"use strict";
/* Parses an import file OFF the Electron main thread (audit DB-038): CSV/TSV/text,
 * XLSX (bounded zip expansion) or a SQL script (dialect-aware split). Input via
 * workerData { file, ext, dialect, encoding, sheet }; output posted once. */
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const F = require("./db-formats");
const S = require("./sqlscript");

try {
  const { file, ext, dialect, encoding, sheet } = workerData;
  const buf = fs.readFileSync(file);
  if (ext === ".sql") {
    const text = F.decodeText(buf, encoding);
    const r = S.splitScript(text, dialect || "generic");
    parentPort.postMessage({ ok: true, type: "sql", statements: r.statements, errors: r.errors, bytes: buf.length });
  } else if (ext === ".xlsx") {
    const r = F.xlsxRead(buf, { sheet: sheet == null ? 0 : sheet });
    parentPort.postMessage({ ok: true, type: "table", rows: r.rows, sheets: r.sheets, sheet: r.sheet, date1904: r.date1904, errorCells: r.errorCells, bigNumbers: r.bigNumbers, bytes: buf.length });
  } else {
    const text = F.decodeText(buf, encoding);
    const r = F.csvParse(text);
    parentPort.postMessage({ ok: true, type: "table", rows: r.rows, delim: r.delim, blankLines: r.blankLines, quotedEmpty: r.quotedEmpty, bytes: buf.length });
  }
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e), type: (e && e.type) || "format", line: e && e.line });
}
