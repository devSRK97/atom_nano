/* Agent UI batch — the Fleet + Skills docks in the chat header:
 *  - the two header buttons open mutually-exclusive right docks
 *  - Skills dock lists active skills AND apprentice suggestions
 *  - Fleet dock dispatches background tasks from the textarea and renders live
 *    rows (status badge); same-file conflict surfaces a ⚠ marker in the UI
 * Uses the fake fleet runner so nothing hits a live model.
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-agentui");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-agentui-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__toggleFleet === "function" && typeof window.__toggleSkills === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const CWD = DIR.replace(/\\/g, "/");
  await win.evaluate(() => window.atomnano.test.fleetFakeRunner(250));
  await win.evaluate(() => window.atomnano.settings.set({ fleetMaxConcurrent: 2 }));

  /* ---------- header buttons exist and toggle docks ---------- */
  const btns = await win.evaluate(() => ({ fleet: !!document.getElementById("fleetBtn"), skills: !!document.getElementById("skillsBtn") }));
  ok(btns.fleet && btns.skills, "Fleet + Skills buttons present in the chat header");

  /* ---------- Skills dock: active + suggested ---------- */
  await win.evaluate((cwd) => window.atomnano.skills.create(cwd, { name: "Wire IPC handler", description: "main↔renderer channel", steps: "handle + bridge + call", triggers: ["ipc", "handler"] }), CWD);
  for (let i = 0; i < 3; i++) await win.evaluate(({ cwd, i }) => window.atomnano.test.skillsRecord(cwd, { prompt: "add a database migration step " + i, files: [cwd + "/db/migrate.js"], tools: ["Edit"] }), { cwd: CWD, i });
  await win.evaluate((cwd) => window.atomnano.skills.mine(cwd), CWD);

  await win.evaluate(() => window.__toggleSkills());
  await win.waitForTimeout(300);
  const skillsOpen = await win.evaluate(() => !document.getElementById("skillsPanel").classList.contains("hidden"));
  ok(skillsOpen, "Skills dock opens");
  const skillNames = await win.evaluate(() => window.__skillNames());
  ok(skillNames.includes("Wire IPC handler"), `manual skill shown in dock (${JSON.stringify(skillNames)})`);
  const hasSuggested = await win.evaluate(() => !!document.querySelector("#skillsPanel .skill-row.suggested"));
  ok(hasSuggested, "an apprentice suggestion is shown (dashed row)");
  const hasLearnedSection = await win.evaluate(() => [...document.querySelectorAll("#skillsPanel .skills-section")].some((e) => /apprentice/i.test(e.textContent)));
  ok(hasLearnedSection, "suggestions sit under a 'learned by the apprentice' section");

  /* ---------- docks are mutually exclusive ---------- */
  await win.evaluate(() => window.__toggleFleet());
  await win.waitForTimeout(200);
  const exclusive = await win.evaluate(() => ({
    fleet: !document.getElementById("fleetPanel").classList.contains("hidden"),
    skills: document.getElementById("skillsPanel").classList.contains("hidden"),
  }));
  ok(exclusive.fleet && exclusive.skills, "opening Fleet closes Skills (one dock at a time)");

  /* ---------- Fleet dock: dispatch multiple agents from the UI ---------- */
  await win.evaluate(() => window.__dispatchFleet("edit shared.js — A\nedit shared.js — B\nedit gamma.js"));
  await win.waitForTimeout(250);
  let snap = await win.evaluate(() => window.__fleetSnap());
  ok(snap.tasks.length === 3, `three agents dispatched from the textarea (${snap.tasks.length})`);
  const rows = await win.evaluate(() => document.querySelectorAll("#fleetPanel .fleet-row").length);
  ok(rows === 3, `Fleet dock renders a row per task (${rows})`);

  // wait for completion, then the conflict marker must be visible in the UI
  for (let i = 0; i < 40; i++) { snap = await win.evaluate(() => window.__fleetSnap()); if (snap.running === 0 && snap.queued === 0) break; await sleep(150); }
  await win.evaluate(() => window.__toggleFleet());   // re-open to force a fresh render of final state
  await win.evaluate(() => window.__toggleFleet());
  await win.waitForTimeout(200);
  const conflictShown = await win.evaluate(() => !!document.querySelector("#fleetPanel .fleet-conflict"));
  ok(conflictShown, "same-file conflict surfaces a ⚠ marker on the blocked agent's row");
  const doneBadges = await win.evaluate(() => [...document.querySelectorAll("#fleetPanel .fleet-badge.fb-done")].length);
  ok(doneBadges === 3, `all three rows show a Done badge (${doneBadges})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME AGENT-UI TESTS FAILED" : "\nALL AGENT-UI TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
