"use strict";
/* Workflow (orchestrator-as-primary) regression suite — DESIRED behaviour for docs/WORKFLOW_CONTRACT.md
 * §1–3, §10 (store defaults + session fields, the SessionManager mixin src/main/session/workflow.js):
 *   · settings: the active workflow (per-project) and the library (global) exist with the contract's
 *     defaults; workflowFor fills / clamps whatever is saved and migrates a pre-Orchestrator save;
 *     access → permission mode mapping;
 *   · the ORCHESTRATOR: with the workflow on, the primary turn runs with the orchestrator role's picks and
 *     the generated brief (Claude: systemPrompt.append; Codex: labelled prompt appendix), the CLI env
 *     carries ATOMNANO_SESSION, stage events run running → done; with it off an ordinary turn is untouched;
 *   · JOBS: a role job (planner / coder / reviewer / tester) is a child session (parentId / role / provider /
 *     jobId) run with the role's model, access, effort and sub-agent lane — on Claude AND on Codex; the
 *     orchestrator gets a job card; queued → running → done | error | stopped with the child's final text
 *     as the result; wait / stop / log; command jobs capture output and exit codes (bounded, timeout);
 *     Stop on the orchestrator leaves its jobs running; the fields persist.
 * The ORIGINAL session modules run in a VM with a scripted fake SDK and a fake Codex app-server; store,
 * history, agents and platform are REAL on an isolated data home. No network, no model calls, no saved
 * conversations.  Run: node scripts/test-workflow.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const ROOT = path.join(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-workflow-"));
process.env.ATOMNANO_MAX_MESSAGES = "60";
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, "claude-home"); fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
process.env.CODEX_HOME = path.join(HOME, "codex-home"); fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === "electron") return { app: { getPath: (k) => (k === "userData" ? HOME : os.homedir()), getAppPath: () => ROOT, isPackaged: false } }; return origLoad.call(this, req, ...rest); };

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 900) : ""}`); } }
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 180000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = require(path.join(ROOT, "src/main/storage/store.js"));
const history = require(path.join(ROOT, "src/main/storage/history.js"));
store.loadSettings();
store.saveSettings({ llmProvider: "anthropic", modeNote: false });   // modeNote off: these suites assert bare solo turns (the note has its own checks, test-workflow W29)
const { loadSessionInVm } = require("./lib/session-vm");   // the ORIGINAL session modules, fakes injected

/* One isolated SessionManager. `control.script(ctx)` is an async generator producing a Claude query's
 * messages ({ opts, call }); `control.app(opts, call)` answers a Codex app-server turn. */
function environment() {
  const sends = [], sdkCalls = [], appCalls = [];
  const control = { script: null, app: null };
  const sdk = { query(opts) {
    const call = { prompt: opts.prompt, options: opts.options, prompts: [], promptEnded: false, interrupts: 0 }; sdkCalls.push(call);
    call.consumed = (async () => { for await (const m of opts.prompt) { call.prompts.push(m.message.content); } call.promptEnded = true; return call.prompts; })();
    const gen = (control.script || defaultScript)({ opts, call });
    const q = { [Symbol.asyncIterator]() { return gen; }, next: (...a) => gen.next(...a), return: (...a) => gen.return(...a), throw: (...a) => gen.throw(...a),
      interrupt: async () => { call.interrupts++; if (call.onInterrupt) call.onInterrupt(); return {}; }, setPermissionMode: async () => {}, setModel: async () => {} };
    call.q = q; return q;
  } };
  async function* defaultScript({ call }) {
    await sleep(5);
    yield { type: "system", subtype: "init", session_id: call.options.resume || "native-" + sdkCalls.length, model: call.options.model };
    yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "Synthetic reply." }] } };
    yield { type: "result", subtype: "success", is_error: false, session_id: call.options.resume || "native-" + sdkCalls.length, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 };
    await call.consumed;
  }
  let turnSeq = 0;
  const appserver = {
    ctxKeyOf: () => "login",
    async run(opts) {
      const id = opts.resumeId || "native-openai-" + (appCalls.length + 1), isNew = !opts.resumeId;
      const call = { prompt: opts.promptText, resume: opts.resumeId || null, id, opts }; appCalls.push(call);
      opts.on.onThreadId(id, isNew, "login");
      try { await opts.beforeTurn(id, isNew); } catch (e) { return { ok: false, error: "conversation transfer failed: " + e.message, threadId: id }; }
      opts.on.onTurnId("turn-" + (++turnSeq));
      if (control.app) return control.app(opts, call);
      return { ok: true, text: "Codex reply.", threadId: id };
    },
    async injectItems() { return { ok: true }; }, interrupt: async () => true, steer: async () => ({ ok: true }),
  };
  const providers = {
    get: (p) => ({ label: p === "openai" ? "OpenAI" : p === "custom" ? "Custom API" : "Anthropic", models: p === "openai" ? [{ id: "gpt-5.5", ctx: 272000 }] : [{ id: "claude-opus-4-8", ctx: 200000, ctx1m: true }], defaultModel: p === "openai" ? "gpt-5.5" : p === "custom" ? "" : "claude-opus-4-8", defaultReasoning: p === "openai" ? "medium" : "high", primary: "sdk" }),
    context1M: () => true, resolveOpenAIModelStrict: (id) => ({ model: id || "gpt-5.5" }), resolveOpenAIModel: (id) => ({ model: id || "gpt-5.5" }), openaiEffortStrict: (e) => ({ effort: e || "medium" }), openaiEffort: () => "medium",
  };
  const map = { path, fs, os, crypto: require("crypto"), child_process: require("child_process"), "./store": store, "./history": history, "./cli-auth": {}, "./attachments": { persistAll: (a) => a, light: (a) => a, readBase64: () => "" }, "./tool-args": require(path.join(ROOT, "src/main/session/tool-args.js")), "./subagents": require(path.join(ROOT, "src/main/agents/subagents.js")), "./skills": require(path.join(ROOT, "src/main/agents/skills.js")), "./convo": require(path.join(ROOT, "src/main/storage/convo.js")), "./catalog": providers, "./codex-appserver": appserver, "./codex-exec": { run: async () => ({ ok: true, text: "" }) }, "./codex-cards": { unwrapCmd: (x) => x, parseDiff: () => ({ oldText: "", newText: "", added: 0, removed: 0 }), classifyCmd: () => null }, "./council": { reviewerRun: async () => ({ ok: true, text: "advice" }), label: () => "Reviewer" }, "./custom-api": { getEndpoint: () => null, call: async () => ({ ok: true, text: "custom" }) }, "./platform": require(path.join(ROOT, "src/main/platform.js")) };
  const { M } = loadSessionInVm({ deps: map, sdk });
  M.send = (name, data) => sends.push({ name, data, t: Date.now() });
  M.buildEnv = () => ({}); M.resolveCli = async () => "claude"; M.composeMcp = () => ({}); M.registerModel = () => {}; M.scheduleRetry = () => {};
  M.setSummarizer(async () => "summary");
  M.resultReleaseGraceMs = 30;   // real value 2.5 s — shortened so the suite stays quick
  const make = (opts = {}) => { const v = store.createSession({ cwd: HOME, name: opts.name || "planner", model: opts.model || "claude-opus-4-8", thinking: opts.thinking || "low", permissionMode: opts.permissionMode || "default" }); store.flush(v.id); return store.getSession(v.id); };
  const setProvider = (p) => store.saveSettings({ llmProvider: p });
  const setWorkflow = (wf) => store.saveSettings({ workflow: wf });   // global (no project) → every project, unless a project overrides it
  return { M, make, sends, sdkCalls, appCalls, control, setProvider, setWorkflow };
}
const D = () => store.workflowDefaults();
const BANNED = /caveman|frugal|codefrugal|readgate|ROTATE_TURNS|contextHandoff|rotateSession|convoDigest|HANDOFF_|BATCH_PROMPT_CAP|_imgHashes|imageHash|CLAUDE_CODE_MAX_WEB_SEARCHES|ENABLE_PROMPT_CACHING_1H|MAKEFLAGS|maxBudgetUsd|taskBudget|isTrivialContinuation|resolveThinkingLevel|fallbackModel|maybeHeal|_healTurn|planHeal|truncateDeep|session-context/;
const JOB_KEYS = ["id", "kind", "role", "parentId", "sessionId", "task", "command", "status", "startedTs", "endedTs", "durationMs", "provider", "model", "effort", "access", "agents", "result", "exitCode", "editedFiles", "tokensIn", "tokensOut", "agentsLive", "from", "error"];
const fails = async (fn) => { try { await fn(); return null; } catch (x) { return x; } };

