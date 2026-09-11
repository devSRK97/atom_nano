/* Reply metadata + conversation filtering:
 *  - each reply shows the provider (name) + model + thinking level, and the
 *    reviewers when used — cleanly, in a meta row.
 *  - a top-right provider/model filter appears once a chat mixes ≥2 models and
 *    fades the replies that don't match the picked one.
 *  - chat search supports a case-sensitive (Aa) toggle like the editor's find.
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-replymeta");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-replymeta-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__injectReply === "function" && window.atomnano.providers, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(400);

  /* ---------- a Claude reply: provider name + model + thinking ---------- */
  await win.evaluate(() => window.__injectReply({ provider: "anthropic", model: "claude-opus-4-8", thinking: "think-hard", reviewers: [], reviewMode: "before" }, "HELLO from Claude"));
  let metas = await win.evaluate(() => window.__replyMetas());
  ok(metas.length === 1 && metas[0].label === "Claude", `reply is labelled with the provider name (${metas[0].label})`);
  ok(/Opus 4\.8/.test(metas[0].meta), `meta row shows the model (${metas[0].meta})`);
  ok(/Think hard/.test(metas[0].meta), "meta row shows the thinking level");

  /* ---------- a Gemini reply with a Claude reviewer ---------- */
  await win.evaluate(() => window.__injectReply({ provider: "google", model: "gemini-3.1-pro-preview", thinking: "off", reviewers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }], reviewMode: "after" }, "hello from gemini"));
  metas = await win.evaluate(() => window.__replyMetas());
  ok(metas[1].label === "Gemini", `second reply labelled Gemini (${metas[1].label})`);
  ok(/Gemini 3\.1 Pro/.test(metas[1].meta), `meta shows the Gemini model (${metas[1].meta})`);
  ok(/reviewed by Claude/.test(metas[1].meta), `reviewers are shown on the reply (${metas[1].meta})`);
  ok(!/Think|Effort/.test(metas[1].meta), "thinking 'off' is omitted (clean)");

  /* ---------- model filter appears once ≥2 models are present ---------- */
  let mf = await win.evaluate(() => window.__modelFilter());
  ok(mf && mf.chips.length === 3, `filter shows All + one chip per model (${mf && mf.chips.length})`);
  ok(mf.chips.some((c) => c.text === "All" && c.active), "the All chip is active by default");
  ok(mf.chips.some((c) => /Opus 4\.8/.test(c.text)) && mf.chips.some((c) => /Gemini 3\.1 Pro/.test(c.text)), "a chip per distinct model");

  /* ---------- picking a model fades the non-matching replies ---------- */
  metas = await win.evaluate(() => window.__clickFilterChip("Opus 4.8"));
  ok(metas[0].filtered === false && metas[1].filtered === true, "filtering to Opus fades the Gemini reply, keeps the Claude one");
  metas = await win.evaluate(() => window.__clickFilterChip("All"));
  ok(metas.every((m) => m.filtered === false), "All clears the filter");

  /* ---------- case-sensitive search ---------- */
  const insensitive = await win.evaluate(() => window.__chatFindCase(false, "HELLO"));
  ok(insensitive === 2, `case-insensitive 'HELLO' matches both replies (${insensitive})`);
  const sensitive = await win.evaluate(() => window.__chatFindCase(true, "HELLO"));
  ok(sensitive === 1, `match-case 'HELLO' matches only the capitalised one (${sensitive})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME REPLY-META TESTS FAILED" : "\nALL REPLY-META TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
