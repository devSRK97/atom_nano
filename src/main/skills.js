"use strict";
/* Per-project SKILLS — named, reusable procedures the agent can invoke, plus an
 * "apprentice" that LEARNS them from your repeated work.
 *
 *  - Skill builder (manual): create/edit named procedures with steps + typical
 *    files + trigger keywords. Invoking one injects its procedure as guidance so
 *    the agent follows your established pattern instead of re-deriving it.
 *  - Apprentice (learned): every finished run is logged (intent + files + tools).
 *    When the same intent signature recurs >= MIN_OCCURRENCES, a "suggested"
 *    skill is proposed (common files, trigger words). Promote it to make it real.
 *
 * The point: the agent gets measurably better at THIS repo over time, and spends
 * fewer exploratory tokens because the known shape of a task is handed to it.
 *
 * Storage mirrors graph.js: one JSON per project under userData/skills/<key>.json,
 * everything capped so it can't grow unbounded.
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_RUNS = 240;          // recent run-log entries kept for mining
const MAX_SKILLS = 80;         // total skills (active + suggested) per project
const MIN_OCCURRENCES = 3;     // a pattern must recur this many times to be suggested
const DIGEST_BUDGET = 1200;    // chars injected when a skill matches

const STOP = new Set("the a an to of for in on and or with my our your please can could would i we it this that these those is are be add fix update make change create implement set get use run remove delete refactor into from at as new now also just then so do can will need want let".split(" "));

const dir = () => path.join(app.getPath("userData"), "skills");
const keyOf = (p) => (p || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(-120) || "_";
const fileOf = (cwd) => path.join(dir(), keyOf(cwd) + ".json");
const uid = () => crypto.randomBytes(6).toString("hex");
const slugify = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "skill";

const cache = new Map();
const writeTimers = new Map();

function blank() { return { skills: {}, runs: [], version: 1 }; }
function load(cwd) {
  const k = keyOf(cwd);
  if (cache.has(k)) return cache.get(k);
  let g = null;
  try { g = JSON.parse(fs.readFileSync(fileOf(cwd), "utf8")); } catch { /* fresh */ }
  if (!g || typeof g !== "object") g = blank();
  g.skills = g.skills && typeof g.skills === "object" ? g.skills : {};
  g.runs = Array.isArray(g.runs) ? g.runs : [];
  if (cwd) g._project = cwd;
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
  }, 600));
}

const squash = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const baseName = (p) => (p || "").replace(/\\/g, "/").split("/").pop() || p;
const rel = (p, cwd) => {
  const a = (p || "").replace(/\\/g, "/"), b = (cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return a.toLowerCase().startsWith(b.toLowerCase() + "/") ? a.slice(b.length + 1) : a;
};

// Significant words of a prompt (verbs/nouns), stopwords removed — the basis of
// both the learned "intent signature" and a skill's trigger keywords.
function keywords(text, n = 6) {
  const seen = new Set(), out = [];
  for (const w of squash(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w); out.push(w);
    if (out.length >= n) break;
  }
  return out;
}
// The two most salient (longest → most specific) keywords form the signature that
// clusters similar runs — order-independent, and robust to filler words.
function signatureOf(text) {
  const ws = keywords(text, 8);
  ws.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return ws.slice(0, 2).sort().join("+");
}

function publicSkill(s, cwd) {
  return {
    id: s.id, name: s.name, slug: s.slug, description: s.description || "",
    steps: s.steps || "", params: s.params || [], triggers: s.triggers || [],
    files: (s.files || []).map((f) => rel(f, cwd)), source: s.source || "manual",
    status: s.status || "active", uses: s.uses || 0, lastUsed: s.lastUsed || 0,
    createdAt: s.createdAt || 0, updatedAt: s.updatedAt || 0,
  };
}

function list(cwd) {
  const g = load(cwd);
  return Object.values(g.skills)
    .map((s) => publicSkill(s, cwd))
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) || (b.uses - a.uses) || (b.updatedAt - a.updatedAt));
}
function get(cwd, idOrSlug) {
  const g = load(cwd);
  return g.skills[idOrSlug] || Object.values(g.skills).find((s) => s.slug === idOrSlug) || null;
}

