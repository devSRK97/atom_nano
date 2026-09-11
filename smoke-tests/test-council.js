/* Model council (reviewers):
 *  - consult-before: reviewers advise; their input is collected + injected
 *  - review-after: the answer is handed to reviewers for critique
 *  - composer "Reviewers" control: pick provider+model combos, before/after mode
 * Uses a deterministic fake reviewer runner (no live CLIs).
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-council");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-council-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && window.atomnano.test && window.atomnano.test.councilConsult, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const CWD = DIR.replace(/\\/g, "/");
  await win.evaluate(() => window.atomnano.test.councilRunner());   // deterministic fake reviewers

  /* ---------- consult-before (incl. Claude as a reviewer) ---------- */
  const consult = await win.evaluate((cwd) => window.atomnano.test.councilConsult(cwd, [{ provider: "google", model: "g3" }, { provider: "openai", model: "gpt-5.5" }, { provider: "anthropic", model: "claude-haiku-4-5-20251001" }], "draft an email to the team"), CWD);
  ok(consult.messages.length === 3, `all reviewers consulted incl. Claude (${consult.messages.length})`);
  ok(consult.messages.every((m) => m.kind === "consult" && /ADVICE/.test(m.text)), "each produced advice (before answering)");
  ok(consult.messages.every((m) => m.asked && /DevOps is a culture/.test(m.asked) && /draft an email to the team/.test(m.asked)), "reviewer is sent the conversation context + the question (not just the bare prompt)");
  ok(/advise/i.test(consult.digest) && /google/i.test(consult.digest) && /openai/i.test(consult.digest) && /claude|anthropic/i.test(consult.digest), "reviewer advice (incl. Claude) collected into an injectable digest");

  /* ---------- review-after ---------- */
  const review = await win.evaluate((cwd) => window.atomnano.test.councilReview(cwd, [{ provider: "google", model: "g3" }], "draft an email", "Dear team, here is the update."), CWD);
  ok(review.messages.length === 1 && review.messages[0].kind === "review" && /REVIEW/.test(review.messages[0].text), "review-after hands the answer to reviewers for critique");

  /* ---------- composer Reviewers control ---------- */
  ok(await win.evaluate(() => !!document.getElementById("reviewersBtn")), "Reviewers control in the composer toolbar");
  await win.evaluate(() => document.getElementById("reviewersBtn").click());
  await win.waitForTimeout(150);
  const pop = await win.evaluate(() => { const p = document.querySelector(".rv-pop"); return p ? { modes: p.querySelectorAll(".rv-mode-b").length, rows: p.querySelectorAll(".rv-row").length } : null; });
  ok(pop && pop.modes === 2 && pop.rows === 3, `popover has before/after modes + a row per provider incl. Claude (${pop && pop.rows})`);

  // The Claude reviewer row must NOT offer the current primary model (default
  // primary is Opus 4.8) — a model reviewing itself is pointless.
  const claudeOpts = await win.evaluate(() => { const row = [...document.querySelectorAll(".rv-pop .rv-row")].find((r) => /Claude/.test(r.querySelector(".rv-prov").textContent)); return [...row.querySelector("select.rv-model").options].map((o) => o.value); });
  ok(claudeOpts.includes("claude-sonnet-4-6") && !claudeOpts.includes("claude-opus-4-8"), `Claude reviewer excludes the primary model (${claudeOpts.filter(Boolean).length} options)`);

  // Select a Gemini reviewer model on the Google row.
  await win.evaluate(() => { const row = [...document.querySelectorAll(".rv-pop .rv-row")].find((r) => /Gemini/.test(r.querySelector(".rv-prov").textContent)); const m = row.querySelector("select.rv-model"); m.value = "gemini-3.1-pro-preview"; m.dispatchEvent(new Event("change")); const cb = row.querySelector("input[type=checkbox]"); cb.checked = true; cb.dispatchEvent(new Event("change")); });
  await win.waitForTimeout(250);
  const setg = await win.evaluate(() => window.atomnano.settings.get());
  ok((setg.reviewers || []).length === 1 && setg.reviewers[0].provider === "google" && setg.reviewers[0].model === "gemini-3.1-pro-preview", `selecting a reviewer + model persists (${JSON.stringify(setg.reviewers)})`);
  ok(/Reviewers · 1/.test(await win.evaluate(() => document.getElementById("reviewersBtn").textContent)), "button shows the reviewer count");

  await win.evaluate(() => { const b = [...document.querySelectorAll(".rv-pop .rv-mode-b")].find((x) => /Review after/.test(x.textContent)); b.click(); });
  await win.waitForTimeout(150);
  ok((await win.evaluate(() => window.atomnano.settings.get())).reviewMode === "after", "before/after mode toggle persists");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME COUNCIL TESTS FAILED" : "\nALL COUNCIL TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
