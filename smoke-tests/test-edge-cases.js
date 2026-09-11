/* Edge-case batch test:
 *  - describeError() maps transport errors to friendly text (backend)
 *  - error / system messages render (error-card / sys-note)
 *  - permission pick UI: Allow once / Allow for session / Deny
 *  - "Allow for session" → subsequent same-tool requests auto-allow (no card)
 *  - ExitPlanMode → plan card with Approve & run / Keep planning
 *  - tool chips: text→chip gap is not negative (no covering); chip→chip tighter
 *  - markInterruptedOnQuit / interrupt(reason) exist
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CLAUDE = path.join(ROOT, "src", "main", "claude.js");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  // ---------- backend: describeError mapping ----------
  const errs = await app.evaluate(() => {
    const c = global.__claude;
    return {
      net: c.describeError(new Error("request to https://api failed, reason: connect ECONNREFUSED 1.2.3.4:443")),
      dns: c.describeError(new Error("getaddrinfo ENOTFOUND api.anthropic.com")),
      rate: c.describeError(new Error("API error 429: rate_limit exceeded")),
      auth: c.describeError(new Error("401 Unauthorized: invalid api key")),
      srv: c.describeError(new Error("500 internal server error")),
      hasQuitMark: typeof c.markInterruptedOnQuit === "function",
      interruptTakesReason: /reason/.test(c.interrupt.toString()),
    };
  });
  ok(/connection lost/i.test(errs.net), `network error → friendly text ("${errs.net.slice(0, 40)}…")`);
  ok(/connection lost/i.test(errs.dns), "DNS error → connection text");
  ok(/overloaded|rate limit/i.test(errs.rate), "429 → rate-limit text");
  ok(/authorization|login|api key/i.test(errs.auth), "401 → authorization text");
  ok(/server error/i.test(errs.srv), "500 → server error text");
  ok(errs.hasQuitMark, "markInterruptedOnQuit() exists");
  ok(errs.interruptTakesReason, "interrupt(sessionId, reason) accepts a reason");

  // ---------- seed a session and open it as the active tab ----------
  const sid = await win.evaluate(async () => {
    const v = await window.atomnano.sessions.create({ name: "Edge Demo" });
    await window.atomnano.sessions.update(v.id, { messages: [
      { id: "u1", role: "user", text: "go", ts: new Date().toISOString() },
      { id: "a1", role: "assistant", text: "Working on it.", ts: new Date().toISOString() },
      { id: "t1", role: "tool", toolName: "Bash", toolInput: { command: "ls" }, status: "done", result: "ok", ts: new Date().toISOString() },
      { id: "t2", role: "tool", toolName: "Read", toolInput: { file_path: "/x/y.txt" }, status: "done", result: "ok", ts: new Date().toISOString() },
      { id: "e1", role: "error", text: "Connection lost — Claude couldn't reach the server.", ts: new Date().toISOString() },
      { id: "s1", role: "system", text: "Stopped by you.", ts: new Date().toISOString() },
    ] });
    return v.id;
  });
  await win.locator('[title^="History"]').first().click();
  await win.waitForTimeout(300);
  await win.evaluate(() => { const seg = [...document.querySelectorAll(".segmented button")].find((b) => /All projects/i.test(b.textContent)); if (seg) seg.click(); });
  await win.waitForTimeout(200);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".change-row")].find((r) => (r.querySelector(".change-name") || {}).textContent === "Edge Demo");
    const btn = [...row.querySelectorAll("button")].find((b) => /^(Open|Switch)$/.test(b.textContent.trim()));
    btn.click();
  });
  await win.waitForTimeout(500);

  // ---------- error/system message rendering + chip spacing ----------
  const render = await win.evaluate(() => {
    const errCard = !!document.querySelector("#chatMessages .error-card");
    const sysNote = !!document.querySelector("#chatMessages .sys-note");
    // find an assistant text msg immediately followed by a tool (flow) chip
    const msgs = [...document.querySelectorAll("#chatMessages > .msg")];
    let textThenFlow = null, flowThenFlow = null;
    for (let i = 1; i < msgs.length; i++) {
      const prev = msgs[i - 1], cur = msgs[i];
      if (cur.classList.contains("flow")) {
        const mt = parseFloat(getComputedStyle(cur).marginTop);
        if (!prev.classList.contains("flow") && textThenFlow === null) textThenFlow = mt;
        if (prev.classList.contains("flow") && flowThenFlow === null) flowThenFlow = mt;
      }
    }
    return { errCard, sysNote, textThenFlow, flowThenFlow };
  });
  ok(render.errCard, "error message renders as an error-card");
  ok(render.sysNote, "system message renders as a sys-note");
  ok(render.textThenFlow !== null && render.textThenFlow > 0, `text→chip has a real gap (${render.textThenFlow}px) — no touching/covering`);
  ok(render.flowThenFlow === null || render.flowThenFlow > 0, `chip→chip has a clear gap (${render.flowThenFlow}px) — not touching`);
  ok(render.flowThenFlow === null || render.flowThenFlow <= render.textThenFlow, "chips within a turn grouped no looser than between turns");

  // ---------- permission pick UI ----------
  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()[0].webContents.send("session:permission", { sessionId: id, requestId: "p1", toolName: "Bash", input: { command: "rm -rf build" } });
  }, sid);
  await win.waitForTimeout(300);
  const perm = await win.evaluate(() => {
    const card = document.querySelector("#chatPerms .perm-card");
    const btns = card ? [...card.querySelectorAll("button")].map((b) => b.textContent.trim()) : [];
    return { has: !!card, btns };
  });
  ok(perm.has, "permission card shown");
  ok(perm.btns.includes("Allow once") && perm.btns.includes("Deny"), "perm card has Allow once + Deny");
  ok(perm.btns.some((b) => /Allow for session/i.test(b)), "perm card has Allow for session");

  // click "Allow for session" then send another Bash permission → must auto-allow (no new card)
  await win.evaluate(() => { const b = [...document.querySelectorAll("#chatPerms .perm-card button")].find((x) => /Allow for session/i.test(x.textContent)); b.click(); });
  await win.waitForTimeout(200);
  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()[0].webContents.send("session:permission", { sessionId: id, requestId: "p2", toolName: "Bash", input: { command: "ls again" } });
  }, sid);
  await win.waitForTimeout(300);
  const afterAuto = await win.evaluate(() => document.querySelectorAll("#chatPerms .perm-card").length);
  ok(afterAuto === 0, "second Bash request auto-allowed (no card shown)");

  // ---------- ExitPlanMode → plan card ----------
  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()[0].webContents.send("session:permission", { sessionId: id, requestId: "plan1", toolName: "ExitPlanMode", input: { plan: "## Plan\n\n1. Do the thing\n2. Verify it" } });
  }, sid);
  await win.waitForTimeout(300);
  const plan = await win.evaluate(() => {
    const card = document.querySelector("#chatPerms .plan-card");
    const btns = card ? [...card.querySelectorAll("button")].map((b) => b.textContent.trim()) : [];
    const hasMd = card ? !!card.querySelector(".plan-body p, .plan-body ol, .plan-body h2") : false;
    return { has: !!card, btns, hasMd };
  });
  ok(plan.has, "ExitPlanMode renders a plan card");
  ok(plan.btns.some((b) => /Approve & run/i.test(b)) && plan.btns.some((b) => /Keep planning/i.test(b)), "plan card has Approve & run + Keep planning");
  ok(plan.hasMd, "plan body renders markdown");

  await app.close();
  console.log(process.exitCode ? "\nSOME EDGE-CASE TESTS FAILED" : "\nALL EDGE-CASE TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
