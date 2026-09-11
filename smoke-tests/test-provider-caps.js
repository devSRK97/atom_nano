/* Provider-aware capability discovery:
 *  - switching the PRIMARY provider rebuilds the model list, swaps thinking-levels
 *    vs reasoning-effort, and shows/hides the 1M-context toggle by capability.
 *  - the selected model + reasoning level stay valid across provider switches.
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-provcaps");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-provcaps-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__providerState === "function" && window.atomnano.providers && window.atomnano.providers.catalog, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(400);

  /* ---------- catalog ---------- */
  const cat = await win.evaluate(() => window.atomnano.providers.catalog());
  ok(cat && cat.anthropic && cat.google && cat.openai, "catalog exposes anthropic + google + openai");
  ok(cat.google.models.some((m) => m.id === "gemini-3.1-pro-preview" && m.ctx1m), "Gemini 3.1 Pro is catalogued with a 1M-context flag");
  ok(cat.openai.reasoning === "effort" && cat.anthropic.reasoning === "thinking", "reasoning kind differs by provider (effort vs thinking)");

  /* ---------- default: Anthropic ---------- */
  let s = await win.evaluate(() => window.__providerState());
  ok(s.provider === "anthropic" && s.models.includes("claude-opus-4-8"), "starts on Anthropic with Claude models");
  ok(s.reasoning === "thinking" && s.thinking.includes("ultrathink"), "Anthropic shows thinking levels (off…ultrathink)");
  ok(s.oneMVisible === true, "1M toggle visible for Opus 4.8 (supports 1M)");

  /* ---------- switch → Google (Gemini) ---------- */
  s = await win.evaluate(() => window.__switchProvider("google"));
  ok(s.provider === "google" && s.models.includes("gemini-3.1-pro-preview"), "switching to Google lists Gemini models");
  ok(!s.models.some((m) => /claude/.test(m)), "Gemini model list has no Claude models");
  ok(s.defaultModel === "gemini-3.1-pro-preview", `primary model auto-moved to a Gemini model (${s.defaultModel})`);
  ok(s.reasoning === "thinking" && s.oneMVisible === true, "Gemini keeps thinking levels + 1M toggle (Gemini supports 1M)");

  /* ---------- switch → OpenAI (effort + no 1M) ---------- */
  s = await win.evaluate(() => window.__switchProvider("openai"));
  ok(s.provider === "openai" && s.models.includes("gpt-5.5"), "switching to OpenAI lists GPT/Codex models");
  ok(s.reasoning === "effort" && s.thinking.includes("xhigh") && s.thinking.includes("medium"), "OpenAI swaps to reasoning-effort levels (…x-high)");
  ok(s.defaultThinking && ["minimal", "low", "medium", "high", "xhigh"].includes(s.defaultThinking), `reasoning level moved to a valid effort value (${s.defaultThinking})`);
  ok(s.oneMVisible === false, "1M toggle hidden for GPT-5.5 (no 1M-context)");

  /* ---------- back → Anthropic, pick Haiku (no 1M) ---------- */
  s = await win.evaluate(() => window.__switchProvider("anthropic"));
  ok(s.provider === "anthropic" && s.defaultModel.startsWith("claude"), `back on Anthropic with a Claude model (${s.defaultModel})`);
  ok(s.reasoning === "thinking", "reasoning back to thinking levels");
  s = await win.evaluate(() => window.__setModel("claude-haiku-4-5-20251001"));
  ok(s.oneMVisible === false, "1M toggle hidden for Haiku 4.5 (no 1M-context)");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME PROVIDER-CAPS TESTS FAILED" : "\nALL PROVIDER-CAPS TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
