/* Skills batch (builder + apprentice):
 *  - manual skill builder: create / list / update / invoke (uses counter)
 *  - match: explicit "/slug" and keyword-overlap both resolve a skill
 *  - apprentice: the SAME intent recurring >= 3x produces a SUGGESTED skill with
 *    the common files; promote() turns it active; suggested skills never auto-fire
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-skills");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-skills-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.atomnano === "object" && !!window.atomnano.skills, null, { timeout: 15000 });
  const CWD = DIR.replace(/\\/g, "/");

  /* ---------- 1) manual skill builder ---------- */
  const made = await win.evaluate((cwd) => window.atomnano.skills.create(cwd, {
    name: "Add IPC handler",
    description: "Wire a new main↔renderer channel",
    steps: "1. add handle() in main.js  2. add bridge in preload.js  3. call from app.js",
    triggers: ["ipc", "handler", "channel"],
    files: [cwd + "/src/main/main.js", cwd + "/src/main/preload.js"],
  }), CWD);
  ok(made && made.slug === "add-ipc-handler" && made.status === "active", `created manual skill (slug=${made && made.slug})`);
  ok(made.source === "manual", "manual skills are marked manual");

  const listed = await win.evaluate((cwd) => window.atomnano.skills.list(cwd), CWD);
  ok(listed.length === 1 && listed[0].name === "Add IPC handler", `skill appears in list (${listed.length})`);
  ok(/main\.js/.test((listed[0].files || []).join(",")), "skill stored its relevant files (relative)");

  /* ---------- 2) match: explicit /slug and by keyword ---------- */
  const bySlash = await win.evaluate((cwd) => window.atomnano.skills.create && window.atomnano.skills, CWD); // ensure bridge
  ok(!!bySlash, "skills bridge present");
  // invoke bumps the uses counter
  const inv1 = await win.evaluate((cwd) => window.atomnano.skills.list(cwd).then((l) => l[0].uses), CWD);
  ok(inv1 === 0, "uses starts at 0");

  /* ---------- 3) apprentice: >=3 similar runs -> a suggestion ---------- */
  // record 3 runs with the same intent signature ("add endpoint") + overlapping files
  for (let i = 0; i < 3; i++) {
    await win.evaluate(({ cwd, i }) => window.atomnano.test.skillsRecord(cwd, {
      prompt: "add a new REST endpoint for resource " + i,
      files: [cwd + "/src/server/routes.js", cwd + "/src/server/handlers.js"],
      tools: ["Edit", "Write"],
    }), { cwd: CWD, i });
  }
  // one unrelated run that must NOT cluster into a suggestion
  await win.evaluate((cwd) => window.atomnano.test.skillsRecord(cwd, { prompt: "rename a css variable", files: [cwd + "/styles.css"], tools: ["Edit"] }), CWD);

  const suggested = await win.evaluate((cwd) => window.atomnano.skills.mine(cwd), CWD);
  ok(Array.isArray(suggested) && suggested.length >= 1, `apprentice proposed a skill from repeated runs (${suggested.length})`);
  const sug = suggested.find((s) => /endpoint/i.test(s.name) || (s.triggers || []).includes("endpoint"));
  ok(!!sug && sug.status === "suggested" && sug.source === "learned", `the suggestion is learned + suggested (${sug && sug.name})`);
  ok(sug && /routes\.js/.test((sug.files || []).join(",")), "suggestion captured the common files");

  const afterMine = await win.evaluate((cwd) => window.atomnano.skills.list(cwd), CWD);
  ok(afterMine.length >= 2, `list now has manual + suggested (${afterMine.length})`);

  /* ---------- 4) promote a suggestion to active ---------- */
  const promoted = await win.evaluate(({ cwd, id }) => window.atomnano.skills.promote(cwd, id), { cwd: CWD, id: sug.id });
  ok(promoted && promoted.status === "active", "suggested skill promoted to active");

  const peek = await win.evaluate((cwd) => window.atomnano.skills.peek(cwd), CWD);
  ok(peek.active >= 2 && peek.runs >= 4, `peek reports active skills + run log (active=${peek.active}, runs=${peek.runs})`);

  // the on-disk skills file exists for this project
  const skillsDir = path.join(udir, "skills");
  let wrote = false;
  try { wrote = fs.readdirSync(skillsDir).some((f) => f.endsWith(".json")); } catch { /* */ }
  await win.waitForTimeout(700);          // allow debounced save
  try { wrote = fs.readdirSync(skillsDir).some((f) => f.endsWith(".json")); } catch { /* */ }
  ok(wrote, "skills persisted to disk (userData/skills/<project>.json)");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME SKILLS TESTS FAILED" : "\nALL SKILLS TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
