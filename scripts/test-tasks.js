"use strict";
/* Task board regression suite — DESIRED behaviour for docs/WORKFLOW_CONTRACT.md §8 (the main-process side:
 * the SessionManager mixin src/main/session/tasks.js, its hooks in workflow.js / transfer.js / the synthesize
 * IPC handler, and the store's persistence of `session.tasks`):
 *   · the board's shape and normalisation (legacy / malformed → a clean or empty board);
 *   · addTasks — the set rules (explicit title → close + open; no active set or every item terminal → "Set <n>";
 *     else append), session-wide numbering T1, T2 …, one `role: "tasks"` chat card per set with its FULL meta;
 *   · updateTask — status (any of the contract's; done → doneTs), role, title, detail, notes { ts, by, text },
 *     the ref forms "T12" / 12 / id, plain errors, the set closing as "done" when its last open item finishes;
 *   · openTaskSet / removeTask / taskInfo / boardSummaryText / bounding (400 items · 60 sets, oldest done first);
 *   · tasks:update events with the whole board after every change;
 *   · jobs: startRoleJob({ …, taskRef }) / a bare "T2" description → linkJobToTask (job.taskId / taskN, item.jobIds,
 *     doing / review / test by role, the labelled task line in the child's prompt, the job-end note);
 *   · the §8.2 paragraph of the orchestrator brief; synthesize copies the board and the seed carries its summary;
 *   · persistence: normalizeSession / getSessionView / metaOf.taskCounts round-trip.
 * The ORIGINAL session modules run in a VM with a scripted fake SDK and a fake Codex app-server; store, history,
 * agents and platform are REAL on an isolated data home. No network, no model calls.  Run: node scripts/test-tasks.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const ROOT = path.join(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-tasks-"));
process.env.ATOMNANO_MAX_MESSAGES = "60";
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, "claude-home"); fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
process.env.CODEX_HOME = path.join(HOME, "codex-home"); fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === "electron") return { app: { getPath: (k) => (k === "userData" ? HOME : os.homedir()), getAppPath: () => ROOT, isPackaged: false } }; return origLoad.call(this, req, ...rest); };

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 900) : ""}`); } }
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 180000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = require(path.join(ROOT, "src/main/storage/store.js"));
const history = require(path.join(ROOT, "src/main/storage/history.js"));
store.loadSettings();
store.saveSettings({ llmProvider: "anthropic", modeNote: false });   // modeNote off: these suites assert bare solo turns (the note has its own checks, test-workflow W29)
const src = { sessions: fs.readFileSync(path.join(ROOT, "src/main/ipc/sessions.js"), "utf8") };   // the sessions:* IPC module
const { loadSessionInVm } = require("./lib/session-vm");   // the ORIGINAL session modules, fakes injected

/* One isolated SessionManager (the workflow suite's environment) + the synthesize IPC handler extracted
 * UNCHANGED from src/main/ipc/sessions.js (the context suite's way). */
function environment() {
  const sends = [], sdkCalls = [], appCalls = [];
  const control = { script: null, app: null };
  const sdk = { query(opts) {
    const call = { prompt: opts.prompt, options: opts.options, prompts: [], promptEnded: false, interrupts: 0 }; sdkCalls.push(call);
    call.consumed = (async () => { for await (const m of opts.prompt) { call.prompts.push(m.message.content); } call.promptEnded = true; return call.prompts; })();
    const gen = (control.script || defaultScript)({ opts, call });
    const q = { [Symbol.asyncIterator]() { return gen; }, next: (...a) => gen.next(...a), return: (...a) => gen.return(...a), throw: (...a) => gen.throw(...a),
      interrupt: async () => { call.interrupts++; if (call.onInterrupt) call.onInterrupt(); return {}; }, setPermissionMode: async () => {}, setModel: async () => {} };
    call.q = q; return q;
  } };
  async function* defaultScript({ call }) {
    await sleep(5);
    yield { type: "system", subtype: "init", session_id: call.options.resume || "native-" + sdkCalls.length, model: call.options.model };
    yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "Synthetic reply." }] } };
    yield { type: "result", subtype: "success", is_error: false, session_id: call.options.resume || "native-" + sdkCalls.length, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };
    await call.consumed;
  }
  let turnSeq = 0;
  const appserver = {
    ctxKeyOf: () => "login",
    async run(opts) {
      const id = opts.resumeId || "native-openai-" + (appCalls.length + 1), isNew = !opts.resumeId;
      const call = { prompt: opts.promptText, resume: opts.resumeId || null, id, opts }; appCalls.push(call);
      opts.on.onThreadId(id, isNew, "login");
      try { await opts.beforeTurn(id, isNew); } catch (e) { return { ok: false, error: "conversation transfer failed: " + e.message, threadId: id }; }
      opts.on.onTurnId("turn-" + (++turnSeq));
      if (control.app) return control.app(opts, call);
      return { ok: true, text: "Codex reply.", threadId: id };
    },
    async injectItems() { return { ok: true }; }, interrupt: async () => true, steer: async () => ({ ok: true }),
  };
  const providers = {
    get: (p) => ({ label: p === "openai" ? "OpenAI" : p === "custom" ? "Custom API" : "Anthropic", models: p === "openai" ? [{ id: "gpt-5.5", ctx: 272000 }] : [{ id: "claude-opus-4-8", ctx: 200000, ctx1m: true }], defaultModel: p === "openai" ? "gpt-5.5" : p === "custom" ? "" : "claude-opus-4-8", defaultReasoning: p === "openai" ? "medium" : "high", primary: "sdk" }),
    context1M: () => true, resolveOpenAIModelStrict: (id) => ({ model: id || "gpt-5.5" }), resolveOpenAIModel: (id) => ({ model: id || "gpt-5.5" }), openaiEffortStrict: (e) => ({ effort: e || "medium" }), openaiEffort: () => "medium",
  };
  const map = { path, fs, os, crypto: require("crypto"), child_process: require("child_process"), "./store": store, "./history": history, "./cli-auth": {}, "./attachments": { persistAll: (a) => a, light: (a) => a, readBase64: () => "" }, "./tool-args": require(path.join(ROOT, "src/main/session/tool-args.js")), "./subagents": require(path.join(ROOT, "src/main/agents/subagents.js")), "./convo": require(path.join(ROOT, "src/main/storage/convo.js")), "./catalog": providers, "./codex-appserver": appserver, "./codex-exec": { run: async () => ({ ok: true, text: "" }) }, "./codex-cards": { unwrapCmd: (x) => x, parseDiff: () => ({ oldText: "", newText: "", added: 0, removed: 0 }), classifyCmd: () => null }, "./council": { reviewerRun: async () => ({ ok: true, text: "advice" }), label: () => "Reviewer" }, "./custom-api": { getEndpoint: () => null, call: async () => ({ ok: true, text: "custom" }) }, "./platform": require(path.join(ROOT, "src/main/platform.js")) };
  const { M } = loadSessionInVm({ deps: map, sdk });
  M.send = (name, data) => sends.push({ name, data: JSON.parse(JSON.stringify(data)), t: Date.now() });
  M.buildEnv = () => ({}); M.resolveCli = async () => "claude"; M.composeMcp = () => ({}); M.registerModel = () => {}; M.scheduleRetry = () => {};
  M.setSummarizer(async () => "summary");
  M.resultReleaseGraceMs = 30;
  const make = (opts = {}) => { const v = store.createSession({ cwd: HOME, name: opts.name || "planner", model: opts.model || "claude-opus-4-8", thinking: opts.thinking || "low", permissionMode: opts.permissionMode || "default" }); store.flush(v.id); const s = store.getSession(v.id); if (opts.messages) { s.messages.push(...opts.messages); store.flush(v.id); } return s; };
  const setWorkflow = (wf) => store.saveSettings({ workflow: wf });
  // the synthesize IPC handler, extracted UNCHANGED from src/main/ipc/sessions.js
  const handlers = {};
  const handlerSrc = src.sessions.slice(src.sessions.indexOf('  handle("sessions:synthesize"'), src.sessions.indexOf('  handle("sessions:get"'));
  vm.runInNewContext(handlerSrc, { handle: (n, fn) => { handlers[n] = fn; }, store, claude: M, require: (n) => { if (/history$/.test(n)) return history; throw new Error(n); } });
  const updates = () => sends.filter((x) => x.name === "tasks:update").map((x) => x.data);
  return { M, make, sends, sdkCalls, appCalls, control, setWorkflow, updates, synthesize: (id) => handlers["sessions:synthesize"](null, id) };
}
const D = () => store.workflowDefaults();
const BANNED = /caveman|frugal|codefrugal|readgate|ROTATE_TURNS|contextHandoff|rotateSession|convoDigest|HANDOFF_|BATCH_PROMPT_CAP|_imgHashes|imageHash|CLAUDE_CODE_MAX_WEB_SEARCHES|ENABLE_PROMPT_CACHING_1H|MAKEFLAGS|maxBudgetUsd|taskBudget|isTrivialContinuation|resolveThinkingLevel|fallbackModel|maybeHeal|_healTurn|planHeal|truncateDeep|session-context/;
const EMPTY = { seq: 0, setSeq: 0, sets: [], items: [] };
const SET_KEYS = ["id", "n", "title", "status", "createdTs", "closedTs", "by"];
const ITEM_KEYS = ["id", "n", "setId", "title", "detail", "status", "role", "jobIds", "notes", "createdTs", "updatedTs", "doneTs"];
const sameKeys = (o, keys) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify(keys.slice().sort());
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fails = async (fn) => { try { await fn(); return null; } catch (x) { return x; } };
const failsSync = (fn) => { try { fn(); return null; } catch (x) { return x; } };
const cards = (s) => s.messages.filter((m) => m.role === "tasks");

