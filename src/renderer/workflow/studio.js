/* AtomNano renderer — Workflow studio — the overlay shell (Git-Center style, mounted in #modalRoot): the header
 * with the workflow's name (click to rename · "unsaved changes"), the Enabled switch, the Presets and Library
 * menus (new · load · save · save as · rename · duplicate · delete · import · export), the Orchestrator-brief
 * drawer (generated text + override), the CLI popover, Esc / Tab handling, the 1 s clock and the live hook. */
import { closeModal, confirmDialog, copyText, h, modalShell, promptDialog, showContextMenu, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { icon } from "../icons.js";
import { toggle } from "../settings/controls.js";
import { ROLES, S, SKILL_ROLES, activeSessionId, activeWorkflow, api, captureScope, confirmWorkflowOn, setWorkflowEnabled, edit, editFor, errText, hasOwnWorkflow, isDirty, isOpen, libraryEntry, mirrorActive, mirrorLibrary, normalizeWorkflow, projectWorkflow, pullWorkflow, q, rerender, selectRole, sessionWorkflow, useProjectWorkflow } from "./model.js";
import { PRESETS, presetPatch } from "./presets.js";
import { applyLive, buildCanvas, fitView, renderCanvas } from "./canvas.js";
import { buildInspector, codeLines, renderInspector, renderInspectorJobs } from "./inspector.js";
import { fmtSpan, stageSummary } from "./live.js";
import { runInTerminal } from "../workspace/terminal.js";

/* The commands the CLI popover lists — the same shapes the generated Orchestrator brief teaches (2026-09-18):
 * `--from <jobId>` hands a role another job's result (the Planner's plan → the Coder, the Reviewer's findings →
 * the Coder) without pasting it; `--wait --timeout 540` keeps every shell call under the 600 s tool limit and
 * `atomnano wait <id> --timeout 540` picks a still-running job up again. */
export const WAIT = "--wait --timeout 540";
export const CLI_COMMANDS = [
  "atomnano status",
  "atomnano roles",
  `atomnano run <role> "<task>" [--from <jobId>] [--files a,b] [--agents N] [${WAIT}] [--session ID] [--json]`,
  `atomnano run planner "<request>" ${WAIT}`,
  `atomnano run coder "<task>" --from <plannerJobId> ${WAIT}`,
  `atomnano run reviewer "<what to review>" ${WAIT}`,
  `atomnano run coder "<fix-ups>" --from <reviewerJobId> ${WAIT}`,
  `atomnano test ["<task>"] [--cmd "npm test"] ${WAIT}`,
  "atomnano jobs [--session ID] [--json]",
  "atomnano job <id> | wait <id> --timeout 540 | result <id> | log <id> [--tail n] | stop <id>",
  "atomnano sessions | providers | models [-P provider]",
  "atomnano help | version",
];

/* ============================ open / close ============================ */
export async function openWorkflowStudio({ role } = {}) {
  if (isOpen()) { if (role && ROLES[role]) selectRole(role); return; }
  const gen = ++S.gen;
  S.opener = document.activeElement; S.selected = role && ROLES[role] ? role : null;
  S.drawer = null; S.pop = null; S.view = null; S.brief = null; S.sid = activeSessionId();
  S.back = h("div", { class: "wf-overlay", onmousedown: (e) => { if (e.target === S.back) closeWorkflowStudio(); } });
  S.header = h("div", { class: "wf-head" });
  S.drawerEl = h("div", { class: "wf-drawer hidden", role: "region", "aria-label": "Orchestrator brief" });
  const panel = h("div", { class: "wf-panel", tabindex: "-1", role: "dialog", "aria-modal": "true", "aria-label": "Workflow studio" },
    S.header,
    h("div", { class: "wf-body" }, buildCanvas(), h("div", { class: "wf-side" }, buildInspector(), S.drawerEl)));
  S.panel = panel; S.back.append(panel);
  document.getElementById("modalRoot").append(S.back);
  S.rerender = (p) => { if (p.header !== false) renderHeader(); if (p.canvas !== false) renderCanvas(); if (p.inspector !== false) renderInspector(); if (S.drawer) renderDrawer(); };
  S.onLive = () => { applyLive(); renderInspectorJobs(); renderHeaderStatus(); };
  S.openDrawer = (kind) => openDrawer(kind);
  bindKeys();
  renderHeader(); renderCanvas(); renderInspector();
  S.timer = setInterval(tick1s, 1000);
  setTimeout(() => { try { if (isOpen()) panel.focus({ preventScroll: true }); } catch { /* */ } }, 0);
  try { await pullWorkflow(); } catch (e) { console.warn("workflow: get failed", e); }
  if (!isOpen() || gen !== S.gen) return;
  renderHeader(); renderCanvas(); renderInspector();
  seedJobs(gen);
}
export function closeWorkflowStudio() {
  if (!S.back) return;
  S.gen++;
  closePop();
  clearInterval(S.timer); S.timer = 0;
  S.back.remove();
  S.back = null; S.panel = null; S.header = null; S.inspector = null; S.drawerEl = null; S.canvas = null;
  S.rerender = null; S.onLive = null; S.openDrawer = null; S.drawer = null; S.brief = null;
  unbindKeys();
  const op = S.opener; S.opener = null;
  if (op && op.isConnected && typeof op.focus === "function") { try { op.focus({ preventScroll: true }); } catch { /* */ } }
}
export function toggleWorkflowStudio() { if (isOpen()) closeWorkflowStudio(); else openWorkflowStudio(); }
// Jobs the service already knows for the active session (the studio may open mid-run).
export async function seedJobs(gen) {
  const sid = activeSessionId(); if (!sid) return;
  try {
    const r = await api().jobs(sid);
    if (!isOpen() || gen !== S.gen) return;
    for (const j of (r && r.jobs) || []) if (j && j.id) state.workflow.jobs.set(j.id, j);
    applyLive(); renderInspectorJobs(); renderHeaderStatus();
  } catch { /* the service may not be there */ }
}
// Every second: elapsed labels, the planner's own turn, and a switched active tab.
export function tick1s() {
  if (!isOpen()) return;
  const now = Date.now();
  for (const el of S.back.querySelectorAll(".wf-elapsed[data-from]")) el.textContent = (el.dataset.prefix || "") + fmtSpan(now - +el.dataset.from) + (el.dataset.suffix || "");
  const sid = activeSessionId();
  if (sid !== S.sid) {
    // Another tab is active: it has ITS OWN workflow (per-session selection) — redraw the whole design from
    // what the tab already carries, then confirm it with the service.
    S.sid = sid; S.view = null;
    rerender({});
    if (S.drawer === "brief") loadBrief();
    seedJobs(S.gen);
    const gen = S.gen;
    pullWorkflow().then(() => { if (isOpen() && gen === S.gen) rerender({}); }).catch(() => {});
    return;
  }
  applyLive(); renderHeaderStatus();
}

/* ============================ header ============================ */
export function hbtn(id, ic, label, title, onclick, active) { return h("button", { id, class: "wf-hbtn" + (active ? " active" : ""), title, html: icon(ic, 14) + `<span>${label}</span>`, onclick }); }
export function renderHeader() {
  const hd = S.header; if (!hd) return;
  const wf = activeWorkflow(); const entry = libraryEntry(wf); const dirty = isDirty(wf);
  hd.innerHTML = "";
  // On asks first when solo sub-agents are on (they turn off); off keeps the design. A cancel redraws the header (knob back).
  const sw = toggle(!!wf.enabled, async (v) => { const r = await setWorkflowEnabled(v); if (!r) renderHeader(); }, { label: "Workflow enabled" });
  hd.append(
    h("span", { class: "wf-head-ic", html: icon("atom", 18) }),
    h("h3", { class: "wf-h3", text: "Workflow studio" }),
    h("button", { class: "wf-name", id: "wfName", title: "Rename this workflow", onclick: () => renameActive() }, h("span", { class: "wf-name-text", text: wf.name || "Workflow" }), h("span", { class: "wf-name-ic", html: icon("pencil", 12) })),
    h("span", { class: "wf-dirty" + (dirty ? " on" : entry ? " saved" : " adhoc"), id: "wfDirty", text: dirty ? "· unsaved changes" : entry ? "· saved" : "· not in the library" }),
    // Which workflow this tab runs: its own (chosen here) or the project's default. Every tab picks independently.
    h("span", { class: "wf-scope" + (hasOwnWorkflow() ? " own" : ""), id: "wfScope", title: hasOwnWorkflow() ? "This chat tab has its own workflow — other tabs keep theirs. Library ▸ “Use the project default for this tab” lets it go." : "This tab follows the project's default workflow. Any edit, load or clone here gives this tab its own copy; other tabs are not affected.", text: hasOwnWorkflow() ? "this tab" : "project default" }),
    h("span", { class: "wf-enabled" + (wf.enabled ? " on" : ""), title: "When on, your chats run as the Orchestrator: it manages, orchestrates and monitors the roles" }, sw, h("span", { class: "wf-enabled-label", text: wf.enabled ? "Enabled" : "Off", onclick: () => sw.click() })),
    h("span", { class: "wf-live", id: "wfLive" }),
    h("div", { class: "wf-spacer" }),
    hbtn("wfSkills", "sparkle", "Skills", "Attach this project's installed skills to the Planner, Coder and Reviewer — their jobs run with them", () => openSkillsModal()),
    hbtn("wfPresets", "gauge", "Presets", "Start from a preset", (e) => presetsMenu(e.currentTarget)),
    hbtn("wfLibrary", "list", "Library", "Save, load, import and export workflows", (e) => libraryMenu(e.currentTarget)),
    hbtn("wfBrief", "cpu", "Orchestrator brief", "What the Orchestrator is told about its roles and the CLI", () => toggleDrawer("brief"), S.drawer === "brief"),
    hbtn("wfCli", "terminal", "CLI", "How the Orchestrator reaches the roles — the atomnano CLI", (e) => cliPopover(e.currentTarget)),
    h("button", { class: "wf-hbtn icon", title: "Fit the canvas  F", "aria-label": "Fit the canvas", html: icon("maximize", 15), onclick: () => fitView() }),
    h("button", { class: "wf-hbtn icon close", title: "Close  Esc", "aria-label": "Close", html: icon("close", 16), onclick: () => closeWorkflowStudio() }));
  renderHeaderStatus();
}
export function renderHeaderStatus() {
  const el = q("#wfLive"); if (!el) return;
  const s = activeWorkflow().enabled ? stageSummary(activeSessionId()) : "";
  el.innerHTML = "";
  if (s) el.append(h("span", { class: "ag-orbit sm", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("span", { text: s }));
  el.classList.toggle("on", !!s);
}

/* ============================ menus ============================ */
export function menuAt(btn, items) { const r = btn.getBoundingClientRect(); showContextMenu(Math.round(r.left), Math.round(r.bottom + 6), items); }
export function presetsMenu(btn) { menuAt(btn, PRESETS.map((p) => ({ label: p.name, icon: p.icon, onClick: () => applyPreset(p) }))); }
export async function applyPreset(p) {
  if (isDirty() && !(await confirmDialog({ title: "Replace the current design?", message: `"${activeWorkflow().name}" has unsaved changes. The preset "${p.name}" replaces the roles and the layout — the library entry keeps its saved version.`, confirmLabel: "Apply preset" }))) return;
  const patch = presetPatch(p);
  // a preset that turns the workflow ON while solo sub-agents are on: ask, then the sub-agents go off (exclusive, 2026-09-18)
  if (patch.enabled && !activeWorkflow().enabled && !(await confirmWorkflowOn(patch.name))) return;
  if (await edit(patch)) toast(`Preset applied: ${p.name}`, "sparkle");
}
// The library may have changed outside the studio (CLI, another window, an import): pull before showing it.
export function freshLibrary() { return Promise.race([pullWorkflow().catch(() => {}), new Promise((r) => setTimeout(r, 400))]); }
export async function libraryMenu(btn) {
  await freshLibrary();
  if (!isOpen()) return;
  const wf = activeWorkflow(); const entry = libraryEntry(wf); const lib = state.workflow.library || [];
  // Every action here is for THIS chat tab (per-session selection, contract §10): loading, saving as, cloning
  // give this tab its own workflow; other tabs keep theirs. "Use the project default" lets the tab's copy go.
  menuAt(btn, [
    { label: "New from preset…", icon: "plus", onClick: () => presetsMenu(btn) },
    { label: `Load for this tab…${lib.length ? ` (${lib.length})` : ""}`, icon: "folder", onClick: () => loadMenu(btn) },
    { sep: true },
    { label: entry ? `Save "${entry.name}"` : "Save…", icon: "check", onClick: () => saveActive() },
    { label: "Save as…", icon: "edit", onClick: () => saveAs() },
    { label: "Clone for this tab…", icon: "copy", onClick: () => duplicateActive() },
    { label: "Rename…", icon: "pencil", onClick: () => renameActive() },
    { label: "Delete…", icon: "trash", danger: true, onClick: () => deleteActive() },
    ...(hasOwnWorkflow() ? [{ sep: true }, { label: "Use the project default for this tab", icon: "refresh", onClick: () => useProjectWorkflow().then((ok) => { if (ok) toast("This tab follows the project's default workflow again", "check"); }) }] : []),
    { sep: true },
    { label: "Import from file…", icon: "upload", onClick: () => importFile() },
    { label: "Export…", icon: "download", onClick: () => exportActive() },
  ]);
}
export async function loadMenu(btn) {
  await freshLibrary();
  if (!isOpen()) return;
  const lib = state.workflow.library || []; const wf = activeWorkflow();
  menuAt(btn, lib.length
    ? lib.map((e) => ({ label: e.name + (e.id === wf.savedId ? "  ·  current" : ""), icon: e.id === wf.savedId ? "check" : "atom", onClick: () => loadEntry(e) }))
    : [{ label: "The library is empty — Save as… first", icon: "info", onClick: () => saveAs() }]);
}

/* ============================ library actions ============================ */
/* Library actions address the ACTIVE TAB (per-session selection): the loaded / saved / cloned workflow becomes
 * this tab's own; other tabs are untouched; with no tab (sid null) they address the project's active workflow.
 * The scope is CAPTURED before every await (captureScope, model.js — round 3 2026-09-18): the tab's session id,
 * its project (the tab's cwd, else state.project) and the project current at the start. The IPC goes out for that
 * session AND carries the captured project as its trailing cwd (round 4, 2026-09-18): with no tab open main used
 * to resolve the window's project at IPC receipt, so a Save As whose name dialog was still open when the user
 * switched projects saved B's design under the name typed for A and renamed B's workflow — the same for Load,
 * Clone, a saved entry's Rename and Delete; main honours the cwd only without a session id (a tab's project is the
 * session's own). The user's input is never thrown away over a switch: the write goes to the project it was started
 * in, and its reply is mirrored through takeResult(r, scope) onto THAT tab — or, with no tab, onto the project's
 * workflow only while that project is still current — never onto whatever is active when the reply lands: a
 * Save As started on tab A that resolved after the user switched to B used to replace B's renderer workflow with
 * A's (takeResult mirrored onto the active tab at reply time). The visual follow-ups — the re-pull, the repaint,
 * the view reset and the success toasts, which describe "this tab" — run only while the captured tab (or, with no
 * tab, the project) is still the one on screen (inLibraryScope); otherwise they are skipped without a word: the
 * write is persisted for that tab, and the tab shows it when the user returns (tick1s re-pulls on a tab switch).
 * A failure is toasted whatever is on screen — the user needs to know. */
// Still on screen: the captured tab is the active one — or, with no tab captured, no tab is open and the project is the same.
export const inLibraryScope = (scope) => scope.sid === activeSessionId() && (!!scope.sid || state.project === scope.project);
/* Mirror a library reply for the CAPTURED scope. `active` → that tab's own copy (mirrorActive drops it once the
 * tab is gone); with no tab → the project's active workflow, only while that project is still current. `library`
 * → only while the project is still current (state.settings is the project's; the studio re-pulls it on a tab
 * switch and before the Library menu opens — freshLibrary). Resolves to the mirrored workflow, else null. */
export function takeResult(r, scope) {
  if (!r) return null;
  const sameProject = state.project === scope.project;
  if (Array.isArray(r.library) && sameProject) mirrorLibrary(r.library);
  if (!r.active) return null;
  if (scope.sid) return mirrorActive(r.active, scope.sid);
  return sameProject ? mirrorActive(r.active, null) : null;
}
/* The re-pull that follows a load / clone / delete — for the CAPTURED scope: pullWorkflow(scope) validates it
 * inside, before it mirrors anything (round 4, 2026-09-18 — checking here before and after the pull was not enough:
 * the pull had already mirrored A's reply onto the tab or project active by then). Skipped, like the repaint after
 * it, once the scope left the screen (before AND after: it is an await too). */
export async function pullFor(scope) { if (!inLibraryScope(scope)) return false; await pullWorkflow(scope).catch(() => {}); return inLibraryScope(scope); }
export async function loadEntry(e) {
  const scope = captureScope();
  if (isDirty() && !(await confirmDialog({ title: "Discard unsaved changes?", message: `"${activeWorkflow().name}" has unsaved changes. Loading "${e.name}" replaces this tab's design.`, confirmLabel: "Load" }))) return;
  try { takeResult(await api().load(e.id, scope.sid || undefined, scope.cwd), scope); if (!(await pullFor(scope))) return; S.view = null; rerender({}); toast(`Loaded "${e.name}" for this tab`, "check"); }
  catch (err) { toast(errText(err), "alert"); }
}
export async function saveActive() { const wf = activeWorkflow(); const entry = libraryEntry(wf); return entry ? saveAs(entry.name, entry.id) : saveAs(); }
export async function saveAs(name, id) {
  const scope = captureScope(); const wf = activeWorkflow();
  if (!id) {
    name = await promptDialog({ title: "Save workflow as", ic: "atom", message: "Give this workflow a name for the library. This tab will use it.", value: name || (wf.name && wf.name !== "Solo" ? wf.name : ""), placeholder: "e.g. Plan → Code with tests", confirmLabel: "Save" });
    if (name == null) return; name = name.trim(); if (!name) { toast("A name is needed", "alert"); return; }
  }
  try { takeResult(await api().save(name, id || undefined, scope.sid || undefined, scope.cwd), scope); if (!inLibraryScope(scope)) return; rerender({}); toast(id ? `Saved "${name}"` : `Saved as "${name}" — this tab uses it`, "check"); }
  catch (e) { toast(errText(e), "alert"); }
}
export async function renameActive() {
  const scope = captureScope(); const wf = activeWorkflow(); const entry = libraryEntry(wf);
  const name = await promptDialog({ title: "Rename workflow", ic: "pencil", value: wf.name || "", placeholder: "Workflow name", confirmLabel: "Rename" });
  if (name == null) return; const n = name.trim(); if (!n || n === wf.name) return;
  try {
    if (entry) {
      const r = await api().rename(entry.id, n, scope.sid || undefined, scope.cwd);
      // a reply without a body: the CAPTURED tab's workflow takes the name (never the tab active by now); with no tab, the project's — while it is still current
      takeResult(r, scope);
      if (!(r && r.active)) { const base = scope.sid ? sessionWorkflow(scope.sid) : state.project === scope.project ? projectWorkflow() : null; if (base) mirrorActive({ ...base, name: n }, scope.sid); }
      if (!inLibraryScope(scope)) return;
      rerender({});
    }
    else if (!(await editFor(scope.sid, { name: n }, {}, scope.cwd)) || !inLibraryScope(scope)) return;   // editFor repaints only while that tab is on screen
    toast(`Renamed to "${n}"`, "check");
  } catch (e) { toast(errText(e), "alert"); }
}
/* Clone (user request 2026-09-18): ask for a name first, save THIS tab's current design — with any unsaved
 * changes — as a NEW library entry under that name, and make it this tab's workflow. The entry it was cloned
 * from (if any) is left exactly as saved; other tabs are not affected. */
export async function duplicateActive() {
  const scope = captureScope(); const wf = activeWorkflow(); const entry = libraryEntry(wf);
  const base = (wf.name && wf.name !== "Solo" ? wf.name : "Workflow").replace(/\s+copy(\s+\d+)?$/i, "");
  const name = await promptDialog({ title: "Clone workflow for this tab", ic: "copy", message: entry ? `A copy of "${entry.name}"${isDirty(wf) ? " (with this tab's unsaved changes)" : ""} is saved as a new library entry under the name you give, and this tab switches to it. "${entry.name}" itself stays as saved.` : "This tab's design is saved as a new library entry under the name you give, and this tab uses it from now on.", value: `${base} copy`, placeholder: "Name for the clone", confirmLabel: "Save clone" });
  if (name == null) return; const n = name.trim(); if (!n) { toast("A name is needed", "alert"); return; }
  try { const r = await api().save(n, undefined, scope.sid || undefined, scope.cwd); takeResult(r, scope); if (!(await pullFor(scope))) return; rerender({}); toast(`Cloned as "${(r && r.entry && r.entry.name) || n}" — this tab now uses it`, "check"); }
  catch (e) { toast(errText(e), "alert"); }
}
export async function deleteActive() {
  const scope = captureScope();
  const entry = libraryEntry(); if (!entry) { toast("This workflow is not in the library", "info"); return; }
  if (!(await confirmDialog({ title: "Delete from the library?", message: `"${entry.name}" is removed from the library. The design stays on this tab's canvas until you load or reset it.`, danger: true, confirmLabel: "Delete" }))) return;
  try { takeResult(await api().remove(entry.id, scope.sid || undefined, scope.cwd), scope); if (!(await pullFor(scope))) return; rerender({}); toast(`Deleted "${entry.name}"`, "trash"); }
  catch (e) { toast(errText(e), "alert"); }
}
// Import / export are library-only (the library is global): the scope matters for the reply's mirror and the follow-up alone, never for the IPC.
export async function importFile() {
  const scope = captureScope();
  try {
    const r = await api().importFile(); if (!r || r.canceled) return;
    takeResult(r, scope); if (!inLibraryScope(scope)) return;
    rerender({ canvas: false, inspector: false });
    toast(`Imported "${(r.entry && r.entry.name) || "workflow"}" — load it from the library`, "check");
  } catch (e) { toast(errText(e), "alert"); }
}
export async function exportActive() {
  const entry = libraryEntry();
  try { const r = await api().exportOne(entry ? entry.id : null); if (!r || r.canceled) return; toast(r.path ? `Exported to ${r.path}` : "Exported", "download"); }
  catch (e) { toast(errText(e), "alert"); }
}

/* ============================ the brief drawer ============================ */
export function toggleDrawer(kind) { if (S.drawer === kind) closeDrawer(); else openDrawer(kind); }
export function openDrawer(kind) { S.drawer = kind; if (S.drawerEl) S.drawerEl._built = false; renderDrawer(); renderHeader(); if (kind === "brief") loadBrief(); }
export function closeDrawer() { S.drawer = null; renderDrawer(); renderHeader(); }
export async function loadBrief() {
  const sid = activeSessionId(); S.brief = { loading: true }; renderDrawer();
  try { const r = await api().brief(sid); S.brief = { text: (r && r.text) || "", generated: !r || r.generated !== false, loading: false }; }
  catch (e) { S.brief = { loading: false, error: errText(e) }; }
  if (S.drawer === "brief") renderDrawer();
}
export function renderDrawer() {
  const d = S.drawerEl; if (!d) return;
  d.classList.toggle("hidden", !S.drawer);
  if (!S.drawer) { d.innerHTML = ""; d._built = false; return; }
  if (!d._built) { buildDrawer(d); d._built = true; }
  updateDrawer(d);
}
export function buildDrawer(d) {
  d.innerHTML = "";
  const ta = h("textarea", { class: "wf-brief-ta", placeholder: "Leave empty to use the generated brief. Write your own to replace it entirely — keep the CLI usage and the session-id line so the Orchestrator can still delegate.", spellcheck: "false", "aria-label": "Brief override" });
  let t = 0;
  ta.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => commitBrief(ta.value), 700); });
  ta.addEventListener("blur", () => { clearTimeout(t); commitBrief(ta.value); });
  d.append(
    h("div", { class: "wf-drawer-head" }, h("span", { class: "wf-insp-ic", html: icon("cpu", 16) }), h("b", { text: "Orchestrator brief" }), h("span", { class: "wf-spacer" }),
      h("button", { class: "wf-ibtn", title: "Copy the brief", "aria-label": "Copy the brief", html: icon("copy", 13), onclick: () => copyText((S.brief && S.brief.text) || "", "Brief copied") }),
      h("button", { class: "wf-ibtn", title: "Close", "aria-label": "Close the brief", html: icon("close", 14), onclick: () => closeDrawer() })),
    h("p", { class: "wf-drawer-sub", text: "Appended to the Orchestrator's system prompt on every run: who it is (the primary that manages, orchestrates and monitors the roles), the roles table, how to use the atomnano CLI (--from <jobId> hands a job's result on to the next role; --wait --timeout 540, then atomnano wait <id> --timeout 540, keeps every shell call under its 600 s limit) and its own session id. Each worker role gets its own role brief with the procedures of its attached skills — sent to the role's session once and re-sent only when they change." }),
    h("div", { class: "wf-brief-host" }),
    h("div", { class: "wf-sect wf-brief-sect" }),
    ta,
    h("div", { class: "wf-hint wf-brief-hint" }));
}
export function updateDrawer(d) {
  const wf = activeWorkflow(); const b = S.brief || {};
  const host = d.querySelector(".wf-brief-host"); host.innerHTML = "";
  if (b.loading) host.append(h("div", { class: "wf-loading" }, h("span", { html: icon("spinner", 16, "spin") }), h("span", { text: "Generating…" })));
  else if (b.error) host.append(h("div", { class: "wf-note warn" }, h("span", { html: icon("alert", 13) }), h("span", { text: b.error })));
  else host.append(h("pre", { class: "wf-brief-pre" + (wf.brief ? " override" : ""), text: b.text || "(empty)" }));
  const sect = d.querySelector(".wf-brief-sect"); sect.innerHTML = "";
  sect.append(h("span", { text: wf.brief ? "Override — in use" : "Edit override" }), h("span", { class: "wf-spacer" }));
  if (wf.brief) sect.append(h("button", { class: "wf-btn sm", html: icon("refresh", 12) + "<span>Reset to generated</span>", onclick: () => resetBrief() }));
  const ta = d.querySelector(".wf-brief-ta"); if (ta && document.activeElement !== ta && ta.value !== (wf.brief || "")) ta.value = wf.brief || "";
  d.querySelector(".wf-brief-hint").textContent = wf.brief ? "The Orchestrator receives exactly this text instead of the generated brief." : "Empty = the generated brief above is used.";
}
export async function commitBrief(text) {
  const v = String(text || ""); if (v === (activeWorkflow().brief || "")) return;
  if (await edit({ brief: v }, { canvas: false, inspector: false })) loadBrief();
}
export async function resetBrief() { if (await edit({ brief: "" }, { canvas: false, inspector: false })) { toast("Brief reset to the generated text", "check"); loadBrief(); } }

