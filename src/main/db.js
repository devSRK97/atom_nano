"use strict";
/* DBM — multi-database manager backend (MySQL, PostgreSQL, Oracle, MongoDB, SQLite,
 * SQL Server, Redis). Drivers are ordinary npm packages loaded at first use.
 *
 * Contracts (audit ATOMNANO_DB_MANAGEMENT_AUDIT_2026-09-09):
 *
 *   STORE      userData/db-connections.json is a versioned document written
 *              atomically (temp + rename, .bak kept). Read/parse failures are typed
 *              errors, never an empty list that a later save would overwrite.
 *   SECRETS    passwords / URIs are stored as a typed envelope { $enc: 1, data }
 *              (Electron safeStorage). list() never returns secret values — only
 *              hasPassword/hasUri/secretLocked; the form keeps a secret with
 *              { $keep: true }, clears it with "", reveals it only on explicit request.
 *              If OS encryption is unavailable a secret is NOT written in plaintext:
 *              the save fails with type "secret-unavailable" and the UI offers a
 *              session-only credential (setSessionSecret) instead.
 *   REVISIONS  every save bumps conn.rev. Operations submitted with expectRev are
 *              rejected (type "stale-connection") when the profile changed meanwhile.
 *   CONNECTIONS one live handle per profile with a generation token: concurrent cold
 *              opens share one promise, a disconnect during open closes the late
 *              handle, a failed verification closes the pool, close() is awaited.
 *              Pool error listeners exist before connecting (idle errors never throw).
 *   SESSIONS   a query tab owns a SESSION (pinned client) so BEGIN/COMMIT, SET/USE,
 *              temp tables and search_path belong to that tab. Health checks never
 *              use a session client.
 *   RETRY      a transport error never re-runs a statement that may have mutated
 *              state: mutations surface as type "outcome-unknown"; only classified
 *              reads outside a transaction retry once on a fresh handle.
 *   POLICY     enforced in main on the PARSED statement (sqlscript.classify): CTE
 *              bodies, EXEC/CALL, comments, quoted/qualified names, Mongo operations
 *              and Redis commands. Unknown mutating constructs are blocked when a
 *              protection is enabled.
 *   VALUES     one typed wire contract. Cells are JSON primitives or tagged objects:
 *              { $t:"bigint", v } · { $t:"bytes", b64, len } · { $t:"oid", v } ·
 *              { $t:"date", v } · { $t:"json", v } · { $t:"decimal", v }. Nothing is
 *              rounded through Number; blobs keep their bytes. Generated mutations
 *              bind PARAMETERS (never interpolated literals).
 *   IDENTITY   row edits/deletes require the COMPLETE primary key with non-NULL
 *              typed values and run inside a transaction that verifies exactly one
 *              row matched (rolled back otherwise).
 *   RESULTS    positional columns (duplicates kept), every result set returned,
 *              user SQL is never rewritten: previews wrap a confirmed SELECT in a
 *              derived table (shown as effectiveSql) or use driver cursors, and
 *              `hasMore` says whether more rows exist. */
const { app, safeStorage } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const S = require("./sqlscript");

const CONN_FILE = () => path.join(app.getPath("userData"), "db-connections.json");
const appRoot = () => path.join(__dirname, "..", "..");
const uid = (p = "db") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const POOL_MAX = 4;   // connection budget per profile (server capacity, not local cores)

/* ============================== errors ============================== */
class DbError extends Error {
  constructor(message, { type = "db", details = "", code = null, hint = "", opId = "" } = {}) {
    super(message); this.name = "DbError"; this.type = type; this.details = details; this.code = code; this.hint = hint; this.opId = opId;
  }
  toJSON() { return { message: this.message, type: this.type, details: this.details, code: this.code, hint: this.hint, opId: this.opId }; }
}
const TRANSPORT_RE = /lost|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EHOSTUNREACH|not connected|socket.*closed|ORA-03135|ORA-12541|ORA-03114|ORA-12537|connection.*(closed|terminated|ended)|server closed the connection|read ECONNRESET|PROTOCOL_CONNECTION_LOST|ESOCKET|ETIMEOUT|Connection is closed|Pool is closed|Topology is closed|MongoNetworkError|Socket closed unexpectedly/i;
const AUTH_RE = /access denied|authentication|password|login failed|ER_ACCESS|28P01|28000|ORA-01017|not authorized|Unauthorized|WRONGPASS|NOAUTH|18456/i;
const PERM_RE = /permission denied|42501|ORA-00942|ORA-01031|does not have permission|Command .* denied|insufficient privileges|EACCES/i;
const isTransport = (e) => TRANSPORT_RE.test(String((e && e.message) || e || "")) || /^E(CONN|PIPE|TIMEDOUT|HOSTUNREACH|NOTFOUND)/.test(String((e && e.code) || ""));
function classifyErr(e) {
  const m = String((e && e.message) || e || "");
  if (e instanceof DbError) return e.type;
  if (e && e.driverMissing) return "driver-missing";
  if (isTransport(e)) return "transport";
  if (AUTH_RE.test(m)) return "auth";
  if (PERM_RE.test(m)) return "permission";
  return "db";
}
// Wrap a driver error into a typed DbError (keeps the driver's own message/code).
function wrap(e, fallbackType) {
  if (e instanceof DbError) return e;
  const err = new DbError(String((e && e.message) || e || "Database error"), { type: fallbackType || classifyErr(e), code: e && (e.code || e.errno || e.number) != null ? String(e.code || e.errno || e.number) : null, details: e && e.stack ? "" : "" });
  if (e && e.driverMissing) err.driverMissing = e.driverMissing;
  return err;
}

/* ============================== engine catalog ============================== */
const KINDS = {
  mysql:    { name: "MySQL",      pkg: "mysql2",         requirePath: "mysql2/promise", port: 3306,  fields: ["host", "port", "user", "password", "database"], tls: true },
  postgres: { name: "PostgreSQL", pkg: "pg",             port: 5432,  fields: ["host", "port", "user", "password", "database"], tls: true },
  oracle:   { name: "Oracle",     pkg: "oracledb",       port: 1521,  fields: ["host", "port", "user", "password", "database"], dbLabel: "Service name" },
  mongodb:  { name: "MongoDB",    pkg: "mongodb",        port: 27017, fields: ["uri", "database"], uriPlaceholder: "mongodb://localhost:27017" },
  sqlite:   { name: "SQLite",     pkg: "better-sqlite3", port: 0,     fields: ["file"] },
  mssql:    { name: "SQL Server", pkg: "mssql",          port: 1433,  fields: ["host", "port", "user", "password", "database"], tls: true },
  redis:    { name: "Redis",      pkg: "redis",          port: 6379,  fields: ["uri"], uriPlaceholder: "redis://localhost:6379" },
};
const T = (t, f = {}) => ({ t, ...f });
const TYPES = {
  mysql: [T("INT"), T("BIGINT"), T("SMALLINT"), T("TINYINT"), T("BOOLEAN"), T("DECIMAL", { prec: true }), T("FLOAT"), T("DOUBLE"), T("VARCHAR", { len: true, dlen: 255 }), T("CHAR", { len: true, dlen: 1 }), T("TEXT"), T("MEDIUMTEXT"), T("LONGTEXT"), T("JSON"), T("ENUM", { enum: true }), T("SET", { enum: true }), T("DATE"), T("DATETIME"), T("TIMESTAMP"), T("TIME"), T("YEAR"), T("BLOB"), T("BINARY", { len: true, dlen: 16 }), T("VARBINARY", { len: true, dlen: 255 })],
  postgres: [T("integer"), T("bigint"), T("smallint"), T("serial"), T("bigserial"), T("boolean"), T("numeric", { prec: true }), T("real"), T("double precision"), T("varchar", { len: true, dlen: 255 }), T("char", { len: true, dlen: 1 }), T("text"), T("uuid"), T("json"), T("jsonb"), T("enum", { enum: true, note: "creates a named ENUM type" }), T("date"), T("timestamp"), T("timestamptz"), T("time"), T("interval"), T("bytea"), T("text[]"), T("integer[]"), T("inet"), T("cidr")],
  sqlite: [T("INTEGER"), T("REAL"), T("NUMERIC"), T("TEXT"), T("BLOB"), T("BOOLEAN"), T("DATETIME"), T("ENUM", { enum: true, note: "TEXT with a CHECK constraint" })],
  mssql: [T("int"), T("bigint"), T("smallint"), T("tinyint"), T("bit"), T("decimal", { prec: true }), T("float"), T("money"), T("nvarchar", { len: true, dlen: 255, max: true }), T("varchar", { len: true, dlen: 255, max: true }), T("nchar", { len: true, dlen: 1 }), T("char", { len: true, dlen: 1 }), T("text"), T("ENUM", { enum: true, note: "NVARCHAR with a CHECK constraint" }), T("date"), T("datetime2"), T("datetime"), T("time"), T("datetimeoffset"), T("uniqueidentifier"), T("varbinary", { len: true, dlen: 255, max: true }), T("xml")],
  oracle: [T("NUMBER", { prec: true }), T("INTEGER"), T("FLOAT"), T("BINARY_DOUBLE"), T("VARCHAR2", { len: true, dlen: 255 }), T("NVARCHAR2", { len: true, dlen: 255 }), T("CHAR", { len: true, dlen: 1 }), T("CLOB"), T("NCLOB"), T("ENUM", { enum: true, note: "VARCHAR2 with a CHECK constraint" }), T("DATE"), T("TIMESTAMP"), T("TIMESTAMP WITH TIME ZONE"), T("INTERVAL DAY TO SECOND"), T("BLOB"), T("RAW", { len: true, dlen: 16 })],
  mongodb: [T("string"), T("number"), T("boolean"), T("date"), T("object"), T("array"), T("null")],
  redis: [],
};
// Which protections each engine can actually enforce (the UI shows only these).
const POLICIES = {
  sql: ["blockDrop", "blockTruncate", "blockWrite", "blockDDL", "protectedTables"],
  mongodb: ["blockDrop", "blockTruncate", "blockWrite", "blockDDL", "protectedTables"],
  redis: ["blockDrop", "blockTruncate", "blockWrite", "blockDDL", "protectedTables"],
};
function kinds() {
  return Object.entries(KINDS).map(([id, k]) => ({ id, name: k.name, pkg: k.pkg, port: k.port, fields: k.fields, dbLabel: k.dbLabel || "Database", uriPlaceholder: k.uriPlaceholder || "", tls: !!k.tls, installed: driverInstalled(id), types: TYPES[id] || [], policies: POLICIES[id] || POLICIES.sql, secureStorage: canEncrypt() }));
}

