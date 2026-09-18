"use strict";
/* Workflow control server + `atomnano` CLI + workflow IPC — DESIRED behaviour (docs/WORKFLOW_CONTRACT.md §4–§6, task board §8.3):
 *   · the control server listens on 127.0.0.1, demands the bearer token (401 otherwise), exports
 *     ATOMNANO_CONTROL / ATOMNANO_TOKEN / ATOMNANO_NODE + prepends bin/ to PATH, writes control.json;
 *   · every /v1 route answers JSON and never throws (400/404/405/413 as plain { error } sentences);
 *   · session resolution: explicit → the single running planner → 400 listing candidates;
 *   · the CLI (src/cli/index.js) speaks to it end to end with the contract's exit codes (0/1/2/3),
 *     discovers the app through env or control.json, and the bin/ shims run it;
 *   · the source-job handoff (2026-09-18): `--from <job id>` → POST /jobs body `from` → startRoleJob({ from: "cli",
 *     fromJob }); blank / unknown / foreign / running sources refused (CLI exit 1 before any request, server 400 / 404),
 *     `test --cmd … --from` refused; and the 540 s wait pattern sliced into 240 s long-polls (a fake client, no waiting);
 *   · the workflow:* IPC handlers manage the active workflow + the library (save/load/rename/duplicate/
 *     delete/export/import) and proxy jobs / brief / control;
 *   · the TASK BOARD (§8.3): /v1/tasks routes (default view = active set + last two finished sets, all=1
 *     everything; manager errors → 400, unknown ref → 404), `atomnano tasks …` end to end, --task on jobs,
 *     and the tasks:* IPC handlers (user actions → by "user").
 * No Electron, no network beyond loopback, no model calls: a FAKE session manager (in-memory jobs + board)
 * and a fake store stand in for the other workers' code.  Run: node scripts/test-workflow-cli.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawn, spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-wfcli-"));
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, "claude-home"); fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

// `electron` is only needed by ipc/workflow.js (dialog) — a stub whose dialogs cancel.
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === "electron") return { app: { getPath: (k) => (k === "userData" ? HOME : os.homedir()), getAppPath: () => ROOT, isPackaged: false, getVersion: () => "test" }, dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) }, ipcMain: { handle() {}, on() {} } };
  return origLoad.call(this, req, ...rest);
};

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence !== undefined ? JSON.stringify(evidence).slice(0, 700) : ""}`); } }
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 90000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = require(path.join(ROOT, "src/main/control/server.js"));
const cli = require(path.join(ROOT, "src/cli/index.js"));
const client = require(path.join(ROOT, "src/cli/client.js"));

/* ---- fake task board (contract §8.1 rules, in memory): one board per session id. boardFor() takes the
 * session record (or an id); refs are "T12" | 12 | id. Every mutating call is recorded with its `by`. ---- */
function fakeBoard() {
  const boards = new Map();
  const TERM = new Set(["done", "dropped"]);
  const STATUS = ["todo", "doing", "review", "test", "done", "blocked", "dropped"];
  const bd = (id) => { if (!boards.has(id)) boards.set(id, { seq: 0, setSeq: 0, sets: [], items: [] }); return boards.get(id); };
  const idOf = (s) => (typeof s === "string" ? s : s && s.id);
  const active = (b) => b.sets.find((s) => s.status === "active") || null;
  const itemsOf = (b, set) => b.items.filter((i) => i.setId === set.id);
  const closeActive = (b) => { const a = active(b); if (!a) return; a.status = itemsOf(b, a).every((i) => TERM.has(i.status)) ? "done" : "closed"; a.closedTs = Date.now(); };
  const newSet = (b, title, by) => { closeActive(b); const set = { id: "set-" + (++b.setSeq), n: b.setSeq, title: title || `Set ${b.setSeq}`, status: "active", createdTs: Date.now(), closedTs: null, by: by || "orchestrator" }; b.sets.push(set); return set; };
  const find = (b, ref) => { if (typeof ref === "number") return b.items.find((i) => i.n === ref) || null; const m = /^T(\d+)$/i.exec(String(ref)); return b.items.find((i) => (m ? i.n === +m[1] : i.id === String(ref))) || null; };
  return {
    taskCalls: [],
    boardFor(session) {
      const b = bd(idOf(session));
      return { seq: b.seq, setSeq: b.setSeq, sets: b.sets.map((s) => ({ ...s })), items: b.items.map((i) => ({ ...i })), active: (active(b) || {}).id || null, counts: { total: b.items.length, open: b.items.filter((i) => !TERM.has(i.status)).length, done: b.items.filter((i) => i.status === "done").length } };
    },
    addTasks(sessionId, { titles, items, set } = {}, { by = "orchestrator" } = {}) {
      this.taskCalls.push(["addTasks", sessionId, { titles, items, set }, by]);
      const b = bd(sessionId);
      const list = [...(titles || []).map((t) => ({ title: t })), ...(items || [])].filter((x) => x && String(x.title || "").trim());
      if (!list.length) throw new Error("No task titles given.");
      let target = active(b);
      if (set && set.title) target = newSet(b, set.title, by);
      // an EMPTY active set (just opened) accepts tasks; a set whose every task is terminal is finished → a new "Set n"
      else if (!target || (itemsOf(b, target).length && itemsOf(b, target).every((i) => TERM.has(i.status)))) target = newSet(b, "", by);
      const made = list.map((x) => { const n = ++b.seq; const it = { id: "task-" + n, n, setId: target.id, title: String(x.title).trim(), detail: String(x.detail || ""), status: "todo", role: x.role || null, jobIds: [], notes: [], createdTs: Date.now(), updatedTs: Date.now(), doneTs: null }; b.items.push(it); return it; });
      return { set: { ...target }, items: made.map((i) => ({ ...i })) };
    },
    updateTask(sessionId, ref, patch = {}, { by = "orchestrator" } = {}) {
      this.taskCalls.push(["updateTask", sessionId, ref, patch, by]);
      const b = bd(sessionId); const it = find(b, ref);
      if (!it) throw new Error(`No task ${ref} on this board.`);
      if (patch.status !== undefined) { if (!STATUS.includes(patch.status)) throw new Error(`Bad status "${patch.status}".`); it.status = patch.status; if (patch.status === "done") it.doneTs = Date.now(); }
      if (patch.role !== undefined) it.role = patch.role || null;
      if (patch.title !== undefined) it.title = String(patch.title);
      if (patch.detail !== undefined) it.detail = String(patch.detail);
      if (patch.note) it.notes.push({ ts: Date.now(), by, text: String(patch.note) });
      it.updatedTs = Date.now();
      const set = b.sets.find((s) => s.id === it.setId);
      if (set && set.status === "active" && itemsOf(b, set).every((i) => TERM.has(i.status))) { set.status = "done"; set.closedTs = Date.now(); }
      return { ...it };
    },
    openTaskSet(sessionId, title, { by } = {}) { this.taskCalls.push(["openTaskSet", sessionId, title, by]); return { ...newSet(bd(sessionId), title, by) }; },
    removeTask(sessionId, ref) { this.taskCalls.push(["removeTask", sessionId, ref]); const b = bd(sessionId); const it = find(b, ref); if (!it) throw new Error(`No task ${ref}.`); b.items.splice(b.items.indexOf(it), 1); return true; },
    taskInfo(sessionId, ref) { const it = find(bd(sessionId), ref); return it ? { ...it } : null; },
    linkJobToTask(job, ref) { this.taskCalls.push(["linkJobToTask", job && job.id, ref]); },
  };
}

/* ---- fake session manager: in-memory jobs. A role job finishes 30 ms after it starts with result "OK"
 * (task containing "fail" → error; "slow" → stays running until stopped). ---- */
function fakeManager(running) {
  const jobs = new Map(); let n = 0;
  const WF = { enabled: true, name: "Solo", savedId: null, roles: { orchestrator: { provider: "", model: "", effort: "", access: "bypassPermissions" }, planner: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "read", agents: 0 }, coder: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "bypassPermissions", agents: 3 }, reviewer: { enabled: true, provider: "openai", model: "", effort: "medium", access: "read" }, tester: { enabled: true, provider: "anthropic", model: "", effort: "medium", access: "bypassPermissions", command: "" } }, layout: {}, brief: "", openJobTabs: false };
  const finish = (job, status, result, extra) => { if (job.status !== "running") return; Object.assign(job, { status, result, endedTs: Date.now() }, extra || {}); job.durationMs = job.endedTs - job.startedTs; };
  const mgr = {
    calls: [], jobs, WF,
    isRunning: (id) => running.has(id),
    wfArgs: [],
    workflowFor(x) { this.wfArgs.push(x); return { ...WF, name: typeof x === "string" ? `WF of ${x}` : WF.name, enabled: running.enabledFor ? running.enabledFor(typeof x === "string" ? x : x && x.id) : WF.enabled }; },
    orchestratorBrief: (session, wf, provider) => `Orchestrator brief for ${session.id} (${provider}) — roles ${Object.keys(wf.roles).join(",")}. Your session id is ${session.id}`,
    async startRoleJob(parentId, req) {
      this.calls.push(["startRoleJob", parentId, req]);
      if (!["planner", "coder", "reviewer", "tester"].includes(req.role)) throw new Error(`Unknown role ${req.role}`);
      const id = "j" + (++n);
      const job = { id, kind: "role", role: req.role, parentId, sessionId: "child-" + n, task: req.task, command: "", status: "running", startedTs: Date.now(), endedTs: null, durationMs: null, provider: "anthropic", model: "claude-opus-4-8", effort: "high", access: "bypassPermissions", agents: req.agents != null ? req.agents : 3, result: "", exitCode: null, editedFiles: [], tokensIn: 0, tokensOut: 0, agentsLive: { running: 0, total: 0 }, from: req.from, error: "", fromJob: null };
      // --from → fromJob (2026-09-18): like the real mixin, a source that is missing / another orchestrator's / still running is refused
      if (req.fromJob !== undefined) {
        const src = jobs.get(req.fromJob);
        if (!src || src.parentId !== parentId) throw new Error(`No job ${req.fromJob} among this session's jobs.`);
        if (src.status === "running") throw new Error(`Job ${req.fromJob} is still running — wait for it (atomnano wait ${req.fromJob} --timeout 540) before handing its result on.`);
        job.fromJob = src.id;
      }
      // --task T12 → linkJobToTask (the real mixin sets job.taskId / taskN and moves the item with the role)
      if (req.taskRef) { const t = this.taskInfo(parentId, req.taskRef); job.taskId = t ? t.id : null; job.taskN = t ? t.n : null; this.linkJobToTask(job, req.taskRef); }
      jobs.set(id, job);
      if (!/slow/.test(req.task)) setTimeout(() => (/please fail/.test(req.task) ? finish(job, "error", "", { error: "The child run failed: synthetic" }) : finish(job, "done", "OK", { editedFiles: [{ path: "src/a.js", count: 1, added: 2, removed: 1 }] })), 30);
      return job;
    },
    async runCommandJob(parentId, opts) {
      const { command, timeoutMs } = opts;
      this.calls.push(["runCommandJob", parentId, command, timeoutMs, opts]);
      const id = "j" + (++n);
      const job = { id, kind: "command", role: null, parentId, sessionId: null, task: "", command, status: "running", startedTs: Date.now(), result: "", exitCode: null, from: "cli", error: "" };
      jobs.set(id, job);
      setTimeout(() => finish(job, "done", "cmd:" + command + "\n", { exitCode: 0 }), 30);
      return job;
    },
    jobInfo: (id) => jobs.get(id) || null,
    jobsFor: (p) => [...jobs.values()].filter((j) => j.parentId === p),
    allJobs: () => [...jobs.values()],
    async waitJob(id, ms) { const until = Date.now() + ms; for (;;) { const j = jobs.get(id); if (!j || j.status !== "running" || Date.now() >= until) return j || null; await sleep(5); } },
    async stopJob(id) { const j = jobs.get(id); if (!j) return { ok: false, detail: "no such job" }; if (j.status !== "running") return { ok: false, detail: `already ${j.status}` }; finish(j, "stopped", j.result, { error: "" }); return { ok: true }; },
    jobLog: (id, { tail } = {}) => `log ${id} tail=${tail}\nuser: task\nassistant: working`,
  };
  return Object.assign(mgr, fakeBoard());
}
const SESSIONS = [
  { id: "s1", name: "Fix login", cwd: "E:/proj", status: "running", updatedAt: "2026-09-16T10:00:00.000Z" },
  { id: "s2", name: "Idle chat", cwd: "E:/proj", status: "idle", updatedAt: "2026-09-16T09:00:00.000Z" },
  { id: "c1", name: "coder: task", cwd: "E:/proj", status: "idle", role: "coder", parentId: "s1", updatedAt: "2026-09-16T10:01:00.000Z" },
];
const fakeStore = {
  getSettings: () => ({ llmProvider: "anthropic", customEndpoints: [{ id: "ep1", name: "My endpoint" }] }),
  listSessions: () => SESSIONS, getMeta: (id) => SESSIONS.find((s) => s.id === id) || null, getSession: (id) => SESSIONS.find((s) => s.id === id) || null,
  writeAtomic: (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + ".tmp", data); fs.renameSync(file + ".tmp", file); },
  uid: () => Math.random().toString(16).slice(2, 12) + Date.now().toString(16),
};
const CATALOG = () => ({
  anthropic: { label: "Anthropic", defaultModel: "claude-opus-4-8", reasoningLevels: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], models: [{ id: "claude-opus-4-8", name: "Opus 4.8" }, { id: "claude-sonnet-4-6", name: "Sonnet 4.6" }] },
  google: { label: "Google (removed)", primary: "disabled", defaultModel: "", reasoningLevels: [], models: [] },
  openai: { label: "OpenAI", defaultModel: "gpt-5.6-sol", reasoningLevels: [{ id: "medium", name: "Medium" }], models: [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol" }] },
  custom: { label: "Custom API", defaultModel: "", reasoningLevels: [], models: [] },
});
const AUTH = () => ({ anthropic: { loggedIn: true, key: false }, openai: { loggedIn: false, key: true }, google: {}, custom: { key: false, baseUrl: "" } });

async function api(base, token, method, route, body) {
  const headers = token ? { authorization: "Bearer " + token } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
  let json; const text = await res.text(); try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}
// Discovery must never fall through to the developer's running app/control.json.
const DISCOVERY_ENV = { HOME, USERPROFILE: HOME, APPDATA: path.join(HOME, "roaming"), XDG_CONFIG_HOME: path.join(HOME, "config") };
// The CLI in-process with captured streams. env: only isolated paths and the test's overrides.
async function run(args, env) {
  let stdout = "", stderr = "";
  const code = await cli.main(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env: { ...DISCOVERY_ENV, ...env } });
  return { code, stdout, stderr };
}
// A real child process — asynchronous, so the control server living in THIS process keeps answering.
function spawnAsync(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, windowsHide: true });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => { try { p.kill(); } catch { /* */ } }, 20000);
    p.on("error", (e) => { clearTimeout(t); resolve({ status: -1, stdout, stderr: stderr + String(e.message) }); });
    p.on("close", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  });
}
// A loopback port nothing listens on (bound, then released) — a true ECONNREFUSED, not fetch's blocked-port list.
function closedPort() {
  return new Promise((resolve) => { const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); }); });
}

