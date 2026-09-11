/* Session tabs in chat header (+ overflow), titlebar File/Git toolbar, file-tree
 * highlight, and the git backend (status/stage/commit) on a real temp repo. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

function git(cwd, args) { try { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString(); } catch (e) { return (e.stdout || "") + (e.stderr || ""); } }

(async () => {
  // --- build a temp git repo with a committed file + one modified + one untracked ---
  const REPO = path.join(os.tmpdir(), "atomnano-gitrepo");
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, ["init", "-b", "main"]);
  git(REPO, ["config", "user.email", "t@t.co"]);
  git(REPO, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(REPO, "a.txt"), "hello\n");
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "init"]);
  fs.writeFileSync(path.join(REPO, "a.txt"), "hello world\n");   // modified (unstaged)
  fs.writeFileSync(path.join(REPO, "b.txt"), "new file\n");      // untracked

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && typeof window.__openInEditor === "function", null, { timeout: 15000 });
  await win.evaluate(() => window.__setFsSync && window.__setFsSync(false)); // isolate from the fs watcher (this suite injects fake git state)
  await win.waitForTimeout(400);

  // 1) layout: session tabs moved into chat header, with History + Plus actions
  ok(await win.evaluate(() => !!document.querySelector("#main #chatHeader #tabs")), "session tab strip is inside the chat panel header");
  ok(await win.evaluate(() => document.querySelectorAll("#chatHeader .cht-tab").length >= 1), "at least one session tab renders in the header");
  ok(await win.evaluate(() => !!document.querySelector("#chatHeader #histBtn") && !!document.querySelector("#chatHeader #newTab")), "chat header has History + New-session (Plus) buttons");
  ok(await win.evaluate(() => !document.querySelector("#tabstrip")), "old top tab strip is gone");

  // 2) titlebar File menu + git toolbar exist
  ok(await win.evaluate(() => { const b = [...document.querySelectorAll("#tbActions .tb-btn")].map((x) => x.textContent); return b.some((t) => /File/.test(t)); }), "titlebar has a File menu button");
  // repo-switcher dropdown was removed per request
  ok(await win.evaluate(() => !document.querySelector("#tbActions .tb-branch")), "titlebar has no repo-switcher dropdown (removed per request)");

  // 3) file-tree highlight: click the first file row → it gets .active + opens
  const clicked = await win.evaluate(async () => {
    const row = [...document.querySelectorAll('#fileTree .tree-row[data-dir="0"]')][0];
    if (!row) return { skip: true };
    row.click();
    await new Promise((r) => setTimeout(r, 500));
    const active = document.querySelector("#fileTree .tree-row.active");
    return { skip: false, hasActive: !!active, sameRow: active === row };
  });
  if (clicked.skip) console.log("PASS: (no files in project tree to click — highlight click skipped)");
  else ok(clicked.hasActive && clicked.sameRow, "clicking a file highlights its tree row (.active)");

  // 4) git backend on the temp repo (status parse + stage + commit)
  const st = await win.evaluate((cwd) => window.atomnano.git.status(cwd), REPO);
  ok(st.repo && st.branch === "main", `git status: repo on branch main (branch=${st.branch})`);
  ok(st.files.some((f) => f.path === "a.txt" && f.unstaged) && st.files.some((f) => f.path === "b.txt" && f.label === "Untracked"), `status lists modified + untracked (${st.files.map((f) => f.path + ":" + f.label).join(", ")})`);

  await win.evaluate((cwd) => window.atomnano.git.stage(cwd, ["a.txt"]), REPO);
  const st2 = await win.evaluate((cwd) => window.atomnano.git.status(cwd), REPO);
  ok(st2.files.find((f) => f.path === "a.txt").staged, "staging a.txt marks it staged");

  await win.evaluate((cwd) => window.atomnano.git.commit(cwd, "update a"), REPO);
  const log = git(REPO, ["log", "--oneline"]);
  ok(/update a/.test(log), `commit created (${log.split("\n")[0]})`);

  // 4b) stageTracked stages tracked changes only — untracked stays unstaged
  fs.writeFileSync(path.join(REPO, "a.txt"), "tracked change\n");   // a.txt now modified (tracked); b.txt still untracked
  await win.evaluate((cwd) => window.atomnano.git.stageTracked(cwd), REPO);
  const stk = await win.evaluate((cwd) => window.atomnano.git.status(cwd), REPO);
  const aS = stk.files.find((f) => f.path === "a.txt"), bS = stk.files.find((f) => f.path === "b.txt");
  ok(aS && aS.staged && bS && !bS.staged, `stage-tracked stages tracked (a.txt staged=${aS && aS.staged}) but NOT untracked (b.txt staged=${bS && bS.staged})`);

  // 5) commit view (WebStorm-style) replaces the tree: inject a status + show it
  const freshStatus = await win.evaluate((cwd) => window.atomnano.git.status(cwd), REPO);
  const gv = await win.evaluate((st) => {
    st.__repo = "demo-repo";
    window.__renderGitView(st);
    const view = document.querySelector("#fileTree .git-view");
    const collapsedRows = view ? view.querySelectorAll(".gv-file").length : 0;   // accordions collapsed by default → 0
    const tracked = view && view.querySelector(".gv-repo:not(.gv-untracked)");
    if (tracked) tracked.click();                                                 // expand the tracked accordion
    const v = document.querySelector("#fileTree .git-view");
    return {
      hasView: !!v,
      hasMsg: !!(v && v.querySelector(".gv-msg textarea")),
      commitBtns: v ? [...v.querySelectorAll(".gv-actions .btn")].map((b) => b.textContent) : [],
      collapsedRows,
      openNow: v ? !!v.querySelector(".gv-repo:not(.gv-untracked).open") : false,
      fileRows: v ? v.querySelectorAll(".gv-file").length : 0,
      checkboxes: v ? v.querySelectorAll(".gv-file input.aqx-check").length : 0,
      trackedGroups: v ? v.querySelectorAll(".gv-repo:not(.gv-untracked)").length : 0,
      hasUntrackedAccordion: v ? !!v.querySelector(".gv-untracked") : false,
      untrackedName: v ? ((v.querySelector(".gv-untracked .gvr-name") || {}).textContent || "") : "",
      repoName: v ? ((v.querySelector(".gv-repo:not(.gv-untracked) .gvr-name") || {}).textContent || "") : "",
      branch: v ? ((v.querySelector(".gv-repo:not(.gv-untracked) .gvr-branch") || {}).textContent || "") : "",
      hasSelectAll: v ? [...v.querySelectorAll(".gvr-act")].some((b) => /Select all/.test(b.textContent)) : false,
      hasClear: v ? [...v.querySelectorAll(".gvr-act")].some((b) => /Clear/.test(b.textContent)) : false,
    };
  }, freshStatus);
  ok(gv.hasView && gv.hasMsg, "commit view renders in the sidebar with a message box");
  ok(gv.commitBtns.some((t) => /^Commit$/.test(t)) && gv.commitBtns.some((t) => /Commit & Push/.test(t)), `commit view has Commit + Commit & Push (${JSON.stringify(gv.commitBtns)})`);
  ok(gv.trackedGroups >= 1, `tracked changes grouped per project folder (${gv.trackedGroups} group)`);
  ok(gv.collapsedRows === 0, "folder accordions are collapsed by default (no file rows shown)");
  ok(gv.openNow && gv.fileRows >= 1 && gv.checkboxes >= 1, `expanding a folder reveals its files with themed checkboxes (${gv.fileRows} rows)`);
  ok(gv.hasUntrackedAccordion && /Untracked/i.test(gv.untrackedName), `untracked files are in a separate accordion ("${gv.untrackedName}")`);
  ok(gv.hasSelectAll && gv.hasClear, "each folder group has Select all + Clear buttons");
  ok(/demo-repo/.test(gv.repoName), `folder group shows the repo name (${gv.repoName})`);
  ok(/main/.test(gv.branch), `folder group shows the branch (${gv.branch})`);
  // current branch shown in the commit-view header (single repo → its branch)
  ok(/main/.test(await win.evaluate(() => (document.querySelector("#fileTree .gvb-name") || {}).textContent || "")), "commit view header shows the current branch");

  // 5b) push → 3-second "Successfully pushed to <branch> branch" notification (real local remote)
  const REMOTE = path.join(os.tmpdir(), "atomnano-remote.git");
  fs.rmSync(REMOTE, { recursive: true, force: true });
  git(os.tmpdir(), ["init", "--bare", REMOTE]);
  git(REPO, ["remote", "remove", "origin"]);
  git(REPO, ["remote", "add", "origin", REMOTE]);
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "pre-push"]);
  git(REPO, ["push", "-u", "origin", "main"]);
  fs.writeFileSync(path.join(REPO, "a.txt"), "to push\n");
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "push me"]);
  const pushToast = await win.evaluate(async (repo) => {
    const st = await window.atomnano.git.status(repo); st.__repo = repo;
    window.__renderGitView(st);
    await window.__pushRepo(repo);
    const t = document.getElementById("toast");
    return { text: t ? t.textContent.trim() : "", visible: t ? !t.classList.contains("hidden") : false };
  }, REPO);
  ok(/Pushed .*main/.test(pushToast.text), `push shows the project + its branch (${pushToast.text})`);
  ok(pushToast.visible, "push success notification is visible");
  // back to files
  await win.evaluate(() => window.__sidebarView("files"));
  ok(await win.evaluate(() => !document.querySelector("#fileTree .git-view") && !!document.querySelector("#fileTree .tree-row")), "‘Back to files’ restores the file tree");

  // 6) multi-repo discovery: a PARENT folder that isn't a repo but whose
  // subfolders are (the reported "no git repo" case).
  const PARENT = path.join(os.tmpdir(), "atomnano-multirepo");
  fs.rmSync(PARENT, { recursive: true, force: true });
  for (const name of ["api", "web"]) {
    const sub = path.join(PARENT, name);
    fs.mkdirSync(sub, { recursive: true });
    git(sub, ["init", "-b", "main"]); git(sub, ["config", "user.email", "t@t.co"]); git(sub, ["config", "user.name", "T"]);
    fs.writeFileSync(path.join(sub, "f.txt"), "x\n");
  }
  fs.writeFileSync(path.join(PARENT, "loose.txt"), "not in a repo\n");   // parent itself is NOT a repo
  const found = await win.evaluate((p) => window.atomnano.git.repos(p), PARENT.replace(/\\/g, "/"));
  ok(Array.isArray(found) && found.length === 2 && found.every((r) => /\/(api|web)$/.test(r)), `discovers repos in subfolders of a non-repo parent (${JSON.stringify(found)})`);
  const single = await win.evaluate((p) => window.atomnano.git.repos(p), REPO.replace(/\\/g, "/"));
  ok(single.length === 1, `a folder that is itself a repo returns just itself (${single.length})`);
  const rf = await win.evaluate((p) => window.atomnano.git.repoForFile(p), path.join(PARENT, "api", "f.txt").replace(/\\/g, "/"));
  ok(/\/api$/.test(rf), `repoForFile resolves a file to its enclosing repo (${rf})`);
  // fast .git check used by the folder right-click "Git pull" option
  ok((await win.evaluate((p) => window.atomnano.git.isRepoDir(p), path.join(PARENT, "api").replace(/\\/g, "/"))) === true, "isRepoDir true for a repo folder");
  ok((await win.evaluate((p) => window.atomnano.git.isRepoDir(p), PARENT.replace(/\\/g, "/"))) === false, "isRepoDir false for a non-repo folder");
  // git actions now live in the project-dropdown row (folderActions); titlebar keeps only File
  const tbBtns = await win.evaluate(() => [...document.querySelectorAll("#tbActions .tb-btn")].map((b) => b.textContent.trim()));
  ok(tbBtns.some((t) => /File/.test(t)) && !tbBtns.some((t) => /Pull|Push|Commit/.test(t)), `titlebar keeps only File (${JSON.stringify(tbBtns)})`);
  const faBtns = await win.evaluate(() => { window.__renderGitView({ repo: true, branch: "main", files: [], clean: true, __repo: "demo" }); return [...document.querySelectorAll("#folderActions .sb-act")].map((b) => b.textContent.trim()); });
  ok(faBtns.some((t) => /Pull/.test(t)) && faBtns.some((t) => /Commit/.test(t)) && !faBtns.some((t) => /Push/.test(t)), `project row shows Pull + Commit, no standalone Push button (${JSON.stringify(faBtns)})`);
  ok(faBtns.some((t) => /Back/.test(t)), `project row shows Back (left arrow) in commit view (${JSON.stringify(faBtns)})`);

  ok(errors.length === 0, "no page errors during boot/use" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME GIT/LAYOUT TESTS FAILED" : "\nALL GIT/LAYOUT TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
