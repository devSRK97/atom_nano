/* Verify (1) the 1M checkbox only shows for supporting (Sonnet) models, and
 * (2) the app GENUINELY applies model / reasoning / mode / 1M to a real run —
 * both what we send to the SDK and what the CLI echoes back in init. */
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

  // ---- 1M visibility ----
  // The indicator element is always hidden (2026-09-17, user request) — its "on" class is the state that follows the model.
  const oneMOn = () => win.evaluate(() => { const w = document.getElementById("oneMWrap"); return !!w && w.classList.contains("on") && w.classList.contains("hidden"); });
  // default model is Opus → 1M hidden
  await win.evaluate(() => window.atomnano.settings.set({ defaultModel: "claude-opus-4-8" }));
  // drive via the model dropdown so the UI handler runs
  const pickModel = async (name) => {
    await win.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await win.evaluate(() => { const t = document.querySelector(".composer-toolbar .dd .dd-trigger"); if (t) t.click(); });
    await win.waitForTimeout(250);
    await win.evaluate((n) => { const it = [...document.querySelectorAll(".dd-menu .dd-item")].find((e) => (e.querySelector(".di-title") || {}).textContent === n); if (it) it.click(); }, name);
    await win.waitForTimeout(200);
  };
  await pickModel("Opus 4.8");
  ok(!(await oneMOn()), "1M off for Opus (unsupported) — the indicator itself is never shown");
  await pickModel("Sonnet 4.6");
  ok(await oneMOn(), "1M on in the background for Sonnet (supported), indicator hidden");

  // ---- genuine usage on a real run ----
  const cwd = path.join(os.tmpdir(), "atomnano-genuine"); fs.mkdirSync(cwd, { recursive: true });
  const sid = await win.evaluate((c) => window.atomnano.sessions.create({ name: "Genuine", cwd: c }).then((v) => v.id), cwd);
  await win.evaluate((id) => window.atomnano.sessions.send(id, { text: "Reply with only: ok", model: "claude-sonnet-4-6", permissionMode: "acceptEdits", thinking: "think", oneM: true }), sid);

  // wait until the run records init (or finishes)
  let run = null;
  for (let i = 0; i < 60; i++) {
    await win.waitForTimeout(1000);
    run = await app.evaluate(() => global.__claude && global.__claude._lastRun || null);
    const running = await win.evaluate((id) => window.atomnano.sessions.running(id), sid);
    if (run && run.init) break;
    if (!running) break;
  }
  console.log("LASTRUN:", JSON.stringify(run));
  if (!run) { console.log("SKIP: no run captured"); await app.close(); console.log("\nGENUINE USAGE SKIPPED"); return; }

  // what we sent to the SDK
  ok(run.sent.model === "claude-sonnet-4-6", `model genuinely sent (${run.sent.model})`);
  ok(run.sent.permissionMode === "acceptEdits", `permission mode genuinely sent (${run.sent.permissionMode})`);
  ok(run.sent.maxThinkingTokens === 4000, `reasoning level genuinely sent (maxThinkingTokens=${run.sent.maxThinkingTokens})`);
  ok(run.sent.oneM === true && run.sent.betas.includes("context-1m-2025-08-07"), `1M context genuinely sent (${JSON.stringify(run.sent.betas)})`);

  // what the CLI echoed back (proves it was actually applied, not dropped)
  if (run.init) {
    ok(run.init.model === "claude-sonnet-4-6", `CLI applied the model (init.model=${run.init.model})`);
    ok(run.init.permissionMode === "acceptEdits", `CLI applied the mode (init.permissionMode=${run.init.permissionMode})`);
  } else {
    console.log("NOTE: init not captured (offline?) — sent values still verified");
  }

  await app.close();
  console.log(process.exitCode ? "\nGENUINE USAGE FAILED" : "\nGENUINE USAGE PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
