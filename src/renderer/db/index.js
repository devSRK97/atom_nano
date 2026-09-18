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
 *   A11Y         the grid is a real grid (roles, roving focus, keyboard edit/copy/sort/menu).
 *
 * Modules (this folder): utils · cells · state · grid · health · workspace · connections · sidebar ·
 * query · results · jobs · browse · structure — this entry mounts the manager and exports the public API. */
import { insertRowDialog, renderBrowse } from "./browse.js";
import { b64hex, cellClass, cellText, cellTitle, cmpVals, csvEsc, display, isJsonish, isTag, jsonVal, numOf, parseEdit, prettyJson, toCSV, toJSON, toMD, toTSV } from "./cells.js";
import { drawConnForm, errBanner } from "./connections.js";
import { vgrid, vlist } from "./grid.js";
import { bumpGen, checkHealth, checkOne, disconnectConn, genOf, markLive, noteFailure, setConnStatus, startHealth } from "./health.js";
import { exportRows, importDialog } from "./jobs.js";
import { ensureSession, runQuery, stopRun } from "./query.js";
import { combineWhere, resultBlock, searchWhere, showRowDetail, showValue, startCellEdit } from "./results.js";
import { applyObjFilter, connMenu, getColumns, loadSchema, objMenu, queryTemplate, renderSide, selectObject, showWelcome } from "./sidebar.js";
import { AT, atom, buildScaffold, connById, conns, connStatus, desired, disposers, hClear, hClearAll, hLoad, hPush, initTabs, ioWatchers, kinds, mkTab, objList, pref, resetState, setConns, setConnsError, setKinds, setObjList, setPref, side, tabBar, tabs, tabsOf, wsHost } from "./state.js";
import { addColumnDialog, addIndexDialog, emptyPlan, pendingCount, planOf, prunePlan, renderStruct, reviewPlan } from "./structure.js";
import { DB_COLORS, debounce, defaultQ, errMsg, fmtBytes, fmtInt, fmtNum, insertTemplate, objName, objRef, qIdent, qName, redisQuote, sameObj, SCHEMA_KINDS } from "./utils.js";
import { closeTab, disposeTab, hasDraft, logPush, openBrowse, openInTab, openQuery, openStruct, renderTabBar, setMode, switchTab, syncSessionBadge, toggleLog } from "./workspace.js";

/* ============================================================
   MOUNT
   ============================================================ */
export async function mountDbManager(mountEl, deps) {
  resetState(deps);
  try { setKinds(await atom().db.kinds()); } catch { /* offline */ }
  try { setConns(await atom().db.list()); } catch (e) { setConnsError(errMsg(e)); setConns([]); }
  initTabs();
  buildScaffold(mountEl);
  // export / import job progress → the watcher registered for its token (jobs.js)
  const offIo = atom().db.onIoProgress ? atom().db.onIoProgress((p) => { const cb = p && ioWatchers.get(p.token); if (cb) cb(p); }) : null;
  if (typeof offIo === "function") disposers.push(offIo);

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
    if (objList) { objList.dispose(); setObjList(null); }
    mountEl.innerHTML = "";
  };
  return { dispose, __internals: {
    tabs: () => tabs, AT, mkTab, tabsOf, openInTab, closeTab, switchTab, disposeTab, hasDraft, runQuery, stopRun, ensureSession, renderBrowse, renderStruct, drawConnForm, importDialog, insertRowDialog, addColumnDialog, addIndexDialog, reviewPlan,
    pendingCount, planOf, prunePlan, emptyPlan, searchWhere, combineWhere, connStatus, desired, setConnStatus, bumpGen, genOf, checkHealth, checkOne, noteFailure, disconnectConn, markLive, logPush, hLoad, hPush, hClear, hClearAll, pref, setPref,
    conns: () => conns, kinds: () => kinds, reloadConns: async () => { setConns(await atom().db.list()); renderSide(); }, side, wsHost, tabBar, ioWatchers, exportRows, resultBlock, startCellEdit, showValue, showRowDetail, loadSchema, getColumns, selectObject, openQuery, openBrowse, openStruct, setMode, queryTemplate, objMenu, connMenu, showWelcome, renderSide, renderTabBar, applyObjFilter, errBanner, syncSessionBadge,
  } };
}

/* Pure helpers for unit tests (no DOM state). */
export const __dbmUtils = { parseEdit, display, cellText, cellClass, cellTitle, isTag, isJsonish, prettyJson, toCSV, toJSON, toMD, toTSV, csvEsc, jsonVal, cmpVals, numOf, qIdent, qName, objRef, objName, sameObj, redisQuote, defaultQ, insertTemplate, vlist, vgrid, fmtInt, fmtNum, fmtBytes, b64hex, debounce, DB_COLORS, SCHEMA_KINDS };