/* ============================ the Skills modal ============================ */
/* The ONLY skills UI (2026-09-18 — the chat-header library and the composer's per-chat popover are gone): this
 * project's skills — install from a URL or through an installer command, write one by hand, remove — and which
 * of them the Planner, Coder and Reviewer run with. One row per skill, one checkbox per role. A ticked skill
 * becomes part of `roles.<role>.skills` on THIS tab's workflow; every job of that role then runs with it (main:
 * startRoleJob → the child's selected skills; the role brief and the procedures reach the role's session once
 * and again only when they change). The Tester gets none.
 * Scope: the session, the project AND that session's workflow are captured when the modal opens
 * (captureSkillsScope), and EVERY write goes to that session's workflow, patched from the retained copy — a tick,
 * a Detach or a Remove whose IPC resolves after the user switched tabs (or closed the modal) still lands on the
 * tab it was started in and never touches the tab active by then (2026-09-18: it used to detach from whichever
 * tab was active when the reply came back), and one that resolves after that tab CLOSED is dropped, never written
 * into the project's workflow (re-review 2026-09-18: the patch used to be computed from tabWorkflow(sid), which
 * falls back to the project once the tab is gone, and the reply mirrored into state.settings.workflow). With NO
 * tab open the writes are the project's, and they carry the captured project too (round 3, 2026-09-18): a Remove
 * whose skills IPC resolved after the user switched projects is written into the project it was started in, and
 * its reply is dropped there — it used to be written into, and mirrored onto, the project current by then. Only the
 * visual follow-up (rows, toast) is dropped once the modal closed; an action STARTED after the tab or project
 * changed — or after the tab closed — is refused with a note to reopen, no IPC. Checkbox writes and removals run
 * one after another, so two quick ticks cannot overwrite each other; loading and errors are shown in the modal,
 * not swallowed. */
