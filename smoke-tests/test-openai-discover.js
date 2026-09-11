/* OpenAI/Codex as a primary (the gpt-5.5 "model doesn't exist" fix) + dynamic,
 * non-hardcoded model discovery. Uses injected fakes (no live CLI/API).
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-oaidisc");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-oaidisc-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => window.atomnano.test && window.atomnano.test.openaiRun && window.atomnano.test.discoverFake, null, { timeout: 15000 });

  /* ---------- OpenAI primary runs via Codex (no Anthropic gpt-5.5 error) ---------- */
  const r = await win.evaluate((cwd) => window.atomnano.test.openaiRun(cwd, "extend to 120 words"), DIR.replace(/\\/g, "/"));
  ok(r.lastRun && r.lastRun.provider === "openai" && r.lastRun.model === "gpt-5.5", `run routed to the OpenAI/Codex backend (${r.lastRun && r.lastRun.provider})`);
  ok(r.lastRun.effort === "high", `reasoning effort threaded to codex (${r.lastRun.effort})`);
  const asst = r.msgs.find((m) => m.role === "assistant");
  ok(asst && /extended/.test(asst.text) && asst.provider === "openai", `got an OpenAI answer labelled openai (${asst && asst.provider})`);
  ok(!r.msgs.some((m) => m.role === "error" && /gpt-5\.5.*exist|not have access/i.test(m.text)), "no 'model gpt-5.5 doesn't exist' error");

  /* ---------- dynamic discovery: live list leads, catalog only fills gaps ---------- */
  const oa = await win.evaluate(() => window.atomnano.test.discoverFake("openai"));
  const ids = oa.models.map((m) => m.id);
  ok(ids.includes("gpt-6-turbo"), `a newly-released model discovered from the live API (${ids.slice(0, 3).join(", ")})`);
  ok(ids.indexOf("gpt-6-turbo") < ids.indexOf("gpt-5.5"), "discovered models lead the catalog (dynamic, not hardcoded)");
  ok(oa.models.find((m) => m.id === "gpt-6-turbo").desc === "Discovered", "discovered models are tagged Discovered");

  const gg = await win.evaluate(() => window.atomnano.test.discoverFake("google"));
  ok(gg.models.some((m) => m.id === "gemini-4.0-pro" && m.ctx1m), "Google discovery surfaces a live Gemini model with its 1M flag");

  // when the fetcher returns nothing for a provider, it falls back to the catalog
  const an = await win.evaluate(() => window.atomnano.test.discoverFake("anthropic"));
  ok(an.models.some((m) => m.id === "claude-opus-4-8"), "falls back to the built-in catalog when live discovery is empty");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME OPENAI/DISCOVER TESTS FAILED" : "\nALL OPENAI/DISCOVER TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
