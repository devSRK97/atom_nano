/* Export user data → real .zip (manifest + preferences + last-7 sessions incl.
 * project folder names); import → restores sessions (preserving id) + merges prefs. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const zipper = require(path.join(__dirname, "..", "src", "main", "zipper.js"));
const ROOT = path.join(__dirname, "..");
const ZIP = path.join(os.tmpdir(), "atomnano-userdata-test.zip");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(ZIP, { force: true });
  const udir = path.join(os.tmpdir(), "atomnano-userdata-test-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  // distinctive prefs + a project + 9 sessions (only last 7 should export)
  await win.evaluate(async () => {
    await window.atomnano.settings.set({ theme: "blue", defaultThinking: "ultrathink", projects: { k1: { path: "C:/Proj/Alpha", openTabIds: ["sX"], tagColor: "#123456" } }, recentProjects: ["C:/Proj/Alpha"] });
    for (let i = 0; i < 9; i++) { const v = await window.atomnano.sessions.create({ name: "S" + i }); await window.atomnano.sessions.update(v.id, { messages: [{ id: "m", role: "user", text: "hi " + i, ts: new Date().toISOString() }] }); }
  });
  const idsBefore = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l.map((s) => s.id)));

  // ---- export (stub save dialog) ----
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, ZIP);
  const exp = await win.evaluate(() => window.atomnano.userdata.export());
  ok(exp && exp.path === ZIP, "export returned the zip path");
  ok(exp.sessions === idsBefore.length, `exported ALL conversations (${exp.sessions}/${idsBefore.length})`);
  ok(exp.projects >= 1, `exported project folder name(s) (${exp.projects})`);
  ok(fs.existsSync(ZIP), "zip written to disk");

  // inspect the zip
  const files = zipper.unzip(fs.readFileSync(ZIP));
  const names = files.map((f) => f.name.replace(/\\/g, "/"));
  const get = (n) => JSON.parse(files.find((f) => f.name === n).data.toString("utf8"));
  ok(names.includes("manifest.json") && names.includes("preferences.json"), "zip has manifest + preferences");
  ok(names.filter((n) => /^sessions\/[^/.]+\.json$/.test(n)).length === idsBefore.length, `zip has every session file (${idsBefore.length})`);
  const manifest = get("manifest.json");
  ok(manifest.kind === "userdata" && manifest.projects.includes("C:/Proj/Alpha"), "manifest includes the project folder name");
  const prefs = get("preferences.json");
  ok(prefs.theme === "blue" && prefs.defaultThinking === "ultrathink" && prefs.projects.k1, "preferences captured (theme, thinking, projects)");
  ok(prefs.apiKey === undefined && prefs.claudePath === undefined, "secrets (apiKey/claudePath) NOT exported");

  // ---- mutate, then import (stub open dialog) ----
  const victim = idsBefore[0];   // most-recent session — guaranteed in the last-7 export
  await win.evaluate((id) => window.atomnano.sessions.delete(id), victim);
  await win.evaluate(() => window.atomnano.settings.set({ theme: "amber", projects: {}, recentProjects: [] }));
  ok(!(await win.evaluate((id) => window.atomnano.sessions.list().then((l) => l.some((s) => s.id === id)), victim)), "victim session deleted pre-import");

  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ZIP);
  const imp = await win.evaluate(() => window.atomnano.userdata.import());
  ok(imp && imp.ok && imp.sessions === idsBefore.length, `import restored every session (${imp && imp.sessions}/${idsBefore.length})`);

  // sessions restored preserving id; prefs merged back
  ok(await win.evaluate((id) => window.atomnano.sessions.list().then((l) => l.some((s) => s.id === id)), victim), "deleted session restored with the SAME id");
  const after = await win.evaluate(() => window.atomnano.settings.get());
  ok(after.theme === "blue", `theme preference restored (${after.theme})`);
  ok(after.defaultThinking === "ultrathink", "thinking preference restored");
  ok(after.projects && after.projects.k1 && after.projects.k1.path === "C:/Proj/Alpha", "project (with folder name + tabs + color) restored");
  ok((after.recentProjects || []).includes("C:/Proj/Alpha"), "recents restored");

  await app.close();
  console.log(process.exitCode ? "\nSOME USERDATA TESTS FAILED" : "\nALL USERDATA TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
