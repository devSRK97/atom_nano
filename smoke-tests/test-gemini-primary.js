/* Gemini as a full-fledged streaming PRIMARY (not just a reviewer).
 * Drives the real GeminiClient over a scripted in-process ACP agent (no live
 * CLI) and verifies the protocol mapping:
 *   - streamed assistant text + a thought become messages
 *   - a tool_call renders a tool card that resolves to done
 *   - a session/request_permission round-trips through the user gate
 *   - on allow → fs/write_text_file lands a file in the workspace
 *   - on deny  → no file is written and the tool card fails
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-gemini");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-gemini-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => window.atomnano.test && window.atomnano.test.geminiRun, null, { timeout: 15000 });
  const CWD = DIR.replace(/\\/g, "/");
  await win.evaluate(() => window.atomnano.test.geminiRunner());   // inject scripted ACP agent + auto-permission

  /* ---------- allow path ---------- */
  const allow = await win.evaluate((cwd) => window.atomnano.test.geminiRun(cwd, "create out.txt", "allow"), CWD);
  ok(allow.lastRun && allow.lastRun.provider === "google", "run routed to the Gemini primary backend");
  ok(allow.lastRun.thinking === "think-harder", `the chosen reasoning level is applied + recorded (${allow.lastRun.thinking})`);
  ok(/Reasoning guidance/.test((allow.promptBlocks && allow.promptBlocks[0] && allow.promptBlocks[0].text) || ""), "the reasoning level steers the Gemini prompt");
  const asst = allow.msgs.find((m) => m.role === "assistant");
  ok(asst && /Hello from Gemini/.test(asst.text), `streamed assistant text became a message (${asst && JSON.stringify(asst.text)})`);
  ok(allow.msgs.some((m) => m.role === "thinking"), "the agent thought chunk became a thinking message");
  const tool = allow.msgs.find((m) => m.role === "tool");
  ok(tool && /out\.txt/i.test(tool.toolName) && tool.status === "done", `tool_call rendered a card that resolved to done (${tool && tool.status})`);
  ok(allow.perm && allow.perm.outcome === "selected" && /allow/i.test(allow.perm.optionId), `permission allowed → ACP optionId mapped (${allow.perm && allow.perm.optionId})`);
  ok(allow.wrote === true, "allow → Gemini's fs/write_text_file landed a file in the workspace");

  /* ---------- deny path ---------- */
  fs.rmSync(path.join(DIR, "out.txt"), { force: true });
  const deny = await win.evaluate((cwd) => window.atomnano.test.geminiRun(cwd, "create out.txt again", "deny"), CWD);
  ok(deny.perm && /reject/i.test(deny.perm.optionId), `permission denied → reject optionId mapped (${deny.perm && deny.perm.optionId})`);
  ok(deny.wrote === false, "deny → no file written");
  const dtool = deny.msgs.find((m) => m.role === "tool");
  ok(dtool && dtool.status === "error", `denied tool card marked failed (${dtool && dtool.status})`);

  /* ---------- multimodal prompt: image + doc attachments ---------- */
  fs.writeFileSync(path.join(DIR, "notes.md"), "# Notes\nsome content");
  const atts = [
    { kind: "image", data: "iVBORw0KGgoAAAANSUhEUg==", mediaType: "image/png", name: "shot.png" },
    { kind: "file", path: CWD + "/notes.md", name: "notes.md", mediaType: "text/markdown" },
  ];
  const mm = await win.evaluate(({ cwd, atts }) => window.atomnano.test.geminiRun(cwd, "what's in these?", "allow", atts), { cwd: CWD, atts });
  const blocks = mm.promptBlocks || [];
  const imgBlock = blocks.find((b) => b.type === "image");
  ok(imgBlock && imgBlock.data === "iVBORw0KGgoAAAANSUhEUg==" && imgBlock.mimeType === "image/png", "image attachment → ACP image block with base64 data + mimeType");
  const linkBlock = blocks.find((b) => b.type === "resource_link");
  ok(linkBlock && /notes\.md$/.test(linkBlock.uri) && /^file:/.test(linkBlock.uri), `doc attachment → ACP resource_link block (${linkBlock && linkBlock.uri})`);
  const textBlock = blocks.find((b) => b.type === "text");
  ok(textBlock && /notes\.md/.test(textBlock.text), "attached doc path is also listed in the text (fs-read fallback)");
  ok(mm.lastRun && mm.lastRun.attachments === 2, `run records the attachment count (${mm.lastRun && mm.lastRun.attachments})`);

  /* ---------- native session resume across turns ---------- */
  const r = await win.evaluate((cwd) => window.atomnano.test.geminiResume(cwd), CWD);
  ok(r.sid1 && r.sid1 === r.sid2, `the ACP session id persists across turns (${r.sid1} → ${r.sid2})`);
  ok(r.firstResumed === false, "first turn opens a fresh session (nothing to resume)");
  ok(r.secondResumed === true, "second turn natively resumes via session/load");
  ok(r.replayed === false, "session/load history replay is suppressed (not duplicated into the chat)");
  ok(r.assistantCount === 2, `one assistant reply per turn, no replay duplication (${r.assistantCount})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME GEMINI-PRIMARY TESTS FAILED" : "\nALL GEMINI-PRIMARY TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
