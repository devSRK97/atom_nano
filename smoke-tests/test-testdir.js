/* Test Director batch (MVP):
 *  - classifyByImports routes by imports (react→browser, fs→node, express→backend)
 *  - checkIntegrity blocks weakening (fewer assertions / added skip), allows strengthening
 *  - the EMBEDDED Chromium executes a real interaction test (click → assert) — pass + fail
 *  - catalog: upsert browser + node tests; list; selective selection by category + by
 *    changed-file impact; run records pass/fail status
 *  - append-only guard end-to-end: an approved-spec test is LOCKED; a weakened upsert is denied
 *  - flake gate leaves a stable test un-quarantined
 *  - Tests dock renders rows with status + adapter badges
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-testdir");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

const FIXTURE = "<!doctype html><html><body>" +
  "<button id='go'>Go</button><div id='out'>idle</div>" +
  "<script>document.getElementById('go').addEventListener('click',function(){document.getElementById('out').textContent='clicked!';});</script>" +
  "</body></html>";

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  // node-adapter test fixtures (exit code = pass/fail)
  fs.writeFileSync(path.join(DIR, "passing.test.js"), "process.exit(0);\n");
  fs.writeFileSync(path.join(DIR, "failing.test.js"), "process.exit(1);\n");

  const udir = path.join(os.tmpdir(), "atomnano-testdir-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && typeof window.__toggleTests === "function" && window.atomnano && window.atomnano.testdir, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const CWD = DIR.replace(/\\/g, "/");

  /* ---------- 1) capability classification by imports ---------- */
  const cls = await win.evaluate(async () => ({
    react: await window.atomnano.testdir.classify("import React from 'react'\nexport const A=()=><div/>"),
    fsx: await window.atomnano.testdir.classify("const fs=require('fs'); module.exports=()=>fs.readFileSync('x')"),
    exp: await window.atomnano.testdir.classify("import express from 'express'; const a=express()"),
  }));
  ok(cls.react.adapter === "browser" && cls.react.domain === "frontend", `react → browser/frontend (${JSON.stringify(cls.react)})`);
  ok(cls.fsx.adapter === "node" && cls.fsx.domain === "library", `fs → node/library (${JSON.stringify(cls.fsx)})`);
  ok(cls.exp.adapter === "node" && cls.exp.domain === "backend", `express → node/backend (${JSON.stringify(cls.exp)})`);

  /* ---------- 2) integrity guard (pure) ---------- */
  const integ = await win.evaluate(async () => ({
    weaken: await window.atomnano.testdir.integrity({ steps: [{ type: "expectText" }, { type: "expectVisible" }] }, { steps: [{ type: "expectText" }] }),
    strengthen: await window.atomnano.testdir.integrity({ steps: [{ type: "expectText" }] }, { steps: [{ type: "expectText" }, { type: "expectVisible" }] }),
    skip: await window.atomnano.testdir.integrity({ source: "expect(a).toBe(1)" }, { source: "it.skip('x',()=>{expect(a).toBe(1)})" }),
  }));
  ok(integ.weaken.ok === false && /reduced/.test(integ.weaken.violations.join()), "integrity DENIES dropping an assertion");
  ok(integ.strengthen.ok === true, "integrity ALLOWS adding an assertion");
  ok(integ.skip.ok === false && /skip/.test(integ.skip.violations.join()), "integrity DENIES adding skip/only");

  /* ---------- 3) embedded Chromium executes a real interaction test ---------- */
  const passRun = await win.evaluate(async (html) => window.atomnano.testhost.run({ html }, [
    { type: "expectText", selector: "#out", contains: "idle" },
    { type: "click", selector: "#go" },
    { type: "expectText", selector: "#out", contains: "clicked" },
  ]), FIXTURE);
  ok(passRun.ok === true && passRun.steps.length === 3 && passRun.steps.every((s) => s.ok), "embedded browser runs a click→assert flow GREEN");
  const failRun = await win.evaluate(async (html) => window.atomnano.testhost.run({ html }, [{ type: "expectText", selector: "#out", contains: "NEVER" }]), FIXTURE);
  ok(failRun.ok === false && failRun.steps[0].ok === false, "embedded browser reports a failed assertion RED");

  /* ---------- 4) catalog: upsert browser + node tests ---------- */
  const made = await win.evaluate(async ({ cwd, html }) => {
    const b = await window.atomnano.testdir.upsert(cwd, { title: "login click", adapter: "browser", category: "smoke", domain: "frontend", target: { html }, steps: [{ type: "click", selector: "#go" }, { type: "expectText", selector: "#out", contains: "clicked" }], coveredFiles: [cwd + "/src/ui.js"] });
    const p = await window.atomnano.testdir.upsert(cwd, { title: "lib passes", adapter: "node", category: "regression", domain: "library", file: "passing.test.js", coveredFiles: [cwd + "/src/lib.js"] });
    const f = await window.atomnano.testdir.upsert(cwd, { title: "lib fails", adapter: "node", category: "regression", domain: "library", file: "failing.test.js" });
    return { b: b.test, p: p.test, f: f.test };
  }, { cwd: CWD, html: FIXTURE });
  ok(made.b.adapter === "browser" && made.p.adapter === "node", "catalog stored a browser test + a node test");
  const all = await win.evaluate((cwd) => window.atomnano.testdir.list(cwd, {}), CWD);
  ok(all.length === 3, `catalog lists all tests (${all.length})`);

  /* ---------- 5) selective selection ---------- */
  const smoke = await win.evaluate((cwd) => window.atomnano.testdir.select(cwd, { category: "smoke" }), CWD);
  ok(smoke.length === 1 && smoke[0].title === "login click", `select by category=smoke → only the smoke test (${smoke.length})`);
  const impact = await win.evaluate(({ cwd }) => window.atomnano.testdir.select(cwd, { changedFiles: [cwd + "/src/ui.js"] }), { cwd: CWD });
  ok(impact.length === 1 && impact[0].title === "login click", `impact selection: changing src/ui.js → only its test (${impact.length})`);

  /* ---------- 6) run tests (browser + node), status recorded ---------- */
  const runs = await win.evaluate(async ({ cwd, ids }) => ({
    browser: await window.atomnano.testdir.run(cwd, ids.b),
    pass: await window.atomnano.testdir.run(cwd, ids.p),
    fail: await window.atomnano.testdir.run(cwd, ids.f),
  }), { cwd: CWD, ids: { b: made.b.id, p: made.p.id, f: made.f.id } });
  ok(runs.browser.status === "pass", `embedded-browser catalog test runs green (${runs.browser.status})`);
  ok(runs.pass.status === "pass", "node test (exit 0) → pass");
  ok(runs.fail.status === "fail", "node test (exit 1) → fail");

  /* ---------- 7) flake gate keeps a stable test un-quarantined ---------- */
  const flake = await win.evaluate(({ cwd, id }) => window.atomnano.testdir.flakeGate(cwd, [id], 3), { cwd: CWD, id: made.p.id });
  ok(flake[0] && flake[0].flaky === false && flake[0].statuses.length === 3, `stable test not quarantined (${JSON.stringify(flake[0] && flake[0].statuses)})`);

  /* ---------- 8) append-only guard end-to-end (approved spec → locked) ---------- */
  const guard = await win.evaluate(async ({ cwd, html }) => {
    const goal = await window.atomnano.testdir.goalCreate(cwd, { prompt: "login works", spec: [{ id: "b1", text: "clicking Go shows clicked" }] });
    const t = await window.atomnano.testdir.upsert(cwd, { title: "spec login", adapter: "browser", category: "e2e", target: { html }, steps: [{ type: "expectText", selector: "#out", contains: "idle" }, { type: "click", selector: "#go" }, { type: "expectText", selector: "#out", contains: "clicked" }], bulletIds: ["b1"] });
    await window.atomnano.testdir.goalAttach(cwd, goal.id, t.test.id);
    await window.atomnano.testdir.goalApprove(cwd, goal.id);     // locks the test
    // now try to WEAKEN it (drop the two assertions, keep only the click)
    const weakened = await window.atomnano.testdir.upsert(cwd, { id: t.test.id, title: "spec login", adapter: "browser", target: { html }, steps: [{ type: "click", selector: "#go" }] });
    const after = await window.atomnano.testdir.get(cwd, t.test.id);
    return { weakened, lockedNow: after.locked, stepCount: (after.steps || []).length };
  }, { cwd: CWD, html: FIXTURE });
  ok(guard.lockedNow === true, "approving a goal's spec LOCKS its tests");
  ok(guard.weakened.ok === false && /reduced|assertion/.test((guard.weakened.violations || []).join()), "a weakening upsert of a locked test is DENIED");
  ok(guard.stepCount === 3, "the locked test kept its assertions (weakening did not apply)");

  /* ---------- 9) Tests dock renders the catalog ---------- */
  await win.evaluate(() => window.__toggleTests());
  await win.waitForTimeout(400);
  const rows = await win.evaluate(() => window.__testRows());
  ok(rows.length >= 3, `Tests dock renders rows (${rows.length})`);
  ok(rows.some((r) => r.adapter === "browser") && rows.some((r) => r.adapter === "node"), "rows show both browser + node adapters");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME TEST-DIRECTOR TESTS FAILED" : "\nALL TEST-DIRECTOR TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
