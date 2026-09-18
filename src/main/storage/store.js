"use strict";
/*
 * Persistence layer for AtomNano.
 *  - settings.json lives in userData
 *  - each session is one JSON file inside the (configurable) history folder
 *
 * Lazy loading: at startup we only build a lightweight META index of all
 * sessions (no message arrays). Full sessions (with messages) are parsed from
 * disk on demand via ensureLoaded() and stay cached only once touched, so RAM
 * scales with what you actually open — not with total history. Renderers fetch
 * messages in windows (getSessionView / getMessagesRange) rather than the whole
 * array.
 *
 * Per-project window state (projects, openWindows) supports multiple windows,
 * one project (folder) each.
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const convo = require("./convo");
const agentsMod = require("../agents/subagents");   // pure registry helpers (TERMINAL, patch, endNote) — no store dependency

const userData = app.getPath("userData");
const settingsPath = path.join(userData, "settings.json");

// Live-transcript cap per session. Beyond this the oldest messages are distilled
// into the session's convo memory + an on-disk archive, then dropped from the
// live array (see enforceCap). Overridable for tests.
const MAX_MESSAGES = Math.max(20, parseInt(process.env.ATOMNANO_MAX_MESSAGES, 10) || 5000);

function uid() { return crypto.randomBytes(9).toString("hex"); }
function nowISO() { return new Date().toISOString(); }
function projectKey(p) { return (p || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase(); }

const DEFAULT_SETTINGS = {
  historyDir: path.join(userData, "sessions"),
  defaultModel: "claude-opus-4-8",
  llmProvider: "anthropic",    // anthropic | openai | google | custom (chosen before the model)
  customApiBaseUrl: "",        // Anthropic-compatible base URL when llmProvider === "custom"
  // Custom provider — "anthropic" (SDK via base URL) or "raw" (any HTTP API via template).
  customMode: "anthropic",     // "anthropic" | "raw"
  customEndpoint: "",          // raw mode: full POST URL (e.g. https://api.x.com/v1/chat/completions)
  customHeaders: "",           // raw mode: "Key: Value" per line; {{apiKey}} substituted
  customPayloadTemplate: "",   // raw mode: JSON body template with {{prompt}}/{{system}}/{{model}}
  customOutputPath: "",        // raw mode: JSON path to the reply text (e.g. choices[0].message.content)
  // Multiple named custom endpoints — each its own raw HTTP API selectable as a
  // "model". Shape: { id, name, endpoint, apiKey, model, headers, payloadTemplate, outputPath }
  customEndpoints: [],
  cliEnabled: false,           // `atomnano` CLI linked onto PATH via npm link
  defaultPermissionMode: "acceptEdits",
  defaultThinking: "high",   // Opus 4.8 default effort (adaptive thinking)
  claudePath: "",
  apiKey: "",
  openaiApiKey: "",        // OpenAI / Codex official API key
  openaiWebSearch: "live", // Codex web_search for every OpenAI turn: "live" | "cached" | "indexed" | "disabled" | "" (= Codex's own config.toml, default cached)
  geminiApiKey: "",        // Google / Gemini official API key
  customApiKey: "",        // key for the custom (Anthropic-compatible) endpoint
  useEnvApiKey: false,
  confirmClose: true,
  theme: "amber",
  editorFontSize: 13,
  editorFontFamily: "default",
  editorStickyScroll: false,   // pin enclosing function/class/block headers while scrolling
  editorHighlight: true,       // grammar syntax highlighting (colours)
  editorLint: true,            // underline syntax (parse) errors
  editorSemantic: true,        // TypeScript type-aware diagnostics for JS/TS (off-thread)
  editorFormatOnSave: false,   // run the TS formatter on save (JS/TS)
  editorWordWrap: false,       // wrap long lines
  editorBracketColors: true,   // rainbow bracket-pair colours
  editorTrimWhitespace: false, // trim trailing whitespace on save (.editorconfig overrides)
  editorFinalNewline: false,   // ensure a final newline on save (.editorconfig overrides)
  editorRenderWhitespace: false, // show whitespace dots/arrows
  editorAutoSave: false,       // auto-save edits after a short idle
  editorInlayHints: false,     // inline parameter-name / inferred-type hints (TS + LSP)
  editorIndentGuides: false,   // vertical indent guide lines (hidden by default)
  resendButton: true,      // "Retry" button on your own prompts (resend the same text)
  subAgents: false,        // delegate independent subtasks to parallel subagents
  subAgentsMax: 3,         // max concurrent subagents when enabled (1-20) — passed to the CLI as CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS
  modeNote: true,          // a solo primary turn tells the model its mode in one sentence — the workflow is off for this chat, solo sub-agents on/off (user decision 2026-09-18; session/workflow.js modeBrief). false = a bare turn.
  // --- Workflow (orchestrator-as-primary, docs/WORKFLOW_CONTRACT.md §1, §10). `workflow` is the ACTIVE
  //     workflow — per-project overridable like the other agent settings; `workflows` is the saved
  //     LIBRARY (global). The Orchestrator is the model the user chats with — it manages, orchestrates
  //     and monitors the roles; Planner / Coder / Reviewer / Tester run as child sessions (jobs) with
  //     their own provider · model · effort · access and their own sub-agent lane (on every provider). ---
  workflow: {
    enabled: false,
    name: "Solo",                   // display name (the library entry it was loaded from, or "Custom")
    savedId: null,                  // library entry id it was loaded from (null = ad hoc / unsaved edits)
    roles: {
      orchestrator: { provider: "", model: "", effort: "", access: "bypassPermissions" },                                               // the PRIMARY; "" = follow the composer's picks
      planner: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "read", agents: 0, skills: [] },                // drafts the plan the orchestrator decides on (read-only) — a worker since 2026-09-17; skills = ids of this project's AtomNano skills every job of the role runs with (2026-09-18)
      coder: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "bypassPermissions", agents: 3, skills: [] },    // agents 0 = solo, 1–20 = the role's own sub-agent lane
      reviewer: { enabled: true, provider: "openai", model: "", effort: "medium", access: "read", agents: 0, skills: [] },                // every worker role has its own lane, on any provider (2026-09-17)
      tester: { enabled: true, provider: "anthropic", model: "", effort: "medium", access: "bypassPermissions", agents: 0, command: "" }, // command "" = the project's test command / let the tester decide
    },
    layout: {},                     // canvas node positions { orchestrator: {x,y}, planner: {x,y}, coder: {x,y}, reviewer: {x,y}, tester: {x,y} } (px)
    brief: "",                      // optional override of the GENERATED orchestrator brief (empty = generated)
    openJobTabs: false,             // open a tab for every role job in the orchestrator's window (never steals focus). OFF by default (2026-09-17): jobs run in the background through the CLI and come back as job cards; a job's tab opens on demand from its card / the studio. (Replaces the pre-2026-09-17 `autoOpenJobs`, which defaulted to on.)
  },
  workflows: [],                    // the LIBRARY: [{ id, name, createdAt, updatedAt, workflow: { roles, layout, brief, openJobTabs } }]
  agentCoresPerAgent: "auto", // CPU governor: cores reserved per running agent — "auto" (2 on 12+ core machines, else 1) | 1 | 2 | 4
  agentCpuGovernor: false, // CPU governor (opt-in, "Yield to heavy processes"): hold new agent spawns while the machine is saturated and run the agent process at lower priority. Off: the user's cap is the limit (2026-09-17).
  agentsStrip: true,       // show the live "agents running" strip above the composer
  contextRolloverPct: 90,  // Claude: when the native context is this % full BEFORE a turn, continue in a fresh native session with the budgeted record (0 = off)
  contextDigest: true,     // Claude: keep a rolling summary of the older record ready in the background once the context is half full (so a rollover is instant)
  reviewers: [],           // council: [{provider, model}] consulted/reviewing alongside the primary
  reviewMode: "before",    // "before" (consult before answering) | "after" (review the answer)
  // (Google primary / Antigravity CLI / legacy Gemini ACP / skill bridge settings
  //  were removed — agy CLI integration is no longer part of this build.)
  enableDefaultMcp: true,       // kept for back-compat; DEFAULTS is now empty — only user-added mcpConfig servers attach
  codexReasoningSummary: "",    // Codex reasoning summaries shown as thinking cards: "" (Codex default) | auto | concise | detailed | none — an explicit control, never forced

  fleetMaxConcurrent: 0,   // background fleet: max agents at once (0 = auto from cores)
  testCommand: "node {file}",  // Test Director: command template for node-adapter tests ({file} → test path)
  preventSleep: false,     // keep the computer/display awake while AtomNano runs (long agent jobs)
  // --- Agent SDK capabilities — all optional, gated here so defaults
  //     preserve today's behavior. See claude.js run() for where each is applied. ---
  enableFileCheckpointing: true,  // back up files before edits so a turn's changes can be rewound (Query.rewindFiles)
  agentProgressSummaries: true,   // ~30s AI progress blurbs for running subagents (only emitted when subAgents on)
  forwardSubagentText: true,      // stream subagents' text/thinking so a nested transcript can render (only when subAgents on)
  promptSuggestions: false,       // emit one predicted next-prompt after each turn (composer chips) — off by default (UX opt-in)
  // (sdkSkills was removed 2026-09-18: the SDK `skills` option is no longer set, so Claude's own native skills
  //  work exactly as the CLI defaults them; AtomNano's per-project skills reach the workflow ROLES only.)
  additionalDirectories: [],      // extra ABSOLUTE dirs a session may read beyond cwd
  disallowedTools: [],            // built-in tool names to hard-remove from the model (e.g. ["WebFetch"])
  customModels: [],
  fontSize: "medium",
  lastFolder: app.getPath("home"),
  windowBounds: null,
  projects: {},      // { [projectKey]: { path, openTabIds, activeTabId, editorOpenFiles, editorActiveFile, tagColor } }
  openWindows: [],   // project paths that had an open window (restored on launch)
  recentProjects: [],// recently opened project folders, most-recent first
  discoveredModels: [], // concrete model ids resolved from the CLI (newest first)
  discoveredMeta: null, // { cliVersion, at } of the last COMPLETE alias probe — skip re-probing while the CLI is unchanged
};

// A fresh deep copy of the default (active) workflow — the shape session/workflow.js fills a saved
// workflow against (settings.json holds the whole object, so a partial one must be completed).
function workflowDefaults() { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS.workflow)); }

// Settings keys whose features were removed (app-injected instructions, lossy
// context layers, hidden caps and tuning). Stripped from the global AND every
// per-project override on load, so a saved `true` can never re-activate a code
// path that no longer exists — and stale keys don't linger in backups.
const REMOVED_SETTINGS = [
  "enableCavemanBrevity", "enableFrugalContext", "enableCodeFrugal", "enableReadGate", "smartThinkingGate",
  "agentGraphMemory", "autoSkills", "agentSelfHeal", "extendPromptCache", "commandParallelism",
  "maxBudgetUsd", "taskBudgetTokens", "fallbackModel", "localOptimizer",
  "sdkSkills", "skillsMarketplaceUrl",   // native SDK skills forwarding + the marketplace index override (removed 2026-09-18)
];
function stripRemoved(obj) {
  if (!obj || typeof obj !== "object") return false;
  let changed = false;
  for (const k of REMOVED_SETTINGS) if (k in obj) { delete obj[k]; changed = true; }
  return changed;
}

let settings = { ...DEFAULT_SETTINGS };
const index = new Map();   // id -> meta (ALL sessions, lightweight)

// Persistence failures are reported, never swallowed: main wires this to a
// renderer toast + log so "saved" is only ever claimed after the bytes landed.
const errorListeners = new Set();
function onError(cb) { if (typeof cb === "function") errorListeners.add(cb); return () => errorListeners.delete(cb); }
function emitError(kind, detail, extra) {
  const info = { kind, detail: String((detail && detail.message) || detail || ""), ...(extra || {}) };
  console.error(`[store] ${kind} failed:`, info.detail);
  for (const cb of errorListeners) { try { cb(info); } catch { /* listener must not break persistence */ } }
}

