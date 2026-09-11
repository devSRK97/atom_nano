/* Formatting / Files / UI batch:
 *  - Prettier formatting for CSS/JSON/etc. (Shift+Alt+F → formatDoc)
 *  - CRLF/EOL detection + preservation on save + status-bar indicator
 *  - Render-whitespace toggle (setWhitespace)
 *  - Inline CSS colour swatches
 *  - Persistent fold state across file switches
 *  - Auto-save (debounced)
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-files");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  // messy CSS for prettier + colour swatches
  fs.writeFileSync(path.join(DIR, "messy.css"), "a{color:#ff0000;background:   rgba(0,0,0,.5)}\n.b   {  margin : 0 }\n");
  // CRLF file (Windows line endings) for EOL preservation
  fs.writeFileSync(path.join(DIR, "win.js"), "const a = 1;\r\nconst b = 2;\r\n");
  // LF file with tabs + trailing spaces for render-whitespace
  fs.writeFileSync(path.join(DIR, "ws.js"), "function f() {\n\treturn 1;  \n}\n");
  // foldable file for persistent folds
  fs.writeFileSync(path.join(DIR, "fold.js"), "function big() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n\nconst z = 3;\n");
  // file for auto-save
  fs.writeFileSync(path.join(DIR, "auto.txt"), "start\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* ---------- 1) Prettier formatting (CSS) ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("messy.css"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(400);
  const fmtOk = await win.evaluate(async () => { await window.__cm().formatDoc(); return window.__cm().getValue(); });
  ok(/color:\s*#ff0000;/.test(fmtOk) && /\{\n/.test(fmtOk), "Prettier reformatted the CSS (multiline, normalised spacing)");

  /* ---------- 2) CSS colour swatches ---------- */
  await win.waitForTimeout(200);
  const swatches = await win.evaluate(() => document.querySelectorAll(".cm-color-swatch").length);
  ok(swatches >= 1, `inline colour swatches rendered (${swatches})`);

  /* ---------- 3) CRLF detection + status-bar indicator ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("win.js"));
  await win.waitForTimeout(400);
  const eolText = await win.evaluate(() => { const e = document.querySelector(".editor-status .es-eol"); return e ? e.textContent.trim() : ""; });
  ok(eolText === "CRLF", `status bar shows CRLF for a Windows-EOL file (got "${eolText}")`);

  /* ---------- 4) CRLF preserved on save ---------- */
  await win.click(".cm-content");
  await win.keyboard.press("Control+End");
  await win.keyboard.type(";");
  await win.keyboard.press("Control+s");
  await win.waitForTimeout(500);
  const winDisk = fs.readFileSync(path.join(DIR, "win.js"), "utf8");
  ok(/\r\n/.test(winDisk) && !/[^\r]\n/.test(winDisk), "CRLF line endings preserved on save");

  /* ---------- 5) Render whitespace toggle ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("ws.js"));
  await win.waitForTimeout(400);
  await win.evaluate(() => window.__cm().setWhitespace(true));
  await win.waitForTimeout(200);
  const wsMarks = await win.evaluate(() => document.querySelectorAll(".cm-highlightSpace, .cm-highlightTab").length);
  ok(wsMarks >= 1, `render-whitespace markers shown when enabled (${wsMarks})`);
  await win.evaluate(() => window.__cm().setWhitespace(false));
  await win.waitForTimeout(150);
  const wsOff = await win.evaluate(() => document.querySelectorAll(".cm-highlightSpace, .cm-highlightTab").length);
  ok(wsOff === 0, "render-whitespace markers removed when disabled");

  /* ---------- 6) Persistent folds across file switches ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("fold.js"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(500);
  const folded1 = await win.evaluate(() => { window.__cm().foldAll(); return window.__cm().foldedCount(); });
  ok(folded1 >= 1, `folded the function in fold.js (${folded1})`);
  // switch away then back
  await win.evaluate((p) => window.__openInEditor(p), P("auto.txt"));
  await win.waitForTimeout(300);
  await win.evaluate((p) => window.__openInEditor(p), P("fold.js"));
  await win.waitForTimeout(500);
  const folded2 = await win.evaluate(() => window.__cm().foldedCount());
  ok(folded2 >= 1, `fold restored after switching back (${folded2})`);

  /* ---------- 7) Auto-save (debounced) ---------- */
  await win.evaluate(() => window.__setSetting("editorAutoSave", true));
  await win.evaluate((p) => window.__openInEditor(p), P("auto.txt"));
  await win.waitForTimeout(300);
  await win.click(".cm-content");
  await win.keyboard.press("Control+End");
  await win.keyboard.type(" EDIT");
  await win.waitForTimeout(1600);   // > 1200ms debounce
  const autoDisk = fs.readFileSync(path.join(DIR, "auto.txt"), "utf8");
  ok(/EDIT/.test(autoDisk), "auto-save wrote the edit to disk without Ctrl+S");

  ok(errors.length === 0, "no page errors during the files/UI flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME FILES/UI TESTS FAILED" : "\nALL FILES/UI TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
