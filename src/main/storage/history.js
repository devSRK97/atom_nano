"use strict";
/* Canonical conversation record + lossless provider-transfer adapter.
 *
 * The session's message array (plus its on-disk archive) is the ONE record of
 * the conversation, independent of provider, native thread, account and UI view.
 * Each provider keeps a BINDING on the session:
 *
 *   session.bindings[provider] = { id, syncedIndex, account, briefHash?, skillsHash? }
 *     id           native thread / SDK session id (null = no thread yet)
 *     syncedIndex  GLOBAL index of the last canonical message that thread has
 *                  received (−1 = nothing). Global indexes count the archive
 *                  first, then the live array — see store.getMessagesRange.
 *     account      identity hash of the login the thread was created under
 *     skillsHash   the skill selection (role skills) the thread last ACCEPTED — session/index.js
 *                  skillSnapshot; the next turn sends a pointer instead of the procedures (2026-09-18)
 *     briefHash    (Codex only) the role / agents briefs the thread last accepted — same purpose; "" once the
 *                  set went away. briefKinds ("r" role, "a" agents) is the composition behind that hash, so a
 *                  changed set can name exactly the brief kind the thread lost (2026-09-18)
 *                  All three belong to the native thread: a patch that CHANGES the id (a replacement
 *                  thread, a drop) clears them before it is merged; same-id metadata keeps them.
 *
 * When a provider is about to generate and its thread has NOT seen every
 * message before the current prompt (a provider switch, a lost thread, a fresh
 * thread after a failed resume), the missing messages are transferred EXACTLY:
 * full text, every completed tool call with its input and result, attachment
 * references. Nothing is summarised, clipped, or re-executed. Tool calls travel
 * as completed history, never as instructions to run again.
 *
 * Two output shapes:
 *   transcriptBlock()  — plain text for a prompt (Claude / Codex SDK / custom)
 *   codexItems()       — Responses API items for `thread/inject_items`
 */
const store = require("./store");

const PROVIDER_ROLE_LABEL = { user: "User", assistant: "Assistant" };

function lastGlobalIndex(session) {
  return (session.archivedCount || 0) + (session.messages || []).length - 1;
}

function bindings(session) {
  if (!session.bindings || typeof session.bindings !== "object") session.bindings = {};
  return session.bindings;
}
function bindingFor(session, provider) {
  const b = bindings(session);
  if (!b[provider]) b[provider] = { id: null, syncedIndex: -1, account: "" };
  return b[provider];
}
function setBinding(session, provider, patch) {
  const cur = bindingFor(session, provider);
  patch = patch || {};
  // The prompt-delivery caches (briefHash + briefKinds / skillsHash) describe what THIS native thread has received. A
  // patch that changes the thread — a replacement thread taking over, a drop to null — clears them first (a patch
  // that carries new hashes for the new thread sets them right after); a same-id update leaves them alone.
  if (Object.prototype.hasOwnProperty.call(patch, "id") && (patch.id || null) !== (cur.id || null)) { delete cur.briefHash; delete cur.briefKinds; delete cur.skillsHash; }
  Object.assign(cur, patch);
  // Legacy mirrors so old readers (renderer meta, older code paths) keep working.
  if (provider === "anthropic") session.claudeSessionId = cur.id || null;
  if (provider === "openai") session.codexThreadId = cur.id || null;
  store.scheduleWrite(session.id);
  return cur;
}
function dropBinding(session, provider) {
  return setBinding(session, provider, { id: null, syncedIndex: -1 });
}

// Messages [from, to] by GLOBAL index (inclusive), archive included.
function range(session, from, to) {
  if (to < from) return [];
  const r = store.getMessagesRange(session.id, to + 1, to - from + 1);
  return r && Array.isArray(r.messages) ? r.messages : [];
}

