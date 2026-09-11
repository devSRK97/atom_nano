/* Verify the in-app update flow: progress log streams, no terminal, and a
 * "Restart now / Later" prompt that triggers app relaunch. (Stubs the actual
 * npm/CLI calls so the test stays offline and doesn't really restart.) */
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

  // stub the main-process update + replace the relaunch handler so the test is
  // offline and never actually restarts (which would break app.close()).
  await app.evaluate(({ ipcMain }) => {
    global.__relaunched = false;
    ipcMain.removeAllListeners("app:relaunch");
    ipcMain.on("app:relaunch", () => { global.__relaunched = true; });
    global.__auth.checkUpdates = async () => ({ cli: { current: "2.1.158", latest: "2.2.0", updateAvailable: true }, sdk: { current: "1.0.0", latest: "1.1.0", updateAvailable: true }, updateAvailable: true });
    global.__auth.updateAll = async (onProgress) => {
      onProgress("Updating Claude CLI…");
      onProgress("✓ Claude CLI is up to date (new models ship with it).");
      onProgress("Updating Agent SDK…");
      onProgress("✓ Agent SDK updated.");
      onProgress("Done.");
      return { ok: true, cli: { ok: true, detail: "updated" }, sdk: { ok: true, detail: "updated" } };
    };
  });

  await win.evaluate(() => { const b = [...document.querySelectorAll("#sidebarFooter .foot-btn")].find((x) => /Settings/i.test(x.textContent)); b.click(); });
  await win.waitForTimeout(450);

  // refresh update status so the "Update now" button appears
  await win.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /Check for updates/i.test(x.textContent)); b.click(); });
  await win.waitForTimeout(400);
  const hasUpdateBtn = await win.evaluate(() => [...document.querySelectorAll("button")].some((b) => /^\s*Update now\s*$/i.test(b.textContent)));
  ok(hasUpdateBtn, "‘Update now’ button shown when an update is available");

  // click Update now → progress log streams
  await win.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /Update now/i.test(x.textContent)); b.click(); });
  await win.waitForTimeout(900);
  const log = await win.evaluate(() => [...document.querySelectorAll(".upd-log-line")].map((l) => l.textContent));
  ok(log.length >= 3, `progress log streamed (${log.length} lines)`);
  ok(log.some((l) => /Claude CLI/i.test(l)) && log.some((l) => /Agent SDK/i.test(l)), "log mentions both CLI and SDK");

  // restart prompt appears with Restart now / Later (it's the topmost modal)
  const dlg = await win.evaluate(() => {
    const heads = [...document.querySelectorAll("#modalRoot .modal-head h3")];
    const title = heads.length ? heads[heads.length - 1].textContent : "";
    const foots = [...document.querySelectorAll("#modalRoot .modal-foot")];
    const btns = foots.length ? [...foots[foots.length - 1].querySelectorAll("button")].map((b) => b.textContent.trim()) : [];
    return { title, btns };
  });
  ok(/update complete/i.test(dlg.title), `restart prompt shown ("${dlg.title}")`);
  ok(dlg.btns.some((b) => /Restart now/i.test(b)) && dlg.btns.some((b) => /Later/i.test(b)), `prompt offers Restart now + Later (${JSON.stringify(dlg.btns)})`);

  // click Restart now → app.relaunch fired (stubbed)
  await win.evaluate(() => { const foots = [...document.querySelectorAll("#modalRoot .modal-foot")]; const b = [...foots[foots.length - 1].querySelectorAll("button")].find((x) => /Restart now/i.test(x.textContent)); b.click(); });
  await win.waitForTimeout(400);
  ok(await app.evaluate(() => global.__relaunched === true), "‘Restart now’ relaunches the app");

  // confirm the legacy export no longer exists (updateCli replaced by updateAll)
  ok(await app.evaluate(() => typeof global.__auth.updateAll === "function"), "auth.updateAll is the update entry point");

  await app.close();
  console.log(process.exitCode ? "\nSOME UPDATE-FLOW TESTS FAILED" : "\nALL UPDATE-FLOW TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
