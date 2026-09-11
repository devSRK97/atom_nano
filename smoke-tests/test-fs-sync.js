/* Filesystem sync: the file tree + open editor stay in sync with changes made by
 * an external process (another editor, the AI agent, a git op) — no manual
 * refresh. Added/removed files appear/disappear in the tree; an externally
 * modified open file reloads in the editor UNLESS it has unsaved edits, which are
 * never clobbered. Driven against a real temp folder watched by the app. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const WROOT = path.join(os.tmpdir(), "atomnano-fswatch");
  fs.rmSync(WROOT, { recursive: true, force: true });
  fs.mkdirSync(WROOT, { recursive: true });
  fs.writeFileSync(path.join(WROOT, "a.txt"), "A1\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && typeof window.__openTree === "function", null, { timeout: 15000 });

  // 1) open the folder as the tree root → the app starts watching it
  const watched = await win.evaluate((p) => window.__openTree(p), WROOT.replace(/\\/g, "/"));
  await sleep(300);
  ok(/atomnano-fswatch$/.test(watched), `app is watching the opened folder (${watched})`);
  ok((await win.evaluate(() => window.__treeNames())).includes("a.txt"), "file tree shows the initial file (a.txt)");

  // 2) a file ADDED by an external process appears WITHOUT a manual refresh
  fs.writeFileSync(path.join(WROOT, "b.txt"), "B\n");
  await sleep(900);
  ok((await win.evaluate(() => window.__treeNames())).includes("b.txt"), "externally ADDED file auto-appears in the tree");

  // 3) a file REMOVED by an external process disappears
  fs.rmSync(path.join(WROOT, "b.txt"));
  await sleep(900);
  ok(!(await win.evaluate(() => window.__treeNames())).includes("b.txt"), "externally REMOVED file auto-disappears from the tree");

  // 4) an externally MODIFIED open file reloads in the editor (when not dirty)
  await win.evaluate((p) => window.__openInEditor(p), path.join(WROOT, "a.txt").replace(/\\/g, "/"));
  await sleep(300);
  ok((await win.evaluate(() => window.__editorCM())) === "A1\n", "editor opened a.txt with its on-disk content");
  fs.writeFileSync(path.join(WROOT, "a.txt"), "A2-external\n");
  await sleep(900);
  ok((await win.evaluate(() => window.__editorCM())) === "A2-external\n", "externally MODIFIED open file auto-reloaded in the editor");
  ok((await win.evaluate(() => window.__editorState())).dirty === false, "auto-reloaded file is not marked dirty");

  // 5) unsaved edits are NEVER clobbered by an external change
  await win.evaluate(() => window.__editorType("MY UNSAVED EDITS\n"));
  ok((await win.evaluate(() => window.__editorState())).dirty === true, "typing makes the editor dirty");
  fs.writeFileSync(path.join(WROOT, "a.txt"), "A3-external\n");
  await sleep(900);
  const es = await win.evaluate(() => window.__editorState());
  ok(es.content === "MY UNSAVED EDITS\n" && es.dirty === true, "external change did NOT clobber unsaved edits");
  ok(/changed on disk/i.test(await win.evaluate(() => window.__lastToast())), "a 'changed on disk' notice is shown for the conflict");

  ok(errors.length === 0, "no page errors during the fs-sync flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME FS-SYNC TESTS FAILED" : "\nALL FS-SYNC TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