// An entry produced INSIDE a sub-agent (its tool calls, its text, its thinking — parentToolUseId
// names the Agent / Task call it ran under). It is the worker's own working context, not the
// conversation: the Agent tool entry and its result carry the outcome into the primary thread.
function isAgentInternal(m) { return !!(m && m.parentToolUseId); }
// Which canonical messages count as conversation history for a model — the PRIMARY conversation
// only (user decision 2026-09-17: a fresh thread, a summary or a handoff never carries the
// sub-agents' internal entries; 4,529 of the 5,000 live entries of one session were such entries).
function isHistoryMessage(m) {
  if (!m || !m.role) return false;
  if (isAgentInternal(m)) return false;
  if (m.role === "user" || m.role === "assistant") return !!(m.text && String(m.text).trim()) || (Array.isArray(m.attachments) && m.attachments.length);
  if (m.role === "tool") return true;
  if (m.role === "planner" || m.role === "reviewer") return !!m.text;   // explicit workflows the user ran — part of what was said
  if (m.role === "record") return !!m.text;   // the bounded record a synthesized session carries from its source (already model-ready text)
  return false;   // system notes, errors, result footers, thinking cards, summary cards: app-side
}
// GLOBAL index of a live message by id (−1 when it is not in the live array).
function indexOfMessage(session, id) {
  if (!id) return -1;
  const i = (session.messages || []).findIndex((m) => m && m.id === id);
  return i < 0 ? -1 : (session.archivedCount || 0) + i;
}

function toolInputText(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}
function attachmentsText(atts) {
  if (!Array.isArray(atts) || !atts.length) return "";
  return "\n[attachments: " + atts.map((a) => `${a.kind || "file"} ${a.path || a.name || ""}`.trim()).join("; ") + "]";
}

// One canonical message → one verbatim text entry.
function entryText(m) {
  if (m.role === "tool") {
    const st = m.status ? ` (${m.status})` : "";
    const inp = toolInputText(m.toolInput);
    const res = m.result != null && m.result !== "" ? `\n[result]\n${typeof m.result === "string" ? m.result : toolInputText(m.result)}` : "";
    return `[Tool ${m.toolName || "tool"}${st}]${inp ? "\n[input]\n" + inp : ""}${res}`;
  }
  if (m.role === "record") return String(m.text || "");   // already a labelled record block
  const label = PROVIDER_ROLE_LABEL[m.role] || (m.role === "planner" ? "Planner" : m.role === "reviewer" ? `Reviewer${m.reviewModel ? " " + m.reviewModel : ""}` : m.role);
  return `${label}:\n${String(m.text || "")}${attachmentsText(m.attachments)}`;
}

/* Verbatim transcript of canonical messages (from, to] as ONE text block the
 * next request carries as conversation data. `from` = last synced global index
 * (−1 for none); `to` = last global index to include (normally the index just
 * BEFORE the current prompt). Returns { text, count, lastIndex }. */
function transcriptBlock(session, from, to) {
  const msgs = range(session, from + 1, to).filter(isHistoryMessage);
  if (!msgs.length) return { text: "", count: 0, lastIndex: to };
  const head = `Conversation record — ${msgs.length} earlier entr${msgs.length === 1 ? "y" : "ies"} of this same conversation, verbatim, in order. ` +
    "This is history the previous model already produced or ran; tool entries are completed results, not requests to run again. Continue the conversation from here.";
  return { text: head + "\n\n" + msgs.map(entryText).join("\n\n---\n\n"), count: msgs.length, lastIndex: to };
}

/* Responses API items for Codex `thread/inject_items` — appended to the
 * thread's model-visible history without starting generation. User turns become
 * user messages; assistant text, planner/reviewer text and completed tool
 * records become assistant messages (the model that produced them was the
 * assistant of this conversation). */
function codexItems(session, from, to) {
  const msgs = range(session, from + 1, to).filter(isHistoryMessage);
  const items = [];
  for (const m of msgs) {
    if (m.role === "user") items.push({ type: "message", role: "user", content: [{ type: "input_text", text: String(m.text || "") + attachmentsText(m.attachments) }] });
    else items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: entryText(m) }] });
  }
  return { items, count: items.length, lastIndex: to };
}

/* Decide what the provider's thread is missing before the prompt at index
 * `promptIndex` (the current user message). */