// Atomic file write: temp file beside the target, fsync, rename over. A crash or
// full disk mid-write leaves the previous valid file untouched. Throws on failure.
function writeAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, data);
    try { fs.fsyncSync(fd); } catch { /* fsync unsupported on some filesystems — the rename still commits */ }
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* */ } }
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
}
const loaded = new Map();  // id -> full session (loaded on demand) — LRU-evicted
const writeTimers = new Map();

// LRU cap on the in-memory full-session cache. Without this, every session the
// user ever opens stays fully resident (up to MAX_MESSAGES=5000 message objects
// each) for the app's lifetime — a slow but real memory leak on long multi-project
// runs. `loaded` is a Map (insertion-ordered); we treat front = least-recently
// used. On access we move the id to the back (MRU). When size exceeds the cap we
// flush + drop the coldest sessions. Guards below prevent evicting anything still
// in use, so an evicted session is only ever reloaded fresh from disk when idle —
// no divergence with a live in-flight copy.
const LOADED_CACHE_MAX = Math.max(8, parseInt(process.env.ATOMNANO_LOADED_CACHE_MAX, 10) || 24);
// A running session must never be evicted: claude.js holds a long-lived reference
// to the loaded object across an async turn and mutates it in place. Evicting it
// would let a concurrent getSession() reload a divergent copy from disk, losing
// messages on the next flush. main wires this to claude.isRunning at startup.
let isBusy = () => false;
function setBusyCheck(fn) { if (typeof fn === "function") isBusy = fn; }

