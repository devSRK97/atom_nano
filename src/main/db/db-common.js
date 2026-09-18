"use strict";
/* DBM shared vocabulary: the typed DbError with its transport / auth / permission classification,
 * the engine catalog (KINDS, column TYPES, the POLICIES each engine can enforce) and the small
 * helpers every other db-*.js module needs (app root, ids). Nothing here touches a driver or the
 * connection store, so every sibling can depend on it without a cycle. */
const path = require("path");

const appRoot = () => path.join(__dirname, "..", "..", "..");
const uid = (p = "db") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

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

const VALID_KIND = (k) => Object.prototype.hasOwnProperty.call(KINDS, k);

module.exports = { DbError, isTransport, wrap, KINDS, TYPES, POLICIES, VALID_KIND, appRoot, uid };
