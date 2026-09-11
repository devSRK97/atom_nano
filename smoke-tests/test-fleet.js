/* Fleet + Heal batch (agent runtime):
 *  - enqueue several background tasks; a scheduler runs up to N at once
 *  - SAME-FILE prevention: two agents told to edit the same file → the second's
 *    edit is DENIED at the permission layer (conflict recorded), the first allowed
 *  - the queue drains (all tasks reach a terminal state) and persists to disk
 *  - Heal: the bounded self-repair loop announces attempts, stops clean, and stops
 *    on no-progress — driven deterministically by a fake verifier sequence
 *
 * Uses a fake runner (test hook) so no live model is needed.
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-fleet");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-fleet-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => window.atomnano && window.atomnano.fleet && window.atomnano.test, null, { timeout: 15000 });
  const CWD = DIR.replace(/\\/g, "/");

  // cap concurrency at 2 and install the deterministic fake runner (holds 300ms)
  await win.evaluate(() => window.atomnano.settings.set({ fleetMaxConcurrent: 2 }));
  await win.evaluate(() => window.atomnano.test.fleetFakeRunner(300));

  /* ---------- enqueue: two same-file (collide) first, then two distinct ---------- */
  const enq = await win.evaluate((cwd) => window.atomnano.fleet.enqueueMany(cwd, [
    { prompt: "edit shared.js — part A", name: "A shared" },
    { prompt: "edit shared.js — part B", name: "B shared" },
    { prompt: "edit alpha.js", name: "C alpha" },
    { prompt: "edit beta.js", name: "D beta" },
  ]), CWD);
  ok(enq.length === 4, `enqueued 4 background tasks (${enq.length})`);
  ok(enq.every((t) => t.sessionId), "each task got its own session (openable transcript)");

  const snap0 = await win.evaluate(() => window.atomnano.fleet.list());
  ok(snap0.maxConcurrent === 2, `scheduler honors max concurrency setting (${snap0.maxConcurrent})`);

  /* ---------- wait for the queue to drain ---------- */
  let snap = snap0;
  for (let i = 0; i < 60; i++) {
    snap = await win.evaluate(() => window.atomnano.fleet.list());
    if (snap.running === 0 && snap.queued === 0) break;
    await sleep(150);
  }
  ok(snap.running === 0 && snap.queued === 0, "queue fully drained");
  const done = snap.tasks.filter((t) => t.status === "done").length;
  ok(done === 4, `all 4 tasks reached done (${done}/4)`);

  /* ---------- same-file conflict prevention ---------- */
  const log = await win.evaluate(() => window.atomnano.test.fleetLog());
  const shared = log.filter((e) => /shared\.js/.test(e.file));
  const allows = shared.filter((e) => e.behavior === "allow").length;
  const denies = shared.filter((e) => e.behavior === "deny").length;
  ok(allows === 1 && denies === 1, `same file: exactly one agent allowed, the other denied (allow=${allows}, deny=${denies})`);
  const distinct = log.filter((e) => /alpha\.js|beta\.js/.test(e.file));
  ok(distinct.length === 2 && distinct.every((e) => e.behavior === "allow"), "edits to distinct files are never blocked");
  const conflicted = snap.tasks.filter((t) => (t.conflicts || 0) > 0);
  ok(conflicted.length === 1, `the blocked agent recorded a conflict (${conflicted.length} task)`);

  /* ---------- persistence ---------- */
  await sleep(400);
  let persisted = null;
  try { persisted = JSON.parse(fs.readFileSync(path.join(udir, "fleet.json"), "utf8")); } catch { /* */ }
  ok(persisted && Array.isArray(persisted.tasks) && persisted.tasks.length === 4, "fleet queue persisted to userData/fleet.json");

  /* ---------- Heal: bounded self-repair loop ---------- */
  // 2 errors → fix → 1 error → fix → 0 errors (clean)
  const healClean = await win.evaluate((cwd) => window.atomnano.test.healRun(cwd, [2, 1, 0]), CWD);
  ok(healClean.messages.length === 3, `heal looped twice then stopped (${healClean.messages.length} notices)`);
  ok(/found 2 problem/.test(healClean.messages[0]) && /1\/2/.test(healClean.messages[0]), "first heal notice reports count + attempt");
  ok(/resolved/i.test(healClean.messages[healClean.messages.length - 1]), "heal ends by confirming the fixes landed");

  // no progress (3 → 3) → stop early, don't burn the attempt budget pointlessly
  const healStuck = await win.evaluate((cwd) => window.atomnano.test.healRun(cwd, [3, 3]), CWD);
  ok(/no further progress/i.test(healStuck.messages[healStuck.messages.length - 1] || ""), "heal stops on no-progress and says so");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME FLEET/HEAL TESTS FAILED" : "\nALL FLEET/HEAL TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
