/* Merge-conflict resolver: trigger a real conflict (feature/headline on the HTML
 * fixture), then resolve it through the guided UI — keep incoming, keep current
 * (via bulk), mark the file resolved, and complete the merge — asserting the real
 * committed result each time. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { buildHtmlFixture } = require("./fixtures/html-project");
const { tmpRoot, isolatedEnv } = require("./_env");
const ROOT = path.join(__dirname, "..");
const RUN = tmpRoot("conflict");            // unique per run; isolated app profile + git config
const ENV = isolatedEnv(RUN);
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function git(cwd, a) { try { return execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString(); } catch (e) { return (e.stdout || "") + (e.stderr || ""); } }
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const merging = (d) => fs.existsSync(path.join(d, ".git", "MERGE_HEAD"));

async function launch() {
  const app = await electron.launch({ args: [ROOT], env: ENV });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && typeof window.__openConflictResolver === "function", null, { timeout: 15000 });
  await win.evaluate(() => window.__setFsSync && window.__setFsSync(false));
  return { app, win, errors };
}

(async () => {
  // ===== Round 1: resolve by KEEPING INCOMING =====
  const D1 = path.join(RUN, "project-1");
  buildHtmlFixture(D1, {});
  let { app, win, errors } = await launch();
  await win.evaluate((p) => window.__setProject(p), D1.replace(/\\/g, "/"));
  await sleep(300);
  const repo = (await win.evaluate(() => window.__gitRepos()))[0];

  await win.evaluate((r) => window.__gitMerge(r, "feature/headline"), repo);
  await sleep(450);
  ok(merging(D1), "merge produced a conflict (MERGE_HEAD present)");
  ok(await win.evaluate(() => !!document.querySelector(".gv-merge-banner")), "a merge-in-progress banner is shown in the Changes view");

  await win.evaluate((r) => window.__openConflictResolver(r), repo);
  await sleep(300);
  let mi = await win.evaluate(() => window.__mergeInfo());
  ok(mi && mi.open && mi.file === "index.html", `resolver opened on the conflicted file (${mi && mi.file})`);
  ok(mi.total === 1 && mi.resolved === 0 && mi.cards === 1, `one unresolved conflict card (total=${mi.total}, cards=${mi.cards})`);

  await win.evaluate(() => window.__resolveConflict(0, "theirs"));
  await sleep(150);
  mi = await win.evaluate(() => window.__mergeInfo());
  ok(mi.resolved === 1 && mi.resolvedCards === 1, "choosing Keep-incoming marks the conflict resolved (card collapses)");

  await win.evaluate(() => window.__markFileResolved());
  await sleep(350);
  mi = await win.evaluate(() => window.__mergeInfo());
  ok(mi && mi.files === 0 && mi.allset, "all files resolved → 'all set' state");

  await win.evaluate(() => window.__completeMerge());
  await sleep(400);
  ok(!merging(D1), "Complete merge created the merge commit (no longer merging)");
  ok(/Launch in record time/.test(read(path.join(D1, "index.html"))), "kept INCOMING: hero now reads feature/headline's text");
  ok(/Merge branch/.test(git(D1, ["log", "-1", "--pretty=%s"])), `merge commit recorded (${git(D1, ["log", "-1", "--pretty=%s"]).trim()})`);
  ok(/completed/i.test(await win.evaluate(() => window.__lastToast())), "completion toast shown");
  ok(errors.length === 0, "round 1: no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();

  // ===== Round 2: resolve by KEEPING CURRENT (via bulk "take all current") =====
  const D2 = path.join(RUN, "project-2");
  buildHtmlFixture(D2, {});
  ({ app, win, errors } = await launch());
  await win.evaluate((p) => window.__setProject(p), D2.replace(/\\/g, "/"));
  await sleep(300);
  const repo2 = (await win.evaluate(() => window.__gitRepos()))[0];
  await win.evaluate((r) => window.__gitMerge(r, "feature/headline"), repo2);
  await sleep(450);
  await win.evaluate((r) => window.__openConflictResolver(r), repo2);
  await sleep(300);
  await win.evaluate(() => window.__bulkResolve("ours"));
  await sleep(150);
  mi = await win.evaluate(() => window.__mergeInfo());
  ok(mi.resolved === mi.total && mi.total > 0, "bulk 'take all current' resolves every conflict");
  await win.evaluate(() => window.__markFileResolved());
  await sleep(300);
  await win.evaluate(() => window.__completeMerge());
  await sleep(400);
  ok(!merging(D2), "round 2: merge completed");
  ok(/Build faster than your competition/.test(read(path.join(D2, "index.html"))), "kept CURRENT: hero retains main's text");
  ok(errors.length === 0, "round 2: no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();

  console.log(process.exitCode ? "\nSOME CONFLICT-RESOLVER TESTS FAILED" : "\nALL CONFLICT-RESOLVER TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
