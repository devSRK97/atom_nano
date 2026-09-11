/* Visual capture: boot the app, exercise the new layout, save screenshots. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist", "shots");
const git = (cwd, a) => { try { return execFileSync("git", a, { cwd }).toString(); } catch (e) { return ""; } };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // temp repo with a mix of changes for the commit view
  const REPO = path.join(os.tmpdir(), "atomnano-visual-repo");
  fs.rmSync(REPO, { recursive: true, force: true }); fs.mkdirSync(REPO, { recursive: true });
  git(REPO, ["init", "-b", "main"]); git(REPO, ["config", "user.email", "t@t.co"]); git(REPO, ["config", "user.name", "Test"]);
  for (const f of ["index.js", "utils.js", "README.md"]) fs.writeFileSync(path.join(REPO, f), "v1\n");
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "init"]);
  fs.writeFileSync(path.join(REPO, "index.js"), "v2 modified\n");
  fs.writeFileSync(path.join(REPO, "utils.js"), "v2 modified\n");
  git(REPO, ["add", "utils.js"]);                                  // staged
  fs.writeFileSync(path.join(REPO, "newfile.ts"), "untracked\n");  // untracked

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && typeof window.__openInEditor === "function", null, { timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1480, 920); w.center(); });
  await win.waitForTimeout(600);

  // 1) default — chat header tabs + titlebar (should now detect the sub-repos)
  await win.waitForTimeout(800);   // let refreshGit discover repos
  await win.screenshot({ path: path.join(OUT, "1-main.png") });

  // 1b) real git view on the actually-opened project (discovers sub-repos)
  await win.evaluate(() => window.__sidebarView("git"));
  await win.waitForTimeout(1100);
  await win.screenshot({ path: path.join(OUT, "1b-real-git.png") });
  // expand the first tracked folder + the Untracked files accordion for a detail shot
  await win.evaluate(() => {
    const tracked = document.querySelector("#fileTree .gv-repo:not(.gv-untracked)");
    if (tracked) tracked.click();
    const ut = document.querySelector("#fileTree .gv-untracked");
    if (ut) ut.click();
  });
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(OUT, "1c-git-expanded.png") });
  await win.evaluate(() => window.__sidebarView("files"));
  await win.waitForTimeout(300);

  // 2) open a couple of files (highlight + editor + multiple session tabs)
  await win.evaluate(async () => { await window.atomnano.sessions.create({ name: "Session Two" }); });
  const opened = await win.evaluate(async () => {
    const rows = [...document.querySelectorAll('#fileTree .tree-row[data-dir="0"]')].slice(0, 1);
    if (rows[0]) rows[0].click();
    await new Promise((r) => setTimeout(r, 600));
    return !!document.querySelector(".cm-content");
  });
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(OUT, "2-editor-highlight.png") });
  // tight crop of just the tab-strip row to compare editor-tab vs session-tab heights
  await win.screenshot({ path: path.join(OUT, "2b-tabstrip.png"), clip: { x: 0, y: 34, width: 1480, height: 56 } });
  const heights = await win.evaluate(() => {
    const g = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height) : null; };
    return { chatHeader: g(".chat-header"), chtTabs: g(".cht-tabs"), chtTab: g(".cht-tab"), editorTabs: g(".editor-tabs"), editorTab: g(".editor-tab") };
  });
  console.log("HEIGHTS", JSON.stringify(heights));

  // 3) File menu open
  await win.evaluate(() => { const b = [...document.querySelectorAll("#tbActions .tb-btn")].find((x) => /File/.test(x.textContent)); b.click(); });
  await win.waitForTimeout(250);
  await win.screenshot({ path: path.join(OUT, "3-file-menu.png") });
  await win.keyboard.press("Escape");

  // 4) git commit view with real repo status injected
  const st = await win.evaluate((cwd) => window.atomnano.git.status(cwd), REPO);
  await win.evaluate((s) => window.__renderGitView(s), st);
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(OUT, "4-git-commit-view.png") });

  // 5) git commit view on the light theme (theme adaptation)
  await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await win.evaluate((s) => window.__renderGitView(s), st);
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(OUT, "5-git-light.png") });

  console.log("shots saved to", OUT);
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
