/* Capabilities graph + 5-minute decision timer:
 *  - capabilities.compose derives the project's surface (npm commands, HTTP routes,
 *    exported API) and folds into the auto-context block
 *  - a permission/decision prompt shows a live countdown; answering flashes a
 *    green tick; an un-answered prompt auto-declines after the deadline
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-caps");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "package.json"), '{"name":"demo","scripts":{"dev":"node server","test":"node t"}}\n');
  fs.writeFileSync(path.join(DIR, "server.js"),
    "import express from 'express';\nconst app = express();\napp.get('/users', (q,r)=>r.json([]));\napp.post('/login', (q,r)=>r.send('ok'));\napp.delete('/users/:id', (q,r)=>r.end());\nexport function start(){ app.listen(3000); }\n");

  const udir = path.join(os.tmpdir(), "atomnano-caps-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && typeof window.__injectPerm === "function" && window.atomnano.capabilities, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const CWD = DIR.replace(/\\/g, "/");

  /* ---------- capabilities graph ---------- */
  const caps = await win.evaluate((cwd) => window.atomnano.capabilities.peek(cwd), CWD);
  ok(caps.commands.includes("dev") && caps.commands.includes("test"), `commands derived from package.json scripts (${caps.commands.join(",")})`);
  ok(caps.routes.includes("GET /users") && caps.routes.includes("POST /login") && caps.routes.includes("DELETE /users/:id"), `HTTP routes derived from source (${caps.routes.join(" · ")})`);
  ok(caps.exports.includes("start"), `exported API derived (${caps.exports.join(",")})`);
  const ctx = await win.evaluate((cwd) => window.atomnano.context.peek(cwd), CWD);
  ok(/Project capabilities/.test(ctx.text) && /HTTP routes/.test(ctx.text), "capabilities fold into the auto-context block");

  /* ---------- 5-minute decision timer + green tick ---------- */
  const sid = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l[0] && l[0].id));
  await win.evaluate((sid) => window.__reloadTab(sid), sid);
  await win.waitForTimeout(300);

  await win.evaluate(() => window.__injectPerm("Bash", 300000));
  await win.waitForTimeout(150);
  const info1 = await win.evaluate(() => window.__permInfo());
  ok(info1.pending === 1 && /^\d:\d\d$/.test(info1.countdown || ""), `decision prompt shows a live countdown (${info1.countdown})`);
  const answered = await win.evaluate(() => window.__answerPerm());
  const info2 = await win.evaluate(() => window.__permInfo());
  ok(answered && info2.tick && info2.answeredVisible, "answering flashes a green tick");
  await win.waitForTimeout(1300);
  const info3 = await win.evaluate(() => window.__permInfo());
  ok(info3.total === 0, "the answered prompt clears after the tick");

  /* ---------- auto-decline on timeout ---------- */
  await win.evaluate(() => window.__injectPerm("Bash", 1100));
  await win.waitForTimeout(3600);
  const info4 = await win.evaluate(() => window.__permInfo());
  ok(info4.total === 0 && info4.pending === 0, "an un-answered prompt auto-declines after its deadline");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME CAPS/PERM TESTS FAILED" : "\nALL CAPS/PERM TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
