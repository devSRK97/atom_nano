"use strict";
/* IPC: workflow:* — the ACTIVE workflow (per-project, `settings.workflow`), the LIBRARY of saved
 * workflows (`settings.workflows`, global), JSON import/export, role jobs (run / stop / list), the
 * orchestrator brief and the control server's endpoint (docs/WORKFLOW_CONTRACT.md §6). The job methods
 * are the session manager's workflow mixin (§3); the defaults below mirror §1 so this module answers
 * sensibly before the store has them. Test seam: ctx may carry { store, manager, control } fakes —
 * the real singletons are required lazily inside register() otherwise. */
const { dialog } = require("electron");
const fs = require("fs");
const path = require("path");

const PRIMARY = "orchestrator";   // the role the user chats with (the Planner was the primary before 2026-09-17)
const ROLES = ["orchestrator", "planner", "coder", "reviewer", "tester"];
const SKILL_ROLES = ["planner", "coder", "reviewer"];   // roles that carry attached skills (ids) — the Tester does not
const ACCESS = new Set(["bypassPermissions", "acceptEdits", "default", "read"]);
const DEFAULT_WORKFLOW = {
  enabled: false,
  name: "Solo",
  savedId: null,
  roles: {
    orchestrator: { provider: "", model: "", effort: "", access: "bypassPermissions" },
    planner: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "read", agents: 0, skills: [] },
    coder: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "bypassPermissions", agents: 3, skills: [] },
    reviewer: { enabled: true, provider: "openai", model: "", effort: "medium", access: "read", agents: 0, skills: [] },
    tester: { enabled: true, provider: "anthropic", model: "", effort: "medium", access: "bypassPermissions", agents: 0, command: "" },
  },
  layout: {},
  brief: "",
  openJobTabs: false,   // jobs run in the background; tabs open on demand (the pre-2026-09-17 `autoOpenJobs` is dropped on read)
};
const SAVED_KEYS = ["roles", "layout", "brief", "openJobTabs"];

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const str = (v) => (v == null ? "" : String(v));
// Deep merge for plain objects: nested objects merge, everything else (arrays, scalars, null) replaces.
function deepMerge(base, patch) {
  const out = isObj(base) ? { ...base } : {};
  if (!isObj(patch)) return out;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : (isObj(v) ? deepMerge({}, v) : v);
  }
  return out;
}
function clampInt(v, min, max, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }

// The store's defaults (DEFAULT_SETTINGS.workflow via store.workflowDefaults()) when it has them, else the copy above.
function defaultsOf(store) {
  try { if (store && typeof store.workflowDefaults === "function") { const d = store.workflowDefaults(); if (isObj(d) && isObj(d.roles)) return deepMerge(clone(DEFAULT_WORKFLOW), d); } } catch { /* fall through */ }
  return clone(DEFAULT_WORKFLOW);
}
/* A workflow saved before the Orchestrator existed (2026-09-17) carries the primary's picks under
 * `roles.planner` (no `enabled` / `agents`) and its node under `layout.planner`: they move to
 * `orchestrator`, and the Planner takes the new worker defaults. Returns a migrated deep copy. */
