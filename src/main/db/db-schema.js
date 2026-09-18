"use strict";
/* Catalog introspection per engine: objects (tables / views / collections / Redis key pages via
 * SCAN, never KEYS *), columns with the primary key flagged (the identity every row mutation
 * depends on) and tableInfo (indexes, foreign keys, native or synthesised DDL). Every read goes
 * through readOp, so a transport hiccup retries once — catalog reads are always safe to repeat. */
const { DbError } = require("./db-common");
const { getConn } = require("./db-store");
const { displayName, objIdent, quoteIdent, qualify, fmtType } = require("./db-values");
const { readOp } = require("./db-exec");

/* ============================== schema (objects) ============================== */
const num = (v) => (v == null || v === "" ? null : (Number.isFinite(+v) ? +v : null));
function finishSchema(items, extra = {}) {
  const tables = items.filter((x) => x.type !== "view").map((x) => x.name);
  const views = items.filter((x) => x.type === "view").map((x) => x.name);
  return { items, tables: [...tables, ...views], tableCount: tables.length, viewCount: views.length, ...extra };
}
const item = (o) => ({ ...o, name: o.name != null ? o.name : displayName(o), table: o.table, schema: o.schema || "" });
async function schema(id) {
  const conn = getConn(id);
  return readOp(conn, async (e) => { switch (conn.kind) {
    case "mysql": {
      const [rows] = await e.handle.query({ sql: "SELECT table_name AS name, table_type AS ttype, table_rows AS nrows, (COALESCE(data_length,0)+COALESCE(index_length,0)) AS bytes, engine, table_comment AS comment FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY (table_type = 'VIEW'), table_name", rowsAsArray: false });
      if (!rows.length) { const [[cur]] = await e.handle.query({ sql: "SELECT DATABASE() AS db", rowsAsArray: false }); if (!cur || !cur.db) return finishSchema([], { info: "No database selected — set one on the connection, or run USE <db> in Query." }); }
      return finishSchema(rows.map((r) => item({ table: r.name, type: /VIEW/i.test(r.ttype) ? "view" : "table", rows: num(r.nrows), rowsEstimated: true, bytes: num(r.bytes), engine: r.engine || "", comment: r.comment || "" })));
    }
    case "postgres": {
      const r = await e.handle.query("SELECT n.nspname AS sch, c.relname AS name, CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS ttype, c.reltuples::bigint AS nrows, pg_total_relation_size(c.oid) AS bytes, obj_description(c.oid, 'pg_class') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' ORDER BY ttype, (n.nspname <> 'public'), n.nspname, c.relname");
      return finishSchema(r.rows.map((x) => item({ name: x.sch === "public" ? x.name : `${x.sch}.${x.name}`, schema: x.sch, table: x.name, type: x.ttype, rows: num(x.nrows) != null && +x.nrows >= 0 ? +x.nrows : null, rowsEstimated: true, bytes: num(x.bytes), comment: x.comment || "" })));
    }
    case "oracle": {
      const c = await e.handle.getConnection();
      try {
        const r = await c.execute("SELECT owner, table_name AS name, 'table' AS ttype, num_rows AS nrows FROM all_tables WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') UNION ALL SELECT owner, view_name, 'view', NULL FROM all_views WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') ORDER BY 3, 2", [], { outFormat: e.d.OUT_FORMAT_OBJECT });
        return finishSchema(r.rows.map((x) => item({ table: x.NAME, schema: x.OWNER, name: x.NAME, type: x.TTYPE, rows: num(x.NROWS), rowsEstimated: true })));
      } finally { await c.close().catch(() => {}); }
    }
    case "mongodb": {
      const cols = await e.handle.db(conn.database || undefined).listCollections({}, { nameOnly: true }).toArray();
      return finishSchema(cols.filter((c) => !/^system\./.test(c.name)).map((c) => item({ table: c.name, type: c.type === "view" ? "view" : "collection" })).sort((a, b) => a.name.localeCompare(b.name)));
    }
    case "sqlite": {
      const rows = e.handle.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
      return finishSchema(rows.map((r) => item({ table: r.name, type: r.type === "view" ? "view" : "table" })));
    }
    case "mssql": {
      const r = await e.handle.request().query("SELECT s.name AS sch, t.name AS name, 'table' AS ttype, SUM(p.rows) AS nrows FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1) GROUP BY s.name, t.name UNION ALL SELECT s.name, v.name, 'view', NULL FROM sys.views v JOIN sys.schemas s ON s.schema_id = v.schema_id ORDER BY ttype, sch, name");
      return finishSchema(r.recordset.map((x) => item({ name: x.sch === "dbo" ? x.name : `${x.sch}.${x.name}`, schema: x.sch, table: x.name, type: x.ttype, rows: num(x.nrows), rowsEstimated: true })));
    }
    case "redis": {
      // SCAN pages (never KEYS *). The sidebar shows the first page; `schemaMore` continues the cursor.
      const size = await e.handle.dbSize();
      const page = await redisScan(e, "0", 1000, "");
      return finishSchema(page.items, { info: `${size.toLocaleString()} keys in this database${page.cursor !== "0" ? ` — ${page.items.length.toLocaleString()} loaded so far` : ""}`, keyCount: size, cursor: page.cursor, complete: page.cursor === "0" });
    }
    default: return finishSchema([]);
  } });
}
async function redisScan(e, cursor, want, match) {
  const keys = new Set(); let cur = String(cursor || "0");
  do {
    const r = await e.handle.scan(cur, { COUNT: 500, ...(match ? { MATCH: match } : {}) });
    cur = String(r.cursor); for (const k of r.keys) keys.add(k);
  } while (cur !== "0" && keys.size < want);
  const list = [...keys];
  const m = e.handle.multi(); for (const k of list) m.type(k);
  const types = list.length ? await m.exec() : [];
  return { items: list.map((k, i) => item({ table: k, type: "key", keyType: String(types[i] || "") })).sort((a, b) => a.name.localeCompare(b.name)), cursor: cur };
}
// Continue a Redis key scan (deduplicated by the caller) or search server-side with MATCH.
async function schemaMore(id, { cursor = "0", match = "", want = 1000 } = {}) {
  const conn = getConn(id);
  if (conn.kind !== "redis") throw new DbError("Only Redis key lists page.", { type: "unsupported" });
  return readOp(conn, async (e) => { const p = await redisScan(e, cursor, Math.min(10000, Math.max(1, +want || 1000)), String(match || "")); return { items: p.items, cursor: p.cursor, complete: p.cursor === "0" }; });
}

