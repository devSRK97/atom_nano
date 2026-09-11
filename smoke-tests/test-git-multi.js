/* Multi-project git flow: discover several project repos under one folder, then
 * exercise the enhanced commit view — SELECT files (incl. untracked) without
 * staging, COMMIT / COMMIT & PUSH across projects, PUSH ALL, PULL ALL — against
 * real local repos with real (bare, file-path) remotes, asserting the actual git
 * state and the per-project summary toasts. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { tmpRoot, isolatedEnv } = require("./_env");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

function git(cwd, args) { try { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString(); } catch (e) { return (e.stdout || "") + (e.stderr || ""); } }
function subject(repo) { return git(repo, ["log", "-1", "--pretty=%s"]).trim(); }                 // local HEAD message
function remoteSubject(remote) { return git(remote, ["log", "-1", "--pretty=%s", "main"]).trim(); } // bare remote's main-branch tip (HEAD on a bare repo may not point at main)

function mkRepo(parent, remotesDir, name) {
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.co"]); git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "v1\n");
  git(repo, ["add", "-A"]); git(repo, ["commit", "-m", "init"]);
  const remote = path.join(remotesDir, name + ".git");
  git(remotesDir, ["init", "--bare", "-b", "main", remote]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  return { repo, remote };
}
function dirty(repo, marker) {
  fs.writeFileSync(path.join(repo, "tracked.txt"), "v-" + marker + "\n");        // modify a tracked file
  fs.writeFileSync(path.join(repo, "new-" + marker + ".txt"), "added " + marker + "\n"); // add an untracked file
}

(async () => {
  // Unique run folder (fixtures, local remotes, clone) + isolated app profile / git config.
  const RUN = tmpRoot("gitmulti");
  const ENV = isolatedEnv(RUN);
  const PARENT = path.join(RUN, "projects");
  const REMOTES = path.join(RUN, "remotes");
  const CLONE = path.join(RUN, "clone");
  fs.mkdirSync(PARENT, { recursive: true }); fs.mkdirSync(REMOTES, { recursive: true });
  const api = mkRepo(PARENT, REMOTES, "api");
  const web = mkRepo(PARENT, REMOTES, "web");
  dirty(api.repo, "r1"); dirty(web.repo, "r1");                                   // both have a modified + an untracked file

  const app = await electron.launch({ args: [ROOT], env: ENV });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && typeof window.__setProject === "function", null, { timeout: 15000 });
  await win.evaluate(() => window.__setFsSync && window.__setFsSync(false)); // drive git ops explicitly; don't race the fs watcher
  // Record every toast: the app has ONE toast element, and unrelated first-run notices on
  // the isolated profile ("New model available", "Codex signed out") can replace a Git
  // summary within milliseconds. Assertions look at what was shown, not what is showing.
  await win.evaluate(() => { window.__toasts = []; const t = document.getElementById("toast"); new MutationObserver(() => { const s = t.textContent.trim(); if (s && window.__toasts[window.__toasts.length - 1] !== s) window.__toasts.push(s); }).observe(t, { childList: true, subtree: true, characterData: true }); });
  const toastsSince = () => win.evaluate(() => window.__toasts.splice(0));
  const findToast = (list, re) => [...list].reverse().find((s) => re.test(s)) || "";

  // 1) point the app at the parent folder → it discovers both project repos
  await win.evaluate((p) => window.__setProject(p), PARENT.replace(/\\/g, "/"));
  await win.waitForTimeout(350);
  const repos = await win.evaluate(() => window.__gitRepos());
  ok(repos.length === 2, `discovers both project repos under one folder (${repos.length})`);
  const apiKey = repos.find((r) => /\/api$/.test(r));
  const webKey = repos.find((r) => /\/web$/.test(r));
  ok(apiKey && webKey, `resolves the api + web project keys (${JSON.stringify(repos)})`);

  // 2) per-project status lists tracked (modified) AND untracked changes
  const statuses = await win.evaluate(() => window.__gitStatuses());
  const apiFiles = (statuses[apiKey] || {}).files || [];
  const webFiles = (statuses[webKey] || {}).files || [];
  ok(apiFiles.some((f) => f.label === "Modified") && apiFiles.some((f) => f.label === "Untracked"),
    `api status has a modified + an untracked file (${apiFiles.map((f) => f.path + ":" + f.label).join(", ")})`);

  // 3) SELECTION is decoupled from staging: ticking a file must NOT stage it
  await win.evaluate((k) => window.__gitSelect(k, ["tracked.txt"], true), apiKey);
  const afterSel = await win.evaluate((k) => window.atomnano.git.status(k), apiKey);
  const tRow = afterSel.files.find((f) => f.path === "tracked.txt");
  ok(tRow && !tRow.staged, "ticking a file SELECTS it for commit but does NOT stage it in git");

  // tick everything across BOTH projects (incl. untracked)
  const totalSel = await win.evaluate(() => window.__gitSelectAll(true));
  ok(totalSel === apiFiles.length + webFiles.length, `Select-all ticks every changed file in both projects (${totalSel})`);

  // 4) COMMIT (no push): both projects commit the selection; untracked gets staged
  //    automatically; remotes stay untouched.
  await win.evaluate(() => window.__setGitMessage("round1 multi-commit"));
  await win.evaluate(() => window.__commitSelected(false));
  await win.waitForTimeout(350);
  ok(subject(api.repo) === "round1 multi-commit" && subject(web.repo) === "round1 multi-commit",
    "Commit committed BOTH projects with the shared message");
  ok(git(api.repo, ["ls-files"]).includes("new-r1.txt"), "the ticked UNTRACKED file was staged + committed");
  ok(/working tree clean/.test(git(api.repo, ["status"])), "api working tree is clean after the commit");
  ok(remoteSubject(api.remote) === "init" && remoteSubject(web.remote) === "init",
    "Commit (no push) left both remotes unchanged");
  const commitToast = findToast(await toastsSince(), /Committed/);
  ok(/Committed/.test(commitToast) && /2 projects/.test(commitToast), `commit shows a multi-project summary toast (${commitToast})`);

  // 5) PUSH ALL: both projects pushed; summary names each project + branch
  await win.evaluate(() => window.__pushAll());
  await win.waitForTimeout(400);
  ok(remoteSubject(api.remote) === "round1 multi-commit" && remoteSubject(web.remote) === "round1 multi-commit",
    "Push all pushed BOTH projects to their remotes");
  const pushToast = findToast(await toastsSince(), /Pushed/);
  ok(/Pushed 2 projects/.test(pushToast), `push-all summary names the project count (${pushToast})`);
  ok(/api/.test(pushToast) && /web/.test(pushToast) && /main/.test(pushToast), `push-all summary lists each project → branch (${pushToast})`);

  // 6) COMMIT & PUSH in a single action
  dirty(api.repo, "r2"); dirty(web.repo, "r2");
  await win.evaluate(() => window.__refreshGit());
  await win.waitForTimeout(250);
  await win.evaluate(() => window.__gitSelectAll(true));
  await win.evaluate(() => window.__setGitMessage("round2 commit-and-push"));
  await win.evaluate(() => window.__commitSelected(true));
  await win.waitForTimeout(500);
  ok(subject(api.repo) === "round2 commit-and-push" && remoteSubject(api.remote) === "round2 commit-and-push",
    "Commit & Push committed AND pushed api in one action");
  ok(subject(web.repo) === "round2 commit-and-push" && remoteSubject(web.remote) === "round2 commit-and-push",
    "Commit & Push committed AND pushed web in one action");
  const cpToast = findToast(await toastsSince(), /Committed & pushed/);
  ok(/Committed & pushed 2 projects/.test(cpToast), `commit & push shows a multi-project summary toast (${cpToast})`);

  // 7) PULL ALL: advance api's remote from an outside clone → the app pulls it in
  git(os.tmpdir(), ["clone", api.remote, CLONE]);
  git(CLONE, ["config", "user.email", "t@t.co"]); git(CLONE, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(CLONE, "remote-added.txt"), "from remote\n");
  git(CLONE, ["add", "-A"]); git(CLONE, ["commit", "-m", "remote-change"]); git(CLONE, ["push", "origin", "main"]);
  await win.evaluate(() => window.__refreshGit());
  await win.waitForTimeout(250);
  await win.evaluate(() => window.__pullAll());
  await win.waitForTimeout(500);
  ok(fs.existsSync(path.join(api.repo, "remote-added.txt")), "Pull all fetched + merged the remote change into api");
  ok(subject(api.repo) === "remote-change", "api HEAD now matches the pulled remote commit");
  const pullToast = findToast(await toastsSince(), /Pulled/);
  ok(/Pulled/.test(pullToast), `pull-all shows a summary toast (${pullToast})`);

  ok(errors.length === 0, "no page errors during the multi-project git flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME MULTI-PROJECT GIT TESTS FAILED" : "\nALL MULTI-PROJECT GIT TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
