"use strict";
/* Row identity and generated mutations. insert / update / delete bind PARAMETERS (never interpolated
 * literals), require the COMPLETE primary key with non-NULL typed values and run inside a
 * transaction that verifies exactly one row matched (rolled back otherwise); the persisted row is
 * re-read so the grid shows what the engine stored. count and browse page a table with a
 * DETERMINISTIC order: the requested column, then the key (or the engine's row locator). */
const { DbError } = require("./db-common");
const { open } = require("./db-connections");
const { getConn } = require("./db-store");
const { isTag, cell, cellText, quoteIdent, qualify, objIdent, displayName, safeFrag } = require("./db-values");
const { enforcePolicy, tableCls } = require("./db-policy");
const { ph, withTx, runGuarded, readOp, clampLimit, unionShape } = require("./db-exec");
const { query } = require("./db-query");
const { keyColumns } = require("./db-schema");

/* ============================== row identity + mutations ============================== */
const isRaw = (v) => v && typeof v === "object" && !isTag(v) && "raw" in v;
// The complete primary key with typed, non-NULL values — or a typed identity error.
function requireKey(pkCols, pk, table) {
  if (!pkCols.length) throw new DbError(`“${table}” has no primary key — rows can't be edited or deleted safely.`, { type: "identity" });
  const given = Object.keys(pk || {});
  const missing = pkCols.filter((c) => !given.includes(c)), extra = given.filter((c) => !pkCols.includes(c));
  if (missing.length || extra.length) throw new DbError(`Row identity must be the complete primary key (${pkCols.join(", ")})${missing.length ? ` — missing ${missing.join(", ")}` : ""}${extra.length ? ` — unexpected ${extra.join(", ")}` : ""}. Refresh the page and try again.`, { type: "identity" });
  for (const c of pkCols) { const v = pk[c]; if (v === null || v === undefined) throw new DbError(`The key column “${c}” is NULL for this row — NULL keys can match several rows, so the row can't be targeted.`, { type: "identity" }); if (isRaw(v)) throw new DbError("Expressions are not allowed in a row identity.", { type: "identity" }); if (isTag(v) && v.$t === "bytes" && v.len > 4096) throw new DbError("Binary keys longer than 4 KB are not supported for row targeting.", { type: "identity" }); }
  return pkCols.map((c) => pk[c]);
}
const whereKey = (kind, pkCols, offset = 0) => pkCols.map((c, i) => `${quoteIdent(kind, c)} = ${ph(kind, offset + i)}`).join(" AND ");
// SET/VALUES fragments: values bind; { raw } expressions pass through after validation.
function assignParts(kind, entries, params) {
  const frag = [];
  for (const [c, v] of entries) { if (isRaw(v)) frag.push(`${quoteIdent(kind, c)} = ${safeFrag(v.raw, "expression")}`); else { frag.push(`${quoteIdent(kind, c)} = ${ph(kind, params.length)}`); params.push(v); } }
  return frag;
}
function valueParts(kind, values, params) {
  return values.map((v) => { if (isRaw(v)) return safeFrag(v.raw, "expression"); params.push(v); return ph(kind, params.length - 1); });
}
// Mongo: typed identity ({ $t:"oid" } → ObjectId); strings stay strings; "=…" raw → EJSON.
function mongoValue(entry, v) {
  if (v === null || v === undefined) return null;
  if (isRaw(v)) { try { return entry.d.BSON.EJSON.parse(String(v.raw)); } catch (e) { throw new DbError("Raw Mongo value must be valid (Extended) JSON: " + e.message, { type: "invalid" }); } }
  if (!isTag(v)) return v;
  switch (v.$t) {
    case "oid": return new entry.d.ObjectId(String(v.v));
    case "bigint": return entry.d.Long.fromString(String(v.v));
    case "decimal": return entry.d.Decimal128.fromString(String(v.v));
    case "date": return new Date(v.v);
    case "bytes": return new entry.d.Binary(Buffer.from(v.b64 || "", "base64"));
    case "json": try { return JSON.parse(v.v); } catch { return v.v; }
    default: return String(v.v);
  }
}
const mongoDoc = (entry, values) => { const doc = {}; for (const [k, v] of Object.entries(values || {})) doc[k] = mongoValue(entry, v); return doc; };
async function insertRow(id, tableRef, values, opts = {}) {
  const conn = getConn(id, opts.expectRev);
  const entries = Object.entries(values || {});
  if (!entries.length) throw new DbError("No values to insert.", { type: "invalid" });
  if (conn.kind === "redis") throw new DbError("Not applicable to Redis", { type: "unsupported" });
  const o = objIdent(conn.kind, tableRef);
  enforcePolicy(conn, tableCls("write", o), "insert row");
  if (conn.kind === "mongodb") {
    const entry = await open(conn);
    const r = await entry.handle.db(conn.database || undefined).collection(o.table).insertOne(mongoDoc(entry, values));
    return { ok: true, affected: 1, message: "Inserted " + r.insertedId, insertedId: cell(r.insertedId) };
  }
  const k = conn.kind;
  const { pk } = await keyColumns(id, o);
  return runGuarded(conn, tableCls("write", o), null, (entry) => withTx(k, entry, async (run) => {
    const params = [];
    const cols = entries.map(([c]) => quoteIdent(k, c)).join(", ");
    const vals = valueParts(k, entries.map(([, v]) => v), params).join(", ");
    let sql = `INSERT INTO ${qualify(k, o)} (${cols}) VALUES (${vals})`;
    if (k === "postgres") sql += " RETURNING *";
    else if (k === "mssql") sql = `INSERT INTO ${qualify(k, o)} (${cols}) OUTPUT INSERTED.* VALUES (${vals})`;
    const r = await run(sql, params);
    let row = r.rows && r.rows[0] ? { columns: r.columns, values: r.rows[0] } : null;
    // re-read the persisted row where the engine can't return it directly
    if (!row && k === "sqlite" && r.insertId) { const rr = await run(`SELECT * FROM ${qualify(k, o)} WHERE rowid = ?`, [{ $t: "bigint", v: r.insertId }]); if (rr.rows[0]) row = { columns: rr.columns, values: rr.rows[0] }; }
    if (!row && k === "mysql" && r.insertId && pk.length === 1) { const rr = await run(`SELECT * FROM ${qualify(k, o)} WHERE ${quoteIdent(k, pk[0])} = ?`, [{ $t: "bigint", v: r.insertId }]); if (rr.rows[0]) row = { columns: rr.columns, values: rr.rows[0] }; }
    return { ok: true, affected: k === "postgres" || k === "mssql" ? (r.rows ? r.rows.length : r.affected) : r.affected, message: "Inserted", insertId: r.insertId, row, sql };
  }));
}
/* UPDATE exactly one row: complete typed key, cardinality verified inside a
 * transaction (0 or >1 matches roll back), the persisted row is re-read. */
