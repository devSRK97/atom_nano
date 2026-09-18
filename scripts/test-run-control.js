"use strict";
/* Run-control regression suite — DESIRED behaviour for the Claude harness path in claude.js:
 *   · the prompt input stream stays OPEN until THIS turn's result: an early `result` (the CLI
 *     finalising a queued task notification on resume, zero turns) neither ends the turn nor
 *     closes the permission channel ("Tool permission request failed: AbortError: Stream closed");
 *   · streamed tool arguments reach the renderer coalesced and bounded (no O(n²) IPC for a big Write);
 *   · parallel tool calls keep their own cards, arguments and results;
 *   · Stop is graceful-first (query.interrupt → wind-down), the abort + process-tree kill is the
 *     fallback after the grace period; a replacing run waits for the stopped one to drain;
 *   · the CLI is spawned with the SDK's own options and the run knows its pid.
 * The ORIGINAL session modules (src/main/session/) run in a VM with a controllable fake SDK and a fake child_process;
 * store.js / history.js are real on an isolated data home. No network, no model calls, no saved
 * conversations.  Run: node scripts/test-run-control.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { EventEmitter } = require("events");
const ROOT = path.join(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-runctl-"));
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, "claude-home"); fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
process.env.CODEX_HOME = path.join(HOME, "codex-home"); fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === "electron") return { app: { getPath: (k) => (k === "userData" ? HOME : os.homedir()), getAppPath: () => ROOT, isPackaged: false } }; return origLoad.call(this, req, ...rest); };

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 700) : ""}`); } }
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 120000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = require(path.join(ROOT, "src/main/storage/store.js"));
const history = require(path.join(ROOT, "src/main/storage/history.js"));
store.loadSettings();
store.saveSettings({ llmProvider: "anthropic", modeNote: false });   // modeNote off: these suites assert bare solo turns (the note has its own checks, test-workflow W29)
const { loadSessionInVm } = require("./lib/session-vm");   // the ORIGINAL session modules, fakes injected

/* A fake CLI child: pid, pipes as emitters, kill recorded. */
function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid; c.stdin = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.killed = false; c.exitCode = null; c.signalCode = null; c.kill = (sig) => { c.killed = true; c.signalCode = sig || "SIGTERM"; return true; };
  return c;
}

/* One isolated SessionManager. `script(ctx)` is an async generator producing the SDK messages of a
 * query; it receives { opts, q, prompt, released } and may await ctx.gate / call ctx.spawn(). */
function environment() {
  const sends = [], sdkCalls = [], spawns = [], kills = [];
  const control = { script: null };
  const fakeCp = {
    spawn: (command, args, options) => { const child = fakeChild(4000 + spawns.length); spawns.push({ command, args, options, child }); if (command === "taskkill") { kills.push({ taskkill: args.slice() }); process.nextTick(() => child.emit("exit", 0)); } return child; },
  };
  const sdk = { query(opts) {
    const call = { prompt: opts.prompt, options: opts.options, promptEnded: false, interrupts: 0, t: Date.now() }; sdkCalls.push(call);
    call.prompts = [];
    const consumed = (async () => { for await (const m of opts.prompt) { call.prompts.push(m.message.content); if (call.onPrompt) call.onPrompt(m.message.content); } call.promptEnded = true; call.promptEndedAt = Date.now(); call.promptText = call.prompts.length === 1 ? call.prompts[0] : call.prompts.slice(); return call.prompts; })();
    call.consumed = consumed;
    const gen = (control.script || defaultScript)({ opts, call, spawn: () => opts.options.spawnClaudeCodeProcess && opts.options.spawnClaudeCodeProcess({ command: "claude", args: ["--output-format", "stream-json"], cwd: opts.options.cwd, env: {}, signal: opts.options.abortController.signal }) });
    const q = { [Symbol.asyncIterator]() { return gen; }, next: (...a) => gen.next(...a), return: (...a) => gen.return(...a), throw: (...a) => gen.throw(...a),
      interrupt: async () => { call.interrupts++; call.interruptAt = Date.now(); if (call.onInterrupt) call.onInterrupt(); return {}; },
      setPermissionMode: async () => {}, setModel: async () => {} };
    call.q = q;
    return q;
  } };
  async function* defaultScript({ call }) {
    await sleep(5);
    yield { type: "system", subtype: "init", session_id: call.options.resume || "native-1", model: "claude-opus-4-8" };
    yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "Synthetic reply." }] } };
    yield { type: "result", subtype: "success", is_error: false, session_id: "native-1", num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };
    await call.consumed;   // the SDK would only end the process once stdin is closed
  }
  // The fixture model is a genuine 200K model: the catalog decides the window (T7, 2026-09-16), so a 1M-capable
  // entry would silently turn every 200K scenario (rollover at 95 %, summary-mode preparation) into a no-op.
  const providers = { get: () => ({ label: "anthropic", models: [{ id: "claude-opus-4-8", ctx: 200000, ctx1m: false }], defaultModel: "claude-opus-4-8", defaultReasoning: "low", primary: "sdk" }), context1M: () => false, resolveOpenAIModelStrict: (id) => ({ model: id }), resolveOpenAIModel: (id) => ({ model: id }), openaiEffortStrict: (e) => ({ effort: e || "low" }), openaiEffort: () => "low" };
  const map = { path, fs, os, crypto: require("crypto"), child_process: fakeCp, "./store": store, "./history": history, "./cli-auth": {}, "./attachments": { persistAll: (a) => a, light: (a) => a, readBase64: () => "" }, "./tool-args": require(path.join(ROOT, "src/main/session/tool-args.js")), "./subagents": require(path.join(ROOT, "src/main/agents/subagents.js")), "./catalog": providers, "./codex-appserver": { ctxKeyOf: () => "login", run: async () => ({ ok: true, text: "" }), injectItems: async () => ({ ok: true }), interrupt: async () => true, steer: async () => ({ ok: true }) }, "./codex-exec": { run: async () => ({ ok: true, text: "" }) }, "./codex-cards": { unwrapCmd: (x) => x, parseDiff: () => ({ oldText: "", newText: "", added: 0, removed: 0 }), classifyCmd: () => null }, "./council": { reviewerRun: async () => ({ ok: true, text: "" }), label: () => "Reviewer" }, "./custom-api": { getEndpoint: () => null, call: async () => ({ ok: true, text: "" }) } };
  const { M } = loadSessionInVm({ deps: map, sdk });
  M.send = (name, data) => sends.push({ name, data, t: Date.now() });
  M.buildEnv = () => ({}); M.resolveCli = async () => "claude"; M.composeMcp = () => ({}); M.registerModel = () => {}; M.scheduleRetry = () => {};
  M.setSummarizer(async () => "summary");
  M.resultReleaseGraceMs = 60;   // real value 2.5 s — shortened so the suite stays quick (R13 tests the grace itself)
  const make = () => { const v = store.createSession({ cwd: HOME, name: "runctl", model: "claude-opus-4-8", thinking: "low" }); store.flush(v.id); return store.getSession(v.id); };
  return { M, make, sends, sdkCalls, spawns, kills, control };
}
const toolCards = (s) => s.messages.filter((m) => m.role === "tool");
const roles = (s) => s.messages.map((m) => m.role);

