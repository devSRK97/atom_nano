/* CodeMirror 6 wrapper for AtomNano — themed via CSS variables so it follows
 * the app theme automatically. Bundled by esbuild into cm.bundle.js.
 *
 * Languages: the 6 common grammars (JS/TS, Python, JSON, CSS, HTML, Markdown)
 * are imported eagerly; everything else is lazy-loaded via dynamic import() so
 * a grammar only costs memory once you open a file of that type (esbuild
 * code-splits each into its own chunk). Every lazy branch is wrapped so a
 * failed/blocked chunk degrades to plain text instead of breaking the editor. */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, Decoration, ViewPlugin, WidgetType, hoverTooltip, showTooltip, highlightWhitespace, gutter, GutterMarker } from "@codemirror/view";
import { EditorState, EditorSelection, Compartment, StateField, StateEffect, RangeSetBuilder, RangeSet, Annotation, Transaction } from "@codemirror/state";

import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, toggleComment, selectParentSyntax, moveLineUp, moveLineDown, copyLineUp, copyLineDown, deleteLine, toggleBlockComment } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, foldKeymap, codeFolding, foldGutter, foldAll, unfoldAll, foldedRanges, foldEffect, syntaxTree, ensureSyntaxTree, StreamLanguage, indentUnit, language } from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel, closeSearchPanel, searchPanelOpen, findNext, findPrevious, SearchQuery, setSearchQuery, getSearchQuery, replaceNext, replaceAll, selectNextOccurrence } from "@codemirror/search";
import { linter, lintGutter, forEachDiagnostic, forceLinting } from "@codemirror/lint";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippetCompletion, nextSnippetField, prevSnippetField, hasNextSnippetField, hasPrevSnippetField, clearSnippet, completeAnyWord } from "@codemirror/autocomplete";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { abbreviationTracker } from "@emmetio/codemirror6-plugin";
import { javascript, autoCloseTags as jsxAutoCloseTags } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

// Token colours come from CSS variables, so switching the app theme restyles
// the code live (no editor reconfigure needed).
const aqxHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--tok-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self, t.null], color: "var(--tok-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--tok-string)" },
  { tag: [t.number, t.bool, t.integer, t.float], color: "var(--tok-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.macroName], color: "var(--tok-fn)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--tok-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--tok-prop)" },
  { tag: [t.variableName, t.labelName], color: "var(--code-text)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--tok-punct)" },
  { tag: [t.invalid], color: "var(--red)" },
  { tag: [t.link, t.url], color: "var(--accent)", textDecoration: "underline" },
  { tag: [t.heading], color: "var(--tok-type)", fontWeight: "bold" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.emphasis], fontStyle: "italic" },
]);

const aqxTheme = EditorView.theme({
  "&": { color: "var(--code-text)", backgroundColor: "var(--bg-inset)", height: "100%", fontSize: "var(--ed-font, 13px)" },
  ".cm-scroller": { fontFamily: "var(--ed-font-family, var(--font-mono))", lineHeight: "1.62", overflow: "auto" },
  ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
  ".cm-line": { padding: "0 12px" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "color-mix(in srgb, var(--accent) 26%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 14%, transparent)" },
  ".cm-gutters": { backgroundColor: "var(--bg-1)", color: "var(--text-4)", border: "none", borderRight: "1px solid var(--line-soft)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--accent)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 5%, transparent)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 8px", minWidth: "28px" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--text-4)", cursor: "pointer" },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--accent)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-3)", border: "1px solid var(--line-2)", color: "var(--text-3)", borderRadius: "4px", margin: "0 4px", padding: "0 6px" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)", outline: "1px solid var(--accent-2)" },
  ".cm-tooltip": { backgroundColor: "var(--bg-3)", border: "1px solid var(--line-2)", borderRadius: "8px", color: "var(--text)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)", color: "var(--text)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
  ".cm-panels": { backgroundColor: "var(--bg-2)", color: "var(--text)", borderTop: "1px solid var(--line)" },
  ".cm-panel.cm-search": { padding: "8px 10px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-textfield": { backgroundColor: "var(--bg-inset)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: "6px" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 50%, transparent)" },
  ".cm-cm-link, .cm-link-target": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "2px", cursor: "pointer" },
});

// StreamLanguage helper for the legacy (non-Lezer) modes.
function defineStream(mod, name) { try { const m = mod && mod[name]; return m ? StreamLanguage.define(m) : []; } catch { return []; } }

// Resolve an extension/lang id → a CodeMirror language extension. Async because
// all but the 6 common grammars are dynamically imported (lazy chunks). Any
// failure (blocked chunk, bad export) falls back to plain text via try/catch.
async function langFor(lang) {
  lang = (lang || "").toLowerCase();
  try {
    switch (lang) {
      // ---- common, eager ----
      // JSX/TSX get auto-close tags (html() already auto-closes for HTML/Vue/Svelte).
      case "js": case "mjs": case "cjs": case "jsx": return [javascript({ jsx: true }), jsxAutoCloseTags];
      case "ts": case "tsx": case "mts": case "cts": return [javascript({ jsx: true, typescript: true }), jsxAutoCloseTags];
      case "py": case "pyw": case "pyi": return python();
      case "json": case "jsonc": case "json5": case "webmanifest": return json();
      case "css": return css();
      case "html": case "htm": case "xhtml": return html();
      case "md": case "markdown": case "mdx": return markdown();
      // ---- lazy: official Lezer grammars ----
      case "scss": return (await import("@codemirror/lang-sass")).sass({ indented: false });
      case "sass": return (await import("@codemirror/lang-sass")).sass({ indented: true });
      case "less": return (await import("@codemirror/lang-less")).less();
      case "vue": return (await import("@codemirror/lang-vue")).vue();
      case "svelte": return (await import("@replit/codemirror-lang-svelte")).svelte();
      case "go": return (await import("@codemirror/lang-go")).go();
      case "rs": return (await import("@codemirror/lang-rust")).rust();
      case "java": return (await import("@codemirror/lang-java")).java();
      case "yaml": case "yml": return (await import("@codemirror/lang-yaml")).yaml();
      case "xml": case "svg": case "xsl": case "xsd": case "plist": case "wsdl": return (await import("@codemirror/lang-xml")).xml();
      case "c": case "h": case "cpp": case "cc": case "cxx": case "c++": case "hpp": case "hh": case "hxx": case "ino": return (await import("@codemirror/lang-cpp")).cpp();
      case "php": case "phtml": return (await import("@codemirror/lang-php")).php();
      case "sql": case "mysql": case "pgsql": return (await import("@codemirror/lang-sql")).sql();
      // ---- lazy: legacy stream modes ----
      case "sh": case "bash": case "zsh": case "ksh": case "bats": return defineStream(await import("@codemirror/legacy-modes/mode/shell"), "shell");
      case "rb": case "gemspec": case "rake": return defineStream(await import("@codemirror/legacy-modes/mode/ruby"), "ruby");
      case "toml": return defineStream(await import("@codemirror/legacy-modes/mode/toml"), "toml");
      case "dockerfile": case "containerfile": return defineStream(await import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile");
      case "lua": return defineStream(await import("@codemirror/legacy-modes/mode/lua"), "lua");
      case "pl": case "pm": return defineStream(await import("@codemirror/legacy-modes/mode/perl"), "perl");
      case "swift": return defineStream(await import("@codemirror/legacy-modes/mode/swift"), "swift");
      case "ini": case "conf": case "cfg": case "properties": case "env": case "editorconfig": return defineStream(await import("@codemirror/legacy-modes/mode/properties"), "properties");
      case "ps1": case "psm1": case "psd1": return defineStream(await import("@codemirror/legacy-modes/mode/powershell"), "powerShell");
      case "r": return defineStream(await import("@codemirror/legacy-modes/mode/r"), "r");
      case "jl": return defineStream(await import("@codemirror/legacy-modes/mode/julia"), "julia");
      case "hs": return defineStream(await import("@codemirror/legacy-modes/mode/haskell"), "haskell");
      case "clj": case "cljs": case "cljc": case "edn": return defineStream(await import("@codemirror/legacy-modes/mode/clojure"), "clojure");
      case "groovy": case "gradle": return defineStream(await import("@codemirror/legacy-modes/mode/groovy"), "groovy");
      case "diff": case "patch": return defineStream(await import("@codemirror/legacy-modes/mode/diff"), "diff");
      case "cs": return defineStream(await import("@codemirror/legacy-modes/mode/clike"), "csharp");
      case "kt": case "kts": return defineStream(await import("@codemirror/legacy-modes/mode/clike"), "kotlin");
      case "scala": case "sc": return defineStream(await import("@codemirror/legacy-modes/mode/clike"), "scala");
      case "dart": return defineStream(await import("@codemirror/legacy-modes/mode/clike"), "dart");
      case "m": case "mm": return defineStream(await import("@codemirror/legacy-modes/mode/clike"), "objectiveC");
      default: return [];
    }
  } catch { return []; }
}

// ---- syntax-error linter: surface Lezer parse-error nodes as diagnostics
// (works for every grammar that has one — cheap, walks the cached tree). ----
function treeLinter(view) {
  const out = [];
  try {
    const tree = syntaxTree(view.state);
    if (!tree || tree.length < view.state.doc.length * 0.5) return out;   // grammar not (fully) parsed
    const docLen = view.state.doc.length;
    let last = -1;
    tree.iterate({
      enter(node) {
        if (out.length >= 100) return false;
        if (!node.type.isError) return;
        const from = node.from, to = Math.min(Math.max(node.to, from + 1), docLen);
        if (from === last) return;        // collapse adjacent error spans
        last = from;
        out.push({ from, to, severity: "error", message: "Syntax error" });
      },
    });
  } catch { /* ignore */ }
  return out;
}

/* ---- worker pool: offload syntax-error parsing + find-counting to other cores.
 * The EditorView stays on the main thread; only this CPU-heavy work moves off it.
 * Workers are spawned lazily (up to cores−2) and requests round-robin across them,
 * so several large files lint/count in parallel. Any failure falls back to the
 * main thread, so the editor never depends on the worker. ---- */
const WORKER_LINT_LANGS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "py", "pyw", "pyi", "json",
  "css", "scss", "html", "htm", "xhtml", "go", "rs", "java", "yaml", "yml",
  "xml", "svg", "xsd", "xsl", "plist", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "ino", "php", "phtml",
]);
const pool = {
  size: Math.max(1, Math.min((typeof navigator !== "undefined" && navigator.hardwareConcurrency || 4) - 2, 3)),
  workers: [], rr: 0, seq: 0, pending: new Map(), broken: false,
  stats: { lint: 0, count: 0 },
};
function ensureWorker(idx) {
  if (pool.broken) return null;
  if (pool.workers[idx]) return pool.workers[idx];
  let w;
  try { w = new Worker(new URL("./cm-worker.bundle.js", import.meta.url), { type: "module" }); }
  catch { pool.broken = true; return null; }
  w.onmessage = (e) => {
    const p = pool.pending.get(e.data && e.data.id);
    if (!p) return;
    pool.pending.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
  };
  w.onerror = () => { /* pending requests time out and fall back */ };
  pool.workers[idx] = w;
  return w;
}
// Affinity key (e.g. a docId) pins same-document requests to the same worker so
// its incremental-parse cache stays warm; without a key we round-robin.
function pickWorker(affinity) {
  if (affinity != null) {
    let h = 0; const s = String(affinity);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return ensureWorker(Math.abs(h) % pool.size);
  }
  return ensureWorker((pool.rr++) % pool.size);
}
function poolRpc(type, payload, timeoutMs = 6000, affinity) {
  return new Promise((resolve, reject) => {
    const w = pickWorker(affinity != null ? affinity : payload && payload.docId);
    if (!w) { reject(new Error("no worker")); return; }
    const id = ++pool.seq;
    const timer = setTimeout(() => { if (pool.pending.has(id)) { pool.pending.delete(id); reject(new Error("worker timeout")); } }, timeoutMs);
    pool.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    w.postMessage({ id, type, ...payload });
  });
}

