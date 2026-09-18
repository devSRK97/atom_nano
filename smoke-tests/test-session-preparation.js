/* Session preparation lifecycle — "Synthesize → new session" as an honest, cancellable, deduplicated
 * run, end to end in the REAL Electron app on an isolated profile (smoke-tests/_env.js). No model is
 * called: a gated fake summariser is injected into the main process (setSummarizer) so every summary
 * request is visible to the test and finishes only when the test releases it.
 *
 * Covered (task T3 of "Session reliability", 2026-09-16):
 *   1. visible preparation — the source session is `running` with a `preparing` live label while its
 *      seed is summarised; runState / running / the composer's Stop button all agree; idle afterwards;
 *   2. duplicate Synthesize clicks share ONE job — one summariser chain, one new session, same id back;
 *   3. a busy primary (a live reply on the source) is rejected with a clear error, nothing is prepared;
 *   4. cancellation (Stop over IPC) releases the slot at once, the call resolves without a new session,
 *      and the abandoned summary finishing late still creates nothing;
 *   5. Stop from the composer, then an immediate new run on the same session — no "already running",
 *      the renderer keeps showing the NEWER run (no forced-idle timer), and the OLD run's late
 *      completion neither idles the newer run nor creates a phantom session;
 *   6. the source keeps its complete transcript throughout;
 *   7. the renderer's own Synthesize path opens the seeded tab (auto-resolving summariser);
 *   8. a PRIMARY run (the custom raw-HTTP provider against a local fake endpoint that answers only
 *      when told): Stop releases the slot at once, a send right after it is not refused as "already
 *      running", the stopped run's asynchronous wind-down never idles the newer run, and the
 *      endpoint's late answer to the stopped request changes nothing.
 * Providers: the same IPC / lifecycle runs under anthropic, openai and custom project settings (the
 * summariser receives the provider each source resolves to); the primary-run scenario uses custom.
 * Run: node smoke-tests/test-session-preparation.js
 * Set ATOMNANO_SMOKE_EXE to test a packaged executable with the same isolated profile. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { tmpRoot, isolatedEnv, cleanup } = require("./_env");

const ROOT = path.join(__dirname, "..");
const SOURCE_ENTRIES = 120;
// The honest live label while a seed is condensed (wording may evolve; it must name the work).
const PREP_LABEL = /Preparing|Condensing|Waiting for another summary/i;
let passN = 0, failN = 0;
const ok = (c, m) => { if (!c) { failN++; console.error("FAIL:", m); process.exitCode = 1; } else { passN++; console.log("PASS:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (x) => JSON.stringify(x === undefined ? null : x).slice(0, 300);
async function until(fn, { timeout = 8000, every = 50 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await sleep(every); }
  return null;
}

/* A source long enough that the seed MUST be condensed (summary of the oldest entries + newest
 * verbatim): ~120 entries, ~90K characters of record against the ~24K-character seed budget. */
function longTranscript(tag) {
  const msgs = []; const t0 = Date.UTC(2026, 0, 1);
  const filler = (i) => ` The ${tag} module ${i} handles retries, validation and logging; the change touched the handler, its guard and the tests, and the reviewer asked for clearer error messages plus a regression test that pins the fixed behaviour.`;
  for (let i = 0; i < SOURCE_ENTRIES; i++) {
    const ts = new Date(t0 + i * 1000).toISOString(); const id = `${tag}-m${i}`;
    if (i % 10 === 9) msgs.push({ id, role: "tool", toolName: "Read", toolInput: { file_path: `C:/p/${tag}/mod${i}.js` }, status: "done", result: `// ${tag} mod${i}\n` + "x".repeat(3000), ts });
    else if (i % 2 === 0) msgs.push({ id, role: "user", text: `Fix the ${tag.toUpperCase()} bug ${i} in the dashboard.` + filler(i).repeat(3), ts });
    else msgs.push({ id, role: "assistant", text: `Fixed ${tag} bug ${i - 1} and added a guard.` + filler(i).repeat(3), ts });
  }
  return msgs;
}

