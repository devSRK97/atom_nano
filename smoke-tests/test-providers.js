/* LLM provider dropdown:
 *  - a provider dropdown sits BEFORE the model dropdown in the composer
 *  - the llmProvider setting persists (default anthropic)
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const udir = path.join(os.tmpdir(), "atomnano-providers-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => document.querySelector("#headerProvider .dd .dd-val") && document.querySelector(".composer-toolbar .dd .dd-val") && window.atomnano, null, { timeout: 15000 });

  /* ---------- default provider ---------- */
  const def = await win.evaluate(() => window.atomnano.settings.get());
  ok(def.llmProvider === "anthropic", `default provider is Anthropic (${def.llmProvider})`);

  /* ---------- provider dropdown lives in the tab bar, before the Skills icon ---------- */
  const hdr = await win.evaluate(() => document.querySelector("#headerProvider .dd .dd-val").textContent.trim());
  ok(/Anthropic|OpenAI|Google|Custom/.test(hdr), `provider dropdown is in the chat header (${hdr})`);
  const beforeSkills = await win.evaluate(() => { const a = document.getElementById("headerProvider"); const b = document.getElementById("skillsBtn"); return !!(a && b) && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); });
  ok(beforeSkills, "provider dropdown sits before the Skills icon");

  /* ---------- composer toolbar now starts with the model dropdown ---------- */
  const vals = await win.evaluate(() => [...document.querySelectorAll(".composer-toolbar .dd .dd-val")].map((v) => v.textContent.trim()));
  ok(/Opus|Sonnet|Haiku|Fable/.test(vals[0] || ""), `model dropdown is first in the composer toolbar (${vals[0]})`);

  /* ---------- llmProvider persists ---------- */
  const set = await win.evaluate(() => window.atomnano.settings.set({ llmProvider: "openai", customApiBaseUrl: "https://example.test/v1" }));
  ok(set.llmProvider === "openai" && set.customApiBaseUrl === "https://example.test/v1", "provider + custom base URL persist");
  const got = await win.evaluate(() => window.atomnano.settings.get());
  ok(got.llmProvider === "openai", "llmProvider setting survives a re-read");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME PROVIDER TESTS FAILED" : "\nALL PROVIDER TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