export const SKILL_INSTALL_MODES = ["git", "cli"];   // the project setting `skillInstallMode` — URL ("git", the default) or an installer command
export function skillInstallMode() { return state.settings && state.settings.skillInstallMode === "cli" ? "cli" : "git"; }
export async function setSkillInstallMode(mode) {
  const m = mode === "cli" ? "cli" : "git";
  if (state.settings) state.settings.skillInstallMode = m;
  try { await atom.settings.set({ skillInstallMode: m }); } catch (e) { console.warn("workflow: skillInstallMode not saved", e); }
  return m;
}
// Where a skills modal works right now: the active tab's session and the project its skills belong to.
export function skillsScope() {
  const sid = activeSessionId(); const ts = sid && state.tabs.get(sid);
  return { sid, cwd: (ts && ts.meta && ts.meta.cwd) || state.project || "" };
}
/* The scope a modal CAPTURES when it opens: skillsScope() plus `wf`, that session's workflow as the modal RETAINS
 * it (re-review 2026-09-18) — what the rows show and the base of every patch, replaced by what each successful
 * write returns for that session (writeSkills). It is never re-read through tabWorkflow(sid): once the tab is
 * gone that falls back to the project's workflow, and a patch computed from it — a removal whose skills IPC
 * resolved after the tab closed — detached from the wrong workflow. With no tab open the studio edits the
 * project's workflow, so that is what a modal opened then retains; a tab already gone leaves `wf` null and the
 * modal refuses every action (sameScope). */
