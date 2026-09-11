/* Verify the chat-section toggle: default shown, click hides #main completely,
 * click again shows it; button sits before History; Ctrl+\ also toggles. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist", "chat-hidden.png");

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  const mainVisible = () => win.evaluate(() => { const m = document.getElementById("main"); return !!m && getComputedStyle(m).display !== "none"; });

  // default: shown
  ok(await mainVisible(), "chat section shown by default");
  ok(!(await win.evaluate(() => document.body.classList.contains("chat-collapsed"))), "no chat-collapsed class by default");

  // toggle button exists, lives in the title bar (so it stays reachable when the
  // chat + its session tabs are collapsed)
  ok(await win.evaluate(() => !!document.getElementById("chatToggle")), "chat toggle button exists");
  ok(await win.evaluate(() => { const b = document.getElementById("chatToggle"); return !!b && !!b.closest("#titlebar"); }), "chat toggle lives in the title bar (outside #main)");

  // click → hides #main completely
  await win.locator("#chatToggle").click();
  await win.waitForTimeout(300);
  ok(!(await mainVisible()), "clicking toggle hides the chat section (#main display:none)");
  ok(await win.evaluate(() => document.getElementById("chatToggle").classList.contains("active")), "toggle button shows active state when hidden");
  await win.locator("#chat").screenshot({ path: OUT }).catch(() => {}); // chat hidden; capture window instead
  await win.screenshot({ path: OUT });

  // click again → shows
  await win.locator("#chatToggle").click();
  await win.waitForTimeout(300);
  ok(await mainVisible(), "clicking again shows the chat section");

  // Ctrl+\ also toggles
  await win.locator("body").click();
  await win.keyboard.press("Control+\\");
  await win.waitForTimeout(250);
  ok(!(await mainVisible()), "Ctrl+\\ hides the chat section");
  await win.keyboard.press("Control+\\");
  await win.waitForTimeout(250);
  ok(await mainVisible(), "Ctrl+\\ shows it again");

  console.log("screenshot:", OUT);
  await app.close();
  console.log(process.exitCode ? "\nSOME CHAT-TOGGLE TESTS FAILED" : "\nALL CHAT-TOGGLE TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