function pendingSync(session, provider, promptIndex) {
  const b = bindingFor(session, provider);
  const to = promptIndex - 1;
  return { binding: b, from: b.syncedIndex, to, needed: b.syncedIndex < to };
}

/* ---------------- Budgeted transfer (the user's explicit exception, 2026-09-10) ----------------
 * The EXACT record stays the default whenever it fits the destination model's context
 * window. Only when it cannot fit — it would fail with "prompt is too long" / "context
 * window exceeded" — the transfer degrades, visibly and never silently, in two steps:
 *   "shortened"  conversation text (user / assistant / planner / reviewer) stays verbatim;
 *                tool inputs and results (the bulk: file contents, command output) keep a
 *                head plus a size note — the model can re-read any file it needs.
 *   "summary"    the OLDEST part is condensed by a model (summaries are cached on the
 *                session and rolled forward — the same span is never summarised twice)
 *                and the NEWEST entries travel verbatim (shortened form) within the budget.
 * The canonical record on disk is untouched; what the model received is announced in the
 * chat and the summary itself is shown as its own card. */
const CHARS_PER_TOKEN = 4;                 // conservative estimate for budget maths (code-heavy text)
const SHORT_INPUT_KEEP = 600;              // chars of a tool INPUT kept in the shortened form (head)
const SHORT_RESULT_HEAD = 1000;            // chars of a tool RESULT kept from its start …
const SHORT_RESULT_TAIL = 500;             // … and from its END (exit codes, final errors, summaries live there)
const fmtN = (n) => Number(n || 0).toLocaleString("en-US");

// Never split a surrogate pair (an emoji / rare CJK character) when cutting text.
const safeCut = (s, i) => { if (i > 0 && i < s.length) { const c = s.charCodeAt(i); if (c >= 0xdc00 && c <= 0xdfff) return i - 1; } return i; };
/* Shortened text: the head, an omission note that names the exact record entry (so the
 * original can be looked up — never "re-run the command"), and optionally the TAIL, where a
 * command's outcome usually is. */
function shortenText(s, head, tail = 0, ref = "") {
  s = String(s || "");
  if (s.length <= head + tail) return s;
  const a = safeCut(s, head), b = tail ? safeCut(s, s.length - tail) : s.length;
  const note = `\n… [${fmtN(b - a)} characters omitted here — the complete text is in the conversation record${ref ? ` (entry ${ref})` : ""}; look it up rather than re-running anything] …\n`;
  return s.slice(0, a) + note + (tail ? s.slice(b) : "");
}
// An excerpt bounded to `max` characters: start and end kept, middle replaced by the omission note.
function excerptText(s, max, ref = "") {
  s = String(s || "");
  if (s.length <= max) return s;
  const keep = Math.max(200, Math.floor((max - 220) / 2));
  return shortenText(s, keep, keep, ref);
}
// Shortened entry: conversation text verbatim; tool payloads reduced to head (+ tail for results) with the entry's id.
function entryTextShort(m) {
  if (m.role !== "tool") return entryText(m);
  const st = m.status ? ` (${m.status})` : "";
  const ref = m.id ? String(m.id) : "";
  const inp = shortenText(toolInputText(m.toolInput), SHORT_INPUT_KEEP, 0, ref);
  const resRaw = m.result != null && m.result !== "" ? (typeof m.result === "string" ? m.result : toolInputText(m.result)) : "";
  const res = resRaw ? `\n[result]\n${shortenText(resRaw, SHORT_RESULT_HEAD, SHORT_RESULT_TAIL, ref)}` : "";
  return `[Tool ${m.toolName || "tool"}${st}${ref ? ` · entry ${ref}` : ""}]${inp ? "\n[input]\n" + inp : ""}${res}`;
}
/* Split one oversized text into ordered segments of at most `maxChars`, cutting at paragraph /
 * line boundaries when one exists in the last fifth of the window, never inside a surrogate pair.
 * Used so that a single huge entry (a pasted document, a giant reply, a carried record) is
 * summarised in pieces instead of being handed to one model call whole. */