export function captureSkillsScope() {
  const s = skillsScope();
  return { ...s, wf: s.sid ? sessionWorkflow(s.sid) : projectWorkflow() };
}
// Ids a workflow's roles carry that no installed skill matches (removed, or another project's) — role by role.
export function missingSkillIds(wf, installed) {
  const have = new Set((installed || []).map((s) => s.id)); const out = new Map();
  for (const r of SKILL_ROLES) for (const id of (wf.roles[r] && wf.roles[r].skills) || []) if (!have.has(id)) out.set(id, [...(out.get(id) || []), r]);
  return out;
}
// One patch that drops `id` from every role that carries it (null when no role does).
export function detachPatch(wf, id) {
  const roles = {};
  for (const r of SKILL_ROLES) if (((wf.roles[r] && wf.roles[r].skills) || []).includes(id)) roles[r] = { skills: wf.roles[r].skills.filter((x) => x !== id) };
  return Object.keys(roles).length ? { roles } : null;
}
/* The table's row model (2026-09-18): EVERY record with an id, active ones first, in main's order otherwise.
 * A legacy "suggested" record — learned by the apprentice before it was removed — keeps its id, status and
 * procedure in the store and counts toward main's per-project limit exactly like an active skill (skills.js
 * capacityError). Hiding it left a project full of preserved suggestions looking empty while create and import
 * were refused and nothing could be removed; so it is shown, flagged `legacy`, WITH Remove and the role ticks
 * (it is a real procedure — attaching it is allowed). Its status is never changed here. */
