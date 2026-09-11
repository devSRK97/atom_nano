/* LIVE: make Claude use AskUserQuestion, answer it via the picker, and confirm
 * Claude receives the choice and continues. Skips if no login / tool not used. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const ROOT = path.join(__dirname, "..");
const CWD = path.join(os.tmpdir(), "atomnano-live-ask");

(async () => {
  fs.mkdirSync(CWD, { recursive: true });
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  const sid = await win.evaluate((cwd) => window.atomnano.sessions.create({ name: "LiveAsk", cwd }).then((v) => v.id), CWD);
  await win.locator('[title^="History"]').first().click();
  await win.waitForTimeout(300);
  await win.evaluate(() => { const s = [...document.querySelectorAll(".segmented button")].find((b) => /All projects/i.test(b.textContent)); if (s) s.click(); });
  await win.waitForTimeout(150);
  await win.evaluate(() => { const r = [...document.querySelectorAll(".change-row")].find((x) => (x.querySelector(".change-name") || {}).textContent === "LiveAsk"); [...r.querySelectorAll("button")].find((b) => /^(Open|Switch)$/.test(b.textContent.trim())).click(); });
  await win.waitForTimeout(500);

  await win.fill("#promptInput", "Use the AskUserQuestion tool to ask me a single question with header \"Pet\" and exactly two options: \"Cats\" and \"Dogs\". After I answer, reply with one short sentence that names the pet I chose.");
  await win.locator("#promptInput").press("Enter");

  // wait for the picker
  let appeared = false;
  for (let i = 0; i < 60; i++) {
    await win.waitForTimeout(1000);
    if (await win.evaluate(() => !!document.querySelector("#chatPerms .ask-card"))) { appeared = true; break; }
    const err = await win.evaluate((id) => window.atomnano.sessions.get(id).then((v) => (v.messages || []).some((m) => m.role === "error")), sid);
    if (err) break;
  }
  if (!appeared) { console.log("SKIP: AskUserQuestion picker did not appear (no login, or model didn't use the tool)"); await app.close(); console.log("\nLIVE ASK SKIPPED"); return; }
  ok(true, "Claude used AskUserQuestion → picker appeared");

  // choose "Cats" (first radio) and send
  await win.evaluate(() => {
    const card = document.querySelector("#chatPerms .ask-card");
    card.querySelector('input[type="radio"]').click();
    card.querySelector(".btn-primary").click();
  });

  // wait for Claude to finish and name the pet
  let finalText = "";
  const start = Date.now();
  while (Date.now() - start < 75000) {
    await win.waitForTimeout(1500);
    const running = await win.evaluate((id) => window.atomnano.sessions.running(id), sid);
    finalText = await win.evaluate((id) => window.atomnano.sessions.get(id).then((v) => (v.messages || []).filter((m) => m.role === "assistant").map((m) => m.text).slice(-1)[0] || ""), sid);
    if (!running && finalText) break;
  }
  ok(/cat/i.test(finalText), `Claude received the answer and named the choice ("${finalText.slice(0, 60)}")`);

  await app.close();
  console.log(process.exitCode ? "\nLIVE ASK FAILED" : "\nLIVE ASK PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
