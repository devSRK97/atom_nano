/* AtomNano renderer — Database Manager — virtual list and the accessible virtual grid (roles, roving focus, sort / filter, callbacks by row index).
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { cellClass, cellText, cellTitle, cmpVals, copyText, display } from "./cells.js";
import { h, icon } from "./state.js";

/* ------------------------------ virtual list ------------------------------ */
export function vlist({ rowH = 26, overscan = 8, render, className = "", label }) {
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
export function vgrid({ columns, rows, rowH = 26, headH = 30, onCell, onCellDbl, onCellMenu, onRowNum, pkCols = [], externalSort = null, label }) {
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
