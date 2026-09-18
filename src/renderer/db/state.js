/* AtomNano renderer — Database Manager — injected deps, the manager's module state (connections, tabs, status maps …) with its setters, and the small helpers that read it.
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { DB_COLORS, uid } from "./utils.js";

export let D = null;
export const h = (...a) => D.h(...a);
export const icon = (...a) => D.icon(...a);
export const toast = (...a) => D.toast(...a);
export const atom = () => D.atom;

/* ---- mount state: what the mountDbManager closure used to hold. Reset on every mount; the other
 * modules read these live bindings and write them through the setters below. ---- */
export let disposers = [];
export let kinds = [], conns = [], connsError = "";
export let tabs = [], activeTabId = null;
export let connStatus = new Map(), desired = new Map(), statusGen = new Map();   // per connection: status · what the user asked for · generation (see health.js)
export let healthTimer = 0;
export let _welcomeEl = null;
export let objList = null;
export let ioWatchers = new Map();                                                // export / import job progress watchers by token (see jobs.js)
export let insertBusy = false;                                                    // one insert in flight at a time (a double-click never inserts twice)
export let side = null, tabBar = null, wsHost = null;                             // the DOM scaffold
export function resetState(deps) {
  D = deps;
  disposers = []; kinds = []; conns = []; connsError = "";
  tabs = []; activeTabId = null;
  connStatus = new Map(); desired = new Map(); statusGen = new Map();
  healthTimer = 0; _welcomeEl = null; objList = null; ioWatchers = new Map(); insertBusy = false;
  side = null; tabBar = null; wsHost = null;
}
export function setKinds(v) { kinds = v; }
export function setConns(v) { conns = v; }
export function setConnsError(v) { connsError = v; }
export function setActiveTabId(id) { activeTabId = id; }
export function setHealthTimer(t) { healthTimer = t; }
export function setWelcomeEl(el) { _welcomeEl = el; }
export function setObjList(l) { objList = l; }
export function setInsertBusy(b) { insertBusy = b; }
// One empty tab to start with (created once the connection list is known, as before).
export function initTabs() { tabs = [mkTab()]; activeTabId = tabs[0].id; }
/* ---- DOM scaffold ---- */
export function buildScaffold(mountEl) {
  side = h("aside", { class: "dbm-side", role: "complementary", "aria-label": "Connections and objects" });
  tabBar = h("div", { class: "dbm-tabbar", role: "tablist", "aria-label": "Connection tabs" });
  wsHost = h("div", { class: "dbm-ws-host" });
  mountEl.append(h("div", { class: "dbm-wrap" }, side, h("section", { class: "dbm-main" }, tabBar, wsHost)));
}

export const kindOf = (id) => kinds.find((k) => k.id === id) || { name: id, fields: [], policies: [] };
export const chip = (kind, size = 22) => h("span", { class: "dbm-chip", "aria-hidden": "true", style: `background:${DB_COLORS[kind] || "var(--bg-4)"}; width:${size}px; height:${size}px;`, text: (kindOf(kind).name || "?")[0] });
export const setDot = (el, live) => { if (el) el.style.background = live ? "#58c07a" : "var(--text-4)"; };
export const objNoun = (kind, plural = true) => kind === "mongodb" ? (plural ? "Collections" : "collection") : kind === "redis" ? (plural ? "Keys" : "key") : (plural ? "Tables" : "table");
export const connById = (id) => conns.find((c) => c.id === id) || null;
export const pref = (k, d) => { try { const v = localStorage.getItem("dbm-" + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
export const setPref = (k, v) => { try { localStorage.setItem("dbm-" + k, JSON.stringify(v)); } catch { /* */ } };

/* ---- tabs (never mutated on close: a closed tab's run context stays its own) ---- */
export const mkTab = (conn = null) => ({ id: uid("t"), conn, connLive: false, cur: null, mode: "query", busy: false, run: null, session: null, sessionTx: false, autocommit: true, wsEl: null, schema: null, filter: "", typeFilter: "all", sortBy: "name", _limit: pref("limit", 200), _draft: "", struct: new Map(), structTab: "columns", log: [], logMin: pref("log-min", false), browse: { offset: 0, limit: pref("page", 200), orderBy: "", dir: "asc", where: "", search: "", total: null }, pendingByTable: new Map(), disposers: [] });
export const AT = () => tabs.find((t) => t.id === activeTabId) || tabs[0];
export const tabsOf = (connId) => tabs.filter((t) => t.conn && t.conn.id === connId);

/* ---- query history (per connection, localStorage; retention is a preference) ---- */
export const hKey = (id) => "dbm-h-" + id;
export const hLoad = (id) => { try { return JSON.parse(localStorage.getItem(hKey(id)) || "[]"); } catch { return []; } };
export const hPush = (id, sql) => { if (!sql || !id || pref("hist-off", false)) return; const arr = hLoad(id).filter((x) => x !== sql); arr.unshift(sql); try { localStorage.setItem(hKey(id), JSON.stringify(arr.slice(0, pref("hist-max", 100)))); } catch { /* full */ } };
export const hClear = (id) => { try { localStorage.removeItem(hKey(id)); } catch { /* */ } };
export const hClearAll = () => { try { for (const k of Object.keys(localStorage)) if (k.startsWith("dbm-h-")) localStorage.removeItem(k); } catch { /* */ } };
// Every dismissal (Cancel, ×, backdrop, Escape) resolves false — never a dangling decision.
export const confirm = async (title, message, label, danger = true) => (await D.chooseDialog({ title, ic: danger ? "alert" : "db", message, choices: [{ label, value: "yes", primary: true }, { label: "Cancel", value: null }] })) === "yes";