// Mark a cached session as most-recently-used (move to Map tail).
function touchLoaded(id) {
  if (!loaded.has(id)) return;
  const s = loaded.get(id);
  loaded.delete(id);
  loaded.set(id, s);
}

// Evict least-recently-used sessions down to the cap. Never evicts a session that
// is running (isBusy) or has an unflushed pending write (flush it first). Meta in
// `index` is kept, so listing and reload stay intact.
function evictLoaded() {
  if (loaded.size <= LOADED_CACHE_MAX) return;
  for (const id of [...loaded.keys()]) {
    if (loaded.size <= LOADED_CACHE_MAX) break;
    if (isBusy(id)) continue;                 // in-flight turn — keep resident
    if (writeTimers.has(id)) flush(id);        // persist pending changes before drop
    loaded.delete(id);
  }
}

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch { /* ignore */ } }
function sessionFile(id) { return path.join(settings.historyDir, `${id}.json`); }
// Persist a settings object. THROWS on failure (callers decide whether that is
// fatal); the previous settings.json stays valid because the write is atomic.
function writeSettingsObject(obj) { writeAtomic(settingsPath, JSON.stringify(obj, null, 2)); }
// Best-effort variant for internal bookkeeping (window bounds, tab lists) where
// a failure must be reported but must not break the caller.
function writeSettingsFile() { try { writeSettingsObject(settings); } catch (e) { emitError("settings", e, { file: settingsPath }); } }

function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) }; }
  catch { settings = { ...DEFAULT_SETTINGS }; }
  if (!settings.projects || typeof settings.projects !== "object") settings.projects = {};
  if (!settings.projectSettings || typeof settings.projectSettings !== "object") settings.projectSettings = {};
  if (!Array.isArray(settings.openWindows)) settings.openWindows = [];
  let dirty = false;
  // One-time migration: the "Retry" button on your prompts is now on by default.
  // Existing installs persisted the old `resendButton: false` default, which would
  // otherwise keep it hidden — flip it on once (the toggle still works afterward).
  if (!settings.resendButtonMigrated) { settings.resendButton = true; settings.resendButtonMigrated = true; dirty = true; }
  // Removed features: drop their keys everywhere so they can't silently re-arm.
  if (stripRemoved(settings)) dirty = true;
  for (const k of Object.keys(settings.projectSettings)) if (stripRemoved(settings.projectSettings[k])) dirty = true;
  if (dirty) writeSettingsFile();
  ensureDir(settings.historyDir);
  convo.setDir(settings.historyDir);   // keep convo sidecars beside session files
  return settings;
}
// Keys that stay GLOBAL (machine/account-level) even with per-project settings:
// secrets, CLI paths, window/history, the project list, and the shared local model.
const GLOBAL_ONLY = new Set([
  "apiKey", "useEnvApiKey", "openaiApiKey", "geminiApiKey", "customApiKey", "customApiBaseUrl",
  "customMode", "customEndpoint", "customHeaders", "customPayloadTemplate", "customOutputPath", "customEndpoints",
  "claudePath", "historyDir", "windowBounds", "confirmClose",
  "recentProjects", "projects", "openWindows", "lastFolder",
  "discoveredModels", "discoveredMeta", "customModels", "projectSettings",
  "workflows",   // the saved workflow LIBRARY is one list for the machine; the ACTIVE workflow stays per-project
]);
function pkey(p) { return p ? String(p).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() : ""; }

// Effective settings for a project = global defaults, with that project's
// overrides applied for everything EXCEPT the global-only keys. Everything else
// (provider, model, thinking, permission, reviewers, editor + appearance prefs,
// agent toggles…) is per-project.
function getSettings(project) {
  const out = { ...settings };
  delete out.projectSettings;
  const k = pkey(project);
  const ov = k && settings.projectSettings ? settings.projectSettings[k] : null;
  if (ov) for (const key of Object.keys(ov)) if (!GLOBAL_ONLY.has(key)) out[key] = ov[key];
  return out;
}
// The per-project overrides as one map { <pkey>: { key: value } } (a copy). getSettings() deliberately hides the
// map (it is not a preference); the backup bundle needs it whole — a project's active workflow, theme, agent
// toggles and every other per-project choice live here and nowhere else (2026-09-18: a restore on another machine
// came back with the default workflow for every project the user had configured).
function getProjectSettingsMap() {
  const out = {};
  const ps = settings.projectSettings && typeof settings.projectSettings === "object" ? settings.projectSettings : {};
  for (const k of Object.keys(ps)) if (ps[k] && typeof ps[k] === "object" && !Array.isArray(ps[k])) out[k] = { ...ps[k] };
  return out;
}
// Save a settings patch. The new object is written to disk FIRST (atomically) and
// only committed to memory once the write succeeded — so the UI can never report
// "saved" for a change that a restart would roll back. Throws on write failure.
function saveSettings(partial, project) {
  partial = partial || {};
  stripRemoved(partial);
  const k = pkey(project);
  const globalPatch = {}, projPatch = {};
  for (const key of Object.keys(partial)) { if (!k || GLOBAL_ONLY.has(key)) globalPatch[key] = partial[key]; else projPatch[key] = partial[key]; }
  const prevDir = settings.historyDir;
  const next = { ...settings, ...globalPatch };
  if (k && Object.keys(projPatch).length) {
    const ps = (settings.projectSettings && typeof settings.projectSettings === "object") ? settings.projectSettings : {};
    next.projectSettings = { ...ps, [k]: { ...(ps[k] || {}), ...projPatch } };
  }
  try { writeSettingsObject(next); }
  catch (e) { emitError("settings", e, { file: settingsPath, keys: Object.keys(partial) }); throw new Error(`Could not save settings (${e.code || "write failed"}: ${e.message}). Nothing was changed.`); }
  settings = next;
  if (partial.historyDir && partial.historyDir !== prevDir) {
    ensureDir(settings.historyDir);
    convo.setDir(settings.historyDir);
    loadAllSessions();
  }
  return getSettings(project);
}

