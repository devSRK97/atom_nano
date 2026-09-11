/* Conversation navigation trio:
 *  - Ctrl+F search over the conversation: highlights + match count + next/prev
 *  - prompt timeline dots: one per user prompt, hover tooltip, click jumps
 *  - right-click tab → synthesize → a fresh session seeded with the digest
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-chatnav");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-chatnav-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__reloadTab === "function" && typeof window.__chatFind === "function" && window.atomnano, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(400);

  /* ---------- fabricate a conversation ---------- */
  const msgs = [
    { id: "m0", role: "user", text: "fix the AUTH login bug", ts: new Date(2026, 0, 1, 0, 0, 0).toISOString() },
    { id: "m1", role: "assistant", text: "I fixed the login flow and added a guard.", ts: new Date(2026, 0, 1, 0, 0, 1).toISOString() },
    { id: "m2", role: "user", text: "add a SEARCH feature to the sidebar", ts: new Date(2026, 0, 1, 0, 0, 2).toISOString() },
    { id: "m3", role: "assistant", text: "Search implemented.", ts: new Date(2026, 0, 1, 0, 0, 3).toISOString() },
    { id: "m4", role: "user", text: "refactor the DATABASE layer", ts: new Date(2026, 0, 1, 0, 0, 4).toISOString() },
    { id: "m5", role: "assistant", text: "Refactor complete ✓", ts: new Date(2026, 0, 1, 0, 0, 5).toISOString() },
  ];
  const sid = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l[0] && l[0].id));
  await win.evaluate(({ sid, msgs }) => window.atomnano.sessions.update(sid, { messages: msgs }), { sid, msgs });
  await win.evaluate((sid) => window.__reloadTab(sid), sid);
  await win.waitForTimeout(500);

  /* ---------- 1) Ctrl+F search ---------- */
  const find = await win.evaluate(() => window.__chatFind("login"));
  ok(find.count === 2, `search "login" finds both occurrences (count=${find.count})`);
  ok(/1\/2/.test(find.label || ""), `match counter shows position (${find.label})`);
  const idx = await win.evaluate(() => window.__chatFindStep(1));
  ok(idx === 1, `next match advances the cursor (idx=${idx})`);
  const search2 = await win.evaluate(() => window.__chatFind("SEARCH"));
  ok(search2.count === 2, `search is case-insensitive — "SEARCH" matches SEARCH + Search (count=${search2.count})`);
  await win.evaluate(() => window.__closeChatFind());
  const closed = await win.evaluate(() => !document.getElementById("chatSearch") && document.querySelectorAll("#chatMessages mark.cf-hit").length === 0);
  ok(closed, "closing search removes the bar and clears highlights");

  /* ---------- 2) prompt timeline dots ---------- */
  const dots = await win.evaluate(() => window.__promptDots());
  ok(dots.length === 3, `one timeline dot per user prompt (${dots.length})`);
  ok(dots.some((t) => /AUTH login bug/.test(t)), "dot tooltip carries the prompt text");
  const jumped = await win.evaluate(() => window.__clickPromptDot(0));
  ok(jumped, "clicking a dot jumps to that prompt");

  // custom, left-directed tooltip on hover
  await win.evaluate(() => window.__hoverTip("#promptRail .rail-dot"));
  await win.waitForTimeout(430);
  const tip = await win.evaluate(() => { const s = window.__tipState(); const d = document.querySelector("#promptRail .rail-dot").getBoundingClientRect(); return Object.assign({ dotLeft: d.left }, s); });
  ok(tip.show && tip.dir === "tip-left", `rail dot shows a LEFT-directed custom tooltip (dir=${tip.dir})`);
  ok(/AUTH login bug|search|refactor/i.test(tip.text || ""), `tooltip carries the prompt text (${JSON.stringify((tip.text || "").slice(0, 24))})`);
  ok(tip.left > 0 && tip.left < tip.dotLeft, `tooltip sits to the LEFT of the dot (${Math.round(tip.left)} < ${Math.round(tip.dotLeft)})`);

  /* ---------- 3) synthesize → new session ---------- */
  const synth = await win.evaluate((id) => window.__synthesize(id), sid);
  ok(synth && synth.id && synth.id !== sid, `synthesize created a NEW session (${synth && synth.name})`);
  ok(/^↻/.test(synth.name || ""), "the new session is marked as a resume");
  ok(/Continued from/.test(synth.first || ""), "the new session is seeded with a bounded conversation-record entry");
  ok(/login|auth|search|database/i.test(synth.first || ""), "the seed carries the source conversation's content");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME CHAT-NAV TESTS FAILED" : "\nALL CHAT-NAV TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
