/* AtomNano renderer — Workflow studio — the model the shell, the canvas and the inspector share:
 * role metadata, the ACTIVE workflow with the contract's defaults filled in (docs/WORKFLOW_CONTRACT.md §1),
 * every edit going through atom.workflow.set and mirrored into state.settings.workflow / state.workflow.active,
 * the library, dirtiness against the library entry, labels for provider · model · effort · access, the
 * role actions (run / stop / open tab) and the studio's session state S.
 * When the main-process workflow service is not wired yet (window.atomnano.workflow missing) a settings-backed
 * fallback keeps the studio usable: the active workflow and the library live in the same settings keys the
 * service uses (`workflow`, `workflows`); file, job and brief operations report themselves unavailable. */
import { confirmDialog, promptDialog, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";

/* ----------------------------- roles · providers · access ----------------------------- */
// The ORCHESTRATOR is the primary — the model you chat with; it manages, orchestrates and monitors the worker
// roles (2026-09-17: it took every controlling duty over from the Planner, which is now a worker that plans).
export const PRIMARY = "orchestrator";
export const ROLE_ORDER = ["orchestrator", "planner", "coder", "reviewer", "tester"];
export const WORKERS = ["planner", "coder", "reviewer", "tester"];
export const SKILL_ROLES = ["planner", "coder", "reviewer"];   // roles that can carry attached skills (the Tester runs the tests as they are)
export const ROLES = {
  orchestrator: { id: "orchestrator", name: "Orchestrator", icon: "cpu", blurb: "The model you chat with. It manages, orchestrates and monitors every role: it delegates through the atomnano CLI, keeps the task board current and verifies what comes back." },
  planner: { id: "planner", name: "Planner", icon: "brain", blurb: "Drafts the implementation plan the Orchestrator decides on and hands to the Coder — usually read-only." },
  coder: { id: "coder", name: "Coder", icon: "fileCode", blurb: "Implements the work in its own session — and can fan out to sub-agents." },
  reviewer: { id: "reviewer", name: "Reviewer", icon: "shield", blurb: "Reads the changes and reports back — usually read-only." },
  tester: { id: "tester", name: "Tester", icon: "checkCircle", blurb: "Runs the project's tests and reports the outcome." },
};
export const PROVIDERS = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "custom", name: "Custom" },
];
export const ACCESS = [
  { id: "bypassPermissions", name: "Full access", short: "Full", icon: "sparkle", help: "Never asks — runs every tool and edit. The default for every role." },
  { id: "acceptEdits", name: "Accept edits", short: "Edits", icon: "check", help: "Applies file edits without asking; other tools still prompt in the job's tab." },
  { id: "default", name: "Ask", short: "Ask", icon: "shield", help: "Confirms before each tool call — the prompts appear in the job's tab." },
  { id: "read", name: "Read-only", short: "Read", icon: "list", help: "Reads and reports only — no edits, no shell (plan mode on Claude, read-only sandbox on Codex)." },
];
export const AGENTS_MAX = 20;
export const SKILLS_MAX = 50;   // attached skill ids per role — the same cap as main (session/workflow.js normalizeWorkflow)
export const UNAVAILABLE = "The workflow service is not available in this build yet";

/* ----------------------------- the active workflow ----------------------------- */
export function defaultWorkflow() {
  return {
    enabled: false, name: "Solo", savedId: null,
    roles: {
      orchestrator: { provider: "", model: "", effort: "", access: "bypassPermissions" },
      planner: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "read", agents: 0, skills: [] },
      coder: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "bypassPermissions", agents: 3, skills: [] },
      reviewer: { enabled: true, provider: "openai", model: "", effort: "medium", access: "read", agents: 0, skills: [] },
      tester: { enabled: true, provider: "anthropic", model: "", effort: "medium", access: "bypassPermissions", agents: 0, command: "" },
    },
    layout: {}, brief: "", openJobTabs: false,   // jobs run in the background; a tab per job is opt-in (2026-09-17)
  };
}
// A role's usable sub-agent lane: its cap while the role is on — on EVERY provider (Claude: the Task tool;
// Codex: its multi-agent feature). The lane used to count on Anthropic only (2026-09-17).
export function laneOf(role, cfg) { return role !== PRIMARY && cfg && cfg.enabled !== false ? clampAgents(cfg.agents) : 0; }
export function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
/* A workflow saved before the Orchestrator existed (2026-09-17) keeps the primary's picks under `roles.planner`
 * (no `enabled` / `agents`) and its node under `layout.planner`: both move to `orchestrator`, and the Planner
 * takes the new worker defaults. Returns a migrated shallow copy (roles / layout copied). */
