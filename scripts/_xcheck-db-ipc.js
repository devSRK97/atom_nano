"use strict";
/* Static cross-check (no Electron): every db./dbio. method main.js calls exists in the module's
 * export list, and every db:* channel preload invokes has a main handler. Run: node scripts/_xcheck-db-ipc.js */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(ROOT, "src/main/main.js"), "utf8");
const reqs = [...main.matchAll(/const\s+(\w+)\s*=\s*require\("\.\/(db(?:-io)?)"\)/g)].map((m) => [m[1], m[2]]);
let bad = 0;
const exp = (file) => {
  const s = fs.readFileSync(path.join(ROOT, "src/main", file + ".js"), "utf8");
  const m = /module\.exports\s*=\s*\{([\s\S]*?)\n\};|module\.exports\s*=\s*\{([^\n]*)\};/.exec(s);
  const body = (m[1] || m[2]).replace(/\/\/.*$/mg, "").replace(/__internals:\s*\{[^}]*\}/, "");
  return new Set(body.split(",").map((x) => x.trim().split(":")[0].trim()).filter(Boolean));
};
for (const [v, f] of reqs) {
  const ex = exp(f);
  const used = new Set([...main.matchAll(new RegExp("[^A-Za-z0-9_.]" + v + "[.]([A-Za-z0-9_]+)[(]", "g"))].map((m) => m[1]));
  const missing = [...used].filter((u) => !ex.has(u));
  if (missing.length) bad++;
  console.log(`${v} -> ${f}: ${used.size} methods used, missing: ${JSON.stringify(missing)}`);
}
const pre = fs.readFileSync(path.join(ROOT, "src/main/preload.js"), "utf8");
const chans = new Set([...main.matchAll(/handle\("(db:[^"]+)"/g)].map((m) => m[1]));
const pchans = [...pre.matchAll(/invoke\("(db:[^"]+)"/g)].map((m) => m[1]);
const orphan = pchans.filter((c) => !chans.has(c));
if (orphan.length) bad++;
console.log(`main handlers: ${chans.size}, preload invokes: ${pchans.length}, preload channels without a handler: ${JSON.stringify(orphan)}`);
const rend = fs.readFileSync(path.join(ROOT, "src/renderer/dbm.js"), "utf8");
const preMethods = new Set([...pre.slice(pre.indexOf("db: {")).matchAll(/^\s+(\w+):\s*\(/mg)].map((m) => m[1]));
const rUsed = new Set([...rend.matchAll(/atom\(\)\.db\.(\w+)/g)].map((m) => m[1]));
const rMissing = [...rUsed].filter((u) => !preMethods.has(u));
if (rMissing.length) bad++;
console.log(`renderer uses ${rUsed.size} db bridge methods, missing in preload: ${JSON.stringify(rMissing)}`);
process.exitCode = bad ? 1 : 0;
