/* Checkpoints: snapshot open files, then restore them after edits. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-checkpoints");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "a.txt"), "original A\n");
  fs.writeFileSync(path.join(DIR, "b.txt"), "original B\n");

  const udir = path.join(os.tmpdir(), "atomnano-cp-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__createCheckpoint === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  await win.evaluate((p) => window.__openInEditor(p), P("a.txt"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.evaluate((p) => window.__openInEditor(p), P("b.txt"));
  await win.waitForTimeout(400);

  /* ---------- 1) create a checkpoint of the original content ---------- */
  const cp = await win.evaluate(() => window.__createCheckpoint("test snapshot"));
  ok(cp && cp.files.length === 2, `checkpoint captured both open files (${cp ? cp.files.length : 0})`);
  const list = await win.evaluate(() => window.__checkpoints());
  ok(list.length >= 1 && list[0].label === "test snapshot", "checkpoint appears in the list");

  /* ---------- 2) edit + save both files on disk ---------- */
  fs.writeFileSync(path.join(DIR, "a.txt"), "MUTATED A\nmore\n");
  fs.writeFileSync(path.join(DIR, "b.txt"), "MUTATED B\n");
  // also dirty one in the editor to prove restore overrides editor state
  await win.evaluate(() => { const cm = window.__cm(); cm.replaceRange(0, 0, "editor junk "); });
  await win.waitForTimeout(200);

  /* ---------- 3) restore → disk + editor return to the snapshot ---------- */
  await win.evaluate((id) => window.__restoreCheckpoint(id), cp.id);
  await win.waitForTimeout(700);
  const diskA = fs.readFileSync(path.join(DIR, "a.txt"), "utf8");
  const diskB = fs.readFileSync(path.join(DIR, "b.txt"), "utf8");
  ok(/original A/.test(diskA) && !/MUTATED/.test(diskA), `a.txt restored on disk (${JSON.stringify(diskA.trim())})`);
  ok(/original B/.test(diskB) && !/MUTATED/.test(diskB), `b.txt restored on disk (${JSON.stringify(diskB.trim())})`);
  const editorVal = await win.evaluate(() => window.__cm().getValue());
  ok(/original B/.test(editorVal) && !/junk/.test(editorVal) && !/MUTATED/.test(editorVal), "the open editor reflects the restored content (no dirty junk)");
  const dirty = await win.evaluate(() => window.__editorState().dirty);
  ok(dirty === false, "restored file is not marked dirty");

  /* ---------- 4) auto-checkpoint exists via the status-bar entry ---------- */
  const hasCpUi = await win.evaluate(() => !!document.querySelector(".editor-status .es-cp"));
  ok(hasCpUi, "checkpoints control is present in the status bar");

  ok(errors.length === 0, "no page errors during the checkpoints flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME CHECKPOINT TESTS FAILED" : "\nALL CHECKPOINT TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
