/* Verify: AskUserQuestion → radio (single) + checkbox (multi) picker that sends
 * the chosen answer back; the "Thinking" working label; and the jump-to-latest
 * scroll caret appearing when scrolled up. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist", "ask-ui.png");

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  // open a session as the active tab
  const sid = await win.evaluate(async () => {
    const v = await window.atomnano.sessions.create({ name: "AskDemo" });
    // fill with enough messages to make the chat scrollable
    const msgs = [];
    for (let i = 0; i < 40; i++) msgs.push({ id: "m" + i, role: i % 2 ? "assistant" : "user", text: "line " + i + " ".repeat(4), ts: new Date().toISOString() });
    await window.atomnano.sessions.update(v.id, { messages: msgs });
    return v.id;
  });
  await win.locator('[title^="History"]').first().click();
  await win.waitForTimeout(300);
  await win.evaluate(() => { const s = [...document.querySelectorAll(".segmented button")].find((b) => /All projects/i.test(b.textContent)); if (s) s.click(); });
  await win.waitForTimeout(150);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".change-row")].find((r) => (r.querySelector(".change-name") || {}).textContent === "AskDemo");
    [...row.querySelectorAll("button")].find((b) => /^(Open|Switch)$/.test(b.textContent.trim())).click();
  });
  await win.waitForTimeout(600);

  // ---- scroll caret: hidden at bottom, shown after scrolling up ----
  await win.evaluate(() => { const w = document.getElementById("chatWrap"); w.scrollTop = w.scrollHeight; });
  await win.waitForTimeout(200);
  ok(await win.evaluate(() => document.getElementById("scrollBtn").classList.contains("hidden")), "scroll caret hidden at bottom");
  await win.evaluate(() => { const w = document.getElementById("chatWrap"); w.scrollTop = w.scrollHeight - w.clientHeight - 120; w.dispatchEvent(new Event("scroll")); });
  await win.waitForTimeout(200);
  ok(!(await win.evaluate(() => document.getElementById("scrollBtn").classList.contains("hidden"))), "scroll caret shown after scrolling up");
  // click it → returns to bottom + hides
  await win.click("#scrollBtn");
  await win.waitForTimeout(400);
  ok(await win.evaluate(() => document.getElementById("scrollBtn").classList.contains("hidden")), "caret hides after jumping to latest");

  // ---- AskUserQuestion picker (1 single-select + 1 multi-select) ----
  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()[0].webContents.send("session:permission", {
      sessionId: id, requestId: "ask1", toolName: "AskUserQuestion",
      input: { questions: [
        { header: "Infra source", question: "How should start-all-dev.bat provide RabbitMQ + Redis?", multiSelect: false,
          options: [ { label: "Portable Redis + choco RabbitMQ", description: "No Docker; native services." }, { label: "Keep Docker compose", description: "Use the existing compose file." } ] },
        { header: "Extras", question: "Which optional services to include?", multiSelect: true,
          options: [ { label: "LLM worker", description: "Python FastAPI gateway." }, { label: "Tunnel", description: "CI entry point." }, { label: "Recorder", description: "Chrome extension recorder." } ] },
      ] },
    });
  }, sid);
  await win.waitForTimeout(400);

  const ui = await win.evaluate(() => {
    const card = document.querySelector("#chatPerms .ask-card");
    if (!card) return { has: false };
    return {
      has: true,
      radios: card.querySelectorAll('input[type="radio"]').length,
      checks: card.querySelectorAll('input[type="checkbox"]').length,
      tags: [...card.querySelectorAll(".ask-tag")].map((t) => t.textContent),
      sendDisabled: card.querySelector(".btn-primary").disabled,
      noRawJson: !/\"questions\"/.test(card.textContent),
    };
  });
  ok(ui.has, "AskUserQuestion renders a picker card (not raw JSON)");
  ok(ui.noRawJson, "card shows no raw JSON");
  ok(ui.radios === 2, `single-select question uses 2 radio buttons (${ui.radios})`);
  ok(ui.checks === 3, `multi-select question uses 3 checkboxes (${ui.checks})`);
  ok(ui.tags.join(",") === "Infra source,Extras", `question headers shown as tags (${ui.tags})`);
  ok(ui.sendDisabled, "Send disabled until all questions answered");

  // pick a radio + two checkboxes
  await win.evaluate(() => {
    const card = document.querySelector("#chatPerms .ask-card");
    card.querySelectorAll('input[type="radio"]')[0].click();
    const cbs = card.querySelectorAll('input[type="checkbox"]');
    cbs[0].click(); cbs[2].click();
  });
  await win.waitForTimeout(150);
  ok(!(await win.evaluate(() => document.querySelector("#chatPerms .ask-card .btn-primary").disabled)), "Send enables after answering every question");
  await win.locator("#chatPerms .ask-card").screenshot({ path: OUT }).catch(() => {});

  // capture the message sent back via permissionResponse (register listener first)
  await app.evaluate(({ ipcMain }) => {
    global.__permResp = null;
    ipcMain.once("sessions:permission-response", (_e, requestId, decision) => { global.__permResp = { requestId, decision }; });
  });
  await win.evaluate(() => document.querySelector("#chatPerms .ask-card .btn-primary").click());
  await win.waitForTimeout(400);
  const sent = await app.evaluate(() => global.__permResp);
  ok(sent && sent.requestId === "ask1", "answer delivered via permission response");
  const msg = sent && sent.decision && sent.decision.message || "";
  ok(/Portable Redis/.test(msg), `answer includes the single-select choice ("${msg.split("\\n")[1] || msg.slice(0, 40)}")`);
  ok(/LLM worker/.test(msg) && /Recorder/.test(msg), "answer includes both multi-select choices");
  ok(await win.evaluate(() => !document.querySelector("#chatPerms .ask-card")), "ask card dismissed after sending");

  // ---- Thinking label ----
  await win.evaluate((id) => {
    const ts = null; // can't reach internal state; drive via a fake running status
    window.dispatchEvent(new Event("noop"));
  }, sid);
  // simulate running status for the active session and re-render live
  await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.getAllWindows()[0].webContents.send("session:status", { sessionId: id, status: "running" }); }, sid);
  await win.waitForTimeout(300);
  const thinking = await win.evaluate(() => { const el = document.querySelector(".live-typing .typing-label"); return el ? el.textContent : null; });
  ok(thinking === "Thinking", `running shows a "Thinking" label (got: ${JSON.stringify(thinking)})`);

  console.log("screenshot:", OUT);
  await app.close();
  console.log(process.exitCode ? "\nSOME ASK/SCROLL TESTS FAILED" : "\nALL ASK/SCROLL TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
