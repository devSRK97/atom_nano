# Workflow (orchestrator-as-primary) — shared contract

Built 2026-09-16 by four parallel workers; the Orchestrator was added above the Planner on
2026-09-17 (§10). This file is the ONE agreed interface between the parts; each worker implements its
side against it and must not change a signature without updating this file. Terminology: a
**workflow** assigns a model (provider · model · effort · access) to each **role** — the Orchestrator
and its workers Planner, Coder, Reviewer, Tester — and configures a sub-agent lane per worker role.
The **Orchestrator is the primary**: it is the model the user chats with; it manages, orchestrates and
monitors the other roles by calling the `atomnano` CLI (Bash tool), which talks to the running app's
local **control server**. Each delegated piece of work is a **job**: a child session run with the
role's own model/provider/effort/access, visible as its own tab. (Before §10 the Planner was the
primary; the text below reads "orchestrator" wherever it used to read "planner" in that sense.)

## 1. Settings (`src/main/storage/store.js` DEFAULT_SETTINGS)

```js
workflow: {                       // the ACTIVE workflow — per-project overridable like other agent settings
  enabled: false,
  name: "Solo",                   // display name (matches the library entry it was loaded from, or "Custom")
  savedId: null,                  // library entry id it was loaded from (null = ad hoc / unsaved edits)
  roles: {
    orchestrator: { provider: "", model: "", effort: "", access: "bypassPermissions" },          // the PRIMARY; "" = follow the composer's picks
    planner:  { enabled: true, provider: "anthropic", model: "", effort: "high",   access: "read", agents: 0, skills: [] },    // drafts the plan the orchestrator decides on (read-only); skills = ids of this project's AtomNano skills every job runs with (§10)
    coder:    { enabled: true, provider: "anthropic", model: "", effort: "high",   access: "bypassPermissions", agents: 3, skills: [] },   // agents 0 = solo, 1–20 = sub-agent lane (any provider)
    reviewer: { enabled: true, provider: "openai",    model: "", effort: "medium", access: "read", agents: 0, skills: [] },
    tester:   { enabled: true, provider: "anthropic", model: "", effort: "medium", access: "bypassPermissions", agents: 0, command: "" }, // command "" = the project's test command / let the tester decide
  },
  layout: {},                     // canvas node positions { orchestrator: {x,y}, planner: {x,y}, coder: {x,y}, reviewer: {x,y}, tester: {x,y} } (px)
  brief: "",                      // optional override of the GENERATED orchestrator brief (empty = generated)
  openJobTabs: false,             // open a tab for every role job in the orchestrator's window (never steals focus). OFF by default: jobs run in the background (§10)
},
workflows: [],                    // the LIBRARY (GLOBAL_ONLY): [{ id, name, createdAt, updatedAt, workflow: { roles, layout, brief, openJobTabs } }]
```

Access values: `"bypassPermissions"` (Full access, DEFAULT) · `"acceptEdits"` · `"default"` (Ask) · `"read"`
(read-only). Mapping to a run: Anthropic `permissionMode` = access, except `read` → `"plan"`;
OpenAI/Codex: the runner already maps `session.permissionMode` (read/plan → read-only sandbox).

Provider values: `"anthropic" | "openai" | "custom"`; `""` on the orchestrator = the composer's provider.
Effort values: the provider's ladder (`state.providerCatalog[provider].reasoningLevels`), `""` = default.

Import/export file format (JSON): `{ "atomnanoWorkflow": 1, "name": "…", "workflow": { roles, layout, brief, openJobTabs } }`.

## 2. Session fields (store) — child sessions

`createSession({ …, parentId, role, provider, jobId })` persists and `normalizeSession` keeps:
`parentId` (string|null), `role` (`"planner"|"coder"|"reviewer"|"tester"`|null), `provider` (string|null — the
provider this session runs on; null = settings), `jobId` (string|null). `metaOf` and `getSessionView`
include `parentId`, `role`, `provider`, `jobId`.

## 3. SessionManager methods (mixin `src/main/session/workflow.js`, assembled by `session/index.js`)

```js
workflowFor(sessionOrCwd, settings?)      → resolved active workflow with defaults filled (never throws)
accessToPermission(access, provider)     → permissionMode string
orchestratorBrief(session, wf, provider) → string   // generated text (wf.brief override wins); includes the roles table, the CLI usage and "Your session id is <id>". plannerBrief = its pre-§10 alias.
roleBrief(role, wf)                      → string   // short brief for a child job (planner / coder / reviewer / tester)
async startRoleJob(parentId, { role, task, files = [], agents, from = "ui", fromJob, taskRef, context = false, fresh = false }) → job
   // resolves once the child session is created and its run STARTED (rejects with a plain Error for a disabled/unknown role, the orchestrator itself, a missing parent,
   // an unknown taskRef, or an unusable fromJob — §10 "Source-job handoff"). `from` is the "cli" | "ui" provenance; `fromJob` is the id of a FINISHED job of this
   // orchestrator whose saved result is appended to the task. The child's first prompt: task → source result → board task line → files of interest → --context block.
jobInfo(jobId) → job|null ;  jobsFor(parentId) → job[] ;  allJobs() → job[]
async waitJob(jobId, timeoutMs) → job    // resolves when terminal or when the timeout passes (current state)
async stopJob(jobId) → { ok, detail? }
jobLog(jobId, { tail = 40 } = {}) → string   // recent record entries of the child session as text (history.entryText)
async runCommandJob(parentId, { command, timeoutMs = 600000 }) → job   // kind "command": runs the shell command in the project cwd (platform.shellCommand), captures stdout+stderr (bounded 200 KB), exit code → done/error
stopJobsOf(parentId)                     // stop every live job of a planner session (called when the planner is stopped)
```

Job shape (also what `workflow:job` events carry):
```js
{ id, kind: "role"|"command", role, parentId, sessionId /* child session, null for command */, task, command,
  status: "queued"|"running"|"done"|"error"|"stopped", startedTs, endedTs, durationMs,
  provider, model, effort, access, agents, result: "" /* child's final assistant text, or command output */,
  exitCode, editedFiles: [{ path, count, added, removed }], tokensIn, tokensOut,
  agentsLive: { running, total, list } /* sub-agents of the child session (§9) */, from: "cli"|"ui", error: "",
  taskId, taskN /* §8 */, context: bool /* §8.5 */, reused: bool /* §9 */, skills: [ids] /* §10 */,
  fromJob: null | "job-…" /* §10 — the finished job whose saved result was appended to the task */ }
```
The job object is mirrored whole onto `session.workflowJobs` (bounded to 100, `store.js`), so every field above — `fromJob` included — persists without a store change; the `role: "job"` card meta carries the same fields.

