"use strict";
/* Per-conversation "session memory" — a bounded, zero-LLM digest of one chat.
 *
 * Why: context across turns is normally carried by the SDK's `resume` (the CLI
 * replays its own transcript). That breaks for *long* conversations exactly when
 * the user "resumes back":
 *   - the CLI session can expire / not exist after a restart → we retry fresh and
 *     would otherwise lose ALL context (amnesia);
 *   - a 5000-message history is far past any context window, so the CLI compacts
 *     it lossily and we have no control over what survives;
 *   - we cap the stored transcript at MAX_MESSAGES and prune the oldest.
 *
 * So we distil the conversation into a compact (~1.8 KB) digest — the goals the
 * user has pursued, the outcomes reached, the files in play, the tools leaned on
 * — and inject it on resume when (and only when) the CLI can't be trusted to
 * still hold that context. It is the deterministic, app-controlled safety net.
 *
 * Two sources are merged:
 *   - LIVE: derived on demand from the messages still in the transcript.
 *   - PRUNED: the distilled essence of messages already removed past the cap,
 *     accumulated once-per-message into a sidecar (userData/<historyDir>/<id>.convo.json).
 * A message is either live or pruned, never both, so the fold is naturally
 * idempotent — no per-message bookkeeping, and a session that never hits the cap
 * needs no sidecar at all (digest is purely live and always current).
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

// Persisted-memory caps (pruned side). Bounded so a sidecar can never grow large.
const KEEP_GOALS = 24;
const KEEP_OUTCOMES = 24;
const KEEP_TOOLS = 40;
// Live-scan caps (don't walk all 5000 messages every run).
const SCAN_CAP = 2000;        // newest N messages scanned for goals/outcomes/tools
const COLLECT_GOALS = 10;
const COLLECT_OUTCOMES = 10;
// Digest shape injected into the prompt — scales with conversation length so
// longer sessions preserve more of their history without burning excessive tokens.
const SHOW_GOALS = 6, SHOW_OUTCOMES = 6, SHOW_FILES = 8, SHOW_TOOLS = 6;
const DIGEST_BUDGET_BASE = 1800;   // chars for short conversations (< 100 msgs)
const DIGEST_BUDGET_LONG = 3200;   // chars for long conversations (100-400 msgs)
const DIGEST_BUDGET_HUGE = 4800;   // chars for very long conversations (400+)
function digestBudget(total) {
  if (total >= 400) return DIGEST_BUDGET_HUGE;
  if (total >= 100) return DIGEST_BUDGET_LONG;
  return DIGEST_BUDGET_BASE;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update", "create_file", "str_replace"]);

let baseDir = null;           // set by store once historyDir is known
function setDir(dir) { if (dir) baseDir = dir; }
function dir() { return baseDir || path.join(app.getPath("userData"), "sessions"); }
function fileOf(id) { return path.join(dir(), `${id}.convo.json`); }

const cache = new Map();      // id -> persisted memory
const writeTimers = new Map();

function blank() { return { goals: [], outcomes: [], tools: {}, prunedCount: 0 }; }

function loadPruned(id) {
  if (cache.has(id)) return cache.get(id);
  let g = null;
  try { g = JSON.parse(fs.readFileSync(fileOf(id), "utf8")); } catch { /* fresh */ }
  if (!g || typeof g !== "object") g = blank();
  g.goals = Array.isArray(g.goals) ? g.goals : [];
  g.outcomes = Array.isArray(g.outcomes) ? g.outcomes : [];
  g.tools = g.tools && typeof g.tools === "object" ? g.tools : {};
  g.prunedCount = g.prunedCount || 0;
  cache.set(id, g);
  return g;
}
function scheduleSave(id) {
  if (writeTimers.has(id)) clearTimeout(writeTimers.get(id));
  writeTimers.set(id, setTimeout(() => {
    writeTimers.delete(id);
    try { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(fileOf(id), JSON.stringify(cache.get(id) || blank())); }
    catch { /* non-fatal — memory is a best-effort optimisation */ }
  }, 800));
}

// ---- text distillation helpers ----
const squash = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
function clip(s, n) { s = squash(s); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }
const normKey = (s) => squash(s).toLowerCase().slice(0, 60);

