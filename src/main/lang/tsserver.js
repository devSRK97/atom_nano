"use strict";
/* Project-wide TypeScript diagnostics, in the main (Node) process.
 *
 * Runs the real TypeScript language service with a filesystem-backed host, so it
 * resolves tsconfig, sibling files, and node_modules/@types exactly like VS Code's
 * tsserver — full project-wide type checking, not single-file. The open document's
 * unsaved text is layered on top via an overlay; everything else is read from disk.
 * One cached service per project root (the renderer process stays free for the UI). */
const ts = require("typescript");
const fs = require("fs");
const path = require("path");

const services = new Map();   // projectRoot -> { ls, overlay: Map<file,{text,version}>, options }
const MAX_PROJECTS = 4;

function normal(p) { return (p || "").replace(/\\/g, "/"); }

// Defaults for projects WITHOUT a tsconfig — mirror VS Code's inferred-project
// friendliness (default-import interop, .json imports) rather than strict tsc.
const DEFAULT_OPTIONS = {
  allowJs: true, checkJs: false, target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX, strict: false,
  esModuleInterop: true, allowSyntheticDefaultImports: true, resolveJsonModule: true,
};
function configFor(cfgPath) {
  try {
    const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config || {}, ts.sys, path.dirname(cfgPath));
    // Cap the root set so a giant monorepo can't blow up the program; over the cap
    // we fall back to overlay-only (single-file) which still covers diagnostics.
    const fileNames = (parsed.fileNames || []).map(normal);
    return { options: parsed.options, fileNames: fileNames.length <= 4000 ? fileNames : [] };
  } catch { return null; }
}
// Find the project for a FILE: the nearest tsconfig/jsconfig searching up from the
// file's own directory (so nested/monorepo packages get their own config + paths).
// Falls back to the opened folder with default options.
function findProject(root, file) {
  try {
    const cfg = ts.findConfigFile(path.dirname(file), ts.sys.fileExists, "tsconfig.json")
      || ts.findConfigFile(path.dirname(file), ts.sys.fileExists, "jsconfig.json");
    if (cfg) return { dir: normal(path.dirname(cfg)), cfg };
  } catch { /* fall through */ }
  return { dir: normal(root), cfg: null };
}

