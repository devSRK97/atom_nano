/* AtomNano renderer — Sidebar — file tree and the file viewer.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { $, baseName, closeModal, confirmDialog, copyText, h, modalShell, promptDialog, relPath, showContextMenu, toast } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { applyWindowTitle } from "../core/theme.js";
import { gitGutterRefreshAll, loadPaneFile, openInEditor, renderEditorTabs, stateActiveFile, updateEditorLayout } from "../editor/editor-pane.js";
import { openSearch } from "../editor/search-palette.js";
import { closeEditorFile, updateEditorStatus } from "../editor/symbols.js";
import { gitPull, refreshGit, renderGitView, setSidebarView } from "../git/sidebar.js";
import { esc, renderFolderActions } from "../git/titlebar.js";
import { icon } from "../icons.js";
import { chooseDialog, openProjectMenu, persistTabs, pushRecent } from "./projects.js";

/* ============================================================
   SIDEBAR + FILE TREE
   ============================================================ */
export async function renderSidebar() {
  const ts = activeTS();
  if (!ts) return;
  const bar = $("folderBar");
  bar.innerHTML = "";
  bar.append(
    h("button", { class: "folder-pick", title: state.project + "  —  switch / open project", onclick: (e) => openProjectMenu(e) },
      h("span", { class: "fp-icon", html: icon("folderOpen", 17) }),
      h("span", { class: "fp-name", text: baseName(state.project) }),
      h("span", { html: icon("chevronDown", 14) })),
    h("div", { class: "folder-actions", id: "folderActions" }));
  renderFolderActions();

  // footer removed — Settings lives top-right; History is in the chat header.
  $("sidebarFooter").innerHTML = "";

  await ensureTreeRoot(ts);
  if (state.sidebarView === "git") renderGitView();
  else renderTree();
}
export async function ensureTreeRoot(ts) {
  const root = state.project || ts.meta.cwd;
  if (!ts.tree || ts.tree.root !== root) ts.tree = { root, expanded: new Set(), cache: new Map() };
  if (!ts.tree.cache.has(ts.tree.root)) {
    try { const d = await atom.files.list(ts.tree.root); ts.tree.cache.set(ts.tree.root, d.entries); }
    catch { ts.tree.cache.set(ts.tree.root, null); }
  }
  setWatchRoot(ts.tree.root);   // watch the active tree root for external changes
}
// Tell the main process which folder to watch (only when it actually changes).
export function setWatchRoot(root) {
  if (!root || root === state._watchedRoot) return;
  state._watchedRoot = root;
  try { atom.files.watch(root); } catch { /* ignore */ }
}
export function renderTree() {
  if (state.sidebarView !== "files") return;   // the Git/Changes view owns #fileTree right now — don't clobber it
  const ts = activeTS();
  const host = $("fileTree");
  host.innerHTML = "";
  if (!ts) return;
  const root = ts.tree.root;
  const entries = ts.tree.cache.get(root);
  if (entries === null) { host.append(h("div", { class: "tree-empty", text: "Folder not accessible." })); return; }
  if (!entries) { host.append(h("div", { class: "tree-loading", text: "Loading…" })); return; }
  const editedSet = new Set(ts.editedFiles.map((f) => f.path));
  renderTreeLevel(host, entries, 0, ts, editedSet);
}
// Highlight the row of the currently-open editor file (without rebuilding the
// tree). Called whenever the active editor file changes.
export function highlightTreeFile() {
  if (state.sidebarView !== "files") return;
  const host = $("fileTree"); if (!host) return;
  host.querySelectorAll(".tree-row.active").forEach((r) => r.classList.remove("active"));
  const active = state.editor.active;
  if (!active) return;
  let row = null;
  try { row = host.querySelector(`.tree-row[data-path="${CSS.escape(active)}"]`); } catch { /* invalid selector */ }
  if (row && row.dataset.dir === "0") row.classList.add("active");
}
export function renderTreeLevel(host, entries, depth, ts, editedSet) {
  if (!entries.length) { host.append(h("div", { class: "tree-empty", style: `padding-left:${12 + depth * 14}px`, text: "empty" })); return; }
  for (const e of entries) {
    const isOpen = ts.tree.expanded.has(e.path);
    const row = h("div", {
      class: "tree-row" + (e.isDir ? " is-dir" : "") + (isOpen ? " open" : "") + (e.skip || e.hidden ? " dim" : "") + (e.isDir && e.path === state.selectedFolder ? " selected" : "") + (!e.isDir && e.path === state.editor.active ? " active" : ""),
      style: `padding-left:${6 + depth * 14}px`,
      dataset: { path: e.path, dir: e.isDir ? "1" : "0" },
      onclick: () => {
        if (e.isDir) { state.selectedFolder = e.path; state.findContext = "folder"; toggleDir(e); }
        else { state.findContext = "editor"; openInEditor(e.path); }
      },
      oncontextmenu: (ev) => { ev.preventDefault(); if (e.isDir) state.selectedFolder = e.path; fileContextMenu(ev, e); },
    },
      e.isDir ? h("span", { class: "tw-chev", html: icon("chevron", 13) }) : h("span", { class: "tw-chev" }),
      e.isDir
        ? h("span", { class: "tw-icon ft-folder", html: icon(isOpen ? "folderOpen" : "folder", 15) })
        : (function () { const m = fileMeta(e.name); return h("span", { class: "tw-icon " + m.cls, html: icon(m.ic, 15) }); })(),
      h("span", { class: "tw-name" + (e.isDir ? "" : " " + fileMeta(e.name).cls), text: e.name }),
      editedSet.has(e.path) ? h("span", { class: "edit-badge", html: icon("dot", 10) }) : null);
    host.append(row);
    if (e.isDir && isOpen) {
      const children = ts.tree.cache.get(e.path);
      const childHost = h("div", { class: "tree-children" });
      host.append(childHost);
      if (children === undefined) childHost.append(h("div", { class: "tree-loading", style: `padding-left:${12 + (depth + 1) * 14}px`, text: "Loading…" }));
      else if (children === null) childHost.append(h("div", { class: "tree-empty", text: "—" }));
      else renderTreeLevel(childHost, children, depth + 1, ts, editedSet);
    }
  }
}
export async function toggleDir(e) {
  const ts = activeTS();
  if (ts.tree.expanded.has(e.path)) { ts.tree.expanded.delete(e.path); renderTree(); return; }
  ts.tree.expanded.add(e.path);
  if (!ts.tree.cache.has(e.path)) {
    renderTree();
    try { const d = await atom.files.list(e.path); ts.tree.cache.set(e.path, d.entries); }
    catch { ts.tree.cache.set(e.path, null); }
  }
  renderTree();
}
export async function refreshTree(silent) {
  const ts = activeTS();
  if (!ts) return;
  ts.tree.cache.clear();
  await ensureTreeRoot(ts);
  // reload expanded dirs
  for (const p of ts.tree.expanded) { try { const d = await atom.files.list(p); ts.tree.cache.set(p, d.entries); } catch { ts.tree.cache.set(p, null); } }
  renderTree();
  if (!silent) toast("File tree refreshed", "refresh");   // silent when called as a side-effect of a git op (keeps the git summary toast)
}
export let _fsChangeT = 0;
// An external change under the watched root (another app/editor, the AI agent's
// edits, or a git operation) → resync the file tree, the git status (when the
// commit view is showing), and any open editor files. Debounced so a burst of
// filesystem events triggers a single resync.
export function onFsChanged() {
  if (state._fsSyncOff) return;   // test seam: suites that inject fake state disable this
  clearTimeout(_fsChangeT);
  _fsChangeT = setTimeout(async () => {
    try { await refreshTree(true); } catch { /* ignore */ }
    if (state.sidebarView === "git") { try { await refreshGit(); } catch { /* ignore */ } }
    try { await syncOpenFilesFromDisk(); } catch { /* ignore */ }
  }, 180);
}
// Reload open editor files whose on-disk content changed out from under us.
// Files with UNSAVED edits are never clobbered — they keep the user's text and
// raise a one-time "changed on disk" notice instead.
export async function syncOpenFilesFromDisk() {
  if (!state.editor.open.length) return;
  const reloaded = new Set(); let conflict = null, changed = false;
  for (const f of state.editor.open.slice()) {
    let data;
    try { data = await atom.files.read(f.path); } catch { data = null; }
    if (!data || data.error || data.tooLarge || data.isBinary) continue;
    const disk = (data.content || "").replace(/\r\n/g, "\n");
    if (disk === f.saved) { if (f._diskConflict) { f._diskConflict = false; changed = true; } continue; }
    if (f.dirty) { if (!f._diskConflict) { f._diskConflict = true; conflict = f; changed = true; } continue; }
    f.content = disk; f.saved = disk; f._diskConflict = false; f._stale = false; changed = true;
    f.eol = /\r\n/.test(data.content || "") ? "crlf" : "lf";
    reloaded.add(f.path);
  }
  // Reload any pane currently showing a file whose disk content changed.
  if (reloaded.size) for (let p = 0; p < 2; p++) if (state.editor.panes[p] && reloaded.has(state.editor.panes[p])) loadPaneFile(p, true);
  if (changed) { renderEditorTabs(); const af = stateActiveFile(); if (af) updateEditorStatus(af); }
  gitGutterRefreshAll();   // external git ops (checkout/pull) change the diff vs HEAD
  if (conflict) toast(`"${conflict.name}" changed on disk — your unsaved edits were kept`, "alert", { ms: 4500 });
}
// File-type metadata for editor tabs + the project tree. Each entry maps to
// an existing icon and a CSS class — the class drives a subtle WebStorm-style
// colour on the icon glyph + a muted tint on the filename. Extensions match
// case-insensitively; filename special-cases (e.g. Dockerfile, package.json)
// override the extension match. Unknown types fall back to a plain "file"
// glyph in the default text colour.
export const FILE_TYPE_BY_EXT = {
  // JS/TS family
  js: "js", mjs: "js", cjs: "js", jsx: "jsx",
  ts: "ts", tsx: "tsx", "d.ts": "ts",
  // Web
  html: "html", htm: "html",
  css: "css", scss: "scss", sass: "scss", less: "css",
  vue: "vue", svelte: "svelte", astro: "astro",
  // Data
  json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml", toml: "yaml",
  xml: "xml", csv: "csv", tsv: "csv",
  // Backend langs
  py: "py", rb: "rb", php: "php", go: "go", rs: "rs",
  java: "java", kt: "kt", swift: "swift", scala: "scala",
  c: "c", cc: "c", cpp: "c", h: "c", hpp: "c", cs: "cs",
  // Shell + scripts
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
  bat: "bat", cmd: "bat", ps1: "ps", psm1: "ps",
  // Docs
  md: "md", markdown: "md", mdx: "md",
  txt: "txt", rst: "txt", adoc: "txt",
  pdf: "pdf",
  // Config / DevOps
  env: "env", ini: "ini", cfg: "ini", conf: "ini",
  lock: "lock",
  dockerfile: "docker",
  // Images
  png: "img", jpg: "img", jpeg: "img", gif: "img", webp: "img",
  svg: "svg", ico: "img", bmp: "img",
  // Misc
  sql: "sql",
  ipynb: "ipynb",
  proto: "proto",
  gradle: "gradle",
  log: "log",
};
export const FILE_TYPE_BY_NAME = {
  "package.json": "pkg-json", "package-lock.json": "lock",
  "tsconfig.json": "tsconfig", "tsconfig.base.json": "tsconfig",
  "jsconfig.json": "tsconfig",
  "dockerfile": "docker", "docker-compose.yml": "docker", "docker-compose.yaml": "docker",
  ".dockerignore": "docker",
  ".gitignore": "git", ".gitattributes": "git", ".gitkeep": "git",
  ".npmrc": "npm", ".npmignore": "npm",
  ".env": "env", ".env.local": "env", ".env.development": "env", ".env.production": "env",
  ".eslintrc": "lint", ".eslintrc.json": "lint", ".eslintrc.js": "lint", ".eslintrc.cjs": "lint",
  ".prettierrc": "lint", ".prettierrc.json": "lint", "prettier.config.js": "lint",
  "makefile": "makefile",
  "readme.md": "readme", "readme": "readme",
  "license": "license", "license.md": "license", "license.txt": "license",
  "changelog.md": "md",
};
// Each type → { ic: <existing icon name from icons.js>, cls: "ft-<type>" }.
// The cls hooks the CSS-var colour pair (icon + name tint). Icon names
// reuse what's already in icons.js so we don't bloat the SVG bundle.
export const FILE_TYPE_META = {
  js:        { ic: "jsLetters",  cls: "ft-js" },
  jsx:       { ic: "atom",       cls: "ft-jsx" },         // React component — atomic-orbital glyph
  ts:        { ic: "tsLetters",  cls: "ft-ts" },
  tsx:       { ic: "atom",       cls: "ft-tsx" },         // React component (TS)
  html:      { ic: "globe",    cls: "ft-html" },
  css:       { ic: "fileCode", cls: "ft-css" },
  scss:      { ic: "fileCode", cls: "ft-scss" },
  vue:       { ic: "fileCode", cls: "ft-vue" },
  svelte:    { ic: "fileCode", cls: "ft-svelte" },
  astro:     { ic: "fileCode", cls: "ft-astro" },
  json:      { ic: "jsonBraces", cls: "ft-json" },
  yaml:      { ic: "list",     cls: "ft-yaml" },
  xml:       { ic: "fileCode", cls: "ft-xml" },
  csv:       { ic: "list",     cls: "ft-csv" },
  py:        { ic: "fileCode", cls: "ft-py" },
  rb:        { ic: "fileCode", cls: "ft-rb" },
  php:       { ic: "fileCode", cls: "ft-php" },
  go:        { ic: "fileCode", cls: "ft-go" },
  rs:        { ic: "fileCode", cls: "ft-rs" },
  java:      { ic: "fileCode", cls: "ft-java" },
  kt:        { ic: "fileCode", cls: "ft-kt" },
  swift:     { ic: "fileCode", cls: "ft-swift" },
  scala:     { ic: "fileCode", cls: "ft-scala" },
  c:         { ic: "fileCode", cls: "ft-c" },
  cs:        { ic: "fileCode", cls: "ft-cs" },
  sh:        { ic: "terminal", cls: "ft-sh" },
  bat:       { ic: "terminal", cls: "ft-bat" },
  ps:        { ic: "terminal", cls: "ft-ps" },
  md:        { ic: "file",     cls: "ft-md" },
  txt:       { ic: "file",     cls: "ft-txt" },
  pdf:       { ic: "file",     cls: "ft-pdf" },
  env:       { ic: "key",      cls: "ft-env" },
  ini:       { ic: "settings", cls: "ft-ini" },
  lock:      { ic: "shield",   cls: "ft-lock" },
  docker:    { ic: "cpu",      cls: "ft-docker" },
  img:       { ic: "image",    cls: "ft-img" },
  svg:       { ic: "image",    cls: "ft-svg" },
  sql:       { ic: "list",     cls: "ft-sql" },
  ipynb:     { ic: "fileCode", cls: "ft-py" },
  proto:     { ic: "fileCode", cls: "ft-proto" },
  gradle:    { ic: "fileCode", cls: "ft-gradle" },
  log:       { ic: "file",     cls: "ft-log" },
  "pkg-json":{ ic: "jsonBraces", cls: "ft-pkgjson" },
  tsconfig:  { ic: "jsonBraces", cls: "ft-tsconfig" },
  git:       { ic: "git",      cls: "ft-git" },
  npm:       { ic: "list",     cls: "ft-npm" },
  lint:      { ic: "check",    cls: "ft-lint" },
  makefile:  { ic: "terminal", cls: "ft-makefile" },
  readme:    { ic: "file",     cls: "ft-readme" },
  license:   { ic: "shield",   cls: "ft-license" },
};
// Look up icon + class for one filename. Special-case names (Dockerfile,
// README, .env, package.json…) win over the trailing-extension match.
export function fileMeta(name) {
  if (!name) return { ic: "file", cls: "" };
  const low = String(name).toLowerCase();
  const byName = FILE_TYPE_BY_NAME[low];
  if (byName && FILE_TYPE_META[byName]) return FILE_TYPE_META[byName];
  // Handle compound extensions like ".d.ts" before plain ".ts".
  if (low.endsWith(".d.ts") && FILE_TYPE_META.ts) return FILE_TYPE_META.ts;
  const dot = low.lastIndexOf(".");
  if (dot < 0 || dot === low.length - 1) return { ic: "file", cls: "" };
  const ext = low.slice(dot + 1);
  const type = FILE_TYPE_BY_EXT[ext];
  return (type && FILE_TYPE_META[type]) || { ic: "file", cls: "" };
}
// Back-compat: keep the old single-icon-name API for any caller still using it.
export function fileIcon(extOrName) { return fileMeta(extOrName).ic; }
/* ---- tree file operations -------------------------------------------------
 * The tree could read, reveal and open, but never create, rename or delete —
 * every one of those meant leaving the app or asking the agent to do it. */
