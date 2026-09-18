"use strict";
/* OPENAI (CODEX) — exec transport via @openai/codex-sdk.
 *
 * Fallback for the interactive app-server transport (codex-appserver.js) when
 * that process cannot start: live token streaming is coarser (whole agent
 * messages), approvals cannot be asked (non-interactive → declined), but the
 * request is delivered with its full text, every attached file inlined in full,
 * and images as structured `local_image` inputs.
 *
 * The SDK is ESM-only and wraps the bundled @openai/codex binary; we load it with
 * dynamic import() from this CommonJS module. Every failure is returned as a value
 * (never thrown), so claude.js can report a recoverable transport state.
 */
const fs = require("fs");
const { webSearchMode } = require("./codex-appserver");   // same setting → mode mapping as the primary transport

let _sdk;   // cached ESM module (import() is async; do it once)
async function loadSdk() {
  if (_sdk) return _sdk;
  _sdk = await import("@openai/codex-sdk");
  return _sdk;
}
// After an in-app SDK update the cached module still points at the OLD code: an
// ESM import cannot be re-evaluated in this process. Callers report that the new
// version becomes active after a relaunch; this at least lets a fresh process
// (or a test) drop the reference.
function resetSdk() { _sdk = null; }
function sdkLoaded() { return !!_sdk; }

// Every level the Codex SDK's ModelReasoningEffort type accepts (0.153). Callers
// pass a level already validated against the MODEL by providers.openaiEffort();
// this set only guards against garbage reaching the SDK.
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"]);

// Build the structured input: the prompt text (exact), each attached text file
// inlined in FULL (no count or size caps — the provider reports its own limits),
// and every image with a durable path as a native image input.
function buildInput(promptText, attachments) {
  const atts = Array.isArray(attachments) ? attachments : [];
  const files = atts.filter((a) => a && a.kind !== "image" && a.path);
  const images = atts.filter((a) => a && a.kind === "image" && a.path);
  let text = String(promptText || "");
  if (files.length) {
    const parts = [];
    for (const f of files) {
      try { parts.push(`--- ${f.name || f.path} ---\n${fs.readFileSync(f.path, "utf8")}`); }
      catch (e) { parts.push(`--- ${f.name || f.path} --- (could not read: ${(e && e.code) || e})`); }
    }
    text += (text ? "\n\n" : "") + "Attached files:\n" + parts.join("\n\n");
  }
  if (!images.length) return text;
  const input = [];
  if (text) input.push({ type: "text", text });
  for (const im of images) input.push({ type: "local_image", path: im.path });
  return input;
}

/* Run one turn and stream it through `on` (all callbacks optional):
 *   onThreadId(id)         — persist for resume (Codex keeps sessions in ~/.codex)
 *   onTextDelta(text)      — assistant text delta      → session:partial "text"
 *   onReasoningDelta(text) — reasoning delta           → session:partial "thinking"
 *   onReasoning(text)      — a completed reasoning block
 *   onToolStart(item)      — a tool item began         → tool card
 *   onToolUpdate(item)     — a tool item progressed
 *   onToolEnd(item)        — a tool item finished       → patch tool card
 *   onErrorItem(message)   — a non-fatal error item
 *   onUsage(usage)         — token usage for the turn
 *
 * Returns { ok, text, threadId, usage, error, aborted, loadFailed, threadLost }.
 * `loadFailed` marks an SDK-unavailable error (recoverable transport state);
 * `threadLost` marks a resume whose thread no longer exists (the caller re-syncs
 * the conversation record into a new thread — never a silent blank start).
 */
