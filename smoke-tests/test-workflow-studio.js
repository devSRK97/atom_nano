/* Workflow studio, end to end in the REAL Electron app on an isolated profile: open the studio, the five role
 * nodes (the Orchestrator primary + Planner / Coder / Reviewer / Tester) and four edges render, Enabled flips
 * through the header switch and lands in settings, the Coder's sub-agent lane stepper persists, a preset applies,
 * the library round-trips (save as → export → delete → import → load → rename), the unsaved-changes marker
 * appears, Esc closes. Writes test-results/workflow-studio.png.
 * The Skills modal (2026-09-18, the only skills UI): the bridge surface, installed rows with Planner / Coder /
 * Reviewer ticks + Remove, a tick lands on THIS tab's workflow only and lights the node chip and the inspector,
 * install from a URL (JSON list, SKILL.md — served by a local fixture server; a 404 shows inline and keeps the
 * link), the write-by-hand form (refused without steps, input kept; new skills unticked; Cancel), Remove
 * (cancelled, then confirmed: skill gone + detached + chip gone), an attached id with no skill behind it shows
 * as unavailable with Detach, the remembered install mode, and a CLI install that closes the modal and the
 * studio and runs a harmless command in a visible app terminal.
 * The studio is opened through window.__openWorkflow (wired by the chat integration); when that hook is not
 * there yet the module is imported directly so the UI still gets exercised — that is reported, not hidden. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-wfstudio");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const skip = (m) => console.log("SKIP:", m);
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 240000);
// Skill fixtures the main process fetches over loopback — a JSON list and a SKILL.md; anything else is a 404.
const FIXTURES = {
  "/skills.json": JSON.stringify([{ name: "Imported alpha", description: "from the fixture server", steps: "1. alpha" }, { name: "Imported beta", steps: "1. beta" }]),
  "/SKILL.md": "---\nname: Imported gamma\ndescription: md fixture\n---\n\n1. gamma\n2. done\n",
};

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-wfstudio-udata"); fs.rmSync(udir, { recursive: true, force: true });
  const srv = http.createServer((req, res) => { const body = FIXTURES[req.url]; if (!body) { res.statusCode = 404; res.end("no such fixture"); return; } res.setHeader("content-type", "text/plain; charset=utf-8"); res.end(body); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const FIX = `http://127.0.0.1:${srv.address().port}`;
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1", ATOMNANO_USER_DATA: udir } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && window.atomnano, null, { timeout: 20000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(400);

  // ---- the hook (integration worker) or a direct import of the module ----
  const hook = await win.waitForFunction(() => typeof window.__openWorkflow === "function", null, { timeout: 15000 }).then(() => true).catch(() => false);
  if (!hook) {
    console.log("NOTE: window.__openWorkflow is not wired yet (chat integration) — importing src/renderer/workflow/index.js directly");
    await win.evaluate(() => import("./workflow/index.js").then((m) => { window.__wfMod = m; }));
  }
  const hasService = await win.evaluate(() => !!(window.atomnano.workflow && typeof window.atomnano.workflow.get === "function"));
  if (!hasService) console.log("NOTE: window.atomnano.workflow is not in the preload yet (main-process worker) — the studio runs on its settings-backed fallback; export/import are skipped");
  // The studio edits the ACTIVE TAB's own workflow (per-session selection, 2026-09-18) — read it with the tab's id.
  const getActive = () => win.evaluate(async () => {
    const st = await import("./core/state.js"); const sid = st.state.activeTabId || undefined;
    if (window.atomnano.workflow && window.atomnano.workflow.get) { const r = await window.atomnano.workflow.get(undefined, sid); return { active: r.active, scope: r.scope, library: r.library || [] }; }
    const s = await window.atomnano.settings.get(); return { active: s.workflow || {}, library: s.workflows || [] };
  });
  const menuClick = async (btnSel, label) => {
    await win.click(btnSel);
    await win.locator("#ctxMenu:not(.hidden) .ctx-item", { hasText: label }).first().click();
    await win.waitForTimeout(250);
  };
  const promptFill = async (value) => {
    await win.waitForSelector(".modal .prompt-input", { timeout: 5000 });
    await win.fill(".modal .prompt-input", value);
    await win.press(".modal .prompt-input", "Enter");
    await win.waitForTimeout(350);
  };

  // ---- open + shape ----
  await win.evaluate(() => (window.__openWorkflow ? window.__openWorkflow() : window.__wfMod.openWorkflowStudio()));
  await win.waitForSelector(".wf-panel", { timeout: 8000 });
  await win.waitForTimeout(500);
  const shape = await win.evaluate(() => ({
    nodes: document.querySelectorAll(".wf-nodeg").length, names: [...document.querySelectorAll(".wf-node-name")].map((n) => n.textContent),
    edges: document.querySelectorAll(".wf-edge-flow").length, lane: !!document.querySelector(".wf-lane-band"), orbs: document.querySelectorAll(".wf-lane-orb").length,
    header: !!document.querySelector("#wfName") && !!document.querySelector("#wfLibrary") && !!document.querySelector("#wfPresets"), inspector: !!document.querySelector(".wf-inspector .wf-insp"),
    title: (document.querySelector(".wf-h3") || {}).textContent,
  }));
  ok(shape.nodes === 5 && shape.names.join() === "Orchestrator,Planner,Coder,Reviewer,Tester", `the five role nodes render — the Orchestrator primary and its four workers (${shape.names.join(", ")})`);
  ok(shape.edges === 4 && shape.lane, `four Orchestrator → role edges and the sub-agent lanes render (${shape.edges} edges, lane ${shape.lane}, ${shape.orbs} lane orbs)`);
  ok(shape.header && shape.inspector && shape.title === "Workflow studio", "header (name · Library · Presets) and the inspector overview are there");

  // ---- Enabled through the header switch → settings ----
  const before = (await getActive()).active.enabled === true;
  await win.click(".wf-enabled .sw");
  await win.waitForTimeout(400);
  const flipped = await getActive();
  const sEnabled = flipped.active.enabled;
  const projEnabled = await win.evaluate(() => window.atomnano.settings.get().then((s) => !!(s.workflow && s.workflow.enabled)));
  ok(sEnabled === !before && flipped.scope === "session" && projEnabled === before, `Enabled flipped through the UI for THIS tab only (own workflow, scope ${flipped.scope}; the project's default stays ${projEnabled}) — workflow.enabled = ${sEnabled}`);
  const offbarHidden = await win.evaluate(() => document.querySelector(".wf-offbar").classList.contains("hidden"));
  ok(offbarHidden === sEnabled, "the 'Workflow off' banner follows the switch");

  // ---- the workflow chip's own switch (2026-09-18): off keeps this tab's design, on brings it back; the knob mirrors the state ----
  const designBefore = (await getActive()).active;
  await win.evaluate(() => document.querySelector("#wfChip .wf-chip-sw").click()); await win.waitForTimeout(450);
  const offNow = (await getActive()).active;
  const knobOff = await win.evaluate(() => { const s = document.querySelector("#wfChip .wf-chip-sw"); return s ? s.classList.contains("on") : null; });
  await win.evaluate(() => document.querySelector("#wfChip .wf-chip-sw").click()); await win.waitForTimeout(450);
  const onAgain = (await getActive()).active;
  const knobOn = await win.evaluate(() => { const s = document.querySelector("#wfChip .wf-chip-sw"); return s ? s.classList.contains("on") : null; });
  ok(designBefore.enabled === true && offNow.enabled === false && knobOff === false && onAgain.enabled === true && knobOn === true && onAgain.name === designBefore.name && onAgain.roles.coder.agents === designBefore.roles.coder.agents && JSON.stringify(onAgain.roles) === JSON.stringify(designBefore.roles), `the chip's switch flips this tab's workflow off and back on, the design survives (name "${onAgain.name}", coder lane ${onAgain.roles.coder.agents}) and the knob mirrors the state (${knobOff} → ${knobOn})`);
  // ---- exclusive with solo sub-agents: turning the workflow on while they are on asks first; yes turns them off ----
  await win.evaluate(async () => { const st = await import("./core/state.js"); st.state.settings.subAgents = true; await window.atomnano.settings.set({ subAgents: true }); });
  await win.evaluate(() => document.querySelector("#wfChip .wf-chip-sw").click()); await win.waitForTimeout(400);   // off — no question
  const noAsk = await win.evaluate(() => document.querySelectorAll("#modalRoot > .modal-backdrop").length);
  await win.evaluate(() => document.querySelector("#wfChip .wf-chip-sw").click()); await win.waitForTimeout(400);   // on → asks
  const asked = await win.evaluate(() => { const d = [...document.querySelectorAll("#modalRoot > .modal-backdrop")].pop(); return d ? d.textContent : ""; });
  ok(noAsk === 0 && /Turn on the workflow for this tab\?/.test(asked) && /Solo sub-agents are on/.test(asked), "turning the workflow off asks nothing; turning it on while solo sub-agents are on asks first");
  await win.evaluate(() => [...document.querySelectorAll("#modalRoot > .modal-backdrop")].pop().querySelector(".btn-primary").click()); await win.waitForTimeout(500);
  const afterYes = (await getActive()).active;
  const agentsOff = await win.evaluate(() => window.atomnano.settings.get().then((s) => s.subAgents === false));
  const agentsBtn = await win.evaluate(() => ((document.getElementById("agentsBtn") || {}).textContent || "").trim());
  ok(afterYes.enabled === true && agentsOff && /Agents · workflow/.test(agentsBtn), `yes → solo sub-agents off (settings.subAgents=false), the workflow on, the composer's Agents button reads "${agentsBtn}"`);

  // ---- the lane stepper: 3 → 5 ----
  const agents0 = (await getActive()).active.roles.coder.agents;
  for (let i = agents0; i < 5; i++) { await win.click(".wf-lane-ctl.coder .wf-lane-plus"); await win.waitForTimeout(280); }
  const laneAfter = await getActive();
  const laneOrbs = await win.evaluate(() => document.querySelectorAll(".wf-lane-orb").length);
  ok(laneAfter.active.roles.coder.agents === 5 && laneOrbs === 5, `the lane stepper set coder.agents = ${laneAfter.active.roles.coder.agents} (persisted) and draws ${laneOrbs} orbs`);

  // ---- select a node → inspector ----
  await win.evaluate(() => { const c = document.querySelector('.wf-nodeg[data-role="coder"] .wf-node'); c.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 10, clientY: 10 })); c.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 7, clientX: 10, clientY: 10 })); });
  await win.waitForTimeout(250);
  const insp = await win.evaluate(() => ({ sel: !!document.querySelector(".wf-nodeg.coder.selected"), title: (document.querySelector(".wf-insp-title b") || {}).textContent, seg: document.querySelectorAll(".wf-inspector .wf-seg").length, stepper: !!document.querySelector(".wf-inspector .wf-stepper") }));
  ok(insp.sel && insp.title === "Coder" && insp.seg >= 2 && insp.stepper, `clicking the Coder node selects it and the inspector shows its editor (provider + access segments, the agents stepper)`);
  await win.click(".wf-inspector .wf-seg.access button.acc-read");
  await win.waitForTimeout(300);
  ok((await getActive()).active.roles.coder.access === "read", "the inspector's Access segment persists roles.coder.access = read");

  // ---- Skills (the studio is the only skills UI): local fixtures, a harmless CLI command ----
  const skCwd = await win.evaluate(async () => { const st = await import("./core/state.js"); const ts = st.state.tabs.get(st.state.activeTabId); return (ts && ts.meta && ts.meta.cwd) || st.state.project || ""; });
  const surface = await win.evaluate(() => Object.keys(window.atomnano.skills).sort().join());
  ok(surface === "create,importUrl,list,remove,update", `atomnano.skills is exactly { list, create, update, remove, importUrl } (${surface})`);
  const seeded = await win.evaluate((cwd) => window.atomnano.skills.create(cwd, { name: "Fixture skill A", description: "seeded by the smoke", steps: "1. do A" }), skCwd);
  ok(seeded && seeded.id && seeded.status === "active" && seeded.source === "manual", `a fixture skill exists for the tab's project (${seeded && seeded.id})`);
  const rowsN = () => win.evaluate(() => document.querySelectorAll(".wf-skills-rows .wf-skills-row.skill").length);
  const waitRows = (n) => win.waitForFunction((k) => document.querySelectorAll(".wf-skills-rows .wf-skills-row.skill").length === k, n, { timeout: 8000 }).catch(() => {});
  const vis = () => win.evaluate(() => ({ chip: ((document.querySelector('.wf-nodeg[data-role="coder"] .wf-count-chip.skills') || {}).textContent || "").trim(), insp: ([...document.querySelectorAll(".wf-inspector .wf-btn")].map((b) => b.textContent).find((t) => /attached/.test(t)) || "").trim() }));
  const clickDone = async () => { await win.click(".modal-backdrop:last-child .modal-foot .btn-primary"); await win.waitForTimeout(150); };
  await win.click("#wfSkills");
  await win.waitForSelector(".wf-skills-row.skill", { timeout: 6000 });
  await win.waitForTimeout(150);
  const sk1 = await win.evaluate(() => ({
    heads: [...document.querySelectorAll(".wf-skills-row.head .wf-skills-col")].map((e) => e.textContent.trim()),
    rows: document.querySelectorAll(".wf-skills-rows .wf-skills-row.skill").length, boxes: document.querySelectorAll(".wf-skills-rows .wf-skills-row.skill input[type=checkbox]").length,
    remove: document.querySelectorAll(".wf-skills-rows .wf-skills-remove").length, mode: (document.querySelector(".wf-skills-mode button.active") || { dataset: {} }).dataset.mode,
    text: document.querySelector(".wf-skills").textContent, loading: !!document.querySelector(".wf-skills-status:not(.hidden)"),
  }));
  ok(sk1.heads.join() === "Planner,Coder,Reviewer" && sk1.rows === 1 && sk1.boxes === 3 && sk1.remove === 1 && !sk1.loading, `the Skills modal lists the installed skill with Planner / Coder / Reviewer ticks (no Tester) and a Remove action (${sk1.rows} row, ${sk1.boxes} boxes)`);
  ok(sk1.mode === "git" && !/Skills for this chat|Skills library/.test(sk1.text), "URL is the default install mode and the copy no longer points at the removed chat-header skills UI");
  await win.click(`.wf-skills-row.skill[data-id="${seeded.id}"] .wf-skills-col.coder input`);
  await win.waitForTimeout(500);
  const att = await getActive();
  const projSkills = await win.evaluate(() => window.atomnano.settings.get().then((s) => (s.workflow && s.workflow.roles && s.workflow.roles.coder && s.workflow.roles.coder.skills) || []));
  const v1 = await vis();
  ok(att.active.roles.coder.skills.join() === seeded.id && att.scope === "session" && projSkills.length === 0, `ticking the Coder attached the skill to THIS tab's workflow only (${JSON.stringify(att.active.roles.coder.skills)}; the project default keeps none)`);
  ok(/1 skill/.test(v1.chip) && /1 attached/.test(v1.insp), `the Coder node chip reads "${v1.chip}" and the inspector "${v1.insp}"`);
  // install from a URL: a JSON list, then a SKILL.md (Enter), then a 404
  await win.fill(".wf-skills-install .wf-skills-url", FIX + "/skills.json");
  await win.click(".wf-skills-install .wf-skills-go");
  await waitRows(3);
  const imp = await win.evaluate(() => ({ names: [...document.querySelectorAll(".wf-skills-rows .wf-skills-row.skill b")].map((b) => b.textContent), checked: document.querySelectorAll(".wf-skills-rows input[type=checkbox]:checked").length, input: document.querySelector(".wf-skills-url").value, err: document.querySelector(".wf-skills-install .wf-skills-err").textContent }));
  ok(imp.names.length === 3 && imp.names.includes("Imported alpha") && imp.names.includes("Imported beta") && imp.checked === 1 && imp.input === "" && !imp.err, `Install from a URL added the fixture list's two skills, unticked (${imp.names.join(", ")}; ${imp.checked} tick)`);
  await win.fill(".wf-skills-install .wf-skills-url", FIX + "/SKILL.md");
  await win.press(".wf-skills-install .wf-skills-url", "Enter");
  await waitRows(4);
  const md = await win.evaluate((cwd) => window.atomnano.skills.list(cwd).then((l) => l.find((s) => s.name === "Imported gamma") || null), skCwd);
  ok(md && md.source === "imported" && /^1\. gamma\n2\. done$/.test(md.steps) && md.description === "md fixture", `a SKILL.md import keeps the front matter and the body as steps (${md && JSON.stringify(md.steps)})`);
  await win.fill(".wf-skills-install .wf-skills-url", FIX + "/missing.json");
  await win.click(".wf-skills-install .wf-skills-go");
  await win.waitForFunction(() => !!document.querySelector(".wf-skills-install .wf-skills-err").textContent, null, { timeout: 8000 }).catch(() => {});
  const bad = await win.evaluate(() => ({ err: document.querySelector(".wf-skills-install .wf-skills-err").textContent, input: document.querySelector(".wf-skills-url").value, rows: document.querySelectorAll(".wf-skills-rows .wf-skills-row.skill").length, disabled: document.querySelector(".wf-skills-go").disabled }));
  ok(/HTTP 404/.test(bad.err) && /missing\.json/.test(bad.input) && bad.rows === 4 && !bad.disabled, `a failing URL shows an inline error ("${bad.err}"), keeps the link in the box and adds nothing`);
  // write one by hand: refused without steps (input kept), then created unticked; Cancel folds the form
  await win.click(".wf-skills-new");
  await win.fill(".wf-skills-f-name", "Handwritten skill");
  await win.click(".wf-skills-create");
  await win.waitForTimeout(200);
  const f1 = await win.evaluate(() => ({ err: document.querySelector(".wf-skills-form .wf-skills-err").textContent, name: document.querySelector(".wf-skills-f-name").value, rows: document.querySelectorAll(".wf-skills-rows .wf-skills-row.skill").length, shown: !document.querySelector(".wf-skills-form").classList.contains("hidden") }));
  ok(/steps/i.test(f1.err) && f1.name === "Handwritten skill" && f1.rows === 4 && f1.shown, `Create without steps is refused ("${f1.err}") and the typed name stays`);
  await win.fill(".wf-skills-f-desc", "typed in the studio");
  await win.fill(".wf-skills-f-steps", "1. write\n2. check");
  await win.click(".wf-skills-create");
  await waitRows(5);
  const f2 = await win.evaluate(() => ({ names: [...document.querySelectorAll(".wf-skills-rows .wf-skills-row.skill b")].map((b) => b.textContent), checked: document.querySelectorAll(".wf-skills-rows input[type=checkbox]:checked").length, hidden: document.querySelector(".wf-skills-form").classList.contains("hidden") }));
  ok(f2.names.includes("Handwritten skill") && f2.checked === 1 && f2.hidden, `the manual form created "Handwritten skill", unticked, and folded away (${f2.names.length} rows)`);
  await win.click(".wf-skills-new"); await win.fill(".wf-skills-f-name", "never created"); await win.click(".wf-skills-cancel");
  await win.waitForTimeout(150);
  const f3 = await win.evaluate(() => ({ hidden: document.querySelector(".wf-skills-form").classList.contains("hidden"), rows: document.querySelectorAll(".wf-skills-rows .wf-skills-row.skill").length }));
  ok(f3.hidden && f3.rows === 5, "Cancel folds the form away without creating anything");
  // remove: cancelled, then confirmed → the project skill is gone AND detached from the Coder; chip + inspector follow
  await win.click(`.wf-skills-row.skill[data-id="${seeded.id}"] .wf-skills-remove`);
  await win.waitForSelector(".modal-backdrop:last-child .btn-danger", { timeout: 5000 });
  await win.click(".modal-backdrop:last-child .btn-ghost");
  await win.waitForTimeout(300);
  ok((await rowsN()) === 5 && (await getActive()).active.roles.coder.skills.join() === seeded.id, "cancelling the removal keeps the skill and its attachment");
  await win.click(`.wf-skills-row.skill[data-id="${seeded.id}"] .wf-skills-remove`);
  await win.waitForSelector(".modal-backdrop:last-child .btn-danger", { timeout: 5000 });
  await win.click(".modal-backdrop:last-child .btn-danger");
  await waitRows(4);
  const rem = await getActive(); const left = await win.evaluate((cwd) => window.atomnano.skills.list(cwd).then((l) => l.map((s) => s.id)), skCwd); const v2 = await vis();
  ok(!left.includes(seeded.id) && rem.active.roles.coder.skills.length === 0 && !v2.chip && /None attached/.test(v2.insp), `Remove deleted the project skill and detached it from the Coder in one go (chip "${v2.chip}", inspector "${v2.insp}")`);
  // an attached id with no installed skill behind it → an "unavailable" row with Detach
  await clickDone();
  await win.evaluate(async () => { const m = await import("./workflow/model.js"); await m.edit({ roles: { reviewer: { skills: ["ghost-skill-id"] } } }); });
  await win.waitForTimeout(300);
  await win.click("#wfSkills");
  await win.waitForSelector(".wf-skills-row.missing", { timeout: 6000 });
  const ghost = await win.evaluate(() => ({ text: document.querySelector(".wf-skills-row.missing").textContent, marks: document.querySelectorAll(".wf-skills-row.missing .wf-skills-ghost").length, chip: ((document.querySelector('.wf-nodeg[data-role="reviewer"] .wf-count-chip.skills') || {}).textContent || "").trim() }));
  ok(/ghost-skill-id/.test(ghost.text) && /Reviewer/.test(ghost.text) && ghost.marks === 1 && /1 skill/.test(ghost.chip), `an attached id with no skill behind it shows as unavailable for the Reviewer (chip "${ghost.chip}")`);
  await win.click(".wf-skills-row.missing .wf-skills-detach");
  await win.waitForFunction(() => !document.querySelector(".wf-skills-row.missing"), null, { timeout: 6000 }).catch(() => {});
  const det = await getActive();
  ok(det.active.roles.reviewer.skills.length === 0 && (await rowsN()) === 4, "Detach dropped the unavailable id from the Reviewer and left the installed rows alone");
  // the install mode is a remembered project setting; CLI mode runs the command in a visible app terminal
  await win.click('.wf-skills-mode button[data-mode="cli"]');
  await win.waitForTimeout(350);
  const modeSaved = await win.evaluate(() => window.atomnano.settings.get().then((s) => s.skillInstallMode));
  ok(modeSaved === "cli", `the install mode is remembered as a project setting (skillInstallMode = ${modeSaved})`);
  await clickDone();
  await win.click("#wfSkills");
  await win.waitForSelector(".wf-skills-mode button.active", { timeout: 6000 });
  const modeBack = await win.evaluate(() => ({ mode: document.querySelector(".wf-skills-mode button.active").dataset.mode, go: document.querySelector(".wf-skills-go").textContent.trim(), hint: document.querySelector(".wf-skills-install .wf-hint").textContent }));
  ok(modeBack.mode === "cli" && /terminal/i.test(modeBack.go) && /nothing is scanned/i.test(modeBack.hint) && !/picked up/i.test(modeBack.hint), `reopening restores CLI mode ("${modeBack.go}") and its hint does not claim installs become entries`);
  await win.evaluate(() => { window.__wfCmdExits = []; window.atomnano.events.onTerminalCommandExit((ev) => window.__wfCmdExits.push(ev)); });
  await win.fill(".wf-skills-url", "echo atomnano-skill-cli-smoke");
  await win.click(".wf-skills-go");
  await win.waitForTimeout(800);
  const cli = await win.evaluate(() => ({ modal: !!document.querySelector(".wf-skills"), studio: !!document.querySelector(".wf-panel"), dock: (() => { const d = document.getElementById("termDock"); return !!d && !d.classList.contains("hidden"); })(), tab: (document.querySelector(".term-tab.active .term-tab-name") || {}).textContent || "" }));
  ok(!cli.modal && !cli.studio && cli.dock && /skill install/.test(cli.tab), `a CLI install closes the modal and the studio and runs in a visible app terminal ("${cli.tab}")`);
  const termOut = await win.evaluate(async () => { const t = window.atomnano.terminal; if (!t || !t.list || !t.buffer) return null; const l = await t.list(); const me = (l || []).find((x) => /skill install/.test(x.title || "")); return me ? await t.buffer(me.id) : ""; });
  if (termOut === null) skip("terminal buffer probe — the bridge has no list/buffer"); else ok(/atomnano-skill-cli-smoke/.test(String((termOut && termOut.buf) || termOut || "")), "the command's output is in that terminal");
  /* The exit toast rides on runInTerminal's onExit → the main terminal's `__ATOM_CMD__` marker (terminal:command-exit).
   * Under Windows ConPTY the marker is followed by a cursor-positioning sequence instead of a newline; MARK_RE in
   * src/main/workspace/terminal.js stopped requiring the newline on 2026-09-18, so the event reaches the renderer on
   * every backend. Both the completion event and the toast are REQUIRED here — a backend that delivers no exit event
   * is a failure, never a skip. The shell has to start and run the two lines first, so the wait is generous (15 s). */
  const toasted = await win.waitForFunction(() => { const t = document.getElementById("toast"); return !!t && !t.classList.contains("hidden") && /Installer (finished|exited)/.test(t.textContent); }, null, { timeout: 15000 }).then(() => win.evaluate(() => document.getElementById("toast").textContent)).catch(() => "");
  const exits = await win.evaluate(() => window.__wfCmdExits.length);
  ok(exits >= 1, `the terminal backend delivered terminal:command-exit for the installer command (${exits} event(s); the __ATOM_CMD__ marker was matched)`);
  ok(/Installer finished/.test(toasted), `the installer's exit is reported and points back at the studio ("${toasted.trim()}")`);
  await win.evaluate(() => { const b = document.querySelector('#termDock .term-act[title^="Hide"]'); if (b) b.click(); });
  await win.evaluate(() => (window.__openWorkflow ? window.__openWorkflow() : window.__wfMod.openWorkflowStudio()));
  await win.waitForSelector(".wf-panel", { timeout: 8000 });
  await win.waitForTimeout(400);

  // ---- drag the Tester node (real pointer events) → layout persists, snapped to the 8 px grid; Fit re-frames ----
  const tBefore = await win.evaluate(() => { const r = document.querySelector('.wf-nodeg[data-role="tester"] .wf-node-name').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, d: document.querySelector(".wf-edge-flow.tester").getAttribute("d"), vb: document.querySelector(".wf-svg").getAttribute("viewBox") }; });
  await win.mouse.move(tBefore.x, tBefore.y); await win.mouse.down();
  for (let i = 1; i <= 6; i++) { await win.mouse.move(tBefore.x - 15 * i, tBefore.y + 8 * i); await win.waitForTimeout(20); }
  await win.mouse.up(); await win.waitForTimeout(400);
  const tAfter = await getActive();
  const tLay = tAfter.active.layout && tAfter.active.layout.tester;
  const tEdge = await win.evaluate(() => document.querySelector(".wf-edge-flow.tester").getAttribute("d"));
  ok(tLay && Number.isFinite(tLay.x) && tLay.x % 8 === 0 && tLay.y % 8 === 0 && !(tLay.x === 580 && tLay.y === 494) && tEdge !== tBefore.d, `dragging the Tester persisted layout.tester = ${JSON.stringify(tLay)} (8 px snap) and re-pathed its edge`);
  await win.click(".wf-tools .wf-tool");   // Fit
  await win.waitForTimeout(200);
  const vbFit = await win.evaluate(() => document.querySelector(".wf-svg").getAttribute("viewBox"));
  ok(vbFit && vbFit !== tBefore.vb, `Fit re-framed the canvas (viewBox ${vbFit})`);

  // ---- preset ----
  await menuClick("#wfPresets", "Full orchestra");
  await win.waitForTimeout(300);
  const pre = (await getActive()).active;
  ok(pre.name === "Full orchestra" && pre.roles.coder.enabled && pre.roles.reviewer.enabled && pre.roles.tester.enabled && pre.roles.coder.access === "bypassPermissions", `the preset applied (name "${pre.name}", all roles on, Coder back to full access)`);

  // ---- library: save as ----
  await menuClick("#wfLibrary", "Save as");
  await promptFill("Smoke flow");
  let lib = await getActive();
  let entry = lib.library.find((e) => e.name === "Smoke flow");
  ok(!!entry && lib.active.savedId === entry.id && lib.active.name === "Smoke flow", `Save as… created the library entry "Smoke flow" (${entry && entry.id}) and the active workflow points at it`);
  const headName = await win.evaluate(() => ({ name: document.querySelector("#wfName .wf-name-text").textContent, dirty: document.querySelector("#wfDirty").textContent }));
  ok(headName.name === "Smoke flow" && /saved/.test(headName.dirty), `the header shows the name and "${headName.dirty}"`);

  // ---- export → delete → import (needs the main-process service) ----
  const tmpFile = path.join(os.tmpdir(), "atomnano-wfstudio-export.json");
  fs.rmSync(tmpFile, { force: true });
  if (hasService && entry) {
    const ex = await win.evaluate((a) => window.atomnano.workflow.exportOne(a.id, a.p), { id: entry.id, p: tmpFile });
    let parsed = null; try { parsed = JSON.parse(fs.readFileSync(tmpFile, "utf8")); } catch { /* */ }
    ok(ex && ex.ok !== false && parsed && parsed.atomnanoWorkflow === 1 && parsed.name === "Smoke flow" && parsed.workflow && parsed.workflow.roles, `exportOne wrote ${tmpFile} (atomnanoWorkflow 1, name, roles)`);
    await menuClick("#wfLibrary", "Delete");
    await win.waitForSelector(".modal .btn-danger", { timeout: 5000 });
    await win.click(".modal .btn-danger");
    await win.waitForTimeout(400);
    lib = await getActive();
    ok(!lib.library.find((e) => e.id === entry.id), "Delete… removed the entry from the library");
    const im = await win.evaluate((p) => window.atomnano.workflow.importFile(p), tmpFile);
    await win.waitForTimeout(300);
    lib = await getActive();
    entry = lib.library.find((e) => e.name === "Smoke flow");
    ok(im && im.entry && entry && entry.id === im.entry.id, `importFile brought "Smoke flow" back (${entry && entry.id})`);
  } else {
    skip("export / delete / import through atomnano.workflow — the service is not in this build yet");
  }

  // ---- load it (through the Load ▸ menu) ----
  await win.click("#wfLibrary");
  await win.locator("#ctxMenu:not(.hidden) .ctx-item", { hasText: "Load" }).first().click();
  await win.waitForTimeout(200);
  await win.locator("#ctxMenu:not(.hidden) .ctx-item", { hasText: "Smoke flow" }).first().click();
  await win.waitForTimeout(450);
  lib = await getActive();
  ok(entry && lib.active.savedId === entry.id && lib.active.name === "Smoke flow" && lib.active.roles.tester.enabled === true, "Load ▸ Smoke flow made it the active workflow (savedId, name, roles)");

  // ---- unsaved marker after an edit, then rename ----
  await win.click(".wf-lane-ctl.coder .wf-lane-minus");
  await win.waitForTimeout(350);
  const dirty = await win.evaluate(() => document.querySelector("#wfDirty").textContent);
  ok(/unsaved/.test(dirty), `an edit after loading shows "${dirty}"`);
  await win.click("#wfName");
  await promptFill("Smoke flow renamed");
  lib = await getActive();
  const renamed = lib.library.find((e) => e.id === (entry && entry.id));
  ok(renamed && renamed.name === "Smoke flow renamed" && lib.active.name === "Smoke flow renamed", `Rename updated the library entry and the active name ("${lib.active.name}")`);
  const headAfter = await win.evaluate(() => document.querySelector("#wfName .wf-name-text").textContent);
  ok(headAfter === "Smoke flow renamed", "the header shows the new name");

  // ---- brief drawer + CLI popover open and close ----
  await win.click("#wfBrief");
  await win.waitForTimeout(500);
  const drawer = await win.evaluate(() => ({ open: !document.querySelector(".wf-drawer").classList.contains("hidden"), ta: !!document.querySelector(".wf-brief-ta"), pre: !!document.querySelector(".wf-brief-pre, .wf-note, .wf-loading") }));
  ok(drawer.open && drawer.ta && drawer.pre, "the Orchestrator brief drawer opens with the generated text (or the service's answer) and the override editor");
  await win.click("#wfCli");
  await win.waitForTimeout(300);
  const pop = await win.evaluate(() => ({ open: !!document.querySelector(".wf-pop"), cmds: document.querySelectorAll(".wf-pop .wf-code-line").length }));
  ok(pop.open && pop.cmds >= 8, `the CLI popover lists the commands (${pop.cmds})`);
  await win.keyboard.press("Escape");   // closes the popover
  await win.waitForTimeout(150);
  await win.keyboard.press("Escape");   // closes the drawer
  await win.waitForTimeout(150);
  const afterEsc = await win.evaluate(() => ({ pop: !!document.querySelector(".wf-pop"), drawer: !document.querySelector(".wf-drawer").classList.contains("hidden"), panel: !!document.querySelector(".wf-panel") }));
  ok(!afterEsc.pop && !afterEsc.drawer && afterEsc.panel, "Esc closes the popover, then the drawer, and the studio stays open");

  // ---- the chip ----
  const chip = await win.evaluate(() => { let el = document.getElementById("wfChip"); let made = false; if (!el && window.__wfMod) { el = window.__wfMod.workflowChip(); made = true; } if (!el) return null; el._refresh(); return { made, cls: el.className, text: el.textContent }; });
  ok(chip && /wf-chip/.test(chip.cls) && /^(Smoke flow renamed|Workflow off)$/.test(chip.text.trim()), `the composer chip renders "${chip && chip.text.trim()}"${chip && chip.made ? " — built directly, the composer has not placed it yet" : ""}`);

  // ---- the live layer, driven by the very events the main process sends (no model call): running → paused → done ----
  const liveA = await win.evaluate(async () => {
    const m = await import("./workflow/index.js"); const st = await import("./core/state.js");
    const sid = st.state.activeTabId; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { sid: !!sid, reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches };
    m.onWorkflowStage({ sessionId: sid, stage: "orchestrator", status: "running", provider: "anthropic", model: "m" });
    m.onWorkflowJob({ job: { id: "smoke-j1", kind: "role", role: "coder", parentId: sid, sessionId: null, task: "Implement the smoke feature", command: "", status: "running", startedTs: new Date(Date.now() - 5000).toISOString(), endedTs: null, durationMs: 0, provider: "anthropic", model: "claude-smoke", effort: "high", access: "bypassPermissions", agents: 3, result: "", exitCode: null, editedFiles: [], tokensIn: 0, tokensOut: 0, agentsLive: { running: 2, total: 3 }, from: "cli", error: "" } });
    await wait(450);
    out.primaryRunning = !!document.querySelector('.wf-nodeg[data-role="orchestrator"].running');
    out.coderRunning = !!document.querySelector('.wf-nodeg[data-role="coder"].running');
    out.particles = document.querySelectorAll(".wf-particles.coder .wf-particle").length;
    out.orbs = document.querySelectorAll(".wf-orb").length;
    out.status = (document.querySelector('.wf-nodeg[data-role="coder"] .wf-status-text') || {}).textContent || "";
    out.counters = [...document.querySelectorAll('.wf-nodeg[data-role="coder"] .wf-count-chip')].map((c) => c.textContent.replace(/\s+/g, " ").trim());
    out.chip = (document.getElementById("wfChip") || {}).textContent || "";
    out.headerLive = (document.getElementById("wfLive") || {}).textContent || "";
    out.jobRows = document.querySelectorAll(".wf-inspector .wf-job").length; out.stopBtn = !!document.querySelector(".wf-inspector .wf-job .wf-ibtn.danger");
    const p = document.querySelector(".wf-particles.coder .wf-particle"); const c0 = p && p.getAttribute("cx");
    await wait(300);
    out.moved = !!(p && p.getAttribute("cx") !== c0);
    return out;
  });
  ok(liveA.sid && liveA.primaryRunning && liveA.coderRunning, "an orchestrator stage + a running coder job light up the Orchestrator and the Coder nodes");
  if (liveA.reduced) skip("particles — this machine prefers reduced motion"); else ok(liveA.particles === 7 && liveA.moved, `the Orchestrator → Coder edge streams ${liveA.particles} particles and they move`);
  ok(liveA.orbs === 2, `the Coder shows ${liveA.orbs} live sub-agent orbs (agentsLive.running)`);
  ok(/^running · \d+s$/.test(liveA.status.trim()), `the Coder node reads "${liveA.status}" (state + elapsed; the agent numbers are the counter chips)`);
  ok(liveA.counters && liveA.counters[0] === "2 running" && liveA.counters[1] === "3 used", `the Coder card's counter chips read "${(liveA.counters || []).join('" · "')}" (agents running now · used so far in this session)`);
  ok(/coder · 2 agents/.test(liveA.chip) && /coder · 2 agents/.test(liveA.headerLive), `the chip and the header show the live stage ("${liveA.chip.trim()}")`);
  ok(liveA.jobRows === 1 && liveA.stopBtn, "the inspector lists the running job with a Stop button");

  // ---- screenshot, mid-run ----
  fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(ROOT, "test-results", "workflow-studio.png") });
  console.log("screenshot: test-results/workflow-studio.png");

  const liveB = await win.evaluate(async () => {
    const m = await import("./workflow/index.js"); const st = await import("./core/state.js");
    const sid = st.state.activeTabId; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const out = {};
    m.onWorkflowJob({ job: { id: "smoke-j1", role: "coder", parentId: sid, status: "running", paused: "offline" } });
    await wait(300);
    out.paused = !!document.querySelector('.wf-nodeg[data-role="coder"].paused');
    out.pausedText = (document.querySelector('.wf-nodeg[data-role="coder"] .wf-status-text') || {}).textContent || "";
    out.pausedPill = (document.querySelector(".wf-inspector .wf-job .wf-pill") || {}).textContent || "";
    m.onWorkflowJob({ job: { id: "smoke-j1", role: "coder", parentId: sid, status: "done", paused: null, endedTs: new Date().toISOString(), durationMs: 5300, result: "ok" } });
    m.onWorkflowStage({ sessionId: sid, stage: "orchestrator", status: "done", provider: "anthropic", model: "m" });
    await wait(400);
    out.badge = document.querySelectorAll(".wf-badge.done").length;
    out.coderDone = !!document.querySelector('.wf-nodeg[data-role="coder"].done') && !document.querySelector('.wf-nodeg[data-role="coder"].running');
    out.particlesAfter = document.querySelectorAll(".wf-particles.coder .wf-particle").length;
    out.orbsAfter = document.querySelectorAll(".wf-orb").length;
    out.doneText = (document.querySelector('.wf-nodeg[data-role="coder"] .wf-status-text') || {}).textContent || "";
    out.jobsFor = m.workflowJobsFor(sid).length;
    out.chip = (document.getElementById("wfChip") || {}).textContent || "";
    return out;
  });
  ok(liveB.paused && /paused · offline/.test(liveB.pausedText) && /paused/.test(liveB.pausedPill), `a paused job shows on the node ("${liveB.pausedText}") and its pill ("${liveB.pausedPill}")`);
  ok(liveB.coderDone && liveB.badge >= 1 && liveB.particlesAfter === 0 && liveB.orbsAfter === 0 && /done · 5s/.test(liveB.doneText), `the finished job leaves a check badge, stops the particles and orbs, and the node reads "${liveB.doneText}"`);
  ok(liveB.jobsFor === 1 && liveB.chip.trim() === "Smoke flow renamed", `workflowJobsFor(session) has the job and the chip is back to the name ("${liveB.chip.trim()}")`);

  // ---- Esc closes the studio ----
  await win.keyboard.press("Escape");
  await win.waitForTimeout(250);
  ok(!(await win.evaluate(() => !!document.querySelector(".wf-panel"))), "Esc closes the studio");
  if (!hasService && entry) {
    await win.evaluate(() => (window.__openWorkflow ? window.__openWorkflow() : window.__wfMod.openWorkflowStudio()));
    await win.waitForSelector(".wf-panel", { timeout: 8000 });
    await win.waitForTimeout(300);
    await menuClick("#wfLibrary", "Delete");
    await win.waitForSelector(".modal .btn-danger", { timeout: 5000 });
    await win.click(".modal .btn-danger");
    await win.waitForTimeout(400);
    lib = await getActive();
    ok(!lib.library.find((e) => e.id === entry.id), "Delete… removed the entry from the library (fallback store)");
    await win.keyboard.press("Escape");
  }
  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  srv.close();
  clearTimeout(watchdog);
  console.log(process.exitCode ? "\nWORKFLOW STUDIO SMOKE FAILED" : "\nWORKFLOW STUDIO SMOKE PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
