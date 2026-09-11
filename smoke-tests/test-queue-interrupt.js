/* While a reply is generating and you've typed text:
 *  - the primary button INTERRUPTS & runs now (Enter), and a QUEUE button appears before it
 *  - Enter (default) interrupts → the typed message jumps to the front of the queue
 *  - Queue (Ctrl+Enter / button) adds to the queue → numbered chips, in order (end)
 *  - with the box empty while running, the primary button is Stop (no queue btn)
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const udir = path.join(os.tmpdir(), "atomnano-queue-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setRunning === "function" && typeof window.__composerSend === "function", null, { timeout: 15000 });
  const sid = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l[0] && l[0].id));
  await win.evaluate((sid) => window.__reloadTab(sid), sid);
  await win.waitForTimeout(300);

  /* ---------- not running: plain send button ---------- */
  await win.evaluate(() => window.__setRunning(false));
  let st = await win.evaluate(() => { const ta = document.getElementById("promptInput"); ta.value = "x"; ta.dispatchEvent(new Event("input")); return window.__composerState(); });
  ok(!st.sendStop && !st.sendInterrupt && !st.queueVisible && /Send/.test(st.sendTitle), `idle → plain Send button (${st.sendTitle})`);

  /* ---------- running + text → INTERRUPT primary + QUEUE button ---------- */
  await win.evaluate(() => window.__setRunning(true));
  st = await win.evaluate(() => { const ta = document.getElementById("promptInput"); ta.value = "hello"; ta.dispatchEvent(new Event("input")); return window.__composerState(); });
  ok(st.sendInterrupt && !st.sendStop, "generating + text → primary button INTERRUPTS & runs now (not stop)");
  ok(/interrupt/i.test(st.sendTitle), `…titled for interrupting (${st.sendTitle})`);
  ok(st.queueVisible, "a Queue button appears before it");

  /* ---------- Queue (Ctrl+Enter / button) queues, numbered, in order ---------- */
  await win.evaluate(() => window.__composerSend("alpha", { queue: true }));
  await win.evaluate(() => window.__composerSend("beta", { queue: true }));
  let q = await win.evaluate(() => window.__queueState());
  ok(q.len === 2 && q.texts[0] === "alpha" && q.texts[1] === "beta", `Queue button adds in order (${JSON.stringify(q.texts)})`);
  ok(q.nums.join(",") === "1,2", `queue shows numbered chips (${q.nums.join(",")})`);

  /* ---------- Enter (default) interrupts → typed message jumps to the front ---------- */
  await win.evaluate(() => window.__composerSend("urgent", {}));
  q = await win.evaluate(() => window.__queueState());
  ok(q.texts[0] === "urgent", `Enter runs the typed message NOW — jumps the queue (${JSON.stringify(q.texts)})`);

  /* ---------- running + empty box → Stop, no queue button ---------- */
  // reset the transient stopping state left by the interrupt above so we test the
  // genuine running+empty case (not the "Stopping…" snapshot).
  await win.evaluate(() => { window.__resetTabState(); window.__setRunning(true); });
  st = await win.evaluate(() => { const ta = document.getElementById("promptInput"); ta.value = ""; ta.dispatchEvent(new Event("input")); return window.__composerState(); });
  ok(st.sendStop && !st.queueVisible, "generating + empty box → primary button is Stop, no Queue button");

  /* ---------- a REAL Enter keypress (not send() directly) interrupts ---------- */
  // Reset the synthetic queue/stopping from the cases above, then drive the real keydown.
  await win.evaluate(() => { window.__resetTabState(); window.__setRunning(true); });
  const enterRes = await win.evaluate(() => {
    const ta = document.getElementById("promptInput");
    ta.value = "viaEnter"; ta.dispatchEvent(new Event("input"));
    const prevented = window.__pressEnter();         // plain Enter
    const st = window.__composerState();
    const qq = window.__queueState();
    return { prevented, stopping: st.sendStop, stopTitle: st.sendTitle, front: qq.texts[0] };
  });
  ok(enterRes.prevented, "plain Enter is handled (preventDefault)");
  ok(enterRes.front === "viaEnter", `plain Enter queues the typed prompt to the FRONT to run now (${enterRes.front})`);
  ok(enterRes.stopping, `…and snaps the composer to a stopping state (${enterRes.stopTitle})`);

  /* ---------- the interrupted prompt is NOT dropped if the run is still tearing down ---------- */
  // The real race: dispatch fires while the backend run is still tearing down
  // (isRunning === true). The old code threw "already running" and DROPPED the
  // prompt. Now it must wait for idle, then dispatch — never drop.
  await win.evaluate((sid) => window.atomnano.test.clearLastRunPayload().then(() => window.atomnano.test.fakeRunning(sid, true)), sid);
  // queue is ["viaEnter"] from the real-Enter case; kick a dispatch while "running".
  await win.evaluate(() => window.__dispatchQueued());
  await win.waitForTimeout(450);
  let payloadDuringBusy = await win.evaluate(() => window.atomnano.test.lastRunPayload());
  ok(!payloadDuringBusy, "while the run is still busy, the queued prompt is NOT sent (no drop, no premature send)");
  let qDuring = await win.evaluate(() => window.__queueState());
  ok(qDuring.texts[0] === "viaEnter", "…the prompt stays at the front of the queue, waiting");
  // backend goes idle → the gated retry should now dispatch it
  await win.evaluate((sid) => window.atomnano.test.fakeRunning(sid, false), sid);
  await win.waitForTimeout(600);
  let payloadAfter = await win.evaluate(() => window.atomnano.test.lastRunPayload());
  ok(payloadAfter && payloadAfter.text === "viaEnter", `once idle, the interrupted prompt is dispatched — never dropped (${payloadAfter && JSON.stringify(payloadAfter.text)})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME QUEUE/INTERRUPT TESTS FAILED" : "\nALL QUEUE/INTERRUPT TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
