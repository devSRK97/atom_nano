"use strict";
/* Task board (docs/WORKFLOW_CONTRACT.md §8) in the REAL Electron app on an isolated profile (smoke-tests/_env.js):
 * the Board dock (⋮ → Task board / window.__toggleBoard), the per-set checklist card in the planner's chat and the
 * composer chip follow a board seeded through the bridge (atom.tasks.add / update) and its tasks:update events.
 *   Tier A — needs no main-process service: the dock opens with its empty state, the ⋮ menu lists "Task board",
 *            a persisted `role: "tasks"` message renders as a checklist card, a row click opens the dock.
 *   Tier B — needs atom.tasks (polled for up to 60 s; reported as SKIP when absent): seed a set of 3 tasks and
 *            assert rows / T-badges / header, update T1 → done live (dock row, header, card), T2 → doing (pulsing
 *            dot, chip "Sprint 1 · 1/3"), finish the set, add a task → a second set opens expanded while the first
 *            collapses as done, the cards say "3 of 3 done" / "0 of 1 done", rename + the row's ⋯ menu.
 * Writes test-results/task-board.png.  Run: node smoke-tests/test-task-board.js */
const { _electron: electron } = require("playwright");
const path = require("path");
const fs = require("fs");
const { tmpRoot, isolatedEnv, cleanup } = require("./_env");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const skip = (m) => console.log("SKIP:", m);

