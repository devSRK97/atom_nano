/* AtomNano renderer — Document symbols — outline, breadcrumbs, go-to-symbol.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { openChatSearch } from "../chat/navigation.js";
import { $, baseName, closeModal, copyText, h, modalShell, promptDialog, relPath, showContextMenu, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { changeEditorZoom } from "../core/theme.js";
import { refreshGit, scheduleGitRefresh } from "../git/sidebar.js";
import { gitProjectRoot } from "../git/titlebar.js";
import { icon } from "../icons.js";
import { persistEditor } from "../workspace/projects.js";
import { highlightTreeFile, refreshTree } from "../workspace/sidebar.js";
import { openCheckpoints } from "./checkpoints.js";
import { LSP_EXTS, TS_LANGS, cm, editors, gitGutterRefreshAll, openInEditor, promptWriteBufferTo, renderEditorTabs, saveEditorAs, stateActiveFile, syncFileContent, toggleEditorEol, tsRootFor, updateEditorLayout } from "./editor-pane.js";
import { openSearch } from "./search-palette.js";

/* ============================================================
   NAVIGATION — document symbols (outline / breadcrumbs / go-to-symbol)
   ============================================================ */
export const SYMBOL_LANGS = () => new Set([...TS_LANGS, ...LSP_EXTS]);
// Map TS/LSP symbol-kind strings to an icon + a CSS class for colouring.
export const SYM_ICON = { class: "box", interface: "box", "type-parameter": "box", struct: "box", enum: "list", "enum-member": "dot", method: "sparkle", function: "sparkle", constructor: "sparkle", property: "dot", field: "dot", variable: "dot", constant: "dot", module: "folder", namespace: "folder", "var": "dot", "let": "dot", "const": "dot", alias: "box", parameter: "dot" };
export const symIcon = (k) => SYM_ICON[(k || "").toLowerCase()] || "dot";
export let _symCache = { path: null, token: 0, symbols: [] };
export let _symFetchTimer = null;
export async function fetchEditorSymbols() {
  const f = stateActiveFile();
  if (!f) return [];
  const lang = (f.lang || "").toLowerCase(), root = tsRootFor(f), text = (cm && cm.docText()) || f.content || "";
  try {
    if (TS_LANGS.has(lang) && atom.ts) return (await atom.ts.req("documentSymbols", root, f.path, { text })) || [];
    if (LSP_EXTS.has(lang) && atom.lsp) return (await atom.lsp.req("documentSymbols", root, lang, f.path, { text })) || [];
  } catch { /* ignore */ }
  return [];
}
// Refresh the symbol cache for the active file (debounced), then redraw breadcrumbs.
export function scheduleSymbolRefresh() {
  clearTimeout(_symFetchTimer);
  const f = stateActiveFile();
  if (!f || !SYMBOL_LANGS().has((f.lang || "").toLowerCase())) { _symCache = { path: f ? f.path : null, token: 0, symbols: [] }; renderBreadcrumbs(); return; }
  // Each refetch ships the full document over IPC — debounce harder on big files.
  const delay = (cm && cm.view.state.doc.length > 300_000) ? 2000 : 500;
  _symFetchTimer = setTimeout(async () => {
    const path = f.path;
    const symbols = await fetchEditorSymbols();
    if (stateActiveFile() && stateActiveFile().path === path) { _symCache = { path, token: 0, symbols }; renderBreadcrumbs(); }
  }, delay);
}
// Symbols whose range encloses `pos`, outermost-first → the breadcrumb chain.
export function symbolChainAt(pos) {
  return (_symCache.symbols || []).filter((s) => s.from <= pos && pos <= s.to).sort((a, b) => a.from - b.from || b.to - a.to);
}
export function renderBreadcrumbs() {
  const bar = $("editorBreadcrumbs");
  if (!bar) return;
  const f = stateActiveFile();
  const symsSupported = f && SYMBOL_LANGS().has((f.lang || "").toLowerCase());
  if (!f || !symsSupported || !(_symCache.symbols && _symCache.symbols.length)) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  bar.classList.remove("hidden");
  bar.innerHTML = "";
  // path crumb (opens the symbol picker) + the enclosing symbol chain
  const pos = cm ? cm.cursor() : 0;
  const chain = symbolChainAt(pos);
  const seg = (label, ic, onclick, cls) => h("button", { class: "bc-seg" + (cls ? " " + cls : ""), onclick }, ic ? h("span", { class: "bc-ic", html: icon(ic, 13) }) : null, h("span", { text: label }));
  bar.append(seg(f.name, "fileCode", () => openSymbolPicker(), "bc-file"));
  for (const s of chain) {
    bar.append(h("span", { class: "bc-sep", html: icon("chevron", 12) }));
    bar.append(seg(s.name, symIcon(s.kind), () => jumpTo(f.path, s.from)));
  }
}
export function updateBreadcrumbsCursor() { if (!$("editorBreadcrumbs").classList.contains("hidden")) renderBreadcrumbs(); }
// Ctrl+Shift+O — fuzzy go-to-symbol over the active file's document symbols.
export async function openSymbolPicker() {
  const f = stateActiveFile();
  if (!f) return;
  let symbols = _symCache.path === f.path ? _symCache.symbols : null;
  const input = h("input", { placeholder: "Go to symbol…  (type to filter)", spellcheck: "false" });
  const results = h("div", { class: "search-results" });
  const summary = h("div", { class: "search-summary" });
  const body = h("div", {}, h("div", { class: "search-input-row" }, h("div", { class: "si-wrap" }, h("span", { html: icon("list", 16) }), input)), summary, results);
  const back = modalShell({ title: "Go to symbol", ic: "list", wide: true, body });
  back.querySelector(".modal").classList.add("search-modal");
  setTimeout(() => input.focus(), 40);

  let sel = 0, filtered = [];
  function draw() {
    const q = input.value.trim().toLowerCase();
    filtered = (symbols || []).filter((s) => !q || s.name.toLowerCase().includes(q));
    summary.textContent = symbols == null ? "Loading symbols…" : `${filtered.length} symbol${filtered.length !== 1 ? "s" : ""}`;
    results.innerHTML = "";
    if (!filtered.length) { results.append(h("div", { class: "search-empty", text: symbols == null ? "…" : "No symbols." })); return; }
    sel = Math.max(0, Math.min(sel, filtered.length - 1));
    filtered.slice(0, 500).forEach((s, i) => {
      results.append(h("div", { class: "sr-name-row sym-row" + (i === sel ? " active" : ""), style: `padding-left:${8 + (s.depth || 0) * 14}px`, onclick: () => pick(s) },
        h("span", { class: "sym-ic sym-" + (s.kind || "").toLowerCase().replace(/[^a-z]/g, ""), html: icon(symIcon(s.kind), 14) }),
        h("span", { class: "srn-name", text: s.name }), h("span", { class: "srn-path", text: s.kind || "" })));
    });
  }
  function pick(s) { closeModal(back); jumpTo(f.path, s.from); }
  input.addEventListener("input", () => { sel = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closeModal(back);
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); draw(); scrollSel(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); scrollSel(); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[sel]) pick(filtered[sel]); }
  });
  function scrollSel() { const el = results.querySelector(".sym-row.active"); if (el) el.scrollIntoView({ block: "nearest" }); }
  draw();
  if (symbols == null) { symbols = await fetchEditorSymbols(); draw(); }
}
export function applyEditsToString(s, edits) {
  for (const e of [...edits].sort((a, b) => b.from - a.from)) s = s.slice(0, e.from) + (e.text || "") + s.slice(e.to);
  return s;
}
// Apply TS FileTextChanges: the active file goes through the editor (undoable);
// other files are read, edited by offset and written back.
export async function applyTsFileChanges(changes, activePath) {
  const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
  let n = 0;
  for (const fc of (changes || [])) {
    if (norm(fc.fileName) === norm(activePath) && cm) cm.applyEdits(fc.edits);
    else { try { const data = await atom.files.read(fc.fileName); await atom.files.write(fc.fileName, applyEditsToString((data.content || "").replace(/\r\n/g, "\n"), fc.edits)); } catch { /* ignore */ } }
    n++;
  }
  if (n) { toast("Applied fix", "checkCircle", { ms: 1600 }); if (state.sidebarView === "git") refreshGit(); refreshTree(true); }
}
// Quick fixes / code actions (Ctrl+.) — TS code fixes + organize imports.
export async function editorQuickFix(from, to) {
  const f = stateActiveFile();
  if (!f || !atom.ts || !TS_LANGS.has((f.lang || "").toLowerCase())) return;
  const text = (cm && cm.docText()) || f.content || "";
  let fixes = null;
  try { fixes = await atom.ts.req("codeFixes", tsRootFor(f), f.path, { text, start: from, end: to }); } catch { /* ignore */ }
  if (!fixes || !fixes.length) { toast("No quick fixes here", "check", { ms: 1800 }); return; }
  const c = cm && cm.coordsAtPos(from);
  showContextMenu(c ? c.left : 240, c ? c.bottom + 4 : 240,
    fixes.map((fx) => ({ label: (fx.description || "Fix").slice(0, 70), icon: fx.fixName === "organizeImports" ? "list" : "sparkle", onClick: () => applyTsFileChanges(fx.changes, f.path) })));
}
// Rename symbol (F2) — project-wide, across files.
export async function editorRename(pos) {
  const f = stateActiveFile();
  if (!f || !atom.ts || !TS_LANGS.has((f.lang || "").toLowerCase())) return;
  const text = (cm && cm.docText()) || f.content || "";
  let info = null;
  try { info = await atom.ts.req("rename", tsRootFor(f), f.path, { text, pos }); } catch { /* ignore */ }
  if (!info || !info.files || !Object.keys(info.files).length) { toast("Can’t rename this symbol", "alert", { ms: 2500 }); return; }
  const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
  const activeKey = Object.keys(info.files).find((k) => norm(k) === norm(f.path));
  const locs = (activeKey && info.files[activeKey]) || [];
  const cur = locs.length && cm ? cm.slice(locs[0].from, locs[0].to) : "";
  promptDialog({
    title: "Rename symbol", ic: "pencil", value: cur, placeholder: "New name", confirmLabel: "Rename",
    onConfirm: async (newName) => {
      newName = (newName || "").trim();
      if (!newName || newName === cur) return;
      let files = 0, total = 0;
      for (const [fname, ls] of Object.entries(info.files)) {
        const edits = ls.map((l) => ({ from: l.from, to: l.to, text: (l.prefix || "") + newName + (l.suffix || "") }));
        if (norm(fname) === norm(f.path) && cm) cm.applyEdits(edits);
        else { try { const data = await atom.files.read(fname); await atom.files.write(fname, applyEditsToString((data.content || "").replace(/\r\n/g, "\n"), edits)); } catch { /* ignore */ } }
        files++; total += edits.length;
      }
      toast(`Renamed ${total} occurrence${total === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`, "checkCircle", { ms: 3500 });
      if (state.sidebarView === "git") refreshGit();
      refreshTree(true);
    },
  });
}
export function updateEditorStatus(f, line, col) {
  const bar = $("editorStatus");
  if (!bar || !f) return;
  if (line == null) {
    // No caret info supplied — read it from the live editor (or default to 1,1).
    if (cm) { const pos = cm.cursor(); line = cm.lineOf(pos); col = pos - cm.lineRangeAt(pos).from + 1; }
    else { line = 1; col = 1; }
  }
  bar.innerHTML = "";
  bar.append(
    h("span", { text: (f.lang || "text").toUpperCase() }),
    h("span", { text: `Ln ${line}, Col ${col}` }),
    h("span", { class: "es-eol", title: "Line endings — click to toggle", text: (f.eol || "lf").toUpperCase(), onclick: () => toggleEditorEol(f) }),
    problemsBadge(),
    h("span", { class: "es-spacer" }),
    h("div", { class: "es-zoom" },
      h("button", { title: "Zoom out (Ctrl+-)", text: "−", onclick: () => changeEditorZoom(-1) }),
      h("span", { class: "es-zlabel", title: "Reset zoom (Ctrl+0)", text: (state.editor.fontSize || 13) + "px", onclick: () => changeEditorZoom(0) }),
      h("button", { title: "Zoom in (Ctrl+=)", text: "+", onclick: () => changeEditorZoom(1) })),
    h("span", { class: "es-cp", title: "Checkpoints — snapshot/restore (auto-saved before each agent run)", onclick: () => openCheckpoints() }, h("span", { html: icon("history", 12) }), h("span", { text: (state.checkpoints && state.checkpoints.length) ? String(state.checkpoints.length) : "" })),
    f.dirty ? h("span", { class: "es-dirty", text: "● unsaved" }) : h("span", { text: "saved" }),
    h("span", { class: "es-save", text: "Save (Ctrl+S)", onclick: () => saveEditorFile(f.path) }));
}
// ---- Problems panel + go-to-line (Editor UX) ----
export function problemsBadge() {
  const d = state.editor.diags || [];
  const e = d.filter((x) => x.severity === "error").length, w = d.filter((x) => x.severity === "warning").length;
  const txt = (e || w) ? `${e} error${e === 1 ? "" : "s"}${w ? `, ${w} warning${w === 1 ? "" : "s"}` : ""}` : "No problems";
  return h("span", { class: "es-problems" + ((e || w) ? " has" : "") + (state.editor.problemsOpen ? " active" : ""), title: "Toggle Problems panel (Ctrl+Shift+M)", onclick: () => toggleProblems() }, txt);
}
export function onEditorDiagnostics() {
  state.editor.diags = cm ? cm.diagnosticsDetailed() : [];
  const f = stateActiveFile();
  if (f) updateEditorStatus(f);
  if (state.editor.problemsOpen) renderProblems();
}
export function toggleProblems() {
  state.editor.problemsOpen = !state.editor.problemsOpen;
  renderProblems();
  const f = stateActiveFile();
  if (f) updateEditorStatus(f);
  if (cm) cm.remeasure();
}
export async function scanProjectProblems() {
  const f = stateActiveFile();
  if (!f || !cm || !TS_LANGS.has((f.lang || "").toLowerCase()) || !atom.ts) { state.editor.projDiags = []; renderProblems(); return; }
  state.editor.projDiags = null;   // loading
  renderProblems();
  let res = [];
  try { res = await atom.ts.req("projectDiagnostics", tsRootFor(f), f.path, { text: cm.docText() }) || []; } catch { res = []; }
  state.editor.projDiags = res;
  if (state.editor.problemsOpen && state.editor.problemsScope === "project") renderProblems();
}
export function renderProblems() {
  const pane = $("editorPane");
  if (!pane) return;
  let panel = $("editorProblems");
  if (!state.editor.problemsOpen) { if (panel) panel.classList.add("hidden"); return; }
  if (!panel) { panel = h("div", { id: "editorProblems", class: "editor-problems" }); pane.insertBefore(panel, $("editorStatus")); }
  panel.classList.remove("hidden");
  panel.innerHTML = "";
  const scope = state.editor.problemsScope === "project" ? "project" : "file";
  const fileDiags = state.editor.diags || [];
  const projDiags = state.editor.projDiags;
  const f = stateActiveFile();
  const canProject = f && TS_LANGS.has((f.lang || "").toLowerCase());
  const tab = (id, label) => h("button", { class: "ep-tab" + (scope === id ? " active" : ""), text: label, onclick: () => { state.editor.problemsScope = id; if (id === "project" && state.editor.projDiags == null) scanProjectProblems(); else renderProblems(); } });
  const head = h("div", { class: "ep-head" }, h("span", { html: icon("alert", 13) }), h("span", { text: "Problems" }), tab("file", "This file"));
  if (canProject) head.append(tab("project", "Project"));
  head.append(h("div", { class: "es-spacer" }),
    h("button", { class: "ep-close", html: icon("close", 14), title: "Close", onclick: () => toggleProblems() }));
  panel.append(head);

  if (scope === "project") {
    if (projDiags == null) { panel.append(h("div", { class: "ep-empty", text: "Scanning the project…" })); return; }
    if (!projDiags.length) { panel.append(h("div", { class: "ep-empty", text: "No problems in the project." })); return; }
    const byFile = new Map();
    for (const d of projDiags) { if (!byFile.has(d.file)) byFile.set(d.file, []); byFile.get(d.file).push(d); }
    const list = h("div", { class: "ep-list" });
    for (const [file, items] of byFile) {
      list.append(h("div", { class: "ref-file-head" }, h("span", { html: icon("fileCode", 13) }), h("span", { class: "srf-name", text: baseName(file) }), h("span", { class: "srf-path", text: relPath(file, state.project || "") }), h("span", { class: "srf-count", text: String(items.length) })));
      for (const d of items) list.append(h("div", { class: "ep-item " + (d.severity || "info"), onclick: () => jumpTo(file, null, d.line, d.col) },
        h("span", { class: "ep-sev " + (d.severity || "info"), html: icon(d.severity === "warning" ? "eye" : d.severity === "error" ? "alert" : "dot", 12) }),
        h("span", { class: "ep-msg", text: d.message.replace(/\n/g, " ") }),
        h("span", { class: "ep-loc", text: `Ln ${d.line}:${d.col}` })));
    }
    panel.append(list);
    return;
  }

  if (!fileDiags.length) { panel.append(h("div", { class: "ep-empty", text: "No problems detected in this file." })); return; }
  const list = h("div", { class: "ep-list" });
  for (const d of fileDiags) {
    list.append(h("div", { class: "ep-item " + (d.severity || "info"), onclick: () => { if (cm) cm.gotoLine(d.line, d.col); } },
      h("span", { class: "ep-sev " + (d.severity || "info"), html: icon(d.severity === "warning" ? "eye" : d.severity === "error" ? "alert" : "dot", 12) }),
      h("span", { class: "ep-msg", text: d.message.replace(/\n/g, " ") }),
      h("span", { class: "ep-loc", text: `Ln ${d.line}:${d.col}` })));
  }
  panel.append(list);
}
export function editorGoToLinePrompt() {
  if (!cm) return;
  const total = cm.view.state.doc.lines;
  promptDialog({
    title: "Go to line", ic: "list", message: `Line 1 – ${total}  (line or line:column)`, placeholder: "e.g. 120 or 120:5", confirmLabel: "Go",
    onConfirm: (v) => { const m = /(\d+)(?::(\d+))?/.exec(String(v || "")); if (!m) return; const n = Math.min(+m[1], total); if (n >= 1) cm.gotoLine(n, m[2] ? +m[2] : 1); },
  });
}
/* ---- jump history (Alt+Left / Alt+Right) ---- */
export const _nav = { stack: [], idx: -1 };
export function navLoc() { const f = stateActiveFile(); return (f && cm) ? { path: f.path, pos: cm.cursor() } : null; }
export function navSame(a, b) { return a && b && a.path === b.path && Math.abs(a.pos - b.pos) < 3; }
// Record the current caret as a history entry (truncating any forward history).
export function navMark() {
  const loc = navLoc(); if (!loc) return;
  if (navSame(_nav.stack[_nav.idx], loc)) return;
  _nav.stack = _nav.stack.slice(0, _nav.idx + 1);
  _nav.stack.push(loc); _nav.idx = _nav.stack.length - 1;
  if (_nav.stack.length > 80) { _nav.stack.shift(); _nav.idx--; }
}
// Jump to a location, recording the SOURCE for back/forward. The destination is
// committed lazily on the first Back (navGo), so positions are real caret offsets.
export async function jumpTo(path, pos, line, col) {
  navMark();
  await openInEditor(path);
  requestAnimationFrame(() => { if (!cm) return; if (pos != null) cm.gotoOffset(pos, 0); else cm.gotoLine(line || 1, col || 1); });
}
export async function navGo(dir) {
  if (dir < 0) navMark();   // commit the current caret before stepping back (browser model)
  const ni = _nav.idx + dir;
  if (ni < 0 || ni >= _nav.stack.length) return;
  _nav.idx = ni;
  const l = _nav.stack[ni];
  await openInEditor(l.path);
  requestAnimationFrame(() => { if (!cm) return; if (l.pos != null) cm.gotoOffset(l.pos, 0); else cm.gotoLine(l.line || 1, l.col || 1); });
}
/* ---- find all references (Shift+F12) → docked references panel ---- */
export async function editorFindReferences() {
  const f = stateActiveFile();
  if (!f || !cm) return;
  const lang = (f.lang || "").toLowerCase(), root = tsRootFor(f), text = cm.docText(), pos = cm.cursor();
  if (!TS_LANGS.has(lang) && !LSP_EXTS.has(lang)) { toast("References aren't available for this language", "alert"); return; }
  const word = cm.wordAt(pos);
  state.editor.refs = null; state.editor.refsOpen = true; state.editor.refsWord = word ? word.word : "";
  renderReferences();   // show "searching…"
  let refs = null;
  try {
    if (TS_LANGS.has(lang) && atom.ts) refs = await atom.ts.req("references", root, f.path, { text, pos });
    else if (LSP_EXTS.has(lang) && atom.lsp) refs = await atom.lsp.req("references", root, lang, f.path, { text, pos });
  } catch { /* ignore */ }
  state.editor.refs = refs || [];
  if (state.editor.refsOpen) renderReferences();
}
export function closeReferences() { state.editor.refsOpen = false; const p = $("editorRefs"); if (p) p.classList.add("hidden"); if (cm) cm.remeasure(); }
export function renderReferences() {
  const pane = $("editorPane");
  if (!pane) return;
  let panel = $("editorRefs");
  if (!state.editor.refsOpen) { if (panel) panel.classList.add("hidden"); return; }
  if (!panel) { panel = h("div", { id: "editorRefs", class: "editor-problems" }); pane.insertBefore(panel, $("editorStatus")); }
  panel.classList.remove("hidden");
  panel.innerHTML = "";
  const refs = state.editor.refs;
  const n = refs ? refs.length : 0;
  panel.append(h("div", { class: "ep-head" },
    h("span", { html: icon("gitCompare", 13) }),
    h("span", { text: refs == null ? `Finding references…` : `References to "${state.editor.refsWord || "symbol"}" · ${n}` }),
    h("div", { class: "es-spacer" }),
    h("button", { class: "ep-close", html: icon("close", 14), title: "Close", onclick: () => closeReferences() })));
  if (refs == null) { panel.append(h("div", { class: "ep-empty", text: "Searching the project…" })); return; }
  if (!n) { panel.append(h("div", { class: "ep-empty", text: "No references found." })); return; }
  // group by file
  const byFile = new Map();
  for (const r of refs) { const k = r.file; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(r); }
  const list = h("div", { class: "ep-list" });
  for (const [file, items] of byFile) {
    list.append(h("div", { class: "ref-file-head" }, h("span", { html: icon("fileCode", 13) }), h("span", { class: "srf-name", text: baseName(file) }), h("span", { class: "srf-path", text: relPath(file, state.project || "") }), h("span", { class: "srf-count", text: String(items.length) })));
    for (const r of items) {
      list.append(h("div", { class: "ep-item", onclick: () => jumpTo(file, null, r.line, r.col) },
        h("span", { class: "ep-sev", html: icon(r.isWrite ? "pencil" : "dot", 12) }),
        h("span", { class: "ep-msg", text: `${baseName(file)}` }),
        h("span", { class: "ep-loc", text: `Ln ${r.line}:${r.col}` })));
    }
  }
  panel.append(list);
}
export async function saveEditorFile(path) {
  const f = state.editor.open.find((x) => x.path === path);
  if (!f) return;
  // Ctrl+S on a buffer with no path is the "where?" question, and it applies even
  // to an untouched one — that is how you turn a scratch tab into a file.
  if (f.untitled) return void saveEditorAs(f);
  if (!f.dirty) return;
  // Pull the live text from whichever pane shows this file (lazy content sync).
  for (let p = 0; p < 2; p++) if (state.editor.panes[p] === path && editors[p]) { syncFileContent(f, editors[p]); break; }
  // Format on save (JS/TS) when enabled — runs the TS formatter before writing.
  if (state.settings.editorFormatOnSave && cm && state.editor.active === path && TS_LANGS.has((f.lang || "").toLowerCase())) {
    try { await cm.formatDoc(); f.content = cm.docText(); } catch { /* ignore */ }
  }
  // Trim trailing whitespace + final newline (EditorConfig overrides the setting).
  const ec = f.ec || {};
  const trim = ("trim_trailing_whitespace" in ec) ? ec.trim_trailing_whitespace === true : !!state.settings.editorTrimWhitespace;
  const finalNL = ("insert_final_newline" in ec) ? ec.insert_final_newline === true : !!state.settings.editorFinalNewline;
  if ((trim || finalNL) && cm && state.editor.active === path) {
    try { f.content = cm.normalizeWhitespace(trim, finalNL); } catch { /* ignore */ }
  }
  // The editor doc is always LF internally; restore the file's own EOL on write.
  const onDisk = f.eol === "crlf" ? f.content.replace(/\r?\n/g, "\r\n") : f.content;
  // No success toast — the status bar + tab dirty dot already indicate the save.
  try { await atom.files.write(f.path, onDisk); f.saved = f.content; f.dirty = false; renderEditorTabs(); updateEditorStatus(f); gitGutterRefreshAll(); if (gitProjectRoot()) scheduleGitRefresh(); }
  catch (e) { toast("Save failed: " + e.message, "alert"); }
}
/* Take a file out of the editor without touching disk: drop the tab, refill any
 * pane that was showing it (preferring a file the other pane isn't on), and
 * collapse the split if a pane can't be filled. */
