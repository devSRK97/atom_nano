"use strict";
/* SQL script tokenizer, splitter and statement classifier (audit DB-006/011/012/026/027).
 *
 * ONE implementation serves the backend (policy decisions, retry classification,
 * preview wrapping, the importer) and — through IPC — the editor, so every path
 * agrees on what a statement is and what it does.
 *
 *   tokenize(sql, dialect)  → tokens with exact source offsets; strings, quoted
 *                              identifiers, comments, dollar quotes and MySQL
 *                              executable comments are single tokens.
 *   splitScript(sql, dialect) → { statements: [{ text, offset, line }], errors }
 *                              Comments inside a statement are kept verbatim
 *                              (they may carry hints); DELIMITER / GO / "/" client
 *                              markers, dollar-quoted bodies, BEGIN…END blocks and
 *                              stored-program bodies are understood per dialect.
 *                              An unterminated construct is an ERROR (nothing is
 *                              silently glued or dropped).
 *   classify(sql, dialect)  → { op, first, tables, mutating, cteWrite, tx, drop,
 *                              truncate, readonly, unknown } for policy/retry.
 *   formatSql(sql, dialect) → keyword casing / line breaks OUTSIDE strings and
 *                              comments only; literal bytes never change. */

const MYSQLISH = new Set(["mysql", "mariadb"]);
const isWordStart = (c) => /[A-Za-z_-￿]/.test(c);
const isWordChar = (c) => /[\w$#-￿]/.test(c);

function tokenize(sql, dialect = "generic") {
  const s = String(sql || "");
  const out = [];
  const errors = [];
  const n = s.length;
  let i = 0;
  const push = (t, start, end) => out.push({ t, v: s.slice(start, end), pos: start });
  while (i < n) {
    const c = s[i], d = s[i + 1];
    // whitespace
    if (/\s/.test(c)) { let j = i + 1; while (j < n && /\s/.test(s[j])) j++; push("ws", i, j); i = j; continue; }
    // line comments: -- (all), # (mysql)
    if ((c === "-" && d === "-") || (c === "#" && MYSQLISH.has(dialect))) { let j = s.indexOf("\n", i); if (j < 0) j = n; push("comment", i, j); i = j; continue; }
    // block comments; MySQL "/*! … */" and "/*+ hint */" are CODE, not commentary
    if (c === "/" && d === "*") {
      const j = s.indexOf("*/", i + 2);
      if (j < 0) { errors.push({ message: "Unterminated block comment", offset: i }); push("comment", i, n); i = n; continue; }
      const exec = s[i + 2] === "!" && MYSQLISH.has(dialect);
      push(exec ? "code" : (s[i + 2] === "+" ? "hint" : "comment"), i, j + 2); i = j + 2; continue;
    }
    // dollar quoting (PostgreSQL): $tag$ … $tag$
    if (c === "$" && dialect === "postgres") {
      const m = /^\$([A-Za-z_][\w]*)?\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const j = s.indexOf(tag, i + tag.length);
        if (j < 0) { errors.push({ message: `Unterminated dollar-quoted string ${tag}`, offset: i }); push("string", i, n); i = n; continue; }
        push("string", i, j + tag.length); i = j + tag.length; continue;
      }
    }
    // strings: '…' ('' doubles; backslash escapes in MySQL and PostgreSQL E'…')
    if (c === "'" || ((c === "N" || c === "n" || c === "E" || c === "e" || c === "B" || c === "b" || c === "X" || c === "x") && d === "'" && (i === 0 || !isWordChar(s[i - 1])))) {
      const start = i; if (c !== "'") i++;
      const escapes = MYSQLISH.has(dialect) || (dialect === "postgres" && /^[Ee]$/.test(c));
      let j = i + 1, closed = false;
      while (j < n) {
        if (escapes && s[j] === "\\") { j += 2; continue; }
        if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } closed = true; j++; break; }
        j++;
      }
      if (!closed) { errors.push({ message: "Unterminated string literal", offset: start }); push("string", start, n); i = n; continue; }
      push("string", start, j); i = j; continue;
    }
    // double quotes: identifier (ANSI) — MySQL treats it as a string; both are one token
    if (c === '"') {
      let j = i + 1, closed = false;
      while (j < n) { if (MYSQLISH.has(dialect) && s[j] === "\\") { j += 2; continue; } if (s[j] === '"') { if (s[j + 1] === '"') { j += 2; continue; } closed = true; j++; break; } j++; }
      if (!closed) { errors.push({ message: "Unterminated quoted identifier", offset: i }); push("ident", i, n); i = n; continue; }
      push(MYSQLISH.has(dialect) ? "string" : "ident", i, j); i = j; continue;
    }
    // backtick identifiers (MySQL / SQLite)
    if (c === "`") {
      let j = i + 1, closed = false;
      while (j < n) { if (s[j] === "`") { if (s[j + 1] === "`") { j += 2; continue; } closed = true; j++; break; } j++; }
      if (!closed) { errors.push({ message: "Unterminated backtick identifier", offset: i }); push("ident", i, n); i = n; continue; }
      push("ident", i, j); i = j; continue;
    }
    // bracket identifiers (SQL Server / SQLite)
    if (c === "[" && (dialect === "mssql" || dialect === "sqlite")) {
      const j = s.indexOf("]", i + 1);
      if (j < 0) { errors.push({ message: "Unterminated [identifier]", offset: i }); push("ident", i, n); i = n; continue; }
      push("ident", i, j + 1); i = j + 1; continue;
    }
    // numbers
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(d || ""))) { let j = i + 1; while (j < n && /[\w.]/.test(s[j])) j++; push("num", i, j); i = j; continue; }
    // words (identifiers / keywords), including @vars, :binds, ?
    if (isWordStart(c) || c === "@" || c === ":") { let j = i + 1; while (j < n && (isWordChar(s[j]) || s[j] === "@" || s[j] === ":")) j++; push("word", i, j); i = j; continue; }
    push("punct", i, i + 1); i++;
  }
  return { tokens: out, errors };
}

