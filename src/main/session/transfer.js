"use strict";
/* Native context stays with its provider thread; the canonical record and portable memory stay
 * with the AtomNano session. Fitting records transfer exactly. Oversized records and explicit
 * synthesis use adaptive selected evidence plus cached memory, with exact source retrieval. */
const store = require("../storage/store");
const history = require("../storage/history");
const { PROVIDER_LABEL } = require("./errors");
const packet = require("./context-packet");

// Instruction for the SEPARATE summarisation request (never injected into the user's own
// turn). Used only when the exact record cannot fit the destination model's context window.
const SUMMARY_INSTRUCTIONS = "You are condensing the earlier part of a conversation between a user and an AI coding assistant so that a fresh model instance can continue it. Write a faithful working summary: the user's goals, explicit instructions and preferences; decisions made and why; what was changed or produced (files, commands, outcomes) and what was verified; open questions and pending work; exact identifiers that matter (paths, names, commands, error messages). Keep the order of events where it matters. Do not add advice, do not invent details, and say when something was left unresolved. Plain prose and bullet points, at most about 1,500 words. Output only the summary.";

/* Historical handoffs adapt to the work, not to the size of the raw archive. These limits do
 * not restrict the model's native context or the user's new prompt. A cold handoff may ask for
 * ONE short summary; cached memory is used immediately. Unavailable summaries have a local fallback. */