async function main() {
  // ---- W01: defaults, deep-fill / clamps, per-project active vs global library ----
  { const s = store.getSettings();
    check("W01", "defaults: the active workflow (disabled, 'Solo', the Orchestrator primary + four worker roles with the contract's picks — the Planner read-only, on) and an empty library are present", s.workflow && s.workflow.enabled === false && s.workflow.name === "Solo" && s.workflow.savedId === null && s.workflow.roles.orchestrator.provider === "" && s.workflow.roles.orchestrator.access === "bypassPermissions" && s.workflow.roles.planner.enabled === true && s.workflow.roles.planner.provider === "anthropic" && s.workflow.roles.planner.access === "read" && s.workflow.roles.planner.agents === 0 && s.workflow.roles.coder.agents === 3 && s.workflow.roles.coder.effort === "high" && s.workflow.roles.reviewer.provider === "openai" && s.workflow.roles.reviewer.access === "read" && s.workflow.roles.tester.command === "" && s.workflow.openJobTabs === false && !("autoOpenJobs" in s.workflow) && s.workflow.brief === "" && Array.isArray(s.workflows) && s.workflows.length === 0 && JSON.stringify(D()) === JSON.stringify(s.workflow), s.workflow);
    const e = environment();
    e.setWorkflow({ enabled: true, roles: { coder: { agents: 99, access: "nonsense" }, reviewer: { provider: "nope" }, orchestrator: { access: "" } } });
    const wf = e.M.workflowFor(HOME);
    check("W01b", "workflowFor deep-fills and clamps a partial saved workflow: lane 99 → 20, unknown access → bypassPermissions, unknown provider → the role's default, a missing role filled (the Planner worker too), the orchestrator's '' access kept (follow the composer)", wf.enabled === true && wf.roles.coder.agents === 20 && wf.roles.coder.access === "bypassPermissions" && wf.roles.coder.provider === "anthropic" && wf.roles.coder.enabled === true && wf.roles.reviewer.provider === "openai" && wf.roles.reviewer.access === "read" && wf.roles.tester.enabled === true && wf.roles.tester.command === "" && wf.roles.planner.enabled === true && wf.roles.planner.access === "read" && wf.roles.orchestrator.access === "" && wf.name === "Solo" && wf.openJobTabs === false && wf.brief === "" && JSON.stringify(wf.layout) === "{}", wf);
    e.setWorkflow({ roles: { coder: { agents: -5 } } });
    check("W01c", "a negative lane clamps to 0 (solo coder); garbage never throws (defaults come back)", e.M.workflowFor(HOME).roles.coder.agents === 0 && e.M.workflowFor({ cwd: HOME }, { workflow: "garbage" }).roles.coder.agents === 3 && e.M.workflowFor(null, { workflow: { roles: null } }).roles.orchestrator.provider === "" && e.M.workflowFor(undefined).enabled === false);
    // A workflow saved before the Orchestrator existed (2026-09-17): the primary's picks sat under roles.planner.
    const legacy = e.M.workflowFor(null, { workflow: { enabled: true, roles: { planner: { provider: "openai", model: "gpt-5.5", effort: "high", access: "acceptEdits" }, coder: { agents: 7 } }, layout: { planner: { x: 10, y: 20 }, coder: { x: 500, y: 40 } } } });
    const kept = e.M.workflowFor(null, { workflow: { roles: { orchestrator: { provider: "openai" }, planner: { provider: "openai", enabled: false, agents: 2 } } } });
    check("W01d", "a pre-Orchestrator save migrates: the old primary's picks under roles.planner (no enabled / agents) move to roles.orchestrator and its node to layout.orchestrator; the Planner takes the worker defaults (Anthropic · high · read-only, on); a save that already has an orchestrator is left alone", legacy.roles.orchestrator.provider === "openai" && legacy.roles.orchestrator.model === "gpt-5.5" && legacy.roles.orchestrator.effort === "high" && legacy.roles.orchestrator.access === "acceptEdits" && legacy.roles.planner.enabled === true && legacy.roles.planner.provider === "anthropic" && legacy.roles.planner.access === "read" && legacy.roles.planner.agents === 0 && legacy.roles.coder.agents === 7 && legacy.layout.orchestrator.x === 10 && !legacy.layout.planner && legacy.layout.coder.x === 500 && kept.roles.orchestrator.provider === "openai" && kept.roles.planner.enabled === false && kept.roles.planner.provider === "openai" && kept.roles.planner.agents === 2, { legacy, kept });
    store.saveSettings({ workflows: [{ id: "lib-1", name: "L", createdAt: "", updatedAt: "", workflow: {} }] }, HOME);
    const other = path.join(HOME, "other-project");
    check("W01d", "the LIBRARY is global: saved 'for a project' it lands in the global settings and shows for every project", store.getSettings(other).workflows.length === 1 && store.getSettings(other).workflows[0].id === "lib-1" && store.getSettings().workflows[0].id === "lib-1" && !(store.getSettings().projectSettings && store.getSettings().projectSettings[other.replace(/\\/g, "/").toLowerCase()] && "workflows" in store.getSettings().projectSettings[other.replace(/\\/g, "/").toLowerCase()]));
    store.saveSettings({ workflow: { ...D(), enabled: true, name: "ProjOnly" } }, other);
    check("W01e", "the ACTIVE workflow is per-project: enabling it for one folder does not enable it elsewhere", e.M.workflowFor(other).enabled === true && e.M.workflowFor(other).name === "ProjOnly" && e.M.workflowFor(HOME).enabled === false && e.M.workflowFor({ cwd: other }).enabled === true); }

  // ---- W02: access → permission mode ----
  { const e = environment();
    check("W02", "accessToPermission: read → plan; acceptEdits / default / bypassPermissions pass through; unknown or empty → bypassPermissions", e.M.accessToPermission("read", "anthropic") === "plan" && e.M.accessToPermission("plan", "openai") === "plan" && e.M.accessToPermission("acceptEdits") === "acceptEdits" && e.M.accessToPermission("default") === "default" && e.M.accessToPermission("bypassPermissions", "openai") === "bypassPermissions" && e.M.accessToPermission("", "anthropic") === "bypassPermissions" && e.M.accessToPermission("weird") === "bypassPermissions" && e.M.accessToPermission(undefined) === "bypassPermissions"); }

  // ---- W03: the planner brief + the role briefs ----
  { const e = environment(); const d = D();
    e.setWorkflow({ ...d, enabled: true, name: "Team", roles: { ...d.roles, tester: { ...d.roles.tester, command: "npm test" } } });
    const s = e.make({ model: "claude-opus-4-8", thinking: "high", permissionMode: "acceptEdits" });
    const wf = e.M.workflowFor(s);
    const brief = e.M.plannerBrief(s, wf, "anthropic");
    const cmds = ['atomnano run planner "<request>"', 'atomnano run coder "<task>" [--from <job id>]', 'atomnano run reviewer "<what to review>"', 'atomnano test [--cmd "<command>"]', "atomnano jobs · wait <id> · result <id> · stop <id> · roles · status"];
    check("W03", "the generated orchestrator brief says who the orchestrator is (the primary that manages, orchestrates and monitors the roles), lists the roles (provider · model · effort · access, the coder's lane, the tester's command — the Planner among them), every CLI command (the plan command too, the coder example with --from and WITHOUT --json), that a job's result is the command output, and this session's id with --session", cmds.every((c) => brief.includes(c)) && brief.includes(`Your session id is ${s.id} — pass --session ${s.id} when a command asks for it.`) && /Orchestrator \(you\): Anthropic · claude-opus-4-8 · high · accept edits/.test(brief) && /Planner: Anthropic · default model · high · read-only/.test(brief) && /Coder: Anthropic · default model · high · full access · up to 3 sub-agents/.test(brief) && /Reviewer: OpenAI · default model · medium · read-only/.test(brief) && /Tester: Anthropic · default model · medium · full access · test command: npm test/.test(brief) && /"Team" workflow/.test(brief) && /manage, orchestrate and monitor every other role/.test(brief) && /have the Planner draft the plan/.test(brief) && /Coding work goes to the Coder through the atomnano CLI \(your Bash tool\)/.test(brief) && /have the Reviewer review and the Tester test the result \(both at once\)/.test(brief) && /a job's result is the command output/.test(brief) && /Monitor the jobs, verify what comes back and report to the user/.test(brief) && !/--json/.test(brief) && !/Planner \(you\)/.test(brief), { brief });
    check("W03a", "TRIAGE (2026-09-18): simple requests are answered directly with no roles or board; small clear coding goes straight to the Coder with no plan; the Planner is reserved for larger or unclear coding work and its plan is handed to the Coder with --from <planner job id>; fix-ups go straight back to the Coder with --from <reviewer job id>; waiting is --wait --timeout 540, then atomnano wait <id> --timeout 540, under a 600 s shell-tool timeout (the old 100 s slices are gone)", /Simple requests — questions, explanations, summaries, reviews of text or ideas, advice, lookups, any non-coding work — you answer yourself: no Planner, no Coder, no task board/.test(brief) && /a small, clear change \(a bug fix, a rename\) straight away, no plan\./.test(brief) && /For larger or unclear coding work \(several files, design decisions, unknown code\) have the Planner draft the plan, decide on it, then hand it to the Coder with --from <planner job id> \(--context when the discussion matters\)/.test(brief) && /fix-ups go straight back to the Coder with --from <reviewer job id> — no new plan/.test(brief) && /Wait with --wait --timeout 540 \(returns after 540 s; the job keeps running\), then atomnano wait <id> --timeout 540 until it ends, with your shell tool's timeout at 600 s; without --wait a job runs in the background/.test(brief) && !/timeout 100/.test(brief) && /--from <job id> \(append that finished job's saved result to the task\)/.test(brief) && /a direct answer needs no board/.test(brief), { brief });
    check("W03a2", "CONTINUITY (2026-09-18): the orchestrator is told that each role keeps ONE persistent session for this chat and remembers its earlier tasks — build on them, send follow-ups to the same role, wait for a busy role rather than spawn a second session, --fresh starts over (and --fresh is among the CLI options)", /Each role keeps ONE persistent session for this chat and remembers its earlier tasks and results: build on them, send follow-ups to the same role/.test(brief) && /A busy role gets a second, fresh session — for continuity wait for its job first; --fresh starts a role over/.test(brief) && /--fresh \(a new session for the role\)/.test(brief), { brief });
    check("W03a3", "IDLE ROLES (2026-09-18): the orchestrator is told to pipeline — while the Coder implements one part the Planner plans the next and the Reviewer / Tester check finished parts, such jobs started without --wait and collected with atomnano jobs / wait; lanes: divisible tasks, a bigger lane for a broad investigation", /Keep idle roles busy — while the Coder implements one part, the Planner plans the next and the Reviewer and Tester check finished parts: start such jobs without --wait and collect them with atomnano jobs \/ wait <id>\./.test(brief) && /Roles with sub-agents work in parallel: give them divisible tasks, a broad investigation a bigger lane \(--agents N\)/.test(brief), { brief });
    check("W03b", "the brief is plain prose + bullets (no markdown headings or fences), under 3,300 characters (compacted 2026-09-18 from 3,978 to about 3,150 with every rule kept — triage, small-change delegation, planning with --from, disabled-role fallbacks, parallel review / test, direct fix-ups, the board paragraph verbatim, lanes, idle-role pipelining, continuity / --fresh, the roles table, the CLI options and the session id), and carries none of the removed-layer tokens", brief.length < 3300 && !/^#/m.test(brief) && !/```/.test(brief) && !BANNED.test(brief), { length: brief.length });
    check("W03c", "a user-written override is returned verbatim; a whitespace-only override falls back to the generated text", e.M.plannerBrief(s, { ...wf, brief: "  MY OWN BRIEF  " }, "anthropic") === "  MY OWN BRIEF  " && e.M.plannerBrief(s, { ...wf, brief: "   " }, "anthropic") === brief);
    const b3 = e.M.plannerBrief(s, { ...wf, roles: { ...wf.roles, reviewer: { ...wf.roles.reviewer, enabled: false } } }, "anthropic");
    check("W03d", "a disabled role is listed as disabled, its run command, its mention and its --from handoff are left out", /Reviewer: disabled/.test(b3) && !b3.includes("atomnano run reviewer") && b3.includes("atomnano run coder") && !/the Reviewer review/.test(b3) && /After code changes have the Tester test the result; fix-ups go straight back to the Coder — no new plan\./.test(b3) && !/\(both at once\)/.test(b3) && !/--from <reviewer job id>/.test(b3), { b3 });
    const b3p = e.M.orchestratorBrief(s, { ...wf, roles: { ...wf.roles, planner: { ...wf.roles.planner, enabled: false } } }, "anthropic");
    const b3c = e.M.orchestratorBrief(s, { ...wf, roles: { ...wf.roles, coder: { ...wf.roles.coder, enabled: false } } }, "anthropic");
    check("W03d2", "with the Planner disabled the orchestrator is told to decide the plan itself; the plan command and the planner handoff are left out; with the Coder disabled it does the coding itself, follows the plan itself and does the fix-ups itself (no --from to a Coder, no coder command)", /Planner: disabled/.test(b3p) && /decide the plan yourself \(the Planner role is disabled\)/.test(b3p) && !b3p.includes("atomnano run planner") && !/have the Planner draft/.test(b3p) && !/--from <planner job id>/.test(b3p) && /Coding work you do yourself \(the Coder role is disabled\)/.test(b3c) && /have the Planner draft the plan, decide on it, then follow it yourself\./.test(b3c) && /fix-ups you do yourself/.test(b3c) && !/--from <planner job id>/.test(b3c) && !/--from <reviewer job id>/.test(b3c) && /--from <job id> \(append/.test(b3c) && !b3c.includes('- atomnano run coder "<task>"') && b3c.includes("atomnano run coder \"…\" --task T3"), { b3p, b3c });
    const b4 = e.M.plannerBrief(e.make({ model: "gpt-5.5", thinking: "medium", permissionMode: "plan" }), wf, "openai");
    check("W03e", "the orchestrator row follows the run's own provider / model / effort / access (a Codex orchestrator in read-only); plannerBrief is the pre-Orchestrator alias of orchestratorBrief", /Orchestrator \(you\): OpenAI · gpt-5.5 · medium · read-only/.test(b4) && e.M.orchestratorBrief(s, wf, "anthropic") === brief, { b4 });
    const rb = ["coder", "reviewer", "tester"].map((r) => e.M.roleBrief(r, wf));
    const pb = e.M.roleBrief("planner", wf);
    const sentences = (t) => (t.match(/[.!?](\s|$)/g) || []).length;
    const pb2 = e.M.roleBrief("planner", { ...wf, roles: { ...wf.roles, planner: { ...wf.roles.planner, agents: 3 } } });
    check("W03f", "role briefs: the planner plans only (a concise implementation plan the Coder follows, no implementation, the Orchestrator decides) and, with a lane, splits the INVESTIGATION across its read-only sub-agents — one area / module / question each, in parallel, findings combined into the plan; the coder implements exactly the task (its lane named, a carried plan followed) and reports what changed + how it was verified; the reviewer reviews only, no edits, findings by severity; the tester runs the configured command and reports pass/fail with the failing output; 2–4 sentences each; the orchestrator / unknown → ''", /Planner/.test(pb) && /plan only/.test(pb) && /implementation plan the Coder will follow/.test(pb) && /Do not implement anything yourself/.test(pb) && /the Orchestrator decides on your plan/.test(pb) && !/sub-agent/.test(pb) && /up to 3 sub-agents \(read-only, like you\)/.test(pb2) && /speed the investigation up/.test(pb2) && /one area, module or question each/.test(pb2) && /run them in parallel, then combine what they found into the plan/.test(pb2) && sentences(pb2) >= 2 && sentences(pb2) <= 4 && /when the task carries a plan, follow its steps/.test(rb[0]) && [pb, ...rb].every((t) => /This session is your persistent one for this chat/.test(t) && /build on them rather than starting over/.test(t)) && /Coder/.test(rb[0]) && /implement exactly the task/.test(rb[0]) && /up to 3 sub-agents/.test(rb[0]) && /report what changed/.test(rb[0]) && /how you verified it/.test(rb[0]) && /Reviewer/.test(rb[1]) && /review only/.test(rb[1]) && /do not edit files/.test(rb[1]) && /ordered by severity/.test(rb[1]) && /Tester/.test(rb[2]) && /`npm test`/.test(rb[2]) && /pass or fail/.test(rb[2]) && /failing output/.test(rb[2]) && [pb, ...rb].every((t) => sentences(t) >= 2 && sentences(t) <= 4 && !BANNED.test(t)) && e.M.roleBrief("orchestrator", wf) === "" && e.M.roleBrief("nope", wf) === "" && !/up to/.test(e.M.roleBrief("coder", { ...wf, roles: { ...wf.roles, coder: { ...wf.roles.coder, agents: 0 } } })), { pb, rb }); }

  // ---- W04: the ORCHESTRATOR on Claude (workflow on) vs an ordinary turn (workflow off) ----
  { const e = environment(); e.setProvider("anthropic"); const d = D();
    e.setWorkflow({ ...d, enabled: true, name: "Team", roles: { ...d.roles, orchestrator: { provider: "", model: "claude-sonnet-4-6", effort: "medium", access: "acceptEdits" } } });
    const s = e.make({ model: "claude-opus-4-8", thinking: "low", permissionMode: "default" });
    let legacyPlanner = 0; e.M.runPlanner = async () => { legacyPlanner++; return { plan: "", aborted: false }; };
    await e.M.run(s.id, { text: "PLAN THIS", model: "claude-opus-4-8", permissionMode: "default", thinking: "low", planner: { enabled: true, provider: "openai", model: "gpt-5.5" } });
    const call = e.sdkCalls[0];
    const st = e.sends.filter((x) => x.name === "session:status" && x.data.sessionId === s.id).map((x) => x.data);
    const stages = e.sends.filter((x) => x.name === "workflow:stage" && x.data.sessionId === s.id).map((x) => x.data);
    check("W04", "workflow ON: the primary turn IS the orchestrator — the orchestrator role's model / effort / access replace the composer's picks, the brief is Claude's system-prompt append (preset kept), the CLI env carries ATOMNANO_SESSION, the user's text is the whole prompt, the legacy Plan→Code step is skipped", call && call.options.model === "claude-sonnet-4-6" && call.options.permissionMode === "acceptEdits" && call.options.effort === "medium" && call.options.systemPrompt && call.options.systemPrompt.type === "preset" && call.options.systemPrompt.preset === "claude_code" && typeof call.options.systemPrompt.append === "string" && call.options.systemPrompt.append.includes(`Your session id is ${s.id}`) && call.options.systemPrompt.append.includes("atomnano run coder") && call.options.systemPrompt.append.includes("atomnano run planner") && call.options.systemPrompt.append.includes("claude-sonnet-4-6 · medium · accept edits") && call.options.env.ATOMNANO_SESSION === s.id && call.prompts[0] === "PLAN THIS" && legacyPlanner === 0 && s.status === "done" && e.M.lastRunInfo().sent.roleBrief > 0, { model: call && call.options.model, mode: call && call.options.permissionMode, effort: call && call.options.effort, sys: call && call.options.systemPrompt && Object.keys(call.options.systemPrompt), env: call && call.options.env, legacyPlanner, status: s.status });
    check("W04b", "the dispatched snapshot (session:status running) reflects the override; workflow:stage orchestrator running → done", st[0] && st[0].status === "running" && st[0].model === "claude-sonnet-4-6" && st[0].effort === "medium" && st[0].permissionMode === "acceptEdits" && st[0].provider === "anthropic" && stages.length === 2 && stages[0].stage === "orchestrator" && stages[0].status === "running" && stages[0].model === "claude-sonnet-4-6" && stages[1].status === "done" && stages[1].model === "claude-sonnet-4-6" && stages[1].provider === "anthropic", { st, stages });
    e.setWorkflow({ ...d, enabled: false });
    const s2 = e.make({ model: "claude-opus-4-8", thinking: "low", permissionMode: "default" });
    await e.M.run(s2.id, { text: "ORDINARY" });
    const c2 = e.sdkCalls[1];
    check("W04c", "workflow OFF: an ordinary turn is untouched — the composer's model / mode, the bare preset system prompt (no append), no stage events; ATOMNANO_SESSION is still set (the CLI can always address the tab)", c2 && c2.options.model === "claude-opus-4-8" && c2.options.permissionMode === "default" && !("append" in c2.options.systemPrompt) && JSON.stringify(c2.options.systemPrompt) === JSON.stringify({ type: "preset", preset: "claude_code" }) && e.sends.filter((x) => x.name === "workflow:stage" && x.data.sessionId === s2.id).length === 0 && c2.options.env.ATOMNANO_SESSION === s2.id && c2.prompts[0] === "ORDINARY" && s2.status === "done", { sys: c2 && c2.options.systemPrompt });
    e.setWorkflow({ ...d, enabled: true });
    const s3 = e.make(); await e.M.run(s3.id, { text: "BG", background: true });
    const s4 = e.make(); await e.M.run(s4.id, { text: "FLEET", fleet: { taskId: "t1" } });
    check("W04d", "a background turn and a fleet task never become the planner even with the workflow on", !("append" in e.sdkCalls[2].options.systemPrompt) && !("append" in e.sdkCalls[3].options.systemPrompt) && !e.sends.some((x) => x.name === "workflow:stage" && (x.data.sessionId === s3.id || x.data.sessionId === s4.id))); }

  // ---- W05: the PLANNER on Codex — the brief as a labelled appendix; the planner's provider overrides the settings ----
  { const e = environment(); e.setProvider("openai"); const d = D();
    e.setWorkflow({ ...d, enabled: true });
    const s = e.make({ model: "gpt-5.5", thinking: "medium" });
    await e.M.run(s.id, { text: "PLAN THIS ON CODEX" });
    const call = e.appCalls[0];
    const LABEL = "Role brief for this conversation (configured by the user in the Workflow studio):\n";
    check("W05", "Codex orchestrator: the user's exact text first, then the labelled brief in the prompt appendix; model / effort follow the composer when the orchestrator role leaves them empty; stage events carry provider openai; an ordinary primary turn passes no multi-agent override to Codex", call && call.prompt.startsWith("PLAN THIS ON CODEX\n\n") && call.prompt.indexOf(LABEL) > 0 && call.prompt.slice(call.prompt.indexOf(LABEL) + LABEL.length).startsWith("You are the Orchestrator") && call.prompt.includes(`Your session id is ${s.id}`) && call.opts.model === "gpt-5.5" && call.opts.effort === "medium" && !("features.multi_agent" in (call.opts.config || {})) && s.status === "done" && e.sends.some((x) => x.name === "workflow:stage" && x.data.sessionId === s.id && x.data.stage === "orchestrator" && x.data.status === "done" && x.data.provider === "openai"), { head: call && call.prompt.slice(0, 160), model: call && call.opts.model, cfg: call && call.opts.config });
    e.setProvider("anthropic");
    e.setWorkflow({ ...d, enabled: true, roles: { ...d.roles, orchestrator: { provider: "openai", model: "gpt-5.5", effort: "high", access: "read" } } });
    const s2 = e.make({ model: "claude-opus-4-8" });
    await e.M.run(s2.id, { text: "CROSS" });
    const c2 = e.appCalls[1];
    check("W05b", "an orchestrator role pinned to openai runs on Codex although the settings say anthropic (read access → plan → read-only sandbox); no Claude query is made", c2 && c2.opts.model === "gpt-5.5" && c2.opts.effort === "high" && c2.opts.mode === "plan" && e.sdkCalls.length === 0 && s2.lastProvider === "openai" && s2.status === "done", { c2: c2 && { model: c2.opts.model, effort: c2.opts.effort, mode: c2.opts.mode }, sdk: e.sdkCalls.length }); }

  // ---- W06: startRoleJob — a coder job on Claude with the lane, a reviewer job on Codex ----
  { const e = environment(); e.setProvider("anthropic"); e.setWorkflow({ ...D(), enabled: true });
    const parent = e.make({ name: "planner" });
    const job = await e.M.startRoleJob(parent.id, { role: "coder", task: "Add a /health endpoint", files: ["src/server.js", "README.md"], from: "cli" });
    const child = store.getSession(job.sessionId);
    const created = e.sends.find((x) => x.name === "session:created");
    const card = parent.messages.find((m) => m.role === "job");
    check("W06", "startRoleJob creates the CHILD session (parentId / role / provider / jobId, the coder's model · access · effort, the '⚙ Coder · task' name, the parent's cwd) and resolves once its run started (status running)", job && job.kind === "role" && job.role === "coder" && job.status === "running" && job.from === "cli" && job.parentId === parent.id && job.task === "Add a /health endpoint" && child && child.parentId === parent.id && child.role === "coder" && child.provider === "anthropic" && child.jobId === job.id && child.model === "claude-opus-4-8" && child.permissionMode === "bypassPermissions" && child.thinking === "high" && /^⚙ Coder · Add a \/health endpoint/.test(child.name) && child.cwd === parent.cwd && job.model === "claude-opus-4-8" && job.effort === "high" && job.access === "bypassPermissions" && job.agents === 3 && job.provider === "anthropic", { job, child: child && { parentId: child.parentId, role: child.role, provider: child.provider, jobId: child.jobId, model: child.model, mode: child.permissionMode, thinking: child.thinking, name: child.name } });
    check("W06b", "session:created carries the child's view (with parentId / role / jobId) + parentId + role; the PLANNER gets one role:'job' card with the task and the run's meta", created && created.data.view && created.data.view.id === child.id && created.data.view.parentId === parent.id && created.data.view.role === "coder" && created.data.view.jobId === job.id && created.data.parentId === parent.id && created.data.role === "coder" && card && card.jobId === job.id && card.jobRole === "coder" && card.text === "Add a /health endpoint" && card.meta.provider === "anthropic" && card.meta.model === "claude-opus-4-8" && card.meta.effort === "high" && card.meta.access === "bypassPermissions" && card.meta.agents === 3 && card.meta.sessionId === child.id && parent.messages.filter((m) => m.role === "job").length === 1, { created: created && Object.keys(created.data), card });
    const done = await e.M.waitJob(job.id, 10000);
    const call = e.sdkCalls[0];
    const jobEvents = e.sends.filter((x) => x.name === "workflow:job" && x.data.job.id === job.id).map((x) => x.data.job.status);
    const stages = e.sends.filter((x) => x.name === "workflow:stage" && x.data.jobId === job.id).map((x) => x.data);
    check("W06c", "the child runs with the coder's model / access / effort, the sub-agent lane (Task tool allowed, worker defined, CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = 3), the ROLE brief as the system-prompt append, the task + labelled files as the prompt, ATOMNANO_SESSION = the child", call && call.options.model === "claude-opus-4-8" && call.options.permissionMode === "bypassPermissions" && call.options.effort === "high" && call.options.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS === "3" && call.options.agents && call.options.agents.worker && !(call.options.disallowedTools || []).includes("Task") && call.options.systemPrompt.append === e.M.roleBrief("coder", e.M.workflowFor(parent)) && /Coder/.test(call.options.systemPrompt.append) && call.prompts[0].startsWith("Add a /health endpoint\n\nFiles of interest") && /Files of interest[^\n]*:\n- src\/server\.js\n- README\.md$/.test(call.prompts[0]) && call.options.env.ATOMNANO_SESSION === child.id && call.options.cwd === parent.cwd, { model: call && call.options.model, env: call && call.options.env, prompt: call && call.prompts[0], sys: call && call.options.systemPrompt });
    check("W06d", "the job finishes 'done' with the child's final text as the result, tokens from the child's totals, an empty agentsLive, timing; the card is patched (meta.status / result / durationMs / editedFiles); the events ran queued → running → done; stage coder running → done", done.status === "done" && done.result === "Synthetic reply." && done.tokensIn === 10 && done.tokensOut === 5 && done.agentsLive.running === 0 && done.agentsLive.total === 0 && !!done.endedTs && done.durationMs >= 0 && done.error === "" && Array.isArray(done.editedFiles) && card.meta.status === "done" && card.meta.result === "Synthetic reply." && typeof card.meta.durationMs === "number" && Array.isArray(card.meta.editedFiles) && jobEvents[0] === "queued" && jobEvents.includes("running") && jobEvents[jobEvents.length - 1] === "done" && stages.map((x) => x.stage + ":" + x.status).join(",") === "coder:running,coder:done" && stages.every((x) => x.sessionId === parent.id && x.provider === "anthropic" && x.model === "claude-opus-4-8") && child.status === "done", { done, cardMeta: card.meta, jobEvents, stages });
    const upd = e.sends.filter((x) => x.name === "session:message-update" && x.data.sessionId === parent.id && x.data.messageId === card.id);
    const META_KEYS = ["provider", "model", "effort", "access", "agents", "sessionId", "status", "startedTs", "endedTs", "durationMs", "result", "editedFiles", "error", "agentsLive", "kind", "command", "exitCode"];
    check("W06e", "the card's changes reach the renderer as session:message-update patches carrying the WHOLE meta every time (never a partial one), status / result included; the card keeps jobId = job.id", upd.length >= 2 && upd[upd.length - 1].data.patch.meta.status === "done" && upd[upd.length - 1].data.patch.meta.result === "Synthetic reply." && upd[0].data.patch.meta.status === "running" && upd.every((u) => META_KEYS.every((k) => k in u.data.patch.meta)) && META_KEYS.every((k) => k in card.meta) && card.jobId === job.id && created.data.view.messages && created.data.view.totalMessages === 0 && created.data.view.firstIndex === 0 && created.data.view.name === child.name && created.data.view.cwd === parent.cwd && created.data.view.provider === "anthropic", { statuses: upd.map((u) => u.data.patch.meta.status), keys: upd.length ? Object.keys(upd[0].data.patch.meta) : [], view: Object.keys(created.data.view) });
    check("W06f", "jobInfo / jobsFor / allJobs see the job (copies, every contract field present); the parent keeps a bounded history copy (workflowJobs)", e.M.jobInfo(job.id).status === "done" && JOB_KEYS.every((k) => k in e.M.jobInfo(job.id)) && e.M.jobsFor(parent.id).length === 1 && e.M.jobsFor(parent.id)[0].id === job.id && e.M.allJobs().some((j) => j.id === job.id) && parent.workflowJobs.length === 1 && parent.workflowJobs[0].status === "done" && parent.workflowJobs[0].result === "Synthetic reply." && e.M.jobInfo("job-nope") === null, { keys: Object.keys(e.M.jobInfo(job.id)) });
    const rj = await e.M.startRoleJob(parent.id, { role: "review", task: "Review the health endpoint" });
    const rdone = await e.M.waitJob(rj.id, 10000);
    const rchild = store.getSession(rj.sessionId);
    const rcall = e.appCalls[0];
    check("W06g", "a reviewer job runs on ITS provider (Codex) while the settings say anthropic: the default Codex model, read → plan (read-only sandbox), the reviewer brief as the labelled appendix after the task, no sub-agents; the alias 'review' is accepted; the result is Codex's text", rj.role === "reviewer" && rj.provider === "openai" && rj.model === "gpt-5.5" && rj.effort === "medium" && rj.access === "read" && rj.agents === 0 && rchild.provider === "openai" && rchild.permissionMode === "plan" && /^⚙ Reviewer · /.test(rchild.name) && rcall && rcall.opts.model === "gpt-5.5" && rcall.opts.mode === "plan" && rcall.opts.cwd === parent.cwd && rcall.prompt.startsWith("Review the health endpoint\n\nRole brief for this conversation") && /review only/.test(rcall.prompt) && rdone.status === "done" && rdone.result === "Codex reply." && e.sdkCalls.length === 1 && parent.messages.filter((m) => m.role === "job").length === 2, { rj, rcall: rcall && { model: rcall.opts.model, mode: rcall.opts.mode, head: rcall.prompt.slice(0, 120) }, rdone: rdone && rdone.status });
    const lane1 = await e.M.startRoleJob(parent.id, { role: "coder", task: "Solo please", agents: 0 });
    await e.M.waitJob(lane1.id, 10000);
    const lc = e.sdkCalls[1];
    check("W06h", "--agents overrides the lane for one job: 0 → solo (Task / Agent tools removed, no cap in the env, no lane sentence in the brief)", lane1.agents === 0 && lc && (lc.options.disallowedTools || []).includes("Task") && !("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS" in lc.options.env) && !/sub-agent/.test(lc.options.systemPrompt.append), { agents: lane1.agents, dt: lc && lc.options.disallowedTools, env: lc && lc.options.env });
    // --context: the planner's conversation travels with the task, condensed like a synthesized handoff
    parent.messages.push({ id: "pu1", role: "user", text: "We decided to use PostgreSQL for the store.", ts: store.nowISO() }, { id: "pa1", role: "assistant", text: "Noted — PostgreSQL it is, with one pool per connection profile.", ts: store.nowISO() });
    store.flush(parent.id);
    const ctxJob = await e.M.startRoleJob(parent.id, { role: "coder", task: "Wire the store to the decided database", context: true });
    await e.M.waitJob(ctxJob.id, 10000);
    const cc = e.sdkCalls[2];
    const plain = e.sdkCalls[1];
    check("W06i", "startRoleJob({ context: true }) appends the orchestrator's conversation as a labelled, condensed block after the task (exact for a small record: the decision text travels); without --context nothing of the conversation is sent", ctxJob.context === true && cc && cc.prompts[0].startsWith("Wire the store to the decided database\n\nContext from the orchestrator session") && /Conversation record/.test(cc.prompts[0]) && /PostgreSQL for the store/.test(cc.prompts[0]) && /Session map/.test(cc.prompts[0]) && plain && !/Context from the orchestrator session/.test(plain.prompts[0]) && lane1.context === false, { head: cc && cc.prompts[0].slice(0, 160), len: cc && cc.prompts[0].length }); }

  // ---- W07: waitJob — current state at the timeout, terminal state at the end ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    let gate = null;
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "n7" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "working…" }] } };
      await new Promise((r) => { gate = r; });
      yield { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Finished the tests." }] } };
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
      await call.consumed;
    };
    const job = await e.M.startRoleJob(parent.id, { role: "tester", task: "Run the suite" });
    const t0 = Date.now(); const cur = await e.M.waitJob(job.id, 80); const waited = Date.now() - t0;
    check("W07", "waitJob returns the CURRENT state (still running) when its timeout passes", cur.status === "running" && cur.result === "" && waited >= 70 && waited < 2000, { status: cur.status, waited });
    while (!gate) await sleep(5);
    gate();
    const fin = await e.M.waitJob(job.id, 10000);
    check("W07b", "…and the terminal state once the job ends — the LAST assistant text is the result; a zero wait on a finished job answers at once", fin.status === "done" && fin.result === "Finished the tests." && (await e.M.waitJob(job.id, 0)).status === "done" && fin.role === "tester" && /Tester/.test(e.sdkCalls[0].options.systemPrompt.append), { fin: fin.status, result: fin.result });
    const err = await fails(() => e.M.waitJob("job-nope", 10));
    check("W07c", "an unknown job id is a plain error", err && /No job "job-nope"/.test(err.message), err && err.message); }

  // ---- W08: stopJob on a long-running turn ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "n8" };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "Partial work" }] } };
      yield { type: "assistant", message: { id: "a2", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sleep 999" } }] } };
      await new Promise((res) => { call.onInterrupt = res; });
      await sleep(10);
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "[Request interrupted by user for tool use]", is_error: true }] } };
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    const job = await e.M.startRoleJob(parent.id, { role: "coder", task: "Long job" });
    await sleep(40);
    const r = await e.M.stopJob(job.id);
    const j = e.M.jobInfo(job.id);
    const child = store.getSession(job.sessionId);
    await sleep(60);
    check("W08", "stopJob interrupts the child's turn (graceful-first: query.interrupt) and the job ends 'stopped' at once with the text so far as its result; the child tab is idle; the card and the stage event say stopped", r.ok === true && j.status === "stopped" && j.result === "Partial work" && j.error === "" && e.sdkCalls[0].interrupts === 1 && child.status === "idle" && parent.messages.find((m) => m.role === "job").meta.status === "stopped" && e.sends.some((x) => x.name === "workflow:stage" && x.data.jobId === job.id && x.data.status === "stopped") && e.M.jobInfo(job.id).status === "stopped", { r, j: { status: j.status, result: j.result }, interrupts: e.sdkCalls[0].interrupts, child: child.status });
    const again = await e.M.stopJob(job.id);
    check("W08b", "stopping a finished job is a harmless no-op with a detail; an unknown id is refused plainly", again.ok === true && /already stopped/.test(again.detail) && (await e.M.stopJob("job-x")).ok === false && /No job/.test((await e.M.stopJob("job-x")).detail), again); }

  // ---- W09: jobLog ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    const job = await e.M.startRoleJob(parent.id, { role: "coder", task: "Log me" }); await e.M.waitJob(job.id, 10000);
    const log = e.M.jobLog(job.id);
    const one = e.M.jobLog(job.id, { tail: 1 });
    check("W09", "jobLog returns the child's recent record entries as text (history.entryText: the prompt, the reply) and honours tail", /User:\nLog me/.test(log) && /Assistant:\nSynthetic reply\./.test(log) && log.indexOf("User:") < log.indexOf("Assistant:") && one === "Assistant:\nSynthetic reply." && !/Log me/.test(one), { log, one });
    const err = await fails(async () => e.M.jobLog("job-nope"));
    check("W09b", "an unknown job id is a plain error", err && /No job/.test(err.message)); }

  // ---- W10: command jobs ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    const job = await e.M.runCommandJob(parent.id, { command: "node -e \"console.log('OK-42')\"" });
    check("W10", "runCommandJob resolves once the process runs: kind command, role tester, no child session, a job card on the planner", job.kind === "command" && job.status === "running" && job.role === "tester" && job.sessionId === null && job.command.includes("OK-42") && job.task === job.command && parent.messages.some((m) => m.role === "job" && m.kind === "command" && m.jobId === job.id && m.text === job.command) && JOB_KEYS.every((k) => k in job), job);
    const done = await e.M.waitJob(job.id, 20000);
    check("W10b", "exit 0 → done with the captured stdout, exit code 0, no error; the log shows it; stage tester running → done", done.status === "done" && done.exitCode === 0 && /OK-42/.test(done.result) && done.error === "" && e.M.jobLog(job.id).includes("OK-42") && e.sends.filter((x) => x.name === "workflow:stage" && x.data.jobId === job.id).map((x) => x.data.stage + ":" + x.data.status).join(",") === "tester:running,tester:done" && parent.messages.find((m) => m.jobId === job.id).meta.exitCode === 0 && parent.messages.find((m) => m.jobId === job.id).meta.status === "done", { done });
    const bad = await e.M.runCommandJob(parent.id, { command: "node -e \"console.error('BOOM-7'); process.exit(3)\"" });
    const bdone = await e.M.waitJob(bad.id, 20000);
    check("W10c", "a failing command → error with its exit code; stderr is in the captured output", bdone.status === "error" && bdone.exitCode === 3 && /BOOM-7/.test(bdone.result) && /Exit code 3/.test(bdone.error), { bdone });
    const slow = await e.M.runCommandJob(parent.id, { command: "node -e \"setTimeout(function(){}, 8000)\"", timeoutMs: 400 });
    const sdone = await e.M.waitJob(slow.id, 20000);
    check("W10d", "a command past its timeout is ended (process tree) and reported as an error", sdone.status === "error" && /Timed out after 0 s|Timed out/.test(sdone.error) && sdone.durationMs < 8000, { sdone: { status: sdone.status, error: sdone.error, ms: sdone.durationMs } });
    const hang = await e.M.runCommandJob(parent.id, { command: "node -e \"setTimeout(function(){}, 8000)\"" });
    await sleep(30);
    const sr = await e.M.stopJob(hang.id);
    check("W10e", "stopJob ends a running command job → stopped", sr.ok === true && e.M.jobInfo(hang.id).status === "stopped" && e.M.jobInfo(hang.id).error === "", { sr, status: e.M.jobInfo(hang.id).status });
    const err = await fails(() => e.M.runCommandJob(parent.id, { command: "  " }));
    check("W10f", "no command and no configured tester command → a plain error", err && /No command given/.test(err.message), err && err.message);
    const d = D(); e.setWorkflow({ ...d, enabled: true, roles: { ...d.roles, tester: { ...d.roles.tester, command: "node -e \"console.log('FROM-CONFIG')\"" } } });
    const cfg = await e.M.runCommandJob(parent.id, {}); const cdone = await e.M.waitJob(cfg.id, 20000);
    check("W10g", "without a command the Tester role's configured command runs", cdone.status === "done" && /FROM-CONFIG/.test(cdone.result) && cfg.command.includes("FROM-CONFIG"), { cdone });
    e.setWorkflow({ ...d, enabled: true });
    const cwdJob = await e.M.runCommandJob(parent.id, { command: "node -e \"console.log(process.cwd())\"" });
    const cd = await e.M.waitJob(cwdJob.id, 20000);
    check("W10h", "the command runs in the project folder", cd.status === "done" && path.resolve(cd.result.trim()).toLowerCase() === path.resolve(HOME).toLowerCase(), { out: cd.result.trim(), home: HOME });
    const big = await e.M.runCommandJob(parent.id, { command: "node -e \"process.stdout.write('A'.repeat(150000)); process.stdout.write('MIDDLE-MARK'); process.stdout.write('Z'.repeat(150000)); console.log('TAIL-MARK')\"" });
    const bg = await e.M.waitJob(big.id, 20000);
    check("W10i", "output is bounded to about 200 KB: the head and the TAIL are kept, the middle is replaced by one '[… truncated …]' note", bg.status === "done" && bg.result.length <= 200 * 1024 + 200 && /\[… truncated …\]/.test(bg.result) && bg.result.startsWith("AAAA") && /TAIL-MARK/.test(bg.result) && !/MIDDLE-MARK/.test(bg.result), { len: bg.result.length, head: bg.result.slice(0, 8), tail: bg.result.slice(-30) });
    const nope = await fails(() => e.M.runCommandJob("no-such-session", { command: "node -v" }));
    check("W10j", "a missing orchestrator session is a plain error", nope && /orchestrator session was not found/.test(nope.message)); }

  // ---- W11: refusals ----
  { const e = environment(); const d = D(); e.setWorkflow({ ...d, enabled: true, roles: { ...d.roles, reviewer: { ...d.roles.reviewer, enabled: false } } }); const parent = e.make();
    const before = store.listSessions().length;
    const e1 = await fails(() => e.M.startRoleJob(parent.id, { role: "reviewer", task: "x" }));
    const e2 = await fails(() => e.M.startRoleJob(parent.id, { role: "wizard", task: "x" }));
    const e3 = await fails(() => e.M.startRoleJob("nope", { role: "coder", task: "x" }));
    const e4 = await fails(() => e.M.startRoleJob(parent.id, { role: "coder", task: "   " }));
    const e5 = await fails(() => e.M.startRoleJob(parent.id, { role: "orchestrator", task: "x" }));
    check("W11", "a disabled role, an unknown role, the orchestrator itself, a missing parent and an empty task are refused with plain sentences — no session created, no card, no events", e1 && /Reviewer role is disabled/.test(e1.message) && e2 && /Unknown role "wizard"\. Roles you can run: planner, coder, reviewer, tester\./.test(e2.message) && e3 && /orchestrator session was not found/.test(e3.message) && e4 && /task description is required/.test(e4.message) && e5 && /orchestrator is the calling session — delegate to planner, coder, reviewer or tester/.test(e5.message) && !parent.messages.some((m) => m.role === "job") && store.listSessions().length === before && e.sends.length === 0, { e1: e1 && e1.message, e2: e2 && e2.message, e3: e3 && e3.message, e4: e4 && e4.message, e5: e5 && e5.message }); }

  // ---- W12: a child never re-enters planner mode ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    const job = await e.M.startRoleJob(parent.id, { role: "coder", task: "Child task" }); await e.M.waitJob(job.id, 10000);
    const first = e.sdkCalls[0];
    await e.M.run(job.sessionId, { text: "follow-up in the coder tab" });
    const second = e.sdkCalls[1];
    const child = store.getSession(job.sessionId);
    check("W12", "a child session never becomes the planner: its job run carries the ROLE brief (not the planner's), a later manual turn in that tab carries no brief at all and resumes the child's native thread, no planner stage is ever emitted for it, the job stays done", first.options.systemPrompt.append && !first.options.systemPrompt.append.includes("Your session id is") && second && !("append" in second.options.systemPrompt) && second.options.resume === "native-1" && second.prompts[0] === "follow-up in the coder tab" && !e.sends.some((x) => x.name === "workflow:stage" && x.data.sessionId === job.sessionId) && e.M.jobInfo(job.id).status === "done" && child.status === "done" && child.role === "coder", { first: first.options.systemPrompt, second: second && second.options.systemPrompt, resume: second && second.options.resume }); }

  // ---- W13: Stop on the planner stops its jobs; a "replace" keeps them ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    e.control.script = async function* ({ call }) {
      yield { type: "system", subtype: "init", session_id: "n13-" + sdkCallsOf(e).length };
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "working" }] } };
      await new Promise((res) => { call.onInterrupt = res; });
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], num_turns: 1, total_cost_usd: 0 };
      await call.consumed;
    };
    const plannerRun = e.M.run(parent.id, { text: "orchestrate" });
    await sleep(30);
    const j1 = await e.M.startRoleJob(parent.id, { role: "coder", task: "A" });
    const j2 = await e.M.startRoleJob(parent.id, { role: "tester", task: "B" });
    const cmd = await e.M.runCommandJob(parent.id, { command: "node -e \"setTimeout(function(){}, 8000)\"" });
    await sleep(60);
    const live = [j1, j2, cmd].map((j) => e.M.jobInfo(j.id).status);
    await e.M.interrupt(parent.id, "stop");
    const right = [j1, j2, cmd].map((j) => e.M.jobInfo(j.id).status);
    await plannerRun; await sleep(60);
    check("W13", "Stop on the orchestrator stops the ORCHESTRATOR'S TURN only (user decision 2026-09-17): its two role jobs and the command job keep running with their state, a note says so, the orchestrator stage is 'stopped', the orchestrator tab idle, no child interrupted", live.join() === "running,running,running" && right.join() === "running,running,running" && e.sdkCalls.slice(1).every((c) => c.interrupts === 0) && parent.messages.some((m) => m.role === "system" && /3 delegated jobs keep running with their sub-agents/.test(m.text)) && e.sends.some((x) => x.name === "workflow:stage" && x.data.sessionId === parent.id && x.data.stage === "orchestrator" && x.data.status === "stopped") && parent.status === "idle" && e.M.liveJobCount(parent.id) === 3, { live, right, status: parent.status, interrupts: e.sdkCalls.map((c) => c.interrupts) });
    const stoppedN = e.M.stopJobsOf(parent.id); await sleep(80);
    check("W13d", "stopJobsOf — the studio's 'Stop all jobs' / atomnano stop --all — ends every live job at once, each child interrupted gracefully, the children idle", stoppedN === 3 && [j1, j2, cmd].every((j) => e.M.jobInfo(j.id).status === "stopped") && e.sdkCalls.slice(1).every((c) => c.interrupts === 1) && [j1, j2].every((j) => store.getSession(j.sessionId).status === "idle") && e.M.liveJobCount(parent.id) === 0, { stoppedN, statuses: [j1, j2, cmd].map((j) => e.M.jobInfo(j.id).status), interrupts: e.sdkCalls.map((c) => c.interrupts) });
    const parent2 = e.make(); const run2 = e.M.run(parent2.id, { text: "again" }); await sleep(30);
    const j3 = await e.M.startRoleJob(parent2.id, { role: "coder", task: "C" });
    await sleep(30);
    await e.M.interrupt(parent2.id, "replace"); await run2; await sleep(30);
    check("W13b", "a 'replace' interrupt (a new message while the planner works) leaves the jobs running for the next planner turn to pick up", e.M.jobInfo(j3.id).status === "running" && parent2.status === "idle", { status: e.M.jobInfo(j3.id).status });
    const sj = await e.M.stopJob(j3.id); await sleep(30);
    check("W13c", "…and stopJob ends it", sj.ok && e.M.jobInfo(j3.id).status === "stopped"); }

  // ---- W14: persistence ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    const job = await e.M.startRoleJob(parent.id, { role: "tester", task: "Persist me" }); await e.M.waitJob(job.id, 10000);
    store.flush(parent.id); store.flush(job.sessionId); store.loadAllSessions();
    const re = store.getSession(job.sessionId), meta = store.getMeta(job.sessionId), view = store.getSessionView(job.sessionId), reParent = store.getSession(parent.id);
    check("W14", "parentId / role / provider / jobId survive a reload (normalizeSession) and are on metaOf and the renderer view", re.parentId === parent.id && re.role === "tester" && re.provider === "anthropic" && re.jobId === job.id && meta.parentId === parent.id && meta.role === "tester" && meta.provider === "anthropic" && meta.jobId === job.id && view.parentId === parent.id && view.role === "tester" && view.jobId === job.id && view.provider === "anthropic", { re: { parentId: re.parentId, role: re.role, provider: re.provider, jobId: re.jobId }, meta, view: { parentId: view.parentId, role: view.role, jobId: view.jobId, provider: view.provider } });
    e.M._jobs.clear();
    const hist = e.M.jobsFor(parent.id);
    check("W14b", "the planner's job history (workflowJobs) survives the reload, is on its view, and jobsFor serves it once the live registry is gone", reParent.workflowJobs.length === 1 && reParent.workflowJobs[0].id === job.id && reParent.workflowJobs[0].status === "done" && hist.length === 1 && hist[0].result === "Synthetic reply." && hist[0].status === "done" && Array.isArray(store.getSessionView(parent.id).workflowJobs) && store.getSessionView(parent.id).workflowJobs.length === 1, { hist });
    const rawId = store.writeSessionRaw({ id: "raw-child-1", name: "raw", cwd: HOME, messages: [], parentId: "p-1", role: "coder", provider: "openai", jobId: "job-raw", workflowJobs: [{ id: "job-z", status: "running", startedTs: "2026-01-01T00:00:00.000Z" }, { id: 7 }, null] });
    store.loadAllSessions();
    const raw = store.getSession(rawId);
    check("W14c", "writeSessionRaw keeps the fields; a history entry that was live when the app closed is served as stopped (with a reason); malformed entries are dropped", raw.parentId === "p-1" && raw.role === "coder" && raw.provider === "openai" && raw.jobId === "job-raw" && raw.workflowJobs.length === 1 && e.M.jobsFor(rawId).length === 1 && e.M.jobsFor(rawId)[0].status === "stopped" && /restarted/.test(e.M.jobsFor(rawId)[0].error), { raw: { parentId: raw.parentId, role: raw.role, provider: raw.provider, jobId: raw.jobId, jobs: raw.workflowJobs }, served: e.M.jobsFor(rawId) });
    const plain = store.getSession(store.createSession({ cwd: HOME, name: "plain" }).id);
    check("W14d", "an ordinary session has null parentId / role / provider / jobId and no job history; a garbage role/provider is dropped", plain.parentId === null && plain.role === null && plain.provider === null && plain.jobId === null && plain.workflowJobs.length === 0 && store.getMeta(plain.id).role === null && store.getSession(store.createSession({ cwd: HOME, name: "g", role: 5, provider: "" }).id).role === null); }

  // ---- W15: run() honours an explicit provider and a session's own provider pin ----
  { const e = environment(); e.setProvider("anthropic"); e.setWorkflow({ ...D(), enabled: false });
    const s = e.make({ model: "gpt-5.5" });
    await e.M.run(s.id, { text: "EXPLICIT", provider: "openai" });
    const pinned = store.getSession(store.createSession({ cwd: HOME, name: "pinned", model: "gpt-5.5", provider: "openai" }).id);
    await e.M.run(pinned.id, { text: "PINNED" });
    const st = e.sends.filter((x) => x.name === "session:status" && x.data.status === "running").map((x) => x.data.provider);
    check("W15", "run() honours an explicit provider override and a session's own provider pin (anthropic settings → Codex runs both turns); the dispatched snapshot names the provider", e.appCalls.length === 2 && e.sdkCalls.length === 0 && e.appCalls[0].prompt === "EXPLICIT" && e.appCalls[1].prompt === "PINNED" && st.join() === "openai,openai" && s.lastProvider === "openai" && !e.appCalls[0].prompt.includes("Role brief"), { app: e.appCalls.length, sdk: e.sdkCalls.length, st }); }

  // ---- W16: workflow OFF = solo — no role jobs, no command jobs (they used to start regardless) ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: false }); const parent = e.make(); const before = store.listSessions().length;
    const e1 = await fails(() => e.M.startRoleJob(parent.id, { role: "reviewer", task: "review it" }));
    const e2 = await fails(() => e.M.runCommandJob(parent.id, { command: "node -v" }));
    check("W16", "with the workflow off a role job and a command job are refused with a plain sentence naming the studio; no session, no card, no event", e1 && /workflow is off/.test(e1.message) && /Workflow studio/.test(e1.message) && e2 && /workflow is off/.test(e2.message) && store.listSessions().length === before && !parent.messages.some((m) => m.role === "job") && !e.sends.some((x) => x.name === "workflow:job"), { e1: e1 && e1.message, e2: e2 && e2.message }); }

  // ---- W17: every role has its own sub-agent lane; the role is told to use it ----
  { const e = environment(); const d = D();
    e.setWorkflow({ ...d, enabled: true, roles: { ...d.roles, coder: { ...d.roles.coder, agents: 12 }, reviewer: { ...d.roles.reviewer, agents: 5 }, tester: { ...d.roles.tester, agents: 4 } } });
    const parent = e.make();
    const wf = e.M.workflowFor(parent);
    const brief = e.M.plannerBrief(parent, wf, "anthropic");
    check("W17", "the orchestrator brief lists EVERY role's lane — the OpenAI reviewer's too (the lane counts on any provider since 2026-09-17) — and tells the orchestrator that the roles work in parallel and that it monitors, verifies and reports", /Coder: Anthropic · default model · high · full access · up to 12 sub-agents/.test(brief) && /Tester: Anthropic · default model · medium · full access · up to 4 sub-agents/.test(brief) && /Reviewer: OpenAI · default model · medium · read-only · up to 5 sub-agents$/m.test(brief) && /Planner: Anthropic · default model · high · read-only$/m.test(brief) && /Roles with sub-agents work in parallel/.test(brief) && /Monitor the jobs, verify what comes back and report to the user/.test(brief), { brief });
    const tb = e.M.roleBrief("tester", wf), cb = e.M.roleBrief("coder", wf), rb = e.M.roleBrief("reviewer", { ...wf, roles: { ...wf.roles, reviewer: { ...wf.roles.reviewer, provider: "anthropic" } } });
    check("W17b", "the role briefs tell each role to USE its lane — all N when the work divides, fewer when not, in parallel; the reviewer's are read-only; an OpenAI reviewer gets the same lane sentence as a Claude one", /up to 4 sub-agents — use them to speed the work up/.test(tb) && /all 4 when the work divides that far, fewer when it does not/.test(tb) && /in parallel/.test(tb) && /up to 12 sub-agents/.test(cb) && /up to 5 sub-agents \(read-only, like you\)/.test(rb) && e.M.roleBrief("reviewer", wf) === rb, { tb, rb });
    const tj = await e.M.startRoleJob(parent.id, { role: "tester", task: "Run everything" }); await e.M.waitJob(tj.id, 10000);
    const tc = e.sdkCalls[e.sdkCalls.length - 1];
    check("W17c", "a tester job runs with ITS lane: Task allowed, worker defined, CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = 4, the lane sentence in its brief (the solo agents brief is not repeated); the job records agents 4", tj.agents === 4 && tc.options.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS === "4" && tc.options.agents && tc.options.agents.worker && !(tc.options.disallowedTools || []).includes("Task") && /up to 4 sub-agents/.test(tc.options.systemPrompt.append) && !/Sub-agents: you may launch/.test(tc.options.systemPrompt.append), { agents: tj.agents, env: tc.options.env, sys: tc.options.systemPrompt.append });
    const rj = await e.M.startRoleJob(parent.id, { role: "reviewer", task: "Review it" }); await e.M.waitJob(rj.id, 10000);
    const rcfg = e.appCalls[0] && e.appCalls[0].opts.config;
    check("W17d", "an OpenAI reviewer with a lane of 5 runs WITH sub-agents (2026-09-17): Codex's multi-agent feature is turned on for the thread with the lane as its cap (features.multi_agent · agents.max_concurrent_threads_per_session = 5), the lane sentence is in its brief, the run records the cap", rj.agents === 5 && rj.provider === "openai" && e.appCalls.length === 1 && /up to 5 sub-agents \(read-only, like you\)/.test(e.appCalls[0].prompt) && rcfg && rcfg["features.multi_agent"] === true && rcfg["agents.max_concurrent_threads_per_session"] === 5 && rcfg.model_context_window > 0 && e.M.lastRunInfo().sent.subAgents === 5, { agents: rj.agents, cfg: rcfg, tail: e.appCalls[0] && e.appCalls[0].prompt.slice(-160) });
    const oj = await e.M.startRoleJob(parent.id, { role: "tester", task: "Solo run", agents: 0 }); await e.M.waitJob(oj.id, 10000);
    const oc = e.sdkCalls[e.sdkCalls.length - 1];
    check("W17e", "--agents 0 on a tester job → solo: Task removed, no cap, no lane sentence", oj.agents === 0 && (oc.options.disallowedTools || []).includes("Task") && !("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS" in oc.options.env) && !/sub-agent/.test(oc.options.systemPrompt.append), { dt: oc.options.disallowedTools, env: oc.options.env });
    const rz = await e.M.startRoleJob(parent.id, { role: "reviewer", task: "Review alone", agents: 0 }); await e.M.waitJob(rz.id, 10000);
    const rzc = e.appCalls[e.appCalls.length - 1];
    check("W17f", "--agents 0 on a Codex job → solo: Codex's multi-agent feature is turned OFF for the thread, no cap, no lane sentence", rz.agents === 0 && e.appCalls.length === 2 && rzc.opts.config["features.multi_agent"] === false && !("agents.max_concurrent_threads_per_session" in rzc.opts.config) && !/sub-agent/.test(rzc.prompt), { cfg: rzc && rzc.opts.config }); }

  // ---- W18: a job's agentsLive follows its child's registry WHILE it runs (the studio shows every role's agents without the child tab open) ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    let gate; e.control.script = async function* ({ call }) { yield { type: "system", subtype: "init", session_id: "n18" }; yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "working" }] } }; await new Promise((r) => { gate = r; }); yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 }; await call.consumed; };
    const job = await e.M.startRoleJob(parent.id, { role: "coder", task: "Fan out" }); await sleep(30);
    const child = store.getSession(job.sessionId); const runner = e.M.runners.get(child.id);
    const a1 = e.M.agentAnnounce(child, runner, { toolUseId: "w18-a", input: { description: "Half A" }, status: "running" }).agent;
    e.M.agentAnnounce(child, runner, { toolUseId: "w18-b", input: { description: "Half B" }, status: "running" });
    e.M.agentPatch(child, a1, { progress: "Editing half A" });
    await sleep(400);
    const live = e.M.jobInfo(job.id); const ev = e.sends.filter((x) => x.name === "workflow:job" && x.data.job.id === job.id).pop();
    const card = parent.messages.find((m) => m.role === "job" && m.jobId === job.id);
    check("W18", "while the coder job runs, agentsLive carries running 2 / total 2 and the LIST (number, description, progress); the coalesced workflow:job event and the card's meta carry it too", live.agentsLive.running === 2 && live.agentsLive.total === 2 && live.agentsLive.list.length === 2 && live.agentsLive.list[0].description === "Half A" && live.agentsLive.list[0].progress === "Editing half A" && ev && ev.data.job.agentsLive.list.length === 2 && card.meta.agentsLive.list.length === 2, { al: live.agentsLive });
    e.M.agentPatch(child, a1, { status: "done", result: "A done" }); await sleep(400);
    check("W18b", "an agent that finishes leaves the live list (running 1, total 2)", e.M.jobInfo(job.id).agentsLive.running === 1 && e.M.jobInfo(job.id).agentsLive.list.length === 1 && e.M.jobInfo(job.id).agentsLive.list[0].description === "Half B", e.M.jobInfo(job.id).agentsLive);
    gate(); await e.M.waitJob(job.id, 10000); e.control.script = null; }

  // ---- W19: a role pinned to a model runs on exactly that model and provider (gpt-6-astra on Codex, claude-fable-5-1 on Claude with its 1M context) ----
  { const e = environment(); const d = D(); e.setProvider("anthropic");
    e.setWorkflow({ ...d, enabled: true, roles: { ...d.roles, coder: { ...d.roles.coder, model: "claude-fable-5-1", agents: 6 }, reviewer: { ...d.roles.reviewer, provider: "openai", model: "gpt-6-astra", effort: "xhigh" } } });
    const parent = e.make();
    const cj = await e.M.startRoleJob(parent.id, { role: "coder", task: "Build it" }); await e.M.waitJob(cj.id, 10000);
    const cc = e.sdkCalls[e.sdkCalls.length - 1]; const cchild = store.getSession(cj.sessionId);
    const rj = await e.M.startRoleJob(parent.id, { role: "reviewer", task: "Review it" }); await e.M.waitJob(rj.id, 10000);
    const rc = e.appCalls[e.appCalls.length - 1];
    check("W19", "coder → claude-fable-5-1 with the 1M beta and cap 6; reviewer → gpt-6-astra on Codex at effort xhigh in the read-only sandbox", cj.model === "claude-fable-5-1" && cc.options.model === "claude-fable-5-1" && (cc.options.betas || []).includes("context-1m-2025-08-07") && cchild.oneM === true && cc.options.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS === "6" && rj.model === "gpt-6-astra" && rj.provider === "openai" && rc && rc.opts.model === "gpt-6-astra" && rc.opts.effort === "xhigh" && rc.opts.mode === "plan", { coder: { model: cc.options.model, betas: cc.options.betas, oneM: cchild.oneM }, reviewer: rc && { model: rc.opts.model, effort: rc.opts.effort, mode: rc.opts.mode } }); }

  // ---- W20: the workflow's Reviewer replaces the council — a planner turn consults no council reviewers ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: true }); const s = e.make(); let consulted = 0;
    e.M.consultReviewers = async () => { consulted++; return "ADVICE"; };
    await e.M.run(s.id, { text: "PLAN", reviewers: [{ provider: "openai", model: "" }], reviewMode: "before" });
    const off = e.make(); e.setWorkflow({ ...D(), enabled: false });
    await e.M.run(off.id, { text: "SOLO", reviewers: [{ provider: "openai", model: "" }], reviewMode: "before" });
    check("W20", "with the workflow ON the council is not consulted on the planner's turn (reviewing is the planner's Reviewer role); with it OFF the user's configured council still runs", consulted === 1 && s.status === "done" && off.status === "done", { consulted }); }

  // ---- W21: sub-agents ON in an ordinary (solo) turn → Claude is told to use the lane; OFF → the bare preset ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: false }); const s = e.make();
    await e.M.run(s.id, { text: "SOLO WITH AGENTS", subAgents: true, subAgentsMax: 7 });
    const c = e.sdkCalls[0];
    check("W21", "the sub-agents brief is the system-prompt append: up to 7, as many as the task allows, in parallel; the CLI cap is 7; the run info records it; the worker definition invites parallel launches", c.options.systemPrompt.append && /Sub-agents: you may launch up to 7 worker sub-agents/.test(c.options.systemPrompt.append) && /all 7 when it divides that far, fewer when it does not/.test(c.options.systemPrompt.append) && /in parallel/.test(c.options.systemPrompt.append) && c.options.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS === "7" && e.M.lastRunInfo().sent.agentsBrief === true && /several in parallel/.test(c.options.agents.worker.description), { sys: c.options.systemPrompt, env: c.options.env });
    const s2 = e.make(); await e.M.run(s2.id, { text: "SOLO PLAIN" });
    check("W21b", "without sub-agents the ordinary turn stays untouched — no append at all", !("append" in e.sdkCalls[1].options.systemPrompt) && e.M.lastRunInfo().sent.agentsBrief === false, e.sdkCalls[1].options.systemPrompt); }

  // ---- W24: sub-agents ON in a solo Codex turn → Codex multi-agent + the same explicit brief as labelled data; OFF → no override ----
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5", thinking: "medium" });
    await e.M.run(s.id, { text: "SOLO CODEX WITH AGENTS", subAgents: true, subAgentsMax: 6 });
    const c = e.appCalls[0];
    check("W24", "the Agents switch on a Codex turn: multi-agent on with the cap 6, the sub-agents brief after the user's text as labelled data (all 6 when it divides, in parallel), the run info records both", c && c.prompt.startsWith("SOLO CODEX WITH AGENTS\n\n") && /Sub-agents \(the Agents switch the user turned on\):\nSub-agents: you may launch up to 6 worker sub-agents/.test(c.prompt) && /all 6 when it divides that far, fewer when it does not/.test(c.prompt) && c.opts.config["features.multi_agent"] === true && c.opts.config["agents.max_concurrent_threads_per_session"] === 6 && e.M.lastRunInfo().sent.subAgents === 6 && e.M.lastRunInfo().sent.agentsBrief === true, { head: c && c.prompt.slice(0, 220), cfg: c && c.opts.config });
    await e.M.run(s.id, { text: "SOLO CODEX PLAIN" });
    const c2 = e.appCalls[1];
    check("W24b", "without the switch an ordinary Codex turn passes no multi-agent override at all (Codex's own config decides, as before) and no brief — the sub-agents brief the earlier turn delivered to this thread is explicitly cleared once (2026-09-18)", c2 && c2.prompt === "SOLO CODEX PLAIN\n\nBriefs: none apply to this conversation any more — the role brief and any sub-agents brief given earlier in this conversation no longer apply." && !("features.multi_agent" in c2.opts.config) && !("agents.max_concurrent_threads_per_session" in c2.opts.config) && e.M.lastRunInfo().sent.subAgents === 0 && e.M.lastRunInfo().sent.agentsBrief === false, { cfg: c2 && c2.opts.config, prompt: c2 && c2.prompt }); }

  // ---- W25: the Planner is a WORKER role (2026-09-17) — a planner job runs read-only with the planner brief; the orchestrator is not runnable ----
  { const e = environment(); e.setProvider("anthropic"); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    const pj = await e.M.startRoleJob(parent.id, { role: "plan", task: "Plan the /health endpoint" }); await e.M.waitJob(pj.id, 10000);
    const pc = e.sdkCalls[0]; const pchild = store.getSession(pj.sessionId);
    check("W25", "atomnano run plan → a Planner job: its own child session (role planner, the '⚙ Planner · task' name), the planner role's picks (Anthropic · high · read → plan mode, lane 0 → no Task tool), the planner brief as the system-prompt append (plan only, no implementation), the task as the whole prompt, a job card on the orchestrator, planner stage events running → done", pj.role === "planner" && pj.access === "read" && pj.effort === "high" && pj.agents === 0 && pchild.role === "planner" && pchild.parentId === parent.id && pchild.permissionMode === "plan" && /^⚙ Planner · Plan the \/health endpoint/.test(pchild.name) && pc && pc.options.permissionMode === "plan" && (pc.options.disallowedTools || []).includes("Task") && /You are the Planner/.test(pc.options.systemPrompt.append) && /plan only/.test(pc.options.systemPrompt.append) && /Do not implement anything yourself/.test(pc.options.systemPrompt.append) && pc.prompts[0] === "Plan the /health endpoint" && e.M.jobInfo(pj.id).status === "done" && parent.messages.some((m) => m.role === "job" && m.jobRole === "planner") && e.sends.filter((x) => x.name === "workflow:stage" && x.data.stage === "planner").map((x) => x.data.status).join() === "running,done" && (parent.roleSessions.planner || []).includes(pj.sessionId), { pj, name: pchild && pchild.name, sys: pc && pc.options.systemPrompt.append });
    const eo = await fails(() => e.M.startRoleJob(parent.id, { role: "primary", task: "x" }));
    check("W25b", "the orchestrator (or 'primary') is not a runnable role — a plain sentence, nothing created", eo && /orchestrator is the calling session/.test(eo.message) && !store.getSession(parent.id).messages.some((m) => m.role === "job" && m.jobRole === "orchestrator"), eo && eo.message); }

  // ---- W22: ONE session per role — the next task runs in the role's existing session (native thread resumed, context kept); a busy role gets a second session; --fresh forces a new one; roles never share ----
  { const e = environment(); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    const j1 = await e.M.startRoleJob(parent.id, { role: "coder", task: "First task" }); await e.M.waitJob(j1.id, 10000);
    const j2 = await e.M.startRoleJob(parent.id, { role: "coder", task: "Second task" }); await e.M.waitJob(j2.id, 10000);
    const c1 = e.sdkCalls[0], c2 = e.sdkCalls[1]; const child = store.getSession(j2.sessionId);
    check("W22", "the second coder job reuses the first one's session: same sessionId, the native thread resumed (options.resume = the first init's id), only the new task as the prompt, reused flagged, the tab renamed to the new task, the parent lists the session under roleSessions.coder", j2.sessionId === j1.sessionId && j2.reused === true && j1.reused === false && c2.options.resume === "native-1" && c2.prompts[0] === "Second task" && /^⚙ Coder · Second task/.test(child.name) && child.jobId === j2.id && parent.roleSessions.coder.length === 1 && parent.roleSessions.coder[0] === j1.sessionId && c1.prompts[0] === "First task" && e.sends.filter((x) => x.name === "session:created").length === 2 && e.sends.filter((x) => x.name === "session:created")[1].data.reused === true, { s1: j1.sessionId, s2: j2.sessionId, resume: c2.options.resume, name: child.name, pool: parent.roleSessions });
    let gate; e.control.script = async function* ({ call }) { yield { type: "system", subtype: "init", session_id: call.options.resume || "n22" }; yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "busy" }] } }; await new Promise((r) => { gate = r; }); yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 }; await call.consumed; };
    const busy = await e.M.startRoleJob(parent.id, { role: "coder", task: "Long task" }); await sleep(30);
    e.control.script = null;
    const j4 = await e.M.startRoleJob(parent.id, { role: "coder", task: "Parallel task" }); await e.M.waitJob(j4.id, 10000);
    check("W22b", "a coder task while the Coder's session is busy gets a SECOND coder session (both listed); the busy one keeps running", busy.sessionId === j1.sessionId && j4.sessionId !== j1.sessionId && j4.reused === false && parent.roleSessions.coder.length === 2 && e.M.jobInfo(busy.id).status === "running", { pool: parent.roleSessions.coder, j4: j4.sessionId });
    gate(); await e.M.waitJob(busy.id, 10000);
    const rj = await e.M.startRoleJob(parent.id, { role: "reviewer", task: "Review" }); await e.M.waitJob(rj.id, 10000);
    const fr = await e.M.startRoleJob(parent.id, { role: "coder", task: "Fresh start", fresh: true }); await e.M.waitJob(fr.id, 10000);
    check("W22c", "a reviewer never reuses a coder session; fresh: true gives the coder a brand-new session (three coder sessions now)", rj.sessionId !== j1.sessionId && rj.sessionId !== j4.sessionId && parent.roleSessions.reviewer[0] === rj.sessionId && fr.reused === false && !parent.roleSessions.coder.slice(0, 2).includes(fr.sessionId) && parent.roleSessions.coder.length === 3, { pool: parent.roleSessions });
    store.flush(parent.id); store.loadAllSessions();
    const re = store.getSession(parent.id);
    check("W22d", "roleSessions survive a reload (normalizeSession) and are on the view", Array.isArray(re.roleSessions.coder) && re.roleSessions.coder.length === 3 && re.roleSessions.reviewer.length === 1 && store.getSessionView(parent.id).roleSessions.coder.length === 3, re.roleSessions); }

  // ---- W26: PER-SESSION workflows (contract §10, 2026-09-18) — a tab's own workflow wins over the project's; a child follows its orchestrator ----
  { const e = environment(); e.setProvider("anthropic"); const d = D();
    e.setWorkflow({ ...d, enabled: false, name: "Project default" });
    const a = e.make({ name: "tab A" }), b = e.make({ name: "tab B" });
    const own = e.M.setSessionWorkflow(a.id, { ...d, enabled: true, name: "Tab A flow", roles: { ...d.roles, coder: { ...d.roles.coder, agents: 9 } } });
    const wa = e.M.workflowFor(a), wb = e.M.workflowFor(b), wcwd = e.M.workflowFor(HOME);
    check("W26", "setSessionWorkflow gives ONE tab its own workflow (resolved, on the record and the view, announced as session:workflow); workflowFor(that session) returns it while another tab of the same project and the bare project still resolve the project's", own.name === "Tab A flow" && own.roles.coder.agents === 9 && wa.name === "Tab A flow" && wa.enabled === true && wa.roles.coder.agents === 9 && wb.name === "Project default" && wb.enabled === false && wcwd.name === "Project default" && e.M.hasOwnWorkflow(a.id) && !e.M.hasOwnWorkflow(b.id) && store.getSession(a.id).workflow.name === "Tab A flow" && store.getSessionView(a.id).workflow.name === "Tab A flow" && store.getSessionView(b.id).workflow === null && e.sends.some((x) => x.name === "session:workflow" && x.data.sessionId === a.id && x.data.workflow.name === "Tab A flow"), { wa: wa.name, wb: wb.name, view: store.getSessionView(a.id).workflow && store.getSessionView(a.id).workflow.name });
    await e.M.run(a.id, { text: "GO A" }); await e.M.run(b.id, { text: "GO B" });
    const ca = e.sdkCalls[0], cb = e.sdkCalls[1];
    check("W26b", "the runs follow each tab's own choice: tab A's turn is the orchestrator (its brief appended, stage events), tab B's is an ordinary solo turn (no brief, no stage) although both tabs share the project", ca && typeof ca.options.systemPrompt.append === "string" && /"Tab A flow" workflow/.test(ca.options.systemPrompt.append) && cb && !("append" in cb.options.systemPrompt) && e.sends.some((x) => x.name === "workflow:stage" && x.data.sessionId === a.id) && !e.sends.some((x) => x.name === "workflow:stage" && x.data.sessionId === b.id), { a: ca && Object.keys(ca.options.systemPrompt), b: cb && Object.keys(cb.options.systemPrompt) });
    const job = await e.M.startRoleJob(a.id, { role: "coder", task: "Child task" }); await e.M.waitJob(job.id, 10000);
    const child = store.getSession(job.sessionId);
    const refused = await fails(() => e.M.startRoleJob(b.id, { role: "coder", task: "x" }));
    check("W26c", "a role job runs with its ORCHESTRATOR's own workflow (lane 9 from tab A) and the child session resolves to it without a copy of its own; a job from tab B is refused because tab B's workflow (the project's) is off", job.agents === 9 && e.M.workflowFor(child).name === "Tab A flow" && !child.workflow && !e.M.hasOwnWorkflow(child.id) && refused && /workflow is off/.test(refused.message), { agents: job.agents, childWf: e.M.workflowFor(child).name, refused: refused && refused.message });
    store.flush(a.id); store.loadAllSessions();
    const kept = store.getSession(a.id).workflow && store.getSession(a.id).workflow.name === "Tab A flow";
    const cleared = e.M.setSessionWorkflow(a.id, null);
    check("W26d", "the own workflow survives a reload (normalizeSession); setSessionWorkflow(id, null) clears it and the tab follows the project's again", kept && cleared === null && e.M.workflowFor(a).name === "Project default" && !e.M.hasOwnWorkflow(a.id) && store.getSessionView(a.id).workflow === null, { kept, name: e.M.workflowFor(a).name }); }

  // ---- W28: SKILLS attached to a role (2026-09-18) — every job of the Planner / Coder / Reviewer runs with them; the Tester gets none ----
  { const e = environment(); e.setProvider("anthropic"); const d = D();
    const skillsMod = require(path.join(ROOT, "src/main/agents/skills.js"));
    const sk = skillsMod.create(HOME, { name: "Design system rules", description: "Tokens, spacing, no hardcoded colours", steps: "1. Use the --var tokens\n2. Reuse the h() helpers" });
    e.setWorkflow({ ...d, enabled: true, roles: { ...d.roles, coder: { ...d.roles.coder, skills: [sk.id, sk.id, " "] }, planner: { ...d.roles.planner, skills: [sk.id, "missing-skill"] }, tester: { ...d.roles.tester, skills: [sk.id] } } });
    const parent = e.make();
    const wf = e.M.workflowFor(parent); const brief = e.M.orchestratorBrief(parent, wf, "anthropic");
    check("W28", "roles.<planner|coder|reviewer>.skills is kept as clean ids (blanks and duplicates dropped); the tester carries no skills; the orchestrator brief lists each role's skills by name (an unknown id as is) and says attached skills reach the role's jobs automatically", wf.roles.coder.skills.join() === sk.id && wf.roles.planner.skills.join() === `${sk.id},missing-skill` && wf.roles.reviewer.skills.length === 0 && wf.roles.tester.skills === undefined && /Coder: .* · skills: Design system rules$/m.test(brief) && /Planner: .* · skills: Design system rules, missing-skill$/m.test(brief) && /Skills attached to a role \(listed below\) reach that role's jobs automatically/.test(brief), { coder: wf.roles.coder.skills, tester: wf.roles.tester.skills });
    const job = await e.M.startRoleJob(parent.id, { role: "coder", task: "Build the settings page" }); await e.M.waitJob(job.id, 10000);
    const child = store.getSession(job.sessionId); const call = e.sdkCalls[0];
    check("W28b", "a coder job runs with the role's skills: the child session's selectedSkills, the job's `skills` (the card meta too), and the skill's procedure in the prompt as the labelled skills block right after the task", job.skills.join() === sk.id && child.selectedSkills.join() === sk.id && call && call.prompts[0].startsWith("Build the settings page\n\nSkills the user selected for this message") && /Design system rules/.test(call.prompts[0]) && parent.messages.find((m) => m.role === "job" && m.jobId === job.id).meta.skills.join() === sk.id, { skills: job.skills, sel: child.selectedSkills, head: call && call.prompts[0].slice(0, 140) });
    const tj = await e.M.startRoleJob(parent.id, { role: "tester", task: "Run it" }); await e.M.waitJob(tj.id, 10000);
    const tchild = store.getSession(tj.sessionId);
    check("W28c", "a tester job runs WITHOUT skills even when its saved config carries some; a second coder job (the reused session) keeps the role's skills", tj.skills.length === 0 && tchild.selectedSkills.length === 0 && !/Skills the user selected/.test(e.sdkCalls[1].prompts[0]) && (await (async () => { const j2 = await e.M.startRoleJob(parent.id, { role: "coder", task: "Second task" }); await e.M.waitJob(j2.id, 10000); return j2.sessionId === job.sessionId && store.getSession(j2.sessionId).selectedSkills.join() === sk.id && /Design system rules/.test(e.sdkCalls[2].prompts[0]); })()), { skills: tj.skills }); }

  // ---- W29: SOURCE-JOB HANDOFF (2026-09-18) — startRoleJob({ fromJob }) appends a FINISHED job's SAVED result to the next role's task ----
  { const e = environment(); e.setProvider("anthropic"); e.setWorkflow({ ...D(), enabled: true }); const parent = e.make();
    const pj = await e.M.startRoleJob(parent.id, { role: "planner", task: "Plan the /health endpoint" }); await e.M.waitJob(pj.id, 10000);
    // a later manual turn in the Planner's tab changes its transcript — what travels must be the SAVED job.result
    e.control.script = async function* ({ call }) { await sleep(5); yield { type: "system", subtype: "init", session_id: call.options.resume || "n29" }; yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "LATER TRANSCRIPT TEXT" }] } }; yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 }; await call.consumed; };
    await e.M.run(pj.sessionId, { text: "a follow-up typed in the planner tab" });
    e.control.script = null;
    const cj = await e.M.startRoleJob(parent.id, { role: "coder", task: "Implement the plan", fromJob: pj.id, files: ["src/server.js"], from: "cli" }); await e.M.waitJob(cj.id, 10000);
    const cc = e.sdkCalls[e.sdkCalls.length - 1]; const cchild = store.getSession(cj.sessionId); const ccard = parent.messages.find((m) => m.role === "job" && m.jobId === cj.id);
    check("W29", "plan → Coder: with fromJob = the finished planner job the child's prompt is the task, then ONE block 'Result of planner job <id> (the plan):' carrying the planner job's SAVED result (not the later transcript of its reused tab), then the files; job.task, the card text and the tab name stay the caller's text; fromJob is on the job, the card meta, jobInfo and the persisted history; `from` stays the cli provenance; the planner job's own fromJob is null", cc && cc.prompts[0] === `Implement the plan\n\nResult of planner job ${pj.id} (the plan):\nSynthetic reply.\n\nFiles of interest (named by the orchestrator):\n- src/server.js` && (cc.prompts[0].match(/Result of /g) || []).length === 1 && e.M.lastAssistantText(store.getSession(pj.sessionId)) === "LATER TRANSCRIPT TEXT" && cj.fromJob === pj.id && cj.task === "Implement the plan" && /^⚙ Coder · Implement the plan/.test(cchild.name) && cj.from === "cli" && ccard && ccard.meta.fromJob === pj.id && ccard.text === "Implement the plan" && e.M.jobInfo(cj.id).fromJob === pj.id && parent.workflowJobs.find((j) => j.id === cj.id).fromJob === pj.id && pj.fromJob === null && e.M.jobInfo(pj.id).fromJob === null, { prompt: cc && cc.prompts[0], fromJob: cj.fromJob, later: e.M.lastAssistantText(store.getSession(pj.sessionId)) });
    const rj = await e.M.startRoleJob(parent.id, { role: "reviewer", task: "Review the endpoint" }); await e.M.waitJob(rj.id, 10000);
    const fj = await e.M.startRoleJob(parent.id, { role: "coder", task: "Fix the findings", fromJob: rj.id }); await e.M.waitJob(fj.id, 10000);
    const fc = e.sdkCalls[e.sdkCalls.length - 1];
    check("W29b", "review → Coder: a Reviewer source is labelled '(the review findings)' and carries the Codex reviewer's saved text; the coder job REUSES the Coder's persistent session (same sessionId, native thread resumed) and still gets the block right after its task; the reviewer's own prompt carried no block", fj.sessionId === cj.sessionId && fj.reused === true && fc && typeof fc.options.resume === "string" && /^native-/.test(fc.options.resume) && fc.prompts[0] === `Fix the findings\n\nResult of reviewer job ${rj.id} (the review findings):\nCodex reply.` && fj.fromJob === rj.id && !/Result of /.test(e.appCalls[0].prompt), { prompt: fc && fc.prompts[0], resume: fc && fc.options.resume, reused: fj.reused });
    const cmd = await e.M.runCommandJob(parent.id, { command: "node -e \"console.error('BOOM-7'); process.exit(3)\"" }); const cdone = await e.M.waitJob(cmd.id, 20000);
    const ej = await e.M.startRoleJob(parent.id, { role: "coder", task: "Fix the failing run", fromJob: cmd.id }); await e.M.waitJob(ej.id, 10000);
    const ec = e.sdkCalls[e.sdkCalls.length - 1];
    e.control.script = async function* ({ call }) { yield { type: "system", subtype: "init", session_id: call.options.resume || "n29s" }; await new Promise((res) => { call.onInterrupt = res; }); await sleep(10); yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], num_turns: 1, total_cost_usd: 0 }; await call.consumed; };
    const sj = await e.M.startRoleJob(parent.id, { role: "tester", task: "Run everything" }); await sleep(40); await e.M.stopJob(sj.id); await sleep(60); e.control.script = null;
    const zj = await e.M.startRoleJob(parent.id, { role: "coder", task: "Retry the tests", fromJob: sj.id }); await e.M.waitJob(zj.id, 10000);
    const zc = e.sdkCalls[e.sdkCalls.length - 1];
    check("W29c", "an unsuccessful source is accepted and LABELLED: a failed command job → 'Result of command job <id> (the result — the job ended in error: Exit code 3.):' with its captured output verbatim (only trailing whitespace dropped — no JSON / log expansion, no truncation); a stopped role job that saved no text → '(the result — the job was stopped):' followed by '(empty result)'", cdone.status === "error" && cdone.error === "Exit code 3." && ec && ec.prompts[0] === `Fix the failing run\n\nResult of command job ${cmd.id} (the result — the job ended in error: Exit code 3.):\n${cdone.result.replace(/\s+$/, "")}` && /BOOM-7$/.test(ec.prompts[0]) && ej.fromJob === cmd.id && e.M.jobInfo(sj.id).status === "stopped" && !e.M.jobInfo(sj.id).result && zc && zc.prompts[0] === `Retry the tests\n\nResult of tester job ${sj.id} (the result — the job was stopped):\n(empty result)`, { ec: ec && ec.prompts[0], zc: zc && zc.prompts[0], sj: e.M.jobInfo(sj.id) && { status: e.M.jobInfo(sj.id).status, result: e.M.jobInfo(sj.id).result } });
    // refusals — every one BEFORE any side effect: no session, no pool entry, no registry entry, no card, no event, no task link
    e.M.addTasks(parent.id, { titles: ["Handoff task"] });
    let gate29; e.control.script = async function* ({ call }) { yield { type: "system", subtype: "init", session_id: call.options.resume || "n29r" }; yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "still working" }] } }; await new Promise((r) => { gate29 = r; }); yield { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0 }; await call.consumed; };
    const live = await e.M.startRoleJob(parent.id, { role: "planner", task: "Plan part two" }); await sleep(30); e.control.script = null;
    const other = e.make({ name: "another orchestrator" });
    const oj = await e.M.startRoleJob(other.id, { role: "coder", task: "The other orchestrator's job" }); await e.M.waitJob(oj.id, 10000);
    const snap = () => JSON.stringify({ sessions: store.listSessions().length, cards: parent.messages.filter((m) => m.role === "job").length, jobEvents: e.sends.filter((x) => x.name === "workflow:job").length, created: e.sends.filter((x) => x.name === "session:created").length, pool: parent.roleSessions, registry: e.M._jobRegistry().size, task: e.M.taskInfo(parent.id, "T1") });
    const before = snap();
    const r1 = await fails(() => e.M.startRoleJob(parent.id, { role: "coder", task: "x", fromJob: live.id }));
    const r2 = await fails(() => e.M.startRoleJob(parent.id, { role: "coder", task: "x", fromJob: "job-nope" }));
    const r3 = await fails(() => e.M.startRoleJob(parent.id, { role: "coder", task: "x", fromJob: oj.id }));
    const r4 = await fails(() => e.M.startRoleJob(parent.id, { role: "coder", task: "x", fromJob: "   " }));
    const r5 = await fails(() => e.M.startRoleJob(parent.id, { role: "coder", task: "x", taskRef: "T1", fromJob: "job-nope" }));
    check("W29d", "refused with plain sentences: a source that has not ended (wait for it — atomnano wait <id> --timeout 540), an unknown / pruned id, another orchestrator's job, a blank id, and an unknown source next to a valid --task; nothing changed — no session, no pool entry, no registry entry, no card, no workflow:job / session:created event, and the task was not linked", r1 && new RegExp(`^Job ${live.id} is still running — wait for it \\(atomnano wait ${live.id} --timeout 540\\) before handing its result on\\.$`).test(r1.message) && r2 && /^No job job-nope among this session's jobs — --from takes the id of a finished job of this orchestrator \(atomnano jobs lists them; jobs older than the kept history are gone\)\.$/.test(r2.message) && r3 && new RegExp(`^Job ${oj.id} belongs to another orchestrator session — --from takes a job of this session \\(atomnano jobs lists them\\)\\.$`).test(r3.message) && r4 && /^--from needs the id of a finished job of this session \(atomnano jobs lists them\)\.$/.test(r4.message) && r5 && /^No job job-nope among this session's jobs/.test(r5.message) && snap() === before && e.M.taskInfo(parent.id, "T1").jobIds.length === 0 && e.M.taskInfo(parent.id, "T1").status === "todo", { r1: r1 && r1.message, r2: r2 && r2.message, r3: r3 && r3.message, r4: r4 && r4.message, r5: r5 && r5.message, same: snap() === before });
    gate29(); await e.M.waitJob(live.id, 10000);
    // a PERSISTED source: the live registry is gone (an earlier app process ran the job) — jobsFor serves the orchestrator's workflowJobs
    store.flush(parent.id); e.M._jobs.clear();
    parent.workflowJobs.push({ id: "job-old", kind: "role", role: "planner", parentId: parent.id, sessionId: null, task: "Plan part three", status: "running", startedTs: "2026-01-01T00:00:00.000Z", result: "half a plan\n" });
    const hj = await e.M.startRoleJob(parent.id, { role: "coder", task: "Continue from history", fromJob: pj.id }); await e.M.waitJob(hj.id, 10000);
    const hc = e.sdkCalls[e.sdkCalls.length - 1];
    const oj2 = await e.M.startRoleJob(parent.id, { role: "coder", task: "Finish part three", fromJob: "job-old" }); await e.M.waitJob(oj2.id, 10000);
    const oc = e.sdkCalls[e.sdkCalls.length - 1];
    check("W29e", "a PERSISTED source works once the live registry is gone: the planner job's saved result travels from the orchestrator's workflowJobs (the reused Coder session gets it); a history entry that was still live when the app closed is served as stopped and handed on with that label — '(the plan — the job was stopped: AtomNano was restarted before this job finished.)' — and its saved text", hc && hc.prompts[0] === `Continue from history\n\nResult of planner job ${pj.id} (the plan):\nSynthetic reply.` && hj.fromJob === pj.id && hj.sessionId === cj.sessionId && oc && oc.prompts[0] === `Finish part three\n\nResult of planner job job-old (the plan — the job was stopped: AtomNano was restarted before this job finished.):\nhalf a plan` && oj2.fromJob === "job-old", { hc: hc && hc.prompts[0], oc: oc && oc.prompts[0] }); }

  // ---- W29: the MODE NOTE (settings.modeNote, default on) + workflow ↔ solo sub-agents EXCLUSIVITY (user decisions 2026-09-18) ----
  { const e = environment(); e.setProvider("anthropic"); store.saveSettings({ modeNote: true }); const d = D();
    e.setWorkflow({ ...d, enabled: false, name: "Team" });
    const s = e.make();
    await e.M.run(s.id, { text: "SOLO OFF" });
    const c1 = e.sdkCalls[0];
    await e.M.run(s.id, { text: "SOLO ON", subAgents: true, subAgentsMax: 7 });
    const c2 = e.sdkCalls[1];
    const noteOff = e.M.modeBrief(s, e.M.workflowFor(s), false), noteOn = e.M.modeBrief(s, e.M.workflowFor(s), true, 7);
    check("W29", "mode note: a bare solo turn's system-prompt append is ONE sentence — the workflow \"Team\" is off for this chat, solo sub-agents off; with the Agents switch on the note says on (up to 7) and the sub-agents brief follows it; the Task tool follows the switch; no stage events either way", c1 && c1.options.systemPrompt.append === noteOff && /^AtomNano mode: solo\. The workflow "Team" is off for this chat/.test(noteOff) && /solo sub-agents are off, so you do everything yourself\.$/.test(noteOff) && (c1.options.disallowedTools || []).includes("Task") && c2 && c2.options.systemPrompt.append.startsWith(noteOn + "\n\n") && /solo sub-agents are on \(up to 7 at once/.test(noteOn) && /Sub-agents: you may launch up to 7/.test(c2.options.systemPrompt.append) && !(c2.options.disallowedTools || []).includes("Task") && c2.options.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS === "7" && !e.sends.some((x) => x.name === "workflow:stage" && x.data.sessionId === s.id), { a1: c1 && c1.options.systemPrompt.append, a2: c2 && c2.options.systemPrompt.append });
    e.setWorkflow({ ...d, enabled: true, name: "Team" });
    const o = e.make();
    await e.M.run(o.id, { text: "ORCH", subAgents: true, subAgentsMax: 7 });
    const c3 = e.sdkCalls[2];
    check("W29b", "EXCLUSIVE: with the workflow on, the orchestrator's own turn never gets solo sub-agents even though the composer switch is on — Task / Agent disallowed, no cap in the env, no sub-agents brief, sent.subAgents 0 — and its brief says it fans out only through the roles", c3 && (c3.options.disallowedTools || []).includes("Task") && !("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS" in c3.options.env) && !/Sub-agents: you may launch/.test(c3.options.systemPrompt.append) && /Solo sub-agents are off on your own turns — you fan out only through the roles/.test(c3.options.systemPrompt.append) && /You are the Orchestrator/.test(c3.options.systemPrompt.append) && !/AtomNano mode: solo/.test(c3.options.systemPrompt.append) && e.M.lastRunInfo().sent.subAgents === 0, { dt: c3 && c3.options.disallowedTools, env: c3 && c3.options.env });
    // no note: the setting off, a background turn, a role child's own later turn
    store.saveSettings({ modeNote: false }); e.setWorkflow({ ...d, enabled: false, name: "Team" });
    const s2 = e.make(); await e.M.run(s2.id, { text: "BARE" }); const cBare = e.sdkCalls[e.sdkCalls.length - 1];
    store.saveSettings({ modeNote: true });
    const s3 = e.make(); await e.M.run(s3.id, { text: "BG", background: true }); const cBg = e.sdkCalls[e.sdkCalls.length - 1];
    e.setWorkflow({ ...d, enabled: true, name: "Team" }); const parent = e.make();
    const job = await e.M.startRoleJob(parent.id, { role: "coder", task: "T" }); await e.M.waitJob(job.id, 10000);
    await e.M.run(job.sessionId, { text: "child follow-up" }); const cChild = e.sdkCalls[e.sdkCalls.length - 1];
    check("W29c", "no mode note when settings.modeNote is false (a bare turn), on a background turn, or in a role child's own later turn", !("append" in cBare.options.systemPrompt) && !("append" in cBg.options.systemPrompt) && cChild.prompts[0] === "child follow-up" && !/AtomNano mode/.test(cChild.options.systemPrompt.append || ""), { bare: cBare.options.systemPrompt, bg: cBg.options.systemPrompt, child: cChild.options.systemPrompt });
    // switching the workflow OFF mid-work: the next solo turn's note carries the state to continue — the open board items and the recent jobs
    e.setWorkflow({ ...d, enabled: true, name: "Team" }); const hs = e.make();
    e.M.addTasks(hs.id, { titles: ["Wire the store", "Write the docs"], set: { title: "Payments" } });
    const hj = await e.M.startRoleJob(hs.id, { role: "coder", task: "Wire the store to Postgres", taskRef: "T1" }); await e.M.waitJob(hj.id, 10000);
    e.M.updateTask(hs.id, "T1", { status: "done" });
    e.setWorkflow({ ...d, enabled: false, name: "Team" });
    await e.M.run(hs.id, { text: "continue" }); const cH = e.sdkCalls[e.sdkCalls.length - 1]; const ap = cH.options.systemPrompt.append || "";
    check("W29e", "the workflow switched OFF mid-work: the next solo turn's note says the workflow was on earlier, that the remaining work is the model's to finish itself (atomnano run refused; tasks / jobs / result still read), the OPEN board items (done ones left out) and the recent jobs with status and task — so the agent continues from the current state; a chat that never delegated gets the bare note", /^AtomNano mode: solo\./.test(ap) && /The workflow was on earlier in this chat/.test(ap) && /do the remaining parts yourself/.test(ap) && /atomnano run … is refused while the workflow is off/.test(ap) && /Task board — Set 1/.test(ap) && /Payments/.test(ap) && /T2 todo/.test(ap) && !/T1 done/.test(ap) && new RegExp(hj.id + " coder done — Wire the store to Postgres").test(ap) && (cH.options.disallowedTools || []).includes("Task") && e.M.modeBrief(e.make(), e.M.workflowFor(hs), false) === noteOff, { ap });
    // Codex: the note rides the brief channel — once per thread, a pointer afterwards
    e.setProvider("openai"); e.setWorkflow({ ...d, enabled: false, name: "Team" });
    const cx = e.make({ model: "gpt-5.5", thinking: "medium" });
    await e.M.run(cx.id, { text: "CX1" }); await e.M.run(cx.id, { text: "CX2" });
    const p1 = e.appCalls[e.appCalls.length - 2].prompt, p2 = e.appCalls[e.appCalls.length - 1].prompt;
    check("W29d", "Codex: the mode note goes out in full once (the thread's first turn, as the role brief) and as the one-line briefs pointer on the next turn — never the note again", p1.startsWith("CX1\n\nRole brief for this conversation") && /AtomNano mode: solo\. The workflow "Team" is off/.test(p1) && p2.startsWith("CX2\n\nBriefs: unchanged") && !/AtomNano mode/.test(p2) && !/Sub-agents/.test(p1), { p1: p1.slice(0, 220), p2 }); }

  clearTimeout(watchdog);
  console.log(`Workflow: ${pass} passed, ${failN} failed`);
  if (failures.length) console.log("Failures:\n  " + failures.join("\n  "));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failN ? 1 : 0);
}
function sdkCallsOf(e) { return e.sdkCalls; }
main().catch((e) => { console.error(e); process.exit(2); });
