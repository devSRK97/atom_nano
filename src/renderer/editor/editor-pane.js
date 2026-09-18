/* AtomNano renderer — Code editor pane — CodeMirror 6 surfaces, tabs, split view, save, untitled buffers.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { dragProps, reorderEditorTabs } from "../chat/tabs.js";
import { $, baseName, copyText, h, hideContextMenu, mdToRichHtml, samePath, selectionHtml, showContextMenu, styleRichHtml, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { icon } from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { persistEditor } from "../workspace/projects.js";
import { fileMeta, highlightTreeFile } from "../workspace/sidebar.js";
import { closeEditorFile, dropEditorFile, editorFindReferences, editorGoToLine, editorGoToLinePrompt, editorQuickFix, editorRename, editorTabContextMenu, navMark, onEditorDiagnostics, openSymbolPicker, renderBreadcrumbs, saveEditorFile, scheduleSymbolRefresh, updateBreadcrumbsCursor, updateEditorStatus } from "./symbols.js";

// CodeMirror 6 (~285 KB + language chunks) is loaded on demand the first time an
// editor surface is shown — a chat-only session never pays its parse/heap cost.
export let createEditor = null, _cmLoading = null;
export function ensureCmModule() {
  if (createEditor) return Promise.resolve(createEditor);
  if (!_cmLoading) _cmLoading = import("./cm.bundle.js").then((m) => { createEditor = m.createEditor; return createEditor; });   // module-relative: this file lives in editor/ next to the bundle
  return _cmLoading;
}
/* ============================================================
   CODE EDITOR (CodeMirror 6 — see src/renderer/editor/cm-src.js)
   ============================================================ */
export function langOf(p) { return (p.split(".").pop() || "").toLowerCase(); }
export function escHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
// Image files open in the in-editor previewer (SVG stays editable text).
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
export const MD_EXTS = new Set(["md", "markdown", "mdx"]);
export function stateActiveFile() { return state.editor.open.find((x) => x.path === state.editor.active); }
export function activateEditorFile(filePath) {
  if (!state.editor.open.find((f) => f.path === filePath)) return;
  const idx = state.editor.focused;
  if (state.editor.panes[idx] === filePath) return;
  // Already shown in the other pane → just move focus there (no second copy).
  const other = idx === 0 ? 1 : 0;
  if (state.editor.split && state.editor.panes[other] === filePath) { focusPane(other); persistEditor(); return; }
  // Remember the outgoing pane file's scroll + folds + live text before swapping.
  if (editors[idx]) { const cur = paneFile(idx); if (cur) { cur.scrollTop = editors[idx].getScrollTop(); cur.folds = editors[idx].getFolds(); syncFileContent(cur, editors[idx]); } }
  const target = state.editor.open.find((f) => f.path === filePath);
  const wasImage = !!$("editorBody").querySelector(".img-view");
  state.editor.panes[idx] = filePath;
  state.editor.active = filePath;          // keep the tab order; activation never reorders
  // Crossing an image↔code boundary needs a full re-render (image branch re-attaches editors).
  if ((target && target.kind === "image") || wasImage) { renderEditorTabs(); renderEditor(); highlightTreeFile(); persistEditor(); return; }
  relinkPanes();                           // unlink before swapping the doc
  loadPaneFile(idx, true);
  relinkPanes();                           // relink if now the same file as the other pane
  renderEditorTabs();
  highlightTreeFile();
  persistEditor();
}
/* ---------------- Untitled buffers ------------------------------------------
 * Ctrl+N gives you somewhere to type before you have decided where it belongs —
 * a tab with no file behind it. The path is a scheme, not a location, so nothing
 * that walks the filesystem (git gutter, the language service, the tree, session
 * restore) can mistake the buffer for something on disk. It becomes a real file
 * only when you say where, at which point the tab is reopened from that path so
 * language, gutter and diagnostics all arrive with it.
 */
export const UNTITLED = "untitled:";
export function isUntitled(p) { return typeof p === "string" && p.startsWith(UNTITLED); }
export let _untitledSeq = 0;
export function newUntitledFile() {
  let name, path;
  do { name = `Untitled-${++_untitledSeq}`; path = UNTITLED + name; }
  while (state.editor.open.some((f) => f.path === path));
  state.findContext = "editor";
  // Same hand-off as opening a real file: the outgoing pane keeps its place.
  const fidx = state.editor.focused;
  if (editors[fidx]) { const cur = paneFile(fidx); if (cur) { cur.scrollTop = editors[fidx].getScrollTop(); cur.folds = editors[fidx].getFolds(); syncFileContent(cur, editors[fidx]); } }
  state.editor.open.push({ path, name, content: "", saved: "", dirty: false, lang: "", scrollTop: 0, eol: "lf", untitled: true });
  state.editor.panes[fidx] = path;
  state.editor.active = path;
  updateEditorLayout();
  highlightTreeFile();
  persistEditor();
  focusEditorSoon();
}
/* Put the cursor in the editor once there is one. The first editor surface in a
 * session loads CodeMirror on demand, so the pane can be several frames away —
 * focusing on the next frame would focus nothing at all. */
export function focusEditorSoon(tries = 60) {
  const ed = editors[state.editor.focused] || cm;
  if (ed) { ed.focus(); return; }
  if (tries > 0) requestAnimationFrame(() => focusEditorSoon(tries - 1));
}
/* Ask where a buffer should go and write it there. Returns the chosen path, or
 * null when the user backs out of the picker. Used both for a scratch tab that
 * has never had a path and for Save As on a file that has one. */
export async function promptWriteBufferTo(f) {
  for (let p = 0; p < 2; p++) if (state.editor.panes[p] === f.path && editors[p]) { syncFileContent(f, editors[p]); break; }
  const dir = (state.project || "").replace(/[\\/]+$/, "");
  const suggest = f.untitled ? (dir ? dir + "\\" + f.name : f.name) : f.path;
  // Written with the file's own line endings, the same as an ordinary save.
  const body = f.eol === "crlf" ? f.content.replace(/\r?\n/g, "\r\n") : f.content;
  let res;
  try { res = await atom.files.saveAs({ defaultPath: suggest, content: body }); }
  catch (e) { toast("Save failed: " + e.message, "alert"); return null; }
  if (!res || res.canceled || !res.path) return null;
  return res.path;
}
/* Write the buffer somewhere and keep editing it THERE — reopened from the new
 * path, so syntax, git gutter and diagnostics all arrive with the extension. */
