/* Agent panel batch:
 *  - copy button on prompt + response cards (writes to clipboard)
 *  - edit tool-card click → editor jumps to the exact edited section
 *  - changed-files panel shows +/− counts; row click jumps to first change
 *  - scroll-to-bottom button exists; lazy history loads older pages with a spinner
 *  - sub-agents control (checkbox + max) before the 1M toggle; persists
 *  - project memory graph records runs and produces a digest
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-agentpanel");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  // target file the fake Edit tool-card points at
  let target = "function alpha() {\n  return 1;\n}\n\n";
  for (let i = 0; i < 60; i++) target += `// filler line ${i}\n`;
  target += "function target() {\n  const SPECIAL_MARKER = 99;\n  return SPECIAL_MARKER;\n}\n";
  fs.writeFileSync(path.join(DIR, "edited.js"), target);

  const udir = path.join(os.tmpdir(), "atomnano-agentpanel-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__reloadTab === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(400);

  /* ---------- fabricate a conversation on disk, then reload the tab ---------- */
  const editedPath = path.join(DIR, "edited.js");
  const fabricated = [];
  for (let i = 0; i < 150; i++) fabricated.push({ id: "m" + i, role: i % 2 ? "assistant" : "user", text: `message number ${i}`, ts: new Date(2026, 0, 1, 0, 0, i).toISOString() });
  fabricated.push({ id: "mtool", role: "tool", toolName: "Edit", status: "done", ts: new Date().toISOString(),
    toolInput: { file_path: editedPath, old_string: "const SPECIAL_MARKER = 99;", new_string: "const SPECIAL_MARKER = 99;" } });
  fabricated.push({ id: "mlast", role: "assistant", text: "final answer ✓", ts: new Date().toISOString() });
  const sid = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l[0] && l[0].id));
  await win.evaluate(({ sid, msgs }) => window.atomnano.sessions.update(sid, { messages: msgs }), { sid, msgs: fabricated });
  await win.evaluate((sid) => window.__reloadTab(sid), sid);
  await win.waitForTimeout(800);

  /* ---------- 1) lazy history: only a window in RAM, older loads with spinner ---------- */
  let info = await win.evaluate(() => window.__chatInfo());
  ok(info.total === 152, `session reports all messages (${info.total})`);
  ok(info.inRam < info.total, `only a window is in RAM (${info.inRam}/${info.total}, firstIndex=${info.firstIndex})`);
  const sawSpinner = await win.evaluate(async () => {
    // drain the in-memory window first so the next page must come from DISK
    for (let i = 0; i < 30 && window.__chatInfo().viewStart > 0; i++) await window.__loadOlder();
    const p = window.__loadOlder();   // disk branch → spinner (180ms min visibility)
    await new Promise((r) => setTimeout(r, 60));
    const seen = !!document.querySelector("#chatMessages .load-older");
    await p;
    return seen;
  });
  ok(sawSpinner, "loading an older page from disk shows the spinner row");
  const info2 = await win.evaluate(() => window.__chatInfo());
  ok(info2.inRam > info.inRam || info2.viewStart < info.viewStart, `older page actually loaded (ram ${info.inRam}→${info2.inRam})`);

  /* ---------- 2) scroll-to-bottom button ---------- */
  const btn = await win.evaluate(() => { const b = document.getElementById("scrollBtn"); if (!b) return null; const cs = getComputedStyle(b); return { right: cs.right, bottom: cs.bottom }; });
  ok(!!btn, `scroll-to-bottom button present (right ${btn && btn.right}, bottom ${btn && btn.bottom})`);

  /* ---------- 3) copy buttons on prompt + response cards ---------- */
  const copyCounts = await win.evaluate(() => ({
    user: document.querySelectorAll(".msg.user .msg-copy").length,
    assistant: document.querySelectorAll(".msg.assistant .msg-copy").length,
  }));
  ok(copyCounts.user > 0 && copyCounts.assistant > 0, `copy buttons on cards (user=${copyCounts.user}, assistant=${copyCounts.assistant})`);
  await win.evaluate(() => { const btns = document.querySelectorAll(".msg.assistant .msg-copy"); btns[btns.length - 1].click(); });
  await win.waitForTimeout(250);
  const clip = await win.evaluate(() => window.atomnano.clipboard.read());
  ok(/final answer/.test(clip || ""), `copy button copied the response text (${JSON.stringify((clip || "").slice(0, 24))})`);

  /* ---------- 4) Edit tool-card click → jump to the edited section ---------- */
  await win.evaluate(() => { const links = document.querySelectorAll(".tool-card .tool-summary.file-link"); links[links.length - 1].click(); });
  await win.waitForTimeout(1200);
  const jump = await win.evaluate(() => { const f = window.__editorState(); const cm = window.__cm(); return { path: f && f.path, line: cm ? cm.lineOf(cm.cursor()) : 0 }; });
  ok(/edited\.js$/.test(jump.path || ""), "edit card opened the edited file");
  ok(jump.line >= 60, `caret landed on the edited section, not the top (line ${jump.line})`);

  /* ---------- 5) changed-files panel: counts + jump ---------- */
  await win.evaluate((p) => window.__setEditedFiles([{ path: p, count: 2, added: 7, removed: 3 }]), editedPath);
  await win.evaluate(() => window.__toggleChanges());
  await win.waitForTimeout(300);
  const row = await win.evaluate(() => {
    const r = document.querySelector("#changesPanel .change-row");
    return r ? { add: (r.querySelector(".d-add") || {}).textContent, del: (r.querySelector(".d-del") || {}).textContent } : null;
  });
  ok(row && row.add === "+7" && row.del === "−3", `changes panel shows per-file +/− counts (${row && row.add}/${row && row.del})`);

  /* ---------- 6) the Agents button before the 1M indicator; the compact popover's switch persists ---------- */
  const sub = await win.evaluate(() => {
    const btn = document.getElementById("agentsBtn"), onem = document.getElementById("oneMWrap");
    if (!btn || !onem) return null;
    return { order: !!(btn.compareDocumentPosition(onem) & Node.DOCUMENT_POSITION_FOLLOWING), label: btn.textContent.trim(), noReviewers: !document.getElementById("reviewersBtn"), noCheckbox: !onem.querySelector("input") };
  });
  ok(sub && sub.order && /^Agents/.test(sub.label) && sub.noReviewers && sub.noCheckbox, `Agents button sits before the 1M indicator; no Reviewers button, no 1M checkbox (${sub && sub.label})`);
  await win.evaluate(() => document.getElementById("agentsBtn").click());
  await win.waitForTimeout(150);
  const popInfo = await win.evaluate(() => {
    const p = document.querySelector(".ag-pop"); if (!p) return null;
    const sw = p.querySelector(".ag-switch-input"); if (sw && !sw.checked) { sw.checked = true; sw.dispatchEvent(new Event("change")); }
    return { hasList: !!p.querySelector(".ag-list-host"), hasStatus: !!p.querySelector(".ag-statusline"), noCores: !/Cores per agent/.test(p.textContent), stepper: !!p.querySelector(".ag-stepper") };
  });
  ok(popInfo && popInfo.hasList && popInfo.hasStatus && popInfo.noCores && popInfo.stepper, "the compact Agents popover: switch + cap on one row, status line, running list, no cores section");
  await win.waitForTimeout(300);
  const persisted = await win.evaluate(() => window.atomnano.settings.get().then((s) => ({ on: s.subAgents, max: s.subAgentsMax })));
  ok(persisted.on === true && persisted.max >= 1, `sub-agents setting persists (on=${persisted.on}, max=${persisted.max})`);

  /* ---------- 7) memory graph records + digests ---------- */
  await win.evaluate((d) => window.atomnano.graph.record(d, { prompt: "add login form validation", files: [{ path: d + "/edited.js", added: 12, removed: 2 }, { path: d + "/auth.ts", added: 30, removed: 0 }] }), DIR.replace(/\\/g, "/"));
  await win.evaluate((d) => window.atomnano.graph.record(d, { prompt: "fix the session bug", files: [{ path: d + "/auth.ts", added: 4, removed: 1 }] }), DIR.replace(/\\/g, "/"));
  const peek = await win.evaluate((d) => window.atomnano.graph.peek(d), DIR.replace(/\\/g, "/"));
  ok(peek.runs === 2 && peek.files === 2, `graph recorded runs + file nodes (runs=${peek.runs}, files=${peek.files})`);
  ok(/login form validation/.test(peek.digest) && /auth\.ts \(2×/.test(peek.digest), "digest contains recent topics + hot files");
  ok(/edited\.js ↔|↔ edited\.js|auth\.ts ↔|↔ auth\.ts/.test(peek.digest), "digest includes co-edited file pairs");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME AGENT-PANEL TESTS FAILED" : "\nALL AGENT-PANEL TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
