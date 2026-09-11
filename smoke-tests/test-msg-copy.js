/* Message copy affordances:
 *  - the copy button sits IN the role line (after "Claude", before "You")
 *  - clicking it copies the message text
 *  - right-clicking a selection in the conversation shows a Copy context menu
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const udir = path.join(os.tmpdir(), "atomnano-msgcopy-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__reloadTab === "function" && typeof window.__ctxItems === "function", null, { timeout: 15000 });

  const msgs = [
    { id: "u1", role: "user", text: "please refactor the auth module", ts: new Date(2026, 0, 1, 0, 0, 0).toISOString() },
    { id: "a1", role: "assistant", text: "Refactored the auth module into smaller pieces.", ts: new Date(2026, 0, 1, 0, 0, 1).toISOString() },
  ];
  const sid = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l[0] && l[0].id));
  await win.evaluate(({ sid, msgs }) => window.atomnano.sessions.update(sid, { messages: msgs }), { sid, msgs });
  await win.evaluate((sid) => window.__reloadTab(sid), sid);
  await win.waitForTimeout(500);

  /* ---------- copy button lives in the role line ---------- */
  const place = await win.evaluate(() => ({
    assistant: !!document.querySelector("#chatMessages .msg.assistant .msg-role .msg-copy"),
    user: !!document.querySelector("#chatMessages .msg.user .msg-role .msg-copy"),
    // in the assistant role line, the copy comes AFTER the label in DOM order
    assistantAfterName: (() => { const r = document.querySelector("#chatMessages .msg.assistant .msg-role"); if (!r) return false; const kids = [...r.children]; const li = kids.findIndex((k) => k.classList.contains("msg-role-label")); const ci = kids.findIndex((k) => k.classList.contains("msg-copy")); return li >= 0 && ci > li; })(),
  }));
  ok(place.assistant, "assistant copy button is inside the role line (after the name)");
  ok(place.assistantAfterName, "…and ordered after the 'Claude' label");
  ok(place.user, "user copy button is inside the role line (before 'You' via row-reverse)");

  /* ---------- clicking it copies the message ---------- */
  await win.evaluate(() => document.querySelector("#chatMessages .msg.assistant .msg-copy").click());
  await win.waitForTimeout(200);
  const clip = await win.evaluate(() => window.atomnano.clipboard.read());
  ok(/Refactored the auth module/.test(clip || ""), `copy button copied the response (${JSON.stringify((clip || "").slice(0, 24))})`);

  /* ---------- right-click a selection → Copy menu ---------- */
  await win.evaluate(() => {
    const node = document.querySelector("#chatMessages .msg.assistant .bubble");
    const range = document.createRange(); range.selectNodeContents(node);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 120 }));
  });
  await win.waitForTimeout(150);
  const items = await win.evaluate(() => window.__ctxItems());
  ok(items.includes("Copy"), `selecting text + right-click shows a Copy option (${JSON.stringify(items)})`);
  await win.evaluate(() => window.__ctxClick("Copy"));
  await win.waitForTimeout(150);
  const clip2 = await win.evaluate(() => window.atomnano.clipboard.read());
  ok(/Refactored the auth/.test(clip2 || ""), "the Copy menu item copies the selection");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME MSG-COPY TESTS FAILED" : "\nALL MSG-COPY TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
