"use strict";
/* SUB-AGENTS — registry + CPU governor.
 *
 * Registry: every worker the primary agent launches (the Task / Agent tool) gets a per-session
 * number and a record on `session.agents` — purpose (description + full prompt), type, status,
 * timings, progress blurbs, tool/token usage and the result — kept as HISTORY, so the Agents
 * panel can show what ran, why, and how it went long after the cards scrolled away. The record
 * is app-side bookkeeping: it is never part of what the model receives.
 *
 * CPU governor: how many agents may run at once, decided from what the machine can actually
 * give. The user's maximum (1–20) is the ceiling and is passed to the CLI as its own hard cap
 * (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). Below that ceiling the governor reserves a number of
 * cores per agent ("auto" = 2 on 12+ core machines, else 1), keeps one or two cores for the
 * system, and counts only cores that are FREE right now (sampled from os.cpus() — works on
 * Windows, where os.loadavg() is always zero). While a build or other work saturates the CPU,
 * new agent spawns wait for a slot (bounded) and the agent process runs at lower priority; when
 * the load drops the slots come back. Nothing here changes the model's instructions — the gate
 * is a permission-layer decision, like the fleet's same-file lock. */
const os = require("os");

const MAX_AGENTS = 20;
const AGENT_CAP = 400;                 // records kept per session (oldest finished ones drop first)
const RESULT_KEEP = 4000;              // chars of a result / prompt excerpt kept on a record
const TERMINAL = new Set(["done", "error", "stopped", "interrupted"]);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function clampMax(n, fallback = 3) { const v = Math.floor(+n); return Number.isFinite(v) && v >= 1 ? Math.min(MAX_AGENTS, v) : fallback; }
function excerpt(s, max = RESULT_KEEP) { s = String(s == null ? "" : s); return s.length <= max ? s : s.slice(0, max) + `\n… [${(s.length - max).toLocaleString("en-US")} more characters]`; }
function coreCount() { try { if (typeof os.availableParallelism === "function") return Math.max(1, os.availableParallelism()); } catch { /* */ } return Math.max(1, (os.cpus() || []).length || 1); }

/* ------------------------------------ CPU governor ------------------------------------ */
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus() || []) { const t = c.times || {}; idle += t.idle || 0; for (const k of Object.keys(t)) total += t[k] || 0; }
  return { idle, total };
}

