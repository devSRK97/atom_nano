"use strict";
/* DBM import / export (audit DB-008/009/010/018/033–038/044).
 *
 *   exportFile  → CSV · JSON · SQL INSERTs · Excel, for the rows the grid holds
 *                 ("page") or every row of a table ("all"). ALL exports STREAM page
 *                 by page to a temporary file that is published only on completion —
 *                 no row ceiling; Cancel produces an explicitly labelled partial file.
 *                 Mongo columns are the UNION over every page (rows remapped by field).
 *                 SQL export needs a SQL engine and an explicit target table.
 *   importPick  → open dialog → parsed OFF the main thread (db-io-worker) → preview +
 *                 a job token bound to the window, connection revision and target.
 *   importRun   → picked → running → done|cancelled|failed, exactly once per token,
 *                 bound parameters, engine-aware batch limits, per-batch accounting
 *                 (committed / failed / unattempted / unknown) and a complete error
 *                 artifact. "Empty first" runs atomically inside one transaction on
 *                 SQL engines (rolled back on any failure); Mongo needs an explicit
 *                 non-atomic acknowledgement.
 *   importCancel → stops before the next batch and is acknowledged in the result;
 *                 closing a dialog never implies cancellation (jobStatus keeps the outcome). */
const { dialog } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Worker } = require("worker_threads");
const db = require("./db");
const F = require("./db-formats");
const { DbError } = db;

const jobs = new Map();   // token → job
const progress = (win, payload) => { try { if (win && !win.isDestroyed()) win.webContents.send("db:io-progress", payload); } catch { /* window gone */ } };
const safeName = (s) => String(s || "export").replace(/[^\w.-]+/g, "_").slice(0, 80);
const newToken = (p) => p + crypto.randomBytes(9).toString("base64url");
const senderId = (win) => (win && !win.isDestroyed() ? win.webContents.id : 0);
const connOf = (id) => { const c = db.list().find((x) => x.id === id); if (!c) throw new DbError("Connection not found", { type: "not-found" }); return c; };
const sweep = () => { const now = Date.now(); for (const [k, v] of jobs) if (v.expires < now && v.state !== "running") jobs.delete(k); };
const PAGE = 5000;
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;   // explicit resource policy (1 GB file); expansion is bounded by db-formats

/* ============================== values ============================== */
const isTag = db.isTag;
// wire cell → JSON export value (Extended-JSON style tags for non-JSON types)
function jsonValue(v) {
  if (v === null || v === undefined) return null;
  if (!isTag(v)) return v;
  switch (v.$t) {
    case "bigint": return { $numberLong: String(v.v) };
    case "decimal": return { $numberDecimal: String(v.v) };
    case "num": return { $numberDouble: String(v.v) };
    case "oid": return { $oid: String(v.v) };
    case "uuid": return { $uuid: String(v.v) };
    case "date": return { $date: String(v.v) };
    case "bytes": return { $binary: { base64: v.b64 || "", subType: v.sub != null ? String(v.sub) : "00" } };
    case "json": try { return JSON.parse(v.v); } catch { return v.v; }
    default: return String(v.v);
  }
}
const text = F.cellText;
function sqlInserts(kind, table, columns, rows, per = 200) {
  const cols = columns.map((c) => db.quoteIdent(kind, c)).join(", ");
  const t = db.qualify(kind, table);
  const out = [];
  if (kind === "oracle") { for (const r of rows) out.push(`INSERT INTO ${t} (${cols}) VALUES (${r.map((v) => db.sqlLiteral(kind, v)).join(", ")});`); return out.join("\n") + (out.length ? "\n" : ""); }
  for (let i = 0; i < rows.length; i += per) out.push(`INSERT INTO ${t} (${cols}) VALUES\n${rows.slice(i, i + per).map((r) => "  (" + r.map((v) => db.sqlLiteral(kind, v)).join(", ") + ")").join(",\n")};`);
  return out.join("\n") + (out.length ? "\n" : "");
}

