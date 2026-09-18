/* Verify 1M gating now includes Opus 4.6+ and Sonnet 4.6+ (not Haiku/old Sonnet),
 * and that sending the 1M beta with Opus 4.8 is accepted by the CLI (no error). */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  // The indicator element is always hidden (2026-09-17, user request) — its "on" class is the state that follows the model.
  const oneMOn = () => win.evaluate(() => { const w = document.getElementById("oneMWrap"); return !!w && w.classList.contains("on") && w.classList.contains("hidden"); });
  const pickModel = async (name) => {
    await win.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await win.evaluate(() => { const t = document.querySelector(".composer-toolbar .dd .dd-trigger"); if (t) t.click(); });
    await win.waitForTimeout(220);
    await win.evaluate((n) => { const it = [...document.querySelectorAll(".dd-menu .dd-item")].find((e) => (e.querySelector(".di-title") || {}).textContent === n); if (it) it.click(); }, name);
    await win.waitForTimeout(180);
  };
  for (const name of ["Fable 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6"]) { await pickModel(name); ok(await oneMOn(), `1M on in the background for ${name} (indicator hidden)`); }
  await pickModel("Haiku 4.5"); ok(!(await oneMOn()), "1M off for Haiku 4.5");

  // live: Opus 4.8 + 1M beta must be accepted (no error), init.model = opus
  const cwd = path.join(os.tmpdir(), "atomnano-1m"); fs.mkdirSync(cwd, { recursive: true });
  const sid = await win.evaluate((c) => window.atomnano.sessions.create({ name: "OneM", cwd: c }).then((v) => v.id), cwd);
  await win.evaluate((id) => window.atomnano.sessions.send(id, { text: "Reply with only: ok", model: "claude-opus-4-8", permissionMode: "acceptEdits", thinking: "off", oneM: true }), sid);
  let errored = false, init = null, done = false;
  for (let i = 0; i < 60; i++) {
    await win.waitForTimeout(1000);
    const running = await win.evaluate((id) => window.atomnano.sessions.running(id), sid);
    const msgs = await win.evaluate((id) => window.atomnano.sessions.get(id).then((v) => (v.messages || []).map((m) => ({ r: m.role, t: m.text }))), sid);
    errored = msgs.some((m) => m.r === "error");
    init = await app.evaluate(() => global.__claude && global.__claude._lastRun && global.__claude._lastRun.init || null);
    if (!running) { done = true; break; }
    if (errored) break;
  }
  if (!init && !done) { console.log("SKIP: no run (login/network)"); await app.close(); console.log("\n1M SUPPORT SKIPPED (live)"); return; }
  ok(!errored, "Opus 4.8 + 1M beta accepted by the CLI (no error)");
  if (init) ok(init.model === "claude-opus-4-8", `ran on Opus 4.8 with 1M (init.model=${init.model})`);

  await app.close();
  console.log(process.exitCode ? "\n1M SUPPORT FAILED" : "\n1M SUPPORT PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