/* ---- semantic diagnostics: project-wide TypeScript runs in the MAIN process
 * (real filesystem → resolves tsconfig + node_modules + sibling files, like VS
 * Code's tsserver) and is delivered here through opts.semanticProvider(text).
 * The renderer just renders the result, so the UI thread stays free. ---- */
const SEMANTIC_LANGS = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"]);
const MAX_SEMANTIC_BYTES = 4_000_000;
const sem = { count: 0 };
// TS completion-entry kind → CodeMirror completion type (drives the popup icon).
const TS_KIND = {
  method: "method", function: "function", "local function": "function", constructor: "function",
  property: "property", getter: "property", setter: "property",
  variable: "variable", let: "variable", const: "variable", "local var": "variable", parameter: "variable", alias: "variable",
  class: "class", interface: "interface", type: "type", "primitive type": "type", "type parameter": "type",
  enum: "enum", "enum member": "enum", module: "namespace", "external module name": "namespace", keyword: "keyword",
};

// ---- bracket-pair colourization (rainbow brackets) ----
const BR_OPEN = "([{", BR_CLOSE = ")]}";
function bracketColors() {
  const marks = [0, 1, 2, 3, 4, 5].map((d) => Decoration.mark({ class: "cm-br" + d }));
  function build(view) {
    const b = new RangeSetBuilder();
    const doc = view.state.doc;
    if (doc.length > 120000) return b.finish();   // skip the scan on very large files
    const text = doc.toString();
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (BR_OPEN.includes(c)) { b.add(i, i + 1, marks[depth % 6]); depth++; }
      else if (BR_CLOSE.includes(c)) { depth = Math.max(0, depth - 1); b.add(i, i + 1, marks[depth % 6]); }
    }
    return b.finish();
  }
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = build(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
  }, { decorations: (v) => v.decorations });
}

// ---- select all occurrences of the current selection/word (Ctrl+Shift+L) ----
function selectAllOccurrences(view) {
  const { from, to } = view.state.selection.main;
  let word;
  if (from === to) {
    const w = view.state.wordAt(from);
    if (!w) return false;
    word = view.state.sliceDoc(w.from, w.to);
  } else { word = view.state.sliceDoc(from, to); }
  if (!word) return false;
  const doc = view.state.doc.toString();
  const ranges = [];
  let idx = 0;
  while (true) {
    const i = doc.indexOf(word, idx);
    if (i < 0) break;
    ranges.push(EditorSelection.range(i, i + word.length));
    idx = i + word.length;
  }
  if (ranges.length <= 1) return false;
  view.dispatch({ selection: EditorSelection.create(ranges) });
  return true;
}
// ---- duplicate the current line(s) below ----
function duplicateLineCmd(view) {
  const { from, to } = view.state.selection.main;
  const a = view.state.doc.lineAt(from), b = view.state.doc.lineAt(to);
  const text = view.state.sliceDoc(a.from, b.to);
  view.dispatch({ changes: { from: b.to, to: b.to, insert: "\n" + text } });
  return true;
}

// ---- add a cursor on the line above/below the edge-most caret (Ctrl+Alt+↑/↓) ----
function addCursorVertical(view, dir) {
  const ranges = view.state.selection.ranges;
  const edge = ranges.reduce((a, b) => (dir > 0 ? (b.head > a.head ? b : a) : (b.head < a.head ? b : a)), ranges[0]);
  const line = view.state.doc.lineAt(edge.head);
  const col = edge.head - line.from;
  const n = line.number + dir;
  if (n < 1 || n > view.state.doc.lines) return false;
  const tl = view.state.doc.line(n);
  const pos = Math.min(tl.from + col, tl.to);
  view.dispatch({ selection: EditorSelection.create([...ranges, EditorSelection.cursor(pos)], ranges.length), scrollIntoView: true });
  return true;
}

// ---- line operations + syntax-aware selection ----
// Resolve the line range a command should act on: the selection's span of lines,
// or the whole document when the selection sits within a single line.
function lineSpan(state) {
  const r = state.selection.main;
  let a = state.doc.lineAt(r.from).number, b = state.doc.lineAt(r.to).number;
  if (a === b) {   // no real selection → whole document, minus a trailing empty line
    a = 1; b = state.doc.lines;
    if (b > 1 && state.doc.line(b).text === "") b--;
  }
  return { a, b, from: state.doc.line(a).from, to: state.doc.line(b).to };
}
function sortSelectedLines(view, desc) {
  const { a, b, from, to } = lineSpan(view.state);
  if (a === b) return false;
  const lines = [];
  for (let i = a; i <= b; i++) lines.push(view.state.doc.line(i).text);
  lines.sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" }));
  if (desc) lines.reverse();
  view.dispatch({ changes: { from, to, insert: lines.join(view.state.lineBreak) } });
  return true;
}
// Join the selected lines (or the current line with the next) into one, collapsing
// the inter-line whitespace to a single space — like VS Code's Join Lines.
function joinLinesCmd(view) {
  const st = view.state, r = st.selection.main;
  let a = st.doc.lineAt(r.from).number, b = st.doc.lineAt(r.to).number;
  if (a === b) b = Math.min(a + 1, st.doc.lines);
  if (a === b) return false;
  const from = st.doc.line(a).from, to = st.doc.line(b).to;
  let out = st.doc.line(a).text;
  for (let i = a + 1; i <= b; i++) out += (out && !/\s$/.test(out) ? " " : "") + st.doc.line(i).text.replace(/^\s+/, "");
  view.dispatch({ changes: { from, to, insert: out }, selection: { anchor: from + out.length } });
  return true;
}
// Expand selection to the enclosing syntax node, remembering each prior range so
// Shrink can walk back out — a manual stack since CM6 has no built-in shrink.
const selStacks = new WeakMap();
function expandSelectionCmd(view) {
  const before = view.state.selection.main;
  selectParentSyntax(view);
  const after = view.state.selection.main;
  if (after.from !== before.from || after.to !== before.to) {
    let s = selStacks.get(view); if (!s) selStacks.set(view, s = []);
    s.push({ from: before.from, to: before.to });
  }
  return true;
}
function shrinkSelectionCmd(view) {
  const s = selStacks.get(view);
  if (s && s.length) { const r = s.pop(); view.dispatch({ selection: { anchor: r.from, head: r.to } }); return true; }
  return false;
}