/* Session schema v2. Every field a provider needs to CONTINUE a conversation is
 * round-tripped explicitly: both native thread ids, per-provider bindings (thread
 * id + how much of the canonical record that thread has seen + which account
 * created it), the provider that produced the last turn, and cumulative usage.
 * Legacy (v1) files carried only claudeSessionId and dropped codexThreadId /
 * lastProvider / token totals on reload — that is what made Codex start fresh and
 * provider-switch detection fail after a restart.
 *
 * Migration is conservative: a v1 native id is trusted as-is (it IS native
 * metadata), and its binding is marked as having seen the whole record at load
 * time — re-sending history the thread already holds would duplicate context. */
const SESSION_SCHEMA = 2;
const BINDING_PROVIDERS = ["anthropic", "openai"];
function normalizeBinding(b, legacyId, syncedDefault) {
  const src = (b && typeof b === "object") ? b : {};
  const id = (typeof src.id === "string" && src.id) ? src.id : (legacyId || null);
  const out = {
    id,
    syncedIndex: Number.isFinite(+src.syncedIndex) ? +src.syncedIndex : (id ? syncedDefault : -1),
    account: typeof src.account === "string" ? src.account : "",
  };
  // Context preparation relies on these measurements/checkpoints across restarts.
  // Keeping only the native id/cursor silently discarded a measured 1M window
  // and rejection-learned caps, causing fresh rollover/summary work after reload.
  for (const key of ["activeTokens", "compactions"]) {
    if (typeof src[key] === "number" && Number.isFinite(src[key]) && src[key] >= 0) out[key] = src[key];
  }
  if (typeof src.activeTokensTs === "string") out.activeTokensTs = src.activeTokensTs;
  if (typeof src.capacityAccount === "string") out.capacityAccount = src.capacityAccount;
  // Prompt-delivery caches (session/index.js composeAttempt): what the native thread last accepted — the role /
  // agents briefs (Codex) and the role skills. Kept across restarts so an unchanged selection is not resent in
  // full; a legacy binding without them simply resends once (2026-09-18). `briefKinds` is the composition the
  // briefHash describes ("r" role, "a" agents — composeAttempt): without it a changed brief set after a restart
  // would fall back to naming every absent kind as gone, which a role job's changed role brief must not do.
  for (const key of ["briefHash", "skillsHash", "briefKinds"]) if (typeof src[key] === "string" && src[key]) out[key] = src[key];
  for (const key of ["ctxUsage", "reportedWindow", "learnedWindow", "digest", "lastCompaction"]) {
    if (src[key] && typeof src[key] === "object" && !Array.isArray(src[key])) out[key] = { ...src[key] };
  }
  return out;
}
/* The session's TASK BOARD (docs/WORKFLOW_CONTRACT.md §8) in its exact persisted shape:
 *   { seq, setSeq, sets: [{ id, n, title, status, createdTs, closedTs, by }],
 *     items: [{ id, n, setId, title, detail, status, role, jobIds, notes, createdTs, updatedTs, doneTs }] }
 * Anything else — missing, a legacy array, malformed entries, an item whose set is gone, duplicate
 * numbers, two sets marked active — comes back as a clean board (empty when there was nothing usable).
 * The result is always a fresh deep copy, never the object passed in. The bounds (400 items / 60 sets)
 * are kept by the session manager on every change (session/tasks.js), not here. */
const TASK_STATUSES = ["todo", "doing", "review", "test", "done", "blocked", "dropped"];
const TASK_ROLES = ["orchestrator", "planner", "coder", "reviewer", "tester"];
const TASK_TERMINAL = new Set(["done", "dropped"]);
const SET_STATUSES = ["active", "done", "closed"];
function normalizeTasks(raw) {
  const t = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  const str = (v) => (typeof v === "string" ? v : "");
  const ts = (v) => (typeof v === "string" && v ? v : null);
  const num = (v) => { const n = Math.floor(+v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const sets = [], setIds = new Set();
  for (const s of Array.isArray(t.sets) ? t.sets : []) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || !s.id || setIds.has(s.id)) continue;
    setIds.add(s.id);
    sets.push({ id: s.id, n: num(s.n), title: str(s.title).trim(), status: SET_STATUSES.includes(s.status) ? s.status : "closed", createdTs: ts(s.createdTs) || nowISO(), closedTs: ts(s.closedTs), by: str(s.by) || "orchestrator" });
  }
  const items = [], itemIds = new Set();
  for (const i of Array.isArray(t.items) ? t.items : []) {
    if (!i || typeof i !== "object" || typeof i.id !== "string" || !i.id || itemIds.has(i.id) || !setIds.has(i.setId) || !str(i.title).trim()) continue;
    itemIds.add(i.id);
    items.push({
      id: i.id, n: num(i.n), setId: i.setId, title: str(i.title).trim(), detail: str(i.detail),
      status: TASK_STATUSES.includes(i.status) ? i.status : "todo", role: TASK_ROLES.includes(i.role) ? i.role : null,
      jobIds: Array.isArray(i.jobIds) ? i.jobIds.filter((j) => typeof j === "string" && j) : [],
      notes: Array.isArray(i.notes) ? i.notes.filter((x) => x && typeof x === "object" && typeof x.text === "string").map((x) => ({ ts: ts(x.ts) || "", by: str(x.by), text: x.text })) : [],
      createdTs: ts(i.createdTs) || nowISO(), updatedTs: ts(i.updatedTs) || ts(i.createdTs) || nowISO(), doneTs: ts(i.doneTs),
    });
  }
  // Numbering: the counters never go backwards; an entry without a valid (unique) number gets the next one.
  let seq = Math.max(num(t.seq), ...items.map((i) => i.n)), setSeq = Math.max(num(t.setSeq), ...sets.map((s) => s.n));
  const seenN = new Set(); for (const i of items) { if (!i.n || seenN.has(i.n)) i.n = ++seq; seenN.add(i.n); }
  const seenS = new Set(); for (const s of sets) { if (!s.n || seenS.has(s.n)) s.n = ++setSeq; seenS.add(s.n); if (!s.title) s.title = `Set ${s.n}`; }
  // Exactly one active set (or none): the newest one marked active keeps it; any other becomes done | closed.
  let activeKept = false;
  for (let k = sets.length - 1; k >= 0; k--) {
    const s = sets[k];
    if (s.status !== "active") continue;
    if (!activeKept) { activeKept = true; s.closedTs = null; continue; }
    const mine = items.filter((i) => i.setId === s.id);
    s.status = mine.length && mine.every((i) => TASK_TERMINAL.has(i.status)) ? "done" : "closed";
    s.closedTs = s.closedTs || nowISO();
  }
  return { seq, setSeq, sets, items };
}
// { total, open, done } of a board — open = not terminal (todo | doing | review | test | blocked), done = status done.
function taskCountsOf(t) {
  let total = 0, open = 0, done = 0;
  for (const i of (t && Array.isArray(t.items)) ? t.items : []) { if (!i || typeof i !== "object") continue; total++; if (i.status === "done") done++; else if (i.status !== "dropped") open++; }
  return { total, open, done };
}