function getService(dir, cfg) {
  let s = services.get(dir);
  if (s) return s;
  const overlay = new Map();
  const cfgData = cfg ? configFor(cfg) : null;
  const options = { ...((cfgData && cfgData.options) || DEFAULT_OPTIONS), noEmit: true, skipLibCheck: true, allowNonTsExtensions: true };
  // Root the program at all project files (so cross-file find-references works), plus
  // any overlaid (open) file. The service still parses files lazily on demand.
  const projectFiles = (cfgData && cfgData.fileNames) || [];
  const host = {
    getScriptFileNames: () => (projectFiles.length ? [...new Set([...projectFiles, ...overlay.keys()])] : [...overlay.keys()]),
    getScriptVersion: (f) => {
      const o = overlay.get(normal(f));
      if (o) return "o" + o.version;
      try { return "d" + fs.statSync(f).mtimeMs; } catch { return "0"; }
    },
    getScriptSnapshot: (f) => {
      const o = overlay.get(normal(f));
      if (o) return ts.ScriptSnapshot.fromString(o.text);
      try { return ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8")); } catch { return undefined; }
    },
    getCurrentDirectory: () => dir,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  s = { ls: ts.createLanguageService(host, ts.createDocumentRegistry()), overlay, options };
  services.set(dir, s);
  if (services.size > MAX_PROJECTS) { const k = services.keys().next().value; services.get(k).ls.dispose(); services.delete(k); }
  return s;
}

// Overlay the (unsaved) text of the file being edited, then return its service.
function prep(root, file, text) {
  root = normal(root); file = normal(file);
  const { dir, cfg } = findProject(root, file);
  const s = getService(dir, cfg);
  const prev = s.overlay.get(file);
  s.overlay.clear();
  s.overlay.set(file, { text: text || "", version: (prev ? prev.version : 0) + 1 });
  return { s, file };
}
const parts = (p) => ts.displayPartsToString(p || []);
function mapChanges(fileChanges) {
  return (fileChanges || []).map((fc) => ({
    fileName: normal(fc.fileName),
    edits: (fc.textChanges || []).map((tc) => ({ from: tc.span.start, to: tc.span.start + tc.span.length, text: tc.newText })),
  }));
}
const FORMAT = {
  baseIndentSize: 0, indentSize: 2, tabSize: 2, newLineCharacter: "\n", convertTabsToSpaces: true,
  indentStyle: ts.IndentStyle.Smart,
  insertSpaceAfterCommaDelimiter: true,
  insertSpaceAfterSemicolonInForStatements: true,
  insertSpaceBeforeAndAfterBinaryOperators: true,
  insertSpaceAfterKeywordsInControlFlowStatements: true,
  insertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
  insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
  semicolons: ts.SemicolonPreference.Ignore,
};

// Core built-ins that only go "missing" when the default lib didn't load.
const CORE_GLOBALS = /^(Array|String|Boolean|Number|Object|Function|RegExp|RegExpExecArray|Symbol|Promise|Map|Set|WeakMap|WeakSet|Math|Date|Error|JSON|Record|Readonly|Partial|Pick|Omit|Awaited|ReturnType|Iterator|IterableIterator|IArguments|ArrayLike|PropertyKey|Uint8Array|ArrayBuffer)$/;
function libMissingSentinel(d) {
  if (!d) return false;
  if (d.code === 2318) return true;   // "Cannot find global type 'X'."
  if (d.code === 2304 || d.code === 2552 || d.code === 2593) {   // "Cannot find name 'X'."
    const m = /Cannot find name '([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, " "));
    if (m && CORE_GLOBALS.test(m[1])) return true;
  }
  return false;
}

function diagnose(root, file, text) {
  if (!root || !file) return [];
  const { s, file: f } = prep(root, file, text);
  // Plain JS (no checkJs) → SYNTACTIC diagnostics only. Semantic type-checking of
  // untyped JS produces a flood of false "cannot find name Array/String/Record…"
  // errors whenever the lib/types aren't set up (the common case for hand-written
  // JS), which would wrongly trip the self-heal loop. Real parse errors are
  // syntactic and always kept. TS files and checkJs projects still get full
  // semantic diagnostics.
  const isJs = /\.(js|jsx|mjs|cjs)$/i.test(f);
  const checkJs = !!(s.options && s.options.checkJs);
  const semanticOff = isJs && !checkJs;
  let raw;
  try {
    const syn = s.ls.getSyntacticDiagnostics(f);
    let sem = semanticOff ? [] : s.ls.getSemanticDiagnostics(f);
    // Lib-missing guard (covers .ts too): when TypeScript's default lib.*.d.ts
    // fails to load — common in a PACKAGED app where the lib files aren't
    // reachable on disk — it reports 2318 "Cannot find global type 'Array'…"
    // and 2304 "Cannot find name 'String'…" for built-ins, and then EVERY
    // expression cascades into false errors. That single sentinel means the
    // entire semantic batch is unreliable → drop it (syntactic parse errors,
    // the ones self-heal should act on, are always kept).
    if (sem.length && sem.some((d) => libMissingSentinel(d))) sem = [];
    raw = [...syn, ...sem, ...s.ls.getSuggestionDiagnostics(f)];
  }
  catch { return []; }
  const out = [];
  for (const d of raw) {
    if (d.start == null || (d.file && normal(d.file.fileName) !== f)) continue;
    if (out.length >= 400) break;
    out.push({
      from: d.start, to: d.start + Math.max(1, d.length || 1),
      severity: d.category === ts.DiagnosticCategory.Error ? "error" : d.category === ts.DiagnosticCategory.Warning ? "warning" : "info",
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"), code: d.code,
    });
  }
  return out;
}

// Project-wide diagnostics: typecheck every source file in the program (capped).
function projectDiagnostics(root, file, text) {
  const { s } = prep(root, file, text);
  const program = s.ls.getProgram && s.ls.getProgram();
  if (!program) return [];
  const out = [];
  const files = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(sf.fileName));
  for (const sf of files) {
    if (out.length >= 1000) break;
    const fn = normal(sf.fileName);
    let diags;
    try {
      const isJs = /\.(js|jsx|mjs|cjs)$/i.test(fn);
      const checkJs = !!(s.options && s.options.checkJs);
      let sem = (isJs && !checkJs) ? [] : s.ls.getSemanticDiagnostics(fn);
      if (sem.length && sem.some((d) => libMissingSentinel(d))) sem = [];   // lib-missing → drop noise
      diags = [...s.ls.getSyntacticDiagnostics(fn), ...sem];
    } catch { continue; }
    for (const d of diags) {
      if (d.start == null) continue;
      const { line, col } = offToLineCol(sf.text, d.start);
      out.push({ file: fn, line, col, severity: d.category === ts.DiagnosticCategory.Error ? "error" : d.category === ts.DiagnosticCategory.Warning ? "warning" : "info", message: ts.flattenDiagnosticMessageText(d.messageText, "\n") });
      if (out.length >= 1000) break;
    }
  }
  return out;
}

function hover(root, file, text, pos) {
  const { s, file: f } = prep(root, file, text);
  const qi = s.ls.getQuickInfoAtPosition(f, pos);
  if (!qi) return null;
  return { from: qi.textSpan.start, to: qi.textSpan.start + qi.textSpan.length, display: parts(qi.displayParts), doc: parts(qi.documentation) };
}

function completions(root, file, text, pos) {
  const { s, file: f } = prep(root, file, text);
  let info;
  try { info = s.ls.getCompletionsAtPosition(f, pos, { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true, includeCompletionsForImportStatements: true, includePackageJsonAutoImports: "auto", allowIncompleteCompletions: true }); } catch { return null; }
  if (!info) return null;
  const entries = info.entries.slice(0, 300).map((e) => ({
    name: e.name, kind: e.kind, sortText: e.sortText, source: e.source || null,
    hasAction: !!e.hasAction, insertText: e.insertText || null,
    data: e.data || null,
    replace: e.replacementSpan ? { from: e.replacementSpan.start, to: e.replacementSpan.start + e.replacementSpan.length } : null,
  }));
  return { entries, isMember: !!info.isMemberCompletion, optionalReplace: info.optionalReplacementSpan ? { from: info.optionalReplacementSpan.start, to: info.optionalReplacementSpan.start + info.optionalReplacementSpan.length } : null };
}
function completionDetails(root, file, text, pos, name, source, data) {
  const { s, file: f } = prep(root, file, text);
  let d;
  try { d = s.ls.getCompletionEntryDetails(f, pos, name, FORMAT, source || undefined, {}, data || undefined); } catch { return null; }
  if (!d) return null;
  // flatten any code-action edits (auto-import) that apply to THIS file → ready to apply
  const importEdits = [];
  let importDesc = "";
  for (const a of (d.codeActions || [])) {
    if (a.description && !importDesc) importDesc = a.description;
    for (const fc of (a.changes || [])) {
      if (normal(fc.fileName) !== f) continue;
      for (const tc of (fc.textChanges || [])) importEdits.push({ from: tc.span.start, to: tc.span.start + tc.span.length, text: tc.newText });
    }
  }
  return { display: parts(d.displayParts), doc: parts(d.documentation), importEdits, importDesc };
}

function format(root, file, text) {
  const { s, file: f } = prep(root, file, text);
  let edits;
  try { edits = s.ls.getFormattingEditsForDocument(f, FORMAT); } catch { return []; }
  return (edits || []).map((e) => ({ from: e.span.start, to: e.span.start + e.span.length, text: e.newText }));
}

function definition(root, file, text, pos) {
  const { s, file: f } = prep(root, file, text);
  let defs;
  try { defs = s.ls.getDefinitionAtPosition(f, pos); } catch { return null; }
  if (!defs || !defs.length) return null;
  const d = defs.find((x) => normal(x.fileName) !== f) || defs[0];
  return { file: normal(d.fileName), start: d.textSpan.start, length: d.textSpan.length };
}

function codeFixes(root, file, text, start, end) {
  const { s, file: f } = prep(root, file, text);
  let codes = [];
  try {
    codes = [...new Set([...s.ls.getSemanticDiagnostics(f), ...s.ls.getSyntacticDiagnostics(f)]
      .filter((d) => d.start != null && d.start <= end && d.start + (d.length || 0) >= start).map((d) => d.code))];
  } catch { /* ignore */ }
  const fixes = [];
  try { for (const fx of s.ls.getCodeFixesAtPosition(f, start, end, codes, FORMAT, {})) fixes.push({ description: fx.description, fixName: fx.fixName, changes: mapChanges(fx.changes) }); } catch { /* ignore */ }
  try { const o = s.ls.organizeImports({ type: "file", fileName: f }, FORMAT, {}); if (o && o.length) fixes.push({ description: "Organize imports", fixName: "organizeImports", changes: mapChanges(o) }); } catch { /* ignore */ }
  return fixes;
}

const INLAY_PREFS = {
  includeInlayParameterNameHints: "all",
  includeInlayParameterNameHintsWhenArgumentMatchesName: false,
  includeInlayFunctionParameterTypeHints: true,
  includeInlayVariableTypeHints: true,
  includeInlayVariableTypeHintsWhenTypeMatchesName: false,
  includeInlayPropertyDeclarationTypeHints: true,
  includeInlayFunctionLikeReturnTypeHints: true,
  includeInlayEnumMemberValueHints: true,
};
function inlayHints(root, file, text, start, end) {
  const { s, file: f } = prep(root, file, text);
  let hints;
  try { hints = s.ls.provideInlayHints(f, { start: start || 0, length: Math.max(0, (end || text.length) - (start || 0)) }, INLAY_PREFS); }
  catch { return []; }
  return (hints || []).slice(0, 600).map((h) => ({ pos: h.position, text: h.text, paddingLeft: !!h.whitespaceBefore, paddingRight: !!h.whitespaceAfter }));
}

function signature(root, file, text, pos) {
  const { s, file: f } = prep(root, file, text);
  let sh;
  try { sh = s.ls.getSignatureHelpItems(f, pos, {}); } catch { return null; }
  if (!sh || !sh.items.length) return null;
  const it = sh.items[sh.selectedItemIndex] || sh.items[0];
  const params = it.parameters.map((p) => parts(p.displayParts));
  const label = parts(it.prefixDisplayParts) + params.join(parts(it.separatorDisplayParts)) + parts(it.suffixDisplayParts);
  return { label, params, activeParam: sh.argumentIndex, doc: parts(it.documentation) };
}

function offToLineCol(text, off) {
  let line = 1, last = 0;
  const n = Math.min(off, text.length);
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 10) { line++; last = i + 1; }
  return { line, col: off - last + 1 };
}
// Hierarchical document symbols (outline / breadcrumbs / go-to-symbol).
function documentSymbols(root, file, text) {
  const { s, file: f } = prep(root, file, text);
  let tree;
  try { tree = s.ls.getNavigationTree(f); } catch { return []; }
  const out = [];
  const walk = (node, depth) => {
    for (const c of (node.childItems || [])) {
      const span = (c.spans && c.spans[0]) || null;
      if (span) out.push({ name: c.text, kind: c.kind, from: span.start, to: span.start + span.length, depth });
      walk(c, depth + 1);
    }
  };
  walk(tree || {}, 0);
  return out;
}
// All references to the symbol at pos, as {file,line,col} (reads sibling files).
function references(root, file, text, pos) {
  const { s, file: f } = prep(root, file, text);
  let refs;
  try { refs = s.ls.getReferencesAtPosition(f, pos); } catch { return []; }
  if (!refs) return [];
  const cache = new Map([[f, text]]);
  const out = [];
  for (const r of refs.slice(0, 1000)) {
    const fn = normal(r.fileName);
    let content = cache.get(fn);
    if (content == null) { try { content = fs.readFileSync(r.fileName, "utf8"); } catch { content = ""; } cache.set(fn, content); }
    const { line, col } = offToLineCol(content, r.textSpan.start);
    out.push({ file: fn, line, col, isWrite: !!r.isWriteAccess });
  }
  return out;
}

