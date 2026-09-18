"use strict";
/* Sub-agents + context regression suite — DESIRED behaviour:
 *   · CPU governor: slots follow free cores (user max is the ceiling, 1–20), a saturated machine
 *     holds new agents (bounded) then denies with a plain sentence, priority throttling engages
 *     after sustained load and releases after it cools;
 *   · registry: every Task call is numbered when announced, follows the SDK's task lifecycle
 *     (started / progress / notification), ends with the run, never resurrects;
 *   · runner: the cap reaches the CLI as CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, a Task call
 *     reserves a slot through canUseTool, the card carries the agent number;
 *   · context: the CLI's own usage measurement is captured after a turn; a nearly-full thread
 *     rolls over to a fresh native session with the budgeted record BEFORE the request fails;
 *     a "prompt is too long" teaches the real window (used by budgets and the CLI's compaction);
 *     the rolling digest is prepared in the background without adding chat cards.
 *   · role skills across a rollover: the fresh native session gets the procedures in full again, its
 *     init commits the delivery hash; a rollover that fails before acceptance keeps the old thread's cache.
 * The ORIGINAL session modules run in a VM with a scripted fake SDK; store / history / agents / skills are
 * real on an isolated data home. No network, no model calls.  Run: node scripts/test-agents.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");
const ROOT = path.join(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-agents-"));
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
const A = require(path.join(ROOT, "src/main/agents/subagents.js"));
const skillsMod = require(path.join(ROOT, "src/main/agents/skills.js"));   // real per-project skills store under the isolated HOME (a controlled dependency, not a swallowed one)
store.loadSettings();
store.saveSettings({ llmProvider: "anthropic", modeNote: false });   // modeNote off: these suites assert bare solo turns (the note has its own checks, test-workflow W29)
const { loadSessionInVm } = require("./lib/session-vm");

/* ---------------- governor + registry: pure ---------------- */
async function pureChecks() {
  // G01 slots from cores and load
  let settings = { subAgentsMax: 20, agentCoresPerAgent: "auto", agentCpuGovernor: true };
  const g = new A.CpuGovernor({ cores: 16, settings: () => settings, sampler: () => ({ idle: 0, total: 0 }) });
  g.ema = 0;
  check("G01", "idle 16-core machine: auto = 2 cores per agent, 2 reserved → 7 slots (below the user's 20)", g.compute().allowedNow === 7 && g.compute().coresPerAgent === 2 && g.compute().reserve === 2, g.compute());
  g.ema = 90;
  check("G01b", "a saturated machine still allows ONE agent (never zero)", g.compute().allowedNow === 1 && g.compute().freeCores === 0, g.compute());
  settings = { subAgentsMax: 3, agentCoresPerAgent: 1, agentCpuGovernor: true }; g.ema = 0;
  check("G01c", "the user's max is the ceiling (1 core per agent would allow 14)", g.compute().allowedNow === 3, g.compute());
  settings = { subAgentsMax: 12, agentCpuGovernor: false }; g.ema = 100;
  check("G01d", "governor off → the user's max regardless of load", g.compute().allowedNow === 12 && g.compute().freeCores === null, g.compute());
  settings = { subAgentsMax: 12 }; g.ema = 100;
  check("G01f", "the CPU gate is OPT-IN: without the setting the user's cap is the limit on a saturated machine too, and the snapshot reports the free slots (user decision 2026-09-17)", g.compute().governor === false && g.compute().allowedNow === 12 && g.snapshot().freeSlots === 12, g.compute());
  check("G01e", "the cap clamps to 1–20", A.clampMax(0) === 3 && A.clampMax(99) === 20 && A.clampMax("7") === 7 && A.clampMax(undefined) === 3);
  // G02 acquire / wait / deny / release
  settings = { subAgentsMax: 20, agentCoresPerAgent: 2, agentCpuGovernor: true }; g.ema = 90;   // 1 slot
  const a1 = await g.acquire("t1", { waitMs: 50 });
  const t0 = Date.now(); const a2 = await g.acquire("t2", { waitMs: 60 }); const waited = Date.now() - t0;
  check("G02", "one slot: the first agent is granted, the second waits the bounded time then is denied with the governor's sentence", a1.ok === true && a2.ok === false && a2.reason === "timeout" && waited >= 55 && /CPU governor allows 1 concurrent agent/.test(g.denyMessage(a2.snapshot)) && /Do not retry in a loop/.test(g.denyMessage(a2.snapshot)), { a1, a2: a2.reason, waited });
  const p3 = g.acquire("t3", { waitMs: 500 });
  await sleep(10); g.release("t1");
  const a3 = await p3;
  check("G02b", "a waiting agent is granted the moment a slot is released", a3.ok === true && a3.waited === true && a3.waitedMs < 400 && g.holds.size === 1 && g.holds.has("t3"), a3);
  const ac = new AbortController(); const p4 = g.acquire("t4", { waitMs: 5000, signal: ac.signal }); ac.abort(); const a4 = await p4;
  check("G02c", "a stopped run ends the wait (aborted, not denied)", a4.ok === false && a4.reason === "aborted", a4);
  g.releaseAll();
  // G03 throttle hysteresis
  let throttleEvents = [];
  const g3 = new A.CpuGovernor({ cores: 8, settings: () => ({ subAgentsMax: 4, agentCpuGovernor: true }), sampler: () => ({ idle: 0, total: 0 }), onThrottle: (t) => throttleEvents.push(t) });
  g3.holds.set("x", { since: 0 });
  const feed = (busy) => { g3.busy = busy; g3.ema = busy; g3.samples.push(busy); g3.updateThrottle(); };
  feed(95); feed(95);
  const before = throttleEvents.slice();
  feed(95);
  const afterHot = throttleEvents.slice();
  feed(60); feed(60); feed(60);
  check("G03", "priority throttling engages after three saturated samples and releases after three cool ones", before.length === 0 && afterHot.join() === "true" && throttleEvents.join() === "true,false" && g3.throttled === false, throttleEvents);
  g3.holds.clear(); feed(95); feed(95); feed(95);
  check("G03b", "no throttling when no agent is running (a build alone is not ours to slow)", throttleEvents.join() === "true,false", throttleEvents);
  // G04 registry
  const s = { id: "s", agents: [], agentSeq: 0 };
  const r1 = A.announce(s, { toolUseId: "tu1", input: { description: "Read the docs", prompt: "Read every markdown file", subagent_type: "worker", run_in_background: true }, runId: "run-1" });
  const r2 = A.announce(s, { toolUseId: "tu2", input: { description: "Run tests" }, runId: "run-1" });
  const again = A.announce(s, { toolUseId: "tu1", input: { description: "Read the docs" }, runId: "run-1" });
  check("G04", "agents are numbered once when announced; a repeat announcement fills fields without renumbering", r1.agent.n === 1 && r2.agent.n === 2 && again.created === false && again.agent === r1.agent && s.agentSeq === 2 && r1.agent.background === true && r1.agent.type === "worker" && r1.agent.prompt === "Read every markdown file", { n1: r1.agent.n, n2: r2.agent.n, seq: s.agentSeq });
  A.patch(r1.agent, { status: "running", taskId: "task-a" }); A.patch(r1.agent, { toolUses: 3, tokens: 500 }); A.patch(r1.agent, { toolUses: 2 });
  A.patch(r1.agent, { status: "done", result: "All read." }); const rez = A.patch(r1.agent, { status: "running" });
  check("G04b", "usage counters never go backwards; a finished agent never returns to running; timings are filled", r1.agent.toolUses === 3 && r1.agent.status === "done" && rez === false && !!r1.agent.startedTs && !!r1.agent.endedTs, { toolUses: r1.agent.toolUses, status: r1.agent.status });
  const closed = A.closeRun(s, "run-1", "interrupted");
  check("G04c", "closing a run ends only its live agents", closed.length === 1 && closed[0].n === 2 && r2.agent.status === "interrupted" && /Stopped before/.test(r2.agent.result), closed.map((a) => a.n));
  check("G04d", "the backgrounded-launch placeholder is recognised", A.looksBackgrounded("Async agent launched successfully. agentId: a1 — running in the background") && !A.looksBackgrounded("All files read; 3 findings."));
  // G04e an agent that ends without its own report keeps what it was last doing (user request 2026-09-17: "when clearing keep last activity text")
  const s5 = { id: "s5", agents: [], agentSeq: 0 };
  const w1 = A.announce(s5, { toolUseId: "w1", input: { description: "Trace" }, runId: "run-5", status: "running" }); A.patch(w1.agent, { progress: "Tracing recovery stop in generateEntry.ts", lastTool: "Grep" });
  const w2 = A.announce(s5, { toolUseId: "w2", input: { description: "Lint" }, runId: "run-5", status: "running" }); A.patch(w2.agent, { lastTool: "Bash" });
  const w3 = A.announce(s5, { toolUseId: "w3", input: { description: "Done one" }, runId: "run-5", status: "running" }); A.patch(w3.agent, { result: "Its own report." });
  A.closeRun(s5, "run-5", "interrupted", "The run paused.");
  check("G04e", "closing keeps the last activity: the progress blurb (else the last tool) follows the reason; an agent's own report is never replaced", w1.agent.result === "The run paused. Last activity: Tracing recovery stop in generateEntry.ts" && w2.agent.result === "The run paused. Last tool: Bash" && w3.agent.result === "Its own report." && w1.agent.progress === "Tracing recovery stop in generateEntry.ts", { w1: w1.agent.result, w2: w2.agent.result, w3: w3.agent.result });
}

