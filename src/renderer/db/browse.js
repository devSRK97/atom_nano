/* AtomNano renderer — Database Manager — the Browse mode (stable server-side pages, sort, filter, inline edit by primary key, confirmed values only) and the insert-row dialog.
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { parseEdit } from "./cells.js";
import { errBanner } from "./connections.js";
import { markLive, noteFailure } from "./health.js";
import { importDialog } from "./jobs.js";
import { combineWhere, resultBlock, searchWhere } from "./results.js";
import { getColumns } from "./sidebar.js";
import { atom, confirm, D, h, icon, insertBusy, objNoun, setInsertBusy, setPref, toast } from "./state.js";
import { errMsg, fmtInt, objName, objRef, sameObj } from "./utils.js";
import { logPush } from "./workspace.js";

/* ------------------------------ BROWSE ------------------------------ */
export const renderBrowse = async (tab) => {
  const panel = tab.wsEl.querySelector(".dbm-browse-panel");
  panel.innerHTML = "";
  if (!tab.cur) { panel.append(h("div", { class: "dbm-empty dbm-big-empty" }, h("span", { html: icon("list", 26) }), h("div", { text: `Pick a ${objNoun(tab.conn.kind, false)} on the left to browse its data.` }))); return; }
  const B = tab.browse, it = tab.cur, kind = tab.conn.kind, conn = tab.conn;
  const gen = (tab._browseGen = (tab._browseGen || 0) + 1);
  const whereIn = h("input", { class: "dbm-where", type: "text", value: B.where || "", spellcheck: "false", placeholder: kind === "mongodb" ? 'filter JSON, e.g. {"status":"active"}' : "WHERE … e.g. status = 'active' AND total > 100", "aria-label": "Filter" });
  const apply = () => { B.where = whereIn.value.trim(); B.offset = 0; B.total = null; renderBrowse(tab); };
  whereIn.onkeydown = (e) => { if (e.key === "Enter") apply(); };
  const sizeSel = h("select", { class: "input dbm-page-size", title: "Rows per page", "aria-label": "Rows per page" });
  for (const n of [50, 100, 200, 500, 1000, 2000, 5000]) sizeSel.append(h("option", { value: String(n), text: String(n) }));
  sizeSel.value = String(B.limit || 200);
  sizeSel.onchange = () => { B.limit = +sizeSel.value; setPref("page", B.limit); B.offset = 0; renderBrowse(tab); };
  // pagination: estimates are ADVISORY (shown with ~); navigation follows the returned page (hasMore) or an exact count
  const pageIn = h("input", { class: "input dbm-page-in", type: "number", min: "1", value: String(Math.floor(B.offset / B.limit) + 1), title: "Page — type a number and press Enter", "aria-label": "Page" });
  const pageOf = h("span", { class: "dbm-page-of" });
  const pageInfo = h("span", { class: "dbm-page-info", text: "…" });
  const exactPages = () => (B.total != null ? Math.max(1, Math.ceil(B.total / B.limit)) : 0);
  const goPage = (p) => { const max = exactPages(); p = Math.max(1, max ? Math.min(p, max) : p); B.offset = (p - 1) * B.limit; renderBrowse(tab); };
  pageIn.onkeydown = (e) => { if (e.key === "Enter") goPage(+pageIn.value || 1); };
  const first = h("button", { class: "btn btn-ghost btn-sm dbm-pg", html: icon("chevronLeft", 12) + icon("chevronLeft", 12), title: "First page", "aria-label": "First page", onclick: () => goPage(1) });
  const prev = h("button", { class: "btn btn-ghost btn-sm dbm-pg", html: icon("chevronLeft", 13), title: "Previous page (Alt+←)", "aria-label": "Previous page", onclick: () => goPage(Math.floor(B.offset / B.limit)) });
  const next = h("button", { class: "btn btn-ghost btn-sm dbm-pg", html: icon("chevronRight", 13), title: "Next page (Alt+→)", "aria-label": "Next page", onclick: () => goPage(Math.floor(B.offset / B.limit) + 2) });
  const last = h("button", { class: "btn btn-ghost btn-sm dbm-pg", html: icon("chevronRight", 12) + icon("chevronRight", 12), title: "Last page (needs an exact count)", "aria-label": "Last page", onclick: () => { const m = exactPages(); if (m) goPage(m); } });
  const countBtn = h("button", { class: "btn btn-ghost btn-sm", html: icon("history", 12) + "<span>Count</span>", title: "Exact row count for this filter", onclick: async () => { countBtn.disabled = true; try { const r = await atom().db.count(conn.id, objRef(it), effWhere()); B.total = r.count; if (!B.where && !B.search) { it.rows = r.count; it.rowsEstimated = false; } syncPage(); if (tab._objUI) tab._objUI.list.refresh(); } catch (e) { toast("Count failed: " + errMsg(e), "alert"); } countBtn.disabled = false; } });
  const addBtn = h("button", { class: "btn btn-ghost btn-sm", html: icon("plus", 12) + "<span>Row</span>", title: "Insert a row", onclick: () => insertRowDialog(tab) });
  const importBtn = h("button", { class: "btn btn-ghost btn-sm", html: icon("upload", 12) + "<span>Import</span>", title: "Import rows from CSV / Excel, or run a .sql file", onclick: () => importDialog(tab, it) });
  const refreshBtn = h("button", { class: "btn btn-ghost btn-sm", html: icon("refresh", 12), title: "Reload page", "aria-label": "Reload page", onclick: () => renderBrowse(tab) });
  const sortNote = h("span", { class: "dbm-dim dbm-sort-note", text: B.orderBy ? `sorted by ${B.orderBy} ${B.dir}` : "" });
  if (B.orderBy) sortNote.append(h("button", { class: "dbm-mini", html: icon("x", 10), title: "Clear sort", "aria-label": "Clear sort", onclick: () => { B.orderBy = ""; B.dir = "asc"; renderBrowse(tab); } }));
  const searchChip = B.search ? h("span", { class: "dbm-search-chip", title: "Server-side search across all text columns" }, h("span", { html: icon("search", 11) }), h("span", { text: B.search }), h("button", { class: "dbm-mini", html: icon("x", 10), title: "Clear search", "aria-label": "Clear search", onclick: () => { B.search = ""; B.offset = 0; B.total = null; renderBrowse(tab); } })) : null;
  const bar = h("div", { class: "dbm-browse-bar" },
    h("span", { class: "dbm-browse-name" }, h("span", { html: icon(it.type === "view" ? "eye" : "list", 13) }), h("span", { text: objName(it) })),   // database names are TEXT, never markup
    whereIn, h("button", { class: "btn btn-ghost btn-sm", text: "Apply", onclick: apply }), searchChip, sortNote, h("div", { class: "spacer" }),
    countBtn, it.type === "view" ? null : addBtn, it.type === "view" ? null : importBtn, refreshBtn,
    h("span", { class: "dbm-pager", role: "group", "aria-label": "Pages" }, first, prev, pageIn, pageOf, next, last), pageInfo, sizeSel);
  const host = h("div", { class: "dbm-results dbm-browse-results" }, h("div", { class: "dbm-empty dbm-running" }, h("span", { class: "dbm-spinner" }), h("span", { text: B.search ? " Querying…" : " Loading…" })));
  const st = h("div", { class: "dbm-statusbar", role: "status" });
  panel.append(bar, host, st);
  const effWhere = () => combineWhere(kind, B.where, B.search ? searchWhere(kind, tab.struct.get(objName(it))?.columns || [], B.search) : "");
  const syncPage = () => {
    const n = (B.result && B.result.rows) ? B.result.rows.length : 0, more = !!(B.result && B.result.hasMore);
    const from = n ? B.offset + 1 : 0, to = B.offset + n;
    const est = it.rows != null && !B.where && !B.search && B.total == null ? it.rows : null;
    const pages = exactPages(); const cur = Math.floor(B.offset / B.limit) + 1;
    pageIn.value = String(cur);
    pageOf.textContent = pages ? `of ${fmtInt(pages)}` : (est != null ? `of ~${fmtInt(Math.max(1, Math.ceil(est / B.limit)))} (estimate)` : "");
    pageInfo.textContent = `${fmtInt(from)}–${fmtInt(to)}${B.total != null ? ` of ${fmtInt(B.total)}` : est != null ? ` of ~${fmtInt(est)}` : more ? " · more rows available" : ""}`;
    first.disabled = prev.disabled = B.offset <= 0;
    next.disabled = !more;                                 // driven by the page itself, never by an estimate
    last.disabled = !pages || cur >= pages;
    last.title = B.total == null ? "Last page — click Count first for an exact total" : "Last page";
  };
  if (!tab._pageKeys) { tab._pageKeys = true; const onKeys = (e) => { if (tab.mode !== "browse" || !e.altKey) return; if (e.key === "ArrowLeft" && tab.browse.offset > 0) { e.preventDefault(); tab.browse.offset = Math.max(0, tab.browse.offset - tab.browse.limit); renderBrowse(tab); } else if (e.key === "ArrowRight" && tab.browse.result && tab.browse.result.hasMore) { e.preventDefault(); tab.browse.offset += tab.browse.limit; renderBrowse(tab); } }; tab.wsEl.addEventListener("keydown", onKeys); tab.disposers.push(() => tab.wsEl && tab.wsEl.removeEventListener("keydown", onKeys)); }
  let res, cols = [];
  try {
    cols = await getColumns(tab, it).catch(() => []);
    res = await atom().db.browse(conn.id, objRef(it), { offset: B.offset, limit: B.limit, orderBy: B.orderBy, dir: B.dir, where: effWhere() });
  } catch (e) {
    if (gen !== tab._browseGen) return;
    logPush(tab, { kind: "browse", text: `browse ${objName(it)}${B.where ? " WHERE " + B.where : ""}${B.search ? ` search "${B.search}"` : ""}`, ok: false, error: errMsg(e) });
    noteFailure(tab, e);
    host.innerHTML = ""; host.append(errBanner(e, kind, { extra: [h("button", { class: "btn btn-ghost btn-sm", html: icon("refresh", 12) + "<span>Retry</span>", onclick: () => renderBrowse(tab) })] })); syncPage(); return;
  }
  if (gen !== tab._browseGen) return;
  B.result = res; markLive(tab);
  logPush(tab, { kind: "browse", text: res.sql || `browse ${objName(it)}`, ms: res.ms, rows: res.rows.length, hasMore: res.hasMore, ok: true });
  const pkCols = (res.pk && res.pk.length ? res.pk : cols.filter((c) => c.key === "PRI").map((c) => c.name)).filter((c) => res.columns.includes(c));
  const policy = conn.policy || {};
  const protectedHit = (policy.protectedTables || []).some((t) => t.toLowerCase() === objName(it).toLowerCase() || t.toLowerCase() === String(it.table || "").toLowerCase());
  const editable = pkCols.length > 0 && it.type !== "view" && !policy.blockWrite && !protectedHit;
  host.innerHTML = "";
  if (!res.columns.length || (!res.rows.length && B.search)) {
    host.append(h("div", { class: "dbm-empty dbm-big-empty" }, h("span", { html: icon("search", 22) }), h("div", { text: B.search ? `No rows anywhere in ${objName(it)} match “${B.search}”${B.where ? " with the current WHERE" : ""}.` : "No rows." }),
      B.search ? h("button", { class: "btn btn-ghost btn-sm", text: "Clear search", onclick: () => { B.search = ""; B.offset = 0; B.total = null; renderBrowse(tab); } }) : null));
    syncPage(); return;
  }
  const pkOf = (row) => Object.fromEntries(pkCols.map((c) => [c, row[res.columns.indexOf(c)]]));
  const rowEdits = new Set();                              // rows with an edit in flight — one at a time per row
  const blk = resultBlock(tab, { ...res, ms: res.ms }, {
    name: objName(it), editable, pkCols,
    exportCtx: { table: it, where: effWhere(), orderBy: B.orderBy, dir: B.dir },
    searchTerm: B.search || "",
    onServerSearch: (q) => { B.search = q; B.offset = 0; B.total = null; renderBrowse(tab); },
    externalSort: { col: B.orderBy, dir: B.dir, onClick: (col) => { if (B.orderBy === col) { if (B.dir === "asc") B.dir = "desc"; else { B.orderBy = ""; B.dir = "asc"; } } else { B.orderBy = col; B.dir = "asc"; } B.offset = 0; renderBrowse(tab); } },
    onEdit: async (ri, ci, v) => {
      const row = res.rows[ri]; const col = res.columns[ci];
      if (rowEdits.has(ri)) { toast("This row already has a change in progress", "alert"); return; }
      if (pkCols.includes(col) && v === null) { toast("Primary key can't be NULL", "alert"); blk._grid.refresh(); return; }
      rowEdits.add(ri);
      try {
        const r = await atom().db.updateRows(conn.id, objRef(it), { pk: pkOf(row), set: { [col]: v } }, { expectRev: conn.rev });
        if (r.row && r.row.columns) { const vals = res.columns.map((c) => { const i = r.row.columns.indexOf(c); return i >= 0 ? r.row.values[i] : row[res.columns.indexOf(c)]; }); blk._grid.setRow(ri, vals); }   // the PERSISTED row, as the server has it
        else blk._grid.refresh();
        toast(r.affected === 0 ? `Saved ${col} (value unchanged on the server)` : `Saved ${col}`, "check");
        logPush(tab, { kind: "edit", text: r.sql || `update ${objName(it)}.${col}`, affected: r.affected, ok: true });
      } catch (e) {
        blk._grid.refresh();                               // keep the original value
        toast(`${e.type === "not-found" ? "Not saved — the row changed or was deleted. " : e.type === "identity" ? "Not saved — " : "Update failed: "}${errMsg(e)}`, "alert", { ms: 7000 });
        logPush(tab, { kind: "edit", text: `update ${objName(it)}.${col}`, ok: false, error: errMsg(e), state: e.type === "outcome-unknown" ? "unknown" : "" });
        noteFailure(tab, e);
        if (e.type === "not-found" || e.type === "identity") renderBrowse(tab);
      } finally { rowEdits.delete(ri); }
    },
    onDelete: async (ris) => {
      if (!(await confirm("Delete row", `Delete ${ris.length} row${ris.length > 1 ? "s" : ""} from “${objName(it)}”?`, "Delete"))) return;
      try { const r = await atom().db.deleteRows(conn.id, objRef(it), ris.map((i) => pkOf(res.rows[i])), { expectRev: conn.rev }); toast(r.message || "Deleted", "check"); logPush(tab, { kind: "edit", text: `delete ${ris.length} row(s) from ${objName(it)}`, affected: r.affected, ok: true }); if (it.rows != null) it.rows = Math.max(0, it.rows - r.affected); if (B.total != null) B.total = Math.max(0, B.total - r.affected); renderBrowse(tab); }   // re-read the page: totals and positions come from the server
      catch (e) { toast(`Delete failed${e.type ? ` (${e.type})` : ""}: ${errMsg(e)}`, "alert", { ms: 7000 }); logPush(tab, { kind: "edit", text: `delete from ${objName(it)}`, ok: false, error: errMsg(e), state: e.type === "outcome-unknown" ? "unknown" : "" }); noteFailure(tab, e); if (e.type === "not-found") renderBrowse(tab); }
    },
  });
  host.append(blk);
  syncPage();
  st.textContent = `${res.ms} ms${B.search ? ` · server search “${B.search}”` : ""} · ${editable ? `editable (key: ${pkCols.join(", ")}) — double-click or Enter on a cell` : pkCols.length ? (protectedHit ? "read-only (protected table)" : "read-only (policy)") : it.type === "view" ? "view — read-only" : "read-only — no primary key"}${res.stable === false ? " · ⚠ order not guaranteed (no key)" : ""}${res.sql ? "  ·  " + res.sql.replace(/\s+/g, " ").slice(0, 120) : ""}`;
};

