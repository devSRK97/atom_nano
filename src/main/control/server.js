"use strict";
/* Control server — how the `atomnano` CLI reaches the running app (docs/WORKFLOW_CONTRACT.md §4).
 *
 * Plain Node `http` on 127.0.0.1, a random port and a per-launch bearer token. start() exports
 * ATOMNANO_CONTROL / ATOMNANO_TOKEN / ATOMNANO_NODE to process.env and prepends the app's bin/ folder
 * to PATH — every child process the app spawns afterwards (Claude CLI, Codex, terminals) inherits them,
 * so the Orchestrator's Bash tool can simply run `atomnano …`. <userData>/control.json { url, token, pid,
 * startedAt } serves CLIs launched from an outside terminal; it is removed on stop().
 *
 * Routes live under /v1 (the prefix is optional), answer JSON and never throw: every failure is
 * { error: "plain sentence" } with a 4xx/5xx. POST /jobs carries the CLI's --from as body `from` (a finished
 * job id → the manager's `fromJob`, contract §10). The manager methods used here are the workflow mixin's
 * (contract §3): workflowFor · plannerBrief · startRoleJob · jobInfo · jobsFor · allJobs · waitJob ·
 * stopJob · jobLog · runCommandJob · isRunning — and the task board mixin's (contract §8.1/§8.3):
 * boardFor · addTasks · updateTask · openTaskSet · taskInfo (a build without them answers 501).
 * No Electron import — loads and runs under plain Node (scripts/test-workflow-cli.js drives it with a
 * fake manager + store). */
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const MAX_BODY = 1024 * 1024;           // JSON bodies are tiny; 1 MB is the hard cap
const MAX_WAIT_S = 600;                 // long-poll cap (seconds)
const ROLES = ["planner", "coder", "reviewer", "tester"];   // the roles a job can run as (the orchestrator is the caller)
const ROLE_ALIAS = { planner: "planner", plan: "planner", coder: "coder", code: "coder", reviewer: "reviewer", review: "reviewer", tester: "tester", test: "tester" };
const PRIMARY = "orchestrator";
const DEFAULT_BY = "orchestrator";   // the CLI is the orchestrator's hands
const TERMINAL = new Set(["done", "error", "stopped"]);
// Task board (contract §8): statuses, who a task can be for, and how many finished sets the default view keeps.
const TASK_STATUS = ["todo", "doing", "review", "test", "done", "blocked", "dropped"];
const TASK_STATUS_ALIAS = { start: "doing", started: "doing", block: "blocked", drop: "dropped", finished: "done", complete: "done", completed: "done" };
const TASK_ROLES = ["orchestrator", "planner", "coder", "reviewer", "tester"];
const BOARD_FINISHED_SETS = 2;

let state = null;   // { server, url, port, token, file, binDir, manager, store, version, deps }

// ---------------------------------------------------------------- helpers
function httpError(status, message, extra) { const e = new Error(message); e.status = status; if (extra) e.extra = extra; return e; }

function send(res, status, obj) {
  let body;
  try { body = JSON.stringify(obj == null ? {} : obj); }
  catch (e) { status = 500; body = JSON.stringify({ error: "Reply could not be serialised: " + ((e && e.message) || e) }); }
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
    res.end(body);
  } catch { /* socket already gone */ }
}

function authorized(req, token) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ""));
  if (!m || !token) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Bounded body read. An oversized body is answered 413 while the rest is DRAINED (not destroyed) so
// the reply actually reaches a client still uploading; a runaway stream is cut at 8× the limit.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false;
    const tooBig = () => { done = true; chunks.length = 0; reject(httpError(413, "The request body exceeds 1 MB")); };
    const declared = parseInt(req.headers["content-length"] || "", 10);
    if (Number.isFinite(declared) && declared > MAX_BODY) tooBig();
    req.on("data", (c) => {
      size += c.length;
      if (done) { if (size > 8 * MAX_BODY) { try { req.destroy(); } catch { /* */ } } return; }
      if (size > MAX_BODY) { tooBig(); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    req.on("error", (e) => { if (!done) { done = true; reject(httpError(400, "Could not read the request body: " + ((e && e.message) || e))); } });
  });
}

async function parseJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  let j;
  try { j = JSON.parse(text); } catch { throw httpError(400, "The request body is not valid JSON"); }
  return j && typeof j === "object" && !Array.isArray(j) ? j : {};
}