export const LEGACY_SKILL_BADGE = "legacy suggestion";
export const LEGACY_SKILL_TITLE = "Learned by the apprentice before it was removed. It still counts toward this project's skill limit — the one Install and New skill check — so remove it, or tick it for the roles that should run with its procedure.";
export function skillRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((s) => s && s.id).map((s) => ({ skill: s, legacy: s.status === "suggested" })).sort((a, b) => a.legacy - b.legacy);
}
/* The modal's writes, each for the scope CAPTURED when the modal opened (captureSkillsScope, 2026-09-18) — never
 * the active tab, which may have changed while the IPC was in flight. Every patch is computed from `scope.wf`,
 * the retained copy of that session's workflow, and persisted through editFor(scope.sid, …, scope.cwd): the set
 * carries the captured session id AND the captured project (round 3, 2026-09-18 — with no tab open a removal whose
 * skills IPC resolved after a project switch used to be written into the project current by then, main resolving
 * the window's project for a cwd-less set), the reply is mirrored onto that tab only (or dropped once the tab is
 * gone — setWorkflowFor) or, with no tab, onto the project's workflow only while that project is still current,
 * the studio re-renders only while that tab is the one on screen. Each resolves true when the write went through
 * (scope.wf then holds what the tab carries), false when it failed (editFor toasted it). */