/* ============================== streaming file writer ============================== */
function openOut(finalPath) {
  const tmp = `${finalPath}.part-${process.pid}-${Date.now()}`;
  const ws = fs.createWriteStream(tmp);
  let failed = null; ws.on("error", (e) => { failed = e; });
  const write = (chunk) => new Promise((resolve, reject) => { if (failed) return reject(failed); if (!ws.write(chunk)) ws.once("drain", resolve); else resolve(); });
  const close = () => new Promise((resolve, reject) => { if (failed) return reject(failed); ws.end(() => (failed ? reject(failed) : resolve())); });
  const publish = async (to) => { await close(); await fs.promises.rename(tmp, to); return to; };
  const discard = async () => { try { ws.destroy(); await fs.promises.unlink(tmp); } catch { /* */ } };
  return { write, close, publish, discard, tmp };
}

/* ============================== EXPORT ============================== */
const FILTERS = { csv: [{ name: "CSV", extensions: ["csv"] }], json: [{ name: "JSON", extensions: ["json"] }], sql: [{ name: "SQL", extensions: ["sql"] }], xlsx: [{ name: "Excel workbook", extensions: ["xlsx"] }] };
/* opts: { token, id, table, targetTable, format, scope, columns, rows, where, orderBy, dir, name } */
async function exportFile(win, opts = {}) {
  const { id, table, format, scope, columns, rows, where, orderBy, dir, name } = opts;
  const fmt = FILTERS[format] ? format : "csv";
  const conn = connOf(id);
  const sqlTarget = opts.targetTable || table || "";
  if (fmt === "sql") {
    if (conn.kind === "mongodb" || conn.kind === "redis") throw new DbError(`SQL INSERT export is not available for ${conn.kind} — use JSON (Extended JSON) or CSV.`, { type: "unsupported" });
    if (!sqlTarget) throw new DbError("SQL INSERT export needs a target table — export from Browse, or choose a target table.", { type: "invalid" });
  }
  if (scope === "all" && !table) throw new DbError("Export all rows needs a table.", { type: "invalid" });
  const base = safeName(name || (table && (table.name || table)) || "query") + (scope === "all" ? "" : "_page");
  const res = await dialog.showSaveDialog(win, { title: `Export as ${fmt.toUpperCase()}`, defaultPath: `${base}.${fmt}`, filters: FILTERS[fmt] });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true, state: "canceled" };
  const token = opts.token ? String(opts.token) : newToken("exp");
  const job = { token, kind: "export", state: "running", cancel: false, sender: senderId(win), connId: id, created: Date.now(), expires: Date.now() + 60 * 60 * 1000, rows: 0 };
  jobs.set(token, job);
  const t0 = Date.now();
  const out = openOut(res.filePath);
  const finish = async (state, extra = {}) => {
    job.state = state;
    if (state === "done") { await out.publish(res.filePath); job.result = { ok: true, state, path: res.filePath, rows: job.rows, format: fmt, complete: true, ms: Date.now() - t0, ...extra }; }
    else if (state === "cancelled") { const p = res.filePath.replace(/(\.[^.]+)$/, ".partial$1"); await out.publish(p); job.result = { ok: false, state, path: p, rows: job.rows, format: fmt, complete: false, cancelled: true, ms: Date.now() - t0, ...extra }; }
    else { await out.discard(); job.result = { ok: false, state, rows: job.rows, format: fmt, complete: false, ms: Date.now() - t0, ...extra }; }
    progress(win, { token, phase: "done", state, done: job.rows, message: state === "done" ? "Done" : state === "cancelled" ? "Cancelled — partial file kept" : "Failed" });
    return job.result;
  };
  try {
    let cols = (columns || []).map(String), data = rows || [];
    const kind = conn.kind;
    if (scope !== "all") {
      // page export: what the grid holds
      if (fmt === "csv") await out.write("﻿" + [F.csvLine(cols.map((c) => c)), ...data.map((r) => F.csvLine(r))].join("\r\n") + "\r\n");
      else if (fmt === "json") await out.write(JSON.stringify(data.map((r) => Object.fromEntries(cols.map((c, i) => [c, jsonValue(r[i])]))), null, 2));
      else if (fmt === "sql") await out.write(sqlInserts(kind, sqlTarget, cols, data));
      else await out.write(F.xlsxWrite(cols, data, String((table && (table.table || table)) || "Sheet1").split(".").pop()));
      job.rows = data.length;
      return await finish("done");
    }
    // ---- ALL rows: stream page by page ----
    let offset = 0, first = true, unionCols = null, spool = null, spoolRows = 0;
    const pageIter = async function* () {
      for (;;) {
        if (job.cancel) return;
        const r = await db.browse(id, table, { offset, limit: PAGE, where, orderBy, dir });
        yield r;
        job.rows += r.rows.length; offset += r.rows.length;
        progress(win, { token, phase: "fetch", state: "running", done: job.rows, message: `Fetched ${job.rows.toLocaleString()} rows…` });
        if (!r.hasMore) return;
      }
    };
    if (fmt === "xlsx") {
      const all = [];
      for await (const r of pageIter()) { if (first) { cols = r.columns; first = false; } if (kind === "mongodb") { for (const c of r.columns) if (!cols.includes(c)) cols.push(c); for (const row of r.rows) all.push(Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))); } else all.push(...r.rows); if (all.length > F.XLSX_MAX_ROWS - 1) throw new F.FormatError(`More than ${(F.XLSX_MAX_ROWS - 1).toLocaleString()} rows — Excel can't hold this table. Export as CSV or JSON.`, { type: "format-limit" }); }
      if (job.cancel) return await finish("cancelled");
      const data2 = kind === "mongodb" ? all.map((d0) => cols.map((c) => (Object.prototype.hasOwnProperty.call(d0, c) ? d0[c] : null))) : all;
      await out.write(F.xlsxWrite(cols, data2, String(table.table || table).split(".").pop()));
      return await finish("done");
    }
    if (fmt === "json") {
      await out.write("[");
      let n = 0;
      for await (const r of pageIter()) { for (const row of r.rows) { await out.write((n++ ? ",\n" : "\n") + JSON.stringify(Object.fromEntries(r.columns.map((c, i) => [c, jsonValue(row[i])])))); } }
      await out.write("\n]\n");
      return await finish(job.cancel ? "cancelled" : "done");
    }
    if (fmt === "sql") {
      for await (const r of pageIter()) { if (first) { first = false; } await out.write(sqlInserts(kind, sqlTarget, r.columns, r.rows)); }
      return await finish(job.cancel ? "cancelled" : "done");
    }
    // CSV: SQL engines have fixed columns → stream; Mongo → spool rows (JSONL) while
    // collecting the union of fields, then write the CSV in a second pass.
    if (kind !== "mongodb") {
      for await (const r of pageIter()) { if (first) { first = false; cols = r.columns; await out.write("﻿" + F.csvLine(cols) + "\r\n"); } for (const row of r.rows) await out.write(F.csvLine(row) + "\r\n"); }
      if (first) await out.write("﻿" + F.csvLine(cols) + "\r\n");
      return await finish(job.cancel ? "cancelled" : "done");
    }
    spool = path.join(os.tmpdir(), `atomnano-export-${token}.jsonl`);
    const sp = fs.createWriteStream(spool);
    const spWrite = (s) => new Promise((ok) => { if (!sp.write(s)) sp.once("drain", ok); else ok(); });
    unionCols = [];
    const seen = new Set();
    for await (const r of pageIter()) { for (const c of r.columns) if (!seen.has(c)) { seen.add(c); unionCols.push(c); } for (const row of r.rows) { await spWrite(JSON.stringify(Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))) + "\n"); spoolRows++; } }
    await new Promise((ok) => sp.end(ok));
    await out.write("﻿" + F.csvLine(unionCols) + "\r\n");
    const rl = require("readline").createInterface({ input: fs.createReadStream(spool) });
    for await (const line of rl) { if (!line) continue; const d0 = JSON.parse(line); await out.write(F.csvLine(unionCols.map((c) => (Object.prototype.hasOwnProperty.call(d0, c) ? d0[c] : null))) + "\r\n"); }
    try { await fs.promises.unlink(spool); } catch { /* */ }
    return await finish(job.cancel ? "cancelled" : "done", { columns: unionCols.length, spooled: spoolRows });
  } catch (e) {
    const err = e instanceof DbError || e instanceof F.FormatError ? e : new DbError(String(e.message || e), { type: "export" });
    await finish("failed", { error: err.message, type: err.type });
    throw err;
  }
}
function exportCancel(token) { const j = jobs.get(String(token || "")); if (!j || j.kind !== "export") return { ok: false, reason: "not-running" }; if (j.state !== "running") return { ok: false, reason: j.state }; j.cancel = true; return { ok: true, acknowledged: true }; }

