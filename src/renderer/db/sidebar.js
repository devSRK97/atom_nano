/* AtomNano renderer — Database Manager — welcome screen, the connections rail with its menu, the virtualised object list (filter · chips · menus · DDL shortcuts), schema loading.
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { copyText } from "./cells.js";
import { drawConnForm, errBanner } from "./connections.js";
import { vlist } from "./grid.js";
import { disconnectConn, markLive, noteFailure, statusTitle, syncConnCards } from "./health.js";
import { runQuery } from "./query.js";
import { _welcomeEl, activeTabId, AT, atom, chip, confirm, conns, connsError, connStatus, D, h, hClear, icon, kindOf, kinds, objList, objNoun, pref, setConns, setConnsError, setObjList, setPref, setWelcomeEl, side, tabsOf, toast, wsHost } from "./state.js";
import { debounce, defaultQ, errMsg, fmtBytes, fmtInt, fmtNum, insertTemplate, objName, objRef, qName, redisQuote, sameObj, SCHEMA_KINDS } from "./utils.js";
import { buildWorkspace, disposeTab, hideAllWs, logPush, openBrowse, openInTab, openQuery, openStruct, renderTabBar, switchTab } from "./workspace.js";

/* ---- welcome ---- */
export const showWelcome = () => {
  hideAllWs();
  if (!_welcomeEl) {
    const grid = h("div", { class: "dbm-kinds" });
    for (const k of kinds) grid.append(h("button", { class: "dbm-kind-card", onclick: () => drawConnForm(null, { kind: k.id }) },
      chip(k.id, 30), h("span", { class: "dbm-kind-name", text: k.name }), h("span", { class: "dbm-kind-sub", text: k.installed ? "driver ready" : "installs on first use" })));
    const autoCb = h("input", { type: "checkbox" }); autoCb.checked = !!pref("autoconnect", false); autoCb.onchange = () => setPref("autoconnect", autoCb.checked);
    setWelcomeEl(h("div", { class: "dbm-welcome" },
      h("div", { class: "dbm-welcome-title" }, h("span", { html: icon("db", 20) }), h("span", { text: "Database Manager" })),
      h("div", { class: "dbm-welcome-sub", text: "Connect to 7 engines · browse tables with stable server-side paging and inline editing · run scripts statement by statement in your own session · inspect columns, indexes, foreign keys and DDL. Ctrl+Click a connection to open it in a new tab." }),
      grid,
      h("label", { class: "dbm-check dbm-welcome-pref" }, autoCb, h("span", { text: "Open the last used connection when the Database Manager starts" })),
      connsError ? errBanner({ message: "Saved connections could not be read: " + connsError }, null) : null));
    wsHost.append(_welcomeEl);
  }
  _welcomeEl.style.display = "";
};

/* ============================================================
   SIDEBAR — connections + virtualised object list
   ============================================================ */