function migrateLegacyPrimary(raw) {
  const w = isObj(raw) ? clone(raw) : {};
  const p = isObj(w.roles) && isObj(w.roles.planner) ? w.roles.planner : null;
  if (p && !isObj(w.roles.orchestrator) && p.enabled === undefined && p.agents === undefined) {
    w.roles.orchestrator = { provider: str(p.provider), model: str(p.model), effort: str(p.effort), access: p.access === undefined ? "bypassPermissions" : p.access };
    delete w.roles.planner;
    if (isObj(w.layout) && isObj(w.layout.planner) && !isObj(w.layout.orchestrator)) { w.layout.orchestrator = w.layout.planner; delete w.layout.planner; }
  }
  return w;
}
// Defaults filled, values coerced to the contract's shapes; unknown keys are kept. Never throws.
// The orchestrator's "" provider / model / effort / access mean "follow the composer's picks" and are kept.
function normalizeWorkflow(raw, store) {
  const d = defaultsOf(store);
  const w = deepMerge(d, migrateLegacyPrimary(raw));
  w.enabled = !!w.enabled;
  w.name = str(w.name).trim() || "Custom";
  w.savedId = w.savedId ? String(w.savedId) : null;
  if (!isObj(w.roles)) w.roles = clone(d.roles);
  for (const r of ROLES) {
    const role = (w.roles[r] = { ...d.roles[r], ...(isObj(w.roles[r]) ? w.roles[r] : {}) });
    role.provider = str(role.provider).trim(); role.model = str(role.model).trim(); role.effort = str(role.effort).trim();
    if (!ACCESS.has(role.access) && !(r === PRIMARY && role.access === "")) role.access = d.roles[r].access;
    if (r !== PRIMARY) role.enabled = role.enabled !== false;
    if (r !== PRIMARY) role.agents = clampInt(role.agents, 0, 20, d.roles[r].agents || 0);   // every worker role has its own lane
    if (SKILL_ROLES.includes(r)) role.skills = Array.isArray(role.skills) ? [...new Set(role.skills.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()))].slice(0, 50) : [];   // attached skills (ids)
    else delete role.skills;
    if (r === "tester") role.command = str(role.command);
  }
  w.layout = isObj(w.layout) ? w.layout : {};
  w.brief = str(w.brief);
  // Job tabs are opt-in (2026-09-17, user request: delegation runs in the background through the CLI).
  // The old `autoOpenJobs` (default on) is not carried over — every workflow starts in the background.
  w.openJobTabs = w.openJobTabs === true;
  delete w.autoOpenJobs;
  return w;
}
// The part of a workflow a library entry / export file carries.
function savedPart(wf, store) { const w = normalizeWorkflow(wf, store); const out = {}; for (const k of SAVED_KEYS) out[k] = clone(w[k]); return out; }
function normalizeEntry(e, store) {
  if (!isObj(e) || !e.id) return null;
  const ts = new Date().toISOString();
  return { id: String(e.id), name: str(e.name).trim() || "Workflow", createdAt: e.createdAt || ts, updatedAt: e.updatedAt || e.createdAt || ts, workflow: savedPart(e.workflow, store) };
}
function safeFileName(name) { return (str(name).replace(/[^a-z0-9_\- ]/gi, "").trim().slice(0, 60) || "workflow"); }

// Import file shape: { atomnanoWorkflow: 1, name, workflow: { roles, layout, brief, openJobTabs } }.
// A bare { name?, roles, … } body is accepted too. Throws a plain Error on anything else.
function parseWorkflowFile(text, store) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("That file is not JSON"); }
  if (!isObj(j)) throw new Error("Not an AtomNano workflow file (expected { atomnanoWorkflow: 1, name, workflow })");
  let body = null;
  if (j.atomnanoWorkflow != null) {
    if (Number(j.atomnanoWorkflow) !== 1) throw new Error(`Unsupported workflow file version ${j.atomnanoWorkflow} (this app reads version 1)`);
    body = isObj(j.workflow) ? j.workflow : null;
  } else if (isObj(j.roles)) body = j;
  else if (isObj(j.workflow) && isObj(j.workflow.roles)) body = j.workflow;
  if (!body || !isObj(body.roles)) throw new Error("Not an AtomNano workflow file (expected { atomnanoWorkflow: 1, name, workflow: { roles, … } })");
  return { name: str(j.name).trim() || str(body.name).trim(), workflow: savedPart(body, store) };
}

