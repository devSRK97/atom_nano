/* AtomNano renderer — Tests dock — per-project test catalog (Test Director).
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { $, baseName, confirmDialog, h, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { icon } from "../icons.js";
import { dockHead, toggleTests } from "./changes.js";

/* ============================================================
   TESTS PANEL — per-project test catalog (Test Director)
   ============================================================ */
export let testsFilter = "all";
export const TEST_CATS = ["all", "smoke", "regression", "e2e", "unit", "integration", "visual"];
export async function renderTests() {
  const panel = $("testsPanel");
  if (!panel || panel.classList.contains("hidden")) return;
  let peek = null, tests = [], goals = [];
  if (state.project) {
    peek = await atom.testdir.peek(state.project).catch(() => null);
    tests = await atom.testdir.list(state.project, testsFilter === "all" ? {} : { category: testsFilter }).catch(() => []);
    goals = await atom.testdir.goals(state.project).catch(() => []);
  }
  panel.innerHTML = "";
  const pk = peek || { total: 0, pass: 0, fail: 0, quarantined: 0 };
  panel.append(dockHead("checkCircle", "Tests", `${pk.pass}/${pk.total} green`, toggleTests, [
    h("button", { class: "dock-mini", title: "Run smoke tests", html: icon("send", 14), onclick: () => runTestsCategory("smoke") }),
    h("button", { class: "dock-mini", title: "Run all (regression)", html: icon("refresh", 14), onclick: () => runTestsCategory(null) }),
  ]));
  if (!state.project) { panel.append(h("div", { class: "dock-empty", text: "Open a project to manage tests." })); return; }

  // Goal → Green composer + active goals
  const gi = h("textarea", { class: "goal-input", id: "goalInput", rows: "2", spellcheck: "false", placeholder: "Goal → Green — describe what to build; the agent writes tests and drives to green." });
  panel.append(h("div", { class: "goal-compose" }, gi,
    h("div", { class: "goal-compose-row" }, h("span", { class: "goal-hint", text: "agent authors tests → builds → auto-fixes → gates" }), h("div", { class: "spacer" }),
      h("button", { class: "goal-plan", onclick: () => planGoal() }, h("span", { html: icon("sparkle", 13) }), h("span", { text: "Plan" })))));
  if (goals.length) { const gl = h("div", { class: "goal-list" }); for (const g of goals.slice(0, 6)) gl.append(goalRow(g)); panel.append(gl); }

  panel.append(h("div", { class: "tests-filter" }, ...TEST_CATS.map((c) =>
    h("button", { class: "tcat" + (testsFilter === c ? " active" : ""), onclick: () => { testsFilter = c; renderTests(); }, text: c }))));

  const list = h("div", { class: "tests-list" });
  if (!tests.length) list.append(h("div", { class: "dock-empty", text: "No tests yet. Give the agent a goal — it authors tests here and runs them in the embedded browser." }));
  for (const t of tests) list.append(testRow(t));
  panel.append(list);
}
export function testRow(t) {
  const run = h("button", { class: "test-act", title: "Run this test", html: icon("send", 13), onclick: async () => {
    const r = await atom.testdir.run(state.project, t.id).catch(() => null);
    toast(`${t.title}: ${r ? r.status : "error"}`, r && r.status === "pass" ? "check" : "alert");
    renderTests();
  } });
  const del = h("button", { class: "test-act", title: "Delete", html: icon("trash", 13), onclick: () => confirmDialog({ title: "Delete test", message: `Delete “${t.title}”?`, confirmLabel: "Delete", danger: true, onConfirm: async () => { await atom.testdir.remove(state.project, t.id).catch(() => {}); renderTests(); } }) });
  return h("div", { class: "test-row" },
    h("div", { class: "test-row-top" },
      h("span", { class: "test-badge tb-" + (t.status || "unknown"), text: t.status || "unknown" }),
      h("span", { class: "test-name", text: t.title, title: t.title }),
      t.locked ? h("span", { class: "test-lock", title: "Locked to an approved spec — append-only", html: icon("shield", 11) }) : null,
      h("div", { class: "spacer" })),
    h("div", { class: "test-meta" },
      h("span", { class: "test-cat", text: t.category }),
      h("span", { class: "test-adp", title: t.adapter === "browser" ? "runs in the embedded browser" : "runs as a node process", text: t.adapter }),
      t.flaky ? h("span", { class: "test-flaky", text: "flaky" }) : null),
    (t.coveredFiles || []).length ? h("div", { class: "test-files", text: t.coveredFiles.slice(0, 3).map(baseName).join(" · ") }) : null,
    h("div", { class: "test-row-acts" }, run, del));
}
export async function runTestsCategory(cat) {
  if (!state.project) return;
  toast(cat ? `Running ${cat} tests…` : "Running all tests…", "refresh");
  const r = await atom.testdir.runSelection(state.project, cat ? { category: cat } : {}).catch(() => null);
  if (r) toast(`${r.pass}/${r.total} passed`, r.fail === 0 ? "check" : "alert");
  renderTests();
}
export const GOAL_BADGE = { draft: "Draft", approved: "Approved", authoring: "Authoring", building: "Building", red: "Red", fixing: "Fixing", gating: "Gating", complete: "Complete", blocked: "Blocked", "no-tests": "No tests" };
export function goalRow(g) {
  const acts = [];
  if (g.status === "draft" && (g.spec || []).length) acts.push(h("button", { class: "goal-act run", onclick: () => approveAndRun(g.id) }, h("span", { html: icon("check", 12) }), h("span", { text: "Approve & Run" })));
  else if (g.status === "blocked") acts.push(h("button", { class: "goal-act", onclick: () => approveAndRun(g.id, true) }, h("span", { html: icon("refresh", 12) }), h("span", { text: "Retry" })));
  return h("div", { class: "goal-row" },
    h("div", { class: "goal-row-top" },
      h("span", { class: "goal-badge gb-" + g.status, text: GOAL_BADGE[g.status] || g.status }),
      h("span", { class: "goal-name", text: g.prompt, title: g.prompt }), h("div", { class: "spacer" })),
    (g.spec || []).length ? h("div", { class: "goal-spec" }, ...g.spec.slice(0, 5).map((b) => h("div", { class: "goal-bullet" }, h("span", { class: "gbid", text: b.id }), h("span", { class: "gbtext", text: b.text })))) : null,
    acts.length ? h("div", { class: "goal-row-acts" }, ...acts) : null);
}
export async function planGoal() {
  const ta = $("goalInput");
  if (!ta || !state.project) return;
  const prompt = ta.value.trim();
  if (!prompt) return;
  ta.value = "";
  // Seed a one-bullet spec from the goal; a live spec-author agent refines this later.
  await atom.director.plan(state.project, prompt, { spec: [{ text: prompt }] }).catch((e) => toast(String((e && e.message) || e), "alert"));
  renderTests();
}
export async function approveAndRun(id, retry) {
  if (!state.project) return;
  if (!retry) await atom.director.approve(state.project, id).catch(() => {});
  renderTests();
  toast("Running goal to green…", "refresh");
  const r = await atom.director.run(state.project, id).catch((e) => ({ status: "error", reason: String((e && e.message) || e) }));
  toast(`Goal ${r.status}${r.reason ? " — " + r.reason : ""}`, r.status === "complete" ? "check" : "alert");
  renderTests();
}
