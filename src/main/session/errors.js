"use strict";
/* Error classification for every provider path: transient (network / rate limit / auth) vs
 * capability (prompt too long, lost native session) vs everything else — and the user-facing
 * sentence for an unclassified failure. Pure functions, no state. */

// Friendly provider names for user-facing pause/resume messages.
const PROVIDER_LABEL = { anthropic: "Claude", openai: "OpenAI", google: "Antigravity", custom: "API" };

function isNetworkError(e) {
  const msg = String((e && e.message) || e || "").toLowerCase();
  return /econnrefused|enotfound|eai_again|etimedout|econnreset|socket hang up|network|fetch failed|getaddrinfo|dns|eproto|epipe|ehostunreach|enetunreach/.test(msg);
}
// Auth/token-expiry: RECOVERABLE — pause the session (context intact) and resume
// once the user re-authenticates. Genuine auth signals only.
function isAuthError(e) {
  const msg = String((e && e.message) || e || "").toLowerCase();
  return /\b401\b|\b403\b|unauthor|invalid[_ ]?api[_ ]?key|invalid[_ ]credentials|authentication fail|token (?:has )?expired|expired token|access token|refresh token|\boauth\b|login required|not logged in|please log ?in|re-?authenticate/.test(msg);
}
function isRateLimitError(e) {
  const msg = String((e && e.message) || e || "").toLowerCase();
  const status = e && (e.status || e.statusCode || e.api_error_status);
  if (status === 429 || status === 529) return true;
  return /\b429\b|\b529\b|rate.?limit|rate.?limited|too many requests|overloaded|\bquota\b|capacity|try again later|temporarily unavailable/.test(msg);
}
// The provider rejected the request because it does not fit the model's context window
// (Anthropic "prompt is too long", OpenAI/Codex "context window exceeded" /
// context_length_exceeded, HTTP 413). Recovery: a NEW thread with a summarised record
// (see transferBlock) — never a blind retry of the same request.
function isPromptTooLong(err) {
  if (err && err.promptTooLong) return true;
  const msg = String((err && err.message) || err || "").toLowerCase();
  return /prompt.*(too long|too large)|input.*too long|too many (?:total )?tokens|request.*(too large|entity too large)|token.*exceed|context.*length.*exceed|context_length_exceeded|context.?window.?exceeded|exceeds? the (?:model'?s )?context|max.*context|payload too large|\b413\b/.test(msg);
}
// A resume the CLI could not honour (the transcript for that id is gone).
function isSessionGone(err) {
  const msg = String((err && err.message) || err || "").toLowerCase();
  return /no conversation found|session.*not found|could not resume|unknown session|no such session|conversation.*does not exist/.test(msg);
}

// Map a raw SDK/transport error to a clear, user-facing sentence.
function describeError(e) {
  const raw = e && e.message ? e.message : String(e || "");
  const low = raw.toLowerCase();
  if (/abort/.test(low)) return "Stopped.";
  if (/econnrefused|enotfound|eai_again|etimedout|econnreset|socket hang up|network|fetch failed|getaddrinfo|dns/.test(low))
    return "Connection lost — Claude couldn't reach the server. Check your internet or VPN and try again.";
  if (/\b429\b|rate.?limit|overloaded|\b529\b/.test(low))
    return "Claude is overloaded or you've hit a rate limit. Wait a moment and resend.";
  if (/\b401\b|\b403\b|unauthor|authentication|invalid api key|api key|credentials/.test(low))
    return "Authorization error — re-check your Claude login or API key in Settings.";
  if (/prompt.*(too long|too large)|too many tokens|context.*length|payload too large/.test(low))
    return "The provider rejected the request as too large for the model's context window: " + raw;
  if (/\b5\d\d\b|server error|internal error|service unavailable/.test(low))
    return "Claude API server error. Please try again shortly.";
  if (/exited|spawn|enoent|failed to launch/.test(low))
    return "The Claude CLI process couldn't run. Check the CLI path in Settings.";
  return "Error: " + raw;
}

module.exports = { PROVIDER_LABEL, isNetworkError, isAuthError, isRateLimitError, isPromptTooLong, isSessionGone, describeError };
