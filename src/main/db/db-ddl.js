"use strict";
/* Schema changes. Column types are built from the form (inactive parameters are IGNORED, never
 * appended), then add / drop / rename column, add / drop index, MySQL column reordering through full
 * MODIFY COLUMN definitions, and schemaPlan — a reviewed set of renames / drops / reorder validated
 * against LIVE metadata and applied inside one transaction where the engine's DDL is transactional
 * (TX_DDL), otherwise step by step with every outcome (done / failed / skipped) reported. */
const { DbError, TYPES } = require("./db-common");
const { open } = require("./db-connections");
const { getConn } = require("./db-store");
const { sqlLiteral, safeFrag, safeIdent, quoteIdent, qualify, objIdent } = require("./db-values");
const { enforcePolicy, tableCls } = require("./db-policy");
const { withTx } = require("./db-exec");
const { query } = require("./db-query");
const { columns } = require("./db-schema");

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

module.exports = { buildColumnType, addColumn, dropColumn, renameColumn, addIndex, dropIndex, reorderColumns, schemaPlan, TX_DDL, mysqlColumnDef, defaultLit };
