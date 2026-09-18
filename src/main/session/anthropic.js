"use strict";
/* Anthropic primary — the Claude Agent SDK runner.
 *
 * One query() per turn, continuity via the CLI's native session (resume). The prompt stream is
 * held OPEN by an input feed until the run says the turn is over (a closed stdin breaks every
 * later permission / hook round-trip — see buildPrompt), and the CLI is spawned by the app so a
 * hard stop can end the whole process tree. Also the headless single-turn runner (CLI / Planner)
 * and model-alias discovery. Message handling lives in anthropic-events.js. */
const path = require("path");
const { spawn } = require("child_process");
const store = require("../storage/store");
const history = require("../storage/history");
const auth = require("../auth/cli-auth");
const attachmentsStore = require("../storage/attachments");
const agentsMod = require("../agents/subagents");
const { loadSDK, isUltracode, supportsXhigh, effortFor, applyThinking } = require("./sdk");
const { PROVIDER_LABEL, isNetworkError, isAuthError, isRateLimitError, isPromptTooLong, isSessionGone } = require("./errors");
const { EDIT_TOOLS, SUBAGENT_TOOLS } = require("./tools");

/* The run's INPUT FEED: the prompt generator yields the first message, then whatever is pushed here
 * (a message sent while background agents work joins the live process as its next turn), until the
 * run closes the feed — which is when the SDK may end the CLI's stdin. */
function inputFeed() {
  const queue = []; let wake = null, closed = false;
  const kick = () => { if (wake) { const w = wake; wake = null; w(); } };
  return {
    push(msg) { if (closed) return false; queue.push(msg); kick(); return true; },
    close() { closed = true; kick(); },
    get closed() { return closed; },
    async next() { for (;;) { if (queue.length) return queue.shift(); if (closed) return null; await new Promise((r) => { wake = r; }); } },
  };
}