const lineOf = (s, offset) => { let l = 1; for (let i = 0; i < offset && i < s.length; i++) if (s.charCodeAt(i) === 10) l++; return l; };
const BLOCK_STARTERS = /^(TRIGGER|PROCEDURE|FUNCTION|EVENT|PACKAGE|TYPE|BODY)$/i;
const ORACLE_BLOCK_FIRST = /^(BEGIN|DECLARE)$/i;

/* Split a script into executable statements for `dialect`. */
function splitScript(sql, dialect = "generic") {
  const s = String(sql || "");
  const { tokens, errors } = tokenize(s, dialect);
  const statements = [];
  let start = -1, end = -1, sawCode = false, depth = 0, inCreateRoutine = false, oracleBlock = false;
  let delimiter = ";";
  let words = [];                       // significant words of the current statement (uppercase)
  const flush = (to) => {
    if (start >= 0 && sawCode) { const text = s.slice(start, to).replace(/\s+$/, ""); if (text.trim()) statements.push({ text, offset: start, line: lineOf(s, start) }); }
    start = -1; end = -1; sawCode = false; depth = 0; inCreateRoutine = false; oracleBlock = false; words = [];
  };
  const atLineStart = (pos) => { let k = pos - 1; while (k >= 0 && (s[k] === " " || s[k] === "\t")) k--; return k < 0 || s[k] === "\n"; };
  const lineOnly = (tok) => { const eol = s.indexOf("\n", tok.pos); const rest = s.slice(tok.pos + tok.v.length, eol < 0 ? s.length : eol); return atLineStart(tok.pos) && /^\s*(--.*)?$/.test(rest); };
  for (let k = 0; k < tokens.length; k++) {
    let tok = tokens[k];
    // A custom delimiter glued to a word ("END$$", "END//"): the word tokenizer swallowed it
    // because $ and / can be identifier characters — split it back into word + delimiter.
    if (delimiter !== ";" && tok.t === "word" && tok.v.length > delimiter.length && tok.v.endsWith(delimiter)) {
      const head = tok.v.slice(0, -delimiter.length);
      tok = { t: "word", v: head, pos: tok.pos };
      tokens.splice(k, 1, tok, { t: "punct", v: delimiter, pos: tok.pos + head.length });
    }
    // MySQL client "DELIMITER xx" line (never sent to the server)
    if (tok.t === "word" && /^DELIMITER$/i.test(tok.v) && MYSQLISH.has(dialect) && atLineStart(tok.pos) && start < 0) {
      const eol = s.indexOf("\n", tok.pos); const line = s.slice(tok.pos, eol < 0 ? s.length : eol);
      const m = /^DELIMITER\s+(\S+)/i.exec(line); if (m) delimiter = m[1];
      // skip the rest of the line
      while (k + 1 < tokens.length && tokens[k + 1].pos < (eol < 0 ? s.length : eol)) k++;
      continue;
    }
    // SQL Server batch separator
    if (dialect === "mssql" && tok.t === "word" && /^GO$/i.test(tok.v) && lineOnly(tok) && depth === 0) { flush(tok.pos); continue; }
    // Oracle: "/" alone on a line ends a block / statement
    if (dialect === "oracle" && tok.t === "punct" && tok.v === "/" && lineOnly(tok)) { flush(tok.pos); continue; }
    if (tok.t === "ws") { if (start >= 0) end = tok.pos + tok.v.length; continue; }
    if (tok.t === "comment") { if (start >= 0) end = tok.pos + tok.v.length; continue; }   // a comment before any code is dropped; inside a statement it is kept
    if (start < 0) { start = tok.pos; }
    sawCode = true; end = tok.pos + tok.v.length;
    if (tok.t === "word") {
      const W = tok.v.toUpperCase();
      words.push(W);
      if (words.length === 1) {
        if (dialect === "oracle" && ORACLE_BLOCK_FIRST.test(W)) oracleBlock = true;
      } else if (words[0] === "CREATE" && BLOCK_STARTERS.test(W) && words.length <= 4) { inCreateRoutine = true; if (dialect === "oracle") oracleBlock = true; }
      if (inCreateRoutine && !oracleBlock) {
        if (W === "BEGIN" || W === "CASE" || W === "LOOP" || W === "REPEAT" || W === "WHILE" || (W === "IF" && !(tokens[k + 2] && /^EXISTS$/i.test(tokens[k + 2].v)))) depth++;
        else if (W === "END") { depth = Math.max(0, depth - 1); if (tokens[k + 2] && /^(IF|LOOP|WHILE|REPEAT|CASE)$/i.test(tokens[k + 2].v || "")) k += 2; }
      }
    }
    // custom delimiter (MySQL) — a word/punct sequence equal to it at depth 0
    if (delimiter !== ";" && s.startsWith(delimiter, tok.pos) && depth === 0 && !oracleBlock) {
      flush(tok.pos);
      // skip tokens covering the delimiter
      const stop = tok.pos + delimiter.length;
      while (k + 1 < tokens.length && tokens[k + 1].pos < stop) k++;
      continue;
    }
    if (delimiter === ";" && tok.t === "punct" && tok.v === ";" && depth === 0 && !oracleBlock) { flush(tok.pos); continue; }
  }
  if (oracleBlock && start >= 0) flush(end);
  else if (start >= 0) { if (depth > 0) errors.push({ message: "Unterminated BEGIN … END block", offset: start }); flush(end); }
  for (const e of errors) e.line = lineOf(s, e.offset);
  return { statements, errors };
}

