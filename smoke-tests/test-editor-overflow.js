/* Editor tab overflow dropdown: lists ONLY hidden tabs (never ones already
 * visible), STAYS OPEN when you remove a tab from it, and closes on outside click.
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-etof");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(DIR, `longfilename-${i}.txt`), "content " + i);
  const udir = path.join(os.tmpdir(), "atomnano-etof-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__etForce === "function" && typeof window.__openInEditor === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  // open all 12 files
  const CWD = DIR.replace(/\\/g, "/");
  for (let i = 0; i < 12; i++) { await win.evaluate((p) => window.__openInEditor(p), `${CWD}/longfilename-${i}.txt`); }
  await win.waitForTimeout(400);

  // force the tab strip narrow so some tabs overflow
  let st = await win.evaluate(() => window.__etForce(260));
  ok(st && st.hiddenCount >= 2, `some tabs overflow into the dropdown (${st.hiddenCount} hidden)`);

  /* ---------- menu lists ONLY hidden tabs ---------- */
  st = await win.evaluate(() => window.__etOpenMenu());
  ok(st.menuOpen, "overflow dropdown opens");
  ok(st.menuRows === st.hiddenCount, `dropdown shows exactly the hidden tabs (${st.menuRows} rows = ${st.hiddenCount} hidden)`);
  const overlap = st.menuPaths.filter((p) => st.visiblePaths.includes(p));
  ok(overlap.length === 0, `no already-visible tab appears in the dropdown (${overlap.length} overlap)`);

  /* ---------- removing a tab keeps the dropdown open ---------- */
  const rowsBefore = st.menuRows;
  st = await win.evaluate(() => window.__etRemoveFirst());
  ok(st.menuOpen, "the dropdown stays OPEN after removing a tab");
  ok(st.menuRows === rowsBefore - 1, `the removed tab is gone, rest remain (${rowsBefore} → ${st.menuRows})`);

  /* ---------- clicking outside closes it ---------- */
  st = await win.evaluate(() => window.__etClickOutside());
  ok(st.menuOpen === false, "clicking outside closes the dropdown");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME EDITOR-OVERFLOW TESTS FAILED" : "\nALL EDITOR-OVERFLOW TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
