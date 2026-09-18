"use strict";
/* Statement execution primitives. execSql / execMongo / execRedis run ONE statement on an entry (or
 * a tab's pinned session client) and shape every result set positionally — previews wrap a
 * confirmed SELECT in a derived table or use driver cursors, never rewriting user SQL. runGuarded and
 * readOp hold the RETRY rule (a transport failure never re-runs anything that may have mutated
 * state → "outcome-unknown"; only a classified read outside a transaction retries once), withTx runs
 * generated mutations in a short transaction with bound parameters, and the ops registry lets the
 * UI cancel a running statement at the engine. */
const { DbError, isTransport, wrap } = require("./db-common");
const S = require("./sqlscript");
const { open, closeHandle, dropSessionClients, clientFor } = require("./db-connections");
const { cell, bindValue, isTag } = require("./db-values");

/* ============================== operations (cancel) ============================== */
const ops = new Map();   // opId → { cancel }
function registerOp(opId, cancelFn) { if (opId) ops.set(String(opId), { cancel: cancelFn }); }
function unregisterOp(opId) { if (opId) ops.delete(String(opId)); }
async function cancel(opId) {
  const op = ops.get(String(opId || ""));
  if (!op) return { ok: false, reason: "not-running" };
  try { const r = await op.cancel(); return { ok: r !== false, reason: r === false ? "not-cancellable" : "" }; } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

/* ============================== execution core ============================== */
const NO_WRAP_RE = /\b(FOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)|LOCK\s+IN\s+SHARE\s+MODE|INTO\s+(OUTFILE|DUMPFILE|@))\b/i;
const stripSemi = (s) => String(s).replace(/;+\s*$/, "");
// A plain SELECT/CTE/VALUES can be previewed through a derived table without changing
// its meaning; anything else runs untouched (rows are then sliced client-side).
function canWrap(cls, sql) { return cls.op === "select" && /^(SELECT|WITH|VALUES|TABLE)$/.test(cls.first) && !NO_WRAP_RE.test(sql) && !/\bINTO\b/i.test(sql.replace(/'[^']*'/g, "")); }
function positional(rowsIn, colsIn, limit) {
  const hasMore = rowsIn.length > limit;
  const rows = (hasMore ? rowsIn.slice(0, limit) : rowsIn).map((r) => (Array.isArray(r) ? r : colsIn.map((c) => r[c])).map(cell));
  return { columns: colsIn.slice(), rows, rowCount: rows.length, hasMore, truncated: hasMore };
}
function unionShape(docs, limit) {
  const cols = []; const seen = new Set();
  for (const d0 of docs) for (const k of Object.keys(d0 || {})) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const hasMore = docs.length > limit;
  const list = hasMore ? docs.slice(0, limit) : docs;
  return { columns: cols, rows: list.map((d0) => cols.map((c) => cell(d0 && Object.prototype.hasOwnProperty.call(d0, c) ? d0[c] : undefined))), rowCount: list.length, hasMore, truncated: hasMore };
}
const cmdResult = (affected, message, extra = {}) => ({ columns: [], rows: [], rowCount: 0, hasMore: false, affected, message, ...extra });
/* Execute ONE statement (or a parameterised generated statement) on `entry`/session. */
async function execSql(kind, entry, sess, sql, params, { limit = 200, opId = "", cls = null, d = entry.d } = {}) {
  cls = cls || S.classify(sql, kind);
  const { client } = await clientFor(entry, sess);
  const trackTx = () => { if (!sess) return; if (cls.op === "tx") sess.inTx = cls.tx === "begin" || (cls.tx === "savepoint" ? sess.inTx : false); };
  switch (kind) {
    case "mysql": {
      const conn = sess ? client : await entry.handle.getConnection();
      try {
        const threadId = conn.connection && conn.connection.threadId;
        registerOp(opId, () => threadId ? entry.handle.query("KILL QUERY ?", [threadId]).then(() => true).catch(() => false) : false);
        let text = sql, effectiveSql;
        if (!params && canWrap(cls, sql) && limit) { text = `SELECT * FROM (${stripSemi(sql)}) AS \`_atomnano_preview\` LIMIT ${limit + 1}`; effectiveSql = text; }
        const [rows, fields] = await conn.query({ sql: text, values: params || undefined, rowsAsArray: true });
        trackTx();
        if (Array.isArray(rows)) { const cols = Array.isArray(fields) ? fields.map((f) => f && f.name) : []; return { ...positional(rows, cols, limit), effectiveSql }; }
        return cmdResult(rows.affectedRows ?? 0, `${rows.affectedRows ?? 0} row(s) affected${rows.insertId ? ` · insert id ${rows.insertId}` : ""}`, { insertId: rows.insertId ? String(rows.insertId) : undefined });
      } finally { unregisterOp(opId); if (!sess) conn.release(); }
    }
    case "postgres": {
      const c = sess ? client : await entry.handle.connect();
      try {
        registerOp(opId, () => c.processID ? entry.handle.query("SELECT pg_cancel_backend($1)", [c.processID]).then(() => true).catch(() => false) : false);
        let text = sql, effectiveSql;
        if (!params && canWrap(cls, sql) && limit) { text = `SELECT * FROM (${stripSemi(sql)}) AS "_atomnano_preview" LIMIT ${limit + 1}`; effectiveSql = text; }
        const r = await c.query({ text, values: params || undefined, rowMode: "array" });
        trackTx();
        const results = Array.isArray(r) ? r : [r];
        const sets = results.map((x) => {
          const cols = Array.isArray(x.fields) ? x.fields.map((f) => f.name) : [];
          if ((x.rows && x.rows.length) || cols.length) return { ...positional(x.rows || [], cols, limit), command: x.command, affected: /^(INSERT|UPDATE|DELETE|MERGE)$/i.test(x.command || "") ? x.rowCount : undefined };
          return cmdResult(x.rowCount ?? 0, `${x.command || "OK"} — ${x.rowCount ?? 0} row(s) affected`);
        });
        return { ...sets[0], effectiveSql, sets: sets.length > 1 ? sets : undefined };
      } finally { unregisterOp(opId); if (!sess) c.release(); }
    }
    case "sqlite": {
      const db = client;
      const text = stripSemi(sql);
      let st;
      try { st = db.prepare(text); } catch (e) { throw wrap(e); }
      if (params) st.bind(...params.map((p) => bindValue("sqlite", p)));
      if (st.reader) {
        st.raw(true);
        const cols = st.columns().map((c) => c.name);
        const out = []; let hasMore = false;
        for (const row of st.iterate()) { if (out.length >= limit) { hasMore = true; break; } out.push(row.map(cell)); }
        if (sess) sess.inTx = !!db.inTransaction;
        return { columns: cols, rows: out, rowCount: out.length, hasMore, truncated: hasMore };
      }
      const r = st.run();
      if (sess) sess.inTx = !!db.inTransaction;
      const changes = Number(r.changes), rowid = r.lastInsertRowid;
      return cmdResult(changes, cls.op === "ddl" || cls.op === "admin" ? "OK" : `${changes} row(s) affected${cls.first === "INSERT" && rowid ? ` · rowid ${rowid}` : ""}`, { insertId: cls.first === "INSERT" && rowid ? String(rowid) : undefined });
    }
    case "mssql": {
      // transactions pin a connection through a Transaction object
      if (sess && cls.op === "tx") {
        if (cls.tx === "begin") { if (sess.txObj) throw new DbError("A transaction is already open in this tab.", { type: "invalid" }); sess.txObj = new d.Transaction(entry.handle); await sess.txObj.begin(); sess.inTx = true; return cmdResult(0, "Transaction started"); }
        if (cls.tx === "end") { const t = sess.txObj; sess.txObj = null; sess.inTx = false; if (!t) return cmdResult(0, "No transaction was open"); if (cls.first === "COMMIT") { await t.commit(); return cmdResult(0, "Committed"); } await t.rollback(); return cmdResult(0, "Rolled back"); }
      }
      const req = new d.Request(sess && sess.txObj ? sess.txObj : entry.handle);
      req.arrayRowMode = true;
      if (params) params.forEach((p, i) => { const v = bindValue("mssql", p); if (isTag(p) && p.$t === "bigint") req.input("p" + i, d.BigInt, v); else if (Buffer.isBuffer(v)) req.input("p" + i, d.VarBinary(d.MAX), v); else if (typeof v === "string" && /[^\x00-\x7f]/.test(v)) req.input("p" + i, d.NVarChar(d.MAX), v); else req.input("p" + i, v); });
      registerOp(opId, () => { try { req.cancel(); return true; } catch { return false; } });
      try {
        if (cls.op === "select" && limit) {
          // stream and stop after limit+1 rows: exact, no SQL rewrite, no ORDER BY restriction
          req.stream = true;
          return await new Promise((resolve, reject) => {
            const sets = []; let cur = null; let cancelled = false; let hasMore = false;
            req.on("recordset", (cols) => { cur = { columns: (Array.isArray(cols) ? cols : Object.values(cols)).map((c) => c.name), rows: [] }; sets.push(cur); });
            req.on("row", (row) => { if (!cur) return; if (cur.rows.length >= limit) { hasMore = true; if (!cancelled) { cancelled = true; try { req.cancel(); } catch { /* */ } } return; } cur.rows.push(row.map(cell)); });
            req.on("error", (e) => { if (!(cancelled && /cancel/i.test(String(e.message)))) reject(wrap(e)); });
            req.on("done", (r) => {
              const rs = sets.map((s) => ({ ...s, rowCount: s.rows.length, hasMore: false, truncated: false }));
              if (rs.length) { rs[rs.length - 1].hasMore = hasMore; rs[rs.length - 1].truncated = hasMore; }
              const aff = r && Array.isArray(r.rowsAffected) ? r.rowsAffected.reduce((a, b) => a + b, 0) : 0;
              resolve(rs.length ? { ...rs[0], sets: rs.length > 1 ? rs : undefined } : cmdResult(aff, `${aff} row(s) affected`));
            });
            req.query(sql);
          });
        }
        const r = await req.query(sql);
        const rsAll = r.recordsets || [];
        const sets = rsAll.map((rs) => positional(rs, (Array.isArray(rs.columns) ? rs.columns : Object.values(rs.columns || {})).map((c) => c.name), limit));
        const aff = Array.isArray(r.rowsAffected) ? r.rowsAffected.reduce((a, b) => a + b, 0) : 0;
        if (sets.length && (sets[0].columns.length || sets[0].rows.length)) return { ...sets[0], sets: sets.length > 1 ? sets : undefined, affected: cls.op === "write" ? aff : undefined };
        return cmdResult(aff, `${aff} row(s) affected`);
      } finally { unregisterOp(opId); }
    }
    case "oracle": {
      const c = sess ? client : await entry.handle.getConnection();
      try {
        registerOp(opId, () => c.break().then(() => true).catch(() => false));
        // transaction control maps to the driver (Oracle has no BEGIN statement)
        if (cls.op === "tx" && /^(COMMIT|ROLLBACK)$/.test(cls.first)) { if (cls.first === "COMMIT") await c.commit(); else await c.rollback(); if (sess) sess.inTx = false; return cmdResult(0, cls.first === "COMMIT" ? "Committed" : "Rolled back"); }
        const isBlock = cls.op === "proc" && /^(BEGIN|DECLARE)$/.test(cls.first) || (cls.first === "CREATE" && /\b(FUNCTION|PROCEDURE|PACKAGE|TRIGGER|TYPE)\b/i.test(sql));
        const text = isBlock ? sql.trim() : stripSemi(sql.trim());
        const autoCommit = sess ? (sess.autocommit !== false && !sess.inTx) : true;
        const opts = { outFormat: d.OUT_FORMAT_ARRAY, autoCommit, fetchTypeHandler: (meta) => (meta.dbType === d.DB_TYPE_CLOB || meta.dbType === d.DB_TYPE_NCLOB) ? { type: d.STRING } : meta.dbType === d.DB_TYPE_BLOB ? { type: d.BUFFER } : undefined };
        if (cls.op === "select") {
          const r = await c.execute(text, params ? params.map((p) => bindValue("oracle", p)) : [], { ...opts, resultSet: true });
          const rs = r.resultSet; let rows = [];
          try { rows = await rs.getRows(limit + 1); } finally { await rs.close().catch(() => {}); }
          return positional(rows, (r.metaData || []).map((m) => m.name), limit);
        }
        const r = await c.execute(text, params ? params.map((p) => bindValue("oracle", p)) : [], opts);
        if (sess && !autoCommit && cls.op === "write") sess.inTx = true;
        return cmdResult(r.rowsAffected ?? 0, cls.op === "ddl" ? "OK" : `${r.rowsAffected ?? 0} row(s) affected${!autoCommit ? " (uncommitted)" : ""}`);
      } finally { unregisterOp(opId); if (!sess) await c.close().catch(() => {}); }
    }
    default: throw new DbError("Unsupported engine for SQL execution", { type: "unsupported" });
  }
}
async function execMongo(conn, entry, spec, cls, limit, opId) {
  const db = entry.handle.db(conn.database || undefined);
  const op = spec.op || (spec.collection ? "find" : "command");
  if (op === "command" || (!spec.collection && !spec.op)) { const r = await db.command(spec.command || spec); return unionShape([r], limit); }
  const col = db.collection(String(spec.collection));
  const lim = Math.min(limit, +spec.limit || limit);
  if (op === "find") { const cur = col.find(spec.filter || {}, spec.projection ? { projection: spec.projection } : {}).sort(spec.sort || {}).skip(+spec.skip || 0).limit(lim + 1); registerOp(opId, () => cur.close().then(() => true)); try { return unionShape(await cur.toArray(), lim); } finally { unregisterOp(opId); } }
  if (op === "findOne") { const d0 = await col.findOne(spec.filter || {}); return unionShape(d0 ? [d0] : [], limit); }
  if (op === "distinct") { const vals = await col.distinct(String(spec.field || "_id"), spec.filter || {}); return { columns: [String(spec.field || "_id")], rows: vals.slice(0, limit).map((v) => [cell(v)]), rowCount: Math.min(vals.length, limit), hasMore: vals.length > limit, truncated: vals.length > limit }; }
  if (op === "aggregate") { const cur = col.aggregate(spec.pipeline || []); registerOp(opId, () => cur.close().then(() => true)); try { const all = []; for await (const d0 of cur) { all.push(d0); if (all.length > limit) break; } return unionShape(all, limit); } finally { unregisterOp(opId); } }
  if (op === "count" || op === "countDocuments") { const n = await col.countDocuments(spec.filter || {}); return { columns: ["count"], rows: [[n]], rowCount: 1, hasMore: false }; }
  if (op === "indexes") return unionShape(await col.indexes(), limit);
  if (op === "insertOne") { const r = await col.insertOne(spec.doc || {}); return cmdResult(1, "Inserted " + r.insertedId, { insertedId: cell(r.insertedId) }); }
  if (op === "insertMany") { const r = await col.insertMany(spec.docs || []); return cmdResult(r.insertedCount, `Inserted ${r.insertedCount} doc(s)`); }
  if (op === "updateOne" || op === "updateMany") { const r = await col[op](spec.filter || {}, spec.update || {}); return cmdResult(r.modifiedCount, `${r.matchedCount} matched · ${r.modifiedCount} modified`, { matched: r.matchedCount }); }
  if (op === "deleteOne" || op === "deleteMany") { const r = await col[op](spec.filter || {}); return cmdResult(r.deletedCount, `${r.deletedCount} doc(s) deleted`); }
  if (op === "drop") { await col.drop(); return cmdResult(0, "Collection dropped"); }
  throw new DbError("Unknown op: " + op, { type: "invalid" });
}
async function execRedis(entry, sess, argv, limit) {
  const { client } = await clientFor(entry, sess);
  const r = await client.sendCommand(argv.map(String));
  if (sess) { const n = String(argv[0] || "").toUpperCase(); if (n === "MULTI") sess.inTx = true; else if (n === "EXEC" || n === "DISCARD") sess.inTx = false; }
  if (Array.isArray(r)) return { columns: ["value"], rows: r.slice(0, limit).map((v) => [cell(v)]), rowCount: Math.min(r.length, limit), hasMore: r.length > limit, truncated: r.length > limit };
  if (r !== null && typeof r === "object" && !Buffer.isBuffer(r)) return unionShape([r], limit);
  return { columns: ["value"], rows: [[cell(r)]], rowCount: 1, hasMore: false };
}
/* Run `fn(entry)` for `cls` with the retry rule: a transport failure never re-runs
 * anything that may have mutated state (→ type "outcome-unknown"); a classified read
 * outside a transaction retries once on a fresh handle. */
async function runGuarded(conn, cls, sess, fn) {
  let entry = await open(conn);
  try { return await fn(entry); }
  catch (e) {
    if (e instanceof DbError && e.type !== "transport") throw e;
    if (!isTransport(e)) throw wrap(e);
    const hadTx = !!(sess && sess.inTx);
    entry.broken = true;
    await dropSessionClients(conn.id);
    await closeHandle(conn.id);
    const safe = cls.readonly && !hadTx;
    if (!safe) throw new DbError(`The connection was lost while “${(cls.first || "the statement").toLowerCase()}” was running${hadTx ? " inside a transaction (now rolled back by the server)" : ""}. Its outcome is UNKNOWN — check the database before running it again.`, { type: "outcome-unknown", details: String((e && e.message) || e), hint: "Nothing was retried automatically." });
    entry = await open(conn);
    try { return await fn(entry); } catch (e2) { throw wrap(e2); }
  }
}
const clampLimit = (v, d = 200) => Math.max(1, Math.min(100000, +v || d));
// Read-only catalog call with a single transport retry (reads are safe to repeat).
async function readOp(conn, fn) {
  let entry = await open(conn);
  try { return await fn(entry); }
  catch (e) {
    if (!isTransport(e)) throw wrap(e);
    await dropSessionClients(conn.id);
    await closeHandle(conn.id);
    entry = await open(conn);
    try { return await fn(entry); } catch (e2) { throw wrap(e2); }
  }
}

/* ============================== transactions for generated mutations ============================== */
const ph = (kind, i) => kind === "postgres" ? `$${i + 1}` : kind === "mssql" ? `@p${i}` : kind === "oracle" ? `:${i + 1}` : "?";
/* A short transaction on a pinned client. run(sql, params) → { columns, rows, affected }.
 * SQLite uses a SAVEPOINT so it also works while a tab holds an open transaction. */
async function withTx(kind, entry, fn) {
  const d = entry.d;
  if (kind === "sqlite") {
    const db = entry.handle; const sp = "atomnano_mut_" + Date.now().toString(36);
    db.exec(`SAVEPOINT ${sp}`);
    const run = (sql, params) => { const st = db.prepare(sql); if (params) st.bind(...params.map((p) => bindValue("sqlite", p))); if (st.reader) { st.raw(true); const rows = st.all().map((r) => r.map(cell)); return { columns: st.columns().map((c) => c.name), rows, affected: rows.length }; } const r = st.run(); return { columns: [], rows: [], affected: Number(r.changes), insertId: r.lastInsertRowid != null ? String(r.lastInsertRowid) : undefined }; };
    try { const out = await fn(run); db.exec(`RELEASE ${sp}`); return out; } catch (e) { try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch { /* */ } throw e; }
  }
  if (kind === "mysql") {
    const c = await entry.handle.getConnection();
    try {
      await c.beginTransaction();
      const run = async (sql, params) => { const [rows, fields] = await c.query({ sql, values: params ? params.map((p) => bindValue("mysql", p)) : undefined, rowsAsArray: true }); if (Array.isArray(rows)) return { columns: (fields || []).map((f) => f.name), rows: rows.map((r) => r.map(cell)), affected: rows.length }; return { columns: [], rows: [], affected: rows.affectedRows ?? 0, insertId: rows.insertId ? String(rows.insertId) : undefined }; };
      try { const out = await fn(run); await c.commit(); return out; } catch (e) { await c.rollback().catch(() => {}); throw e; }
    } finally { c.release(); }
  }
  if (kind === "postgres") {
    const c = await entry.handle.connect();
    try {
      await c.query("BEGIN");
      const run = async (sql, params) => { const r = await c.query({ text: sql, values: params ? params.map((p) => bindValue("postgres", p)) : undefined, rowMode: "array" }); return { columns: (r.fields || []).map((f) => f.name), rows: (r.rows || []).map((x) => x.map(cell)), affected: r.rowCount ?? 0 }; };
      try { const out = await fn(run); await c.query("COMMIT"); return out; } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
    } finally { c.release(); }
  }
  if (kind === "mssql") {
    const tx = new d.Transaction(entry.handle);
    await tx.begin();
    const run = async (sql, params) => { const req = new d.Request(tx); req.arrayRowMode = true; (params || []).forEach((p, i) => { const v = bindValue("mssql", p); if (isTag(p) && p.$t === "bigint") req.input("p" + i, d.BigInt, v); else if (Buffer.isBuffer(v)) req.input("p" + i, d.VarBinary(d.MAX), v); else if (typeof v === "string" && /[^\x00-\x7f]/.test(v)) req.input("p" + i, d.NVarChar(d.MAX), v); else req.input("p" + i, v); }); const r = await req.query(sql); const rs = (r.recordsets || [])[0]; const cols = rs ? (Array.isArray(rs.columns) ? rs.columns : Object.values(rs.columns || {})).map((x) => x.name) : []; return { columns: cols, rows: rs ? rs.map((x) => x.map(cell)) : [], affected: Array.isArray(r.rowsAffected) ? r.rowsAffected.reduce((a, b) => a + b, 0) : 0 }; };
    try { const out = await fn(run); await tx.commit(); return out; } catch (e) { await tx.rollback().catch(() => {}); throw e; }
  }
  if (kind === "oracle") {
    const c = await entry.handle.getConnection();
    try {
      const run = async (sql, params) => { const r = await c.execute(sql, params ? params.map((p) => bindValue("oracle", p)) : [], { outFormat: d.OUT_FORMAT_ARRAY, autoCommit: false, fetchTypeHandler: (m) => (m.dbType === d.DB_TYPE_CLOB || m.dbType === d.DB_TYPE_NCLOB) ? { type: d.STRING } : m.dbType === d.DB_TYPE_BLOB ? { type: d.BUFFER } : undefined }); return { columns: (r.metaData || []).map((m) => m.name), rows: (r.rows || []).map((x) => x.map(cell)), affected: r.rowsAffected ?? (r.rows ? r.rows.length : 0) }; };
      try { const out = await fn(run); await c.commit(); return out; } catch (e) { await c.rollback().catch(() => {}); throw e; }
    } finally { await c.close().catch(() => {}); }
  }
  throw new DbError("Transactions are not available for this engine.", { type: "unsupported" });
}

module.exports = { cancel, readOp, runGuarded, clampLimit, execSql, execMongo, execRedis, unionShape, ph, withTx };