function segmentText(s, maxChars) {
  s = String(s || ""); const out = [];
  if (s.length <= maxChars) return [s];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + maxChars);
    if (end < s.length) {
      const floor = i + Math.floor(maxChars * 0.8);
      const para = s.lastIndexOf("\n\n", end), line = s.lastIndexOf("\n", end);
      if (para > floor) end = para + 2; else if (line > floor) end = line + 1;
      end = safeCut(s, end);
    }
    out.push(s.slice(i, end)); i = end;
  }
  return out;
}
const SEP = "\n\n---\n\n";
const TAIL_NOTE = "This is history the previous model already produced or ran; tool entries are completed results, not requests to run again. Continue the conversation from here.";
const headExact = (n) => `Conversation record — ${n} earlier entr${n === 1 ? "y" : "ies"} of this same conversation, verbatim, in order. ` + TAIL_NOTE;
const headShort = (n, handoff) => `Conversation record — ${n} earlier entr${n === 1 ? "y" : "ies"} of this same conversation, in order. Conversation text is verbatim; long tool inputs and outputs were shortened ${handoff ? "for this handoff" : "to fit the model's context window"} (re-read a file if you need its current content). ` + TAIL_NOTE;
// A HANDOFF (synthesize → new session) is condensed by design, not because the window is small.
const headSummary = (plan) => (plan.handoff
  ? `Conversation record — the source conversation condensed into a handoff: the ${fmtN(plan.headCount)} oldest entr${plan.headCount === 1 ? "y is" : "ies are"} carried as a summary and the ${fmtN(plan.count - plan.headCount)} most recent entr${plan.count - plan.headCount === 1 ? "y" : "ies"} verbatim (long tool inputs/outputs shortened); the complete record (${fmtN(plan.count)} entries, ${fmtN(plan.fullChars)} characters) stays in the source session. `
  : `Conversation record — this same conversation so far. The full record (${fmtN(plan.count)} entries, ${fmtN(plan.fullChars)} characters) is larger than the model's context window, so the ${fmtN(plan.headCount)} oldest entr${plan.headCount === 1 ? "y is" : "ies are"} carried as a summary and the ${fmtN(plan.count - plan.headCount)} most recent entr${plan.count - plan.headCount === 1 ? "y" : "ies"} verbatim (long tool inputs/outputs shortened). `) + TAIL_NOTE;

/* Plan the transfer of (from, to] within `budgetChars`.
 *   { mode: "exact" | "shortened", msgs:[{m,g}], texts, text, count, chars, fullChars, headCount: 0 }
 *   { mode: "summary", msgs, texts, count, fullChars, headCount, head:{ from, to }, tail:{ from, to }, budgetChars }
 * (`text` for the summary mode is assembled by transferText once the summary exists.)
 * `handoff` only changes the framing sentences: the record is condensed for a fresh session by
 * design rather than to fit a context window. */
