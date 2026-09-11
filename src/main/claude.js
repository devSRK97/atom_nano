"use strict";
/*
 * Session manager — drives one conversation ("session") through whichever
 * provider is selected: Anthropic (Claude Agent SDK), OpenAI (Codex app-server,
 * with the Codex SDK exec transport as fallback) or a Custom raw-HTTP endpoint.
 *
 * WHAT THE MODEL RECEIVES. The user's message text, exactly. Attachments as the
 * provider's native inputs (images by durable path; files by path / native
 * mention / full inline content). Conversation continuity comes from the
 * provider's own thread (resume) — and, when that thread has not seen part of
 * the canonical record (provider switch, lost thread, fresh thread), from an
 * EXACT transfer of the missing messages (history.js): never a summary, never
 * clipped, tool calls as completed history. Explicit user workflows (selected
 * skills, configured reviewers / planner, fleet notes) travel as clearly labelled
 * conversation data appended after the user's own text. The app adds no
 * behavioural instructions, no caps, no hidden effort/model/summary changes.
 *
 * Emits normalized events to the renderer:
 *   session:status         { sessionId, status, provider?, model?, effort? }
 *   session:message        { sessionId, message }
 *   session:message-update { sessionId, messageId, patch }
 *   session:partial        { sessionId, index, kind, delta, parent? }
 *   session:partial-reset  { sessionId, index? }
 *   session:edited-files   { sessionId, files }
 *   session:permission     { sessionId, requestId, toolName, input }
 */
const path = require("path");
const store = require("./store");
const auth = require("./auth");
const history = require("./history");
const attachmentsStore = require("./attachments");
const { partialToolInput } = require("./tool-args");
const { spawn } = require("child_process");

// Live tool-argument streaming: the growing JSON is coalesced into at most one renderer update
// per STREAM_ARGS_MS per card, carrying a BOUNDED excerpt — never the whole (possibly huge)
// body on every fragment.
const STREAM_ARGS_MS = 120, STREAM_ARGS_PREVIEW = 6000, STREAM_ARGS_SCAN_MAX = 262144;
const excerptArgs = (s) => (s.length <= STREAM_ARGS_PREVIEW ? s : s.slice(0, Math.round(STREAM_ARGS_PREVIEW * 0.6)) + `\n… ${(s.length - STREAM_ARGS_PREVIEW).toLocaleString("en-US")} more characters still streaming …\n` + s.slice(-Math.round(STREAM_ARGS_PREVIEW * 0.4)));
// Incremental JSON structure scan over one streamed fragment (string/escape aware). Returns true
// once the top-level object has closed — the only moment a full JSON.parse is worth attempting.
function scanJsonState(st, frag) {
  if (st.depth == null) { st.depth = 0; st.inStr = false; st.esc = false; st.opened = false; st.complete = false; }
  for (let i = 0; i < frag.length; i++) {
    const c = frag[i];
    if (st.inStr) { if (st.esc) st.esc = false; else if (c === "\\") st.esc = true; else if (c === '"') st.inStr = false; continue; }
    if (c === '"') st.inStr = true;
    else if (c === "{" || c === "[") { st.depth++; st.opened = true; }
    else if (c === "}" || c === "]") { st.depth--; if (st.depth === 0 && st.opened) st.complete = true; }
  }
  return st.complete;
}
// Stop: the harness is asked to end the turn first (it cancels the running tool and the shell
// processes it started); the transport is torn down only if the turn has not wound down by then.
const INTERRUPT_GRACE_MS = 4000;

let sdkPromise = null;
function loadSDK() {
  if (!sdkPromise) sdkPromise = import("@anthropic-ai/claude-agent-sdk");
  return sdkPromise;
}

// Legacy models (Haiku) have no adaptive thinking → each effort level maps to a
// fixed thinking-token budget. Keyed by the NORMALISED effort name (see normEffort).
const THINKING_TOKENS = { low: 6000, medium: 12000, high: 20000, xhigh: 31999, max: 31999 };
// Back-compat: old stored session/setting values → the current effort levels, so
// existing sessions (thinking = "off"/"think"/"ultrathink"…) keep working. A rename
// only — never a change of depth.
const EFFORT_ALIAS = {
  off: "low", minimal: "low", think: "low",
  "think-hard": "medium", "think-harder": "high", ultrathink: "xhigh",
  low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
  // "ultracode" is not a sixth effort tier — it IS xhigh, plus standing
  // dynamic-workflow orchestration (see applyUltracode).
  ultracode: "xhigh",
};
function normEffort(level) { return EFFORT_ALIAS[String(level || "").toLowerCase()] || "high"; }
function isUltracode(level) { return String(level || "").toLowerCase() === "ultracode"; }
// Modern models (Opus 4.6+, Sonnet 4.6+, Fable, Mythos) reason via *adaptive*
// thinking: depth is driven with `effort` and a visible summary is requested.
// Older models keep the legacy fixed-budget path.
function supportsAdaptiveThinking(id) {
  const s = (id || "").toLowerCase();
  if (/haiku/.test(s)) return false;
  if (/fable|mythos/.test(s)) return true;
  const m = /claude-(opus|sonnet)-(\d+)-(\d+)/.exec(s);
  if (m) return +m[2] > 4 || (+m[2] === 4 && +m[3] >= 6);
  return /opus|sonnet/.test(s);
}
// `xhigh` effort arrived with Opus 4.7. Opus 4.6 / Sonnet 4.6 top out at `max`.
function supportsXhigh(id) {
  const s = (id || "").toLowerCase();
  if (/haiku/.test(s)) return false;
  if (/fable|mythos/.test(s)) return true;
  if (/opus-5|sonnet-5/.test(s)) return true;
  const m = /claude-(opus|sonnet)-(\d+)-(\d+)/.exec(s);
  if (m) { const maj = +m[2], min = +m[3]; if (m[1] === "opus") return maj > 4 || (maj === 4 && min >= 7); return false; }
  return false;
}
// The effort THIS turn sends. A level the model does not offer is an explicit
// capability error — the run does not start with a silently substituted level.
function effortFor(model, level) {
  const eff = normEffort(level);
  if (eff === "xhigh" && !supportsXhigh(model)) return { effort: null, error: `Effort "xhigh" is not offered by ${model}. Supported: low, medium, high, max. Pick one in the Thinking menu.` };
  return { effort: eff };
}
function applyThinking(options, model, level) {
  const r = effortFor(model, level);
  if (r.error) return r.error;
  if (supportsAdaptiveThinking(model)) {
    options.thinking = { type: "adaptive", display: "summarized" };  // make reasoning visible
    options.effort = r.effort;                                      // low | medium | high | xhigh | max
  } else {
    options.maxThinkingTokens = THINKING_TOKENS[r.effort] || 12000; // legacy fixed budget (Haiku)
  }
  return null;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update", "create_file", "str_replace"]);
// Delegation tools that spawn worker sub-agents — removed from the model unless the user opts in.
const SUBAGENT_TOOLS = /^(Task|Agent)$/i;

function toolResultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b && b.type === "text" ? b.text : b && b.text ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && content.text) return content.text;
  try { return JSON.stringify(content); } catch { return String(content); }
}
function linesOf(str) { return !str ? 0 : String(str).split("\n").length; }
// Approximate lines added/removed for an edit tool call.
function computeDiff(toolName, input) {
  if (!input) return { added: 0, removed: 0 };
  switch (toolName) {
    case "Write": case "create_file": return { added: linesOf(input.content), removed: 0 };
    case "Edit": case "str_replace": return { added: linesOf(input.new_string), removed: linesOf(input.old_string) };
    case "MultiEdit": {
      let a = 0, r = 0;
      for (const e of (input.edits || [])) { a += linesOf(e.new_string); r += linesOf(e.old_string); }
      return { added: a, removed: r };
    }
    case "NotebookEdit": return { added: linesOf(input.new_source), removed: 0 };
    default: return { added: 0, removed: 0 };
  }
}

// Friendly provider names for user-facing pause/resume messages.
const PROVIDER_LABEL = { anthropic: "Claude", openai: "OpenAI", google: "Antigravity", custom: "API" };

function isNetworkError(e) {
  const msg = String((e && e.message) || e || "").toLowerCase();
  return /econnrefused|enotfound|eai_again|etimedout|econnreset|socket hang up|network|fetch failed|getaddrinfo|dns|eproto|epipe|ehostunreach|enetunreach/.test(msg);
}
// Auth/token-expiry: RECOVERABLE — pause the session (context intact) and resume
// once the user re-authenticates. Genuine auth signals only.
function isAuthError(e) {
  const msg = String((e && e.message) || e || "").toLowerCase();
  return /\b401\b|\b403\b|unauthor|invalid[_ ]?api[_ ]?key|invalid[_ ]credentials|authentication fail|token (?:has )?expired|expired token|access token|refresh token|\boauth\b|login required|not logged in|please log ?in|re-?authenticate/.test(msg);
}
function isRateLimitError(e) {
  const msg = String((e && e.message) || e || "").toLowerCase();
  const status = e && (e.status || e.statusCode || e.api_error_status);
  if (status === 429 || status === 529) return true;
  return /\b429\b|\b529\b|rate.?limit|rate.?limited|too many requests|overloaded|\bquota\b|capacity|try again later|temporarily unavailable/.test(msg);
}
// The provider rejected the request because it does not fit the model's context window
// (Anthropic "prompt is too long", OpenAI/Codex "context window exceeded" /
// context_length_exceeded, HTTP 413). Recovery: a NEW thread with a summarised record
// (see transferBlock) — never a blind retry of the same request.
function isPromptTooLong(err) {
  if (err && err.promptTooLong) return true;
  const msg = String((err && err.message) || err || "").toLowerCase();
  return /prompt.*(too long|too large)|input.*too long|too many (?:total )?tokens|request.*(too large|entity too large)|token.*exceed|context.*length.*exceed|context_length_exceeded|context.?window.?exceeded|exceeds? the (?:model'?s )?context|max.*context|payload too large|\b413\b/.test(msg);
}
// Instruction for the SEPARATE summarisation request (never injected into the user's own
// turn). Used only when the exact record cannot fit the destination model's context window.
const SUMMARY_INSTRUCTIONS = "You are condensing the earlier part of a conversation between a user and an AI coding assistant so that a fresh model instance can continue it. Write a faithful working summary: the user's goals, explicit instructions and preferences; decisions made and why; what was changed or produced (files, commands, outcomes) and what was verified; open questions and pending work; exact identifiers that matter (paths, names, commands, error messages). Keep the order of events where it matters. Do not add advice, do not invent details, and say when something was left unresolved. Plain prose and bullet points, at most about 1,500 words. Output only the summary.";
// A resume the CLI could not honour (the transcript for that id is gone).
function isSessionGone(err) {
  const msg = String((err && err.message) || err || "").toLowerCase();
  return /no conversation found|session.*not found|could not resume|unknown session|no such session|conversation.*does not exist/.test(msg);
}

// Sum a result message's per-model usage map (modelUsage) into one total — covers
// EVERY query-pipeline call (main loop + subagents + reviewers).
function sumModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  const t = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, models: 0 };
  for (const key of Object.keys(modelUsage)) {
    const v = modelUsage[key] || {};
    t.inputTokens += v.inputTokens || 0;
    t.outputTokens += v.outputTokens || 0;
    t.cacheReadInputTokens += v.cacheReadInputTokens || 0;
    t.cacheCreationInputTokens += v.cacheCreationInputTokens || 0;
    t.costUSD += v.costUSD || 0;
    t.models++;
  }
  return t.models ? t : null;
}

let runSeq = 0;
const newRunId = () => `run-${Date.now().toString(36)}-${(++runSeq).toString(36)}`;

class SessionManager {
  constructor() {
    this.runners = new Map();          // sessionId → runner (one live run per session)
    this.permResolvers = new Map();    // requestId → { sessionId, runId, resolve }
    this.draining = new Map();         // sessionId → promise of a stopped run that is still winding down
    this.interruptGraceMs = INTERRUPT_GRACE_MS;
    this.emit = () => {};
    this.cachedCliPath = null;
  }