async function main() {
  // ---- R01: an early result (no output yet) is ignored; the input stream stays open until OUR result ----
  { const e = environment(); const s = e.make(); const order = [];
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 0, duration_ms: 56, total_cost_usd: 0 };   // the CLI closing a queued task notification on resume
      await sleep(30); order.push({ ev: "afterEarly", promptEnded: call.promptEnded });
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Edit", input: {} } } };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.js", old_string: "x", new_string: "y" } }] } };
      await sleep(30); order.push({ ev: "midTurn", promptEnded: call.promptEnded });
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] } };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Done." }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 5 } };
      await call.consumed; order.push({ ev: "afterFinal", promptEnded: call.promptEnded });
    };
    await e.M.run(s.id, { text: "hello" });
    const results = s.messages.filter((m) => m.role === "result"), errors = s.messages.filter((m) => m.role === "error");
    const call = e.sdkCalls[0];
    check("R01", "an early zero-turn result is ignored: the input stream stays open through the turn and only OUR result ends it", results.length === 1 && errors.length === 0 && order[0].promptEnded === false && order[1].promptEnded === false && order[2].promptEnded === true && call.promptEnded && s.status === "done" && toolCards(s)[0].status === "done", { order, results: results.length, errors: errors.length, status: s.status, roles: roles(s) });
    const st = e.sends.filter((x) => x.name === "session:status").map((x) => x.data.status);
    check("R01b", "the run reports running → done exactly once (no premature idle at the early result)", st.filter((x) => x === "done" || x === "idle").length === 1 && st[st.length - 1] === "done", st); }

  // ---- R02: a genuine error result without output still ends the run (auth / API errors keep working) ----
  { const e = environment(); const s = e.make();
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["API error 500"], num_turns: 0, total_cost_usd: 0 };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "hello" });
    check("R02", "an error result with no output is this turn's end: error card, status error, input released", s.messages.some((m) => m.role === "error" && /500/.test(m.text)) && s.status === "error" && e.sdkCalls[0].promptEnded, { status: s.status, roles: roles(s), promptEnded: e.sdkCalls[0].promptEnded }); }

  // ---- R03: streamed Write arguments reach the renderer coalesced and bounded ----
  { const e = environment(); const s = e.make();
    const body = "x".repeat(300000); const CH = 100;
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "w1", name: "Write", input: {} } } };
      const json = JSON.stringify({ file_path: "C:/proj/big.txt", content: body });
      for (let i = 0; i < json.length; i += CH) { yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(i, i + CH) } } }; if (i === CH * 1500) await sleep(200); }
      await sleep(200);
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "C:/proj/big.txt", content: body } }] } };
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "written", is_error: false }] } };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Done." }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0 };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "write it" });
    const upd = e.sends.filter((x) => x.name === "session:message-update" && x.data.patch && x.data.patch.partialInput !== undefined && x.data.patch.partialInput !== null);
    const sizes = upd.map((x) => x.data.patch.partialInput.length);
    const card = toolCards(s)[0];
    check("R03", "3,000 argument fragments → a handful of bounded renderer updates (not one per fragment carrying the whole body)", upd.length >= 1 && upd.length <= 12 && sizes.every((n) => n <= 6300) && upd.every((x) => x.data.patch.partialBytes > 0 && x.data.patch.toolInput && x.data.patch.toolInput.file_path === "C:/proj/big.txt"), { updates: upd.length, sizes, bytes: upd.map((x) => x.data.patch.partialBytes) });
    check("R03b", "the finished card holds the complete input, no leftover streaming excerpt, status done", card && card.status === "done" && card.toolInput.content === body && card.partialInput === undefined && card.result === "written", { status: card && card.status, len: card && card.toolInput.content && card.toolInput.content.length, partial: card && card.partialInput && card.partialInput.length }); }

  // ---- R04: parallel tool calls keep their own cards, arguments and results ----
  { const e = environment(); const s = e.make();
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "p1", name: "Read", input: {} } } };
      yield { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "p2", name: "Grep", input: {} } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"C:/proj/a.js"' } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pattern":"TODO","path":"C:/proj"' } } };
      await sleep(180);
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "}" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "}" } } };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "p1", name: "Read", input: { file_path: "C:/proj/a.js" } }, { type: "tool_use", id: "p2", name: "Grep", input: { pattern: "TODO", path: "C:/proj" } }] } };
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "p2", content: "3 hits", is_error: false }] } };   // out of order
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "p1", content: "file body", is_error: false }] } };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Done." }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0 };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "parallel" });
    const cards = toolCards(s);
    const read = cards.find((c) => c.toolUseId === "p1"), grep = cards.find((c) => c.toolUseId === "p2");
    const streamed = e.sends.filter((x) => x.name === "session:message-update" && x.data.patch && x.data.patch.partialInput);
    check("R04", "two parallel tools → two cards, each with its own arguments and the result addressed to it (out-of-order results ok)", cards.length === 2 && read && grep && read.toolName === "Read" && read.toolInput.file_path === "C:/proj/a.js" && read.result === "file body" && read.status === "done" && grep.toolName === "Grep" && grep.toolInput.pattern === "TODO" && grep.result === "3 hits" && grep.status === "done", cards.map((c) => ({ id: c.toolUseId, name: c.toolName, input: c.toolInput, result: c.result, status: c.status })));
    check("R04b", "each streaming update targets its own card with its own fields", streamed.length >= 2 && streamed.every((x) => (x.data.messageId === read.id && x.data.patch.toolInput.file_path === "C:/proj/a.js") || (x.data.messageId === grep.id && x.data.patch.toolInput.pattern === "TODO")), streamed.map((x) => ({ id: x.data.messageId, ti: x.data.patch.toolInput }))); }

  // ---- R05: Stop is graceful-first: interrupt reaches the CLI while stdin is open; no abort when it winds down ----
  { const e = environment(); const s = e.make(); const trace = [];
    e.control.script = async function* ({ call, spawn }) {
      spawn();
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "b1", name: "Bash", input: {} } } };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }] } };
      await new Promise((res) => { call.onInterrupt = () => { trace.push({ ev: "interrupt", promptEnded: call.promptEnded, aborted: call.options.abortController.signal.aborted }); res(); }; });
      await sleep(20);   // the CLI cancels the tool …
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "[Request interrupted by user for tool use]", is_error: true }] } };
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], num_turns: 1, total_cost_usd: 0.002 };   // … and ends the turn
      await call.consumed; trace.push({ ev: "ended", promptEnded: call.promptEnded, aborted: call.options.abortController.signal.aborted });
    };
    const run = e.M.run(s.id, { text: "run tests" });
    await sleep(60);
    const t0 = Date.now();
    await e.M.interrupt(s.id, "stop");
    await run;
    const ms = Date.now() - t0;
    const card = toolCards(s)[0];
    check("R05", "interrupt is delivered to the CLI first (stdin still open, not aborted) and the turn winds down without an abort or a kill", e.sdkCalls[0].interrupts === 1 && trace[0] && trace[0].aborted === false && trace[0].promptEnded === false && trace[1] && trace[1].aborted === false && e.kills.length === 0 && ms < 2000, { trace, interrupts: e.sdkCalls[0].interrupts, kills: e.kills, ms });
    check("R05b", "the cancelled tool stays 'interrupted' (with the CLI's text), 'Stopped by you.' is recorded once, no extra result/error card", card && card.status === "interrupted" && /interrupted/i.test(card.result) && s.messages.filter((m) => m.role === "system" && /Stopped by you/.test(m.text)).length === 1 && !s.messages.some((m) => m.role === "error") && s.messages.filter((m) => m.role === "result").length === 0 && s.status === "idle", { card: card && { status: card.status, result: card.result }, roles: roles(s), status: s.status }); }

  // ---- R06: a turn that does not wind down is torn down after the grace period — abort + process-tree kill ----
  { const e = environment(); const s = e.make(); e.M.interruptGraceMs = 150;
    e.control.script = async function* ({ call, spawn }) {
      spawn();
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sleep 999" } }] } };
      await new Promise((res) => call.options.abortController.signal.addEventListener("abort", res, { once: true }));   // ignores the interrupt; dies only when killed
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const run = e.M.run(s.id, { text: "hang" });
    await sleep(40);
    const t0 = Date.now();
    await e.M.interrupt(s.id, "stop");
    await run;
    const ms = Date.now() - t0;
    const tk = e.kills.find((k) => k.taskkill);
    const pid = e.spawns.find((x) => x.command === "claude").child.pid;
    check("R06", "after the grace period the transport is aborted and the CLI's whole process tree is killed (taskkill /T /F on Windows)", e.sdkCalls[0].interrupts === 1 && e.sdkCalls[0].options.abortController.signal.aborted && ms >= 140 && ms < 3000 && (process.platform !== "win32" || (tk && tk.taskkill.includes(String(pid)) && tk.taskkill.includes("/T") && tk.taskkill.includes("/F"))), { ms, kills: e.kills, pid, aborted: e.sdkCalls[0].options.abortController.signal.aborted, status: s.status }); }

  // ---- R07: a replacing run waits for the stopped one to drain (never two CLIs on one native session) ----
  { const e = environment(); const s = e.make(); const marks = {};
    let first = true;
    e.control.script = async function* ({ call }) {
      if (first) {
        first = false;
        yield { type: "system", subtype: "init", session_id: "native-1" };
        yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "working…" }] } };
        await new Promise((res) => { call.onInterrupt = res; });
        await sleep(120);   // slow wind-down
        yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
        await call.consumed; marks.firstEnded = Date.now();
        return;
      }
      marks.secondStarted = Date.now();
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "second" }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    const r1 = e.M.run(s.id, { text: "first" });
    await sleep(40);
    await e.M.interrupt(s.id, "replace");
    const r2 = e.M.run(s.id, { text: "second" });   // the renderer dispatches the queued message right after "idle"
    await Promise.all([r1, r2]);
    check("R07", "the replacing run's query starts only after the stopped run's process ended", e.sdkCalls.length === 2 && marks.firstEnded && marks.secondStarted && marks.secondStarted >= marks.firstEnded && s.messages.some((m) => m.role === "assistant" && m.text === "second") && s.status === "done", { marks, calls: e.sdkCalls.length, status: s.status }); }

  // ---- R08: the CLI is spawned with the SDK's own options and the run knows its pid ----
  { const e = environment(); const s = e.make();
    e.control.script = async function* ({ call, spawn }) {
      const child = spawn(); child.stderr.emit("data", Buffer.from("warning: something\n"));
      yield { type: "system", subtype: "init", session_id: "native-1" };
      call.pidSeen = e.M.runners.get(s.id) && e.M.runners.get(s.id).pid; call.tail = e.M.runners.get(s.id) && e.M.runners.get(s.id).stderrTail;
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "hi" }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "spawn" });
    const sp = e.spawns.find((x) => x.command === "claude");
    check("R08", "spawnClaudeCodeProcess is supplied and spawns with pipes, windowsHide and the forwarded signal; the run records pid and stderr", typeof e.sdkCalls[0].options.spawnClaudeCodeProcess === "function" && sp && Array.isArray(sp.options.stdio) && sp.options.stdio.join() === "pipe,pipe,pipe" && sp.options.windowsHide === true && sp.options.signal === e.sdkCalls[0].options.abortController.signal && sp.options.cwd === HOME && e.sdkCalls[0].pidSeen === sp.child.pid && /warning: something/.test(e.sdkCalls[0].tail || ""), { options: sp && { stdio: sp.options.stdio, windowsHide: sp.options.windowsHide, cwd: sp.options.cwd }, pidSeen: e.sdkCalls[0].pidSeen, tail: e.sdkCalls[0].tail }); }

  // ---- R09: tools announced together wait ("queued") until the CLI starts them (PreToolUse hook) ----
  { const e = environment(); const s = e.make(); const seen = [];
    const hook = (opts, id, name) => opts.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: name, tool_input: {}, tool_use_id: id }, id, { signal: new AbortController().signal });
    const status = (id) => { const c = toolCards(s).find((x) => x.toolUseId === id); return c ? c.status : null; };
    e.control.script = async function* ({ call, opts }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }, { type: "tool_use", id: "w1", name: "Write", input: { file_path: "C:/proj/a.txt", content: "x" } }] } };
      seen.push({ at: "announced", b1: status("b1"), w1: status("w1") });
      await hook(opts, "b1", "Bash");                                  // the CLI starts the command…
      seen.push({ at: "bashStarted", b1: status("b1"), w1: status("w1") });
      yield { type: "tool_progress", tool_use_id: "b1", tool_name: "Bash", elapsed_time_seconds: 1 };
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "ok", is_error: false }] } };
      await hook(opts, "w1", "Write");                                 // …and only then the write
      seen.push({ at: "writeStarted", b1: status("b1"), w1: status("w1") });
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "written", is_error: false }] } };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Done." }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0 };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "test then write" });
    const hooksOk = !!(e.sdkCalls[0].options.hooks && e.sdkCalls[0].options.hooks.PreToolUse && e.sdkCalls[0].options.hooks.PreToolUse[0].hooks.length === 1);
    const ret = await hook(e.sdkCalls[0], "nope", "X");
    check("R09", "two tools announced together: both 'queued'; the Bash card runs when its PreToolUse fires while the Write stays queued; the Write runs only when ITS hook fires; both finish 'done'", hooksOk && seen[0].b1 === "queued" && seen[0].w1 === "queued" && seen[1].b1 === "running" && seen[1].w1 === "queued" && seen[2].b1 === "done" && seen[2].w1 === "running" && status("b1") === "done" && status("w1") === "done" && JSON.stringify(ret) === "{}", { hooksOk, seen, final: { b1: status("b1"), w1: status("w1") }, ret });
    const started = e.sends.filter((x) => x.name === "session:message-update" && x.data.patch && x.data.patch.status === "running");
    check("R09b", "the card leaves the queue through a message-update carrying startedTs (renderer swaps the waiting dot for the spinner once)", started.length === 2 && started.every((x) => x.data.patch.startedTs), started.map((x) => x.data.patch)); }
  // ---- R10: Stop while one tool runs and another waits → both marked interrupted, nothing left spinning ----
  { const e = environment(); const s = e.make();
    e.control.script = async function* ({ call, opts }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sleep 99" } }, { type: "tool_use", id: "w1", name: "Write", input: { file_path: "C:/proj/a.txt", content: "x" } }] } };
      await opts.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "b1" }, "b1", { signal: new AbortController().signal });
      await new Promise((res) => { call.onInterrupt = res; });
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    const run = e.M.run(s.id, { text: "long" });
    await sleep(60);
    await e.M.interrupt(s.id, "stop");
    await run;
    const cards = toolCards(s);
    check("R10", "Stop marks the running command AND the queued write 'interrupted'", cards.length === 2 && cards.every((c) => c.status === "interrupted"), cards.map((c) => ({ id: c.toolUseId, status: c.status }))); }

  // ---- R11: background agents outlive the main turn — the input stays open until the LAST result ----
  // (Real shapes: task events are SYSTEM messages with subtypes, and task_started arrives AFTER the result.)
  { const e = environment(); const s = e.make(); e.M.resultReleaseGraceMs = 400; const trace = [];
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "probe agent A" } }] } };
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Async agent launched successfully.", is_error: false }] } };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Four agents are running." }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.01 };   // the MAIN turn ends…
      await sleep(200);                                                                                   // …and only then the CLI registers the task
      yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "t1", description: "probe agent A", is_backgrounded: true };
      await sleep(400); trace.push({ at: "afterGrace", promptEnded: call.promptEnded, status: store.getSession(s.id).status });
      // the agent keeps working inside the same process: its tools must still be served
      yield { type: "stream_event", parent_tool_use_id: "t1", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "r1", name: "Read", input: {} } } };
      yield { type: "assistant", parent_tool_use_id: "t1", message: { id: "a3", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "C:/proj/a.ts" } }] } };
      yield { type: "user", parent_tool_use_id: "t1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "file body", is_error: false }] } };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "watch-1", task_type: "watcher", description: "live update watcher", ambient: true }] };   // REPLACE: only an ambient watcher left
      yield { type: "system", subtype: "task_notification", task_id: "bg1", tool_use_id: "t1", status: "completed", summary: "6/6 ok" };
      trace.push({ at: "afterNotification", promptEnded: call.promptEnded });
      yield { type: "system", subtype: "init", session_id: "native-1" };                                  // the CLI wakes the agent for the report
      yield { type: "assistant", message: { id: "a4", content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "ls" } }] } };
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b2", content: "a.txt", is_error: false }] } };
      yield { type: "assistant", message: { id: "a5", content: [{ type: "text", text: "Agent A: 6/6 ok." }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0.002 };
      await call.consumed; trace.push({ at: "afterFinal", promptEnded: call.promptEnded });
    };
    await e.M.run(s.id, { text: "probe with agents" });
    const read = toolCards(s).find((c) => c.toolUseId === "r1"), agent = toolCards(s).find((c) => c.toolUseId === "t1"), ls = toolCards(s).find((c) => c.toolUseId === "b2");
    const note = s.messages.find((m) => m.role === "system" && /background task.*still running/.test(m.text));
    check("R11", "system/task_started ~200 ms after the result keeps the input open (grace); the agent's tools and the wake-up turn's tools are served; the follow-up result ends the run", trace[0].promptEnded === false && trace[0].status === "running" && !!note && trace[1].promptEnded === false && trace[2].promptEnded === true && read && read.status === "done" && read.result === "file body" && agent && agent.background === true && agent.taskId === "bg1" && agent.status === "done" && /6\/6 ok/.test(agent.result) && ls && ls.status === "done" && s.status === "done" && s.messages.filter((m) => m.role === "result").length === 2, { trace, note: note && note.text, read: read && { status: read.status }, agent: agent && { status: agent.status, bg: agent.background, task: agent.taskId, result: agent.result }, ls: ls && ls.status, status: s.status }); }
  // ---- R12: the last task reports and the CLI stays quiet → the input is released after the idle wait ----
  { const e = environment(); const s = e.make(); e.M.taskIdleReleaseMs = 150; e.M.resultReleaseGraceMs = 60; let releasedAt = 0, notifiedAt = 0;
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test", run_in_background: true } }] } };
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "running in the background", is_error: false }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await sleep(20);
      yield { type: "system", subtype: "task_started", task_id: "bg9", tool_use_id: "b1", description: "npm test", is_backgrounded: true };
      await sleep(150);
      notifiedAt = Date.now();
      yield { type: "system", subtype: "task_notification", task_id: "bg9", tool_use_id: "b1", status: "completed", summary: "83 passed" };
      await call.consumed; releasedAt = Date.now();   // no follow-up turn from the CLI
    };
    await e.M.run(s.id, { text: "run tests in the background" });
    const bash = toolCards(s)[0];
    check("R12", "with no follow-up turn after the last task report, the input is released after the idle wait and the run completes", releasedAt - notifiedAt >= 140 && releasedAt - notifiedAt < 2000 && bash && bash.status === "done" && /83 passed/.test(bash.result) && bash.taskId === "bg9" && s.status === "done", { waitMs: releasedAt - notifiedAt, bash: bash && { status: bash.status, result: bash.result, task: bash.taskId }, status: s.status }); }
  // ---- R13: no background work → the input is released after the grace period, not before ----
  { const e = environment(); const s = e.make(); e.M.resultReleaseGraceMs = 250; let resultAt = 0, releasedAt = 0;
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "hi" }] } };
      resultAt = Date.now();
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await call.consumed; releasedAt = Date.now();
    };
    await e.M.run(s.id, { text: "hello" });
    check("R13", "a plain turn releases the input after the grace period (late task_started window) and completes", releasedAt - resultAt >= 230 && releasedAt - resultAt < 1500 && s.status === "done", { waitMs: releasedAt - resultAt, status: s.status }); }

  // ---- R14: a message sent while background agents run joins the live process (no interrupt) ----
  { const e = environment(); const s = e.make(); e.M.resultReleaseGraceMs = 300; let steerRes = null;
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "worker" } }] } };
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Async agent launched successfully.", is_error: false }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await sleep(30);
      yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "t1", description: "worker", is_backgrounded: true };
      const second = await new Promise((res) => { call.onPrompt = (c) => res(c); });                       // the user's message arrives on the SAME stream
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Noted: " + second }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await sleep(60);
      yield { type: "system", subtype: "task_notification", task_id: "bg1", tool_use_id: "t1", status: "completed", summary: "worker done" };
      yield { type: "assistant", message: { id: "a3", content: [{ type: "text", text: "Worker finished." }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    const run = e.M.run(s.id, { text: "launch a worker" });
    await sleep(120);   // main result + task_started are in → the run is waiting on the agent
    steerRes = await e.M.steer(s.id, { text: "also check b.txt" });
    await run;
    const call = e.sdkCalls[0];
    const userMsgs = s.messages.filter((m) => m.role === "user");
    check("R14", "with agents alive, a new message is steered into the live process (one query, second prompt on the same stream, recorded as a steered user message), nothing interrupted, run ends done", steerRes && steerRes.steered === true && steerRes.mode === "queued" && e.sdkCalls.length === 1 && call.prompts.length === 2 && call.prompts[1] === "also check b.txt" && userMsgs.length === 2 && userMsgs[1].steered === true && !s.messages.some((m) => m.role === "system" && /Interrupted|Stopped/.test(m.text)) && s.messages.some((m) => m.role === "assistant" && /Noted: also check b\.txt/.test(m.text)) && call.interrupts === 0 && s.status === "done", { steerRes, queries: e.sdkCalls.length, prompts: call.prompts, users: userMsgs.map((m) => ({ text: m.text, steered: m.steered })), status: s.status }); }
  // ---- R15: without background work, steer is refused so Enter keeps interrupting as before ----
  { const e = environment(); const s = e.make(); let gate;
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "working…" }] } };
      await new Promise((res) => { gate = res; });
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    const run = e.M.run(s.id, { text: "plain" });
    await sleep(60);
    const res = await e.M.steer(s.id, { text: "change of plan" });
    gate(); await run;
    check("R15", "a plain running turn (no background tasks) is not steerable — the renderer falls back to interrupt + run", res && res.steered === false && /interrupt/.test(res.reason) && e.sdkCalls[0].prompts.length === 1 && s.status === "done", res); }

  // ---- R16: SDK messages the chat used to drop — status / api retry / refusal fallback / auto-denial / tool summary / output cap ----
  { const e = environment(); const s = e.make();
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "system", subtype: "status", status: "compacting" };
      yield { type: "system", subtype: "status", status: null };
      yield { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: "overloaded" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.js" } }] } };
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] } };
      yield { type: "tool_use_summary", summary: "Read the config file", preceding_tool_use_ids: ["t1"] };
      yield { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "t2", decision_reason_type: "rule", decision_reason: "deny rule Bash(rm *)", message: "blocked" };
      yield { type: "system", subtype: "model_refusal_fallback", trigger: "refusal", direction: "retry", scope: "session", original_model: "claude-opus-4-8", fallback_model: "claude-sonnet-4-6", request_id: null, api_refusal_category: "safety", content: "retrying" };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Done." }], stop_reason: "max_tokens" }, error: "max_output_tokens" };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0, usage: { input_tokens: 5, output_tokens: 5 } };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "go" });
    const lives = e.sends.filter((x) => x.name === "session:live").map((x) => x.data.live);
    const notes = s.messages.filter((m) => m.role === "system").map((m) => m.text);
    const tool = s.messages.find((m) => m.role === "tool" && m.toolUseId === "t1");
    check("R16", "compacting / retrying become live labels (cleared when output resumes); retry, auto-denial, refusal fallback and the output-token cap are explained once; the model's tool summary lands on its card",
      lives.length === 4 && lives[0] && lives[0].status === "compacting" && lives[1] === null && lives[2] && lives[2].retry && lives[2].retry.attempt === 2 && lives[2].retry.error === "overloaded" && lives[3] === null
      && notes.filter((t) => /being retried \(attempt 2 of 10\)/.test(t)).length === 1 && tool && tool.aiSummary === "Read the config file" && notes.some((t) => /Bash was denied automatically — deny rule/.test(t)) && notes.some((t) => /Safeguards flagged the request \(safety\)/.test(t) && /claude-sonnet-4-6/.test(t)) && notes.some((t) => /output-token limit/.test(t)) && s.status === "done",
      { lives, notes, aiSummary: tool && tool.aiSummary, status: s.status }); }
  // ---- R17: the permission card gets the CLI's prompt sentence; "always allow" hands the suggested rules back ----
  { const e = environment(); const s = e.make();
    const sugg = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "session" }];
    const p = e.M.requestPermission(s.id, "Bash", { command: "npm test" }, undefined, "run-x", { title: "Claude wants to run npm test", displayName: "Bash", decisionReason: "asks by default", suggestions: sugg, agentID: "", toolUseID: "tu1" });
    await new Promise((r) => setImmediate(r));
    const ev = e.sends.find((x) => x.name === "session:permission").data;
    e.M.respondPermission(ev.requestId, { allow: true, always: true });
    const r = await p;
    check("R17", "the card receives title / displayName / reason / canRemember, and an 'always' answer returns the CLI's suggested rules as updatedPermissions", ev.title === "Claude wants to run npm test" && ev.displayName === "Bash" && ev.canRemember === true && ev.decisionReason === "asks by default" && ev.toolUseId === "tu1" && r.behavior === "allow" && Array.isArray(r.updatedPermissions) && r.updatedPermissions[0].destination === "session" && r.updatedInput.command === "npm test", { ev, r });
    const p2 = e.M.requestPermission(s.id, "Bash", { command: "ls" }, undefined, "run-x", { title: "t" });
    await new Promise((r) => setImmediate(r));
    const ev2 = e.sends.filter((x) => x.name === "session:permission").pop().data;
    e.M.respondPermission(ev2.requestId, { allow: true, always: true });
    const r2 = await p2;
    check("R17b", "without suggested rules an 'always' answer is a plain allow (the tab's own auto-allow list handles it)", r2.behavior === "allow" && !("updatedPermissions" in r2) && ev2.canRemember === false, r2); }

  /* ================= Cancellation ownership (session reliability, 2026-09-16) ================= */
  // ---- E01: Stop on an EXTERNAL task aborts it and releases the slot at once; its unregister() then returns false ----
  { const e = environment(); const s = e.make();
    store.updateSession(s.id, { status: "running" });
    const ext = e.M.registerExternalRunner(s.id, { label: "[synthesis]" });
    const dup = e.M.registerExternalRunner(s.id, { label: "[again]" });
    const progressed = ext.progress("Preparing the handoff — call 1");
    const t0 = Date.now();
    const stopped = await e.M.interrupt(s.id, "stop");
    const ms = Date.now() - t0;
    const st = e.sends.filter((x) => x.name === "session:status").map((x) => x.data.status);
    const lives = e.sends.filter((x) => x.name === "session:live").map((x) => x.data.live);
    const runningAfterStop = e.M.isRunning(s.id);
    const owned = ext.unregister();
    const after = e.M.registerExternalRunner(s.id, { label: "[new]" });
    check("E01", "Stop aborts the external task's signal, frees the slot immediately (idle status, live label cleared) and takes under 100 ms; a second registration while busy is refused", stopped === true && dup === null && progressed === true && ext.isAborted() && ext.signal.aborted && runningAfterStop === false && store.getSession(s.id).status === "idle" && st[st.length - 1] === "idle" && ms < 100 && lives.length === 2 && lives[0] && lives[0].status === "preparing" && /call 1/.test(lives[0].label) && lives[1] === null, { stopped, dup, progressed, aborted: ext.isAborted(), runningAfterStop, status: store.getSession(s.id).status, st, lives, ms });
    check("E01b", "after Stop released it, unregister() returns FALSE (the task no longer owns the slot — the caller must not touch the status) and a fresh task can register at once; progress after Stop is ignored", owned === false && after !== null && ext.progress("late") === false && !e.sends.slice(-1).some((x) => x.name === "session:live" && x.data.live && x.data.live.label === "late"), { owned, after: !!after });
    const owned2 = after.unregister();
    check("E01c", "an undisturbed task's unregister() returns TRUE and frees the slot", owned2 === true && !e.M.isRunning(s.id) && e.M.registerExternalRunner(s.id, {}) !== null, { owned2 }); }

  // ---- S01: the run slot is reserved BEFORE async setup; a second send is refused; Stop during setup cancels before dispatch ----
  { const e = environment(); const s = e.make(); let gate, sawSignal = null;
    e.M.consultReviewers = async (_sess, _rv, _text, _pid, signal) => { sawSignal = signal; await new Promise((r) => { gate = r; }); return ""; };
    const run = e.M.run(s.id, { text: "slow setup", reviewers: [{ provider: "anthropic", model: "claude-opus-4-8" }], reviewMode: "before" });
    await sleep(30);
    const busy = e.M.isRunning(s.id);
    let second = null; try { await e.M.run(s.id, { text: "second" }); } catch (err) { second = err.message; }
    const t0 = Date.now();
    await e.M.interrupt(s.id, "stop");
    const stopMs = Date.now() - t0;
    const idleAtStop = store.getSession(s.id).status;
    gate(); await run;
    const notes = s.messages.filter((m) => m.role === "system" && /Stopped/.test(m.text));
    check("S01", "during the (slow) reviewer consultation the tab is running and a second send is refused; Stop sets idle at once and aborts the setup's signal", busy === true && /already running/.test(second || "") && sawSignal && sawSignal.aborted && idleAtStop === "idle" && stopMs < 100, { busy, second, aborted: sawSignal && sawSignal.aborted, idleAtStop, stopMs });
    check("S01b", "the stopped setup never dispatches: no SDK query, one 'Stopped by you.', status idle, slot free", e.sdkCalls.length === 0 && notes.length === 1 && /Stopped by you/.test(notes[0].text) && s.status === "idle" && !e.M.isRunning(s.id), { calls: e.sdkCalls.length, notes: notes.map((n) => n.text), status: s.status });
    e.M.consultReviewers = async () => "";
    const t1 = Date.now();
    await e.M.run(s.id, { text: "next" });
    check("S01c", "the next send starts without waiting out a drain (the reservation's drain settled) and completes", e.sdkCalls.length === 1 && s.status === "done" && Date.now() - t1 < 1500, { calls: e.sdkCalls.length, status: s.status, ms: Date.now() - t1 }); }

  // ---- S02: Stop while the ROLLOVER record is being prepared keeps the native binding (the resume is not lost) ----
  { const e = environment(); const s = e.make(); store.saveSettings({ contextRolloverPct: 90 });
    for (let i = 0; i < 14; i++) s.messages.push({ id: "big" + i, role: i % 2 ? "assistant" : "user", text: `ENTRY-${i} ` + "x".repeat(40000), ts: store.nowISO() });
    store.enforceCap(s); store.flush(s.id);
    history.setBinding(s, "anthropic", { id: "native-keep", syncedIndex: history.lastGlobalIndex(s), ctxUsage: { totalTokens: 190000, maxTokens: 200000, percentage: 95, ts: store.nowISO() } });
    let calls = 0;
    e.M.setSummarizer((_p, _m, _prompt, { signal }) => { calls++; return new Promise((_res, rej) => { signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }); }); });
    const run = e.M.run(s.id, { text: "continue" });
    await sleep(60);
    const liveDuring = e.sends.filter((x) => x.name === "session:live").map((x) => x.data.live);
    const t0 = Date.now();
    await e.M.interrupt(s.id, "stop");
    await run;
    const ms = Date.now() - t0;
    const b = history.bindingFor(s, "anthropic");
    const lives = e.sends.filter((x) => x.name === "session:live").map((x) => x.data.live);
    check("S02", "the summary preparation is under way (live label 'preparing…' with progress) and Stop ends it well inside a second", calls >= 1 && liveDuring.length >= 1 && liveDuring[0] && liveDuring[0].status === "preparing" && /Preparing the conversation record for a fresh native session|Condensing/.test(liveDuring[0].label) && ms < 800 && lives[lives.length - 1] === null, { calls, liveDuring, ms, last: lives[lives.length - 1] });
    check("S02b", "the native thread is STILL bound (the binding is dropped only once the replacement record exists): no SDK query, status idle, resume intact", b.id === "native-keep" && b.ctxUsage && b.ctxUsage.totalTokens === 190000 && e.sdkCalls.length === 0 && s.status === "idle" && !e.M.isRunning(s.id), { binding: { id: b.id, ctx: b.ctxUsage && b.ctxUsage.totalTokens }, calls: e.sdkCalls.length, status: s.status });
    e.M.setSummarizer(async () => "summary"); }

  // ---- S03: the slot is reserved BEFORE the wait for a stopped run's drain — Stop during that wait cancels the queued send ----
  { const e = environment(); const s = e.make(); const marks = {}; let first = true;
    e.control.script = async function* ({ call }) {
      if (first) {
        first = false;
        yield { type: "system", subtype: "init", session_id: "native-1" };
        yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "working…" }] } };
        await new Promise((res) => { call.onInterrupt = res; });
        await sleep(200);   // slow wind-down
        yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
        await call.consumed; marks.firstEnded = Date.now();
        return;
      }
      marks.secondStarted = Date.now();
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "second" }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    const r1 = e.M.run(s.id, { text: "first" });
    await sleep(40);
    await e.M.interrupt(s.id, "replace");
    const r2 = e.M.run(s.id, { text: "second" });   // the queued message: it owns the slot NOW and waits for the drain
    await sleep(20);
    const busyDuringDrain = e.M.isRunning(s.id);
    let third = null; try { await e.M.run(s.id, { text: "third" }); } catch (err) { third = err.message; }
    const t0 = Date.now();
    const stopped = await e.M.interrupt(s.id, "stop");   // Stop while the old run is still draining
    const stopMs = Date.now() - t0;
    const idleAtStop = store.getSession(s.id).status;
    await Promise.all([r1, r2]);
    const notes = s.messages.filter((m) => m.role === "system").map((m) => m.text);
    check("S03", "while the stopped run drains, the queued send already OWNS the slot: the tab is running, a third send is refused, and Stop finds it — idle at once", busyDuringDrain === true && /already running/.test(third || "") && stopped === true && idleAtStop === "idle" && stopMs < 100, { busyDuringDrain, third, stopped, idleAtStop, stopMs });
    check("S03b", "the send stopped during the drain never starts afterwards: ONE SDK query in total, 'Stopped by you.' once, no second reply, status idle, slot free", e.sdkCalls.length === 1 && !marks.secondStarted && notes.filter((t) => /Stopped by you/.test(t)).length === 1 && !s.messages.some((m) => m.role === "assistant" && m.text === "second") && s.status === "idle" && !e.M.isRunning(s.id), { calls: e.sdkCalls.length, marks, notes, status: s.status }); }

  // ---- S04: a stopped run's late live status never relabels the tab its replacement owns ----
  { const e = environment(); const s = e.make(); let first = true, releaseOld = null;
    e.control.script = async function* ({ call }) {
      if (first) {
        first = false;
        yield { type: "system", subtype: "init", session_id: "native-1" };
        yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "working…" }] } };
        await new Promise((res) => { call.onInterrupt = res; });
        await new Promise((res) => { releaseOld = res; });
        yield { type: "system", subtype: "status", status: "compacting" };   // the OLD process, still winding down, reports a phase
        yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], num_turns: 1, total_cost_usd: 0 };
        await call.consumed;
        return;
      }
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "second" }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    const r1 = e.M.run(s.id, { text: "first" });
    await sleep(40);
    await e.M.interrupt(s.id, "replace");
    const r2 = e.M.run(s.id, { text: "second" });   // owns the slot now (waiting for the drain)
    await sleep(20);
    const before = e.sends.filter((x) => x.name === "session:live").length;
    releaseOld();
    await Promise.all([r1, r2]);
    const lateLives = e.sends.filter((x) => x.name === "session:live").slice(before).map((x) => x.data.live);
    check("S04", "the old run's 'compacting' status arrives while the replacement owns the slot: no live label is emitted for it, and the replacement completes normally", !lateLives.some((l) => l && l.status === "compacting") && s.messages.some((m) => m.role === "assistant" && m.text === "second") && s.status === "done", { lateLives, status: s.status }); }

  /* ================= Headless Claude (summariser / planner) lifecycle ================= */
  const settingsFor = () => store.getSettings();
  // ---- H01: the headless CLI is spawned by the app (pid known), the input stays open past an early zero-turn result, only OUR result ends it ----
  { const e = environment(); const order = [];
    e.control.script = async function* ({ call, spawn }) {
      spawn();
      yield { type: "system", subtype: "init", session_id: "h-1" };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 0, duration_ms: 40, total_cost_usd: 0 };   // the CLI closing something else
      await sleep(20); order.push({ at: "afterEarly", promptEnded: call.promptEnded });
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "Synthetic summary." }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Synthetic summary.", usage: { input_tokens: 9, output_tokens: 3 }, total_cost_usd: 0 };
      await call.consumed; order.push({ at: "afterFinal", promptEnded: call.promptEnded });
    };
    let usage = null;
    const out = await e.M.runHeadlessAnthropic({ settings: settingsFor(), model: "claude-opus-4-8", thinking: "low", system: "s", prompt: "condense this", cwd: HOME, onResult: (r) => { usage = r; } });
    const sp = e.spawns.find((x) => x.command === "claude");
    check("H01", "headless: our spawner is used (pipes, windowsHide, forwarded signal), the zero-turn early result is ignored while the input stays open, and OUR result ends the call with its text and usage", out === "Synthetic summary." && sp && Array.isArray(sp.options.stdio) && sp.options.windowsHide === true && order[0] && order[0].promptEnded === false && order[1] && order[1].promptEnded === true && usage && usage.usage.input_tokens === 9 && e.kills.length === 0, { out, order, usage, spawned: !!sp, kills: e.kills }); }
  // ---- H02: cancellation is GRACEFUL-FIRST against an uncooperative transport — the caller returns at once, the CLI is asked to end its turn, the kill is the bounded fallback ----
  { const e = environment(); const killed = []; e.M.killProcessTree = (r) => killed.push(r && r.pid); e.M.interruptGraceMs = 120;
    e.control.script = async function* ({ spawn }) {
      spawn();
      yield { type: "system", subtype: "init", session_id: "h-2" };
      await new Promise(() => {});   // ignores the interrupt AND the abort forever
    };
    const ac = new AbortController();
    const p = e.M.runHeadlessAnthropic({ settings: settingsFor(), model: "claude-opus-4-8", thinking: "low", system: "s", prompt: "hang", cwd: HOME, signal: ac.signal });
    await sleep(40);
    const t0 = Date.now(); ac.abort();
    let err = null; try { await p; } catch (x) { err = x; }
    const ms = Date.now() - t0;
    const call = e.sdkCalls[0];
    await sleep(5);
    const early = { interrupts: call.interrupts, aborted: call.options.abortController.signal.aborted, killed: killed.slice(), promptEnded: call.promptEnded };
    await sleep(50);
    const mid = { aborted: call.options.abortController.signal.aborted, killed: killed.slice() };
    await sleep(150);
    const pid = e.spawns.find((x) => x.command === "claude").child.pid;
    check("H02", "abort → AbortError within 100 ms although the transport never yields; the CLI is asked to end its turn FIRST (query.interrupt, input released) — no SDK abort and no kill inside the grace period", err && err.name === "AbortError" && ms < 100 && early.interrupts === 1 && early.aborted === false && early.killed.length === 0 && early.promptEnded === true && mid.aborted === false && mid.killed.length === 0, { err: err && err.name, ms, early, mid });
    check("H02b", "a CLI that ignores the interrupt is torn down after the grace period: SDK abort + process-tree kill of its known pid", call.options.abortController.signal.aborted === true && killed.includes(pid), { aborted: call.options.abortController.signal.aborted, killed, pid }); }
  // ---- H05: a CLI that winds down after the interrupt is left alone — no SDK abort, no taskkill ----
  { const e = environment(); e.M.interruptGraceMs = 100; let exited = false;
    e.control.script = async function* ({ call, spawn }) {
      const child = spawn();
      yield { type: "system", subtype: "init", session_id: "h-5" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }] } };
      await new Promise((res) => { call.onInterrupt = res; });
      await sleep(20);   // the CLI cancels the command and ends the turn …
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], num_turns: 1, total_cost_usd: 0 };
      child.emit("exit", 0); exited = true;   // … and exits on its own
    };
    const ac = new AbortController();
    const p = e.M.runHeadlessAnthropic({ settings: settingsFor(), model: "claude-opus-4-8", thinking: "low", system: "s", prompt: "work", cwd: HOME, allowTools: true, signal: ac.signal });
    await sleep(40);
    ac.abort();
    let err = null; try { await p; } catch (x) { err = x; }
    await sleep(220);
    const call = e.sdkCalls[0];
    check("H05", "the cancelled allow-tools call returns AbortError at once; the CLI ends its own turn and exits, so the grace fallback kills nothing and never aborts the SDK", err && err.name === "AbortError" && call.interrupts === 1 && exited && e.kills.length === 0 && call.options.abortController.signal.aborted === false, { err: err && err.name, interrupts: call.interrupts, exited, kills: e.kills, aborted: call.options.abortController.signal.aborted }); }
  // ---- H06: an abort or a timeout that lands during the SDK / CLI-path setup dispatches NO query ----
  { const e = environment(); e.M.resolveCli = async () => { await sleep(120); return "claude"; };
    const ac = new AbortController();
    const p1 = e.M.runHeadlessAnthropic({ settings: settingsFor(), model: "claude-opus-4-8", thinking: "low", system: "s", prompt: "p", cwd: HOME, signal: ac.signal });
    await sleep(10); const t0 = Date.now(); ac.abort();
    let err1 = null; try { await p1; } catch (x) { err1 = x; }
    const ms1 = Date.now() - t0;
    const t1 = Date.now(); let err2 = null;
    try { await e.M.runHeadlessAnthropic({ settings: settingsFor(), model: "claude-opus-4-8", thinking: "low", system: "s", prompt: "p", cwd: HOME, timeoutMs: 15 }); } catch (x) { err2 = x; }
    const ms2 = Date.now() - t1;
    await sleep(150);
    check("H06", "a cancel (or a timeout) while the SDK / CLI path is still being set up returns AT ONCE (the pending setup is not awaited) with its own error and never dispatches a query late", err1 && err1.name === "AbortError" && ms1 < 60 && err2 && err2.timeout === true && ms2 < 80 && /did not answer within/.test(err2.message) && e.sdkCalls.length === 0 && e.kills.length === 0, { err1: err1 && err1.name, ms1, err2: err2 && err2.message, ms2, calls: e.sdkCalls.length }); }
  // ---- R18: a live state with nothing to show is null on the runner too (sessions:run-state reads it) ----
  { const e = environment(); const s = e.make(); const r = { id: "run-live", running: true };
    e.M.runners.set(s.id, r);
    e.M.setLive(s, r, { status: "preparing", label: "Preparing the record" });
    const shown = r.live && r.live.status;
    e.M.setLive(s, r, { status: null, label: null });
    const lives = e.sends.filter((x) => x.name === "session:live").map((x) => x.data.live);
    e.M.setLive(s, r, { status: null });   // nothing to show and nothing shown: no event
    e.M.runners.delete(s.id);
    check("R18", "setLive keeps a real state on the runner, clears it to NULL (not an all-null object) when nothing is left to show, and emits nothing for null → null", shown === "preparing" && r.live === null && lives.length === 2 && lives[0] && lives[0].status === "preparing" && lives[1] === null && e.sends.filter((x) => x.name === "session:live").length === 2, { shown, live: r.live, lives }); }
  // ---- H03: a result without assistant text falls back to the result's own text; an error result throws ----
  { const e = environment();
    e.control.script = async function* ({ call }) { yield { type: "system", subtype: "init", session_id: "h-3" }; yield { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "From the result frame.", total_cost_usd: 0 }; await call.consumed; };
    const out = await e.M.runHeadlessAnthropic({ settings: settingsFor(), model: "claude-opus-4-8", thinking: "low", system: "s", prompt: "p", cwd: HOME });
    e.control.script = async function* ({ call }) { yield { type: "system", subtype: "init", session_id: "h-3" }; yield { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, errors: ["prompt is too long: 300000 tokens"], total_cost_usd: 0 }; await call.consumed; };
    let err = null; try { await e.M.runHeadlessAnthropic({ settings: settingsFor(), model: "claude-opus-4-8", thinking: "low", system: "s", prompt: "p", cwd: HOME }); } catch (x) { err = x; }
    await sleep(5);   // the fake's prompt reader observes the closed feed one microtask after the rejection
    check("H03", "the result frame's text is the answer when no assistant text streamed; an error result is thrown (prompt-too-long classified) and the call's input is released", out === "From the result frame." && err && err.promptTooLong === true && e.sdkCalls.every((c) => c.promptEnded), { out, err: err && err.message, ended: e.sdkCalls.map((c) => c.promptEnded) }); }
  // ---- H04: an unresponsive summary call is bounded by settings.summaryCallTimeoutMs; the failed call counts ----
  { const e = environment(); const s = e.make(); store.saveSettings({ summaryCallTimeoutMs: 80 });
    e.M.setSummarizer(() => new Promise(() => {}));   // never answers
    const job = { calls: 0 };
    const t0 = Date.now(); let err = null;
    try { await e.M.summarizeText(s, "anthropic", "claude-opus-4-8", "condense", { job }); } catch (x) { err = x; }
    const ms = Date.now() - t0;
    store.saveSettings({ summaryCallTimeoutMs: 0 });
    check("H04", "a summary call that never answers is cancelled at the configured timeout with a plain sentence (checkpoints kept), counted as one call", err && err.timeout === true && /did not answer within/.test(err.message) && /checkpoint/.test(err.message) && ms >= 70 && ms < 1000 && job.calls === 1, { err: err && err.message, ms, calls: job.calls }); }

  clearTimeout(watchdog);
  console.log(`Run control: ${pass} passed, ${failN} failed`);
  if (failures.length) console.log("Failures:\n  " + failures.join("\n  "));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failN ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