async function updateRows(id, tableRef, { pk, set } = {}, opts = {}) {
  const conn = getConn(id, opts.expectRev);
  const setE = Object.entries(set || {});
  if (!setE.length) throw new DbError("Nothing to update.", { type: "invalid" });
  if (conn.kind === "redis") throw new DbError("Not applicable to Redis", { type: "unsupported" });
  const o = objIdent(conn.kind, tableRef);
  enforcePolicy(conn, tableCls("write", o), "update row");
  if (conn.kind === "mongodb") {
    const keyVals = requireKey(["_id"], pk, o.table);
    const entry = await open(conn);
    const col = entry.handle.db(conn.database || undefined).collection(o.table);
    const filter = { _id: mongoValue(entry, keyVals[0]) };
    const r = await col.updateOne(filter, { $set: mongoDoc(entry, set) });
    if (r.matchedCount !== 1) throw new DbError(r.matchedCount === 0 ? "No document matches this _id any more — it was changed or deleted. Refresh." : `${r.matchedCount} documents matched — the identity is ambiguous.`, { type: r.matchedCount === 0 ? "not-found" : "identity" });
    const doc = await col.findOne(filter);
    const shaped = unionShape(doc ? [doc] : [], 1);
    return { ok: true, affected: r.modifiedCount, matched: r.matchedCount, message: `${r.matchedCount} matched · ${r.modifiedCount} modified`, row: shaped.rows[0] ? { columns: shaped.columns, values: shaped.rows[0] } : null };
  }
  const k = conn.kind;
  const { pk: pkCols } = await keyColumns(id, o);
  const keyVals = requireKey(pkCols, pk, displayName(o));
  return runGuarded(conn, tableCls("write", o), null, (entry) => withTx(k, entry, async (run) => {
    const where = whereKey(k, pkCols);
    const cnt = await run(`SELECT COUNT(*) FROM ${qualify(k, o)} WHERE ${where}`, keyVals);
    const n = Number(cellText(cnt.rows[0] && cnt.rows[0][0]) || 0);
    if (n !== 1) throw new DbError(n === 0 ? "No row matches this key any more — it was changed or deleted. Refresh." : `${n} rows match this key — the identity is ambiguous; nothing was changed.`, { type: n === 0 ? "not-found" : "identity" });
    const params = [];
    const sets = assignParts(k, setE, params);
    const sql = `UPDATE ${qualify(k, o)} SET ${sets.join(", ")} WHERE ${whereKey(k, pkCols, params.length)}`;
    const r = await run(sql, [...params, ...keyVals]);
    if (Number(r.affected) > 1) throw new DbError(`The update matched ${r.affected} rows — rolled back.`, { type: "identity" });
    // re-read with the NEW key (a key column may have been edited)
    const newKey = pkCols.map((c) => (Object.prototype.hasOwnProperty.call(set, c) && !isRaw(set[c]) ? set[c] : pk[c]));
    const rr = await run(`SELECT * FROM ${qualify(k, o)} WHERE ${where}`, newKey);
    return { ok: true, affected: Number(r.affected), message: `${r.affected} row updated`, sql, row: rr.rows[0] ? { columns: rr.columns, values: rr.rows[0] } : null };
  }));
}
// DELETE the given rows: each key complete and matching exactly one row, all in one transaction.
async function deleteRows(id, tableRef, pks, opts = {}) {
  const conn = getConn(id, opts.expectRev);
  const list = (pks || []).filter((p) => p && Object.keys(p).length);
  if (!list.length) throw new DbError("A primary key is required to delete rows safely.", { type: "identity" });
  if (conn.kind === "redis") throw new DbError("Not applicable to Redis", { type: "unsupported" });
  const o = objIdent(conn.kind, tableRef);
  enforcePolicy(conn, tableCls("write", o), "delete rows");
  if (conn.kind === "mongodb") {
    const entry = await open(conn);
    const ids = list.map((p) => mongoValue(entry, requireKey(["_id"], p, o.table)[0]));
    const col = entry.handle.db(conn.database || undefined).collection(o.table);
    const n = await col.countDocuments({ _id: { $in: ids } });
    if (n !== ids.length) throw new DbError(`${n} of ${ids.length} documents match — some were changed or deleted. Refresh; nothing was deleted.`, { type: "not-found" });
    const r = await col.deleteMany({ _id: { $in: ids } });
    return { ok: true, affected: r.deletedCount, message: `${r.deletedCount} doc(s) deleted` };
  }
  const k = conn.kind;
  const { pk: pkCols } = await keyColumns(id, o);
  const keys = list.map((p) => requireKey(pkCols, p, displayName(o)));
  return runGuarded(conn, tableCls("write", o), null, (entry) => withTx(k, entry, async (run) => {
    let affected = 0;
    for (const kv of keys) {
      const where = whereKey(k, pkCols);
      const cnt = await run(`SELECT COUNT(*) FROM ${qualify(k, o)} WHERE ${where}`, kv);
      const n = Number(cellText(cnt.rows[0] && cnt.rows[0][0]) || 0);
      if (n !== 1) throw new DbError(n === 0 ? "A row no longer matches its key — it was changed or deleted. Nothing was deleted; refresh." : `${n} rows match one key — ambiguous identity; nothing was deleted.`, { type: n === 0 ? "not-found" : "identity" });
      const r = await run(`DELETE FROM ${qualify(k, o)} WHERE ${where}`, kv);
      if (Number(r.affected) !== 1) throw new DbError(`A delete affected ${r.affected} rows — rolled back.`, { type: "identity" });
      affected += 1;
    }
    return { ok: true, affected, message: `${affected} row(s) deleted` };
  }));
}

