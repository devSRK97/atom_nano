"use strict";
/* TEST DIRECTOR — a per-project, self-maintaining test catalog + runner.
 *
 * The user gives a goal; the agent authors tests that encode it and drives code
 * to GREEN. This module owns the durable side of that: the catalog of tests, how
 * they're categorised (smoke / regression / e2e / unit / integration / visual),
 * which files each covers (impact selection), run history + flakiness, and the
 * SAFEGUARDS the two model consults insisted on:
 *
 *  - Capability ADAPTERS, not file-path "domain guessing": a test declares its
 *    adapter (browser → embedded Chromium via testhost; node → spawned process);
 *    classifyByImports() picks one from a source file's imports (react/DOM → browser,
 *    fs/net → node) so the CODE dictates the runner.
 *  - INTEGRITY GUARD (append-only): once a test is locked to an approved spec, a
 *    replacement may strengthen it but may NOT drop assertions or add skip/only —
 *    this is what stops an auto-fix loop from "going green" by deleting assertions.
 *  - Spec bullets carry stable IDs; tests map to bullet IDs so completion is
 *    traceable, and a flake gate keeps the green signal trustworthy.
 *
 * Storage: one JSON per project under userData/tests/<projectKey>.json (capped).
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CATEGORIES = ["smoke", "regression", "e2e", "unit", "integration", "visual"];
const DOMAINS = ["frontend", "backend", "library", "cli"];
const MAX_HISTORY = 100;
const NODE_TIMEOUT_MS = 60000;

const dir = () => path.join(app.getPath("userData"), "tests");
const keyOf = (p) => (p || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(-120) || "_";
const fileOf = (cwd) => path.join(dir(), keyOf(cwd) + ".json");
const uid = () => crypto.randomBytes(6).toString("hex");
const nowMs = () => Date.now();
const squash = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const relOf = (p, cwd) => {
  const a = (p || "").replace(/\\/g, "/"), b = (cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return a.toLowerCase().startsWith(b.toLowerCase() + "/") ? a.slice(b.length + 1) : a;
};

const cache = new Map();
const writeTimers = new Map();
function blank() { return { version: 1, tests: {}, goals: {}, impact: {}, history: [] }; }
function load(cwd) {
  const k = keyOf(cwd);
  if (cache.has(k)) return cache.get(k);
  let g = null;
  try { g = JSON.parse(fs.readFileSync(fileOf(cwd), "utf8")); } catch { /* fresh */ }
  if (!g || typeof g !== "object") g = blank();
  g.tests = g.tests || {}; g.goals = g.goals || {}; g.impact = g.impact || {}; g.history = g.history || [];
  cache.set(k, g);
  return g;
}
function scheduleSave(cwd) {
  const k = keyOf(cwd);
  if (writeTimers.has(k)) clearTimeout(writeTimers.get(k));
  writeTimers.set(k, setTimeout(() => {
    writeTimers.delete(k);
    try { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(fileOf(cwd), JSON.stringify(cache.get(k) || blank())); }
    catch { /* non-fatal */ }
  }, 500));
}
function saveNow(cwd) {
  const k = keyOf(cwd);
  if (writeTimers.has(k)) { clearTimeout(writeTimers.get(k)); writeTimers.delete(k); }
  try { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(fileOf(cwd), JSON.stringify(cache.get(k) || blank())); } catch { /* non-fatal */ }
}

