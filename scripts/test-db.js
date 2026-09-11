"use strict";
/* DB backend regression suite — DESIRED behaviour for the audit findings
 * (ATOMNANO_DB_MANAGEMENT_AUDIT_2026-09-09, DB-001..DB-051). Each block names the audit
 * check IDs (DB-Bxx) it converts from "bug reproduced" to "correct behaviour asserted".
 *
 * Isolation: Electron is stubbed (temp userData, fake safeStorage keyed per "account",
 * a save-dialog stub); SQLite is REAL (better-sqlite3 on temp files); the six server
 * engines use FAKE drivers injected through the module loader — no live server, no
 * network, and never the user's saved profiles. A fake-driver test proves the
 * module's contract, not server integration (see the implementation notes).
 * Run:  node scripts/test-db.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const EventEmitter = require("events");

const APP = path.join(__dirname, "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-db-test-"));
const USER = path.join(ROOT, "userData"); fs.mkdirSync(USER);
process.env.ATOMNANO_USER_DATA = USER;

/* ------------------------------ Electron stub ------------------------------ */
const secure = { available: true, key: 7 };            // key = the OS account that encrypted
const dialogAnswers = { save: null };
const electronStub = {
  app: { getPath: (n) => (n === "userData" ? USER : ROOT), getAppPath: () => APP, isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => secure.available,
    encryptString: (s) => { if (!secure.available) throw new Error("encryption unavailable"); return Buffer.from(`ENC${secure.key}:${Buffer.from(String(s), "utf8").toString("base64")}`); },
    decryptString: (b) => { const m = /^ENC(\d+):(.*)$/.exec(b.toString()); if (!m || +m[1] !== secure.key) throw new Error("Decryption failed"); return Buffer.from(m[2], "base64").toString("utf8"); },
  },
  dialog: { showSaveDialog: async (_w, o) => (dialogAnswers.save ? dialogAnswers.save(o) : { canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: class {}, ipcMain: { handle() {}, on() {} },
};
/* ------------------------------ fake drivers ------------------------------ */
const fake = { mysql: null, pg: null, mssql: null, oracle: null, mongo: null, redis: null, brokenPg: false };
const FAKE_PKGS = { mysql2: "mysql", pg: "pg", mssql: "mssql", oracledb: "oracle", mongodb: "mongo", redis: "redis" };
const pkgOf = (req) => Object.keys(FAKE_PKGS).find((p) => req === p || req.startsWith(p + "/"));
const origResolve = Module._resolveFilename, origLoad = Module._load;
Module._resolveFilename = function (request, ...rest) { if (request === "electron") return "electron"; const p = pkgOf(request); if (p) return "fake:" + p; return origResolve.call(this, request, ...rest); };
Module._load = function (request, ...rest) {
  if (request === "electron") return electronStub;
  const p = pkgOf(request.startsWith("fake:") ? request.slice(5) : request);
  if (p) { if (p === "pg" && fake.brokenPg) throw new Error("The module was compiled against a different Node.js version using NODE_MODULE_VERSION 118."); return fake[FAKE_PKGS[p]].mod; }
  return origLoad.call(this, request, ...rest);
};
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = (n = 3) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : setImmediate(f)); setImmediate(f); });