(async () => {
  const RUN = tmpRoot("board");
  const ENV = isolatedEnv(RUN);
  const PROJECT = path.join(RUN, "Board Project");
  fs.mkdirSync(PROJECT, { recursive: true }); fs.writeFileSync(path.join(PROJECT, "readme.md"), "# board\n");
  const app = await electron.launch({ args: [ROOT], env: ENV });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && typeof window.__toggleBoard === "function" && typeof window.__tabOrder === "function" && typeof window.__reloadTab === "function", null, { timeout: 20000 });
  await win.evaluate((p) => window.__setProject(p), PROJECT.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const sid = await win.evaluate(() => { const all = window.__tabOrder(); const t = all.find((x) => x.active) || all[0]; return t && t.id; });
  ok(!!sid, `active session tab found (${sid})`);

  /* ---- readers ---- */
  const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await win.waitForTimeout(100); } return false; };
  const dockState = () => win.evaluate(() => {
    const p = document.getElementById("boardPanel"); if (!p) return null;
    const head = p.querySelector(".changes-head");
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
    return {
      visible: !p.classList.contains("hidden"),
      title: head ? txt(head.querySelector(".ch-title")) : "",
      count: head ? txt(head.querySelector(".ch-count")) : "",
      buttons: head ? head.querySelectorAll(".dock-mini").length : 0,
      empty: txt(p.querySelector(".bd-empty")),
      summary: txt(p.querySelector(".bd-sum-set")),
      filter: [...p.querySelectorAll(".bd-seg-btn")].map((b) => b.textContent + (b.classList.contains("active") ? "*" : "")),
      sets: [...p.querySelectorAll(".bd-set")].map((s) => ({
        id: s.dataset.set, open: s.classList.contains("open"), status: ([...s.classList].find((c) => c.startsWith("st-")) || "").slice(3),
        head: txt(s.querySelector(".bd-set-head")), tag: txt(s.querySelector(".bd-set-tag")),
        rows: [...s.querySelectorAll(".bd-task")].map((r) => ({ ref: r.dataset.ref, status: r.dataset.status, title: txt(r.querySelector(".bd-title")), badge: txt(r.querySelector(".bd-badge")), dot: !!r.querySelector(".bd-status .bd-dot"), role: txt(r.querySelector(".bd-role")) })),
      })),
    };
  });
  const cardState = (setId) => win.evaluate((setId) => {
    const c = document.querySelector(`#chatMessages .tasks-card[data-set="${setId}"]`); if (!c) return null;
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
    return {
      status: ([...c.classList].find((x) => x.startsWith("st-")) || "").slice(3), collapsed: c.classList.contains("collapsed"),
      set: txt(c.querySelector(".tk-set")), title: txt(c.querySelector(".tk-title")), count: txt(c.querySelector(".tk-count")),
      bar: (c.querySelector(".tk-bar-done") || { style: {} }).style.width,
      rows: [...c.querySelectorAll(".tk-row")].map((r) => ({ ref: r.dataset.ref, status: ([...r.classList].find((x) => x.startsWith("st-")) || "").slice(3), badge: txt(r.querySelector(".tk-badge")), glyph: (r.querySelector(".tk-glyph") || { dataset: {} }).dataset.state, name: txt(r.querySelector(".tk-name")), role: txt(r.querySelector(".tk-role")) })),
    };
  }, String(setId));

  /* ================= Tier A — the renderer alone ================= */
  await win.evaluate(() => window.__toggleBoard());
  await win.waitForTimeout(250);
  let d = await dockState();
  ok(d && d.visible && d.title === "Task board" && d.buttons === 2, `the Board dock opens (window.__toggleBoard): title "${d && d.title}", ${d && d.buttons} header buttons (New set · Add task)`);
  ok(d && /No tasks yet/.test(d.empty) && /atomnano tasks add/.test(d.empty), `empty state: "${d && d.empty.slice(0, 96)}"`);
  ok(d && d.filter.join(" ") === "All* Ongoing Open Done", `filter segments ${JSON.stringify(d && d.filter)} (Ongoing = doing · review · test, added 2026-09-17)`);
  // the ⋮ menu lists the dock right after "Agents activity" and toggles it
  await win.evaluate(() => document.getElementById("chatMore").click());
  await win.waitForTimeout(500);   // the menu lists recent conversations from disk before it opens
  const menu = await win.evaluate(() => window.__ctxItems());
  ok(menu.includes("Task board") && menu.indexOf("Task board") === menu.indexOf("Agents activity") + 1, `⋮ menu has "Task board" after "Agents activity" (${menu.slice(0, 9).join(" · ")})`);
  const viaMenu = await win.evaluate(() => window.__ctxClick("Task board"));
  await win.waitForTimeout(200);
  d = await dockState();
  ok(viaMenu && d && !d.visible, "the menu entry toggles the dock (closed it)");
  // a persisted `role: "tasks"` message renders as the set's checklist card (no service involved)
  const ts0 = new Date().toISOString();
  await win.evaluate(({ sid, ts }) => window.atomnano.sessions.update(sid, { messages: [
    { id: "u0", role: "user", text: "plan the payments work", ts },
    { id: "tk0", role: "tasks", setId: "set-fixture", text: "Fixture set", ts, meta: { setId: "set-fixture", setN: 7, title: "Fixture set", status: "active", items: [
      { n: 41, title: "Alpha", status: "done", role: "coder" }, { n: 42, title: "Beta", status: "doing", role: null }, { n: 43, title: "Gamma", status: "dropped", role: "tester" }, { n: 44, title: "Delta", status: "review", role: "reviewer" }] } },
  ] }), { sid, ts: ts0 });
  await win.evaluate((id) => window.__reloadTab(id), sid);
  await win.waitForTimeout(400);
  const fx = await cardState("set-fixture");
  ok(fx && fx.set === "Set 7" && fx.title === "Fixture set" && fx.count === "1 of 4 done · 1 dropped" && fx.status === "active" && !fx.collapsed, `a persisted tasks message renders as a card: ${fx && `${fx.set} · ${fx.title} · ${fx.count}`}`);
  ok(fx && fx.rows.map((r) => r.badge).join(",") === "T41,T42,T43,T44" && fx.rows.map((r) => r.glyph).join(",") === "done,doing,dropped,review" && fx.rows[0].role === "coder" && fx.rows[1].role === "" && fx.rows[3].role === "reviewer", `rows carry T-badges, status glyphs and role chips (${fx && fx.rows.map((r) => `${r.badge}:${r.glyph}${r.role ? "/" + r.role : ""}`).join(" ")})`);
  ok(fx && parseFloat(fx.bar) === 25, `the card's bar is 1 of 4 (${fx && fx.bar})`);
  await win.evaluate(() => document.querySelector('#chatMessages .tasks-card[data-set="set-fixture"] .tk-row[data-ref="T42"]').click());
  await win.waitForTimeout(300);
  d = await dockState();
  ok(d && d.visible, "clicking a card row opens the Board dock");
  await win.evaluate(() => document.querySelector('#chatMessages .tasks-card[data-set="set-fixture"] .tk-head').click());
  const folded = await cardState("set-fixture");
  ok(folded && folded.collapsed, "the card's header chevron collapses the checklist");
  await win.evaluate(() => document.querySelector('#chatMessages .tasks-card[data-set="set-fixture"] .tk-head').click());

  /* ================= Tier B — the main-process service (atom.tasks) ================= */
  const t0 = Date.now(); let hasSvc = false;
  while (Date.now() - t0 < 60000) {
    hasSvc = await win.evaluate(() => !!(window.atomnano.tasks && typeof window.atomnano.tasks.add === "function" && typeof window.atomnano.tasks.update === "function"));
    if (hasSvc) break;
    await win.waitForTimeout(1000);
  }
  if (!hasSvc) {
    skip("atom.tasks is not in this build yet — tier B (seeded board, live tasks:update, chip progress, set roll-over, ⋯ menu actions) not run");
  } else {
    const r1 = await win.evaluate((sid) => window.atomnano.tasks.add(sid, { titles: ["Design schema", "Build API", "Write tests"], set: { title: "Sprint 1" } }), sid);
    const set1 = r1 && r1.set;
    ok(set1 && set1.id != null && Array.isArray(r1.items) && r1.items.length === 3, `tasks.add seeded a set of 3 (${set1 && set1.title} · ${r1 && r1.items ? r1.items.map((i) => "T" + i.n).join(",") : "?"})`);
    if (!(await dockState()).visible) await win.evaluate(() => window.__toggleBoard());
    await waitFor(async () => { const s = await dockState(); return s && s.sets.some((x) => String(x.id) === String(set1 && set1.id) && x.rows.length === 3); });
    d = await dockState();
    const g1 = d.sets.find((x) => String(x.id) === String(set1 && set1.id));
    ok(g1 && g1.open && g1.status === "active" && g1.rows.map((r) => r.badge).join(",") === "T1,T2,T3" && g1.rows.every((r) => r.status === "todo"), `the dock shows the active set expanded with T1..T3 (${g1 ? g1.rows.map((r) => r.badge + ":" + r.status).join(" ") : "no group"})`);
    ok(g1 && g1.rows[0].title === "Design schema" && g1.rows[2].title === "Write tests", "row titles");
    ok(d.count === "0 / 3 done" && /Sprint 1/.test(d.summary), `header "${d.count}", summary "${d.summary}"`);
    const c1 = await waitFor(async () => { const c = await cardState(set1.id); return c && c.count === "0 of 3 done" && c.rows.length === 3 && c.title === "Sprint 1"; });
    const card1 = await cardState(set1.id);
    ok(c1, `the planner's chat has the set's card: ${card1 ? `${card1.set} · ${card1.title} · ${card1.count}` : "no card"}`);
    // T1 → done, live in the dock, the header and the card
    await win.evaluate((sid) => window.atomnano.tasks.update(sid, "T1", { status: "done" }), sid);
    const live1 = await waitFor(async () => { const s = await dockState(); const g = s && s.sets.find((x) => String(x.id) === String(set1.id)); return g && g.rows[0].status === "done" && s.count === "1 / 3 done"; });
    d = await dockState();
    ok(live1, `T1 → done updates the dock live (header "${d.count}")`);
    const live1c = await waitFor(async () => { const c = await cardState(set1.id); return c && c.rows[0].status === "done" && c.rows[0].glyph === "done" && c.count === "1 of 3 done"; });
    ok(live1c, 'the chat card follows in place (row T1 done, "1 of 3 done")');
    // T2 → doing: the pulsing dot and the composer chip
    await win.evaluate((sid) => window.atomnano.tasks.update(sid, "T2", { status: "doing" }), sid);
    const doing = await waitFor(async () => { const s = await dockState(); const g = s && s.sets.find((x) => String(x.id) === String(set1.id)); return g && g.rows[1].status === "doing" && g.rows[1].dot; });
    ok(doing, "T2 → doing shows the accent status chip with the pulsing dot");
    // The Task board pill next to the workflow chip (2026-09-17): shown when a board exists, lit while a task is being worked, opens the Board dock.
    const chip = await win.evaluate(() => { const c = document.getElementById("boardChip"); return c ? { text: c.textContent.replace(/\s+/g, " ").trim(), board: (c.querySelector(".wf-chip-board") || {}).textContent || "", hidden: c.classList.contains("hidden"), live: c.classList.contains("live"), title: c.title } : null; });
    ok(chip && !chip.hidden && /^Task board\s*· 1\/3$/.test(chip.text) && chip.live && /Sprint 1 — 1 ongoing · 1 remaining · 1 done/.test(chip.title), `the Task board pill shows the progress and is lit while T2 is being worked (${chip ? chip.text + " | live " + chip.live + " | " + chip.title : "no #boardChip"})`);
    // finish the set
    await win.evaluate((sid) => window.atomnano.tasks.update(sid, "T2", { status: "done" }), sid);
    await win.evaluate((sid) => window.atomnano.tasks.update(sid, "T3", { status: "done" }), sid);
    const finished = await waitFor(async () => { const s = await dockState(); const g = s && s.sets.find((x) => String(x.id) === String(set1.id)); return g && g.status === "done" && s.count === "3 / 3 done"; });
    d = await dockState();
    ok(finished, `every task done closes the set as done (header "${d.count}", tag "${(d.sets[0] || {}).tag}")`);
    // a task added after the set finished → a NEW set, expanded first; the finished one collapses to one line
    const r2 = await win.evaluate((sid) => window.atomnano.tasks.add(sid, { titles: ["Ship it"] }), sid);
    const set2 = r2 && r2.set;
    ok(set2 && String(set2.id) !== String(set1.id), `adding a task after the set finished opens a new set (${set2 ? `Set ${set2.n} "${set2.title}"` : "no set"})`);
    const rolled = await waitFor(async () => { const s = await dockState(); return s && s.sets.length === 2 && String(s.sets[0].id) === String(set2 && set2.id) && s.sets[0].open && !s.sets[1].open; });
    d = await dockState();
    ok(rolled, `the dock lists the new set first and expanded, the finished set collapsed (${d.sets.map((s) => `${s.head} [${s.open ? "open" : "collapsed"}]`).join(" | ")})`);
    ok(d.sets[1] && /done/.test(d.sets[1].tag) && /3 tasks/.test(d.sets[1].head), `the collapsed line reads "${d.sets[1] && d.sets[1].head}"`);
    ok(d.sets[0] && d.sets[0].rows.length === 1 && d.sets[0].rows[0].badge === "T4" && d.count === "0 / 1 done", `the new set holds T4 and the header follows the active set ("${d.count}")`);
    await win.evaluate((id) => document.querySelector(`#boardPanel .bd-set[data-set="${id}"] .bd-set-head`).click(), String(set1.id));
    d = await dockState();
    ok(d.sets[1] && d.sets[1].open && d.sets[1].rows.length === 3 && d.sets[1].rows.every((r) => r.status === "done"), "clicking a finished set's line expands its 3 done tasks");
    await win.evaluate(() => [...document.querySelectorAll("#boardPanel .bd-seg-btn")].find((b) => b.textContent === "Open").click());
    d = await dockState();
    ok(d.sets[1] && d.sets[1].rows.length === 0 && d.sets[0].rows.length === 1, "the Open filter hides finished tasks");
    await win.evaluate(() => [...document.querySelectorAll("#boardPanel .bd-seg-btn")].find((b) => b.textContent === "All").click());
    // one card per set in the chat
    const cardsOk = await waitFor(async () => { const a = await cardState(set1.id), b = await cardState(set2.id); return a && b && a.count === "3 of 3 done" && a.status === "done" && b.count === "0 of 1 done" && b.rows.length === 1 && b.rows[0].badge === "T4"; });
    const a = await cardState(set1.id), b = await cardState(set2.id);
    ok(cardsOk, `the chat has one card per set: ${a ? `${a.set} ${a.count} [${a.status}]` : "no card 1"} · ${b ? `${b.set} ${b.count} [${b.status}]` : "no card 2"}`);
    // a rename reaches both in place
    await win.evaluate((sid) => window.atomnano.tasks.update(sid, "T4", { title: "Ship it!" }), sid);
    const renamed = await waitFor(async () => { const s = await dockState(); const c = await cardState(set2.id); return s && s.sets[0].rows[0] && s.sets[0].rows[0].title === "Ship it!" && c && c.rows[0].name === "Ship it!"; });
    ok(renamed, "a title change reaches the dock row and the card row in place");
    // the row's ⋯ menu → Start
    await win.evaluate(() => document.querySelector('#boardPanel .bd-task[data-ref="T4"] .bd-menu').click());
    const acts = await win.evaluate(() => window.__ctxItems());
    ok(["Start", "Done", "Review", "Test", "Block", "Drop", "Rename…", "Add note…", "Delete"].every((l) => acts.includes(l)), `the row's ⋯ menu: ${acts.join(" · ")}`);
    const started = await win.evaluate(() => window.__ctxClick("Start"));
    const startedOk = await waitFor(async () => { const s = await dockState(); return s && s.sets[0].rows[0] && s.sets[0].rows[0].status === "doing"; });
    ok(started && startedOk, "⋯ → Start puts the task in progress through atom.tasks.update");
  }

  fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(ROOT, "test-results", "task-board.png") });
  ok(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await app.close();
  cleanup(RUN);
  console.log(process.exitCode ? "\nTASK BOARD SMOKE: FAILURES" : hasSvc ? "\nALL TASK BOARD CHECKS PASSED" : "\nTASK BOARD TIER A PASSED (tier B skipped — atom.tasks missing)");
})().catch((e) => { console.error(e); process.exit(2); });