// ---- CSS colour swatches: a small colour square before #hex / rgb() / hsl() ----
const CSS_SWATCH_LANGS = new Set(["css", "scss", "less", "vue", "html", "htm", "xhtml", "svg"]);
const COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|(?:rgba?|hsla?)\([^)]*\)/g;
class SwatchWidget extends WidgetType {
  constructor(color) { super(); this.color = color; }
  eq(o) { return o.color === this.color; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-color-swatch"; s.style.backgroundColor = this.color; s.title = this.color; return s; }
  ignoreEvent() { return false; }
}
function colorSwatches(getLang) {
  function build(view) {
    const b = new RangeSetBuilder();
    if (!CSS_SWATCH_LANGS.has(getLang())) return b.finish();
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.sliceDoc(from, to);
      COLOR_RE.lastIndex = 0;
      let m;
      while ((m = COLOR_RE.exec(text))) { const at = from + m.index; b.add(at, at, Decoration.widget({ widget: new SwatchWidget(m[0]), side: -1 })); }
    }
    return b.finish();
  }
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = build(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
  }, { decorations: (v) => v.decorations });
}

// ---- snippets (Tab-stops) per language ----
const mkSnips = (defs) => defs.map(([label, template, detail]) => snippetCompletion(template, { label, detail: detail || "snippet", type: "text", boost: -1 }));
const JS_SNIPPETS = mkSnips([
  ["clg", "console.log(${})", "console.log"],
  ["fn", "function ${name}(${}) {\n\t${}\n}", "function"],
  ["afn", "const ${name} = (${}) => {\n\t${}\n}", "arrow fn"],
  ["for", "for (let ${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}", "for loop"],
  ["forof", "for (const ${item} of ${iterable}) {\n\t${}\n}", "for…of"],
  ["if", "if (${}) {\n\t${}\n}", "if"],
  ["ife", "if (${}) {\n\t${}\n} else {\n\t${}\n}", "if/else"],
  ["imp", "import ${name} from \"${module}\";", "default import"],
  ["impn", "import { ${} } from \"${module}\";", "named import"],
  ["try", "try {\n\t${}\n} catch (${e}) {\n\t${}\n}", "try/catch"],
  ["ec", "export const ${name} = ${};", "export const"],
  ["switch", "switch (${}) {\n\tcase ${}:\n\t\t${}\n\t\tbreak;\n\tdefault:\n\t\t${}\n}", "switch"],
]);
const PY_SNIPPETS = mkSnips([
  ["def", "def ${name}(${}):\n\t${pass}", "function"],
  ["class", "class ${Name}:\n\tdef __init__(self${}):\n\t\t${pass}", "class"],
  ["for", "for ${x} in ${iterable}:\n\t${pass}", "for loop"],
  ["ifmain", "if __name__ == \"__main__\":\n\t${main()}", "main guard"],
  ["try", "try:\n\t${}\nexcept ${Exception} as ${e}:\n\t${pass}", "try/except"],
]);
const SNIPPETS = {
  js: JS_SNIPPETS, mjs: JS_SNIPPETS, cjs: JS_SNIPPETS, jsx: JS_SNIPPETS,
  ts: JS_SNIPPETS, tsx: JS_SNIPPETS, mts: JS_SNIPPETS, cts: JS_SNIPPETS,
  py: PY_SNIPPETS, pyw: PY_SNIPPETS,
};
// Emmet abbreviation expansion applies to markup + stylesheet languages.
const EMMET_LANGS = new Set(["html", "htm", "xhtml", "xml", "svg", "vue", "svelte", "css", "scss", "less"]);

// ---- sticky scroll: pin the enclosing function/class/block/element headers at
// the top of the viewport (VS Code / WebStorm style). Off unless enabled. ----
const MAX_STICKY = 5;
function stickyScroll() {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.raf = 0;
      this.dom = document.createElement("div");
      this.dom.className = "cm-sticky";
      this.dom.style.display = "none";
      this.dom.addEventListener("mousedown", (e) => {
        const el = e.target.closest(".cm-sticky-line");
        if (el && el.dataset.line) {
          e.preventDefault();
          const n = +el.dataset.line;
          if (n >= 1 && n <= view.state.doc.lines) {
            const l = view.state.doc.line(n);
            view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start" }) });
            view.focus();
          }
        }
      });
      view.dom.appendChild(this.dom);
      this.onScroll = () => this.schedule();
      view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      this.schedule();
    }
    update(u) { if (u.docChanged || u.viewportChanged || u.geometryChanged) this.schedule(); }
    schedule() { if (this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = 0; this.compute(); }); }
    compute() {
      const view = this.view;
      try {
        const top = view.scrollDOM.scrollTop;
        const block = view.lineBlockAtHeight(top + 1);
        const doc = view.state.doc;
        const topLine = doc.lineAt(block.from);
        const tree = syntaxTree(view.state);
        const headers = [];
        const seen = new Set();
        if (tree) {
          let node = tree.resolveInner(block.from, -1);
          // walk ancestors but skip the outermost (document root) — pinning the
          // whole-file node's first line ("package main", "<!doctype>") is noise.
          for (let cur = node; cur && cur.parent; cur = cur.parent) {
            if (cur.from < 0 || cur.to > doc.length) continue;
            const fl = doc.lineAt(cur.from);
            const tl = doc.lineAt(Math.min(cur.to, doc.length));
            if (tl.number - fl.number < 1) continue;       // single-line node — skip
            if (fl.number >= topLine.number) continue;      // header still visible — skip
            if (seen.has(fl.number)) continue;
            const txt = fl.text;
            if (!txt.trim()) continue;
            seen.add(fl.number);
            headers.push({ line: fl.number, text: txt });
          }
        }
        headers.sort((a, b) => a.line - b.line);
        const show = headers.slice(-MAX_STICKY);
        if (!show.length) { if (this.dom.style.display !== "none") { this.dom.style.display = "none"; this.dom.textContent = ""; } return; }
        // align with the code column (past the gutters)
        const pad = Math.max(0, view.contentDOM.getBoundingClientRect().left - view.scrollDOM.getBoundingClientRect().left);
        this.dom.innerHTML = "";
        for (const hdr of show) {
          const el = document.createElement("div");
          el.className = "cm-sticky-line";
          el.dataset.line = String(hdr.line);
          el.style.paddingLeft = pad + 12 + "px";
          el.textContent = hdr.text.replace(/\t/g, "  ");
          el.title = "Line " + hdr.line;
          this.dom.appendChild(el);
        }
        this.dom.style.display = "block";
      } catch { this.dom.style.display = "none"; }
    }
    destroy() { if (this.raf) cancelAnimationFrame(this.raf); this.view.scrollDOM.removeEventListener("scroll", this.onScroll); this.dom.remove(); }
  });
}

// Ctrl/Cmd-hover → underline the word under the mouse (go-to-def affordance).
const linkMark = Decoration.mark({ class: "cm-link-target" });
const setLink = StateEffect.define();
const linkField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setLink)) deco = e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
function wordRangeAt(text, pos) {
  const isW = (ch) => ch != null && /[A-Za-z0-9_$]/.test(ch);
  let i = pos; if (!isW(text[i]) && isW(text[i - 1])) i--;
  if (!isW(text[i])) return null;
  let s = i, e = i; while (s > 0 && isW(text[s - 1])) s--; while (e < text.length && isW(text[e])) e++;
  return { from: s, to: e };
}

/* ---- custom search panel: find + replace, chevron prev/next, "Aa" case,
 * underlined "ab" word, themed toggles + a live "x of N" count ---- */
