/* AtomNano renderer — Database Manager — engine constants, number / identifier formatting, SQL · Mongo · Redis statement templates.
 * One of the modules the former single dbm.js was split into (see db/index.js). */

export const DB_COLORS = { mysql: "#4479A1", postgres: "#336791", oracle: "#F80000", mongodb: "#47A248", sqlite: "#6BA5D7", mssql: "#CC2927", redis: "#DC382D" };
export const DB_PLACEHOLDER = {
  mongodb: '{"collection":"users","op":"find","filter":{},"limit":50}\n\nops: find · findOne · distinct · aggregate · count · indexes · insertOne · insertMany · updateOne · updateMany · deleteOne · deleteMany · command',
  redis: 'GET mykey        HGETALL user:1        SET k v        SCAN 0 COUNT 100\nQuote keys with spaces or special characters: GET "my key"   (\\" \\\\ \\n \\xHH escapes)',
  default: "SELECT * FROM …\n\nAny SQL runs here — each statement gets its own result block; a selection runs only the selected text.\nCtrl+Enter runs · Statements are split by the server-side parser (comments, $$ bodies, DELIMITER, GO and / are understood).",
};
export const REDIS_READ = { string: "GET", hash: "HGETALL", list: "LRANGE", set: "SMEMBERS", zset: "ZRANGE", stream: "XRANGE", ReJSON: "JSON.GET", "ReJSON-RL": "JSON.GET" };
export const SCHEMA_KINDS = new Set(["postgres", "mssql", "oracle", "mysql"]);

/* ------------------------------ tiny utils ------------------------------ */
export const fmtNum = (n) => (n == null || !Number.isFinite(+n)) ? "" : (+n >= 1e9 ? (+n / 1e9).toFixed(1) + "B" : +n >= 1e6 ? (+n / 1e6).toFixed(1) + "M" : +n >= 1e4 ? (+n / 1e3).toFixed(0) + "k" : +n >= 1e3 ? (+n / 1e3).toFixed(1) + "k" : String(Math.round(+n)));
export const fmtBytes = (b) => (b == null || !Number.isFinite(+b)) ? "" : (+b >= 1 << 30 ? (+b / (1 << 30)).toFixed(1) + " GB" : +b >= 1 << 20 ? (+b / (1 << 20)).toFixed(1) + " MB" : +b >= 1024 ? (+b / 1024).toFixed(0) + " KB" : +b + " B");
export const fmtInt = (n) => (n == null ? "?" : Number(n).toLocaleString());
export const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const uid = (p = "x") => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
export const errMsg = (e) => String((e && e.message) || e || "");
// Quote an identifier the way the engine expects; "schema.table" splits on schema engines.
export function qIdent(kind, part) { const p = String(part); if (kind === "mysql") return "`" + p.replace(/`/g, "``") + "`"; if (kind === "mssql") return "[" + p.replace(/]/g, "]]") + "]"; return '"' + p.replace(/"/g, '""') + '"'; }
export function qName(kind, it) { const o = objRef(it); if (o.schema && SCHEMA_KINDS.has(kind)) return qIdent(kind, o.schema) + "." + qIdent(kind, o.table); return qIdent(kind, o.table); }
// Structured object reference for IPC: { schema, table } (from an item or a display string).
export const objRef = (it) => (typeof it === "string" ? { schema: "", table: it } : { schema: it.schema || "", table: it.table || it.name });
export const objName = (it) => (typeof it === "string" ? it : it.name || (it.schema ? `${it.schema}.${it.table}` : it.table));
export const sameObj = (a, b) => !!a && !!b && objName(a) === objName(b);
// Redis: quote one argument for the command editor (round-trips through main's parser).
export const redisQuote = (v) => { const s = String(v); return /^[^\s"'\\]+$/.test(s) ? s : '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"'; };
export function defaultQ(conn, item) {
  if (conn.kind === "mongodb") return JSON.stringify({ collection: objName(item), op: "find", filter: {}, limit: 50 }, null, 2);
  if (conn.kind === "redis") { const cmd = (item && REDIS_READ[item.keyType]) || "TYPE"; const k = redisQuote(objName(item)); return cmd === "LRANGE" ? `LRANGE ${k} 0 99` : cmd === "ZRANGE" ? `ZRANGE ${k} 0 99 WITHSCORES` : cmd === "XRANGE" ? `XRANGE ${k} - + COUNT 50` : `${cmd} ${k}`; }
  return `SELECT * FROM ${qName(conn.kind, item)}`;
}
export function insertTemplate(conn, it, cols) {
  if (conn.kind === "mongodb") return JSON.stringify({ collection: objName(it), op: "insertOne", doc: Object.fromEntries((cols || []).filter((c) => c.name !== "_id").map((c) => [c.name, null])) }, null, 2);
  if (conn.kind === "redis") return `SET ${redisQuote(objName(it))} value`;
  const names = (cols || []).filter((c) => !/auto_increment|identity/i.test(c.extra || "")).map((c) => c.name);
  return `INSERT INTO ${qName(conn.kind, it)} (${names.map((c) => qIdent(conn.kind, c)).join(", ")})\nVALUES (${names.map((c) => `/* ${c} */ NULL`).join(", ")})`;
}