// The orchestrator's persistent role sessions (session/workflow.js): { planner: [ids], coder: [ids], reviewer: [ids], tester: [ids] } — strings only, the newest 20 per role.
function normalizeRoleSessions(v) {
  const out = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const k of ["planner", "coder", "reviewer", "tester"]) if (Array.isArray(v[k])) out[k] = v[k].filter((x) => typeof x === "string" && x).slice(-20);
  return out;
}
function normalizeSession(s) {
  const messages = Array.isArray(s.messages) ? s.messages : [];
  const archivedCount = s.archivedCount || 0;
  const lastIndex = archivedCount + messages.length - 1;
  const rawB = (s.bindings && typeof s.bindings === "object") ? s.bindings : {};
  const bindings = {};
  bindings.anthropic = normalizeBinding(rawB.anthropic, s.claudeSessionId || null, lastIndex);
  bindings.openai = normalizeBinding(rawB.openai, s.codexThreadId || null, lastIndex);
  for (const k of Object.keys(rawB)) if (!BINDING_PROVIDERS.includes(k)) bindings[k] = normalizeBinding(rawB[k], null, lastIndex);
  return {
    id: s.id,
    schemaVersion: SESSION_SCHEMA,
    name: s.name || "Untitled session",
    cwd: s.cwd || settings.lastFolder,
    model: s.model || settings.defaultModel,
    permissionMode: s.permissionMode || settings.defaultPermissionMode,
    thinking: s.thinking || settings.defaultThinking,
    oneM: s.oneM || false,
    forceRollover: !!s.forceRollover,
    // Native thread ids — mirrors of bindings.<provider>.id kept for older readers.
    claudeSessionId: bindings.anthropic.id,
    codexThreadId: bindings.openai.id,
    geminiSessionId: s.geminiSessionId || null,
    bindings,
    // Provider that ran the most recent turn (drives provider-switch detection).
    lastProvider: typeof s.lastProvider === "string" ? s.lastProvider : null,
    // A run paused by an expired login persists its pending payload so it can resume
    // after re-login — even across an app restart. Everything else loads "idle".
    pendingRun: (s.pendingRun && s.pendingRun.payload && s.pendingRun.reason === "auth") ? s.pendingRun : null,
    status: (s.pendingRun && s.pendingRun.reason === "auth") ? "auth-expired" : "idle",
    createdAt: s.createdAt || nowISO(),
    updatedAt: s.updatedAt || nowISO(),
    messages,
    editedFiles: Array.isArray(s.editedFiles) ? s.editedFiles : [],
    totalCostUsd: s.totalCostUsd || 0,
    totalTokensIn: +s.totalTokensIn || 0,
    totalTokensOut: +s.totalTokensOut || 0,
    archivedCount,   // messages moved from the live array into the on-disk archive
    autoAllow: Array.isArray(s.autoAllow) ? s.autoAllow.filter((x) => typeof x === "string") : [],
    // The session's skill selection (ids of this project's skills). EFFECTIVE only on a persistent workflow ROLE
    // session (planner / coder / reviewer child — workflow.js gives it the role's attached skills on every job);
    // a plain chat's legacy selection is kept as data but has no effect (session/index.js skillsApply, 2026-09-18).
    selectedSkills: Array.isArray(s.selectedSkills) ? s.selectedSkills.filter((x) => typeof x === "string") : [],
    // Cached summaries of record spans (history.js budgeted transfer): { from, upTo, text, provider, model, ts, entries }.
    // Kept so re-synthesising a thread never summarises the same span twice.
    summaries: Array.isArray(s.summaries) ? s.summaries.filter((x) => x && typeof x === "object" && Number.isFinite(+x.from) && Number.isFinite(+x.upTo) && typeof x.text === "string") : [],
    // Sub-agent registry (src/main/agents.js): every worker the primary agent launched in this
    // session — number, purpose, status, timings — kept as history. Not part of the model-visible
    // record. `agentSeq` is the per-session numbering counter.
    agents: Array.isArray(s.agents) ? s.agents.filter((a) => a && typeof a === "object" && Number.isFinite(+a.n)) : [],
    agentSeq: Number.isFinite(+s.agentSeq) ? +s.agentSeq : 0,
    // Workflow (orchestrator-as-primary): a CHILD session created for a role job points at its orchestrator
    // session (parentId), knows its role (coder | reviewer | tester) and the job it ran; `provider`
    // pins the provider this session runs on (null = the settings' provider) — for any session.
    parentId: typeof s.parentId === "string" && s.parentId ? s.parentId : null,
    role: typeof s.role === "string" && s.role ? s.role : null,
    provider: typeof s.provider === "string" && s.provider ? s.provider : null,
    jobId: typeof s.jobId === "string" && s.jobId ? s.jobId : null,
    // The jobs THIS (orchestrator) session started — a bounded history mirrored from the live registry
    // (session/workflow.js); app-side bookkeeping, never part of the model-visible record.
    workflowJobs: Array.isArray(s.workflowJobs) ? s.workflowJobs.filter((j) => j && typeof j === "object" && typeof j.id === "string").slice(-100) : [],
    // The orchestrator's ONE session per role, reused job after job so a role keeps its context (2026-09-17).
    roleSessions: normalizeRoleSessions(s.roleSessions),
    // The session's TASK BOARD (contract §8) — sets + items the orchestrator / user maintain; app-side
    // bookkeeping (its chat cards are role "tasks", not part of the model-visible record).
    tasks: normalizeTasks(s.tasks),
    // The session's OWN workflow (contract §10, 2026-09-18): a tab picks its workflow independently of the
    // other tabs; null = follow the project's active workflow (settings.workflow). Resolved by
    // session/workflow.js workflowFor (a role child follows its orchestrator's).
    workflow: s.workflow && typeof s.workflow === "object" && !Array.isArray(s.workflow) ? s.workflow : null,
    // Note: _pendingRetry, _runTouched and other transient run state are
    // intentionally NOT copied through — they belong to the live runner and a
    // fresh process must not act on them after a relaunch.
  };
}