// Seconds for a wait / timeout parameter: absent → def, true → the cap, numbers and numeric strings clamped to [0, cap].
function seconds(v, def) {
  if (v == null || v === "") return def;
  if (v === true || v === "true") return MAX_WAIT_S;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(MAX_WAIT_S, Math.max(0, n));
}
function intOr(v, def, min, max) {
  if (v == null || v === "") return def;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
function str(v) { return v == null ? "" : String(v); }
function list(v) { if (Array.isArray(v)) return v.map(str).filter(Boolean); if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean); return []; }

function sessionSummary(st, m) {
  if (!m) return null;
  let running = false; try { running = !!st.manager.isRunning(m.id); } catch { /* */ }
  return { id: m.id, name: m.name || "", cwd: m.cwd || "", status: m.status || (running ? "running" : "idle"), role: m.role || null, parentId: m.parentId || null, updatedAt: m.updatedAt || null, running };
}

// The resolved active workflow for a session (or a cwd). Prefers the manager's resolver; without it
// (transitional builds) the settings' `workflow` is normalised by ipc/workflow.js, else a bare shape.
function workflowFor(st, sessionOrCwd) {
  try { if (typeof st.manager.workflowFor === "function") { const w = st.manager.workflowFor(sessionOrCwd); if (w) return w; } } catch { /* fall through */ }
  const cwd = typeof sessionOrCwd === "string" ? sessionOrCwd : (sessionOrCwd && sessionOrCwd.cwd) || undefined;
  let raw = null; try { raw = (st.store.getSettings(cwd) || {}).workflow || null; } catch { /* */ }
  try { return require("../ipc/workflow").normalizeWorkflow(raw); } catch { /* electron-less context */ }
  return { enabled: false, name: "Solo", savedId: null, roles: {}, layout: {}, brief: "", openJobTabs: false, ...(raw || {}) };
}

function metaOf(st, id) {
  if (!id) return null;
  try { const m = st.store.getMeta && st.store.getMeta(id); if (m) return m; } catch { /* */ }
  try { const s = st.store.getSession && st.store.getSession(id); if (s) return s; } catch { /* */ }
  return null;
}

/* Session resolution (contract §4): explicit id (the CLI forwards ATOMNANO_SESSION as `session`) →
 * else the single session that is running as an orchestrator (live turn, enabled workflow, not a child) →
 * else 400 with candidates so the caller can pass --session. */
function resolveSession(st, explicit, { lenient = false } = {}) {
  if (explicit) {
    const m = metaOf(st, explicit);
    if (!m) { if (lenient) return null; throw httpError(404, `No session with id ${explicit}`); }
    return m;
  }
  let metas = [];
  try { metas = st.store.listSessions() || []; } catch { metas = []; }
  const primaries = metas.filter((m) => m && !m.role);
  const live = primaries.filter((m) => { try { return !!st.manager.isRunning(m.id); } catch { return false; } });
  const candidates = live.filter((m) => { try { return !!workflowFor(st, m).enabled; } catch { return false; } });
  if (candidates.length === 1) return candidates[0];
  if (lenient) return null;
  const shown = (candidates.length ? candidates : live.length ? live : primaries.slice(0, 10)).map((m) => sessionSummary(st, m));
  const why = candidates.length > 1 ? `${candidates.length} orchestrator sessions are running — pass --session <id> (or set ATOMNANO_SESSION).`
    : live.length ? "A session is running but its workflow is not enabled — pass --session <id> or enable the workflow."
      : "No orchestrator session is running — pass --session <id> (or set ATOMNANO_SESSION).";
  throw httpError(400, why, { sessions: shown });
}

function jobsOf(st, sessionId) {
  try {
    if (sessionId && typeof st.manager.jobsFor === "function") return st.manager.jobsFor(sessionId) || [];
    if (typeof st.manager.allJobs === "function") return st.manager.allJobs() || [];
  } catch { /* */ }
  return [];
}
function jobOr404(st, id) {
  let job = null;
  try { job = typeof st.manager.jobInfo === "function" ? st.manager.jobInfo(id) : null; } catch { job = null; }
  if (!job) throw httpError(404, `No job with id ${id}`);
  return job;
}
async function waitFor(st, job, secs) {
  if (!job || !secs || TERMINAL.has(job.status)) return job;
  if (typeof st.manager.waitJob !== "function") return job;
  let r;
  try { r = await st.manager.waitJob(job.id, Math.round(secs * 1000)); }   // the manager throws for an unknown id
  catch (e) { throw httpError(404, (e && e.message) || String(e)); }
  return r || job;
}
function need(method, want) { if (method !== want) throw httpError(405, `Use ${want} for this route`); }

