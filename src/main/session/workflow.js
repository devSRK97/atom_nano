"use strict";
/* Workflow (orchestrator-as-primary) — the main-process core. Contract: docs/WORKFLOW_CONTRACT.md.
 *
 * A WORKFLOW assigns a model (provider · model · effort · access) to each ROLE — the Orchestrator and
 * its workers Planner, Coder, Reviewer, Tester — plus a sub-agent lane per worker role. The
 * ORCHESTRATOR IS THE PRIMARY: it is the model the user chats with, and it manages, orchestrates and
 * monitors every other role (user decision 2026-09-17: the Planner used to be the primary; it is now a
 * worker that drafts the plan, and the new Orchestrator node above it took over all controlling
 * duties). While the workflow is enabled the primary turn runs with the orchestrator role's picks and
 * a visible BRIEF (systemPrompt.append on Claude, a labelled appendix on Codex / custom) that explains
 * the roles and the `atomnano` CLI; the orchestrator delegates by running the CLI from its Bash tool,
 * the CLI reaches the app's control server, and the server calls startRoleJob / runCommandJob here.
 *
 * Every delegated piece of work is a JOB. A ROLE job is a CHILD SESSION (its own tab, `parentId` →
 * the orchestrator) run through the ordinary run() path with that role's provider / model / effort /
 * access, so permissions, Stop, the record and provider continuity all work exactly as for any tab.
 * A COMMAND job runs a shell command in the project folder and captures its output. Job state lives
 * in an in-memory registry (this._jobs) and is mirrored, bounded, onto the orchestrator session
 * (`workflowJobs`) as history; every change is broadcast as `workflow:job`, every role transition as
 * `workflow:stage`, and the orchestrator's chat shows one `role: "job"` card per job.
 *
 * Lifecycle: queued → running (the child's run() dispatched) → done | error | stopped — the terminal
 * transition comes from finalizeRun (the ONE terminal state of a run), so a child turn that is
 * paused and replayed (offline / login / rate limit) keeps its job alive until the replay ends.
 *
 * The TASK BOARD (session/tasks.js, contract §8) hooks in here: the generated orchestrator brief carries
 * the one §8.2 paragraph, startRoleJob links a job to a board task (`taskRef`, or a description that is
 * just "T3") and the child receives that task as a labelled line after its task text, and _jobEnd appends
 * the job's outcome as a note on the task.
 *
 * SOURCE-JOB HANDOFF (2026-09-18, `atomnano run coder "…" --from <job id>`): startRoleJob({ fromJob }) hands a
 * FINISHED job's SAVED result (its `job.result` snapshot — never the reused child's later transcript) to the
 * next role as one labelled block right after the task text ("Result of planner job job-1 (the plan):"). The
 * source is resolved through jobsFor (live registry + persisted history) and must belong to the same
 * orchestrator and have ended (done / error / stopped — an unsuccessful end is named in the label, an empty
 * result is marked); anything else is refused before a child session, pool entry, card or task link exists.
 * The job records `fromJob`; its `task` stays the caller's text.
 *
 * SUB-AGENT LANES run on every provider (user decision 2026-09-17): Claude roles get the Task tool with
 * CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, Codex roles get Codex's own multi-agent feature with the lane as
 * `agents.max_concurrent_threads_per_session` (session/openai.js). A lane is never silently ignored.
 *
 * STANDING RULE: the app adds no hidden prompt layers to ORDINARY turns. The briefs here are an
 * explicit, user-designed workflow, shown in the Workflow studio, applied only to the orchestrator while
 * `workflow.enabled` and to the child jobs the orchestrator (or the user) started. */
const { spawn } = require("child_process");
const store = require("../storage/store");
const history = require("../storage/history");
const providers = require("../providers/catalog");
const A = require("../agents/subagents");
const { isBareRef } = require("./tasks");

const PRIMARY = "orchestrator";                                          // the role the user chats with
const ROLES = ["orchestrator", "planner", "coder", "reviewer", "tester"];
const WORKERS = ["planner", "coder", "reviewer", "tester"];              // the roles the orchestrator delegates to (each with its own lane)
const SKILL_ROLES = ["planner", "coder", "reviewer"];                    // roles that can carry attached skills (the Tester runs the tests as they are)
const PROVIDERS = ["anthropic", "openai", "custom"];
const ACCESS = ["bypassPermissions", "acceptEdits", "default", "read"];
const ACCESS_LABEL = { bypassPermissions: "full access", acceptEdits: "accept edits", default: "ask before tools", read: "read-only", plan: "read-only" };
const ROLE_ALIAS = { planner: "planner", plan: "planner", coder: "coder", code: "coder", reviewer: "reviewer", review: "reviewer", tester: "tester", test: "tester" };
const TERMINAL = new Set(["done", "error", "stopped"]);
const PAUSED = new Set(["offline", "auth-expired", "ratelimited"]);   // the child's turn is preserved and replays by itself
const MAX_LANE = 20;                 // sub-agents in the lane (the CLI's own concurrency cap)
const JOB_HISTORY = 100;             // jobs kept on the orchestrator session
const REGISTRY_KEEP = 500;           // finished jobs kept in memory for `atomnano result <id>`
const COMMAND_OUTPUT_MAX = 200 * 1024;
// Contract §8.2 — the ONE task-board paragraph of the GENERATED orchestrator brief (a user's override replaces the whole brief).
const TASK_BOARD_BRIEF = 'Track delegated, multi-step work on this session\'s task board (a direct answer needs no board): create the tasks first (`atomnano tasks add "…" "…" --set "<title>"`), start / finish them as you go (`atomnano tasks start T3`, `atomnano tasks done T3 --note "…"`), hand one to a role with `atomnano run coder "…" --task T3` (planner → doing, reviewer → review, tester → test), and open a new set when a new batch of work begins. `atomnano tasks` shows the board.';

// The contract's defaults — normally read from the store; this copy only guards a store without them.
const FALLBACK_DEFAULTS = {
  enabled: false, name: "Solo", savedId: null,
  roles: {
    orchestrator: { provider: "", model: "", effort: "", access: "bypassPermissions" },
    planner: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "read", agents: 0, skills: [] },
    coder: { enabled: true, provider: "anthropic", model: "", effort: "high", access: "bypassPermissions", agents: 3, skills: [] },
    reviewer: { enabled: true, provider: "openai", model: "", effort: "medium", access: "read", agents: 0, skills: [] },
    tester: { enabled: true, provider: "anthropic", model: "", effort: "medium", access: "bypassPermissions", agents: 0, command: "" },
  },
  layout: {}, brief: "", openJobTabs: false,
};
// A role's usable sub-agent lane: its cap when the role is on — on EVERY provider (2026-09-17: the lane
// used to count on Anthropic only; Codex roles now get Codex's multi-agent feature with the same cap).
const laneOf = (rc) => (rc && rc.enabled !== false && rc.agents > 0 ? rc.agents : 0);
function defaults() {
  try { if (typeof store.workflowDefaults === "function") return store.workflowDefaults(); } catch { /* fall through */ }
  return JSON.parse(JSON.stringify(FALLBACK_DEFAULTS));
}
/* A workflow saved BEFORE the Orchestrator existed (2026-09-17) has the primary's picks under
 * `roles.planner` (no `enabled`, no `agents`) and the primary's node under `layout.planner`. They move
 * to `orchestrator`; the Planner then takes the new worker defaults. Mutates and returns `w`. */