/* ============================== columns ============================== */
const PG_PK = "EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND k.column_name = c.column_name)";
// Every engine: [{ name, type, nullable, default, key: "PRI"|"", extra, generated? }]
async function columns(id, tableRef) {
  const conn = getConn(id);
  const o = objIdent(conn.kind, tableRef);
  return readOp(conn, async (e) => { switch (conn.kind) {
    case "mysql": {
      const [rows] = await e.handle.query({ sql: "SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_default AS dflt, column_key AS ckey, extra, column_comment AS comment, generation_expression AS gen, collation_name AS coll FROM information_schema.columns WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? ORDER BY ordinal_position", values: [o.schema || null, o.table], rowsAsArray: false });
      return rows.map((r) => ({ name: r.name, type: r.type, nullable: r.nullable === "YES", default: r.dflt, key: r.ckey === "PRI" ? "PRI" : (r.ckey || ""), extra: [r.extra, r.comment].filter(Boolean).join(" · "), generated: r.gen || "", collation: r.coll || "" }));
    }
    case "postgres": {
      const r = await e.handle.query(`SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default, c.character_maximum_length AS len, c.numeric_precision AS prec, c.numeric_scale AS scale, c.is_identity, c.is_generated, ${PG_PK} AS is_pk FROM information_schema.columns c WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position`, [o.schema || "public", o.table]);
      return r.rows.map((x) => ({ name: x.column_name, type: fmtType(x.data_type === "USER-DEFINED" || x.data_type === "ARRAY" ? x.udt_name.replace(/^_/, "") + (x.data_type === "ARRAY" ? "[]" : "") : x.data_type, x.len, x.prec, x.scale), nullable: x.is_nullable === "YES", default: x.column_default, key: x.is_pk ? "PRI" : "", extra: [x.is_identity === "YES" ? "identity" : "", x.is_generated === "ALWAYS" ? "generated" : ""].filter(Boolean).join(" · ") }));
    }
    case "oracle": {
      const c = await e.handle.getConnection();
      try {
        const owner = o.schema || null;
        const sql = "SELECT c.column_name, c.data_type, c.data_length AS len, c.data_precision AS prec, c.data_scale AS scale, c.nullable, c.data_default, (SELECT 'PRI' FROM all_constraints uc JOIN all_cons_columns ucc ON ucc.constraint_name = uc.constraint_name AND ucc.owner = uc.owner WHERE uc.constraint_type = 'P' AND uc.owner = c.owner AND uc.table_name = c.table_name AND ucc.column_name = c.column_name AND ROWNUM = 1) AS keytype FROM all_tab_columns c WHERE c.owner = COALESCE(:o, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AND c.table_name = :t ORDER BY c.column_id";
        let r = await c.execute(sql, { o: owner, t: o.table }, { outFormat: e.d.OUT_FORMAT_OBJECT });
        if (!r.rows.length && o.table !== o.table.toUpperCase()) r = await c.execute(sql, { o: owner, t: o.table.toUpperCase() }, { outFormat: e.d.OUT_FORMAT_OBJECT });
        return r.rows.map((x) => ({ name: x.COLUMN_NAME, type: fmtType(x.DATA_TYPE, /CHAR|RAW/.test(x.DATA_TYPE) ? x.LEN : null, x.PREC, x.SCALE), nullable: x.NULLABLE === "Y", default: x.DATA_DEFAULT == null ? null : String(x.DATA_DEFAULT).trim(), key: x.KEYTYPE || "", extra: "" }));
      } finally { await c.close().catch(() => {}); }
    }
    case "mongodb": {
      const SAMPLE = 200;
      const docs = await e.handle.db(conn.database || undefined).collection(o.table).find({}).limit(SAMPLE).toArray();
      const fields = new Map();
      for (const d0 of docs) for (const [k, v] of Object.entries(d0)) {
        const ty = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? (v._bsontype || "object") : typeof v;
        if (!fields.has(k)) fields.set(k, { types: new Set(), n: 0 });
        fields.get(k).types.add(ty); fields.get(k).n++;
      }
      return [...fields.entries()].map(([name, f]) => ({ name, type: [...f.types].join(" | "), nullable: f.n < docs.length, default: null, key: name === "_id" ? "PRI" : "", extra: `${f.n}/${docs.length} sampled docs`, sampled: docs.length }));
    }
    case "sqlite": {
      const rows = e.handle.prepare(`PRAGMA table_info(${quoteIdent("sqlite", o.table)})`).all();
      return rows.map((r) => ({ name: r.name, type: r.type, nullable: !r.notnull, default: r.dflt_value, key: r.pk ? "PRI" : "", extra: "" }));
    }
    case "mssql": {
      const r = await e.handle.request().input("s", o.schema || "dbo").input("t", o.table).query(`SELECT c.column_name, c.data_type, c.character_maximum_length AS len, c.numeric_precision AS prec, c.numeric_scale AS scale, c.is_nullable, c.column_default, CASE WHEN ${PG_PK} THEN 'PRI' ELSE '' END AS keytype, COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.table_schema) + '.' + QUOTENAME(c.table_name)), c.column_name, 'IsIdentity') AS is_identity FROM information_schema.columns c WHERE c.table_schema = @s AND c.table_name = @t ORDER BY c.ordinal_position`);
      return r.recordset.map((x) => ({ name: x.column_name, type: fmtType(x.data_type, x.len === -1 ? null : x.len, x.prec, x.scale) + (x.len === -1 ? "(max)" : ""), nullable: x.is_nullable === "YES", default: x.column_default, key: x.keytype || "", extra: x.is_identity ? "identity" : "" }));
    }
    default: return [];
  } });
}
// Key metadata for a row mutation: the complete primary key (or null when the table has none).
async function keyColumns(id, tableRef) { const cols = await columns(id, tableRef); const pk = cols.filter((c) => c.key === "PRI").map((c) => c.name); return { pk, cols }; }

