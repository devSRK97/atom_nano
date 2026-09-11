"use strict";
/* Pure file-format codecs for DBM import/export (no Electron, no drivers) — shared by
 * db-io.js (main) and db-io-worker.js (parsing off the main thread).
 *
 *   ZIP    deflate/store only, CRC verified, bounded entry count / expanded size.
 *   XLSX   minimal OOXML: shared/inline strings, numbers (lossless past 15 digits),
 *          booleans, dates honouring the 1900/1904 systems, sheet selection, formula
 *          error cells reported (not silently turned into a value). Writing REFUSES
 *          text over Excel's 32 767-character cell limit and > 1 048 575 data rows
 *          instead of truncating.
 *   CSV    RFC-style parser with exact errors for malformed quotes; unquoted empty
 *          → null candidate, quoted empty → "" (they round-trip through csvSerialize).
 *   Text   BOM-aware decoding (UTF-8 / UTF-16 LE / UTF-16 BE) or an explicit encoding. */
const zlib = require("zlib");

class FormatError extends Error { constructor(message, extra = {}) { super(message); this.name = "FormatError"; this.type = extra.type || "format"; Object.assign(this, extra); } }

/* ============================== ZIP ============================== */
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function dosTime(d) { return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff; }
function dosDate(d) { return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff; }
function zipSync(entries) {
  const now = new Date(), locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8"), data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime(now), 10); lh.writeUInt16LE(dosDate(now), 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime(now), 12); ch.writeUInt16LE(dosDate(now), 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}
// zip Buffer → Map(name → Buffer). Bounded: entry count, declared + actual expanded bytes, CRC.
function unzipSync(buf, { maxEntries = 10000, maxExpanded = 1536 * 1024 * 1024 } = {}) {
  const out = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new FormatError("Not a zip / xlsx file (no end-of-central-directory record).");
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  if (n > maxEntries) throw new FormatError(`Archive has ${n} entries (limit ${maxEntries}).`);
  let expanded = 0;
  for (let i = 0; i < n; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new FormatError("Damaged zip central directory.");
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    if (lho + 30 > buf.length) throw new FormatError(`Damaged zip entry ${name}.`);
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    if (start + csize > buf.length) throw new FormatError(`Truncated zip entry ${name}.`);
    expanded += usize;
    if (expanded > maxExpanded) throw new FormatError(`Archive expands beyond ${Math.round(maxExpanded / 1048576)} MB — too large to import in one piece.`);
    const data = buf.slice(start, start + csize);
    let content;
    if (method === 8) { try { content = zlib.inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) }); } catch (e) { throw new FormatError(`Cannot inflate ${name}: ${e.message}`); } }
    else if (method === 0) content = Buffer.from(data);
    else throw new FormatError(`Unsupported zip compression method ${method} for ${name}.`);
    if (content.length !== usize) throw new FormatError(`Size mismatch in ${name} (declared ${usize}, got ${content.length}).`);
    if (crc32(content) !== crc) throw new FormatError(`CRC mismatch in ${name} — the archive is corrupt.`);
    out.set(name, content);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/* ============================== XLSX ============================== */
