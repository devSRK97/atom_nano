/* AtomNano renderer — Workflow studio — the inspector (right column): the editor for the selected role
 * (enabled · provider · model · effort · access · each worker's sub-agent lane (any provider) · the Tester's
 * command · the Orchestrator's job-tab switch), that role's jobs in the active session with Open tab / Stop,
 * and — when nothing is selected — the overview: roles, job counts and how the Orchestrator drives the roles
 * through the CLI. */
import { copyText, h } from "../core/dom.js";
import { state } from "../core/state.js";
import { icon } from "../icons.js";
import { toggle } from "../settings/controls.js";
import { ACCESS, AGENTS_MAX, PRIMARY, PROVIDERS, ROLES, ROLE_ORDER, S, SKILL_ROLES, accessOf, activeSessionId, activeWorkflow, catalogFor, clampAgents, composerProvider, edit, effectiveProvider, effortsFor, hasService, modelName, modelsFor, nodeModelLine, openJobTab, providerName, runRole, selectRole, stopAllJobs, stopJob } from "./model.js";
import { LIVE, agentHue, boardStats, fmtSpan, jobElapsedMs, pausedLabel, primaryRunning, roleAgentStats, roleLive, statusLabel, toMs, workflowJobsFor } from "./live.js";
const ROLE_CMD = { planner: "plan", coder: "coder", reviewer: "review", tester: "test" };   // the CLI shorthand of each worker role

export function buildInspector() { const el = h("aside", { class: "wf-inspector", "aria-label": "Inspector" }); S.inspector = el; return el; }
export function renderInspector() { const el = S.inspector; if (!el) return; el.innerHTML = ""; el.append(S.selected && ROLES[S.selected] ? roleEditor(S.selected) : overview()); }
// Only the jobs part (live events must not rebuild the inputs the user may be editing).
export function renderInspectorJobs() {
  const el = S.inspector; if (!el) return;
  if (!S.selected) { renderInspector(); return; }
  const host = el.querySelector(".wf-jobs-host"); if (host) { host.innerHTML = ""; host.append(jobsBlock(S.selected)); }
}

/* ----------------------------- controls ----------------------------- */
export function row(label, control, hint, cls) {
  return h("div", { class: "wf-row" + (cls ? " " + cls : "") }, h("div", { class: "wf-label", text: label }), h("div", { class: "wf-ctl" }, control), hint ? h("div", { class: "wf-hint", text: hint }) : null);
}
export function seg(options, current, onPick, cls) {
  const el = h("div", { class: "wf-seg" + (cls ? " " + cls : ""), role: "radiogroup" });
  for (const o of options) el.append(h("button", { class: (o.id === current ? "active" : "") + (o.cls ? " " + o.cls : ""), type: "button", role: "radio", "aria-checked": o.id === current ? "true" : "false", title: o.title || o.name, text: o.name, onclick: () => { if (o.id !== current) onPick(o.id); } }));
  return el;
}
export function select(options, current, onChange, ariaLabel) {
  const el = h("select", { class: "wf-select", "aria-label": ariaLabel || "Choose" });
  for (const o of options) el.append(h("option", { value: o.id, text: o.name }));
  el.value = options.some((o) => o.id === current) ? current : (options[0] ? options[0].id : "");
  el.addEventListener("change", () => onChange(el.value));
  return el;
}
export function stepper(value, onChange, label) {
  const input = h("input", { class: "wf-step-num", type: "number", min: "0", max: String(AGENTS_MAX), step: "1", value: String(value), "aria-label": label || "Value" });
  input.addEventListener("change", () => onChange(clampAgents(+input.value)));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  return h("div", { class: "wf-stepper" },
    h("button", { class: "wf-step-btn", type: "button", "aria-label": "Fewer", html: icon("minus", 12), onclick: () => onChange(clampAgents(value - 1)) }),
    input,
    h("button", { class: "wf-step-btn", type: "button", "aria-label": "More", html: icon("plus", 12), onclick: () => onChange(clampAgents(value + 1)) }));
}

