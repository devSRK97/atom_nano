/* AtomNano renderer — Agents dock: every sub-agent the primary agent launched in this session —
 * live (running / waiting), history (grouped by the turn that launched them) and a timeline —
 * plus the CPU governor's picture (cores, load, slots, throttling). Records come from the main
 * process registry (agents:update) and are kept on the tab (ts.agents); per-agent Stop goes
 * through the live query's stopTask. Shared helpers for the composer strip / button live here. */
import { $, h, toast } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { icon } from "../icons.js";
import { agentHue, isAgentTool } from "../chat/messages.js";
import { jumpToMessage } from "../chat/navigation.js";
import { currentDock, dockHead, showDock, toggleDock } from "./changes.js";

export const AG_TERMINAL = new Set(["done", "error", "stopped", "interrupted"]);
export const AG_STATUS_LABEL = { queued: "Queued", waiting: "Waiting for CPU", running: "Running", done: "Done", error: "Failed", stopped: "Stopped", interrupted: "Interrupted" };

export function liveAgents(ts) { return (ts && Array.isArray(ts.agents) ? ts.agents : []).filter((a) => !AG_TERMINAL.has(a.status)); }
export function agentByToolUse(ts, toolUseId) { if (!ts || !toolUseId || !Array.isArray(ts.agents)) return null; for (let i = ts.agents.length - 1; i >= 0; i--) if (ts.agents[i].toolUseId === toolUseId) return ts.agents[i]; return null; }
// Registry update → the tab's copy (by number).
export function upsertAgentRecord(ts, agent) {
  if (!ts || !agent) return;
  if (!Array.isArray(ts.agents)) ts.agents = [];
  const i = ts.agents.findIndex((a) => a.n === agent.n);
  if (i >= 0) ts.agents[i] = agent; else ts.agents.push(agent);
}
export function fmtAgo(iso) { if (!iso) return ""; const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`; }
export function fmtSpan(ms) { ms = Math.max(0, Math.round(+ms || 0)); const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; }
// Elapsed for a record: its own duration when finished, else since it started (or was announced).
export function agentElapsedMs(a) { if (!a) return 0; if (a.durationMs && AG_TERMINAL.has(a.status)) return a.durationMs; const from = a.startedTs || a.ts; if (!from) return 0; const to = a.endedTs ? new Date(a.endedTs).getTime() : Date.now(); return Math.max(0, to - new Date(from).getTime()); }
export function fmtTokens(n) { n = Math.round(+n || 0); return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(n); }

/* ---------------- slots line (the dock, the settings page) ----------------
 * One line: running · free slots · the cap. `running` comes from the registry (main adjusts the
 * snapshot — the governor's holds alone miss agents of full-access runs). The CPU picture (busy %,
 * yielding, waiting) shows only while "Yield to heavy processes" is on; the per-core grid is gone
 * (user request 2026-09-17: no cores section). */
export function renderCpuMeter(snap, { compact = false } = {}) {
  const wrap = h("div", { class: "cpu-meter" + (compact ? " compact" : "") });
  if (!snap) { wrap.append(h("span", { class: "cpu-line muted", text: "Reading the machine…" })); return wrap; }
  const gov = snap.governor === true;
  const running = snap.running || 0, allowed = gov ? (snap.allowedNow || snap.userMax) : snap.userMax, free = Math.max(0, allowed - running);
  const busy = Math.round(snap.ema || snap.busyPct || 0);
  wrap.append(h("span", { class: "cpu-slots" + (running ? " on" : ""), text: `${running} running` }), h("span", { class: "cpu-slots", text: `${free} slot${free === 1 ? "" : "s"} free` }), h("span", { class: "cpu-slots", text: `up to ${snap.userMax}` }));
  if (gov) wrap.append(h("span", { class: "cpu-busy" + (busy >= 90 ? " hot" : busy >= 70 ? " warm" : ""), title: `${snap.cores} cores`, text: `CPU ${busy}% busy` }));
  if (snap.throttled) wrap.append(h("span", { class: "cpu-throttle", title: "The machine stayed saturated: the agent process runs at lower priority until the load drops", text: "yielding CPU" }));
  if (snap.waiting) wrap.append(h("span", { class: "cpu-waiting", text: `${snap.waiting} waiting` }));
  return wrap;
}

/* ---------------- the dock ---------------- */
export let agentsView = "live";           // live | history | timeline
export const agentsExpanded = new Set();  // agent numbers whose brief/result are expanded
let _ticker = null, _renderTimer = null, _cpuSnap = null;

export function toggleAgents() {
  if (currentDock() === "agents") { showDock(null); stopAgentsTicker(); return; }
  showDock("agents"); renderAgents(); refreshAgentsDock();
}
export function openAgents(view) { if (view) agentsView = view; if (currentDock() !== "agents") showDock("agents"); renderAgents(); refreshAgentsDock(); }
// Open the drawer ON one agent (a strip chip, a popover row): its card expanded, scrolled into view.
export function focusAgent(n) {
  const ts = activeTS(); const a = ts && Array.isArray(ts.agents) ? ts.agents.find((x) => x.n === n) : null;
  agentsView = a && AG_TERMINAL.has(a.status) ? "history" : "live";
  agentsExpanded.add(n);
  if (currentDock() !== "agents") showDock("agents");
  renderAgents(); refreshAgentsDock();
  requestAnimationFrame(() => { const card = document.querySelector(`#agentsPanel .ag-card[data-n="${n}"]`); if (card) { card.scrollIntoView({ block: "center", behavior: "smooth" }); card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1400); } });
}
// Pull the registry + CPU picture from main (a tab opened before the panel has the view's copy only).
export async function refreshAgentsDock() {
  const ts = activeTS(); if (!ts) return;
  try { const r = await atom.agents.list(ts.meta.id); if (r && Array.isArray(r.agents)) ts.agents = r.agents; } catch { /* keep the tab's copy */ }
  try { _cpuSnap = await atom.agents.cpu(); } catch { /* */ }
  if (currentDock() === "agents") renderAgents();
}
export function updateCpuMeter(snap) { _cpuSnap = snap || _cpuSnap; const host = $("agentsCpu"); if (host && currentDock() === "agents") { host.innerHTML = ""; host.append(renderCpuMeter(_cpuSnap)); } }
export function scheduleAgentsRender() { if (currentDock() !== "agents") return; clearTimeout(_renderTimer); _renderTimer = setTimeout(() => { _renderTimer = null; renderAgents(); }, 120); }
function startAgentsTicker() { if (!_ticker) _ticker = setInterval(() => { const ts = activeTS(); if (currentDock() !== "agents" || !ts || !liveAgents(ts).length) { stopAgentsTicker(); return; } renderAgents(); }, 1000); }
function stopAgentsTicker() { if (_ticker) { clearInterval(_ticker); _ticker = null; } }