function uniqueSlug(g, base) {
  let slug = base, i = 2;
  const taken = new Set(Object.values(g.skills).map((s) => s.slug));
  while (taken.has(slug)) slug = `${base}-${i++}`;
  return slug;
}

function create(cwd, input = {}) {
  const g = load(cwd);
  const now = Date.now();
  const id = uid();
  const name = squash(input.name) || "Untitled skill";
  const s = {
    id, name, slug: uniqueSlug(g, slugify(input.slug || name)),
    description: squash(input.description), steps: String(input.steps || "").trim(),
    params: Array.isArray(input.params) ? input.params.slice(0, 12) : [],
    triggers: Array.isArray(input.triggers) && input.triggers.length ? input.triggers.map(squash).filter(Boolean).slice(0, 12) : keywords(name + " " + (input.description || "")),
    files: Array.isArray(input.files) ? input.files.slice(0, 40) : [],
    source: input.source === "learned" ? "learned" : input.source === "imported" ? "imported" : "manual",
    status: input.status === "suggested" ? "suggested" : "active",
    uses: 0, lastUsed: 0, createdAt: now, updatedAt: now,
  };
  g.skills[id] = s;
  capSkills(g);
  scheduleSave(cwd);
  return publicSkill(s, cwd);
}
function update(cwd, id, patch = {}) {
  const g = load(cwd);
  const s = g.skills[id];
  if (!s) return null;
  for (const k of ["name", "description", "steps"]) if (k in patch) s[k] = typeof patch[k] === "string" ? (k === "steps" ? patch[k] : squash(patch[k])) : s[k];
  if (Array.isArray(patch.params)) s.params = patch.params.slice(0, 12);
  if (Array.isArray(patch.triggers)) s.triggers = patch.triggers.map(squash).filter(Boolean).slice(0, 12);
  if (Array.isArray(patch.files)) s.files = patch.files.slice(0, 40);
  if (patch.status === "active" || patch.status === "suggested") s.status = patch.status;
  s.updatedAt = Date.now();
  scheduleSave(cwd);
  return publicSkill(s, cwd);
}
function remove(cwd, id) { const g = load(cwd); const had = !!g.skills[id]; delete g.skills[id]; scheduleSave(cwd); return had; }
function promote(cwd, id) { return update(cwd, id, { status: "active" }); }

function capSkills(g) {
  const ids = Object.keys(g.skills);
  if (ids.length <= MAX_SKILLS) return;
  // drop the weakest suggestions first (least used, oldest), never active+used ones lightly
  ids.sort((a, b) => {
    const x = g.skills[a], y = g.skills[b];
    const rank = (s) => (s.status === "active" ? 1000 : 0) + (s.uses || 0);
    return rank(x) - rank(y);
  });
  for (const id of ids.slice(0, ids.length - MAX_SKILLS)) delete g.skills[id];
}

// (The run-log apprentice — recordRun / mine / autoCreate — and prompt auto-matching
//  were removed: skills are applied only when the user explicitly selects them.)

// Mark a skill used + return the procedure text the user asked to apply.
function invoke(cwd, idOrSlug) {
  const s = get(cwd, idOrSlug);
  if (!s) return null;
  s.uses = (s.uses || 0) + 1; s.lastUsed = Date.now();
  scheduleSave(cwd);
  return digestFor(s, cwd);
}
function digestFor(s, cwd) {
  const parts = [`Skill "${s.name}"${s.description ? " — " + s.description : ""}.`];
  if (s.steps) parts.push(s.steps);
  if ((s.files || []).length) parts.push("Relevant files: " + s.files.map((f) => rel(f, cwd)).join(", "));
  let out = parts.join("\n");
  if (out.length > DIGEST_BUDGET) out = out.slice(0, DIGEST_BUDGET - 1) + "…";
  return out;
}

function peek(cwd) {
  const g = load(cwd);
  const all = Object.values(g.skills);
  return { skills: all.length, active: all.filter((s) => s.status === "active").length, suggested: all.filter((s) => s.status === "suggested").length, runs: g.runs.length };
}

/* ============================================================
   SKILL HUB — built-in curated skill templates
   ============================================================ */
