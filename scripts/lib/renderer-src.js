"use strict";
/* Renderer sources for the test harnesses. The former single app.js is a set of ES modules under
 * src/renderer/ (app.js entry + core/ chat/ git/ git/center/ workspace/ panels/ settings/ editor/ db/);
 * the suites that run ORIGINAL renderer functions in headless Chromium extract them by name from
 * whichever module declares them, with the `export` keyword removed so the text runs as a classic
 * script — or load a whole feature folder (db/, git/center/) as one such script (folderSource). */
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const ROOT = path.join(__dirname, "..", "..");
const RDIR = path.join(ROOT, "src", "renderer");
const DIRS = ["", "core", "chat", "db", "git", "git/center", "workspace", "panels", "settings", "editor", "workflow"];

// Every hand-written renderer module (entry + feature folders; bundles / chunks / vendor excluded).
function rendererFiles() {
  const out = [];
  for (const d of DIRS) {
    const dir = path.join(RDIR, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".js") && !f.endsWith(".bundle.js") && !/^cm-/.test(f)) out.push(path.join(dir, f));
  }
  return out.sort();
}
let _texts = null, _asts = null;
function texts() { if (!_texts) _texts = rendererFiles().map((f) => ({ file: f, text: fs.readFileSync(f, "utf8") })); return _texts; }
function asts() { if (!_asts) _asts = texts().map((t) => ({ ...t, ast: ts.createSourceFile(path.basename(t.file), t.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS) })); return _asts; }
// All renderer source concatenated (for static pattern checks).
function rendererSource() { return texts().map((t) => t.text).join("\n"); }
// Text of a (possibly nested) function declaration by name, `export` stripped.
function fn(name) {
  for (const { ast } of asts()) {
    let n = null;
    const visit = (x) => { if (n) return; if (ts.isFunctionDeclaration(x) && x.name && x.name.text === name) { n = x; return; } ts.forEachChild(x, visit); };
    visit(ast);
    if (n) return n.getText(ast).replace(/^export\s+/, "");
  }
  throw new Error("function not found in the renderer modules: " + name);
}
// One-line `const NAME = …;` (or `export const …`) by name, `export` stripped.
function constLine(name, loose = false) {
  const re = new RegExp(loose ? `^(?:export )?const ${name}\\b.*$` : `^(?:export )?const ${name} = .*$`, "m");
  for (const { text } of texts()) { const m = re.exec(text); if (m) return m[0].replace(/^export\s+/, ""); }
  throw new Error("const not found in the renderer modules: " + name);
}
// Text between two markers within the module that contains the start marker (`export` stripped
// first, so markers written for the classic single-file source still match and the block runs as a script).
function block(startMarker, endMarker) {
  for (const { text: raw } of texts()) {
    const text = raw.replace(/^export /mg, "");
    const a = text.indexOf(startMarker); if (a < 0) continue;
    const b = text.indexOf(endMarker, a); if (b < 0) throw new Error("end marker not found after " + startMarker + ": " + endMarker);
    return text.slice(a, b);
  }
  throw new Error("marker not found in the renderer modules: " + startMarker);
}
// One ES module (path relative to src/renderer) as classic-script text: `import` statements and
// `export {…} from` re-exports removed, `export ` prefixes stripped.
function moduleSource(relPath) {
  return fs.readFileSync(path.join(RDIR, relPath), "utf8")
    .replace(/^import\s[^;]*;[ \t]*\n/mg, "")
    .replace(/^export \{[^}]*\}(?: from "[^"]+")?;[ \t]*\n/mg, "")
    .replace(/^export /mg, "");
}
// A whole feature folder as ONE classic script, modules in `order` (file names without .js). Top-level
// code only ever READS another module's binding in the entry's internals objects, so the entry goes last;
// everything else is declarations. `order` must name every .js file in the folder exactly once, so a
// new module cannot be left out of a suite by accident.
function folderSource(dir, order) {
  const files = fs.readdirSync(path.join(RDIR, dir)).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
  const missing = files.filter((f) => !order.includes(f)), unknown = order.filter((f) => !files.includes(f)), dup = order.filter((f, i) => order.indexOf(f) !== i);
  if (missing.length || unknown.length || dup.length) throw new Error(`folderSource(${dir}): order must list every module once — missing ${JSON.stringify(missing)}, unknown ${JSON.stringify(unknown)}, duplicate ${JSON.stringify(dup)}`);
  return order.map((f) => moduleSource(`${dir}/${f}.js`)).join("\n");
}
function css() {
  const dir = path.join(RDIR, "styles");
  if (fs.existsSync(dir)) return fs.readdirSync(dir).filter((f) => f.endsWith(".css")).sort().map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  return fs.readFileSync(path.join(RDIR, "styles.css"), "utf8");
}
module.exports = { rendererFiles, rendererSource, fn, constLine, block, moduleSource, folderSource, css, RDIR };
