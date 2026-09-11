/* Test Director hardening (consult enhancements):
 *  - AST analysis (TypeScript parser): classify by real imports; assertion counting
 *    that IGNORES strings/comments; node-precise mutation that never touches a `>`
 *    inside a string literal
 *  - dependency-graph impact selection: changing a file selects tests that
 *    TRANSITIVELY import it (not just tests that name it)
 *  - hermetic browser: frozen clock + seeded RNG → two runs are byte-identical
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-tdast");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, "src"), { recursive: true });
  // dependency chain: a → b ; c is unrelated
  fs.writeFileSync(path.join(DIR, "src", "b.js"), "exports.base=(a,b)=>a+b;\n");
  fs.writeFileSync(path.join(DIR, "src", "a.js"), "const {base}=require('./b'); exports.compute=(x)=>base(x,1);\n");
  fs.writeFileSync(path.join(DIR, "src", "c.js"), "exports.other=()=>1;\n");

  const udir = path.join(os.tmpdir(), "atomnano-tdast-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && window.atomnano && window.atomnano.test && window.atomnano.test.astProbe, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const CWD = DIR.replace(/\\/g, "/");

  /* ---------- AST is active ---------- */
  const avail = await win.evaluate(() => window.atomnano.test.astProbe("available"));
  ok(avail === true, "AST analyzer (TypeScript parser) is available");

  /* ---------- AST classify by real imports ---------- */
  const cReact = await win.evaluate(() => window.atomnano.test.astProbe("classify", "import React from 'react'; export const A=()=><div/>"));
  ok(cReact && cReact.adapter === "browser" && cReact.domain === "frontend", `react JSX → browser/frontend (${JSON.stringify(cReact)})`);
  const cExp = await win.evaluate(() => window.atomnano.test.astProbe("classify", "import express from 'express'; const a=express();"));
  ok(cExp && cExp.adapter === "node" && cExp.domain === "backend", `express → node/backend (${JSON.stringify(cExp)})`);

  /* ---------- AST assertion counting ignores strings ---------- */
  const asr = await win.evaluate(() => window.atomnano.test.astProbe("assertions", "const note='call expect(z) please'; test('x',()=>{ expect(1).toBe(1); assert(true); })"));
  ok(asr && asr.count === 2, `assertion count ignores the string "expect(z)" → 2 real (got ${asr && asr.count})`);
  const skip = await win.evaluate(() => window.atomnano.test.astProbe("assertions", "it.skip('x',()=>{ expect(1).toBe(1); })"));
  ok(skip && skip.hasSkipOnly === true, "AST detects it.skip()");

  /* ---------- AST mutation is node-precise (never mutates a string) ---------- */
  const muts = await win.evaluate(() => window.atomnano.test.astProbe("mutate", "const s = 'a > b'; function f(x){ return x > 0; }"));
  ok(Array.isArray(muts) && muts.length >= 1, `AST produced mutants (${muts && muts.length})`);
  ok(muts.every((m) => /'a > b'/.test(m.code)), "the `>` inside the STRING literal is never mutated");
  ok(muts.some((m) => /return x < 0/.test(m.code)), "the real `x > 0` operator IS mutated to `x < 0`");

  /* ---------- dependency-graph impact selection ---------- */
  await win.evaluate((cwd) => Promise.all([
    window.atomnano.testdir.upsert(cwd, { title: "covers A", adapter: "node", category: "regression", file: "t-a.js", coveredFiles: [cwd + "/src/a.js"] }),
    window.atomnano.testdir.upsert(cwd, { title: "covers C", adapter: "node", category: "regression", file: "t-c.js", coveredFiles: [cwd + "/src/c.js"] }),
  ]), CWD);
  const impacted = await win.evaluate(({ cwd }) => window.atomnano.testdir.select(cwd, { changedFiles: [cwd + "/src/b.js"] }), { cwd: CWD });
  const titles = impacted.map((t) => t.title);
  ok(titles.includes("covers A"), `changing src/b.js selects the test covering src/a.js (a imports b) — ${JSON.stringify(titles)}`);
  ok(!titles.includes("covers C"), "the unrelated test (covers C) is NOT selected");

  /* ---------- hermetic browser: frozen clock + seeded RNG → identical runs ---------- */
  const FIX = "<div id='r'></div><script>document.getElementById('r').textContent=Date.now()+'|'+Math.random();</script>";
  const run1 = await win.evaluate((html) => window.atomnano.testhost.run({ html }, [{ type: "expectText", selector: "#r", contains: "1577836800000" }]), FIX);
  const run2 = await win.evaluate((html) => window.atomnano.testhost.run({ html }, [{ type: "expectText", selector: "#r", contains: "1577836800000" }]), FIX);
  ok(run1.steps[0].ok, `clock is frozen to the fixed epoch (${run1.steps[0].detail})`);
  ok(run1.steps[0].detail === run2.steps[0].detail, `two runs are byte-identical — deterministic clock + RNG (${run1.steps[0].detail})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME AST/HARDENING TESTS FAILED" : "\nALL AST/HARDENING TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