export function renderAgents() {
  const panel = $("agentsPanel");
  if (!panel || panel.classList.contains("hidden")) return;
  const ts = activeTS();
  const list = ts && Array.isArray(ts.agents) ? ts.agents : [];
  const live = liveAgents(ts);
  const listEl = panel.querySelector(".ag-list");
  const scrollTop = listEl ? listEl.scrollTop : 0;
  panel.innerHTML = "";
  panel.append(dockHead("agents", "Agents", `${live.length} running · ${list.length} total`, toggleAgents, [
    h("button", { class: "dock-mini", title: "Refresh", html: icon("refresh", 14), onclick: () => refreshAgentsDock() }),
  ]));
  const cpu = h("div", { class: "ag-cpu", id: "agentsCpu" }, renderCpuMeter(_cpuSnap));
  panel.append(cpu);
  const tabs = h("div", { class: "ag-tabs" });
  for (const [id, label] of [["live", `Live${live.length ? " · " + live.length : ""}`], ["history", "History"], ["timeline", "Timeline"]]) {
    tabs.append(h("button", { class: "ag-tab" + (agentsView === id ? " active" : ""), text: label, onclick: () => { agentsView = id; renderAgents(); } }));
  }
  panel.append(tabs);
  const body = h("div", { class: "ag-list" });
  if (!ts) body.append(h("div", { class: "dock-empty", text: "Open a conversation to see its agents." }));
  else if (agentsView === "live") renderLiveView(body, ts, live);
  else if (agentsView === "history") renderHistoryView(body, ts, list);
  else renderTimelineView(body, ts, list);
  panel.append(body);
  body.scrollTop = scrollTop;
  if (live.length) startAgentsTicker();
}