function rename(root, file, text, pos, newName) {
  const { s, file: f } = prep(root, file, text);
  let locs;
  try { locs = s.ls.findRenameLocations(f, pos, false, false, {}); } catch { return null; }
  if (!locs || !locs.length) return null;
  const byFile = {};
  for (const l of locs) {
    const fn = normal(l.fileName);
    (byFile[fn] = byFile[fn] || []).push({ from: l.textSpan.start, to: l.textSpan.start + l.textSpan.length, prefix: l.prefixText || "", suffix: l.suffixText || "" });
  }
  return { newName: newName || "", files: byFile };
}

/* Edits that keep every import pointing at a file after it moves or is renamed.
 *
 * This is the language service's own file-rename support, not a text search: it
 * rewrites relative specifiers in the files that import the moved one AND the
 * relative specifiers INSIDE it that are now resolved from a new directory —
 * the half hand-rolled refactors always miss. Renaming a folder is the same
 * call: pass the old and new directory paths.
 *
 * The service needs a program that already knows the OLD path, so this must run
 * BEFORE the rename lands on disk — see applyRenameEdits in ipc/files.js, which
 * captures the edits first and writes them after. */
function fileRename(root, oldPath, newPath) {
  // NOT prep(): that overlays the file with the caller's text, and here there is
  // none — an empty overlay would blank the very file we're tracking imports to.
  const { dir, cfg } = findProject(normal(root), normal(oldPath));
  const s = getService(dir, cfg);
  if (!s || !s.ls) return null;
  let changes;
  try { changes = s.ls.getEditsForFileRename(normal(oldPath), normal(newPath), FORMAT, {}); }
  catch { return null; }
  if (!changes || !changes.length) return { files: [] };
  return { files: mapChanges(changes) };
}

// Single dispatcher for all on-demand language requests (payload carries text + position).
function request(kind, root, file, payload) {
  if (!root || !file) return null;
  const p = payload || {}, text = p.text || "";
  switch (kind) {
    case "hover": return hover(root, file, text, p.pos);
    case "completions": return completions(root, file, text, p.pos);
    case "completionDetails": return completionDetails(root, file, text, p.pos, p.name, p.source, p.data);
    case "format": return format(root, file, text);
    case "definition": return definition(root, file, text, p.pos);
    case "codeFixes": return codeFixes(root, file, text, p.start, p.end);
    case "signature": return signature(root, file, text, p.pos);
    case "inlayHints": return inlayHints(root, file, text, p.start, p.end);
    case "documentSymbols": return documentSymbols(root, file, text);
    case "projectDiagnostics": return projectDiagnostics(root, file, text);
    case "references": return references(root, file, text, p.pos);
    case "rename": return rename(root, file, text, p.pos, p.newName);
    case "fileRename": return fileRename(root, p.oldPath || file, p.newPath);
    default: return null;
  }
}

module.exports = { diagnose, request };