Primary run (`run()` in `session/index.js`): accepts `provider` (override of `settings.llmProvider`) and
`roleBrief`. When the active workflow is enabled and the session is not itself a child (`!session.role`)
and the run is not background/fleet: the run becomes the ORCHESTRATOR — provider/model/effort/access from
`wf.roles.orchestrator` (empty = keep the composer's), `roleBrief = orchestratorBrief(...)`, the legacy
`planner` param is ignored. Anthropic appends the brief to the system prompt (`systemPrompt.append`); OpenAI /
custom carry it in the prompt appendix (labelled). The Anthropic CLI env gets `ATOMNANO_SESSION=<id>`.

Events (via `this.send`): `workflow:job` `{ job }` on every job change · `workflow:stage`
`{ sessionId, stage: "orchestrator"|"planner"|"coder"|"reviewer"|"tester", status: "running"|"done"|"error"|"stopped", jobId? , provider, model }` ·
`session:created` `{ view, parentId, role }` when a child session is created.

## 4. Control server (`src/main/control/server.js`) — how the CLI reaches the app

Plain Node `http` on `127.0.0.1`, random port, per-launch token. `start({ manager, store, version })`
→ `{ url, token, port }`; sets `process.env.ATOMNANO_CONTROL = url`, `ATOMNANO_TOKEN = token`,
`ATOMNANO_NODE = process.execPath`, prepends the app's `bin/` folder to `process.env.PATH` (every child
process — Claude CLI, Codex, terminals — inherits them) and writes `<userData>/control.json`
`{ url, token, pid, startedAt }` for CLIs launched from an outside terminal. Auth: `Authorization: Bearer <token>`
(else 401). JSON in/out. Routes (`/v1`):

```
GET  /ping                       → { ok:true, app:"atomnano", version, pid }
GET  /status?session=            → { session:{id,name,cwd,status}, workflow, jobs:[…] }
GET  /roles?session=|cwd=        → { enabled, name, roles:{…resolved…} }
GET  /sessions                   → { sessions:[{id,name,cwd,status,role,parentId,updatedAt}] }
GET  /providers                  → { providers:[{id,label,authorized,defaultModel}] }
GET  /models?provider=           → { models:[{id,name}] , reasoningLevels:[…] }
POST /jobs   { session, role, task, files, agents, wait, taskRef, context, fresh, from }   → { job }
                                   (wait = seconds to long-poll for completion, 0 = return immediately, capped at 600;
                                    from = the id of a FINISHED job of this orchestrator whose saved result travels with the task —
                                    forwarded to the manager as `fromJob` while the manager's `from` stays "cli"; a blank `from` → 400,
                                    an id that is not among the session's jobs (jobsFor: live + persisted) → 404, a job that has not ended → 400)
GET  /jobs?session=              → { jobs }
GET  /jobs/:id                   → { job }
GET  /jobs/:id/wait?timeout=     → { job }   (seconds, max 600 — MAX_WAIT_S, unchanged; the CLI slices its waits into 240 s requests under it)
GET  /jobs/:id/log?tail=         → { text }
POST /jobs/:id/stop              → { ok }
POST /tests  { session, command, wait }                      → { job }  (command job)
```
`session` resolution when omitted: `ATOMNANO_SESSION` env of the caller is not visible to the server, so
the CLI sends it; the server falls back to the single session currently running as a planner, else
400 `{ error, sessions:[…] }`. Errors: `{ error: "plain sentence" }` with 4xx/5xx.

## 5. CLI (`bin/atomnano.js` → `src/cli/index.js`; plain Node, NO Electron)

Discovery order: `ATOMNANO_CONTROL` + `ATOMNANO_TOKEN` env → `control.json` in userData
(`ATOMNANO_USER_DATA`, else `%APPDATA%/atomnano` and `%APPDATA%/AtomNano`, `~/Library/Application Support/…`,
`~/.config/…`). Exit codes: 0 ok · 1 usage/other error · 2 app not running · 3 the awaited job failed/stopped.

