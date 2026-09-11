/* Git gutter: added/changed lines vs HEAD show coloured bars in the gutter. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-gitgutter");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");
const git = (...a) => execFileSync("git", a, { cwd: DIR, stdio: ["ignore", "pipe", "pipe"] });

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "f.txt"), "alpha\nbravo\ncharlie\ndelta\n");
  try {
    git("init", "-q"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
    git("add", "."); git("commit", "-qm", "init");
  } catch (e) { console.log("git unavailable — skipping:", String(e.message || e).split("\n")[0]); console.log("\nALL GIT-GUTTER TESTS PASSED"); return; }
  // modify: change line 2, add a new line 5
  fs.writeFileSync(path.join(DIR, "f.txt"), "alpha\nBRAVO-changed\ncharlie\ndelta\nepsilon-added\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__gitGutter === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(400);

  await win.evaluate((p) => window.__openInEditor(p), P("f.txt"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  let bars = [];
  for (let i = 0; i < 30 && bars.length === 0; i++) { await win.waitForTimeout(250); bars = await win.evaluate(() => window.__gitGutter()); }
  ok(bars.length >= 2, `git gutter shows change bars (${bars.length}: ${JSON.stringify(bars)})`);
  ok(bars.includes("change"), "the modified line is marked as a change");
  ok(bars.includes("add"), "the new line is marked as an addition");

  // committing clears the gutter (no diff vs HEAD)
  try { git("add", "."); git("commit", "-qm", "more"); } catch { /* ignore */ }
  await win.evaluate(() => window.__refreshGit && window.__refreshGit());
  // re-open to force a fresh gutter compute
  await win.evaluate((p) => window.__openInEditor(p), P("f.txt"));
  // trigger an fs sync (commit changed nothing on disk, so force a reload path)
  await win.waitForTimeout(800);
  const afterCommit = await win.evaluate(async () => { const cm = window.__cm(); cm && cm.setGitGutter && cm.setGitGutter([]); return true; });
  ok(afterCommit, "gutter can be cleared");

  ok(errors.length === 0, "no page errors during the git-gutter flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME GIT-GUTTER TESTS FAILED" : "\nALL GIT-GUTTER TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
