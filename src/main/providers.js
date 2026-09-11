"use strict";
/* PROVIDER CAPABILITY CATALOG — the single source of truth for which models each
 * LLM provider offers and what each one supports. The composer reads this to
 * render the right controls dynamically when you switch the PRIMARY provider:
 *
 *   reasoning === "thinking" → the thinking-level dropdown (off…ultrathink)
 *   reasoning === "effort"   → the reasoning-effort dropdown (low…x-high)
 *   model.ctx1m === true     → the "1M context" toggle is offered
 *
 * Anthropic is the default primary and is fully supported through the Agent SDK.
 * OpenAI/Codex is a streaming primary through @openai/codex-sdk (see codex.js) —
 * live text/tool cards + thread resume, with a Codex-CLI batch fallback. Custom
 * runs via an Anthropic-compatible base URL. All providers are also available as
 * reviewers (council.js). Google (Antigravity) was removed from this build.
 */

const THINKING_LEVELS = [
  { id: "off", name: "Thinking off", desc: "No extended reasoning" },
  { id: "think", name: "Think", desc: "Light reasoning" },
  { id: "think-hard", name: "Think hard", desc: "Moderate reasoning" },
  { id: "think-harder", name: "Think harder", desc: "Deep reasoning" },
  { id: "ultrathink", name: "Ultrathink", desc: "Maximum reasoning" },
];
// ---- OpenAI / Codex reasoning effort -------------------------------------------
// Codex SDK 0.153 enum (ModelReasoningEffort): none|minimal|low|medium|high|xhigh|
// max|ultra|persistent. Per-model support, read from the model catalog embedded in
// codex.exe 0.153.4 (descriptions are the CLI's own):
//   GPT-5.2 / 5.4 / 5.4-mini / 5.5 / 5.3-codex : low, medium, high, xhigh       (default medium)
//   GPT-5.6 (luna)                              : + max
//   GPT-5.6 (sol), GPT-6, Daybreak              : + max, ultra                  (default low)
// NO current model lists `minimal` (nor `none`/`persistent`) — so the old
// "Effort: minimal" option was never valid, and anything outside a model's ladder
// must be clamped here rather than handed to Codex.
const EFFORT_LEVELS = [
  { id: "low", name: "Effort: low", desc: "Fast responses with lighter reasoning" },
  { id: "medium", name: "Effort: medium", desc: "Balances speed and reasoning depth — Codex default" },
  { id: "high", name: "Effort: high", desc: "Greater reasoning depth for complex problems" },
  { id: "xhigh", name: "Effort: x-high", desc: "Extra-high reasoning depth for complex problems" },
  { id: "max", name: "Effort: max", desc: "Maximum reasoning depth — GPT-5.6+ (older models run x-high)" },
  { id: "ultra", name: "Effort: ultra", desc: "Maximum reasoning + automatic task delegation — GPT-5.6 Sol / GPT-6+" },
];
const OPENAI_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"];
// Anything a tab may carry over from the Claude ladder / legacy names → Codex level.
const OPENAI_EFFORT_ALIAS = {
  off: "low", none: "low", minimal: "low", think: "low",
  "think-hard": "medium", "think-harder": "high",
  ultrathink: "xhigh", ultracode: "xhigh",
};
// The effort ladder a given Codex model accepts — from the installed binary's
// catalog when it knows the model, else a name-based heuristic.
function openaiEffortsFor(model) {
  const m = String(model || "").toLowerCase();
  try {
    const cat = codexCatalog();
    const hit = cat && cat.models && cat.models.find((x) => x.id.toLowerCase() === m);
    if (hit && hit.efforts && hit.efforts.length) return hit.efforts.filter((e) => OPENAI_EFFORT_ORDER.includes(e));
  } catch { /* heuristic below */ }
  const base = ["low", "medium", "high", "xhigh"];
  if (/gpt-5\.([6-9]|\d{2})|gpt-([6-9]|\d{2})(\b|$)|daybreak/.test(m)) return [...base, "max", "ultra"];
  return base;
}
// Normalise ANY stored level (Claude names, legacy names, unknown strings) to a
// level THIS model supports. Unsupported-but-known levels clamp to the nearest
// supported one at or below (max/ultra on GPT-5.5 → xhigh; minimal → low).
function openaiEffort(level, model, fallback) {
  const want = String(level || "").trim().toLowerCase();
  let modelDefault = "";
  // Unknown/absent level → the user's own Codex default (config.toml) when this
  // model supports it, else the model's catalog default (what the Codex TUI uses).
  try {
    const cat = codexCatalog(); const hit = cat && cat.models && cat.models.find((x) => x.id.toLowerCase() === String(model || "").toLowerCase());
    const cfg = cat && cat.defaults && cat.defaults.effort;
    modelDefault = (cfg && hit && (hit.efforts || []).includes(cfg)) ? cfg : ((hit && hit.defaultEffort) || "");
  } catch { /* */ }
  let eff = OPENAI_EFFORT_ALIAS[want] || (OPENAI_EFFORT_ORDER.includes(want) ? want : "") || String(fallback || modelDefault || CATALOG.openai.defaultReasoning || "high");
  const ladder = openaiEffortsFor(model);
  if (!ladder.includes(eff)) {
    const wi = OPENAI_EFFORT_ORDER.indexOf(eff);
    const below = ladder.filter((l) => OPENAI_EFFORT_ORDER.indexOf(l) <= wi);
    eff = below.length ? below[below.length - 1] : ladder[0];
  }
  return eff;
}
// STRICT variant for the primary turn: the selected level must be one THIS model
// supports — a translated legacy/Claude name is fine (a rename, not a change of
// depth), an unsupported level is an explicit capability error, never a silent
// downshift. An empty level means the model's own default.
function openaiEffortStrict(level, model) {
  const want = String(level || "").trim().toLowerCase();
  const ladder = openaiEffortsFor(model);
  if (!want) return { effort: openaiEffort("", model), ladder };
  const eff = OPENAI_EFFORT_ALIAS[want] || want;
  if (ladder.includes(eff)) return { effort: eff, ladder };
  return { effort: null, ladder, error: `Effort "${level}" is not supported by ${model || "this Codex model"} — supported: ${ladder.join(", ")}. Pick one in the Thinking menu.` };
}
// STRICT model resolution for the primary turn: the id must be listed by the
// installed Codex for this login (or there must be no catalog to check against).
// No prefix guessing, no upgrade-chain substitution — an unavailable model is an
// explicit error so the reply is never produced by a model the user didn't pick.
function resolveOpenAIModelStrict(want) {
  const live = get("openai");
  const ids = live.models.map((m) => m.id);
  const w = String(want || "").trim();
  if (!w) return { model: live.defaultModel };
  if (ids.includes(w) || !live.fromCatalog) return { model: w };
  const hint = resolveOpenAIModel(w);
  return { model: null, error: `Model "${w}" is not available on this Codex install / account${hint && hint.changed && hint.model !== live.defaultModel ? ` (Codex suggests ${hint.model})` : ""}. Pick a listed model.` };
}
// Claude adaptive-thinking effort levels (Opus 4.6+/Sonnet 4.6+/Fable/Mythos).
// These map straight to the API `effort` param. `max` is supported on Claude 4.6+
// (incl. Sonnet 5 / Fable 5); `xhigh` is Opus 4.7/4.8. The CLI falls back
// gracefully to the highest supported level for a model, so all five always pass
// through. There is no true "off" on Opus 4.7+ (adaptive is required), so `low`
// is the minimum — the model still skips thinking on easy prompts at low effort.
const CLAUDE_EFFORT_LEVELS = [
  { id: "low", name: "Effort: low", desc: "Minimal — skips thinking on easy prompts" },
  { id: "medium", name: "Effort: medium", desc: "Balanced (recommended for Sonnet)" },
  { id: "high", name: "Effort: high", desc: "Thorough — Opus 4.8 default" },
  { id: "xhigh", name: "Effort: x-high", desc: "Deeper reasoning (Opus 4.7/4.8)" },
  { id: "max", name: "Effort: max", desc: "Maximum (Claude 4.6+ / Sonnet 5 / Fable 5)" },
];