// ---- MySQL (mysql2/promise): scripted by rules; records every statement and connection ----
function mkMysql() {
  const st = { pools: [], conns: [], queries: [], rules: [] };
  const handle = async (sql, values, connId) => {
    for (const r of st.rules) if (r.re.test(sql)) return r.fn(sql, values, connId);
    if (/select\s+1\b/i.test(sql)) return { rows: [[1]], fields: [{ name: "1" }] };
    if (/^\s*(insert|update|delete|kill|start|commit|rollback|alter|create|drop|set)\b/i.test(sql)) return { affectedRows: 1, insertId: 0 };
    return { rows: [], fields: [] };
  };
  let seq = 0;
  st.mod = {
    createPool(cfg) {
      const pool = { id: ++seq, cfg, ended: false, pool: new EventEmitter() };
      st.pools.push(pool);
      const exec = async (q, values, connId) => { const o = typeof q === "string" ? { sql: q, values } : q; const rec = { sql: o.sql, values: o.values, connId, pool: pool.id, rowsAsArray: o.rowsAsArray }; st.queries.push(rec); const r = await handle(o.sql, o.values, connId); if (r && "affectedRows" in r) return [r, undefined]; if (o.rowsAsArray === false && r.objects) return [r.objects, r.fields]; return [r.rows, r.fields]; };
      pool.query = (q, values) => exec(q, values, 0);
      pool.getConnection = async () => { const id = ++seq; const c = { id, connection: { threadId: 1000 + id }, released: false, tx: [], query: (q, values) => exec(q, values, id), release() { c.released = true; }, async beginTransaction() { c.tx.push("begin"); }, async commit() { c.tx.push("commit"); }, async rollback() { c.tx.push("rollback"); } }; st.conns.push(c); return c; };
      pool.end = async () => { pool.ended = true; };
      return pool;
    },
  };
  return st;
}
// ---- PostgreSQL (pg): Pool with idle error events, clients with processID ----
function mkPg() {
  const st = { pools: [], queries: [], rules: [] };
  const handle = async (text, values) => { for (const r of st.rules) if (r.re.test(text)) return r.fn(text, values); if (/select\s+1\b/i.test(text)) return { rows: [[1]], fields: [{ name: "?column?" }], command: "SELECT", rowCount: 1 }; return { rows: [], fields: [], command: "SELECT", rowCount: 0 }; };
  let seq = 0;
  class Pool extends EventEmitter {
    constructor(cfg) { super(); this.id = ++seq; this.cfg = cfg; this.ended = false; st.pools.push(this); }
    async connect() { const c = { processID: 500 + this.id, released: false, query: async (q, values) => { const o = typeof q === "string" ? { text: q, values } : q; st.queries.push({ text: o.text, values: o.values, pool: this.id, client: c.processID }); return handle(o.text, o.values); }, release() { c.released = true; } }; return c; }
    async query(q, values) { const o = typeof q === "string" ? { text: q, values } : q; st.queries.push({ text: o.text, values: o.values, pool: this.id, client: 0 }); return handle(o.text, o.values); }
    async end() { this.ended = true; }
  }
  st.mod = { Pool };
  return st;
}
// ---- SQL Server (mssql): ConnectionPool / Request (stream mode) / Transaction ----
function mkMssql() {
  const st = { pools: [], requests: [], rules: [] };
  let seq = 0;
  class ConnectionPool extends EventEmitter { constructor(cfg) { super(); this.id = ++seq; this.cfg = cfg; this.closed = false; st.pools.push(this); } async connect() { return this; } async close() { this.closed = true; } request() { return new Request(this); } }
  class Transaction { constructor(pool) { this.pool = pool; this.log = []; } async begin() { this.log.push("begin"); } async commit() { this.log.push("commit"); } async rollback() { this.log.push("rollback"); } }
  class Request extends EventEmitter {
    constructor(parent) { super(); this.parent = parent; this.inputs = []; this.stream = false; this.cancelled = false; st.requests.push(this); }
    input(name, type, value) { this.inputs.push({ name, type, value: value === undefined ? type : value }); return this; }
    cancel() { this.cancelled = true; }
    async query(sql) {
      this.sql = sql;
      const rule = st.rules.find((r) => r.re.test(sql));
      const res = rule ? await rule.fn(sql, this) : { recordsets: [], rowsAffected: [0] };
      if (!this.stream) return res;
      queueMicrotask(() => {
        for (const rs of res.recordsets || []) { this.emit("recordset", rs.columns); for (const row of rs) { if (this.cancelled) break; this.emit("row", row); } }
        this.emit("done", { rowsAffected: res.rowsAffected || [] });
      });
      return undefined;
    }
  }
  st.mod = { ConnectionPool, Request, Transaction, BigInt: "BigInt", VarBinary: (n) => ({ t: "VarBinary", n }), NVarChar: (n) => ({ t: "NVarChar", n }), MAX: "MAX" };
  return st;
}
// ---- Oracle (oracledb): pool.getConnection / execute with resultSet + autoCommit ----
function mkOracle() {
  const st = { pools: [], execs: [], rules: [], conns: [] };
  let seq = 0;
  st.mod = {
    OUT_FORMAT_ARRAY: 4001, OUT_FORMAT_OBJECT: 4002, DB_TYPE_CLOB: 2017, DB_TYPE_NCLOB: 2018, DB_TYPE_BLOB: 2019, STRING: 2001, BUFFER: 2006,
    async createPool(cfg) {
      const pool = { id: ++seq, cfg, closed: false, getConnectionCalls: 0 };
      st.pools.push(pool);
      pool.getConnection = async () => {
        pool.getConnectionCalls++;
        const c = { id: ++seq, log: [], async execute(sql, binds, opts) { const rec = { sql, binds, opts, conn: c.id }; st.execs.push(rec); const rule = st.rules.find((r) => r.re.test(sql)); if (rule) return rule.fn(sql, binds, opts, c); if (/FROM dual/i.test(sql)) return { rows: [[1]], metaData: [{ name: "1" }] }; return { rowsAffected: 1 }; }, async close() { c.log.push("close"); }, async commit() { c.log.push("commit"); }, async rollback() { c.log.push("rollback"); }, async break() { c.log.push("break"); } };
        st.conns.push(c); return c;
      };
      pool.close = async () => { pool.closed = true; };
      return pool;
    },
  };
  return st;
}
// ---- MongoDB: in-memory collections with the subset of the driver API the module uses ----
function mkMongo() {
  const st = { clients: [], dbs: new Map(), calls: [] };
  let oidSeq = 0;
  class ObjectId { constructor(hex) { this._bsontype = "ObjectId"; this.hex = hex || (++oidSeq).toString(16).padStart(24, "0"); if (!/^[0-9a-f]{24}$/i.test(this.hex)) throw new Error("invalid ObjectId"); } toHexString() { return this.hex; } toString() { return this.hex; } equals(o) { return o && String(o) === this.hex; } }
  const same = (a, b) => (a && a._bsontype === "ObjectId" ? a.hex === String(b && b.hex != null ? b.hex : b) : a === b);
  const matches = (doc, filter) => Object.entries(filter || {}).every(([k, v]) => (v && typeof v === "object" && "$in" in v) ? v.$in.some((x) => same(doc[k], x)) : same(doc[k], v));
  const coll = (dbName, name) => { const key = dbName + "." + name; if (!st.dbs.has(key)) st.dbs.set(key, []); const docs = st.dbs.get(key);
    const cursor = (list) => { let s = 0, l = Infinity; const c = { sort() { return c; }, skip(n) { s = n; return c; }, limit(n) { l = n; return c; }, async toArray() { return list.slice(s, s + l); }, async close() { st.calls.push({ op: "cursorClose" }); }, [Symbol.asyncIterator]: async function* () { for (const d of list.slice(s, s + l)) yield d; } }; return c; };
    return {
      find(filter) { st.calls.push({ op: "find", name, filter }); return cursor(docs.filter((d) => matches(d, filter))); },
      aggregate(pipeline) { st.calls.push({ op: "aggregate", name, pipeline }); return cursor(docs); },
      async findOne(filter) { return docs.find((d) => matches(d, filter)) || null; },
      async countDocuments(filter) { return docs.filter((d) => matches(d, filter)).length; },
      async estimatedDocumentCount() { return docs.length; },
      async distinct(f) { return [...new Set(docs.map((d) => d[f]))]; },
      async insertOne(doc) { const d = { _id: doc._id || new ObjectId(), ...doc }; docs.push(d); st.calls.push({ op: "insertOne", name, doc: d }); return { insertedId: d._id }; },
      async insertMany(list) { for (const doc of list) docs.push({ _id: doc._id || new ObjectId(), ...doc }); st.calls.push({ op: "insertMany", name, n: list.length }); return { insertedCount: list.length }; },
      async updateOne(filter, update) { st.calls.push({ op: "updateOne", name, filter, update }); const d = docs.find((x) => matches(x, filter)); if (!d) return { matchedCount: 0, modifiedCount: 0 }; Object.assign(d, update.$set || {}); return { matchedCount: 1, modifiedCount: 1 }; },
      async updateMany(filter, update) { st.calls.push({ op: "updateMany", name, filter, update }); let n = 0; for (const d of docs) if (matches(d, filter)) { n++; Object.assign(d, update.$set || {}); for (const k of Object.keys(update.$unset || {})) delete d[k]; for (const [a, b] of Object.entries(update.$rename || {})) { d[b] = d[a]; delete d[a]; } } return { matchedCount: n, modifiedCount: n }; },
      async deleteMany(filter) { st.calls.push({ op: "deleteMany", name, filter }); const keep = docs.filter((d) => !matches(d, filter)); const n = docs.length - keep.length; docs.length = 0; docs.push(...keep); return { deletedCount: n }; },
      async deleteOne(filter) { const i = docs.findIndex((d) => matches(d, filter)); if (i >= 0) docs.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
      async indexes() { return [{ name: "_id_", key: { _id: 1 } }]; },
      async createIndex(spec, o) { st.calls.push({ op: "createIndex", name, spec, o }); return o.name; },
      async dropIndex(n) { st.calls.push({ op: "dropIndex", name, n }); },
      async drop() { st.calls.push({ op: "drop", name }); st.dbs.delete(key); },
    }; };
  class MongoClient extends EventEmitter {
    constructor(uri, o) { super(); this.uri = uri; this.o = o; this.closed = false; st.clients.push(this); }
    async connect() { return this; }
    async close() { this.closed = true; }
    db(name) { const dbName = name || "test"; return { command: async (c) => { st.calls.push({ op: "command", c }); return { ok: 1 }; }, collection: (n) => coll(dbName, n), listCollections: () => ({ toArray: async () => [...st.dbs.keys()].filter((k) => k.startsWith(dbName + ".")).map((k) => ({ name: k.slice(dbName.length + 1), type: "collection" })) }) }; }
  }
  st.mod = { MongoClient, ObjectId, Long: { fromString: (s) => ({ _bsontype: "Long", v: s, toString: () => s }) }, Decimal128: { fromString: (s) => ({ _bsontype: "Decimal128", toString: () => s }) }, Binary: class { constructor(b) { this._bsontype = "Binary"; this.buffer = b; this.sub_type = 0; } length() { return this.buffer.length; } }, BSON: { EJSON: { parse: (s) => JSON.parse(s) } } };
  st.ObjectId = ObjectId; st.seed = (dbName, name, docs) => { st.dbs.set(dbName + "." + name, docs.map((d) => ({ _id: new ObjectId(), ...d }))); };
  return st;
}
// ---- Redis: in-memory strings; every command is recorded as the exact argv ----
function mkRedis() {
  const st = { clients: [], commands: [], kv: new Map() };
  const mkClient = (url) => {
    const c = new EventEmitter();
    Object.assign(c, { url, open: false, async connect() { c.open = true; }, async ping() { return "PONG"; }, async quit() { c.open = false; }, async disconnect() { c.open = false; }, duplicate: () => mkClient(url),
      async dbSize() { return st.kv.size; }, async scan(cur, o) { const keys = [...st.kv.keys()].filter((k) => !o.MATCH || new RegExp("^" + o.MATCH.replace(/\*/g, ".*") + "$").test(k)); return { cursor: "0", keys }; },
      multi() { const ks = []; return { type(k) { ks.push(k); return this; }, async exec() { return ks.map(() => "string"); } }; },
      async sendCommand(argv) { st.commands.push(argv.slice()); const n = argv[0].toUpperCase(); if (n === "SET") { st.kv.set(argv[1], argv[2]); return "OK"; } if (n === "GET") return st.kv.has(argv[1]) ? st.kv.get(argv[1]) : null; if (n === "DEL" || n === "UNLINK") { let d = 0; for (const k of argv.slice(1)) if (st.kv.delete(k)) d++; return d; } if (n === "MGET") return argv.slice(1).map((k) => st.kv.get(k) ?? null); if (n === "PING") return "PONG"; if (n === "FLUSHDB") { st.kv.clear(); return "OK"; } return "OK"; } });
    st.clients.push(c); return c;
  };
  st.mod = { createClient: ({ url }) => mkClient(url) };
  return st;
}
const resetFakes = () => { fake.mysql = mkMysql(); fake.pg = mkPg(); fake.mssql = mkMssql(); fake.oracle = mkOracle(); fake.mongo = mkMongo(); fake.redis = mkRedis(); };
resetFakes();

const db = require("../src/main/db");
const io = require("../src/main/db-io");
const F = require("../src/main/db-formats");
const S = require("../src/main/sqlscript");
const STORE = path.join(USER, "db-connections.json");

/* ------------------------------ harness ------------------------------ */
let pass = 0, failN = 0; const failures = [];
function check(name, cond, extra) { if (cond) pass++; else { failN++; failures.push(name + (extra ? " — " + extra : "")); console.log("  FAIL " + name + (extra ? "  (" + extra + ")" : "")); } }
async function throws(name, fn, type) {
  try { await fn(); check(name, false, "did not throw"); return null; }
  catch (e) { const ok = !type || e.type === type || (type instanceof RegExp && (type.test(e.message) || type.test(e.type || ""))); check(name, ok, ok ? "" : `threw type=${e.type} msg=${e.message}`); return e; }
}
let uncaught = [];
process.on("uncaughtException", (e) => { uncaught.push(e); });
process.on("unhandledRejection", (e) => { uncaught.push(e); });
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT — a test never settled"); process.exit(3); }, 240000);
let n = 0;
const sqliteConn = async (name, extra = {}) => { const file = path.join(ROOT, `${name}-${++n}.db`); return db.save({ kind: "sqlite", name, file, createIfMissing: true, ...extra }); };
const raw = (id) => db.getConn(id);
const win = (id = 1) => ({ isDestroyed: () => false, webContents: { id, send: (_ch, p) => { progressLog.push(p); if (onProgress) onProgress(p); } } });
let progressLog = [], onProgress = null;
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeCsv = (name, rows) => { const p = path.join(ROOT, name); fs.writeFileSync(p, rows.map((r) => r.join(",")).join("\r\n") + "\r\n"); return p; };
dialogAnswers.save = (o) => ({ canceled: false, filePath: path.join(ROOT, `out-${++n}-${path.basename(o.defaultPath || "x.csv")}`) });

async function main() {
  console.log("fixtures:", ROOT);

  /* ================= DB-014 store atomicity (B01, B02) ================= */
  {
    fs.writeFileSync(STORE, "{ this is not json");
    await throws("B01 corrupt store: list() reports store-corrupt", () => db.list(), "store-corrupt");
    await throws("B01 corrupt store: save() refuses (no false success)", () => db.save({ kind: "sqlite", name: "x", file: ":memory:" }), "store-corrupt");
    check("B01 corrupt store file left untouched", fs.readFileSync(STORE, "utf8") === "{ this is not json");
    fs.unlinkSync(STORE);
    fs.mkdirSync(STORE);                                     // a read failure that is NOT "no file yet"
    await throws("B02 unreadable store is a typed store error, not an empty store", () => db.list(), "store");
    await throws("B02 save on unreadable store changes nothing", () => db.save({ kind: "sqlite", name: "x", file: ":memory:" }), "store");
    check("B02 nothing was written over the unreadable store", fs.statSync(STORE).isDirectory());
    fs.rmdirSync(STORE);
    const c = await db.save({ kind: "sqlite", name: "first", file: ":memory:" });
    check("B02 save writes versioned store + keeps a .bak on the next write", readJson(STORE).version === 2 && readJson(STORE).connections.length === 1);
    await db.save({ ...c, name: "first2" });
    check("B02 previous store kept as .bak", fs.existsSync(STORE + ".bak") && readJson(STORE + ".bak").connections[0].name === "first");
    check("B02 rev increments on save", db.list()[0].rev === 2);
    await throws("B06 stale rev save is rejected", () => db.save({ ...c, rev: 1, name: "late" }), "stale-connection");
    await db.remove(c.id);
    check("B02 remove persists", db.list().length === 0);
  }

  /* ================= DB-015 / DB-046 secrets (B03, B04, B05, B06) ================= */
  {
    const c = await db.save({ kind: "mysql", name: "m", host: "h", user: "u", password: "s3cret", database: "d" });
    const stored = readJson(STORE).connections[0];
    check("B03 password stored as an encryption envelope", stored.password && stored.password.$enc === 1 && typeof stored.password.data === "string");
    check("B03 no plaintext in the store file", !fs.readFileSync(STORE, "utf8").includes("s3cret"));
    const pub = db.list()[0];
    check("B06 list() exposes presence only, never the value", pub.hasPassword === true && !("password" in pub) && !("uri" in pub));
    check("B06 revealSecret returns the value on explicit request", db.revealSecret(c.id, "password").value === "s3cret");
    const before = fs.readFileSync(STORE, "utf8");
    secure.available = false;
    const e = await throws("B04 secure storage unavailable → save refuses to persist the secret", () => db.save({ ...c, name: "m2", password: "newpw" }), "secret-unavailable");
    check("B04 error carries a hint", !!(e && e.hint));
    check("B04 nothing written when the secret can't be sealed", fs.readFileSync(STORE, "utf8") === before);
    check("B04 kinds() reports secureStorage=false", db.kinds().every((k) => k.secureStorage === false));
    const s2 = await db.save({ ...c, name: "m2", password: "" });   // clearing is allowed without encryption
    db.setSessionSecret(s2.id, { password: "sessionpw" });
    check("B04 session-only secret is used for connecting", raw(s2.id).password === "sessionpw");
    check("B04 session-only secret visible as presence in list()", (db.list()[0].sessionSecret || []).includes("password"));
    check("B04 session secret never reaches the file", !fs.readFileSync(STORE, "utf8").includes("sessionpw"));
    check("B04 revealSecret flags the session origin", db.revealSecret(s2.id, "password").session === true);
    db.setSessionSecret(s2.id, { password: "" });
    secure.available = true;
    await db.remove(s2.id);
    // legacy plaintext → migrated only when sealing works; locked ciphertext is never destroyed
    fs.writeFileSync(STORE, JSON.stringify({ version: 2, connections: [{ id: "legacy1", kind: "mysql", name: "L", host: "h", user: "u", password: "plainpw", rev: 1 }] }));
    check("B05 legacy plaintext is flagged", db.list()[0].legacyPlaintext === true && db.list()[0].hasPassword === true);
    await db.save({ ...db.list()[0], password: { $keep: true } });
    const mig = readJson(STORE).connections[0];
    check("B05 $keep migrates legacy plaintext into an envelope", mig.password && mig.password.$enc === 1 && !fs.readFileSync(STORE, "utf8").includes("plainpw"));
    check("B05 migrated secret still decrypts", raw("legacy1").password === "plainpw");
    secure.key = 8;                                          // another OS account / machine
    check("B05 undecryptable secret is reported as locked, not blank", db.list()[0].secretLocked.password === true && db.list()[0].hasPassword === true);
    await throws("B05 connecting with a locked secret is a typed error", () => raw("legacy1"), "secret-locked");
    await throws("B05 reveal of a locked secret is a typed error", () => db.revealSecret("legacy1", "password"), "secret-locked");
    const cipher = readJson(STORE).connections[0].password.data;
    await db.save({ ...db.list()[0], name: "L2", password: { $keep: true } });
    check("B05 saving other fields keeps the locked ciphertext byte-for-byte", readJson(STORE).connections[0].password.data === cipher);
    secure.key = 7;
    check("B05 back on the original account the secret decrypts again", raw("legacy1").password === "plainpw");
    await db.remove("legacy1");
  }

  /* ================= DB-021 / DB-013 / DB-025 / DB-016 lifecycle & drivers (B07–B12) ================= */
  {
    resetFakes();
    const m = await db.save({ kind: "mysql", name: "pool", host: "h", user: "u", password: "p", database: "cold" });
    await Promise.all([1, 2, 3, 4, 5].map(() => db.query(m.id, "SELECT 1")));
    check("B08 five concurrent cold queries open ONE pool", fake.mysql.pools.filter((p) => p.cfg.database === "cold").length === 1);
    const r = await db.test({ kind: "mysql", host: "h", user: "u", password: "p", database: "probe" });
    const probe = fake.mysql.pools.find((p) => p.cfg.database === "probe");
    check("B09 unsaved test uses a throw-away handle that is closed", r.ok && probe && probe.ended === true);
    check("B09 the throw-away handle is never cached", ![...db.__internals.live.keys()].some((k) => k.startsWith("__test__")));
    // disconnect while opening → the late handle is closed, never cached
    const gate = defer();
    fake.mysql.rules.push({ re: /SELECT 1/, fn: (sql, v, connId) => (fake.mysql.pools.at(-1).cfg.database === "slow" && connId === 0 && !gate.done ? gate.promise : { rows: [[1]], fields: [{ name: "1" }] }) });
    const slow = await db.save({ kind: "mysql", name: "slow", host: "h", user: "u", password: "p", database: "slow" });
    const pending = db.query(slow.id, "SELECT 2");
    await tick();
    await db.disconnect(slow.id);
    gate.done = true; gate.resolve({ rows: [[1]], fields: [{ name: "1" }] });
    const late = await throws("B10 open cancelled by a disconnect is a typed error", () => pending, "cancelled");
    await tick();
    check("B10 the late handle was closed and not cached", !!late && fake.mysql.pools.find((p) => p.cfg.database === "slow").ended === true && !db.__internals.live.has(slow.id));
    // pg: idle-client errors are events; the handle is marked broken and replaced on the next call
    uncaught = [];
    const pgc = await db.save({ kind: "postgres", name: "pg", host: "h", user: "u", password: "p", database: "pgdb" });
    await db.query(pgc.id, "SELECT 1");
    fake.pg.pools[0].emit("error", new Error("terminating connection due to administrator command"));
    await tick();
    check("B11 idle pool error does not crash main", uncaught.length === 0);
    check("B11 idle pool error marks the handle broken", db.__internals.live.get(pgc.id).entry.broken === true);
    const again = await db.query(pgc.id, "SELECT 1");
    check("B11 next call re-opens on a fresh pool and succeeds", again.rows.length === 1 && fake.pg.pools.length === 2);
    // oracle: Test connection goes through pool.getConnection (not a non-existent pool.execute)
    const ot = await db.test({ kind: "oracle", host: "h", port: 1521, user: "u", password: "p", database: "XE" });
    check("B12 Oracle test uses pool.getConnection and succeeds", ot.ok === true && fake.oracle.pools[0].getConnectionCalls >= 1 && fake.oracle.pools[0].closed === true);
    // TLS: the selected mode is what the driver receives
    const ca = path.join(ROOT, "ca.pem"); fs.writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    for (const [mode, cfgCheck] of [["verify", (s) => s && s.rejectUnauthorized === true], ["insecure", (s) => s && s.rejectUnauthorized === false]]) {
      const tls = await db.save({ kind: "mysql", name: "tls-" + mode, host: "h", user: "u", password: "p", database: "tls-" + mode, ssl: true, sslMode: mode, sslCa: ca });
      await db.query(tls.id, "SELECT 1");
      const cfg = fake.mysql.pools.find((p) => p.cfg.database === "tls-" + mode).cfg;
      check(`B07 mysql sslMode=${mode} → rejectUnauthorized=${mode === "verify"} and CA loaded`, cfgCheck(cfg.ssl) && /BEGIN CERTIFICATE/.test(cfg.ssl.ca));
    }
    const plain = await db.save({ kind: "mysql", name: "plain", host: "h", user: "u", password: "p", database: "plain", ssl: false });
    await db.query(plain.id, "SELECT 1");
    check("B07 ssl off → no ssl option at all", !("ssl" in fake.mysql.pools.find((p) => p.cfg.database === "plain").cfg));
    const ms = await db.save({ kind: "mssql", name: "ms", host: "h", user: "u", password: "p", database: "msdb", ssl: true, sslMode: "verify" });
    await db.query(ms.id, "SELECT 1");
    check("B07 mssql verify → encrypt=true, trustServerCertificate=false", fake.mssql.pools[0].cfg.options.encrypt === true && fake.mssql.pools[0].cfg.options.trustServerCertificate === false);
    const badCa = await db.test({ kind: "mysql", host: "h", user: "u", password: "p", database: "x", ssl: true, sslMode: "verify", sslCa: path.join(ROOT, "missing.pem") });
    check("B07 missing CA file is a typed invalid error, not a silent downgrade", badCa.ok === false && badCa.type === "invalid");
    // driver missing vs broken are distinct, and installed state is real
    fake.brokenPg = true;
    const broken = await db.test({ kind: "postgres", host: "h", user: "u", password: "p", database: "x" });
    check("DB-047 driver that fails to load reports driver-broken with a rebuild hint", broken.ok === false && broken.type === "driver-broken" && /electron-rebuild/.test(broken.hint || ""));
    fake.brokenPg = false;
    check("DB-047 kinds() reports installed drivers", db.kinds().find((k) => k.id === "sqlite").installed === true);
    for (const c of db.list()) await db.remove(c.id);
  }

  /* ================= DB-002 / DB-003 sessions & retry classification (B13, B14, B49) ================= */
  {
    resetFakes();
    const m = await db.save({ kind: "mysql", name: "sess", host: "h", user: "u", password: "p", database: "sess" });
    const a = await db.sessionOpen(m.id), b = await db.sessionOpen(m.id);
    await db.query(m.id, "SET @x = 1", { session: a.session });
    await db.query(m.id, "START TRANSACTION", { session: a.session });
    await db.query(m.id, "UPDATE t SET v = 1", { session: a.session });
    await db.query(m.id, "SELECT 1", { session: b.session });
    const qa = fake.mysql.queries.filter((q) => /SET @x|START TRANSACTION|UPDATE t/.test(q.sql)).map((q) => q.connId);
    const qb = fake.mysql.queries.filter((q) => /_atomnano_preview/.test(q.sql) && q.connId).map((q) => q.connId);
    check("B14 a tab's statements all run on ITS pinned connection", qa.length === 3 && new Set(qa).size === 1 && qa[0] !== 0);
    check("B14 another tab uses a different pinned connection", qb.length === 1 && qb[0] !== qa[0]);
    check("B14 transaction state is tracked per session", db.sessionState(a.session).inTx === true && db.sessionState(b.session).inTx === false);
    const pinned = fake.mysql.conns.find((c) => c.id === qa[0]);
    await db.sessionClose(a.session, { rollback: true });
    check("B49 closing a session with an open transaction rolls it back and releases the client", pinned.tx.includes("rollback") && pinned.released === true);
    await throws("B49 a closed session is a typed session-gone error", () => db.query(m.id, "SELECT 1", { session: a.session }), "session-gone");
    await throws("B49 a session cannot be used on another connection", async () => { const other = await db.save({ kind: "mysql", name: "o", host: "h", user: "u", password: "p", database: "o" }); try { await db.query(other.id, "SELECT 1", { session: b.session }); } finally { await db.remove(other.id); } }, "invalid");
    await db.sessionClose(b.session);
    // transport failure during a write → outcome-unknown, sent exactly once; a read retries once
    fake.mysql.rules.push({ re: /UPDATE t SET boom/, fn: () => { throw new Error("read ECONNRESET"); } });
    let flaky = 0; fake.mysql.rules.push({ re: /SELECT flaky/, fn: () => { if (flaky++ === 0) throw new Error("Connection lost: The server closed the connection."); return { rows: [[42]], fields: [{ name: "v" }] }; } });
    const e = await throws("B13 transport failure during a write is outcome-unknown", () => db.query(m.id, "UPDATE t SET boom = 1"), "outcome-unknown");
    check("B13 the write was sent exactly once (no replay)", fake.mysql.queries.filter((q) => /UPDATE t SET boom/.test(q.sql)).length === 1 && /UNKNOWN/.test(e.message));
    await db.query(m.id, "SELECT 1");                        // warm the (re-opened) pool first
    const poolsBefore = fake.mysql.pools.length;
    const rr = await db.query(m.id, "SELECT flaky FROM t");
    check("B13 a read retries once on a fresh handle", rr.rows[0][0] === 42 && fake.mysql.queries.filter((q) => /SELECT flaky/.test(q.sql)).length === 2 && fake.mysql.pools.length === poolsBefore + 1);
    const s3 = await db.sessionOpen(m.id);
    await db.query(m.id, "START TRANSACTION", { session: s3.session });
    fake.mysql.rules.push({ re: /SELECT intx/, fn: () => { throw new Error("read ECONNRESET"); } });
    await throws("B13 a read INSIDE a transaction is not retried (outcome-unknown)", () => db.query(m.id, "SELECT intx FROM t", { session: s3.session }), "outcome-unknown");
    check("B13 the session survives with its transaction reported LOST (not silently replaced)", db.sessionState(s3.session) !== null && db.sessionState(s3.session).inTx === false && db.sessionState(s3.session).lostTx === true);
    const afterLoss = await db.query(m.id, "SELECT 1", { session: s3.session });
    check("B13 the same session re-pins on the new handle and clears lostTx", afterLoss.session.session === s3.session && afterLoss.session.lostTx === false);
    await db.sessionClose(s3.session);
    // cancel protocol
    const gate = defer();
    fake.mysql.rules.push({ re: /SELECT SLEEP/, fn: () => gate.promise });
    const long = db.query(m.id, "SELECT SLEEP(10)", { opId: "op-1" });
    await tick(5);
    const c1 = await db.cancel("op-1");
    check("DB-039 cancel reaches the engine (KILL QUERY on the right thread)", c1.ok === true && fake.mysql.queries.some((q) => /KILL QUERY/.test(q.sql) && q.values && q.values[0] >= 1000));
    gate.resolve({ rows: [], fields: [] }); await long;
    check("DB-039 cancel of an unknown op is not-running", (await db.cancel("nope")).ok === false && (await db.cancel("nope")).reason === "not-running");
    await db.remove(m.id);
    // sqlite: real session transaction + rollback on close
    const s = await sqliteConn("sess");
    await db.query(s.id, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const sid = (await db.sessionOpen(s.id)).session;
    const b1 = await db.query(s.id, "BEGIN", { session: sid });
    await db.query(s.id, "INSERT INTO t (v) VALUES ('x')", { session: sid });
    check("B14 sqlite BEGIN reports inTx on the session", b1.session.inTx === true && db.sessionState(sid).inTx === true);
    await db.sessionClose(sid, { rollback: true });
    check("B49 sqlite session close rolls the open transaction back", (await db.count(s.id, "t")).count === 0);
    await db.remove(s.id);
  }

  /* ================= DB-004 / DB-005 / DB-030 row identity & bound values (B19, B20, B21) ================= */
  {
    const s = await sqliteConn("ident");
    await db.query(s.id, "CREATE TABLE c (a INTEGER, b INTEGER, v TEXT, PRIMARY KEY (a, b))");
    await db.query(s.id, "INSERT INTO c VALUES (1, 1, 'one'), (1, 2, 'two')");
    await db.query(s.id, "CREATE TABLE nopk (v TEXT)"); await db.query(s.id, "INSERT INTO nopk VALUES ('x'), ('x')");
    await db.query(s.id, "CREATE TABLE tk (k TEXT PRIMARY KEY, v TEXT)"); await db.query(s.id, "INSERT INTO tk VALUES (NULL, 'n1'), (NULL, 'n2'), ('k', 'kv')");
    await throws("B19 incomplete composite key is rejected", () => db.updateRows(s.id, "c", { pk: { a: 1 }, set: { v: "z" } }), "identity");
    await throws("B19 extra key column is rejected", () => db.updateRows(s.id, "c", { pk: { a: 1, b: 1, v: "one" }, set: { v: "z" } }), "identity");
    await throws("B19 NULL key value is rejected", () => db.updateRows(s.id, "tk", { pk: { k: null }, set: { v: "z" } }), "identity");
    await throws("B19 table without a primary key cannot be edited", () => db.updateRows(s.id, "nopk", { pk: { v: "x" }, set: { v: "y" } }), "identity");
    await throws("B19 expression in a key is rejected", () => db.updateRows(s.id, "c", { pk: { a: { raw: "1" }, b: 1 }, set: { v: "z" } }), "identity");
    check("B19 nothing changed by the rejected attempts", (await db.query(s.id, "SELECT v FROM c ORDER BY b")).rows.map((r) => r[0]).join() === "one,two" && (await db.count(s.id, "tk", "v = 'z'")).count === 0);
    const u = await db.updateRows(s.id, "c", { pk: { a: 1, b: 2 }, set: { v: "O'Brien; DROP TABLE c; --" } });
    check("B30 values are bound, not interpolated (quotes/semicolons stored literally)", u.affected === 1 && (await db.query(s.id, "SELECT v FROM c WHERE b = 2")).rows[0][0] === "O'Brien; DROP TABLE c; --");
    check("B30 update returns the persisted row", u.row && u.row.columns.join() === "a,b,v" && u.row.values[2] === "O'Brien; DROP TABLE c; --");
    await throws("B30 unsafe raw expression is rejected", () => db.updateRows(s.id, "c", { pk: { a: 1, b: 2 }, set: { v: { raw: "1; DROP TABLE c" } } }), "invalid");
    const ins = await db.insertRow(s.id, "c", { a: 2, b: 1, v: { raw: "upper('ok')" } });
    check("B30 insert with a validated raw expression and persisted row re-read", ins.affected === 1 && ins.row && ins.row.values[2] === "OK");
    await throws("B20 delete of a vanished row is not-found and nothing else is deleted", async () => db.deleteRows(s.id, "c", [{ a: 1, b: 1 }, { a: 9, b: 9 }]), "not-found");
    check("B20 delete rolled back as a whole", (await db.count(s.id, "c")).count === 3);
    // ambiguous key at the server (fake mysql: COUNT(*) says 2) → identity error, UPDATE never sent
    resetFakes();
    const m = await db.save({ kind: "mysql", name: "amb", host: "h", user: "u", password: "p", database: "amb" });
    fake.mysql.rules.push({ re: /information_schema\.columns/i, fn: () => ({ objects: [{ name: "id", type: "int", nullable: "NO", dflt: null, ckey: "PRI", extra: "", comment: "", gen: null, coll: null }, { name: "v", type: "text", nullable: "YES", dflt: null, ckey: "", extra: "", comment: "", gen: null, coll: null }], fields: [] }) });
    fake.mysql.rules.push({ re: /SELECT COUNT\(\*\)/i, fn: () => ({ rows: [[2]], fields: [{ name: "COUNT(*)" }] }) });
    await throws("B20 server-side ambiguous identity (2 rows) is rejected", () => db.updateRows(m.id, "t", { pk: { id: 1 }, set: { v: "x" } }), "identity");
    check("B20 no UPDATE reached the server and the transaction rolled back", !fake.mysql.queries.some((q) => /^UPDATE/i.test(q.sql)) && fake.mysql.conns.some((c) => c.tx.includes("rollback")));
    await db.remove(m.id);
    // 64-bit keys
    await db.query(s.id, "CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)");
    await db.query(s.id, "INSERT INTO big VALUES (9007199254740993, 'a'), (9007199254740992, 'b'), (5, 'small')");
    const br = await db.browse(s.id, "big", { limit: 10 });
    const bigCell = br.rows.find((r) => r[1] === "a")[0];
    check("B21 keys above 2^53 arrive as exact bigint tags", bigCell && bigCell.$t === "bigint" && bigCell.v === "9007199254740993" && br.rows.find((r) => r[1] === "small")[0] === 5);
    const up = await db.updateRows(s.id, "big", { pk: { id: bigCell }, set: { v: "A!" } });
    const after = await db.query(s.id, "SELECT id, v FROM big ORDER BY id");
    check("B21 the exact row is updated and its neighbour untouched", up.affected === 1 && after.rows.find((r) => r[1] === "A!")[0].v === "9007199254740993" && after.rows.some((r) => r[1] === "b"));
    check("B21 persisted row keeps the tagged key", up.row.values[0].$t === "bigint" && up.row.values[0].v === "9007199254740993");
    await db.remove(s.id);
  }

  /* ================= DB-006 / DB-007 / DB-051 policies (B15–B18, B30) ================= */
  {
    const p0 = await sqliteConn("policy");
    await db.query(p0.id, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.query(p0.id, "CREATE TABLE secret (id INTEGER PRIMARY KEY)");
    const p = await db.save({ ...p0, policy: { blockDrop: true, protectedTables: ["secret"] } });   // protections switched on afterwards
    await throws("B15 DDL on a protected table is blocked once protected", () => db.query(p.id, "CREATE INDEX ix_s ON secret (id)"), /protected/);
    await throws("B15 protected table via quoted identifier", () => db.query(p.id, 'update "secret" set id = 2 where id = 1'), /protected/);
    await throws("B15 protected table in a subquery-driven write", () => db.query(p.id, "DELETE FROM secret WHERE id IN (SELECT id FROM t)"), /protected/);
    await throws("B15 protected table via INSERT … SELECT", () => db.query(p.id, "INSERT INTO secret (id) SELECT id FROM t"), /protected/);
    check("B15 protected tables stay readable", (await db.query(p.id, 'SELECT * FROM "secret"')).columns.length === 1);
    check("B15 writes to other tables pass without blockWrite", (await db.query(p.id, "INSERT INTO t (v) VALUES ('ok')")).affected === 1);
    for (const [label, sql] of [["DROP with comment and newlines", "drop /* x */\n table\n if exists t"], ["DROP INDEX", "DROP INDEX IF EXISTS ix"]]) await throws(`B15 blockDrop stops ${label}`, () => db.query(p.id, sql), "policy");
    const pw = await db.save({ ...db.list().find((c) => c.id === p.id), policy: { blockWrite: true, blockDrop: true, protectedTables: ["secret"] } });
    for (const [label, sql] of [["comment-prefixed INSERT", "/* hi */ INSERT INTO t (v) VALUES ('x')"], ["writable CTE", "WITH x AS (SELECT 1) DELETE FROM t"], ["lower-case update with newline", "update\n t set v = 'y'"], ["REPLACE", "REPLACE INTO t (id, v) VALUES (1, 'z')"], ["INSERT … RETURNING", "INSERT INTO t (v) VALUES ('r') RETURNING id"]]) await throws(`B15 blockWrite stops ${label}`, () => db.query(pw.id, sql), "policy");
    check("B15 reads on unprotected tables pass", (await db.query(pw.id, "SELECT * FROM (SELECT * FROM t)")).columns.length === 2);
    check("B15 PRAGMA table_info is a read, not admin", (await db.query(p.id, "PRAGMA table_info(t)")).rows.length === 2);
    check("B15 structured insert is blocked too", (await throws("B17 insertRow blocked by blockWrite", () => db.insertRow(p.id, "t", { v: "x" }), "policy")) !== null);
    await throws("B17 import into a protected table is blocked", async () => { const f = writeCsv("pol.csv", [["id"], ["1"]]); const pick = await io.importPick(win(), { id: p.id, table: { schema: "", table: "secret", name: "secret" }, file: f }); await io.importRun(win(), { token: pick.token, id: p.id, table: { schema: "", table: "secret", name: "secret" }, mapping: { 0: "id" }, hasHeader: true }); }, "policy");
    await db.remove(p.id);
    // DDL policy
    const d = await sqliteConn("ddlpol", { policy: { blockDDL: true } });
    await throws("B15 blockDDL stops CREATE", () => db.query(d.id, "CREATE TABLE z (a)"), "policy");
    await throws("B15 blockDDL stops PRAGMA assignment (admin)", () => db.query(d.id, "PRAGMA journal_mode = WAL"), "policy");
    check("B15 blockDDL still allows SELECT", (await db.query(d.id, "SELECT 1")).rows.length === 1);
    await db.remove(d.id);
    // Mongo
    resetFakes();
    fake.mongo.seed("app", "users", [{ n: "a" }, { n: "b" }]);
    const mg = await db.save({ kind: "mongodb", name: "mg", uri: "mongodb://fake", database: "app", policy: { blockWrite: true, blockDrop: true, protectedTables: ["audit"] } });
    await throws("B16 $out aggregation is a write", () => db.query(mg.id, JSON.stringify({ collection: "users", op: "aggregate", pipeline: [{ $match: {} }, { $out: "copy" }] })), "policy");
    await throws("B16 insertOne blocked", () => db.query(mg.id, JSON.stringify({ collection: "users", op: "insertOne", doc: { n: "c" } })), "policy");
    await throws("B16 collection drop blocked", () => db.query(mg.id, JSON.stringify({ collection: "users", op: "drop" })), "policy");
    await throws("B16 raw drop command blocked", () => db.query(mg.id, JSON.stringify({ drop: "users" })), "policy");
    await throws("B16 unknown op cannot bypass protections", () => db.query(mg.id, JSON.stringify({ collection: "audit", op: "renameCollection" })), "policy");
    await throws("B16 protected collection write blocked", () => db.query(mg.id, JSON.stringify({ collection: "audit", op: "updateMany", filter: {}, update: { $set: { x: 1 } } })), "policy");
    check("B16 reads pass", (await db.query(mg.id, JSON.stringify({ collection: "users", op: "find", filter: {} }))).rows.length === 2);
    await throws("B17 structured Mongo delete blocked", () => db.deleteRows(mg.id, "users", [{ _id: { $t: "oid", v: "0".repeat(23) + "1" } }]), "policy");
    check("B17 no write reached the fake", !fake.mongo.calls.some((c) => /insert|update|delete|drop|aggregate/.test(c.op)));
    await db.remove(mg.id);
    // Redis
    const rd = await db.save({ kind: "redis", name: "rd", uri: "redis://fake", policy: { blockDrop: true, protectedTables: ["config:main"] } });
    await throws("B18 DEL blocked by blockDrop", () => db.query(rd.id, "DEL k"), "policy");
    await throws("B18 UNLINK blocked by blockDrop", () => db.query(rd.id, "UNLINK k"), "policy");
    await throws("B18 FLUSHDB blocked by blockDrop", () => db.query(rd.id, "FLUSHDB"), "policy");
    await throws("B18 protected key write blocked", () => db.query(rd.id, "SET config:main x"), /protected/);
    await throws("B18 EVAL blocked while protections exist", () => db.query(rd.id, "EVAL \"return 1\" 0"), "policy");
    check("B18 read of a protected key allowed", (await db.query(rd.id, "MGET config:main other")).rows.length === 2);
    check("B18 write to another key allowed", (await db.query(rd.id, "SET other 1")).rows[0][0] === "OK");
    await db.remove(rd.id);
    const rd2 = await db.save({ kind: "redis", name: "rd2", uri: "redis://fake", policy: { protectedTables: ["b"] } });
    fake.redis.commands.length = 0;
    await db.query(rd2.id, 'SET "my key" v1');
    await db.query(rd2.id, 'DEL "my key"');
    check("B30 a quoted key is ONE argument", fake.redis.commands.some((a) => a.join("|") === "DEL|my key") && fake.redis.commands.some((a) => a.join("|") === "SET|my key|v1"));
    await db.query(rd2.id, "", { argv: ["SET", "a b", "x y"] });
    check("B30 structured argv travels verbatim", fake.redis.commands.at(-1).join("|") === "SET|a b|x y");
    await throws("B30 DEL over several keys is checked per key (protected b)", () => db.query(rd2.id, "DEL a b"), /protected/);
    await throws("B30 unterminated quote is rejected, not guessed", () => db.query(rd2.id, 'DEL "open'), "invalid");
    check("B30 splitCmd: '' escapes and \\x hex", db.splitCmd("SET 'it''s' \"\\x41\\n\"").join("|") === "SET|it's|A\n");
    check("B30 redisQuote round-trips", db.splitCmd(`DEL ${db.redisQuote('we"ird key')}`)[1] === 'we"ird key');
    await db.remove(rd2.id);
  }

  /* ================= DB-017 / DB-026–029 / DB-043 typed values & result shape (B22–B29, B31, B43) ================= */
  {
    const s = await sqliteConn("typed");
    const dup = await db.query(s.id, "SELECT 1 AS a, 2 AS a, 'x' AS b");
    check("B22 duplicate column names are kept positionally", dup.columns.join() === "a,a,b" && dup.rows[0].join() === "1,2,x");
    await db.query(s.id, "CREATE TABLE b (id INTEGER PRIMARY KEY, blob BLOB, big INTEGER, d TEXT)");
    const bytes = Buffer.alloc(100, 7);
    await db.query(s.id, "INSERT INTO b (blob, big) VALUES (?, ?)", { params: [{ $t: "bytes", len: 100, b64: bytes.toString("base64") }, { $t: "bigint", v: "18446744073709551" }] });
    const one = await db.query(s.id, "SELECT blob, big FROM b");
    check("B23 100-byte blob is a lossless bytes tag (no display marker)", one.rows[0][0].$t === "bytes" && one.rows[0][0].len === 100 && Buffer.from(one.rows[0][0].b64, "base64").equals(bytes));
    check("B23 bigint beyond 2^53 is an exact tag", one.rows[0][1].$t === "bigint" && one.rows[0][1].v === "18446744073709551");
    for (let i = 0; i < 3000; i++) await db.query(s.id, "INSERT INTO b (blob, big) VALUES (X'0102030405', 9007199254740993)");
    const many = await db.query(s.id, "SELECT blob, big FROM b", { limit: 5000 });
    check("B24/B29 3001 rows keep every tag intact (no size-dependent representation)", many.rows.length === 3001 && many.rows.every((r) => r[0].$t === "bytes") && many.rows.slice(1).every((r) => r[1].$t === "bigint" && r[1].v === "9007199254740993"));
    const lim = await db.query(s.id, "SELECT id FROM b", { limit: 3000 });
    check("B26 preview limit reports hasMore instead of hiding rows", lim.rows.length === 3000 && lim.hasMore === true && lim.truncated === true);
    check("B27 sqlite never rewrites the SQL", lim.effectiveSql === undefined);
    check("B25 PRAGMA returns rows (dispatch by prepared statement, not keyword)", (await db.query(s.id, "PRAGMA table_info(b)")).rows.length === 4);
    const cte = await db.query(s.id, "WITH src AS (SELECT 'c' AS d) INSERT INTO b (d) SELECT d FROM src");
    check("B25 CTE INSERT is a write with an affected count", cte.op === "write" && cte.affected === 1 && cte.rows.length === 0);
    const ret = await db.query(s.id, "INSERT INTO b (d) VALUES ('r') RETURNING id, d");
    check("B25 INSERT … RETURNING returns its rows", ret.columns.join() === "id,d" && ret.rows[0][1] === "r");
    check("B28 cell(): Date → date tag, Buffer → bytes, BigInt safe → number", db.cell(new Date("2024-01-02T03:04:05Z")).v === "2024-01-02T03:04:05.000Z" && db.cell(Buffer.from([1, 2])).$t === "bytes" && db.cell(BigInt(5)) === 5 && db.cell(BigInt("9007199254740993")).$t === "bigint");
    check("B28 cellText/bytes hex", db.cellText({ $t: "bytes", len: 2, b64: Buffer.from([0xab, 0xcd]).toString("base64") }) === "0xabcd");
    check("B28 sqlLiteral bytes per dialect", db.sqlLiteral("sqlite", db.cell(Buffer.from([1, 2]))) === "X'0102'" && db.sqlLiteral("postgres", db.cell(Buffer.from([1, 2]))) === "'\\x0102'::bytea" && db.sqlLiteral("mysql", db.cell(Buffer.from([1, 2]))) === "0x0102");
    check("B28 bindValue keeps bigint exact per engine", db.bindValue("sqlite", { $t: "bigint", v: "9007199254740993" }) === 9007199254740993n && db.bindValue("postgres", { $t: "bigint", v: "9007199254740993" }) === "9007199254740993");
    // object identity
    check("B43 structured ref keeps a dotted table name", db.objIdent("postgres", { schema: "s", table: "a.b" }).table === "a.b" && db.qualify("postgres", { schema: "s", table: "a.b" }) === '"s"."a.b"');
    check("B43 string ref splits on the FIRST dot only", db.objIdent("postgres", "s.a.b").schema === "s" && db.objIdent("postgres", "s.a.b").table === "a.b");
    check("B43 engines without schemas never split", db.objIdent("sqlite", "a.b").table === "a.b" && db.objIdent("sqlite", "a.b").schema === "");
    check("B43 quoting escapes embedded quotes", db.quoteIdent("mysql", "we`ird") === "`we``ird`" && db.quoteIdent("mssql", "a]b") === "[a]]b]" && db.quoteIdent("postgres", 'we"ird') === '"we""ird"');
    check("B43 trailing spaces in identifiers are preserved", db.quoteIdent("postgres", "x ") === '"x "');
    await throws("DB-045 control characters in identifiers are rejected", () => db.quoteIdent("sqlite", "a\u0000b"), "invalid");
    await throws("DB-045 filters with statement separators are rejected", () => db.count(s.id, "b", "1=1; DROP TABLE b"), "invalid");
    await db.query(s.id, 'CREATE TABLE "dot.ted" (id INTEGER PRIMARY KEY, v TEXT)');
    check("B31 sqlite table with a dot in its name is addressable", (await db.columns(s.id, { schema: "", table: "dot.ted" })).length === 2);
    const info = await db.tableInfo(s.id, "b");
    check("B31 tableInfo returns native DDL and the object identity", info.ddlNative === true && /CREATE TABLE b/.test(info.ddl) && info.object.table === "b");
    // browse: stable order, hasMore, no estimate as total
    const pg1 = await db.browse(s.id, "b", { limit: 100, offset: 0 });
    check("DB-032 browse orders by the primary key and reports hasMore", /ORDER BY "id"/.test(pg1.sql) && pg1.stable === true && pg1.hasMore === true && pg1.rows.length === 100 && pg1.total === null && pg1.pk.join() === "id");
    const pgc = await db.browse(s.id, "b", { limit: 100, offset: 3000, count: true });
    check("DB-032 total is only an exact count on request", pgc.total === 3003 && pgc.hasMore === false && pgc.rows.length === 3);
    await db.query(s.id, "CREATE TABLE nk (v TEXT)"); await db.query(s.id, "INSERT INTO nk VALUES ('a'), ('b')");
    const nk = await db.browse(s.id, "nk", { limit: 10 });
    check("DB-032 no primary key → row locator order, pk reported empty", /ORDER BY rowid/.test(nk.sql) && nk.pk.length === 0 && nk.stable === true);
    const ob = await db.browse(s.id, "b", { limit: 5, orderBy: "d", dir: "desc" });
    check("DB-032 sort column then key as tie-breaker", /ORDER BY "d" DESC, "id"/.test(ob.sql));
    check("DB-039 explain runs on sqlite", (await db.explain(s.id, "SELECT * FROM b WHERE id = 1")).rows.length >= 1);
    await db.remove(s.id);
    // mysql: preview wrap is disclosed; non-wrappable statements are sent verbatim
    resetFakes();
    const m = await db.save({ kind: "mysql", name: "wrap", host: "h", user: "u", password: "p", database: "wrap" });
    fake.mysql.rules.push({ re: /_atomnano_preview/, fn: () => ({ rows: [[1], [2], [3], [4]], fields: [{ name: "id" }] }) });
    fake.mysql.rules.push({ re: /FOR UPDATE|INTO OUTFILE|SELECT \* FROM t2/, fn: (sql) => ({ rows: [[1], [2], [3], [4], [5]], fields: [{ name: "id" }] }) });
    const w = await db.query(m.id, "SELECT * FROM t;", { limit: 3 });
    check("B27 mysql preview wraps as a derived table and discloses it", w.rows.length === 3 && w.hasMore === true && /^SELECT \* FROM \(SELECT \* FROM t\) AS `_atomnano_preview` LIMIT 4$/.test(w.effectiveSql));
    const fu = await db.query(m.id, "SELECT * FROM t FOR UPDATE", { limit: 3 });
    check("B27 FOR UPDATE is sent verbatim (no rewrite) and sliced client-side", fake.mysql.queries.some((q) => q.sql === "SELECT * FROM t FOR UPDATE") && fu.rows.length === 3 && fu.hasMore === true && fu.effectiveSql === undefined);
    await db.query(m.id, "SELECT * FROM t2 WHERE v = ?", { params: ["x"], limit: 2 });
    check("B27 parameterised statements are never wrapped", fake.mysql.queries.some((q) => q.sql === "SELECT * FROM t2 WHERE v = ?" && q.values[0] === "x"));
    await db.remove(m.id);
    // pg: multiple result sets
    const pgc2 = await db.save({ kind: "postgres", name: "sets", host: "h", user: "u", password: "p", database: "sets" });
    fake.pg.rules.push({ re: /SELECT 1; SELECT 2/, fn: () => [{ rows: [[1]], fields: [{ name: "a" }], command: "SELECT", rowCount: 1 }, { rows: [[2], [3]], fields: [{ name: "b" }], command: "SELECT", rowCount: 2 }] });
    const sets = await db.query(pgc2.id, "SELECT 1; SELECT 2");
    check("B22 every result set is returned", sets.sets && sets.sets.length === 2 && sets.sets[1].rows.length === 2 && sets.columns.join() === "a");
    await db.remove(pgc2.id);
    // mssql: stream and stop — no TOP injected
    const ms = await db.save({ kind: "mssql", name: "ms", host: "h", user: "u", password: "p", database: "ms" });
    fake.mssql.rules.push({ re: /FROM big/, fn: () => { const rs = [[1], [2], [3], [4], [5]]; rs.columns = [{ name: "id" }]; return { recordsets: [rs], rowsAffected: [5] }; } });
    const st = await db.query(ms.id, "SELECT id FROM big", { limit: 2 });
    check("B27 mssql streams and stops after limit+1 without rewriting SQL", st.rows.length === 2 && st.hasMore === true && fake.mssql.requests.some((r) => r.sql === "SELECT id FROM big" && r.stream === true));
    await db.remove(ms.id);
    // oracle: no injected hint, session autocommit visible, LOBs fetched as content
    const o = await db.save({ kind: "oracle", name: "ora", host: "h", user: "u", password: "p", database: "XE" });
    fake.oracle.rules.push({ re: /FROM emp/, fn: (sql, b, opts) => ({ metaData: [{ name: "A" }], resultSet: { getRows: async (k) => [[1], [2]].slice(0, k), close: async () => {} } }) });
    const oq = await db.query(o.id, "SELECT * FROM emp", { limit: 5 });
    const sent = fake.oracle.execs.find((x) => /FROM emp/.test(x.sql));
    check("DB-oracle no PARALLEL hint is injected; result set is used", oq.rows.length === 2 && sent.sql === "SELECT * FROM emp" && sent.opts.resultSet === true);
    check("B31 CLOB/BLOB are fetched as content (fetchTypeHandler)", sent.opts.fetchTypeHandler({ dbType: fake.oracle.mod.DB_TYPE_CLOB }).type === fake.oracle.mod.STRING && sent.opts.fetchTypeHandler({ dbType: fake.oracle.mod.DB_TYPE_BLOB }).type === fake.oracle.mod.BUFFER);
    const osid = (await db.sessionOpen(o.id)).session;
    await db.sessionSet(osid, { autocommit: false });
    const ou = await db.query(o.id, "UPDATE emp SET x = 1", { session: osid });
    const upd = fake.oracle.execs.find((x) => /UPDATE emp/.test(x.sql));
    check("DB-oracle autocommit off is honoured and visible", upd.opts.autoCommit === false && ou.session.inTx === true && /uncommitted/.test(ou.message));
    const oc = await db.query(o.id, "COMMIT", { session: osid });
    check("DB-oracle COMMIT maps to the driver and clears inTx", oc.session.inTx === false && fake.oracle.conns.some((c) => c.log.includes("commit")));
    await db.sessionClose(osid);
    const auto = await db.query(o.id, "UPDATE emp SET y = 2");
    check("DB-oracle statement outside a session autocommits", fake.oracle.execs.find((x) => /SET y = 2/.test(x.sql)).opts.autoCommit === true && !/uncommitted/.test(auto.message));
    await db.remove(o.id);
    // mongo: typed identity travels as ObjectId
    fake.mongo.seed("app", "u", [{ n: "a" }, { n: "b" }]);
    const mg = await db.save({ kind: "mongodb", name: "mg", uri: "mongodb://fake", database: "app" });
    const docs = await db.browse(mg.id, "u", { limit: 10 });
    const idCell = docs.rows[0][docs.columns.indexOf("_id")];
    check("B29 ObjectId arrives as an oid tag", idCell.$t === "oid" && /^[0-9a-f]{24}$/.test(idCell.v));
    const mu = await db.updateRows(mg.id, "u", { pk: { _id: idCell }, set: { n: "A" } });
    const call = fake.mongo.calls.find((c) => c.op === "updateOne");
    check("B29 the oid tag becomes an ObjectId in the filter (not a string)", call.filter._id && call.filter._id._bsontype === "ObjectId" && mu.affected === 1 && mu.row.values[mu.row.columns.indexOf("n")] === "A");
    await throws("B29 a string where an oid is expected does not match", () => db.updateRows(mg.id, "u", { pk: { _id: "not-an-oid" }, set: { n: "x" } }), "not-found");
    await db.remove(mg.id);
  }

  /* ================= DB-011 / DB-012 parser: split, classify, format (B47, B48) ================= */
  {
    const sp = (sql, d) => S.splitScript(sql, d).statements.map((x) => x.text);
    check("B47 semicolon inside a string does not split", sp("INSERT INTO t VALUES ('a;b'); SELECT 1;", "sqlite").length === 2 && sp("INSERT INTO t VALUES ('a;b'); SELECT 1;", "sqlite")[0].includes("'a;b'"));
    const proc = sp("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;", "mysql");
    check("B47 mysql DELIMITER blocks keep the procedure body whole", proc.length === 2 && /END$/.test(proc[0].trim()) && proc[1].trim() === "SELECT 3");
    const pgf = sp("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT f();", "postgres");
    check("B47 dollar-quoted bodies are one statement", pgf.length === 2 && /\$\$ BEGIN RETURN 1; END; \$\$/.test(pgf[0]));
    check("B47 mssql GO batches", sp("SELECT 1\nGO\nSELECT 2\nGO", "mssql").length === 2);
    const ora = sp("BEGIN\n dbms_output.put_line('x;y');\nEND;\n/\nSELECT 1 FROM dual;", "oracle");
    check("B47 oracle PL/SQL block ends at the slash", ora.length === 2 && /END;?$/.test(ora[0].trim()));
    const trg = sp("CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET v = 1; DELETE FROM u; END; SELECT 1;", "sqlite");
    check("B47 trigger bodies stay whole", trg.length === 2 && /END$/.test(trg[0].trim()));
    const err = S.splitScript("SELECT 'abc", "sqlite");
    check("B48 unterminated string is a parse error with a line, not a silent split", err.errors.length === 1 && err.errors[0].line === 1);
    check("B48 executable comments are preserved", sp("/*!40101 SET NAMES utf8 */; SELECT 1", "mysql")[0].includes("/*!40101"));
    const f = S.formatSql("select a,'x  y' -- keep\nfrom t where b='  z  '", "generic");
    check("U01 formatting never touches string literals or comments", f.ok && f.text.includes("'x  y'") && f.text.includes("-- keep") && f.text.includes("'  z  '") && /SELECT/.test(f.text) && /FROM/.test(f.text));
    const bad = S.formatSql("select 'open", "generic");
    check("U01 unparsable SQL is returned unchanged with ok=false", bad.ok === false && bad.text === "select 'open");
    const cls = (sql, d = "generic") => S.classify(sql, d);
    check("B15 classify: comment-prefixed insert is a write", cls("/* c */ INSERT INTO t VALUES (1)").op === "write");
    check("B15 classify: writable CTE flagged", cls("WITH x AS (SELECT 1) DELETE FROM t").mutating === true);
    check("B15 classify: parenthesised select is a read", cls("(SELECT 1)").op === "select");
    check("B15 classify: DROP IF EXISTS is a drop", cls("DROP TABLE IF EXISTS t").drop === true);
    check("B15 classify: TRUNCATE flagged", cls("TRUNCATE TABLE t").truncate === true);
    check("B15 classify: CALL/EXEC are procedures", cls("CALL p()").op === "proc" && cls("EXEC sp_who", "mssql").op === "proc");
    check("B15 classify: PRAGMA read vs assignment", cls("PRAGMA table_info(t)", "sqlite").op === "select" && cls("PRAGMA journal_mode = WAL", "sqlite").op === "admin");
    check("B15 touchesProtected matches schema-qualified names", !!S.touchesProtected(cls("UPDATE sales.orders SET a = 1", "postgres"), ["sales.orders"]) && !S.touchesProtected(cls("UPDATE hr.orders SET a = 1", "postgres"), ["sales.orders"]));
  }

  /* ================= DB-008 / DB-009 / DB-033–035 import jobs (B34–B39) ================= */
  {
    const s = await sqliteConn("imp");
    await db.query(s.id, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    await db.query(s.id, "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    const T = { schema: "", table: "t", name: "t" };
    // B34: empty-first is atomic — a failing row leaves the table exactly as it was
    const bad = writeCsv("bad.csv", [["id", "v"], ["10", "x"], ["11", ""], ["12", "z"]]);
    let pick = await io.importPick(win(), { id: s.id, table: T, file: bad });
    check("B34 preview parsed off-thread with header detection", pick.ok && pick.type === "table" && pick.total === 4 && pick.looksHeader === true && pick.width === 2);
    let r = await io.importRun(win(), { token: pick.token, id: s.id, table: T, mapping: { 0: "id", 1: "v" }, hasHeader: true, emptyFirst: true, emptyAsNull: true, batch: 1 });
    check("B34 atomic empty-first rolls everything back on failure", r.state === "failed" && r.atomic === true && r.rolledBack === true && r.committed === 0 && r.totalErrors === 1);
    check("B34 table unchanged after the failed atomic import", (await db.count(s.id, "t")).count === 3 && (await db.query(s.id, "SELECT v FROM t ORDER BY id")).rows.map((x) => x[0]).join() === "a,b,c");
    // B35: cancel is acknowledged and the counts are the truth
    const rows = [["id", "v"]]; for (let i = 100; i < 2100; i++) rows.push([String(i), "r" + i]);
    const big = writeCsv("big.csv", rows);
    pick = await io.importPick(win(), { id: s.id, table: T, file: big });
    progressLog = []; let ack = null;
    onProgress = (p) => { if (p.phase === "run" && p.done >= 100 && !ack) ack = io.importCancel(pick.token); };
    r = await io.importRun(win(), { token: pick.token, id: s.id, table: T, mapping: { 0: "id", 1: "v" }, hasHeader: true, batch: 10 });
    onProgress = null;
    check("B35 cancel is acknowledged", ack && ack.ok === true && ack.acknowledged === true);
    check("B35 cancelled import stops before the next batch", r.state === "cancelled" && r.committed >= 100 && r.committed < 2000);
    check("B35 committed count equals what is in the table", (await db.count(s.id, "t")).count === 3 + r.committed && r.attempted === r.committed + r.failed && r.unattempted === r.total - r.attempted);
    check("B35 job status keeps the outcome after the dialog is gone", io.jobStatus(pick.token).state === "cancelled" && io.jobStatus(pick.token).result.committed === r.committed);
    check("B35 cancel after completion is refused with the state", io.importCancel(pick.token).ok === false && io.importCancel(pick.token).reason === "cancelled");
    // B36/B37: token lifecycle
    await throws("B36 a finished token cannot run again", () => io.importRun(win(), { token: pick.token, id: s.id, table: T, mapping: { 0: "id", 1: "v" } }), "job-finished");
    await throws("B36 unknown token", () => io.importRun(win(), { token: "nope", id: s.id, table: T, mapping: { 0: "id" } }), "job-expired");
    const small = writeCsv("small.csv", [["id", "v"], ["5000", "q"]]);
    pick = await io.importPick(win(1), { id: s.id, table: T, file: small });
    await throws("B37 another window cannot run this import", () => io.importRun(win(2), { token: pick.token, id: s.id, table: T, mapping: { 0: "id", 1: "v" } }), "job-owner");
    const s2 = await sqliteConn("imp2");
    await throws("B37 another connection cannot run this import", () => io.importRun(win(), { token: pick.token, id: s2.id, table: T, mapping: { 0: "id", 1: "v" } }), "job-target");
    await throws("B37 a different target table is refused", () => io.importRun(win(), { token: pick.token, id: s.id, table: { schema: "", table: "u", name: "u" }, mapping: { 0: "id", 1: "v" } }), "job-target");
    await db.save({ ...db.list().find((c) => c.id === s.id), name: "imp-edited" });   // rev bump
    await throws("B37 editing the connection after picking invalidates the token", () => io.importRun(win(), { token: pick.token, id: s.id, table: T, mapping: { 0: "id", 1: "v" } }), "stale-connection");
    check("B37 discarding a preview releases it", io.importDiscard(pick.token).existed === true && io.jobStatus(pick.token) === null);
    await db.remove(s2.id);
    // B38: partial commits are counted exactly; the error list is complete in an artifact
    await db.query(s.id, "DELETE FROM t");
    const mixed = [["id", "v"]]; for (let i = 1; i <= 300; i++) mixed.push([String(i), i <= 250 ? "" : "ok" + i]);
    pick = await io.importPick(win(), { id: s.id, table: T, file: writeCsv("mixed.csv", mixed) });
    r = await io.importRun(win(), { token: pick.token, id: s.id, table: T, mapping: { 0: "id", 1: "v" }, hasHeader: true, emptyAsNull: true, stopOnError: false, batch: 1 });
    check("B38 counts: committed/failed/unattempted are exact", r.state === "done" && r.committed === 50 && r.failed === 250 && r.unattempted === 0 && r.totalErrors === 250 && (await db.count(s.id, "t")).count === 50);
    check("B38 error list is capped in the result but complete in the artifact", r.errors.length === 200 && r.errorsFile && readJson(r.errorsFile).length === 250 && r.errors[0].at === 2);
    // stopOnError with batches: unattempted rows are reported
    await db.query(s.id, "DELETE FROM t");
    pick = await io.importPick(win(), { id: s.id, table: T, file: writeCsv("stop.csv", [["id", "v"], ["1", "a"], ["2", ""], ["3", "c"], ["4", "d"]]) });
    r = await io.importRun(win(), { token: pick.token, id: s.id, table: T, mapping: { 0: "id", 1: "v" }, hasHeader: true, emptyAsNull: true, stopOnError: true, batch: 1 });
    check("B33 stop at first failure leaves later rows unattempted (not 'failed')", r.state === "failed" && r.committed === 1 && r.failed === 1 && r.unattempted === 2);
    // SQL script import: statements in one session, per-statement outcome
    const sqlFile = path.join(ROOT, "script.sql"); fs.writeFileSync(sqlFile, "INSERT INTO t VALUES (100, 'x');\nINSERT INTO t VALUES (100, 'dup');\nINSERT INTO t VALUES (101, 'y');\n");
    pick = await io.importPick(win(), { id: s.id, table: T, file: sqlFile });
    check("B33 sql script preview lists statements with line numbers", pick.type === "sql" && pick.total === 3 && pick.sample[1].line === 2);
    r = await io.importRun(win(), { token: pick.token, id: s.id, stopOnError: true });
    check("B33 sql script: executed/failed/unattempted with the failing statement and line", r.executed === 1 && r.failed === 1 && r.unattempted === 1 && r.errors[0].line === 2 && /dup/.test(r.errors[0].statement));
    fs.writeFileSync(sqlFile, "INSERT INTO t VALUES (777, 'unterminated);\nSELECT 1;");
    const beforeBad = (await db.count(s.id, "t")).count;
    pick = await io.importPick(win(), { id: s.id, table: T, file: sqlFile });
    r = await io.importRun(win(), { token: pick.token, id: s.id });
    check("B47 unparsable script executes nothing", pick.errors.length === 1 && pick.errors[0].line === 1 && r.state === "failed" && r.executed === 0 && r.unattempted === r.total && r.total >= 1 && /could not be parsed/.test(r.error) && (await db.count(s.id, "t")).count === beforeBad);
    // Mongo empty-first is not atomic and needs an explicit acknowledgement
    resetFakes();
    fake.mongo.seed("app", "c", [{ a: 1 }]);
    const mg = await db.save({ kind: "mongodb", name: "mg", uri: "mongodb://fake", database: "app" });
    pick = await io.importPick(win(), { id: mg.id, table: { schema: "", table: "c", name: "c" }, file: writeCsv("m.csv", [["a"], ["2"]]) });
    await throws("B34 Mongo empty-first without acknowledgement is refused before any write", () => io.importRun(win(), { token: pick.token, id: mg.id, table: { schema: "", table: "c", name: "c" }, mapping: { 0: "a" }, hasHeader: true, emptyFirst: true }), "non-atomic");
    check("B34 refused import deleted nothing", !fake.mongo.calls.some((c) => c.op === "deleteMany") && io.jobStatus(pick.token).state === "picked");
    r = await io.importRun(win(), { token: pick.token, id: mg.id, table: { schema: "", table: "c", name: "c" }, mapping: { 0: "a" }, hasHeader: true, emptyFirst: true, acknowledgeNonAtomic: true });
    check("B34 acknowledged Mongo import reports nonAtomic", r.state === "done" && r.nonAtomic === true && r.atomic === false && r.committed === 1);
    await db.remove(mg.id);
    // B39: batch limits follow the engine, not a preference
    check("B39 mssql: ≤1000 rows and ≤2000 parameters", io.batchLimit("mssql", 3, 5000) === 666 && io.batchLimit("mssql", 1, 5000) === 1000);
    check("B39 postgres: 65000 parameters", io.batchLimit("postgres", 70, 5000) === 928);
    check("B39 oracle: one row per statement", io.batchLimit("oracle", 5, 500) === 1);
    check("B39 sqlite: 32000 parameters", io.batchLimit("sqlite", 100, 5000) === 320);
    check("B39 mysql: 5000 rows / 60000 params", io.batchLimit("mysql", 1, 60000) === 5000 && io.batchLimit("mysql", 30, 5000) === 2000);
    await db.remove(s.id);
  }

  /* ================= DB-010 / DB-018 / DB-044 export jobs (B40–B42) ================= */
  {
    const s = await sqliteConn("exp");
    await db.query(s.id, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, b BLOB)");
    const insert = db.__internals.live; void insert;
    await db.query(s.id, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12001) INSERT INTO t (id, v, b) SELECT i, 'v' || i, X'0102' FROM n");
    check("B42 fixture has 12001 rows", (await db.count(s.id, "t")).count === 12001);
    const T = { schema: "", table: "t", name: "t" };
    progressLog = [];
    let r = await io.exportFile(win(), { id: s.id, table: T, format: "csv", scope: "all" });
    const lines = fs.readFileSync(r.path, "utf8").split("\r\n").filter(Boolean);
    check("B42 ALL export streams every row (no ceiling) and is marked complete", r.ok && r.state === "done" && r.complete === true && r.rows === 12001 && lines.length === 12002 && lines[1] === "1,v1,0x0102");
    check("B42 export progress is reported per page", progressLog.filter((p) => p.phase === "fetch").length === 3);
    let cancelAck = null;
    onProgress = (p) => { if (p.phase === "fetch" && p.done >= 5000 && !cancelAck) cancelAck = io.exportCancel(p.token); };
    r = await io.exportFile(win(), { token: "exp-cancel", id: s.id, table: T, format: "csv", scope: "all" });
    onProgress = null;
    check("B42 cancelled export is explicit: partial file, rows so far, complete=false", cancelAck && cancelAck.ok && r.ok === false && r.state === "cancelled" && r.complete === false && /\.partial\.csv$/.test(r.path) && r.rows === 5000 && fs.readFileSync(r.path, "utf8").split("\r\n").filter(Boolean).length === 5001);
    check("B42 no unfinished .part file is left behind", !fs.readdirSync(ROOT).some((f) => /\.part-/.test(f)));
    r = await io.exportFile(win(), { id: s.id, table: T, format: "json", scope: "all" });
    const arr = readJson(r.path);
    check("B42 JSON ALL export is valid and complete, binary as Extended JSON", arr.length === 12001 && arr[0].b.$binary.base64 === Buffer.from([1, 2]).toString("base64"));
    // SQL export needs a SQL engine and a target
    await throws("DB-044 SQL export without a target table is refused", () => io.exportFile(win(), { id: s.id, format: "sql", scope: "page", columns: ["id"], rows: [[1]] }), "invalid");
    r = await io.exportFile(win(), { id: s.id, format: "sql", scope: "page", targetTable: { schema: "", table: "t" }, columns: ["id", "v", "b"], rows: [[1, "it's", db.cell(Buffer.from([1, 2]))]] });
    check("DB-044 SQL export uses the dialect and the target table", /INSERT INTO "t" \("id", "v", "b"\) VALUES\n  \(1, 'it''s', X'0102'\);/.test(fs.readFileSync(r.path, "utf8")));
    check("DB-044 sqlInserts per dialect", /'\\x0102'::bytea/.test(io.sqlInserts("postgres", "t", ["b"], [[db.cell(Buffer.from([1, 2]))]])) && /N'ünï'/.test(io.sqlInserts("mssql", "t", ["v"], [["ünï"]])));
    r = await io.exportFile(win(), { id: s.id, table: T, format: "xlsx", scope: "page", columns: ["id", "v"], rows: [[1, "a"], [2, "b"]] });
    const wb = F.xlsxRead(fs.readFileSync(r.path));
    check("B44 XLSX page export round-trips", wb.rows.length === 3 && wb.rows[0].join() === "id,v" && wb.rows[2][0] === 2 && wb.rows[2][1] === "b");
    await db.remove(s.id);
    // Mongo: union of fields over every page, earlier rows remapped
    resetFakes();
    const docs = []; for (let i = 0; i < 5000; i++) docs.push({ a: i, b: "b" + i }); for (let i = 0; i < 3; i++) docs.push({ a: 9000 + i, c: "late" + i });
    fake.mongo.seed("app", "m", docs);
    const mg = await db.save({ kind: "mongodb", name: "mg", uri: "mongodb://fake", database: "app" });
    r = await io.exportFile(win(), { id: mg.id, table: { schema: "", table: "m", name: "m" }, format: "csv", scope: "all" });
    const ml = fs.readFileSync(r.path, "utf8").split("\r\n").filter(Boolean);
    check("B40 Mongo CSV header is the union of fields across ALL pages", ml[0].replace(/^\uFEFF/, "") === "_id,a,b,c" && ml.length === 5004 && r.columns === 4);
    check("B41 early rows are remapped to the final header (no misaligned columns)", /^[0-9a-f]{24},0,b0,$/.test(ml[1]) && /^[0-9a-f]{24},9002,,late2$/.test(ml[5003]));
    await throws("DB-044 SQL export is refused for Mongo", () => io.exportFile(win(), { id: mg.id, table: { schema: "", table: "m", name: "m" }, format: "sql", scope: "all" }), "unsupported");
    await db.remove(mg.id);
  }

  /* ================= DB-036 / DB-037 file formats (B44, B45, B46, B53) ================= */
  {
    const c = F.csvParse('a,b\r\n1,\r\n"",x\r\n\r\n2,"q""uote"\r\n');
    check("B46 unquoted empty → null, quoted empty → empty string", c.rows.length === 4 && c.rows[1][1] === null && c.rows[2][0] === "" && c.quotedEmpty === 1);
    check("B46 blank lines are skipped and counted; escaped quotes decoded", c.blankLines === 1 && c.rows[3][1] === 'q"uote');
    check("B46 delimiter detection", F.csvParse("a;b\n1;2").delim === ";" && F.csvParse("a\tb\n1\t2").rows[1][1] === "2");
    let e = null; try { F.csvParse('a,b\n1,"x"y\n'); } catch (x) { e = x; }
    check("B46 text after a closing quote is a located error", e && e.line === 2 && /line 2/.test(e.message));
    e = null; try { F.csvParse('a,b\n"open,1\n2,3'); } catch (x) { e = x; }
    check("B46 unterminated quoted field is a located error", e && e.line === 2);
    check("B46 multi-line quoted fields keep their newline", F.csvParse('a\n"l1\nl2"\n').rows[1][0] === "l1\nl2");
    check("B46 csvLine round-trips null vs empty", F.csvLine([null, "", "a,b"]) === ',"","a,b"' && F.csvParse(F.csvLine([null, "", "x"]) + "\n").rows[0].join("|") === "||x");
    check("B53 UTF-16 with BOM is decoded", F.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo", "utf16le")]), "auto") === "héllo");
    // XLSX: never truncate, never silently convert
    e = null; try { F.xlsxWrite(["t"], [["x".repeat(40000)]]); } catch (x) { e = x; }
    check("B45 text beyond Excel's cell limit is refused with the cell address (not truncated)", e && e.type === "format-limit" && e.cell === "A2");
    const big = F.xlsxWrite(["n", "s", "bi"], [[1.5, "s", { $t: "bigint", v: "12345678901234567890" }]]);
    const rb = F.xlsxRead(big);
    check("B45 >15-digit integers are written as text and read back exactly", rb.rows[1][2] === "12345678901234567890" && rb.rows[1][0] === 1.5 && rb.rows[1][1] === "s");
    const sheet = (date1904, extraCells = "") => F.zipSync([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "xl/workbook.xml", data: `<workbook><workbookPr date1904="${date1904 ? 1 : 0}"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: "xl/styles.xml", data: '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>' },
      { name: "xl/worksheets/sheet1.xml", data: `<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>0</v></c><c r="B1" t="e"><v>#N/A</v></c>${extraCells}</row></sheetData></worksheet>` },
    ]);
    check("B44 1900 date system", F.xlsxRead(sheet(false)).rows[0][0] === "1899-12-30");
    check("B44 1904 date system is honoured", F.xlsxRead(sheet(true)).rows[0][0] === "1904-01-01" && F.xlsxRead(sheet(true)).date1904 === true);
    check("B44 error cells become null and are counted", F.xlsxRead(sheet(false)).rows[0][1] === null && F.xlsxRead(sheet(false)).errorCells === 1);
    const bigSheet = F.xlsxRead(sheet(false, '<c r="C1"><v>1234567890123456789</v></c>'));
    check("B45 Excel-native >15-digit numbers keep their exact digits and are counted", bigSheet.rows[0][2] === "1234567890123456789" && bigSheet.bigNumbers === 1);
    e = null; try { F.xlsxRead(sheet(false), { sheet: "Nope" }); } catch (x) { e = x; }
    check("B44 unknown worksheet is an error listing the available ones", e && /Available: S/.test(e.message));
    const zipped = F.zipSync([{ name: "a.txt", data: "x".repeat(10000) }]);
    e = null; try { F.unzipSync(zipped, { maxExpanded: 100 }); } catch (x) { e = x; }
    check("DB-038 zip expansion is bounded", e && /expand|budget|limit|large/i.test(e.message));
    const corrupt = Buffer.from(zipped); corrupt[corrupt.length - 30] ^= 0xff;
    e = null; try { F.unzipSync(corrupt); } catch (x) { e = x; }
    check("DB-038 a corrupt archive is rejected (CRC / structure), not partially read", e !== null);
  }

  /* ================= DB-040 / DB-041 / DB-042 schema plans & column DDL (B32, B33) ================= */
  {
    const s = await sqliteConn("plan");
    await db.query(s.id, "CREATE TABLE sp (a INTEGER PRIMARY KEY, b TEXT, c TEXT)");
    await db.query(s.id, "CREATE INDEX ix_sp_b ON sp (b)");
    let plan = await db.schemaPlan(s.id, "sp", { renames: [["b", "bb"]], drops: ["c"], dropIndexes: ["ix_sp_b"] }, { dryRun: true });
    check("U14 dry run returns the exact ordered steps", plan.steps.map((x) => x.label).join("|") === "drop index ix_sp_b|rename b → bb|drop column c" && plan.steps.every((x) => x.state === "planned") && plan.transactional === true);
    check("U14 steps carry the exact SQL", plan.steps[1].sql === 'ALTER TABLE "sp" RENAME COLUMN "b" TO "bb"');
    plan = await db.schemaPlan(s.id, "sp", { renames: [["c", "x"]], drops: ["c"] }, { dryRun: true });
    check("U14 a rename of a dropped column is discarded and explained", plan.steps.length === 1 && plan.notes.length === 1 && /discarded/.test(plan.notes[0]));
    await throws("U14 rename onto an existing column is rejected", () => db.schemaPlan(s.id, "sp", { renames: [["b", "c"]] }, { dryRun: true }), "invalid");
    await throws("U14 plan against a vanished column asks for a refresh", () => db.schemaPlan(s.id, "sp", { drops: ["zz"] }, { dryRun: true }), "invalid");
    await throws("U14 reorder is refused outside MySQL", () => db.schemaPlan(s.id, "sp", { order: ["c", "b", "a"] }, { dryRun: true }), "unsupported");
    const res = await db.schemaPlan(s.id, "sp", { dropIndexes: ["ix_missing"], renames: [["b", "bb"]] });
    check("U15 a failing step reports failed/skipped and rolls back the plan", res.ok === false && res.steps[0].state === "failed" && res.steps[1].state === "skipped" && res.transactional === true && (await db.columns(s.id, "sp")).map((c) => c.name).join() === "a,b,c");
    const ok = await db.schemaPlan(s.id, "sp", { renames: [["b", "bb"]], drops: ["c"], dropIndexes: ["ix_sp_b"] });
    check("U15 a valid plan applies all steps and reports each as done", ok.ok === true && ok.steps.every((x) => x.state === "done") && (await db.columns(s.id, "sp")).map((c) => c.name).join() === "a,bb");
    // add column: inactive parameters are not appended; preview is the exact statement
    const dry = await db.addColumn(s.id, "sp", { name: "c2", type: "TEXT", length: "10", precision: "5", default: "abc", nullable: false }, { dryRun: true });
    check("B33 length/precision are ignored for a type that has none", dry.sql === 'ALTER TABLE "sp" ADD COLUMN "c2" TEXT DEFAULT \'abc\' NOT NULL');
    check("B33 buildColumnType per type", db.buildColumnType("mysql", { type: "VARCHAR", length: "40" }).type === "VARCHAR(40)" && db.buildColumnType("mysql", { type: "INT", length: "10" }).type === "INT" && db.buildColumnType("mysql", { type: "DECIMAL", precision: 10, scale: 2 }).type === "DECIMAL(10,2)" && db.buildColumnType("sqlite", { type: "ENUM", enumValues: ["a", "b"] }).check.join() === "a,b");
    const dl = db.__internals.defaultLit;
    check("B33 defaults: numbers/keywords/expressions pass, text is quoted", dl("sqlite", "0") === "0" && dl("sqlite", "CURRENT_TIMESTAMP") === "CURRENT_TIMESTAMP" && dl("sqlite", "(1+1)") === "(1+1)" && dl("sqlite", "abc") === "'abc'" && dl("sqlite", "'x'") === "'x'");
    await throws("B33 default with a statement separator is rejected", () => db.addColumn(s.id, "sp", { name: "c3", type: "TEXT", default: "x'; DROP TABLE sp; --" }, { dryRun: true }), "invalid");
    const added = await db.addColumn(s.id, "sp", { name: "c2", type: "TEXT", default: "abc", nullable: false });
    check("B33 add column applies and reports steps", added.ok && added.steps[0].state === "done" && (await db.columns(s.id, "sp")).some((c) => c.name === "c2" && c.default === "'abc'"));
    await throws("DB-042 stale connection revision is refused for DDL", () => db.addColumn(s.id, "sp", { name: "c4", type: "TEXT" }, { expectRev: 999 }), "stale-connection");
    const ix = await db.addIndex(s.id, "sp", { columns: ["bb"], unique: true });
    check("DB-040 index creation reports its SQL", /CREATE UNIQUE INDEX "ux_sp_bb" ON "sp" \("bb"\)/.test(ix.sql) && (await db.tableInfo(s.id, "sp")).indexes.some((x) => x.name === "ux_sp_bb" && x.unique));
    await db.remove(s.id);
    // MySQL column definitions are rebuilt completely
    const def = db.__internals.mysqlColumnDef;
    check("B32 generated column keeps its expression and STORED", /GENERATED ALWAYS AS \(`a` \* `b`\) STORED/.test(def({ name: "total", type: "decimal(10,2)", generated: "`a` * `b`", extra: "STORED GENERATED", nullable: true })));
    const ts = def({ name: "ts", type: "timestamp", nullable: false, default: "CURRENT_TIMESTAMP", extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP · created at" });
    check("B32 timestamp default stays an expression; ON UPDATE and COMMENT kept", /DEFAULT CURRENT_TIMESTAMP/.test(ts) && /on update CURRENT_TIMESTAMP/.test(ts) && /COMMENT 'created at'/.test(ts) && !/'CURRENT_TIMESTAMP'/.test(ts));
    const ai = def({ name: "id", type: "int", nullable: false, default: null, extra: "auto_increment" });
    check("B32 auto_increment kept, no DEFAULT NULL on NOT NULL", /auto_increment/i.test(ai) && !/DEFAULT NULL/.test(ai) && /NOT NULL/.test(ai));
    check("B32 collation and nullable default", /COLLATE utf8mb4_bin/.test(def({ name: "n", type: "varchar(20)", collation: "utf8mb4_bin", nullable: true, default: null })) && /DEFAULT NULL/.test(def({ name: "n", type: "varchar(20)", nullable: true, default: null })));
    resetFakes();
    const m = await db.save({ kind: "mysql", name: "reo", host: "h", user: "u", password: "p", database: "reo" });
    fake.mysql.rules.push({ re: /information_schema\.columns/i, fn: () => ({ objects: ["a", "b", "c"].map((nm) => ({ name: nm, type: "int", nullable: "YES", dflt: null, ckey: nm === "a" ? "PRI" : "", extra: "", comment: "", gen: null, coll: null })), fields: [] }) });
    const ro = await db.reorderColumns(m.id, "t", ["c", "a", "b"], { dryRun: true });
    check("B32 reorder emits MODIFY only for moved columns with full definitions", /MODIFY COLUMN `c` int NULL DEFAULT NULL FIRST/.test(ro.sql) && !/MODIFY COLUMN `a`/.test(ro.sql));
    await throws("B32 reorder that is not a permutation is rejected", () => db.reorderColumns(m.id, "t", ["c", "a"], { dryRun: true }), "invalid");
    const same = await db.reorderColumns(m.id, "t", ["a", "b", "c"], { dryRun: true });
    check("B32 unchanged order produces no statement", same.sql === "");
    await db.remove(m.id);
  }

  /* ================= SQLite open semantics (audit limits table) ================= */
  {
    const missing = path.join(ROOT, "does-not-exist.db");
    const t = await db.test({ kind: "sqlite", file: missing });
    check("DB-sqlite opening a missing file is an error (no silent create)", t.ok === false && t.type === "not-found" && !fs.existsSync(missing));
    const c = await db.test({ kind: "sqlite", file: missing, createIfMissing: true });
    check("DB-sqlite explicit create works", c.ok === true && fs.existsSync(missing));
    const ro = await db.save({ kind: "sqlite", name: "ro", file: missing, readOnly: true });
    await throws("DB-sqlite read-only connection refuses writes", () => db.query(ro.id, "CREATE TABLE x (a)"));
    check("DB-sqlite ping/disconnect lifecycle", (await db.ping(ro.id)).ok === true && db.__internals.live.has(ro.id));
    await db.disconnect(ro.id);
    check("DB-sqlite disconnect releases the handle", !db.__internals.live.has(ro.id));
    await db.remove(ro.id);
  }

  await db.closeAll();
  clearTimeout(watchdog);
  console.log(`\nDB backend: ${pass} passed, ${failN} failed`);
  if (uncaught.length) { console.log("UNCAUGHT:", uncaught.map((e) => String(e && e.stack || e)).join("\n")); }
  if (failN || uncaught.length) { console.log(failures.map((f) => " - " + f).join("\n")); process.exitCode = 1; }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