/* ============================== count · browse (stable pages) ============================== */
function parseJsonFilter(s) { try { return JSON.parse(s); } catch { throw new DbError('Filter must be a JSON document, e.g. {"status":"active"}', { type: "invalid" }); } }
async function count(id, tableRef, where) {
  const conn = getConn(id);
  if (conn.kind === "redis") throw new DbError("Not applicable to Redis", { type: "unsupported" });
  const o = objIdent(conn.kind, tableRef);
  if (conn.kind === "mongodb") {
    const t0 = Date.now();
    const n = await readOp(conn, (e) => e.handle.db(conn.database || undefined).collection(o.table).countDocuments(where && where.trim() ? parseJsonFilter(where) : {}));
    return { count: n, exact: true, ms: Date.now() - t0 };
  }
  const w = where && where.trim() ? " WHERE " + safeFrag(where, "filter") : "";
  const r = await query(id, `SELECT COUNT(*) AS n FROM ${qualify(conn.kind, o)}${w}`, { limit: 1 });
  return { count: r.rows && r.rows[0] ? Number(cellText(r.rows[0][0])) : null, exact: true, ms: r.ms };
}
/* One page of a table with a DETERMINISTIC order: the requested column (if any),
 * then the primary key as tie-breaker; without a key, the engine's row locator or all
 * columns. `total` is only an exact count (opts.count) — never an estimate. */
