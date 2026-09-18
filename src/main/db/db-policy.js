"use strict";
/* Protections, enforced in main on PARSED operations. SQL arrives classified by sqlscript; MongoDB
 * specs and Redis argv are classified here into the same shape, and enforcePolicy() blocks DDL,
 * DROP, TRUNCATE, writes and protected tables — refusing an unknown mutating construct while a
 * protection is on rather than letting it through. The redis-cli style command splitter lives here
 * because classification of a Redis command starts from its argv. */
const { DbError } = require("./db-common");
const S = require("./sqlscript");
const { displayName } = require("./db-values");

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

module.exports = { enforcePolicy, tableCls, mongoClassify, redisClassify, splitCmd, redisQuote };