/* ---------------- runner integration (VM, fake SDK) ---------------- */
function fakeChild(pid) { const c = new EventEmitter(); c.pid = pid; c.stdin = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true; return c; }
function environment({ ctx = 200000, ctx1m = false } = {}) {
  const sends = [], sdkCalls = [];
  const control = { script: null };
  const fakeCp = { spawn: (command, args, options) => { const child = fakeChild(4000 + sdkCalls.length); if (command === "taskkill") process.nextTick(() => child.emit("exit", 0)); return child; } };
  const sdk = { query(opts) {
    const call = { prompt: opts.prompt, options: opts.options, prompts: [], promptEnded: false }; sdkCalls.push(call);
    call.consumed = (async () => { for await (const m of opts.prompt) { call.prompts.push(m.message.content); } call.promptEnded = true; return call.prompts; })();
    const gen = (control.script || defaultScript)({ opts, call });
    const q = { [Symbol.asyncIterator]() { return gen; }, next: (...a) => gen.next(...a), return: (...a) => gen.return(...a), throw: (...a) => gen.throw(...a), interrupt: async () => ({}), setPermissionMode: async () => {}, setModel: async () => {},
      getContextUsage: async () => call.ctxUsage || null, stopTask: async (id) => { call.stopped = (call.stopped || []).concat(id); } };
    call.q = q; return q;
  } };
  async function* defaultScript({ call }) {
    await sleep(5);
    yield { type: "system", subtype: "init", session_id: call.options.resume || "native-1", model: "claude-opus-4-8" };
    yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "Synthetic reply." }] } };
    yield { type: "result", subtype: "success", is_error: false, session_id: call.options.resume || "native-1", num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };
    await call.consumed;
  }
  const providers = { get: () => ({ label: "anthropic", models: [{ id: "claude-opus-4-8", ctx, ctx1m }], defaultModel: "claude-opus-4-8", defaultReasoning: "low", primary: "sdk" }), context1M: () => ctx1m, resolveOpenAIModelStrict: (id) => ({ model: id }), resolveOpenAIModel: (id) => ({ model: id }), openaiEffortStrict: (e) => ({ effort: e || "low" }), openaiEffort: () => "low" };
  const map = { path, fs, os, crypto: require("crypto"), child_process: fakeCp, "./store": store, "./history": history, "./cli-auth": {}, "./attachments": { persistAll: (a) => a, light: (a) => a, readBase64: () => "" }, "./tool-args": require(path.join(ROOT, "src/main/session/tool-args.js")), "./subagents": A, "./skills": skillsMod, "./catalog": providers, "./codex-appserver": { ctxKeyOf: () => "login", run: async () => ({ ok: true, text: "" }), injectItems: async () => ({ ok: true }), interrupt: async () => true, steer: async () => ({ ok: true }) }, "./codex-exec": { run: async () => ({ ok: true, text: "" }) }, "./codex-cards": { unwrapCmd: (x) => x, parseDiff: () => ({ oldText: "", newText: "", added: 0, removed: 0 }), classifyCmd: () => null }, "./council": { reviewerRun: async () => ({ ok: true, text: "" }), label: () => "Reviewer" }, "./custom-api": { getEndpoint: () => null, call: async () => ({ ok: true, text: "" }) } };
  const { M } = loadSessionInVm({ deps: map, sdk });
  M.send = (name, data) => sends.push({ name, data, t: Date.now() });
  M.buildEnv = () => ({}); M.resolveCli = async () => "claude"; M.composeMcp = () => ({}); M.registerModel = () => {}; M.scheduleRetry = () => {};
  const summaryCalls = [];
  M.setSummarizer(async (p, model, prompt) => { summaryCalls.push({ p, model, len: prompt.length }); return "Digest of the older conversation."; });
  M.resultReleaseGraceMs = 40;
  // Full access: the slot gate is what these checks exercise — a permission prompt would wait for a user who is not there.
  // `parentId` + `role` make a workflow ROLE child (the only sessions whose skill selection takes effect).
  const make = (opts = {}) => { const v = store.createSession({ cwd: HOME, name: "agents", model: "claude-opus-4-8", thinking: "low", oneM: opts.oneM, permissionMode: "bypassPermissions", selectedSkills: opts.selectedSkills, parentId: opts.parentId, role: opts.role }); const s = store.getSession(v.id); if (opts.messages) { s.messages.push(...opts.messages); store.enforceCap(s); } store.flush(v.id); return s; };
  return { M, make, sends, sdkCalls, control, summaryCalls, sdk };
}