export function migrateLegacyPrimary(wf) {
  if (!isObj(wf) || !isObj(wf.roles)) return wf;
  const p = wf.roles.planner;
  if (isObj(wf.roles.orchestrator) || !isObj(p) || p.enabled !== undefined || p.agents !== undefined) return wf;
  const roles = { ...wf.roles, orchestrator: { provider: p.provider || "", model: p.model || "", effort: p.effort || "", access: p.access === undefined ? "bypassPermissions" : p.access } };
  delete roles.planner;
  const out = { ...wf, roles };
  if (isObj(wf.layout) && isObj(wf.layout.planner) && !isObj(wf.layout.orchestrator)) { const layout = { ...wf.layout, orchestrator: wf.layout.planner }; delete layout.planner; out.layout = layout; }
  return out;
}
export function deepMerge(base, patch) {
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch || {})) out[k] = isObj(v) ? deepMerge(isObj(out[k]) ? out[k] : {}, v) : v;
  return out;
}
export function clampAgents(n) { n = Math.round(+n); return Number.isFinite(n) ? Math.max(0, Math.min(AGENTS_MAX, n)) : 0; }
// A role's attached skill ids, the way main normalizes them (session/workflow.js, 2026-09-18): trimmed strings,
// blanks dropped, duplicates collapsed, at most SKILLS_MAX.
export function normalizeSkillIds(v) { return Array.isArray(v) ? [...new Set(v.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()))].slice(0, SKILLS_MAX) : []; }
// Defaults filled for every role; never throws, never returns a shared object.
export function normalizeWorkflow(wf) {
  const d = defaultWorkflow();
  const w = isObj(wf) ? migrateLegacyPrimary(wf) : {};
  const roles = {};
  for (const r of ROLE_ORDER) roles[r] = { ...d.roles[r], ...(isObj(w.roles) && isObj(w.roles[r]) ? w.roles[r] : {}) };
  for (const r of WORKERS) roles[r].agents = clampAgents(roles[r].agents);   // every worker role has its own lane (2026-09-17)
  for (const r of ROLE_ORDER) { if (SKILL_ROLES.includes(r)) roles[r].skills = normalizeSkillIds(roles[r].skills); else delete roles[r].skills; }   // attached skills (ids, 2026-09-18) — the Tester and the Orchestrator carry none, exactly as main
  for (const r of ROLE_ORDER) if (!ACCESS.find((a) => a.id === roles[r].access)) roles[r].access = "bypassPermissions";
  const out = { ...d, ...w, roles, layout: isObj(w.layout) ? w.layout : {}, brief: typeof w.brief === "string" ? w.brief : "", openJobTabs: w.openJobTabs === true, name: w.name || d.name, savedId: w.savedId || null, enabled: !!w.enabled };
  delete out.autoOpenJobs;   // the pre-2026-09-17 key (tabs on by default) is not carried over
  return out;
}
/* PER-SESSION selection (contract §10, 2026-09-18): every tab keeps its OWN workflow (`ts.wfOwn`, mirrored
 * from the session record); a tab that never chose follows the project's active workflow
 * (state.settings.workflow). The studio, the chips and the composer all read the ACTIVE TAB's. */
// The project's active workflow: what a tab without its own copy follows, and what the studio shows with no tab open.
export function projectWorkflow() { return normalizeWorkflow((state.settings && state.settings.workflow) || state.workflow.active); }
/* The workflow a GIVEN session runs with — its own copy, else the project's — or NULL when the session has no tab
 * (closed, or never open here). Re-review 2026-09-18: code that addresses a fixed session (the Skills modal's
 * writes, setWorkflowFor) must read it through this and treat null as "gone: nothing to patch, nothing to
 * mirror" — tabWorkflow(sid) below falls back to the project's workflow for a missing tab, which is right for a
 * display (a job card of a closed session, the studio with no tab) but made a removal that resolved after its tab
 * closed compute its patch from, and mirror its reply onto, the PROJECT's workflow. */