/* ---- task board (contract §8.3) ----
 * The board belongs to the ORCHESTRATOR session. A role child calling in with its own ATOMNANO_SESSION is
 * redirected to its parent's board and its role becomes the default `by`; otherwise `by` defaults to
 * "orchestrator" (the CLI is the orchestrator's hands). boardFor(session) reads session.tasks, so the FULL
 * record (store.getSession) is passed, not the meta — the meta carries no tasks. */
function needBoard(st, method) {
  if (typeof st.manager.boardFor !== "function" || (method && typeof st.manager[method] !== "function")) throw httpError(501, "The task board is not available in this build.");
}
function boardSession(st, explicit) {
  let m = resolveSession(st, explicit);
  let by = DEFAULT_BY;
  if (m.role && m.parentId) {
    const parent = metaOf(st, m.parentId);
    if (!parent) throw httpError(400, `Session ${m.id} is a ${m.role} job whose orchestrator session no longer exists — pass --session <orchestrator id>.`);
    by = TASK_ROLES.includes(m.role) ? m.role : DEFAULT_BY; m = parent;
  }
  let full = null; try { full = st.store.getSession ? st.store.getSession(m.id) : null; } catch { full = null; }
  return { meta: m, session: full || m, by };
}
const EMPTY_BOARD = () => ({ seq: 0, setSeq: 0, sets: [], items: [], active: null, counts: { total: 0, open: 0, done: 0 } });
function boardOf(st, session) {
  let b = null;
  try { b = st.manager.boardFor(session); } catch (e) { throw httpError(500, "The task board could not be read: " + ((e && e.message) || e)); }
  if (!b || typeof b !== "object") return EMPTY_BOARD();
  return { ...EMPTY_BOARD(), ...b, sets: Array.isArray(b.sets) ? b.sets : [], items: Array.isArray(b.items) ? b.items : [] };
}
// The default view: the active set plus the last BOARD_FINISHED_SETS finished ones (items of hidden sets
// leave with them; items of no known set stay). `hidden` tells the CLI what --all would add.
function trimBoard(board, all) {
  const { sets, items } = board;
  if (all) return { ...board, hidden: { sets: 0, items: 0 } };
  const keep = new Set();
  if (board.active) keep.add(board.active);
  for (const s of sets) if (s && s.status === "active") keep.add(s.id);
  const finished = sets.filter((s) => s && !keep.has(s.id)).sort((a, b) => (+a.n || 0) - (+b.n || 0));
  for (const s of finished.slice(-BOARD_FINISHED_SETS)) keep.add(s.id);
  const hidden = new Set(sets.filter((s) => s && !keep.has(s.id)).map((s) => s.id));
  const vs = sets.filter((s) => s && !hidden.has(s.id));
  const vi = items.filter((i) => i && !hidden.has(i.setId));
  return { ...board, sets: vs, items: vi, hidden: { sets: sets.length - vs.length, items: items.length - vi.length } };
}
// "T12" · "t12" · "#12" · "12" → "T12"; anything else is taken as an item id.
function taskRef(raw) {
  const s = str(raw).trim();
  if (!s) throw httpError(400, "A task reference is required (T12).");
  const m = /^#?[tT]?(\d+)$/.exec(s);
  return m ? "T" + parseInt(m[1], 10) : s;
}
function taskOr404(st, sessionId, ref) {
  let item = null;
  try { item = typeof st.manager.taskInfo === "function" ? st.manager.taskInfo(sessionId, ref) : null; } catch { item = null; }
  if (!item) throw httpError(404, `No task ${ref} on this session's board.`);
  return item;
}
function setOfItem(board, item) { return item ? board.sets.find((s) => s && s.id === item.setId) || null : null; }
function taskRole(v) {
  const s = str(v).trim().toLowerCase();
  if (!s) return null;
  const r = s === PRIMARY || s === "primary" ? PRIMARY : ROLE_ALIAS[s];
  if (!r) throw httpError(400, `Unknown role "${str(v)}" — one of: ${TASK_ROLES.join(", ")}`);
  return r;
}
function taskStatus(v) {
  const s = str(v).trim().toLowerCase();
  const st = TASK_STATUS_ALIAS[s] || s;
  if (!TASK_STATUS.includes(st)) throw httpError(400, `Unknown status "${str(v)}" — one of: ${TASK_STATUS.join(", ")}`);
  return st;
}
// { titles | items | set } of a POST /tasks body → the manager's addTasks request (only the keys given).
function addTasksRequest(body) {
  const req = {};
  const titles = Array.isArray(body.titles) ? body.titles.map((t) => str(t).trim()).filter(Boolean) : str(body.titles).trim() ? [str(body.titles).trim()] : [];
  const items = (Array.isArray(body.items) ? body.items : []).map((it) => {
    if (typeof it === "string") return { title: it.trim() };
    if (!it || typeof it !== "object") return null;
    const o = { title: str(it.title).trim() };
    if (str(it.detail).trim()) o.detail = str(it.detail);
    const role = taskRole(it.role); if (role) o.role = role;
    return o;
  }).filter((it) => it && it.title);
  if (titles.length) req.titles = titles;
  if (items.length) req.items = items;
  if (!titles.length && !items.length) throw httpError(400, 'At least one task title is required — atomnano tasks add "title" ["title" …] [--set "Set title"].');
  const setTitle = body.set && typeof body.set === "object" ? str(body.set.title).trim() : str(body.set).trim();
  if (setTitle) req.set = { title: setTitle };
  return req;
}
// The optional board task a job is linked to (POST /jobs, POST /tests): `taskRef` (or `ref`), normalised.
function jobTaskRef(body) {
  const raw = body.taskRef != null && str(body.taskRef).trim() ? body.taskRef : body.ref;
  return raw != null && str(raw).trim() ? taskRef(raw) : "";
}

