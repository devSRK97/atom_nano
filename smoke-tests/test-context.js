/* Context window + prevent-sleep:
 *  - context.info reports a session's window picture before any turn — the window from the
 *    catalog, nothing used, no native thread, no digest — through the current context API
 *    (context:info / rollover / digest). The old unified "context.compose" block (project memory
 *    graph + tree + load-bearing files + available skills) is gone with the graph and the Skills
 *    dock (2026-09-18): no context.peek / context.compose / atom.graph on the bridge.
 *  - the one-shot rollover flag round-trips (context.rollover → info.forceRollover)
 *  - the prevent-sleep setting persists (drives powerSaveBlocker in main)
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-context");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, "src"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "package.json"), '{"name":"demo","scripts":{"test":"node t"}}\n');
  fs.writeFileSync(path.join(DIR, "src", "a.js"), "exports.compute=(x)=>x+1;\n");

  const udir = path.join(os.tmpdir(), "atomnano-context-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && window.atomnano && window.atomnano.context, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* ---------- the removed compose/graph surface is gone ---------- */
  const api = await win.evaluate(() => ({ peek: typeof window.atomnano.context.peek, compose: typeof window.atomnano.context.compose, graph: typeof window.atomnano.graph, info: typeof window.atomnano.context.info, rollover: typeof window.atomnano.context.rollover, digest: typeof window.atomnano.context.digest }));
  ok(api.peek === "undefined" && api.compose === "undefined" && api.graph === "undefined", "no context.peek / context.compose / atom.graph on the bridge");
  ok(api.info === "function" && api.rollover === "function" && api.digest === "function", "context.info / rollover / digest are the context API");

  /* ---------- context.info before any turn ---------- */
  const sid = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l[0] && l[0].id));
  ok(!!sid, "a session exists to ask about");
  const info = await win.evaluate((id) => window.atomnano.context.info(id), sid);
  ok(info && typeof info.window === "number" && info.window > 0, `info reports the effective window (${info && info.window} tokens, ${info && info.windowSource})`);
  ok(info && info.used === 0 && info.pct === 0 && info.source === "none", `nothing used yet (used ${info && info.used}, pct ${info && info.pct}, source ${info && info.source})`);
  ok(info && info.thread === false && info.digest === null && info.compactions === 0, "no native thread, no digest, no compactions before the first turn");
  ok(info && typeof info.totalEntries === "number" && typeof info.rolloverPct === "number" && info.forceRollover === false, `record size + rollover picture present (entries ${info && info.totalEntries}, rollover at ${info && info.rolloverPct}%)`);

  /* ---------- the one-shot rollover flag round-trips ---------- */
  const armed = await win.evaluate((id) => window.atomnano.context.rollover(id, true), sid);
  const info2 = await win.evaluate((id) => window.atomnano.context.info(id), sid);
  ok(armed === true && info2 && info2.forceRollover === true, "rollover(true) arms the next-message rollover");
  await win.evaluate((id) => window.atomnano.context.rollover(id, false), sid);
  const info3 = await win.evaluate((id) => window.atomnano.context.info(id), sid);
  ok(info3 && info3.forceRollover === false, "rollover(false) disarms it again");

  /* ---------- prevent-sleep setting persists ---------- */
  const set = await win.evaluate(() => window.atomnano.settings.set({ preventSleep: true }));
  ok(set.preventSleep === true, "prevent-sleep setting is accepted");
  const got = await win.evaluate(() => window.atomnano.settings.get());
  ok(got.preventSleep === true, "prevent-sleep setting persists (drives powerSaveBlocker in main)");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME CONTEXT TESTS FAILED" : "\nALL CONTEXT TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
