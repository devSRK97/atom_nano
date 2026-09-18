/* AtomNano renderer — Database Manager — result blocks (filter · count · export menu · accessible grid), value and row viewers, the inline cell editor, server-side search WHERE.
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { cellText, copyText, display, isJsonish, isTag, parseEdit, prettyJson, toCSV, toJSON, toMD, toTSV } from "./cells.js";
import { vgrid } from "./grid.js";
import { exportRows } from "./jobs.js";
import { D, h, icon } from "./state.js";
import { fmtInt, qIdent } from "./utils.js";

// One result set: toolbar (filter · count · export) + accessible virtual grid.
export const resultBlock = (tab, r, { name, editable, pkCols, onEdit, onDelete, externalSort, exportCtx, onServerSearch, searchTerm } = {}) => {
  const cols = r.columns, rows = r.rows;
  const info = h("span", { class: "dbm-res-info", role: "status" });
  const grid = vgrid({ columns: cols, rows, pkCols: pkCols || [], externalSort: externalSort || null, label: `${name || "Results"} (${fmtInt(rows.length)} rows)`,
    onRowNum: (ri) => showRowDetail(cols, rows[ri], ri),
    onCell: (ri, ci, e) => { if (e.ctrlKey || e.metaKey) copyText(cellText(rows[ri][ci]), "Cell copied"); },
    onCellDbl: (ri, ci, e, cellEl) => { if (editable && onEdit && cellEl) startCellEdit(grid, cellEl, ri, ci, onEdit); else showValue(cols[ci], rows[ri][ci]); },
    onCellMenu: (ri, ci, e) => {
      const v = rows[ri][ci];
      const items = [
        { label: "Copy value", icon: "copy", onClick: () => copyText(cellText(v), "Value copied") },
        { label: "Copy row as JSON", icon: "copy", onClick: () => copyText(toJSON(cols, [rows[ri]]).replace(/^\[\n|\n\]$/g, ""), "Row copied") },
        { label: "View value", icon: "eye", onClick: () => showValue(cols[ci], v) },
        { label: "Row details", icon: "list", onClick: () => showRowDetail(cols, rows[ri], ri) },
      ];
      if (editable && onEdit) items.push({ sep: true }, { label: "Edit cell", icon: "pencil", onClick: () => { const cellEl = grid.el.querySelector(`.dbm-vrow[data-ri="${ri}"]`)?.children[ci + 1]; if (cellEl) startCellEdit(grid, cellEl, ri, ci, onEdit); } }, { label: "Set NULL", icon: "x", onClick: () => onEdit(ri, ci, null) });
      if (editable && onDelete) items.push({ label: "Delete row…", icon: "trash", danger: true, onClick: () => onDelete([ri]) });
      D.showContextMenu(e.clientX, e.clientY, items);
    } });
  const filterIn = h("input", { class: "dbm-col-filter", type: "search", placeholder: onServerSearch ? "Filter rows… (Enter searches the whole table)" : "Filter rows…", value: searchTerm || "", "aria-label": "Filter rows" });
  let searching = false;
  const syncInfo = () => {
    info.innerHTML = "";
    if (searching) { info.append(h("span", { class: "dbm-spinner" }), h("span", { text: " Querying…" })); info.classList.add("busy"); return; }
    info.classList.remove("busy");
    const q = filterIn.value.trim();
    info.textContent = `${fmtInt(grid.visibleCount)}${grid.visibleCount !== rows.length ? " / " + fmtInt(rows.length) : ""} row${rows.length === 1 ? "" : "s"}${r.hasMore ? " (more available — raise the preview limit or export)" : ""} · ${cols.length} col${cols.length === 1 ? "" : "s"}${r.ms != null ? ` · ${r.ms} ms` : ""}`;
    if (r.effectiveSql) info.append(h("span", { class: "dbm-dim dbm-effective", title: r.effectiveSql, text: " · preview-limited" }));
    if (onServerSearch && q && grid.visibleCount === 0 && q !== searchTerm) info.append(h("span", { class: "dbm-dim", text: " — not on this page, " }), h("button", { class: "dbm-link", text: "search the whole table", onclick: () => serverSearch(q) }));
  };
  const serverSearch = (q) => { if (!onServerSearch || searching) return; searching = true; syncInfo(); filterIn.classList.add("searching"); onServerSearch(q); };
  let autoT = 0;
  filterIn.oninput = () => {
    const q = filterIn.value.trim();
    grid.filter(q); syncInfo();
    clearTimeout(autoT);
    if (onServerSearch && !q && searchTerm) autoT = setTimeout(() => onServerSearch(""), 400);
  };
  filterIn.onkeydown = (e) => { if (e.key === "Enter" && onServerSearch) { e.preventDefault(); clearTimeout(autoT); serverSearch(filterIn.value.trim()); } if (e.key === "Escape") { filterIn.value = ""; filterIn.oninput(); } };
  syncInfo();
  const view = () => grid.viewRows();
  const exportMenu = (e) => {
    const kind = tab.conn.kind, sqlOk = kind !== "mongodb" && kind !== "redis";
    const page = (format) => exportRows(tab, { format, scope: "page", table: exportCtx ? exportCtx.table : null, cols, rows: view(), name });
    const all = (format) => exportRows(tab, { format, scope: "all", table: exportCtx.table, where: exportCtx.where, orderBy: exportCtx.orderBy, dir: exportCtx.dir, name });
    const items = [
      { label: `Export ${exportCtx ? "this page" : "results"} as CSV`, icon: "download", onClick: () => page("csv") },
      { label: `Export ${exportCtx ? "this page" : "results"} as Excel (.xlsx)`, icon: "download", onClick: () => page("xlsx") },
      { label: `Export ${exportCtx ? "this page" : "results"} as JSON${kind === "mongodb" ? " (Extended JSON)" : ""}`, icon: "download", onClick: () => page("json") },
    ];
    if (sqlOk) items.push({ label: `Export ${exportCtx ? "this page" : "results"} as SQL INSERTs${exportCtx ? "" : " (choose target table)"}`, icon: "download", onClick: () => page("sql") });
    if (exportCtx) items.push({ sep: true },
      { label: "Export ALL rows as CSV" + (exportCtx.where ? " (filtered)" : ""), icon: "cloudDown", onClick: () => all("csv") },
      { label: "Export ALL rows as Excel (.xlsx)", icon: "cloudDown", onClick: () => all("xlsx") },
      { label: "Export ALL rows as JSON", icon: "cloudDown", onClick: () => all("json") },
      ...(sqlOk ? [{ label: "Export ALL rows as SQL INSERTs", icon: "cloudDown", onClick: () => all("sql") }] : []));
    items.push({ sep: true },
      { label: "Copy as TSV (paste into Excel)", icon: "copy", onClick: () => copyText(toTSV(cols, view()), "Copied as TSV") },
      { label: "Copy as Markdown", icon: "copy", onClick: () => copyText(toMD(cols, view()), "Copied as Markdown") },
      { label: "Copy as JSON", icon: "copy", onClick: () => copyText(toJSON(cols, view()), "Copied as JSON") },
      { label: "Copy as CSV", icon: "copy", onClick: () => copyText(toCSV(cols, view()), "Copied as CSV") });
    D.showContextMenu(e.clientX, e.clientY, items);
  };
  const bar = h("div", { class: "dbm-result-bar" }, filterIn, info, h("div", { class: "spacer" }),
    h("button", { class: "btn btn-ghost btn-sm dbm-export-btn", html: icon("download", 12) + "<span>Export</span>", title: "Export or copy these rows", "aria-haspopup": "menu", onclick: exportMenu }));
  const blk = h("div", { class: "dbm-result-block" }, bar, grid.el);
  blk._grid = grid; blk._syncInfo = syncInfo; blk._filter = filterIn;
  return blk;
};
export const showValue = (col, v) => {
  const text = isTag(v) && v.$t === "json" ? prettyJson(v.v) : isJsonish(v) ? prettyJson(v) : (v === null || v === undefined ? "NULL" : isTag(v) && v.$t === "bytes" ? `${fmtInt(v.len)} bytes\n\n${cellText(v)}` : cellText(v));
  const pre = h("pre", { class: "dbm-value-pre", text });
  D.modalShell({ title: String(col) + (isTag(v) ? ` · ${v.$t}` : ""), ic: "eye", wide: true, body: pre, footer: [h("button", { class: "btn btn-ghost", text: "Copy", onclick: () => copyText(cellText(v), "Copied") })] });
};
export const showRowDetail = (cols, row, ri) => {
  const tbl = h("table", { class: "dbm-grid dbm-detail-grid" }, h("tbody", {}, ...cols.map((c, i) => {
    const v = row[i];
    return h("tr", {}, h("th", { class: "dbm-col-name", scope: "row", text: c }), h("td", { class: v === null || v === undefined ? "dbm-null" : "", text: v === null || v === undefined ? "NULL" : (isTag(v) && v.$t === "json" ? prettyJson(v.v) : isJsonish(v) ? prettyJson(v) : display(v)), title: "Click to copy", tabindex: "0", onclick: () => copyText(cellText(v), "Copied"), onkeydown: (e) => { if (e.key === "Enter") copyText(cellText(v), "Copied"); } }));
  })));
  D.modalShell({ title: `Row ${ri + 1}`, ic: "list", wide: true, body: h("div", { class: "dbm-detail-wrap" }, tbl), footer: [h("button", { class: "btn btn-ghost", text: "Copy JSON", onclick: () => copyText(toJSON(cols, [row]), "Row copied") })] });
};
/* Inline cell editor. Enter saves, Esc discards; blur with a changed value ASKS (Save /
 * Discard — every dismissal counts as Discard). The grid shows the ORIGINAL value until
 * the caller confirms the persisted row. */