const SKILL_HUB = [
  { id: "hub-api-endpoint", name: "Add API Endpoint", category: "Backend", popular: true,
    description: "Create a REST API endpoint with validation, error handling, and tests",
    tags: ["api", "rest", "endpoint", "route", "handler"],
    triggers: ["api", "endpoint", "route", "handler"],
    steps: "1. Create route handler in the appropriate router file\n2. Define request/response schema with input validation\n3. Implement the handler with proper error handling and status codes\n4. Add authentication/authorization middleware if needed\n5. Write unit tests covering happy path and error cases\n6. Update API documentation or OpenAPI spec" },
  { id: "hub-db-migration", name: "Database Migration", category: "Backend", popular: true,
    description: "Create a database schema migration with rollback support",
    tags: ["database", "migration", "schema", "sql", "alter"],
    triggers: ["migration", "database", "schema", "alter"],
    steps: "1. Create a new migration file with timestamp naming\n2. Write the UP migration (create/alter tables, add columns, indexes)\n3. Write the DOWN migration (reverse of UP for rollback)\n4. Test the migration against a fresh database\n5. Test the rollback to ensure clean revert\n6. Update seed data if schema changes affect it" },
  { id: "hub-auth-flow", name: "Authentication Flow", category: "Backend",
    description: "Implement JWT/session auth with login, register, and middleware",
    tags: ["auth", "jwt", "login", "session", "middleware"],
    triggers: ["auth", "login", "jwt", "authentication"],
    steps: "1. Set up user model with hashed password storage (bcrypt/argon2)\n2. Create registration endpoint with input validation\n3. Create login endpoint returning JWT or session token\n4. Build auth middleware that validates tokens on protected routes\n5. Add token refresh/rotation mechanism\n6. Implement logout and token invalidation\n7. Add rate limiting to auth endpoints" },
  { id: "hub-error-handler", name: "Error Handling", category: "Backend",
    description: "Add structured error handling with logging, codes, and safe messages",
    tags: ["error", "handling", "exception", "logging", "middleware"],
    triggers: ["error", "handling", "exception", "catch"],
    steps: "1. Define error classes/types with codes and HTTP status mapping\n2. Create a centralized error handler middleware\n3. Add try/catch blocks to async route handlers\n4. Log errors with context (request ID, user, timestamp)\n5. Return user-friendly messages (never expose internal details)\n6. Add error monitoring/alerting integration" },
  { id: "hub-react-component", name: "React Component", category: "Frontend", popular: true,
    description: "Scaffold a React component with TypeScript, props, hooks, and tests",
    tags: ["react", "component", "typescript", "frontend", "scaffold"],
    triggers: ["component", "react", "scaffold", "widget"],
    steps: "1. Create the component file with TypeScript interface for props\n2. Implement the component with hooks for state and effects\n3. Add CSS modules or styled-components for styling\n4. Create unit tests with React Testing Library\n5. Add Storybook story if applicable\n6. Export from the module index file" },
  { id: "hub-form-validation", name: "Form with Validation", category: "Frontend",
    description: "Build a form with client-side validation, error messages, and submission",
    tags: ["form", "validation", "input", "frontend", "schema"],
    triggers: ["form", "validation", "input", "fields"],
    steps: "1. Define form fields and validation rules (required, format, length)\n2. Create the form component with controlled inputs\n3. Implement validation logic with inline error display\n4. Handle submission with loading and disabled states\n5. Display server-side validation errors\n6. Ensure accessibility (labels, aria-invalid, focus management)" },
  { id: "hub-state-mgmt", name: "State Management", category: "Frontend",
    description: "Set up global state with actions, selectors, and persistence",
    tags: ["state", "redux", "zustand", "context", "store"],
    triggers: ["state", "store", "redux", "zustand"],
    steps: "1. Choose the state management approach (Context, Zustand, Redux)\n2. Define the state shape with types/interfaces\n3. Create actions/mutations for state changes\n4. Create selectors for derived state\n5. Set up persistence if needed (localStorage, IndexedDB)\n6. Connect components to the store\n7. Add devtools integration for debugging" },
  { id: "hub-rest-client", name: "API Client Layer", category: "Frontend",
    description: "Build a typed HTTP client with interceptors, retry, and caching",
    tags: ["api", "client", "fetch", "http", "axios"],
    triggers: ["client", "fetch", "http", "axios"],
    steps: "1. Create a base HTTP client (fetch wrapper or Axios instance)\n2. Add request/response interceptors (auth token, logging)\n3. Define typed endpoint functions matching the API\n4. Add error handling with typed error responses\n5. Implement retry logic for transient failures\n6. Add request deduplication and response caching" },
  { id: "hub-unit-tests", name: "Unit Test Suite", category: "Testing", popular: true,
    description: "Generate comprehensive unit tests with edge cases and mocks",
    tags: ["test", "unit", "jest", "vitest", "testing", "coverage"],
    triggers: ["test", "unit", "coverage", "jest"],
    steps: "1. Identify the module's public API and side effects\n2. Write tests for each public function/method\n3. Cover happy path with expected inputs and outputs\n4. Add edge cases: empty inputs, boundary values, null/undefined\n5. Mock external dependencies (APIs, databases, file system)\n6. Verify error handling paths throw or return correctly\n7. Check coverage and add tests for missing branches" },
  { id: "hub-e2e-test", name: "E2E Test", category: "Testing",
    description: "Write end-to-end tests with Playwright or Cypress",
    tags: ["e2e", "playwright", "cypress", "browser", "integration"],
    triggers: ["e2e", "playwright", "cypress", "end-to-end"],
    steps: "1. Set up the test framework (Playwright/Cypress)\n2. Create page objects for the pages under test\n3. Write the test scenario: navigate, interact, assert\n4. Add assertions for element visibility and content\n5. Handle async operations (waits, network requests)\n6. Add test data setup and teardown\n7. Configure headless execution for CI" },
  { id: "hub-docker", name: "Docker Setup", category: "DevOps", popular: true,
    description: "Create Dockerfile and docker-compose with multi-stage build",
    tags: ["docker", "container", "dockerfile", "compose", "deploy"],
    triggers: ["docker", "container", "dockerfile", "compose"],
    steps: "1. Create a multi-stage Dockerfile (build stage + production stage)\n2. Use appropriate base image, set working directory\n3. Copy dependency manifests first and install (layer caching)\n4. Copy source and build the application\n5. Create docker-compose.yml with services, networks, volumes\n6. Add .dockerignore to exclude unnecessary files\n7. Add health check endpoint and Docker HEALTHCHECK" },
  { id: "hub-ci-pipeline", name: "CI Pipeline", category: "DevOps",
    description: "Set up GitHub Actions or GitLab CI with test, lint, build, deploy",
    tags: ["ci", "cd", "pipeline", "github-actions", "gitlab-ci"],
    triggers: ["pipeline", "github", "actions", "gitlab"],
    steps: "1. Create the CI config file (.github/workflows/ or .gitlab-ci.yml)\n2. Define stages: install dependencies, lint, test, build\n3. Set up dependency caching for faster builds\n4. Configure test runner with coverage reporting\n5. Add deployment step (staging on PR merge, production on tag)\n6. Set up failure notifications\n7. Add branch protection rules requiring CI pass" },
  { id: "hub-security-audit", name: "Security Audit", category: "DevOps",
    description: "OWASP top-10 checklist for code review and hardening",
    tags: ["security", "owasp", "audit", "vulnerability", "hardening"],
    triggers: ["security", "audit", "vulnerability", "owasp"],
    steps: "1. Check for injection vulnerabilities (SQL, NoSQL, command, XSS)\n2. Verify authentication and session management\n3. Check authorization on every endpoint and resource\n4. Review sensitive data handling (encryption, logging, exposure)\n5. Scan dependencies for known vulnerabilities\n6. Check CORS, CSP, and security headers\n7. Review error handling (no stack traces in responses)\n8. Verify rate limiting and brute-force protection" },
  { id: "hub-refactor", name: "Extract & Refactor", category: "Workflow",
    description: "Extract method, class, or module while preserving behavior",
    tags: ["refactor", "extract", "clean", "module", "decouple"],
    triggers: ["refactor", "extract", "clean", "decouple"],
    steps: "1. Identify the code to extract (duplicated or complex logic)\n2. Write tests for existing behavior if missing\n3. Extract into a new function/class/module with clear interface\n4. Replace original code with call to extracted unit\n5. Run tests to verify behavior is unchanged\n6. Update imports and exports\n7. Remove any dead code left behind" },
  { id: "hub-debug", name: "Debug Investigation", category: "Workflow", popular: true,
    description: "Systematic debugging: reproduce, bisect, root-cause, fix, verify",
    tags: ["debug", "bug", "investigate", "fix", "bisect"],
    triggers: ["debug", "bug", "investigate", "broken"],
    steps: "1. Reproduce the bug reliably (exact steps, inputs, environment)\n2. Read the error message and stack trace carefully\n3. Add targeted logging around the suspected area\n4. Bisect: narrow down which change introduced the bug\n5. Identify the root cause (not just the symptom)\n6. Write a failing test that captures the bug\n7. Fix the root cause\n8. Verify the fix passes and doesn't regress" },
];
const HUB_CATEGORIES = ["All", "Backend", "Frontend", "Testing", "DevOps", "Workflow"];

