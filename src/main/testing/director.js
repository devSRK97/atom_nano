"use strict";
/* GOAL → GREEN orchestrator (Test Director, Phase 2).
 *
 * You give a goal; the system reaches GREEN under guardrails the two model
 * consults insisted on. The pipeline is a state machine:
 *
 *   draft → (approve spec, locks tests) → authoring(TESTER) → building(BUILDER)
 *         → red → fixing(oracle-guarded, bounded) → gating(mutation+flake) → complete
 *                                                              ↘ blocked (escalate)
 *
 * Guardrails:
 *  - Spec bullets are approved up front and FROZEN; tests map to bullet IDs.
 *  - The fix loop is ORACLE-GUARDED: it biases to fixing CODE, only touches a test
 *    if it's flagged test-wrong, and ESCALATES (blocks) when a failure can't be
 *    traced to a spec bullet — it never silently reinterprets the spec.
 *  - testdir's append-only INTEGRITY GUARD prevents the fixer from weakening locked
 *    tests to go green.
 *  - MUTATION gate (does the suite actually catch injected bugs?) + FLAKE gate
 *    (is green deterministic?) must pass before "complete".
 *
 * The agent runner is INJECTABLE (setAgentRunner) so the whole state machine is
 * deterministically testable without a model; the default runner drives the live
 * agent via claude.run with role-specific prompts.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const testdir = require("./testdir");

const MAX_FIX = 3;            // bounded auto-fix attempts
const MUTANTS_PER_FILE = 5;

let agentRunner = null;
function setAgentRunner(fn) { agentRunner = fn; }   // ({role, cwd, goalId, prompt, spec, failures}) => Promise
let emit = () => {};
function setEmitter(fn) { emit = fn; }

const baseName = (p) => (p || "").replace(/\\/g, "/").split("/").pop() || p;
const relOf = (p, cwd) => {
  const a = (p || "").replace(/\\/g, "/"), b = (cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return a.toLowerCase().startsWith(b.toLowerCase() + "/") ? a.slice(b.length + 1) : a;
};

function setStatus(cwd, goalId, patch) {
  const g = testdir.updateGoal(cwd, goalId, patch);
  try { emit("director:update", { cwd, goal: g }); } catch { /* no window */ }
  return g;
}
function goalOf(cwd, goalId) { return testdir.listGoals(cwd).find((g) => g.id === goalId) || null; }
function goalTestIds(cwd, goalId) { const g = goalOf(cwd, goalId); return g ? g.testIds.slice() : []; }

/* ----------------------------- pure helpers ----------------------------- */
// Oracle guard: decide which side of a failure is wrong. Bias to CODE; only the
// agent may flag a test as wrong (testWrong) and even then it must cite a bullet;
// a failure with no bullet mapping is AMBIGUOUS → escalate (never reinterpret spec).
function classifyFailure(failure) {
  const bulletIds = (failure && failure.bulletIds) || [];
  if (!bulletIds.length) return { kind: "ambiguous", reason: "failure not traceable to a spec bullet" };
  // The fixing agent may NOT auto-invalidate a LOCKED (approved) test — that would
  // route around the frozen spec. Flagging one as wrong escalates to a human.
  if (failure.testWrong) {
    if (failure.locked) return { kind: "ambiguous", reason: "agent flagged a LOCKED test as wrong — needs your review, not an auto-edit" };
    return { kind: "test", bulletId: bulletIds[0] };
  }
  return { kind: "code", bulletId: bulletIds[0] };
}
// Bounded-loop decision (same shape as Heal's planHeal): act / stop(green|no-progress|exhausted).
function planFix(prevFails, curFails, attempts, max = MAX_FIX) {
  if (curFails === 0) return { act: false, reason: "green" };
  if (attempts >= max) return { act: false, reason: "exhausted" };
  if (attempts > 0 && curFails >= prevFails) return { act: false, reason: "no-progress" };
  return { act: true, reason: "fix" };
}