/* ----------------------------- the role editor ----------------------------- */
export function roleEditor(role) {
  const wf = activeWorkflow(); const cfg = wf.roles[role]; const meta = ROLES[role]; const isPrimary = role === PRIMARY; const on = isPrimary || cfg.enabled !== false;
  const prov = effectiveProvider(role, cfg);
  const wrap = h("div", { class: `wf-insp ${role}` + (on ? "" : " off") });
  wrap.append(h("div", { class: "wf-insp-head" },
    h("button", { class: "wf-ibtn", title: "Back to the overview", "aria-label": "Back to the overview", html: icon("chevronLeft", 14), onclick: () => selectRole(null) }),
    h("span", { class: "wf-insp-ic", html: icon(meta.icon, 18) }),
    h("div", { class: "wf-insp-title" }, h("b", { text: meta.name }), h("span", { class: "wf-insp-sub", text: isPrimary ? "primary — the model you chat with" : on ? nodeModelLine(role, cfg) : "disabled in this workflow" })),
    isPrimary ? null : toggle(on, (v) => edit({ roles: { [role]: { enabled: v } } }), { label: `${meta.name} enabled` })));
  wrap.append(h("p", { class: "wf-blurb", text: meta.blurb }));
  // The role's sub-agent counters for this session (the same numbers as the canvas card's chips).
  if (!isPrimary) {
    const st = roleAgentStats(role, activeSessionId());
    wrap.append(h("div", { class: "wf-role-stats" },
      h("span", { class: "wf-count-chip running" + (st.running ? " on" : ""), title: "Sub-agents working right now" }, st.running ? h("span", { class: "ag-orbit sm", "aria-hidden": "true" }, h("i"), h("i"), h("i")) : h("span", { class: "wf-count-dot" }), h("span", { text: `${st.running} running` })),
      h("span", { class: "wf-count-chip used" + (st.used ? " on" : ""), title: "Sub-agents used so far in this session" }, h("span", { class: "wf-count-ic", html: icon("history", 10) }), h("span", { text: `${st.used} used so far` })),
      h("span", { class: "wf-count-chip", title: "Jobs of this role in this session" }, h("span", { text: `${st.jobs} job${st.jobs === 1 ? "" : "s"}${st.live ? ` · ${st.live} live` : ""}` }))));
  }

  const provOpts = (isPrimary ? [{ id: "", name: "Composer's pick", title: "Follow the composer's provider and model" }] : []).concat(PROVIDERS.map((p) => ({ id: p.id, name: p.name })));
  wrap.append(row("Provider", seg(provOpts, cfg.provider || "", (v) => edit({ roles: { [role]: { provider: v, model: "", effort: "" } } })), isPrimary && !cfg.provider ? `Runs on the composer's provider (${providerName(composerProvider())}) and its model.` : null));

  const models = modelsFor(prov); const cat = catalogFor(prov);
  const first = isPrimary && !cfg.provider ? { id: "", name: "Composer's pick" } : { id: "", name: `Default (${providerName(prov)}${cat.defaultModel ? " — " + modelName(prov, "") : ""})` };
  wrap.append(row("Model", select([first, ...models], cfg.model || "", (v) => edit({ roles: { [role]: { model: v } } }), `${meta.name} model`),
    models.length ? null : prov === "custom" ? "No custom endpoints configured yet (Settings → Providers)." : "The model catalog for this provider has not loaded yet."));

  wrap.append(row("Effort", select([{ id: "", name: "Default" }, ...effortsFor(prov)], cfg.effort || "", (v) => edit({ roles: { [role]: { effort: v } } }), `${meta.name} effort`)));

  const acc = accessOf(cfg.access);
  wrap.append(row("Access", seg(ACCESS.map((a) => ({ id: a.id, name: a.short, title: a.name, cls: "acc-" + a.id })), cfg.access, (v) => edit({ roles: { [role]: { access: v } } }), "access"), acc.help));

  if (!isPrimary) {
    // Every worker role has its own lane, on ANY provider (2026-09-17: the stepper used to be ignored on Codex /
    // Custom with a "Claude only" warning). The role is TOLD to use it: as many as the task allows, in parallel.
    const via = prov === "anthropic" ? "Claude's Task tool" : prov === "openai" ? "Codex's multi-agent feature" : "the provider's own agent support";
    wrap.append(row("Sub-agents", stepper(cfg.agents, (n) => edit({ roles: { [role]: { agents: n } } }), `${meta.name} sub-agents`),
      cfg.agents ? `The ${meta.name} may fan out to up to ${cfg.agents} sub-agent${cfg.agents === 1 ? "" : "s"} (${via}) and is told to use as many as the task allows, in parallel — all ${cfg.agents} when the work divides that far, fewer when it does not.` : `0 = the ${meta.name} works alone.`));
  }
  if (SKILL_ROLES.includes(role)) {
    // Skills attached to the role (2026-09-18): every job of the role runs with them as its selected skills.
    const n = Array.isArray(cfg.skills) ? cfg.skills.length : 0;
    wrap.append(row("Skills", h("button", { class: "wf-btn sm" + (n ? " primary" : ""), html: icon("sparkle", 12) + `<span>${n ? `${n} attached` : "None attached"} · Skills…</span>`, onclick: () => import("./studio.js").then((m) => m.openSkillsModal(role)) }),
      n ? `Every ${meta.name} job runs with ${n === 1 ? "this skill" : `these ${n} skills`} — their saved procedures travel with the task.` : `Attach this project's installed skills (design conventions, checklists, architecture notes) — every ${meta.name} job then runs with them.`));
  }
  if (role === "tester") {
    const inp = h("input", { class: "wf-input mono", type: "text", value: cfg.command || "", placeholder: "project test command, e.g. npm test", spellcheck: "false", "aria-label": "Test command" });
    inp.addEventListener("change", () => edit({ roles: { tester: { command: inp.value.trim() } } }));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    wrap.append(row("Command", inp, "Empty = the project's test command, or the Tester decides."));
  }
  if (isPrimary) {
    wrap.append(row("Job tabs", toggle(wf.openJobTabs === true, (v) => edit({ openJobTabs: v }, { canvas: false }), { label: "Open a tab for every job" }), "Off: jobs run in the background through the CLI and come back as cards in this chat — open any job's tab from its card or from the jobs list below. On: a tab opens for every job (it never steals focus)."));
    wrap.append(h("div", { class: "wf-actions" }, h("button", { class: "wf-btn", html: icon("cpu", 13) + "<span>Orchestrator brief</span>", onclick: () => { if (S.openDrawer) S.openDrawer("brief"); } })));
  } else {
    const cli = ROLE_CMD[role] || role;
    wrap.append(h("div", { class: "wf-actions" },
      h("button", { class: "wf-btn primary", disabled: on ? null : true, html: icon("send", 13) + `<span>Run ${meta.name}…</span>`, onclick: () => runRole(role) }),
      h("span", { class: "wf-actions-hint mono", text: `atomnano ${cli} "…"` })));
  }
  wrap.append(h("div", { class: "wf-sect" }, h("span", { text: "Jobs in this session" })), h("div", { class: "wf-jobs-host" }, jobsBlock(role)));
  return wrap;
}

