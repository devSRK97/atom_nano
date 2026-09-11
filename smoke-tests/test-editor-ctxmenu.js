/* Editor right-click menu (CodeMirror 6): Cut / Copy / Paste / Select all /
 * Upper case / Lower case, and that the case + copy/paste actions work. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-editor-ctx");
const FILE = path.join(DIR, "sample.txt");

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, "hello world\nsecond line\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });
  await win.waitForFunction(() => typeof window.__openInEditor === "function", null, { timeout: 8000 });
  await win.evaluate((p) => window.__openInEditor(p), FILE);
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(300);

  const doc = () => win.evaluate(() => window.__cm().docText());
  const setSel = (a, b) => win.evaluate(({ a, b }) => window.__cm().view.dispatch({ selection: { anchor: a, head: b } }), { a, b });
  const openMenu = () => win.evaluate(() => { const el = document.querySelector(".cm-content"); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 12 })); });
  const clickItem = (reSrc) => win.evaluate((src) => { const rx = new RegExp(src, "i"); const it = [...document.querySelectorAll("#ctxMenu .ctx-item")].find((e) => rx.test(e.textContent)); if (it) it.click(); }, reSrc);

  ok((await doc()).startsWith("hello world"), "file opened in editor");

  // 1) menu has every action
  await setSel(0, 5);             // select "hello"
  await openMenu();
  await win.waitForTimeout(200);
  const labels = await win.evaluate(() => [...document.querySelectorAll("#ctxMenu .ctx-item")].map((e) => e.textContent.trim()));
  for (const want of ["Cut", "Copy", "Paste", "Select all", "Upper case", "Lower case"]) {
    ok(labels.some((l) => l.toLowerCase().startsWith(want.toLowerCase())), `menu has "${want}" (${JSON.stringify(labels)})`);
  }

  // 2) Upper case → "hello" → "HELLO"
  await clickItem("^Upper case");
  await win.waitForTimeout(200);
  ok((await doc()).startsWith("HELLO world"), `Upper case worked (now: "${(await doc()).slice(0, 14)}")`);

  // 3) Lower case it back
  await setSel(0, 5);
  await openMenu(); await win.waitForTimeout(150);
  await clickItem("^Lower case");
  await win.waitForTimeout(200);
  ok((await doc()).startsWith("hello world"), "Lower case worked");

  // 4) Copy → clipboard
  await setSel(0, 5);
  await openMenu(); await win.waitForTimeout(150);
  await clickItem("^Copy");
  await win.waitForTimeout(200);
  ok((await win.evaluate(() => window.atomnano.clipboard.read())) === "hello", "Copy put selection on the clipboard");

  // 5) Paste at end
  const end = (await doc()).length;
  await setSel(end, end);
  await openMenu(); await win.waitForTimeout(150);
  await clickItem("^Paste");
  await win.waitForTimeout(250);
  ok((await doc()).endsWith("hello"), `Paste inserted clipboard text (ends: "${(await doc()).slice(-8)}")`);

  await app.close();
  console.log(process.exitCode ? "\nSOME EDITOR-CTX TESTS FAILED" : "\nALL EDITOR-CTX TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
