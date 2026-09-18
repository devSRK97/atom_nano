/* AtomNano renderer — The composer — prompt box, dropdowns, roles / reviewers controls, attachments, queue, send.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { MODELS, PERMS, PROVIDERS, THINKING, loadProviderModels } from "../core/catalog.js";
import { $, closeModal, confirmDialog, dropdown, h, modalShell, toast } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { createCheckpoint } from "../editor/checkpoints.js";
import { icon } from "../icons.js";
import { agentElapsedMs, fmtAgo, fmtSpan, fmtTokens, focusAgent, liveAgents, openAgents } from "../panels/agents.js";
import { toggleChanges } from "../panels/changes.js";
import { openSettings } from "../settings/settings.js";
import { activeWorkflow, onSoloAgentsChanged, refreshBoardChip, refreshWorkflowChip, setWorkflowEnabled, taskBoardChip, workflowChip } from "../workflow/index.js";
import { resumeAuthExpired } from "./events.js";
import { openSessionTab } from "./history.js";
import { agentHue, openImageViewer, renderLive, scrollBottom } from "./messages.js";
import { imgSrc, jumpToMessage } from "./navigation.js";
import { applyTabTip, renderTabs } from "./tabs.js";

/* ============================================================
   COMPOSER
   ============================================================ */
export let providerDD, modelDD, thinkDD, permDD;
// "Reviewers" — pick provider+model combos to consult before / review after.
// Reviewer providers — includes Claude so you can have a second Claude model
// critique the primary's answer (the primary's own model is excluded below).
export const RV_PROVIDERS = [
  { id: "anthropic", name: "Claude (Anthropic)", ph: "default model" },
  { id: "openai", name: "Codex (OpenAI)", ph: "gpt-5.5" },
];
export let _rvPop = null;
export function reviewersControl() {
  const btn = h("button", { id: "reviewersBtn", class: "rv-btn", onclick: (e) => { e.stopPropagation(); toggleReviewersPopover(btn); } });
  btn._refresh = () => { const n = (state.settings.reviewers || []).length; btn.innerHTML = `${icon("shield", 14, "dd-ico")}<span>Reviewers${n ? " · " + n : ""}</span>`; btn.classList.toggle("active", n > 0); };
  btn._refresh();
  return btn;
}
export function closeReviewersPopover() { if (_rvPop) { _rvPop.remove(); _rvPop = null; document.removeEventListener("mousedown", _rvOutside, true); } }
export function _rvOutside(e) { if (_rvPop && !_rvPop.contains(e.target) && !e.target.closest("#reviewersBtn")) closeReviewersPopover(); }
export function toggleReviewersPopover(anchor) {
  if (_rvPop) { closeReviewersPopover(); return; }
  const pop = h("div", { class: "rv-pop" });
  const renderPop = () => {
    pop.innerHTML = "";
    const mode = state.settings.reviewMode === "after" ? "after" : "before";
    pop.append(h("div", { class: "rv-pop-head" }, h("span", { html: icon("shield", 13) }), h("span", { text: "Reviewers" })));
    pop.append(h("div", { class: "rv-mode" },
      h("button", { class: "rv-mode-b" + (mode === "before" ? " active" : ""), text: "Consult before", title: "Reviewers advise, then Claude answers", onclick: () => { setSharedSetting("reviewMode", "before"); renderPop(); } }),
      h("button", { class: "rv-mode-b" + (mode === "after" ? " active" : ""), text: "Review after", title: "Claude answers, then reviewers critique", onclick: () => { setSharedSetting("reviewMode", "after"); renderPop(); } })));
    const primaryProv = state.settings.llmProvider || "anthropic";
    for (const prov of RV_PROVIDERS) {
      const cur = (state.settings.reviewers || []).find((r) => r.provider === prov.id);
      const cb = h("input", { type: "checkbox", class: "aqx-check" }); cb.checked = !!cur;
      // Model picker from the provider catalog. For the provider that's the
      // current primary, drop the primary model so a reviewer is always a
      // DIFFERENT model (review with a fresh perspective).
      const cat = (state.providerCatalog && state.providerCatalog[prov.id]) || { models: [] };
      const exclude = prov.id === primaryProv ? state.settings.defaultModel : null;
      const opts = (cat.models || []).filter((m) => m.id !== exclude);
      const model = h("select", { class: "rv-model input" });
      model.append(h("option", { value: "", text: "Default model" }));
      for (const m of opts) model.append(h("option", { value: m.id, text: m.name }));
      model.value = cur ? (cur.model || "") : "";
      const sync = () => {
        const arr = (state.settings.reviewers || []).filter((r) => r.provider !== prov.id);
        if (cb.checked) arr.push({ provider: prov.id, model: (model.value || "").trim() });
        setSharedSetting("reviewers", arr);
        const b = $("reviewersBtn"); if (b && b._refresh) b._refresh();
      };
      cb.addEventListener("change", sync); model.addEventListener("change", sync);
      pop.append(h("label", { class: "rv-row" }, cb, h("span", { class: "rv-prov", text: prov.name }), model));
    }
    pop.append(h("div", { class: "rv-pop-hint", text: "Reviewers run via their CLIs (authorize in Settings)." }));
  };
  renderPop();
  document.body.append(pop);
  placePop(pop, anchor);
  _rvPop = pop;
  setTimeout(() => document.addEventListener("mousedown", _rvOutside, true), 0);
}
// "Roles" — a per-session Planner that drafts a plan (its OWN provider/model/
// effort) before the primary Coder implements it. Pipeline: Plan → Code → Review.
// The Coder is your primary model (the model dropdown); Reviewers keep their own
// button. Configured exactly like Reviewers, so it feels the same.
export let _rolesPop = null;
export function rolesControl() {
  const btn = h("button", { id: "rolesBtn", class: "rv-btn", onclick: (e) => { e.stopPropagation(); toggleRolesPopover(btn); } });
  btn._refresh = () => { const on = !!(state.settings.planner && state.settings.planner.enabled); btn.innerHTML = `${icon("sparkle", 14, "dd-ico")}<span>Roles${on ? " · Plan→Code" : ""}</span>`; btn.classList.toggle("active", on); };
  btn._refresh();
  return btn;
}
export function closeRolesPopover() { if (_rolesPop) { _rolesPop.remove(); _rolesPop = null; document.removeEventListener("mousedown", _rolesOutside, true); } }
export function _rolesOutside(e) { if (_rolesPop && !_rolesPop.contains(e.target) && !e.target.closest("#rolesBtn")) closeRolesPopover(); }
export function toggleRolesPopover(anchor) {
  if (_rolesPop) { closeRolesPopover(); return; }
  const pop = h("div", { class: "rv-pop" });
  const getP = () => (state.settings.planner && typeof state.settings.planner === "object") ? state.settings.planner : { enabled: false, provider: "openai", model: "", effort: "" };
  const save = (patch) => { const p = { ...getP(), ...patch }; setSharedSetting("planner", p); const b = $("rolesBtn"); if (b && b._refresh) b._refresh(); };
  const render = () => {
    pop.innerHTML = "";
    const p = getP();
    pop.append(h("div", { class: "rv-pop-head" }, h("span", { html: icon("sparkle", 13) }), h("span", { text: "Roles — Plan → Code → Review" })));

    const cb = h("input", { type: "checkbox", class: "aqx-check" }); cb.checked = !!p.enabled;
    cb.addEventListener("change", () => save({ enabled: cb.checked }));
    const prov = h("select", { class: "rv-model input" });
    for (const rp of RV_PROVIDERS) prov.append(h("option", { value: rp.id, text: rp.name }));
    prov.value = p.provider || "openai";
    const cat = () => (state.providerCatalog && state.providerCatalog[prov.value]) || { models: [], reasoningLevels: [] };
    const model = h("select", { class: "rv-model input" });
    const effort = h("select", { class: "rv-model input" });
    const fillModel = () => { model.innerHTML = ""; model.append(h("option", { value: "", text: "Default model" })); for (const m of (cat().models || [])) model.append(h("option", { value: m.id, text: m.name })); model.value = p.model || ""; };
    const fillEffort = () => { effort.innerHTML = ""; effort.append(h("option", { value: "", text: "Default effort" })); for (const lv of (cat().reasoningLevels || [])) effort.append(h("option", { value: lv.id, text: lv.name })); effort.value = p.effort || ""; };
    fillModel(); fillEffort();
    prov.addEventListener("change", () => { save({ provider: prov.value, model: "", effort: "" }); render(); });
    model.addEventListener("change", () => save({ model: model.value }));
    effort.addEventListener("change", () => save({ effort: effort.value }));
    pop.append(h("label", { class: "rv-row" }, cb, h("span", { class: "rv-prov", text: "Planner" }), prov));
    pop.append(h("div", { class: "rv-row", style: "padding-left:26px; gap:6px;" }, model, effort));

    const primModel = state.settings.defaultModel || "your primary model";
    pop.append(h("div", { class: "rv-pop-hint", text: `Coder = your primary model (${primModel}) — set it in the model dropdown. Reviewers run after (Reviewers button).` }));
    pop.append(h("div", { class: "rv-pop-hint", text: "The Planner drafts a plan (reads the repo, never edits), then the Coder implements it in the same session — different models, no context lost." }));
    // The workflow's Orchestrator (with its own Planner role) replaces this Plan → Code role while a workflow is on.
    const tabWf = activeWorkflow();   // this tab's own workflow, or the project's (per-session selection)
    if (tabWf.enabled) pop.append(h("div", { class: "rv-pop-hint", text: `A workflow is active on this tab (${tabWf.name || "Custom"}) — its Orchestrator manages the Planner / Coder / Reviewer / Tester roles, so this Plan → Code role is not used until the workflow is turned off (Workflow studio…).` }));
  };
  render();
  document.body.append(pop);
  placePop(pop, anchor);
  _rolesPop = pop;
  setTimeout(() => document.addEventListener("mousedown", _rolesOutside, true), 0);
}
/* (The per-chat "Skills" control and its install popover left the composer on 2026-09-18: skills are
 * attached to workflow roles in the Workflow Studio's Skills modal (workflow/studio.js), the one skills UI.) */
