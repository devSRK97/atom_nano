/* Verify the Thinking dropdown actually drives extended reasoning — and, crucially,
 * that it does NOT error on the adaptive-only models (Fable 5 / Opus 4.8 reject the
 * raw `budget_tokens` shape, so we must confirm the Agent SDK's adaptive thinking +
 * effort is accepted and that thinking content surfaces).
 *
 * For each (model, thinking-level) it checks:
 *   - the run completes with NO error envelope (no 400 from an unsupported param),
 *   - the CLI echoes back the requested model in init,
 *   - depth is driven by `effort` with a visible adaptive summary (not a dead budget),
 *   - thinking actually surfaced (streamed thinking deltas and/or a thinking block),
 *   - and "off" yields a clean run with no thinking.
 * Live: SKIPS gracefully if there's no login / network. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

// Adaptive models (Opus 4.6+, Sonnet 4.6, Fable) ignore a fixed budget and drive
// depth via effort, mirroring EFFORT_BY_LEVEL in src/main/claude.js.
const EFFORT = { think: "low", "think-hard": "medium", "think-harder": "high", ultrathink: "max" };
const PROMPT = "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Reason carefully step by step, then state the final amount.";

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  // Capture streamed thinking deltas per session (the app surfaces them via onPartial).
  await win.evaluate(() => {
    window.__thinkChars = {};
    window.atomnano.events.onPartial((p) => {
      if (p && p.kind === "thinking") window.__thinkChars[p.sessionId] = (window.__thinkChars[p.sessionId] || 0) + (p.delta ? p.delta.length : 0);
    });
  });

  const cwd = path.join(os.tmpdir(), "atomnano-thinking"); fs.mkdirSync(cwd, { recursive: true });

  const runCase = async (model, level) => {
    const sid = await win.evaluate((c) => window.atomnano.sessions.create({ name: "Think " + Date.now() }).then((v) => v.id), cwd);
    await win.evaluate(({ id, c }) => window.atomnano.sessions.update(id, { cwd: c }), { id: sid, c: cwd });
    await win.evaluate(({ id, model, level, prompt }) =>
      window.atomnano.sessions.send(id, { text: prompt, model, thinking: level, permissionMode: "acceptEdits" }),
      { id: sid, model, level, prompt: PROMPT });

    let done = false, errored = false, errText = "";
    for (let i = 0; i < 90; i++) {
      await win.waitForTimeout(1000);
      const running = await win.evaluate((id) => window.atomnano.sessions.running(id), sid);
      const msgs = await win.evaluate((id) => window.atomnano.sessions.get(id).then((v) => (v.messages || []).map((m) => ({ r: m.role, t: m.text || "" }))), sid);
      const err = msgs.find((m) => m.r === "error");
      if (err) { errored = true; errText = err.t; break; }
      if (!running) { done = true; break; }
    }

    const sent = await app.evaluate(() => global.__claude && global.__claude._lastRun && global.__claude._lastRun.sent || null);
    const init = await app.evaluate(() => global.__claude && global.__claude._lastRun && global.__claude._lastRun.init || null);
    const msgs = await win.evaluate((id) => window.atomnano.sessions.get(id).then((v) => (v.messages || []).map((m) => ({ r: m.role, t: m.text || "" }))), sid);
    const thinkMsgChars = msgs.filter((m) => m.r === "thinking").reduce((n, m) => n + m.t.length, 0);
    const streamChars = await win.evaluate((id) => (window.__thinkChars || {})[id] || 0, sid);
    const answer = msgs.filter((m) => m.r === "assistant").map((m) => m.t).join(" ");
    return { sid, done, errored, errText, sent, init, thinkMsgChars, streamChars, answeredLen: answer.length };
  };

  // Probe once to see whether we can run live at all.
  const probe = await runCase("claude-opus-4-8", "off");
  if (!probe.done && !probe.errored && !probe.init) {
    console.log("SKIP: no live run (login/network)");
    await app.close();
    console.log("\nTHINKING LEVELS SKIPPED (live)");
    return;
  }

  const cases = [
    ["claude-opus-4-8", "off"],
    ["claude-opus-4-8", "ultrathink"],
    ["claude-fable-5", "think-hard"],
    ["claude-fable-5", "ultrathink"],
  ];

  for (const [model, level] of cases) {
    const r = await runCase(model, level);
    console.log(`\n=== ${model} / ${level} ===`, JSON.stringify({
      done: r.done, errored: r.errored, errText: r.errText.slice(0, 160),
      effort: r.sent && r.sent.effort, thinkingConfig: r.sent && r.sent.thinkingConfig, sentThinking: r.sent && r.sent.thinking,
      initModel: r.init && r.init.model, thinkMsgChars: r.thinkMsgChars, streamChars: r.streamChars, answerLen: r.answeredLen,
    }));

    ok(!r.errored, `${model}/${level}: run produced NO error (param accepted) ${r.errText ? "— " + r.errText.slice(0, 120) : ""}`);
    if (r.init) ok(r.init.model === model, `${model}/${level}: CLI ran the requested model (init=${r.init && r.init.model})`);
    ok(r.answeredLen > 0, `${model}/${level}: produced an assistant answer`);

    if (level !== "off") {
      ok((r.sent && r.sent.effort) === EFFORT[level], `${model}/${level}: effort = ${EFFORT[level]} (got ${r.sent && r.sent.effort})`);
      ok(r.sent && r.sent.thinkingConfig && r.sent.thinkingConfig.type === "adaptive" && r.sent.thinkingConfig.display === "summarized",
        `${model}/${level}: requested adaptive thinking with a visible summary`);
      ok((r.sent && r.sent.maxThinkingTokens) === 0, `${model}/${level}: no dead legacy budget sent on an adaptive model`);
      ok((r.thinkMsgChars + r.streamChars) > 0, `${model}/${level}: thinking SURFACED (${r.streamChars} streamed + ${r.thinkMsgChars} block chars)`);
    } else {
      ok(!(r.sent && r.sent.thinkingConfig) && !(r.sent && r.sent.effort), `${model}/off: no thinking/effort requested`);
      ok((r.thinkMsgChars + r.streamChars) === 0, `${model}/off: no thinking emitted (${r.streamChars}+${r.thinkMsgChars})`);
    }
  }

  await app.close();
  console.log(process.exitCode ? "\nTHINKING LEVELS FAILED" : "\nTHINKING LEVELS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
