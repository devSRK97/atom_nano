"use strict";
/* Streaming tool arguments (Claude Agent SDK `input_json_delta`): the model's tool call
 * arrives as a JSON object in fragments. Until the whole object parses, this pulls out
 * the TOP-LEVEL string fields that have fully arrived ("file_path", "command", "pattern",
 * …) so the tool card can show what the call targets right away. Nothing is guessed:
 * an unterminated string, a nested object's fields and non-string values are skipped. */

// Decode one JSON string literal starting at s[from] === '"'. Returns [endIndex, value] or null when unterminated.
function readString(s, from) {
  let j = from + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") { j += 2; continue; }
    if (c === '"') { const raw = s.slice(from, j + 1); try { return [j + 1, JSON.parse(raw)]; } catch { return [j + 1, raw.slice(1, -1)]; } }
    j++;
  }
  return null;
}

function partialToolInput(json) {
  const s = String(json || "");
  const out = {};
  let i = 0, depth = 0, key = null, expectValue = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      const r = readString(s, i);
      if (!r) break;                                         // the string is still streaming
      if (depth === 1) {
        if (expectValue && key !== null) { out[key] = r[1]; key = null; expectValue = false; }
        else if (!expectValue) key = r[1];
      }
      i = r[0]; continue;
    }
    if (c === "{" || c === "[") { if (depth === 1 && expectValue) { key = null; expectValue = false; } depth++; i++; continue; }
    if (c === "}" || c === "]") { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 1) {
      if (c === ":" && key !== null && !expectValue) { expectValue = true; i++; continue; }
      if (c === ",") { key = null; expectValue = false; i++; continue; }
      if (expectValue && /[-0-9tfn]/.test(c)) {              // number / true / false / null — not shown, but skip it whole
        let j = i; while (j < s.length && !/[,}\]]/.test(s[j])) j++;
        if (j >= s.length) break;                            // still streaming
        key = null; expectValue = false; i = j; continue;
      }
    }
    i++;
  }
  return out;
}

module.exports = { partialToolInput };
