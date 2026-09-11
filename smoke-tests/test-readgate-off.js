/* LIVE smoke: a repeat Read of an unchanged file is NOT denied.
 *
 * readgate used to deny a byte-identical second Read with a pointer to the copy
 * already in context. It is off by default now — re-reading is the agent's call,
 * not ours. This pins that: two Reads of the same file, no denial in between.
 *
 * Skips gracefully if there's no login / network.
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const MODEL = process.env.HARNESS_MODEL || "claude-opus-5";
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

function freshDir() {
  for (let i = 0; i < 20; i++) {
    const p = path.join(os.tmpdir(), "atomnano-readgate" + (i ? "-" + i : ""));
    try { fs.rmSync(p, { recursive: true, force: true }); fs.mkdirSync(p, { recursive: true }); return p; }
    catch { /* locked by a previous run — try the next slot */ }
  }
  throw new Error("no writable temp project dir");
}
const CWD = freshDir();

(async () => {
  console.log("project:", CWD, "| model:", MODEL);
  fs.writeFileSync(path.join(CWD, "notes.md"), "# Notes\n\nalpha\nbravo\ncharlie\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 20000 });

  // llmProvider is PROJECT-scoped and settings.set() writes to the window's project.
  await win.evaluate((cwd) => window.atomnano.win.setProject(cwd), CWD);
  const prev = await win.evaluate(() => window.atomnano.settings.get().then((s) => ({ model: s.defaultModel, provider: s.llmProvider })));
  await win.evaluate((m) => window.atomnano.settings.set({ defaultModel: m, llmProvider: "anthropic", enableReadGate: false, enableFrugalContext: false }), MODEL);
  const restore = () => win.evaluate((p) => window.atomnano.settings.set({ defaultModel: p.model, llmProvider: p.provider }), prev).catch(() => {});

  const id = await win.evaluate((cwd) => window.atomnano.sessions.create({ name: "readgate", cwd }).then((v) => v.id), CWD);
  await win.evaluate(({ sid, model }) => window.atomnano.sessions.send(sid, {
    text: "Read notes.md. Then read notes.md a second time to double-check, and tell me what the fourth line says.",
    provider: "anthropic", model, permissionMode: "bypassPermissions", thinking: "low",
  }), { sid: id, model: MODEL });

  const start = Date.now();
  while (Date.now() - start < 240000) {
    await win.waitForTimeout(1000);
    const running = await win.evaluate((sid) => window.atomnano.sessions.running(sid), id);
    if (!running && Date.now() - start > 4000) break;
  }

  const msgs = await win.evaluate((sid) => window.atomnano.sessions.get(sid).then((v) => (v.messages || []).map((m) => ({
    role: m.role, tool: m.toolName || null, status: m.status || null, text: (m.text || "").slice(0, 300), result: String(m.result || "").slice(0, 300),
  }))), id);
  const errored = msgs.find((m) => m.role === "error");
  if (errored) {
    console.log("SKIP: run errored (likely no login/network):", (errored.text || "").slice(0, 140));
    await restore(); await app.close();
    console.log("\nREADGATE-OFF SMOKE SKIPPED");
    return;
  }

  const reads = msgs.filter((m) => m.role === "tool" && m.tool === "Read");
  const gated = msgs.filter((m) => m.role === "tool" && /already in your context|already read|readgate/i.test(m.result));
  console.log("tool calls:", msgs.filter((m) => m.role === "tool").map((m) => m.tool).join(", ") || "(none)");
  console.log("Read calls:", reads.length, "| denied as duplicate:", gated.length);

  // NOT asserted: that the model actually reads twice. With the frugal skill on,
  // "never re-read an unchanged file" is an instruction it follows, so a single
  // Read says nothing about the gate. What this pins is that nothing DENIES a
  // second read when the model wants one.
  console.log(reads.length >= 2
    ? "NOTE: the model re-read the file"
    : "NOTE: the model chose not to re-read (prompt-level, not the gate)");
  ok(gated.length === 0, "no Read was denied as a duplicate");
  ok(!reads.some((r) => r.status === "error"), "no Read came back as an error");
  const reply = msgs.filter((m) => m.role === "assistant").map((m) => m.text).join(" ");
  ok(/bravo/i.test(reply), `the answer used the file contents (said: "${reply.replace(/\s+/g, " ").slice(0, 60)}")`);

  await restore();
  await app.close();
  console.log(process.exitCode ? "\nREADGATE-OFF SMOKE FAILED" : "\nREADGATE-OFF SMOKE PASSED");
})().catch((e) => { console.error("READGATE-OFF SMOKE ERROR:", (e && e.message) || e); process.exit(1); });
