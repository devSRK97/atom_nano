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
 * The ORIGINAL claude.js runs in a VM with a controllable fake SDK and a fake child_process;
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

const store = require(path.join(ROOT, "src/main/store.js"));
const history = require(path.join(ROOT, "src/main/history.js"));
store.loadSettings();
store.saveSettings({ llmProvider: "anthropic" });
const src = fs.readFileSync(path.join(ROOT, "src/main/claude.js"), "utf8");

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
    const consumed = (async () => { const got = []; for await (const m of opts.prompt) got.push(m.message.content); call.promptEnded = true; call.promptEndedAt = Date.now(); call.promptText = got.length === 1 ? got[0] : got; return got; })();
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
  const providers = { get: () => ({ label: "anthropic", models: [{ id: "claude-opus-4-8", ctx: 200000, ctx1m: true }], defaultModel: "claude-opus-4-8", defaultReasoning: "low", primary: "sdk" }), context1M: () => true, resolveOpenAIModelStrict: (id) => ({ model: id }), resolveOpenAIModel: (id) => ({ model: id }), openaiEffortStrict: (e) => ({ effort: e || "low" }), openaiEffort: () => "low" };
  const req = (name) => {
    const map = { path, fs, os, crypto: require("crypto"), child_process: fakeCp, "./store": store, "./history": history, "./auth": {}, "./attachments": { persistAll: (a) => a, light: (a) => a, readBase64: () => "" }, "./tool-args": require(path.join(ROOT, "src/main/tool-args.js")), "./providers": providers, "./codex-appserver": { ctxKeyOf: () => "login", run: async () => ({ ok: true, text: "" }), injectItems: async () => ({ ok: true }), interrupt: async () => true, steer: async () => ({ ok: true }) }, "./codex": { run: async () => ({ ok: true, text: "" }) }, "./codex-cards": { unwrapCmd: (x) => x, parseDiff: () => ({ oldText: "", newText: "", added: 0, removed: 0 }), classifyCmd: () => null }, "./council": { reviewerRun: async () => ({ ok: true, text: "" }), label: () => "Reviewer" }, "./customApi": { getEndpoint: () => null, call: async () => ({ ok: true, text: "" }) } };
    if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
    throw new Error("Unexpected manager dependency " + name);
  };
  const mod = { exports: {} };
  const scope = { module: mod, exports: mod.exports, require: req, __filename: path.join(ROOT, "src/main/claude.js"), __dirname: path.join(ROOT, "src/main"), process, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, URL, TextEncoder, TextDecoder, console: { log() {}, warn() {}, error() {} }, __auditSdk: sdk };
  vm.runInNewContext(src + "\nsdkPromise = Promise.resolve(__auditSdk);", scope, { filename: "claude.js" });
  const M = mod.exports;
  M.send = (name, data) => sends.push({ name, data, t: Date.now() });
  M.buildEnv = () => ({}); M.resolveCli = async () => "claude"; M.composeMcp = () => ({}); M.registerModel = () => {}; M.scheduleRetry = () => {};
  M.setSummarizer(async () => "summary");
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

  clearTimeout(watchdog);
  console.log(`Run control: ${pass} passed, ${failN} failed`);
  if (failures.length) console.log("Failures:\n  " + failures.join("\n  "));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failN ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