export function dropEditorFile(path) {
  const idx = state.editor.open.findIndex((x) => x.path === path);
  if (idx < 0) return;
  state.editor.open.splice(idx, 1);
  for (let p = 0; p < 2; p++) {
    if (state.editor.panes[p] !== path) continue;
    const otherPath = state.editor.panes[p === 0 ? 1 : 0];
    const diff = state.editor.open.find((x) => x.path !== otherPath);
    state.editor.panes[p] = (diff && diff.path) || otherPath || null;
  }
  if (state.editor.split && (!state.editor.panes[0] || !state.editor.panes[1])) {
    state.editor.split = false;
    if (editors[1]) { editors[1].destroy(); editors[1] = null; }
    state.editor.panes[1] = null; state.editor.focused = 0;
  }
  if (!state.editor.panes[0]) state.editor.panes[0] = state.editor.open.length ? state.editor.open[Math.min(idx, state.editor.open.length - 1)].path : null;
  state.editor.active = state.editor.panes[state.editor.focused] || (state.editor.open[0] && state.editor.open[0].path) || null;
  updateEditorLayout();
  highlightTreeFile();
  persistEditor();
}
export function closeEditorFile(path) {
  const f = state.editor.open.find((x) => x.path === path);
  if (!f) return;
  const doClose = () => dropEditorFile(path);
  // An untitled buffer has nowhere to be saved TO, so the honest question is
  // "where?", not "are you sure?" — cancelling the picker leaves the tab open
  // rather than quietly discarding what the user just chose to keep.
  if (f.untitled) {
    if (!f.dirty) { doClose(); return; }
    saveChangesDialog({ name: f.name, onSave: async () => { if (await promptWriteBufferTo(f)) doClose(); }, onDiscard: doClose });
    return;
  }
  if (f.dirty) {
    saveChangesDialog({ name: f.name, onSave: async () => { await saveEditorFile(path); doClose(); }, onDiscard: doClose });
    return;
  }
  doClose();
}
/* Save / Don't save / Cancel — the three answers a close on unsaved work has.
 * confirmDialog only offers two, and "Cancel or lose it" isn't the choice. */
