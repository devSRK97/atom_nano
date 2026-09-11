/* Split editor:
 *  - toggle split (same file in both panes → live-synced)
 *  - edit in one pane mirrors into the other (shared document)
 *  - independent scroll/cursor per pane
 *  - navigate one pane to a different file (two-file split, unlinks)
 *  - orientation toggle (vertical ⇄ horizontal)
 *  - close split frees the second editor
 *  - split state persists across a project switch
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-split");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "a.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  fs.writeFileSync(path.join(DIR, "b.js"), "function other() {\n  return 42;\n}\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__splitEditor === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* ---------- open a file, then split ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("a.js"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(400);
  await win.evaluate(() => window.__splitEditor());
  await win.waitForTimeout(400);
  let info = await win.evaluate(() => window.__splitInfo());
  ok(info.split === true, "split is on");
  ok(info.hosts === 2 && info.editors === 2, `two pane hosts + two editors (hosts=${info.hosts}, editors=${info.editors})`);
  ok(info.panes[0] === info.panes[1], "both panes show the same file after split");
  ok(info.linked === true, "same-file panes are live-linked");

  /* ---------- edit in pane 0 mirrors into pane 1 ---------- */
  await win.evaluate(() => { const cm = window.__paneCm(0); cm.replaceRange(0, 0, "X"); });
  await win.waitForTimeout(200);
  const p0 = await win.evaluate(() => window.__paneCm(0).getValue());
  const p1 = await win.evaluate(() => window.__paneCm(1).getValue());
  ok(p0 === p1 && /^X/.test(p1), "edit in pane 0 live-synced into pane 1");

  /* ---------- independent scroll/cursor (selection differs) ---------- */
  await win.evaluate(() => { window.__paneCm(0).selectRange(0, 0); window.__paneCm(1).selectRange(5, 5); });
  await win.waitForTimeout(120);
  const sels = await win.evaluate(() => [window.__paneCm(0).cursor(), window.__paneCm(1).cursor()]);
  ok(sels[0] !== sels[1], `panes keep independent cursors (${sels[0]} vs ${sels[1]})`);

  /* ---------- navigate pane 1 to a different file → two-file split (unlinks) ---------- */
  await win.evaluate(() => window.__focusPane(1));
  await win.waitForTimeout(100);
  await win.evaluate((p) => window.__openInEditor(p), P("b.js"));
  await win.waitForTimeout(400);
  info = await win.evaluate(() => window.__splitInfo());
  ok(info.panes[0] !== info.panes[1], "panes now show two different files");
  ok(info.linked === false, "two-file split is unlinked");
  const pane1Val = await win.evaluate(() => window.__paneCm(1).getValue());
  ok(/function other/.test(pane1Val), "pane 1 shows b.js");
  // editing b.js in pane 1 must NOT leak into pane 0 (a.js)
  await win.evaluate(() => window.__paneCm(1).replaceRange(0, 0, "Z"));
  await win.waitForTimeout(150);
  const pane0Val = await win.evaluate(() => window.__paneCm(0).getValue());
  ok(!/^Z/.test(pane0Val), "edit in unlinked pane 1 does not leak into pane 0");

  /* ---------- orientation toggle ---------- */
  await win.evaluate(() => window.__splitOrientation());
  await win.waitForTimeout(200);
  const horiz = await win.evaluate(() => document.querySelector("#editorBody").classList.contains("split-h"));
  ok(horiz === true, "orientation switched to horizontal");
  await win.evaluate(() => window.__splitOrientation());
  await win.waitForTimeout(150);
  const vert = await win.evaluate(() => !document.querySelector("#editorBody").classList.contains("split-h"));
  ok(vert === true, "orientation switched back to vertical");

  /* ---------- close split ---------- */
  await win.evaluate(() => window.__closeSplit());
  await win.waitForTimeout(300);
  info = await win.evaluate(() => window.__splitInfo());
  ok(info.split === false && info.editors === 1 && info.hosts === 1, `split closed, second editor freed (editors=${info.editors})`);

  /* ---------- persistence across project switch ---------- */
  await win.evaluate(() => window.__splitEditor());     // split again
  await win.waitForTimeout(200);
  await win.evaluate(() => window.__focusPane(1));
  await win.evaluate((p) => window.__openInEditor(p), P("b.js"));
  await win.waitForTimeout(400);
  // re-open the same project (switchProject path) and confirm split is restored
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(800);
  info = await win.evaluate(() => window.__splitInfo());
  ok(info.split === true && info.editors === 2, `split restored after project re-open (split=${info.split}, editors=${info.editors})`);

  ok(errors.length === 0, "no page errors during the split flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME SPLIT TESTS FAILED" : "\nALL SPLIT TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