function metaOf(s) {
  return {
    id: s.id, name: s.name, cwd: s.cwd, model: s.model,
    permissionMode: s.permissionMode, thinking: s.thinking, oneM: s.oneM,
    status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt,
    messageCount: (s.messages || []).length, editedCount: (s.editedFiles || []).length,
    archivedCount: s.archivedCount || 0,
    totalCostUsd: s.totalCostUsd || 0,
    totalTokensIn: s.totalTokensIn || 0, totalTokensOut: s.totalTokensOut || 0,
    lastProvider: s.lastProvider || null,
    authProvider: (s.pendingRun && s.pendingRun.reason === "auth") ? s.pendingRun.provider : null,
    parentId: s.parentId || null, role: s.role || null, provider: s.provider || null, jobId: s.jobId || null,
    taskCounts: taskCountsOf(s.tasks),
  };
}

function archiveFile(id) { return path.join(settings.historyDir, `${id}.archive.jsonl`); }

/* GLOBAL message indexes. A session's transcript is archive (pruned, on disk,
 * one JSONL line per message) followed by the live array. Index g < archivedCount
 * addresses archive line g, otherwise live[g - archivedCount]. Pruning appends to
 * the archive exactly the messages it removes from the front of the live array, so
 * a message's global index never changes — the renderer can hold a window
 * anywhere in the history (scroll up through archived turns, jump to a search
 * hit or a prompt) and always agree with the main process about positions. */
const archiveCache = new Map();   // id → { size, mtime, rows } (two most recent sessions)
function readArchive(id) {
  const f = archiveFile(id);
  let st; try { st = fs.statSync(f); } catch { archiveCache.delete(id); return []; }
  const hit = archiveCache.get(id);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.rows;
  const rows = [];
  try {
    for (const ln of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      if (!ln) continue;
      try { rows.push(JSON.parse(ln)); } catch { rows.push({ id: "corrupt-" + rows.length, role: "system", text: "(unreadable archived message)", ts: "" }); }
    }
  } catch { /* partial read — placeholders fill the gaps below */ }
  archiveCache.delete(id); archiveCache.set(id, { size: st.size, mtime: st.mtimeMs, rows });
  if (archiveCache.size > 2) archiveCache.delete(archiveCache.keys().next().value);
  return rows;
}
const totalCount = (s) => (s.archivedCount || 0) + s.messages.length;
const missingMsg = (g) => ({ id: "missing-" + g, role: "system", text: "(archived message unavailable)", ts: "" });

// Cap the LIVE (in-memory) transcript at MAX_MESSAGES by moving the oldest
// overflow into the on-disk archive. This is a memory-window limit, not a
// history-loss limit: the archive append is DURABLE FIRST (written + fsynced),
// and only then are the rows removed from the live array and the counters
// advanced. If the append fails nothing is removed, the failure is reported, and
// the live array simply stays over the cap until the next successful flush.
function enforceCap(s) {
  if (!s || !Array.isArray(s.messages) || s.messages.length <= MAX_MESSAGES) return 0;
  const overflow = s.messages.length - MAX_MESSAGES;
  const pruned = s.messages.slice(0, overflow);
  const payload = pruned.map((m) => JSON.stringify(m)).join("\n") + "\n";
  let fd = null;
  try {
    ensureDir(settings.historyDir);
    fd = fs.openSync(archiveFile(s.id), "a");
    fs.writeSync(fd, payload);
    try { fs.fsyncSync(fd); } catch { /* fsync unsupported — the write itself succeeded */ }
    fs.closeSync(fd); fd = null;
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* */ } }
    emitError("archive", e, { sessionId: s.id, file: archiveFile(s.id), count: pruned.length });
    return 0;   // keep every message in memory; nothing was archived
  }
  s.messages.splice(0, overflow);
  archiveCache.delete(s.id);   // the cached row list is stale now
  try { convo.foldPruned(s.id, pruned); } catch { /* digest is best-effort — used only by compact export */ }
  s.archivedCount = (s.archivedCount || 0) + pruned.length;
  return pruned.length;
}

// Startup: index META only (parse each file, keep meta, discard messages).
function loadAllSessions() {
  index.clear(); loaded.clear();
  ensureDir(settings.historyDir);
  let files = [];
  try { files = fs.readdirSync(settings.historyDir).filter((f) => f.endsWith(".json")); } catch { files = []; }
  for (const f of files) {
    try {
      const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(settings.historyDir, f), "utf8")));
      if (s.id) index.set(s.id, metaOf(s));
    } catch { /* skip corrupt */ }
  }
}

/* A session read from DISK holds no live work: the process that ran it is gone (a restart, a crash,
 * an older build that never closed them). Whatever it persisted as still running — sub-agents and
 * tool cards — is ended here, once, with a plain reason; an agent's last activity is kept on its
 * record (2026-09-17: a record reopened with an agent "running" for hours and five tool cards
 * queued). Never applied to a resident, running session — those are never reloaded from disk. */
const LIVE_TOOL_STATUS = new Set(["running", "queued", "preparing"]);
function settleStaleWork(s, note = "AtomNano was closed before this finished.") {
  let n = 0; const ts = nowISO();
  for (const a of Array.isArray(s.agents) ? s.agents : []) {
    if (!a || agentsMod.TERMINAL.has(a.status)) continue;
    agentsMod.patch(a, { status: "interrupted", result: a.result || agentsMod.endNote(a, note) });
    n++;
  }
  for (const m of Array.isArray(s.messages) ? s.messages : []) {
    if (!m || m.role !== "tool" || !LIVE_TOOL_STATUS.has(m.status)) continue;
    m.status = "interrupted"; if (!m.result) m.result = note; if (!m.endedTs) m.endedTs = ts; if (m.agentN) m.agentStatus = "interrupted";
    n++;
  }
  return n;
}

// Full session (with messages), parsed on demand and cached once touched.
function ensureLoaded(id) {
  if (loaded.has(id)) { touchLoaded(id); return loaded.get(id); }
  try {
    const s = normalizeSession(JSON.parse(fs.readFileSync(sessionFile(id), "utf8")));
    if (s.id !== id) return null;
    if (!isBusy(id) && settleStaleWork(s)) scheduleWrite(id);   // nothing loaded from disk is still running
    if (enforceCap(s)) scheduleWrite(id);   // cap legacy/imported over-sized transcripts on first load
    loaded.set(id, s);
    index.set(id, metaOf(s));
    evictLoaded();                          // keep the in-memory cache bounded (LRU)
    return s;
  } catch { return null; }
}

function getSession(id) { return ensureLoaded(id); }            // full — internal use
function getMeta(id) { return index.get(id) || null; }

