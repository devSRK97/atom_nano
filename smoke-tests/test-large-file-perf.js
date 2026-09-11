/* Big-file editor performance with CodeMirror 6: opens fast, virtualizes the
 * viewport (only visible lines in the DOM), scrolling + typing stay responsive. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-bigfile");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const N = 30000;
  let src = ""; for (let i = 0; i < N; i++) src += `function fn${i}(a) { const v = a + ${i}; return v; }\n`;
  const FILE = path.join(DIR, "big.js");
  fs.writeFileSync(FILE, src);

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && !!window.atomnano, null, { timeout: 15000 });

  const t0 = Date.now();
  await win.evaluate((p) => window.__openInEditor(p), FILE);
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 15000 });
  await win.waitForTimeout(400);
  const openMs = Date.now() - t0;
  ok(openMs < 6000, `opened a ${N}-line file quickly (${openMs}ms)`);

  // whole document is present in the model
  ok(await win.evaluate(() => window.__cm().docText().split("\n").length >= 30000), `full ${N}-line document is loaded`);

  // CM6 virtualizes — only a viewport's worth of lines are in the DOM, not all N
  const domLines = await win.evaluate(() => document.querySelectorAll(".cm-content .cm-line").length);
  ok(domLines > 0 && domLines < 2000, `viewport is virtualized (${domLines} line nodes in the DOM, not ${N})`);

  // top-of-file token is highlighted
  ok(await win.evaluate(() => [...document.querySelectorAll(".cm-content .cm-line span")].some((s) => s.textContent === "function")), "top-of-file keyword is highlighted");

  // scroll to the bottom → bottom lines render + stay highlighted
  await win.evaluate(() => { const s = document.querySelector(".cm-scroller"); s.scrollTop = s.scrollHeight; });
  await win.waitForTimeout(300);
  ok(await win.evaluate(() => /fn299\d\d/.test(document.querySelector(".cm-content").textContent)), "scrolling renders the bottom of the file");
  // the incremental (Lezer) parser styles the viewport a beat after it scrolls in
  await win.waitForFunction(() => {
    const kw = new Set(["function", "const", "return"]);
    return [...document.querySelectorAll(".cm-content .cm-line span")].some((s) => kw.has(s.textContent));
  }, null, { timeout: 4000 }).catch(() => {});
  ok(await win.evaluate(() => { const kw = new Set(["function", "const", "return"]); return [...document.querySelectorAll(".cm-content .cm-line span")].some((s) => kw.has(s.textContent)); }), "bottom lines stay highlighted after scroll");

  // go-to-offset (Ctrl-click target) scrolls the destination into the CENTRE
  await win.evaluate(() => { const cm = window.__cm(); const off = cm.docText().indexOf("fn15000"); cm.gotoOffset(off, 7); });
  await win.waitForTimeout(350);
  const centered = await win.evaluate(() => {
    const view = window.__cm().view;
    const c = view.coordsAtPos(view.state.selection.main.from);
    if (!c) return false;
    const sc = view.scrollDOM.getBoundingClientRect();
    const rel = (c.top - sc.top) / sc.height;   // 0 = top edge, 1 = bottom edge
    return rel > 0.2 && rel < 0.8;
  });
  ok(centered, "go-to-offset scrolls the target into the centre of the viewport");

  // typing remains responsive
  await win.evaluate(() => { const s = document.querySelector(".cm-scroller"); s.scrollTop = 0; });
  await win.waitForTimeout(150);
  await win.click(".cm-content");
  await win.evaluate(() => window.__cm().view.dispatch({ selection: { anchor: 0 } }));
  const tt = Date.now();
  await win.keyboard.type("const ZZTOP = 1;\n");
  const typeMs = Date.now() - tt;
  await win.waitForTimeout(150);
  ok(await win.evaluate(() => window.__cm().docText().startsWith("const ZZTOP")), "typed text is inserted at the top");
  ok(typeMs < 4000, `typing into the big file stays responsive (${typeMs}ms for the edit)`);

  await app.close();
  console.log(process.exitCode ? "\nSOME BIG-FILE TESTS FAILED" : "\nALL BIG-FILE TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
