/* Verify keyboard handling for dialogs/shortcuts:
 *  - Ctrl+H opens History; Esc closes it
 *  - Ctrl+P opens the "open project" folder picker
 *  - Enter confirms a dialog (primary/danger button); Esc cancels it
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const ROOT = path.join(__dirname, "..");

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  const modalOpen = () => win.evaluate(() => !!document.querySelector("#modalRoot .modal-backdrop"));
  const modalTitle = () => win.evaluate(() => { const h = document.querySelector("#modalRoot .modal-head h3"); return h ? h.textContent : null; });

  // ---- Ctrl+H opens History, Esc closes ----
  await win.locator("body").click();
  await win.keyboard.press("Control+h");
  await win.waitForTimeout(300);
  ok(await modalOpen() && /history/i.test(await modalTitle()), "Ctrl+H opens History");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(250);
  ok(!(await modalOpen()), "Esc closes the History modal");

  // ---- Ctrl+P opens the project picker ----
  await app.evaluate(({ dialog }) => { global.__pickCalled = false; dialog.showOpenDialog = async () => { global.__pickCalled = true; return { canceled: true, filePaths: [] }; }; });
  await win.keyboard.press("Control+p");
  await win.waitForTimeout(400);
  ok(await app.evaluate(() => global.__pickCalled === true), "Ctrl+P opens the open-project folder picker");

  // ---- a confirm dialog: Esc cancels, Enter confirms ----
  const sid = await win.evaluate(() => window.atomnano.sessions.create({ name: "ZapKeys" }).then((v) => v.id));
  await win.locator('[title^="History"]').first().click();
  await win.waitForTimeout(250);
  await win.evaluate(() => { const s = [...document.querySelectorAll(".segmented button")].find((b) => /All projects/i.test(b.textContent)); if (s) s.click(); });
  await win.waitForTimeout(150);
  // open the session, then close History
  await win.evaluate(() => { const r = [...document.querySelectorAll(".change-row")].find((x) => (x.querySelector(".change-name") || {}).textContent === "ZapKeys"); [...r.querySelectorAll("button")].find((b) => /^(Open|Switch)$/.test(b.textContent.trim())).click(); });
  await win.waitForTimeout(400);

  const inList = () => win.evaluate((id) => window.atomnano.sessions.list().then((l) => l.some((s) => s.id === id)), sid);

  // open the delete confirm via the tab context menu, then Esc → cancel
  async function openDeleteConfirm() {
    await win.locator("#tabs .cht-tab.active").click({ button: "right" });
    await win.waitForTimeout(200);
    await win.evaluate(() => { const it = [...document.querySelectorAll("#ctxMenu .ctx-item")].find((e) => /Delete from history/i.test(e.textContent)); it.click(); });
    await win.waitForTimeout(250);
  }
  await openDeleteConfirm();
  ok(await modalOpen() && /delete/i.test(await modalTitle()), "delete confirm dialog opened");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(250);
  ok(!(await modalOpen()), "Esc closed the confirm dialog");
  ok(await inList(), "Esc cancelled — session NOT deleted");

  // open again, Enter → confirm (danger primary)
  await openDeleteConfirm();
  ok(await modalOpen(), "delete confirm reopened");
  await win.keyboard.press("Enter");
  await win.waitForTimeout(500);
  ok(!(await modalOpen()), "Enter closed the confirm dialog");
  ok(!(await inList()), "Enter confirmed — session deleted");

  await app.close();
  console.log(process.exitCode ? "\nSOME MODAL-KEY TESTS FAILED" : "\nALL MODAL-KEY TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
