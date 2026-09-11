/* Git diff viewer: clicking a changed file opens a polished overlay with ± stats,
 * split / unified views, word-level (intra-line) highlights, and prev/next file
 * navigation. Driven against a real repo. */
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
  const REPO = path.join(os.tmpdir(), "atomnano-diff");
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, ["init", "-b", "main"]); git(REPO, ["config", "user.email", "t@t.co"]); git(REPO, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(REPO, "code.txt"), "alpha\nbeta\ngamma\n");
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "base"]);
  // working-tree changes: one line modified (→ word-level highlight) + one added line
  fs.writeFileSync(path.join(REPO, "code.txt"), "alpha\nbeta CHANGED here\ngamma\ndelta\n");
  fs.writeFileSync(path.join(REPO, "fresh.txt"), "brand new\nsecond line\n");   // untracked → all-add

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && typeof window.__openDiff === "function", null, { timeout: 15000 });
  await win.evaluate(() => window.__setFsSync && window.__setFsSync(false));

  await win.evaluate((p) => window.__setProject(p), REPO.replace(/\\/g, "/"));
  await win.waitForTimeout(350);
  const repo = (await win.evaluate(() => window.__gitRepos()))[0];
  ok(!!repo, `project repo discovered (${repo})`);

  // 1) open the diff for the modified file (force split explicitly — the view is
  // a persisted user preference, so we don't rely on its default here)
  await win.evaluate((r) => window.__openDiff(r, "code.txt"), repo);
  await win.waitForTimeout(300);
  await win.evaluate(() => window.__diffView("split"));
  await win.waitForTimeout(120);
  let d = await win.evaluate(() => window.__diffInfo());
  ok(d && d.open, "diff overlay opened");
  ok(d.name === "code.txt", `diff header shows the file name (${d.name})`);
  ok(d.adds === 2 && d.dels === 1, `± stats are correct (adds=${d.adds}, dels=${d.dels})`);
  ok(/\+2/.test(d.stat) && /1/.test(d.stat), `header shows +2 / −1 (${d.stat})`);
  ok(d.view === "split" && d.splitRows > 0, `split (side-by-side) view renders rows (${d.splitRows})`);
  ok(d.addEls > 0 && d.delEls > 0, `added + deleted cells are present (add=${d.addEls}, del=${d.delEls})`);
  ok(d.words > 0, `word-level (intra-line) highlights are rendered (${d.words} spans)`);
  ok(d.hunks >= 1, `hunk header(s) rendered (${d.hunks})`);

  // 2) toggle to unified view
  await win.evaluate(() => window.__diffView("unified"));
  await win.waitForTimeout(150);
  d = await win.evaluate(() => window.__diffInfo());
  ok(d.view === "unified" && d.unifiedRows > 0, `unified view renders rows (${d.unifiedRows})`);

  // 3) navigate to the untracked file → all additions
  await win.evaluate((r) => window.__openDiff(r, "fresh.txt"), repo);
  await win.waitForTimeout(300);
  d = await win.evaluate(() => window.__diffInfo());
  ok(d.name === "fresh.txt" && d.adds === 2 && d.dels === 0, `untracked file shows as all-added (adds=${d.adds}, dels=${d.dels})`);

  // 4) close
  await win.evaluate(() => window.__closeDiff());
  ok((await win.evaluate(() => window.__diffInfo())) === null, "diff overlay closes");

  ok(errors.length === 0, "no page errors during the diff flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME DIFF TESTS FAILED" : "\nALL DIFF TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