/* ============================== IMPORT ============================== */
function parseInWorker(payload) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, "db-io-worker.js"), { workerData: payload, resourceLimits: { maxOldGenerationSizeMb: 3072 } });
    const timer = setTimeout(() => { w.terminate(); reject(new DbError("Parsing the file took more than 10 minutes — it was stopped.", { type: "timeout" })); }, 600000);
    w.once("message", (m) => { clearTimeout(timer); if (m && m.ok) resolve(m); else reject(new DbError((m && m.error) || "parse failed", { type: (m && m.type) || "format", details: m && m.line ? `line ${m.line}` : "" })); });
    w.once("error", (e) => { clearTimeout(timer); reject(new DbError("Parsing failed: " + e.message, { type: "format" })); });
    w.once("exit", (code) => { clearTimeout(timer); if (code !== 0) reject(new DbError(`The parser stopped unexpectedly (exit ${code}) — the file may be too large for memory.`, { type: "format" })); });
  });
}
const dialectOf = (kind) => (kind === "mongodb" || kind === "redis" ? "generic" : kind);
/* Pick and parse a file. Returns { token, type, file, size, total, width, looksHeader, sample,
 * sheets, sheet, errors, ... }. The token is bound to the calling window, the connection
 * revision and the target table. */
async function importPick(win, { id, table, sheet, encoding, file: fileOverride } = {}) {
  sweep();
  const conn = connOf(id);
  let file = fileOverride;
  if (!file) {
    const res = await dialog.showOpenDialog(win, { title: table ? `Import into ${table.name || table}` : "Import", properties: ["openFile"], filters: [{ name: "Data files", extensions: ["sql", "csv", "tsv", "txt", "xlsx"] }, { name: "SQL script", extensions: ["sql"] }, { name: "CSV / text", extensions: ["csv", "tsv", "txt"] }, { name: "Excel workbook", extensions: ["xlsx"] }] });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    file = res.filePaths[0];
  }
  const ext = path.extname(file).toLowerCase();
  const stat = await fs.promises.stat(file);
  if (stat.size > MAX_IMPORT_BYTES) throw new DbError(`File is larger than ${Math.round(MAX_IMPORT_BYTES / 1048576)} MB — split it first.`, { type: "format-limit" });
  const parsed = await parseInWorker({ file, ext, dialect: dialectOf(conn.kind), encoding: encoding || "auto", sheet: sheet == null ? 0 : sheet });
  const token = newToken("imp");
  const expires = Date.now() + 30 * 60 * 1000;
  const base = { token, kind: "import", state: "picked", cancel: false, sender: senderId(win), connId: id, rev: conn.rev, table: table ? (table.name || table) : "", file, created: Date.now(), expires };
  if (parsed.type === "sql") {
    jobs.set(token, { ...base, type: "sql", statements: parsed.statements, parseErrors: parsed.errors });
    return { ok: true, token, type: "sql", file, size: stat.size, total: parsed.statements.length, errors: parsed.errors, sample: parsed.statements.slice(0, 8).map((s) => ({ line: s.line, text: s.text.replace(/\s+/g, " ").slice(0, 160) })) };
  }
  let rows = parsed.rows;
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  rows = rows.map((r) => { const o = r.slice(0, width); while (o.length < width) o.push(null); return o; });
  const first = rows[0] || [];
  const looksHeader = first.length > 0 && first.every((v) => typeof v === "string" && v.trim() !== "" && !/^-?\d+(\.\d+)?$/.test(v.trim()));
  jobs.set(token, { ...base, type: "table", rows });
  return { ok: true, token, type: "table", file, size: stat.size, total: rows.length, width, looksHeader, sample: rows.slice(0, 21), sheets: parsed.sheets, sheet: parsed.sheet, date1904: parsed.date1904, errorCells: parsed.errorCells || 0, bigNumbers: parsed.bigNumbers || 0, blankLines: parsed.blankLines || 0, quotedEmpty: parsed.quotedEmpty || 0, delim: parsed.delim };
}
// Rows per INSERT for this engine and column count (server limits, not preferences).
function batchLimit(kind, cols, wanted) {
  const w = Math.max(1, Math.floor(+wanted || 500));
  const c = Math.max(1, cols);
  if (kind === "mssql") return Math.max(1, Math.min(w, 1000, Math.floor(2000 / c)));
  if (kind === "postgres") return Math.max(1, Math.min(w, Math.floor(65000 / c)));
  if (kind === "mysql") return Math.max(1, Math.min(w, 5000, Math.floor(60000 / c)));
  if (kind === "sqlite") return Math.max(1, Math.min(w, Math.floor(32000 / c)));
  if (kind === "oracle") return 1;
  return w;
}
// Acquire and transition a job for running; typed errors for every invalid state.
function takeJob(win, token, id) {
  const job = jobs.get(String(token || ""));
  if (!job || job.kind !== "import") throw new DbError("Import expired or unknown — pick the file again.", { type: "job-expired" });
  if (job.expires < Date.now()) { jobs.delete(job.token); throw new DbError("This import preview expired — pick the file again.", { type: "job-expired" }); }
  if (job.sender && senderId(win) && job.sender !== senderId(win)) throw new DbError("This import belongs to another window.", { type: "job-owner" });
  if (job.connId !== id) throw new DbError("This import was prepared for a different connection.", { type: "job-target" });
  if (job.state === "running") throw new DbError("This import is already running.", { type: "job-running" });
  if (job.state !== "picked") throw new DbError(`This import already finished (${job.state}).`, { type: "job-finished" });
  const conn = connOf(id);
  if (conn.rev !== job.rev) throw new DbError("The connection was edited since the file was picked — pick it again.", { type: "stale-connection" });
  job.state = "running"; job.started = Date.now();
  return { job, conn };
}
function errorsArtifact(token, errors) {
  if (errors.length <= 200) return "";
  try { const p = path.join(os.tmpdir(), `atomnano-import-errors-${token}.json`); fs.writeFileSync(p, JSON.stringify(errors, null, 2)); return p; } catch { return ""; }
}
/* Run a prepared import. opts: { token, id, table, mapping, hasHeader, emptyFirst, batch,
 * emptyAsNull, stopOnError, acknowledgeNonAtomic } */
