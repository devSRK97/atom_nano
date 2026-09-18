"use strict";
/* Claude Agent SDK loader + the thinking / effort capability helpers.
 *
 * The SDK is ESM and loaded once (dynamic import). `setSDK` is the test seam: harnesses inject
 * a scripted fake instead of the real package (no network, no CLI). */
let sdkPromise = null;
function loadSDK() {
  if (!sdkPromise) sdkPromise = import("@anthropic-ai/claude-agent-sdk");
  return sdkPromise;
}
// Test seam: a fake { query } takes the SDK's place (null restores the real loader).
function setSDK(fake) { sdkPromise = fake ? Promise.resolve(fake) : null; }

// Legacy models (Haiku) have no adaptive thinking → each effort level maps to a
// fixed thinking-token budget. Keyed by the NORMALISED effort name (see normEffort).
const THINKING_TOKENS = { low: 6000, medium: 12000, high: 20000, xhigh: 31999, max: 31999 };
// Back-compat: old stored session/setting values → the current effort levels, so
// existing sessions (thinking = "off"/"think"/"ultrathink"…) keep working. A rename
// only — never a change of depth.
const EFFORT_ALIAS = {
  off: "low", minimal: "low", think: "low",
  "think-hard": "medium", "think-harder": "high", ultrathink: "xhigh",
  low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
  // "ultracode" is not a sixth effort tier — it IS xhigh, plus standing
  // dynamic-workflow orchestration (see applyUltracode).
  ultracode: "xhigh",
};
function normEffort(level) { return EFFORT_ALIAS[String(level || "").toLowerCase()] || "high"; }
function isUltracode(level) { return String(level || "").toLowerCase() === "ultracode"; }
// Modern models (Opus 4.6+, Sonnet 4.6+, Fable, Mythos) reason via *adaptive*
// thinking: depth is driven with `effort` and a visible summary is requested.
// Older models keep the legacy fixed-budget path.
function supportsAdaptiveThinking(id) {
  const s = (id || "").toLowerCase();
  if (/haiku/.test(s)) return false;
  if (/fable|mythos/.test(s)) return true;
  const m = /claude-(opus|sonnet)-(\d+)-(\d+)/.exec(s);
  if (m) return +m[2] > 4 || (+m[2] === 4 && +m[3] >= 6);
  return /opus|sonnet/.test(s);
}
// `xhigh` effort arrived with Opus 4.7. Opus 4.6 / Sonnet 4.6 top out at `max`.
function supportsXhigh(id) {
  const s = (id || "").toLowerCase();
  if (/haiku/.test(s)) return false;
  if (/fable|mythos/.test(s)) return true;
  if (/opus-5|sonnet-5/.test(s)) return true;
  const m = /claude-(opus|sonnet)-(\d+)-(\d+)/.exec(s);
  if (m) { const maj = +m[2], min = +m[3]; if (m[1] === "opus") return maj > 4 || (maj === 4 && min >= 7); return false; }
  return false;
}
// The effort THIS turn sends. A level the model does not offer is an explicit
// capability error — the run does not start with a silently substituted level.
function effortFor(model, level) {
  const eff = normEffort(level);
  if (eff === "xhigh" && !supportsXhigh(model)) return { effort: null, error: `Effort "xhigh" is not offered by ${model}. Supported: low, medium, high, max. Pick one in the Thinking menu.` };
  return { effort: eff };
}
function applyThinking(options, model, level) {
  const r = effortFor(model, level);
  if (r.error) return r.error;
  if (supportsAdaptiveThinking(model)) {
    options.thinking = { type: "adaptive", display: "summarized" };  // make reasoning visible
    options.effort = r.effort;                                      // low | medium | high | xhigh | max
  } else {
    options.maxThinkingTokens = THINKING_TOKENS[r.effort] || 12000; // legacy fixed budget (Haiku)
  }
  return null;
}

module.exports = { loadSDK, setSDK, THINKING_TOKENS, EFFORT_ALIAS, normEffort, isUltracode, supportsAdaptiveThinking, supportsXhigh, effortFor, applyThinking };
