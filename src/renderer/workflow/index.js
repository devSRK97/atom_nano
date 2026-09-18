/* AtomNano renderer — Workflow studio (orchestrator-as-primary): the canvas where the roles — the
 * Orchestrator (the primary) and its workers Planner · Coder · Reviewer · Tester — are designed, the library of
 * saved workflows, and the live view while role jobs run. This file is the contract the rest of the renderer
 * imports (docs/WORKFLOW_CONTRACT.md §7);
 * the implementation is split into studio.js (shell), canvas.js, inspector.js, live.js, model.js, presets.js. */
export { openWorkflowStudio, closeWorkflowStudio, toggleWorkflowStudio } from "./studio.js";
export { workflowChip, refreshWorkflowChip, taskBoardChip, refreshBoardChip, onWorkflowJob, onWorkflowStage, workflowJobsFor, notify as notifyWorkflow } from "./live.js";
// The active tab's workflow (its own, else the project's — per-session selection, contract §10) and its edit path.
export { activeWorkflow, tabWorkflow, hasOwnWorkflow, setWorkflow, useProjectWorkflow } from "./model.js";
// The workflow switch and its exclusivity with solo sub-agents (2026-09-18): setWorkflowEnabled asks before turning on
// while solo sub-agents are on and turns them off; confirmWorkflowOn is that question alone (presets); the composer
// registers onSoloAgentsChanged to redraw its Agents button when the workflow code flips the shared setting.
export { setWorkflowEnabled, confirmWorkflowOn, setSoloAgentsSetting, soloAgentsOn, onSoloAgentsChanged } from "./model.js";
