"use strict";
/* Sub-agents: the per-session registry and the CPU governor, wired to the runners.
 *
 * REGISTRY (agents/subagents.js keeps the records on `session.agents`): every Task / Agent tool
 * call the primary agent makes gets a number (#1, #2 …) the moment it is announced, and its
 * record follows the agent through the SDK's events — PreToolUse (started), task_started /
 * task_progress / task_notification (background lifecycle, usage, the model's progress blurbs),
 * the tool_result (a foreground agent's end), SubagentStart / SubagentStop hooks (the agent id,
 * its last message) — and ends with the run. The renderer shows the same numbers on the Task
 * cards, the nested output and the Agents panel; the history stays on the session.
 *
 * GOVERNOR (one per process): how many agents may run at once, from the user's ceiling (1–20,
 * also handed to the CLI as CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS — its own hard cap) and the
 * cores that are actually free. A Task call waits for a slot (bounded) before it is allowed; if
 * none frees up the call is denied with a plain sentence the model can act on (do it yourself /
 * delegate later) — a permission-layer decision, never an instruction in the prompt. While the
 * machine stays saturated the CLI process runs at lower priority so a build keeps its cores. */
const os = require("os");
const store = require("../storage/store");
const A = require("../agents/subagents");
const { SUBAGENT_TOOLS } = require("./tools");

const PRIO = (os.constants && os.constants.priority) || { PRIORITY_NORMAL: 0, PRIORITY_BELOW_NORMAL: 10 };
const AGENT_SLOT_WAIT_MS = 45000;