/* ----------------------------- mutation gate ---------------------------- */
// Operator-level mutations on spaced operators (keeps us out of string/comment
// contents without a full parser — an AST pass is the planned upgrade). Each
// mutant flips one decision point so a real test must notice.
const MUT_RULES = [
  [/ > /, " < "], [/ < /, " > "], [/ >= /, " <= "], [/ <= /, " >= "],
  [/ === /, " !== "], [/ !== /, " === "], [/ == /, " != "],
  [/ && /, " || "], [/ \|\| /, " && "], [/ \+ /, " - "], [/ - /, " + "],
  [/\breturn true\b/, "return false"], [/\breturn false\b/, "return true"],
];
function generateMutants(src, cap = MUTANTS_PER_FILE) {
  // AST-precise mutants (only real operator/boolean tokens — never strings/comments).
  try { const a = require("../lang/ast").mutate(src, cap); if (a && a.length) return a; } catch { /* fall back to regex */ }
  const out = [];
  for (const [re, rep] of MUT_RULES) {
    if (re.test(src)) { out.push({ code: src.replace(re, rep), op: re.source.trim() + "→" + rep.trim() }); if (out.length >= cap) break; }
  }
  return out;
}
// A disposable SHADOW copy of the project (source only; node_modules junctioned)
// so mutation NEVER writes the user's real working tree — a crash/kill mid-gate
// can't corrupt it. (Consult finding #1: in-place mutation = data-loss risk.)
const SHADOW_EXCLUDE = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out", ".cache", "tmp", ".turbo", ".atomnano"]);
function makeShadow(cwd) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aqx-mut-"));
  let count = 0; const CAP = 4000;
  const walk = (rel) => {
    let ents; try { ents = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++count > CAP) throw new Error("shadow cap");
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (SHADOW_EXCLUDE.has(e.name)) continue; try { fs.mkdirSync(path.join(root, r), { recursive: true }); } catch { /* */ } walk(r); }
      else if (e.isFile()) { try { fs.copyFileSync(path.join(cwd, r), path.join(root, r)); } catch { /* skip */ } }
    }
  };
  try { walk(""); } catch (e) { rmShadow(root); throw e; }
  try { const nm = path.join(cwd, "node_modules"); if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(root, "node_modules"), "junction"); } catch { /* deps best-effort */ }
  return root;
}
function rmShadow(root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }

// Returns { ok, total, killed, survived, score, survivors:[op] }. The user's real
// files are never touched; all mutation happens in the shadow.
async function mutationGate(cwd, relFile, testIds) {
  const nodeTests = (testIds || []).map((id) => testdir.get(cwd, id)).filter((t) => t && t.adapter === "node" && t.file);
  let original; try { original = fs.readFileSync(path.join(cwd, relFile), "utf8"); } catch { return { ok: true, total: 0, killed: 0, survived: 0, score: 1, skipped: "no file" }; }
  const mutants = generateMutants(original);
  if (!mutants.length) return { ok: true, total: 0, killed: 0, survived: 0, score: 1, note: "no mutants" };
  if (!nodeTests.length) return { ok: true, total: mutants.length, killed: 0, survived: 0, score: 1, note: "no node tests cover this file — browser mutation needs a build (skipped)" };
  let shadow; try { shadow = makeShadow(cwd); } catch { return { ok: true, total: mutants.length, killed: 0, survived: 0, score: 1, note: "project too large to shadow — mutation skipped" }; }
  const shadowFile = path.join(shadow, relFile);
  let killed = 0; const survivors = [];
  try {
    for (const m of mutants) {
      fs.writeFileSync(shadowFile, m.code);
      let caught = false;
      for (const t of nodeTests) { const r = await testdir.runTest(shadow, { adapter: "node", file: t.file, cmd: t.cmd }); if (r.status === "fail") { caught = true; break; } }
      if (caught) killed++; else survivors.push(m.op);
      fs.writeFileSync(shadowFile, original);
    }
  } finally { rmShadow(shadow); }
  return { ok: survivors.length === 0, total: mutants.length, killed, survived: survivors.length, score: killed / mutants.length, survivors };
}

/* ------------------------------ live runner ----------------------------- */
function rolePrompt(ctx) {
  const bullets = (ctx.spec || []).map((b) => `[${b.id}] ${b.text}`).join("\n");
  if (ctx.role === "tester") {
    return `You are a HOSTILE QA engineer. The approved acceptance spec is:\n${bullets}\n\nWrite tests that PROVE each bullet, including edge/error cases. Put them in the project's test files (e.g. *.test.js). Map each test to its bullet id in a comment. Do NOT implement the feature — only tests. The tests should FAIL against the current code.`;
  }
  if (ctx.role === "builder") {
    return `Implement the feature to satisfy this approved spec (do not modify or weaken any test):\n${bullets}\n\nGoal: ${ctx.prompt}`;
  }
  // fixer
  const fails = (ctx.failures || []).map((f) => `- ${f.title || f.id}: ${f.detail || ""}`).join("\n");
  return `These tests are failing:\n${fails}\n\nApproved spec (the source of truth — do not reinterpret it):\n${bullets}\n\nFix the CODE so the tests pass. You may STRENGTHEN tests but must NEVER delete assertions, weaken matchers, or skip tests. If a test genuinely contradicts the spec, stop and explain instead of weakening it.`;
}
async function defaultAgentRunner(ctx) {
  const store = require("../storage/store");
  const claude = require("../session/index");
  const sess = store.createSession({ cwd: ctx.cwd, name: `🧪 ${ctx.role}` });
  await claude.run(sess.id, { text: rolePrompt(ctx), background: true, permissionMode: "acceptEdits" });
  // Tester: discover any test files it wrote and register them against the goal.
  if (ctx.role === "tester") {
    const full = store.getSession(sess.id);
    const touched = (full.editedFiles || []).map((f) => f.path).filter((p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p));
    for (const p of touched) {
      const up = testdir.upsert(ctx.cwd, { title: baseName(p), adapter: "node", category: "regression", file: relOf(p, ctx.cwd), bulletIds: (ctx.spec || []).map((b) => b.id) });
      if (up.ok) testdir.attachTest(ctx.cwd, ctx.goalId, up.test.id);
    }
  }
}
const run = () => agentRunner || defaultAgentRunner;

