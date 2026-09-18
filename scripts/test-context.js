"use strict";
/* Context-continuity regression suite — DESIRED behaviour for the findings of
 * ATOMNANO_CONTEXT_CONTINUITY_AUDIT_2026-09-10 (CTX-001..CTX-019), converted from the audit's
 * characterization checks (their C-ids are kept). Built the way the audit's harness was: the
 * ORIGINAL session modules (src/main/session/) are loaded in a VM with the SDK, Codex app-server, Codex exec and
 * the summariser injected (recording / fault-injecting fakes); store.js, history.js and agents/skills.js are
 * the REAL modules on an isolated data home (the skills store is a real, controlled dependency: the delivery
 * checks below create, edit and remove skills through it — an absent module used to be swallowed silently).
 * No credentials, no network, no model requests, no saved conversations.  Run: node scripts/test-context.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const ROOT = path.join(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-context-"));
process.env.ATOMNANO_MAX_MESSAGES = "60";
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, "claude-home"); fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
process.env.CODEX_HOME = path.join(HOME, "codex-home"); fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === "electron") return { app: { getPath: (k) => (k === "userData" ? HOME : os.homedir()), getAppPath: () => ROOT, isPackaged: false } }; return origLoad.call(this, req, ...rest); };

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 600) : ""}`); } }
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 240000);

const store = require(path.join(ROOT, "src/main/storage/store.js"));
const history = require(path.join(ROOT, "src/main/storage/history.js"));
const skillsMod = require(path.join(ROOT, "src/main/agents/skills.js"));   // real per-project skills store, under the isolated HOME
store.loadSettings();
store.saveSettings({ modeNote: false });   // the default-on mode note (2026-09-18) is off here: this suite asserts bare solo turns / exact Codex appendices (test-workflow W29 covers the note)
const src = { sessions: fs.readFileSync(path.join(ROOT, "src/main/ipc/sessions.js"), "utf8") };   // the sessions:* IPC module
const { loadSessionInVm } = require("./lib/session-vm");   // the ORIGINAL session modules, fakes injected

/* One isolated SessionManager with recording fakes. */
function environment({ oneMCap = false } = {}) {
  const sdkCalls = [], appCalls = [], injections = [], summaryCalls = [], sends = [];
  // Fault injection for the Codex app-server fake, in the order the real transport fails:
  //   appEarly   before any thread exists (the app-server cannot start)
  //   appBefore  after the thread holds the record but BEFORE it accepts the prompt (no turn/started → no onTurnId,
  //              nothing committed): a rejected request — network down, an HTTP failure before dispatch
  //   app        AFTER acceptance (onTurnId ran, the hashes are committed): the turn started, then broke / was stopped
  const control = { account: "login", sdk: null, app: null, appBefore: null, appEarly: null, onInject: null, exec: null, custom: null };
  const providers = {
    get: (p) => ({ label: p, models: p === "openai" ? [{ id: "gpt-5.5", ctx: 272000 }] : [{ id: "claude-opus-4-8", ctx: 200000, ctx1m: oneMCap }], defaultModel: p === "openai" ? "gpt-5.5" : "claude-opus-4-8", defaultReasoning: "low", primary: "sdk" }),
    context1M: (p) => p === "anthropic" && oneMCap, resolveOpenAIModelStrict: (id) => ({ model: id || "gpt-5.5" }), resolveOpenAIModel: (id) => ({ model: id || "gpt-5.5" }), openaiEffortStrict: (e) => ({ effort: e || "low" }), openaiEffort: () => "low",
  };
  const sdk = { query(opts) { return (async function* () {
    let prompt = opts.prompt;
    // Like the real SDK: the prompt stream is read CONCURRENTLY with the output — the app holds it
    // open until this turn's result (see buildPrompt), so it must never be drained up front. Every LATER
    // message the app pushes onto it (a steer) is recorded on the call (`inputs`) — the reset checks (K11c / K11d)
    // assert that NOTHING is pushed after a conversation_reset (nothing is injected mid-run, decision 2026-09-18).
    const inputs = [];
    if (typeof prompt !== "string") { const it = prompt[Symbol.asyncIterator](); const first = await it.next(); prompt = first.value.message.content; (async () => { for await (const m of it) inputs.push(m); })().catch(() => {}); }
    const call = { prompt, resume: opts.options.resume || null, options: opts.options, inputs }; sdkCalls.push(call);
    if (control.sdk) { yield* control.sdk(call); return; }
    yield { type: "system", subtype: "init", session_id: opts.options.resume || "native-claude" };
    yield { type: "assistant", message: { id: "a-" + sdkCalls.length, content: [{ type: "text", text: "Synthetic reply." }] } };
    yield { type: "result", subtype: "success", is_error: false, session_id: opts.options.resume || "native-claude", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };
  })(); } };
  let turnSeq = 0;
  const appserver = {
    ctxKeyOf: () => control.account,
    async run(opts) {
      if (control.appEarly) { const early = await control.appEarly(opts); if (early) return early; }   // e.g. the app-server cannot start (before any thread exists)
      const id = opts.resumeId || "native-openai-" + (appCalls.length + 1), isNew = !opts.resumeId;
      const call = { prompt: opts.promptText, resume: opts.resumeId || null, id, config: opts.config }; appCalls.push(call);
      opts.on.onThreadId(id, isNew, control.account);
      try { await opts.beforeTurn(id, isNew); } catch (e) { return { ok: false, error: "conversation transfer failed: " + e.message, threadId: id }; }
      if (control.appBefore) { const rejected = await control.appBefore(opts, call); if (rejected) return rejected; }   // rejected BEFORE acceptance: no turn id, nothing committed
      opts.on.onTurnId("turn-" + (++turnSeq));   // the thread ACCEPTED the prompt (turn/started): the run commits the attempt's hashes here
      if (control.app) return control.app(opts, call);   // a failure AFTER acceptance
      return { ok: true, text: "Synthetic reply.", threadId: id };
    },
    async injectItems(id, items) { if (control.onInject) await control.onInject(id, items); injections.push({ id, items: JSON.parse(JSON.stringify(items)) }); return { ok: true }; },
    interrupt: async () => true, steer: async () => ({ ok: true }),
  };
  const codex = { run: async (opts) => (control.exec ? control.exec(opts) : { ok: true, text: "Synthetic summary.", usage: { input_tokens: 100, output_tokens: 20 } }) };
  const map = { path, fs, os, crypto: require("crypto"), child_process: require("child_process"), "./store": store, "./history": history, "./cli-auth": { profiles: { accountKey: () => control.account } }, "./attachments": { persistAll: (a) => a, light: (a) => a, readBase64: () => "" }, "./tool-args": require(path.join(ROOT, "src/main/session/tool-args.js")), "./subagents": require(path.join(ROOT, "src/main/agents/subagents.js")), "./skills": skillsMod, "./convo": require(path.join(ROOT, "src/main/storage/convo.js")), "./catalog": providers, "./codex-appserver": appserver, "./codex-exec": codex, "./codex-cards": { unwrapCmd: (x) => x, parseDiff: () => ({ oldText: "", newText: "", added: 0, removed: 0 }), classifyCmd: () => null }, "./council": { reviewerRun: async () => ({ ok: true, text: "advice" }), label: () => "Reviewer" }, "./custom-api": { getEndpoint: () => null, call: async (opts) => (control.custom ? control.custom(opts) : { ok: true, text: "custom" }) } };
  const { M } = loadSessionInVm({ deps: map, sdk });
  M.send = (name, data) => sends.push({ name, data });
  M.buildEnv = () => ({}); M.resolveCli = async () => ""; M.composeMcp = () => ({}); M.registerModel = () => {}; M.scheduleRetry = () => {};
  M.setSummarizer(async (provider, model, prompt) => { summaryCalls.push({ provider, model, prompt }); return "Summary of synthetic completed work."; });
  // `parentId` + `role` make a workflow ROLE child (the only sessions whose skill selection takes effect).
  const make = (opts = {}) => { const v = store.createSession({ cwd: HOME, name: "ctx", model: opts.model || "claude-opus-4-8", thinking: "low", permissionMode: opts.permissionMode, oneM: opts.oneM, selectedSkills: opts.selectedSkills, parentId: opts.parentId, role: opts.role }); const s = store.getSession(v.id); if (opts.messages) { s.messages.push(...opts.messages); store.enforceCap(s); } store.flush(v.id); return s; };
  let seq = 0;
  const msg = (role, text, more = {}) => ({ id: "m-" + (++seq), role, text, ts: store.nowISO(), ...more });
  const setProvider = (p) => store.saveSettings({ llmProvider: p });
  // the synthesize IPC handler, extracted UNCHANGED from src/main/ipc/sessions.js
  const handlers = {};
  const handlerSrc = src.sessions.slice(src.sessions.indexOf('  handle("sessions:synthesize"'), src.sessions.indexOf('  handle("sessions:get"'));
  vm.runInNewContext(handlerSrc, { handle: (n, fn) => { handlers[n] = fn; }, store, claude: M, require: (n) => { if (/history$/.test(n)) return history; throw new Error(n); } });
  return { M, make, msg, sdkCalls, appCalls, injections, summaryCalls, sends, control, setProvider, synthesize: (id) => handlers["sessions:synthesize"](null, id) };
}
const count = (s, needle) => String(s || "").split(needle).length - 1;