const XLSX_TEXT_LIMIT = 32767;
const XLSX_MAX_ROWS = 1048576;
const XLSX_MAX_COLS = 16384;
const xmlEsc = (s) => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xmlUnesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");
function colLetter(i) { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function colIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
const isTag = (v) => v && typeof v === "object" && typeof v.$t === "string";
// wire cell → text for spreadsheets / CSV (bytes as 0x…, others as their canonical text)
function cellText(v) { if (v === null || v === undefined) return null; if (!isTag(v)) return typeof v === "string" ? v : String(v); if (v.$t === "bytes") return "0x" + Buffer.from(v.b64 || "", "base64").toString("hex"); return String(v.v); }
/* Write a workbook. `toText` converts non-primitive cells. Throws FormatError (with the
 * offending cell address) rather than truncating text or dropping rows. */
function xlsxWrite(columns, rows, sheetName = "Sheet1", { toText = cellText } = {}) {
  if (rows.length > XLSX_MAX_ROWS - 1) throw new FormatError(`Excel worksheets hold at most ${(XLSX_MAX_ROWS - 1).toLocaleString()} data rows; this export has ${rows.length.toLocaleString()}. Use CSV or JSON, or export a filtered range.`, { type: "format-limit" });
  if (columns.length > XLSX_MAX_COLS) throw new FormatError(`Excel worksheets hold at most ${XLSX_MAX_COLS} columns.`, { type: "format-limit" });
  const cellXml = (r, c, v, style) => {
    const ref = `${colLetter(c)}${r}`; const s = style ? ` s="${style}"` : "";
    if (v === null || v === undefined) return "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    if (typeof v === "boolean") return `<c r="${ref}" t="b"${s}><v>${v ? 1 : 0}</v></c>`;
    if (isTag(v) && (v.$t === "bigint" || v.$t === "decimal" || v.$t === "num")) { const str = String(v.v); return /^-?\d{1,15}(\.\d+)?$/.test(str) ? `<c r="${ref}"${s}><v>${str}</v></c>` : `<c r="${ref}" t="inlineStr"${s}><is><t>${xmlEsc(str)}</t></is></c>`; }   // > 15 digits: keep as text (Excel would round)
    const text = toText(v);
    if (text.length > XLSX_TEXT_LIMIT) throw new FormatError(`Cell ${ref} holds ${text.length.toLocaleString()} characters; Excel cells are limited to ${XLSX_TEXT_LIMIT.toLocaleString()}. Export as CSV or JSON to keep the full text.`, { type: "format-limit", cell: ref });
    return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
  };
  const parts = [`<row r="1">${columns.map((c, i) => cellXml(1, i, String(c), 1)).join("")}</row>`];
  rows.forEach((row, ri) => { parts.push(`<row r="${ri + 2}">${row.map((v, ci) => cellXml(ri + 2, ci, v)).join("")}</row>`); });
  const widths = columns.map((c, ci) => { let m = String(c).length; for (let i = 0; i < Math.min(rows.length, 200); i++) { const v = rows[i][ci]; const t = v == null ? "" : (toText(v) || ""); if (t.length > m) m = t.length; } return Math.min(60, Math.max(8, m + 2)); });
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${parts.join("")}</sheetData></worksheet>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0"/><xf fontId="1" fillId="0" borderId="0" applyFont="1"/></cellXfs></styleSheet>`;
  return zipSync([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: wb },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: styles },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}
// Excel serial → ISO date/datetime text for the given date system.
function excelDate(n, date1904) {
  const epoch = date1904 ? 24107 : 25569;   // days from 1899-12-30 / 1904-01-01 to 1970-01-01
  const ms = Math.round((n - epoch) * 86400 * 1000); const d = new Date(ms);
  if (isNaN(d)) return n;
  return n % 1 === 0 ? d.toISOString().slice(0, 10) : d.toISOString().replace("T", " ").slice(0, 19);
}
/* Read one worksheet: { rows, sheets: [{ name }], sheet, date1904, errorCells, truncatedNumbers }.
 * `sheet` selects by 0-based index or name (default: first). */
function xlsxRead(buf, { sheet = 0, limits } = {}) {
  const files = unzipSync(buf, limits);
  const text = (n) => { const b = files.get(n); return b ? b.toString("utf8") : ""; };
  const wb = text("xl/workbook.xml"); const rels = text("xl/_rels/workbook.xml.rels");
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/i.test(wb);
  const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({ name: xmlUnesc((/\bname="([^"]*)"/.exec(m[1]) || [])[1] || ""), rid: (/\br:id="([^"]+)"/.exec(m[1]) || [])[1] || "" }));
  const relTarget = (rid) => { const m = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels) || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels); return m ? "xl/" + m[1].replace(/^\/?xl\//, "").replace(/^\//, "") : ""; };
  let idx = typeof sheet === "number" ? sheet : sheets.findIndex((s) => s.name === String(sheet));
  if (idx < 0 || idx >= Math.max(1, sheets.length)) throw new FormatError(`Worksheet ${JSON.stringify(sheet)} not found. Available: ${sheets.map((s) => s.name).join(", ") || "(unnamed)"}`);
  let sheetPath = sheets[idx] ? relTarget(sheets[idx].rid) : "";
  if (!sheetPath || !files.has(sheetPath)) { const any = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[idx] || [...files.keys()].find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)); if (!any) throw new FormatError("The workbook has no worksheet data."); sheetPath = any; }
  const sst = []; const ss = text("xl/sharedStrings.xml");
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) sst.push(xmlUnesc([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const styles = text("xl/styles.xml");
  const customDate = new Set([...styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].filter((m) => /[dmyh]/i.test(m[2].replace(/\[[^\]]*\]|"[^"]*"/g, "")) && !/[#0]/.test(m[2].replace(/\[[^\]]*\]|"[^"]*"/g, ""))).map((m) => +m[1]));
  const xfs = [...((/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles) || [])[1] || "").matchAll(/<xf\b([^>]*)>/g)].map((m) => +((/numFmtId="(\d+)"/.exec(m[1]) || [])[1] || 0));
  const isDateStyle = (s) => { const id = xfs[s]; return id != null && ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || customDate.has(id)); };
  const sheetXml = text(sheetPath);
  const rows = []; let errorCells = 0, bigNumbers = 0;
  for (const rm of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || "";
      const ref = (/\br="([A-Z]+)\d+"/.exec(attrs) || [])[1]; const t = (/\bt="(\w+)"/.exec(attrs) || [])[1] || ""; const s = +((/\bs="(\d+)"/.exec(attrs) || [])[1] || -1);
      const ci = ref ? colIndex(ref) : row.length;
      if (ci >= XLSX_MAX_COLS) throw new FormatError(`Cell reference ${ref} is beyond Excel's column limit.`);
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let val = null;
      if (t === "s") val = sst[+v] ?? null;
      else if (t === "inlineStr") val = xmlUnesc([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
      else if (t === "str") val = v == null ? null : xmlUnesc(v);
      else if (t === "b") val = v === "1";
      else if (t === "e") { errorCells++; val = null; }
      else if (v != null) {
        const raw = String(v).trim();
        if (/^-?\d+$/.test(raw) && raw.replace("-", "").length > 15) { bigNumbers++; val = raw; }   // keep exact digits Excel itself cannot represent
        else { const n = Number(raw); val = Number.isFinite(n) ? (s >= 0 && isDateStyle(s) ? excelDate(n, date1904) : n) : xmlUnesc(raw); }
      }
      while (row.length < ci) row.push(null);
      row[ci] = val;
    }
    rows.push(row);
    if (rows.length > XLSX_MAX_ROWS) throw new FormatError("Worksheet has more rows than Excel allows — the file is not a valid workbook.");
  }
  return { rows, sheets: sheets.map((s) => ({ name: s.name })), sheet: idx, date1904, errorCells, bigNumbers };
}

