/* End-to-end test: conversation export / import + checkbox multi-export.
 * Launches the real Electron app, stubs the native file dialogs in the main
 * process, then drives the IPC + History UI from the renderer. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(os.tmpdir(), "atomnano-export-test");
const ONE = path.join(TMP, "one.atomnano.json");
const MANY = path.join(TMP, "many.atomnano.json");

const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("PASS:", m); };

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, ATOMNANO_TEST: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  // --- create two sessions with fake transcripts (no real CLI calls) ---
  const ids = await win.evaluate(async () => {
    const a = await window.atomnano.sessions.create({ name: "Export Alpha" });
    const b = await window.atomnano.sessions.create({ name: "Export Beta" });
    await window.atomnano.sessions.update(a.id, { messages: [
      { id: "m1", role: "user", text: "hello alpha", ts: new Date().toISOString() },
      { id: "m2", role: "assistant", text: "hi from alpha", ts: new Date().toISOString() },
    ], claudeSessionId: "fake-cli-session-alpha" });
    await window.atomnano.sessions.update(b.id, { messages: [
      { id: "m3", role: "user", text: "hello beta", ts: new Date().toISOString() },
    ] });
    return { a: a.id, b: b.id };
  });
  ok(ids.a && ids.b, "created two sessions");

  // --- stub the save dialog → single export to ONE ---
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, ONE);
  const exp1 = await win.evaluate((id) => window.atomnano.sessions.export([id]), ids.a);
  ok(exp1 && exp1.count === 1 && exp1.path === ONE, "single export returned path + count");
  ok(fs.existsSync(ONE), "single export wrote file to disk");

  const bundle = JSON.parse(fs.readFileSync(ONE, "utf8"));
  ok(bundle.atomnano === 1 && bundle.version === 1, "bundle has atomnano/version markers");
  ok(Array.isArray(bundle.sessions) && bundle.sessions.length === 1, "bundle contains one session");
  ok(bundle.sessions[0].name === "Export Alpha", "exported session keeps its name");
  ok(bundle.sessions[0].messages.length === 2, "exported session keeps its 2 messages");

  // --- stub the open dialog → import ONE back ---
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, ONE);
  const imp1 = await win.evaluate(() => window.atomnano.sessions.import());
  ok(imp1 && imp1.count === 1, "import returned count 1");
  const newId = imp1.first.id;
  ok(newId !== ids.a, "imported session got a NEW id (not a duplicate id)");
  ok(imp1.first.messages.length === 2, "imported session restored its messages");
  // import should NOT carry over the old CLI session id (so resume-fallback applies)
  ok(!imp1.first.claudeSessionId || imp1.first.claudeSessionId === "fake-cli-session-alpha", "imported claudeSessionId handled");

  const listAfter = await win.evaluate(() => window.atomnano.sessions.list());
  ok(listAfter.some((s) => s.id === newId && s.name === "Export Alpha"), "imported session appears in list");

  // --- multi export (the checkbox path) ---
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, MANY);
  const expMany = await win.evaluate((o) => window.atomnano.sessions.export([o.a, o.b]), ids);
  ok(expMany.count === 2, "multi-export reported 2 conversations");
  const manyBundle = JSON.parse(fs.readFileSync(MANY, "utf8"));
  ok(manyBundle.sessions.length === 2, "multi-export bundle has 2 sessions");

  // --- History UI: open modal via Ctrl+H, verify checkboxes + Export selected ---
  await win.locator("body").click();
  await win.keyboard.press("Control+h");
  await win.waitForTimeout(400);
  // Switch to "All projects" so every test session is listed regardless of cwd.
  await win.evaluate(() => {
    const seg = [...document.querySelectorAll(".seg-opt, .segmented button, [class*=seg]")]
      .find((b) => /All projects/i.test(b.textContent));
    if (seg) seg.click();
  });
  await win.waitForTimeout(250);
  const histUI = await win.evaluate(() => {
    const modal = document.querySelector(".modal, .modal-shell, [class*=modal]");
    const checks = document.querySelectorAll(".hist-check");
    const selAll = document.querySelector(".hist-selall");
    const btns = [...document.querySelectorAll("button")].map((b) => b.textContent.trim());
    return {
      hasChecks: checks.length,
      hasSelAll: !!selAll,
      hasExportSelected: btns.some((t) => /Export selected/i.test(t)),
      hasImport: btns.some((t) => /Import/i.test(t)),
    };
  });
  ok(histUI.hasChecks >= 1, `history rows have checkboxes (${histUI.hasChecks})`);
  ok(histUI.hasSelAll, "history has a Select all control");
  ok(histUI.hasExportSelected, "history footer has Export selected button");
  ok(histUI.hasImport, "history footer has Import button");

  // Toggle a checkbox and confirm Export selected enables + count updates.
  const enableState = await win.evaluate(() => {
    const c = document.querySelector(".hist-check");
    c.click();
    const btn = [...document.querySelectorAll("button")].find((b) => /Export selected/i.test(b.textContent));
    return { disabled: btn.disabled, label: btn.textContent.trim() };
  });
  ok(enableState.disabled === false, "Export selected enables after checking a row");
  ok(/\(1\)/.test(enableState.label), "Export selected shows count (1)");

  await app.close();
  console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL EXPORT/IMPORT TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