// ---------------------------------------------------------------- routes
async function routeRequest(st, method, p, q, body) {
  if (p === "/" || p === "/ping") { need(method, "GET"); return { ok: true, app: "atomnano", version: st.version, pid: process.pid }; }

  // /status and /roles are lenient: from an outside terminal no planner may be running — the workflow
  // then comes from the caller's project folder (`cwd`, the CLI sends its working directory), else global.
  if (p === "/status") {
    need(method, "GET");
    const m = resolveSession(st, q.session, { lenient: !q.session });
    const wf = workflowFor(st, m || str(q.cwd) || undefined);
    const jobs = m ? jobsOf(st, m.id) : jobsOf(st, null);
    // The board's progress + active set (a build without the board, or a board-less session: null).
    let board = null;
    if (m && typeof st.manager.boardFor === "function") {
      try {
        const b = boardOf(st, boardSession(st, m.id).session);
        const act = b.sets.find((s) => s && (s.id === b.active || s.status === "active")) || null;
        board = { counts: b.counts || EMPTY_BOARD().counts, active: act ? { id: act.id, n: act.n, title: act.title || "" } : null };
      } catch { board = null; }
    }
    return { ok: true, app: "atomnano", version: st.version, pid: process.pid, url: st.url, session: sessionSummary(st, m), workflow: wf, cwd: m ? m.cwd : str(q.cwd) || null, jobs, board };
  }

  if (p === "/roles") {
    need(method, "GET");
    const m = resolveSession(st, q.session, { lenient: !q.session });
    const wf = workflowFor(st, m || str(q.cwd) || undefined);
    return { enabled: !!wf.enabled, name: wf.name || "", savedId: wf.savedId || null, roles: wf.roles || {}, session: m ? m.id : null, cwd: m ? m.cwd : str(q.cwd) || null };
  }

  if (p === "/sessions") {
    need(method, "GET");
    let metas = []; try { metas = st.store.listSessions() || []; } catch { metas = []; }
    return { sessions: metas.map((m) => sessionSummary(st, m)).filter(Boolean) };
  }

  if (p === "/context/search" || p === "/context/read") {
    need(method, "GET");
    const meta = resolveSession(st, q.session);
    const session = st.store.getSession(meta.id);
    if (!session) throw httpError(404, "The source session is unavailable");
    const historyQuery = require("../storage/history-query");
    return p === "/context/search"
      ? historyQuery.search(st.store, session, q.query, { limit: q.limit, before: q.before })
      : historyQuery.read(st.store, session, q.ref, { offset: q.offset, limit: q.limit });
  }

  if (p === "/providers") {
    need(method, "GET");
    const cat = st.deps.catalog() || {};
    let auth = {}; try { auth = st.deps.authStatus() || {}; } catch { auth = {}; }
    let settings = {}; try { settings = st.store.getSettings() || {}; } catch { settings = {}; }
    const providers = [];
    for (const id of Object.keys(cat)) {
      const c = cat[id] || {}; const a = auth[id] || {};
      if (c.primary === "disabled") continue;
      let ok = !!(a.loggedIn || a.key);
      if (id === "custom") ok = !!(a.key || a.baseUrl || (Array.isArray(settings.customEndpoints) && settings.customEndpoints.length));
      providers.push({ id, label: c.label || id, authorized: ok, defaultModel: c.defaultModel || "", current: (settings.llmProvider || "anthropic") === id });
    }
    return { providers, current: settings.llmProvider || "anthropic" };
  }

  if (p === "/models") {
    need(method, "GET");
    const cat = st.deps.catalog() || {};
    let settings = {}; try { settings = st.store.getSettings() || {}; } catch { settings = {}; }
    const provider = str(q.provider) || settings.llmProvider || "anthropic";
    const c = cat[provider];
    if (!c) throw httpError(400, `Unknown provider "${provider}" — one of: ${Object.keys(cat).filter((k) => (cat[k] || {}).primary !== "disabled").join(", ")}`);
    const models = (c.models || []).map((m) => ({ id: m.id, name: m.name || m.id }));
    if (provider === "custom" && Array.isArray(settings.customEndpoints)) for (const ep of settings.customEndpoints) if (ep && ep.id) models.push({ id: ep.id, name: ep.name || ep.id });
    return { provider, defaultModel: c.defaultModel || "", models, reasoningLevels: (c.reasoningLevels || []).map((l) => ({ id: l.id, name: l.name || l.id })) };
  }

  if (p === "/jobs") {
    if (method === "GET") {
      const m = resolveSession(st, q.session, { lenient: true });
      return { jobs: jobsOf(st, m ? m.id : null), session: m ? m.id : null };
    }
    need(method, "POST");
    const wantRole = str(body.role).trim().toLowerCase();
    const role = ROLE_ALIAS[wantRole];
    if (!role) throw httpError(400, wantRole === PRIMARY || wantRole === "primary" ? "The orchestrator is the calling session — delegate to planner, coder, reviewer or tester." : `Unknown role "${str(body.role)}" — one of: ${ROLES.join(", ")}`);
    const task = str(body.task).trim();
    if (!task) throw httpError(400, "A task is required (the text the role should work on).");
    const parent = resolveSession(st, str(body.session));
    if (parent.role) throw httpError(400, `Session ${parent.id} is a ${parent.role} job itself — jobs belong to an orchestrator session.`);
    if (typeof st.manager.startRoleJob !== "function") throw httpError(501, "Workflow jobs are not available in this build.");
    const req = { role, task, files: list(body.files), from: "cli" };
    const agents = intOr(body.agents, undefined, 0, 20);
    if (agents !== undefined) req.agents = agents;
    // --context: the orchestrator's conversation so far travels with the task (condensed by the manager)
    if (body.context === true || /^(1|true|yes)$/i.test(str(body.context))) req.context = true;
    // --fresh: a new session for the role (by default its next task continues in its existing session)
    if (body.fresh === true || /^(1|true|yes)$/i.test(str(body.fresh))) req.fresh = true;
    // --task T12: the board task this job works on (the manager links it — linkJobToTask, contract §8.1).
    const ref = jobTaskRef(body);
    if (ref) { taskOr404(st, parent.id, ref); req.taskRef = ref; }
    // --from <job id> (2026-09-18): body `from` = the finished job of THIS orchestrator whose saved result travels
    // with the task; the manager receives it as `fromJob` (`from` stays the "cli" provenance). A blank id is a
    // 400, an id that is not among the session's jobs a 404 (like a task ref); the manager refuses one that has
    // not ended (400) — nothing is created before either check passes.
    if (body.from !== undefined && body.from !== null) {
      const fromJob = str(body.from).trim();
      if (!fromJob) throw httpError(400, "A job id is required with `from` (--from <job id>): the finished job whose result travels with the task.");
      if (!jobsOf(st, parent.id).some((j) => j && j.id === fromJob)) throw httpError(404, `No job ${fromJob} among session ${parent.id}'s jobs — --from takes the id of a finished job of this orchestrator (atomnano jobs).`);
      req.fromJob = fromJob;
    }
    let job;
    try { job = await st.manager.startRoleJob(parent.id, req); }
    catch (e) { throw httpError(400, (e && e.message) || String(e)); }
    if (!job) throw httpError(500, "The job could not be started.");
    return { job: await waitFor(st, job, seconds(body.wait, 0)) };
  }

  // Every live job of the orchestrator — the explicit stop-all (Stop on the orchestrator's own turn leaves jobs running).
  if (p === "/jobs/stop-all") {
    need(method, "POST");
    const parent = resolveSession(st, str(body.session || q.session));
    if (typeof st.manager.stopJobsOf !== "function") throw httpError(501, "Stopping jobs is not available in this build.");
    return { ok: true, stopped: st.manager.stopJobsOf(parent.id), session: parent.id };
  }

  const jm = /^\/jobs\/([^/]+)(?:\/(wait|log|stop))?$/.exec(p);
  if (jm) {
    const id = decodeURIComponent(jm[1]); const sub = jm[2] || "";
    if (!sub) { need(method, "GET"); return { job: jobOr404(st, id) }; }
    if (sub === "wait") { need(method, "GET"); const job = jobOr404(st, id); return { job: await waitFor(st, job, seconds(q.timeout, MAX_WAIT_S)) }; }
    if (sub === "log") {
      need(method, "GET"); jobOr404(st, id);
      const tail = intOr(q.tail, 40, 1, 5000);
      let text = ""; try { text = typeof st.manager.jobLog === "function" ? (st.manager.jobLog(id, { tail }) || "") : ""; } catch (e) { throw httpError(404, (e && e.message) || String(e)); }
      return { text: String(text), tail };
    }
    if (sub === "stop") {
      need(method, "POST"); jobOr404(st, id);
      if (typeof st.manager.stopJob !== "function") throw httpError(501, "Stopping jobs is not available in this build.");
      const r = await st.manager.stopJob(id);
      const ok = !!(r && r.ok !== false);
      return { ok, detail: (r && r.detail) || "", job: (() => { try { return st.manager.jobInfo(id) || null; } catch { return null; } })() };
    }
  }

  if (p === "/tests") {
    need(method, "POST");
    const parent = resolveSession(st, str(body.session));
    if (parent.role) throw httpError(400, `Session ${parent.id} is a ${parent.role} job itself — jobs belong to an orchestrator session.`);
    let command = str(body.command).trim();
    if (!command) {
      const wf = workflowFor(st, parent);
      command = str(wf && wf.roles && wf.roles.tester && wf.roles.tester.command).trim();
      if (!command) throw httpError(400, "No command given — pass --cmd \"npm test\" or set the tester's command in the workflow.");
    }
    if (typeof st.manager.runCommandJob !== "function") throw httpError(501, "Command jobs are not available in this build.");
    const timeoutMs = intOr(body.timeoutMs, undefined, 1000, 6 * 3600 * 1000);
    const opts = timeoutMs ? { command, timeoutMs } : { command };
    const ref = jobTaskRef(body);
    if (ref) { taskOr404(st, parent.id, ref); opts.taskRef = ref; }
    let job;
    try { job = await st.manager.runCommandJob(parent.id, opts); }
    catch (e) { throw httpError(400, (e && e.message) || String(e)); }
    if (!job) throw httpError(500, "The command job could not be started.");
    return { job: await waitFor(st, job, seconds(body.wait, 0)) };
  }

  /* ---- task board (contract §8.3) ---- */
  if (p === "/tasks") {
    if (method === "GET") {
      needBoard(st);
      const b = boardSession(st, str(q.session));
      const all = q.all === "1" || q.all === "true" || q.all === "all";
      return { board: trimBoard(boardOf(st, b.session), all), all, session: b.meta.id };
    }
    need(method, "POST"); needBoard(st, "addTasks");
    const b = boardSession(st, str(body.session));
    const req = addTasksRequest(body);
    let out;
    try { out = await st.manager.addTasks(b.meta.id, req, { by: str(body.by).trim() || b.by }); }
    catch (e) { throw httpError(400, (e && e.message) || String(e)); }
    return { set: (out && out.set) || null, items: (out && Array.isArray(out.items)) ? out.items : [], session: b.meta.id };
  }

  if (p === "/tasks/sets") {
    need(method, "POST"); needBoard(st, "openTaskSet");
    const b = boardSession(st, str(body.session));
    const title = str(body.title).trim();
    if (!title) throw httpError(400, 'A title for the new set is required — atomnano tasks set "Title".');
    let set;
    try { set = await st.manager.openTaskSet(b.meta.id, title, { by: str(body.by).trim() || b.by }); }
    catch (e) { throw httpError(400, (e && e.message) || String(e)); }
    return { set: set || null, session: b.meta.id };
  }

  const tm = /^\/tasks\/([^/]+)$/.exec(p);
  if (tm) {
    needBoard(st);
    const ref = taskRef(decodeURIComponent(tm[1]));
    if (method === "GET") {
      const b = boardSession(st, str(q.session));
      const item = taskOr404(st, b.meta.id, ref);
      return { item, set: setOfItem(boardOf(st, b.session), item), session: b.meta.id };
    }
    need(method, "PATCH"); needBoard(st, "updateTask");
    const b = boardSession(st, str(body.session));
    taskOr404(st, b.meta.id, ref);
    const patch = {};
    if (str(body.status).trim()) patch.status = taskStatus(body.status);
    if (body.role !== undefined) patch.role = taskRole(body.role);          // "" / null = unassign
    if (body.title !== undefined) { const t = str(body.title).trim(); if (!t) throw httpError(400, "The title cannot be empty."); patch.title = t; }
    if (body.detail !== undefined) patch.detail = str(body.detail);
    if (str(body.note).trim()) patch.note = str(body.note).trim();
    if (!Object.keys(patch).length) throw httpError(400, "Nothing to update — pass status, role, title, detail or note.");
    let item;
    try { item = await st.manager.updateTask(b.meta.id, ref, patch, { by: str(body.by).trim() || b.by }); }
    catch (e) { throw httpError(400, (e && e.message) || String(e)); }
    if (!item) item = taskOr404(st, b.meta.id, ref);
    return { item, set: setOfItem(boardOf(st, b.session), item), session: b.meta.id };
  }

  throw httpError(404, `No route ${method} ${p} — see docs/WORKFLOW_CONTRACT.md §4 and §8.3`);
}

