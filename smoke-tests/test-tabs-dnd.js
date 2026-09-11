/* Tab drag-reorder + persistence, new-session-at-end, Export on tab menu,
 * composer Import, and editor-tab overflow dropdown (close + reveal-to-last). */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-dnd");

// synthetic HTML5 drag from one element to another (shared DataTransfer)
const DND = `(function(fromEl, toEl){ const dt = new DataTransfer();
  fromEl.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:dt}));
  toEl.dispatchEvent(new DragEvent("dragover",{bubbles:true,dataTransfer:dt}));
  toEl.dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:dt}));
  fromEl.dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:dt})); })`;

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  // a re-importable bundle for the composer Import test
  const bundle = { atomnano: 1, version: 1, exportedAt: "x", sessions: [{ name: "Imported Chat", cwd: DIR, messages: [
    { id: "m1", role: "user", text: "hello from import", ts: "2026-01-01T00:00:00Z" },
    { id: "m2", role: "assistant", text: "hi back", ts: "2026-01-01T00:00:01Z" },
  ] }] };
  const bundlePath = path.join(DIR, "chat.atomnano.json");
  fs.writeFileSync(bundlePath, JSON.stringify(bundle));

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  const titles = () => win.evaluate(() => [...document.querySelectorAll("#tabs .cht-tab .ct-name")].map((t) => t.textContent));
  const tabCount = () => win.evaluate(() => document.querySelectorAll("#tabs .cht-tab").length);

  // open A, B, C (non-empty) via History
  await win.evaluate(async () => { for (const n of ["AA", "BB", "CC"]) { const v = await window.atomnano.sessions.create({ name: n }); await window.atomnano.sessions.update(v.id, { messages: [{ id: "m", role: "user", text: n, ts: new Date().toISOString() }] }); } });
  for (const n of ["AA", "BB", "CC"]) {
    await win.locator('[title^="History"]').first().click();
    await win.waitForTimeout(200);
    await win.evaluate(() => { const s = [...document.querySelectorAll(".segmented button")].find((b) => /All projects/i.test(b.textContent)); if (s) s.click(); });
    await win.waitForTimeout(120);
    await win.evaluate((nm) => { const r = [...document.querySelectorAll(".change-row")].find((x) => (x.querySelector(".change-name") || {}).textContent === nm); [...r.querySelectorAll("button")].find((b) => /^(Open|Switch)$/.test(b.textContent.trim())).click(); }, n);
    await win.waitForTimeout(300);
  }

  // ---- drag the first tab onto the last → it moves to the end ----
  const before = await titles();
  ok(before.length >= 3, `multiple session tabs (${before.length})`);
  await win.evaluate((dnd) => { const t = [...document.querySelectorAll("#tabs .cht-tab")]; eval(dnd)(t[0], t[t.length - 1]); }, DND);
  await win.waitForTimeout(250);
  const after = await titles();
  ok(after[after.length - 1] === before[0], `dragged tab "${before[0]}" moved to the end`);
  ok(after[0] === before[1], "remaining tabs shifted left");

  // ---- persistence: saved project order matches the DOM order ----
  const persisted = await win.evaluate(async () => {
    const proj = (await window.atomnano.win.project()) || (await window.atomnano.settings.get()).lastFolder;
    const pt = await window.atomnano.project.getTabs(proj);
    const list = await window.atomnano.sessions.list();
    const nameOf = (id) => (list.find((s) => s.id === id) || {}).name;
    return (pt && pt.openTabIds || []).map(nameOf);
  });
  ok(JSON.stringify(persisted) === JSON.stringify(after), `reordered order persisted (${persisted.join(",")})`);

  // ---- a newly opened session goes to the END and becomes active ----
  const newId = await win.evaluate(async () => { const v = await window.atomnano.sessions.create({ name: "ZZ-Last" }); await window.atomnano.sessions.update(v.id, { messages: [{ id: "m", role: "user", text: "z", ts: new Date().toISOString() }] }); return v.id; });
  await win.evaluate((id) => window.__openInEditor && null); // noop
  await win.evaluate(async (id) => { await window.atomnano.sessions.get(id); }, newId);
  // open it via History (uses openSessionTab → append at end)
  await win.locator('[title^="History"]').first().click();
  await win.waitForTimeout(200);
  await win.evaluate(() => { const s = [...document.querySelectorAll(".segmented button")].find((b) => /All projects/i.test(b.textContent)); if (s) s.click(); });
  await win.waitForTimeout(120);
  await win.evaluate(() => { const r = [...document.querySelectorAll(".change-row")].find((x) => (x.querySelector(".change-name") || {}).textContent === "ZZ-Last"); [...r.querySelectorAll("button")].find((b) => /^(Open|Switch)$/.test(b.textContent.trim())).click(); });
  await win.waitForTimeout(350);
  const tt = await win.evaluate(() => { const tabs = [...document.querySelectorAll("#tabs .cht-tab")]; const last = tabs[tabs.length - 1]; return { name: (last.querySelector(".ct-name") || {}).textContent, active: last.classList.contains("active") }; });
  ok(tt.name === "ZZ-Last" && tt.active, "newly opened session appears last and active");

  // ---- right-click tab menu has Export ----
  await win.locator("#tabs .cht-tab.active").click({ button: "right" });
  await win.waitForTimeout(200);
  const menu = await win.evaluate(() => [...document.querySelectorAll("#ctxMenu .ctx-item")].map((e) => e.textContent.trim()));
  ok(menu.some((t) => /Export conversation/i.test(t)), `tab menu has Export (${JSON.stringify(menu)})`);
  await win.keyboard.press("Escape");

  // ---- composer Import button: present after the 3 dropdowns, imports + opens ----
  const pos = await win.evaluate(() => {
    const kids = [...document.querySelectorAll(".composer-toolbar > *")];
    const idx = kids.findIndex((k) => k.classList.contains("composer-import"));
    const dds = kids.slice(0, idx).filter((k) => k.classList.contains("dd")).length;
    return { has: idx !== -1, ddsBefore: dds };
  });
  ok(pos.has && pos.ddsBefore === 3, `Import button is after the 3 mode dropdowns (dds before=${pos.ddsBefore})`);

  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, bundlePath);
  await win.locator(".composer-import").click();
  await win.waitForTimeout(700);
  const imp = await win.evaluate(() => { const a = document.querySelector("#tabs .cht-tab.active .ct-name"); const body = (document.querySelector("#chat") || {}).textContent || ""; return { active: a ? a.textContent : null, hasMsg: /hello from import/.test(body) }; });
  ok(imp.active === "Imported Chat", `composer Import opened the conversation ("${imp.active}")`);
  ok(imp.hasMsg, "imported conversation messages are loaded in the chat");

  // ---- editor tab overflow: open many files in a narrow editor ----
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(DIR, `longish-file-name-${i}.txt`), "x\n");
  await win.waitForFunction(() => typeof window.__openInEditor === "function", null, { timeout: 8000 });
  for (let i = 0; i < 9; i++) { await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, `longish-file-name-${i}.txt`)); await win.waitForTimeout(80); }
  // shrink editor + recompute
  await win.evaluate(() => { document.documentElement.style.setProperty("--editor-w", "420px"); window.dispatchEvent(new Event("resize")); });
  await win.waitForTimeout(300);
  const ov = await win.evaluate(() => ({ hidden: document.querySelectorAll(".editor-tab.et-hidden").length, ovShown: !document.querySelector(".et-overflow").classList.contains("hidden") }));
  ok(ov.hidden > 0, `narrow editor hides overflowing tabs (${ov.hidden} hidden)`);
  ok(ov.ovShown, "overflow button shown when tabs are hidden");

  // open the overflow dropdown → has close buttons; reveal a hidden tab
  await win.locator(".et-overflow").click();
  await win.waitForTimeout(200);
  const dd = await win.evaluate(() => { const m = document.querySelector(".et-menu"); return { has: !!m, rows: m ? m.querySelectorAll(".et-menu-row").length : 0, closes: m ? m.querySelectorAll(".et-menu-x").length : 0, first: m ? (m.querySelector(".et-menu-name") || {}).textContent : null }; });
  ok(dd.has && dd.rows > 0, `overflow dropdown lists hidden tabs (${dd.rows})`);
  ok(dd.closes === dd.rows, "each hidden tab has a close button in the dropdown");
  const revealName = dd.first;
  await win.evaluate(() => { document.querySelector(".et-menu .et-menu-row").click(); });
  await win.waitForTimeout(300);
  const revealed = await win.evaluate(() => { const vis = [...document.querySelectorAll(".editor-tab:not(.et-hidden)")]; const active = document.querySelector(".editor-tab.active"); const last = vis[vis.length - 1]; return { activeName: active ? (active.querySelector(".et-name") || {}).textContent : null, lastVisName: last ? (last.querySelector(".et-name") || {}).textContent : null }; });
  ok(revealed.activeName === revealName.replace(/\s+•$/, ""), `revealed tab became active ("${revealed.activeName}")`);
  ok(revealed.lastVisName === revealed.activeName, "revealed tab placed at the last visible position");

  await app.close();
  console.log(process.exitCode ? "\nSOME TAB-DND TESTS FAILED" : "\nALL TAB-DND TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