export const SKILL_PARTS = { canvas: true, inspector: true, header: false };   // what a skills write repaints: the chips on the canvas and the inspector, not the header
export async function writeSkills(scope, patch, parts = SKILL_PARTS) {
  if (!scope.wf) return false;   // the tab was already gone when the modal opened — nothing to patch from
  const n = await editFor(scope.sid, patch, parts, scope.cwd);
  if (n) scope.wf = n;   // null = dropped (the tab closed while the set was in flight): the copy stays as it was; the modal is stale for good
  return n !== false;
}
// Drop `id` from every role of the captured session's workflow (true when no role carried it — nothing to write).
export async function detachSkillFrom(scope, id, parts = SKILL_PARTS) {
  const patch = scope.wf && detachPatch(scope.wf, id);
  return patch ? writeSkills(scope, patch, parts) : true;
}
// Tick (`want`) or untick one skill for one role of the captured session's workflow.
export async function attachSkillTo(scope, role, id, want, parts = SKILL_PARTS) {
  const cur = (((scope.wf || {}).roles || {})[role] || {}).skills || [];
  return writeSkills(scope, { roles: { [role]: { skills: want ? [...cur.filter((x) => x !== id), id] : cur.filter((x) => x !== id) } } }, parts);
}
// Remove = delete the project skill (`io.remove`, the skills IPC — a failure throws and the workflow is left
// alone), then detach its id from every role of the captured session's workflow in one patch. Other saved
// workflows are untouched: when one of them is loaded its stale id shows up as "Unavailable skill" with its own
// Detach. Resolves to the detach result.
export async function removeSkillFromScope(scope, skill, io = atom.skills) {
  await io.remove(scope.cwd, skill.id);
  return detachSkillFrom(scope, skill.id);
}
export async function openSkillsModal(focusRole) {
  const scope = captureSkillsScope(); const { cwd } = scope;
  const M = { open: true, gen: 0, rows: [], installed: [], loading: false, error: "", queue: Promise.resolve() };   // rows = skillRows(list); installed = their records
  const wfOf = () => scope.wf || normalizeWorkflow(null);   // the RETAINED copy of the captured tab's workflow (never tabWorkflow's fallback); a dead scope draws empty roles
  // Still what was captured: the modal is open, the same tab is active AND still exists, the same project. An
  // action started otherwise is refused (STALE, no IPC); a write already in flight lands on the captured session
  // regardless, or is dropped once its tab is gone (setWorkflowFor).
  const sameScope = () => { const s = skillsScope(); return M.open && !!scope.wf && s.sid === scope.sid && s.cwd === scope.cwd && (!scope.sid || state.tabs.has(scope.sid)); };
  const STALE = "The active tab or project changed — close this dialog and open Skills again.";
  // The guard every action starts with; back in the captured scope (the user returned to the tab) a STALE note left
  // by a refused action is cleared, so the dialog does not keep telling the user to reopen it while it works.
  const inScope = () => { if (!sameScope()) return false; if (M.error === STALE) { M.error = ""; drawStatus(); } return true; };
  // Writes run one after another; a rejected step never blocks the next.
  const serial = (fn) => { const p = M.queue.then(fn, fn); M.queue = p.catch(() => {}); return p; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  /* ---- status (loading / error) ---- */
  const status = h("div", { class: "wf-skills-status hidden", role: "status" });
  const drawStatus = () => {
    status.innerHTML = ""; status.classList.toggle("hidden", !M.loading && !M.error);
    if (M.loading) status.append(h("div", { class: "wf-loading" }, h("span", { html: icon("spinner", 14, "spin") }), h("span", { text: "Loading this project's skills…" })));
    else if (M.error) status.append(h("div", { class: "wf-note warn" }, h("span", { html: icon("alert", 13) }), h("span", { text: M.error })));
  };
  const fail = (msg) => { M.error = msg; drawStatus(); };

  /* ---- the table: installed skills × roles, plus attachments no installed skill matches ---- */
  const table = h("div", { class: "wf-skills-table", role: "table" });
  table.append(h("div", { class: "wf-skills-row head" }, h("span", { class: "wf-skills-name", text: "Skill" }), ...SKILL_ROLES.map((r) => h("span", { class: `wf-skills-col ${r}` + (focusRole === r ? " focus" : ""), text: ROLES[r].name })), h("span", { class: "wf-skills-act", "aria-hidden": "true" })));
  const rowsHost = h("div", { class: "wf-skills-rows" });
  table.append(rowsHost);
  const drawRows = () => {
    rowsHost.innerHTML = "";
    const wf = wfOf();
    const missing = missingSkillIds(wf, M.installed);
    if (!M.rows.length && !missing.size) { rowsHost.append(h("div", { class: "wf-skills-row empty" }, h("span", { class: "wf-hint", text: M.loading ? "" : "No skills are installed for this project yet. Install one from a URL or with an installer command below, or write one by hand — then tick it for the roles that should run with it." }))); return; }
    for (const { skill: s, legacy } of M.rows) {
      // a legacy suggestion: the same row (it counts), marked, its badge next to the name (see skillRows)
      const row = h("div", { class: "wf-skills-row skill" + (legacy ? " legacy" : ""), dataset: { id: s.id } },
        h("span", { class: "wf-skills-name", title: legacy ? LEGACY_SKILL_TITLE : s.description || s.name }, h("b", { text: s.name }), legacy ? h("span", { class: "wf-skills-legacy", text: LEGACY_SKILL_BADGE, title: LEGACY_SKILL_TITLE }) : null, s.description ? h("span", { class: "wf-skills-desc", text: s.description }) : null));
      for (const r of SKILL_ROLES) {
        const has = (wf.roles[r].skills || []).includes(s.id);
        const cb = h("input", { type: "checkbox", class: "aqx-check", "aria-label": `${s.name} for the ${ROLES[r].name}` }); cb.checked = has;
        cb.addEventListener("change", () => {
          const want = cb.checked; cb.disabled = true;
          serial(async () => {
            if (!inScope()) { if (M.open) { cb.checked = !want; cb.disabled = false; fail(STALE); } return; }
            const ok = await attachSkillTo(scope, r, s.id, want);   // the captured tab, whatever is active when this resolves
            if (!M.open) return;   // closed meanwhile — the workflow is right, the checkbox is gone
            if (!ok) cb.checked = !want;
            cb.disabled = false;
          });
        });
        row.append(h("span", { class: `wf-skills-col ${r}` }, cb));
      }
      row.append(h("span", { class: "wf-skills-act" }, h("button", { class: "wf-ibtn danger wf-skills-remove", title: `Remove "${s.name}" from this project`, "aria-label": `Remove ${s.name}`, html: icon("trash", 13), onclick: () => removeSkill(s) })));
      rowsHost.append(row);
    }
    for (const [id, roles] of missing) {
      rowsHost.append(h("div", { class: "wf-skills-row missing", dataset: { id } },
        h("span", { class: "wf-skills-name", title: id }, h("b", { text: "Unavailable skill" }), h("span", { class: "wf-skills-desc", text: `${id} — attached to the ${roles.map((r) => ROLES[r].name).join(", ")} but not installed in this project (removed, or from another project)` })),
        ...SKILL_ROLES.map((r) => h("span", { class: `wf-skills-col ${r}` }, roles.includes(r) ? h("span", { class: "wf-skills-ghost", html: icon("alert", 12), title: "Attached, but the skill is not installed here" }) : null)),
        h("span", { class: "wf-skills-act" }, h("button", { class: "wf-btn sm wf-skills-detach", text: "Detach", title: "Drop this id from every role of this tab's workflow", onclick: () => detach(id) }))));
    }
  };
  const detach = (id) => serial(async () => {
    if (!inScope()) { if (M.open) fail(STALE); return; }
    if (!(await detachSkillFrom(scope, id))) return;
    if (M.open) { drawRows(); toast("Detached", "check"); }
  });
  const reload = async () => {
    const gen = ++M.gen; M.loading = true; M.error = ""; drawStatus();
    let rows = [];
    try { rows = (atom.skills && atom.skills.list ? await atom.skills.list(cwd) : []) || []; }
    catch (e) { if (!M.open || gen !== M.gen) return; M.loading = false; fail(errText(e)); drawRows(); return; }
    if (!M.open || gen !== M.gen) return;   // closed, or a newer list is on its way
    M.rows = skillRows(rows); M.installed = M.rows.map((r) => r.skill); M.loading = false; drawStatus(); drawRows();
  };
  /* Remove: removeSkillFromScope deletes the project skill and detaches it from the CAPTURED tab's workflow
   * (see above) — a reply that lands after a tab switch or after the modal closed still completes for that
   * tab; only the toast and the reload need the modal. */
  const removeSkill = async (s) => {
    const sure = await confirmDialog({ title: "Remove this skill?", danger: true, confirmLabel: "Remove", message: `"${s.name}" is deleted from this project's skills and detached from the Planner, Coder and Reviewer of this tab's workflow. A saved workflow in the library that still names it shows it as unavailable until you detach it there.` });
    if (!sure || !M.open) return;
    await serial(async () => {
      if (!inScope()) { if (M.open) fail(STALE); return; }
      try { await removeSkillFromScope(scope, s); } catch (e) { if (M.open) { fail("Remove failed: " + errText(e)); toast(errText(e), "alert"); } return; }
      if (!M.open) return;
      toast(`Removed "${s.name}"`, "trash");
      await reload();
    });
  };

  /* ---- install: one input, two sources (the remembered project setting `skillInstallMode`) ---- */
  let mode = skillInstallMode();
  const inp = h("input", { class: "wf-input wf-skills-url", type: "text", spellcheck: "false", autocomplete: "off", "aria-label": "Skill source" });
  const go = h("button", { class: "wf-btn primary wf-skills-go", html: icon("download", 12) + "<span>Install</span>" });
  const instHint = h("div", { class: "wf-hint" });
  const instErr = h("div", { class: "wf-skills-err", role: "alert" });
  const modeSeg = h("div", { class: "wf-seg wf-skills-mode", role: "radiogroup", "aria-label": "Install from" });
  const applyMode = () => {
    for (const b of modeSeg.querySelectorAll("button")) { b.classList.toggle("active", b.dataset.mode === mode); b.setAttribute("aria-checked", b.dataset.mode === mode ? "true" : "false"); }
    inp.placeholder = mode === "git" ? "github.com/owner/repo/blob/main/SKILL.md  ·  a JSON skill or list" : "the installer's command, e.g. npx <package> install <skill>";
    go.innerHTML = icon(mode === "git" ? "download" : "terminal", 12) + `<span>${mode === "git" ? "Install" : "Run in terminal"}</span>`;
    instHint.textContent = mode === "git"
      ? "Fetched and written into this project's skills: a SKILL.md (front matter name / description, the body = the steps), a JSON skill or a JSON list of skills. New skills start unticked."
      : "Runs the command in the app's terminal at the project root, so you can answer its prompts; this dialog and the studio close to make room. Only skills a command adds to this project's AtomNano skills appear here — nothing is scanned from other folders. Open Skills again when it has finished.";
    instErr.textContent = "";
  };
  for (const [m, label, ic] of [["git", "From a URL", "globe"], ["cli", "By CLI command", "terminal"]]) modeSeg.append(h("button", { dataset: { mode: m }, role: "radio", html: icon(ic, 12) + `<span>${label}</span>`, onclick: () => { if (mode === m) return; mode = m; applyMode(); setSkillInstallMode(m); inp.focus(); } }));
  const install = async () => {
    const val = inp.value.trim();
    if (!val) { instErr.textContent = mode === "git" ? "Paste the link to a SKILL.md or a JSON skill first." : "Type the installer command first."; inp.focus(); return; }
    if (mode === "cli") {
      // An installer may prompt, take a minute or fail in a way only its own output explains: hand it to the
      // app terminal and get the modal AND the studio out of the way so that output is what the user sees.
      closeModal(back); closeWorkflowStudio();
      try {
        await runInTerminal(val, { cwd, title: "skill install", onExit: (code) => {
          if (code === 0) toast("Installer finished — open Workflow studio ▸ Skills to see this project's skills", "sparkle", { ms: 6000 });
          else toast(`Installer exited with code ${code} — see the terminal`, "alert", { ms: 6000 });
        } });
      } catch (e) { toast(errText(e), "alert"); }
      return;
    }
    instErr.textContent = ""; go.disabled = true; inp.disabled = true;
    try {
      const r = await atom.skills.importUrl(cwd, val);
      if (!M.open) return;
      inp.value = ""; toast(`Installed ${plural(Array.isArray(r) ? r.length : 1, "skill")}`, "sparkle");
      await reload();
    } catch (e) { if (M.open) instErr.textContent = "Install failed: " + errText(e); }   // the link stays in the box
    finally { go.disabled = false; inp.disabled = false; }
  };
  go.addEventListener("click", install);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); install(); } });
  applyMode();

  /* ---- write one by hand ---- */
  const fName = h("input", { class: "wf-input wf-skills-f-name", type: "text", placeholder: "Name — e.g. Review checklist", "aria-label": "Skill name", spellcheck: "false" });
  const fDesc = h("input", { class: "wf-input wf-skills-f-desc", type: "text", placeholder: "One line on when it applies (optional)", "aria-label": "Skill description" });
  const fSteps = h("textarea", { class: "wf-input wf-skills-f-steps", rows: "5", placeholder: "The procedure, one step per line — this is what the role reads.", "aria-label": "Skill steps", spellcheck: "false" });
  const fErr = h("div", { class: "wf-skills-err", role: "alert" });
  const newBtn = h("button", { class: "wf-btn sm wf-skills-new", html: icon("plus", 12) + "<span>New skill…</span>" });
  const form = h("div", { class: "wf-skills-form hidden" }, fName, fDesc, fSteps, fErr);
  const showForm = (on) => { form.classList.toggle("hidden", !on); newBtn.classList.toggle("hidden", on); if (on) setTimeout(() => fName.focus(), 0); };
  const createSkill = async () => {
    const name = fName.value.trim(), steps = fSteps.value.trim();
    if (!name || !steps) { fErr.textContent = !name && !steps ? "A name and the steps are needed." : !name ? "A name is needed." : "The steps are needed — that is what the role runs with."; (name ? fSteps : fName).focus(); return; }
    fErr.textContent = ""; createBtn.disabled = true;
    try {
      await atom.skills.create(cwd, { name, description: fDesc.value.trim(), steps });
      if (!M.open) return;
      fName.value = ""; fDesc.value = ""; fSteps.value = ""; showForm(false);
      toast(`Created "${name}" — tick it for the roles that should run with it`, "sparkle");
      await reload();
    } catch (e) { if (M.open) fErr.textContent = "Create failed: " + errText(e); }   // what was typed stays
    finally { createBtn.disabled = false; }
  };
  const createBtn = h("button", { class: "wf-btn primary wf-skills-create", html: icon("check", 12) + "<span>Create</span>", onclick: createSkill });
  form.append(h("div", { class: "wf-skills-actions" }, createBtn, h("button", { class: "wf-btn wf-skills-cancel", text: "Cancel", onclick: () => { fErr.textContent = ""; showForm(false); } })));
  newBtn.addEventListener("click", () => showForm(true));

  const body = h("div", { class: "wf-skills" },
    h("p", { class: "wf-drawer-sub", text: "Tick a skill for a role and every job of that role runs with it: the role's brief and the attached skills' procedures are sent to the role's session once and re-sent only when they change. Design conventions for the Coder, review checklists for the Reviewer, architecture notes for the Planner. The Tester runs the tests as they are and gets no skills. Skills belong to this project; the ticks belong to this tab's workflow." }),
    status, table,
    h("div", { class: "wf-sect" }, h("span", { text: "Install a skill" })),
    h("div", { class: "wf-skills-install" }, modeSeg, h("div", { class: "wf-skills-install-row" }, inp, go), instHint, instErr),
    h("div", { class: "wf-sect" }, h("span", { text: "Write one by hand" }), h("span", { class: "wf-spacer" }), newBtn),
    form);
  let back = null;
  back = modalShell({ title: "Skills for the roles", ic: "sparkle", wide: true, body, footer: h("button", { class: "btn btn-primary btn-sm", text: "Done", onclick: () => closeModal(back) }) });
  back.addEventListener("modal-closed", () => { M.open = false; M.gen++; });   // ×, backdrop, Esc, Done — every close path
  M.loading = true; drawRows();   // the table frame first (no "nothing installed" flash), then the list
  await reload();
  return back;
}