function statusChip(a) { return h("span", { class: "ag-status st-" + a.status, text: AG_STATUS_LABEL[a.status] || a.status }); }
function railStyle(a) { return `--ag-h:${agentHue(a.n)}`; }
function agentActions(ts, a) {
  const acts = h("div", { class: "ag-acts" });
  if (a.msgId) acts.append(h("button", { class: "ag-act", title: "Show this agent's card in the chat", html: icon("chat", 13), onclick: () => { if (!jumpToMessage(a.msgId)) toast("That card is not in view — scroll up to load it", "history"); } }));
  if (!AG_TERMINAL.has(a.status) && a.taskId) acts.append(h("button", { class: "ag-act danger", title: "Stop this agent (the others keep working)", html: icon("stop", 12), onclick: async () => { const r = await atom.agents.stop(ts.meta.id, a.taskId).catch((e) => ({ ok: false, detail: e.message })); toast(r && r.ok ? `Stopping agent #${a.n}…` : (r && r.detail) || "Could not stop the agent", r && r.ok ? "stop" : "alert"); } }));
  acts.append(h("button", { class: "ag-act", title: agentsExpanded.has(a.n) ? "Hide the brief" : "Show the brief and result", html: icon(agentsExpanded.has(a.n) ? "chevronDown" : "chevronRight", 13), onclick: () => { if (agentsExpanded.has(a.n)) agentsExpanded.delete(a.n); else agentsExpanded.add(a.n); renderAgents(); } }));
  return acts;
}
function agentDetail(a) {
  const det = h("div", { class: "ag-detail" });
  if (a.prompt) det.append(h("div", { class: "ag-det-label", text: "Brief" }), h("pre", { class: "ag-pre", text: a.prompt }));
  const meta = [];
  if (a.model) meta.push(["Model", a.model]);
  meta.push(["Background", a.background ? "yes" : "no"]);
  if (a.depth > 1) meta.push(["Depth", String(a.depth)]);
  if (a.startedTs) meta.push(["Started", new Date(a.startedTs).toLocaleTimeString()]);
  if (a.endedTs) meta.push(["Ended", new Date(a.endedTs).toLocaleTimeString()]);
  if (a.gate) meta.push(["CPU slot", a.gate === "waited" ? `granted after ${fmtSpan(a.waitMs)}` : a.gate]);
  if (a.taskId) meta.push(["Task", a.taskId]);
  det.append(h("div", { class: "ag-meta-grid" }, ...meta.map(([k, v]) => h("div", { class: "ag-meta-cell" }, h("span", { class: "k", text: k }), h("span", { class: "v", text: v })))));
  if (a.result) det.append(h("div", { class: "ag-det-label", text: AG_TERMINAL.has(a.status) ? "Result" : "Latest report" }), h("pre", { class: "ag-pre", text: a.result }));
  if (a.outputFile) det.append(h("div", { class: "ag-det-label", text: "Output file" }), h("pre", { class: "ag-pre", text: a.outputFile }));
  return det;
}
// One agent CARD in the drawer: head (number · robot · type · status · elapsed), the brief as the
// title, what it is doing now (or its result / last activity once ended), usage bits, actions.
// Its own class (.ag-card) — it used to share .ag-row with the popover's centred settings rows,
// which centred every line of the card (user report 2026-09-17).
function agentRow(ts, a, { compact = false } = {}) {
  const live = !AG_TERMINAL.has(a.status);
  const row = h("div", { class: "ag-card" + (live ? " live" : "") + (agentsExpanded.has(a.n) ? " open" : ""), style: railStyle(a), dataset: { n: String(a.n) } });
  const head = h("div", { class: "ag-card-head" },
    h("span", { class: "agent-num", text: `#${a.n}` }),
    h("span", { class: "ag-card-ico", html: icon("agents", 13) }),
    a.type ? h("span", { class: "agent-type", text: a.type }) : null,
    statusChip(a),
    live && a.status === "running" ? h("span", { class: "ag-orbit sm" }, h("i"), h("i"), h("i")) : null,
    h("span", { class: "spacer" }),
    h("span", { class: "ag-time", title: live ? "Running for" : "Took", text: fmtSpan(agentElapsedMs(a)) }));
  row.append(head);
  row.append(h("div", { class: "ag-desc", text: a.description || a.name || (live ? "Starting — the brief has not been reported yet" : "(no description)") }));
  if (live && (a.progress || a.status === "waiting")) row.append(h("div", { class: "ag-progress" }, h("span", { class: "ag-progress-text", text: a.status === "waiting" ? "Waiting for a free CPU slot — the machine is busy" : a.progress })));
  // An ended agent keeps what it reported — or, without a report, what it was last doing.
  else if (!compact && !live && (a.result || a.progress)) row.append(h("div", { class: "ag-result-preview", text: (a.result || `Last activity: ${a.progress}`).replace(/\s+/g, " ").slice(0, 140) }));
  const bits = [];
  if (a.toolUses) bits.push(`${a.toolUses} tool call${a.toolUses === 1 ? "" : "s"}`);
  if (a.lastTool && live) bits.push(`last: ${a.lastTool}`);
  if (a.tokens) bits.push(`${fmtTokens(a.tokens)} tokens`);
  if (a.background) bits.push("background");
  if (bits.length) row.append(h("div", { class: "ag-bits", text: bits.join(" · ") }));
  row.append(agentActions(ts, a));
  if (agentsExpanded.has(a.n)) row.append(agentDetail(a));
  return row;
}
function renderLiveView(body, ts, live) {
  if (!live.length) { body.append(h("div", { class: "dock-empty" }, h("div", { text: "No agents running." }), h("div", { class: "ag-hint", text: "Turn sub-agents on with the Agents button in the composer; Claude then delegates independent subtasks to numbered workers you can follow here." }))); return; }
  for (const a of live.slice().sort((x, y) => x.n - y.n)) body.append(agentRow(ts, a));
}
function turnLabel(ts, promptMessageId) {
  if (!promptMessageId) return "Earlier turns";
  const m = (ts.messages || []).find((x) => x.id === promptMessageId);
  return m && m.text ? m.text.replace(/\s+/g, " ").slice(0, 90) : "A previous turn";
}
function renderHistoryView(body, ts, list) {
  if (!list.length) { body.append(h("div", { class: "dock-empty", text: "No agents have run in this conversation yet." })); return; }
  const groups = new Map();
  for (const a of list.slice().sort((x, y) => y.n - x.n)) { const k = a.promptMessageId || ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  for (const [k, arr] of groups) {
    const done = arr.filter((a) => a.status === "done").length, failed = arr.filter((a) => a.status === "error").length;
    body.append(h("div", { class: "ag-group-head" }, h("span", { class: "ag-group-title", text: turnLabel(ts, k) }), h("span", { class: "ag-group-sum", text: `${arr.length} agent${arr.length === 1 ? "" : "s"} · ${done} done${failed ? ` · ${failed} failed` : ""}` })));
    for (const a of arr) body.append(agentRow(ts, a, { compact: true }));
  }
}
function renderTimelineView(body, ts, list) {
  const rows = list.slice(-60).filter((a) => a.ts);
  if (!rows.length) { body.append(h("div", { class: "dock-empty", text: "The timeline fills in as agents run." })); return; }
  const now = Date.now();
  const t0 = Math.min(...rows.map((a) => new Date(a.startedTs || a.ts).getTime()));
  const t1 = Math.max(now, ...rows.map((a) => (a.endedTs ? new Date(a.endedTs).getTime() : now)));
  const span = Math.max(1000, t1 - t0);
  const wrap = h("div", { class: "ag-timeline" });
  const axis = h("div", { class: "ag-axis" });
  for (let i = 0; i <= 4; i++) axis.append(h("span", { style: `left:${i * 25}%`, text: i === 0 ? "start" : "+" + fmtSpan((span * i) / 4) }));
  wrap.append(axis);
  for (const a of rows.slice().sort((x, y) => new Date(x.startedTs || x.ts) - new Date(y.startedTs || y.ts))) {
    const s = new Date(a.startedTs || a.ts).getTime(), e = a.endedTs ? new Date(a.endedTs).getTime() : now;
    const left = ((s - t0) / span) * 100, width = Math.max(0.8, ((e - s) / span) * 100);
    const live = !AG_TERMINAL.has(a.status);
    wrap.append(h("div", { class: "ag-tl-row", style: railStyle(a), title: `#${a.n} ${a.description || ""} — ${AG_STATUS_LABEL[a.status] || a.status}, ${fmtSpan(e - s)}`, onclick: () => { agentsView = "history"; agentsExpanded.add(a.n); renderAgents(); } },
      h("span", { class: "ag-tl-label" }, h("span", { class: "agent-num", text: `#${a.n}` }), h("span", { class: "ag-tl-desc", text: a.description || "" })),
      h("div", { class: "ag-tl-track" }, h("div", { class: "ag-tl-bar st-" + a.status + (live ? " live" : ""), style: `left:${left}%;width:${width}%` }))));
  }
  const total = rows.length, maxConc = Math.max(...rows.map((a) => { const s = new Date(a.startedTs || a.ts).getTime(); return rows.filter((b) => { const bs = new Date(b.startedTs || b.ts).getTime(), be = b.endedTs ? new Date(b.endedTs).getTime() : now; return bs <= s && be >= s; }).length; }));
  wrap.append(h("div", { class: "ag-tl-foot", text: `${total} agents · peak concurrency ${maxConc} · ${fmtSpan(span)} span` }));
  body.append(wrap);
}
// Guard against an import-only usage warning for isAgentTool (kept for the strip's card lookups).
export { isAgentTool };
