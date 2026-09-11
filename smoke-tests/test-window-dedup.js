/* One window per project: opening a folder that's already open focuses the
 * existing window instead of creating a duplicate; a different folder opens new.
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const A = path.join(os.tmpdir(), "atomnano-dedup-A");
const B = path.join(os.tmpdir(), "atomnano-dedup-B");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  for (const d of [A, B]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const udir = path.join(os.tmpdir(), "atomnano-dedup-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => window.atomnano && window.atomnano.win && window.atomnano.win.openProject, null, { timeout: 15000 });

  const winCount = () => app.windows().length;
  const aFwd = A.replace(/\\/g, "/");

  // open project A → one new window (2 total)
  let r = await win.evaluate((p) => window.atomnano.win.openProject(p), aFwd);
  await win.waitForTimeout(700);
  ok(r.reused === false, "opening a NEW folder creates a window (reused=false)");
  const afterA = winCount();
  ok(afterA >= 2, `project A opened in its own window (${afterA} windows)`);

  // is-open reports A as open
  ok(await win.evaluate((p) => window.atomnano.win.isOpen(p), aFwd) === true, "isOpen() reports project A as open");

  // open project A AGAIN → focus existing, NO new window
  r = await win.evaluate((p) => window.atomnano.win.openProject(p), aFwd);
  await win.waitForTimeout(600);
  ok(r.reused === true, "re-opening the SAME folder reuses its window (reused=true)");
  ok(winCount() === afterA, `no duplicate window for the same folder (${winCount()} == ${afterA})`);

  // a DIFFERENT folder → a new window
  r = await win.evaluate((p) => window.atomnano.win.openProject(p), B.replace(/\\/g, "/"));
  await win.waitForTimeout(700);
  ok(r.reused === false && winCount() === afterA + 1, `a different folder opens a new window (${winCount()})`);

  /* ---------- in-place project switch updates per-project settings ---------- */
  await win.evaluate((p) => window.atomnano.win.setProject(p), aFwd);
  await win.evaluate(() => window.atomnano.settings.set({ llmProvider: "openai", defaultModel: "gpt-5.5" }));
  let s = await win.evaluate(() => window.atomnano.settings.get());
  ok(s.llmProvider === "openai", "settings written after win.setProject land on the new project");
  await win.evaluate((p) => window.atomnano.win.setProject(p), B.replace(/\\/g, "/"));
  s = await win.evaluate(() => window.atomnano.settings.get());
  ok(s.llmProvider !== "openai", "switching the window's project loads THAT project's settings (not the previous)");

  /* ---------- taskbar "New Window" opens a pick window ---------- */
  const n0 = winCount();
  await win.evaluate(() => window.atomnano.test.newPickWindow());
  await win.waitForFunction((n) => true, n0, { timeout: 3000 }).catch(() => {});
  await new Promise((r2) => setTimeout(r2, 800));
  ok(app.windows().length === n0 + 1, `the taskbar New Window task opens a window (${app.windows().length})`);
  const pickWin = app.windows()[app.windows().length - 1];
  await pickWin.waitForFunction(() => window.atomnano && window.atomnano.win && window.atomnano.win.pickOnOpen, null, { timeout: 8000 });
  ok(await pickWin.evaluate(() => window.atomnano.win.pickOnOpen()) === true, "the new window is flagged to prompt for a project (pick-on-open)");

  await app.close();
  console.log(process.exitCode ? "\nSOME WINDOW-DEDUP TESTS FAILED" : "\nALL WINDOW-DEDUP TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