/* ============================== table info ============================== */
function groupFks(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.name)) m.set(r.name, { name: r.name, columns: [], refTable: r.rtable, refSchema: r.rschema || "", refColumns: [], onDelete: r.del || "", onUpdate: r.upd || "" });
    const g = m.get(r.name); g.columns.push(r.col); g.refColumns.push(r.rcol);
  }
  return [...m.values()];
}
function synthDDL(kind, o, cols, indexes, fks) {
  const q = (n) => quoteIdent(kind, n);
  const lines = cols.map((c) => `  ${q(c.name)} ${c.type || ""}${c.nullable === false ? " NOT NULL" : ""}${c.default != null && String(c.default) !== "" ? " DEFAULT " + c.default : ""}`);
  const pk = cols.filter((c) => c.key === "PRI").map((c) => q(c.name));
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  for (const f of fks || []) lines.push(`  CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(", ")}) REFERENCES ${qualify(kind, { schema: f.refSchema, table: f.refTable })} (${f.refColumns.map(q).join(", ")})${f.onDelete && !/no action/i.test(f.onDelete) ? " ON DELETE " + f.onDelete : ""}`);
  let out = `-- APPROXIMATE: generated from catalog metadata (constraints, index options, identity and expressions may be missing). Not a migration source.\nCREATE TABLE ${qualify(kind, o)} (\n${lines.join(",\n")}\n);`;
  for (const ix of indexes || []) if (!ix.primary) out += `\nCREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${q(ix.name)} ON ${qualify(kind, o)} (${ix.columns.map(q).join(", ")});`;
  return out;
}
async function tableInfo(id, tableRef) {
  const conn = getConn(id);
  if (conn.kind === "redis") return { columns: [], indexes: [], foreignKeys: [], ddl: "", rows: null };
  const o = objIdent(conn.kind, tableRef);
  const cols = await columns(id, o);
  return readOp(conn, async (e) => {
    let indexes = [], foreignKeys = [], ddl = "", rows = null, native = false;
    switch (conn.kind) {
      case "mysql": {
        const [ix] = await e.handle.query({ sql: "SHOW INDEX FROM " + qualify("mysql", o), rowsAsArray: false });
        const m = new Map();
        for (const r of ix) { const k = r.Key_name; if (!m.has(k)) m.set(k, { name: k, unique: String(r.Non_unique) === "0", primary: k === "PRIMARY", type: r.Index_type || "", columns: [] }); m.get(k).columns[(+r.Seq_in_index || 1) - 1] = r.Column_name; }
        indexes = [...m.values()].map((x) => ({ ...x, columns: x.columns.filter(Boolean) }));
        const [fk] = await e.handle.query({ sql: "SELECT k.constraint_name AS name, k.column_name AS col, k.referenced_table_schema AS rschema, k.referenced_table_name AS rtable, k.referenced_column_name AS rcol, r.delete_rule AS del, r.update_rule AS upd FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_name = k.constraint_name AND r.constraint_schema = k.constraint_schema WHERE k.table_schema = COALESCE(?, DATABASE()) AND k.table_name = ? AND k.referenced_table_name IS NOT NULL ORDER BY k.constraint_name, k.ordinal_position", values: [o.schema || null, o.table], rowsAsArray: false });
        foreignKeys = groupFks(fk);
        try { const [cr] = await e.handle.query({ sql: "SHOW CREATE TABLE " + qualify("mysql", o), rowsAsArray: false }); const row = cr[0] || {}; ddl = row["Create Table"] || row["Create View"] || Object.values(row)[1] || ""; native = !!ddl; } catch { ddl = ""; }
        break;
      }
      case "postgres": {
        const s = o.schema || "public";
        const ix = await e.handle.query("SELECT i.relname AS name, ix.indisunique AS uniq, ix.indisprimary AS prim, am.amname AS type, pg_get_indexdef(ix.indexrelid) AS def, array_to_string(array_agg(a.attname ORDER BY k.ord), ',') AS cols FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_index ix ON ix.indrelid = t.oid JOIN pg_class i ON i.oid = ix.indexrelid LEFT JOIN pg_am am ON am.oid = i.relam JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum WHERE n.nspname = $1 AND t.relname = $2 GROUP BY i.relname, ix.indisunique, ix.indisprimary, am.amname, ix.indexrelid ORDER BY ix.indisprimary DESC, i.relname", [s, o.table]);
        indexes = ix.rows.map((r) => ({ name: r.name, unique: !!r.uniq, primary: !!r.prim, type: r.type || "", columns: String(r.cols || "").split(",").filter(Boolean), definition: r.def || "" }));
        const fk = await e.handle.query("SELECT con.conname AS name, a.attname AS col, cf.relname AS rtable, nf.nspname AS rsch, af.attname AS rcol, con.confdeltype AS del, con.confupdtype AS upd FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_class cf ON cf.oid = con.confrelid JOIN pg_namespace nf ON nf.oid = cf.relnamespace JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(att, fatt, ord) ON true JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.att JOIN pg_attribute af ON af.attrelid = cf.oid AND af.attnum = k.fatt WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2 ORDER BY con.conname, k.ord", [s, o.table]);
        const ACT = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
        foreignKeys = groupFks(fk.rows.map((r) => ({ name: r.name, col: r.col, rtable: r.rtable, rschema: r.rsch, rcol: r.rcol, del: ACT[r.del] || r.del, upd: ACT[r.upd] || r.upd })));
        break;
      }
      case "oracle": {
        const c = await e.handle.getConnection();
        try {
          const owner = o.schema || null;
          const ix = await c.execute("SELECT i.index_name AS name, i.uniqueness AS uniq, i.index_type AS itype, ic.column_name AS col, (SELECT 'Y' FROM all_constraints uc WHERE uc.owner = i.owner AND uc.index_name = i.index_name AND uc.constraint_type = 'P' AND ROWNUM = 1) AS prim FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name WHERE i.table_owner = COALESCE(:o, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AND i.table_name = :t ORDER BY i.index_name, ic.column_position", { o: owner, t: o.table }, { outFormat: e.d.OUT_FORMAT_OBJECT });
          const m = new Map();
          for (const r of ix.rows) { if (!m.has(r.NAME)) m.set(r.NAME, { name: r.NAME, unique: r.UNIQ === "UNIQUE", primary: r.PRIM === "Y", type: r.ITYPE || "", columns: [] }); m.get(r.NAME).columns.push(r.COL); }
          indexes = [...m.values()];
          const fk = await c.execute("SELECT c.constraint_name AS name, cc.column_name AS col, rc.owner AS rschema, rc.table_name AS rtable, rcc.column_name AS rcol, c.delete_rule AS del FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name JOIN all_constraints rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position WHERE c.constraint_type = 'R' AND c.owner = COALESCE(:o, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AND c.table_name = :t ORDER BY c.constraint_name, cc.position", { o: owner, t: o.table }, { outFormat: e.d.OUT_FORMAT_OBJECT });
          foreignKeys = groupFks(fk.rows.map((r) => ({ name: r.NAME, col: r.COL, rschema: r.RSCHEMA, rtable: r.RTABLE, rcol: r.RCOL, del: r.DEL, upd: "" })));
          try { const d0 = await c.execute("SELECT DBMS_METADATA.GET_DDL('TABLE', :t, :o) AS ddl FROM dual", { t: o.table, o: owner || null }, { outFormat: e.d.OUT_FORMAT_OBJECT, fetchInfo: { DDL: { type: e.d.STRING } } }); ddl = d0.rows[0] ? String(d0.rows[0].DDL || "").trim() : ""; native = !!ddl; } catch { ddl = ""; }
        } finally { await c.close().catch(() => {}); }
        break;
      }
      case "mongodb": {
        const col = e.handle.db(conn.database || undefined).collection(o.table);
        const ix = await col.indexes();
        indexes = ix.map((x) => ({ name: x.name, unique: !!x.unique, primary: x.name === "_id_", type: x.sparse ? "sparse" : (x.expireAfterSeconds != null ? `ttl ${x.expireAfterSeconds}s` : ""), columns: Object.entries(x.key || {}).map(([k, v]) => `${k}${v === -1 ? " desc" : typeof v === "string" ? " " + v : ""}`) }));
        try { rows = await col.estimatedDocumentCount(); } catch { rows = null; }
        break;
      }
      case "sqlite": {
        const q = quoteIdent("sqlite", o.table);
        const il = e.handle.prepare(`PRAGMA index_list(${q})`).all();
        indexes = il.map((x) => ({ name: x.name, unique: !!Number(x.unique), primary: x.origin === "pk", type: x.origin === "u" ? "unique constraint" : x.origin === "pk" ? "primary key" : "", columns: e.handle.prepare(`PRAGMA index_info(${quoteIdent("sqlite", x.name)})`).all().map((c) => c.name) }));
        const fkl = e.handle.prepare(`PRAGMA foreign_key_list(${q})`).all();
        foreignKeys = groupFks(fkl.map((r) => ({ name: `fk_${r.id}`, col: r.from, rtable: r.table, rcol: r.to, del: r.on_delete, upd: r.on_update })));
        const row = e.handle.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(o.table);
        ddl = (row && row.sql) || ""; native = !!ddl;
        break;
      }
      case "mssql": {
        const full = `${quoteIdent("mssql", o.schema || "dbo")}.${quoteIdent("mssql", o.table)}`;
        const ix = await e.handle.request().input("full", full).query("SELECT i.name, i.is_unique AS uniq, i.is_primary_key AS prim, i.type_desc AS itype, c.name AS col FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE i.object_id = OBJECT_ID(@full) AND i.name IS NOT NULL AND ic.key_ordinal > 0 ORDER BY i.name, ic.key_ordinal");
        const m = new Map();
        for (const r of ix.recordset) { if (!m.has(r.name)) m.set(r.name, { name: r.name, unique: !!r.uniq, primary: !!r.prim, type: r.itype || "", columns: [] }); m.get(r.name).columns.push(r.col); }
        indexes = [...m.values()];
        const fk = await e.handle.request().input("full", full).query("SELECT fk.name, pc.name AS col, rs.name AS rsch, rt.name AS rtable, rc.name AS rcol, fk.delete_referential_action_desc AS del, fk.update_referential_action_desc AS upd FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id WHERE fk.parent_object_id = OBJECT_ID(@full) ORDER BY fk.name, fkc.constraint_column_id");
        foreignKeys = groupFks(fk.recordset.map((r) => ({ name: r.name, col: r.col, rschema: r.rsch, rtable: r.rtable, rcol: r.rcol, del: String(r.del || "").replace(/_/g, " "), upd: String(r.upd || "").replace(/_/g, " ") })));
        break;
      }
    }
    if (!ddl && cols.length && conn.kind !== "mongodb") ddl = synthDDL(conn.kind, o, cols, indexes, foreignKeys);
    return { columns: cols, indexes, foreignKeys, ddl, ddlNative: native, rows, object: { schema: o.schema, table: o.table, name: displayName(o) } };
  });
}

module.exports = { schema, schemaMore, columns, keyColumns, tableInfo };
