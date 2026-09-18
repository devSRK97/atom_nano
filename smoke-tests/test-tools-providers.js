/* Tools & Updates + Providers/Auth:
 *  - toolVersions detects Claude CLI / Agent SDK / Codex / Gemini
 *  - provider auth status + per-provider API keys persist
 *  - the Settings → Providers tab renders tool rows + provider rows (Authorize)
 * (Renamed from test-tools-skills.js on 2026-09-18: the "auto skill creator" it also covered — the
 *  apprentice that turned recurring runs into skills — was removed with the Skills dock. Skills now
 *  live in the Workflow Studio; their CRUD/persistence is scripts/test-workflow-skills.js.)
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-toolsproviders");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-toolsproviders-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && typeof window.__openSettings === "function" && window.atomnano.updates.toolVersions, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* ---------- tool version detection (Claude CLI, Agent SDK, Codex CLI, Codex SDK — Gemini/agy tracking left with that integration) ---------- */
  const tv = await win.evaluate(() => window.atomnano.updates.toolVersions());
  ok(tv.claudeCli && tv.agentSdk && tv.codex && tv.codexSdk && !tv.gemini, `toolVersions reports the four tracked tools (${Object.keys(tv).join(", ")})`);
  ok(tv.agentSdk.present && /\d+\.\d+\.\d+/.test(tv.agentSdk.version || ""), `Agent SDK detected (${tv.agentSdk.version})`);
  ok(tv.codex.present && /\d+\.\d+\.\d+/.test(tv.codex.version || ""), `Codex CLI detected (${tv.codex.version})`);

  /* ---------- provider auth status + key persistence ---------- */
  const st = await win.evaluate(() => window.atomnano.providers.authStatus());
  ok(st.anthropic && st.openai && st.google && st.custom, "provider auth status covers all four providers");
  const set = await win.evaluate(() => window.atomnano.settings.set({ openaiApiKey: "sk-o", geminiApiKey: "g-key", customApiKey: "c-key" }));
  ok(set.openaiApiKey === "sk-o" && set.geminiApiKey === "g-key" && set.customApiKey === "c-key", "per-provider API keys persist");
  const st2 = await win.evaluate(() => window.atomnano.providers.authStatus());
  ok(st2.openai.key && st2.google.key && st2.custom.key, "auth status reflects the saved keys");

  /* ---------- the apprentice's test hooks are gone with it ---------- */
  const hooks = await win.evaluate(() => ({ record: typeof (window.atomnano.test || {}).skillsRecord, autocreate: typeof (window.atomnano.test || {}).skillsAutocreate }));
  ok(hooks.record === "undefined" && hooks.autocreate === "undefined", "no skillsRecord / skillsAutocreate test hooks on the bridge (auto skill creator removed)");

  /* ---------- Settings → Providers tab (merged; cards + seamless updater) ---------- */
  // openSettings() awaits auth.status() + app.info() before it renders the nav — poll until the category exists.
  win.evaluate(() => window.__openSettings()).catch(() => {});
  let catOpened = false;
  for (let i = 0; i < 50 && !catOpened; i++) { await win.waitForTimeout(300); catOpened = await win.evaluate(() => window.__settingsCat("Providers")); }
  ok(catOpened, "Settings opens on the Providers category");
  // toolVersions runs `--version` on the CLIs (slow) — poll until cards render
  let ui = { provCards: 0 };
  for (let i = 0; i < 30; i++) {
    ui = await win.evaluate(() => ({
      provCards: document.querySelectorAll(".prov-card").length,
      primaryBadges: document.querySelectorAll(".prov-card .pc-primary").length,
      primaryCard: (document.querySelector(".prov-card.primary .pc-name") || {}).textContent || "",
      toolRows: document.querySelectorAll(".tool-row").length,
      connectionGone: ![...document.querySelectorAll(".st-cat")].some((x) => /Connection/.test(x.textContent)),
      labels: [...document.querySelectorAll(".st-content label")].map((l) => l.textContent),
    }));
    if (ui.provCards >= 3 && ui.toolRows >= 2) break;
    await win.waitForTimeout(300);
  }
  ok(ui.connectionGone, "the separate Connection tab is gone (merged into Providers)");
  // PROV_DEFS: Anthropic, OpenAI, Custom — the Google card left with the Antigravity integration (authStatus still reports google).
  ok(ui.provCards === 3, `Providers shows a card per provider — Anthropic, OpenAI, Custom (${ui.provCards})`);
  ok(ui.primaryBadges === 1 && /Anthropic/.test(ui.primaryCard), `the primary provider is marked (${ui.primaryCard})`);
  ok(ui.labels.includes("Providers & Authentication") && ui.labels.some((l) => /Updates/.test(l)), "Providers + the seamless Updates box are both present");
  ok(ui.toolRows >= 2, `the tracked tools (Claude CLI, Agent SDK, Codex CLI, Codex SDK) are listed (${ui.toolRows})`);

  /* ---------- a provider card opens a manage modal with Authorize + API key ---------- */
  await win.evaluate(() => document.querySelector(".prov-card").click());
  await win.waitForTimeout(500);
  const modal = await win.evaluate(() => { const m = document.querySelector(".prov-modal"); return m ? { authBtn: [...m.querySelectorAll("button")].some((b) => /Authorize/.test(b.textContent)), keyInputs: m.querySelectorAll("input[type=password]").length } : null; });
  ok(modal && modal.authBtn, "the provider modal has an Authorize button");
  ok(modal && modal.keyInputs === 1, `the provider modal has an API-key field (${modal && modal.keyInputs})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME TOOLS/PROVIDERS TESTS FAILED" : "\nALL TOOLS/PROVIDERS TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
