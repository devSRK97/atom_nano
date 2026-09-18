"use strict";
/* Custom raw-HTTP primary — a stateless endpoint: every request carries the exact conversation
 * record (system) plus the user's message; attached text files are inlined in full. */
const path = require("path");
const store = require("../storage/store");
const history = require("../storage/history");
const { isNetworkError, isRateLimitError } = require("./errors");

const methods = {
  /* --------------------------- Custom raw-HTTP primary ----------------------
   * A stateless HTTP API has no thread: every request carries the exact
   * conversation record (system) plus the user's message (prompt). Attached text
   * files are inlined in full; images are reported as unsupported by this transport.
   */
  async runCustomHttp(sessionId, session, { text, attachments, reviewers, reviewMode, background, fleet, extraSystem, roleBrief, promptMessageId, provider, workflowJob, reservation }, reviewerBeforeDigest, settings, endpoint) {
    // A workflow job's retry replays with the job's provider / brief; everything else here is the user's.
    const pendingPayload = () => ({ text, attachments, reviewers, reviewMode, background, fleet, extraSystem, resumeContinuation: true, promptMessageId, provider, roleBrief, workflowJob });
    const customApi = require("../providers/custom-api");
    const fs = require("fs");
    settings = settings || store.getSettings(session.cwd);
    const cfg = endpoint ? {
      endpoint: endpoint.endpoint, headers: endpoint.headers, payloadTemplate: endpoint.payloadTemplate,
      outputPath: endpoint.outputPath, apiKey: endpoint.apiKey, model: endpoint.model || endpoint.id || "",
      label: endpoint.name || endpoint.id,
    } : {
      endpoint: settings.customEndpoint, headers: settings.customHeaders, payloadTemplate: settings.customPayloadTemplate,
      outputPath: settings.customOutputPath, apiKey: settings.customApiKey, model: session.model || "",
      label: "Custom",
    };
    const model = cfg.model;
    const { digests: skillDigests, names: skillNames } = this.selectedSkillDigests(session);
    const atts = attachments || [];
    const fileAtts = atts.filter((a) => a.kind !== "image" && a.path);
    let filesText = "";
    if (fileAtts.length) {
      const parts = [];
      for (const f of fileAtts) {
        try { parts.push(`--- ${f.name || f.path} ---\n${fs.readFileSync(f.path, "utf8")}`); }
        catch (e) { parts.push(`--- ${f.name || f.path} --- (could not read: ${(e && e.code) || e})`); }
      }
      filesText = "\n\nAttached files:\n" + parts.join("\n\n");
    }
    const imageAtts = atts.filter((a) => a.kind === "image");
    if (imageAtts.length) this.addMessage(session, { id: store.uid(), role: "system", text: `${imageAtts.length} image attachment${imageAtts.length > 1 ? "s were" : " was"} not sent: this custom HTTP endpoint is configured as text-only.`, ts: store.nowISO() });
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    const promptText = (text || "") + filesText + this.workflowAppendix({ skillDigests, extraSystem, reviewerDigest: reviewerBeforeDigest, roleBrief });
    const ctxTokens = this.contextTokensFor("custom", model, session);
    if (promptText.length > ctxTokens * history.CHARS_PER_TOKEN * 0.9) { this.releaseRun(sessionId, reservation); return this.failRun(session, `Your message (with inlined files) is about ${Math.round(promptText.length / history.CHARS_PER_TOKEN).toLocaleString("en-US")} tokens — larger than the model's context window (${ctxTokens.toLocaleString("en-US")} tokens assumed for this endpoint). It was not sent. Split it, or attach less at once.`); }

    session._replyMeta = this.replyMeta("custom", model || "custom", session.thinking, reviewers, reviewMode);
    session._replyMeta.endpointName = cfg.label;
    // The run takes over the slot run() reserved (see control.js claimRun); null = stopped or
    // replaced during setup — the stop already recorded the outcome, nothing starts.
    const runner = this.claimRun(sessionId, reservation, { promptText: text || "", provider: "custom", model, promptIndex });
    if (!runner) return;
    const abortController = runner.abortController;
    const runId = runner.id;
    // This run may act on the session only while it still OWNS the slot and was not stopped: the
    // endpoint's late answer or error after Stop (or after a newer run took the slot) changes nothing.
    const stale = () => !!(runner.interrupted || abortController.signal.aborted || this.runners.get(sessionId) !== runner);
    const preparing = (label) => { if (!stale()) this.setLive(session, runner, { status: "preparing", label: label || "Preparing the conversation record" }); };
    const prepared = () => { if (runner.live && runner.live.status === "preparing") this.setLive(session, runner, { status: null, label: null }); };
    this._lastRun ={ sessionId, runId, sent: { provider: "custom", mode: "raw", model, endpointName: cfg.label, endpoint: cfg.endpoint, transferredEntries: 0, skills: skillNames, background: !!background, fleet: !!(fleet && fleet.taskId) }, init: null };

    try {
      // The conversation so far — the endpoint keeps no thread. Exact when it fits the model's
      // window; otherwise the budgeted transfer (its summary is cached, so later turns reuse it).
      // Prepared inside the run's lifecycle so a summariser failure ends the run cleanly.
      if (promptIndex > 0) preparing("Preparing the conversation record for the endpoint");
      const record = await this.transferBlock(session, "custom", { model, from: -1, to: promptIndex - 1, promptChars: promptText.length, signal: abortController.signal, label: "The endpoint", onProgress: preparing });
      if (stale()) { this.finalizeRun(session, runner, { aborted: true }); return; }   // Stop while the record was prepared: nothing is sent
      prepared();
      if (record.count && record.mode !== "exact") this.addMessage(session, { id: store.uid(), role: "system", text: record.note, ts: store.nowISO() });
      const systemText = record.text;
      this._lastRun.sent.transferredEntries = record.count; this._lastRun.sent.transferMode = record.mode;
      const r = await customApi.call({
        endpoint: cfg.endpoint, headers: cfg.headers,
        payloadTemplate: cfg.payloadTemplate, outputPath: cfg.outputPath,
        model, prompt: promptText, system: systemText, apiKey: cfg.apiKey, signal: abortController.signal,
      });
      // Stopped or replaced while the endpoint answered: the answer is NOT applied — no reply, no
      // status, no preserved retry (the stop recorded the turn).
      if (stale()) { this.finalizeRun(session, runner, { aborted: true }); return; }
      if (r.ok && r.text) {
        this.addMessage(session, { id: store.uid(), role: "assistant", text: r.text, ts: store.nowISO(), meta: session._replyMeta });
        store.scheduleWrite(sessionId);
        this.finalizeRun(session, runner, { aborted: false });
      } else if (r.aborted || runner.interrupted || abortController.signal.aborted) {
        this.finalizeRun(session, runner, { aborted: true });
      } else if (r.status === 429 || r.status === 529) {
        session._pendingRetry = pendingPayload();
        runner.running = false; if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId);
        this.scheduleRetry(sessionId, "ratelimited");
        return;
      } else {
        const detail = r.error || "no output";
        const hint = (r.candidates && r.candidates.length)
          ? "  Detected reply keys: " + r.candidates.slice(0, 5).map((c) => c.path).join(", ") + " — set one as the Output path in Settings → Providers → Custom."
          : "  Check the endpoint, headers, payload template and Output path in Settings → Providers → Custom.";
        this.addMessage(session, { id: store.uid(), role: "error", text: "Custom API run failed: " + detail + hint, ts: store.nowISO() });
        runner.failed = true;
        this.finalizeRun(session, runner, { aborted: false, failed: true });
      }
    } catch (e) {
      // An error from a run that was stopped or replaced meanwhile (a connection reset after Stop)
      // must never mark the tab offline, pause it or queue a retry of an abandoned prompt.
      if (stale()) { this.finalizeRun(session, runner, { aborted: true }); return; }
      console.error("[custom:run]", e);
      if (isNetworkError(e)) {
        session._pendingRetry = pendingPayload();
        store.updateSession(sessionId, { status: "offline" }); this.send("session:status", { sessionId, status: "offline" });
      } else if (isRateLimitError(e)) {
        session._pendingRetry = pendingPayload();
        this.scheduleRetry(sessionId, "ratelimited");
      } else {
        this.addMessage(session, { id: store.uid(), role: "error", text: "Custom API run failed: " + String((e && e.message) || e), ts: store.nowISO() });
        runner.failed = true;
        this.finalizeRun(session, runner, { aborted: false, failed: true });
      }
    } finally {
      runner.running = false; runner.ended = true;
      prepared();
      clearTimeout(runner._graceTimer);
      if (this.runners.get(sessionId) === runner) { this.send("session:partial-reset", { sessionId }); this.runners.delete(sessionId); }
      if (this.draining.get(sessionId) === runner.done) this.draining.delete(sessionId);
      store.flush(sessionId);
      if (runner._resolveDone) runner._resolveDone();
    }

    if (Array.isArray(reviewers) && reviewers.length && reviewMode === "after" && runner.completedClean && !background && !(fleet && fleet.taskId)) {
      try { await this.reviewAfter(session, reviewers, text || "", promptMessageId); } catch (e) { console.error("[council:after]", e); }
    }
  },
};

module.exports = { methods };