/* -------------------------- capability adapters -------------------------- */
// Pick the runner from a source file's imports — the CODE decides, not a path
// heuristic (both consults: file-path domain guessing is brittle in monorepos).
const BROWSER_HINT = /\b(?:from\s+['"](?:react|react-dom|preact|vue|svelte|solid-js|@testing-library\/[^'"]+|@angular\/core)['"]|require\(['"](?:react|react-dom|@testing-library\/[^'"]+)['"]\)|\bdocument\.|window\.|customElements|HTMLElement)/;
const NODE_HINT = /\b(?:from\s+['"](?:fs|path|os|http|https|net|crypto|child_process|stream|express|fastify|koa|@nestjs\/[^'"]+|pg|mysql2?|mongodb)['"]|require\(['"](?:fs|path|os|http|https|net|express|fastify|koa)['"]\))/;
function classifyByImports(source, file) {
  try { const a = require("../lang/ast").classify(source, file); if (a) return a; } catch { /* fall back to regex below */ }
  const s = String(source || "");
  const browser = BROWSER_HINT.test(s);
  const node = NODE_HINT.test(s);
  if (browser && !node) return { adapter: "browser", domain: "frontend" };
  if (node && !browser) return { adapter: "node", domain: /express|fastify|koa|http|net|nest/.test(s) ? "backend" : "library" };
  if (browser && node) return { adapter: "browser", domain: "frontend" }; // SSR/full-stack file → exercise the UI surface
  return { adapter: "node", domain: "library" };
}

/* ------------------------ integrity guard (pure) ------------------------ */
// How many assertions a test carries: expect* steps (browser) or expect()/assert()
// /toMatchSnapshot occurrences (node source).
function assertionCount(t) {
  if (t && Array.isArray(t.steps)) return t.steps.filter((s) => /^expect/i.test(s && s.type || "")).length;
  const src = String((t && t.source) || "");
  try { const a = require("../lang/ast").assertions(src); if (a) return a.count; } catch { /* fall back */ }
  return (src.match(/\b(?:expect|assert)\s*\(/g) || []).length + (src.match(/toMatchSnapshot/g) || []).length;
}
function hasSkipOnly(t) {
  const src = String((t && t.source) || "");
  try { const a = require("../lang/ast").assertions(src); if (a) return a.hasSkipOnly; } catch { /* fall back */ }
  return /\b(?:\.skip|\.only|xit|xdescribe|fit|fdescribe)\b/.test(src);
}
// A replacement for a locked test may STRENGTHEN but never weaken. Returns the
// violations so the caller can block the change (or require user approval).
function checkIntegrity(oldT, newT) {
  const o = assertionCount(oldT), n = assertionCount(newT);
  const v = [];
  if (n < o) v.push(`assertions reduced (${o} → ${n})`);
  if (!hasSkipOnly(oldT) && hasSkipOnly(newT)) v.push("adds skip/only (disables a test)");
  const oSnap = (String((oldT && oldT.source) || "").match(/toMatchSnapshot/g) || []).length;
  const nSnap = (String((newT && newT.source) || "").match(/toMatchSnapshot/g) || []).length;
  if (nSnap < oSnap) v.push("removes a snapshot assertion");
  return { ok: v.length === 0, violations: v, oldAssertions: o, newAssertions: n };
}

/* ------------------------------- flake -------------------------------- */
function isFlaky(results) {
  const s = new Set((results || []).map((r) => (r && r.status) || r));
  return s.has("pass") && s.has("fail");
}

/* ------------------------------- catalog ------------------------------- */
function publicTest(t, cwd) {
  return {
    id: t.id, title: t.title, adapter: t.adapter, category: t.category, domain: t.domain,
    steps: t.steps || null, file: t.file || null, target: t.target || null,
    coveredFiles: (t.coveredFiles || []).map((f) => relOf(f, cwd)), tags: t.tags || [], bulletIds: t.bulletIds || [],
    originGoal: t.originGoal || null, status: t.status || "unknown", locked: !!t.locked,
    lastRunAt: t.lastRunAt || 0, durationMs: t.durationMs || 0,
    runCount: t.runCount || 0, passCount: t.passCount || 0, failCount: t.failCount || 0, flaky: !!t.flaky,
    createdAt: t.createdAt || 0, updatedAt: t.updatedAt || 0,
  };
}

function upsert(cwd, input = {}, opts = {}) {
  const g = load(cwd);
  const now = nowMs();
  let t = input.id && g.tests[input.id];
  // Integrity: replacing a LOCKED test may not weaken it.
  if (t && t.locked && !opts.force) {
    const integ = checkIntegrity(t, input);
    if (!integ.ok) return { ok: false, violations: integ.violations, test: publicTest(t, cwd) };
  }
  if (!t) { t = { id: input.id || uid(), createdAt: now, runCount: 0, passCount: 0, failCount: 0, status: "unknown" }; g.tests[t.id] = t; }
  t.title = squash(input.title) || t.title || "Untitled test";
  t.adapter = input.adapter === "node" ? "node" : (input.adapter === "browser" ? "browser" : (t.adapter || (input.steps ? "browser" : "node")));
  t.category = CATEGORIES.includes(input.category) ? input.category : (t.category || "regression");
  t.domain = DOMAINS.includes(input.domain) ? input.domain : (t.domain || (t.adapter === "browser" ? "frontend" : "library"));
  if (input.steps) t.steps = input.steps;
  if (input.target) t.target = input.target;
  if (input.file != null) t.file = input.file;
  if (input.cmd != null) t.cmd = input.cmd;
  if (Array.isArray(input.coveredFiles)) t.coveredFiles = input.coveredFiles.map((f) => relOf(f, cwd));
  if (Array.isArray(input.tags)) t.tags = input.tags.map(squash).filter(Boolean).slice(0, 12);
  if (Array.isArray(input.bulletIds)) t.bulletIds = input.bulletIds.slice(0, 24);
  if (input.originGoal) t.originGoal = input.originGoal;
  if (typeof input.source === "string") t.source = input.source.slice(0, 20000); // kept for integrity diffing of node tests
  t.updatedAt = now;
  reindexImpact(g);
  scheduleSave(cwd);
  return { ok: true, test: publicTest(t, cwd) };
}

function reindexImpact(g) {
  const impact = {};
  for (const t of Object.values(g.tests)) for (const f of (t.coveredFiles || [])) (impact[f] = impact[f] || []).push(t.id);
  g.impact = impact;
}

function list(cwd, filter = {}) {
  const g = load(cwd);
  let arr = Object.values(g.tests).map((t) => publicTest(t, cwd));
  if (filter.category) arr = arr.filter((t) => t.category === filter.category);
  if (filter.domain) arr = arr.filter((t) => t.domain === filter.domain);
  if (filter.status) arr = arr.filter((t) => t.status === filter.status);
  if (filter.goal) arr = arr.filter((t) => t.originGoal === filter.goal);
  if (filter.tag) arr = arr.filter((t) => (t.tags || []).includes(filter.tag));
  return arr.sort((a, b) => (b.updatedAt - a.updatedAt));
}
function get(cwd, id) { const g = load(cwd); return g.tests[id] ? publicTest(g.tests[id], cwd) : null; }
function remove(cwd, id) { const g = load(cwd); const had = !!g.tests[id]; delete g.tests[id]; reindexImpact(g); scheduleSave(cwd); return had; }
function retag(cwd, id, patch = {}) { return upsert(cwd, { id, category: patch.category, tags: patch.tags }); }
function lock(cwd, id, on = true) { const g = load(cwd); if (g.tests[id]) { g.tests[id].locked = !!on; g.tests[id].updatedAt = nowMs(); scheduleSave(cwd); return true; } return false; }

// Reverse import graph: dependency → files that import it (transitively). Lets a
// change to a core file select every test that *transitively* exercises it, not
// just tests that name the file directly (consult: regex/editedFiles miss re-exports).
const importGraphCache = new Map();
const SRC_EXCLUDE = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out", ".cache", ".turbo", ".atomnano"]);
function listSourceFiles(cwd) {
  const out = []; let count = 0; const CAP = 3000;
  const walkDir = (rel) => {
    let ents; try { ents = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (count > CAP) return;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (SRC_EXCLUDE.has(e.name)) continue; walkDir(r); }
      else if (e.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) { out.push(r); count++; }
    }
  };
  walkDir("");
  return out;
}
function buildImportGraph(cwd) {
  const k = keyOf(cwd);
  const cached = importGraphCache.get(k);
  if (cached && (nowMs() - cached.at) < 15000) return cached;     // short TTL — rebuild after edits
  const ast = require("../lang/ast");
  const reverse = new Map();
  for (const rel of listSourceFiles(cwd)) {
    const abs = path.join(cwd, rel);
    let src; try { src = fs.readFileSync(abs, "utf8"); } catch { continue; }
    for (const spec of (ast.imports(src, abs) || [])) {
      const resolved = ast.resolveImport(abs, spec);
      if (!resolved) continue;
      const depRel = relOf(resolved.replace(/\\/g, "/"), cwd);
      if (!reverse.has(depRel)) reverse.set(depRel, new Set());
      reverse.get(depRel).add(rel);
    }
  }
  const g = { at: nowMs(), reverse };
  importGraphCache.set(k, g);
  return g;
}
// --- Non-blocking variant for the SEND path -------------------------------
// buildImportGraph() reads + AST-parses every source file SYNCHRONOUSLY. On a
// large repo that's a multi-second main-thread block — and it sits on the prompt
// path (context.compose → importHotspots), so every orienting turn whose 15s
// cache had expired froze the whole app until the parse finished. Here we never
// build synchronously: return whatever is cached (even stale) instantly and, if
// it's stale/missing, refresh in the background in small chunks that yield to the
// event loop so the UI never freezes. The hotspot list is just orientation
// context — being one turn stale (or empty on the very first send) is harmless.
const importGraphBuilding = new Set();   // cwds with an in-flight background rebuild
function graphFresh(cwd) { const c = importGraphCache.get(keyOf(cwd)); return !!(c && (nowMs() - c.at) < 60000); }
async function refreshImportGraph(cwd) {
  const k = keyOf(cwd);
  if (importGraphBuilding.has(k) || graphFresh(cwd)) return;
  importGraphBuilding.add(k);
  try {
    const ast = require("../lang/ast");
    const files = listSourceFiles(cwd);
    const reverse = new Map();
    for (let i = 0; i < files.length; i++) {
      const abs = path.join(cwd, files[i]);
      let src; try { src = fs.readFileSync(abs, "utf8"); } catch { continue; }
      for (const spec of (ast.imports(src, abs) || [])) {
        const resolved = ast.resolveImport(abs, spec);
        if (!resolved) continue;
        const depRel = relOf(resolved.replace(/\\/g, "/"), cwd);
        if (!reverse.has(depRel)) reverse.set(depRel, new Set());
        reverse.get(depRel).add(files[i]);
      }
      // Yield to the event loop every 64 files so parsing thousands of them never
      // blocks streaming / input for more than a few ms at a time.
      if ((i & 63) === 63) await new Promise((r) => setImmediate(r));
    }
    importGraphCache.set(k, { at: nowMs(), reverse });
  } catch { /* keep whatever was cached */ }
  finally { importGraphBuilding.delete(k); }
}

// Most depended-on files (load-bearing) — surfaced in the auto-context block.
// Non-blocking: uses the cached graph and warms it in the background.
function importHotspots(cwd, n = 6) {
  if (!graphFresh(cwd)) Promise.resolve().then(() => refreshImportGraph(cwd)).catch(() => {});
  const g = importGraphCache.get(keyOf(cwd));
  if (!g) return [];
  return [...g.reverse.entries()].map(([file, importers]) => ({ file, importers: importers.size }))
    .sort((a, b) => b.importers - a.importers).slice(0, n);
}
function affectedFiles(cwd, changedFiles) {
  const g = buildImportGraph(cwd);
  const seed = changedFiles.map((f) => relOf(f, cwd).replace(/\\/g, "/"));
  const out = new Set(seed);
  const queue = [...seed];
  while (queue.length) {
    const f = queue.shift();
    const importers = g.reverse.get(f);
    if (importers) for (const imp of importers) if (!out.has(imp)) { out.add(imp); queue.push(imp); }
  }
  return [...out];
}

// Choose which tests to run. The big lever is `changedFiles` → impact selection:
// only tests that cover something you (transitively) touched; full categories
// (smoke/regression) for the gates.
function select(cwd, sel = {}) {
  const g = load(cwd);
  let ids;
  if (Array.isArray(sel.ids) && sel.ids.length) ids = sel.ids.filter((id) => g.tests[id]);
  else if (Array.isArray(sel.changedFiles) && sel.changedFiles.length) {
    const want = new Set();
    // expand the changed set to every file that transitively imports them
    const affected = new Set(affectedFiles(cwd, sel.changedFiles).map((f) => f.toLowerCase()));
    for (const [f, list] of Object.entries(g.impact)) if (affected.has(String(f).toLowerCase())) for (const id of list) want.add(id);
    ids = [...want];
  } else ids = Object.keys(g.tests);
  let tests = ids.map((id) => g.tests[id]).filter(Boolean);
  if (sel.category) tests = tests.filter((t) => t.category === sel.category);
  if (sel.domain) tests = tests.filter((t) => t.domain === sel.domain);
  if (sel.tag) tests = tests.filter((t) => (t.tags || []).includes(sel.tag));
  if (!sel.includeQuarantined) tests = tests.filter((t) => t.status !== "quarantined");
  return tests.map((t) => publicTest(t, cwd));
}

function recordRun(cwd, id, { status, durationMs } = {}) {
  const g = load(cwd);
  const t = g.tests[id];
  if (!t) return null;
  t.runCount = (t.runCount || 0) + 1;
  if (status === "pass") t.passCount = (t.passCount || 0) + 1;
  else if (status === "fail") t.failCount = (t.failCount || 0) + 1;
  t.status = status || t.status;
  t.lastRunAt = nowMs();
  if (durationMs != null) t.durationMs = durationMs;
  scheduleSave(cwd);
  return publicTest(t, cwd);
}

/* ------------------------------- runners ------------------------------- */
async function runNode(cwd, t) {
  const { spawn } = require("child_process");
  const store = require("../storage/store");
  const tmpl = (t.cmd || (store.getSettings && store.getSettings().testCommand) || "node {file}");
  const cmdline = String(tmpl).replace("{file}", t.file || "");
  return await new Promise((resolve) => {
    const t0 = nowMs();
    let done = false;
    const child = spawn(cmdline, { cwd, shell: true });
    let out = "";
    const onEnd = (code) => { if (done) return; done = true; resolve({ status: code === 0 ? "pass" : "fail", durationMs: nowMs() - t0, detail: out.slice(-2000) }); };
    child.stdout && child.stdout.on("data", (d) => { out += d; });
    child.stderr && child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => { if (!done) { done = true; resolve({ status: "fail", durationMs: nowMs() - t0, detail: String(e && e.message || e) }); } });
    child.on("close", onEnd);
    setTimeout(() => { if (!done) { try { child.kill(); } catch { /* */ } done = true; resolve({ status: "fail", durationMs: nowMs() - t0, detail: "timed out" }); } }, NODE_TIMEOUT_MS);
  });
}

async function runTest(cwd, idOrTest, opts = {}) {
  const g = load(cwd);
  const t = typeof idOrTest === "string" ? g.tests[idOrTest] : idOrTest;
  if (!t) return { status: "fail", detail: "test not found" };
  let res;
  if (t.adapter === "browser") {
    const host = require("./testhost");
    const r = await host.runSteps(t.target, t.steps, { now: nowMs, continueOnFail: !!opts.continueOnFail });
    res = { status: r.ok ? "pass" : "fail", durationMs: (r.steps || []).length ? undefined : 0, detail: r.error || (r.steps || []).map((s) => `${s.type}${s.ok ? "✓" : "✗ " + (s.detail || "")}`).join(" "), steps: r.steps };
  } else {
    res = await runNode(cwd, t);
  }
  if (t.id) recordRun(cwd, t.id, { status: res.status, durationMs: res.durationMs });
  return Object.assign({ id: t.id, title: t.title }, res);
}

async function runSelection(cwd, sel = {}, opts = {}) {
  const tests = Array.isArray(sel) ? sel : select(cwd, sel);
  const results = [];
  for (const t of tests) results.push(await runTest(cwd, t.id, opts));
  const pass = results.filter((r) => r.status === "pass").length;
  return { total: results.length, pass, fail: results.length - pass, results };
}

// Flake gate: run each test N times; if results disagree → quarantine it so the
// green signal stays trustworthy (both consults' #3 risk).
async function flakeGate(cwd, ids, n = 3) {
  const g = load(cwd);
  const report = [];
  for (const id of ids) {
    if (!g.tests[id]) continue;
    const runs = [];
    for (let i = 0; i < Math.max(2, n); i++) runs.push(await runTest(cwd, id));
    const flaky = isFlaky(runs);
    if (flaky) { g.tests[id].flaky = true; g.tests[id].status = "quarantined"; g.tests[id].updatedAt = nowMs(); }
    report.push({ id, flaky, statuses: runs.map((r) => r.status) });
  }
  scheduleSave(cwd);
  return report;
}

/* -------------------------------- goals -------------------------------- */
function createGoal(cwd, { prompt, spec } = {}) {
  const g = load(cwd);
  const id = uid(), now = nowMs();
  const bullets = (Array.isArray(spec) ? spec : []).map((b) => ({ id: (b && b.id) || uid().slice(0, 4), text: squash(typeof b === "string" ? b : b && b.text) })).filter((b) => b.text);
  g.goals[id] = { id, prompt: squash(prompt), spec: bullets, status: "draft", testIds: [], createdAt: now, updatedAt: now, approvedAt: 0 };
  scheduleSave(cwd);
  return g.goals[id];
}
function updateGoal(cwd, id, patch = {}) {
  const g = load(cwd); const go = g.goals[id]; if (!go) return null;
  if (Array.isArray(patch.spec)) go.spec = patch.spec.map((b) => ({ id: (b && b.id) || uid().slice(0, 4), text: squash(typeof b === "string" ? b : b && b.text) })).filter((b) => b.text);
  if (patch.status) go.status = patch.status;
  if (patch.prompt != null) go.prompt = squash(patch.prompt);
  go.updatedAt = nowMs();
  scheduleSave(cwd);
  return go;
}
// Approving the spec freezes it: its tests are LOCKED (append-only) from here.
function approveGoal(cwd, id) {
  const g = load(cwd); const go = g.goals[id]; if (!go) return null;
  go.status = "approved"; go.approvedAt = nowMs(); go.updatedAt = go.approvedAt;
  for (const tid of go.testIds) if (g.tests[tid]) g.tests[tid].locked = true;
  scheduleSave(cwd);
  return go;
}
function attachTest(cwd, goalId, testId) {
  const g = load(cwd); const go = g.goals[goalId]; if (!go || !g.tests[testId]) return false;
  if (!go.testIds.includes(testId)) go.testIds.push(testId);
  g.tests[testId].originGoal = goalId;
  if (go.approvedAt) g.tests[testId].locked = true;   // tests authored after spec approval are still locked
  scheduleSave(cwd);
  return true;
}
function listGoals(cwd) { return Object.values(load(cwd).goals).sort((a, b) => b.createdAt - a.createdAt); }
// A goal is GREEN when every attached test passes (none failing/quarantined/unknown).
function goalGreen(cwd, id) {
  const g = load(cwd); const go = g.goals[id]; if (!go) return false;
  const ts = go.testIds.map((t) => g.tests[t]).filter(Boolean);
  return ts.length > 0 && ts.every((t) => t.status === "pass");
}

function peek(cwd) {
  const g = load(cwd);
  const tests = Object.values(g.tests);
  const byCat = {}; for (const c of CATEGORIES) byCat[c] = tests.filter((t) => t.category === c).length;
  return {
    total: tests.length, byCategory: byCat,
    pass: tests.filter((t) => t.status === "pass").length,
    fail: tests.filter((t) => t.status === "fail").length,
    quarantined: tests.filter((t) => t.status === "quarantined").length,
    goals: Object.keys(g.goals).length,
  };
}

module.exports = {
  CATEGORIES, DOMAINS,
  classifyByImports, checkIntegrity, isFlaky,
  list, get, upsert, remove, retag, lock, select, recordRun, importHotspots,
  runTest, runSelection, flakeGate,
  createGoal, updateGoal, approveGoal, attachTest, listGoals, goalGreen,
  peek, saveNow,
};