function svgIcon(inner) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", "15"); s.setAttribute("height", "15");
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.innerHTML = inner;
  return s;
}
const ICON_CHEVRON = '<path d="m6 9 6 6 6-6"/>';
const ICON_CLOSE = '<path d="M18 6 6 18M6 6l12 12"/>';

// Count matches + the 1-based index at/after the caret (capped; skipped on huge docs).
function matchInfo(view, search, caseSensitive, wholeWord, regexp) {
  if (!search || view.state.doc.length > 3000000) return { total: null, index: 0 };
  let pat = regexp ? search : search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wholeWord) pat = `(?<![\\w$])${pat}(?![\\w$])`;
  let re; try { re = new RegExp(pat, caseSensitive ? "g" : "gi"); } catch { return { total: null, index: 0 }; }
  const text = view.state.doc.toString();
  const caret = view.state.selection.main.from;
  let total = 0, index = 0, m, guard = 0;
  while ((m = re.exec(text)) && guard++ < 200000) {
    if (m[0] === "") { re.lastIndex++; continue; }
    total++;
    if (m.index === caret) index = total;
    else if (!index && m.index >= caret) index = total;
  }
  if (!index && total) index = 1;
  return { total, index };
}

function makeSearchPanel(view) {
  const q0 = getSearchQuery(view.state);
  let caseSensitive = q0.caseSensitive, wholeWord = q0.wholeWord, regexp = !!q0.regexp;

  const dom = document.createElement("div");
  dom.className = "cmfind";

  const findRow = document.createElement("div"); findRow.className = "cmfind-row";
  const replRow = document.createElement("div"); replRow.className = "cmfind-row cmfind-replrow";

  const input = document.createElement("input");
  input.className = "cmfind-input"; input.placeholder = "Find"; input.spellcheck = false;
  input.setAttribute("aria-label", "Find"); input.value = q0.search || "";

  const count = document.createElement("span"); count.className = "cmfind-count";

  const replaceInput = document.createElement("input");
  replaceInput.className = "cmfind-input cmfind-replace-input"; replaceInput.placeholder = "Replace"; replaceInput.spellcheck = false;
  replaceInput.setAttribute("aria-label", "Replace"); replaceInput.value = q0.replace || "";

  const mkOpt = (label, html, on, title) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "cmfind-opt" + (on ? " on" : ""); b.title = title;
    if (html) b.innerHTML = html; else b.textContent = label;
    return b;
  };
  const caseB = mkOpt("Aa", null, caseSensitive, "Match case");
  const wordB = mkOpt(null, "<u>ab</u>", wholeWord, "Match whole word");
  const regexB = mkOpt(".*", null, regexp, "Use regular expression");

  const mkBtn = (extra, svg, title) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "cmfind-btn" + (extra ? " " + extra : ""); b.title = title;
    b.appendChild(svgIcon(svg)); return b;
  };
  const prevB = mkBtn("flip", ICON_CHEVRON, "Previous (Shift+Enter)");
  const nextB = mkBtn("", ICON_CHEVRON, "Next (Enter)");
  const closeB = mkBtn("", ICON_CLOSE, "Close (Esc)");

  const replaceB = document.createElement("button");
  replaceB.type = "button"; replaceB.className = "cmfind-text-btn"; replaceB.textContent = "Replace"; replaceB.title = "Replace (Enter in this field)";
  const replaceAllB = document.createElement("button");
  replaceAllB.type = "button"; replaceAllB.className = "cmfind-text-btn"; replaceAllB.textContent = "All"; replaceAllB.title = "Replace all";

  // Small docs count synchronously (instant); large docs count on a worker core
  // so the find box never janks the UI thread. A token guards against stale async
  // results overwriting a newer query.
  let refreshTok = 0;
  const paint = (info) => {
    count.classList.toggle("none", info.total === 0);
    if (!input.value || info.total == null) count.textContent = "";
    else if (info.total === 0) count.textContent = "No results";
    else count.textContent = `${info.index} of ${info.total}`;
  };
  const refresh = () => {
    const tok = ++refreshTok;
    if (!input.value) { paint({ total: null }); return; }
    if (view.state.doc.length > 16_000_000) { paint({ total: null }); return; }   // too large even for a worker round-trip per keystroke
    if (view.state.doc.length <= 200000) { paint(matchInfo(view, input.value, caseSensitive, wholeWord, regexp)); return; }
    count.textContent = "counting…";
    poolRpc("count", { text: view.state.doc.toString(), search: input.value, caseSensitive, wholeWord, regexp, caret: view.state.selection.main.from })
      .then((info) => { pool.stats.count++; if (tok === refreshTok) paint(info); })
      .catch(() => { if (tok === refreshTok) paint(matchInfo(view, input.value, caseSensitive, wholeWord, regexp)); });
  };
  const apply = () => { view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: input.value, replace: replaceInput.value, caseSensitive, wholeWord, regexp, literal: !regexp })) }); refresh(); };

  input.addEventListener("input", apply);
  replaceInput.addEventListener("input", apply);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) findPrevious(view); else findNext(view); refresh(); }
    else if (e.key === "Escape") { e.preventDefault(); closeSearchPanel(view); view.focus(); }
  });
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); apply(); replaceNext(view); refresh(); }
    else if (e.key === "Escape") { e.preventDefault(); closeSearchPanel(view); view.focus(); }
  });
  caseB.addEventListener("click", () => { caseSensitive = !caseSensitive; caseB.classList.toggle("on", caseSensitive); apply(); input.focus(); });
  wordB.addEventListener("click", () => { wholeWord = !wholeWord; wordB.classList.toggle("on", wholeWord); apply(); input.focus(); });
  regexB.addEventListener("click", () => { regexp = !regexp; regexB.classList.toggle("on", regexp); apply(); input.focus(); });
  prevB.addEventListener("click", () => { findPrevious(view); refresh(); });
  nextB.addEventListener("click", () => { findNext(view); refresh(); });
  closeB.addEventListener("click", () => { closeSearchPanel(view); view.focus(); });
  replaceB.addEventListener("click", () => { apply(); replaceNext(view); refresh(); });
  replaceAllB.addEventListener("click", () => { apply(); replaceAll(view); refresh(); });

  findRow.append(input, count, caseB, wordB, regexB, prevB, nextB, closeB);
  replRow.append(replaceInput, replaceB, replaceAllB);
  dom.append(findRow, replRow);

  return {
    top: true,
    dom,
    mount() {
      if (!input.value) {
        const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
        if (sel && !sel.includes("\n") && sel.length < 100) input.value = sel;
      }
      // mount() runs DURING CM6's panel-open update — dispatching here throws
      // ("update in progress"), so defer the query apply + focus to a microtask.
      Promise.resolve().then(() => { if (input.value) apply(); else refresh(); input.focus(); input.select(); });
    },
    update(u) { if (u.docChanged) refresh(); },
  };
}

// Open the find bar; if a (non-newline) selection exists, populate the box with
// it — and if the bar is already open, refill it from the current selection.
function openFind(view) {
  const m = view.state.selection.main;
  const sel = m.from !== m.to ? view.state.sliceDoc(m.from, m.to) : "";
  const prefill = sel && !sel.includes("\n") && sel.length < 100 ? sel : null;
  if (searchPanelOpen(view.state)) {
    const inp = view.dom.querySelector(".cmfind .cmfind-input");
    if (inp) { if (prefill) { inp.value = prefill; inp.dispatchEvent(new Event("input", { bubbles: true })); } inp.focus(); inp.select(); return true; }
  }
  return openSearchPanel(view);
}

// Marks a transaction that was forwarded from a linked peer view, so the peer's
// dispatch doesn't echo it back (would loop). Used by same-file split panes.
const splitSync = Annotation.define();
// Marks the mirrored half of an auto-rename-tag edit (so it doesn't re-trigger).
const tagSync = Annotation.define();

