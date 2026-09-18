/* AtomNano renderer — Database Manager — the Query mode: per-tab backend session, statement editor, the captured RUN CONTEXT, one visible row per statement, Stop.
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { errBanner } from "./connections.js";
import { markLive, noteFailure } from "./health.js";
import { resultBlock } from "./results.js";
import { loadSchema } from "./sidebar.js";
import { atom, confirm, D, h, hClear, hClearAll, hLoad, hPush, icon, pref, setPref, toast } from "./state.js";
import { DB_PLACEHOLDER, errMsg, fmtInt, objName, uid } from "./utils.js";
import { buildWorkspace, logPush, renderTabBar, syncSessionBadge } from "./workspace.js";

/* ------------------------------ QUERY ------------------------------ */
// A tab's backend session (pinned client). Opened lazily, re-opened after it is gone.
export const ensureSession = async (tab) => {
  if (tab.session) return tab.session;
  const r = await atom().db.sessionOpen(tab.conn.id);
  tab.session = r.session; tab.sessionTx = false;
  if (tab.autocommit === false) await atom().db.sessionSet(tab.session, { autocommit: false }).catch(() => {});
  return tab.session;
};
export const buildQueryPanel = (tab) => {
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
export const stopRun = async (tab) => { const r = tab.run; if (!r || !r.currentOp) return; const res = await atom().db.cancel(r.currentOp).catch((e) => ({ ok: false, reason: errMsg(e) })); toast(res.ok ? "Cancel requested" : `Cannot cancel: ${res.reason || "not supported by this engine"}`, res.ok ? "check" : "alert"); };
/* Run the editor's statements. The RUN CONTEXT is captured here and used for every
 * statement; nothing is re-read from the tab afterwards. Each statement is a visible
 * row whose state advances; a failure stops the sequence but keeps earlier results. */
export const runQuery = async (tab, { explain } = {}) => {
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
