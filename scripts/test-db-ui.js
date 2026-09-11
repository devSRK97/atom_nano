"use strict";
/* DB manager UI regression suite — DESIRED behaviour for the renderer findings of
 * ATOMNANO_DB_MANAGEMENT_AUDIT_2026-09-09 (checks DB-U01..U20 + extras), run against the
 * ORIGINAL renderer module (src/renderer/dbm.js), the real styles.css, the real SQL
 * splitter (src/main/sqlscript.js) and the real dialog helpers extracted from app.js, in a
 * blank headless Chromium page with fixture IPC.
 *
 * Never launches AtomNano, never reads its profile, never opens a database.
 * Run:  node scripts/test-db-ui.js */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const ts = require("typescript");
const { chromium } = require("playwright");

const app = fs.readFileSync(path.join(ROOT, "src/renderer/app.js"), "utf8");
const ast = ts.createSourceFile("app.js", app, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function fn(name) {
  let n = null;
  const visit = (x) => { if (n) return; if (ts.isFunctionDeclaration(x) && x.name && x.name.text === name) { n = x; return; } ts.forEachChild(x, visit); };
  visit(ast);
  if (!n) throw new Error("function not found: " + name);
  return n.getText(ast);
}
const dbm = fs.readFileSync(path.join(ROOT, "src/renderer/dbm.js"), "utf8").replace(/^export /mg, "");
const sqlscript = fs.readFileSync(path.join(ROOT, "src/main/sqlscript.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "src/renderer/styles.css"), "utf8");
const dialogs = ["closeModal", "openModal", "modalShell", "confirmDialog", "promptDialog", "chooseDialog"].map(fn).join("\n");

let pass = 0, failN = 0; const results = [];
function record(id, name, ok, evidence) { results.push({ id, name, ok: !!ok, evidence }); if (ok) pass++; else { failN++; console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 600) : ""}`); } }
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 300000);

async function main() {
  const browser = await chromium.launch({ headless: true });
  async function setup() {
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, reducedMotion: "reduce" });
    await page.route("**/*", (route) => route.abort());
    page.on("pageerror", (e) => { page._errors = (page._errors || []).concat(String(e && e.stack || e)); });
    await page.setContent('<!doctype html><html><body style="margin:0"><div id="dbmRoot" style="height:900px;width:1500px;display:flex"></div><div id="modalRoot"></div><div id="toast" class="toast hidden"></div></body></html>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: "(()=>{const module={exports:{}};" + sqlscript + "\nwindow.sqlscript=module.exports;})();" });
    await page.addScriptTag({ content: "window.auditH=(" + fn("h") + ");window.$=(id)=>document.getElementById(id);" });
    await page.addScriptTag({ content: "(()=>{const h=window.auditH,$=window.$,icon=()=>'';" + dialogs + "\nwindow.dialogs={closeModal,openModal,modalShell,confirmDialog,promptDialog,chooseDialog};})();" });
    await page.addScriptTag({ content: dbm + "\nwindow.dbm={mountDbManager,__dbmUtils};" });
    await page.evaluate(async () => {
      window.calls = []; window.notices = []; window.menus = [];
      const rec = (op, ...a) => { calls.push({ op, a }); };
      window.defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
      window.frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))));
      window.until = async (f, ms = 4000) => { const t0 = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("until: timeout"); await new Promise((r) => setTimeout(r, 15)); } };
      window.conns = [
        { id: "c1", kind: "sqlite", name: "Local", file: "x.db", rev: 1, hasPassword: false, hasUri: false, secretLocked: {}, policy: {} },
        { id: "c2", kind: "mysql", name: "Shop", host: "db", port: 3306, user: "u", database: "shop", rev: 3, hasPassword: true, hasUri: false, secretLocked: {}, policy: { blockDrop: true, protectedTables: ["users"] } },
      ];
      const P = ["blockDrop", "blockTruncate", "blockWrite", "blockDDL", "protectedTables"];
      const items = [{ name: "t", table: "t", schema: "", type: "table", rows: 1000000, rowsEstimated: true }, { name: "<img src=x onerror=window.__xss=1>", table: "<img src=x onerror=window.__xss=1>", schema: "", type: "table" }, { name: "v1", table: "v1", schema: "", type: "view" }];
      const cols = [{ name: "id", type: "INTEGER", nullable: false, key: "PRI", default: null, extra: "" }, { name: "v", type: "TEXT", nullable: true, key: "", default: null, extra: "" }];
      const sel = () => ({ columns: ["id", "v"], rows: [[1, "a"], [2, "b"]], rowCount: 2, hasMore: false, ms: 1, op: "select", first: "SELECT", session: { inTx: false } });
      window.deps = {
        h: window.auditH, icon: (nm, n = 14) => `<svg class="icon" data-icon="${nm}" width="${n}" height="${n}"></svg>`,
        toast: (text, kind, o) => { notices.push({ text: String(text), kind, o }); },
        showContextMenu: (x, y, its) => { menus.push(its); window.lastMenu = its; },
        chooseDialog: dialogs.chooseDialog, promptDialog: dialogs.promptDialog, modalShell: dialogs.modalShell, closeModal: dialogs.closeModal,
        atom: { db: {
          kinds: async () => [
            { id: "sqlite", name: "SQLite", pkg: "better-sqlite3", port: 0, fields: ["file"], installed: true, tls: false, types: [{ t: "INTEGER" }, { t: "TEXT" }, { t: "VARCHAR", len: true, dlen: 255 }, { t: "NUMERIC", prec: true }], policies: P, secureStorage: true, dbLabel: "Database" },
            { id: "mysql", name: "MySQL", pkg: "mysql2", port: 3306, fields: ["host", "port", "user", "password", "database"], installed: true, tls: true, types: [{ t: "INT" }, { t: "VARCHAR", len: true, dlen: 255 }, { t: "DECIMAL", prec: true }], policies: P, secureStorage: true, dbLabel: "Database" },
          ],
          list: async () => structuredClone(conns),
          save: async (c) => { rec("save", structuredClone(c)); const i = conns.findIndex((x) => x.id === c.id); const prev = i >= 0 ? conns[i] : null; const out = { ...c, id: c.id || "new1", rev: (prev ? prev.rev : 0) + 1, hasPassword: c.password && c.password.$keep ? !!(prev && prev.hasPassword) : !!c.password, hasUri: false, secretLocked: {} }; delete out.password; delete out.uri; if (i >= 0) conns[i] = out; else conns.push(out); return structuredClone(out); },
          remove: async (id) => { rec("remove", id); },
          revealSecret: async (id, f) => { rec("revealSecret", id, f); return { value: "pw" }; },
          setSessionSecret: async (id, f) => { rec("setSessionSecret", id, f); return { ok: true }; },
          test: async () => ({ ok: true, ms: 1 }),
          ping: (id) => { rec("ping", id); return window.pingImpl ? window.pingImpl(id) : Promise.resolve({ ok: true, ms: 1 }); },
          schema: async () => ({ items: structuredClone(items), tableCount: 2, viewCount: 1 }),
          schemaMore: async () => ({ items: [], cursor: "0", complete: true }),
          columns: async () => structuredClone(cols),
          query: (id, text, opts) => { rec("query", id, text, opts); return window.queryImpl ? window.queryImpl(id, text, opts) : Promise.resolve(sel()); },
          explain: async () => ({ columns: ["plan"], rows: [["SCAN t"]], ms: 1, op: "select" }),
          splitScript: async (id, text) => window.sqlscript.splitScript(text, "sqlite"),
          formatSql: async (id, text) => (window.fmtImpl ? window.fmtImpl(text) : window.sqlscript.formatSql(text, "sqlite")),
          sessionOpen: async (id) => { rec("sessionOpen", id); return { session: "s-" + id, kind: "sqlite" }; },
          sessionClose: async (sid, o) => { rec("sessionClose", sid, o); return { ok: true }; },
          sessionSet: async () => ({}),
          cancel: async (opId) => { rec("cancel", opId); return { ok: true }; },
          tableInfo: async () => ({ columns: structuredClone(cols), indexes: [{ name: "ix_v", unique: false, primary: false, columns: ["v"], type: "" }], foreignKeys: [], ddl: "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)", ddlNative: true, rows: null, object: { schema: "", table: "t", name: "t" } }),
          count: async () => ({ count: 42, exact: true, ms: 1 }),
          browse: (id, ref, opts) => { rec("browse", id, ref, opts); return window.browseImpl ? window.browseImpl(id, ref, opts) : Promise.resolve({ columns: ["id", "v"], rows: [[1, "a"], [2, "b"]], hasMore: true, ms: 1, offset: opts.offset || 0, limit: opts.limit, total: null, sql: 'SELECT * FROM "t" ORDER BY "id" LIMIT 201 OFFSET 0', stable: true, pk: ["id"] }); },
          insertRow: (id, ref, values, o) => { rec("insertRow", id, ref, values, o); return window.insertImpl ? window.insertImpl(values) : Promise.resolve({ ok: true, affected: 1, message: "Inserted" }); },
          updateRows: (id, ref, p, o) => { rec("updateRows", id, ref, p, o); return window.updateImpl ? window.updateImpl(p) : Promise.resolve({ ok: true, affected: 1, message: "1 row updated", row: { columns: ["id", "v"], values: [1, "SERVER"] } }); },
          deleteRows: async (id, ref, pks, o) => { rec("deleteRows", id, ref, pks, o); return { ok: true, affected: pks.length, message: "Deleted" }; },
          schemaPlan: (id, ref, plan, o) => { rec("schemaPlan", id, ref, structuredClone(plan), o); return window.planImpl ? window.planImpl(plan, o) : Promise.resolve(o && o.dryRun ? { ok: true, steps: [{ label: "rename v → vv", sql: 'ALTER TABLE "t" RENAME COLUMN "v" TO "vv"', state: "planned" }], notes: [], transactional: true } : { ok: true, steps: [{ label: "rename v → vv", sql: "…", state: "done" }], notes: [], transactional: true }); },
          addColumn: (id, ref, col, o) => { rec("addColumn", id, ref, structuredClone(col), o); return Promise.resolve(o && o.dryRun ? { ok: true, sql: `ALTER TABLE "t" ADD COLUMN "${col.name}" ${col.type}${col.length ? "(" + col.length + ")" : ""}`, transactional: true } : { ok: true, message: "added", steps: [] }); },
          addIndex: async () => ({ ok: true, message: "Index created", sql: "CREATE INDEX …" }),
          dropIndex: async () => ({ ok: true }), renameColumn: async () => ({ ok: true }), dropColumn: async () => ({ ok: true }), reorderColumns: async () => ({ ok: true, sql: "" }),
          exportFile: (o) => { rec("exportFile", o); return window.exportImpl ? window.exportImpl(o) : Promise.resolve({ ok: true, state: "done", path: "C:\\tmp\\out.csv", rows: 2, complete: true }); },
          exportCancel: async (t) => { rec("exportCancel", t); return { ok: true, acknowledged: true }; },
          importPick: (o) => { rec("importPick", o); return window.pickImpl ? window.pickImpl(o) : Promise.resolve({ ok: true, token: "imp1", type: "table", file: "C:\\tmp\\rows.csv", size: 10, total: 3, width: 2, looksHeader: true, sample: [["id", "v"], ["1", "a"], ["2", "b"]] }); },
          importRun: (o) => { rec("importRun", o); return window.runImpl ? window.runImpl(o) : Promise.resolve({ ok: true, state: "done", total: 2, attempted: 2, committed: 2, failed: 0, unattempted: 0, unknown: 0, atomic: false, errors: [], totalErrors: 0, ms: 3 }); },
          importCancel: async (t) => { rec("importCancel", t); return { ok: true, acknowledged: true }; },
          importDiscard: async (t) => { rec("importDiscard", t); return { ok: true, existed: true }; },
          jobStatus: async () => null, jobs: async () => [],
          installDriver: async () => ({ ok: true }),
          disconnect: async (id) => { rec("disconnect", id); return { ok: true }; },
          onIoProgress: (cb) => { window.ioCb = cb; return () => { window.ioCb = null; }; },
        } },
      };
      window.mount = await dbm.mountDbManager(document.getElementById("dbmRoot"), deps);
      window.I = mount.__internals;
      window.openConn = async (id) => { I.openInTab(conns.find((c) => c.id === id)); await until(() => I.AT().schema); await frame(); return I.AT(); };
      window.setEditor = (text) => { const t = I.AT(); t._ed.value = text; t._ed.dispatchEvent(new Event("input")); };
      window.qcalls = () => calls.filter((c) => c.op === "query");
    });
    return page;
  }
  async function check(id, name, run) {
    const page = await setup();
    try { const r = await run(page); const errs = page._errors || []; record(id, name, r && r.ok && !errs.length, errs.length ? { pageErrors: errs, ...(r && r.evidence) } : r && r.evidence); }
    catch (e) { record(id, name, false, { harnessError: (e && e.stack) || String(e), pageErrors: page._errors }); }
    finally { await page.close(); }
  }

  await check("U01", "Format never rewrites literals/comments; unparsable SQL is left untouched", (p) => p.evaluate(async () => {
    await openConn("c1");
    const src = "select a,'x  y' -- keep\nfrom t";
    setEditor(src);
    const fmtBtn = [...document.querySelectorAll(".dbm-ed-bar button")].find((b) => /Format/.test(b.textContent)); fmtBtn.click(); await until(() => I.AT()._ed.value !== src);
    const formatted = I.AT()._ed.value;
    window.fmtImpl = () => ({ ok: false, error: "Unterminated string literal", text: "select 'open" });
    setEditor("select 'open"); fmtBtn.click(); await new Promise((r) => setTimeout(r, 60));
    return { ok: formatted.includes("'x  y'") && formatted.includes("-- keep") && /SELECT/.test(formatted) && I.AT()._ed.value === "select 'open" && notices.some((n) => /Not formatted/.test(n.text)), evidence: { formatted, after: I.AT()._ed.value } };
  }));

  await check("U02", "Splitting is the shared parser: a parse error refuses the whole run (nothing sent)", (p) => p.evaluate(async () => {
    await openConn("c1");
    setEditor("INSERT INTO t VALUES ('a;b'); SELECT 'abc");
    await I.runQuery(I.AT());
    const err = document.querySelector(".dbm-results .dbm-err");
    const ok1 = qcalls().length === 0 && err && /Script not run/.test(err.textContent);
    setEditor("INSERT INTO t VALUES ('a;b'); SELECT 1;");
    await I.runQuery(I.AT());
    const sent = qcalls().map((c) => c.a[1]);
    return { ok: ok1 && sent.length === 2 && sent[0] === "INSERT INTO t VALUES ('a;b')" && sent[1] === "SELECT 1", evidence: { sent, err: err && err.textContent } };
  }));

  await check("U19", "Statement rows advance queued → running → done; Stop cancels the running op id", (p) => p.evaluate(async () => {
    await openConn("c1");
    const gate = defer();
    window.queryImpl = (id, text, opts) => (/SLOW/.test(text) ? gate.promise : Promise.resolve({ columns: ["n"], rows: [[1]], rowCount: 1, hasMore: false, ms: 1, op: "select", first: "SELECT", session: { inTx: false } }));
    setEditor("SELECT 1; SELECT SLOW; SELECT 3;");
    const run = I.runQuery(I.AT());
    await until(() => document.querySelectorAll(".dbm-stmt-label").length === 3 && document.querySelector(".dbm-stmt-label.running"));
    const states1 = [...document.querySelectorAll(".dbm-stmt-label")].map((l) => l.className.replace("dbm-stmt-label ", ""));
    const stop = document.querySelector(".dbm-stop-btn");
    const stopVisible = stop && stop.style.display !== "none";
    stop.click(); await until(() => calls.some((c) => c.op === "cancel"));
    const opId = qcalls().find((c) => /SLOW/.test(c.a[1])).a[2].opId;
    const cancelledId = calls.find((c) => c.op === "cancel").a[0];
    gate.resolve({ columns: ["n"], rows: [[2]], rowCount: 1, hasMore: false, ms: 5, op: "select", first: "SELECT", session: { inTx: false } });
    await run;
    const states2 = [...document.querySelectorAll(".dbm-stmt-label")].map((l) => l.className.replace("dbm-stmt-label ", ""));
    return { ok: states1.join() === "done,running,queued" && stopVisible && opId && cancelledId === opId && states2.join() === "done,done,done" && document.querySelectorAll(".dbm-result-block").length === 3 && /3 of 3 statements ran/.test(document.querySelector(".dbm-statusbar").textContent), evidence: { states1, states2, opId, cancelledId } };
  }));

  await check("U08", "A later failure keeps the earlier results and marks the rest not run", (p) => p.evaluate(async () => {
    await openConn("c1");
    window.queryImpl = (id, text) => (/BOOM/.test(text) ? Promise.reject(Object.assign(new Error("no such table: nope"), { type: "db" })) : Promise.resolve({ columns: ["n"], rows: [[1]], rowCount: 1, hasMore: false, ms: 1, op: "select", first: "SELECT", session: { inTx: false } }));
    setEditor("SELECT 1; SELECT BOOM; SELECT 3;");
    await I.runQuery(I.AT());
    const states = [...document.querySelectorAll(".dbm-stmt-label")].map((l) => l.className.replace("dbm-stmt-label ", ""));
    const st = document.querySelector(".dbm-statusbar").textContent;
    return { ok: states.join() === "done,failed,not-run" && document.querySelectorAll(".dbm-result-block").length === 1 && document.querySelector(".dbm-stmt-body .dbm-err") && /1 of 3/.test(st) && /1 failed/.test(st) && /1 not run/.test(st) && qcalls().length === 2, evidence: { states, st } };
  }));

  await check("U20", "Unknown outcome is its own state (never 'failed'), in the block and the log", (p) => p.evaluate(async () => {
    await openConn("c1");
    window.queryImpl = () => Promise.reject(Object.assign(new Error("The connection was lost while “update” was running. Its outcome is UNKNOWN"), { type: "outcome-unknown" }));
    setEditor("UPDATE t SET v = 1");
    await I.runQuery(I.AT());
    const label = document.querySelector(".dbm-stmt-label");
    const banner = document.querySelector(".dbm-err.dbm-unknown");
    const log = I.AT().log[0];
    return { ok: label.classList.contains("unknown") && banner && /Do not re-run blindly/.test(banner.textContent) && log.state === "unknown" && /UNKNOWN outcome/.test(document.querySelector(".dbm-statusbar").textContent) && document.querySelector(".dbm-log-row.unknown"), evidence: { cls: label.className, log } };
  }));

  await check("U07", "A busy tab closed mid-run keeps its run context; remaining statements are not sent anywhere", (p) => p.evaluate(async () => {
    await openConn("c1");
    const oldTab = I.AT();
    const gate = defer();
    window.queryImpl = (id, text) => (/SLOW/.test(text) ? gate.promise : Promise.resolve({ columns: ["n"], rows: [[1]], rowCount: 1, hasMore: false, ms: 1, op: "select", first: "SELECT", session: { inTx: false } }));
    setEditor("SELECT SLOW; SELECT 2;");
    const run = I.runQuery(oldTab);
    await until(() => document.querySelector(".dbm-stmt-label.running"));
    window.chooseAnswerAuto = true;
    const closing = I.closeTab(oldTab.id);
    await until(() => document.querySelector(".modal-backdrop"));
    [...document.querySelectorAll(".modal-foot .btn")].find((b) => /Close tab/.test(b.textContent)).click();
    await closing;
    const newTab = I.AT();
    I.openInTab(conns[1]);                                   // the user moves on to ANOTHER connection
    await until(() => I.AT().conn && I.AT().conn.id === "c2");
    gate.resolve({ columns: ["n"], rows: [[9]], rowCount: 1, hasMore: false, ms: 1, op: "select", first: "SELECT", session: { inTx: false } });
    await run;
    const sent = qcalls().map((c) => ({ id: c.a[0], sql: c.a[1] }));
    return { ok: newTab.id !== oldTab.id && oldTab.run === null && sent.length === 1 && sent[0].id === "c1" && /SLOW/.test(sent[0].sql) && !I.tabs().includes(oldTab) && calls.some((c) => c.op === "sessionClose" && c.a[0] === "s-c1" && c.a[1].rollback === true), evidence: { sent, tabs: I.tabs().map((t) => t.id), old: oldTab.id } };
  }));

  await check("U12", "Dismissing the shared confirm dialog (×) resolves to 'no' — the busy tab stays", (p) => p.evaluate(async () => {
    await openConn("c1");
    const t = I.AT(); t.busy = true;
    const closing = I.closeTab(t.id);
    await until(() => document.querySelector(".modal-backdrop"));
    document.querySelector(".mh-close").click();
    let settled = false; closing.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    const stillThere = I.tabs().some((x) => x.id === t.id);
    t.busy = false;
    return { ok: settled && stillThere && !document.querySelector(".modal-backdrop"), evidence: { settled, stillThere } };
  }));

  await check("U13", "Escape/backdrop dismissal of a choice dialog resolves null (draft tab kept)", (p) => p.evaluate(async () => {
    await openConn("c1");
    const t = I.AT(); setEditor("SELECT draft");
    const closing = I.closeTab(t.id);
    await until(() => document.querySelector(".modal-backdrop"));
    const back = document.querySelector(".modal-backdrop");
    back.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    let settled = false; closing.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    return { ok: settled && I.tabs().some((x) => x.id === t.id) && I.AT()._draft === "SELECT draft", evidence: { settled } };
  }));

  await check("U04", "Paging: Next follows the returned page (hasMore), estimates are advisory with ~, total only when exact", (p) => p.evaluate(async () => {
    const tab = await openConn("c1");
    I.selectObject(tab, tab.schema.items[0]); I.openBrowse(tab);
    await until(() => document.querySelector(".dbm-browse-panel .dbm-result-block")); await frame();
    const next = document.querySelector('.dbm-pg[aria-label="Next page"]'), last = document.querySelector('.dbm-pg[aria-label="Last page"]');
    const info1 = document.querySelector(".dbm-page-info").textContent, of1 = document.querySelector(".dbm-page-of").textContent;
    const r1 = { next: !next.disabled, last: last.disabled, info: info1, of: of1 };
    // a stale estimate says a million rows, but the page says there is nothing more → Next disabled
    window.browseImpl = (id, ref, opts) => Promise.resolve({ columns: ["id", "v"], rows: [[1, "a"]], hasMore: false, ms: 1, offset: opts.offset || 0, limit: opts.limit, total: null, sql: "", stable: true, pk: ["id"] });
    next.click();
    await until(() => calls.filter((c) => c.op === "browse").length >= 2); await until(() => document.querySelector('.dbm-pg[aria-label="Next page"]').disabled); await frame();
    const r2 = { offset: calls.filter((c) => c.op === "browse").at(-1).a[2].offset, next: !document.querySelector('.dbm-pg[aria-label="Next page"]').disabled, info: document.querySelector(".dbm-page-info").textContent };
    // exact count unlocks Last and a real total
    [...document.querySelectorAll(".dbm-browse-bar button")].find((b) => /Count/.test(b.textContent)).click();
    await until(() => /of 42/.test(document.querySelector(".dbm-page-info").textContent)); await frame();
    const r3 = { last: document.querySelector('.dbm-pg[aria-label="Last page"]').disabled, of: document.querySelector(".dbm-page-of").textContent };
    // back to the first page: with an exact total of 42 there is exactly one page, so Last is reachable but already current
    document.querySelector('.dbm-pg[aria-label="First page"]').click();
    await until(() => calls.filter((c) => c.op === "browse").length >= 3); await frame();
    const r4 = { offset: calls.filter((c) => c.op === "browse").at(-1).a[2].offset, of: document.querySelector(".dbm-page-of").textContent, info: document.querySelector(".dbm-page-info").textContent };
    return { ok: true, evidence: { r1, r2, r3, r4 } };
  }).then((r) => ({ ok: r.evidence.r1.next === true && r.evidence.r1.last === true && /~1,000,000/.test(r.evidence.r1.info) && /estimate/.test(r.evidence.r1.of) && r.evidence.r2.offset === 200 && r.evidence.r2.next === false && r.evidence.r3.last === true && /^of 1$/.test(r.evidence.r3.of) && r.evidence.r4.offset === 0 && /^of 1$/.test(r.evidence.r4.of) && !/~/.test(r.evidence.r4.info), evidence: r.evidence })));

  await check("U05", "Cell edit shows the SERVER's persisted value; a no-match keeps the original and re-reads the page", (p) => p.evaluate(async () => {
    const tab = await openConn("c1");
    I.selectObject(tab, tab.schema.items[0]); I.openBrowse(tab);
    await until(() => document.querySelector(".dbm-browse-panel .dbm-vrow")); await frame();
    const blk = document.querySelector(".dbm-browse-panel .dbm-result-block");
    const cell = () => document.querySelector('.dbm-browse-panel .dbm-vrow[data-ri="0"]').children[2];
    I.startCellEdit(blk._grid, cell(), 0, 1, async (ri, ci, v) => { await blk._grid; });
    const inp = document.querySelector(".dbm-cell-edit"); inp.value = "typed"; inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await frame();
    const afterEsc = cell().textContent;                       // editor without a server round-trip → original stays
    // real flow through the browse panel's onEdit: double-click → Enter
    cell().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const inp2 = await until(() => document.querySelector(".dbm-cell-edit")); inp2.value = "typed"; inp2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => calls.some((c) => c.op === "updateRows")); await frame(); await frame();
    const serverShown = cell().textContent;
    const upd = calls.find((c) => c.op === "updateRows");
    // now a conflict: the row vanished
    window.updateImpl = () => Promise.reject(Object.assign(new Error("No row matches this key any more"), { type: "not-found" }));
    const browses = calls.filter((c) => c.op === "browse").length;
    cell().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const inp3 = await until(() => document.querySelector(".dbm-cell-edit")); inp3.value = "again"; inp3.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => calls.filter((c) => c.op === "browse").length > browses); await frame();
    return { ok: afterEsc === "a" && serverShown === "SERVER" && upd.a[2].pk.id === 1 && upd.a[2].set.v === "typed" && upd.a[3].expectRev === 1 && notices.some((n) => /Not saved — the row changed/.test(n.text)), evidence: { afterEsc, serverShown, upd: upd && upd.a } };
  }));

  await check("U06", "Insert dialog sends exactly one insert for a double click", (p) => p.evaluate(async () => {
    const tab = await openConn("c1");
    I.selectObject(tab, tab.schema.items[0]);
    const gate = defer(); window.insertImpl = () => gate.promise;
    I.insertRowDialog(tab);
    const inp = await until(() => document.querySelector('.dbm-ins-form input[aria-label="v"]')); inp.value = "hello"; inp.dispatchEvent(new Event("input"));
    const btn = [...document.querySelectorAll(".modal-foot .btn")].find((b) => b.textContent === "Insert");
    btn.click(); btn.click(); btn.click();
    await new Promise((r) => setTimeout(r, 30));
    const n = calls.filter((c) => c.op === "insertRow").length;
    gate.resolve({ ok: true, affected: 1, message: "Inserted" });
    await until(() => !document.querySelector(".modal-backdrop"));
    return { ok: n === 1 && calls.find((c) => c.op === "insertRow").a[2].v === "hello" && calls.find((c) => c.op === "insertRow").a[3].expectRev === 1, evidence: { n } };
  }));

  await check("U09", "Cancelling a connection edit changes nothing (the form edits a deep copy)", (p) => p.evaluate(async () => {
    await openConn("c2");
    I.drawConnForm(conns[1]);
    await until(() => document.querySelector(".dbm-form-ws"));
    document.querySelector(".dbm-policy-section").open = true;
    const cbs = [...document.querySelectorAll(".dbm-policy-row input")];
    cbs[0].checked = false; cbs[0].dispatchEvent(new Event("change"));
    const nameIn = document.querySelector('.dbm-form-fields input[aria-label="Name"]'); nameIn.value = "Renamed"; nameIn.dispatchEvent(new Event("input"));
    [...document.querySelectorAll(".dbm-form-actions .btn")].find((b) => b.textContent === "Cancel").click();
    await frame();
    return { ok: !calls.some((c) => c.op === "save") && conns[1].policy.blockDrop === true && conns[1].name === "Shop" && I.AT().conn.policy.blockDrop === true && !document.querySelector(".dbm-form-ws"), evidence: { policy: conns[1].policy, name: conns[1].name } };
  }));

  await check("S01", "Saving without touching the password sends $keep; clearing sends an empty string", (p) => p.evaluate(async () => {
    await openConn("c2");
    I.drawConnForm(conns[1]);
    await until(() => document.querySelector(".dbm-form-ws"));
    const pw = document.querySelector('.dbm-form-fields input[type="password"]');
    const keepPlaceholder = pw.placeholder;
    [...document.querySelectorAll(".dbm-form-actions .btn")].find((b) => /^Save/.test(b.textContent)).click();
    await until(() => calls.some((c) => c.op === "save"));
    const first = calls.find((c) => c.op === "save").a[0];
    await until(() => !document.querySelector(".dbm-form-ws"));
    I.drawConnForm(conns[1]);
    await until(() => document.querySelector(".dbm-form-ws"));
    document.querySelector('.dbm-secret-acts button[aria-label="Clear saved password"]').click();
    [...document.querySelectorAll(".dbm-form-actions .btn")].find((b) => /^Save/.test(b.textContent)).click();
    await until(() => calls.filter((c) => c.op === "save").length === 2);
    const second = calls.filter((c) => c.op === "save")[1].a[0];
    return { ok: /saved/.test(keepPlaceholder) && first.password && first.password.$keep === true && !("hasPassword" in first) && second.password === "" && first.rev === 3 && second.rev === 4, evidence: { first: first.password, second: second.password, keepPlaceholder } };
  }));

  await check("U11", "Health: a late ping result never resurrects a disconnected connection; auth errors are 'error', not 'reconnecting'", (p) => p.evaluate(async () => {
    await openConn("c1");
    const c = conns[0];
    I.desired.set("c1", "on"); I.setConnStatus("c1", "live");
    const gate = defer(); window.pingImpl = () => gate.promise;
    const health = I.checkOne(c, true);
    await I.disconnectConn(c);
    const offBefore = I.connStatus.get("c1");
    gate.resolve({ ok: true, ms: 1 });
    await health;
    const afterLate = I.connStatus.get("c1");
    I.desired.set("c1", "on"); I.setConnStatus("c1", "live");
    window.pingImpl = () => Promise.resolve({ ok: false, detail: "Access denied for user", type: "auth" });
    await I.checkOne(c, true);
    const auth = I.connStatus.get("c1");
    I.setConnStatus("c1", "live");
    window.pingImpl = () => Promise.resolve({ ok: false, detail: "ECONNREFUSED", type: "transport" });
    await I.checkOne(c, true);
    const transport = I.connStatus.get("c1");
    return { ok: offBefore === "off" && afterLate === "off" && auth === "error" && transport === "reconnecting", evidence: { offBefore, afterLate, auth, transport } };
  }));

  await check("U14", "Structure: renames/drops collect in a pending plan; review calls the exact dry run", (p) => p.evaluate(async () => {
    const tab = await openConn("c1");
    I.selectObject(tab, tab.schema.items[0]); I.openStruct(tab);
    await until(() => document.querySelector(".dbm-struct-panel .dbm-grid tbody tr"));
    window.promptAnswer = "vv";
    const origPrompt = deps.promptDialog; deps.promptDialog = async () => "vv";
    document.querySelector('.dbm-struct-panel button[aria-label="Rename v"]').click();
    await until(() => document.querySelector(".dbm-row-renamed"));
    document.querySelector('.dbm-struct-panel button[aria-label="Drop id"]').click();
    await until(() => document.querySelector(".dbm-row-dropped"));
    const P = I.planOf(tab, tab.cur);
    const pendText = document.querySelector(".dbm-pending-text").textContent;
    const noDdlSent = !calls.some((c) => /schemaPlan|renameColumn|dropColumn/.test(c.op));
    [...document.querySelectorAll(".dbm-pending button")].find((b) => /Review/.test(b.textContent)).click();
    await until(() => calls.some((c) => c.op === "schemaPlan"));
    const dry = calls.find((c) => c.op === "schemaPlan");
    await until(() => document.querySelector(".dbm-steps .dbm-step"));
    deps.promptDialog = origPrompt;
    return { ok: I.pendingCount(P) === 2 && /2 pending/.test(pendText) && noDdlSent && dry.a[2].renames[0].join() === "v,vv" && dry.a[2].drops.join() === "id" && dry.a[3].dryRun === true && dry.a[3].expectRev === 1 && document.querySelector(".dbm-step-state").textContent === "planned", evidence: { pendText, plan: dry.a[2] } };
  }));

  await check("U15", "Structure: a failed plan keeps its steps' outcomes and the pending plan; success clears it", (p) => p.evaluate(async () => {
    const tab = await openConn("c1");
    I.selectObject(tab, tab.schema.items[0]); I.openStruct(tab);
    await until(() => document.querySelector(".dbm-struct-panel .dbm-grid tbody tr"));
    deps.promptDialog = async () => "vv";
    document.querySelector('.dbm-struct-panel button[aria-label="Rename v"]').click();
    await until(() => document.querySelector(".dbm-row-renamed"));
    window.planImpl = (plan, o) => Promise.resolve(o && o.dryRun ? { ok: true, steps: [{ label: "rename v → vv", sql: "ALTER …", state: "planned" }], notes: [], transactional: false } : { ok: false, transactional: false, error: "duplicate column", steps: [{ label: "rename v → vv", sql: "ALTER …", state: "failed", error: "duplicate column" }], notes: [] });
    [...document.querySelectorAll(".dbm-pending button")].find((b) => /Review/.test(b.textContent)).click();
    await until(() => document.querySelector(".modal-foot .btn-primary:not([disabled])"));
    document.querySelector(".modal-foot .btn-primary").click();
    await until(() => document.querySelector(".dbm-step-state.failed"));
    const failedShown = document.querySelector(".dbm-imp-state.failed") && document.querySelector(".dbm-step-state.failed");
    const stillPending = I.pendingCount(I.planOf(tab, tab.cur)) === 1;
    dialogs.closeModal(document.querySelector(".modal-backdrop"));
    window.planImpl = null;
    await until(() => document.querySelector(".dbm-pending button"));
    [...document.querySelectorAll(".dbm-pending button")].find((b) => /Review/.test(b.textContent)).click();
    await until(() => document.querySelector(".modal-foot .btn-primary:not([disabled])"));
    document.querySelector(".modal-foot .btn-primary").click();
    await until(() => document.querySelector(".dbm-imp-state.done"));
    await until(() => I.pendingCount(I.planOf(tab, tab.cur)) === 0);
    await until(() => document.querySelector(".dbm-pending") && document.querySelector(".dbm-pending").style.display === "none");
    return { ok: !!failedShown && stillPending && I.pendingCount(I.planOf(tab, tab.cur)) === 0 && notices.some((n) => /applied/.test(n.text)), evidence: { stillPending } };
  }));

  await check("U16", "Add column: changing the type clears parameters that do not apply; preview is the server's dry run", (p) => p.evaluate(async () => {
    const tab = await openConn("c1");
    I.selectObject(tab, tab.schema.items[0]);
    I.addColumnDialog(tab, tab.cur);
    const nameIn = await until(() => document.querySelector('.dbm-ac-form input[aria-label="Name"]'));
    nameIn.value = "c2"; nameIn.dispatchEvent(new Event("input"));
    const typeSel = document.querySelector('.dbm-ac-form select[aria-label="Type"]');
    typeSel.value = "VARCHAR"; typeSel.dispatchEvent(new Event("change"));
    const lenIn = document.querySelector('.dbm-ac-form input[aria-label="Length"]');
    await until(() => calls.some((c) => c.op === "addColumn" && c.a[2].type === "VARCHAR"));
    const lenShown = lenIn.closest("label").style.display !== "none" && lenIn.value === "255";
    typeSel.value = "INTEGER"; typeSel.dispatchEvent(new Event("change"));
    await until(() => calls.some((c) => c.op === "addColumn" && c.a[2].type === "INTEGER"));
    const last = calls.filter((c) => c.op === "addColumn").at(-1).a;
    await until(() => /INTEGER/.test(document.querySelector(".dbm-ac-preview").textContent));
    const preview = document.querySelector(".dbm-ac-preview").textContent;
    return { ok: lenShown && lenIn.closest("label").style.display === "none" && last[2].length === "" && last[3].dryRun === true && last[3].expectRev === 1 && preview === 'ALTER TABLE "t" ADD COLUMN "c2" INTEGER', evidence: { last: last[2], preview } };
  }));

  await check("U17", "Database-controlled names are rendered as text, never as markup", (p) => p.evaluate(async () => {
    const tab = await openConn("c1");
    const evil = tab.schema.items[1];
    I.selectObject(tab, evil); I.openBrowse(tab);
    await until(() => document.querySelector(".dbm-browse-name")); await frame();
    const side = [...document.querySelectorAll(".dbm-obj-name")].some((el) => el.textContent.includes("<img src=x"));
    return { ok: side && document.querySelector(".dbm-browse-name").textContent.includes("<img src=x") && !document.querySelector("img") && !window.__xss && document.querySelector(".dbm-cur-badge").textContent.includes("<img"), evidence: { side } };
  }));

  await check("U18", "Result grid is an accessible grid: roles, one roving tab stop, arrow-key focus, header sort state", (p) => p.evaluate(async () => {
    await openConn("c1");
    setEditor("SELECT 1");
    await I.runQuery(I.AT()); await frame();
    const grid = document.querySelector(".dbm-vgrid");
    const roles = { grid: grid.getAttribute("role"), header: grid.querySelector(".dbm-vgrid-head").getAttribute("role"), colh: grid.querySelector(".dbm-vgrid-hcell:not(.rn)").getAttribute("role"), row: grid.querySelector(".dbm-vrow").getAttribute("role"), cell: grid.querySelector(".dbm-vcell:not(.rn)").getAttribute("role") };
    const stops = grid.querySelectorAll('[tabindex="0"]').length;
    grid.querySelector('[tabindex="0"]').focus();
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await frame();
    const focused = document.activeElement;
    const sortBefore = grid.querySelector(".dbm-vgrid-hcell:not(.rn)").getAttribute("aria-sort");
    grid.querySelector(".dbm-vgrid-hcell:not(.rn)").click(); await frame();
    const sortAfter = grid.querySelector(".dbm-vgrid-hcell:not(.rn)").getAttribute("aria-sort");
    return { ok: roles.grid === "grid" && roles.header === "row" && roles.colh === "columnheader" && roles.row === "row" && roles.cell === "gridcell" && stops === 1 && focused && focused.classList.contains("dbm-vcell") && focused.getAttribute("aria-colindex") === "2" && focused.closest(".dbm-vrow").dataset.ri === "1" && sortBefore === "none" && sortAfter === "ascending" && grid.getAttribute("aria-rowcount") === "3", evidence: { roles, stops, focused: focused && focused.outerHTML.slice(0, 120), sortBefore, sortAfter } };
  }));

  await check("U10", "Closing a tab with a draft asks first; dispose releases every listener and the DOM", (p) => p.evaluate(async () => {
    await openConn("c1");
    const t = I.AT(); setEditor("SELECT draft");
    const closing = I.closeTab(t.id);
    await until(() => document.querySelector(".modal-backdrop"));
    const asked = /unsaved query draft/.test(document.querySelector(".modal-body").textContent);
    [...document.querySelectorAll(".modal-foot .btn")].find((b) => /Discard & close/.test(b.textContent)).click();
    await closing;
    const fresh = I.AT();
    const freshIsNew = fresh.id !== t.id && fresh._draft === "" && fresh.conn === null;
    const sessionsClosed = calls.some((c) => c.op === "sessionClose");
    await mount.dispose();
    const gone = document.getElementById("dbmRoot").children.length === 0;
    calls.length = 0;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    return { ok: asked && freshIsNew && gone && calls.length === 0 && window.ioCb === null, evidence: { asked, freshIsNew, gone, sessionsClosed } };
  }));

  await check("I01", "Import dialog: Cancel asks the job to stop; Close only hides and the outcome still arrives", (p) => p.evaluate(async () => {
    const tab = await openConn("c1");
    I.selectObject(tab, tab.schema.items[0]);
    const gate = defer(); window.runImpl = () => gate.promise;
    I.importDialog(tab, tab.cur);
    await until(() => document.querySelector(".dbm-imp-map select"));
    const mapped = [...document.querySelectorAll(".dbm-imp-map select")].map((s) => s.value);
    [...document.querySelectorAll(".modal-foot .btn")].find((b) => b.textContent === "Import").click();
    await until(() => calls.some((c) => c.op === "importRun"));
    const run = calls.find((c) => c.op === "importRun").a[0];
    if (window.ioCb) window.ioCb({ token: "imp1", phase: "run", state: "running", done: 1, total: 2, committed: 1, message: "1 / 2 rows" });
    const progressText = document.querySelector(".dbm-prog-text").textContent;
    const cancelBtn = [...document.querySelectorAll(".modal-foot .btn")].find((b) => /Cancel import/.test(b.textContent));
    cancelBtn.click(); await until(() => calls.some((c) => c.op === "importCancel"));
    const closeBtn = [...document.querySelectorAll(".modal-foot .btn")].find((b) => /Close/.test(b.textContent)); closeBtn.click();
    await until(() => !document.querySelector(".modal-backdrop"));
    const discarded = calls.some((c) => c.op === "importDiscard");
    gate.resolve({ ok: false, state: "cancelled", total: 2, attempted: 1, committed: 1, failed: 0, unattempted: 1, unknown: 0, atomic: false, errors: [], totalErrors: 0, ms: 9 });
    await until(() => notices.some((n) => /Import cancelled/.test(n.text)));
    return { ok: mapped.join() === "id,v" && run.token === "imp1" && run.mapping[0] === "id" && run.hasHeader === true && /1 \/ 2 rows/.test(progressText) && !discarded && calls.some((c) => c.op === "importCancel" && c.a[0] === "imp1") && notices.some((n) => /Import cancelled: 1 rows committed/.test(n.text)), evidence: { mapped, run, progressText, discarded } };
  }));

  await check("I02", "Import dialog closed before running discards the preview; counts are rendered from the result", (p) => p.evaluate(async () => {
    const tab = await openConn("c1");
    I.selectObject(tab, tab.schema.items[0]);
    I.importDialog(tab, tab.cur);
    await until(() => document.querySelector(".dbm-imp-map select"));
    dialogs.closeModal(document.querySelector(".modal-backdrop"));
    await until(() => calls.some((c) => c.op === "importDiscard" && c.a[0] === "imp1"));
    window.runImpl = () => Promise.resolve({ ok: false, state: "failed", total: 10, attempted: 6, committed: 3, failed: 3, unattempted: 4, unknown: 2, atomic: false, errors: [{ at: 4, rows: 1, error: "NOT NULL constraint failed", type: "db" }], totalErrors: 3, ms: 12 });
    I.importDialog(tab, tab.cur);
    await until(() => document.querySelector(".dbm-imp-map select"));
    [...document.querySelectorAll(".modal-foot .btn")].find((b) => b.textContent === "Import").click();
    await until(() => document.querySelector(".dbm-imp-state"));
    const stats = [...document.querySelectorAll(".dbm-imp-stat")].map((s) => s.textContent.replace(/\s+/g, " "));
    return { ok: document.querySelector(".dbm-imp-state").textContent === "Failed" && stats.join("|") === "committed3|failed3|unattempted4|unknown outcome2" && document.querySelector(".dbm-imp-errors").style.display !== "none" && /UNKNOWN outcome/.test(document.querySelector(".dbm-imp-summary").textContent), evidence: { stats } };
  }));

  await check("E01", "Export ALL runs as a job with Cancel; SQL export for a query asks for a target table", (p) => p.evaluate(async () => {
    const tab = await openConn("c1");
    I.selectObject(tab, tab.schema.items[0]); I.openBrowse(tab);
    await until(() => document.querySelector(".dbm-browse-panel .dbm-result-block")); await frame();
    const gate = defer(); window.exportImpl = () => gate.promise;
    document.querySelector(".dbm-browse-panel .dbm-export-btn").click();
    const all = lastMenu.find((m) => /Export ALL rows as CSV/.test(m.label)); all.onClick();
    await until(() => calls.some((c) => c.op === "exportFile"));
    const req = calls.find((c) => c.op === "exportFile").a[0];
    await until(() => document.querySelector(".modal-backdrop"));
    [...document.querySelectorAll(".modal-foot .btn")].find((b) => /Cancel export/.test(b.textContent)).click();
    await until(() => calls.some((c) => c.op === "exportCancel"));
    gate.resolve({ ok: false, state: "cancelled", path: "C:\\tmp\\t.partial.csv", rows: 5000, complete: false });
    await until(() => notices.some((n) => /Export cancelled/.test(n.text)));
    // query result → SQL export needs a target
    I.openQuery(tab); setEditor("SELECT 1"); await I.runQuery(tab); await frame();
    deps.promptDialog = async () => "public.target";
    window.exportImpl = () => Promise.resolve({ ok: true, state: "done", path: "C:\\tmp\\q.sql", rows: 1, complete: true });
    document.querySelector(".dbm-query-panel .dbm-export-btn").click();
    lastMenu.find((m) => /SQL INSERTs/.test(m.label)).onClick();
    await until(() => calls.filter((c) => c.op === "exportFile").length === 2);
    const sqlReq = calls.filter((c) => c.op === "exportFile")[1].a[0];
    return { ok: req.scope === "all" && req.format === "csv" && req.token === calls.find((c) => c.op === "exportCancel").a[0] && req.table.table === "t" && sqlReq.format === "sql" && sqlReq.targetTable.table === "public.target" && notices.some((n) => /PARTIAL/.test(n.text)), evidence: { req, sqlReq } };
  }));

  await browser.close();
  clearTimeout(watchdog);
  console.log(`\nDB UI: ${pass} passed, ${failN} failed`);
  if (failN) { console.log(results.filter((r) => !r.ok).map((r) => ` - ${r.id} ${r.name}`).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