class CpuGovernor {
  constructor({ intervalMs = 2000, settings, cores, onSnapshot, onThrottle, sampler } = {}) {
    this.intervalMs = intervalMs;
    this.getSettings = settings || (() => ({}));
    this.cores = cores || coreCount();
    this.onSnapshot = onSnapshot || null;
    this.onThrottle = onThrottle || null;
    this.sampler = sampler || cpuTimes;            // tests inject a fake
    this.busy = 0; this.ema = 0; this.samples = [];  // percent
    this.holds = new Map();                         // key → { since, label }
    this.waiters = new Set();                       // resolve functions woken on release / sample
    this.waiting = 0;
    this.throttled = false; this._hot = 0; this._cool = 0;
    this._last = null; this._timer = null; this._interestUntil = 0;
    this.idleStopMs = 90000;
  }
  configure(opts = {}) { if (opts.settings) this.getSettings = opts.settings; if (opts.onSnapshot) this.onSnapshot = opts.onSnapshot; if (opts.onThrottle) this.onThrottle = opts.onThrottle; if (opts.sampler) this.sampler = opts.sampler; if (opts.cores) this.cores = opts.cores; return this; }
  // Someone cares about the numbers (a run with sub-agents, an open panel): keep sampling.
  touch(ms) { this._interestUntil = Math.max(this._interestUntil, Date.now() + (ms || this.idleStopMs)); this.start(); }
  start() {
    if (this._timer) return;
    this._last = this.sampler();
    this._timer = setInterval(() => this.tick(), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } this._last = null; }
  tick() {
    this.sample();
    if (this.onSnapshot) { try { this.onSnapshot(this.snapshot()); } catch { /* listener error is not ours */ } }
    for (const w of Array.from(this.waiters)) { try { w(); } catch { /* */ } }
    if (!this.holds.size && !this.waiters.size && Date.now() > this._interestUntil) this.stop();
  }
  // One measurement: busy % since the previous sample, smoothed (EMA) so a burst does not flap the slots.
  sample(times) {
    const now = times || this.sampler();
    if (this._last && now.total > this._last.total) {
      const dt = now.total - this._last.total, di = now.idle - this._last.idle;
      this.busy = clamp(Math.round((1 - di / dt) * 100), 0, 100);
      this.ema = this.samples.length ? Math.round(this.ema * 0.6 + this.busy * 0.4) : this.busy;
      this.samples.push(this.busy); if (this.samples.length > 40) this.samples.shift();
    }
    this._last = now;
    this.updateThrottle();
    return this.busy;
  }
  policy() {
    const s = this.getSettings() || {};
    const userMax = clampMax(s.subAgentsMax);
    const raw = s.agentCoresPerAgent;
    const auto = this.cores >= 12 ? 2 : 1;
    const coresPerAgent = raw === 1 || raw === 2 || raw === 4 || raw === "1" || raw === "2" || raw === "4" ? +raw : auto;
    const reserve = this.cores >= 8 ? 2 : 1;
    // The CPU gate is OPT-IN (user decision 2026-09-17): the cap the user set is the limit unless they
    // asked the app to yield to heavy processes. Priority throttling follows the same switch.
    return { userMax, coresPerAgent, coresAuto: auto, reserve, governor: s.agentCpuGovernor === true };
  }
  // How many agents may run RIGHT NOW: the running ones plus what the free cores allow, never below one, never above the user's cap.
  compute() {
    const p = this.policy();
    const running = this.holds.size;
    if (!p.governor) return { ...p, running, freeCores: null, busyCores: null, allowedNow: p.userMax };
    const busyCores = Math.round((this.ema / 100) * this.cores);
    const freeCores = Math.max(0, this.cores - p.reserve - busyCores);
    const allowedNow = clamp(running + Math.floor(freeCores / p.coresPerAgent), 1, p.userMax);
    return { ...p, running, freeCores, busyCores, allowedNow };
  }
  snapshot() {
    const c = this.compute();
    return { cores: this.cores, busyPct: this.busy, ema: this.ema, samples: this.samples.slice(-30), throttled: this.throttled, waiting: this.waiting, sampling: !!this._timer, ts: Date.now(), ...c,
      freeSlots: Math.max(0, c.allowedNow - c.running),
      holds: [...this.holds.entries()].map(([key, v]) => ({ key, since: v.since, label: v.label || "" })) };
  }
  // Below-normal priority for the agent process while the machine stays saturated (3 samples ≥ 90 %), back to normal once it cools (3 samples < 70 %).
  updateThrottle() {
    const p = this.policy();
    const hot = p.governor && this.holds.size > 0 && this.ema >= 90;
    const cool = this.ema < 70 || !p.governor;
    this._hot = hot ? this._hot + 1 : 0; this._cool = cool ? this._cool + 1 : 0;
    let next = this.throttled;
    if (!this.throttled && this._hot >= 3) next = true;
    if (this.throttled && (this._cool >= 3 || !this.holds.size)) next = false;
    if (next !== this.throttled) { this.throttled = next; if (this.onThrottle) { try { this.onThrottle(next, this.snapshot()); } catch { /* */ } } }
  }
  /* Reserve a slot for a new agent. Immediate when the governor allows it; otherwise wait
   * (woken by every release and every sample) up to waitMs. Resolves { ok, waitedMs } or
   * { ok:false, reason, snapshot }. `signal` (the run's abort) ends the wait. */
  async acquire(key, { waitMs = 45000, signal, label, onWait } = {}) {
    this.touch();
    const t0 = Date.now();
    if (this.holds.has(key)) return { ok: true, waitedMs: 0, already: true };
    let waited = false;
    for (;;) {
      const c = this.compute();
      if (this.holds.size < c.allowedNow) { this.holds.set(key, { since: Date.now(), label: label || "" }); if (waited) this.waiting = Math.max(0, this.waiting - 1); return { ok: true, waitedMs: Date.now() - t0, waited }; }
      if (signal && signal.aborted) { if (waited) this.waiting = Math.max(0, this.waiting - 1); return { ok: false, reason: "aborted", snapshot: this.snapshot() }; }
      if (Date.now() - t0 >= waitMs) { if (waited) this.waiting = Math.max(0, this.waiting - 1); return { ok: false, reason: "timeout", snapshot: this.snapshot() }; }
      if (!waited) { waited = true; this.waiting++; if (onWait) { try { onWait(this.snapshot()); } catch { /* */ } } }
      await new Promise((res) => {
        const wake = () => { this.waiters.delete(wake); clearTimeout(t); if (signal) signal.removeEventListener("abort", wake); res(); };
        this.waiters.add(wake);
        const t = setTimeout(wake, Math.min(1000, Math.max(50, waitMs - (Date.now() - t0))));
        if (signal) signal.addEventListener("abort", wake, { once: true });
      });
    }
  }
  release(key) {
    if (!this.holds.delete(key)) return false;
    for (const w of Array.from(this.waiters)) { try { w(); } catch { /* */ } }
    this.updateThrottle();
    return true;
  }
  releaseAll(pred) { for (const key of Array.from(this.holds.keys())) if (!pred || pred(key)) this.release(key); }
  // The message a denied spawn carries back to the model — a structured permission decision, no prompt text elsewhere.
  denyMessage(snap) {
    const s = snap || this.snapshot();
    return `Sub-agent slot unavailable: AtomNano's CPU governor allows ${s.allowedNow} concurrent agent${s.allowedNow === 1 ? "" : "s"} right now (${s.running} running; the machine is ${s.ema}% busy on ${s.cores} cores, ${s.coresPerAgent} core${s.coresPerAgent === 1 ? "" : "s"} reserved per agent). Do this subtask yourself, or delegate again after a running agent has finished. Do not retry in a loop.`;
  }
}

