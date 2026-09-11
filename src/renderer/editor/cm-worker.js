/* AtomNano editor worker — runs on a separate core (Web Worker).
 *
 * The EditorView/DOM must stay on the main thread, but the CPU-heavy,
 * parallelisable work does not. This worker:
 *   - parses a document with the raw Lezer grammar and returns syntax-error
 *     ranges (so large files can be linted without janking the UI thread), and
 *   - counts find matches over the whole document (uncapped).
 * It uses the raw @lezer/* parsers only (no @codemirror/view), so it stays lean
 * and never touches the DOM. Bundled by esbuild → cm-worker.bundle.js. */
import { TreeFragment } from "@lezer/common";
import { parser as jsParser } from "@lezer/javascript";
import { parser as pyParser } from "@lezer/python";
import { parser as jsonParser } from "@lezer/json";
import { parser as cssParser } from "@lezer/css";
import { parser as sassParser } from "@lezer/sass";
import { parser as htmlParser } from "@lezer/html";
import { parser as goParser } from "@lezer/go";
import { parser as rustParser } from "@lezer/rust";
import { parser as javaParser } from "@lezer/java";
import { parser as yamlParser } from "@lezer/yaml";
import { parser as xmlParser } from "@lezer/xml";
import { parser as cppParser } from "@lezer/cpp";
import { parser as phpParser } from "@lezer/php";

const MAX_LINT_BYTES = 16_000_000;   // above this, skip lint (even off-thread); incremental re-parse keeps edits cheap up to here
const cache = Object.create(null);

function parserFor(lang) {
  if (lang in cache) return cache[lang];
  let p = null;
  try {
    switch (lang) {
      case "js": case "mjs": case "cjs": case "jsx": p = jsParser.configure({ dialect: "jsx" }); break;
      case "ts": case "tsx": case "mts": case "cts": p = jsParser.configure({ dialect: "ts jsx" }); break;
      case "py": case "pyw": case "pyi": p = pyParser; break;
      case "json": p = jsonParser; break;
      case "css": p = cssParser; break;
      case "scss": p = sassParser; break;
      case "html": case "htm": case "xhtml": p = htmlParser; break;
      case "go": p = goParser; break;
      case "rs": p = rustParser; break;
      case "java": p = javaParser; break;
      case "yaml": case "yml": p = yamlParser; break;
      case "xml": case "svg": case "xsd": case "xsl": case "plist": p = xmlParser; break;
      case "c": case "h": case "cpp": case "cc": case "cxx": case "hpp": case "hh": case "ino": p = cppParser; break;
      case "php": case "phtml": p = phpParser; break;
      default: p = null;
    }
  } catch { p = null; }
  cache[lang] = p;
  return p;
}

// Per-document parse cache for INCREMENTAL re-parsing: keep the previous text +
// tree fragments per docId, so an edit re-parses only the changed span (Lezer
// reuses the rest). A small LRU cap bounds memory (each entry holds one doc).
const LINT_CACHE = new Map();
const LINT_CACHE_MAX = 3;
function cacheSet(docId, entry) {
  LINT_CACHE.delete(docId);
  LINT_CACHE.set(docId, entry);
  while (LINT_CACHE.size > LINT_CACHE_MAX) LINT_CACHE.delete(LINT_CACHE.keys().next().value);
}
// Smallest single replaced span between two strings (common prefix + suffix).
// A zero-length result (identical text) makes applyChanges a no-op → full reuse.
function diffRange(a, b) {
  const al = a.length, bl = b.length, min = Math.min(al, bl);
  let s = 0;
  while (s < min && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let ea = al, eb = bl;
  while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) { ea--; eb--; }
  return { fromA: s, toA: ea, fromB: s, toB: eb };
}

// Parse (incrementally when we have a prior tree for docId) + collect Lezer
// error-node ranges. Returns { diagnostics, incremental, ms }.
function lint(lang, text, docId, force) {
  const p = parserFor(lang);
  if (!p || !text || (text.length > MAX_LINT_BYTES && !force)) return { diagnostics: [], incremental: false, ms: 0 };
  const t0 = (self.performance && self.performance.now) ? self.performance.now() : Date.now();
  let tree, incremental = false;
  const prev = docId != null ? LINT_CACHE.get(docId) : null;
  try {
    if (prev && prev.lang === lang && prev.fragments) {
      const frags = TreeFragment.applyChanges(prev.fragments, [diffRange(prev.text, text)]);
      tree = p.parse(text, frags);
      incremental = true;
    } else {
      tree = p.parse(text);
    }
  } catch {
    try { tree = p.parse(text); incremental = false; } catch { return { diagnostics: [], incremental: false, ms: 0 }; }
  }
  if (docId != null) cacheSet(docId, { text, fragments: TreeFragment.addTree(tree), lang });
  const out = [];
  let last = -1;
  tree.iterate({
    enter(n) {
      if (out.length >= 200) return false;
      if (!n.type.isError) return;
      const from = n.from, to = Math.min(Math.max(n.to, from + 1), text.length);
      if (from === last) return;
      last = from;
      out.push([from, to]);
    },
  });
  const ms = ((self.performance && self.performance.now) ? self.performance.now() : Date.now()) - t0;
  return { diagnostics: out, incremental, ms };
}

// Count matches + the 1-based index at/after the caret (for the find "x of N").
function count(text, search, caseSensitive, wholeWord, caret, regexp) {
  if (!search) return { total: null, index: 0 };
  let pat = regexp ? search : search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wholeWord) pat = `(?<![\\w$])${pat}(?![\\w$])`;
  let re;
  try { re = new RegExp(pat, caseSensitive ? "g" : "gi"); } catch { return { total: null, index: 0 }; }
  let total = 0, index = 0, m, guard = 0;
  while ((m = re.exec(text)) && guard++ < 5_000_000) {
    if (m[0] === "") { re.lastIndex++; continue; }
    total++;
    if (m.index === caret) index = total;
    else if (!index && m.index >= caret) index = total;
  }
  if (!index && total) index = 1;
  return { total, index };
}

self.onmessage = (e) => {
  const d = e.data || {};
  const id = d.id;
  try {
    if (d.type === "lint") { const r = lint(d.lang, d.text, d.docId, d.force); self.postMessage({ id, diagnostics: r.diagnostics, incremental: r.incremental, ms: r.ms }); }
    else if (d.type === "count") self.postMessage({ id, ...count(d.text, d.search, d.caseSensitive, d.wholeWord, d.caret, d.regexp) });
    else self.postMessage({ id, error: "unknown request" });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
