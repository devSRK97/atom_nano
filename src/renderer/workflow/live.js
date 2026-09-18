/* AtomNano renderer — Workflow studio — the live side: role jobs and stages (fed by workflow:job /
 * workflow:stage through onWorkflowJob / onWorkflowStage), what each role is doing right now, the
 * requestAnimationFrame scheduler the canvas particles and sub-agent orbits run on (only while something
 * runs; off under prefers-reduced-motion), and the composer chip. */
import { h } from "../core/dom.js";
import { state } from "../core/state.js";
import { icon } from "../icons.js";
import { toggle } from "../settings/controls.js";
import { PRIMARY, ROLES, S, WORKERS, activeSessionId, activeWorkflow, isOpen, setWorkflowEnabled, tabWorkflow } from "./model.js";

export const LIVE = new Set(["queued", "running"]);
export const TERMINAL = new Set(["done", "error", "stopped"]);
export const AG_TERMINAL = new Set(["done", "error", "stopped", "interrupted"]);   // sub-agent records (mirrors panels/agents.js)
export const BADGE_MS = 6000;

/* ----------------------------- events → state ----------------------------- */
export function onWorkflowJob(payload) {
  const job = payload && (payload.job || (payload.id ? payload : null));
  if (!job || !job.id) return;
  const prev = state.workflow.jobs.get(job.id);
  state.workflow.jobs.set(job.id, prev ? { ...prev, ...job } : job);
  notify();
}
export function onWorkflowStage(payload) {
  if (!payload || !payload.sessionId) return;
  state.workflow.stages.set(payload.sessionId, { ...payload, at: Date.now() });
  notify();
}
export function workflowJobsFor(sessionId) {
  if (!sessionId) return [];
  return [...state.workflow.jobs.values()].filter((j) => j && j.parentId === sessionId).sort((a, b) => toMs(a.startedTs) - toMs(b.startedTs));
}
// Coalesce bursts of job events into one re-render per frame.
export let _pending = false;
export function notify() {
  if (_pending) return;
  _pending = true;
  const flush = () => { _pending = false; if (S.onLive && isOpen()) { try { S.onLive(); } catch (e) { console.error(e); } } refreshWorkflowChip(); refreshBoardChip(); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush); else setTimeout(flush, 16);
}

/* ----------------------------- what a role is doing ----------------------------- */
export function toMs(v) { if (!v) return 0; if (typeof v === "number") return v; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : 0; }
export function jobElapsedMs(job) {
  if (!job) return 0;
  if (TERMINAL.has(job.status) && job.durationMs) return job.durationMs;
  const from = toMs(job.startedTs); if (!from) return 0;
  const to = job.endedTs ? toMs(job.endedTs) : Date.now();
  return Math.max(0, to - from);
}
export function jobEndMs(job) { return toMs(job && job.endedTs) || (job && job.startedTs ? toMs(job.startedTs) + (job.durationMs || 0) : 0); }
export function fmtSpan(ms) { ms = Math.max(0, Math.round(+ms || 0)); const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; }
export function roleJobs(role, sessionId) { return workflowJobsFor(sessionId).filter((j) => j.role === role); }
// { status: idle|queued|running|done|error|stopped, jobs, running, queued, last, startedAt, endedAt, agents }
export function roleLive(role, sessionId) {
  const jobs = roleJobs(role, sessionId);
  const running = jobs.filter((j) => j.status === "running"), queued = jobs.filter((j) => j.status === "queued");
  if (running.length) {
    const pausedJob = running.find((j) => j.paused);   // "offline" | "auth-expired" | "ratelimited" while the child turn waits
    // agents = the role's sub-agents working right now (every role has its own lane); cap = the largest lane among its running jobs
    return { status: "running", jobs, running, queued, startedAt: Math.min(...running.map((j) => toMs(j.startedTs) || Date.now())), agents: running.reduce((n, j) => n + ((j.agentsLive && j.agentsLive.running) || 0), 0), cap: running.reduce((n, j) => Math.max(n, +j.agents || 0), 0), paused: pausedJob ? String(pausedJob.paused) : "" };
  }
  if (queued.length) return { status: "queued", jobs, running, queued, startedAt: 0, agents: 0, cap: 0 };
  const done = jobs.filter((j) => TERMINAL.has(j.status)).sort((a, b) => jobEndMs(b) - jobEndMs(a));
  if (done.length) return { status: done[0].status, jobs, running, queued, last: done[0], endedAt: jobEndMs(done[0]), agents: 0, cap: 0 };
  return { status: "idle", jobs, running, queued, agents: 0, cap: 0 };
}
export function primaryStage(sessionId) { return (sessionId && state.workflow.stages.get(sessionId)) || null; }
/* Is the Orchestrator's own turn running? Only with the workflow ON — off, the chat runs solo and there is
 * no orchestrator (the node used to say "thinking…" for any running tab, 2026-09-17). The tab's status is
 * the source of truth; an "orchestrator running" stage event counts only until the tab's status changed
 * after it, so a stage whose terminal event never arrived cannot keep the node thinking. */
