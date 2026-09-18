/* Full-backup export/import — the personal migration archive (src/main/ipc/settings.js):
 *  - the app-data bundle carries ALL settings — secrets (API keys) and the sub-agent toggles
 *    INCLUDED, so a restore on another machine is signed in and configured; only machine-local
 *    keys (historyDir, claudePath, windowBounds) are skipped — plus the per-project skill files
 *    the Workflow Studio attaches to its roles (userData/skills/<key>.json); no conversations
 *  - the full bundle adds every conversation (+ sidecars)
 *  - re-importing restores the conversations + the skill files
 * The restore is exercised the way a migration happens (2026-09-18): the full zip is imported into a SECOND app on a
 * DIFFERENT, empty profile, which is then closed and relaunched — so everything checked afterwards comes from disk,
 * never from the exporting profile's caches. What must come back: the seeded skill with the SAME id / name / steps,
 * the restored session under the SAME id with its own workflow still pointing the Coder at that skill, and the
 * project's default workflow carrying it too (per-project settings live in store.projectSettings — the bundle has to
 * carry that map for the last one to hold). */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-export");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 300000);

// One app on an isolated profile (ATOMNANO_USER_DATA + --user-data-dir: settings, sessions, skills, Claude home all under `dir`).
async function launch(dir) {
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + dir], env: { ...process.env, ATOMNANO_TEST: "1", ATOMNANO_USER_DATA: dir } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && window.atomnano && window.atomnano.test && window.atomnano.test.userdataExport && window.atomnano.skills && window.atomnano.workflow, null, { timeout: 20000 });
  return { app, win, errors };
}

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-export-udata");        // the SOURCE profile
  const udir2 = path.join(os.tmpdir(), "atomnano-export-udata-2");     // the RESTORE profile — a different, empty one
  fs.rmSync(udir, { recursive: true, force: true });
  fs.rmSync(udir2, { recursive: true, force: true });
  const zipApp = path.join(DIR, "backup-app.zip").replace(/\\/g, "/");
  const zipFull = path.join(DIR, "backup-full.zip").replace(/\\/g, "/");
  const CWD = DIR.replace(/\\/g, "/");
  const pageErrors = [];

  /* ================= the SOURCE profile: seed, export ================= */
  let { app, win, errors } = await launch(udir);
  await win.evaluate((p) => window.__setProject(p), CWD);
  await win.waitForTimeout(300);

  // seed: a conversation, a workflow skill (the store the Studio's Skills modal edits), settings incl. a SECRET + sub-agents ON
  const sid = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l[0] && l[0].id));
  ok(!!sid, `the source profile has a session to restore (${sid})`);
  await win.evaluate((sid) => window.atomnano.sessions.update(sid, { messages: [{ id: "m1", role: "user", text: "hello world", ts: new Date().toISOString() }] }), sid);
  const skill = await win.evaluate((cwd) => window.atomnano.skills.create(cwd, { name: "Add endpoint", steps: "do it", triggers: ["endpoint"] }), CWD);
  ok(skill && skill.id && skill.name === "Add endpoint" && skill.steps === "do it", `seeded the skill "Add endpoint" / steps "do it" (${skill && skill.id})`);
  // attach it to the Coder: on THIS tab's own workflow (the session record carries it → the full bundle) and on the
  // project's default workflow (settings.workflow for this project). workflow.set(patch, cwd, sid) — no sid = the project's.
  const attSession = await win.evaluate((a) => window.atomnano.workflow.set({ roles: { coder: { skills: [a.id] } } }, undefined, a.sid), { id: skill.id, sid });
  const attProject = await win.evaluate((a) => window.atomnano.workflow.set({ roles: { coder: { skills: [a.id] } } }, a.cwd), { id: skill.id, cwd: CWD });
  ok(attSession && attSession.scope === "session" && attSession.active.roles.coder.skills.join() === skill.id, `the skill is attached to the Coder on the session's own workflow (scope ${attSession && attSession.scope})`);
  ok(attProject && attProject.scope === "project" && attProject.active.roles.coder.skills.join() === skill.id, `…and on the project's default workflow (scope ${attProject && attProject.scope})`);
  // (settings.get()/set() are scoped to the WINDOW's registered project — main.js projectOf —, not to the folder
  // __setProject shows in the renderer, so every project-scoped read here names the folder explicitly.)
  const projectWf = await win.evaluate((cwd) => window.atomnano.workflow.get(cwd).then((r) => (r.active.roles.coder.skills || [])), CWD);
  ok(projectWf.join() === skill.id, `workflow.get(<project>) reads the project default attachment back (${JSON.stringify(projectWf)})`);
  await win.evaluate(() => window.atomnano.settings.set({ theme: "midnight", apiKey: "sk-SECRET", subAgents: true, subAgentsMax: 5 }));
  await win.waitForTimeout(900);   // let the skill store's debounced write (~600 ms) land before the bundle reads the files

  /* ---------- app-data export (the default scope) ---------- */
  const exp = await win.evaluate((p) => window.atomnano.test.userdataExport(p), zipApp);
  ok(fs.existsSync(zipApp), "export wrote a backup zip");
  ok(exp.names.some((n) => /^preferences\.json$/.test(n)) && exp.names.some((n) => /^manifest\.json$/.test(n)), "bundle contains the manifest + settings");
  ok(exp.names.some((n) => /^skills\/.+\.json$/.test(n)) && exp.skills >= 1, `bundle contains the per-project skill files (${exp.skills})`);
  ok(exp.sessions === 0 && !exp.names.some((n) => /^sessions\//.test(n)), "the app-data scope carries no conversations");
  ok(exp.prefKeys.includes("theme") && exp.prefKeys.includes("defaultModel"), "settings are included (theme, defaultModel …)");
  ok(exp.prefKeys.includes("projectSettings"), "the per-project overrides map (store.projectSettings — each project's active workflow, picks, toggles) travels in preferences.json");
  ok(exp.hasSecret && exp.prefKeys.includes("apiKey"), "API key (secret) is INCLUDED — a personal migration archive restores signed in");
  ok(exp.hasSubAgents && exp.prefKeys.includes("subAgents"), "sub-agent toggles are INCLUDED (every preference travels)");
  ok(!exp.prefKeys.includes("historyDir") && !exp.prefKeys.includes("claudePath") && !exp.prefKeys.includes("windowBounds"), "machine-local keys (historyDir, claudePath, windowBounds) are skipped");

  /* ---------- full export adds the conversations ---------- */
  const full = await win.evaluate((arg) => window.atomnano.test.userdataExport(arg), { path: zipFull, includeSessions: true });
  ok(fs.existsSync(zipFull) && full.sessions >= 1 && full.names.some((n) => /^sessions\/.+\.json$/.test(n)), `the full bundle contains all conversations (${full.sessions})`);
  ok(full.names.includes(`sessions/${sid}.json`), `…the seeded session among them (sessions/${sid}.json)`);
  ok(full.skills >= 1 && full.names.some((n) => /^skills\/.+\.json$/.test(n)), "…and the skill files too");
  pageErrors.push(...errors);
  await app.close();

  /* ================= the RESTORE profile: a different, empty profile ================= */
  ({ app, win, errors } = await launch(udir2));
  const virgin = await win.evaluate((cwd) => Promise.all([window.atomnano.skills.list(cwd), window.atomnano.sessions.list()]), CWD);
  ok(Array.isArray(virgin[0]) && virgin[0].length === 0 && !virgin[1].some((s) => s.id === sid), `the second profile starts empty for this project (${virgin[0].length} skills; the seeded session is not there)`);
  const imp = await win.evaluate((p) => window.atomnano.test.userdataImport(p), zipFull);
  ok(imp.sessions >= 1 && imp.skills >= 1, `import restores conversations + skill files (sessions=${imp.sessions}, skills=${imp.skills})`);
  await win.waitForTimeout(600);
  pageErrors.push(...errors);
  await app.close();

  /* ---------- relaunch that profile: everything below comes from disk, not from an in-memory cache ---------- */
  ({ app, win, errors } = await launch(udir2));
  await win.evaluate((p) => window.__setProject(p), CWD);
  await win.waitForTimeout(300);
  const skillsAfter = await win.evaluate((cwd) => window.atomnano.skills.list(cwd), CWD);
  const restored = Array.isArray(skillsAfter) ? skillsAfter.find((s) => s.id === skill.id) : null;
  ok(!!restored, `after the relaunch the restored profile lists the seeded skill under the SAME id (${skill.id}; ${Array.isArray(skillsAfter) ? skillsAfter.length : "?"} skills)`);
  ok(restored && restored.name === "Add endpoint" && restored.steps === "do it", `…with its name "Add endpoint" and steps "do it" (${restored && JSON.stringify([restored.name, restored.steps])})`);
  const sessionsAfter = await win.evaluate(() => window.atomnano.sessions.list());
  ok(sessionsAfter.some((s) => s.id === sid), `the restored session exists under the same id (${sid})`);
  const wfSession = await win.evaluate((sid) => window.atomnano.workflow.get(undefined, sid), sid);
  const sessSkills = (wfSession && wfSession.active && wfSession.active.roles && wfSession.active.roles.coder && wfSession.active.roles.coder.skills) || [];
  ok(wfSession && wfSession.scope === "session" && sessSkills.includes(skill.id), `the restored session's OWN workflow still attaches the skill to the Coder (scope ${wfSession && wfSession.scope}, skills ${JSON.stringify(sessSkills)})`);
  const wfProject = await win.evaluate((cwd) => window.atomnano.workflow.get(cwd), CWD);
  const projSkills = (wfProject && wfProject.active && wfProject.active.roles && wfProject.active.roles.coder && wfProject.active.roles.coder.skills) || [];
  // The project's default workflow (like every per-project preference) lives in store.projectSettings[<project>];
  // store.getSettings() is the no-project view, which DROPS that map, so buildUserdataBundle adds it explicitly and
  // applyUserdataBundle merges it project by project (src/main/ipc/settings.js, 2026-09-18). A restore on another
  // machine must not come back with the default workflow for a project the user configured.
  ok(projSkills.includes(skill.id), `the project's default workflow carries the attachment too (workflow.get(<project>) → coder.skills ${JSON.stringify(projSkills)}) — per-project settings (store.projectSettings) must travel in preferences.json`);
  const keyBack = await win.evaluate(() => window.atomnano.settings.get().then((s) => !!s.apiKey));
  ok(keyBack, "the machine-level preferences came along (the API key is present after the restore)");
  pageErrors.push(...errors);

  ok(pageErrors.length === 0, "no page errors" + (pageErrors.length ? " — " + pageErrors.join(" | ") : ""));
  await app.close();
  clearTimeout(watchdog);
  console.log(process.exitCode ? "\nSOME EXPORT TESTS FAILED" : "\nALL EXPORT TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
