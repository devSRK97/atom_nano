/* Drives the reusable sample HTML-project fixture end-to-end in AtomNano:
 * discover the repo, view a diff, do a CLEAN merge (feature/dark-mode), then a
 * CONFLICTING merge (feature/headline) and abort it. This doubles as the template
 * future git smokes should follow — call buildHtmlFixture() for a realistic repo
 * instead of hand-rolling one. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { buildHtmlFixture } = require("./fixtures/html-project");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const merging = (repo) => fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"));

(async () => {
  const DIR = path.join(os.tmpdir(), "atomnano-htmlfix");
  const fx = buildHtmlFixture(DIR, { remote: true, dirty: true });   // realistic repo with a clean working diff

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && typeof window.__gitMerge === "function", null, { timeout: 15000 });
  await win.evaluate(() => window.__setFsSync && window.__setFsSync(false));

  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(350);
  const repo = (await win.evaluate(() => window.__gitRepos()))[0];
  ok(!!repo, `fixture repo discovered (${repo})`);

  // status: the fixture leaves about.html modified + NOTES.md untracked
  const st = await win.evaluate((r) => window.atomnano.git.status(r), repo);
  ok(st.files.some((f) => f.path === "about.html" && f.unstaged) && st.files.some((f) => f.path === "NOTES.md" && f.label === "Untracked"),
    `working tree shows the seeded changes (${st.files.map((f) => f.path + ":" + f.label).join(", ")})`);

  // branches present
  const info = await win.evaluate((r) => window.atomnano.git.branches(r), repo);
  ok(info.current === "main" && info.locals.includes("feature/dark-mode") && info.locals.includes("feature/headline"),
    `branch topology present (${info.locals.join(", ")})`);

  // 1) view the diff of a changed file
  await win.evaluate((r) => window.__openDiff(r, "about.html"), repo);
  await win.waitForTimeout(300);
  let d = await win.evaluate(() => window.__diffInfo());
  ok(d && d.open && d.name === "about.html" && d.adds >= 1 && d.dels >= 1, `diff opens with ± stats (adds=${d && d.adds}, dels=${d && d.dels})`);
  await win.evaluate(() => window.__closeDiff());

  // 2) CLEAN merge: feature/dark-mode brings the theme toggle in with no conflict
  await win.evaluate((r) => window.__gitMerge(r, "feature/dark-mode"), repo);
  await win.waitForTimeout(400);
  ok(!merging(DIR), "clean merge completed (no merge conflict state)");
  ok(/data-theme/.test(read(path.join(DIR, "styles.css"))), "feature/dark-mode CSS landed on main");
  ok(/Merged feature\/dark-mode/.test(await win.evaluate(() => window.__lastToast())), `clean merge shows a success toast (${await win.evaluate(() => window.__lastToast())})`);

  // 3) CONFLICTING merge: feature/headline collides on the hero line
  await win.evaluate((r) => window.__gitMerge(r, "feature/headline"), repo);
  await win.waitForTimeout(450);
  ok(merging(DIR), "conflicting merge left the repo merging (MERGE_HEAD)");
  ok(/UU\s+index\.html/.test((await win.evaluate((r) => window.atomnano.git.status(r), repo)).files.map((f) => f.x + f.y + " " + f.path).join("\n")) ||
     /<<<<<<</.test(read(path.join(DIR, "index.html"))), "hero conflict is present in index.html");
  ok(/conflict/i.test(await win.evaluate(() => window.__lastToast())), "merge-conflict notice shown");

  // 4) abort restores main
  await win.evaluate((r) => window.__gitMergeAbort(r), repo);
  await win.waitForTimeout(300);
  ok(!merging(DIR), "Abort merge cleared the conflict");
  ok(/Build faster than your competition/.test(read(path.join(DIR, "index.html"))), "abort restored main's hero headline");

  ok(errors.length === 0, "no page errors driving the HTML fixture" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME HTML-FIXTURE TESTS FAILED" : "\nALL HTML-FIXTURE TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