/* ---------------- popover placement (shared) ----------------
 * Above the anchor when there is room (bottom-anchored, so an async-growing list grows upward and
 * never covers the button), else below; clamped to the viewport; overflow scrolls inside. */
export function placePop(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const gap = 8, margin = 10;
  const spaceAbove = r.top - margin - gap, spaceBelow = window.innerHeight - r.bottom - margin - gap;
  const useAbove = spaceAbove >= 160 && (spaceAbove >= spaceBelow || spaceAbove >= pop.offsetHeight + 20);
  pop.style.maxHeight = Math.max(200, useAbove ? spaceAbove : spaceBelow) + "px";
  pop.style.overflowY = "auto";
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  if (useAbove) { pop.style.bottom = (window.innerHeight - r.top + gap) + "px"; pop.style.top = "auto"; }
  else { pop.style.top = (r.bottom + gap) + "px"; pop.style.bottom = "auto"; }
}

/* ---------------- Agents: the composer button, its popover, the live strip ----------------
 * The button turns sub-agents on / off and shows how many run RIGHT NOW ("Agents · 3" — the
 * number is the live count; the cap lives in the popover and the tooltip). The popover is
 * compact by design (user request 2026-09-17): the switch and the cap on one row (1–20 — how
 * many may work at once; Claude decides WHEN delegating speeds the work up), the opt-in "yield
 * to heavy processes" switch, one status line, and the room goes to the agents running now.
 * The strip above the composer appears while agents run: one chip per agent, coloured and
 * numbered like its card; a click opens the Agents drawer on that agent. */
export const agentsMaxSetting = () => Math.max(1, Math.min(20, +state.settings.subAgentsMax || 3));
export function agentsControl() {
  // With the active tab's workflow ON the button says so and a click offers to turn solo sub-agents back on — which
  // turns the workflow off after asking (setSoloAgents); with the workflow OFF the normal button, popover and strip
  // return (user request 2026-09-18: "back to the normal agent").
  const btn = h("button", { id: "agentsBtn", class: "rv-btn agents-btn", onclick: (e) => { e.stopPropagation(); if (activeWorkflow().enabled) setSoloAgents(true); else toggleAgentsPopover(btn); } });
  btn._refresh = () => {
    const on = !!state.settings.subAgents, max = agentsMaxSetting();
    const ts = activeTS(); const live = ts ? liveAgents(ts).length : 0;
    const wfOn = activeWorkflow().enabled;
    if (wfOn) {
      btn.innerHTML = `${icon("agents", 14, "dd-ico")}<span>Agents · workflow</span>`;
      btn.classList.remove("active", "running"); btn.classList.add("wf-managed");
      btn.title = "Sub-agents are the roles' lanes while the workflow is on — configure them in the Workflow studio. Click to turn solo sub-agents back on (that turns the workflow off for this tab; its design is kept).";
      return;
    }
    btn.classList.remove("wf-managed");
    btn.innerHTML = `${icon("agents", 14, "dd-ico")}<span>Agents${live ? ` · ${live}` : ""}</span>${live ? `<span class="ag-live" title="${live} sub-agent${live === 1 ? "" : "s"} running"><span class="ag-orbit"><i></i><i></i><i></i></span></span>` : ""}`;
    btn.classList.toggle("active", on); btn.classList.toggle("running", live > 0);
    btn.title = on ? `Sub-agents on — ${live} running now, up to ${max} at once. Claude decides when delegating speeds the work up.` : "Sub-agents off — Claude does everything itself. Click to turn on.";
  };
  btn._refresh();
  onSoloAgentsChanged(() => refreshAgentsBtn());   // the workflow code flips the shared setting when a workflow turns on
  return btn;
}
export function refreshAgentsBtn() { const b = $("agentsBtn"); if (b && b._refresh) b._refresh(); }
/* Solo sub-agents ON while the active tab's workflow is on → ask, then turn the tab's workflow off (its design is
 * kept — the chip's switch turns it back on) and the shared setting on. The workflow and solo sub-agents are
 * exclusive (user decision 2026-09-18; the other direction lives in workflow/model.js setWorkflowEnabled).
 * Resolves true when the setting now has the wanted value, false when the user cancelled or the write failed. */