// Windowed view for the renderer: only the tail of messages + counts.
function getSessionView(id, tail = 120) {
  const s = ensureLoaded(id);
  if (!s) return null;
  const total = totalCount(s);
  const take = Math.min(tail, s.messages.length);
  const firstIndex = total - take;                     // GLOBAL index of messages[0]
  return {
    id: s.id, name: s.name, cwd: s.cwd, model: s.model, permissionMode: s.permissionMode,
    thinking: s.thinking, oneM: s.oneM, claudeSessionId: s.claudeSessionId, codexThreadId: s.codexThreadId,
    lastProvider: s.lastProvider || null, status: s.status === "auth-expired" ? "auth-expired" : "idle",
    createdAt: s.createdAt, updatedAt: s.updatedAt, totalCostUsd: s.totalCostUsd,
    totalTokensIn: s.totalTokensIn || 0, totalTokensOut: s.totalTokensOut || 0,
    editedFiles: s.editedFiles, totalMessages: total, firstIndex, messages: s.messages.slice(s.messages.length - take),
    archivedCount: s.archivedCount || 0,
    autoAllow: Array.isArray(s.autoAllow) ? s.autoAllow.slice() : [],
    selectedSkills: Array.isArray(s.selectedSkills) ? s.selectedSkills.slice() : [],
    agents: Array.isArray(s.agents) ? s.agents.slice() : [],
    agentSeq: s.agentSeq || 0,
    parentId: s.parentId || null, role: s.role || null, provider: s.provider || null, jobId: s.jobId || null,
    workflowJobs: Array.isArray(s.workflowJobs) ? s.workflowJobs.slice() : [],
    roleSessions: normalizeRoleSessions(s.roleSessions),
    tasks: normalizeTasks(s.tasks),
    workflow: s.workflow && typeof s.workflow === "object" ? JSON.parse(JSON.stringify(s.workflow)) : null,   // the tab's own workflow (null = the project's)
  };
}

// The COMPLETE transcript (archive + live) for a full export — every message the
// session ever recorded, in order, plus its metadata. `archivedCount` is 0 in the
// result because nothing is left behind.
function exportSession(id) {
  const s = ensureLoaded(id);
  if (!s) return null;
  const arch = s.archivedCount || 0;
  const archived = arch ? readArchive(id) : [];
  const rows = [];
  for (let g = 0; g < arch; g++) rows.push(archived[g] || missingMsg(g));
  const { messages, archivedCount, status, pendingRun, ...meta } = s;   // eslint-disable-line no-unused-vars
  return { ...meta, archivedCount: 0, messages: rows.concat(messages), exportedMessageCount: rows.length + messages.length };
}

// A page of messages by GLOBAL index: [end - count, end). Reaches into the
// on-disk archive for indexes below archivedCount, so scrolling up (or jumping
// to a search hit / prompt) can reach every message ever sent in the session.
function getMessagesRange(id, end, count) {
  const s = ensureLoaded(id);
  if (!s) return { messages: [], firstIndex: 0, total: 0 };
  const arch = s.archivedCount || 0, total = totalCount(s);
  end = Math.max(0, Math.min(+end || 0, total));
  const start = Math.max(0, end - Math.max(1, +count || 1));
  const out = [];
  if (start < arch) { const rows = readArchive(id); for (let g = start; g < Math.min(end, arch); g++) out.push(rows[g] || missingMsg(g)); }
  for (let g = Math.max(start, arch); g < end; g++) out.push(s.messages[g - arch]);
  return { messages: out, firstIndex: start, total };
}

// Every user prompt in the session (archive + live) with its global index — the
// prompt picker lists these and jumps by index.
function listPrompts(id) {
  const s = ensureLoaded(id);
  if (!s) return { prompts: [], total: 0 };
  const arch = s.archivedCount || 0, out = [];
  const push = (m, g) => { if (m && m.role === "user") out.push({ index: g, id: m.id || "", ts: m.ts || "", text: String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 240) }); };
  if (arch) readArchive(id).forEach((m, i) => push(m, i));
  s.messages.forEach((m, i) => push(m, arch + i));
  return { prompts: out, total: totalCount(s) };
}

