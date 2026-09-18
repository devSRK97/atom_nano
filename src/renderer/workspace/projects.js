/* AtomNano renderer — Projects — one window per project folder, recents, persisted tab / editor state.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { modelDD, permDD, providerDD, thinkDD, updateOneMVisibility } from "../chat/composer.js";
import { addTabState, renderTabs } from "../chat/tabs.js";
import { loadProviderModels } from "../core/catalog.js";
import { $, baseName, closeModal, h, modalShell, samePath, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { applyFontSize, applyTheme, applyWindowTitle, projectKeyOf } from "../core/theme.js";
import { activateEditorFile, editors, isUntitled, openInEditor, renderEditor, updateEditorLayout } from "../editor/editor-pane.js";
import { switchTab } from "../git/conflicts-ui.js";
import { icon } from "../icons.js";
import { openSettings } from "../settings/settings.js";

   // max messages kept in renderer memory per tab — a paginated window, never the whole transcript

export function saveProjectState() {
  if (!state.project) return;
  atom.project.saveTabs(state.project, {
    openTabIds: state.order, activeTabId: state.activeTabId,
    // Untitled buffers have no path to come back from — persisting one would only
    // produce a tab that fails to restore.
    editorOpenFiles: state.editor.open.filter((f) => !f.untitled).map((f) => f.path),
    editorActiveFile: isUntitled(state.editor.active) ? null : state.editor.active,
    editorSplit: state.editor.split, editorSplitDir: state.editor.splitDir,
    editorPanes: state.editor.panes.map((p) => (isUntitled(p) ? null : p)),
  }).catch(() => {});
}
export function persistTabs() {
  saveProjectState();
  if (state.project) { state.settings.lastFolder = state.project; atom.settings.set({ lastFolder: state.project }).catch(() => {}); }
}
export function persistEditor() { saveProjectState(); }
/* ============================================================
   PROJECTS / MULTI-WINDOW
   ============================================================ */
