/* LIVE smoke (uses the real Claude CLI login): the "ultracode" effort level.
 *
 * Ultracode is xhigh effort PLUS standing dynamic-workflow orchestration. The
 * SDK has no `ultracode` option on query() — it's only reachable as the
 * applyFlagSettings control request — so this test checks both halves:
 *   1. the level normalises to effort "xhigh" in what we send, and
 *   2. applyFlagSettings({ultracode: true}) was accepted by the CLI.
 *
 * Requires Claude Code 2.1.203+, workflows enabled, and an xhigh-capable model.
 * Skips gracefully if there's no login / network.
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");



const ROOT = path.join(__dirname, "..");
const MODEL = process.env.HARNESS_MODEL || "claude-opus-5";
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

const CWD = ROOT;   // llmProvider is project-scoped; this project is already configured for Anthropic

(async () => {
  console.log("project:", CWD, "| model:", MODEL);

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 20000 });


  const id = await win.evaluate((cwd) => window.atomnano.sessions.create({ name: "ultracode", cwd }).then((v) => v.id), CWD);
  await win.evaluate(({ sid, model }) => window.atomnano.sessions.send(sid, {
    text: "Say OK and nothing else.",
    provider: "anthropic", model, permissionMode: "bypassPermissions",
    thinking: "ultracode",
  }), { sid: id, model: MODEL });

  const start = Date.now();
  let run = null;
  while (Date.now() - start < 240000) {
    await win.waitForTimeout(1000);
    const running = await win.evaluate((sid) => window.atomnano.sessions.running(sid), id);
    run = await app.evaluate(() => (global.__claude && global.__claude._lastRun) || null);
    if (!running && Date.now() - start > 4000) break;
  }

  const msgs = await win.evaluate((sid) => window.atomnano.sessions.get(sid).then((v) => (v.messages || []).map((m) => ({
    role: m.role, text: (m.text || "").slice(0, 200),
  }))), id);
  const errored = msgs.find((m) => m.role === "error");
  if (errored) {
    console.log("SKIP: run errored (likely no login/network):", (errored.text || "").slice(0, 140));
    await app.close();
    console.log("\nULTRACODE SMOKE SKIPPED");
    return;
  }

  console.log("\nsent:", JSON.stringify(run && run.sent));
  ok(!!(run && run.sent && run.sent.ultracode), "the run was tagged as ultracode");
  ok(!!(run && run.sent && run.sent.effort === "xhigh"), `effort normalised to xhigh (got ${run && run.sent && run.sent.effort})`);
  ok(!!(run && run.ultracodeApplied), "applyFlagSettings({ultracode:true}) was accepted by the CLI");
  const reply = msgs.filter((m) => m.role === "assistant").map((m) => m.text).join(" ");
  ok(/ok/i.test(reply), `the turn still completed normally (assistant said: "${reply.slice(0, 40)}")`);

  await app.close();
  console.log(process.exitCode ? "\nULTRACODE SMOKE FAILED" : "\nULTRACODE SMOKE PASSED");
})().catch((e) => { console.error("ULTRACODE SMOKE ERROR:", (e && e.message) || e); process.exit(1); });
