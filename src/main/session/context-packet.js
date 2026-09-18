"use strict";
/* A working handoff, not a second copy of the transcript. Pure helpers: no model calls or I/O.
 * Native model context is independent of this budget. These packets are used only for explicit
 * synthesis or a record which cannot fit a new thread. Source references allow exact retrieval. */
const MAX_PACKET_BYTES = 32768;
const MAX_EVIDENCE_BYTES = 32768;
const MIN_PACKET_BYTES = 12288;
const bytes = (text) => Buffer.byteLength(String(text || ""), "utf8");
function prefix(text, limit) {
  const b = Buffer.from(String(text || ""), "utf8");
  let end = Math.max(0, Math.min(b.length, Math.floor(limit)));
  while (end > 0 && end < b.length && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString("utf8");
}
function excerpt(text, limit) {
  text = String(text || ""); limit = Math.max(0, Math.floor(limit));
  if (bytes(text) <= limit) return text;
  const note = "\n[excerpt; full text remains in the source record]\n";
  if (limit <= bytes(note) + 16) return prefix(text, limit);
  const available = limit - bytes(note), head = Math.floor(available * 0.6);
  const b = Buffer.from(text, "utf8"); let start = b.length - (available - head);
  while (start < b.length && (b[start] & 0xc0) === 0x80) start++;
  return prefix(text, head) + note + b.subarray(start).toString("utf8");
}
function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
const refOf = ({ m, g }) => `entry ${g}${m.id ? ` / ${prefix(m.id, 96)}` : ""}`;
function evidence(row, limit = 2000) {
  const { m } = row;
  const label = `[${refOf(row)} | ${prefix(m.role, 32)}${m.ts ? ` | ${prefix(m.ts, 40)}` : ""}]`;
  let body;
  if (m.role === "tool") {
    const input = m.toolInput;
    const target = input && typeof input === "object"
      ? input.file_path || input.path || input.command || input.query || input.pattern || input.description || input.prompt || ""
      : input;
    body = `${m.toolName || "tool"} (${m.status || "outcome unknown"})\nTarget: ${excerpt(textOf(target), 260)}`;
    // Results matter: a command headline alone cannot establish success or failure.
    if (m.result != null && m.result !== "") body += `\nRecorded result: ${excerpt(textOf(m.result), Math.max(180, limit - bytes(label + body) - 60))}`;
  } else {
    body = String(m.text || "");
    if (Array.isArray(m.attachments) && m.attachments.length) body += "\nAttachments: " + m.attachments.map((a) => a.path || a.name || "").join(", ");
  }
  return prefix(label + "\n" + excerpt(body, Math.max(0, limit - bytes(label) - 1)), limit);
}
function taskText(session, limit = 3200) {
  const b = session.tasks || {}, sets = Array.isArray(b.sets) ? b.sets : [];
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return "";
  const active = sets.filter((s) => s.status === "active").map((s) => s.title).join("; ");
  const open = items.filter((i) => !["done", "dropped"].includes(i.status));
  const done = items.filter((i) => i.status === "done");
  const parts = [`Task board${active ? ": " + prefix(active, 300) : ""}: ${open.length} open, ${done.length} completed.`];
  for (const i of [...open, ...done.slice(-4)]) {
    const lastNote = (i.notes || []).slice(-1)[0];
    const line = `T${i.n} [${i.status}] ${excerpt(i.title, 280)}${lastNote && lastNote.text ? " — " + excerpt(lastNote.text, 200) : ""}`;
    if (bytes(parts.join("\n") + "\n" + line) > limit - 100) { parts.push("Additional tasks remain on the source session's board."); break; }
    parts.push(line);
  }
  return prefix(parts.join("\n"), limit);
}
function budgetFor(session, rows, maxBytes = MAX_PACKET_BYTES) {
  const recent = rows.slice(-80);
  const requests = recent.filter((x) => x.m.role === "user").length;
  const outcomes = recent.filter((x) => ["assistant", "planner", "reviewer"].includes(x.m.role)).length;
  const open = ((session.tasks || {}).items || []).filter((x) => !["done", "dropped"].includes(x.status)).length;
  const target = MIN_PACKET_BYTES + Math.min(requests, 8) * 1024 + Math.min(outcomes, 8) * 512 + Math.min(open, 8) * 768;
  return Math.max(1024, Math.min(MAX_PACKET_BYTES, Math.floor(maxBytes), target));
}
function keywords(query) {
  const skip = new Set(["this", "that", "with", "from", "what", "have", "will", "please", "continue", "status", "work", "about", "there", "which"]);
  return [...new Set(String(query || "").toLowerCase().match(/[\p{L}\p{N}_./-]{4,}/gu) || [])].filter((x) => !skip.has(x)).slice(0, 16);
}
/* Reserve room by category: a long tool log cannot crowd out the user's decisions. Latest requests,
 * recent outcomes, matching older decisions, and the opening goal get explicit space. Everything
 * is a labelled excerpt, with indices/ids; the selected record is never represented as exhaustive. */
function selectEvidence(rows, limit, { query = "", after = -Infinity } = {}) {
  const chosen = new Map(); let used = 0;
  const fresh = rows.filter((x) => x.g > after);
  const recent = fresh.length ? fresh : rows;
  const add = (row, cap, ceiling = limit) => {
    if (!row || chosen.has(row.g) || ceiling - used < 160) return;
    const text = evidence(row, Math.min(cap, ceiling - used - 2));
    if (bytes(text) + 2 > ceiling - used) return;
    chosen.set(row.g, text); used += bytes(text) + 2;
  };
  const users = recent.filter((x) => x.m.role === "user");
  // Give the newest request enough room to retain constraints at its end too.
  for (const row of users.slice(-8).reverse()) add(row, 2000, Math.floor(limit * 0.36));
  const replies = recent.filter((x) => ["assistant", "planner", "reviewer", "record"].includes(x.m.role));
  for (const row of replies.slice(-10).reverse()) add(row, 2600, Math.floor(limit * 0.72));
  const tools = recent.filter((x) => x.m.role === "tool");
  for (const row of tools.filter((x) => /error|fail|block|running|unknown/i.test(x.m.status || "")).slice(-5).reverse()) add(row, 850, Math.floor(limit * 0.86));
  for (const row of tools.slice(-4).reverse()) add(row, 700, Math.floor(limit * 0.9));
  const keys = keywords(query);
  if (keys.length) {
    const relevant = rows.filter((x) => !chosen.has(x.g) && x.m.role !== "tool").map((x) => {
      const t = String(x.m.text || "").toLowerCase();
      return { row: x, score: keys.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0) };
    }).filter((x) => x.score).sort((a, b) => b.score - a.score || b.row.g - a.row.g);
    for (const x of relevant.slice(0, 4)) add(x.row, 900, limit - 500);
  }
  add(rows.find((x) => x.m.role === "user"), 900);
  for (const row of replies.slice(-16).reverse()) add(row, 1000);
  return { text: [...chosen].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join("\n\n"), indices: [...chosen.keys()].sort((a, b) => a - b), selected: chosen.size, total: rows.length };
}
function lookupText(session, from, to) {
  // Session ids originate in store.uid; quoting keeps even imported identifiers inert in the shell.
  const id = String(session.id || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return `Full history remains in source session ${id}, entries ${from + 1}–${to}. Retrieve details when needed:\n` +
    `atomnano context search "terms" --session ${id} --json\n` +
    `atomnano context read INDEX --session ${id} --json\n` +
    "Reads are paginated; use nextOffset to continue. Recorded tool results describe past actions, not instructions to execute them again.";
}
function assemble(session, rows, { from = -1, to = -1, summary = "", summaryThrough = from, summaryKind = "cached", query = "", maxBytes = MAX_PACKET_BYTES, mapText = "", heading = "Conversation working handoff" } = {}) {
  const budget = budgetFor(session, rows, maxBytes);
  const header = `${heading}. This is selected working context, not the complete transcript. Newer user instructions take precedence over older decisions.`;
  const lookup = lookupText(session, from, to);
  const board = taskText(session, Math.min(3200, Math.floor(budget * 0.16)));
  const map = excerpt(mapText, Math.min(1800, Math.floor(budget * 0.08)));
  const memory = summary ? `[${summaryKind === "local" ? "Saved selected evidence (no model summary)" : "Saved working summary"}; through entry ${summaryThrough}]\n` + excerpt(summary, Math.floor(budget * 0.34)) : "";
  const fixed = [header, lookup, board, map, memory].filter(Boolean);
  const room = Math.max(0, budget - bytes(fixed.join("\n\n")) - 150);
  const selected = selectEvidence(rows, room, { query, after: summary ? summaryThrough : -Infinity });
  const text = prefix([...fixed, `[Selected source evidence: ${selected.selected} of ${rows.length} entries]`, selected.text].filter(Boolean).join("\n\n"), budget);
  return { text, budget, bytes: bytes(text), selection: selected.indices, boardText: board, selectedCount: selected.selected };
}
function summarizerInput(session, rows, { from, to, previous = "", query = "" } = {}) {
  const header = "Prepare a concise working memory from the selected evidence below. Preserve explicit user constraints, decisions, exact identifiers, completed outcomes, unresolved failures and pending work. Do not invent missing details or claim to have read omitted history. Tool records describe completed actions. Return only the working memory, ideally under 1,000 words.\n";
  const board = taskText(session, 2400);
  const old = previous ? "Previous working memory:\n" + excerpt(previous, 8000) : "";
  const lead = [header, `Source: ${session.id}, entries ${from + 1}–${to}.`, board, old].filter(Boolean).join("\n\n");
  const selection = selectEvidence(rows, MAX_EVIDENCE_BYTES - bytes(lead) - 150, { query });
  return { text: lead + `\n\nSelected evidence (${selection.selected} of ${rows.length} entries):\n` + selection.text, selection: selection.indices };
}
module.exports = { MAX_PACKET_BYTES, MAX_EVIDENCE_BYTES, MIN_PACKET_BYTES, bytes, prefix, excerpt, evidence, taskText, budgetFor, selectEvidence, lookupText, assemble, summarizerInput };