async function main() {
  // Most fixtures deliberately model a 200K endpoint so their boundary cases
  // remain boundary cases. This one exercises automatic 1M native configuration.
  { const e = environment({ oneMCap: true }); e.setProvider("anthropic"); const s = e.make({ oneM: false });
    await e.M.run(s.id, { text: "Use this model's full context", oneM: false });
    const primary = e.sdkCalls[0];
    check("C00a", "a 1M-capable primary model enables its native context automatically, even when an old caller sends oneM:false", s.oneM === true && primary && (primary.options.betas || []).includes("context-1m-2025-08-07") && e.M.contextTokensFor("anthropic", s.model, s) === 1000000);
    await e.M.runHeadlessAnthropic({ settings: store.getSettings(), model: s.model, oneM: false, prompt: "Summarize this", cwd: s.cwd });
    check("C00b", "headless summaries use the selected model's 1M configuration too", e.sdkCalls.length === 2 && (e.sdkCalls[1].options.betas || []).includes("context-1m-2025-08-07")); }
  // ---- controls: ordinary continuation stays delta-only ----
  { const e = environment(); e.setProvider("anthropic"); const s = e.make();
    await e.M.run(s.id, { text: "FIRST" }); await e.M.run(s.id, { text: "MIDDLE FOLLOWUP" });
    check("C01", "Claude normal continuation submits only the new prompt with native resume", e.sdkCalls.length === 2 && e.sdkCalls[1].prompt === "MIDDLE FOLLOWUP" && e.sdkCalls[1].resume === "native-claude", e.sdkCalls.map((c) => [c.prompt.slice(0, 40), c.resume])); }
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5" });
    await e.M.run(s.id, { text: "FIRST" }); await e.M.run(s.id, { text: "MIDDLE FOLLOWUP" });
    check("C02", "Codex normal continuation uses native resume without history reinjection", e.appCalls.length === 2 && !!e.appCalls[1].resume && e.injections.length === 0, { calls: e.appCalls.length, injections: e.injections.length }); }

  // ---- CTX-001 / CTX-014: synthesize is a CONDENSED handoff (≈ SYNTH_SEED_CHARS) that keeps the settings ----
  { const e = environment(); e.setProvider("anthropic");
    const big = (n, ch) => ch.repeat(n);
    const SEED_MAX = 32768;   // transfer.SYNTH_SEED_CHARS + the "Continued from" head line
    const s = e.make({ permissionMode: "plan", selectedSkills: ["test-skill"], messages: [{ id: "u1", role: "user", text: "GOAL: fix the login bug " + big(600000, "A"), ts: store.nowISO() }, { id: "a1", role: "assistant", text: "DONE: patched auth.js " + big(600000, "B"), ts: store.nowISO() }] });
    s.editedFiles = [{ path: "C:/proj/src/auth.js", count: 3, added: 40, removed: 12 }]; store.flush(s.id);
    const next = await e.synthesize(s.id);
    const seed = next.messages[0];
    check("C05", "synthesize seeds a CONDENSED handoff (summary of the oldest, newest verbatim excerpt), never the 1.2 MB transcript — about 6K tokens however big the source", next.messages.length === 1 && seed.role === "record" && seed.carriedRecord === true && seed.text.length <= SEED_MAX && seed.meta.mode === "summary" && e.summaryCalls.length === 1 && /Continued from/.test(seed.text) && /condensed handoff/.test(seed.text) && /DONE: patched auth\.js/.test(seed.text) && !/context window/.test(seed.text), { chars: seed.text.length, summaryCalls: e.summaryCalls.length, mode: seed.meta && seed.meta.mode });
    check("C05b", "every summariser request for the giant entry is sized to the model's window (segmented), not to the seed", e.summaryCalls.every((c) => c.prompt.length <= 200000 + 2000) && e.summaryCalls.length <= 8, { max: Math.max(...e.summaryCalls.map((c) => c.prompt.length)), calls: e.summaryCalls.length });
    check("C05e", "the seed carries the SESSION MAP (goals, files with edit counts, entry counts) as labelled facts, and the card gets it structured", /\[Session map — facts distilled/.test(seed.text) && /Goals the user pursued:\n- GOAL: fix the login bug/.test(seed.text) && /auth\.js \(3×, \+40\/−12\)/.test(seed.text) && seed.meta.map && seed.meta.map.total === 2 && seed.meta.map.userTurns === 1 && seed.meta.map.files[0].path === "C:/proj/src/auth.js" && seed.meta.summary === "Summary of synthetic completed work." && seed.meta.selected === true && seed.meta.headCount === 2 && seed.meta.tailCount === 0, { map: seed.meta.map && Object.keys(seed.meta.map), summary: seed.meta.summary && seed.meta.summary.slice(0, 40) });
    check("C05f", "synthesizing does not add a summary card to the SOURCE session", !store.getSession(s.id).messages.some((m) => m.role === "summary") && store.getSession(s.id).messages.length === 2, { roles: store.getSession(s.id).messages.map((m) => m.role) });
    // What is persisted / sent over IPC must be clonable: a function on the seed's job (the progress sink) hung the renderer (tester repro, 2026-09-16)
    const clone = (v) => (typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
    let cloneErr = null; try { clone(seed.meta); clone(next); } catch (x) { cloneErr = x; }
    check("C05h", "the summary-mode seed's meta (job included) and the new session view contain no functions — structuredClone succeeds", cloneErr === null && seed.meta.job && typeof seed.meta.job.calls === "number" && !("onProgress" in seed.meta.job) && Object.keys(seed.meta.job).every((k) => typeof seed.meta.job[k] !== "function"), { err: cloneErr && cloneErr.message, job: seed.meta.job });
    const callsBefore = e.summaryCalls.length;
    const again = await e.synthesize(s.id);
    check("C05g", "synthesizing the same source again reuses the cached summary — no new model calls, same bounded seed", e.summaryCalls.length === callsBefore && again.messages[0].text.length <= SEED_MAX && again.messages[0].meta.mode === "summary", { calls: e.summaryCalls.length - callsBefore, chars: again.messages[0].text.length });
    check("C06", "synthesize carries the permission mode but NOT the source's skill selection (skills reach workflow role sessions only, 2026-09-18 — a copied legacy selection would be inert data)", next.permissionMode === "plan" && Array.isArray(next.selectedSkills) && next.selectedSkills.length === 0 && store.getSession(s.id).selectedSkills[0] === "test-skill", { permissionMode: next.permissionMode, selectedSkills: next.selectedSkills });
    const small = e.make({ oneM: true, messages: [e.msg("user", "hello"), e.msg("assistant", "hi")] });
    const n2 = await e.synthesize(small.id);
    check("C06b", "synthesize carries the 1M-context selection; a small record stays exact (plus the session map)", n2.oneM === true && n2.messages[0].meta.mode === "exact" && /verbatim/.test(n2.messages[0].text) && /Session map/.test(n2.messages[0].text) && n2.messages[0].text.length < 3000, { oneM: n2.oneM, mode: n2.messages[0].meta.mode, chars: n2.messages[0].text.length });
    // synthesize AGAIN from the continuation: bounded again, no nested blow-up
    const nn = await e.synthesize(next.id);
    check("C05c", "synthesizing the continuation again stays bounded (no nested full transcript)", nn.messages.length === 1 && nn.messages[0].text.length <= SEED_MAX, { chars: nn.messages[0].text.length });
    // the seed is what the first turn transfers — as ONE record entry, and the record card is app-visible history
    const nextFull = store.getSession(next.id);
    check("C05d", "the record entry is model-visible history for the first turn", history.isHistoryMessage(nextFull.messages[0]) && history.planTransfer(nextFull, -1, 0, { budgetChars: Infinity }).count === 1); }

  // ---- CTX-002 / CTX-003: chunking within an oversized entry; enforced size contract ----
  { const e = environment(); const s = e.make({ messages: [e.msg("user", "GOAL " + "X".repeat(1100000) + " END-OF-GOAL")] });
    const tb = await e.M.transferBlock(s, "anthropic", { model: s.model, from: -1, to: 0, promptChars: 20 });
    check("C07c", "one giant user entry gets a compact handoff retaining its start and end", tb.mode === "summary" && Buffer.byteLength(tb.text) <= 32768 && /GOAL X/.test(tb.text) && /END-OF-GOAL/.test(tb.text) && e.summaryCalls.length === 1, { chars: tb.text.length, budget: tb.budget, calls: e.summaryCalls.length }); }
  { const e = environment(); const s = e.make({ messages: [e.msg("user", "X".repeat(1200000)), e.msg("assistant", "Y".repeat(200))] });
    const tb = await e.M.transferBlock(s, "anthropic", { model: s.model, from: -1, to: 1, promptChars: 20 });
    check("C07", "one oversized entry is sampled in one byte-bounded summary request", tb.mode === "summary" && e.summaryCalls.length === 1 && e.summaryCalls.every((c) => Buffer.byteLength(c.prompt) <= 32768) && /Selected evidence/.test(e.summaryCalls[0].prompt), { budget: tb.budget, calls: e.summaryCalls.length, max: Math.max(...e.summaryCalls.map((c) => c.prompt.length)) });
    check("C07b", "the final block fits the budget", tb.text.length <= tb.budget, { chars: tb.text.length, budget: tb.budget }); }
  { const e = environment(); const s = e.make({ messages: Array.from({ length: 20 }, (_, i) => e.msg(i % 2 ? "assistant" : "user", "ENTRY-" + i + " " + "x".repeat(8000))) });
    let compactions = 0;
    e.M.setSummarizer(async (p, m, prompt) => { if (/too long for the space available/.test(prompt)) { compactions++; return "COMPACT SUMMARY " + "z".repeat(3000); } return "x".repeat(90000); });
    const tb = await e.M.transferBlock(s, "anthropic", { model: s.model, from: -1, to: 19, budgetScale: 0.1, forceSummary: true });
    check("C08", "oversized summary output is excerpted locally with no second model call", compactions === 0 && Buffer.byteLength(tb.text) <= tb.packetBudget && tb.job.calls === 1 && /excerpt/.test(tb.text), { budget: tb.budget, finalChars: tb.text.length, compactions }); }

  // ---- CTX-004: the prompt itself is measured; occupied threads reduce the allowance ----
  { const e = environment(); e.setProvider("anthropic"); const s = e.make();
    await e.M.run(s.id, { text: "x".repeat(1200000) });
    check("C10", "a message larger than the model's window is NOT submitted; the run ends with a clear error", e.sdkCalls.length === 0 && s.status === "error" && s.messages.some((m) => m.role === "error" && /larger than the model's context window/.test(m.text)) && !e.M.isRunning(s.id), { sdkCalls: e.sdkCalls.length, status: s.status });
    const s2 = e.make({ messages: Array.from({ length: 30 }, (_, i) => e.msg("user", "E" + i)) });
    const tb = await e.M.transferBlock(s2, "anthropic", { model: s2.model, from: 5, to: 29, promptChars: 100, activeTokens: 90000 });
    check("C11", "a partial transfer into an occupied thread budgets against its active context", tb.budget === 400000 - 100 - 360000, { budget: tb.budget }); }

  // ---- CTX-006: the current prompt is sent once, whatever cards follow it ----
  for (const provider of ["anthropic", "openai"]) {
    const e = environment(); e.setProvider(provider); const s = e.make({ model: provider === "openai" ? "gpt-5.5" : "claude-opus-4-8", messages: [] });
    e.M.consultReviewers = async (sess) => { e.M.addMessage(sess, e.msg("system", "Consulting")); e.M.addMessage(sess, e.msg("reviewer", "REVIEWER ADVICE")); return "REVIEWER ADVICE"; };
    await e.M.run(s.id, { text: "CURRENT PROMPT", reviewers: [{ provider, model: s.model }], reviewMode: "before" });
    const replay = provider === "openai" ? JSON.stringify(e.injections) : e.sdkCalls[0].prompt;
    const n = provider === "openai" ? count(replay, "CURRENT PROMPT") + count(e.appCalls[0].prompt, "CURRENT PROMPT") : count(replay, "CURRENT PROMPT");
    check(provider === "openai" ? "C13" : "C12", `${provider}: the current prompt reaches the provider exactly once even after reviewer cards`, n === 1, { occurrences: n }); }

  // ---- CTX-007: accepted input / injected history is never replayed ----
  { const e = environment(); e.setProvider("anthropic"); const s = e.make({ messages: [e.msg("user", "OLD"), e.msg("assistant", "DONE")] });
    history.setBinding(s, "anthropic", { id: "native-claude", syncedIndex: 1 });
    e.control.sdk = async function* () { yield { type: "system", subtype: "init", session_id: "native-claude" }; yield { type: "assistant", message: { id: "p", content: [{ type: "text", text: "PARTIAL ALREADY IN NATIVE THREAD" }] } }; throw new Error("boom: provider dropped"); };
    await e.M.run(s.id, { text: "RETRY THIS" });
    e.control.sdk = null;
    const pid = s.messages.find((m) => m.role === "user" && m.text === "RETRY THIS").id;
    await e.M.run(s.id, { text: "RETRY THIS", resumeContinuation: true, promptMessageId: pid });
    const t = e.sdkCalls[1].prompt;
    check("C14", "a retry after an ACCEPTED failed turn sends the prompt once and no replay of the partial output", count(t, "RETRY THIS") === 1 && !t.includes("PARTIAL ALREADY IN NATIVE THREAD") && e.sdkCalls[1].resume === "native-claude", { prompt: t.slice(0, 200) }); }
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5", messages: [e.msg("user", "OLD"), e.msg("assistant", "DONE")] });
    history.setBinding(s, "openai", { id: "native-openai", syncedIndex: 1, account: "login" });
    e.control.app = async (opts) => { opts.on.onAgentMessage("PARTIAL ALREADY RECEIVED", { id: "x", type: "agentMessage" }); return { ok: false, aborted: true }; };
    await e.M.run(s.id, { text: "ALREADY RECEIVED" });
    e.control.app = null;
    await e.M.run(s.id, { text: "NEW MIDDLE INSTRUCTION" });
    check("C15", "the prompt after a stopped Codex turn does not re-inject the accepted turn", e.injections.length === 0 && e.appCalls[1].resume === "native-openai" && e.appCalls[1].prompt === "NEW MIDDLE INSTRUCTION", { injections: e.injections.length }); }
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5", messages: [e.msg("user", "SOURCE"), e.msg("assistant", "SOURCE ANSWER")] });
    e.control.app = async () => ({ ok: false, error: "network unavailable", errorInfo: "httpConnectionFailed" });
    await e.M.run(s.id, { text: "RETRY PROMPT" });
    e.control.app = null;
    const pid = s.messages.find((m) => m.role === "user" && m.text === "RETRY PROMPT").id;
    await e.M.run(s.id, { text: "RETRY PROMPT", resumeContinuation: true, promptMessageId: pid });
    check("C16", "history injected before a network failure is acknowledged and not injected again on retry", e.injections.length === 1 && e.appCalls.length === 2 && count(e.appCalls[1].prompt, "RETRY PROMPT") === 1, { injections: e.injections.length }); }

  /* ---- CTX-007 (2026-09-18): the delivery caches follow ACCEPTANCE, not attempts. A turn the thread REJECTED before
   * accepting it (no turn/started on Codex, no init on Claude — control.appBefore / an SDK that throws before init)
   * leaves the binding's skillsHash at what the thread last accepted, so the retry sends the changed procedures again;
   * a thread that starts with nothing (an account change's replacement thread, a --fresh role session) gets the full
   * block and commits on ITS acceptance; init / turn/started followed by a failure is an acceptance. ---- */
  { const SK_HEAD = "Skills the user selected for this message", SK_PTR = "Skills active for this conversation";
    const hOf = (s, p) => history.bindingFor(s, p).skillsHash || "";
    const isSha = (h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h);
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const roleKid = (e, opts = {}) => { const parent = e.make(); return e.make({ ...opts, parentId: parent.id, role: opts.role || "coder" }); };
    // (a) Codex: rejected BEFORE acceptance → the hash stays; the retry carries the full block again and commits
    { const e = environment(); e.setProvider("openai");
      const sk = skillsMod.create(HOME, { name: "Reject rules", steps: "Rejected input keeps the hashes." });
      const coder = roleKid(e, { model: "gpt-5.5", selectedSkills: [sk.id] });
      await e.M.run(coder.id, { text: "TURN ONE", roleBrief: "Coder." });
      const H = hOf(coder, "openai"), thread = history.bindingFor(coder, "openai").id;
      await pause(5); skillsMod.update(HOME, sk.id, { steps: "Rejected input keeps the hashes.\nEdited since." });
      const H2 = e.M.skillSnapshot(coder).hash;
      e.control.appBefore = async () => ({ ok: false, error: "network unavailable", errorInfo: "httpConnectionFailed" });   // the request never reached turn/start
      await e.M.run(coder.id, { text: "TURN TWO", roleBrief: "Coder." });
      e.control.appBefore = null;
      const afterReject = { ...history.bindingFor(coder, "openai") }, statusReject = coder.status;
      const pid = coder.messages.find((m) => m.role === "user" && m.text === "TURN TWO").id;
      await e.M.run(coder.id, { text: "TURN TWO", resumeContinuation: true, promptMessageId: pid, roleBrief: "Coder." });
      const [, c2, c3] = e.appCalls;
      check("C17a", "Codex: a turn the thread REJECTED before accepting it (no turn/started) leaves the binding's skillsHash at what it last accepted, same thread, session offline; the attempt carried the edited procedures in full; the retry resumes that thread with the full block again (marked as replacing) and commits the new hash", isSha(H) && H2 !== H && c2 && c2.prompt.startsWith("TURN TWO\n\n" + SK_HEAD) && afterReject.skillsHash === H && afterReject.id === thread && statusReject === "offline" && c3 && c3.resume === thread && c3.prompt.startsWith("TURN TWO\n\n" + SK_HEAD) && /replace any skills/.test(c3.prompt) && count(c3.prompt, "TURN TWO") === 1 && hOf(coder, "openai") === H2 && e.appCalls.length === 3 && e.injections.length === 0 && coder.status === "done", { H: H.slice(0, 8), afterReject: { id: afterReject.id, h: afterReject.skillsHash && afterReject.skillsHash.slice(0, 8) }, statusReject, c2: c2 && c2.prompt.slice(0, 70), c3: c3 && [c3.resume, c3.prompt.slice(0, 70)], final: hOf(coder, "openai").slice(0, 8), calls: e.appCalls.length }); }
    // (b) Codex: a hash-bearing ACCOUNT change → a new thread that starts with nothing and gets the full block; commit on its acceptance
    { const e = environment(); e.setProvider("openai");
      const sk = skillsMod.create(HOME, { name: "Account rules", steps: "Another account gets a new thread." });
      const coder = roleKid(e, { model: "gpt-5.5", selectedSkills: [sk.id] });
      await e.M.run(coder.id, { text: "UNDER A", roleBrief: "Coder." });
      const bA = { ...history.bindingFor(coder, "openai") };
      e.control.account = "account-b";
      let beforeAccept = null;
      e.control.appBefore = async () => { beforeAccept = { ...history.bindingFor(coder, "openai") }; return null; };   // a probe only: the binding once the new thread holds the record, before it accepts the prompt
      await e.M.run(coder.id, { text: "UNDER B", roleBrief: "Coder." });
      e.control.appBefore = null;
      const bB = { ...history.bindingFor(coder, "openai") }, c2 = e.appCalls[1], sent = e.M.lastRunInfo().sent;
      check("C17b", "Codex: a thread with committed hashes under account A; account B → a NEW thread (no resume, the record injected) whose prompt carries the procedures and the brief in FULL (no pointer); before it accepts, the binding already names the new id + account with the old id's hashes gone; turn/started commits fresh ones", bA.account === "login" && isSha(bA.skillsHash) && isSha(bA.briefHash) && c2 && c2.resume === null && c2.id !== bA.id && c2.prompt.startsWith("UNDER B\n\n" + SK_HEAD) && !c2.prompt.includes(SK_PTR) && c2.prompt.includes("Role brief for this conversation") && sent.skillsMode === "full" && sent.briefMode === "full" && beforeAccept && beforeAccept.id === c2.id && beforeAccept.account === "account-b" && !("skillsHash" in beforeAccept) && !("briefHash" in beforeAccept) && bB.id === c2.id && bB.account === "account-b" && isSha(bB.skillsHash) && isSha(bB.briefHash) && e.injections.length === 1 && coder.status === "done", { bA: { id: bA.id, acct: bA.account }, beforeAccept, bB: { id: bB.id, acct: bB.account, s: !!bB.skillsHash, b: !!bB.briefHash }, c2: c2 && [c2.resume, c2.prompt.slice(0, 60)], sent: [sent.skillsMode, sent.briefMode], inj: e.injections.length }); }
    // (c) --fresh (startRoleJob fresh:true): a NEW role session instead of the role's pooled one — its first turn sends the full block, its binding inherited nothing, the pooled session's hash is untouched
    { const e = environment(); e.setProvider("anthropic");
      const d = store.workflowDefaults();
      const sk = skillsMod.create(HOME, { name: "Fresh role rules", steps: "A fresh role session gets everything." });
      store.saveSettings({ workflow: { ...d, enabled: true, roles: { ...d.roles, coder: { ...d.roles.coder, skills: [sk.id] } } } });
      const parent = e.make();
      const j1 = await e.M.startRoleJob(parent.id, { role: "coder", task: "TASK ONE" }); await e.M.waitJob(j1.id, 10000);
      const c1 = store.getSession(j1.sessionId), h1 = hOf(c1, "anthropic");
      const j2 = await e.M.startRoleJob(parent.id, { role: "coder", task: "TASK TWO" }); await e.M.waitJob(j2.id, 10000);
      let probe = null;   // the fresh child's binding at the moment its first prompt is dispatched (before init)
      e.control.sdk = async function* () {
        const kid = store.listSessions().map((m) => store.getSession(m.id)).find((s) => s && s.parentId === parent.id && s.role === "coder" && s.id !== c1.id);
        probe = kid ? { ...history.bindingFor(kid, "anthropic"), session: kid.id } : null;
        yield { type: "system", subtype: "init", session_id: "native-claude-fresh" };
        yield { type: "assistant", message: { id: "a-fresh", content: [{ type: "text", text: "Synthetic reply." }] } };
        yield { type: "result", subtype: "success", is_error: false, session_id: "native-claude-fresh", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };
      };
      const j3 = await e.M.startRoleJob(parent.id, { role: "coder", task: "TASK THREE", fresh: true }); const d3 = await e.M.waitJob(j3.id, 10000);
      e.control.sdk = null;
      const c3 = store.getSession(j3.sessionId), [p1, p2, p3] = e.sdkCalls.map((c) => c.prompt);
      store.saveSettings({ workflow: store.workflowDefaults() });   // back to the default (off) for the later fixtures
      check("C17c", "--fresh: the role's pooled session is reused for the second job (pointer, same hash); fresh:true makes a NEW coder child (new record, same parent, the role's skills) whose binding holds no id and no hash when its first prompt goes out → that prompt carries the procedures in FULL (no 'replace' wording, no resume) and its init commits the hash to the new native id; the pooled session's binding is untouched", j2.sessionId === c1.id && j2.reused === true && j3.sessionId !== c1.id && j3.reused === false && c3 && c3.parentId === parent.id && c3.role === "coder" && (c3.selectedSkills || []).join() === sk.id && p1 && p1.startsWith("TASK ONE\n\n" + SK_HEAD) && p2 && p2.startsWith("TASK TWO\n\n" + SK_PTR) && p3 && p3.startsWith("TASK THREE\n\n" + SK_HEAD) && !/replace any skills/.test(p3) && e.sdkCalls[2].resume === null && probe && probe.session === c3.id && probe.id === null && !("skillsHash" in probe) && isSha(h1) && hOf(c1, "anthropic") === h1 && history.bindingFor(c1, "anthropic").id === "native-claude" && hOf(c3, "anthropic") === h1 && history.bindingFor(c3, "anthropic").id === "native-claude-fresh" && d3.status === "done", { j2: [j2.sessionId === c1.id, j2.reused], j3: [j3.sessionId !== c1.id, j3.reused, d3.status], heads: [p1, p2, p3].map((p) => p && p.slice(0, 60)), probe, h1: h1.slice(0, 8), h3: hOf(c3, "anthropic").slice(0, 8), ids: [history.bindingFor(c1, "anthropic").id, history.bindingFor(c3, "anthropic").id] }); }
    // (d) Claude: a network drop BEFORE init → nothing accepted, the hash stays; init and THEN the drop → accepted → committed; the retry is a pointer
    { const e = environment(); e.setProvider("anthropic");
      const sk = skillsMod.create(HOME, { name: "Claude reject rules", steps: "Init is the acceptance." });
      const coder = roleKid(e, { selectedSkills: [sk.id] });
      await e.M.run(coder.id, { text: "TURN ONE", roleBrief: "Coder." });
      const H = hOf(coder, "anthropic");
      await pause(5); skillsMod.update(HOME, sk.id, { steps: "Init is the acceptance.\nEdited since." });
      const H2 = e.M.skillSnapshot(coder).hash;
      e.control.sdk = async function* () { throw new Error("read ECONNRESET"); };   // the connection dropped before the CLI reported init (errors.js isNetworkError)
      await e.M.run(coder.id, { text: "TURN TWO", roleBrief: "Coder." });
      const hReject = hOf(coder, "anthropic"), stReject = coder.status;
      const pid = coder.messages.find((m) => m.role === "user" && m.text === "TURN TWO").id;
      e.control.sdk = async function* () { yield { type: "system", subtype: "init", session_id: "native-claude" }; throw new Error("read ECONNRESET"); };   // accepted (init), then dropped
      await e.M.run(coder.id, { text: "TURN TWO", resumeContinuation: true, promptMessageId: pid, roleBrief: "Coder." });
      const hAccepted = hOf(coder, "anthropic"), stAccepted = coder.status;
      e.control.sdk = null;
      await e.M.run(coder.id, { text: "TURN TWO", resumeContinuation: true, promptMessageId: pid, roleBrief: "Coder." });
      const [, p2, p3, p4] = e.sdkCalls.map((c) => c.prompt);
      check("C17d", "Claude: a network drop BEFORE init leaves the skillsHash at what the session last accepted (offline, the attempt had carried the full block); init and THEN a drop is an acceptance → the new hash is committed (still offline); the retry after that resumes with ONE pointer line, no procedures", isSha(H) && H2 !== H && p2 && p2.startsWith("TURN TWO\n\n" + SK_HEAD) && hReject === H && stReject === "offline" && p3 && p3.startsWith("TURN TWO\n\n" + SK_HEAD) && hAccepted === H2 && stAccepted === "offline" && p4 && p4.startsWith("TURN TWO\n\n" + SK_PTR) && !p4.includes(SK_HEAD) && count(p4, "TURN TWO") === 1 && hOf(coder, "anthropic") === H2 && e.sdkCalls.length === 4 && e.sdkCalls.slice(1).every((c) => c.resume === "native-claude") && coder.status === "done", { H: H.slice(0, 8), H2: H2.slice(0, 8), hReject: hReject.slice(0, 8), stReject, hAccepted: hAccepted.slice(0, 8), stAccepted, heads: [p2, p3, p4].map((p) => p && p.slice(0, 60)), final: hOf(coder, "anthropic").slice(0, 8), calls: e.sdkCalls.length, status: coder.status }); } }

  // ---- CTX-009 / CTX-010 / CTX-012 / CTX-013: cursors, cache, tail, shortening ----
  { const e = environment(); const s = e.make({ messages: [e.msg("user", "Keep exact decision"), e.msg("assistant", "ack"), e.msg("user", "already seen")] });
    history.setBinding(s, "anthropic", { id: "native", syncedIndex: 2 });
    history.rememberSummary(s, { from: -1, upTo: 1, text: "OLD RECORD" });
    history.rememberSummary(s, { from: 2, upTo: 2, text: "LATER" });
    store.deleteMessage(s.id, s.messages[0].id);
    s.messages.push(e.msg("assistant", "NEW UNSEEN ENTRY"), e.msg("user", "CURRENT"));
    const sync = history.pendingSync(s, "anthropic", history.lastGlobalIndex(s));
    check("C23", "deleting a message shifts the cursor so a newer unsent entry is still transferred", sync.needed === true && sync.from === 1 && sync.to === 2, sync);
    check("C24", "deleting a message drops the summary that covered it and shifts later ones", !s.summaries.some((x) => x.text === "OLD RECORD") && s.summaries.some((x) => x.text === "LATER" && x.from === 1 && x.upTo === 1), s.summaries); }
  { const e = environment(); const s = e.make({ messages: Array.from({ length: 20 }, (_, i) => e.msg("user", "ITEM-" + i + " " + "x".repeat(10000))) });
    history.rememberSummary(s, { from: -1, upTo: 19, text: "COMPLETE CHECKPOINT" });
    check("C20", "a summary that starts earlier is reused for an overlapping head", history.cachedSummary(s, 9, 19) !== null && history.cachedSummary(s, 9, 19).text === "COMPLETE CHECKPOINT");
    const p = history.planTransfer(s, -1, 19, { budgetChars: 8000, forceSummary: true });
    history.rememberSummary(s, { from: -1, upTo: p.head.to, text: "ORIGINAL" });
    for (let i = 0; i < 61; i++) history.rememberSummary(s, { from: i + 100, upTo: i + 101, text: "S-" + i });
    check("C35", "retention never evicts the latest root checkpoint (count is a memory bound, not correctness)", history.cachedSummary(s, -1, 99) !== null && s.summaries.length <= history.MAX_SUMMARIES, { retained: s.summaries.length }); }
  { const e = environment(); const s = e.make({ messages: [e.msg("user", "EARLY CURRENT GOAL"), e.msg("assistant", "L".repeat(100000))] });
    const p = history.planTransfer(s, -1, 1, { budgetChars: 10000, forceSummary: true });
    check("C21", "a huge newest entry still leaves an exact recent tail (as a bounded excerpt)", p.mode === "summary" && p.headCount === 1 && p.count - p.headCount === 1 && p.texts[1].length <= 5000 && /characters omitted here/.test(p.texts[1]), { headCount: p.headCount, tailChars: p.texts[1].length });
    const tool = e.msg("tool", "", { toolName: "Bash", toolInput: { command: "build" }, result: "Log ".repeat(600) + "CRITICAL FAILURE AT END", status: "error" });
    const short = history.entryTextShort(tool);
    check("C22", "shortened tool results keep their END (the failure) and name the exact record entry", short.includes("CRITICAL FAILURE AT END") && short.includes(tool.id) && short.length < tool.result.length && !/re-running/.test(short.replace(/rather than re-running anything/g, "")), { chars: short.length }); }

  // ---- CTX-017 / CTX-016: usage arithmetic, context meter, compaction telemetry ----
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5" });
    e.control.app = async (opts) => { opts.on.onUsage({ input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 100, output_tokens: 100 }); return { ok: true, text: "reply" }; };
    await e.M.run(s.id, { text: "USAGE" });
    check("C25", "Codex cached tokens are a subset of input — counted once", s.totalTokensIn === 1000 && s.totalTokensOut === 100, { in: s.totalTokensIn });
    e.M.runners.set(s.id, { running: true, codex: true, usage: { last: { input_tokens: 1000, cached_input_tokens: 500 }, context_window: 272000 }, query: { interrupt() {}, steer() {} } });
    const cu = await e.M.contextUsage(s.id);
    check("C26", "the live Codex meter counts cached input once", cu && cu.totalTokens === 1000 && cu.maxTokens === 272000 && cu.estimate === true, cu);
    let args = "unset";
    e.M.runners.set(s.id, { running: true, query: { getContextUsage: async (a) => { args = a; return { totalTokens: 123, maxTokens: 200000, percentage: 1 }; } } });
    const usage = await e.M.contextUsage(s.id);
    check("C27", "Claude control-response camelCase fields pass through", usage.totalTokens === 123 && usage.maxTokens === 200000);
    check("C28", "periodic polling asks for summary detail (no per-category token-count calls)", args && args.detail === "summary", args);
    e.M.runners.delete(s.id); }
  { const e = environment(); const s = e.make();
    e.M.handleMessage(s, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 190000, post_tokens: 40000 } }, {});
    const b = history.bindingFor(s, "anthropic");
    check("C29", "a Claude compaction boundary is recorded (binding telemetry + visible note)", b.compactions === 1 && b.activeTokens === 40000 && s.messages.some((m) => m.role === "system" && /compacted its context/.test(m.text)), { b }); }

  // ---- CTX-015 / CTX-005 / CTX-008: recovery is bounded, clean, and carries completed work ----
  { const e = environment(); e.setProvider("anthropic"); const s = e.make({ messages: [e.msg("user", "OLD"), e.msg("assistant", "A")] });
    history.setBinding(s, "anthropic", { id: "gone", syncedIndex: 1 });
    let attempt = 0;
    e.control.sdk = async function* (call) { attempt++; if (attempt === 1) throw new Error("no conversation found"); if (attempt === 2) throw new Error("prompt is too long"); yield { type: "system", subtype: "init", session_id: "new-native" }; yield { type: "result", subtype: "success", is_error: false, session_id: "new-native", usage: {} }; };
    await e.M.run(s.id, { text: "NEXT" });
    check("C32", "lost session, then prompt too long: both recovered in one bounded sequence", attempt === 3 && s.status === "done" && e.M._lastRun.sent.promptTooLongRecovery === true && e.sdkCalls[2].resume === null, { attempts: attempt, status: s.status }); }
  { const e = environment(); e.setProvider("anthropic"); const s = e.make({ messages: Array.from({ length: 20 }, (_, i) => e.msg(i % 2 ? "assistant" : "user", "ENTRY-" + i + " " + "X".repeat(60000))) });
    e.M.setSummarizer(async () => { throw new Error("prompt is too long in summarizer"); });
    let thrown = "";
    try { await e.M.run(s.id, { text: "NEXT" }); } catch (err) { thrown = err.message; }
    check("C33", "an unavailable summary uses source excerpts and the user turn continues normally", !thrown && !e.M.isRunning(s.id) && s.status === "done" && s.messages.some((m) => m.role === "summary" && m.meta.job.fallback), { thrown, running: e.M.isRunning(s.id), status: s.status }); }
  { const e = environment(); e.setProvider("anthropic"); const s = e.make({ messages: [e.msg("user", "OLD"), e.msg("assistant", "A")] });
    history.setBinding(s, "anthropic", { id: "native", syncedIndex: 1 });
    let attempt = 0;
    e.control.sdk = async function* () { attempt++; if (attempt === 1) { yield { type: "system", subtype: "init", session_id: "native" }; yield { type: "assistant", message: { id: "part", content: [{ type: "text", text: "ACTION ALREADY APPLIED" }] } }; throw new Error("prompt is too long"); } yield { type: "system", subtype: "init", session_id: "new-native" }; yield { type: "result", subtype: "success", is_error: false, session_id: "new-native", usage: {} }; };
    await e.M.run(s.id, { text: "APPLY A CHANGE" });
    const p2 = String(e.sdkCalls[1].prompt);
    check("C34", "Claude overflow recovery carries the failed attempt's completed work and asks to continue", e.sdkCalls.length === 2 && p2.includes("ACTION ALREADY APPLIED") && /Continuation note/.test(p2) && e.M._lastRun.sent.continuationEntries === 1 && s.status === "done", { promptTail: p2.slice(-300) }); }
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5", messages: [e.msg("user", "OLDER"), e.msg("assistant", "OLD ANSWER")] });
    history.setBinding(s, "openai", { id: "native-openai", syncedIndex: 1, account: "login" });
    let attempts = 0;
    e.control.app = async (opts) => { attempts++; if (attempts === 1) { opts.on.onAgentMessage("CURRENT ACTION ALREADY APPLIED", { id: "partial", type: "agentMessage" }); return { ok: false, error: "context window exceeded", errorInfo: "contextWindowExceeded" }; } return { ok: true, text: "Done" }; };
    await e.M.run(s.id, { text: "MAKE CHANGE" });
    check("C39", "Codex overflow recovery injects the failed attempt's completed work and asks to continue", attempts === 2 && JSON.stringify(e.injections).includes("CURRENT ACTION ALREADY APPLIED") && /Continuation note/.test(e.appCalls[1].prompt) && s.status === "done", { attempts, injections: e.injections.length }); }
  { const e = environment(); const ac = new AbortController(); ac.abort();
    let threw = null; try { await e.M.runHeadlessAnthropic({ settings: store.getSettings(), model: "claude-opus-4-8", thinking: "low", system: "s", prompt: "p", cwd: HOME, signal: ac.signal }); } catch (x) { threw = x; }
    check("C36", "an already-aborted signal never starts a headless summary call", threw && threw.name === "AbortError" && e.sdkCalls.length === 0, { calls: e.sdkCalls.length }); }

  // ---- controls that must keep holding ----
  { const e = environment(); e.setProvider("anthropic"); const s = e.make();
    await e.M.run(s.id, { text: "PROVIDER-A-FIRST" });
    e.setProvider("openai"); await e.M.run(s.id, { text: "PROVIDER-B-MIDDLE", model: "gpt-5.5" });
    e.setProvider("anthropic"); await e.M.run(s.id, { text: "PROVIDER-A-FOLLOWUP", model: "claude-opus-4-8" });
    const resumed = e.sdkCalls[1];
    check("C37", "A→B→A switching resumes A and transfers only B's missed span", resumed.resume === "native-claude" && resumed.prompt.includes("PROVIDER-B-MIDDLE") && !resumed.prompt.includes("PROVIDER-A-FIRST") && resumed.prompt.endsWith("PROVIDER-A-FOLLOWUP") && count(resumed.prompt, "PROVIDER-A-FOLLOWUP") === 1, { prompt: resumed.prompt.slice(0, 120) }); }
  { const e = environment(); const s = e.make({ messages: Array.from({ length: 30 }, (_, i) => e.msg("user", "RAW-ENTRY-" + i + " " + "x".repeat(9000))) });
    const first = history.planTransfer(s, -1, 19, { budgetChars: 60000, forceSummary: true });
    await e.M.summarizeRecord(s, "anthropic", s.model, first, { budgetChars: 60000 });
    const c = e.summaryCalls.length;
    await e.M.summarizeRecord(s, "anthropic", s.model, first, { budgetChars: 60000 });
    check("C17", "an unchanged span is reused without a model call", e.summaryCalls.length === c);
    const next = history.planTransfer(s, -1, 29, { budgetChars: 60000, forceSummary: true });
    await e.M.summarizeRecord(s, "anthropic", s.model, next, { budgetChars: 60000 });
    const added = e.summaryCalls.slice(c);
    check("C38", "foreground preparation reuses old memory without a catch-up summary chain", added.length === 0, { added: added.length }); }
  { const e = environment(); const s = e.make({ messages: [e.msg("user", "OLDER"), e.msg("assistant", "ANSWER"), e.msg("user", "CURRENT")] });
    const p = history.planTransfer(s, 0, 1, { budgetChars: 10000 });
    check("C03", "a provider sync span includes only its missing earlier entries", p.count === 1 && p.text.includes("ANSWER") && !p.text.includes("OLDER") && !p.text.includes("CURRENT"));
    history.setBinding(s, "anthropic", { id: "native", syncedIndex: 1 });
    check("C04", "UI pagination never decides the next prompt's history", !history.pendingSync(s, "anthropic", 2).needed); }
  // CTX-019: separate summary calls are accounted
  { const e = environment(); const s = e.make({ messages: Array.from({ length: 40 }, (_, i) => e.msg("user", "E" + i + " " + "q".repeat(12000))) });
    const tb = await e.M.transferBlock(s, "anthropic", { model: s.model, from: -1, to: 39, budgetScale: 0.1, forceSummary: true });
    const card = s.messages.find((m) => m.role === "summary");
    check("C19b", "summary preparation is reported (calls counted on the card and in the note)", tb.job && tb.job.calls >= 1 && card && card.meta.job.calls === tb.job.calls && /model call/.test(tb.note), { job: tb.job });
    let cardCloneErr = null; try { (typeof structuredClone === "function" ? structuredClone : (v) => JSON.parse(JSON.stringify(v)))({ message: card }); } catch (x) { cardCloneErr = x; }
    check("C19c", "the summary card (its meta.job) is clonable — no progress function or deadline bookkeeping is persisted with it", cardCloneErr === null && !("onProgress" in card.meta.job) && !("deadlineAt" in card.meta.job), { err: cardCloneErr && cardCloneErr.message, job: card.meta.job }); }

  /* ---- Preparation lifecycle (session reliability, 2026-09-16): one chain per session, cancellable, bounded, checkpoints reused ---- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bigRecord = (e) => Array.from({ length: 24 }, (_, i) => e.msg(i % 2 ? "assistant" : "user", `ENTRY-${i} ` + "r".repeat(60000)));
  // P01: two synthesis requests at once share ONE summary chain (the second waits, then reuses the cache)
  { const e = environment(); const s = e.make({ messages: bigRecord(e) });
    let inFlight = 0, maxInFlight = 0;
    e.M.setSummarizer(async (p, m, prompt) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); e.summaryCalls.push({ p, m, prompt }); await sleep(15); inFlight--; return "Summary of synthetic completed work."; });
    const labels = [];
    const [a, b] = await Promise.all([e.M.synthesizeSeed(s, "anthropic", { model: s.model }), e.M.synthesizeSeed(s, "anthropic", { model: s.model, onProgress: (l) => labels.push(l) })]);
    const concurrentCalls = e.summaryCalls.length;
    const s2 = e.make({ messages: bigRecord(e) });
    await e.M.synthesizeSeed(s2, "anthropic", { model: s2.model });
    const coldCalls = e.summaryCalls.length - concurrentCalls;
    check("P01", "two concurrent syntheses of one source cost exactly what ONE does (never two model calls in flight for the same record); both seeds are complete", a.mode === "summary" && b.mode === "summary" && a.text.length > 1000 && b.text.length > 1000 && maxInFlight === 1 && concurrentCalls === coldCalls && coldCalls === 1 && e.M.preparationOf(s.id) === null, { maxInFlight, concurrentCalls, coldCalls, modes: [a.mode, b.mode] });
    check("P01b", "the waiting request reports that it is waiting, then reuses the finished chain", labels.some((l) => /Waiting for another preparation/.test(l)) && labels.some((l) => /Preparing a working handoff/.test(l)), labels); }
  // P02: Stop aborts a cold preparation without persisting an unfinished answer.
  { const e = environment(); const s = e.make({ messages: bigRecord(e) });
    const ac = new AbortController(); let calls = 0;
    e.M.setSummarizer(async () => { calls++; setTimeout(() => ac.abort(), 5); return new Promise(() => {}); });
    let err; try { await e.M.synthesizeSeed(s, "anthropic", { model: s.model, signal: ac.signal }); } catch (x) { err = x; }
    check("P02", "Stop aborts the only pending call, releases preparation, and caches no unfinished result", err && err.name === "AbortError" && calls === 1 && !s.summaries.length && !e.M.preparationOf(s.id));
    e.M.setSummarizer(async () => { calls++; return "Finished memory."; });
    await e.M.synthesizeSeed(s, "anthropic", { model: s.model });
    await e.M.synthesizeSeed(s, "openai", { model: "gpt-5.5" });
    check("P02b", "a retry completes with one call; changing provider reuses that memory", calls === 2 && s.summaries.length === 1);
  }
  // P03: the work scales with selected evidence, not raw history size.
  { const e = environment(); const s = e.make({ messages: bigRecord(e) });
    store.saveSettings({ summaryMaxCalls: 50 });
    const a = await e.M.synthesizeSeed(s, "anthropic", { model: s.model });
    const b = await e.M.synthesizeSeed(s, "anthropic", { model: s.model });
    store.saveSettings({ summaryMaxCalls: 0 });
    check("P03", "even a legacy large call cap permits only one bounded call; next handoff uses zero", a.job.calls === 1 && b.job.calls === 0 && a.job.inputBytes <= 32768 && e.summaryCalls.length === 1);
    check("P03b", "selected memory is labelled with provenance, source range and retrieval commands", s.summaries[0].inputMode === "selected" && s.summaries[0].selection.length > 0 && /not the complete transcript/.test(a.text) && a.text.includes("atomnano context read") && a.text.includes(s.id));
  }
  // P04: honest progress — the labels name the work and count the calls
  { const e = environment(); const s = e.make({ messages: bigRecord(e) }); const labels = [];
    const seed = await e.M.synthesizeSeed(s, "anthropic", { model: s.model, onProgress: (l, info) => labels.push({ l, phase: info && info.phase, calls: info && info.calls }) });
    check("P04", "progress reports selection, one model call and completion with accurate accounting", labels.length >= 3 && labels[0].phase === "start" && labels.some((x) => x.phase === "call" && /at most one model call/.test(x.l)) && labels.at(-1).phase === "done" && labels.at(-1).calls === seed.job.calls, { labels, calls: seed.job.calls }); }

  /* ---- Review corrections (2026-09-16, T4 / T5): lock ownership, total deadline, stale measurements, late provider answers, overflow recovery ---- */
  const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  // A summariser that answers its first `answerFirst` calls and then hangs until its signal aborts. Returns the call counter.
  const gatedSummarizer = (e, { answerFirst = 0 } = {}) => { let n = 0; e.M.setSummarizer((_p, _m, _prompt, { signal }) => { n++; if (n <= answerFirst) return Promise.resolve("Summary of synthetic completed work."); return new Promise((_res, rej) => signal.addEventListener("abort", () => rej(abortErr()), { once: true })); }); return () => n; };
  const longRecord = (e, n = 40, size = 3000) => { const out = []; for (let i = 0; i < n; i++) { out.push(e.msg("user", `Question ${i} ` + "q".repeat(size))); out.push(e.msg("assistant", `Answer ${i} ` + "a".repeat(size))); } return out; };
  const noSettingsKeys = (t) => !/Settings|preparationTimeoutMs|summaryMaxCalls|summaryCallTimeoutMs|contextDigest/.test(String(t || ""));

  // P05: a cancelled WAITER leaves the chain registered — the next request still queues behind the running one (reviewer repro: A gated, B queued then cancelled, C must not overlap A)
  { const e = environment(); const s = e.make();
    let gate; const gateP = new Promise((r) => { gate = r; }); const order = [];
    const A = e.M.withPreparation(s, { kind: "digest" }, async () => { order.push("A-start"); await gateP; order.push("A-end"); return "A"; });
    const acB = new AbortController();
    const B = e.M.withPreparation(s, { kind: "handoff", signal: acB.signal }, async () => { order.push("B-start"); return "B"; });
    await sleep(5);
    acB.abort();
    let errB = null; try { await B; } catch (x) { errB = x; }
    const C = e.M.withPreparation(s, { kind: "transfer" }, async () => { order.push("C-start"); return "C"; });
    await sleep(15);
    const overlapped = order.includes("C-start");
    const prep = e.M.preparationOf(s.id);
    gate();
    const [ra, rc] = await Promise.all([A, C]);
    check("P05", "A holds the lock, B queued then cancelled (AbortError): C still waits for A — never overlaps it — and the session stays visibly locked meanwhile (running A, one queued); the lock clears once all settle", errB && errB.name === "AbortError" && overlapped === false && prep && prep.kind === "digest" && prep.waiting === false && prep.queued === 1 && ra === "A" && rc === "C" && order.join() === "A-start,A-end,C-start" && e.M.preparationOf(s.id) === null, { errB: errB && errB.name, overlapped, prep, order }); }

  // P06: a cold call or a queue wait times out into local evidence, never a stuck turn.
  { const e = environment(); const s = e.make({ messages: bigRecord(e) }); store.saveSettings({ preparationTimeoutMs: 200 });
    const calls = gatedSummarizer(e); const entries = s.messages.length; const t0 = Date.now();
    const seed = await e.M.synthesizeSeed(s, "anthropic", { model: s.model });
    const elapsed = Date.now() - t0;
    check("P06", "a hanging model call falls back within the preparation deadline; canonical entries stay intact", seed.job.fallback && seed.job.calls === 1 && elapsed >= 180 && elapsed < 2500 && calls() === 1 && s.messages.length === entries && !e.M.preparationOf(s.id), { elapsed, job: seed.job });
    const s2 = e.make({ messages: bigRecord(e) }); let gate;
    const hold = e.M.withPreparation(s2, { kind: "handoff" }, () => new Promise((r) => { gate = r; }));
    const t1 = Date.now(), before = calls();
    const queued = await e.M.synthesizeSeed(s2, "anthropic", { model: s2.model });
    const ms = Date.now() - t1, holder = e.M.preparationOf(s2.id);
    gate(); await hold; store.saveSettings({ preparationTimeoutMs: 0 });
    check("P06b", "queue deadline falls back with no call while preserving the running holder's lock", queued.job.fallback && calls() === before && ms >= 180 && ms < 2500 && holder && holder.kind === "handoff" && !e.M.preparationOf(s2.id), { ms, holder });
    let errCap; try { await e.M.summarizeText(s, "anthropic", s.model, "x", { job: { calls: 3, maxCalls: 3 } }); } catch (x) { errCap = x; }
    check("P06c", "the summary transport rejects excess calls before starting provider work", errCap && errCap.summaryBudget && calls() === before);
  }

  // P07: Stop cancels a background refresh and retains the previous portable memory.
  { const e = environment(); e.setProvider("anthropic"); const s = e.make({ messages: longRecord(e, 40, 6000) });
    history.setBinding(s, "anthropic", { id: "native-dg", syncedIndex: history.lastGlobalIndex(s), ctxUsage: { totalTokens: 120000, maxTokens: 200000, percentage: 60, ts: store.nowISO() } });
    history.rememberSummary(s, { from: -1, upTo: 19, text: "Earlier saved memory", entries: 20 });
    const calls = gatedSummarizer(e), d = e.M.maybeDigest(s); d.catch(() => {});
    await sleep(40);
    const mid = { running: s._digestRunning, prep: e.M.preparationOf(s.id), calls: calls() };
    const stopped = await e.M.interrupt(s.id, "stop"); let err;
    try { await d; } catch (x) { err = x; }
    check("P07", "Stop cancels the only background call and preserves the previous checkpoint", mid.running && mid.prep.kind === "digest" && mid.calls === 1 && stopped && err && err.name === "AbortError" && !s._digestRunning && s.summaries.length === 1 && s.summaries[0].text === "Earlier saved memory" && !e.M.preparationOf(s.id));
  }

  // P08: a context measurement / provider window that lands after a replacement run, a scope change or a rollover is dropped (reviewer repro)
  { const e = environment(); const s = e.make();
    history.setBinding(s, "anthropic", { id: "old-thread", syncedIndex: 0 });
    let answer = null; const runnerA = { id: "run-a", running: true, model: "claude-opus-4-8", oneM: false, query: { getContextUsage: () => new Promise((r) => { answer = r; }) } };
    e.M.runners.set(s.id, runnerA);
    const late = e.M.captureContextUsage(s, runnerA);
    // meanwhile: Stop, a new run with the 1M choice, and a rollover to a fresh thread
    e.M.runners.set(s.id, { id: "run-b", running: true, model: "claude-opus-4-8", oneM: true }); s.oneM = true;
    history.dropBinding(s, "anthropic"); history.setBinding(s, "anthropic", { id: "new-thread", ctxUsage: null, reportedWindow: null });
    answer({ totalTokens: 190000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 95, model: "claude-opus-4-8" });
    const out = await late;
    const b = history.bindingFor(s, "anthropic");
    check("P08", "old 200K usage arriving after the replacement (1M) and the rollover: dropped — the new binding gets neither the 190K measurement nor a {oneM:true, 200K} window", out === null && !b.ctxUsage && !b.reportedWindow, { out, ctxUsage: b.ctxUsage, rw: b.reportedWindow });
    e.M.runners.set(s.id, runnerA); s.oneM = false;
    const ok = e.M.captureContextUsage(s, runnerA);
    answer({ totalTokens: 190000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 95, model: "claude-opus-4-8" });
    const out2 = await ok; const b2 = history.bindingFor(s, "anthropic");
    check("P08b", "…the same answer for the run that still owns the slot and scope IS recorded, under the run's own 1M choice", out2 && out2.totalTokens === 190000 && b2.ctxUsage && b2.ctxUsage.totalTokens === 190000 && b2.reportedWindow && b2.reportedWindow.tokens === 200000 && b2.reportedWindow.oneM === false && b2.reportedWindow.source === "contextUsage", { out2, rw: b2.reportedWindow });
    const runnerC = { id: "run-c", model: "claude-opus-4-8", oneM: true, sawOutput: true, ended: true, bindingProvider: "anthropic" };
    e.M.runners.set(s.id, { id: "run-d", running: true });
    e.M.handleMessage(s, { type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "new-thread", usage: { input_tokens: 100, output_tokens: 1 }, modelUsage: { "claude-opus-4-8": { inputTokens: 100, outputTokens: 1, contextWindow: 1000000 } } }, runnerC);
    const rw3 = history.bindingFor(s, "anthropic").reportedWindow;
    e.M.runners.delete(s.id);
    check("P08c", "a result's provider window from a run that no longer owns the slot (dispatched under another 1M choice) never replaces the current scope's window", rw3 && rw3.tokens === 200000 && rw3.oneM === false, { rw3 });
    // reviewer repro #7: the old probe is held; a NEWER run on the same thread / model / 1M choice measures, completes and is released; then the old probe resolves
    const held = e.M.captureContextUsage(s, runnerA);   // runnerA: model + oneM match the session, "old-thread" bound
    const newer = e.M.reserveRun(s.id, { text: "next" });   // the newer generation (reserveRun records it on the manager)
    newer.model = "claude-opus-4-8"; newer.oneM = false;
    history.setBinding(s, "anthropic", { ctxUsage: { totalTokens: 900, maxTokens: 200000, percentage: 1, model: "claude-opus-4-8", ts: store.nowISO() } });   // what the newer run measured
    e.M.releaseRun(s.id, newer);   // …and it is gone: no owner in the runners map any more
    answer({ totalTokens: 190000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 95, model: "claude-opus-4-8" });
    const outHeld = await held;
    check("P08d", "an old probe that resolves after a NEWER run on the same thread measured, finished and released is still stale: the newer measurement (900) stands", outHeld === null && history.bindingFor(s, "anthropic").ctxUsage.totalTokens === 900, { outHeld, ctx: history.bindingFor(s, "anthropic").ctxUsage }); }

  // P09: Codex — an old run's success that lands after Stop and a completed replacement must append nothing and move no cursor (reviewer repro)
  { const e = environment(); e.setProvider("openai"); e.M.interruptGraceMs = 20;
    const s = e.make({ model: "gpt-5.5", messages: [e.msg("user", "OLD"), e.msg("assistant", "OLD ANSWER")] });
    history.setBinding(s, "openai", { id: "thread-1", syncedIndex: 1, account: "login" });
    let finishOld = null, oldOpts = null;
    e.control.app = (opts) => { oldOpts = opts; return new Promise((r) => { finishOld = r; }); };   // the transport ignores the abort
    const runA = e.M.run(s.id, { text: "SLOW PROMPT" });
    await sleep(20);
    await e.M.interrupt(s.id, "stop");
    e.control.app = null;
    history.dropBinding(s, "openai");   // the next message starts on a NEW thread (a replacement binding)
    await e.M.run(s.id, { text: "NEW PROMPT" });   // waits out the bounded drain, then runs
    const afterB = { status: s.status, binding: JSON.stringify(history.bindingFor(s, "openai")), messages: s.messages.length, statusSends: e.sends.filter((x) => x.name === "session:status").length };
    // now the OLD run's transport comes back: streamed text, a ghost thread id, a turn id, a success
    oldOpts.on.onAgentMessage("LATE STREAMED ANSWER", { id: "x", type: "agentMessage" });
    oldOpts.on.onThreadId("ghost-thread", true, "login");
    oldOpts.on.onTurnId("turn-ghost");
    finishOld({ ok: true, text: "LATE OLD ANSWER", usage: { input_tokens: 5, output_tokens: 5 } });
    await runA;
    const bAfter = history.bindingFor(s, "openai");
    check("P09", "the old success after Stop appends no reply, leaves the NEW binding's id and cursor untouched (its unaccepted prompt is not acknowledged), and changes no status", afterB.status === "done" && !s.messages.some((m) => m.role === "assistant" && /LATE/.test(m.text)) && JSON.stringify(bAfter) === afterB.binding && bAfter.id === "native-openai-2" && s.status === "done" && s.messages.length === afterB.messages && e.sends.filter((x) => x.name === "session:status").length === afterB.statusSends && !s._pendingRetry, { afterB: { status: afterB.status, binding: afterB.binding }, bAfter, status: s.status, added: s.messages.length - afterB.messages }); }

  // P10: Custom — an old request that dies with ECONNRESET after Stop must not mark the replacement offline or queue the abandoned prompt
  { const e = environment(); e.setProvider("custom"); store.saveSettings({ customMode: "raw", customEndpoint: "http://127.0.0.1:9/v1" }); e.M.interruptGraceMs = 20;
    const s = e.make();
    let failOld = null;
    e.control.custom = () => new Promise((_r, rej) => { failOld = rej; });   // the socket hangs and ignores the abort
    const runA = e.M.run(s.id, { text: "SLOW" });
    await sleep(20);
    await e.M.interrupt(s.id, "stop");
    e.control.custom = null;
    await e.M.run(s.id, { text: "NEXT" });   // after the bounded drain: the endpoint answers → done
    const afterB = { status: s.status, sends: e.sends.filter((x) => x.name === "session:status").length, replies: s.messages.filter((m) => m.role === "assistant").length };
    failOld(new Error("read ECONNRESET"));
    await runA;
    await sleep(5);
    store.saveSettings({ customMode: "" });
    check("P10", "the replacement's 'done' stands: no offline status, no preserved retry payload, no extra status event, no extra reply", afterB.status === "done" && afterB.replies === 1 && s.status === "done" && !s._pendingRetry && e.sends.filter((x) => x.name === "session:status").length === afterB.sends && !e.sends.some((x) => x.name === "session:status" && x.data.status === "offline") && s.messages.filter((m) => m.role === "assistant").length === 1, { afterB, status: s.status, pending: !!s._pendingRetry, statuses: e.sends.filter((x) => x.name === "session:status").map((x) => x.data.status) }); }

  // P11: Codex overflow recovery — the summarised record is prepared BEFORE the full thread is unbound; the new thread is bound only once its record is injected (reviewer repro)
  { const e = environment(); e.setProvider("openai");
    const s = e.make({ model: "gpt-5.5", messages: Array.from({ length: 20 }, (_, i) => e.msg(i % 2 ? "assistant" : "user", "ENTRY-" + i + " " + "x".repeat(20000))) });
    history.setBinding(s, "openai", { id: "thread-full", syncedIndex: history.lastGlobalIndex(s), account: "login" });
    let attempts = 0;
    e.control.app = async (opts) => { attempts++; return opts.resumeId === "thread-full" ? { ok: false, error: "context window exceeded", errorInfo: "contextWindowExceeded" } : { ok: true, text: "Continued." }; };   // the full thread always overflows
    gatedSummarizer(e);
    const run1 = e.M.run(s.id, { text: "NEXT STEP" });
    await sleep(40);
    const liveDuring = e.sends.filter((x) => x.name === "session:live").map((x) => x.data.live);
    await e.M.interrupt(s.id, "stop");
    await run1;
    const b1 = history.bindingFor(s, "openai");
    check("P11", "Stop while the replacement record is summarised: the full thread stays bound (id kept, resumable), no new thread was started, the tab showed 'preparing' and is idle", b1.id === "thread-full" && attempts === 1 && e.appCalls.length === 1 && liveDuring.some((l) => l && l.status === "preparing") && s.status === "idle" && !e.M.isRunning(s.id), { binding: { id: b1.id, synced: b1.syncedIndex }, attempts, appCalls: e.appCalls.length, liveDuring, status: s.status });
    // (b) the seed is ready and the NEW thread's injection is pending → Stop; the late acknowledgement arrives afterwards
    e.M.setSummarizer(async () => "Summary of the full thread.");
    let ackInject = null; e.control.onInject = () => new Promise((r) => { ackInject = r; });
    const run2 = e.M.run(s.id, { text: "NEXT STEP 2" });
    await sleep(40);
    const pending = { injectPending: !!ackInject, id: history.bindingFor(s, "openai").id, cursor: history.bindingFor(s, "openai").syncedIndex, account: history.bindingFor(s, "openai").account };
    await e.M.interrupt(s.id, "stop");
    ackInject(); await run2;
    const b2 = history.bindingFor(s, "openai");
    check("P11b", "seed ready, replacement thread started, its injection pending: the full thread is STILL bound; Stop and then the late acknowledgement leave id, account and cursor exactly as they were — never id:null / cursor -1", pending.injectPending && pending.id === "thread-full" && b2.id === "thread-full" && b2.account === pending.account && b2.syncedIndex === pending.cursor && s.status === "idle" && !e.M.isRunning(s.id), { pending, b2: { id: b2.id, synced: b2.syncedIndex, account: b2.account }, status: s.status });
    // (c) without Stop: the new thread takes the binding over only once its record is acknowledged
    const injectSeen = []; e.control.onInject = () => { injectSeen.push(history.bindingFor(s, "openai").id); };
    await e.M.run(s.id, { text: "NEXT STEP 3" });
    const b3 = history.bindingFor(s, "openai");
    check("P11c", "without Stop: the seed is prepared, the full thread stays bound through thread/start and the injection (still 'thread-full' at injection time), and the new thread takes over — cursor acknowledged — only after the injection; the run completes", injectSeen.length === 1 && injectSeen[0] === "thread-full" && /^native-openai-\d+$/.test(b3.id) && b3.id !== "thread-full" && b3.syncedIndex === history.lastGlobalIndex(s) && s.status === "done" && s.messages.some((m) => m.role === "assistant" && m.text === "Continued.") && s.messages.some((m) => m.role === "summary"), { injectSeen, b3: { id: b3.id, synced: b3.syncedIndex, last: history.lastGlobalIndex(s) }, status: s.status, attempts });
    e.control.onInject = null; e.control.app = null; }

  // P13: an injection acknowledged AFTER Stop and after the replacement run bound its own thread binds nothing and moves no cursor (reviewer repro)
  { const e = environment(); e.setProvider("openai"); e.M.interruptGraceMs = 20;
    const s = e.make({ model: "gpt-5.5", messages: [e.msg("user", "OLD"), e.msg("assistant", "OLD ANSWER")] });   // no thread yet: the first run starts one and injects the record
    let ack = null; e.control.onInject = () => (ack ? null : new Promise((r) => { ack = r; }));   // only the FIRST injection hangs
    const runA = e.M.run(s.id, { text: "FIRST" });
    await sleep(20);
    const duringA = { pending: !!ack, id: history.bindingFor(s, "openai").id };
    await e.M.interrupt(s.id, "stop");
    await e.M.run(s.id, { text: "SECOND" });   // after the bounded drain: its own new thread, injected and bound
    const afterB = JSON.stringify(history.bindingFor(s, "openai"));
    ack(); await runA;   // the OLD injection is acknowledged only now
    const bAfter = history.bindingFor(s, "openai");
    check("P13", "while the first injection is pending no thread is bound; once Stop and the replacement have bound their own thread, the old acknowledgement changes nothing (id and cursor untouched)", duringA.pending && duringA.id === null && JSON.stringify(bAfter) === afterB && bAfter.id === "native-openai-2" && s.status === "done", { duringA, afterB, bAfter, status: s.status });
    e.control.onInject = null; }

  // P14: a planner stopped after streaming part of its plan yields NO plan and records no card (reviewer repro #8)
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5" });
    const reservation = e.M.reserveRun(s.id, { text: "plan this" });
    let finish = null; e.control.exec = (opts) => new Promise((r) => { finish = r; setTimeout(() => opts.on.onTextDelta("PARTIAL PLAN "), 5); });
    const p = e.M.runPlanner(s.id, s, { userText: "plan this", planner: { enabled: true, provider: "openai", model: "gpt-5.5", effort: "low" }, settings: store.getSettings(s.cwd), promptMessageId: null, reservation });
    await sleep(30);
    const partials = e.sends.filter((x) => x.name === "session:partial").length;
    await e.M.interrupt(s.id, "stop");
    finish({ ok: true, text: "PARTIAL PLAN and the rest of it" });
    const r = await p;
    e.M.releaseRun(s.id, reservation);
    check("P14", "the planner streamed a partial plan, then Stop: its late result yields { plan: '', aborted: true } and no planner card is recorded; the tab is idle", partials >= 1 && r && r.aborted === true && r.plan === "" && !s.messages.some((m) => m.role === "planner") && s.status === "idle", { partials, r, roles: s.messages.map((m) => m.role), status: s.status });
    e.control.exec = null; }

  // P12: the Codex SDK-exec fallback's overflow recovery keeps the thread bound while the seed is summarised too
  { const e = environment(); e.setProvider("openai");
    const s = e.make({ model: "gpt-5.5", messages: Array.from({ length: 20 }, (_, i) => e.msg(i % 2 ? "assistant" : "user", "ENTRY-" + i + " " + "x".repeat(20000))) });
    history.setBinding(s, "openai", { id: "exec-full", syncedIndex: history.lastGlobalIndex(s), account: "login" });
    e.control.appEarly = async () => ({ ok: false, loadFailed: true, error: "app-server unavailable" });
    let execCalls = 0;
    e.control.exec = async () => { execCalls++; return execCalls === 1 ? { ok: false, error: "context window exceeded", errorInfo: "contextWindowExceeded" } : { ok: true, text: "exec ok" }; };
    gatedSummarizer(e);
    const run1 = e.M.run(s.id, { text: "NEXT" });
    await sleep(40);
    await e.M.interrupt(s.id, "stop");
    await run1;
    const b = history.bindingFor(s, "openai");
    check("P12", "SDK-exec overflow: Stop during the summarised record keeps the thread bound; no second exec call; idle", b.id === "exec-full" && execCalls === 1 && s.status === "idle" && !e.M.isRunning(s.id), { binding: { id: b.id }, execCalls, status: s.status });
    e.control.appEarly = null; e.control.exec = null; }


  // Adaptive handoff: a 20 MB archive, growing evidence, and portability across identities.
  { const e = environment(); const source = Array.from({ length: 400 }, (_, i) => e.msg(i % 2 ? "assistant" : "user", "ENTRY-" + i + " " + "z".repeat(50000)));
    source.push(e.msg("tool", "", { toolName: "Bash", status: "error", toolInput: { command: "npm test" }, result: "FAIL account swap dropped context" }));
    const s = e.make({ messages: source }); const original = JSON.stringify(store.getMessagesRange(s.id, 401, 401).messages);
    const first = await e.M.synthesizeSeed(s, "anthropic", { model: s.model });
    check("A01", "20 MB archived history produces one <=32 KiB summary request and a byte-bounded handoff", s.archivedCount > 0 && e.summaryCalls.length === 1 && Buffer.byteLength(e.summaryCalls[0].prompt) <= 32768 && Buffer.byteLength(first.text) <= 32768 && first.text.includes("ENTRY-399") && first.text.includes("FAIL account swap"));
    s.messages.push(e.msg("user", "LATEST: keep the same session on account change")); store.enforceCap(s);
    for (const provider of ["anthropic", "openai", "custom"]) {
      const seed = await e.M.synthesizeSeed(s, provider, { model: provider === "openai" ? "gpt-5.5" : s.model });
      check("A02-" + provider, "cached memory plus fresh instructions survives provider/model switch with no new call", seed.job.calls === 0 && seed.job.cached && seed.text.includes("LATEST: keep the same session") && seed.text.includes(first.summary) && Buffer.byteLength(seed.text) <= 32768);
    }
    const hq = require("../src/main/storage/history-query");
    const found = await hq.search(store, s, "ENTRY-25");
    check("A03", "exact archived evidence remains available after synthesis, with stable source ids", original === JSON.stringify(store.getMessagesRange(s.id, 401, 401).messages) && found.matches.some((x) => x.index === 25 && x.archived) && hq.read(store, s, source[25].id).text.includes("ENTRY-25"));
    const sr = e.make({ messages: [e.msg("user", "界".repeat(300000)), e.msg("assistant", "RESULT")] }); sr.name = "界".repeat(200);
    const synthesized = await e.synthesize(sr.id);
    check("A04", "the whole persisted synthesis seed, including a Unicode source name, stays <=32 KiB", Buffer.byteLength(synthesized.messages[0].text) <= 32768 && !synthesized.messages[0].text.includes("�"));
  }
  for (const fallback of [false, true]) {
    const e = environment(); e.setProvider("openai");
    const s = e.make({ model: "gpt-5.5", messages: [e.msg("user", "ORIGINAL REQUIREMENT"), e.msg("assistant", "COMPLETED PATCH")] });
    history.setBinding(s, "openai", { id: "account-a-thread", account: "account-a", syncedIndex: 1, reportedWindow: { model: s.model, oneM: false, tokens: 50000 }, learnedWindow: { model: s.model, oneM: false, tokens: 50000 } });
    e.control.account = "account-b"; let execOpts;
    if (fallback) {
      e.control.appEarly = async () => ({ ok: false, loadFailed: true, error: "offline app-server fixture" });
      e.control.exec = async (opts) => { execOpts = opts; opts.on.onThreadId("account-b-thread"); return { ok: true, text: "Continued.", threadId: "account-b-thread" }; };
    }
    const id = s.id; await e.M.run(s.id, { text: "CONTINUE WITH NEW ACCOUNT" });
    const transferred = fallback ? execOpts.promptText : JSON.stringify(e.injections);
    const b = history.bindingFor(s, "openai");
    check("A05-" + fallback, "account change starts fresh native context and transfers earlier history inside the same app session", s.id === id && transferred.includes("ORIGINAL REQUIREMENT") && transferred.includes("COMPLETED PATCH") && (fallback ? !execOpts.resumeId : !e.appCalls[0].resume) && b.account === "account-b" && b.syncedIndex >= 2 && s.status === "done");
    check("A06-" + fallback, "old account capacity is discarded and native dispatch uses the new model capability", !b.reportedWindow && !b.learnedWindow && (fallback ? execOpts.contextWindow === 272000 : e.appCalls[0].config.model_context_window === 272000));
  }
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5" });
    e.control.app = async (opts) => { opts.on.onUsage({ input_tokens: 100, context_window: 258400 }); return { ok: true, text: "done" }; };
    await e.M.run(s.id, { text: "FIRST" }); await e.M.run(s.id, { text: "SECOND" });
    check("A07", "provider-reported usable capacity is shown without recursively shrinking the configured native window", e.M.contextTokensFor("openai", s.model, s) === 258400 && e.appCalls.every((c) => c.config.model_context_window === 272000) && e.injections.length === 0);
  }

  { const e = environment({ oneMCap: true }); e.setProvider("anthropic"); const s = e.make();
    await e.M.run(s.id, { text: "FIRST ACCOUNT" });
    const b = history.bindingFor(s, "anthropic"), scope = b.capacityAccount;
    history.setBinding(s, "anthropic", { learnedWindow: { model: s.model, oneM: true, tokens: 200000 }, reportedWindow: { model: s.model, oneM: true, tokens: 200000 } });
    e.control.account = "another-account";
    await e.M.run(s.id, { text: "CONTINUE SAME CHAT" });
    check("A08", "Claude credential changes preserve the local native thread but discard the old account's smaller capacity", e.sdkCalls[1].resume === e.sdkCalls[0].options.resume || e.sdkCalls[1].resume === "native-claude", { resume: e.sdkCalls[1].resume });
    check("A08b", "learned account limits reset to model capability, with only a hash stored", b.capacityAccount !== scope && /^[a-f0-9]{24}$/.test(b.capacityAccount) && !b.learnedWindow && !b.reportedWindow && e.M.contextTokensFor("anthropic", s.model, s) === 1000000);
  }

  { const e = environment(); e.setProvider("openai"); e.control.account = "new-account";
    const s = e.make({ model: "gpt-5.5", messages: [e.msg("user", "SOURCE GOAL"), e.msg("assistant", "SOURCE WORK")] });
    history.setBinding(s, "openai", { id: "retained-thread", account: "old-account", syncedIndex: 1 });
    e.control.appEarly = async () => ({ ok: false, loadFailed: true, error: "fixture" });
    e.control.exec = async (opts) => { opts.on.onThreadId("empty-thread"); return { ok: false, error: "fixture rejected before acceptance", threadId: "empty-thread" }; };
    await e.M.run(s.id, { text: "UNACCEPTED REQUEST" });
    const b = history.bindingFor(s, "openai");
    check("A09", "exec thread.started alone never replaces the previous binding or acknowledges a prompt", b.id === "retained-thread" && b.account === "old-account" && b.syncedIndex === 1 && s.messages.some((m) => m.text === "UNACCEPTED REQUEST"));
    let sent;
    e.control.exec = async (opts) => { sent = opts.promptText; opts.on.onThreadId("accepted-thread"); opts.on.onTurnStarted(); return { ok: true, text: "done", threadId: "accepted-thread" }; };
    await e.M.run(s.id, { text: "RECOVER" });
    check("A09b", "the next fresh account turn receives original work and the previously unaccepted request", sent.includes("SOURCE GOAL") && sent.includes("SOURCE WORK") && sent.includes("UNACCEPTED REQUEST") && b.id === "accepted-thread" && b.account === "new-account");
  }
  { const e = environment(); e.setProvider("openai"); e.control.account = "new-account";
    const s = e.make({ model: "gpt-5.5", messages: [e.msg("user", "OLD"), e.msg("assistant", "WORK")] });
    history.setBinding(s, "openai", { id: "previous-account-thread", account: "old-account", syncedIndex: 1 });
    e.control.appEarly = async () => ({ ok: false, loadFailed: true, error: "fixture" });
    e.control.exec = async (opts) => {
      opts.on.onThreadId("accepted-native"); opts.on.onTurnStarted();
      const item = { id: "completed-action", type: "command_execution", command: "npm test", status: "completed", aggregated_output: "ACTION ALREADY COMPLETED", exit_code: 0 };
      opts.on.onToolStart(item); opts.on.onToolEnd(item);
      return { ok: false, error: "fixture failed after completed action", threadId: "accepted-native" };
    };
    await e.M.run(s.id, { text: "ACCEPTED REQUEST" });
    const priorCursor = history.bindingFor(s, "openai").syncedIndex; let sent, resumed;
    e.control.exec = async (opts) => { sent = opts.promptText; resumed = opts.resumeId; opts.on.onThreadId("accepted-native"); opts.on.onTurnStarted(); return { ok: true, text: "continued", threadId: "accepted-native" }; };
    await e.M.run(s.id, { text: "NEXT REQUEST" });
    check("A10", "accepted exec tool work followed by failure is not replayed on the next native resume", priorCursor > 2 && resumed === "accepted-native" && sent === "NEXT REQUEST" && s.messages.some((m) => m.role === "tool" && m.result === "ACTION ALREADY COMPLETED"));
  }
  // Recoverable errors deliberately preserve pause/retry status instead of finalizing the run.
  // Their accepted tool outcomes must still be acknowledged before releasing the native thread.
  for (const fallback of [false, true]) for (const thrown of [false, true]) for (const rate of [false, true]) {
    const e = environment(); e.setProvider("openai");
    const s = e.make({ model: "gpt-5.5", messages: [e.msg("user", "OLD"), e.msg("assistant", "WORK")] });
    history.setBinding(s, "openai", { id: "accepted-native", account: "login", syncedIndex: 1 });
    e.M.scheduleRetry = (id) => store.updateSession(id, { status: "ratelimited" });
    const fail = async (opts) => {
      if (fallback) { opts.on.onThreadId("accepted-native"); opts.on.onTurnStarted(); }
      const item = { id: "completed-action", type: "command_execution", command: "build once", status: "completed", aggregated_output: "ACTION ALREADY COMPLETED", exit_code: 0 };
      opts.on.onToolStart(item); opts.on.onToolEnd(item);
      const error = rate ? "429 rate limit" : "ECONNRESET network failure";
      if (thrown) throw new Error(error);
      return { ok: false, error, threadId: "accepted-native" };
    };
    if (fallback) { e.control.appEarly = async () => ({ ok: false, loadFailed: true, error: "fixture" }); e.control.exec = fail; }
    else e.control.app = fail;
    await e.M.run(s.id, { text: "ACCEPTED REQUEST" });
    const priorCursor = history.bindingFor(s, "openai").syncedIndex, expectedCursor = history.lastGlobalIndex(s);
    const paused = s.status === (rate ? "ratelimited" : "offline") && !e.M.isRunning(s.id);
    const payload = s._pendingRetry, prompt = s.messages.find((m) => m.role === "user" && m.text === "ACCEPTED REQUEST");
    let sent, resumed;
    e.control.app = null;
    e.control.exec = async (opts) => { sent = opts.promptText; resumed = opts.resumeId; opts.on.onThreadId("accepted-native"); opts.on.onTurnStarted(); return { ok: true, text: "continued", threadId: "accepted-native" }; };
    await e.M.run(s.id, { ...payload });
    const next = e.appCalls[1];
    check(`A13-${fallback}-${thrown}-${rate}`, "accepted Codex work survives returned/thrown network/rate errors without history replay or losing retry identity", paused && payload && payload.promptMessageId === prompt.id && payload.resumeContinuation === true && priorCursor === expectedCursor && (fallback ? resumed === "accepted-native" && sent === "ACCEPTED REQUEST" : next.resume === "accepted-native" && next.prompt === "ACCEPTED REQUEST" && e.injections.length === 0) && s.messages.filter((m) => m.role === "user" && m.text === "ACCEPTED REQUEST").length === 1, { priorCursor, expectedCursor, paused, sent, injected: e.injections.length });
  }
  for (const failure of ["ECONNRESET network failure", "429 rate limit", "401 unauthorized"]) {
    const e = environment(); e.setProvider("anthropic"); const s = e.make();
    e.M.scheduleRetry = (id) => store.updateSession(id, { status: "ratelimited" });
    e.control.sdk = async function* () {
      yield { type: "system", subtype: "init", session_id: "native-claude" };
      yield { type: "assistant", message: { id: "tool-call", content: [{ type: "tool_use", id: "completed-tool", name: "Bash", input: { command: "build once" } }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "completed-tool", content: "ACTION ALREADY COMPLETED" }] } };
      throw new Error(failure);
    };
    await e.M.run(s.id, { text: "ACCEPTED REQUEST" });
    const priorCursor = history.bindingFor(s, "anthropic").syncedIndex, expectedCursor = history.lastGlobalIndex(s);
    const paused = s.status === (/429/.test(failure) ? "ratelimited" : /401/.test(failure) ? "auth-expired" : "offline");
    const payload = s._pendingRetry;
    e.control.sdk = null;
    await e.M.run(s.id, { ...payload });
    check("A14-" + failure.split(" ")[0], "Claude acknowledges accepted work on recoverable errors and resumes without replaying tool results", paused && priorCursor === expectedCursor && e.sdkCalls[1].resume === "native-claude" && e.sdkCalls[1].prompt === "ACCEPTED REQUEST" && s.messages.some((m) => m.role === "tool" && m.result === "ACTION ALREADY COMPLETED"), { priorCursor, expectedCursor, paused });
  }
  { const e = environment(); const s = e.make();
    history.setBinding(s, "anthropic", { id: "retained-native", syncedIndex: 0 });
    const old = { id: "stopped-run", interrupted: true, freshThread: true, promptIndex: 20, bindingProvider: "anthropic" };
    e.M.handleMessage(s, { type: "system", subtype: "init", session_id: "late-empty-thread" }, old);
    check("A11", "late Claude init during graceful Stop cannot change the retained binding or acceptance", history.bindingFor(s, "anthropic").id === "retained-native" && !old.accepted);
    const newer = e.M.reserveRun(s.id, { text: "new prompt" });
    history.setBinding(s, "anthropic", { id: "newer-native", syncedIndex: 1 });
    const snapshot = JSON.stringify(history.bindingFor(s, "anthropic"));
    const tool = e.msg("tool", "", { toolName: "Bash", toolUseId: "cancelled-tool", runId: old.id, status: "interrupted", result: "Stopped before its result arrived." });
    s.messages.push(tool);
    e.M.handleMessage(s, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: tool.toolUseId, content: "Actual cancelled command outcome" }] } }, old);
    check("A11c", "graceful drain preserves an old tool's real outcome without touching the newer binding", tool.result === "Actual cancelled command outcome" && tool.status === "interrupted" && JSON.stringify(history.bindingFor(s, "anthropic")) === snapshot);
    old.accepted = true;
    e.M.handleMessage(s, { type: "system", subtype: "init", session_id: "late-thread" }, old);
    e.M._finalizeRun(s, old, { aborted: true });
    e.M.releaseRun(s.id, newer);
    e.M.handleMessage(s, { type: "result", subtype: "success", session_id: "late-thread", num_turns: 1, usage: { input_tokens: 123 } }, old);
    e.M.handleMessage(s, { type: "assistant", message: { content: [{ type: "text", text: "LATE OUTPUT" }] } }, old);
    check("A11b", "superseded Claude events and finalization cannot overwrite bindings/cursors after a newer run finishes", JSON.stringify(history.bindingFor(s, "anthropic")) === snapshot && !s.messages.some((m) => m.text === "LATE OUTPUT"));
  }

  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5", messages: [e.msg("user", "OLD"), e.msg("assistant", "WORK")] });
    history.setBinding(s, "openai", { id: "full-exec-thread", account: "login", syncedIndex: 1 });
    e.control.appEarly = async () => ({ ok: false, loadFailed: true, error: "fixture" });
    let attempts = 0, recovery;
    e.control.exec = async (opts) => {
      attempts++;
      if (attempts === 1) {
        opts.on.onThreadId("full-exec-thread"); opts.on.onTurnStarted();
        const item = { id: "before-overflow", type: "command_execution", command: "build once", status: "completed", aggregated_output: "BUILD ALREADY COMPLETED BEFORE OVERFLOW", exit_code: 0 };
        opts.on.onToolStart(item); opts.on.onToolEnd(item);
        return { ok: false, error: "context window exceeded" };
      }
      recovery = opts; opts.on.onThreadId("recovered-exec"); opts.on.onTurnStarted();
      return { ok: true, text: "Continued without repeating the build.", threadId: "recovered-exec" };
    };
    await e.M.run(s.id, { text: "CONTINUE BUILD" });
    check("A12", "SDK fallback overflow transfers completed actions from the failed attempt with its continuation note", attempts === 2 && !recovery.resumeId && recovery.promptText.includes("BUILD ALREADY COMPLETED BEFORE OVERFLOW") && recovery.promptText.includes("Continuation note from AtomNano") && s.status === "done");
  }

  /* ---- Role-only skill delivery + the per-thread delivery caches (2026-09-18) ----
   * Skills take effect on a persistent workflow ROLE session only (planner / coder / reviewer child); a plain
   * chat's legacy selection is inert. A thread receives the procedures (and, on Codex, the role / agents
   * briefs) in full when new or changed, else ONE pointer line; a selection that went away sends one clearing
   * line. What a thread holds is committed on its binding (skillsHash / briefHash) when it ACCEPTS the input —
   * Claude init, Codex turn/started, exec turn.started — never on thread creation alone; a fresh thread
   * (initial, lost, overflow, rollover, fresh exec) always gets everything; a new native id clears the caches. */
  const SKILLS_HEAD = "Skills the user selected for this message";
  const POINTER = "Skills active for this conversation";
  const CLEARED = "Skills: none are attached to this conversation any more";
  const BRIEFS_PTR = "Briefs: unchanged";
  const ROLE_HEAD = "Role brief for this conversation (configured by the user in the Workflow studio):\n";
  const AGENTS_HEAD = "Sub-agents (the Agents switch the user turned on)";
  // A CHANGED brief set on a thread that holds an earlier one: present briefs are labelled as replacing, absent kinds are named (2026-09-18)
  const ROLE_HEAD_REPLACING = "Role brief for this conversation (configured by the user in the Workflow studio; it replaces any role brief given earlier in this conversation):\n";
  const AGENTS_HEAD_REPLACING = "Sub-agents (the Agents switch the user turned on; it replaces any sub-agents brief given earlier in this conversation):\n";
  const AGENTS_GONE = "Sub-agents: no sub-agents brief applies to this conversation any more — any sub-agents brief given earlier in this conversation no longer applies.";
  const BRIEFS_CLEARED = "Briefs: none apply to this conversation any more — the role brief and any sub-agents brief given earlier in this conversation no longer apply.";
  const roleChild = (e, opts = {}) => { const parent = e.make(); return e.make({ ...opts, parentId: parent.id, role: opts.role || "coder" }); };
  const hashOf = (s, p) => history.bindingFor(s, p).skillsHash || "";
  const sha64 = (h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h);
  // K01 gating: a plain chat's selection is inert; a coder child gets the procedures; a tester child gets none; invoke ran once
  { const e = environment(); e.setProvider("anthropic");
    const sk = skillsMod.create(HOME, { name: "Design tokens", description: "Tokens over literals", steps: "1. Use the --var tokens\n2. Reuse the h() helpers" });
    const plain = e.make({ selectedSkills: [sk.id] });
    await e.M.run(plain.id, { text: "PLAIN" });
    const plainInfo = e.M.lastRunInfo().sent;
    const coder = roleChild(e, { selectedSkills: [sk.id] });
    await e.M.run(coder.id, { text: "TASK ONE", roleBrief: "You are the Coder." });
    const coderInfo = e.M.lastRunInfo().sent;
    const tester = roleChild(e, { role: "tester", selectedSkills: [sk.id] });
    await e.M.run(tester.id, { text: "RUN TESTS" });
    const p1 = e.sdkCalls[1].prompt;
    check("K01", "a plain chat's legacy selection sends nothing (no hash either); a CODER child gets the saved procedures right after its text, its names as metadata, and its binding commits the hash at init; a TESTER child gets nothing; invoke ran once (for the one full delivery)", e.sdkCalls[0].prompt === "PLAIN" && plainInfo.skills.length === 0 && plainInfo.skillsMode === "none" && !hashOf(plain, "anthropic") && p1.startsWith("TASK ONE\n\n" + SKILLS_HEAD) && /Skill "Design tokens" — Tokens over literals\./.test(p1) && /Reuse the h\(\) helpers/.test(p1) && coderInfo.skills.join() === "Design tokens" && coderInfo.skillsMode === "full" && sha64(hashOf(coder, "anthropic")) && e.sdkCalls[2].prompt === "RUN TESTS" && !hashOf(tester, "anthropic") && skillsMod.get(HOME, sk.id).uses === 1, { p0: e.sdkCalls[0].prompt, p1: p1.slice(0, 120), plainInfo, coderInfo, tester: e.sdkCalls[2].prompt, uses: skillsMod.get(HOME, sk.id).uses });
    // K02 unchanged → one pointer line (no invoke); an edit → the procedures again, marked as replacing
    const h1 = hashOf(coder, "anthropic");
    await e.M.run(coder.id, { text: "TASK TWO", roleBrief: "You are the Coder." });
    const p2 = e.sdkCalls[3].prompt;
    check("K02", "the unchanged selection travels as ONE pointer line naming the skill — no procedure, no invoke, the same hash", p2 === "TASK TWO\n\n" + POINTER + " (their saved procedures were provided earlier in this conversation and still apply): Design tokens." && !/Reuse the h\(\)/.test(p2) && e.M.lastRunInfo().sent.skillsMode === "pointer" && hashOf(coder, "anthropic") === h1 && skillsMod.get(HOME, sk.id).uses === 1, { p2, mode: e.M.lastRunInfo().sent.skillsMode });
    await sleep(5); skillsMod.update(HOME, sk.id, { steps: "1. Use the --var tokens\n2. Reuse the h() helpers\n3. Never hardcode colours" });
    await e.M.run(coder.id, { text: "TASK THREE", roleBrief: "You are the Coder." });
    const p3 = e.sdkCalls[4].prompt, h3 = hashOf(coder, "anthropic");
    check("K02b", "an EDITED skill (updatedAt moved; usage counters are ignored) → the procedures again, labelled as replacing the earlier ones; a new hash committed; invoke ran again", p3.startsWith("TASK THREE\n\n" + SKILLS_HEAD + " (their saved procedures; they replace any skills given earlier in this conversation):") && /Never hardcode colours/.test(p3) && sha64(h3) && h3 !== h1 && skillsMod.get(HOME, sk.id).uses === 2, { head: p3.slice(0, 160), same: h3 === h1 });
    // K02c membership + a missing id: the marker is hashed (the existing skill's procedure is what travels); the same missing id next turn → pointer
    coder.selectedSkills = [sk.id, "review-rules"];   // "review-rules" = the SLUG a skill created below will get; no record yet
    await e.M.run(coder.id, { text: "TASK FOUR", roleBrief: "You are the Coder." });
    const p4 = e.sdkCalls[5].prompt, h4 = hashOf(coder, "anthropic");
    await e.M.run(coder.id, { text: "TASK FIVE", roleBrief: "You are the Coder." });
    const p5 = e.sdkCalls[6].prompt;
    check("K02c", "membership changed by a MISSING id: the hash carries the missing marker (new hash → the existing procedure resent, names list only existing skills); the same missing id next turn is a pointer", p4.startsWith("TASK FOUR\n\n" + SKILLS_HEAD) && count(p4, 'Skill "') === 1 && h4 !== h3 && sha64(h4) && p5.startsWith("TASK FIVE\n\n" + POINTER) && /: Design tokens\.$/.test(p5) && hashOf(coder, "anthropic") === h4, { p4: p4.slice(0, 80), p5, changed: h4 !== h3 });
    // K02d the missing skill now EXISTS (created — resolved by slug) → the hash changes → both procedures travel; the reordered selection → pointer
    const sk2 = skillsMod.create(HOME, { name: "Review rules", steps: "Order findings by severity." });
    await e.M.run(coder.id, { text: "TASK SIX", roleBrief: "You are the Coder." });
    const p6 = e.sdkCalls[7].prompt, h6 = hashOf(coder, "anthropic"), names6 = e.M.lastRunInfo().sent.skills.join();
    coder.selectedSkills = ["review-rules", sk.id];
    await e.M.run(coder.id, { text: "TASK SEVEN", roleBrief: "You are the Coder." });
    const p7 = e.sdkCalls[8].prompt;
    check("K02d", "a selected skill that comes into existence → both procedures travel (one full block, two skills, both names); changing only the ORDER of the selection changes nothing (sorted pairs) → pointer, same hash", sk2.slug === "review-rules" && p6.startsWith("TASK SIX\n\n" + SKILLS_HEAD) && count(p6, 'Skill "') === 2 && /Order findings by severity/.test(p6) && names6 === "Design tokens,Review rules" && h6 !== h4 && p7.startsWith("TASK SEVEN\n\n" + POINTER) && /Review rules, Design tokens\.$/.test(p7) && hashOf(coder, "anthropic") === h6, { slug: sk2.slug, p6: p6.slice(0, 80), names6, p7 });
    // K03 clearing: the selection goes away → ONE clearing line; nothing afterwards; re-attached → full again (no "replace" wording: the thread holds nothing)
    coder.selectedSkills = [];
    await e.M.run(coder.id, { text: "TASK EIGHT", roleBrief: "You are the Coder." });
    const p8 = e.sdkCalls[9].prompt, h8 = hashOf(coder, "anthropic");
    await e.M.run(coder.id, { text: "TASK NINE", roleBrief: "You are the Coder." });
    const p9 = e.sdkCalls[10].prompt;
    coder.selectedSkills = [sk.id];
    await e.M.run(coder.id, { text: "TASK TEN", roleBrief: "You are the Coder." });
    const p10 = e.sdkCalls[11].prompt;
    check("K03", "removal to empty → the explicit clearing line ONCE (hash cleared), then nothing; re-attaching sends the procedures in full again", p8 === "TASK EIGHT\n\n" + CLEARED + " — the skill procedures provided earlier in this conversation no longer apply." && h8 === "" && p9 === "TASK NINE" && p10.startsWith("TASK TEN\n\n" + SKILLS_HEAD + " (their saved procedures):") && !/replace any skills/.test(p10) && sha64(hashOf(coder, "anthropic")), { p8, h8, p9, p10: p10.slice(0, 90) });
    // K03b a fresh initially-empty role child adds nothing and commits no hash; a removed skill record → its id is a missing marker → clearing once
    const empty = roleChild(e, { role: "reviewer", selectedSkills: [] });
    await e.M.run(empty.id, { text: "REVIEW" });
    const gone = roleChild(e, { role: "planner", selectedSkills: [sk2.id] });
    await e.M.run(gone.id, { text: "PLAN A" });
    skillsMod.remove(HOME, sk2.id);
    await e.M.run(gone.id, { text: "PLAN B" });
    await e.M.run(gone.id, { text: "PLAN C" });
    const [pe, pa, pb, pc] = e.sdkCalls.slice(12, 16).map((c) => c.prompt);
    check("K03b", "an initially EMPTY selection adds nothing (no hash); a skill whose record is REMOVED → its selection is now empty → one clearing line, then nothing", pe === "REVIEW" && !hashOf(empty, "anthropic") && pa.startsWith("PLAN A\n\n" + SKILLS_HEAD) && pb.startsWith("PLAN B\n\n" + CLEARED) && pc === "PLAN C" && hashOf(gone, "anthropic") === "", { pe, pa: pa.slice(0, 60), pb: pb.slice(0, 60), pc });
    // K12 the SDK `skills` option is never set (Claude's own native skills keep the CLI's defaults); the sdkSkills setting is gone
    store.saveSettings({ sdkSkills: "all", skillsMarketplaceUrl: "https://example.invalid/index.json" });
    await e.M.run(coder.id, { text: "TASK ELEVEN", roleBrief: "You are the Coder." });
    check("K12", "no query option `skills` on any Claude run; `sdkSkills` / `skillsMarketplaceUrl` are REMOVED settings (stripped on save/load, no default)", e.sdkCalls.every((c) => !("skills" in c.options)) && !("sdkSkills" in store.getSettings()) && !("skillsMarketplaceUrl" in store.getSettings()) && store.REMOVED_SETTINGS.includes("sdkSkills") && store.REMOVED_SETTINGS.includes("skillsMarketplaceUrl"), { keys: Object.keys(e.sdkCalls[0].options).filter((k) => /skill/i.test(k)), has: "sdkSkills" in store.getSettings() }); }

  // K04 Codex: the role / agents briefs ride in the appendix and are cached like the skills; reviewer advice stays outside the hashes
  { const e = environment(); e.setProvider("openai");
    const sk = skillsMod.create(HOME, { name: "Codex tokens", steps: "Use tokens." });
    const coder = roleChild(e, { model: "gpt-5.5", selectedSkills: [sk.id] });
    const brief = "You are the Coder (Codex).";
    await e.M.run(coder.id, { text: "TASK ONE", roleBrief: brief, subAgents: true, subAgentsMax: 3 });
    const b1 = { ...history.bindingFor(coder, "openai") }, i1 = e.M.lastRunInfo().sent;
    await e.M.run(coder.id, { text: "TASK TWO", roleBrief: brief, subAgents: true, subAgentsMax: 3 });
    const i2 = e.M.lastRunInfo().sent;
    e.M.consultReviewers = async (sess) => { e.M.addMessage(sess, e.msg("reviewer", "REVIEWER ADVICE")); return "REVIEWER ADVICE"; };
    await e.M.run(coder.id, { text: "TASK THREE", roleBrief: brief, subAgents: true, subAgentsMax: 3, reviewers: [{ provider: "openai", model: "gpt-5.5" }], reviewMode: "before" });
    const b3 = { ...history.bindingFor(coder, "openai") };
    await e.M.run(coder.id, { text: "TASK FOUR", roleBrief: brief + " Report in bullet points.", subAgents: true, subAgentsMax: 3 });
    const b4 = { ...history.bindingFor(coder, "openai") };
    await e.M.run(coder.id, { text: "TASK FIVE", roleBrief: brief + " Report in bullet points." });   // the Agents switch off: the briefs changed again (no agents brief now)
    const [p1, p2, p3, p4, p5] = e.appCalls.map((c) => c.prompt);
    check("K04", "first Codex turn: skills + role brief + sub-agents brief in full; briefHash and skillsHash committed at turn/started (sha256 of [roleBrief, agentsBrief])", p1.startsWith("TASK ONE\n\n" + SKILLS_HEAD) && p1.includes(ROLE_HEAD + brief) && p1.includes(AGENTS_HEAD) && /up to 3 worker sub-agents/.test(p1) && sha64(b1.briefHash) && sha64(b1.skillsHash) && b1.briefHash === require("crypto").createHash("sha256").update(JSON.stringify([brief, e.M.agentsBrief(3)])).digest("hex") && i1.skillsMode === "full" && i1.briefMode === "full", { p1: p1.slice(0, 100), b1: { brief: b1.briefHash && b1.briefHash.slice(0, 8), skills: b1.skillsHash && b1.skillsHash.slice(0, 8) }, i1 });
    check("K04b", "unchanged briefs + skills → exactly two pointer lines (skills, briefs — the briefs pointer names BOTH active briefs) and nothing else; reviewer advice rides outside the hashes (pointers stay, hashes unchanged)", p2 === "TASK TWO\n\n" + POINTER + " (their saved procedures were provided earlier in this conversation and still apply): Codex tokens.\n\n" + BRIEFS_PTR + " — the role brief and the sub-agents brief given earlier in this conversation still apply." && i2.skillsMode === "pointer" && i2.briefMode === "pointer" && p3.startsWith("TASK THREE\n\n" + POINTER) && p3.includes(BRIEFS_PTR) && /REVIEWER ADVICE$/.test(p3) && !p3.includes(ROLE_HEAD) && b3.briefHash === b1.briefHash && b3.skillsHash === b1.skillsHash, { p2, p3tail: p3.slice(-120) });
    check("K04c", "a CHANGED role brief → the briefs in full again, each labelled as REPLACING its predecessor (skills still a pointer), new briefHash; the Agents switch turned off changes the briefs once more: the role brief (replacing) plus the explicit 'no sub-agents brief any more' line, no agents brief; same skillsHash throughout", p4.startsWith("TASK FOUR\n\n" + POINTER) && p4.includes(ROLE_HEAD_REPLACING + brief + " Report in bullet points.") && p4.includes(AGENTS_HEAD_REPLACING) && !p4.includes(AGENTS_GONE) && !p4.includes(BRIEFS_PTR) && b4.briefHash !== b1.briefHash && p5.includes(ROLE_HEAD_REPLACING + brief + " Report in bullet points.") && p5.includes(AGENTS_GONE) && !p5.includes(AGENTS_HEAD) && !p5.includes(BRIEFS_PTR) && history.bindingFor(coder, "openai").briefHash !== b4.briefHash && history.bindingFor(coder, "openai").skillsHash === b1.skillsHash && e.injections.length === 0, { p4: p4.slice(0, 200), p5: p5.slice(-260) }); }

  // K05 provider switching: each provider's thread has its own cache; K06 restart persistence + legacy bindings
  { const e = environment(); e.setProvider("anthropic");
    const sk = skillsMod.create(HOME, { name: "Switch rules", steps: "Keep the record exact." });
    const coder = roleChild(e, { selectedSkills: [sk.id] });
    await e.M.run(coder.id, { text: "ON CLAUDE", roleBrief: "Coder." });
    e.setProvider("openai"); await e.M.run(coder.id, { text: "ON CODEX", roleBrief: "Coder.", model: "gpt-5.5" });
    e.setProvider("anthropic"); await e.M.run(coder.id, { text: "BACK ON CLAUDE", roleBrief: "Coder.", model: "claude-opus-4-8" });
    const ba = history.bindingFor(coder, "anthropic"), bo = history.bindingFor(coder, "openai");
    check("K05", "Claude gets the procedures; the switch to Codex starts ITS thread with the procedures (and the brief) in full — the transferred record carries no skills block; back on Claude the resumed thread gets a pointer; each binding keeps its own hashes", e.sdkCalls[0].prompt.startsWith("ON CLAUDE\n\n" + SKILLS_HEAD) && e.appCalls[0].prompt.startsWith("ON CODEX\n\n" + SKILLS_HEAD) && e.appCalls[0].prompt.includes(ROLE_HEAD) && !JSON.stringify(e.injections).includes(SKILLS_HEAD) && e.sdkCalls[1].resume === "native-claude" && /BACK ON CLAUDE\n\n.*Skills active for this conversation/.test(e.sdkCalls[1].prompt) && !e.sdkCalls[1].prompt.includes(SKILLS_HEAD) && sha64(ba.skillsHash) && ba.skillsHash === bo.skillsHash && sha64(bo.briefHash) && !ba.briefHash, { claude2: e.sdkCalls[1].prompt.slice(-140), codex: e.appCalls[0].prompt.slice(0, 60), ba: { s: ba.skillsHash && ba.skillsHash.slice(0, 8), b: ba.briefHash }, bo: { s: bo.skillsHash && bo.skillsHash.slice(0, 8), b: bo.briefHash && bo.briefHash.slice(0, 8) } });
    // restart: the hashes survive normalizeBinding; a LEGACY binding (no hashes) resends once, then pointers
    store.flush(coder.id); store.flushAll(); store.loadAllSessions();
    const again = store.getSession(coder.id);
    const kept = { ...history.bindingFor(again, "anthropic") };
    await e.M.run(again.id, { text: "AFTER RESTART", roleBrief: "Coder." });
    const pr = e.sdkCalls[2].prompt;
    delete history.bindingFor(again, "anthropic").skillsHash;   // a binding saved by an older build
    await e.M.run(again.id, { text: "LEGACY ONE", roleBrief: "Coder." });
    await e.M.run(again.id, { text: "LEGACY TWO", roleBrief: "Coder." });
    check("K06", "reopened from disk: skillsHash / briefHash / briefKinds survive (normalizeBinding) → the next turn is a pointer; a legacy binding without the hash resends the procedures ONCE, then pointers", kept.skillsHash === ba.skillsHash && sha64(history.bindingFor(again, "openai").briefHash) && history.bindingFor(again, "openai").briefKinds === "r" && pr.startsWith("AFTER RESTART\n\n" + POINTER) && e.sdkCalls[3].prompt.startsWith("LEGACY ONE\n\n" + SKILLS_HEAD) && e.sdkCalls[4].prompt.startsWith("LEGACY TWO\n\n" + POINTER) && history.bindingFor(again, "anthropic").skillsHash === ba.skillsHash, { kept: kept.skillsHash && kept.skillsHash.slice(0, 8), pr: pr.slice(0, 60), l1: e.sdkCalls[3].prompt.slice(0, 60), l2: e.sdkCalls[4].prompt.slice(0, 60) });
    // K13 the stateless custom endpoint sends the full eligible procedures on EVERY request (no cache); a plain chat none
    e.setProvider("custom"); store.saveSettings({ customMode: "raw", customEndpoint: "http://127.0.0.1:9/v1" });
    const prompts = []; e.control.custom = async (opts) => { prompts.push(opts.prompt); return { ok: true, text: "custom" }; };
    await e.M.run(again.id, { text: "CUSTOM ONE", roleBrief: "Coder." }); await e.M.run(again.id, { text: "CUSTOM TWO", roleBrief: "Coder." });
    const plain = e.make({ selectedSkills: [sk.id] }); await e.M.run(plain.id, { text: "CUSTOM PLAIN" });
    store.saveSettings({ customMode: "" }); e.control.custom = null;
    check("K13", "the stateless custom endpoint carries the full procedures and the role brief on every request (no thread, no cache) — and nothing for a plain chat", prompts.length === 3 && prompts[0].startsWith("CUSTOM ONE\n\n" + SKILLS_HEAD) && prompts[1].startsWith("CUSTOM TWO\n\n" + SKILLS_HEAD) && prompts[1].includes(ROLE_HEAD) && prompts[2] === "CUSTOM PLAIN", { heads: prompts.map((p) => p.slice(0, 60)) }); }

  // K07 every FRESH-thread path recomposes the full appendix although the (kept) binding says "already delivered"
  { const e = environment(); e.setProvider("anthropic");
    const sk = skillsMod.create(HOME, { name: "Fresh rules", steps: "Fresh threads get everything." });
    const brief = "Coder.";
    // (a) Claude: lost native session → the fresh session's prompt carries the procedures; its init commits the hash to the NEW id
    const lost = roleChild(e, { selectedSkills: [sk.id], messages: [e.msg("user", "OLD"), e.msg("assistant", "A")] });
    await e.M.run(lost.id, { text: "WARM UP", roleBrief: brief });
    const hLost = hashOf(lost, "anthropic");
    history.setBinding(lost, "anthropic", { id: "gone" });   // the thread is gone; the same-id-less patch clears the cache — put it back to model a stale cache
    history.setBinding(lost, "anthropic", { skillsHash: hLost });
    let attempt = 0;
    e.control.sdk = async function* () { attempt++; if (attempt === 1) throw new Error("no conversation found"); yield { type: "system", subtype: "init", session_id: "new-native" }; yield { type: "result", subtype: "success", is_error: false, session_id: "new-native", usage: {} }; };
    await e.M.run(lost.id, { text: "AFTER LOSS", roleBrief: brief });
    e.control.sdk = null;
    const la = e.sdkCalls[1], lb = e.sdkCalls[2], lbind = history.bindingFor(lost, "anthropic");
    check("K07a", "Claude lost session: the resume attempt carried a pointer; the fresh attempt (no resume) carries the procedures in full + the record; the new native id holds the hash", la.resume === "gone" && la.prompt.includes(POINTER) && !la.prompt.includes(SKILLS_HEAD) && lb.resume === null && lb.prompt.includes(SKILLS_HEAD + " (their saved procedures):") && /^Conversation record/.test(lb.prompt) && lbind.id === "new-native" && lbind.skillsHash === hLost && lost.status === "done", { la: la.prompt.slice(-90), lb: lb.prompt.slice(-160), lbind: { id: lbind.id, h: lbind.skillsHash && lbind.skillsHash.slice(0, 8) } });
    // (b) Claude: prompt too long → the replacement session carries the procedures + the continuation note
    const big = roleChild(e, { selectedSkills: [sk.id], messages: [e.msg("user", "OLD"), e.msg("assistant", "A")] });
    await e.M.run(big.id, { text: "WARM UP", roleBrief: brief });
    attempt = 0;
    e.control.sdk = async function* () { attempt++; if (attempt === 1) { yield { type: "system", subtype: "init", session_id: "native-claude" }; yield { type: "assistant", message: { id: "part", content: [{ type: "text", text: "PARTIAL WORK" }] } }; throw new Error("prompt is too long"); } yield { type: "system", subtype: "init", session_id: "new-native-2" }; yield { type: "result", subtype: "success", is_error: false, session_id: "new-native-2", usage: {} }; };
    await e.M.run(big.id, { text: "OVERFLOW", roleBrief: brief });
    e.control.sdk = null;
    const oa = e.sdkCalls[4], ob = e.sdkCalls[5];
    check("K07b", "Claude overflow: the rejected resume attempt had a pointer; the replacement (fresh) carries the procedures in full, the completed work and the continuation note; its id holds the hash", oa.prompt.includes(POINTER) && ob.resume === null && ob.prompt.includes(SKILLS_HEAD) && ob.prompt.includes("PARTIAL WORK") && /Continuation note/.test(ob.prompt) && history.bindingFor(big, "anthropic").id === "new-native-2" && sha64(hashOf(big, "anthropic")), { oa: oa.prompt.slice(-80), ob: ob.prompt.slice(-260) });
    // (c) Claude: a requested rollover → fresh session with the procedures
    const roll = roleChild(e, { selectedSkills: [sk.id] });
    await e.M.run(roll.id, { text: "FIRST", roleBrief: brief }); e.M.requestRollover(roll.id, true);
    await e.M.run(roll.id, { text: "ROLLED", roleBrief: brief });
    const rc = e.sdkCalls[7];
    check("K07c", "Claude rollover: the fresh native session carries the procedures in full (the resumed one would have got a pointer)", rc.resume === null && rc.prompt.includes(SKILLS_HEAD) && !rc.prompt.includes(POINTER) && roll.status === "done", { rc: rc.prompt.slice(-120), resume: rc.resume });
    // (d) Codex app-server: lost thread + overflow → each replacement thread carries the full skills AND briefs
    e.setProvider("openai");
    const cx = roleChild(e, { model: "gpt-5.5", selectedSkills: [sk.id], messages: [e.msg("user", "OLD"), e.msg("assistant", "A")] });
    await e.M.run(cx.id, { text: "WARM UP", roleBrief: brief });
    let calls = 0;
    e.control.app = async (opts) => { calls++; return calls === 1 ? { ok: false, threadLost: true, error: "no rollout found" } : { ok: true, text: "ok" }; };
    await e.M.run(cx.id, { text: "AFTER LOSS", roleBrief: brief });
    const cl1 = e.appCalls[1], cl2 = e.appCalls[2];
    calls = 0;
    e.control.app = async (opts) => { calls++; return calls === 1 ? { ok: false, error: "context window exceeded", errorInfo: "contextWindowExceeded" } : { ok: true, text: "ok" }; };
    await e.M.run(cx.id, { text: "OVERFLOW", roleBrief: brief });
    e.control.app = null;
    const co1 = e.appCalls[3], co2 = e.appCalls[4], cb = history.bindingFor(cx, "openai");
    check("K07d", "Codex lost thread and Codex overflow: the failing resume attempts carried the two pointers; each replacement thread (no resume) carries the skills AND the role brief in full; the new thread holds both hashes", cl1.resume && cl1.prompt.includes(POINTER) && cl1.prompt.includes(BRIEFS_PTR) && cl2.resume === null && cl2.prompt.includes(SKILLS_HEAD) && cl2.prompt.includes(ROLE_HEAD + brief) && co1.resume && co1.prompt.includes(POINTER) && co2.resume === null && co2.prompt.includes(SKILLS_HEAD) && co2.prompt.includes(ROLE_HEAD) && /Continuation note|OVERFLOW/.test(co2.prompt) && cb.id === co2.id && sha64(cb.skillsHash) && sha64(cb.briefHash) && cx.status === "done", { cl1: cl1.prompt.slice(-100), cl2: cl2.prompt.slice(0, 80), co2: co2.prompt.slice(0, 80), cb: { id: cb.id, s: !!cb.skillsHash, b: !!cb.briefHash } });
    // (e) Codex SDK-exec fallback: a fresh exec thread (lost) and an overflow replacement carry everything; the resumed one a pointer
    const ex = roleChild(e, { model: "gpt-5.5", selectedSkills: [sk.id], messages: [e.msg("user", "OLD"), e.msg("assistant", "A")] });
    history.setBinding(ex, "openai", { id: "exec-thread", account: "login", syncedIndex: 1 });
    e.control.appEarly = async () => ({ ok: false, loadFailed: true, error: "app-server unavailable" });
    const execPrompts = []; let n = 0;
    e.control.exec = async (opts) => { n++; execPrompts.push({ resume: opts.resumeId, prompt: opts.promptText }); if (n === 1) { opts.on.onThreadId("exec-thread"); opts.on.onTurnStarted(); return { ok: true, text: "ok", threadId: "exec-thread" }; } if (n === 2) return { ok: false, threadLost: true, error: "no rollout found" }; opts.on.onThreadId("exec-" + n); opts.on.onTurnStarted(); return { ok: true, text: "ok", threadId: "exec-" + n }; };
    await e.M.run(ex.id, { text: "EXEC WARM UP", roleBrief: brief });
    await e.M.run(ex.id, { text: "EXEC AFTER LOSS", roleBrief: brief });
    const hx = hashOf(ex, "openai");
    n = 10; e.control.exec = async (opts) => { n++; execPrompts.push({ resume: opts.resumeId, prompt: opts.promptText }); if (n === 11) { opts.on.onThreadId(opts.resumeId); opts.on.onTurnStarted(); return { ok: false, error: "context window exceeded", errorInfo: "contextWindowExceeded" }; } opts.on.onThreadId("exec-fresh"); opts.on.onTurnStarted(); return { ok: true, text: "ok", threadId: "exec-fresh" }; };
    await e.M.run(ex.id, { text: "EXEC OVERFLOW", roleBrief: brief });
    e.control.appEarly = null; e.control.exec = null;
    const [x1, x2, x3, x4, x5] = execPrompts, xb = history.bindingFor(ex, "openai");
    check("K07e", "Codex exec fallback: the first resumed exec turn (legacy binding) sends everything and its turn.started commits; the lost-thread retry's resume attempt is a pointer, the fresh exec thread gets everything; the overflow replacement (fresh) gets everything too; the new id holds the hashes", x1.resume === "exec-thread" && x1.prompt.includes(SKILLS_HEAD) && x1.prompt.includes(ROLE_HEAD) && x2.resume === "exec-thread" && x2.prompt.includes(POINTER) && x2.prompt.includes(BRIEFS_PTR) && x3.resume === null && x3.prompt.includes(SKILLS_HEAD) && x3.prompt.includes(ROLE_HEAD) && sha64(hx) && x4.resume === "exec-3" && x4.prompt.includes(POINTER) && x5.resume === null && x5.prompt.includes(SKILLS_HEAD) && x5.prompt.includes(ROLE_HEAD) && xb.id === "exec-fresh" && xb.skillsHash === hx && sha64(xb.briefHash) && ex.status === "done", { x: execPrompts.map((p) => [p.resume, p.prompt.replace(/[\s\S]*?(Skills|Briefs)/, "$1").slice(0, 40)]), xb: { id: xb.id, s: xb.skillsHash && xb.skillsHash.slice(0, 8) }, status: ex.status }); }

  // K08 pre-acceptance failures commit nothing (the retry sends everything again); K09 accepted partial failures commit (the retry sends pointers); K10 late callbacks change nothing
  { const e = environment(); e.setProvider("anthropic");
    const sk = skillsMod.create(HOME, { name: "Accept rules", steps: "Commit on acceptance only." });
    const brief = "Coder.";
    // (a) Claude: the CLI dies before init (network) → no hash; the preserved retry carries the procedures again and commits
    const c1 = roleChild(e, { selectedSkills: [sk.id] });
    e.control.sdk = async function* () { throw new Error("read ECONNRESET"); };
    await e.M.run(c1.id, { text: "TRY", roleBrief: brief });
    const noCommit = { hash: hashOf(c1, "anthropic"), status: c1.status, pending: !!c1._pendingRetry };
    e.control.sdk = null;
    const payload = c1._pendingRetry; delete c1._pendingRetry;
    await e.M.run(c1.id, payload);
    check("K08a", "Claude: a failure BEFORE init commits no hash (offline, turn preserved); the retry carries the procedures in full and its init commits", noCommit.hash === "" && noCommit.status === "offline" && noCommit.pending && e.sdkCalls[0].prompt.includes(SKILLS_HEAD) && e.sdkCalls[1].prompt.includes(SKILLS_HEAD) && sha64(hashOf(c1, "anthropic")) && c1.status === "done", { noCommit, p1: e.sdkCalls[1].prompt.slice(0, 60) });
    // (b) Claude: accepted (init + partial output) then failure → the hash IS committed; the retry sends a pointer, no replay
    const c2 = roleChild(e, { selectedSkills: [sk.id] });
    e.control.sdk = async function* () { yield { type: "system", subtype: "init", session_id: "native-claude" }; yield { type: "assistant", message: { id: "p", content: [{ type: "text", text: "PARTIAL" }] } }; throw new Error("boom: provider dropped"); };
    await e.M.run(c2.id, { text: "RETRY THIS", roleBrief: brief });
    e.control.sdk = null;
    const committed = hashOf(c2, "anthropic");
    const pid = c2.messages.find((m) => m.role === "user" && m.text === "RETRY THIS").id;
    await e.M.run(c2.id, { text: "RETRY THIS", resumeContinuation: true, promptMessageId: pid, roleBrief: brief });
    check("K09a", "Claude: an ACCEPTED turn that failed afterwards committed the hash at init; the retry resumes with a pointer (no procedures, no replay of the partial output)", sha64(committed) && e.sdkCalls[3].resume === "native-claude" && e.sdkCalls[3].prompt.startsWith("RETRY THIS\n\n" + POINTER) && !e.sdkCalls[3].prompt.includes("PARTIAL") && hashOf(c2, "anthropic") === committed, { committed: committed.slice(0, 8), p: e.sdkCalls[3].prompt.slice(0, 80) });
    // (c) Codex app-server: the record injection fails BEFORE turn/started → nothing bound, nothing committed; the next turn sends everything
    e.setProvider("openai");
    const c3 = roleChild(e, { model: "gpt-5.5", selectedSkills: [sk.id], messages: [e.msg("user", "OLD"), e.msg("assistant", "A")] });
    e.control.onInject = async () => { throw new Error("inject failed"); };
    await e.M.run(c3.id, { text: "FIRST", roleBrief: brief });
    const b3a = { ...history.bindingFor(c3, "openai") }, st3 = c3.status;
    e.control.onInject = null;
    await e.M.run(c3.id, { text: "SECOND", roleBrief: brief });
    const b3b = history.bindingFor(c3, "openai");
    check("K08c", "Codex: thread/start + a failed injection (no turn/started) bind no thread and commit no hash; the next turn's new thread gets everything and commits both hashes", b3a.id === null && !b3a.skillsHash && !b3a.briefHash && st3 === "error" && e.appCalls[0].prompt.includes(SKILLS_HEAD) && e.appCalls[1].prompt.includes(SKILLS_HEAD) && e.appCalls[1].prompt.includes(ROLE_HEAD) && b3b.id === e.appCalls[1].id && sha64(b3b.skillsHash) && sha64(b3b.briefHash) && c3.status === "done", { b3a, st3, b3b: { id: b3b.id, s: !!b3b.skillsHash, b: !!b3b.briefHash } });
    // (d) Codex: turn/started then an error → committed; the retry sends pointers only
    const c4 = roleChild(e, { model: "gpt-5.5", selectedSkills: [sk.id] });
    e.control.app = async () => ({ ok: false, error: "boom after acceptance" });
    await e.M.run(c4.id, { text: "ACCEPTED", roleBrief: brief });
    e.control.app = null;
    const b4 = { ...history.bindingFor(c4, "openai") };
    const pid4 = c4.messages.find((m) => m.role === "user" && m.text === "ACCEPTED").id;
    await e.M.run(c4.id, { text: "ACCEPTED", resumeContinuation: true, promptMessageId: pid4, roleBrief: brief });
    check("K09b", "Codex: turn/started then failure → both hashes committed; the retry on the same thread carries the two pointers only (the briefs pointer names the role brief alone — no agents brief was ever active)", sha64(b4.skillsHash) && sha64(b4.briefHash) && e.appCalls[2].prompt.includes(SKILLS_HEAD) && e.appCalls[3].resume === b4.id && e.appCalls[3].prompt === "ACCEPTED\n\n" + POINTER + " (their saved procedures were provided earlier in this conversation and still apply): Accept rules.\n\n" + BRIEFS_PTR + " — the role brief given earlier in this conversation still applies.", { b4: { id: b4.id, s: !!b4.skillsHash }, p: e.appCalls[3].prompt });
    // (e) Codex exec: thread.started alone (no turn.started, then failure) commits nothing; the next turn sends everything
    const c5 = roleChild(e, { model: "gpt-5.5", selectedSkills: [sk.id] });
    e.control.appEarly = async () => ({ ok: false, loadFailed: true, error: "fixture" });
    let sent = [];
    e.control.exec = async (opts) => { sent.push(opts.promptText); opts.on.onThreadId("empty-thread"); return { ok: false, error: "rejected before acceptance", threadId: "empty-thread" }; };
    await e.M.run(c5.id, { text: "UNACCEPTED", roleBrief: brief });
    const b5 = { ...history.bindingFor(c5, "openai") };
    e.control.exec = async (opts) => { sent.push(opts.promptText); opts.on.onThreadId("accepted-thread"); opts.on.onTurnStarted(); return { ok: true, text: "done", threadId: "accepted-thread" }; };
    await e.M.run(c5.id, { text: "RECOVER", roleBrief: brief });
    e.control.appEarly = null; e.control.exec = null;
    const b5b = history.bindingFor(c5, "openai");
    check("K08e", "Codex exec: thread.started alone binds nothing and commits nothing; the accepted next turn carries everything (and the unaccepted prompt) and commits with the id", b5.id === null && !b5.skillsHash && sent[0].includes(SKILLS_HEAD) && sent[1].includes(SKILLS_HEAD) && sent[1].includes("UNACCEPTED") && b5b.id === "accepted-thread" && sha64(b5b.skillsHash) && sha64(b5b.briefHash), { b5, b5b: { id: b5b.id, s: !!b5b.skillsHash } });
    // (f) late callbacks: a stopped Codex run's turn/started after Stop + a completed replacement commits nothing to the new binding; a late Claude init of an interrupted run commits nothing
    e.M.interruptGraceMs = 20;
    const c6 = roleChild(e, { model: "gpt-5.5", selectedSkills: [sk.id] });
    let finishOld = null, oldOpts = null;
    e.control.app = (opts) => { oldOpts = opts; return new Promise((r) => { finishOld = r; }); };
    const runA = e.M.run(c6.id, { text: "SLOW", roleBrief: brief });
    await sleep(20);
    await e.M.interrupt(c6.id, "stop");
    e.control.app = null;
    history.dropBinding(c6, "openai");
    c6.selectedSkills = [];   // the replacement turn runs with NO skills: its thread must hold an empty cache, whatever the ghost says
    await e.M.run(c6.id, { text: "NEW", roleBrief: brief });
    const afterB = JSON.stringify(history.bindingFor(c6, "openai"));
    oldOpts.on.onThreadId("ghost-thread", true, "login"); oldOpts.on.onTurnId("turn-ghost");
    finishOld({ ok: true, text: "LATE" });
    await runA;
    const c7 = roleChild(e, { selectedSkills: [sk.id] });
    history.setBinding(c7, "anthropic", { id: "retained-native", syncedIndex: 0 });
    const old = { id: "stopped-run", interrupted: true, promptIndex: 20, bindingProvider: "anthropic", attempt: { commit: { skillsHash: "ghost".repeat(16).slice(0, 64) } } };
    e.M.handleMessage(c7, { type: "system", subtype: "init", session_id: "late-empty-thread" }, old);
    check("K10", "late callbacks: the stopped Codex run's ghost turn/started leaves the replacement's binding byte-identical (empty skills cache included); a late Claude init of an interrupted run commits nothing", JSON.stringify(history.bindingFor(c6, "openai")) === afterB && history.bindingFor(c6, "openai").skillsHash === "" && !e.appCalls[e.appCalls.length - 1].prompt.includes(SKILLS_HEAD) && c6.status === "done" && !history.bindingFor(c7, "anthropic").skillsHash && history.bindingFor(c7, "anthropic").id === "retained-native" && !old.accepted, { afterB, now: JSON.stringify(history.bindingFor(c6, "openai")), c7: history.bindingFor(c7, "anthropic") }); }

  // K11 Claude conversation_reset (/clear inside the CLI, 2026-09-18): the fresh context has seen NOTHING — the binding follows the new id
  // with its caches dropped and the cursor at −1; this run commits nothing more; the next turn transfers the whole record and resends
  // the procedures in full (no pointer), and ITS init commits the hash to the new id
  { const e = environment(); e.setProvider("anthropic");
    const sk = skillsMod.create(HOME, { name: "Reset rules", steps: "Survive a /clear." });
    const rs = roleChild(e, { selectedSkills: [sk.id] });
    await e.M.run(rs.id, { text: "TASK ONE", roleBrief: "Coder." });
    const h1 = hashOf(rs, "anthropic"), before = { ...history.bindingFor(rs, "anthropic") };
    // turn 2: the CLI accepts the resumed turn (init), then resets its conversation; the result still names the OLD session id
    e.control.sdk = async function* (call) { yield { type: "system", subtype: "init", session_id: call.resume || "native-claude" }; yield { type: "conversation_reset", new_conversation_id: "fresh-ctx", session_id: "native-claude", uuid: "u1" }; yield { type: "result", subtype: "success", is_error: false, session_id: "native-claude", usage: {} }; };
    await e.M.run(rs.id, { text: "TASK TWO", roleBrief: "Coder." });
    e.control.sdk = null;
    const p2 = e.sdkCalls[1].prompt, afterReset = { ...history.bindingFor(rs, "anthropic") }, info2 = e.M.lastRunInfo();
    const resetNotes = rs.messages.filter((m) => m.role === "system" && /fresh conversation context/.test(m.text)).length;
    await e.M.run(rs.id, { text: "TASK THREE", roleBrief: "Coder." });
    const c3 = e.sdkCalls[2], b3 = { ...history.bindingFor(rs, "anthropic") };
    check("K11", "Claude reset: turn 2 resumed with a pointer; after the reset the binding is the NEW id with no skills hash, cursor −1, measurement cleared (nothing recommitted at the run's end, the old id never rebound by the result), the note shown once; turn 3 resumes the new id, carries the whole record (both earlier prompts) AND the procedures in full without 'replace' wording, no pointer — and its init commits the hash to the new id", sha64(h1) && before.id === "native-claude" && p2.startsWith("TASK TWO\n\n" + POINTER) && afterReset.id === "fresh-ctx" && !afterReset.skillsHash && !("skillsHash" in afterReset) && afterReset.syncedIndex === -1 && afterReset.activeTokens === 0 && rs.status === "done" && resetNotes === 1 && info2.conversationReset === "fresh-ctx" && c3.resume === "fresh-ctx" && /^Conversation record/.test(c3.prompt) && c3.prompt.includes("TASK ONE") && c3.prompt.includes("TASK TWO") && c3.prompt.includes("TASK THREE\n\n" + SKILLS_HEAD + " (their saved procedures):") && /Survive a \/clear/.test(c3.prompt) && !c3.prompt.includes(POINTER) && !/replace any skills/.test(c3.prompt) && b3.id === "fresh-ctx" && b3.skillsHash === h1 && b3.syncedIndex === history.lastGlobalIndex(rs), { p2: p2.slice(0, 80), afterReset, c3: [c3.resume, c3.prompt.slice(0, 40), c3.prompt.slice(-140)], b3: { id: b3.id, h: b3.skillsHash && b3.skillsHash.slice(0, 8), synced: b3.syncedIndex } });
    // a reset delivered to a runner that does not own the session changes nothing (the K10 pattern): an interrupted runner, and a run the session superseded
    const c8 = roleChild(e, { selectedSkills: [sk.id] });
    history.setBinding(c8, "anthropic", { id: "retained-native", syncedIndex: 0, skillsHash: h1 });
    const ghost = { id: "stopped-run", interrupted: true, promptIndex: 20, bindingProvider: "anthropic", attempt: { commit: { skillsHash: "ghost".repeat(16).slice(0, 64) } } };
    e.M.handleMessage(c8, { type: "conversation_reset", new_conversation_id: "ghost-ctx", session_id: "retained-native", uuid: "u2" }, ghost);
    const c9 = roleChild(e, { selectedSkills: [sk.id] });
    await e.M.run(c9.id, { text: "ONE", roleBrief: "Coder." });
    const c9Before = JSON.stringify(history.bindingFor(c9, "anthropic")), c9Msgs = c9.messages.length;
    const superseded = { id: "not-the-latest-run", interrupted: false, promptIndex: 1, bindingProvider: "anthropic", attempt: { commit: { skillsHash: "x" } } };
    e.M.handleMessage(c9, { type: "conversation_reset", new_conversation_id: "ghost-ctx-2", session_id: "native-claude", uuid: "u3" }, superseded);
    check("K11b", "a conversation_reset for an INTERRUPTED runner, or for a run the session has since superseded, changes nothing: id, hash and cursor stay, no note is added, no reset is recorded on the ghost runner", history.bindingFor(c8, "anthropic").id === "retained-native" && history.bindingFor(c8, "anthropic").skillsHash === h1 && history.bindingFor(c8, "anthropic").syncedIndex === 0 && !c8.messages.some((m) => m.role === "system") && !ghost.resetSeen && ghost.attempt && JSON.stringify(history.bindingFor(c9, "anthropic")) === c9Before && c9.messages.length === c9Msgs && history.bindingFor(c9, "anthropic").id === "native-claude" && sha64(hashOf(c9, "anthropic")) && !superseded.resetSeen, { c8: history.bindingFor(c8, "anthropic"), c9: history.bindingFor(c9, "anthropic"), c9Before }); }

  // K11c Claude reset MID-RUN (decision 2026-09-18, after the round-3 review): NOTHING is injected into the run — the current turn finishes
  // in the fresh context as the CLI compacted it (no message is pushed onto the open input stream, no "carried" note), the run's end does
  // not advance the cursor (the fresh context holds none of the record), the frozen attempt is retired (its hash is never recommitted), a
  // late init naming the retired id binds nothing; the NEXT user turn resumes the fresh id with the whole record — the reply the fresh
  // context produced included — and the procedures in FULL (skillsMode "full", no pointer), and ITS init commits hash + cursor to the new
  // id; the turn after that is a pointer again
  { const e = environment(); e.setProvider("anthropic");
    const sk = skillsMod.create(HOME, { name: "Reset rules", steps: "Survive a /clear." });
    const rs = roleChild(e, { selectedSkills: [sk.id] });
    await e.M.run(rs.id, { text: "TASK ONE", roleBrief: "Coder." });
    const h1 = hashOf(rs, "anthropic");
    const seen = {};
    // the CLI accepts the resumed turn, resets its conversation, emits a late init of the CLEARED conversation, then announces the fresh
    // context and finishes the task there; the pause after the reset is where an asynchronous restore used to push its message
    e.control.sdk = async function* (call) {
      yield { type: "system", subtype: "init", session_id: call.resume || "native-claude" };
      seen.afterAccept = { ...history.bindingFor(rs, "anthropic") };
      yield { type: "conversation_reset", new_conversation_id: "fresh-ctx", session_id: "native-claude", uuid: "u1" };
      const r = e.M.runners.get(rs.id); seen.afterReset = { ...history.bindingFor(rs, "anthropic") }; seen.retired = [...(r.retiredIds || [])]; seen.attemptAfterReset = r.attempt; seen.acceptedAfterReset = !!r.accepted;
      await sleep(40); seen.inputsAfterReset = call.inputs.length;
      yield { type: "system", subtype: "init", session_id: "native-claude" };   // late init naming the CLEARED conversation (the resumed-thread branch)
      seen.afterLate = { ...history.bindingFor(rs, "anthropic") }; seen.acceptedAfterLate = !!r.accepted;
      yield { type: "system", subtype: "init", session_id: "fresh-ctx" };
      seen.afterInit = { ...history.bindingFor(rs, "anthropic") }; seen.acceptedAfterInit = !!r.accepted; seen.attemptAfterInit = r.attempt;
      yield { type: "assistant", message: { id: "a-fresh", content: [{ type: "text", text: "Continuing in the fresh context." }] } };
      yield { type: "result", subtype: "success", is_error: false, session_id: "fresh-ctx", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };
    };
    await e.M.run(rs.id, { text: "TASK TWO", roleBrief: "Coder." });
    e.control.sdk = null;
    const c2 = e.sdkCalls[1], bEnd = { ...history.bindingFor(rs, "anthropic") }, info2 = e.M.lastRunInfo();
    const noCaches = (b) => !!b && !("skillsHash" in b) && !("briefHash" in b) && !("briefKinds" in b);
    check("K11c", "Claude reset mid-run: turn 2 resumed with a pointer and its init committed it; after the reset the binding is the fresh id with NO delivery caches, cursor −1 and measurement cleared, the frozen attempt and the acceptance are dropped and the old id is retired; NOTHING was pushed onto the open input stream (checked after the reset and at the end) and no 'carried' note exists; the late init naming the retired id rebinds and accepts nothing; the fresh context's init keeps the fresh id but commits neither hash nor cursor and accepts nothing; the task completed in the same run and the run's end left the cursor at −1", e.sdkCalls.length === 2 && c2.resume === "native-claude" && c2.prompt.startsWith("TASK TWO\n\n" + POINTER) && seen.afterAccept.skillsHash === h1
      && seen.afterReset.id === "fresh-ctx" && noCaches(seen.afterReset) && seen.afterReset.syncedIndex === -1 && seen.afterReset.activeTokens === 0 && seen.attemptAfterReset === null && seen.acceptedAfterReset === false && seen.retired.join() === "native-claude"
      && seen.inputsAfterReset === 0 && c2.inputs.length === 0 && !rs.messages.some((m) => m.role === "system" && /carried .* into Claude's fresh context/.test(m.text)) && !info2.resetRestore
      && seen.afterLate.id === "fresh-ctx" && noCaches(seen.afterLate) && seen.afterLate.syncedIndex === -1 && seen.acceptedAfterLate === false
      && seen.afterInit.id === "fresh-ctx" && noCaches(seen.afterInit) && seen.afterInit.syncedIndex === -1 && seen.acceptedAfterInit === false && seen.attemptAfterInit === null
      && bEnd.id === "fresh-ctx" && noCaches(bEnd) && bEnd.syncedIndex === -1 && rs.status === "done" && rs.messages.some((m) => m.role === "assistant" && /Continuing in the fresh context/.test(m.text)) && info2.conversationReset === "fresh-ctx",
      { c2: [c2.resume, c2.prompt.slice(0, 60), c2.inputs.length], afterReset: seen.afterReset, retired: seen.retired, inputsAfterReset: seen.inputsAfterReset, afterLate: seen.afterLate && { ...seen.afterLate, accepted: seen.acceptedAfterLate }, afterInit: seen.afterInit && { ...seen.afterInit, accepted: seen.acceptedAfterInit, attempt: !!seen.attemptAfterInit }, bEnd, status: rs.status, restore: info2.resetRestore });
    // the NEXT user turn is composed for the fresh context: no accepted hash → the digests in full; cursor −1 → the record from the start
    await e.M.run(rs.id, { text: "TASK THREE", roleBrief: "Coder." });
    const c3 = e.sdkCalls[2], b3 = { ...history.bindingFor(rs, "anthropic") }, info3 = e.M.lastRunInfo();
    check("K11c-next", "the next user turn after a reset resumes the fresh id, carries the whole record (both earlier prompts AND the reply the fresh context gave) and the procedures in FULL under the skills label — skillsMode 'full', no pointer, no 'replace' wording — pushes nothing extra, and its init commits the attempt's hash with the cursor at the record's end", e.sdkCalls.length === 3 && c3.resume === "fresh-ctx" && info3.sent.skillsMode === "full" && /^Conversation record/.test(c3.prompt) && c3.prompt.includes("TASK ONE") && c3.prompt.includes("TASK TWO") && c3.prompt.includes("Continuing in the fresh context") && c3.prompt.includes("TASK THREE\n\n" + SKILLS_HEAD + " (their saved procedures):") && /Survive a \/clear/.test(c3.prompt) && !c3.prompt.includes(POINTER) && !/replace any skills/.test(c3.prompt) && c3.inputs.length === 0 && b3.id === "fresh-ctx" && b3.skillsHash === h1 && sha64(b3.skillsHash) && b3.syncedIndex === history.lastGlobalIndex(rs) && rs.status === "done", { c3: [c3.resume, info3.sent.skillsMode, c3.prompt.slice(0, 60), c3.prompt.slice(-160)], b3: { id: b3.id, h: b3.skillsHash && b3.skillsHash.slice(0, 8), synced: b3.syncedIndex, last: history.lastGlobalIndex(rs) } });
    await e.M.run(rs.id, { text: "TASK FOUR", roleBrief: "Coder." });
    const c4 = e.sdkCalls[3];
    check("K11c-pointer", "the turn after that resumes the fresh id with a POINTER and no record transfer (the fresh context now holds both)", e.sdkCalls.length === 4 && c4.resume === "fresh-ctx" && c4.prompt.startsWith("TASK FOUR\n\n" + POINTER) && !/Conversation record/.test(c4.prompt) && !/Survive a \/clear/.test(c4.prompt) && hashOf(rs, "anthropic") === h1 && history.bindingFor(rs, "anthropic").syncedIndex === history.lastGlobalIndex(rs), { c4: [c4.resume, c4.prompt.slice(0, 80)] }); }

  // K11d reset BEFORE the replacement's init (a rollover: the old thread A stays bound, freshThread pending) and a SECOND reset in the same
  // run: EVERY id the run retired is refused by both init branches — an init naming A after reset(A→B) rebound A through the replacement
  // branch (it skipped the cleared-id check, 2026-09-18), and remembering only the LAST retired id let an init naming A rebind it after
  // reset(B→C). The init naming C ends the replacement and commits nothing (resetSeen); a result naming a retired id rebinds nothing; the
  // run ends on C with the cursor at −1 and nothing pushed; the next user turn is C's first delivery (the record + the digests in full)
  { const e = environment(); e.setProvider("anthropic");
    const sk = skillsMod.create(HOME, { name: "Rollover rules", steps: "Roll over safely." });
    const rs = roleChild(e, { selectedSkills: [sk.id] });
    await e.M.run(rs.id, { text: "TASK ONE", roleBrief: "Coder." });
    const h1 = hashOf(rs, "anthropic");
    rs.forceRollover = true;   // turn 2 starts a FRESH native session; "native-claude" (A) stays bound until the replacement accepts
    const seen = {};
    e.control.sdk = async function* (call) {
      const r = e.M.runners.get(rs.id); seen.call = call; seen.freshBefore = r.freshThread; seen.boundBefore = history.bindingFor(rs, "anthropic").id;
      const snap = (k) => { seen[k] = { b: { ...history.bindingFor(rs, "anthropic") }, fresh: r.freshThread, accepted: !!r.accepted, attempt: r.attempt, retired: [...(r.retiredIds || [])].sort() }; };
      yield { type: "conversation_reset", new_conversation_id: "ctx-b", session_id: "native-claude", uuid: "u1" };   // A → B
      snap("afterReset1");
      yield { type: "system", subtype: "init", session_id: "native-claude" };   // late init naming A, cleared by the first reset (the replacement branch)
      snap("afterLateA1");
      yield { type: "conversation_reset", new_conversation_id: "ctx-c", session_id: "ctx-b", uuid: "u2" };   // B → C
      snap("afterReset2");
      yield { type: "system", subtype: "init", session_id: "native-claude" };   // A again: a last-id-only guard has forgotten it by now
      snap("afterLateA2");
      yield { type: "system", subtype: "init", session_id: "ctx-b" };   // B: retired by the second reset
      snap("afterLateB");
      await sleep(40); seen.inputs = call.inputs.length;
      yield { type: "system", subtype: "init", session_id: "ctx-c" };   // the active context
      snap("afterInit");
      yield { type: "assistant", message: { id: "a-roll", content: [{ type: "text", text: "Rolled over and continuing." }] } };
      yield { type: "result", subtype: "success", is_error: false, session_id: "native-claude", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };   // a result naming a RETIRED id
      snap("afterResult");
    };
    await e.M.run(rs.id, { text: "TASK TWO", roleBrief: "Coder." });
    e.control.sdk = null;
    const bEnd = { ...history.bindingFor(rs, "anthropic") };
    // a refused init / a reset leaves: the fresh id bound, cursor −1, no hash, the replacement pending, nothing accepted, no attempt
    const refused = (k, id) => !!seen[k] && seen[k].b.id === id && seen[k].b.syncedIndex === -1 && !("skillsHash" in seen[k].b) && seen[k].fresh === true && seen[k].accepted === false && seen[k].attempt === null;
    check("K11d", "double reset during a pending rollover: reset(A→B) binds B (cursor −1, no hash), retires A and leaves the replacement pending; the late init naming A rebinds nothing, ends no replacement, accepts and commits nothing; reset(B→C) binds C and retires B too (both ids remembered); inits naming A and B are BOTH refused; the init naming C ends the replacement, keeps C and commits neither hash nor cursor; the result naming A rebinds nothing; the run completes on C with the cursor at −1, nothing pushed, one note per reset", seen.call.resume === null && seen.freshBefore === true && seen.boundBefore === "native-claude"
      && refused("afterReset1", "ctx-b") && seen.afterReset1.retired.join() === "native-claude"
      && refused("afterLateA1", "ctx-b")
      && refused("afterReset2", "ctx-c") && seen.afterReset2.retired.join() === "ctx-b,native-claude"
      && refused("afterLateA2", "ctx-c") && refused("afterLateB", "ctx-c")
      && seen.inputs === 0 && seen.call.inputs.length === 0
      && seen.afterInit.b.id === "ctx-c" && seen.afterInit.fresh === false && seen.afterInit.accepted === false && seen.afterInit.attempt === null && !("skillsHash" in seen.afterInit.b) && seen.afterInit.b.syncedIndex === -1
      && seen.afterResult.b.id === "ctx-c" && seen.afterResult.b.syncedIndex === -1
      && bEnd.id === "ctx-c" && !("skillsHash" in bEnd) && bEnd.syncedIndex === -1 && rs.status === "done" && e.sdkCalls.length === 2 && rs.messages.filter((m) => m.role === "system" && /fresh conversation context/.test(m.text)).length === 2,
      { call: seen.call && [seen.call.resume, seen.call.prompt.slice(0, 40)], freshBefore: seen.freshBefore, afterReset1: seen.afterReset1, afterLateA1: seen.afterLateA1, afterReset2: seen.afterReset2, afterLateA2: seen.afterLateA2, afterLateB: seen.afterLateB, inputs: seen.inputs, afterInit: seen.afterInit, afterResult: seen.afterResult && seen.afterResult.b, bEnd, status: rs.status });
    await e.M.run(rs.id, { text: "TASK THREE", roleBrief: "Coder." });
    const c3 = e.sdkCalls[2], b3 = { ...history.bindingFor(rs, "anthropic") };
    check("K11d-next", "after the double reset the next user turn resumes C, carries the record from the start and the procedures in full (no pointer), and its init commits the hash to C with the cursor at the record's end", e.sdkCalls.length === 3 && c3.resume === "ctx-c" && e.M.lastRunInfo().sent.skillsMode === "full" && /^Conversation record/.test(c3.prompt) && c3.prompt.includes("TASK ONE") && c3.prompt.includes("Rolled over and continuing") && /Roll over safely/.test(c3.prompt) && !c3.prompt.includes(POINTER) && c3.inputs.length === 0 && b3.id === "ctx-c" && b3.skillsHash === h1 && b3.syncedIndex === history.lastGlobalIndex(rs) && rs.status === "done", { c3: [c3.resume, c3.prompt.slice(0, 60)], b3: { id: b3.id, h: b3.skillsHash && b3.skillsHash.slice(0, 8), synced: b3.syncedIndex, last: history.lastGlobalIndex(rs) } }); }

  // K11e reset naming the SAME id (round-4 review, 2026-09-18): the CLI reports new_conversation_id === the bound id. history.setBinding
  // drops the delivery caches only on an ID CHANGE, so the reset case's explicit fallback (`!fresh || fresh === prevId` → delete the three)
  // is the ONLY thing clearing them here — K11 / K11c / K11d always change the id and never reach that line. All THREE caches are seeded
  // on the bound id (a same-id patch keeps them; turn 2's own init commits only skillsHash, another same-id patch, so they are provably
  // still there right before the reset) and must ALL be gone after it, with the cursor at −1 and the measurement cleared; the attempt
  // and the acceptance are dropped; NOTHING is retired (the id did not change), so a later init naming the id is the ACTIVE context —
  // kept, not refused — yet commits nothing (resetSeen); the run ends with the cursor at −1; the next user turn resumes the SAME id with
  // the whole record and the digests in full, and ITS init commits the hash with the cursor at the record's end (the stale briefs never return)
  { const e = environment(); e.setProvider("anthropic");
    const sk = skillsMod.create(HOME, { name: "Same-id rules", steps: "Survive a same-id /clear." });
    const rs = roleChild(e, { selectedSkills: [sk.id] });
    await e.M.run(rs.id, { text: "TASK ONE", roleBrief: "Coder." });
    const h1 = hashOf(rs, "anthropic");
    history.setBinding(rs, "anthropic", { briefHash: "b".repeat(64), briefKinds: "r" });   // seed the other two on the same id: all three caches present
    const seeded = { ...history.bindingFor(rs, "anthropic") };
    const seen = {};
    e.control.sdk = async function* (call) {
      const r = e.M.runners.get(rs.id);
      const snap = (k) => { seen[k] = { b: { ...history.bindingFor(rs, "anthropic") }, accepted: !!r.accepted, attempt: r.attempt, retired: [...(r.retiredIds || [])], resetSeen: !!r.resetSeen }; };
      yield { type: "system", subtype: "init", session_id: call.resume || "native-claude" };
      snap("afterAccept");
      yield { type: "conversation_reset", new_conversation_id: "native-claude", session_id: "native-claude", uuid: "u1" };   // the SAME id, UNCHANGED
      snap("afterReset");
      await sleep(40); seen.inputsAfterReset = call.inputs.length;
      yield { type: "system", subtype: "init", session_id: "native-claude" };   // names the ACTIVE context: not refused, still commits nothing
      snap("afterInit");
      yield { type: "assistant", message: { id: "a-same", content: [{ type: "text", text: "Continuing in the cleared context." }] } };
      yield { type: "result", subtype: "success", is_error: false, session_id: "native-claude", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };
    };
    await e.M.run(rs.id, { text: "TASK TWO", roleBrief: "Coder." });
    e.control.sdk = null;
    const c2 = e.sdkCalls[1], bEnd = { ...history.bindingFor(rs, "anthropic") }, info2 = e.M.lastRunInfo();
    const noCaches = (b) => !!b && !("skillsHash" in b) && !("briefHash" in b) && !("briefKinds" in b);
    const allCaches = (b) => !!b && b.skillsHash === h1 && b.briefHash === "b".repeat(64) && b.briefKinds === "r";
    check("K11e", "Claude reset naming the SAME id: all three caches were seeded and survived turn 2's pointer init; after the reset the id is unchanged yet NONE of skillsHash / briefHash / briefKinds remains, cursor −1, measurement cleared, attempt and acceptance dropped, resetSeen set and NOTHING retired; nothing pushed onto the input; the later init naming the id is not refused (id kept) but commits nothing; the run ends on the same id with the cursor at −1, the note shown once, the reset recorded with its id", sha64(h1) && seeded.id === "native-claude" && allCaches(seeded)
      && e.sdkCalls.length === 2 && c2.resume === "native-claude" && c2.prompt.startsWith("TASK TWO\n\n" + POINTER) && seen.afterAccept.accepted === true && allCaches(seen.afterAccept.b)
      && seen.afterReset.b.id === "native-claude" && noCaches(seen.afterReset.b) && seen.afterReset.b.syncedIndex === -1 && seen.afterReset.b.activeTokens === 0 && seen.afterReset.b.ctxUsage === null && seen.afterReset.attempt === null && seen.afterReset.accepted === false && seen.afterReset.resetSeen === true && seen.afterReset.retired.length === 0
      && seen.inputsAfterReset === 0 && c2.inputs.length === 0
      && seen.afterInit.b.id === "native-claude" && noCaches(seen.afterInit.b) && seen.afterInit.b.syncedIndex === -1 && seen.afterInit.accepted === false && seen.afterInit.attempt === null && seen.afterInit.retired.length === 0
      && bEnd.id === "native-claude" && noCaches(bEnd) && bEnd.syncedIndex === -1 && rs.status === "done" && info2.conversationReset === "native-claude" && rs.messages.filter((m) => m.role === "system" && /fresh conversation context/.test(m.text)).length === 1,
      { seeded, c2: [c2.resume, c2.prompt.slice(0, 60), c2.inputs.length], afterAccept: seen.afterAccept, afterReset: seen.afterReset, inputsAfterReset: seen.inputsAfterReset, afterInit: seen.afterInit, bEnd, status: rs.status, reset: info2.conversationReset });
    await e.M.run(rs.id, { text: "TASK THREE", roleBrief: "Coder." });
    const c3 = e.sdkCalls[2], b3 = { ...history.bindingFor(rs, "anthropic") }, info3 = e.M.lastRunInfo();
    check("K11e-next", "after the same-id reset the next user turn resumes the SAME id, carries the whole record (both earlier prompts and the cleared context's reply) and the procedures in FULL — skillsMode 'full', no pointer, no 'replace' wording — and its init commits the hash with the cursor at the record's end; the seeded briefs never return", e.sdkCalls.length === 3 && c3.resume === "native-claude" && info3.sent.skillsMode === "full" && /^Conversation record/.test(c3.prompt) && c3.prompt.includes("TASK ONE") && c3.prompt.includes("TASK TWO") && c3.prompt.includes("Continuing in the cleared context") && c3.prompt.includes("TASK THREE\n\n" + SKILLS_HEAD + " (their saved procedures):") && /Survive a same-id \/clear/.test(c3.prompt) && !c3.prompt.includes(POINTER) && !/replace any skills/.test(c3.prompt) && c3.inputs.length === 0 && b3.id === "native-claude" && b3.skillsHash === h1 && !("briefHash" in b3) && !("briefKinds" in b3) && b3.syncedIndex === history.lastGlobalIndex(rs) && rs.status === "done", { c3: [c3.resume, info3.sent.skillsMode, c3.prompt.slice(0, 60), c3.prompt.slice(-160)], b3: { id: b3.id, h: b3.skillsHash && b3.skillsHash.slice(0, 8), briefs: [b3.briefHash, b3.briefKinds], synced: b3.syncedIndex, last: history.lastGlobalIndex(rs) } }); }

  // K11f reset naming NO id (round-4 review, 2026-09-18): the message carries neither new_conversation_id nor session_id (only its uuid).
  // No id patch is written — the binding keeps the id it has (the successor is unknown; the next turn resumes the known id from scratch)
  // — so setBinding drops nothing and the explicit fallback alone clears the three seeded caches; cursor −1, measurement cleared, the
  // attempt and the acceptance dropped; the bound id is the one id this run reset away from, so it IS retired: a later init naming it
  // rebinds and commits nothing (the id stays bound regardless), the result naming it rebinds nothing; the record notes
  // conversationReset === true (no id to name); the run ends with the cursor at −1; the next turn resumes the same id with the whole
  // record and the digests in full, and its init commits
  { const e = environment(); e.setProvider("anthropic");
    const sk = skillsMod.create(HOME, { name: "No-id rules", steps: "Survive an anonymous /clear." });
    const rs = roleChild(e, { selectedSkills: [sk.id] });
    await e.M.run(rs.id, { text: "TASK ONE", roleBrief: "Coder." });
    const h1 = hashOf(rs, "anthropic");
    history.setBinding(rs, "anthropic", { briefHash: "b".repeat(64), briefKinds: "r" });
    const seeded = { ...history.bindingFor(rs, "anthropic") };
    const seen = {};
    e.control.sdk = async function* (call) {
      const r = e.M.runners.get(rs.id);
      const snap = (k) => { seen[k] = { b: { ...history.bindingFor(rs, "anthropic") }, accepted: !!r.accepted, attempt: r.attempt, retired: [...(r.retiredIds || [])], resetSeen: !!r.resetSeen }; };
      yield { type: "system", subtype: "init", session_id: call.resume || "native-claude" };
      snap("afterAccept");
      yield { type: "conversation_reset", uuid: "u1" };   // NO new_conversation_id, NO session_id
      snap("afterReset");
      await sleep(40); seen.inputsAfterReset = call.inputs.length;
      yield { type: "system", subtype: "init", session_id: "native-claude" };   // the retired id: refused (binds and commits nothing) — the binding keeps it anyway
      snap("afterInit");
      yield { type: "assistant", message: { id: "a-anon", content: [{ type: "text", text: "Continuing after the anonymous clear." }] } };
      yield { type: "result", subtype: "success", is_error: false, session_id: "native-claude", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };
    };
    await e.M.run(rs.id, { text: "TASK TWO", roleBrief: "Coder." });
    e.control.sdk = null;
    const c2 = e.sdkCalls[1], bEnd = { ...history.bindingFor(rs, "anthropic") }, info2 = e.M.lastRunInfo();
    const noCaches = (b) => !!b && !("skillsHash" in b) && !("briefHash" in b) && !("briefKinds" in b);
    const allCaches = (b) => !!b && b.skillsHash === h1 && b.briefHash === "b".repeat(64) && b.briefKinds === "r";
    check("K11f", "Claude reset naming NO id: all three seeded caches survived turn 2's pointer init; after the reset the id is unchanged (no id patch) yet NONE of skillsHash / briefHash / briefKinds remains, cursor −1, measurement cleared, attempt and acceptance dropped, resetSeen set, the bound id retired; nothing pushed onto the input; the later init naming the retired id keeps the binding byte-for-byte and commits nothing; the run ends on the same id with the cursor at −1, the note shown once, the reset recorded as `true`", sha64(h1) && seeded.id === "native-claude" && allCaches(seeded)
      && e.sdkCalls.length === 2 && c2.resume === "native-claude" && c2.prompt.startsWith("TASK TWO\n\n" + POINTER) && seen.afterAccept.accepted === true && allCaches(seen.afterAccept.b)
      && seen.afterReset.b.id === "native-claude" && noCaches(seen.afterReset.b) && seen.afterReset.b.syncedIndex === -1 && seen.afterReset.b.activeTokens === 0 && seen.afterReset.b.ctxUsage === null && seen.afterReset.attempt === null && seen.afterReset.accepted === false && seen.afterReset.resetSeen === true && seen.afterReset.retired.join() === "native-claude"
      && seen.inputsAfterReset === 0 && c2.inputs.length === 0
      && JSON.stringify(seen.afterInit.b) === JSON.stringify(seen.afterReset.b) && seen.afterInit.accepted === false && seen.afterInit.attempt === null
      && bEnd.id === "native-claude" && noCaches(bEnd) && bEnd.syncedIndex === -1 && rs.status === "done" && info2.conversationReset === true && rs.messages.filter((m) => m.role === "system" && /fresh conversation context/.test(m.text)).length === 1,
      { seeded, c2: [c2.resume, c2.prompt.slice(0, 60), c2.inputs.length], afterAccept: seen.afterAccept, afterReset: seen.afterReset, inputsAfterReset: seen.inputsAfterReset, afterInit: seen.afterInit, bEnd, status: rs.status, reset: info2.conversationReset });
    await e.M.run(rs.id, { text: "TASK THREE", roleBrief: "Coder." });
    const c3 = e.sdkCalls[2], b3 = { ...history.bindingFor(rs, "anthropic") }, info3 = e.M.lastRunInfo();
    check("K11f-next", "after the anonymous reset the next user turn resumes the same id, carries the whole record (both earlier prompts and the reply) and the procedures in FULL — skillsMode 'full', no pointer, no 'replace' wording — and its init commits the hash with the cursor at the record's end; the seeded briefs never return", e.sdkCalls.length === 3 && c3.resume === "native-claude" && info3.sent.skillsMode === "full" && /^Conversation record/.test(c3.prompt) && c3.prompt.includes("TASK ONE") && c3.prompt.includes("TASK TWO") && c3.prompt.includes("Continuing after the anonymous clear") && c3.prompt.includes("TASK THREE\n\n" + SKILLS_HEAD + " (their saved procedures):") && /Survive an anonymous \/clear/.test(c3.prompt) && !c3.prompt.includes(POINTER) && !/replace any skills/.test(c3.prompt) && c3.inputs.length === 0 && b3.id === "native-claude" && b3.skillsHash === h1 && !("briefHash" in b3) && !("briefKinds" in b3) && b3.syncedIndex === history.lastGlobalIndex(rs) && rs.status === "done", { c3: [c3.resume, info3.sent.skillsMode, c3.prompt.slice(0, 60), c3.prompt.slice(-160)], b3: { id: b3.id, h: b3.skillsHash && b3.skillsHash.slice(0, 8), briefs: [b3.briefHash, b3.briefKinds], synced: b3.syncedIndex, last: history.lastGlobalIndex(rs) } }); }

  // K12b Codex briefs (2026-09-18): a REMOVED brief is named — never silently dropped while a changed hash is committed; the pointer
  // names only the briefs currently active; a set gone empty sends one clearing line and commits ""; a brief after that is full without 'replaces'
  { const e = environment(); e.setProvider("openai");
    const brief = "You are the Coder (Codex).";
    const cb = roleChild(e, { model: "gpt-5.5" });   // no skills: the briefs alone are under test
    await e.M.run(cb.id, { text: "T1", roleBrief: brief, subAgents: true, subAgentsMax: 3 });
    const b1 = { ...history.bindingFor(cb, "openai") }, i1 = e.M.lastRunInfo().sent;
    await e.M.run(cb.id, { text: "T2", roleBrief: brief });   // the Agents switch OFF: the set changed — the agents brief is gone
    const b2 = { ...history.bindingFor(cb, "openai") }, i2 = e.M.lastRunInfo().sent;
    await e.M.run(cb.id, { text: "T3", roleBrief: brief });   // unchanged
    const b3 = { ...history.bindingFor(cb, "openai") }, i3 = e.M.lastRunInfo().sent;
    await e.M.run(cb.id, { text: "T4" });   // no role brief, agents off: something before, nothing now
    const b4 = { ...history.bindingFor(cb, "openai") }, i4 = e.M.lastRunInfo().sent;
    await e.M.run(cb.id, { text: "T5" });   // nothing before, nothing now
    const b5 = { ...history.bindingFor(cb, "openai") }, i5 = e.M.lastRunInfo().sent;
    await e.M.run(cb.id, { text: "T6", roleBrief: brief });   // a brief again: the thread holds none → full, no 'replaces'
    const b6 = { ...history.bindingFor(cb, "openai") }, i6 = e.M.lastRunInfo().sent;
    const [p1, p2, p3, p4, p5, p6] = e.appCalls.map((c) => c.prompt);
    const sha = (v) => require("crypto").createHash("sha256").update(JSON.stringify(v)).digest("hex");
    check("K12b", "Codex briefs: T1 both briefs in full (hash of the pair); T2 agents off → the role brief labelled as REPLACING plus the explicit 'no sub-agents brief any more' line, briefHash changed; T3 → the pointer names ONLY the role brief; T4 no briefs → the clearing line ONCE and briefHash ''; T5 → no brief text at all; T6 a brief again → full without 'replaces' wording, its hash committed", p1 === "T1\n\n" + ROLE_HEAD + brief + "\n\n" + AGENTS_HEAD + ":\n" + e.M.agentsBrief(3) && b1.briefHash === sha([brief, e.M.agentsBrief(3)]) && i1.briefMode === "full"
      && p2 === "T2\n\n" + ROLE_HEAD_REPLACING + brief + "\n\n" + AGENTS_GONE && !p2.includes(AGENTS_HEAD) && b2.briefHash === sha([brief, ""]) && b2.briefHash !== b1.briefHash && i2.briefMode === "full"
      && p3 === "T3\n\n" + BRIEFS_PTR + " — the role brief given earlier in this conversation still applies." && !/sub-agents/i.test(p3) && b3.briefHash === b2.briefHash && i3.briefMode === "pointer"
      && p4 === "T4\n\n" + BRIEFS_CLEARED && count(p4, "Briefs:") === 1 && b4.briefHash === "" && i4.briefMode === "clear"
      && p5 === "T5" && b5.briefHash === "" && i5.briefMode === "none"
      && p6 === "T6\n\n" + ROLE_HEAD + brief && !/replaces/.test(p6) && !p6.includes(AGENTS_GONE) && b6.briefHash === b2.briefHash && i6.briefMode === "full" && cb.status === "done" && e.injections.length === 0
      && [b1, b2, b3, b4, b5, b6].map((b) => b.briefKinds).join("|") === "ra|r|r|||r",
      { p2, p3, p4, p5, p6, hashes: [b1, b2, b3, b4, b5, b6].map((b) => (b.briefHash || "").slice(0, 8)), kinds: [b1, b2, b3, b4, b5, b6].map((b) => b.briefKinds), modes: [i1, i2, i3, i4, i5, i6].map((i) => i.briefMode) });
    // K12d the composition decides which absent kind is named: a role-only thread whose role brief changes says nothing about an agents
    // brief it never had (a persistent role job's lane sentence lives INSIDE its role brief); a legacy binding (hash, no composition) names it
    const ro = roleChild(e, { model: "gpt-5.5", role: "reviewer" });
    await e.M.run(ro.id, { text: "R1", roleBrief: "Reviewer with a lane of 5 sub-agents." });
    await e.M.run(ro.id, { text: "R2", roleBrief: "Reviewer alone." });
    const r2 = e.appCalls[e.appCalls.length - 1].prompt, rb2 = { ...history.bindingFor(ro, "openai") };
    delete history.bindingFor(ro, "openai").briefKinds;   // a binding saved by the build before the composition was recorded
    await e.M.run(ro.id, { text: "R3", roleBrief: "Reviewer, third brief." });
    const r3 = e.appCalls[e.appCalls.length - 1].prompt, rb3 = history.bindingFor(ro, "openai");
    check("K12d", "a changed role brief on a thread that only ever had a role brief → labelled as replacing, NO 'no sub-agents brief' line (the kind was never there); the same change on a legacy binding without the composition names the absent kind (safe side); the composition is recommitted", r2 === "R2\n\n" + ROLE_HEAD_REPLACING + "Reviewer alone." && !/sub-agent/.test(r2) && rb2.briefKinds === "r" && r3 === "R3\n\n" + ROLE_HEAD_REPLACING + "Reviewer, third brief.\n\n" + AGENTS_GONE && rb3.briefKinds === "r" && sha64(rb3.briefHash) && rb3.briefHash !== rb2.briefHash, { r2, r3, rb2: rb2.briefKinds, rb3: rb3.briefKinds });
    check("K12c", "briefHashOf is '' when neither brief is present; briefDelivery mirrors skillDelivery: none / full / pointer / full (changed) / clear", e.M.briefHashOf("", "") === "" && sha64(e.M.briefHashOf("r", "")) && e.M.briefDelivery("", "") === "none" && e.M.briefDelivery("h", "") === "full" && e.M.briefDelivery("h", "h") === "pointer" && e.M.briefDelivery("h2", "h") === "full" && e.M.briefDelivery("", "h") === "clear" && e.M.briefNoteFor("pointer", "r", "a") === "Briefs: unchanged — the role brief and the sub-agents brief given earlier in this conversation still apply." && e.M.briefNoteFor("pointer", "", "a") === "Briefs: unchanged — the sub-agents brief given earlier in this conversation still applies." && e.M.briefNoteFor("clear", "", "") === BRIEFS_CLEARED && e.M.briefNoteFor("full", "r", "") === "" && e.M.briefNoteFor("none", "", "") === "", { agentsOnly: e.M.briefNoteFor("pointer", "", "a") }); }

  // K13b frozen digests (2026-09-18): the procedure TEXT is frozen with the turn's snapshot — a replacement attempt (lost session) sends
  // exactly what the committed hash describes although the store changed under the turn; the NEXT turn's snapshot notices the change
  { const e = environment(); e.setProvider("anthropic");
    const skA = skillsMod.create(HOME, { name: "Frozen A", steps: "ORIGINAL STEPS A" });
    const skB = skillsMod.create(HOME, { name: "Frozen B", steps: "ORIGINAL STEPS B" });
    const fz = roleChild(e, { selectedSkills: [skA.id, skB.id], messages: [e.msg("user", "OLD"), e.msg("assistant", "A")] });
    await e.M.run(fz.id, { text: "WARM UP", roleBrief: "Coder." });
    const h1 = hashOf(fz, "anthropic"), uses1 = skillsMod.get(HOME, skA.id).uses;
    const expected = e.M.skillSnapshot(fz).hash;   // the hash the next turn freezes at its start (nothing has changed yet); taking a snapshot bumps nothing
    const usesAfterSnap = skillsMod.get(HOME, skA.id).uses;
    let attempt = 0;
    e.control.sdk = async function* () {
      attempt++;
      if (attempt === 1) {
        // the resumed attempt dies (lost session) — and BEFORE the replacement is composed the store changes under the turn: A edited, B removed
        await sleep(5); skillsMod.update(HOME, skA.id, { steps: "EDITED STEPS A" }); skillsMod.remove(HOME, skB.id);
        throw new Error("no conversation found");
      }
      yield { type: "system", subtype: "init", session_id: "new-native" }; yield { type: "result", subtype: "success", is_error: false, session_id: "new-native", usage: {} };
    };
    await e.M.run(fz.id, { text: "AFTER LOSS", roleBrief: "Coder." });
    e.control.sdk = null;
    const la = e.sdkCalls[1], lb = e.sdkCalls[2], bl = { ...history.bindingFor(fz, "anthropic") }, uses2 = skillsMod.get(HOME, skA.id).uses;
    await e.M.run(fz.id, { text: "NEXT", roleBrief: "Coder." });
    const n = e.sdkCalls[3], bn = history.bindingFor(fz, "anthropic");
    check("K13b", "frozen digests: the resumed attempt carried a pointer; the replacement (fresh) attempt carries the ORIGINAL frozen text of BOTH skills (not the edit, the removed one included) and its init commits the hash of the turn-start snapshot; the next turn sees the edit and the removal (full resend, edited text, one skill, new hash); usage bumped once per full delivery only (a snapshot bumps nothing)", expected === h1 && usesAfterSnap === uses1 && attempt === 2 && la.resume === "native-claude" && la.prompt.includes(POINTER) && !la.prompt.includes(SKILLS_HEAD) && lb.resume === null && lb.prompt.includes(SKILLS_HEAD + " (their saved procedures):") && lb.prompt.includes("ORIGINAL STEPS A") && lb.prompt.includes("ORIGINAL STEPS B") && !lb.prompt.includes("EDITED STEPS A") && count(lb.prompt, 'Skill "') === 2 && bl.id === "new-native" && bl.skillsHash === expected && fz.status === "done" && n.resume === "new-native" && n.prompt.startsWith("NEXT\n\n" + SKILLS_HEAD + " (their saved procedures; they replace any skills given earlier in this conversation):") && n.prompt.includes("EDITED STEPS A") && !n.prompt.includes("ORIGINAL STEPS") && count(n.prompt, 'Skill "') === 1 && sha64(bn.skillsHash) && bn.skillsHash !== expected && uses1 === 1 && uses2 === 2 && skillsMod.get(HOME, skA.id).uses === 3 && skillsMod.get(HOME, skB.id) === null, { attempt, la: la.prompt.slice(-90), lb: lb.prompt.slice(-200), bl: { id: bl.id, same: bl.skillsHash === expected }, n: n.prompt.slice(0, 200), uses: [uses1, usesAfterSnap, uses2, skillsMod.get(HOME, skA.id).uses] }); }

  console.log(`\nContext continuity: ${pass} passed, ${failN} failed`);
  if (failN) { console.log(failures.map((f) => " - " + f).join("\n")); process.exitCode = 1; }
  clearTimeout(watchdog);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