/* ============================ the CLI popover ============================ */
export async function cliPopover(btn) {
  if (S.pop) { closePop(); return; }
  const pop = h("div", { class: "wf-pop", role: "dialog", "aria-label": "atomnano CLI" });
  const facts = h("div", { class: "wf-facts" }); const sid = activeSessionId();
  pop.append(
    h("div", { class: "wf-pop-head" }, h("span", { class: "wf-insp-ic", html: icon("terminal", 15) }), h("b", { text: "atomnano CLI" }), h("span", { class: "wf-spacer" }), h("button", { class: "wf-ibtn", "aria-label": "Close", html: icon("close", 13), onclick: () => closePop() })),
    h("p", { class: "wf-drawer-sub", text: "The Orchestrator runs these in its Bash tool; they reach this app's local control server. Every child process inherits ATOMNANO_CONTROL, ATOMNANO_TOKEN and the app's bin folder on PATH — a terminal outside the app finds control.json in the user-data folder. --from <jobId> hands a role another job's result (the Planner's plan → the Coder, the Reviewer's findings → the Coder). Shell calls have a 600 s limit: use --wait --timeout 540 and, while a job still runs, atomnano wait <id> --timeout 540. A role's brief and its attached skills' procedures go to the role's session once and are re-sent only when they change." }),
    facts,
    h("div", { class: "wf-sect" }, h("span", { text: "Commands" })),
    codeLines(CLI_COMMANDS));
  document.body.append(pop);
  placePop(pop, btn);
  const off = (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) closePop(); };
  setTimeout(() => document.addEventListener("mousedown", off, true), 0);
  S.pop = { el: pop, off };
  factsInto(facts, S.control, sid);
  try { const c = await api().control(); if (S.pop && S.pop.el === pop) { S.control = c || S.control; factsInto(facts, S.control, sid); } } catch { /* keep what we have */ }
}
export function factsInto(host, c, sid) {
  host.innerHTML = "";
  const rows = [
    ["Control server", c && c.url ? `${c.running === false ? "not running" : "running"} · ${c.url}` : c && c.running === false ? "not running" : "unknown — the service has not reported yet"],
    ["PATH", c && c.binDir ? c.binDir : "the app's bin folder, prepended for every child process"],
    ["Session", sid || "no active tab"],
  ];
  for (const [k, v] of rows) host.append(h("div", { class: "wf-fact" }, h("span", { class: "wf-fact-k", text: k }), h("span", { class: "wf-fact-v mono", text: v, title: v })));
}
export function placePop(pop, anchor) {
  const r = anchor.getBoundingClientRect(); const w = pop.offsetWidth || 460, hh = pop.offsetHeight || 320;
  const left = Math.max(10, Math.min(r.left, window.innerWidth - w - 10));
  let top = r.bottom + 8; if (top + hh > window.innerHeight - 10) top = Math.max(10, r.top - hh - 8);
  pop.style.left = left + "px"; pop.style.top = top + "px";
}
export function closePop() { if (!S.pop) return; document.removeEventListener("mousedown", S.pop.off, true); S.pop.el.remove(); S.pop = null; }

/* ============================ keys ============================ */
export let _keys = null;
export function bindKeys() {
  if (_keys) return;
  _keys = (e) => {
    if (!isOpen()) return;
    if (document.querySelector(".modal-backdrop, #ctxMenu:not(.hidden)")) return;   // a dialog or a menu is on top
    const typing = e.target && /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName);
    if (e.key === "Escape") { e.preventDefault(); if (S.pop) closePop(); else if (typing) e.target.blur(); else if (S.drawer) closeDrawer(); else closeWorkflowStudio(); }
    else if (!typing && (e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); fitView(); }
    else if (e.key === "Tab") {
      const panel = S.panel; if (!panel) return;
      const f = [...panel.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((el) => el.offsetParent !== null || el.closest("foreignObject"));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener("keydown", _keys, true);
}
export function unbindKeys() { if (_keys) { document.removeEventListener("keydown", _keys, true); _keys = null; } }