async function dispatch(req, res) {
  const st = state;
  if (!st) { send(res, 503, { error: "The control server is stopping" }); return; }
  let u;
  try { u = new URL(req.url || "/", "http://127.0.0.1"); } catch { send(res, 400, { error: "Bad request URL" }); return; }
  let p = u.pathname.replace(/\/+$/, "") || "/";
  if (p === "/v1") p = "/"; else if (p.startsWith("/v1/")) p = p.slice(3);
  if (!authorized(req, st.token)) { send(res, 401, { error: "Unauthorized — send Authorization: Bearer <token> (the app exports it as ATOMNANO_TOKEN)" }); return; }
  const q = {}; for (const [k, v] of u.searchParams) q[k] = v;
  const method = String(req.method || "GET").toUpperCase();
  try {
    const body = method === "POST" || method === "PUT" || method === "PATCH" ? await parseJson(req) : {};
    const out = await routeRequest(st, method, p, q, body);
    send(res, 200, out);
  } catch (e) {
    const status = e && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 500;
    if (status >= 500 && status !== 501) { try { console.error("[control]", method, p, e); } catch { /* */ } }   // 501 = a feature this build lacks, not a fault
    send(res, status, { error: (e && e.message) || String(e), ...((e && e.extra) || {}) });
  }
}