export async function setSoloAgents(on) {
  if (!!state.settings.subAgents === !!on) return true;
  if (on && activeWorkflow().enabled) {
    const wf = activeWorkflow();
    const ok = await confirmDialog({ title: "Turn on solo sub-agents?", ic: "agents", confirmLabel: "Turn on", message: `The workflow "${wf.name}" is on for this tab, and in a workflow the roles carry the sub-agent lanes. Turning solo sub-agents on turns the workflow off for this tab — its design is kept, and the Workflow chip's switch turns it back on.` });
    if (!ok) { refreshAgentsBtn(); return false; }
    const r = await setWorkflowEnabled(false);
    if (!r) { refreshAgentsBtn(); return false; }
  }
  setSharedSetting("subAgents", !!on);
  refreshAgentsBtn(); refreshWorkflowChip();
  return true;
}
export let _agPop = null;
export function closeAgentsPopover() { if (_agPop) { _agPop.remove(); _agPop = null; document.removeEventListener("mousedown", _agOutside, true); } }
export function _agOutside(e) { if (_agPop && !_agPop.contains(e.target) && !e.target.closest("#agentsBtn")) closeAgentsPopover(); }
// The bare on/off switch (no row) — the popovers compose it into rows.
export function switchControl(label, on, onChange) {
  const input = h("input", { type: "checkbox", class: "ag-switch-input" }); input.checked = !!on;
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "ag-switch" }, input, h("span", { class: "ag-switch-track" }, h("span", { class: "ag-switch-knob" })), h("span", { class: "ag-switch-label", text: label }));
}
// A labelled on/off switch row (shared by the agents and context popovers).
export function settingSwitch(label, on, onChange, hint) {
  return h("div", { class: "ag-row" }, switchControl(label, on, onChange), hint ? h("span", { class: "ag-hint", text: hint }) : null);
}
// One line of facts: running · free slots · the cap — the CPU picture only when the governor is on.
// "running" is the registry's count (every agent), never the governor's holds alone.
function agentsStatusLine() {
  const ts = activeTS(); const live = ts ? liveAgents(ts) : [];
  const max = agentsMaxSetting(), gov = state.settings.agentCpuGovernor === true, snap = state.cpu;
  const allowed = gov && snap && snap.allowedNow ? Math.min(snap.allowedNow, max) : max;
  const running = Math.max(live.length, gov && snap ? snap.running || 0 : 0);
  const free = Math.max(0, allowed - running);
  const parts = [`${running} running`, `${free} slot${free === 1 ? "" : "s"} free`, `up to ${max} at once`];
  if (gov && snap) { parts.push(`CPU ${Math.round(snap.ema || snap.busyPct || 0)}% busy`); if (snap.throttled) parts.push("yielding CPU"); if (snap.waiting) parts.push(`${snap.waiting} waiting`); }
  return h("div", { class: "ag-statusline" }, ...parts.map((t, i) => h("span", { class: i === 0 && running ? "on" : "", text: t })));
}
export function toggleAgentsPopover(anchor) {
  if (_agPop) { closeAgentsPopover(); return; }
  const pop = h("div", { class: "rv-pop ag-pop" });
  let statusHost = null, listHost = null;
  const drawStatus = () => { if (statusHost) { statusHost.innerHTML = ""; statusHost.append(agentsStatusLine()); } };
  // The running agents get the room: number, brief, what it is doing now, elapsed — a click opens the drawer on it.
  const drawList = () => {
    if (!listHost) return;
    const ts = activeTS(); const live = ts ? liveAgents(ts) : []; const on = !!state.settings.subAgents;
    listHost.innerHTML = "";
    listHost.append(h("div", { class: "ag-section", text: live.length ? `Running now · ${live.length}` : "Running now" }));
    const list = h("div", { class: "ag-mini-list" });
    if (!live.length) list.append(h("div", { class: "ag-hint", text: on ? "None right now — Claude delegates when parallel work speeds things up." : "Sub-agents are off." }));
    for (const a of live.slice().sort((x, y) => x.n - y.n).slice(0, 12)) {
      const starting = a.status === "queued" || a.status === "waiting";
      list.append(h("button", { class: "ag-mini st-" + a.status, style: `--ag-h:${agentHue(a.n)}`, title: [a.description, a.progress].filter(Boolean).join("\n") || "Open in the Agents drawer", onclick: () => { closeAgentsPopover(); focusAgent(a.n); } },
        h("span", { class: "agent-num", text: `#${a.n}` }),
        h("span", { class: "ag-mini-body" },
          h("span", { class: "ag-mini-desc", text: a.description || a.type || (starting ? "Starting…" : "agent") }),
          a.status === "waiting" ? h("span", { class: "ag-mini-prog", text: "waiting for a CPU slot" }) : a.progress ? h("span", { class: "ag-mini-prog", text: a.progress }) : null),
        h("span", { class: "ag-mini-time", text: fmtSpan(agentElapsedMs(a)) })));
    }
    if (live.length > 12) list.append(h("div", { class: "ag-hint", text: `+${live.length - 12} more in the Agents drawer` }));
    listHost.append(list);
  };
  const render = () => {
    pop.innerHTML = "";
    const on = !!state.settings.subAgents, max = agentsMaxSetting();
    const ts = activeTS(); const live = ts ? liveAgents(ts) : [];
    pop.append(h("div", { class: "rv-pop-head" }, h("span", { html: icon("agents", 14) }), h("span", { text: "Agents" }), h("span", { class: "spacer" }),
      h("button", { class: "ag-link", text: "Activity ›", title: "Open the Agents drawer — live agents, history, timeline", onclick: () => { closeAgentsPopover(); openAgents(live.length ? "live" : "history"); } })));
    // One row: the switch and — when on — the cap. Claude decides WHEN to delegate; the cap is how many may work at once.
    const row = h("div", { class: "ag-row ag-inline" }, switchControl("Sub-agents", on, async (v) => { await setSoloAgents(v); render(); }));   // asks first when the tab's workflow is on (it turns off)
    if (on) {
      const num = h("input", { type: "number", class: "ag-num", min: "1", max: "20", value: String(max), "aria-label": "How many sub-agents may run at once" });
      const setMax = (n) => { n = Math.max(1, Math.min(20, Math.round(+n) || 1)); num.value = String(n); setSharedSetting("subAgentsMax", n); refreshAgentsBtn(); drawStatus(); };
      num.addEventListener("change", () => setMax(num.value));
      row.append(h("span", { class: "spacer" }), h("span", { class: "ag-label sm", text: "up to" }),
        h("div", { class: "ag-stepper", title: "How many agents may work at the same time (1–20). Claude decides when delegating speeds the work up." }, h("button", { class: "ag-step", text: "−", title: "Fewer", onclick: () => setMax((+num.value || 1) - 1) }), num, h("button", { class: "ag-step", text: "+", title: "More", onclick: () => setMax((+num.value || 1) + 1) })),
        h("span", { class: "ag-label sm", text: "at once" }));
    }
    pop.append(row);
    if (on) pop.append(settingSwitch("Yield to heavy processes", state.settings.agentCpuGovernor === true, (v) => { setSharedSetting("agentCpuGovernor", v); render(); }, "Off: your cap is the limit. On: while a build saturates the CPU, new agents wait for a slot and run at lower priority."));
    statusHost = h("div", { class: "ag-status-host" }); pop.append(statusHost); drawStatus();
    listHost = h("div", { class: "ag-list-host" }); pop.append(listHost); drawList();
  };
  render();
  document.body.append(pop);
  placePop(pop, anchor);
  _agPop = pop; _agPop._drawStatus = drawStatus; _agPop._drawList = drawList;
  atom.agents.cpu().then((snap) => { state.cpu = snap; drawStatus(); }).catch(() => {});
  // Elapsed times and progress lines keep moving while the popover is open.
  const tick = setInterval(() => { if (_agPop !== pop) { clearInterval(tick); return; } drawList(); drawStatus(); }, 1000);
  setTimeout(() => document.addEventListener("mousedown", _agOutside, true), 0);
}
export function updateCpuStrip(snap) { if (snap) state.cpu = snap; if (_agPop && _agPop._drawStatus) _agPop._drawStatus(); }
let _stripTicker = null;
function stopStripTicker() { if (_stripTicker) { clearInterval(_stripTicker); _stripTicker = null; } }
export function renderAgentsStrip() {
  const host = $("agentsStrip"); const ts = activeTS();
  if (!host) return;
  if (!ts || state.settings.agentsStrip === false) { host.classList.add("hidden"); host.innerHTML = ""; stopStripTicker(); return; }
  const live = liveAgents(ts);
  if (!live.length) {
    // the last agent just finished: a "finished" line stays for a few seconds, then the strip goes
    if (ts._agentsLiveSeen && !ts._agentsStripUntil) ts._agentsStripUntil = Date.now() + 6000;
    if (!ts._agentsStripUntil || Date.now() > ts._agentsStripUntil) { host.classList.add("hidden"); host.innerHTML = ""; ts._agentsLiveSeen = false; ts._agentsStripUntil = 0; stopStripTicker(); return; }
    const n = ts._agentsLastCount || 0;
    host.innerHTML = ""; host.classList.remove("hidden");
    // The last activity of the agent that just ended stays readable on the finished line.
    const lastAct = ts._agentsLastActivity ? ` — last: ${ts._agentsLastActivity}` : "";
    host.append(h("button", { class: "ag-strip-head done", title: "Open the Agents panel", onclick: () => openAgents("history") }, h("span", { html: icon("check", 13) }), h("span", { text: `${n} agent${n === 1 ? "" : "s"} finished${lastAct}` }), h("span", { class: "ag-strip-more", text: "History ›" })));
    setTimeout(() => renderAgentsStrip(), 6200);
    return;
  }
  ts._agentsLiveSeen = true; ts._agentsStripUntil = 0; ts._agentsLastCount = Math.max(ts._agentsLastCount || 0, live.length);
  { const newest = live.slice().sort((x, y) => y.n - x.n)[0]; const act = newest && (newest.progress || newest.description); if (act) ts._agentsLastActivity = String(act).replace(/\s+/g, " ").slice(0, 90); }
  const waiting = live.filter((a) => a.status === "waiting").length;
  host.innerHTML = ""; host.classList.remove("hidden");
  host.append(h("button", { class: "ag-strip-head", title: "Open the Agents drawer", onclick: () => openAgents("live") },
    h("span", { class: "ag-strip-ico", html: icon("agents", 13) }), h("span", { class: "ag-orbit" }, h("i"), h("i"), h("i")), h("span", { text: `${live.length} agent${live.length === 1 ? "" : "s"} running${waiting ? ` · ${waiting} waiting for CPU` : ""}` }), h("span", { class: "ag-strip-more", text: "Details ›" })));
  const chips = h("div", { class: "ag-strip-chips" });
  // A chip opens the Agents drawer ON that agent (its card expanded) — the drawer is where its brief, progress and result live.
  for (const a of live.slice().sort((x, y) => x.n - y.n).slice(0, 8)) chips.append(h("button", { class: "ag-chip st-" + a.status, style: `--ag-h:${agentHue(a.n)}`, title: ((a.description || "") + (a.progress ? "\n" + a.progress : "")).trim() || "Open in the Agents drawer", onclick: () => focusAgent(a.n) },
    h("span", { class: "agent-num", text: `#${a.n}` }), h("span", { class: "ag-chip-desc", text: a.status === "waiting" ? "waiting for a CPU slot" : (a.progress || a.description || a.type || "agent") }), h("span", { class: "ag-chip-time", text: fmtSpan(agentElapsedMs(a)) })));
  if (live.length > 8) chips.append(h("span", { class: "ag-chip more", text: `+${live.length - 8}` }));
  host.append(chips);
  if (!_stripTicker) _stripTicker = setInterval(() => { const t = activeTS(); if (!t || !liveAgents(t).length) { stopStripTicker(); } renderAgentsStrip(); }, 1000);
}

/* ---------------- Context window chip + popover ----------------
 * How full the native thread is (measured by the CLI after its last reply, else estimated), the
 * effective window (a learned one is flagged), the rollover threshold, a one-shot "roll over on
 * the next message", and the rolling digest (what a fresh session would receive first). */
