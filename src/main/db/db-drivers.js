"use strict";
/* Engine adapters. Drivers are ordinary npm packages resolved from the app folder at first use
 * (installable from the UI, with the Electron rebuild for native ones — "installed" means the
 * package actually LOADS), and connect() builds the pool / client for one profile per engine.
 * Callers never hold a driver: they get an entry { kind, handle, d, close } that db-connections.js
 * caches, with error listeners attached before the first round trip so idle errors never throw. */
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { DbError, KINDS, appRoot } = require("./db-common");

const POOL_MAX = 4;   // connection budget per profile (server capacity, not local cores)

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

/* ============================== connect (one entry per profile) ============================== */
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

module.exports = { driverInstalled, loadDriver, installDriver, connect };
