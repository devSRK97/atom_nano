/* Right-click Copy/Cut/Paste/Select All on the folder-search input and the
 * editor-find input. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const DIR = path.join(os.tmpdir(), "atomnano-inputctx");

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "f.js"), "const a = 1;\nconst b = 2;\n");
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano, null, { timeout: 15000 });

  const rightClick = (selector) => win.evaluate((sel) => {
    const el = document.querySelector(sel); if (!el) return false;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 10, clientY: r.top + 8 }));
    return true;
  }, selector);
  const menuItems = () => win.evaluate(() => [...document.querySelectorAll("#ctxMenu .ctx-item")].map((e) => e.textContent.trim()));
  const clickItem = (label) => win.evaluate((l) => { const it = [...document.querySelectorAll("#ctxMenu .ctx-item")].find((e) => e.textContent.trim() === l); if (it) it.click(); }, label);

  // ---- folder/project search modal input ----
  await win.waitForFunction(() => typeof window.__openSearch === "function", null, { timeout: 8000 });
  await win.evaluate(() => window.__openSearch({}));
  await win.waitForTimeout(400);
  const searchSel = ".search-input-row input";
  ok(await win.evaluate((s) => !!document.querySelector(s), searchSel), "search modal input present");
  await win.fill(searchSel, "hello world");
  ok(await rightClick(searchSel), "right-clicked the search input");
  await win.waitForTimeout(200);
  let items = await menuItems();
  for (const w of ["Cut", "Copy", "Paste", "Select all"]) ok(items.some((x) => new RegExp("^" + w, "i").test(x)), `search-input menu has "${w}" (${JSON.stringify(items)})`);
  // Select all → Copy
  await clickItem("Select all"); await win.waitForTimeout(100);
  const selAll = await win.evaluate((s) => { const el = document.querySelector(s); return el.selectionStart === 0 && el.selectionEnd === el.value.length; }, searchSel);
  ok(selAll, "Select all selected the whole input");
  await rightClick(searchSel); await win.waitForTimeout(150); await clickItem("Copy"); await win.waitForTimeout(150);
  ok((await win.evaluate(() => window.atomnano.clipboard.read())) === "hello world", "Copy put the input text on the clipboard");
  await win.keyboard.press("Escape"); await win.waitForTimeout(200);

  // ---- editor find input (CodeMirror 6 search panel) ----
  await win.waitForFunction(() => typeof window.__openInEditor === "function", null, { timeout: 8000 });
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "f.js"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.click(".cm-content");
  await win.keyboard.press("Control+f");
  await win.waitForTimeout(300);
  const findSel = ".cmfind .cmfind-input";
  ok(await win.evaluate((s) => !!document.querySelector(s), findSel), "editor find input present");
  ok(await rightClick(findSel), "right-clicked the editor-find input");
  await win.waitForTimeout(200);
  items = await menuItems();
  for (const w of ["Cut", "Copy", "Paste", "Select all"]) ok(items.some((x) => new RegExp("^" + w, "i").test(x)), `editor-find menu has "${w}"`);
  // Paste the earlier-copied text into the find box
  await win.evaluate((s) => document.querySelector(s).focus(), findSel);
  await rightClick(findSel); await win.waitForTimeout(150); await clickItem("Paste"); await win.waitForTimeout(200);
  ok((await win.evaluate((s) => document.querySelector(s).value, findSel)) === "hello world", "Paste inserted clipboard text into the find box");

  await app.close();
  console.log(process.exitCode ? "\nSOME INPUT-CTX TESTS FAILED" : "\nALL INPUT-CTX TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