async function browse(id, tableRef, opts = {}) {
  const conn = getConn(id);
  const offset = Math.max(0, Math.floor(+opts.offset || 0)), limit = clampLimit(opts.limit);
  const dir = /^desc$/i.test(opts.dir || "") ? "DESC" : "ASC";
  const where = String(opts.where || "").trim();
  if (conn.kind === "redis") throw new DbError("Browse isn't available for Redis — run commands in Query.", { type: "unsupported" });
  const o = objIdent(conn.kind, tableRef);
  if (conn.kind === "mongodb") {
    const filter = where ? parseJsonFilter(where) : {};
    const t0 = Date.now();
    return readOp(conn, async (e) => {
      const col = e.handle.db(conn.database || undefined).collection(o.table);
      const sort = opts.orderBy ? { [opts.orderBy]: dir === "ASC" ? 1 : -1, _id: 1 } : { _id: 1 };
      const docs = await col.find(filter).sort(sort).skip(offset).limit(limit + 1).toArray();
      const total = opts.count ? await col.countDocuments(filter) : null;
      return { ...unionShape(docs, limit), ms: Date.now() - t0, offset, limit, total, stable: true, orderBy: opts.orderBy || "_id" };
    });
  }
  const k = conn.kind, t = qualify(k, o);
  const w = where ? " WHERE " + safeFrag(where, "filter") : "";
  const { pk, cols } = await keyColumns(id, o);
  const ordCols = [];
  if (opts.orderBy) ordCols.push(`${quoteIdent(k, opts.orderBy)} ${dir}`);
  const tie = pk.length ? pk.filter((c) => c !== opts.orderBy) : [];
  let stable = true;
  if (tie.length) ordCols.push(...tie.map((c) => quoteIdent(k, c)));
  else if (!pk.length) {
    if (k === "sqlite") ordCols.push("rowid");
    else if (k === "postgres") ordCols.push("ctid");
    else if (cols.length) ordCols.push(...cols.filter((c) => c.name !== opts.orderBy).map((c) => quoteIdent(k, c.name)));
    else stable = false;
  }
  const ob = ordCols.length ? ` ORDER BY ${ordCols.join(", ")}` : (k === "mssql" ? " ORDER BY (SELECT NULL)" : "");
  let sql;
  if (k === "mssql") sql = `SELECT * FROM ${t}${w}${ob} OFFSET ${offset} ROWS FETCH NEXT ${limit + 1} ROWS ONLY`;
  else if (k === "oracle") sql = `SELECT * FROM ${t}${w}${ob} OFFSET ${offset} ROWS FETCH NEXT ${limit + 1} ROWS ONLY`;
  else sql = `SELECT * FROM ${t}${w}${ob} LIMIT ${limit + 1} OFFSET ${offset}`;
  const r = await query(id, sql, { limit: limit + 1 });
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  let total = null;
  if (opts.count) { const c = await query(id, `SELECT COUNT(*) AS n FROM ${t}${w}`, { limit: 1 }); total = c.rows && c.rows[0] ? Number(cellText(c.rows[0][0])) : null; }
  return { columns: r.columns, rows, rowCount: rows.length, hasMore, truncated: hasMore, ms: r.ms, offset, limit, total, sql, stable, orderBy: opts.orderBy || "", pk };
}

module.exports = { insertRow, updateRows, deleteRows, count, browse };