(async () => {
  const root = tmpRoot("session-preparation");
  const env = isolatedEnv(root);
  // Diagnostics for a hang: the main process's own output and the summariser call table.
  const mainLog = [];
  let diag = async () => "";
  let appRef = null;
  const watchdog = setTimeout(async () => {
    console.error("FAIL: watchdog — the suite did not finish within 300s (a hung preparation or a Stop that never released)");
    try { console.error("summariser calls: " + (await Promise.race([diag(), sleep(3000).then(() => "(unavailable)")]))); } catch { /* */ }
    console.error("main process log (tail):\n" + mainLog.join("").split("\n").slice(-40).join("\n"));
    try { if (appRef) await Promise.race([appRef.close(), sleep(5000)]); } catch { /* */ }   // never leave the app under test running
    cleanup(root);
    process.exit(2);
  }, 300000);
  // A local fake for the CUSTOM raw-HTTP provider (scenario 8): every request is recorded and
  // answered only when the test says so. Nothing leaves 127.0.0.1; no model is involved.
  const fake = { reqs: [], url: "" };
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      let body = null; try { body = JSON.parse(raw); } catch { /* not JSON */ }
      const entry = { n: fake.reqs.length + 1, body, closed: false, answered: false, respond(text) { if (entry.answered) return false; entry.answered = true; try { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: text } }] })); } catch { /* socket gone */ } return true; } };
      res.on("close", () => { entry.closed = true; });
      fake.reqs.push(entry);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const executablePath = process.env.ATOMNANO_SMOKE_EXE ? path.resolve(process.env.ATOMNANO_SMOKE_EXE) : null;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [ROOT]), "--user-data-dir=" + env.ATOMNANO_USER_DATA], env });
  appRef = app;
  try { app.process().stdout.on("data", (d) => mainLog.push(String(d))); app.process().stderr.on("data", (d) => mainLog.push(String(d))); } catch { /* no process handle */ }
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__reloadTab === "function" && typeof window.__synthesize === "function" && window.atomnano && window.atomnano.sessions && typeof window.atomnano.sessions.runState === "function", null, { timeout: 20000 });

  /* ---- the gated fake summariser (main process): every request is recorded; it resolves only when
   *      the test releases it (or at once while `auto` is on). ---- */
  await app.evaluate(() => {
    const G = (global.__prep = { calls: [], auto: false });
    G.autoText = (c) => `Auto summary #${c.n}: goals, decisions and outcomes of the earlier conversation.`;
    global.__claude.setSummarizer((provider, model, prompt) => new Promise((resolve, reject) => {
      const call = { n: G.calls.length + 1, provider, model, chars: String(prompt || "").length, done: false };
      call.resolve = (text) => { if (call.done) return; call.done = true; resolve(text); };
      call.reject = (msg) => { if (call.done) return; call.done = true; reject(new Error(msg)); };
      G.calls.push(call);
      if (G.auto) call.resolve(G.autoText(call));
    }));
    return true;
  });
  const calls = () => app.evaluate(() => global.__prep.calls.map((c) => ({ n: c.n, provider: c.provider, model: c.model, chars: c.chars, done: c.done })));
  diag = async () => JSON.stringify(await calls());
  const release = (n, text) => app.evaluate((_e, a) => { const c = global.__prep.calls[a.n - 1]; if (!c || c.done) return false; c.resolve(a.text); return true; }, { n, text });
  const setAuto = (on) => app.evaluate((_e, on) => { const G = global.__prep; G.auto = !!on; if (on) for (const c of G.calls) if (!c.done) c.resolve(G.autoText(c)); return G.auto; }, on);
  const waitCall = async (n) => { const got = await until(async () => { const c = await calls(); return c.length >= n ? c : null; }, { timeout: 15000 }); if (!got) throw new Error(`no summariser call #${n} within 15s`); return got[n - 1]; };
  const sourceCount = (id) => app.evaluate((_e, id) => { const s = global.__store.getSession(id); return s ? (s.archivedCount || 0) + s.messages.length : -1; }, id);
  const sessionCount = () => app.evaluate(() => global.__store.listSessions().length);
  const storeStatus = (id) => app.evaluate((_e, id) => { const s = global.__store.getSession(id); return s ? s.status : null; }, id);
  const runState = (id) => win.evaluate((id) => window.atomnano.sessions.runState(id), id);
  const running = (id) => win.evaluate((id) => window.atomnano.sessions.running(id), id);
  const interrupt = (id) => win.evaluate((id) => window.atomnano.sessions.interrupt(id, "stop"), id);
  const composer = () => win.evaluate(() => {
    const b = document.getElementById("sendBtn"), box = document.getElementById("composerBox"), lbl = document.querySelector("#chatLive .typing-label");
    return { stop: !!(b && b.classList.contains("stop")), disabled: !!(b && b.disabled), title: b ? b.title : "", running: !!(box && box.classList.contains("running")), label: lbl ? lbl.textContent : "" };
  });
  // Start a synthesis WITHOUT awaiting it: the promise lives in the page under `key`.
  const startSynth = (key, id) => win.evaluate((a) => { window.__prepP = window.__prepP || {}; window.__prepP[a.key] = window.atomnano.sessions.synthesize(a.id).then((v) => ({ ok: true, id: v ? v.id : null, name: v ? v.name : "" }), (e) => ({ ok: false, error: String((e && e.message) || e) })); return true; }, { key, id });
  const outcome = (key, ms = 4000) => win.evaluate((a) => Promise.race([window.__prepP[a.key], new Promise((r) => setTimeout(() => r({ pending: true }), a.ms))]), { key, ms });

  async function makeSource(tag, provider, model) {
    const cwd = path.join(root, "proj-" + tag).replace(/\\/g, "/"); fs.mkdirSync(cwd, { recursive: true });
    await app.evaluate((_e, a) => global.__store.saveSettings({ llmProvider: a.provider, defaultModel: a.model }, a.cwd), { cwd, provider, model });
    const view = await win.evaluate((a) => window.atomnano.sessions.create({ cwd: a.cwd, name: a.name, model: a.model }), { cwd, name: `${tag} source`, model });
    await win.evaluate((a) => window.atomnano.sessions.update(a.id, { messages: a.msgs, permissionMode: "plan" }), { id: view.id, msgs: longTranscript(tag) });
    return view.id;
  }

  const A = await makeSource("alpha", "anthropic", "claude-fable-5-1");
  const B = await makeSource("bravo", "openai", "gpt-5.5");
  const C = await makeSource("charlie", "anthropic", "claude-fable-5-1");
  const D = await makeSource("delta", "custom", "local-model");
  const E = await makeSource("echo", "anthropic", "claude-fable-5-1");
  const F = await makeSource("foxtrot", "openai", "gpt-5.5");
  const recordChars = await app.evaluate((_e, id) => { const s = global.__store.getSession(id); return s ? s.messages.reduce((n, m) => n + String(m.text || "").length + String(m.result || "").length, 0) : -1; }, A);
  ok((await sourceCount(A)) === SOURCE_ENTRIES && recordChars > 24000, `fixture: a source of ${SOURCE_ENTRIES} entries, ${recordChars} chars of conversation text — larger than the ~24K seed budget, so the seed must be summarised`);

  /* ================= 1. visible preparation (anthropic) ================= */
  console.log("\n-- 1. visible, honest preparation --");
  await win.evaluate((id) => window.__reloadTab(id), A);
  await sleep(300);
  let idle0 = await composer();
  ok(!idle0.stop && !idle0.running, `before: the composer is idle (${short(idle0)})`);
  let before = await sessionCount();
  await startSynth("a1", A);
  const c1 = await waitCall(1);
  ok(c1.provider === "anthropic" && c1.model === "claude-fable-5-1" && c1.chars > 20000, `the seed needs a summary: summariser call #1 on ${c1.provider}/${c1.model}, ${c1.chars} prompt chars`);
  let rs = await runState(A);
  ok(rs && rs.running === true && rs.status === "running", `runState(source) while preparing → ${short(rs)}`);
  ok(rs && rs.live && rs.live.status === "preparing" && PREP_LABEL.test(rs.live.label || ""), `runState carries the honest live label so a reconcile can restore it (${short(rs && rs.live)})`);
  ok((await running(A)) === true && (await storeStatus(A)) === "running", "sessions.running() and the stored status agree: running");
  let live = await until(async () => { const c = await composer(); return c.stop && PREP_LABEL.test(c.label) ? c : null; }, { timeout: 4000 });
  ok(!!live, `the composer shows Stop and a preparing label while the seed is summarised (${short(live || await composer())})`);
  ok(live && /\d/.test(live.label) && /entries|call/i.test(live.label), `the label reports real progress — entries and model calls (${live && live.label})`);
  ok((await outcome("a1", 300)).pending === true, "the Synthesize call is still pending while the summariser has not answered");
  ok((await sessionCount()) === before, "no session is created before the seed exists");
  ok(await release(1, "Summary A: the alpha bugs 0-99 were fixed one by one; each got a guard and a regression test."), "released summariser call #1");
  // The main process must finish AND its reply must be deliverable. A function inside the record's
  // meta (e.g. a progress callback left on the persisted `job`) cannot be structured-cloned: Electron
  // logs "An object could not be cloned" and never replies, so the renderer's invoke hangs forever and
  // the new session cannot even be opened (sessions:get fails the same way) until the app restarts.
  const created = await until(() => app.evaluate((_e, a) => {
    const s = global.__store.listSessions().find((x) => x.name === a.name); if (!s) return null;
    const full = global.__store.getSession(s.id);
    const fnPaths = []; const walk = (o, p, d) => { if (!o || typeof o !== "object" || d > 6) return; for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === "function") fnPaths.push(p + "." + k); else if (v && typeof v === "object") walk(v, p + "." + k, d + 1); } }; walk((full && full.messages) || [], "messages", 0);
    return { id: s.id, fnPaths };
  }, { name: "↻ alpha source" }), { timeout: 5000 });
  ok(!!created, `the main process created the continuation session (${short(created)})`);
  ok(created && created.fnPaths.length === 0, `no function is stored inside the new session's messages (IPC replies must be structured-cloneable) (${short(created && created.fnPaths)})`);
  let r1 = await outcome("a1");
  ok(!(r1 && r1.pending), `the renderer's Synthesize promise settles once the main process is done (${short(r1)}${/could not be cloned/.test(mainLog.join("")) ? " — main process: 'An object could not be cloned' — the reply was never delivered" : ""})`);
  ok(r1 && r1.ok && r1.id && r1.id !== A, `Synthesize resolved with a NEW session (${short(r1)})`);
  const seedA = r1 && r1.id ? await win.evaluate((id) => window.atomnano.sessions.get(id), r1.id) : null;
  ok(seedA && seedA.messages.length === 1 && seedA.messages[0].role === "record" && seedA.messages[0].meta && seedA.messages[0].meta.mode === "summary" && /Summary A: the alpha bugs/.test(seedA.messages[0].text), `the seed is ONE record entry in summary mode carrying the summariser's text (${seedA && seedA.messages[0] && short({ mode: seedA.messages[0].meta && seedA.messages[0].meta.mode, chars: seedA.messages[0].text.length, calls: seedA.messages[0].meta && seedA.messages[0].meta.job && seedA.messages[0].meta.job.calls })})`);
  ok(seedA && seedA.permissionMode === "plan" && !seedA.claudeSessionId && !seedA.codexThreadId, "settings carry over, no native thread id does");
  rs = await until(async () => { const s = await runState(A); return s && s.running === false ? s : null; }, { timeout: 3000 });
  ok(rs && rs.status === "idle" && (await storeStatus(A)) === "idle", `after: runState(source) → ${short(rs)}, stored status idle`);
  idle0 = await until(async () => { const c = await composer(); return !c.stop && !c.running && !c.label ? c : null; }, { timeout: 3000 });
  ok(!!idle0, `after: the composer is idle again, no live label (${short(idle0 || await composer())})`);
  ok((await sessionCount()) === before + 1, "exactly one session was created");
  const baselineCalls = (await calls()).length;
  ok(baselineCalls === 1, `one preparation = ${baselineCalls} summariser call (the head fits one request)`);

  /* ================= 2. duplicate clicks share one job (openai) ================= */
  console.log("\n-- 2. duplicate Synthesize requests share one job --");
  before = await sessionCount();
  await win.evaluate((id) => { window.__prepP = window.__prepP || {}; const wrap = (p) => p.then((v) => ({ ok: true, id: v ? v.id : null }), (e) => ({ ok: false, error: String((e && e.message) || e) })); window.__prepP.b1 = wrap(window.atomnano.sessions.synthesize(id)); window.__prepP.b2 = wrap(window.atomnano.sessions.synthesize(id)); return true; }, B);
  const c2 = await waitCall(2);
  ok(c2.provider === "openai" && c2.model === "gpt-5.5", `the openai source summarises on ${c2.provider}/${c2.model}`);
  await sleep(600);
  ok((await calls()).length === 2, `two concurrent requests → ONE summariser chain (${(await calls()).length - 1} call(s) for this source, not 2)`);
  ok((await outcome("b1", 200)).pending && (await outcome("b2", 200)).pending, "both requests wait on the same preparation");
  await release(2, "Summary B: bravo work, condensed.");
  const [b1, b2] = [await outcome("b1"), await outcome("b2")];
  ok(b1.ok && b2.ok && b1.id && b1.id === b2.id && b1.id !== B, `both requests resolve to the SAME new session (${short({ b1, b2 })})`);
  ok((await sessionCount()) === before + 1, "exactly one session was created for the two requests");
  rs = await until(async () => { const s = await runState(B); return s && s.running === false ? s : null; }, { timeout: 3000 });
  ok(rs && rs.status === "idle", `the source is idle afterwards (${short(rs)})`);
  // A later request on the same source reuses the cached checkpoints — no new model call.
  await startSynth("b3", B);
  const b3 = await outcome("b3", 8000);
  ok(b3.ok && b3.id && b3.id !== b1.id && (await calls()).length === 2, `a later Synthesize of the same source reuses the cached summary: new session, no extra summariser call (${(await calls()).length} total)`);

  /* ================= 3. busy primary is rejected (anthropic) ================= */
  console.log("\n-- 3. a source with a live reply cannot be synthesized --");
  before = await sessionCount();
  ok((await win.evaluate((id) => window.atomnano.test.fakeRunning(id, true), C)) === true, "pinned a live (fake) reply on the source");
  await startSynth("c1", C);
  const c3 = await outcome("c1", 4000);
  ok(c3 && c3.ok === false && /running|Stop|busy/i.test(c3.error || ""), `Synthesize is rejected with a clear error (${short(c3)})`);
  ok((await calls()).length === 2 && (await sessionCount()) === before, "nothing was summarised and no session was created");
  rs = await runState(C);
  ok(rs && rs.running === true, `runState reports the live reply (${short(rs)})`);
  await win.evaluate((id) => window.atomnano.test.fakeRunning(id, false), C);
  ok((await running(C)) === false, "unpinned the fake reply");

  /* ================= 4. cancellation over IPC (custom) ================= */
  console.log("\n-- 4. Stop cancels the preparation: slot released at once, no new session --");
  before = await sessionCount();
  await startSynth("d1", D);
  const c4 = await waitCall(3);
  ok(c4.provider === "custom" && c4.model === "local-model", `the custom source summarises on ${c4.provider}/${c4.model}`);
  ok((await runState(D)).running === true, "preparing → running");
  const stopped = await interrupt(D);
  rs = await runState(D);
  ok(stopped === true && rs && rs.running === false, `Stop returns true and the slot is released IMMEDIATELY (${short(rs)})`);
  const d1 = await outcome("d1", 3000);
  ok(d1 && !d1.pending && !d1.id, `the Synthesize call settles without a session (${short(d1)})`);
  ok((await sessionCount()) === before, "no session was created by the cancelled preparation");
  ok(await release(3, "Summary D, arriving after the user pressed Stop."), "the abandoned summariser call finishes late…");
  await sleep(500);
  ok((await sessionCount()) === before, "…and still creates no session");
  rs = await runState(D);
  ok(rs && rs.running === false && rs.status === "idle" && (await storeStatus(D)) === "idle", `the source is idle (${short(rs)})`);
  // Stop with nothing running is a no-op that does not fail.
  ok((await interrupt(D)) === false || (await runState(D)).running === false, "a second Stop with nothing running is harmless");

  /* ================= 5. Stop from the composer, immediate new run, late old completion ================= */
  console.log("\n-- 5. composer Stop → immediate new run; the old run's late completion is ignored --");
  await win.evaluate((id) => window.__reloadTab(id), E);
  await sleep(300);
  before = await sessionCount();
  await startSynth("e1", E);
  const c5 = await waitCall(4);
  ok(c5.provider === "anthropic", `run #1 on the echo source summarises on ${c5.provider}`);
  live = await until(async () => { const c = await composer(); return c.stop && PREP_LABEL.test(c.label) ? c : null; }, { timeout: 4000 });
  ok(!!live, `run #1 is visible in the composer (${short(live || await composer())})`);
  await win.click("#sendBtn");   // the primary button IS Stop while running
  rs = await until(async () => { const s = await runState(E); return s && s.running === false ? s : null; }, { timeout: 3000 });
  ok(!!rs, `the composer's Stop released the slot (${short(rs || await runState(E))})`);
  const e1 = await outcome("e1", 3000);
  ok(e1 && !e1.pending && !e1.id, `run #1 settled without a session (${short(e1)})`);
  // Immediately start run #2 on the same session — must not be refused as "already running".
  await startSynth("e2", E);
  const c6 = await waitCall(5);
  ok(!!c6 && (await outcome("e2", 200)).pending === true, "run #2 started at once after Stop — not rejected as already running");
  rs = await runState(E);
  ok(rs && rs.running === true && rs.status === "running", `runState → run #2 running (${short(rs)})`);
  live = await until(async () => { const c = await composer(); return c.stop && !c.disabled && PREP_LABEL.test(c.label) ? c : null; }, { timeout: 4000 });
  ok(!!live, `the composer shows run #2 (Stop enabled, preparing label) (${short(live || await composer())})`);
  // Past every renderer timer (old forced-idle 1200ms, reconcile 1500ms): the tab must still show run #2.
  await sleep(1800);
  let now = await composer();
  ok(now.stop && !now.disabled && now.running && PREP_LABEL.test(now.label), `1.8s later the composer still shows run #2 — no forced idle, the backend is the owner (${short(now)})`);
  ok((await runState(E)).running === true, "backend still running run #2");
  // The OLD run's summary arrives late: it must not idle run #2 nor create a session.
  ok(await release(4, "Summary E (run #1) — arriving after Stop and after run #2 began."), "released run #1's abandoned summariser call");
  await sleep(500);
  rs = await runState(E);
  ok(rs && rs.running === true && rs.status === "running", `run #1's late completion did NOT idle run #2 (${short(rs)})`);
  now = await composer();
  ok(now.stop && now.running && PREP_LABEL.test(now.label), `the composer still shows run #2 after run #1's late finally (${short(now)})`);
  ok((await sessionCount()) === before, "run #1 created no phantom session");
  ok((await storeStatus(E)) === "running", "the stored status stays running for run #2");
  // Finish run #2.
  ok(await release(5, "Summary E (run #2): echo bugs fixed, guards added."), "released run #2's summariser call");
  const e2 = await outcome("e2");
  ok(e2 && e2.ok && e2.id && e2.id !== E, `run #2 resolved with a new session (${short(e2)})`);
  const seedE = e2 && e2.id ? await win.evaluate((id) => window.atomnano.sessions.get(id), e2.id) : null;
  ok(seedE && seedE.messages.length === 1 && /Summary E \(run #2\)/.test(seedE.messages[0].text), "run #2's seed carries run #2's summary, not run #1's");
  rs = await until(async () => { const s = await runState(E); return s && s.running === false ? s : null; }, { timeout: 3000 });
  ok(rs && rs.status === "idle", `the source is idle after run #2 (${short(rs)})`);
  idle0 = await until(async () => { const c = await composer(); return !c.stop && !c.running && !c.label ? c : null; }, { timeout: 3000 });
  ok(!!idle0, `the composer is idle again (${short(idle0 || await composer())})`);
  ok((await sessionCount()) === before + 1, "exactly one session came out of the two runs");

  /* ================= 6. the source keeps its transcript ================= */
  console.log("\n-- 6. sources preserved --");
  for (const [tag, id] of [["alpha", A], ["bravo", B], ["charlie", C], ["delta", D], ["echo", E]]) {
    const n = await sourceCount(id);
    ok(n === SOURCE_ENTRIES, `${tag} source keeps its ${SOURCE_ENTRIES} entries (${n})`);
  }

  /* ================= 7. the renderer's own Synthesize path (openai, auto summariser) ================= */
  console.log("\n-- 7. renderer Synthesize opens the seeded tab --");
  await setAuto(true);
  before = await sessionCount();
  const ui = await win.evaluate((id) => Promise.race([window.__synthesize(id), new Promise((r) => setTimeout(() => r({ pending: true }), 15000))]), F);
  ok(ui && !ui.pending && ui.id && ui.id !== F && /^↻/.test(ui.name || ""), `the renderer path opened a NEW continuation tab (${short(ui)})`);
  ok(/Continued from/.test(ui && ui.first || "") && /Auto summary #/.test(ui && ui.first || ""), "its first entry is the handoff record with the summary");
  const card = await until(() => win.evaluate(() => { const c = document.querySelector("#chatMessages .record-card"); return c ? { head: c.querySelector(".thinking-head") && c.querySelector(".thinking-head").textContent } : null; }), { timeout: 3000 });
  ok(card && /Continued from/.test(card.head || ""), `the handoff card is rendered (${short(card)})`);
  ok((await runState(F)).running === false && (await sessionCount()) === before + 1, "the source is idle and exactly one session was created");
  ok((await sourceCount(F)) === SOURCE_ENTRIES, "foxtrot source keeps its transcript");
  await setAuto(false);

  /* ================= 8. a PRIMARY run on the custom endpoint: Stop → immediate new send ================= */
  console.log("\n-- 8. primary run (custom endpoint): Stop releases the slot, the next send starts at once, the stopped run never idles it --");
  const golfCwd = path.join(root, "proj-golf").replace(/\\/g, "/"); fs.mkdirSync(golfCwd, { recursive: true });
  await app.evaluate((_e, a) => global.__store.saveSettings({ llmProvider: "custom", defaultModel: "custom-default", customMode: "raw", customEndpoint: a.url, customHeaders: "", customPayloadTemplate: '{"model":"{{model}}","system":"{{system}}","prompt":"{{prompt}}"}', customOutputPath: "choices[0].message.content", customApiKey: "" }, a.cwd), { cwd: golfCwd, url: fake.url });
  const G = (await win.evaluate((a) => window.atomnano.sessions.create({ cwd: a.cwd, name: "golf primary", model: "custom-default" }), { cwd: golfCwd })).id;
  await win.evaluate((id) => window.__reloadTab(id), G);
  await sleep(300);
  const sendText = (id, text) => win.evaluate((a) => window.atomnano.sessions.send(a.id, { text: a.text }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: String((e && e.message) || e) })), { id, text });
  const s1 = await sendText(G, "First question for the endpoint");
  ok(s1.ok, `send #1 accepted (${short(s1)})`);
  const q1 = await until(() => (fake.reqs.length >= 1 ? fake.reqs[0] : null), { timeout: 10000 });
  ok(!!(q1 && q1.body && q1.body.prompt === "First question for the endpoint"), `the fake endpoint received request #1 with the exact prompt (${short(q1 && q1.body && { model: q1.body.model, prompt: q1.body.prompt, systemChars: String(q1.body.system || "").length })})`);
  rs = await runState(G);
  ok(rs && rs.running === true && rs.status === "running", `runState → running while the endpoint has not answered (${short(rs)})`);
  now = await until(async () => { const c = await composer(); return c.stop ? c : null; }, { timeout: 3000 });
  ok(!!now, `the composer shows Stop for the primary run (${short(now || await composer())})`);
  const stopped2 = await interrupt(G);
  rs = await runState(G);
  ok(stopped2 === true && rs && rs.running === false, `Stop releases the primary run's slot immediately (${short(rs)})`);
  ok((await until(() => (q1 && q1.closed ? true : null), { timeout: 3000 })) === true, "request #1 was aborted at the endpoint (its socket closed)");
  const t0 = Date.now();
  const s2 = await sendText(G, "Second question, sent right after Stop");
  ok(s2.ok, `send #2 right after Stop is accepted — not refused as already running (${Date.now() - t0}ms; ${short(s2)})`);
  const q2 = await until(() => (fake.reqs.length >= 2 ? fake.reqs[1] : null), { timeout: 10000 });
  ok(!!(q2 && q2.body && q2.body.prompt === "Second question, sent right after Stop"), `the endpoint received request #2 (${short(q2 && q2.body && { prompt: q2.body.prompt })})`);
  ok(!!(q2 && /First question for the endpoint/.test(String(q2.body.system || ""))), "request #2 carries the record so far (the stopped first question) as its system context");
  await sleep(900);
  rs = await runState(G);
  ok(rs && rs.running === true && rs.status === "running" && (await storeStatus(G)) === "running", `0.9s later run #2 is still running — the stopped run's wind-down did not idle it (${short(rs)})`);
  now = await composer();
  ok(now.stop && now.running, `the composer still shows Stop for run #2 (${short(now)})`);
  ok(q2.respond("Reply to the second question."), "the endpoint answers request #2");
  rs = await until(async () => { const s = await runState(G); return s && s.running === false ? s : null; }, { timeout: 5000 });
  ok(rs && (rs.status === "done" || rs.status === "idle"), `run #2 finished (${short(rs)})`);
  const gView = await win.evaluate((id) => window.atomnano.sessions.get(id), G);
  const gMsgs = (gView && gView.messages) || [];
  const replies = gMsgs.filter((m) => m.role === "assistant");
  ok(replies.length === 1 && /Reply to the second question/.test(replies[0].text || ""), `exactly one reply, and it is run #2's (${short(gMsgs.map((m) => m.role + (m.role === "assistant" || m.role === "system" ? ":" + String(m.text || "").slice(0, 40) : "")))})`);
  ok(gMsgs.filter((m) => m.role === "user").length === 2 && gMsgs.some((m) => m.role === "system" && /Stopped/.test(m.text || "")), "both prompts and the Stop marker are in the transcript");
  q1.respond("Late reply to the first question.");
  await sleep(400);
  const gView2 = await win.evaluate((id) => window.atomnano.sessions.get(id), G);
  ok(((gView2 && gView2.messages) || []).filter((m) => m.role === "assistant").length === 1 && (await runState(G)).running === false, "the endpoint's late answer to the stopped request changes nothing");
  idle0 = await until(async () => { const c = await composer(); return !c.stop && !c.running ? c : null; }, { timeout: 3000 });
  ok(!!idle0, `the composer is idle again (${short(idle0 || await composer())})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  const cloneFailures = mainLog.join("").split("\n").filter((l) => /could not be cloned/i.test(l));
  ok(cloneFailures.length === 0, "every IPC reply and event was serialisable (no 'An object could not be cloned' in the main process)" + (cloneFailures.length ? ` — ${cloneFailures.length} failure(s): ${cloneFailures.slice(0, 3).join(" | ").slice(0, 300)}` : ""));
  await app.close();
  server.close();
  clearTimeout(watchdog);
  cleanup(root);
  console.log(`\n${passN} passed, ${failN} failed`);
  console.log(process.exitCode ? "\nSESSION PREPARATION SMOKE FAILED" : "\nSESSION PREPARATION SMOKE PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