async function main() {
  // ---- T01: defaults + normalisation ----
  { const e = environment(); const s = e.make();
    const b = e.M.boardFor(s);
    check("T01", "a new session has the empty board { seq: 0, setSeq: 0, sets: [], items: [] }; boardFor adds active: null and zero counts; a missing / unknown session never throws", eq(s.tasks, EMPTY) && eq(b, { ...EMPTY, active: null, counts: { total: 0, open: 0, done: 0 } }) && eq(e.M.boardFor(null), b) && eq(e.M.boardFor("no-such-session"), b) && eq(e.M.boardFor(undefined), b) && e.M.boardSummaryText(s) === "" && e.M.taskInfo(s.id, "T1") === null && e.M.taskInfo("nope", 1) === null, { tasks: s.tasks, b });
    const legacy = e.make(); legacy.tasks = ["legacy", "list"];
    const orphan = e.make(); orphan.tasks = { items: [{ id: "x", title: "orphan", n: 1 }] };   // no sets → the item has no home
    const messy = store.normalizeTasks({ seq: "3", sets: [{ id: "s1", status: "active", by: 7 }, { id: "s2", status: "active", title: "  Two  " }, null, { id: "s1" }], items: [{ id: "i1", setId: "s1", title: "A", status: "weird", role: "nobody", n: 0, notes: [{ text: "n1" }, "junk", { by: "u" }], jobIds: ["j", 3] }, { id: "i2", setId: "s2", title: "B", n: 7, status: "done", role: "coder" }, { id: "i3", setId: "gone", title: "C" }, { id: "i4", setId: "s2", title: "   " }, { id: "i2", setId: "s2", title: "dup" }] });
    check("T01b", "normalisation: a legacy array → empty; items whose set is gone / blank titles / duplicate ids are dropped; unknown status → todo, unknown role → null, notes need text, jobIds strings; numbering never goes backwards (seq = max, a 0 gets the next number); untitled sets are 'Set <n>'; only the NEWEST active set stays active, the other is closed (open item) — and the result is the exact contract shape", eq(e.M.boardFor(legacy), { ...EMPTY, active: null, counts: { total: 0, open: 0, done: 0 } }) && eq(legacy.tasks, EMPTY) && e.M.boardFor(orphan).items.length === 0 && messy.sets.length === 2 && messy.items.length === 2 && messy.seq === 8 && messy.setSeq === 2 && messy.sets[0].n === 1 && messy.sets[0].title === "Set 1" && messy.sets[0].status === "closed" && messy.sets[0].by === "orchestrator" && messy.sets[1].n === 2 && messy.sets[1].title === "Two" && messy.sets[1].status === "active" && messy.sets[1].closedTs === null && messy.items[0].n === 8 && messy.items[0].status === "todo" && messy.items[0].role === null && eq(messy.items[0].notes, [{ ts: "", by: "", text: "n1" }]) && eq(messy.items[0].jobIds, ["j"]) && messy.items[1].n === 7 && messy.items[1].status === "done" && messy.items[1].role === "coder" && messy.sets.every((x) => sameKeys(x, SET_KEYS)) && messy.items.every((x) => sameKeys(x, ITEM_KEYS)) && eq(store.normalizeTasks(undefined), EMPTY) && eq(store.normalizeTasks("nope"), EMPTY), messy);
    const doneBoth = store.normalizeTasks({ sets: [{ id: "a", n: 1, status: "active" }, { id: "b", n: 2, status: "active" }], items: [{ id: "i", setId: "a", n: 1, title: "t", status: "dropped" }] });
    check("T01c", "…and an older active set whose items are all terminal becomes 'done' (closedTs stamped); normalizeTasks returns a fresh copy (never the object passed in)", doneBoth.sets[0].status === "done" && typeof doneBoth.sets[0].closedTs === "string" && doneBoth.sets[1].status === "active" && (() => { const raw = { seq: 1, setSeq: 1, sets: [{ id: "a", n: 1, status: "active", title: "T" }], items: [] }; const out = store.normalizeTasks(raw); return out !== raw && out.sets[0] !== raw.sets[0] && eq(out.sets[0].title, "T"); })(), doneBoth); }

  // ---- T02: addTasks → Set 1 with T1..Tn, the card, the event ----
  { const e = environment(); const s = e.make();
    const res = e.M.addTasks(s.id, { titles: ["Alpha", "Beta ", " Gamma", "", "  "] });
    const set = res.set, items = res.items;
    const card = cards(s)[0];
    const up = e.updates();
    check("T02", "addTasks(titles) opens Set 1 ('Set 1', active, by orchestrator — the CLI's default actor) with T1..T3 (todo, no role, empty notes / jobIds, timestamps, doneTs null); blank titles are skipped; the counters advance", set && set.n === 1 && set.title === "Set 1" && set.status === "active" && set.by === "orchestrator" && set.closedTs === null && sameKeys(set, SET_KEYS) && items.length === 3 && items.map((i) => i.n).join() === "1,2,3" && items.map((i) => i.title).join("|") === "Alpha|Beta|Gamma" && items.every((i) => i.setId === set.id && i.status === "todo" && i.role === null && eq(i.jobIds, []) && eq(i.notes, []) && i.detail === "" && typeof i.createdTs === "string" && i.updatedTs === i.createdTs && i.doneTs === null && sameKeys(i, ITEM_KEYS)) && s.tasks.seq === 3 && s.tasks.setSeq === 1 && s.tasks.sets.length === 1 && s.tasks.items.length === 3, res);
    check("T02b", "the orchestrator gets ONE role:'tasks' card for the set — { id, role, setId, text: set.title, ts, meta: { setN, title, status, items: [{ n, title, status, role }] } } — sent as session:message; the card is app-side (not a history message)", cards(s).length === 1 && card.setId === set.id && card.text === "Set 1" && typeof card.ts === "string" && sameKeys(card, ["id", "role", "setId", "text", "ts", "meta"]) && eq(card.meta, { setN: 1, title: "Set 1", status: "active", items: [{ n: 1, title: "Alpha", status: "todo", role: null }, { n: 2, title: "Beta", status: "todo", role: null }, { n: 3, title: "Gamma", status: "todo", role: null }] }) && e.sends.some((x) => x.name === "session:message" && x.data.sessionId === s.id && x.data.message.id === card.id && x.data.message.role === "tasks") && history.isHistoryMessage(card) === false, card);
    check("T02c", "tasks:update { sessionId, board } is emitted with the WHOLE board (sets, items, seq, setSeq, active = the set id, counts)", up.length === 1 && up[0].sessionId === s.id && up[0].board.active === set.id && up[0].board.items.length === 3 && up[0].board.sets.length === 1 && up[0].board.seq === 3 && up[0].board.setSeq === 1 && eq(up[0].board.counts, { total: 3, open: 3, done: 0 }) && eq(up[0].board, e.M.boardFor(s)), up[0]);
    const res2 = e.M.addTasks(s.id, { titles: ["Eps"], items: [{ title: "Delta", detail: "  the detail ", role: "code" }, "Zeta", { title: "" }, null], role: "tester", detail: "d" }, { by: "user" });
    const patch = e.sends.filter((x) => x.name === "session:message-update" && x.data.messageId === card.id).pop();
    check("T02d", "more tasks while the set has open items APPEND to it (T4..T6): the items form carries detail / role (aliases accepted), top-level role / detail apply to the titles; the card is patched with the FULL meta; no new card or set", res2.set.id === set.id && res2.items.map((i) => i.n + ":" + i.title + ":" + (i.role || "-") + ":" + i.detail).join("|") === "4:Eps:tester:d|5:Delta:coder:the detail|6:Zeta:tester:d" && s.tasks.sets.length === 1 && cards(s).length === 1 && patch && eq(patch.data.patch, { meta: { setN: 1, title: "Set 1", status: "active", items: s.tasks.items.map((i) => ({ n: i.n, title: i.title, status: i.status, role: i.role })) } }) && patch.data.patch.meta.items.length === 6 && e.updates().length === 2, { res2, patch: patch && patch.data.patch });
    const noTitle = failsSync(() => e.M.addTasks(s.id, { titles: ["  "] })), badRole = failsSync(() => e.M.addTasks(s.id, { titles: ["x"], role: "wizard" })), noSession = failsSync(() => e.M.addTasks("nope", { titles: ["x"] }));
    check("T02e", "no usable title, an unknown role and a missing session are plain errors — nothing added, no event", noTitle && /task title is required/.test(noTitle.message) && badRole && /Unknown role "wizard"/.test(badRole.message) && noSession && /session was not found/.test(noSession.message) && s.tasks.items.length === 6 && e.updates().length === 2, { noTitle: noTitle && noTitle.message, badRole: badRole && badRole.message }); }

  // ---- T03: updateTask — statuses, notes, ref forms, errors ----
  { const e = environment(); const s = e.make();
    e.M.addTasks(s.id, { titles: ["Alpha", "Beta", "Gamma"] });
    const [i1, i2, i3] = s.tasks.items;
    const a = e.M.updateTask(s.id, "T1", { status: "start" });
    const b = e.M.updateTask(s.id, 1, { status: "done", note: "  shipped " });
    const c = e.M.updateTask(s.id, i2.id, { role: "review", title: " Beta renamed ", detail: " more " }, { by: "user" });
    const d = e.M.updateTask(s.id, "t3", { status: "block", note: "waiting on API keys" }, { by: "user" });
    check("T03", "updateTask by 'T1' / 1 / id / 't3': status words map to the contract's (start → doing, block → blocked), done stamps doneTs, a note is appended as { ts, by, text } (trimmed, `by` recorded), role / title / detail change (trimmed), updatedTs moves; the returned item is a copy", a.status === "doing" && a.doneTs === null && b.status === "done" && typeof b.doneTs === "string" && b.notes.length === 1 && b.notes[0].text === "shipped" && b.notes[0].by === "orchestrator" && typeof b.notes[0].ts === "string" && c.role === "reviewer" && c.title === "Beta renamed" && c.detail === "more" && c.status === "todo" && d.status === "blocked" && d.notes[0].by === "user" && d.notes[0].text === "waiting on API keys" && i1.status === "done" && i2.title === "Beta renamed" && i3.status === "blocked" && b !== i1 && e.M.taskInfo(s.id, "T3").status === "blocked" && e.M.taskInfo(s.id, 2).title === "Beta renamed" && e.M.taskInfo(s.id, i1.id).doneTs === i1.doneTs && e.M.taskInfo(s.id, "T99") === null, { a, b, c, d });
    const badStatus = failsSync(() => e.M.updateTask(s.id, "T1", { status: "banana" })), badRef = failsSync(() => e.M.updateTask(s.id, "T99", { status: "done" })), badRole = failsSync(() => e.M.updateTask(s.id, "T1", { role: "wizard" })), emptyTitle = failsSync(() => e.M.updateTask(s.id, "T1", { title: "  " }));
    const before = JSON.stringify(s.tasks);
    const badMix = failsSync(() => e.M.updateTask(s.id, "T2", { status: "doing", role: "nobody" }));
    check("T03b", "a bad status / unknown ref / unknown role / empty title are plain errors; validation happens BEFORE anything changes (a patch with one bad field leaves the task untouched)", badStatus && /Unknown task status "banana"/.test(badStatus.message) && badRef && /No task "T99" on this board/.test(badRef.message) && badRole && /Unknown role "wizard"/.test(badRole.message) && emptyTitle && /title cannot be empty/.test(emptyTitle.message) && badMix && JSON.stringify(s.tasks) === before && i2.status === "todo", { badStatus: badStatus && badStatus.message, badRef: badRef && badRef.message });
    const reopened = e.M.updateTask(s.id, "T1", { status: "todo" });
    const same = e.M.updateTask(s.id, "T1", { status: "done" }); const ts1 = same.doneTs;
    const again = e.M.updateTask(s.id, "T1", { status: "done", note: "still done" });
    check("T03c", "reopening clears doneTs; setting the same status again keeps doneTs; every status of the contract is accepted (review, test, dropped …)", reopened.doneTs === null && reopened.status === "todo" && typeof ts1 === "string" && again.doneTs === ts1 && again.notes.length === 2 && ["review", "test", "dropped", "doing", "blocked", "todo", "done"].every((st) => e.M.updateTask(s.id, "T2", { status: st }).status === st), { reopened: reopened.doneTs, ts1, again: again.doneTs });
    const card = cards(s)[0]; const patches = e.sends.filter((x) => x.name === "session:message-update" && x.data.messageId === card.id);
    check("T03d", "every update patches the set's card with the FULL meta (setN / title / status / items with n, title, status, role) and emits tasks:update", patches.length >= 6 && patches.every((p) => eq(Object.keys(p.data.patch), ["meta"]) && sameKeys(p.data.patch.meta, ["setN", "title", "status", "items"]) && p.data.patch.meta.items.length === 3 && p.data.patch.meta.items.every((i) => sameKeys(i, ["n", "title", "status", "role"]))) && patches[patches.length - 1].data.patch.meta.items[1].title === "Beta renamed" && e.updates().length === patches.length + 1, { n: patches.length, last: patches[patches.length - 1] && patches[patches.length - 1].data.patch }); }

  // ---- T04: the set closes as "done" when its last open item finishes; the next add opens Set 2 ----
  { const e = environment(); const s = e.make();
    e.M.addTasks(s.id, { titles: ["A", "B", "C"] });
    e.M.updateTask(s.id, "T1", { status: "done" }); e.M.updateTask(s.id, "T2", { status: "dropped" });
    const stillOpen = s.tasks.sets[0].status;
    const last = e.M.updateTask(s.id, "T3", { status: "done", note: "last one" });
    const set1 = s.tasks.sets[0];
    const patch = e.sends.filter((x) => x.name === "session:message-update" && x.data.messageId === cards(s)[0].id).pop();
    check("T04", "with an item still open the set stays active; when its LAST open item finishes (done or dropped count as terminal) the set becomes 'done' with closedTs, its card shows status done, no set is active, and counts read 2 done / 0 open of 3", stillOpen === "active" && last.status === "done" && set1.status === "done" && typeof set1.closedTs === "string" && patch.data.patch.meta.status === "done" && e.M.boardFor(s).active === null && eq(e.M.boardFor(s).counts, { total: 3, open: 0, done: 2 }) && s.tasks.sets.length === 1, { set1, counts: e.M.boardFor(s).counts });
    const res = e.M.addTasks(s.id, { titles: ["D", "E"] });
    const set2 = s.tasks.sets[1];
    check("T04b", "new tasks after that open Set 2 (auto-titled 'Set 2', active) with T4, T5 — session-wide numbering continues; a SECOND card is added for the new set; Set 1 stays 'done' and visible", res.set.id === set2.id && set2.n === 2 && set2.title === "Set 2" && set2.status === "active" && res.items.map((i) => i.n).join() === "4,5" && res.items.every((i) => i.setId === set2.id) && cards(s).length === 2 && cards(s)[1].setId === set2.id && cards(s)[1].text === "Set 2" && cards(s)[1].meta.items.length === 2 && s.tasks.sets[0].status === "done" && e.M.boardFor(s).active === set2.id && s.tasks.items.length === 5, { res, sets: s.tasks.sets });
    e.M.updateTask(s.id, "T4", { status: "done" }); e.M.updateTask(s.id, "T5", { status: "done" });
    const back = e.M.updateTask(s.id, "T1", { status: "todo" });
    check("T04c", "an item of a finished set reopened while NO set is active brings that set back as the active one (its closedTs cleared)", back.status === "todo" && s.tasks.sets[1].status === "done" && s.tasks.sets[0].status === "active" && s.tasks.sets[0].closedTs === null && e.M.boardFor(s).active === s.tasks.sets[0].id, s.tasks.sets); }

  // ---- T05: an explicit set title closes the current set as "closed" while it has open items ----
  { const e = environment(); const s = e.make();
    e.M.addTasks(s.id, { titles: ["Old 1", "Old 2"] });
    e.M.updateTask(s.id, "T1", { status: "done" });
    const res = e.M.addTasks(s.id, { titles: ["Pay 1", "Pay 2"], set: { title: "  Payments " } }, { by: "planner" });
    const [set1, set2] = s.tasks.sets;
    const p1 = e.sends.filter((x) => x.name === "session:message-update" && x.data.messageId === cards(s)[0].id).pop();
    check("T05", "addTasks with set.title while the active set has open items: the previous set becomes 'closed' (closedTs, card patched), the new set opens with that title (trimmed) as Set 2 and takes the tasks; two cards", res.set.title === "Payments" && res.set.n === 2 && set2.status === "active" && set1.status === "closed" && typeof set1.closedTs === "string" && p1.data.patch.meta.status === "closed" && res.items.map((i) => i.n).join() === "3,4" && res.items.every((i) => i.setId === set2.id) && cards(s).length === 2 && cards(s)[1].text === "Payments" && cards(s)[1].meta.title === "Payments" && cards(s)[1].meta.setN === 2, { sets: s.tasks.sets, res });
    const res3 = e.M.addTasks(s.id, { titles: ["R1"], set: "Refunds" });
    e.M.updateTask(s.id, "T2", { status: "done" });
    check("T05b", "a string `set` works too (Set 3 'Refunds'); Set 2 with open items → closed; finishing the last open item of a CLOSED set turns it 'done'; the summary lists every set with counts", res3.set.title === "Refunds" && res3.set.n === 3 && s.tasks.sets[1].status === "closed" && s.tasks.sets[0].status === "done" && s.tasks.sets[0].closedTs && s.tasks.sets.length === 3 && cards(s).length === 3 && /^Task board — Set 3 “Refunds” \(0 of 1 done\): T5 todo “R1”\nOther sets: Set 2 “Payments” \(0 of 2 done\) closed · Set 1 “Set 1” \(2 of 2 done\) done$/.test(e.M.boardSummaryText(s)), { sets: s.tasks.sets, text: e.M.boardSummaryText(s) }); }

  // ---- T06: openTaskSet / removeTask ----
  { const e = environment(); const s = e.make();
    e.M.addTasks(s.id, { titles: ["A"] });
    const set2 = e.M.openTaskSet(s.id, " Manual ", { by: "user" });
    const added = e.M.addTasks(s.id, { titles: ["M1", "M2"] });
    check("T06", "openTaskSet opens an explicit set (title trimmed, by recorded, active, card added) and closes the current one ('closed' — A is open); the EMPTY new set receives the next tasks (it is not skipped as 'every item terminal')", set2.n === 2 && set2.title === "Manual" && set2.by === "user" && set2.status === "active" && sameKeys(set2, SET_KEYS) && s.tasks.sets[0].status === "closed" && added.set.id === set2.id && added.items.map((i) => i.n).join() === "2,3" && s.tasks.setSeq === 2 && cards(s).length === 2 && cards(s)[1].setId === set2.id && cards(s)[1].text === "Manual", { set2, added, sets: s.tasks.sets });
    const set3 = e.M.openTaskSet(s.id, "");
    check("T06b", "an empty title gives 'Set <n>'; the previous set with open items is closed", set3.title === "Set 3" && set3.n === 3 && s.tasks.sets[1].status === "closed" && e.M.boardFor(s).active === set3.id, set3);
    const n = e.updates().length;
    const ok = e.M.removeTask(s.id, "T2");
    const gone = e.M.removeTask(s.id, 3);
    const err = failsSync(() => e.M.removeTask(s.id, "T2"));
    check("T06c", "removeTask (user action) removes the task → true; the emptied finished set becomes 'done'; the card of that set is patched (no items); an unknown ref is a plain error; events emitted", ok === true && gone === true && e.M.taskInfo(s.id, "T2") === null && e.M.taskInfo(s.id, "T3") === null && s.tasks.items.length === 1 && s.tasks.items[0].n === 1 && s.tasks.sets[1].status === "done" && err && /No task "T2"/.test(err.message) && e.sends.filter((x) => x.name === "session:message-update" && x.data.messageId === cards(s)[1].id).pop().data.patch.meta.items.length === 0 && e.updates().length === n + 2 && e.M.boardFor(s).counts.total === 1, { sets: s.tasks.sets, items: s.tasks.items });
    e.M.removeTask(s.id, "T1");
    check("T06d", "removing the last item of the ACTIVE set leaves it active (an empty active set is fine); removing the last item of a finished set never reactivates it", s.tasks.sets[2].status === "active" && s.tasks.sets[0].status === "done" && s.tasks.items.length === 0 && e.M.boardFor(s).active === set3.id, s.tasks.sets); }

  // ---- T07: bounding — 400 items / 60 sets, the oldest DONE sets pruned first ----
  { const e = environment(); const s = e.make();
    e.M.addTasks(s.id, { titles: Array.from({ length: 10 }, (_, i) => "first " + i) });
    for (let i = 1; i <= 10; i++) e.M.updateTask(s.id, i, { status: "done" });
    e.M.addTasks(s.id, { titles: Array.from({ length: 200 }, (_, i) => "second " + i) });   // Set 2 (open) — 210 items
    e.M.addTasks(s.id, { titles: Array.from({ length: 190 }, (_, i) => "third " + i) });    // appended to Set 2 → 400 items, both sets present
    const at400 = { items: s.tasks.items.length, sets: s.tasks.sets.length };
    const res = e.M.addTasks(s.id, { titles: ["the 401st"] });
    check("T07", "the 401st item prunes the OLDEST DONE set (Set 1 with its 10 items): 391 items remain, Set 2 alone, numbering untouched (T401 exists, T1 gone), the added item survives", at400.items === 400 && at400.sets === 2 && s.tasks.items.length === 391 && s.tasks.sets.length === 1 && s.tasks.sets[0].n === 2 && s.tasks.items[0].n === 11 && res.items[0].n === 401 && e.M.taskInfo(s.id, "T401").title === "the 401st" && e.M.taskInfo(s.id, "T1") === null && s.tasks.seq === 401 && e.M.boardFor(s).counts.total === 391, { at400, now: s.tasks.items.length, sets: s.tasks.sets.map((x) => x.n) });
    e.M.addTasks(s.id, { titles: Array.from({ length: 20 }, (_, i) => "over " + i) });   // 411 in the ACTIVE set alone → its oldest items go
    check("T07b", "when the active set alone is over the limit its oldest items are dropped (terminal ones first, here none), keeping 400 — the newest survive", s.tasks.items.length === 400 && s.tasks.items[0].n === 22 && s.tasks.items[399].n === 421 && s.tasks.sets.length === 1, { first: s.tasks.items[0].n, last: s.tasks.items[399].n });
    const s2 = e.make();
    for (let i = 1; i <= 61; i++) e.M.openTaskSet(s2.id, "S" + i);
    check("T07c", "61 sets → the oldest is pruned (60 kept, S2..S61, the active one last); the board summary stays under 3,000 characters and names every kept set or says how many more", s2.tasks.sets.length === 60 && s2.tasks.sets[0].title === "S2" && s2.tasks.sets[59].title === "S61" && s2.tasks.sets[59].status === "active" && s2.tasks.setSeq === 61 && e.M.boardSummaryText(s2).length <= 3000 && /Task board — Set 61 “S61” \(0 of 0 done\): no tasks yet\nOther sets: Set 60 “S60” \(0 of 0 done\) done · /.test(e.M.boardSummaryText(s2)) && e.M.boardSummaryText(s).length <= 3000 && /· … \d+ more$/m.test(e.M.boardSummaryText(s)), { len: e.M.boardSummaryText(s2).length, head: e.M.boardSummaryText(s2).slice(0, 140), big: e.M.boardSummaryText(s).slice(-60) }); }

  // ---- T08: boardSummaryText ----
  { const e = environment(); const s = e.make();
    e.M.addTasks(s.id, { titles: ["Wire the webhook", "Add retries", "Refund flow"], set: { title: "Payments" } });
    e.M.updateTask(s.id, "T1", { status: "done", role: "coder" }); e.M.updateTask(s.id, "T2", { status: "doing", role: "coder" }); e.M.updateTask(s.id, "T3", { status: "test", role: "tester" });
    const text = e.M.boardSummaryText(s), open = e.M.boardSummaryText(s, { openOnly: true });
    check("T08", "boardSummaryText: 'Task board — Set 1 “Payments” (1 of 3 done): T1 done coder “Wire the webhook” · T2 doing coder “Add retries” · T3 test tester “Refund flow”'; openOnly drops the finished ones; one set → no 'Other sets' line; a long title is shortened with …", text === "Task board — Set 1 “Payments” (1 of 3 done): T1 done coder “Wire the webhook” · T2 doing coder “Add retries” · T3 test tester “Refund flow”" && open === "Task board — Set 1 “Payments” (1 of 3 done): T2 doing coder “Add retries” · T3 test tester “Refund flow”" && (() => { e.M.addTasks(s.id, { titles: ["x".repeat(200)] }); const t = e.M.boardSummaryText(s); return t.includes("T4 todo “" + "x".repeat(59) + "…”") && !t.includes("x".repeat(61)); })(), { text, open });
    e.M.updateTask(s.id, "T4", { status: "dropped" }); e.M.updateTask(s.id, "T2", { status: "done" }); e.M.updateTask(s.id, "T3", { status: "done" });
    check("T08b", "with every set finished the summary says so and shows the latest set; dropped items count as neither open nor done", /^Task board — every set is finished; the latest is Set 1 “Payments” \(3 of 4 done\): T1 done coder “Wire the webhook” · T2 done coder “Add retries” · T3 done tester “Refund flow” · T4 dropped “xxx/.test(e.M.boardSummaryText(s)) && eq(e.M.boardFor(s).counts, { total: 4, open: 0, done: 3 }), e.M.boardSummaryText(s)); }

  // ---- T09: jobs — startRoleJob({ task: "T2" }) / taskRef → linkJobToTask, the child's prompt, the job-end note ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    e.M.addTasks(parent.id, { titles: ["Wire the webhook", "Add retries", "Refund flow"], set: { title: "Payments" } });
    e.M.updateTask(parent.id, "T2", { detail: "exponential backoff" });
    const item2 = () => e.M.taskInfo(parent.id, "T2");
    const before = store.listSessions().length;
    const job = await e.M.startRoleJob(parent.id, { role: "coder", task: "T2", from: "cli" });
    const linked = item2();
    const jobCard = parent.messages.find((m) => m.role === "job" && m.jobId === job.id);
    check("T09", "startRoleJob with a description that is just 'T2' takes that task: job.taskId / taskN set, job.task = the task's title (the tab name too), item.jobIds += job.id, status todo → doing, role coder; the job card's meta and the workflow:job event carry taskId / taskN", job.taskId === linked.id && job.taskN === 2 && job.task === "Add retries" && /Add retries/.test(store.getSession(job.sessionId).name) && eq(linked.jobIds, [job.id]) && linked.status === "doing" && linked.role === "coder" && jobCard && jobCard.meta.taskId === linked.id && jobCard.meta.taskN === 2 && e.sends.some((x) => x.name === "workflow:job" && x.data.job.id === job.id && x.data.job.taskN === 2 && x.data.job.taskId === linked.id) && store.listSessions().length === before + 1, { job: { taskId: job.taskId, taskN: job.taskN, task: job.task }, linked });
    const done = await e.M.waitJob(job.id, 10000);
    const call = e.sdkCalls[0];
    const after = item2();
    check("T09b", "the child's prompt is the task text followed by the labelled task line — 'Add retries\\n\\nTask T2 of set \"Payments\": Add retries — exponential backoff'; on job end the note '<role> job <id> <status>' is appended (by the role) and the STATUS is left as it is (doing)", done.status === "done" && call && call.prompts[0] === 'Add retries\n\nTask T2 of set "Payments": Add retries — exponential backoff' && after.notes.length === 1 && after.notes[0].text === `coder job ${job.id} done` && after.notes[0].by === "coder" && typeof after.notes[0].ts === "string" && after.status === "doing" && e.M.jobInfo(job.id).taskN === 2 && cards(parent)[0].meta.items[1].status === "doing", { prompt: call && call.prompts[0], after });
    const rj = await e.M.startRoleJob(parent.id, { role: "reviewer", task: "Review the retries", taskRef: "T2" });
    const rdone = await e.M.waitJob(rj.id, 10000);
    const rcall = e.appCalls[0];
    check("T09c", "a reviewer job with taskRef (description kept): the task moves doing → review, role reviewer, jobIds has both jobs; the Codex child's prompt starts with the description, then the task line, then the role brief; its end note names the reviewer job", rj.taskN === 2 && rj.task === "Review the retries" && item2().status === "review" && item2().role === "reviewer" && eq(item2().jobIds, [job.id, rj.id]) && rcall && rcall.prompt.startsWith('Review the retries\n\nTask T2 of set "Payments": Add retries — exponential backoff\n\nRole brief for this conversation') && rdone.status === "done" && item2().notes.length === 2 && item2().notes[1].text === `reviewer job ${rj.id} done` && item2().notes[1].by === "reviewer", { head: rcall && rcall.prompt.slice(0, 160), item: item2() });
    const tj = await e.M.startRoleJob(parent.id, { role: "tester", task: "Test T3", ref: 3, files: ["a.js", "b.js"] });
    await e.M.waitJob(tj.id, 10000);
    const tcall = e.sdkCalls[1];
    check("T09d", "a tester job with `ref: 3` and files: status todo → test, role tester; the prompt order is task text → task line (no detail → no dash) → files block", tj.taskN === 3 && e.M.taskInfo(parent.id, 3).status === "test" && e.M.taskInfo(parent.id, 3).role === "tester" && tcall && tcall.prompts[0] === 'Test T3\n\nTask T3 of set "Payments": Refund flow\n\nFiles of interest (named by the orchestrator):\n- a.js\n- b.js', { prompt: tcall && tcall.prompts[0] });
    const sessionsNow = store.listSessions().length, jobCards = parent.messages.filter((m) => m.role === "job").length, upd = e.updates().length;
    const bad = await fails(() => e.M.startRoleJob(parent.id, { role: "coder", task: "x", taskRef: "T99" }));
    const badBare = await e.M.startRoleJob(parent.id, { role: "coder", task: "T99" });   // no such task → an ordinary description
    await e.M.waitJob(badBare.id, 10000);
    // (the accepted job reuses the Coder's existing session when it is idle — one session per role, 2026-09-17 — so it adds a session only when none was free)
    check("T09e", "an unknown taskRef refuses the job BEFORE any child session / card / event exists; a bare 'T99' that matches no task is just an ordinary description (no link)", bad && /No task "T99" on this board/.test(bad.message) && store.listSessions().length === sessionsNow + (badBare.reused ? 0 : 1) && parent.messages.filter((m) => m.role === "job").length === jobCards + 1 && badBare.taskId === null && badBare.taskN === null && badBare.task === "T99" && e.sdkCalls[2].prompts[0] === "T99" && e.updates().length === upd, { bad: bad && bad.message, badBare: { taskId: badBare.taskId, task: badBare.task, reused: badBare.reused } });
    e.M.updateTask(parent.id, "T1", { status: "done" });
    const dj = await e.M.startRoleJob(parent.id, { role: "coder", task: "Polish", taskId: "T1" });
    await e.M.waitJob(dj.id, 10000);
    const cmd = await e.M.runCommandJob(parent.id, { command: "node -e \"console.log('OK')\"", taskRef: "T3" });
    const cdone = await e.M.waitJob(cmd.id, 20000);
    check("T09f", "a job on a FINISHED task leaves its status (done) and records the role; a command job accepts taskRef too (linked, status test, its end note 'tester job … done')", e.M.taskInfo(parent.id, 1).status === "done" && e.M.taskInfo(parent.id, 1).role === "coder" && dj.taskN === 1 && cmd.taskN === 3 && cdone.status === "done" && e.M.taskInfo(parent.id, 3).notes.some((n) => n.text === `tester job ${cmd.id} done` && n.by === "tester") && e.M.taskInfo(parent.id, 3).status === "test", { t1: e.M.taskInfo(parent.id, 1), t3notes: e.M.taskInfo(parent.id, 3).notes });
    const child = store.getSession(job.sessionId);
    const viaChild = e.M.addTasks(child.id, { titles: ["From the coder tab"] });
    check("T09g", "a CHILD job session addresses its orchestrator's board: addTasks / boardFor / taskInfo through the child land on the parent (the event names the parent), the child's own `tasks` stays empty", viaChild.items[0].n === 4 && e.M.taskInfo(parent.id, 4).title === "From the coder tab" && eq(e.M.boardFor(child), e.M.boardFor(parent)) && e.updates().pop().sessionId === parent.id && eq(child.tasks, EMPTY) && e.M.taskInfo(child.id, "T4").title === "From the coder tab", { viaChild, childTasks: child.tasks });
    // --from + --task (2026-09-18): the source job's saved result comes right after the task text, BEFORE the board task line
    const src = await e.M.startRoleJob(parent.id, { role: "planner", task: "Plan the retries" }); await e.M.waitJob(src.id, 10000);
    const hj = await e.M.startRoleJob(parent.id, { role: "coder", task: "Implement the retries", taskRef: "T2", fromJob: src.id, files: ["src/retry.js"] }); await e.M.waitJob(hj.id, 10000);
    const hcall = e.sdkCalls[e.sdkCalls.length - 1];
    check("T09h", "a job with --from AND --task: the child's prompt is the task text → the source job's saved result ('Result of planner job <id> (the plan):') → the labelled board task line → the files (the contract's order); the task is linked (jobIds gains the job, doing / coder) and the job carries taskN and fromJob", hcall && hcall.prompts[0] === `Implement the retries\n\nResult of planner job ${src.id} (the plan):\nSynthetic reply.\n\nTask T2 of set "Payments": Add retries — exponential backoff\n\nFiles of interest (named by the orchestrator):\n- src/retry.js` && hj.taskN === 2 && hj.fromJob === src.id && item2().jobIds.includes(hj.id) && item2().status === "doing" && item2().role === "coder", { prompt: hcall && hcall.prompts[0], item: item2() }); }

  // ---- T10: the orchestrator brief's §8.2 paragraph ----
  { const e = environment(); const d = D();
    e.setWorkflow({ ...d, enabled: true, name: "Team", roles: { ...d.roles, tester: { ...d.roles.tester, command: "npm test" } } });
    const s = e.make({ model: "claude-opus-4-8", thinking: "high", permissionMode: "acceptEdits" });
    const brief = e.M.orchestratorBrief(s, e.M.workflowFor(s), "anthropic");
    const P = 'Track delegated, multi-step work on this session\'s task board (a direct answer needs no board): create the tasks first (`atomnano tasks add "…" "…" --set "<title>"`), start / finish them as you go (`atomnano tasks start T3`, `atomnano tasks done T3 --note "…"`), hand one to a role with `atomnano run coder "…" --task T3` (planner → doing, reviewer → review, tester → test), and open a new set when a new batch of work begins. `atomnano tasks` shows the board.';
    check("T10", "the GENERATED orchestrator brief carries the §8.2 paragraph verbatim (as its own paragraph, after the CLI block, before the session id line), stays under 3,300 characters (compacted 2026-09-18), has no fences / headings and none of the banned tokens; the user's override is returned untouched (no paragraph added)", brief.includes("\n\n" + P + "\n\n") && brief.indexOf(P) > brief.indexOf("stop <id>") && brief.indexOf(P) < brief.indexOf("Your session id is") && brief.length < 3300 && !/```/.test(brief) && !/^#/m.test(brief) && !BANNED.test(brief) && e.M.orchestratorBrief(s, { ...e.M.workflowFor(s), brief: "MINE" }, "anthropic") === "MINE", { length: brief.length, brief });
    await e.M.run(s.id, { text: "PLAN" });
    check("T10b", "…and it reaches the orchestrator's run (Claude: inside systemPrompt.append)", e.sdkCalls[0] && e.sdkCalls[0].options.systemPrompt.append.includes(P) && e.sdkCalls[0].prompts[0] === "PLAN", { has: !!e.sdkCalls[0] }); }

  // ---- T11: synthesize copies the board; the seed carries the "Task board" block ----
  { const e = environment();
    const s = e.make({ messages: [{ id: "u1", role: "user", text: "GOAL: ship payments", ts: store.nowISO() }, { id: "a1", role: "assistant", text: "DONE: wired the webhook", ts: store.nowISO() }] });
    e.M.addTasks(s.id, { titles: ["Wire the webhook", "Add retries"], set: { title: "Payments" } });
    e.M.updateTask(s.id, "T1", { status: "done", role: "coder", note: "shipped" });
    const next = await e.synthesize(s.id);
    const full = store.getSession(next.id);
    const seed = next.messages[0];
    check("T11", "synthesize copies the WHOLE board to the new session (a deep copy with the same numbering — sets, items, notes; independent objects) and the view / meta expose it", eq(full.tasks, s.tasks) && full.tasks !== s.tasks && full.tasks.items[0] !== s.tasks.items[0] && full.tasks.items[0].notes !== s.tasks.items[0].notes && eq(next.tasks, s.tasks) && eq(store.getMeta(next.id).taskCounts, { total: 2, open: 1, done: 1 }) && eq(e.M.boardFor(full).counts, { total: 2, open: 1, done: 1 }), { copied: full.tasks });
    check("T11b", "the seed's text ends with the 'Task board' block after the session map (separated like the map), the head line announces it, the card's meta carries boardText, and the seed stays within its budget", seed.role === "record" && /---\n\nTask board — Set 1 “Payments” \(1 of 2 done\): T1 done coder “Wire the webhook” · T2 todo “Add retries”$/.test(seed.text) && seed.text.indexOf("[Session map") < seed.text.indexOf("Task board —") && /then the task board \(its sets and tasks with their status\)\./.test(seed.text) && seed.meta.boardText === e.M.boardSummaryText(s) && seed.text.length < 24000 + 600 && seed.meta.mode === "exact", { tail: seed.text.slice(-260), head: seed.text.slice(0, 300) });
    const plain = e.make({ messages: [{ id: "u2", role: "user", text: "hello", ts: store.nowISO() }, { id: "a2", role: "assistant", text: "hi", ts: store.nowISO() }] });
    const n2 = await e.synthesize(plain.id);
    check("T11c", "a source without tasks gets no board block (and an empty board copy); a source with tasks but NO messages still seeds the board", !/Task board/.test(n2.messages[0].text) && !/task board/.test(n2.messages[0].text) && eq(store.getSession(n2.id).tasks, EMPTY) && (await (async () => { const t = e.make(); e.M.addTasks(t.id, { titles: ["Only a task"] }); const nn = await e.synthesize(t.id); return nn.messages.length === 1 && /Task board — Set 1 “Set 1” \(0 of 1 done\): T1 todo “Only a task”/.test(nn.messages[0].text) && eq(store.getSession(nn.id).tasks, t.tasks); })()), { text: n2.messages[0].text.slice(0, 200) }); }

  // ---- T12: persistence round-trip ----
  { const e = environment(); const s = e.make();
    e.M.addTasks(s.id, { titles: ["Persist me", "And me"], set: { title: "Durable" } });
    e.M.updateTask(s.id, "T1", { status: "done", role: "coder", note: "kept" });
    const snapshot = JSON.parse(JSON.stringify(s.tasks));
    store.flush(s.id); store.loadAllSessions();
    const re = store.getSession(s.id), view = store.getSessionView(s.id), meta = store.getMeta(s.id);
    check("T12", "the board survives a reload through normalizeSession exactly (sets, items, notes, counters), getSessionView exposes `tasks` (a copy) and metaOf carries taskCounts { total, open, done }", eq(re.tasks, snapshot) && eq(view.tasks, snapshot) && view.tasks !== re.tasks && eq(meta.taskCounts, { total: 2, open: 1, done: 1 }) && eq(store.listSessions().find((m) => m.id === s.id).taskCounts, { total: 2, open: 1, done: 1 }), { re: re.tasks, meta });
    const rawId = store.writeSessionRaw({ id: "raw-board-1", name: "raw", cwd: HOME, messages: [], tasks: { seq: 2, setSeq: 1, sets: [{ id: "s1", n: 1, title: "Raw", status: "active", createdTs: "2026-01-01T00:00:00.000Z", closedTs: null, by: "planner" }], items: [{ id: "i1", n: 1, setId: "s1", title: "A", detail: "", status: "doing", role: "coder", jobIds: [], notes: [], createdTs: "2026-01-01T00:00:00.000Z", updatedTs: "2026-01-01T00:00:00.000Z", doneTs: null }, { id: "i2", n: 2, setId: "s1", title: "B", status: "nope", role: 3 }] } });
    store.loadAllSessions();
    const raw = store.getSession(rawId);
    const legacyId = store.writeSessionRaw({ id: "raw-board-2", name: "legacy", cwd: HOME, messages: [], tasks: [{ title: "old list" }] });
    check("T12b", "writeSessionRaw keeps a valid board (a malformed item is cleaned: status → todo, role → null, missing fields filled) and a legacy shape loads as an empty board; a session without `tasks` has the empty board and zero taskCounts", raw.tasks.sets.length === 1 && raw.tasks.items.length === 2 && raw.tasks.items[0].status === "doing" && raw.tasks.items[1].status === "todo" && raw.tasks.items[1].role === null && raw.tasks.items[1].detail === "" && eq(raw.tasks.items[1].notes, []) && typeof raw.tasks.items[1].createdTs === "string" && eq(store.getMeta(rawId).taskCounts, { total: 2, open: 2, done: 0 }) && eq(store.getSession(legacyId).tasks, EMPTY) && eq(store.getSession(store.createSession({ cwd: HOME, name: "plain" }).id).tasks, EMPTY) && eq(store.getMeta(legacyId).taskCounts, { total: 0, open: 0, done: 0 }), { raw: raw.tasks, legacy: store.getSession(legacyId).tasks });
    e.M.updateTask(s.id, "T2", { status: "done" });
    await sleep(500);   // scheduleWrite → flush (400 ms) refreshes the index
    check("T12c", "a change persists on its own (scheduleWrite): after the write the file and the index reflect it", JSON.parse(fs.readFileSync(path.join(store.getSettings().historyDir, s.id + ".json"), "utf8")).tasks.items[1].status === "done" && eq(store.getMeta(s.id).taskCounts, { total: 2, open: 0, done: 2 }), store.getMeta(s.id).taskCounts); }

  clearTimeout(watchdog);
  console.log(`Tasks: ${pass} passed, ${failN} failed`);
  if (failures.length) console.log("Failures:\n  " + failures.join("\n  "));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failN ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
