"use strict";
/* End-to-end probe: drive a real `agy` reviewer call through council.js and
 * confirm the --log-file + transcript.jsonl workaround actually surfaces text
 * even when agy's stdout is empty.
 *
 *   node smoke-tests/test-agy-reviewer.js
 *
 * Requires: agy installed and authenticated. Times out at 90s.
 */
const council = require("../src/main/council");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  /* --- 1. detect ----------------------------------------------------------- */
  const have = council.present();
  console.log("present():", JSON.stringify(have));
  ok(have.agy === true, "agy is detected on this machine");
  if (!have.agy) { console.error("ABORT: install agy first"); process.exit(2); }

  const agyPath = council.resolveAgy();
  console.log("resolveAgy():", agyPath);
  ok(!!agyPath && fs.existsSync(agyPath), "agy binary path exists");

  /* --- 2. small reviewer call --------------------------------------------- */
  console.log("calling council.reviewerRun(\"google\", null, ...) — this can take up to 60s");
  const t0 = Date.now();
  const r = await council.reviewerRun("google", null, "Reply with exactly the three words: agy works fine. No punctuation, no quotes, nothing else.");
  const dt = Date.now() - t0;
  console.log(`returned in ${dt}ms · ok=${r.ok} · text.length=${(r.text || "").length} · error=${(r.error || "").slice(0, 200)}`);
  if (r.text) console.log("--- agy text (first 400 chars) ---\n" + r.text.slice(0, 400) + (r.text.length > 400 ? "…" : ""));

  ok(r && typeof r === "object", "reviewerRun returned an object");
  ok(r.ok === true, "reviewerRun reports ok=true (covered by stdout OR transcript recovery)");
  ok(typeof r.text === "string" && r.text.trim().length > 0, "reviewerRun returned non-empty text");

  /* --- 3. transcript-recovery path ----------------------------------------
   * Verify the .system_generated transcript path the recovery code expects
   * actually contains conversations agy wrote on this machine. */
  const brain = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
  let convCount = 0;
  try { convCount = fs.readdirSync(brain).filter((n) => /^[0-9a-f-]{36}$/.test(n)).length; } catch { /* not initialised yet */ }
  ok(convCount >= 1, `at least one conversation folder under brain/ (found ${convCount})`);
  if (convCount) {
    const ents = fs.readdirSync(brain).filter((n) => /^[0-9a-f-]{36}$/.test(n));
    const latest = ents.map((n) => ({ n, t: (fs.statSync(path.join(brain, n)).mtimeMs || 0) })).sort((a, b) => b.t - a.t)[0];
    const tFile = path.join(brain, latest.n, ".system_generated", "logs", "transcript.jsonl");
    const exists = fs.existsSync(tFile);
    console.log("latest transcript.jsonl:", tFile, "exists=", exists, "size=", exists ? fs.statSync(tFile).size : "-");
    ok(exists, "the documented transcript.jsonl path is the one agy actually writes");
  }

  console.log(process.exitCode ? "\nSOME AGY-REVIEWER TESTS FAILED" : "\nALL AGY-REVIEWER TESTS PASSED");
})().catch((e) => { console.error("THREW:", e); process.exit(3); });