/* ----------------------------- jobs ----------------------------- */
export function jobsBlock(role) {
  const sid = activeSessionId();
  if (!sid) return h("div", { class: "wf-empty", text: "Open a chat tab — jobs belong to the active orchestrator session." });
  const jobs = workflowJobsFor(sid).filter((j) => !role || j.role === role).reverse();
  if (!jobs.length) return h("div", { class: "wf-empty", text: role ? `No ${ROLES[role].name} jobs yet. The Orchestrator starts them through the atomnano CLI — or use Run above.` : "No jobs yet. With the workflow on, the Orchestrator starts them through the atomnano CLI." });
  return h("div", { class: "wf-jobs" }, ...jobs.map(jobRow));
}
export function jobRow(job) {
  const live = LIVE.has(job.status);
  const elapsed = h("span", { class: "wf-job-time" + (live ? " wf-elapsed" : ""), text: fmtSpan(jobElapsedMs(job)) });
  if (live && job.startedTs) elapsed.dataset.from = String(toMs(job.startedTs));
  const title = job.kind === "command" ? (job.command || "test command") : (job.task || "(no task)");
  const al = job.agentsLive || {};
  const agentsMeta = job.agents ? (live && al.running ? `${al.running} of ${job.agents} agents` : `up to ${job.agents} agents`) : null;
  const meta = [job.kind === "command" ? "command" : (ROLES[job.role] ? ROLES[job.role].name : job.role), job.provider ? providerName(job.provider) : null, job.model || null, agentsMeta, job.from === "cli" ? "via CLI" : null].filter(Boolean).join(" · ");
  const paused = job.status === "running" && job.paused ? String(job.paused) : "";
  // the job's live sub-agents (main keeps agentsLive.list current): the role-level agent activity, right here
  const agentChips = live && Array.isArray(al.list) && al.list.length ? h("div", { class: "wf-job-agents" }, ...al.list.slice(0, 6).map((a) => h("span", { class: "wf-agent-chip st-" + (a.status || "running"), style: `--ag-h:${agentHue(a.n)}`, title: [a.description, a.progress].filter(Boolean).join(" — ") || `Sub-agent #${a.n}` }, h("span", { class: "agent-num", text: `#${a.n}` }), h("span", { class: "wf-agent-chip-text", text: a.progress || a.description || "working" }))), al.list.length > 6 ? h("span", { class: "wf-agent-chip more", text: `+${al.list.length - 6}` }) : null) : null;
  return h("div", { class: `wf-job st-${job.status}` + (paused ? " paused" : "") + (job.sessionId ? " openable" : ""), title: paused ? `${title} — paused: ${pausedLabel(paused)}` : title, onclick: () => { if (job.sessionId) openJobTab(job); } },
    h("span", { class: `wf-pill st-${paused ? "paused" : job.status}`, text: statusLabel(job.status, paused), title: paused ? pausedLabel(paused) : null }),
    h("div", { class: "wf-job-main" }, h("div", { class: "wf-job-task", text: title }), h("div", { class: "wf-job-meta", text: meta }), agentChips),
    elapsed,
    h("span", { class: "wf-job-acts" },
      job.sessionId ? h("button", { class: "wf-ibtn", title: "Open the job's tab", "aria-label": "Open tab", html: icon("external", 13), onclick: (e) => { e.stopPropagation(); openJobTab(job); } }) : null,
      live ? h("button", { class: "wf-ibtn danger", title: "Stop this job", "aria-label": "Stop", html: icon("stop", 12), onclick: (e) => { e.stopPropagation(); stopJob(job); } }) : null));
}