export function contextChip() {
  const btn = h("button", { id: "ctxChip", class: "ctx-chip hidden", onclick: (e) => { e.stopPropagation(); toggleContextPopover(btn); } });
  btn._refresh = () => {
    const ts = activeTS(); const info = ts && ts.ctxInfo;
    if (!info || !info.used) { btn.classList.add("hidden"); return; }
    const pct = Math.min(100, info.pct), roll = info.rolloverPct || 0;
    btn.classList.remove("hidden");
    const hot = (roll && pct >= roll - 5) || pct >= 92;
    btn.classList.toggle("hot", !!hot);
    btn.classList.toggle("warn", !hot && pct >= 70);
    btn.style.setProperty("--pct", String(pct));
    btn.innerHTML = `<span class="ctx-ring"></span><span class="ctx-text">Context ${info.pct}%</span>${info.learned ? '<span class="ctx-flag" title="The window was learned from a rejected request — smaller than the catalog says">!</span>' : ""}${info.forceRollover ? '<span class="ctx-flag roll" title="Rolls over to a fresh native session on the next message">↻</span>' : ""}`;
    btn.title = `${fmtTokens(info.used)} of ${fmtTokens(info.window)} tokens (${info.source === "measured" ? "measured by the CLI" : "estimated"})${roll ? ` · continues in a fresh session at ${roll}%` : ""}`;
  };
  btn._refresh();
  return btn;
}
export function refreshCtxChip() {
  const b = $("ctxChip"); if (!b || !b._refresh) return;
  const ts = activeTS();
  if (ts && !ts.ctxInfo && !ts._ctxFetching) { ts._ctxFetching = true; atom.context.info(ts.meta.id).then((info) => { ts.ctxInfo = info || null; ts._ctxFetching = false; b._refresh(); }).catch(() => { ts._ctxFetching = false; }); }
  b._refresh();
}
export let _ctxPop = null;
export function closeContextPopover() { if (_ctxPop) { _ctxPop.remove(); _ctxPop = null; document.removeEventListener("mousedown", _ctxOutside, true); } }
export function _ctxOutside(e) { if (_ctxPop && !_ctxPop.contains(e.target) && !e.target.closest("#ctxChip")) closeContextPopover(); }
export function toggleContextPopover(anchor) {
  if (_ctxPop) { closeContextPopover(); return; }
  const ts = activeTS(); if (!ts) return;
  const pop = h("div", { class: "rv-pop ctx-pop" });
  const render = (info) => {
    pop.innerHTML = "";
    pop.append(h("div", { class: "rv-pop-head" }, h("span", { html: icon("gauge", 13) }), h("span", { text: "Context window" })));
    if (!info) { pop.append(h("div", { class: "ag-hint", text: "No measurement yet — it appears after the first reply." })); return; }
    const pct = info.pct;
    pop.append(h("div", { class: "ctx-bar-wrap" },
      h("div", { class: "ctx-bar" }, h("div", { class: "ctx-bar-fill" + (pct >= 90 ? " hot" : pct >= 70 ? " warm" : ""), style: `width:${Math.min(100, pct)}%` }), info.rolloverPct ? h("div", { class: "ctx-bar-mark", style: `left:${Math.min(100, info.rolloverPct)}%`, title: `Rollover at ${info.rolloverPct}%` }) : null),
      h("div", { class: "ctx-nums", text: info.used ? `${fmtTokens(info.used)} of ${fmtTokens(info.window)} tokens · ${pct}% · ${info.source === "measured" ? "measured by the CLI" : "estimated from the last request"}${info.usageTs ? " · " + fmtAgo(info.usageTs) : ""}` : `Window ${fmtTokens(info.window)} tokens · nothing sent yet` })));
    const rows = [["Model", info.model || "—"], ["Window", `${fmtTokens(info.window)} tokens${info.learned ? ` — learned; the catalog says ${fmtTokens(info.believedWindow)}, a request was rejected at ~${fmtTokens(info.learnedFrom)}` : ""}`], ["Native thread", info.thread ? "attached" : "none yet"], ["CLI compactions", String(info.compactions || 0)], ["Record", `${info.totalEntries} entries`]];
    pop.append(h("div", { class: "ag-meta-grid ctx-grid" }, ...rows.map(([k, v]) => h("div", { class: "ag-meta-cell" }, h("span", { class: "k", text: k }), h("span", { class: "v", text: v })))));
    const seg = h("div", { class: "ag-seg" });
    for (const [v, label] of [[0, "Off"], [80, "80%"], [90, "90%"], [95, "95%"]]) seg.append(h("button", { class: (+info.rolloverPct || 0) === v ? "active" : "", text: label, onclick: () => { setSharedSetting("contextRolloverPct", v); reload(); } }));
    pop.append(h("div", { class: "ag-row" }, h("span", { class: "ag-label", text: "Roll over at" }), seg,
      h("span", { class: "ag-hint", text: "When the thread is this full, the next message continues in a fresh native session that receives the record — exact when it fits, else saved working memory plus selected recent evidence and access to the full history — before a request can fail with “prompt is too long”." })));
    pop.append(settingSwitch("Roll over on the next message", !!info.forceRollover, (v) => { atom.context.rollover(ts.meta.id, v).then(reload).catch(() => {}); }, "Start a fresh native session now; the record travels with it."));
    const d = info.digest;
    const dline = info.digestRunning ? "Updating the digest…" : d ? d.selected ? `Selected working memory through entry ${d.upTo} · ${d.calls || 0} model calls · ${fmtAgo(d.ts)}` : `Covers ${d.entries} of ${d.totalEntries} entries (${d.coversPct}%) · ${d.calls} model call${d.calls === 1 ? "" : "s"} · ${fmtAgo(d.ts)}` : "No digest yet — it is prepared automatically once the thread is half full.";
    pop.append(h("div", { class: "ag-section", text: "Rolling digest" }), h("div", { class: "ag-hint ctx-digest-line", text: dline }));
    pop.append(h("div", { class: "ag-row ctx-actions" },
      h("button", { class: "btn btn-ghost btn-sm", disabled: !!info.digestRunning || ts.meta.status === "running", text: d ? "Update digest" : "Build digest", onclick: async () => { const r = await atom.context.digest(ts.meta.id).catch((e) => ({ ok: false, detail: e.message })); if (!r || !r.ok) toast((r && r.detail) || "Could not build the digest", "alert"); reload(); } }),
      d ? h("button", { class: "btn btn-ghost btn-sm", text: "View digest", onclick: async () => { const text = await atom.context.digestText(ts.meta.id).catch(() => ""); const back = modalShell({ title: "Rolling digest — what a fresh session receives first", ic: "history", wide: true, body: h("pre", { class: "ag-pre ctx-digest-text", text: text || "(empty)" }), footer: [h("button", { class: "btn btn-primary", text: "Done", onclick: () => closeModal(back) })] }); } }) : null));
    pop.append(settingSwitch("Keep the digest ready", info.digestOn !== false, (v) => { setSharedSetting("contextDigest", v); reload(); }, "Extra model calls on the same model, only once the thread is half full; a rollover then reuses them."));
  };
  const reload = () => atom.context.info(ts.meta.id).then((info) => { ts.ctxInfo = info || null; refreshCtxChip(); render(info); placePop(pop, anchor); }).catch(() => {});
  render(ts.ctxInfo);
  document.body.append(pop);
  placePop(pop, anchor);
  _ctxPop = pop;
  reload();
  setTimeout(() => document.addEventListener("mousedown", _ctxOutside, true), 0);
}

