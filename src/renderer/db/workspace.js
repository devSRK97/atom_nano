/* AtomNano renderer — Database Manager — connection tabs, the per-tab workspace (toolbar, Query / Browse / Structure modes) and the execution log.
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { renderBrowse } from "./browse.js";
import { copyText } from "./cells.js";
import { drawConnForm } from "./connections.js";
import { disconnectConn } from "./health.js";
import { buildQueryPanel } from "./query.js";
import { loadSchema, queryTemplate, renderSide, showWelcome } from "./sidebar.js";
import { activeTabId, AT, atom, chip, confirm, D, h, icon, kindOf, mkTab, pref, setActiveTabId, setDot, setPref, tabBar, tabs, tabsOf, wsHost } from "./state.js";
import { pendingCount, renderStruct } from "./structure.js";
import { fmtInt, objName } from "./utils.js";

/* ---- tab bar ---- */
export const renderTabBar = () => {
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
export const hideAllWs = () => { for (const el of wsHost.children) el.style.display = "none"; };
export const switchTab = (id) => {
  setActiveTabId(id);
  hideAllWs();
  const at = AT();
  if (at.wsEl) at.wsEl.style.display = "";
  else if (at.conn) buildWorkspace(at);
  else showWelcome();
  renderTabBar(); renderSide();
};
// Release a tab's backend session (rolling back an open transaction) and UI resources.
export const disposeTab = async (t) => {
  for (const d0 of t.disposers.splice(0)) { try { d0(); } catch { /* */ } }
  if (t.wsEl) { t.wsEl.remove(); t.wsEl = null; }
  if (t.session) { const sid = t.session; t.session = null; t.sessionTx = false; await atom().db.sessionClose(sid, { rollback: true }).catch(() => {}); }
};
export const hasDraft = (t) => !!((t._draft && t._draft.trim()) || [...t.pendingByTable.values()].some((p) => pendingCount(p) > 0));
export const closeTab = async (id) => {
  const t = tabs.find((x) => x.id === id); if (!t) return;
  if (t.busy && !(await confirm("Close busy tab", "A statement is still running in this tab. Closing detaches the tab; the statement finishes (or is cancelled) on its original connection. Close anyway?", "Close tab"))) return;
  if (!t.busy && hasDraft(t) && !(await confirm("Discard draft", `This tab has ${t._draft && t._draft.trim() ? "an unsaved query draft" : ""}${t._draft && t._draft.trim() && [...t.pendingByTable.values()].some((p) => pendingCount(p) > 0) ? " and " : ""}${[...t.pendingByTable.values()].some((p) => pendingCount(p) > 0) ? "pending schema changes" : ""}. Close and discard?`, "Discard & close"))) return;
  if (t.sessionTx && !(await confirm("Open transaction", "This tab has an uncommitted transaction. Closing the tab rolls it back. Continue?", "Roll back & close"))) return;
  const idx = tabs.indexOf(t);
  if (t.run) t.run.detached = true;                       // a run in flight keeps ITS context; the UI just stops updating
  await disposeTab(t);
  tabs.splice(idx, 1);
  if (!tabs.length) tabs.push(mkTab());                    // always a fresh object — never the old one reused
  if (activeTabId === id) setActiveTabId(tabs[Math.max(0, idx - 1)].id);
  switchTab(activeTabId);
};
/* Open a connection: reuse the tab already showing it, else fill the current EMPTY tab,
 * else a new tab (forceNew always opens a new one). */
export const openInTab = (conn, forceNew = false) => {
  setPref("last-conn", conn.id);
  if (!forceNew) {
    const existing = tabsOf(conn.id)[0];
    if (existing) { switchTab(existing.id); if (!existing.schema) loadSchema(existing); return; }
    const at = AT();
    if (!at.conn) { at.conn = conn; at.connLive = false; at.cur = null; at.schema = null; switchTab(at.id); loadSchema(at); return; }
  }
  const nt = mkTab(conn); tabs.push(nt); setActiveTabId(nt.id);
  switchTab(activeTabId); loadSchema(nt);
};

/* ------------------------------ EXECUTION LOG ------------------------------ */
export const fmtTime = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour12: false });
export const logPush = (tab, e) => {
  if (!tab) return;
  tab.log.unshift({ ts: Date.now(), ...e });
  if (tab.log.length > pref("log-max", 500)) tab.log.length = pref("log-max", 500);
  renderLog(tab);
};
export const logAll = (connId, e) => { for (const t of tabsOf(connId)) logPush(t, e); };
export const toggleLog = (tab) => {
  tab.logMin = !tab.logMin; setPref("log-min", tab.logMin);
  if (tab._log) { tab._log.panel.classList.toggle("min", tab.logMin); tab._log.minBtn.innerHTML = icon(tab.logMin ? "chevronRight" : "chevronDown", 13); tab._log.minBtn.title = tab.logMin ? "Expand log (Ctrl+L)" : "Minimize log (Ctrl+L)"; tab._log.minBtn.setAttribute("aria-expanded", tab.logMin ? "false" : "true"); }
  renderLog(tab);
};
export const buildLogPanel = (tab) => {
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
export const renderLog = (tab) => {
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

/* ============================================================
   WORKSPACE (per tab): toolbar + Query / Browse / Structure panels
   ============================================================ */
export const syncSessionBadge = (tab) => { const b = tab.wsEl && tab.wsEl.querySelector(".dbm-tx-badge"); if (!b) return; b.textContent = tab.sessionTx ? "TRANSACTION OPEN" : (tab.autocommit === false ? "autocommit off" : ""); b.style.display = tab.sessionTx || tab.autocommit === false ? "" : "none"; b.title = tab.sessionTx ? "This tab holds an uncommitted transaction — COMMIT or ROLLBACK it; closing the tab rolls it back." : "Statements in this tab are not committed until you run COMMIT"; };
export const buildWorkspace = (tab) => {
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
export const setMode = (tab, mode) => {
  tab.mode = mode;
  if (!tab.wsEl) return;
  for (const [m, sel, btn] of [["query", ".dbm-query-panel", tab._tbQ], ["browse", ".dbm-browse-panel", tab._tbB], ["struct", ".dbm-struct-panel", tab._tbS]]) {
    tab.wsEl.querySelector(sel).style.display = m === mode ? "" : "none";
    if (btn) { btn.classList.toggle("active", m === mode); btn.setAttribute("aria-selected", m === mode ? "true" : "false"); }
  }
  if (tab._objUI) tab._objUI.list.refresh();
};
export const openQuery = (tab) => { if (!tab.wsEl) buildWorkspace(tab); setMode(tab, "query"); if (tab._ed) tab._ed.focus(); };
export const openBrowse = (tab) => { if (tab.conn.kind === "redis") { queryTemplate(tab, tab.cur, true); return; } if (!tab.wsEl) buildWorkspace(tab); setMode(tab, "browse"); renderBrowse(tab); };
export const openStruct = (tab) => { if (tab.conn.kind === "redis") return; if (!tab.wsEl) buildWorkspace(tab); setMode(tab, "struct"); renderStruct(tab); };
