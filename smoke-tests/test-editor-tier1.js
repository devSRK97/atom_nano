/* Tier 1 editing commands: move/copy/delete/duplicate line, select-all-occurrences, block comment. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-tier1");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "t.js"), "alpha\nbravo\ncharlie\nalpha\nalpha\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  await win.evaluate((p) => window.__openInEditor(p), P("t.js"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(400);

  // Helper: reset the file content
  const reset = async (text) => { await win.evaluate((t) => { const cm = window.__cm(); cm.view.dispatch({ changes: { from: 0, to: cm.view.state.doc.length, insert: t } }); }, text); };

  /* 1) moveLineDown: caret on line 1, move it down */
  await reset("alpha\nbravo\ncharlie\n");
  await win.evaluate(() => window.__cm().gotoLine(1, 1));
  await win.evaluate(() => window.__cm().moveLineDown());
  let v = await win.evaluate(() => window.__cm().getValue());
  ok(v.startsWith("bravo\nalpha\n"), `moveLineDown swapped lines 1↔2 (${JSON.stringify(v.slice(0, 20))})`);

  /* 2) moveLineUp: caret on line 2, move it up */
  await reset("alpha\nbravo\ncharlie\n");
  await win.evaluate(() => window.__cm().gotoLine(2, 1));
  await win.evaluate(() => window.__cm().moveLineUp());
  v = await win.evaluate(() => window.__cm().getValue());
  ok(v.startsWith("bravo\nalpha\n"), `moveLineUp swapped lines 2↔1 (${JSON.stringify(v.slice(0, 20))})`);

  /* 3) copyLineDown: caret on line 1, duplicate below */
  await reset("alpha\nbravo\n");
  await win.evaluate(() => window.__cm().gotoLine(1, 1));
  await win.evaluate(() => window.__cm().copyLineDown());
  v = await win.evaluate(() => window.__cm().getValue());
  ok(/^alpha\nalpha\nbravo/.test(v), `copyLineDown duplicated line 1 below (${JSON.stringify(v.slice(0, 24))})`);

  /* 4) deleteLine: caret on line 2, delete it */
  await reset("alpha\nbravo\ncharlie\n");
  await win.evaluate(() => window.__cm().gotoLine(2, 1));
  await win.evaluate(() => window.__cm().deleteLine());
  v = await win.evaluate(() => window.__cm().getValue());
  ok(/^alpha\ncharlie\n$/.test(v), `deleteLine removed line 2 (${JSON.stringify(v)})`);

  /* 5) duplicateLine: caret on line 1, duplicate below */
  await reset("alpha\nbravo\n");
  await win.evaluate(() => window.__cm().gotoLine(1, 1));
  await win.evaluate(() => window.__cm().duplicateLine());
  v = await win.evaluate(() => window.__cm().getValue());
  ok(/^alpha\nalpha\nbravo/.test(v), `duplicateLine cloned line 1 (${JSON.stringify(v.slice(0, 24))})`);

  /* 6) selectAllOccurrences: select "alpha", then all */
  await reset("alpha\nbravo\nalpha\nalpha\n");
  await win.evaluate(() => window.__cm().selectRange(0, 5));   // select "alpha"
  await win.evaluate(() => window.__cm().selectAllOccurrences());
  const sels = await win.evaluate(() => window.__cm().view.state.selection.ranges.length);
  ok(sels === 3, `selectAllOccurrences found all 3 "alpha" (${sels})`);

  /* 7) toggleBlockComment: select a region and wrap in block comment */
  await reset("const x = 1;\nconst y = 2;\n");
  await win.evaluate(() => window.__cm().selectRange(0, 12));   // "const x = 1;"
  await win.evaluate(() => window.__cm().toggleBlockComment());
  v = await win.evaluate(() => window.__cm().getValue());
  ok(/\/\*/.test(v) && /\*\//.test(v), `toggleBlockComment wrapped in /* */ (${JSON.stringify(v.slice(0, 30))})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME TIER-1 TESTS FAILED" : "\nALL TIER-1 TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