/* ============================== connection store ============================== */
const STORE_VERSION = 2;
const SECRET_FIELDS = ["password", "uri"];
function canEncrypt() { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; } }
const isEnvelope = (v) => v && typeof v === "object" && v.$enc === 1 && typeof v.data === "string";
// Encrypt a plaintext secret → envelope. Throws (typed) when secure storage is unavailable.
function sealSecret(plain) {
  if (!canEncrypt()) throw new DbError("Secure credential storage is not available on this system — the secret was not saved.", { type: "secret-unavailable", hint: "Use a session-only credential (kept in memory until the app closes) or fix the OS keychain / DPAPI." });
  try { return { $enc: 1, data: safeStorage.encryptString(String(plain)).toString("base64") }; }
  catch (e) { throw new DbError("Encrypting the credential failed: " + e.message, { type: "secret-unavailable" }); }
}
// Decrypt an envelope → { value } or { locked: true } (ciphertext retained, never blanked).
function openSecret(stored) {
  if (stored == null || stored === "") return { value: "" };
  if (typeof stored === "string" && stored.startsWith("enc:")) { try { return { value: safeStorage.decryptString(Buffer.from(stored.slice(4), "base64")) }; } catch { return { locked: true }; } }   // legacy envelope
  if (isEnvelope(stored)) { try { return { value: safeStorage.decryptString(Buffer.from(stored.data, "base64")) }; } catch { return { locked: true }; } }
  if (typeof stored === "string") return { value: stored, plaintext: true };   // legacy plaintext (migrated on the next save)
  return { value: "" };
}
function readStore() {
  const file = CONN_FILE();
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return { version: STORE_VERSION, connections: [] }; throw new DbError(`Cannot read the connection store (${e.code || e.message}). Nothing was changed.`, { type: "store", code: e.code, details: file }); }
  let j;
  try { j = JSON.parse(raw); } catch (e) { throw new DbError("The connection store is damaged (invalid JSON). It was left untouched — repair or move db-connections.json.", { type: "store-corrupt", details: file + "\n" + e.message }); }
  if (Array.isArray(j)) return { version: 1, connections: j.filter((c) => c && typeof c === "object") };
  if (!j || typeof j !== "object" || !Array.isArray(j.connections)) throw new DbError("The connection store has an unexpected shape. It was left untouched.", { type: "store-corrupt", details: file });
  return j;
}
// Atomic write: temp file in the same folder, fsync, rename; the previous file is kept as .bak.
function writeStore(doc) {
  const file = CONN_FILE();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const text = JSON.stringify({ version: STORE_VERSION, savedAt: new Date().toISOString(), connections: doc.connections }, null, 2);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, "w"); try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (JSON.parse(fs.readFileSync(tmp, "utf8")).connections.length !== doc.connections.length) throw new Error("verification of the written store failed");
    if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + ".bak"); } catch { /* backup is best effort */ } }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw new DbError(`Saving the connection store failed (${e.code || e.message}). The previous store is intact.`, { type: "store", code: e.code, details: file });
  }
}
// Session-only credentials (never persisted): connId → { password?, uri? }
const sessionSecrets = new Map();
function setSessionSecret(id, fields) {
  if (!id || typeof id !== "string") throw new DbError("Connection id is required.", { type: "invalid" });
  const cur = sessionSecrets.get(id) || {};
  for (const f of SECRET_FIELDS) if (fields && typeof fields[f] === "string") { if (fields[f]) cur[f] = fields[f]; else delete cur[f]; }
  if (Object.keys(cur).length) sessionSecrets.set(id, cur); else sessionSecrets.delete(id);
  return { ok: true, fields: Object.keys(cur) };
}
// Public profile: no secret values, only their presence/lock state.
function publicProfile(c) {
  const o = {};
  for (const [k, v] of Object.entries(c)) if (!SECRET_FIELDS.includes(k)) o[k] = v;
  const locked = {};
  o.hasPassword = false; o.hasUri = false;
  for (const f of SECRET_FIELDS) {
    const st = openSecret(c[f]);
    const has = c[f] != null && c[f] !== "";
    if (f === "password") o.hasPassword = has; else o.hasUri = has;
    if (st.locked) locked[f] = true;
    if (st.plaintext) o.legacyPlaintext = true;
  }
  if (sessionSecrets.has(c.id)) o.sessionSecret = Object.keys(sessionSecrets.get(c.id));
  o.secretLocked = locked;
  o.rev = c.rev || 1;
  return o;
}
function list() { return readStore().connections.map(publicProfile); }
// Full profile WITH decrypted secrets — internal use only (connecting).
function getConn(id, expectRev) {
  if (!id || typeof id !== "string") throw new DbError("Connection id is required.", { type: "invalid" });
  const c = readStore().connections.find((x) => x.id === id);
  if (!c) throw new DbError("Connection not found", { type: "not-found" });
  if (expectRev != null && +expectRev !== (c.rev || 1)) throw new DbError("This connection's settings changed since the operation was prepared. Reload and try again.", { type: "stale-connection" });
  const o = { ...c };
  const ss = sessionSecrets.get(id) || {};
  for (const f of SECRET_FIELDS) {
    if (ss[f]) { o[f] = ss[f]; continue; }
    const st = openSecret(c[f]);
    if (st.locked) throw new DbError(`The saved ${f} for “${c.name || id}” cannot be decrypted on this account/machine. Enter it again to continue.`, { type: "secret-locked", hint: "Edit the connection and re-enter the secret, or use a session-only credential." });
    o[f] = st.value || "";
  }
  return o;
}
// Reveal one secret on explicit request (edit form eye button).
function revealSecret(id, field) {
  if (!SECRET_FIELDS.includes(field)) throw new DbError("Unknown secret field.", { type: "invalid" });
  const c = readStore().connections.find((x) => x.id === id);
  if (!c) throw new DbError("Connection not found", { type: "not-found" });
  const ss = sessionSecrets.get(id) || {};
  if (ss[field]) return { value: ss[field], session: true };
  const st = openSecret(c[field]);
  if (st.locked) throw new DbError(`The saved ${field} cannot be decrypted on this account/machine.`, { type: "secret-locked" });
  return { value: st.value || "" };
}
const VALID_KIND = (k) => Object.prototype.hasOwnProperty.call(KINDS, k);
/* Save a profile. Secret fields: undefined / { $keep: true } keep the stored envelope,
 * "" clears, a string is sealed. Legacy plaintext is migrated only when sealing works.
 * The live connection is closed only AFTER persistence succeeded. */
async function save(conn) {
  if (!conn || typeof conn !== "object") throw new DbError("Connection is required.", { type: "invalid" });
  if (!VALID_KIND(conn.kind)) throw new DbError("Unknown database kind: " + conn.kind, { type: "invalid" });
  const store = readStore();
  const isNew = !conn.id;
  if (isNew) conn.id = uid();
  else if (typeof conn.id !== "string") throw new DbError("Invalid connection id.", { type: "invalid" });
  const i = store.connections.findIndex((c) => c.id === conn.id);
  const prev = i >= 0 ? store.connections[i] : null;
  if (!isNew && prev && conn.rev != null && +conn.rev !== (prev.rev || 1)) throw new DbError("Someone else saved this connection meanwhile (another window?). Reload it before saving.", { type: "stale-connection" });
  const out = {};
  for (const [k, v] of Object.entries(conn)) if (!SECRET_FIELDS.includes(k) && !["hasPassword", "hasUri", "secretLocked", "legacyPlaintext", "sessionSecret"].includes(k)) out[k] = v;
  for (const f of SECRET_FIELDS) {
    const v = conn[f];
    if (v === undefined || (v && typeof v === "object" && v.$keep)) {
      // keep — migrating legacy plaintext when we can
      const stored = prev ? prev[f] : undefined;
      if (typeof stored === "string" && stored && !stored.startsWith("enc:") && canEncrypt()) out[f] = sealSecret(stored);
      else if (stored != null) out[f] = stored;
    } else if (v === "" || v === null) { /* cleared */ }
    else if (typeof v === "string") out[f] = sealSecret(v);
    else throw new DbError(`Invalid ${f} value.`, { type: "invalid" });
  }
  if (out.policy && typeof out.policy === "object") { const p = {}; for (const k of POLICIES.sql) if (out.policy[k] !== undefined) p[k] = k === "protectedTables" ? (Array.isArray(out.policy[k]) ? out.policy[k].map(String).filter(Boolean) : []) : !!out.policy[k]; out.policy = p; }
  out.rev = (prev ? (prev.rev || 1) : 0) + 1;
  out.updatedAt = new Date().toISOString();
  if (i >= 0) store.connections[i] = out; else store.connections.push(out);
  writeStore(store);                                       // throws typed — nothing else changed
  await closeOne(conn.id);                                 // config changed → drop the live connection
  return publicProfile(out);
}
async function remove(id) {
  const store = readStore();
  const before = store.connections.length;
  store.connections = store.connections.filter((c) => c.id !== id);
  if (store.connections.length === before) throw new DbError("Connection not found", { type: "not-found" });
  writeStore(store);
  sessionSecrets.delete(id);
  await closeOne(id);
  return { ok: true };
}

/* ============================== drivers ============================== */
function driverInstalled(kind) {
  const k = KINDS[kind]; if (!k) return false;
  try { require.resolve(k.requirePath || k.pkg, { paths: [appRoot()] }); return true; } catch { return false; }
}
// Missing vs broken are distinct: a package that resolves but fails to load (ABI,
// corrupt install) reports its real error instead of "not installed".
function loadDriver(kind) {
  const k = KINDS[kind]; if (!k) throw new DbError("Unknown database kind: " + kind, { type: "invalid" });
  let resolved;
  try { resolved = require.resolve(k.requirePath || k.pkg, { paths: [appRoot()] }); }
  catch { const e = new DbError(`Driver "${k.pkg}" is not installed`, { type: "driver-missing" }); e.driverMissing = k.pkg; throw e; }
  try { return require(resolved); }
  catch (e) { throw new DbError(`Driver "${k.pkg}" is installed but failed to load: ${e.message}`, { type: "driver-broken", details: e.stack || "", hint: /NODE_MODULE_VERSION|was compiled against/.test(e.message) ? `Rebuild it for Electron: npx electron-rebuild -f -w ${k.pkg}` : "" }); }
}
const NATIVE_PKGS = new Set(["better-sqlite3"]);
const lastLine = (s) => String(s || "").split(/\r?\n/).filter(Boolean).slice(-1)[0] || "";
let installLock = Promise.resolve();
/* Install a driver into the app folder (serialized; one at a time). "ok" requires
 * the package to actually LOAD afterwards; a native rebuild failure is reported as a
 * failure with the real message — never as success. */
