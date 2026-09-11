/* Stress test (CodeMirror 6): a ~1,000,000-line file opens without hanging, the
 * viewport stays virtualized (only visible lines in the DOM), and scrolling +
 * highlighting stay responsive across the file. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-1m");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const FILE = path.join(DIR, "huge.js");
  const N = 1000000;
  if (!fs.existsSync(FILE) || fs.statSync(FILE).size < 30 * 1024 * 1024) {
    const ws = fs.createWriteStream(FILE);
    for (let i = 0; i < N; i++) ws.write(`function fn${i}(a) { const v = a + ${i}; return v; }\n`);
    await new Promise((r) => ws.end(r));
  }
  const sizeMB = (fs.statSync(FILE).size / 1048576).toFixed(1);
  console.log(`file: ${N} lines, ${sizeMB} MB`);

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && !!window.atomnano, null, { timeout: 15000 });

  const t0 = Date.now();
  await win.evaluate((p) => window.__openInEditor(p), FILE);
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 60000 });
  await win.waitForFunction(() => window.__cm() && window.__cm().docText().length > 30000000, null, { timeout: 60000 });
  const openMs = Date.now() - t0;
  ok(openMs < 30000, `1M-line file opened in ${openMs}ms (no hang)`);

  await win.waitForTimeout(500);
  // CM6 only renders the visible viewport — a few dozen line nodes, not 1,000,000
  const domLines = await win.evaluate(() => document.querySelectorAll(".cm-content .cm-line").length);
  ok(domLines > 0 && domLines < 2000, `viewport virtualized (${domLines} line nodes, not ${N})`);
  ok(await win.evaluate(() => /\bfn0\b/.test(document.querySelector(".cm-content").textContent)), "top of file is rendered");

  // scroll to ~middle → mid-file functions render
  await win.evaluate(() => { const s = document.querySelector(".cm-scroller"); s.scrollTop = Math.floor(s.scrollHeight / 2); });
  await win.waitForTimeout(600);
  ok(await win.evaluate(() => /fn[45]\d\d\d\d\d/.test(document.querySelector(".cm-content").textContent)), "scrolling to the middle renders mid-file content");

  // editor stays interactive at 1M lines (cursor moves are instant — no full-doc work)
  const tCur = Date.now();
  await win.evaluate(() => window.__cm().view.dispatch({ selection: { anchor: 100 } }));
  await win.evaluate(() => window.__cm().view.dispatch({ selection: { anchor: 50 } }));
  const curMs = Date.now() - tCur;
  ok(curMs < 2000, `editor stays responsive at 1M lines (two cursor moves in ${curMs}ms)`);

  await app.close();
  console.log(process.exitCode ? "\n1M-LINE TEST FAILED" : "\n1M-LINE TEST PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
