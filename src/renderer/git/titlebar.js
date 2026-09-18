/* AtomNano renderer — Title bar — File menu and the Git toolbar (pull / commit / push).
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { importConversation } from "../chat/composer.js";
import { $, h, showContextMenu, toast } from "../core/dom.js";
import { activeTS, state } from "../core/state.js";
import { newUntitledFile } from "../editor/editor-pane.js";
import { openSearch } from "../editor/search-palette.js";
import { icon } from "../icons.js";
import { openSettings } from "../settings/settings.js";
import { pickAndOpenProject } from "../workspace/projects.js";
import { renderTree } from "../workspace/sidebar.js";
import { openGitCenter } from "./center/index.js";
import { newTab } from "./conflicts-ui.js";
import { gDiffView } from "./diff-viewer.js";
import { openCommitModal, pullAll, renderGitView, setSidebarView } from "./sidebar.js";

/* ============================================================
   TITLEBAR: File menu + Git toolbar (pull / commit / push)
   ============================================================ */
export function gitProjectRoot() { return state.project || activeTS()?.meta.cwd || ""; }
export function repoName(p) { return (p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p; }
export function gitTotalChanges() { return (state.git.repos || []).reduce((n, r) => { const s = state.git.statuses[r]; return n + ((s && s.files) ? s.files.length : 0); }, 0); }
export function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
/* ---- commit selection: a Set of "repo\x1fpath" keys, decoupled from git's index.
   Ticking a file (or folder) only SELECTS it; staging happens at commit time. */
export function selKey(repo, p) { return repo + "\n" + p; }
export function isSel(repo, p) { return state.git.selected.has(selKey(repo, p)); }
export function setSel(repo, p, on) { const k = selKey(repo, p); if (on) state.git.selected.add(k); else state.git.selected.delete(k); }
export function repoFiles(repo) { const s = state.git.statuses[repo]; return (s && s.files) || []; }
export function repoSelectedPaths(repo) { return repoFiles(repo).filter((f) => isSel(repo, f.path)).map((f) => f.path); }
export function selectionByRepo() { return (state.git.repos || []).map((repo) => ({ repo, files: repoSelectedPaths(repo) })).filter((g) => g.files.length); }
export function totalSelected() { return (state.git.repos || []).reduce((n, r) => n + repoSelectedPaths(r).length, 0); }
export function setRepoSelection(repo, files, on) { for (const f of files) setSel(repo, f.path, on); afterGitSelectionChange(); }
export function afterGitSelectionChange() { renderGitView(); }
// A repo is pushable if it has commits the upstream lacks, or has never been pushed.
export function gitPushable(repo) { const s = state.git.statuses[repo]; return !!s && (s.ahead > 0 || !s.upstream); }
// Title bar now holds only the File menu — Pull/Push/Commit moved into the
// project-dropdown row (see renderFolderActions).
export function renderTitlebarActions() {
  const host = $("tbActions");
  if (!host) return;
  host.innerHTML = "";
  host.append(h("button", { class: "tb-btn", title: "File", onclick: (e) => fileMenu(e) },
    h("span", { html: icon("file", 15) }), h("span", { text: "File" })));
}
// Everything the Git Center module (git/center/) borrows from app.js — passed
// explicitly so the module stays decoupled. All functions are hoisted; `state`
// and `atom` exist by the time a button is clicked.
export function gitCenterDeps() {
  return {
    h, icon, atom, state, toast, esc, repoName, baseName, fileMeta,
    parseUnifiedDiff, renderDiffContent, diffEmpty, getDiffView: () => gDiffView, setDiffView,
    refreshGit, refreshTree, openInEditor, openConflictResolver, conflictedFiles, showMenuAt,
    chooseDialog, promptDialog, confirmDialog, modalShell, projectRoot: gitProjectRoot,
  };
}
// The project-dropdown row's action buttons. Files view → [Search, Git,
// Collapse, Pull, Commit]; the Git/commit view swaps Collapse for a Back arrow. Git buttons only
// appear when the folder is (or contains) a repo. (No standalone Push — pushing
// happens via Commit & Push, the per-project push button, or the row's menu.)
export function renderFolderActions() {
  const host = $("folderActions");
  if (!host) return;
  host.innerHTML = "";
  const inGit = state.sidebarView === "git";
  if (inGit) {
    host.append(h("button", { class: "sb-act", title: "Back to files", onclick: () => setSidebarView("files") },
      h("span", { html: icon("chevronLeft", 14) }), "Back"));
  } else {
    // Project search — folders, file names and file contents, with filters.
    host.append(h("button", { class: "sb-act icon-only", title: "Search folders, files & contents in this project", onclick: () => { const ts = activeTS(); openSearch({ root: (ts && ts.meta.cwd) || state.project, mode: "content" }); } },
      h("span", { html: icon("search", 14) })));
    // Git Center — every repo, source → target merge/rebase, history, branches, stashes…
    host.append(h("button", { class: "sb-act icon-only", title: "Git Center — repositories, branches, merge & conflicts, history, stashes, tags", onclick: () => openGitCenter(gitCenterDeps(), {}) },
      h("span", { html: icon("git", 14) })));
    host.append(h("button", { class: "sb-act", title: "Collapse all", onclick: () => { const ts = activeTS(); if (ts) { ts.tree.expanded.clear(); renderTree(); } } },
      h("span", { html: icon("list", 14) }), "Collapse"));
  }
  const repos = state.git.repos || [];
  if (!repos.length) return;
  const behind = repos.reduce((n, r) => { const s = state.git.statuses[r]; return n + ((s && s.behind) || 0); }, 0);
  host.append(h("button", { class: "sb-act", title: repos.length > 1 ? "Pull all projects" : "Pull (git pull)", onclick: () => pullAll() },
    h("span", { html: icon("pull", 14) }), behind ? `Pull (${behind})` : "Pull"));
  const total = gitTotalChanges();
  // Opens the full Review & Commit modal directly — does NOT switch the
  // sidebar away from the file tree the user is currently looking at.
  host.append(h("button", { class: "sb-act" + (inGit ? " active" : ""), title: "Review & commit changes", onclick: () => {
    if (!total) { toast("No changes to commit", "alert"); return; }
    openCommitModal(false);
  } },
    h("span", { html: icon("commit", 14) }), total ? `Commit (${total})` : "Commit"));
}
export function fileMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 4, [
    { label: "New file", icon: "file", onClick: () => newUntitledFile() },
    { label: "Open folder…", icon: "folderOpen", onClick: () => pickAndOpenProject() },
    { label: "New session", icon: "plus", onClick: () => newTab() },
    { sep: true },
    { label: "Search in project", icon: "search", onClick: () => openSearch({ mode: "content", root: state.project }) },
    { label: "Import conversation…", icon: "download", onClick: () => importConversation() },
    { sep: true },
    { label: "Settings", icon: "settings", onClick: () => openSettings() },
  ]);
}
