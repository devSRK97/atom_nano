"use strict";
/* Read-only access to the full canonical transcript. A handoff links here rather than stuffing
 * tool logs into a prompt. Results are bounded, including UTF-8 pagination of a single large entry. */
const PAGE_BYTES = 8192, MAX_BYTES = 32768;
const error = (status, message) => Object.assign(new Error(message), { status });
function integer(value, fallback, min, max) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw error(400, `Expected a whole number between ${min} and ${max}`);
  return n;
}
const totalOf = (s) => (s.archivedCount || 0) + (s.messages || []).length;
function rows(store, s, start, end) { return store.getMessagesRange(s.id, end, end - start).messages || []; }
function content(m) { return require("./history").entryText(m); }
function bytePage(text, offset, limit) {
  const b = Buffer.from(text, "utf8");
  let start = Math.min(offset, b.length), end;
  while (start > 0 && start < b.length && (b[start] & 0xc0) === 0x80) start--;
  end = Math.min(b.length, start + limit);
  while (end > start && end < b.length && (b[end] & 0xc0) === 0x80) end--;
  return { text: b.subarray(start, end).toString("utf8"), offset: start, bytes: end - start, totalBytes: b.length, nextOffset: end < b.length ? end : null };
}
function findEntry(store, s, ref) {
  const total = totalOf(s), str = String(ref == null ? "" : ref);
  if (/^\d+$/.test(str) && Number.isSafeInteger(Number(str))) {
    const index = Number(str);
    if (index >= total) throw error(404, "No record entry at that index");
    return { index, message: rows(store, s, index, index + 1)[0] };
  }
  if (!str) throw error(400, "A record index or message id is required");
  for (let end = total; end > 0; end -= 256) {
    const start = Math.max(0, end - 256), batch = rows(store, s, start, end);
    const i = batch.findIndex((m) => m && m.id === str);
    if (i >= 0) return { index: start + i, message: batch[i] };
  }
  throw error(404, "No record entry with that message id");
}
function read(store, session, ref, opts = {}) {
  const offset = integer(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(opts.limit, PAGE_BYTES, 64, MAX_BYTES);
  const { index, message: m } = findEntry(store, session, ref);
  if (!m) throw error(404, "The record entry is unavailable");
  return { session: session.id, index, id: m.id || "", role: m.role, ts: m.ts || "", archived: index < (session.archivedCount || 0), ...bytePage(content(m), offset, limit) };
}
async function search(store, session, query, opts = {}) {
  const q = String(query || "").trim();
  if (!q || q.length > 2000) throw error(400, "Search needs 1 to 2000 characters");
  const limit = integer(opts.limit, 12, 1, 50), total = totalOf(session);
  const before = integer(opts.before, total, 0, total);
  const terms = [...new Set(q.toLowerCase().split(/\s+/))].slice(0, 20);
  const matches = [];
  for (let end = before; end > 0; end -= 128) {
    const start = Math.max(0, end - 128), batch = rows(store, session, start, end);
    for (let i = batch.length - 1; i >= 0; i--) {
      const m = batch[i]; if (!m) continue;
      const text = content(m), lower = text.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      const at = Math.min(...terms.map((term) => lower.indexOf(term)));
      const snippet = bytePage(text.slice(Math.max(0, at - 80)), 0, 600).text;
      const index = start + i;
      matches.push({ index, id: m.id || "", role: m.role, ts: m.ts || "", archived: index < (session.archivedCount || 0), snippet });
      if (matches.length >= limit) return { session: session.id, query: q, matches, nextBefore: index > 0 ? index : null, totalMessages: total };
    }
    // Large archives must not block Stop/Send while an agent searches them.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { session: session.id, query: q, matches, nextBefore: null, totalMessages: total };
}
module.exports = { read, search, bytePage, PAGE_BYTES, MAX_BYTES };
