/* AtomNano renderer — Database Manager — typed cells (see main/db VALUES): display text, edit parsing, copy / export text, ordering.
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { toast } from "./state.js";
import { fmtInt } from "./utils.js";

/* ---- typed cells (see db.js VALUES) ---- */
export const isTag = (v) => v && typeof v === "object" && typeof v.$t === "string";
export function display(v) {
  if (v === null || v === undefined) return "NULL";
  if (!isTag(v)) return typeof v === "string" ? v : String(v);
  switch (v.$t) {
    case "bytes": return v.len > 64 ? `<binary ${fmtInt(v.len)} bytes>` : "0x" + b64hex(v.b64);
    case "json": return v.v;
    default: return String(v.v);
  }
}
export function b64hex(b64) { try { return Array.from(atob(b64 || ""), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""); } catch { return ""; } }
// copy/export text: bytes as full hex, everything else canonical
export const cellText = (v) => (v === null || v === undefined ? "" : isTag(v) ? (v.$t === "bytes" ? "0x" + b64hex(v.b64) : String(v.v)) : String(v));
export const cellClass = (v) => (v === null || v === undefined ? " null" : typeof v === "number" ? " num" : isTag(v) ? (v.$t === "bigint" || v.$t === "decimal" || v.$t === "num" ? " num" : v.$t === "bytes" ? " bytes" : v.$t === "json" ? " json" : " tagged") : isJsonish(v) ? " json" : "");
export const cellTitle = (v) => (v === null || v === undefined ? "NULL" : isTag(v) ? `${v.$t}${v.$t === "bytes" ? ` · ${fmtInt(v.len)} bytes` : ""}: ${display(v).slice(0, 300)}` : String(v).slice(0, 400));
export const isJsonish = (v) => typeof v === "string" && /^\s*[[{]/.test(v) && /[\]}]\s*$/.test(v);
export const prettyJson = (v) => { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } };
// The editor text for a cell → the typed value to send back (preserves the original tag kind)
export function parseEdit(raw, cur) {
  if (raw === "NULL") return null;
  if (/^=/.test(raw)) return { raw: raw.slice(1) };
  if (isTag(cur)) {
    if ((cur.$t === "bigint" || cur.$t === "decimal" || cur.$t === "num") && /^-?\d+(\.\d+)?$/.test(raw)) return { $t: cur.$t === "num" ? "decimal" : cur.$t, v: raw };
    if (cur.$t === "oid" && /^[0-9a-f]{24}$/i.test(raw)) return { $t: "oid", v: raw };
    if (cur.$t === "date") return { $t: "date", v: raw };
    if (cur.$t === "json") return { $t: "json", v: raw };
    if (cur.$t === "bytes" && /^0x[0-9a-f]*$/i.test(raw)) { const hex = raw.slice(2); const bytes = hex.match(/../g) || []; return { $t: "bytes", len: bytes.length, b64: btoa(bytes.map((x) => String.fromCharCode(parseInt(x, 16))).join("")) }; }
    return raw;
  }
  if (typeof cur === "number" && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (typeof cur === "boolean" && /^(true|false)$/i.test(raw)) return /^true$/i.test(raw);
  return raw;
}
export function copyText(t, msg) { navigator.clipboard.writeText(t == null ? "" : String(t)).then(() => toast(msg || "Copied", "check")).catch(() => {}); }
export const csvEsc = (v) => { const s = cellText(v); if (v === null || v === undefined) return ""; if (s === "") return '""'; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCSV = (cols, rows) => [cols.map((c) => csvEsc(c)).join(","), ...rows.map((r) => r.map(csvEsc).join(","))].join("\r\n");
export const jsonVal = (v) => (isTag(v) ? (v.$t === "json" ? (() => { try { return JSON.parse(v.v); } catch { return v.v; } })() : v.$t === "bytes" ? { $binary: { base64: v.b64, subType: "00" } } : v.$t === "oid" ? { $oid: v.v } : v.$t === "date" ? { $date: v.v } : v.$t === "bigint" ? { $numberLong: v.v } : v.$t === "decimal" ? { $numberDecimal: v.v } : v.v) : v);
export const toJSON = (cols, rows) => JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, jsonVal(r[i])]))), null, 2);
export const toMD = (cols, rows) => { const e = (v) => (v === null || v === undefined ? "" : cellText(v)).replace(/\|/g, "\\|").replace(/\n/g, " "); return [`| ${cols.map(e).join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(e).join(" | ")} |`)].join("\n"); };
export const toTSV = (cols, rows) => [cols.join("\t"), ...rows.map((r) => r.map((v) => (v == null ? "" : cellText(v).replace(/\t|\n/g, " "))).join("\t"))].join("\n");
export const numOf = (v) => (typeof v === "number" ? v : isTag(v) && (v.$t === "bigint" || v.$t === "decimal" || v.$t === "num") ? Number(v.v) : (typeof v === "string" && v.trim() !== "" && !isNaN(v) ? +v : NaN));
export const cmpVals = (a, b) => {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (isTag(a) && isTag(b) && a.$t === "bigint" && b.$t === "bigint") { try { const x = BigInt(a.v), y = BigInt(b.v); return x < y ? -1 : x > y ? 1 : 0; } catch { /* fall through */ } }
  const an = numOf(a), bn = numOf(b);
  if (!isNaN(an) && !isNaN(bn)) return an - bn;
  return cellText(a).localeCompare(cellText(b), undefined, { numeric: true, sensitivity: "base" });
};
