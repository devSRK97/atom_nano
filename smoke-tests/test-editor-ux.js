/* Editor UX batch: minimap, regex find, word wrap, bracket-pair colours,
 * add-cursor (Ctrl+Alt+↓), go-to-line (Ctrl+G), and the Problems panel. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-ux");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, "src"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2020", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["src"] }));
  const MAIN = path.join(DIR, "src", "main.ts");
  fs.writeFileSync(MAIN, [
    "const data = { a: [1, 2, 3], b: { c: (4 + 5) * 6 } };",
    "const n1 = 100;",
    "const n2 = 200;",
    'const bad: number = "oops";',
    "function f() { return data; }",
    "export { data, n1, n2, bad, f };",
    "",
  ].join("\n"));

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  await win.evaluate((p) => window.__openInEditor(p), MAIN.replace(/\\/g, "/"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(600);

  // 1) minimap (default on) + toggle
  ok(await win.evaluate(() => !!document.querySelector(".cm-minimap-inner")), "minimap renders (default on)");
  await win.evaluate(() => window.__cm().setMinimap(false));
  await win.waitForTimeout(150);
  ok(!(await win.evaluate(() => !!document.querySelector(".cm-minimap-inner"))), "minimap turns off");
  await win.evaluate(() => window.__cm().setMinimap(true));

  // 2) bracket-pair colours
  ok(await win.evaluate(() => !!document.querySelector(".cm-br0") && !!document.querySelector(".cm-br1")), "rainbow bracket colours applied (nesting depths)");

  // 3) word wrap toggle
  await win.evaluate(() => window.__cm().setWrap(true));
  await win.waitForTimeout(120);
  ok(await win.evaluate(() => !!document.querySelector(".cm-content.cm-lineWrapping")), "word wrap turns on");
  await win.evaluate(() => window.__cm().setWrap(false));
  await win.waitForTimeout(120);
  ok(!(await win.evaluate(() => !!document.querySelector(".cm-content.cm-lineWrapping"))), "word wrap turns off");

  // 4) regex find — "\d+" matches digit runs only when regex is on
  await win.evaluate(() => window.__cm().openSearch());
  await win.waitForTimeout(250);
  await win.evaluate(() => { const i = document.querySelector(".cmfind .cmfind-input"); i.value = "\\d+"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await win.waitForTimeout(150);
  const litCount = await win.evaluate(() => (document.querySelector(".cmfind-count") || {}).textContent || "");
  await win.evaluate(() => { const r = [...document.querySelectorAll(".cmfind .cmfind-opt")].find((b) => b.textContent.trim() === ".*"); if (r) r.click(); });
  await win.waitForTimeout(250);
  const reCount = await win.evaluate(() => (document.querySelector(".cmfind-count") || {}).textContent || "");
  ok(/No results|^$/.test(litCount) && /of\s+([5-9]|\d{2,})/.test(reCount), `regex find counts digit runs (literal="${litCount}" → regex="${reCount}")`);
  await win.evaluate(() => { const b = [...document.querySelectorAll(".cmfind .cmfind-btn")]; if (b.length) b[b.length - 1].click(); });   // close find

  // 5) add cursor below (Ctrl+Alt+↓)
  await win.click(".cm-content");
  await win.evaluate(() => window.__cm().gotoLine(2, 1));
  await win.keyboard.press("Control+Alt+ArrowDown");
  await win.waitForTimeout(120);
  ok((await win.evaluate(() => window.__cm().view.state.selection.ranges.length)) === 2, "Ctrl+Alt+↓ adds a second cursor");
  await win.keyboard.press("Escape");

  // 6) go to line (Ctrl+G)
  await win.click(".cm-content");
  await win.keyboard.press("Control+g");
  await win.waitForSelector("#modalRoot .prompt-input", { timeout: 4000 });
  await win.evaluate(() => { const i = document.querySelector("#modalRoot .prompt-input"); i.value = "4"; });
  await win.evaluate(() => { const b = document.querySelector("#modalRoot .modal-foot .btn-primary"); if (b) b.click(); });
  await win.waitForTimeout(200);
  ok((await win.evaluate(() => window.__cm().lineOf(window.__cm().cursor()))) === 4, "Go to line jumps the caret to the requested line");

  // 7) Problems panel — a real type error appears + click to jump
  let nDiag = 0;
  for (let i = 0; i < 60 && nDiag === 0; i++) { await win.waitForTimeout(250); nDiag = await win.evaluate(() => window.__cm().diagnosticsDetailed().length); }
  ok(nDiag > 0, `diagnostics available for the Problems panel (${nDiag})`);
  await win.evaluate(() => { const b = document.querySelector(".es-problems"); if (b) b.click(); });
  await win.waitForTimeout(250);
  const probs = await win.evaluate(() => {
    const panel = document.getElementById("editorProblems");
    return { open: !!(panel && !panel.classList.contains("hidden")), items: panel ? panel.querySelectorAll(".ep-item").length : 0, badgeHas: !!document.querySelector(".es-problems.has") };
  });
  ok(probs.open && probs.items > 0, `Problems panel opens with ${probs.items} item(s)`);
  ok(probs.badgeHas, "status bar shows an error badge");

  ok(errors.length === 0, "no page errors during the UX flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME EDITOR-UX TESTS FAILED" : "\nALL EDITOR-UX TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