async function importRun(win, opts = {}) {
  const { token, id } = opts;
  const { job, conn } = takeJob(win, token, id);
  const k = conn.kind;
  const t0 = Date.now();
  const errors = [];
  const done = (state, extra) => { job.state = state; job.result = { ok: state === "done" && errors.length === 0, state, errors: errors.slice(0, 200), totalErrors: errors.length, errorsFile: errorsArtifact(token, errors), ms: Date.now() - t0, ...extra }; progress(win, { token, phase: "done", state, done: extra.committed ?? extra.executed ?? 0, total: extra.total, message: state === "done" ? "Done" : state === "cancelled" ? "Cancelled" : "Failed" }); return job.result; };
  // ---- SQL script: statements in order, one session (USE / SET persist) ----
  if (job.type === "sql") {
    if (job.parseErrors && job.parseErrors.length) return done("failed", { total: job.statements.length, executed: 0, failed: 0, unattempted: job.statements.length, unknown: 0, error: `The script could not be parsed: ${job.parseErrors[0].message} (line ${job.parseErrors[0].line}). Nothing was executed.` });
    const stopOnError = opts.stopOnError !== false;
    let executed = 0, failed = 0, unknown = 0, i = 0;
    const { session } = await db.sessionOpen(id);
    try {
      for (; i < job.statements.length; i++) {
        if (job.cancel) break;
        const s = job.statements[i];
        try { await db.query(id, s.text, { session }); executed++; }
        catch (e) { failed++; if (e && e.type === "outcome-unknown") unknown++; errors.push({ at: i + 1, line: s.line, error: e.message, type: e.type || "db", statement: s.text.slice(0, 300) }); if (stopOnError) { i++; break; } }
        if ((i + 1) % 10 === 0 || i + 1 === job.statements.length) progress(win, { token, phase: "run", state: "running", done: i + 1, total: job.statements.length, committed: executed, failed, message: `${i + 1} / ${job.statements.length} statements` });
      }
    } finally { await db.sessionClose(session, { rollback: false }).catch(() => {}); }
    const unattempted = job.statements.length - executed - failed;
    return done(job.cancel ? "cancelled" : "done", { total: job.statements.length, executed, failed, unattempted, unknown });
  }
  // ---- table import: every validation runs BEFORE any write; a rejected request puts the
  // job back to "picked" so the user can fix the options and run the same preview again ----
  const revert = (e) => { job.state = "picked"; delete job.started; throw e; };
  const table = opts.table || job.table;
  if (!table) revert(new DbError("Pick a target table.", { type: "invalid" }));
  if (job.table && (table.name || table) !== job.table) revert(new DbError("The target table changed since the file was picked — pick it again for the new table.", { type: "job-target" }));
  const map = Object.entries(opts.mapping || {}).map(([src, col]) => [+src, String(col)]).filter(([, col]) => col);
  if (!map.length) revert(new DbError("Map at least one source column to a table column.", { type: "invalid" }));
  const hasHeader = opts.hasHeader !== false;
  const data = hasHeader ? job.rows.slice(1) : job.rows;
  const cols = map.map(([, col]) => col);
  const emptyAsNull = !!opts.emptyAsNull;
  const stopOnError = opts.stopOnError !== false;
  const coerce = (v) => (v === undefined ? null : (v === "" && emptyAsNull) ? null : v);
  const emptyFirst = !!(opts.emptyFirst || opts.truncate);
  const atomic = emptyFirst && k !== "mongodb";
  if (emptyFirst && k === "mongodb" && !opts.acknowledgeNonAtomic) revert(new DbError("MongoDB cannot empty and refill a collection atomically here. Acknowledge the non-atomic plan (existing documents are deleted first; a failure leaves a partial collection) to continue.", { type: "non-atomic" }));
  try { db.enforcePolicy(conn, db.tableCls("write", db.objIdent(k, table), { truncate: emptyFirst }), "import"); } catch (e) { revert(e); }   // protections apply to imports before the first row
  const per = batchLimit(k, cols.length, opts.batch);
  let committed = 0, attempted = 0, failed = 0, unknown = 0, rolledBack = false, session = null;
  const total = data.length;
  progress(win, { token, phase: "run", state: "running", done: 0, total, committed: 0, failed: 0, message: emptyFirst ? (atomic ? "Starting transaction…" : "Emptying the collection…") : "Starting…" });
  try {
    if (atomic) {
      session = (await db.sessionOpen(id)).session;
      if (k === "oracle") await db.sessionSet(session, { autocommit: false });
      else await db.query(id, k === "mysql" ? "START TRANSACTION" : k === "mssql" ? "BEGIN TRANSACTION" : "BEGIN", { session });
      await db.query(id, `DELETE FROM ${db.qualify(k, table)}`, { session });
      progress(win, { token, phase: "run", state: "running", done: 0, total, committed: 0, failed: 0, message: "Table emptied (uncommitted)" });
    } else if (emptyFirst && k === "mongodb") {
      await db.query(id, JSON.stringify({ collection: table.table || table, op: "deleteMany", filter: {} }), {});
      progress(win, { token, phase: "run", state: "running", done: 0, total, committed: 0, failed: 0, message: "Collection emptied" });
    }
    const q = (sql, params) => db.query(id, sql, { params, session: session || undefined });
    for (let i = 0; i < data.length; i += per) {
      if (job.cancel) break;
      const slice = data.slice(i, i + per).map((r) => map.map(([src]) => coerce(r[src])));
      attempted += slice.length;
      try {
        if (k === "mongodb") await db.query(id, JSON.stringify({ collection: table.table || table, op: "insertMany", docs: slice.map((r) => Object.fromEntries(cols.map((c, j) => [c, r[j]]))) }), {});
        else if (k === "oracle") { for (const r of slice) await q(`INSERT INTO ${db.qualify(k, table)} (${cols.map((c) => db.quoteIdent(k, c)).join(", ")}) VALUES (${r.map((_, j) => db.ph(k, j)).join(", ")})`, r); }
        else {
          const params = []; const tuples = slice.map((r) => "(" + r.map((v) => { params.push(v); return db.ph(k, params.length - 1); }).join(", ") + ")");
          await q(`INSERT INTO ${db.qualify(k, table)} (${cols.map((c) => db.quoteIdent(k, c)).join(", ")}) VALUES ${tuples.join(", ")}`, params);
        }
        committed += slice.length;
      } catch (e) {
        failed += slice.length;
        if (e && e.type === "outcome-unknown") unknown += slice.length;
        errors.push({ at: i + 1 + (hasHeader ? 1 : 0), rows: slice.length, error: e.message, type: e.type || "db" });
        if (stopOnError || atomic) break;
      }
      progress(win, { token, phase: "run", state: "running", done: Math.min(i + per, total), total, committed, failed, message: `${committed.toLocaleString()} / ${total.toLocaleString()} rows${atomic ? " (uncommitted)" : ""}` });
    }
    if (atomic) {
      if (errors.length || job.cancel) {
        if (k === "oracle") await db.query(id, "ROLLBACK", { session }); else await db.query(id, "ROLLBACK", { session });
        rolledBack = true; committed = 0;
      } else { await db.query(id, "COMMIT", { session }); }
    }
  } catch (e) {
    if (atomic && session) { try { await db.query(id, "ROLLBACK", { session }); rolledBack = true; committed = 0; } catch { /* connection may be gone */ } }
    errors.push({ at: 0, error: e.message, type: e.type || "db", phase: "setup" });
    if (e && e.type === "outcome-unknown") unknown = Math.max(unknown, attempted - committed);
  } finally { if (session) await db.sessionClose(session, { rollback: false }).catch(() => {}); }
  const unattempted = total - attempted;
  const state = job.cancel ? "cancelled" : (errors.length ? (committed || !atomic ? (errors.length && stopOnError ? "failed" : "done") : "failed") : "done");
  return done(state, { total, attempted, committed, failed: atomic && rolledBack ? attempted : failed, unattempted, unknown, atomic, rolledBack, emptyFirst, nonAtomic: emptyFirst && !atomic, table: table.name || table.table || table, inserted: committed });
}
function importCancel(token) { const j = jobs.get(String(token || "")); if (!j || j.kind !== "import") return { ok: false, reason: "unknown" }; if (j.state !== "running") return { ok: false, reason: j.state }; j.cancel = true; return { ok: true, acknowledged: true }; }
// Discard a preview (its parsed rows are released). A RUNNING job is only cancelled — its outcome stays available.
function importDiscard(token) { const j = jobs.get(String(token || "")); if (!j) return { ok: true, existed: false }; if (j.state === "running") { j.cancel = true; return { ok: true, cancelling: true }; } jobs.delete(j.token); return { ok: true, existed: true }; }
function jobStatus(token) { const j = jobs.get(String(token || "")); if (!j) return null; return { token: j.token, kind: j.kind, type: j.type, state: j.state, table: j.table, file: j.file, created: j.created, result: j.result || null }; }
function jobsFor(win) { const s = senderId(win); return [...jobs.values()].filter((j) => !s || j.sender === s).map((j) => jobStatus(j.token)); }

module.exports = { exportFile, exportCancel, importPick, importRun, importCancel, importDiscard, jobStatus, jobsFor, sqlInserts, jsonValue, batchLimit, xlsxWrite: F.xlsxWrite, xlsxRead: F.xlsxRead, csvParse: F.csvParse, csvLine: F.csvLine, zipSync: F.zipSync, unzipSync: F.unzipSync, splitStatements: (sql, dialect) => require("./sqlscript").splitScript(sql, dialect).statements.map((s) => s.text) };