/* ============================================================
   MARKETPLACE — cross-project, hub, scout, import
   ============================================================ */

function hub(category) {
  if (!category || category === "All") return SKILL_HUB;
  return SKILL_HUB.filter((s) => s.category === category);
}

function crossProject(cwd) {
  const myKey = keyOf(cwd);
  const skillsDir = dir();
  const results = [];
  let files;
  try { files = fs.readdirSync(skillsDir); } catch { return results; }
  for (const file of files) {
    if (!file.endsWith(".json") || file === myKey + ".json") continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(skillsDir, file), "utf8"));
      const projName = raw._project ? path.basename(raw._project) : file.replace(".json", "");
      const sk = Object.values(raw.skills || {}).filter((s) => s.status === "active" && s.name).map((s) => publicSkill(s, raw._project || ""));
      if (sk.length) results.push({ project: projName, projectPath: raw._project || "", skills: sk });
    } catch { /* skip */ }
  }
  return results;
}

function scout(cwd, query) {
  const qWords = keywords(query, 10);
  if (!qWords.length) return { hub: [], crossProject: [], generated: null };
  const score = (s) => {
    const hay = [s.name, s.description, ...(s.triggers || []), ...(s.tags || []), s.category || ""].join(" ").toLowerCase();
    let hits = 0;
    for (const w of qWords) if (hay.includes(w)) hits++;
    return hits / qWords.length;
  };
  const hubHits = SKILL_HUB.map((s) => ({ ...s, _score: score(s) })).filter((s) => s._score > 0).sort((a, b) => b._score - a._score).slice(0, 8);
  const xpHits = [];
  const myKey = keyOf(cwd);
  try {
    for (const file of fs.readdirSync(dir())) {
      if (!file.endsWith(".json") || file === myKey + ".json") continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir(), file), "utf8"));
        const projName = raw._project ? path.basename(raw._project) : file.replace(".json", "");
        for (const s of Object.values(raw.skills || {})) {
          if (s.status !== "active") continue;
          const sc = score(s);
          if (sc > 0) xpHits.push({ ...publicSkill(s, ""), project: projName, _score: sc });
        }
      } catch { /* skip */ }
    }
  } catch { /* dir missing */ }
  xpHits.sort((a, b) => b._score - a._score);
  const genName = squash(query).slice(0, 80);
  const generated = {
    name: genName,
    description: squash(query),
    steps: `1. Identify the relevant files and patterns in the codebase\n2. Review existing implementations for conventions\n3. Implement ${genName.toLowerCase()} following project structure\n4. Add proper error handling and edge case coverage\n5. Write tests for the new implementation\n6. Verify correctness and check for regressions`,
    triggers: qWords.slice(0, 6),
    tags: qWords.slice(0, 4),
  };
  return { hub: hubHits, crossProject: xpHits.slice(0, 8), generated };
}

