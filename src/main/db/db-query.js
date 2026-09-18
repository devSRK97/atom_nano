"use strict";
/* The profile-facing statement API: test / ping (health on the shared handle, never on a session
 * client; a transport failure gets ONE fresh open, auth failures never heal by waiting), query
 * (policy-checked, session-aware, cancellable, retried only when safe), script splitting and
 * formatting for the connection's dialect, the session lifecycle a query tab drives (sessionOpen /
 * sessionSet) and EXPLAIN. */
const { DbError, VALID_KIND, uid, wrap } = require("./db-common");
const S = require("./sqlscript");
const { connect } = require("./db-drivers");
const { open, closeOne, closeHandle, isLive, dropSessionClients, sessions, sessionState } = require("./db-connections");
const { getConn, SECRET_FIELDS } = require("./db-store");
const { safeFrag } = require("./db-values");
const { enforcePolicy, mongoClassify, redisClassify, splitCmd } = require("./db-policy");
const { execSql, execMongo, execRedis, runGuarded, readOp, clampLimit } = require("./db-exec");

/* ============================== test / ping ============================== */
// Test a saved profile (by id) or an unsaved form (object). Unsaved tests use a
// throw-away handle that is always disposed — never the shared cache.
async function test(connOrId) {
  const t0 = Date.now();
  try {
    if (typeof connOrId === "string") { const r = await ping(connOrId); return r.ok ? { ok: true, ms: r.ms } : { ok: false, detail: r.detail, type: r.type }; }
    const conn = { ...(connOrId || {}) };
    if (!VALID_KIND(conn.kind)) return { ok: false, detail: "Unknown database kind", type: "invalid" };
    // secrets may come from the form ({ $keep } → the stored one)
    for (const f of SECRET_FIELDS) if (conn[f] && typeof conn[f] === "object" && conn[f].$keep) { if (!conn.id) throw new DbError(`Enter the ${f} to test an unsaved connection.`, { type: "invalid" }); conn[f] = getConn(conn.id)[f]; }
    conn.id = uid("__test__");
    const entry = await connect(conn);
    try { await hitPing(entry, conn); } finally { await entry.close().catch(() => {}); }
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    const e = wrap(err);
    return { ok: false, detail: e.message, type: e.type, driverMissing: err && err.driverMissing, hint: e.hint };
  }
}
async function hitPing(e, conn) {
  switch (e.kind) {
    case "mysql": case "postgres": await e.handle.query("SELECT 1"); break;
    case "oracle": { const c = await e.handle.getConnection(); try { await c.execute("SELECT 1 FROM dual"); } finally { await c.close().catch(() => {}); } break; }
    case "mongodb": await e.handle.db(conn.database || "admin").command({ ping: 1 }); break;
    case "sqlite": e.handle.prepare("SELECT 1").get(); break;
    case "mssql": await e.handle.request().query("SELECT 1"); break;
    case "redis": await e.handle.ping(); break;
  }
}
/* Health ping on the shared handle (never on a tab's session client). On a transport
 * failure the handle is dropped and ONE fresh open is attempted; auth/permission
 * failures are reported as such (they never heal by waiting). */
async function ping(id) {
  const conn = getConn(id);
  const t0 = Date.now();
  const had = isLive(conn.id);
  try { await hitPing(await open(conn), conn); return { ok: true, ms: Date.now() - t0, reconnected: !had }; }
  catch (err) {
    const e = wrap(err);
    if (e.type !== "transport" && e.type !== "cancelled") { await closeOne(conn.id); return { ok: false, detail: e.message, type: e.type, ms: Date.now() - t0 }; }
    await dropSessionClients(conn.id);                     // tabs keep their session ids (and learn about a lost transaction)
    await closeHandle(conn.id);
    try { await hitPing(await open(conn), conn); return { ok: true, ms: Date.now() - t0, reconnected: true }; }
    catch (err2) { const e2 = wrap(err2); await closeHandle(conn.id); return { ok: false, detail: e2.message, type: e2.type, ms: Date.now() - t0 }; }
  }
}