function migrateLegacyPrimary(w) {
  const roles = w && w.roles && typeof w.roles === "object" ? w.roles : null;
  const p = roles && roles.planner && typeof roles.planner === "object" ? roles.planner : null;
  if (roles && !roles.orchestrator && p && p.enabled === undefined && p.agents === undefined) {
    roles.orchestrator = { provider: p.provider || "", model: p.model || "", effort: p.effort || "", access: p.access === undefined ? "bypassPermissions" : p.access };
    delete roles.planner;
    const lay = w.layout && typeof w.layout === "object" && !Array.isArray(w.layout) ? w.layout : null;
    if (lay && lay.planner && !lay.orchestrator) { lay.orchestrator = lay.planner; delete lay.planner; }
  }
  return w;
}
const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
const str = (v, dv) => (typeof v === "string" ? v.trim() : dv);
const clampLane = (n, dv) => { const v = Math.floor(+n); return Number.isFinite(v) ? Math.max(0, Math.min(MAX_LANE, v)) : dv; };
// One line of a task for a tab name.
function shortText(s, max) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length <= max ? s : s.slice(0, max - 1).replace(/[\s,;:]+\S*$/, "") + "…"; }

/* A saved workflow completed against the defaults: every role present, unknown providers /
 * access values replaced, the sub-agent lane clamped to 0–20. Never throws. */
function resolveWorkflow(raw) {
  const d = defaults();
  const w = migrateLegacyPrimary((raw && typeof raw === "object") ? JSON.parse(JSON.stringify(raw)) : {});
  const out = {
    enabled: !!w.enabled,
    name: str(w.name, "") || d.name,
    savedId: typeof w.savedId === "string" && w.savedId ? w.savedId : null,
    roles: {},
    layout: (w.layout && typeof w.layout === "object" && !Array.isArray(w.layout)) ? w.layout : {},
    brief: typeof w.brief === "string" ? w.brief : "",
    // Job tabs are opt-in (2026-09-17): jobs run in the background through the CLI; the pre-2026-09-17
    // `autoOpenJobs` (default on) is not read, so every saved workflow starts in the background.
    openJobTabs: w.openJobTabs === undefined ? d.openJobTabs === true : !!w.openJobTabs,
  };
  const roles = (w.roles && typeof w.roles === "object") ? w.roles : {};
  for (const name of ROLES) {
    const dr = d.roles[name] || FALLBACK_DEFAULTS.roles[name];
    const r = (roles[name] && typeof roles[name] === "object") ? roles[name] : {};
    const provider = str(r.provider, dr.provider);
    const access = str(r.access, dr.access);
    const role = {
      // the orchestrator's "" = follow the composer's provider / model / effort / access
      provider: PROVIDERS.includes(provider) ? provider : (name === PRIMARY ? "" : dr.provider),
      model: str(r.model, dr.model),
      effort: str(r.effort, dr.effort),
      access: ACCESS.includes(access) ? access : (name === PRIMARY && access === "" ? "" : "bypassPermissions"),
    };
    if (name !== PRIMARY) role.enabled = r.enabled === undefined ? dr.enabled !== false : !!r.enabled;
    // Every worker role has ITS OWN sub-agent lane (user decision 2026-09-17): 0 = solo, 1–20 = the cap.
    if (name !== PRIMARY) role.agents = clampLane(r.agents, clampLane(dr.agents, name === "coder" ? 3 : 0));
    // Skills attached to the role (ids of this project's AtomNano skills, 2026-09-18): every job of the role runs
    // with them as its selected skills. Planner / Coder / Reviewer only — the Tester runs the tests as they are.
    if (SKILL_ROLES.includes(name)) role.skills = Array.isArray(r.skills) ? [...new Set(r.skills.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()))].slice(0, 50) : [];
    if (name === "tester") role.command = str(r.command, dr.command || "");
    out.roles[name] = role;
  }
  return out;
}

/* Bounded capture of a command's output: the first part and the last part are kept (a failing test
 * run reports at its END), what fell between is replaced by one note. */
function outputBuffer(max) {
  const headMax = Math.floor(max * 0.4), tailMax = max - headMax;
  let head = "", tail = "", dropped = 0;
  return {
    push(chunk) {
      let s = String(chunk || "");
      if (head.length < headMax) { const take = Math.min(headMax - head.length, s.length); head += s.slice(0, take); s = s.slice(take); }
      if (!s) return;
      tail += s;
      if (tail.length > tailMax) { dropped += tail.length - tailMax; tail = tail.slice(tail.length - tailMax); }
    },
    text() { return dropped ? `${head}\n[… truncated …] (${dropped.toLocaleString("en-US")} characters of output omitted here)\n${tail}` : head + tail; },
  };
}

