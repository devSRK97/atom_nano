/* DBM — Database Manager (standalone window, mounted by app.js).
 *
 * Layout: connections + objects rail · one tab per open connection · per tab a
 * workspace with three modes:
 *   Query      SQL / JSON / Redis command editor → one block per statement
 *   Browse     one table, stable server-side pages, sort, filter, inline edit (by PK)
 *   Structure  columns · indexes · foreign keys · DDL · reviewed schema plans
 *
 * Contracts (audit ATOMNANO_DB_MANAGEMENT_AUDIT_2026-09-09):
 *   RUN CONTEXT  a run captures { opId, connection id + revision, session, statements }
 *                when it STARTS; closing/reusing the tab or switching connections never
 *                retargets it. Each statement is a visible row with its own state
 *                (queued · running · done · failed · unknown · not run); earlier results
 *                survive a later failure; Stop cancels the running statement.
 *   SESSION      each query tab owns a backend session (pinned client) so BEGIN/COMMIT,
 *                SET/USE and temp tables belong to that tab; its transaction state is shown.
 *   TYPED CELLS  cells are primitives or tagged objects from main; the grid shows
 *                `display()` text and keeps the canonical value for edit/copy/export.
 *   CONFIRMED UI a cell/row changes on screen only from the persisted row main returns;
 *                zero-match / conflict keeps the old value and says so.
 *   ONE SUBMIT   every mutation form has one in-flight state set before the first await.
 *   PROFILES     the form edits a deep copy; Cancel changes nothing; secrets are kept /
 *                cleared / revealed explicitly; TLS verifies certificates unless the
 *                profile says otherwise.
 *   JOBS         import/export are jobs: Cancel is acknowledged by main, Close only hides
 *                the dialog, results show committed / failed / unattempted / unknown.
 *   A11Y         the grid is a real grid (roles, roving focus, keyboard edit/copy/sort/menu). */

const DB_COLORS = { mysql: "#4479A1", postgres: "#336791", oracle: "#F80000", mongodb: "#47A248", sqlite: "#6BA5D7", mssql: "#CC2927", redis: "#DC382D" };
const DB_PLACEHOLDER = {
  mongodb: '{"collection":"users","op":"find","filter":{},"limit":50}\n\nops: find · findOne · distinct · aggregate · count · indexes · insertOne · insertMany · updateOne · updateMany · deleteOne · deleteMany · command',
  redis: 'GET mykey        HGETALL user:1        SET k v        SCAN 0 COUNT 100\nQuote keys with spaces or special characters: GET "my key"   (\\" \\\\ \\n \\xHH escapes)',
  default: "SELECT * FROM …\n\nAny SQL runs here — each statement gets its own result block; a selection runs only the selected text.\nCtrl+Enter runs · Statements are split by the server-side parser (comments, $$ bodies, DELIMITER, GO and / are understood).",
};
const REDIS_READ = { string: "GET", hash: "HGETALL", list: "LRANGE", set: "SMEMBERS", zset: "ZRANGE", stream: "XRANGE", ReJSON: "JSON.GET", "ReJSON-RL": "JSON.GET" };
const SCHEMA_KINDS = new Set(["postgres", "mssql", "oracle", "mysql"]);

let D = null;
const h = (...a) => D.h(...a);
const icon = (...a) => D.icon(...a);
const toast = (...a) => D.toast(...a);
const atom = () => D.atom;

/* ------------------------------ tiny utils ------------------------------ */
const fmtNum = (n) => (n == null || !Number.isFinite(+n)) ? "" : (+n >= 1e9 ? (+n / 1e9).toFixed(1) + "B" : +n >= 1e6 ? (+n / 1e6).toFixed(1) + "M" : +n >= 1e4 ? (+n / 1e3).toFixed(0) + "k" : +n >= 1e3 ? (+n / 1e3).toFixed(1) + "k" : String(Math.round(+n)));
const fmtBytes = (b) => (b == null || !Number.isFinite(+b)) ? "" : (+b >= 1 << 30 ? (+b / (1 << 30)).toFixed(1) + " GB" : +b >= 1 << 20 ? (+b / (1 << 20)).toFixed(1) + " MB" : +b >= 1024 ? (+b / 1024).toFixed(0) + " KB" : +b + " B");
const fmtInt = (n) => (n == null ? "?" : Number(n).toLocaleString());
const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = (p = "x") => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const errMsg = (e) => String((e && e.message) || e || "");
// Quote an identifier the way the engine expects; "schema.table" splits on schema engines.
function qIdent(kind, part) { const p = String(part); if (kind === "mysql") return "`" + p.replace(/`/g, "``") + "`"; if (kind === "mssql") return "[" + p.replace(/]/g, "]]") + "]"; return '"' + p.replace(/"/g, '""') + '"'; }
function qName(kind, it) { const o = objRef(it); if (o.schema && SCHEMA_KINDS.has(kind)) return qIdent(kind, o.schema) + "." + qIdent(kind, o.table); return qIdent(kind, o.table); }
// Structured object reference for IPC: { schema, table } (from an item or a display string).
const objRef = (it) => (typeof it === "string" ? { schema: "", table: it } : { schema: it.schema || "", table: it.table || it.name });
const objName = (it) => (typeof it === "string" ? it : it.name || (it.schema ? `${it.schema}.${it.table}` : it.table));
const sameObj = (a, b) => !!a && !!b && objName(a) === objName(b);
// Redis: quote one argument for the command editor (round-trips through main's parser).
const redisQuote = (v) => { const s = String(v); return /^[^\s"'\\]+$/.test(s) ? s : '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"'; };
function defaultQ(conn, item) {
  if (conn.kind === "mongodb") return JSON.stringify({ collection: objName(item), op: "find", filter: {}, limit: 50 }, null, 2);
  if (conn.kind === "redis") { const cmd = (item && REDIS_READ[item.keyType]) || "TYPE"; const k = redisQuote(objName(item)); return cmd === "LRANGE" ? `LRANGE ${k} 0 99` : cmd === "ZRANGE" ? `ZRANGE ${k} 0 99 WITHSCORES` : cmd === "XRANGE" ? `XRANGE ${k} - + COUNT 50` : `${cmd} ${k}`; }
  return `SELECT * FROM ${qName(conn.kind, item)}`;
}
function insertTemplate(conn, it, cols) {
  if (conn.kind === "mongodb") return JSON.stringify({ collection: objName(it), op: "insertOne", doc: Object.fromEntries((cols || []).filter((c) => c.name !== "_id").map((c) => [c.name, null])) }, null, 2);
  if (conn.kind === "redis") return `SET ${redisQuote(objName(it))} value`;
  const names = (cols || []).filter((c) => !/auto_increment|identity/i.test(c.extra || "")).map((c) => c.name);
  return `INSERT INTO ${qName(conn.kind, it)} (${names.map((c) => qIdent(conn.kind, c)).join(", ")})\nVALUES (${names.map((c) => `/* ${c} */ NULL`).join(", ")})`;
}
/* ---- typed cells (see db.js VALUES) ---- */
const isTag = (v) => v && typeof v === "object" && typeof v.$t === "string";
function display(v) {
  if (v === null || v === undefined) return "NULL";
  if (!isTag(v)) return typeof v === "string" ? v : String(v);
  switch (v.$t) {
    case "bytes": return v.len > 64 ? `<binary ${fmtInt(v.len)} bytes>` : "0x" + b64hex(v.b64);
    case "json": return v.v;
    default: return String(v.v);
  }
}
function b64hex(b64) { try { return Array.from(atob(b64 || ""), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""); } catch { return ""; } }
// copy/export text: bytes as full hex, everything else canonical
const cellText = (v) => (v === null || v === undefined ? "" : isTag(v) ? (v.$t === "bytes" ? "0x" + b64hex(v.b64) : String(v.v)) : String(v));
const cellClass = (v) => (v === null || v === undefined ? " null" : typeof v === "number" ? " num" : isTag(v) ? (v.$t === "bigint" || v.$t === "decimal" || v.$t === "num" ? " num" : v.$t === "bytes" ? " bytes" : v.$t === "json" ? " json" : " tagged") : isJsonish(v) ? " json" : "");
const cellTitle = (v) => (v === null || v === undefined ? "NULL" : isTag(v) ? `${v.$t}${v.$t === "bytes" ? ` · ${fmtInt(v.len)} bytes` : ""}: ${display(v).slice(0, 300)}` : String(v).slice(0, 400));
const isJsonish = (v) => typeof v === "string" && /^\s*[[{]/.test(v) && /[\]}]\s*$/.test(v);
const prettyJson = (v) => { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } };
// The editor text for a cell → the typed value to send back (preserves the original tag kind)
function parseEdit(raw, cur) {
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
function copyText(t, msg) { navigator.clipboard.writeText(t == null ? "" : String(t)).then(() => toast(msg || "Copied", "check")).catch(() => {}); }
const csvEsc = (v) => { const s = cellText(v); if (v === null || v === undefined) return ""; if (s === "") return '""'; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCSV = (cols, rows) => [cols.map((c) => csvEsc(c)).join(","), ...rows.map((r) => r.map(csvEsc).join(","))].join("\r\n");
const jsonVal = (v) => (isTag(v) ? (v.$t === "json" ? (() => { try { return JSON.parse(v.v); } catch { return v.v; } })() : v.$t === "bytes" ? { $binary: { base64: v.b64, subType: "00" } } : v.$t === "oid" ? { $oid: v.v } : v.$t === "date" ? { $date: v.v } : v.$t === "bigint" ? { $numberLong: v.v } : v.$t === "decimal" ? { $numberDecimal: v.v } : v.v) : v);
const toJSON = (cols, rows) => JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, jsonVal(r[i])]))), null, 2);
const toMD = (cols, rows) => { const e = (v) => (v === null || v === undefined ? "" : cellText(v)).replace(/\|/g, "\\|").replace(/\n/g, " "); return [`| ${cols.map(e).join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(e).join(" | ")} |`)].join("\n"); };
const toTSV = (cols, rows) => [cols.join("\t"), ...rows.map((r) => r.map((v) => (v == null ? "" : cellText(v).replace(/\t|\n/g, " "))).join("\t"))].join("\n");
const numOf = (v) => (typeof v === "number" ? v : isTag(v) && (v.$t === "bigint" || v.$t === "decimal" || v.$t === "num") ? Number(v.v) : (typeof v === "string" && v.trim() !== "" && !isNaN(v) ? +v : NaN));
const cmpVals = (a, b) => {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (isTag(a) && isTag(b) && a.$t === "bigint" && b.$t === "bigint") { try { const x = BigInt(a.v), y = BigInt(b.v); return x < y ? -1 : x > y ? 1 : 0; } catch { /* fall through */ } }
  const an = numOf(a), bn = numOf(b);
  if (!isNaN(an) && !isNaN(bn)) return an - bn;
  return cellText(a).localeCompare(cellText(b), undefined, { numeric: true, sensitivity: "base" });
};

/* ------------------------------ virtual list ------------------------------ */
function vlist({ rowH = 26, overscan = 8, render, className = "", label }) {
  const el = h("div", { class: "dbm-vlist " + className, tabindex: "0", role: "listbox", "aria-label": label || "" });
  const spacer = h("div", { class: "dbm-vlist-spacer" });
  const body = h("div", { class: "dbm-vlist-body" });
  el.append(spacer, body);
  let items = [], raf = 0, lastStart = -1, lastEnd = -1, force = false;
  const draw = () => {
    raf = 0;
    const H = el.clientHeight || 400, top = el.scrollTop;
    const start = Math.max(0, Math.floor(top / rowH) - overscan), end = Math.min(items.length, Math.ceil((top + H) / rowH) + overscan);
    if (!force && start === lastStart && end === lastEnd) return;
    lastStart = start; lastEnd = end; force = false;
    body.style.transform = `translateY(${start * rowH}px)`;
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) { const r = render(items[i], i); r.style.height = rowH + "px"; frag.append(r); }
    body.replaceChildren(frag);
  };
  const schedule = (f) => { if (f) force = true; if (!raf) raf = requestAnimationFrame(draw); };
  el.addEventListener("scroll", () => schedule(false));
  let ro = null;
  if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(() => schedule(true)); ro.observe(el); }
  return {
    el,
    get items() { return items; },
    setItems(list) { items = list || []; spacer.style.height = (items.length * rowH) + "px"; schedule(true); },
    refresh() { schedule(true); },
    scrollToIndex(i) { const y = i * rowH; if (y < el.scrollTop || y + rowH > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, y - el.clientHeight / 2); schedule(true); },
    dispose() { if (ro) ro.disconnect(); },
  };
}

/* ------------------------------ virtual grid (accessible) ------------------------------ */
/* Columns + rows (arrays of typed cells). Sort/filter run on the data; only visible rows
 * are in the DOM. Roles: grid / row / columnheader / gridcell; ONE focusable cell at a
 * time (roving tabindex); Arrow keys move, Enter edits or opens, Ctrl+C copies, Space on
 * a header sorts, Shift+F10 / ContextMenu opens the row menu. Callbacks receive indices
 * into the ORIGINAL rows array. */
function vgrid({ columns, rows, rowH = 26, headH = 30, onCell, onCellDbl, onCellMenu, onRowNum, pkCols = [], externalSort = null, label }) {
  const widths = columns.map((c, ci) => {
    let m = String(c).length;
    const n = Math.min(rows.length, 60);
    for (let i = 0; i < n; i++) { const v = rows[i][ci]; const l = v == null ? 4 : display(v).length; if (l > m) m = l; }
    return Math.max(64, Math.min(360, Math.round(m * 7.2) + 22));
  });
  const total = 46 + widths.reduce((a, b) => a + b, 0);
  const tpl = `46px ${widths.map((w) => w + "px").join(" ")}`;
  const el = h("div", { class: "dbm-vgrid", role: "grid", "aria-label": label || "Results", "aria-rowcount": String(rows.length + 1), "aria-colcount": String(columns.length + 1) });
  const head = h("div", { class: "dbm-vgrid-head", role: "row", "aria-rowindex": "1", style: `grid-template-columns:${tpl}; width:${total}px; height:${headH}px` });
  const spacer = h("div", { class: "dbm-vgrid-spacer", style: `width:${total}px` });
  const body = h("div", { class: "dbm-vgrid-body", style: `top:${headH}px; width:${total}px` });
  el.append(head, spacer, body);
  let view = rows.map((_, i) => i);
  let sortCol = -1, sortAsc = true, filterText = "", selected = -1;
  let focus = { vi: 0, ci: 0 };                              // roving focus (view index, column index incl. row-number col 0)
  const sortState = (ci) => externalSort ? (externalSort.col === String(columns[ci]) ? (externalSort.dir === "desc" ? "descending" : "ascending") : "none") : (sortCol === ci ? (sortAsc ? "ascending" : "descending") : "none");
  const hcell = (text, cls, onclick, title, ci) => {
    const c = h("div", { class: "dbm-vgrid-hcell " + (cls || ""), role: "columnheader", "aria-colindex": String(ci + 1), title: title || text, tabindex: "-1", onclick }, h("span", { text }));
    if (ci > 0) c.setAttribute("aria-sort", sortState(ci - 1));
    c.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && onclick) { e.preventDefault(); onclick(); } });
    return c;
  };
  const drawHead = () => {
    head.replaceChildren(hcell("#", "rn", null, "Row number — Enter opens the row", 0), ...columns.map((c, ci) => {
      const name = String(c);
      const sortCls = externalSort ? (externalSort.col === name ? (externalSort.dir === "desc" ? "sort-desc" : "sort-asc") : "") : (sortCol === ci ? (sortAsc ? "sort-asc" : "sort-desc") : "");
      const cellEl = hcell(name, (pkCols.includes(c) ? "pk " : "") + sortCls, externalSort ? () => externalSort.onClick(name) : () => api.sort(ci), externalSort ? `${name} — sort server-side (Space)` : `${name} — sort (Space)`, ci + 1);
      if (pkCols.includes(c)) cellEl.prepend(h("span", { class: "dbm-pk-ic", html: icon("key", 10), title: "Primary key" }));
      return cellEl;
    }));
  };
  let raf = 0, lastStart = -1, lastEnd = -1, force = false;
  const cellAt = (vi, ci) => { const row = body.querySelector(`.dbm-vrow[data-vi="${vi}"]`); return row ? row.children[ci] : null; };
  const applyFocus = () => { for (const c of el.querySelectorAll('[tabindex="0"]')) c.tabIndex = -1; const target = focus.vi < 0 ? head.children[focus.ci] : cellAt(focus.vi, focus.ci); if (target) { target.tabIndex = 0; return target; } return null; };
  const draw = () => {
    raf = 0;
    const H = el.clientHeight || 300, top = el.scrollTop;
    const start = Math.max(0, Math.floor(Math.max(0, top - headH) / rowH) - 6), end = Math.min(view.length, Math.ceil((top + H) / rowH) + 6);
    if (!force && start === lastStart && end === lastEnd) return;
    lastStart = start; lastEnd = end; force = false;
    body.style.transform = `translateY(${start * rowH}px)`;
    const frag = document.createDocumentFragment();
    for (let vi = start; vi < end; vi++) {
      const ri = view[vi]; const r = rows[ri];
      const row = h("div", { class: "dbm-vrow" + (vi % 2 ? " odd" : "") + (ri === selected ? " sel" : ""), role: "row", "aria-rowindex": String(ri + 2), "aria-selected": ri === selected ? "true" : "false", style: `grid-template-columns:${tpl}; height:${rowH}px`, dataset: { ri: String(ri), vi: String(vi) } });
      row.append(h("div", { class: "dbm-vcell rn", role: "rowheader", "aria-colindex": "1", tabindex: "-1", text: String(ri + 1), onclick: (e) => onRowNum && onRowNum(ri, e) }));
      for (let ci = 0; ci < columns.length; ci++) {
        const v = r[ci];
        const cell = h("div", { class: "dbm-vcell" + cellClass(v), role: "gridcell", "aria-colindex": String(ci + 2), tabindex: "-1", text: display(v), title: cellTitle(v) });
        cell.onclick = (e) => { const s = window.getSelection(); if (s && !s.isCollapsed && cell.contains(s.anchorNode)) return; focus = { vi, ci: ci + 1 }; applyFocus(); api.select(ri); onCell && onCell(ri, ci, e); };
        cell.ondblclick = (e) => onCellDbl && onCellDbl(ri, ci, e, cell);
        cell.oncontextmenu = (e) => { e.preventDefault(); api.select(ri); onCellMenu && onCellMenu(ri, ci, e); };
        row.append(cell);
      }
      frag.append(row);
    }
    body.replaceChildren(frag);
    applyFocus();
  };
  const schedule = (f) => { if (f) force = true; if (!raf) raf = requestAnimationFrame(draw); };
  el.addEventListener("scroll", () => schedule(false));
  let ro = null;
  if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(() => schedule(true)); ro.observe(el); }
  // keyboard: roving focus + actions
  el.addEventListener("keydown", (e) => {
    const editing = e.target && e.target.tagName === "INPUT"; if (editing) return;
    const maxVi = view.length - 1, maxCi = columns.length;
    let { vi, ci } = focus; let handled = true;
    if (e.key === "ArrowDown") vi = Math.min(maxVi, vi + 1);
    else if (e.key === "ArrowUp") vi = vi <= 0 ? -1 : vi - 1;
    else if (e.key === "ArrowRight") ci = Math.min(maxCi, ci + 1);
    else if (e.key === "ArrowLeft") ci = Math.max(0, ci - 1);
    else if (e.key === "Home") ci = (e.ctrlKey || e.metaKey) ? (vi = 0, 0) : 0;
    else if (e.key === "End") ci = (e.ctrlKey || e.metaKey) ? (vi = maxVi, maxCi) : maxCi;
    else if (e.key === "PageDown") vi = Math.min(maxVi, vi + Math.max(1, Math.floor((el.clientHeight || 300) / rowH) - 1));
    else if (e.key === "PageUp") vi = Math.max(0, vi - Math.max(1, Math.floor((el.clientHeight || 300) / rowH) - 1));
    else if (e.key === "Enter" && vi >= 0) { const ri = view[vi]; if (ci === 0) { onRowNum && onRowNum(ri, e); } else { const c = cellAt(vi, ci); onCellDbl && onCellDbl(ri, ci - 1, e, c); } }
    else if ((e.key === "c" || e.key === "C") && (e.ctrlKey || e.metaKey) && vi >= 0 && ci > 0) { const s = window.getSelection(); if (s && !s.isCollapsed) return; copyText(cellText(rows[view[vi]][ci - 1]), "Cell copied"); }
    else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") { if (vi >= 0) { const ri = view[vi]; api.select(ri); const c = cellAt(vi, ci) || el; const r = c.getBoundingClientRect(); onCellMenu && onCellMenu(ri, Math.max(0, ci - 1), { clientX: r.left + 8, clientY: r.bottom, preventDefault() {} }); } }
    else handled = false;
    if (!handled) return;
    e.preventDefault();
    if (vi !== focus.vi || ci !== focus.ci) {
      focus = { vi, ci };
      if (vi >= 0) { const y = headH + vi * rowH; if (y < el.scrollTop + headH) el.scrollTop = y - headH; else if (y + rowH > el.scrollTop + el.clientHeight) el.scrollTop = y + rowH - el.clientHeight; }
      draw(); const t = applyFocus(); if (t) t.focus({ preventScroll: true });
      if (vi >= 0) api.select(view[vi]);
    }
  });
  el.addEventListener("focusin", (e) => { if (e.target === el) { const t = applyFocus(); if (t) t.focus({ preventScroll: true }); } });
  const rebuild = () => {
    let idx = rows.map((_, i) => i);
    if (filterText) { const f = filterText.toLowerCase(); idx = idx.filter((i) => rows[i].some((v) => v != null && display(v).toLowerCase().includes(f))); }
    if (sortCol >= 0) idx.sort((a, b) => { const c = cmpVals(rows[a][sortCol], rows[b][sortCol]); return sortAsc ? c : -c; });
    view = idx;
    spacer.style.height = (headH + view.length * rowH) + "px";
    el.setAttribute("aria-rowcount", String(view.length + 1));
    focus.vi = Math.min(focus.vi, view.length - 1);
    drawHead(); schedule(true);
  };
  const api = {
    el, columns, rows,
    get visibleCount() { return view.length; },
    sort(ci) { if (sortCol === ci) { if (sortAsc) sortAsc = false; else { sortCol = -1; sortAsc = true; } } else { sortCol = ci; sortAsc = true; } rebuild(); },
    filter(t) { filterText = (t || "").trim(); rebuild(); },
    select(ri) { selected = ri; for (const r of body.children) { const on = +r.dataset.ri === ri; r.classList.toggle("sel", on); r.setAttribute("aria-selected", on ? "true" : "false"); } },
    setCell(ri, ci, v) { rows[ri][ci] = v; schedule(true); },
    setRow(ri, values) { for (let i = 0; i < values.length && i < rows[ri].length; i++) rows[ri][i] = values[i]; schedule(true); },
    removeRows(set) { const keep = rows.map((_, i) => i).filter((i) => !set.has(i)); const nr = keep.map((i) => rows[i]); rows.length = 0; rows.push(...nr); selected = -1; rebuild(); },
    viewRows() { return view.map((i) => rows[i]); },
    refresh() { rebuild(); },
    focusCell(ri, ci) { const vi = view.indexOf(ri); if (vi < 0) return; focus = { vi, ci: ci + 1 }; draw(); const t = applyFocus(); if (t) t.focus({ preventScroll: true }); },
    dispose() { if (ro) ro.disconnect(); },
  };
  rebuild();
  return api;
}
/* ============================================================
   MOUNT
   ============================================================ */