async function run({ apiKey, baseUrl, model, effort, cwd, promptText, attachments, resumeId, signal, webSearch, reasoningSummary, contextWindow, readOnly, config: extraConfig, on } = {}) {
  on = on || {};

  let Codex;
  try { ({ Codex } = await loadSdk()); }
  catch (e) { return { ok: false, loadFailed: true, error: "codex-sdk unavailable: " + ((e && e.message) || e) }; }

  const clientOpts = {};
  if (apiKey) clientOpts.apiKey = apiKey;          // else the bundled codex uses ~/.codex/auth.json (ChatGPT login)
  if (baseUrl) clientOpts.baseUrl = baseUrl;
  // `config`: extra `--config key=value` overrides from the caller (dotted keys — e.g. the sub-agent lane:
  // features.multi_agent + agents.max_concurrent_threads_per_session, session/openai.js).
  const config = { ...(extraConfig && typeof extraConfig === "object" ? extraConfig : {}) };
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) {
    config.model_context_window = contextWindow;
    config.model_auto_compact_token_limit = Math.floor(contextWindow * 0.9);
  }
  if (reasoningSummary && ["auto", "concise", "detailed", "none"].includes(reasoningSummary)) config.model_reasoning_summary = reasoningSummary;
  if (Object.keys(config).length) clientOpts.config = config;

  const threadOpts = {
    workingDirectory: cwd || process.cwd(),
    sandboxMode: readOnly ? "read-only" : "workspace-write",   // planner inspects; coder writes
    approvalPolicy: "never",     // non-interactive: the app is the harness, not a TTY
    skipGitRepoCheck: true,      // AtomNano projects aren't always git repos
  };
  if (model) threadOpts.model = model;
  if (effort && EFFORTS.has(effort)) threadOpts.modelReasoningEffort = effort;
  // webSearchMode only: the SDK ignores webSearchEnabled whenever webSearchMode is set,
  // and an explicit "disabled" is the only way to turn search OFF (unset = Codex's
  // config.toml default, which is "cached"). Unset in the app → leave Codex's default.
  const ws = webSearchMode(webSearch);
  if (ws) threadOpts.webSearchMode = ws;

  let thread;
  try {
    const codex = new Codex(clientOpts);
    thread = resumeId ? codex.resumeThread(resumeId, threadOpts) : codex.startThread(threadOpts);
  } catch (e) {
    return { ok: false, error: "codex thread init failed: " + ((e && e.message) || e), threadId: resumeId || null };
  }

  let finalText = "";
  let usage = null;
  const lastText = new Map();     // itemId -> last text seen (to compute streaming deltas)
  let idSent = false;
  const flushId = () => { if (!idSent && thread.id) { idSent = true; try { on.onThreadId && on.onThreadId(thread.id); } catch { /* */ } } };
  const call = (fn, arg) => { try { fn && fn(arg); } catch { /* callback must never break the loop */ } };
  const isThreadLost = (msg) => /no rollout found|thread .*not found|unknown thread|no such thread|could not resume/i.test(String(msg || ""));

  try {
    const { events } = await thread.runStreamed(buildInput(promptText, attachments), signal ? { signal } : undefined);
    for await (const ev of events) {
      if (signal && signal.aborted) break;
      switch (ev.type) {
        case "thread.started":
          flushId();
          break;

        case "turn.started":
          flushId();
          call(on.onTurnStarted);
          break;

        case "item.started":
        case "item.updated":
        case "item.completed": {
          const it = ev.item;
          if (!it) break;
          if (it.type === "agent_message" || it.type === "reasoning") {
            const prev = lastText.get(it.id) || "";
            const cur = it.text || "";
            if (cur.length > prev.length) {
              const delta = cur.slice(prev.length);
              lastText.set(it.id, cur);
              if (it.type === "agent_message") call(on.onTextDelta, delta);
              else call(on.onReasoningDelta, delta);
            }
            if (ev.type === "item.completed") {
              if (it.type === "agent_message") finalText += (finalText ? "\n" : "") + (it.text || "");
              else call(on.onReasoning, it.text || "");
            }
          } else if (it.type === "command_execution" || it.type === "file_change" || it.type === "web_search" || it.type === "mcp_tool_call" || it.type === "todo_list") {
            if (ev.type === "item.started") call(on.onToolStart, it);
            else if (ev.type === "item.completed") call(on.onToolEnd, it);
            else call(on.onToolUpdate, it);
          } else if (it.type === "error") {
            call(on.onErrorItem, it.message || "error");
          }
          break;
        }

        case "turn.completed":
          usage = ev.usage || null;
          if (usage) call(on.onUsage, usage);
          break;

        case "turn.failed": {
          flushId();
          const msg = (ev.error && ev.error.message) || "turn failed";
          return { ok: false, error: msg, threadLost: !!resumeId && isThreadLost(msg), threadId: thread.id || resumeId || null, usage };
        }

        case "error": {
          flushId();
          const msg = ev.message || "stream error";
          return { ok: false, error: msg, threadLost: !!resumeId && isThreadLost(msg), threadId: thread.id || resumeId || null, usage };
        }
      }
      flushId();
    }
  } catch (e) {
    flushId();
    if (signal && signal.aborted) return { ok: false, aborted: true, threadId: thread.id || resumeId || null, usage };
    const msg = (e && e.message) || String(e);
    return { ok: false, error: "codex run failed: " + msg, threadLost: !!resumeId && isThreadLost(msg), threadId: thread.id || resumeId || null, usage };
  }

  flushId();
  if (signal && signal.aborted) return { ok: false, aborted: true, threadId: thread.id || resumeId || null, usage };
  return { ok: true, text: finalText, threadId: thread.id || resumeId || null, usage };
}

module.exports = { run, buildInput, resetSdk, sdkLoaded };
