/* Project-wide Problems: scan all TS files in the program for diagnostics. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-projprob");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noUnusedLocals: true, target: "ES2020", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["."] }, null, 2));
  // open file is clean; a SIBLING file has errors → only a project scan finds them
  fs.writeFileSync(path.join(DIR, "ok.ts"), "export const ok = 1;\nexport {};\n");
  fs.writeFileSync(path.join(DIR, "bad.ts"), "const x: number = \"nope\";\nlet unused = 5;\nexport {};\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__scanProjectProblems === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  await win.evaluate((p) => window.__openInEditor(p), P("ok.ts"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(800);

  // the open file is clean
  const fileDiags = await win.evaluate(() => window.__cm().diagnostics().length);
  ok(fileDiags === 0, `the open file (ok.ts) has no diagnostics (${fileDiags})`);

  // project scan finds the errors in bad.ts
  const proj = await win.evaluate(() => window.__scanProjectProblems());
  ok(proj.length >= 2, `project scan found problems in sibling files (${proj.length})`);
  ok(proj.some((d) => /bad\.ts$/.test(d.file)), "problems include the unopened bad.ts");
  await win.waitForTimeout(200);
  const rows = await win.evaluate(() => document.querySelectorAll("#editorProblems .ep-item").length);
  ok(rows >= 2, `Problems panel lists the project problems (${rows})`);
  const hasProjectTab = await win.evaluate(() => [...document.querySelectorAll("#editorProblems .ep-tab")].some((t) => t.textContent === "Project" && t.classList.contains("active")));
  ok(hasProjectTab, "the 'Project' scope tab is active");

  ok(errors.length === 0, "no page errors during the project-problems flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME PROJECT-PROBLEMS TESTS FAILED" : "\nALL PROJECT-PROBLEMS TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
