"use strict";
/* Live handles and sessions. One generation-tracked entry per profile: concurrent cold opens share
 * a promise, a disconnect during open closes the late handle instead of caching it, close() is
 * awaited. A query tab owns a SESSION whose pinned client carries BEGIN/COMMIT, SET/USE, temp
 * tables and search_path; after a transport failure only the shared handle is dropped, so the
 * session keeps its id and reports its transaction as lost instead of silently starting anew. */
const { DbError, wrap } = require("./db-common");
const { connect } = require("./db-drivers");

/* ============================== live connections (generation-tracked) ============================== */
const live = new Map();   // conn.id → { gen, promise, entry, broken }
let genSeq = 0;
/* Open (or reuse) the live connection for a profile. Concurrent cold calls share one
 * promise; a disconnect during open invalidates the generation and the late handle is
 * closed instead of cached. */
async function open(conn) {
  const key = conn.id;
  let rec = live.get(key);
  if (rec && rec.entry && !rec.entry.broken) return rec.entry;
  if (rec && rec.entry && rec.entry.broken) { live.delete(key); await rec.entry.close().catch(() => {}); rec = null; }
  if (rec && rec.promise) return rec.promise;
  const gen = ++genSeq;
  rec = { gen, promise: null, entry: null };
  live.set(key, rec);
  rec.promise = (async () => {
    let entry;
    try { entry = await connect(conn); } catch (e) { if (live.get(key) === rec) live.delete(key); throw wrap(e); }
    entry.gen = gen; entry.id = key; entry.rev = conn.rev || 1;
    if (live.get(key) !== rec) { await entry.close().catch(() => {}); throw new DbError("The connection was closed while it was opening.", { type: "cancelled" }); }
    rec.entry = entry; rec.promise = null;
    return entry;
  })();
  return rec.promise;
}
async function closeOne(id) {
  const rec = live.get(id);
  live.delete(id);                                         // an in-flight open sees this and closes its late handle
  await closeSessionsFor(id);
  if (rec && rec.entry) await rec.entry.close().catch(() => {});
}
/* Drop only the shared handle after a TRANSPORT failure. Session records survive (their
 * pinned clients are released separately) so a tab keeps its session id and learns that
 * its transaction was lost instead of silently getting a new session. */
async function closeHandle(id) {
  const rec = live.get(id);
  live.delete(id);
  if (rec && rec.entry) await rec.entry.close().catch(() => {});
}
async function closeAll() { for (const id of [...live.keys()]) await closeOne(id); }
function isLive(id) { const r = live.get(id); return !!(r && r.entry && !r.entry.broken); }

/* ============================== sessions (pinned clients per tab) ============================== */
const sessions = new Map();   // sid → { sid, id, kind, client, inTx, gen, txObj }
async function releaseSessionClient(sess, { rollback = true } = {}) {
  const c = sess.client; sess.client = null;
  if (!c) { sess.inTx = false; sess.txObj = null; return; }
  try {
    if (sess.kind === "mysql") { if (sess.inTx && rollback) await c.rollback().catch(() => {}); c.release(); }
    else if (sess.kind === "postgres") { if (sess.inTx && rollback) await c.query("ROLLBACK").catch(() => {}); c.release(); }
    else if (sess.kind === "oracle") { if (sess.inTx && rollback) await c.rollback().catch(() => {}); await c.close().catch(() => {}); }
    else if (sess.kind === "mssql") { if (sess.txObj && rollback) await sess.txObj.rollback().catch(() => {}); }
    else if (sess.kind === "redis") { await c.quit().catch(() => {}); }
    else if (sess.kind === "sqlite") { if (sess.inTx && rollback) { try { c.exec("ROLLBACK"); } catch { /* */ } } }
  } finally { sess.inTx = false; sess.txObj = null; }
}
async function sessionClose(sid, { rollback = true } = {}) {
  const sess = sessions.get(sid);
  if (!sess) return { ok: true, existed: false };
  sessions.delete(sid);
  await releaseSessionClient(sess, { rollback });
  return { ok: true, existed: true };
}
async function closeSessionsFor(id) { for (const s of [...sessions.values()]) if (s.id === id) { sessions.delete(s.sid); await releaseSessionClient(s, { rollback: true }).catch(() => {}); } }
// The client a statement runs on: the session's pinned client (acquired lazily) or the pool.
async function clientFor(entry, sess) {
  if (!sess) return { client: entry.handle, pinned: false };
  if (sess.client && sess.gen === entry.gen) return { client: sess.client, pinned: true };
  if (sess.client) await releaseSessionClient(sess, { rollback: true });   // the connection was re-opened: the old pinned client is gone
  sess.gen = entry.gen; sess.lostTx = false;
  switch (entry.kind) {
    case "mysql": sess.client = await entry.handle.getConnection(); break;
    case "postgres": sess.client = await entry.handle.connect(); break;
    case "oracle": sess.client = await entry.handle.getConnection(); break;
    case "redis": { const c = entry.handle.duplicate(); c.on("error", () => {}); await c.connect(); sess.client = c; break; }
    case "mssql": sess.client = entry.handle; break;       // pinned via Transaction objects (see execMssql)
    default: sess.client = entry.handle;                   // sqlite / mongo: one handle
  }
  return { client: sess.client, pinned: true };
}
function sessionState(sid) { const s = sessions.get(sid); return s ? { session: sid, inTx: !!s.inTx, autocommit: s.autocommit !== false, lostTx: !!s.lostTx } : null; }
// Drop the pinned clients of a connection's sessions (after a transport failure) but keep the session ids.
async function dropSessionClients(id) { for (const s of sessions.values()) if (s.id === id && s.client) { const inTx = s.inTx; await releaseSessionClient(s, { rollback: false }).catch(() => {}); s.lostTx = inTx; } }

module.exports = { live, sessions, open, closeOne, closeHandle, closeAll, isLive, sessionClose, closeSessionsFor, clientFor, sessionState, dropSessionClients };
