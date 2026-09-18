"use strict";
/* Static cross-check (no Electron): every db./dbio. method the IPC layer calls exists in the
 * module's export list, every db:* channel preload invokes has a main handler, and every db bridge
 * method the Database Manager UI calls exists in preload. Run: node scripts/_xcheck-db-ipc.js */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const listJs = (rel) => { const dir = path.join(ROOT, rel); return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort().map((f) => rel + "/" + f) : []; };
// The IPC layer: the bootstrap plus every handler module under src/main/ipc.
const mainFiles = ["src/main/main.js", ...listJs("src/main/ipc")];
const main = mainFiles.map(read).join("\n");
// `const db = require("../db/db")` (ipc/) or `require("./db/db")` (main.js) → the module under src/main/db.
const reqs = [...main.matchAll(/const\s+(\w+)\s*=\s*require\("\.\.?\/db\/(db(?:-io)?)"\)/g)].map((m) => [m[1], m[2]]);
let bad = 0;
if (!reqs.length) { bad++; console.log("no db requires found in the IPC layer — the regex is stale"); }
const exp = (file) => {
  const s = read("src/main/db/" + file + ".js");
  const m = /module\.exports\s*=\s*\{([\s\S]*?)\n\};|module\.exports\s*=\s*\{([^\n]*)\};/.exec(s);
  const body = (m[1] || m[2]).replace(/\/\/.*$/mg, "").replace(/__internals:\s*\{[^}]*\}/, "");
  return new Set(body.split(",").map((x) => x.trim().split(":")[0].trim()).filter(Boolean));
};
const seen = new Set();
for (const [v, f] of reqs) {
  if (seen.has(v + f)) continue; seen.add(v + f);
  const ex = exp(f);
  const used = new Set([...main.matchAll(new RegExp("[^A-Za-z0-9_.]" + v + "[.]([A-Za-z0-9_]+)[(]", "g"))].map((m) => m[1]));
  const missing = [...used].filter((u) => !ex.has(u));
  if (missing.length) bad++;
  console.log(`${v} -> db/${f}: ${used.size} methods used, missing: ${JSON.stringify(missing)}`);
}
const pre = read("src/main/preload.js");
const chans = new Set([...main.matchAll(/handle\("(db:[^"]+)"/g)].map((m) => m[1]));
const pchans = [...pre.matchAll(/invoke\("(db:[^"]+)"/g)].map((m) => m[1]);
const orphan = pchans.filter((c) => !chans.has(c));
if (orphan.length) bad++;
console.log(`main handlers: ${chans.size}, preload invokes: ${pchans.length}, preload channels without a handler: ${JSON.stringify(orphan)}`);
// The Database Manager UI: the single dbm.js, or its split modules under src/renderer/db.
const rendFiles = fs.existsSync(path.join(ROOT, "src/renderer/dbm.js")) ? ["src/renderer/dbm.js"] : listJs("src/renderer/db");
if (!rendFiles.length) { bad++; console.log("no Database Manager renderer source found"); }
const rend = rendFiles.map(read).join("\n");
const preMethods = new Set([...pre.slice(pre.indexOf("db: {")).matchAll(/^\s+(\w+):\s*\(/mg)].map((m) => m[1]));
const rUsed = new Set([...rend.matchAll(/atom\(\)\.db\.(\w+)/g)].map((m) => m[1]));
const rMissing = [...rUsed].filter((u) => !preMethods.has(u));
if (rMissing.length) bad++;
console.log(`renderer (${rendFiles.length} file${rendFiles.length === 1 ? "" : "s"}) uses ${rUsed.size} db bridge methods, missing in preload: ${JSON.stringify(rMissing)}`);
process.exitCode = bad ? 1 : 0;