async function main() {
  const running = new Set(["s1"]);
  const M = fakeManager(running);
  const binDir = path.join(ROOT, "bin");
  const prevPath = process.env.PATH;
  const c = await server.start({ manager: M, store: fakeStore, version: "9.9.9", userData: HOME, binDir, catalog: CATALOG, authStatus: AUTH });
  const T = c.token, B = c.url;

  /* ---------------- server: lifecycle + auth ---------------- */
  const ctl = JSON.parse(fs.readFileSync(path.join(HOME, "control.json"), "utf8"));
  check("W01", "start() listens on 127.0.0.1, writes control.json { url, token, pid, startedAt }", /^http:\/\/127\.0\.0\.1:\d+$/.test(B) && ctl.url === B && ctl.token === T && ctl.pid === process.pid && !!ctl.startedAt, { B, ctl: { ...ctl, token: ctl.token.slice(0, 6) } });
  check("W02", "env exports: ATOMNANO_CONTROL / ATOMNANO_TOKEN / ATOMNANO_NODE, bin/ first on PATH", process.env.ATOMNANO_CONTROL === B && process.env.ATOMNANO_TOKEN === T && process.env.ATOMNANO_NODE === process.execPath && process.env.PATH.split(path.delimiter)[0] === binDir && process.env.PATH.endsWith(prevPath), { head: process.env.PATH.split(path.delimiter)[0], binDir });
  check("W03", "info() reports running + url + binDir (no token)", (() => { const i = server.info(); return i.running && i.url === B && i.binDir === binDir && !("token" in i); })(), server.info());
  const idem = await server.start({ manager: M, store: fakeStore });
  check("W04", "a second start() is idempotent (same endpoint)", idem.url === B && idem.token === T, idem);
  let r = await api(B, "", "GET", "/v1/ping");
  check("W05", "no token → 401 { error }", r.status === 401 && /Unauthorized/.test(r.json.error), r);
  r = await api(B, "wrong" + T.slice(5), "GET", "/v1/ping");
  check("W06", "wrong token → 401", r.status === 401, r);
  r = await api(B, T, "GET", "/v1/ping");
  check("W07", "GET /v1/ping → { ok, app, version, pid }", r.status === 200 && r.json.ok === true && r.json.app === "atomnano" && r.json.version === "9.9.9" && r.json.pid === process.pid, r);
  r = await api(B, T, "GET", "/ping");
  check("W08", "the /v1 prefix is optional", r.status === 200 && r.json.ok === true, r);

  /* ---------------- server: read routes ---------------- */
  r = await api(B, T, "GET", "/v1/roles?session=s1");
  check("W09", "GET /roles?session= → { enabled, name, roles } resolved", r.status === 200 && r.json.enabled === true && r.json.name === "Solo" && r.json.roles.coder.agents === 3 && r.json.roles.reviewer.access === "read" && r.json.session === "s1", r.json);
  r = await api(B, T, "GET", "/v1/roles?cwd=" + encodeURIComponent("E:/other"));
  check("W09b", "GET /roles?cwd= while a planner runs → the running planner's workflow wins over cwd", r.status === 200 && r.json.session === "s1" && r.json.name === "Solo", r.json);
  running.delete("s1");
  r = await api(B, T, "GET", "/v1/roles?cwd=" + encodeURIComponent("E:/other"));
  check("W09c", "GET /roles?cwd= with no running planner → workflowFor(cwd): that project's active workflow", r.status === 200 && r.json.session === null && r.json.name === "WF of E:/other" && r.json.cwd === "E:/other" && M.wfArgs.at(-1) === "E:/other", r.json);
  r = await api(B, T, "GET", "/v1/status?cwd=" + encodeURIComponent("E:/other"));
  check("W09d", "GET /status?cwd= with no running planner → session null, that project's workflow", r.status === 200 && r.json.session === null && r.json.workflow.name === "WF of E:/other" && r.json.cwd === "E:/other", { session: r.json.session, wf: r.json.workflow.name });
  running.add("s1");
  r = await api(B, T, "GET", "/v1/sessions");
  check("W10", "GET /sessions → metas with role / parentId / running", r.status === 200 && r.json.sessions.length === 3 && r.json.sessions[0].running === true && r.json.sessions[2].role === "coder" && r.json.sessions[2].parentId === "s1", r.json);
  r = await api(B, T, "GET", "/v1/providers");
  check("W11", "GET /providers → authorized flags, disabled provider skipped, current marked", r.status === 200 && r.json.providers.map((p) => p.id).join() === "anthropic,openai,custom" && r.json.providers[0].authorized && r.json.providers[1].authorized && r.json.providers[2].authorized === true /* custom endpoints configured */ && r.json.providers[0].current === true && r.json.providers[0].defaultModel === "claude-opus-4-8", r.json);
  r = await api(B, T, "GET", "/v1/models?provider=anthropic");
  check("W12", "GET /models?provider= → { models:[{id,name}], reasoningLevels }", r.status === 200 && r.json.models.length === 2 && r.json.models[0].id === "claude-opus-4-8" && r.json.reasoningLevels.map((l) => l.id).join() === "low,high", r.json);
  r = await api(B, T, "GET", "/v1/models?provider=nope");
  check("W13", "unknown provider → 400 sentence listing the valid ones", r.status === 400 && /Unknown provider "nope"/.test(r.json.error) && /anthropic, openai, custom/.test(r.json.error), r.json);
  r = await api(B, T, "GET", "/v1/status?session=s1");
  check("W14", "GET /status?session= → { session:{id,name,cwd,status}, workflow, jobs }", r.status === 200 && r.json.session.id === "s1" && r.json.session.cwd === "E:/proj" && r.json.session.running === true && r.json.workflow.enabled === true && Array.isArray(r.json.jobs) && r.json.jobs.length === 0, r.json);

  /* ---------------- server: jobs ---------------- */
  r = await api(B, T, "POST", "/v1/jobs", { session: "s1", role: "coder", task: "Fix it", files: "a.js,b.js", agents: 2, wait: 5 });
  const j1 = r.json.job;
  check("W15", "POST /jobs { wait } long-polls until terminal → done, result OK, from cli, files/agents forwarded", r.status === 200 && j1 && j1.status === "done" && j1.result === "OK" && j1.from === "cli" && j1.parentId === "s1" && j1.durationMs >= 0, r.json);
  const call = M.calls.find((x) => x[0] === "startRoleJob");
  check("W16", "startRoleJob(parentId, { role, task, files[], agents, from:'cli' })", call && call[1] === "s1" && call[2].role === "coder" && call[2].task === "Fix it" && call[2].files.join() === "a.js,b.js" && call[2].agents === 2 && call[2].from === "cli", call);
  r = await api(B, T, "GET", "/v1/jobs?session=s1");
  check("W17", "GET /jobs?session= → { jobs } of that planner", r.status === 200 && r.json.jobs.length === 1 && r.json.jobs[0].id === j1.id, r.json);
  r = await api(B, T, "POST", "/v1/jobs", { role: "review", task: "slow review" });
  const j2 = r.json.job;
  check("W18", "session omitted → the single running planner (s1); role alias 'review' → reviewer; wait omitted → returns at once", r.status === 200 && j2 && j2.parentId === "s1" && j2.role === "reviewer" && j2.status === "running", r.json);
  r = await api(B, T, "GET", `/v1/jobs/${j2.id}/wait?timeout=0.05`);
  check("W19", "GET /jobs/:id/wait?timeout= returns the current state when the timeout passes", r.status === 200 && r.json.job.id === j2.id && r.json.job.status === "running", r.json);
  r = await api(B, T, "GET", `/v1/jobs/${j2.id}/log?tail=3`);
  check("W20", "GET /jobs/:id/log?tail= → { text }", r.status === 200 && r.json.text === `log ${j2.id} tail=3\nuser: task\nassistant: working`, r.json);
  r = await api(B, T, "POST", `/v1/jobs/${j2.id}/stop`);
  check("W21", "POST /jobs/:id/stop → { ok } and the job reads stopped", r.status === 200 && r.json.ok === true && r.json.job.status === "stopped" && (await api(B, T, "GET", `/v1/jobs/${j2.id}`)).json.job.status === "stopped", r.json);
  r = await api(B, T, "POST", `/v1/jobs/${j2.id}/stop`);
  check("W22", "stopping a finished job → { ok:false, detail }", r.status === 200 && r.json.ok === false && /already stopped/.test(r.json.detail), r.json);
  r = await api(B, T, "POST", "/v1/tests", { session: "s1", command: "npm test", wait: 5 });
  check("W23", "POST /tests → command job (kind command, exit code, captured output)", r.status === 200 && r.json.job.kind === "command" && r.json.job.command === "npm test" && r.json.job.status === "done" && r.json.job.exitCode === 0 && r.json.job.result === "cmd:npm test\n", r.json);
  r = await api(B, T, "POST", "/v1/tests", { session: "s1", command: "" });
  check("W24", "POST /tests without a command (none configured on the tester) → 400 sentence", r.status === 400 && /No command given/.test(r.json.error), r.json);
  M.WF.roles.tester.command = "pytest -q";
  r = await api(B, T, "POST", "/v1/tests", { session: "s1", wait: 5 });
  check("W25", "POST /tests without a command uses the tester's configured command", r.status === 200 && r.json.job.command === "pytest -q" && r.json.job.status === "done", r.json);
  M.WF.roles.tester.command = "";

  /* ---------------- server: --from (source-job handoff, 2026-09-18) ---------------- */
  const jobsBeforeFrom = M.calls.length;
  r = await api(B, T, "POST", "/v1/jobs", { session: "s1", role: "coder", task: "Implement the plan", from: j1.id, wait: 5 });
  const fromCall = M.calls.filter((x) => x[0] === "startRoleJob").pop();
  check("W25b", "POST /jobs { from: <finished job id> } → startRoleJob(parent, { …, from: 'cli', fromJob: <id> }): the wire `from` is the source job, the manager's `from` stays the cli provenance, the task text is untouched; the job reports fromJob", r.status === 200 && r.json.job.status === "done" && r.json.job.fromJob === j1.id && r.json.job.from === "cli" && fromCall[2].from === "cli" && fromCall[2].fromJob === j1.id && fromCall[2].task === "Implement the plan", { call: fromCall && fromCall[2], job: r.json.job });
  r = await api(B, T, "POST", "/v1/jobs", { session: "s1", role: "coder", task: "x", from: "zzz" });
  const blankFrom = await api(B, T, "POST", "/v1/jobs", { session: "s1", role: "coder", task: "x", from: "   " });
  const foreign = await api(B, T, "POST", "/v1/jobs", { session: "s2", role: "coder", task: "x", from: j1.id });
  check("W25c", "an unknown source job → 404 naming the session (like an unknown task ref); another orchestrator's job → 404 too (jobsFor is per orchestrator); a blank `from` → 400; NO job is started for any of them", r.status === 404 && /No job zzz among session s1's jobs — --from takes the id of a finished job of this orchestrator \(atomnano jobs\)\./.test(r.json.error) && foreign.status === 404 && new RegExp(`No job ${j1.id} among session s2's jobs`).test(foreign.json.error) && blankFrom.status === 400 && /A job id is required with `from` \(--from <job id>\)/.test(blankFrom.json.error) && M.calls.length === jobsBeforeFrom + 1, { r: r.json, foreign: foreign.json, blank: blankFrom.json, calls: M.calls.length - jobsBeforeFrom });
  r = await api(B, T, "POST", "/v1/jobs", { session: "s1", role: "coder", task: "slow source" });
  const slowSrc = r.json.job;
  r = await api(B, T, "POST", "/v1/jobs", { session: "s1", role: "coder", task: "x", from: slowSrc.id });
  await api(B, T, "POST", `/v1/jobs/${slowSrc.id}/stop`);
  check("W25d", "a source job that has not ended → 400 with the manager's sentence (wait for it — atomnano wait <id> --timeout 540); no job exists for it", r.status === 400 && new RegExp(`Job ${slowSrc.id} is still running — wait for it \\(atomnano wait ${slowSrc.id} --timeout 540\\)`).test(r.json.error) && ![...M.jobs.values()].some((j) => j.fromJob === slowSrc.id), r.json);

  /* ---------------- server: validation + session resolution ---------------- */
  r = await api(B, T, "POST", "/v1/jobs", { session: "s1", role: "orchestrator", task: "x" });
  check("W26", "role orchestrator → 400 explaining the orchestrator is the caller (planner, coder, reviewer, tester are the runnable roles)", r.status === 400 && /orchestrator is the calling session — delegate to planner, coder, reviewer or tester/.test(r.json.error), r.json);
  r = await api(B, T, "POST", "/v1/jobs", { session: "s1", role: "plan", task: "Draft the plan", wait: 5 });
  check("W26b", "role alias 'plan' → a planner job (the Planner is a worker role since 2026-09-17)", r.status === 200 && r.json.job.role === "planner" && r.json.job.status === "done" && M.calls.at(-1)[2].role === "planner", r.json);
  r = await api(B, T, "POST", "/v1/jobs", { session: "s1", role: "coder", task: "  " });
  check("W27", "empty task → 400", r.status === 400 && /task is required/i.test(r.json.error), r.json);
  r = await api(B, T, "POST", "/v1/jobs", { session: "c1", role: "coder", task: "x" });
  check("W28", "a child (role) session cannot own jobs → 400", r.status === 400 && /is a coder job itself/.test(r.json.error), r.json);
  r = await api(B, T, "POST", "/v1/jobs", { session: "nope", role: "coder", task: "x" });
  check("W29", "unknown explicit session → 404", r.status === 404 && /No session with id nope/.test(r.json.error), r.json);
  r = await api(B, T, "GET", "/v1/jobs/zzz");
  check("W30", "unknown job → 404", r.status === 404 && /No job with id zzz/.test(r.json.error), r.json);
  r = await api(B, T, "GET", "/v1/nothing");
  check("W31", "unknown route → 404 { error }", r.status === 404 && /No route GET \/nothing/.test(r.json.error), r.json);
  r = await api(B, T, "POST", "/v1/roles", {});
  check("W32", "wrong method → 405", r.status === 405 && /Use GET/.test(r.json.error), r.json);
  r = await api(B, T, "POST", "/v1/jobs", "{ not json");
  check("W33", "malformed JSON body → 400", r.status === 400 && /not valid JSON/.test(r.json.error), r.json);
  try { r = await api(B, T, "POST", "/v1/jobs", JSON.stringify({ task: "x".repeat(1024 * 1024 + 10), role: "coder" })); } catch (e) { r = { status: "threw", json: { error: String(e && e.cause ? e.cause.message : e.message) } }; }
  check("W34", "body over 1 MB → 413 (the reply reaches a client still uploading)", r.status === 413 && /exceeds 1 MB/.test(r.json.error), r);
  r = await api(B, T, "GET", "/v1/ping");
  check("W34b", "the server keeps serving after an oversized body", r.status === 200 && r.json.ok === true, r);
  running.add("s2");
  r = await api(B, T, "POST", "/v1/jobs", { role: "coder", task: "x" });
  check("W35", "two running orchestrators, no session → 400 listing both candidates", r.status === 400 && /2 orchestrator sessions are running/.test(r.json.error) && Array.isArray(r.json.sessions) && r.json.sessions.map((s) => s.id).sort().join() === "s1,s2", r.json);
  running.delete("s2"); running.delete("s1");
  r = await api(B, T, "POST", "/v1/jobs", { role: "coder", task: "x" });
  check("W36", "no running orchestrator, no session → 400 with the orchestrator sessions as candidates", r.status === 400 && /No orchestrator session is running/.test(r.json.error) && r.json.sessions.length === 2 && !r.json.sessions.some((s) => s.role), r.json);
  running.add("s1"); running.enabledFor = (id) => id !== "s1";
  r = await api(B, T, "POST", "/v1/jobs", { role: "coder", task: "x" });
  check("W37", "a running session whose workflow is off does not resolve → 400 says so", r.status === 400 && /workflow is not enabled/.test(r.json.error) && r.json.sessions[0].id === "s1", r.json);
  running.enabledFor = null; running.delete("s1");
  r = await api(B, T, "GET", "/v1/status");
  check("W38", "GET /status without a resolvable session is lenient: session null, all jobs listed", r.status === 200 && r.json.session === null && r.json.jobs.length === M.allJobs().length && r.json.workflow.name === "Solo", { session: r.json.session, jobs: r.json.jobs.length });
  running.add("s1");

  // Canonical history retrieval through the real authenticated server and CLI.
  {
    const source = [{ id: "old-user", role: "user", text: "ACCOUNT DECISION: preserve context" },
      { id: "tool-proof", role: "tool", toolName: "Bash", status: "error", toolInput: { command: "npm test" }, result: "Output ".repeat(1000) + "FAIL ACCOUNT DECISION" }];
    SESSIONS[0].archivedCount = 1; SESSIONS[0].messages = source.slice(1);
    fakeStore.getMessagesRange = (_id, end, count) => ({ messages: source.slice(Math.max(0, end - count), end) });
    const env = { ATOMNANO_CONTROL: B, ATOMNANO_TOKEN: T };
    const find = await run(["context", "search", "ACCOUNT DECISION", "--session", "s1", "--json", "--limit", "1"], env);
    const parsed = JSON.parse(find.stdout);
    check("CTX1", "CLI history search returns bounded tool evidence and a next cursor", find.code === 0 && parsed.matches[0].id === "tool-proof" && parsed.nextBefore === 1 && Buffer.byteLength(parsed.matches[0].snippet) <= 600, find);
    const next = await run(["context", "search", "ACCOUNT DECISION", "--session", "s1", "--json", "--before", "1"], env);
    check("CTX2", "CLI search crosses into the archive on the next page", next.code === 0 && JSON.parse(next.stdout).matches[0].archived, next);
    const read = await run(["context", "read", "tool-proof", "--session", "s1", "--json", "--offset", "64", "--limit", "128"], env);
    check("CTX3", "CLI exact record read passes byte offset and limit unchanged", read.code === 0 && JSON.parse(read.stdout).offset === 64 && JSON.parse(read.stdout).bytes === 128 && JSON.parse(read.stdout).nextOffset === 192, read);
    const unauthorized = await api(B, "", "GET", "/v1/context/read?session=s1&ref=0");
    check("CTX4", "retrieval requires the same bearer authentication as other control routes", unauthorized.status === 401);
    const absent = await run(["context", "read", "missing", "--session", "s1", "--json"], env);
    check("CTX5", "missing source refs return a clear CLI failure", absent.code === 1 && /No record entry/.test(absent.stderr), absent);
    const invalid = await run(["context", "read", "0", "--session", "s1", "--limit", "-1"], env);
    check("CTX6", "invalid retrieval pagination is rejected by the server", invalid.code === 1, invalid);
    const human = await run(["context", "read", "old-user", "--session", "s1"], env);
    check("CTX7", "plain text retrieval includes source identity and exact recorded text", human.code === 0 && /entry 0/.test(human.stdout) && human.stdout.includes(source[0].text), human);
    delete SESSIONS[0].archivedCount; delete SESSIONS[0].messages;
  }

  /* ---------------- CLI end to end (in-process, env limited to the control vars) ---------------- */
  const ENV = { ATOMNANO_CONTROL: B, ATOMNANO_TOKEN: T };
  let o = await run(["status"], ENV);
  check("C01", "atomnano status → app line, session, workflow line (the Planner worker listed first), jobs table", o.code === 0 && /^AtomNano 9\.9\.9 · http:\/\/127\.0\.0\.1:\d+ · pid \d+/.test(o.stdout) && /session   s1  "Fix login"  running  E:\/proj/.test(o.stdout) && /workflow  Solo \(enabled\) — planner anthropic\/high\/read · coder anthropic\/high\/full ×3 · reviewer openai\/medium\/read · tester anthropic\/medium\/full/.test(o.stdout) && /jobs      \d+/.test(o.stdout) && /ID\s+ROLE\s+STATUS\s+TIME\s+TASK/.test(o.stdout), o);
  o = await run(["roles"], ENV);
  check("C02", "atomnano roles → the role table: the orchestrator first (the calling session), then the four workers", o.code === 0 && /workflow "Solo" — enabled/.test(o.stdout) && /orchestrator\s+-\s+\(composer\)\s+\(composer\)\s+-\s+full\s+the calling session — you/.test(o.stdout) && /planner\s+yes\s+anthropic\s+\(default\)\s+high\s+read/.test(o.stdout) && /coder\s+yes\s+anthropic\s+\(default\)\s+high\s+full\s+3 sub-agents/.test(o.stdout) && /reviewer\s+yes\s+openai\s+\(default\)\s+medium\s+read/.test(o.stdout) && /tester\s+yes/.test(o.stdout), o);
  running.delete("s1");
  await cli.main(["roles"], { stdout: () => {}, stderr: () => {}, env: ENV, cwd: "E:/from-here" });
  check("C02b", "atomnano roles sends the caller's working directory as cwd (used when no planner session resolves)", M.wfArgs.at(-1) === "E:/from-here", { last: M.wfArgs.at(-1) });
  o = await run(["status"], ENV);
  check("C02c", "atomnano status with no resolvable session says so and names the folder whose workflow is shown", o.code === 0 && /session   none resolved — pass --session <id> or set ATOMNANO_SESSION \(workflow shown for .+\)/.test(o.stdout), o.stdout);
  running.add("s1");
  o = await run(["run", "coder", "Add a null check", "--files", "a.js", "--agents", "1", "--wait"], ENV);
  check("C03", 'atomnano run coder "x" --wait → result on stdout, one summary line on stderr, exit 0', o.code === 0 && o.stdout === "OK\n" && /^\[job j\d+ · coder · done · \d+ms · 1 file edited \(\+2\/-1\) · session child-\d+\]\n$/.test(o.stderr), o);
  o = await run(["coder", "please fail", "--wait"], ENV);
  check("C04", "an awaited job that ends in error → exit 3, error on stderr", o.code === 3 && /atomnano: job j\d+ error: The child run failed: synthetic/.test(o.stderr) && o.stdout === "", o);
  o = await run(["jobs", "--json"], ENV);
  let parsed = null; try { parsed = JSON.parse(o.stdout); } catch { /* */ }
  check("C05", "atomnano jobs --json → one JSON document { jobs, session }", o.code === 0 && parsed && Array.isArray(parsed.jobs) && parsed.jobs.length === M.jobsFor("s1").length && parsed.session === "s1", o.stdout.slice(0, 200));
  o = await run(["jobs"], ENV);
  check("C06", "atomnano jobs → table incl. the command job", o.code === 0 && /^ID\s+ROLE\s+STATUS\s+TIME\s+TASK\n/.test(o.stdout) && /j1\s+coder\s+done\s+\d+ms\s+Fix it/.test(o.stdout) && /command\s+done\s+\d+ms\s+npm test/.test(o.stdout), o.stdout);
  o = await run(["job", "j1"], ENV);
  check("C07", "atomnano job <id> → header, session, model, files, result", o.code === 0 && /^job j1 · coder · done · \d+ms\n/.test(o.stdout) && /session   child-1  \(orchestrator s1\)/.test(o.stdout) && /model     anthropic\/claude-opus-4-8 · effort high · access full · 2 agents/.test(o.stdout) && /files     1 file edited \(\+2\/-1\): src\/a\.js/.test(o.stdout) && /\nresult\nOK\n$/.test(o.stdout), o.stdout);
  o = await run(["review", "slow: look at the diff"], ENV);
  const slowId = (o.stdout.match(/^job (j\d+) running · reviewer/) || [])[1];
  check("C08", "atomnano review <task> (no --wait) → 'job <id> running · reviewer …' + the wait hint with --timeout 540, exit 0", o.code === 0 && !!slowId && /anthropic\/claude-opus-4-8 · effort high · access full · 3 agents · session child-\d+\n  atomnano wait j\d+ --timeout 540   # block/.test(o.stdout), o);
  o = await run(["wait", slowId, "--timeout", "0.05"], ENV);
  check("C09", "atomnano wait <id> --timeout s on a running job → ONE short line (status, elapsed, role, the next wait command with --timeout 540), exit 0", o.code === 0 && new RegExp(`^job ${slowId} still running after \\d+ms · reviewer — atomnano wait ${slowId} --timeout 540\\n$`).test(o.stdout) && o.stderr === "", o);
  o = await run(["result", slowId], ENV);
  check("C10", "atomnano result <id> on a running job → exit 1 with a hint", o.code === 1 && new RegExp(`job ${slowId} is still running — atomnano wait ${slowId}`).test(o.stderr), o);
  o = await run(["log", slowId, "--tail", "2"], ENV);
  check("C11", "atomnano log <id> --tail n → the transcript text", o.code === 0 && o.stdout === `log ${slowId} tail=2\nuser: task\nassistant: working\n`, o);
  o = await run(["stop", slowId], ENV);
  check("C12", "atomnano stop <id> → 'stopped <id> · stopped', exit 0", o.code === 0 && o.stdout === `stopped ${slowId} · stopped\n`, o);
  o = await run(["wait", slowId], ENV);
  check("C13", "atomnano wait on a stopped job → exit 3", o.code === 3 && new RegExp(`atomnano: job ${slowId} stopped`).test(o.stderr), o);
  o = await run(["result", "j1"], ENV);
  check("C14", "atomnano result <id> → the result text, exit 0", o.code === 0 && o.stdout === "OK\n", o);
  o = await run(["test", "--cmd", "npm test", "--wait"], ENV);
  check("C15", 'atomnano test --cmd "npm test" --wait → command output on stdout, exit code in the summary', o.code === 0 && o.stdout === "cmd:npm test\n" && /^\[job j\d+ · command "npm test" · done · \d+ms · exit 0\]\n$/.test(o.stderr), o);
  o = await run(["test", "--wait"], ENV);
  const testerCall = M.calls.filter((x) => x[0] === "startRoleJob" && x[2].role === "tester").pop();
  check("C16", "atomnano test (no task, no --cmd) → a tester ROLE job with the default task", o.code === 0 && o.stdout === "OK\n" && testerCall && /Run the project's test suite/.test(testerCall[2].task), { o, task: testerCall && testerCall[2].task });
  o = await run(["run", "coder", "x", "--session", "nope"], ENV);
  check("C17", "--session with an unknown id → exit 1, the server's sentence", o.code === 1 && /atomnano: No session with id nope/.test(o.stderr), o);
  o = await run(["coder", "x", "--session", "s1"], { ...ENV, ATOMNANO_SESSION: "nope" });
  check("C18", "--session wins over ATOMNANO_SESSION", o.code === 0 && /^job j\d+ running · coder/.test(o.stdout), o);
  o = await run(["coder", "x"], { ...ENV, ATOMNANO_SESSION: "nope" });
  check("C19", "ATOMNANO_SESSION is the default --session (unknown id → exit 1)", o.code === 1 && /No session with id nope/.test(o.stderr), o);
  running.delete("s1"); running.add("s2"); running.add("s1");
  o = await run(["coder", "x"], ENV);
  check("C20", "ambiguous orchestrator → exit 1 and the candidate sessions listed on stderr", o.code === 1 && /2 orchestrator sessions are running/.test(o.stderr) && /    s1  running  "Fix login"  E:\/proj/.test(o.stderr) && /    s2  running/.test(o.stderr), o);
  running.delete("s2");
  o = await run(["frobnicate"], ENV);
  check("C21", "unknown command → exit 1", o.code === 1 && /unknown command "frobnicate" — try: atomnano help/.test(o.stderr), o);
  o = await run(["run", "orchestrator", "x"], ENV);
  check("C22", "run orchestrator → usage error, exit 1 (no request needed): the orchestrator is this session", o.code === 1 && /The orchestrator is this session — delegate to planner, coder, reviewer or tester/.test(o.stderr), o);
  o = await run(["plan", "Draft the plan", "--wait"], ENV);
  check("C22b", "atomnano plan \"<request>\" --wait → a planner job (the Planner is a worker role): the result on stdout, the job line on stderr, exit 0", o.code === 0 && o.stdout === "OK\n" && /^\[job j\d+ · planner · done · /.test(o.stderr) && M.calls.at(-1)[0] === "startRoleJob" && M.calls.at(-1)[2].role === "planner" && M.calls.at(-1)[2].task === "Draft the plan", o);
  o = await run(["run", "planner"], ENV);
  check("C22c", "atomnano run planner without a task → the usage line names the plan shorthand", o.code === 1 && /usage: atomnano plan "<task>" \[--wait\]/.test(o.stderr), o);
  // --from (source-job handoff, 2026-09-18)
  o = await run(["run", "coder", "Implement the plan", "--from", "j1"], ENV);
  const fromReq = M.calls.filter((x) => x[0] === "startRoleJob").pop();
  check("C22d", 'atomnano run coder "…" --from j1 → body.from = "j1" → startRoleJob({ from: "cli", fromJob: "j1" }); the task text is untouched; the started line reads as usual', o.code === 0 && /^job j\d+ running · coder/.test(o.stdout) && fromReq[2].fromJob === "j1" && fromReq[2].from === "cli" && fromReq[2].task === "Implement the plan", { o, call: fromReq && fromReq[2] });
  const callsBeforeFrom = M.calls.length;
  o = await run(["coder", "x", "--from"], ENV);
  const oBlank = await run(["plan", "x", "--from", ""], ENV);
  const oCmd = await run(["test", "--cmd", "npm test", "--from", "j1", "--wait"], ENV);
  check("C22e", "a bare --from, a blank --from and `test --cmd … --from` are refused BEFORE any request (exit 1, no server call): the first two name the shorthand's usage, the last explains that a command job has no role and shows the role form", o.code === 1 && /^atomnano: --from needs a job id — usage: atomnano coder "<task>" --from <job id> \[--wait\]\n$/.test(o.stderr) && oBlank.code === 1 && /--from needs a job id — usage: atomnano plan "<task>" --from <job id> \[--wait\]/.test(oBlank.stderr) && oCmd.code === 1 && /^atomnano: --from hands a finished job's result to a role, but `atomnano test --cmd` runs a command, not the Tester role — drop --from, or run the Tester as a role: atomnano test "<task>" --from <job id>\n$/.test(oCmd.stderr) && M.calls.length === callsBeforeFrom, { o: o.stderr, oBlank: oBlank.stderr, oCmd: oCmd.stderr, calls: M.calls.length - callsBeforeFrom });
  // The same refusals with the app DOWN: the arguments are validated before the client is constructed (2026-09-18 —
  // `ctx.client()` used to come first, so a bare --from against a stopped app was exit 2 "not running" instead of the usage
  // error). The first version of this check handed the CLI control credentials for a refused port — but with credentials
  // the client CONSTRUCTS fine and only its request fails, so the old order passed unnoticed (re-review 2026-09-18).
  // Now the client cannot even be built: NO credentials at all — no ATOMNANO_CONTROL / ATOMNANO_TOKEN / ATOMNANO_SESSION,
  // discovery pointed at the isolated dirs of DISCOVERY_ENV where no control.json exists (the test server's lives in
  // HOME itself, which no platform's userDataDirs visits) — so createClient() throws exit 2 "not running" the moment it
  // runs. With the OLD order every malformed --from below would be exit 2 "not running"; the usage error proves the
  // arguments were checked first.
  const NOCREDS = {};   // run() adds nothing but DISCOVERY_ENV
  const oDeadBare = await run(["coder", "x", "--from"], NOCREDS);
  const oDeadBlank = await run(["plan", "x", "--from", ""], NOCREDS);
  const oDeadCmd = await run(["test", "--cmd", "npm test", "--from", "j1"], NOCREDS);
  const oDeadOk = await run(["coder", "x", "--from", "j1"], NOCREDS);
  check("C22e2", "with NO credentials and nothing to discover (the client cannot be constructed at all) a bare / blank --from and `test --cmd … --from` are STILL the usage errors (exit 1, the shorthand's usage line) — the arguments are validated before the client exists; a valid --from with the same env is exit 2 'not running' (the client is constructed only after validation)", oDeadBare.code === 1 && /^atomnano: --from needs a job id — usage: atomnano coder "<task>" --from <job id> \[--wait\]\n$/.test(oDeadBare.stderr) && oDeadBlank.code === 1 && /^atomnano: --from needs a job id — usage: atomnano plan "<task>" --from <job id> \[--wait\]\n$/.test(oDeadBlank.stderr) && oDeadCmd.code === 1 && /^atomnano: --from hands a finished job's result to a role/.test(oDeadCmd.stderr) && oDeadOk.code === 2 && oDeadOk.stderr === "atomnano: AtomNano is not running — start the app\n", { bare: [oDeadBare.code, oDeadBare.stderr], blank: [oDeadBlank.code, oDeadBlank.stderr], cmd: [oDeadCmd.code, oDeadCmd.stderr.slice(0, 80)], ok: [oDeadOk.code, oDeadOk.stderr] });
  // The same, made explicit with a client FACTORY that throws on construction and counts its calls: main() reads
  // `io.client` only inside ctx.client(), so a getter on the io object is exactly "the moment a client is built".
  // A malformed --from must never reach it; the valid --from must reach it once and exit with ITS error.
  let built = 0;
  const runThrowing = async (args) => {
    let stdout = "", stderr = "";
    const io = { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env: DISCOVERY_ENV, get client() { built++; throw new client.CliError("FACTORY: a client was constructed before the arguments were validated", 2); } };
    const code = await cli.main(args, io);
    return { code, stdout, stderr };
  };
  const oFBare = await runThrowing(["coder", "x", "--from"]);
  const oFBlank = await runThrowing(["plan", "x", "--from", ""]);
  const oFCmd = await runThrowing(["test", "--cmd", "npm test", "--from", "j1"]);
  const builtByMalformed = built;
  const oFOk = await runThrowing(["coder", "x", "--from", "j1"]);
  check("C22e3", "a client factory that throws on construction: the three malformed --from forms are the usage errors (exit 1) and the factory is NEVER called; a valid --from j1 calls it exactly once and exits with the factory's own error (2) — the client is built only after the arguments pass", oFBare.code === 1 && /^atomnano: --from needs a job id — usage: atomnano coder "<task>" --from <job id> \[--wait\]\n$/.test(oFBare.stderr) && oFBlank.code === 1 && /^atomnano: --from needs a job id — usage: atomnano plan "<task>" --from <job id> \[--wait\]\n$/.test(oFBlank.stderr) && oFCmd.code === 1 && /^atomnano: --from hands a finished job's result to a role/.test(oFCmd.stderr) && builtByMalformed === 0 && oFOk.code === 2 && oFOk.stderr === "atomnano: FACTORY: a client was constructed before the arguments were validated\n" && built === 1, { builtByMalformed, built, bare: [oFBare.code, oFBare.stderr], blank: [oFBlank.code, oFBlank.stderr], cmd: [oFCmd.code, oFCmd.stderr.slice(0, 80)], ok: [oFOk.code, oFOk.stderr] });
  o = await run(["test", "Rerun the suite", "--from", "j1", "--wait"], ENV);
  const testFrom = M.calls.filter((x) => x[0] === "startRoleJob").pop();
  const oRev = await run(["review", "the fix", "--from", "j1"], ENV);
  const revFrom = M.calls.filter((x) => x[0] === "startRoleJob").pop();
  check("C22f", 'atomnano test "<task>" --from j1 (no --cmd) is a Tester ROLE job with the source; atomnano review … --from j1 forwards it too', o.code === 0 && o.stdout === "OK\n" && testFrom[2].role === "tester" && testFrom[2].fromJob === "j1" && testFrom[2].task === "Rerun the suite" && oRev.code === 0 && revFrom[2].role === "reviewer" && revFrom[2].fromJob === "j1", { testFrom: testFrom && testFrom[2], revFrom: revFrom && revFrom[2] });
  o = await run(["coder", "x", "--from", "nope"], ENV);
  check("C22g", "an unknown source → exit 1 with the server's 404 sentence", o.code === 1 && /^atomnano: No job nope among session s1's jobs/.test(o.stderr), o);
  o = await run(["help"], ENV);
  const o2 = await run([], ENV);
  check("C23", "help (and no arguments) → usage on stdout, exit 0; it documents --from JOB and the 540 / 600 s waiting pattern", o.code === 0 && /^atomnano — delegate work/.test(o.stdout) && /EXIT CODES/.test(o.stdout) && o2.code === 0 && o2.stdout === o.stdout && /run <role> "<task>" \[--from JOB\]/.test(o.stdout) && /--from JOB\s+append that finished job's saved result to the task/.test(o.stdout) && /600 s/.test(o.stdout) && /atomnano wait <id> --timeout 540/.test(o.stdout), o.stdout.slice(0, 120));
  o = await run(["version"], {});
  check("C24", "version → 'atomnano <package version>' without touching the server", o.code === 0 && o.stdout === `atomnano ${require(path.join(ROOT, "package.json")).version}\n`, o);
  o = await run(["sessions"], ENV);
  check("C25", "atomnano sessions → table with status / role / name / cwd (a root session is the orchestrator)", o.code === 0 && /^ID\s+STATUS\s+ROLE\s+NAME\s+CWD\n/.test(o.stdout) && /s1\s+running\s+orchestrator\s+Fix login\s+E:\/proj/.test(o.stdout) && /c1\s+idle\s+coder/.test(o.stdout), o.stdout);
  o = await run(["providers"], ENV);
  check("C26", "atomnano providers → table with authorized + default model + current", o.code === 0 && /anthropic\s+Anthropic\s+yes\s+claude-opus-4-8\s+\*/.test(o.stdout) && /openai\s+OpenAI\s+yes\s+gpt-5\.6-sol/.test(o.stdout) && !/google/.test(o.stdout), o.stdout);
  o = await run(["models", "-P", "openai"], ENV);
  check("C27", "atomnano models -P provider → models + effort ladder", o.code === 0 && /^models for openai \(default gpt-5\.6-sol\)\n/.test(o.stdout) && /gpt-5\.6-sol\s+GPT-5\.6-Sol/.test(o.stdout) && /efforts: medium/.test(o.stdout), o.stdout);
  o = await run(["status"], { ATOMNANO_CONTROL: `http://127.0.0.1:${await closedPort()}`, ATOMNANO_TOKEN: "x" });
  check("C28", "server unreachable (connection refused) → exit 2 'AtomNano is not running — start the app'", o.code === 2 && o.stderr === "atomnano: AtomNano is not running — start the app\n", o);
  o = await run(["status"], { ATOMNANO_CONTROL: "http://127.0.0.1:1", ATOMNANO_TOKEN: "x" });
  check("C28b", "a malformed ATOMNANO_CONTROL (fetch's blocked port) → exit 1 naming the url and the cause", o.code === 1 && /Request to http:\/\/127\.0\.0\.1:1 failed: bad port \(check ATOMNANO_CONTROL\)/.test(o.stderr), o);
  o = await run(["status"], { ATOMNANO_CONTROL: B, ATOMNANO_TOKEN: "bad" });
  check("C29", "wrong token → exit 1 with a rediscovery hint", o.code === 1 && /control token was rejected/.test(o.stderr), o);

  /* ---------------- 540 s waits, sliced (2026-09-18) — a fake client stands in for the server, no real waiting ---------------- */
  // The CLI asks the server in SLICE_S (240 s) long-polls under the server's 600 s cap: --timeout 540 → 240 + 240 + 60.
  function sliceClient({ doneAt = Infinity, paused = null } = {}) {
    const calls = []; let n = 0;
    return { calls, url: "http://fake", async request(method, route, body, opts) {
      n++; calls.push({ method, route, body, timeoutMs: opts && opts.timeoutMs });
      const done = n >= doneAt;
      return { job: { id: "j-slice", kind: "role", role: "coder", parentId: "s1", sessionId: "child-9", status: done ? "done" : "running", paused: done ? null : paused, startedTs: new Date(Date.now() - 4000).toISOString(), durationMs: done ? 4000 : 0, result: done ? "SLICED OK" : "", editedFiles: [], error: "" } };
    } };
  }
  const runFake = async (args, client) => { let stdout = "", stderr = ""; const code = await cli.main(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env: DISCOVERY_ENV, client }); return { code, stdout, stderr, calls: client.calls }; };
  let sc = sliceClient({ paused: "offline" });
  o = await runFake(["run", "coder", "Long task", "--wait", "--timeout", "540"], sc);
  check("S540a", 'atomnano run coder "…" --wait --timeout 540 → POST /jobs { wait: 240 } (HTTP timeout 330 s), then GET /jobs/:id/wait?timeout=240 (270 s), then ?timeout=60 (90 s) — three requests, none above the 240 s slice; still running after 540 s → ONE short line naming the paused state and the next wait command, exit 0, nothing on stderr', o.code === 0 && o.calls.length === 3 && o.calls[0].method === "POST" && o.calls[0].route === "/v1/jobs" && o.calls[0].body.wait === 240 && o.calls[0].body.task === "Long task" && o.calls[0].timeoutMs === 330000 && o.calls[1].method === "GET" && o.calls[1].route === "/v1/jobs/j-slice/wait?timeout=240" && o.calls[1].timeoutMs === 270000 && o.calls[2].route === "/v1/jobs/j-slice/wait?timeout=60" && o.calls[2].timeoutMs === 90000 && /^job j-slice still running \(paused: offline\) after [^\n·]+ · coder — atomnano wait j-slice --timeout 540\n$/.test(o.stdout) && o.stderr === "", { calls: o.calls.map((c) => [c.method, c.route, c.body && c.body.wait, c.timeoutMs]), stdout: o.stdout });
  sc = sliceClient({ doneAt: 4 });
  o = await runFake(["wait", "j-slice", "--timeout", "540"], sc);
  check("S540b", "atomnano wait <id> --timeout 540 → GET /jobs/:id, then wait slices 240 · 240 · 60; a job that ends inside the last slice prints its result and the summary line, exit 0", o.code === 0 && o.calls.map((c) => c.route).join("|") === "/v1/jobs/j-slice|/v1/jobs/j-slice/wait?timeout=240|/v1/jobs/j-slice/wait?timeout=240|/v1/jobs/j-slice/wait?timeout=60" && o.stdout === "SLICED OK\n" && /^\[job j-slice · coder · done · 4\.0s · session child-9\]\n$/.test(o.stderr), { routes: o.calls.map((c) => c.route), out: o.stdout, err: o.stderr });
  sc = sliceClient();
  o = await runFake(["run", "coder", "Long task", "--wait", "--timeout", "540", "--json"], sc);
  let sj = null; try { sj = JSON.parse(o.stdout); } catch { /* */ }
  check("S540c", "--json keeps the JSON reply for a waited, unfinished job ({ job } with status running), exit 0; SLICE_S stays 240 and the server's long-poll cap stays 600", o.code === 0 && sj && sj.job && sj.job.status === "running" && o.calls.length === 3 && cli.SLICE_S === 240 && server.MAX_WAIT_S === 600, { out: o.stdout.slice(0, 120), calls: o.calls.length });

  /* ---------------- discovery through control.json ---------------- */
  o = await run(["status", "--json"], { ATOMNANO_USER_DATA: HOME });
  check("D01", "no env → control.json in ATOMNANO_USER_DATA is used", o.code === 0 && JSON.parse(o.stdout).pid === process.pid, o.stderr || o.stdout.slice(0, 80));
  const dirs = client.userDataDirs({ APPDATA: "C:\\U\\AppData\\Roaming", HOME: "/home/u" });
  check("D02", "userDataDirs: %APPDATA%/atomnano + AtomNano on Windows (Library/Application Support · .config elsewhere)", process.platform === "win32" ? dirs.join("|") === "C:\\U\\AppData\\Roaming\\atomnano|C:\\U\\AppData\\Roaming\\AtomNano" : dirs.length === 2 && dirs.every((d) => /atomnano$/i.test(d)), dirs);
  const stale = fs.mkdtempSync(path.join(HOME, "stale-"));
  const dead = spawnSync(process.execPath, ["-e", "0"]);   // a pid that has certainly exited
  fs.writeFileSync(path.join(stale, "control.json"), JSON.stringify({ url: B, token: T, pid: dead.pid }));
  o = await run(["status"], { ATOMNANO_USER_DATA: stale });
  check("D03", "a control.json whose pid is gone is ignored → exit 2", o.code === 2 && /not running/.test(o.stderr), { o, deadPid: dead.pid });
  o = await run(["status"], { ATOMNANO_USER_DATA: path.join(HOME, "empty-none") });
  check("D04", "nothing to discover → exit 2", o.code === 2, o);

  /* ---------------- bin/ launcher + shims as real processes ---------------- */
  const spawnEnv = { ...process.env, ...DISCOVERY_ENV, ATOMNANO_USER_DATA: HOME, ATOMNANO_SESSION: "", ATOMNANO_CONTROL: B, ATOMNANO_TOKEN: T };
  let p = await spawnAsync(process.execPath, [path.join(binDir, "atomnano.js"), "job", "j1", "--json"], spawnEnv);
  let pj = null; try { pj = JSON.parse(p.stdout); } catch { /* */ }
  check("B01", "node bin/atomnano.js → runs the CLI, flushes stdout, exits with its code", p.status === 0 && pj && pj.job && pj.job.id === "j1", { status: p.status, stderr: p.stderr, head: (p.stdout || "").slice(0, 80) });
  p = await spawnAsync(process.execPath, [path.join(binDir, "atomnano.js"), "coder", "please fail", "--wait"], spawnEnv);
  check("B02", "exit code 3 propagates through the launcher", p.status === 3 && /error/.test(p.stderr), { status: p.status, stderr: p.stderr });
  const nodeOnPath = { ...spawnEnv, ATOMNANO_NODE: "", PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
  if (process.platform === "win32") {
    p = await spawnAsync("cmd.exe", ["/d", "/c", path.join(binDir, "atomnano.cmd"), "version"], { ...spawnEnv, ATOMNANO_NODE: process.execPath });
    check("B03", "bin/atomnano.cmd runs the CLI through ATOMNANO_NODE (ELECTRON_RUN_AS_NODE=1)", p.status === 0 && /^atomnano \d/.test(p.stdout || ""), { status: p.status, out: p.stdout, err: p.stderr });
    p = await spawnAsync("cmd.exe", ["/d", "/c", path.join(binDir, "atomnano.cmd"), "status"], nodeOnPath);
    check("B04", "bin/atomnano.cmd falls back to `node` on PATH when ATOMNANO_NODE is unset", p.status === 0 && /^AtomNano 9\.9\.9/.test(p.stdout || ""), { status: p.status, out: (p.stdout || "").slice(0, 80), err: p.stderr });
  } else {
    p = await spawnAsync("sh", [path.join(binDir, "atomnano"), "version"], { ...spawnEnv, ATOMNANO_NODE: process.execPath });
    check("B03", "bin/atomnano (sh) runs the CLI through ATOMNANO_NODE", p.status === 0 && /^atomnano \d/.test(p.stdout || ""), { status: p.status, out: p.stdout, err: p.stderr });
    p = await spawnAsync("sh", [path.join(binDir, "atomnano"), "status"], nodeOnPath);
    check("B04", "bin/atomnano (sh) falls back to `node` on PATH", p.status === 0 && /^AtomNano 9\.9\.9/.test(p.stdout || ""), { status: p.status, out: (p.stdout || "").slice(0, 80), err: p.stderr });
  }
  const cmdText = fs.readFileSync(path.join(binDir, "atomnano.cmd"), "utf8");
  check("B05", "atomnano.cmd is ASCII with CRLF line endings and the ELECTRON_RUN_AS_NODE switch", /^[\x00-\x7f]*$/.test(cmdText) && /\r\n/.test(cmdText) && !/[^\r]\n/.test(cmdText) && /set ELECTRON_RUN_AS_NODE=1/.test(cmdText) && /"%ATOMNANO_NODE%" "%~dp0atomnano.js" %\*/.test(cmdText), cmdText.slice(0, 60));
  check("B06", "package.json keeps bin → bin/atomnano.js and the cli script; src/cli/cli.js is gone", (() => { const pkg = require(path.join(ROOT, "package.json")); return pkg.bin.atomnano === "bin/atomnano.js" && pkg.scripts.cli === "node bin/atomnano.js" && !fs.existsSync(path.join(ROOT, "src/cli/cli.js")); })());

  /* ---------------- workflow:* IPC (ipc/workflow.js with fake store / manager) ---------------- */
  const ipc = require(path.join(ROOT, "src/main/ipc/workflow.js"));
  const settings = { global: { llmProvider: "anthropic", workflows: [] }, projects: {} };
  const saves = [];
  const ipcStore = {
    uid: fakeStore.uid, getSession: fakeStore.getSession, getMeta: fakeStore.getMeta, listSessions: fakeStore.listSessions,
    updateSession: (id, patch) => { const s = fakeStore.getSession(id); if (s) Object.assign(s, patch); return s; },   // per-session workflows land here
    getSettings: (cwd) => ({ ...settings.global, ...(cwd ? settings.projects[cwd] || {} : {}) }),
    saveSettings: (patch, cwd) => { saves.push({ keys: Object.keys(patch), cwd }); for (const k of Object.keys(patch)) { if (cwd && k !== "workflows") (settings.projects[cwd] = settings.projects[cwd] || {})[k] = patch[k]; else settings.global[k] = patch[k]; } },
  };
  // Like the real mixin, workflowFor(cwd) resolves the store's per-project `workflow` (jobs still go to M).
  const IM = Object.create(M);
  IM.workflowFor = (x) => ipc.normalizeWorkflow(ipcStore.getSettings(typeof x === "string" ? x : x && x.cwd).workflow, ipcStore);
  const H = {};
  ipc.register({ handle: (ch, fn) => { H[ch] = fn; }, winFrom: () => null, projectOf: () => "E:/proj", store: ipcStore, manager: IM, control: server });
  const E = {};
  check("I01", "register() installs every workflow:* channel of contract §6 (+ clear, §10)", ["get", "set", "clear", "save", "load", "delete", "rename", "duplicate", "export", "import", "jobs", "run", "stop", "brief", "control"].every((k) => typeof H["workflow:" + k] === "function"), Object.keys(H));
  let g = await H["workflow:get"](E, "E:/proj");
  check("I02", "workflow:get → contract defaults when nothing is stored (the Orchestrator primary + the Planner worker), empty library, control { url, running }", g.active.enabled === false && g.active.name === "Solo" && g.active.savedId === null && g.active.roles.coder.agents === 3 && g.active.roles.reviewer.access === "read" && g.active.roles.orchestrator.provider === "" && g.active.roles.planner.enabled === true && g.active.roles.planner.access === "read" && g.active.roles.planner.agents === 0 && g.active.openJobTabs === false && !("autoOpenJobs" in g.active) && g.library.length === 0 && g.control.running === true && g.control.url === B && g.control.binDir === binDir, g);
  let s = await H["workflow:set"](E, { enabled: true, roles: { coder: { agents: 5, model: "claude-opus-5" } }, layout: { coder: { x: 10, y: 20 } } }, "E:/proj");
  check("I03", "workflow:set deep-merges into the active workflow and saves it PER PROJECT", s.active.enabled === true && s.active.roles.coder.agents === 5 && s.active.roles.coder.model === "claude-opus-5" && s.active.roles.coder.effort === "high" && s.active.roles.reviewer.provider === "openai" && s.active.layout.coder.y === 20 && saves.at(-1).cwd === "E:/proj" && saves.at(-1).keys.join() === "workflow", { active: s.active, save: saves.at(-1) });
  s = await H["workflow:set"](E, { roles: { coder: { agents: 99, access: "nope" } }, layout: { reviewer: { x: 1, y: 2 } } }, "E:/proj");
  check("I04", "set() clamps agents to 0–20, rejects unknown access values, keeps other layout nodes", s.active.roles.coder.agents === 20 && s.active.roles.coder.access === "bypassPermissions" && s.active.layout.coder.x === 10 && s.active.layout.reviewer.x === 1, s.active);
  let sv = await H["workflow:save"](E, "Team A");
  const idA = sv.entry.id;
  check("I05", "workflow:save(name) → new library entry { id, name, createdAt, updatedAt, workflow:{roles,layout,brief,openJobTabs} }; active gets name + savedId; library saved GLOBALLY", sv.library.length === 1 && sv.entry.name === "Team A" && !!idA && !!sv.entry.createdAt && Object.keys(sv.entry.workflow).sort().join() === "brief,layout,openJobTabs,roles" && sv.entry.workflow.roles.coder.agents === 20 && !("enabled" in sv.entry.workflow) && sv.active.savedId === idA && sv.active.name === "Team A" && saves.some((x) => x.keys.join() === "workflows" && x.cwd === undefined), { entry: sv.entry, saves: saves.slice(-2) });
  await H["workflow:set"](E, { roles: { coder: { agents: 2 } } }, "E:/proj");
  sv = await H["workflow:save"](E, "Team A v2", idA);
  check("I06", "workflow:save(name, id) overwrites that entry in place (same id, new name/content, one entry)", sv.library.length === 1 && sv.library[0].id === idA && sv.library[0].name === "Team A v2" && sv.library[0].workflow.roles.coder.agents === 2 && sv.active.name === "Team A v2", sv.library);
  let d = await H["workflow:duplicate"](E, idA);
  const idB = d.entry.id;
  check("I07", "workflow:duplicate → a copy with a fresh id and a unique name", d.library.length === 2 && idB !== idA && d.entry.name === "Team A v2 copy" && d.entry.workflow.roles.coder.agents === 2, d.entry);
  let rn = await H["workflow:rename"](E, idB, "Team B");
  check("I08", "workflow:rename → entry renamed, active untouched when it points elsewhere", rn.library.find((x) => x.id === idB).name === "Team B" && rn.active.name === "Team A v2" && rn.active.savedId === idA, rn.active);
  await H["workflow:set"](E, { enabled: true, roles: { coder: { agents: 7 } } }, "E:/proj");
  let ld = await H["workflow:load"](E, idB);
  check("I09", "workflow:load → the entry becomes the active workflow (enabled flag kept, name + savedId set)", ld.active.savedId === idB && ld.active.name === "Team B" && ld.active.enabled === true && ld.active.roles.coder.agents === 2, ld.active);
  rn = await H["workflow:rename"](E, idB, "Team B!");
  check("I10", "renaming the loaded entry renames the active workflow too", rn.active.name === "Team B!" && rn.active.savedId === idB, rn.active);
  const f1 = path.join(HOME, "out", "team-b.workflow.json");
  let ex = await H["workflow:export"](E, idB, f1);
  const file1 = JSON.parse(fs.readFileSync(f1, "utf8"));
  check("I11", "workflow:export(id, path) writes { atomnanoWorkflow: 1, name, workflow }", ex.ok === true && ex.path === f1 && file1.atomnanoWorkflow === 1 && file1.name === "Team B!" && file1.workflow.roles.coder.agents === 2 && !("enabled" in file1.workflow), file1);
  const f2 = path.join(HOME, "out", "active.workflow.json");
  await H["workflow:set"](E, { roles: { tester: { command: "npm test" } } }, "E:/proj");
  ex = await H["workflow:export"](E, null, f2);
  const file2 = JSON.parse(fs.readFileSync(f2, "utf8"));
  check("I12", "workflow:export(null, path) exports the ACTIVE workflow", ex.ok && file2.name === "Team B!" && file2.workflow.roles.tester.command === "npm test", file2);
  ex = await H["workflow:export"](E, null);
  check("I13", "export without a path opens the save dialog; cancel → { canceled: true }", ex.canceled === true, ex);
  let im = await H["workflow:import"](E, f1);
  check("I14", "workflow:import(path) validates, assigns a new id, appends with a unique name → { entry, library }", im.entry.id !== idB && im.entry.name === "Team B! 2" && im.entry.workflow.roles.coder.agents === 2 && im.library.length === 3, im.entry);
  fs.writeFileSync(path.join(HOME, "bad.json"), JSON.stringify({ hello: 1 }));
  let bad = null; try { await H["workflow:import"](E, path.join(HOME, "bad.json")); } catch (e) { bad = e.message; }
  let bad2 = null; try { await H["workflow:import"](E, path.join(HOME, "missing.json")); } catch (e) { bad2 = e.message; }
  check("I15", "import rejects a non-workflow file and a missing file with plain sentences", /Not an AtomNano workflow file/.test(bad) && bad2 === "Could not read the file", { bad, bad2 });
  im = await H["workflow:import"](E);
  check("I16", "import without a path opens the open dialog; cancel → { canceled: true }", im.canceled === true, im);
  let del = await H["workflow:delete"](E, idB);
  check("I17", "workflow:delete removes the entry; an active workflow loaded from it keeps its values but loses savedId", del.library.length === 2 && !del.library.some((x) => x.id === idB) && del.active.savedId === null && del.active.name === "Team B!" && del.active.roles.tester.command === "npm test", del.active);
  let nf = null; try { await H["workflow:load"](E, "missing"); } catch (e) { nf = e.message; }
  check("I18", "load of a missing id → plain error", /no longer in the library/.test(nf), nf);
  const jb = await H["workflow:jobs"](E, "s1");
  const rj = await H["workflow:run"](E, "s1", { role: "coder", task: "from the studio", files: ["x.js"], agents: 4 });
  const lastCall = M.calls.at(-1);
  check("I19", "workflow:jobs → { jobs }; workflow:run → startRoleJob(sessionId, { role, task, files, agents, from:'ui' }) → { job }", Array.isArray(jb.jobs) && jb.jobs.length === M.jobsFor("s1").length - 1 && rj.job.from === "ui" && lastCall[1] === "s1" && lastCall[2].files.join() === "x.js" && lastCall[2].agents === 4, { lastCall, job: rj.job.id });
  const stp = await H["workflow:stop"](E, rj.job.id);
  check("I20", "workflow:stop → manager.stopJob result", stp.ok === true && M.jobInfo(rj.job.id).status === "stopped", stp);
  const rjf = await H["workflow:run"](E, "s1", { role: "coder", task: "from the studio, with the plan", fromJob: "j1" });
  const fromUi = M.calls.at(-1);
  await H["workflow:run"](E, "s1", { role: "coder", task: "no source", fromJob: "  " });
  check("I20b", "workflow:run forwards an optional fromJob to startRoleJob (from stays 'ui'; the job reports fromJob); a blank fromJob is not forwarded", rjf.job.fromJob === "j1" && fromUi[2].fromJob === "j1" && fromUi[2].from === "ui" && fromUi[2].task === "from the studio, with the plan" && M.calls.at(-1)[2].fromJob === undefined && M.calls.at(-1)[2].from === "ui", { fromUi: fromUi && fromUi[2], last: M.calls.at(-1)[2] });
  const br = await H["workflow:brief"](E, "s1");
  check("I21", "workflow:brief → { text, generated:true } from manager.orchestratorBrief(session, wf, provider)", /^Orchestrator brief for s1/.test(br.text) && /Your session id is s1/.test(br.text) && /\(anthropic\)/.test(br.text) && br.generated === true, br);
  const ci = await H["workflow:control"](E);
  check("I22", "workflow:control → { url, running, binDir }", ci.running === true && ci.url === B && ci.binDir === binDir && Object.keys(ci).sort().join() === "binDir,running,url", ci);
  let noSess = null; try { await H["workflow:brief"](E, "nope"); } catch (e) { noSess = e.message; }
  check("I23", "brief for an unknown session → 'Session not found'", noSess === "Session not found", noSess);
  check("I24", "normalizeWorkflow / DEFAULT_WORKFLOW / PRIMARY exported; garbage in → contract shape out (the Planner worker filled from the defaults)", (() => { const w = ipc.normalizeWorkflow({ roles: { coder: { agents: "abc" }, planner: null }, name: "", layout: "x" }); return w.name === "Custom" && w.roles.coder.agents === 3 && w.roles.orchestrator.access === "bypassPermissions" && w.roles.planner.access === "read" && w.roles.planner.enabled === true && typeof w.layout === "object" && ipc.DEFAULT_WORKFLOW.roles.tester.command === "" && ipc.PRIMARY === "orchestrator"; })());
  check("I25", "the orchestrator's \"\" access / provider (follow the composer) survive normalisation; other roles fall back", (() => { const w = ipc.normalizeWorkflow({ roles: { orchestrator: { access: "", provider: "" }, coder: { access: "" } } }); return w.roles.orchestrator.access === "" && w.roles.orchestrator.provider === "" && w.roles.coder.access === "bypassPermissions"; })());
  check("I25c", "roles.<planner|coder|reviewer>.skills (attached skill ids) survive normalisation as clean, deduped ids; the tester never carries skills; SKILL_ROLES is exported", (() => { const w = ipc.normalizeWorkflow({ roles: { coder: { skills: ["a", "", 3, "b", "a"] }, tester: { skills: ["x"] } } }); return w.roles.coder.skills.join() === "a,b" && w.roles.planner.skills.length === 0 && w.roles.reviewer.skills.length === 0 && !("skills" in w.roles.tester) && ipc.SKILL_ROLES.join() === "planner,coder,reviewer"; })());
  check("I25b", "a pre-Orchestrator save (the primary's picks under roles.planner without enabled / agents, its node under layout.planner) migrates to roles.orchestrator / layout.orchestrator and the Planner takes the worker defaults; migrateLegacyPrimary is exported and leaves a new-shape save alone", (() => { const w = ipc.normalizeWorkflow({ roles: { planner: { access: "", provider: "openai", model: "gpt-5.5" }, coder: { agents: 4 } }, layout: { planner: { x: 8, y: 16 } } }); const n = ipc.normalizeWorkflow({ roles: { orchestrator: { provider: "openai" }, planner: { enabled: false, provider: "openai" } } }); return w.roles.orchestrator.access === "" && w.roles.orchestrator.provider === "openai" && w.roles.orchestrator.model === "gpt-5.5" && w.roles.planner.provider === "anthropic" && w.roles.planner.enabled === true && w.roles.planner.access === "read" && w.roles.coder.agents === 4 && w.layout.orchestrator.x === 8 && !w.layout.planner && n.roles.planner.enabled === false && n.roles.planner.provider === "openai" && n.roles.orchestrator.provider === "openai" && typeof ipc.migrateLegacyPrimary === "function"; })());
  check("I26", "defaults come from store.workflowDefaults() when the store has it (coordinator), else the local copy", (() => { const d = ipc.defaultsOf({ workflowDefaults: () => ({ enabled: false, name: "FromStore", roles: { coder: { agents: 9 } } }) }); const w = ipc.normalizeWorkflow(null, { workflowDefaults: () => ({ name: "FromStore", roles: { coder: { agents: 9 } } }) }); return d.name === "FromStore" && d.roles.coder.agents === 9 && d.roles.reviewer.access === "read" && w.name === "FromStore" && w.roles.coder.agents === 9 && ipc.defaultsOf(null).name === "Solo"; })());
  // ---- per-session workflows (contract §10, 2026-09-18): a tab's own workflow vs the project's ----
  { const s1rec = ipcStore.getSession("s1"), s2rec = ipcStore.getSession("s2");
    let ps = await H["workflow:get"](E, "E:/proj", "s2");
    check("I27", "workflow:get with a session that has no workflow of its own → the project's active workflow, scope 'project'", ps.scope === "project" && ps.active.name === ipcStore.getSettings("E:/proj").workflow.name && !s2rec.workflow, { scope: ps.scope, name: ps.active.name });
    ps = await H["workflow:set"](E, { enabled: true, roles: { coder: { agents: 7 } } }, "E:/proj", "s2");
    const proj = ipcStore.getSettings("E:/proj").workflow;
    const g1 = await H["workflow:get"](E, "E:/proj", "s1"), g2 = await H["workflow:get"](E, "E:/proj", "s2");
    check("I28", "workflow:set with a session id gives THAT session its own copy (edited) and leaves the project's active workflow untouched; another session still reads the project's", ps.scope === "session" && ps.active.roles.coder.agents === 7 && s2rec.workflow && s2rec.workflow.roles.coder.agents === 7 && proj.roles.coder.agents !== 7 && g1.scope === "project" && g1.active.roles.coder.agents === proj.roles.coder.agents && g2.scope === "session" && g2.active.roles.coder.agents === 7, { s2: s2rec.workflow && s2rec.workflow.roles.coder.agents, proj: proj.roles.coder.agents, g1: g1.scope });
    const cl = await H["workflow:save"](E, "Tab two flow", undefined, "s2");
    check("I29", "Clone (workflow:save without an id, with a session id): a NEW library entry from the tab's design, bound to that tab only — savedId + name on the session, the project's active workflow unchanged", cl.scope === "session" && cl.entry.name === "Tab two flow" && cl.entry.workflow.roles.coder.agents === 7 && s2rec.workflow.savedId === cl.entry.id && s2rec.workflow.name === "Tab two flow" && ipcStore.getSettings("E:/proj").workflow.savedId !== cl.entry.id && cl.library.some((x) => x.id === cl.entry.id), { entry: cl.entry.name, s2: s2rec.workflow.savedId });
    const ld = await H["workflow:load"](E, cl.entry.id, "s1");
    check("I30", "workflow:load with a session id binds the entry to that session as its own copy (enabled flag kept from what it ran before); the project's stays", ld.scope === "session" && s1rec.workflow && s1rec.workflow.savedId === cl.entry.id && s1rec.workflow.roles.coder.agents === 7 && s1rec.workflow.enabled === proj.enabled && ipcStore.getSettings("E:/proj").workflow.savedId !== cl.entry.id, { s1: s1rec.workflow && s1rec.workflow.savedId });
    const cr = await H["workflow:clear"](E, "s1");
    let noSess2 = null; try { await H["workflow:clear"](E, "nope"); } catch (e) { noSess2 = e.message; }
    check("I31", "workflow:clear drops the session's own workflow → it follows the project's again (scope 'project'); an unknown session → 'Session not found'", cr.scope === "project" && s1rec.workflow === null && cr.active.name === ipcStore.getSettings("E:/proj").workflow.name && noSess2 === "Session not found", { s1: s1rec.workflow, err: noSess2 });
    // ---- round 4 (2026-09-18): the library IPCs take a trailing cwd — the project the studio CAPTURED before its dialog opened — honoured
    //      only without a session id (like workflow:get / set), so a Save As confirmed after the window switched projects still lands where it started ----
    const other = await H["workflow:save"](E, "Elsewhere", undefined, undefined, "E:/other");
    const rn = await H["workflow:rename"](E, other.entry.id, "Elsewhere 2", undefined, "E:/other");
    const otherWf = () => ipcStore.getSettings("E:/other").workflow || {}, projWf = () => ipcStore.getSettings("E:/proj").workflow || {};
    check("I32", "workflow:save / rename with NO session id and an explicit cwd write THAT project's active workflow (scope 'project'), not the window's project (E:/proj) — which keeps its own savedId and name", other.scope === "project" && otherWf().savedId === other.entry.id && otherWf().name === "Elsewhere 2" && projWf().savedId !== other.entry.id && projWf().name !== "Elsewhere 2" && rn.library.some((x) => x.id === other.entry.id && x.name === "Elsewhere 2"), { other: [otherWf().savedId, otherWf().name], proj: [projWf().savedId, projWf().name] });
    const again = await H["workflow:save"](E, "Tab two again", undefined, "s2", "E:/other");
    const otherBefore = otherWf().savedId, s2Saved = s2rec.workflow && s2rec.workflow.savedId;   // what the sid save bound, BEFORE the deletes below unbind it
    await H["workflow:delete"](E, other.entry.id, undefined, "E:/other");
    await H["workflow:delete"](E, again.entry.id, "s2");
    check("I33", "with a session id the trailing cwd is IGNORED: the save lands on that session's own copy and E:/other / E:/proj do not change; workflow:delete follows the same rule (no sid + cwd unbinds E:/other's savedId, a sid unbinds the session's) and both entries leave the library", again.scope === "session" && s2Saved === again.entry.id && s2rec.workflow && s2rec.workflow.name === "Tab two again" && otherBefore === other.entry.id && projWf().savedId !== again.entry.id && otherWf().savedId == null && s2rec.workflow.savedId == null && !ipcStore.getSettings("E:/proj").workflows.some((x) => x.id === other.entry.id || x.id === again.entry.id), { s2Saved, s2After: s2rec.workflow && [s2rec.workflow.savedId, s2rec.workflow.name], otherBefore, otherAfter: otherWf().savedId, lib: ipcStore.getSettings("E:/proj").workflows.map((x) => x.name) });
    s2rec.workflow = null; }   // leave the fixtures as the later tests expect them

  // Real manager jobs carry an ISO startedTs and durationMs 0 while running; jobs may be paused.
  const ISO = new Date(Date.now() - 65000).toISOString();
  const fmt = require(path.join(ROOT, "src/cli/format.js"));
  check("F01", "format: a running job with ISO startedTs + durationMs 0 shows elapsed time, not 0ms; a finished one its duration; paused is visible", /^1m 0[4-6]s$/.test(fmt.jobDuration({ status: "running", startedTs: ISO, durationMs: 0 })) && fmt.jobDuration({ status: "done", startedTs: ISO, durationMs: 4200 }) === "4.2s" && fmt.statusLabel({ status: "running", paused: "offline" }) === "running (paused: offline)" && fmt.statusLabel({ status: "done", paused: null }) === "done", { run: fmt.jobDuration({ status: "running", startedTs: ISO, durationMs: 0 }) });

  /* ================= TASK BOARD (contract §8.3) ================= */
  /* ---- server routes (planner s1, running) ---- */
  r = await api(B, T, "GET", "/v1/tasks?session=s1");
  check("T01", "GET /tasks on an empty board → { board:{ sets:[], items:[], counts }, all:false, session }", r.status === 200 && r.json.board.sets.length === 0 && r.json.board.items.length === 0 && r.json.board.counts.total === 0 && r.json.board.hidden.sets === 0 && r.json.all === false && r.json.session === "s1", r.json);
  r = await api(B, T, "POST", "/v1/tasks", { session: "s1", titles: ["Wire the webhook", "Add retries"], set: { title: "Payments" } });
  let tc = M.taskCalls.at(-1);
  check("T02", "POST /tasks { titles, set:{title} } → addTasks(session, { titles, set }, { by:'orchestrator' }) → { set, items T1 T2 }", r.status === 200 && r.json.set.n === 1 && r.json.set.title === "Payments" && r.json.set.status === "active" && r.json.items.map((i) => i.n).join() === "1,2" && r.json.items[0].status === "todo" && r.json.items[0].setId === r.json.set.id && tc[0] === "addTasks" && tc[1] === "s1" && tc[2].titles.join() === "Wire the webhook,Add retries" && tc[2].set.title === "Payments" && tc[3] === "orchestrator", { reply: r.json, call: tc });
  r = await api(B, T, "POST", "/v1/tasks", { session: "s1", items: [{ title: "Review the schema", role: "review", detail: "pg" }] });
  check("T03", "POST /tasks { items:[{ title, role, detail }] } without a set → appended to the active set; role alias normalised", r.status === 200 && r.json.set.n === 1 && r.json.items.length === 1 && r.json.items[0].n === 3 && r.json.items[0].role === "reviewer" && r.json.items[0].detail === "pg", r.json);
  r = await api(B, T, "GET", "/v1/tasks/T1?session=s1");
  check("T04", "GET /tasks/:ref → { item, set } (the item's set comes along)", r.status === 200 && r.json.item.n === 1 && r.json.item.title === "Wire the webhook" && r.json.set.n === 1 && r.json.set.title === "Payments" && r.json.session === "s1", r.json);
  const refs = await Promise.all(["t2", "2", "%232"].map((x) => api(B, T, "GET", `/v1/tasks/${x}?session=s1`)));
  check("T05", "refs t2 · 2 · #2 all resolve to T2", refs.every((x) => x.status === 200 && x.json.item.n === 2), refs.map((x) => x.status));
  r = await api(B, T, "PATCH", "/v1/tasks/T1", { session: "s1", status: "doing", role: "coder" });
  tc = M.taskCalls.at(-1);
  check("T06", "PATCH /tasks/:ref { status, role } → updateTask(session, 'T1', { status, role }, { by:'orchestrator' }) → { item }", r.status === 200 && r.json.item.status === "doing" && r.json.item.role === "coder" && tc[0] === "updateTask" && tc[2] === "T1" && tc[3].status === "doing" && tc[3].role === "coder" && tc[4] === "orchestrator", { reply: r.json, call: tc });
  r = await api(B, T, "PATCH", "/v1/tasks/T1", { session: "s1", status: "done", note: "ok" });
  check("T07", "PATCH { status:'done', note } → doneTs set, note appended { by:'orchestrator', text }", r.status === 200 && r.json.item.status === "done" && !!r.json.item.doneTs && r.json.item.notes.length === 1 && r.json.item.notes[0].by === "orchestrator" && r.json.item.notes[0].text === "ok" && r.json.set.n === 1, r.json);
  r = await api(B, T, "PATCH", "/v1/tasks/T99", { session: "s1", status: "done" });
  check("T08", "unknown ref → 404 { error }", r.status === 404 && /No task T99/.test(r.json.error), r.json);
  r = await api(B, T, "PATCH", "/v1/tasks/T2", { session: "s1", status: "nope" });
  check("T09", "bad status → 400 listing the valid ones", r.status === 400 && /Unknown status "nope"/.test(r.json.error) && /todo, doing, review, test, done, blocked, dropped/.test(r.json.error), r.json);
  r = await api(B, T, "PATCH", "/v1/tasks/T2", { session: "s1" });
  check("T10", "PATCH with nothing to change → 400", r.status === 400 && /Nothing to update/.test(r.json.error), r.json);
  r = await api(B, T, "POST", "/v1/tasks", { session: "s1" });
  const badRole = await api(B, T, "POST", "/v1/tasks", { session: "s1", items: [{ title: "x", role: "boss" }] });
  check("T11", "POST /tasks without titles → 400; an unknown role → 400", r.status === 400 && /At least one task title/.test(r.json.error) && badRole.status === 400 && /Unknown role "boss"/.test(badRole.json.error), { r: r.json, badRole: badRole.json });
  r = await api(B, T, "POST", "/v1/tasks/sets", { session: "s1", title: "Refunds" });
  const set2 = r.json.set;
  const allB = (await api(B, T, "GET", "/v1/tasks?session=s1&all=1")).json.board;
  check("T12", "POST /tasks/sets { title } → openTaskSet → { set } active; the previous set (open items) reads closed", r.status === 200 && set2.n === 2 && set2.status === "active" && allB.active === set2.id && allB.sets.length === 2 && allB.sets[0].status === "closed", { set2, sets: allB.sets });
  r = await api(B, T, "POST", "/v1/tasks", { session: "c1", titles: ["From the coder"] });
  tc = M.taskCalls.at(-1);
  check("T13", "a role child's session resolves to its PLANNER's board and `by` defaults to its role", r.status === 200 && r.json.session === "s1" && r.json.items[0].n === 4 && r.json.set.n === 2 && tc[1] === "s1" && tc[3] === "coder", { reply: r.json, call: tc });
  for (const [t, s] of [["Third", "S3"], ["Fourth", "S4"], ["Fifth", "S5"]]) await api(B, T, "POST", "/v1/tasks", { session: "s1", titles: [t], set: { title: s } });
  r = await api(B, T, "GET", "/v1/tasks?session=s1");
  const rAll = await api(B, T, "GET", "/v1/tasks?session=s1&all=1");
  check("T14", "default view = the active set + the last 2 finished sets (their items only, hidden counted; counts stay board-wide); all=1 → everything", r.status === 200 && r.json.board.sets.map((s) => s.n).join() === "3,4,5" && r.json.board.items.map((i) => i.n).join() === "5,6,7" && r.json.board.hidden.sets === 2 && r.json.board.hidden.items === 4 && r.json.board.counts.total === 7 && rAll.json.board.sets.length === 5 && rAll.json.board.items.length === 7 && rAll.json.board.hidden.sets === 0 && rAll.json.all === true, { def: { sets: r.json.board.sets.map((s) => s.n), items: r.json.board.items.map((i) => i.n), hidden: r.json.board.hidden }, all: rAll.json.board.sets.length });
  const jobsBefore = M.calls.length;
  r = await api(B, T, "POST", "/v1/jobs", { session: "s1", role: "coder", task: "Do the fifth", taskRef: "t7", wait: 2 });
  const linkCall = M.calls.filter((x) => x[0] === "startRoleJob").pop();
  check("T15", "POST /jobs { task, taskRef } → startRoleJob(parent, { …, task: text, taskRef:'T7' }); the job carries taskN", r.status === 200 && r.json.job.status === "done" && r.json.job.taskN === 7 && linkCall[2].task === "Do the fifth" && linkCall[2].taskRef === "T7" && M.taskCalls.some((x) => x[0] === "linkJobToTask" && x[2] === "T7"), { call: linkCall && linkCall[2], job: r.json.job && r.json.job.taskN });
  r = await api(B, T, "POST", "/v1/jobs", { session: "s1", role: "coder", task: "x", taskRef: "T99" });
  check("T15b", "POST /jobs with an unknown taskRef → 404 and NO job is started", r.status === 404 && /No task T99/.test(r.json.error) && M.calls.length === jobsBefore + 1, { r: r.json, calls: M.calls.length - jobsBefore });
  r = await api(B, T, "POST", "/v1/tests", { session: "s1", command: "npm test", taskRef: "T7", wait: 5 });
  const cmdCall = M.calls.filter((x) => x[0] === "runCommandJob").pop();
  check("T16", "POST /tests { taskRef } → runCommandJob(parent, { command, taskRef })", r.status === 200 && r.json.job.status === "done" && cmdCall[4].taskRef === "T7" && cmdCall[4].command === "npm test", cmdCall && cmdCall[4]);
  r = await api(B, T, "PUT", "/v1/tasks/T1", {});
  const delT = await api(B, T, "DELETE", "/v1/tasks");
  check("T17", "wrong methods → 405 (PATCH for /tasks/:ref, POST for /tasks)", r.status === 405 && /Use PATCH/.test(r.json.error) && delT.status === 405 && /Use POST/.test(delT.json.error), { r: r.json, del: delT.json });
  r = await api(B, T, "GET", "/v1/tasks");
  check("T18", "session omitted → the single running planner (as for jobs)", r.status === 200 && r.json.session === "s1" && r.json.board.counts.total === 7, r.json.session);
  r = await api(B, T, "GET", "/v1/tasks?session=nope");
  const nope2 = await api(B, T, "GET", "/v1/tasks/T1?session=nope");
  check("T19", "unknown explicit session → 404 on every tasks route", r.status === 404 && /No session with id nope/.test(r.json.error) && nope2.status === 404, { r: r.json, nope2: nope2.json });
  r = await api(B, T, "GET", "/v1/status?session=s1");
  check("T20", "GET /status carries the board's progress + active set { counts, active:{ n, title } }", r.status === 200 && r.json.board && r.json.board.counts.total === 7 && r.json.board.counts.done === 1 && r.json.board.active.n === 5 && r.json.board.active.title === "S5", r.json.board);
  const bf = M.boardFor; M.boardFor = undefined;
  r = await api(B, T, "GET", "/v1/tasks?session=s1");
  const st501 = await api(B, T, "GET", "/v1/status?session=s1");
  M.boardFor = bf;
  check("T21", "a manager without the board mixin → 501 on /tasks; /status still answers (board null)", r.status === 501 && /not available in this build/.test(r.json.error) && st501.status === 200 && st501.json.board === null, { r: r.json, status: st501.status });

  /* ---- CLI end to end (planner s2, explicit --session) ---- */
  const S2 = ["--session", "s2"];
  o = await run(["tasks", "add", "a", "b", "--set", "Sprint 1", ...S2], ENV);
  check("TC01", 'atomnano tasks add "a" "b" --set "Sprint 1" → "added 2 tasks → Set 1 · Sprint 1" + rows T1 / T2', o.code === 0 && o.stdout === "added 2 tasks → Set 1 · Sprint 1\n  T1  todo  -  a\n  T2  todo  -  b\n", o);
  o = await run(["tasks", ...S2], ENV);
  check("TC02", "atomnano tasks → set header 'Set 1 · Sprint 1 · 0/2 done · active' with its rows", o.code === 0 && o.stdout === "Set 1 · Sprint 1 · 0/2 done · active\n  T1  todo  -  a\n  T2  todo  -  b\n", o);
  o = await run(["tasks", "start", "T1", ...S2], ENV);
  tc = M.taskCalls.at(-1);
  check("TC03", "atomnano tasks start T1 → PATCH { status:'doing' } by orchestrator → the row", o.code === 0 && o.stdout === "T1  doing  -  a\n" && tc[0] === "updateTask" && tc[1] === "s2" && tc[3].status === "doing" && tc[4] === "orchestrator", { o, call: tc });
  o = await run(["tasks", "done", "T1", "--note", "ok", ...S2], ENV);
  check("TC04", 'atomnano tasks done T1 --note "ok" → row + the note line', o.code === 0 && o.stdout === "T1  done  -  a\n  T1 note (orchestrator): ok\n" && M.taskCalls.at(-1)[3].note === "ok", o);
  o = await run(["tasks", "show", "T1", ...S2], ENV);
  check("TC05", "atomnano tasks show T1 → header, set, timestamps, notes", o.code === 0 && /^T1 · done · - · a\nset       Set 1 · Sprint 1\ncreated   \d{4}-\d\d-\d\d \d\d:\d\d · updated \d{4}-\d\d-\d\d \d\d:\d\d · done \d{4}-\d\d-\d\d \d\d:\d\d\nnotes \(1\)\n  \d{4}-\d\d-\d\d \d\d:\d\d  orchestrator  ok\n$/.test(o.stdout), o.stdout);
  o = await run(["tasks", "add", "c", "--role", "review", "--detail", "d", ...S2], ENV);
  check("TC06", 'atomnano tasks add "c" --role review --detail d → items:[{ title, detail, role }] appended to the active set', o.code === 0 && o.stdout === "added 1 task → Set 1 · Sprint 1\n  T3  todo  reviewer  c\n" && M.taskCalls.at(-1)[2].items[0].detail === "d" && M.taskCalls.at(-1)[2].items[0].role === "reviewer", { o, call: M.taskCalls.at(-1)[2] });
  o = await run(["tasks", "sets", ...S2], ENV);
  check("TC07", "atomnano tasks sets → one line per set", o.code === 0 && o.stdout === "Set 1 · Sprint 1 · 1/3 done · active\n", o);
  o = await run(["tasks", "--json", ...S2], ENV);
  parsed = null; try { parsed = JSON.parse(o.stdout); } catch { /* */ }
  check("TC08", "atomnano tasks --json → the server's { board, all, session }", o.code === 0 && parsed && parsed.board.items.length === 3 && parsed.board.sets.length === 1 && parsed.session === "s2" && parsed.all === false, o.stdout.slice(0, 120));
  o = await run(["run", "coder", "x", "--task", "T2", ...S2], ENV);
  const linked = M.calls.filter((x) => x[0] === "startRoleJob").pop();
  check("TC09", 'atomnano run coder "x" --task T2 → taskRef forwarded; the started line names the task', o.code === 0 && linked[2].taskRef === "T2" && linked[2].task === "x" && /^job j\d+ running · coder · task T2 · anthropic\/claude-opus-4-8/.test(o.stdout), { o, call: linked && linked[2] });
  o = await run(["run", "coder", "y", "--context", ...S2], ENV);
  const ctxd = M.calls.filter((x) => x[0] === "startRoleJob").pop();
  check("TC09b", 'atomnano run coder "y" --context → context: true forwarded to startRoleJob (the planner conversation travels with the task); plain runs carry no context flag', o.code === 0 && ctxd[2].context === true && ctxd[2].task === "y" && linked[2].context === undefined, { call: ctxd && ctxd[2] });
  o = await run(["tasks", "note", "T2", "needs the schema first", ...S2], ENV);
  check("TC10", 'atomnano tasks note T2 "text" → PATCH { note } → row + note', o.code === 0 && o.stdout === "T2  todo  -  b\n  T2 note (orchestrator): needs the schema first\n", o);
  o = await run(["tasks", "block", "T2", ...S2], ENV);
  const o3 = await run(["tasks", "drop", "T2", "T3", ...S2], ENV);
  check("TC11", "tasks block T2 → blocked; tasks drop T2 T3 → several refs at once, one row each", o.code === 0 && o.stdout === "T2  blocked  -  b\n" && o3.code === 0 && /^T2  dropped  -\s+b\nT3  dropped  reviewer  c\n$/.test(o3.stdout), { o, o3 });
  o = await run(["tasks", "set", "Sprint 2", ...S2], ENV);
  check("TC12", 'atomnano tasks set "Sprint 2" → "opened Set 2 · Sprint 2"; the finished set reads done', o.code === 0 && o.stdout === "opened Set 2 · Sprint 2\n" && M.boardFor("s2").sets[0].status === "done", { o, sets: M.boardFor("s2").sets });
  o = await run(["tasks", "edit", "T3", "--title", "c2", "--role", "tester", ...S2], ENV);
  check("TC13", 'atomnano tasks edit T3 --title "c2" --role tester → PATCH { title, role }', o.code === 0 && o.stdout === "T3  dropped  tester  c2\n", o);
  o = await run(["status", ...S2], ENV);
  check("TC14", "atomnano status shows the board line: done/total + the active set", o.code === 0 && /\ntasks     1\/3 done · Set 2 "Sprint 2"   \(atomnano tasks\)\n/.test(o.stdout), o.stdout);
  o = await run(["tasks", "--session", "s1"], ENV);
  const oAll = await run(["tasks", "--all", "--session", "s1"], ENV);
  check("TC15", "default board hides older finished sets with a hint; --all prints every set with its rows", o.code === 0 && /^Set 5 · S5 · 0\/1 done · active\n  T7  todo  -  Fifth\nSet 4 · S4 · 0\/1 done · closed\nSet 3 · S3 · 0\/1 done · closed\n\(2 older sets with 4 tasks hidden — atomnano tasks --all\)\n$/.test(o.stdout) && oAll.code === 0 && /Set 1 · Payments · 1\/3 done · closed\n  T1  done  coder\s+Wire the webhook\n  T2  todo  -\s+Add retries\n  T3  todo  reviewer  Review the schema\n$/.test(oAll.stdout) && !/hidden/.test(oAll.stdout), { def: o.stdout, all: oAll.stdout });
  o = await run(["tasks", "frob", ...S2], ENV);
  const o4 = await run(["tasks", "done", ...S2], ENV);
  const o5 = await run(["tasks", "show", "T99", ...S2], ENV);
  const o6 = await run(["tasks", "add", ...S2], ENV);
  check("TC16", "usage errors → exit 1: unknown sub-command, a status verb without a ref, an unknown ref (server 404), add without titles", o.code === 1 && /Unknown tasks command "frob"/.test(o.stderr) && o4.code === 1 && /Usage: atomnano tasks done T12/.test(o4.stderr) && o5.code === 1 && /No task T99/.test(o5.stderr) && o6.code === 1 && /Usage: atomnano tasks add/.test(o6.stderr), { o: o.stderr, o4: o4.stderr, o5: o5.stderr, o6: o6.stderr });
  o = await run(["help"], ENV);
  check("TC17", "help documents the task board commands and --task", /atomnano tasks \[--all\] \[--json\]/.test(o.stdout) && /tasks start\|done\|review\|test\|block\|drop T12/.test(o.stdout) && /--task T12/.test(o.stdout), o.stdout.length);

  /* ---- tasks:* IPC (ipc/tasks.js with the fake store / manager) ---- */
  const tasksIpc = require(path.join(ROOT, "src/main/ipc/tasks.js"));
  const HT = {};
  tasksIpc.register({ handle: (ch, fn) => { HT[ch] = fn; }, store: fakeStore, manager: M });
  check("TI01", "register() installs tasks:get / add / update / new-set / remove", ["get", "add", "update", "new-set", "remove"].every((k) => typeof HT["tasks:" + k] === "function"), Object.keys(HT));
  let ta = await HT["tasks:add"](E, "s2", { titles: ["ui task"] });
  tc = M.taskCalls.at(-1);
  check("TI02", "tasks:add → addTasks(session, req, { by:'user' }) → { set, items, board }; the empty active set takes the tasks", ta.items.length === 1 && ta.items[0].title === "ui task" && ta.set.n === 2 && ta.board.counts.total === 4 && tc[0] === "addTasks" && tc[3] === "user", { ta: { set: ta.set.n, items: ta.items.map((i) => i.n), total: ta.board.counts.total }, call: tc });
  let tu = await HT["tasks:update"](E, "s2", "t4", { status: "doing" });
  tc = M.taskCalls.at(-1);
  check("TI03", "tasks:update(session, 't4', { status }) → updateTask(session, 'T4', …, { by:'user' }) → { item, board }", tu.item.status === "doing" && tu.item.n === 4 && tc[2] === "T4" && tc[4] === "user" && tu.board.counts.open === 1, { item: tu.item.status, call: tc });
  const tg = await HT["tasks:get"](E, "s2");
  const tn = await HT["tasks:new-set"](E, "s2", "Sprint 3");
  const trm = await HT["tasks:remove"](E, "s2", "T4");
  const tgc = await HT["tasks:get"](E, "c1");
  check("TI04", "tasks:get → { board }; tasks:new-set → { set }; tasks:remove → { ok, board }; a child id → its planner's board", tg.board.counts.total === 4 && tg.sessionId === "s2" && tn.set.n === 3 && tn.set.title === "Sprint 3" && trm.ok === true && trm.board.items.length === 3 && tgc.sessionId === "s1" && tgc.board.counts.total === M.boardFor("s1").counts.total, { tg: tg.board.counts, tn: tn.set, trm: trm.board.items.length, tgc: tgc.sessionId });
  let e1 = null, e2 = null, e3 = null;
  try { await HT["tasks:update"](E, "s2", "T1", {}); } catch (e) { e1 = e.message; }
  try { await HT["tasks:add"](E, "s2", {}); } catch (e) { e2 = e.message; }
  try { await HT["tasks:get"](E, "nope"); } catch (e) { e3 = e.message; }
  check("TI05", "plain-sentence errors: nothing to update · no title · unknown session", /Nothing to update/.test(e1) && /task title is required/.test(e2) && e3 === "Session not found", { e1, e2, e3 });

  /* ---------------- stop ---------------- */
  server.stop();
  await sleep(20);
  let closed = false; try { await fetch(B + "/v1/ping"); } catch { closed = true; }
  check("S01", "stop() closes the server, removes control.json and the env exports", closed && !fs.existsSync(path.join(HOME, "control.json")) && !process.env.ATOMNANO_CONTROL && !process.env.ATOMNANO_TOKEN && server.info().running === false, { closed, info: server.info() });

  clearTimeout(watchdog);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(`\nworkflow cli: ${pass} passed, ${failN} failed${failN ? "\n  " + failures.join("\n  ") : ""}`);
  process.exit(failN ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
