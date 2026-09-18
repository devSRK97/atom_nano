"use strict";
/* IPC: per-session sub-agents (agents:*) and the context window (context:* — fill, rollover, digest),
 * both answered by the session manager. */
const claude = require("../session/index");

function register(ctx) {
  const { handle } = ctx;
  // Sub-agents: the per-session registry (history of every worker), the CPU governor's live
  // picture, and stopping ONE background agent. Context: fill / window / digest for the chip.
  handle("agents:list", async (_e, id) => claude.agentsList(id));
  handle("agents:cpu", async () => claude.cpuSnapshot());
  handle("agents:stop", async (_e, id, taskId) => claude.stopAgent(id, taskId));
  handle("context:info", async (_e, id) => claude.contextInfo(id));
  handle("context:rollover", async (_e, id, on) => claude.requestRollover(id, on !== false));
  handle("context:digest", async (_e, id) => claude.buildDigest(id));
  handle("context:digest-text", async (_e, id) => claude.digestText(id));

  // (The auto-maintained project memory graph, conversation digest / thread graph
  //  and capabilities graph were removed: no app-authored context is injected into
  //  runs any more. The compact export still uses convo.digestFor explicitly.)
}

module.exports = { register };
