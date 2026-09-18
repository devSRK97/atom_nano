"use strict";
/* The Workflow studio's Skills modal, run for real: src/renderer/workflow/model.js + studio.js WHOLE, with the real
 * h() / openModal() / modalShell() / closeModal() / confirmDialog() of core/dom.js and the real toggle() of
 * settings/controls.js, in a vm against the fake DOM of scripts/lib/fake-dom.js, a fake `state` (two tabs with their
 * own workflows, a project default) and a fake `atom` whose skills / workflow IPCs return DEFERRED promises the
 * tests resolve — or reject — in the order they choose. openSkillsModal() is opened, its checkboxes get real
 * `change` events, Remove goes through the real confirm dialog, Done through the real close path, and the suite
 * asserts what reached the service, in which order, and what the renderer state looks like after each reply:
 *   · writes run one at a time — a second tick is not issued until the first reply is in, and it is computed from
 *     that reply (the modal's RETAINED copy of the captured tab's workflow), so it never clobbers the first
 *   · a reply that lands after a tab switch lands on the tab the modal was opened for; the new tab, the project
 *     default and what the active tab shows are untouched; nothing re-renders for the new tab
 *   · a reply that lands after the modal closed still lands on that tab (the service has it) — only the modal's own
 *     follow-up (rows, toast, checkbox) is dropped
 *   · an action STARTED after the tab or project changed — or after the tab closed — is refused with the STALE note
 *     and no IPC
 *   · a reply that lands after the captured tab CLOSED is dropped: never a project-scoped write, whatever the reply
 *     says its scope is (re-review 2026-09-18: it used to fall through to state.settings.workflow)
 *   · every skills write carries the CAPTURED project as the set's cwd (round 3, 2026-09-18): a no-tab Remove whose
 *     skills IPC resolves after a project switch is written for the project it was started in — main honours an
 *     explicit cwd — and its reply is dropped there; the new project's settings never take it
 *   · the library actions (Save as, Load, Rename, …) capture the tab and the project BEFORE their IPC and mirror
 *     the reply onto THAT tab only — a Save As for tab A resolved after a switch to B leaves B's workflow, what B
 *     shows, the repaint and the toast alone (round 3, 2026-09-18: takeResult mirrored onto the active tab)
 *   · every library IPC carries the CAPTURED project as its trailing cwd (round 4, 2026-09-18): with no tab open, a
 *     Save as / Clone / Rename / Delete / Load whose dialog — the held promptDialog, or the REAL confirm dialog — is
 *     still up when the user switches projects goes out for the project it was started in, and its reply is dropped
 *     there; the new project's settings, what the studio shows and the library take nothing
 *   · the follow-up re-pull validates its captured scope INSIDE pullWorkflow, before any mutation (round 4): a get
 *     for tab A answered after a switch to B lands on A's own copy only; one for a tab that closed, a tab that is
 *     another project's by then, or a project no longer current is dropped whole — workflow:get is a deferred IPC here
 *   · legacy "suggested" skill records are rows (flagged legacy), never dropped — they count toward main's limit
 * `node scripts/test-workflow-ui.js --mutants` additionally re-runs the suite against deliberately damaged copies
 * of the module source (serial() replaced by direct calls, the sameScope() / M.open guards removed, the cwd dropped
 * from the write, takeResult mirroring onto the active tab, the library IPCs' cwd dropped, pullWorkflow mirroring
 * before its scope check, …) and reports which test kills each — a mutant that survives fails the run. A test that
 * never settles fails after TEST_TIMEOUT_MS instead of ending the process silently.
 * Run: node scripts/test-workflow-ui.js */
const assert = require("node:assert/strict");
const vm = require("node:vm");
const R = require("./lib/renderer-src");
const D = require("./lib/fake-dom");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
// values built INSIDE the vm carry its realm's prototypes — deepStrictEqual would reject them; compare their shape
const J = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const eq = (a, b, msg) => assert.deepEqual(J(a), J(b), msg);
const results = { passed: 0, failed: [] };
let quiet = false;
/* A test that never settles FAILS (round 4, 2026-09-18) instead of ending the process silently: every IPC here is a
 * deferred the test answers, so an await on one the test did not expect — a follow-up get for a scope that left the
 * screen, say — would otherwise drain the event loop and exit 0 with no summary and no exit code (the mutant that
 * unguards the library follow-ups did exactly that once workflow:get became deferred). The timer keeps the loop
 * alive; the race lets the test's own promise reject later without an unhandled rejection. */
