"use strict";
/* Tool-call bookkeeping shared by the runners: which tools edit files / spawn agents, tool
 * result text, edit line-diffs, the incremental scan of STREAMED tool arguments, per-turn usage
 * sums and run ids. Pure helpers, no state beyond the run-id counter. */


// Live tool-argument streaming: the growing JSON is coalesced into at most one renderer update
// per STREAM_ARGS_MS per card, carrying a BOUNDED excerpt — never the whole (possibly huge)
// body on every fragment.
const STREAM_ARGS_MS = 120, STREAM_ARGS_PREVIEW = 6000, STREAM_ARGS_SCAN_MAX = 262144;
const excerptArgs = (s) => (s.length <= STREAM_ARGS_PREVIEW ? s : s.slice(0, Math.round(STREAM_ARGS_PREVIEW * 0.6)) + `\n… ${(s.length - STREAM_ARGS_PREVIEW).toLocaleString("en-US")} more characters still streaming …\n` + s.slice(-Math.round(STREAM_ARGS_PREVIEW * 0.4)));
// Incremental JSON structure scan over one streamed fragment (string/escape aware). Returns true
// once the top-level object has closed — the only moment a full JSON.parse is worth attempting.
function scanJsonState(st, frag) {
  if (st.depth == null) { st.depth = 0; st.inStr = false; st.esc = false; st.opened = false; st.complete = false; }
  for (let i = 0; i < frag.length; i++) {
    const c = frag[i];
    if (st.inStr) { if (st.esc) st.esc = false; else if (c === "\\") st.esc = true; else if (c === '"') st.inStr = false; continue; }
    if (c === '"') st.inStr = true;
    else if (c === "{" || c === "[") { st.depth++; st.opened = true; }
    else if (c === "}" || c === "]") { st.depth--; if (st.depth === 0 && st.opened) st.complete = true; }
  }
  return st.complete;
}
// Stop: the harness is asked to end the turn first (it cancels the running tool and the shell
// processes it started); the transport is torn down only if the turn has not wound down by then.
const INTERRUPT_GRACE_MS = 4000;


const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update", "create_file", "str_replace"]);
// Delegation tools that spawn worker sub-agents — removed from the model unless the user opts in.
const SUBAGENT_TOOLS = /^(Task|Agent)$/i;

function toolResultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b && b.type === "text" ? b.text : b && b.text ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && content.text) return content.text;
  try { return JSON.stringify(content); } catch { return String(content); }
}
function linesOf(str) { return !str ? 0 : String(str).split("\n").length; }
// Approximate lines added/removed for an edit tool call.
function computeDiff(toolName, input) {
  if (!input) return { added: 0, removed: 0 };
  switch (toolName) {
    case "Write": case "create_file": return { added: linesOf(input.content), removed: 0 };
    case "Edit": case "str_replace": return { added: linesOf(input.new_string), removed: linesOf(input.old_string) };
    case "MultiEdit": {
      let a = 0, r = 0;
      for (const e of (input.edits || [])) { a += linesOf(e.new_string); r += linesOf(e.old_string); }
      return { added: a, removed: r };
    }
    case "NotebookEdit": return { added: linesOf(input.new_source), removed: 0 };
    default: return { added: 0, removed: 0 };
  }
}


// Sum a result message's per-model usage map (modelUsage) into one total — covers
// EVERY query-pipeline call (main loop + subagents + reviewers).
function sumModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  const t = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, models: 0 };
  for (const key of Object.keys(modelUsage)) {
    const v = modelUsage[key] || {};
    t.inputTokens += v.inputTokens || 0;
    t.outputTokens += v.outputTokens || 0;
    t.cacheReadInputTokens += v.cacheReadInputTokens || 0;
    t.cacheCreationInputTokens += v.cacheCreationInputTokens || 0;
    t.costUSD += v.costUSD || 0;
    t.models++;
  }
  return t.models ? t : null;
}

let runSeq = 0;
const newRunId = () => `run-${Date.now().toString(36)}-${(++runSeq).toString(36)}`;

module.exports = { STREAM_ARGS_MS, STREAM_ARGS_PREVIEW, STREAM_ARGS_SCAN_MAX, excerptArgs, scanJsonState, INTERRUPT_GRACE_MS, EDIT_TOOLS, SUBAGENT_TOOLS, toolResultText, linesOf, computeDiff, sumModelUsage, newRunId };