export function saveChangesDialog({ name, onSave, onDiscard }) {
  const back = modalShell({
    title: `Save changes to ${name}?`, ic: "alert",
    body: h("div", { style: "color:var(--text-2); line-height:1.6; font-size:13.5px", text: "Your changes will be lost if you don't save them." }),
    footer: [
      h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => closeModal(back) }),
      h("button", { class: "btn btn-danger", text: "Don't save", onclick: () => { closeModal(back); onDiscard(); } }),
      h("button", { class: "btn btn-primary", text: "Save", onclick: () => { closeModal(back); onSave(); } }),
    ],
  });
}
export function editorTabContextMenu(ev, f) {
  // An untitled buffer has no path to copy, reveal or hand to another app — the
  // only thing worth offering is giving it one.
  showContextMenu(ev.clientX, ev.clientY, f.untitled ? [
    { label: "Save as…", icon: "download", onClick: () => saveEditorAs(f) },
    { sep: true },
    { label: "Close", icon: "close", onClick: () => closeEditorFile(f.path) },
  ] : [
    { label: "Copy file path", icon: "copy", onClick: () => copyText('"' + f.path + '"', "File path copied") },
    { label: "Copy file name", icon: "copy", onClick: () => copyText(f.name, "File name copied") },
    { sep: true },
    { label: "Save as…", icon: "download", onClick: () => saveEditorAs(f) },
    { label: "Open in File Explorer", icon: "external", onClick: () => atom.files.reveal(f.path) },
    { label: "Open externally", icon: "external", onClick: () => atom.files.open(f.path) },
    { sep: true },
    { label: "Close", icon: "close", onClick: () => closeEditorFile(f.path) },
    { label: "Close others", icon: "close", onClick: () => { state.editor.open = state.editor.open.filter((x) => x.path === f.path); state.editor.split = false; if (editors[1]) { editors[1].destroy(); editors[1] = null; } state.editor.panes = [f.path, null]; state.editor.focused = 0; state.editor.active = f.path; updateEditorLayout(); persistEditor(); } },
  ]);
}
export async function editorGoToLine(path, line, query, caseSensitive) {
  await openInEditor(path);
  requestAnimationFrame(() => { if (cm) cm.gotoLine(line, 1, query || null); });
}
/* ---- Ctrl+F routing: editor → CM6's search panel; folder/global → palette ---- */
export function handleFind() {
  const ae = document.activeElement;
  // Inside the code editor → CM6's own find panel.
  if (cm && cm.view.dom.contains(ae)) { cm.openSearch(); return; }
  // In the agent panel (input focused, or chat is the visible surface) → conversation search.
  const main = $("main");
  const inChat = main && ae && (main.contains(ae) || ae.id === "promptInput");
  if (!document.body.classList.contains("chat-collapsed") && (inChat || !state.editor.active)) { openChatSearch(); return; }
  if (state.findContext === "folder" && state.selectedFolder) return openSearch({ mode: "content", root: state.selectedFolder });
  if (state.editor.active && cm) { cm.openSearch(); return; }
  openSearch({});
}