/* ============================== text decoding ============================== */
function decodeText(buf, encoding) {
  if (!Buffer.isBuffer(buf)) return String(buf);
  const enc = String(encoding || "auto").toLowerCase();
  if (enc === "utf16le" || (enc === "auto" && buf[0] === 0xff && buf[1] === 0xfe)) return buf.slice(buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0).toString("utf16le");
  if (enc === "utf16be" || (enc === "auto" && buf[0] === 0xfe && buf[1] === 0xff)) { const b = Buffer.from(buf.slice(buf[0] === 0xfe && buf[1] === 0xff ? 2 : 0)); for (let i = 0; i + 1 < b.length; i += 2) { const x = b[i]; b[i] = b[i + 1]; b[i + 1] = x; } return b.toString("utf16le"); }
  if (enc === "latin1" || enc === "windows-1252") return buf.toString("latin1");
  return buf.toString("utf8").replace(/^﻿/, "");
}

/* ============================== CSV ============================== */
function detectDelim(line) { const c = { ",": 0, ";": 0, "\t": 0, "|": 0 }; let q = false; for (const ch of line) { if (ch === '"') q = !q; else if (!q && ch in c) c[ch]++; } return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; }
/* Parse delimited text. Cells: unquoted empty → null (no value), quoted "" → "" (empty
 * string). Blank lines are skipped and counted. Malformed quoting is an error with
 * the line number — never accepted silently. */
function csvParse(text, { delim } = {}) {
  text = String(text).replace(/^﻿/, "");
  const d = delim || detectDelim(text.split(/\r?\n/, 1)[0] || "");
  const rows = []; let row = [], cur = "", q = false, quoted = false, line = 1, blank = 0, quotedEmpty = 0, cellStartLine = 1;
  const endCell = () => { row.push(quoted ? cur : (cur === "" ? null : cur)); if (quoted && cur === "") quotedEmpty++; cur = ""; quoted = false; };
  const endRow = () => { endCell(); if (row.length === 1 && row[0] === null) blank++; else rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else { q = false; const nx = text[i + 1]; if (nx !== undefined && nx !== d && nx !== "\n" && nx !== "\r") throw new FormatError(`Malformed CSV at line ${line}: text after a closing quote.`, { line }); } }
      else { if (ch === "\n") line++; cur += ch; }
      continue;
    }
    if (ch === '"') { if (cur !== "") throw new FormatError(`Malformed CSV at line ${line}: a quote inside an unquoted field.`, { line }); q = true; quoted = true; cellStartLine = line; continue; }
    if (ch === d) { endCell(); continue; }
    if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; endRow(); line++; continue; }
    cur += ch;
  }
  if (q) throw new FormatError(`Malformed CSV: the quoted field starting on line ${cellStartLine} is never closed.`, { line: cellStartLine });
  if (cur !== "" || row.length || quoted) endRow();
  return { rows, delim: d, blankLines: blank, quotedEmpty };
}
// Serialize rows for CSV. NULL → empty (unquoted); "" → "" (quoted) so both round-trip.
const csvField = (v, toText) => { if (v === null || v === undefined) return ""; const s = toText(v); if (s === "") return '""'; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function csvLine(values, { toText = cellText } = {}) { return values.map((v) => csvField(v, toText)).join(","); }

module.exports = { FormatError, crc32, zipSync, unzipSync, xlsxWrite, xlsxRead, excelDate, decodeText, detectDelim, csvParse, csvLine, cellText, XLSX_TEXT_LIMIT, XLSX_MAX_ROWS };