async function runnerChecks() {
  // A01 the cap reaches the CLI; a Task call reserves a slot; the card and registry carry the number; lifecycle follows the task events
  { const e = environment(); const s = e.make();
    A.governor.configure({ settings: () => ({ subAgentsMax: 5, agentCoresPerAgent: 1, agentCpuGovernor: true }), cores: 8, sampler: () => ({ idle: 0, total: 0 }) }); A.governor.ema = 0; A.governor.releaseAll();
    let gate = null;
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "Task", input: {} } } };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "tu1", name: "Task", input: { description: "Review auth", prompt: "Review src/auth for bugs", subagent_type: "worker", run_in_background: true } }] } };
      gate = await call.options.canUseTool("Task", { description: "Review auth" }, { toolUseID: "tu1", signal: new AbortController().signal });
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Async agent launched successfully. agentId: ag1", is_error: false }] } };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "LAUNCHED" }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 2 } };
      await sleep(15);
      yield { type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "tu1", description: "Review auth", subagent_type: "worker", is_backgrounded: true, task_type: "local_agent", spawn_depth: 1 };
      yield { type: "system", subtype: "task_progress", task_id: "task-1", tool_use_id: "tu1", description: "Review auth", subagent_type: "worker", usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 3000 }, last_tool_name: "Grep", summary: "Reading auth.js" };
      yield { type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: "tu1", status: "completed", summary: "Two issues found.", output_file: "", usage: { total_tokens: 2400, tool_uses: 7, duration_ms: 6000 } };
      yield { type: "assistant", message: { id: "a3", content: [{ type: "text", text: "Agent done." }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0, usage: { input_tokens: 20, output_tokens: 2 } };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "review", subAgents: true, subAgentsMax: 5 });
    const call = e.sdkCalls[0];
    const card = s.messages.find((m) => m.role === "tool" && m.toolUseId === "tu1");
    const list = e.M.agentsList(s.id);
    const ag = list.agents[0];
    const updates = e.sends.filter((x) => x.name === "agents:update");
    check("A01", "the CLI cap is CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=5; the Task call was granted a slot; the card and the registry carry agent #1", call.options.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS === "5" && call.options.agents && call.options.agents.worker && gate && gate.behavior === "allow" && card && card.agentN === 1 && ag && ag.n === 1 && ag.description === "Review auth" && ag.prompt === "Review src/auth for bugs" && ag.type === "worker", { env: call.options.env, gate: gate && gate.behavior, agentN: card && card.agentN, ag: ag && { n: ag.n, description: ag.description } });
    check("A01b", "the record follows the task lifecycle: background, task id, progress blurb + last tool + usage, then done with the summary; the slot is released", ag.background === true && ag.taskId === "task-1" && ag.status === "done" && ag.result === "Two issues found." && ag.toolUses === 7 && ag.tokens === 2400 && ag.lastTool === "Grep" && ag.progress === "Reading auth.js" && !!ag.startedTs && !!ag.endedTs && A.governor.holds.size === 0 && updates.length >= 4 && s.status === "done", { ag: { status: ag.status, toolUses: ag.toolUses, tokens: ag.tokens, lastTool: ag.lastTool, progress: ag.progress }, holds: A.governor.holds.size, updates: updates.length, status: s.status });
    const hooks = call.options.hooks || {};
    check("A01c", "the runner registers SubagentStart / SubagentStop hooks next to PreToolUse", Array.isArray(hooks.SubagentStart) && Array.isArray(hooks.SubagentStop) && Array.isArray(hooks.PreToolUse), Object.keys(hooks));
    // hooks feed the registry: SubagentStart binds the agent id, PreToolUse inside it counts tools
    const s2 = e.make(); const runner2 = { id: "run-x", promptMessageId: null };
    const ann = e.M.agentAnnounce(s2, runner2, { toolUseId: "tuX", input: { description: "Hook test" }, status: "queued" });
    e.M.agentHookStart(s2, runner2, { agent_id: "agent-77", agent_type: "worker" });
    e.M.agentToolUse(s2, runner2, { agent_id: "agent-77", tool_name: "Read", tool_use_id: "in1" });
    e.M.agentToolUse(s2, runner2, { agent_id: "agent-77", tool_name: "Edit", tool_use_id: "in2" });
    e.M.agentHookStop(s2, runner2, { agent_id: "agent-77", last_assistant_message: "Fixed the bug." });
    check("A01d", "SubagentStart binds the CLI's agent id to the newest unbound agent, PreToolUse counts its tools, SubagentStop ends a foreground agent with its last message", ann.agent.agentId === "agent-77" && ann.agent.toolUses === 2 && ann.agent.lastTool === "Edit" && ann.agent.status === "done" && ann.agent.result === "Fixed the bug." && e.M.agentNumberFor(s2.id, "agent-77") === 1, { a: { agentId: ann.agent.agentId, toolUses: ann.agent.toolUses, status: ann.agent.status } }); }

  // A02 with the CPU gate ON ("Yield to heavy processes" — opt-in since 2026-09-17), a saturated machine holds the Task call until a slot frees
  { const e = environment(); const s = e.make();
    store.saveSettings({ agentCpuGovernor: true, agentCoresPerAgent: 2 });   // the run's governor reads the settings (governorSettings), so the gate is switched on there
    A.governor.configure({ settings: () => ({ subAgentsMax: 20, agentCoresPerAgent: 2, agentCpuGovernor: true }), cores: 8, sampler: () => ({ idle: 0, total: 0 }) }); A.governor.ema = 95; A.governor.releaseAll();
    A.governor.holds.set("other-agent", { since: Date.now() });   // one agent already running elsewhere → 0 free slots
    const saveWait = require(path.join(ROOT, "src/main/session/subagents.js")).AGENT_SLOT_WAIT_MS;
    let gate = null;
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "tu9", name: "Task", input: { description: "Heavy job" } }] } };
      const ac = new AbortController(); setTimeout(() => ac.abort(), 80);   // the harness cuts the wait short via the abort signal path
      gate = await Promise.race([call.options.canUseTool("Task", { description: "Heavy job" }, { toolUseID: "tu9", signal: ac.signal }), sleep(600).then(() => ({ behavior: "timeout" }))]);
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu9", content: "denied", is_error: true }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    const runP = e.M.run(s.id, { text: "heavy", subAgents: true, subAgentsMax: 20 });
    await sleep(120);
    const waiting = e.M.agentsList(s.id).agents[0];
    const waitingStatus = waiting && waiting.status;
    A.governor.release("other-agent");   // a slot frees → the held call proceeds
    await runP;
    check("A02", "with no free slot the Task call waits (agent shown as waiting) and is granted when another agent finishes", waitingStatus === "waiting" && gate && gate.behavior === "allow" && e.M.agentsList(s.id).agents[0].gate === "waited", { waitingStatus, gate, saveWait });
    store.saveSettings({ agentCpuGovernor: false, agentCoresPerAgent: "auto" });
    A.governor.releaseAll(); }

  // A03 context usage is captured after the turn; a nearly-full thread rolls over BEFORE the next request
  { const e = environment(); store.saveSettings({ contextRolloverPct: 90 }); const s = e.make();
    e.control.script = async function* ({ call }) {
      call.ctxUsage = { totalTokens: 176000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 88, model: "claude-opus-4-8" };
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "First reply." }] } };
      yield { type: "result", subtype: "success", is_error: false, session_id: "native-1", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 170000, output_tokens: 50 } };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "first" });
    await sleep(30);
    const b = history.bindingFor(s, "anthropic");
    const info = e.M.contextInfo(s.id);
    check("A03", "the CLI's context measurement is captured after the turn and reported (88 % measured of a 200K window)", b.ctxUsage && b.ctxUsage.totalTokens === 176000 && info.pct === 88 && info.source === "measured" && info.window === 200000 && e.sends.some((x) => x.name === "session:context"), { ctxUsage: b.ctxUsage, info });
    e.control.script = null;
    await e.M.run(s.id, { text: "second — " + "x".repeat(40000) });   // ~10K more tokens → 176K + 10K + 8K reserve ≥ 90 % → roll
    const second = e.sdkCalls[1];
    const notes = s.messages.filter((m) => m.role === "system").map((m) => m.text);
    check("A03b", "the next turn continues in a FRESH native session (no resume) with the record transferred, announced with the fill level", !second.options.resume && /^Conversation record/.test(second.prompts[0]) && /second — x/.test(second.prompts[0]) && notes.some((t) => /Context window 9\d% full/.test(t) && /fresh native session/.test(t)) && e.M.lastRunInfo().rollover && e.M.lastRunInfo().rollover.reason === "full" && !history.bindingFor(s, "anthropic").ctxUsage, { resume: second.options.resume, promptHead: second.prompts[0].slice(0, 60), notes, rollover: e.M.lastRunInfo().rollover });
    // a manual rollover request works the same way even when the thread is small
    const s3 = e.make(); await e.M.run(s3.id, { text: "hello" }); e.M.requestRollover(s3.id, true); await e.M.run(s3.id, { text: "again" });
    const third = e.sdkCalls[e.sdkCalls.length - 1];
    check("A03c", "a requested rollover (context popover) starts a fresh native session on the next message and clears the request", !third.options.resume && s3.forceRollover === false && s3.messages.some((m) => m.role === "system" && /Context rollover requested/.test(m.text)), { resume: third.options.resume, force: s3.forceRollover });
    store.saveSettings({ contextRolloverPct: 0 });
    const s4 = e.make(); e.control.script = async function* ({ call }) { call.ctxUsage = { totalTokens: 195000, maxTokens: 200000, percentage: 97 }; yield* (async function* () { yield { type: "system", subtype: "init", session_id: "n4" }; yield { type: "assistant", message: { id: "a", content: [{ type: "text", text: "r" }] } }; yield { type: "result", subtype: "success", is_error: false, session_id: "n4", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 190000, output_tokens: 5 } }; await call.consumed; })(); };
    await e.M.run(s4.id, { text: "a" }); await sleep(30); e.control.script = null; await e.M.run(s4.id, { text: "b" });
    check("A03d", "rollover threshold 0 = off: a full thread is resumed as before (the CLI's own compaction / the overflow recovery handle it)", e.sdkCalls[e.sdkCalls.length - 1].options.resume === "n4", e.sdkCalls[e.sdkCalls.length - 1].options.resume);
    store.saveSettings({ contextRolloverPct: 90 }); }

  // A04 "prompt is too long" teaches the real window; the next run tells the CLI the compaction window
  { const e = environment({ ctx: 200000, ctx1m: true }); const s = e.make({ oneM: true });
    history.setBinding(s, "anthropic", { id: "native-1m", syncedIndex: -1, activeTokens: 195000 });
    let n = 0;
    e.control.script = async function* ({ call }) {
      n++;
      yield { type: "system", subtype: "init", session_id: call.options.resume || "native-new" };
      if (n === 1) { yield { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, errors: ["prompt is too long: 214000 tokens > 200000 maximum"], total_cost_usd: 0 }; await call.consumed; return; }
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "Recovered." }] } };
      yield { type: "result", subtype: "success", is_error: false, session_id: "native-new", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 20000, output_tokens: 5 } };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "hello", oneM: true });
    const lw = history.bindingFor(s, "anthropic").learnedWindow;
    const win = e.M.effectiveWindow(s, "anthropic", "claude-opus-4-8");
    check("A04", "the 1M window the catalog promised was not honoured (rejected at ~195K): the session now budgets a 200K window, announced", lw && lw.tokens === 200000 && lw.oneM === true && win.believed === 1000000 && win.tokens === 200000 && win.learned && s.messages.some((m) => m.role === "system" && /budgets this session for a 200,000-token window/.test(m.text)) && s.status === "done", { lw, win, status: s.status });
    e.control.script = null;
    await e.M.run(s.id, { text: "next", oneM: true });
    const last = e.sdkCalls[e.sdkCalls.length - 1];
    check("A04b", "the next run passes the learned window to the CLI as its auto-compaction window (its own compaction fires before the real limit)", last.options.settings && last.options.settings.autoCompactWindow === 200000 && e.M.lastRunInfo().sent.autoCompactWindow === 200000, last.options.settings);
    check("A04c", "a rejection consistent with the automatic 1M window teaches nothing; a smaller real rejection still teaches its limit", e.M.learnWindow(e.make(), "anthropic", "claude-opus-4-8", 990000) === null && e.M.learnWindow(e.make({ oneM: true }), "anthropic", "claude-opus-4-8", 620000) === 600000); }

  // A05 the rolling digest is prepared in the background — cached, no chat card
  { const e = environment(); const msgs = []; for (let i = 0; i < 40; i++) { msgs.push({ id: "u" + i, role: "user", text: `Question ${i} ` + "q".repeat(3000), ts: store.nowISO() }); msgs.push({ id: "a" + i, role: "assistant", text: `Answer ${i} ` + "a".repeat(3000), ts: store.nowISO() }); }
    const s = e.make({ messages: msgs });
    history.setBinding(s, "anthropic", { id: "native-d", syncedIndex: history.lastGlobalIndex(s), ctxUsage: { totalTokens: 120000, maxTokens: 200000, percentage: 60, ts: store.nowISO() } });
    const cardsBefore = s.messages.filter((m) => m.role === "summary").length;
    const d = await e.M.maybeDigest(s);
    const cardsAfter = s.messages.filter((m) => m.role === "summary").length;
    const info = e.M.contextInfo(s.id);
    check("A05", "once the thread is half full the oldest part of the record is digested in the background: cached checkpoints, model calls counted, no card in the chat", d && d.upTo > 0 && d.entries >= 4 && e.summaryCalls.length >= 1 && cardsAfter === cardsBefore && info.digest && info.digest.calls === e.summaryCalls.length && info.digest.coversPct > 0 && Array.isArray(s.summaries) && s.summaries.length >= 1, { d, calls: e.summaryCalls.length, cards: [cardsBefore, cardsAfter], digest: info.digest });
    const calls1 = e.summaryCalls.length;
    const d2 = await e.M.maybeDigest(s);
    check("A05b", "with nothing new to fold in, the digest is not rebuilt", d2 === null && e.summaryCalls.length === calls1, { d2, calls: e.summaryCalls.length });
    store.saveSettings({ contextDigest: false });
    check("A05c", "the digest can be switched off; a forced build still works", (await e.M.maybeDigest(e.make({ messages: msgs }))) === null && (await e.M.buildDigest(s.id)).ok === true);
    store.saveSettings({ contextDigest: true });
    check("A05d", "the digest text is available for the context popover", /Digest of the older conversation/.test(e.M.digestText(s.id))); }

  // A06 stopping ONE agent goes through the live query's stopTask
  { const e = environment(); const s = e.make(); let stopRes = null, gate;
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "working" }] } };
      await new Promise((r) => { gate = r; });
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    const p = e.M.run(s.id, { text: "go" }); await sleep(40);
    stopRes = await e.M.stopAgent(s.id, "task-z"); gate(); await p;
    const after = await e.M.stopAgent(s.id, "task-z");
    check("A06", "a per-agent stop reaches the live query's stopTask; without a running turn it is refused plainly", stopRes && stopRes.ok === true && e.sdkCalls[0].stopped && e.sdkCalls[0].stopped[0] === "task-z" && after.ok === false && /No running turn/.test(after.detail), { stopRes, after }); }

  // A07 the provider's OWN window figure (modelUsage[model].contextWindow / the CLI's maxTokens) replaces the catalog's guess — scoped to model + 1M choice; a learned rejection still caps it
  { const e = environment({ ctx: 200000, ctx1m: false }); store.saveSettings({ contextRolloverPct: 90 }); const s = e.make();
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-w" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "Reply." }] } };
      yield { type: "result", subtype: "success", is_error: false, session_id: "native-w", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 540000, output_tokens: 20 },
        modelUsage: { "claude-opus-4-8": { inputTokens: 540000, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 1000000, maxOutputTokens: 32000 }, "claude-haiku-4-5": { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 8000 } } };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "first" }); await sleep(30);
    const rw = history.bindingFor(s, "anthropic").reportedWindow;
    const info = e.M.contextInfo(s.id);
    check("A07", "the result's modelUsage for THIS model (not the sub-agent's Haiku entry) teaches a 1M window although the catalog assumed 200K: budgets use 1,000,000 and the chip shows 54 % 'reported'", rw && rw.tokens === 1000000 && rw.model === "claude-opus-4-8" && rw.oneM === false && rw.source === "modelUsage" && e.M.contextTokensFor("anthropic", "claude-opus-4-8", s) === 1000000 && info.window === 1000000 && info.pct === 54 && info.windowSource === "reported", { rw, window: info.window, pct: info.pct, src: info.windowSource });
    e.control.script = null;
    await e.M.run(s.id, { text: "second" });
    check("A07b", "540K measured against the REAL 1M window is no reason to roll over: the next turn resumes the native thread (the catalog's 200K would have forced a fresh session and a huge summary)", e.sdkCalls[1].options.resume === "native-w" && !e.M.lastRunInfo().rollover, { resume: e.sdkCalls[1].options.resume });
    s.oneM = true;
    const flipped = e.M.contextTokensFor("anthropic", "claude-opus-4-8", s);
    s.oneM = false;
    const learned = e.M.learnWindow(s, "anthropic", "claude-opus-4-8", 540000);
    const win = e.M.effectiveWindow(s, "anthropic", "claude-opus-4-8");
    check("A07c", "the reported window is scoped to the 1M choice it was seen with (another choice falls back to the catalog), and a real rejection still caps it (540K accepted → 525K learned below the reported 1M)", flipped === 200000 && learned === 525000 && win.believed === 1000000 && win.tokens === 525000 && win.source === "learned", { flipped, learned, win });
    const s2 = e.make();
    e.control.script = async function* ({ call }) { call.ctxUsage = { totalTokens: 90000, maxTokens: 800000, rawMaxTokens: 1000000, percentage: 11, model: "claude-opus-4-8" }; yield { type: "system", subtype: "init", session_id: "native-u" }; yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "r" }] } }; yield { type: "result", subtype: "success", is_error: false, session_id: "native-u", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 90000, output_tokens: 5 } }; await call.consumed; };
    await e.M.run(s2.id, { text: "a" }); await sleep(40);
    const rw2 = history.bindingFor(s2, "anthropic").reportedWindow;
    check("A07d", "the CLI's context-usage maxTokens is the reported window too (source contextUsage)", rw2 && rw2.tokens === 800000 && rw2.source === "contextUsage" && e.M.contextInfo(s2.id).window === 800000, { rw2 });
    e.control.script = null; }

  // A08 the rolling digest follows every result of a Claude thread (not only the run's end) and a STOPPED accepted turn
  { const e = environment(); const msgs = []; for (let i = 0; i < 40; i++) { msgs.push({ id: "u" + i, role: "user", text: `Question ${i} ` + "q".repeat(3000), ts: store.nowISO() }); msgs.push({ id: "a" + i, role: "assistant", text: `Answer ${i} ` + "a".repeat(3000), ts: store.nowISO() }); }
    const s = e.make({ messages: msgs });
    history.setBinding(s, "anthropic", { id: "native-d2", syncedIndex: history.lastGlobalIndex(s) });
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-d2" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "long worker" } }] } };
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Async agent launched successfully.", is_error: false }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 120000, output_tokens: 5 } };   // a result while the process lives on
      await sleep(20);
      yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "t1", description: "long worker", is_backgrounded: true };
      await sleep(120); call.digestCallsMidRun = e.summaryCalls.length; call.stillRunning = e.M.isRunning(s.id);
      yield { type: "system", subtype: "task_notification", task_id: "bg1", tool_use_id: "t1", status: "completed", summary: "done" };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Worker done." }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 121000, output_tokens: 5 } };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "launch" }); await sleep(60);
    const b = history.bindingFor(s, "anthropic");
    check("A08", "a result mid-run (background agent still alive, thread 60 % full) already starts the digest: checkpoints exist before the run ends, no summary card, the digest binding is set", e.sdkCalls[0].digestCallsMidRun >= 1 && e.sdkCalls[0].stillRunning === true && b.digest && b.digest.upTo > 0 && !s.messages.some((m) => m.role === "summary") && s.status === "done", { mid: e.sdkCalls[0].digestCallsMidRun, still: e.sdkCalls[0].stillRunning, digest: b.digest, status: s.status });
    // a STOPPED turn — accepted or not — starts NO new digest: Stop stops work, it never spawns paid summaries
    const s2 = e.make({ messages: msgs });
    history.setBinding(s2, "anthropic", { id: "native-d3", syncedIndex: history.lastGlobalIndex(s2), activeTokens: 120000 });
    const before = e.summaryCalls.length; let gate;
    e.control.script = async function* ({ call }) { yield { type: "system", subtype: "init", session_id: "native-d3" }; yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "working" }] } }; await new Promise((r) => { gate = r; }); yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], num_turns: 1, total_cost_usd: 0 }; await call.consumed; };
    const p = e.M.run(s2.id, { text: "go" }); await sleep(40);
    await e.M.interrupt(s2.id, "stop"); gate(); await p; await sleep(60);
    check("A08b", "Stop on an accepted turn (thread 60 % full, a dozen new entries): NO digest is started afterwards — no summary call, no digest binding; 'Stopped by you.' once, status idle", e.summaryCalls.length === before && !history.bindingFor(s2, "anthropic").digest && !s2._digestRunning && s2.status === "idle" && s2.messages.filter((m) => m.role === "system" && /Stopped by you/.test(m.text)).length === 1, { calls: e.summaryCalls.length - before, digest: history.bindingFor(s2, "anthropic").digest, status: s2.status });
    e.control.script = null; }

  // A10 rollover: the native thread stays bound until the FRESH session has accepted its input (reviewer repro: ECONNRESET before acceptance)
  { const e = environment(); store.saveSettings({ contextRolloverPct: 90 }); const s = e.make();
    e.control.script = async function* ({ call }) {
      call.ctxUsage = { totalTokens: 176000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 88, model: "claude-opus-4-8" };
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "First reply." }] } };
      yield { type: "result", subtype: "success", is_error: false, session_id: "native-1", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 170000, output_tokens: 50 } };
      await call.consumed;
    };
    await e.M.run(s.id, { text: "first" }); await sleep(30);
    const before = { ...history.bindingFor(s, "anthropic") };
    e.control.script = async function* () { throw new Error("read ECONNRESET"); };   // the fresh session's CLI never accepts the input
    await e.M.run(s.id, { text: "second — " + "x".repeat(40000) });
    const b = history.bindingFor(s, "anthropic");
    check("A10", "a network failure BEFORE the fresh session accepts its input: the old native thread stays bound with its cursor and measurement (nothing was rolled), the turn is preserved offline for retry, and the failed attempt did start fresh (no resume)", b.id === "native-1" && b.syncedIndex === before.syncedIndex && b.ctxUsage && b.ctxUsage.totalTokens === 176000 && s.status === "offline" && !!s._pendingRetry && e.sdkCalls.length === 2 && !e.sdkCalls[1].options.resume, { b: { id: b.id, synced: b.syncedIndex, ctx: b.ctxUsage && b.ctxUsage.totalTokens }, before: { synced: before.syncedIndex }, status: s.status, pending: !!s._pendingRetry, resume: e.sdkCalls[1] && e.sdkCalls[1].options.resume });
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-fresh" };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Fresh." }] } };
      yield { type: "result", subtype: "success", is_error: false, session_id: "native-fresh", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 30000, output_tokens: 5 } };
      await call.consumed;
    };
    const payload = s._pendingRetry; delete s._pendingRetry;
    await e.M.run(s.id, payload);
    const b2 = history.bindingFor(s, "anthropic");
    check("A10b", "the retry rolls again from the same measurement; once the fresh session ACCEPTS (init), it takes the binding over — new id, cursor acknowledged through this turn, old measurement cleared — and the run completes", b2.id === "native-fresh" && !b2.ctxUsage && b2.syncedIndex === history.lastGlobalIndex(s) && s.status === "done" && e.sdkCalls.length === 3 && !e.sdkCalls[2].options.resume && s.messages.some((m) => m.role === "assistant" && m.text === "Fresh."), { b2: { id: b2.id, synced: b2.syncedIndex, last: history.lastGlobalIndex(s), ctx: b2.ctxUsage }, status: s.status, calls: e.sdkCalls.length });
    e.control.script = null; store.saveSettings({ contextRolloverPct: 90 }); }

  // A11 the run's dispatch scope (model, 1M choice) is frozen from what is SENT — the betas of the query that went out — not from the session as it was before the SDK load (reviewer repro)
  { const e = environment({ ctx: 200000, ctx1m: true }); const s = e.make({ oneM: false });   // the session starts without the 1M choice; the model is 1M-capable
    let releaseSdk = null; e.M.setSDK({ then(res) { releaseSdk = () => res(e.sdk); } });   // the SDK import is deferred until released
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-scope" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "Reply." }] } };
      yield { type: "result", subtype: "success", is_error: false, session_id: "native-scope", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 300000, output_tokens: 5 }, modelUsage: { "claude-opus-4-8": { inputTokens: 300000, outputTokens: 5, contextWindow: 1000000 } } };
      await call.consumed;
    };
    const p = e.M.run(s.id, { text: "hello" });
    await sleep(30);
    const pendingSdk = !!releaseSdk && e.sdkCalls.length === 0;
    s.oneM = true;   // the user turns the 1M choice on while the SDK is still loading
    releaseSdk(); await p; await sleep(30);
    const call = e.sdkCalls[0];
    const rw = history.bindingFor(s, "anthropic").reportedWindow;
    e.M.setSDK(e.sdk); e.control.script = null;
    check("A11", "the session's 1M choice was false before the SDK load and true at dispatch: the query went out WITH the 1M beta, the run's snapshot follows what was sent (oneM=true), and the result's 1M window is recorded under that dispatched scope — never under the pre-load snapshot", pendingSdk && call && Array.isArray(call.options.betas) && call.options.betas.includes("context-1m-2025-08-07") && e.M.lastRunInfo().sent.oneM === true && rw && rw.tokens === 1000000 && rw.oneM === true && s.status === "done", { pendingSdk, betas: call && call.options.betas, sentOneM: e.M.lastRunInfo().sent.oneM, rw, status: s.status }); }

  // A09 a digest ALREADY running mid-turn (started after an interim result) is cancelled by Stop together with the turn
  { const e = environment(); const msgs = []; for (let i = 0; i < 40; i++) { msgs.push({ id: "u" + i, role: "user", text: `Question ${i} ` + "q".repeat(3000), ts: store.nowISO() }); msgs.push({ id: "a" + i, role: "assistant", text: `Answer ${i} ` + "a".repeat(3000), ts: store.nowISO() }); }
    const s = e.make({ messages: msgs });
    history.setBinding(s, "anthropic", { id: "native-d4", syncedIndex: history.lastGlobalIndex(s) });
    let digestCalls = 0, gate;
    e.M.setSummarizer((_p, _m, _prompt, { signal }) => { digestCalls++; return new Promise((_res, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })); });
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-d4" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "long worker" } }] } };
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Async agent launched successfully.", is_error: false }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 120000, output_tokens: 5 } };   // interim result → the digest starts
      await sleep(20);
      yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "t1", description: "long worker", is_backgrounded: true };
      await new Promise((r) => { gate = r; });
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    const p = e.M.run(s.id, { text: "launch" }); await sleep(90);
    const mid = { digestRunning: s._digestRunning === true, calls: digestCalls, prep: e.M.preparationOf(s.id) && e.M.preparationOf(s.id).kind };
    await e.M.interrupt(s.id, "stop"); gate(); await p; await sleep(40);
    check("A09", "the interim-result digest is running (one summary call in flight, preparation 'digest'); Stop cancels it with the turn: digestRunning cleared, no further call, the preparation lock free, status idle", mid.digestRunning && mid.calls === 1 && mid.prep === "digest" && !s._digestRunning && digestCalls === 1 && e.M.preparationOf(s.id) === null && s.status === "idle", { mid, after: { digestRunning: s._digestRunning, calls: digestCalls, prep: e.M.preparationOf(s.id), status: s.status } });
    e.control.script = null; }

  /* ---- agent lifecycle after a run ENDS without finalising (user report 2026-09-17: an agent shown "running" 3 h after its run, the composer counting it, its CPU slot never freed) ---- */
  // A12 a run that PAUSES on a network error (the turn is preserved for retry, no finalize) still ends what it left running: its background agent (with a paused note), the agent's governor slot; the turn's retry state is untouched
  { const e = environment(); const s = e.make();
    A.governor.configure({ settings: () => ({ subAgentsMax: 5, agentCoresPerAgent: 1, agentCpuGovernor: true }), cores: 8, sampler: () => ({ idle: 0, total: 0 }) }); A.governor.ema = 0; A.governor.releaseAll();
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "native-p1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "tp1", name: "Task", input: { description: "long worker", prompt: "work", run_in_background: true } }] } };
      await call.options.canUseTool("Task", { description: "long worker" }, { toolUseID: "tp1", signal: new AbortController().signal });
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tp1", content: "Async agent launched successfully. agentId: agp", is_error: false }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 2 } };
      await sleep(15);
      yield { type: "system", subtype: "task_started", task_id: "tk-p1", tool_use_id: "tp1", description: "long worker", is_backgrounded: true, task_type: "local_agent" };
      await sleep(15);
      throw new Error("read ECONNRESET");   // the CLI's connection dies while the agent works: the run pauses (offline), its process is gone
    };
    await e.M.run(s.id, { text: "go", subAgents: true, subAgentsMax: 5 });
    const holdsAfter = A.governor.holds.size;
    const list = e.M.agentsList(s.id); const ag = list.agents[0];
    const update = e.sends.filter((x) => x.name === "agents:update" && x.data.agent.n === 1).pop();
    check("A12", "paused run (offline, retry preserved): its agent is ended with the paused note, its slot released, the registry reports 0 running — no agent outlives the process that ran it", s.status === "offline" && !!s._pendingRetry && ag && ag.status === "interrupted" && /Paused before this finished/.test(ag.result) && !!ag.endedTs && holdsAfter === 0 && list.running === 0 && update && update.data.agent.status === "interrupted" && update.data.running === 0, { status: s.status, pending: !!s._pendingRetry, ag: ag && { status: ag.status, result: ag.result, endedTs: !!ag.endedTs }, holds: holdsAfter, running: list.running });
    e.control.script = null; A.governor.releaseAll(); }

  // A13 agents left "running" by a run that no longer exists (a restart, a paused run of an older build) are reconciled: the panel's list ends them (card too, slot freed), Stop with nothing running ends them, a NEW run's first agent ends them — a live run's own agents are never touched
  { const e = environment(); const s = e.make();
    A.governor.releaseAll();
    const card = { id: "card-old", role: "tool", toolName: "Task", toolUseId: "tu-old", runId: "run-old", toolInput: { description: "ghost" }, status: "running", ts: store.nowISO() };
    s.messages.push(card);
    const r = A.announce(s, { toolUseId: "tu-old", msgId: "card-old", input: { description: "ghost", run_in_background: true }, runId: "run-old", status: "running" });
    A.governor.holds.set("tu-old", { since: Date.now() });
    const before = A.summary(s).running;
    const list = e.M.agentsList(s.id);
    check("A13", "a stale 'running' agent of an ended run is ended when the registry is listed: interrupted with a plain result, its Task card interrupted, its slot released, 0 running", before === 1 && list.running === 0 && r.agent.status === "interrupted" && /run that started this agent has ended/.test(r.agent.result) && card.status === "interrupted" && !A.governor.holds.has("tu-old") && e.sends.some((x) => x.name === "agents:update" && x.data.agent.n === r.agent.n && x.data.agent.status === "interrupted") && e.sends.some((x) => x.name === "session:message-update" && x.data.messageId === "card-old" && x.data.patch.status === "interrupted"), { before, running: list.running, agent: r.agent.status, card: card.status, hold: A.governor.holds.has("tu-old") });
    const r2 = A.announce(s, { toolUseId: "tu-old2", input: { description: "ghost 2" }, runId: "run-old2", status: "running" });
    const stopped = await e.M.interrupt(s.id, "stop");
    check("A13b", "Stop with no turn running ends stale agents and reports that it did something", stopped === true && r2.agent.status === "interrupted" && A.summary(s).running === 0, { stopped, status: r2.agent.status });
    // a live run owns its agents: reconciliation ends only the records of OTHER runs
    const liveRunner = { id: "run-live", running: true, promptMessageId: null };
    e.M.runners.set(s.id, liveRunner);
    const mine = A.announce(s, { toolUseId: "tu-live", input: { description: "mine" }, runId: "run-live", status: "running" });
    const ghost = A.announce(s, { toolUseId: "tu-old3", input: { description: "ghost 3" }, runId: "run-old3", status: "running" });
    const fresh = e.M.agentAnnounce(s, liveRunner, { toolUseId: "tu-live2", input: { description: "mine too" }, status: "queued" });
    e.M.runners.delete(s.id);
    check("A13c", "a new agent of the live run ends the earlier runs' leftovers but never the live run's own agents", fresh.created && mine.agent.status === "running" && fresh.agent.status === "queued" && ghost.agent.status === "interrupted" && A.summary(s).running === 2, { mine: mine.agent.status, fresh: fresh.agent.status, ghost: ghost.agent.status, running: A.summary(s).running });
    A.governor.releaseAll(); }

  // A14 a record REOPENED after a restart (read from disk) — an agent persisted as "running", tool cards "queued" — comes back settled: the tab's view shows nothing running, the last activity is kept (user report 2026-09-17: "even after closing it shows running")
  { const e = environment(); const s = e.make();
    const card = { id: "card-dead", role: "tool", toolName: "Task", toolUseId: "tu-dead", runId: "run-dead", toolInput: { description: "ghost" }, status: "running", agentN: 1, ts: store.nowISO() };
    const sub = { id: "sub-dead", role: "tool", toolName: "Bash", toolUseId: "tu-sub", runId: "run-dead", parentToolUseId: "tu-dead", toolInput: { command: "npm test" }, status: "queued", ts: store.nowISO() };
    s.messages.push(card, sub);
    const dead = A.announce(s, { toolUseId: "tu-dead", msgId: "card-dead", input: { description: "ghost", run_in_background: true }, runId: "run-dead", status: "running" });
    A.patch(dead.agent, { progress: "Tracing recovery stop in generateEntry.ts", lastTool: "Grep", toolUses: 51 });
    store.flush(s.id); store.flushAll();
    store.loadAllSessions();   // the in-memory cache is gone, as after a restart: the next read comes from disk
    const view = store.getSessionView(s.id);
    const ag = view.agents.find((a) => a.n === dead.agent.n);
    const cardV = view.messages.find((m) => m.id === "card-dead"), subV = view.messages.find((m) => m.id === "sub-dead");
    check("A14", "reopened from disk: the agent is 'interrupted' with the closed-app reason AND its last activity, ended timestamp set; its Task card and the queued sub-agent card are interrupted; the registry reports 0 running", ag && ag.status === "interrupted" && ag.result === "AtomNano was closed before this finished. Last activity: Tracing recovery stop in generateEntry.ts" && !!ag.endedTs && ag.progress === "Tracing recovery stop in generateEntry.ts" && cardV && cardV.status === "interrupted" && cardV.agentStatus === "interrupted" && subV && subV.status === "interrupted" && e.M.agentsList(s.id).running === 0, { ag: ag && { status: ag.status, result: ag.result, endedTs: !!ag.endedTs }, card: cardV && cardV.status, sub: subV && subV.status, running: e.M.agentsList(s.id).running }); }

  // A15 a clean quit while a run is alive persists its leftovers as ended (with the last activity), not as running
  { const e = environment(); const s = e.make();
    const runner = { id: "run-quit", running: true, promptMessageId: null };
    e.M.runners.set(s.id, runner);
    s.messages.push({ id: "card-quit", role: "tool", toolName: "Bash", toolUseId: "tu-quit", runId: "run-quit", toolInput: { command: "npm run build" }, status: "running", ts: store.nowISO() });
    const ag = e.M.agentAnnounce(s, runner, { toolUseId: "tu-quit-agent", input: { description: "builder", run_in_background: true }, status: "running" }).agent;
    e.M.agentPatch(s, ag, { progress: "Compiling the renderer bundle" });
    e.M.markInterruptedOnQuit();
    e.M.runners.delete(s.id);
    const card = s.messages.find((m) => m.id === "card-quit");
    check("A15", "quit: the agent ends with 'AtomNano was closed before this finished. Last activity: …', the running tool card is interrupted, the closing note is recorded, status idle", ag.status === "interrupted" && ag.result === "AtomNano was closed before this finished. Last activity: Compiling the renderer bundle" && card.status === "interrupted" && /AtomNano was closed before this finished/.test(card.result) && s.messages.some((m) => m.role === "system" && /interrupted because AtomNano closed/.test(m.text)) && s.status === "idle" && A.summary(s).running === 0, { ag: { status: ag.status, result: ag.result }, card: card.status, status: s.status }); }

  // A16 the numbers come from ONE source and the user's cap is the limit: the governor's cap follows the RUNNING turn (the composer's 12, not the settings file's 3 — the gate denied agents the user had allowed), and "running" counts the registry (full-access runs skip the gate, so the holds alone showed 0 while 4 agents worked)
  { const e = environment(); const s = e.make();
    store.saveSettings({ subAgentsMax: 3, agentCpuGovernor: false });
    const runner = { id: "run-cap", running: true, promptMessageId: null, subAgentsMax: 12 };
    e.M.runners.set(s.id, runner);
    e.M._governorReady = false; e.M.ensureGovernor();   // this manager's own policy inputs (the checks above configured the singleton directly)
    A.governor.releaseAll();
    e.M.agentAnnounce(s, runner, { toolUseId: "cap-1", input: { description: "one" }, status: "running" });
    e.M.agentAnnounce(s, runner, { toolUseId: "cap-2", input: { description: "two" }, status: "running" });
    const snap = e.M.cpuSnapshot();
    check("A16", "cap 12 from the running turn (settings say 3), gate off → 12 allowed; 2 agents running per the registry with 0 holds → running 2, 10 slots free", A.governor.policy().userMax === 12 && snap.userMax === 12 && snap.allowedNow === 12 && snap.governor === false && snap.running === 2 && snap.freeSlots === 10 && A.governor.holds.size === 0, { userMax: A.governor.policy().userMax, snap: { userMax: snap.userMax, allowedNow: snap.allowedNow, governor: snap.governor, running: snap.running, freeSlots: snap.freeSlots }, holds: A.governor.holds.size });
    e.M.runners.delete(s.id);
    const idle = e.M.cpuSnapshot();
    check("A16b", "with no turn running the cap falls back to the settings and nothing is running", idle.userMax === 3 && idle.running === 0 && idle.freeSlots === 3, { userMax: idle.userMax, running: idle.running, freeSlots: idle.freeSlots });
    A.governor.releaseAll(); }

  // A17 role skills across a CONTEXT ROLLOVER (2026-09-18): the resumed thread gets a pointer; the fresh native session the
  // rollover starts gets the procedures in full again (its record budgeted for that prompt) and commits the hash at its init; a
  // rollover whose fresh session dies BEFORE init leaves the old thread bound with its cache intact
  { const e = environment(); store.saveSettings({ contextRolloverPct: 90 });
    const sk = skillsMod.create(HOME, { name: "Rollover rules", steps: "Keep the tokens." });
    const parent = e.make(); const s = e.make({ parentId: parent.id, role: "coder", selectedSkills: [sk.id] });
    // The measurement a turn leaves behind decides whether the NEXT turn rolls (A03): 60 % keeps the thread, 88 % (+ the 8K reserve) rolls it.
    const measured = (tokens) => async function* ({ call }) {
      call.ctxUsage = { totalTokens: tokens, maxTokens: 200000, rawMaxTokens: 200000, percentage: Math.round(tokens / 2000), model: "claude-opus-4-8" };
      yield { type: "system", subtype: "init", session_id: call.options.resume || "native-1" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "Reply." }] } };
      yield { type: "result", subtype: "success", is_error: false, session_id: call.options.resume || "native-1", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: tokens - 6000, output_tokens: 50 } };
      await call.consumed;
    };
    e.control.script = measured(120000);
    await e.M.run(s.id, { text: "first", roleBrief: "Coder." }); await sleep(30);
    e.control.script = measured(176000);
    await e.M.run(s.id, { text: "second", roleBrief: "Coder." }); await sleep(30);   // still on the resumed thread (60 % measured): a pointer; leaves 88 % behind
    const h = history.bindingFor(s, "anthropic").skillsHash;
    e.control.script = async function* () { throw new Error("read ECONNRESET"); };   // the fresh session never accepts
    await e.M.run(s.id, { text: "third", roleBrief: "Coder." });   // 88 % + the reserve ≥ 90 %: rolls
    const kept = { ...history.bindingFor(s, "anthropic") }, paused = s.status;
    e.control.script = async function* ({ call }) { yield { type: "system", subtype: "init", session_id: "native-fresh" }; yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Fresh." }] } }; yield { type: "result", subtype: "success", is_error: false, session_id: "native-fresh", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 30000, output_tokens: 5 } }; await call.consumed; };
    const payload = s._pendingRetry; delete s._pendingRetry;
    await e.M.run(s.id, payload);
    const [c1, c2, c3, c4] = e.sdkCalls.map((c) => ({ resume: c.options.resume, p: c.prompts[0] }));
    const b = history.bindingFor(s, "anthropic");
    check("A17", "first turn: procedures in full, hash committed; second (resumed): one pointer line; the rollover attempt that died before init (no resume, procedures in full) left the OLD thread bound with its hash; the retried rollover's fresh session carries the record + the procedures in full and takes the binding with the hash", /^first\n\nSkills the user selected for this message/.test(c1.p) && c2.resume === "native-1" && /^second\n\nSkills active for this conversation/.test(c2.p) && !/saved procedures\):/.test(c2.p) && typeof h === "string" && h.length === 64 && !c3.resume && /Skills the user selected for this message/.test(c3.p) && kept.id === "native-1" && kept.skillsHash === h && paused === "offline" && !c4.resume && /^Conversation record/.test(c4.p) && /Skills the user selected for this message/.test(c4.p) && b.id === "native-fresh" && b.skillsHash === h && s.status === "done", { c2: c2.p.slice(0, 80), c3: { resume: c3.resume, tail: c3.p.slice(-80) }, kept: { id: kept.id, h: kept.skillsHash && kept.skillsHash.slice(0, 8) }, paused, b: { id: b.id, h: b.skillsHash && b.skillsHash.slice(0, 8) }, status: s.status });
    e.control.script = null; store.saveSettings({ contextRolloverPct: 90 }); }
}

async function main() {
  await pureChecks();
  await runnerChecks();
  clearTimeout(watchdog);
  console.log(`Agents + context: ${pass} passed, ${failN} failed`);
  if (failures.length) console.log("Failures:\n  " + failures.join("\n  "));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failN ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
