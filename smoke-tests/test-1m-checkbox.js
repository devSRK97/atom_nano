/* Verify the "1M context" checkbox actually drives what's sent to Claude.
 * Toggling the checkbox should:
 *   - flip state.settings.oneM
 *   - cause the NEXT run (via the same shared-opts path the UI uses) to send
 *     oneM:true to claude.run, which in turn sets options.betas to
 *     ["context-1m-2025-08-07"] — observable on global.__claude._lastRun.sent. */
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
  const cwd = path.join(os.tmpdir(), "atomnano-1m-checkbox"); fs.mkdirSync(cwd, { recursive: true });
  await app.evaluate(({ }, c) => global.__store && global.__store.saveSettings({ llmProvider: "anthropic", defaultModel: "claude-opus-4-8", defaultThinking: "off" }, c), cwd);
  await win.evaluate(() => window.atomnano.settings.set({ llmProvider: "anthropic", defaultModel: "claude-opus-4-8", defaultThinking: "off" }));

  // Helper: read+click the 1M checkbox in the real composer.
  const checkboxState = () => win.evaluate(() => {
    const cb = document.getElementById("oneMToggle");
    const wrap = document.getElementById("oneMWrap");
    return cb ? { exists: true, checked: cb.checked, hidden: !!(wrap && wrap.classList.contains("hidden")) } : { exists: false };
  });
  const clickCheckbox = () => win.evaluate(() => {
    const cb = document.getElementById("oneMToggle");
    if (!cb) return false;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    return cb.checked;
  });
  const settingFlag = () => win.evaluate(() => window.atomnano.settings.get().then((s) => !!s.oneM));

  // 1. Sanity: checkbox renders, starts unchecked, settings.oneM is falsy.
  const initial = await checkboxState();
  ok(initial.exists, "1M checkbox is rendered in the composer");
  ok(!initial.hidden, "1M checkbox is visible for Opus 4.8 (a 1M-capable model)");
  ok(!initial.checked, "1M starts UNCHECKED");
  ok(!(await settingFlag()), "state.settings.oneM starts false");

  // 2. CHECK the box → settings.oneM becomes true; CLI accepts oneM and sends the beta.
  const wantChecked = await clickCheckbox();
  ok(wantChecked === true, "clicking checkbox flips it to CHECKED");
  await win.waitForTimeout(120);
  ok(await settingFlag(), "state.settings.oneM is now TRUE");

  // Drive a real turn through the SAME shared-opts path the UI uses on send().
  // window.__composerSend writes a prompt + calls send(), exactly like Enter would.
  const sidActive = await win.evaluate(() => window.atomnano.sessions.list().then((l) => (l[0] && l[0].id) || null));
  await win.evaluate(() => { const ta = document.getElementById("promptInput"); ta.value = "Reply with only: ok"; ta.dispatchEvent(new Event("input")); document.getElementById("sendBtn").click(); });

  // Wait for the backend to record the run (we don't need it to FINISH — _lastRun
  // is stamped before the SDK call, so it's available immediately).
  let lastRun = null;
  for (let i = 0; i < 30; i++) {
    await win.waitForTimeout(300);
    lastRun = await app.evaluate(() => global.__claude && global.__claude._lastRun && global.__claude._lastRun.sent || null);
    if (lastRun && lastRun.model) break;
  }
  ok(!!lastRun, "backend recorded a _lastRun for the checked-1M turn");
  ok(lastRun && lastRun.oneM === true, `_lastRun.sent.oneM === true (got ${lastRun && lastRun.oneM})`);
  ok(Array.isArray(lastRun && lastRun.betas) && lastRun.betas.includes("context-1m-2025-08-07"),
    `_lastRun.sent.betas includes "context-1m-2025-08-07" (got ${JSON.stringify(lastRun && lastRun.betas)})`);

  // Wait for that run to finish so the next send doesn't get queued.
  for (let i = 0; i < 60; i++) {
    await win.waitForTimeout(500);
    const running = sidActive ? await win.evaluate((id) => window.atomnano.sessions.running(id), sidActive) : false;
    if (!running) break;
  }

  // 3. UNCHECK the box → settings.oneM becomes false; next run sends no beta.
  await app.evaluate(() => { global.__claude._lastRun = null; });
  const stillChecked = await clickCheckbox();
  ok(stillChecked === false, "clicking again flips it to UNCHECKED");
  await win.waitForTimeout(120);
  ok(!(await settingFlag()), "state.settings.oneM is back to false");

  await win.evaluate(() => { const ta = document.getElementById("promptInput"); ta.value = "Reply with only: ok"; ta.dispatchEvent(new Event("input")); document.getElementById("sendBtn").click(); });
  let lastRun2 = null;
  for (let i = 0; i < 30; i++) {
    await win.waitForTimeout(300);
    lastRun2 = await app.evaluate(() => global.__claude && global.__claude._lastRun && global.__claude._lastRun.sent || null);
    if (lastRun2 && lastRun2.model) break;
  }
  ok(!!lastRun2, "backend recorded a _lastRun for the unchecked turn");
  ok(lastRun2 && lastRun2.oneM === false, `_lastRun.sent.oneM === false (got ${lastRun2 && lastRun2.oneM})`);
  ok(!Array.isArray(lastRun2 && lastRun2.betas) || !lastRun2.betas.includes("context-1m-2025-08-07"),
    `_lastRun.sent.betas does NOT include the 1M beta (got ${JSON.stringify(lastRun2 && lastRun2.betas)})`);

  await app.close();
  console.log(process.exitCode ? "\n1M CHECKBOX FAILED" : "\n1M CHECKBOX PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
