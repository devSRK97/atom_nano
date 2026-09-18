"use strict";
/* Module-graph check: require() every hand-written main-process module under a stubbed
 * `electron`, so a broken relative path or a load-time error is caught without launching the app.
 * Skips the files that only run inside another process (workers, utility process, preloads, the
 * app entry). Exit 1 on any failure.  node scripts/check-requires.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const ROOT = path.join(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-reqcheck-"));
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, "claude-home"); fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
process.env.CODEX_HOME = path.join(HOME, "codex-home"); fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

// Anything Electron-shaped answers with a harmless object / function.
const noop = () => {};
const anything = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : k === "getPath" ? (kind) => (kind === "userData" ? HOME : os.homedir()) : k === "getAppPath" ? () => ROOT : k === "isPackaged" ? false : k === "getVersion" ? () => "check" : anything), apply: () => anything, construct: () => anything });
const electronStub = new Proxy({}, { get: (_t, k) => (k === "app" ? anything : anything) });
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === "electron") return electronStub; return origLoad.call(this, req, ...rest); };

const SKIP = new Set(["src/main/main.js", "src/main/preload.js", "src/main/lang/ts-host.js", "src/main/db/db-io-worker.js", "src/main/workspace/search-worker.js", "src/main/testing/testhost-preload.js"]);
function walk(dir, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.isFile() && p.endsWith(".js")) out.push(p); } return out; }
const files = [...walk(path.join(ROOT, "src", "main")), ...walk(path.join(ROOT, "src", "cli"))].map((p) => path.relative(ROOT, p).replace(/\\/g, "/")).sort();
let failed = 0;
for (const rel of files) {
  if (SKIP.has(rel)) { console.log("skip", rel); continue; }
  try { require(path.join(ROOT, rel)); console.log("ok  ", rel); }
  catch (e) { failed++; console.log("FAIL", rel, "—", (e && e.message) || e); }
}
// Every relative require() must point at a file that exists (catches paths only hit at runtime).
let dangling = 0;
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  for (const m of src.matchAll(/require\((["'])(\.{1,2}\/[^"'\n]+)\1\)/g)) {
    const spec = m[2];
    if (/calc$/.test(spec)) continue;                 // a test fixture string inside main.js
    const target = path.resolve(path.dirname(path.join(ROOT, rel)), spec);
    if (!fs.existsSync(target) && !fs.existsSync(target + ".js") && !fs.existsSync(path.join(target, "index.js"))) { dangling++; console.log("DANGLING", rel, "→", spec); }
  }
}
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${files.length - SKIP.size} modules loaded, ${failed} failed, ${dangling} dangling require paths`);
if (failed || dangling) process.exit(1);
