/* Git branches + merge: switch branches, create a branch, fast-forward merge,
 * and a conflicting merge that is then aborted — all driven through the app
 * against a real repo, asserting real git state + the result toasts. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
function git(cwd, args) { try { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString(); } catch (e) { return (e.stdout || "") + (e.stderr || ""); } }
const cur = (repo) => git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
const merging = (repo) => /MERGE_HEAD/.test(git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])) || fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"));

(async () => {
  const REPO = path.join(os.tmpdir(), "atomnano-merge");
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, ["init", "-b", "main"]); git(REPO, ["config", "user.email", "t@t.co"]); git(REPO, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(REPO, "shared.txt"), "base\n");
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "base"]);
  // feature branch ahead of main by one commit (a clean fast-forward target)
  git(REPO, ["checkout", "-b", "feature"]);
  fs.writeFileSync(path.join(REPO, "feature.txt"), "feature work\n");
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "feature commit"]);
  git(REPO, ["checkout", "main"]);

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && typeof window.__gitMerge === "function", null, { timeout: 15000 });
  await win.evaluate(() => window.__setFsSync && window.__setFsSync(false));

  await win.evaluate((p) => window.__setProject(p), REPO.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const repo = (await win.evaluate(() => window.__gitRepos()))[0];
  ok(!!repo, `project repo discovered (${repo})`);

  // 1) list branches via the bridge
  const info = await win.evaluate((r) => window.atomnano.git.branches(r), repo);
  ok(info.current === "main" && info.locals.includes("feature"), `branches listed (current=${info.current}, locals=${info.locals.join(",")})`);

  // 2) switch branch
  await win.evaluate((r) => window.__gitCheckout(r, "feature"), repo);
  await win.waitForTimeout(250);
  ok(cur(REPO) === "feature", `switched to feature (HEAD=${cur(REPO)})`);
  ok(/Switched/.test(await win.evaluate(() => window.__lastToast())), "switch shows a confirmation toast");
  await win.evaluate((r) => window.__gitCheckout(r, "main"), repo);
  await win.waitForTimeout(250);
  ok(cur(REPO) === "main", "switched back to main");

  // 3) create a new branch
  await win.evaluate((r) => window.__gitCheckoutNew(r, "scratch"), repo);
  await win.waitForTimeout(250);
  ok(cur(REPO) === "scratch", `created + switched to new branch (HEAD=${cur(REPO)})`);
  await win.evaluate((r) => window.__gitCheckout(r, "main"), repo);
  await win.waitForTimeout(250);

  // 4) fast-forward merge: main is behind feature → merge brings feature.txt in
  await win.evaluate((r) => window.__gitMerge(r, "feature"), repo);
  await win.waitForTimeout(350);
  ok(fs.existsSync(path.join(REPO, "feature.txt")), "fast-forward merge brought feature.txt into main");
  ok(/Merged feature/.test(await win.evaluate(() => window.__lastToast())), `merge shows a success toast (${await win.evaluate(() => window.__lastToast())})`);

  // 5) conflicting merge → reported, NOT thrown; then aborted cleanly
  git(REPO, ["checkout", "-b", "conflict"]);
  fs.writeFileSync(path.join(REPO, "shared.txt"), "from the conflict branch\n");
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "conflict side"]);
  git(REPO, ["checkout", "main"]);
  fs.writeFileSync(path.join(REPO, "shared.txt"), "from main\n");
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "main side"]);

  await win.evaluate((r) => window.__gitMerge(r, "conflict"), repo);
  await win.waitForTimeout(400);
  ok(merging(REPO), "conflicting merge leaves the repo in a merging state (MERGE_HEAD)");
  ok(/UU\s+shared\.txt/.test(git(REPO, ["status", "--porcelain"])), "shared.txt is marked conflicted (UU)");
  ok(/conflict/i.test(await win.evaluate(() => window.__lastToast())), "a merge-conflict notice is shown");

  await win.evaluate((r) => window.__gitMergeAbort(r), repo);
  await win.waitForTimeout(300);
  ok(!merging(REPO), "Abort merge cleared the merging state");
  ok(/from main/.test(fs.readFileSync(path.join(REPO, "shared.txt"), "utf8")), "abort restored main's version of the file");

  ok(errors.length === 0, "no page errors during the branches/merge flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME MERGE TESTS FAILED" : "\nALL MERGE TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
