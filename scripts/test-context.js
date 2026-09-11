"use strict";
/* Context-continuity regression suite — DESIRED behaviour for the findings of
 * ATOMNANO_CONTEXT_CONTINUITY_AUDIT_2026-09-10 (CTX-001..CTX-019), converted from the audit's
 * characterization checks (their C-ids are kept). Built the way the audit's harness was: the
 * ORIGINAL claude.js is loaded in a VM with the SDK loader, Codex app-server, Codex exec and
 * the summariser injected (recording / fault-injecting fakes); store.js and history.js are the
 * REAL modules on an isolated data home. No credentials, no network, no model requests, no
 * saved conversations.  Run: node scripts/test-context.js */
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

const store = require(path.join(ROOT, "src/main/store.js"));
const history = require(path.join(ROOT, "src/main/history.js"));
store.loadSettings();
const src = { claude: fs.readFileSync(path.join(ROOT, "src/main/claude.js"), "utf8"), main: fs.readFileSync(path.join(ROOT, "src/main/main.js"), "utf8") };

/* One isolated SessionManager with recording fakes. */
function environment() {
  const sdkCalls = [], appCalls = [], injections = [], summaryCalls = [], sends = [];
  const control = { sdk: null, app: null, exec: null };
  const providers = {
    get: (p) => ({ label: p, models: p === "openai" ? [{ id: "gpt-5.5", ctx: 272000 }] : [{ id: "claude-opus-4-8", ctx: 200000, ctx1m: true }], defaultModel: p === "openai" ? "gpt-5.5" : "claude-opus-4-8", defaultReasoning: "low", primary: "sdk" }),
    context1M: () => true, resolveOpenAIModelStrict: (id) => ({ model: id || "gpt-5.5" }), resolveOpenAIModel: (id) => ({ model: id || "gpt-5.5" }), openaiEffortStrict: (e) => ({ effort: e || "low" }), openaiEffort: () => "low",
  };
  const sdk = { query(opts) { return (async function* () {
    let prompt = opts.prompt;
    // Like the real SDK: the prompt stream is read CONCURRENTLY with the output — the app holds it
    // open until this turn's result (see buildPrompt), so it must never be drained up front.
    if (typeof prompt !== "string") { const it = prompt[Symbol.asyncIterator](); const first = await it.next(); prompt = first.value.message.content; (async () => { for await (const _ of it) { /* stays open until the run releases it */ } })().catch(() => {}); }
    const call = { prompt, resume: opts.options.resume || null, options: opts.options }; sdkCalls.push(call);
    if (control.sdk) { yield* control.sdk(call); return; }
    yield { type: "system", subtype: "init", session_id: opts.options.resume || "native-claude" };
    yield { type: "assistant", message: { id: "a-" + sdkCalls.length, content: [{ type: "text", text: "Synthetic reply." }] } };
    yield { type: "result", subtype: "success", is_error: false, session_id: opts.options.resume || "native-claude", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };
  })(); } };
  let turnSeq = 0;
  const appserver = {
    ctxKeyOf: () => "login",
    async run(opts) {
      const id = opts.resumeId || "native-openai-" + (appCalls.length + 1), isNew = !opts.resumeId;
      const call = { prompt: opts.promptText, resume: opts.resumeId || null, id }; appCalls.push(call);
      opts.on.onThreadId(id, isNew, "login");
      try { await opts.beforeTurn(id, isNew); } catch (e) { return { ok: false, error: "conversation transfer failed: " + e.message, threadId: id }; }
      opts.on.onTurnId("turn-" + (++turnSeq));
      if (control.app) return control.app(opts, call);
      return { ok: true, text: "Synthetic reply.", threadId: id };
    },
    async injectItems(id, items) { injections.push({ id, items: JSON.parse(JSON.stringify(items)) }); return { ok: true }; },
    interrupt: async () => true, steer: async () => ({ ok: true }),
  };
  const codex = { run: async (opts) => (control.exec ? control.exec(opts) : { ok: true, text: "Synthetic summary.", usage: { input_tokens: 100, output_tokens: 20 } }) };
  const req = (name) => {
    const map = { path, fs, os, crypto: require("crypto"), child_process: require("child_process"), "./store": store, "./history": history, "./auth": {}, "./attachments": { persistAll: (a) => a, light: (a) => a, readBase64: () => "" }, "./tool-args": require(path.join(ROOT, "src/main/tool-args.js")), "./providers": providers, "./codex-appserver": appserver, "./codex": codex, "./codex-cards": { unwrapCmd: (x) => x, parseDiff: () => ({ oldText: "", newText: "", added: 0, removed: 0 }), classifyCmd: () => null }, "./council": { reviewerRun: async () => ({ ok: true, text: "advice" }), label: () => "Reviewer" }, "./customApi": { getEndpoint: () => null, call: async () => ({ ok: true, text: "custom" }) } };
    if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
    throw new Error("Unexpected manager dependency " + name);
  };
  const mod = { exports: {} };
  const scope = { module: mod, exports: mod.exports, require: req, __filename: path.join(ROOT, "src/main/claude.js"), __dirname: path.join(ROOT, "src/main"), process, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, URL, TextEncoder, TextDecoder, console: { log() {}, warn() {}, error() {} }, __auditSdk: sdk };
  vm.runInNewContext(src.claude + "\nsdkPromise = Promise.resolve(__auditSdk);", scope, { filename: "claude.js" });
  const M = mod.exports;
  M.send = (name, data) => sends.push({ name, data });
  M.buildEnv = () => ({}); M.resolveCli = async () => ""; M.composeMcp = () => ({}); M.registerModel = () => {}; M.scheduleRetry = () => {};
  M.setSummarizer(async (provider, model, prompt) => { summaryCalls.push({ provider, model, prompt }); return "Summary of synthetic completed work."; });
  const make = (opts = {}) => { const v = store.createSession({ cwd: HOME, name: "ctx", model: opts.model || "claude-opus-4-8", thinking: "low", permissionMode: opts.permissionMode, oneM: opts.oneM, selectedSkills: opts.selectedSkills }); const s = store.getSession(v.id); if (opts.messages) { s.messages.push(...opts.messages); store.enforceCap(s); } store.flush(v.id); return s; };
  let seq = 0;
  const msg = (role, text, more = {}) => ({ id: "m-" + (++seq), role, text, ts: store.nowISO(), ...more });
  const setProvider = (p) => store.saveSettings({ llmProvider: p });
  // the synthesize IPC handler, extracted UNCHANGED from main.js
  const handlers = {};
  const handlerSrc = src.main.slice(src.main.indexOf('  handle("sessions:synthesize"'), src.main.indexOf('  handle("sessions:get"'));
  vm.runInNewContext(handlerSrc, { handle: (n, fn) => { handlers[n] = fn; }, store, claude: M, require: (n) => { if (n === "./history") return history; throw new Error(n); } });
  return { M, make, msg, sdkCalls, appCalls, injections, summaryCalls, sends, control, setProvider, synthesize: (id) => handlers["sessions:synthesize"](null, id) };
}
const count = (s, needle) => String(s || "").split(needle).length - 1;