/* ---------- classification ---------- */
const CLAUSE_TABLE = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE", "USING", "ON"]);
const STOP = new Set(["SELECT", "WHERE", "SET", "VALUES", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "UNION", "EXCEPT", "INTERSECT", "WITH", "AS", "ON", "USING", "RETURNING", "WHEN", "MATCHED", "NOT", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL", "LATERAL", "IF", "EXISTS", "ONLY", "DEFAULT", "PARTITION", "DUAL", "LOCK", "FOR", "FETCH", "TOP", "DISTINCT", "ALL"]);
const unquote = (v) => v.replace(/^[`"[]|[`"\]]$/g, "").replace(/``|""|]]/g, (m) => m[0]);
function classify(sql, dialect = "generic") {
  const { tokens } = tokenize(sql, dialect);
  const sig = tokens.filter((t) => t.t !== "ws" && t.t !== "comment" && t.t !== "hint");
  // leading parentheses / executable comments do not decide the statement kind
  let f = 0; while (f < sig.length && (sig[f].t === "punct" && sig[f].v === "(")) f++;
  const first = sig[f] && sig[f].t === "word" ? sig[f].v.toUpperCase() : (sig[f] && sig[f].t === "code" ? "CODE" : "");
  const second = sig[f + 1] && sig[f + 1].t === "word" ? sig[f + 1].v.toUpperCase() : "";
  const res = { first, op: "unknown", tables: [], mutating: true, readonly: false, cteWrite: false, tx: "", drop: false, truncate: false, unknown: false, sets: false };
  const words = sig.filter((t) => t.t === "word").map((t) => t.v.toUpperCase());
  const hasWord = (w) => words.includes(w);
  const dmlIn = (arr) => arr.find((w) => w === "INSERT" || w === "UPDATE" || w === "DELETE" || w === "MERGE" || w === "REPLACE" || w === "UPSERT");
  const setOp = (op, ro) => { res.op = op; res.readonly = !!ro; res.mutating = !ro; };
  switch (first) {
    case "SELECT": case "VALUES": case "TABLE": case "SHOW": case "DESC": case "DESCRIBE": setOp("select", true); break;
    case "EXPLAIN": { const inner = dmlIn(words.slice(1)); if (inner && !hasWord("SELECT") || (inner && (hasWord("ANALYZE") || hasWord("ANALYSE")))) setOp("write", false); else setOp("select", true); break; }
    case "PRAGMA": { const assign = sig.some((t) => t.t === "punct" && t.v === "="); if (assign) setOp("admin", false); else setOp("select", true); break; }   // PRAGMA x(...) reads; PRAGMA x = y sets
    case "WITH": {
      // top-level statement after the CTE list: skip balanced parens; DML inside a CTE body is a data-modifying CTE
      let depth = 0, top = ""; const bodies = [];
      for (let i = f + 1; i < sig.length; i++) {
        const t = sig[i];
        if (t.t === "punct" && t.v === "(") depth++;
        else if (t.t === "punct" && t.v === ")") depth--;
        else if (t.t === "word") { const W = t.v.toUpperCase(); if (depth > 0) bodies.push(W); else if (depth === 0 && /^(SELECT|INSERT|UPDATE|DELETE|MERGE|REPLACE|VALUES|TABLE)$/.test(W)) { top = W; break; } }
      }
      const inner = dmlIn(bodies);
      if (inner) { res.cteWrite = true; setOp("write", false); }
      else if (top && top !== "SELECT" && top !== "VALUES" && top !== "TABLE") setOp("write", false);
      else if (top) setOp("select", true);
      else { setOp("unknown", false); res.unknown = true; }
      break;
    }
    case "INSERT": case "UPDATE": case "DELETE": case "MERGE": case "REPLACE": case "UPSERT": setOp("write", false); break;
    case "CREATE": case "ALTER": case "DROP": case "TRUNCATE": case "RENAME": case "COMMENT": case "GRANT": case "REVOKE": setOp("ddl", false); res.drop = first === "DROP"; res.truncate = first === "TRUNCATE"; break;
    case "BEGIN": case "START": case "COMMIT": case "ROLLBACK": case "SAVEPOINT": case "RELEASE": case "END":
      if (first === "BEGIN" && dialect === "oracle") { setOp("proc", false); break; }            // PL/SQL anonymous block
      setOp("tx", true); res.tx = first === "BEGIN" || first === "START" ? "begin" : first === "SAVEPOINT" ? "savepoint" : first === "RELEASE" ? "release" : "end"; break;
    case "SET": case "USE": case "RESET": setOp("session", true); res.sets = true; break;
    case "EXEC": case "EXECUTE": case "CALL": case "DO": case "DECLARE": {
      setOp("proc", false);
      if (/^SP_RENAME$/i.test(second) || /^SP_RENAME/i.test(second)) { setOp("ddl", false); }
      break;
    }
    case "LOCK": case "UNLOCK": case "VACUUM": case "ANALYZE": case "ANALYSE": case "OPTIMIZE": case "KILL": case "FLUSH": case "COPY": case "LOAD": case "IMPORT": case "ATTACH": case "DETACH": case "REINDEX": setOp("admin", false); break;
    case "CODE": setOp("unknown", false); res.unknown = true; break;
    default: setOp("unknown", false); res.unknown = true;
  }
  // referenced objects: identifiers after FROM / JOIN / INTO / UPDATE / TABLE / USING / MERGE INTO
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.t !== "word" || !CLAUSE_TABLE.has(t.v.toUpperCase())) continue;
    const W = t.v.toUpperCase();
    if (W === "ON" && !(res.op === "ddl")) continue;                       // "CREATE INDEX x ON t" only
    let j = i + 1;
    // optional qualifiers: IF EXISTS / IF NOT EXISTS / ONLY / TABLE after DROP etc.
    while (j < sig.length && sig[j].t === "word" && /^(IF|NOT|EXISTS|ONLY|TEMPORARY|TEMP|TABLE)$/i.test(sig[j].v)) j++;
    // a list: t1, t2 (FROM) — collect each dotted identifier
    for (;;) {
      if (j >= sig.length) break;
      if (sig[j].t === "punct" && sig[j].v === "(") break;                 // subquery / derived table
      if (!(sig[j].t === "word" || sig[j].t === "ident")) break;
      if (sig[j].t === "word" && STOP.has(sig[j].v.toUpperCase())) break;
      let name = sig[j].v; j++;
      while (j + 1 < sig.length && sig[j].t === "punct" && sig[j].v === "." && (sig[j + 1].t === "word" || sig[j + 1].t === "ident")) { name += "." + sig[j + 1].v; j += 2; }
      const parts = name.split(".").map(unquote);
      res.tables.push({ raw: name, name: parts[parts.length - 1], schema: parts.length > 1 ? parts[parts.length - 2] : "", qualified: parts.join(".") });
      // alias?
      if (j < sig.length && sig[j].t === "word" && /^AS$/i.test(sig[j].v)) j++;
      if (j < sig.length && sig[j].t === "word" && !STOP.has(sig[j].v.toUpperCase()) && !CLAUSE_TABLE.has(sig[j].v.toUpperCase())) j++;   // alias word
      if (j < sig.length && sig[j].t === "punct" && sig[j].v === "," && (W === "FROM" || W === "UPDATE" || W === "TABLE")) { j++; continue; }
      break;
    }
  }
  return res;
}

/* Does `cls` touch a protected object? Names compare case-insensitively on the last
 * segment; a schema-qualified protected entry must match schema + name. */
function touchesProtected(cls, protectedTables) {
  const list = (protectedTables || []).map((s) => String(s || "").trim()).filter(Boolean);
  if (!list.length) return "";
  for (const p of list) {
    const parts = p.split(".").map((x) => x.replace(/^[`"[]|[`"\]]$/g, "").toLowerCase());
    const pName = parts[parts.length - 1], pSchema = parts.length > 1 ? parts[parts.length - 2] : "";
    for (const t of cls.tables) {
      if (t.name.toLowerCase() !== pName) continue;
      if (pSchema && t.schema && t.schema.toLowerCase() !== pSchema) continue;
      return p;
    }
  }
  return "";
}

/* ---------- formatting (never touches literal / comment bytes) ---------- */
const KW = new Set(["SELECT", "FROM", "WHERE", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "JOIN", "ON", "UNION", "ALL", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "ALTER", "DROP", "TABLE", "INDEX", "VIEW", "AND", "OR", "AS", "IN", "IS", "NULL", "NOT", "LIKE", "BETWEEN", "DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END", "WITH", "EXISTS", "DESC", "ASC", "COUNT", "SUM", "AVG", "MIN", "MAX", "RETURNING", "USING", "MERGE", "TRUNCATE", "BEGIN", "COMMIT", "ROLLBACK", "EXPLAIN", "PRIMARY", "KEY", "REFERENCES", "DEFAULT", "UNIQUE", "CONSTRAINT", "FOREIGN", "CHECK", "IF", "TOP", "FETCH", "FIRST", "NEXT", "ROWS", "ONLY"]);
const NEWLINE_BEFORE = new Set(["SELECT", "FROM", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "JOIN", "UNION", "VALUES", "SET", "RETURNING", "AND", "OR"]);
function formatSql(sql, dialect = "generic") {
  const { tokens, errors } = tokenize(sql, dialect);
  if (errors.length) return { ok: false, error: errors[0].message, text: sql };
  let out = "";
  let prevWord = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === "ws") { if (/\n\s*\n/.test(t.v) && out && !out.endsWith("\n")) out += "\n"; else if (out && !/\s$/.test(out)) out += " "; continue; }
    if (t.t === "string" || t.t === "comment" || t.t === "ident" || t.t === "code" || t.t === "hint" || t.t === "num") { out += t.v; if (t.t === "comment" && t.v.startsWith("--")) out += "\n"; prevWord = ""; continue; }
    if (t.t === "word") {
      const W = t.v.toUpperCase();
      const isKw = KW.has(W) && !(prevWord === "." );
      if (isKw && NEWLINE_BEFORE.has(W) && out.trim() && !/\(\s*$/.test(out) && !((W === "BY") ) && !(prevWord === "GROUP" || prevWord === "ORDER")) {
        const indent = (W === "AND" || W === "OR" || W === "ON") ? "  " : "";
        out = out.replace(/\s+$/, "") + "\n" + indent;
      }
      out += isKw ? W : t.v;
      prevWord = W;
      continue;
    }
    // punctuation
    if (t.v === ",") { out = out.replace(/\s+$/, "") + ", "; prevWord = ""; continue; }
    if (t.v === "(" || t.v === ")") { if (t.v === "(" && /[A-Za-z_)\]"`]\s$/.test(out) && !KW.has(prevWord)) out = out.replace(/\s+$/, ""); out += t.v; prevWord = t.v; continue; }
    if (t.v === ";") { out = out.replace(/\s+$/, "") + ";\n"; prevWord = ""; continue; }
    if (t.v === ".") { out = out.replace(/\s+$/, "") + "."; prevWord = "."; continue; }
    out += t.v; prevWord = t.v;
  }
  return { ok: true, text: out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "") };
}

module.exports = { tokenize, splitScript, classify, touchesProtected, formatSql };