export function primaryRunning(sessionId) {
  if (!tabWorkflow(sessionId).enabled) return false;   // that tab's own workflow (or the project's) — per-session selection
  const ts = sessionId && state.tabs.get(sessionId);
  if (ts && ts.meta && ts.meta.status === "running") return true;
  const st = primaryStage(sessionId);
  return !!(st && st.stage === PRIMARY && st.status === "running" && st.at && !(ts && ts._statusAt > st.at));
}
export function primaryLive(sessionId) {
  if (primaryRunning(sessionId)) return { status: "running", jobs: [], running: [], queued: [], startedAt: 0, agents: 0 };
  const st = primaryStage(sessionId);
  if (st && st.stage === PRIMARY && (st.status === "done" || st.status === "error") && st.at) return { status: st.status, jobs: [], running: [], queued: [], endedAt: st.at, agents: 0 };
  return { status: "idle", jobs: [], running: [], queued: [], agents: 0 };
}
export function anythingRunning(sessionId) { return primaryRunning(sessionId) || WORKERS.some((r) => roleLive(r, sessionId).status === "running"); }
/* A role's live sub-agents: the child tab's records when that tab is open, else the list the job's
 * agentsLive carries (main keeps it current — workflow.js jobAgentsChanged), else placeholders from
 * the running count. Every role has its own lane, so every role is asked (2026-09-17). */
export function liveSubAgentsFor(role, sessionId) {
  const out = [];
  for (const job of roleJobs(role, sessionId).filter((j) => j.status === "running")) {
    const ts = job.sessionId && state.tabs.get(job.sessionId);
    if (ts && Array.isArray(ts.agents) && ts.agents.length) { for (const a of ts.agents) if (!AG_TERMINAL.has(a.status)) out.push({ n: a.n, status: a.status, description: a.description || "", progress: a.progress || "", jobId: job.id }); continue; }
    const list = job.agentsLive && Array.isArray(job.agentsLive.list) ? job.agentsLive.list : null;
    if (list && list.length) { for (const a of list) out.push({ n: a.n, status: a.status || "running", description: a.description || "", progress: a.progress || "", jobId: job.id }); continue; }
    const n = (job.agentsLive && job.agentsLive.running) || 0;
    for (let i = 0; i < n; i++) out.push({ n: i + 1, status: "running", description: "", progress: "", jobId: job.id });
  }
  return out;
}
export function liveSubAgents(sessionId) { return liveSubAgentsFor("coder", sessionId); }
/* A role's sub-agent counters for the studio (user request 2026-09-18): `running` = its agents working right
 * now across its running jobs; `used` = agents spawned so far in this session for the role. A role keeps ONE
 * session per orchestrator, and main reports the child registry's running / total on every job (agentsLive),
 * so `used` is the largest total seen per child session (the open child tab's registry when fresher), summed
 * over the role's sessions — never the per-job totals added up, which would count the same agents twice. */
export function roleAgentStats(role, sessionId) {
  const jobs = roleJobs(role, sessionId);
  let running = 0, orphan = 0; const perSession = new Map();
  for (const j of jobs) {
    const al = j.agentsLive || {};
    if (j.status === "running") running += +al.running || 0;
    const total = +al.total || 0;
    if (j.sessionId) perSession.set(j.sessionId, Math.max(perSession.get(j.sessionId) || 0, total)); else orphan += total;
  }
  let used = orphan;
  for (const [sid, t] of perSession) { const ts = state.tabs.get(sid); const reg = ts && Array.isArray(ts.agents) ? ts.agents.length : 0; used += Math.max(t, reg); }
  return { running, used, jobs: jobs.length, live: jobs.filter((j) => LIVE.has(j.status)).length };
}
/* The active tab's task board in the numbers the studio shows live: the active set (else the whole
 * board) split into ongoing (doing · review · test), remaining (todo · blocked) and done. null = no board. */
