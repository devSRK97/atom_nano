/* CodeMirror 6 find bar — full functionality: open via keyboard + via the global
 * Ctrl+F handler, auto-populate from selection (incl. double-click), live count,
 * next/prev navigation, Aa (case) + ab (whole-word) toggles, Esc close + reopen. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-findbar");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const code = [
    "const test = 1;",
    "const tester = 2;",
    "const Value = test + tester;",
    "const value = Value;",
    "console.log(test, value, Value);",
    "",
  ].join("\n");
  const FILE = path.join(DIR, "find.js");
  fs.writeFileSync(FILE, code);

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  win.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  win.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE.ERR:", m.text()); });
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && !!window.atomnano, null, { timeout: 15000 });
  await win.evaluate((p) => window.__openInEditor(p), FILE);
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(300);

  const barVisible = () => win.evaluate(() => { const b = document.querySelector(".cm-editor .cmfind"); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const inputVal = () => win.evaluate(() => { const i = document.querySelector(".cmfind .cmfind-input"); return i ? i.value : null; });
  const countText = () => win.evaluate(() => { const c = document.querySelector(".cmfind-count"); return c ? c.textContent : null; });
  const total = async () => { const t = await countText(); if (!t) return null; if (/No results/.test(t)) return 0; const m = /of (\d+)/.exec(t); return m ? +m[1] : null; };
  const sel = () => win.evaluate(() => { const s = window.__cm().selection(); return { from: s.from, text: s.text }; });
  const dblclick = (needle) => win.evaluate((n) => {
    const view = window.__cm().view; view.focus();
    const off = view.state.doc.toString().indexOf(n) + Math.floor(n.length / 2);
    const c = view.coordsAtPos(off);
    const at = { bubbles: true, button: 0, clientX: c.left + 2, clientY: (c.top + c.bottom) / 2 };
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { ...at, detail: 2 }));
    view.contentDOM.dispatchEvent(new MouseEvent("mouseup", { ...at, detail: 2 }));   // complete the gesture
  }, needle);

  // 1) Ctrl+F with editor focused → bar opens + is visible
  await win.click(".cm-content");
  await win.keyboard.press("Control+f");
  await win.waitForTimeout(250);
  ok(await barVisible(), "Ctrl+F (editor focused) opens a visible find bar");

  // 2) Esc closes, Ctrl+F reopens
  await win.keyboard.press("Escape");
  await win.waitForTimeout(150);
  ok(!(await win.evaluate(() => !!document.querySelector(".cmfind"))), "Esc closes the find bar");
  await win.click(".cm-content");
  await win.keyboard.press("Control+f");
  await win.waitForTimeout(200);
  ok(await barVisible(), "Ctrl+F reopens the find bar");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(150);

  // 3) global Ctrl+F path (focus NOT in the editor) still opens it
  await win.evaluate(() => { if (document.activeElement) document.activeElement.blur(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true })); });
  await win.waitForTimeout(200);
  ok(await barVisible(), "global Ctrl+F (editor not focused) opens the find bar");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(150);

  // 4) double-click a word + Ctrl+F → auto-populates the box with that word
  await dblclick("tester");
  await win.waitForTimeout(120);
  ok((await sel()).text === "tester", "double-click selected 'tester'");
  await win.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true })));
  await win.waitForTimeout(250);
  ok(await barVisible(), "Ctrl+F after double-click opens the find bar");
  ok((await inputVal()) === "tester", `Ctrl+F after double-click auto-populated the box ("${await inputVal()}")`);
  ok((await total()) >= 1, `auto-populated search shows a live count (${await countText()})`);

  // 5) while the bar is OPEN, double-click a different word + Ctrl+F → box updates
  await dblclick("Value");
  await win.waitForTimeout(120);
  await win.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true })));
  await win.waitForTimeout(200);
  ok((await inputVal()) === "Value", `re-Ctrl+F refills the box from the new selection ("${await inputVal()}")`);

  // 6) live count + next/prev navigation
  await win.fill(".cmfind .cmfind-input", "test");
  await win.waitForTimeout(200);
  const tTest = await total();
  ok(tTest >= 3, `"test" reports a live match count (${await countText()})`);
  await win.keyboard.press("Enter");                 // next
  await win.waitForTimeout(150);
  const s1 = await sel();
  ok(s1.text.toLowerCase() === "test", `Enter jumps the selection to a match ("${s1.text}")`);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(150);
  const s2 = await sel();
  ok(s2.from !== s1.from, "Enter again advances to the next match");
  await win.keyboard.press("Shift+Enter");
  await win.waitForTimeout(150);
  ok((await sel()).from === s1.from, "Shift+Enter goes back to the previous match");

  // 7) whole-word toggle (ab) reduces the count ("test" no longer matches "tester")
  await win.click(".cmfind .cmfind-opt:nth-of-type(2)");   // second opt = ab (whole word)
  await win.waitForTimeout(180);
  const tWord = await total();
  ok(await win.evaluate(() => document.querySelectorAll(".cmfind-opt")[1].classList.contains("on")), "whole-word toggle turns on");
  ok(tWord != null && tWord < tTest, `whole-word reduces matches (${tTest} → ${tWord})`);

  // 8) case toggle (Aa) — "value" lower-case-only count < case-insensitive count
  await win.click(".cmfind .cmfind-opt:nth-of-type(2)");   // turn whole-word back off
  await win.waitForTimeout(120);
  await win.fill(".cmfind .cmfind-input", "value");
  await win.waitForTimeout(180);
  const ciValue = await total();
  await win.click(".cmfind .cmfind-opt:nth-of-type(1)");    // Aa on
  await win.waitForTimeout(180);
  const csValue = await total();
  ok(await win.evaluate(() => document.querySelectorAll(".cmfind-opt")[0].classList.contains("on")), "case toggle (Aa) turns on");
  ok(csValue != null && csValue < ciValue, `match-case reduces matches (${ciValue} → ${csValue})`);

  await app.close();
  console.log(process.exitCode ? "\nSOME FIND-BAR TESTS FAILED" : "\nALL FIND-BAR TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
