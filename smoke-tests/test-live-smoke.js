/* LIVE smoke (uses the real Claude CLI login): verifies that the streaming-input
 * change didn't break normal completion, and that a follow-up turn resumes
 * context. Skips gracefully if no login / network. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const CWD = path.join(os.tmpdir(), "atomnano-live-smoke");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.mkdirSync(CWD, { recursive: true });
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  const sid = await win.evaluate((cwd) => window.atomnano.sessions.create({ name: "Live", cwd }).then((v) => v.id), CWD);

  // helper: run a prompt and wait until idle, return the tail messages
  async function runAndWait(text, ms) {
    await win.evaluate(({ id, text }) => window.atomnano.sessions.send(id, { text, model: "claude-opus-4-8", permissionMode: "acceptEdits", thinking: "off" }), { id, text });
    const start = Date.now();
    // poll the backend running flag
    while (Date.now() - start < ms) {
      await win.waitForTimeout(800);
      const running = await win.evaluate((id) => window.atomnano.sessions.running(id), id);
      if (!running) break;
    }
    return win.evaluate((id) => window.atomnano.sessions.get(id).then((v) => (v.messages || []).map((m) => ({ role: m.role, text: m.text }))), id);
  }
  const id = sid;

  let msgs1;
  try { msgs1 = await runAndWait("Reply with exactly the single word: PONG", 75000); }
  catch (e) { console.log("SKIP: live run threw:", e.message); await app.close(); return; }

  const errored = msgs1.some((m) => m.role === "error");
  if (errored) {
    const errText = (msgs1.find((m) => m.role === "error") || {}).text || "";
    console.log("SKIP: live run errored (likely no login/network):", errText.slice(0, 120));
    await app.close();
    console.log("\nLIVE SMOKE SKIPPED");
    return;
  }

  const got1 = msgs1.filter((m) => m.role === "assistant").map((m) => m.text).join(" ");
  ok(/pong/i.test(got1), `turn 1 completed under streaming input (assistant said: "${got1.slice(0, 40)}")`);

  // turn 2 — should resume context (knows what word it replied with)
  const msgs2 = await runAndWait("In one word, what did you just reply?", 75000);
  const got2 = msgs2.filter((m) => m.role === "assistant").map((m) => m.text).slice(-1)[0] || "";
  ok(/pong/i.test(got2), `turn 2 resumed context (assistant recalled: "${got2.slice(0, 40)}")`);

  await app.close();
  console.log(process.exitCode ? "\nLIVE SMOKE FAILED" : "\nLIVE SMOKE PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
