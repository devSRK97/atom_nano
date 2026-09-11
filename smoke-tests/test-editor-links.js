/* Editor (CodeMirror 6): function names are syntax-shaded, Ctrl-hover underlines
 * the click target (cm-link-target + link cursor), and Ctrl+click a variable
 * jumps to its definition within the file. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-links");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const code = [
    "function doThing(n) {",
    "  return n + 1;",
    "}",
    "const myVar = 41;",
    "const out = doThing(myVar);",
    "console.log(out);",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(DIR, "main.js"), code);

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "main.js"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(400);

  // 1) function names are syntax-shaded (distinct colour from body text)
  const shade = await win.evaluate(() => {
    const body = getComputedStyle(document.querySelector(".cm-content")).color;
    const span = [...document.querySelectorAll(".cm-content .cm-line span")].find((s) => s.textContent === "doThing");
    return span ? { color: getComputedStyle(span).color, body } : null;
  });
  ok(shade && shade.color !== shade.body, `function name is syntax-shaded (${shade && shade.color} vs body ${shade && shade.body})`);

  // 2) Ctrl-hover over the doThing() call → cm-link-target + link cursor
  await win.evaluate(() => {
    const view = window.__cm().view;
    const off = view.state.doc.toString().indexOf("doThing(myVar)") + 3;
    const c = view.coordsAtPos(off);
    view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ctrlKey: true, clientX: c.left + 2, clientY: (c.top + c.bottom) / 2 }));
  });
  await win.waitForTimeout(200);
  const hover = await win.evaluate(() => {
    const link = document.querySelector(".cm-content .cm-link-target");
    return { text: link ? link.textContent : null, cursor: !!document.querySelector(".cm-scroller.cm-ctrl") };
  });
  ok(hover.text === "doThing", `Ctrl-hover underlines the target ("${hover.text}")`);
  ok(hover.cursor, "Ctrl-hover shows the link cursor");

  // 3) Ctrl+click a variable usage → jump to its definition line
  await win.evaluate(() => {
    const doc = window.__cm().docText();
    const off = doc.indexOf("doThing(myVar)") + "doThing(".length + 2;   // inside `myVar`
    window.__gotoDef(off);
  });
  await win.waitForTimeout(350);
  const v = await win.evaluate(() => { const s = window.__cm().selection(); return { text: s.text, line: window.__cm().lineOf(s.from) }; });
  ok(v.text === "myVar", `variable jump selected the definition token ("${v.text}")`);
  ok(v.line === 4, `landed on the 'const myVar' line (line ${v.line})`);

  await app.close();
  console.log(process.exitCode ? "\nSOME EDITOR-LINK TESTS FAILED" : "\nALL EDITOR-LINK TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