async function main() {
  // ---- controls: ordinary continuation stays delta-only ----
  { const e = environment(); e.setProvider("anthropic"); const s = e.make();
    await e.M.run(s.id, { text: "FIRST" }); await e.M.run(s.id, { text: "MIDDLE FOLLOWUP" });
    check("C01", "Claude normal continuation submits only the new prompt with native resume", e.sdkCalls.length === 2 && e.sdkCalls[1].prompt === "MIDDLE FOLLOWUP" && e.sdkCalls[1].resume === "native-claude", e.sdkCalls.map((c) => [c.prompt.slice(0, 40), c.resume])); }
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5" });
    await e.M.run(s.id, { text: "FIRST" }); await e.M.run(s.id, { text: "MIDDLE FOLLOWUP" });
    check("C02", "Codex normal continuation uses native resume without history reinjection", e.appCalls.length === 2 && !!e.appCalls[1].resume && e.injections.length === 0, { calls: e.appCalls.length, injections: e.injections.length }); }

  // ---- CTX-001 / CTX-014: synthesize is a bounded continuation that keeps the settings ----
  { const e = environment(); e.setProvider("anthropic");
    const big = (n, ch) => ch.repeat(n);
    const s = e.make({ permissionMode: "plan", selectedSkills: ["test-skill"], messages: [{ id: "u1", role: "user", text: "GOAL: fix the login bug " + big(600000, "A"), ts: store.nowISO() }, { id: "a1", role: "assistant", text: "DONE: patched auth.js " + big(600000, "B"), ts: store.nowISO() }] });
    const next = await e.synthesize(s.id);
    const seed = next.messages[0];
    check("C05", "synthesize seeds a BOUNDED record entry (summary of the oldest, newest verbatim excerpt), never the 1.2 MB transcript", next.messages.length === 1 && seed.role === "record" && seed.carriedRecord === true && seed.text.length < 400000 && e.summaryCalls.length >= 1 && /Continued from/.test(seed.text) && /DONE: patched auth\.js/.test(seed.text), { chars: seed.text.length, summaryCalls: e.summaryCalls.length, mode: seed.meta && seed.meta.mode });
    check("C05b", "every summariser request for the giant entry fits its own budget (segmented)", e.summaryCalls.every((c) => c.prompt.length <= 200000 + 2000), { max: Math.max(...e.summaryCalls.map((c) => c.prompt.length)) });
    check("C06", "synthesize carries permission mode and selected skills", next.permissionMode === "plan" && Array.isArray(next.selectedSkills) && next.selectedSkills[0] === "test-skill", { permissionMode: next.permissionMode, selectedSkills: next.selectedSkills });
    const small = e.make({ oneM: true, messages: [e.msg("user", "hello"), e.msg("assistant", "hi")] });
    const n2 = await e.synthesize(small.id);
    check("C06b", "synthesize carries the 1M-context selection; a small record stays exact", n2.oneM === true && n2.messages[0].meta.mode === "exact" && /verbatim/.test(n2.messages[0].text), { oneM: n2.oneM, mode: n2.messages[0].meta.mode });
    // synthesize AGAIN from the continuation: bounded again, no nested blow-up
    const nn = await e.synthesize(next.id);
    check("C05c", "synthesizing the continuation again stays bounded (no nested full transcript)", nn.messages.length === 1 && nn.messages[0].text.length < 400000, { chars: nn.messages[0].text.length });
    // the seed is what the first turn transfers — as ONE record entry, and the record card is app-visible history
    const nextFull = store.getSession(next.id);
    check("C05d", "the record entry is model-visible history for the first turn", history.isHistoryMessage(nextFull.messages[0]) && history.planTransfer(nextFull, -1, 0, { budgetChars: Infinity }).count === 1); }

  // ---- CTX-002 / CTX-003: chunking within an oversized entry; enforced size contract ----
  { const e = environment(); const s = e.make({ messages: [e.msg("user", "GOAL " + "X".repeat(1100000) + " END-OF-GOAL")] });
    const tb = await e.M.transferBlock(s, "anthropic", { model: s.model, from: -1, to: 0, promptChars: 20 });
    check("C07c", "a record that is ONE oversized entry is bounded by an excerpt (start and end kept) without a summary call", tb.mode === "shortened" && tb.text.length <= tb.budget && /GOAL X/.test(tb.text) && /END-OF-GOAL/.test(tb.text) && e.summaryCalls.length === 0, { chars: tb.text.length, budget: tb.budget, calls: e.summaryCalls.length }); }
  { const e = environment(); const s = e.make({ messages: [e.msg("user", "X".repeat(1200000)), e.msg("assistant", "Y".repeat(200))] });
    const tb = await e.M.transferBlock(s, "anthropic", { model: s.model, from: -1, to: 1, promptChars: 20 });
    check("C07", "one oversized entry is summarised in segments — no summariser request exceeds half the budget", tb.mode === "summary" && e.summaryCalls.length >= 6 && e.summaryCalls.every((c) => c.prompt.length <= tb.budget * 0.5 + 2000) && e.summaryCalls[1].prompt.includes("part 2 of"), { budget: tb.budget, calls: e.summaryCalls.length, max: Math.max(...e.summaryCalls.map((c) => c.prompt.length)) });
    check("C07b", "the final block fits the budget", tb.text.length <= tb.budget, { chars: tb.text.length, budget: tb.budget }); }
  { const e = environment(); const s = e.make({ messages: Array.from({ length: 20 }, (_, i) => e.msg(i % 2 ? "assistant" : "user", "ENTRY-" + i + " " + "x".repeat(8000))) });
    let compactions = 0;
    e.M.setSummarizer(async (p, m, prompt) => { if (/too long for the space available/.test(prompt)) { compactions++; return "COMPACT SUMMARY " + "z".repeat(3000); } return "x".repeat(90000); });
    const tb = await e.M.transferBlock(s, "anthropic", { model: s.model, from: -1, to: 19, budgetScale: 0.1, forceSummary: true });
    check("C08", "an oversized summariser response is compacted and the assembled block fits its budget", compactions >= 1 && tb.text.length <= tb.budget && /COMPACT SUMMARY/.test(tb.text), { budget: tb.budget, finalChars: tb.text.length, compactions }); }

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
    check("C26", "the context meter answers for a live Codex turn from its own usage", cu && cu.totalTokens === 1500 && cu.maxTokens === 272000 && cu.estimate === true, cu);
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
    check("C33", "a summariser failure during preparation ends the run cleanly (no stuck running slot)", !thrown && !e.M.isRunning(s.id) && s.status === "error" && s.messages.some((m) => m.role === "error"), { thrown, running: e.M.isRunning(s.id), status: s.status }); }
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
    check("C38", "an advancing span folds only newer entries into the cached summary", added.length > 0 && added.every((x) => !x.prompt.includes("RAW-ENTRY-0 ")) && /Summary so far/.test(added[0].prompt), { added: added.length }); }
  { const e = environment(); const s = e.make({ messages: [e.msg("user", "OLDER"), e.msg("assistant", "ANSWER"), e.msg("user", "CURRENT")] });
    const p = history.planTransfer(s, 0, 1, { budgetChars: 10000 });
    check("C03", "a provider sync span includes only its missing earlier entries", p.count === 1 && p.text.includes("ANSWER") && !p.text.includes("OLDER") && !p.text.includes("CURRENT"));
    history.setBinding(s, "anthropic", { id: "native", syncedIndex: 1 });
    check("C04", "UI pagination never decides the next prompt's history", !history.pendingSync(s, "anthropic", 2).needed); }
  // CTX-019: separate summary calls are accounted
  { const e = environment(); const s = e.make({ messages: Array.from({ length: 40 }, (_, i) => e.msg("user", "E" + i + " " + "q".repeat(12000))) });
    const tb = await e.M.transferBlock(s, "anthropic", { model: s.model, from: -1, to: 39, budgetScale: 0.1, forceSummary: true });
    const card = s.messages.find((m) => m.role === "summary");
    check("C19b", "summary preparation is reported (calls counted on the card and in the note)", tb.job && tb.job.calls >= 1 && card && card.meta.job.calls === tb.job.calls && /model call/.test(tb.note), { job: tb.job }); }

  console.log(`\nContext continuity: ${pass} passed, ${failN} failed`);
  if (failN) { console.log(failures.map((f) => " - " + f).join("\n")); process.exitCode = 1; }
  clearTimeout(watchdog);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