// ---------------------------------------------------------------- lifecycle
function resolveBinDir(dir) {
  if (!dir) return "";
  try { return fs.existsSync(dir) ? path.resolve(dir) : ""; } catch { return ""; }
}
function writeControlFile(st) {
  const data = JSON.stringify({ url: st.url, token: st.token, pid: process.pid, startedAt: new Date().toISOString(), version: st.version }, null, 2);
  if (st.store && typeof st.store.writeAtomic === "function") st.store.writeAtomic(st.file, data);
  else { fs.mkdirSync(path.dirname(st.file), { recursive: true }); fs.writeFileSync(st.file, data); }
  try { if (process.platform !== "win32") fs.chmodSync(st.file, 0o600); } catch { /* best effort */ }
}
function removeControlFile(file) {
  if (!file) return;
  try {
    if (!fs.existsSync(file)) return;
    let mine = true;
    try { const j = JSON.parse(fs.readFileSync(file, "utf8")); mine = !j.pid || j.pid === process.pid; } catch { mine = true; }
    if (mine) fs.unlinkSync(file);
  } catch { /* best effort */ }
}
function exportEnv(st) {
  process.env.ATOMNANO_CONTROL = st.url;
  process.env.ATOMNANO_TOKEN = st.token;
  process.env.ATOMNANO_NODE = process.execPath;
  if (st.binDir) {
    const cur = process.env.PATH || process.env.Path || "";
    const parts = cur.split(path.delimiter);
    const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (!parts.some((x) => same(x.replace(/[\\/]+$/, ""), st.binDir.replace(/[\\/]+$/, "")))) process.env.PATH = st.binDir + path.delimiter + cur;
  }
}

