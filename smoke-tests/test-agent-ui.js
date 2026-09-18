/* Agent UI batch — the right docks behind the chat header ⋮ menu:
 *  - the Skills entries are GONE (2026-09-18 — skills are attached to workflow roles in the Workflow
 *    Studio's Skills modal): no #skillsBtn, no #skillsPanel, no __toggleSkills / __skillNames hooks, and
 *    the header menu offers neither "Skills for this chat" nor "Skills library"
 *  - the surviving docks stay mutually exclusive (Tests, then Fleet — one dock at a time)
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
  await win.waitForFunction(() => typeof window.__toggleFleet === "function" && typeof window.__toggleTests === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  await win.evaluate(() => window.atomnano.test.fleetFakeRunner(250));
  await win.evaluate(() => window.atomnano.settings.set({ fleetMaxConcurrent: 2 }));

  /* ---------- the removed Skills UI is absent ---------- */
  const gone = await win.evaluate(() => ({
    btn: !!document.getElementById("skillsBtn"), panel: !!document.getElementById("skillsPanel"),
    toggle: typeof window.__toggleSkills, names: typeof window.__skillNames,
    fleetPanel: !!document.getElementById("fleetPanel"), testsPanel: !!document.getElementById("testsPanel"),
  }));
  ok(!gone.btn && !gone.panel, "no Skills button and no Skills dock in the DOM");
  ok(gone.toggle === "undefined" && gone.names === "undefined", "no __toggleSkills / __skillNames webdriver hooks");
  ok(gone.fleetPanel && gone.testsPanel, "the Fleet and Tests docks are still there");

  /* ---------- the header ⋮ menu: no Skills entries, the surviving docks listed ---------- */
  await win.evaluate(() => document.getElementById("chatMore").click());
  await win.waitForTimeout(500);   // the menu loads recent conversations before it opens
  const menu = await win.evaluate(() => ({ open: !document.getElementById("ctxMenu").classList.contains("hidden"), items: [...document.querySelectorAll("#ctxMenu .ctx-item")].map((e) => e.textContent.trim()) }));
  await win.keyboard.press("Escape");
  ok(menu.open && menu.items.length >= 5, `the header ⋮ menu opens (${menu.items.length} items)`);
  ok(!menu.items.some((t) => /Skills for this chat|Skills library/i.test(t)), `no "Skills for this chat" / "Skills library" entries (${JSON.stringify(menu.items.filter((t) => /skill/i.test(t)))})`);
  ok(["Workflow studio…", "Agents activity", "Task board", "Fleet", "Tests"].every((l) => menu.items.includes(l)), `Workflow studio, Agents activity, Task board, Fleet and Tests remain (${JSON.stringify(menu.items.slice(0, 8))})`);

  /* ---------- docks are mutually exclusive ---------- */
  await win.evaluate(() => window.__toggleTests());
  await win.waitForTimeout(200);
  const testsOpen = await win.evaluate(() => !document.getElementById("testsPanel").classList.contains("hidden"));
  ok(testsOpen, "Tests dock opens");
  await win.evaluate(() => window.__toggleFleet());
  await win.waitForTimeout(200);
  const exclusive = await win.evaluate(() => ({
    fleet: !document.getElementById("fleetPanel").classList.contains("hidden"),
    tests: document.getElementById("testsPanel").classList.contains("hidden"),
  }));
  ok(exclusive.fleet && exclusive.tests, "opening Fleet closes Tests (one dock at a time)");

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
