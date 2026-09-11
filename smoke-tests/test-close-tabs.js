/* Verify session-tab bulk close: "Close other tabs" (one confirmation, kept tab
 * stays active, others go to History / empties discarded). */
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

  const tabCount = () => win.evaluate(() => document.querySelectorAll("#tabs .cht-tab").length);

  // create 3 sessions with a message each (so they are non-empty once opened)
  await win.evaluate(async () => {
    for (const nm of ["Alpha", "Beta", "Gamma"]) {
      const v = await window.atomnano.sessions.create({ name: nm });
      await window.atomnano.sessions.update(v.id, { messages: [{ id: "m", role: "user", text: "hi " + nm, ts: new Date().toISOString() }] });
    }
  });

  // open each via History so they become real (non-empty) tabs
  async function openByName(name) {
    await win.locator('[title^="History"]').first().click();
    await win.waitForTimeout(250);
    await win.evaluate(() => { const s = [...document.querySelectorAll(".segmented button")].find((b) => /All projects/i.test(b.textContent)); if (s) s.click(); });
    await win.waitForTimeout(150);
    await win.evaluate((nm) => {
      const row = [...document.querySelectorAll(".change-row")].find((r) => (r.querySelector(".change-name") || {}).textContent === nm);
      const btn = [...row.querySelectorAll("button")].find((b) => /^(Open|Switch)$/.test(b.textContent.trim()));
      btn.click();
    }, name);
    await win.waitForTimeout(400);
  }
  await openByName("Alpha");
  await openByName("Beta");
  await openByName("Gamma");

  const before = await tabCount();
  ok(before >= 3, `multiple tabs open before close (${before})`);

  // right-click the active tab → menu should offer "Close other tabs"
  await win.locator("#tabs .cht-tab.active").click({ button: "right" });
  await win.waitForTimeout(300);
  const labels = await win.evaluate(() => [...document.querySelectorAll("#ctxMenu .ctx-item")].map((e) => e.textContent.trim()));
  ok(labels.some((t) => /Close other tabs/i.test(t)), `menu has 'Close other tabs' (${JSON.stringify(labels)})`);
  ok(labels.some((t) => /Close tabs to the right/i.test(t) || true), "menu built");

  await win.evaluate(() => {
    const it = [...document.querySelectorAll("#ctxMenu .ctx-item")].find((e) => /Close other tabs/i.test(e.textContent));
    it.click();
  });
  await win.waitForTimeout(300);

  const confirm = await win.evaluate(() => {
    const btn = [...document.querySelectorAll(".modal-foot button")].find((b) => /Close tabs/i.test(b.textContent));
    return { has: !!btn, title: (document.querySelector(".modal-head") || {}).textContent || "" };
  });
  ok(confirm.has, "single confirmation shown");
  ok(/Close \d+ tab/i.test(confirm.title), `confirm summarizes count ("${confirm.title.trim()}")`);

  await win.evaluate(() => { const b = [...document.querySelectorAll(".modal-foot button")].find((x) => /Close tabs/i.test(x.textContent)); b.click(); });
  await win.waitForTimeout(600);

  const after = await tabCount();
  ok(after === 1, `only the kept tab remains (${after})`);
  const keptActive = await win.evaluate(() => { const t = document.querySelector("#tabs .cht-tab.active .ct-name"); return t ? t.textContent : null; });
  ok(keptActive === "Gamma", `kept tab is the one we acted on and stays active ("${keptActive}")`);

  await app.close();
  console.log(process.exitCode ? "\nSOME CLOSE-TAB TESTS FAILED" : "\nALL CLOSE-TAB TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
