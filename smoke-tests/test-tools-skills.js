/* Tools & Updates + Providers/Auth + auto skill creator:
 *  - toolVersions detects Claude CLI / Agent SDK / Codex / Gemini
 *  - provider auth status + per-provider API keys persist
 *  - auto skill creator turns a workflow recurring >=4x into an ACTIVE skill
 *  - the Settings → Providers tab renders tool rows + provider rows (Authorize)
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-toolskills");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-toolskills-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && typeof window.__openSettings === "function" && window.atomnano.updates.toolVersions, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const CWD = DIR.replace(/\\/g, "/");

  /* ---------- tool version detection ---------- */
  const tv = await win.evaluate(() => window.atomnano.updates.toolVersions());
  ok(tv.claudeCli && tv.agentSdk && tv.codex && tv.gemini, "toolVersions reports all four tools");
  ok(tv.codex.present && /\d+\.\d+\.\d+/.test(tv.codex.version || ""), `Codex CLI detected (${tv.codex.version})`);
  ok(tv.gemini.present && /\d+\.\d+\.\d+/.test(tv.gemini.version || ""), `Gemini CLI detected (${tv.gemini.version})`);

  /* ---------- provider auth status + key persistence ---------- */
  const st = await win.evaluate(() => window.atomnano.providers.authStatus());
  ok(st.anthropic && st.openai && st.google && st.custom, "provider auth status covers all four providers");
  const set = await win.evaluate(() => window.atomnano.settings.set({ openaiApiKey: "sk-o", geminiApiKey: "g-key", customApiKey: "c-key" }));
  ok(set.openaiApiKey === "sk-o" && set.geminiApiKey === "g-key" && set.customApiKey === "c-key", "per-provider API keys persist");
  const st2 = await win.evaluate(() => window.atomnano.providers.authStatus());
  ok(st2.openai.key && st2.google.key && st2.custom.key, "auth status reflects the saved keys");

  /* ---------- auto skill creator (>=4 recurrences) ---------- */
  for (let i = 0; i < 4; i++) await win.evaluate(({ cwd, i }) => window.atomnano.test.skillsRecord(cwd, { prompt: "deploy the service to staging server " + i, files: [cwd + "/deploy.sh"], tools: ["Bash"] }), { cwd: CWD, i });
  for (let i = 0; i < 3; i++) await win.evaluate(({ cwd, i }) => window.atomnano.test.skillsRecord(cwd, { prompt: "rename a css token " + i, files: [cwd + "/x.css"] }), { cwd: CWD, i });
  const created = await win.evaluate((cwd) => window.atomnano.test.skillsAutocreate(cwd), CWD);
  ok(created.length >= 1, `auto-created a skill from the recurring workflow (${created.length})`);
  ok(created.every((s) => s.status === "active" && s.source === "learned"), "auto-created skills are ACTIVE + learned (no accept step)");
  const all = await win.evaluate((cwd) => window.atomnano.skills.list(cwd), CWD);
  ok(all.some((s) => /deploy|staging|server/i.test(s.name) && s.status === "active"), "the deploy workflow became an active skill");
  ok(!all.some((s) => /css|token|rename/i.test(s.name) && s.status === "active"), "a workflow seen only 3x is NOT auto-created (threshold respected)");

  /* ---------- Settings → Providers tab (merged; cards + seamless updater) ---------- */
  await win.evaluate(() => window.__openSettings());
  await win.waitForTimeout(200);
  await win.evaluate(() => window.__settingsCat("Providers"));
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
    if (ui.provCards >= 4 && ui.toolRows >= 2) break;
    await win.waitForTimeout(300);
  }
  ok(ui.connectionGone, "the separate Connection tab is gone (merged into Providers)");
  ok(ui.provCards === 4, `Providers shows a card per provider (${ui.provCards})`);
  ok(ui.primaryBadges === 1 && /Anthropic/.test(ui.primaryCard), `the primary provider is marked (${ui.primaryCard})`);
  ok(ui.labels.includes("Providers & Authentication") && ui.labels.some((l) => /Updates/.test(l)), "Providers + the seamless Updates box are both present");
  ok(ui.toolRows >= 2, `the reviewer CLIs (Antigravity/agy + Codex, + legacy Gemini if present) are listed (${ui.toolRows})`);

  /* ---------- a provider card opens a manage modal with Authorize + API key ---------- */
  await win.evaluate(() => document.querySelector(".prov-card").click());
  await win.waitForTimeout(500);
  const modal = await win.evaluate(() => { const m = document.querySelector(".prov-modal"); return m ? { authBtn: [...m.querySelectorAll("button")].some((b) => /Authorize/.test(b.textContent)), keyInputs: m.querySelectorAll("input[type=password]").length } : null; });
  ok(modal && modal.authBtn, "the provider modal has an Authorize button");
  ok(modal && modal.keyInputs === 1, `the provider modal has an API-key field (${modal && modal.keyInputs})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME TOOLS/SKILLS TESTS FAILED" : "\nALL TOOLS/SKILLS TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
