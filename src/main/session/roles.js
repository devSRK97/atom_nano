"use strict";
/* Explicit user workflows around the primary turn: the Council (reviewers consulted before /
 * reviewing after, via their own CLIs — council.js) and the Planner role (Plan → Code). Both
 * receive the exact conversation record and produce their own visible cards; their output
 * travels to the primary model as labelled data AFTER the user's text, never as instructions. */
const store = require("../storage/store");
const history = require("../storage/history");

const methods = {
  // The conversation BEFORE the current prompt for a reviewer / planner: exact when it fits
  // that model's window, otherwise the same budgeted transfer the primary would get.
  async recentExchange(session, provider, model, promptIndex, signal) {
    const to = (Number.isFinite(promptIndex) ? promptIndex : history.lastGlobalIndex(session)) - 1;
    const tb = await this.transferBlock(session, provider || "anthropic", { model, from: -1, to, label: "The reviewer", signal });
    return tb.text;
  },

  // `signal` (the run's reservation) ends the consultation — including any record summary it
  // prepares — the moment the user presses Stop.
  async consultReviewers(session, reviewers, prompt, promptMessageId, signal) {
    const council = require("../providers/council");
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    this.addMessage(session, { id: store.uid(), role: "system", text: `Consulting ${reviewers.length} reviewer${reviewers.length > 1 ? "s" : ""} before answering…`, ts: store.nowISO() });
    const out = [];
    for (const rv of reviewers) {
      if (signal && signal.aborted) break;
      const ctx = await this.recentExchange(session, rv.provider, rv.model, promptIndex, signal);
      if (signal && signal.aborted) break;
      const cprompt = `${ctx ? `${ctx}\n\n` : ""}The user now asks the assistant:\n"""${prompt || "(continue)"}"""\n\nIn 2–5 sentences, give concrete advice on how to answer this — key considerations or a better approach. If the request refers to earlier content, use the conversation above. Do NOT reply to the user yourself.`;
      const r = await council.reviewerRun(rv.provider, rv.model, cprompt);
      if (signal && signal.aborted) break;
      this.addMessage(session, { id: store.uid(), role: "reviewer", reviewProvider: rv.provider, reviewModel: rv.model, reviewKind: "consult", asked: cprompt, text: r.ok ? r.text : `(no response — ${r.error || "failed"})`, ts: store.nowISO() });
      if (r.ok && r.text) out.push(`${council.label(rv.provider, rv.model)} advises:\n${r.text}`);
    }
    return out.length ? "Advice from the reviewers the user configured (weigh it, then answer yourself):\n\n" + out.join("\n\n") : "";
  },

  async reviewAfter(session, reviewers, prompt, promptMessageId) {
    const answer = this.lastAssistantText(session);
    if (!answer) return;
    const council = require("../providers/council");
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    // The review holds the slot as an external task: Stop ends it, a new message is refused
    // meanwhile, and its completion never overwrites a newer run's status. When the slot is already
    // taken (the user sent the next message before the review could begin) the review is skipped —
    // it must never run beside a live turn, unowned and uncancellable.
    const ext = this.registerExternalRunner(session.id, { label: "[reviewers]" });
    if (!ext) { this.addMessage(session, { id: store.uid(), role: "system", text: "Reviewers were not consulted about this answer — a new message was already running.", ts: store.nowISO() }); return; }
    this.addMessage(session, { id: store.uid(), role: "system", text: `Handing the answer to ${reviewers.length} reviewer${reviewers.length > 1 ? "s" : ""} for review…`, ts: store.nowISO() });
    const signal = ext.signal;
    store.updateSession(session.id, { status: "running" }); this.send("session:status", { sessionId: session.id, status: "running" });
    try {
      for (const rv of reviewers) {
        if (signal && signal.aborted) break;
        const ctx = await this.recentExchange(session, rv.provider, rv.model, promptIndex, signal);
        if (signal && signal.aborted) break;
        const rprompt = `${ctx ? `${ctx}\n\n` : ""}A user asked:\n"""${prompt}"""\n\nAnother AI proposed this answer:\n"""${answer}"""\n\nIn 2–6 sentences review it: correctness, gaps, risks and concrete improvements. Be specific.`;
        const r = await council.reviewerRun(rv.provider, rv.model, rprompt);
        if (signal && signal.aborted) break;
        this.addMessage(session, { id: store.uid(), role: "reviewer", reviewProvider: rv.provider, reviewModel: rv.model, reviewKind: "review", asked: rprompt, text: r.ok ? r.text : `(no response — ${r.error || "failed"})`, ts: store.nowISO() });
      }
    } catch (e) {
      if (!ext.isAborted()) throw e;
    } finally {
      // Only the task that still owns the slot may set the status (Stop released it and set idle).
      const owned = ext.unregister();
      if (owned) { store.updateSession(session.id, { status: "done" }); this.send("session:status", { sessionId: session.id, status: "done" }); }
    }
  },

  /* ROLE PIPELINE — Planner (explicit user configuration). Drafts an implementation
   * plan with its own provider/model/effort, streamed to the tab as its own card,
   * from the EXACT conversation record. Never touches the session's thread bindings. */
  async runPlanner(sessionId, session, { userText, planner, settings, promptMessageId, reservation }) {
    const providers = require("../providers/catalog");
    const provider = planner.provider || (settings.llmProvider || "anthropic");
    const pcat = providers.get(provider);
    let model = (planner.model || "").trim() || pcat.defaultModel || "";
    let effort = (planner.effort || "").trim() || pcat.defaultReasoning || "high";
    if (provider === "openai") {
      const rs = providers.resolveOpenAIModelStrict(model); if (rs.error) throw new Error(rs.error); model = rs.model;
      const re = providers.openaiEffortStrict(effort, model); if (re.error) throw new Error(re.error); effort = re.effort;
    }
    const sys = "You are the PLANNER in a two-role pipeline (Planner → Coder). Read the request and the conversation so far, then write a concise, actionable implementation plan the Coder will follow: numbered steps, the files/areas to touch, key decisions, and edge cases to handle. Do NOT write the implementation yourself — plan only.";
    // Inside a turn the planner runs under the turn's RESERVATION (its signal is the run's Stop);
    // called on its own it holds the slot as an external task — and never runs without one.
    const ext = reservation
      ? { signal: reservation.abortController.signal, isAborted: () => this.setupStopped(reservation), owns: () => this.runners.get(sessionId) === reservation, unregister: () => true }
      : this.registerExternalRunner(sessionId, { label: "[planner]" });
    if (!ext) return { plan: "", aborted: true };
    const signal = ext.signal;
    // Live-stream emissions belong to the run that owns the slot: once Stop released it (or a newer
    // run took it) the planner's late deltas and its final reset must not touch the tab's stream.
    const owns = () => ext.owns() && !ext.isAborted();
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    const record = await this.transferBlock(session, provider, { model, from: -1, to: promptIndex - 1, promptChars: sys.length + (userText || "").length + 200, label: "The Planner", signal });
    if (!owns()) { if (!reservation) ext.unregister(); return { plan: "", aborted: true }; }
    if (record.count && record.mode !== "exact") this.addMessage(session, { id: store.uid(), role: "system", text: record.note, ts: store.nowISO() });
    const prompt = (record.text ? record.text + "\n\n----\n\n" : "") + "User request:\n" + (userText || "") + "\n\nWrite the implementation plan now.";

    const meta = this.replyMeta(provider, model, effort, null, null);
    meta.role = "planner";
    this.addMessage(session, { id: store.uid(), role: "system", text: `Planning with ${pcat.label} · ${model || "default"}…`, ts: store.nowISO() });
    this.send("session:partial-reset", { sessionId });
    let plan = "", lostSlot = false;
    const onDelta = (d) => { if (!d || !owns()) return; plan += d; this.send("session:partial", { sessionId, index: 0, kind: "text", delta: d }); };
    try {
      if (provider === "openai") {
        const codex = require("../providers/codex-exec");
        const res = await codex.run({ apiKey: settings.openaiApiKey || undefined, model, effort, cwd: session.cwd, readOnly: true, signal, promptText: sys + "\n\n" + prompt, on: { onTextDelta: onDelta } });
        if (res && res.text && owns()) plan = res.text;
        if (!plan && res && res.error && !res.aborted && owns()) throw new Error(res.error);
      } else if (provider === "anthropic") {
        const out = await this.runHeadlessAnthropic({ settings, model, thinking: effort, system: sys, prompt, cwd: session.cwd, stream: true, onText: onDelta, signal });
        if (owns()) plan = out;
      } else {
        const council = require("../providers/council");
        const r = await council.reviewerRun(provider, model, sys + "\n\n" + prompt, { effort });
        if (r && r.ok && r.text && owns()) { plan = r.text; this.send("session:partial", { sessionId, index: 0, kind: "text", delta: plan }); }
        else if (r && !r.ok && owns()) throw new Error(r.error || "planner failed");
      }
    } catch (e) {
      if (owns()) throw e;
    } finally {
      lostSlot = !owns();
      if (!lostSlot) this.send("session:partial-reset", { sessionId });
      ext.unregister();
    }
    const aborted = ext.isAborted() || lostSlot;
    // A stopped (or superseded) planner yields no plan: what it streamed before the Stop is not
    // recorded as a card and never reaches the Coder.
    plan = aborted ? "" : (plan || "").trim();
    if (plan) this.addMessage(session, { id: store.uid(), role: "planner", text: plan, ts: store.nowISO(), meta });
    return { plan, aborted };
  },
};

module.exports = { methods };