function planTransfer(session, from, to, { budgetChars = Infinity, forceSummary = false, tailShare = 0.5, handoff = false } = {}) {
  const all = range(session, from + 1, to);
  const msgs = [];
  // agentEntries: what the span holds from INSIDE sub-agents (tool calls, text) — never carried; the
  // transfer note tells the user how many were left out and where their outcomes are.
  let agentEntries = 0;
  all.forEach((m, i) => { if (isHistoryMessage(m)) msgs.push({ m, g: from + 1 + i }); else if (isAgentInternal(m) && (m.role === "tool" || (m.role === "assistant" && m.text))) agentEntries++; });
  handoff = !!handoff;
  if (!msgs.length) return { mode: "exact", msgs, texts: [], text: "", count: 0, chars: 0, fullChars: 0, headCount: 0, handoff, agentEntries };
  // Measure without retaining several copies of a huge tool transcript. Only assemble the exact
  // record when it fits; otherwise the original payloads stay in the canonical store.
  let fullChars = headExact(msgs.length).length + 2 + Math.max(0, msgs.length - 1) * SEP.length;
  let exact = [];
  for (const x of msgs) { const text = entryText(x.m); fullChars += text.length; if (exact && !forceSummary && fullChars <= budgetChars) exact.push(text); else exact = null; }
  if (exact && !forceSummary && fullChars <= budgetChars) { const text = headExact(msgs.length) + "\n\n" + exact.join(SEP); return { mode: "exact", msgs, texts: exact, text, count: msgs.length, chars: text.length, fullChars, headCount: 0, handoff, agentEntries }; }
  const short = msgs.map((x) => entryTextShort(x.m));
  const shortChars = headShort(msgs.length, handoff).length + 2 + Math.max(0, msgs.length - 1) * SEP.length + short.reduce((n, text) => n + text.length, 0);
  if (!forceSummary && shortChars <= budgetChars) {
    const shortText = headShort(msgs.length, handoff) + "\n\n" + short.join(SEP);
    return { mode: "shortened", msgs, texts: short, text: shortText, count: msgs.length, chars: shortChars, fullChars, headCount: 0, handoff, agentEntries };
  }
  // Newest entries verbatim within `tailShare` of the budget; everything before them is summarised.
  const tailBudget = Math.max(0, Math.floor((Number.isFinite(budgetChars) ? budgetChars : shortChars) * tailShare));
  let tailStart = msgs.length, used = 0;
  while (tailStart > 0) { const len = short[tailStart - 1].length + SEP.length; if (used + len > tailBudget) break; used += len; tailStart--; }
  // The NEWEST entry must always travel verbatim as far as the budget allows: when it alone is
  // larger than the tail share, an excerpt (start + end) stands in for it instead of pushing the
  // whole recent context into the summary.
  if (tailStart === msgs.length && msgs.length > 0 && tailBudget > 600) {
    const last = msgs.length - 1;
    short[last] = excerptText(short[last], tailBudget - SEP.length, msgs[last].m && msgs[last].m.id ? String(msgs[last].m.id) : "");
    tailStart = last;
  }
  if (tailStart === 0) {   // the whole record fits the tail share (newest entry possibly excerpted) — nothing left to summarise
    const text = headShort(msgs.length, handoff) + "\n\n" + short.join(SEP);
    return { mode: "shortened", msgs, texts: short, text, count: msgs.length, chars: text.length, fullChars, headCount: 0, handoff, agentEntries };
  }
  return { mode: "summary", msgs, texts: short, count: msgs.length, fullChars, headCount: tailStart, head: { from, to: msgs[tailStart - 1].g }, tail: { from: msgs[tailStart - 1].g, to }, budgetChars, tailShare, handoff, agentEntries };
}
// The sentence a transfer note adds when the span held sub-agent internal entries (none carried).
function agentEntriesNote(plan) {
  const n = plan && plan.agentEntries;
  if (!n) return "";
  return ` ${fmtN(n)} entr${n === 1 ? "y" : "ies"} produced inside sub-agents ${n === 1 ? "is" : "are"} not carried — only the primary conversation travels; the agents' outcomes are in their Agent tool results.`;
}
// Text form of a planned transfer (prompt block for Claude / Codex exec / custom / planner / reviewers).
function transferText(plan, summary) {
  if (!plan || !plan.count) return "";
  if (plan.mode !== "summary") return plan.text;
  const tail = plan.texts.slice(plan.headCount);
  return headSummary(plan) + "\n\n[Summary of the earlier conversation]\n" + String(summary || "").trim() + (tail.length ? SEP + "[Most recent entries, verbatim]" + SEP + tail.join(SEP) : "");
}
// Responses API items (Codex `thread/inject_items`) for a planned transfer.
function transferItems(plan, summary) {
  if (!plan || !plan.count) return [];
  const items = [];
  const userItem = (m) => ({ type: "message", role: "user", content: [{ type: "input_text", text: String(m.text || "") + attachmentsText(m.attachments) }] });
  const assistantItem = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  let start = 0;
  if (plan.mode === "summary") {
    const why = plan.handoff ? "condensed for this handoff into a fresh session" : `condensed because the full record (${fmtN(plan.fullChars)} characters) is larger than the model's context window`;
    items.push(userItem({ text: `[Conversation summary — the ${fmtN(plan.headCount)} oldest entries of this same conversation, ${why}. Tool entries below are completed results, not requests to run again.]\n\n${String(summary || "").trim()}` }));
    start = plan.headCount;
  }
  for (let i = start; i < plan.msgs.length; i++) { const m = plan.msgs[i].m; items.push(m.role === "user" ? (plan.texts[i] === entryText(m) ? userItem(m) : userItem({ text: plan.texts[i] })) : assistantItem(plan.texts[i])); }
  return items;
}
/* Summary cache on the session: { from, upTo, text, provider, model, ts, entries }. A summary
 * covers the record span (from, upTo]. The best cached entry for a head (from, upToMax] is the
 * one with the same start and the largest upTo not beyond it — the caller rolls forward from there. */
