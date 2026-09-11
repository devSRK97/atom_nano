/* Claude-only probe: verify each thinking level (think / think-hard / think-harder /
 * ultrathink / off) is actually being applied on the Anthropic path. Forces
 * llmProvider="anthropic" first so it doesn't get rerouted via the user's saved
 * Gemini/OpenAI setting. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
// Model-aware ladder: `max` is OPUS 4.6 ONLY; on Opus 4.7+, Fable, Mythos it
// errors, so we now send `xhigh` (the deepest valid level on those models).
function effortFor(model, level) {
  if (level === "ultrathink") return /claude-opus-4-6/.test(model) ? "max" : "xhigh";
  return ({ think: "low", "think-hard": "medium", "think-harder": "high" })[level];
}

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  // Force the primary back to Anthropic — the user's persisted setting may be
  // google/openai and would otherwise route through that path. Settings are
  // PER-PROJECT, so we save at the test's cwd directly (the IPC route would only
  // set it for the open window's project).
  const cwd = path.join(os.tmpdir(), "atomnano-think-claude"); fs.mkdirSync(cwd, { recursive: true });
  await app.evaluate(({ }, c) => global.__store && global.__store.saveSettings({ llmProvider: "anthropic", defaultModel: "claude-opus-4-8" }, c), cwd);
  // Also set globally as a safety net.
  await win.evaluate(() => window.atomnano.settings.set({ llmProvider: "anthropic" }));

  // Stream-thinking capture per session.
  await win.evaluate(() => {
    window.__thinkChars = {};
    window.atomnano.events.onPartial((p) => {
      if (p && p.kind === "thinking") window.__thinkChars[p.sessionId] = (window.__thinkChars[p.sessionId] || 0) + (p.delta ? p.delta.length : 0);
    });
  });

  const PROMPT = "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Reason carefully step by step, then state the final amount.";

  const runCase = async (model, level) => {
    const sid = await win.evaluate(() => window.atomnano.sessions.create({ name: "Think " + Date.now() }).then((v) => v.id));
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
    const streamChars = await win.evaluate((id) => (window.__thinkChars || {})[id] || 0, sid);
    const msgs = await win.evaluate((id) => window.atomnano.sessions.get(id).then((v) => (v.messages || []).map((m) => ({ r: m.role, t: m.text || "" }))), sid);
    const thinkChars = msgs.filter((m) => m.r === "thinking").reduce((n, m) => n + m.t.length, 0);
    const answer = msgs.filter((m) => m.r === "assistant").map((m) => m.t).join(" ");
    return { sid, done, errored, errText, sent, init, thinkChars, streamChars, answerLen: answer.length };
  };

  // Probe with "off" first to confirm we can run live at all.
  const probe = await runCase("claude-opus-4-8", "off");
  if (!probe.done && !probe.errored) {
    console.log("SKIP: no live run available (login/network)");
    await app.close();
    return;
  }

  const MODELS = ["claude-opus-4-8", "claude-opus-4-7"];
  const LEVELS = ["off", "think", "think-hard", "think-harder", "ultrathink"];

  for (const model of MODELS) {
    for (const level of LEVELS) {
      const r = (model === "claude-opus-4-8" && level === "off") ? probe : await runCase(model, level);
      console.log(`\n--- ${model} / ${level} ---`, JSON.stringify({
        done: r.done, errored: r.errored, errText: r.errText.slice(0, 120),
        thinking: r.sent && r.sent.thinking, effort: r.sent && r.sent.effort,
        thinkingConfig: r.sent && r.sent.thinkingConfig,
        maxThinkingTokens: r.sent && r.sent.maxThinkingTokens,
        initModel: r.init && r.init.model,
        thinkChars: r.thinkChars, streamChars: r.streamChars, answerLen: r.answerLen,
      }));
      ok(!r.errored, `${model}/${level}: NO error${r.errText ? " — " + r.errText.slice(0, 100) : ""}`);
      ok(r.answerLen > 0, `${model}/${level}: produced an assistant answer`);
      ok(!r.init || r.init.model === model, `${model}/${level}: CLI ran requested model (init=${r.init && r.init.model})`);
      if (level === "off") {
        ok(!(r.sent && r.sent.effort), `${model}/off: no effort sent`);
        ok(!(r.sent && r.sent.thinkingConfig), `${model}/off: no thinkingConfig sent`);
        ok((r.thinkChars + r.streamChars) === 0, `${model}/off: no thinking emitted (${r.streamChars}+${r.thinkChars})`);
      } else {
        ok((r.sent && r.sent.thinking) === level, `${model}/${level}: session.thinking = "${level}" (got "${r.sent && r.sent.thinking}")`);
        const wantEff = effortFor(model, level);
        ok((r.sent && r.sent.effort) === wantEff, `${model}/${level}: effort = "${wantEff}" (got "${r.sent && r.sent.effort}")`);
        ok(r.sent && r.sent.thinkingConfig && r.sent.thinkingConfig.type === "adaptive" && r.sent.thinkingConfig.display === "summarized",
          `${model}/${level}: adaptive thinking + summary requested`);
        ok((r.sent && r.sent.maxThinkingTokens) === 0, `${model}/${level}: no dead legacy budget on adaptive model`);
        ok((r.thinkChars + r.streamChars) > 0, `${model}/${level}: thinking SURFACED (${r.streamChars} streamed + ${r.thinkChars} block chars)`);
      }
    }
  }

  await app.close();
  console.log(process.exitCode ? "\nTHINKING-CLAUDE FAILED" : "\nTHINKING-CLAUDE PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
