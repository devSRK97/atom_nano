/* AtomNano renderer — Workflow studio — the presets (each a function returning { name, enabled, roles, layout })
 * and the default canvas geometry: node sizes and positions for the ~900×660 design frame. The Orchestrator
 * (the primary) sits on the left; its four worker roles — Planner, Coder, Reviewer, Tester — stack on the right. */
import { defaultWorkflow } from "./model.js";

export const CANVAS_W = 900;
export const CANVAS_H = 660;
export const NODE_SIZE = {
  orchestrator: { w: 250, h: 150 },
  planner: { w: 236, h: 142 },    // head · model · chips · live sub-agent chips · status
  coder: { w: 236, h: 142 },
  reviewer: { w: 236, h: 142 },
  tester: { w: 236, h: 142 },
};
// Orchestrator on the left (vertically centred), the four worker roles stacked on the right — the Planner on top.
export const DEFAULT_LAYOUT = {
  orchestrator: { x: 72, y: 256 },
  planner: { x: 580, y: 20 },
  coder: { x: 580, y: 178 },
  reviewer: { x: 580, y: 336 },
  tester: { x: 580, y: 494 },
};
export function cloneLayout() { const out = {}; for (const [k, v] of Object.entries(DEFAULT_LAYOUT)) out[k] = { x: v.x, y: v.y }; return out; }
// Start from the contract's defaults and override per role.
export function rolesWith(over = {}) {
  const roles = defaultWorkflow().roles;
  for (const [r, patch] of Object.entries(over)) roles[r] = { ...roles[r], ...patch };
  return roles;
}
export function solo() { return { name: "Solo", enabled: false, roles: rolesWith(), layout: cloneLayout() }; }
export function planCode() {
  return { name: "Plan → Code", enabled: true, roles: rolesWith({ planner: { enabled: true, provider: "anthropic", effort: "high", access: "read", agents: 0 }, coder: { enabled: true, provider: "anthropic", effort: "high", access: "bypassPermissions", agents: 3 }, reviewer: { enabled: false }, tester: { enabled: false } }), layout: cloneLayout() };
}
export function planCodeReview() {
  return { name: "Plan → Code → Review", enabled: true, roles: rolesWith({ planner: { enabled: true, provider: "anthropic", effort: "high", access: "read", agents: 0 }, coder: { enabled: true, provider: "anthropic", effort: "high", access: "bypassPermissions", agents: 3 }, reviewer: { enabled: true, provider: "openai", effort: "medium", access: "read", agents: 0 }, tester: { enabled: false } }), layout: cloneLayout() };
}
export function orchestra() {
  return { name: "Full orchestra", enabled: true, roles: rolesWith({ planner: { enabled: true, provider: "anthropic", effort: "high", access: "read", agents: 2 }, coder: { enabled: true, provider: "anthropic", effort: "high", access: "bypassPermissions", agents: 4 }, reviewer: { enabled: true, provider: "openai", effort: "medium", access: "read", agents: 2 }, tester: { enabled: true, provider: "anthropic", effort: "medium", access: "bypassPermissions", agents: 0 } }), layout: cloneLayout() };
}
export function claudePlansCodexCodes() {
  return { name: "Claude plans, Codex codes", enabled: true, roles: rolesWith({ orchestrator: { provider: "anthropic", model: "", effort: "high", access: "bypassPermissions" }, planner: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "read", agents: 0 }, coder: { enabled: true, provider: "openai", model: "", effort: "high", access: "bypassPermissions", agents: 3 }, reviewer: { enabled: true, provider: "anthropic", effort: "medium", access: "read", agents: 0 }, tester: { enabled: true, provider: "openai", effort: "medium", access: "bypassPermissions", agents: 0 } }), layout: cloneLayout() };
}
export function codexPlansClaudeCodes() {
  return { name: "Codex plans, Claude codes", enabled: true, roles: rolesWith({ orchestrator: { provider: "openai", model: "", effort: "high", access: "bypassPermissions" }, planner: { enabled: true, provider: "openai", model: "", effort: "high", access: "read", agents: 0 }, coder: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "bypassPermissions", agents: 3 }, reviewer: { enabled: true, provider: "openai", effort: "medium", access: "read", agents: 0 }, tester: { enabled: true, provider: "anthropic", effort: "medium", access: "bypassPermissions", agents: 0 } }), layout: cloneLayout() };
}
export const PRESETS = [
  { id: "solo", name: "Solo", desc: "Workflow off — one model, no roles", icon: "dot", make: solo },
  { id: "plan-code", name: "Plan → Code", desc: "Orchestrator, a read-only Planner and a Coder with 3 sub-agents", icon: "fileCode", make: planCode },
  { id: "plan-code-review", name: "Plan → Code → Review", desc: "…plus a read-only Reviewer on OpenAI", icon: "shield", make: planCodeReview },
  { id: "orchestra", name: "Full orchestra", desc: "Planner + Coder + Reviewer + Tester, lanes on three of them", icon: "agents", make: orchestra },
  { id: "claude-codex", name: "Claude plans, Codex codes", desc: "Anthropic Orchestrator + Planner · OpenAI Coder", icon: "brain", make: claudePlansCodexCodes },
  { id: "codex-claude", name: "Codex plans, Claude codes", desc: "OpenAI Orchestrator + Planner · Anthropic Coder", icon: "sparkle", make: codexPlansClaudeCodes },
];
// The patch atom.workflow.set receives for a preset: a fresh, unsaved design under the preset's name.
export function presetPatch(p) { const w = p.make(); return { name: w.name, enabled: w.enabled, roles: w.roles, layout: w.layout, savedId: null }; }