export function buildComposer() {
  const host = $("composer");
  const ta = h("textarea", { id: "promptInput", rows: "1", placeholder: "Ask AtomNano…  (Enter to send · Shift+Enter newline · while running: Enter sends now — joins a Codex turn or Claude's live agents, else interrupts · Ctrl+Enter queues · Esc stops)" });
  ta.addEventListener("input", () => { autoGrow(); updateSendButton(); });
  // While running + text: Enter SENDS NOW (steers a Codex turn / joins Claude's live process when
  // agents run, otherwise interrupts and runs); Ctrl/Cmd+Enter adds it to the queue instead. The
  // primary button is Stop for the whole run — sending never hides it.
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e.ctrlKey || e.metaKey ? { queue: true } : { now: true }); } });
  ta.addEventListener("paste", onPaste);

  // Model / thinking / permission / 1M are SHARED across all sessions.
  providerDD = dropdown({ ic: "globe", items: PROVIDERS, getValue: () => state.settings.llmProvider || "anthropic", onSelect: (v) => {
    setSharedSetting("llmProvider", v);
    loadProviderModels(v, { announce: true });   // discover its models / reasoning / 1M flags
    // The composer-area auth banner is the persistent indicator now — the
    // brief toast is a nudge that fades; the banner stays until signed in.
    refreshAuthBanner();
    if (v === "google") toast("Switched to Antigravity — sign in if prompted.", "sparkle");
    else if (v === "openai") toast("Switched to OpenAI / Codex — sign in if prompted.", "sparkle");
    else if (v === "custom" && !state.settings.customApiBaseUrl) toast("Set a Custom API base URL + key in Settings → Providers.", "globe");
  } });
  modelDD = dropdown({ ic: "cpu", items: MODELS, getValue: () => state.settings.defaultModel, onSelect: (v) => setSharedSetting("defaultModel", v) });
  thinkDD = dropdown({ ic: "brain", items: THINKING, getValue: () => state.settings.defaultThinking, onSelect: (v) => setSharedSetting("defaultThinking", v) });
  permDD = dropdown({ ic: "shield", items: PERMS, getValue: () => state.settings.defaultPermissionMode, onSelect: (v) => setSharedSetting("defaultPermissionMode", v) });

  // While a reply is generating the PRIMARY button is always Stop (it never turns into a send
  // arrow — a click while the agent works stops it). Typed text adds two secondary buttons
  // before it: "Send now" (Enter: steer a Codex turn / join Claude's live agents, else
  // interrupt & run) and "Queue" (Ctrl+Enter: run after the current reply).
  const queueBtn = h("button", { id: "queueBtn", class: "send-btn queue-btn hidden", html: icon("list", 16), onclick: () => send({ queue: true }), title: "Add to queue — runs after the current reply (Ctrl+Enter)" });
  const nowBtn = h("button", { id: "nowBtn", class: "send-btn now-btn hidden", html: icon("arrowUp", 17), onclick: () => send({ now: true }), title: "Send now (Enter)" });
  const sendBtn = h("button", { id: "sendBtn", class: "send-btn", html: icon("arrowUp", 19), onclick: () => send(), title: "Send (Enter)" });
  // Roles (Planner) and Reviewers open from the chat-header ⋮ menu; Import too.
  // (Reviewers left the composer row on 2026-09-17 — user request.)
  const agentsBtn = agentsControl();         // sub-agents on/off, cap, live count
  const ctxChip = contextChip();             // context-window fill / rollover / digest (before the 1M indicator)
  const wfChip = workflowChip();             // the active workflow + its live stage; opens the Workflow studio (first after the spacer)
  const boardChip = taskBoardChip();         // "Task board · 3/8" while a workflow runs (or a board exists); opens the Board drawer (2026-09-17)

  // The 1M indicator: context follows the selected model automatically — a label, not a checkbox (2026-09-17).
  // It is kept in the DOM but never shown (user request, later the same day): the 1M context still
  // applies in the background (updateOneMVisibility keeps settings.oneM in step with the model).
  const oneM = h("span", { class: "onem-toggle hidden", id: "oneMWrap", title: "The selected model's 1M context window is used automatically" },
    h("span", { class: "om-ico", html: icon("sparkle", 12) }),
    h("span", { text: "1M context · Auto" }));

  // Image generation still works via "/image <prompt>".
  const stats = h("div", { class: "stats-strip", id: "statsStrip" });
  const tray = h("div", { class: "attach-tray hidden", id: "attachTray" });

  const box = h("div", { class: "composer-box", id: "composerBox" }, tray, ta,
    h("div", { class: "composer-toolbar" }, modelDD, thinkDD, permDD, h("div", { class: "spacer" }), queueBtn, nowBtn, sendBtn));
  // The primary-provider dropdown lives in the tab bar (chat header), first among
  // the header actions — it's a workspace-level choice, not a per-message one.
  const hp = $("headerProvider"); if (hp) { hp.innerHTML = ""; hp.append(providerDD); }
  ta.addEventListener("focus", () => box.classList.add("focused"));
  ta.addEventListener("blur", () => box.classList.remove("focused"));
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("dragover"); });
  box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove("dragover"); });
  box.addEventListener("drop", onDrop);

  host.innerHTML = "";
  host.append(h("div", { class: "composer-inner" },
    h("div", { class: "queue-strip hidden", id: "queueStrip" }),
    h("div", { class: "suggest-chips hidden", id: "suggestChips" }),
    h("div", { class: "agents-strip hidden", id: "agentsStrip" }),
    h("div", { class: "composer-meta" }, stats, h("div", { class: "spacer" }), wfChip, boardChip, agentsBtn, ctxChip, oneM),
    h("div", { class: "auth-banner hidden", id: "authBanner" }),
    box));
  refreshAuthBanner();
  renderSuggestChips();
}
// --- Prompt suggestion chip (promptSuggestions) ---------------------------
// One predicted next-prompt, shown after the reply. Click fills the composer.
export function renderSuggestChips() {
  const host = $("suggestChips"); if (!host) return;
  const ts = activeTS();
  const sug = ts && ts.suggestion;
  host.innerHTML = "";
  if (!sug || (ts && ts.meta.status === "running")) { host.classList.add("hidden"); return; }
  host.classList.remove("hidden");
  host.append(
    h("span", { class: "sc-ic", html: icon("sparkle", 12) }),
    h("button", { class: "suggest-chip", text: sug, title: "Use this prompt", onclick: () => {
      const ta = $("promptInput"); if (ta) { ta.value = sug; ta.dispatchEvent(new Event("input")); ta.focus(); }
      ts.suggestion = null; renderSuggestChips();
    } }),
    h("button", { class: "sc-x", html: icon("close", 11), title: "Dismiss", onclick: () => { ts.suggestion = null; renderSuggestChips(); } }));
}
// --- Live context-window usage --------------------------------------------
// Polls the running turn's real context fill (getContextUsage) and stashes it on
// the tab. No visible chip — the info surfaces in the session-tab hover tooltip
// (see usageTipText), alongside the plan-usage windows.
export let _ctxTimer = null;
export function startCtxMeter(sessionId) {
  stopCtxMeter();
  const tick = async () => {
    if (state.activeTabId !== sessionId) return;
    const ts = state.tabs.get(sessionId);
    if (!ts || ts.meta.status !== "running") { stopCtxMeter(); return; }
    try { const u = await atom.sessions.contextUsage(sessionId); if (u && u.totalTokens) { ts.ctxUsage = u; applyTabTip(); } } catch { /* between turns → ignore */ }
  };
  tick();
  _ctxTimer = setInterval(tick, 3000);
}
export function stopCtxMeter() { if (_ctxTimer) { clearInterval(_ctxTimer); _ctxTimer = null; } }
// Show a clear "sign-in required" banner above the composer when the active
// primary provider isn't authenticated yet. Reads atom.providers.authStatus()
// and renders provider-specific messaging + a one-click sign-in button that
// fires the same OAuth flow as Settings → Providers.
export async function refreshAuthBanner() {
  const el = $("authBanner");
  if (!el) return;
  const provider = state.settings.llmProvider || "anthropic";
  let st = {};
  try { st = await atom.providers.authStatus(); } catch { /* ignore — banner just stays hidden */ }
  const p = st[provider] || {};
  // "Signed in" means: an OAuth credential is on disk OR a user-set API key
  // covers this provider. For custom providers a baseUrl + key combo also
  // counts. If the provider entry was never returned, hide rather than scare.
  const signedIn = !!(p.loggedIn || p.key);
  if (signedIn || !PROVIDER_NEEDS_AUTH[provider]) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const meta = PROVIDER_NEEDS_AUTH[provider];
  el.innerHTML = "";
  el.classList.remove("hidden");
  el.append(
    h("span", { class: "auth-banner-ic", html: icon(meta.icon, 14) }),
    h("div", { class: "auth-banner-body" },
      h("div", { class: "auth-banner-title", text: meta.title }),
      h("div", { class: "auth-banner-sub", text: meta.sub })),
    h("button", { class: "btn btn-primary btn-sm", text: meta.action, onclick: async () => {
      if (provider === "custom") { openSettings(); return; }   // baseUrl + key form lives there
      try { await atom.providers.authorize(provider); if (meta.toast) toast(meta.toast, "globe"); }
      catch (e) { toast("Sign-in failed to open: " + e.message, "alert"); }
      // Re-check after a beat — browser auth finishes asynchronously.
      setTimeout(refreshAuthBanner, 4000);
      setTimeout(refreshAuthBanner, 12000);
    } }),
    h("button", { class: "auth-banner-x", html: icon("close", 12), title: "Dismiss for now", onclick: () => el.classList.add("hidden") }),
  );
}
// Per-provider auth banner copy. `anthropic` is excluded — its sign-in flow
// lives in the welcome screen + Settings → Storage already, and most users
// arrive already signed in via the Claude CLI.
export const PROVIDER_NEEDS_AUTH = {
  google: {
    icon: "globe",
    title: "Sign in to Antigravity to use Google as the primary",
    sub: "agy uses your Google account via browser OAuth. Tokens are stored in ~/.gemini/.",
    action: "Sign in",
    toast: "Antigravity login opened in a new window. Complete it in the browser, then return.",
  },
  openai: {
    icon: "globe",
    title: "Sign in to OpenAI / Codex to use it as the primary",
    sub: "codex login uses your OpenAI account via browser OAuth.",
    action: "Sign in",
    toast: "OpenAI login opened in a new window. Complete it, then return.",
  },
  custom: {
    icon: "key",
    title: "Configure your Custom provider to use it",
    sub: "Set a base URL and API key in Settings → Providers.",
    action: "Open settings",
    toast: "",
  },
};
export function renderQueue() {
  const el = $("queueStrip");
  if (!el) return;
  const ts = activeTS();
  const q = ts ? ts.queue : [];
  el.innerHTML = "";
  if (!q || !q.length) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const collapsed = !!(ts && ts._queueCollapsed);
  // Header doubles as a hide/show toggle for the whole queue.
  el.append(h("div", { class: "queue-head", title: collapsed ? "Show queued messages" : "Hide queued messages",
    onclick: () => { if (ts) { ts._queueCollapsed = !ts._queueCollapsed; renderQueue(); } } },
    h("span", { class: "qh-chev", html: icon(collapsed ? "chevronRight" : "chevronDown", 12) }),
    h("span", { html: icon("list", 12) }),
    h("span", { text: `Queued — runs after the current reply (${q.length})` })));
  if (collapsed) return;
  const list = h("div", { class: "queue-list" });   // scrollable, capped height
  q.forEach((item, i) => {
    list.append(h("div", { class: "queue-item" },
      h("span", { class: "queue-num", text: String(i + 1) }),
      h("span", { class: "queue-text", text: item.text || "(attachments only)" }),
      item.attachments && item.attachments.length ? h("span", { class: "queue-att", html: icon("file", 11) + " " + item.attachments.length }) : null,
      h("button", { class: "queue-copy", html: icon("copy", 12), title: "Copy queued text", onclick: async (e) => {
        const b = e.currentTarget;
        try { await atom.clipboard.write(item.text || ""); b.innerHTML = icon("check", 12); setTimeout(() => { b.innerHTML = icon("copy", 12); }, 1200); }
        catch { toast("Copy failed", "alert"); }
      } }),
      h("button", { class: "queue-x", html: icon("close", 12), title: "Remove from queue", onclick: () => { ts.queue.splice(i, 1); renderQueue(); } })));
  });
  el.append(list);
}
export function refreshComposer() {
  const ts = activeTS();
  if (!ts) return;
  if (providerDD) providerDD._refresh(); modelDD._refresh(); thinkDD._refresh(); permDD._refresh();
  const ta = $("promptInput");
  ta.value = ts.draft || "";
  const sa = $("subAgentsToggle"); if (sa) sa.checked = !!state.settings.subAgents;
  const sm = $("subAgentsMax"); if (sm) sm.classList.toggle("hidden", !state.settings.subAgents);
  const sv = $("subAgentsVal"); if (sv) sv.textContent = String(state.settings.subAgentsMax || 3);
  updateOneMVisibility();
  refreshAgentsBtn(); renderAgentsStrip(); refreshCtxChip(); refreshWorkflowChip(); refreshBoardChip();
  renderAttachments();
  renderQueue();
  updateStats();
  autoGrow();
  updateSendButton();
  // Rebind the SDK capability UIs (suggestion chip / live context meter) to the
  // now-active tab.
  renderSuggestChips();
  if (ts.meta.status === "running") startCtxMeter(ts.meta.id); else stopCtxMeter();
}
// Per Anthropic docs, the 1M-token context window is available on Opus 4.6+ and
// Sonnet 4.6+ (Haiku and Sonnet ≤4.5 are 200K). For these models 1M is the
// default; the context-1m beta we pass is the explicit opt-in (harmless if already on).
export function modelSupports1M(id) {
  // Provider-reported capability wins (covers Gemini + discovered ids); fall back
  // to the Anthropic version heuristic when we have no catalog entry.
  if (state.modelCaps && Object.prototype.hasOwnProperty.call(state.modelCaps, id)) return !!state.modelCaps[id];
  const m = /claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec((id || "").toLowerCase());
  if (!m) return /opus|sonnet|fable/i.test(id || "");    // fable + unknown opus/sonnet → assume supported
  const fam = m[1], major = +m[2], minor = +m[3];
  if (fam === "haiku") return false;
  return major > 4 || (major === 4 && minor >= 6);        // Opus/Sonnet 4.6+
}
// Context follows the selected model automatically. Keep the legacy stored flag
// in sync for older sessions/callers; it is no longer an opt-in that silently caps a model at 200K.
// The chip itself stays HIDDEN (user request 2026-09-17): the 1M context works in the background
// and the "on" class still records the state for anything that reads it.
export function updateOneMVisibility() {
  const wrap = $("oneMWrap");
  if (!wrap) return;
  const supported = modelSupports1M(state.settings.defaultModel);
  wrap.classList.toggle("hidden", true);
  if (!!state.settings.oneM !== supported) {
    state.settings.oneM = supported;
    atom.settings.set({ oneM: supported }).catch(() => {});
  }
  wrap.classList.toggle("on", supported);
}
// Model / thinking / permission / 1M are shared across every session.
export function setSharedSetting(key, val) {
  state.settings[key] = val;
  atom.settings.set({ [key]: val }).catch(() => {});
  if (key === "defaultModel") { updateOneMVisibility(); syncEffortForModel(); }
  // Picking a permission mode applies to the active tab's RUNNING turn too (Full access
  // must stop asking now, not at the next send): Claude's live setPermissionMode and the
  // app's own gate / Codex's per-request decisions all read the session's mode.
  if (key === "defaultPermissionMode") { const ts = activeTS(); if (ts && ts.meta) { ts.meta.permissionMode = val; atom.sessions.setModeLive(ts.meta.id, val).catch(() => {}); } }
}
// Codex models differ in the efforts they accept (GPT-5.5: low…x-high; 5.6 Sol:
// …max, ultra). Show only the picked model's ladder and move the selection to the
// model's own default when the current level isn't available on it.
export function syncEffortForModel() {
  if ((state.settings.llmProvider || "anthropic") !== "openai" || !state.fullLadder) return;
  const info = state.modelEfforts && state.modelEfforts[state.settings.defaultModel];
  const ladder = info ? state.fullLadder.filter((l) => info.efforts.includes(l.id)) : state.fullLadder;
  if (!ladder.length) return;
  THINKING.length = 0; for (const l of ladder) THINKING.push({ ...l, desc: (l.desc || "").replace(/ — .*$/, "") });
  if (!THINKING.find((l) => l.id === state.settings.defaultThinking)) {
    const v = (info && info.def && THINKING.find((l) => l.id === info.def)) ? info.def : THINKING[Math.min(THINKING.length - 1, 2)].id;
    state.settings.defaultThinking = v; atom.settings.set({ defaultThinking: v }).catch(() => {});
    toast(`Effort set to ${v} — the only levels ${(MODELS.find((m) => m.id === state.settings.defaultModel) || {}).name || "this model"} accepts are ${THINKING.map((l) => l.id).join(", ")}`, "sparkle", { ms: 3500 });
  }
  if (thinkDD) thinkDD._refresh();
}
export function onToggleOneM() { updateOneMVisibility(); }
export function stepSubAgents(delta) {
  const cur = Math.max(1, Math.min(8, +state.settings.subAgentsMax || 3));
  const next = Math.max(1, Math.min(8, cur + delta));
  if (next === cur) return;
  setSharedSetting("subAgentsMax", next);
  const sv = $("subAgentsVal"); if (sv) sv.textContent = String(next);
}
export function updateStats() {
  const el = $("statsStrip"); if (!el) return;
  const ts = activeTS();
  const files = ts ? ts.editedFiles : [];
  if (!files.length) { el.classList.remove("clickable"); el.innerHTML = `<span class="stat-muted">No file changes yet</span>`; el.onclick = null; return; }
  const added = files.reduce((s, f) => s + (f.added || 0), 0);
  const removed = files.reduce((s, f) => s + (f.removed || 0), 0);
  el.classList.add("clickable");
  el.innerHTML =
    `<span class="stat">${icon("pencil", 12)} ${files.length} file${files.length > 1 ? "s" : ""} changed</span>` +
    `<span class="stat add">+${added}</span><span class="stat del">−${removed}</span>` +
    `<span class="stat-hint">lines</span>`;
  el.onclick = () => { if ($("changesPanel").classList.contains("hidden")) toggleChanges(); };
}
/* ---- attachments (paste / drop images & files) ---- */
export function onPaste(e) {
  const dt = e.clipboardData; if (!dt) return;
  const imageItems = [...(dt.items || [])].filter((it) => it.kind === "file" && it.type.startsWith("image/"));
  if (imageItems.length) {
    e.preventDefault();
    for (const it of imageItems) { const f = it.getAsFile(); if (f) addImageFile(f); }
    return;
  }
  const pathed = [...(dt.files || [])].filter((f) => f.path);
  if (pathed.length) { e.preventDefault(); for (const f of pathed) addPathFile(f); }
}
export function onDrop(e) {
  e.preventDefault();
  $("composerBox").classList.remove("dragover");
  const files = [...(e.dataTransfer.files || [])];
  if (files.length) {
    for (const f of files) {
      if (f.type && f.type.startsWith("image/")) addImageFile(f);
      else if (f.path) addPathFile(f);
      else addImageFile(f);
    }
    return;
  }
  // No files → a selected-text drag (from the editor, a chat message, etc.).
  // Drop it into the prompt box at the caret instead of discarding it.
  const text = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text");
  if (text) insertIntoComposer(text);
}
// Insert text into the prompt box at the caret (replacing any selection), keeping
// the draft + autosize + send-button state in sync.
export function insertIntoComposer(text) {
  const ta = $("promptInput"); if (!ta) return;
  const ts = activeTS();
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const caret = start + text.length;
  ta.focus();
  try { ta.setSelectionRange(caret, caret); } catch { /* ignore */ }
  if (ts) ts.draft = ta.value;
  autoGrow();
  updateSendButton();
}
export function addPathFile(file) {
  const ts = activeTS(); if (!ts) return;
  ts.attachments.push({ kind: "file", name: file.name, path: file.path, mediaType: file.type });
  renderAttachments();
}
export function addImageFile(file) {
  const ts = activeTS(); if (!ts) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || "");
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return;
    const data = dataUrl.slice(comma + 1);
    const mediaType = dataUrl.slice(5, comma).split(";")[0] || file.type || "image/png";
    makeThumb(dataUrl).then((thumb) => {
      ts.attachments.push({ kind: "image", name: file.name || "pasted-image.png", data, mediaType, thumb });
      renderAttachments();
    });
  };
  reader.readAsDataURL(file);
}
// Thumbnail sized for crisp display: the inline preview can render ~220px wide,
// so target ~2.5× that and account for the screen's pixel ratio (Hi-DPI laptops
// were upscaling a 160px thumb → blurry). Never upscales past the source.
export function makeThumb(dataUrl, max = Math.min(900, Math.round(560 * (window.devicePixelRatio || 1)))) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale)), hh = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas"); c.width = w; c.height = hh;
      const ctx = c.getContext("2d"); if (ctx) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; }
      try { ctx.drawImage(img, 0, 0, w, hh); res(c.toDataURL("image/jpeg", 0.92)); }
      catch { res(dataUrl); }
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });
}
export function renderAttachments() {
  const tray = $("attachTray"); if (!tray) return;
  const ts = activeTS();
  const atts = ts ? ts.attachments : [];
  tray.innerHTML = "";
  if (!atts || !atts.length) { tray.classList.add("hidden"); return; }
  tray.classList.remove("hidden");
  atts.forEach((a, i) => {
    const chip = h("div", { class: "attach-chip" });
    if (a.kind === "image") { const t = h("img", { class: "attach-thumb", src: imgSrc(a) || a.thumb, title: "Click to view", onclick: () => openImageViewer(imgSrc(a) || a.thumb, a.name) }); chip.append(t); }
    else chip.append(h("span", { class: "attach-fico", html: icon("file", 14) }));
    chip.append(h("span", { class: "attach-name", text: a.name || (a.kind === "image" ? "image" : "file") }));
    chip.append(h("button", { class: "attach-x", html: icon("close", 12), title: "Remove", onclick: () => { ts.attachments.splice(i, 1); renderAttachments(); } }));
    tray.append(chip);
  });
}
export function autoGrow() {
  const ta = $("promptInput");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 260) + "px";
}
export async function updateTabSetting(key, val) {
  const ts = activeTS();
  if (!ts) return;
  ts.meta[key] = val;
  await atom.sessions.update(ts.meta.id, { [key]: val });
}
export function updateSendButton() {
  const ts = activeTS();
  const btn = $("sendBtn");
  const qbtn = $("queueBtn");
  const nbtn = $("nowBtn");
  const box = $("composerBox");
  if (!btn || !ts) return;
  const running = ts.meta.status === "running";
  const ta = $("promptInput");
  const hasText = !!((ta && ta.value.trim()) || (ts.attachments && ts.attachments.length));
  box.classList.toggle("running", running || !!ts.stopping);
  const hideQueue = () => { if (qbtn) qbtn.classList.add("hidden"); if (nbtn) nbtn.classList.add("hidden"); };
  if (ts.stopping) {
    // Interrupt in flight — show it's working on stopping, ignore further clicks.
    btn.classList.remove("queue", "interrupt-now"); btn.classList.add("stop"); btn.innerHTML = icon("stop", 16); btn.title = "Stopping…"; btn.disabled = true;
    hideQueue();
    return;
  }
  const offline = ts.meta.status === "offline";
  if (offline) {
    btn.classList.remove("queue", "interrupt-now", "stop"); btn.innerHTML = icon("wifiOff", 16); btn.title = "Offline — will retry when connection returns";
    btn.disabled = true;
    box.classList.add("running");
    hideQueue();
    return;
  }
  if (ts.meta.status === "auth-expired") {
    // Paused awaiting re-login. Clicking the button opens the sign-in flow; the
    // run resumes automatically once auth is restored (context preserved).
    btn.classList.remove("queue", "interrupt-now", "stop"); btn.innerHTML = icon("key", 16);
    btn.title = "Login expired — sign in to resume (context preserved)";
    btn.disabled = false;
    box.classList.add("running");
    hideQueue();
    return;
  }
  if (ts.meta.status === "ratelimited") {
    // Rate-limited — auto-retrying. Button stops the auto-retry (context kept).
    btn.classList.remove("queue", "interrupt-now"); btn.classList.add("stop"); btn.innerHTML = icon("history", 16);
    btn.title = "Rate limited — auto-retrying. Click to stop (your message stays).";
    btn.disabled = false;
    box.classList.add("running");
    hideQueue();
    return;
  }
  if (running) {
    // Generating → the primary button is ALWAYS Stop (whatever is typed). Typed text reveals the
    // secondary "Send now" (Enter) and "Queue" (Ctrl+Enter) buttons before it.
    btn.classList.remove("queue", "interrupt-now"); btn.classList.add("stop"); btn.innerHTML = icon("stop", 16); btn.title = "Stop (Esc)";
    if (hasText) {
      const codex = ((ts.meta.run && ts.meta.run.provider) || state.settings.llmProvider) === "openai";
      if (nbtn) { nbtn.classList.remove("hidden"); nbtn.title = codex ? "Send now (Enter) — joins the running Codex turn; nothing is stopped" : "Send now (Enter) — joins the live turn while agents run, otherwise interrupts the reply and runs this"; }
      if (qbtn) qbtn.classList.remove("hidden");
    } else hideQueue();
  } else {
    // Idle → send.
    btn.classList.remove("stop", "queue", "interrupt-now"); btn.innerHTML = icon("arrowUp", 19); btn.title = "Send (Enter)";
    hideQueue();
  }
  btn.disabled = false;
}
// Reconcile a missed event against the owner in main. A newer status/dispatch wins over
// an in-flight probe; elapsed time alone never means that a run has stopped.
export async function reconcileSessionRunState(ts) {
  const version = ts._statusVersion || 0;
  const id = ts.meta.id;
  const snapshot = await atom.sessions.runState(id);
  if (state.tabs.get(id) !== ts || (ts._statusVersion || 0) !== version) return;
  ts.meta.status = snapshot.status;
  ts.stopping = !!snapshot.stopping;
  if (!snapshot.running) { ts.streaming.clear(); ts.live = null; }
  else if (snapshot.live) ts.live = snapshot.live;
  if (id === state.activeTabId) { updateSendButton(); renderLive(); }
  renderTabs();
  if (!snapshot.running && (snapshot.status === "idle" || snapshot.status === "done") && ts.queue && ts.queue.length) dispatchNextQueued(id);
}
export function requestSessionStop(ts, reason) {
  const request = {};
  ts._stopRequest = request;
  clearTimeout(ts._stopTimer);
  const reconcile = () => {
    if (ts._stopRequest !== request || !ts.stopping) return;
    return reconcileSessionRunState(ts).catch(() => {});
  };
  ts._stopTimer = setTimeout(reconcile, 1500);
  return atom.sessions.interrupt(ts.meta.id, reason).then(reconcile).catch((e) => {
    if (ts._stopRequest !== request || !ts.stopping) return;
    ts.stopping = false;
    if (ts.meta.id === state.activeTabId) { updateSendButton(); renderLive(); }
    toast("Stop failed: " + ((e && e.message) || e), "alert");
    return reconcileSessionRunState(ts).catch(() => {});
  });
}
export function stopSession(id) {
  const ts = state.tabs.get(id);
  if (!ts) return;
  // Invalidate sends/probes already awaiting IPC. Their late failure must not put
  // a cancelled prompt back into the queue or restart its retry timer.
  ts._queueVersion = (ts._queueVersion || 0) + 1;
  ts._statusVersion = (ts._statusVersion || 0) + 1;
  clearTimeout(ts._dispatchRetry);
  ts._dispatchOwner = null; ts._dispatching = false;
  if (ts.queue && ts.queue.length) { ts.queue = []; if (id === state.activeTabId) renderQueue(); }
  // Hard stop: drop the live partials/thinking immediately so the UI snaps to
  // a stopped state instead of pulsing "Thinking…" during the abort window.
  ts.streaming.clear();
  ts.stopping = true;
  if (id === state.activeTabId) { updateSendButton(); renderLive(); }
  return requestSessionStop(ts, "stop");
}
// (The Optimise / Distill pre-mind was removed: nothing rewrites or strips a request
//  before the model sees it.)