function importSkill(cwd, input = {}) {
  return create(cwd, { name: input.name, description: input.description, steps: input.steps || "",
    triggers: input.triggers || [], files: input.files || [], source: "imported", status: "active" });
}

function parseSKILLmd(text) {
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(text);
  if (!fm) return null;
  const meta = {};
  for (const line of fm[1].split("\n")) {
    const m = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  if (!meta.name) return null;
  return { name: meta.name, description: meta.description || "", steps: fm[2].trim(), source: "imported" };
}

async function importFromUrl(cwd, url) {
  if (!url || typeof url !== "string") throw new Error("Invalid URL");
  const u = url.replace(/github\.com\/([^/]+)\/([^/]+)\/blob\//, "raw.githubusercontent.com/$1/$2/");
  const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 500000) throw new Error("Response too large");
  let data;
  try { data = JSON.parse(text); } catch { data = parseSKILLmd(text); }
  if (Array.isArray(data)) return data.filter((s) => s && s.name).map((s) => importSkill(cwd, s));
  if (!data || !data.name) throw new Error("Invalid skill format — needs at least a 'name' field");
  return [importSkill(cwd, data)];
}

function exportSkill(cwd, id) {
  const g = load(cwd);
  const s = g.skills[id];
  if (!s) return null;
  const p = publicSkill(s, cwd);
  return { name: p.name, description: p.description, steps: p.steps, triggers: p.triggers, files: p.files, tags: p.triggers };
}

/* ============================================================
   LIVE MARKETPLACE — browse + search a remote skill index per
   provider, install with one click. Falls back to the built-in
   SKILL_HUB when offline or the index is unreachable, so the UI
   always has something to show.
   ============================================================ */
// Per-provider index URLs (raw JSON). Override via settings.skillsMarketplaceUrl.
const MARKETPLACE_INDEX = {
  claude:  "https://raw.githubusercontent.com/anthropics/skills/main/index.json",
  default: "https://raw.githubusercontent.com/anthropics/skills/main/index.json",
};
function repoToRaw(repo, p) {
  if (!repo) return "";
  const m = /github\.com\/([^/]+)\/([^/]+)/.exec(repo) || /^([^/]+)\/([^/]+)$/.exec(repo);
  if (!m) return "";
  const branch = "main", file = p || "SKILL.md";
  return `https://raw.githubusercontent.com/${m[1]}/${m[2].replace(/\.git$/, "")}/${branch}/${file.replace(/^\//, "")}`;
}
// Normalize whatever shape the remote index uses into installable entries.
function normalizeIndex(data) {
  const arr = Array.isArray(data) ? data : (data && (data.skills || data.entries || data.items)) || [];
  return arr
    .filter((x) => x && (x.name || x.title))
    .map((x) => ({
      name: x.name || x.title,
      description: x.description || x.summary || "",
      url: x.url || x.raw || x.download_url || x.skill_url || (x.repo ? repoToRaw(x.repo, x.path) : ""),
      tags: x.tags || x.keywords || [],
      category: x.category || "",
      source: "live",
    }))
    .filter((x) => x.url);
}
async function marketplace({ provider, query, url } = {}) {
  const src = url || MARKETPLACE_INDEX[provider] || MARKETPLACE_INDEX.default;
  let live = [];
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(12000) });
    if (res.ok) {
      const txt = await res.text();
      if (txt.length < 2_000_000) live = normalizeIndex(JSON.parse(txt));
    }
  } catch { /* offline / bad index → built-in fallback below */ }
  const builtin = SKILL_HUB.map((s) => ({
    name: s.name, description: s.description, url: "", hubId: s.id,
    tags: s.tags, category: s.category, source: "builtin",
  }));
  let all = [...live, ...builtin];
  const q = String(query || "").toLowerCase().trim();
  if (q) all = all.filter((e) => `${e.name} ${e.description} ${(e.tags || []).join(" ")} ${e.category}`.toLowerCase().includes(q));
  return { source: src, liveCount: live.length, offline: !live.length, entries: all.slice(0, 120) };
}
// Install one marketplace entry: a live URL → importFromUrl; a built-in hub id → template.
async function installMarketplace(cwd, entry = {}) {
  if (entry.hubId) return installHub(cwd, entry.hubId);
  if (entry.url) return importFromUrl(cwd, entry.url);
  throw new Error("Entry has no installable url or hubId");
}
function installHub(cwd, id) {
  const t = SKILL_HUB.find((s) => s.id === id);
  if (!t) throw new Error("Unknown hub skill: " + id);
  return importSkill(cwd, { name: t.name, description: t.description, steps: t.steps, triggers: t.triggers });
}

module.exports = { list, get, create, update, remove, promote, invoke, peek,
  hub, crossProject, scout, importSkill, importFromUrl, exportSkill, HUB_CATEGORIES,
  marketplace, installMarketplace, installHub };