function installDriver(kind) {
  const k = KINDS[kind]; if (!k) return Promise.resolve({ ok: false, detail: "Unknown kind" });
  const job = installLock.then(() => new Promise((resolve) => {
    const npmArgs = ["i", `${k.pkg}@latest`, "--no-audit", "--no-fund", "--loglevel=error", ...(NATIVE_PKGS.has(k.pkg) ? [] : ["--ignore-scripts"])];
    const cmd = process.platform === "win32" ? "cmd.exe" : "npm";
    const args = process.platform === "win32" ? ["/c", "npm", ...npmArgs] : npmArgs;
    execFile(cmd, args, { cwd: appRoot(), timeout: 300000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _o, se) => {
      if (err) return resolve({ ok: false, state: "install-failed", detail: lastLine(se) || err.message || String(err) });
      const verify = () => { try { const m = loadDriver(kind); return { ok: !!m, state: "ready", version: (() => { try { return require(require.resolve(`${k.pkg}/package.json`, { paths: [appRoot()] })).version; } catch { return ""; } })() }; } catch (e) { return { ok: false, state: "load-failed", detail: e.message }; } };
      if (!NATIVE_PKGS.has(k.pkg)) return resolve(verify());
      const cli = path.join(appRoot(), "node_modules", "@electron", "rebuild", "lib", "cli.js");
      if (!fs.existsSync(cli)) return resolve({ ...verify(), detail: `installed — if it fails to load in the app, run: npx electron-rebuild -f -w ${k.pkg}` });
      execFile(process.execPath, [cli, "-f", "-w", k.pkg], { cwd: appRoot(), timeout: 600000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (err2, _o2, se2) => {
        if (err2) return resolve({ ok: false, state: "rebuild-failed", detail: "installed, but the Electron rebuild failed: " + (lastLine(se2) || err2.message) });
        resolve({ ...verify(), detail: "installed and rebuilt for Electron" });
      });
    });
  }));
  installLock = job.catch(() => {});
  return job;
}

/* ============================== live connections (generation-tracked) ============================== */
const live = new Map();   // conn.id → { gen, promise, entry, broken }
let genSeq = 0;
function tlsOptions(conn) {
  if (!conn.ssl) return null;
  const insecure = conn.sslMode === "insecure";
  const o = { rejectUnauthorized: !insecure };
  if (conn.sslCa) { try { o.ca = fs.readFileSync(conn.sslCa, "utf8"); } catch (e) { throw new DbError(`Cannot read the CA certificate file: ${e.message}`, { type: "invalid" }); } }
  if (conn.sslServerName) o.servername = conn.sslServerName;
  return o;
}
async function connect(conn) {
  const d = loadDriver(conn.kind);
  const broken = (rec, e) => { rec.broken = true; rec.lastError = String((e && e.message) || e); };
  switch (conn.kind) {
    case "mysql": {
      const tls = tlsOptions(conn);
      const pool = d.createPool({
        host: conn.host || "localhost", port: +conn.port || 3306, user: conn.user, password: conn.password, database: conn.database || undefined,
        connectTimeout: 15000, connectionLimit: POOL_MAX, waitForConnections: true, queueLimit: 50,
        supportBigNumbers: true, bigNumberStrings: false, decimalNumbers: false, dateStrings: false, multipleStatements: false, rowsAsArray: true,
        ...(tls ? { ssl: tls } : {}),
      });
      const entry = { kind: conn.kind, handle: pool, d, close: () => pool.end().catch(() => {}) };
      if (pool.pool && typeof pool.pool.on === "function") pool.pool.on("error", (e) => broken(entry, e));
      try { await pool.query("SELECT 1"); } catch (e) { await entry.close(); throw e; }
      return entry;
    }
    case "postgres": {
      const tls = tlsOptions(conn);
      const pool = new d.Pool({ host: conn.host || "localhost", port: +conn.port || 5432, user: conn.user, password: conn.password, database: conn.database || undefined, connectionTimeoutMillis: 15000, max: POOL_MAX, idleTimeoutMillis: 30000, ...(tls ? { ssl: tls } : {}) });
      const entry = { kind: conn.kind, handle: pool, d, close: () => pool.end().catch(() => {}) };
      pool.on("error", (e) => broken(entry, e));           // idle-client errors are events, never unhandled throws
      try { const c = await pool.connect(); c.release(); } catch (e) { await entry.close(); throw e; }
      return entry;
    }
    case "oracle": {
      const pool = await d.createPool({ user: conn.user, password: conn.password, connectString: `${conn.host || "localhost"}:${+conn.port || 1521}/${conn.database || ""}`, poolMin: 0, poolMax: POOL_MAX, poolTimeout: 15 });
      const entry = { kind: conn.kind, handle: pool, d, close: () => pool.close(0).catch(() => {}) };
      try { const c = await pool.getConnection(); try { await c.execute("SELECT 1 FROM dual"); } finally { await c.close().catch(() => {}); } } catch (e) { await entry.close(); throw e; }
      return entry;
    }
    case "mongodb": {
      const client = new d.MongoClient(conn.uri || "mongodb://localhost:27017", { serverSelectionTimeoutMS: 8000, maxPoolSize: POOL_MAX });
      const entry = { kind: conn.kind, handle: client, d, close: () => client.close().catch(() => {}) };
      client.on("error", (e) => broken(entry, e));
      try { await client.connect(); await client.db(conn.database || "admin").command({ ping: 1 }); } catch (e) { await entry.close(); throw e; }
      return entry;
    }
    case "sqlite": {
      if (!conn.file) throw new DbError("SQLite needs a database file path.", { type: "invalid" });
      if (!conn.createIfMissing && conn.file !== ":memory:" && !fs.existsSync(conn.file)) throw new DbError(`The database file does not exist: ${conn.file}`, { type: "not-found", hint: "Enable “Create the file if it doesn't exist” on the connection to create a new database." });
      const c = new d(conn.file, { fileMustExist: !conn.createIfMissing && conn.file !== ":memory:", readonly: !!conn.readOnly });
      c.defaultSafeIntegers(true);                          // never round 64-bit integers
      // No journal / synchronous / cache pragmas: opening a database for inspection must not rewrite its settings.
      return { kind: conn.kind, handle: c, d, close: async () => { try { c.close(); } catch { /* */ } } };
    }
    case "mssql": {
      const insecure = conn.sslMode === "insecure";
      const pool = new d.ConnectionPool({ server: conn.host || "localhost", port: +conn.port || 1433, user: conn.user, password: conn.password, database: conn.database || undefined, options: { encrypt: !!conn.ssl, trustServerCertificate: insecure, ...(conn.sslCa ? { cryptoCredentialsDetails: { ca: fs.readFileSync(conn.sslCa, "utf8") } } : {}) }, connectionTimeout: 15000, requestTimeout: 0, pool: { max: POOL_MAX, min: 0, acquireTimeoutMillis: 30000 } });
      const entry = { kind: conn.kind, handle: pool, d, close: () => pool.close().catch(() => {}) };
      pool.on("error", (e) => broken(entry, e));
      try { await pool.connect(); } catch (e) { await entry.close(); throw e; }
      return entry;
    }
    case "redis": {
      const c = d.createClient({ url: conn.uri || "redis://localhost:6379", socket: { connectTimeout: 8000, reconnectStrategy: false } });
      const entry = { kind: conn.kind, handle: c, d, close: () => c.quit().catch(() => c.disconnect().catch(() => {})) };
      c.on("error", (e) => broken(entry, e));
      try { await c.connect(); await c.ping(); } catch (e) { await entry.close(); throw e; }
      return entry;
    }
    default: throw new DbError("Unknown kind " + conn.kind, { type: "invalid" });
  }
}
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
async function sessionOpen(id) {
  const conn = getConn(id);
  const sid = uid("s");
  sessions.set(sid, { sid, id, kind: conn.kind, client: null, inTx: false, gen: 0, txObj: null, autocommit: true });
  return { session: sid, kind: conn.kind };
}
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

/* ============================== typed values ============================== */
const SAFE = (n) => n >= Number.MIN_SAFE_INTEGER && n <= Number.MAX_SAFE_INTEGER;
const isBytes = (v) => Buffer.isBuffer(v) || v instanceof Uint8Array || (v && typeof v === "object" && v.constructor && v.constructor.name === "ArrayBuffer");
// Driver value → wire cell (JSON primitive or tagged object). Lossless.
function cell(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string" || t === "boolean") return v;
  if (t === "number") return Number.isFinite(v) ? v : { $t: "num", v: String(v) };
  if (t === "bigint") return SAFE(Number(v)) && Number(v).toString() === v.toString() ? Number(v) : { $t: "bigint", v: v.toString() };
  if (v instanceof Date) return { $t: "date", v: isNaN(v) ? String(v) : v.toISOString() };
  if (isBytes(v)) { const b = Buffer.isBuffer(v) ? v : Buffer.from(v.buffer ? v.buffer : v); return { $t: "bytes", len: b.length, b64: b.toString("base64") }; }
  if (t === "object") {
    const bt = v._bsontype;
    if (bt === "ObjectId" || bt === "ObjectID") return { $t: "oid", v: v.toHexString() };
    if (bt === "Long") return cell(BigInt(v.toString()));
    if (bt === "Decimal128") return { $t: "decimal", v: v.toString() };
    if (bt === "Binary") return { $t: "bytes", len: v.length ? v.length() : (v.buffer ? v.buffer.length : 0), b64: Buffer.from(v.buffer || []).toString("base64"), sub: v.sub_type };
    if (bt === "Timestamp") return { $t: "json", v: JSON.stringify({ $timestamp: { t: v.high, i: v.low } }) };
    if (bt === "UUID") return { $t: "uuid", v: v.toString() };
    if (typeof v.toHexString === "function") return { $t: "oid", v: v.toHexString() };
    try { return { $t: "json", v: JSON.stringify(v, (_k, x) => typeof x === "bigint" ? { $bigint: x.toString() } : isBytes(x) ? { $bytes: Buffer.from(x).toString("base64") } : x) }; } catch { return { $t: "json", v: String(v) }; }
  }
  return String(v);
}
const isTag = (v) => v && typeof v === "object" && typeof v.$t === "string";
// Wire cell → the value to BIND as a parameter for `kind`.
function bindValue(kind, v) {
  if (v === null || v === undefined) return null;
  if (!isTag(v)) {
    if (typeof v === "object" && "raw" in v) throw new DbError("Raw expressions are not allowed in bound values.", { type: "invalid" });
    if (typeof v === "boolean" && (kind === "mssql" || kind === "oracle" || kind === "sqlite")) return v ? 1 : 0;
    return v;
  }
  switch (v.$t) {
    case "bigint": { if (!/^-?\d+$/.test(String(v.v))) throw new DbError("Invalid integer value.", { type: "invalid" }); return kind === "postgres" || kind === "oracle" || kind === "mssql" ? String(v.v) : BigInt(v.v); }
    case "num": case "decimal": return kind === "sqlite" ? Number(v.v) : String(v.v);
    case "bytes": return Buffer.from(v.b64 || "", "base64");
    case "date": return kind === "sqlite" ? String(v.v) : new Date(v.v);
    case "json": return kind === "postgres" || kind === "mysql" ? String(v.v) : String(v.v);
    case "oid": case "uuid": return String(v.v);
    default: return String(v.v);
  }
}
// Wire cell → display text (what a user sees / copies).
function cellText(v) {
  if (v === null || v === undefined) return null;
  if (!isTag(v)) return typeof v === "string" ? v : String(v);
  switch (v.$t) {
    case "bytes": return `0x${Buffer.from(v.b64 || "", "base64").toString("hex")}`;
    default: return String(v.v);
  }
}
// Wire cell → SQL literal for exports (dialect-aware, lossless where the dialect allows).
function sqlLiteral(kind, v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return (kind === "mssql" || kind === "oracle" || kind === "sqlite") ? (v ? "1" : "0") : (v ? "TRUE" : "FALSE");
  if (isTag(v)) {
    if (v.$t === "bigint" || v.$t === "num" || v.$t === "decimal") return String(v.v);
    if (v.$t === "bytes") { const hex = Buffer.from(v.b64 || "", "base64").toString("hex"); return kind === "postgres" ? `'\\x${hex}'::bytea` : kind === "mssql" || kind === "mysql" ? `0x${hex}` : kind === "oracle" ? `HEXTORAW('${hex}')` : `X'${hex}'`; }
    if (v.$t === "date") return kind === "oracle" ? `TIMESTAMP '${String(v.v).replace("T", " ").replace(/Z$/, "")}'` : `'${String(v.v)}'`;
    v = String(v.v);
  }
  const s = typeof v === "string" ? v : String(v);
  const q = s.replace(/'/g, "''");
  if (kind === "mysql") return "'" + q.replace(/\\/g, "\\\\").replace(/\0/g, "\\0") + "'";
  if (kind === "mssql") return (/[^\x00-\x7f]/.test(s) ? "N'" : "'") + q + "'";
  return "'" + q + "'";
}

/* ============================== identifiers ============================== */
const SCHEMA_KINDS = new Set(["postgres", "mssql", "oracle", "mysql"]);
function safeIdent(s) {
  const v = String(s == null ? "" : s);
  if (!v || /[\x00-\x1f]/.test(v) || v.length > 256) throw new DbError(`Invalid identifier: "${s}"`, { type: "invalid" });
  return v;                                                // legal leading/trailing spaces are part of a name — never trimmed
}
function quoteIdent(kind, part) {
  const p = safeIdent(part);
  if (kind === "mysql") return "`" + p.replace(/`/g, "``") + "`";
  if (kind === "mssql") return "[" + p.replace(/]/g, "]]") + "]";
  return '"' + p.replace(/"/g, '""') + '"';
}
/* Object identity: { schema, table } (structured) or a display string "schema.table".
 * Structured input is authoritative; a plain string splits on the FIRST dot only for
 * engines with schemas (a table whose own name contains a dot must be passed structured). */
function objIdent(kind, ref) {
  if (ref && typeof ref === "object") return { schema: ref.schema ? safeIdent(ref.schema) : "", table: safeIdent(ref.table || ref.name) };
  const s = String(ref == null ? "" : ref);
  if (!SCHEMA_KINDS.has(kind)) return { schema: "", table: safeIdent(s) };
  const i = s.indexOf(".");
  return i > 0 && i < s.length - 1 ? { schema: safeIdent(s.slice(0, i)), table: safeIdent(s.slice(i + 1)) } : { schema: "", table: safeIdent(s) };
}
function qualify(kind, ref) { const { schema, table } = objIdent(kind, ref); return (schema ? quoteIdent(kind, schema) + "." : "") + quoteIdent(kind, table); }
const displayName = (o) => (o.schema ? `${o.schema}.${o.table}` : o.table);
function safeFrag(s, what) {
  const v = String(s || "").trim();
  if (/[;]|--|\/\*/.test(v)) throw new DbError(`Unsafe ${what}: "${s}"`, { type: "invalid" });
  return v;
}
function fmtType(base, len, prec, scale) {
  const b = String(base || "").toLowerCase();
  if (len != null && len > 0 && /char|text|binary|varying/.test(b) && len < 1e9) return `${base}(${len})`;
  if (prec != null && /numeric|decimal|number/.test(b)) return `${base}(${prec}${scale != null ? "," + scale : ""})`;
  return String(base || "");
}

/* ============================== policy (parsed operations) ============================== */
const policyActive = (p) => !!(p && (p.blockDDL || p.blockDrop || p.blockTruncate || p.blockWrite || (p.protectedTables && p.protectedTables.length)));
/* `cls` = { op, drop, truncate, tables, unknown, cteWrite } from sqlscript.classify or an
 * adapter classifier. Throws DbError type "policy" — never lets an unknown mutating
 * construct through while a protection is on. */
function enforcePolicy(conn, cls, label) {
  const p = conn.policy;
  if (!policyActive(p)) return;
  const who = `"${conn.name || conn.id}"`;
  const deny = (what) => { throw new DbError(`Policy: ${what} blocked on ${who}`, { type: "policy", details: label || "" }); };
  if (cls.op === "select" || cls.op === "tx" || (cls.op === "session" && !cls.unknown)) {
    // reads and transaction control are fine; SET/USE are session-local
    return;
  }
  if (p.blockDDL && (cls.op === "ddl" || cls.op === "proc" || cls.op === "admin" || cls.op === "unknown")) deny(cls.op === "ddl" ? "DDL" : `${cls.op === "proc" ? "procedure execution" : cls.op === "admin" ? "administrative commands" : "unrecognised statements"} (DDL protection)`);
  if (p.blockDrop && (cls.drop || cls.op === "unknown" || cls.op === "proc")) deny(cls.drop ? "DROP" : `${cls.op === "proc" ? "procedure execution" : "unrecognised statements"} (DROP protection)`);
  if (p.blockTruncate && (cls.truncate || cls.op === "unknown" || cls.op === "proc")) deny(cls.truncate ? "TRUNCATE" : `${cls.op === "proc" ? "procedure execution" : "unrecognised statements"} (TRUNCATE protection)`);
  if (p.blockWrite && (cls.op === "write" || cls.op === "proc" || cls.op === "admin" || cls.op === "unknown" || cls.cteWrite)) deny(cls.op === "write" || cls.cteWrite ? "write" : `${cls.op === "proc" ? "procedure execution" : cls.op === "admin" ? "administrative commands" : "unrecognised statements"} (write protection)`);
  if (p.protectedTables && p.protectedTables.length && cls.op !== "session") {
    if (cls.op === "unknown" || cls.op === "proc") throw new DbError(`Policy: protected tables are configured — ${cls.op === "proc" ? "procedure execution" : "unrecognised statements"} cannot be checked and are blocked on ${who}`, { type: "policy" });
    const hit = S.touchesProtected(cls, p.protectedTables);
    if (hit) throw new DbError(`Policy: table "${hit}" is protected (read-only)`, { type: "policy" });
  }
}
const tableCls = (op, table, extra = {}) => { const o = table && typeof table === "object" ? table : { table: String(table || "") }; const parts = String(o.table || "").split("."); return { op, tables: [{ name: parts[parts.length - 1], schema: o.schema || "", qualified: displayName({ schema: o.schema || "", table: o.table || "" }), raw: o.table || "" }], drop: false, truncate: false, unknown: false, cteWrite: false, ...extra }; };
// MongoDB: { collection, op, pipeline, command } → policy classification
const MONGO_READ = new Set(["find", "findOne", "distinct", "aggregate", "count", "indexes", "estimatedDocumentCount", "countDocuments"]);
const MONGO_WRITE = new Set(["insertOne", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "bulkWrite"]);
const MONGO_READ_CMDS = new Set(["ping", "count", "listcollections", "listindexes", "collstats", "dbstats", "serverstatus", "buildinfo", "hostinfo", "hello", "ismaster", "find", "aggregate", "distinct", "explain", "getparameter", "connectionstatus", "whatsmyuri", "validate", "listdatabases", "currentop", "top", "profile"]);
function mongoClassify(spec) {
  const op = spec.op || (spec.collection ? "find" : "command");
  const col = spec.collection ? String(spec.collection) : "";
  const cls = tableCls("unknown", col || "(command)");
  if (op === "command" || (!spec.collection && !spec.op)) {
    const cmd = spec.command || spec; const name = Object.keys(cmd || {})[0] || "";
    const n = name.toLowerCase();
    if (n === "drop" || n === "dropdatabase" || n === "dropindexes") return { ...tableCls("ddl", String(cmd[name] || "")), drop: true, truncate: n === "drop" };
    if (n === "create" || n === "createindexes" || n === "collmod" || n === "renamecollection" || n === "convertToCapped") return tableCls("ddl", String(cmd[name] || ""));
    if (MONGO_READ_CMDS.has(n)) return tableCls("select", String(typeof cmd[name] === "string" ? cmd[name] : "(command)"));
    return { ...cls, op: n === "insert" || n === "update" || n === "delete" || n === "findandmodify" ? "write" : "unknown", unknown: !(n === "insert" || n === "update" || n === "delete" || n === "findandmodify") };
  }
  if (op === "aggregate") {
    const out = (spec.pipeline || []).some((st) => st && typeof st === "object" && ("$out" in st || "$merge" in st));
    return tableCls(out ? "write" : "select", col, out ? { cteWrite: true } : {});
  }
  if (MONGO_READ.has(op)) return tableCls("select", col);
  if (MONGO_WRITE.has(op)) return tableCls("write", col);
  if (op === "drop") return { ...tableCls("ddl", col), drop: true, truncate: true };
  if (op === "createIndex" || op === "dropIndex" || op === "createIndexes" || op === "dropIndexes") return { ...tableCls("ddl", col), drop: /drop/i.test(op) };
  return { ...cls, unknown: true };
}
// Redis commands: read / write / admin. FLUSH* is both drop and truncate.
const REDIS_READ = new Set(["GET", "MGET", "GETRANGE", "STRLEN", "EXISTS", "TYPE", "TTL", "PTTL", "KEYS", "SCAN", "HGET", "HGETALL", "HMGET", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSCAN", "HSTRLEN", "LRANGE", "LLEN", "LINDEX", "LPOS", "SMEMBERS", "SCARD", "SISMEMBER", "SMISMEMBER", "SSCAN", "SRANDMEMBER", "ZRANGE", "ZRANGEBYSCORE", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZCARD", "ZSCORE", "ZRANK", "ZREVRANK", "ZCOUNT", "ZSCAN", "ZMSCORE", "XRANGE", "XREVRANGE", "XLEN", "XINFO", "XREAD", "PING", "ECHO", "INFO", "DBSIZE", "TIME", "RANDOMKEY", "OBJECT", "MEMORY", "PFCOUNT", "GEOPOS", "GEODIST", "GEOSEARCH", "GEOHASH", "BITCOUNT", "BITPOS", "GETBIT", "JSON.GET", "JSON.TYPE", "JSON.STRLEN", "JSON.ARRLEN", "JSON.OBJKEYS", "JSON.OBJLEN", "JSON.MGET", "FT.SEARCH", "FT.INFO", "CLIENT", "COMMAND", "LASTSAVE", "ROLE", "WAIT", "LOLWUT", "HELLO", "SELECT", "DUMP", "TOUCH", "SINTER", "SUNION", "SDIFF", "ZINTER", "ZUNION", "ZDIFF", "LCS", "SUBSTR", "GETEX", "GETDEL"]);
const REDIS_ADMIN = new Set(["FLUSHALL", "FLUSHDB", "CONFIG", "SHUTDOWN", "DEBUG", "SAVE", "BGSAVE", "BGREWRITEAOF", "SLAVEOF", "REPLICAOF", "MIGRATE", "CLUSTER", "MODULE", "ACL", "SWAPDB", "MONITOR", "SYNC", "PSYNC", "FAILOVER", "SCRIPT", "FUNCTION", "LATENCY", "SLOWLOG", "RESET"]);
const REDIS_DELETE = new Set(["DEL", "UNLINK", "FLUSHALL", "FLUSHDB", "HDEL", "SREM", "ZREM", "LREM", "XDEL", "ZREMRANGEBYSCORE", "ZREMRANGEBYRANK", "ZREMRANGEBYLEX", "JSON.DEL", "JSON.FORGET"]);
const REDIS_NOKEY = new Set(["PING", "ECHO", "INFO", "DBSIZE", "TIME", "RANDOMKEY", "SCAN", "KEYS", "SELECT", "CLIENT", "COMMAND", "CONFIG", "FLUSHALL", "FLUSHDB", "SHUTDOWN", "DEBUG", "SAVE", "BGSAVE", "LASTSAVE", "ROLE", "WAIT", "MULTI", "EXEC", "DISCARD", "WATCH", "UNWATCH", "AUTH", "HELLO", "QUIT", "RESET", "SWAPDB", "MONITOR", "SCRIPT", "FUNCTION", "EVAL", "EVALSHA", "FT.SEARCH", "FT.INFO", "LOLWUT", "MODULE", "ACL", "CLUSTER", "LATENCY", "SLOWLOG", "OBJECT", "MEMORY"]);
function redisClassify(argv) {
  const name = String(argv[0] || "").toUpperCase();
  const keys = REDIS_NOKEY.has(name) ? [] : (name === "MGET" ? argv.slice(1) : name === "DEL" || name === "UNLINK" || name === "EXISTS" || name === "TOUCH" ? argv.slice(1) : argv[1] != null ? [argv[1]] : []);
  const tables = keys.map((k) => ({ name: String(k), schema: "", qualified: String(k), raw: String(k) }));
  const base = { first: name, tables, unknown: false, cteWrite: false, drop: REDIS_DELETE.has(name), truncate: name === "FLUSHALL" || name === "FLUSHDB" };
  if (!name) return { ...base, op: "unknown", unknown: true };
  if (name === "MULTI" || name === "EXEC" || name === "DISCARD" || name === "WATCH" || name === "UNWATCH") return { ...base, op: "tx", tx: name === "MULTI" ? "begin" : "end" };
  if (REDIS_ADMIN.has(name)) return { ...base, op: "admin" };
  if (REDIS_READ.has(name)) return { ...base, op: "select" };
  if (name === "EVAL" || name === "EVALSHA" || name === "FCALL") return { ...base, op: "proc" };
  return { ...base, op: "write" };
}
// Redis command line → argv (redis-cli quoting): "…" with \" \\ \n \r \t \xHH, '…' literal. Errors on unterminated quotes.
function splitCmd(line) {
  const out = []; const s = String(line || ""); let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    let cur = "";
    if (s[i] === '"') {
      i++; let closed = false;
      while (i < s.length) {
        const c = s[i];
        if (c === "\\" && i + 1 < s.length) {
          const e = s[i + 1];
          if (e === "x" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) { cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 4; continue; }
          cur += e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e === "b" ? "\b" : e === "a" ? "\x07" : e; i += 2; continue;
        }
        if (c === '"') { closed = true; i++; break; }
        cur += c; i++;
      }
      if (!closed) throw new DbError("Unterminated double quote in the Redis command.", { type: "invalid" });
      if (i < s.length && !/\s/.test(s[i])) throw new DbError("A closing quote must be followed by a space.", { type: "invalid" });
    } else if (s[i] === "'") {
      i++; let closed = false;
      while (i < s.length) { if (s[i] === "'") { if (s[i + 1] === "'") { cur += "'"; i += 2; continue; } closed = true; i++; break; } cur += s[i]; i++; }
      if (!closed) throw new DbError("Unterminated single quote in the Redis command.", { type: "invalid" });
      if (i < s.length && !/\s/.test(s[i])) throw new DbError("A closing quote must be followed by a space.", { type: "invalid" });
    } else { while (i < s.length && !/\s/.test(s[i])) { cur += s[i]; i++; } }
    out.push(cur);
  }
  return out;
}
// Quote one argument for the command editor (round-trips through splitCmd).
const redisQuote = (v) => { const s = String(v); return /^[^\s"'\\]+$/.test(s) && s !== "" ? s : '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"'; };

/* ============================== operations (cancel) ============================== */
const ops = new Map();   // opId → { cancel }
function registerOp(opId, cancelFn) { if (opId) ops.set(String(opId), { cancel: cancelFn }); }
function unregisterOp(opId) { if (opId) ops.delete(String(opId)); }
async function cancel(opId) {
  const op = ops.get(String(opId || ""));
  if (!op) return { ok: false, reason: "not-running" };
  try { const r = await op.cancel(); return { ok: r !== false, reason: r === false ? "not-cancellable" : "" }; } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

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

/* ============================== schema (objects) ============================== */
const num = (v) => (v == null || v === "" ? null : (Number.isFinite(+v) ? +v : null));
function finishSchema(items, extra = {}) {
  const tables = items.filter((x) => x.type !== "view").map((x) => x.name);
  const views = items.filter((x) => x.type === "view").map((x) => x.name);
  return { items, tables: [...tables, ...views], tableCount: tables.length, viewCount: views.length, ...extra };
}
const item = (o) => ({ ...o, name: o.name != null ? o.name : displayName(o), table: o.table, schema: o.schema || "" });
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
async function schema(id) {
  const conn = getConn(id);
  return readOp(conn, async (e) => { switch (conn.kind) {
    case "mysql": {
      const [rows] = await e.handle.query({ sql: "SELECT table_name AS name, table_type AS ttype, table_rows AS nrows, (COALESCE(data_length,0)+COALESCE(index_length,0)) AS bytes, engine, table_comment AS comment FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY (table_type = 'VIEW'), table_name", rowsAsArray: false });
      if (!rows.length) { const [[cur]] = await e.handle.query({ sql: "SELECT DATABASE() AS db", rowsAsArray: false }); if (!cur || !cur.db) return finishSchema([], { info: "No database selected — set one on the connection, or run USE <db> in Query." }); }
      return finishSchema(rows.map((r) => item({ table: r.name, type: /VIEW/i.test(r.ttype) ? "view" : "table", rows: num(r.nrows), rowsEstimated: true, bytes: num(r.bytes), engine: r.engine || "", comment: r.comment || "" })));
    }
    case "postgres": {
      const r = await e.handle.query("SELECT n.nspname AS sch, c.relname AS name, CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS ttype, c.reltuples::bigint AS nrows, pg_total_relation_size(c.oid) AS bytes, obj_description(c.oid, 'pg_class') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' ORDER BY ttype, (n.nspname <> 'public'), n.nspname, c.relname");
      return finishSchema(r.rows.map((x) => item({ name: x.sch === "public" ? x.name : `${x.sch}.${x.name}`, schema: x.sch, table: x.name, type: x.ttype, rows: num(x.nrows) != null && +x.nrows >= 0 ? +x.nrows : null, rowsEstimated: true, bytes: num(x.bytes), comment: x.comment || "" })));
    }
    case "oracle": {
      const c = await e.handle.getConnection();
      try {
        const r = await c.execute("SELECT owner, table_name AS name, 'table' AS ttype, num_rows AS nrows FROM all_tables WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') UNION ALL SELECT owner, view_name, 'view', NULL FROM all_views WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') ORDER BY 3, 2", [], { outFormat: e.d.OUT_FORMAT_OBJECT });
        return finishSchema(r.rows.map((x) => item({ table: x.NAME, schema: x.OWNER, name: x.NAME, type: x.TTYPE, rows: num(x.NROWS), rowsEstimated: true })));
      } finally { await c.close().catch(() => {}); }
    }
    case "mongodb": {
      const cols = await e.handle.db(conn.database || undefined).listCollections({}, { nameOnly: true }).toArray();
      return finishSchema(cols.filter((c) => !/^system\./.test(c.name)).map((c) => item({ table: c.name, type: c.type === "view" ? "view" : "collection" })).sort((a, b) => a.name.localeCompare(b.name)));
    }
    case "sqlite": {
      const rows = e.handle.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
      return finishSchema(rows.map((r) => item({ table: r.name, type: r.type === "view" ? "view" : "table" })));
    }
    case "mssql": {
      const r = await e.handle.request().query("SELECT s.name AS sch, t.name AS name, 'table' AS ttype, SUM(p.rows) AS nrows FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1) GROUP BY s.name, t.name UNION ALL SELECT s.name, v.name, 'view', NULL FROM sys.views v JOIN sys.schemas s ON s.schema_id = v.schema_id ORDER BY ttype, sch, name");
      return finishSchema(r.recordset.map((x) => item({ name: x.sch === "dbo" ? x.name : `${x.sch}.${x.name}`, schema: x.sch, table: x.name, type: x.ttype, rows: num(x.nrows), rowsEstimated: true })));
    }
    case "redis": {
      // SCAN pages (never KEYS *). The sidebar shows the first page; `schemaMore` continues the cursor.
      const size = await e.handle.dbSize();
      const page = await redisScan(e, "0", 1000, "");
      return finishSchema(page.items, { info: `${size.toLocaleString()} keys in this database${page.cursor !== "0" ? ` — ${page.items.length.toLocaleString()} loaded so far` : ""}`, keyCount: size, cursor: page.cursor, complete: page.cursor === "0" });
    }
    default: return finishSchema([]);
  } });
}
async function redisScan(e, cursor, want, match) {
  const keys = new Set(); let cur = String(cursor || "0");
  do {
    const r = await e.handle.scan(cur, { COUNT: 500, ...(match ? { MATCH: match } : {}) });
    cur = String(r.cursor); for (const k of r.keys) keys.add(k);
  } while (cur !== "0" && keys.size < want);
  const list = [...keys];
  const m = e.handle.multi(); for (const k of list) m.type(k);
  const types = list.length ? await m.exec() : [];
  return { items: list.map((k, i) => item({ table: k, type: "key", keyType: String(types[i] || "") })).sort((a, b) => a.name.localeCompare(b.name)), cursor: cur };
}
// Continue a Redis key scan (deduplicated by the caller) or search server-side with MATCH.
async function schemaMore(id, { cursor = "0", match = "", want = 1000 } = {}) {
  const conn = getConn(id);
  if (conn.kind !== "redis") throw new DbError("Only Redis key lists page.", { type: "unsupported" });
  return readOp(conn, async (e) => { const p = await redisScan(e, cursor, Math.min(10000, Math.max(1, +want || 1000)), String(match || "")); return { items: p.items, cursor: p.cursor, complete: p.cursor === "0" }; });
}

/* ============================== columns ============================== */
const PG_PK = "EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND k.column_name = c.column_name)";
// Every engine: [{ name, type, nullable, default, key: "PRI"|"", extra, generated? }]
async function columns(id, tableRef) {
  const conn = getConn(id);
  const o = objIdent(conn.kind, tableRef);
  return readOp(conn, async (e) => { switch (conn.kind) {
    case "mysql": {
      const [rows] = await e.handle.query({ sql: "SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_default AS dflt, column_key AS ckey, extra, column_comment AS comment, generation_expression AS gen, collation_name AS coll FROM information_schema.columns WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? ORDER BY ordinal_position", values: [o.schema || null, o.table], rowsAsArray: false });
      return rows.map((r) => ({ name: r.name, type: r.type, nullable: r.nullable === "YES", default: r.dflt, key: r.ckey === "PRI" ? "PRI" : (r.ckey || ""), extra: [r.extra, r.comment].filter(Boolean).join(" · "), generated: r.gen || "", collation: r.coll || "" }));
    }
    case "postgres": {
      const r = await e.handle.query(`SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default, c.character_maximum_length AS len, c.numeric_precision AS prec, c.numeric_scale AS scale, c.is_identity, c.is_generated, ${PG_PK} AS is_pk FROM information_schema.columns c WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position`, [o.schema || "public", o.table]);
      return r.rows.map((x) => ({ name: x.column_name, type: fmtType(x.data_type === "USER-DEFINED" || x.data_type === "ARRAY" ? x.udt_name.replace(/^_/, "") + (x.data_type === "ARRAY" ? "[]" : "") : x.data_type, x.len, x.prec, x.scale), nullable: x.is_nullable === "YES", default: x.column_default, key: x.is_pk ? "PRI" : "", extra: [x.is_identity === "YES" ? "identity" : "", x.is_generated === "ALWAYS" ? "generated" : ""].filter(Boolean).join(" · ") }));
    }
    case "oracle": {
      const c = await e.handle.getConnection();
      try {
        const owner = o.schema || null;
        const sql = "SELECT c.column_name, c.data_type, c.data_length AS len, c.data_precision AS prec, c.data_scale AS scale, c.nullable, c.data_default, (SELECT 'PRI' FROM all_constraints uc JOIN all_cons_columns ucc ON ucc.constraint_name = uc.constraint_name AND ucc.owner = uc.owner WHERE uc.constraint_type = 'P' AND uc.owner = c.owner AND uc.table_name = c.table_name AND ucc.column_name = c.column_name AND ROWNUM = 1) AS keytype FROM all_tab_columns c WHERE c.owner = COALESCE(:o, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AND c.table_name = :t ORDER BY c.column_id";
        let r = await c.execute(sql, { o: owner, t: o.table }, { outFormat: e.d.OUT_FORMAT_OBJECT });
        if (!r.rows.length && o.table !== o.table.toUpperCase()) r = await c.execute(sql, { o: owner, t: o.table.toUpperCase() }, { outFormat: e.d.OUT_FORMAT_OBJECT });
        return r.rows.map((x) => ({ name: x.COLUMN_NAME, type: fmtType(x.DATA_TYPE, /CHAR|RAW/.test(x.DATA_TYPE) ? x.LEN : null, x.PREC, x.SCALE), nullable: x.NULLABLE === "Y", default: x.DATA_DEFAULT == null ? null : String(x.DATA_DEFAULT).trim(), key: x.KEYTYPE || "", extra: "" }));
      } finally { await c.close().catch(() => {}); }
    }
    case "mongodb": {
      const SAMPLE = 200;
      const docs = await e.handle.db(conn.database || undefined).collection(o.table).find({}).limit(SAMPLE).toArray();
      const fields = new Map();
      for (const d0 of docs) for (const [k, v] of Object.entries(d0)) {
        const ty = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? (v._bsontype || "object") : typeof v;
        if (!fields.has(k)) fields.set(k, { types: new Set(), n: 0 });
        fields.get(k).types.add(ty); fields.get(k).n++;
      }
      return [...fields.entries()].map(([name, f]) => ({ name, type: [...f.types].join(" | "), nullable: f.n < docs.length, default: null, key: name === "_id" ? "PRI" : "", extra: `${f.n}/${docs.length} sampled docs`, sampled: docs.length }));
    }
    case "sqlite": {
      const rows = e.handle.prepare(`PRAGMA table_info(${quoteIdent("sqlite", o.table)})`).all();
      return rows.map((r) => ({ name: r.name, type: r.type, nullable: !r.notnull, default: r.dflt_value, key: r.pk ? "PRI" : "", extra: "" }));
    }
    case "mssql": {
      const r = await e.handle.request().input("s", o.schema || "dbo").input("t", o.table).query(`SELECT c.column_name, c.data_type, c.character_maximum_length AS len, c.numeric_precision AS prec, c.numeric_scale AS scale, c.is_nullable, c.column_default, CASE WHEN ${PG_PK} THEN 'PRI' ELSE '' END AS keytype, COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.table_schema) + '.' + QUOTENAME(c.table_name)), c.column_name, 'IsIdentity') AS is_identity FROM information_schema.columns c WHERE c.table_schema = @s AND c.table_name = @t ORDER BY c.ordinal_position`);
      return r.recordset.map((x) => ({ name: x.column_name, type: fmtType(x.data_type, x.len === -1 ? null : x.len, x.prec, x.scale) + (x.len === -1 ? "(max)" : ""), nullable: x.is_nullable === "YES", default: x.column_default, key: x.keytype || "", extra: x.is_identity ? "identity" : "" }));
    }
    default: return [];
  } });
}
// Key metadata for a row mutation: the complete primary key (or null when the table has none).
async function keyColumns(id, tableRef) { const cols = await columns(id, tableRef); const pk = cols.filter((c) => c.key === "PRI").map((c) => c.name); return { pk, cols }; }

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
// Drop the pinned clients of a connection's sessions (after a transport failure) but keep the session ids.
async function dropSessionClients(id) { for (const s of sessions.values()) if (s.id === id && s.client) { const inTx = s.inTx; await releaseSessionClient(s, { rollback: false }).catch(() => {}); s.lostTx = inTx; } }
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
async function sessionSet(sid, patch) { const s = sessions.get(String(sid)); if (!s) throw new DbError("Session not found", { type: "session-gone" }); if (patch && typeof patch.autocommit === "boolean") s.autocommit = patch.autocommit; return sessionState(sid); }
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

/* ============================== column / index DDL ============================== */
const DEFAULT_KEYWORDS = /^(null|true|false|current_timestamp(\(\))?|current_date|current_time|now\(\)|getdate\(\)|sysdate|systimestamp|gen_random_uuid\(\)|newid\(\)|uuid\(\)|localtimestamp)$/i;
// A default: numbers/keywords/(expr) pass through; a quoted 'literal' is already a literal; other text is quoted.
const defaultLit = (kind, v) => (/^-?\d+(\.\d+)?$/.test(v) || DEFAULT_KEYWORDS.test(v) || /^\(.*\)$/.test(v) || /^'(?:[^']|'')*'$/.test(v)) ? v : sqlLiteral(kind, v);
const typeMeta = (kind, base) => (TYPES[kind] || []).find((t) => t.t.toLowerCase() === String(base || "").toLowerCase()) || null;
/* Column type from the form. Inactive parameters (length on a numeric, precision on
 * text …) are IGNORED, never appended: text(10,2) cannot be produced. */
function buildColumnType(kind, col) {
  const raw = String(col.type || "").trim();
  if (!raw) throw new DbError("Column type is required.", { type: "invalid" });
  const base = safeFrag(raw, "type");
  const meta = typeMeta(kind, base);
  const vals = (col.enumValues || []).map((v) => String(v).trim()).filter(Boolean);
  const len = col.length != null && String(col.length).trim() !== "" ? String(col.length).trim() : null;
  const prec = col.precision != null && String(col.precision).trim() !== "" ? +col.precision : null;
  const scale = col.scale != null && String(col.scale).trim() !== "" ? +col.scale : null;
  if (/^(enum|set)$/i.test(base)) {
    if (!vals.length) throw new DbError("Add at least one value for the enum.", { type: "invalid" });
    if (kind === "mysql") return { type: `${base.toUpperCase()}(${vals.map((v) => sqlLiteral("mysql", v)).join(", ")})` };
    if (kind === "postgres") return { type: null, pgEnum: vals };
    const w = Math.max(32, ...vals.map((v) => v.length));
    return { type: kind === "oracle" ? `VARCHAR2(${w})` : kind === "mssql" ? `NVARCHAR(${w})` : "TEXT", check: vals };
  }
  if (/\(/.test(base)) return { type: base };                       // caller already wrote VARCHAR(40)
  const allowLen = meta ? !!meta.len : /char|binary|varying|raw|bit|varchar|nvarchar/i.test(base);
  const allowPrec = meta ? !!meta.prec : /numeric|decimal|number|float/i.test(base);
  if (allowLen && len != null) {
    if (/^max$/i.test(len)) { if (!(meta && meta.max) && kind !== "mssql") throw new DbError("MAX length is SQL Server only.", { type: "invalid" }); return { type: `${base}(MAX)` }; }
    if (!/^\d+$/.test(len)) throw new DbError("Length must be a number.", { type: "invalid" });
    return { type: `${base}(${len})` };
  }
  if (allowPrec && prec != null) { if (!Number.isFinite(prec)) throw new DbError("Precision must be a number.", { type: "invalid" }); return { type: `${base}(${prec}${scale != null && Number.isFinite(scale) ? "," + scale : ""})` }; }
  return { type: base };
}
async function addColumn(id, tableRef, col, { dryRun, expectRev } = {}) {
  const conn = getConn(id, expectRev);
  const o = objIdent(conn.kind, tableRef);
  const name = safeIdent(col.name);
  const nullable = col.nullable !== false;
  const dflt = col.default != null && String(col.default).trim() !== "" ? safeFrag(col.default, "default") : null;
  if (conn.kind === "redis") throw new DbError("Redis has no columns", { type: "unsupported" });
  enforcePolicy(conn, tableCls("ddl", o), "add column");
  if (conn.kind === "mongodb") {
    // Schemaless — "adding a field" seeds it on documents that lack it (a write, policy-checked as DDL+write).
    enforcePolicy(conn, tableCls("write", o), "add field");
    const spec = { collection: o.table, op: "updateMany", filter: { [name]: { $exists: false } }, update: { $set: { [name]: dflt === null ? null : dflt } } };
    if (dryRun) return { ok: true, sql: JSON.stringify(spec, null, 2) };
    const e = await open(conn);
    const r = await e.handle.db(conn.database || undefined).collection(o.table).updateMany(spec.filter, spec.update);
    return { ok: true, message: `Field "${name}" set on ${r.modifiedCount} document(s)`, sql: JSON.stringify(spec) };
  }
  const k = conn.kind;
  const bt = buildColumnType(k, col);
  const stmts = [];
  let typeStr = bt.type;
  if (bt.pgEnum) { const tname = safeIdent(col.enumTypeName || `${o.table.replace(/[^\w]/g, "_")}_${name}_enum`); stmts.push(`CREATE TYPE ${quoteIdent(k, tname)} AS ENUM (${bt.pgEnum.map((v) => sqlLiteral(k, v)).join(", ")})`); typeStr = quoteIdent(k, tname); }
  let def = `${quoteIdent(k, name)} ${typeStr}`;
  if (dflt !== null) def += " DEFAULT " + defaultLit(k, dflt);
  if (!nullable) def += " NOT NULL";
  if (col.unique && k !== "sqlite") def += " UNIQUE";
  if (bt.check) def += ` CHECK (${quoteIdent(k, name)} IN (${bt.check.map((v) => sqlLiteral(k, v)).join(", ")}))`;
  if (col.comment && k === "mysql") def += " COMMENT " + sqlLiteral("mysql", col.comment);
  let alter = k === "oracle" ? `ALTER TABLE ${qualify(k, o)} ADD (${def})` : `ALTER TABLE ${qualify(k, o)} ADD ${k === "mssql" ? "" : "COLUMN "}${def}`;
  if (k === "mysql" && col.after) alter += " AFTER " + quoteIdent("mysql", safeIdent(col.after));
  stmts.push(alter);
  if (col.unique && k === "sqlite") stmts.push(`CREATE UNIQUE INDEX ${quoteIdent(k, `ux_${o.table}_${name}`.replace(/[^\w]/g, "_"))} ON ${qualify(k, o)} (${quoteIdent(k, name)})`);
  if (col.comment && (k === "postgres" || k === "oracle")) stmts.push(`COMMENT ON COLUMN ${qualify(k, o)}.${quoteIdent(k, name)} IS ${sqlLiteral(k, col.comment)}`);
  const sql = stmts.join(";\n");
  if (dryRun) return { ok: true, sql, transactional: TX_DDL.has(k) };
  const res = await applySteps(conn, stmts.map((s, i) => ({ label: i === 0 && bt.pgEnum ? "create enum type" : `add column ${name}`, sql: s })));
  if (!res.ok) throw new DbError(res.error || "Add column failed", { type: "db", details: JSON.stringify(res.steps) });
  return { ok: true, message: `Column "${name}" added`, sql, steps: res.steps };
}
const sqlDropColumn = (k, o, name) => `ALTER TABLE ${qualify(k, o)} DROP COLUMN ${quoteIdent(k, safeIdent(name))}`;
const sqlRenameColumn = (k, o, a, b) => k === "mssql" ? `EXEC sp_rename ${sqlLiteral(k, `${o.schema || "dbo"}.${o.table}.${a}`)}, ${sqlLiteral(k, b)}, 'COLUMN'` : `ALTER TABLE ${qualify(k, o)} RENAME COLUMN ${quoteIdent(k, a)} TO ${quoteIdent(k, b)}`;
const sqlDropIndex = (k, o, name) => (k === "mysql" || k === "mssql") ? `DROP INDEX ${quoteIdent(k, name)} ON ${qualify(k, o)}` : `DROP INDEX ${k === "postgres" ? qualify(k, { schema: o.schema, table: name }) : quoteIdent(k, name)}`;
async function dropColumn(id, tableRef, name, opts = {}) {
  const conn = getConn(id, opts.expectRev); const k = conn.kind; const o = objIdent(k, tableRef);
  enforcePolicy(conn, tableCls("ddl", o), "drop column");
  if (k === "mongodb") { enforcePolicy(conn, tableCls("write", o), "remove field"); const e = await open(conn); const r = await e.handle.db(conn.database || undefined).collection(o.table).updateMany({}, { $unset: { [safeIdent(name)]: "" } }); return { ok: true, message: `Field removed from ${r.modifiedCount} document(s)` }; }
  if (k === "redis") throw new DbError("Redis has no columns", { type: "unsupported" });
  const sql = sqlDropColumn(k, o, name);
  await query(id, sql, {});
  return { ok: true, message: `Column "${name}" dropped`, sql };
}
async function renameColumn(id, tableRef, oldName, newName, opts = {}) {
  const conn = getConn(id, opts.expectRev); const k = conn.kind; const o = objIdent(k, tableRef);
  safeIdent(oldName); safeIdent(newName);
  enforcePolicy(conn, tableCls("ddl", o), "rename column");
  if (k === "mongodb") { enforcePolicy(conn, tableCls("write", o), "rename field"); const e = await open(conn); const r = await e.handle.db(conn.database || undefined).collection(o.table).updateMany({}, { $rename: { [oldName]: newName } }); return { ok: true, message: `Field renamed on ${r.modifiedCount} document(s)` }; }
  if (k === "redis") throw new DbError("Redis has no columns", { type: "unsupported" });
  const sql = sqlRenameColumn(k, o, oldName, newName);
  await query(id, sql, {});
  return { ok: true, message: `Renamed "${oldName}" → "${newName}"`, sql };
}
async function addIndex(id, tableRef, { name, columns: cols, unique } = {}, opts = {}) {
  const conn = getConn(id, opts.expectRev); const k = conn.kind; const o = objIdent(k, tableRef);
  const list = (cols || []).map((c) => safeIdent(c));
  if (!list.length) throw new DbError("Pick at least one column.", { type: "invalid" });
  const ixName = safeIdent(name || `${unique ? "ux" : "ix"}_${o.table.replace(/[^\w]/g, "_")}_${list.join("_")}`.slice(0, 60));
  enforcePolicy(conn, tableCls("ddl", o), "add index");
  if (k === "mongodb") { const e = await open(conn); const spec = Object.fromEntries(list.map((c) => [c, 1])); const r = await e.handle.db(conn.database || undefined).collection(o.table).createIndex(spec, { name: ixName, unique: !!unique }); return { ok: true, message: `Index ${r} created` }; }
  if (k === "redis") throw new DbError("Not applicable to Redis", { type: "unsupported" });
  const sql = `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(k, ixName)} ON ${qualify(k, o)} (${list.map((c) => quoteIdent(k, c)).join(", ")})`;
  await query(id, sql, {});
  return { ok: true, message: `Index "${ixName}" created`, sql };
}
async function dropIndex(id, tableRef, name, opts = {}) {
  const conn = getConn(id, opts.expectRev); const k = conn.kind; const o = objIdent(k, tableRef);
  safeIdent(name);
  enforcePolicy(conn, { ...tableCls("ddl", o), drop: true }, "drop index");
  if (k === "mongodb") { const e = await open(conn); await e.handle.db(conn.database || undefined).collection(o.table).dropIndex(name); return { ok: true, message: `Index "${name}" dropped` }; }
  if (k === "redis") throw new DbError("Not applicable to Redis", { type: "unsupported" });
  const sql = sqlDropIndex(k, o, name);
  await query(id, sql, {});
  return { ok: true, message: `Index "${name}" dropped`, sql };
}

/* ============================== MySQL column order ============================== */
// Full MODIFY COLUMN definition from information_schema (generation expression included).
function mysqlColumnDef(c) {
  const gen = c.generated ? ` GENERATED ALWAYS AS (${c.generated}) ${/STORED/i.test(c.extra || "") ? "STORED" : "VIRTUAL"}` : "";
  let def = `${quoteIdent("mysql", c.name)} ${c.type}${gen}`;
  if (c.collation && /char|text|enum|set/i.test(c.type)) def += ` COLLATE ${safeFrag(c.collation, "collation")}`;
  def += c.nullable ? " NULL" : " NOT NULL";
  const extra = String(c.extra || "").split(" · ")[0] || "";
  if (!c.generated) {
    if (c.default !== null && c.default !== undefined) { const generatedDefault = /DEFAULT_GENERATED/i.test(extra) || /^current_timestamp/i.test(c.default); def += " DEFAULT " + (generatedDefault ? c.default : sqlLiteral("mysql", c.default)); }
    else if (c.nullable && !/auto_increment/i.test(extra)) def += " DEFAULT NULL";
    const ex = extra.replace(/DEFAULT_GENERATED/gi, "").replace(/(VIRTUAL|STORED) GENERATED/gi, "").trim();
    if (ex) def += " " + ex;
  }
  const comment = String(c.extra || "").split(" · ")[1];
  if (comment) def += " COMMENT " + sqlLiteral("mysql", comment);
  return def;
}
async function reorderSql(conn, o, order) {
  const cols = await columns(conn.id, o);
  const byName = new Map(cols.map((c) => [c.name, c]));
  const cur = cols.map((c) => c.name);
  const want = (order || []).map((c) => safeIdent(c));
  if (want.length !== cur.length || new Set(want).size !== want.length || want.some((c) => !byName.has(c))) throw new DbError("The requested order is not a permutation of the table's current columns — refresh and try again.", { type: "invalid" });
  const clauses = []; const sim = [...cur];
  for (let i = 0; i < want.length; i++) {
    if (sim[i] === want[i]) continue;
    const c = want[i]; sim.splice(sim.indexOf(c), 1); sim.splice(i, 0, c);
    clauses.push(`MODIFY COLUMN ${mysqlColumnDef(byName.get(c))} ${i === 0 ? "FIRST" : "AFTER " + quoteIdent("mysql", want[i - 1])}`);
  }
  return clauses.length ? `ALTER TABLE ${qualify("mysql", o)}\n  ${clauses.join(",\n  ")}` : "";
}
async function reorderColumns(id, tableRef, order, { dryRun, expectRev } = {}) {
  const conn = getConn(id, expectRev);
  if (conn.kind !== "mysql") throw new DbError("Only MySQL / MariaDB can reorder columns; other engines fix the column order at creation.", { type: "unsupported" });
  const o = objIdent("mysql", tableRef);
  enforcePolicy(conn, tableCls("ddl", o), "reorder columns");
  const sql = await reorderSql(conn, o, order);
  if (!sql) return { ok: true, sql: "", message: "Column order unchanged" };
  if (dryRun) return { ok: true, sql };
  await query(id, sql, {});
  return { ok: true, sql, message: "Columns reordered" };
}

/* ============================== schema plan (rename / drop / reorder as one reviewed plan) ============================== */
const TX_DDL = new Set(["postgres", "sqlite", "mssql"]);   // engines whose DDL is transactional
/* Execute DDL steps: inside one transaction where the engine supports it, otherwise one
 * by one. Every step reports done / failed / skipped; nothing is hidden. */
async function applySteps(conn, steps) {
  const k = conn.kind;
  const out = steps.map((s) => ({ label: s.label, sql: s.sql, state: "pending", error: "" }));
  const entry = await open(conn);
  if (TX_DDL.has(k)) {
    try {
      await withTx(k, entry, async (run) => { for (let i = 0; i < steps.length; i++) { try { await run(steps[i].sql, null); out[i].state = "done"; } catch (e) { out[i].state = "failed"; out[i].error = String(e.message || e); for (let j = i + 1; j < out.length; j++) out[j].state = "skipped"; throw e; } } });
      return { ok: true, steps: out, transactional: true };
    } catch (e) {
      for (const s of out) if (s.state === "done") s.state = "rolled-back";
      return { ok: false, steps: out, transactional: true, error: String(e.message || e) };
    }
  }
  for (let i = 0; i < steps.length; i++) {
    try { await query(conn.id, steps[i].sql, {}); out[i].state = "done"; }
    catch (e) { out[i].state = "failed"; out[i].error = String(e.message || e); for (let j = i + 1; j < out.length; j++) out[j].state = "skipped"; return { ok: false, steps: out, transactional: false, error: String(e.message || e) }; }
  }
  return { ok: true, steps: out, transactional: false };
}
/* plan = { renames: [[old, new]], drops: [name], dropIndexes: [name], order: [names] | null }.
 * Validated against LIVE metadata; conflicts resolved explicitly (a dropped column's
 * rename is discarded and reported); executed as index drops → renames → column drops →
 * reorder (using the renamed names). dryRun returns the exact steps. */
async function schemaPlan(id, tableRef, plan = {}, { dryRun, expectRev } = {}) {
  const conn = getConn(id, expectRev); const k = conn.kind;
  if (k === "mongodb" || k === "redis") throw new DbError("Schema plans apply to SQL tables.", { type: "unsupported" });
  const o = objIdent(k, tableRef);
  enforcePolicy(conn, { ...tableCls("ddl", o), drop: !!((plan.drops || []).length || (plan.dropIndexes || []).length) }, "schema changes");
  const cols = await columns(id, o);
  const names = new Set(cols.map((c) => c.name));
  const notes = [];
  const drops = [...new Set((plan.drops || []).map(safeIdent))];
  for (const d0 of drops) if (!names.has(d0)) throw new DbError(`Column “${d0}” no longer exists — refresh.`, { type: "invalid" });
  const renames = [];
  const targets = new Set();
  for (const [a, b] of (plan.renames || [])) {
    safeIdent(a); safeIdent(b);
    if (!names.has(a)) throw new DbError(`Column “${a}” no longer exists — refresh.`, { type: "invalid" });
    if (drops.includes(a)) { notes.push(`“${a}” is dropped — its rename to “${b}” was discarded.`); continue; }
    if (a === b) continue;
    if (names.has(b) && !drops.includes(b)) throw new DbError(`A column named “${b}” already exists.`, { type: "invalid" });
    if (targets.has(b)) throw new DbError(`Two columns would be renamed to “${b}”.`, { type: "invalid" });
    targets.add(b); renames.push([a, b]);
  }
  const dropIdx = [...new Set((plan.dropIndexes || []).map(safeIdent))];
  const steps = [];
  for (const x of dropIdx) steps.push({ label: `drop index ${x}`, sql: sqlDropIndex(k, o, x) });
  for (const [a, b] of renames) steps.push({ label: `rename ${a} → ${b}`, sql: sqlRenameColumn(k, o, a, b) });
  for (const d0 of drops) steps.push({ label: `drop column ${d0}`, sql: sqlDropColumn(k, o, d0) });
  let reorder = null;
  if (plan.order && plan.order.length) {
    if (k !== "mysql") throw new DbError("Only MySQL / MariaDB can reorder columns.", { type: "unsupported" });
    const ren = new Map(renames);
    const finalOrder = plan.order.map((c) => ren.get(c) || c).filter((c) => !drops.includes(c) && !drops.includes([...ren.entries()].find(([, v]) => v === c)?.[0]));
    const expected = cols.map((c) => c.name).filter((c) => !drops.includes(c)).map((c) => ren.get(c) || c);
    if (finalOrder.length !== expected.length || new Set(finalOrder).size !== finalOrder.length || finalOrder.some((c) => !expected.includes(c))) throw new DbError("The requested column order does not match the table after the planned changes — refresh and try again.", { type: "invalid" });
    const changed = finalOrder.some((c, i) => c !== expected[i]);
    if (changed) { reorder = finalOrder; steps.push({ label: "reorder columns", sql: "-- computed after the preceding steps run", deferred: true }); }
  }
  if (!steps.length) return { ok: true, steps: [], notes, transactional: TX_DDL.has(k), message: "No changes" };
  if (dryRun) {
    if (reorder && !renames.length && !drops.length) { try { steps[steps.length - 1].sql = await reorderSql(conn, o, reorder) || "-- order unchanged"; } catch (e) { steps[steps.length - 1].sql = "-- " + e.message; } }
    return { ok: true, steps: steps.map((s) => ({ ...s, state: "planned" })), notes, transactional: TX_DDL.has(k) };
  }
  const head = steps.filter((s) => !s.deferred);
  let res = head.length ? await applySteps(conn, head) : { ok: true, steps: [], transactional: TX_DDL.has(k) };
  if (res.ok && reorder) {
    try { const sql = await reorderSql(conn, o, reorder); if (sql) { await query(id, sql, {}); res.steps.push({ label: "reorder columns", sql, state: "done", error: "" }); } else res.steps.push({ label: "reorder columns", sql: "", state: "done", error: "" }); }
    catch (e) { res = { ...res, ok: false, error: String(e.message || e) }; res.steps.push({ label: "reorder columns", sql: "", state: "failed", error: String(e.message || e) }); }
  } else if (!res.ok && reorder) res.steps.push({ label: "reorder columns", sql: "", state: "skipped", error: "" });
  return { ...res, notes };
}

/* ============================== table info ============================== */
function groupFks(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.name)) m.set(r.name, { name: r.name, columns: [], refTable: r.rtable, refSchema: r.rschema || "", refColumns: [], onDelete: r.del || "", onUpdate: r.upd || "" });
    const g = m.get(r.name); g.columns.push(r.col); g.refColumns.push(r.rcol);
  }
  return [...m.values()];
}
function synthDDL(kind, o, cols, indexes, fks) {
  const q = (n) => quoteIdent(kind, n);
  const lines = cols.map((c) => `  ${q(c.name)} ${c.type || ""}${c.nullable === false ? " NOT NULL" : ""}${c.default != null && String(c.default) !== "" ? " DEFAULT " + c.default : ""}`);
  const pk = cols.filter((c) => c.key === "PRI").map((c) => q(c.name));
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  for (const f of fks || []) lines.push(`  CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(", ")}) REFERENCES ${qualify(kind, { schema: f.refSchema, table: f.refTable })} (${f.refColumns.map(q).join(", ")})${f.onDelete && !/no action/i.test(f.onDelete) ? " ON DELETE " + f.onDelete : ""}`);
  let out = `-- APPROXIMATE: generated from catalog metadata (constraints, index options, identity and expressions may be missing). Not a migration source.\nCREATE TABLE ${qualify(kind, o)} (\n${lines.join(",\n")}\n);`;
  for (const ix of indexes || []) if (!ix.primary) out += `\nCREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${q(ix.name)} ON ${qualify(kind, o)} (${ix.columns.map(q).join(", ")});`;
  return out;
}
async function tableInfo(id, tableRef) {
  const conn = getConn(id);
  if (conn.kind === "redis") return { columns: [], indexes: [], foreignKeys: [], ddl: "", rows: null };
  const o = objIdent(conn.kind, tableRef);
  const cols = await columns(id, o);
  return readOp(conn, async (e) => {
    let indexes = [], foreignKeys = [], ddl = "", rows = null, native = false;
    switch (conn.kind) {
      case "mysql": {
        const [ix] = await e.handle.query({ sql: "SHOW INDEX FROM " + qualify("mysql", o), rowsAsArray: false });
        const m = new Map();
        for (const r of ix) { const k = r.Key_name; if (!m.has(k)) m.set(k, { name: k, unique: String(r.Non_unique) === "0", primary: k === "PRIMARY", type: r.Index_type || "", columns: [] }); m.get(k).columns[(+r.Seq_in_index || 1) - 1] = r.Column_name; }
        indexes = [...m.values()].map((x) => ({ ...x, columns: x.columns.filter(Boolean) }));
        const [fk] = await e.handle.query({ sql: "SELECT k.constraint_name AS name, k.column_name AS col, k.referenced_table_schema AS rschema, k.referenced_table_name AS rtable, k.referenced_column_name AS rcol, r.delete_rule AS del, r.update_rule AS upd FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_name = k.constraint_name AND r.constraint_schema = k.constraint_schema WHERE k.table_schema = COALESCE(?, DATABASE()) AND k.table_name = ? AND k.referenced_table_name IS NOT NULL ORDER BY k.constraint_name, k.ordinal_position", values: [o.schema || null, o.table], rowsAsArray: false });
        foreignKeys = groupFks(fk);
        try { const [cr] = await e.handle.query({ sql: "SHOW CREATE TABLE " + qualify("mysql", o), rowsAsArray: false }); const row = cr[0] || {}; ddl = row["Create Table"] || row["Create View"] || Object.values(row)[1] || ""; native = !!ddl; } catch { ddl = ""; }
        break;
      }
      case "postgres": {
        const s = o.schema || "public";
        const ix = await e.handle.query("SELECT i.relname AS name, ix.indisunique AS uniq, ix.indisprimary AS prim, am.amname AS type, pg_get_indexdef(ix.indexrelid) AS def, array_to_string(array_agg(a.attname ORDER BY k.ord), ',') AS cols FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_index ix ON ix.indrelid = t.oid JOIN pg_class i ON i.oid = ix.indexrelid LEFT JOIN pg_am am ON am.oid = i.relam JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum WHERE n.nspname = $1 AND t.relname = $2 GROUP BY i.relname, ix.indisunique, ix.indisprimary, am.amname, ix.indexrelid ORDER BY ix.indisprimary DESC, i.relname", [s, o.table]);
        indexes = ix.rows.map((r) => ({ name: r.name, unique: !!r.uniq, primary: !!r.prim, type: r.type || "", columns: String(r.cols || "").split(",").filter(Boolean), definition: r.def || "" }));
        const fk = await e.handle.query("SELECT con.conname AS name, a.attname AS col, cf.relname AS rtable, nf.nspname AS rsch, af.attname AS rcol, con.confdeltype AS del, con.confupdtype AS upd FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_class cf ON cf.oid = con.confrelid JOIN pg_namespace nf ON nf.oid = cf.relnamespace JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(att, fatt, ord) ON true JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.att JOIN pg_attribute af ON af.attrelid = cf.oid AND af.attnum = k.fatt WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2 ORDER BY con.conname, k.ord", [s, o.table]);
        const ACT = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
        foreignKeys = groupFks(fk.rows.map((r) => ({ name: r.name, col: r.col, rtable: r.rtable, rschema: r.rsch, rcol: r.rcol, del: ACT[r.del] || r.del, upd: ACT[r.upd] || r.upd })));
        break;
      }
      case "oracle": {
        const c = await e.handle.getConnection();
        try {
          const owner = o.schema || null;
          const ix = await c.execute("SELECT i.index_name AS name, i.uniqueness AS uniq, i.index_type AS itype, ic.column_name AS col, (SELECT 'Y' FROM all_constraints uc WHERE uc.owner = i.owner AND uc.index_name = i.index_name AND uc.constraint_type = 'P' AND ROWNUM = 1) AS prim FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name WHERE i.table_owner = COALESCE(:o, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AND i.table_name = :t ORDER BY i.index_name, ic.column_position", { o: owner, t: o.table }, { outFormat: e.d.OUT_FORMAT_OBJECT });
          const m = new Map();
          for (const r of ix.rows) { if (!m.has(r.NAME)) m.set(r.NAME, { name: r.NAME, unique: r.UNIQ === "UNIQUE", primary: r.PRIM === "Y", type: r.ITYPE || "", columns: [] }); m.get(r.NAME).columns.push(r.COL); }
          indexes = [...m.values()];
          const fk = await c.execute("SELECT c.constraint_name AS name, cc.column_name AS col, rc.owner AS rschema, rc.table_name AS rtable, rcc.column_name AS rcol, c.delete_rule AS del FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name JOIN all_constraints rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position WHERE c.constraint_type = 'R' AND c.owner = COALESCE(:o, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AND c.table_name = :t ORDER BY c.constraint_name, cc.position", { o: owner, t: o.table }, { outFormat: e.d.OUT_FORMAT_OBJECT });
          foreignKeys = groupFks(fk.rows.map((r) => ({ name: r.NAME, col: r.COL, rschema: r.RSCHEMA, rtable: r.RTABLE, rcol: r.RCOL, del: r.DEL, upd: "" })));
          try { const d0 = await c.execute("SELECT DBMS_METADATA.GET_DDL('TABLE', :t, :o) AS ddl FROM dual", { t: o.table, o: owner || null }, { outFormat: e.d.OUT_FORMAT_OBJECT, fetchInfo: { DDL: { type: e.d.STRING } } }); ddl = d0.rows[0] ? String(d0.rows[0].DDL || "").trim() : ""; native = !!ddl; } catch { ddl = ""; }
        } finally { await c.close().catch(() => {}); }
        break;
      }
      case "mongodb": {
        const col = e.handle.db(conn.database || undefined).collection(o.table);
        const ix = await col.indexes();
        indexes = ix.map((x) => ({ name: x.name, unique: !!x.unique, primary: x.name === "_id_", type: x.sparse ? "sparse" : (x.expireAfterSeconds != null ? `ttl ${x.expireAfterSeconds}s` : ""), columns: Object.entries(x.key || {}).map(([k, v]) => `${k}${v === -1 ? " desc" : typeof v === "string" ? " " + v : ""}`) }));
        try { rows = await col.estimatedDocumentCount(); } catch { rows = null; }
        break;
      }
      case "sqlite": {
        const q = quoteIdent("sqlite", o.table);
        const il = e.handle.prepare(`PRAGMA index_list(${q})`).all();
        indexes = il.map((x) => ({ name: x.name, unique: !!Number(x.unique), primary: x.origin === "pk", type: x.origin === "u" ? "unique constraint" : x.origin === "pk" ? "primary key" : "", columns: e.handle.prepare(`PRAGMA index_info(${quoteIdent("sqlite", x.name)})`).all().map((c) => c.name) }));
        const fkl = e.handle.prepare(`PRAGMA foreign_key_list(${q})`).all();
        foreignKeys = groupFks(fkl.map((r) => ({ name: `fk_${r.id}`, col: r.from, rtable: r.table, rcol: r.to, del: r.on_delete, upd: r.on_update })));
        const row = e.handle.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(o.table);
        ddl = (row && row.sql) || ""; native = !!ddl;
        break;
      }
      case "mssql": {
        const full = `${quoteIdent("mssql", o.schema || "dbo")}.${quoteIdent("mssql", o.table)}`;
        const ix = await e.handle.request().input("full", full).query("SELECT i.name, i.is_unique AS uniq, i.is_primary_key AS prim, i.type_desc AS itype, c.name AS col FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE i.object_id = OBJECT_ID(@full) AND i.name IS NOT NULL AND ic.key_ordinal > 0 ORDER BY i.name, ic.key_ordinal");
        const m = new Map();
        for (const r of ix.recordset) { if (!m.has(r.name)) m.set(r.name, { name: r.name, unique: !!r.uniq, primary: !!r.prim, type: r.itype || "", columns: [] }); m.get(r.name).columns.push(r.col); }
        indexes = [...m.values()];
        const fk = await e.handle.request().input("full", full).query("SELECT fk.name, pc.name AS col, rs.name AS rsch, rt.name AS rtable, rc.name AS rcol, fk.delete_referential_action_desc AS del, fk.update_referential_action_desc AS upd FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id WHERE fk.parent_object_id = OBJECT_ID(@full) ORDER BY fk.name, fkc.constraint_column_id");
        foreignKeys = groupFks(fk.recordset.map((r) => ({ name: r.name, col: r.col, rschema: r.rsch, rtable: r.rtable, rcol: r.rcol, del: String(r.del || "").replace(/_/g, " "), upd: String(r.upd || "").replace(/_/g, " ") })));
        break;
      }
    }
    if (!ddl && cols.length && conn.kind !== "mongodb") ddl = synthDDL(conn.kind, o, cols, indexes, foreignKeys);
    return { columns: cols, indexes, foreignKeys, ddl, ddlNative: native, rows, object: { schema: o.schema, table: o.table, name: displayName(o) } };
  });
}

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

module.exports = {
  DbError, kinds, list, save, remove, revealSecret, setSessionSecret, test, ping, schema, schemaMore, columns, keyColumns, query, parallelQuery, splitScript, formatSql,
  sessionOpen, sessionClose, sessionSet, sessionState, cancel,
  addColumn, dropColumn, renameColumn, addIndex, dropIndex, reorderColumns, schemaPlan, installDriver, driverInstalled, closeAll, disconnect: closeOne,
  tableInfo, count, browse, insertRow, updateRows, deleteRows, explain,
  // shared with db-io / tests
  quoteIdent, qualify, objIdent, literal: sqlLiteral, sqlLiteral, cell, cellText, bindValue, isTag, buildColumnType, classify: S.classify, splitCmd, redisQuote, mongoClassify, redisClassify, enforcePolicy, tableCls, getConn, open, withTx, ph, TX_DDL, POLICIES,
  __internals: { live, sessions, connect, sessionSecrets, readStore, writeStore, sealSecret, openSecret, mysqlColumnDef, defaultLit },
};
