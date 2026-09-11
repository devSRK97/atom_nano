/* LIVE interrupt test: start a long reply, then (as a user would) type a new
 * message and press Enter mid-stream. Verifies the current turn is interrupted
 * and the new message runs + resumes. Skips if no login/network. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const CWD = path.join(os.tmpdir(), "atomnano-live-interrupt");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.mkdirSync(CWD, { recursive: true });
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  // create + open a session so it's the active tab the composer targets
  const sid = await win.evaluate((cwd) => window.atomnano.sessions.create({ name: "Intr", cwd }).then((v) => v.id), CWD);
  await win.locator('[title^="History"]').first().click();
  await win.waitForTimeout(300);
  await win.evaluate(() => { const s = [...document.querySelectorAll(".segmented button")].find((b) => /All projects/i.test(b.textContent)); if (s) s.click(); });
  await win.waitForTimeout(200);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".change-row")].find((r) => (r.querySelector(".change-name") || {}).textContent === "Intr");
    const btn = [...row.querySelectorAll("button")].find((b) => /^(Open|Switch)$/.test(b.textContent.trim()));
    btn.click();
  });
  await win.waitForTimeout(500);

  const getMsgs = () => win.evaluate((id) => window.atomnano.sessions.get(id).then((v) => (v.messages || []).map((m) => ({ role: m.role, text: m.text || "" }))), sid);
  const isRunning = () => win.evaluate((id) => window.atomnano.sessions.running(id), sid);

  // turn 1: a long, slow reply we can interrupt
  await win.fill("#promptInput", "Count from 1 to 80. Put each number on its own line with a short factual sentence about that number. Go slowly.");
  await win.locator("#promptInput").press("Enter");

  // wait until it's actually running
  let started = false;
  for (let i = 0; i < 30; i++) { await win.waitForTimeout(500); if (await isRunning()) { started = true; break; } }
  if (!started) { console.log("SKIP: run never started (no login/network?)"); await app.close(); console.log("\nLIVE INTERRUPT SKIPPED"); return; }

  // bail if it errored immediately
  let early = await getMsgs();
  if (early.some((m) => m.role === "error")) { console.log("SKIP: errored:", (early.find((m) => m.role === "error") || {}).text.slice(0, 100)); await app.close(); console.log("\nLIVE INTERRUPT SKIPPED"); return; }

  // let it stream a bit, then interrupt by sending a new message (Enter while running)
  await win.waitForTimeout(3500);
  await win.fill("#promptInput", "Stop. Ignore the counting. Reply with exactly one word: SWITCHED");
  await win.locator("#promptInput").press("Enter");

  // wait until a reply to the NEW message appears (assistant says SWITCHED) or timeout
  let switched = false, sawInterruptNote = false;
  const start = Date.now();
  while (Date.now() - start < 90000) {
    await win.waitForTimeout(1000);
    const msgs = await getMsgs();
    if (msgs.some((m) => m.role === "system" && /interrupted — running your new message/i.test(m.text))) sawInterruptNote = true;
    if (msgs.some((m) => m.role === "assistant" && /switched/i.test(m.text))) { switched = true; break; }
  }
  ok(sawInterruptNote, "interrupt produced the ‘running your new message’ note");
  ok(switched, "the new message ran after interrupting (and the session resumed)");

  // the assistant text can land a beat before the turn finalizes — poll for idle
  let finalRunning = true;
  for (let i = 0; i < 20; i++) { await win.waitForTimeout(800); finalRunning = await isRunning(); if (!finalRunning) break; }
  ok(!finalRunning, "session settled to idle after the replacement turn");

  await app.close();
  console.log(process.exitCode ? "\nLIVE INTERRUPT FAILED" : "\nLIVE INTERRUPT PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
