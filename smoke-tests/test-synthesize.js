/* Synthesize → new session, end to end in the REAL Electron app on an isolated profile:
 * a fabricated conversation is synthesized; the new session must carry ONE condensed
 * `record` entry — the record (exact here, the conversation is small) plus the session map —
 * rendered as a structured handoff card with the exact model-visible text expandable, keep the
 * source's settings and show the source content — never a user message holding the whole
 * transcript. No model call is made (the seed is exact for a small conversation).
 * Writes test-results/synthesize-card.png. */
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
  // `selectedSkills` is a LEGACY per-chat selection (the composer control that set it left on 2026-09-18);
  // the store still persists it, and the plain continuation below must NOT inherit it.
  await win.evaluate(({ sid, msgs }) => window.atomnano.sessions.update(sid, { messages: msgs, permissionMode: "plan", oneM: true, selectedSkills: ["smoke-skill"] }), { sid, msgs });
  await win.evaluate((sid) => window.__reloadTab(sid), sid);
  await win.waitForTimeout(400);

  const synth = await win.evaluate((id) => window.__synthesize(id), sid);
  ok(synth && synth.id && synth.id !== sid, `synthesize created a NEW session (${synth && synth.name})`);
  ok(/^↻/.test(synth.name || ""), "the new session is marked as a continuation");
  const view = await win.evaluate((id) => window.atomnano.sessions.get(id), synth.id);
  ok(view.messages.length === 1 && view.messages[0].role === "record" && view.messages[0].carriedRecord === true, `the seed is ONE record entry (${view.messages.length} message(s), role ${view.messages[0] && view.messages[0].role})`);
  const seed = view.messages[0];
  ok(/Continued from/.test(seed.text) && /condensed handoff/.test(seed.text) && /verbatim/.test(seed.text), "a small conversation is carried exactly, labelled as a condensed handoff");
  ok(/AUTH login bug/.test(seed.text) && /Search implemented/.test(seed.text) && /\[Tool Read \(done\)\]/.test(seed.text), "the record carries user, assistant and tool entries");
  ok(/\[Session map — facts distilled/.test(seed.text) && /Goals the user pursued:\n- fix the AUTH login bug/.test(seed.text) && /Tools used: Read 1×/.test(seed.text), "the seed ends with the SESSION MAP (goals, tools) as labelled facts");
  ok(seed.meta && seed.meta.entries === 5 && seed.meta.mode === "exact" && seed.meta.map && seed.meta.map.total === 5 && seed.meta.map.userTurns === 2 && seed.meta.map.toolCalls === 1 && seed.text.length < 4000, `record metadata: ${JSON.stringify(seed.meta && { entries: seed.meta.entries, mode: seed.meta.mode, chars: seed.text.length, map: seed.meta.map && { total: seed.meta.map.total, userTurns: seed.meta.map.userTurns } })}`);
  ok(view.permissionMode === "plan" && view.oneM === true, `settings carried over (mode ${view.permissionMode}, 1M ${view.oneM})`);
  ok(!Array.isArray(view.selectedSkills) || view.selectedSkills.length === 0, `the plain continuation carries NO per-chat skills — only a workflow role's job session gets skills (${JSON.stringify(view.selectedSkills)})`);
  ok(!view.claudeSessionId && !view.codexThreadId, "no native thread id is carried into the new session");
  const card = await win.evaluate(() => {
    const c = document.querySelector("#chatMessages .record-card"); if (!c) return null;
    c.classList.add("open");
    return { head: c.querySelector(".thinking-head").textContent, structured: c.classList.contains("structured"), sections: [...c.querySelectorAll(".rc-title")].map((t) => t.textContent), chips: c.querySelectorAll(".rc-chip").length, raw: !!c.querySelector(".rc-raw .rc-pre"), rawChars: (c.querySelector(".rc-raw .rc-pre") || {}).textContent ? c.querySelector(".rc-raw .rc-pre").textContent.length : 0 };
  });
  ok(card && /Continued from/.test(card.head) && /condensed handoff/.test(card.head) && /5 entries verbatim/.test(card.head) && /session map/.test(card.head), `the record renders as a collapsible handoff card (${card && card.head})`);
  ok(card && card.structured && card.sections.includes("Goals pursued") && card.sections.includes("Tools used") && card.chips >= 4 && card.raw && card.rawChars === seed.text.length, `the card is structured — sections ${JSON.stringify(card && card.sections)}, ${card && card.chips} fact chips, exact model text expandable (${card && card.rawChars} chars)`);
  fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(ROOT, "test-results", "synthesize-card.png") });
  const srcView = await win.evaluate((id) => window.atomnano.sessions.get(id), sid);
  ok(srcView.messages.length === 5, "the source session keeps its complete transcript");
  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSYNTHESIZE SMOKE FAILED" : "\nSYNTHESIZE SMOKE PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