  /* Spawn the CLI ourselves with the SDK's own options (pipes, windowsHide, forwarded abort
   * signal) so the run knows the process id: a hard stop can then end the WHOLE process tree —
   * the CLI and every shell command it started — which plain child.kill() cannot do on Windows. */
  spawnCli(cfg, runner, onStderr) {
    const child = spawn(cfg.command, cfg.args, { cwd: cfg.cwd, env: cfg.env, stdio: ["pipe", "pipe", "pipe"], signal: cfg.signal, windowsHide: true });
    if (runner) runner.pid = child.pid;
    let tail = "";
    if (child.stderr) {
      child.stderr.on("data", (d) => { const s = String(d); tail = (tail + s).slice(-4000); if (runner) runner.stderrTail = tail; if (onStderr) { try { onStderr(s); } catch { /* */ } } });
      child.stderr.on("error", () => {});
    }
    if (child.stdin) child.stdin.on("error", () => {});
    return child;
  }
  killProcessTree(runner) {
    const pid = runner && runner.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
      else { try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); } }
    } catch { /* already gone */ }
  }
  // A stopped run may still be winding down (graceful interrupt): the next run on the same session
  // waits for it (bounded) so two CLI processes never work the same native session at once.
  async awaitDrain(sessionId) {
    const d = this.draining.get(sessionId);
    if (!d) return;
    await Promise.race([d, new Promise((res) => setTimeout(res, this.interruptGraceMs + 1500))]);
    if (this.draining.get(sessionId) === d) this.draining.delete(sessionId);
  }

  /*
   * Prefer the user's installed claude.exe. The Agent SDK otherwise spawns its
   * own bundled native binary, whose first launch is unreliable on Windows
   * (antivirus scan races). The installed CLI shares the same login.
   */
  async resolveCli(settings) {
    if (settings.claudePath) return settings.claudePath;
    if (this.cachedCliPath) return this.cachedCliPath;
    try { this.cachedCliPath = (await auth.whereClaude()) || ""; }
    catch { this.cachedCliPath = ""; }
    return this.cachedCliPath;
  }
  resetCliCache() { this.cachedCliPath = null; }

  setEmitter(fn) { this.emit = fn; }
  send(channel, payload) { try { this.emit(channel, payload); } catch { /* window gone */ } }

  /*
   * Spawn environment for the Claude CLI. By default the CLI's OAuth login is used
   * and an inherited ANTHROPIC_API_KEY is stripped (a stale key would silently
   * override the login). An explicit key in settings, or opting into the env key,
   * takes precedence. Nothing else in the user's environment is changed.
   */
  buildEnv(settings) {
    const env = { ...process.env };
    if (settings.apiKey) {
      env.ANTHROPIC_API_KEY = settings.apiKey;
    } else if (!settings.useEnvApiKey) {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    // Custom provider = an Anthropic-compatible endpoint (its own base URL + key).
    if (settings.llmProvider === "custom" && settings.customApiBaseUrl) env.ANTHROPIC_BASE_URL = settings.customApiBaseUrl;
    return env;
  }

  isRunning(id) { const r = this.runners.get(id); return !!(r && r.running); }
  runningCount() { let n = 0; for (const r of this.runners.values()) if (r.running) n++; return n; }
  runningCountForCwd(cwd) {
    if (!cwd) return this.runningCount();
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const want = norm(cwd);
    let n = 0;
    for (const [id, r] of this.runners) {
      if (!r || !r.running) continue;
      try { const s = store.getSession(id); if (s && norm(s.cwd) === want) n++; } catch { /* session gone */ }
    }
    return n;
  }

  // The mcpServers option: the user's configured servers (mcpConfig).
  composeMcp(settings) {
    const { composeMcpServers } = require("./defaultMcp");
    let userMap = {};
    try {
      const raw = require("./mcpConfig").list();
      for (const s of raw.servers || []) userMap[s.name] = s;
    } catch { /* mcp config absent — fine */ }
    return composeMcpServers(userMap, { enableDefaultMcp: settings.enableDefaultMcp !== false });
  }

  /* Ultracode — xhigh effort PLUS standing dynamic-workflow orchestration. Applied
   * on the live query (applyFlagSettings) right after it is created. Every failure
   * path degrades to a plain xhigh run (the effort half is already set). */
  async applyUltracode(q, session, level) {
    if (!isUltracode(level)) return false;
    if (!q || typeof q.applyFlagSettings !== "function") { console.warn("[ultracode] this SDK/CLI has no applyFlagSettings (needs Claude Code 2.1.203+) — running at xhigh"); return false; }
    if (!supportsXhigh(session.model)) { console.warn(`[ultracode] ${session.model} is not xhigh-capable — running at its supported effort`); return false; }
    try {
      await q.applyFlagSettings({ ultracode: true });
      if (this._lastRun && this._lastRun.sessionId === session.id) this._lastRun.ultracodeApplied = true;
      return true;
    } catch (e) { console.warn("[ultracode] refused by the CLI:", (e && e.message) || e); return false; }
  }

  // canUseTool for the Anthropic path: the permission gate, scoped to THIS run so a
  // stop elsewhere can never resolve its prompts. The sub-agent opt-out is enforced
  // structurally (disallowedTools) and re-checked here as a safety net.
  composeCanUseTool(sessionId, runId, canUseToolOverride, abortController, subOn, permMode) {
    // The permission mode is read LIVE (the user can switch it while the turn runs):
    //   "Full access" (bypassPermissions) means NEVER ask — the SDK only skips its OWN checks in
    //   that mode, a canUseTool handler is still consulted — so auto-allow;
    //   "Accept edits" auto-allows the edit tools (the CLI does the same for its own checks);
    //   ExitPlanMode / AskUserQuestion always reach the user — they are questions, not risks.
    const liveMode = () => { const s = store.getSession(sessionId); return (s && s.permissionMode) || permMode || "default"; };
    const ask = (toolName, input) => this.requestPermission(sessionId, toolName, input, abortController.signal, runId);
    const base = canUseToolOverride || ((toolName, input) => {
      const mode = liveMode();
      const question = toolName === "ExitPlanMode" || toolName === "AskUserQuestion";
      if (!question && mode === "bypassPermissions") return { behavior: "allow", updatedInput: input };
      if (!question && mode === "acceptEdits" && EDIT_TOOLS.has(String(toolName || ""))) return { behavior: "allow", updatedInput: input };
      return ask(toolName, input);
    });
    if (subOn) return base;
    return async (toolName, input, ...rest) => {
      if (SUBAGENT_TOOLS.test(String(toolName || ""))) {
        this.send("subagent:blocked", { sessionId, toolName });
        return { behavior: "deny", message: "Sub-agents are disabled for this session (the 'Sub agents' toggle in the composer is off)." };
      }
      return base(toolName, input, ...rest);
    };
  }

  addMessage(session, msg) {
    session.messages.push(msg);
    store.enforceCap(session);   // memory window; nothing is lost (archive-first)
    store.scheduleWrite(session.id);
    this.send("session:message", { sessionId: session.id, message: msg });
  }

  updateMessage(session, messageId, patch) {
    const m = session.messages.find((x) => x.id === messageId);
    if (m) Object.assign(m, patch);
    store.scheduleWrite(session.id);
    this.send("session:message-update", { sessionId: session.id, messageId, patch });
  }

  // Every file an edit tool touched, cumulatively for the session (no cap — the
  // Changed-files panel and exports must be able to show the complete list).
  trackEdit(session, filePath, toolName, diff) {
    if (!filePath) return;
    let e = session.editedFiles.find((x) => x.path === filePath);
    if (!e) { e = { path: filePath, count: 0, added: 0, removed: 0 }; session.editedFiles.push(e); }
    e.count++; e.tool = toolName; e.ts = store.nowISO();
    if (diff) { e.added = (e.added || 0) + (diff.added || 0); e.removed = (e.removed || 0) + (diff.removed || 0); }
    (session._runTouched = session._runTouched || []).push({ path: filePath, added: (diff && diff.added) || 0, removed: (diff && diff.removed) || 0 });
    store.scheduleWrite(session.id);
    this.send("session:edited-files", { sessionId: session.id, files: session.editedFiles });
  }

  /*
   * Build the SDK prompt. Streaming-input mode (an async generator of one user
   * message) is what enables query.interrupt() to gracefully stop a turn while
   * keeping the CLI session resumable. Files are referenced by path (Claude reads
   * them with its tools); every image ships as a base64 block read from its
   * durable file — an explicitly attached image is ALWAYS sent.
   */
  buildPrompt(text, attachments, session, hold) {
    const atts = attachments || [];
    const images = atts.filter((a) => a.kind === "image" && (a.path || a.data));
    const files = atts.filter((a) => a.kind !== "image" && a.path);
    let textPart = text || "";
    if (files.length) textPart += (textPart ? "\n\n" : "") + "Attached files:\n" + files.map((f) => `- ${f.path}`).join("\n");
    let content;
    if (images.length) {
      content = [];
      if (textPart) content.push({ type: "text", text: textPart });
      for (const img of images) {
        const data = img.data || attachmentsStore.readBase64(img.path);
        if (!data) { content.push({ type: "text", text: `[attached image ${img.name || img.path} could not be read from disk]` }); continue; }
        content.push({ type: "image", source: { type: "base64", media_type: img.mediaType || "image/png", data } });
      }
    } else {
      content = textPart;
    }
    const msg = { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: session.claudeSessionId || "" };
    // The input stream stays OPEN until the run releases it. The SDK closes the CLI's stdin as soon
    // as this generator ends AND a first `result` has arrived — and the CLI can emit a result before
    // this turn's own (on resume it finalises a queued task notification as a zero-turn result, for
    // instance). With stdin closed every later permission prompt fails ("Tool permission request
    // failed: Stream closed") and interrupt() has no channel. So the generator ends only when the
    // run has seen ITS result (or is stopped).
    return (async function* () { yield msg; if (hold) await hold; })();
  }

  // Map a raw SDK/transport error to a clear, user-facing sentence.
  describeError(e) {
    const raw = e && e.message ? e.message : String(e || "");
    const low = raw.toLowerCase();
    if (/abort/.test(low)) return "Stopped.";
    if (/econnrefused|enotfound|eai_again|etimedout|econnreset|socket hang up|network|fetch failed|getaddrinfo|dns/.test(low))
      return "Connection lost — Claude couldn't reach the server. Check your internet or VPN and try again.";
    if (/\b429\b|rate.?limit|overloaded|\b529\b/.test(low))
      return "Claude is overloaded or you've hit a rate limit. Wait a moment and resend.";
    if (/\b401\b|\b403\b|unauthor|authentication|invalid api key|api key|credentials/.test(low))
      return "Authorization error — re-check your Claude login or API key in Settings.";
    if (/prompt.*(too long|too large)|too many tokens|context.*length|payload too large/.test(low))
      return "The provider rejected the request as too large for the model's context window: " + raw;
    if (/\b5\d\d\b|server error|internal error|service unavailable/.test(low))
      return "Claude API server error. Please try again shortly.";
    if (/exited|spawn|enoent|failed to launch/.test(low))
      return "The Claude CLI process couldn't run. Check the CLI path in Settings.";
    return "Error: " + raw;
  }

  // Explicit user workflow data appended AFTER the user's own text — clearly
  // labelled conversation data, never an instruction prefix. The user's text is
  // always first and byte-exact.
  workflowAppendix({ skillDigests, extraSystem, reviewerDigest }) {
    const parts = [];
    if (skillDigests && skillDigests.length) parts.push("Skills the user selected for this message (their saved procedures):\n\n" + skillDigests.join("\n\n---\n\n"));
    if (extraSystem) parts.push(String(extraSystem));
    if (reviewerDigest) parts.push(reviewerDigest);
    return parts.length ? "\n\n" + parts.join("\n\n") : "";
  }
  // The skills the user explicitly checked in the composer, applied for every provider.
  selectedSkillDigests(session) {
    const picked = Array.isArray(session.selectedSkills) ? session.selectedSkills : [];
    if (!picked.length) return { digests: [], names: [] };
    const digests = [], names = [];
    try {
      const skills = require("./skills");
      for (const id of picked) {
        try { const d = skills.invoke(session.cwd, id); if (d) { digests.push(d); const s = skills.get(session.cwd, id); names.push(s ? s.name : id); } } catch { /* skip a missing skill */ }
      }
    } catch { /* skills optional */ }
    return { digests, names };
  }

  async run(sessionId, { text, model, permissionMode, thinking, attachments, oneM, subAgents, subAgentsMax, canUseToolOverride, extraSystem, background, fleet, reviewers, reviewMode, planner, resumeContinuation, promptMessageId } = {}) {
    const session = store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (this.isRunning(sessionId)) throw new Error("This tab is already running.");
    await this.awaitDrain(sessionId);   // a stopped run may still be winding down gracefully
    if (this.isRunning(sessionId)) throw new Error("This tab is already running.");
    // A genuinely NEW prompt supersedes any queued retry payload and resets the
    // backoff. A resumeContinuation run is the SAME turn being retried.
    if (!resumeContinuation) {
      if (session._pendingRetry) delete session._pendingRetry;
      if (session.pendingRun) { session.pendingRun = null; store.updateSession(sessionId, { pendingRun: null }); }
      session._retryAttempt = 0;
      this.cancelScheduledRetry(sessionId);
    }
    if (model) session.model = model;
    if (permissionMode) session.permissionMode = permissionMode;
    if (thinking) session.thinking = thinking;
    if (typeof oneM === "boolean") session.oneM = oneM;
    session._runTouched = [];   // files touched by THIS run
    session._interruptRequested = false;   // a new turn supersedes any stale stop request

    // Durable attachments FIRST: a pasted image gets a file before anything else
    // sees it. A failed write is a visible error, not a silently image-less prompt.
    let atts = Array.isArray(attachments) ? attachments : [];
    try { atts = attachmentsStore.persistAll(atts); }
    catch (e) {
      this.addMessage(session, { id: store.uid(), role: "error", text: "Could not store an attachment before sending (" + ((e && e.message) || e) + "). Nothing was sent.", ts: store.nowISO() });
      store.updateSession(sessionId, { status: "error" }); this.send("session:status", { sessionId, status: "error" });
      return;
    }
    attachments = atts;

    // The turn's identity is the user MESSAGE (its id), never "the last entry": reviewer /
    // planner / status cards appended before the provider runs must not move the boundary
    // between earlier history and the current prompt. On a retry/continuation the user
    // message is ALREADY in the transcript and its id travels with the retry payload.
    if (!resumeContinuation) {
      const um = { id: store.uid(), role: "user", text, ts: store.nowISO(), attachments: attachmentsStore.light(atts) };
      this.addMessage(session, um);
      promptMessageId = um.id;
    } else if (!promptMessageId || history.indexOfMessage(session, promptMessageId) < 0) {
      for (let i = session.messages.length - 1; i >= 0; i--) { const m = session.messages[i]; if (m && m.role === "user" && !m.steered) { promptMessageId = m.id; break; } }
    }
    const settings = store.getSettings(session.cwd);   // per-project settings (provider/model/flags)
    const provider = settings.llmProvider || "anthropic";
    // Snapshot of what THIS run was dispatched with — the renderer labels the live
    // reply from it, not from whatever the dropdowns say later.
    const dispatched = { provider, model: session.model, effort: session.thinking, permissionMode: session.permissionMode };
    store.updateSession(sessionId, { status: "running" });
    this.send("session:status", { sessionId, status: "running", ...dispatched });

    // Council — consult-before (an explicit, user-configured workflow with its own visible cards).
    let reviewerBeforeDigest = "";
    if (Array.isArray(reviewers) && reviewers.length && reviewMode === "before") {
      try { reviewerBeforeDigest = await this.consultReviewers(session, reviewers, text || "", promptMessageId); } catch (e) { console.error("[council:before]", e); }
      if (session._interruptRequested) {
        this.addMessage(session, { id: store.uid(), role: "system", text: "Stopped by you.", ts: store.nowISO() });
        store.updateSession(sessionId, { status: "idle" }); this.send("session:status", { sessionId, status: "idle" });
        return;
      }
    }

    if (provider === "google") {
      this.addMessage(session, { id: store.uid(), role: "error", text: "Google primary (Antigravity / agy) integration was removed from this build. Switch the provider to Anthropic (Claude), OpenAI, or Custom in Settings → Providers.", ts: store.nowISO() });
      store.updateSession(sessionId, { status: "error" }); this.send("session:status", { sessionId, status: "error" });
      return;
    }

    // Provider continuity: every provider keeps its own binding (native thread +
    // how much of the record it has seen). Switching providers changes which
    // binding generates next — nothing is cleared, and the destination receives
    // the exact messages it has not seen (see runAnthropic / runOpenAI).
    if (session.lastProvider && session.lastProvider !== provider) console.log(`[run] provider switch ${session.lastProvider} → ${provider} — the ${provider} thread will receive the exact missing conversation record`);
    session.lastProvider = provider;
    store.scheduleWrite(sessionId);

    // ROLE PIPELINE — Planner phase (explicit user configuration). The Planner drafts
    // a plan as its own visible card; the Coder receives it as workflow data.
    if (planner && planner.enabled && (planner.provider || planner.model) && !background && !(fleet && fleet.taskId)) {
      let pr = { plan: "", aborted: false };
      try { pr = await this.runPlanner(sessionId, session, { userText: text, planner, settings, promptMessageId }); }
      catch (e) {
        console.error("[planner]", e);
        this.addMessage(session, { id: store.uid(), role: "system", text: "Planner step failed — continuing without a plan. (" + String((e && e.message) || e) + ")", ts: store.nowISO() });
      }
      if (pr.aborted || session._interruptRequested) {
        this.addMessage(session, { id: store.uid(), role: "system", text: "Stopped during planning.", ts: store.nowISO() });
        store.updateSession(sessionId, { status: "idle" }); this.send("session:partial-reset", { sessionId }); this.send("session:status", { sessionId, status: "idle" });
        return;
      }
      if (pr.plan) extraSystem = (extraSystem ? extraSystem + "\n\n" : "") + "Implementation plan produced by the Planner role you configured (the Coder follows it):\n" + pr.plan;
    }

    const common = { text, attachments, reviewers, reviewMode, background, fleet, extraSystem, subAgents, subAgentsMax, canUseToolOverride, resumeContinuation, promptMessageId };
    if (provider === "openai") return this.runOpenAI(sessionId, session, common, reviewerBeforeDigest, settings, dispatched);
    if (provider === "custom") {
      const ep = require("./customApi").getEndpoint(settings, session.model);
      if (ep) return this.runCustomHttp(sessionId, session, common, reviewerBeforeDigest, settings, ep);
      if (settings.customMode === "raw") return this.runCustomHttp(sessionId, session, common, reviewerBeforeDigest, settings, null);
    }
    return this.runAnthropic(sessionId, session, common, reviewerBeforeDigest, settings, provider, dispatched);
  }

  /* ----------------------------- Anthropic primary ----------------------------- */
  async runAnthropic(sessionId, session, { text, attachments, reviewers, reviewMode, background, fleet, extraSystem, subAgents, subAgentsMax, canUseToolOverride, promptMessageId }, reviewerBeforeDigest, settings, provider, dispatched) {
    // Capability check BEFORE anything is spawned: an effort the model doesn't
    // offer is an explicit error, not a silent substitution.
    const effChk = effortFor(session.model, session.thinking);
    if (effChk.error) return this.failRun(session, effChk.error);

    session._replyMeta = this.replyMeta(provider, session.model, session.thinking, reviewers, reviewMode);
    const { query } = await loadSDK();
    const abortController = new AbortController();
    const runId = newRunId();
    const runner = { id: runId, running: true, abortController, query: null, promptText: text || "", provider, model: session.model, effort: session.thinking, sawOutput: false };
    runner.done = new Promise((res) => { runner._resolveDone = res; });
    this.runners.set(sessionId, runner);

    const subOn = !!subAgents;
    const { digests: skillDigests, names: skillNames } = this.selectedSkillDigests(session);
    const appendix = this.workflowAppendix({ skillDigests, extraSystem, reviewerDigest: reviewerBeforeDigest });

    // Conversation transfer: what has this provider's thread NOT seen? Everything
    // before the current prompt that arrived while another provider (or a lost
    // thread) was generating is carried verbatim as conversation data.
    const binding = history.bindingFor(session, "anthropic");
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    runner.promptIndex = promptIndex; runner.bindingProvider = "anthropic";
    const sync = history.pendingSync(session, "anthropic", promptIndex);
    const promptChars = (text || "").length + appendix.length + (attachments || []).filter((a) => a && a.kind === "image").length * 6400;
    // The prompt alone must fit the model's window — otherwise it is preserved in the chat and
    // the run stops here with a clear message, not a provider rejection nobody can act on.
    const ctxTokens = this.contextTokensFor(provider, session.model, session);
    if (promptChars > ctxTokens * history.CHARS_PER_TOKEN * 0.9) {
      this.runners.delete(sessionId);
      return this.failRun(session, `Your message alone is about ${Math.round(promptChars / history.CHARS_PER_TOKEN).toLocaleString("en-US")} tokens — larger than the model's context window (${ctxTokens.toLocaleString("en-US")} tokens). It was not sent. Split it, or attach the large part as a file the model can read in pieces.`);
    }
    let recordBlock = { text: "", count: 0, mode: "none", note: "" };   // prepared inside the run's try/finally
    const composePrompt = (block, extra) => (block && block.text ? block.text + "\n\n---\n\n" : "") + (text || "") + appendix + (extra || "");

    const mcpServers = this.composeMcp(settings);
    const options = {
      cwd: session.cwd,
      model: session.model,
      permissionMode: session.permissionMode,
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code" },   // the provider's native system behaviour; no app-added instructions
      settingSources: ["user", "project", "local"],
      abortController,
      stderr: (d) => { if (d) console.error("[claude:stderr]", String(d).slice(0, 800)); },
      // Our own spawner (same options as the SDK's): the run learns the CLI's pid, so a hard stop
      // can end the whole process tree — no shell command is left running after Stop.
      spawnClaudeCodeProcess: (cfg) => this.spawnCli(cfg, runner, (d) => { if (d) console.error("[claude:stderr]", String(d).slice(0, 800)); }),
      canUseTool: this.composeCanUseTool(sessionId, runId, canUseToolOverride, abortController, subOn, session.permissionMode),
      env: this.buildEnv(settings),
      // The user's configured servers (mcpConfig) PLUS whatever their native Claude
      // settings sources declare — nothing is silently excluded.
      mcpServers,
    };
    // Always set: the SDK requires it for bypassPermissions AND for switching to Full access
    // mid-turn (setPermissionMode). It does not by itself change the active mode.
    options.allowDangerouslySkipPermissions = true;
    if (settings.enableFileCheckpointing !== false) options.enableFileCheckpointing = true;
    if (settings.promptSuggestions) options.promptSuggestions = true;
    if (Array.isArray(settings.additionalDirectories) && settings.additionalDirectories.length) {
      const dirs = settings.additionalDirectories.filter((d) => d && typeof d === "string");
      if (dirs.length) options.additionalDirectories = dirs;
    }
    // Hard-remove tools: the user's list, plus the delegation tools when sub-agents
    // are off (a structured control — no prompt text asks the model not to delegate).
    const dt = (Array.isArray(settings.disallowedTools) ? settings.disallowedTools : []).filter((t) => t && typeof t === "string");
    if (!subOn) for (const t of ["Task", "Agent"]) if (!dt.includes(t)) dt.push(t);
    if (dt.length) options.disallowedTools = dt;
    if (settings.sdkSkills === "all") options.skills = "all";
    else if (typeof settings.sdkSkills === "string" && settings.sdkSkills.trim() && settings.sdkSkills !== "none") {
      const sk = settings.sdkSkills.split(",").map((s) => s.trim()).filter(Boolean);
      if (sk.length) options.skills = sk;
    }
    if (subOn) {
      if (settings.agentProgressSummaries !== false) options.agentProgressSummaries = true;
      if (settings.forwardSubagentText !== false) options.forwardSubagentText = true;
      // A worker definition is a structured control the user opted into; how many
      // to fan out is the model's call within the CLI's own limits.
      options.agents = { worker: { description: "General-purpose worker for delegated, independent subtasks (focused edits, research, analysis).", prompt: "You are a focused worker subagent. Complete exactly the subtask you were given and return a concise final result." } };
    }
    const effErr = applyThinking(options, session.model, session.thinking);
    if (effErr) { this.runners.delete(sessionId); return this.failRun(session, effErr); }
    if (session.oneM) options.betas = ["context-1m-2025-08-07"];
    const cli = await this.resolveCli(settings);
    if (cli) options.pathToClaudeCodeExecutable = cli; else options.executable = "node";
    if (binding.id) options.resume = binding.id;

    this._lastRun = {
      sessionId, runId,
      resumeRequested: options.resume || null,
      sent: { provider, model: options.model, permissionMode: options.permissionMode, thinking: session.thinking, thinkingConfig: options.thinking || null, effort: options.effort || null, ultracode: isUltracode(session.thinking), maxThinkingTokens: options.maxThinkingTokens || 0, oneM: !!session.oneM, betas: options.betas || [], subAgents: subOn ? Math.max(1, Math.min(8, +subAgentsMax || 3)) : 0, transferredEntries: recordBlock.count, transferMode: recordBlock.mode, skills: skillNames, fleet: !!(fleet && fleet.taskId), background: !!background },
      init: null,
    };

    const runOnce = async (opts, block, extra) => {
      runner.resultSeen = false; runner.sawOutput = false;
      // The prompt stream is held open until THIS turn's result (or a stop) releases it — see buildPrompt.
      const hold = new Promise((res) => { runner.releaseInput = res; });
      const q = query({ prompt: this.buildPrompt(composePrompt(block, extra), attachments, session, hold), options: opts });
      runner.query = q;
      try {
        await this.applyUltracode(q, session, session.thinking);
        // A stopped turn is asked to wind down (query.interrupt): what the CLI still emits — the
        // cancelled tool's result, the final result — is recorded until it ends or the grace period
        // tears the transport down (abort).
        for await (const m of q) { if (abortController.signal.aborted) break; this.handleMessage(session, m, runner); }
      } finally { runner.releaseInput(); this.clearStreamTools(runner); }
    };

    try {
      // Preparation (the record transfer, which may summarise) runs INSIDE the run's lifecycle:
      // a failure here ends the run cleanly — never a tab stuck "running".
      if (sync.needed) {
        recordBlock = await this.transferBlock(session, "anthropic", { model: session.model, from: sync.from, to: sync.to, promptChars, signal: abortController.signal, activeTokens: sync.from > -1 ? (binding.activeTokens || 0) : 0 });
        if (recordBlock.count) this.addMessage(session, { id: store.uid(), role: "system", text: recordBlock.note, ts: store.nowISO() });
        if (this._lastRun && this._lastRun.sessionId === sessionId) { this._lastRun.sent.transferredEntries = recordBlock.count; this._lastRun.sent.transferMode = recordBlock.mode; }
      }
      // Bounded recovery: at most two replacement attempts, each classified — a lost native
      // session gets a new one with the (budgeted) record; a request that does not fit the
      // window gets ONE new session with a summarised record at half the budget. Either can
      // follow the other; nothing is retried blindly.
      let block = recordBlock, extra = "", attempts = 0;
      for (;;) {
        try { await runOnce(options, block, extra); break; }
        catch (e1) {
          if (runner.interrupted || abortController.signal.aborted) throw e1;
          // Transient errors keep the resume point and bubble to the pause/retry logic.
          if (isRateLimitError(e1) || isNetworkError(e1) || isAuthError(e1)) throw e1;
          if (++attempts > 2) throw e1;
          if (options.resume && isSessionGone(e1)) {
            console.warn("[claude:run] resume failed (session gone) — starting a new native session with the record:", e1.message);
            history.dropBinding(session, "anthropic"); delete options.resume; runner.accepted = false;
            block = await this.transferBlock(session, "anthropic", { model: session.model, from: -1, to: promptIndex - 1, promptChars, signal: abortController.signal });
            this.addMessage(session, { id: store.uid(), role: "system", text: `Claude's native session could not be resumed. A new one was started. ${block.note}`.trim(), ts: store.nowISO() });
            if (this._lastRun && this._lastRun.sessionId === sessionId) { this._lastRun.resumedFresh = true; this._lastRun.sent.transferredEntries = block.count; this._lastRun.sent.transferMode = block.mode; }
            continue;
          }
          if (isPromptTooLong(e1) && !runner.retriedTooLong) {
            // Work the failing attempt already did travels with the replacement record, and the
            // model is asked to continue from it instead of redoing completed steps.
            runner.retriedTooLong = true;
            console.warn("[claude:run] prompt too long — starting a new native session with a summarised record:", e1.message);
            history.dropBinding(session, "anthropic"); delete options.resume; runner.accepted = false;
            const cont = this.continuationAfter(session, promptIndex);
            block = await this.transferBlock(session, "anthropic", { model: session.model, from: -1, to: cont.to, promptChars: promptChars + cont.note.length, forceSummary: true, budgetScale: 0.5, signal: abortController.signal });
            extra = cont.note;
            this.addMessage(session, { id: store.uid(), role: "system", text: `Claude rejected the request as too large for the model's context window. A new native session was started. ${block.note}${cont.count ? ` The ${cont.count} entr${cont.count === 1 ? "y" : "ies"} the interrupted attempt produced travel with it, and the model is asked to continue rather than start over.` : ""}`.trim(), ts: store.nowISO() });
            if (this._lastRun && this._lastRun.sessionId === sessionId) { this._lastRun.resumedFresh = true; this._lastRun.sent.transferredEntries = block.count; this._lastRun.sent.transferMode = block.mode; this._lastRun.sent.promptTooLongRecovery = true; this._lastRun.sent.continuationEntries = cont.count; }
            continue;
          }
          throw e1;
        }
      }
      // Completed normally OR was gracefully interrupted (no throw).
      session._retryAttempt = 0;
      // The thread has now seen everything up to and including this turn's output.
      if (!runner.interrupted && !abortController.signal.aborted) history.setBinding(session, "anthropic", { id: session.claudeSessionId || binding.id, syncedIndex: history.lastGlobalIndex(session), account: "" });
      store.scheduleWrite(sessionId);
      this.finalizeRun(session, runner, { aborted: false });
    } catch (e) {
      if (runner.interrupted || abortController.signal.aborted) {
        this.finalizeRun(session, runner, { aborted: true });
      } else if (isNetworkError(e)) {
        console.warn("[claude:run] network error — will retry on reconnect:", (e && e.message) || e);
        session._pendingRetry = { text, model: session.model, permissionMode: session.permissionMode, thinking: session.thinking, oneM: session.oneM, attachments, subAgents, subAgentsMax, extraSystem, background, fleet, reviewers, reviewMode, resumeContinuation: true, promptMessageId };
        this.addMessage(session, { id: store.uid(), role: "system", text: "Connection lost — will resume automatically when back online.", ts: store.nowISO() });
        store.updateSession(sessionId, { status: "offline" }); this.send("session:status", { sessionId, status: "offline" });
      } else if (isAuthError(e)) {
        // Login/token expired mid-run: PERSIST the pending run (survives restart) and
        // pause as "auth-expired". The native session id stays intact, so re-login
        // continues exactly where it left off.
        const payload = { text, model: session.model, permissionMode: session.permissionMode, thinking: session.thinking, oneM: session.oneM, attachments, subAgents, subAgentsMax, extraSystem, background, fleet, reviewers, reviewMode, resumeContinuation: true, promptMessageId };
        session._pendingRetry = payload;
        console.warn(`[claude:run] auth/token expired (${provider}) — pausing session, will resume after re-login`);
        this.addMessage(session, { id: store.uid(), role: "system", text: `Your ${PROVIDER_LABEL[provider] || provider} login expired — this session is paused. Sign in again and it resumes automatically with full context.`, ts: store.nowISO() });
        store.updateSession(sessionId, { status: "auth-expired", pendingRun: { payload, reason: "auth", provider, at: store.nowISO() } });
        this.send("session:status", { sessionId, status: "auth-expired", provider });
      } else if (isRateLimitError(e)) {
        session._pendingRetry = { text, model: session.model, permissionMode: session.permissionMode, thinking: session.thinking, oneM: session.oneM, attachments, subAgents, subAgentsMax, extraSystem, background, fleet, reviewers, reviewMode, resumeContinuation: true, promptMessageId };
        console.warn("[claude:run] rate-limited — preserving turn, will auto-retry:", (e && e.message) || e);
        this.scheduleRetry(sessionId, "ratelimited");
      } else {
        const text2 = this.describeError(e);
        console.error("[claude:run]", e && e.stack ? e.stack : e);
        this.addMessage(session, { id: store.uid(), role: "error", text: text2, ts: store.nowISO() });
        runner.failed = true;
        this.finalizeRun(session, runner, { aborted: false, failed: true });
      }
    } finally {
      runner.running = false; runner.ended = true;
      clearTimeout(runner._graceTimer);
      if (runner.releaseInput) runner.releaseInput();
      // interrupt() may already have freed the slot and a NEW run may own it now —
      // only THIS run's owner may reset the live stream or clear the registry.
      if (this.runners.get(sessionId) === runner) { this.send("session:partial-reset", { sessionId }); this.runners.delete(sessionId); }
      if (this.draining.get(sessionId) === runner.done) this.draining.delete(sessionId);
      this.cancelPermissionsFor(sessionId, runId, "Run ended");
      store.flush(sessionId);
      if (runner._resolveDone) runner._resolveDone();
    }

    // Council — review-after (explicit workflow): only after a GENUINE success.
    if (Array.isArray(reviewers) && reviewers.length && reviewMode === "after" && runner.completedClean && !background && !(fleet && fleet.taskId)) {
      try { await this.reviewAfter(session, reviewers, text || "", promptMessageId); } catch (e) { console.error("[council:after]", e); }
    }
  }

  // A run that cannot start (capability / configuration error): one visible error, terminal state "error".
  failRun(session, message) {
    this.addMessage(session, { id: store.uid(), role: "error", text: message, ts: store.nowISO() });
    store.updateSession(session.id, { status: "error" });
    this.send("session:status", { sessionId: session.id, status: "error" });
  }

  // Compact run descriptor stamped onto each assistant reply (provider/model/
  // thinking + reviewers). Pretty labels are resolved in the renderer.
  replyMeta(provider, model, thinking, reviewers, reviewMode) {
    return {
      provider: provider || "anthropic",
      model: model || "",
      thinking: thinking || "off",
      reviewMode: reviewMode === "after" ? "after" : "before",
      reviewers: Array.isArray(reviewers) ? reviewers.map((r) => ({ provider: r.provider, model: r.model || "" })) : [],
    };
  }

  /* ------------------------------- Council ------------------------------- */
  lastAssistantText(session) {
    for (let i = session.messages.length - 1; i >= 0; i--) { const m = session.messages[i]; if (m.role === "assistant" && m.text) return m.text; }
    return "";
  }
  /* ----------------------- Conversation transfer, sized to the model -----------------------
   * The exact record is the default. When it cannot fit the destination model's context
   * window, history.planTransfer degrades it visibly (shortened tool payloads, then a
   * cached/rolled summary of the oldest part + newest entries verbatim). The user asked
   * for this on 2026-09-10 to stop "prompt too long" failures on new/lost threads. */
  // GLOBAL index of the current prompt — from the user message's id (durable), falling back to
  // the newest user message, then the last entry. Everything before it is "earlier history".
  promptIndexFor(session, promptMessageId) {
    const g = history.indexOfMessage(session, promptMessageId);
    if (g >= 0) return g;
    for (let i = session.messages.length - 1; i >= 0; i--) { const m = session.messages[i]; if (m && m.role === "user" && !m.steered) return (session.archivedCount || 0) + i; }
    return history.lastGlobalIndex(session);
  }
  /* After an attempt failed mid-way (context overflow): the canonical entries it produced after
   * the prompt travel with the replacement record, and a labelled note (after the user's own
   * text) asks the model to continue rather than redo them. */
  continuationAfter(session, promptIndex) {
    const arch = session.archivedCount || 0;
    const produced = session.messages.filter((m, i) => arch + i > promptIndex && history.isHistoryMessage(m) && m.role !== "user");
    if (!produced.length) return { to: promptIndex - 1, count: 0, note: "" };
    return { to: history.lastGlobalIndex(session), count: produced.length, note: `\n\n[Continuation note from AtomNano: the request above was already being worked on when the model's context window overflowed. The conversation record ends with the ${produced.length} action${produced.length === 1 ? "" : "s"}/outputs that attempt completed. Continue from there — do not redo completed steps; check the outcome of any action whose result is marked unknown.]` };
  }
  contextTokensFor(provider, model, session) {
    try {
      const P = require("./providers");
      const cat = P.get(provider);
      const m = (cat && Array.isArray(cat.models) ? cat.models : []).find((x) => x.id === model);
      if (m) { if (m.ctx1m && session && session.oneM) return 1000000; if (m.ctx) return m.ctx; }
      if (provider === "anthropic" && session && session.oneM && P.context1M("anthropic", model)) return 1000000;
    } catch { /* catalog unavailable → defaults below */ }
    return provider === "openai" ? 272000 : provider === "anthropic" ? 200000 : 128000;
  }
  // Characters of transferred record the first turn of a thread may carry: half the window
  // (the rest is the model's own system prompt/tools, the user's prompt and the turn's work).
  transferBudgetChars(provider, model, session, promptChars = 0) {
    const ctx = this.contextTokensFor(provider, model, session);
    return Math.max(20000, Math.floor(ctx * 0.5) * history.CHARS_PER_TOKEN - (promptChars || 0));
  }
  /* The record a provider's thread is missing — (from, to] — sized to `model`. Returns
   * { text, items, count, mode, note, plan, summary, budget }. A summary transfer also
   * adds the summary card to the chat. */
  async transferBlock(session, provider, { model, from, to, promptChars = 0, forceSummary = false, budgetScale = 1, signal, label, activeTokens = 0 } = {}) {
    if (from >= to) return { text: "", items: [], count: 0, mode: "none", note: "", budget: 0 };
    // A thread that already holds context (partial transfer into an existing thread) has less
    // room; its last known active size is subtracted. The floor keeps a summary transfer possible.
    const raw = this.transferBudgetChars(provider, model, session, promptChars) - Math.max(0, +activeTokens || 0) * history.CHARS_PER_TOKEN;
    const budget = Math.max(10000, Math.floor(raw * (budgetScale || 1)));
    let plan = history.planTransfer(session, from, to, { budgetChars: budget, forceSummary });
    let summary = "", job = null;
    if (plan.mode === "summary") {
      // A cached summary that already covers the head (and a little more) is reused as is —
      // the verbatim tail simply starts after it. No model call for the same conversation twice.
      const wider = history.cachedSummary(session, plan.head.from, plan.tail.to);
      if (wider && wider.upTo > plan.head.to) history.extendHead(plan, wider.upTo);
      job = { calls: 0, input_tokens: 0, output_tokens: 0, ms: 0 };
      summary = await this.summarizeRecord(session, provider, model, plan, { budgetChars: budget, signal, job });
      // SIZE CONTRACT: the assembled block (framing + summary + verbatim tail) must fit the budget.
      // A summary that came back too long is compacted (bounded passes); a block still too large
      // gives the tail a smaller share and rolls the (cached) summary forward over the extra head.
      for (let pass = 0; pass < 3 && history.transferText(plan, summary).length > budget; pass++) {
        const summaryCap = Math.max(4000, Math.floor(budget * 0.35));
        if (summary.length > summaryCap) { summary = await this.compactSummary(session, provider, model, summary, summaryCap, { signal, job }); history.rememberSummary(session, { from: plan.head.from, upTo: plan.head.to, text: summary, provider, model: model || "", ts: store.nowISO(), entries: plan.headCount, compacted: true }); continue; }
        const share = (plan.tailShare || 0.5) / 2;
        if (share < 0.05) break;
        plan = history.planTransfer(session, from, to, { budgetChars: budget, forceSummary: true, tailShare: share });
        if (plan.mode !== "summary") break;
        summary = await this.summarizeRecord(session, provider, model, plan, { budgetChars: budget, signal, job });
      }
      this.addMessage(session, { id: store.uid(), role: "summary", text: summary, ts: store.nowISO(), meta: { provider, model, entries: plan.headCount, fromIndex: plan.head.from + 1, toIndex: plan.head.to, job } });
    }
    const who = label || PROVIDER_LABEL[provider] || provider;
    const n = plan.count, f = (x) => Number(x).toLocaleString("en-US");
    const text = history.transferText(plan, summary);
    const jobNote = job && job.calls ? ` Summary prepared with ${job.calls} model call${job.calls === 1 ? "" : "s"}${job.input_tokens || job.output_tokens ? ` (${f(job.input_tokens)} in / ${f(job.output_tokens)} out tokens)` : ""}.` : "";
    const note = !n ? "" : plan.mode === "exact" ? `${who} receives ${f(n)} earlier conversation entr${n === 1 ? "y" : "ies"} it had not seen (verbatim record).`
      : plan.mode === "shortened" ? `${who} receives ${f(n)} earlier conversation entr${n === 1 ? "y" : "ies"} it had not seen — conversation text verbatim, long tool inputs/outputs shortened to fit the model's context window (full record ${f(plan.fullChars)} characters; about ${f(budget)} available).`
        : `${who} receives a summary of the ${f(plan.headCount)} oldest entries plus the ${f(n - plan.headCount)} most recent entr${n - plan.headCount === 1 ? "y" : "ies"} verbatim — the full record (${f(plan.fullChars)} characters) is larger than the model's context window (about ${f(budget)} characters available for it; this block is ${f(text.length)}).${jobNote}`;
    return { text, items: history.transferItems(plan, summary), count: n, mode: plan.mode, note, plan, summary, budget, job };
  }
  // One bounded pass that condenses an over-long summary (keeps decisions, identifiers, pending work).
  async compactSummary(session, provider, model, summary, capChars, { signal, job } = {}) {
    const words = Math.max(150, Math.floor(capChars / 7));
    const prompt = `The following summary of a conversation is too long for the space available. Rewrite it to at most about ${words} words. Keep every decision, explicit user instruction, exact identifier (paths, names, commands, error messages), completed-work fact and pending item; drop repetition and narrative. Output only the rewritten summary.\n\n---\n\n${summary}`;
    const out = String(await this.summarizeText(session, provider, model, prompt, { signal, job }) || "").trim();
    return out || summary;
  }
  /* Summary of plan.head — rolled forward from the best cached summary of the same span
   * start, in chunks that each fit half the budget, every step cached. */
  async summarizeRecord(session, provider, model, plan, { budgetChars, signal, job } = {}) {
    const from = plan.head.from, upTo = plan.head.to;
    const cached = history.cachedSummary(session, from, upTo);
    let summary = cached ? cached.text : "", covered = cached ? cached.upTo : from;
    if (cached && cached.upTo >= upTo) return summary;
    // Every summariser request (instruction + previous summary + new material) stays within half
    // the budget. One oversized entry is fed in SEGMENTS (ordered, marked) — never whole.
    const chunkChars = Math.max(20000, Math.floor((budgetChars || 200000) * 0.5));
    const prevCap = Math.floor(chunkChars * 0.4);
    if (summary.length > prevCap) summary = await this.compactSummary(session, provider, model, summary, prevCap, { signal, job });
    let i = plan.msgs.findIndex((x) => x.g > covered);
    if (i < 0) return summary;
    // pieces: [{ text, g, last }] — a whole entry, or one segment of an oversized entry
    const pieces = [];
    for (let k = i; k < plan.headCount; k++) {
      const room = chunkChars - prevCap - 600;
      const t = plan.texts[k];
      if (t.length <= room) { pieces.push({ text: t, g: plan.msgs[k].g }); continue; }
      const segs = history.segmentText(t, room);
      segs.forEach((seg, si) => pieces.push({ text: `[entry ${plan.msgs[k].m && plan.msgs[k].m.id ? plan.msgs[k].m.id : plan.msgs[k].g} — part ${si + 1} of ${segs.length}]\n${seg}`, g: plan.msgs[k].g, partial: si < segs.length - 1 }));
    }
    let p = 0;
    while (p < pieces.length) {
      if (signal && signal.aborted) { const e = new Error("Cancelled while summarising the record"); e.name = "AbortError"; throw e; }
      const chunk = []; let used = summary.length + 600, last = covered;
      while (p < pieces.length && (chunk.length === 0 || used + pieces[p].text.length + 7 <= chunkChars)) { chunk.push(pieces[p].text); used += pieces[p].text.length + 7; if (!pieces[p].partial) last = pieces[p].g; p++; }
      const prompt = (summary ? `Summary so far (the earlier part of the conversation):\n${summary}\n\n---\n\nNew entries to fold into the summary, in order:\n\n` : "Conversation entries to summarise, in order:\n\n") + chunk.join("\n\n---\n\n");
      const out = String(await this.summarizeText(session, provider, model, prompt, { signal, job }) || "").trim();
      if (!out) throw new Error("The summary model returned no text — the record could not be condensed.");
      summary = out;
      if (summary.length > prevCap) summary = await this.compactSummary(session, provider, model, summary, prevCap, { signal, job });
      if (last > covered) { covered = last; history.rememberSummary(session, { from, upTo: covered, text: summary, provider, model: model || "", ts: store.nowISO(), entries: plan.msgs.filter((x) => x.g <= covered).length }); }
    }
    return summary;
  }
  // One summarisation request on the same provider (tests inject a fake via setSummarizer).
  setSummarizer(fn) { this._summarizer = fn || null; }
  /* One summarisation request on the same provider. Its usage is charged to the session's totals
   * and to the preparation `job` (calls / tokens / ms) so separate summary calls are never
   * invisible. Tests inject a fake via setSummarizer. */
  async summarizeText(session, provider, model, prompt, { signal, job } = {}) {
    if (signal && signal.aborted) { const e = new Error("Cancelled before summarising"); e.name = "AbortError"; throw e; }
    const t0 = Date.now();
    const charge = (u) => {
      if (job) { job.calls = (job.calls || 0) + 1; job.ms = (job.ms || 0) + (Date.now() - t0); }
      if (!u) return;
      const inT = (u.input_tokens || 0) + (provider === "openai" ? 0 : (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
      const outT = u.output_tokens || 0;
      session.totalTokensIn = (session.totalTokensIn || 0) + inT; session.totalTokensOut = (session.totalTokensOut || 0) + outT;
      if (job) { job.input_tokens = (job.input_tokens || 0) + inT; job.output_tokens = (job.output_tokens || 0) + outT; }
      store.scheduleWrite(session.id);
    };
    if (this._summarizer) { const out = await this._summarizer(provider, model, prompt); charge(null); return out; }
    const settings = store.getSettings(session.cwd);
    if (provider === "openai") {
      const codex = require("./codex"); const P = require("./providers");
      const res = await codex.run({ apiKey: settings.openaiApiKey || undefined, model, effort: P.openaiEffort("low", model), cwd: session.cwd, readOnly: true, signal, promptText: SUMMARY_INSTRUCTIONS + "\n\n" + prompt });
      charge(res && res.usage ? (res.usage.last || res.usage) : null);
      if (res && res.text) return res.text;
      throw new Error((res && res.error) || "Codex returned no summary");
    }
    if (provider === "anthropic") { let usage = null; const out = await this.runHeadlessAnthropic({ settings, model, thinking: "low", oneM: session.oneM, system: SUMMARY_INSTRUCTIONS, prompt, cwd: session.cwd, signal, onResult: (r) => { usage = r && r.usage; } }); charge(usage); return out; }
    if (provider === "custom") {
      const customApi = require("./customApi");
      const ep = customApi.getEndpoint(settings, model);
      const cfg = ep ? { endpoint: ep.endpoint, headers: ep.headers, payloadTemplate: ep.payloadTemplate, outputPath: ep.outputPath, apiKey: ep.apiKey, model: ep.model || ep.id || "" } : { endpoint: settings.customEndpoint, headers: settings.customHeaders, payloadTemplate: settings.customPayloadTemplate, outputPath: settings.customOutputPath, apiKey: settings.customApiKey, model: model || "" };
      const r = await customApi.call({ ...cfg, prompt, system: SUMMARY_INSTRUCTIONS, signal });
      charge(r && r.usage ? r.usage : null);
      if (r && r.ok && r.text) return r.text;
      throw new Error((r && r.error) || "The custom endpoint returned no summary");
    }
    const council = require("./council");
    const r = await council.reviewerRun(provider, model, SUMMARY_INSTRUCTIONS + "\n\n" + prompt);
    charge(null);
    if (r && r.ok && r.text) return r.text;
    throw new Error((r && r.error) || "no summary");
  }
  // The conversation BEFORE the current prompt for a reviewer / planner: exact when it fits
  // that model's window, otherwise the same budgeted transfer the primary would get.
  async recentExchange(session, provider, model, promptIndex) {
    const to = (Number.isFinite(promptIndex) ? promptIndex : history.lastGlobalIndex(session)) - 1;
    const tb = await this.transferBlock(session, provider || "anthropic", { model, from: -1, to, label: "The reviewer" });
    return tb.text;
  }
  async consultReviewers(session, reviewers, prompt, promptMessageId) {
    const council = require("./council");
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    this.addMessage(session, { id: store.uid(), role: "system", text: `Consulting ${reviewers.length} reviewer${reviewers.length > 1 ? "s" : ""} before answering…`, ts: store.nowISO() });
    const out = [];
    for (const rv of reviewers) {
      const ctx = await this.recentExchange(session, rv.provider, rv.model, promptIndex);
      const cprompt = `${ctx ? `${ctx}\n\n` : ""}The user now asks the assistant:\n"""${prompt || "(continue)"}"""\n\nIn 2–5 sentences, give concrete advice on how to answer this — key considerations or a better approach. If the request refers to earlier content, use the conversation above. Do NOT reply to the user yourself.`;
      const r = await council.reviewerRun(rv.provider, rv.model, cprompt);
      this.addMessage(session, { id: store.uid(), role: "reviewer", reviewProvider: rv.provider, reviewModel: rv.model, reviewKind: "consult", asked: cprompt, text: r.ok ? r.text : `(no response — ${r.error || "failed"})`, ts: store.nowISO() });
      if (r.ok && r.text) out.push(`${council.label(rv.provider, rv.model)} advises:\n${r.text}`);
    }
    return out.length ? "Advice from the reviewers the user configured (weigh it, then answer yourself):\n\n" + out.join("\n\n") : "";
  }
  async reviewAfter(session, reviewers, prompt, promptMessageId) {
    const answer = this.lastAssistantText(session);
    if (!answer) return;
    const council = require("./council");
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    this.addMessage(session, { id: store.uid(), role: "system", text: `Handing the answer to ${reviewers.length} reviewer${reviewers.length > 1 ? "s" : ""} for review…`, ts: store.nowISO() });
    store.updateSession(session.id, { status: "running" });
    this.send("session:status", { sessionId: session.id, status: "running" });
    for (const rv of reviewers) {
      const ctx = await this.recentExchange(session, rv.provider, rv.model, promptIndex);
      const rprompt = `${ctx ? `${ctx}\n\n` : ""}A user asked:\n"""${prompt}"""\n\nAnother AI proposed this answer:\n"""${answer}"""\n\nIn 2–6 sentences review it: correctness, gaps, risks and concrete improvements. Be specific.`;
      const r = await council.reviewerRun(rv.provider, rv.model, rprompt);
      this.addMessage(session, { id: store.uid(), role: "reviewer", reviewProvider: rv.provider, reviewModel: rv.model, reviewKind: "review", asked: rprompt, text: r.ok ? r.text : `(no response — ${r.error || "failed"})`, ts: store.nowISO() });
    }
    store.updateSession(session.id, { status: "done" });
    this.send("session:status", { sessionId: session.id, status: "done" });
  }

  /* ----------------------------- OpenAI / Codex primary -----------------------------
   * Streaming primary via the Codex app-server (codex-appserver.js): live text +
   * reasoning deltas, per-tool cards, live command output, approvals answered by
   * the app, token usage, thread resume and EXACT conversation transfer into the
   * thread (thread/inject_items). Falls back to the Codex SDK exec transport when
   * the app-server cannot start; if neither transport is available the request is
   * preserved as a recoverable state — never downgraded to a batch CLI run.
   */
  async runOpenAI(sessionId, session, { text, attachments, reviewers, reviewMode, background, fleet, extraSystem, promptMessageId }, reviewerBeforeDigest, settings, dispatched) {
    const providers = require("./providers");
    settings = settings || store.getSettings(session.cwd);
    // Strict capability checks: the model must be listed for this Codex install /
    // account and the effort must be on that model's ladder. No remapping.
    const wanted = /gpt|^o\d|codex|daybreak/i.test(session.model || "") ? session.model : "";
    const rs = providers.resolveOpenAIModelStrict(wanted);
    if (rs.error) return this.failRun(session, rs.error);
    const model = rs.model;
    const re = providers.openaiEffortStrict(session.thinking, model);
    if (re.error) return this.failRun(session, re.error);
    const effort = re.effort;

    const { digests: skillDigests, names: skillNames } = this.selectedSkillDigests(session);
    const appendix = this.workflowAppendix({ skillDigests, extraSystem, reviewerDigest: reviewerBeforeDigest });
    const promptText = (text || "") + appendix;   // exact user text first; no caps
    const atts = attachments || [];
    const files = atts.filter((a) => a.kind !== "image" && a.path).map((a) => ({ path: a.path, name: a.name }));
    const images = atts.filter((a) => a.kind === "image" && a.path).map((a) => ({ path: a.path }));

    session._replyMeta = this.replyMeta("openai", model, effort, reviewers, reviewMode);
    const abortController = new AbortController();
    const runId = newRunId();
    const runner = { id: runId, running: true, abortController, promptText: text || "", codex: true, provider: "openai", model, effort };
    runner.done = new Promise((res) => { runner._resolveDone = res; });
    this.runners.set(sessionId, runner);
    const appserver = require("./codex-appserver");
    const authCtx = { apiKey: settings.openaiApiKey || "" };
    const ctxKey = appserver.ctxKeyOf(authCtx);
    // The binding is only a resume candidate when it was created in THIS auth
    // context — a thread from another account/home is never resumed under this one.
    const binding = history.bindingFor(session, "openai");
    const resumeId = binding.id && (!binding.account || binding.account === ctxKey) ? binding.id : null;
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    runner.promptIndex = promptIndex; runner.bindingProvider = "openai";
    // The prompt alone must fit the model's window (images count as native inputs, files are
    // read by Codex itself — only the text is measured here).
    const ctxTokens = this.contextTokensFor("openai", model, session);
    if (promptText.length + images.length * 6400 > ctxTokens * history.CHARS_PER_TOKEN * 0.9) {
      this.runners.delete(sessionId);
      return this.failRun(session, `Your message alone is about ${Math.round(promptText.length / history.CHARS_PER_TOKEN).toLocaleString("en-US")} tokens — larger than the model's context window (${ctxTokens.toLocaleString("en-US")} tokens). It was not sent. Split it, or attach the large part as a file Codex can read in pieces.`);
    }
    this._lastRun = { sessionId, runId, sent: { provider: "openai", model, effort, authContext: ctxKey, threadResumed: !!resumeId, skills: skillNames, background: !!background, fleet: !!(fleet && fleet.taskId), files: files.length, images: images.length }, init: null };

    const pendingRetry = () => ({ text, attachments, reviewers, reviewMode, background, fleet, extraSystem, resumeContinuation: true, promptMessageId });

    // ---- Tool cards: map Codex thread items to the app's live tool messages ----
    const toolMsgId = new Map();   // codex item.id (or item.id#i for one file of a patch) -> our tool message id
    const itemsSeen = new Map();   // codex item.id -> last item seen (enriches approval cards)
    const kindOf = (c) => (c && c.kind && typeof c.kind === "object") ? c.kind.type : (c && c.kind);
    const absp = (p) => (p && session.cwd && !path.isAbsolute(p)) ? path.join(session.cwd, p) : p;
    const cards = require("./codex-cards");
    const unwrapCmd = cards.unwrapCmd, parseDiff = cards.parseDiff;
    const classifyCmd = (cmd) => cards.classifyCmd(cmd, absp);
    const changeCards = (it) => (it.changes || []).map((c, i) => {
      const kind = kindOf(c) || "update", d = parseDiff(c.diff), fp = absp(c.path);
      const key = `${it.id}#${i}`;
      if (kind === "add") return { key, fp, d, toolName: "Write", toolInput: { file_path: fp, content: d.newText } };
      if (kind === "delete") return { key, fp, d, toolName: "Delete", toolInput: { file_path: fp } };
      return { key, fp, d, toolName: "Edit", toolInput: { file_path: fp, old_string: d.oldText, new_string: d.newText, ...(c.kind && c.kind.move_path ? { rename_to: absp(c.kind.move_path) } : {}) } };
    });
    const cardFor = (it) => {
      const t = it.type;
      if (t === "commandExecution" || t === "command_execution") {
        const acts = Array.isArray(it.commandActions) ? it.commandActions : [];
        const a = acts[0];
        if (a && acts.every((x) => x.type === "read") && a.path) return { toolName: "Read", toolInput: { file_path: absp(a.path), ...(acts.length > 1 ? { files: acts.map((x) => absp(x.path)) } : {}) } };
        if (a && a.type === "listFiles" && acts.length === 1) return { toolName: "Glob", toolInput: { pattern: (a.path ? String(a.path).replace(/[\\/]+$/, "") + "/" : "") + "*", ...(a.path ? { path: absp(a.path) } : {}) } };
        if (a && a.type === "search" && acts.length === 1) return { toolName: "Grep", toolInput: { pattern: a.query || unwrapCmd(a.command || it.command), ...(a.path ? { path: absp(a.path) } : {}) } };
        const bare = unwrapCmd(it.command);
        const own = classifyCmd(bare);
        if (own) return { toolName: own.toolName, toolInput: { ...own.toolInput, command: bare } };
        return { toolName: "Bash", toolInput: { command: bare, ...(it.cwd && it.cwd !== session.cwd ? { cwd: it.cwd } : {}) } };
      }
      if (t === "webSearch" || t === "web_search") return { toolName: "WebSearch", toolInput: { query: it.query || "" } };
      if (t === "mcpToolCall" || t === "mcp_tool_call") return { toolName: `mcp:${it.server}/${it.tool}`, toolInput: it.arguments };
      if (t === "dynamicToolCall") return { toolName: it.tool || "tool", toolInput: it.arguments || {} };
      if (t === "imageView") return { toolName: "Read", toolInput: { file_path: absp(it.path || "") } };
      if (t === "collabAgentToolCall") return { toolName: "Task", toolInput: { description: it.prompt || String(it.tool || "agent"), ...(it.model ? { subagent_type: it.model } : {}) } };
      if (t === "subAgentActivity") return { toolName: "Task", toolInput: { description: `${it.kind || "sub-agent"} ${it.agentPath || ""}`.trim() } };
      if (t === "imageGeneration") return { toolName: "ImageGeneration", toolInput: { prompt: it.prompt || "" } };
      if (t === "todo_list") return { toolName: "TodoWrite", toolInput: { todos: (it.items || []).map((x) => ({ content: x.text, status: x.completed ? "completed" : "pending" })) } };
      return { toolName: t, toolInput: {} };
    };
    const isFileChange = (it) => it.type === "fileChange" || it.type === "file_change";
    const addCard = (key, itemId, c) => {
      const mid = store.uid();
      toolMsgId.set(key, mid);
      this.addMessage(session, { id: mid, role: "tool", toolName: c.toolName, toolUseId: itemId, runId, toolInput: c.toolInput, status: "running", ts: store.nowISO() });
      return mid;
    };
    const startCard = (it) => {
      itemsSeen.set(it.id, it);
      if (isFileChange(it)) {
        for (const c of changeCards(it)) {
          if (toolMsgId.has(c.key)) continue;
          addCard(c.key, it.id, c);
          this.trackEdit(session, c.fp, c.toolName, { added: c.d.added, removed: c.d.removed });
        }
        return;
      }
      if (toolMsgId.has(it.id)) return;
      addCard(it.id, it.id, cardFor(it));
    };
    // Live command output: deltas are batched into the running card ~5×/s. The full
    // output is kept; the renderer pages/virtualises long results.
    const outBuf = new Map(), outTimer = new Map();
    const flushOut = (itemId) => { const t = outTimer.get(itemId); if (t) clearTimeout(t); outTimer.delete(itemId); const mid = toolMsgId.get(itemId); if (mid && outBuf.has(itemId)) this.updateMessage(session, mid, { result: outBuf.get(itemId) || "" }); };
    const onToolOutput = (itemId, delta) => { if (!delta) return; outBuf.set(itemId, (outBuf.get(itemId) || "") + delta); if (!outTimer.has(itemId)) outTimer.set(itemId, setTimeout(() => flushOut(itemId), 200)); };
    const endCard = (it) => {
      itemsSeen.set(it.id, it);
      const declined = it.status === "declined";
      if (isFileChange(it)) {
        const cs = changeCards(it);
        if (!cs.length && !toolMsgId.has(it.id)) addCard(it.id, it.id, { toolName: "Edit", toolInput: {} });
        const failed = declined || it.status === "failed";
        for (const c of cs) {
          if (!toolMsgId.has(c.key)) { addCard(c.key, it.id, c); this.trackEdit(session, c.fp, c.toolName, { added: c.d.added, removed: c.d.removed }); }
          const result = declined ? "Declined — not applied." : failed ? "Failed to apply this change." : `${c.toolName === "Write" ? "Wrote" : c.toolName === "Delete" ? "Deleted" : "Updated"} ${path.basename(c.fp || "")}  (+${c.d.added} −${c.d.removed})`;
          this.updateMessage(session, toolMsgId.get(c.key), { status: failed ? "error" : "done", toolInput: c.toolInput, result, endedTs: store.nowISO() });
        }
        return;
      }
      let mid = toolMsgId.get(it.id);
      if (!mid) { startCard(it); mid = toolMsgId.get(it.id); }
      const t0 = outTimer.get(it.id); if (t0) { clearTimeout(t0); outTimer.delete(it.id); }
      const exit = typeof it.exitCode === "number" ? it.exitCode : (typeof it.exit_code === "number" ? it.exit_code : null);
      const failed = declined || it.status === "failed" || (exit !== null && exit !== 0) || it.success === false;
      let result = "";
      const t = it.type;
      if (t === "commandExecution" || t === "command_execution") result = it.aggregatedOutput || it.aggregated_output || outBuf.get(it.id) || "";
      else if (t === "mcpToolCall" || t === "mcp_tool_call") result = it.error ? (it.error.message || "") : ((it.result && Array.isArray(it.result.content)) ? it.result.content.map((c) => (c && c.text) || "").filter(Boolean).join("\n") : "");
      else if (t === "dynamicToolCall") result = (it.contentItems || []).map((c) => (c && (c.text || c.output)) || "").filter(Boolean).join("\n");
      else if (t === "webSearch" || t === "web_search") result = it.query || "";
      if (declined) result = (result ? result + "\n" : "") + "Declined — not run.";
      else if (exit !== null && exit !== 0) result = (result ? result + "\n" : "") + `exit code ${exit}`;
      // Codex often classifies a command (read/search/list) only at completion → re-derive the card.
      const c = cardFor(it);
      const cur = session.messages.find((x) => x.id === mid);
      const rename = cur && (cur.toolName !== c.toolName || JSON.stringify(cur.toolInput) !== JSON.stringify(c.toolInput)) ? { toolName: c.toolName, toolInput: c.toolInput } : {};
      this.updateMessage(session, mid, { status: failed ? "error" : "done", result: String(result || ""), endedTs: store.nowISO(), ...rename });
      outBuf.delete(it.id);
    };
    let planMid = null;
    const onPlan = (steps, explanation) => {
      const todos = (steps || []).map((s) => ({ content: s.step, status: s.status === "inProgress" ? "in_progress" : (s.status || "pending") }));
      if (!todos.length) return;
      if (!planMid) { planMid = store.uid(); this.addMessage(session, { id: planMid, role: "tool", toolName: "TodoWrite", toolUseId: planMid, runId, toolInput: { todos }, status: "done", result: explanation || "", ts: store.nowISO() }); }
      else this.updateMessage(session, planMid, { toolInput: { todos }, result: explanation || "" });
    };
    const notice = (msg) => {
      const t = "Codex: " + String(msg || "").trim();
      if (!msg) return;
      const seen = (this._codexNotices ||= new Map()).get(session.id) || new Set();
      this._codexNotices.set(session.id, seen);
      if (seen.has(t)) { console.warn("[codex]", String(msg).slice(0, 200)); return; }
      seen.add(t);
      this.addMessage(session, { id: store.uid(), role: "system", text: t, ts: store.nowISO() });
    };
    let assistantCount = 0;
    const onAgentMessage = (t) => {
      if (!t || !t.trim()) return;
      this.send("session:partial-reset", { sessionId, index: 0 });
      this.addMessage(session, { id: store.uid(), role: "assistant", text: t, ts: store.nowISO(), meta: session._replyMeta });
      assistantCount++;
    };
    // Approvals: decided from the tab's permission mode, read LIVE so a mid-turn
    // change applies to the next request. Full access → auto-approve; Plan → nothing
    // that changes state; Accept edits → file changes auto, commands ask; Ask → ask.
    const permModeNow = () => session.permissionMode || settings.defaultPermissionMode || "default";
    const askUser = async (toolName, input) => { const d = await this.requestPermission(sessionId, toolName, input, abortController.signal, runId); return !!(d && d.behavior === "allow"); };
    const decide = async (kind, p, c) => {
      const mode = permModeNow();
      if (runner.interrupted || abortController.signal.aborted) return { decision: "cancel", grant: false, answers: {} };
      const item = (c && c.item) || itemsSeen.get(p.itemId) || null;
      if (kind === "command") {
        if (mode === "bypassPermissions") return { decision: "accept" };
        if (mode === "plan") return { decision: "decline" };
        const cc = item ? cardFor({ ...item, command: p.command || item.command, commandActions: p.commandActions || item.commandActions }) : { toolName: "Bash", toolInput: { command: unwrapCmd(p.command || "") } };
        const ok = await askUser(cc.toolName, { ...cc.toolInput, ...(p.reason ? { description: p.reason } : {}), ...(p.kind === "writeStdin" ? { stdin: true } : {}) });
        return { decision: ok ? "accept" : "decline" };
      }
      if (kind === "fileChange") {
        if (mode === "bypassPermissions" || mode === "acceptEdits") return { decision: "accept" };
        if (mode === "plan") return { decision: "decline" };
        const cs = item ? changeCards(item) : [];
        const first = cs[0] || { toolName: "Edit", toolInput: { file_path: p.grantRoot || "" } };
        const ok = await askUser(first.toolName, { ...first.toolInput, ...(cs.length > 1 ? { files: cs.map((x) => x.fp) } : {}), ...(p.reason ? { reason: p.reason } : {}) });
        return { decision: ok ? "accept" : "decline" };
      }
      if (kind === "permissions") {
        if (mode === "bypassPermissions" || mode === "acceptEdits") return { grant: true, scope: "turn" };
        if (mode === "plan") return { grant: false, message: "Plan mode — no additional permissions" };
        const ok = await askUser("Permissions", { reason: p.reason || "", ...(p.permissions || {}) });
        return ok ? { grant: true, scope: "turn" } : { grant: false, message: "Declined by user" };
      }
      if (kind === "userInput") {
        const qs = (p.questions || []).map((q) => ({ header: q.header || q.id, question: q.question, multiSelect: false, options: (q.options || []).map((o) => ({ label: o.label, description: o.description || "" })).concat(q.isOther ? [{ label: "Other", description: "Something else" }] : []) }));
        if (!qs.length) return { answers: {} };
        const d = await this.requestPermission(sessionId, "AskUserQuestion", { questions: qs }, abortController.signal, runId);
        // The renderer answers as ALLOW with updatedInput.answers (question text → "label, label");
        // an older message-line form is still understood.
        const given = (d && d.behavior === "allow" && d.updatedInput && d.updatedInput.answers && typeof d.updatedInput.answers === "object") ? d.updatedInput.answers : null;
        const lines = given ? [] : String((d && d.message) || "").split("\n").map((l) => l.replace(/^•\s*/, "").trim()).filter(Boolean);
        const answers = {};
        for (const q of (p.questions || [])) {
          const label = String(q.header || q.id || q.question || "");
          let picked = null;
          if (given) { const v = given[q.question] != null ? given[q.question] : given[label]; if (typeof v === "string") picked = v; }
          else { const line = lines.find((l) => l.startsWith(label + ":")); if (line) picked = line.slice(label.length + 1); }
          if (picked != null) answers[q.id] = { answers: String(picked).split(",").map((s) => s.trim()).filter(Boolean) };
        }
        return { answers };
      }
      if (kind === "elicitation") return { action: "decline", content: null, _meta: null };
      return null;
    };

    // Conversation transfer into the Codex thread. A NEW thread receives everything
    // before the current prompt; a resumed thread receives only what it missed.
    // Sized to the model (exact → shortened tool payloads → cached summary + newest verbatim).
    // After a "context window exceeded" failure the retry forces the summary within half the budget.
    let transferOpts = { forceSummary: false, budgetScale: 1, to: promptIndex - 1, extra: "" };
    const transferInto = async (threadId, isNew) => {
      const b = history.bindingFor(session, "openai");
      const from = isNew ? -1 : b.syncedIndex;
      const to = transferOpts.to;
      if (from >= to) return 0;
      const tb = await this.transferBlock(session, "openai", { model, from, to, promptChars: promptText.length + (transferOpts.extra || "").length, signal: abortController.signal, forceSummary: transferOpts.forceSummary, budgetScale: transferOpts.budgetScale, activeTokens: from > -1 ? (b.activeTokens || 0) : 0 });
      if (!tb.count) return 0;
      await appserver.injectItems(threadId, tb.items);
      // ACKNOWLEDGED: the thread holds this span now. Recorded immediately so a failure later in
      // the turn (network, cancel) never injects the same history a second time.
      history.setBinding(session, "openai", { syncedIndex: to });
      this.addMessage(session, { id: store.uid(), role: "system", text: tb.note.replace(/\.$/, "") + " — injected into its thread.", ts: store.nowISO() });
      if (this._lastRun && this._lastRun.sessionId === sessionId) { this._lastRun.sent.transferredEntries = tb.count; this._lastRun.sent.transferMode = tb.mode; }
      return tb.count;
    };
    const contextExceeded = (r) => !!r && !r.ok && !r.aborted && (isPromptTooLong(r.error) || (r.errorInfo && (r.errorInfo === "contextWindowExceeded" || (typeof r.errorInfo === "object" && "contextWindowExceeded" in r.errorInfo))));

    let turnUsage = null;
    try {
      this.send("session:partial-reset", { sessionId });
      const permMode = permModeNow();
      const streamOn = {
        onThreadId: (id, isNew, ctx) => { history.setBinding(session, "openai", { id, account: ctx || ctxKey, ...(isNew ? { syncedIndex: -1 } : {}) }); },
        onAccount: (acct) => { if (acct && session._replyMeta) { session._replyMeta.account = acct.email || acct.type; session._replyMeta.accountType = acct.type; } },
        onTextDelta: (d) => this.send("session:partial", { sessionId, index: 0, kind: "text", delta: d }),
        // Codex reasoning summaries are markdown headlines ("**Planning rollback**"); the thinking card is plain text.
        onReasoningDelta: (d) => this.send("session:partial", { sessionId, index: 1, kind: "thinking", delta: String(d || "").replace(/\*\*/g, "") }),
        onReasoning: (t) => { const tt = String(t || "").replace(/\*\*/g, "").trim(); this.send("session:partial-reset", { sessionId, index: 1 }); if (tt) this.addMessage(session, { id: store.uid(), role: "thinking", text: tt, ts: store.nowISO() }); },
        onToolStart: startCard, onToolEnd: endCard,
        onUsage: (u) => { turnUsage = u; runner.usage = u; },
      };
      const runApp = (resume) => appserver.run({
        apiKey: authCtx.apiKey,
        model, effort, cwd: session.cwd, promptText: promptText + (transferOpts.extra || ""), images, files,
        resumeId: resume,
        mode: permMode, signal: abortController.signal, decide,
        reasoningSummary: settings.codexReasoningSummary || undefined,
        webSearch: settings.openaiWebSearch,
        beforeTurn: transferInto,
        on: {
          ...streamOn,
          onTurnId: (turnId) => {
            runner.query = { interrupt: () => appserver.interrupt(session.codexThreadId, turnId), steer: (t, imgs, fls) => appserver.steer(session.codexThreadId, turnId, t, imgs, fls) };
            // The turn started: the thread has accepted this prompt. Acknowledge it on the cursor now
            // so a stop/failure later never re-injects an accepted prompt (see finalizeRun).
            runner.accepted = true;
            const b = history.bindingFor(session, "openai");
            if (b.syncedIndex < promptIndex) history.setBinding(session, "openai", { syncedIndex: promptIndex });
          },
          onAgentMessage, onToolOutput, onPlan, onNotice: notice,
          onToolUpdate: (it) => { itemsSeen.set(it.id, it); if (it.progress) { const mid = toolMsgId.get(it.id); if (mid) this.updateMessage(session, mid, { progress: String(it.progress) }); } },
          onRetry: (m) => notice("Reconnecting… " + m),
          onRerouted: (from, to, reason) => { notice(`rerouted ${from} → ${to}${reason ? ` (${typeof reason === "string" ? reason : JSON.stringify(reason)})` : ""}`); if (session._replyMeta) { session._replyMeta.servedModel = to; } },
        },
      });
      let res = await runApp(resumeId);
      // The resumed thread is gone: explicit recovery — a new thread that receives
      // the FULL record, announced. Never a blank thread pretending to continue.
      if (res.threadLost && !abortController.signal.aborted) {
        console.warn("[codex] thread lost —", res.error);
        history.dropBinding(session, "openai");
        this.addMessage(session, { id: store.uid(), role: "system", text: "Codex's thread for this conversation no longer exists. A new thread is being started with the conversation record.", ts: store.nowISO() });
        res = await runApp(null);
      }
      // The thread (or the injected record) does not fit the model's window: ONE recovery —
      // a new thread that receives a summarised record within half the budget.
      if (contextExceeded(res) && !abortController.signal.aborted && !runner.retriedTooLong) {
        // ONE recovery — a new thread with a summarised record at half the budget. Work the failing
        // attempt already did (canonical entries after the prompt) travels too, and the model is
        // asked to continue from it rather than redo it.
        runner.retriedTooLong = true; runner.accepted = false;
        console.warn("[codex] context window exceeded — new thread with a summarised record:", res.error);
        history.dropBinding(session, "openai");
        const cont = this.continuationAfter(session, promptIndex);
        transferOpts = { forceSummary: true, budgetScale: 0.5, to: cont.to, extra: cont.note };
        this.addMessage(session, { id: store.uid(), role: "system", text: `Codex rejected the request as too large for the model's context window. A new thread is being started with a summary of the conversation so far and the most recent entries verbatim.${cont.count ? ` The ${cont.count} entr${cont.count === 1 ? "y" : "ies"} the interrupted attempt produced travel with it, and the model is asked to continue rather than start over.` : ""}`, ts: store.nowISO() });
        if (this._lastRun && this._lastRun.sessionId === sessionId) { this._lastRun.sent.promptTooLongRecovery = true; this._lastRun.sent.continuationEntries = cont.count; }
        res = await runApp(null);
      }
      // FALLBACK: app-server unavailable → the Codex SDK exec transport (coarser
      // streaming; approvals cannot be asked). Same exact text, attachments and record.
      if (res.loadFailed) {
        notice("app-server unavailable — using the Codex SDK exec transport (no live streaming or approvals). " + String(res.error || ""));
        const codex = require("./codex");
        const b = history.bindingFor(session, "openai");
        const sync = history.pendingSync(session, "openai", promptIndex);
        const execOpts = (resume) => ({ apiKey: authCtx.apiKey || undefined, model, effort, cwd: session.cwd, attachments: atts, resumeId: resume, signal: abortController.signal, webSearch: settings.openaiWebSearch, reasoningSummary: settings.codexReasoningSummary || undefined, readOnly: permMode === "plan", on: { ...streamOn, onErrorItem: notice } });
        const withRecord = (tb) => (tb && tb.text ? tb.text + "\n\n---\n\n" : "") + promptText;
        const block = sync.needed ? await this.transferBlock(session, "openai", { model, from: sync.from, to: sync.to, promptChars: promptText.length, signal: abortController.signal, ...transferOpts }) : { text: "", count: 0, mode: "none", note: "" };
        if (block.count) this.addMessage(session, { id: store.uid(), role: "system", text: block.note, ts: store.nowISO() });
        const execRes = await codex.run({ ...execOpts(b.id && (!b.account || b.account === ctxKey) ? b.id : null), promptText: withRecord(block) });
        if (execRes.threadLost && !abortController.signal.aborted) {
          history.dropBinding(session, "openai");
          const full = await this.transferBlock(session, "openai", { model, from: -1, to: promptIndex - 1, promptChars: promptText.length, signal: abortController.signal, ...transferOpts });
          this.addMessage(session, { id: store.uid(), role: "system", text: `Codex's thread for this conversation no longer exists. Starting a new one. ${full.note}`.trim(), ts: store.nowISO() });
          res = await codex.run({ ...execOpts(null), promptText: withRecord(full) });
        } else res = execRes;
        if (contextExceeded(res) && !abortController.signal.aborted && !runner.retriedTooLong) {
          runner.retriedTooLong = true;
          history.dropBinding(session, "openai");
          const tb = await this.transferBlock(session, "openai", { model, from: -1, to: promptIndex - 1, promptChars: promptText.length, forceSummary: true, budgetScale: 0.5, signal: abortController.signal });
          this.addMessage(session, { id: store.uid(), role: "system", text: `Codex rejected the request as too large for the model's context window. Starting a new thread. ${tb.note}`.trim(), ts: store.nowISO() });
          res = await codex.run({ ...execOpts(null), promptText: withRecord(tb) });
        }
        if (res.usage && !turnUsage) turnUsage = res.usage;
      }
      for (const itemId of Array.from(outTimer.keys())) flushOut(itemId);   // pending command output → cards

      // NEITHER transport could run: recoverable state. The request is preserved for
      // Retry; nothing is silently downgraded to a batch CLI run.
      if (res.loadFailed) {
        session._pendingRetry = pendingRetry();
        this.addMessage(session, { id: store.uid(), role: "error", text: "Codex is unavailable: neither the app-server nor the Codex SDK could start (" + String(res.error || "unknown error") + "). Your message is preserved — fix the Codex install (Settings → Providers → Tools) and click Retry.", ts: store.nowISO() });
        runner.failed = true;
        this.finalizeRun(session, runner, { aborted: false, failed: true });
        return;
      }
      const info = res.errorInfo;
      const infoIs = (k) => info === k || (info && typeof info === "object" && k in info);
      if (res.ok) {
        this.send("session:partial-reset", { sessionId });
        if (!assistantCount && (res.text || "").trim()) this.addMessage(session, { id: store.uid(), role: "assistant", text: res.text, ts: store.nowISO(), meta: session._replyMeta });
        else if (!assistantCount) this.addMessage(session, { id: store.uid(), role: "system", text: "Codex finished the turn with no text reply.", ts: store.nowISO() });
        // Usage: apply the turn's FINAL numbers exactly once (Codex reports cumulative-within-turn).
        const u = (turnUsage && (turnUsage.last || turnUsage)) || (res.usage && (res.usage.last || res.usage)) || null;
        if (u) {
          // OpenAI's usage contract: cached / cache-write tokens are SUBSETS of input_tokens (unlike
          // Anthropic's three separate input components) — count the input once.
          session.totalTokensIn = (session.totalTokensIn || 0) + (u.input_tokens || 0);
          session.totalTokensOut = (session.totalTokensOut || 0) + (u.output_tokens || 0);
          this.addMessage(session, { id: store.uid(), role: "result", text: "", ts: store.nowISO(), meta: { subtype: "success", isError: false, usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: u.cached_input_tokens || 0, cache_creation_input_tokens: u.cache_write_input_tokens || 0, cacheIsSubsetOfInput: true }, contextWindow: turnUsage && turnUsage.context_window || null, provider: "openai", account: session._replyMeta && session._replyMeta.account || "" } });
          history.setBinding(session, "openai", { activeTokens: (u.input_tokens || 0), activeTokensTs: store.nowISO() });
        }
        session._retryAttempt = 0;
        history.setBinding(session, "openai", { syncedIndex: history.lastGlobalIndex(session) });
        store.scheduleWrite(sessionId);
        this.finalizeRun(session, runner, { aborted: false });
      } else if (res.aborted || runner.interrupted || abortController.signal.aborted) {
        this.finalizeRun(session, runner, { aborted: true });
      } else if (isRateLimitError(res.error) || infoIs("rateLimitExceeded") || infoIs("usageLimitExceeded") || infoIs("serverOverloaded")) {
        session._pendingRetry = pendingRetry();
        runner.running = false; if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId);
        this.scheduleRetry(sessionId, "ratelimited");
        return;
      } else if (isNetworkError(res.error) || infoIs("httpConnectionFailed") || infoIs("responseStreamConnectionFailed") || infoIs("responseStreamDisconnected")) {
        session._pendingRetry = pendingRetry();
        store.updateSession(sessionId, { status: "offline" }); this.send("session:status", { sessionId, status: "offline" });
      } else if (res.authFailed || infoIs("unauthorized")) {
        // Login expired / key rejected: pause with the request preserved (the thread
        // binding is kept — it is still this account's thread).
        const payload = pendingRetry();
        session._pendingRetry = payload;
        this.addMessage(session, { id: store.uid(), role: "system", text: "Your OpenAI (Codex) login is not valid right now — this session is paused. Sign in again (Settings → Providers) and it resumes automatically.", ts: store.nowISO() });
        store.updateSession(sessionId, { status: "auth-expired", pendingRun: { payload, reason: "auth", provider: "openai", at: store.nowISO() } });
        this.send("session:status", { sessionId, status: "auth-expired", provider: "openai" });
      } else {
        const hint = res.resumeFailed ? "  (The existing Codex thread is kept — retry when Codex is reachable.)"
          : infoIs("contextWindowExceeded") ? "  (Context window exceeded — start a new session or let Codex compact.)"
          : infoIs("sandboxError") ? "  (Sandbox error — try Full access, or check the Windows sandbox setup in Codex.)"
          : "";
        this.addMessage(session, { id: store.uid(), role: "error", text: "OpenAI / Codex run failed: " + (res.error || "no output") + hint, ts: store.nowISO() });
        runner.failed = true;
        this.finalizeRun(session, runner, { aborted: false, failed: true });
      }
    } catch (e) {
      console.error("[openai:run]", e);
      if (isNetworkError(e)) {
        session._pendingRetry = pendingRetry();
        store.updateSession(sessionId, { status: "offline" }); this.send("session:status", { sessionId, status: "offline" });
      } else if (isRateLimitError(e)) {
        session._pendingRetry = pendingRetry();
        this.scheduleRetry(sessionId, "ratelimited");
      } else {
        this.addMessage(session, { id: store.uid(), role: "error", text: "OpenAI / Codex run failed: " + String((e && e.message) || e), ts: store.nowISO() });
        runner.failed = true;
        this.finalizeRun(session, runner, { aborted: false, failed: true });
      }
    } finally {
      for (const t of outTimer.values()) clearTimeout(t);
      runner.running = false; runner.ended = true;
      clearTimeout(runner._graceTimer);
      if (this.runners.get(sessionId) === runner) { this.send("session:partial-reset", { sessionId }); this.runners.delete(sessionId); }
      if (this.draining.get(sessionId) === runner.done) this.draining.delete(sessionId);
      this.cancelPermissionsFor(sessionId, runId, "Run ended");
      store.flush(sessionId);
      if (runner._resolveDone) runner._resolveDone();
    }

    if (Array.isArray(reviewers) && reviewers.length && reviewMode === "after" && runner.completedClean && !background && !(fleet && fleet.taskId)) {
      try { await this.reviewAfter(session, reviewers, text || "", promptMessageId); } catch (e) { console.error("[council:after]", e); }
    }
  }

  /* --------------------------- Custom raw-HTTP primary ----------------------
   * A stateless HTTP API has no thread: every request carries the exact
   * conversation record (system) plus the user's message (prompt). Attached text
   * files are inlined in full; images are reported as unsupported by this transport.
   */
  async runCustomHttp(sessionId, session, { text, attachments, reviewers, reviewMode, background, fleet, extraSystem, promptMessageId }, reviewerBeforeDigest, settings, endpoint) {
    const customApi = require("./customApi");
    const fs = require("fs");
    settings = settings || store.getSettings(session.cwd);
    const cfg = endpoint ? {
      endpoint: endpoint.endpoint, headers: endpoint.headers, payloadTemplate: endpoint.payloadTemplate,
      outputPath: endpoint.outputPath, apiKey: endpoint.apiKey, model: endpoint.model || endpoint.id || "",
      label: endpoint.name || endpoint.id,
    } : {
      endpoint: settings.customEndpoint, headers: settings.customHeaders, payloadTemplate: settings.customPayloadTemplate,
      outputPath: settings.customOutputPath, apiKey: settings.customApiKey, model: session.model || "",
      label: "Custom",
    };
    const model = cfg.model;
    const { digests: skillDigests, names: skillNames } = this.selectedSkillDigests(session);
    const atts = attachments || [];
    const fileAtts = atts.filter((a) => a.kind !== "image" && a.path);
    let filesText = "";
    if (fileAtts.length) {
      const parts = [];
      for (const f of fileAtts) {
        try { parts.push(`--- ${f.name || f.path} ---\n${fs.readFileSync(f.path, "utf8")}`); }
        catch (e) { parts.push(`--- ${f.name || f.path} --- (could not read: ${(e && e.code) || e})`); }
      }
      filesText = "\n\nAttached files:\n" + parts.join("\n\n");
    }
    const imageAtts = atts.filter((a) => a.kind === "image");
    if (imageAtts.length) this.addMessage(session, { id: store.uid(), role: "system", text: `${imageAtts.length} image attachment${imageAtts.length > 1 ? "s were" : " was"} not sent: this custom HTTP endpoint is configured as text-only.`, ts: store.nowISO() });
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    const promptText = (text || "") + filesText + this.workflowAppendix({ skillDigests, extraSystem, reviewerDigest: reviewerBeforeDigest });
    const ctxTokens = this.contextTokensFor("custom", model, session);
    if (promptText.length > ctxTokens * history.CHARS_PER_TOKEN * 0.9) return this.failRun(session, `Your message (with inlined files) is about ${Math.round(promptText.length / history.CHARS_PER_TOKEN).toLocaleString("en-US")} tokens — larger than the model's context window (${ctxTokens.toLocaleString("en-US")} tokens assumed for this endpoint). It was not sent. Split it, or attach less at once.`);

    session._replyMeta = this.replyMeta("custom", model || "custom", session.thinking, reviewers, reviewMode);
    session._replyMeta.endpointName = cfg.label;
    const abortController = new AbortController();
    const runId = newRunId();
    const runner = { id: runId, running: true, abortController, promptText: text || "", provider: "custom", model, promptIndex };
    runner.done = new Promise((res) => { runner._resolveDone = res; });
    this.runners.set(sessionId, runner);
    this._lastRun = { sessionId, runId, sent: { provider: "custom", mode: "raw", model, endpointName: cfg.label, endpoint: cfg.endpoint, transferredEntries: 0, skills: skillNames, background: !!background, fleet: !!(fleet && fleet.taskId) }, init: null };

    try {
      // The conversation so far — the endpoint keeps no thread. Exact when it fits the model's
      // window; otherwise the budgeted transfer (its summary is cached, so later turns reuse it).
      // Prepared inside the run's lifecycle so a summariser failure ends the run cleanly.
      const record = await this.transferBlock(session, "custom", { model, from: -1, to: promptIndex - 1, promptChars: promptText.length, signal: abortController.signal, label: "The endpoint" });
      if (record.count && record.mode !== "exact") this.addMessage(session, { id: store.uid(), role: "system", text: record.note, ts: store.nowISO() });
      const systemText = record.text;
      this._lastRun.sent.transferredEntries = record.count; this._lastRun.sent.transferMode = record.mode;
      const r = await customApi.call({
        endpoint: cfg.endpoint, headers: cfg.headers,
        payloadTemplate: cfg.payloadTemplate, outputPath: cfg.outputPath,
        model, prompt: promptText, system: systemText, apiKey: cfg.apiKey, signal: abortController.signal,
      });
      if (r.ok && r.text) {
        this.addMessage(session, { id: store.uid(), role: "assistant", text: r.text, ts: store.nowISO(), meta: session._replyMeta });
        store.scheduleWrite(sessionId);
        this.finalizeRun(session, runner, { aborted: false });
      } else if (r.aborted || runner.interrupted || abortController.signal.aborted) {
        this.finalizeRun(session, runner, { aborted: true });
      } else if (r.status === 429 || r.status === 529) {
        session._pendingRetry = { text, attachments, reviewers, reviewMode, background, fleet, extraSystem, resumeContinuation: true, promptMessageId };
        runner.running = false; this.runners.delete(sessionId);
        this.scheduleRetry(sessionId, "ratelimited");
        return;
      } else {
        const detail = r.error || "no output";
        const hint = (r.candidates && r.candidates.length)
          ? "  Detected reply keys: " + r.candidates.slice(0, 5).map((c) => c.path).join(", ") + " — set one as the Output path in Settings → Providers → Custom."
          : "  Check the endpoint, headers, payload template and Output path in Settings → Providers → Custom.";
        this.addMessage(session, { id: store.uid(), role: "error", text: "Custom API run failed: " + detail + hint, ts: store.nowISO() });
        runner.failed = true;
        this.finalizeRun(session, runner, { aborted: false, failed: true });
      }
    } catch (e) {
      console.error("[custom:run]", e);
      if (isNetworkError(e)) {
        session._pendingRetry = { text, attachments, reviewers, reviewMode, background, fleet, extraSystem, resumeContinuation: true, promptMessageId };
        store.updateSession(sessionId, { status: "offline" }); this.send("session:status", { sessionId, status: "offline" });
      } else if (isRateLimitError(e)) {
        session._pendingRetry = { text, attachments, reviewers, reviewMode, background, fleet, extraSystem, resumeContinuation: true, promptMessageId };
        this.scheduleRetry(sessionId, "ratelimited");
      } else {
        this.addMessage(session, { id: store.uid(), role: "error", text: "Custom API run failed: " + String((e && e.message) || e), ts: store.nowISO() });
        runner.failed = true;
        this.finalizeRun(session, runner, { aborted: false, failed: true });
      }
    } finally {
      runner.running = false; runner.ended = true;
      clearTimeout(runner._graceTimer);
      if (this.runners.get(sessionId) === runner) { this.send("session:partial-reset", { sessionId }); this.runners.delete(sessionId); }
      if (this.draining.get(sessionId) === runner.done) this.draining.delete(sessionId);
      store.flush(sessionId);
      if (runner._resolveDone) runner._resolveDone();
    }

    if (Array.isArray(reviewers) && reviewers.length && reviewMode === "after" && runner.completedClean && !background && !(fleet && fleet.taskId)) {
      try { await this.reviewAfter(session, reviewers, text || "", promptMessageId); } catch (e) { console.error("[council:after]", e); }
    }
  }

  // ONE terminal-state transition per run: completed | failed | interrupted | stopped.
  // Only a GENUINE completion sets completedClean (what gates success-dependent work).
  finalizeRun(session, runner, { aborted, failed }) {
    const sessionId = session.id;
    if (runner.finalized) return;
    runner.finalized = true;
    // Once the provider ACCEPTED this turn's input, its native thread holds the prompt and
    // everything the turn produced (partial output, tool calls) — even when the turn was stopped
    // or failed afterwards. Acknowledge that on the cursor so the next prompt sends only what is
    // new; a turn rejected BEFORE acceptance (network, prompt too long) leaves the cursor alone.
    if (runner.accepted && runner.bindingProvider && !runner._external && !runner.retargeted) {
      try { history.setBinding(session, runner.bindingProvider, { syncedIndex: history.lastGlobalIndex(session) }); } catch { /* binding update is best effort */ }
    }
    if (runner.interrupted || aborted || failed) {
      // Tool messages of THIS run still marked "running" will never get a result.
      const stopTs = store.nowISO();
      for (const msg of session.messages) {
        if (msg && msg.role === "tool" && msg.status === "running" && (!msg.runId || msg.runId === runner.id)) {
          const patch = { status: failed && !runner.interrupted && !aborted ? "error" : "interrupted", result: msg.result || (failed ? "The run failed before this tool finished." : "Stopped before this tool finished."), endedTs: stopTs };
          Object.assign(msg, patch);
          this.send("session:message-update", { sessionId, messageId: msg.id, patch });
        }
      }
      // Cancel permission cards left in flight FOR THIS RUN ONLY.
      this.cancelPermissionsFor(sessionId, runner.id, "Stopped");
    }
    if (runner.interrupted) {
      const replacing = runner.interruptReason === "replace";
      this.addMessage(session, { id: store.uid(), role: "system", text: replacing ? "Interrupted — running your new message…" : "Stopped by you.", ts: store.nowISO() });
      store.updateSession(sessionId, { status: "idle" }); this.send("session:status", { sessionId, status: "idle" });
      return;
    }
    if (aborted) {
      this.addMessage(session, { id: store.uid(), role: "system", text: "Stopped.", ts: store.nowISO() });
      store.updateSession(sessionId, { status: "idle" }); this.send("session:status", { sessionId, status: "idle" });
      return;
    }
    const finalStatus = (failed || runner.failed) ? "error" : "done";
    runner.completedClean = finalStatus === "done";
    store.updateSession(sessionId, { status: finalStatus });
    this.send("session:status", { sessionId, status: finalStatus });
  }

  // Resolve/cancel every pending permission request that belongs to ONE run.
  cancelPermissionsFor(sessionId, runId, message) {
    for (const [requestId, rec] of Array.from(this.permResolvers.entries())) {
      if (!rec || rec.sessionId !== sessionId) continue;
      if (runId && rec.runId && rec.runId !== runId) continue;
      this.send("session:permission-cancel", { sessionId, requestId });
      // rec.resolve removes the entry itself (and ignores a second call).
      try { rec.resolve({ allow: false, message: message || "Cancelled" }); } catch { /* */ }
    }
  }

  handleMessage(session, m, runner) {
    const sessionId = session.id;
    const parent = m.parent_tool_use_id || null;   // non-null: produced inside a subagent
    // Anything the model produced for this turn (text, thinking, a tool call, a tool result):
    // a `result` arriving BEFORE any of it is not this turn's end (see the "result" case).
    if (runner && (m.type === "assistant" || m.type === "user" || m.type === "stream_event" || m.type === "tool_progress")) runner.sawOutput = true;
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          if (m.session_id) { history.setBinding(session, "anthropic", { id: m.session_id }); }
          if (m.model) this.registerModel(m.model);
          // The CLI accepted this turn's input: the native session now holds the current prompt
          // (and whatever record was transferred with it). Acknowledge that on the cursor NOW, so a
          // later stop/failure never re-transfers an accepted prompt (see finalizeRun).
          if (runner) { runner.accepted = true; if (Number.isFinite(runner.promptIndex)) { const b = history.bindingFor(session, "anthropic"); if (b.syncedIndex < runner.promptIndex) history.setBinding(session, "anthropic", { syncedIndex: runner.promptIndex }); } }
          if (this._lastRun && this._lastRun.sessionId === sessionId) this._lastRun.init = { model: m.model, permissionMode: m.permissionMode, mcpServers: (m.mcp_servers || []).map((s) => `${s.name}:${s.status}`), toolCount: (m.tools || []).length };
        } else if (m.subtype === "compact_boundary") {
          // Claude compacted its own context: record it (telemetry + a visible note) — the native
          // session continues; the app keeps its complete record.
          const cm = m.compact_metadata || {};
          const b = history.bindingFor(session, "anthropic");
          history.setBinding(session, "anthropic", { compactions: (b.compactions || 0) + 1, lastCompaction: { trigger: cm.trigger || "auto", preTokens: cm.pre_tokens || 0, postTokens: cm.post_tokens || null, ts: store.nowISO() }, ...(cm.post_tokens ? { activeTokens: cm.post_tokens } : {}) });
          if (this._lastRun && this._lastRun.sessionId === sessionId) this._lastRun.compactions = (this._lastRun.compactions || 0) + 1;
          this.addMessage(session, { id: store.uid(), role: "system", text: `Claude compacted its context (${cm.trigger === "manual" ? "requested" : "automatic"}${cm.pre_tokens ? `, ${Number(cm.pre_tokens).toLocaleString("en-US")} tokens before` : ""}${cm.post_tokens ? `, ${Number(cm.post_tokens).toLocaleString("en-US")} after` : ""}). The complete record stays in this chat.`, ts: store.nowISO() });
        }
        return;

      case "prompt_suggestion":
        if (m.suggestion) this.send("session:prompt-suggestion", { sessionId, suggestion: String(m.suggestion) });
        return;

      case "stream_event": {
        const ev = m.event;
        if (!ev) return;
        if (parent) {
          // Subagent output streams into ITS Task card, never the main reply.
          if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") this.send("session:partial", { sessionId, index: ev.index, kind: "text", delta: ev.delta.text, parent });
          return;
        }
        if (ev.type === "message_start") { this.send("session:partial-reset", { sessionId }); return; }
        // Earliest tool visibility: a tool_use block starting is already a card
        // ("preparing"), and its streamed JSON arguments fill the card in as they arrive.
        if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "tool_use") {
          const b = ev.content_block;
          const existing = session.messages.find((x) => x.role === "tool" && x.toolUseId === b.id);
          if (!existing) {
            const mid = store.uid();
            (runner && (runner.streamTools = runner.streamTools || new Map()) || new Map()).set(ev.index, { id: mid, toolUseId: b.id, json: "" });
            this.addMessage(session, { id: mid, role: "tool", toolName: b.name, toolUseId: b.id, runId: runner ? runner.id : undefined, toolInput: b.input && Object.keys(b.input).length ? b.input : {}, status: "preparing", ts: store.nowISO() });
          }
          return;
        }
        if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta") this.send("session:partial", { sessionId, index: ev.index, kind: "text", delta: ev.delta.text });
          else if (ev.delta.type === "thinking_delta") this.send("session:partial", { sessionId, index: ev.index, kind: "thinking", delta: ev.delta.thinking });
          else if (ev.delta.type === "input_json_delta" && runner && runner.streamTools) {
            const st = runner.streamTools.get(ev.index);
            if (st) {
              const frag = ev.delta.partial_json || "";
              st.json += frag;
              // The complete object is persisted the moment it closes (an incremental brace/string
              // scan — no re-parse of the whole body per fragment). Before that the arguments are shown
              // as they take shape, COALESCED: at most one renderer update per STREAM_ARGS_MS per card,
              // carrying the top-level fields that have fully arrived (file_path, command, pattern …)
              // and a bounded excerpt of the raw JSON. (Sending the whole growing body on every fragment
              // cost O(n²) bytes over IPC and a full re-layout per fragment for a large Write.)
              if (scanJsonState(st, frag)) {
                if (st.timer) { clearTimeout(st.timer); st.timer = null; }
                try { const parsed = JSON.parse(st.json); st.dirty = false; this.updateMessage(session, st.id, { toolInput: parsed, partialInput: undefined, partialBytes: undefined }); return; } catch { /* not valid yet — keep streaming */ }
              }
              st.dirty = true;
              if (!st.timer) st.timer = setTimeout(() => { st.timer = null; this.flushStreamArgs(session, runner, ev.index, st); }, STREAM_ARGS_MS);
            }
          }
        }
        return;
      }

      case "tool_progress": {
        // Elapsed-time heartbeat for a running tool (NOT stdout) — the card shows it is alive.
        const target = [...session.messages].reverse().find((x) => x.role === "tool" && x.toolUseId === m.tool_use_id);
        if (target) this.send("session:message-update", { sessionId, messageId: target.id, patch: { elapsedSeconds: m.elapsed_time_seconds, taskId: m.task_id || undefined, subagentType: m.subagent_type || undefined } });
        return;
      }
      case "task_started": case "task_progress": case "task_notification": {
        // Native background tasks (background Bash, local agents): lifecycle on the tool card that owns them.
        const tid = m.task_id;
        const target = tid ? [...session.messages].reverse().find((x) => x.role === "tool" && (x.taskId === tid || x.toolUseId === m.tool_use_id)) : null;
        const patch = { taskId: tid };
        if (m.type === "task_started") { patch.background = true; patch.progress = m.description || "started in the background"; }
        if (m.type === "task_progress") patch.progress = m.description || m.summary || "running…";
        if (m.type === "task_notification") { patch.status = m.status === "failed" ? "error" : "done"; patch.result = m.summary || m.description || (m.status === "failed" ? "Background task failed." : "Background task completed."); patch.endedTs = store.nowISO(); if (m.output_file) patch.outputFile = m.output_file; }
        if (target) this.updateMessage(session, target.id, patch);
        else if (m.type === "task_notification") this.addMessage(session, { id: store.uid(), role: "system", text: `Background task ${m.status === "failed" ? "failed" : "finished"}${m.summary ? ": " + m.summary : ""}`, ts: store.nowISO() });
        return;
      }

      case "assistant": {
        const blocks = (m.message && m.message.content) || [];
        for (const b of blocks) {
          if (b.type === "text" && b.text) {
            this.addMessage(session, { id: store.uid(), role: "assistant", text: b.text, ts: store.nowISO(), meta: session._replyMeta || null, ...(parent ? { parentToolUseId: parent } : {}) });
          } else if (b.type === "thinking" && b.thinking) {
            this.addMessage(session, { id: store.uid(), role: "thinking", text: b.thinking, ts: store.nowISO(), ...(parent ? { parentToolUseId: parent } : {}) });
          } else if (b.type === "tool_use") {
            let filePath = b.input && (b.input.file_path || b.input.notebook_path || b.input.file || b.input.path);
            if (filePath && session.cwd && !path.isAbsolute(filePath)) filePath = path.join(session.cwd, filePath);
            if (EDIT_TOOLS.has(b.name)) this.trackEdit(session, filePath, b.name, computeDiff(b.name, b.input));
            // Upsert: the card may already exist from content_block_start.
            const existing = session.messages.find((x) => x.role === "tool" && x.toolUseId === b.id);
            if (existing) this.updateMessage(session, existing.id, { toolName: b.name, toolInput: b.input, status: "running", partialInput: undefined });
            else this.addMessage(session, { id: store.uid(), role: "tool", toolName: b.name, toolUseId: b.id, runId: runner ? runner.id : undefined, toolInput: b.input, status: "running", ts: store.nowISO(), ...(parent ? { parentToolUseId: parent } : {}) });
          }
        }
        if (!parent) this.send("session:partial-reset", { sessionId });
        this.clearStreamTools(runner);
        return;
      }

      case "user": {
        const blocks = (m.message && m.message.content) || [];
        for (const b of blocks) {
          if (b && b.type === "tool_result") {
            const target = [...session.messages].reverse().find((x) => x.role === "tool" && x.toolUseId === b.tool_use_id);
            // A tool cancelled by Stop keeps its "interrupted" state; its (interrupted) result text is kept.
            const cancelled = runner && runner.interrupted && target && target.status === "interrupted";
            const patch = { status: cancelled ? "interrupted" : (b.is_error ? "error" : "done"), result: toolResultText(b.content), endedTs: store.nowISO() };
            if (target) this.updateMessage(session, target.id, patch);
          }
        }
        return;
      }

      case "result": {
        // A ZERO-TURN success result BEFORE any output of this turn is the CLI finalising something
        // else (on resume it closes a queued task notification that way: num_turns 0, ~50 ms) — not
        // this turn's end. Nothing is recorded for it and the input stream stays open, so permission
        // prompts keep working. A genuine result always has turns (or is an error).
        if (runner && !runner.sawOutput && !m.is_error && m.num_turns === 0) {
          runner.earlyResults = (runner.earlyResults || 0) + 1;
          console.warn(`[claude:run] early result ignored (no output yet; subtype=${m.subtype}, turns=${m.num_turns})`);
          return;
        }
        if (m.session_id) history.setBinding(session, "anthropic", { id: m.session_id });
        // Structured overload/rate-limit termination arrives as an ERROR RESULT with
        // api_error_status → the same preserve-turn + backoff retry as a thrown error.
        if (m.is_error && (m.api_error_status === 429 || m.api_error_status === 529)) {
          const err = new Error(`Claude API ${m.api_error_status} — overloaded/rate-limited, auto-retrying`);
          err.api_error_status = m.api_error_status;
          throw err;
        }
        // "Prompt is too long" arrives as an error RESULT: hand it to the run so it can start
        // a new native session with a summarised record instead of failing the turn.
        if (m.is_error && isPromptTooLong(String(m.result || "") + " " + (Array.isArray(m.errors) ? m.errors.map(String).join(" ") : ""))) {
          const err = new Error("Claude rejected the request as too large for the model's context window: " + String(m.result || (Array.isArray(m.errors) && m.errors[0]) || "prompt is too long"));
          err.promptTooLong = true;
          throw err;
        }
        if (runner) runner.resultSeen = true;
        session.totalCostUsd = (session.totalCostUsd || 0) + (m.total_cost_usd || 0);
        const turnUsage = sumModelUsage(m.modelUsage);
        if (turnUsage) {
          session.totalTokensIn = (session.totalTokensIn || 0) + turnUsage.inputTokens + turnUsage.cacheReadInputTokens + turnUsage.cacheCreationInputTokens;
          session.totalTokensOut = (session.totalTokensOut || 0) + turnUsage.outputTokens;
        } else if (m.usage) {
          session.totalTokensIn = (session.totalTokensIn || 0) + (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
          session.totalTokensOut = (session.totalTokensOut || 0) + (m.usage.output_tokens || 0);
        }
        const meta = {
          subtype: m.subtype, isError: !!m.is_error,
          costUsd: m.total_cost_usd || 0, totalCostUsd: session.totalCostUsd,
          durationMs: m.duration_ms || 0, numTurns: m.num_turns || 0,
          usage: m.usage || null, modelUsage: m.modelUsage || null, turnUsage: turnUsage || null,
          provider: "anthropic",
        };
        // Active native context ≈ the last request's full input (uncached + cache read + cache
        // creation). Remembered on the binding so a later partial transfer into THIS thread
        // budgets against what the thread already holds.
        if (m.usage && !m.is_error) {
          const active = (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
          if (active > 0) history.setBinding(session, "anthropic", { activeTokens: active, activeTokensTs: store.nowISO() });
        }
        // This turn is over: let the input stream end (the SDK then closes the CLI's stdin and the
        // process exits). A stopped turn's result adds no card — "Stopped by you." is already there.
        if (runner && runner.releaseInput) runner.releaseInput();
        if (runner && runner.interrupted) { store.scheduleWrite(sessionId); return; }
        // Classify BEFORE finalisation: anything that is not a clean success is a
        // failed run — error subtypes (max turns, budget, execution error) AND a
        // "success" frame flagged is_error. The run's terminal state follows this.
        const failed = !!m.is_error || (m.subtype && m.subtype !== "success");
        if (failed) {
          const detail = m.subtype && m.subtype !== "success" ? m.subtype.replace(/^error_/, "").replace(/_/g, " ") : "error";
          const errs = Array.isArray(m.errors) && m.errors.length ? " — " + m.errors.map((x) => String(x)).join("; ") : (m.result && typeof m.result === "string" && m.is_error ? " — " + m.result : "");
          this.addMessage(session, { id: store.uid(), role: "error", text: `Run ended: ${detail}${errs}`, ts: store.nowISO(), meta });
          if (runner) runner.failed = true;
        } else {
          this.addMessage(session, { id: store.uid(), role: "result", text: "", ts: store.nowISO(), meta });
        }
        store.scheduleWrite(sessionId);
        return;
      }
      default:
        return;
    }
  }

  // One coalesced update for a tool card whose arguments are still streaming (see input_json_delta).
  flushStreamArgs(session, runner, index, st) {
    if (!st || !st.dirty || !runner || !runner.streamTools || runner.streamTools.get(index) !== st) return;
    st.dirty = false;
    try { const parsed = JSON.parse(st.json); this.updateMessage(session, st.id, { toolInput: parsed, partialInput: undefined, partialBytes: undefined }); return; } catch { /* still streaming */ }
    const known = st.json.length <= STREAM_ARGS_SCAN_MAX ? partialToolInput(st.json) : {};
    this.send("session:message-update", { sessionId: session.id, messageId: st.id, patch: { partialInput: excerptArgs(st.json), partialBytes: st.json.length, ...(Object.keys(known).length ? { toolInput: known } : {}) } });
  }
  clearStreamTools(runner) {
    if (!runner || !runner.streamTools) return;
    for (const st of runner.streamTools.values()) { if (st.timer) { clearTimeout(st.timer); st.timer = null; } st.dirty = false; }
    runner.streamTools.clear();
  }

  // Record a concrete model id seen in use (deduped, newest first).
  registerModel(id) {
    if (!id || !/(^|[^a-z])(claude|opus|sonnet|haiku|fable|mythos)([^a-z]|$)/i.test(String(id))) return;
    const prev = store.getSettings().discoveredModels || [];
    if (prev.includes(id)) return;
    const merged = [id, ...prev];
    try { store.saveSettings({ discoveredModels: merged }); } catch { /* reported by store */ }
    this.send("models:update", { ids: merged });
  }

  // Ask the user to allow a tool call. The request is owned by (sessionId, runId):
  // only its own run's stop/finish may cancel it, and a late answer for another run
  // is ignored.
  requestPermission(sessionId, toolName, input, signal, runId) {
    const requestId = store.uid();
    this.send("session:permission", { sessionId, requestId, toolName, input });
    return new Promise((resolve) => {
      const rec = {
        sessionId, runId: runId || null,
        resolve: (decision) => {
          if (this.permResolvers.get(requestId) !== rec) return;   // already resolved / cancelled
          this.permResolvers.delete(requestId);
          if (decision && decision.allow) {
            // An answer to AskUserQuestion travels as `updatedInput.answers` (question text →
            // chosen label(s)) — the SDK's contract; a denial with the answers in its message
            // would reach the model as "permission denied".
            const extra = decision.updatedInput && typeof decision.updatedInput === "object" ? decision.updatedInput : (decision.answers && typeof decision.answers === "object" ? { answers: decision.answers } : null);
            resolve({ behavior: "allow", updatedInput: extra ? { ...(input && typeof input === "object" ? input : {}), ...extra } : input });
          } else resolve({ behavior: "deny", message: (decision && decision.message) || "Denied by user" });
        },
      };
      this.permResolvers.set(requestId, rec);
      if (signal) signal.addEventListener("abort", () => {
        if (this.permResolvers.get(requestId) !== rec) return;
        this.send("session:permission-cancel", { sessionId, requestId });
        rec.resolve({ allow: false, message: "Aborted" });
      }, { once: true });
    });
  }

  respondPermission(requestId, decision) {
    const rec = this.permResolvers.get(requestId);
    if (rec) rec.resolve(decision);
  }

  /*
   * Stop the current turn. reason "stop" = user pressed stop; "replace" = user
   * sent a new message that should run next.
   */
  async interrupt(sessionId, reason = "stop") {
    const r = this.runners.get(sessionId);
    const sess = store.getSession(sessionId);
    if (sess) sess._interruptRequested = true;
    if (!r) {
      const session = sess;
      if (session && (session._pendingRetry || session.pendingRun || session.status === "ratelimited" || session.status === "auth-expired" || session.status === "offline")) {
        this.cancelScheduledRetry(sessionId);
        delete session._pendingRetry; session._retryAttempt = 0;
        if (session.pendingRun) session.pendingRun = null;
        store.updateSession(sessionId, { status: "idle", pendingRun: null });
        this.send("session:status", { sessionId, status: "idle" });
        return true;
      }
      if (session && session.status === "running") {
        store.updateSession(sessionId, { status: "idle" });
        this.send("session:partial-reset", { sessionId });
        this.send("session:status", { sessionId, status: "idle" });
        return true;
      }
      return false;
    }
    r.interrupted = true;
    r.interruptReason = reason;
    this.send("session:partial-reset", { sessionId });
    // Graceful first: the harness ends the turn itself (the running tool is cancelled and the shell
    // processes it started are killed by the CLI); the input stream is then released so the process
    // exits once its final result is out. Only a turn that has not wound down by the grace period
    // has its transport torn down — and then the whole CLI process tree, so nothing keeps running.
    // (Aborting FIRST used to kill the CLI before the interrupt could reach it, leaving the command
    // it was running alive on Windows.)
    const graceful = !!(r.query && typeof r.query.interrupt === "function") && !r.abortController.signal.aborted;
    if (graceful) Promise.resolve(r.query.interrupt()).catch(() => {});
    if (r.releaseInput) r.releaseInput();
    const hardStop = () => { if (r.ended) return; try { r.abortController.abort(); } catch { /* ignore */ } this.killProcessTree(r); };
    if (graceful) r._graceTimer = setTimeout(hardStop, this.interruptGraceMs); else hardStop();
    if (r.done) this.draining.set(sessionId, r.done);
    if (!r._external) {
      r.running = false;
      if (this.runners.get(sessionId) === r) this.runners.delete(sessionId);
      if (sess) { try { this.finalizeRun(sess, r, { aborted: true }); } catch { /* status event below still fires */ } }
      this.send("session:status", { sessionId, status: "idle" });
    }
    return true;
  }

  interruptAll() { for (const id of this.runners.keys()) this.interrupt(id, "stop"); }

  /*
   * Steer the RUNNING turn with a new user message instead of stopping it — Codex
   * app-server `turn/steer`. Only a live Codex turn is steerable; anything else
   * returns { steered:false } and the renderer falls back to interrupt + run. The
   * exact text goes in; attachments are persisted and passed as native inputs.
   */
  async steer(sessionId, { text, attachments } = {}) {
    const r = this.runners.get(sessionId);
    const session = store.getSession(sessionId);
    if (!session || !r || !r.running || r._external || !r.codex || !r.query || typeof r.query.steer !== "function") return { steered: false, reason: "no steerable turn" };
    if (r.interrupted || session._interruptRequested) return { steered: false, reason: "turn is stopping" };
    let atts = Array.isArray(attachments) ? attachments : [];
    if (!String(text || "").trim() && !atts.length) return { steered: false, reason: "empty" };
    try { atts = attachmentsStore.persistAll(atts); } catch (e) { return { steered: false, reason: "attachment store failed: " + ((e && e.message) || e) }; }
    const files = atts.filter((a) => a.kind !== "image" && a.path).map((a) => ({ path: a.path, name: a.name }));
    const images = atts.filter((a) => a.kind === "image" && a.path).map((a) => ({ path: a.path }));
    let res;
    try { res = await r.query.steer(text || "", images, files); } catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
    if (!res || !res.ok) return { steered: false, reason: (res && res.error) || "steer failed" };
    this.addMessage(session, { id: store.uid(), role: "user", text, ts: store.nowISO(), attachments: attachmentsStore.light(atts), steered: true });
    return { steered: true };
  }

  // Register a non-LLM cancellable task (image gen, planner) as a runner so the
  // existing stop button + IPC path can interrupt it the same way.
  registerExternalRunner(sessionId, opts = {}) {
    if (this.isRunning(sessionId)) return null;
    const abortController = new AbortController();
    const runner = { id: newRunId(), running: true, abortController, query: null, promptText: opts.label || "", _external: true };
    this.runners.set(sessionId, runner);
    return {
      signal: abortController.signal,
      isAborted: () => !!runner.interrupted || abortController.signal.aborted,
      unregister: () => { runner.running = false; if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId); },
    };
  }

  // Called on app quit: leave a clear marker in any session that was mid-run.
  markInterruptedOnQuit() {
    for (const [id, r] of this.runners.entries()) {
      if (!r || !r.running) continue;
      try {
        const s = store.getSession(id);
        if (s) {
          s.messages.push({ id: store.uid(), role: "system", text: "The run was interrupted because AtomNano closed.", ts: store.nowISO() });
          store.enforceCap(s);
          s.status = "idle";
          store.flush(id);
        }
      } catch { /* best effort on quit */ }
    }
  }

  // Volatile run prefs change between when a turn first failed and when it
  // auto-retries — replay with LIVE settings, keeping the turn's text/attachments.
  applyLivePrefs(session, payload) {
    if (!payload || !session) return payload;
    const s = store.getSettings(session.cwd);
    const reviewers = (Array.isArray(s.reviewers) ? s.reviewers : [])
      .filter((r) => r && r.provider && !(r.provider === (s.llmProvider || "anthropic") && r.model && r.model === s.defaultModel));
    return {
      ...payload,
      model: s.defaultModel || payload.model,
      permissionMode: s.defaultPermissionMode || payload.permissionMode,
      thinking: s.defaultThinking || payload.thinking,
      oneM: !!s.oneM,
      subAgents: !!s.subAgents,
      subAgentsMax: Math.max(1, Math.min(8, +s.subAgentsMax || 3)),
      reviewers,
      reviewMode: s.reviewMode === "after" ? "after" : "before",
    };
  }

  retryPending(sessionId) {
    const session = store.getSession(sessionId);
    if (!session) return false;
    if (this.isRunning(sessionId)) return false;
    this.cancelScheduledRetry(sessionId);
    const wasAuth = !session._pendingRetry && session.pendingRun && session.pendingRun.payload;
    const wasRate = session.status === "ratelimited";
    const payload = session._pendingRetry || (session.pendingRun && session.pendingRun.payload);
    if (!payload) return false;
    delete session._pendingRetry;
    if (session.pendingRun) { session.pendingRun = null; store.updateSession(sessionId, { pendingRun: null }); }
    const note = wasAuth ? "Signed back in — resuming with full context…" : wasRate ? "Retrying — your message and context are preserved…" : "Connection restored — resuming...";
    this.addMessage(session, { id: store.uid(), role: "system", text: note, ts: store.nowISO() });
    this.run(sessionId, this.applyLivePrefs(session, payload)).catch((err) => console.error("[claude:retry]", err));
    return true;
  }

  scheduleRetry(sessionId, reason) {
    const RATE_BACKOFF = [15, 30, 60, 120, 120];   // seconds per attempt
    const session = store.getSession(sessionId);
    if (!session || !session._pendingRetry) return;
    this.cancelScheduledRetry(sessionId);
    const attempt = (session._retryAttempt || 0);
    if (attempt >= RATE_BACKOFF.length) {
      this.addMessage(session, { id: store.uid(), role: "error", text: "Still rate-limited after several attempts — your message is preserved. Click Retry to try again, or wait a bit longer.", ts: store.nowISO() });
      store.updateSession(sessionId, { status: "ratelimited" });
      this.send("session:status", { sessionId, status: "ratelimited", waiting: false });
      return;
    }
    const delay = RATE_BACKOFF[attempt];
    session._retryAttempt = attempt + 1;
    const resumeAt = Date.now() + delay * 1000;
    store.updateSession(sessionId, { status: "ratelimited" });
    this.send("session:status", { sessionId, status: "ratelimited", waiting: true, resumeAt, attempt: attempt + 1 });
    if (!this._retryTimers) this._retryTimers = new Map();
    const t = setTimeout(() => {
      this._retryTimers.delete(sessionId);
      const s = store.getSession(sessionId);
      if (!s || !s._pendingRetry || this.isRunning(sessionId)) return;
      const payload = this.applyLivePrefs(s, s._pendingRetry);
      delete s._pendingRetry;
      this.run(sessionId, payload).catch((err) => console.error("[claude:rate-retry]", err));
    }, delay * 1000);
    if (t.unref) t.unref();
    this._retryTimers.set(sessionId, t);
  }

  cancelScheduledRetry(sessionId) {
    if (this._retryTimers && this._retryTimers.has(sessionId)) {
      clearTimeout(this._retryTimers.get(sessionId));
      this._retryTimers.delete(sessionId);
    }
  }

  retryAllOffline() {
    let count = 0;
    for (const meta of store.listSessions()) {
      if (!meta || !meta.id) continue;
      const session = store.getSession(meta.id);
      if (session && session._pendingRetry && !this.isRunning(meta.id)) { this.retryPending(meta.id); count++; }
    }
    return count;
  }

  retryAllAuthExpired(provider) {
    let count = 0;
    for (const meta of store.listSessions()) {
      if (!meta || !meta.id) continue;
      const session = store.getSession(meta.id);
      if (!session || this.isRunning(meta.id)) continue;
      const pr = session.pendingRun;
      const paused = (session.status === "auth-expired") || (pr && pr.reason === "auth");
      if (!paused) continue;
      if (provider && pr && pr.provider && pr.provider !== provider) continue;
      if (this.retryPending(meta.id)) count++;
    }
    return count;
  }

  // The live Query object for a running turn, or null.
  _liveQuery(id) { const r = this.runners.get(id); return r && r.running && r.query ? r.query : null; }
  /* Live context meter. Claude: the SDK's control response with `detail: "summary"` (answered
   * from the last response's usage — polling never triggers per-category token-count calls).
   * Codex: the app-server's own token usage for the running turn (input + cached ≈ active
   * context, its reported context window as the limit), marked as an estimate. */
  async contextUsage(id) {
    const r = this.runners.get(id);
    const q = this._liveQuery(id);
    if (q && q.getContextUsage) { try { return await q.getContextUsage({ detail: "summary" }); } catch { return null; } }
    if (r && r.running && r.codex && r.usage) {
      const u = r.usage.last || r.usage;
      const total = (u.input_tokens || 0) + (u.cached_input_tokens || 0) + (u.cache_write_input_tokens || 0);
      const max = r.usage.context_window || null;
      if (!total) return null;
      return { totalTokens: total, maxTokens: max, percentage: max ? Math.min(100, Math.round((total / max) * 100)) : null, provider: "openai", estimate: true };
    }
    return null;
  }
  async mcpStatus(id) { const q = this._liveQuery(id); if (!q || !q.mcpServerStatus) return null; try { return await q.mcpServerStatus(); } catch { return null; } }
  async rewindFiles(id, userMessageId) {
    const q = this._liveQuery(id);
    if (!q || !q.rewindFiles) return { ok: false, detail: "Rewind needs a running turn — file checkpoints live in the active session." };
    try { const r = await q.rewindFiles(userMessageId); return { ok: true, result: r || null }; }
    catch (e) { return { ok: false, detail: String((e && e.message) || e) }; }
  }
  async setModelLive(id, model) { const q = this._liveQuery(id); if (!q || !q.setModel) return false; try { await q.setModel(model || undefined); return true; } catch { return false; } }
  async setPermissionModeLive(id, mode) {
    const sess = store.getSession(id); if (sess && mode) { sess.permissionMode = mode; store.scheduleWrite(id); }
    const q = this._liveQuery(id); if (!q || !q.setPermissionMode) return !!(sess && this.runners.get(id) && this.runners.get(id).codex);
    try { await q.setPermissionMode(mode); return true; } catch { return false; }
  }
  listAuthExpired() {
    const out = [];
    for (const meta of store.listSessions()) {
      if (!meta || !meta.id) continue;
      const session = store.getSession(meta.id);
      const pr = session && session.pendingRun;
      if (session && (session.status === "auth-expired" || (pr && pr.reason === "auth"))) out.push({ id: meta.id, provider: (pr && pr.provider) || "anthropic" });
    }
    return out;
  }
  // Per-run diagnostics (what was dispatched / acknowledged), secrets excluded.
  lastRunInfo() { return this._lastRun || null; }

  // Resolve a model alias (opus/sonnet/haiku) to its concrete id by reading the
  // system/init message, then abort before any generation (no token cost).
  async resolveModel(alias) {
    const abort = new AbortController();
    const timer = setTimeout(() => { try { abort.abort(); } catch { /* ignore */ } }, 45000);
    let resolved = "";
    try {
      const settings = store.getSettings();
      const { query } = await loadSDK();
      let cwd; try { if (settings.lastFolder && require("fs").existsSync(settings.lastFolder)) cwd = settings.lastFolder; } catch { /* home */ }
      const options = {
        cwd, model: alias,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user"],
        abortController: abort,
        canUseTool: () => Promise.resolve({ behavior: "deny", message: "model discovery" }),
        env: this.buildEnv(settings),
        strictMcpConfig: true,   // discovery probe only — it aborts before any generation; no user run is affected
      };
      const cli = await this.resolveCli(settings);
      if (cli) options.pathToClaudeCodeExecutable = cli; else options.executable = "node";
      const q = query({ prompt: "ok", options });
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init" && m.model) { resolved = m.model; break; }
      }
    } catch { /* offline / no login */ }
    finally { clearTimeout(timer); try { abort.abort(); } catch { /* ignore */ } }
    return resolved;
  }

  async discoverModels({ force } = {}) {
    if (this._discovering) return this._discovering;
    this._discovering = (async () => {
      const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
      const ALIASES = ["fable", "opus", "sonnet", "haiku"];
      const isClaude = (id) => /(^|[^a-z])(claude|opus|sonnet|haiku|fable|mythos)([^a-z]|$)/i.test(String(id || ""));
      const concrete = (id) => isClaude(id) && /\d/.test(id) && !ALIASES.includes(String(id).toLowerCase());
      const settings = store.getSettings();
      const prev = (settings.discoveredModels || []).filter(isClaude);
      const cliPath = await this.resolveCli(settings);
      const cliVer = await auth.cliVersion(cliPath).catch(() => "");
      const meta = settings.discoveredMeta || null;
      const cacheOk = !force && prev.length && meta && meta.cliVersion && meta.cliVersion === cliVer && (Date.now() - (meta.at || 0)) < DISCOVERY_TTL_MS;
      if (cacheOk) return prev;
      const ids = await Promise.all(ALIASES.map((a) => this.resolveModel(a).catch(() => "")));
      const found = [];
      for (const id of ids) if (id && concrete(id) && !found.includes(id)) found.push(id);
      const merged = [...found, ...prev.filter((id) => !found.includes(id))];
      const changed = merged.length !== prev.length || merged.some((id, i) => id !== prev[i]);
      const patch = { discoveredModels: merged };
      if (ids.every((id) => id && concrete(id))) patch.discoveredMeta = { cliVersion: cliVer, at: Date.now() };
      try { store.saveSettings(patch); } catch { /* reported by store */ }
      if (changed) this.send("models:update", { ids: merged });
      return merged;
    })();
    try { return await this._discovering; }
    finally { this._discovering = null; }
  }

  /* ROLE PIPELINE — Planner (explicit user configuration). Drafts an implementation
   * plan with its own provider/model/effort, streamed to the tab as its own card,
   * from the EXACT conversation record. Never touches the session's thread bindings. */
  async runPlanner(sessionId, session, { userText, planner, settings, promptMessageId }) {
    const providers = require("./providers");
    const provider = planner.provider || (settings.llmProvider || "anthropic");
    const pcat = providers.get(provider);
    let model = (planner.model || "").trim() || pcat.defaultModel || "";
    let effort = (planner.effort || "").trim() || pcat.defaultReasoning || "high";
    if (provider === "openai") {
      const rs = providers.resolveOpenAIModelStrict(model); if (rs.error) throw new Error(rs.error); model = rs.model;
      const re = providers.openaiEffortStrict(effort, model); if (re.error) throw new Error(re.error); effort = re.effort;
    }
    const sys = "You are the PLANNER in a two-role pipeline (Planner → Coder). Read the request and the conversation so far, then write a concise, actionable implementation plan the Coder will follow: numbered steps, the files/areas to touch, key decisions, and edge cases to handle. Do NOT write the implementation yourself — plan only.";
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    const record = await this.transferBlock(session, provider, { model, from: -1, to: promptIndex - 1, promptChars: sys.length + (userText || "").length + 200, label: "The Planner" });
    if (record.count && record.mode !== "exact") this.addMessage(session, { id: store.uid(), role: "system", text: record.note, ts: store.nowISO() });
    const prompt = (record.text ? record.text + "\n\n----\n\n" : "") + "User request:\n" + (userText || "") + "\n\nWrite the implementation plan now.";

    const meta = this.replyMeta(provider, model, effort, null, null);
    meta.role = "planner";
    this.addMessage(session, { id: store.uid(), role: "system", text: `Planning with ${pcat.label} · ${model || "default"}…`, ts: store.nowISO() });
    this.send("session:partial-reset", { sessionId });
    const ext = this.registerExternalRunner(sessionId, { label: "[planner]" });
    const signal = ext ? ext.signal : undefined;
    let plan = "";
    const onDelta = (d) => { if (!d) return; plan += d; this.send("session:partial", { sessionId, index: 0, kind: "text", delta: d }); };
    try {
      if (provider === "openai") {
        const codex = require("./codex");
        const res = await codex.run({ apiKey: settings.openaiApiKey || undefined, model, effort, cwd: session.cwd, readOnly: true, signal, promptText: sys + "\n\n" + prompt, on: { onTextDelta: onDelta } });
        if (res && res.text) plan = res.text;
        if (!plan && res && res.error && !res.aborted) throw new Error(res.error);
      } else if (provider === "anthropic") {
        plan = await this.runHeadlessAnthropic({ settings, model, thinking: effort, system: sys, prompt, cwd: session.cwd, stream: true, onText: onDelta, signal });
      } else {
        const council = require("./council");
        const r = await council.reviewerRun(provider, model, sys + "\n\n" + prompt, { effort });
        if (r && r.ok && r.text) { plan = r.text; this.send("session:partial", { sessionId, index: 0, kind: "text", delta: plan }); }
        else if (r && !r.ok && !(ext && ext.isAborted())) throw new Error(r.error || "planner failed");
      }
    } catch (e) {
      if (!(ext && ext.isAborted())) throw e;
    } finally {
      this.send("session:partial-reset", { sessionId });
      if (ext) ext.unregister();
    }
    const aborted = ext ? ext.isAborted() : false;
    plan = (plan || "").trim();
    if (plan) this.addMessage(session, { id: store.uid(), role: "planner", text: plan, ts: store.nowISO(), meta });
    return { plan, aborted };
  }

  // Headless single Anthropic (or custom-base-URL) turn for the CLI / planner. No
  // sessions, no IPC, no permission UI. `system` here is the caller's EXPLICIT
  // instruction (a CLI flag or the Planner role), never an app-added layer.
  async runHeadlessAnthropic({ settings, model, thinking, oneM, system, prompt, cwd, allowTools, stream, onText, onResult, signal } = {}) {
    // An already-cancelled parent never starts a new model call.
    if (signal && signal.aborted) { const e = new Error("Cancelled before the request started"); e.name = "AbortError"; throw e; }
    const { query } = await loadSDK();
    const abortController = new AbortController();
    const onAbort = () => { try { abortController.abort(); } catch { /* */ } };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const options = {
      cwd: cwd || process.cwd(),
      model: model || settings.defaultModel || "claude-opus-4-8",
      permissionMode: allowTools ? (settings.defaultPermissionMode || "acceptEdits") : "default",
      includePartialMessages: !!stream,
      systemPrompt: system ? { type: "preset", preset: "claude_code", append: system } : { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      abortController,
      stderr: () => {},
      canUseTool: allowTools
        ? ((_t, input) => ({ behavior: "allow", updatedInput: input }))
        : (() => ({ behavior: "deny", message: "Tools are disabled in CLI text mode — pass --agent to enable." })),
      env: this.buildEnv(settings),
    };
    const effErr = applyThinking(options, options.model, thinking || "low");
    if (effErr) throw new Error(effErr);
    if (oneM) options.betas = ["context-1m-2025-08-07"];
    const cli = await this.resolveCli(settings);
    if (cli) options.pathToClaudeCodeExecutable = cli; else options.executable = "node";
    let full = "";
    try {
      const q = query({ prompt: String(prompt || ""), options });
      for await (const m of q) {
        if (signal && signal.aborted) break;
        if (m.type === "stream_event") {
          const ev = m.event;
          if (ev && ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text) { full += ev.delta.text; if (onText) onText(ev.delta.text); }
        } else if (m.type === "assistant" && !stream) {
          for (const b of (m.message && m.message.content) || []) if (b && b.type === "text" && b.text) full += b.text;
        } else if (m.type === "result") {
          if (m.is_error) { const err = new Error(String(m.result || (Array.isArray(m.errors) && m.errors[0]) || "headless run failed")); if (isPromptTooLong(err)) err.promptTooLong = true; throw err; }
          if (onResult) onResult({ usage: m.usage || null, modelUsage: m.modelUsage || null, costUsd: m.total_cost_usd || 0, durationMs: m.duration_ms || 0 });
        }
      }
    } finally { if (signal) signal.removeEventListener("abort", onAbort); }
    return full;
  }
}

module.exports = new SessionManager();
module.exports.__internals = { effortFor, applyThinking, normEffort, supportsXhigh, supportsAdaptiveThinking, isRateLimitError, isNetworkError, isAuthError, isPromptTooLong, isSessionGone, sumModelUsage, computeDiff, toolResultText, SessionManager, SUMMARY_INSTRUCTIONS };