export function parentDir(p) { return String(p || "").replace(/[\\/][^\\/]*$/, "") || p; }
export function promptNewEntry(parent, isDir) {
  promptDialog({
    title: isDir ? "New folder" : "New file",
    ic: isDir ? "folderPlus" : "file",
    placeholder: isDir ? "components" : "utils.ts",
    confirmLabel: "Create",
    onConfirm: async (name) => {
      name = (name || "").trim();
      if (!name) return;
      // A path in the name creates the intermediate folders — "a/b/c.ts" just works.
      const target = parent.replace(/[\\/]+$/, "") + "/" + name.replace(/^[\\/]+/, "");
      try {
        if (isDir) await atom.files.createFolder(target);
        else await atom.files.createFile(target, "");
        await refreshTree(true);
        if (!isDir) await openInEditor(target);
        toast(`Created ${esc(baseName(target))}`, "checkCircle", { ms: 2200 });
      } catch (err) { toast(`Create failed: ${esc(err.message)}`, "alert", { ms: 6000 }); }
    },
  });
}
export function promptRename(e) {
  promptDialog({
    title: "Rename", ic: "edit", value: e.name, placeholder: e.name, confirmLabel: "Rename",
    onConfirm: async (name) => {
      name = (name || "").trim();
      if (!name || name === e.name) return;
      try {
        // state.project lets the language service rewrite the imports that
        // pointed at the old path — see files:rename in main.
        const r = await atom.files.rename(e.path, name, state.project);
        await refreshTree(true);
        // Keep an open editor tab pointing at the file under its new name.
        const open = state.editor.open.find((f) => f.path === e.path);
        if (open) { closeEditorFile(e.path); if (!r.isDir) await openInEditor(r.path); }
        const fixed = r.refactor && r.refactor.files
          ? ` — updated imports in ${r.refactor.files} file${r.refactor.files === 1 ? "" : "s"}`
          : "";
        toast(`Renamed to ${esc(baseName(r.path))}${fixed}`, "checkCircle", { ms: 3600 });
      } catch (err) { toast(`Rename failed: ${esc(err.message)}`, "alert", { ms: 6000 }); }
    },
  });
}
export function confirmDelete(e) {
  chooseDialog({
    title: e.isDir ? "Delete folder" : "Delete file", ic: "trash",
    message: `Move “${e.name}” to the Recycle Bin?${e.isDir ? " Everything inside goes with it." : ""}`,
    choices: [
      { label: "Delete", value: "del", primary: true },
      { label: "Cancel", value: null },
    ],
  }).then(async (choice) => {
    if (choice !== "del") return;
    try {
      await atom.files.trash(e.path);
      if (!e.isDir) closeEditorFile(e.path);   // sync, and a no-op when it isn't open
      await refreshTree(true);
      toast(`${esc(e.name)} moved to the Recycle Bin`, "checkCircle", { ms: 2600 });
    } catch (err) { toast(`Delete failed: ${esc(err.message)}`, "alert", { ms: 6000 }); }
  });
}
export async function fileContextMenu(ev, e) {
  const x = ev.clientX, y = ev.clientY;
  const ts = activeTS();
  const items = [
    { label: "Copy absolute path", icon: "copy", onClick: () => copyText('"' + e.path + '"', "Absolute path copied") },
    { label: "Copy relative path", icon: "copy", onClick: () => copyText(relPath(e.path, ts.meta.cwd), "Relative path copied") },
    { label: "Copy name", icon: "copy", onClick: () => copyText(e.name, "Name copied") },
    { sep: true },
    { label: "Reveal in File Explorer", icon: "external", onClick: () => atom.files.reveal(e.path) },
  ];
  // Folders get "Search folder" (replacing the old OS "Open folder"); files keep OS-open.
  if (e.isDir) items.push({ label: "Search folder", icon: "search", onClick: () => openSearch({ mode: "content", root: e.path }) });
  else items.push({ label: "Open file (default app)", icon: "external", onClick: () => atom.files.open(e.path) });
  /* Create / rename / delete. New items land INSIDE a folder and BESIDE a file,
   * which is what every file tree does and what the click position implies. */
  const parent = e.isDir ? e.path : parentDir(e.path);
  items.push(
    { sep: true },
    { label: "New file…", icon: "file", onClick: () => promptNewEntry(parent, false) },
    { label: "New folder…", icon: "folderPlus", onClick: () => promptNewEntry(parent, true) },
    { label: "Rename…", icon: "edit", onClick: () => promptRename(e) },
    { label: "Delete", icon: "trash", onClick: () => confirmDelete(e) },
  );
  if (!e.isDir) items.splice(5, 0, { label: "Open in editor", icon: "fileCode", onClick: () => openInEditor(e.path) });
  if (e.isDir) {
    items.push(
      { sep: true },
      { label: "Open Terminal here", icon: "terminal", onClick: () => atom.files.openTerminal(e.path).catch((err) => toast("Couldn't open terminal: " + err.message, "alert")) },
      { label: "Set as working folder", icon: "folderOpen", onClick: () => setWorkingFolder(e.path) });
    // If this folder is a git repo, offer Pull (commit/push live in the panel).
    let isRepo = false; try { isRepo = await atom.git.isRepoDir(e.path); } catch { /* ignore */ }
    if (isRepo) items.push({ sep: true }, { label: "Git pull", icon: "pull", onClick: () => gitPull(e.path) }, { label: "Open commit view", icon: "commit", onClick: () => setSidebarView("git") });
  }
  items.push({ sep: true }, { label: e.isDir ? "Delete folder" : "Delete file", icon: "trash", danger: true, onClick: () => deleteTreeItem(e) });
  showContextMenu(x, y, items);
}
export function deleteTreeItem(e) {
  confirmDialog({
    title: e.isDir ? "Delete folder?" : "Delete file?",
    message: `"${e.name}" will be moved to the Recycle Bin.`,
    danger: true, confirmLabel: "Delete",
    onConfirm: async () => {
      try { await atom.files.trash(e.path); }
      catch (err) { toast("Delete failed: " + err.message, "alert"); return; }
      // close it in the editor if open (no unsaved prompt — it's gone)
      const oi = state.editor.open.findIndex((f) => f.path === e.path);
      if (oi >= 0) {
        state.editor.open.splice(oi, 1);
        if (state.editor.active === e.path) state.editor.active = state.editor.open[0] ? state.editor.open[0].path : null;
        updateEditorLayout();
      }
      if (state.selectedFolder === e.path) state.selectedFolder = null;
      await refreshTree();
      toast((e.isDir ? "Folder" : "File") + " moved to Recycle Bin", "trash");
    },
  });
}
// Re-root THIS window to a subfolder (tree + new sessions).
export async function setWorkingFolder(folder) {
  state.project = folder;
  state.settings.lastFolder = folder;
  pushRecent(folder);
  applyWindowTitle();
  for (const ts of state.tabs.values()) ts.tree = null;
  await atom.settings.set({ lastFolder: folder });
  await renderSidebar();
  persistTabs();
  toast("Project folder set to " + baseName(folder), "folderOpen");
}
/* ============================================================
   FILE VIEWER
   ============================================================ */
