/* The "1M context · Auto" indicator (2026-09-17: a label, not a checkbox — and, later the same day,
 * kept HIDDEN: the 1M context works in the background, user request). Context follows the selected
 * model automatically: the element stays in the DOM with its "on" class lit for a 1M-capable model,
 * it is never shown, there is nothing to tick, settings.oneM follows the model, and a turn on that
 * model goes out WITH the 1M beta — observable on global.__claude._lastRun.sent. (test-1m-support.js
 * covers the 200K models, for which "on" is off.) */
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

  // Force the primary back to Anthropic and pick a 1M-capable model.
  const cwd = path.join(os.tmpdir(), "atomnano-1m-indicator"); fs.mkdirSync(cwd, { recursive: true });
  await app.evaluate(({ }, c) => global.__store && global.__store.saveSettings({ llmProvider: "anthropic", defaultModel: "claude-opus-4-8", defaultThinking: "off" }, c), cwd);
  await win.evaluate(() => window.atomnano.settings.set({ llmProvider: "anthropic", defaultModel: "claude-opus-4-8", defaultThinking: "off" }));
  await win.waitForTimeout(200);

  const indicator = () => win.evaluate(() => { const w = document.getElementById("oneMWrap"); return w ? { exists: true, hidden: w.classList.contains("hidden"), on: w.classList.contains("on"), checkbox: !!w.querySelector("input"), text: w.textContent.trim() } : { exists: false }; });
  const s1 = await indicator();
  ok(s1.exists && s1.hidden && s1.on && !s1.checkbox && /1M context · Auto/.test(s1.text), `1M indicator lit for Opus 4.8 but kept hidden (works in the background), no checkbox (${JSON.stringify(s1)})`);
  ok(await win.evaluate(() => window.atomnano.settings.get().then((s) => !!s.oneM)), "settings.oneM follows the model automatically (true)");

  // A turn on the 1M model carries the beta without any user action.
  await win.evaluate(() => { const ta = document.getElementById("promptInput"); ta.value = "Reply with only: ok"; ta.dispatchEvent(new Event("input")); document.getElementById("sendBtn").click(); });
  let lastRun = null;
  for (let i = 0; i < 30; i++) {
    await win.waitForTimeout(300);
    lastRun = await app.evaluate(() => global.__claude && global.__claude._lastRun && global.__claude._lastRun.sent || null);
    if (lastRun && lastRun.model) break;
  }
  ok(!!lastRun, "backend recorded a _lastRun for the turn");
  ok(lastRun && lastRun.oneM === true, `_lastRun.sent.oneM === true (got ${lastRun && lastRun.oneM})`);
  ok(Array.isArray(lastRun && lastRun.betas) && lastRun.betas.includes("context-1m-2025-08-07"), `_lastRun.sent.betas includes "context-1m-2025-08-07" (got ${JSON.stringify(lastRun && lastRun.betas)})`);

  await app.close();
  console.log(process.exitCode ? "\n1M INDICATOR FAILED" : "\n1M INDICATOR PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
