"use strict";
/* Run control: stop (graceful-first, process-tree kill as the fallback), steer a running turn,
 * external cancellable tasks, quit handling, and the live-query control requests (context usage,
 * MCP status, rewind, live model / permission-mode changes). */
const path = require("path");
const store = require("../storage/store");
const auth = require("../auth/cli-auth");
const attachmentsStore = require("../storage/attachments");
const { newRunId } = require("./tools");

const methods = {
  // A stopped run may still be winding down (graceful interrupt): the next run on the same session
  // waits for it (bounded) so two CLI processes never work the same native session at once.
  async awaitDrain(sessionId) {
    const d = this.draining.get(sessionId);
    if (!d) return;
    await Promise.race([d, new Promise((res) => setTimeout(res, this.interruptGraceMs + 1500))]);
    if (this.draining.get(sessionId) === d) this.draining.delete(sessionId);
  },

  /*
   * Stop the current turn. reason "stop" = user pressed stop; "replace" = user
   * sent a new message that should run next.
   */
  async interrupt(sessionId, reason = "stop") {
    const r = this.runners.get(sessionId);
    const sess = store.getSession(sessionId);
    if (sess) sess._interruptRequested = true;
    // Every preparation registered for this session — a transfer, a synthesis, the background digest
    // (which has no runner) — is cancelled NOW, running or waiting: Stop stops paid summary work and
    // frees the summary lock for the next turn.
    const cancelledPreparations = this.cancelPreparations ? this.cancelPreparations(sessionId) : 0;
    // Stopping an ORCHESTRATOR stops the orchestrator's TURN only (user decision 2026-09-17): its delegated jobs — the
    // Coder / Reviewer / Tester tabs with their sub-agents, command runs — keep running and keep their
    // state; the next orchestrator turn picks their results up (`atomnano jobs` / `wait`). Ending every job is
    // an explicit action: the studio's "Stop all jobs" / `atomnano stop --all` (stopJobsOf).
    const liveJobs = reason === "stop" && sess && !sess.role && typeof this.liveJobCount === "function" ? this.liveJobCount(sessionId) : 0;
    const jobsNote = () => { if (liveJobs && sess) this.addMessage(sess, { id: store.uid(), role: "system", text: `${liveJobs} delegated job${liveJobs === 1 ? " keeps" : "s keep"} running with ${liveJobs === 1 ? "its" : "their"} sub-agents — the next turn can pick up the results (atomnano jobs). Use "Stop all jobs" in the Workflow studio to end them.`, ts: store.nowISO() }); };
    if (!r) {
      const session = sess;
      if (session && (session._pendingRetry || session.pendingRun || session.status === "ratelimited" || session.status === "auth-expired" || session.status === "offline")) {
        this.cancelScheduledRetry(sessionId);
        delete session._pendingRetry; session._retryAttempt = 0;
        if (session.pendingRun) session.pendingRun = null;
        store.updateSession(sessionId, { status: "idle", pendingRun: null });
        this.send("session:status", { sessionId, status: "idle" });
        return true;
      }
      // Nothing runs, yet agents of an ended run may still show as running (a paused run, a restart):
      // Stop ends them — the user asked for exactly that.
      const staleAgents = session && this.reconcileAgents ? this.reconcileAgents(session) : 0;
      if (session && session.status === "running") {
        store.updateSession(sessionId, { status: "idle" });
        this.send("session:partial-reset", { sessionId });
        this.send("session:status", { sessionId, status: "idle" });
        jobsNote();
        return true;
      }
      jobsNote();
      return cancelledPreparations > 0 || staleAgents > 0 || liveJobs > 0;   // a background digest, stale agents or live jobs were the only work
    }
    r.interrupted = true;
    r.interruptReason = reason;
    this.send("session:partial-reset", { sessionId });
    // An EXTERNAL task (image generation, a synthesis being prepared): its signal is aborted at once
    // and the slot is released NOW — the tab is idle and can take a new message immediately. The
    // task's own unregister() then returns false (it no longer owns the slot), so its completion
    // never overwrites the status a newer run may have set meanwhile.
    if (r._external) {
      r.running = false;
      try { r.abortController.abort(); } catch { /* ignore */ }
      if (this.runners.get(sessionId) === r) this.runners.delete(sessionId);
      if (r._live) { r._live = null; this.send("session:live", { sessionId, live: null }); }
      if (sess) store.updateSession(sessionId, { status: "idle" });
      this.send("session:status", { sessionId, status: "idle" });
      return true;
    }
    // Graceful first: the harness ends the turn itself (the running tool is cancelled and the shell
    // processes it started are killed by the CLI); the input stream is then released so the process
    // exits once its final result is out. Only a turn that has not wound down by the grace period
    // has its transport torn down — and then the whole CLI process tree, so nothing keeps running.
    // (Aborting FIRST used to kill the CLI before the interrupt could reach it, leaving the command
    // it was running alive on Windows.) A run still in SETUP (no query yet — reviewers, planner,
    // record transfer) has nothing to wind down: its signal is aborted at once, which ends any
    // summary preparation it started, and the setup sees the stop before dispatching.
    const graceful = !!(r.query && typeof r.query.interrupt === "function") && !r.abortController.signal.aborted;
    if (graceful) Promise.resolve(r.query.interrupt()).catch(() => {});
    if (r.releaseInput) r.releaseInput();
    const hardStop = () => { if (r.ended) return; try { r.abortController.abort(); } catch { /* ignore */ } this.killProcessTree(r); };
    if (graceful) r._graceTimer = setTimeout(hardStop, this.interruptGraceMs); else hardStop();
    if (r.done) this.draining.set(sessionId, r.done);
    r.running = false;
    if (this.runners.get(sessionId) === r) this.runners.delete(sessionId);
    if (r.live && (r.live.status || r.live.label)) { r.live = null; this.send("session:live", { sessionId, live: null }); }
    if (sess) { try { this.finalizeRun(sess, r, { aborted: true }); } catch { /* status event below still fires */ } }
    jobsNote();
    this.send("session:status", { sessionId, status: "idle" });
    return true;
  },

  interruptAll() { for (const id of this.runners.keys()) this.interrupt(id, "stop"); },

  /*
   * Steer the RUNNING turn with a new user message instead of stopping it — Codex
   * app-server `turn/steer`. Only a live Codex turn is steerable; anything else
   * returns { steered:false } and the renderer falls back to interrupt + run. The
   * exact text goes in; attachments are persisted and passed as native inputs.
   */
  async steer(sessionId, { text, attachments } = {}) {
    const r = this.runners.get(sessionId);
    const session = store.getSession(sessionId);
    if (!session || !r || !r.running || r._external) return { steered: false, reason: "no steerable turn" };
    if (r.interrupted || session._interruptRequested) return { steered: false, reason: "turn is stopping" };
    let atts = Array.isArray(attachments) ? attachments : [];
    if (!String(text || "").trim() && !atts.length) return { steered: false, reason: "empty" };
    // Claude with background agents / tasks alive: the message joins the LIVE process as its next
    // turn (the CLI runs it after the current step) — nothing is interrupted, the agents keep working.
    // Without background work Enter keeps its "interrupt and run now" meaning (the renderer falls back).
    if (!r.codex && r.feed) {
      const busy = !!((r.activeTasks && r.activeTasks.size > 0) || r.awaitingTasks);
      if (!busy) return { steered: false, reason: "no background work — interrupt path" };
      if (r.feed.closed) return { steered: false, reason: "input already ended" };
      try { atts = attachmentsStore.persistAll(atts); } catch (e) { return { steered: false, reason: "attachment store failed: " + ((e && e.message) || e) }; }
      // A new turn is coming: no pending release / idle timer may end the input before the CLI has it.
      if (r._releaseTimer) { clearTimeout(r._releaseTimer); r._releaseTimer = null; }
      if (r._taskIdle) { clearTimeout(r._taskIdle); r._taskIdle = null; }
      if (!r.feed.push(this.promptMessage(text || "", atts, session))) return { steered: false, reason: "input already ended" };
      this.addMessage(session, { id: store.uid(), role: "user", text, ts: store.nowISO(), attachments: attachmentsStore.light(atts), steered: true });
      return { steered: true, mode: "queued" };
    }
    if (!r.codex || !r.query || typeof r.query.steer !== "function") return { steered: false, reason: "no steerable turn" };
    try { atts = attachmentsStore.persistAll(atts); } catch (e) { return { steered: false, reason: "attachment store failed: " + ((e && e.message) || e) }; }
    const files = atts.filter((a) => a.kind !== "image" && a.path).map((a) => ({ path: a.path, name: a.name }));
    const images = atts.filter((a) => a.kind === "image" && a.path).map((a) => ({ path: a.path }));
    let res;
    try { res = await r.query.steer(text || "", images, files); } catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
    if (!res || !res.ok) return { steered: false, reason: (res && res.error) || "steer failed" };
    this.addMessage(session, { id: store.uid(), role: "user", text, ts: store.nowISO(), attachments: attachmentsStore.light(atts), steered: true });
    return { steered: true };
  },

  /* Register a cancellable EXTERNAL task (image generation, a synthesis being prepared) as the
   * session's runner, so Stop reaches it through the same path as a turn. Returns null while the
   * tab is busy. The handle:
   *   signal          aborted by Stop (and by the task itself never) — pass it to every model call
   *   isAborted()     true once Stop happened
   *   owns()          true while THIS task still holds the slot (Stop releases it immediately)
   *   progress(label) honest live status for the tab (session:live { status:"preparing", label });
   *                   ignored — returns false — once the task no longer owns the slot
   *   unregister()    releases the slot; returns TRUE only when it removed its own runner. FALSE
   *                   means Stop already released it (and set the tab idle) or a newer run owns the
   *                   slot: the caller must then leave the tab's status alone. */
  registerExternalRunner(sessionId, opts = {}) {
    if (this.isRunning(sessionId)) return null;
    const abortController = new AbortController();
    const label = String(opts.label || "");
    const runner = { id: newRunId(), running: true, abortController, query: null, promptText: label, label, _external: true, startedAt: Date.now() };
    this.runners.set(sessionId, runner);
    const owns = () => this.runners.get(sessionId) === runner;
    const isAborted = () => !!runner.interrupted || abortController.signal.aborted;
    return {
      id: runner.id,
      signal: abortController.signal,
      isAborted, owns,
      progress: (text) => {
        if (!owns() || isAborted() || !runner.running) return false;
        runner._live = { status: "preparing", label: String(text || label || "Preparing…") };
        this.send("session:live", { sessionId, live: runner._live });
        return true;
      },
      unregister: () => {
        const owned = owns();
        runner.running = false;
        if (owned) {
          this.runners.delete(sessionId);
          if (runner._live) { runner._live = null; this.send("session:live", { sessionId, live: null }); }
        }
        return owned;
      },
    };
  },

  /* ---- Run ownership for a turn that is still being SET UP ----
   * run() reserves the session's slot BEFORE its asynchronous preparation (reviewers, planner,
   * SDK load, record transfer), so a second send is refused at once and Stop during setup reaches
   * the reservation's signal. The provider runner then CLAIMS the reservation — the same object, so
   * a stop that already happened is seen — or gets null and must not start. */
  reserveRun(sessionId, { text, provider } = {}) {
    const abortController = new AbortController();
    const runner = { id: newRunId(), running: true, setup: true, abortController, query: null, promptText: text || "", provider: provider || "" };
    runner.done = new Promise((res) => { runner._resolveDone = res; });
    this.runners.set(sessionId, runner);
    // The session's latest run GENERATION, kept after the run ends: a measurement from an older run
    // that arrives once a newer run has finished is recognised as stale (transfer.js measurementCurrent).
    (this._lastRunId || (this._lastRunId = new Map())).set(sessionId, runner.id);
    return runner;
  },
  claimRun(sessionId, reservation, fields = {}) {
    if (!reservation) { const r = this.reserveRun(sessionId, {}); Object.assign(r, fields); r.setup = false; return r; }
    // Stopped (or replaced) during setup: nothing starts; the reservation's drain promise settles now.
    if (reservation.interrupted || reservation.abortController.signal.aborted || this.runners.get(sessionId) !== reservation) { this.releaseRun(sessionId, reservation); return null; }
    Object.assign(reservation, fields);
    reservation.setup = false;
    return reservation;
  },
  // A run that ends before (or without) dispatching frees its slot; only the owner may clear the registry.
  releaseRun(sessionId, runner) {
    if (!runner) return;
    runner.running = false; runner.ended = true;
    if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId);
    if (runner.done && this.draining.get(sessionId) === runner.done) this.draining.delete(sessionId);
    if (runner._resolveDone) runner._resolveDone();
  },
  setupStopped(runner) { return !!(runner && (runner.interrupted || (runner.abortController && runner.abortController.signal.aborted))); },

  // Called on app quit: leave a clear marker in any session that was mid-run, and end what the run
  // left in flight (tool cards, sub-agents) — nothing survives the process, so nothing may be
  // persisted as "running" (the record used to reopen with agents running for hours, 2026-09-17).
  markInterruptedOnQuit() {
    for (const [id, r] of this.runners.entries()) {
      if (!r || !r.running) continue;
      try {
        const s = store.getSession(id);
        if (s) {
          s.messages.push({ id: store.uid(), role: "system", text: "The run was interrupted because AtomNano closed.", ts: store.nowISO() });
          if (this.settleRunLeftovers) this.settleRunLeftovers(s, r, { status: "interrupted", note: "AtomNano was closed before this finished." });
          store.enforceCap(s);
          s.status = "idle";
          store.flush(id);
        }
      } catch { /* best effort on quit */ }
    }
  },

  // The live Query object for a running turn, or null.
  _liveQuery(id) { const r = this.runners.get(id); return r && r.running && r.query ? r.query : null; },

  /* Live context meter. Claude: the SDK's control response with `detail: "summary"` (answered
   * from the last response's usage — polling never triggers per-category token-count calls).
   * Codex: the app-server's own token usage for the running turn (input includes cached tokens ≈ active
   * context, its reported context window as the limit), marked as an estimate. */
  async contextUsage(id) {
    const r = this.runners.get(id);
    const q = this._liveQuery(id);
    if (q && q.getContextUsage) { try { return await q.getContextUsage({ detail: "summary" }); } catch { return null; } }
    if (r && r.running && r.codex && r.usage) {
      const u = r.usage.last || r.usage;
      // Codex cache reads/writes are subsets of input_tokens, not extra context.
      const total = u.input_tokens || 0;
      const max = r.usage.context_window || null;
      if (!total) return null;
      return { totalTokens: total, maxTokens: max, percentage: max ? Math.min(100, Math.round((total / max) * 100)) : null, provider: "openai", estimate: true };
    }
    return null;
  },

  async mcpStatus(id) { const q = this._liveQuery(id); if (!q || !q.mcpServerStatus) return null; try { return await q.mcpServerStatus(); } catch { return null; } },

  async rewindFiles(id, userMessageId) {
    const q = this._liveQuery(id);
    if (!q || !q.rewindFiles) return { ok: false, detail: "Rewind needs a running turn — file checkpoints live in the active session." };
    try { const r = await q.rewindFiles(userMessageId); return { ok: true, result: r || null }; }
    catch (e) { return { ok: false, detail: String((e && e.message) || e) }; }
  },

  async setModelLive(id, model) { const q = this._liveQuery(id); if (!q || !q.setModel) return false; try { await q.setModel(model || undefined); return true; } catch { return false; } },

  async setPermissionModeLive(id, mode) {
    const sess = store.getSession(id); if (sess && mode) { sess.permissionMode = mode; store.scheduleWrite(id); }
    const q = this._liveQuery(id); if (!q || !q.setPermissionMode) return !!(sess && this.runners.get(id) && this.runners.get(id).codex);
    try { await q.setPermissionMode(mode); return true; } catch { return false; }
  },
};

module.exports = { methods };