/* ----------------------------- overview ----------------------------- */
export function overview() {
  const wf = activeWorkflow(); const sid = activeSessionId(); const jobs = workflowJobsFor(sid);
  const counts = { running: jobs.filter((j) => LIVE.has(j.status)).length, done: jobs.filter((j) => j.status === "done").length, failed: jobs.filter((j) => j.status === "error" || j.status === "stopped").length };
  const wrap = h("div", { class: "wf-insp overview" });
  wrap.append(h("div", { class: "wf-insp-head" }, h("span", { class: "wf-insp-ic", html: icon("atom", 18) }),
    h("div", { class: "wf-insp-title" }, h("b", { text: wf.name || "Workflow" }), h("span", { class: "wf-insp-sub", text: wf.enabled ? "on — your chats run as the Orchestrator, which manages and monitors the roles" : "off — one model, no roles" }))));
  wrap.append(h("div", { class: "wf-sect" }, h("span", { text: "Roles" }), h("span", { class: "wf-spacer" }), h("span", { class: "wf-sect-hint", text: "click one to configure" })));
  const list = h("div", { class: "wf-roles" });
  for (const r of ROLE_ORDER) {
    const cfg = wf.roles[r]; const on = r === PRIMARY || cfg.enabled !== false;
    const st = r === PRIMARY ? (primaryRunning(sid) ? "running" : "idle") : roleLive(r, sid).status;
    list.append(h("button", { class: `wf-role-row ${r}` + (on ? "" : " off"), type: "button", onclick: () => selectRole(r) },
      h("span", { class: `wf-role-dot st-${st}` }), h("span", { class: "wf-role-ic", html: icon(ROLES[r].icon, 14) }), h("span", { class: "wf-role-name", text: ROLES[r].name }),
      h("span", { class: "wf-role-model", text: on ? nodeModelLine(r, cfg) + (r !== PRIMARY && cfg.agents ? ` · ${cfg.agents} agents` : "") : "off" }), h("span", { class: "wf-role-chev", html: icon("chevronRight", 13) })));
  }
  wrap.append(list);
  wrap.append(h("div", { class: "wf-sect" }, h("span", { text: "This session" })));
  wrap.append(h("div", { class: "wf-counts" }, countEl("running", counts.running), countEl("done", counts.done), countEl("failed", counts.failed)));
  // Stop on the orchestrator's turn leaves the roles working (they keep their state); ending them all is this explicit action.
  if (counts.running) wrap.append(h("div", { class: "wf-actions" }, h("button", { class: "wf-btn sm danger", title: "End every running job of this orchestrator — Stop on the orchestrator's own turn leaves them running", html: icon("stop", 12) + `<span>Stop all ${counts.running} job${counts.running === 1 ? "" : "s"}</span>`, onclick: () => stopAllJobs(sid) }), h("span", { class: "wf-actions-hint", text: "Stop on the orchestrator keeps the roles working" })));
  // The task board, live: what is being worked on and what is left (tasks:update re-renders this through S.onLive).
  wrap.append(h("div", { class: "wf-sect" }, h("span", { text: "Task board" }), h("span", { class: "wf-spacer" }), h("span", { class: "wf-sect-hint", text: "live" })));
  wrap.append(h("div", { class: "wf-board-host" }, boardBlock(sid)));
  wrap.append(h("div", { class: "wf-jobs-host" }, jobsBlock(null)));
  wrap.append(h("div", { class: "wf-sect" }, h("span", { text: "How the Orchestrator drives it" })));
  wrap.append(h("p", { class: "wf-blurb", text: "With the workflow on, the Orchestrator's system prompt carries a brief of these roles; it has the Planner draft the plan, delegates with the atomnano CLI in its Bash tool, keeps the task board current and monitors the jobs — every job opens as its own tab." }));
  wrap.append(codeLines(['atomnano plan "how to …" --wait', 'atomnano coder "implement …" --wait', 'atomnano review "review the diff of …"', 'atomnano test --cmd "npm test" --wait', "atomnano jobs"]));
  wrap.append(h("div", { class: "wf-actions" },
    h("button", { class: "wf-btn", html: icon("terminal", 13) + "<span>CLI details</span>", onclick: () => { const b = document.getElementById("wfCli"); if (b) b.click(); } }),
    h("button", { class: "wf-btn", html: icon("cpu", 13) + "<span>Orchestrator brief</span>", onclick: () => { if (S.openDrawer) S.openDrawer("brief"); } })));
  if (!hasService()) wrap.append(h("div", { class: "wf-note warn" }, h("span", { html: icon("alert", 13) }), h("span", { text: "The workflow service is not running in this build — designs are stored, but jobs cannot start yet." })));
  return wrap;
}
export function countEl(label, n) { return h("div", { class: "wf-count " + label + (n ? " on" : "") }, h("b", { text: String(n) }), h("span", { text: label })); }
/* The board as the orchestrator's cockpit sees it: the active set's progress, then the tasks being worked
 * right now (with the role and a live job) and the ones still to pick up. Realtime: every tasks:update
 * notifies the studio (chat/events.js) and S.onLive re-renders the overview. */