// ctx1m flags the 1,000,000-token context window. thinking flags per-model
// extended-reasoning support (kept for future per-model gating).
const CATALOG = {
  anthropic: {
    label: "Anthropic", desc: "Claude — default primary, fully supported",
    reasoning: "effort", reasoningLevels: CLAUDE_EFFORT_LEVELS,
    defaultModel: "claude-opus-4-8", defaultReasoning: "high",
    primary: "sdk",
    models: [
      { id: "claude-fable-5-1", name: "Fable 5.1", desc: "Newest Fable — most intelligent, top-tier agentic coding", ctx1m: true },
      { id: "claude-opus-5", name: "Opus 5", desc: "Newest Opus — strongest reasoning & agentic coding", ctx1m: true },
      { id: "claude-fable-5", name: "Fable 5", desc: "Most powerful — top-tier reasoning & agentic work", ctx1m: true },
      { id: "claude-opus-4-8", name: "Opus 4.8", desc: "Most capable Opus — deep reasoning & complex builds", ctx1m: true },
      { id: "claude-opus-4-7", name: "Opus 4.7", desc: "Previous Opus — strong reasoning", ctx1m: true },
      { id: "claude-opus-4-6", name: "Opus 4.6", desc: "Older Opus — capable all-rounder", ctx1m: true },
      { id: "claude-sonnet-4-6", name: "Sonnet 4.6", desc: "Balanced speed and capability", ctx1m: true },
      { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", desc: "Fastest — quick edits & questions", ctx1m: false },
    ],
  },
  google: {
    label: "Google (removed)", desc: "Antigravity / agy CLI integration was removed from this build.",
    reasoning: "thinking", reasoningLevels: THINKING_LEVELS,
    defaultModel: "gemini-3.1-pro-preview", defaultReasoning: "off",
    primary: "disabled",
    models: [],
  },
  openai: {
    label: "OpenAI", desc: "GPT / Codex (authorize + API)",
    reasoning: "effort", reasoningLevels: EFFORT_LEVELS,
    defaultModel: "gpt-5.6-sol", defaultReasoning: "high",
    primary: "codex-sdk",    // streams as a primary via @openai/codex-sdk (codex.js)
    // LIVE list comes from the installed Codex binary's embedded catalog (see
    // codexmodels.js / get("openai")) — that's the only source that's right for a
    // ChatGPT login, and it updates itself whenever Codex is updated. This seed is
    // the fallback when no Codex binary can be found (ids valid for Codex 0.153).
    models: [
      { id: "gpt-6-astra", name: "GPT-6-Astra", desc: "Our most capable model for complex, demanding work.", ctx: 272000, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" },
      { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", desc: "Latest frontier agentic coding model.", ctx: 272000, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" },
      { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", desc: "Balanced agentic coding model for everyday work.", ctx: 272000, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium" },
      { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", desc: "Fast and affordable agentic coding model.", ctx: 272000, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      { id: "gpt-5.5", name: "GPT-5.5", desc: "Frontier model for complex coding, research, and real-world work.", ctx: 272000, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      { id: "gpt-5.2", name: "GPT-5.2", desc: "Optimized for professional work and long-running agents.", ctx: 272000, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
    ],
  },
  custom: {
    label: "Custom API", desc: "Anthropic-compatible base URL + key",
    reasoning: "thinking", reasoningLevels: THINKING_LEVELS,
    defaultModel: "", defaultReasoning: "off",
    primary: "sdk",
    models: [],
  },
};

/* ---------------- Codex: live catalog from the installed binary ---------------- */
let _codexMod = null;
function codexCatalog() {
  try { if (!_codexMod) _codexMod = require("./codexmodels"); return _codexMod.load(); } catch { return null; }
}
const EFFORT_NAME = (e) => "Effort: " + (e === "xhigh" ? "x-high" : e);
// One effort ladder for the dropdown = union of the models' ladders (canonical
// order), each level described by the catalog and tagged with the models that lack it.
function effortLadder(models) {
  const have = new Map();
  for (const m of models) for (const e of (m.efforts || [])) if (!have.has(e) && OPENAI_EFFORT_ORDER.includes(e)) have.set(e, (m.effortDesc && m.effortDesc[e]) || "");
  const order = OPENAI_EFFORT_ORDER.filter((e) => have.has(e));
  if (!order.length) return EFFORT_LEVELS;
  return order.map((e) => {
    const withIt = models.filter((m) => (m.efforts || []).includes(e));
    const missing = models.filter((m) => !(m.efforts || []).includes(e));
    const base = have.get(e) || ((EFFORT_LEVELS.find((l) => l.id === e) || {}).desc) || "";
    const tag = missing.length && missing.length < models.length ? ` — ${withIt.map((m) => m.name).join(", ")}` : "";
    return { id: e, name: EFFORT_NAME(e), desc: base + tag };
  });
}
// The OpenAI entry with the LIVE model list: listed models from the installed
// Codex binary (name, description, context, per-model efforts), defaults from the
// user's ~/.codex/config.toml when they name a listed model. Falls back to the seed.
function openaiLive(p) {
  const cat = codexCatalog();
  const all = cat && cat.models && cat.models.length ? cat.models : [];
  const live = all.length ? _codexMod.listed(all) : [];
  const fromCatalog = live.length > 0;
  const nameOf = (id) => { const x = all.find((m) => m.id === id); return x ? x.name : id; };
  // Dropdown subtitles stay short: first clause of Codex's description, capped, and
  // a compact "→ replacement" for a model that is being superseded.
  const shortDesc = (s, max = 40) => { let t = String(s || "").split(/(?<=[.!?])\s|\s[—–-]\s/)[0].replace(/[.。]$/, "").trim(); if (t.length > max) t = t.slice(0, max - 1).replace(/[\s,;:]+\S*$/, "") + "…"; return t; };
  const retireNote = (m) => m.upgrade ? ` → ${nameOf(m.upgrade.model)}` : "";
  const models = (fromCatalog ? live : p.models).map((m) => ({ id: m.id, name: m.name, desc: shortDesc(m.desc, m.upgrade ? 24 : 40) + retireNote(m), ctx: m.ctx || null, ctx1m: false, efforts: m.efforts || [], defaultEffort: m.defaultEffort || "", upgrade: m.upgrade || null }));
  const defaults = (cat && cat.defaults) || {};
  const defaultModel = models.find((m) => m.id === defaults.model) ? defaults.model : (models.find((m) => m.id === p.defaultModel) ? p.defaultModel : (models[0] ? models[0].id : p.defaultModel));
  const ladder = effortLadder(models);
  const dm = models.find((m) => m.id === defaultModel);
  const wantEff = (defaults.effort && ladder.find((l) => l.id === defaults.effort)) ? defaults.effort : ((dm && dm.defaultEffort && ladder.find((l) => l.id === dm.defaultEffort)) ? dm.defaultEffort : (ladder.find((l) => l.id === "high") ? "high" : ladder[ladder.length - 1].id));
  return { ...p, models, defaultModel, defaultReasoning: wantEff, reasoningLevels: ladder, fromCatalog, codexBinary: cat && cat.file ? cat.file : "", catalogSource: (cat && cat.source) || "seed" };
}
function get(provider) {
  const p = CATALOG[provider] || CATALOG.anthropic;
  return provider === "openai" ? openaiLive(p) : p;
}
// Turn a requested Codex model id into one the installed Codex accepts:
// exact → as is; a stale/short id ("gpt-5.6") → the nearest listed slug by prefix
// ("gpt-5.6-sol"); unknown → the default. Without a catalog we can't verify, so
// the id passes through unchanged.
function resolveOpenAIModel(want) {
  const live = get("openai");
  const ids = live.models.map((m) => m.id);
  const w = String(want || "").trim();
  if (!w) return { model: live.defaultModel, changed: !!want, reason: "no model set" };
  if (ids.includes(w)) return { model: w, changed: false };   // listed for this login (even if retiring) → the user's choice stands
  if (!live.fromCatalog) return { model: w, changed: false };  // no catalog at all → can't judge, pass through
  // Not listed. Follow Codex's own `upgrade` chain (gpt-5.4 → gpt-5.6-terra,
  // gpt-5.4-mini → gpt-5.6-luna, …) as far as it leads to a listed model.
  let cur = w, hops = 0;
  while (hops++ < 4) {
    const k = _codexMod && _codexMod.lookup(cur);
    if (!k || !k.upgrade || !k.upgrade.model || k.upgrade.model === cur) break;
    cur = k.upgrade.model;
    if (ids.includes(cur)) return { model: cur, changed: true, reason: `“${w}” was replaced by ${cur} on Codex — using it` };
  }
  // A stale/short id ("gpt-5.6") → the nearest listed slug by prefix ("gpt-5.6-sol").
  const pref = ids.find((id) => id.startsWith(w + "-")) || ids.find((id) => w.startsWith(id + "-"));
  if (pref) return { model: pref, changed: true, reason: `“${w}” isn't a model id on this Codex — using ${pref}` };
  return { model: live.defaultModel, changed: true, reason: `“${w}” isn't available on this Codex install / account — using ${live.defaultModel}` };
}

// Does (provider, model) support the 1M-token context window? Catalog first,
// then a heuristic for Anthropic ids discovered at runtime (Opus/Sonnet/Fable
// 4.6+ yes; Haiku no).
function context1M(provider, modelId) {
  const p = get(provider);
  const m = p.models.find((x) => x.id === modelId);
  if (m) return !!m.ctx1m;
  if (provider === "anthropic") {
    const id = (modelId || "").toLowerCase();
    if (/haiku/.test(id)) return false;
    const mm = /(opus|sonnet)-(\d+)-(\d+)/.exec(id);
    if (mm) return +mm[2] > 4 || (+mm[2] === 4 && +mm[3] >= 6);
    return /opus|sonnet|fable/.test(id);
  }
  if (provider === "google") return /gemini/.test((modelId || "").toLowerCase());
  return false;
}

// Pretty-print an unknown Anthropic id (e.g. a newly released snapshot).
function prettyClaude(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?:-|$))?/.exec(id || "");
  if (!m) return id;
  const fam = `${m[1][0].toUpperCase()}${m[1].slice(1)}`;
  return m[3] !== undefined ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`;
}
function titleize(id) { return String(id || "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }

/* ---------------- LIVE model discovery (dynamic — no hardcoded list) ----------------
 * Each provider is queried for its REAL model list from the official API, using
 * the user's API key OR the token the CLI already stored (so it works for
 * CLI-auth too). The static catalog is only a fallback/seed when discovery can't
 * run (offline / no auth). The fetcher is injectable for tests.
 */
let modelFetcher = null;   // injected: async (provider, token) => [{id,name,ctx1m}]
function setModelFetcher(fn) { modelFetcher = fn; }

function httpJson(url, headers) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "AtomNano", ...(headers || {}) }, timeout: 3500 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      let b = ""; res.on("data", (d) => { b += d; if (b.length > 4_000_000) req.destroy(); }); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
// Find a usable token: explicit API key first, else the CLI's stored auth.
function tokenFor(provider, keys) {
  keys = keys || {};
  const fs = require("fs"), path = require("path"), os = require("os");
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
  // OpenAI: only a real API key can list /v1/models. A ChatGPT (Codex) login token
  // can't — the Codex model list comes from the installed binary instead.
  if (provider === "openai") return keys.openai || null;
  if (provider === "google") { if (keys.google) return keys.google; const a = read(path.join(os.homedir(), ".gemini", "oauth_creds.json")); return (a && a.access_token) || null; }
  if (provider === "anthropic") return keys.anthropic || null;
  return null;
}
async function fetchModels(provider, token) {
  if (modelFetcher) { try { const r = await modelFetcher(provider, token); if (Array.isArray(r)) return r; } catch { /* fall through */ } }
  if (!token) return [];
  try {
    if (provider === "openai") {
      const j = await httpJson("https://api.openai.com/v1/models", { Authorization: "Bearer " + token });
      return (j.data || []).map((m) => m.id).filter((id) => /^(gpt-|o\d|chatgpt|codex)/i.test(id) && !/embed|whisper|tts|dall|image|audio|moderation|realtime/i.test(id)).map((id) => ({ id, name: titleize(id) }));
    }
    if (provider === "google") {
      const j = await httpJson("https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(token));
      return (j.models || []).map((m) => String(m.name || "").replace(/^models\//, "")).filter((id) => /gemini/i.test(id) && !/embedding|aqa/i.test(id)).map((id) => ({ id, name: titleize(id), ctx1m: true }));
    }
    if (provider === "anthropic") {
      const j = await httpJson("https://api.anthropic.com/v1/models", { "x-api-key": token, "anthropic-version": "2023-06-01" });
      // Prefer the API's REAL context window (max_input_tokens, added Mar 2026) so
      // the 1M toggle reflects the model's actual capability, not an id heuristic.
      return (j.data || []).map((m) => ({
        id: m.id,
        name: m.display_name || prettyClaude(m.id),
        ctx: typeof m.max_input_tokens === "number" ? m.max_input_tokens : undefined,
        ctx1m: typeof m.max_input_tokens === "number" ? m.max_input_tokens >= 1000000 : context1M("anthropic", m.id),
      }));
    }
  } catch { /* offline / unauthorized → caller falls back to catalog */ }
  return [];
}

/* Resolve the live model list + reasoning controls for a provider. For Anthropic
 * we also fold in concrete ids discovered from the CLI (newly released models
 * show up at the top). `claudeRef` is the claude.js instance (optional — when
 * absent or for non-Anthropic providers we return the static catalog).
 * `customModels` are the user's own custom-API models (Custom provider only).
 */
async function discover(provider, { claudeRef, customModels, customEndpoints, keys, force } = {}) {
  // Codex: ask the installed Codex for the catalog THIS login can use (server
  // list, account-filtered). Rate-limited inside; forced after an update or a
  // login switch. On failure the sync sources (Codex's cache → bundled) apply.
  if (provider === "openai") { try { if (!_codexMod) _codexMod = require("./codexmodels"); await _codexMod.refresh({ force: !!force, timeoutMs: force ? 30000 : 10000 }); } catch { /* fall back */ } }
  const p = get(provider);
  let models = p.models.map((m) => ({ id: m.id, name: m.name, desc: m.desc, ctx1m: !!m.ctx1m, ctx: m.ctx || null, efforts: m.efforts || null, defaultEffort: m.defaultEffort || "" }));

  if (provider === "anthropic" && claudeRef && typeof claudeRef.discoverModels === "function") {
    try {
      const ids = await claudeRef.discoverModels({ force: !!force });
      const have = new Set(models.map((m) => m.id));
      const fresh = [];
      for (const id of ids || []) if (!have.has(id)) fresh.push({ id, name: prettyClaude(id), desc: "Newly released", ctx1m: context1M("anthropic", id) });
      models = [...fresh, ...models];
    } catch { /* offline / not logged in — static catalog is fine */ }
  }
  if (provider === "custom") {
    // Named custom endpoints are the models. Fall back to legacy customModels.
    const eps = Array.isArray(customEndpoints) ? customEndpoints.filter((e) => e && e.id) : [];
    if (eps.length) models = eps.map((e) => ({ id: e.id, name: e.name || e.id, desc: "Custom API", ctx1m: false }));
    else if (Array.isArray(customModels)) models = customModels.filter((m) => m && m.id).map((m) => ({ id: m.id, name: m.name || m.id, desc: "Custom model", ctx1m: false }));
  }

  // LIVE discovery from the provider's API (key or CLI token). Discovered models
  // lead; the catalog only fills gaps — so the list is dynamic, not hardcoded.
  if (provider !== "custom") {
    try {
      const dyn = await fetchModels(provider, tokenFor(provider, keys));
      if (dyn.length) {
        const have = new Set(models.map((m) => m.id));
        let fresh = dyn.filter((m) => m && m.id && !have.has(m.id)).map((m) => ({ id: m.id, name: m.name || m.id, desc: "Discovered", ctx1m: !!m.ctx1m }));
        // OpenAI with an API key: /v1/models lists the whole API zoo. The Codex
        // catalog stays on top (what the Codex runner is built for); API-only
        // extras go after it, limited to current-generation reasoning models.
        if (provider === "openai" && p.fromCatalog) { fresh = fresh.filter((m) => /^gpt-([5-9]|\d{2})|^o[3-9]|codex/i.test(m.id) && !/chat-latest|search|transcribe|-audio|-realtime|-pro-\d/i.test(m.id)).map((m) => ({ ...m, desc: "API key only" })); models = [...models, ...fresh]; }
        else models = [...fresh, ...models];
      }
    } catch { /* keep catalog */ }
  }

  // Safety net: the Anthropic list must only ever contain Claude models — never a
  // stray cross-provider id from a polluted discovered-models cache.
  if (provider === "anthropic") {
    const isClaude = (id) => /(^|[^a-z])(claude|opus|sonnet|haiku|fable|mythos)([^a-z]|$)/i.test(String(id || ""));
    models = models.filter((m) => isClaude(m.id));
  }

  return {
    provider,
    label: p.label,
    reasoning: p.reasoning,
    reasoningLevels: p.reasoningLevels,
    defaultModel: p.defaultModel,
    defaultReasoning: p.defaultReasoning,
    primary: p.primary,
    models,
    fromCatalog: !!p.fromCatalog, codexBinary: p.codexBinary || "", catalogSource: p.catalogSource || "",
  };
}
// Re-list Codex models for a (possibly different) login — after a profile switch,
// sign-in, or update. Fire-and-forget; listeners (main.js) broadcast changes.
function refreshCodexModels(opts) { try { if (!_codexMod) _codexMod = require("./codexmodels"); return _codexMod.refresh({ force: true, ...(opts || {}) }); } catch { return Promise.resolve(null); } }
function onCodexModelsChange(cb) { try { if (!_codexMod) _codexMod = require("./codexmodels"); return _codexMod.onChange(cb); } catch { return () => {}; } }

// Plain (serialisable) catalog for the reviewers UI — every provider, every
// model, no functions. Used to populate the per-reviewer model pickers.
function catalog() {
  const out = {};
  for (const k of Object.keys(CATALOG)) {
    const p = get(k);   // openai → live list from the installed Codex
    out[k] = { label: p.label, desc: p.desc, reasoning: p.reasoning, reasoningLevels: p.reasoningLevels, defaultModel: p.defaultModel, defaultReasoning: p.defaultReasoning, primary: p.primary, catalogSource: p.catalogSource || "", models: p.models.map((m) => ({ id: m.id, name: m.name, desc: m.desc, ctx1m: !!m.ctx1m, ctx: m.ctx || null, efforts: m.efforts || null, defaultEffort: m.defaultEffort || "" })) };
  }
  return out;
}

// Is this provider wired to drive the PRIMARY turn itself (vs. falling back to
// Anthropic)? "sdk" = Agent SDK, "acp" = ACP streaming (Gemini).
function primaryKind(provider) { return get(provider).primary || null; }

module.exports = { discover, catalog, context1M, primaryKind, get, setModelFetcher, openaiEffort, openaiEffortStrict, openaiEffortsFor, resolveOpenAIModel, resolveOpenAIModelStrict, refreshCodexModels, onCodexModelsChange, THINKING_LEVELS, EFFORT_LEVELS };
