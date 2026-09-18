"use strict";
/* Per-project SKILLS — named, reusable procedures the user attaches to the Workflow studio's roles
 * (Planner / Coder / Reviewer). A skill is a name, a description and its steps; invoking one hands the
 * procedure to the role's session so the agent follows your established pattern instead of re-deriving it.
 *
 * The store is deliberately small (2026-09-18: the apprentice, the built-in hub, the marketplace, the
 * cross-project browser, the scout and the standalone import/export were removed — the Studio's Skills
 * modal is the only management UI). What remains:
 *   list / get / create / update / remove  — CRUD over this project's skills (IPC skills:*)
 *   digest                                 — main-process only, PURE: the procedure text a role runs with (no bookkeeping)
 *   markUsed                               — main-process only: usage bookkeeping (uses / lastUsed) for a skill that went out
 *   invoke                                 — markUsed + digest (compatibility)
 *   importFromUrl                          — one URL → one or more skills (JSON object / array, or SKILL.md)
 *
 * Storage mirrors graph.js: one JSON per project under userData/skills/<key>.json. Files written by the
 * earlier, larger module load unchanged: ids, slugs, procedures and the (now unused) `runs` log are kept
 * as they are, so nothing a workflow points at disappears. */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_SKILLS = 80;         // skills per project — a hard limit: adding beyond it is an error, never a silent eviction
const DIGEST_BUDGET = 1200;    // chars a skill contributes when a role runs with it
const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_CHARS = 500000;

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
  g.runs = Array.isArray(g.runs) ? g.runs : [];   // legacy apprentice log — carried, never read
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
const rel = (p, cwd) => {
  const a = (p || "").replace(/\\/g, "/"), b = (cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return a.toLowerCase().startsWith(b.toLowerCase() + "/") ? a.slice(b.length + 1) : a;
};

// Significant words of a name + description, stopwords removed — a new skill's default trigger keywords.
function keywords(text, n = 6) {
  const seen = new Set(), out = [];
  for (const w of squash(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w); out.push(w);
    if (out.length >= n) break;
  }
  return out;
}

// The record the renderer and the session code see. `updatedAt` is the edit clock (ms): invoke() leaves it
// alone, so a role session's skill snapshot hash (session/index.js) changes only when the procedure does.
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

// Room for `n` more skills, or a clear error — the caller adds nothing when it throws (batch imports ask
// for the whole batch first, so a partial import can never evict a skill a workflow points at).
function capacityError(g, n = 1) {
  const have = Object.keys(g.skills).length;
  if (have + n <= MAX_SKILLS) return null;
  return new Error(n > 1
    ? `Importing ${n} skills would exceed this project's limit of ${MAX_SKILLS} (${have} installed) — remove some skills first.`
    : `This project already has ${have} skills — the limit is ${MAX_SKILLS}. Remove a skill before adding another.`);
}

function create(cwd, input = {}) {
  const g = load(cwd);
  const full = capacityError(g, 1);
  if (full) throw full;
  const now = Date.now();
  const id = uid();
  const name = squash(input.name) || "Untitled skill";
  const s = {
    id, name, slug: uniqueSlug(g, slugify(input.slug || name)),
    description: squash(input.description), steps: String(input.steps || "").trim(),
    params: Array.isArray(input.params) ? input.params.slice(0, 12) : [],
    triggers: Array.isArray(input.triggers) && input.triggers.length ? input.triggers.map(squash).filter(Boolean).slice(0, 12) : keywords(name + " " + (input.description || "")),
    files: Array.isArray(input.files) ? input.files.slice(0, 40) : [],
    source: input.source === "imported" ? "imported" : "manual",
    status: "active",
    uses: 0, lastUsed: 0, createdAt: now, updatedAt: now,
  };
  g.skills[id] = s;
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
  if (patch.status === "active" || patch.status === "suggested") s.status = patch.status;   // legacy records may still carry "suggested"
  s.updatedAt = Date.now();
  scheduleSave(cwd);
  return publicSkill(s, cwd);
}
function remove(cwd, id) { const g = load(cwd); const had = !!g.skills[id]; delete g.skills[id]; scheduleSave(cwd); return had; }

/* The procedure text a role session runs with — PURE: nothing is bumped, nothing is saved. The session code
 * FREEZES it once per turn (session/index.js skillSnapshot, 2026-09-18): every attempt of that turn — the resumed
 * thread's, a lost-session or overflow replacement's — sends exactly the text the turn's hash describes, however the
 * store changes meanwhile (an edit or a removal between the snapshot and a replacement attempt used to send new text
 * under the old hash). null when the skill does not exist. */
function digest(cwd, idOrSlug) {
  const s = get(cwd, idOrSlug);
  return s ? digestFor(s, cwd) : null;
}
// Usage bookkeeping for a skill whose procedure actually went out: uses / lastUsed only — `updatedAt` stays (the
// snapshot hash must not move because a skill was used). Returns whether the skill (still) exists.
function markUsed(cwd, idOrSlug) {
  const s = get(cwd, idOrSlug);
  if (!s) return false;
  s.uses = (s.uses || 0) + 1; s.lastUsed = Date.now();
  scheduleSave(cwd);
  return true;
}
// Mark a skill used + return its procedure text (the stateless callers' one-step form).
function invoke(cwd, idOrSlug) { return markUsed(cwd, idOrSlug) ? digest(cwd, idOrSlug) : null; }
function digestFor(s, cwd) {
  const parts = [`Skill "${s.name}"${s.description ? " — " + s.description : ""}.`];
  if (s.steps) parts.push(s.steps);
  if ((s.files || []).length) parts.push("Relevant files: " + s.files.map((f) => rel(f, cwd)).join(", "));
  let out = parts.join("\n");
  if (out.length > DIGEST_BUDGET) out = out.slice(0, DIGEST_BUDGET - 1) + "…";
  return out;
}

/* ============================================================
   IMPORT FROM A URL — a JSON skill, a JSON array of skills, or a SKILL.md
   (front matter `name` / `description`, the body = the steps). GitHub blob
   links are read through raw.githubusercontent.com.
   ============================================================ */
// A fetched entry → the input create() takes. null when it has no name.
function normalizeImport(input) {
  if (!input || typeof input !== "object" || !squash(input.name)) return null;
  return {
    name: input.name, description: input.description, steps: input.steps || "",
    triggers: Array.isArray(input.triggers) ? input.triggers : Array.isArray(input.tags) ? input.tags : [],
    files: Array.isArray(input.files) ? input.files : [],
    source: "imported",
  };
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
  return { name: meta.name, description: meta.description || "", steps: fm[2].trim() };
}
async function importFromUrl(cwd, url) {
  if (!url || typeof url !== "string" || !url.trim()) throw new Error("Invalid URL");
  const u = url.trim().replace(/github\.com\/([^/]+)\/([^/]+)\/blob\//, "raw.githubusercontent.com/$1/$2/");
  const res = await fetch(u, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > FETCH_MAX_CHARS) throw new Error("Response too large");
  let data;
  try { data = JSON.parse(text); } catch { data = parseSKILLmd(text); }
  const entries = (Array.isArray(data) ? data : [data]).map(normalizeImport).filter(Boolean);
  if (!entries.length) throw new Error(Array.isArray(data) ? "No skills found — every entry needs at least a 'name' field" : "Invalid skill format — needs at least a 'name' field");
  const full = capacityError(load(cwd), entries.length);   // the whole batch fits, or nothing is added
  if (full) throw full;
  return entries.map((e) => create(cwd, e));
}

module.exports = { list, get, create, update, remove, digest, markUsed, invoke, importFromUrl };