export const renderSide = () => {
  if (objList) { objList.dispose(); setObjList(null); }
  side.innerHTML = "";
  side.append(h("div", { class: "dbm-side-head" },
    h("span", { text: "Connections" }), h("span", { class: "dbm-schema-count", text: String(conns.length) }),
    h("button", { class: "dbm-mini", html: icon("plus", 13), title: "Add connection", "aria-label": "Add connection", onclick: () => drawConnForm() })));
  const listEl = h("div", { class: "dbm-conns", role: "list" });
  if (connsError) listEl.append(errBanner({ message: connsError, type: "store" }, null, { extra: [h("button", { class: "btn btn-ghost btn-sm", text: "Retry", onclick: async () => { try { setConns(await atom().db.list()); setConnsError(""); } catch (e) { setConnsError(errMsg(e)); } renderSide(); } })] }));
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
  setObjList(vlist({ rowH: 26, className: "dbm-tables", label: noun, render: (it) => objRow(at, it) }));
  objList.el.addEventListener("keydown", (e) => objKeys(at, e));
  side.append(head, h("div", { class: "dbm-filter-wrap" }, filterIn), chips, objList.el);
  at._objUI = { countEl, filterIn, chips, list: objList };
  filterIn.addEventListener("input", debounce(() => { at.filter = filterIn.value; applyObjFilter(at); }, 90));
  filterIn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); objList.el.focus(); } if (e.key === "Escape") { filterIn.value = ""; at.filter = ""; applyObjFilter(at); } if (e.key === "Enter" && at.conn.kind === "redis") redisSearch(at, filterIn.value.trim()); });
  if (at.schema) applyObjFilter(at); else loadSchema(at);
};
export const connMenu = (e, c) => D.showContextMenu(e.clientX, e.clientY, [
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
    try { setConns(await atom().db.list()); } catch (e2) { setConnsError(errMsg(e2)); }
    for (const t of tabsOf(c.id)) { await disposeTab(t); t.conn = null; t.connLive = false; t.schema = null; t.cur = null; }
    renderSide(); switchTab(activeTabId);
  } },
]);
export const applyObjFilter = (tab) => {
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
export const redisMore = async (tab) => { try { const r = await atom().db.schemaMore(tab.conn.id, { cursor: tab.schema.cursor }); const seen = new Set(tab.schema.items.map((x) => x.name)); tab.schema.items.push(...r.items.filter((x) => !seen.has(x.name))); tab.schema.cursor = r.cursor; tab.schema.info = `${fmtInt(tab.schema.keyCount)} keys in this database${r.complete ? "" : ` — ${fmtInt(tab.schema.items.length)} loaded so far`}`; applyObjFilter(tab); } catch (e) { toast("Couldn't load more keys: " + errMsg(e), "alert"); } };
export const redisSearch = async (tab, q) => { if (!q || !tab.schema) return; try { const r = await atom().db.schemaMore(tab.conn.id, { cursor: "0", match: `*${q}*`, want: 2000 }); const seen = new Set(tab.schema.items.map((x) => x.name)); tab.schema.items.push(...r.items.filter((x) => !seen.has(x.name))); tab.schema.info = `${r.items.length} key(s) match “${q}” on the server${r.complete ? "" : " (partial scan)"}`; applyObjFilter(tab); } catch (e) { toast("Search failed: " + errMsg(e), "alert"); } };
export const objRow = (tab, it) => {
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
export const objKeys = (tab, e) => {
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
export const selectObject = (tab, it) => { if (!sameObj(tab.cur, it)) tab.browse = { offset: 0, limit: tab.browse.limit || 200, orderBy: "", dir: "asc", where: "", search: "", total: null }; tab.cur = it; if (tab._objUI) tab._objUI.list.refresh(); renderTabBar(); if (tab.wsEl) { const b = tab.wsEl.querySelector(".dbm-cur-badge"); if (b) { b.textContent = objName(it); b.style.display = ""; } } };
export const queryTemplate = (tab, it, run) => {
  buildWorkspace(tab);
  const q = defaultQ(tab.conn, it);
  if (tab._ed) { tab._ed.value = q; tab._draft = q; }
  openQuery(tab);
  if (run) runQuery(tab);
};
export const objMenu = (tab, it, e) => {
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
export const runDDL = async (tab, sql, okMsg, extra = {}) => {
  try { const r = await atom().db.query(tab.conn.id, sql, { expectRev: tab.conn.rev, ...extra }); toast(okMsg + (r.message ? " · " + r.message : ""), "check"); logPush(tab, { kind: "ddl", text: sql, ms: r.ms, affected: r.affected, ok: true }); tab.struct.clear(); await loadSchema(tab); }
  catch (e) { toast("Failed: " + errMsg(e), "alert", { ms: 6000 }); logPush(tab, { kind: "ddl", text: sql, ok: false, error: errMsg(e), state: e.type === "outcome-unknown" ? "unknown" : "" }); noteFailure(tab, e); }
};
export const countExact = async (tab, it) => {
  toast(`Counting ${objName(it)}…`, "spinner", { sticky: true, spin: true });
  try { const r = await atom().db.count(tab.conn.id, objRef(it)); toast(`${objName(it)}: ${fmtInt(r.count)} rows (${r.ms} ms)`, "checkCircle", { ms: 5000 }); logPush(tab, { kind: "count", text: `count ${objName(it)}`, ms: r.ms, rows: r.count, ok: true }); it.rows = r.count; it.rowsEstimated = false; if (tab._objUI) tab._objUI.list.refresh(); }
  catch (e) { toast("Count failed: " + errMsg(e), "alert", { ms: 6000 }); logPush(tab, { kind: "count", text: `count ${objName(it)}`, ok: false, error: errMsg(e) }); }
};
export const loadSchema = async (tab) => {
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
export const getColumns = async (tab, it) => {
  const key = objName(it);
  if (tab.struct.has(key) && tab.struct.get(key).columns) return tab.struct.get(key).columns;
  const cols = await atom().db.columns(tab.conn.id, objRef(it));
  tab.struct.set(key, { ...(tab.struct.get(key) || {}), columns: cols });
  return cols;
};