export function boardBlock(sid) {
  const b = boardStats(sid);
  const wrap = h("div", { class: "wf-board" });
  if (!b) { wrap.append(h("div", { class: "wf-empty", text: "No task board yet — the Orchestrator creates tasks with atomnano tasks add … and keeps them current as the roles work." })); return wrap; }
  const pct = b.total ? Math.round((b.done.length / b.total) * 100) : 0;
  wrap.append(h("div", { class: "wf-board-head" }, h("span", { class: "wf-board-title", text: b.title }), h("span", { class: "wf-spacer" }), h("span", { class: "wf-board-sum", text: `${b.done.length} / ${b.total} done` })));
  wrap.append(h("div", { class: "wf-board-bar", role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" }, h("i", { style: `width:${pct}%` })));
  const num = (label, n, cls) => h("span", { class: "wf-board-num " + cls + (n ? " on" : "") }, h("b", { text: String(n) }), h("span", { text: " " + label }));
  wrap.append(h("div", { class: "wf-board-nums" }, num("ongoing", b.ongoing.length, "ongoing"), num("remaining", b.remaining.length, "remaining"), num("done", b.done.length, "done")));
  const list = (label, items, cls) => {
    if (!items.length) return;
    wrap.append(h("div", { class: "wf-board-label", text: label }));
    for (const it of items.slice(0, 6)) wrap.append(taskLine(it, cls));
    if (items.length > 6) wrap.append(h("div", { class: "wf-hint", text: `+${items.length - 6} more on the board` }));
  };
  list("Ongoing", b.ongoing, "ongoing"); list("Remaining", b.remaining, "remaining");
  wrap.append(h("div", { class: "wf-actions" }, h("button", { class: "wf-btn sm", html: icon("checkCircle", 12) + "<span>Open the board</span>", onclick: () => import("../panels/board.js").then((m) => m.openBoard()).catch(() => {}) })));
  return wrap;
}
export function taskLine(it, cls) {
  const ids = Array.isArray(it.jobIds) ? it.jobIds : [];
  const liveJobs = ids.map((id) => state.workflow.jobs.get(id)).filter((j) => j && LIVE.has(j.status)).length;
  const st = String(it.status || "todo").toLowerCase(), role = it.role ? String(it.role).toLowerCase() : "";
  return h("div", { class: `wf-task ${cls} st-${st}`, title: [it.title, it.detail].filter(Boolean).join(" — ") },
    h("span", { class: "wf-task-ref", text: `T${it.n}` }),
    h("span", { class: "wf-task-title", text: it.title || "(untitled)" }),
    role ? h("span", { class: `wf-task-role ${role}`, text: role }) : null,
    h("span", { class: `wf-task-st st-${st}`, text: st }),
    liveJobs ? h("span", { class: "ag-orbit sm", "aria-hidden": "true", title: `${liveJobs} job${liveJobs === 1 ? "" : "s"} running on this task` }, h("i"), h("i"), h("i")) : null);
}
export function codeLines(lines) {
  return h("div", { class: "wf-code" }, ...lines.map((l) => h("div", { class: "wf-code-line" }, h("code", { text: l }), h("button", { class: "wf-ibtn", title: "Copy", "aria-label": "Copy command", html: icon("copy", 12), onclick: () => copyText(l, "Command copied") }))));
}