/* ============================== query (one statement, one tab) ============================== */
/* Run one statement. opts: { limit, session, opId, expectRev, params (internal), argv (Redis) }. */
async function query(id, text, opts = {}) {
  const conn = getConn(id, opts.expectRev);
  const limit = clampLimit(opts.limit);
  const sess = opts.session ? sessions.get(String(opts.session)) : null;
  if (opts.session && !sess) throw new DbError("This query tab's session is gone (the connection was closed or edited). Run again to start a new session.", { type: "session-gone" });
  if (sess && sess.id !== id) throw new DbError("The session belongs to a different connection.", { type: "invalid" });
  const opId = opts.opId ? String(opts.opId) : "";
  const t0 = Date.now();
  const finish = (r, cls) => ({ ...r, ms: Date.now() - t0, op: cls.op, first: cls.first, session: sess ? { session: sess.sid, inTx: !!sess.inTx, lostTx: !!sess.lostTx } : undefined });
  if (conn.kind === "mongodb") {
    let spec; try { spec = JSON.parse(String(text)); } catch { throw new DbError('MongoDB queries are JSON, e.g. {"collection":"users","op":"find","filter":{}}', { type: "invalid" }); }
    if (!spec || typeof spec !== "object") throw new DbError("MongoDB query must be a JSON object.", { type: "invalid" });
    if (spec.collection != null) safeFrag(String(spec.collection), "collection");
    const cls = mongoClassify(spec);
    enforcePolicy(conn, cls, text);
    return finish(await runGuarded(conn, cls, sess, (entry) => execMongo(conn, entry, spec, cls, limit, opId)), cls);
  }
  if (conn.kind === "redis") {
    const argv = Array.isArray(opts.argv) && opts.argv.length ? opts.argv.map((a) => (a == null ? "" : String(a))) : splitCmd(String(text || "").trim());
    if (!argv.length) throw new DbError("Empty command", { type: "invalid" });
    const cls = redisClassify(argv);
    enforcePolicy(conn, cls, argv.join(" "));
    return finish(await runGuarded(conn, cls, sess, (entry) => execRedis(entry, sess, argv, limit)), cls);
  }
  const sql = String(text || "");
  if (!sql.trim()) throw new DbError("Empty statement", { type: "invalid" });
  const cls = S.classify(sql, conn.kind);
  enforcePolicy(conn, cls, sql);
  const params = Array.isArray(opts.params) ? opts.params : null;
  const r = await runGuarded(conn, cls, sess, (entry) => execSql(conn.kind, entry, sess, sql, params, { limit, opId, cls }));
  return finish(r, cls);
}
async function parallelQuery(id, queries, opts = {}) { return Promise.all((queries || []).map((q) => query(id, q, { ...opts, session: undefined }))); }
// Split an editor script into statements for this connection's dialect.
function splitScript(id, text) { const conn = getConn(id); return S.splitScript(String(text || ""), conn.kind === "mongodb" || conn.kind === "redis" ? "generic" : conn.kind); }
function formatSql(id, text) { const conn = getConn(id); return S.formatSql(String(text || ""), conn.kind); }
// A query tab opens a SESSION on a saved profile; its pinned client is acquired lazily by the first statement (clientFor).
async function sessionOpen(id) {
  const conn = getConn(id);
  const sid = uid("s");
  sessions.set(sid, { sid, id, kind: conn.kind, client: null, inTx: false, gen: 0, txObj: null, autocommit: true });
  return { session: sid, kind: conn.kind };
}
async function sessionSet(sid, patch) { const s = sessions.get(String(sid)); if (!s) throw new DbError("Session not found", { type: "session-gone" }); if (patch && typeof patch.autocommit === "boolean") s.autocommit = patch.autocommit; return sessionState(sid); }

/* ============================== explain ============================== */
async function explain(id, text) {
  const conn = getConn(id);
  const s = String(text || "").trim().replace(/;+\s*$/, "");
  if (!/^(select|with|insert|update|delete)\b/i.test(s)) throw new DbError("EXPLAIN works on SELECT / INSERT / UPDATE / DELETE statements.", { type: "invalid" });
  switch (conn.kind) {
    case "mysql": return query(id, "EXPLAIN " + s, { limit: 500 });
    case "postgres": return query(id, "EXPLAIN (FORMAT TEXT) " + s, { limit: 5000 });
    case "sqlite": return query(id, "EXPLAIN QUERY PLAN " + s, { limit: 500 });
    case "oracle": {
      const t0 = Date.now();
      return readOp(conn, async (e) => { const c = await e.handle.getConnection(); try { await c.execute("EXPLAIN PLAN FOR " + s); const r = await c.execute("SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY())", [], { outFormat: e.d.OUT_FORMAT_OBJECT }); return { columns: ["plan"], rows: r.rows.map((x) => [x.PLAN_TABLE_OUTPUT]), rowCount: r.rows.length, ms: Date.now() - t0 }; } finally { await c.close().catch(() => {}); } });
    }
    case "mssql": throw new DbError("Execution plans are not available for SQL Server in this build.", { type: "unsupported" });
    default: throw new DbError("EXPLAIN isn't available for this engine.", { type: "unsupported" });
  }
}

module.exports = { test, ping, query, parallelQuery, splitScript, formatSql, sessionOpen, sessionSet, explain };
