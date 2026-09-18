/* Settings › Agent, Agents & context, Agent SDK — the defaults every session starts from, the
 * sub-agent / CPU governor / context-rollover controls, and the SDK capability gates. */
import { modelDD, permDD, refreshAgentsBtn, refreshCtxChip, renderAgentsStrip, setSharedSetting, setSoloAgents, thinkDD, updateOneMVisibility } from "../chat/composer.js";
import { renderChat } from "../chat/navigation.js";
import { MODELS, PERMS, THINKING, applyCustomModels } from "../core/catalog.js";
import { h, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { icon } from "../icons.js";
import { renderCpuMeter } from "../panels/agents.js";
import { activeWorkflow, hasOwnWorkflow, openWorkflowStudio, refreshWorkflowChip, setWorkflow, setWorkflowEnabled } from "../workflow/index.js";
import { boolSetting, field, inlineSelect, section, segmented, stepper, toggle } from "./controls.js";

export function agentCategory({ s }) {
  // Shared model / permission / thinking — apply to ALL sessions and mirror the composer's pickers
  const defModel = inlineSelect(MODELS, s.defaultModel, (v) => { setSharedSetting("defaultModel", v); if (modelDD) modelDD._refresh(); updateOneMVisibility(); });
  const defPerm = inlineSelect(PERMS, s.defaultPermissionMode, (v) => { setSharedSetting("defaultPermissionMode", v); if (permDD) permDD._refresh(); });
  const defThink = inlineSelect(THINKING, s.defaultThinking, (v) => { setSharedSetting("defaultThinking", v); if (thinkDD) thinkDD._refresh(); });
  // Retry button under your own prompts (on by default)
  const retry = toggle(s.resendButton !== false, (v) => { s.resendButton = v; atom.settings.set({ resendButton: v }); renderChat(); }, { label: "Retry button" });
  const sleep = boolSetting("preventSleep", { label: "Prevent sleep" });
  // Custom models (so new models from a CLI update can be picked up)
  const cmInput = h("textarea", { class: "input st-mono", rows: "3", placeholder: "one per line:  claude-opus-4-9 | Opus 4.9" });
  cmInput.value = (s.customModels || []).map((m) => m.id + (m.name ? " | " + m.name : "")).join("\n");
  cmInput.addEventListener("change", () => {
    const list = cmInput.value.split("\n").map((ln) => ln.trim()).filter(Boolean).map((ln) => { const [id, name] = ln.split("|").map((x) => x.trim()); return { id, name: name || id }; }).filter((m) => m.id);
    s.customModels = list; atom.settings.set({ customModels: list }); applyCustomModels(list); toast("Models updated");
  });
  return {
    id: "agent", label: "Agent", ic: "atom", group: "Model",
    blurb: "What every new session starts with. The composer's pickers change the same values.",
    items: () => [
      section("Defaults for every session", "atom"),
      field("Model", defModel, "Shared across every session and window.", { wide: true, keywords: "opus sonnet haiku default" }),
      field("Permission mode", defPerm, "How much the agent may do without asking. Changing it applies to the running turn too.", { wide: true, keywords: "approve edits bypass plan" }),
      field("Thinking level", defThink, "Reasoning effort for models with adaptive thinking.", { wide: true, keywords: "effort reasoning ultrathink" }),
      section("Chat", "chat"),
      field("Retry button", retry, "A Retry button under each of your prompts sends the same text again.", { keywords: "resend repeat" }),
      field("Prevent sleep", sleep, "Keep the computer awake while AtomNano runs long agent jobs.", { keywords: "screen awake power" }),
      field("Custom models", cmInput, "Add model IDs released after this build — one per line, an optional display name after “|”.", { wide: true, keywords: "id new release" }),
    ],
  };
}

const ROLL = [[0, "Off"], [80, "80%"], [90, "90%"], [95, "95%"]];

export function agentsCategory({ s }) {
  // Exclusive with the active tab's workflow (2026-09-18): turning solo sub-agents on asks, then turns that workflow off; a cancel puts the knob back.
  const subOn = toggle(!!s.subAgents, async (v) => { await setSoloAgents(v); subOn._set(!!state.settings.subAgents); }, { label: "Sub-agents" });
  const modeNote = toggle(s.modeNote !== false, (v) => setSharedSetting("modeNote", v), { label: "Tell the model its mode" });
  const maxAt = stepper({ value: Math.max(1, Math.min(20, +s.subAgentsMax || 3)), min: 1, max: 20, labels: { minus: "Fewer agents", plus: "More agents" }, onChange: (n) => { setSharedSetting("subAgentsMax", n); refreshAgentsBtn(); } });
  // The CPU gate is opt-in (2026-09-17): off, the cap is the limit. (The cores-per-agent knob left the UI; "auto" applies when the gate is on.)
  const governor = toggle(s.agentCpuGovernor === true, (v) => setSharedSetting("agentCpuGovernor", v), { label: "Yield to heavy processes" });
  const strip = toggle(s.agentsStrip !== false, (v) => { setSharedSetting("agentsStrip", v); renderAgentsStrip(); }, { label: "Running-agents strip" });

  // Live CPU picture — the governor's own view: busy cores, agent-reserved cores, free slots.
  const cpuBox = h("div", { class: "st-cpu" });
  const drawCpu = () => { cpuBox.innerHTML = ""; cpuBox.append(renderCpuMeter(state.cpu)); };
  drawCpu();
  const refreshCpu = () => atom.agents.cpu().then((snap) => { state.cpu = snap; drawCpu(); }).catch(() => {});
  refreshCpu();
  const tick = setInterval(() => { if (!document.body.contains(cpuBox)) { clearInterval(tick); return; } refreshCpu(); }, 2500);
  const cpuWrap = h("div", { class: "st-cpu-wrap" }, cpuBox, h("button", { class: "btn btn-ghost btn-sm", html: `${icon("refresh", 13)}<span>Refresh</span>`, onclick: refreshCpu }));

  const roll = segmented(ROLL.map((r) => r[0]), ROLL.some((r) => r[0] === +s.contextRolloverPct) ? +s.contextRolloverPct : 90, (v) => { setSharedSetting("contextRolloverPct", v); refreshCtxChip(); }, Object.fromEntries(ROLL));
  const digest = toggle(s.contextDigest !== false, (v) => setSharedSetting("contextDigest", v), { label: "Rolling digest" });

  // Workflow (the Orchestrator as primary): the switch and the door to the studio. These read and edit the
  // ACTIVE TAB's workflow (per-session selection, contract §10) through workflow/model.js setWorkflow, so the
  // tab's own copy — or the project's default when the tab never chose — stays the single source of truth.
  const wf = () => activeWorkflow();
  const setWf = async (patch) => { try { await setWorkflow(patch); } catch (e) { toast("Could not save the workflow: " + ((e && e.message) || e), "alert"); } refreshWorkflowChip(); };
  // Exclusive with solo sub-agents (2026-09-18): turning the workflow on asks, then turns them off; a cancel puts the knob back. Off keeps the tab's design.
  const wfOn = toggle(!!wf().enabled, async (v) => { await setWorkflowEnabled(v); wfOn._set(!!wf().enabled); subOn._set(!!state.settings.subAgents); refreshWorkflowChip(); }, { label: "Orchestrator workflow" });
  const wfAuto = toggle(wf().openJobTabs === true, (v) => setWf({ openJobTabs: v }), { label: "Open a tab for every job" });
  const wfOpen = h("div", { class: "st-btn-row" },
    h("button", { class: "btn btn-primary btn-sm", html: `${icon("activity", 14)}<span>Open Workflow studio</span>`, onclick: () => openWorkflowStudio() }),
    h("span", { class: "hint", style: "margin:0", text: `Active tab: ${wf().name || "Custom"}${hasOwnWorkflow() ? " (this tab's own)" : " (project default)"}` }));

  return {
    id: "agents", label: "Agents & context", ic: "agents", group: "Model",
    blurb: "Parallel worker agents, the Orchestrator workflow, how much of the machine agents may use, and what happens when a conversation outgrows the model's context window.",
    items: () => [
      section("Workflow", "activity"),
      field("Orchestrator workflow", wfOn, "The model you chat with becomes the Orchestrator: it manages, orchestrates and monitors the roles — it has the Planner draft the plan, delegates implementation to the Coder, asks the Reviewer and the Tester, keeps the task board current and reports back. Each role has its own provider, model, effort, access and sub-agent lane, designed on the canvas.", { keywords: "workflow roles orchestrator primary planner coder reviewer tester canvas" }),
      field("Workflow studio", wfOpen, "Design the roles on a canvas, set each role's sub-agent lane (on any provider), save workflows by name, import and export them.", { keywords: "canvas design save load import export library presets" }),
      field("Job tabs", wfAuto, "Off (default): delegated jobs run in the background through the atomnano CLI and come back to the Orchestrator as job cards — open any job's tab from its card or the Workflow studio. On: every job opens as a tab next to the orchestrator's (never steals focus).", { keywords: "jobs tabs child sessions background" }),
      section("Sub-agents", "agents"),
      field("Sub-agents", subOn, "Claude may delegate independent subtasks to numbered worker agents that run in parallel. The composer's Agents button toggles the same switch. Exclusive with the workflow: turning this on turns the active tab's workflow off (after asking), and turning a workflow on turns this off.", { keywords: "subagents parallel task delegate workers exclusive workflow" }),
      field("Tell the model its mode", modeNote, "A solo turn carries one sentence: the workflow is off for this chat, solo sub-agents on or off. It is sent once per thread on Codex and cached on Claude. Off = a bare turn.", { keywords: "mode note brief solo workflow aware" }),
      field("Max at once", maxAt, "1–20: how many agents may work at the same time. Handed to the CLI as its hard cap; Claude decides when delegating speeds the work up.", { keywords: "concurrent limit count" }),
      field("Yield to heavy processes", governor, "Off: your cap is the limit. On: while a build or other work saturates the CPU, new agents wait for a free slot (Claude is told when none comes) and the agent process runs at lower priority until the load drops.", { keywords: "governor throttle priority build" }),
      field("Running-agents strip", strip, "The chips above the composer while agents run — one per agent, click to open it in the Agents drawer.", { keywords: "chips live" }),
      field("Agents right now", cpuWrap, "How many agents run, how many slots are free, and the cap.", { wide: true, keywords: "load slots running" }),
      section("Context window", "gauge"),
      field("Roll over at", roll, "When the native thread is this full before a turn, the next message continues in a fresh native session that receives the record first — exact when it fits, else the digest plus the newest entries verbatim. Off = wait for the CLI's own compaction.", { keywords: "prompt too long rollover compaction overflow fresh session" }),
      field("Rolling digest", digest, "Once the thread is half full, keep a summary of the older record ready in the background so a rollover is instant. Uses the session's own model.", { keywords: "summary background" }),
      h("div", { class: "st-note" }, h("span", { html: icon("info", 14) }), h("span", { text: "AtomNano adds nothing to your prompts: no prefixes, no hidden summaries, no model downshifts. The only exception is context overflow, where the record is carried into a fresh session as configured here." })),
    ],
  };
}

export function sdkCategory({ s }) {
  // (The "Native SDK skills" control left on 2026-09-18: nothing sets `skills` in the Claude query options.)
  const addDirsInput = h("input", { class: "input", placeholder: "C:\\lib, D:\\shared (absolute)", value: Array.isArray(s.additionalDirectories) ? s.additionalDirectories.join(", ") : "" });
  addDirsInput.onchange = () => { s.additionalDirectories = addDirsInput.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean); atom.settings.set({ additionalDirectories: s.additionalDirectories }); };
  const disToolsInput = h("input", { class: "input", placeholder: "e.g. WebFetch, WebSearch", value: Array.isArray(s.disallowedTools) ? s.disallowedTools.join(", ") : "" });
  disToolsInput.onchange = () => { s.disallowedTools = disToolsInput.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean); atom.settings.set({ disallowedTools: s.disallowedTools }); };
  return {
    id: "sdk", label: "Agent SDK", ic: "cpu", group: "Model",
    blurb: "Capabilities of the Claude Agent SDK run underneath every Anthropic session.",
    items: () => [
      section("Run", "cpu"),
      field("File checkpoints", boolSetting("enableFileCheckpointing", { def: true, label: "File checkpoints" }), "Back up files before edits so a turn's changes can be rewound (Rewind under your prompts). Small disk overhead.", { keywords: "rewind undo backup" }),
      field("Subagent progress", boolSetting("agentProgressSummaries", { def: true, label: "Subagent progress" }), "Live status blurbs for running sub-agents, shown on their cards and in the Agents panel.", { keywords: "status blurbs" }),
      field("Subagent transcript", boolSetting("forwardSubagentText", { def: true, label: "Subagent transcript" }), "Stream sub-agents' own text and thinking into a nested view under their card.", { keywords: "nested output" }),
      field("Prompt suggestions", boolSetting("promptSuggestions", { label: "Prompt suggestions" }), "Show a predicted next-prompt chip after each reply. Nearly free — it rides the cache.", { keywords: "predict chips" }),
      section("Tools & access", "shield"),
      field("Extra read directories", addDirsInput, "Absolute paths the agent may read beyond the project folder.", { wide: true, keywords: "additional folders access" }),
      field("Disabled tools", disToolsInput, "Built-in tool names to remove from the agent entirely (e.g. WebFetch).", { wide: true, keywords: "disallow block webfetch websearch" }),
    ],
  };
}