const SYNTH_SEED_CHARS = packet.MAX_PACKET_BYTES; // compatibility export; the budget is now UTF-8 bytes
const SUMMARY_CALL_TIMEOUT_MS = 20000;
const SUMMARY_MAX_CALLS = 1;
const PREPARATION_TIMEOUT_MS = 30000;
const fmtN = (n) => Number(n || 0).toLocaleString("en-US");
const fmtDuration = (ms) => { const mins = Math.round(ms / 60000); if (mins >= 1) return `${mins} minute${mins === 1 ? "" : "s"}`; const secs = Math.max(1, Math.round(ms / 1000)); return `${secs} second${secs === 1 ? "" : "s"}`; };
const abortError = (msg) => { const e = new Error(msg); e.name = "AbortError"; return e; };
// One summariser request (instruction + previous summary + new material) stays within half the budget.
// The deadline includes any queue wait; a foreground timeout uses source evidence.
const preparationTimeoutError = (job) => {
  const total = job && job.totalMs > 0 ? job.totalMs : PREPARATION_TIMEOUT_MS;
  const after = job && job.calls ? ` after ${fmtN(job.calls)} model call${job.calls === 1 ? "" : "s"}` : " before its first model call";
  const e = new Error(`Context preparation exceeded ${fmtDuration(total)}${after}. Saved checkpoints remain available.`);
  e.name = "TimeoutError"; e.timeout = true; e.preparationTimeout = true; return e;
};
// Milliseconds a preparation job may still spend without progress (Infinity without a job / deadline).
const remainingMs = (job) => (job && job.deadlineAt > 0 ? job.deadlineAt - Date.now() : Infinity);
// Resolve with `p`, or reject with an AbortError the moment `signal` aborts (p is left to settle on its own).
function raceAbort(p, signal, msg) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError(msg || "Cancelled"));
  return new Promise((res, rej) => {
    const onAbort = () => rej(abortError(msg || "Cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(p).then((v) => { signal.removeEventListener("abort", onAbort); res(v); }, (e) => { signal.removeEventListener("abort", onAbort); rej(e); });
  });
}
// Resolve with `p`, or reject with the preparation timeout once the job's deadline passes.
function raceDeadline(p, job) {
  const left = remainingMs(job);
  if (!(left < Infinity)) return p;
  if (left <= 0) return Promise.reject(preparationTimeoutError(job));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(preparationTimeoutError(job)), left);
    Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

const methods = {
  /* ----------------------- Conversation transfer, sized to the model -----------------------
   * The exact record is the default. When it cannot fit the destination model's context
   * window, history.planTransfer degrades it visibly (shortened tool payloads, then a
   * cached/rolled summary of the oldest part + newest entries verbatim). The user asked
   * for this on 2026-09-10 to stop "prompt too long" failures on new/lost threads. */
  // GLOBAL index of the current prompt — from the user message's id (durable), falling back to
  // the newest user message, then the last entry. Everything before it is "earlier history".
  promptIndexFor(session, promptMessageId) {
    const g = history.indexOfMessage(session, promptMessageId);
    if (g >= 0) return g;
    for (let i = session.messages.length - 1; i >= 0; i--) { const m = session.messages[i]; if (m && m.role === "user" && !m.steered) return (session.archivedCount || 0) + i; }
    return history.lastGlobalIndex(session);
  },

  /* After an attempt failed mid-way (context overflow): the canonical entries it produced after
   * the prompt travel with the replacement record, and a labelled note (after the user's own
   * text) asks the model to continue rather than redo them. */
  continuationAfter(session, promptIndex) {
    const arch = session.archivedCount || 0;
    const produced = session.messages.filter((m, i) => arch + i > promptIndex && history.isHistoryMessage(m) && m.role !== "user");
    if (!produced.length) return { to: promptIndex - 1, count: 0, note: "" };
    return { to: history.lastGlobalIndex(session), count: produced.length, note: `\n\n[Continuation note from AtomNano: the request above was already being worked on when the model's context window overflowed. The conversation record ends with the ${produced.length} action${produced.length === 1 ? "" : "s"}/outputs that attempt completed. Continue from there — do not redo completed steps; check the outcome of any action whose result is marked unknown.]` };
  },

  /* The model's context window in tokens. The provider's OWN figure for this session's model and
   * 1M choice when it has reported one (modelUsage[model].contextWindow on a Claude result, the
   * CLI's context-usage maxTokens — see noteReportedWindow), else the catalog's figure (1M with the
   * beta when the model offers it); either capped by a window LEARNED from a real rejection on this
   * session for the same model / 1M choice (see learnWindow). `raw: true` ignores the learned cap. */
  contextTokensFor(provider, model, session, { raw = false } = {}) {
    let believed = provider === "openai" ? 272000 : provider === "anthropic" ? 200000 : 128000;
    try {
      const P = require("../providers/catalog");
      const cat = P.get(provider);
      const models = cat && Array.isArray(cat.models) ? cat.models : [];
      const m = models.find((x) => x.id === model) || (provider === "custom" && session && models.find((x) => x.id === session.model));
      if (m && (+m.ctx > 0 || m.ctx1m)) believed = Math.max(+m.ctx || 0, m.ctx1m ? 1000000 : 0);
      else if (provider === "anthropic" && P.context1M("anthropic", model)) believed = 1000000;
    } catch { /* catalog unavailable → the default above */ }
    if (!session || !session.bindings) return believed;
    const b = session.bindings[provider] || {};
    const scoped = (w) => !!(w && w.model === model && !!w.oneM === !!session.oneM && w.tokens > 0);
    if (scoped(b.reportedWindow)) believed = b.reportedWindow.tokens;
    if (raw) return believed;
    const lw = b.learnedWindow;
    if (scoped(lw) && lw.tokens < believed) return lw.tokens;
    return believed;
  },
  /* The provider told us the window it actually uses for `model` (a Claude result's
   * modelUsage[model].contextWindow, the CLI's context-usage maxTokens). Remembered on the binding
   * for this model + 1M choice — the catalog's guess (200K for a model that runs at 1M, or the
   * reverse) no longer decides budgets or the rollover. A learned rejection cap still applies. */
  noteReportedWindow(session, provider, model, tokens, { source, cliModel, oneM } = {}) {
    if (!session || !model || !(tokens > 0)) return null;
    // The figure describes the scope it was measured under (the run's model + 1M choice, snapshotted
    // at dispatch). A figure from another scope — a run that finished after the user changed the
    // 1M choice or the model — must never replace the current scope's window.
    const scopeOneM = typeof oneM === "boolean" ? oneM : !!session.oneM;
    if (scopeOneM !== !!session.oneM || (session.model && model !== session.model)) return null;
    const b = history.bindingFor(session, provider);
    const cur = b.reportedWindow;
    if (cur && cur.model === model && !!cur.oneM === scopeOneM && cur.tokens === tokens) return cur;
    const reportedWindow = { model, oneM: scopeOneM, tokens: Math.round(tokens), source: source || "provider", cliModel: cliModel || "", ts: store.nowISO() };
    history.setBinding(session, provider, { reportedWindow });
    return reportedWindow;
  },
  /* May a measurement `runner` took (context usage, the provider's window figure) still be recorded?
   * Only while that run owns the session's slot — or ended without a newer run taking it —, its
   * dispatch scope (model + 1M choice) is still the session's, and the native thread it measured is
   * still the bound one (a rollover / new thread since means the figure describes a thread that is
   * gone). A late answer from a replaced run never overwrites the current run's measurement. */
  measurementCurrent(session, runner, { provider = "anthropic", bindingId } = {}) {
    if (!session || !runner) return false;
    if (runner.interrupted) return false;   // a stopped run's measurement is not recorded
    const cur = this.runners.get(session.id);
    if (cur && cur !== runner) return false;
    // A newer run may already have COME AND GONE (reserved, completed, released): the manager remembers
    // the latest run reserved on the session (control.js reserveRun), so an old probe that resolves
    // after that run finished cannot overwrite what the newer run measured on the same thread.
    const latest = this._lastRunId && this._lastRunId.get(session.id);
    if (latest && latest !== runner.id) return false;
    if (runner.retargeted) return false;
    if (runner.model && session.model && runner.model !== session.model) return false;
    if (typeof runner.oneM === "boolean" && runner.oneM !== !!session.oneM) return false;
    if (bindingId !== undefined && history.bindingFor(session, provider).id !== bindingId) return false;
    return true;
  },
  // Believed vs effective window for a session — what the UI shows and what budgets use.
  effectiveWindow(session, provider, model) {
    const believed = this.contextTokensFor(provider, model, session, { raw: true });
    const tokens = this.contextTokensFor(provider, model, session);
    const rw = session && session.bindings && session.bindings[provider] && session.bindings[provider].reportedWindow;
    const reported = !!(rw && rw.model === model && !!rw.oneM === !!session.oneM && rw.tokens > 0);
    return { believed, tokens, learned: tokens < believed, reported, source: tokens < believed ? "learned" : reported ? "reported" : "catalog" };
  },
  /* A "prompt is too long" told us the model took about `estTokens` before refusing — less than
   * the window we assumed. Remember the real one for this session + model + 1M choice (rounded to
   * a clean boundary: 200K is by far the common case). Returns the learned size or null. */
  learnWindow(session, provider, model, estTokens) {
    const believed = this.contextTokensFor(provider, model, session, { raw: true });
    if (!(estTokens > 0) || estTokens >= believed * 0.9) return null;
    const learned = estTokens >= 150000 && estTokens <= 260000 ? 200000 : Math.max(50000, Math.floor(estTokens / 25000) * 25000);
    history.setBinding(session, provider, { learnedWindow: { model, oneM: !!(session && session.oneM), tokens: learned, from: Math.round(estTokens), ts: store.nowISO() } });
    return learned;
  },
  /* Should the next turn continue in a FRESH native session? Yes when the user asked for it
   * (forceRollover) or when the thread's context — measured by the CLI after its last reply,
   * else estimated from the last request's input — plus this prompt would pass the threshold
   * (settings.contextRolloverPct, 0 = off). Returns null or { reason, pct, used, window }. */
  contextRolloverNeeded(session, provider, promptChars = 0) {
    const b = history.bindingFor(session, provider);
    if (!b.id) return null;                                   // no thread yet — nothing to roll
    if (session.forceRollover) return { reason: "requested", pct: 0, used: 0, window: this.contextTokensFor(provider, session.model, session) };
    const settings = store.getSettings(session.cwd);
    const threshold = Math.min(98, Math.max(0, +settings.contextRolloverPct || 0));
    if (!threshold) return null;
    const window = this.contextTokensFor(provider, session.model, session);
    const measured = b.ctxUsage && b.ctxUsage.totalTokens > 0 ? b.ctxUsage.totalTokens : 0;
    const used = measured || (b.activeTokens || 0);
    if (!used) return null;
    const projected = used + Math.ceil((promptChars || 0) / history.CHARS_PER_TOKEN) + 8000;   // room for the reply and its first tool results
    const pct = Math.round((projected / window) * 100);
    return pct >= threshold ? { reason: "full", pct, used, window, measured: !!measured } : null;
  },
  /* After a Claude turn: ask the live query how full its context is (the CLI answers from the last
   * response's usage — no token-count calls). Stored on the binding for the rollover decision and
   * the context chip; bounded, never blocks the run. */
  captureContextUsage(session, runner) {
    const q = runner && runner.query;
    if (!q || typeof q.getContextUsage !== "function") return Promise.resolve(null);
    const sessionId = session.id;
    // Snapshot of what the answer will describe: THIS run's model + 1M choice and the thread bound
    // now. The answer may arrive after a Stop, a replacement run or a rollover — then it is dropped
    // (see measurementCurrent), never written over the newer run's scope or binding.
    const model = runner.model || session.model || "";
    const oneM = typeof runner.oneM === "boolean" ? runner.oneM : !!session.oneM;
    const bindingId = history.bindingFor(session, "anthropic").id;
    return Promise.race([q.getContextUsage({ detail: "summary" }), new Promise((res) => setTimeout(() => res(null), 1500))]).then((u) => {
      if (!u || !(u.totalTokens > 0)) return null;
      if (!this.measurementCurrent(session, runner, { bindingId }) || !!session.oneM !== oneM || (session.model && model && session.model !== model)) return null;
      const ctxUsage = { totalTokens: u.totalTokens, maxTokens: u.maxTokens || 0, rawMaxTokens: u.rawMaxTokens || 0, percentage: u.percentage || 0, model: u.model || model, ts: store.nowISO() };
      // The CLI's window figure is the provider's own (scoped to the model + 1M choice this run sent).
      const reported = u.maxTokens > 0 ? u.maxTokens : u.rawMaxTokens > 0 ? u.rawMaxTokens : 0;
      if (reported && model) this.noteReportedWindow(session, "anthropic", model, reported, { source: "contextUsage", cliModel: u.model || "", oneM });
      history.setBinding(session, "anthropic", { ctxUsage });
      this.send("session:context", { sessionId, info: this.contextInfo(sessionId) });
      return ctxUsage;
    }).catch(() => null);
  },
  /* Everything the context chip / popover shows for a session. */
  contextInfo(sessionId) {
    const s = store.getSession(sessionId);
    if (!s) return null;
    const settings = store.getSettings(s.cwd);
    const provider = s.lastProvider || settings.llmProvider || "anthropic";
    const b = history.bindingFor(s, provider);
    const win = this.effectiveWindow(s, provider, s.model);
    const measured = b.ctxUsage && b.ctxUsage.totalTokens > 0 ? b.ctxUsage.totalTokens : 0;
    const used = measured || (b.activeTokens || 0);
    const total = (s.archivedCount || 0) + (s.messages || []).length;
    const cachedMemory = history.cachedSummary(s, -1, history.lastGlobalIndex(s));
    const digest = cachedMemory ? { upTo: cachedMemory.upTo, entries: cachedMemory.entries || 0, ts: cachedMemory.ts, calls: cachedMemory.calls || 0, selected: cachedMemory.inputMode === "selected", sourceProvider: cachedMemory.provider, ...(b.digest && b.digest.upTo === cachedMemory.upTo ? b.digest : {}) } : b.digest;
    return {
      provider, model: s.model, thread: !!b.id, window: win.tokens, believedWindow: win.believed, learned: win.learned, learnedFrom: b.learnedWindow ? b.learnedWindow.from : 0,
      windowSource: win.source, reportedWindow: win.reported ? b.reportedWindow.tokens : 0,
      used, pct: used ? Math.min(999, Math.round((used / win.tokens) * 100)) : 0, source: measured ? "measured" : used ? "estimated" : "none", usageTs: (b.ctxUsage && b.ctxUsage.ts) || b.activeTokensTs || null,
      rolloverPct: +settings.contextRolloverPct || 0, forceRollover: !!s.forceRollover, digestOn: settings.contextDigest !== false,
      digest: digest ? { ...digest, totalEntries: total, coversPct: total ? Math.round(((digest.upTo + 1) / total) * 100) : 0 } : null, digestRunning: !!s._digestRunning,
      preparing: this.preparationOf(sessionId),
      compactions: b.compactions || 0, totalEntries: total,
    };
  },
  requestRollover(sessionId, on = true) {
    const s = store.getSession(sessionId); if (!s) return false;
    s.forceRollover = !!on; store.scheduleWrite(sessionId);
    this.send("session:context", { sessionId, info: this.contextInfo(sessionId) });
    return true;
  },
  /* The rolling digest ("what the model must keep knowing"): once a Claude thread is half full,
   * the OLDEST part of the record is summarised in the background — checkpoints are cached and
   * rolled forward, so a rollover later reuses them and only folds in the newest entries. Same
   * summariser and cache as the transfer itself; shown in the context popover with its call
   * count; never sent unless a rollover happens. `force` runs it regardless of fill / novelty. */
  async maybeDigest(session, { force = false, signal } = {}) {
    if (!session || session._digestRunning) return null;
    if (signal && signal.aborted) return null;   // a stopped turn never starts paid summary work
    const settings = store.getSettings(session.cwd);
    if (settings.contextDigest === false && !force) return null;
    const provider = session.lastProvider || settings.llmProvider || "anthropic";
    const b = history.bindingFor(session, provider);
    const info = this.contextInfo(session.id);
    if (!force && (!info || info.pct < 50)) return null;
    const last = history.lastGlobalIndex(session);
    if (!force && b.digest && last - b.digest.upTo < 12) return null;   // fewer than a dozen new entries: nothing worth folding yet
    const budget = this.transferBudgetChars(provider, session.model, session, 0);
    const plan = history.planTransfer(session, -1, last, { budgetChars: budget, forceSummary: true, tailShare: 0.3 });
    if (plan.mode !== "summary" || plan.headCount < 4) return null;   // the record would travel (nearly) verbatim anyway
    if (b.digest && b.digest.upTo >= plan.head.to && !force) return null;
    session._digestRunning = true;
    this.send("session:context", { sessionId: session.id, info: this.contextInfo(session.id) });
    const job = this.preparationJob(session, "digest");
    try {
      // One pass is bounded (summaryMaxCalls, the total deadline): a very long record advances
      // checkpoint by checkpoint over several passes, each reusing the last — never one endless
      // chain. The pass runs under the session's preparation lock, so Stop on the session ends it
      // (cancelPreparations) even though no turn is running.
      await this.summarizeRecord(session, provider, session.model, plan, { budgetChars: budget, signal, job });
      history.setBinding(session, provider, { digest: { upTo: plan.head.to, entries: plan.headCount, ts: store.nowISO(), calls: (b.digest ? b.digest.calls || 0 : 0) + job.calls, inputTokens: (b.digest ? b.digest.inputTokens || 0 : 0) + job.input_tokens, outputTokens: (b.digest ? b.digest.outputTokens || 0 : 0) + job.output_tokens } });
      return history.bindingFor(session, provider).digest;
    } catch (e) {
      // A bounded pass that stopped at its cap still advanced the checkpoints: record how far.
      const best = history.cachedSummary(session, -1, plan.head.to);
      if (best && job.calls) history.setBinding(session, provider, { digest: { upTo: best.upTo, entries: best.entries || 0, ts: store.nowISO(), partial: true, calls: (b.digest ? b.digest.calls || 0 : 0) + job.calls, inputTokens: (b.digest ? b.digest.inputTokens || 0 : 0) + job.input_tokens, outputTokens: (b.digest ? b.digest.outputTokens || 0 : 0) + job.output_tokens } });
      throw e;
    } finally {
      session._digestRunning = false;
      this.send("session:context", { sessionId: session.id, info: this.contextInfo(session.id) });
    }
  },
  async buildDigest(sessionId) {
    const s = store.getSession(sessionId); if (!s) return { ok: false, detail: "Session not found" };
    if (this.isRunning(sessionId)) return { ok: false, detail: "Wait for the running turn to finish." };
    try { const d = await this.maybeDigest(s, { force: true }); return { ok: true, digest: d || null, info: this.contextInfo(sessionId) }; }
    catch (e) { return { ok: false, detail: String((e && e.message) || e) }; }
  },
  // The latest cached summary text for the context popover ("what the model would carry").
  digestText(sessionId) {
    const s = store.getSession(sessionId); if (!s) return "";
    const best = history.cachedSummary(s, -1, history.lastGlobalIndex(s));
    return best ? best.text : "";
  },

  /* Explicit Synthesize carries bounded working context and a full-history reference. It does not
   * replay or repeatedly summarize the archive. The IPC wrapper reserves its own small header. */
  async synthesizeSeed(session, provider, { model, signal, onProgress } = {}) {
    const convo = require("../storage/convo");
    if (signal && signal.aborted) throw abortError("Cancelled before the handoff was prepared");
    const last = history.lastGlobalIndex(session), map = convo.sessionMap(session);
    const mapText = packet.excerpt(convo.sessionMapText(map, 1800), 1800);
    const boardText = packet.excerpt(typeof this.boardSummaryText === "function" ? this.boardSummaryText(session) : packet.taskText(session), 3200);
    const budget = packet.MAX_PACKET_BYTES - 1200;
    const plan = history.planTransfer(session, -1, last, { budgetChars: budget, handoff: true });
    const exact = history.transferText(plan, "");
    const exactSeed = [exact, mapText, boardText].filter(Boolean).join("\n\n---\n\n");
    if (plan.mode === "exact" && packet.bytes(exactSeed) <= budget) {
      const text = exactSeed;
      return { text, record: exact, mapText, map, boardText, summary: "", job: null, budget, bytes: packet.bytes(text), last, mode: plan.count ? "exact" : "none", count: plan.count, headCount: 0, tailCount: plan.count, fullChars: plan.fullChars || 0 };
    }
    const compactPlan = { ...plan, mode: "summary", headCount: plan.count, head: { from: -1, to: last }, tail: { from: last, to: last } };
    const job = this.preparationJob(session, "handoff", { onProgress });
    if (job.onProgress) job.onProgress(`Preparing a working handoff from ${fmtN(plan.count)} entries`, { phase: "start", calls: 0 });
    const summary = await this.summarizeRecord(session, provider, model, compactPlan, { signal, job });
    if (signal && signal.aborted) throw abortError("Cancelled before the handoff was prepared");
    const built = packet.assemble(session, plan.msgs, { from: -1, to: last, summary, summaryThrough: job.summaryThrough, summaryKind: job.memoryKind, maxBytes: budget, mapText });
    return { text: built.text, record: built.text, mapText, map, boardText: built.boardText, summary, job: this.persistedJob(job), budget: built.budget + 1200, bytes: packet.bytes(built.text), last, mode: "summary", selected: true, memorySource: job.memorySource, selectedCount: built.selectedCount, count: plan.count, headCount: plan.count, tailCount: 0, fullChars: plan.fullChars || 0 };
  },

  // Model capacity remains dynamic, including 1M+. Only a record which cannot fit this allowance
  // is replaced by a working handoff; ordinary native resumes keep their full provider context.
  transferBudgetChars(provider, model, session, promptChars = 0) {
    const ctx = this.contextTokensFor(provider, model, session);
    return Math.max(20000, Math.floor(ctx * 0.5) * history.CHARS_PER_TOKEN - (promptChars || 0));
  },

  async transferBlock(session, provider, { model, from, to, promptChars = 0, forceSummary = false, budgetScale = 1, signal, label, activeTokens = 0, onProgress } = {}) {
    if (from >= to) return { text: "", items: [], count: 0, mode: "none", note: "", budget: 0 };
    if (signal && signal.aborted) throw abortError("Cancelled before the record was prepared");
    const raw = this.transferBudgetChars(provider, model, session, promptChars) - Math.max(0, +activeTokens || 0) * history.CHARS_PER_TOKEN;
    const budget = Math.max(10000, Math.floor(raw * (budgetScale || 1)));
    const plan = history.planTransfer(session, from, to, { budgetChars: budget, forceSummary });
    const who = label || PROVIDER_LABEL[provider] || provider;
    // Only the PRIMARY conversation travels: history.isHistoryMessage leaves out every entry a
    // sub-agent produced internally (plan.agentEntries counts them; the note says so).
    const agentsNote = history.agentEntriesNote(plan);
    if (plan.mode === "exact" || (plan.mode === "shortened" && packet.bytes(plan.text) <= packet.MAX_PACKET_BYTES)) {
      const text = history.transferText(plan, "");
      const note = !plan.count ? (plan.agentEntries ? `${who} had already seen the primary conversation.${agentsNote}` : "") : (plan.mode === "exact"
        ? `${who} receives ${fmtN(plan.count)} earlier conversation entries it had not seen (verbatim record).`
        : `${who} receives ${fmtN(plan.count)} earlier entries; conversation text is verbatim and long tool payloads are shortened to fit the model's context window. The full record remains in this chat.`) + agentsNote;
      return { text, items: history.transferItems(plan, ""), count: plan.count, mode: plan.mode, note, plan, summary: "", budget, job: null };
    }
    // All missing history is represented by selected working evidence plus cached memory. There
    // is no multi-megabyte tail and no sequential catch-up chain, even with a 1M model.
    const compactPlan = { ...plan, mode: "summary", headCount: plan.count, head: { from, to }, tail: { from: to, to } };
    const job = this.preparationJob(session, "transfer", { onProgress });
    const query = (session.messages || []).filter((m, i) => m.role === "user" && (session.archivedCount || 0) + i > to).map((m) => m.text || "").slice(0, 1).join("");
    job.query = query;
    const summary = await this.summarizeRecord(session, provider, model, compactPlan, { signal, job });
    if (signal && signal.aborted) throw abortError("Cancelled before the record was prepared");
    const built = packet.assemble(session, plan.msgs, { from, to, summary, summaryThrough: job.summaryThrough, summaryKind: job.memoryKind, query, maxBytes: Math.min(packet.MAX_PACKET_BYTES, budget) });
    const text = built.text;
    const source = job.memorySource === "cached" ? "reused cached memory; no summary model call"
      : job.memorySource === "local" ? "used selected source excerpts because a model summary was unavailable"
        : "prepared with one summary model call";
    const note = `${who} receives a working handoff (${fmtN(packet.bytes(text))} bytes) of ${fmtN(plan.count)} earlier entries: cached decisions, recent requests and outcomes, task state, and references to the full record. AtomNano ${source}.${agentsNote}`;
    this.addMessage(session, { id: store.uid(), role: "summary", text, ts: store.nowISO(), meta: { provider, model, entries: plan.count, fromIndex: from + 1, toIndex: to, compact: true, selected: true, bytes: packet.bytes(text), budgetBytes: built.budget, job: this.persistedJob(job) } });
    return { text, items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }], count: plan.count, mode: "summary", compact: true, selected: true, note, plan: compactPlan, summary, budget, packetBudget: built.budget, job: this.persistedJob(job) };
  },

  // No extra model call just to shorten a model's response.
  async compactSummary(_session, _provider, _model, summary, capChars, { signal } = {}) {
    if (signal && signal.aborted) throw abortError("Cancelled while preparing context");
    return packet.excerpt(summary, capChars);
  },

  /* The accounting object of ONE preparation (a transfer, a synthesis, a digest pass): calls /
   * tokens / time, its kind, its progress sink — and its TOTAL deadline, which starts now and
   * includes any wait for another summary of the same conversation (see withPreparation). */
  preparationJob(session, kind, extra = {}) {
    const settings = store.getSettings(session && session.cwd);
    const totalMs = Math.min(PREPARATION_TIMEOUT_MS, +settings.preparationTimeoutMs > 0 ? +settings.preparationTimeoutMs : PREPARATION_TIMEOUT_MS);
    const startedAt = Date.now();
    const { onProgress, ...rest } = extra || {};
    const job = { calls: 0, input_tokens: 0, output_tokens: 0, ms: 0, kind: kind || "summary", startedAt, totalMs, deadlineAt: startedAt + totalMs, ...rest };
    // The progress sink is bookkeeping, never data: kept OFF the enumerable shape, so a job that is
    // copied, serialised or cloned (IPC) never carries a function. What is recorded goes through persistedJob.
    Object.defineProperty(job, "onProgress", { value: typeof onProgress === "function" ? onProgress : null, enumerable: false, writable: true, configurable: true });
    return job;
  },
  // The part of a preparation job that is RECORDED (a summary card's meta, a synthesized seed's meta) and
  // returned to callers: plain numbers and the kind — safe to persist and to clone over IPC.
  persistedJob(job) {
    if (!job) return null;
    return { calls: job.calls || 0, input_tokens: job.input_tokens || 0, output_tokens: job.output_tokens || 0, ms: job.ms || 0, kind: job.kind || "summary", cached: !!job.cached, fallback: !!job.fallback, memorySource: job.memorySource || "", inputBytes: job.inputBytes || 0, ...(job.compact ? { compact: true, excerpt: job.excerpt || null } : {}) };
  },

  /* ---- ONE preparation per session at a time ----
   * The digest, a transfer and a synthesis all condense the SAME record from the same cached
   * checkpoints. Run side by side they each summarised the same span (four low-effort CLIs over
   * one conversation, observed 2026-09-16); serialised, the second waits for the first — the wait
   * itself is cancellable and bounded by the job's total deadline — and then re-plans from the
   * cache, which by then covers what the first produced.
   * Every preparation on a session is registered until IT settles, running or waiting: a waiter
   * that is cancelled leaves the ones ahead of it registered, so a third request still queues
   * behind the running one instead of overlapping it. Each has its own controller, so Stop on the
   * session (cancelPreparations) ends all of them at once — the digest too, which has no runner.
   * `fn` receives the preparation's signal (the caller's Stop OR the session's) and must pass it to
   * every model call. `preparationOf(sessionId)` tells the UI what is being prepared. */
  async withPreparation(session, { signal, kind, label, job } = {}, fn) {
    if (!this._preparations) this._preparations = new Map();
    const key = session.id;
    let rec = this._preparations.get(key);
    if (!rec) { rec = { tail: Promise.resolve(), entries: [] }; this._preparations.set(key, rec); }
    const ctl = new AbortController();
    const onAbort = () => { try { ctl.abort(); } catch { /* */ } };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
    const prev = rec.entries.length ? rec.tail : null;
    let release; const mine = new Promise((res) => { release = res; });
    const entry = { kind: kind || "summary", label: label || "", waiting: !!prev, since: Date.now(), ctl, job: job || null };
    // The user's turn comes first: a BACKGROUND digest that holds the session's lock is cancelled
    // (its finished checkpoints stay and the turn's preparation resumes from them) instead of making
    // the turn wait behind it. A digest that arrives while a turn prepares simply queues.
    if (entry.kind !== "digest") for (const e of rec.entries) if (e.kind === "digest" && !e.waiting && !e.ctl.signal.aborted) { try { e.ctl.abort(); } catch { /* */ } }
    rec.tail = rec.tail.then(() => mine, () => mine);
    rec.entries.push(entry);
    try {
      if (prev) await raceDeadline(raceAbort(prev, ctl.signal, "Cancelled while waiting for another summary of this conversation"), job);
      entry.waiting = false;
      if (ctl.signal.aborted) throw abortError("Cancelled before summarising");
      if (remainingMs(job) <= 0) throw preparationTimeoutError(job);
      return await fn(ctl.signal);
    } finally {
      release();
      if (signal) signal.removeEventListener("abort", onAbort);
      const i = rec.entries.indexOf(entry); if (i >= 0) rec.entries.splice(i, 1);
      if (!rec.entries.length && this._preparations.get(key) === rec) this._preparations.delete(key);
    }
  },
  // Stop (or delete) on a session: every preparation registered for it — running or waiting, with
  // or without a runner — is cancelled now. Returns how many were.
  cancelPreparations(sessionId) {
    const rec = this._preparations && this._preparations.get(sessionId);
    if (!rec || !rec.entries.length) return 0;
    let n = 0;
    for (const e of rec.entries.slice()) { if (!e.ctl.signal.aborted) { n++; try { e.ctl.abort(); } catch { /* */ } } }
    return n;
  },
  preparationOf(sessionId) {
    const rec = this._preparations && this._preparations.get(sessionId);
    if (!rec || !rec.entries.length) return null;
    const e = rec.entries.find((x) => !x.waiting) || rec.entries[0];
    return { kind: e.kind, label: e.label, waiting: e.waiting, since: e.since, queued: rec.entries.filter((x) => x.waiting).length };
  },

  /* Reuse a known summary at once. A background digest may refresh it from a bounded selection
   * of new evidence; foreground preparation never walks a catch-up chain. Cold preparation gets
   * at most one short call and falls back to labelled source excerpts on failure. */
  async summarizeRecord(session, provider, model, plan, { signal: outerSignal, job } = {}) {
    const from = plan.head.from, upTo = plan.head.to;
    job = job || this.preparationJob(session, "summary");
    const report = (label, info = {}) => { if (typeof job.onProgress === "function") { try { job.onProgress(label, { ...info, calls: job.calls || 0 }); } catch { /* optional */ } } };
    const use = (cached) => {
      job.cached = true; job.summaryThrough = cached.upTo;
      job.memoryKind = cached.deterministic ? "local" : "summary"; job.memorySource = "cached";
      report(`Reusing saved working memory through entry ${fmtN(cached.upTo)}; selecting recent evidence locally`, { phase: "done" });
      return packet.excerpt(cached.text, 10000);
    };
    const quick = history.cachedSummary(session, from, upTo);
    if (outerSignal && outerSignal.aborted) throw abortError("Cancelled before preparing context");
    if (quick && (job.kind !== "digest" || quick.upTo >= upTo)) return use(quick);
    if (this._preparations && this._preparations.get(session.id)) report("Waiting for another preparation of this conversation", { phase: "waiting" });
    try { return await this.withPreparation(session, { signal: outerSignal, kind: job.kind, job }, async (signal) => {
      const cached = history.cachedSummary(session, from, upTo);
      if (cached && (job.kind !== "digest" || cached.upTo >= upTo)) return use(cached);
      const all = plan.msgs.slice(0, plan.headCount);
      const newer = cached ? all.filter((x) => x.g > cached.upTo) : all;
      const input = packet.summarizerInput(session, newer, { from: cached ? cached.upTo : from, to: upTo, previous: cached ? cached.text : "", query: job.query || "" });
      job.compact = true; job.maxCalls = 1; job.inputBytes = packet.bytes(input.text);
      job.summaryThrough = upTo; job.memoryKind = "summary"; job.memorySource = "model";
      job.excerpt = { entries: all.length, selected: input.selection.length };
      report(`Preparing working memory from ${fmtN(input.selection.length)} selected entries — at most one model call`, { phase: "call", entries: all.length, selected: input.selection.length });
      let summary;
      try {
        summary = String(await this.summarizeText(session, provider, model, input.text, { signal, job }) || "").trim();
        if (!summary) throw new Error("The summary model returned no text");
      } catch (e) {
        if (signal.aborted || (outerSignal && outerSignal.aborted) || (e && e.name === "AbortError")) throw abortError("Cancelled while preparing context");
        job.memoryKind = "local"; job.memorySource = "local"; job.fallback = true;
        const local = packet.selectEvidence(all, 9000, { query: job.query || "" });
        summary = "[Selected source excerpts; no model summary was available. Omitted details remain in the source record.]\n\n" + local.text;
        report("Using saved source excerpts; continuing without waiting for a summary", { phase: "fallback" });
      }
      if (signal.aborted || (outerSignal && outerSignal.aborted)) throw abortError("Cancelled while preparing context");
      summary = packet.excerpt(summary, 10000);
      history.rememberSummary(session, { from, upTo, text: summary, provider, model: model || "", ts: store.nowISO(), entries: all.length, calls: job.calls || 0, compact: true, inputMode: "selected", deterministic: job.memoryKind === "local", selection: input.selection, packetVersion: 1 });
      report(`Working memory ready from ${fmtN(all.length)} source entries (${fmtN(job.calls || 0)} model calls)`, { phase: "done" });
      return summary;
    }); } catch (e) {
      if ((outerSignal && outerSignal.aborted) || (e && e.name === "AbortError")) throw e;
      if (!e || !e.preparationTimeout) throw e;
      // A queued preparation can exhaust its deadline before it acquires the lock. Do not
      // launch another model call or turn that queue delay into a failed user request.
      job.summaryThrough = upTo; job.memoryKind = "local"; job.memorySource = "local"; job.fallback = true;
      report("Using selected source excerpts after the preparation wait", { phase: "fallback" });
      return packet.selectEvidence(plan.msgs.slice(0, plan.headCount), 9000, { query: job.query || "" }).text;
    }
  },

  // One summarisation request on the same provider (tests inject a fake via setSummarizer).
  setSummarizer(fn) { this._summarizer = fn || null; },

  /* One summarisation request on the same provider. Its usage is charged to the session's totals
   * and to the preparation `job` (calls / tokens / ms) so separate summary calls are never
   * invisible. BOUNDED: the job's call cap (job.maxCalls, else settings.summaryMaxCalls) ends a
   * runaway preparation with a clear error, and a call that does not answer within
   * settings.summaryCallTimeoutMs is cancelled (its CLI process ended). Tests inject a fake via
   * setSummarizer; the fake goes through the same bounds. */
  async summarizeText(session, provider, model, prompt, { signal, job } = {}) {
    if (signal && signal.aborted) throw abortError("Cancelled before summarising");
    const settings = store.getSettings(session.cwd);
    const maxCalls = (job && job.maxCalls > 0) ? job.maxCalls : (+settings.summaryMaxCalls > 0 ? +settings.summaryMaxCalls : SUMMARY_MAX_CALLS);
    if (job && (job.calls || 0) >= maxCalls) {
      const e = new Error(`Preparing the conversation summary stopped after ${fmtN(job.calls)} model call${job.calls === 1 ? "" : "s"} — the limit for one preparation. Every finished step is a cached checkpoint, so sending again continues from where this stopped.`);
      e.name = "SummaryBudgetError"; e.summaryBudget = true; throw e;
    }
    // The call's own bound, and the preparation's TOTAL deadline (the wait for the lock counted):
    // whichever is nearer ends this call; an already-expired total never starts another call.
    const callTimeoutMs = Math.min(SUMMARY_CALL_TIMEOUT_MS, +settings.summaryCallTimeoutMs > 0 ? +settings.summaryCallTimeoutMs : SUMMARY_CALL_TIMEOUT_MS);
    const left = remainingMs(job);
    if (left <= 0) throw preparationTimeoutError(job);
    const totalHit = left < callTimeoutMs;
    const timeoutMs = totalHit ? Math.max(1, Math.ceil(left)) : callTimeoutMs;
    const t0 = Date.now();
    // Count every attempted call once, including failure or cancellation.
    let charged = false;
    const charge = (u, { failed = false } = {}) => {
      if (charged) return;
      charged = true;
      if (job) { job.calls = (job.calls || 0) + 1; job.ms = (job.ms || 0) + (Date.now() - t0); }
      if (!u) return;
      const inT = (u.input_tokens || 0) + (provider === "openai" ? 0 : (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
      const outT = u.output_tokens || 0;
      session.totalTokensIn = (session.totalTokensIn || 0) + inT; session.totalTokensOut = (session.totalTokensOut || 0) + outT;
      if (job) { job.input_tokens = (job.input_tokens || 0) + inT; job.output_tokens = (job.output_tokens || 0) + outT; }
      store.scheduleWrite(session.id);
    };
    // One controller for this call: the caller's Stop and the call timeout both end it.
    const ctl = new AbortController();
    let timedOut = false;
    const onAbort = () => { try { ctl.abort(); } catch { /* */ } };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);
    const label = `summary call ${fmtN((job && job.calls || 0) + 1)}`;
    const timeoutError = () => { if (totalHit) return preparationTimeoutError(job); const e = new Error(`The summary model did not answer within ${fmtDuration(timeoutMs)} (${label}) — the request was cancelled. Every finished step is a cached checkpoint, so sending again continues from where this stopped.`); e.name = "TimeoutError"; e.timeout = true; return e; };
    try {
      if (this._summarizer) {
        const out = await raceAbort(this._summarizer(provider, model, prompt, { signal: ctl.signal }), ctl.signal, "Cancelled while summarising");
        charge(null); return out;
      }
      if (provider === "openai") {
        const codex = require("../providers/codex-exec"); const P = require("../providers/catalog");
        const res = await raceAbort(codex.run({ apiKey: settings.openaiApiKey || undefined, model, effort: P.openaiEffort("low", model), cwd: session.cwd, readOnly: true, signal: ctl.signal, promptText: SUMMARY_INSTRUCTIONS + "\n\n" + prompt }), ctl.signal, "Cancelled while summarising");
        charge(res && res.usage ? (res.usage.last || res.usage) : null);
        if (res && res.text) return res.text;
        throw new Error((res && res.error) || "Codex returned no summary");
      }
      if (provider === "anthropic") {
        let usage = null;
        const out = await this.runHeadlessAnthropic({ settings, model, thinking: "low", oneM: session.oneM, system: SUMMARY_INSTRUCTIONS, prompt, cwd: session.cwd, signal: ctl.signal, label, onResult: (r) => { usage = r && r.usage; } });
        charge(usage); return out;
      }
      if (provider === "custom") {
        const customApi = require("../providers/custom-api");
        const ep = customApi.getEndpoint(settings, model);
        const cfg = ep ? { endpoint: ep.endpoint, headers: ep.headers, payloadTemplate: ep.payloadTemplate, outputPath: ep.outputPath, apiKey: ep.apiKey, model: ep.model || ep.id || "" } : { endpoint: settings.customEndpoint, headers: settings.customHeaders, payloadTemplate: settings.customPayloadTemplate, outputPath: settings.customOutputPath, apiKey: settings.customApiKey, model: model || "" };
        const r = await raceAbort(customApi.call({ ...cfg, prompt, system: SUMMARY_INSTRUCTIONS, signal: ctl.signal }), ctl.signal, "Cancelled while summarising");
        charge(r && r.usage ? r.usage : null);
        if (r && r.ok && r.text) return r.text;
        throw new Error((r && r.error) || "The custom endpoint returned no summary");
      }
      const council = require("../providers/council");
      const r = await raceAbort(council.reviewerRun(provider, model, SUMMARY_INSTRUCTIONS + "\n\n" + prompt), ctl.signal, "Cancelled while summarising");
      charge(null);
      if (r && r.ok && r.text) return r.text;
      throw new Error((r && r.error) || "no summary");
    } catch (e) {
      if (timedOut) { charge(null, { failed: true }); throw timeoutError(); }   // the failed call counts against the bound, not as progress
      charge(null, { failed: true });
      if (signal && signal.aborted) throw abortError("Cancelled while summarising");
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  },
};

module.exports = { methods, SUMMARY_INSTRUCTIONS, SYNTH_SEED_CHARS, SUMMARY_CALL_TIMEOUT_MS, SUMMARY_MAX_CALLS, PREPARATION_TIMEOUT_MS };