export async function saveEditorAs(f) {
  if (!f || f.kind === "image") return false;
  const written = await promptWriteBufferTo(f);
  if (!written) return false;
  const pane = state.editor.panes.indexOf(f.path);
  dropEditorFile(f.path);
  // Saving onto a path that is already open would otherwise leave that tab
  // showing what the file used to contain.
  if (state.editor.open.some((x) => samePath(x.path, written))) dropEditorFile(written);
  if (pane >= 0 && state.editor.split) state.editor.focused = pane;
  await openInEditor(written);
  return true;
}
export async function openInEditor(filePath, quiet) {
  state.findContext = "editor";
  if (state.editor.open.find((f) => f.path === filePath)) { activateEditorFile(filePath); return; }
  // Remember the outgoing focused-pane file's folds + live text before swapping.
  const fidx = state.editor.focused;
  if (editors[fidx]) { const cur = paneFile(fidx); if (cur) { cur.scrollTop = editors[fidx].getScrollTop(); cur.folds = editors[fidx].getFolds(); syncFileContent(cur, editors[fidx]); } }
  // Image files → in-editor preview (no document/CM, no disk read of bytes here).
  if (IMAGE_EXTS.has(langOf(filePath))) {
    state.editor.open.push({ path: filePath, name: baseName(filePath), content: "", saved: "", dirty: false, lang: langOf(filePath), scrollTop: 0, eol: "lf", kind: "image" });
    state.editor.panes[fidx] = filePath;
    state.editor.active = filePath;
    updateEditorLayout();
    highlightTreeFile();
    persistEditor();
    return;
  }
  const data = await atom.files.read(filePath).catch((e) => ({ error: String(e) }));
  if (data.error) { if (!quiet) toast("Cannot open: " + data.error, "alert"); return; }
  if (data.tooLarge) { if (!quiet) toast("File too large to open in editor", "alert"); return; }
  if (data.isBinary) { if (!quiet) { toast("Binary file — opening externally"); atom.files.open(filePath); } return; }
  // Normalise to LF so the editor document, dirty-tracking and offsets all agree
  // (CRLF would otherwise drift between the on-disk bytes and CodeMirror's doc).
  const content = (data.content || "").replace(/\r\n/g, "\n");
  const eol = /\r\n/.test(data.content || "") ? "crlf" : "lf";   // detect line ending before normalising
  state.editor.open.push({ path: filePath, name: baseName(filePath), content, saved: content, dirty: false, lang: langOf(filePath), scrollTop: 0, eol });  // new files open at the end
  state.editor.panes[fidx] = filePath;     // the new file lands in the focused pane
  state.editor.active = filePath;
  updateEditorLayout();
  highlightTreeFile();
  persistEditor();
}
export function updateEditorLayout() {
  const has = state.editor.open.length > 0;
  $("editorPane").classList.toggle("hidden", !has);
  $("editorResizer").classList.toggle("hidden", !has);
  renderEditorTabs();
  renderEditor();   // handles both the populated and the empty (destroy editors) states
}
export let _prevTabPaths = new Set();
export function renderEditorTabs() {
  const host = $("editorTabs");
  host.innerHTML = "";
  const scroll = h("div", { class: "et-scroll" });
  const nowPaths = new Set(state.editor.open.map((f) => f.path));
  for (const f of state.editor.open) {
    scroll.append(h("div", Object.assign({
      class: "editor-tab" + (f.path === state.editor.active ? " active" : "") + (_prevTabPaths.size && !_prevTabPaths.has(f.path) ? " et-enter" : ""),
      dataset: { path: f.path },
      title: f.untitled ? `${f.name} — not saved yet` : f.path,
      onclick: () => activateEditorFile(f.path),
      oncontextmenu: (ev) => { ev.preventDefault(); editorTabContextMenu(ev, f); },
      onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeEditorFile(f.path); } },
    }, dragProps(f.path, reorderEditorTabs)),
      (function () { const m = fileMeta(f.name); return h("span", { class: "et-ico " + m.cls, html: icon(m.ic, 13) }); })(),
      h("span", { class: "et-name " + fileMeta(f.name).cls, text: f.name }),
      f.dirty ? h("span", { class: "et-dirty" }) : null,
      h("button", { class: "et-x", html: icon("close", 12), onclick: (e) => { e.stopPropagation(); closeEditorFile(f.path); } })));
  }
  host.append(scroll);
  const ov = h("button", { class: "et-overflow hidden", title: "Hidden tabs", onclick: (e) => editorOverflowMenu(e) },
    h("span", { html: icon("chevronDown", 16) }),
    h("span", { class: "et-badge hidden" }));
  host.append(ov);
  // Split controls: toggle split, and (when split) flip orientation.
  if (state.editor.split) {
    host.append(h("button", { class: "et-split", title: "Switch split orientation", html: icon(state.editor.splitDir === "h" ? "splitV" : "splitH", 15), onclick: toggleSplitOrientation }));
  }
  host.append(h("button", { class: "et-split" + (state.editor.split ? " active" : ""), title: state.editor.split ? "Close split (Ctrl+\\)" : "Split editor (Ctrl+\\)", html: icon(state.editor.splitDir === "h" ? "splitH" : "splitV", 15), onclick: toggleSplit }));
  const af = stateActiveFile();
  if (af && MD_EXTS.has((af.lang || "").toLowerCase())) {
    host.append(h("button", { class: "et-split" + (state.editor.mdPreview ? " active" : ""), title: "Toggle Markdown preview (Ctrl+Shift+V)", html: icon("eye", 15), onclick: toggleMarkdownPreview }));
  }
  _prevTabPaths = nowPaths;   // newly-opened tabs animate in on the next render
  requestAnimationFrame(computeEditorOverflow);
}
// Hide tabs that don't fit the visible width; the overflow button lists them.
// The active tab is always kept visible (shown as the last visible one).
export function computeEditorOverflow() {
  const host = $("editorTabs");
  if (!host) return;
  const scroll = host.querySelector(".et-scroll");
  const ov = host.querySelector(".et-overflow");
  if (!scroll || !ov) return;
  const tabs = [...scroll.querySelectorAll(".editor-tab")];
  tabs.forEach((t) => t.classList.remove("et-hidden"));
  ov.classList.add("hidden");
  ov._hidden = [];
  if (tabs.length <= 1) return;
  // Width actually available to the tab strip. host.clientWidth is the WHOLE
  // header — it includes the padding and the trailing controls (split, split
  // orientation, Markdown preview, overflow), none of which live inside
  // .et-scroll. Measuring against it over-allocated by 36–100px, so the last tab
  // was rendered past the edge and .et-scroll{overflow:hidden} clipped it — which
  // is why its close button disappeared once a second tab opened.
  const cs = getComputedStyle(host);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const trailing = [...host.children]
    .filter((c) => c !== scroll && !c.classList.contains("et-overflow"))
    .reduce((s, c) => s + c.offsetWidth, 0);
  const avail = Math.max(0, host.clientWidth - padX - trailing);
  const widths = new Map(tabs.map((t) => [t, t.offsetWidth]));
  const total = tabs.reduce((s, t) => s + widths.get(t), 0);
  if (total <= avail) return;                 // everything fits
  const reserve = 38;                         // room for the overflow button (34px + slack)
  const hidden = [];
  let used = 0;
  for (const t of tabs) {
    const w = widths.get(t);
    if (used + w <= avail - reserve) used += w;
    else { t.classList.add("et-hidden"); hidden.push(t.dataset.path); }
  }
  // Keep the active tab visible — if it got hidden, show it and drop visible
  // tabs from the right until it fits.
  const active = state.editor.active;
  if (active && hidden.includes(active)) {
    const aEl = tabs.find((t) => t.dataset.path === active);
    aEl.classList.remove("et-hidden");
    hidden.splice(hidden.indexOf(active), 1);
    let w2 = tabs.filter((t) => !t.classList.contains("et-hidden")).reduce((s, t) => s + widths.get(t), 0);
    const vis = tabs.filter((t) => !t.classList.contains("et-hidden") && t.dataset.path !== active);
    for (let i = vis.length - 1; i >= 0 && w2 > avail - reserve; i--) {
      vis[i].classList.add("et-hidden"); w2 -= widths.get(vis[i]); hidden.push(vis[i].dataset.path);
    }
  }
  if (!hidden.length) return;
  ov.classList.remove("hidden");
  ov._hidden = hidden;
  const badge = ov.querySelector(".et-badge");
  badge.textContent = String(hidden.length);
  badge.classList.remove("hidden");
}
// Bring a hidden tab into view: move it to the end of the strip so it becomes
// the last visible tab (not the first), then activate it. Since the active tab
// is always kept visible, it ends up as the rightmost visible one.
export function revealEditorTab(path) {
  const arr = state.editor.open;
  const from = arr.findIndex((f) => f.path === path);
  if (from < 0) { activateEditorFile(path); return; }
  const [it] = arr.splice(from, 1);
  arr.push(it);
  activateEditorFile(path);   // sets active + renders + persists
}
// Dropdown listing the tabs that don't fit. Each row reveals (→ last visible)
// or closes that file.
export function editorOverflowMenu(e) {
  const ov = e.currentTarget;
  closeEtMenu();
  hideContextMenu();
  const menu = h("div", { class: "et-menu" });
  document.body.append(menu);
  const position = () => {
    // Re-find the overflow button on every call — `closeEditorFile` triggers
    // a renderEditorTabs() that detaches the original `ov` reference, and a
    // detached node's getBoundingClientRect() returns all zeros, slamming the
    // menu into the top-left corner.
    const live = document.querySelector("#editorTabs .et-overflow") || ov;
    const r = live.getBoundingClientRect();
    if (!r.width && !r.height) return;   // not on screen yet — try again next frame
    menu.style.top = (r.bottom + 4) + "px";
    menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + "px";
  };
  // (re)build rows from the CURRENTLY-hidden tabs only; closing one stays open.
  function build() {
    const files = (ov._hidden || []).map((p) => state.editor.open.find((f) => f.path === p)).filter(Boolean);
    if (!files.length) { closeEtMenu(); return; }
    menu.innerHTML = "";
    for (const f of files) {
      const fm = fileMeta(f.name);
      menu.append(h("div", { class: "et-menu-row" + (f.path === state.editor.active ? " active" : ""), onclick: () => { closeEtMenu(); revealEditorTab(f.path); } },
        h("span", { class: "et-ico " + fm.cls, html: icon(fm.ic, 13) }),
        h("span", { class: "et-menu-name " + fm.cls, text: f.name, title: f.path }),
        f.dirty ? h("span", { class: "et-dirty" }) : null,
        h("button", { class: "et-menu-x", title: "Close", html: icon("close", 12), onclick: (ev) => { ev.stopPropagation(); closeEditorFile(f.path); requestAnimationFrame(() => { computeEditorOverflow(); build(); }); } })));
    }
    position();
  }
  build();
  if (!document.querySelector(".et-menu")) return;   // nothing hidden → already closed
  setTimeout(() => document.addEventListener("mousedown", etMenuOutside, true), 0);
}
export function closeEtMenu() { const m = document.querySelector(".et-menu"); if (m) m.remove(); document.removeEventListener("mousedown", etMenuOutside, true); }
export function etMenuOutside(e) { const m = document.querySelector(".et-menu"); if (m && !m.contains(e.target)) closeEtMenu(); }
// CodeMirror 6 editors, one per pane. `cm` always aliases the FOCUSED pane's
// editor so the ~100 existing `cm.*`/`stateActiveFile()` call sites keep working
// (commands act on the focused pane). The second pane only exists while split.
export let cm = null;
export const editors = [null, null];   // editors[paneIdx]