function listSessions() {
  return [...index.values()].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

function defaultName() {
  const d = new Date();
  return `Session ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function createSession({ cwd, name, model, permissionMode, thinking, oneM, selectedSkills, parentId, role, provider, jobId, workflow } = {}) {
  const id = uid();
  const s = normalizeSession({
    id, name: name || defaultName(), cwd: cwd || settings.lastFolder,
    model: model || settings.defaultModel, permissionMode: permissionMode || settings.defaultPermissionMode,
    thinking: thinking || settings.defaultThinking, oneM: !!oneM, selectedSkills: Array.isArray(selectedSkills) ? selectedSkills : [],
    parentId: parentId || null, role: role || null, provider: provider || null, jobId: jobId || null,   // workflow child sessions (jobs)
    workflow: workflow && typeof workflow === "object" ? workflow : null,   // the tab's own workflow (a continuation carries its source's)
    createdAt: nowISO(), updatedAt: nowISO(),
  });
  loaded.set(id, s);
  index.set(id, metaOf(s));
  flush(id);
  if (cwd) saveSettings({ lastFolder: cwd });
  return getSessionView(id);
}

// Create a session from imported data (new id), preserving the transcript. Native
// thread ids are deliberately NOT carried over: they belong to another install's
// provider transcripts, and resuming one here would attach this conversation to an
// unrelated (or missing) native history. The next turn re-anchors from the record.
function importSession(src) {
  if (!src || !Array.isArray(src.messages)) return null;
  const id = uid();
  const s = normalizeSession({
    id,
    name: src.name || "Imported session",
    cwd: src.cwd || settings.lastFolder,
    model: src.model, permissionMode: src.permissionMode, thinking: src.thinking, oneM: src.oneM,
    lastProvider: src.lastProvider || null,
    createdAt: src.createdAt || nowISO(),
    updatedAt: nowISO(),
    messages: src.messages,
    editedFiles: Array.isArray(src.editedFiles) ? src.editedFiles : [],
    totalCostUsd: src.totalCostUsd || 0,
    totalTokensIn: src.totalTokensIn || 0, totalTokensOut: src.totalTokensOut || 0,
    tasks: src.tasks,   // the task board travels with a full export
  });
  enforceCap(s);
  loaded.set(id, s);
  index.set(id, metaOf(s));
  flush(id);
  return getSessionView(id);
}

// Restore a session from a backup, PRESERVING its id (so per-project openTabIds
// still resolve). Overwrites an existing session with the same id.
function writeSessionRaw(src) {
  if (!src || !src.id || !Array.isArray(src.messages)) return null;
  const s = normalizeSession(src);
  enforceCap(s);
  loaded.set(s.id, s);
  index.set(s.id, metaOf(s));
  flush(s.id);
  return s.id;
}

function updateSession(id, patch) {
  const s = ensureLoaded(id);
  if (!s) return null;
  Object.assign(s, patch, { updatedAt: nowISO() });
  if (patch && Array.isArray(patch.messages)) enforceCap(s);   // bulk-set transcript must also respect the cap
  index.set(id, metaOf(s));
  scheduleWrite(id);
  return s;
}

// Remove a single message by id from the FULL on-disk transcript (not just the
// renderer's windowed tail). Returns true if a message was removed.
/* Delete a live message. Global indexes after it shift by one, so every positional
 * reference is corrected: provider cursors move back (an entry that came AFTER the deleted
 * one and was not yet synced stays unsynced), cached summaries that COVER the deleted entry
 * are dropped (their text describes content that no longer exists), and summaries entirely
 * after it are shifted. The provider's native thread may still know the message — the
 * chat says so when a thread exists. */
function deleteMessage(id, mid) {
  const s = ensureLoaded(id);
  if (!s) return false;
  const i = s.messages.findIndex((m) => m && m.id === mid);
  if (i < 0) return false;
  const g = (s.archivedCount || 0) + i;
  s.messages.splice(i, 1);
  if (s.bindings && typeof s.bindings === "object") {
    for (const b of Object.values(s.bindings)) if (b && Number.isFinite(+b.syncedIndex) && b.syncedIndex >= g) b.syncedIndex = b.syncedIndex - 1;
  }
  if (Array.isArray(s.summaries)) {
    s.summaries = s.summaries.filter((x) => !(x && x.from < g && g <= x.upTo));                     // covered the deleted entry → invalid
    for (const x of s.summaries) if (x && x.from >= g) { x.from -= 1; x.upTo -= 1; }                  // entirely after it → shift
  }
  index.set(id, metaOf(s));
  scheduleWrite(id);
  return true;
}

function deleteSession(id) {
  loaded.delete(id); index.delete(id);
  try { fs.unlinkSync(sessionFile(id)); } catch { /* ignore */ }
  try { fs.unlinkSync(archiveFile(id)); } catch { /* may not exist */ }
  try { convo.remove(id); } catch { /* ignore */ }
  return true;
}

// Session conversation memory (the auto-distilled digest used on resume).
function peekConvo(id) { const s = ensureLoaded(id); return s ? convo.peek(s) : null; }
function convoDigest(id) { const s = ensureLoaded(id); return s ? convo.digestFor(s) : ""; }

function scheduleWrite(id) {
  if (writeTimers.has(id)) clearTimeout(writeTimers.get(id));
  writeTimers.set(id, setTimeout(() => flush(id), 400));
}
// Write one session to disk atomically (temp + rename, so a crash or a full disk
// mid-write never truncates the previous good file). Returns true on success;
// on failure the error is reported through onError and the write is retried on
// the next scheduleWrite (the in-memory session is unchanged).
function flush(id) {
  const s = loaded.get(id);
  if (!s) return false;
  writeTimers.delete(id);
  // Compact JSON (no pretty-print): session files aren't hand-edited and a busy
  // turn flushes ~10-20× (each message / edit / tool status change).
  try { writeAtomic(sessionFile(id), JSON.stringify(s)); index.set(id, metaOf(s)); return true; }
  catch (e) { emitError("session", e, { sessionId: id, file: sessionFile(id) }); return false; }
}
function flushAll() { for (const id of loaded.keys()) flush(id); }

// ---- per-project window state ----
function getProjectTabs(p) { return settings.projects[projectKey(p)] || null; }
function setProjectTabs(p, data) {
  const k = projectKey(p);
  settings.projects = { ...settings.projects, [k]: { ...(settings.projects[k] || {}), path: p, ...data } }; // merge — keeps tabs + color
  writeSettingsFile();
}
function getOpenWindows() { return Array.isArray(settings.openWindows) ? settings.openWindows.slice() : []; }
function setOpenWindows(arr) { settings.openWindows = arr.slice(); writeSettingsFile(); }

// Full-text search WITHIN one session, across its entire on-disk transcript —
// both the live window (.json) and the pruned older messages (.archive.jsonl)
// that the chat view no longer holds in memory. Returns lightweight matches with
// a snippet; `archived: true` marks a hit that lives only in the sidecar (the
// renderer can show its snippet but can't scroll to it in the transcript).
function searchSession(id, query, max = 200) {
  const q = String(query || "").trim().toLowerCase();
  if (!q || !id) return { matches: [], total: 0 };
  const s = ensureLoaded(id);
  if (!s) return { matches: [], total: 0 };
  const arch = s.archivedCount || 0;
  const results = []; let total = 0;
  // Every hit carries its GLOBAL index so the renderer can load that part of the
  // transcript and scroll to it — archived or not.
  const scan = (m, g) => {
    if (!m) return;
    const text = typeof m.text === "string" ? m.text : "";
    if (!text) return;
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) return;
    total++;
    if (results.length >= max) return;
    const start = Math.max(0, idx - 40);
    const snippet = (start > 0 ? "…" : "") + text.slice(start, idx + q.length + 70).replace(/\s+/g, " ").trim() + (idx + q.length + 70 < text.length ? "…" : "");
    results.push({ mid: m.id || "", role: m.role || "", ts: m.ts || "", snippet, index: g, archived: g < arch });
  };
  if (arch) readArchive(id).forEach((m, i) => scan(m, i));
  s.messages.forEach((m, i) => scan(m, arch + i));
  return { matches: results, total, totalMessages: totalCount(s) };
}

module.exports = {
  uid, nowISO,
  loadSettings, getSettings, saveSettings, getProjectSettingsMap, REMOVED_SETTINGS,
  loadAllSessions, listSessions, getSession, getMeta, getSessionView, getMessagesRange, searchSession, listPrompts, exportSession,
  createSession, importSession, writeSessionRaw, updateSession, deleteSession, deleteMessage, scheduleWrite, flush, flushAll, metaOf, setBusyCheck,
  enforceCap, peekConvo, convoDigest, MAX_MESSAGES, SESSION_SCHEMA,
  workflowDefaults, normalizeTasks, taskCountsOf,
  onError, writeAtomic,
  getProjectTabs, setProjectTabs, getOpenWindows, setOpenWindows,
};