/* ------------------------------ INSERT ROW ------------------------------ */
export const insertRowDialog = async (tab) => {
  const it = tab.cur, conn = tab.conn, kind = conn.kind;
  if (!it || it.type === "view" || kind === "redis") return;
  let cols = []; try { cols = await getColumns(tab, it); } catch (e) { toast(errMsg(e), "alert"); return; }
  const status = h("div", { class: "dbm-form-status" });
  let body, collect;
  if (kind === "mongodb") {
    const ta = h("textarea", { class: "dbm-editor dbm-ins-json", spellcheck: "false", "aria-label": "Document (JSON)" }); ta.value = JSON.stringify(Object.fromEntries(cols.filter((c) => c.name !== "_id").map((c) => [c.name, null])), null, 2);
    body = h("div", { class: "dbm-ins-form" }, h("div", { class: "dbm-form-hint", text: "One document as JSON. Extended JSON ($oid, $date, $numberLong …) is accepted." }), ta);
    collect = () => { const doc = JSON.parse(ta.value); if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("The document must be a JSON object."); return doc; };
  } else {
    const inputs = new Map();
    body = h("div", { class: "dbm-ins-form" });
    for (const c of cols) {
      const auto = /auto_increment|identity|nextval|default_generated/i.test(String(c.extra || "") + " " + String(c.default || ""));
      const inp = h("input", { class: "input", type: "text", placeholder: auto ? "auto" : c.default != null && String(c.default) !== "" ? `default: ${c.default}` : c.nullable === false ? "required" : "NULL", "aria-label": c.name, title: `${c.type || ""}${c.nullable === false ? " NOT NULL" : ""} — empty = column default · NULL · =expr for a raw expression` });
      inputs.set(c.name, inp);
      body.append(h("label", { class: "dbm-ins-field" }, h("span", { class: "dbm-col-name" }, c.key === "PRI" ? h("span", { class: "dbm-pk-ic", html: icon("key", 10), title: "primary key" }) : null, h("span", { text: c.name })), h("span", { class: "dbm-type", text: c.type || "" }), inp));
    }
    collect = () => { const v = {}; for (const [name, inp] of inputs) { if (inp.value === "") continue; v[name] = parseEdit(inp.value, null); } if (!Object.keys(v).length) throw new Error("Enter at least one value — empty fields use the column default."); return v; };
  }
  let back = null;
  const btn = h("button", { class: "btn btn-primary", text: "Insert", onclick: async () => {
    if (insertBusy) return; setInsertBusy(true); btn.disabled = true; status.innerHTML = "";
    try {
      const values = collect();
      const r = await atom().db.insertRow(conn.id, objRef(it), values, { expectRev: conn.rev });
      toast(r.message || "Inserted", "check");
      logPush(tab, { kind: "edit", text: r.sql || `insert into ${objName(it)}`, affected: r.affected, ok: true });
      if (it.rows != null) it.rows += r.affected || 1;
      D.closeModal(back);
      if (tab.mode === "browse" && sameObj(tab.cur, it)) { tab.browse.total = null; renderBrowse(tab); }
    } catch (e) { status.append(errBanner(e, kind)); logPush(tab, { kind: "edit", text: `insert into ${objName(it)}`, ok: false, error: errMsg(e), state: e.type === "outcome-unknown" ? "unknown" : "" }); noteFailure(tab, e); }
    finally { setInsertBusy(false); btn.disabled = false; }
  } });
  body.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); btn.click(); } });
  back = D.modalShell({ title: `Insert into ${objName(it)}`, ic: "plus", wide: true, body: h("div", {}, body, status), footer: [h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => D.closeModal(back) }), btn] });
  setTimeout(() => { const f = back.querySelector("input, textarea"); if (f) f.focus(); }, 30);
};
