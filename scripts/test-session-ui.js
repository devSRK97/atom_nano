"use strict";
// Exercise the actual renderer entry points with delayed IPC responses. No app profile,
// credentials or model calls. A clock tick must never manufacture a backend idle state.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const R = require("./lib/renderer-src");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("PASS " + name); }
function fixture() {
  const ts = { meta: { id: "s", status: "running" }, streaming: new Map([[0, { text: "thinking" }]]), queue: [], stopping: false };
  const state = { tabs: new Map([["s", ts]]), activeTabId: "s", order: ["s"] };
  const timers = [], toasts = [], opened = [], calls = [];
  const stop = deferred(), synth = deferred();
  const atom = { sessions: {
    interrupt: () => stop.promise,
    running: async () => false,
    send: async () => { calls.push("send"); },
    runState: async () => ({ running: true, status: "running", stopping: true }),
    synthesize: () => { calls.push("synthesize"); return synth.promise; },
  } };
  const context = vm.createContext({
    state, atom, Map, Promise, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    updateSendButton() {}, renderLive() {}, renderTabs() {}, renderQueue() {}, persistTabs() {},
    dispatchNextQueued: (id) => calls.push("queue:" + id), toast: (t) => toasts.push(t),
    addTabState: (v) => { opened.push(v.id); state.tabs.set(v.id, { meta: v }); },
    switchTab: async (id) => { state.activeTabId = id; },
    sharedRunOpts: () => ({}), $: () => null, autoGrow() {}, renderAttachments() {},
  });
  vm.runInContext(["reconcileSessionRunState", "requestSessionStop", "stopSession"].map(R.fn).join("\n") +
    "\nconst synthesisRequests = new Map();\n" + R.fn("synthesizeSession"), context);
  return { context, ts, state, timers, toasts, opened, calls, atom, stop, synth };
}
async function main() {
  await check("Stop stays stopping while backend owns the run, even after the fallback clock fires", async () => {
    const e = fixture(); const p = e.context.stopSession("s");
    assert.equal(e.ts.stopping, true); assert.equal(e.ts.streaming.size, 0);
    await e.timers[0]();
    assert.equal(e.ts.meta.status, "running"); assert.equal(e.ts.stopping, true);
    e.atom.sessions.runState = async () => ({ running: false, status: "idle", stopping: false });
    e.stop.resolve(true); await p;
    assert.equal(e.ts.meta.status, "idle"); assert.equal(e.ts.stopping, false);
  });
  await check("A stale idle probe cannot override the replacement run", async () => {
    const e = fixture(), probe = deferred();
    e.atom.sessions.runState = () => probe.promise;
    const p = e.context.reconcileSessionRunState(e.ts);
    e.ts._statusVersion = 1; e.ts.meta.status = "running";
    probe.resolve({ running: false, status: "idle", stopping: false }); await p;
    assert.equal(e.ts.meta.status, "running");
  });
  await check("Stop errors preserve the running state and allow retry", async () => {
    const e = fixture(); e.atom.sessions.runState = async () => ({ running: true, status: "running", stopping: false });
    const p = e.context.stopSession("s"); e.stop.reject(new Error("IPC unavailable")); await p;
    assert.equal(e.ts.meta.status, "running"); assert.equal(e.ts.stopping, false);
    assert.ok(e.toasts.some((t) => /Stop failed/.test(t)));
  });
  await check("A rejected image request reconciles the optimistic running state", async () => {
    const e = fixture();
    e.context.activeTS = () => e.ts;
    e.atom.image = { generate: async () => { throw new Error("IPC unavailable"); } };
    e.atom.sessions.runState = async () => ({ running: false, status: "idle", stopping: false });
    vm.runInContext(R.fn("generateImage"), e.context);
    await e.context.generateImage("draw a circle");
    assert.equal(e.ts.meta.status, "idle");
    assert.ok(e.toasts.some((t) => /Image generation failed/.test(t)));
  });
  await check("Selecting a 1M model enables its context automatically and clears it for unsupported models — in the background: the chip stays hidden either way (user request 2026-09-17), its 'on' class still records the state, no checkbox", () => {
    const e = fixture(), saved = [], toggles = [];
    e.state.settings = { defaultModel: "large", oneM: false };
    e.state.modelCaps = { large: true, small: false };
    e.atom.settings = { set: async (patch) => { saved.push(patch.oneM); } };
    e.context.$ = (id) => id === "oneMWrap" ? { classList: { toggle: (key, on) => toggles.push(key + ":" + on) } } : null;
    vm.runInContext(R.fn("modelSupports1M") + "\n" + R.fn("updateOneMVisibility"), e.context);
    e.context.updateOneMVisibility(); e.context.updateOneMVisibility();
    assert.equal(e.state.settings.oneM, true); assert.deepEqual(saved, [true]);
    assert.deepEqual(toggles.slice(-2), ["hidden:true", "on:true"]);
    e.state.settings.defaultModel = "small"; e.context.updateOneMVisibility();
    assert.equal(e.state.settings.oneM, false); assert.deepEqual(saved, [true, false]);
    assert.deepEqual(toggles.slice(-2), ["hidden:true", "on:false"]);
    assert.ok(toggles.every((t) => !t.startsWith("hidden:false")), "the chip is never shown");
    assert.ok(!/oneMToggle/.test(R.fn("updateOneMVisibility")), "no checkbox is driven any more");
  });
  await check("The Orchestrator node runs only with the workflow on; a stale 'running' stage cannot keep it thinking after the tab's status changed; an old 'planner' stage is a worker's, not the primary's", () => {
    const e = fixture(); let enabled = true;
    e.context.activeWorkflow = () => ({ enabled });
    e.context.tabWorkflow = () => ({ enabled });   // primaryRunning reads THAT tab's workflow (per-session selection, 2026-09-18)
    e.context.PRIMARY = "orchestrator";
    e.state.workflow = { stages: new Map(), jobs: new Map() };
    vm.runInContext(R.fn("primaryStage") + "\n" + R.fn("primaryRunning"), e.context);
    e.ts.meta.status = "idle";
    assert.equal(e.context.primaryRunning("s"), false);
    e.state.workflow.stages.set("s", { stage: "planner", status: "running", at: Date.now() });
    assert.equal(e.context.primaryRunning("s"), false);                          // the Planner is a worker role now — its stage never means the primary thinks
    e.state.workflow.stages.set("s", { stage: "orchestrator", status: "running", at: Date.now() });
    assert.equal(e.context.primaryRunning("s"), true);                           // main said the orchestrator turn started
    e.ts._statusAt = Date.now() + 5; assert.equal(e.context.primaryRunning("s"), false);   // …then the tab's status changed after it (Stop): not thinking
    e.ts.meta.status = "running"; assert.equal(e.context.primaryRunning("s"), true);
    enabled = false; assert.equal(e.context.primaryRunning("s"), false);         // workflow off: the chat runs solo — there is no orchestrator
  });
  await check("A queued send rejected after Stop cannot requeue or resend the cancelled prompt", async () => {
    const e = fixture(), pending = deferred();
    vm.runInContext(R.fn("dispatchNextQueued"), e.context);
    e.ts.queue.push({ text: "cancel this" });
    e.atom.sessions.send = () => { e.calls.push("send"); return pending.promise; };
    const dispatch = e.context.dispatchNextQueued("s"); await new Promise(setImmediate);
    assert.equal(e.calls.filter((x) => x === "send").length, 1);
    const stop = e.context.stopSession("s");
    pending.reject(new Error("already running")); await dispatch;
    e.atom.sessions.runState = async () => ({ running: false, status: "idle" });
    e.stop.resolve(true); await stop;
    for (const timer of e.timers.slice()) await timer();
    assert.equal(e.ts.queue.length, 0);
    assert.equal(e.calls.filter((x) => x === "send").length, 1);
  });
  await check("A queue probe cancelled by Stop cannot dispatch or release a newer queue owner", async () => {
    const e = fixture(), probe = deferred(), pending = deferred();
    vm.runInContext(R.fn("dispatchNextQueued"), e.context);
    e.ts.queue.push({ text: "old" }); e.atom.sessions.running = () => probe.promise;
    const old = e.context.dispatchNextQueued("s");
    const stopping = e.context.stopSession("s");
    e.atom.sessions.runState = async () => ({ running: false, status: "idle" });
    e.stop.resolve(true); await stopping;
    e.ts.queue.push({ text: "new" }); e.atom.sessions.running = async () => false;
    e.atom.sessions.send = (_id, payload) => { e.calls.push(payload.text); return pending.promise; };
    const current = e.context.dispatchNextQueued("s"); await new Promise(setImmediate);
    probe.resolve(false); await old;
    assert.equal(e.ts._dispatching, true); assert.deepEqual(e.calls, ["new"]);
    pending.resolve({ started: true }); await current;
    assert.equal(e.ts._dispatching, false);
  });
  await check("Enter awaiting a steer response cannot restart the prompt after Stop", async () => {
    const e = fixture(), steer = deferred(), input = { value: "send this now" };
    Object.assign(e.context, { activeTS: () => e.ts, $: () => input, looksLikeImageRequest: () => false, scrollBottom() {} });
    e.atom.sessions.steer = () => steer.promise;
    vm.runInContext(R.fn("send"), e.context);
    const sending = e.context.send({ now: true });
    const stopping = e.context.stopSession("s");
    e.atom.sessions.runState = async () => ({ running: false, status: "idle" });
    e.stop.resolve(true); await stopping;
    steer.resolve({ steered: false }); await sending;
    assert.equal(e.ts.queue.length, 0); assert.equal(e.ts.stopping, false);
    assert.ok(!e.toasts.some((t) => /Interrupting/.test(t)));
  });
  await check("Two Synthesize clicks share one IPC call and open one continuation", async () => {
    const e = fixture(); const a = e.context.synthesizeSession("s"), b = e.context.synthesizeSession("s");
    assert.equal(e.calls.length, 1);
    e.synth.resolve({ id: "continued", name: "continued", messages: [] });
    await Promise.all([a, b]); assert.deepEqual(e.opened, ["continued"]);
    assert.equal(e.toasts.length, 1);
  });
  await check("Cancelled Synthesize opens no phantom tab and permits a fresh attempt", async () => {
    const e = fixture(); const a = e.context.synthesizeSession("s");
    e.synth.resolve(null); assert.equal(await a, null); assert.equal(e.opened.length, 0);
    e.atom.sessions.synthesize = async () => ({ id: "retry", messages: [] });
    await e.context.synthesizeSession("s"); assert.deepEqual(e.opened, ["retry"]);
  });
  console.log(`Session UI: ${passed} passed, 0 failed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