export async function openFileViewer(filePath) {
  const data = await atom.files.read(filePath).catch((e) => ({ error: String(e) }));
  let body;
  if (data.error) body = h("div", { class: "error-card" }, h("span", { html: icon("alert", 18) }), data.error);
  else if (data.tooLarge) body = h("div", { class: "sys-note", text: `File is too large to preview (${(data.size / 1048576).toFixed(1)} MB).` });
  else if (data.isBinary) body = h("div", { class: "sys-note", text: "Binary file — cannot preview as text." });
  else body = h("div", {},
    h("div", { class: "fv-meta" }, h("span", { html: icon("file", 13) }), h("span", { text: filePath }), h("span", { text: `· ${data.content.split("\n").length} lines` })),
    h("pre", { class: "fv-pre", text: data.content }));

  const back = modalShell({
    title: baseName(filePath), ic: "file", wide: true, body,
    footer: [
      h("button", { class: "btn btn-ghost btn-sm", text: "Reveal in Explorer", onclick: () => atom.files.reveal(filePath) }),
      h("button", { class: "btn btn-ghost btn-sm", text: "Open externally", onclick: () => atom.files.open(filePath) }),
      data && data.content ? h("button", { class: "btn btn-ghost btn-sm", text: "Copy contents", onclick: () => copyText(data.content, "File contents copied") }) : null,
      h("button", { class: "btn btn-primary btn-sm", text: "Close", onclick: () => closeModal(back) }),
    ],
  });
}