export async function mountDbManager(mountEl, deps) {
  D = deps;
  const disposers = [];
  let kinds = []; try { kinds = await atom().db.kinds(); } catch { /* offline */ }
  let conns = []; let connsError = "";
  try { conns = await atom().db.list(); } catch (e) { connsError = errMsg(e); conns = []; }
  const kindOf = (id) => kinds.find((k) => k.id === id) || { name: id, fields: [], policies: [] };
  const chip = (kind, size = 22) => h("span", { class: "dbm-chip", "aria-hidden": "true", style: `background:${DB_COLORS[kind] || "var(--bg-4)"}; width:${size}px; height:${size}px;`, text: (kindOf(kind).name || "?")[0] });
  const setDot = (el, live) => { if (el) el.style.background = live ? "#58c07a" : "var(--text-4)"; };
  const objNoun = (kind, plural = true) => kind === "mongodb" ? (plural ? "Collections" : "collection") : kind === "redis" ? (plural ? "Keys" : "key") : (plural ? "Tables" : "table");
  const connById = (id) => conns.find((c) => c.id === id) || null;
  const pref = (k, d) => { try { const v = localStorage.getItem("dbm-" + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem("dbm-" + k, JSON.stringify(v)); } catch { /* */ } };

  /* ---- tabs (never mutated on close: a closed tab's run context stays its own) ---- */
  const mkTab = (conn = null) => ({ id: uid("t"), conn, connLive: false, cur: null, mode: "query", busy: false, run: null, session: null, sessionTx: false, autocommit: true, wsEl: null, schema: null, filter: "", typeFilter: "all", sortBy: "name", _limit: pref("limit", 200), _draft: "", struct: new Map(), structTab: "columns", log: [], logMin: pref("log-min", false), browse: { offset: 0, limit: pref("page", 200), orderBy: "", dir: "asc", where: "", search: "", total: null }, pendingByTable: new Map(), disposers: [] });
  let tabs = [mkTab()];
  let activeTabId = tabs[0].id;
  const AT = () => tabs.find((t) => t.id === activeTabId) || tabs[0];
  const tabsOf = (connId) => tabs.filter((t) => t.conn && t.conn.id === connId);

  /* ---- query history (per connection, localStorage; retention is a preference) ---- */
  const hKey = (id) => "dbm-h-" + id;
  const hLoad = (id) => { try { return JSON.parse(localStorage.getItem(hKey(id)) || "[]"); } catch { return []; } };
  const hPush = (id, sql) => { if (!sql || !id || pref("hist-off", false)) return; const arr = hLoad(id).filter((x) => x !== sql); arr.unshift(sql); try { localStorage.setItem(hKey(id), JSON.stringify(arr.slice(0, pref("hist-max", 100)))); } catch { /* full */ } };
  const hClear = (id) => { try { localStorage.removeItem(hKey(id)); } catch { /* */ } };
  const hClearAll = () => { try { for (const k of Object.keys(localStorage)) if (k.startsWith("dbm-h-")) localStorage.removeItem(k); } catch { /* */ } };

  // Error card. A missing driver gets an Install button; extra actions can be added.
  const errBanner = (e, kind, { onInstalled, extra } = {}) => {
    const msg = errMsg(e), type = (e && e.type) || "";
    const isPolicy = type === "policy" || /^Policy:/.test(msg);
    const isConn = type === "transport" || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(msg);
    const isAuth = type === "auth" || /Access denied|authentication|password|login failed|ER_ACCESS/i.test(msg);
    const isUnknown = type === "outcome-unknown";
    const wrap = h("div", { class: "dbm-err" + (isPolicy ? " dbm-policy-block" : "") + (isUnknown ? " dbm-unknown" : "") },
      h("span", { html: icon("alert", 13) }),
      h("div", { class: "dbm-err-body" }, h("span", { text: msg }),
        isUnknown ? h("span", { class: "dbm-err-hint", text: "Do not re-run blindly: check whether the change is present first." }) : null,
        isConn ? h("span", { class: "dbm-err-hint", text: "Server not reachable — is it running, and are host/port right?" }) : null,
        isAuth ? h("span", { class: "dbm-err-hint", text: "Check the user, password and database on this connection." }) : null,
        e && e.hint ? h("span", { class: "dbm-err-hint", text: e.hint }) : null,
        type ? h("span", { class: "dbm-err-type", text: type }) : null));
    const m = msg.match(/Driver "([^"]+)" is not installed/);
    const acts = h("div", { class: "dbm-err-acts" });
    if (m && kind) acts.append(h("button", { class: "btn btn-primary btn-sm", text: `Install ${m[1]}`, onclick: async (ev) => {
      const b = ev.currentTarget; b.disabled = true; b.innerHTML = '<span class="dbm-spinner"></span> Installing…';
      const note = h("span", { class: "dbm-err-hint", text: "Downloading with npm — usually 10–60 s." }); acts.append(note);
      const r = await atom().db.installDriver(kind).catch((x) => ({ ok: false, detail: x.message }));
      note.remove();
      toast(r.ok ? "Driver installed and loaded ✓" + (r.version ? " · " + r.version : "") : `Install ${r.state || "failed"}: ${r.detail || ""}`, r.ok ? "check" : "alert", { ms: r.ok ? 3500 : 8000 });
      kinds = await atom().db.kinds().catch(() => kinds);
      if (r.ok && onInstalled) onInstalled(); else { b.disabled = false; b.textContent = `Install ${m[1]}`; }
    } }));
    for (const a of extra || []) acts.append(a);
    if (acts.childNodes.length) wrap.append(acts);
    return wrap;
  };
  // Every dismissal (Cancel, ×, backdrop, Escape) resolves false — never a dangling decision.
  const confirm = async (title, message, label, danger = true) => (await D.chooseDialog({ title, ic: danger ? "alert" : "db", message, choices: [{ label, value: "yes", primary: true }, { label: "Cancel", value: null }] })) === "yes";

  /* ---- DOM scaffold ---- */
  const side = h("aside", { class: "dbm-side", role: "complementary", "aria-label": "Connections and objects" });
  const tabBar = h("div", { class: "dbm-tabbar", role: "tablist", "aria-label": "Connection tabs" });
  const wsHost = h("div", { class: "dbm-ws-host" });
  mountEl.append(h("div", { class: "dbm-wrap" }, side, h("section", { class: "dbm-main" }, tabBar, wsHost)));

  /* ---- tab bar ---- */
  const renderTabBar = () => {
    tabBar.innerHTML = "";
    for (const t of tabs) {
      const active = t.id === activeTabId;
      const dot = h("span", { class: "dbm-tab-dot-sm" }); setDot(dot, t.connLive);
      const tabEl = h("div", { class: "dbm-conn-tab" + (active ? " active" : "") + (t.busy ? " busy" : ""), role: "tab", tabindex: active ? "0" : "-1", "aria-selected": active ? "true" : "false", onclick: () => switchTab(t.id), onauxclick: (e) => { if (e.button === 1) closeTab(t.id); }, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchTab(t.id); } else if (e.key === "Delete") closeTab(t.id); } });
      if (t.conn) tabEl.append(chip(t.conn.kind, 15), dot);
      tabEl.append(h("span", { class: "dbm-conn-tab-name", text: t.conn ? (t.conn.name || kindOf(t.conn.kind).name) + (t.cur ? " · " + objName(t.cur) : "") : "New tab" }),
        t.busy ? h("span", { class: "dbm-spinner sm", title: "Running" }) : null,
        h("button", { class: "dbm-tab-x", html: icon("x", 9), title: "Close tab", "aria-label": "Close tab", onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }));
      tabBar.append(tabEl);
    }
    tabBar.append(h("button", { class: "dbm-tab-add", html: icon("plus", 12), title: "New tab", "aria-label": "New tab", onclick: () => { const nt = mkTab(); tabs.push(nt); switchTab(nt.id); } }));
  };
  const hideAllWs = () => { for (const el of wsHost.children) el.style.display = "none"; };
  const switchTab = (id) => {
    activeTabId = id;
    hideAllWs();
    const at = AT();
    if (at.wsEl) at.wsEl.style.display = "";
    else if (at.conn) buildWorkspace(at);
    else showWelcome();
    renderTabBar(); renderSide();
  };
  // Release a tab's backend session (rolling back an open transaction) and UI resources.
  const disposeTab = async (t) => {
    for (const d0 of t.disposers.splice(0)) { try { d0(); } catch { /* */ } }
    if (t.wsEl) { t.wsEl.remove(); t.wsEl = null; }
    if (t.session) { const sid = t.session; t.session = null; t.sessionTx = false; await atom().db.sessionClose(sid, { rollback: true }).catch(() => {}); }
  };
  const hasDraft = (t) => !!((t._draft && t._draft.trim()) || [...t.pendingByTable.values()].some((p) => pendingCount(p) > 0));
  const closeTab = async (id) => {
    const t = tabs.find((x) => x.id === id); if (!t) return;
    if (t.busy && !(await confirm("Close busy tab", "A statement is still running in this tab. Closing detaches the tab; the statement finishes (or is cancelled) on its original connection. Close anyway?", "Close tab"))) return;
    if (!t.busy && hasDraft(t) && !(await confirm("Discard draft", `This tab has ${t._draft && t._draft.trim() ? "an unsaved query draft" : ""}${t._draft && t._draft.trim() && [...t.pendingByTable.values()].some((p) => pendingCount(p) > 0) ? " and " : ""}${[...t.pendingByTable.values()].some((p) => pendingCount(p) > 0) ? "pending schema changes" : ""}. Close and discard?`, "Discard & close"))) return;
    if (t.sessionTx && !(await confirm("Open transaction", "This tab has an uncommitted transaction. Closing the tab rolls it back. Continue?", "Roll back & close"))) return;
    const idx = tabs.indexOf(t);
    if (t.run) t.run.detached = true;                       // a run in flight keeps ITS context; the UI just stops updating
    await disposeTab(t);
    tabs.splice(idx, 1);
    if (!tabs.length) tabs.push(mkTab());                    // always a fresh object — never the old one reused
    if (activeTabId === id) activeTabId = tabs[Math.max(0, idx - 1)].id;
    switchTab(activeTabId);
  };
  /* Open a connection: reuse the tab already showing it, else fill the current EMPTY tab,
   * else a new tab (forceNew always opens a new one). */
  const openInTab = (conn, forceNew = false) => {
    setPref("last-conn", conn.id);
    if (!forceNew) {
      const existing = tabsOf(conn.id)[0];
      if (existing) { switchTab(existing.id); if (!existing.schema) loadSchema(existing); return; }
      const at = AT();
      if (!at.conn) { at.conn = conn; at.connLive = false; at.cur = null; at.schema = null; switchTab(at.id); loadSchema(at); return; }
    }
    const nt = mkTab(conn); tabs.push(nt); activeTabId = nt.id;
    switchTab(activeTabId); loadSchema(nt);
  };

  /* ---- connection status: desired state + generation per connection ----
   * live | error | reconnecting | off. `desired` records what the USER asked for; an
   * in-flight health result from before a disconnect (older generation) is ignored. */
  const connStatus = new Map(), desired = new Map(), statusGen = new Map();
  const genOf = (id) => statusGen.get(id) || 0;
  const bumpGen = (id) => { statusGen.set(id, genOf(id) + 1); return genOf(id); };
  const statusTitle = (st) => st === "live" ? "Connected — click to disconnect" : st === "error" ? "Connection failed — click to retry" : st === "reconnecting" ? "Connection dropped — reconnecting automatically (click to stop)" : "Not connected — click to connect";
  const syncConnCards = () => {
    for (const el of side.querySelectorAll(".dbm-conn")) {
      const st = connStatus.get(el.dataset.id) || "off";
      el.classList.toggle("live", st === "live"); el.classList.toggle("error", st === "error"); el.classList.toggle("reconnecting", st === "reconnecting");
      const d = el.querySelector(".dbm-conn-dot"); if (d) { d.className = "dbm-conn-dot " + st; d.title = statusTitle(st); }
      const b = el.querySelector(".dbm-conn-act");
      if (b) { b.innerHTML = icon(st === "live" || st === "reconnecting" ? "wifiOff" : "wifi", 12); b.title = st === "live" ? "Disconnect" : st === "reconnecting" ? "Stop reconnecting" : st === "error" ? "Retry" : "Connect"; b.setAttribute("aria-label", b.title); b.dataset.live = st === "live" || st === "reconnecting" ? "1" : ""; }
      const s = el.querySelector(".dbm-conn-status"); if (s) s.textContent = st === "live" ? "connected" : st === "error" ? "failed" : st === "reconnecting" ? "reconnecting…" : "";
    }
    // every view of a connection (tab dots, toolbar dots) follows the one status
    for (const t of tabs) if (t.conn) { const live = connStatus.get(t.conn.id) === "live"; if (t.connLive !== live) { t.connLive = live; } const i = tabs.indexOf(t); const el = tabBar.querySelectorAll(".dbm-conn-tab")[i]; if (el) setDot(el.querySelector(".dbm-tab-dot-sm"), live); if (t.wsEl) setDot(t.wsEl.querySelector(".dbm-dot"), live); }
  };
  const setConnStatus = (id, st, { gen } = {}) => { if (!id) return; if (gen != null && gen !== genOf(id)) return; connStatus.set(id, st); syncConnCards(); };

  /* ------------------------------ EXECUTION LOG ------------------------------ */
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour12: false });
  const logPush = (tab, e) => {
    if (!tab) return;
    tab.log.unshift({ ts: Date.now(), ...e });
    if (tab.log.length > pref("log-max", 500)) tab.log.length = pref("log-max", 500);
    renderLog(tab);
  };
  const logAll = (connId, e) => { for (const t of tabsOf(connId)) logPush(t, e); };
  const toggleLog = (tab) => {
    tab.logMin = !tab.logMin; setPref("log-min", tab.logMin);
    if (tab._log) { tab._log.panel.classList.toggle("min", tab.logMin); tab._log.minBtn.innerHTML = icon(tab.logMin ? "chevronRight" : "chevronDown", 13); tab._log.minBtn.title = tab.logMin ? "Expand log (Ctrl+L)" : "Minimize log (Ctrl+L)"; tab._log.minBtn.setAttribute("aria-expanded", tab.logMin ? "false" : "true"); }
    renderLog(tab);
  };
  const buildLogPanel = (tab) => {
    const body = h("div", { class: "dbm-log-body", role: "log", "aria-label": "Execution log" });
    const count = h("span", { class: "dbm-schema-count", text: "0" });
    const last = h("span", { class: "dbm-log-last" });
    const minBtn = h("button", { class: "dbm-mini", title: tab.logMin ? "Expand log (Ctrl+L)" : "Minimize log (Ctrl+L)", "aria-expanded": tab.logMin ? "false" : "true", html: icon(tab.logMin ? "chevronRight" : "chevronDown", 13), onclick: (e) => { e.stopPropagation(); toggleLog(tab); } });
    const panel = h("div", { class: "dbm-log" + (tab.logMin ? " min" : "") },
      h("div", { class: "dbm-log-head", onclick: () => { if (tab.logMin) toggleLog(tab); }, ondblclick: () => { if (!tab.logMin) toggleLog(tab); } },
        h("span", { class: "dbm-log-ic", html: icon("terminal", 13) }), h("span", { class: "dbm-log-title", text: "Execution log" }), count, last,
        h("div", { class: "spacer" }),
        h("button", { class: "dbm-mini", title: "Copy log", "aria-label": "Copy log", html: icon("copy", 12), onclick: (e) => { e.stopPropagation(); copyText(tab.log.map((l) => `${fmtTime(l.ts)}  ${l.ok ? "OK " : l.state === "unknown" ? "?? " : "ERR"}  ${l.ms != null ? String(l.ms).padStart(6) + " ms" : "         "}  ${(l.text || "").replace(/\s+/g, " ")}${l.error ? "  -- " + l.error : ""}`).reverse().join("\n"), "Log copied"); } }),
        h("button", { class: "dbm-mini", title: "Clear log", "aria-label": "Clear log", html: icon("trash", 12), onclick: (e) => { e.stopPropagation(); tab.log = []; renderLog(tab); } }),
        minBtn),
      body);
    try { const hh = +localStorage.getItem("dbm-log-h"); if (hh >= 80) panel.style.height = hh + "px"; } catch { /* */ }
    if (typeof ResizeObserver !== "undefined") { const ro = new ResizeObserver(() => { if (!panel.classList.contains("min") && panel.offsetHeight >= 80) { try { localStorage.setItem("dbm-log-h", String(panel.offsetHeight)); } catch { /* */ } } }); ro.observe(panel); tab.disposers.push(() => ro.disconnect()); }
    tab._log = { panel, body, count, minBtn, last };
    renderLog(tab);
    return panel;
  };
  const renderLog = (tab) => {
    const L = tab._log; if (!L) return;
    L.count.textContent = String(tab.log.length);
    const last = tab.log[0];
    L.last.textContent = last ? `${last.ok ? "✓" : last.state === "unknown" ? "?" : "✗"} ${(last.text || "").replace(/\s+/g, " ").slice(0, 90)}${last.ms != null ? ` · ${last.ms} ms` : ""}` : "";
    L.last.className = "dbm-log-last" + (last && !last.ok ? " err" : "");
    if (tab.logMin) return;
    L.body.innerHTML = "";
    if (!tab.log.length) { L.body.append(h("div", { class: "dbm-empty", text: "Every statement you run — queries, page loads, edits, DDL, imports — is logged here with timing, row counts and outcome." })); return; }
    const shown = tab.log.slice(0, pref("log-page", 200));
    for (const e of shown) {
      const row = h("div", { class: "dbm-log-row" + (e.ok ? "" : e.state === "unknown" ? " unknown" : " err"), title: "Click to expand · double-click to load into the editor", tabindex: "0",
        onclick: () => row.classList.toggle("open"),
        onkeydown: (ev) => { if (ev.key === "Enter") row.classList.toggle("open"); },
        ondblclick: () => { if (tab._ed && e.text && e.kind !== "conn") { tab._ed.value = e.text; tab._draft = e.text; openQuery(tab); } },
        oncontextmenu: (ev) => { ev.preventDefault(); D.showContextMenu(ev.clientX, ev.clientY, [{ label: "Copy statement", icon: "copy", onClick: () => copyText(e.text, "Copied") }, { label: "Load into editor", icon: "edit", onClick: () => { if (tab._ed) { tab._ed.value = e.text; tab._draft = e.text; openQuery(tab); } } }, ...(e.error ? [{ label: "Copy error", icon: "copy", onClick: () => copyText(e.error, "Copied") }] : [])]); } },
        h("span", { class: "dbm-log-time", text: fmtTime(e.ts) }),
        h("span", { class: "dbm-log-kind k-" + (e.kind || "query"), text: e.kind || "query" }),
        h("span", { class: "dbm-log-text", text: e.text || "" }),
        h("span", { class: "dbm-log-meta", text: e.ok ? [e.rows != null ? `${fmtInt(e.rows)} rows${e.hasMore ? "+" : ""}` : "", e.affected != null && e.rows == null ? `${fmtInt(e.affected)} affected` : "", e.ms != null ? `${e.ms} ms` : ""].filter(Boolean).join(" · ") : (e.state === "unknown" ? "outcome unknown — " : "") + (e.error || "error") }));
      L.body.append(row);
    }
    if (tab.log.length > shown.length) L.body.append(h("div", { class: "dbm-empty", text: `${fmtInt(tab.log.length - shown.length)} older entries — use Copy log for the complete list.` }));
  };

  /* ------------------------------ HEALTH ------------------------------
   * Every 20 s (and when the network/window comes back) each live or dropped
   * connection is pinged IN PARALLEL on the shared handle. Results carry the status
   * generation they were started under: a disconnect in between wins. Auth / permission
   * failures become "error" (they never heal by waiting); transport failures "reconnecting". */
  const HEALTH_MS = 20000;
  const connLabel = (c) => c.name || kindOf(c.kind).name;
  let healthTimer = 0;
  const checkOne = async (c, eager) => {
    const st = connStatus.get(c.id);
    if (st !== "live" && st !== "reconnecting") return;
    if (desired.get(c.id) === "off") return;
    if (st === "reconnecting" && !navigator.onLine && !eager) return;
    const gen = genOf(c.id);
    let r; try { r = await atom().db.ping(c.id); } catch (e) { r = { ok: false, detail: e.message, type: e.type }; }
    if (gen !== genOf(c.id) || desired.get(c.id) === "off") return;   // disconnected / re-targeted meanwhile → stale result
    if (r.ok) {
      if (st !== "live") {
        setConnStatus(c.id, "live", { gen });
        toast(`Reconnected to ${connLabel(c)}`, "checkCircle", { ms: 3500 });
        logAll(c.id, { kind: "conn", text: `reconnected to ${connLabel(c)}`, ok: true, ms: r.ms });
        for (const t of tabsOf(c.id)) { if (!t.schema) loadSchema(t); else if (t === AT() && t.mode === "browse" && t.cur) renderBrowse(t); }
      }
    } else if (st === "live" || (st === "reconnecting" && (r.type === "auth" || r.type === "permission" || r.type === "secret-locked"))) {
      const fatal = r.type === "auth" || r.type === "permission" || r.type === "secret-locked" || r.type === "driver-missing" || r.type === "driver-broken";
      setConnStatus(c.id, fatal ? "error" : "reconnecting", { gen });
      toast(fatal ? `${connLabel(c)}: ${r.detail}` : `Lost connection to ${connLabel(c)} — reconnecting…`, "alert", { ms: 5000 });
      logAll(c.id, { kind: "conn", text: `connection ${fatal ? "failed" : "lost"} — ${r.detail}`, ok: false, error: r.detail });
    }
  };
  const checkHealth = async (eager) => { await Promise.allSettled(conns.map((c) => checkOne(c, eager))); };
  const startHealth = () => {
    if (healthTimer) return;
    healthTimer = setInterval(() => checkHealth(false), HEALTH_MS);
    const onOnline = () => { toast("Network is back — reconnecting…", "wifi", { ms: 2500 }); setTimeout(() => checkHealth(true), 800); };
    const onOffline = () => { let any = false; for (const c of conns) if (connStatus.get(c.id) === "live") { any = true; bumpGen(c.id); setConnStatus(c.id, "reconnecting"); } if (any) toast("Network offline — connections will resume automatically", "wifiOff", { ms: 3500 }); };
    const onVis = () => { if (!document.hidden) checkHealth(true); };
    window.addEventListener("online", onOnline); window.addEventListener("offline", onOffline); document.addEventListener("visibilitychange", onVis);
    disposers.push(() => { clearInterval(healthTimer); healthTimer = 0; window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); document.removeEventListener("visibilitychange", onVis); });
  };
  // An operation failed: typed transport errors → reconnecting; auth/permission/policy → not a connection problem.
  const noteFailure = (tab, err) => {
    if (!tab || !tab.conn) return;
    const type = (err && err.type) || "";
    const msg = errMsg(err);
    const transport = type === "transport" || type === "outcome-unknown" || /ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EPIPE|not connected|Driver .* is not installed/i.test(msg);
    if (!transport && type !== "auth" && type !== "secret-locked" && type !== "driver-missing" && type !== "driver-broken") return;
    const fatal = type === "auth" || type === "secret-locked" || type === "driver-missing" || type === "driver-broken";
    const gen = bumpGen(tab.conn.id);
    setConnStatus(tab.conn.id, fatal ? "error" : "reconnecting", { gen });
    if (!fatal) setTimeout(() => checkHealth(true), 2500);
  };
  const disconnectConn = async (c) => {
    desired.set(c.id, "off"); bumpGen(c.id);
    for (const t of tabsOf(c.id)) { if (t.session) { const sid = t.session; t.session = null; t.sessionTx = false; await atom().db.sessionClose(sid, { rollback: true }).catch(() => {}); } }
    await atom().db.disconnect(c.id).catch(() => {});
    setConnStatus(c.id, "off");
    for (const t of tabsOf(c.id)) syncSessionBadge(t);
    toast("Disconnected", "check");
  };
  const markLive = (tab) => { if (!tab.conn) return; desired.set(tab.conn.id, "on"); setConnStatus(tab.conn.id, "live"); };

  /* ---- welcome ---- */
  let _welcomeEl = null;
  const showWelcome = () => {
    hideAllWs();
    if (!_welcomeEl) {
      const grid = h("div", { class: "dbm-kinds" });
      for (const k of kinds) grid.append(h("button", { class: "dbm-kind-card", onclick: () => drawConnForm(null, { kind: k.id }) },
        chip(k.id, 30), h("span", { class: "dbm-kind-name", text: k.name }), h("span", { class: "dbm-kind-sub", text: k.installed ? "driver ready" : "installs on first use" })));
      const autoCb = h("input", { type: "checkbox" }); autoCb.checked = !!pref("autoconnect", false); autoCb.onchange = () => setPref("autoconnect", autoCb.checked);
      _welcomeEl = h("div", { class: "dbm-welcome" },
        h("div", { class: "dbm-welcome-title" }, h("span", { html: icon("db", 20) }), h("span", { text: "Database Manager" })),
        h("div", { class: "dbm-welcome-sub", text: "Connect to 7 engines · browse tables with stable server-side paging and inline editing · run scripts statement by statement in your own session · inspect columns, indexes, foreign keys and DDL. Ctrl+Click a connection to open it in a new tab." }),
        grid,
        h("label", { class: "dbm-check dbm-welcome-pref" }, autoCb, h("span", { text: "Open the last used connection when the Database Manager starts" })),
        connsError ? errBanner({ message: "Saved connections could not be read: " + connsError }, null) : null);
      wsHost.append(_welcomeEl);
    }
    _welcomeEl.style.display = "";
  };

  /* ============================================================
     SIDEBAR — connections + virtualised object list
     ============================================================ */
  let objList = null;
  const renderSide = () => {
    if (objList) { objList.dispose(); objList = null; }
    side.innerHTML = "";
    side.append(h("div", { class: "dbm-side-head" },
      h("span", { text: "Connections" }), h("span", { class: "dbm-schema-count", text: String(conns.length) }),
      h("button", { class: "dbm-mini", html: icon("plus", 13), title: "Add connection", "aria-label": "Add connection", onclick: () => drawConnForm() })));
    const listEl = h("div", { class: "dbm-conns", role: "list" });
    if (connsError) listEl.append(errBanner({ message: connsError, type: "store" }, null, { extra: [h("button", { class: "btn btn-ghost btn-sm", text: "Retry", onclick: async () => { try { conns = await atom().db.list(); connsError = ""; } catch (e) { connsError = errMsg(e); } renderSide(); } })] }));
    else if (!conns.length) listEl.append(h("div", { class: "dbm-empty", text: "No connections yet — click + or pick an engine." }));
    const at = AT();
    for (const c of conns) {
      const isCur = at.conn && at.conn.id === c.id;
      const locked = c.policy && Object.values(c.policy).some((v) => (Array.isArray(v) ? v.length : v));
      const st = connStatus.get(c.id) || "off";
      const secretIssue = c.secretLocked && Object.keys(c.secretLocked).length;
      listEl.append(h("div", { class: "dbm-conn" + (isCur ? " sel" : "") + (st === "live" ? " live" : st === "error" ? " error" : ""), role: "listitem", tabindex: "0", dataset: { id: c.id }, title: "Click to open · Ctrl/⌘+Click opens a new tab · right-click for more", onclick: (e) => openInTab(c, e.ctrlKey || e.metaKey), onkeydown: (e) => { if (e.key === "Enter") openInTab(c, e.ctrlKey || e.metaKey); }, oncontextmenu: (e) => { e.preventDefault(); connMenu(e, c); } },
        h("span", { class: "dbm-conn-chipwrap" }, chip(c.kind), h("span", { class: "dbm-conn-dot " + st, title: statusTitle(st) })),
        h("div", { class: "dbm-conn-meta" },
          h("div", { class: "dbm-conn-name" }, h("span", { text: c.name || kindOf(c.kind).name }), h("span", { class: "dbm-conn-status", text: st === "live" ? "connected" : st === "error" ? "failed" : "" })),
          h("div", { class: "dbm-conn-kind" }, h("span", { text: kindOf(c.kind).name + (c.database ? " · " + c.database : "") + (c.host && c.host !== "localhost" ? " · " + c.host : "") }), locked ? h("span", { class: "dbm-lock-ic", html: icon("shield", 10), title: "Security policy active" }) : null, secretIssue ? h("span", { class: "dbm-lock-ic warn", html: icon("alert", 10), title: "Saved credential cannot be decrypted on this account — edit the connection" }) : null)),
        h("button", { class: "dbm-mini dbm-conn-act", html: icon(st === "live" ? "wifiOff" : "wifi", 12), title: st === "live" ? "Disconnect" : (st === "error" ? "Retry" : "Connect"), "aria-label": st === "live" ? "Disconnect" : "Connect", dataset: { live: st === "live" ? "1" : "" }, onclick: (e) => { e.stopPropagation(); if (e.currentTarget.dataset.live) disconnectConn(c); else openInTab(c); } }),
        h("button", { class: "dbm-mini", html: icon("moreVert", 13), title: "Actions", "aria-label": "Connection actions", onclick: (e) => { e.stopPropagation(); connMenu(e, c); } })));
    }
    side.append(listEl);
    syncConnCards();
    if (!at.conn) return;
    // ---- objects (tables / collections / keys) ----
    const noun = objNoun(at.conn.kind);
    const countEl = h("span", { class: "dbm-schema-count" });
    const filterIn = h("input", { class: "dbm-filter", type: "search", placeholder: `Filter ${noun.toLowerCase()}…  (Ctrl+K)`, value: at.filter || "", "aria-label": `Filter ${noun.toLowerCase()}` });
    const chips = h("div", { class: "dbm-type-chips" });
    const sortBtn = h("button", { class: "dbm-mini", title: "Sort: by name / by rows", "aria-label": "Toggle sort by rows", html: icon("list", 12), onclick: () => { at.sortBy = at.sortBy === "name" ? "rows" : "name"; sortBtn.classList.toggle("on", at.sortBy === "rows"); applyObjFilter(at); } });
    sortBtn.classList.toggle("on", at.sortBy === "rows");
    const head = h("div", { class: "dbm-side-head" }, h("span", { text: noun }), countEl, sortBtn,
      h("button", { class: "dbm-mini", html: icon("refresh", 12), title: "Refresh (F5)", "aria-label": "Refresh objects", onclick: () => loadSchema(at) }));
    objList = vlist({ rowH: 26, className: "dbm-tables", label: noun, render: (it) => objRow(at, it) });
    objList.el.addEventListener("keydown", (e) => objKeys(at, e));
    side.append(head, h("div", { class: "dbm-filter-wrap" }, filterIn), chips, objList.el);
    at._objUI = { countEl, filterIn, chips, list: objList };
    filterIn.addEventListener("input", debounce(() => { at.filter = filterIn.value; applyObjFilter(at); }, 90));
    filterIn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); objList.el.focus(); } if (e.key === "Escape") { filterIn.value = ""; at.filter = ""; applyObjFilter(at); } if (e.key === "Enter" && at.conn.kind === "redis") redisSearch(at, filterIn.value.trim()); });
    if (at.schema) applyObjFilter(at); else loadSchema(at);
  };
  const connMenu = (e, c) => D.showContextMenu(e.clientX, e.clientY, [
    { label: "Open", icon: "db", onClick: () => openInTab(c) },
    { label: "Open in new tab", icon: "plus", onClick: () => openInTab(c, true) },
    { label: "Test connection", icon: "check", onClick: async () => { toast("Testing…", "spinner", { sticky: true, spin: true }); const r = await atom().db.test(c.id).catch((x) => ({ ok: false, detail: x.message })); toast(r.ok ? `Connected ✓ (${r.ms} ms)` : `Failed${r.type ? ` (${r.type})` : ""}: ${r.detail || ""}`, r.ok ? "checkCircle" : "alert", { ms: 5000 }); } },
    { sep: true },
    { label: "Edit…", icon: "pencil", onClick: () => drawConnForm(c) },
    { label: "Duplicate…", icon: "copy", onClick: () => drawConnForm(null, { ...structuredClone(c), id: undefined, rev: undefined, hasPassword: false, hasUri: false, name: (c.name || kindOf(c.kind).name) + " (copy)" }) },
    connStatus.get(c.id) === "live" ? { label: "Disconnect", icon: "wifiOff", onClick: () => disconnectConn(c) } : { label: "Connect", icon: "wifi", onClick: () => openInTab(c) },
    { sep: true },
    { label: "Delete connection…", icon: "trash", danger: true, onClick: async () => {
      const choice = await D.chooseDialog({ title: "Delete connection", ic: "alert", message: `Delete “${c.name || kindOf(c.kind).name}”? Its saved credential is removed. Choose what happens to the query history kept on this computer.`, choices: [{ label: "Delete + clear history", value: "all", primary: true }, { label: "Delete, keep history", value: "keep" }, { label: "Cancel", value: null }] });
      if (!choice) return;
      try { await atom().db.remove(c.id); } catch (e2) { toast("Delete failed: " + errMsg(e2), "alert", { ms: 7000 }); return; }
      if (choice === "all") hClear(c.id);
      try { conns = await atom().db.list(); } catch (e2) { connsError = errMsg(e2); }
      for (const t of tabsOf(c.id)) { await disposeTab(t); t.conn = null; t.connLive = false; t.schema = null; t.cur = null; }
      renderSide(); switchTab(activeTabId);
    } },
  ]);
  const applyObjFilter = (tab) => {
    const ui = tab._objUI; if (!ui || !tab.schema) return;
    const all = tab.schema.items || [];
    const q = (tab.filter || "").trim().toLowerCase();
    const tf = tab.typeFilter || "all";
    let vis = all;
    if (tf !== "all") vis = vis.filter((it) => (tf === "views" ? it.type === "view" : it.type !== "view"));
    if (q) vis = vis.filter((it) => objName(it).toLowerCase().includes(q) || (it.keyType || "").toLowerCase() === q);
    if (tab.sortBy === "rows") vis = [...vis].sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1) || objName(a).localeCompare(objName(b)));
    ui.list.setItems(vis);
    const tc = tab.schema.tableCount ?? 0, vc = tab.schema.viewCount ?? 0;
    ui.countEl.textContent = (vis.length !== all.length ? `${fmtInt(vis.length)} / ` : "") + fmtInt(all.length);
    ui.countEl.title = `${fmtInt(tc)} ${objNoun(tab.conn.kind).toLowerCase()}${vc ? ` · ${fmtInt(vc)} views` : ""}`;
    ui.chips.innerHTML = "";
    if (vc && tc) for (const [id, label, n] of [["all", "All", all.length], ["tables", objNoun(tab.conn.kind), tc], ["views", "Views", vc]]) ui.chips.append(h("button", { class: "dbm-type-chip" + (tf === id ? " on" : ""), text: `${label} ${fmtNum(n)}`, "aria-pressed": tf === id ? "true" : "false", onclick: () => { tab.typeFilter = id; applyObjFilter(tab); } }));
    if (tab.schema.info) ui.chips.append(h("span", { class: "dbm-info-line", text: tab.schema.info }));
    if (tab.conn.kind === "redis" && tab.schema.cursor && tab.schema.cursor !== "0") ui.chips.append(h("button", { class: "btn btn-ghost btn-sm", text: "Load more keys", onclick: () => redisMore(tab) }), q ? h("button", { class: "btn btn-ghost btn-sm", text: `Search server for “${q}”`, onclick: () => redisSearch(tab, q) }) : null);
  };
  // Redis: continue the SCAN cursor (deduplicated) or search server-side with MATCH.
  const redisMore = async (tab) => { try { const r = await atom().db.schemaMore(tab.conn.id, { cursor: tab.schema.cursor }); const seen = new Set(tab.schema.items.map((x) => x.name)); tab.schema.items.push(...r.items.filter((x) => !seen.has(x.name))); tab.schema.cursor = r.cursor; tab.schema.info = `${fmtInt(tab.schema.keyCount)} keys in this database${r.complete ? "" : ` — ${fmtInt(tab.schema.items.length)} loaded so far`}`; applyObjFilter(tab); } catch (e) { toast("Couldn't load more keys: " + errMsg(e), "alert"); } };
  const redisSearch = async (tab, q) => { if (!q || !tab.schema) return; try { const r = await atom().db.schemaMore(tab.conn.id, { cursor: "0", match: `*${q}*`, want: 2000 }); const seen = new Set(tab.schema.items.map((x) => x.name)); tab.schema.items.push(...r.items.filter((x) => !seen.has(x.name))); tab.schema.info = `${r.items.length} key(s) match “${q}” on the server${r.complete ? "" : " (partial scan)"}`; applyObjFilter(tab); } catch (e) { toast("Search failed: " + errMsg(e), "alert"); } };
  const objRow = (tab, it) => {
    const isView = it.type === "view", isKey = it.type === "key";
    const sel = sameObj(tab.cur, it);
    const schemaPart = SCHEMA_KINDS.has(tab.conn.kind) && it.schema && objName(it).includes(".") ? it.schema + "." : "";
    const row = h("div", { class: "dbm-table" + (sel ? " sel" : "") + (isView ? " dbm-view" : ""), role: "option", "aria-selected": sel ? "true" : "false", title: `${isKey ? (it.keyType || "key") : isView ? "View" : objNoun(tab.conn.kind, false)} — ${objName(it)}${it.rows != null ? ` · ~${fmtInt(it.rows)} rows (estimate)` : ""}${it.bytes ? ` · ${fmtBytes(it.bytes)}` : ""}${it.comment ? "\n" + it.comment : ""}\nClick: browse · Double-click: query · Right-click: more` },
      h("span", { class: "dbm-obj-ic", html: icon(isKey ? "key" : isView ? "eye" : "list", 12) }),
      h("span", { class: "dbm-obj-name" }, schemaPart ? h("span", { class: "dbm-obj-schema", text: schemaPart }) : null, h("span", { text: schemaPart ? it.table : objName(it) })),
      isKey ? h("span", { class: "dbm-obj-rows", text: it.keyType || "" }) : (it.rows != null ? h("span", { class: "dbm-obj-rows", title: "estimated rows", text: "~" + fmtNum(it.rows) }) : null));
    row.onclick = () => { selectObject(tab, it); openBrowse(tab); };
    row.ondblclick = () => { selectObject(tab, it); queryTemplate(tab, it, true); };
    row.oncontextmenu = (e) => { e.preventDefault(); selectObject(tab, it); objMenu(tab, it, e); };
    return row;
  };
  const objKeys = (tab, e) => {
    const ui = tab._objUI; if (!ui) return;
    const items = ui.list.items; if (!items.length) return;
    let i = tab.cur ? items.findIndex((x) => sameObj(x, tab.cur)) : -1;
    if (e.key === "ArrowDown") { i = Math.min(items.length - 1, i + 1); } else if (e.key === "ArrowUp") { i = Math.max(0, i - 1); }
    else if (e.key === "Enter" && i >= 0) { openBrowse(tab); return; }
    else if (e.key === "PageDown") i = Math.min(items.length - 1, i + 15); else if (e.key === "PageUp") i = Math.max(0, i - 15);
    else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { if (i >= 0) { e.preventDefault(); const r = ui.list.el.getBoundingClientRect(); objMenu(tab, items[i], { clientX: r.left + 40, clientY: r.top + 40 }); } return; }
    else return;
    e.preventDefault();
    selectObject(tab, items[i]); ui.list.scrollToIndex(i);
    if (tab.mode === "browse") openBrowse(tab); else if (tab.mode === "struct") openStruct(tab);
  };
  const selectObject = (tab, it) => { if (!sameObj(tab.cur, it)) tab.browse = { offset: 0, limit: tab.browse.limit || 200, orderBy: "", dir: "asc", where: "", search: "", total: null }; tab.cur = it; if (tab._objUI) tab._objUI.list.refresh(); renderTabBar(); if (tab.wsEl) { const b = tab.wsEl.querySelector(".dbm-cur-badge"); if (b) { b.textContent = objName(it); b.style.display = ""; } } };
  const queryTemplate = (tab, it, run) => {
    buildWorkspace(tab);
    const q = defaultQ(tab.conn, it);
    if (tab._ed) { tab._ed.value = q; tab._draft = q; }
    openQuery(tab);
    if (run) runQuery(tab);
  };
  const objMenu = (tab, it, e) => {
    const isKey = it.type === "key", kind = tab.conn.kind;
    const items = [];
    if (!isKey) items.push({ label: "Browse data", icon: "list", onClick: () => openBrowse(tab) }, { label: "Structure", icon: "cpu", onClick: () => openStruct(tab) });
    items.push({ label: "Query", icon: "search", onClick: () => queryTemplate(tab, it, true) });
    if (!isKey) items.push({ label: "Count rows (exact)", icon: "history", onClick: () => countExact(tab, it) });
    items.push({ sep: true }, { label: "Copy name", icon: "copy", onClick: () => copyText(objName(it), "Name copied") });
    if (!isKey && kind !== "redis") {
      items.push({ label: "Copy SELECT", icon: "copy", onClick: () => copyText(defaultQ(tab.conn, it), "SELECT copied") });
      items.push({ label: "Copy INSERT template", icon: "copy", onClick: async () => { const cols = await getColumns(tab, it).catch(() => []); copyText(insertTemplate(tab.conn, it, cols), "INSERT template copied"); } });
      if (kind !== "mongodb" && it.type !== "view") {
        items.push({ sep: true },
          { label: "Empty table…", icon: "alert", danger: true, onClick: async () => { if (await confirm("Empty table", `Delete ALL rows from “${objName(it)}”? This cannot be undone.`, "Delete all rows")) await runDDL(tab, kind === "sqlite" ? `DELETE FROM ${qName(kind, it)}` : `TRUNCATE TABLE ${qName(kind, it)}`, "Emptied"); } },
          { label: `Drop ${objNoun(kind, false)}…`, icon: "trash", danger: true, onClick: async () => { if (await confirm("Drop table", `Drop “${objName(it)}” and all its data? This cannot be undone.`, "Drop")) await runDDL(tab, `DROP TABLE ${qName(kind, it)}`, "Dropped"); } });
      }
      if (kind === "mongodb") items.push({ sep: true }, { label: "Drop collection…", icon: "trash", danger: true, onClick: async () => { if (await confirm("Drop collection", `Drop “${objName(it)}” and all its documents?`, "Drop")) await runDDL(tab, JSON.stringify({ collection: it.table, op: "drop" }), "Dropped"); } });
    }
    // Redis keys travel as STRUCTURED arguments — the exact bytes, never re-parsed from text.
    if (isKey) items.push({ sep: true }, { label: "DEL key…", icon: "trash", danger: true, onClick: async () => { if (await confirm("Delete key", `DEL “${objName(it)}”? Exactly this one key is deleted.`, "Delete")) await runDDL(tab, `DEL ${redisQuote(objName(it))}`, "Deleted", { argv: ["DEL", objName(it)] }); } });
    D.showContextMenu(e.clientX, e.clientY, items);
  };
  const runDDL = async (tab, sql, okMsg, extra = {}) => {
    try { const r = await atom().db.query(tab.conn.id, sql, { expectRev: tab.conn.rev, ...extra }); toast(okMsg + (r.message ? " · " + r.message : ""), "check"); logPush(tab, { kind: "ddl", text: sql, ms: r.ms, affected: r.affected, ok: true }); tab.struct.clear(); await loadSchema(tab); }
    catch (e) { toast("Failed: " + errMsg(e), "alert", { ms: 6000 }); logPush(tab, { kind: "ddl", text: sql, ok: false, error: errMsg(e), state: e.type === "outcome-unknown" ? "unknown" : "" }); noteFailure(tab, e); }
  };
  const countExact = async (tab, it) => {
    toast(`Counting ${objName(it)}…`, "spinner", { sticky: true, spin: true });
    try { const r = await atom().db.count(tab.conn.id, objRef(it)); toast(`${objName(it)}: ${fmtInt(r.count)} rows (${r.ms} ms)`, "checkCircle", { ms: 5000 }); logPush(tab, { kind: "count", text: `count ${objName(it)}`, ms: r.ms, rows: r.count, ok: true }); it.rows = r.count; it.rowsEstimated = false; if (tab._objUI) tab._objUI.list.refresh(); }
    catch (e) { toast("Count failed: " + errMsg(e), "alert", { ms: 6000 }); logPush(tab, { kind: "count", text: `count ${objName(it)}`, ok: false, error: errMsg(e) }); }
  };
  const loadSchema = async (tab) => {
    if (!tab || !tab.conn) return;
    if (tab._schemaLoading) return tab._schemaLoading;   // coalesce parallel requests
    const ui = tab._objUI;
    if (ui) { ui.list.setItems([]); ui.countEl.textContent = "…"; ui.chips.innerHTML = ""; ui.chips.append(h("span", { class: "dbm-info-line", text: "Loading…" })); }
    const t0 = Date.now(); const conn = tab.conn;
    tab._schemaLoading = (async () => {
      try {
        const s = await atom().db.schema(conn.id);
        if (tab.conn !== conn) return;                    // the tab moved to another connection meanwhile
        if (!Array.isArray(s.items)) s.items = (s.tables || []).map((n, i) => ({ name: n, table: n, type: s.viewCount && i >= (s.tableCount ?? 0) ? "view" : "table" }));
        tab.schema = s; markLive(tab);
        if (tab.cur && !s.items.find((x) => sameObj(x, tab.cur))) tab.cur = null;
        if (tab === AT()) applyObjFilter(tab);
        if (s.items.length > 2000) toast(`${fmtInt(s.items.length)} objects listed in ${Date.now() - t0} ms`, "check", { ms: 2500 });
      } catch (e2) {
        if (tab.conn !== conn) return;
        noteFailure(tab, e2);
        logPush(tab, { kind: "conn", text: "load schema", ok: false, error: errMsg(e2) });
        if (ui) {
          ui.chips.innerHTML = "";
          ui.chips.append(errBanner(e2, conn.kind, { onInstalled: () => loadSchema(tab), extra: [
            h("button", { class: "btn btn-ghost btn-sm", html: icon("refresh", 12) + "<span>Retry</span>", onclick: () => loadSchema(tab) }),
            h("button", { class: "btn btn-ghost btn-sm", html: icon("pencil", 12) + "<span>Edit connection</span>", onclick: () => drawConnForm(conn) }),
          ] }));
          ui.countEl.textContent = "!";
        }
      } finally { tab._schemaLoading = null; }
    })();
    return tab._schemaLoading;
  };
  const getColumns = async (tab, it) => {
    const key = objName(it);
    if (tab.struct.has(key) && tab.struct.get(key).columns) return tab.struct.get(key).columns;
    const cols = await atom().db.columns(tab.conn.id, objRef(it));
    tab.struct.set(key, { ...(tab.struct.get(key) || {}), columns: cols });
    return cols;
  };
  /* ============================================================
     CONNECTION FORM — edits a DEEP COPY; Cancel changes nothing
     ============================================================ */
  const drawConnForm = (existing, defaults = {}) => {
    const src = existing ? structuredClone(existing) : structuredClone(defaults);
    const c = Object.assign({ kind: "mysql", name: "", host: "localhost", port: "", user: "", database: "", file: "", ssl: false, sslMode: "verify", sslCa: "", createIfMissing: false, readOnly: false }, src);
    c.policy = structuredClone(c.policy || {});
    // secret fields: undefined = keep what's stored; "" = clear; string = replace
    const secret = { password: undefined, uri: undefined };
    hideAllWs();
    const fields = h("div", { class: "dbm-form-fields" });
    const inp = (key, label, type = "text", ph = "") => {
      const i = h("input", { class: "input", type, value: c[key] !== undefined && c[key] !== null ? String(c[key]) : "", placeholder: ph, autocomplete: "off", spellcheck: "false", "aria-label": label });
      i.oninput = () => { c[key] = i.value; }; return h("label", { class: "dbm-field" }, h("span", { text: label }), i);
    };
    const secretField = (key, label, ph) => {
      const has = key === "password" ? !!c.hasPassword : !!c.hasUri;
      const locked = !!(c.secretLocked && c.secretLocked[key]);
      const i = h("input", { class: "input", type: key === "password" ? "password" : "text", value: "", placeholder: has ? (locked ? "saved value can't be decrypted here — enter it again" : "•••••• (saved — leave empty to keep)") : ph, autocomplete: "off", spellcheck: "false", "aria-label": label });
      i.oninput = () => { secret[key] = i.value; };
      const acts = h("span", { class: "dbm-secret-acts" });
      if (has && !locked && c.id) acts.append(h("button", { class: "dbm-mini dbm-eye", html: icon("eye", 13), title: "Reveal the saved value (explicit request)", "aria-label": "Reveal saved value", onclick: async (e) => { e.preventDefault(); try { const r = await atom().db.revealSecret(c.id, key); i.value = r.value; i.type = "text"; secret[key] = r.value; } catch (err) { toast(errMsg(err), "alert"); } } }));
      if (key === "password") acts.append(h("button", { class: "dbm-mini dbm-eye", html: icon("eye", 13), title: "Show / hide", "aria-label": "Show or hide", onclick: (e) => { e.preventDefault(); i.type = i.type === "password" ? "text" : "password"; } }));
      if (has) acts.append(h("button", { class: "dbm-mini", html: icon("x", 12), title: `Clear the saved ${key}`, "aria-label": `Clear saved ${key}`, onclick: (e) => { e.preventDefault(); secret[key] = ""; i.value = ""; i.placeholder = "(will be cleared)"; } }));
      const l = h("label", { class: "dbm-field dbm-pw-field" }, h("span", { text: label }), i, acts);
      if (locked) l.append(h("span", { class: "dbm-err-hint", text: "The stored value was encrypted by another OS account or machine and stays intact until you replace it." }));
      return l;
    };
    const kindSel = h("select", { class: "input", "aria-label": "Engine" });
    for (const k of kinds) kindSel.append(h("option", { value: k.id, text: k.name + (k.installed ? "" : " (driver not installed)") }));
    kindSel.value = c.kind; kindSel.onchange = () => { c.kind = kindSel.value; c.port = ""; drawF(); drawPolicy(); };
    function drawF() {
      const k = kindOf(c.kind); fields.innerHTML = "";
      if (!c.port) c.port = k.port || "";
      fields.append(inp("name", "Name", "text", k.name + " connection"));
      let pendH = false;
      for (const f of k.fields) {
        if (f === "host") { pendH = true; continue; }
        if (f === "port") {
          const hIn = h("input", { class: "input", type: "text", value: c.host || "localhost", autocomplete: "off", "aria-label": "Host" }); hIn.oninput = () => { c.host = hIn.value; };
          const pIn = h("input", { class: "input dbm-port-in", type: "number", value: c.port || k.port || "", placeholder: String(k.port || ""), "aria-label": "Port" }); pIn.oninput = () => { c.port = pIn.value; };
          if (pendH) fields.append(h("div", { class: "dbm-host-port" }, h("label", { class: "dbm-field dbm-host-f" }, h("span", { text: "Host" }), hIn), h("label", { class: "dbm-field dbm-port-f" }, h("span", { text: "Port" }), pIn)));
          else fields.append(h("label", { class: "dbm-field" }, h("span", { text: "Port" }), pIn));
          pendH = false; continue;
        }
        if (f === "user") { fields.append(inp("user", "User")); continue; }
        if (f === "password") { fields.append(secretField("password", "Password", "")); continue; }
        if (f === "database") { fields.append(inp("database", k.dbLabel || "Database")); continue; }
        if (f === "uri") { fields.append(secretField("uri", "Connection URI", k.uriPlaceholder)); continue; }
        if (f === "file") {
          fields.append(inp("file", "Database file path", "text", "C:\\data\\app.db"));
          const cb = h("input", { type: "checkbox" }); cb.checked = !!c.createIfMissing; cb.onchange = () => { c.createIfMissing = cb.checked; };
          const ro = h("input", { type: "checkbox" }); ro.checked = !!c.readOnly; ro.onchange = () => { c.readOnly = ro.checked; };
          fields.append(h("label", { class: "dbm-field dbm-ssl-row" }, cb, h("span", { text: "Create the file if it doesn't exist (otherwise opening a missing file is an error)" })), h("label", { class: "dbm-field dbm-ssl-row" }, ro, h("span", { text: "Open read-only" })));
          continue;
        }
      }
      if (k.tls) {
        const cb = h("input", { type: "checkbox" }); cb.checked = !!c.ssl;
        const mode = h("select", { class: "input", "aria-label": "Certificate verification" }, h("option", { value: "verify", text: "Verify the server certificate and host name (recommended)" }), h("option", { value: "insecure", text: "Encrypt only — trust ANY certificate (insecure: no server authentication)" }));
        mode.value = c.sslMode === "insecure" ? "insecure" : "verify"; mode.onchange = () => { c.sslMode = mode.value; syncTls(); };
        const ca = h("input", { class: "input", type: "text", value: c.sslCa || "", placeholder: "optional: path to a CA certificate (PEM)", "aria-label": "CA certificate file" }); ca.oninput = () => { c.sslCa = ca.value; };
        const sn = h("input", { class: "input", type: "text", value: c.sslServerName || "", placeholder: "optional: expected server name (SNI)", "aria-label": "Server name" }); sn.oninput = () => { c.sslServerName = sn.value; };
        const tlsBox = h("div", { class: "dbm-tls-box" }, h("label", { class: "dbm-field" }, h("span", { text: "Certificate check" }), mode), h("label", { class: "dbm-field" }, h("span", { text: "CA certificate" }), ca), c.kind === "mssql" ? null : h("label", { class: "dbm-field" }, h("span", { text: "Server name" }), sn), h("div", { class: "dbm-form-hint dbm-tls-warn", text: "" }));
        const syncTls = () => { tlsBox.style.display = c.ssl ? "" : "none"; const w = tlsBox.querySelector(".dbm-tls-warn"); w.textContent = c.sslMode === "insecure" ? "⚠ Insecure: the connection is encrypted but the server is NOT authenticated — a man-in-the-middle can read it." : "The server certificate must be valid for the host name (or signed by the CA file)."; w.classList.toggle("dbm-bad", c.sslMode === "insecure"); };
        cb.onchange = () => { c.ssl = cb.checked; syncTls(); };
        fields.append(h("label", { class: "dbm-field dbm-ssl-row" }, cb, h("span", { text: c.kind === "mssql" ? "Encrypt (TLS)" : "Use SSL / TLS" })), tlsBox);
        syncTls();
      }
    }
    drawF();
    const policyBody = h("div", { class: "dbm-policy-body" });
    const mkPCb = (key, label) => { const cb = h("input", { type: "checkbox" }); cb.checked = !!c.policy[key]; cb.onchange = () => { c.policy[key] = cb.checked; }; return h("label", { class: "dbm-policy-row" }, cb, h("span", { text: label })); };
    function drawPolicy() {
      const allowed = new Set(kindOf(c.kind).policies || []);
      policyBody.innerHTML = "";
      const isRedis = c.kind === "redis", isMongo = c.kind === "mongodb";
      if (allowed.has("blockDrop")) policyBody.append(mkPCb("blockDrop", isRedis ? "Block DEL / UNLINK / FLUSH*" : isMongo ? "Block drop (collections, indexes, databases)" : "Block DROP statements"));
      if (allowed.has("blockTruncate")) policyBody.append(mkPCb("blockTruncate", isRedis ? "Block FLUSHDB / FLUSHALL" : isMongo ? "Block emptying collections (drop / deleteMany)" : "Block TRUNCATE"));
      if (allowed.has("blockWrite")) policyBody.append(mkPCb("blockWrite", isRedis ? "Block every write and admin command (read-only)" : isMongo ? "Block writes — insert / update / delete / $out / $merge (also disables inline editing)" : "Block writes — INSERT / UPDATE / DELETE / MERGE, writable CTEs, procedures (also disables inline editing)"));
      if (allowed.has("blockDDL")) policyBody.append(mkPCb("blockDDL", isRedis ? "Block admin commands (CONFIG, SCRIPT, …)" : isMongo ? "Block schema/index changes and admin commands" : "Block all DDL and procedure calls"));
      if (allowed.has("protectedTables")) {
        const ptIn = h("input", { class: "input dbm-policy-tables", type: "text", value: (c.policy.protectedTables || []).join(", "), placeholder: isRedis ? "exact key names, e.g. config:main, session:*" : "users, payments, sales.orders", "aria-label": "Protected objects" });
        ptIn.oninput = () => { c.policy.protectedTables = ptIn.value.split(",").map((s) => s.trim()).filter(Boolean); };
        policyBody.append(h("label", { class: "dbm-field", style: "margin-top:6px" }, h("span", { text: isRedis ? "Protected keys (read-only):" : `Protected ${isMongo ? "collections" : "tables"} (read-only, schema-qualified names allowed):` }), ptIn));
      }
      policyBody.append(h("div", { class: "dbm-form-hint", text: "These are application-side protections enforced by AtomNano on every statement it sends, including CTE bodies, procedure calls and imports. They are not a substitute for database permissions." }));
    }
    drawPolicy();
    const policyEl = h("details", { class: "dbm-policy-section" }, h("summary", { class: "dbm-policy-summary" }, h("span", { html: icon("shield", 13) }), h("span", { text: "Security policies" })), policyBody);
    if (Object.values(c.policy).some((v) => (Array.isArray(v) ? v.length : v))) policyEl.open = true;
    const status = h("div", { class: "dbm-form-status", role: "status" });
    const installBtnFn = (kind, pkg) => h("button", { class: "btn btn-primary btn-sm", style: "margin-left:8px", text: `Install ${pkg}`, onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = "Installing…";
      const r = await atom().db.installDriver(kind).catch((x) => ({ ok: false, detail: x.message }));
      toast(r.ok ? "Driver installed and loaded ✓ — test again" : `Install ${r.state || "failed"}: ${r.detail || ""}`, r.ok ? "check" : "alert", { ms: 7000 });
      b.disabled = false; b.textContent = `Install ${pkg}`; kinds = await atom().db.kinds().catch(() => kinds);
    } });
    const payload = () => { const out = { ...c }; for (const k of ["hasPassword", "hasUri", "secretLocked", "legacyPlaintext", "sessionSecret"]) delete out[k]; for (const f of ["password", "uri"]) { if (secret[f] === undefined) { if (c.id) out[f] = { $keep: true }; else delete out[f]; } else out[f] = secret[f]; } if (out.policy && !Object.values(out.policy).some((v) => (Array.isArray(v) ? v.length : v))) out.policy = {}; return out; };
    let saving = false;
    const secretUnavailable = async (err, saved) => {
      // OS secure storage is unavailable: offer a session-only credential (memory) instead of plaintext
      const choice = await D.chooseDialog({ title: "Secure storage unavailable", ic: "alert", message: `${err.message}\n\nThe connection can be saved WITHOUT the secret and use it for this app session only (you will enter it again after a restart).`, choices: [{ label: "Save without secret, use it this session", value: "session", primary: true }, { label: "Cancel", value: null }] });
      if (choice !== "session") return null;
      const p = payload(); const fields = {}; for (const f of ["password", "uri"]) { if (typeof secret[f] === "string" && secret[f]) { fields[f] = secret[f]; p[f] = ""; } }
      const s2 = await atom().db.save(p);
      await atom().db.setSessionSecret(s2.id, fields);
      return s2;
    };
    const formEl = h("div", { class: "dbm-form-ws", role: "form", "aria-label": existing && existing.id ? "Edit connection" : "New connection" },
      h("div", { class: "dbm-form" },
        h("div", { class: "dbm-form-title", text: existing && existing.id ? "Edit connection" : "New connection" }),
        h("label", { class: "dbm-field" }, h("span", { text: "Engine" }), kindSel),
        fields, policyEl, status,
        h("div", { class: "dbm-form-hint", text: kinds.length && kinds[0].secureStorage === false ? "⚠ OS credential encryption is unavailable on this system — secrets cannot be saved to disk (a session-only credential is offered instead)." : "Passwords and URIs are encrypted at rest with the OS credential store and never sent to the UI unless you reveal them." }),
        h("div", { class: "dbm-form-actions" },
          h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => { formEl.remove(); switchTab(activeTabId); } }),
          h("button", { class: "btn btn-ghost", text: "Test connection", onclick: async (e) => {
            const b = e.currentTarget; b.disabled = true; status.innerHTML = ""; status.append(h("span", { class: "dbm-dim", text: "Connecting…" }));
            const r = await atom().db.test({ ...payload(), id: c.id || "" }).catch((x) => ({ ok: false, detail: x.message, type: x.type }));
            status.innerHTML = "";
            if (r.ok) status.append(h("span", { class: "dbm-ok", text: `Connected ✓  (${r.ms} ms)` }));
            else { status.append(h("span", { class: "dbm-bad", text: `${r.type ? `[${r.type}] ` : ""}${r.detail || "Failed"}` })); if (r.hint) status.append(h("div", { class: "dbm-err-hint", text: r.hint })); if (r.driverMissing) status.append(installBtnFn(c.kind, r.driverMissing)); }
            b.disabled = false;
          } }),
          h("button", { class: "btn btn-primary", text: existing && existing.id ? "Save" : "Save & connect", onclick: async (e) => {
            if (saving) return; saving = true; const b = e.currentTarget; b.disabled = true;
            try {
              if (!c.name) c.name = (kindOf(c.kind).name || "DB") + (c.database ? " · " + c.database : c.file ? " · " + c.file.split(/[\\/]/).pop() : "");
              let saved;
              try { saved = await atom().db.save(payload()); }
              catch (x) { if (x.type === "secret-unavailable") saved = await secretUnavailable(x); else throw x; }
              if (!saved) return;
              conns = await atom().db.list().catch(() => conns);
              toast("Connection saved ✓", "check");
              formEl.remove();
              // tabs on this connection: new revision → sessions/pending plans of the OLD configuration are dropped explicitly
              for (const t of tabsOf(saved.id)) { const hadPending = [...t.pendingByTable.values()].some((p) => pendingCount(p) > 0); await disposeTab(t); t.conn = conns.find((x) => x.id === saved.id) || saved; t.schema = null; t.struct.clear(); t.pendingByTable.clear(); if (hadPending) toast("Pending schema changes were discarded because the connection changed.", "alert", { ms: 5000 }); }
              desired.set(saved.id, "on"); bumpGen(saved.id); connStatus.delete(saved.id);
              openInTab(conns.find((x) => x.id === saved.id) || saved);
            } catch (x) { toast(`Save failed${x.type ? ` (${x.type})` : ""}: ${errMsg(x)}`, "alert", { ms: 8000 }); status.innerHTML = ""; status.append(h("span", { class: "dbm-bad", text: errMsg(x) }), x.hint ? h("div", { class: "dbm-err-hint", text: x.hint }) : null); }
            finally { saving = false; b.disabled = false; }
          } }))));
    wsHost.append(formEl);
    const first = formEl.querySelector("input"); if (first) setTimeout(() => first.focus(), 30);
  };

  /* ============================================================
     WORKSPACE (per tab): toolbar + Query / Browse / Structure panels
     ============================================================ */
  const syncSessionBadge = (tab) => { const b = tab.wsEl && tab.wsEl.querySelector(".dbm-tx-badge"); if (!b) return; b.textContent = tab.sessionTx ? "TRANSACTION OPEN" : (tab.autocommit === false ? "autocommit off" : ""); b.style.display = tab.sessionTx || tab.autocommit === false ? "" : "none"; b.title = tab.sessionTx ? "This tab holds an uncommitted transaction — COMMIT or ROLLBACK it; closing the tab rolls it back." : "Statements in this tab are not committed until you run COMMIT"; };
  const buildWorkspace = (tab) => {
    if (tab.wsEl) { hideAllWs(); tab.wsEl.style.display = ""; return; }
    const ws = h("div", { class: "dbm-workspace", role: "tabpanel" });
    tab.wsEl = ws;
    const dot = h("span", { class: "dbm-dot" }); setDot(dot, tab.connLive);
    const tbQ = h("button", { class: "dbm-tab", text: "Query", role: "tab", onclick: () => openQuery(tab) });
    const tbB = h("button", { class: "dbm-tab", text: "Browse", role: "tab", onclick: () => openBrowse(tab) });
    const tbS = h("button", { class: "dbm-tab", text: "Structure", role: "tab", onclick: () => openStruct(tab) });
    if (tab.conn.kind === "redis") { tbB.disabled = true; tbS.disabled = true; tbB.title = tbS.title = "Not available for Redis"; }
    const curBadge = h("span", { class: "dbm-cur-badge", text: tab.cur ? objName(tab.cur) : "", style: tab.cur ? "" : "display:none", title: "Current object" });
    const txBadge = h("span", { class: "dbm-tx-badge", style: "display:none" });
    ws.append(h("div", { class: "dbm-toolbar" }, chip(tab.conn.kind), h("span", { class: "dbm-tb-name", text: tab.conn.name || kindOf(tab.conn.kind).name }), dot,
      h("div", { class: "dbm-tabs", role: "tablist" }, tbQ, tbB, tbS), curBadge, txBadge, h("div", { class: "spacer" }),
      h("button", { class: "btn btn-ghost btn-sm", html: icon("refresh", 12), title: "Refresh schema (F5)", "aria-label": "Refresh schema", onclick: () => { tab.struct.clear(); loadSchema(tab); } }),
      h("button", { class: "btn btn-ghost btn-sm", html: icon("x", 13), title: "Disconnect", "aria-label": "Disconnect", onclick: () => disconnectConn(tab.conn) }),
      h("button", { class: "btn btn-ghost btn-sm", html: icon("pencil", 12), title: "Edit connection", "aria-label": "Edit connection", onclick: () => drawConnForm(tab.conn) })));
    tab._tbQ = tbQ; tab._tbB = tbB; tab._tbS = tbS;
    ws.append(buildQueryPanel(tab), h("div", { class: "dbm-browse-panel", style: "display:none" }), h("div", { class: "dbm-struct dbm-struct-panel", style: "display:none" }), buildLogPanel(tab));
    hideAllWs();
    wsHost.append(ws);
    setMode(tab, tab.mode || "query");
  };
  const setMode = (tab, mode) => {
    tab.mode = mode;
    if (!tab.wsEl) return;
    for (const [m, sel, btn] of [["query", ".dbm-query-panel", tab._tbQ], ["browse", ".dbm-browse-panel", tab._tbB], ["struct", ".dbm-struct-panel", tab._tbS]]) {
      tab.wsEl.querySelector(sel).style.display = m === mode ? "" : "none";
      if (btn) { btn.classList.toggle("active", m === mode); btn.setAttribute("aria-selected", m === mode ? "true" : "false"); }
    }
    if (tab._objUI) tab._objUI.list.refresh();
  };
  const openQuery = (tab) => { if (!tab.wsEl) buildWorkspace(tab); setMode(tab, "query"); if (tab._ed) tab._ed.focus(); };
  const openBrowse = (tab) => { if (tab.conn.kind === "redis") { queryTemplate(tab, tab.cur, true); return; } if (!tab.wsEl) buildWorkspace(tab); setMode(tab, "browse"); renderBrowse(tab); };
  const openStruct = (tab) => { if (tab.conn.kind === "redis") return; if (!tab.wsEl) buildWorkspace(tab); setMode(tab, "struct"); renderStruct(tab); };

  /* ------------------------------ QUERY ------------------------------ */
  // A tab's backend session (pinned client). Opened lazily, re-opened after it is gone.
  const ensureSession = async (tab) => {
    if (tab.session) return tab.session;
    const r = await atom().db.sessionOpen(tab.conn.id);
    tab.session = r.session; tab.sessionTx = false;
    if (tab.autocommit === false) await atom().db.sessionSet(tab.session, { autocommit: false }).catch(() => {});
    return tab.session;
  };
  const buildQueryPanel = (tab) => {
    const limitIn = h("input", { class: "input dbm-limit", type: "number", value: tab._limit || 200, min: 1, max: 100000, title: "Preview rows per statement — more rows are reported as available (hasMore), never hidden", "aria-label": "Preview row limit" });
    limitIn.onchange = () => { tab._limit = Math.max(1, Math.min(100000, +limitIn.value || 200)); limitIn.value = tab._limit; setPref("limit", tab._limit); };
    const runBtn = h("button", { class: "btn btn-primary btn-sm dbm-run-btn", html: icon("send", 13) + "<span>Run</span>", title: "Run (Ctrl+Enter) — runs the selection if any", onclick: () => runQuery(tab) });
    const stopBtn = h("button", { class: "btn btn-ghost btn-sm dbm-stop-btn", html: icon("stop", 12) + "<span>Stop</span>", title: "Cancel the running statement (where the engine supports it)", style: "display:none", onclick: () => stopRun(tab) });
    const explainBtn = h("button", { class: "btn btn-ghost btn-sm", html: icon("eye", 12) + "<span>Explain</span>", title: "Show the execution plan", onclick: () => runQuery(tab, { explain: true }) });
    if (tab.conn.kind === "mssql" || tab.conn.kind === "mongodb" || tab.conn.kind === "redis") { explainBtn.disabled = true; explainBtn.title = "Execution plans are not available for this engine here"; }
    const fmtBtn = h("button", { class: "btn btn-ghost btn-sm", html: icon("list", 12) + "<span>Format</span>", title: "Format SQL (keywords and line breaks only — literals and comments are never changed)", onclick: async () => {
      if (!tab._ed || ["mongodb", "redis"].includes(tab.conn.kind)) return;
      try { const r = await atom().db.formatSql(tab.conn.id, tab._ed.value); if (!r.ok) { toast("Not formatted: " + (r.error || "parse error") + " — the text was left as is.", "alert", { ms: 5000 }); return; } const ed = tab._ed; ed.focus(); ed.select(); if (!document.execCommand || !document.execCommand("insertText", false, r.text)) ed.value = r.text; tab._draft = ed.value; }
      catch (e) { toast("Format failed: " + errMsg(e), "alert"); }
    } });
    const acCb = h("input", { type: "checkbox" }); acCb.checked = tab.autocommit !== false;
    acCb.onchange = async () => { tab.autocommit = acCb.checked; if (tab.session) { try { await atom().db.sessionSet(tab.session, { autocommit: tab.autocommit }); } catch (e) { toast(errMsg(e), "alert"); } } syncSessionBadge(tab); };
    const acRow = tab.conn.kind === "oracle" ? h("label", { class: "dbm-check", title: "Oracle: commit each statement automatically. Off = statements stay uncommitted until COMMIT." }, acCb, h("span", { text: "Autocommit" })) : null;
    const histBtn = h("button", { class: "btn btn-ghost btn-sm", html: icon("history", 12) + "<span>History</span>", title: "Query history (kept on this computer)", onclick: (e) => {
      const hist = hLoad(tab.conn.id);
      const items = hist.slice(0, 25).map((q) => ({ label: q.replace(/\s+/g, " ").slice(0, 70) + (q.length > 70 ? "…" : ""), icon: "history", onClick: () => { tab._ed.value = q; tab._draft = q; tab._ed.focus(); } }));
      if (!items.length) items.push({ label: pref("hist-off", false) ? "History is disabled" : "No history yet", icon: "dot", onClick: () => {} });
      items.push({ sep: true }, { label: pref("hist-off", false) ? "Enable saving history" : "Stop saving history (session only)", icon: "shield", onClick: () => { setPref("hist-off", !pref("hist-off", false)); toast(pref("hist-off", false) ? "History is no longer saved" : "History is saved again", "check"); } });
      if (hist.length) items.push({ label: "Clear this connection's history", icon: "trash", danger: true, onClick: () => { hClear(tab.conn.id); toast("History cleared", "check"); } });
      items.push({ label: "Clear ALL saved query history", icon: "trash", danger: true, onClick: async () => { if (await confirm("Clear all history", "Remove every saved query for every connection on this computer?", "Clear all")) { hClearAll(); toast("All history cleared", "check"); } } });
      D.showContextMenu(e.clientX, e.clientY, items);
    } });
    const ed = h("textarea", { class: "dbm-editor", spellcheck: "false", placeholder: DB_PLACEHOLDER[tab.conn.kind] || DB_PLACEHOLDER.default, "aria-label": "Statement editor" });
    ed.value = tab._draft || "";
    ed.oninput = () => { tab._draft = ed.value; };
    ed.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runQuery(tab); }
      else if (e.key === "Tab") { e.preventDefault(); const s = ed.selectionStart; ed.value = ed.value.slice(0, s) + "  " + ed.value.slice(ed.selectionEnd); ed.selectionStart = ed.selectionEnd = s + 2; tab._draft = ed.value; }
      else if (e.key === "Escape") ed.blur();
    };
    tab._ed = ed; tab._runBtn = runBtn; tab._stopBtn = stopBtn;
    const results = h("div", { class: "dbm-results", "aria-live": "polite" }, h("div", { class: "dbm-empty", text: "Results appear here — one block per statement." }));
    const statusBar = h("div", { class: "dbm-statusbar", role: "status" });
    tab._res = results; tab._st = statusBar;
    return h("div", { class: "dbm-query-panel" },
      h("div", { class: "dbm-ed-bar" }, runBtn, stopBtn, explainBtn, fmtBtn, histBtn, h("span", { class: "dbm-dim", text: "Preview" }), limitIn, acRow, h("div", { class: "spacer" }), h("span", { class: "dbm-ed-hint", text: "Ctrl+Enter runs · selection runs only that text · one result block per statement" })),
      ed, results, statusBar);
  };
  const stopRun = async (tab) => { const r = tab.run; if (!r || !r.currentOp) return; const res = await atom().db.cancel(r.currentOp).catch((e) => ({ ok: false, reason: errMsg(e) })); toast(res.ok ? "Cancel requested" : `Cannot cancel: ${res.reason || "not supported by this engine"}`, res.ok ? "check" : "alert"); };
  /* Run the editor's statements. The RUN CONTEXT is captured here and used for every
   * statement; nothing is re-read from the tab afterwards. Each statement is a visible
   * row whose state advances; a failure stops the sequence but keeps earlier results. */
  const runQuery = async (tab, { explain } = {}) => {
    if (!tab || !tab.conn || tab.busy) return;
    if (!tab.wsEl) buildWorkspace(tab);
    const ed = tab._ed, res = tab._res, st = tab._st;
    const selText = ed.selectionStart !== ed.selectionEnd ? ed.value.slice(ed.selectionStart, ed.selectionEnd) : "";
    const text = (selText || ed.value).trim(); if (!text) return;
    const ctx = { id: uid("run"), conn: tab.conn, connId: tab.conn.id, rev: tab.conn.rev, kind: tab.conn.kind, limit: tab._limit || 200, explain: !!explain, detached: false, currentOp: null, cancelled: false };
    tab.busy = true; tab.run = ctx; tab._runBtn.disabled = true; tab._stopBtn.style.display = ""; renderTabBar();
    res.innerHTML = ""; st.textContent = "";
    const t0 = Date.now();
    let stmts;
    try {
      if (ctx.kind === "mongodb" || ctx.kind === "redis") stmts = [{ text, line: 1 }];
      else { const sp = await atom().db.splitScript(ctx.connId, text); if (sp.errors && sp.errors.length) { res.append(errBanner({ message: `Script not run: ${sp.errors[0].message} (line ${sp.errors[0].line}).`, type: "parse" }, ctx.kind)); logPush(tab, { kind: "query", text, ok: false, error: sp.errors[0].message }); throw null; } stmts = sp.statements; }
      if (!stmts.length) throw null;
      hPush(ctx.connId, text);
      let session = null;
      if (ctx.kind !== "mongodb") { try { session = await ensureSession(tab); ctx.session = session; } catch (e) { res.append(errBanner(e, ctx.kind)); throw null; } }
      // statement rows (queued) — rendered up front so progress is visible
      const blocks = stmts.map((s, i) => { const label = h("div", { class: "dbm-stmt-label queued", "aria-live": "off" }, h("span", { class: "dbm-stmt-state", text: "queued" }), h("span", { class: "dbm-stmt-text", text: `${stmts.length > 1 ? `${i + 1}. ` : ""}${s.text.replace(/\s+/g, " ").slice(0, 120)}${s.text.length > 120 ? "…" : ""}` }), h("span", { class: "dbm-stmt-ms" })); const body = h("div", { class: "dbm-stmt-body" }); res.append(label, body); return { label, body }; });
      const setState = (b, state, extra) => { b.label.className = "dbm-stmt-label " + state; b.label.querySelector(".dbm-stmt-state").textContent = state.replace("-", " "); if (extra != null) b.label.querySelector(".dbm-stmt-ms").textContent = extra; };
      let rowsTotal = 0, done = 0, failed = 0, unknown = 0, touchedSchema = false;
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i], b = blocks[i];
        if (ctx.cancelled) { setState(b, "not-run"); continue; }
        setState(b, "running");
        ctx.currentOp = uid("op");
        const t1 = Date.now();
        try {
          const r = explain ? await atom().db.explain(ctx.connId, s.text) : await atom().db.query(ctx.connId, s.text, { limit: ctx.limit, session, opId: ctx.currentOp, expectRev: ctx.rev });
          if (ctx.detached) break;                           // the tab was closed: this statement finished on ITS connection; the rest is not sent anywhere
          done++;
          if (r.session) { tab.sessionTx = !!r.session.inTx; syncSessionBadge(tab); }
          setState(b, "done", `${r.ms} ms`);
          logPush(tab, { kind: explain ? "explain" : "query", text: s.text, ms: r.ms, rows: r.columns && r.columns.length ? r.rows.length : null, hasMore: r.hasMore, affected: r.affected, ok: true });
          const sets = r.sets && r.sets.length > 1 ? r.sets : [r];
          for (const set of sets) {
            if (set.columns && set.columns.length) { rowsTotal += set.rows.length; b.body.append(resultBlock(tab, { ...set, ms: r.ms, effectiveSql: r.effectiveSql }, { name: tab.cur ? objName(tab.cur) : "query" })); }
            else b.body.append(h("div", { class: "dbm-exec-ok" }, h("span", { html: icon("check", 15) }), h("span", { text: (set.message || r.message || "OK") + ` · ${r.ms} ms` })));
          }
          if (r.op === "ddl" || r.op === "session" || /^(create|drop|alter|rename|truncate|use)\b/i.test(s.text)) touchedSchema = true;
        } catch (e) {
          if (ctx.detached) break;
          const isUnknown = e && e.type === "outcome-unknown";
          if (isUnknown) unknown++; else failed++;
          setState(b, isUnknown ? "unknown" : "failed", `${Date.now() - t1} ms`);
          b.body.append(errBanner(e, ctx.kind, { onInstalled: () => runQuery(tab, { explain }) }));
          logPush(tab, { kind: explain ? "explain" : "query", text: s.text, ok: false, error: errMsg(e), ms: Date.now() - t1, state: isUnknown ? "unknown" : "" });
          if (e && e.type === "session-gone") { tab.session = null; tab.sessionTx = false; syncSessionBadge(tab); }
          noteFailure(tab, e);
          for (let j = i + 1; j < stmts.length; j++) setState(blocks[j], "not-run");
          break;
        } finally { ctx.currentOp = null; }
      }
      if (!ctx.detached) {
        if (done && !failed && !unknown) markLive(tab);
        st.textContent = `${done} of ${stmts.length} statement${stmts.length > 1 ? "s" : ""} ran${failed ? ` · ${failed} failed` : ""}${unknown ? ` · ${unknown} with UNKNOWN outcome` : ""}${stmts.length - done - failed - unknown > 0 ? ` · ${stmts.length - done - failed - unknown} not run` : ""} · ${fmtInt(rowsTotal)} row${rowsTotal === 1 ? "" : "s"} shown · ${Date.now() - t0} ms${explain ? " · EXPLAIN" : ""}${tab.sessionTx ? " · transaction open" : ""}`;
        if (touchedSchema) { tab.struct.clear(); loadSchema(tab); }
      }
    } catch (e) { if (e) { res.append(errBanner(e, ctx.kind)); logPush(tab, { kind: "query", text, ok: false, error: errMsg(e) }); } }
    finally { if (tab.run === ctx) { tab.busy = false; tab.run = null; tab._runBtn.disabled = false; tab._stopBtn.style.display = "none"; renderTabBar(); } }
  };

  /* ---- jobs: export / import progress (main owns the job; Cancel is acknowledged) ---- */
  const ioWatchers = new Map();
  const offIo = atom().db.onIoProgress ? atom().db.onIoProgress((p) => { const cb = p && ioWatchers.get(p.token); if (cb) cb(p); }) : null;
  if (typeof offIo === "function") disposers.push(offIo);
  const ioToken = () => uid("io");
  const exportRows = async (tab, { format, scope, table, cols, rows, where, orderBy, dir, name }) => {
    const token = ioToken();
    const kind = tab.conn.kind;
    if (format === "sql" && (kind === "mongodb" || kind === "redis")) { toast("SQL INSERT export is not available for this engine — use JSON or CSV.", "alert", { ms: 5000 }); return; }
    let targetTable = table ? objRef(table) : null;
    if (format === "sql" && !targetTable) {
      const t = await D.promptDialog({ title: "Target table for INSERT statements", ic: "db", message: "Query results have no table of their own. Which table should the generated INSERT statements target? (The result's column names must exist there.)", placeholder: "schema.table", confirmLabel: "Export" });
      if (!t || !String(t).trim()) return;
      targetTable = { schema: "", table: String(t).trim() };
    }
    const prog = h("div", { class: "dbm-prog" }, h("div", { class: "dbm-prog-bar", style: "width:100%" }), h("span", { class: "dbm-prog-text", text: "Starting…" }));
    let back = null;
    if (scope === "all") back = D.modalShell({ title: `Exporting ${objName(table)}…`, ic: "download", body: h("div", { class: "dbm-imp" }, h("div", { class: "dbm-form-hint", text: "All rows are streamed page by page to a temporary file that is published when the export completes. Cancel keeps what was written as a clearly named partial file." }), prog), footer: [h("button", { class: "btn btn-ghost", text: "Cancel export", onclick: async () => { const r = await atom().db.exportCancel(token).catch(() => ({ ok: false })); toast(r.ok ? "Cancelling after the current page…" : "Nothing to cancel", r.ok ? "check" : "alert"); } })] });
    ioWatchers.set(token, (p) => { prog.querySelector(".dbm-prog-text").textContent = p.message || ""; if (p.phase === "done" && back) D.closeModal(back); });
    try {
      const r = await atom().db.exportFile({ token, id: tab.conn.id, table: table ? objRef(table) : undefined, targetTable, format, scope, columns: cols, rows, where, orderBy, dir, name });
      if (r && r.canceled) return;
      if (r && r.ok) { toast(`Exported ${fmtInt(r.rows)} rows → ${r.path.split(/[\\/]/).pop()}`, "checkCircle", { ms: 5000 }); logPush(tab, { kind: "export", text: `export ${scope === "all" ? "all rows of " : ""}${table ? objName(table) : name || "query"} as ${format.toUpperCase()} → ${r.path}`, rows: r.rows, ok: true }); }
      else if (r && r.state === "cancelled") { toast(`<b>Export cancelled</b><span class="toast-sub">${fmtInt(r.rows)} rows were written to ${D.esc ? D.esc(r.path.split(/[\\/]/).pop()) : r.path.split(/[\\/]/).pop()} (PARTIAL).</span>`, "alert", { ms: 8000 }); logPush(tab, { kind: "export", text: `export ${table ? objName(table) : name || "query"} as ${format} — cancelled, partial file ${r.path}`, rows: r.rows, ok: false, error: "cancelled (partial file kept)" }); }
      else toast("Export failed", "alert");
    } catch (e) { toast(`Export failed${e.type ? ` (${e.type})` : ""}: ${errMsg(e)}`, "alert", { ms: 8000 }); logPush(tab, { kind: "export", text: `export ${table ? objName(table) : name || "query"} as ${format}`, ok: false, error: errMsg(e) }); }
    finally { ioWatchers.delete(token); if (back) D.closeModal(back); }
  };
  // One result set: toolbar (filter · count · export) + accessible virtual grid.
  const resultBlock = (tab, r, { name, editable, pkCols, onEdit, onDelete, externalSort, exportCtx, onServerSearch, searchTerm } = {}) => {
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
  const showValue = (col, v) => {
    const text = isTag(v) && v.$t === "json" ? prettyJson(v.v) : isJsonish(v) ? prettyJson(v) : (v === null || v === undefined ? "NULL" : isTag(v) && v.$t === "bytes" ? `${fmtInt(v.len)} bytes\n\n${cellText(v)}` : cellText(v));
    const pre = h("pre", { class: "dbm-value-pre", text });
    D.modalShell({ title: String(col) + (isTag(v) ? ` · ${v.$t}` : ""), ic: "eye", wide: true, body: pre, footer: [h("button", { class: "btn btn-ghost", text: "Copy", onclick: () => copyText(cellText(v), "Copied") })] });
  };
  const showRowDetail = (cols, row, ri) => {
    const tbl = h("table", { class: "dbm-grid dbm-detail-grid" }, h("tbody", {}, ...cols.map((c, i) => {
      const v = row[i];
      return h("tr", {}, h("th", { class: "dbm-col-name", scope: "row", text: c }), h("td", { class: v === null || v === undefined ? "dbm-null" : "", text: v === null || v === undefined ? "NULL" : (isTag(v) && v.$t === "json" ? prettyJson(v.v) : isJsonish(v) ? prettyJson(v) : display(v)), title: "Click to copy", tabindex: "0", onclick: () => copyText(cellText(v), "Copied"), onkeydown: (e) => { if (e.key === "Enter") copyText(cellText(v), "Copied"); } }));
    })));
    D.modalShell({ title: `Row ${ri + 1}`, ic: "list", wide: true, body: h("div", { class: "dbm-detail-wrap" }, tbl), footer: [h("button", { class: "btn btn-ghost", text: "Copy JSON", onclick: () => copyText(toJSON(cols, [row]), "Row copied") })] });
  };
  /* Inline cell editor. Enter saves, Esc discards; blur with a changed value ASKS (Save /
   * Discard — every dismissal counts as Discard). The grid shows the ORIGINAL value until
   * the caller confirms the persisted row. */
  const startCellEdit = (grid, cellEl, ri, ci, onEdit) => {
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
  const searchWhere = (kind, cols, q) => {
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
  const combineWhere = (kind, userWhere, search) => { if (!search) return userWhere || ""; if (!userWhere) return search; if (kind === "mongodb") { try { return JSON.stringify({ $and: [JSON.parse(userWhere), JSON.parse(search)] }); } catch { return search; } } return `(${userWhere}) AND ${search}`; };

  /* ------------------------------ BROWSE ------------------------------ */
  const renderBrowse = async (tab) => {
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
  /* ============================================================
     IMPORT — a main-process JOB: picked → running → done | cancelled | failed.
     Cancel asks the job to stop (acknowledged, finishes after the current batch);
     Close only hides the dialog — the job continues and reports when it ends.
     Counts shown are exactly what the job reports: committed / failed / unattempted / unknown.
     ============================================================ */
  const importDialog = async (tab, it, { file, sheet } = {}) => {
    const conn = tab.conn, kind = conn.kind;
    if (kind === "redis") { toast("Import is not available for Redis.", "alert"); return; }
    if (!it || it.type === "view") { toast("Pick a table first.", "alert"); return; }
    const tableArg = { ...objRef(it), name: objName(it) };
    let pick;
    try { pick = await atom().db.importPick({ id: conn.id, table: tableArg, file, sheet }); }
    catch (e) { toast(`Import: ${errMsg(e)}`, "alert", { ms: 8000 }); return; }
    if (!pick || pick.canceled || !pick.ok) return;
    const token = pick.token;
    const fileName = String(pick.file).split(/[\\/]/).pop();
    let state = "picked", back = null, hidden = false;
    const result = h("div", { class: "dbm-imp-summary", role: "status" });
    const prog = h("div", { class: "dbm-prog", style: "display:none" }, h("div", { class: "dbm-prog-bar", style: "width:0%" }), h("span", { class: "dbm-prog-text", text: "" }));
    const errBox = h("div", { class: "dbm-imp-errors", style: "display:none" });
    const runBtn = h("button", { class: "btn btn-primary", text: pick.type === "sql" ? "Run script" : "Import" });
    const cancelBtn = h("button", { class: "btn btn-ghost", text: "Cancel import", style: "display:none", onclick: async () => { const r = await atom().db.importCancel(token).catch(() => ({ ok: false })); toast(r.ok ? "Cancelling after the current batch…" : `Nothing to cancel (${r.reason || "not running"})`, r.ok ? "check" : "alert"); } });
    const closeBtn = h("button", { class: "btn btn-ghost", text: pick.type === "sql" ? "Cancel" : "Cancel", onclick: () => D.closeModal(back) });
    const opts = h("div", { class: "dbm-imp-opts" });
    const body = h("div", { class: "dbm-imp" });
    const warn = (t) => h("div", { class: "dbm-form-hint dbm-bad", text: t });
    const info = h("div", { class: "dbm-form-hint", text: `${fileName} · ${fmtBytes(pick.size)} · ${fmtInt(pick.total)} ${pick.type === "sql" ? "statements" : "rows"}${pick.delim ? ` · delimiter ${pick.delim === "\t" ? "TAB" : JSON.stringify(pick.delim)}` : ""}${pick.sheet != null && pick.sheets ? ` · sheet “${pick.sheets[pick.sheet]}”` : ""}` });
    body.append(h("div", { class: "dbm-imp-row" }, h("span", { class: "dbm-imp-src", text: fileName }), h("span", { class: "dbm-imp-arrow", html: icon("arrowRight", 14) }), h("span", { class: "dbm-imp-target", text: objName(it) })), info);
    if (pick.sheets && pick.sheets.length > 1) {
      const sel = h("select", { class: "input", "aria-label": "Worksheet" }); pick.sheets.forEach((s, i) => sel.append(h("option", { value: String(i), text: s }))); sel.value = String(pick.sheet || 0);
      sel.onchange = async () => { await atom().db.importDiscard(token).catch(() => {}); D.closeModal(back); importDialog(tab, it, { file: pick.file, sheet: +sel.value }); };
      body.append(h("label", { class: "dbm-field" }, h("span", { text: "Worksheet" }), sel));
    }
    if (pick.errorCells) body.append(warn(`${fmtInt(pick.errorCells)} cell(s) hold Excel errors (#N/A, #DIV/0!, …) — they import as NULL, not as text.`));
    if (pick.bigNumbers) body.append(warn(`${fmtInt(pick.bigNumbers)} number(s) exceed 15 significant digits — Excel already lost precision; they are imported as text to avoid further rounding.`));
    if (pick.blankLines) body.append(h("div", { class: "dbm-form-hint", text: `${fmtInt(pick.blankLines)} blank line(s) were skipped.` }));
    if (pick.quotedEmpty) body.append(h("div", { class: "dbm-form-hint", text: `${fmtInt(pick.quotedEmpty)} quoted empty value(s) ("") import as empty strings; unquoted empties import as NULL.` }));
    if (pick.date1904) body.append(h("div", { class: "dbm-form-hint", text: "Workbook uses the 1904 date system — dates were converted accordingly." }));
    const mapping = {}; let hasHeader = pick.type === "table" ? !!pick.looksHeader : false;
    const o = { emptyFirst: false, ack: false, emptyAsNull: true, stopOnError: true, batch: 500 };
    let cols = [];
    const mapEl = h("div", { class: "dbm-imp-map" });
    const previewEl = h("div", { class: "dbm-imp-preview" });
    const srcNames = () => Array.from({ length: pick.width || 0 }, (_, i) => hasHeader && pick.sample[0] && pick.sample[0][i] != null && String(pick.sample[0][i]).trim() !== "" ? String(pick.sample[0][i]) : `Column ${i + 1}`);
    const autoMap = () => { const names = srcNames(); const lc = new Map(cols.map((c) => [c.name.toLowerCase(), c.name])); for (let i = 0; i < names.length; i++) { const m = lc.get(names[i].trim().toLowerCase()); mapping[i] = m || (!hasHeader && cols[i] ? cols[i].name : ""); } };
    const drawMap = () => {
      mapEl.innerHTML = ""; const names = srcNames();
      mapEl.append(h("div", { class: "dbm-imp-row dbm-imp-head" }, h("span", { class: "dbm-imp-src", text: "Source column" }), h("span", { class: "dbm-imp-arrow" }), h("span", { class: "dbm-imp-target", text: "Table column" })));
      names.forEach((n, i) => {
        const sel = h("select", { class: "input", "aria-label": `Target for ${n}` }, h("option", { value: "", text: "— skip —" }), ...cols.map((c) => h("option", { value: c.name, text: `${c.name}  (${c.type || ""}${c.nullable === false ? ", not null" : ""})` })));
        sel.value = mapping[i] || ""; sel.onchange = () => { mapping[i] = sel.value; };
        const sampleV = (pick.sample[hasHeader ? 1 : 0] || [])[i];
        mapEl.append(h("div", { class: "dbm-imp-row" }, h("span", { class: "dbm-imp-src", title: sampleV == null ? "first value: NULL" : `first value: ${sampleV}`, text: n }), h("span", { class: "dbm-imp-arrow", html: icon("arrowRight", 12) }), h("span", { class: "dbm-imp-target" }, sel)));
      });
      const rows = pick.sample.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 8);
      previewEl.innerHTML = "";
      if (rows.length) { const g = vgrid({ columns: names, rows, rowH: 24, headH: 26, label: "File preview" }); previewEl.append(h("div", { class: "dbm-form-hint", text: `First ${rows.length} data row${rows.length === 1 ? "" : "s"} as parsed:` }), g.el); g.el.style.height = Math.min(240, 26 + rows.length * 24 + 4) + "px"; g.refresh(); }
    };
    if (pick.type === "sql") {
      if (pick.errors && pick.errors.length) { body.append(warn(`The script cannot be run: ${pick.errors[0].message} (line ${pick.errors[0].line}). Nothing will be executed until the file is fixed.`)); runBtn.disabled = true; }
      body.append(h("div", { class: "dbm-form-hint", text: "Statements run in order in ONE session (USE / SET / transactions in the script apply to the following statements). Each statement is executed individually and its outcome recorded." }));
      const list = h("div", { class: "dbm-imp-preview" }, ...(pick.sample || []).map((s) => h("div", { class: "dbm-imp-row" }, h("span", { class: "dbm-dim", text: `L${s.line}` }), h("span", { class: "dbm-imp-src", style: "flex:1", text: s.text }))));
      if (pick.total > (pick.sample || []).length) list.append(h("div", { class: "dbm-dim", text: `… ${fmtInt(pick.total - pick.sample.length)} more` }));
      body.append(list);
      const stopCb = h("input", { type: "checkbox" }); stopCb.checked = true; stopCb.onchange = () => { o.stopOnError = stopCb.checked; };
      opts.append(h("label", { class: "dbm-check" }, stopCb, h("span", { text: "Stop at the first failing statement (the rest stay unattempted)" })));
    } else {
      try { cols = await getColumns(tab, it); } catch (e) { body.append(errBanner(e, kind)); runBtn.disabled = true; }
      autoMap();
      const hdrCb = h("input", { type: "checkbox" }); hdrCb.checked = hasHeader; hdrCb.onchange = () => { hasHeader = hdrCb.checked; autoMap(); drawMap(); };
      const emptyCb = h("input", { type: "checkbox" });
      const ackRow = h("label", { class: "dbm-check dbm-bad", style: "display:none" });
      const ackCb = h("input", { type: "checkbox" }); ackCb.onchange = () => { o.ack = ackCb.checked; };
      ackRow.append(ackCb, h("span", { text: "I understand: existing documents are deleted first and a failure leaves a partially filled collection." }));
      emptyCb.onchange = () => { o.emptyFirst = emptyCb.checked; ackRow.style.display = o.emptyFirst && kind === "mongodb" ? "" : "none"; };
      const nullCb = h("input", { type: "checkbox" }); nullCb.checked = true; nullCb.onchange = () => { o.emptyAsNull = nullCb.checked; };
      const stopCb = h("input", { type: "checkbox" }); stopCb.checked = true; stopCb.onchange = () => { o.stopOnError = stopCb.checked; };
      const batchIn = h("input", { class: "input dbm-limit", type: "number", min: "1", max: "5000", value: "500", "aria-label": "Rows per statement" }); batchIn.onchange = () => { o.batch = Math.max(1, Math.min(5000, +batchIn.value || 500)); batchIn.value = o.batch; };
      opts.append(
        h("label", { class: "dbm-check" }, hdrCb, h("span", { text: "First row is a header" })),
        h("label", { class: "dbm-check" }, emptyCb, h("span", { text: kind === "mongodb" ? "Empty the collection first (NOT atomic on MongoDB)" : "Empty the table first — atomic: delete + insert in ONE transaction, all or nothing" })),
        ackRow,
        h("label", { class: "dbm-check" }, nullCb, h("span", { text: "Empty cells → NULL (off: empty string)" })),
        h("label", { class: "dbm-check" }, stopCb, h("span", { text: "Stop at the first failing batch" })),
        kind === "oracle" ? h("span", { class: "dbm-form-hint", text: "Oracle: rows are inserted one by one." }) : h("label", { class: "dbm-check" }, h("span", { text: "Rows per INSERT (capped by the engine's parameter limit)" }), batchIn));
      drawMap();
      body.append(mapEl, previewEl);
    }
    body.append(opts, prog, result, errBox);
    const renderResult = (r) => {
      result.innerHTML = ""; errBox.innerHTML = ""; errBox.style.display = "none";
      const st = r.state || (r.ok ? "done" : "failed");
      const isSql = pick.type === "sql";
      const line = (label, n, cls) => h("div", { class: "dbm-imp-stat" + (cls ? " " + cls : "") }, h("span", { class: "dbm-dim", text: label }), h("b", { text: fmtInt(n) }));
      result.append(h("div", { class: "dbm-imp-state " + st, text: st === "done" ? (r.totalErrors ? "Finished with errors" : "Done") : st === "cancelled" ? "Cancelled" : "Failed" }));
      const stats = h("div", { class: "dbm-imp-stats" });
      if (isSql) stats.append(line("executed", r.executed), line("failed", r.failed, r.failed ? "bad" : ""), line("unattempted", r.unattempted), line("unknown outcome", r.unknown, r.unknown ? "warn" : ""));
      else stats.append(line("committed", r.committed), line("failed", r.failed, r.failed ? "bad" : ""), line("unattempted", r.unattempted), line("unknown outcome", r.unknown, r.unknown ? "warn" : ""));
      result.append(stats);
      if (!isSql && r.atomic) result.append(h("div", { class: "dbm-form-hint", text: r.rolledBack ? "Atomic import rolled back — the table is exactly as it was before." : r.committed ? "Atomic import committed as one transaction." : "" }));
      if (!isSql && r.nonAtomic) result.append(warn("Non-atomic: the collection was emptied before inserting. If rows failed, it is partially filled."));
      if (r.unknown) result.append(warn(`${fmtInt(r.unknown)} row(s)/statement(s) have an UNKNOWN outcome (the connection dropped mid-flight). Check the table before re-running.`));
      if (r.error) result.append(warn(r.error));
      result.append(h("div", { class: "dbm-dim", text: `${r.ms} ms` }));
      if (r.totalErrors) {
        errBox.style.display = "";
        errBox.append(h("div", { class: "dbm-form-hint", text: `${fmtInt(r.totalErrors)} error${r.totalErrors === 1 ? "" : "s"}${r.totalErrors > (r.errors || []).length ? ` — first ${(r.errors || []).length} shown` : ""}:` }));
        for (const e of r.errors || []) errBox.append(h("div", { class: "dbm-imp-err" }, h("span", { class: "dbm-dim", text: e.line ? `line ${e.line}` : e.at ? `row ${fmtInt(e.at)}${e.rows > 1 ? `–${fmtInt(e.at + e.rows - 1)}` : ""}` : e.phase || "" }), h("span", { text: `${e.type && e.type !== "db" ? `[${e.type}] ` : ""}${e.error}` }), e.statement ? h("code", { text: e.statement }) : null));
        if (r.errorsFile) errBox.append(h("button", { class: "btn btn-ghost btn-sm", text: "Copy path of the full error list", onclick: () => copyText(r.errorsFile, "Path copied") }));
      }
    };
    const finish = (r) => {
      state = r.state || "done";
      ioWatchers.delete(token);
      prog.style.display = "none"; cancelBtn.style.display = "none"; closeBtn.textContent = "Close"; runBtn.style.display = "none";
      const n = pick.type === "sql" ? r.executed : r.committed;
      logPush(tab, { kind: "import", text: `import ${fileName} → ${objName(it)} (${state})`, rows: n, ms: r.ms, ok: state === "done" && !r.totalErrors, error: state === "done" ? (r.totalErrors ? `${r.totalErrors} error(s)` : "") : (r.error || state), state: r.unknown ? "unknown" : "" });
      renderResult(r);
      if (hidden) toast(`Import ${state}: ${fmtInt(n)} ${pick.type === "sql" ? "statements executed" : "rows committed"}${r.totalErrors ? ` · ${fmtInt(r.totalErrors)} error(s)` : ""}`, state === "done" && !r.totalErrors ? "checkCircle" : "alert", { ms: 8000 });
      if (n || r.emptyFirst) { tab.struct.delete(objName(it)); if (it.rows != null) it.rows = null; loadSchema(tab); if (tab.mode === "browse" && sameObj(tab.cur, it)) { tab.browse.total = null; renderBrowse(tab); } }
    };
    runBtn.onclick = async () => {
      if (state !== "picked") return;
      if (pick.type === "table") {
        if (!Object.values(mapping).some(Boolean)) { toast("Map at least one column.", "alert"); return; }
        if (o.emptyFirst && kind === "mongodb" && !o.ack) { toast("Acknowledge the non-atomic plan first.", "alert"); return; }
        if (o.emptyFirst && !(await confirm("Empty first", `All rows of “${objName(it)}” will be deleted${kind === "mongodb" ? " (not atomic)" : " in the same transaction as the insert — a failure restores them"}. Continue?`, "Empty and import"))) return;
      }
      state = "running"; runBtn.disabled = true; cancelBtn.style.display = ""; closeBtn.textContent = "Close (keeps running)"; prog.style.display = "";
      prog.querySelector(".dbm-prog-text").textContent = "Starting…";
      ioWatchers.set(token, (p) => { if (p.phase === "done") return; const pct = p.total ? Math.round((p.done / p.total) * 100) : 0; prog.querySelector(".dbm-prog-bar").style.width = pct + "%"; prog.querySelector(".dbm-prog-text").textContent = p.message || `${fmtInt(p.done)} / ${fmtInt(p.total)}`; });
      try {
        const r = await atom().db.importRun(pick.type === "sql"
          ? { token, id: conn.id, stopOnError: o.stopOnError }
          : { token, id: conn.id, table: tableArg, mapping, hasHeader, emptyFirst: o.emptyFirst, acknowledgeNonAtomic: o.ack, emptyAsNull: o.emptyAsNull, stopOnError: o.stopOnError, batch: o.batch });
        finish(r);
      } catch (e) {
        ioWatchers.delete(token); state = "failed"; prog.style.display = "none"; cancelBtn.style.display = "none"; closeBtn.textContent = "Close";
        const retryable = ["job-expired", "stale-connection", "job-target", "non-atomic"].includes(e.type);
        result.innerHTML = ""; result.append(errBanner(e, kind, { extra: retryable ? [h("button", { class: "btn btn-ghost btn-sm", text: "Pick the file again", onclick: () => { D.closeModal(back); importDialog(tab, it); } })] : [] }));
        if (e.type === "non-atomic") { state = "picked"; runBtn.disabled = false; }
        logPush(tab, { kind: "import", text: `import ${fileName} → ${objName(it)}`, ok: false, error: errMsg(e), state: e.type === "outcome-unknown" ? "unknown" : "" });
        noteFailure(tab, e);
        if (hidden) toast(`Import failed: ${errMsg(e)}`, "alert", { ms: 8000 });
      }
    };
    back = D.modalShell({ title: pick.type === "sql" ? `Run ${fileName}` : `Import into ${objName(it)}`, ic: "upload", wide: true, body, footer: [closeBtn, cancelBtn, runBtn] });
    back.addEventListener("modal-closed", () => { if (state === "picked") atom().db.importDiscard(token).catch(() => {}); else if (state === "running") hidden = true; });
  };

  /* ------------------------------ INSERT ROW ------------------------------ */
  let insertBusy = false;                                    // one insert in flight at a time (a double-click never inserts twice)
  const insertRowDialog = async (tab) => {
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
      if (insertBusy) return; insertBusy = true; btn.disabled = true; status.innerHTML = "";
      try {
        const values = collect();
        const r = await atom().db.insertRow(conn.id, objRef(it), values, { expectRev: conn.rev });
        toast(r.message || "Inserted", "check");
        logPush(tab, { kind: "edit", text: r.sql || `insert into ${objName(it)}`, affected: r.affected, ok: true });
        if (it.rows != null) it.rows += r.affected || 1;
        D.closeModal(back);
        if (tab.mode === "browse" && sameObj(tab.cur, it)) { tab.browse.total = null; renderBrowse(tab); }
      } catch (e) { status.append(errBanner(e, kind)); logPush(tab, { kind: "edit", text: `insert into ${objName(it)}`, ok: false, error: errMsg(e), state: e.type === "outcome-unknown" ? "unknown" : "" }); noteFailure(tab, e); }
      finally { insertBusy = false; btn.disabled = false; }
    } });
    body.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); btn.click(); } });
    back = D.modalShell({ title: `Insert into ${objName(it)}`, ic: "plus", wide: true, body: h("div", {}, body, status), footer: [h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => D.closeModal(back) }), btn] });
    setTimeout(() => { const f = back.querySelector("input, textarea"); if (f) f.focus(); }, 30);
  };

  /* ============================================================
     STRUCTURE — columns / indexes / foreign keys / DDL. Renames, drops and reordering are
     collected as a PENDING PLAN per table (nothing is sent), reviewed as exact steps
     (schemaPlan dryRun) and applied as one plan with per-step outcomes.
     ============================================================ */
  const emptyPlan = () => ({ renames: new Map(), drops: new Set(), dropIndexes: new Set(), order: null, rev: null });
  const pendingCount = (P) => (P ? P.renames.size + P.drops.size + P.dropIndexes.size + (P.order ? 1 : 0) : 0);
  const planOf = (tab, it) => { const k = objName(it); if (!tab.pendingByTable.has(k)) tab.pendingByTable.set(k, emptyPlan()); const P = tab.pendingByTable.get(k); if (P.rev != null && P.rev !== tab.conn.rev) Object.assign(P, emptyPlan()); P.rev = tab.conn.rev; return P; };
  const planPayload = (P) => ({ renames: [...P.renames.entries()], drops: [...P.drops], dropIndexes: [...P.dropIndexes], order: P.order });
  // Drop plan entries that no longer match the live table (after a refresh).
  const prunePlan = (P, info) => {
    const names = new Set(info.columns.map((c) => c.name)), ix = new Set(info.indexes.map((x) => x.name));
    for (const n of [...P.drops]) if (!names.has(n)) P.drops.delete(n);
    for (const n of [...P.renames.keys()]) if (!names.has(n)) P.renames.delete(n);
    for (const n of [...P.dropIndexes]) if (!ix.has(n)) P.dropIndexes.delete(n);
    if (P.order && (P.order.length !== names.size || P.order.some((n) => !names.has(n)))) P.order = null;
  };
  const stepState = (s) => h("span", { class: "dbm-step-state " + (s.state || "planned"), text: s.state || "planned" });
  const stepsList = (steps) => h("div", { class: "dbm-steps" }, ...steps.map((s, i) => h("div", { class: "dbm-step " + (s.state || "planned") }, h("span", { class: "dbm-dim", text: `${i + 1}.` }), h("span", { class: "dbm-step-label", text: s.label }), stepState(s), h("code", { class: "dbm-step-sql", text: s.sql || "" }), s.error ? h("span", { class: "dbm-bad", text: s.error }) : null)));
  const reviewPlan = async (tab, it) => {
    const P = planOf(tab, it); if (!pendingCount(P)) return;
    const conn = tab.conn, kind = conn.kind;
    const body = h("div", { class: "dbm-imp" }, h("div", { class: "dbm-dim", text: "Computing the exact steps…" }));
    let back = null; let applying = false;
    const applyBtn = h("button", { class: "btn btn-primary", text: "Apply", disabled: true });
    const closeBtn = h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => D.closeModal(back) });
    back = D.modalShell({ title: `Review changes to ${objName(it)}`, ic: "cpu", wide: true, body, footer: [closeBtn, applyBtn] });
    let plan;
    try { plan = await atom().db.schemaPlan(conn.id, objRef(it), planPayload(P), { dryRun: true, expectRev: conn.rev }); }
    catch (e) {
      body.innerHTML = ""; body.append(errBanner(e, kind));
      if (e.type === "invalid" || e.type === "stale-connection") { body.append(h("div", { class: "dbm-form-hint", text: "The table changed since the plan was made. Refresh the structure — entries that no longer apply are removed from the plan." }), h("button", { class: "btn btn-ghost btn-sm", text: "Refresh structure", onclick: () => { D.closeModal(back); tab.struct.delete(objName(it)); renderStruct(tab); } })); }
      return;
    }
    body.innerHTML = "";
    if (!plan.steps.length) { body.append(h("div", { class: "dbm-form-hint", text: plan.message || "No changes" }), ...(plan.notes || []).map((n) => warn(n))); return; }
    body.append(h("div", { class: "dbm-form-hint", text: plan.transactional ? "All steps run in ONE transaction: if any step fails, every step is rolled back." : "⚠ This engine cannot roll back DDL: steps run one by one and stop at the first failure — the ones already done stay applied. Each step's outcome is reported." }),
      ...(plan.notes || []).map((n) => warn(n)), stepsList(plan.steps));
    applyBtn.textContent = `Apply ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}`; applyBtn.disabled = false;
    applyBtn.onclick = async () => {
      if (applying) return; applying = true; applyBtn.disabled = true; closeBtn.disabled = true;
      let res;
      try { res = await atom().db.schemaPlan(conn.id, objRef(it), planPayload(P), { expectRev: conn.rev }); }
      catch (e) { body.append(errBanner(e, kind)); logPush(tab, { kind: "ddl", text: `schema plan ${objName(it)}`, ok: false, error: errMsg(e), state: e.type === "outcome-unknown" ? "unknown" : "" }); noteFailure(tab, e); closeBtn.disabled = false; applying = false; return; }
      body.innerHTML = "";
      body.append(h("div", { class: "dbm-imp-state " + (res.ok ? "done" : "failed"), text: res.ok ? "Applied" : (res.transactional ? "Failed — rolled back" : "Failed — see the steps") }), ...(res.notes || []).map((n) => warn(n)), res.error ? warn(res.error) : null, stepsList(res.steps || []));
      for (const s of res.steps || []) logPush(tab, { kind: "ddl", text: s.sql || s.label, ok: s.state === "done", error: s.state === "done" ? "" : `${s.state}${s.error ? ": " + s.error : ""}` });
      closeBtn.textContent = "Close"; closeBtn.disabled = false;
      if (res.ok) { toast("Schema changes applied ✓", "check"); tab.pendingByTable.delete(objName(it)); }
      else if (!res.transactional && (res.steps || []).some((s) => s.state === "done")) { toast("Some steps were applied before the failure — review the structure.", "alert", { ms: 8000 }); tab.pendingByTable.delete(objName(it)); }
      else toast("Nothing was changed.", "alert");
      tab.struct.delete(objName(it)); await loadSchema(tab); if (tab.mode === "struct" && sameObj(tab.cur, it)) renderStruct(tab);
    };
    function warn(t) { return h("div", { class: "dbm-form-hint dbm-bad", text: t }); }
  };
  const renderStruct = async (tab) => {
    const panel = tab.wsEl.querySelector(".dbm-struct-panel");
    panel.innerHTML = "";
    const it = tab.cur, kind = tab.conn.kind, conn = tab.conn;
    if (!it) { panel.append(h("div", { class: "dbm-empty dbm-big-empty" }, h("span", { html: icon("cpu", 26) }), h("div", { text: `Pick a ${objNoun(kind, false)} on the left to inspect its structure.` }))); return; }
    const gen = (tab._structGen = (tab._structGen || 0) + 1);
    const key = objName(it);
    let info = tab.struct.get(key) && tab.struct.get(key).info;
    if (!info) {
      panel.append(h("div", { class: "dbm-empty dbm-running" }, h("span", { class: "dbm-spinner" }), h("span", { text: " Loading structure…" })));
      try { info = await atom().db.tableInfo(conn.id, objRef(it)); }
      catch (e) { if (gen !== tab._structGen) return; panel.innerHTML = ""; panel.append(errBanner(e, kind, { extra: [h("button", { class: "btn btn-ghost btn-sm", html: icon("refresh", 12) + "<span>Retry</span>", onclick: () => renderStruct(tab) })] })); noteFailure(tab, e); logPush(tab, { kind: "struct", text: `structure ${key}`, ok: false, error: errMsg(e) }); return; }
      if (gen !== tab._structGen) return;
      tab.struct.set(key, { ...(tab.struct.get(key) || {}), info, columns: info.columns });
      markLive(tab);
    }
    panel.innerHTML = "";
    const isSql = kind !== "mongodb", isView = it.type === "view";
    const P = isSql ? planOf(tab, it) : null; if (P) prunePlan(P, info);
    const policy = conn.policy || {};
    const ddlBlocked = !!policy.blockDDL || (policy.protectedTables || []).some((t) => t.toLowerCase() === key.toLowerCase() || t.toLowerCase() === String(it.table || "").toLowerCase());
    const canEdit = !isView && !ddlBlocked;
    const bodyEl = h("div", { class: "dbm-struct-body" });
    const stabs = h("div", { class: "dbm-struct-tabs", role: "tablist" });
    const tabsDef = [["columns", `${kind === "mongodb" ? "Fields" : "Columns"} (${info.columns.length})`], ["indexes", `Indexes (${info.indexes.length})`], ...(isSql ? [["fks", `Foreign keys (${info.foreignKeys.length})`], ["ddl", "DDL"]] : [])];
    const pendBar = h("div", { class: "dbm-pending", style: "display:none" });
    const syncPending = () => {
      const n = pendingCount(P);
      pendBar.style.display = n ? "" : "none"; pendBar.innerHTML = "";
      if (!n) return;
      pendBar.append(h("span", { class: "dbm-pending-ic", html: icon("alert", 13) }), h("span", { class: "dbm-pending-text", text: `${n} pending change${n === 1 ? "" : "s"} — nothing has been sent to the database yet.` }), h("div", { class: "spacer" }),
        h("button", { class: "btn btn-ghost btn-sm", text: "Discard", onclick: () => { tab.pendingByTable.delete(key); renderStruct(tab); } }),
        h("button", { class: "btn btn-primary btn-sm", text: "Review & apply…", onclick: () => reviewPlan(tab, it) }));
    };
    const draw = () => {
      bodyEl.innerHTML = "";
      for (const b of stabs.children) { b.classList.toggle("active", b.dataset.k === tab.structTab); b.setAttribute("aria-selected", b.dataset.k === tab.structTab ? "true" : "false"); }
      if (tab.structTab === "columns") bodyEl.append(drawColumns());
      else if (tab.structTab === "indexes") bodyEl.append(drawIndexes());
      else if (tab.structTab === "fks") bodyEl.append(drawFks());
      else bodyEl.append(drawDdl());
      if (P) syncPending();
    };
    for (const [k, label] of tabsDef) stabs.append(h("button", { class: "dbm-stab", role: "tab", dataset: { k }, text: label, onclick: () => { tab.structTab = k; draw(); } }));
    if (!tabsDef.some(([k]) => k === tab.structTab)) tab.structTab = "columns";
    const drawColumns = () => {
      const cols = info.columns;
      const names = cols.map((c) => c.name);
      const order = P && P.order ? P.order : names;
      const byName = new Map(cols.map((c) => [c.name, c]));
      const canReorder = kind === "mysql" && canEdit;
      const tbl = h("table", { class: "dbm-grid dbm-static", "aria-label": "Columns" });
      tbl.append(h("thead", {}, h("tr", {}, canReorder ? h("th", { class: "dbm-drag-cell", "aria-label": "Reorder" }) : null, h("th", { text: "#" }), h("th", { text: "Name" }), h("th", { text: "Type" }), h("th", { text: "Null" }), h("th", { text: "Default" }), h("th", { text: "Key" }), h("th", { text: kind === "mongodb" ? "Seen in" : "Extra" }), canEdit ? h("th", { text: "" }) : null)));
      const tb = h("tbody"); tbl.append(tb);
      let dragName = null;
      order.forEach((name, i) => {
        const c = byName.get(name); if (!c) return;
        const renamed = P && P.renames.get(name), dropped = P && P.drops.has(name), moved = P && P.order && names[i] !== name;
        const tr = h("tr", { class: (renamed ? "dbm-row-renamed " : "") + (dropped ? "dbm-row-dropped " : "") + (moved ? "dbm-row-moved" : ""), dataset: { name } });
        if (canReorder) { tr.draggable = true; tr.classList.add("dbm-draggable"); tr.append(h("td", { class: "dbm-drag-cell" }, h("span", { class: "dbm-drag", html: icon("moreVert", 12), title: "Drag to reorder" }))); tr.addEventListener("dragstart", (e) => { dragName = name; e.dataTransfer.effectAllowed = "move"; tr.classList.add("dragging"); }); tr.addEventListener("dragend", () => tr.classList.remove("dragging")); tr.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }); tr.addEventListener("drop", (e) => { e.preventDefault(); if (!dragName || dragName === name) return; const cur = [...order]; cur.splice(cur.indexOf(dragName), 1); cur.splice(cur.indexOf(name), 0, dragName); P.order = cur.every((n, j) => n === names[j]) ? null : cur; dragName = null; draw(); }); }
        tr.append(h("td", { class: "dbm-rn", text: String(i + 1) }),
          h("td", { class: "dbm-col-name" }, c.key === "PRI" ? h("span", { class: "dbm-pk-ic", html: icon("key", 10), title: "primary key" }) : null, h("span", { text: name }), renamed ? h("span", { class: "dbm-rename-to", text: ` → ${renamed}` }) : null, dropped ? h("span", { class: "dbm-drop-tag", text: "will be dropped" }) : null),
          h("td", { class: "dbm-type", text: c.type || "" }),
          h("td", { text: c.nullable === false ? "NOT NULL" : c.nullable === true ? "NULL" : "" }),
          h("td", { class: c.default == null ? "dbm-null" : "", text: c.default == null ? "" : String(c.default) }),
          h("td", { text: c.key === "PRI" ? "PK" : c.key === "UNI" ? "UNIQUE" : c.key === "MUL" ? "INDEX" : (c.key || "") }),
          h("td", { class: "dbm-dim", text: kind === "mongodb" ? (c.seen != null ? `${fmtInt(c.seen)} docs` : "") : (c.extra || "") + (c.comment ? (c.extra ? " · " : "") + c.comment : "") }));
        if (canEdit) {
          const acts = h("td", { class: "dbm-row-acts" });
          if (isSql) {
            acts.append(h("button", { class: "dbm-mini", html: icon("pencil", 11), title: renamed ? `Pending rename to ${renamed} — click to change` : "Rename (pending)", "aria-label": `Rename ${name}`, disabled: dropped, onclick: async () => { const nn = await D.promptDialog({ title: `Rename column ${name}`, ic: "pencil", message: "The rename is added to the pending plan; nothing is sent until you review and apply.", value: renamed || name, confirmLabel: "Add to plan" }); if (nn == null) return; const v = String(nn).trim(); if (!v || v === name) P.renames.delete(name); else if (names.includes(v) && !P.drops.has(v)) { toast(`A column named “${v}” already exists.`, "alert"); return; } else P.renames.set(name, v); draw(); } }),
              h("button", { class: "dbm-mini" + (dropped ? " on" : ""), html: icon(dropped ? "undo" : "trash", 11), title: dropped ? "Undo drop" : "Drop column (pending)", "aria-label": dropped ? `Undo drop of ${name}` : `Drop ${name}`, onclick: () => { if (dropped) P.drops.delete(name); else { if (c.key === "PRI") toast("This column is part of the primary key — dropping it is planned; the review step shows the exact statement.", "alert", { ms: 5000 }); P.drops.add(name); P.renames.delete(name); } draw(); } }));
          } else {
            acts.append(h("button", { class: "dbm-mini", html: icon("pencil", 11), title: "Rename field on all documents", "aria-label": `Rename ${name}`, onclick: async () => { const nn = await D.promptDialog({ title: `Rename field ${name}`, ic: "pencil", message: "Renames the field on EVERY document of the collection (a write).", value: name, confirmLabel: "Rename" }); if (nn == null || !String(nn).trim() || nn === name) return; try { const r = await atom().db.renameColumn(conn.id, objRef(it), name, String(nn).trim(), { expectRev: conn.rev }); toast(r.message, "check"); logPush(tab, { kind: "ddl", text: `rename field ${name} → ${nn}`, ok: true }); tab.struct.delete(key); renderStruct(tab); } catch (e) { toast(errMsg(e), "alert", { ms: 6000 }); noteFailure(tab, e); } } }),
              h("button", { class: "dbm-mini", html: icon("trash", 11), title: "Remove field from all documents", "aria-label": `Remove ${name}`, onclick: async () => { if (!(await confirm("Remove field", `Remove “${name}” from EVERY document in “${key}”? This cannot be undone.`, "Remove"))) return; try { const r = await atom().db.dropColumn(conn.id, objRef(it), name, { expectRev: conn.rev }); toast(r.message, "check"); logPush(tab, { kind: "ddl", text: `remove field ${name}`, ok: true }); tab.struct.delete(key); renderStruct(tab); } catch (e) { toast(errMsg(e), "alert", { ms: 6000 }); noteFailure(tab, e); } } }));
          }
          tr.append(acts);
        }
        tb.append(tr);
      });
      const wrap = h("div", { class: "dbm-sec" }, tbl);
      if (canReorder) wrap.append(h("div", { class: "dbm-struct-note", text: P && P.order ? "Column order changed (pending) — MySQL rewrites the moved columns' definitions." : "Drag rows to change the column order (MySQL)." }));
      if (kind === "mongodb") wrap.append(h("div", { class: "dbm-struct-note", text: "Fields are inferred from a sample of documents — a schemaless collection may hold others." }));
      if (isView) wrap.append(h("div", { class: "dbm-struct-note", text: "Views are read-only here." }));
      if (ddlBlocked && !isView) wrap.append(h("div", { class: "dbm-struct-note", text: "Schema changes are blocked by this connection's policy." }));
      return wrap;
    };
    const drawIndexes = () => {
      const tbl = h("table", { class: "dbm-grid dbm-static", "aria-label": "Indexes" });
      tbl.append(h("thead", {}, h("tr", {}, h("th", { text: "Name" }), h("th", { text: "Columns" }), h("th", { text: "Unique" }), h("th", { text: "Type" }), canEdit ? h("th", { text: "" }) : null)));
      const tb = h("tbody"); tbl.append(tb);
      if (!info.indexes.length) tb.append(h("tr", {}, h("td", { colspan: "5", class: "dbm-dim", text: "No indexes." })));
      for (const ix of info.indexes) {
        const dropped = P && P.dropIndexes.has(ix.name);
        const tr = h("tr", { class: dropped ? "dbm-row-dropped" : "" },
          h("td", { class: "dbm-col-name" }, ix.primary ? h("span", { class: "dbm-pk-ic", html: icon("key", 10), title: "primary key" }) : null, h("span", { text: ix.name }), dropped ? h("span", { class: "dbm-drop-tag", text: "will be dropped" }) : null),
          h("td", { text: (ix.columns || []).join(", ") }), h("td", { text: ix.unique ? "yes" : "" }), h("td", { class: "dbm-dim", text: ix.type || "" }));
        if (canEdit) {
          const td = h("td", { class: "dbm-row-acts" });
          if (!ix.primary) td.append(h("button", { class: "dbm-mini" + (dropped ? " on" : ""), html: icon(dropped ? "undo" : "trash", 11), title: isSql ? (dropped ? "Undo drop" : "Drop index (pending)") : "Drop index", "aria-label": `Drop index ${ix.name}`, onclick: async () => {
            if (isSql) { if (dropped) P.dropIndexes.delete(ix.name); else P.dropIndexes.add(ix.name); draw(); return; }
            if (!(await confirm("Drop index", `Drop index “${ix.name}” on “${key}”?`, "Drop"))) return;
            try { const r = await atom().db.dropIndex(conn.id, objRef(it), ix.name, { expectRev: conn.rev }); toast(r.message, "check"); logPush(tab, { kind: "ddl", text: `drop index ${ix.name}`, ok: true }); tab.struct.delete(key); renderStruct(tab); } catch (e) { toast(errMsg(e), "alert", { ms: 6000 }); noteFailure(tab, e); }
          } }));
          tr.append(td);
        }
        tb.append(tr);
      }
      return h("div", { class: "dbm-sec" }, tbl);
    };
    const drawFks = () => {
      const tbl = h("table", { class: "dbm-grid dbm-static", "aria-label": "Foreign keys" });
      tbl.append(h("thead", {}, h("tr", {}, h("th", { text: "Constraint" }), h("th", { text: "Columns" }), h("th", { text: "References" }), h("th", { text: "On delete" }), h("th", { text: "On update" }))));
      const tb = h("tbody"); tbl.append(tb);
      if (!info.foreignKeys.length) tb.append(h("tr", {}, h("td", { colspan: "5", class: "dbm-dim", text: "No foreign keys." })));
      for (const f of info.foreignKeys) {
        const ref = { schema: f.refSchema || "", table: f.refTable, name: f.refSchema && SCHEMA_KINDS.has(kind) ? `${f.refSchema}.${f.refTable}` : f.refTable };
        tb.append(h("tr", {}, h("td", { class: "dbm-col-name", text: f.name }), h("td", { text: f.columns.join(", ") }),
          h("td", {}, h("button", { class: "dbm-link", text: `${ref.name} (${f.refColumns.join(", ")})`, title: "Open the referenced table", onclick: () => { const target = (tab.schema && tab.schema.items || []).find((x) => sameObj(x, ref)) || { ...ref, type: "table" }; selectObject(tab, target); renderStruct(tab); } })),
          h("td", { class: "dbm-dim", text: f.onDelete || "" }), h("td", { class: "dbm-dim", text: f.onUpdate || "" })));
      }
      return h("div", { class: "dbm-sec" }, tbl);
    };
    const drawDdl = () => h("div", { class: "dbm-sec dbm-ddl-wrap" },
      h("div", { class: "dbm-sec-head" }, h("span", { text: info.ddlNative ? "Definition (from the server)" : "Definition (APPROXIMATE — synthesised from catalog metadata)" }), h("div", { class: "spacer" }), h("button", { class: "btn btn-ghost btn-sm dbm-ddl-copy", html: icon("copy", 12) + "<span>Copy</span>", onclick: () => copyText(info.ddl, "DDL copied") })),
      info.ddlNative ? null : h("div", { class: "dbm-struct-note dbm-bad", text: "This engine does not return the original CREATE statement here. Constraints, index options, identity settings and expressions may be missing — do not use it as a migration source." }),
      h("pre", { class: "dbm-ddl", text: info.ddl || "(no definition available)" }));
    panel.append(
      h("div", { class: "dbm-struct-title" }, h("span", { html: icon(isView ? "eye" : "cpu", 14) }), h("span", { text: key }),
        h("span", { class: "dbm-struct-meta", text: `${info.columns.length} ${kind === "mongodb" ? "fields" : "columns"} · ${info.indexes.length} index${info.indexes.length === 1 ? "" : "es"}${isSql && info.foreignKeys.length ? ` · ${info.foreignKeys.length} foreign key${info.foreignKeys.length === 1 ? "" : "s"}` : ""}${info.rows != null ? ` · ~${fmtInt(info.rows)} rows` : ""}` }),
        h("div", { class: "spacer" }),
        canEdit ? h("button", { class: "btn btn-ghost btn-sm", html: icon("plus", 12) + `<span>${kind === "mongodb" ? "Field" : "Column"}</span>`, onclick: () => addColumnDialog(tab, it) }) : null,
        canEdit ? h("button", { class: "btn btn-ghost btn-sm", html: icon("plus", 12) + "<span>Index</span>", onclick: () => addIndexDialog(tab, it, info) }) : null,
        h("button", { class: "btn btn-ghost btn-sm", html: icon("refresh", 12), title: "Reload structure", "aria-label": "Reload structure", onclick: () => { tab.struct.delete(key); renderStruct(tab); } })),
      stabs, pendBar, bodyEl);
    draw();
  };
  /* Add column: the type's INACTIVE parameters are cleared when the type changes (a length
   * never leaks onto a numeric); the preview is the server's dryRun, bound to the connection revision. */
  const addColumnDialog = async (tab, it) => {
    const conn = tab.conn, kind = conn.kind;
    const types = kindOf(kind).types || [];
    const isMongo = kind === "mongodb";
    let cols = []; try { cols = await getColumns(tab, it); } catch { /* preview will tell */ }
    const col = { name: "", type: types[0] ? types[0].t : "", length: "", precision: "", scale: "", enumValues: [], nullable: true, default: "", unique: false, comment: "", after: "" };
    const nameIn = h("input", { class: "input", type: "text", placeholder: isMongo ? "field name" : "column_name", spellcheck: "false", "aria-label": "Name" }); nameIn.oninput = () => { col.name = nameIn.value; schedule(); };
    const typeSel = h("select", { class: "input", "aria-label": "Type" }); for (const t of types) typeSel.append(h("option", { value: t.t, text: t.t + (t.note ? ` — ${t.note}` : "") }));
    const lenIn = h("input", { class: "input dbm-ac-num", type: "text", placeholder: "length", "aria-label": "Length" }); lenIn.oninput = () => { col.length = lenIn.value; schedule(); };
    const precIn = h("input", { class: "input dbm-ac-num", type: "number", placeholder: "precision", "aria-label": "Precision" }); precIn.oninput = () => { col.precision = precIn.value; schedule(); };
    const scaleIn = h("input", { class: "input dbm-ac-num", type: "number", placeholder: "scale", "aria-label": "Scale" }); scaleIn.oninput = () => { col.scale = scaleIn.value; schedule(); };
    const enumIn = h("input", { class: "input", type: "text", placeholder: "values, comma separated: small, medium, large", "aria-label": "Enum values" }); enumIn.oninput = () => { col.enumValues = enumIn.value.split(",").map((s) => s.trim()).filter(Boolean); schedule(); };
    const nullCb = h("input", { type: "checkbox" }); nullCb.checked = true; nullCb.onchange = () => { col.nullable = nullCb.checked; schedule(); };
    const uniqCb = h("input", { type: "checkbox" }); uniqCb.onchange = () => { col.unique = uniqCb.checked; schedule(); };
    const defIn = h("input", { class: "input", type: "text", placeholder: isMongo ? "value set on documents that lack the field (JSON or text)" : "default value or expression (e.g. 0, 'n/a', CURRENT_TIMESTAMP)", spellcheck: "false", "aria-label": "Default" }); defIn.oninput = () => { col.default = defIn.value; schedule(); };
    const commentIn = h("input", { class: "input", type: "text", placeholder: "comment (optional)", "aria-label": "Comment" }); commentIn.oninput = () => { col.comment = commentIn.value; schedule(); };
    const afterSel = h("select", { class: "input", "aria-label": "Position" }, h("option", { value: "", text: "at the end" }), ...cols.map((c) => h("option", { value: c.name, text: `after ${c.name}` }))); afterSel.onchange = () => { col.after = afterSel.value; schedule(); };
    const lenRow = h("label", { class: "dbm-field" }, h("span", { text: "Length" }), lenIn);
    const precRow = h("div", { class: "dbm-ac-row" }, h("label", { class: "dbm-field" }, h("span", { text: "Precision" }), precIn), h("label", { class: "dbm-field" }, h("span", { text: "Scale" }), scaleIn));
    const enumRow = h("label", { class: "dbm-field" }, h("span", { text: "Values" }), enumIn);
    const previewEl = h("pre", { class: "dbm-ac-preview", text: "" });
    const previewNote = h("div", { class: "dbm-form-hint", text: "" });
    let previewSeq = 0, timer = 0;
    const payload = () => ({ name: col.name.trim(), type: col.type, length: col.length, precision: col.precision, scale: col.scale, enumValues: col.enumValues, nullable: col.nullable, default: col.default, unique: col.unique, comment: col.comment, after: col.after });
    const preview = async () => {
      const seq = ++previewSeq;
      if (!col.name.trim()) { previewEl.textContent = ""; previewNote.textContent = "Enter a name to see the exact statement."; previewEl.classList.remove("dbm-bad"); return; }
      try { const r = await atom().db.addColumn(conn.id, objRef(it), payload(), { dryRun: true, expectRev: conn.rev }); if (seq !== previewSeq) return; previewEl.textContent = r.sql || ""; previewEl.classList.remove("dbm-bad"); previewNote.textContent = r.transactional === false ? "This engine cannot roll back DDL — each statement is final once it runs." : ""; }
      catch (e) { if (seq !== previewSeq) return; previewEl.textContent = errMsg(e); previewEl.classList.add("dbm-bad"); previewNote.textContent = ""; }
    };
    function schedule() { clearTimeout(timer); timer = setTimeout(preview, 200); }
    const meta = () => types.find((t) => t.t === typeSel.value) || {};
    const syncType = () => {
      const m = meta();
      lenRow.style.display = m.len ? "" : "none"; precRow.style.display = m.prec ? "" : "none"; enumRow.style.display = m.enum ? "" : "none";
      if (!m.len) { col.length = ""; lenIn.value = ""; } else { col.length = m.dlen != null ? String(m.dlen) : ""; lenIn.value = col.length; lenIn.placeholder = m.max ? "length or MAX" : "length"; }
      if (!m.prec) { col.precision = ""; col.scale = ""; precIn.value = ""; scaleIn.value = ""; }
      if (!m.enum) { col.enumValues = []; enumIn.value = ""; }
      schedule();
    };
    typeSel.onchange = () => { col.type = typeSel.value; syncType(); };
    const form = h("div", { class: "dbm-ac-form" }, h("label", { class: "dbm-field" }, h("span", { text: "Name" }), nameIn));
    if (!isMongo) form.append(h("label", { class: "dbm-field" }, h("span", { text: "Type" }), typeSel), lenRow, precRow, enumRow,
      h("div", { class: "dbm-ac-row" }, h("label", { class: "dbm-check" }, nullCb, h("span", { text: "Allow NULL" })), h("label", { class: "dbm-check" }, uniqCb, h("span", { text: "Unique" }))));
    form.append(h("label", { class: "dbm-field" }, h("span", { text: "Default" }), defIn));
    if (kind === "mysql" || kind === "postgres" || kind === "oracle") form.append(h("label", { class: "dbm-field" }, h("span", { text: "Comment" }), commentIn));
    if (kind === "mysql") form.append(h("label", { class: "dbm-field" }, h("span", { text: "Position" }), afterSel));
    const status = h("div", { class: "dbm-form-status" });
    let back = null, busy = false;
    const applyBtn = h("button", { class: "btn btn-primary", text: isMongo ? "Add field" : "Add column", onclick: async () => {
      if (busy) return; if (!col.name.trim()) { toast("Enter a name.", "alert"); return; }
      busy = true; applyBtn.disabled = true; status.innerHTML = "";
      try {
        const r = await atom().db.addColumn(conn.id, objRef(it), payload(), { expectRev: conn.rev });
        toast(r.message || "Added", "check"); logPush(tab, { kind: "ddl", text: r.sql || `add column ${col.name}`, ok: true });
        tab.struct.delete(objName(it)); D.closeModal(back); await loadSchema(tab); if (tab.mode === "struct" && sameObj(tab.cur, it)) renderStruct(tab);
      } catch (e) { status.append(errBanner(e, kind)); if (e.details) { try { status.append(stepsList(JSON.parse(e.details))); } catch { /* not steps */ } } logPush(tab, { kind: "ddl", text: `add column ${col.name}`, ok: false, error: errMsg(e), state: e.type === "outcome-unknown" ? "unknown" : "" }); noteFailure(tab, e); }
      finally { busy = false; applyBtn.disabled = false; }
    } });
    back = D.modalShell({ title: `${isMongo ? "Add field to" : "Add column to"} ${objName(it)}`, ic: "plus", wide: true, body: h("div", { class: "dbm-addcol dbm-ac-modal" }, h("div", { class: "dbm-ac" }, form, h("div", { class: "dbm-ac-side" }, h("div", { class: "dbm-addcol-label", text: "Exact statement (server preview)" }), previewEl, previewNote)), status), footer: [h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => D.closeModal(back) }), applyBtn] });
    if (!isMongo) syncType(); else schedule();
    setTimeout(() => nameIn.focus(), 30);
  };
  const addIndexDialog = async (tab, it, info) => {
    const conn = tab.conn, kind = conn.kind;
    const cols = (info && info.columns) || (await getColumns(tab, it).catch(() => []));
    const order = [];
    const nameIn = h("input", { class: "input", type: "text", placeholder: "index name (optional — generated from the columns)", spellcheck: "false", "aria-label": "Index name" });
    const uniqCb = h("input", { type: "checkbox" });
    const list = h("div", { class: "dbm-ix-cols", role: "group", "aria-label": "Columns" });
    const draw = () => {
      list.innerHTML = "";
      for (const c of cols) {
        const pos = order.indexOf(c.name);
        list.append(h("button", { class: "dbm-ix-col" + (pos >= 0 ? " on" : ""), "aria-pressed": pos >= 0 ? "true" : "false", onclick: () => { if (pos >= 0) order.splice(pos, 1); else order.push(c.name); draw(); } }, pos >= 0 ? h("span", { class: "dbm-ix-ord", text: String(pos + 1) }) : null, h("span", { text: c.name }), h("span", { class: "dbm-type dbm-dim", text: c.type || "" })));
      }
      hint.textContent = order.length ? `Index on (${order.join(", ")}) — click columns in the order they should appear.` : "Click columns in the order they should appear in the index.";
    };
    const hint = h("div", { class: "dbm-form-hint" });
    draw();
    const status = h("div", { class: "dbm-form-status" });
    let back = null, busy = false;
    const btn = h("button", { class: "btn btn-primary", text: "Create index", onclick: async () => {
      if (busy) return; if (!order.length) { toast("Pick at least one column.", "alert"); return; }
      busy = true; btn.disabled = true; status.innerHTML = "";
      try { const r = await atom().db.addIndex(conn.id, objRef(it), { name: nameIn.value.trim(), columns: order, unique: uniqCb.checked }, { expectRev: conn.rev }); toast(r.message || "Index created", "check"); logPush(tab, { kind: "ddl", text: r.sql || `create index on ${objName(it)}`, ok: true }); tab.struct.delete(objName(it)); D.closeModal(back); if (tab.mode === "struct" && sameObj(tab.cur, it)) renderStruct(tab); }
      catch (e) { status.append(errBanner(e, kind)); logPush(tab, { kind: "ddl", text: `create index on ${objName(it)}`, ok: false, error: errMsg(e), state: e.type === "outcome-unknown" ? "unknown" : "" }); noteFailure(tab, e); }
      finally { busy = false; btn.disabled = false; }
    } });
    back = D.modalShell({ title: `New index on ${objName(it)}`, ic: "plus", body: h("div", { class: "dbm-addcol" }, h("label", { class: "dbm-field" }, h("span", { text: "Name" }), nameIn), h("label", { class: "dbm-check" }, uniqCb, h("span", { text: "Unique" })), list, hint, status), footer: [h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => D.closeModal(back) }), btn] });
  };

  /* ---- global keys: Ctrl+K filter objects · Ctrl+L toggle log · F5 refresh schema ---- */
  const onGlobalKeys = (e) => {
    if (!mountEl.isConnected) return;
    const at = AT();
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "k") { const f = at._objUI && at._objUI.filterIn; if (f && f.isConnected) { e.preventDefault(); f.focus(); f.select(); } }
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "l") { if (at.conn && at.wsEl) { e.preventDefault(); toggleLog(at); } }
    else if (e.key === "F5") { if (at.conn) { e.preventDefault(); at.struct.clear(); loadSchema(at); } }
  };
  document.addEventListener("keydown", onGlobalKeys);
  disposers.push(() => document.removeEventListener("keydown", onGlobalKeys));

  /* ---- boot ---- */
  renderTabBar(); renderSide(); showWelcome(); startHealth();
  if (pref("autoconnect", false)) { const c = connById(pref("last-conn", null)); if (c) openInTab(c); }

  const dispose = async () => {
    for (const d0 of disposers.splice(0)) { try { d0(); } catch { /* */ } }
    for (const t of tabs) await disposeTab(t);
    if (objList) { objList.dispose(); objList = null; }
    mountEl.innerHTML = "";
  };
  return { dispose, __internals: {
    tabs: () => tabs, AT, mkTab, tabsOf, openInTab, closeTab, switchTab, disposeTab, hasDraft, runQuery, stopRun, ensureSession, renderBrowse, renderStruct, drawConnForm, importDialog, insertRowDialog, addColumnDialog, addIndexDialog, reviewPlan,
    pendingCount, planOf, prunePlan, emptyPlan, searchWhere, combineWhere, connStatus, desired, setConnStatus, bumpGen, genOf, checkHealth, checkOne, noteFailure, disconnectConn, markLive, logPush, hLoad, hPush, hClear, hClearAll, pref, setPref,
    conns: () => conns, kinds: () => kinds, reloadConns: async () => { conns = await atom().db.list(); renderSide(); }, side, wsHost, tabBar, ioWatchers, exportRows, resultBlock, startCellEdit, showValue, showRowDetail, loadSchema, getColumns, selectObject, openQuery, openBrowse, openStruct, setMode, queryTemplate, objMenu, connMenu, showWelcome, renderSide, renderTabBar, applyObjFilter, errBanner, syncSessionBadge,
  } };
}

/* Pure helpers for unit tests (no DOM state). */
export const __dbmUtils = { parseEdit, display, cellText, cellClass, cellTitle, isTag, isJsonish, prettyJson, toCSV, toJSON, toMD, toTSV, csvEsc, jsonVal, cmpVals, numOf, qIdent, qName, objRef, objName, sameObj, redisQuote, defaultQ, insertTemplate, vlist, vgrid, fmtInt, fmtNum, fmtBytes, b64hex, debounce, DB_COLORS, SCHEMA_KINDS };