// ---- linked tag editing (auto-rename tag pairs) for HTML-family grammars ----
// All of these embed the @lezer/html tree (TagName / OpenTag / CloseTag nodes).
const LINKED_TAG_LANGS = new Set(["html", "htm", "xhtml", "xml", "svg", "xsl", "vue", "svelte", "php", "phtml"]);
// Given a caret position inside a tag NAME, return its range + the matching tag's
// name range (open↔close), or null if the caret isn't on a paired tag name.
function pairedTagName(state, pos) {
  const tree = syntaxTree(state);
  if (!tree) return null;
  let n = tree.resolveInner(pos, -1);
  if (!n || n.name !== "TagName") { const r = tree.resolveInner(pos, 1); if (r && r.name === "TagName") n = r; }
  if (!n || n.name !== "TagName") return null;
  const tag = n.parent;
  if (!tag || (tag.name !== "OpenTag" && tag.name !== "CloseTag")) return null;
  const el = tag.parent;
  if (!el) return null;
  const other = el.getChild(tag.name === "OpenTag" ? "CloseTag" : "OpenTag");
  const otherName = other && other.getChild("TagName");
  if (!otherName) return null;
  return { edited: { from: n.from, to: n.to }, paired: { from: otherName.from, to: otherName.to } };
}
function linkedTagPlugin(getLang) {
  return ViewPlugin.fromClass(class {
    update(u) {
      if (!u.docChanged || !LINKED_TAG_LANGS.has(getLang())) return;
      if (u.transactions.some((t) => t.annotation(tagSync) || t.annotation(splitSync))) return;
      // Find the tag pair in the PRE-edit tree (names still matched there), then map
      // both ranges forward through this change — once the names diverge the parser
      // stops pairing them, so we can't recompute from the post-edit state.
      const info = pairedTagName(u.startState, u.startState.selection.main.head);
      if (!info) return;
      // Bias outward so chars typed at the name's edges grow the captured range.
      const ed = { from: u.changes.mapPos(info.edited.from, -1), to: u.changes.mapPos(info.edited.to, 1) };
      const pr = { from: u.changes.mapPos(info.paired.from, -1), to: u.changes.mapPos(info.paired.to, 1) };
      const view = u.view;
      // Dispatch can't happen during update → mirror on a microtask.
      Promise.resolve().then(() => {
        try {
          if (ed.from >= ed.to || pr.from >= pr.to || pr.to > view.state.doc.length) return;
          const name = view.state.sliceDoc(ed.from, ed.to);
          if (!/^[A-Za-z][\w.:-]*$/.test(name)) return;
          if (view.state.sliceDoc(pr.from, pr.to) === name) return;
          view.dispatch({ changes: { from: pr.from, to: pr.to, insert: name }, annotations: tagSync.of(true) });
        } catch { /* ignore */ }
      });
    }
  });
}

// ---- git gutter: a thin coloured bar marking added/changed/removed lines ----
class GitMarker extends GutterMarker {
  constructor(type) { super(); this.type = type; }
  eq(o) { return o.type === this.type; }
  toDOM() { const s = document.createElement("div"); s.className = "cm-gitbar " + this.type; return s; }
}
const setGitMarks = StateEffect.define();
const gitMarksField = StateField.define({
  create() { return RangeSet.empty; },
  update(set, tr) { set = set.map(tr.changes); for (const e of tr.effects) if (e.is(setGitMarks)) set = e.value; return set; },
});
const gitGutterExt = [
  gitMarksField,
  gutter({ class: "cm-git-gutter", markers: (v) => v.state.field(gitMarksField), initialSpacer: () => new GitMarker("none") }),
];

