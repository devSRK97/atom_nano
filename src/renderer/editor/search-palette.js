/* AtomNano renderer — Search palette — file names and contents (Ctrl+F on a folder / global).
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { $, closeModal, h, modalShell, relPath } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { setSidebarView } from "../git/sidebar.js";
import { icon } from "../icons.js";
import { fileMeta, renderTree } from "../workspace/sidebar.js";
import { cm, escHtml, openInEditor, stateActiveFile, syncFileContent } from "./editor-pane.js";
import { editorGoToLine } from "./symbols.js";

/* ============================================================
   SEARCH PALETTE (Ctrl+F on a folder / global): file names / contents
   ============================================================ */
// Filters persist for the session: `scope` = one sub-folder (absolute path) to
// search in; `include` / `exclude` = comma-separated globs / .ext / path segments.
export const searchState = { mode: "content", caseSensitive: false, wholeWord: false, regex: false, scope: "", include: "", exclude: "" };
export function pathInside(p, root) {
  if (!p || !root) return false;
  const f = p.replace(/\\/g, "/").toLowerCase(), r = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return f.startsWith(r + "/");
}
// Expand every ancestor of `folderPath` in the file tree (loading levels on
// demand, like clicking would), select the folder, and scroll it into view.
export async function revealFolderInTree(folderPath) {
  const ts = activeTS(); if (!ts || !folderPath) return;
  if (state.sidebarView !== "files") setSidebarView("files");
  const root = (ts.tree.root || "").replace(/[\\/]+$/, "");
  if (!pathInside(folderPath, root)) return;                 // outside this tree
  const sep = root.includes("\\") ? "\\" : "/";
  const ensure = async (dir) => { if (!ts.tree.cache.has(dir)) { try { const d = await atom.files.list(dir); ts.tree.cache.set(dir, d.entries); } catch { ts.tree.cache.set(dir, null); } } };
  await ensure(root);
  let cur = root;
  for (const s of relPath(folderPath, root).split(/[\\/]/).filter(Boolean)) { cur = cur + sep + s; ts.tree.expanded.add(cur); await ensure(cur); }
  state.selectedFolder = cur; state.findContext = "folder";
  renderTree();
  try { const row = $("fileTree").querySelector(`.tree-row[data-path="${CSS.escape(cur)}"]`); if (row) row.scrollIntoView({ block: "center" }); } catch { /* ignore */ }
}
// `rx` = treat q as a regular expression. An invalid pattern falls back to a
// literal match (the user is often mid-typing "foo(" — never throw at them).
export function patternFor(q, ww, rx) {
  if (rx) { try { new RegExp(q); return q; } catch { /* fall through to literal */ } }
  let pat = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (ww && !rx) pat = `(?<![\\w$])${pat}(?![\\w$])`;
  return pat;
}
export function highlightQuery(text, q, cs, ww, rx) {
  const esc = escHtml(text);
  if (!q) return esc;
  const pat = patternFor(q, ww, rx);
  try { return esc.replace(new RegExp(pat, (cs ? "g" : "gi") + (rx ? "m" : "")), (mm) => `<mark>${mm}</mark>`); } catch { return esc; }
}
export function localMatcher(q, cs, ww, rx) {
  const pat = patternFor(q, ww, rx);
  let re = null; try { re = new RegExp(pat, (cs ? "" : "i") + (rx ? "m" : "")); } catch { /* */ }
  return (line) => re ? re.test(line) : (cs ? line.includes(q) : line.toLowerCase().includes(q.toLowerCase()));
}
export function openSearch({ mode, root, query } = {}) {
  const ts = activeTS();
  const searchRoot = root || (ts ? ts.meta.cwd : state.settings.lastFolder);
  searchState.mode = mode || (state.editor.active ? "file" : "content");
  // A folder scope from an earlier search only carries over inside this root.
  if (searchState.scope && !pathInside(searchState.scope, searchRoot)) searchState.scope = "";

  const input = h("input", { placeholder: "Search…", value: query || "", spellcheck: "false" });
  const caseBtn = h("button", { class: "search-opt" + (searchState.caseSensitive ? " on" : ""), title: "Match case", text: "Aa", onclick: () => { searchState.caseSensitive = !searchState.caseSensitive; caseBtn.classList.toggle("on", searchState.caseSensitive); run(); } });
  const wordBtn = h("button", { class: "search-opt" + (searchState.wholeWord ? " on" : ""), title: "Whole word", html: "<u>ab</u>", onclick: () => { searchState.wholeWord = !searchState.wholeWord; wordBtn.classList.toggle("on", searchState.wholeWord); run(); } });
  // Regex mode. Whole-word is meaningless for a pattern, so it's disabled while on.
  const reBtn = h("button", { class: "search-opt" + (searchState.regex ? " on" : ""), title: "Use regular expression", text: ".*", onclick: () => { searchState.regex = !searchState.regex; reBtn.classList.toggle("on", searchState.regex); wordBtn.disabled = searchState.regex; run(); } });
  wordBtn.disabled = !!searchState.regex;
  const filtersOn = () => !!(searchState.scope || searchState.include || searchState.exclude);
  const filterBtn = h("button", { class: "search-opt" + (filtersOn() ? " on" : ""), title: "Filters — folder scope, include / exclude patterns", html: icon("filter", 14), onclick: () => { const open = filters.classList.toggle("open"); if (open) incInput.focus(); } });
  const siWrap = h("div", { class: "si-wrap" }, h("span", { html: icon("search", 16) }), input, caseBtn, wordBtn, reBtn, filterBtn);
  input.addEventListener("focus", () => siWrap.classList.add("focused"));
  input.addEventListener("blur", () => siWrap.classList.remove("focused"));

  // ---- filters: folder scope + include / exclude patterns ----
  const scopeSel = h("select", { title: "Limit the search to one folder" });
  const incInput = h("input", { placeholder: "*.js, *.md, src/**", value: searchState.include, spellcheck: "false", title: "Only these paths — globs, .ext, or folder names (comma-separated)" });
  const excInput = h("input", { placeholder: "node_modules, *.log, dist", value: searchState.exclude, spellcheck: "false", title: "Skip these paths — globs, .ext, or folder names (comma-separated)" });
  const clearBtn = h("button", { class: "search-filter-clear", text: "Clear", onclick: () => { searchState.scope = searchState.include = searchState.exclude = ""; incInput.value = excInput.value = ""; scopeSel.value = ""; syncFilterBtn(); run(); } });
  const filters = h("div", { class: "search-filters" + (filtersOn() ? " open" : "") },
    h("div", { class: "search-filter" }, h("label", { text: "In" }), scopeSel),
    h("div", { class: "search-filter" }, h("label", { text: "Include" }), incInput),
    h("div", { class: "search-filter" }, h("label", { text: "Exclude" }), excInput),
    clearBtn);
  function syncFilterBtn() { filterBtn.classList.toggle("on", filtersOn()); }
  let scopeDirs = [];   // top-level folders of the root (filled async)
  function fillScopes() {
    scopeSel.innerHTML = "";
    scopeSel.append(h("option", { value: "", text: "Whole project" }));
    const seen = new Set();
    const add = (p, label) => { if (!p || seen.has(p.toLowerCase())) return; seen.add(p.toLowerCase()); scopeSel.append(h("option", { value: p, text: label || relPath(p, searchRoot) + "/" })); };
    if (state.selectedFolder && pathInside(state.selectedFolder, searchRoot)) add(state.selectedFolder, "Selected: " + relPath(state.selectedFolder, searchRoot) + "/");
    if (searchState.scope) add(searchState.scope);
    for (const d of scopeDirs) add(d);
    scopeSel.value = searchState.scope || "";
  }
  fillScopes();
  atom.files.list(searchRoot).then((d) => { scopeDirs = ((d && d.entries) || []).filter((e) => e.isDir && !e.skip).map((e) => e.path); fillScopes(); }).catch(() => {});
  scopeSel.addEventListener("change", () => { searchState.scope = scopeSel.value; syncFilterBtn(); run(); });
  let ftimer = null;
  const onFilterInput = () => { searchState.include = incInput.value.trim(); searchState.exclude = excInput.value.trim(); syncFilterBtn(); clearTimeout(ftimer); ftimer = setTimeout(run, 300); };
  for (const el of [incInput, excInput]) {
    el.addEventListener("input", onFilterInput);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(ftimer); onFilterInput(); clearTimeout(ftimer); run(); } else if (e.key === "Escape") closeModal(back); });
  }
  // Scope the search to a folder (from a folder result's "search inside" action).
  function scopeTo(dir) { searchState.scope = dir; fillScopes(); syncFilterBtn(); filters.classList.add("open"); searchState.mode = "content"; drawModes(); run(); }
  const effRoot = () => searchState.scope || searchRoot;
  // Filters are resolved against the PROJECT root (base) even when scoped, so
  // "src/**" means the same thing whichever folder is selected.
  const fopts = () => ({ root: effRoot(), base: searchRoot, include: searchState.include || undefined, exclude: searchState.exclude || undefined });
  const filterNote = () => { const p = []; if (searchState.scope) p.push("in " + relPath(searchState.scope, searchRoot) + "/"); if (searchState.include) p.push(searchState.include); if (searchState.exclude) p.push("− " + searchState.exclude); return p.length ? " · " + p.join(" · ") : ""; };

  const modesRow = h("div", { class: "search-modes" });
  const MODES = [{ id: "file", name: "This file", icon: "fileCode" }, { id: "folders", name: "Folders", icon: "folder" }, { id: "names", name: "File names", icon: "file" }, { id: "content", name: "In files", icon: "search" }];
  function drawModes() { modesRow.innerHTML = ""; for (const m of MODES) modesRow.append(h("button", { class: "search-mode" + (m.id === searchState.mode ? " active" : ""), onclick: () => { searchState.mode = m.id; drawModes(); run(); } }, h("span", { html: icon(m.icon, 15) }), m.name)); }
  drawModes();

  const summary = h("div", { class: "search-summary" });
  const results = h("div", { class: "search-results" });
  const body = h("div", {}, h("div", { class: "search-input-row" }, siWrap), filters, modesRow, summary, results);
  const back = modalShell({ title: "Search", ic: "search", wide: true, body });
  back.querySelector(".modal").classList.add("search-modal");
  setTimeout(() => { input.focus(); input.select(); }, 40);

  let timer = null;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 260); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); run(); } else if (e.key === "Escape") closeModal(back); });

  function matchPreview(m, q) {
    const wrap = h("div", { style: "display:inline-block; vertical-align:top" });
    if (m.before != null) wrap.append(h("div", { class: "srm-ctx", text: m.before }));
    wrap.append(h("div", { class: "srm-hit", html: highlightQuery(m.text, q, searchState.caseSensitive, searchState.wholeWord, searchState.regex) }));
    if (m.after != null) wrap.append(h("div", { class: "srm-ctx", text: m.after }));
    return wrap;
  }

  async function run() {
    const q = input.value.trim();
    results.innerHTML = ""; summary.textContent = "";
    if (!q) { results.append(h("div", { class: "search-empty", text: "Type to search." })); return; }

    if (searchState.mode === "file") {
      const f = stateActiveFile();
      if (!f) { results.append(h("div", { class: "search-empty", text: "No file open. Open a file to search within it." })); return; }
      syncFileContent(f, cm);   // f.content is lazily synced — bring it current first
      const match = localMatcher(q, searchState.caseSensitive, searchState.wholeWord, searchState.regex);
      const lines = f.content.split("\n");
      let count = 0; const frag = [];
      for (let i = 0; i < lines.length && frag.length < 800; i++) if (match(lines[i])) { count++; frag.push({ line: i + 1, text: lines[i].slice(0, 240) }); }
      summary.textContent = `${count} match${count !== 1 ? "es" : ""} in this file`;
      if (!count) { results.append(h("div", { class: "search-empty", text: "No matches in this file." })); return; }
      for (const r of frag) results.append(h("div", { class: "sr-match", onclick: () => { closeModal(back); editorGoToLine(f.path, r.line, q, searchState.caseSensitive); } },
        h("span", { class: "srm-line", text: String(r.line) }), matchPreview({ text: r.text, before: null, after: null }, q)));
      return;
    }

    summary.textContent = "Searching…";
    if (searchState.mode === "names" || searchState.mode === "folders") {
      const kind = searchState.mode === "folders" ? "folders" : "files";
      const r = await atom.files.searchNames({ ...fopts(), query: q, kind }).catch(() => ({ files: [] }));
      const noun = kind === "folders" ? "folder" : "file";
      summary.textContent = `${r.files.length} ${noun}${r.files.length !== 1 ? "s" : ""}${r.truncated ? "+" : ""}${filterNote()}`;
      if (!r.files.length) { results.append(h("div", { class: "search-empty", text: `No ${noun}s match.` })); return; }
      for (const f of r.files) {
        if (f.isDir) {
          // Folder hit: click reveals it in the tree; the trailing action scopes
          // a content search to it without leaving the modal.
          results.append(h("div", { class: "sr-name-row is-dir", title: "Reveal in file tree", onclick: () => { closeModal(back); revealFolderInTree(f.path); } },
            h("span", { class: "tw-icon ft-folder", html: icon("folder", 15) }), h("span", { class: "srn-name", text: f.name }), h("span", { class: "srn-path", text: relPath(f.path, searchRoot) }),
            h("button", { class: "srn-act", title: "Search inside this folder", html: icon("search", 13), onclick: (ev) => { ev.stopPropagation(); scopeTo(f.path); } })));
        } else {
          const sm = fileMeta(f.name);
          results.append(h("div", { class: "sr-name-row", onclick: () => { closeModal(back); openInEditor(f.path); } },
            h("span", { class: "tw-icon " + sm.cls, html: icon(sm.ic, 15) }), h("span", { class: "srn-name " + sm.cls, text: f.name }), h("span", { class: "srn-path", text: relPath(f.path, searchRoot) })));
        }
      }
      return;
    }

    // content
    const r = await atom.files.searchContent({ ...fopts(), query: q, caseSensitive: searchState.caseSensitive, wholeWord: searchState.wholeWord, regex: searchState.regex }).catch(() => ({ results: [], fileCount: 0, matchCount: 0 }));
    summary.textContent = `${r.matchCount} result${r.matchCount !== 1 ? "s" : ""} in ${r.fileCount} file${r.fileCount !== 1 ? "s" : ""}${r.truncated ? " · truncated" : ""}${filterNote()}`;
    if (!r.results.length) { results.append(h("div", { class: "search-empty", text: "No matches found." })); return; }
    for (const file of r.results) {
      const grp = h("div", { class: "sr-file" });
      grp.append(h("div", { class: "sr-file-head", onclick: () => { closeModal(back); openInEditor(file.path); } },
        h("span", { html: icon("fileCode", 14) }), h("span", { class: "srf-name", text: file.name }),
        h("span", { class: "srf-path", text: relPath(file.path, searchRoot) }), h("span", { class: "srf-count", text: String(file.matches.length) })));
      for (const m of file.matches) grp.append(h("div", { class: "sr-match", onclick: () => { closeModal(back); editorGoToLine(file.path, m.line, q, searchState.caseSensitive); } },
        h("span", { class: "srm-line", text: String(m.line) }), matchPreview(m, q)));
      results.append(grp);
    }
  }
  run();
}