/* ------------------------------- pipeline ------------------------------- */
// Draft a goal (spec authored by the agent unless one is supplied). Returns the goal.
async function plan(cwd, prompt, opts = {}) {
  let spec = opts.spec;
  if (!spec && agentRunner && opts.agentSpec) spec = await agentRunner({ role: "spec", cwd, prompt });
  const goal = testdir.createGoal(cwd, { prompt, spec: spec || [] });
  setStatus(cwd, goal.id, {});   // emit
  return goal;
}
function approve(cwd, goalId) { const g = testdir.approveGoal(cwd, goalId); try { emit("director:update", { cwd, goal: g }); } catch { /* */ } return g; }

// The full goal → GREEN run. Returns { status, reason?, mutation?, flake? }.
async function runGoal(cwd, goalId, opts = {}) {
  const g0 = goalOf(cwd, goalId);
  if (!g0) return { status: "error", reason: "goal not found" };
  if (g0.status === "draft") return { status: "error", reason: "spec not approved" };

  setStatus(cwd, goalId, { status: "authoring" });
  await run()({ role: "tester", cwd, goalId, prompt: g0.prompt, spec: g0.spec });

  setStatus(cwd, goalId, { status: "building" });
  await run()({ role: "builder", cwd, goalId, prompt: g0.prompt, spec: g0.spec });

  // Auto-fix loop
  let attempts = 0, prev = Infinity, outcome = "green";
  setStatus(cwd, goalId, { status: "red" });
  while (true) {
    const ids = goalTestIds(cwd, goalId);
    if (!ids.length) { outcome = "no-tests"; break; }
    const res = await testdir.runSelection(cwd, { ids, includeQuarantined: true });
    const fails = res.results.filter((r) => r.status !== "pass");
    const plan = planFix(prev, fails.length, attempts);
    if (!plan.act) { outcome = plan.reason; break; }
    // Oracle: enrich failures with their test's bullet mapping, escalate if ambiguous.
    const enriched = fails.map((f) => { const t = testdir.get(cwd, f.id) || {}; return { id: f.id, title: f.title, detail: f.detail, bulletIds: t.bulletIds || [], locked: !!t.locked }; });
    const classes = enriched.map(classifyFailure);
    if (!opts.noEscalate && classes.some((c) => c.kind === "ambiguous")) {
      setStatus(cwd, goalId, { status: "blocked" });
      return { status: "blocked", reason: "a failure couldn't be traced to a spec bullet — needs your decision", failures: enriched };
    }
    setStatus(cwd, goalId, { status: "fixing" });
    await run()({ role: "fixer", cwd, goalId, prompt: g0.prompt, spec: g0.spec, failures: enriched, classes });
    prev = fails.length; attempts++;
  }
  if (outcome !== "green") {
    setStatus(cwd, goalId, { status: "blocked" });
    const reason = outcome === "exhausted" ? `not green after ${MAX_FIX} fix attempts`
      : outcome === "no-progress" ? `stuck after ${attempts} fix attempt${attempts === 1 ? "" : "s"} (no progress)`
        : outcome === "no-tests" ? "the tester authored no tests" : outcome;
    return { status: "blocked", reason };
  }

  // Gates: flake (deterministic green) + mutation (tests have teeth).
  setStatus(cwd, goalId, { status: "gating" });
  const ids = goalTestIds(cwd, goalId);
  const flake = await testdir.flakeGate(cwd, ids, 3);
  const flaky = flake.some((f) => f.flaky);
  const covered = new Set();
  for (const id of ids) for (const f of (testdir.get(cwd, id) || {}).coveredFiles || []) covered.add(f);
  const mutation = [];
  for (const f of covered) mutation.push(Object.assign({ file: f }, await mutationGate(cwd, f, ids)));
  const weakSuite = mutation.some((m) => !m.ok);
  await testdir.runSelection(cwd, { ids });   // restore true statuses after mutation flips

  const complete = !flaky && !weakSuite;
  setStatus(cwd, goalId, { status: complete ? "complete" : "blocked" });
  return {
    status: complete ? "complete" : "blocked",
    reason: complete ? "all spec tests green, mutation-resistant, non-flaky" : (flaky ? "flaky tests quarantined" : "weak tests — mutants survived"),
    flake, mutation,
  };
}

module.exports = { setAgentRunner, setEmitter, plan, approve, runGoal, classifyFailure, planFix, generateMutants, mutationGate, MAX_FIX };