/* Best cached summary for a head (from, upToMax]: same start preferred; a checkpoint that
 * STARTS EARLIER is also usable (it covers what the thread already knows plus the head — a
 * little redundancy is far cheaper than a new model call). Never one that ends beyond the head. */
function cachedSummary(session, from, upToMax) {
  const list = Array.isArray(session.summaries) ? session.summaries : [];
  let best = null;
  const rank = (s) => (s.from === from ? 1 : 0) * 1e12 + s.upTo;
  for (const s of list) if (s && typeof s.text === "string" && s.text && s.from <= from && s.upTo > from && s.upTo <= upToMax && (!best || rank(s) > rank(best))) best = s;
  return best;
}
/* Remember a summary. Retention keeps the LATEST checkpoint of every distinct start (the root
 * checkpoint from −1 above all) and trims only superseded intermediates of the same start — a
 * count is a memory bound, never a correctness boundary. */
const MAX_SUMMARIES = 60;
function rememberSummary(session, entry) {
  if (!Array.isArray(session.summaries)) session.summaries = [];
  session.summaries = session.summaries.filter((s) => !(s && s.from === entry.from && s.upTo === entry.upTo));
  session.summaries.push(entry);
  if (session.summaries.length > MAX_SUMMARIES) {
    const latestByStart = new Map();
    for (const s of session.summaries) { const cur = latestByStart.get(s.from); if (!cur || s.upTo > cur.upTo) latestByStart.set(s.from, s); }
    const keepers = new Set(latestByStart.values());
    const intermediates = session.summaries.filter((s) => !keepers.has(s));
    while (session.summaries.length > MAX_SUMMARIES && intermediates.length) { const drop = intermediates.shift(); session.summaries.splice(session.summaries.indexOf(drop), 1); }
    // still too many distinct starts: drop the oldest non-root checkpoints
    while (session.summaries.length > MAX_SUMMARIES) { const i = session.summaries.findIndex((s) => s.from !== -1); if (i < 0) break; session.summaries.splice(i, 1); }
  }
  store.scheduleWrite(session.id);
  return entry;
}
/* Reuse a cached summary that covers MORE than the planned head: extend the head to it
 * (the verbatim tail then starts right after) so no model call is needed. Only when at least
 * half of the planned verbatim tail (and one entry) survives — the newest entries verbatim
 * are what makes the continuation precise. Returns true when the plan was adjusted. */
function extendHead(plan, upTo) {
  if (!plan || plan.mode !== "summary" || upTo <= plan.head.to) return false;
  const newHead = plan.msgs.filter((x) => x.g <= upTo).length;
  const plannedTail = plan.count - plan.headCount, remaining = plan.count - newHead;
  if (remaining < 1 || remaining < Math.ceil(plannedTail / 2)) return false;
  plan.headCount = newHead; plan.head.to = upTo; plan.tail.from = upTo;
  return true;
}
const approxTokens = (s) => Math.ceil(String(s || "").length / CHARS_PER_TOKEN);

module.exports = { lastGlobalIndex, indexOfMessage, bindingFor, setBinding, dropBinding, transcriptBlock, codexItems, pendingSync, isHistoryMessage, isAgentInternal, agentEntriesNote, entryText, entryTextShort, shortenText, excerptText, segmentText, planTransfer, transferText, transferItems, cachedSummary, rememberSummary, extendHead, approxTokens, CHARS_PER_TOKEN, MAX_SUMMARIES };