export function boardStats(sessionId) {
  const ts = sessionId && state.tabs.get(sessionId); const b = ts && ts.board;
  if (!b || typeof b !== "object") return null;
  const sets = Array.isArray(b.sets) ? b.sets : [], items = (Array.isArray(b.items) ? b.items : []).filter(Boolean);
  const set = sets.find((s) => s && b.active != null && s.id === b.active) || sets.find((s) => s && s.status === "active") || null;
  const mine = set ? items.filter((i) => i.setId === set.id) : items;
  if (!mine.length && !sets.length) return null;
  const st = (i) => String(i.status || "todo").toLowerCase();
  return {
    set, title: set ? (String(set.title || "").trim() || `Set ${set.n}`) : "All sets", total: mine.length, items: mine,
    ongoing: mine.filter((i) => ["doing", "review", "test"].includes(st(i))), remaining: mine.filter((i) => ["todo", "blocked"].includes(st(i))), done: mine.filter((i) => st(i) === "done"),
  };
}
export function agentHue(n) { return Math.round(((+n || 0) * 137.508) % 360); }   // mirrors chat/messages.js agentHue
export function statusLabel(st, paused) { return st === "running" ? (paused ? "paused" : "running") : st === "queued" ? "queued" : st === "done" ? "done" : st === "error" ? "failed" : st === "stopped" ? "stopped" : "idle"; }
export function pausedLabel(p) { return p === "auth-expired" ? "sign-in expired" : p === "ratelimited" ? "rate limited" : p === "offline" ? "offline" : String(p || ""); }
// One line for the chip / status texts: "orchestrator thinking" · "coder ×2 · 5 agents" · "planner · tester".
export function stageSummary(sessionId) {
  const parts = [];
  for (const r of WORKERS) {
    const live = roleLive(r, sessionId);
    if (live.status !== "running") continue;
    let s = ROLES[r].name.toLowerCase();
    if (live.running.length > 1) s += ` ×${live.running.length}`;
    if (live.agents) s += ` · ${live.agents} agent${live.agents === 1 ? "" : "s"}`;   // any role's sub-agents
    if (live.paused) s += ` (${pausedLabel(live.paused)})`;
    parts.push(s);
  }
  if (!parts.length && primaryRunning(sessionId)) parts.push("orchestrator thinking");
  return parts.join(" · ");
}

/* ----------------------------- animation scheduler ----------------------------- */
export let _raf = 0;
export let _last = 0;
export const _tickers = new Set();
export function reducedMotion() { try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch { return false; } }
// fn(dt, now) → return false when there is nothing left to animate (the loop stops by itself).
export function addTicker(fn) { _tickers.add(fn); ensureAnim(); }
export function removeTicker(fn) { _tickers.delete(fn); }
export function ensureAnim() { if (_raf || !_tickers.size || reducedMotion()) return; _last = performance.now(); _raf = requestAnimationFrame(frame); }
export function frame(now) {
  _raf = 0;
  const dt = Math.min(64, Math.max(0, now - _last)); _last = now;
  for (const fn of [..._tickers]) { let keep = true; try { keep = fn(dt, now) !== false; } catch (e) { console.error(e); keep = false; } if (!keep) _tickers.delete(fn); }
  if (_tickers.size) _raf = requestAnimationFrame(frame);
}

