"use strict";
/* The typed wire contract and identifier rules. Driver values become JSON primitives or tagged
 * objects ({ $t: "bigint" | "bytes" | "oid" | "date" | "json" | "decimal" | … }) without ever
 * rounding through Number; the same tags bind back as parameters (bindValue), print as text
 * (cellText) or as dialect literals for exports (sqlLiteral). Identifiers are validated and quoted
 * per engine; a "schema.table" string splits on the FIRST dot only for engines with schemas. */
const { DbError } = require("./db-common");

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

module.exports = { cell, bindValue, cellText, sqlLiteral, isTag, safeIdent, quoteIdent, objIdent, qualify, displayName, safeFrag, fmtType };