// Conservatively detect a "make me an image" request in natural language —
// requires a generation verb + an image noun, and bails on coding contexts
// (docker image, image upload component, base image, etc.) to avoid misfires.
export function looksLikeImageRequest(t) {
  t = String(t || "");
  const verb = /\b(generate|create|make|draw|paint|render|design|sketch|illustrate)\b/i;
  const noun = /\b(image|images|picture|pictures|pic|photo|photos|logo|icon|illustration|drawing|artwork|portrait|poster|wallpaper|avatar|sticker|painting|emoji|thumbnail)\b/i;
  const code = /\b(docker|container|kubernetes|component|upload|picker|gallery|carousel|css|html|react|vue|svelte|button|form\b|api|endpoint|function|class|file|disk|iso|\bvm\b|build|deploy|base ?image|src=|https?:|crop|resize|optimi[sz]e|compress|sprite|favicon|placeholder|<img|tag)\b/i;
  return verb.test(t) && noun.test(t) && !code.test(t);
}
// Generate an image from a prompt — the prompt + result/error arrive as messages
// (added in the main process), so the renderer just kicks it off.
export function generateImage(prompt) {
  const ts = activeTS(); if (!ts || !prompt) return;
  ts.meta.status = "running"; ts._statusVersion = (ts._statusVersion || 0) + 1; updateSendButton();
  return atom.image.generate(ts.meta.id, prompt).then((r) => {
    if (r && r.ok) toast(`Image generated · ${r.provider}`, "image");
    else if (r && r.error && r.error !== "stopped") toast("Image generation failed: " + r.error, "alert");
  }).catch((e) => toast("Image generation failed: " + e.message, "alert"))
    .finally(() => reconcileSessionRunState(ts).catch(() => {}));
}
export async function send(opts = {}) {
  const ts = activeTS();
  if (!ts) return;
  // Paused awaiting re-login → the send button is a "sign in & resume" affordance.
  if (ts.meta.status === "auth-expired") { resumeAuthExpired(ts.meta.authProvider || ts.meta.provider); return; }
  const ta = $("promptInput");
  const text = ta.value.trim();
  const attachments = ts.attachments || [];
  // Rate-limited + nothing typed → the button stops the auto-retry (context kept).
  if (ts.meta.status === "ratelimited" && !text && !attachments.length) { stopSession(ts.meta.id); return; }
  const running = ts.meta.status === "running";
  // The primary button while running IS the Stop button — whatever is typed. Sending while a
  // reply runs is explicit: Enter / "Send now" → { now }, Ctrl+Enter / "Queue" → { queue }.
  if (running && !opts.now && !opts.queue) { stopSession(ts.meta.id); return; }
  if (!text && !attachments.length) return;
  // "/image <prompt>" OR a natural-language image request → generate an image
  // instead of a chat turn (so the text model can't falsely claim it made one).
  // Skip the natural-language heuristic if the user attached files — they
  // probably want the model to look at the attachment, not silently throw it
  // away and run text-to-image on a prompt that mentioned "image".
  const igm = text.match(/^\/(?:image|img|imagine)\s+([\s\S]+)/i);
  const heuristicImage = !attachments.length && looksLikeImageRequest(text);
  if (!running && (igm || heuristicImage)) { const p = igm ? igm[1].trim() : text; ta.value = ""; ts.draft = ""; autoGrow(); ts.attachments = []; renderAttachments(); generateImage(p); return; }

  ta.value = ""; ts.draft = ""; autoGrow();
  ts.attachments = []; renderAttachments();
  const extraSystem = undefined;   // the message is sent exactly as written — no local rewriting layer
  // Sending is an explicit "I'm done reading back" — if the user had scrolled up,
  // jump to the latest so they see their own message and the reply arriving. The
  // message itself renders a moment later (it round-trips through the backend), so
  // also arm a one-shot flag that forces the scroll when it actually lands.
  ts._forceScrollOnce = true;
  scrollBottom(true);

  if (running) {
    const queueVersion = ts._queueVersion || 0;
    const item = { id: "q" + Math.random().toString(36).slice(2, 9), text, attachments, extraSystem };
    if (opts.queue) {
      // Explicit queue (the Queue button / Ctrl+Enter): run it after the current reply.
      ts.queue.push(item);
      renderQueue();
      updateSendButton();
      toast(`Queued — #${ts.queue.length} in line`, "list");
    } else {
      // Codex turn: STEER it — the message joins the running turn (turn/steer) and
      // the model picks it up at its next step, nothing is stopped or re-run. Any
      // other case (Claude, no live turn, turn just finished) falls through to the
      // interrupt path below.
      // Claude with background agents running: the message joins the live process as its next turn
      // (queued behind the current step) — the agents are NOT stopped; only Stop ends them.
      let steerRes = null;
      try { steerRes = await atom.sessions.steer(ts.meta.id, { text, attachments }); } catch { steerRes = null; }
      if (state.tabs.get(ts.meta.id) !== ts || (ts._queueVersion || 0) !== queueVersion) return;
      if (steerRes && steerRes.steered) { toast(steerRes.mode === "queued" ? "Sent — runs after the current step; the agents keep working" : "Added to the running turn", "send"); return; }
      // Enter interrupts the current reply and runs this next. Clear old partials
      // while main releases the run; keep the button stopping until main confirms it.
      // The stop is graceful (resumable); onStatus(idle) then clears `stopping`
      // and dispatchNextQueued runs this item (and any queued after it).
      ts.queue.unshift(item);
      renderQueue();
      ts.streaming.clear();
      ts.stopping = true;
      if (ts.meta.id === state.activeTabId) { updateSendButton(); renderLive(); }
      requestSessionStop(ts, "replace");
      toast("Interrupting — running your message now…", "stop");
    }
    return;
  }
  ts.meta.status = "running";
  ts._statusVersion = (ts._statusVersion || 0) + 1;
  ts.suggestion = null; renderSuggestChips();
  updateSendButton();
  createCheckpoint("Before: " + (text.slice(0, 48) || "agent run")).catch(() => {});   // snapshot so the run is reversible
  try { await atom.sessions.send(ts.meta.id, { text, attachments, extraSystem, ...sharedRunOpts() }); }
  catch (e) {
    // The composer was already cleared — put the prompt (and attachments) back so
    // a failed send (backend still tearing down, transient error) loses nothing.
    toast("Failed: " + e.message, "alert");
    await reconcileSessionRunState(ts).catch(() => {});
    const ta2 = $("promptInput"), active = ts.meta.id === state.activeTabId;
    if (active && ta2 && !ta2.value.trim()) { ta2.value = text; ts.draft = text; autoGrow(); }
    else if (!active && !ts.draft) ts.draft = text;
    if (attachments.length && !(ts.attachments || []).length) { ts.attachments = attachments; if (active) renderAttachments(); }
    updateSendButton();
  }
}
// Import a saved conversation from the composer, open it as a tab, scroll to end.
export async function importConversation() {
  try {
    const r = await atom.sessions.import();
    if (!r || r.canceled) return;
    toast(`Imported ${r.count} conversation${r.count > 1 ? "s" : ""}`, "upload");
    if (r.first && r.first.id) {
      await openSessionTab(r.first.id);
      setTimeout(() => scrollBottom(true), 140);
    }
  } catch (e) { toast("Import failed: " + e.message, "alert"); }
}
// Resend an earlier prompt: drop its text into the composer and send (which
// queues it if a reply is already running).
export function resendPrompt(text) {
  const ts = activeTS();
  if (!ts) return;
  const ta = $("promptInput");
  ta.value = text;
  ts.draft = text;
  autoGrow();
  ta.focus();
  send();
}
// The run options shared by every session (model/thinking/permission/1M).
export function sharedRunOpts() {
  return {
    model: state.settings.defaultModel,
    permissionMode: state.settings.defaultPermissionMode,
    thinking: state.settings.defaultThinking,
    oneM: modelSupports1M(state.settings.defaultModel),
    subAgents: !!state.settings.subAgents,
    subAgentsMax: agentsMaxSetting(),
    // Never let a reviewer be the EXACT primary (same provider + same model) — a
    // model reviewing itself adds nothing. Same provider with a different model is fine.
    reviewers: (Array.isArray(state.settings.reviewers) ? state.settings.reviewers : [])
      .filter((r) => !(r.provider === (state.settings.llmProvider || "anthropic") && r.model && r.model === state.settings.defaultModel)),
    reviewMode: state.settings.reviewMode === "after" ? "after" : "before",
    // Planner role (Plan → Code). Only sent when enabled; the Coder is the primary
    // model above, so the plan is drafted by planner.model and implemented by it.
    // While a WORKFLOW is on, its Orchestrator (the primary main builds from settings.workflow.roles.orchestrator)
    // replaces this legacy role — the composer's picks still travel; main applies the orchestrator's overrides.
    planner: activeWorkflow().enabled ? null
      : (state.settings.planner && state.settings.planner.enabled && (state.settings.planner.provider || state.settings.planner.model))
        ? { enabled: true, provider: state.settings.planner.provider || "anthropic", model: state.settings.planner.model || "", effort: state.settings.planner.effort || "" }
        : null,
  };
}
export async function dispatchNextQueued(sessionId) {
  const ts = state.tabs.get(sessionId);
  if (!ts || !ts.queue || !ts.queue.length) return;
  if (ts._dispatching) return;            // a dispatch attempt is already in flight
  clearTimeout(ts._dispatchRetry);
  const owner = {}, version = ts._queueVersion || 0;
  ts._dispatchOwner = owner;
  ts._dispatching = true;
  const valid = () => state.tabs.get(sessionId) === ts && (ts._queueVersion || 0) === version;
  const owns = () => valid() && ts._dispatchOwner === owner;
  const release = () => { if (owns()) { ts._dispatching = false; ts._dispatchOwner = null; } };
  const retry = (ms = 140) => {
    if (!owns()) return;
    release(); clearTimeout(ts._dispatchRetry);
    ts._dispatchRetry = setTimeout(() => { if (valid()) dispatchNextQueued(sessionId); }, ms);
  };
  try {
    // An interrupt is async on the backend — the previous run may still be tearing
    // down when idle is first observed. Dispatching now would throw "already
    // running", so wait until the backend is genuinely idle (short poll).
    const stillRunning = await atom.sessions.running(sessionId);
    if (!owns()) return;
    if (stillRunning) { retry(); return; }
    if (!ts.queue.length) { release(); return; }
    const next = ts.queue.shift();
    ts.meta.status = "running";
    ts._statusVersion = (ts._statusVersion || 0) + 1;
    if (sessionId === state.activeTabId) { renderQueue(); updateSendButton(); }
    renderTabs();
    try {
      await atom.sessions.send(sessionId, { text: next.text, attachments: next.attachments, extraSystem: next.extraSystem, ...sharedRunOpts() });
      release();
    } catch (e) {
      if (!owns()) return;
      // NEVER drop the user's prompt. Re-queue at the FRONT and retry.
      //   - "already running" → we raced the teardown; retry fast.
      //   - any other error → transient hiccup; a few quick retries before we
      //     give up and surface a toast (so a blip can't silently lose the msg).
      next._tries = (next._tries || 0) + 1;
      ts.queue.unshift(next);
      if (sessionId === state.activeTabId) renderQueue();
      if (/already running/i.test(e && e.message || "")) retry(120);
      else if (next._tries < 4) retry(400);
      else {
        // Give up on auto-retry — but never lose the prompt or leave the tab stuck
        // on a guessed "running": restore the composer and query the actual owner.
        ts.queue.shift(); release();
        await reconcileSessionRunState(ts).catch(() => {});
        if (!valid()) return;
        const ta = $("promptInput");
        if (sessionId === state.activeTabId && ta && !ta.value.trim()) { ta.value = next.text || ""; ts.draft = next.text || ""; autoGrow(); }
        else if (next.text) ts.draft = next.text;   // inactive tab: restored when it's switched to
        if (Array.isArray(next.attachments) && next.attachments.length && !(ts.attachments || []).length) { ts.attachments = next.attachments; if (sessionId === state.activeTabId) renderAttachments(); }
        if (sessionId === state.activeTabId) { renderQueue(); updateSendButton(); }
        renderTabs();
        toast("Queued run failed: " + (e && e.message || e) + " — your message is back in the composer.", "alert");
      }
    }
  } catch (e) {
    // Outer failure (rare — e.g. the running() probe) — keep the queue intact and
    // try again shortly rather than losing anything.
    retry(400);
  }
}
