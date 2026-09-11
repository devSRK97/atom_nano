/* Ctrl+click go-to-definition (CodeMirror 6): local symbol, import path,
 * cross-file symbol. Scoped to js/ts/python/json. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-gotodef");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "lib.js"), "export function helper(x) {\n  return x * 2;\n}\n");
  const appJs =
`import { helper } from './lib';

function localFn(a) {
  return a + 1;
}

const result = localFn(helper(3));
console.log(result);
`;
  fs.writeFileSync(path.join(DIR, "app.js"), appJs);

  const udir = path.join(os.tmpdir(), "atomnano-gotodef-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && !!window.atomnano, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(200);
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "app.js").replace(/\\/g, "/"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(300);

  // ctrl-click at the middle of `needle` (occurrence n) → go-to-definition
  const gotoToken = async (needle, occurrence = 1) => {
    await win.evaluate(({ needle, occurrence }) => {
      const doc = window.__cm().docText();
      let idx = -1; for (let k = 0; k < occurrence; k++) idx = doc.indexOf(needle, idx + 1);
      window.__gotoDef(idx + Math.floor(needle.length / 2));
    }, { needle, occurrence });
    await win.waitForTimeout(1500);   // TS utility process may cold-start + the heuristic fallback is async
  };
  const sel = () => win.evaluate(() => { const s = window.__cm().selection(); return { line: window.__cm().lineOf(s.from), text: s.text }; });
  const activeFile = () => win.evaluate(() => { const t = document.querySelector(".editor-tab.active .et-name"); return t ? t.textContent : null; });

  // 1) local symbol: click the CALL site of localFn (unambiguous: "localFn(helper")
  await gotoToken("localFn(helper", 1);
  let s = await sel();
  ok(s.text === "localFn", `local symbol jumped to its definition (selected "${s.text}")`);
  ok(s.line === 3, `landed on the 'function localFn' line (line ${s.line})`);

  // 2) import path: ctrl-click inside './lib'
  await gotoToken("./lib", 1);
  ok((await activeFile()) === "lib.js", `import path opened the target file (active=${await activeFile()})`);

  // back to app.js, 3) cross-file symbol: ctrl-click `helper` usage
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "app.js").replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  await gotoToken("helper(3)", 1);
  ok((await activeFile()) === "lib.js", `cross-file symbol opened lib.js (active=${await activeFile()})`);
  s = await sel();
  ok(/helper/.test(s.text), `selected the cross-file definition token ("${s.text}")`);

  await app.close();
  console.log(process.exitCode ? "\nSOME GOTODEF TESTS FAILED" : "\nALL GOTODEF TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