const methods = {
  /* Spawn the CLI ourselves with the SDK's own options (pipes, windowsHide, forwarded abort
   * signal) so the run knows the process id: a hard stop can then end the WHOLE process tree —
   * the CLI and every shell command it started — which plain child.kill() cannot do on Windows. */
  spawnCli(cfg, runner, onStderr) {
    const child = spawn(cfg.command, cfg.args, { cwd: cfg.cwd, env: cfg.env, stdio: ["pipe", "pipe", "pipe"], signal: cfg.signal, windowsHide: true });
    if (runner) { runner.pid = child.pid; runner.exited = false; }
    // The run learns when its CLI is gone: a stop's process-tree fallback then has nothing to kill.
    if (runner && typeof child.on === "function") { child.on("exit", () => { runner.exited = true; }); child.on("error", () => {}); }
    if (this.applySpawnPriority) this.applySpawnPriority(child.pid);   // the CPU governor may be yielding to other work right now
    let tail = "";
    if (child.stderr) {
      child.stderr.on("data", (d) => { const s = String(d); tail = (tail + s).slice(-4000); if (runner) runner.stderrTail = tail; if (onStderr) { try { onStderr(s); } catch { /* */ } } });
      child.stderr.on("error", () => {});
    }
    if (child.stdin) child.stdin.on("error", () => {});
    return child;
  },

  killProcessTree(runner) {
    const pid = runner && runner.pid;
    if (!pid || (runner && runner.exited)) return;
    try {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
      else { try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); } }
    } catch { /* already gone */ }
  },

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
  },

  resetCliCache() { this.cachedCliPath = null; },

  /*
   * Spawn environment for the Claude CLI. By default the CLI's OAuth login is used
   * and an inherited ANTHROPIC_API_KEY is stripped (a stale key would silently
   * override the login). An explicit key in settings, or opting into the env key,
   * takes precedence. Nothing else in the user's environment is changed.
   */
  buildEnv(settings, provider) {
    const env = { ...process.env };
    if (settings.apiKey) {
      env.ANTHROPIC_API_KEY = settings.apiKey;
    } else if (!settings.useEnvApiKey) {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    // Custom provider = an Anthropic-compatible endpoint (its own base URL + key). `provider` is the
    // run's provider (a workflow job may run on another provider than the settings say).
    if ((provider || settings.llmProvider) === "custom" && settings.customApiBaseUrl) env.ANTHROPIC_BASE_URL = settings.customApiBaseUrl;
    return env;
  },

  // The mcpServers option: the user's configured servers (mcpConfig).
  composeMcp(settings) {
    const { composeMcpServers } = require("../providers/default-mcp");
    let userMap = {};
    try {
      const raw = require("../providers/mcp-config").list();
      for (const s of raw.servers || []) userMap[s.name] = s;
    } catch { /* mcp config absent — fine */ }
    return composeMcpServers(userMap, { enableDefaultMcp: settings.enableDefaultMcp !== false });
  },

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
  },

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
    // `opts` is the SDK's canUseTool options object: the prompt sentence (title), suggested
    // "always allow" rules, the blocking rule's reason and the asking sub-agent — all shown on the card.
    const ask = (toolName, input, opts) => this.requestPermission(sessionId, toolName, input, abortController.signal, runId, opts);
    const base = canUseToolOverride || ((toolName, input, opts) => {
      const mode = liveMode();
      const question = toolName === "ExitPlanMode" || toolName === "AskUserQuestion";
      if (!question && mode === "bypassPermissions") return { behavior: "allow", updatedInput: input };
      if (!question && mode === "acceptEdits" && EDIT_TOOLS.has(String(toolName || ""))) return { behavior: "allow", updatedInput: input };
      return ask(toolName, input, opts);
    });
    if (subOn) {
      // Sub-agents on: a Task call first reserves a CPU slot from the governor (bounded wait);
      // a denied slot is a permission decision the model can act on, not a prompt instruction.
      return async (toolName, input, opts, ...rest) => {
        if (SUBAGENT_TOOLS.test(String(toolName || ""))) {
          const g = await this.acquireAgentSlot(sessionId, opts && opts.toolUseID, input, abortController.signal);
          if (!g.ok) return { behavior: "deny", message: g.message };
        }
        return base(toolName, input, opts, ...rest);
      };
    }
    return async (toolName, input, ...rest) => {
      if (SUBAGENT_TOOLS.test(String(toolName || ""))) {
        this.send("subagent:blocked", { sessionId, toolName });
        return { behavior: "deny", message: "Sub-agents are disabled for this session (the Agents button in the composer turns them on)." };
      }
      return base(toolName, input, ...rest);
    };
  },

  /*
   * Build the SDK prompt. Streaming-input mode (an async generator of one user
   * message) is what enables query.interrupt() to gracefully stop a turn while
   * keeping the CLI session resumable. Files are referenced by path (Claude reads
   * them with its tools); every image ships as a base64 block read from its
   * durable file — an explicitly attached image is ALWAYS sent.
   */
  promptMessage(text, attachments, session) {
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
    return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: session.claudeSessionId || "" };
  },

  buildPrompt(text, attachments, session, feed) {
    const msg = this.promptMessage(text, attachments, session);
    // The input stream stays OPEN until the run closes its feed. The SDK closes the CLI's stdin as
    // soon as this generator ends AND a first `result` has arrived — and the CLI can emit a result
    // before this turn's own (on resume it finalises a queued task notification as a zero-turn
    // result, for instance). With stdin closed every later permission prompt / hook fails and
    // interrupt() has no channel. So the generator ends only when the run says so; meanwhile a
    // message the user sends while background agents work is yielded as the process's next turn.
    return (async function* () { yield msg; if (!feed) return; for (;;) { const next = await feed.next(); if (!next) return; yield next; } })();
  },

  /* ----------------------------- Anthropic primary ----------------------------- */
  async runAnthropic(sessionId, session, { text, attachments, reviewers, reviewMode, background, fleet, extraSystem, roleBrief, subAgents, subAgentsMax, canUseToolOverride, promptMessageId, workflowJob, reservation }, reviewerBeforeDigest, settings, provider, dispatched) {
    // The run takes over the slot run() reserved (the same object, so a Stop during setup is seen);
    // null = stopped or replaced meanwhile — the stop already recorded the outcome, nothing starts.
    // `model` / `oneM` are this run's DISPATCH SCOPE: a measurement it reports later (context usage,
    // the provider's window figure) is recorded only while that scope is still the session's.
    const runner = this.claimRun(sessionId, reservation, { promptText: text || "", provider, model: session.model, oneM: !!session.oneM, effort: session.thinking, sawOutput: false, hooksActive: true, startedTools: new Set(), activeTasks: new Map(), promptMessageId: promptMessageId || null, attempt: null });
    if (!runner) return;
    const abortController = runner.abortController;
    const runId = runner.id;
    // Capability check BEFORE anything is spawned: an effort the model doesn't
    // offer is an explicit error, not a silent substitution.
    const effChk = effortFor(session.model, session.thinking);
    if (effChk.error) { this.releaseRun(sessionId, runner); return this.failRun(session, effChk.error); }

    session._replyMeta = this.replyMeta(provider, session.model, session.thinking, reviewers, reviewMode);
    const { query } = await loadSDK();
    if (this.setupStopped(runner)) { this.releaseRun(sessionId, runner); return; }

    const subOn = !!subAgents;
    const subMax = agentsMod.clampMax(subAgentsMax);   // 1–20: the CLI's own concurrency cap; the governor works below it
    runner.subAgentsMax = subOn ? subMax : 0;           // the cap THIS run was dispatched with — the governor's policy reads it (governorSettings)
    // Sub-agents ON (the composer's Agents switch, or the planner's own cap): the model is told to use the
    // lane — as many as the task allows, in parallel (user decision 2026-09-17). A workflow ROLE job
    // carries the same instruction inside its role brief, so it is not repeated there.
    const agentsBrief = subOn && !workflowJob ? this.agentsBrief(subMax) : "";
    // Claude keeps the role / agents briefs in the system prompt on every turn (not part of the delivery cache).
    const sysAppend = [roleBrief ? String(roleBrief) : "", agentsBrief].filter(Boolean).join("\n\n");
    // The role skills of a persistent role session, frozen for THIS turn (index.js skillSnapshot): the names are
    // chat metadata; what each attempt sends is decided per native session below.
    const snap = this.skillSnapshot(session);
    const skillNames = snap.names;
    // The skills part of ONE attempt's appendix (2026-09-18): a RESUMED native session gets the procedures only when
    // new or changed — otherwise one pointer line (a clearing line once when the skills went away); a FRESH native
    // session (initial, rollover, lost session, overflow replacement) gets them in full. Composed once per kind for
    // this turn (invoke marks a skill used, so it runs once for what is sent); the fresh session commits the
    // attempt's hash when it ACCEPTS the input (anthropic-events.js init). Reviewer advice / the plan are turn data.
    const composed = {};
    const composeFor = (resume) => {
      const key = resume ? "resume" : "fresh";
      if (!composed[key]) composed[key] = this.composeAttempt(session, { snap, prev: resume ? history.bindingFor(session, "anthropic") : null, extraSystem, reviewerDigest: reviewerBeforeDigest });
      return composed[key];
    };
    const imageChars = (attachments || []).filter((a) => a && a.kind === "image").length * 6400;
    const promptCharsOf = (at) => (text || "").length + at.appendix.length + imageChars;

    // Conversation transfer: what has this provider's thread NOT seen? Everything
    // before the current prompt that arrived while another provider (or a lost
    // thread) was generating is carried verbatim as conversation data.
    const binding = history.bindingFor(session, "anthropic");
    // CLI transcripts live locally and remain resumable when credentials change. Capacity
    // learned under a different account/endpoint does not. Store only an identity hash.
    const key = settings.apiKey || (settings.useEnvApiKey && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) || "";
    const login = key ? "key:" + require("crypto").createHash("sha256").update(key).digest("hex").slice(0, 20)
      : auth.profiles && typeof auth.profiles.accountKey === "function" ? auth.profiles.accountKey("anthropic") : "";
    const capacityAccount = login ? require("crypto").createHash("sha256").update([provider, settings.customApiBaseUrl || "", login].join("|")).digest("hex").slice(0, 24) : "";
    if (capacityAccount && binding.capacityAccount && binding.capacityAccount !== capacityAccount) {
      history.setBinding(session, "anthropic", { reportedWindow: null, learnedWindow: null });
    }
    if (capacityAccount) history.setBinding(session, "anthropic", { capacityAccount });
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    runner.promptIndex = promptIndex; runner.bindingProvider = "anthropic";
    const sync = history.pendingSync(session, "anthropic", promptIndex);
    // The attempt dispatched first resumes the bound native session (when there is one); its prompt is what
    // the pre-flight measures and what a partial transfer into that session is budgeted against.
    const promptChars = promptCharsOf(composeFor(!!binding.id));
    // The prompt alone must fit the model's window — otherwise it is preserved in the chat and
    // the run stops here with a clear message, not a provider rejection nobody can act on.
    const ctxTokens = this.contextTokensFor(provider, session.model, session);
    if (promptChars > ctxTokens * history.CHARS_PER_TOKEN * 0.9) {
      this.releaseRun(sessionId, runner);
      return this.failRun(session, `Your message alone is about ${Math.round(promptChars / history.CHARS_PER_TOKEN).toLocaleString("en-US")} tokens — larger than the model's context window (${ctxTokens.toLocaleString("en-US")} tokens). It was not sent. Split it, or attach the large part as a file the model can read in pieces.`);
    }
    let recordBlock = { text: "", count: 0, mode: "none", note: "" };   // prepared inside the run's try/finally
    const composePrompt = (block, extra, at) => (block && block.text ? block.text + "\n\n---\n\n" : "") + (text || "") + at.appendix + (extra || "");
    // Record preparation (a transfer that may summarise) reports its progress as the tab's live
    // label — an honest "preparing…" instead of a bare spinner — and clears it when done.
    const preparing = (label) => { if (!runner.interrupted && !abortController.signal.aborted) this.setLive(session, runner, { status: "preparing", label: label || "Preparing the conversation record" }); };
    const prepared = () => { if (runner.live && runner.live.status === "preparing") this.setLive(session, runner, { status: null, label: null }); };
    const stoppedNow = () => { if (runner.interrupted || abortController.signal.aborted) { const e = new Error("Stopped while the record was being prepared"); e.name = "AbortError"; throw e; } };

    const mcpServers = this.composeMcp(settings);
    const options = {
      cwd: session.cwd,
      model: session.model,
      permissionMode: session.permissionMode,
      includePartialMessages: true,
      // The provider's native system behaviour; no app-added instructions. The ONLY additions are the
      // Workflow role brief (an explicit, user-designed workflow shown in the studio — the planner's
      // roles table + CLI usage, or a child job's role) and the sub-agents brief (the Agents switch the
      // user turned on, shown in its popover) — and only when such a run carries them.
      systemPrompt: sysAppend ? { type: "preset", preset: "claude_code", append: sysAppend } : { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      abortController,
      stderr: (d) => { if (d) console.error("[claude:stderr]", String(d).slice(0, 800)); },
      // Our own spawner (same options as the SDK's): the run learns the CLI's pid, so a hard stop
      // can end the whole process tree — no shell command is left running after Stop.
      spawnClaudeCodeProcess: (cfg) => this.spawnCli(cfg, runner, (d) => { if (d) console.error("[claude:stderr]", String(d).slice(0, 800)); }),
      canUseTool: this.composeCanUseTool(sessionId, runId, canUseToolOverride, abortController, subOn, session.permissionMode),
      // Tool lifecycle: PreToolUse fires the moment the CLI actually STARTS a tool. Tools announced
      // in one reply run one after another when a command is among them, so a card stays "queued"
      // (waiting) until its hook fires — never a spinner for a tool that has not begun. Inside a
      // sub-agent (input.agent_id) it counts that agent's tool use. SubagentStart / SubagentStop
      // give the registry the agent id and its last message. Every hook decides nothing ({}), so
      // none can block or alter a call.
      hooks: {
        PreToolUse: [{ hooks: [async (input) => { try { if (input && input.agent_id) this.agentToolUse(session, runner, input); else this.markToolStarted(session, runner, input && input.tool_use_id); } catch { /* never block a tool */ } return {}; }] }],
        SubagentStart: [{ hooks: [async (input) => { try { this.agentHookStart(session, runner, input); } catch { /* */ } return {}; }] }],
        SubagentStop: [{ hooks: [async (input) => { try { this.agentHookStop(session, runner, input); } catch { /* */ } return {}; }] }],
      },
      env: this.buildEnv(settings, provider),
      // The user's configured servers (mcpConfig) PLUS whatever their native Claude
      // settings sources declare — nothing is silently excluded.
      mcpServers,
    };
    // The `atomnano` CLI (run from the Bash tool) addresses THIS session with it — the workflow planner
    // delegates jobs that way; every child process of the CLI inherits it.
    options.env.ATOMNANO_SESSION = sessionId;
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
    // No `skills` option: Claude's own native skills work exactly as the CLI defaults them (the sdkSkills
    // setting was removed 2026-09-18; AtomNano's per-project skills reach the workflow roles as prompt data).
    if (subOn) {
      if (settings.agentProgressSummaries !== false) options.agentProgressSummaries = true;
      if (settings.forwardSubagentText !== false) options.forwardSubagentText = true;
      // A worker definition is a structured control the user opted into; how many to fan out is
      // the model's call within the cap below (the CLI's own limit — it tells the model when the
      // limit is reached) and the CPU governor's live slots (acquireAgentSlot).
      options.agents = { worker: { description: "General-purpose worker for delegated, independent subtasks (focused edits, research, analysis) — launch several in parallel for the independent parts of the work.", prompt: "You are a focused worker subagent. Complete exactly the subtask you were given and return a concise final result." } };
      options.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(subMax);
      this.ensureGovernor().touch(120000);
    }
    const effErr = applyThinking(options, session.model, session.thinking);
    if (effErr) { this.releaseRun(sessionId, runner); return this.failRun(session, effErr); }
    if (session.oneM) options.betas = ["context-1m-2025-08-07"];
    // The run's DISPATCH SCOPE is frozen from the options as they are sent — not from the session as
    // it was before the SDK load (the user may have switched the model or the 1M choice meanwhile):
    // the measurement guards (measurementCurrent, noteReportedWindow) compare against what actually went out.
    runner.model = options.model; runner.oneM = !!(options.betas && options.betas.includes("context-1m-2025-08-07"));
    // A context window LEARNED from an earlier "prompt is too long" (the model accepted less than
    // the catalog says — e.g. the 1M beta not honoured): tell the CLI, so its own auto-compaction
    // triggers before the real limit instead of after a rejected request.
    const win = this.effectiveWindow(session, "anthropic", session.model);
    if (win.learned && win.tokens < win.believed) options.settings = { ...(options.settings || {}), autoCompactWindow: win.tokens };
    const cli = await this.resolveCli(settings);
    if (this.setupStopped(runner)) { this.releaseRun(sessionId, runner); return; }   // Stop while the CLI path was resolved: nothing is dispatched
    if (cli) options.pathToClaudeCodeExecutable = cli; else options.executable = "node";
    if (binding.id) options.resume = binding.id;
    // A NEW native session takes the tab's name as its title (the CLI would otherwise generate
    // one from the first prompt) — the same conversation is recognisable in `claude --resume`.
    else if (session.name && !/^Session \d\d:\d\d$/.test(session.name)) options.title = String(session.name).slice(0, 120);

    this._lastRun = {
      sessionId, runId,
      resumeRequested: options.resume || null,
      sent: { provider, model: options.model, permissionMode: options.permissionMode, thinking: session.thinking, thinkingConfig: options.thinking || null, effort: options.effort || null, ultracode: isUltracode(session.thinking), maxThinkingTokens: options.maxThinkingTokens || 0, oneM: !!session.oneM, betas: options.betas || [], subAgents: subOn ? subMax : 0, autoCompactWindow: options.settings && options.settings.autoCompactWindow || 0, title: options.title || "", transferredEntries: recordBlock.count, transferMode: recordBlock.mode, skills: skillNames, skillsMode: composeFor(!!binding.id).skillsMode, fleet: !!(fleet && fleet.taskId), background: !!background, roleBrief: roleBrief ? roleBrief.length : 0, agentsBrief: !!agentsBrief, workflowJob: workflowJob || null },
      init: null,
    };

    const runOnce = async (opts, block, extra) => {
      stoppedNow();   // a Stop during the preparation just finished (or an earlier attempt) never dispatches a query
      runner.resultSeen = false; runner.sawOutput = false;
      // The prompt stream is held open until the run releases it (result with no background work, or a stop) — see buildPrompt.
      const feed = inputFeed();
      runner.feed = feed; runner.releaseInput = () => feed.close();
      // THIS attempt's appendix, composed after its resume path is known: a resumed session → what changed; a fresh
      // one → everything. The runner carries it so the init acknowledgement commits exactly what went out.
      const at = composeFor(!!opts.resume);
      runner.attempt = at;
      if (this._lastRun && this._lastRun.sessionId === sessionId) this._lastRun.sent.skillsMode = at.skillsMode;
      // A FRESH native session (rollover / overflow / lost session) is addressed as new although the
      // previous thread is still bound (it stays bound until the fresh one accepts — see handleMessage init).
      const q = query({ prompt: this.buildPrompt(composePrompt(block, extra, at), attachments, { claudeSessionId: opts.resume ? (session.claudeSessionId || "") : "" }, feed), options: opts });
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
      // Context rollover (user decision 2026-09-16, extending the 2026-09-10 exception): when the
      // native thread is nearly full — the NEXT request would fail with "prompt is too long" —
      // continue in a FRESH native session that receives the record sized to the model (exact
      // when it fits, else the cached rolling digest + the newest entries verbatim). Announced.
      const roll = options.resume ? this.contextRolloverNeeded(session, "anthropic", promptChars) : null;
      if (roll) {
        console.warn(`[claude:run] context rollover (${roll.reason}, ${roll.pct}%): new native session with the budgeted record`);
        // The replacement record is prepared FIRST — this can take a while and can be stopped — and
        // the native thread STAYS BOUND until the fresh session has accepted its input (the init
        // message hands the binding over — see handleMessage): a Stop here, or a failure before
        // acceptance (network, spawn), loses nothing — the next message still resumes the existing
        // thread and the measurement that decided the rollover is still there.
        preparing("Preparing the conversation record for a fresh native session");
        // The fresh session carries the FULL appendix (skills in full): its record is budgeted against that prompt.
        recordBlock = await this.transferBlock(session, "anthropic", { model: session.model, from: -1, to: promptIndex - 1, promptChars: promptCharsOf(composeFor(false)), signal: abortController.signal, onProgress: preparing });
        stoppedNow(); prepared();
        delete options.resume; runner.freshThread = true; runner.accepted = false; session.forceRollover = false;
        const f = (n) => Number(n || 0).toLocaleString("en-US");
        this.addMessage(session, { id: store.uid(), role: "system", text: `${roll.reason === "requested" ? "Context rollover requested" : `Context window ${roll.pct}% full (${f(roll.used)} of ${f(roll.window)} tokens)`} — Claude continues in a fresh native session. ${recordBlock.note} Nothing in this chat is lost; the complete record stays here.`.trim(), ts: store.nowISO() });
        if (this._lastRun && this._lastRun.sessionId === sessionId) { this._lastRun.rollover = roll; this._lastRun.sent.transferredEntries = recordBlock.count; this._lastRun.sent.transferMode = recordBlock.mode; }
        this.send("session:context", { sessionId, info: this.contextInfo(sessionId) });
      } else if (sync.needed) {
        preparing("Preparing the conversation record this thread has not seen");
        recordBlock = await this.transferBlock(session, "anthropic", { model: session.model, from: sync.from, to: sync.to, promptChars, signal: abortController.signal, activeTokens: sync.from > -1 ? (binding.activeTokens || 0) : 0, onProgress: preparing });
        stoppedNow(); prepared();
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
            preparing("Preparing the conversation record for a new native session");
            block = await this.transferBlock(session, "anthropic", { model: session.model, from: -1, to: promptIndex - 1, promptChars: promptCharsOf(composeFor(false)), signal: abortController.signal, onProgress: preparing });   // the new session's prompt carries the full appendix
            stoppedNow(); prepared();
            // The transcript is confirmed gone: nothing to keep; the new session takes the binding at its init.
            history.dropBinding(session, "anthropic"); delete options.resume; runner.freshThread = true; runner.accepted = false;
            this.addMessage(session, { id: store.uid(), role: "system", text: `Claude's native session could not be resumed. A new one was started. ${block.note}`.trim(), ts: store.nowISO() });
            if (this._lastRun && this._lastRun.sessionId === sessionId) { this._lastRun.resumedFresh = true; this._lastRun.sent.transferredEntries = block.count; this._lastRun.sent.transferMode = block.mode; }
            continue;
          }
          if (isPromptTooLong(e1) && !runner.retriedTooLong) {
            // Work the failing attempt already did travels with the replacement record, and the
            // model is asked to continue from it instead of redoing completed steps.
            runner.retriedTooLong = true;
            console.warn("[claude:run] prompt too long — starting a new native session with a summarised record:", e1.message);
            // What the model actually accepted is smaller than the catalog's window: learn the
            // real one (budgets, the rollover threshold and the CLI's auto-compaction use it).
            const estTokens = (options.resume ? (binding.activeTokens || 0) : 0) + Math.ceil(((block && block.text ? block.text.length : 0) + promptCharsOf(composeFor(!!options.resume))) / history.CHARS_PER_TOKEN);   // what the FAILED attempt actually carried
            const learned = this.learnWindow(session, "anthropic", session.model, estTokens);
            if (learned) this.addMessage(session, { id: store.uid(), role: "system", text: `The model accepted about ${Number(estTokens).toLocaleString("en-US")} tokens before rejecting the request, less than the ${Number(this.contextTokensFor("anthropic", session.model, session, { raw: true })).toLocaleString("en-US")}-token window assumed for it — AtomNano now budgets this session for a ${Number(learned).toLocaleString("en-US")}-token window.`, ts: store.nowISO() });
            const cont = this.continuationAfter(session, promptIndex);
            // The thread REJECTED this turn: it does not hold the prompt, so a Stop during the seed
            // below must not acknowledge it on the kept binding's cursor (finalizeRun).
            runner.accepted = false;
            // The summarised record is prepared BEFORE the thread is unbound (a Stop keeps the resume).
            preparing("Preparing a summarised conversation record after the context overflow");
            block = await this.transferBlock(session, "anthropic", { model: session.model, from: -1, to: cont.to, promptChars: promptCharsOf(composeFor(false)) + cont.note.length, forceSummary: true, budgetScale: 0.5, signal: abortController.signal, onProgress: preparing });   // the replacement carries the full appendix
            stoppedNow(); prepared();
            // The thread stays bound until the fresh session accepts (handleMessage init hands over).
            delete options.resume; runner.freshThread = true;
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
      // The thread has now seen everything up to and including this turn's output — unless the CLI RESET its
      // conversation during the turn (/clear, anthropic-events.js conversation_reset): the fresh context bound there
      // holds NONE of the record (nothing is injected mid-run, 2026-09-18), so the cursor stays at −1 and the next
      // user turn transfers everything. (acknowledgeAcceptedRun in the finally below is inert too: the reset
      // dropped the run's acceptance.)
      if (this.runners.get(sessionId) === runner && !runner.interrupted && !abortController.signal.aborted) history.setBinding(session, "anthropic", { id: session.claudeSessionId || binding.id, ...(runner.resetSeen ? {} : { syncedIndex: history.lastGlobalIndex(session) }), account: "" });
      store.scheduleWrite(sessionId);
      this.finalizeRun(session, runner, { aborted: false });
    } catch (e) {
      if (runner.interrupted || abortController.signal.aborted || this.runners.get(sessionId) !== runner) {
        this.finalizeRun(session, runner, { aborted: true });
      } else if (isNetworkError(e)) {
        console.warn("[claude:run] network error — will retry on reconnect:", (e && e.message) || e);
        session._pendingRetry = { text, model: session.model, permissionMode: session.permissionMode, thinking: session.thinking, oneM: session.oneM, attachments, subAgents, subAgentsMax, extraSystem, background, fleet, reviewers, reviewMode, resumeContinuation: true, promptMessageId, provider, roleBrief, workflowJob };
        this.addMessage(session, { id: store.uid(), role: "system", text: "Connection lost — will resume automatically when back online.", ts: store.nowISO() });
        store.updateSession(sessionId, { status: "offline" }); this.send("session:status", { sessionId, status: "offline" });
      } else if (isAuthError(e)) {
        // Login/token expired mid-run: PERSIST the pending run (survives restart) and
        // pause as "auth-expired". The native session id stays intact, so re-login
        // continues exactly where it left off.
        const payload = { text, model: session.model, permissionMode: session.permissionMode, thinking: session.thinking, oneM: session.oneM, attachments, subAgents, subAgentsMax, extraSystem, background, fleet, reviewers, reviewMode, resumeContinuation: true, promptMessageId, provider, roleBrief, workflowJob };
        session._pendingRetry = payload;
        console.warn(`[claude:run] auth/token expired (${provider}) — pausing session, will resume after re-login`);
        this.addMessage(session, { id: store.uid(), role: "system", text: `Your ${PROVIDER_LABEL[provider] || provider} login expired — this session is paused. Sign in again and it resumes automatically with full context.`, ts: store.nowISO() });
        store.updateSession(sessionId, { status: "auth-expired", pendingRun: { payload, reason: "auth", provider, at: store.nowISO() } });
        this.send("session:status", { sessionId, status: "auth-expired", provider });
      } else if (isRateLimitError(e)) {
        session._pendingRetry = { text, model: session.model, permissionMode: session.permissionMode, thinking: session.thinking, oneM: session.oneM, attachments, subAgents, subAgentsMax, extraSystem, background, fleet, reviewers, reviewMode, resumeContinuation: true, promptMessageId, provider, roleBrief, workflowJob };
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
      // Recoverable pauses retain their status, but accepted output is already in the native
      // transcript. A retry must not transfer those actions a second time.
      this.acknowledgeAcceptedRun(session, runner);
      // A paused run (offline / login / rate limit) never finalises — yet its CLI is gone: the tool
      // cards and sub-agents it left "running" end now and their CPU slots are freed.
      if (!runner.finalized) this.pauseRunLeftovers(session, runner);
      runner.running = false; runner.ended = true;
      clearTimeout(runner._graceTimer); clearTimeout(runner._taskIdle); clearTimeout(runner._releaseTimer);
      if (runner.releaseInput) runner.releaseInput();
      prepared();
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
  },

  /* Headless single Anthropic (or custom-base-URL) turn — the summariser, the Planner role, the CLI.
   * No sessions, no IPC, no permission UI. `system` here is the caller's EXPLICIT instruction (a CLI
   * flag, the Planner role, the summary instruction), never an app-added layer.
   *
   * Lifecycle, like the primary run's: the CLI is spawned by the app so its pid is known; the prompt
   * stream is held OPEN until THIS call's result (a zero-turn result before any output is the CLI
   * finalising something else and is ignored, and a closed stdin would break the permission channel).
   * A cancellation (`signal`) or `timeoutMs` returns to the caller AT ONCE — even when the transport
   * ignores it — and ends the CLI graceful-first, like Stop on a turn: query.interrupt() asks the
   * harness to end the turn itself (it cancels the running tool and the shell processes it started —
   * the allow-tools planner may be mid-command); only a process that has not exited by the grace
   * period has its transport aborted and its whole process tree killed (pid known). The cancel and
   * the timeout are armed BEFORE the SDK / CLI-path setup, so neither can dispatch a query late.
   * Resolves to the text produced (streamed deltas, else the assistant text, else the result's own text). */
  async runHeadlessAnthropic({ settings, model, thinking, oneM, system, prompt, cwd, allowTools, stream, onText, onResult, signal, timeoutMs, label } = {}) {
    const abortError = (msg) => { const e = new Error(msg); e.name = "AbortError"; return e; };
    // An already-cancelled parent never starts a new model call.
    if (signal && signal.aborted) throw abortError("Cancelled before the request started");
    const abortController = new AbortController();
    const proc = { pid: null, exited: false, stderrTail: "", label: label || "" };   // spawnCli records the child's pid (and exit) here
    const feed = inputFeed();
    let wake = null; const stopped = new Promise((res) => { wake = res; });
    let ended = { why: "" };
    let q = null, gotResult = false, timer = null, graceTimer = null;
    // Tear the transport down and end the CLI's process tree — the fallback after the grace period,
    // and the immediate action while there is no query to interrupt yet.
    const hardStop = () => {
      graceTimer = null;
      if (!proc.exited) { try { abortController.abort(); } catch { /* */ } this.killProcessTree(proc); }   // a CLI that already wound down is left alone
      if (q && typeof q.return === "function") { try { const r = q.return(); if (r && typeof r.catch === "function") r.catch(() => {}); } catch { /* */ } }
    };
    // Cancel / time out: wake the read loop (the caller gets its error now), end the input, and end
    // the CLI — graceful first when a turn is running, else at once.
    const stop = (why) => {
      if (ended.why) return; ended.why = why;
      const graceful = !!(q && typeof q.interrupt === "function") && !gotResult && !abortController.signal.aborted;
      if (graceful) { try { Promise.resolve(q.interrupt()).catch(() => {}); } catch { /* */ } }
      feed.close();
      if (graceful) graceTimer = setTimeout(hardStop, this.interruptGraceMs); else hardStop();   // hardStop skips the kill once the CLI has exited
      wake();
    };
    const onAbort = () => stop("cancelled");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    // Armed before any setup: a timeout during the SDK load / CLI lookup ends the call without a query.
    if (timeoutMs > 0) timer = setTimeout(() => stop("timeout"), timeoutMs);
    const endedError = () => ended.why === "timeout"
      ? Object.assign(new Error(`The model did not answer within ${Math.round(timeoutMs / 60000) || 1} minute${Math.round(timeoutMs / 60000) === 1 ? "" : "s"}${proc.label ? ` (${proc.label})` : ""} — the request was cancelled.`), { name: "TimeoutError", timeout: true })
      : abortError("Cancelled while the model was answering");
    // Setup awaits are RACED against the stop: a cancel or timeout returns to the caller at once even
    // while the SDK import or the CLI lookup is still pending — and nothing is dispatched afterwards.
    const orStopped = (p) => Promise.race([p, stopped.then(() => undefined)]);
    let query;
    try {
      const sdk = await orStopped(loadSDK());
      if (ended.why) throw endedError();
      ({ query } = sdk);
    } catch (e) { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); throw e; }
    const options = {
      cwd: cwd || process.cwd(),
      model: model || settings.defaultModel || "claude-opus-4-8",
      permissionMode: allowTools ? (settings.defaultPermissionMode || "acceptEdits") : "default",
      includePartialMessages: !!stream,
      systemPrompt: system ? { type: "preset", preset: "claude_code", append: system } : { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      abortController,
      stderr: () => {},
      spawnClaudeCodeProcess: (cfg) => this.spawnCli(cfg, proc),
      canUseTool: allowTools
        ? ((_t, input) => ({ behavior: "allow", updatedInput: input }))
        : (() => ({ behavior: "deny", message: "Tools are disabled in CLI text mode — pass --agent to enable." })),
      env: this.buildEnv(settings),
    };
    let full = "", resultText = "", sawOutput = false;
    const drainMs = 4000;   // after OUR result and the input's end, how long the CLI gets to exit on its own
    let it = null;
    try {
      const effErr = applyThinking(options, options.model, thinking || "low");
      if (effErr) throw new Error(effErr);
      if (require("../providers/catalog").context1M("anthropic", options.model)) options.betas = ["context-1m-2025-08-07"];
      const cli = await orStopped(this.resolveCli(settings));
      if (ended.why) throw endedError();   // cancelled / timed out during setup: no query is dispatched
      if (cli) options.pathToClaudeCodeExecutable = cli; else options.executable = "node";
      q = query({ prompt: this.buildPrompt(String(prompt || ""), [], { claudeSessionId: "" }, feed), options });
      it = q[Symbol.asyncIterator]();
      for (;;) {
        const nextP = it.next(); nextP.catch(() => {});   // an abandoned step (after a stop) must not surface as an unhandled rejection
        const racers = [nextP, stopped.then(() => ({ stopped: true }))];
        if (gotResult) racers.push(new Promise((res) => setTimeout(() => res({ drained: true }), drainMs)));
        const step = await Promise.race(racers);
        if (step.stopped) break;
        if (step.drained) { stop("drained"); break; }   // the process did not exit after its result: end it, the text is complete
        if (step.done) break;
        const m = step.value;
        if (!m) continue;
        if (m.type === "stream_event") {
          sawOutput = true;
          const ev = m.event;
          if (ev && ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text) { full += ev.delta.text; if (onText) onText(ev.delta.text); }
        } else if (m.type === "assistant" || m.type === "user" || m.type === "tool_progress") {
          sawOutput = true;
          if (m.type === "assistant" && !stream) for (const b of (m.message && m.message.content) || []) if (b && b.type === "text" && b.text) full += b.text;
        } else if (m.type === "result") {
          // A zero-turn success before any output is not this call's result (see handleMessage).
          if (!sawOutput && !m.is_error && m.num_turns === 0) { console.warn("[claude:headless] early result ignored (no output yet)"); continue; }
          if (m.is_error) { const err = new Error(String(m.result || (Array.isArray(m.errors) && m.errors[0]) || "headless run failed")); if (isPromptTooLong(err)) err.promptTooLong = true; throw err; }
          if (typeof m.result === "string") resultText = m.result;
          gotResult = true;
          if (onResult) onResult({ usage: m.usage || null, modelUsage: m.modelUsage || null, costUsd: m.total_cost_usd || 0, durationMs: m.duration_ms || 0, model: options.model });
          feed.close();   // OUR result: the input ends, the CLI exits, the iterator completes
        }
      }
      if (ended.why === "cancelled" || ended.why === "timeout") throw endedError();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      feed.close();
      if (graceTimer) {
        // Winding down gracefully: the CLI gets the grace period to end on its own; meanwhile its
        // remaining output is drained so the transport never blocks, then the fallback tears it down.
        (async () => { try { for (;;) { const s = await Promise.race([it.next(), new Promise((res) => setTimeout(() => res({ done: true }), this.interruptGraceMs + 500))]); if (!s || s.done) break; } } catch { /* the abort ends it */ } })();
      } else {
        // Never leave a CLI behind: a call that ended without its result (an error) is torn down too.
        if (!gotResult && !ended.why) { try { abortController.abort(); } catch { /* */ } this.killProcessTree(proc); }
        if (q && typeof q.return === "function") { try { const r = q.return(); if (r && typeof r.catch === "function") r.catch(() => {}); } catch { /* */ } }
      }
    }
    return full || resultText;
  },

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
  },

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
  },

  // Record a concrete model id seen in use (deduped, newest first).
  registerModel(id) {
    if (!id || !/(^|[^a-z])(claude|opus|sonnet|haiku|fable|mythos)([^a-z]|$)/i.test(String(id))) return;
    const prev = store.getSettings().discoveredModels || [];
    if (prev.includes(id)) return;
    const merged = [id, ...prev];
    try { store.saveSettings({ discoveredModels: merged }); } catch { /* reported by store */ }
    this.send("models:update", { ids: merged });
  },
};

module.exports = { methods };