/* --------------------------------------- registry --------------------------------------- */
function ensure(session) {
  if (!Array.isArray(session.agents)) session.agents = [];
  if (!Number.isFinite(+session.agentSeq)) session.agentSeq = 0;
  return session.agents;
}
function isTerminal(a) { return !!a && TERMINAL.has(a.status); }
function find(session, { toolUseId, taskId, agentId, n } = {}) {
  const list = ensure(session);
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (toolUseId && a.toolUseId === toolUseId) return a;
    if (taskId && a.taskId === taskId) return a;
    if (agentId && a.agentId === agentId) return a;
    if (n && a.n === n) return a;
  }
  return null;
}
function live(session) { return ensure(session).filter((a) => !TERMINAL.has(a.status)); }
// Purpose fields from the Task tool's input (description = one line, prompt = the full brief).
function fieldsFromInput(input) {
  const i = input && typeof input === "object" ? input : {};
  const out = {};
  if (typeof i.description === "string" && i.description) out.description = i.description;
  if (typeof i.prompt === "string" && i.prompt) out.prompt = excerpt(i.prompt, 20000);
  if (typeof i.subagent_type === "string" && i.subagent_type) out.type = i.subagent_type;
  if (typeof i.model === "string" && i.model) out.model = i.model;
  if (i.run_in_background === true) out.background = true;
  if (typeof i.name === "string" && i.name) out.name = i.name;
  return out;
}
/* Create the record for an announced Task tool call (numbering happens here, once). Returns
 * { agent, created }. A second announcement of the same tool_use only fills in fields. */
