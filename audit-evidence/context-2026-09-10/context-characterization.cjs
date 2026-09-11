"use strict";
/* Context audit characterization, 2026-09-10.
 * Runs original history/SessionManager/store functions with synthetic in-memory
 * sessions and explicit mocked providers. No credentials, network, subprocesses,
 * saved chats, or application code are touched. Passing reproductions identify
 * current defects; controls identify behavior that should be preserved.
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), crypto = require("crypto");
const ROOT = path.resolve(__dirname, "../..");
const results = [], reads = [];
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const source = Object.fromEntries(["src/main/history.js", "src/main/claude.js", "src/main/store.js", "src/main/main.js", "src/main/codex.js", "src/main/codex-appserver.js", "src/renderer/app.js"].map(f => [f, read(f)]));
function check(id, kind, name, ok, evidence = {}) { results.push({ id, kind, name, pass: !!ok, evidence }); }
function loadCjs(f, req, extra = {}, appended = "") {
  const mod = { exports: {} };
  const scope = { module: mod, exports: mod.exports, require: req, __filename: path.join(ROOT, f), __dirname: path.dirname(path.join(ROOT, f)), process: { cwd: () => ROOT, env: {}, platform: "win32" }, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Date, console: { log() {}, warn() {}, error() {} }, ...extra };
  vm.runInNewContext(source[f] + "\n" + appended, scope, { filename: f });
  return mod.exports;
}
function environment() {
  let seq = 0;
  const sessions = new Map(), sends = [], sdkCalls = [], appCalls = [], injections = [], summaryCalls = [];
  const settings = { llmProvider: "anthropic", defaultModel: "audit-claude", defaultThinking: "low", discoveredModels: [] };
  const store = {
    uid: () => "audit-" + (++seq), nowISO: () => "2026-09-10T00:00:00.000Z",
    getSession: id => sessions.get(id), getSettings: () => settings, saveSettings: p => Object.assign(settings, p),
    scheduleWrite() {}, flush: () => true, enforceCap() {},
    updateSession(id, p) { const s = sessions.get(id); if (s) Object.assign(s, p); return s; },
    getMessagesRange(id, end, count) { const s = sessions.get(id), all = [...(s.archive || []), ...s.messages]; const start = Math.max(0, end - count); reads.push({ id, start, end, count }); return { messages: all.slice(start, end), firstIndex: start, total: all.length }; },
    exportSession(id) { const s = sessions.get(id); return s && { ...s, messages: [...(s.archive || []), ...s.messages], archivedCount: 0 }; },
    createSession(opts) { return make(opts); }, getSessionView(id) { return sessions.get(id); }
  };
  const H = loadCjs("src/main/history.js", name => { if (name === "./store") return store; throw Error("Unexpected history dependency " + name); });
  const providers = { get: p => ({ models: [{ id: "audit-claude", ctx: 200000 }, { id: "gpt-audit", ctx: 272000 }], defaultModel: p === "openai" ? "gpt-audit" : "audit-claude" }), context1M: () => true, resolveOpenAIModelStrict: id => ({ model: id || "gpt-audit" }), openaiEffortStrict: e => ({ effort: e || "low" }), openaiEffort: () => "low" };
  const control = { sdk: null, app: null, exec: null };
  const sdk = { query(opts) { return (async function* () {
    let prompt = opts.prompt;
    if (typeof prompt !== "string") { const got = []; for await (const m of prompt) got.push(m.message.content); prompt = got.length === 1 ? got[0] : got; }
    const call = { prompt, resume: opts.options.resume || null, options: opts.options }; sdkCalls.push(call);
    if (control.sdk) { yield* control.sdk(call); return; }
    yield { type: "system", subtype: "init", session_id: opts.options.resume || "native-claude" };
    yield { type: "assistant", message: { id: "a-" + sdkCalls.length, content: [{ type: "text", text: "Synthetic reply." }] } };
    yield { type: "result", subtype: "success", is_error: false, session_id: opts.options.resume || "native-claude", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };
  })(); } };
  const appserver = {
    ctxKeyOf: () => "login",
    async run(opts) {
      const id = opts.resumeId || "native-openai-" + (appCalls.length + 1), isNew = !opts.resumeId;
      const call = { prompt: opts.promptText, resume: opts.resumeId || null, id }; appCalls.push(call);
      opts.on.onThreadId(id, isNew, "login");
      await opts.beforeTurn(id, isNew);
      if (control.app) return control.app(opts, call);
      return { ok: true, text: "Synthetic reply.", threadId: id };
    },
    async injectItems(id, items) { injections.push({ id, items: JSON.parse(JSON.stringify(items)) }); return { ok: true }; },
    interrupt: async () => true, steer: async () => ({ ok: true })
  };
  const codex = { run: async opts => control.exec ? control.exec(opts) : ({ ok: true, text: "Synthetic summary." }) };
  const attachments = { persistAll: a => a, light: a => a, readBase64: () => "Zml4dHVyZQ==" };
  const req = name => {
    const map = { path, "./store": store, "./history": H, "./auth": {}, "./attachments": attachments, "./tool-args": { partialToolInput: () => ({}) }, "./providers": providers, "./codex-appserver": appserver, "./codex": codex, "./codex-cards": { unwrapCmd: x => x, parseDiff: () => ({}), classifyCmd: () => null } };
    if (Object.hasOwn(map, name)) return map[name];
    throw Error("Unexpected manager dependency " + name);
  };
  const M = loadCjs("src/main/claude.js", req, { __auditSdk: sdk }, "sdkPromise = Promise.resolve(__auditSdk);");
  M.send = (name, data) => sends.push({ name, data });
  M.buildEnv = () => ({});
  M.resolveCli = async () => "";
  M.composeMcp = () => ({});
  M.registerModel = () => {};
  M.scheduleRetry = () => {};
  M.setSummarizer(async (provider, model, prompt) => { summaryCalls.push({ provider, model, prompt }); return "Summary of synthetic completed work."; });
  function make(opts = {}) {
    const s = { id: "s-" + (++seq), name: "Synthetic", cwd: ROOT, model: "audit-claude", thinking: "low", permissionMode: "default", messages: [], archivedCount: 0, archive: [], editedFiles: [], bindings: {}, summaries: [], ...opts };
    sessions.set(s.id, s); return s;
  }
  const msg = (role, text, more = {}) => ({ id: "m-" + (++seq), role, text, ...more });
  return { M, H, store, settings, make, msg, sdkCalls, appCalls, injections, summaryCalls, control, sends };
}
async function main() {
  {
    const e = environment(), s = e.make();
    await e.M.run(s.id, { text: "FIRST", thinking: "low" });
    await e.M.run(s.id, { text: "MIDDLE FOLLOWUP", thinking: "low" });
    check("C01", "control", "Claude normal continuation submits only the new prompt with native resume", e.sdkCalls.length === 2 && e.sdkCalls[1].prompt === "MIDDLE FOLLOWUP" && e.sdkCalls[1].resume === "native-claude", { newPrompt: e.sdkCalls[1].prompt, resume: e.sdkCalls[1].resume });
  }
  {
    const e = environment(), s = e.make({ model: "gpt-audit" }); e.settings.llmProvider = "openai";
    await e.M.run(s.id, { text: "FIRST" }); await e.M.run(s.id, { text: "MIDDLE FOLLOWUP" });
    check("C02", "control", "Codex normal continuation uses native resume without history reinjection", e.appCalls.length === 2 && !!e.appCalls[1].resume && e.injections.length === 0, { calls: e.appCalls, injections: e.injections.length });
  }
  {
    const e = environment(), s = e.make({ messages: [e.msg("user", "OLDER"), e.msg("assistant", "ANSWER"), e.msg("user", "CURRENT")] });
    const p = e.H.planTransfer(s, 0, 1, { budgetChars: 10000 });
    check("C03", "control", "A provider sync span includes only its missing earlier entries", p.count === 1 && p.text.includes("ANSWER") && !p.text.includes("OLDER") && !p.text.includes("CURRENT"));
    e.H.setBinding(s, "anthropic", { id: "native", syncedIndex: 1 });
    check("C04", "control", "Canonical UI pagination does not determine the next prompt history", !e.H.pendingSync(s, "anthropic", 2).needed);
  }
  {
    const e = environment(), s = e.make({ messages: [e.msg("user", "A".repeat(600000)), e.msg("assistant", "B".repeat(600000))], oneM: true, permissionMode: "plan", selectedSkills: ["test-skill"], summaries: [{ from: -1, upTo: 1, text: "Existing source checkpoint" }] });
    const handlers = {};
    const handler = source["src/main/main.js"].slice(source["src/main/main.js"].indexOf('  handle("sessions:synthesize"'), source["src/main/main.js"].indexOf('  handle("sessions:get"'));
    vm.runInNewContext(handler, { handle: (name, fn) => handlers[name] = fn, store: e.store, require: name => { if (name === "./history") return e.H; throw Error(name); } });
    const next = await handlers["sessions:synthesize"](null, s.id);
    check("C05", "reproduction", "Synthesize copies the entire record as one user message", next.messages.length === 1 && next.messages[0].text.length > 1200000 && next.messages[0].carriedRecord === true, { sourceChars: 1200000, carriedChars: next.messages[0].text.length, summaryCalls: e.summaryCalls.length });
    check("C06", "reproduction", "Synthesize drops 1M, permission mode, selected skills and summary provenance", !next.oneM && next.permissionMode !== "plan" && !next.selectedSkills && next.summaries.length === 0, { oneM: next.oneM || false, permissionMode: next.permissionMode, selectedSkills: next.selectedSkills || [], summaryCount: next.summaries.length });
    const tb = await e.M.transferBlock(next, "anthropic", { model: next.model, from: -1, to: 0, promptChars: 20 });
    check("C07", "reproduction", "One oversized synthesized entry bypasses the summarizer chunk budget", tb.mode === "summary" && e.summaryCalls.length === 1 && e.summaryCalls[0].prompt.length > tb.budget, { transferBudgetChars: tb.budget, summaryRequestChars: e.summaryCalls[0].prompt.length, summaryCalls: e.summaryCalls.length, tailEntries: tb.count - tb.plan.headCount });
  }
  {
    const e = environment(), s = e.make({ messages: Array.from({ length: 20 }, (_, i) => e.msg(i % 2 ? "assistant" : "user", "ENTRY-" + i + " " + "x".repeat(8000))) });
    e.M.setSummarizer(async () => "x".repeat(90000));
    const tb = await e.M.transferBlock(s, "anthropic", { model: s.model, from: -1, to: 19, budgetScale: 0.1, forceSummary: true });
    check("C08", "reproduction", "Final summary transfer is not checked against its budget", tb.text.length > tb.budget, { budget: tb.budget, finalChars: tb.text.length });
  }
  {
    const e = environment(), s = e.make();
    const b = e.M.transferBudgetChars("anthropic", s.model, s, 3000000);
    check("C09", "reproduction", "An already oversized current prompt still receives a positive history allowance", b === 20000, { promptChars: 3000000, contextTokens: 200000, historyBudgetChars: b });
    await e.M.run(s.id, { text: "x".repeat(1200000) });
    check("C10", "reproduction", "A large current user message is submitted with no preflight", e.sdkCalls[0].prompt.length === 1200000, { sentChars: e.sdkCalls[0].prompt.length });
    const before = e.M.transferBudgetChars("anthropic", s.model, s, 100);
    s.contextUsage = { totalTokens: 199990, maxTokens: 200000 }; s.bindings.anthropic = { id: "full", syncedIndex: 0 };
    check("C11", "reproduction", "Transfer allowance ignores occupancy of a resumed thread", e.M.transferBudgetChars("anthropic", s.model, s, 100) === before, { budgetBefore: before, budgetWithNearlyFullThread: e.M.transferBudgetChars("anthropic", s.model, s, 100) });
  }
  for (const provider of ["anthropic", "openai"]) {
    const e = environment(), s = e.make({ model: provider === "openai" ? "gpt-audit" : "audit-claude" }); e.settings.llmProvider = provider;
    e.M.consultReviewers = async () => { e.M.addMessage(s, e.msg("system", "Consulting")); e.M.addMessage(s, e.msg("reviewer", "REVIEWER ADVICE")); return "REVIEWER ADVICE"; };
    await e.M.run(s.id, { text: "CURRENT PROMPT", reviewers: [{ provider, model: s.model }], reviewMode: "before" });
    const replay = provider === "openai" ? JSON.stringify(e.injections) : e.sdkCalls[0].prompt;
    const count = provider === "openai" ? (replay.includes("CURRENT PROMPT") ? 2 : 1) : replay.split("CURRENT PROMPT").length - 1;
    check(provider === "openai" ? "C13" : "C12", "reproduction", provider + " derives prompt boundary after reviewer cards and sends current prompt twice", count === 2, { occurrencesIncludingCurrentInput: count });
  }
  {
    const e = environment(), s = e.make({ messages: [e.msg("user", "OLD"), e.msg("assistant", "DONE")] });
    e.H.setBinding(s, "anthropic", { id: "native-claude", syncedIndex: 1 });
    s.messages.push(e.msg("user", "RETRY THIS"), e.msg("assistant", "PARTIAL ALREADY IN NATIVE THREAD"), e.msg("error", "failure"));
    await e.M.run(s.id, { text: "RETRY THIS", resumeContinuation: true });
    const t = e.sdkCalls[0].prompt;
    check("C14", "reproduction", "Retry replays its original user prompt and partial output into the resumed thread", t.split("RETRY THIS").length - 1 === 2 && t.includes("PARTIAL ALREADY IN NATIVE THREAD"), { occurrences: t.split("RETRY THIS").length - 1, resumed: e.sdkCalls[0].resume });
  }
  {
    const e = environment(), s = e.make({ model: "gpt-audit", messages: [e.msg("user", "OLD"), e.msg("assistant", "DONE")] }); e.settings.llmProvider = "openai";
    e.H.setBinding(s, "openai", { id: "native-openai", syncedIndex: 1, account: "login" });
    s.messages.push(e.msg("user", "ALREADY RECEIVED"), e.msg("assistant", "PARTIAL ALREADY RECEIVED"), e.msg("system", "Stopped"));
    await e.M.run(s.id, { text: "NEW MIDDLE INSTRUCTION" });
    check("C15", "reproduction", "Next prompt after a stopped turn reinjects accepted history into Codex", JSON.stringify(e.injections).includes("PARTIAL ALREADY RECEIVED") && e.appCalls[0].resume === "native-openai", { injectedItems: e.injections[0].items.length });
  }
  {
    const e = environment(), s = e.make({ model: "gpt-audit", messages: [e.msg("user", "SOURCE"), e.msg("assistant", "SOURCE ANSWER")] }); e.settings.llmProvider = "openai";
    e.control.app = async () => ({ ok: false, error: "network unavailable", errorInfo: "httpConnectionFailed" });
    await e.M.run(s.id, { text: "RETRY PROMPT" });
    e.control.app = null;
    await e.M.run(s.id, { text: "RETRY PROMPT", resumeContinuation: true });
    check("C16", "reproduction", "Successful Codex history injection is repeated after failure before completion", e.injections.length === 2 && e.injections.every(x => JSON.stringify(x.items).includes("SOURCE ANSWER")), { injections: e.injections.length, ids: e.injections.map(x => x.id) });
  }
  {
    const e = environment(), s = e.make({ messages: Array.from({ length: 20 }, (_, i) => e.msg("user", "ITEM-" + i + " " + "x".repeat(10000))) });
    const plan = e.H.planTransfer(s, -1, 19, { budgetChars: 60000, forceSummary: true });
    await e.M.summarizeRecord(s, "anthropic", s.model, plan, { budgetChars: 60000 });
    const count = e.summaryCalls.length;
    await e.M.summarizeRecord(s, "anthropic", s.model, plan, { budgetChars: 60000 });
    check("C17", "control", "Unchanged summary span is reused without a model call", e.summaryCalls.length === count);
    s.messages[0].text = "CHANGED RECORD";
    const cached = e.H.cachedSummary(s, -1, plan.head.to);
    check("C18", "reproduction", "Summary cache has no content revision and survives a source edit", !!cached && cached.text === "Summary of synthetic completed work.");
    const n = reads.length;
    await e.M.transferBlock(s, "anthropic", { model: s.model, from: -1, to: 19, forceSummary: true, budgetScale: 0.15 });
    check("C19", "reproduction", "A summary cache hit still reads and serializes the raw history from index zero", reads.slice(n).some(r => r.id === s.id && r.start === 0), { ranges: reads.slice(n) });
    e.H.rememberSummary(s, { from: -1, upTo: 19, text: "COMPLETE CHECKPOINT" });
    check("C20", "reproduction", "A partially overlapping transfer cannot reuse the earlier checkpoint", e.H.cachedSummary(s, 9, 19) === null);
  }
  {
    const e = environment(), s = e.make({ messages: [e.msg("user", "EARLY CURRENT GOAL"), e.msg("assistant", "L".repeat(100000))] });
    const p = e.H.planTransfer(s, -1, 1, { budgetChars: 10000, forceSummary: true });
    check("C21", "reproduction", "A large newest entry leaves no exact recent tail", p.headCount === p.count, { headCount: p.headCount, count: p.count, exactTail: p.count - p.headCount });
    const tool = e.msg("tool", "", { toolName: "Bash", toolInput: { command: "build" }, result: "Log ".repeat(600) + "CRITICAL FAILURE AT END", status: "error" });
    check("C22", "reproduction", "Tool head clipping removes the outcome and supplies no immutable archive locator", !e.H.entryTextShort(tool).includes("CRITICAL FAILURE AT END") && !e.H.entryTextShort(tool).includes(tool.id), { originalChars: tool.result.length, shortenedChars: e.H.entryTextShort(tool).length });
  }
  {
    const e = environment(), s = e.make({ messages: [e.msg("user", "Keep exact decision"), e.msg("assistant", "ack"), e.msg("user", "already seen")] });
    e.H.setBinding(s, "anthropic", { id: "native", syncedIndex: 2 });
    e.H.rememberSummary(s, { from: -1, upTo: 1, text: "OLD RECORD" });
    const raw = loadCjs("src/main/store.js", name => {
      const m = { electron: { app: { getPath: () => "E:\\synthetic-context-audit" } }, fs: {}, path, crypto, "./convo": {}, os: { homedir: () => "E:\\synthetic-context-audit" } };
      if (Object.hasOwn(m, name)) return m[name]; throw Error(name);
    }, {}, "module.exports.__audit = { loaded, index };");
    raw.__audit.loaded.set(s.id, s);
    raw.deleteMessage(s.id, s.messages[0].id);
    s.messages.push(e.msg("assistant", "NEW UNSEEN ENTRY"), e.msg("user", "CURRENT"));
    const sync = e.H.pendingSync(s, "anthropic", e.H.lastGlobalIndex(s));
    check("C23", "reproduction", "Deleting a message shifts absolute cursors and can skip a newer unsent entry", !sync.needed && s.messages[2].text === "NEW UNSEEN ENTRY", { syncedIndex: sync.from, beforePromptIndex: sync.to });
    check("C24", "reproduction", "Deleting a message does not invalidate stored summary coverage", e.H.cachedSummary(s, -1, 1).text === "OLD RECORD");
    // The store's delayed flush uses only this VM's mocked filesystem; no disk write can occur.
  }
  {
    const e = environment(), s = e.make({ model: "gpt-audit" }); e.settings.llmProvider = "openai";
    e.control.app = async opts => { opts.on.onUsage({ input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 100, output_tokens: 100 }); return { ok: true, text: "reply" }; };
    await e.M.run(s.id, { text: "USAGE" });
    check("C25", "reproduction", "Codex accounting adds cache categories on top of total input", s.totalTokensIn === 1900, { providerInput: 1000, cachedInput: 800, cacheWrite: 100, storedInput: s.totalTokensIn, contract: "OpenAI input includes cached/write subsets; confirm pinned transport against live runtime." });
    const c = await e.M.contextUsage(s.id);
    e.M.runners.set(s.id, { running: true, query: { interrupt() {}, steer() {} }, codex: true });
    check("C26", "reproduction", "Codex context usage endpoint returns null even with a live runner", await e.M.contextUsage(s.id) === null, { idle: c });
    let args = "unset";
    e.M.runners.set(s.id, { running: true, query: { getContextUsage: async a => { args = a; return { totalTokens: 123, maxTokens: 200000, percentage: 1 }; } } });
    const usage = await e.M.contextUsage(s.id);
    check("C27", "control", "Claude control-response camelCase fields match renderer expectations", usage.totalTokens === 123 && usage.maxTokens === 200000);
    check("C28", "reproduction", "Polling context usage selects SDK full-count default rather than summary detail", args === undefined, { argumentOmitted: args === undefined, sdkDefault: "full", uiIntervalMs: 3000 });
  }
  {
    const e = environment(), s = e.make();
    e.M.handleMessage(s, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 190000 } }, {});
    check("C29", "reproduction", "Claude compaction boundary is discarded instead of recorded", s.messages.length === 0 && e.sends.length === 0);
    check("C30", "source-contract", "No native Codex compact request or history lookup tool is registered", !source["src/main/codex-appserver.js"].includes('"thread/compact/start"') && source["src/main/codex-appserver.js"].includes("no dynamic tools registered"));
  }
  {
    const e = environment(), s = e.make();
    e.M.selectedSkillDigests = () => ({ digests: ["PROCEDURE".repeat(2000)], names: ["procedure"] });
    await e.M.run(s.id, { text: "FIRST" }); await e.M.run(s.id, { text: "NEXT" });
    check("C31", "reproduction", "Selected skill body is appended again on an already synced native thread", e.sdkCalls[0].prompt.includes("PROCEDURE") && e.sdkCalls[1].prompt.includes("PROCEDURE"), { appendixCharsPerTurn: e.sdkCalls[1].prompt.length - 4 });
  }
  {
    const e = environment(), s = e.make({ messages: [e.msg("user", "OLD"), e.msg("assistant", "A")] });
    e.H.setBinding(s, "anthropic", { id: "gone", syncedIndex: 1 });
    let attempt = 0;
    e.control.sdk = async function* () { attempt++; if (attempt === 1) throw Error("no conversation found"); throw Error("prompt is too long"); };
    await e.M.run(s.id, { text: "NEXT" });
    check("C32", "reproduction", "Claude lost-thread recovery does not handle a too-long error on its second attempt", attempt === 2 && s.status === "error" && !e.M._lastRun.sent.promptTooLongRecovery, { attempts: attempt, status: s.status, summaries: e.summaryCalls.length });
  }
  {
    const e = environment(), s = e.make({ messages: [e.msg("user", "X".repeat(1100000))] });
    e.M.setSummarizer(async () => { throw Error("prompt is too long in summarizer"); });
    let thrown = "";
    try { await e.M.run(s.id, { text: "NEXT" }); } catch (err) { thrown = err.message; }
    check("C33", "reproduction", "Claude transfer failure occurs before cleanup and leaves a running slot", !!thrown && e.M.isRunning(s.id) && s.status === "running", { error: thrown, runningSlot: e.M.isRunning(s.id), status: s.status });
  }
  {
    const e = environment(), s = e.make({ messages: [e.msg("user", "OLD"), e.msg("assistant", "A")] });
    e.H.setBinding(s, "anthropic", { id: "native", syncedIndex: 1 });
    let attempt = 0;
    e.control.sdk = async function* () {
      attempt++;
      if (attempt === 1) { yield { type: "assistant", message: { id: "part", content: [{ type: "text", text: "ACTION ALREADY APPLIED" }] } }; throw Error("prompt is too long"); }
      yield { type: "result", subtype: "success", is_error: false, session_id: "new-native", usage: {} };
    };
    await e.M.run(s.id, { text: "APPLY A CHANGE" });
    check("C34", "reproduction", "Too-long recovery omits already emitted current-turn actions from the new context", e.sdkCalls.length === 2 && !String(e.sdkCalls[1].prompt).includes("ACTION ALREADY APPLIED") && s.messages.some(m => m.text === "ACTION ALREADY APPLIED"), { retryPromptChars: String(e.sdkCalls[1].prompt).length, currentAttemptOutputCarried: false });
  }
  {
    const e = environment(), s = e.make({ messages: Array.from({ length: 100 }, (_, i) => e.msg("user", "E" + i + " " + "z".repeat(500))) });
    const p = e.H.planTransfer(s, -1, 99, { budgetChars: 8000, forceSummary: true });
    e.H.rememberSummary(s, { from: -1, upTo: p.head.to, text: "ORIGINAL" });
    for (let i = 0; i < 61; i++) e.H.rememberSummary(s, { from: i, upTo: i + 1, text: "S-" + i });
    check("C35", "reproduction", "Global FIFO summary retention can evict the only root checkpoint", e.H.cachedSummary(s, -1, 99) === null, { summariesRetained: s.summaries.length });
  }
  {
    const e = environment(), s = e.make(), ac = new AbortController(); ac.abort();
    await e.M.runHeadlessAnthropic({ settings: e.settings, model: s.model, thinking: "low", system: "Synthetic summary instruction", prompt: "Synthetic summary input", cwd: ROOT, signal: ac.signal });
    check("C36", "reproduction", "An already-aborted parent still starts Claude headless summarization", e.sdkCalls.length === 1 && !e.sdkCalls[0].options.abortController.signal.aborted, { calls: e.sdkCalls.length, childAborted: e.sdkCalls[0].options.abortController.signal.aborted });
  }
  {
    const e = environment(), s = e.make();
    await e.M.run(s.id, { text: "PROVIDER-A-FIRST" });
    e.settings.llmProvider = "openai"; await e.M.run(s.id, { text: "PROVIDER-B-MIDDLE", model: "gpt-audit" });
    e.settings.llmProvider = "anthropic"; await e.M.run(s.id, { text: "PROVIDER-A-FOLLOWUP", model: "audit-claude" });
    const resumed = e.sdkCalls[1];
    check("C37", "control", "Successful A-B-A provider switching resumes A and transfers only B's missed span", resumed.resume === "native-claude" && resumed.prompt.includes("PROVIDER-B-MIDDLE") && !resumed.prompt.includes("PROVIDER-A-FIRST") && resumed.prompt.endsWith("PROVIDER-A-FOLLOWUP"));
  }
  {
    const e = environment(), s = e.make({ messages: Array.from({ length: 30 }, (_, i) => e.msg("user", "RAW-ENTRY-" + i + " " + "x".repeat(9000))) });
    const first = e.H.planTransfer(s, -1, 19, { budgetChars: 60000, forceSummary: true });
    await e.M.summarizeRecord(s, "anthropic", s.model, first, { budgetChars: 60000 });
    const count = e.summaryCalls.length, next = e.H.planTransfer(s, -1, 29, { budgetChars: 60000, forceSummary: true });
    await e.M.summarizeRecord(s, "anthropic", s.model, next, { budgetChars: 60000 });
    const added = e.summaryCalls.slice(count);
    check("C38", "control", "An advancing summary with the same start uses cached state plus new entries", added.length > 0 && added.every(c => !c.prompt.includes("RAW-ENTRY-0 ")) && added[0].prompt.includes("Summary so far"), { newSummaryRequests: added.length });
  }
  {
    const e = environment(), s = e.make({ model: "gpt-audit", messages: [e.msg("user", "OLDER"), e.msg("assistant", "OLD ANSWER")] }); e.settings.llmProvider = "openai";
    e.H.setBinding(s, "openai", { id: "native-openai", syncedIndex: 1, account: "login" });
    let attempts = 0;
    e.control.app = async opts => {
      attempts++;
      if (attempts === 1) { opts.on.onAgentMessage("CURRENT ACTION ALREADY APPLIED", { id: "partial", type: "agentMessage", phase: "commentary" }); return { ok: false, error: "context window exceeded", errorInfo: "contextWindowExceeded" }; }
      return { ok: true, text: "Done" };
    };
    await e.M.run(s.id, { text: "MAKE CHANGE" });
    check("C39", "reproduction", "Codex too-long recovery drops completed work from the failed current turn", attempts === 2 && s.messages.some(m => m.text === "CURRENT ACTION ALREADY APPLIED") && !JSON.stringify(e.injections).includes("CURRENT ACTION ALREADY APPLIED"), { attempts, priorAttemptOutputCarried: false });
  }
  {
    const payload = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ id: "arch-" + i, role: "user", text: "ARCHIVE PAYLOAD " + "z".repeat(200) })).join("\n") + "\n";
    let fullReads = 0;
    const fakeFs = { statSync: () => ({ size: payload.length, mtimeMs: 1 }), readFileSync: () => { fullReads++; return payload; } };
    const raw = loadCjs("src/main/store.js", name => {
      const m = { electron: { app: { getPath: () => "E:\\synthetic-context-audit" } }, fs: fakeFs, path, crypto, "./convo": {}, os: { homedir: () => "E:\\synthetic-context-audit" } };
      if (Object.hasOwn(m, name)) return m[name]; throw Error(name);
    }, {}, "module.exports.__audit = { loaded, archiveCache };");
    raw.__audit.loaded.set("archive", { id: "archive", archivedCount: 5000, messages: [] });
    const page = raw.getMessagesRange("archive", 4000, 1), cachedRows = raw.__audit.archiveCache.get("archive").rows.length;
    check("C40", "reproduction", "One old-history page reads and parses the entire archive", page.messages.length === 1 && fullReads === 1 && cachedRows === 5000, { requestedEntries: 1, parsedEntries: cachedRows, fullArchiveChars: payload.length });
  }
  const output = { date: "2026-09-10", project: ROOT, liveProvidersContacted: false, savedProfilesRead: false, productionChanged: false, total: results.length, passed: results.filter(x => x.pass).length, failed: results.filter(x => !x.pass).length, counts: Object.fromEntries([...new Set(results.map(x => x.kind))].map(k => [k, results.filter(x => x.kind === k).length])), results, sourceFingerprints: Object.entries(source).map(([f,s]) => ({ path: f, sha256: crypto.createHash("sha256").update(s).digest("hex") })) };
  fs.writeFileSync(path.join(__dirname, "context-results.json"), JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify({ total: output.total, passed: output.passed, failed: output.failed, counts: output.counts, failures: results.filter(x => !x.pass) }, null, 2));
  process.exitCode = output.failed ? 1 : 0;
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
