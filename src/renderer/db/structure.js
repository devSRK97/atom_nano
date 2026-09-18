/* AtomNano renderer — Database Manager — the Structure mode: columns · indexes · foreign keys · DDL, pending schema plans reviewed as exact steps, add column / add index.
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { copyText } from "./cells.js";
import { errBanner } from "./connections.js";
import { markLive, noteFailure } from "./health.js";
import { getColumns, loadSchema, selectObject } from "./sidebar.js";
import { atom, confirm, D, h, icon, kindOf, objNoun, toast } from "./state.js";
import { errMsg, fmtInt, objName, objRef, sameObj, SCHEMA_KINDS } from "./utils.js";
import { logPush } from "./workspace.js";

/* ============================================================
   STRUCTURE — columns / indexes / foreign keys / DDL. Renames, drops and reordering are
   collected as a PENDING PLAN per table (nothing is sent), reviewed as exact steps
   (schemaPlan dryRun) and applied as one plan with per-step outcomes.
   ============================================================ */
export const emptyPlan = () => ({ renames: new Map(), drops: new Set(), dropIndexes: new Set(), order: null, rev: null });
export const pendingCount = (P) => (P ? P.renames.size + P.drops.size + P.dropIndexes.size + (P.order ? 1 : 0) : 0);
export const planOf = (tab, it) => { const k = objName(it); if (!tab.pendingByTable.has(k)) tab.pendingByTable.set(k, emptyPlan()); const P = tab.pendingByTable.get(k); if (P.rev != null && P.rev !== tab.conn.rev) Object.assign(P, emptyPlan()); P.rev = tab.conn.rev; return P; };
export const planPayload = (P) => ({ renames: [...P.renames.entries()], drops: [...P.drops], dropIndexes: [...P.dropIndexes], order: P.order });
// Drop plan entries that no longer match the live table (after a refresh).
export const prunePlan = (P, info) => {
  const names = new Set(info.columns.map((c) => c.name)), ix = new Set(info.indexes.map((x) => x.name));
  for (const n of [...P.drops]) if (!names.has(n)) P.drops.delete(n);
  for (const n of [...P.renames.keys()]) if (!names.has(n)) P.renames.delete(n);
  for (const n of [...P.dropIndexes]) if (!ix.has(n)) P.dropIndexes.delete(n);
  if (P.order && (P.order.length !== names.size || P.order.some((n) => !names.has(n)))) P.order = null;
};
export const stepState = (s) => h("span", { class: "dbm-step-state " + (s.state || "planned"), text: s.state || "planned" });
export const stepsList = (steps) => h("div", { class: "dbm-steps" }, ...steps.map((s, i) => h("div", { class: "dbm-step " + (s.state || "planned") }, h("span", { class: "dbm-dim", text: `${i + 1}.` }), h("span", { class: "dbm-step-label", text: s.label }), stepState(s), h("code", { class: "dbm-step-sql", text: s.sql || "" }), s.error ? h("span", { class: "dbm-bad", text: s.error }) : null)));
export const reviewPlan = async (tab, it) => {
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
export const renderStruct = async (tab) => {
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
export const addColumnDialog = async (tab, it) => {
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
export const addIndexDialog = async (tab, it, info) => {
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