/* ----------------------------- composer chips ----------------------------- */
export let _chip = null;
export function workflowChip() {
  // A div, not a button: the chip carries its own on/off switch (a button) — buttons cannot nest (2026-09-18).
  const open = () => import("./studio.js").then((m) => m.openWorkflowStudio()).catch((err) => console.error(err));
  const el = h("div", { id: "wfChip", class: "wf-chip", role: "button", tabindex: "0", title: "Workflow studio — design how the Orchestrator drives the Planner, Coder, Reviewer and Tester", onclick: (e) => { e.stopPropagation(); open(); }, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } });
  el._refresh = () => renderChip(el);
  el._refresh();
  _chip = el;
  return el;
}
export function refreshWorkflowChip() {
  const el = (_chip && _chip.isConnected) ? _chip : document.getElementById("wfChip");
  if (el && el._refresh) el._refresh();
}
// The workflow chip: the workflow's name and its live stage. The task board's progress moved to its own
// pill (taskBoardChip) on 2026-09-17 — a long set title used to swallow the whole chip.
export function renderChip(el) {
  const wf = activeWorkflow();
  const sid = activeSessionId();
  const hidden = el.classList.contains("hidden") ? " hidden" : "";   // the composer may hide the chip; keep its choice
  el.innerHTML = "";
  // The switch turns THIS tab's workflow on or off without opening the studio (user request 2026-09-18). Off keeps
  // the design, so on brings the same roles, lanes, skills and role sessions back; on asks first when solo
  // sub-agents are on (they turn off). A cancelled or failed flip puts the knob back.
  const sw = toggle(!!wf.enabled, async (v) => { const r = await setWorkflowEnabled(v); if (!r) sw._set(!!tabWorkflow(activeSessionId()).enabled); refreshWorkflowChip(); }, { label: wf.enabled ? `Turn the workflow off for this tab (its design is kept)` : `Turn the workflow "${wf.name || "Workflow"}" on for this tab` });
  sw.classList.add("wf-chip-sw"); sw.title = wf.enabled ? "Turn the workflow off for this tab — its design is kept" : `Turn "${wf.name || "Workflow"}" on for this tab`;
  sw.addEventListener("click", (e) => e.stopPropagation());
  sw.addEventListener("keydown", (e) => e.stopPropagation());
  if (!wf.enabled) {
    el.className = "wf-chip off" + hidden;
    el.append(sw, h("span", { class: "wf-chip-ic", html: icon("agents", 13) }), h("span", { class: "wf-chip-text", text: "Workflow off" }), h("span", { class: "wf-chip-stage wf-chip-name", text: wf.name && wf.name !== "Solo" ? "· " + wf.name : "" }));
    return;
  }
  const stage = stageSummary(sid);
  el.className = "wf-chip on" + (stage ? " live" : "") + hidden;
  el.append(sw, stage ? h("span", { class: "ag-orbit sm wf-chip-orbit", "aria-hidden": "true" }, h("i"), h("i"), h("i")) : h("span", { class: "wf-chip-ic", html: icon("agents", 13) }),
    h("span", { class: "wf-chip-text", text: wf.name || "Workflow" }));
  if (stage) el.append(h("span", { class: "wf-chip-stage", text: "· " + stage }));   // native append() would print a null kid
}

/* ----------------------------- the Task board pill ----------------------------- */
/* A pill next to the workflow chip (user request 2026-09-17): "Task board · 3/8" for the active tab's
 * board — shown while the workflow is on or the tab has a board — and a click opens (or closes) the Board
 * dock, the drawer with every set, task, status, note and linked job. Lit while a role is working a task
 * (doing · review · test); hidden when there is neither a workflow nor a board. */
export let _boardChip = null;
export function taskBoardChip() {
  const el = h("button", { id: "boardChip", class: "wf-chip board hidden", type: "button", title: "Task board — every set, task, status and note of this session", onclick: (e) => { e.stopPropagation(); import("../panels/changes.js").then((m) => m.toggleBoard()).catch((err) => console.error(err)); } });
  el._refresh = () => renderBoardChip(el);
  el._refresh();
  _boardChip = el;
  return el;
}
export function refreshBoardChip() {
  const el = (_boardChip && _boardChip.isConnected) ? _boardChip : document.getElementById("boardChip");
  if (el && el._refresh) el._refresh();
}
export function renderBoardChip(el) {
  const sid = activeSessionId();
  const b = boardStats(sid);
  const wf = activeWorkflow();
  el.innerHTML = "";
  if (!wf.enabled && !b) { el.className = "wf-chip board hidden"; return; }
  const live = !!(b && b.ongoing.length);
  el.className = "wf-chip board" + (b ? " has-board" : "") + (live ? " live" : "");
  el.append(live ? h("span", { class: "ag-orbit sm wf-chip-orbit", "aria-hidden": "true" }, h("i"), h("i"), h("i")) : h("span", { class: "wf-chip-ic", html: icon("checkCircle", 13) }),
    h("span", { class: "wf-chip-text", text: "Task board" }));
  if (b) {
    el.append(h("span", { class: "wf-chip-stage wf-chip-board", text: `· ${b.done.length}/${b.total}` }));
    el.title = `${b.title} — ${b.ongoing.length} ongoing · ${b.remaining.length} remaining · ${b.done.length} done. Click to open the board.`;
  } else el.title = "Task board — the Orchestrator creates tasks with atomnano tasks add …; click to open the board.";
}
