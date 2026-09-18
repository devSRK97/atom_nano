"use strict";
/* Output helpers for the atomnano CLI: compact tables, durations, one-line text, JSON. The Orchestrator
 * model reads this output inside its Bash tool, so everything is short, aligned and unambiguous. */

const ACCESS_LABEL = { bypassPermissions: "full", acceptEdits: "edits", default: "ask", read: "read" };

function str(v) { return v == null ? "" : String(v); }
function oneLine(s, max = 80) {
  const t = str(s).replace(/\s+/g, " ").trim();
  return max && t.length > max ? t.slice(0, Math.max(1, max - 1)) + "…" : t;
}
function pad(s, n) { s = str(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }

// rows: objects; cols: [{ key, label, max?, get? }] → aligned text (uppercase header), no borders.
function table(rows, cols, { indent = "" } = {}) {
  const cells = rows.map((r) => cols.map((c) => oneLine(c.get ? c.get(r) : r[c.key], c.max || 60)));
  const widths = cols.map((c, i) => Math.max(str(c.label).length, ...cells.map((row) => row[i].length)));
  const line = (arr) => indent + arr.map((v, i) => (i === arr.length - 1 ? v : pad(v, widths[i]))).join("  ").replace(/\s+$/, "");
  return [line(cols.map((c) => str(c.label).toUpperCase())), ...cells.map(line)].join("\n");
}

// Epoch ms from a number, a numeric string or an ISO string (0 when unknown).
function ts(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const n = Number(v); if (Number.isFinite(n)) return n;
  const d = Date.parse(String(v)); return Number.isFinite(d) ? d : 0;
}
function duration(ms) {
  if (!(ms >= 0)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60), rs = Math.round(s % 60);
  if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
const TERMINAL = new Set(["done", "error", "stopped"]);
// A job's elapsed time: while it runs now − start (the manager keeps durationMs at 0 until the end);
// once terminal the recorded duration, else end − start.
function jobDuration(job) {
  if (!job) return "-";
  const start = ts(job.startedTs);
  if (TERMINAL.has(job.status) && job.durationMs > 0) return duration(job.durationMs);
  if (!start) return job.durationMs >= 0 ? duration(job.durationMs) : "-";
  const end = (TERMINAL.has(job.status) && ts(job.endedTs)) || Date.now();
  return duration(Math.max(0, end - start));
}
// "running", "running (paused: offline)", "done" …
function statusLabel(job) { if (!job) return ""; const s = str(job.status) || "queued"; return job.paused && !TERMINAL.has(s) ? `${s} (paused${typeof job.paused === "string" ? ": " + job.paused : ""})` : s; }
function accessLabel(a) { return ACCESS_LABEL[a] || str(a) || "full"; }
function roleModel(role) {
  if (!role) return "";
  const parts = [role.provider || "(composer)", role.model || "(default)"];
  return parts.join("/");
}
function editedSummary(files) {
  if (!Array.isArray(files) || !files.length) return "";
  const added = files.reduce((n, f) => n + (f.added || 0), 0), removed = files.reduce((n, f) => n + (f.removed || 0), 0);
  return `${files.length} file${files.length === 1 ? "" : "s"} edited (+${added}/-${removed})`;
}
function json(obj) { return JSON.stringify(obj, null, 2) + "\n"; }

// ---- task board (docs/WORKFLOW_CONTRACT.md §8) ----
// Local "YYYY-MM-DD HH:MM" for a task / note timestamp (ISO or epoch), "-" when unknown.
function when(v) {
  const ms = ts(v); if (!ms) return "-";
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function taskRef(item) { return item && item.n != null ? "T" + item.n : str(item && item.id); }
function setStats(set, items) {
  const mine = items.filter((i) => i && i.setId === set.id);
  return { items: mine, total: mine.length, done: mine.filter((i) => i.status === "done").length, dropped: mine.filter((i) => i.status === "dropped").length };
}
// "Set 2 · Payments · 3/8 done · active"  ·  "Set 1 · Setup · 2/2 done"  ·  "Set 3 · Refunds · 1/4 done · 1 dropped · closed"
function setLine(set, items) {
  const c = setStats(set, items);
  const bits = [`Set ${set.n}`, oneLine(set.title, 60) || "(untitled)", `${c.done}/${c.total} done`];
  if (c.dropped) bits.push(`${c.dropped} dropped`);
  if (set.status === "active") bits.push("active"); else if (set.status === "closed") bits.push("closed");
  return bits.join(" · ");
}
// One aligned row per task: "T12  doing   coder   Wire the webhook · job job-3f2a"
function taskRows(items, indent = "  ") {
  if (!items.length) return indent + "(no tasks in this set)";
  const w = (f, min) => Math.max(min, ...items.map((i) => f(i).length));
  const refW = w(taskRef, 1), stW = w((i) => str(i.status || "todo"), 4), roleW = w((i) => str(i.role || "-"), 1);
  return items.map((i) => {
    const jobs = Array.isArray(i.jobIds) && i.jobIds.length ? ` · job ${i.jobIds[i.jobIds.length - 1]}` : "";
    return `${indent}${pad(taskRef(i), refW)}  ${pad(i.status || "todo", stW)}  ${pad(i.role || "-", roleW)}  ${oneLine(i.title, 90)}${jobs}`.replace(/\s+$/, "");
  }).join("\n");
}
// The board: newest set first (the active one on top, expanded); finished sets one line each unless `all`.
function boardText(board, { all = false } = {}) {
  const sets = (Array.isArray(board.sets) ? board.sets : []).filter(Boolean).slice().sort((a, b) => (+b.n || 0) - (+a.n || 0));
  const items = Array.isArray(board.items) ? board.items : [];
  if (!sets.length && !items.length) return 'no tasks yet — atomnano tasks add "title" ["title" …] --set "Set title"';
  const lines = [];
  for (const s of sets) { lines.push(setLine(s, items)); if (all || s.status === "active") lines.push(taskRows(setStats(s, items).items)); }
  const loose = items.filter((i) => i && !sets.some((s) => s.id === i.setId));
  if (loose.length) { lines.push("(no set)"); lines.push(taskRows(loose)); }
  const h = board.hidden || {};
  if (h.sets) lines.push(`(${h.sets} older set${h.sets === 1 ? "" : "s"} with ${h.items} task${h.items === 1 ? "" : "s"} hidden — atomnano tasks --all)`);
  return lines.join("\n");
}
// `atomnano tasks show T12`
function taskDetail(item, set) {
  const lines = [`${taskRef(item)} · ${item.status || "todo"} · ${item.role || "-"} · ${oneLine(item.title, 200)}`];
  lines.push(`set       ${set ? `Set ${set.n} · ${oneLine(set.title, 60)}${set.status && set.status !== "active" ? ` (${set.status})` : ""}` : str(item.setId) || "-"}`);
  if (str(item.detail).trim()) lines.push(`detail    ${str(item.detail).trim().replace(/\r?\n/g, "\n          ")}`);
  if (Array.isArray(item.jobIds) && item.jobIds.length) lines.push(`jobs      ${item.jobIds.join(", ")}`);
  lines.push(`created   ${when(item.createdTs)} · updated ${when(item.updatedTs)}${item.doneTs ? ` · done ${when(item.doneTs)}` : ""}`);
  const notes = Array.isArray(item.notes) ? item.notes : [];
  if (notes.length) { lines.push(`notes (${notes.length})`); for (const n of notes) lines.push(`  ${when(n.ts)}  ${pad(str(n.by) || "-", 8)}  ${oneLine(n.text, 300)}`); }
  return lines.join("\n");
}

module.exports = { table, oneLine, duration, jobDuration, statusLabel, ts, accessLabel, roleModel, editedSummary, json, pad, when, taskRef, setLine, setStats, taskRows, boardText, taskDetail };