// Inline inlay-hint chip (e.g. `: number` after a var, or `name:` before an arg).
class InlayWidget extends WidgetType {
  constructor(text, padL, padR) { super(); this.text = text; this.padL = padL; this.padR = padR; }
  eq(o) { return o.text === this.text && o.padL === this.padL && o.padR === this.padR; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-inlay"; s.textContent = (this.padL ? " " : "") + this.text + (this.padR ? " " : ""); return s; }
  ignoreEvent() { return true; }
}

let EDITOR_SEQ = 0;
export function createEditor(parent, opts = {}) {
  let peer = null;   // linked peer editor for same-file split (set via linkPeer)
  const langComp = new Compartment();
  const stickyComp = new Compartment();
  const lintComp = new Compartment();        // grammar syntax-error lint
  const semanticComp = new Compartment();    // TypeScript type-aware diagnostics
  const highlightComp = new Compartment();   // grammar syntax highlighting (colours)
  const wrapComp = new Compartment();        // line wrapping
  const bracketComp = new Compartment();     // bracket-pair colours
  const emmetComp = new Compartment();       // Emmet abbreviation tracker (markup/css)
  const indentComp = new Compartment();      // indent unit + tab size (EditorConfig)
  const guidesComp = new Compartment();     // vertical indent guides
  const wsComp = new Compartment();          // render whitespace
  const inlayComp = new Compartment();       // inlay hints (parameter names / inferred types)
  const selMatchComp = new Compartment();    // highlight-other-occurrences of the selection
  let wrapped = !!opts.wrap;
  const edId = ++EDITOR_SEQ;
  let docToken = 0;   // bumped per loaded document → keys the worker's incremental cache
  let currentLang = "";
  let semanticActive = opts.semantic !== false;
  let bracketUser = opts.bracketColors !== false;
  // A language has semantic features when a backend (TS service or an LSP server)
  // supports it — opts.semanticLangs is the app-supplied set of such extensions.
  const isSemantic = () => (opts.semanticLangs && opts.semanticLangs.has(currentLang)) || SEMANTIC_LANGS.has(currentLang);

  /* ---- adaptive large-file policy ----
   * Whole-document features get expensive as the doc grows; gate them by size so
   * typing stays at frame rate. */
  const BIG = { selMatch: 100_000, brackets: 500_000 };
  let policyLen = -1;
  function applySizePolicy(force) {
    const len = view.state.doc.length;
    const tier = (len > BIG.brackets ? 2 : len > BIG.selMatch ? 1 : 0);
    const prev = (policyLen > BIG.brackets ? 2 : policyLen > BIG.selMatch ? 1 : policyLen < 0 ? -1 : 0);
    if (!force && tier === prev) { policyLen = len; return; }
    policyLen = len;
    view.dispatch({ effects: [
      selMatchComp.reconfigure(len <= BIG.selMatch ? highlightSelectionMatches() : []),
      bracketComp.reconfigure(bracketUser && len <= BIG.brackets ? bracketColors() : []),
    ] });
  }

  // Grammar syntax-error lint — off-thread on a worker core when the language has
  // a raw Lezer parser; falls back to the main-thread tree walk otherwise.
  const lintSource = (v) => {
    if (v.state.doc.length > 16_000_000) return [];   // very large file → skip lint (matches the worker cap)
    // TS-family files get precise syntax errors ("'=' expected.") from the TypeScript
    // service's syntactic pass — skip the generic Lezer "Syntax error" underline so
    // the vague message never duplicates/masks the precise one. Above ~1.5MB the TS
    // round-trip gets slow, so the fast incremental Lezer pass stays authoritative.
    if (semanticActive && isSemantic() && SEMANTIC_LANGS.has(currentLang) && v.state.doc.length <= 1_500_000) return [];
    if (WORKER_LINT_LANGS.has(currentLang)) {
      return poolRpc("lint", { lang: currentLang, text: v.state.doc.toString(), docId: edId + ":" + docToken })
        .then((r) => { pool.stats.lint++; return (r.diagnostics || []).map(([from, to]) => ({ from, to, severity: "error", message: "Syntax error" })); })
        .catch(() => treeLinter(v));
    }
    return treeLinter(v);
  };
  // Semantic (type-aware) diagnostics — fetched via opts.semanticProvider, which
  // calls the project-wide TypeScript service in the main process.
  const semanticSource = (v) => {
    if (!isSemantic() || v.state.doc.length > MAX_SEMANTIC_BYTES || typeof opts.semanticProvider !== "function") return [];
    return Promise.resolve(opts.semanticProvider(v.state.doc.toString()))
      .then((diags) => {
        sem.count++;
        const len = v.state.doc.length, out = [];
        for (const d of (diags || [])) {
          const from = Math.max(0, Math.min(d.from, len));
          if (from >= len) continue;
          out.push({ from, to: Math.max(from + 1, Math.min(d.to, len)), severity: d.severity || "error", message: d.message || "Problem" });
        }
        return out;
      })
      .catch(() => []);
  };
  const grammarLinter = linter(lintSource, { delay: 500 });
  const semanticLinter = linter(semanticSource, { delay: 700 });

  /* ---- IntelliSense from the project-wide TS service (opts.tsRequest) ---- */
  const tsReq = (kind, extra) => (isSemantic() && typeof opts.tsRequest === "function")
    ? Promise.resolve(opts.tsRequest(kind, { text: view.state.doc.toString(), ...(extra || {}) })).catch(() => null)
    : Promise.resolve(null);
  function applyEdits(edits) {
    if (!edits || !edits.length) return;
    try { view.dispatch({ changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.text })) }); } catch { /* overlapping/stale — ignore */ }
  }
  // TS-powered completion (members, types, auto-import); falls back to the
  // language's own completion sources for non-JS/TS files.
  async function tsComplete(context) {
    if (!isSemantic() || typeof opts.tsRequest !== "function") return null;
    const word = context.matchBefore(/[\w$]+/);
    const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
    if (!context.explicit && !word && !".'\"/@<".includes(before)) return null;
    const res = await tsReq("completions", { pos: context.pos });
    if (!res || !res.entries || !res.entries.length) return null;
    const from = res.optionalReplace ? res.optionalReplace.from : (word ? word.from : context.pos);
    const pos = context.pos;
    return {
      from,
      validFor: /[\w$]*/,
      options: res.entries.map((e) => ({
        label: e.name,
        type: TS_KIND[e.kind] || "variable",
        detail: e.source ? "Auto import" : undefined,
        boost: /^0/.test(e.sortText || "") ? 2 : (/^1/.test(e.sortText || "") ? 1 : 0),
        apply: (e.hasAction || e.source) ? tsApply(e, pos) : (e.insertText || e.name),
        info: () => tsInfo(e, pos),
      })),
    };
  }
  function tsApply(entry, pos) {
    return (v, completion, from, to) => {
      const insert = entry.insertText || entry.name;
      v.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
      tsReq("completionDetails", { pos, name: entry.name, source: entry.source, data: entry.data })
        .then((d) => { if (d && d.importEdits && d.importEdits.length) applyEdits(d.importEdits); });
    };
  }
  function tsInfo(entry, pos) {
    return tsReq("completionDetails", { pos, name: entry.name, source: entry.source, data: entry.data }).then((d) => {
      if (!d) return null;
      const dom = document.createElement("div"); dom.className = "cm-ts-info";
      const sig = document.createElement("div"); sig.className = "cm-ts-info-sig"; sig.textContent = d.display || entry.name; dom.appendChild(sig);
      if (d.doc) { const doc = document.createElement("div"); doc.className = "cm-ts-info-doc"; doc.textContent = d.doc; dom.appendChild(doc); }
      return dom;
    });
  }
  async function completionDispatch(context) {
    if (isSemantic()) { const r = await tsComplete(context); if (r) return r; }
    for (const src of context.state.languageDataAt("autocomplete", context.pos)) {
      try { const r = typeof src === "function" ? await src(context) : null; if (r) return r; } catch { /* ignore */ }
    }
    // Last resort (VS Code-style): word-based suggestions from the document, so an
    // `any`-typed receiver still offers SOMETHING. Skipped on huge docs (full scan).
    if (context.state.doc.length < 500_000 && context.matchBefore(/[\w$]+/)) {
      try { return completeAnyWord(context); } catch { /* ignore */ }
    }
    return null;
  }
  function snippetSource(context) {
    const list = SNIPPETS[currentLang];
    if (!list) return null;
    const word = context.matchBefore(/[\w$]+/);
    if (!word && !context.explicit) return null;
    return { from: word ? word.from : context.pos, options: list, validFor: /[\w$]*/ };
  }
  // Hover → type signature + JSDoc.
  const tsHover = hoverTooltip(async (v, pos) => {
    const r = await tsReq("hover", { pos });
    if (!r || !r.display) return null;
    return {
      pos: r.from != null ? r.from : pos, end: r.to,
      create: () => {
        const dom = document.createElement("div"); dom.className = "cm-ts-hover";
        const sig = document.createElement("div"); sig.className = "cm-ts-hover-sig"; sig.textContent = r.display; dom.appendChild(sig);
        if (r.doc) { const doc = document.createElement("div"); doc.className = "cm-ts-hover-doc"; doc.textContent = r.doc; dom.appendChild(doc); }
        return { dom };
      },
    };
  }, { hoverTime: 300 });
  // Signature help → parameter hints while inside a call.
  let sigTimer = 0;
  const setSig = StateEffect.define();
  const sigField = StateField.define({
    create() { return null; },
    update(val, tr) { for (const e of tr.effects) if (e.is(setSig)) val = e.value; return val; },
    provide: (f) => showTooltip.from(f),
  });
  function clearSig() { if (view.state.field(sigField, false)) view.dispatch({ effects: setSig.of(null) }); }
  function refreshSig() {
    if (!isSemantic() || typeof opts.tsRequest !== "function") { clearSig(); return; }
    const pos = view.state.selection.main.head;
    tsReq("signature", { pos }).then((r) => {
      if (!r) { clearSig(); return; }
      view.dispatch({ effects: setSig.of({
        pos, above: true,
        create: () => {
          const dom = document.createElement("div"); dom.className = "cm-ts-sig";
          (r.params || []).forEach((pt, i) => {
            const sp = document.createElement("span"); sp.textContent = pt; if (i === r.activeParam) sp.className = "active"; dom.appendChild(sp);
            if (i < r.params.length - 1) dom.appendChild(document.createTextNode(", "));
          });
          if (!r.params || !r.params.length) dom.textContent = r.label;
          return { dom };
        },
      }) });
    });
  }
  const sigPlugin = ViewPlugin.fromClass(class {
    update(u) {
      if (!(u.docChanged || u.selectionSet)) return;
      const head = u.state.selection.main.head;
      const before = u.state.sliceDoc(Math.max(0, head - 1), head);
      clearTimeout(sigTimer);
      if (u.docChanged && (before === "(" || before === ",")) sigTimer = setTimeout(refreshSig, 120);
      else if (before === ")") clearSig();
      else if (u.state.field(sigField, false)) sigTimer = setTimeout(refreshSig, 160);
    }
  });
  async function runFormat() {
    const edits = await tsReq("format", {});
    if (!edits || !edits.length) return false;
    applyEdits(edits);
    return true;
  }

  /* ---- inlay hints: fetch for the visible range, render as inline widgets ---- */
  const setInlay = StateEffect.define();
  const inlayField = StateField.define({
    create() { return Decoration.none; },
    update(deco, tr) { deco = deco.map(tr.changes); for (const e of tr.effects) if (e.is(setInlay)) deco = e.value; return deco; },
    provide: (f) => EditorView.decorations.from(f),
  });
  let inlayTimer = 0;
  function refreshInlay(v) {
    if (!isSemantic() || typeof opts.tsRequest !== "function" || v.state.doc.length > MAX_SEMANTIC_BYTES) {
      if (v.state.field(inlayField, false)) v.dispatch({ effects: setInlay.of(Decoration.none) });
      return;
    }
    const { from, to } = v.viewport;
    tsReq("inlayHints", { start: from, end: to }).then((hints) => {
      const b = new RangeSetBuilder();
      let last = -1;
      for (const h of (hints || []).slice().sort((a, c) => a.pos - c.pos)) {
        const pos = Math.max(0, Math.min(h.pos, v.state.doc.length));
        if (pos === last) continue;   // one chip per position
        last = pos;
        b.add(pos, pos, Decoration.widget({ widget: new InlayWidget(h.text, h.paddingLeft, h.paddingRight), side: 1 }));
      }
      v.dispatch({ effects: setInlay.of(b.finish()) });
    }).catch(() => {});
  }
  const inlayPlugin = ViewPlugin.fromClass(class {
    constructor(v) { clearTimeout(inlayTimer); inlayTimer = setTimeout(() => refreshInlay(v), 400); }
    update(u) { if (u.docChanged || u.viewportChanged) { clearTimeout(inlayTimer); inlayTimer = setTimeout(() => refreshInlay(u.view), 400); } }
    destroy() { clearTimeout(inlayTimer); }
  });
  const inlayExt = [inlayField, inlayPlugin];

  const view = new EditorView({
    parent,
    doc: opts.doc || "",
    // Forward doc changes to a linked peer (same-file split). Selection/scroll/
    // folds stay independent — only the document edits are mirrored. The splitSync
    // annotation breaks the echo loop; we preserve the user-event for clean undo.
    dispatchTransactions: (trs, v) => {
      v.update(trs);
      if (!peer) return;
      for (const tr of trs) {
        if (tr.changes.empty || tr.annotation(splitSync)) continue;
        const anns = [splitSync.of(true)];
        const ue = tr.annotation(Transaction.userEvent);
        if (ue) anns.push(Transaction.userEvent.of(ue));
        try { peer.view.dispatch({ changes: tr.changes, annotations: anns }); } catch { /* peer gone */ }
      }
    },
    extensions: [
      gitGutterExt,
      lineNumbers(),
      foldGutter(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      bracketMatching(),
      codeFolding(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true, defaultKeymap: false, icons: true, maxRenderedOptions: 40, override: [completionDispatch, snippetSource] }),
      emmetComp.of([]),
      tsHover,
      sigField,
      sigPlugin,
      guidesComp.of(opts.indentGuides ? indentationMarkers({ thickness: 1, highlightActiveBlock: true, hideFirstIndent: true }) : []),
      indentOnInput(),
      indentComp.of([indentUnit.of("  "), EditorState.tabSize.of(2)]),
      selMatchComp.of(highlightSelectionMatches()),
      EditorState.allowMultipleSelections.of(true),
      search({ top: true, createPanel: (v) => makeSearchPanel(v) }),
      lintGutter(),
      highlightComp.of(opts.highlight === false ? [] : syntaxHighlighting(aqxHighlight)),
      aqxTheme,
      langComp.of([]),
      lintComp.of(opts.lint === false ? [] : grammarLinter),
      semanticComp.of(opts.semantic === false ? [] : semanticLinter),
      stickyComp.of(opts.sticky ? stickyScroll() : []),
      wrapComp.of(opts.wrap ? EditorView.lineWrapping : []),
      bracketComp.of(opts.bracketColors === false ? [] : bracketColors()),
      wsComp.of(opts.whitespace ? highlightWhitespace() : []),
      inlayComp.of(opts.inlayHints ? inlayExt : []),
      colorSwatches(() => currentLang),
      linkedTagPlugin(() => currentLang),
      // notify the app shell when the diagnostic set changes (Problems panel)
      ViewPlugin.fromClass(class { constructor() { this.n = -1; } update(u) { if (!opts.onDiagnostics) return; let c = 0; try { forEachDiagnostic(u.state, () => { c++; }); } catch { /* ignore */ } if (c !== this.n) { this.n = c; opts.onDiagnostics(); } } }),
      linkField,
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => { opts.onSave && opts.onSave(); return true; } },
        { key: "Mod-f", preventDefault: true, run: (v) => { openFind(v); return true; } },
        { key: "Mod-/", preventDefault: true, run: toggleComment },
        { key: "Mod-d", preventDefault: true, run: selectNextOccurrence },
        { key: "Shift-Alt-f", preventDefault: true, run: () => { if (opts.onFormat) opts.onFormat(); else runFormat(); return true; } },
        { key: "Mod-.", preventDefault: true, run: () => { if (opts.onQuickFix) { const s = view.state.selection.main; opts.onQuickFix(s.from, s.to); return true; } return false; } },
        { key: "F2", preventDefault: true, run: () => { if (opts.onRename) { opts.onRename(view.state.selection.main.head); return true; } return false; } },
        { key: "Mod-g", preventDefault: true, run: () => { if (opts.onGoToLine) { opts.onGoToLine(); return true; } return false; } },
        { key: "Alt-z", preventDefault: true, run: () => { wrapped = !wrapped; view.dispatch({ effects: wrapComp.reconfigure(wrapped ? EditorView.lineWrapping : []) }); return true; } },
        { key: "Ctrl-Alt-ArrowUp", preventDefault: true, run: (v) => addCursorVertical(v, -1) },
        { key: "Ctrl-Alt-ArrowDown", preventDefault: true, run: (v) => addCursorVertical(v, 1) },
        // VS Code parity: move/copy/delete/duplicate line
        { key: "Alt-ArrowUp", preventDefault: true, run: moveLineUp },
        { key: "Alt-ArrowDown", preventDefault: true, run: moveLineDown },
        { key: "Shift-Alt-ArrowUp", preventDefault: true, run: copyLineUp },
        { key: "Shift-Alt-ArrowDown", preventDefault: true, run: copyLineDown },
        { key: "Mod-Shift-k", preventDefault: true, run: deleteLine },
        { key: "Mod-Shift-l", preventDefault: true, run: selectAllOccurrences },
        { key: "Mod-Shift-/", preventDefault: true, run: toggleBlockComment },
        { key: "Mod-Shift-d", preventDefault: true, run: duplicateLineCmd },
        // syntax-aware selection (VS Code: Shift+Alt+Right/Left) + join lines (Ctrl+J)
        { key: "Shift-Alt-ArrowRight", preventDefault: true, run: expandSelectionCmd },
        { key: "Shift-Alt-ArrowLeft", preventDefault: true, run: shrinkSelectionCmd },
        { key: "Mod-j", preventDefault: true, run: joinLinesCmd },
        // snippet field navigation (only when inside an active snippet)
        { key: "Tab", run: (v) => hasNextSnippetField(v.state) ? nextSnippetField(v) : false },
        { key: "Shift-Tab", run: (v) => hasPrevSnippetField(v.state) ? prevSnippetField(v) : false },
        { key: "Escape", run: clearSnippet },
        indentWithTab,
        ...closeBracketsKeymap, ...completionKeymap,
        ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        // No payload: building the full doc string per keystroke is O(n) — the app
        // shell reads docText() lazily only when it actually needs the content.
        if (u.docChanged && opts.onChange) { opts.onChange(); applySizePolicy(false); }
        if ((u.selectionSet || u.docChanged) && opts.onCursor) {
          const head = u.state.selection.main.head; const ln = u.state.doc.lineAt(head);
          opts.onCursor(ln.number, head - ln.from + 1, u.state.doc.lines);
        }
      }),
      EditorView.domEventHandlers({
        scroll(e, v) { if (opts.onScroll) opts.onScroll(v.scrollDOM.scrollTop); },
        mousedown(e, v) {
          if ((e.ctrlKey || e.metaKey) && !e.altKey && opts.onGotoDef) { const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }); if (pos != null) { e.preventDefault(); opts.onGotoDef(pos); return true; } }
          // Smart double-click: select ONE identifier segment. The dot separates,
          // so "testers.test" selects just "testers"; "my_var"/"cd-pl" stay whole.
          if (e.detail === 2 && e.button === 0 && !e.ctrlKey && !e.metaKey) {
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos == null) return;
            const doc = v.state.doc;
            const from = Math.max(0, pos - 200), to = Math.min(doc.length, pos + 200);
            const win = v.state.sliceDoc(from, to);
            const isW = (ch) => ch != null && /[\w\-$]/.test(ch);   // word chars + - $, NOT '.'
            let i = pos - from;
            if (!isW(win[i]) && isW(win[i - 1])) i--;
            if (!isW(win[i])) return;
            let s = i, en = i;
            while (s > 0 && isW(win[s - 1])) s--;
            while (en < win.length && isW(win[en])) en++;
            e.preventDefault();
            v.dispatch({ selection: { anchor: from + s, head: from + en } });
            return true;
          }
        },
        contextmenu(e, v) {
          if (opts.onContextMenu) { e.preventDefault(); opts.onContextMenu(e.clientX, e.clientY); return true; }
        },
        mousemove(e, v) {
          if (!(e.ctrlKey || e.metaKey)) { if (v.state.field(linkField).size) v.dispatch({ effects: setLink.of(null) }); v.scrollDOM.classList.remove("cm-ctrl"); return; }
          v.scrollDOM.classList.add("cm-ctrl");
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          const w = pos == null ? null : wordRangeAt(v.state.doc.toString(), pos);
          const cur = v.state.field(linkField);
          const has = cur.size > 0;
          if (w) { let same = false; cur.between(w.from, w.to, () => { same = true; }); if (!same || !has) v.dispatch({ effects: setLink.of(w) }); }
          else if (has) v.dispatch({ effects: setLink.of(null) });
        },
        mouseleave(e, v) { if (v.state.field(linkField).size) v.dispatch({ effects: setLink.of(null) }); v.scrollDOM.classList.remove("cm-ctrl"); },
        keyup(e, v) { if (!(e.ctrlKey || e.metaKey) && v.state.field(linkField).size) { v.dispatch({ effects: setLink.of(null) }); v.scrollDOM.classList.remove("cm-ctrl"); } },
      }),
    ],
  });

  // Load a language asynchronously and swap it in (no-op if the view is gone).
  let langSeq = 0;
  function applyLang(lang) {
    currentLang = (lang || "").toLowerCase();
    try { view.dispatch({ effects: emmetComp.reconfigure(EMMET_LANGS.has(currentLang) ? abbreviationTracker() : []) }); } catch { /* ignore */ }
    const my = ++langSeq;
    Promise.resolve(langFor(lang)).then((ext) => {
      if (my !== langSeq) return;   // a newer setDoc/setLang superseded this one
      view.dispatch({ effects: langComp.reconfigure(ext || []) });
    }).catch(() => {});
  }

  applySizePolicy(true);   // gate features for the initial document

  return {
    view,
    dom: view.dom,
    getValue: () => view.state.doc.toString(),
    setDoc(text, lang) {
      docToken++;   // new document → fresh incremental-parse cache key in the worker
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text || "" }, selection: { anchor: 0 } });
      if (lang !== undefined) applyLang(lang);
      applySizePolicy(true);   // gate whole-doc features by the new document's size
    },
    setLang(lang) { applyLang(lang); },
    setSticky(on) { view.dispatch({ effects: stickyComp.reconfigure(on ? stickyScroll() : []) }); },
    setLint(on) { view.dispatch({ effects: lintComp.reconfigure(on ? grammarLinter : []) }); },
    setSemantic(on) { semanticActive = !!on; view.dispatch({ effects: semanticComp.reconfigure(on ? semanticLinter : []) }); try { forceLinting(view); } catch { /* ignore */ } },
    forceRelint() { try { forceLinting(view); } catch { /* ignore */ } },
    setHighlight(on) { view.dispatch({ effects: highlightComp.reconfigure(on ? syntaxHighlighting(aqxHighlight) : []) }); },
    setWrap(on) { wrapped = !!on; view.dispatch({ effects: wrapComp.reconfigure(on ? EditorView.lineWrapping : []) }); },
    setBracketColors(on) { bracketUser = !!on; applySizePolicy(true); },
    setWhitespace(on) { view.dispatch({ effects: wsComp.reconfigure(on ? highlightWhitespace() : []) }); },
    setInlayHints(on) { view.dispatch({ effects: inlayComp.reconfigure(on ? inlayExt : []) }); },
    setIndentGuides(on) { view.dispatch({ effects: guidesComp.reconfigure(on ? indentationMarkers({ thickness: 1, highlightActiveBlock: true, hideFirstIndent: true }) : []) }); },
    // git gutter: marks = [{line, type:"add"|"change"|"del"}] (1-based lines).
    setGitGutter(marks) {
      const docLines = view.state.doc.lines;
      const built = (marks || []).filter((m) => m.line >= 1 && m.line <= docLines).sort((a, b) => a.line - b.line)
        .map((m) => new GitMarker(m.type).range(view.state.doc.line(m.line).from));
      view.dispatch({ effects: setGitMarks.of(RangeSet.of(built, true)) });
    },
    // persistent fold state (per file): capture folded ranges, and restore them.
    getFolds() { const out = []; try { foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => out.push({ from, to })); } catch { /* ignore */ } return out; },
    setFolds(ranges) {
      if (!ranges || !ranges.length) return;
      const len = view.state.doc.length;
      const effects = ranges.filter((r) => r && r.from < r.to && r.to <= len).map((r) => foldEffect.of({ from: r.from, to: r.to }));
      if (effects.length) { try { ensureSyntaxTree(view.state, len, 2000); } catch { /* ignore */ } view.dispatch({ effects }); }
    },
    // EditorConfig: set indent unit + tab size for this document.
    setIndent(size, useTabs) {
      const n = Math.max(1, Math.min(size || 2, 8));
      const unit = useTabs ? "\t" : " ".repeat(n);
      view.dispatch({ effects: indentComp.reconfigure([indentUnit.of(unit), EditorState.tabSize.of(n)]) });
    },
    // On-save normalisation: trim trailing whitespace + ensure a final newline.
    // Applied as editor edits so the doc + saved content stay in sync.
    normalizeWhitespace(trim, finalNewline) {
      const doc = view.state.doc, changes = [];
      if (trim) {
        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i), m = /[ \t]+$/.exec(line.text);
          if (m) changes.push({ from: line.to - m[0].length, to: line.to, insert: "" });
        }
      }
      if (finalNewline && doc.length > 0 && doc.line(doc.lines).text.length > 0) changes.push({ from: doc.length, to: doc.length, insert: "\n" });
      if (changes.length) view.dispatch({ changes });
      return view.state.doc.toString();
    },
    focus() { view.focus(); },
    gotoOffset(off, len) {
      const max = view.state.doc.length; const a = Math.min(off, max), b = Math.min(off + (len || 0), max);
      view.dispatch({ selection: { anchor: a, head: b }, effects: EditorView.scrollIntoView(a, { y: "center" }) });
      view.focus();
    },
    gotoLine(line, col, word) {
      const n = Math.max(1, Math.min(line, view.state.doc.lines));
      const l = view.state.doc.line(n);
      let from = l.from + Math.max(0, (col || 1) - 1), to = from;
      if (word) { const idx = l.text.indexOf(word); if (idx >= 0) { from = l.from + idx; to = from + word.length; } }
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
      view.focus();
    },
    wordAt(pos) { const w = wordRangeAt(view.state.doc.toString(), pos); return w ? { word: view.state.doc.sliceString(w.from, w.to), from: w.from, to: w.to } : null; },
    docText: () => view.state.doc.toString(),
    slice: (a, b) => view.state.sliceDoc(a, b),
    lineOf: (pos) => view.state.doc.lineAt(pos).number,
    getScrollTop: () => view.scrollDOM.scrollTop,
    setScrollTop: (v) => { view.scrollDOM.scrollTop = v || 0; },
    // --- selection / editing (used by the editor context menu) ---
    cursor: () => view.state.selection.main.head,
    selection() { const s = view.state.selection.main; return { from: s.from, to: s.to, empty: s.empty, text: view.state.sliceDoc(s.from, s.to) }; },
    lineRangeAt(pos) { const l = view.state.doc.lineAt(pos); return { from: l.from, to: l.to, text: l.text }; },
    replaceRange(from, to, insert) { view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + (insert ? insert.length : 0) } }); view.focus(); },
    selectRange(from, to) { view.dispatch({ selection: { anchor: from, head: to } }); view.focus(); },
    selectAll() { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); view.focus(); },
    sortLines(desc) { const r = sortSelectedLines(view, !!desc); view.focus(); return r; },
    joinLines() { const r = joinLinesCmd(view); view.focus(); return r; },
    moveLineUp() { return moveLineUp(view); }, moveLineDown() { return moveLineDown(view); },
    copyLineUp() { return copyLineUp(view); }, copyLineDown() { return copyLineDown(view); },
    deleteLine() { return deleteLine(view); },
    duplicateLine() { return duplicateLineCmd(view); },
    selectAllOccurrences() { return selectAllOccurrences(view); },
    toggleBlockComment() { return toggleBlockComment(view); },
    expandSelection() { return expandSelectionCmd(view); },
    shrinkSelection() { return shrinkSelectionCmd(view); },
    remeasure() { view.requestMeasure(); },
    openSearch() { openFind(view); },
    undo() { undo(view); }, redo() { redo(view); },
    foldAll() { try { ensureSyntaxTree(view.state, view.state.doc.length, 3000); } catch { /* ignore */ } foldAll(view); },
    unfoldAll() { unfoldAll(view); },
    // ---- IntelliSense helpers exposed for the app shell (quick-fix / rename UI) ----
    formatDoc() { return opts.onFormat ? opts.onFormat() : runFormat(); },
    applyEdits(edits) { applyEdits(edits); },
    coordsAtPos(pos) { try { return view.coordsAtPos(pos); } catch { return null; } },
    requestTs(kind, extra) { return tsReq(kind, extra); },   // test/automation hook
    foldedCount() { let n = 0; try { foldedRanges(view.state).between(0, view.state.doc.length, () => { n++; }); } catch { /* ignore */ } return n; },
    // ---- introspection (used by smoke tests) ----
    hasLanguage() { try { return !!view.state.facet(language); } catch { return false; } },
    diagnosticCount() { let n = 0; try { forEachDiagnostic(view.state, () => { n++; }); } catch { /* ignore */ } return n; },
    workerStats() { return { lint: pool.stats.lint, count: pool.stats.count, semantic: sem.count, workers: pool.workers.filter(Boolean).length, poolSize: pool.size }; },
    diagnostics() { const out = []; try { forEachDiagnostic(view.state, (d, from, to) => out.push({ from, to, severity: d.severity, message: d.message })); } catch { /* ignore */ } return out; },
    diagnosticsDetailed() {
      const out = [];
      try {
        forEachDiagnostic(view.state, (d, from, to) => {
          const l = view.state.doc.lineAt(from);
          out.push({ from, to, severity: d.severity, message: d.message, line: l.number, col: from - l.from + 1 });
        });
      } catch { /* ignore */ }
      out.sort((a, b) => a.from - b.from);
      return out;
    },
    // benchmark hook: time a worker lint of `text` (force-bypasses the size cap);
    // reuse the same docId across calls to measure incremental re-parse.
    benchLint(lang, text, docId) {
      const t0 = performance.now();
      return poolRpc("lint", { lang, text, docId, force: true }, 120000)
        .then((r) => ({ count: (r.diagnostics || []).length, incremental: !!r.incremental, workerMs: r.ms || 0, rttMs: performance.now() - t0 }));
    },
    stickyActive() { const el = view.dom.querySelector(".cm-sticky"); return !!(el && el.style.display !== "none" && el.children.length); },
    // ---- same-file split linkage ----
    // Link so this editor's doc edits mirror into `other` (call on both to sync
    // bidirectionally). Docs MUST be identical at link time, or positions drift.
    linkPeer(other) { peer = other || null; },
    unlinkPeer() { peer = null; },
    isLinked() { return !!peer; },
    destroy() { peer = null; view.destroy(); },
  };
}
