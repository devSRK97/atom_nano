/* AtomNano renderer — Provider / model / thinking / permission catalogs behind the composer dropdowns.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { modelDD, providerDD, syncEffortForModel, thinkDD, updateOneMVisibility } from "../chat/composer.js";
import { toast } from "./dom.js";
import { atom, state } from "./state.js";

/* ----------------------------- constants ----------------------------- */
export const BUILTIN_MODELS = [
  { id: "claude-fable-5-1", name: "Fable 5.1", desc: "Newest Fable — most intelligent, top-tier agentic coding" },
  { id: "claude-opus-5", name: "Opus 5", desc: "Newest Opus — strongest reasoning & agentic coding" },
  { id: "claude-fable-5", name: "Fable 5", desc: "Most powerful — top-tier reasoning & agentic work" },
  { id: "claude-opus-4-8", name: "Opus 4.8", desc: "Most capable Opus — deep reasoning & complex builds" },
  { id: "claude-opus-4-7", name: "Opus 4.7", desc: "Previous Opus — strong reasoning" },
  { id: "claude-opus-4-6", name: "Opus 4.6", desc: "Older Opus — capable all-rounder" },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6", desc: "Balanced speed and capability" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", desc: "Fastest — quick edits & questions" },
];
export const MODELS = [...BUILTIN_MODELS]; // mutable: discovered (top) + custom (bottom) merged in
// LLM provider — chosen before the model. Anthropic + Custom (Anthropic-compatible
// base URL) run through the Agent SDK today; OpenAI/Google are authorize-ready and
// route generation in a later phase.
export const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", desc: "Claude — default, fully supported" },
  { id: "openai", name: "OpenAI", desc: "GPT / Codex (authorize + API)" },
  { id: "custom", name: "Custom API", desc: "Anthropic-compatible base URL + key" },
];
// Newly-released models discovered from the CLI (concrete ids), shown at the top.
export let DISCOVERED_MODELS = [];
export function setDiscoveredModels(ids) { DISCOVERED_MODELS = Array.isArray(ids) ? ids : []; }
export function prettyModelName(id) {
  // Family-agnostic (so new model lines like "fable" render nicely) and date-safe
  // (a trailing YYYYMMDD snapshot must not be mistaken for a minor version).
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?:-|$))?/.exec(id || "");
  if (!m) return id;
  const fam = `${m[1][0].toUpperCase()}${m[1].slice(1)}`;
  return m[3] !== undefined ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`;
}
// Rebuild the model list: brand-new discovered models first, then the built-ins,
// then user custom models — de-duped.
// Base Anthropic list: the main-process catalog when loaded (single source of
// truth), else the renderer's built-in seed.
export function baseModels() {
  const cat = state.providerCatalog && state.providerCatalog.anthropic;
  return cat && Array.isArray(cat.models) && cat.models.length ? cat.models.map((m) => ({ id: m.id, name: m.name, desc: m.desc })) : BUILTIN_MODELS;
}
export function rebuildModels() {
  MODELS.length = 0;
  const base = baseModels();
  const builtin = new Set(base.map((m) => m.id));
  const custom = state.settings && Array.isArray(state.settings.customModels) ? state.settings.customModels : [];
  const customIds = new Set(custom.map((m) => m.id));
  for (const id of DISCOVERED_MODELS) if (!builtin.has(id) && !customIds.has(id)) MODELS.push({ id, name: prettyModelName(id), desc: "Newly released" });
  MODELS.push(...base);
  for (const m of custom) if (m && m.id && !MODELS.find((x) => x.id === m.id)) MODELS.push({ id: m.id, name: m.name || m.id, desc: "Custom model" });
  if (typeof modelDD !== "undefined" && modelDD) modelDD._refresh();
}
export function applyCustomModels(list) {
  if (list) state.settings.customModels = list;
  rebuildModels();
}
// Which reasoning control the current provider exposes: "thinking" (Claude/Gemini
// thinking levels) or "effort" (OpenAI reasoning effort). Drives the thinking
// dropdown's options + icon.
export let REASONING_KIND = "thinking";
/* Switch the composer to a provider: discover its live models + reasoning
 * controls + 1M-context flags and rebuild the model / thinking dropdowns and the
 * 1M toggle to match. Called on boot and whenever the primary provider changes.
 */
export function applyProviderModels(provider, res, { announce, prevIds } = {}) {
  if (!res || !Array.isArray(res.models)) return;
  if ((state.settings.llmProvider || "anthropic") !== provider) return;   // provider changed again mid-flight
  const before = prevIds || new Set(MODELS.map((m) => m.id));
  const sameProvider = state._modelsProvider === provider;
  state._modelsProvider = provider;
  MODELS.length = 0;
  // one compact subtitle line per option (context size lives in Settings → Tools)
  for (const m of res.models) { const d = String(m.desc || ""); MODELS.push({ id: m.id, name: m.name, desc: d.length > 44 ? d.slice(0, 43).replace(/[\s,;:]+\S*$/, "") + "…" : d }); }
  state.modelCaps = {};
  state.modelEfforts = {};   // per-model effort ladders (Codex) → the effort dropdown adapts to the picked model
  for (const m of res.models) { state.modelCaps[m.id] = !!m.ctx1m; if (Array.isArray(m.efforts) && m.efforts.length) state.modelEfforts[m.id] = { efforts: m.efforts, def: m.defaultEffort || "" }; }

  REASONING_KIND = res.reasoning || "thinking";
  if (Array.isArray(res.reasoningLevels) && res.reasoningLevels.length) { THINKING.length = 0; for (const l of res.reasoningLevels) THINKING.push(l); state.fullLadder = res.reasoningLevels.slice(); }

  // Keep the selected model + reasoning level valid for the new provider.
  if (!MODELS.find((m) => m.id === state.settings.defaultModel)) {
    const v = res.defaultModel || (MODELS[0] && MODELS[0].id) || "";
    state.settings.defaultModel = v; atom.settings.set({ defaultModel: v }).catch(() => {});
  }
  if (!THINKING.find((l) => l.id === state.settings.defaultThinking)) {
    const v = res.defaultReasoning || (THINKING[0] && THINKING[0].id) || "off";
    state.settings.defaultThinking = v; atom.settings.set({ defaultThinking: v }).catch(() => {});
  }
  syncEffortForModel();

  if (providerDD) providerDD._refresh();
  if (modelDD) modelDD._refresh();
  if (thinkDD) { thinkDD._setIcon(REASONING_KIND === "effort" ? "sparkle" : "brain"); thinkDD._refresh(); }
  updateOneMVisibility();
  if (announce) {
    // Anthropic: ids the CLI probe learned. Codex: anything the (updated) binary's
    // catalog lists that wasn't in the dropdown before — same "new model" toast.
    const fresh = provider === "anthropic"
      ? MODELS.filter((m) => m.desc === "Newly released" && !before.has(m.id))
      : (sameProvider && res.fromCatalog ? MODELS.filter((m) => !before.has(m.id)) : []);
    if (fresh.length) toast(`New model${fresh.length > 1 ? "s" : ""} available: ${fresh.map((m) => m.name).join(", ")}`, "sparkle");
  }
}
// `force` re-runs the CLI alias probe even if its cache is fresh (after an update);
// `instant:false` skips the immediate static-catalog apply (used when only
// refining an already-correct list, so discovered models don't blink out).
export async function loadProviderModels(provider, { announce, force, instant = true } = {}) {
  provider = provider || state.settings.llmProvider || "anthropic";
  const cat = state.providerCatalog && state.providerCatalog[provider];
  // CUSTOM: the model list IS the set of configured endpoints. Build it locally
  // from settings so the endpoint names show in the dropdown instantly (and there
  // is no remote model list to discover for a custom API).
  if (provider === "custom") {
    const eps = Array.isArray(state.settings.customEndpoints) ? state.settings.customEndpoints.filter((e) => e && e.id) : [];
    const models = eps.length
      ? eps.map((e) => ({ id: e.id, name: e.name || e.id, desc: "Custom API" }))
      : (Array.isArray(state.settings.customModels) ? state.settings.customModels.filter((m) => m && m.id).map((m) => ({ id: m.id, name: m.name || m.id, desc: "Custom model" })) : []);
    applyProviderModels("custom", {
      models,
      reasoning: (cat && cat.reasoning) || "thinking",
      reasoningLevels: (cat && cat.reasoningLevels) || THINKING,
      defaultModel: (models[0] && models[0].id) || "",
      defaultReasoning: "off",
    }, { announce });
    return;
  }
  // What the dropdown held BEFORE this load (same provider only) — so the "new
  // models" toast after an update compares against the pre-update list, not the
  // instant pass below.
  const prevIds = state._modelsProvider === provider ? new Set(MODELS.map((m) => m.id)) : null;
  // INSTANT: apply the known catalog for this provider so the dropdowns switch
  // immediately (no waiting on a network round-trip).
  if (cat && instant) applyProviderModels(provider, { models: cat.models, reasoning: cat.reasoning, reasoningLevels: cat.reasoningLevels, defaultModel: cat.defaultModel, defaultReasoning: cat.defaultReasoning }, { prevIds });
  // REFINE: live discovery (concrete Anthropic ids / Codex binary catalog /
  // API-discovered models) in the background, then re-apply if still selected.
  let res;
  try { res = await atom.models.discover(provider, force ? { force: true } : null); } catch { return; }
  applyProviderModels(provider, res, { announce, prevIds });
}
export const THINKING = [
  { id: "low", name: "Effort: low", desc: "Minimal — skips thinking on easy prompts" },
  { id: "medium", name: "Effort: medium", desc: "Balanced" },
  { id: "high", name: "Effort: high", desc: "Thorough — Opus 4.8 default" },
  { id: "xhigh", name: "Effort: x-high", desc: "Deeper reasoning (Opus 4.7/4.8)" },
  { id: "max", name: "Effort: max", desc: "Maximum (Claude 4.6+ / Sonnet 5 / Fable 5)" },
  { id: "ultracode", name: "Effort: ultracode", desc: "x-high + a workflow per task — many agents, many tokens" },
];
export const PERMS = [
  { id: "acceptEdits", name: "Accept edits", desc: "Auto-apply edits, run tools", icon: "check" },
  { id: "default", name: "Ask each time", desc: "Confirm before each tool", icon: "shield" },
  { id: "plan", name: "Plan mode", desc: "Plan only — makes no changes", icon: "list" },
  { id: "bypassPermissions", name: "Full access", desc: "Never ask — run everything", icon: "sparkle" },
];
export const FONT_SIZES = { small: 13, medium: 14, large: 15 };
