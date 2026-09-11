/* Unified workspace context (auto-included into every run) + prevent-sleep:
 *  - context.compose gathers EVERY graph/tree AtomNano maintains into one
 *    token-budgeted block: project memory graph + file tree + dependency
 *    load-bearing files + available skills
 *  - the block is bounded
 *  - the prevent-sleep setting persists (drives powerSaveBlocker in main)
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-context");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, "src"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "package.json"), '{"name":"demo","scripts":{"test":"node t"}}\n');
  fs.writeFileSync(path.join(DIR, "src", "b.js"), "exports.base=(a,b)=>a+b;\n");
  fs.writeFileSync(path.join(DIR, "src", "a.js"), "const {base}=require('./b'); exports.compute=(x)=>base(x,1);\n");

  const udir = path.join(os.tmpdir(), "atomnano-context-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && window.atomnano && window.atomnano.context, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const CWD = DIR.replace(/\\/g, "/");

  // seed a couple of graphs: a recorded run (project memory) + a skill
  await win.evaluate((cwd) => window.atomnano.graph.record(cwd, { prompt: "add auth login flow", files: [{ path: cwd + "/src/a.js", added: 12, removed: 1 }] }), CWD);
  await win.evaluate((cwd) => window.atomnano.skills.create(cwd, { name: "Add REST endpoint", description: "wire a new route", steps: "1 route 2 handler", triggers: ["endpoint", "route"] }), CWD);

  /* ---------- compose pulls from every graph/tree ---------- */
  const ctx = await win.evaluate((cwd) => window.atomnano.context.peek(cwd), CWD);
  ok(/Project memory/.test(ctx.text), "context includes the project memory graph");
  ok(/add auth login flow/.test(ctx.text), "…with the recorded recent work");
  ok(/Project structure/.test(ctx.text) && /src\//.test(ctx.text), "context includes the project tree shape");
  ok(/Load-bearing files/.test(ctx.text) && /b\.js \(1/.test(ctx.text), `context includes dependency load-bearing files (${(ctx.text.match(/Load-bearing[^\n]*/) || [""])[0]})`);
  ok(/Available project skills/.test(ctx.text) && /Add REST endpoint/.test(ctx.text), "context includes available skills");
  ok(ctx.chars > 0 && ctx.chars <= 2801, `composed block is bounded (${ctx.chars} chars)`);

  /* ---------- prevent-sleep setting persists ---------- */
  const set = await win.evaluate(() => window.atomnano.settings.set({ preventSleep: true }));
  ok(set.preventSleep === true, "prevent-sleep setting is accepted");
  const got = await win.evaluate(() => window.atomnano.settings.get());
  ok(got.preventSleep === true, "prevent-sleep setting persists (drives powerSaveBlocker in main)");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME CONTEXT TESTS FAILED" : "\nALL CONTEXT TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
