/* Full-backup export/import:
 *  - bundle includes ALL settings, every conversation (+ sidecars), and skills
 *  - secrets (API keys) and sub-agent toggles are EXCLUDED ("no sub-agents")
 *  - re-importing restores the conversations + skills
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-export");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-export-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const zipPath = path.join(DIR, "backup.zip").replace(/\\/g, "/");
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && window.atomnano.test && window.atomnano.test.userdataExport, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const CWD = DIR.replace(/\\/g, "/");

  // seed: a conversation, a skill, settings incl. a SECRET + sub-agents ON
  const sid = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l[0] && l[0].id));
  await win.evaluate((sid) => window.atomnano.sessions.update(sid, { messages: [{ id: "m1", role: "user", text: "hello world", ts: new Date().toISOString() }] }), sid);
  await win.evaluate((cwd) => window.atomnano.skills.create(cwd, { name: "Add endpoint", steps: "do it", triggers: ["endpoint"] }), CWD);
  await win.evaluate(() => window.atomnano.settings.set({ theme: "midnight", apiKey: "sk-SECRET", subAgents: true, subAgentsMax: 5 }));
  await win.waitForTimeout(900);   // let the skill's debounced write land

  /* ---------- export ---------- */
  const exp = await win.evaluate((p) => window.atomnano.test.userdataExport(p), zipPath);
  ok(fs.existsSync(zipPath), "export wrote a backup zip");
  ok(exp.names.some((n) => /^preferences\.json$/.test(n)) && exp.names.some((n) => /^sessions\/.+\.json$/.test(n)), "bundle contains settings + conversations");
  ok(exp.names.some((n) => /^skills\/.+\.json$/.test(n)) && exp.skills >= 1, `bundle contains skills (${exp.skills})`);
  ok(exp.sessions >= 1, `bundle contains all conversations (${exp.sessions})`);
  ok(exp.prefKeys.includes("theme") && exp.prefKeys.includes("defaultModel"), "settings are included (theme, defaultModel …)");
  ok(!exp.hasSecret && !exp.prefKeys.includes("apiKey"), "API key (secret) is EXCLUDED from the backup");
  ok(!exp.hasSubAgents && !exp.prefKeys.includes("subAgents"), "sub-agent toggles are EXCLUDED (\"no sub-agents\")");

  /* ---------- re-import restores conversations + skills ---------- */
  const imp = await win.evaluate((p) => window.atomnano.test.userdataImport(p), zipPath);
  ok(imp.sessions >= 1 && imp.skills >= 1, `import restores conversations + skills (sessions=${imp.sessions}, skills=${imp.skills})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME EXPORT TESTS FAILED" : "\nALL EXPORT TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