export function paneFile(idx) { const p = state.editor.panes[idx]; return p ? state.editor.open.find((f) => f.path === p) : null; }
// Build the createEditor options for a given pane. Pane-fired callbacks
// (change/cursor/scroll/save/goto) resolve THAT pane's file; command callbacks
// (quick-fix/rename/format/go-to-line) act on the focused pane via cm.
export function editorOptsFor(idx) {
  return {
    sticky: !!state.settings.editorStickyScroll,
    lint: state.settings.editorLint !== false,
    semantic: state.settings.editorSemantic !== false,
    highlight: state.settings.editorHighlight !== false,
    // Semantic diagnostics: JS/TS via the TypeScript service, everything else
    // via an LSP server (Python/Go/Rust/C++/PHP…), both in the main process.
    semanticProvider: (text) => {
      const af = paneFile(idx);
      if (!af) return Promise.resolve([]);
      const lang = (af.lang || "").toLowerCase(), root = tsRootFor(af);
      if (TS_LANGS.has(lang)) return atom.ts.diagnose(root, af.path, text).catch(() => []);
      if (LSP_EXTS.has(lang) && atom.lsp) return atom.lsp.diagnose(root, lang, af.path, text).catch(() => []);
      return Promise.resolve([]);
    },
    // On-demand language requests (completion, hover, signature, format, …).
    tsRequest: (kind, payload) => {
      const af = paneFile(idx);
      if (!af) return Promise.resolve(null);
      const lang = (af.lang || "").toLowerCase(), root = tsRootFor(af);
      if (TS_LANGS.has(lang) && atom.ts) return atom.ts.req(kind, root, af.path, payload).catch(() => null);
      if (LSP_EXTS.has(lang) && atom.lsp) return atom.lsp.req(kind, root, lang, af.path, payload).catch(() => null);
      return Promise.resolve(null);
    },
    semanticLangs: SEMANTIC_EXTS,
    onQuickFix: (from, to) => editorQuickFix(from, to),
    onRename: (pos) => editorRename(pos),
    onFormat: () => editorFormat(),
    wrap: !!state.settings.editorWordWrap,
    bracketColors: state.settings.editorBracketColors !== false,
    whitespace: !!state.settings.editorRenderWhitespace,
    inlayHints: !!state.settings.editorInlayHints,
    indentGuides: !!state.settings.editorIndentGuides,
    onGoToLine: () => editorGoToLinePrompt(),
    onDiagnostics: () => { if (idx === state.editor.focused) onEditorDiagnostics(); },
    onChange: () => onCmChange(idx),
    onCursor: (line, col) => { if (idx === state.editor.focused) scheduleCursorUI(idx, line, col); },
    onScroll: (top) => { const af = paneFile(idx); if (af) af.scrollTop = top; },
    onSave: () => { const af = paneFile(idx); if (af) saveEditorFile(af.path); },
    onGotoDef: (pos) => { const af = paneFile(idx); if (af) editorGotoDefinition(af, pos); },
    onContextMenu: (x, y) => editorCtxMenu(x, y),
  };
}
// Make pane `idx` the focused one — `cm`, the active file, the tab highlight and
// the status bar all follow it.
export function focusPane(idx) {
  if (!editors[idx]) return;
  state.editor.focused = idx;
  cm = editors[idx];
  state.editor.active = state.editor.panes[idx];
  state.findContext = "editor";
  updatePaneFocusUI();
  renderEditorTabs();
  const f = paneFile(idx); if (f) updateEditorStatus(f);
  highlightTreeFile();
  onEditorDiagnostics();
}
export function updatePaneFocusUI() {
  const body = $("editorBody");
  if (!body) return;
  [...body.querySelectorAll(".epane")].forEach((el, i) => el.classList.toggle("is-focused", state.editor.split && i === state.editor.focused));
}
// Same file in both panes ⇒ link them so edits live-sync (independent scroll/
// cursor/folds). Otherwise unlink. Docs are identical when linked, by construction.
export function relinkPanes() {
  if (editors[0] && editors[0].unlinkPeer) editors[0].unlinkPeer();
  if (editors[1] && editors[1].unlinkPeer) editors[1].unlinkPeer();
  if (state.editor.split && editors[0] && editors[1] &&
      state.editor.panes[0] && state.editor.panes[0] === state.editor.panes[1]) {
    editors[0].linkPeer(editors[1]);
    editors[1].linkPeer(editors[0]);
  }
}
// Load pane idx's target file into its editor (idempotent — tracks the loaded
// path so re-renders don't reset scroll). Restores scroll + folds.
export function loadPaneFile(idx, force) {
  const ed = editors[idx];
  if (!ed) return;
  const f = paneFile(idx);
  if (!f) { ed.setDoc("", ""); ed._loaded = null; return; }
  if (!force && ed._loaded === f.path) return;
  ed._loaded = f.path;
  // Replacing the doc ourselves (opening a file, or refreshing one the agent just
  // edited on disk) is not a user edit. Flag it so onCmChange doesn't light up the
  // tab's unsaved dot — CodeMirror reports a programmatic setDoc as a doc change
  // exactly like typing. Dispatch is synchronous, so the flag brackets it.
  _programmaticDoc++;
  try { ed.setDoc(f.content, f.lang); } finally { _programmaticDoc--; }
  requestAnimationFrame(() => { if (editors[idx] === ed) { ed.setScrollTop(f.scrollTop || 0); if (f.folds && f.folds.length) ed.setFolds(f.folds); } });
  applyEditorConfig(f, ed);
  gitGutterFor(ed, f);
  if (idx === state.editor.focused) { state.editor.diags = []; setTimeout(() => onEditorDiagnostics(), 700); scheduleSymbolRefresh(); }
}
// Build (or rebuild) the pane DOM. Existing editor .dom nodes are re-attached
// rather than recreated, so split/unsplit/orientation toggles never lose state.
export function renderEditor() {
  const body = $("editorBody");
  if (!stateActiveFile()) {
    for (let i = 0; i < 2; i++) if (editors[i]) { editors[i].destroy(); editors[i] = null; }
    cm = null; state.editor.split = false; state.editor.panes = [null, null]; state.editor.focused = 0;
    body.innerHTML = "";
    body.append(h("div", { class: "editor-empty" }, h("span", { class: "ee-mark", html: icon("fileCode", 54) }), h("p", { text: "No file open" })));
    $("editorStatus").innerHTML = "";
    return;
  }
  // Image files render in the previewer, not CodeMirror (editors are kept alive,
  // just detached, so switching back to a code file is instant).
  if (stateActiveFile().kind === "image") {
    for (const ed of editors) if (ed && ed.dom.parentNode) ed.dom.parentNode.removeChild(ed.dom);
    body.classList.remove("is-split", "split-h");
    renderImageView(body, stateActiveFile());
    renderBreadcrumbs();
    updateEditorStatus(stateActiveFile(), 1, 1);
    return;
  }
  if (!state.editor.panes[0]) state.editor.panes[0] = state.editor.active;
  // First editor surface in this session → load CodeMirror on demand, then re-render.
  if (!createEditor) {
    body.innerHTML = "";
    body.append(h("div", { class: "editor-empty" }, h("span", { class: "ee-mark spin", html: icon("spinner", 40) }), h("p", { text: "Loading editor…" })));
    ensureCmModule().then(() => { if (stateActiveFile()) renderEditor(); });
    return;
  }
  body.classList.toggle("is-split", !!state.editor.split);
  body.classList.toggle("split-h", !!state.editor.split && state.editor.splitDir === "h");
  // Detach existing editor DOM (keeps the views alive) before rebuilding hosts.
  for (const ed of editors) if (ed && ed.dom.parentNode) ed.dom.parentNode.removeChild(ed.dom);
  body.innerHTML = "";

  ensurePane(0, body);
  if (state.editor.split) {
    body.append(h("div", { class: "epane-div", title: "Drag to resize", onmousedown: startPaneResize }));
    ensurePane(1, body);
  } else if (editors[1]) {
    editors[1].destroy(); editors[1] = null; state.editor.panes[1] = null;
  }

  cm = editors[state.editor.focused] || editors[0];
  updatePaneFocusUI();
  relinkPanes();
  for (const ed of editors) if (ed) ed.remeasure();
  const ff = paneFile(state.editor.focused); if (ff) updateEditorStatus(ff);
  renderMarkdownPreview();   // sync/remove the md overlay for the active file
}
// Create pane idx's editor inside a fresh host (or re-attach the existing one).
export function ensurePane(idx, body) {
  const host = h("div", { class: "epane" + (state.editor.split && idx === state.editor.focused ? " is-focused" : "") });
  body.append(host);
  if (!editors[idx]) {
    const f = paneFile(idx) || stateActiveFile();
    editors[idx] = createEditor(host, Object.assign(editorOptsFor(idx), { doc: (f && f.content) || "", lang: (f && f.lang) || "" }));
    editors[idx]._loaded = f ? f.path : null;
    editors[idx].view.contentDOM.addEventListener("focus", () => focusPane(idx));
    loadPaneFile(idx, true);
  } else {
    host.append(editors[idx].dom);
    loadPaneFile(idx);
    const f = paneFile(idx);   // re-attaching the DOM can reset scroll — restore it
    if (f) requestAnimationFrame(() => { if (editors[idx]) editors[idx].setScrollTop(f.scrollTop || 0); });
  }
}
// Render an image file in #editorBody (data URL from main; capped size).
export async function renderImageView(body, f) {
  body.innerHTML = "";
  const img = h("img", { class: "img-preview", alt: f.name });
  const meta = h("div", { class: "img-meta", text: "Loading…" });
  body.append(h("div", { class: "img-view" }, img, meta));
  const d = await atom.files.dataUrl(f.path).catch(() => null);
  if (stateActiveFile() !== f) return;   // switched away while loading
  if (d && d.dataUrl) {
    img.src = d.dataUrl;
    img.onload = () => { meta.textContent = `${img.naturalWidth} × ${img.naturalHeight}  ·  ${(d.size / 1024).toFixed(1)} KB`; };
  } else { meta.textContent = "Can't preview this image (too large or unreadable)."; }
}
// Markdown preview overlay (Ctrl+Shift+V) — rendered HTML over the editor body.
export function toggleMarkdownPreview() {
  const f = stateActiveFile();
  if (!f || !MD_EXTS.has((f.lang || "").toLowerCase())) return;
  state.editor.mdPreview = !state.editor.mdPreview;
  renderMarkdownPreview();
  renderEditorTabs();
}
export function renderMarkdownPreview() {
  const body = $("editorBody");
  if (!body) return;
  let layer = document.getElementById("mdPreview");
  const f = stateActiveFile();
  const on = state.editor.mdPreview && f && MD_EXTS.has((f.lang || "").toLowerCase());
  if (!on) { if (layer) layer.remove(); return; }
  if (!layer) {
    layer = h("div", { id: "mdPreview", class: "md-preview" });
    layer.addEventListener("click", onMdPreviewClick);
    layer.addEventListener("contextmenu", onMdPreviewContext);
    body.appendChild(layer);
  }
  const text = (cm && cm.docText()) || f.content || "";
  // This re-renders on every keystroke; without this the reader is thrown back
  // to the top of the document each time a character is typed.
  const keepScroll = layer.scrollTop;
  layer.innerHTML = "";
  /* `bubble` is the class the conversation renders markdown into. Sharing it is
   * the point: the preview then cannot drift from how the agent panel looks, and
   * it is also what makes the text selectable — the app sets user-select:none
   * globally and .bubble is where that is deliberately turned back on. */
  const doc = h("div", { class: "md-preview-body bubble", html: renderMarkdown(text, { images: true, localLinks: true }) });
  layer.append(mdPreviewBar(f, text), doc);
  resolveMdImages(doc, mdBaseDir(f));
  layer.scrollTop = keepScroll;
}
// The folder a preview's relative links and images resolve against.
export function mdBaseDir(f) {
  if (!f || f.untitled) return state.project || "";
  return f.path.replace(/[\\/][^\\/]*$/, "");
}
export function mdResolve(base, rel) {
  const r = String(rel || "").replace(/^\.\//, "");
  if (/^[a-zA-Z]:[\\/]/.test(r) || r.startsWith("/")) return r;   // already absolute
  let dir = base;
  let rest = r;
  while (/^\.\.[\\/]/.test(rest)) { dir = dir.replace(/[\\/][^\\/]*$/, ""); rest = rest.slice(3); }
  return dir ? dir + "\\" + rest.replace(/\//g, "\\") : rest;
}
/* A relative <img> can't resolve against the app's own URL, so each one is read
 * off disk and inlined. Failures are left showing their alt text rather than a
 * broken-image icon — a missing asset is the document's problem to show, not an
 * error to interrupt the reader with. */
export function resolveMdImages(host, base) {
  for (const img of host.querySelectorAll("img[data-rel]")) {
    const abs = mdResolve(base, img.dataset.rel);
    atom.files.dataUrl(abs)
      .then((d) => { if (d && d.dataUrl) img.src = d.dataUrl; else img.classList.add("missing"); })
      .catch(() => img.classList.add("missing"));
  }
}
/* The preview is a document, so it gets a document's affordances: its name, a
 * copy of the whole thing, and a way back to the source. */
export function mdPreviewBar(f, text) {
  return h("div", { class: "mdp-bar" },
    h("span", { class: "mdp-ico", html: icon("eye", 13) }),
    h("span", { class: "mdp-name", text: f.name }),
    h("span", { class: "mdp-spacer" }),
    h("button", { class: "mdp-act", title: "Copy the whole document as Markdown", onclick: () => copyText(text, "Markdown copied", mdToRichHtml(text)) },
      h("span", { html: icon("copy", 13) }), h("span", { text: "Copy" })),
    h("button", { class: "mdp-act", title: "Back to the source (Ctrl+Shift+V)", onclick: () => toggleMarkdownPreview() },
      h("span", { html: icon("close", 13) })));
}
export function onMdPreviewClick(e) {
  const copyBtn = e.target.closest(".codeblock-copy");
  if (copyBtn) {
    const code = copyBtn.closest(".codeblock").querySelector("code");
    copyText(code ? code.textContent : "", "Code copied");
    return;
  }
  // A path-shaped inline code span is a real file here, so it opens one.
  const fp = e.target.closest(".md-fp");
  if (fp && fp.dataset.fp) {
    const cur = stateActiveFile();
    openInEditor(mdResolve(mdBaseDir(cur), fp.dataset.fp));
    return;
  }
  const link = e.target.closest(".md-link");
  if (!link) return;
  e.preventDefault();
  const href = link.dataset.href || "";
  if (/^https?:/i.test(href)) { atom.shell.openExternal(href); return; }
  if (href.startsWith("#")) {
    const target = document.getElementById(href.slice(1));
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (/^mailto:/i.test(href)) { atom.shell.openExternal(href); return; }
  // A relative link points at a file sitting next to this one — open it.
  const f = stateActiveFile();
  openInEditor(mdResolve(mdBaseDir(f), href.replace(/#.*$/, "")));
}
// Same right-click copy the conversation offers — a preview you can't quote from
// is a screenshot.
export function onMdPreviewContext(e) {
  const sel = (window.getSelection && String(window.getSelection())) || "";
  const f = stateActiveFile();
  const items = [];
  if (sel.trim()) {
    const selHtml = selectionHtml();
    items.push({ label: "Copy", icon: "copy", onClick: () => copyText(sel, "Copied", selHtml ? styleRichHtml(selHtml) : null) });
  }
  if (f) {
    const text = (cm && cm.docText()) || f.content || "";
    items.push({ label: sel.trim() ? "Copy whole document" : "Copy document", icon: "copy", onClick: () => copyText(text, "Markdown copied", mdToRichHtml(text)) });
    items.push({ sep: true });
    items.push({ label: "Back to source", icon: "fileCode", onClick: () => toggleMarkdownPreview() });
  }
  if (!items.length) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, items);
}
/* ---- split controls ---- */
export function toggleSplit() {
  if (!stateActiveFile()) return;
  if (state.editor.split) { closeSplit(); return; }
  syncFileContent(paneFile(0), editors[0]);        // pane 1 loads from f.content — make it current
  state.editor.split = true;
  state.editor.panes[1] = state.editor.panes[0];   // duplicate focused file → same-file live split
  renderEditor();
  persistEditor();
}
export function closeSplit() {
  if (!state.editor.split) return;
  state.editor.split = false;
  if (editors[1]) { editors[1].destroy(); editors[1] = null; }
  state.editor.panes[1] = null;
  state.editor.focused = 0;
  cm = editors[0];
  renderEditor();
  persistEditor();
}
export function toggleSplitOrientation() {
  if (!state.editor.split) return;
  state.editor.splitDir = state.editor.splitDir === "h" ? "v" : "h";
  $("editorBody").style.removeProperty("--epane0");   // reset any drag-set sizing
  renderEditor();
  persistEditor();
}
// Drag the divider to resize the two panes (flex-basis on the first pane).
export function startPaneResize(e) {
  e.preventDefault();
  const body = $("editorBody");
  const horiz = state.editor.splitDir === "h";
  const rect = body.getBoundingClientRect();
  const onMove = (ev) => {
    const frac = horiz ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
    const pct = Math.max(0.15, Math.min(0.85, frac)) * 100;
    body.style.setProperty("--epane0", pct + "%");
    for (const ed of editors) if (ed) ed.remeasure();
  };
  const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); document.body.style.userSelect = ""; };
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
// Resolve .editorconfig for a file (cached) and apply its indent settings to the
// given editor (defaults to the focused pane).
export async function applyEditorConfig(f, ed) {
  if (!atom.editorconfig) return;
  if (f.ec === undefined) { try { f.ec = (await atom.editorconfig(f.path)) || {}; } catch { f.ec = {}; } }
  ed = ed || cm;
  if (!ed) return;
  const ec = f.ec || {};
  if (ec.indent_style === "tab") ed.setIndent(+(ec.tab_width || (ec.indent_size !== "tab" && ec.indent_size) || 4), true);
  else if (ec.indent_size && ec.indent_size !== "tab") ed.setIndent(+ec.indent_size, false);
  else ed.setIndent(2, false);
  // .editorconfig end_of_line wins over the detected EOL (only crlf/lf are written).
  if ((ec.end_of_line === "crlf" || ec.end_of_line === "lf") && f.eol !== ec.end_of_line) { f.eol = ec.end_of_line; if (stateActiveFile() === f) updateEditorStatus(f); }
}
// Pull the live editor text into the file record — called lazily (save, pane
// switch, search) instead of on every keystroke, so typing never pays O(n).
export function syncFileContent(f, ed) {
  if (!f || !ed || !f._stale) return;
  f.content = ed.docText();
  f._stale = false;
}
export let autoSaveTimer = null;
// >0 while WE replace an editor's document (file open / disk refresh after the
// agent edited it). Only edits made outside this window are the user's.
export let _programmaticDoc = 0;
export function onCmChange(idx) {
  const f = (idx == null) ? stateActiveFile() : paneFile(idx);
  if (!f) return;
  const ed = (idx == null) ? cm : editors[idx];
  // Programmatic load: the doc was set FROM f.content, so nothing is stale and the
  // unsaved state is exactly "does the buffer differ from what's on disk". Compare
  // directly instead of falling through to the heuristic below, which assumes any
  // change is the user's and marks big docs dirty outright — that's what made the
  // agent's file edits show a pending-change dot on the tab.
  if (_programmaticDoc) {
    f._stale = false;
    const pending = f.content !== f.saved;
    if (pending !== f.dirty) { f.dirty = pending; renderEditorTabs(); updateEditorStatus(f); }
    return;
  }
  f._stale = true;   // f.content is now behind the editor; sync lazily
  // Dirty check without building the full doc string: any change marks dirty;
  // small docs get the exact "undo back to saved" check, big docs stay dirty.
  let dirty = true;
  const len = ed ? ed.view.state.doc.length : -1;
  if (ed && len === f.saved.length && len < 262_144) {
    dirty = ed.docText() !== f.saved;
    if (!dirty) { f.content = f.saved; f._stale = false; }
  }
  if (dirty !== f.dirty) { f.dirty = dirty; renderEditorTabs(); updateEditorStatus(f); }
  if (idx == null || idx === state.editor.focused) { scheduleSymbolRefresh(); if (state.editor.mdPreview) renderMarkdownPreview(); }
  // Auto-save can't apply to a buffer with no path — it would throw a file picker
  // in the user's face 1.2s after they started typing.
  if (dirty && state.settings.editorAutoSave && !f.untitled) {
    const target = f.path;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => { autoSaveTimer = null; const af = stateActiveFile(); if (af && af.path === target && af.dirty) saveEditorFile(target); }, 1200);
  }
}
// Cursor-driven UI (status bar + breadcrumbs) coalesced to one update per frame —
// rebuilding them per keypress/cursor-move costs DOM churn on every keystroke.
export let _cursorRaf = 0, _cursorArgs = null;
export function scheduleCursorUI(idx, line, col) {
  _cursorArgs = { idx, line, col };
  if (_cursorRaf) return;
  _cursorRaf = requestAnimationFrame(() => {
    _cursorRaf = 0;
    const a = _cursorArgs;
    if (!a || a.idx !== state.editor.focused) return;
    const af = paneFile(a.idx);
    if (af) updateEditorStatus(af, a.line, a.col);
    updateBreadcrumbsCursor();
  });
}
// Flip a file's line-ending style (LF ⇄ CRLF). Persisted on next save.
export function toggleEditorEol(f) {
  if (!f) return;
  f.eol = (f.eol === "crlf") ? "lf" : "crlf";
  f.dirty = true;   // an EOL change is itself a pending write
  renderEditorTabs(); updateEditorStatus(f);
}
/* ---- editor context menu (CM6) ---- */
export function editorCtxMenu(x, y) {
  if (!cm) return;
  const hasSel = !cm.selection().empty;
  const f = stateActiveFile();
  const lang = f ? (f.lang || "").toLowerCase() : "";
  const semantic = TS_LANGS.has(lang) || LSP_EXTS.has(lang);
  showContextMenu(x, y, [
    ...(semantic ? [
      { label: "Go to definition", icon: "external", onClick: () => { const af = stateActiveFile(); if (af && cm) editorGotoDefinition(af, cm.cursor()); } },
      { label: "Find all references", icon: "gitCompare", onClick: () => editorFindReferences() },
      { label: "Go to symbol…", icon: "list", onClick: () => openSymbolPicker() },
      { sep: true },
    ] : []),
    { label: "Cut", icon: "cut", onClick: cmCut },
    { label: "Copy", icon: "copy", onClick: cmCopy },
    { label: "Paste", icon: "paste", onClick: cmPaste },
    { sep: true },
    { label: "Select all", icon: "list", onClick: () => cm.selectAll() },
    { sep: true },
    { label: hasSel ? "Upper case" : "Upper case line", icon: "caseUpper", onClick: () => cmCase(true) },
    { label: hasSel ? "Lower case" : "Lower case line", icon: "caseLower", onClick: () => cmCase(false) },
    { sep: true },
    { label: "Sort lines A→Z", icon: "list", onClick: () => cm.sortLines(false) },
    { label: "Sort lines Z→A", icon: "list", onClick: () => cm.sortLines(true) },
    { label: "Join lines", icon: "merge", onClick: () => cm.joinLines() },
  ]);
}
// Copy/Cut/case fall back to the current line when there's no selection (VS Code-style).
export function cmRange() { const s = cm.selection(); return s.empty ? cm.lineRangeAt(cm.cursor()) : { from: s.from, to: s.to, text: s.text }; }
export async function cmCopy() { const r = cmRange(); if (r.text) { await atom.clipboard.write(r.text); toast("Copied", "copy"); } }
export async function cmCut() { const r = cmRange(); if (!r.text) return; await atom.clipboard.write(r.text); cm.replaceRange(r.from, r.to, ""); }
export async function cmPaste() { const text = await atom.clipboard.read().catch(() => ""); if (text == null || text === "") return; const s = cm.selection(); cm.replaceRange(s.from, s.to, text); }
export function cmCase(upper) {
  const r = cmRange();
  const out = upper ? r.text.toUpperCase() : r.text.toLowerCase();
  if (!r.text || out === r.text) return;
  cm.replaceRange(r.from, r.to, out);
  cm.selectRange(r.from, r.from + out.length);
}
/* ---- Ctrl/Cmd-click go-to-definition (js · ts · python · json) ---- */
export const GOTODEF_LANGS = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "python", "json"]);
export function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// The identifier token under an offset (word chars + $).
export function identAt(text, pos) {
  const isW = (ch) => ch != null && /[A-Za-z0-9_$]/.test(ch);
  let i = pos;
  if (!isW(text[i]) && isW(text[i - 1])) i--;
  if (!isW(text[i])) return "";
  let s = i, e = i;
  while (s > 0 && isW(text[s - 1])) s--;
  while (e < text.length && isW(text[e])) e++;
  return text.slice(s, e);
}
// If the column sits inside a quoted string on this line, return its contents.
export function quotedStringAt(line, col) {
  const re = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(line))) {
    const inner = m.index + 1, end = m.index + m[0].length - 1;
    if (col >= inner && col <= end) return m[2];
  }
  return null;
}
// Regex(es) that mark a definition of `word` for the language.
export function defRegexes(word, lang) {
  const W = escRe(word);
  if (lang === "py" || lang === "python") return [new RegExp(`\\bdef\\s+${W}\\b`), new RegExp(`\\bclass\\s+${W}\\b`), new RegExp(`^\\s*${W}\\s*=`)];
  return [
    new RegExp(`\\b(?:function|class)\\s+${W}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${W}\\b`),
    new RegExp(`\\b${W}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\(|[\\w$]+\\s*=>)`),
    new RegExp(`\\b${W}\\s*\\([^)]*\\)\\s*\\{`),
  ];
}
// Find a definition of `word` in `text`; return the offset of `word`, or -1.
export function findDefinition(text, word, lang, skipLineStart) {
  if (lang === "json") return -1;
  const res = defRegexes(word, lang);
  const lines = text.split("\n");
  let off = 0, fallback = -1;
  for (const ln of lines) {
    if (res.some((r) => r.test(ln))) {
      const idx = ln.indexOf(word);
      const at = off + (idx >= 0 ? idx : 0);
      if (off !== skipLineStart) return at;   // prefer a line other than where you clicked
      fallback = at;
    }
    off += ln.length + 1;
  }
  return fallback;
}
export async function editorGotoOffset(filePath, offset, len) {
  if (state.editor.active !== filePath) await openInEditor(filePath);
  requestAnimationFrame(() => { if (cm) cm.gotoOffset(offset, len); });
}
export function editorGotoDefinition(f, pos) {
  const lang = (f.lang || "").toLowerCase();
  if (!GOTODEF_LANGS.has(lang) && !LSP_EXTS.has(lang)) return;
  navMark();   // record where we jumped FROM so Alt+Left returns here
  // CM6's document is the source of truth — `pos` is an offset into it, so
  // resolve everything against cm.docText() (consistent line endings).
  const text = (cm && cm.docText()) || f.content || "";
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = text.indexOf("\n", pos); if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  const col = pos - lineStart;

  // 1) import/require path, or a relative path string (also JSON)
  const q = quotedStringAt(line, col);
  if (q && (/\b(?:import|require|from|export)\b/.test(line) || lang === "json" || /^[./]/.test(q))) {
    const rel = /^[./]/.test(q);
    // Non-relative specifiers can be tsconfig `paths` aliases (@/utils/x) — the TS
    // service resolves those exactly; only call it a real external module if it can't.
    if (!rel && TS_LANGS.has(lang) && atom.ts) {
      atom.ts.req("definition", tsRootFor(f), f.path, { text, pos })
        .then((d) => {
          if (d && d.file && !/[\\/]node_modules[\\/]/.test(d.file)) editorGotoOffset(d.file, d.start, d.length);
          else toast(`External module “${q}”`, "globe");
        })
        .catch(() => toast(`External module “${q}”`, "globe"));
      return;
    }
    if (rel) {
      atom.files.resolveImport(f.path, q).then((p) => {
        if (p) openInEditor(p);
        else toast(`Can't find “${q}”`, "alert");
      });
    } else {
      toast(`External module “${q}”`, "globe");
    }
    return;
  }
  if (lang === "json") return;   // no symbol resolution in JSON

  const root = tsRootFor(f);
  // Heuristic fallback: this-file symbol, then a fast project-wide source search.
  const heuristic = () => {
    const word = identAt(text, pos);
    if (!word) return;
    const localOff = findDefinition(text, word, lang, lineStart);
    if (localOff >= 0) { editorGotoOffset(f.path, localOff, word.length); return; }
    atom.files.findDefinition(root, word, lang).then((hit) => {
      if (hit && hit.path) editorGoToLine(hit.path, hit.line, word, true);
      else toast(`No definition found for “${word}”`, "search");
    }).catch(() => toast(`No definition found for “${word}”`, "search"));
  };

  // 2) JS/TS: ask the TypeScript service for an exact, cross-file definition first.
  if (TS_LANGS.has(lang) && atom.ts) {
    atom.ts.req("definition", root, f.path, { text, pos })
      .then((d) => { if (d && d.file) editorGotoOffset(d.file, d.start, d.length); else heuristic(); })
      .catch(heuristic);
    return;
  }
  // 2b) LSP languages: ask the language server (returns file + line/col).
  if (LSP_EXTS.has(lang) && atom.lsp) {
    atom.lsp.req("definition", root, lang, f.path, { text, pos })
      .then((d) => { if (d && d.file) { openInEditor(d.file).then(() => { if (cm) cm.gotoLine(d.line, d.col); }); } else heuristic(); })
      .catch(heuristic);
    return;
  }
  heuristic();
}
export const TS_LANGS = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"]);
export const LSP_EXTS = new Set();                         // file exts with an LSP server (filled at startup)
export const SEMANTIC_EXTS = new Set(TS_LANGS);            // union of TS + LSP exts → gates the editor's semantic features
// Discover available LSP servers and live-update diagnostics they push.
export function setupLsp() {
  if (!atom.lsp) return;
  const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
  atom.lsp.langs().then((list) => { for (const e of (list || [])) { LSP_EXTS.add(e); SEMANTIC_EXTS.add(e); } }).catch(() => {});
  atom.lsp.onDiagnostics(({ file }) => {
    const af = stateActiveFile();
    if (af && cm && file && norm(af.path) === norm(file)) { cm.forceRelint(); setTimeout(onEditorDiagnostics, 250); }
  });
}
// Format the active file: TypeScript service for JS/TS, Prettier for
// JSON/CSS/HTML/Markdown/YAML/…, an LSP server otherwise.
export const PRETTIER_LANGS = new Set(["json", "jsonc", "json5", "webmanifest", "css", "scss", "less", "html", "htm", "xhtml", "vue", "md", "markdown", "mdx", "yaml", "yml", "graphql", "gql"]);
export async function editorFormat() {
  const f = stateActiveFile();
  if (!f || !cm) return false;
  const lang = (f.lang || "").toLowerCase(), root = tsRootFor(f), text = cm.docText();
  try {
    if (TS_LANGS.has(lang) && atom.ts) { const edits = await atom.ts.req("format", root, f.path, { text }); if (edits && edits.length) { cm.applyEdits(edits); return true; } return false; }
    if (PRETTIER_LANGS.has(lang) && atom.prettier) { const out = await atom.prettier.format(text, lang, 2); if (out != null && out !== text) { cm.applyEdits([{ from: 0, to: text.length, text: out }]); return true; } return false; }
    if (LSP_EXTS.has(lang) && atom.lsp) { const edits = await atom.lsp.req("format", root, lang, f.path, { text }); if (edits && edits.length) { cm.applyEdits(edits); return true; } return false; }
  } catch { /* ignore */ }
  return false;
}
export function tsRootFor(f) {
  const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
  let root = state.project || "";
  if (!root || !norm(f.path).startsWith(norm(root))) root = f.path.replace(/[\\/][^\\/]*$/, "");
  return root;
}
/* ---- git gutter: parse a `git diff HEAD` into per-line add/change/del marks ---- */
export function parseDiffToGutter(text) {
  const marks = [];
  let newLine = 0, inHunk = false, pendingDel = 0;
  for (const ln of (text || "").split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
    if (m) { if (pendingDel > 0 && newLine > 0) marks.push({ line: Math.max(1, newLine - 1), type: "del" }); newLine = +m[1]; inHunk = true; pendingDel = 0; continue; }
    if (!inHunk) continue;
    const c = ln[0];
    if (c === "+") { marks.push({ line: newLine, type: pendingDel > 0 ? "change" : "add" }); if (pendingDel > 0) pendingDel--; newLine++; }
    else if (c === "-") { pendingDel++; }
    else if (c === "\\") { /* "\ No newline at end of file" */ }
    else { if (pendingDel > 0) { marks.push({ line: Math.max(1, newLine - 1), type: "del" }); pendingDel = 0; } newLine++; }
  }
  if (pendingDel > 0 && newLine > 0) marks.push({ line: Math.max(1, newLine - 1), type: "del" });
  return marks;
}
export async function gitGutterFor(ed, f) {
  if (!ed || !f || !ed.setGitGutter) return;
  let cwd = null;
  try { cwd = await atom.git.repoForFile(f.path); } catch { /* ignore */ }
  if (!cwd) { ed.setGitGutter([]); return; }
  try { const d = await atom.git.fileDiff(cwd, f.path); ed.setGitGutter(parseDiffToGutter((d && d.text) || "")); }
  catch { ed.setGitGutter([]); }
}
export function gitGutterRefreshAll() { for (let i = 0; i < 2; i++) if (editors[i]) gitGutterFor(editors[i], paneFile(i)); }
