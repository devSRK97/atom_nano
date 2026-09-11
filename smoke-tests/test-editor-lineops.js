/* Editing assists v2: sort lines, join lines, expand/shrink syntax selection. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-lineops");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "list.txt"), "banana\napple\ncherry\n");
  fs.writeFileSync(path.join(DIR, "join.txt"), "const x = {\n   a: 1,\n   b: 2\n}\n");
  fs.writeFileSync(path.join(DIR, "sel.js"), "function f() {\n  const obj = { a: 1, b: 2 };\n  return obj;\n}\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* ---------- 1) sort lines (whole doc when single-line selection) ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("list.txt"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(400);
  await win.evaluate(() => window.__cm().sortLines(false));
  await win.waitForTimeout(150);
  let v = await win.evaluate(() => window.__cm().getValue());
  ok(/^apple\nbanana\ncherry/.test(v), `sort A→Z ordered the lines (${JSON.stringify(v.slice(0, 20))})`);
  await win.evaluate(() => window.__cm().sortLines(true));
  await win.waitForTimeout(150);
  v = await win.evaluate(() => window.__cm().getValue());
  ok(/^cherry\nbanana\napple/.test(v), "sort Z→A reversed the order");

  /* ---------- 2) join lines ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("join.txt"));
  await win.waitForTimeout(400);
  // select lines 1-3 then join
  await win.evaluate(() => { const cm = window.__cm(); cm.selectRange(0, cm.slice(0, 9999).indexOf("b: 2") + 4); });
  await win.evaluate(() => window.__cm().joinLines());
  await win.waitForTimeout(150);
  v = await win.evaluate(() => window.__cm().getValue());
  ok(/const x = \{ a: 1, b: 2/.test(v), `join collapsed the lines (${JSON.stringify(v.slice(0, 30))})`);

  /* ---------- 3) expand / shrink syntax selection ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("sel.js"));
  await win.waitForTimeout(500);
  // put caret inside the "1" value, expand a few times, selection should grow
  await win.evaluate(() => { const cm = window.__cm(); const i = cm.slice(0, 9999).indexOf("a: 1") + 3; cm.selectRange(i, i); });
  const s0 = await win.evaluate(() => { const s = window.__cm().selection(); return s.to - s.from; });
  await win.evaluate(() => window.__cm().expandSelection());
  await win.evaluate(() => window.__cm().expandSelection());
  const s1 = await win.evaluate(() => { const s = window.__cm().selection(); return s.to - s.from; });
  ok(s1 > s0, `expand grew the selection (${s0} → ${s1})`);
  await win.evaluate(() => window.__cm().shrinkSelection());
  const s2 = await win.evaluate(() => { const s = window.__cm().selection(); return s.to - s.from; });
  ok(s2 < s1, `shrink walked the selection back in (${s1} → ${s2})`);

  ok(errors.length === 0, "no page errors during the line-ops flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME LINE-OPS TESTS FAILED" : "\nALL LINE-OPS TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
