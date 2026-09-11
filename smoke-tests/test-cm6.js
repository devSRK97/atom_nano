/* CodeMirror 6 editor: mounts, syntax-highlights, follows the theme, edits +
 * dirty-tracks, Ctrl-click go-to-definition, find panel, context menu. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-cm6");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "lib.js"), "export function helper(x) {\n  return x * 2;\n}\n");
  const appJs =
`import { helper } from './lib';

// a sample comment
function localFn(a) {
  const v = "hello";
  return a + 1;
}

const result = localFn(helper(3));
console.log(result);
`;
  const FILE = path.join(DIR, "app.js");
  fs.writeFileSync(FILE, appJs);

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && !!window.atomnano, null, { timeout: 15000 });
  await win.evaluate((p) => window.__openInEditor(p), FILE);

  // 1) CM6 mounts
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(300);
  ok(await win.evaluate(() => !!window.__cm()), "CM6 instance is created");

  // 2) document loaded (LF-normalised, matches the file)
  const doc = await win.evaluate(() => window.__cm().docText());
  ok(doc.includes("function localFn(a)") && doc.includes("helper(3)"), "file content is loaded into the editor");

  // 3) syntax highlighting present — the keyword "function" gets its own token span
  const findKwColor = () => win.evaluate(() => {
    const span = [...document.querySelectorAll(".cm-content .cm-line span")].find((s) => s.textContent === "function");
    return span ? getComputedStyle(span).color : null;
  });
  const kwDark = await findKwColor();
  const codeColor = await win.evaluate(() => getComputedStyle(document.querySelector(".cm-content")).color);
  ok(kwDark && kwDark !== codeColor, `keyword token is syntax-coloured (${kwDark}, distinct from body ${codeColor})`);

  // 4) theme adaptation — switch to light, the keyword colour must change (var-driven)
  await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await win.waitForTimeout(150);
  const kwLight = await findKwColor();
  ok(kwLight && kwLight !== kwDark, `token colour follows the theme (dark ${kwDark} → light ${kwLight})`);
  await win.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await win.waitForTimeout(100);

  // 5) Ctrl-click go-to-definition: local symbol (call site → its definition)
  await win.evaluate(() => { const d = window.__cm().docText(); window.__gotoDef(d.indexOf("localFn(helper") + 3); });
  await win.waitForTimeout(1800);   // TS utility process may cold-start on the first definition request
  const sel = await win.evaluate(() => window.__cm().selection());
  ok(sel.text === "localFn", `local symbol jumped to its definition (selected "${sel.text}")`);
  const defLine = await win.evaluate(() => window.__cm().lineOf(window.__cm().selection().from));
  ok(defLine === 4, `landed on the 'function localFn' line (line ${defLine})`);

  // 6) cross-file import path
  await win.evaluate(() => { const d = window.__cm().docText(); window.__gotoDef(d.indexOf("./lib") + 2); });
  await win.waitForTimeout(450);
  const active = await win.evaluate(() => { const t = document.querySelector(".editor-tab.active .et-name"); return t && t.textContent; });
  ok(active === "lib.js", `import path opened the target file (active=${active})`);

  // resolve a CSS var to its computed rgb (for theme comparisons)
  const resolveVar = (v) => win.evaluate((vv) => { const d = document.createElement("div"); d.style.color = "var(" + vv + ")"; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; }, v);
  const bgOf = (sel) => win.evaluate((s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).backgroundColor : null; }, sel);

  // 7) find panel opens (Ctrl+F inside the editor) and is THEMED (not white)
  await win.click(".cm-content");
  await win.keyboard.press("Control+f");
  await win.waitForTimeout(250);
  ok(await win.evaluate(() => !!document.querySelector(".cm-editor .cmfind")), "Ctrl+F opens the custom find bar");
  const inputBg = await bgOf(".cmfind .cmfind-input");
  const insetBg = await resolveVar("--bg-inset");
  ok(inputBg === insetBg, `find input bg follows theme (${inputBg} == --bg-inset ${insetBg}), not white`);
  // chevron prev/next icons + Aa / ab toggles present
  const bar = await win.evaluate(() => {
    const root = document.querySelector(".cmfind");
    return {
      btnSvgs: root.querySelectorAll(".cmfind-btn svg").length,
      caseLabel: [...root.querySelectorAll(".cmfind-opt")].map((b) => b.textContent),
      hasUnderlineWord: !!root.querySelector(".cmfind-opt u"),
    };
  });
  ok(bar.btnSvgs >= 3, `prev/next/close render as icons (${bar.btnSvgs} svg buttons)`);
  ok(bar.caseLabel.includes("Aa"), `case toggle shows "Aa" (${JSON.stringify(bar.caseLabel)})`);
  ok(bar.hasUnderlineWord, "whole-word toggle shows underlined 'ab'");
  // typing a query shows a live "x of N" count ("function" exists in lib.js, the active file)
  await win.fill(".cmfind .cmfind-input", "function");
  await win.waitForTimeout(200);
  ok(/\bof\b/.test(await win.evaluate(() => document.querySelector(".cmfind-count").textContent)), `find shows a live match count ("${await win.evaluate(() => document.querySelector(".cmfind-count").textContent)}")`);
  // case toggle turns "on" (accent background, themed)
  await win.click(".cmfind .cmfind-opt");   // first opt = Aa
  await win.waitForTimeout(120);
  ok(await win.evaluate(() => document.querySelector(".cmfind-opt").classList.contains("on")), "case toggle activates (themed .on state)");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(100);

  // 7b) selection background follows the theme (not CM6's grey/lavender default)
  await win.click(".cm-content");
  await win.evaluate(() => { window.__cm().view.focus(); window.__cm().view.dispatch({ selection: { anchor: 0, head: 6 } }); });
  await win.waitForTimeout(150);
  const selBg = await bgOf(".cm-editor .cm-selectionBackground");
  const stockDefaults = ["rgb(217, 217, 217)", "rgb(215, 212, 240)", "rgba(0, 0, 0, 0)", "rgb(255, 255, 255)", null];
  ok(selBg && !stockDefaults.includes(selBg), `selection background is theme-coloured (${selBg})`);

  // 8) context menu (Cut/Copy/Paste/…) on right-click
  await win.evaluate(() => {
    const el = document.querySelector(".cm-content");
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 30, clientY: r.top + 20 }));
  });
  await win.waitForTimeout(150);
  const menu = await win.evaluate(() => { const m = document.getElementById("ctxMenu"); return m && !m.classList.contains("hidden") ? m.textContent : ""; });
  ok(/Cut/.test(menu) && /Copy/.test(menu) && /Upper case/.test(menu), `editor context menu shows edit actions ("${menu.replace(/\s+/g, " ").trim()}")`);
  await win.evaluate(() => document.getElementById("ctxMenu").classList.add("hidden"));

  // 9) typing updates the doc + marks the tab dirty (do last — it dirties the file)
  await win.click(".cm-content");
  await win.evaluate(() => window.__cm().view.dispatch({ selection: { anchor: 0 } }));
  await win.keyboard.type("const ZZTOP = 1;\n");
  await win.waitForTimeout(200);
  ok(await win.evaluate(() => window.__cm().docText().includes("ZZTOP")), "typed text appears in the document");
  ok(await win.evaluate(() => !!document.querySelector(".editor-tab.active .et-dirty")), "editing marks the tab dirty");

  await app.close();
  console.log(process.exitCode ? "\nSOME CM6 TESTS FAILED" : "\nALL CM6 TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