const methods = {
  /* ------------------------------ configuration ------------------------------ */
  /* The workflow a session runs with, defaults filled. Never throws. Order (contract §10, 2026-09-18):
   * the session's OWN workflow (`session.workflow` — each tab picks its workflow independently) → the
   * nearest ancestor's own workflow (a role child runs under its orchestrator's) → the project's active
   * workflow (`settings.workflow`, the default for tabs that never chose). A bare cwd resolves the project's. */
  workflowFor(sessionOrCwd, settings) {
    try {
      let cwd = sessionOrCwd;
      if (sessionOrCwd && typeof sessionOrCwd === "object") {
        cwd = sessionOrCwd.cwd;
        let s = sessionOrCwd.id ? (store.getSession(sessionOrCwd.id) || sessionOrCwd) : sessionOrCwd;
        for (let hop = 0; hop < 8 && s; hop++) {
          if (s.workflow && typeof s.workflow === "object" && !Array.isArray(s.workflow)) return resolveWorkflow(s.workflow);
          if (!cwd && s.cwd) cwd = s.cwd;
          s = s.parentId ? store.getSession(s.parentId) : null;
        }
      }
      const s = settings || store.getSettings(cwd || undefined);
      return resolveWorkflow(s && s.workflow);
    } catch { return resolveWorkflow(null); }
  },
  // Does this session carry its own workflow (true) or follow the project's (false)?
  hasOwnWorkflow(sessionId) {
    const s = sessionId ? store.getSession(sessionId) : null;
    return !!(s && s.workflow && typeof s.workflow === "object" && !Array.isArray(s.workflow));
  },
  /* Give a session its own workflow (the studio's edits, a library load, a clone) or clear it back to the
   * project's (wf = null). Persisted on the session record; `session:workflow` tells every window. */
  setSessionWorkflow(sessionId, wf) {
    const s = store.getSession(sessionId);
    if (!s) throw new Error("Session not found");
    const w = wf && typeof wf === "object" ? resolveWorkflow(wf) : null;
    store.updateSession(sessionId, { workflow: w });
    this.send("session:workflow", { sessionId, workflow: w });
    return w;
  },

  // A role's access value → the run's permission mode. `read` is Plan mode (the Codex runner maps
  // plan → read-only sandbox itself); anything unknown is Full access, the default.
  accessToPermission(access, provider) {   // eslint-disable-line no-unused-vars
    const a = String(access || "").trim();
    if (a === "read" || a === "plan") return "plan";
    if (a === "bypassPermissions" || a === "acceptEdits" || a === "default") return a;
    return "bypassPermissions";
  },

  /* The orchestrator's brief — the user's override verbatim when set, else generated: who the
   * orchestrator is (the primary that manages, orchestrates and monitors the roles), the roles table,
   * the exact CLI usage, this session's id. Plain prose and bullets; the studio shows exactly this text
   * (workflow:brief). `plannerBrief` below is the pre-2026-09-17 name, kept as an alias. */
  orchestratorBrief(session, wf, provider) {
    wf = wf || this.workflowFor(session);
    if (typeof wf.brief === "string" && wf.brief.trim()) return wf.brief;
    const label = (p) => { try { const c = providers.get(p); return (c && c.label) || p; } catch { return p; } };
    const acc = (a) => ACCESS_LABEL[a] || a || "full access";
    const r = wf.roles;
    const me = r[PRIMARY];
    const prov = me.provider || provider || session.provider || session.lastProvider || "anthropic";
    const rows = [`- Orchestrator (you): ${label(prov)} · ${session.model || me.model || "default model"} · ${session.thinking || me.effort || "default effort"} · ${acc(session.permissionMode || me.access)}`];
    const row = (name, rc, extra) => (rc.enabled ? `- ${cap(name)}: ${label(rc.provider)} · ${rc.model || "default model"} · ${rc.effort || "default effort"} · ${acc(rc.access)}${extra || ""}` : `- ${cap(name)}: disabled`);
    // Each role's own lane (on every provider): the orchestrator knows what each role can fan out to.
    const lane = (rc) => (laneOf(rc) ? ` · up to ${rc.agents} sub-agent${rc.agents === 1 ? "" : "s"}` : "");
    // The skills attached to a role, by name (this project's AtomNano skills) — they reach the role's jobs automatically.
    const skillName = (id) => { try { const s = require("../agents/skills").get(session.cwd, id); return (s && s.name) || id; } catch { return id; } };
    const skillsOf = (rc) => (Array.isArray(rc.skills) && rc.skills.length ? ` · skills: ${rc.skills.map(skillName).join(", ")}` : "");
    const anySkills = SKILL_ROLES.some((w) => Array.isArray(r[w].skills) && r[w].skills.length);
    rows.push(row("planner", r.planner, lane(r.planner) + skillsOf(r.planner)));
    rows.push(row("coder", r.coder, lane(r.coder) + skillsOf(r.coder)));
    rows.push(row("reviewer", r.reviewer, lane(r.reviewer) + skillsOf(r.reviewer)));
    rows.push(row("tester", r.tester, lane(r.tester) + (r.tester.command ? ` · test command: ${r.tester.command}` : "")));
    // TRIAGE (user request 2026-09-18): simple requests are answered directly; small clear coding goes straight
    // to the Coder; the Planner is for larger or unclear coding work; review / test follow code changes.
    // Compacted 2026-09-18 (≈3,000 characters with the default roles — it rides on every orchestrator turn):
    // every rule stays, the plan → Coder and review → Coder handoffs use --from (the saved result travels with
    // the task), and waiting is --wait --timeout 540 then `atomnano wait <id> --timeout 540` under a 600 s shell timeout.
    const coderOn = r.coder.enabled;
    const delegate = coderOn
      ? "Coding work goes to the Coder through the atomnano CLI (your Bash tool) — a small, clear change (a bug fix, a rename) straight away, no plan."
      : "Coding work you do yourself (the Coder role is disabled); the atomnano CLI (your Bash tool) reaches the other roles.";
    const handPlan = coderOn ? "hand it to the Coder with --from <planner job id> (--context when the discussion matters)" : "follow it yourself";
    const plan = r.planner.enabled
      ? `For larger or unclear coding work (several files, design decisions, unknown code) have the Planner draft the plan, decide on it, then ${handPlan}.`
      : "For larger work decide the plan yourself (the Planner role is disabled) before delegating.";
    const helpers = [r.reviewer.enabled ? "the Reviewer review" : "", r.tester.enabled ? "the Tester test" : ""].filter(Boolean);
    const fixups = coderOn ? `fix-ups go straight back to the Coder${r.reviewer.enabled ? " with --from <reviewer job id>" : ""} — no new plan` : "fix-ups you do yourself";
    const after = helpers.length ? ` After code changes have ${helpers.join(" and ")} the result${helpers.length === 2 ? " (both at once)" : ""}; ${fixups}.` : "";
    const anyLane = WORKERS.some((w) => laneOf(r[w]));
    const cli = [];
    if (r.planner.enabled) cli.push('- atomnano run planner "<request>"');
    if (coderOn) cli.push('- atomnano run coder "<task>" [--from <job id>]');
    if (r.reviewer.enabled) cli.push('- atomnano run reviewer "<what to review>"');
    if (r.tester.enabled) cli.push('- atomnano test [--cmd "<command>"]');
    cli.push("- atomnano jobs · wait <id> · result <id> · stop <id> · roles · status");
    return [
      `You are the Orchestrator of the "${wf.name}" workflow — the primary the user talks to; you manage, orchestrate and monitor every other role. Simple requests — questions, explanations, summaries, reviews of text or ideas, advice, lookups, any non-coding work — you answer yourself: no Planner, no Coder, no task board. ${delegate} ${plan}${after} Monitor the jobs, verify what comes back and report to the user.${anyLane ? " Roles with sub-agents work in parallel: give them divisible tasks, a broad investigation a bigger lane (--agents N)." : ""} Solo sub-agents are off on your own turns — you fan out only through the roles. Keep idle roles busy — while the Coder implements one part, the Planner plans the next and the Reviewer and Tester check finished parts: start such jobs without --wait and collect them with atomnano jobs / wait <id>. Each role keeps ONE persistent session for this chat and remembers its earlier tasks and results: build on them, send follow-ups to the same role. A busy role gets a second, fresh session — for continuity wait for its job first; --fresh starts a role over.${anySkills ? " Skills attached to a role (listed below) reach that role's jobs automatically — no need to paste them." : ""}`,
      "Roles (provider · model · effort · access):\n" + rows.join("\n"),
      "CLI (a job's result is the command output):\n" + cli.join("\n") + "\nOptions: --from <job id> (append that finished job's saved result to the task), --files a,b, --agents N (this job's lane), --context (this conversation, condensed), --fresh (a new session for the role). Wait with --wait --timeout 540 (returns after 540 s; the job keeps running), then atomnano wait <id> --timeout 540 until it ends, with your shell tool's timeout at 600 s; without --wait a job runs in the background.",
      TASK_BOARD_BRIEF,
      `Your session id is ${session.id} — pass --session ${session.id} when a command asks for it.`,
    ].join("\n\n");
  },
  plannerBrief(session, wf, provider) { return this.orchestratorBrief(session, wf, provider); },

  /* The MODE NOTE of a solo primary turn (user decision 2026-09-18: the model must know the current setting):
   * one sentence saying the workflow is off for this chat and whether solo sub-agents are on. It rides the
   * brief channel — Claude: systemPrompt.append (cached), Codex: once per thread through the brief hash, re-sent
   * when the mode flips — so it costs a handful of tokens once, not per turn. `settings.modeNote === false` turns
   * it off (session/index.js _runSetup); the orchestrator's brief covers the workflow-on case itself. */
  modeBrief(session, wf, subOn, subMax) {
    const name = (wf && wf.name) || "Solo";
    const n = subOn ? A.clampMax(subMax) : 0;
    const agents = subOn ? `solo sub-agents are on (up to ${n} at once — see the sub-agents brief)` : "solo sub-agents are off, so you do everything yourself";
    const base = `AtomNano mode: solo. The workflow "${name}" is off for this chat (the user can turn it on in the Workflow studio, which makes you its Orchestrator) and ${agents}.`;
    const cont = this.soloContinuation(session);
    return cont ? base + " " + cont : base;
  },
  /* The workflow was switched OFF mid-work (user request 2026-09-18): the solo turn must know the current state and
   * continue it itself — the open board items and the recent jobs with their status travel in the mode note, with
   * the rule that delegation is refused now while the board and the jobs' results can still be read. "" when the
   * chat never delegated (no jobs, no board). Changes only when the board or a job changes, so the Codex brief
   * hash re-sends it just then. */
  soloContinuation(session) {
    if (!session || session.role) return "";
    let jobs = [], board = null;
    try { jobs = typeof this.jobsFor === "function" ? this.jobsFor(session.id) : []; } catch { jobs = []; }
    try { board = typeof this.boardFor === "function" ? this.boardFor(session) : null; } catch { board = null; }
    const total = board && board.counts ? board.counts.total : 0;
    if (!jobs.length && !total) return "";
    const parts = ["The workflow was on earlier in this chat and you delegated work to its roles; that work is yours now — do the remaining parts yourself (atomnano run … is refused while the workflow is off; atomnano tasks, jobs and result <id> still read the board and the jobs' results)."];
    if (total) { let b = ""; try { b = this.boardSummaryText(session, { openOnly: true }) || ""; } catch { b = ""; } if (b) parts.push(b.replace(/\s+/g, " ").trim()); }
    if (jobs.length) parts.push("Recent jobs: " + jobs.slice(-6).map((j) => `${j.id} ${j.kind === "command" ? "command" : j.role} ${j.status}${j.task ? " — " + shortText(j.task, 60) : ""}`).join("; ") + ".");
    return parts.join(" ");
  },

  // The short brief a child job runs with (Claude: systemPrompt.append; Codex / custom: labelled appendix).
  roleBrief(role, wf) {
    const r = ROLE_ALIAS[String(role || "").trim().toLowerCase()];
    const rc = (wf && wf.roles && wf.roles[r]) || {};
    // The role's lane, and how to USE it (user decision 2026-09-17: fan out to as many as the task
    // allows — all of them when the work divides that far, fewer when it does not — in parallel).
    const n = laneOf({ ...rc, enabled: true });
    const useLane = (what) => (n ? ` You have up to ${n} sub-agent${n === 1 ? "" : "s"}${what.note || ""} — use them to speed the work up: split independent parts of ${what.of} across as many as the task allows (all ${n} when the work divides that far, fewer when it does not) and run them in parallel; the rest you do yourself.` : "");
    // ONE persistent session per role per orchestrator (2026-09-17/18): the role's earlier tasks and results are
    // in its own context already — it is told to build on them rather than start from scratch each time.
    const memory = " This session is your persistent one for this chat — your earlier tasks here and their outcomes are already in your context; build on them rather than starting over.";
    if (r === "planner") {
      // The Planner's lane is for parallel INVESTIGATION (2026-09-18): one area, module or question per agent,
      // the findings combined into the plan — its agents are read-only like the Planner itself.
      const lane = n ? ` You have up to ${n} sub-agent${n === 1 ? "" : "s"} (read-only, like you) — use them to speed the investigation up: split its independent parts across as many as the task allows (all ${n} when it divides that far, fewer when it does not) — one area, module or question each — run them in parallel, then combine what they found into the plan; the rest you research yourself.` : "";
      return "You are the Planner of the user's workflow: plan only — read the repository and the request, then write a concise, actionable implementation plan the Coder will follow: numbered steps, the files and areas to touch, key decisions, edge cases and how to verify the result." + lane + memory + " Do not implement anything yourself; the Orchestrator decides on your plan and delegates it.";
    }
    if (r === "coder") return "You are the Coder of the user's workflow: implement exactly the task delegated to you in this repository — nothing beyond it; when the task carries a plan, follow its steps, and when it carries review findings, address them." + useLane({ of: "the task" }) + memory + " When you are done, report what changed (files and behaviour) and how you verified it.";
    if (r === "reviewer") return "You are the Reviewer of the user's workflow: review only — do not edit files or run anything that changes the repository." + useLane({ of: "the review", note: " (read-only, like you)" }) + memory + " Report your findings ordered by severity (blocking, major, minor), each with the file and line and a concrete fix, and end with a one-line verdict.";
    if (r === "tester") return "You are the Tester of the user's workflow: run the tests" + (rc.command ? ` with the configured command \`${rc.command}\`` : " — with the command given in the task, otherwise the project's own test command —") + " and report pass or fail with the failing output verbatim." + useLane({ of: "the test run" }) + memory + " Do not change the code yourself.";
    return "";
  },

  /* ------------------------------ jobs: registry ------------------------------ */
  _jobRegistry() {
    if (!this._jobs) { this._jobs = new Map(); this._jobMeta = new Map(); }
    return this._jobs;
  },
  _jobRegister(job) {
    const reg = this._jobRegistry();
    const meta = { cardId: null, waiters: [], resolveStarted: null, started: null, child: null, timer: null, output: null };
    meta.started = new Promise((res) => { meta.resolveStarted = res; });
    reg.set(job.id, job); this._jobMeta.set(job.id, meta);
    // memory bound: the oldest FINISHED jobs leave the registry (their history stays on the orchestrator session)
    if (reg.size > REGISTRY_KEEP) for (const [id, j] of reg) { if (reg.size <= REGISTRY_KEEP) break; if (TERMINAL.has(j.status)) { reg.delete(id); this._jobMeta.delete(id); } }
    return meta;
  },
  _publicJob(job) { return { ...job, editedFiles: (job.editedFiles || []).map((f) => ({ ...f })), agentsLive: this._agentsLiveCopy(job) }; },
  // agentsLive as it travels: the counts and the live list (n · status · description · progress · lastTool).
  _agentsLiveCopy(job) {
    const a = job.agentsLive || { running: 0, total: 0 };
    return { running: a.running || 0, total: a.total || 0, list: Array.isArray(a.list) ? a.list.map((x) => ({ ...x })) : [] };
  },
  /* A child job's sub-agent registry changed (session/subagents.js agentEmit): the job carries the
   * live picture — how many run, and which (number, status, brief, what each is doing) — so the
   * studio shows every role's agents WITHOUT that child's tab being open (before, agentsLive was
   * filled only when the job ended; the canvas saw nothing while agents worked, 2026-09-17).
   * Bursts are coalesced: one card patch + one workflow:job event per 250 ms per job. */
  jobAgentsChanged(session) {
    const job = this.liveJobOf(session);
    if (!job) return null;
    const sum = A.summary(session);
    job.agentsLive = { running: sum.running, total: sum.total, list: A.live(session).slice(0, 20).map((a) => ({ n: a.n, status: a.status, description: a.description || "", progress: a.progress || "", lastTool: a.lastTool || "", toolUses: a.toolUses || 0 })) };
    const meta = this._jobMeta.get(job.id);
    if (!meta) return job;
    if (!meta.agentsTimer) {
      meta.agentsTimer = setTimeout(() => { meta.agentsTimer = null; if (TERMINAL.has(job.status)) return; this._jobCardPatch(job); this._jobEmit(job); }, 250);
      if (meta.agentsTimer.unref) meta.agentsTimer.unref();
    }
    return job;
  },
  // The live job whose child session this is (null once it finished, or for any other session).
  liveJobOf(session, jobId) {
    if (!session || !this._jobs) return null;
    const job = this._jobs.get(jobId || session.jobId);
    return job && job.kind === "role" && job.sessionId === session.id && !TERMINAL.has(job.status) ? job : null;
  },
  jobInfo(jobId) { const j = this._jobs && this._jobs.get(jobId); return j ? this._publicJob(j) : null; },
  allJobs() { return [...this._jobRegistry().values()].map((j) => this._publicJob(j)).sort((a, b) => String(a.startedTs).localeCompare(String(b.startedTs))); },
  // An orchestrator's jobs: the live registry first, plus the persisted history of jobs an earlier app
  // process ran (one that was still live when the app closed is reported as stopped).
  jobsFor(parentId) {
    const live = [...this._jobRegistry().values()].filter((j) => j.parentId === parentId);
    const seen = new Set(live.map((j) => j.id));
    const parent = store.getSession(parentId);
    const hist = (parent && Array.isArray(parent.workflowJobs) ? parent.workflowJobs : []).filter((j) => j && j.id && !seen.has(j.id))
      .map((j) => (TERMINAL.has(j.status) ? { ...j } : { ...j, status: "stopped", error: j.error || "AtomNano was restarted before this job finished." }));
    return [...hist, ...live.map((j) => this._publicJob(j))].sort((a, b) => String(a.startedTs).localeCompare(String(b.startedTs)));
  },

  /* ------------------------------ jobs: events + cards ------------------------------ */
  workflowStage(sessionId, stage, status, info) {
    const i = info || {};
    this.send("workflow:stage", { sessionId, stage, status, jobId: i.id || i.jobId || undefined, provider: i.provider || "", model: i.model || "" });
  },
  // The card's meta — always the WHOLE object (the renderer applies a pending patch with Object.assign on m.meta).
  _jobCardMeta(job) {
    return { kind: job.kind, provider: job.provider, model: job.model, effort: job.effort, access: job.access, agents: job.agents, sessionId: job.sessionId, status: job.status, startedTs: job.startedTs, endedTs: job.endedTs, durationMs: job.durationMs, result: job.result, editedFiles: (job.editedFiles || []).map((f) => ({ ...f })), error: job.error, agentsLive: this._agentsLiveCopy(job), tokensIn: job.tokensIn, tokensOut: job.tokensOut, exitCode: job.exitCode, command: job.command, from: job.from, fromJob: job.fromJob || null, paused: job.paused || null, taskId: job.taskId || null, taskN: job.taskN || null, reused: !!job.reused, skills: Array.isArray(job.skills) ? job.skills.slice() : [] };
  },
  // The `role: "job"` card in the ORCHESTRATOR's chat (app-side, not part of the model-visible record).
  _jobCard(parent, job) {
    const meta = this._jobMeta.get(job.id);
    const card = { id: store.uid(), role: "job", jobId: job.id, jobRole: job.role, kind: job.kind, text: job.kind === "command" ? job.command : job.task, ts: store.nowISO(), meta: this._jobCardMeta(job) };
    this.addMessage(parent, card);
    if (meta) meta.cardId = card.id;
    return card;
  },
  _jobCardPatch(job) {
    const meta = this._jobMeta.get(job.id);
    const parent = meta && meta.cardId ? store.getSession(job.parentId) : null;
    if (parent) this.updateMessage(parent, meta.cardId, { meta: this._jobCardMeta(job) });
  },
  // Mirror the job onto the orchestrator session (bounded history) and broadcast it.
  _jobEmit(job) {
    const parent = store.getSession(job.parentId);
    if (parent) {
      if (!Array.isArray(parent.workflowJobs)) parent.workflowJobs = [];
      const copy = this._publicJob(job);
      const i = parent.workflowJobs.findIndex((j) => j && j.id === job.id);
      if (i >= 0) parent.workflowJobs[i] = copy; else parent.workflowJobs.push(copy);
      if (parent.workflowJobs.length > JOB_HISTORY) parent.workflowJobs.splice(0, parent.workflowJobs.length - JOB_HISTORY);
      store.scheduleWrite(parent.id);
    }
    this.send("workflow:job", { job: this._publicJob(job) });
  },

  /* ------------------------------ jobs: lifecycle ------------------------------ */
  // run() dispatched a turn for a job's child session: queued → running (a replay of a paused turn is already running).
  jobRunStarted(session, jobId) {
    const job = this.liveJobOf(session, jobId);
    if (!job) return null;
    const meta = this._jobMeta.get(job.id);
    if (job.paused) delete job.paused;
    if (job.status === "queued") {
      job.status = "running"; job.startedTs = store.nowISO();
      this._jobCardPatch(job); this._jobEmit(job); this.workflowStage(job.parentId, job.role, "running", job);
    } else this._jobEmit(job);
    if (meta && meta.resolveStarted) { meta.resolveStarted(); meta.resolveStarted = null; }
    return job;
  },
  // finalizeRun's hook (index.js): the run of a job's child ended, or an orchestrator turn ended.
  workflowRunEnded(session, runner, term) {
    const job = this.liveJobOf(session);
    if (job) this._jobEnd(job, term);
    if (session && session._wfPrimary && !session.role) this.workflowStage(session.id, PRIMARY, term, { provider: (runner && runner.provider) || session.lastProvider || "", model: (runner && runner.model) || session.model || "" });
  },
  // The child's run() promise resolved: a terminal child ends the job; a PAUSED child (its turn is
  // preserved and replays by itself) keeps the job live until that replay finalises or it is stopped.
  _jobSettle(job) {
    if (TERMINAL.has(job.status)) return;
    const child = store.getSession(job.sessionId);
    const st = child ? child.status : "error";
    if (st === "done") this._jobEnd(job, "done");
    else if (st === "error") this._jobEnd(job, "error");
    else if (PAUSED.has(st)) { job.paused = st; this._jobCardPatch(job); this._jobEmit(job); }
    else this._jobEnd(job, "stopped");
  },
  // ONE terminal transition per job: done | error | stopped.
  _jobEnd(job, status, extra) {
    if (TERMINAL.has(job.status)) return false;
    const meta = this._jobMeta.get(job.id) || {};
    const ex = extra || {};
    job.status = TERMINAL.has(status) ? status : "error";
    job.endedTs = store.nowISO();
    job.durationMs = Math.max(0, Date.now() - (Date.parse(job.startedTs) || Date.now()));
    delete job.paused;
    if (job.kind === "role") {
      const child = store.getSession(job.sessionId);
      if (child) {
        job.result = this.lastAssistantText(child);
        job.editedFiles = (child.editedFiles || []).map((f) => ({ path: f.path, count: f.count || 0, added: f.added || 0, removed: f.removed || 0 }));
        job.tokensIn = +child.totalTokensIn || 0; job.tokensOut = +child.totalTokensOut || 0;
        try { const sum = A.summary(child); job.agentsLive = { running: sum.running, total: sum.total, list: [] }; } catch { /* registry optional */ }
        if (job.status === "error" && !ex.error) { const e = [...child.messages].reverse().find((m) => m && m.role === "error" && m.text); job.error = e ? String(e.text) : "The job failed."; }
      } else if (job.status === "error" && !ex.error) job.error = "The job's session no longer exists.";
    }
    if (meta.timer) { clearTimeout(meta.timer); meta.timer = null; }
    if (meta.agentsTimer) { clearTimeout(meta.agentsTimer); meta.agentsTimer = null; }
    for (const k of Object.keys(ex)) if (ex[k] !== undefined) job[k] = ex[k];
    if (job.status !== "error" && !ex.error) job.error = "";
    this._jobCardPatch(job); this._jobEmit(job); this.workflowStage(job.parentId, job.role, job.status, job);
    // the board task this job worked on gets the outcome as a note (its status is left to the orchestrator)
    if (job.taskId && this._taskJobEnded) { try { this._taskJobEnded(job); } catch (e) { console.warn("[tasks]", (e && e.message) || e); } }
    const waiters = meta.waiters || []; meta.waiters = [];
    for (const w of waiters) { try { w(); } catch { /* a waiter's error is not ours */ } }
    if (meta.resolveStarted) { meta.resolveStarted(); meta.resolveStarted = null; }   // a run that ended before it ever started
    return true;
  },

  /* --from <job id> (2026-09-18): the finished job whose SAVED result is handed to the next role. Resolved
   * through jobsFor — the live registry and the persisted history alike — and restricted to THIS
   * orchestrator's jobs. Refused: a blank id, an id that is not among this session's jobs (unknown, pruned
   * from the kept history, or another orchestrator's), and a job that has not ended. Accepted: done, error
   * and stopped (the block's label names an unsuccessful end). Returns the job copy jobsFor serves. */
  _sourceJob(parent, fromJob) {
    const id = String(fromJob == null ? "" : fromJob).trim();
    if (!id) throw new Error("--from needs the id of a finished job of this session (atomnano jobs lists them).");
    const src = this.jobsFor(parent.id).find((j) => j && j.id === id);
    if (!src) {
      const other = this._jobRegistry().get(id);
      if (other && other.parentId !== parent.id) throw new Error(`Job ${id} belongs to another orchestrator session — --from takes a job of this session (atomnano jobs lists them).`);
      throw new Error(`No job ${id} among this session's jobs — --from takes the id of a finished job of this orchestrator (atomnano jobs lists them; jobs older than the kept history are gone).`);
    }
    if (!TERMINAL.has(src.status)) throw new Error(`Job ${id} is still ${src.status} — wait for it (atomnano wait ${id} --timeout 540) before handing its result on.`);
    return src;
  },
  /* The handoff block, appended ONCE right after the task text:
   *   Result of planner job job-123 (the plan):
   *   <saved result>
   * A Planner source is "the plan", a Reviewer source "the review findings", anything else "the result"; an
   * error / stopped source says so (with its error text); an empty saved result reads "(empty result)". The
   * text is the saved `job.result` verbatim — no JSON or log expansion, no truncation. */
  _sourceBlock(src) {
    const what = src.role === "planner" ? "the plan" : src.role === "reviewer" ? "the review findings" : "the result";
    const who = src.kind === "command" ? "command" : (src.role || "role");
    const err = src.error ? String(src.error).trim() : "";
    const end = src.status === "done" ? "" : ` — the job ${src.status === "error" ? "ended in error" : "was stopped"}${err ? ": " + err : ""}`;
    const text = src.result == null ? "" : String(src.result);
    return `\n\nResult of ${who} job ${src.id} (${what}${end}):\n${text.trim() ? text.replace(/\s+$/, "") : "(empty result)"}`;
  },

  /* Start a ROLE job: a child session with the role's provider · model · effort · access, run
   * through the ordinary run() path. Resolves once the child's run has STARTED (or already ended);
   * rejects with a plain Error for a missing parent, an unknown / disabled role, an empty task, an
   * unknown board task, an unusable --from source, or a run() that refused to start.
   * TASK BOARD (contract §8): `taskRef` (also read as ref / taskId / taskN) names the board task this job
   * works on — the job is linked to it before the run starts and the child receives the task as a
   * labelled line after its task text; a description that is nothing but a reference ("T3") means that
   * task itself (its title becomes the description).
   * SOURCE JOB: `fromJob` (CLI --from, server body `from`, IPC `fromJob`) appends that finished job's saved
   * result after the task text (see _sourceBlock); `from` stays the "cli" | "ui" provenance.
   * The child's prompt order: task → source result → board task line → files of interest → --context block. */
  async startRoleJob(parentId, { role, task, files = [], agents, from = "ui", fromJob, taskRef, ref, taskId, taskN, context = false, fresh = false } = {}) {
    const parent = store.getSession(parentId);
    if (!parent) throw new Error("The orchestrator session was not found.");
    const want = String(role || "").trim().toLowerCase();
    if (want === PRIMARY || want === "primary") throw new Error("The orchestrator is the calling session — delegate to planner, coder, reviewer or tester.");
    const r = ROLE_ALIAS[want];
    if (!r) throw new Error(`Unknown role "${role}". Roles you can run: planner, coder, reviewer, tester.`);
    const wf = this.workflowFor(parent);
    // Workflow OFF means SOLO (user decision 2026-09-17): no role jobs — the orchestrator brief is not in
    // force and the user did not ask for reviewers or testers. Jobs used to start regardless.
    if (!wf.enabled) throw new Error(`The workflow is off — this conversation runs solo. Turn "${wf.name}" on in the Workflow studio to delegate to the ${cap(r)}.`);
    const rc = wf.roles[r];
    if (!rc.enabled) throw new Error(`The ${cap(r)} role is disabled in the active workflow ("${wf.name}").`);
    task = String(task || "").trim();
    // resolved BEFORE the child session exists, so an unknown reference refuses the job cleanly
    const wanted = [taskRef, ref, taskId, taskN].find((v) => v !== undefined && v !== null && v !== "");
    let taskItem = null;
    if (wanted !== undefined) { taskItem = this.taskInfo(parent.id, wanted); if (!taskItem) throw new Error(`No task "${wanted}" on this board.`); }
    else if (isBareRef(task)) taskItem = this.taskInfo(parent.id, task);
    if (taskItem && (!task || isBareRef(task))) task = taskItem.title;
    if (!task) throw new Error("A task description is required.");
    // --from: resolved and refused HERE — before the child session, the pool, the registry, the card or the task link.
    const source = fromJob === undefined || fromJob === null ? null : this._sourceJob(parent, fromJob);
    const provider = rc.provider || "anthropic";
    let pcat = {}; try { pcat = providers.get(provider) || {}; } catch { /* catalog optional */ }
    const settings = store.getSettings(parent.cwd);
    const firstEndpoint = () => { const eps = Array.isArray(settings.customEndpoints) ? settings.customEndpoints : []; return eps.length && eps[0] && eps[0].id ? eps[0].id : ""; };
    const model = rc.model || pcat.defaultModel || (provider === "custom" ? firstEndpoint() : "") || parent.model || settings.defaultModel || "";
    const thinking = rc.effort || pcat.defaultReasoning || settings.defaultThinking || parent.thinking || "";
    const permissionMode = this.accessToPermission(rc.access, provider);
    // The role's own lane (every worker role has one), or the orchestrator's --agents N for this job.
    const lane = agents === undefined || agents === null || agents === "" ? (rc.agents || 0) : clampLane(agents, 0);
    // The skills attached to the role (Planner / Coder / Reviewer) in the Workflow Studio — the ONLY way a skill
    // reaches a session (2026-09-18): they become the child's selectedSkills, and the providers deliver their
    // procedures to this role child (a plain chat's selectedSkills have no effect).
    const skillIds = SKILL_ROLES.includes(r) && Array.isArray(rc.skills) ? rc.skills.filter((s) => typeof s === "string" && s) : [];
    const fileList = (Array.isArray(files) ? files : String(files || "").split(",")).map((f) => String(f || "").trim()).filter(Boolean);
    const jobId = "job-" + store.uid();
    const name = "⚙ " + cap(r) + " · " + shortText(task, 48);
    // ONE session per role per orchestrator (user decision 2026-09-17): the next task for a role runs in
    // that role's existing session, so its native thread resumes and it remembers the earlier tasks. A role
    // whose session is busy with another job gets a second one; `fresh` (CLI --fresh) forces a new session.
    let child = null, reused = false;
    const pool = this._roleSessionPool(parent, r);
    if (!fresh) for (const id of pool) { const s = store.getSession(id); if (s && s.role === r && s.parentId === parent.id && !this.isRunning(id) && !this._liveJobOnSession(id)) { child = s; reused = true; break; } }
    if (child) { store.updateSession(child.id, { name, model, permissionMode, thinking, oneM: !!parent.oneM, provider, jobId, selectedSkills: skillIds.slice() }); child = store.getSession(child.id); }
    else {
      const view = store.createSession({ cwd: parent.cwd, name, model, permissionMode, thinking, oneM: !!parent.oneM, parentId: parent.id, role: r, provider, jobId, selectedSkills: skillIds.slice() });
      child = store.getSession(view.id);
      if (!child) throw new Error("The job's session could not be created.");
      pool.push(child.id); if (pool.length > 20) pool.splice(0, pool.length - 20);
      store.scheduleWrite(parent.id);
    }
    const job = {
      id: jobId, kind: "role", role: r, parentId: parent.id, sessionId: child.id, task, command: "",
      status: "queued", startedTs: store.nowISO(), endedTs: null, durationMs: 0,
      provider, model, effort: thinking, access: rc.access, agents: lane, result: "", exitCode: null,
      editedFiles: [], tokensIn: 0, tokensOut: 0, agentsLive: { running: 0, total: 0, list: [] }, from: from === "cli" ? "cli" : "ui", error: "",
      taskId: null, taskN: null,   // the board task (contract §8), set by linkJobToTask
      context: !!context,          // the orchestrator's conversation travels with the task (--context)
      reused,                      // the role's existing session continues (its native thread resumes)
      skills: skillIds.slice(),    // the role's attached skills this job runs with (ids)
      fromJob: source ? source.id : null,   // the finished job whose saved result was appended to the task (--from)
    };
    const meta = this._jobRegister(job);
    if (taskItem) this.linkJobToTask(job, taskItem.id);
    // autoOpen: whether the renderer opens the child's tab (opt-in — off, the job runs in the background and its card / the studio open the tab on demand).
    this.send("session:created", { view: store.getSessionView(child.id), parentId: parent.id, role: r, jobId, autoOpen: wf.openJobTabs === true, reused });
    this._jobCard(parent, job);
    this._jobEmit(job);
    // the board task as labelled data right after the task text: Task T3 of set "<title>": <title> — <detail>
    const taskLine = taskItem ? `\n\nTask T${taskItem.n} of set "${((this.boardFor(parent).sets.find((s) => s.id === taskItem.setId)) || {}).title || ""}": ${taskItem.title}${taskItem.detail ? " — " + taskItem.detail : ""}` : "";
    // --context: the orchestrator's conversation so far, CONDENSED exactly like a synthesized handoff
    // (summary of the oldest entries — cached checkpoints reused —, the newest verbatim, the
    // session map and the task board), as labelled data after the task. Only when asked for.
    let contextBlock = "";
    if (context) {
      try {
        const seed = await this.synthesizeSeed(parent, provider, { model });
        if (seed && seed.text) contextBlock = "\n\nContext from the orchestrator session — the conversation the orchestrator has had with the user so far, condensed by AtomNano (the complete record stays in the orchestrator's session):\n\n" + seed.text;
      } catch (e) { contextBlock = `\n\n[The orchestrator asked to include its conversation as context, but it could not be condensed: ${String((e && e.message) || e)}]`; }
    }
    // task → the source job's saved result (--from) → the board task line → files of interest → the --context block
    const text = task + (source ? this._sourceBlock(source) : "") + taskLine + (fileList.length ? "\n\nFiles of interest (named by the orchestrator):\n" + fileList.map((f) => "- " + f).join("\n") : "") + contextBlock;
    const brief = this.roleBrief(r, { ...wf, roles: { ...wf.roles, [r]: { ...rc, agents: lane } } });
    // The lane applies on EVERY provider (Claude: the Task tool + its cap; Codex: multi-agent + its cap).
    const runP = this.run(child.id, { text, provider, model, permissionMode, thinking, subAgents: lane > 0, subAgentsMax: lane > 0 ? lane : undefined, roleBrief: brief, workflowJob: jobId });
    const settled = runP.then(() => this._jobSettle(job), (err) => { this._jobEnd(job, "error", { error: String((err && err.message) || err) }); throw err; });
    settled.catch(() => {});   // delivered through the race below (or as the job's error state)
    await Promise.race([meta.started, settled]);
    return this._publicJob(job);
  },

  // Resolves when the job is terminal, or with its current state when the timeout passes.
  async waitJob(jobId, timeoutMs) {
    const job = this._jobRegistry().get(jobId);
    if (!job) throw new Error(`No job "${jobId}".`);
    if (TERMINAL.has(job.status)) return this._publicJob(job);
    const ms = timeoutMs === undefined || timeoutMs === null ? 600000 : Math.max(0, Math.min(+timeoutMs || 0, 24 * 3600 * 1000));
    const meta = this._jobMeta.get(job.id);
    await new Promise((res) => {
      const wake = () => { clearTimeout(t); res(); };
      const t = setTimeout(() => { meta.waiters = meta.waiters.filter((w) => w !== wake); res(); }, ms);
      meta.waiters.push(wake);
    });
    return this._publicJob(job);
  },

  async stopJob(jobId) {
    const job = this._jobRegistry().get(jobId);
    if (!job) return { ok: false, detail: `No job "${jobId}".` };
    if (TERMINAL.has(job.status)) return { ok: true, detail: `Job ${jobId} is already ${job.status}.` };
    if (job.kind === "command") {
      const meta = this._jobMeta.get(job.id);
      this._killCommand(job);
      this._jobEnd(job, "stopped", { result: meta && meta.output ? meta.output() : job.result });
      return { ok: true };
    }
    try { await this.interrupt(job.sessionId, "stop"); } catch (e) { return { ok: false, detail: String((e && e.message) || e) }; }
    if (!TERMINAL.has(job.status)) this._jobEnd(job, "stopped");   // the child had no live run (queued / paused) — nothing else finalises it
    return { ok: true };
  },

  /* Stop every live job of an orchestrator session — an EXPLICIT action (the studio's "Stop all jobs",
   * `atomnano stop --all`, workflow:stopAll). Stop on the orchestrator's own turn no longer cascades here
   * (user decision 2026-09-17): the roles and their sub-agents keep their state and keep running. */
  stopJobsOf(parentId) {
    const live = [...this._jobRegistry().values()].filter((j) => j.parentId === parentId && !TERMINAL.has(j.status));
    for (const j of live) this.stopJob(j.id).catch(() => {});
    return live.length;
  },
  liveJobCount(parentId) { let n = 0; for (const j of this._jobRegistry().values()) if (j.parentId === parentId && !TERMINAL.has(j.status)) n++; return n; },
  _liveJobOnSession(sessionId) { for (const j of this._jobRegistry().values()) if (j.sessionId === sessionId && !TERMINAL.has(j.status)) return j; return null; },
  // The orchestrator's persistent sessions for a role: roleSessions.<role> = [ids], oldest first (persisted by normalizeSession).
  _roleSessionPool(parent, role) {
    if (!parent.roleSessions || typeof parent.roleSessions !== "object" || Array.isArray(parent.roleSessions)) parent.roleSessions = {};
    if (!Array.isArray(parent.roleSessions[role])) parent.roleSessions[role] = [];
    return parent.roleSessions[role];
  },

  // The child's recent record entries as text (a command job: the last lines of its output).
  jobLog(jobId, { tail = 40 } = {}) {
    const job = this._jobRegistry().get(jobId);
    if (!job) throw new Error(`No job "${jobId}".`);
    const n = Math.max(1, Math.min(1000, Math.floor(+tail) || 40));
    if (job.kind === "command") {
      const meta = this._jobMeta.get(job.id);
      const lines = String(job.result || (meta && meta.output ? meta.output() : "")).split(/\r?\n/);
      return lines.slice(-n).join("\n");
    }
    const child = store.getSession(job.sessionId);
    if (!child) return "";
    const entries = child.messages.filter((m) => m && m.role !== "thinking" && m.role !== "result" && (m.role === "tool" || (typeof m.text === "string" && m.text)));
    return entries.slice(-n).map((m) => history.entryText(m)).join("\n\n---\n\n");
  },

  /* A COMMAND job: the shell command runs in the project folder (platform.shellCommand — cmd.exe on
   * Windows, a login shell elsewhere), stdout + stderr are captured (bounded), the exit code decides
   * done / error. Resolves once the process is running. */
  async runCommandJob(parentId, { command, timeoutMs = 600000, from = "cli", taskRef } = {}) {
    const parent = store.getSession(parentId);
    if (!parent) throw new Error("The orchestrator session was not found.");
    const wf = this.workflowFor(parent);
    if (!wf.enabled) throw new Error(`The workflow is off — this conversation runs solo. Turn "${wf.name}" on in the Workflow studio to run test jobs.`);
    command = String(command || "").trim() || wf.roles.tester.command;
    if (!command) throw new Error("No command given, and the Tester role has no configured test command.");
    // optional board task (contract §8): `atomnano test --cmd "…" --task T3` links the test run to the task
    const taskItem = taskRef !== undefined && taskRef !== null && taskRef !== "" ? this.taskInfo(parent.id, taskRef) : null;
    if (taskRef !== undefined && taskRef !== null && taskRef !== "" && !taskItem) throw new Error(`No task "${taskRef}" on this board.`);
    const platform = require("../platform");
    const spec = platform.shellCommand(command);
    // cmd.exe: the line goes through verbatim as Node's own `shell: true` does (`/d /s /c "<line>"`) —
    // per-argument re-quoting would mangle the quotes inside the command.
    const viaCmd = /cmd(\.exe)?$/i.test(String(spec.file || ""));
    const args = viaCmd ? ["/d", "/s", "/c", `"${command}"`] : spec.args;
    const job = {
      id: "job-" + store.uid(), kind: "command", role: "tester", parentId: parent.id, sessionId: null, task: command, command,
      status: "running", startedTs: store.nowISO(), endedTs: null, durationMs: 0,
      provider: "", model: "", effort: "", access: "", agents: 0, result: "", exitCode: null,
      editedFiles: [], tokensIn: 0, tokensOut: 0, agentsLive: { running: 0, total: 0 }, from: from === "ui" ? "ui" : "cli", error: "",
      taskId: null, taskN: null, fromJob: null,   // a command runs a command — no role to hand a result to
    };
    const meta = this._jobRegister(job);
    if (taskItem) this.linkJobToTask(job, taskItem.id);
    const buf = outputBuffer(COMMAND_OUTPUT_MAX);
    meta.output = () => buf.text();
    this._jobCard(parent, job); this._jobEmit(job); this.workflowStage(parent.id, "tester", "running", job);
    const finish = (status, extra) => { if (!TERMINAL.has(job.status)) this._jobEnd(job, status, { result: buf.text(), ...(extra || {}) }); };
    let child;
    // The app's env (the control server's ATOMNANO_CONTROL / ATOMNANO_TOKEN / PATH) plus this orchestrator's id.
    try { child = spawn(spec.file, args, { cwd: parent.cwd, env: { ...process.env, ATOMNANO_SESSION: parent.id }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(viaCmd ? { windowsVerbatimArguments: true } : {}) }); }
    catch (e) { finish("error", { error: `The command could not be started: ${(e && e.message) || e}` }); return this._publicJob(job); }
    meta.child = child;
    if (child.stdout) child.stdout.on("data", (d) => buf.push(d));
    if (child.stderr) child.stderr.on("data", (d) => buf.push(d));
    child.on("error", (e) => finish("error", { error: `The command could not be started: ${(e && e.message) || e}` }));
    child.on("close", (code, signal) => { if (TERMINAL.has(job.status)) return; finish(code === 0 ? "done" : "error", { exitCode: code, error: code === 0 ? "" : `Exit code ${code}${signal ? ` (signal ${signal})` : ""}.` }); });
    const ms = Math.max(100, Math.min(+timeoutMs || 600000, 24 * 3600 * 1000));
    meta.timer = setTimeout(() => { if (TERMINAL.has(job.status)) return; this._killCommand(job); finish("error", { error: `Timed out after ${Math.round(ms / 1000)} s — the command was ended.` }); }, ms);
    if (meta.timer.unref) meta.timer.unref();
    if (meta.resolveStarted) { meta.resolveStarted(); meta.resolveStarted = null; }
    return this._publicJob(job);
  },
  _killCommand(job) {
    const meta = this._jobMeta.get(job.id);
    const child = meta && meta.child;
    if (!child || child.exitCode !== null || child.signalCode) return;
    try {
      const platform = require("../platform");
      if (typeof platform.killTree === "function" && child.pid) platform.killTree(child.pid);
      else child.kill();
    } catch { try { child.kill(); } catch { /* already gone */ } }
  },
};

module.exports = { methods, resolveWorkflow, migrateLegacyPrimary, laneOf, TERMINAL, ROLES, WORKERS, PRIMARY, SKILL_ROLES };