/* start({ manager, store, version, userData, binDir, catalog?, authStatus? }) → Promise<{ url, token, port }>.
 * Idempotent: a second call while running resolves with the current endpoint. Listening is
 * asynchronous in Node (port 0), hence the promise; info() answers synchronously at any time. */
function start(opts = {}) {
  if (state && state.server) return Promise.resolve({ url: state.url, token: state.token, port: state.port });
  if (!opts.manager) return Promise.reject(new Error("control.start: a session manager is required"));
  const store = opts.store || {};
  let version = opts.version;
  if (!version) { try { version = require("../../../package.json").version; } catch { version = "0"; } }
  const deps = {
    catalog: opts.catalog || (() => require("../providers/catalog").catalog()),
    authStatus: opts.authStatus || (() => require("../auth/cli-auth").providerAuthStatus()),
  };
  const token = crypto.randomBytes(24).toString("hex");
  const server = http.createServer((req, res) => { dispatch(req, res).catch((e) => send(res, 500, { error: (e && e.message) || String(e) })); });
  server.on("clientError", (_e, socket) => { try { socket.end("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"Bad request\"}"); } catch { /* */ } });
  const st = { server, url: "", port: 0, token, file: opts.userData ? path.join(opts.userData, "control.json") : "", binDir: resolveBinDir(opts.binDir), manager: opts.manager, store, version: String(version), deps, listening: false };
  state = st;
  return new Promise((resolve, reject) => {
    const onError = (e) => { if (state === st) state = null; reject(e); };
    server.once("error", onError);
    server.listen(Number(opts.port) || 0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      server.on("error", (e) => console.error("[control] server error:", (e && e.message) || e));
      const addr = server.address();
      st.port = addr && addr.port; st.url = `http://127.0.0.1:${st.port}`; st.listening = true;
      try { exportEnv(st); } catch (e) { console.warn("[control] env export failed:", (e && e.message) || e); }
      if (st.file) { try { writeControlFile(st); } catch (e) { console.warn("[control] control.json not written:", (e && e.message) || e); } }
      resolve({ url: st.url, token: st.token, port: st.port });
    });
  });
}

function stop() {
  const st = state; state = null;
  if (!st) return;
  try { if (typeof st.server.closeAllConnections === "function") st.server.closeAllConnections(); } catch { /* */ }
  try { st.server.close(); } catch { /* */ }
  removeControlFile(st.file);
  if (process.env.ATOMNANO_CONTROL === st.url) delete process.env.ATOMNANO_CONTROL;
  if (process.env.ATOMNANO_TOKEN === st.token) delete process.env.ATOMNANO_TOKEN;
}

// Synchronous picture for the renderer (workflow:control) — the token is deliberately not included.
function info() {
  const st = state;
  return { running: !!(st && st.listening), url: st ? st.url : "", port: st ? st.port : 0, binDir: st ? st.binDir : "", file: st ? st.file : "", pid: process.pid };
}

module.exports = { start, stop, info, MAX_WAIT_S, ROLES, PRIMARY, TASK_STATUS, TASK_ROLES, BOARD_FINISHED_SETS };