function register(ctx) {
  const { handle, winFrom, projectOf } = ctx;
  const store = ctx.store || require("../storage/store");
  const manager = ctx.manager || require("../session/index");
  const control = ctx.control || require("../control/server");
  // cwd: explicit (the renderer's state.project) else this window's project — like settings:get/set.
  const cwdOf = (e, cwd) => cwd || (typeof projectOf === "function" ? projectOf(winFrom ? winFrom(e) : null) : undefined) || undefined;

  const norm = (raw) => normalizeWorkflow(raw, store);
  // PER-SESSION selection (contract §10, 2026-09-18): with a sessionId the handlers read and write THAT
  // session's own workflow (`session.workflow`) — each tab picks its workflow independently of the others;
  // a session without one shows the project's active workflow and gets its own copy on the first edit.
  // Without a sessionId they address the project's active workflow, as before.
  const sessionOf = (sid) => { if (!sid) return null; try { return (typeof store.getSession === "function" && store.getSession(String(sid))) || null; } catch { return null; } };
  const ownOf = (sid) => { const s = sessionOf(sid); return s && isObj(s.workflow) ? s.workflow : null; };
  // The workflow a session runs with (its own, else the project's), or a project's active workflow.
  const active = (cwd, sid) => {
    const own = ownOf(sid);
    if (own) return norm(own);
    const s = sessionOf(sid);
    let base = null;
    try { if (typeof manager.workflowFor === "function") base = manager.workflowFor(s || cwd || undefined); } catch { base = null; }
    return norm(base || (store.getSettings((s && s.cwd) || cwd) || {}).workflow);
  };
  // Persist: on the session (its own workflow) when a sessionId is given, else settings.json — which holds
  // the WHOLE `workflow` object (shallow merge on save), so it is always written complete.
  const saveActive = (wf, cwd, sid) => {
    const w = norm(wf);
    if (sid) {
      if (!sessionOf(sid)) throw new Error("Session not found");
      if (typeof manager.setSessionWorkflow === "function") manager.setSessionWorkflow(String(sid), w);
      else if (typeof store.updateSession === "function") store.updateSession(String(sid), { workflow: w });
      else throw new Error("Per-session workflows are not available in this build");
      return w;
    }
    store.saveSettings({ workflow: w }, cwd); return w;
  };
  const scopeOf = (sid) => (ownOf(sid) ? "session" : "project");
  const library = () => { const s = store.getSettings() || {}; return (Array.isArray(s.workflows) ? s.workflows : []).map((e) => normalizeEntry(e, store)).filter(Boolean); };
  const saveLibrary = (list) => { store.saveSettings({ workflows: list }); return list; };   // GLOBAL_ONLY → no cwd
  const entryOr = (list, id) => { const e = list.find((x) => x.id === String(id)); if (!e) throw new Error("That workflow is no longer in the library"); return e; };
  const uniqueName = (list, want) => { let name = want, n = 2; const has = (x) => list.some((e) => e.name.toLowerCase() === x.toLowerCase()); while (has(name)) name = `${want} ${n++}`; return name; };
  const controlInfo = () => { try { const i = control.info(); return { url: i.url || "", running: !!i.running, binDir: i.binDir || "" }; } catch { return { url: "", running: false, binDir: "" }; } };
  const wfForSession = (session) => {
    try { if (typeof manager.workflowFor === "function") { const w = manager.workflowFor(session); if (w) return w; } } catch { /* fall back */ }
    return active(session && session.cwd);
  };

  // ---- active workflow (the session's own with a sessionId, else the project's) ----
  handle("workflow:get", async (e, cwd, sid) => ({ active: active(cwdOf(e, cwd), sid), scope: scopeOf(sid), library: library(), control: controlInfo() }));
  handle("workflow:set", async (e, patch, cwd, sid) => {
    const c = cwdOf(e, cwd);
    return { active: saveActive(deepMerge(active(c, sid), isObj(patch) ? patch : {}), c, sid), scope: sid ? "session" : "project" };
  });
  // Back to the project's active workflow for this session (drops the session's own copy).
  handle("workflow:clear", async (e, sid) => {
    if (!sid || !sessionOf(sid)) throw new Error("Session not found");
    if (typeof manager.setSessionWorkflow === "function") manager.setSessionWorkflow(String(sid), null);
    else if (typeof store.updateSession === "function") store.updateSession(String(sid), { workflow: null });
    return { active: active(cwdOf(e), sid), scope: "project" };
  });

  // ---- library (a sessionId binds the result to that session; without one, to the project) ----
  // The trailing `cwd` (round 4, 2026-09-18) is the project a NO-SESSION call is for — the renderer captures it
  // when the action starts. These handlers used to resolve cwdOf(e), the window's project at IPC receipt: a Save
  // As started with no tab open, whose name dialog was still up when the user switched projects, saved the NEW
  // project's design under the name typed for the old one and renamed the new project's workflow (the same for
  // load / delete / rename). With a session id the cwd is ignored, exactly as set / get behave in effect: active()
  // and saveActive() resolve the project from the session itself.
  const libCwd = (e, sid, cwd) => cwdOf(e, sid ? undefined : cwd);
  handle("workflow:save", async (e, name, id, sid, cwd) => {
    const c = libCwd(e, sid, cwd);
    const cur = active(c, sid);
    const list = library();
    const ts = new Date().toISOString();
    let entry;
    const existing = id ? list.find((x) => x.id === String(id)) : null;
    if (existing) { entry = existing; entry.name = str(name).trim() || entry.name; entry.updatedAt = ts; entry.workflow = savedPart(cur, store); }
    else {
      entry = { id: store.uid(), name: uniqueName(list, str(name).trim() || (cur.savedId ? cur.name : "") || "Workflow"), createdAt: ts, updatedAt: ts, workflow: savedPart(cur, store) };
      list.push(entry);
    }
    saveLibrary(list);
    const next = saveActive({ ...cur, name: entry.name, savedId: entry.id }, c, sid);
    return { library: list, active: next, entry, scope: sid ? "session" : "project" };
  });
  handle("workflow:load", async (e, id, sid, cwd) => {
    const c = libCwd(e, sid, cwd);
    const entry = entryOr(library(), id);
    const cur = active(c, sid);
    return { active: saveActive({ ...cur, ...clone(entry.workflow), enabled: cur.enabled, name: entry.name, savedId: entry.id }, c, sid), scope: sid ? "session" : "project" };
  });
  handle("workflow:delete", async (e, id, sid, cwd) => {
    const c = libCwd(e, sid, cwd);
    const list = library().filter((x) => x.id !== String(id));
    saveLibrary(list);
    let cur = active(c, sid);
    if (cur.savedId === String(id)) cur = saveActive({ ...cur, savedId: null }, c, sid);   // the copy stays; it is unsaved now
    return { library: list, active: cur };
  });
  handle("workflow:rename", async (e, id, name, sid, cwd) => {
    const c = libCwd(e, sid, cwd);
    const list = library();
    const entry = entryOr(list, id);
    entry.name = str(name).trim() || entry.name; entry.updatedAt = new Date().toISOString();
    saveLibrary(list);
    let cur = active(c, sid);
    if (cur.savedId === entry.id && cur.name !== entry.name) cur = saveActive({ ...cur, name: entry.name }, c, sid);
    return { library: list, active: cur };
  });
  // A copy of a library entry under a new name (the studio's Clone saves the CURRENT design instead — workflow:save without an id).
  handle("workflow:duplicate", async (_e, id, name) => {
    const list = library();
    const src = entryOr(list, id);
    const ts = new Date().toISOString();
    const entry = { id: store.uid(), name: uniqueName(list, str(name).trim() || `${src.name} copy`), createdAt: ts, updatedAt: ts, workflow: clone(src.workflow) };
    list.push(entry);
    saveLibrary(list);
    return { library: list, entry };
  });

  // ---- files ----
  handle("workflow:export", async (e, id, filePath) => {
    const c = cwdOf(e);
    let name, workflow;
    if (id) { const entry = entryOr(library(), id); name = entry.name; workflow = clone(entry.workflow); }
    else { const cur = active(c); name = cur.name; workflow = savedPart(cur, store); }
    let target = str(filePath).trim();
    if (!target) {
      const res = await dialog.showSaveDialog(winFrom ? winFrom(e) : undefined, { title: "Export workflow", defaultPath: safeFileName(name) + ".workflow.json", filters: [{ name: "AtomNano workflow", extensions: ["json"] }] });
      if (!res || res.canceled || !res.filePath) return { canceled: true };
      target = res.filePath;
    }
    const data = JSON.stringify({ atomnanoWorkflow: 1, name, exportedAt: new Date().toISOString(), workflow }, null, 2);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return { ok: true, path: target, name };
  });
  handle("workflow:import", async (e, filePath) => {
    let source = str(filePath).trim();
    if (!source) {
      const res = await dialog.showOpenDialog(winFrom ? winFrom(e) : undefined, { title: "Import workflow", properties: ["openFile"], filters: [{ name: "AtomNano workflow", extensions: ["json"] }] });
      if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true };
      source = res.filePaths[0];
    }
    let text;
    try { text = fs.readFileSync(source, "utf8"); } catch { throw new Error("Could not read the file"); }
    const parsed = parseWorkflowFile(text, store);
    const list = library();
    const ts = new Date().toISOString();
    const entry = { id: store.uid(), name: uniqueName(list, parsed.name || path.basename(source).replace(/(\.workflow)?\.json$/i, "") || "Imported workflow"), createdAt: ts, updatedAt: ts, workflow: parsed.workflow };
    list.push(entry);
    saveLibrary(list);
    return { entry, library: list };
  });

  // ---- jobs (the manager's workflow mixin) ----
  handle("workflow:jobs", async (_e, sessionId) => {
    if (sessionId && typeof manager.jobsFor === "function") return { jobs: manager.jobsFor(sessionId) || [] };
    return { jobs: typeof manager.allJobs === "function" ? manager.allJobs() || [] : [] };
  });
  handle("workflow:run", async (_e, sessionId, req) => {
    if (!sessionId) throw new Error("An orchestrator session is required");
    if (typeof manager.startRoleJob !== "function") throw new Error("Workflow jobs are not available in this build");
    const r = isObj(req) ? req : {};
    const start = { role: str(r.role).trim().toLowerCase(), task: str(r.task), files: Array.isArray(r.files) ? r.files.map(str).filter(Boolean) : [], agents: r.agents, from: "ui", taskRef: r.taskRef || undefined, context: !!r.context, fresh: !!r.fresh };
    // fromJob (2026-09-18): the finished job whose saved result travels with the task (the CLI's --from); `from` stays the "ui" provenance
    const fromJob = str(r.fromJob).trim();
    if (fromJob) start.fromJob = fromJob;
    const job = await manager.startRoleJob(sessionId, start);
    return { job };
  });
  handle("workflow:stop", async (_e, jobId) => {
    if (typeof manager.stopJob !== "function") throw new Error("Stopping jobs is not available in this build");
    return manager.stopJob(jobId);
  });
  // Every live job of an orchestrator — the explicit "Stop all jobs" (Stop on the orchestrator's turn leaves them running).
  handle("workflow:stopAll", async (_e, sessionId) => {
    if (!sessionId) throw new Error("An orchestrator session is required");
    if (typeof manager.stopJobsOf !== "function") throw new Error("Stopping jobs is not available in this build");
    return { stopped: manager.stopJobsOf(sessionId) };
  });
  // The orchestrator's brief (manager.orchestratorBrief; plannerBrief is its pre-2026-09-17 name).
  handle("workflow:brief", async (_e, sessionId) => {
    const session = sessionId ? store.getSession(sessionId) : null;
    if (!session) throw new Error("Session not found");
    const wf = wfForSession(session);
    const override = str(wf && wf.brief).trim();
    const briefFn = typeof manager.orchestratorBrief === "function" ? manager.orchestratorBrief : manager.plannerBrief;
    if (typeof briefFn !== "function") return { text: override, generated: false };
    const settings = store.getSettings(session.cwd) || {};
    const provider = (wf.roles && wf.roles[PRIMARY] && wf.roles[PRIMARY].provider) || settings.llmProvider || "anthropic";
    return { text: String(briefFn.call(manager, session, wf, provider) || ""), generated: !override };
  });
  handle("workflow:control", async () => controlInfo());
}

module.exports = { register, DEFAULT_WORKFLOW, PRIMARY, ROLES, SKILL_ROLES, normalizeWorkflow, migrateLegacyPrimary, savedPart, parseWorkflowFile, deepMerge, defaultsOf };
