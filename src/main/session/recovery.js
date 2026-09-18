"use strict";
/* Recovery: a turn interrupted by the network, an expired login or a rate limit is PRESERVED
 * (payload + backoff) and replayed with the live settings once the cause is gone. */
const store = require("../storage/store");
const auth = require("../auth/cli-auth");

const methods = {
  // Volatile run prefs change between when a turn first failed and when it
  // auto-retries — replay with LIVE settings, keeping the turn's text/attachments.
  applyLivePrefs(session, payload) {
    if (!payload || !session) return payload;
    const s = store.getSettings(session.cwd);
    const reviewers = (Array.isArray(s.reviewers) ? s.reviewers : [])
      .filter((r) => r && r.provider && !(r.provider === (s.llmProvider || "anthropic") && r.model && r.model === s.defaultModel));
    return {
      ...payload,
      model: s.defaultModel || payload.model,
      permissionMode: s.defaultPermissionMode || payload.permissionMode,
      thinking: s.defaultThinking || payload.thinking,
      oneM: !!s.oneM,
      subAgents: !!s.subAgents,
      subAgentsMax: Math.max(1, Math.min(20, +s.subAgentsMax || 3)),
      reviewers,
      reviewMode: s.reviewMode === "after" ? "after" : "before",
    };
  },

  retryPending(sessionId) {
    const session = store.getSession(sessionId);
    if (!session) return false;
    if (this.isRunning(sessionId)) return false;
    this.cancelScheduledRetry(sessionId);
    const wasAuth = !session._pendingRetry && session.pendingRun && session.pendingRun.payload;
    const wasRate = session.status === "ratelimited";
    const payload = session._pendingRetry || (session.pendingRun && session.pendingRun.payload);
    if (!payload) return false;
    delete session._pendingRetry;
    if (session.pendingRun) { session.pendingRun = null; store.updateSession(sessionId, { pendingRun: null }); }
    const note = wasAuth ? "Signed back in — resuming with full context…" : wasRate ? "Retrying — your message and context are preserved…" : "Connection restored — resuming...";
    this.addMessage(session, { id: store.uid(), role: "system", text: note, ts: store.nowISO() });
    this.run(sessionId, this.applyLivePrefs(session, payload)).catch((err) => console.error("[claude:retry]", err));
    return true;
  },

  scheduleRetry(sessionId, reason) {
    const RATE_BACKOFF = [15, 30, 60, 120, 120];   // seconds per attempt
    const session = store.getSession(sessionId);
    if (!session || !session._pendingRetry) return;
    this.cancelScheduledRetry(sessionId);
    const attempt = (session._retryAttempt || 0);
    if (attempt >= RATE_BACKOFF.length) {
      this.addMessage(session, { id: store.uid(), role: "error", text: "Still rate-limited after several attempts — your message is preserved. Click Retry to try again, or wait a bit longer.", ts: store.nowISO() });
      store.updateSession(sessionId, { status: "ratelimited" });
      this.send("session:status", { sessionId, status: "ratelimited", waiting: false });
      return;
    }
    const delay = RATE_BACKOFF[attempt];
    session._retryAttempt = attempt + 1;
    const resumeAt = Date.now() + delay * 1000;
    store.updateSession(sessionId, { status: "ratelimited" });
    this.send("session:status", { sessionId, status: "ratelimited", waiting: true, resumeAt, attempt: attempt + 1 });
    if (!this._retryTimers) this._retryTimers = new Map();
    const t = setTimeout(() => {
      this._retryTimers.delete(sessionId);
      const s = store.getSession(sessionId);
      if (!s || !s._pendingRetry || this.isRunning(sessionId)) return;
      const payload = this.applyLivePrefs(s, s._pendingRetry);
      delete s._pendingRetry;
      this.run(sessionId, payload).catch((err) => console.error("[claude:rate-retry]", err));
    }, delay * 1000);
    if (t.unref) t.unref();
    this._retryTimers.set(sessionId, t);
  },

  cancelScheduledRetry(sessionId) {
    if (this._retryTimers && this._retryTimers.has(sessionId)) {
      clearTimeout(this._retryTimers.get(sessionId));
      this._retryTimers.delete(sessionId);
    }
  },

  retryAllOffline() {
    let count = 0;
    for (const meta of store.listSessions()) {
      if (!meta || !meta.id) continue;
      const session = store.getSession(meta.id);
      if (session && session._pendingRetry && !this.isRunning(meta.id)) { this.retryPending(meta.id); count++; }
    }
    return count;
  },

  retryAllAuthExpired(provider) {
    let count = 0;
    for (const meta of store.listSessions()) {
      if (!meta || !meta.id) continue;
      const session = store.getSession(meta.id);
      if (!session || this.isRunning(meta.id)) continue;
      const pr = session.pendingRun;
      const paused = (session.status === "auth-expired") || (pr && pr.reason === "auth");
      if (!paused) continue;
      if (provider && pr && pr.provider && pr.provider !== provider) continue;
      if (this.retryPending(meta.id)) count++;
    }
    return count;
  },

  listAuthExpired() {
    const out = [];
    for (const meta of store.listSessions()) {
      if (!meta || !meta.id) continue;
      const session = store.getSession(meta.id);
      const pr = session && session.pendingRun;
      if (session && (session.status === "auth-expired" || (pr && pr.reason === "auth"))) out.push({ id: meta.id, provider: (pr && pr.provider) || "anthropic" });
    }
    return out;
  },
};

module.exports = { methods };
