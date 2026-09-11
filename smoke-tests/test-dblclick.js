/* Double-click selects one identifier segment; the dot breaks it (CodeMirror 6). */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-dblclick");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "d.js"), "const x = testers.test;\nconst y = my_var + cd-pl;\n");
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "d.js"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(300);

  // place a synthetic double-click (detail:2 mousedown) at the middle of `inWord`
  // inside `needle`, then read what CM6 selected.
  const sel = (needle, inWord) => win.evaluate(({ needle, inWord }) => {
    const view = window.__cm().view;
    const doc = view.state.doc.toString();
    const off = doc.indexOf(needle) + Math.floor(inWord.length / 2);
    const c = view.coordsAtPos(off);
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2, clientX: c.left + 2, clientY: (c.top + c.bottom) / 2 }));
    return window.__cm().selection().text;
  }, { needle, inWord });

  ok((await sel("testers.test", "testers")) === "testers", "double-click on 'testers' (in testers.test) selects 'testers' only");
  ok((await sel(".test", "test")) === "test", "double-click on 'test' (after the dot) selects 'test' only");
  ok((await sel("my_var", "my_var")) === "my_var", "double-click on 'my_var' keeps the underscore (whole)");
  ok((await sel("cd-pl", "cd-pl")) === "cd-pl", "double-click on 'cd-pl' keeps the dash (whole)");

  await app.close();
  console.log(process.exitCode ? "\nSOME DBLCLICK TESTS FAILED" : "\nALL DBLCLICK TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