function announce(session, { toolUseId, msgId, input, runId, promptMessageId, parentToolUseId, status } = {}) {
  const list = ensure(session);
  let a = toolUseId ? find(session, { toolUseId }) : null;
  const fields = fieldsFromInput(input);
  if (a) { const changed = patch(a, { ...fields, ...(msgId ? { msgId } : {}) }); return { agent: a, created: false, changed }; }
  const parent = parentToolUseId ? find(session, { toolUseId: parentToolUseId }) : null;
  a = {
    n: ++session.agentSeq, toolUseId: toolUseId || null, msgId: msgId || null, taskId: null, agentId: null,
    type: fields.type || "", description: fields.description || "", prompt: fields.prompt || "", model: fields.model || "", name: fields.name || "",
    status: status || "queued", background: !!fields.background, depth: parent ? (parent.depth || 1) + 1 : 1, parentToolUseId: parentToolUseId || null, parentN: parent ? parent.n : null,
    runId: runId || null, promptMessageId: promptMessageId || null,
    ts: new Date().toISOString(), startedTs: null, endedTs: null,
    progress: "", lastTool: "", toolUses: 0, tokens: 0, durationMs: 0, elapsedSeconds: null, result: "", outputFile: "", gate: "", waitMs: 0,
  };
  list.push(a);
  trim(session);
  return { agent: a, created: true, changed: true };
}
// Apply a patch; a finished agent never goes back to running; timings are filled consistently. Returns true when something changed.
function patch(a, p) {
  if (!a || !p) return false;
  let changed = false;
  for (const k of Object.keys(p)) {
    let v = p[k];
    if (v === undefined) continue;
    if (k === "status") {
      if (TERMINAL.has(a.status) && !TERMINAL.has(v)) continue;          // no resurrection
      if (TERMINAL.has(v) && !a.endedTs) { a.endedTs = new Date().toISOString(); changed = true; }
      if ((v === "running" || v === "starting") && !a.startedTs) { a.startedTs = new Date().toISOString(); changed = true; }
    }
    if (k === "result" || k === "prompt") v = excerpt(v, k === "prompt" ? 20000 : RESULT_KEEP);
    if (k === "toolUses" || k === "tokens" || k === "durationMs") { v = Math.max(+a[k] || 0, +v || 0); }
    if (a[k] !== v) { a[k] = v; changed = true; }
  }
  if (a.startedTs && a.endedTs && !a.durationMs) { const d = new Date(a.endedTs) - new Date(a.startedTs); if (d > 0) { a.durationMs = d; changed = true; } }
  return changed;
}
// Memory bound: keep the newest records; live ones are never dropped.
function trim(session) {
  const list = ensure(session);
  if (list.length <= AGENT_CAP) return;
  let i = 0;
  while (list.length > AGENT_CAP && i < list.length) { if (TERMINAL.has(list[i].status)) list.splice(i, 1); else i++; }
}
// The result text of an agent that ends WITHOUT a report of its own: the reason it ended, then what
// it was last doing (its progress blurb, else its last tool) — the last activity stays visible on the
// record instead of vanishing with the "running" state (user request 2026-09-17).
function endNote(a, note) {
  const last = a && a.progress ? `Last activity: ${String(a.progress).trim()}` : a && a.lastTool ? `Last tool: ${a.lastTool}` : "";
  return [String(note || "").trim(), last].filter(Boolean).join(" ");
}
// Every non-terminal record of a run ends with the run (stopped / failed / paused). `note` is the
// result text for a record that has none (the default names a stop or a failure).
function closeRun(session, runId, status, note) {
  const out = [];
  for (const a of ensure(session)) if ((!runId || a.runId === runId) && !TERMINAL.has(a.status)) { patch(a, { status: status || "interrupted", result: a.result || endNote(a, note || (status === "error" ? "The run failed before this agent finished." : "Stopped before this agent finished.")) }); out.push(a); }
  return out;
}
// The SDK placeholder a backgrounded Task returns instead of a result.
function looksBackgrounded(text) { return /running in the background|launched .*background|async agent launched|agentId:|task_id/i.test(String(text || "")); }
function publicAgent(a) { return { ...a }; }
function summary(session) { const list = ensure(session); return { total: list.length, running: list.filter((a) => !TERMINAL.has(a.status)).length, seq: session.agentSeq || 0 }; }

const governor = new CpuGovernor();

module.exports = { CpuGovernor, governor, MAX_AGENTS, AGENT_CAP, TERMINAL, clampMax, excerpt, coreCount, cpuTimes, ensure, isTerminal, find, live, announce, patch, trim, closeRun, endNote, looksBackgrounded, publicAgent, summary, fieldsFromInput };
