"use strict";
/* Permission bridge: a tool call the harness must ask about becomes a renderer prompt, owned by
 * (session, run) so only its own run's stop / finish can cancel it and a late answer for another
 * run is ignored.
 *
 * The SDK hands canUseTool more than the tool name and input: the prompt sentence it would show
 * itself (`title` / `displayName`), the reason a rule stopped the call (`decisionReason`,
 * `blockedPath`), the permission rules it suggests for an "always allow" (`suggestions`) and the
 * sub-agent asking (`agentID`). All of it reaches the card, and "allow for this session" hands
 * the suggested rules back as `updatedPermissions` — so the CLI itself stops asking, rather than
 * the app auto-answering the same prompt over and over. */
const store = require("../storage/store");

const methods = {
  // Resolve/cancel every pending permission request that belongs to ONE run.
  cancelPermissionsFor(sessionId, runId, message) {
    for (const [requestId, rec] of Array.from(this.permResolvers.entries())) {
      if (!rec || rec.sessionId !== sessionId) continue;
      if (runId && rec.runId && rec.runId !== runId) continue;
      this.send("session:permission-cancel", { sessionId, requestId });
      // rec.resolve removes the entry itself (and ignores a second call).
      try { rec.resolve({ allow: false, message: message || "Cancelled" }); } catch { /* */ }
    }
  },

  /* Ask the user to allow a tool call. The request is owned by (sessionId, runId): only its own
   * run's stop/finish may cancel it, and a late answer for another run is ignored. `extra` is the
   * SDK's canUseTool options object (title, displayName, description, decisionReason, blockedPath,
   * suggestions, agentID, toolUseID) — forwarded to the card, minus the rule objects themselves. */
  requestPermission(sessionId, toolName, input, signal, runId, extra) {
    const requestId = store.uid();
    const o = extra && typeof extra === "object" ? extra : {};
    const suggestions = Array.isArray(o.suggestions) ? o.suggestions : [];
    const agentN = o.agentID && this.agentNumberFor ? this.agentNumberFor(sessionId, o.agentID, o.toolUseID) : null;
    this.send("session:permission", {
      sessionId, requestId, toolName, input,
      title: o.title || "", displayName: o.displayName || "", description: o.description || "",
      decisionReason: o.decisionReason || "", blockedPath: o.blockedPath || "",
      canRemember: suggestions.length > 0, agentId: o.agentID || "", agentN, toolUseId: o.toolUseID || "",
    });
    return new Promise((resolve) => {
      const rec = {
        sessionId, runId: runId || null,
        resolve: (decision) => {
          if (this.permResolvers.get(requestId) !== rec) return;   // already resolved / cancelled
          this.permResolvers.delete(requestId);
          if (decision && decision.allow) {
            // An answer to AskUserQuestion travels as `updatedInput.answers` (question text →
            // chosen label(s)) — the SDK's contract; a denial with the answers in its message
            // would reach the model as "permission denied".
            const extraInput = decision.updatedInput && typeof decision.updatedInput === "object" ? decision.updatedInput : (decision.answers && typeof decision.answers === "object" ? { answers: decision.answers } : null);
            const out = { behavior: "allow", updatedInput: extraInput ? { ...(input && typeof input === "object" ? input : {}), ...extraInput } : input };
            // "Allow for this session": the CLI's own suggested rules make it stop asking.
            if (decision.always && suggestions.length) out.updatedPermissions = suggestions;
            resolve(out);
          } else resolve({ behavior: "deny", message: (decision && decision.message) || "Denied by user" });
        },
      };
      this.permResolvers.set(requestId, rec);
      if (signal) signal.addEventListener("abort", () => {
        if (this.permResolvers.get(requestId) !== rec) return;
        this.send("session:permission-cancel", { sessionId, requestId });
        rec.resolve({ allow: false, message: "Aborted" });
      }, { once: true });
    });
  },

  respondPermission(requestId, decision) {
    const rec = this.permResolvers.get(requestId);
    if (rec) rec.resolve(decision);
  },
};

module.exports = { methods };
