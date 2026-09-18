"use strict";
// IPC completion must belong to the task that still owns the session. Delayed
// providers intentionally ignore cancellation to reproduce late completions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("PASS " + name); }
function fixture() {
  let sequence = 0;
  const src = { id: "source", name: "Source", cwd: "project", messages: [], tasks: {}, status: "idle" };
  const sessions = new Map([[src.id, src]]), runners = new Map(), handlers = {}, events = [], calls = [];
  const summary = deferred(), images = deferred();
  const store = {
    getSession: (id) => sessions.get(id), getSessionView: (id) => sessions.get(id),
    getSettings: () => ({ llmProvider: "anthropic" }),
    updateSession: (id, patch) => Object.assign(sessions.get(id), patch),
    createSession: (opts) => { const s = { ...opts, id: "new-" + ++sequence, messages: [] }; sessions.set(s.id, s); return s; },
    uid: () => String(++sequence), nowISO: () => "2026-09-16T00:00:00Z", normalizeTasks: (tasks) => tasks, flush() {},
  };
  const manager = {
    runners, send: (type, data) => events.push({ type, ...data }),
    addMessage: (s, m) => s.messages.push(m), workflowFor: () => ({ enabled: false }),
    isRunning: (id) => runners.has(id),
    synthesizeSeed: (_s, _p, opts) => { calls.push(opts); return summary.promise; },
    registerExternalRunner(id) {
      if (runners.has(id)) return null;
      const controller = new AbortController(), runner = { controller };
      runners.set(id, runner);
      return { signal: controller.signal, isAborted: () => controller.signal.aborted,
        progress: (label) => { if (runners.get(id) === runner) manager.send("session:live", { sessionId: id, live: { status: "preparing", label } }); },
        unregister() { if (runners.get(id) !== runner) return false; runners.delete(id); return true; } };
    },
  };
  function stopAndReplace() {
    const old = runners.get(src.id); runners.delete(src.id); old.controller.abort();
    src.status = "running"; runners.set(src.id, { id: "replacement" });
  }
  const deps = {
    electron: { ipcMain: { on() {} } }, fs, "../storage/store": store, "../session/index": manager,
    "../providers/catalog": { onCodexModelsChange() {} },
    "../providers/image-gen": { setTextRunner() {}, generate: () => images.promise },
  };
  for (const file of ["sessions.js", "providers.js"]) {
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/main/ipc", file), "utf8"), {
      module: mod, require: (id) => { if (!(id in deps)) throw new Error("Unexpected dependency " + id); return deps[id]; },
      process, Promise, Map, setImmediate, console,
    }, { filename: file });
    mod.exports.register({ handle: (name, fn) => { handlers[name] = fn; }, winFrom() {}, projectOf() {}, broadcast() {} });
  }
  return { src, sessions, runners, events, calls, summary, images, manager, stopAndReplace,
    synthesize: () => handlers["sessions:synthesize"](null, src.id),
    image: () => handlers["image:generate"](null, src.id, "draw a circle", {}),
  };
}
const seed = { mode: "exact", count: 1, headCount: 0, tailCount: 1, text: "Original conversation", last: 0 };
async function main() {
  await check("Duplicate synthesis shares preparation and creates one continuation", async () => {
    const e = fixture(), a = e.synthesize(), b = e.synthesize();
    assert.equal(e.calls.length, 1); assert.equal(e.src.status, "running");
    assert.ok(e.events.some((x) => x.type === "session:live" && x.live.status === "preparing"));
    e.summary.resolve(seed); const [x, y] = await Promise.all([a, b]);
    assert.equal(x.id, y.id); assert.equal(e.sessions.size, 2);
    assert.equal(e.src.status, "idle"); assert.equal(e.runners.size, 0);
  });
  await check("Cancelled synthesis returns promptly and cannot idle a replacement or create a late tab", async () => {
    const e = fixture(), pending = e.synthesize(); e.stopAndReplace();
    assert.equal(await pending, null); assert.equal(e.src.status, "running");
    e.summary.resolve(seed); await new Promise(setImmediate);
    assert.equal(e.sessions.size, 1); assert.equal(e.runners.get("source").id, "replacement");
    assert.equal(e.src.messages.length, 0);
  });
  await check("Synthesis rejects a busy session before any preparation", async () => {
    const e = fixture(); e.runners.set("source", { id: "primary" });
    await assert.rejects(e.synthesize(), /Stop the running reply/);
    assert.equal(e.calls.length, 0); assert.equal(e.runners.get("source").id, "primary");
  });
  await check("Deleted source cannot produce a phantom continuation", async () => {
    const e = fixture(), pending = e.synthesize(); e.sessions.delete("source");
    e.summary.resolve(seed); assert.equal(await pending, null); assert.equal(e.sessions.size, 0);
  });
  await check("Image completion after Stop cannot overwrite a replacement run", async () => {
    const e = fixture(), pending = e.image(); e.stopAndReplace();
    e.images.resolve([{ data: "fake", mediaType: "image/svg+xml" }]);
    assert.equal((await pending).error, "stopped"); assert.equal(e.src.status, "running");
    assert.equal(e.src.messages.length, 1); assert.equal(e.runners.get("source").id, "replacement");
  });
  await check("Image failure after Stop cannot publish a late error or idle", async () => {
    const e = fixture(), pending = e.image(); e.stopAndReplace();
    e.images.reject(new Error("late network failure"));
    assert.equal((await pending).error, "stopped"); assert.equal(e.src.status, "running");
    assert.equal(e.src.messages.length, 1);
  });
  await check("Current image owner publishes its result and releases the session", async () => {
    const e = fixture(), pending = e.image(); e.images.resolve([{ data: "fake" }]);
    assert.equal((await pending).ok, true); assert.equal(e.src.status, "done");
    assert.equal(e.src.messages[1].role, "image"); assert.equal(e.runners.size, 0);
  });
  console.log(`Session IPC: ${passed} passed, 0 failed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