const TEST_TIMEOUT_MS = 3000;
async function check(name, fn) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${TEST_TIMEOUT_MS} ms — an await never settled (an IPC the test did not expect, so never answered?)`)), TEST_TIMEOUT_MS); });
  try { await Promise.race([fn(), timeout]); results.passed++; if (!quiet) console.log("PASS " + name); }
  catch (e) { results.failed.push({ name, error: e }); if (!quiet) { console.log("FAIL " + name); console.error(e); } }
  finally { clearTimeout(timer); }
}

/* ============================ what runs in the vm ============================ */
let MUTATE = null;   // --mutants: (source) => damaged source
function sources() {
  const prelude = "const $ = (id) => document.getElementById(id);\n" + ["h", "openModal", "closeModal", "modalShell", "confirmDialog", "toggle"].map(R.fn).join("\n");
  const src = R.moduleSource("workflow/model.js") + "\n" + R.moduleSource("workflow/studio.js");
  return prelude + "\n" + (MUTATE ? MUTATE(src) : src);
}
const SKILLS = [{ id: "X", name: "Skill X", description: "the first" }, { id: "Y", name: "Skill Y" }, { id: "Z", name: "Skill Z" }];
/* Two tabs, A (active) and B, each with its OWN workflow carrying X and Y on the Coder and X on the Reviewer; the
 * project default carries P on the Coder — so a patch computed from the wrong workflow is visible in the set. */
function fixture() {
  const own = () => ({ enabled: true, name: "Own", roles: { coder: { skills: ["X", "Y"] }, reviewer: { skills: ["X"] } } });
  const project = () => ({ enabled: false, name: "Project default", roles: { coder: { skills: ["P"] } } });
  const tabA = { meta: { id: "A", cwd: "C:/p" }, wfOwn: own() }, tabB = { meta: { id: "B", cwd: "C:/p" }, wfOwn: own() };
  const state = { tabs: new Map([["A", tabA], ["B", tabB]]), activeTabId: "A", order: ["A", "B"], project: "C:/p", settings: { workflow: project(), workflows: [], skillInstallMode: "git" }, workflow: { active: null, library: [], stages: new Map(), jobs: new Map() } };
  const doc = D.createDocument(); const root = doc.createElement("div"); root.id = "modalRoot"; doc.body.append(root);
  const toasts = [], rerenders = [];
  // every IPC: recorded with its arguments, answered by a deferred the test settles (the workflow IPCs — get / save /
  // load / rename / delete — are `wf*`; workflow:get is deferred like the rest since round 4, 2026-09-18: a get
  // that answered {} at once could not show what a reply landing after a tab or project switch does)
  const NAMES = ["list", "remove", "set", "importUrl", "create", "wfGet", "wfSave", "wfLoad", "wfRename", "wfRemove"];
  const calls = Object.fromEntries(NAMES.map((n) => [n, []])), pending = Object.fromEntries(NAMES.map((n) => [n, []]));
  const io = (name) => (...args) => { const d = deferred(); calls[name].push(args); pending[name].push(d); return d.promise; };
  const atom = { settings: { set: async () => {} }, skills: { list: io("list"), remove: io("remove"), importUrl: io("importUrl"), create: io("create") }, workflow: { get: io("wfGet"), set: io("set"), save: io("wfSave"), load: io("wfLoad"), rename: io("wfRename"), remove: io("wfRemove") } };
  const dlg = { prompt: async () => null };   // promptDialog's answer — a test sets dlg.prompt before it starts a Save as / Rename
  const context = vm.createContext({
    state, atom, document: doc, Event: D.Event, window: { innerWidth: 1200, innerHeight: 800 }, Map, Set, Promise, console, setTimeout, clearTimeout, setInterval, clearInterval,
    toast: (t) => toasts.push(String(t)), promptDialog: (...a) => dlg.prompt(...a), copyText: async () => {}, showContextMenu() {},
    icon: (name) => `<i data-icon="${name}"></i>`, runInTerminal: async () => {},
    PRESETS: [], presetPatch: () => ({}), applyLive() {}, buildCanvas: () => null, fitView() {}, renderCanvas() {}, buildInspector: () => null, codeLines: () => null, renderInspector() {}, renderInspectorJobs() {}, fmtSpan: () => "", stageSummary: () => "",
  });
  vm.runInContext(sources(), context, { filename: "workflow-ui.vm.js" });
  // `const` bindings of a script are not properties of the vm's global — read them out of the context
  const K = vm.runInContext("({ S, LEGACY_SKILL_BADGE, LEGACY_SKILL_TITLE, STALE_RE: /close this dialog and open Skills again/ })", context);
  K.S.rerender = (parts) => rerenders.push(parts);
  state.workflow.active = context.tabWorkflow("A");
  const sets = () => calls.set.map(([patch, cwd, sid]) => ({ patch, cwd, sid }));
  // what main answers for a session set: that tab's workflow with the patch merged (`base` when the tab is gone)
  const reply = (sid, patch, base) => ({ active: context.deepMerge(base || context.sessionWorkflow(sid), patch), scope: "session" });
  const scopeFor = (sid) => ({ sid, cwd: "C:/p", wf: context.sessionWorkflow(sid) });
  const snapshot = () => ({ settings: J(state.settings.workflow), active: J(state.workflow.active), B: J(tabB.wfOwn) });
  // the user switches to tab B — and, when asked, to another project (its settings replace the project default)
  const switchTo = (sid, project) => { state.activeTabId = sid; if (project) { state.project = project; state.settings.workflow = { enabled: true, name: "Other project", roles: { coder: { skills: ["Q"] } } }; } state.workflow.active = context.tabWorkflow(sid); };
  // the studio with NO tab open, in project "C:/A" whose active workflow is the fixture's A copy (X, Y on the Coder, X on the Reviewer)
  const noTab = () => { state.tabs.clear(); state.order = []; state.activeTabId = null; state.project = "C:/A"; state.settings = { workflow: own(), workflows: [], skillInstallMode: "git" }; state.workflow.active = context.projectWorkflow(); };
  // what workspace/projects.js switchProjectInPlace does: state.project moves, state.settings is REPLACED by the new project's (here: B's, with X attached everywhere it can be), the tabs are cleared
  const switchProject = (project, workflow) => { state.project = project; state.settings = { workflow: workflow || { enabled: true, name: "B default", roles: { planner: { skills: ["X"] }, coder: { skills: ["X", "Q"] }, reviewer: { skills: ["X"] } } }, workflows: [], skillInstallMode: "git" }; state.tabs.clear(); state.order = []; state.activeTabId = null; state.workflow.active = context.projectWorkflow(); };
  // noTab() with the project's workflow SAVED as the library entry "wf-1" — its design differs from the saved one (dirty), so Load asks first; Rename and Delete have an entry to address
  const noTabSaved = () => { noTab(); state.settings.workflow.savedId = "wf-1"; state.workflow.library = [{ id: "wf-1", name: "Own", workflow: {} }]; state.settings.workflows = state.workflow.library; state.workflow.active = context.projectWorkflow(); };
  // promptDialog HELD open: the test answers it (`d.resolve(name)`, or null for Cancel) when it chooses — after a project switch, say
  const holdPrompt = () => { const d = deferred(); dlg.prompt = () => d.promise; return d; };
  // the REAL confirm dialog on top (#modalRoot) whose text matches `re` — the test clicks its confirm button (.btn-primary, .btn-danger for a destructive one)
  const confirmOnTop = (re) => { const dialogs = doc.querySelectorAll("#modalRoot > .modal-backdrop"); const back = dialogs[dialogs.length - 1]; assert.ok(back && re.test(back.textContent), "the confirm dialog is up: " + re); return back; };
  // what nothing of the OLD scope may have touched once the project (or tab) switched: the settings' workflow, what the studio shows, B's copy, the library and its settings mirror
  const frozen = () => ({ ...snapshot(), library: J(state.workflow.library), workflows: J(state.settings.workflows) });
  return { context, K, state, tabA, tabB, doc, toasts, rerenders, calls, pending, atom, dlg, sets, reply, scopeFor, snapshot, switchTo, noTab, switchProject, noTabSaved, holdPrompt, confirmOnTop, frozen };
}
const coderSkills = (ctx, sid) => ctx.tabWorkflow(sid).roles.coder.skills;
const reviewerSkills = (ctx, sid) => ctx.tabWorkflow(sid).roles.reviewer.skills;
const plannerSkills = (ctx, sid) => ctx.tabWorkflow(sid).roles.planner.skills;
/* ---- driving the modal ---- */
async function openSkills(e, skills = SKILLS) {
  const p = e.context.openSkillsModal(); await tick();
  assert.equal(e.calls.list.length, 1, "the modal asks main for this project's skills once");
  e.pending.list[0].resolve(skills.map((s) => ({ ...s })));
  const back = await p; await tick();
  return back;
}
// `root` for a modal that is no longer in the document (closed) — the elements live on
const cbOf = (e, id, role, root = e.doc) => { const cb = root.querySelector(`.wf-skills-row.skill[data-id="${id}"] .wf-skills-col.${role} input`); assert.ok(cb, `checkbox ${id} × ${role}`); return cb; };
const flip = (cb, want) => { cb.checked = want; cb.dispatchEvent(new D.Event("change", { bubbles: true })); };   // what a click on a checkbox does
const statusOf = (back) => back.querySelector(".wf-skills-status");
const rowIds = (back) => [...back.querySelectorAll(".wf-skills-rows .wf-skills-row")].map((r) => r.dataset.id);
const doneOf = (back) => back.querySelector(".modal-foot button");
// Remove → the REAL confirm dialog (a second modal in #modalRoot) → its danger button
async function clickRemove(e, id) {
  e.doc.querySelector(`.wf-skills-row.skill[data-id="${id}"] .wf-skills-remove`).click(); await tick();
  const dialogs = e.doc.querySelectorAll("#modalRoot > .modal-backdrop"); const confirm = dialogs[dialogs.length - 1];
  assert.ok(dialogs.length === 2 && /Remove this skill\?/.test(confirm.textContent), "the confirm dialog is on top of the modal");
  confirm.querySelector(".btn-danger").click(); await tick();
  assert.ok(!confirm.isConnected, "the confirm dialog closed");
}

/* ============================ the suite ============================ */
async function suite() {
  await check("open: the real modal, built with h()/modalShell() on the fake DOM, shows the loading state until the deferred skills list resolves, then one row per skill with the ticks of tab A's workflow", async () => {
    const e = fixture(), c = e.context;
    const p = c.openSkillsModal(); await tick();
    eq(e.calls.list, [["C:/p"]]);
    const back0 = e.doc.querySelector("#modalRoot > .modal-backdrop"); assert.ok(back0, "the modal is mounted in #modalRoot");
    assert.ok(!statusOf(back0).classList.contains("hidden") && /Loading this project's skills/.test(statusOf(back0).textContent), "loading is shown");
    eq([...back0.querySelectorAll(".wf-skills-row.head .wf-skills-col")].map((h) => h.textContent), ["Planner", "Coder", "Reviewer"]);
    e.pending.list[0].resolve(SKILLS.map((s) => ({ ...s })));
    const back = await p; await tick();
    assert.equal(back, back0);
    assert.ok(statusOf(back).classList.contains("hidden"), "loading is gone");
    eq(rowIds(back), ["X", "Y", "Z"]);
    eq([cbOf(e, "X", "planner").checked, cbOf(e, "X", "coder").checked, cbOf(e, "X", "reviewer").checked], [false, true, true]);
    eq([cbOf(e, "Y", "coder").checked, cbOf(e, "Y", "reviewer").checked, cbOf(e, "Z", "coder").checked], [true, false, false]);
    assert.equal(back.querySelectorAll(".wf-skills-remove").length, 3);
    assert.equal(e.sets().length, 0); eq(e.rerenders, []); eq(e.toasts, []);
  });
  await check("queue order: two quick ticks are serialized — the second set is not issued until the first reply is in, and it is computed from that reply (the retained copy), so the first tick is kept; a rejected first write flips its box back and does not block the second", async () => {
    const e = fixture(), c = e.context;
    await openSkills(e);
    const zP = cbOf(e, "Z", "planner"), yP = cbOf(e, "Y", "planner");
    flip(zP, true); flip(yP, true); await tick();
    eq(e.sets(), [{ patch: { roles: { planner: { skills: ["Z"] } } }, cwd: "C:/p", sid: "A" }], "only the first write is in flight — for the captured tab and its project");
    assert.ok(zP.disabled && yP.disabled, "both boxes wait");
    e.pending.set[0].resolve(e.reply("A", e.sets()[0].patch)); await tick();
    assert.equal(e.sets().length, 2, "the second write went out once the first reply landed");
    eq(e.sets()[1], { patch: { roles: { planner: { skills: ["Z", "Y"] } } }, cwd: "C:/p", sid: "A" }, "computed from the reply: Z is kept");
    assert.ok(!zP.disabled && zP.checked && yP.disabled, "the first box is released, the second still waits");
    eq(e.rerenders, [{ canvas: true, inspector: true, header: false }], "the studio (showing A) repainted once for the first write");
    e.pending.set[1].resolve(e.reply("A", e.sets()[1].patch)); await tick();
    eq(plannerSkills(c, "A"), ["Z", "Y"]); eq(plannerSkills(c, "B"), []); eq(e.state.settings.workflow.roles.coder.skills, ["P"]);
    assert.ok(!yP.disabled && yP.checked); assert.equal(e.rerenders.length, 2); eq(e.toasts, []);
    // a rejected first write: its box flips back, the next write still goes out (from the copy the failure left alone)
    const xP = cbOf(e, "X", "planner"), yC = cbOf(e, "Y", "coder");
    flip(xP, true); flip(yC, false); await tick();
    assert.equal(e.sets().length, 3); eq(e.sets()[2].patch, { roles: { planner: { skills: ["Z", "Y", "X"] } } });
    e.pending.set[2].reject(new Error("service down")); await tick();
    assert.ok(e.toasts.some((t) => /service down/.test(t)), "the failure is toasted"); assert.equal(e.toasts.length, 1);
    assert.ok(!xP.checked && !xP.disabled, "the failed tick is undone on its box");
    assert.equal(e.sets().length, 4, "the second write was not blocked"); eq(e.sets()[3].patch, { roles: { coder: { skills: ["X"] } } });
    e.pending.set[3].resolve(e.reply("A", e.sets()[3].patch)); await tick();
    eq(coderSkills(c, "A"), ["X"]); eq(plannerSkills(c, "A"), ["Z", "Y"]); assert.ok(!yC.checked && !yC.disabled);
    assert.equal(e.rerenders.length, 3, "no repaint for the failed write");
  });
  await check("Done while a tick is in flight, then a switch to B: the reply still lands on the captured tab A (the service has it) — B, the project default and what B shows are untouched, nothing re-renders, and the modal's own follow-up is dropped (no toast, the box is left as it was)", async () => {
    const e = fixture(), c = e.context;
    const back = await openSkills(e);
    const zC = cbOf(e, "Z", "coder"); flip(zC, true); await tick();
    assert.equal(e.sets().length, 1);
    doneOf(back).click(); await tick();
    assert.ok(!back.isConnected && !e.doc.querySelector(".modal-backdrop"), "Done closed the modal");
    e.switchTo("B"); const before = e.snapshot();
    e.pending.set[0].resolve(e.reply("A", e.sets()[0].patch)); await tick();
    eq(coderSkills(c, "A"), ["X", "Y", "Z"], "A took the tick"); eq(coderSkills(c, "B"), ["X", "Y"]);
    eq(e.snapshot(), before, "B, the project default and state.workflow.active are as they were");
    eq(e.rerenders, []); eq(e.toasts, []);
    assert.ok(zC.disabled && zC.checked, "the closed modal's box was not touched by the reply");
    // an action on the closed modal's elements does nothing
    flip(cbOf(e, "Y", "planner", back), true); await tick(); assert.equal(e.sets().length, 1);
  });
  await check("Done while a tick is in flight, A still active: A takes the reply and the studio behind repaints once for A; no toast, no row redraw", async () => {
    const e = fixture(), c = e.context;
    const back = await openSkills(e);
    const zC = cbOf(e, "Z", "coder"); flip(zC, true); await tick();
    const rows = [...back.querySelectorAll(".wf-skills-rows .wf-skills-row")];
    doneOf(back).click(); await tick();
    e.pending.set[0].resolve(e.reply("A", e.sets()[0].patch)); await tick();
    eq(coderSkills(c, "A"), ["X", "Y", "Z"]); eq(e.state.workflow.active.roles.coder.skills, ["X", "Y", "Z"], "what the active tab A shows follows");
    eq(e.rerenders, [{ canvas: true, inspector: true, header: false }]); eq(e.toasts, []);
    eq([...back.querySelectorAll(".wf-skills-rows .wf-skills-row")].map((r, i) => r === rows[i]), rows.map(() => true), "the rows were not rebuilt");
  });
  await check("Detach (an attached id no installed skill matches) with the modal closed before the reply: the set carried A's id and A's copy, A is patched, no 'Detached' toast, no row redraw", async () => {
    const e = fixture(), c = e.context;
    const back = await openSkills(e, SKILLS.filter((s) => s.id !== "Y"));   // Y is attached to the Coder but not installed → an "Unavailable skill" row
    eq(rowIds(back), ["X", "Z", "Y"]);
    const missing = back.querySelector('.wf-skills-row.missing[data-id="Y"]'); assert.ok(missing && /Unavailable skill/.test(missing.textContent));
    missing.querySelector(".wf-skills-detach").click(); await tick();
    eq(e.sets(), [{ patch: { roles: { coder: { skills: ["X"] } } }, cwd: "C:/p", sid: "A" }]);
    const rows = [...back.querySelectorAll(".wf-skills-rows .wf-skills-row")];
    doneOf(back).click(); await tick();
    e.pending.set[0].resolve(e.reply("A", e.sets()[0].patch)); await tick();
    eq(coderSkills(c, "A"), ["X"]); eq(coderSkills(c, "B"), ["X", "Y"]);
    eq(e.toasts, [], "no 'Detached' toast for a closed modal");
    eq([...back.querySelectorAll(".wf-skills-rows .wf-skills-row")].map((r, i) => r === rows[i]), rows.map(() => true), "the rows were not rebuilt");
    eq(e.rerenders, [{ canvas: true, inspector: true, header: false }], "the studio (still showing A) repainted");
  });
  await check("Remove with the skills IPC in flight while the user switches to tab B AND another project: the follow-up set carries A's id and a patch from A's retained copy, lands on A only — B, the new project's default and what B shows are untouched, nothing re-renders", async () => {
    const e = fixture(), c = e.context;
    await openSkills(e);
    await clickRemove(e, "X");
    eq(e.calls.remove, [["C:/p", "X"]]); assert.equal(e.sets().length, 0, "the workflow is not touched before the skill is gone");
    e.switchTo("B", "D:/q"); const before = e.snapshot();
    e.pending.remove[0].resolve(true); await tick();
    eq(e.sets(), [{ patch: { roles: { coder: { skills: ["Y"] }, reviewer: { skills: [] } } }, cwd: "C:/p", sid: "A" }], "the set is for the captured tab and ITS project, from ITS workflow (not the project's [P] / [Q])");
    e.pending.set[0].resolve(e.reply("A", e.sets()[0].patch)); await tick();
    eq(coderSkills(c, "A"), ["Y"]); eq(reviewerSkills(c, "A"), []);
    eq(coderSkills(c, "B"), ["X", "Y"]); eq(reviewerSkills(c, "B"), ["X"]);
    eq(e.snapshot(), before, "B, the new project's default and state.workflow.active are as they were");
    eq(e.rerenders, [], "no re-render while another tab is active");
    eq(e.toasts, ['Removed "Skill X"'], "the removal itself is reported (the modal is still open)");
    assert.equal(e.calls.list.length, 2, "the list is reloaded");
  });
  await check("an action STARTED after the scope changed is refused: the STALE note, the box flips back, no set and no skills IPC — for a tab switch, a project switch, and a captured tab that is gone while still named active", async () => {
    const e = fixture(), c = e.context;
    const back = await openSkills(e);
    const sets0 = e.sets().length, removes0 = e.calls.remove.length;
    const stale = () => { const st = statusOf(back); return !st.classList.contains("hidden") && e.K.STALE_RE.test(st.textContent); };
    // a tab switch
    e.switchTo("B");
    const zC = cbOf(e, "Z", "coder"); flip(zC, true); await tick();
    assert.ok(stale(), "the STALE note is shown"); assert.ok(!zC.checked && !zC.disabled, "the box flipped back"); assert.equal(e.sets().length, sets0);
    e.doc.querySelector('.wf-skills-row.skill[data-id="Y"] .wf-skills-remove').click(); await tick();
    e.doc.querySelectorAll("#modalRoot > .modal-backdrop")[1].querySelector(".btn-danger").click(); await tick();
    assert.equal(e.calls.remove.length, removes0, "Remove after the switch sends no skills IPC"); assert.ok(stale());
    // back on A — the same tab and project — the modal works again
    e.switchTo("A"); flip(zC, true); await tick();
    assert.equal(e.sets().length, sets0 + 1); e.pending.set[sets0].resolve(e.reply("A", e.sets()[sets0].patch)); await tick(); eq(coderSkills(c, "A"), ["X", "Y", "Z"]);
    // the project changes under the SAME tab (projects.js keeps the tabs; a tab's cwd is its own): the scope is the
    // tab's session and the tab's project, so the modal keeps working — its skills and its workflow are still the tab's
    e.switchTo("A", "D:/q"); const yR = cbOf(e, "Y", "reviewer"); flip(yR, true); await tick();
    assert.equal(e.sets().length, sets0 + 2, "the same tab keeps its scope through a project switch"); eq(e.sets()[sets0 + 1], { patch: { roles: { reviewer: { skills: ["X", "Y"] } } }, cwd: "C:/p", sid: "A" }, "the tab's own project, not the window's new one");
    e.pending.set[sets0 + 1].resolve(e.reply("A", e.sets()[sets0 + 1].patch)); await tick(); eq(reviewerSkills(c, "A"), ["X", "Y"]);
    assert.ok(!stale() && statusOf(back).classList.contains("hidden"), "back in the captured scope, a working action clears the lingering STALE note");
    // the captured tab is gone but state.activeTabId still names it (a close in progress) — with the project back at the
    // captured one, so that ONLY the "tab still exists" check can refuse (skillsScope falls back to state.project for the cwd)
    e.state.tabs.delete("A"); e.state.project = "C:/p"; e.state.workflow.active = c.tabWorkflow("B");
    flip(yR, false); await tick();
    assert.equal(e.sets().length, sets0 + 2, "no set for a tab that is gone"); assert.ok(yR.checked && !yR.disabled && stale(), "flipped back, STALE");
    eq(e.state.settings.workflow.roles.coder.skills, ["Q"], "the (new) project default is untouched throughout"); eq(coderSkills(c, "B"), ["X", "Y"]);
  });
  await check("the captured tab CLOSES (and the project switches) while a Remove's skills IPC is in flight: the detach still goes out for session A — main knows the session — with the CAPTURED project as its cwd, from A's retained copy, but its reply, even one claiming scope 'project', is dropped: the new project's default, state.workflow.active and B are untouched, no tab is resurrected, nothing re-renders", async () => {
    const e = fixture(), c = e.context;
    await openSkills(e);
    await clickRemove(e, "X");
    const aCopy = J(c.sessionWorkflow("A"));
    e.state.tabs.delete("A"); e.switchTo("B", "D:/q"); const before = e.snapshot();
    e.pending.remove[0].resolve(true); await tick();
    eq(e.sets(), [{ patch: { roles: { coder: { skills: ["Y"] }, reviewer: { skills: [] } } }, cwd: "C:/p", sid: "A" }], "the set carries the captured sid AND the captured project (not D:/q, current by now) and a patch from A's copy — not from the project's workflow");
    e.pending.set[0].resolve({ active: { ...c.deepMerge(aCopy, e.sets()[0].patch), name: "HOSTILE" }, scope: "project" }); await tick();
    eq(e.snapshot(), before, "nothing project-scoped was written and B is untouched");
    assert.ok(!e.state.tabs.has("A"), "no tab was resurrected");
    assert.ok(!/HOSTILE/.test(JSON.stringify([e.state.settings, e.state.workflow, e.tabB])), "the late reply reached nothing in the renderer");
    eq(e.rerenders, []);
    eq(e.toasts, ['Removed "Skill X"']);
  });
  await check("the captured tab CLOSES while a tick's set is in flight: the reply is dropped — no project write, no state.workflow.active write, no re-render, no toast — and the next action is refused", async () => {
    const e = fixture(), c = e.context;
    const back = await openSkills(e);
    const zC = cbOf(e, "Z", "coder"); flip(zC, true); await tick();
    assert.equal(e.sets().length, 1);
    e.state.tabs.delete("A"); e.switchTo("B", "D:/q"); const before = e.snapshot();
    e.pending.set[0].resolve({ active: { enabled: true, name: "HOSTILE", roles: { coder: { skills: ["X", "Y", "Z"] } } }, scope: "project" }); await tick();
    eq(e.snapshot(), before); eq(e.rerenders, []); eq(e.toasts, []);
    assert.ok(!e.state.tabs.has("A") && !/HOSTILE/.test(JSON.stringify([e.state.settings, e.state.workflow, e.tabB])));
    assert.ok(zC.checked && !zC.disabled, "the write went through for the session; the box is released");
    flip(cbOf(e, "Y", "planner"), true); await tick();
    assert.equal(e.sets().length, 1, "no further set"); assert.ok(e.K.STALE_RE.test(statusOf(back).textContent));
  });
  await check("no tab open: the modal edits the PROJECT's workflow (sid-less sets, mirrored into state.settings.workflow) — but a reply that lands after the project switched is dropped: the new project's settings and state.workflow.active are untouched, nothing re-renders, and the next action is refused", async () => {
    const e = fixture(), c = e.context;
    e.state.tabs.clear(); e.state.activeTabId = null; e.state.workflow.active = c.projectWorkflow();
    const back = await openSkills(e, [...SKILLS, { id: "P", name: "Skill P" }]);
    eq(rowIds(back), ["X", "Y", "Z", "P"]); assert.ok(cbOf(e, "P", "coder").checked && !cbOf(e, "X", "coder").checked, "the rows show the project's ticks");
    // the plain case: a project write lands in the project's settings and what the studio shows, and the studio repaints
    const pC = cbOf(e, "P", "coder"); flip(pC, false); await tick();
    eq(e.sets(), [{ patch: { roles: { coder: { skills: [] } } }, cwd: "C:/p", sid: undefined }], "a project-scoped set, for the captured project");
    e.pending.set[0].resolve({ active: c.deepMerge(c.projectWorkflow(), e.sets()[0].patch), scope: "project" }); await tick();
    eq(e.state.settings.workflow.roles.coder.skills, []); eq(e.state.workflow.active.roles.coder.skills, []); eq(e.rerenders, [{ canvas: true, inspector: true, header: false }]);
    // the project switches while a set is in flight (projects.js replaces state.settings): the reply is the OLD project's
    const zC = cbOf(e, "Z", "coder"); flip(zC, true); await tick();
    eq(e.sets()[1], { patch: { roles: { coder: { skills: ["Z"] } } }, cwd: "C:/p", sid: undefined });
    e.state.project = "D:/q"; e.state.settings = { workflow: { enabled: true, name: "Other project", roles: { coder: { skills: ["Q"] } } }, workflows: [] }; e.state.workflow.active = c.projectWorkflow();
    const before = e.snapshot();
    e.pending.set[1].resolve({ active: { enabled: true, name: "HOSTILE", roles: { coder: { skills: ["Z"] } } }, scope: "project" }); await tick();
    eq(e.snapshot(), before, "the new project's settings and state.workflow.active are untouched"); assert.ok(!/HOSTILE/.test(JSON.stringify([e.state.settings, e.state.workflow])));
    assert.equal(e.rerenders.length, 1, "no repaint for the dropped reply"); eq(e.toasts, []);
    assert.ok(zC.checked && !zC.disabled, "the write went through for the old project; the box is released");
    flip(cbOf(e, "Y", "planner"), true); await tick();
    assert.equal(e.sets().length, 2, "no further set"); assert.ok(e.K.STALE_RE.test(statusOf(back).textContent));
  });
  await check("no tab open, Remove with the skills IPC in flight while the user switches PROJECTS (state.settings replaced, the way projects.js does): the follow-up set carries the CAPTURED project as its cwd — main writes A, not the project current by then — and its reply is dropped: B's default keeps X on every role, state.workflow.active is untouched, nothing re-renders, the next action is refused", async () => {
    const e = fixture(), c = e.context;
    e.noTab();
    const back = await openSkills(e);
    eq(e.calls.list, [["C:/A"]], "the skills of the captured project");
    assert.ok(cbOf(e, "X", "coder").checked && cbOf(e, "X", "reviewer").checked && !cbOf(e, "X", "planner").checked, "the rows show the project's ticks");
    await clickRemove(e, "X");
    eq(e.calls.remove, [["C:/A", "X"]]); assert.equal(e.sets().length, 0, "the workflow is not touched before the skill is gone");
    e.switchProject("C:/B"); const before = e.snapshot();
    e.pending.remove[0].resolve(true); await tick();
    eq(e.sets(), [{ patch: { roles: { coder: { skills: ["Y"] }, reviewer: { skills: [] } } }, cwd: "C:/A", sid: undefined }], "a project-scoped set FOR THE CAPTURED PROJECT (main honours an explicit cwd), from A's retained copy — never for C:/B, current by now");
    e.pending.set[0].resolve({ active: { enabled: true, name: "A after the removal", roles: { coder: { skills: ["Y"] }, reviewer: { skills: [] } } }, scope: "project" }); await tick();
    eq(e.snapshot(), before, "B's settings and state.workflow.active are as they were");
    eq([e.state.settings.workflow.roles.planner.skills, e.state.settings.workflow.roles.coder.skills, e.state.settings.workflow.roles.reviewer.skills], [["X"], ["X", "Q"], ["X"]], "B keeps X on every role");
    assert.ok(!/A after the removal/.test(JSON.stringify([e.state.settings, e.state.workflow])), "A's reply reached nothing in the renderer");
    eq(e.rerenders, []);
    eq(e.toasts, ['Removed "Skill X"'], "the removal itself is reported (the modal is still open)");
    assert.equal(e.calls.list.length, 2, "the list is reloaded"); e.pending.list[1].resolve(SKILLS.filter((s) => s.id !== "X")); await tick();   // the reload must land first: while it loads, the status shows loading, not a note
    flip(cbOf(e, "Y", "planner"), true); await tick();
    assert.equal(e.sets().length, 1, "no further set"); assert.ok(e.K.STALE_RE.test(statusOf(back).textContent));
  });
  await check("Save as… for tab A with the save IPC in flight while the user switches to tab B: the reply lands on A's own workflow (name, savedId), B's workflow and what B shows are untouched, the library is mirrored (same project), no repaint and no 'this tab uses it' toast for B; the same save with A on screen repaints and toasts", async () => {
    const e = fixture(), c = e.context;
    e.dlg.prompt = async (o) => { assert.match(String(o.title), /Save workflow as/); return "Plan+Code"; };
    const p = c.saveAs(); await tick();
    eq(e.calls.wfSave, [["Plan+Code", undefined, "A", "C:/p"]], "the save is for the captured tab A — and carries its project (main ignores it with a session id)");
    e.switchTo("B"); const before = e.snapshot();
    const lib = [{ id: "wf-1", name: "Plan+Code", workflow: {} }];
    e.pending.wfSave[0].resolve({ library: lib, active: { ...J(c.sessionWorkflow("A")), name: "Plan+Code", savedId: "wf-1" }, entry: lib[0], scope: "session" });
    await p;
    assert.equal(e.tabA.wfOwn.name, "Plan+Code"); assert.equal(e.tabA.wfOwn.savedId, "wf-1"); eq(coderSkills(c, "A"), ["X", "Y"]);
    eq(e.snapshot(), before, "B, what B shows and the project default are as they were");
    assert.equal(e.tabB.wfOwn.name, "Own"); assert.equal(e.tabB.wfOwn.savedId, undefined);
    eq(e.state.workflow.library, lib, "the library is mirrored — same project"); eq(e.state.settings.workflows, lib);
    eq(e.rerenders, []); eq(e.toasts, []);
    // back on A the studio shows the saved workflow; a save that resolves with A still on screen repaints and toasts
    e.switchTo("A"); assert.equal(e.state.workflow.active.name, "Plan+Code");
    const p2 = c.saveAs(); await tick(); eq(e.calls.wfSave[1], ["Plan+Code", undefined, "A", "C:/p"]);
    e.pending.wfSave[1].resolve({ library: lib, active: { ...J(c.sessionWorkflow("A")), name: "Plan+Code", savedId: "wf-1" }, entry: lib[0], scope: "session" }); await p2;
    eq(e.rerenders, [{}]); eq(e.toasts, ['Saved as "Plan+Code" — this tab uses it']);
    // A CLOSES and the project switches before a third save's reply: dropped whole — the new project's settings, its library and B take nothing, no tab is resurrected
    const p3 = c.saveAs(); await tick(); eq(e.calls.wfSave[2], ["Plan+Code", undefined, "A", "C:/p"]);
    e.state.tabs.delete("A"); e.switchTo("B", "D:/q"); const b3 = e.snapshot(); e.rerenders.length = 0; e.toasts.length = 0;
    e.pending.wfSave[2].resolve({ library: [...lib, { id: "wf-2", name: "HOSTILE" }], active: { enabled: true, name: "HOSTILE", roles: {} }, entry: lib[0], scope: "project" }); await p3;
    eq(e.snapshot(), b3); assert.ok(!e.state.tabs.has("A")); assert.ok(!/HOSTILE/.test(JSON.stringify([e.state.settings, e.state.workflow, e.tabB])), "the late reply reached nothing");
    eq(e.rerenders, []); eq(e.toasts, []);
  });
  await check("Load for this tab with the load IPC in flight while the user switches to B: A takes the loaded design, B and what B shows are untouched, no re-pull, no repaint, no view reset, no toast; on screen it re-pulls, resets the view, repaints and toasts; the same load with NO tab, resolved after a PROJECT switch: the reply AND its library are dropped — the new project's settings are untouched", async () => {
    const e = fixture(), c = e.context;
    const entry = { id: "wf-9", name: "Reviewed", workflow: { roles: { coder: { skills: ["Z"] } } } };
    e.state.workflow.library = [entry];
    const p = c.loadEntry(entry); await tick();
    eq(e.calls.wfLoad, [["wf-9", "A", "C:/p"]], "the load is for the captured tab A (and carries its project)");
    e.K.S.view = { x: 1, y: 2, w: 3, h: 4 };
    e.switchTo("B"); const before = e.snapshot();
    const aWf = J(c.sessionWorkflow("A"));
    e.pending.wfLoad[0].resolve({ active: { ...aWf, roles: { ...aWf.roles, coder: { ...aWf.roles.coder, skills: ["Z"] } }, name: "Reviewed", savedId: "wf-9" }, scope: "session" });
    await tick(); assert.equal(e.calls.wfGet.length, 0, "no re-pull for a tab that left the screen");   // asserted BEFORE awaiting the action: a re-pull issued here would wait for an answer this test never gives
    await p;
    eq(coderSkills(c, "A"), ["Z"]); assert.equal(e.tabA.wfOwn.savedId, "wf-9");
    eq(e.snapshot(), before, "B, what B shows and the project default are as they were");
    eq(e.rerenders, []); eq(e.toasts, []); eq(e.K.S.view, { x: 1, y: 2, w: 3, h: 4 }, "the view of the tab on screen is kept");
    // on screen (B is active and the load is for B): re-pull — for B and its project — then view reset, repaint, toast
    const p2 = c.loadEntry(entry); await tick(); eq(e.calls.wfLoad[1], ["wf-9", "B", "C:/p"]);
    e.pending.wfLoad[1].resolve({ active: { ...J(c.sessionWorkflow("B")), name: "Reviewed", savedId: "wf-9" }, scope: "session" }); await tick();
    eq(e.calls.wfGet, [["C:/p", "B"]], "the follow-up get is for the captured tab and its project");
    assert.equal(e.tabB.wfOwn.savedId, "wf-9", "the load reply is in"); eq(e.K.S.view, { x: 1, y: 2, w: 3, h: 4 }, "the view is reset only once the pull is in"); eq(e.rerenders, []); eq(e.toasts, []);
    e.pending.wfGet[0].resolve({ active: J(c.sessionWorkflow("B")), scope: "session", library: [entry] }); await p2;
    assert.equal(e.tabB.wfOwn.savedId, "wf-9"); assert.equal(e.state.workflow.active.savedId, "wf-9");
    assert.equal(e.calls.wfGet.length, 1); assert.equal(e.K.S.view, null); eq(e.rerenders, [{}]); eq(e.toasts, ['Loaded "Reviewed" for this tab']);
    // no tab, then a project switch while the load is in flight
    e.noTab(); e.rerenders.length = 0; e.toasts.length = 0;
    const p3 = c.loadEntry(entry); await tick(); eq(e.calls.wfLoad[2], ["wf-9", undefined, "C:/A"], "no tab: a project-scoped load, for the captured project");
    e.switchProject("C:/B"); const b2 = e.snapshot();
    e.pending.wfLoad[2].resolve({ library: [entry, { id: "wf-x", name: "Other" }], active: { enabled: true, name: "HOSTILE", roles: { coder: { skills: ["Z"] } } }, scope: "project" });
    await tick(); assert.equal(e.calls.wfGet.length, 1, "no re-pull"); await p3;
    eq(e.snapshot(), b2, "the new project's settings and what the studio shows are untouched");
    assert.ok(!/HOSTILE/.test(JSON.stringify([e.state.settings, e.state.workflow])), "the old project's reply reached nothing");
    eq(e.state.settings.workflows, [], "the library reply is not mirrored into the new project's settings"); assert.equal(e.state.workflow.library.length, 1);
    eq(e.rerenders, []); eq(e.toasts, []);
  });
  await check("Rename with the IPC in flight while the user switches to B — a reply WITHOUT a body: the CAPTURED tab A's workflow takes the name (not B's, active by then), B and what B shows are untouched, the library follows, no repaint, no toast; with a body and A on screen: A takes it, the studio repaints and toasts", async () => {
    const e = fixture(), c = e.context;
    e.tabA.wfOwn.savedId = "wf-1"; e.state.workflow.library = [{ id: "wf-1", name: "Own", workflow: {} }]; e.state.workflow.active = c.tabWorkflow("A");
    e.dlg.prompt = async () => "Renamed";
    const p = c.renameActive(); await tick();
    eq(e.calls.wfRename, [["wf-1", "Renamed", "A", "C:/p"]], "the rename is for the captured tab A (and carries its project)");
    e.switchTo("B"); const before = e.snapshot();
    e.pending.wfRename[0].resolve({ library: [{ id: "wf-1", name: "Renamed", workflow: {} }] }); await p;
    assert.equal(e.tabA.wfOwn.name, "Renamed", "the fallback names the captured tab's workflow"); assert.equal(e.tabB.wfOwn.name, "Own", "not the active tab's");
    eq(e.snapshot(), before); eq(e.rerenders, []); eq(e.toasts, []);
    eq(e.state.workflow.library.map((x) => x.name), ["Renamed"]);
    e.switchTo("A"); e.dlg.prompt = async () => "Again";
    const p2 = c.renameActive(); await tick(); eq(e.calls.wfRename[1], ["wf-1", "Again", "A", "C:/p"]);
    e.pending.wfRename[1].resolve({ library: [{ id: "wf-1", name: "Again", workflow: {} }], active: { ...J(c.sessionWorkflow("A")), name: "Again" } }); await p2;
    assert.equal(e.tabA.wfOwn.name, "Again"); assert.equal(e.state.workflow.active.name, "Again"); assert.equal(e.tabB.wfOwn.name, "Own");
    eq(e.rerenders, [{}]); eq(e.toasts, ['Renamed to "Again"']);
  });
  /* ---- round 4 (2026-09-18): no tab open, a dialog still up while the user switches PROJECTS — each library IPC
   * carries the project CAPTURED when the action started as its trailing cwd (main writes A, not the project
   * current at IPC receipt), and its reply is dropped there: B's settings, what the studio shows and the library
   * take nothing, no repaint, no toast. The dialog's answer is never thrown away over the switch. ---- */
  await check("no tab, Save as… with the name dialog still up while the user switches projects: the save carries the CAPTURED project C:/A as its cwd (not C:/B, current when the name is confirmed), and its reply — A's, scope 'project' — is dropped whole", async () => {
    const e = fixture(), c = e.context;
    e.noTab(); const d = e.holdPrompt();
    const p = c.saveAs(); await tick();
    assert.equal(e.calls.wfSave.length, 0, "nothing goes out while the dialog is up");
    e.switchProject("C:/B"); const before = e.frozen();
    d.resolve("For A"); await tick();
    eq(e.calls.wfSave, [["For A", undefined, undefined, "C:/A"]], "the project captured when the dialog opened");
    e.pending.wfSave[0].resolve({ library: [{ id: "wf-a", name: "For A", workflow: {} }], active: { enabled: true, name: "For A", savedId: "wf-a", roles: { coder: { skills: ["X", "Y"] } } }, entry: { id: "wf-a", name: "For A" }, scope: "project" }); await p;
    eq(e.frozen(), before, "B's settings, what the studio shows, the library and its settings mirror are as they were");
    assert.ok(!/For A/.test(JSON.stringify([e.state.settings, e.state.workflow])), "A's reply reached nothing in the renderer");
    eq(e.rerenders, []); eq(e.toasts, []);
  });
  await check("no tab, Clone… with the name dialog still up while the user switches projects: the clone's save (workflow:save without an id) carries the CAPTURED project C:/A, its reply is dropped, no re-pull for B", async () => {
    const e = fixture(), c = e.context;
    e.noTab(); const d = e.holdPrompt();
    const p = c.duplicateActive(); await tick();
    assert.equal(e.calls.wfSave.length, 0);
    e.switchProject("C:/B"); const before = e.frozen();
    d.resolve("Own copy"); await tick();
    eq(e.calls.wfSave, [["Own copy", undefined, undefined, "C:/A"]]);
    e.pending.wfSave[0].resolve({ library: [{ id: "wf-c", name: "Own copy", workflow: {} }], active: { enabled: true, name: "Own copy", savedId: "wf-c", roles: { coder: { skills: ["X", "Y"] } } }, entry: { id: "wf-c", name: "Own copy" }, scope: "project" });
    await tick(); assert.equal(e.calls.wfGet.length, 0, "no follow-up re-pull once the scope left the screen"); await p;
    eq(e.frozen(), before); assert.ok(!/Own copy/.test(JSON.stringify([e.state.settings, e.state.workflow])));
    eq(e.rerenders, []); eq(e.toasts, []);
  });
  await check("no tab, Rename… of the saved entry with the name dialog still up while the user switches projects: the rename carries the CAPTURED project C:/A; a body-less reply names nothing (the fallback base is null once the project changed), the library reply is not mirrored into B", async () => {
    const e = fixture(), c = e.context;
    e.noTabSaved(); const d = e.holdPrompt();
    const p = c.renameActive(); await tick();
    assert.equal(e.calls.wfRename.length, 0);
    e.switchProject("C:/B"); const before = e.frozen();
    d.resolve("Renamed A"); await tick();
    eq(e.calls.wfRename, [["wf-1", "Renamed A", undefined, "C:/A"]]);
    e.pending.wfRename[0].resolve({ library: [{ id: "wf-1", name: "Renamed A", workflow: {} }] }); await p;
    eq(e.frozen(), before, "B's default keeps its name, the library keeps 'Own'"); assert.equal(e.state.settings.workflow.name, "B default"); assert.equal(e.state.workflow.library[0].name, "Own");
    eq(e.rerenders, []); eq(e.toasts, []);
  });
  await check("no tab, Delete… of the saved entry with the REAL confirm dialog still up while the user switches projects: the delete carries the CAPTURED project C:/A, its reply (library + the unsaved active) is dropped, no re-pull for B", async () => {
    const e = fixture(), c = e.context;
    e.noTabSaved();
    const p = c.deleteActive(); await tick();
    const dlg = e.confirmOnTop(/Delete from the library\?/); assert.equal(e.calls.wfRemove.length, 0);
    e.switchProject("C:/B"); const before = e.frozen();
    dlg.querySelector(".btn-danger").click(); await tick();
    assert.ok(!dlg.isConnected, "the confirm dialog closed");
    eq(e.calls.wfRemove, [["wf-1", undefined, "C:/A"]]);
    e.pending.wfRemove[0].resolve({ library: [], active: { enabled: true, name: "Own", savedId: null, roles: { coder: { skills: ["X", "Y"] } } } });
    await tick(); assert.equal(e.calls.wfGet.length, 0, "no re-pull"); await p;
    eq(e.frozen(), before, "B's settings and the library are as they were"); assert.equal(e.state.workflow.library.length, 1);
    eq(e.rerenders, []); eq(e.toasts, []);
  });
  await check("no tab, Load… over unsaved changes with the REAL confirm dialog still up while the user switches projects: the load carries the CAPTURED project C:/A, its reply is dropped, no re-pull for B; a load started in B afterwards carries C:/B", async () => {
    const e = fixture(), c = e.context;
    e.noTabSaved(); const entry = { id: "wf-9", name: "Reviewed", workflow: { roles: { coder: { skills: ["Z"] } } } }; e.state.workflow.library.push(entry);
    assert.ok(c.isDirty(), "the project's workflow differs from its saved entry");
    const p = c.loadEntry(entry); await tick();
    const dlg = e.confirmOnTop(/Discard unsaved changes\?/); assert.equal(e.calls.wfLoad.length, 0);
    e.switchProject("C:/B"); const before = e.frozen();
    dlg.querySelector(".btn-primary").click(); await tick();
    assert.ok(!dlg.isConnected, "the confirm dialog closed");
    eq(e.calls.wfLoad, [["wf-9", undefined, "C:/A"]]);
    e.pending.wfLoad[0].resolve({ active: { enabled: true, name: "Reviewed", savedId: "wf-9", roles: { coder: { skills: ["Z"] } } }, scope: "project" });
    await tick(); assert.equal(e.calls.wfGet.length, 0, "no re-pull"); await p;
    eq(e.frozen(), before); assert.ok(!/Reviewed/.test(JSON.stringify([e.state.settings, e.state.workflow.active])), "A's loaded design reached nothing of B's");
    eq(e.rerenders, []); eq(e.toasts, []);
    // a load started now is B's: B's workflow is not dirty (no dialog), the IPC carries C:/B, and its follow-up get is for C:/B
    const p2 = c.loadEntry(entry); await tick();
    assert.equal(e.doc.querySelectorAll("#modalRoot > .modal-backdrop").length, 0, "B's workflow is not dirty: no dialog"); assert.equal(e.calls.wfLoad.length, 2, "a plain load for B");
    eq(e.calls.wfLoad[1], ["wf-9", undefined, "C:/B"]); e.pending.wfLoad[1].resolve(null); await tick(); eq(e.calls.wfGet, [["C:/B", undefined]]); e.pending.wfGet[0].resolve({}); await p2;
    eq(e.rerenders, [{}]); eq(e.toasts, ['Loaded "Reviewed" for this tab']);
  });
  /* ---- round 4: the follow-up re-pull (pullWorkflow) validates the CAPTURED scope inside, before any mutation ---- */
  await check("Load on tab A on screen, the follow-up get in flight while the user switches to tab B: A's reply lands on A's own copy only — B's copy, what B shows and the view are untouched, no repaint, no toast (the library, global and same-project, is mirrored); with the project switched too, the library is not mirrored either", async () => {
    const e = fixture(), c = e.context;
    const entry = { id: "wf-9", name: "Reviewed", workflow: { roles: { coder: { skills: ["Z"] } } } }; e.state.workflow.library = [entry];
    const p = c.loadEntry(entry); await tick();
    const aWf = J(c.sessionWorkflow("A"));
    e.pending.wfLoad[0].resolve({ active: { ...aWf, name: "Reviewed", savedId: "wf-9", roles: { ...aWf.roles, coder: { ...aWf.roles.coder, skills: ["Z"] } } }, scope: "session" }); await tick();
    eq(e.calls.wfGet, [["C:/p", "A"]], "the follow-up get is for the captured tab and its project"); assert.equal(e.tabA.wfOwn.savedId, "wf-9");
    e.K.S.view = { x: 1, y: 2, w: 3, h: 4 };
    e.switchTo("B"); const before = e.snapshot();
    const lib2 = [entry, { id: "wf-x", name: "Other", workflow: {} }];
    e.pending.wfGet[0].resolve({ active: { ...J(e.tabA.wfOwn), name: "FROM A'S GET" }, scope: "session", library: lib2 }); await p;
    assert.equal(e.tabA.wfOwn.name, "FROM A'S GET", "the tab it was for still exists: its own copy takes it");
    eq(e.snapshot(), before, "B's copy, what B shows and the project default are untouched"); assert.equal(e.tabB.wfOwn.name, "Own"); assert.equal(e.state.workflow.active.name, "Own");
    eq(e.state.workflow.library, lib2, "the library is global and the project unchanged: the snapshot is mirrored, as a Save As reply after a tab switch is");
    eq(e.rerenders, []); eq(e.toasts, []); eq(e.K.S.view, { x: 1, y: 2, w: 3, h: 4 }, "no view reset for B");
    // the same follow-up get, resolved after a switch to B AND another project: A's copy still takes it (A exists and is the captured project's), nothing else — not the library
    e.switchTo("A"); e.rerenders.length = 0;
    const p2 = c.loadEntry(entry); await tick();
    e.confirmOnTop(/Discard unsaved changes\?/).querySelector(".btn-primary").click(); await tick();   // A's design differs from the entry now (the reviewer's skill)
    eq(e.calls.wfLoad[1], ["wf-9", "A", "C:/p"]); e.pending.wfLoad[1].resolve({ active: { ...J(e.tabA.wfOwn), name: "Reviewed" }, scope: "session" }); await tick();
    assert.equal(e.calls.wfGet.length, 2);
    e.switchTo("B", "D:/q"); const b2 = e.frozen();
    e.pending.wfGet[1].resolve({ active: { ...J(e.tabA.wfOwn), name: "FROM A'S SECOND GET" }, scope: "session", library: [{ id: "wf-h", name: "HOSTILE" }] }); await p2;
    assert.equal(e.tabA.wfOwn.name, "FROM A'S SECOND GET"); eq(e.frozen(), b2, "B, the new project's settings and the library are untouched");
    assert.ok(!/HOSTILE/.test(JSON.stringify([e.state.settings, e.state.workflow, e.tabB]))); eq(e.rerenders, []); eq(e.toasts, []);
  });
  await check("no tab, Load on screen, the follow-up get in flight while the user switches PROJECTS: the get went out for the captured project; its reply — A's default, scope 'project', with A's library — is dropped whole: B's settings, what the studio shows and the library are untouched, no repaint, no toast", async () => {
    const e = fixture(), c = e.context;
    e.noTab(); const entry = { id: "wf-9", name: "Reviewed", workflow: { roles: { coder: { skills: ["Z"] } } } }; e.state.workflow.library = [entry]; e.state.settings.workflows = [entry];
    const p = c.loadEntry(entry); await tick();
    eq(e.calls.wfLoad, [["wf-9", undefined, "C:/A"]]);
    e.pending.wfLoad[0].resolve({ active: { enabled: true, name: "Reviewed", savedId: "wf-9", roles: { coder: { skills: ["Z"] } } }, scope: "project" }); await tick();
    assert.equal(e.state.settings.workflow.name, "Reviewed", "the load reply landed — same project"); assert.equal(e.state.workflow.active.name, "Reviewed");
    eq(e.calls.wfGet, [["C:/A", undefined]], "the follow-up get is for the captured project");
    e.switchProject("C:/B"); const before = e.frozen();
    e.pending.wfGet[0].resolve({ active: { enabled: true, name: "HOSTILE", roles: { coder: { skills: ["Z"] } } }, scope: "project", library: [entry, { id: "wf-h", name: "HOSTILE" }] }); await p;
    eq(e.frozen(), before, "B's settings, what the studio shows and the library are untouched");
    assert.ok(!/HOSTILE|Reviewed/.test(JSON.stringify([e.state.settings, e.state.workflow.active])), "A's reply reached nothing of B's");
    eq(e.rerenders, []); eq(e.toasts, []);
  });
  await check("model: pullWorkflow(scope) — the get carries the captured tab and its project; a reply for a tab that CLOSED (its scope 'project' default included) is dropped whole, same project or not, no tab resurrected; a tab that is another project's by reply time is dropped; a tab that merely left the screen takes its own copy; the control facts always land; on screen the default capture mirrors as before (a 'project' reply drops the tab's own copy); no tab: the project's, while it is current; a null reply → null", async () => {
    // 1. tab A follows the project default; the get goes out for A and its project; A CLOSES (same project) before the reply
    let e = fixture(), c = e.context;
    e.tabA.wfOwn = null; e.state.workflow.active = c.tabWorkflow("A");
    const p1 = c.pullWorkflow(); await tick(); eq(e.calls.wfGet, [["C:/p", "A"]], "the captured tab and its project");
    e.state.tabs.delete("A"); e.switchTo("B"); const b1 = e.frozen();
    e.pending.wfGet[0].resolve({ active: { enabled: true, name: "HOSTILE", roles: {} }, scope: "project", library: [{ id: "wf-h", name: "HOSTILE" }], control: { url: "http://c", running: true, binDir: "/bin" } });
    assert.equal(await p1, null, "dropped: null");
    eq(e.frozen(), b1, "the project's settings take nothing although the project is the same — the tab the reply was for is gone"); assert.ok(!e.state.tabs.has("A"));
    assert.ok(!/HOSTILE/.test(JSON.stringify([e.state.settings, e.state.workflow, e.tabB])));
    eq(e.K.S.control, { url: "http://c", running: true, binDir: "/bin" }, "the control facts are global: they land");
    // 2. the same, with the project switched too
    e = fixture(); c = e.context; e.tabA.wfOwn = null; e.state.workflow.active = c.tabWorkflow("A");
    const p2 = c.pullWorkflow(); await tick(); e.state.tabs.delete("A"); e.switchTo("B", "D:/q"); const b2 = e.frozen();
    e.pending.wfGet[0].resolve({ active: { enabled: true, name: "HOSTILE", roles: {} }, scope: "project", library: [{ id: "wf-h", name: "HOSTILE" }] });
    assert.equal(await p2, null); eq(e.frozen(), b2); assert.ok(!/HOSTILE/.test(JSON.stringify([e.state.settings, e.state.workflow, e.tabB])));
    // 3. the tab named is another project's by reply time (its meta.cwd is not the captured project's): dropped whole — its copy and the library untouched
    e = fixture(); c = e.context;
    const p3 = c.pullWorkflow(); await tick(); eq(e.calls.wfGet, [["C:/p", "A"]]);
    e.tabA.meta.cwd = "D:/q"; const b3 = e.frozen(), a3 = J(e.tabA.wfOwn);
    e.pending.wfGet[0].resolve({ active: { ...a3, name: "HOSTILE" }, scope: "session", library: [{ id: "wf-h", name: "HOSTILE" }] });
    assert.equal(await p3, null); eq(e.frozen(), b3); eq(e.tabA.wfOwn, a3, "A's copy is not the reply's");
    // 4. the tab merely LEFT THE SCREEN: its own copy takes the reply (fresh when the user returns), what the studio shows (B's) does not; the library (same project) is mirrored
    e = fixture(); c = e.context;
    const p4 = c.pullWorkflow(); await tick(); e.switchTo("B"); const b4 = e.snapshot();
    e.pending.wfGet[0].resolve({ active: { ...J(e.tabA.wfOwn), name: "FRESH A" }, scope: "session", library: [{ id: "wf-1", name: "One", workflow: {} }] });
    assert.ok(await p4, "applied: the reply"); assert.equal(e.tabA.wfOwn.name, "FRESH A"); eq(e.snapshot(), b4, "B's copy and what B shows are untouched"); assert.equal(e.state.workflow.active.name, "Own");
    eq(e.state.workflow.library.map((x) => x.id), ["wf-1"]);
    // 5. on screen, the default capture: a 'project' reply for the active tab drops the tab's own copy — the project's settings and what the studio shows take it
    e = fixture(); c = e.context;
    const p5 = c.pullWorkflow(); await tick();
    e.pending.wfGet[0].resolve({ active: { enabled: false, name: "Project fresh", roles: { coder: { skills: ["P", "R"] } } }, scope: "project", library: [] }); await p5;
    assert.equal(e.tabA.wfOwn, null, "the tab follows the project again"); assert.equal(e.state.settings.workflow.name, "Project fresh"); assert.equal(e.state.workflow.active.name, "Project fresh"); eq(coderSkills(c, "A"), ["P", "R"]); eq(coderSkills(c, "B"), ["X", "Y"]);
    // 6. no tab: the project's active workflow and the library, while the project is current; a null reply → null, nothing touched
    e = fixture(); c = e.context; e.noTab();
    const p6 = c.pullWorkflow(); await tick(); eq(e.calls.wfGet, [["C:/A", undefined]]);
    e.pending.wfGet[0].resolve({ active: { enabled: true, name: "A fresh", roles: {} }, scope: "project", library: [{ id: "wf-1", name: "One", workflow: {} }] }); await p6;
    assert.equal(e.state.settings.workflow.name, "A fresh"); assert.equal(e.state.workflow.active.name, "A fresh"); assert.equal(e.state.workflow.library.length, 1); eq(e.state.settings.workflows, e.state.workflow.library);
    const p7 = c.pullWorkflow(); await tick(); const b7 = e.frozen(); e.pending.wfGet[1].resolve(null); assert.equal(await p7, null); eq(e.frozen(), b7);
  });
  await check("model: setWorkflowFor(sid) never becomes a project write — a reply after the tab closed resolves null (no toast, no re-render through editFor), the reply's scope is ignored, a body-less reply merges into the captured tab's own copy; setWorkflow with no tab keeps the project path", async () => {
    const e = fixture(), c = e.context;
    // dropped: the tab closed while the set was in flight — even a reply that claims the project scope
    const p = c.setWorkflowFor("A", { brief: "late" }); await tick();
    eq(e.sets()[0], { patch: { brief: "late" }, cwd: undefined, sid: "A" });
    e.state.tabs.delete("A"); e.switchTo("B", "D:/q"); const before = e.snapshot();
    e.pending.set[0].resolve({ active: { brief: "late", name: "HOSTILE" }, scope: "project" });
    assert.equal(await p, null); eq(e.snapshot(), before);
    // the same through editFor: null, no toast, no re-render; a rejected write: false and ONE toast
    const q1 = c.editFor("B", { brief: "for B" }); await tick(); e.state.tabs.delete("B"); e.pending.set[1].resolve({ active: { brief: "for B" }, scope: "session" });
    assert.equal(await q1, null); eq(e.toasts, []); eq(e.rerenders, []); assert.ok(!e.state.settings.workflow.brief, "the project default took nothing");
    e.state.tabs.set("B", e.tabB);
    const q2 = c.editFor("B", { brief: "fails" }); await tick(); e.pending.set[2].reject(new Error("service down"));
    assert.equal(await q2, false); eq(e.toasts, ["service down"]); assert.equal(c.tabWorkflow("B").brief, "");
    // a body-less reply: the fallback merges the CAPTURED tab's own workflow, not the project's
    const q3 = c.setWorkflowFor("B", { brief: "b" }); await tick(); e.pending.set[3].resolve(null);
    const n = await q3; assert.equal(n.brief, "b"); assert.equal(e.tabB.wfOwn.brief, "b"); eq(e.tabB.wfOwn.roles.coder.skills, ["X", "Y"]); assert.ok(!e.state.settings.workflow.brief);
    eq(e.rerenders, [], "setWorkflowFor itself never re-renders");
    // a session write WITH a cwd: carried into the set (main resolves the project from the session; here it is a guard) —
    // mirrored while the tab is that project's, dropped once the tab named is not (its meta.cwd differs)
    const q5 = c.setWorkflowFor("B", { brief: "guarded" }, "C:/p"); await tick(); eq(e.sets()[4], { patch: { brief: "guarded" }, cwd: "C:/p", sid: "B" });
    e.pending.set[4].resolve({ active: { ...J(c.sessionWorkflow("B")), brief: "guarded" }, scope: "session" }); assert.equal((await q5).brief, "guarded"); assert.equal(e.tabB.wfOwn.brief, "guarded");
    const q6 = c.setWorkflowFor("B", { brief: "other project" }, "C:/p"); await tick(); e.tabB.meta.cwd = "D:/q";
    e.pending.set[5].resolve({ active: { ...J(c.sessionWorkflow("B")), brief: "other project" }, scope: "session" }); assert.equal(await q6, null); assert.equal(e.tabB.wfOwn.brief, "guarded"); e.tabB.meta.cwd = "C:/p";
    // no tab at all: the studio edits the project's active workflow
    e.state.activeTabId = null; e.state.tabs.clear();
    const q4 = c.setWorkflow({ brief: "project" }); await tick();
    eq(e.sets()[6], { patch: { brief: "project" }, cwd: "D:/q", sid: undefined }, "no cwd given: the project current when the call started");
    e.pending.set[6].resolve({ active: c.deepMerge(c.projectWorkflow(), { brief: "project" }), scope: "project" });
    assert.equal((await q4).brief, "project"); assert.equal(e.state.settings.workflow.brief, "project"); assert.equal(e.state.workflow.active.brief, "project");
    eq(e.state.settings.workflow.roles.coder.skills, ["Q"]);
    // sessionWorkflow: null for a missing tab; tabWorkflow keeps the project fallback for displays (live.js, events.js)
    assert.equal(c.sessionWorkflow("A"), null); assert.equal(c.sessionWorkflow(null), null); eq(c.tabWorkflow("A").roles.coder.skills, ["Q"]);
  });
  await check("helpers: removeSkillFromScope / detachSkillFrom / attachSkillTo take the captured scope (sid, cwd, retained wf) — a Remove started for A lands on A after a switch to B, a failed skills:remove rejects and leaves both workflows alone, a failed set toasts and resolves false, a no-op detach writes nothing, the scope's copy follows each reply", async () => {
    const e = fixture(), c = e.context;
    const scope = e.scopeFor("A");
    const p = c.removeSkillFromScope(scope, { id: "X", name: "X" }); await tick();
    eq(e.calls.remove, [["C:/p", "X"]]); assert.equal(e.sets().length, 0);
    e.switchTo("B");
    e.pending.remove[0].resolve(true); await tick();
    eq(e.sets()[0], { patch: { roles: { coder: { skills: ["Y"] }, reviewer: { skills: [] } } }, cwd: "C:/p", sid: "A" });
    e.pending.set[0].resolve(e.reply("A", e.sets()[0].patch));
    assert.equal(await p, true);
    eq(coderSkills(c, "A"), ["Y"]); eq(coderSkills(c, "B"), ["X", "Y"]); eq(e.rerenders, []);
    eq(scope.wf.roles.coder.skills, ["Y"], "the scope's retained copy follows the reply");
    eq(e.state.workflow.active.roles.coder.skills, ["X", "Y"], "what B shows is not repainted with A's workflow");
    // a failed remove
    const f = c.removeSkillFromScope(scope, { id: "Y", name: "Y" }); await tick(); e.pending.remove[1].reject(new Error("store locked"));
    await assert.rejects(f, /store locked/); assert.equal(e.sets().length, 1); eq(coderSkills(c, "A"), ["Y"]);
    // a failed set
    const d = c.detachSkillFrom(scope, "Y"); await tick(); e.pending.set[1].reject(new Error("service down"));
    assert.equal(await d, false); eq(coderSkills(c, "A"), ["Y"]); eq(scope.wf.roles.coder.skills, ["Y"]); eq(e.toasts, ["service down"]);
    // nothing to detach
    assert.equal(await c.detachSkillFrom(scope, "nope"), true); assert.equal(e.sets().length, 2);
    // a tick back on A re-renders once (canvas + inspector, not the header)
    e.switchTo("A");
    const t = c.attachSkillTo(scope, "planner", "Z", true); await tick();
    eq(e.sets()[2], { patch: { roles: { planner: { skills: ["Z"] } } }, cwd: "C:/p", sid: "A" });
    e.pending.set[2].resolve(e.reply("A", e.sets()[2].patch)); assert.equal(await t, true);
    eq(plannerSkills(c, "A"), ["Z"]); eq(e.rerenders, [{ canvas: true, inspector: true, header: false }]);
    // a scope whose tab was already gone when it was captured writes nothing
    e.state.tabs.delete("B"); const dead = e.scopeFor("B"); assert.equal(dead.wf, null);
    assert.equal(await c.attachSkillTo(dead, "planner", "Z", true), false); assert.equal(await c.detachSkillFrom(dead, "X"), true); assert.equal(e.sets().length, 3);
  });
  await check("legacy 'suggested' records are rows — sorted after the active ones, flagged with the row class and the badge, with ticks and Remove — and skillRows keeps every record with an id (80 legacy ones, none dropped)", async () => {
    const e = fixture(), c = e.context;
    const back = await openSkills(e, [{ id: "l1", name: "Learned", status: "suggested" }, ...SKILLS.map((s) => ({ ...s, status: "active" }))]);
    eq(rowIds(back), ["X", "Y", "Z", "l1"]);
    const legacy = back.querySelector('.wf-skills-row.legacy[data-id="l1"]'); assert.ok(legacy, "the legacy row class");
    assert.equal(legacy.querySelector(".wf-skills-legacy").textContent, e.K.LEGACY_SKILL_BADGE);
    assert.equal(legacy.querySelectorAll("input").length, 3); assert.ok(legacy.querySelector(".wf-skills-remove"));
    assert.ok(/apprentice/.test(e.K.LEGACY_SKILL_TITLE) && /limit/.test(e.K.LEGACY_SKILL_TITLE));
    assert.ok(/\.wf-skills-legacy\s*\{/.test(R.css()) && /\.wf-skills-row\.legacy/.test(R.css()), "the badge and the legacy row are styled");
    const rows = Array.from({ length: 80 }, (_, i) => ({ id: "s" + i, name: "Suggestion " + i, status: "suggested", steps: "do it" }));
    const out = c.skillRows(rows);
    assert.equal(out.length, 80); assert.ok(out.every((r) => r.legacy === true && r.skill.status === "suggested"), "flagged, status untouched");
    eq(out.map((r) => r.skill.id), rows.map((r) => r.id), "main's order is kept");
    assert.equal(c.missingSkillIds(c.normalizeWorkflow({ roles: { coder: { skills: ["s3", "gone"] } } }), out.map((r) => r.skill)).size, 1, "an attached legacy id is installed, not 'unavailable'");
    eq(c.skillRows([{ id: "l1", status: "suggested" }, { id: "a1", status: "active" }, { id: "a2" }, null, { name: "no id" }, { id: "l2", status: "suggested" }]).map((r) => [r.skill.id, r.legacy]), [["a1", false], ["a2", false], ["l1", true], ["l2", true]]);
    eq(c.skillRows(null), []); eq(c.skillRows("x"), []);
  });

  /* ---- the workflow switch vs solo sub-agents (user decisions 2026-09-18) ---- */
  await check("setWorkflowEnabled(false) on tab A: ONE session set { enabled: false } for A and no question; the reply keeps A's whole design (name, roles, skills) with only `enabled` flipped; on again — solo sub-agents off — sets { enabled: true } with no question; a no-op when already in that state", async () => {
    const e = fixture(); const c = e.context;
    const p = c.setWorkflowEnabled(false); await tick();
    assert.equal(e.doc.querySelectorAll("#modalRoot > .modal-backdrop").length, 0, "no dialog");
    eq(e.sets(), [{ patch: { enabled: false }, cwd: undefined, sid: "A" }]);
    e.pending.set[0].resolve(e.reply("A", { enabled: false })); const r = await p;
    assert.equal(r.enabled, false); assert.equal(r.name, "Own"); eq(r.roles.coder.skills, ["X", "Y"]); eq(r.roles.reviewer.skills, ["X"]);
    assert.equal(e.tabA.wfOwn.enabled, false); eq(e.tabA.wfOwn.roles.coder.skills, ["X", "Y"]); assert.equal(e.state.workflow.active.enabled, false);
    const p2 = c.setWorkflowEnabled(true); await tick();
    assert.equal(e.doc.querySelectorAll("#modalRoot > .modal-backdrop").length, 0, "no dialog when solo sub-agents are off");
    eq(e.sets()[1], { patch: { enabled: true }, cwd: undefined, sid: "A" });
    e.pending.set[1].resolve(e.reply("A", { enabled: true })); const r2 = await p2;
    assert.equal(r2.enabled, true); eq(r2.roles.coder.skills, ["X", "Y"]); assert.equal(e.tabA.wfOwn.enabled, true);
    const same = await c.setWorkflowEnabled(true); assert.equal(same.enabled, true); assert.equal(e.sets().length, 2, "already on: no set");
  });
  await check("turning the workflow ON while solo sub-agents are on ASKS first: Cancel leaves the workflow off and sub-agents on with no set; Confirm turns sub-agents off (state.settings, atom.settings.set, the composer's hook) and only then sets { enabled: true }; confirmWorkflowOn alone is silent when sub-agents are off", async () => {
    const e = fixture(); const c = e.context;
    e.tabA.wfOwn.enabled = false; e.state.settings.subAgents = true; e.state.workflow.active = c.tabWorkflow("A");
    const saved = []; e.atom.settings.set = async (patch) => { saved.push(J(patch)); }; const hook = []; c.onSoloAgentsChanged((v) => hook.push(v));
    let p = c.setWorkflowEnabled(true); await tick();
    let dlg = e.confirmOnTop(/Turn on the workflow for this tab\?/);
    assert.ok(/Solo sub-agents are on/.test(dlg.textContent) && /"Own"/.test(dlg.textContent), "the question names the workflow and says sub-agents turn off");
    dlg.querySelector(".btn-ghost").click(); await tick(); await tick();
    assert.equal(await p, null, "cancelled → null"); assert.equal(e.sets().length, 0, "no set"); assert.equal(e.state.settings.subAgents, true); assert.equal(e.tabA.wfOwn.enabled, false); eq(saved, []); eq(hook, []);
    assert.ok(!dlg.isConnected, "the dialog closed");
    p = c.setWorkflowEnabled(true); await tick();
    dlg = e.confirmOnTop(/Turn on the workflow for this tab\?/); dlg.querySelector(".btn-primary").click(); await tick(); await tick();
    assert.equal(e.state.settings.subAgents, false, "solo sub-agents off"); eq(saved, [{ subAgents: false }]); eq(hook, [false]);
    eq(e.sets(), [{ patch: { enabled: true }, cwd: undefined, sid: "A" }], "then the enable");
    e.pending.set[0].resolve(e.reply("A", { enabled: true })); const r = await p;
    assert.equal(r.enabled, true); assert.equal(e.tabA.wfOwn.enabled, true); eq(e.tabA.wfOwn.roles.coder.skills, ["X", "Y"], "the design is intact");
    assert.equal(await c.confirmWorkflowOn("Own"), true, "no question when solo sub-agents are off"); assert.equal(e.doc.querySelectorAll("#modalRoot > .modal-backdrop").length, 0);
  });
}

/* ============================ mutants ============================ */
// Each damages the module source in one way the suite must notice; `count` occurrences must exist, or the mutant is stale.
const replace = (from, to, count = 1) => (src) => { const n = src.split(from).length - 1; if (n !== count) throw new Error(`mutant does not apply: ${n} of ${count} occurrence(s) of ${JSON.stringify(from)}`); return src.split(from).join(to); };
const MUTANTS = {
  "serial() replaced by direct calls": replace("const serial = (fn) => { const p = M.queue.then(fn, fn); M.queue = p.catch(() => {}); return p; };", "const serial = (fn) => Promise.resolve().then(fn);"),
  "the retained copy is not refreshed from the reply": replace("if (n) scope.wf = n;", ""),
  "sameScope() guards removed": (src) => { const re = /^[ \t]*if \(!inScope\(\)\) \{.*return; \}[ \t]*\n/mg; const n = (src.match(re) || []).length; if (n !== 3) throw new Error("mutant does not apply: " + n + " sameScope guards"); return src.replace(re, ""); },
  "the 'captured tab still exists' guard removed": replace(" && (!scope.sid || state.tabs.has(scope.sid))", ""),
  "M.open guards after a write removed": (src) => replace('if (M.open) { drawRows(); toast("Detached", "check"); }', '{ drawRows(); toast("Detached", "check"); }')(replace("if (!M.open) return;   // closed meanwhile", "if (false) return;   // closed meanwhile")(src)),
  "mirrorActive falls through to the project's settings when the tab is gone": replace("if (sid) { const ts = state.tabs.get(sid); if (!ts) return null; ts.wfOwn = n; if (sid === activeSessionId()) state.workflow.active = n; }", "const ts = sid && state.tabs.get(sid); if (ts) { ts.wfOwn = n; if (sid === activeSessionId()) state.workflow.active = n; }"),
  "patches computed from tabWorkflow(sid) — the project fallback": (src) => replace("const cur = (((scope.wf || {}).roles || {})[role] || {}).skills || [];", "const cur = tabWorkflow(scope.sid).roles[role].skills || [];")(replace("const patch = scope.wf && detachPatch(scope.wf, id);", "const patch = detachPatch(tabWorkflow(scope.sid), id);")(src)),
  "a project-scoped reply is mirrored after a project switch": replace("if ((state.project || undefined) !== cwd) return null;", "if (false) return null;"),
  "setWorkflowFor honours the reply's scope": replace("return mirrorActive((r && r.active) || (before ? deepMerge(before, patch) : null), sid);", "if (r && r.scope === \"project\") { const n = normalizeWorkflow(r.active); state.settings.workflow = n; state.workflow.active = n; return n; }\n  return mirrorActive((r && r.active) || (before ? deepMerge(before, patch) : null), sid);"),
  // round 3 (2026-09-18): the captured project through the write and the guards, the library actions' captured scope
  "writeSkills drops the captured project from the write": replace("const n = await editFor(scope.sid, patch, parts, scope.cwd);", "const n = await editFor(scope.sid, patch, parts);"),
  "setWorkflowFor drops the cwd from the service call": replace("api().set(patch, cwd, ", "api().set(patch, undefined, ", 2),
  "the no-tab response guard compares the project captured at call time, not the caller's cwd": (src) => replace("if ((state.project || undefined) !== cwd) return null;", "if ((state.project || undefined) !== was) return null;")(replace("cwd = cwd || state.project || undefined; const base = projectWorkflow();", "cwd = cwd || state.project || undefined; const base = projectWorkflow(); const was = state.project || undefined;")(src)),
  "the session response guard ignores the captured cwd": replace("if (cwd && ts && ts.meta && ts.meta.cwd && ts.meta.cwd !== cwd) return null;", "if (false) return null;"),
  "takeResult mirrors onto the tab active at reply time": replace("if (scope.sid) return mirrorActive(r.active, scope.sid);", "if (scope.sid) return mirrorActive(r.active);"),
  "takeResult mirrors a project / library reply after a project switch": replace("const sameProject = state.project === scope.project;", "const sameProject = true;"),
  "the library actions' visual follow-ups are not guarded": replace("const inLibraryScope = (scope) => scope.sid === activeSessionId() && (!!scope.sid || state.project === scope.project);", "const inLibraryScope = () => true;"),
  "the rename fallback names the workflow of the tab active at reply time": replace("const base = scope.sid ? sessionWorkflow(scope.sid) : state.project === scope.project ? projectWorkflow() : null; if (base) mirrorActive({ ...base, name: n }, scope.sid);", "mirrorActive({ ...activeWorkflow(), name: n });"),
  // round 4 (2026-09-18): the captured project through the library IPCs (load · save · rename · clone's save · delete), the scoped pull
  "the library IPCs drop the captured project (the trailing cwd)": replace(", scope.sid || undefined, scope.cwd)", ", scope.sid || undefined)", 5),
  "pullWorkflow mirrors BEFORE the scope check": replace("if (!scopeHolds(scope)) return null;\n  mirrorPulled(r, scope);", "mirrorPulled(r, scope);\n  if (!scopeHolds(scope)) return null;"),
  "pullWorkflow re-reads the scope at reply time (the tab / project active by then)": replace("if (!scopeHolds(scope)) return null;\n  mirrorPulled(r, scope);", "scope = captureScope(); if (!scopeHolds(scope)) return null;\n  mirrorPulled(r, scope);"),
  "pullWorkflow ignores the captured sid (the tab-exists / tab-project guard)": replace("return !!ts && !(scope.cwd && ts.meta && ts.meta.cwd && ts.meta.cwd !== scope.cwd);", "return true;"),
  "pullWorkflow ignores the captured project": replace('const sameProjectAs = (scope) => (state.project || "") === (scope.project || "");', "const sameProjectAs = () => true;"),
  // the workflow switch vs solo sub-agents (2026-09-18): on must ask while solo sub-agents are on, and the yes must turn them off
  "setWorkflowEnabled turns the workflow on without asking while solo sub-agents are on": replace("if (on && !(await confirmWorkflowOn(wf.name))) return null;", ""),
  "confirmWorkflowOn leaves solo sub-agents on after a yes": replace("  setSoloAgentsSetting(false);\n  return true;", "  return true;"),
};

async function main() {
  if (process.argv.includes("--mutants")) {
    quiet = true; let survived = 0;
    const pristine = R.moduleSource("workflow/model.js") + "\n" + R.moduleSource("workflow/studio.js");
    for (const [name, mutate] of Object.entries(MUTANTS)) {
      // a mutant whose search string no longer matches the source must not pass for a kill (every fixture would throw)
      try { mutate(pristine); } catch (e) { console.log(`MUTANT ${name}: harness error — ${e.message}`); survived++; continue; }
      results.passed = 0; results.failed = []; MUTATE = mutate;
      try { await suite(); } catch (e) { console.log(`MUTANT ${name}: harness error — ${e.message}`); survived++; continue; }
      if (results.failed.length) console.log(`MUTANT ${name}: killed by ${results.failed.length} test(s)\n` + results.failed.map((f) => "    - " + f.name.split(":")[0]).join("\n"));
      else { console.log(`MUTANT ${name}: SURVIVED`); survived++; }
    }
    MUTATE = null;
    console.log(`Workflow UI mutants: ${Object.keys(MUTANTS).length - survived} killed, ${survived} survived`);
    if (survived) process.exitCode = 1;
    return;
  }
  await suite();
  console.log(`Workflow UI: ${results.passed} passed, ${results.failed.length} failed`);
  if (results.failed.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
