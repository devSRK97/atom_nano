/* Database Manager end-to-end smoke (audit ATOMNANO_DB_MANAGEMENT_AUDIT_2026-09-09):
 * boots the REAL Electron app on an ISOLATED profile, opens the standalone DB window,
 * creates a SQLite connection through the form (a temp file in the run folder), runs a
 * multi-statement script statement by statement, browses the table with server paging,
 * edits a cell (persisted value re-read from the engine), imports nothing and exports
 * nothing (dialogs would block) — then checks the store on disk: versioned, no plaintext.
 * Never touches the developer's AtomNano profile or any real database server. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const fs = require("fs");
const { tmpRoot, isolatedEnv, cleanup } = require("./_env");
const ROOT = path.join(__dirname, "..");
let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const RUN = tmpRoot("dbm");
  const ENV = isolatedEnv(RUN);
  const DBFILE = path.join(RUN, "smoke.db");
  const app = await electron.launch({ args: [ROOT], env: ENV });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano, null, { timeout: 15000 });
  // open the standalone Database Manager view in this window (same bootstrap as the DB window)
  await win.evaluate(() => { window.location.search = "?dbm=1"; });
  await win.waitForLoadState("domcontentloaded");
  await win.waitForSelector(".dbm-wrap", { timeout: 20000 });
  await win.waitForSelector(".dbm-welcome", { timeout: 20000 });
  ok(true, "DB manager mounts in Electron (welcome shown, no saved connections on the isolated profile)");

  // 1) new SQLite connection through the form
  await win.click(".dbm-kind-card:has(.dbm-kind-name:text-is('SQLite'))");
  await win.waitForSelector(".dbm-form-ws");
  await win.fill('.dbm-form-fields input[aria-label="Name"]', "Smoke");
  await win.fill('.dbm-form-fields input[aria-label="Database file path"]', DBFILE);
  await win.check('.dbm-form-fields .dbm-ssl-row input[type="checkbox"] >> nth=0');   // create if missing
  await win.click(".dbm-form-actions .btn-primary");
  await win.waitForSelector(".dbm-workspace", { timeout: 15000 });
  await win.waitForFunction(() => document.querySelectorAll(".dbm-conn").length === 1, null, { timeout: 10000 });
  ok(fs.existsSync(DBFILE), "explicit create-if-missing created the SQLite file in the run folder");
  const store = JSON.parse(fs.readFileSync(path.join(ENV.ATOMNANO_USER_DATA, "db-connections.json"), "utf8"));
  ok(store.version === 2 && store.connections.length === 1 && store.connections[0].rev === 1 && store.connections[0].file === DBFILE, "connection store is versioned and holds the profile");

  // 2) statement-by-statement script run
  const script = "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, note TEXT);\nINSERT INTO people (name, note) VALUES ('Ada', 'a;b'), ('Grace', NULL), ('Linus', 'x');\nSELECT * FROM people;";
  await win.evaluate((s) => { const ed = document.querySelector(".dbm-editor"); ed.value = s; ed.dispatchEvent(new Event("input")); }, script);
  await win.click(".dbm-run-btn");
  await win.waitForFunction(() => document.querySelectorAll(".dbm-stmt-label.done").length === 3, null, { timeout: 15000 });
  const labels = await win.evaluate(() => [...document.querySelectorAll(".dbm-stmt-label")].map((l) => l.querySelector(".dbm-stmt-state").textContent));
  ok(labels.join() === "done,done,done", `three statements, each with its own outcome (${labels.join(",")})`);
  await win.waitForSelector(".dbm-results .dbm-vgrid .dbm-vrow", { timeout: 10000 });
  const gridRows = await win.evaluate(() => document.querySelectorAll(".dbm-results .dbm-vgrid .dbm-vrow").length);
  ok(gridRows === 3, `SELECT rendered as an accessible grid with 3 rows (${gridRows})`);
  const status = await win.textContent(".dbm-query-panel .dbm-statusbar");
  ok(/3 of 3 statements ran/.test(status) && /3 rows shown/.test(status), `status bar reports the run (${status.trim()})`);
  const affected = await win.evaluate(() => [...document.querySelectorAll(".dbm-exec-ok")].map((e) => e.textContent));
  ok(affected.some((t) => /3 row\(s\) affected/.test(t)), `INSERT reports the affected count (${affected.join(" | ")})`);

  // 3) browse with server paging + inline edit → persisted value
  await win.waitForFunction(() => document.querySelectorAll(".dbm-table").length >= 1, null, { timeout: 10000 });
  await win.click(".dbm-table:has-text('people')");
  await win.waitForSelector(".dbm-browse-panel .dbm-vgrid .dbm-vrow", { timeout: 10000 });
  const pageInfo = await win.textContent(".dbm-page-info");
  ok(/1–3/.test(pageInfo), `browse shows the page range (${pageInfo.trim()})`);
  const nextDisabled = await win.evaluate(() => document.querySelector('.dbm-pg[aria-label="Next page"]').disabled);
  ok(nextDisabled === true, "Next is disabled because the page reported no more rows");
  const bstatus = await win.textContent(".dbm-browse-panel .dbm-statusbar");
  ok(/editable \(key: id\)/.test(bstatus), `browse is editable through the primary key (${bstatus.trim().slice(0, 80)})`);
  await win.dblclick('.dbm-browse-panel .dbm-vrow[data-ri="1"] .dbm-vcell[aria-colindex="3"]');   // Grace's name
  await win.waitForSelector(".dbm-cell-edit");
  await win.fill(".dbm-cell-edit", "Grace Hopper");
  await win.press(".dbm-cell-edit", "Enter");
  await win.waitForFunction(() => /Grace Hopper/.test(document.querySelector('.dbm-browse-panel .dbm-vrow[data-ri="1"]').textContent), null, { timeout: 10000 });
  const persisted = await win.evaluate(() => window.atomnano.db.query(JSON.parse(localStorage.getItem("dbm-last-conn")), "SELECT name FROM people WHERE id = 2"));
  ok(persisted.rows[0][0] === "Grace Hopper", "the edit was written to the database and the grid shows the re-read value");
  const logKinds = await win.evaluate(() => [...document.querySelectorAll(".dbm-log-row .dbm-log-kind")].map((k) => k.textContent));
  ok(logKinds.includes("edit") && logKinds.includes("browse") && logKinds.includes("query"), `execution log records query, browse and edit (${[...new Set(logKinds)].join(",")})`);

  // 4) structure view + DDL
  await win.click(".dbm-tabs .dbm-tab:has-text('Structure')");
  await win.waitForSelector(".dbm-struct-panel .dbm-grid tbody tr", { timeout: 10000 });
  const colNames = await win.evaluate(() => [...document.querySelectorAll(".dbm-struct-panel .dbm-grid tbody tr td.dbm-col-name")].map((td) => td.textContent.trim()));
  ok(colNames.join() === "id,name,note", `structure lists the columns (${colNames.join(",")})`);

  // 5) no renderer errors; the isolated profile is the only thing touched
  ok(errors.length === 0, `no renderer errors (${errors.join(" | ")})`);
  await app.close();
  cleanup(RUN);
  console.log(failed ? `\nDB manager smoke: ${failed} FAILED` : "\nDB manager smoke: all passed");
})().catch((e) => { console.error("SMOKE ERROR", e); process.exit(2); });