export const startCellEdit = (grid, cellEl, ri, ci, onEdit) => {
  const cur = grid.rows[ri][ci];
  const col = grid.columns[ci];
  const inp = h("input", { class: "dbm-cell-edit", value: cur === null || cur === undefined ? "" : cellText(cur), spellcheck: "false", "aria-label": `Edit ${col}`, title: "Enter saves · Esc discards · NULL for null · =expr for a raw expression" });
  cellEl.replaceChildren(inp); cellEl.classList.add("editing"); inp.focus(); inp.select();
  let done = false;
  const changed = (raw) => { if (raw === "NULL") return !(cur === null || cur === undefined); return cur === null || cur === undefined ? raw !== "" : cellText(cur) !== raw; };
  const finish = async (mode) => {
    if (done) return; done = true;
    cellEl.classList.remove("editing");
    const raw = inp.value;
    if (mode === "discard" || !changed(raw)) { grid.refresh(); grid.focusCell(ri, ci); return; }
    if (mode === "ask") {
      const before = cur === null || cur === undefined ? "NULL" : display(cur), after = raw === "NULL" ? "NULL" : raw;
      const c = await D.chooseDialog({ title: `Save change to ${col}?`, ic: "pencil", message: `${before}  →  ${after}\n\nThe cell was edited but you clicked away. Save it to the database, or discard the change?`, choices: [{ label: "Save", value: "save", primary: true }, { label: "Discard", value: null }] });
      if (c !== "save") { grid.refresh(); grid.focusCell(ri, ci); return; }
    }
    grid.refresh();                                        // original value stays visible until the server confirms
    onEdit(ri, ci, parseEdit(raw, cur));
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finish("save"); } else if (e.key === "Escape") { e.preventDefault(); finish("discard"); } };
  inp.onblur = () => setTimeout(() => finish("ask"), 0);
};
export const searchWhere = (kind, cols, q) => {
  const term = String(q).replace(/;|--|\/\*/g, " ").trim();
  if (!term) return "";
  if (kind === "mongodb") return JSON.stringify({ $or: cols.filter((c) => /string|null|undefined/i.test(c.type || "string") || !c.type).map((c) => ({ [c.name]: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } })) });
  const like = "'%" + term.replace(/'/g, "''") + "%'";
  const skip = /blob|binary|image|bytea|raw\b|varbinary|clob|xml|geometry|json/i;
  const names = cols.filter((c) => !skip.test(c.type || "")).map((c) => c.name);
  if (!names.length) return "";
  const expr = (c) => { const id = qIdent(kind, c); if (kind === "postgres") return `${id}::text ILIKE ${like}`; if (kind === "mysql") return `CAST(${id} AS CHAR) LIKE ${like}`; if (kind === "sqlite") return `CAST(${id} AS TEXT) LIKE ${like}`; if (kind === "mssql") return `CAST(${id} AS NVARCHAR(MAX)) LIKE ${like}`; if (kind === "oracle") return `UPPER(TO_CHAR(${id})) LIKE UPPER(${like})`; return `${id} LIKE ${like}`; };
  return "(" + names.map(expr).join(" OR ") + ")";
};
export const combineWhere = (kind, userWhere, search) => { if (!search) return userWhere || ""; if (!userWhere) return search; if (kind === "mongodb") { try { return JSON.stringify({ $and: [JSON.parse(userWhere), JSON.parse(search)] }); } catch { return search; } } return `(${userWhere}) AND ${search}`; };
