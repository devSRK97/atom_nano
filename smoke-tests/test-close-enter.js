/* Close-confirm modal: Enter confirms (even when the titlebar Close button kept
 * focus), Esc cancels. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano, null, { timeout: 15000 });
  // capture force-close instead of actually closing
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeAllListeners("win:force-close");
    global.__forceClosed = false;
    ipcMain.on("win:force-close", () => { global.__forceClosed = true; });
    global.__sendConfirm = () => BrowserWindow.getAllWindows()[0].webContents.send("app:confirm-close", { running: 0 });
  });

  const modalUp = () => win.evaluate(() => !!document.querySelector("#modalRoot .modal-backdrop"));

  // ESC first: open confirm, focus titlebar X, Esc → cancels (no force-close)
  await app.evaluate(() => global.__sendConfirm());
  await win.waitForTimeout(350);
  ok(await modalUp(), "close-confirm modal shown");
  await win.evaluate(() => { const b = document.getElementById("winClose"); if (b) b.focus(); });
  await win.keyboard.press("Escape");
  await win.waitForTimeout(200);
  ok(!(await modalUp()), "Esc closed the confirm modal");
  ok(!(await app.evaluate(() => global.__forceClosed)), "Esc cancelled — did NOT force-close");

  // ENTER: open confirm, focus titlebar X (the bug repro), Enter → confirms
  await app.evaluate(() => global.__sendConfirm());
  await win.waitForTimeout(350);
  ok(await modalUp(), "close-confirm modal shown again");
  await win.evaluate(() => { const b = document.getElementById("winClose"); if (b) b.focus(); });
  await win.waitForTimeout(50);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(250);
  ok(await app.evaluate(() => global.__forceClosed), "Enter confirmed the close (force-close fired) even with titlebar Close focused");

  await app.close();
  console.log(process.exitCode ? "\nSOME CLOSE-ENTER TESTS FAILED" : "\nALL CLOSE-ENTER TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
