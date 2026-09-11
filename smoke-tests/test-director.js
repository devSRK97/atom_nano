/* Test Director Phase 2 — goal → GREEN orchestrator (deterministic, scripted agent):
 *  - HAPPY: plan → approve(locks tests) → run → author(TESTER) → build(wrong) →
 *    red → fix(BUILDER) → green → gates → COMPLETE; mutation gate kills a mutant
 *  - EXHAUSTED: fixer never fixes → blocked after the bounded fix attempts
 *  - AMBIGUOUS: a failing test not traceable to a spec bullet → oracle escalates → blocked
 *  - WEAK: a test with no real assertion passes, but the mutation gate catches it → blocked
 *  - the Goal→Green UI renders goal rows with live status
 *
 * The "agent" is a scripted fake (test hook) so the whole state machine runs with
 * no model. Node-adapter tests + mutation run for real against tiny fixtures.
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-director");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-director-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && typeof window.__toggleTests === "function" && window.atomnano && window.atomnano.director, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const CWD = DIR.replace(/\\/g, "/");

  // helper: run one scenario end-to-end → returns the final director result
  const drive = async (scenario, spec) => win.evaluate(async ({ cwd, scenario, spec }) => {
    await window.atomnano.test.directorScenario(cwd, scenario);
    const goal = await window.atomnano.director.plan(cwd, scenario + " calc add", { spec });
    await window.atomnano.director.approve(cwd, goal.id);
    const res = await window.atomnano.director.run(cwd, goal.id);
    return { goalId: goal.id, locked: goal, res };
  }, { cwd: CWD, scenario, spec });

  const SPEC = [{ id: "b1", text: "add(2,3) returns 5" }];

  /* ---------- HAPPY: drives all the way to complete ---------- */
  const happy = await drive("happy", SPEC);
  ok(happy.res.status === "complete", `HAPPY: goal reaches COMPLETE (${happy.res.status}${happy.res.reason ? " — " + happy.res.reason : ""})`);
  const mut = (happy.res.mutation || [])[0];
  ok(mut && mut.killed >= 1 && mut.survived === 0, `HAPPY: mutation gate killed injected bugs (killed=${mut && mut.killed}, survived=${mut && mut.survived})`);
  ok(happy.res.reason && /mutation-resistant/.test(happy.res.reason), "HAPPY: completion is spec-green + mutation-resistant + non-flaky");
  // the goal's test got LOCKED at spec approval (append-only)
  const lockedOk = await win.evaluate(async (cwd) => {
    const tests = await window.atomnano.testdir.list(cwd, {});
    return tests.some((t) => t.locked);
  }, CWD);
  ok(lockedOk, "HAPPY: approving the spec locked its test (append-only)");
  // data-loss fix: the mutation gate ran out-of-place — the user's real file is intact
  const realCalc = fs.readFileSync(path.join(DIR, "calc.js"), "utf8");
  ok(/a \+ b/.test(realCalc) && !/a - b/.test(realCalc), `HAPPY: mutation never wrote the real source (out-of-place) [${realCalc.trim()}]`);

  /* ---------- EXHAUSTED: fixer never fixes → blocked ---------- */
  const exhausted = await drive("exhausted", SPEC);
  ok(exhausted.res.status === "blocked" && /attempt|progress|stuck/i.test(exhausted.res.reason || ""), `EXHAUSTED: blocked after bounded fix attempts (${exhausted.res.reason})`);

  /* ---------- AMBIGUOUS: failure not traceable to a bullet → escalate ---------- */
  const ambiguous = await drive("ambiguous", SPEC);
  ok(ambiguous.res.status === "blocked" && /bullet|decision/i.test(ambiguous.res.reason || ""), `AMBIGUOUS: oracle escalates instead of guessing (${ambiguous.res.reason})`);

  /* ---------- WEAK: passing-but-toothless test caught by mutation gate ---------- */
  const weak = await drive("weak", SPEC);
  ok(weak.res.status === "blocked" && /mutant|weak/i.test(weak.res.reason || ""), `WEAK: green suite REJECTED because mutants survived (${weak.res.reason})`);
  const weakMut = (weak.res.mutation || [])[0];
  ok(weakMut && weakMut.survived >= 1, `WEAK: mutation gate reports survivors (survived=${weakMut && weakMut.survived})`);

  /* ---------- UI: goal rows render with status ---------- */
  await win.evaluate(() => window.__toggleTests());
  await win.waitForTimeout(400);
  const goalRows = await win.evaluate(() => window.__goalRows());
  ok(goalRows.length >= 4, `Goal→Green UI lists the goals (${goalRows.length})`);
  ok(goalRows.some((g) => /complete/i.test(g.status)) && goalRows.some((g) => /blocked/i.test(g.status)), "UI shows both Complete and Blocked goal states");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME DIRECTOR TESTS FAILED" : "\nALL DIRECTOR TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
