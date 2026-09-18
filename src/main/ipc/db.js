"use strict";
/* IPC: the Database Manager — db:* (connections + secrets, schema, queries, row edits, DB sessions,
 * import/export jobs) with payload validation at the boundary, plus the standalone DBM window.
 * Handlers call src/main/db/db.js and db-io.js. */
const { BrowserWindow } = require("electron");
const path = require("path");
const platform = require("../platform");

function register(ctx) {
  const { handle, winFrom, INDEX_HTML } = ctx;
  // ---- DBM (database manager) ----
  // ---- Database Manager ----
  // Every DB route validates its payload shape at the boundary (audit DB-045): ids and
  // names are strings, object references are strings or { schema, table }, option bags
  // are plain objects with finite integers. Typed DbErrors keep type/details/hint.
  const db = require("../db/db");
  const V = {
    id: (v) => { if (typeof v !== "string" || !v || v.length > 200) throw new db.DbError("Invalid connection id.", { type: "invalid" }); return v; },
    str: (v, what, max = 4000) => { if (typeof v !== "string" || v.length > max) throw new db.DbError(`Invalid ${what}.`, { type: "invalid" }); return v; },
    text: (v, what) => { if (typeof v !== "string") throw new db.DbError(`Invalid ${what}.`, { type: "invalid" }); return v; },
    ref: (v) => { if (typeof v === "string") return V.str(v, "object name", 600); if (v && typeof v === "object" && typeof (v.table || v.name) === "string") return { schema: typeof v.schema === "string" ? v.schema : "", table: v.table || v.name }; throw new db.DbError("Invalid object reference.", { type: "invalid" }); },
    obj: (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}),
    opts: (v) => { const o = V.obj(v); for (const k of ["limit", "offset", "batch", "expectRev"]) if (o[k] != null && (!Number.isFinite(+o[k]) || +o[k] < 0)) throw new db.DbError(`Invalid ${k}.`, { type: "invalid" }); if (o.session != null && typeof o.session !== "string") throw new db.DbError("Invalid session.", { type: "invalid" }); if (o.argv != null && !Array.isArray(o.argv)) throw new db.DbError("Invalid argv.", { type: "invalid" }); return o; },
    list: (v, what) => { if (!Array.isArray(v)) throw new db.DbError(`Invalid ${what}.`, { type: "invalid" }); return v; },
  };
  handle("db:kinds", async () => db.kinds());
  handle("db:list", async () => db.list());
  handle("db:save", async (_e, conn) => db.save(V.obj(conn)));
  handle("db:remove", async (_e, id) => db.remove(V.id(id)));
  handle("db:reveal-secret", async (_e, id, field) => db.revealSecret(V.id(id), V.str(field, "field", 20)));
  handle("db:session-secret", async (_e, id, fields) => db.setSessionSecret(V.id(id), V.obj(fields)));
  handle("db:test", async (_e, connOrId) => db.test(typeof connOrId === "string" ? V.id(connOrId) : V.obj(connOrId)));
  handle("db:schema", async (_e, id) => db.schema(V.id(id)));
  handle("db:schema-more", async (_e, id, opts) => db.schemaMore(V.id(id), V.opts(opts)));
  handle("db:columns", async (_e, id, table) => db.columns(V.id(id), V.ref(table)));
  handle("db:query", async (_e, id, text, opts) => db.query(V.id(id), V.text(text == null ? "" : text, "statement"), V.opts(opts)));
  handle("db:parallel-query", async (_e, id, queries, opts) => db.parallelQuery(V.id(id), V.list(queries || [], "queries").map((q) => V.text(q, "statement")), V.opts(opts)));
  handle("db:split-script", async (_e, id, text) => db.splitScript(V.id(id), V.text(text == null ? "" : text, "script")));
  handle("db:format-sql", async (_e, id, text) => db.formatSql(V.id(id), V.text(text == null ? "" : text, "script")));
  handle("db:session-open", async (_e, id) => db.sessionOpen(V.id(id)));
  handle("db:session-close", async (_e, sid, opts) => db.sessionClose(V.str(sid, "session", 64), V.obj(opts)));
  handle("db:session-set", async (_e, sid, patch) => db.sessionSet(V.str(sid, "session", 64), V.obj(patch)));
  handle("db:cancel", async (_e, opId) => db.cancel(V.str(opId, "operation id", 64)));
  handle("db:add-column", async (_e, id, table, col, opts) => db.addColumn(V.id(id), V.ref(table), V.obj(col), V.opts(opts)));
  handle("db:drop-column", async (_e, id, table, name, opts) => db.dropColumn(V.id(id), V.ref(table), V.str(name, "column", 256), V.opts(opts)));
  handle("db:rename-column", async (_e, id, table, oldName, newName, opts) => db.renameColumn(V.id(id), V.ref(table), V.str(oldName, "column", 256), V.str(newName, "column", 256), V.opts(opts)));
  handle("db:add-index", async (_e, id, table, spec, opts) => db.addIndex(V.id(id), V.ref(table), V.obj(spec), V.opts(opts)));
  handle("db:drop-index", async (_e, id, table, name, opts) => db.dropIndex(V.id(id), V.ref(table), V.str(name, "index", 256), V.opts(opts)));
  handle("db:schema-plan", async (_e, id, table, plan, opts) => db.schemaPlan(V.id(id), V.ref(table), V.obj(plan), V.opts(opts)));
  handle("db:ping", async (_e, id) => db.ping(V.id(id)));
  const dbio = require("../db/db-io");
  handle("db:export-file", async (e, opts) => dbio.exportFile(winFrom(e), V.opts(opts)));
  handle("db:export-cancel", async (_e, token) => dbio.exportCancel(V.str(token, "token", 64)));
  handle("db:import-pick", async (e, opts) => dbio.importPick(winFrom(e), V.opts(opts)));
  handle("db:import-run", async (e, opts) => dbio.importRun(winFrom(e), V.opts(opts)));
  handle("db:import-cancel", async (_e, token) => dbio.importCancel(V.str(token, "token", 64)));
  handle("db:import-discard", async (_e, token) => dbio.importDiscard(V.str(token, "token", 64)));
  handle("db:job-status", async (_e, token) => dbio.jobStatus(V.str(token, "token", 64)));
  handle("db:jobs", async (e) => dbio.jobsFor(winFrom(e)));
  handle("db:reorder-columns", async (_e, id, table, order, opts) => db.reorderColumns(V.id(id), V.ref(table), V.list(order || [], "order"), V.opts(opts)));
  handle("db:table-info", async (_e, id, table) => db.tableInfo(V.id(id), V.ref(table)));
  handle("db:count", async (_e, id, table, where) => db.count(V.id(id), V.ref(table), V.str(where == null ? "" : where, "filter")));
  handle("db:browse", async (_e, id, table, opts) => db.browse(V.id(id), V.ref(table), V.opts(opts)));
  handle("db:insert-row", async (_e, id, table, values, opts) => db.insertRow(V.id(id), V.ref(table), V.obj(values), V.opts(opts)));
  handle("db:update-rows", async (_e, id, table, spec, opts) => db.updateRows(V.id(id), V.ref(table), V.obj(spec), V.opts(opts)));
  handle("db:delete-rows", async (_e, id, table, pks, opts) => db.deleteRows(V.id(id), V.ref(table), V.list(pks || [], "keys"), V.opts(opts)));
  handle("db:explain", async (_e, id, text) => db.explain(V.id(id), V.text(text == null ? "" : text, "statement")));
  handle("db:install-driver", async (_e, kind) => db.installDriver(V.str(kind, "kind", 20)));
  handle("db:disconnect", async (_e, id) => { await db.disconnect(V.id(id)); return true; });
  handle("db:open-window", async () => {
    const dbWin = new BrowserWindow({
      width: 1200, height: 760, minWidth: 900, minHeight: 520,
      ...platform.windowChrome(), backgroundColor: "#1a1512", show: false,
      webPreferences: { preload: path.join(__dirname, "..", "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false },
    });
    dbWin.loadFile(INDEX_HTML, { query: { dbm: "1" } });
    const sendMax = () => { if (!dbWin.isDestroyed()) dbWin.webContents.send("win:maximized-change", dbWin.isMaximized()); };
    dbWin.on("maximize", sendMax); dbWin.on("unmaximize", sendMax);
    dbWin.once("ready-to-show", () => dbWin.show());
    return true;
  });
}

module.exports = { register };