```
atomnano status                                  app, active workflow, running jobs
atomnano roles                                   the role table (the orchestrator first — the calling session)
atomnano run <role> "<task>" [--from JOB] [--files a,b] [--agents N] [--context] [--fresh] [--wait] [--timeout s] [--session ID] [--json]   role = planner | coder | reviewer | tester
atomnano plan "<request>" … | atomnano coder "<task>" … | atomnano review "<task>" … | atomnano test ["<task>"] [--cmd "npm test"] …
atomnano jobs [--session ID] [--json]
atomnano job <id> | wait <id> [--timeout s] | result <id> | log <id> [--tail n] | stop <id> | stop --all
atomnano sessions | providers | models [-P provider]
atomnano help | version
```
`atomnano run orchestrator …` is refused: the orchestrator is the calling session.
`--json` prints the raw server object (one JSON document) — for every command, including a waited job that has not
ended. `--wait` blocks until the job is terminal and prints the result text (exit 3 on error/stopped); `--timeout s`
returns earlier with the job still running (exit 0) — the text form is ONE line, `job <id> still running[ (paused: …)]
after <elapsed> · <role> — atomnano wait <id> --timeout 540`. Default (no `--json`): short human-readable tables.
`--from JOB` (§10) sends body `from`: a blank value, a bare `--from`, and `test --cmd … --from` are usage errors
(exit 1, nothing sent) — a command job runs a command, not a role. Waiting pattern (the brief's guidance): `--wait
--timeout 540`, then `atomnano wait <id> --timeout 540` until the job ends, with the shell tool's own timeout at 600 s;
internally the CLI long-polls in `SLICE_S` = 240 s requests (HTTP timeout slice + 30 s / + 90 s for the first POST).

## 6. Preload (`window.atomnano.workflow` + events)

```js
// sessionId (§10, per-session workflows): the call reads / writes THAT tab's own workflow; without it the project's
// active workflow — of `cwd` when given (the renderer's CAPTURED project; the library calls take it as their trailing
// argument, 2026-09-18 round 4), else of the calling window's current project. With a sessionId the cwd is ignored:
// the project is the session's own. `scope` in a reply says which one answered ("session" | "project").
workflow: {
  get: (cwd, sessionId) => invoke("workflow:get", cwd, sessionId),                          // { active, scope, library, control:{ url, running, binDir } }
  set: (patch, cwd, sessionId) => invoke("workflow:set", patch, cwd, sessionId),            // deep-merge patch into the active workflow → { active, scope }
  clearSession: (sessionId) => invoke("workflow:clear", sessionId),                          // drop the tab's own workflow → the project's → { active, scope:"project" }
  save: (name, id, sessionId, cwd) => invoke("workflow:save", name, id, sessionId, cwd),     // active → library entry (new, or overwrite id) → { library, active, entry, scope }
  load: (id, sessionId, cwd) => invoke("workflow:load", id, sessionId, cwd),                 // library entry → active → { active, scope }
  remove: (id, sessionId, cwd) => invoke("workflow:delete", id, sessionId, cwd),             // → { library, active }
  rename: (id, name, sessionId, cwd) => invoke("workflow:rename", id, name, sessionId, cwd), // → { library, active }
  duplicate: (id, name) => invoke("workflow:duplicate", id, name),                            // a copy of a library entry → { library, entry } (the studio's Clone is save without an id)
  exportOne: (id, path) => invoke("workflow:export", id, path),  // id null = active; path omitted → save dialog → { ok, path } | { canceled }
  importFile: (path) => invoke("workflow:import", path),         // path omitted → open dialog → { entry, library } | { canceled }
  jobs: (sessionId) => invoke("workflow:jobs", sessionId),       // → { jobs }
  run: (sessionId, req) => invoke("workflow:run", sessionId, req),   // { role, task, files, agents, taskRef?, context?, fresh?, fromJob? } → { job }   (from: "ui"; fromJob = §10 handoff)
  stop: (jobId) => invoke("workflow:stop", jobId),               // → { ok, detail? }
  stopAll: (sessionId) => invoke("workflow:stopAll", sessionId), // every live job of the orchestrator → { stopped }
  brief: (sessionId) => invoke("workflow:brief", sessionId),     // → { text, generated:bool }
  control: () => invoke("workflow:control"),                     // → { url, running, binDir }
},
events: onWorkflowJob(cb) ← "workflow:job" · onWorkflowStage(cb) ← "workflow:stage" · onSessionCreated(cb) ← "session:created"
```

## 7. Renderer module `src/renderer/workflow/index.js` (exports the rest of the UI imports)

```js
openWorkflowStudio({ role } = {})   // overlay (Git-Center style, mounted in #modalRoot): canvas + inspector + library + brief
closeWorkflowStudio(); toggleWorkflowStudio()
workflowChip()                      // composer chip element (has ._refresh()): off → "Workflow"; on → name + live stage; click → studio
refreshWorkflowChip()
onWorkflowJob({ job })              // upsert into state.workflow.jobs, re-render canvas/chip if open
onWorkflowStage(payload)            // state.workflow.stages.set(sessionId, payload)
workflowJobsFor(sessionId)          // job[] for a planner session
```
`state.workflow = { jobs: Map<jobId, job>, stages: Map<sessionId, stage>, library: [], active: null }` (core/state.js).
Job cards in the chat: main adds a `role: "job"` message to the PLANNER session when a job starts
(`{ id, role:"job", jobId, jobRole, text: task, ts, meta:{ provider, model, effort, access, agents, sessionId, status } }`)
and patches `meta.status / meta.result / meta.durationMs / meta.editedFiles` through `session:message-update`.

## 8. Task board — centralised at the SESSION level (added 2026-09-16, second round)

The planner session owns ONE task board. Agents create the tasks first, then update each one as it
is done; a task can be handed to the Reviewer or the Tester. Tasks are grouped into SETS: when every
task of the current set is finished and new tasks arrive, they open a NEW set with its own title
("a new set of tasks"); the board shows the active set expanded and finished sets collapsed.

```js
session.tasks = { seq: 0, setSeq: 0, sets: [], items: [] }     // persisted by normalizeSession; copied by synthesize
set  = { id, n, title, status: "active"|"done"|"closed", createdTs, closedTs, by }
        // exactly one "active" set at a time (or none). "done" = closed with every item terminal;
        // "closed" = closed by an explicit new set while items were still open.
item = { id, n /* session-wide: T1, T2 … */, setId, title, detail, status, role, jobIds: [], notes: [{ ts, by, text }], createdTs, updatedTs, doneTs }
        // status: "todo"|"doing"|"review"|"test"|"done"|"blocked"|"dropped"   (terminal = done|dropped)
        // role:   null|"planner"|"coder"|"reviewer"|"tester"                    (who it is for / who worked it)
```

### 8.1 SessionManager methods (mixin `src/main/session/tasks.js`)
```js
boardFor(session) → { seq, setSeq, sets, items, active: setId|null, counts: { total, open, done } }   // never throws; normalises legacy shapes
addTasks(sessionId, { titles?: string[], items?: [{ title, detail?, role? }], set?: { title } }, { by = "planner" } = {}) → { set, items }
   // rule: if `set.title` is given (a string `set` works too) → close the current active set (done|closed) and open a new one with that title;
   // else if there is no active set, or the active set has ≥1 item and every item is terminal → open a new set titled "Set <n>";
   // else append to the active set (an EMPTY active set — just opened with openTaskSet — is appended to, never skipped).
   // Adds/patches the planner chat card (8.4). Emits tasks:update. Top-level `role` / `detail` apply to every title.
updateTask(sessionId, ref /* "T12" | 12 | id */, { status?, role?, title?, detail?, note? }, { by = "planner" } = {}) → item
   // any status allowed; done → doneTs; a note is appended as { ts, by, text }; closes the set as "done" when its last open item finishes (the set stays visible). Throws a plain Error for an unknown ref / bad status.
openTaskSet(sessionId, title, { by } = {}) → set          // explicit new set (closes the current one)
removeTask(sessionId, ref) → true                          // user-only action (board UI)
taskInfo(sessionId, ref) → item|null
boardSummaryText(session, { openOnly = false } = {}) → string   // "Task board — Set 2 “Payments” (3 of 8 done): T9 doing coder · …" for briefs / the synthesize session map
linkJobToTask(job, taskRef)                                 // startRoleJob({ …, taskRef }) and runCommandJob({ …, taskRef }) → job.taskId / job.taskN (number) set; item.jobIds += job.id; role set; status → doing (coder) / review (reviewer) / test (tester) unless the task is already terminal (done|dropped); on job end a note "<role> job <id> <status>" is appended (status unchanged)
   // `taskRef` (NOT `task`, which is the job's text) is "T<n>" or an item id; a job whose `task` text is exactly "T<n>" and matches a task means that task (its title becomes the description). An unknown taskRef refuses the job before any child session exists.
```
Refs everywhere: `"T12"` / `"t12"` / `12` / the item id. A CHILD job session (parentId) addresses its planner's board with every method (events name the planner). `by` is stored as given ("planner", a role name, "user").
Events: `tasks:update` `{ sessionId, board }` (the whole board = boardFor, after any change; the board is bounded to 400 items / 60 sets — oldest done sets pruned first, then oldest closed sets, then the active set's oldest terminal items). Job objects / cards / `workflow:job` carry `taskId` and `taskN` (null without a task).

### 8.2 Orchestrator brief additions (workflow.js) — one paragraph, verbatim (`TASK_BOARD_BRIEF`)
"Track delegated, multi-step work on this session's task board (a direct answer needs no board): create the tasks first (`atomnano tasks add "…" "…" --set "<title>"`), start / finish them as you go (`atomnano tasks start T3`, `atomnano tasks done T3 --note "…"`), hand one to a role with `atomnano run coder "…" --task T3` (planner → doing, reviewer → review, tester → test), and open a new set when a new batch of work begins. `atomnano tasks` shows the board." It is the brief's fourth paragraph (after the CLI block, before the session id line) and the one place the generated brief states the board rule; a user's `brief` override replaces the whole brief. Child jobs started with `--task` receive the task as labelled data after the task text (and after a `--from` source result): `Task T3 of set "<title>": <title> — <detail>`.

### 8.3 Control server + CLI
```
GET   /v1/tasks?session=&all=1          → { board }         (default: active set + last 2 finished sets; all=1 everything)
POST  /v1/tasks       { session, titles|items, set, by }   → { set, items }
POST  /v1/tasks/sets  { session, title, by }               → { set }
GET   /v1/tasks/:ref?session=           → { item }
PATCH /v1/tasks/:ref  { session, status, role, title, detail, note, by }  → { item }
POST /v1/jobs and POST /v1/tests accept `taskRef` ("T<n>" or an item id) → linkJobToTask
```
```
atomnano tasks [--all] [--json]                         the board (active set expanded; --all every set)
atomnano tasks add "title" ["title" …] [--detail "…"] [--role coder] [--set "New set title"]
atomnano tasks set "Title"                              open a new set now
atomnano tasks start|done|review|test|block|drop T12 [--note "…"]
atomnano tasks note T12 "text"        atomnano tasks show T12        atomnano tasks sets
atomnano run <role> "…" --task T12                      link the job to a task
```
Preload: `atom.tasks = { get(sessionId), add(sessionId, req), update(sessionId, ref, patch), newSet(sessionId, title), remove(sessionId, ref) }`, event `onTasks(cb)` ← `tasks:update`.

### 8.4 Renderer
- `panels/board.js` — the "Board" dock (`DOCKS.board = "boardPanel"`, `<aside id="boardPanel" class="side-dock hidden">` in index.html AND in the check-renderer stub): header with the session name, progress (done / total) and a bar; sets as collapsible groups — the active set expanded first, finished sets collapsed ("Set 1 · Payments · 20 tasks · done"); each task row: `T12` badge, title, status chip, role chip, linked job mini-status, elapsed / done time, notes on expand; user actions: add task, new set, rename, change status, delete; filter All / Open / Done. Live via `tasks:update`.
- Chat card `role: "tasks"` in the planner session: `{ id, role: "tasks", setId, text: set.title, meta: { setN, title, status, items: [{ n, title, status, role }] } }` — one card per SET, patched with the FULL meta on every change (`session:message-update`): a checklist with live status glyphs and "3 of 8 done"; click a row → opens the Board dock.
- The composer has a **Task board pill** (`#boardChip`, `workflow/live.js` `taskBoardChip`) next to the workflow chip: "Task board · 3/8" while the workflow is on or the tab has a board, lit while a task is ongoing (doing · review · test), tooltip = the active set's ongoing / remaining / done counts; a click toggles the Board dock. (Until 2026-09-17 the progress rode on the workflow chip itself; a long set title swallowed the chip.)
- Synthesize copies `tasks` to the new session and the seed's session map gets a "Task board" block (`boardSummaryText(src)`).

### 8.5 Job context (added after §8)
`startRoleJob(parentId, { …, context: true })` (CLI `--context`, server body `context: true`, IPC `workflow:run { context }`)
appends the planner session's CONDENSED conversation to the child's first prompt as labelled data —
`Context from the planner session — … condensed by AtomNano …` followed by `synthesizeSeed(parent, provider, { model }).text`
(summary of the oldest entries with cached checkpoints reused, the newest verbatim, the session map, the task board; ≈ 24K chars max).
`job.context` records the choice. Without it a job carries only its task text (+ the source result with `--from`, + the task line, + files of interest).
Prompt order, fixed: task → `--from` source result (§10) → board task line → files of interest → `--context` block.

## 9. Changes of 2026-09-17 (user decisions) — what moved in the interface above

- **Every worker role has its own sub-agent lane.** `roles.coder|reviewer|tester.agents` (0–20; defaults 3 / 0 / 0). Only Claude roles can use a lane (Codex / Custom have no Task tool); the planner brief lists each Claude role's lane, the role brief tells the role to **use** it — "split independent parts across as many as the task allows (all N when the work divides that far, fewer when it does not) and run them in parallel". `startRoleJob` applies `rc.agents` for any role; `--agents N` overrides it for one job. The canvas draws a lane (band · orbs · −/+ stepper) on every Planner → role edge; the inspector has the stepper for every role.
- **Solo turns with sub-agents on** get the same instruction (`session/subagents.js agentsBrief`) as the system-prompt append, shown by the Agents popover's hint; `_lastRun.sent.agentsBrief` records it. Without sub-agents an ordinary turn stays untouched.
- **Workflow off = solo.** `startRoleJob` and `runCommandJob` refuse with a plain error when `workflow.enabled` is false (jobs used to start regardless). The planner canvas node reads "workflow off — the chat runs solo"; `plannerRunning` is false with the workflow off, and a stale "planner running" stage cannot keep the node thinking once the tab's status changed after it (`ts._statusAt`).
- **One session per role.** The planner keeps `roleSessions = { coder: [ids], reviewer: [ids], tester: [ids] }` (persisted, on the view). The next task for a role runs in that role's existing session — its native thread resumes, so it remembers the earlier tasks; a role whose session is busy gets a second one; `startRoleJob({ …, fresh: true })` (CLI `--fresh`, server body `fresh`, IPC `workflow:run { fresh }`) forces a new session. The job carries `reused: true|false`; `session:created` is sent for a reused session too (with `reused`) so the tab reopens quietly.
- **Stop on the planner stops the planner's turn only.** Its jobs — the role tabs with their sub-agents, command runs — keep running and keep their state; a system note says so and the next planner turn picks them up (`atomnano jobs` / `wait`). Ending every job is explicit: `stopJobsOf(parentId)` through `workflow:stopAll(sessionId)` (preload `atom.workflow.stopAll`), the studio's "Stop all jobs" button, `POST /v1/jobs/stop-all { session }`, `atomnano stop --all`. `liveJobCount(parentId)` counts them.
- **Live sub-agents per job.** `job.agentsLive = { running, total, list: [{ n, status, description, progress, lastTool, toolUses }] }` follows the child's registry while the job runs (`jobAgentsChanged`, coalesced to one `workflow:job` + card patch per 250 ms) — the studio shows every role's agents (node chips, orbs, inspector job rows) without the child tab being open.
- **The council is skipped in planner mode.** With the workflow on, the planner's Reviewer role is how reviews happen; `_runSetup` clears `reviewers` for the planner's turn. With the workflow off the user's configured council still runs.
- **Task board, live in the studio.** The overview shows the active set's progress, the ongoing tasks (doing · review · test) and the remaining ones (todo · blocked); `tasks:update` notifies the studio (`notifyWorkflow`). The Board dock summary reads "N ongoing · M remaining · K done" and has an Ongoing filter. The primary node's idle line carries "· N ongoing · M to do".

## 10. Changes of 2026-09-17, evening (user decisions) — the Orchestrator above the Planner; lanes on every provider

- **A new primary: the Orchestrator.** `roles.orchestrator` `{ provider, model, effort, access }` (`""` = the composer's picks, exactly the shape the primary always had) is the model the user chats with. It owns every managing, orchestrating and monitoring duty the Planner used to have: the generated brief (`orchestratorBrief`; `plannerBrief` stays as an alias) tells it to have the Planner draft the plan, delegate to the Coder, have the Reviewer and the Tester check the result, keep the task board current, monitor the jobs and report. `workflow:stage` names it `"orchestrator"`; `session._wfPrimary` marks its turns; the task board's default `by` is `"orchestrator"`; `TASK_ROLES` gains `"orchestrator"`.
- **The Planner is a worker role.** `roles.planner` `{ enabled, provider, model, effort, access, agents }` (defaults `anthropic · high · read · 0`) runs as a job like the others: `atomnano run planner "<request>"` / `atomnano plan "…"`, `POST /v1/jobs { role: "planner" | "plan" }`, `roleBrief("planner")` = plan only (a concise implementation plan the Coder follows; no implementation; the Orchestrator decides). Its jobs move a linked task to `doing`; it has its own `roleSessions.planner` pool. `ROLE_ORDER` = orchestrator · planner · coder · reviewer · tester; `WORKERS` = the last four.
- **Sub-agent lanes on every provider.** `laneOf(rc)` no longer requires Anthropic. `startRoleJob` passes `subAgents: lane > 0` for any provider; the Codex runner (`session/openai.js`) maps it to Codex's own multi-agent feature — thread config `features.multi_agent = true` + `agents.max_concurrent_threads_per_session = <lane>`, or `features.multi_agent = false` for a lane of 0 — and the Codex collaborator items land in the same agent registry, so the studio shows a Codex role's agents like a Claude role's. A solo Codex turn with the composer's Agents switch on gets the same override plus the explicit sub-agents brief as labelled data (`workflowAppendix({ agentsBrief })`); with the switch off nothing is passed and Codex's own config decides. The studio's stepper, lane and "N agents" chip work for every role on every provider; the "Claude only" warning is gone. `_lastRun.sent.subAgents` records the cap on Codex runs.
- **Migration of saved workflows.** A workflow whose `roles.planner` has neither `enabled` nor `agents` (the old primary shape) and no `roles.orchestrator` is migrated on read by `migrateLegacyPrimary` (main `session/workflow.js` + `ipc/workflow.js`, renderer `workflow/model.js`): the picks move to `roles.orchestrator`, `layout.planner` to `layout.orchestrator`, and the Planner takes the worker defaults. Library entries and import files go through the same normaliser.
- **Canvas.** Five nodes: the Orchestrator on the left (250×150, tag "primary", icon `cpu`, hue = the accent), the four workers stacked on the right (Planner on top; the planner hue is `--wf-planner`, accent +205°). `CANVAS_H` = 660; `DEFAULT_LAYOUT` orchestrator (72, 256) · planner (580, 20) · coder (580, 178) · reviewer (580, 336) · tester (580, 494). The lane stepper of a role is `.wf-lane-ctl.<role> .wf-lane-plus|minus`.
- **Task board pill.** The composer shows a "Task board · done/total" pill next to the workflow chip while a workflow runs (or the tab has a board); it opens the Board dock — the drawer with every set, task, status, note and linked job (§8.4). The workflow chip itself shows only the workflow's name and live stage.
- **Triage in the Orchestrator brief (2026-09-18).** The generated brief tells the Orchestrator to decide what each request needs: simple requests (questions, explanations, summaries, reviews of text or ideas, advice, lookups, any non-coding work) are answered directly — no Planner, no Coder, no task board; coding work goes to the Coder, and a small clear change goes straight there with no plan; the Planner is reserved for larger or unclear coding work (several files, design decisions, unknown code), its plan is handed to the Coder with `--from <planner job id>` (`--context` when the discussion matters); after code changes the Reviewer and the Tester run (both at once), and fix-ups go straight back to the Coder with `--from <reviewer job id>` — no new plan. The board paragraph (§8.2, verbatim) starts "Track delegated, multi-step work … (a direct answer needs no board)". The Planner's role brief makes its lane an INVESTIGATION lane: one area / module / question per read-only sub-agent, run in parallel, findings combined into the plan; the Coder's brief says to follow a carried plan step by step and to address carried review findings. Whether the model follows the triage is the model's call — the app enforces only what it always did (disabled roles are refused, the workflow off means solo).
- **Idle roles are kept busy (2026-09-18).** The Orchestrator brief adds: while the Coder implements one part, the Planner plans the next and the Reviewer and Tester check finished parts — start such jobs without `--wait` and collect them with `atomnano jobs` / `atomnano wait <id>`.
- **Waiting: 540 / 600 (2026-09-18, evening).** The brief's waiting guidance is `--wait --timeout 540` (returns after 540 s while the job keeps running), then `atomnano wait <id> --timeout 540` until the job ends, with the shell tool's own timeout at 600 s (the earlier 100 s slices are gone). The CLI keeps its internal long-poll slice at `SLICE_S` = 240 s and the server its `MAX_WAIT_S` = 600 cap; a `--timeout 540` therefore becomes 240 + 240 + 60 s requests. A waited job that has not ended prints ONE short line (`job <id> still running[ (paused: offline)] after <elapsed> · <role> — atomnano wait <id> --timeout 540`), exit 0; `--json` and exit 3 on error / stopped are unchanged. The not-yet-waited "started" line's hint reads `atomnano wait <id> --timeout 540`.
- **Compact brief (2026-09-18, evening).** The generated Orchestrator brief was cut from 3,978 to about 3,150 characters (the W03/T10 fixture: the "Team" workflow with the default roles and a test command; `scripts/test-workflow.js` W03b and `scripts/test-tasks.js` T10 assert `< 3200`). Every rule stays: primary responsibility; direct-answer triage; small-change delegation; larger-work planning and approval (now via `--from`); disabled-role fallbacks (Planner off → decide the plan yourself; Coder off → code, follow the plan and do the fix-ups yourself, no `--from` handoffs); parallel review / test and direct fix-ups; the board paragraph verbatim; lanes; idle-role pipelining; persistent-role continuity, busy-role waiting and `--fresh`; automatic attached skills (only when a role has some); the roles table; the CLI block (`atomnano run coder "<task>" [--from <job id>]` — the `--json` example is gone, the CLI's `--json` support is not) and the session id line. A user's `brief` override is untouched.
- **Source-job handoff — `--from` (2026-09-18, evening).** Wire contract: `atomnano run coder "<task>" --from job-123` → `POST /v1/jobs { session, role, task, from: "job-123", … }` → `startRoleJob(parentId, { from: "cli", fromJob: "job-123", … })`; IPC `workflow:run { fromJob }` (preload `atom.workflow.run(sessionId, req)` already takes the object) → `from: "ui"`. The manager's `from` stays the `"cli" | "ui"` provenance. `startRoleJob` resolves the source through `jobsFor(parent.id)` — the live registry and the persisted `workflowJobs` history — restricted to the destination orchestrator's jobs, and validates BEFORE any child reuse / creation, `roleSessions` mutation, registry entry, card, event or task link: a blank id, an id not among this session's jobs (unknown, pruned from the 100-entry history, or another orchestrator's — "belongs to another orchestrator session") and a job that has not ended ("is still running — wait for it (atomnano wait <id> --timeout 540)") are refused with plain sentences; `done`, `error` and `stopped` are accepted (a history entry that was live when the app closed reads as stopped with "AtomNano was restarted before this job finished."). The child's first prompt gets exactly one block right after the task text — `<task>\n\nResult of planner job job-123 (the plan):\n<saved result>` — before the board task line, the files and the `--context` block. The label is `(the plan)` for a Planner source, `(the review findings)` for a Reviewer, `(the result)` for anything else (a command job reads `command job`); an unsuccessful end is named — `(the plan — the job ended in error: Exit code 3.)`, `(the result — the job was stopped)` — and an empty saved result reads `(empty result)`. The text is the SAVED `job.result` snapshot (never the reused child's later transcript), forwarded verbatim except for trailing whitespace — no JSON / log expansion, no truncation. The job keeps the caller's `task` (card text, tab name) and records `fromJob` (job, card meta, `jobInfo`, persisted history). Server: a blank `from` → 400, an id not among the session's jobs → 404 (like an unknown task ref, nothing started), the manager's refusals → 400. CLI: a bare or blank `--from` → exit 1 naming the shorthand's usage; `atomnano test --cmd … --from` → exit 1 ("a command job runs a command, not the Tester role"); `atomnano test "<task>" --from <id>` is the Tester as a role. Tests: `scripts/test-workflow.js` W29–W29e (real manager), `scripts/test-workflow-cli.js` W25b–d · C22d–g · I20b · S540a–c, `scripts/test-tasks.js` T09h (order with `--task`).
- **Skills reach the roles only through the Workflow Studio (2026-09-18, evening).** `roles.planner|coder|reviewer.skills: string[]` — ids of this project's AtomNano skills, cleaned and deduped by every normaliser (max 50); the Tester carries none. `agents/skills.js` is reduced to `list / get / create / update / remove / invoke / importFromUrl`; IPC `skills:list / create / update / remove / import-url`; preload `atom.skills = { list, create, update, remove, importUrl }`. The Studio's **Skills** modal is the ONLY skills UI: one row per installed skill with a Planner · Coder · Reviewer checkbox each and Remove, install from a URL or by a CLI command (the choice remembered in the `skillInstallMode` setting), and an inline manual create form; the Skills library dock (`panels/skills.js`), the composer's "Skills for this chat" popover and both chat-header ⋮ items are gone, and project skill backup / restore stays in the settings IPC as project data. Delivery: `startRoleJob` gives the role's child session the ids as `selectedSkills` (on creation and on every reuse), and skills are effective ONLY on role sessions — `session.parentId && role ∈ {planner, coder, reviewer}`; a plain chat's `selectedSkills` is inert (kept in the store for compatibility), the Tester and the Orchestrator get none. Native Claude skills follow the Claude CLI's own defaults: the `sdkSkills` and `skillsMarketplaceUrl` settings are removed (stripped on load via `REMOVED_SETTINGS`; store default, Anthropic forwarding and the Settings control gone), so Claude's `skills` query option is simply omitted. The Orchestrator brief lists each role's skills by name in the roles table and says they reach the role's jobs automatically; the job (and its card meta) carries `skills`; the inspector's role editor has a Skills row, a worker card an "N skills" chip, a job card "N skills". The full-skills block a role child receives still starts "Skills the user selected for this message". Tests: `scripts/test-workflow-skills.js` (new; in `npm test` right after `test-workflow-cli.js`), `scripts/test-workflow.js` W28; smoke: `smoke-tests/test-tools-providers.js` (was `test-tools-skills.js`; `test-skills.js` deleted).
- **Binding hashes — briefs and skills sent once per native thread (2026-09-18, evening).** Each turn takes one skill snapshot: `skillsHash = sha256(JSON.stringify([projectKey(cwd), sortedPairs]))`, where `projectKey` = the cwd with `\` → `/`, trailing slashes stripped, lower-cased, and `sortedPairs` = the deduplicated `[id, String(updatedAt)]` pairs sorted by id, `"missing"` marking an attached id with no store record; usage counters are never hashed; an empty hash means nothing deliverable. Per native thread the binding caches what the provider ACCEPTED: `session.bindings.openai = { …, briefHash, briefKinds, skillsHash }`, `session.bindings.anthropic = { …, skillsHash }`, with `briefHash = sha256(JSON.stringify([roleBrief || "", agentsBrief || ""]))` when either brief is present and `""` when neither is, and `briefKinds` the composition that hash describes (`"r"` role brief, `"a"` agents brief, `"ra"` both — `normalizeBinding` keeps all three across restarts). `history.setBinding` clears the caches before merging any patch that changes the native id (a drop included); same-id patches keep them; legacy bindings without hashes resend once. The snapshot FREEZES each skill's digest text at the start of the turn (`skills.digest`, pure); every attempt of that turn — the resumed one and a lost-session / overflow / rollover replacement — sends exactly the frozen text, so the committed hash always describes what went out even when a skill was edited or removed meanwhile (the next turn's snapshot notices); usage bookkeeping is separate (`skills.markUsed`, only for what is sent). Delivery per attempt: no previous hash → the full procedures; same hash → one pointer line ("Skills active for this conversation (their saved procedures were provided earlier in this conversation and still apply): <names>."); changed → full again ("…they replace any skills given earlier in this conversation"); changed to empty → one clearing line ("Skills: none are attached to this conversation any more — the skill procedures provided earlier in this conversation no longer apply."); initially empty → nothing. Codex briefs follow the same four modes: new or changed → the present briefs in full (a changed set labels each as replacing its predecessor and adds one explicit line for each brief kind the thread received before that is absent now — "Sub-agents: no sub-agents brief applies to this conversation any more …" / "Role brief: none applies …", decided from `briefKinds`; a hash without kinds names every absent kind); unchanged → a pointer that names ONLY the briefs currently active ("Briefs: unchanged — the role brief given earlier in this conversation still applies." / "… the role brief and the sub-agents brief given earlier in this conversation still apply."); something → nothing → one clearing line ("Briefs: none apply to this conversation any more — …", commits `""`); nothing before and now → nothing. Claude keeps the role / agents briefs in `systemPrompt.append`. Hashes commit only on accepted input — Codex app-server `onTurnId`, Codex exec thread id + `turn.started` (completion fallback retained), Claude `system/init`; thread creation or history injection alone never marks delivery. A Claude `conversation_reset` (SDKConversationResetMessage: /clear inside the CLI, a plan-mode exit, a fresh-session flow) binds `new_conversation_id` (fallback `session_id`) on `session.bindings.anthropic` with `syncedIndex: -1`, `account: ""`, `activeTokens: 0`, `ctxUsage: null`; the id change makes `history.setBinding` drop `skillsHash` and `briefHash`, and when no new id is reported or it equals the old one both are deleted explicitly. Nothing is injected into the running turn: the current turn finishes as the CLI compacted it. The run's frozen attempt is RETIRED (`runner.attempt = null`, `runner.accepted = false`, `runner.resetSeen = true`) and is never committed — after a reset an init of that run commits nothing and the run-end acknowledgement does not advance the cursor (`contextHoldsRecord = !runner.resetSeen`). EVERY id the run retired is kept in a Set (`runner.retiredIds`): an init — in BOTH branches, the plain one and the `freshThread` replacement one — or a result that names any retired id binds nothing, ends no pending replacement, commits nothing and is no acceptance (previously only the last retired id was remembered, so two resets followed by an init naming the first conversation rebound it). Consequence: the NEXT user turn resumes the fresh id with no accepted hash, so the full procedures go out again (skillDelivery `"full"`, the "Skills the user selected…" block, not the pointer) and the cursor at −1 makes pendingSync transfer the record the fresh context never saw; that turn's guarded `system/init` commits its hash and cursor. Claude's role / agents briefs are unaffected — they ride in `systemPrompt.append` on every request. Tests: `scripts/test-context.js` K11 (the binding follows the new id), K11c (no mid-run injection; the next turn carries the full digests and the record), K11d (rollover with two resets: every retired id refused, the fresh id binds). Fresh-thread paths (initial, lost thread, overflow / rollover, fresh exec fallback) recompose full appendices and budget the transfer against the actual attempt. Stateless Custom HTTP sends the full eligible digests on every request. Reviewer advice and other turn-specific data stay outside both hashes.
- **Role continuity is spelled out (2026-09-18).** The one-session-per-role rule of §9 (per orchestrator tab, `roleSessions`, persisted; a busy role gets a second session; `--fresh` forces a new one) is now stated in the briefs: the Orchestrator is told that the Planner, Coder, Reviewer and Tester remember their earlier tasks and results in this chat — refer to earlier work instead of re-explaining, send follow-ups to the same role, wait for a busy role's job rather than spawn a second session, `--fresh` starts a role over (and `--fresh` is listed among the CLI options); every role brief ends its task with "This session is your persistent one for this chat — your earlier tasks here and their outcomes are already in your context; build on them rather than starting over." The reused session is renamed to the new task, its native thread resumes (Claude resume id / Codex thread id), and its record stays intact across app restarts.
- **The workflow and solo sub-agents are exclusive; the model knows its mode (2026-09-18).** In `_runSetup` the orchestrator's own turn forces `subAgents = false` (no Task tool, no solo agents brief — the roles carry the lanes) whatever the composer sent, and its brief says "Solo sub-agents are off on your own turns — you fan out only through the roles." Renderer: `workflow/model.js setWorkflowEnabled(on)` is the ONE enable path (studio header switch, canvas "Turn on", Settings, a preset that enables, the workflow chip's own switch): turning on while `settings.subAgents` is on asks (`confirmWorkflowOn`) and, on yes, turns solo sub-agents off (`setSoloAgentsSetting`, with `onSoloAgentsChanged` redrawing the composer's Agents button); turning off only flips `enabled` on the tab's own copy — design, role sessions, board and skills stay, so the chip's switch turns it straight back on (a toast says live jobs keep running). `chat/composer.js setSoloAgents(on)` is the other direction (composer popover, Settings): turning solo sub-agents on while the tab's workflow is on asks, then turns that workflow off. With the tab's workflow on the composer's Agents button reads "Agents · workflow" and a click runs `setSoloAgents(true)`; off, the normal button, popover and strip return. `#wfChip` is a div (role button) carrying a compact `.sw.wf-chip-sw`. MODE NOTE: a solo primary turn (workflow off, not a role child, not background / fleet) gets `modeBrief(session, wf, subOn, subMax)` as its role brief — one sentence: the workflow "<name>" is off for this chat (the studio turns it on), solo sub-agents on (up to N) or off — so the model knows the current setting. When the workflow was switched off MID-WORK the note also carries the state to continue from (`soloContinuation`): the workflow was on earlier and the remaining work is the model's to finish itself (`atomnano run` is refused now; `tasks` / `jobs` / `result <id>` still read), the OPEN board items (`boardSummaryText(session, { openOnly: true })`) and the last six jobs with role, status and task — a chat that never delegated gets the bare note. It rides the brief channel (Claude: `systemPrompt.append`, cached; Codex: once per thread through the brief hash, a pointer afterwards, re-sent in full when the mode flips). `settings.modeNote` (default `true`; Settings → Agents & context "Tell the model its mode") turns it off for a bare turn. The generated orchestrator brief's fixture bound is 3,300 characters. Content column: `.chat` 1056 px / 21 px side padding and `.composer-inner` 1032 px (+20 % width, −20 % margins).
- **Per-session workflows (2026-09-18).** Every chat tab picks its workflow independently. `session.workflow` (object | null, persisted by `normalizeSession`, on the view and on `session:created`) is the tab's OWN workflow; null = the project's active workflow (`settings.workflow`, the default for tabs that never chose). `workflowFor(session)` resolves own → nearest ancestor's own (a role child runs under its orchestrator's) → project. `setSessionWorkflow(sessionId, wf | null)` writes it and sends `session:workflow { sessionId, workflow }`; `hasOwnWorkflow(sessionId)`. Every `workflow:*` IPC takes a trailing `sessionId`: `get(cwd, sid)` → `{ active, scope: "session" | "project", library, control }`, `set(patch, cwd, sid)` (the tab gets its own copy on the first edit), `save(name, id, sid, cwd)`, `load(id, sid, cwd)`, `delete(id, sid, cwd)`, `rename(id, name, sid, cwd)` bind the result to that tab; `clear(sid)` drops the tab's own workflow; `duplicate(id, name)` accepts a name. Without a sessionId they address the project's active workflow as before — of the trailing `cwd` when given (see the round-4 bullet below), else of the calling window's project. The renderer keeps `ts.wfOwn` per tab (`tabWorkflow(sid)` / `activeWorkflow()` in `workflow/model.js`), the studio redraws when the active tab changes, its header shows "this tab" / "project default", and the Library menu's **Clone for this tab…** asks for a name, saves the tab's current design as a NEW library entry under it (`workflow:save` without an id) and switches the tab to it; **Use the project default for this tab** clears the tab's copy. A synthesized continuation carries its source tab's workflow.
- **Library calls carry the captured project; the studio's pull validates its scope inside (2026-09-18, round 4).** `workflow:save / load / delete / rename` take a trailing `cwd` (preload `save(name, id, sid, cwd)`, `load(id, sid, cwd)`, `remove(id, sid, cwd)`, `rename(id, name, sid, cwd)`): the project a NO-SESSION call is for, honoured only without a `sessionId` — with one, the project is the session's own, exactly as `set` / `get` behave in effect. The renderer passes the project it CAPTURED when the action started (`captureScope()` in `workflow/model.js`: the tab's session id, its project — the tab's cwd, else `state.project` — and the project current then), so a Save As, Load, Clone, saved-entry Rename or Delete whose dialog was still open when the user switched projects goes to the project it was started in (main used to resolve the window's project at IPC receipt: B's design was saved under the name typed for A, and B's workflow renamed). The user's input is never discarded over a switch; the reply is mirrored only while that project (or tab) still holds, as before. `pullWorkflow(scope = captureScope())` sends `get(scope.cwd, scope.sid)` and validates the CAPTURED scope before ANY mutation (`scopeHolds`: with a session the tab still exists and — when both know their project — is the captured project's; with no tab, `state.project` is unchanged); a reply whose scope no longer holds is dropped whole (`null`) — nothing written to `state.settings.workflow`, `ts.wfOwn`, `state.workflow.active` or the library — while the control facts (global) always land. A tab that merely left the screen still takes its own copy; the library is mirrored only while the project is unchanged. The studio's follow-up re-pull (`pullFor(scope)`) passes its captured scope; every other caller (open, the 1 s tick, `freshLibrary`) uses the default capture. Fallback `LOCAL_API` accepts and ignores the trailing scope. Tests: `scripts/test-workflow-ui.js` — the five held-dialog tests (no tab, project switched while the dialog is up), the two deferred-get tests after Load, the `pullWorkflow(scope)` model test; `workflow:get` is a deferred IPC in that fixture now; mutants "the library IPCs drop the captured project", "pullWorkflow mirrors BEFORE the scope check", "… re-reads the scope at reply time", "… ignores the captured sid", "… ignores the captured project".
- **Jobs run in the background; job tabs are opt-in.** `workflow.openJobTabs` (default `false`) replaces `autoOpenJobs` (default `true`), which is dropped on read so every saved workflow starts in the background. A job is still its own child session; its result returns to the Orchestrator as the CLI's output and its `role: "job"` card, and its tab opens on demand (the card's Open tab, the studio's job rows, `session:created` carries `autoOpen: openJobTabs === true`, which the renderer obeys). The Orchestrator-node "Job tabs" switch and Settings → Agents & context → Job tabs turn the tabs on.
