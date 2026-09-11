/* Synthesize → new session, end to end in the REAL Electron app on an isolated profile:
 * a fabricated conversation is synthesized; the new session must carry ONE bounded
 * `record` entry (rendered as a collapsible card), keep the source's settings and show
 * the source content — never a user message holding the whole transcript. No model call
 * is made (the seed is exact for a small conversation). */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-synth");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-synth-udata"); fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1", ATOMNANO_USER_DATA: udir } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__reloadTab === "function" && typeof window.__synthesize === "function" && window.atomnano, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const msgs = [
    { id: "m0", role: "user", text: "fix the AUTH login bug", ts: new Date(2026, 0, 1, 0, 0, 0).toISOString() },
    { id: "m1", role: "assistant", text: "I fixed the login flow and added a guard.", ts: new Date(2026, 0, 1, 0, 0, 1).toISOString() },
    { id: "m2", role: "tool", toolName: "Read", toolInput: { file_path: "C:\\p\\auth.js" }, status: "done", result: "function login() {}", ts: new Date(2026, 0, 1, 0, 0, 2).toISOString() },
    { id: "m3", role: "user", text: "add a SEARCH feature to the sidebar", ts: new Date(2026, 0, 1, 0, 0, 3).toISOString() },
    { id: "m4", role: "assistant", text: "Search implemented.", ts: new Date(2026, 0, 1, 0, 0, 4).toISOString() },
  ];
  const sid = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l[0] && l[0].id));
  await win.evaluate(({ sid, msgs }) => window.atomnano.sessions.update(sid, { messages: msgs, permissionMode: "plan", oneM: true, selectedSkills: ["smoke-skill"] }), { sid, msgs });
  await win.evaluate((sid) => window.__reloadTab(sid), sid);
  await win.waitForTimeout(400);

  const synth = await win.evaluate((id) => window.__synthesize(id), sid);
  ok(synth && synth.id && synth.id !== sid, `synthesize created a NEW session (${synth && synth.name})`);
  ok(/^↻/.test(synth.name || ""), "the new session is marked as a continuation");
  const view = await win.evaluate((id) => window.atomnano.sessions.get(id), synth.id);
  ok(view.messages.length === 1 && view.messages[0].role === "record" && view.messages[0].carriedRecord === true, `the seed is ONE record entry (${view.messages.length} message(s), role ${view.messages[0] && view.messages[0].role})`);
  ok(/Continued from/.test(view.messages[0].text) && /verbatim/.test(view.messages[0].text), "a small conversation is carried exactly, labelled as such");
  ok(/AUTH login bug/.test(view.messages[0].text) && /Search implemented/.test(view.messages[0].text) && /\[Tool Read \(done\)\]/.test(view.messages[0].text), "the record carries user, assistant and tool entries");
  ok(view.messages[0].meta && view.messages[0].meta.entries === 5 && view.messages[0].meta.mode === "exact", `record metadata: ${JSON.stringify(view.messages[0].meta && { entries: view.messages[0].meta.entries, mode: view.messages[0].meta.mode })}`);
  ok(view.permissionMode === "plan" && view.oneM === true && Array.isArray(view.selectedSkills) && view.selectedSkills[0] === "smoke-skill", `settings carried over (mode ${view.permissionMode}, 1M ${view.oneM}, skills ${JSON.stringify(view.selectedSkills)})`);
  ok(!view.claudeSessionId && !view.codexThreadId, "no native thread id is carried into the new session");
  const card = await win.evaluate(() => { const c = document.querySelector("#chatMessages .record-card"); return c ? { head: c.querySelector(".thinking-head").textContent, hasBody: !!c.querySelector(".thinking-body") } : null; });
  ok(card && /Continued from/.test(card.head) && /5 entries carried \(verbatim\)/.test(card.head) && card.hasBody, `the record renders as a collapsible card (${card && card.head})`);
  const srcView = await win.evaluate((id) => window.atomnano.sessions.get(id), sid);
  ok(srcView.messages.length === 5, "the source session keeps its complete transcript");
  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSYNTHESIZE SMOKE FAILED" : "\nSYNTHESIZE SMOKE PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