const methods = {
  /* ---------------- governor ---------------- */
  ensureGovernor() {
    if (this._governorReady) return A.governor;
    this._governorReady = true;
    A.governor.configure({
      settings: () => this.governorSettings(),
      onSnapshot: (snap) => this.send("agents:cpu", this.adjustSnapshot(snap)),
      onThrottle: (throttled, snap) => this.applyThrottle(throttled, snap),
    });
    return A.governor;
  },
  /* The governor's policy inputs. The CAP is the one the running turns were dispatched with
   * (runner.subAgentsMax — what the composer showed and the CLI received): reading the global
   * settings file gave "max 3" while the user had set 12 for the project, so the gate denied
   * agents the user had allowed (2026-09-17). */
  governorSettings() {
    let base = {}; try { base = store.getSettings() || {}; } catch { base = {}; }
    let cap = 0;
    for (const r of this.runners.values()) if (r && r.running && +r.subAgentsMax > cap) cap = +r.subAgentsMax;
    return cap ? { ...base, subAgentsMax: cap } : base;
  },
  // Agents alive right now across the running sessions — from the REGISTRY, which sees every agent
  // (the governor's holds only see the Task calls that passed its gate; full-access runs skip it).
  liveAgentCount() {
    let n = 0;
    for (const [id, r] of this.runners.entries()) { if (!r || !r.running) continue; const s = store.getSession(id); if (s) n += A.live(s).length; }
    return n;
  },
  // The snapshot the UI shows: running = what is actually running, free slots = cap − running.
  adjustSnapshot(snap) {
    if (!snap) return snap;
    const live = this.liveAgentCount();
    if (live > (snap.running || 0)) snap.running = live;
    snap.freeSlots = Math.max(0, (snap.allowedNow || 0) - (snap.running || 0));
    return snap;
  },
  cpuSnapshot() { const g = this.ensureGovernor(); g.touch(); if (!g.samples.length) g.sample(); return this.adjustSnapshot(g.snapshot()); },
  // Below-normal priority for every live CLI process while the machine is saturated; back to normal after.
  applyThrottle(throttled) {
    for (const r of this.runners.values()) {
      if (!r || !r.running || !r.pid) continue;
      try { os.setPriority(r.pid, throttled ? PRIO.PRIORITY_BELOW_NORMAL : PRIO.PRIORITY_NORMAL); r.throttled = !!throttled; } catch { /* the process may be gone, or we may lack the right */ }
    }
  },
  // A CLI spawned while the governor is throttling starts at the lower priority too.
  applySpawnPriority(pid) {
    if (!pid) return;
    try { if (A.governor.throttled) os.setPriority(pid, PRIO.PRIORITY_BELOW_NORMAL); } catch { /* */ }
  },

  /* Reserve a slot for a new agent before its Task call may run. Resolves { ok } or
   * { ok:false, message } (the deny text). The record shows "waiting" meanwhile. */
  async acquireAgentSlot(sessionId, toolUseId, input, signal) {
    const g = this.ensureGovernor();
    const session = store.getSession(sessionId);
    const runner = this.runners.get(sessionId);
    const key = toolUseId || store.uid();
    const rec = session ? this.agentAnnounce(session, runner, { toolUseId: key, input, status: "queued" }).agent : null;
    const t0 = Date.now();
    const r = await g.acquire(key, { waitMs: AGENT_SLOT_WAIT_MS, signal, label: (rec && rec.description) || "", onWait: () => { if (rec) this.agentPatch(session, rec, { status: "waiting", gate: "waiting" }); } });
    if (r.ok) { if (rec) this.agentPatch(session, rec, { gate: r.waited ? "waited" : "granted", waitMs: Date.now() - t0, ...(rec.status === "waiting" ? { status: "queued" } : {}) }); return { ok: true }; }
    if (r.reason === "aborted") return { ok: false, message: "The run was stopped." };
    const message = g.denyMessage(r.snapshot);
    if (rec) this.agentPatch(session, rec, { status: "error", gate: "denied", result: message });
    return { ok: false, message };
  },
  releaseAgentSlot(key) { try { A.governor.release(key); } catch { /* */ } },

  /* ---------------- registry ---------------- */
  agentAnnounce(session, runner, { toolUseId, msgId, input, parentToolUseId, status } = {}) {
    const r = A.announce(session, { toolUseId, msgId, input, runId: runner ? runner.id : null, promptMessageId: runner ? runner.promptMessageId : null, parentToolUseId, status });
    if (r.created) this.reconcileAgents(session, runner);   // a new agent of a live run: whatever an earlier, ended run left "running" ends now
    if (r.created || r.changed) { store.scheduleWrite(session.id); this.agentEmit(session, r.agent); }
    if (r.created && runner) this.ensureGovernor().touch();
    return r;
  },
  /* Agents whose run is no longer alive cannot still be running. A run that PAUSED (offline /
   * login / rate limit) never finalised, an app restart lost its runner — the records stayed
   * "running" for hours and kept their CPU slots (2026-09-17: one agent "running" 3 h after its run
   * ended, the composer still counting it). Every non-terminal record that the live run of this
   * session does not own ends now — its Task card too — and its slot is released. Returns how many. */
  reconcileAgents(session, runner) {
    if (!session) return 0;
    const cur = this.runners.get(session.id);
    const live = runner && runner.running !== false && (!cur || cur === runner) ? runner : (cur && cur.running ? cur : null);
    const liveId = live ? live.id : null;
    const stale = A.live(session).filter((a) => !(liveId && (a.runId === liveId || !a.runId)));
    if (!stale.length) return 0;
    const ts = store.nowISO();
    for (const a of stale) {
      A.patch(a, { status: "interrupted", result: a.result || A.endNote(a, "The run that started this agent has ended.") });
      this.agentEmit(session, a);
      if (a.toolUseId) this.releaseAgentSlot(a.toolUseId);
      const card = a.msgId ? (session.messages || []).find((m) => m && m.id === a.msgId) : null;
      if (card && (card.status === "running" || card.status === "queued" || card.status === "preparing")) {
        const patch = { status: "interrupted", result: card.result || "The run that started this agent has ended.", endedTs: ts, agentStatus: "interrupted" };
        Object.assign(card, patch);
        this.send("session:message-update", { sessionId: session.id, messageId: card.id, patch });
      }
    }
    store.scheduleWrite(session.id);
    return stale.length;
  },
  agentPatch(session, agent, patch) {
    if (!agent) return false;
    const changed = A.patch(agent, patch);
    if (changed) {
      store.scheduleWrite(session.id);
      this.agentEmit(session, agent);
      if (A.isTerminal(agent) && agent.toolUseId) this.releaseAgentSlot(agent.toolUseId);
      // the Task card mirrors the agent's live progress and gate state (purpose stays on the card's input)
      if (agent.msgId && (patch.progress !== undefined || patch.lastTool !== undefined || patch.toolUses !== undefined || patch.gate !== undefined || patch.status !== undefined)) {
        this.send("session:message-update", { sessionId: session.id, messageId: agent.msgId, patch: { agentProgress: agent.progress || undefined, agentLastTool: agent.lastTool || undefined, agentToolUses: agent.toolUses || undefined, agentGate: agent.gate || undefined, agentStatus: agent.status } });
      }
    }
    return changed;
  },
  agentEmit(session, agent) {
    this.send("agents:update", { sessionId: session.id, agent: A.publicAgent(agent), ...A.summary(session) });
    // A workflow job's child: its job carries the live agent picture for the studio (workflow.js).
    if (session.jobId && typeof this.jobAgentsChanged === "function") { try { this.jobAgentsChanged(session); } catch { /* the studio's view is best effort */ } }
  },
  /* What Claude is told when the user turned sub-agents ON — an explicit control shown in the Agents
   * popover, not a hidden layer (user decision 2026-09-17): use the cap. The model still decides
   * what divides; nothing forces a fan-out where the work does not split. */
  agentsBrief(max) {
    const n = A.clampMax(max);
    return `Sub-agents: you may launch up to ${n} worker sub-agent${n === 1 ? "" : "s"} (the Task tool). Use them to speed the work up: split independent parts of the work across as many as the task allows — all ${n} when it divides that far, fewer when it does not — and run them in parallel rather than one after another; work that cannot be split you do yourself.`;
  },
  agentFind(session, keys) { return A.find(session, keys); },
  agentNumberFor(sessionId, agentId, toolUseId) {
    const s = store.getSession(sessionId); if (!s) return null;
    const a = A.find(s, { agentId }) || (toolUseId ? A.find(s, { toolUseId }) : null);
    return a ? a.n : null;
  },
  agentsList(sessionId) {
    const s = store.getSession(sessionId); if (!s) return { agents: [], total: 0, running: 0, seq: 0 };
    this.reconcileAgents(s);   // the panel / strip never shows an agent of an ended run as running
    return { agents: A.ensure(s).map(A.publicAgent), ...A.summary(s) };
  },
  // Every agent of a run that never reached a terminal state ends with the run (its CPU slot freed).
  closeRunAgents(session, runner, status, note) {
    const closed = A.closeRun(session, runner ? runner.id : null, status, note);
    for (const a of closed) { this.agentEmit(session, a); if (a.toolUseId) this.releaseAgentSlot(a.toolUseId); }
    if (closed.length) store.scheduleWrite(session.id);
    return closed.length;
  },
  // Stop ONE background agent (its task) — the CLI emits a task_notification "stopped" for it.
  async stopAgent(sessionId, taskId) {
    const q = this._liveQuery(sessionId);
    if (!q || typeof q.stopTask !== "function") return { ok: false, detail: "No running turn owns that agent." };
    try { await q.stopTask(taskId); return { ok: true }; } catch (e) { return { ok: false, detail: String((e && e.message) || e) }; }
  },

  /* ---------------- hooks (SubagentStart / SubagentStop / PreToolUse inside an agent) ---------------- */
  agentHookStart(session, runner, input) {
    if (!input || !input.agent_id) return;
    // the CLI's agent id is not the Task tool_use id: match the newest announced agent without one
    let a = A.find(session, { agentId: input.agent_id }) || A.find(session, { taskId: input.agent_id });
    if (!a) { const list = A.ensure(session); for (let i = list.length - 1; i >= 0; i--) { const c = list[i]; if (!c.agentId && !A.isTerminal(c) && (!runner || c.runId === runner.id)) { a = c; break; } } }
    if (a) this.agentPatch(session, a, { agentId: input.agent_id, ...(input.agent_type ? { type: input.agent_type } : {}), status: "running" });
  },
  agentHookStop(session, runner, input) {
    if (!input || !input.agent_id) return;
    const a = A.find(session, { agentId: input.agent_id }) || A.find(session, { taskId: input.agent_id });
    if (!a) return;
    const patch = {};
    if (input.last_assistant_message) patch.result = String(input.last_assistant_message);
    if (!a.background) patch.status = "done";   // a foreground agent is finished when it stops; a background one reports through task_notification
    this.agentPatch(session, a, patch);
  },
  agentToolUse(session, runner, input) {
    if (!input || !input.agent_id) return;
    const a = A.find(session, { agentId: input.agent_id }) || A.find(session, { taskId: input.agent_id });
    if (a) this.agentPatch(session, a, { toolUses: (a.toolUses || 0) + 1, lastTool: input.tool_name || a.lastTool, status: A.isTerminal(a) ? a.status : "running" });
  },
  isAgentTool(name) { return SUBAGENT_TOOLS.test(String(name || "")); },
};

module.exports = { methods, AGENT_SLOT_WAIT_MS };