export function sessionWorkflow(sid) {
  const ts = sid && state.tabs.get(sid);
  if (!ts) return null;
  return normalizeWorkflow(isObj(ts.wfOwn) ? ts.wfOwn : (state.settings && state.settings.workflow) || state.workflow.active);
}
export function tabWorkflow(sid) { return sessionWorkflow(sid) || projectWorkflow(); }
export function activeWorkflow() { return tabWorkflow(activeSessionId()); }
export function hasOwnWorkflow(sid = activeSessionId()) { const ts = sid && state.tabs.get(sid); return !!(ts && isObj(ts.wfOwn)); }
export function roleCfg(role) { return activeWorkflow().roles[role]; }
/* Mirror a workflow the service returned. With a session: onto THAT tab's own copy, and only while the tab is
 * still there — a tab closed while the IPC was in flight DROPS the reply (null): the service holds the session's
 * workflow, nothing here shows it any more, and the project's settings must not take it (re-review 2026-09-18: a
 * missing tab used to fall through to state.settings.workflow — a project-scoped write in a closed tab's name,
 * for whatever project was current by then). Without a session: the project's active workflow, as before.
 * state.workflow.active always holds what the active tab shows: it takes the value only for the active tab (or
 * with no tab), never for a reply that belongs to another. */
export function mirrorActive(active, sid = activeSessionId()) {
  if (!isObj(active)) return null;
  const n = normalizeWorkflow(active);
  if (sid) { const ts = state.tabs.get(sid); if (!ts) return null; ts.wfOwn = n; if (sid === activeSessionId()) state.workflow.active = n; }
  else { if (state.settings) state.settings.workflow = n; if (!hasOwnWorkflow()) state.workflow.active = n; }   // the project's: what the active tab shows only while it follows the project (or there is no tab)
  return n;
}
// The tab goes back to the project's active workflow (drops its own copy).
export function clearTabWorkflow(sid = activeSessionId()) {
  const ts = sid && state.tabs.get(sid);
  if (ts) ts.wfOwn = null;
  state.workflow.active = tabWorkflow(sid);
  return state.workflow.active;
}
export function mirrorLibrary(lib) {
  if (Array.isArray(lib)) { state.workflow.library = lib.filter((e) => e && e.id); if (state.settings) state.settings.workflows = state.workflow.library; }
  return state.workflow.library;
}
// The design part of a workflow — what a library entry stores and what "unsaved changes" compares.
export function designOf(wf) { const n = normalizeWorkflow(wf); return { roles: n.roles, layout: n.layout, brief: n.brief, openJobTabs: n.openJobTabs }; }
export function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (isObj(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
export function libraryEntry(wf = activeWorkflow()) { return wf.savedId ? (state.workflow.library || []).find((e) => e.id === wf.savedId) || null : null; }
export function isDirty(wf = activeWorkflow()) { const e = libraryEntry(wf); return !!e && stable(designOf(wf)) !== stable(designOf(e.workflow)); }

/* ----------------------------- the service (atom.workflow) + fallback ----------------------------- */
export function hasService() { const a = atom && atom.workflow; return !!(a && typeof a.set === "function" && typeof a.get === "function"); }
export function api() { return hasService() ? atom.workflow : LOCAL_API; }
export function unavailable() { return Promise.reject(new Error(UNAVAILABLE)); }
export function libraryFromSettings() { const l = state.settings && Array.isArray(state.settings.workflows) ? state.settings.workflows : []; return l.filter((e) => e && e.id); }
export function localId() { return "wf-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
export async function localSave(patch) { try { await atom.settings.set(patch); } catch (e) { console.warn("workflow: settings fallback failed", e); } if (state.settings) Object.assign(state.settings, patch); }
export function localEntry(id) { const e = libraryFromSettings().find((x) => x.id === id); if (!e) throw new Error("That workflow is no longer in the library"); return e; }
// The fallback takes the service's signatures — get(cwd, sid) · set(patch, cwd, sid) · save(name, id, sid, cwd) ·
// load(id, sid, cwd) · remove(id, sid, cwd) · rename(id, name, sid, cwd) — and ignores the trailing scope: it has one
// active workflow, the settings', for whatever the studio shows (no per-session copies, no other project's settings).
export const LOCAL_API = {
  async get(_cwd, _sid) { return { active: activeWorkflow(), library: libraryFromSettings(), control: { url: "", running: false, binDir: "" } }; },
  async set(patch, _cwd, _sid) { const active = normalizeWorkflow(deepMerge(activeWorkflow(), patch || {})); await localSave({ workflow: active }); return { active }; },
  async save(name, id, _sid, _cwd) {
    const lib = libraryFromSettings().map((e) => ({ ...e })); const now = new Date().toISOString(); const wf = activeWorkflow();
    let entry = id ? lib.find((e) => e.id === id) : null;
    if (entry) { entry.name = name || entry.name; entry.updatedAt = now; entry.workflow = designOf(wf); }
    else { entry = { id: localId(), name: name || wf.name || "Workflow", createdAt: now, updatedAt: now, workflow: designOf(wf) }; lib.push(entry); }
    const active = { ...wf, name: entry.name, savedId: entry.id };
    await localSave({ workflows: lib, workflow: active });
    return { library: lib, active };
  },
  async load(id, _sid, _cwd) { const e = localEntry(id); const active = normalizeWorkflow({ ...activeWorkflow(), ...designOf(e.workflow), name: e.name, savedId: e.id }); await localSave({ workflow: active }); return { active }; },
  async remove(id, _sid, _cwd) { const lib = libraryFromSettings().filter((e) => e.id !== id); const wf = activeWorkflow(); const patch = { workflows: lib }; if (wf.savedId === id) patch.workflow = { ...wf, savedId: null }; await localSave(patch); return { library: lib }; },
  async rename(id, name, _sid, _cwd) {
    const lib = libraryFromSettings().map((e) => ({ ...e })); const e = lib.find((x) => x.id === id); if (!e) throw new Error("That workflow is no longer in the library");
    e.name = name; e.updatedAt = new Date().toISOString();
    const wf = activeWorkflow(); const patch = { workflows: lib }; let active = wf;
    if (wf.savedId === id) { active = { ...wf, name }; patch.workflow = active; }
    await localSave(patch); return { library: lib, active };
  },
  async duplicate(id) { const e = localEntry(id); const lib = libraryFromSettings().slice(); const now = new Date().toISOString(); const entry = { id: localId(), name: e.name + " copy", createdAt: now, updatedAt: now, workflow: JSON.parse(JSON.stringify(e.workflow || {})) }; lib.push(entry); await localSave({ workflows: lib }); return { library: lib, entry }; },
  clearSession: unavailable, exportOne: unavailable, importFile: unavailable, run: unavailable, stop: unavailable, stopAll: unavailable, brief: unavailable,
  async jobs() { return { jobs: [] }; },
  async control() { return { url: "", running: false, binDir: "" }; },
};
/* Deep-merge a patch into the workflow of a GIVEN session through the service (the tab gets its own copy on the
 * first edit) and mirror what it returns onto THAT tab — never onto the project. The session is fixed by the
 * caller when its action starts (2026-09-18): a write whose IPC resolves after the user switched tabs still lands
 * on the tab it was made for, and the fallback merge (a reply without a body) reads that tab's workflow, never the
 * one active by then. Re-review 2026-09-18: with a session the reply's `scope` is NOT consulted and a tab that is
 * gone when the reply lands drops it — resolves null, nothing mirrored (mirrorActive), nothing to re-render; the
 * set still went out for that session id, so the service's copy is right. Without a session: the project's active
 * workflow, as before (the studio with no tab open, settings/agent.js) — except that a reply landing after the
 * PROJECT switched is dropped the same way (null): projects.js replaces state.settings on a switch, and the old
 * project's workflow must not be mirrored into the new project's.
 * `cwd` (round 3, 2026-09-18): the PROJECT the write is for, fixed by the caller when its action started — the
 * Skills modal's captured scope.cwd — and carried into the service call: main honours an explicit cwd for the
 * project-scoped set (ipc/workflow.js cwdOf) and would otherwise resolve this window's CURRENT project, so a
 * no-tab removal whose skills IPC resolved after the user switched projects was WRITTEN into the new project (the
 * old guard only dropped the mirror). Without one the project current when this call starts is used — the
 * caller's truth at that moment — never one re-read after the await. The response guard compares state.project
 * AT REPLY TIME against that cwd, nothing captured in here: a caller whose action started in project A and calls
 * this once B is current still writes A, and the reply is dropped because B is not A. With a session main
 * resolves the project from the session itself (its own copy, else workflowFor(session) → session.cwd), so the
 * cwd there is a guard only: a reply is mirrored while the tab still exists AND — when a cwd was given and the tab
 * knows its cwd — the tab's meta.cwd is that project. */
export async function setWorkflowFor(sid, patch, cwd) {
  if (!sid) {
    cwd = cwd || state.project || undefined; const base = projectWorkflow();
    const r = await api().set(patch, cwd, undefined);
    if ((state.project || undefined) !== cwd) return null;   // another project is current now: the reply is the workflow of the project written, not of this one
    return mirrorActive((r && r.active) || deepMerge(base, patch), null);
  }
  const before = sessionWorkflow(sid);   // read BEFORE the IPC: the fallback merge must not see a tab that closed meanwhile as the project
  const r = await api().set(patch, cwd, sid);
  const ts = state.tabs.get(sid);
  if (cwd && ts && ts.meta && ts.meta.cwd && ts.meta.cwd !== cwd) return null;   // the tab named is not the captured project's (a tab gone by now is dropped by mirrorActive)
  return mirrorActive((r && r.active) || (before ? deepMerge(before, patch) : null), sid);
}
// The same for the tab that is active when the call is made.
export async function setWorkflow(patch) { return setWorkflowFor(activeSessionId(), patch); }
/* The SCOPE an operation is for, CAPTURED when it starts (round 3 / 4, 2026-09-18): the active tab's session id
 * (null with no tab), the project it addresses — the tab's cwd, else state.project — and the project current now.
 * Every fetch and every library action carries it: the IPC goes out for that session (or, with no tab, for that
 * project — main honours an explicit cwd), and the reply is judged against it at reply time, never against whatever
 * is active by then. */
export function captureScope() {
  const sid = activeSessionId() || null; const ts = sid && state.tabs.get(sid);
  return { sid, cwd: (ts && ts.meta && ts.meta.cwd) || state.project || "", project: state.project || "" };
}
// The captured project is still the current one (projects.js REPLACES state.settings on a switch — the old project's workflow and library must not land in the new one's).
export const sameProjectAs = (scope) => (state.project || "") === (scope.project || "");
/* A reply for the captured scope may still be applied: with a session, that tab still EXISTS and — when both know
 * their project — is the captured project's (the guards setWorkflowFor uses); with no tab, the project is unchanged.
 * It does not ask whether the tab is still the ACTIVE one: a reply for a tab the user left is mirrored onto that
 * tab's own copy (never onto the one active now — mirrorActive keys on the sid), which the tab shows when the user
 * returns. */
export function scopeHolds(scope) {
  if (scope.sid) { const ts = state.tabs.get(scope.sid); return !!ts && !(scope.cwd && ts.meta && ts.meta.cwd && ts.meta.cwd !== scope.cwd); }
  return sameProjectAs(scope);
}
/* Pull a tab's workflow (its own, or its project's — the reply's `scope` says which), the library and the control
 * facts — for the CAPTURED scope (round 4, 2026-09-18), by default the one captured as the call starts (the active
 * tab, its project). The reply is validated INSIDE, before ANY mutation: the Library actions' follow-up re-pull
 * (studio pullFor) checked the scope before and after the pull, but the pull itself had already mirrored its reply
 * onto whatever was active by then — a Load on tab A whose follow-up get resolved after the user switched to B made
 * B's workflow (and, across a project switch, the new project's settings and library) A's. Now a reply whose scope
 * no longer holds (scopeHolds: the tab is gone or another project's; with no tab, the project changed) is dropped
 * whole — null, nothing written to state.settings.workflow, ts.wfOwn, state.workflow.active or the library. A tab
 * that merely left the screen still takes its own reply (its copy is fresh when the user returns); the library —
 * global in main, but bookkept in the project's state.settings — is mirrored only while the project is unchanged,
 * exactly as the studio's takeResult does; the control facts are global and never stale, so they always land. */
export async function pullWorkflow(scope = captureScope()) {
  const r = await api().get(scope.cwd || undefined, scope.sid || undefined);
  if (!r) return null;
  if (r.control) S.control = { ...(S.control || {}), ...r.control };
  if (!scopeHolds(scope)) return null;
  mirrorPulled(r, scope);
  return r;
}
// Mirror a validated get reply for its captured scope (pullWorkflow — scopeHolds(scope) already said the tab exists / the project is unchanged).
export function mirrorPulled(r, scope) {
  const { sid } = scope; const sameProject = sameProjectAs(scope);
  if (r.active) {
    if (r.scope === "session") mirrorActive(r.active, sid);   // the tab's own copy (and what the studio shows only while that tab is the active one)
    else if (sid) {
      // The tab follows its project's default: drop any own copy it still carried; the project's settings take the
      // default only while that project is current; what the studio shows follows only while the tab is the active one.
      const n = normalizeWorkflow(r.active); const ts = state.tabs.get(sid); if (ts) ts.wfOwn = null;
      if (sameProject && state.settings) state.settings.workflow = n;
      if (sid === activeSessionId()) state.workflow.active = n;
    }
    else mirrorActive(r.active, null);   // no tab: the project's active workflow (the project is unchanged — scopeHolds)
  }
  if (Array.isArray(r.library) && sameProject) mirrorLibrary(r.library);
}
// Drop the active tab's own workflow: it follows the project's active workflow again.
export async function useProjectWorkflow() {
  const sid = activeSessionId();
  if (!sid) { toast("Open a chat tab first", "alert"); return false; }
  try { const r = await api().clearSession(sid); clearTabWorkflow(sid); if (r && r.active) { const n = normalizeWorkflow(r.active); if (state.settings) state.settings.workflow = n; state.workflow.active = n; } }
  catch (e) { toast(errText(e), "alert"); return false; }
  rerender({ canvas: true, inspector: true, header: true });
  return true;
}
export function errText(e) { return (e && (e.message || e.error)) || String(e || "Something went wrong"); }
/* An edit from the UI for a GIVEN session: persist to that tab, then re-render the parts that show it (the shell
 * registers S.rerender) — but ONLY while that tab is still the active one (2026-09-18). The studio always paints
 * the active tab's workflow: a reply that lands after a tab switch must not repaint the new tab from an edit
 * that belongs to the old one (mirrorActive already keeps state.workflow.active for the active tab only).
 * Resolves to the workflow the tab now carries (the mirrored reply — the Skills modal keeps it as its retained
 * copy), null when the reply was dropped because the tab closed meanwhile (nothing to repaint), false when the
 * write failed (toasted here, once). Callers that only need "did it go through" test truthiness.
 * `cwd`: the project the edit was started in (setWorkflowFor above) — the Skills modal passes its captured one. */
export async function editFor(sid, patch, parts = {}, cwd) {
  let n;
  try { n = await setWorkflowFor(sid, patch, cwd); } catch (e) { toast(errText(e), "alert"); return false; }
  if (n && sid === activeSessionId()) rerender({ canvas: true, inspector: true, header: true, ...parts });
  return n;
}
// An edit for the tab that is active when it starts.
export async function edit(patch, parts = {}) { return editFor(activeSessionId(), patch, parts); }
export function rerender(parts) { if (S.rerender) { try { S.rerender(parts || {}); } catch (e) { console.error(e); } } }

/* ----------------------------- the workflow switch vs solo sub-agents ----------------------------- */
/* The workflow and solo sub-agents are EXCLUSIVE (user decision 2026-09-18): in a workflow the roles carry the
 * sub-agent lanes and the Orchestrator never fans out itself (main forces it — session/index.js), so turning the
 * workflow ON turns the composer's solo sub-agents OFF, after asking; turning solo sub-agents ON turns the tab's
 * workflow OFF, after asking (chat/composer.js setSoloAgents). Turning the workflow OFF only flips `enabled` on
 * the tab's own copy: its design, role sessions, board and skills stay, so the chip's switch turns it straight
 * back on. Every enable path goes through here: the studio header switch, the canvas "Turn on", Settings, a
 * preset that enables, the chip's switch. */
let _soloAgentsHook = null;
export function onSoloAgentsChanged(cb) { _soloAgentsHook = typeof cb === "function" ? cb : null; }
// The composer's solo sub-agents setting (shared across tabs), written here so the workflow code needs no composer import.
export function setSoloAgentsSetting(on) {
  if (!state.settings) return;
  state.settings.subAgents = !!on;
  try { const p = atom && atom.settings && atom.settings.set ? atom.settings.set({ subAgents: !!on }) : null; if (p && p.catch) p.catch(() => {}); } catch { /* the setting is in memory either way */ }
  if (_soloAgentsHook) { try { _soloAgentsHook(!!on); } catch (e) { console.error(e); } }
}
export const soloAgentsOn = () => !!(state.settings && state.settings.subAgents);
// Ask before a workflow turns on while solo sub-agents are on; true = go ahead (sub-agents are off now), false = keep everything.
export async function confirmWorkflowOn(wfName) {
  if (!soloAgentsOn()) return true;
  const ok = await confirmDialog({ title: "Turn on the workflow for this tab?", ic: "agents", confirmLabel: "Turn on", message: `Solo sub-agents are on. In a workflow the roles have their own sub-agent lanes and the Orchestrator never fans out itself, so solo sub-agents will be turned off. "${wfName || activeWorkflow().name}" becomes this tab's workflow; your other tabs are not affected.` });
  if (!ok) return false;
  setSoloAgentsSetting(false);
  return true;
}
/* Turn the active tab's workflow on or off. Resolves to the tab's workflow after the change, null when the user
 * cancelled (nothing changed), false when the write failed (toasted by editFor). Off keeps the whole design. */
export async function setWorkflowEnabled(on) {
  const sid = activeSessionId();
  const wf = tabWorkflow(sid);
  if (!!wf.enabled === !!on) return wf;
  if (on && !(await confirmWorkflowOn(wf.name))) return null;
  const r = await editFor(sid, { enabled: !!on });
  if (r && !on && sid) {
    let live = 0; for (const j of state.workflow.jobs.values()) if (j && j.parentId === sid && (j.status === "running" || j.status === "queued")) live++;
    if (live) toast(`Workflow off for this tab — ${live} job${live === 1 ? "" : "s"} keep${live === 1 ? "s" : ""} running (Stop all jobs is in the Workflow studio). Its design is kept; the chip's switch turns it back on.`, "info", { ms: 5000 });
  }
  return r;
}

/* ----------------------------- labels ----------------------------- */
export function providerName(p) { const x = PROVIDERS.find((v) => v.id === p); return x ? x.name : (p || "Composer's pick"); }
export function catalogFor(provider) { const c = state.providerCatalog && state.providerCatalog[provider]; return { models: c && Array.isArray(c.models) ? c.models : [], reasoningLevels: c && Array.isArray(c.reasoningLevels) ? c.reasoningLevels : [], defaultModel: (c && c.defaultModel) || "", label: (c && c.label) || providerName(provider) }; }
// The models a role can pick for a provider. Custom = the configured endpoints (like the composer).
export function modelsFor(provider) {
  const cat = catalogFor(provider);
  if (cat.models.length || provider !== "custom") return cat.models.map((m) => ({ id: m.id, name: m.name || m.id }));
  const s = state.settings || {};
  const eps = Array.isArray(s.customEndpoints) ? s.customEndpoints.filter((e) => e && e.id) : [];
  if (eps.length) return eps.map((e) => ({ id: e.id, name: e.name || e.id }));
  return (Array.isArray(s.customModels) ? s.customModels : []).filter((m) => m && m.id).map((m) => ({ id: m.id, name: m.name || m.id }));
}
export function effortsFor(provider) { return catalogFor(provider).reasoningLevels.map((l) => ({ id: l.id, name: String(l.name || l.id).replace(/^(effort|thinking)\s*:\s*/i, "") })); }
// The provider a role really runs on: "" on the orchestrator = the composer's provider.
export function composerProvider() { return (state.settings && state.settings.llmProvider) || "anthropic"; }
export function effectiveProvider(role, cfg) { return cfg.provider || (role === PRIMARY ? composerProvider() : "anthropic"); }
export function modelName(provider, id) {
  if (!id) { const d = catalogFor(provider).defaultModel; const m = d && modelsFor(provider).find((x) => x.id === d); return m ? m.name : "default"; }
  const m = modelsFor(provider).find((x) => x.id === id); return m ? m.name : id;
}
export function effortName(provider, id) { if (!id) return "default"; const l = effortsFor(provider).find((x) => x.id === id); return l ? l.name : id; }
export function accessOf(id) { return ACCESS.find((a) => a.id === id) || ACCESS[0]; }
export function accessName(id) { return accessOf(id).name; }
// "Anthropic · Opus 5" — or "composer's pick" for an unpinned orchestrator.
export function nodeModelLine(role, cfg) {
  if (role === PRIMARY && !cfg.provider) return cfg.model ? `composer's provider · ${cfg.model}` : "composer's pick";
  const p = effectiveProvider(role, cfg);
  return `${providerName(p)} · ${modelName(p, cfg.model)}`;
}

/* ----------------------------- studio session state ----------------------------- */
export const S = {
  back: null, panel: null, gen: 0, opener: null,
  selected: null,        // role shown in the inspector (null = overview)
  drawer: null,          // "brief" | null — the drawer over the inspector
  pop: null,             // the open popover (CLI info) { el, off }
  view: null,            // canvas viewBox after Fit ({ x, y, w, h }); null = the default frame
  canvas: null,          // built by canvas.js: { root, svg, layers, nodes, edges, lane, particles, orbs, badges, ticker }
  inspector: null, header: null, drawerEl: null,
  rerender: null,        // ({ canvas, inspector, header }) → the shell re-renders those parts
  onLive: null,          // set while open: apply the live job / stage state
  openDrawer: null,      // set while open: (kind) → opens the drawer (the inspector links to the brief)
  timer: 0,              // 1 s tick: elapsed labels + active-session change
  sid: null,             // the session the canvas currently shows
  brief: null,           // { text, generated, loading, error }
  control: null,         // { url, running, binDir }
  jobsSeeded: false,
};
export const isOpen = () => !!(S.back && document.body.contains(S.back));
export const q = (sel) => (S.back ? S.back.querySelector(sel) : null);
export const activeSessionId = () => state.activeTabId || null;
export function selectRole(role) { S.selected = role && ROLES[role] ? role : null; rerender({ canvas: true, inspector: true, header: false }); }

/* ----------------------------- role actions ----------------------------- */
// Ask for a task and start a role job in the active orchestrator session (contract §6 run).
export async function runRole(role, { task } = {}) {
  const sid = activeSessionId();
  if (!sid) { toast("Open a chat tab first — jobs run for the active session", "alert"); return null; }
  const wf = activeWorkflow();
  if (role === PRIMARY) { toast("The Orchestrator is the model you chat with — send it a message", "info"); return null; }
  if (wf.roles[role] && wf.roles[role].enabled === false) { toast(`${ROLES[role].name} is disabled in this workflow`, "alert"); return null; }
  const text = task != null ? task : await promptDialog({ title: `Run the ${ROLES[role].name}`, ic: ROLES[role].icon, message: role === "tester" ? "What should the Tester do? Leave the project's test command to the role's Command setting." : `Describe the task for the ${ROLES[role].name}. It runs in its own tab with this role's model, effort and access.`, placeholder: role === "planner" ? "Plan how to …" : role === "coder" ? "Implement …" : role === "reviewer" ? "Review the changes to …" : "Run the tests and report", confirmLabel: "Run" });
  if (text == null || (!String(text).trim() && role !== "tester")) return null;
  try {
    const r = await api().run(sid, { role, task: String(text).trim() });
    const job = r && r.job;
    if (job && job.id) { state.workflow.jobs.set(job.id, job); if (S.onLive) S.onLive(); }
    toast(`${ROLES[role].name} started`, "check");
    return job || null;
  } catch (e) { toast(errText(e), "alert"); return null; }
}
export async function stopJob(job) {
  if (!job || !job.id) return false;
  try { await api().stop(job.id); toast("Stopping the job…", "check"); return true; } catch (e) { toast(errText(e), "alert"); return false; }
}
// Every live job of the orchestrator — the explicit action; Stop on the orchestrator's turn leaves the roles working.
export async function stopAllJobs(sid) {
  if (!sid) return false;
  try { const r = await api().stopAll(sid); const n = r && r.stopped != null ? r.stopped : 0; toast(n ? `Stopping ${n} job${n === 1 ? "" : "s"}…` : "No running jobs", n ? "stop" : "info"); return true; } catch (e) { toast(errText(e), "alert"); return false; }
}
// Open the child session's tab (history.js is imported lazily: it sits deep in the chat graph).
export async function openJobTab(job) {
  if (!job || !job.sessionId) { toast("This job has no session tab", "info"); return; }
  try { const m = await import("../chat/history.js"); await m.openSessionTab(job.sessionId); } catch (e) { toast(errText(e), "alert"); }
}
