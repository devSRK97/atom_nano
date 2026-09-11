/* Per-project settings: provider / model / appearance / agent prefs are scoped
 * to the project; secrets + machine-level keys stay global.
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const udir = path.join(os.tmpdir(), "atomnano-projset-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => window.atomnano.test && window.atomnano.test.settingsScope, null, { timeout: 15000 });

  const r = await win.evaluate(() => window.atomnano.test.settingsScope());

  /* ---------- provider/model are isolated per project ---------- */
  ok(r.aProvider === "google" && r.aModel === "gemini-3.1-pro-preview", `project A keeps its provider/model (${r.aProvider} · ${r.aModel})`);
  ok(r.bProvider === "openai" && r.bModel === "gpt-5.5", `project B keeps its own provider/model (${r.bProvider} · ${r.bModel})`);
  ok(r.aProvider !== r.bProvider, "the two projects do NOT share the provider");

  /* ---------- appearance is per-project too ---------- */
  ok(r.aTheme === "blue" && r.bTheme === "rose", `theme is per-project (A=${r.aTheme}, B=${r.bTheme})`);

  /* ---------- secrets stay GLOBAL (account-level) ---------- */
  ok(r.globalApiKey === "sk-secret-xyz", "an API key set in any project is stored globally");
  ok(r.aSeesGlobalKey === "sk-secret-xyz", "every project sees the same global API key");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME PROJECT-SETTINGS TESTS FAILED" : "\nALL PROJECT-SETTINGS TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