// Persistent recents (most-recent first), shared across windows.
export function pushRecent(p) {
  if (!p) return;
  let arr = (state.settings.recentProjects || []).filter((x) => !samePath(x, p));
  arr.unshift(p);
  arr = arr.slice(0, 15);
  state.settings.recentProjects = arr;
  atom.settings.set({ recentProjects: arr }).catch(() => {});
}
export function removeRecent(p) {
  state.settings.recentProjects = (state.settings.recentProjects || []).filter((x) => !samePath(x, p));
  atom.settings.set({ recentProjects: state.settings.recentProjects }).catch(() => {});
}
export function seedRecentsIfEmpty(sessions) {
  if ((state.settings.recentProjects || []).length) return;
  const seen = new Set(); const arr = [];
  for (const s of (sessions || []).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))) {
    const k = projectKeyOf(s.cwd); if (s.cwd && !seen.has(k)) { seen.add(k); arr.push(s.cwd); }
  }
  if (arr.length) { state.settings.recentProjects = arr.slice(0, 15); atom.settings.set({ recentProjects: state.settings.recentProjects }).catch(() => {}); }
}
export function closeProjectMenu() {
  const m = $("projMenu"); if (m) m.remove();
  document.removeEventListener("mousedown", projMenuOutside, true);
}
export function projMenuOutside(e) {
  const m = $("projMenu"); const bar = document.querySelector(".folder-pick");
  if (m && !m.contains(e.target) && !(bar && bar.contains(e.target))) closeProjectMenu();
}
export function buildRecents(sub) {
  sub.innerHTML = "";
  const recents = (state.settings.recentProjects || []).filter((p) => !samePath(p, state.project));
  if (!recents.length) { sub.append(h("div", { class: "pm-empty", text: "No recent projects" })); return; }
  for (const p of recents) {
    sub.append(h("div", { class: "pm-recent", title: p, onclick: () => { closeProjectMenu(); chooseOpenProject(p); } },
      h("span", { class: "pm-fico", html: icon("folderOpen", 14) }),
      h("span", { class: "pm-rmeta" }, h("span", { class: "pm-rname", text: baseName(p) }), h("span", { class: "pm-rpath", text: p })),
      h("button", { class: "pm-x", title: "Remove from recents", html: icon("close", 12), onclick: (ev) => { ev.stopPropagation(); removeRecent(p); buildRecents(sub); } })));
  }
}
export function openProjectMenu(e) {
  if ($("projMenu")) { closeProjectMenu(); return; }
  const r = e.currentTarget.getBoundingClientRect();
  const menu = h("div", { class: "proj-menu", id: "projMenu" });
  const sub = h("div", { class: "pm-sub" });
  buildRecents(sub);
  menu.append(
    h("div", { class: "pm-item", onclick: () => { closeProjectMenu(); pickAndOpenProject(); } },
      h("span", { class: "pm-ico", html: icon("folderPlus", 15) }), h("span", { class: "pm-label", text: "Open Folder…" })),
    h("div", { class: "pm-item pm-has-sub" },
      h("span", { class: "pm-ico", html: icon("history", 15) }), h("span", { class: "pm-label", text: "Recents" }),
      h("span", { class: "pm-arrow", html: icon("chevron", 13) }), sub),
    h("div", { class: "pm-item", onclick: () => { closeProjectMenu(); openSettings(); } },
      h("span", { class: "pm-ico", html: icon("settings", 15) }), h("span", { class: "pm-label", text: "Settings" })));
  document.body.append(menu);
  const mw = menu.offsetWidth;
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + "px";
  menu.style.top = (r.bottom + 4) + "px";
  setTimeout(() => document.addEventListener("mousedown", projMenuOutside, true), 0);
}
export async function pickAndOpenProject() {
  const picked = await atom.dialog.pickFolder(state.project);
  if (picked) chooseOpenProject(picked);
}
// A fresh "New Window" (from the taskbar): pick a project and open it IN this
// window — unless it's already open elsewhere, then focus that one.
export async function pickProjectForNewWindow() {
  const picked = await atom.dialog.pickFolder(state.project);
  if (!picked || samePath(picked, state.project)) return;
  if (await atom.win.isOpen(picked).catch(() => false)) {
    atom.win.openProject(picked);   // focus the existing window
    toast(`“${baseName(picked)}” is already open — switched to its window`, "folderOpen");
    return;
  }
  pushRecent(picked); switchProjectInPlace(picked);
}
export async function chooseOpenProject(path) {
  if (samePath(path, state.project)) return;
  // If this folder is already open in another window, just focus it — never a duplicate.
  if (await atom.win.isOpen(path).catch(() => false)) {
    pushRecent(path); atom.win.openProject(path);
    toast(`“${baseName(path)}” is already open — switched to its window`, "folderOpen");
    return;
  }
  chooseDialog({
    title: "Open project", ic: "folderOpen",
    message: `Open “${baseName(path)}” in a new window, or switch this window to it?`,
    choices: [
      { label: "New window", value: "new", primary: true },
      { label: "This window", value: "this" },
      { label: "Cancel", value: null },
    ],
  }).then((choice) => {
    if (choice === "new") { pushRecent(path); atom.win.openProject(path); }
    else if (choice === "this") { pushRecent(path); switchProjectInPlace(path); }
  });
}
export async function switchProjectInPlace(path) {
  saveProjectState();
  state.project = path;
  // Tell main this window is now THIS project, then load THIS project's settings
  // (provider/model/theme/… are per-project) and re-apply them.
  await atom.win.setProject(path).catch(() => {});
  try {
    state.settings = await atom.settings.get();
    applyTheme(state.settings.theme || state.settings.accent || "amber");
    applyFontSize(state.settings.fontSize);
    await loadProviderModels(state.settings.llmProvider || "anthropic");
    if (providerDD) providerDD._refresh(); if (modelDD) modelDD._refresh(); if (thinkDD) thinkDD._refresh(); if (permDD) permDD._refresh();
    updateOneMVisibility();
  } catch { /* keep current settings on failure */ }
  state.settings.lastFolder = path;
  applyWindowTitle();
  state.tabs.clear(); state.order = [];
  state.editor.open = []; state.editor.active = null;
  state.editor.split = false; state.editor.panes = [null, null]; state.editor.focused = 0;
  if (editors[1]) { editors[1].destroy(); editors[1] = null; }
  const list = await atom.sessions.list();
  const pt = await atom.project.getTabs(path).catch(() => null);
  let open = ((pt && pt.openTabIds) || []).filter((id) => list.find((s) => s.id === id));
  if (!open.length) { const inProj = list.filter((s) => samePath(s.cwd, path)).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")); if (inProj.length) open = [inProj[0].id]; }
  if (!open.length) { const s = await atom.sessions.create({ cwd: path }); open = [s.id]; }
  for (const id of open) { const v = await atom.sessions.get(id); if (v) addTabState(v); }
  state.order = open.filter((id) => state.tabs.has(id));
  state.activeTabId = (pt && state.tabs.has(pt.activeTabId)) ? pt.activeTabId : state.order[0];
  updateEditorLayout();
  renderTabs();
  await switchTab(state.activeTabId, true);
  const savedFiles = (pt && pt.editorOpenFiles) || [];
  for (const p of savedFiles) { const sz = await atom.files.size(p).catch(() => -1); if (sz >= 0 && sz <= 5 * 1024 * 1024) await openInEditor(p, true); }  // skip missing/huge on restore
  if (pt && pt.editorActiveFile && state.editor.open.find((f) => f.path === pt.editorActiveFile)) activateEditorFile(pt.editorActiveFile);
  restoreSplit(pt);
  await atom.settings.set({ lastFolder: path });
  toast("Switched to " + baseName(path), "folderOpen");
}
// Re-open a saved split layout (two panes) from persisted project state.
export function restoreSplit(pt) {
  if (!pt || !pt.editorSplit || state.editor.open.length < 1) return;
  const has = (p) => p && state.editor.open.find((f) => f.path === p);
  const p0 = has(pt.editorPanes && pt.editorPanes[0]) ? pt.editorPanes[0] : state.editor.active;
  let p1 = has(pt.editorPanes && pt.editorPanes[1]) ? pt.editorPanes[1] : null;
  if (!p1) p1 = (state.editor.open.find((f) => f.path !== p0) || {}).path || p0;
  if (!p0 || !p1) return;
  state.editor.split = true;
  state.editor.splitDir = pt.editorSplitDir === "h" ? "h" : "v";
  state.editor.panes = [p0, p1];
  state.editor.focused = 0;
  state.editor.active = p0;
  renderEditor();
}
// A small modal with 2–3 choice buttons → resolves to the chosen value (or null).
export function chooseDialog({ title, ic, message, choices }) {
  return new Promise((resolve) => {
    let result = null, done = false;
    const finish = () => { if (done) return; done = true; resolve(result); };
    const buttons = choices.map((c) => h("button", {
      class: "btn " + (c.primary ? "btn-primary" : "btn-ghost"),
      text: c.label, onclick: () => { result = c.value; closeModal(back); },
    }));
    const back = modalShell({
      title: title || "Choose", ic: ic || "folderOpen",
      body: h("div", { style: "color:var(--text-2); line-height:1.6; font-size:13.5px", text: message || "" }),
      footer: buttons,
    });
    back.addEventListener("modal-closed", finish);   // × / backdrop / Escape → null, never a dangling Promise
  });
}
