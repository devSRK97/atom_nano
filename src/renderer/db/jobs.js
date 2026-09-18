/* AtomNano renderer — Database Manager — export and import as main-process JOBS: progress by token, Cancel acknowledged by main, Close only hides, exact result counts.
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { renderBrowse } from "./browse.js";
import { copyText } from "./cells.js";
import { errBanner } from "./connections.js";
import { vgrid } from "./grid.js";
import { noteFailure } from "./health.js";
import { getColumns, loadSchema } from "./sidebar.js";
import { atom, confirm, D, h, icon, ioWatchers, toast } from "./state.js";
import { errMsg, fmtBytes, fmtInt, objName, objRef, sameObj, uid } from "./utils.js";
import { logPush } from "./workspace.js";

/* ---- jobs: export / import progress (main owns the job; Cancel is acknowledged) ---- */
export const ioToken = () => uid("io");
export const exportRows = async (tab, { format, scope, table, cols, rows, where, orderBy, dir, name }) => {
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
/* ============================================================
   IMPORT — a main-process JOB: picked → running → done | cancelled | failed.
   Cancel asks the job to stop (acknowledged, finishes after the current batch);
   Close only hides the dialog — the job continues and reports when it ends.
   Counts shown are exactly what the job reports: committed / failed / unattempted / unknown.
   ============================================================ */
export const importDialog = async (tab, it, { file, sheet } = {}) => {
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