// Pull the most representative single line out of an assistant turn: the first
// non-empty line that isn't a markdown heading marker or code fence.
function leadLine(text) {
  const lines = String(text || "").split("\n");
  for (const raw of lines) {
    const l = squash(raw).replace(/^#+\s*/, "").replace(/^[-*]\s+/, "");
    if (l && !/^```/.test(l)) return l;
  }
  return "";
}

function toolFileOf(input) {
  return input && (input.file_path || input.notebook_path || input.path) || "";
}

// Walk a messages array newest→oldest, collecting goals (user asks), outcomes
// (assistant lead lines) and a tool-usage tally. Used for both the live side and
// each pruned batch.
function derive(messages) {
  const goals = [], outcomes = [], tools = {};
  const seenG = new Set(), seenO = new Set();
  const n = messages.length;
  const stop = Math.max(0, n - SCAN_CAP);
  for (let i = n - 1; i >= stop; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user" && m.text && goals.length < COLLECT_GOALS) {
      const t = clip(m.text, 120), k = normKey(t);
      if (t && !seenG.has(k)) { seenG.add(k); goals.push({ t, at: m.ts || "" }); }
    } else if (m.role === "assistant" && m.text && outcomes.length < COLLECT_OUTCOMES) {
      const t = clip(leadLine(m.text), 120), k = normKey(t);
      if (t && !seenO.has(k)) { seenO.add(k); outcomes.push({ t, at: m.ts || "" }); }
    } else if (m.role === "tool" && m.toolName) {
      tools[m.toolName] = (tools[m.toolName] || 0) + 1;
    }
  }
  return { goals, outcomes, tools };
}

function addTools(into, from) { for (const k of Object.keys(from || {})) into[k] = (into[k] || 0) + from[k]; }

// Fold a batch of just-pruned messages into the persisted side. The batch is
// chronological (oldest→newest) and is NEWER than anything already persisted, so
// its (newest-first) distillation prepends. Counts accumulate; arrays stay capped.
function foldPruned(id, msgs) {
  if (!id || !Array.isArray(msgs) || !msgs.length) return;
  const g = loadPruned(id);
  const d = derive(msgs);
  const seenG = new Set(g.goals.map((x) => normKey(x.t)));
  const seenO = new Set(g.outcomes.map((x) => normKey(x.t)));
  g.goals = [...d.goals.filter((x) => !seenG.has(normKey(x.t))), ...g.goals].slice(0, KEEP_GOALS);
  g.outcomes = [...d.outcomes.filter((x) => !seenO.has(normKey(x.t))), ...g.outcomes].slice(0, KEEP_OUTCOMES);
  addTools(g.tools, d.tools);
  // cap tool keys (keep the most-used)
  const tk = Object.keys(g.tools);
  if (tk.length > KEEP_TOOLS) {
    tk.sort((a, b) => g.tools[b] - g.tools[a]);
    const keep = {}; for (const k of tk.slice(0, KEEP_TOOLS)) keep[k] = g.tools[k];
    g.tools = keep;
  }
  g.prunedCount += msgs.length;
  scheduleSave(id);
}

// Merge live + pruned into the final structured memory used for the digest.
function merge(session) {
  const id = session && session.id;
  const live = derive((session && session.messages) || []);
  const p = id ? loadPruned(id) : blank();
  const seenG = new Set(), seenO = new Set();
  const goals = [];
  for (const x of [...live.goals, ...p.goals]) { const k = normKey(x.t); if (x.t && !seenG.has(k)) { seenG.add(k); goals.push(x.t); } }
  const outcomes = [];
  for (const x of [...live.outcomes, ...p.outcomes]) { const k = normKey(x.t); if (x.t && !seenO.has(k)) { seenO.add(k); outcomes.push(x.t); } }
  const tools = {}; addTools(tools, p.tools); addTools(tools, live.tools);
  // Files come from the session's cumulative editedFiles (whole-conversation,
  // authoritative — it is never pruned), so the digest's file list is complete.
  const files = ((session && session.editedFiles) || [])
    .filter((f) => f && f.path)
    .map((f) => ({ path: f.path, count: f.count || 1, added: f.added || 0, removed: f.removed || 0 }));
  const liveCount = (session && session.messages) ? session.messages.length : 0;
  // archivedCount (from store enforceCap) is authoritative; p.prunedCount tracks
  // how many messages convo.foldPruned has seen — use whichever is larger.
  const prunedCount = Math.max(p.prunedCount || 0, session.archivedCount || 0);
  return { goals, outcomes, tools, files, prunedCount, liveCount };
}

const baseName = (p) => (p || "").replace(/\\/g, "/").split("/").pop() || p;

// Build the compact prompt digest. Empty string when there's nothing worth saying.
// Scales with conversation length: short chats get a lean digest; 800-message
// marathons get a richer one so nothing important is lost on rotation.
function digestFor(session) {
  const m = merge(session);
  const total = m.liveCount + m.prunedCount;
  if (total < 2 && !m.goals.length && !m.outcomes.length && !m.files.length) return "";
  const budget = digestBudget(total);
  const isLong = total >= 200;
  const goalCap = isLong ? 12 : SHOW_GOALS;
  const outcomeCap = isLong ? 10 : SHOW_OUTCOMES;
  const fileCap = isLong ? 14 : SHOW_FILES;
  const toolCap = isLong ? 10 : SHOW_TOOLS;
  const parts = [];
  parts.push(
    `Session memory (auto-distilled from this conversation — ${total} messages` +
    (m.prunedCount ? `, ${m.prunedCount} folded into memory` : "") +
    `). Stay consistent with what's already been decided; don't re-ask or redo it.`);
  if (m.goals.length) parts.push("Goals pursued: " + m.goals.slice(0, goalCap).map((t) => `"${t}"`).join("; "));
  if (m.outcomes.length) parts.push("Outcomes so far: " + m.outcomes.slice(0, outcomeCap).map((t) => `"${t}"`).join("; "));
  if (m.files.length) {
    const hot = m.files.sort((a, b) => (b.count - a.count) || (b.added - a.added)).slice(0, fileCap)
      .map((f) => `${baseName(f.path)} (${f.count}× edited, +${f.added}/−${f.removed})`);
    parts.push("Files worked on: " + hot.join(", "));
  }
  const tk = Object.keys(m.tools).sort((a, b) => m.tools[b] - m.tools[a]).slice(0, toolCap);
  if (tk.length) parts.push("Tools leaned on: " + tk.map((k) => `${k} (${m.tools[k]}×)`).join(", "));
  let out = parts.join("\n");
  if (out.length > budget) out = out.slice(0, budget - 1) + "…";
  return out;
}

function peek(session) {
  const m = merge(session);
  return { live: m.liveCount, pruned: m.prunedCount, goals: m.goals.length, outcomes: m.outcomes.length, files: m.files.length, digest: digestFor(session) };
}

function remove(id) {
  cache.delete(id);
  if (writeTimers.has(id)) { clearTimeout(writeTimers.get(id)); writeTimers.delete(id); }
  try { fs.unlinkSync(fileOf(id)); } catch { /* may not exist */ }
}

module.exports = { setDir, foldPruned, digestFor, peek, remove };
