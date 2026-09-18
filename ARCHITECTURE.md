# AtomNano — Architecture & Context Guide

> **Purpose of this file:** a single, self-contained briefing an AI assistant (or a new engineer) can read to gain full working context on the AtomNano codebase before making changes. It describes the real, verified structure of the app — file responsibilities, the IPC contract, the data model, the agent subsystems, the renderer, and the build.

---

## 0. What AtomNano is

AtomNano is a **Windows desktop GUI for Claude Code**, built on **Electron** with the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). It is a polished IDE-grade shell around an autonomous coding agent: a file tree + CodeMirror 6 editor + git view on the left/middle, and a multi-session chat with the agent on the right. Beyond a plain chat client it adds multi-provider routing, background fleets, per-project memory, a workflow of orchestrated roles with project skills attached to them, and a test-authoring director.

- **App id:** `com.atomailabs.atomnano` · **Product:** `AtomNano` · **Vendor:** Atom AI Labs
- **Stack:** vanilla JS (no React/Vue), Electron main/preload/renderer split, hand-rolled DOM helper `h()`.
- **History:** evolved from an app called "AtomCode" (kept as a backup tree at `E:\Mac\AtomCode`). AtomNano is the live product.

### Directory shape

```
E:\Mac\AtomNano\
  src/
    main/        # Node/Electron main process — main.js, preload.js, platform.js + one folder per domain (see §1):
                 #   session/ providers/ storage/ auth/ agents/ db/ git/ lang/ testing/ workspace/
    renderer/    # UI: index.html, app.js (entry) + core/ chat/ git/ workspace/ panels/ settings/ editor/ (see §5)
      styles/    # stylesheet partials 00-base.css … 98-dbm-updates.css (load order = cascade order)
      editor/    # editor UI modules + CodeMirror 6 source (cm-src.js) → built bundle (cm.bundle.js) + cmchunk/*
  build/         # icon.ico / icon.png (packaging resources)
  smoke-tests/   # Playwright-driven smoke tests (NOT shipped)
  electron-builder.yml
  package.json
```

---

## 1. Main process (`src/main/`)

The main process is the trust boundary: it owns the filesystem, spawns CLIs, talks to provider APIs, and persists everything. The renderer reaches it **only** through the preload IPC bridge (§2). Modules are grouped by domain (one folder each); file names are kebab-case. `node scripts/check-requires.js` loads every module under a stubbed Electron and rejects dangling `require` paths.

| Root file | Responsibility |
|------|----------------|
| **main.js** | App bootstrap only (~470 lines): portable-mode detection and the app-level Claude home, CLI mode, GPU switches, the TypeScript utility-process manager, the window registry (`winFrom`, `projectOf`, `windowForProject`, `focusOrCreateWindow`), file-system and git-metadata watchers, `createWindow`, the sleep blocker, `app.whenReady` → `ipc.registerAll(ctx)`, the network / login auto-resume pollers, `before-quit`. Wires emitters (`session`, `fleet`, `terminal`, `director`) to `broadcast()`. |
| **preload.js** | `contextBridge` → `window.atomnano.*` (§2). |
| **platform.js** | The ONE place that knows how Windows / macOS / Linux differ: shell and CLI lookup, process-tree kill, terminal launch, PATH fix-ups, window chrome. |

### `ipc/` — the IPC handlers (formerly the back half of `main.js`)

`ipc/index.js` holds the `handle(channel, fn)` envelope (`{ ok, data } | { ok:false, error }`) and `registerAll(ctx)`; each domain module exports `register(ctx)` and registers only its own channels — nothing runs at require time, so `check-requires` loads them under the stubbed Electron. `ctx` carries the bootstrap callbacks (`portableInfo, windows, INDEX_HTML, winFrom, projectOf, windowForProject, focusOrCreateWindow, syncOpenWindows, createWindow, broadcast, startWatch, startGitWatch, applyPreventSleep, onProviderLoginChanged, tsCall`) plus `handle`; singletons (`storage/store`, `session`, `auth/cli-auth`, `git/git`, …) are required directly.

| File | Channels |
|------|----------|
| **window.js** | `app:info`, `win:*`, `dialog:*`, `clipboard:*`, `shell:open-external`, `app:relaunch`. |
| **settings.js** | `settings:*`, `project:*`, `userdata:*` (backup bundle builders), `cli:*` (npm link of the `atomnano` command). |
| **auth.js** | `auth:*`, `updates:*`, `tools:*`, `provider:*`, `profiles:*`, `codex:account`, `usage:get`. |
| **providers.js** | `models:discover`, `providers:catalog`, `image:generate`. |
| **sessions.js** | `sessions:*` (send / interrupt / synthesize / permission-response / retry / export / import …). |
| **agents.js** | `agents:*` (registry list, CPU snapshot, per-agent stop), `context:*` (fill info, rollover, digest). |
| **db.js** · **files.js** · **terminal.js** · **git.js** | `db:*` (with the input validators), `files:*` (+ rename-edit application), `terminal:*`, `git:*` (+ the progress sink). |
| **lang.js** | `ts:*`, `lsp:*`, `editorconfig:get`, `prettier:*` (Prettier / editorconfig lazy-loaded here). |
| **skills.js** · **fleet.js** · **mcp.js** · **testing.js** | `skills:list / create / update / remove / import-url` (the project skill store behind the Workflow Studio's Skills modal — 2026-09-18), `fleet:*`, `mcp:*`, `testdir:*` + `testhost:run` + `director:*`. |
| **workflow.js** | `workflow:*` — the active workflow (`get` / `set` deep-merge), the named LIBRARY (`save`, `load`, `rename`, `duplicate`, `delete`, `export` / `import` as `{ atomnanoWorkflow: 1, name, workflow }` JSON files), jobs (`jobs`, `run`, `stop`), the orchestrator `brief`, the control server facts. |
| **tasks.js** | `tasks:*` — the session's task board from the UI (`get`, `add`, `update`, `new-set`, `remove`; user actions are signed `by: "user"`; a child session id resolves to its planner's board). |
| **test-hooks.js** | The `test:*` handlers the smoke tests use (registered only with `ATOMNANO_TEST`). |

### `control/` — the local control server (how the CLI reaches the running app)

`control/server.js` — plain Node `http` on `127.0.0.1` (random port, per-launch bearer token), started in `app.whenReady`. It exports `ATOMNANO_CONTROL`, `ATOMNANO_TOKEN`, `ATOMNANO_NODE` (the app's own runtime, run as Node) to `process.env` and prepends the app's `bin/` to `PATH`, so every process the app starts — the Claude CLI behind the orchestrator's Bash tool, Codex, the integrated terminal — can run `atomnano …`; it also writes `<userData>/control.json` for CLIs launched from an outside terminal. Routes under `/v1`: `ping`, `status`, `roles`, `sessions`, `providers`, `models`, `jobs` (create / list / get / `wait` long-poll capped at 600 s / `log` / `stop` / `stop-all`; `taskRef` links a job to a task; body `from` = a finished job of the same orchestrator whose saved result travels with the task — forwarded as the manager's `fromJob`, 404 when it is not among the session's jobs), `tests` (a command job), `tasks` (the board: list with the active set + last finished sets or `all=1`, add, new set, get / patch one task). The server only calls the session manager's workflow and task-board methods; it never touches the model itself.

### `src/cli/` — the `atomnano` command (plain Node, no Electron)

`bin/atomnano.js` → `src/cli/index.js` (`main(argv, io?)`), `client.js` (discovery: env pair → `control.json`; HTTP with the token; exit codes 0 ok · 1 usage · 2 app not running · 3 awaited job failed), `format.js` (tables, `--json`). Commands: `status`, `roles`, `run <role> "<task>" [--from JOB] [--files a,b] [--agents N] [--context] [--fresh] [--task T12] [--wait] [--timeout s] [--session ID]`, the shortcuts `plan` / `coder` / `review` / `test [--cmd "…"]`, `jobs`, `job <id>`, `wait <id> [--timeout s]`, `result <id>`, `log <id>`, `stop <id> | --all`, `tasks …`, `context search | read`, `sessions`, `providers`, `models [-P provider]`, `help`, `version`. `--from JOB` (2026-09-18) hands a finished job's saved result to the next role (body `from` → the manager's `fromJob`; a bare / blank value and `test --cmd … --from` are refused before any request). Waits are long-polled in 240 s slices (`SLICE_S`) under the server's 600 s cap; the brief tells the orchestrator to use `--wait --timeout 540`, then `atomnano wait <id> --timeout 540`, with its shell tool at 600 s, and a waited job that has not ended prints one short line (exit 0). `bin/atomnano.cmd` and `bin/atomnano` are shims that run the script with `ATOMNANO_NODE` (Electron as Node) when the app exported it, else `node`. The former headless-in-Electron CLI (`atomnano run "prompt"`) was removed on 2026-09-16.

### `session/` — the conversation engine (formerly the single 2.4k-line `claude.js`)

One `SessionManager` class, assembled from per-concern method modules (each exports `{ methods }`; `index.js` copies them onto the prototype). `require("./session")` returns the singleton.

| File | Responsibility |
|------|----------------|
| **index.js** | Class core: runners registry, `run()` dispatch by provider, canonical-record writers (`addMessage` / `updateMessage` / `trackEdit`), terminal states (`finalizeRun`), `__internals` + the `setSDK` / `setSummarizer` test seams. |
| **anthropic.js** | Claude Agent SDK runner: one `query()` per turn with native `resume`; the prompt input stream held open by an input feed until the turn is over; the CLI spawned by the app (pid → whole-tree kill); `canUseTool` composition; headless single-turn runs (CLI / Planner); model-alias discovery. |
| **anthropic-events.js** | SDK message stream → record + IPC events: init, stream deltas and streamed tool arguments, tool cards, background-task lifecycle (the run stays open while agents are alive), results and usage. A `conversation_reset` inside a run (2026-09-18) rebinds the fresh id with the cursor at −1 and no accepted hashes, retires the run's frozen attempt (never committed; the run-end acknowledgement leaves the cursor alone) and records every retired id in `runner.retiredIds` — an init (plain or `freshThread` replacement) or a result naming one binds nothing, ends no pending replacement and commits nothing; nothing is injected into the running turn, the next user turn sends the procedures in full and transfers the record. |
| **openai.js** | Codex app-server primary (+ Codex SDK exec fallback): live text / reasoning, per-tool cards, approvals answered by the app, thread resume, exact record injection, context-overflow recovery. |
| **custom-http.js** | Stateless raw-HTTP endpoint primary (record as system, message as prompt). |
| **context-packet.js** | Pure adaptive handoff builder: UTF-8 budgets, selected user/tool evidence, task state and source references. |
| **transfer.js** | Conversation transfer sized to the destination model: the exact record by default; shortened tool payloads, then cached rolling summaries, only when it cannot fit (user decision 2026-09-10). Context awareness (2026-09-16): measured fill after each Claude turn (`getContextUsage`), a window LEARNED from a rejected request (passed on as `settings.autoCompactWindow`), proactive rollover into a fresh native session at `contextRolloverPct`, and the background rolling digest (`maybeDigest`) that keeps the summary tier ready. |
| **roles.js** | Reviewers — consult-before / review-after through `providers/council.js` — and the Planner role (Plan → Code). |
| **permissions.js** | Permission bridge (renderer prompt ↔ `canUseTool`), owned by (session, run) so only its own run can cancel it. |
| **control.js** | Stop (graceful-first, tree kill as fallback), steer, external cancellable runners, quit handling, live-query controls (context usage, MCP status, rewind, live model / permission mode). |
| **recovery.js** | Preserved turns: offline / expired-login / rate-limit replay with backoff and live settings. |
| **subagents.js** | Sub-agents mixin: the CPU-slot gate a Task / Agent call passes before it may run (`acquireAgentSlot` — bounded wait, then a plain deny sentence the model can act on), the per-session registry (numbered agents announced on the tool call, followed through PreToolUse / SubagentStart / SubagentStop hooks and the task_* events, mirrored onto the Task card), `agents:update` / `agents:cpu` events, per-agent stop (`stopTask`), process-priority throttling. Lifecycle (2026-09-17): no agent outlives the run that started it — `closeRunAgents` ends a run's agents when it finalises, `settleRunLeftovers` (index.js) does the same for a run that PAUSED on a network / login / rate-limit error and never finalised, and `reconcileAgents` ends records of runs that no longer exist (listing the panel, Stop with nothing running, a new run's first agent); every ended agent frees its governor slot. |
| **workflow.js** | Workflow (orchestrator-as-primary) mixin — see §8: `workflowFor` (the active workflow, defaults filled), `orchestratorBrief` (alias `plannerBrief`; compacted to ≈3,150 characters on 2026-09-18) / `roleBrief` (the explicit role briefs), the JOB registry (`startRoleJob` = a child session run with the role's provider / model / effort / access, the sub-agent lane and the role's attached skills; `fromJob` appends a finished job's SAVED result to the task — resolved through `jobsFor`, refused before any side effect when missing / foreign / not ended; `runCommandJob` = a shell command in the project folder; `waitJob`, `stopJob`, `jobLog`, `stopJobsOf`), the orchestrator's `role: "job"` chat cards, `workflow:job` / `workflow:stage` / `session:created` events. |
| **tasks.js** | The session-level task board (§8): sets and numbered tasks (`boardFor`, `addTasks` with the set rules, `updateTask`, `openTaskSet`, `removeTask`, `taskInfo`), `boardSummaryText` for briefs and the synthesize seed, `linkJobToTask` (a job started with `taskRef` moves the task to doing / review / test and leaves a note when it ends), the per-set `role: "tasks"` chat card, `tasks:update` events. |
| **sdk.js** · **errors.js** · **tools.js** · **tool-args.js** | Pure helpers: SDK loader + effort / thinking capability; error classification (transient vs capability); tool bookkeeping, streamed-argument scan, usage sums, run ids; partial tool-input parsing. |

### `providers/`

| File | Responsibility |
|------|----------------|
| **catalog.js** | Provider capability catalog (Anthropic / OpenAI / Custom) + live model discovery. `get()`, `discover()`, `context1M()`, strict Codex model / effort resolution. |
| **codex-appserver.js** · **codex-exec.js** · **codex-cards.js** · **codex-models.js** | Codex app-server transport (JSON-RPC over stdio) · Codex SDK exec transport · Codex thread items → tool-card shapes · the installed Codex's model catalog. |
| **custom-api.js** | Raw-HTTP template engine for any chat API (payload template, headers, output path). |
| **council.js** | Other providers as non-interactive reviewers via their CLIs. |
| **image-gen.js** | Image generation via the provider image APIs (`/image`). |
| **mcp-config.js** · **default-mcp.js** | User MCP server configuration · the default set (empty — MCP is opt-in). |

### `storage/`

| File | Responsibility |
|------|----------------|
| **store.js** | `settings.json` in userData + one JSON file per session in `historyDir`. Lazy metadata index, archive-first message cap, per-project settings merge and the `GLOBAL_ONLY` keys. |
| **workflow.js (session)** | Orchestrator-as-primary core (docs/WORKFLOW_CONTRACT.md, §9–§10 for the 2026-09-17/18 decisions: the Orchestrator above the Planner, lanes on every provider, the `--from` source-job handoff, the 540 / 600 s waiting guidance): role briefs with each role's own sub-agent lane, ONE persistent session per role (`roleSessions`, `--fresh`), jobs refused while the workflow is off, live `agentsLive.list`, Stop on the orchestrator leaving the jobs running (`stopJobsOf` only on the explicit Stop all). The job history rides on `session.workflowJobs` as whole job objects (bounded to 100), so new job fields such as `fromJob` persist without a store change. |
| **history.js** | The canonical conversation record, per-provider bindings (thread id + synced cursor — and, since 2026-09-18, the hashes of what the thread ACCEPTED: `bindings.openai.{briefHash, briefKinds, skillsHash}`, `bindings.anthropic.skillsHash`; `setBinding` clears them whenever the native id changes — a Claude `conversation_reset` included) and the lossless / budgeted transfer planner. What a model receives is the PRIMARY conversation only (2026-09-17): `isHistoryMessage` leaves out every entry produced inside a sub-agent (`parentToolUseId` — its tool calls, text, thinking); the Agent / Task entry and its result carry the outcome. `planTransfer` counts the left-out entries (`agentEntries`) and the transfer note names the count. |
| **history-query.js** | Bounded read/search of the canonical archive and live record, exposed as `atomnano context search/read`; UTF-8 byte pagination and stable message IDs. |
| **convo.js** | Per-session zero-LLM digest sidecar. |
| **attachments.js** | Durable attachment files (pasted images get a file before anything sees them). |

### `auth/` · `agents/`

| File | Responsibility |
|------|----------------|
| **auth/cli-auth.js** | Claude / Codex CLI detection, login status, login terminal, tool updates. |
| **auth/credstore.js** · **auth/profiles.js** | Where the CLI keeps its OAuth login · saved login profiles (save / switch / export). |
| **agents/fleet.js** | Background agent queue; a `FileLockManager` stops two agents editing one file. |
| **agents/skills.js** | Per-project skill store (Workflow Studio roles): `list / get / create / update / remove / invoke / importFromUrl`. Skills reach a session only when it is a Planner / Coder / Reviewer role child (`session.parentId && role`), through the ids the Studio attaches to the role; a plain chat's `selectedSkills` is inert. |
| **agents/subagents.js** | Pure sub-agent model: the registry helpers (`announce` / `patch` / `closeRun` / `publicAgent` on `session.agents`) and the `CpuGovernor` (Windows-safe `os.cpus()` delta sampling with an EMA; slots = free cores ÷ cores-per-agent within the user's 1–20 cap; bounded `acquire` / `release`; throttle when saturated). Wired into the runner by `session/subagents.js`. |

### `db/` · `git/` · `lang/` · `testing/` · `workspace/`

| Folder | Files |
|------|----------------|
| **db/** | **db.js** is the facade (same exports as before) over **db-common.js** (`DbError`, engine catalog), **db-drivers.js** (driver install / connect), **db-connections.js** (live handles, pinned sessions), **db-store.js** (saved connections, sealed secrets), **db-values.js** (typed cells, identifiers), **db-policy.js** (read-only / DDL policy), **db-exec.js** (execution + cancellation), **db-query.js** (query / script / explain), **db-schema.js** (introspection), **db-rows.js** (browse / insert / update / delete), **db-ddl.js** (schema changes); plus **db-io.js** + **db-io-worker.js** (import / export off the main thread), **db-formats.js**, **sqlscript.js** (tokenizer / splitter / classifier). |
| **git/** | **git.js** is the facade (same exports as before) over **git-runner.js** (`GitError`, the process runner, mutation lock, ref validation), **git-status.js** (discovery + porcelain status), **git-commit.js** (staging / commit / discard), **git-remotes.js** (pull / fetch / push / remotes), **git-branches.js** (branches + tags), **git-merge.js** (merge / rebase / cherry-pick / revert / reset / conflict stages), **git-history.js** (diffs, log, compare, archives), **git-stash.js**. |
| **lang/** | **lsp.js** (generic LSP client), **tsserver.js** + **ts-host.js** (TypeScript service in a utility process), **ast.js** (TypeScript-AST analysis for the Test Director). |
| **testing/** | **director.js** (goal → green), **testdir.js** (test catalog + integrity guard), **testhost.js** + **testhost-preload.js** (embedded deterministic browser). |
| **workspace/** | **files.js** (tree, IO, reveal, trash), **search-core.js** + **search-worker.js** (project search in a worker thread), **terminal.js** (integrated shell), **zipper.js** (dependency-free ZIP). |

---

## 2. IPC surface (`src/main/preload.js`)

The renderer accesses everything through `window.atom.*`. Every call is an `invoke()` that unwraps a `{ ok, data } | { ok:false, error }` envelope and throws on error. **Verified top-level namespaces:**

```
app  win  project  settings  auth  updates  providers  models  distill  image
mcp  antigravity  cli  localmind  userdata  dialog  sessions  files  git  ts
editorconfig  graph  convo  convograph  context  capabilities  skills  fleet
director  testdir  testhost  test  lsp  prettier  clipboard  shell  events  agents  workflow
```

- **`atom.agents`** — `list(sessionId)`, `cpu()` (governor snapshot), `stop(sessionId, taskId)`. **`atom.context`** — `info(sessionId)` (fill %, window, learned flag, digest state), `rollover(sessionId, on)`, `digest(sessionId)`, `digestText(sessionId)`.
- **`atom.workflow`** — `get(cwd, sid?)` → `{ active, scope, library, control }`, `set(patch, cwd, sid?)` (deep-merge into the active workflow), `save(name, id, sid?, cwd?)`, `load(id, sid?, cwd?)`, `remove(id, sid?, cwd?)`, `rename(id, name, sid?, cwd?)` (the trailing `cwd` is the project a no-session call addresses — the renderer's captured one; ignored with a `sid`), `duplicate(id, name?)`, `clearSession(sid)`, `exportOne(id, path?)`, `importFile(path?)`, `jobs(sessionId)`, `run(sessionId, { role, task, files, agents, taskRef?, context?, fresh?, fromJob? })`, `stop(jobId)`, `stopAll(sessionId)`, `brief(sessionId)`, `control()`.
- **`atom.tasks`** — `get(sessionId)` → `{ board }`, `add(sessionId, { titles | items, set })`, `update(sessionId, ref, { status, role, title, detail, note })`, `newSet(sessionId, title)`, `remove(sessionId, ref)`; every reply carries the fresh `board`.

Notable namespaces:

- **`atom.sessions`** — `list, create, synthesize, get, messages, rename, update, delete, send, interrupt, running, runState, permissionResponse, openHistory, export, import, retry`. `synthesize(srcId)` forks a fresh session with an adaptive, byte-bounded working handoff, source references, workflow and board (see §3). `runState(id)` returns the backend runner's status, ownership id, stopping flag and live preparation label; renderer Stop reconciliation uses this instead of assuming a timer means the run ended.
- **`atom.providers`** — `authStatus, authorize, catalog, testCustom`. **`atom.models.discover(provider)`** resolves the live model list.
- **`atom.fleet`** — `list, enqueue, enqueueMany, cancel` + `onProgress/onTaskUpdate` events.
- **`atom.skills`** — `list, create, update, remove, importUrl` (the project skill store; its only UI is the Workflow Studio's Skills modal — installed rows with a Planner · Coder · Reviewer checkbox each, Remove, install from a URL or by a CLI command remembered in the `skillInstallMode` setting, an inline manual create form).
- **`atom.director` / `atom.testdir` / `atom.testhost` / `atom.test`** — Test Director surface.
- **`atom.graph / convo / convograph / context / capabilities`** — `peek(...)` inspectors for the memory subsystems.
- **`atom.localmind`** — `probe, recommend, catalog, status, download, installEngine, set, remove, unload` + progress events.
- **`atom.userdata`** — `export(opts)` / `import()` (full backup; see §6).
- **`atom.ts`** — `diagnose`, `req(kind, …)` to the TS utility process. **`atom.lsp`**, **`atom.prettier`**, **`atom.editorconfig`** back editor intelligence.

### Event channels (`atom.events.on*`)

- **Session:** `session:status`, `session:message`, `session:message-update`, `session:partial`, `session:partial-reset`, `session:edited-files`, `session:permission`, `session:live` (preparing / retrying / compacting / waiting states), `session:notice` (CLI notifications, refusal fallbacks, rate-limit events), `session:context` (context fill after each turn / on rollover).
- **Agents:** `agents:update` (one registry record changed — the renderer relabels its Task card, the strip and the Agents panel), `agents:cpu` (governor snapshot while agents are live).
- **Workflow:** `workflow:job` `{ job }` (every job change), `workflow:stage` `{ sessionId, stage, status, jobId?, provider, model }` (the orchestrator session's live stage; `stage` = orchestrator | planner | coder | reviewer | tester), `session:created` `{ view, parentId, role, jobId, autoOpen }` (a child session for a job — the renderer opens its tab next to the orchestrator's without stealing focus), `tasks:update` `{ sessionId, board }` (the whole task board after any change).
- **App/window:** `app:confirm-close`, `win:maximized-change`, `models:update`.
- **Subsystems:** fleet task progress/updates, file-watch `fs:changed`, update progress.

---

## 3. Data model & storage (`store.js`)

### Session (one `<id>.json` in `historyDir`)

```jsonc
{
  "id": "hex", "name": "…", "cwd": "<project folder>",
  "model": "claude-opus-4-8", "permissionMode": "acceptEdits",
  "thinking": "off", "oneM": false,
  "claudeSessionId": "<CLI resume id|null>",
  "status": "idle", "createdAt": "ISO", "updatedAt": "ISO",
  "messages": [ /* user/assistant/thinking/tool/result/system/error */ ],
  "editedFiles": [ { "path", "count", "added", "removed" } ],
  "totalCostUsd": 0
}
```

**Sidecars** (same dir): `<id>.convo.json` (pruned session memory) and `<id>.archive.jsonl` (messages dropped past the message cap, one per line).

### Settings (`settings.json` in userData)

- **Provider/model:** `llmProvider`, `defaultModel`, `defaultThinking`, `customApiBaseUrl`, `customMode`, `customEndpoint/Headers/PayloadTemplate/OutputPath`, **`customEndpoints[]`** (each with its own `apiKey`), `customModels[]`, `discoveredModels[]`.
- **Secrets:** `apiKey` (Anthropic), `openaiApiKey`, `geminiApiKey`, `customApiKey`, `useEnvApiKey`.
- **Workspace:** `historyDir`, `lastFolder`, `projects{}` (per-project tab/editor state + `tagColor`), `openWindows[]`, `recentProjects[]`, `windowBounds`.
- **Per-project overrides:** `projectSettings[projectKey]` overrides global for model/thinking/editor/agent toggles — **except `GLOBAL_ONLY`** keys (all secrets, `customEndpoints`, `claudePath`, `historyDir`, `windowBounds`, `projects/openWindows/lastFolder/recentProjects`, `discoveredModels/customModels`, `localOptimizer`, `projectSettings`).

### Other per-project stores (userData)

`graphs/<projectKey>.json` (memory graph) · `skills/<projectKey>.json` (project skill store) · `tests/<projectKey>.json` (test catalog) · `fleet.json` (shared task queue).

### `synthesize` (fork-with-context)

Preparation owns the source session's run slot. Repeated Synthesize clicks share one job, the live label reports summary progress, and Stop cancels preparation without creating a continuation later. Completion changes the source status only while that job still owns the slot. The renderer reconciles Stop against `sessions:run-state`; elapsed time never serves as proof that a run ended.

Digest, transfer and synthesis preparation for the same session share a cancellable queue and reuse completed summary checkpoints. Calls and total preparation time are bounded, including queue wait. Provider callbacks and native-thread changes are scoped to their run so a stopped request cannot overwrite a replacement. Measured context windows and usage survive session reloads.

`sessions:synthesize` creates a **new** session with one model-visible `record` entry. Small records remain exact; long records become 12–32 KiB of adaptive working context (UTF-8, including the wrapper), with cached decisions, selected requests/outcomes, task state, a session map and references to the full source. Cached summaries are reused immediately across providers/models/accounts; cold preparation makes at most one summary request with at most 32 KiB of selected evidence and a 20-second deadline. A failed, empty or slow summary uses labelled local evidence. Stop still aborts. The whole preparation, including queue wait, is capped at 30 seconds. The canonical record is never modified. See [context policy](docs/CONTEXT.md).

---

## 4. Providers & model invocation

`providers.js` holds a `CATALOG` keyed by provider, each with `{ label, reasoning, reasoningLevels, defaultModel, primary, models[] }`.

| Provider | Primary path | Reasoning | Notes |
|----------|--------------|-----------|-------|
| **Anthropic** | SDK (`claude.run`) | thinking levels | Concrete model ids discovered from the `claude` CLI and prepended to the list. |
| **Google (Gemini)** | ACP via `agy` (or legacy `gemini`) | thinking levels | agy has a non-TTY stdout bug → `--log-file` / `agyDb` recovery. |
| **OpenAI (Codex)** | CLI (`codex exec`) — currently via council path | effort levels | Live model list from API. |
| **Custom** | SDK (Anthropic-compatible base URL) or raw HTTP template | per-config | `customEndpoints[]` take precedence over legacy `customModels`. |

Discovery order: static catalog → CLI discovery (Anthropic) → API discovery (OpenAI/Google) → custom endpoints. `context1M(provider, modelId)` reports 1M-context support (Anthropic: Opus/Sonnet 4.6+ and Fable yes, Haiku no).

Context capacity follows the selected model automatically. Discovery retains numeric windows for both existing and new model IDs, and `get()` exposes those same capacities to summaries, transfers and role jobs. A legacy `oneM: false` does not reduce a supported 1M model to 200K. Codex uses the larger of its installed catalog's default and maximum supported window and configures both native transports; reported usable capacity is measured separately to avoid shrinking the window on each turn. Cached input is a subset of input tokens and counted once. Published fallbacks are used only when no native catalog is available; custom endpoints can declare `ctx` / `contextWindow`. Actual provider measurements and rejection limits remain scoped to the model and run that produced them.

**Reviewers** (any provider) run through `council.reviewerRun()` regardless of the primary.

---

## 5. Renderer (`src/renderer/`)

Vanilla ES modules, no framework. **`index.html`** is the static shell — `#titlebar`, `#sidebar` (folder bar + file tree), `#editorPane`, `#main` (chat header with session tabs + chat + composer), the right docks (`#changesPanel`, fleet / tests / agents / board), and the global overlays `#ctxMenu`, `#modalRoot`, `#toast`. It links the stylesheet partials in cascade order and loads **`app.js`** as the entry module. The former single 10.9k-line `app.js` is split by feature:

| Module | Responsibility |
|------|----------------|
| **app.js** | Entry: `init()` boots the window (title-bar controls, settings, models, project, tabs, editor state, events, keys) and registers the smoke-test hooks (`window.__*`). |
| **core/state.js** | The shared `state` object, `activeTS()`, and `atom` (the IPC bridge). |
| **core/dom.js** | `h(tag, props, ...kids)`, `$`, `toast`, tooltips, `dropdown`, context menu, `openModal` / `modalShell`, confirm / prompt / choose dialogs. |
| **core/catalog.js** | Provider / model / thinking / permission catalogs behind the composer dropdowns; discovered + custom models (`loadProviderModels`, `setDiscoveredModels`). |
| **core/theme.js** · **core/keys.js** | Themes, accent, font size, the per-project taskbar tile · global shortcuts and the pane resizers. |
| **chat/tabs.js** | Session tabs (the chat header), per-tab state (`addTabState`, `MEM_CAP`), the header "More" menu. |
| **chat/composer.js** | Prompt box, dropdowns, the **Agents** control ("Agents · N" = running now; compact popover: sub-agents switch + 1–20 cap on one row, opt-in "yield to heavy processes", one slots line, the running list — a row opens the drawer on that agent), the **context chip** (fill %, rollover threshold, digest), the 1M indicator (a label, no checkbox), the running-agents strip (chips open the drawer), attachments, prompt queue, `send()` (Stop is the primary button while a turn runs; Enter = send now, Ctrl+Enter = queue). Roles and Reviewers open from the chat header's ⋮ menu (Reviewers moved there 2026-09-17); a plain chat has no skills UI since 2026-09-18 — skills are attached to workflow roles in the Studio's Skills modal. |
| **chat/navigation.js** | The paginated message window, Ctrl+F find, prompt timeline, synthesize. |
| **chat/messages.js** | Message / tool / thinking / result cards, the live stream region, permission cards (title, agent chip, decision reason), scroll follow (`_followTail` + `setFollowTail`). Sub-agent Task cards carry the agent number (hue per agent), type chip, live progress line, orbit animation and an ⓘ popover with the agent's purpose / brief / timings / result; nested output is rail-labelled `#n`. |
| **chat/events.js** · **chat/history.js** | Every `atom.events.*` subscription (messages, status, partials, permissions, fleet, auth, network) · the History modal. |
| **git/titlebar.js** · **sidebar.js** · **branches.js** · **diff-viewer.js** · **conflicts-ui.js** | Git toolbar (pull / commit / push), repo discovery + status + commit view, branches & merge, diff + compare overlays, the merge-conflict resolver. |
| **git/center/** | The Git Center (was the single `gitcenter.js`): **index.js** (`openGitCenter`, `changeText`, `__gitcInternals`), **state.js** (deps, `S`, per-repo state, helpers), **widgets.js** (pickers, split pane, virtual list, diff pane, file rows), **shell.js** (open / close, keys, event subscriptions, op log), **repos.js** (repo + status loading, selection, refresh), **actions.js** (`act`, busy state, error details, resolver hand-off), **ops.js** (merge / rebase / checkout / branch / push / pull / stash / reset flows), **render.js** (bars, tabs, compare mode, `renderMain`), **compare.js**, **changes.js** (tree + virtual changes list), **history.js**, **branches.js** (branches / stashes / tags / remotes). |
| **db/** | The Database Manager (was the single `dbm.js`): **index.js** (`mountDbManager`, `__dbmUtils`), **state.js** (deps + the manager's shared state with setters), **utils.js**, **cells.js** (typed cells, exports to CSV / JSON / MD / TSV), **grid.js** (`vlist` / `vgrid` virtualised grids), **health.js** (connection status polling), **workspace.js** (tabs, modes, execution log), **connections.js** (connection form), **sidebar.js** (objects tree, menus, schema loading), **query.js**, **results.js**, **jobs.js** (import / export), **browse.js**, **structure.js** (schema-change plans). |
| **workspace/sidebar.js** · **projects.js** · **terminal.js** | File tree + file viewer, project windows / recents / persisted tab & editor state, the integrated terminal. |
| **panels/changes.js** · **fleet.js** · **tests.js** · **agents.js** · **board.js** | The right docks (the Skills library dock `panels/skills.js` was removed on 2026-09-18). `agents.js` is the Agents panel: live agents, history grouped by turn, a timeline (Gantt) view, the CPU meter (`renderCpuMeter`) shared with the composer popover. `board.js` is the Task board dock (§8): the active set expanded, finished sets collapsed, task rows with status / role / linked jobs / notes, user actions (add, new set, rename, status, delete), live via `tasks:update`. |
| **workflow/** | The Workflow studio (§8): **index.js** (the export contract), **studio.js** (overlay shell — name / rename, unsaved marker, Enabled, the Skills modal — the only skills UI: installed skills with a Planner · Coder · Reviewer checkbox each, Remove, install from a URL or by a CLI command, an inline create form —, Presets and Library menus with save / load / rename / duplicate / delete / import / export, the orchestrator-brief drawer, the CLI popover with `--from` examples), **canvas.js** (SVG canvas: the Orchestrator primary + four worker cards, cubic edges, a sub-agent lane per role with its stepper — on any provider, drag with 8 px snap persisted to `layout`, the live layer — rings, glow, particles, orbiting sub-agent orbs, finish badges), **inspector.js** (per-role editor: enabled · provider · model · effort · access · agents · command, the role's jobs with Open tab / Stop), **live.js** (job / stage state from `workflow:job` / `workflow:stage`, the rAF scheduler, the composer chip), **model.js** (defaults, mirroring into `state`, dirtiness), **presets.js** (Solo · Plan → Code · Plan → Code → Review · Full orchestra · Claude plans, Codex codes · Codex plans, Claude codes). Job cards live in `chat/messages.js` (`jobCard`), child tabs get a role badge in `chat/tabs.js`, and `chat/history.js#openSessionTabQuiet` opens a job's tab without stealing focus. |
| **settings/** | The Settings modal, one module per page: **settings.js** (shell — grouped categories, cross-page search with highlighted labels, footer; also the DBM wrapper around `db/index.js`), **controls.js** (`field` rows, `section`, `toggle` switch, `boolSetting`, `segmented`, `inlineSelect`, `stepper`, `kvGrid`), **providers.js** + **provider-modal.js** + **updates.js**, **agent.js** (Agent defaults · Agents & context · Agent SDK pages), **appearance.js**, **editor.js**, **integrations.js** + **mcp.js**, **storage.js**. Every page returns `{ id, label, ic, group, blurb, items() }`. |
| **editor/editor-pane.js** · **symbols.js** · **checkpoints.js** · **search-palette.js** | Code editor UI (tabs, split panes, save, untitled buffers), document symbols / breadcrumbs / go-to-symbol, checkpoints, the search palette. **`editor/cm-src.js`** is bundled by esbuild into `cm.bundle.js` + `cmchunk/*` (generated — never hand-edit) and lazy-loaded on the first editor surface. |
| **markdown.js** · **icons.js** · **diff.js** · **conflicts.js** | Markdown renderer, inline SVG icon set (`icon(name, size, class)`), unified-diff parsing, conflict-marker parsing. |

**Module rules.** Every top-level declaration is exported and modules import exactly the names they use. A module-level `let` is assigned only inside its own module — other modules call its setter (`setFollowTail`, `setFleetSnap`, `setFleetDraft`, `setDiscoveredModels`, the `db/state.js` and `git/center/state.js` setters). Dynamic `import()` paths are relative to the importing module's folder. No module-level code depends on another module's `const` at load time (import cycles are fine for functions only). `node scripts/check-renderer.js` serves the folder to headless Chromium and fails on any module-graph error (missing export, syntax, read-before-init); the UI suites extract the original functions by name through `scripts/lib/renderer-src.js` (`fn`, `block`, and `folderSource(dir, order)` which concatenates a split folder in dependency order for the DB / Git Center suites).

**Styles** (`styles/`): the former `styles.css` split at its section banners into `00-base.css … 98-dbm-updates.css` (plus `65-agents.css` — agent badges, orbit animation, popovers, strip, dock, context chip — and `72-settings.css` — the Settings modal's two-pane layout, rows, switch); the numeric prefix is the load order, which is the cascade order — keep new rules in the partial that owns the feature and never reorder the prefixes. CSS custom properties on `:root` (`00-base.css`) switched by `html[data-theme="amber|ember|gold|rose|gunmetal|gray|blue|light"]`; accent-derived colours via `color-mix`.

---

## 6. Build, packaging & backup

### Scripts (`package.json`)

- `icon` → generate `build/icon.ico` from PNG.
- `build:cm` → esbuild `cm-src.js` → `cm.bundle.js` (+ `cmchunk/[hash]`) and `cm-worker.js` → `cm-worker.bundle.js` (esm, minified, `--target=chrome120`).
- `pack` → `electron-builder --win --dir` (unpacked). `dist` → `electron-builder --win` (NSIS installer).

### `electron-builder.yml`

```yaml
appId: com.atomailabs.atomnano
productName: AtomNano
copyright: Copyright © 2026 Atom AI Labs
asar: false        # SDK is ESM + spawns native binaries → asar breaks resolution
files:             # exclude dist/scripts/smoke-tests/maps + the SDK's platform binaries
win:  { target: [{ target: nsis, arch: [x64] }], icon: build/icon.ico,
        artifactName: ${productName}-Setup-${version}.${ext} }
nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
        deleteAppDataOnUninstall: false }
```

**exe metadata mapping:** Company name ← `package.json` `author.name`; Product name ← `productName`; Copyright ← `copyright`; Version ← `package.json` `version`. Installer publisher ← `win.publisherName` (falls back to `author.name`). The ~236 MB bundled SDK platform binaries are **excluded** — AtomNano drives the user's installed `claude` CLI.

### Backup (`atom.userdata.export`)

A **full personal migration archive** (zip). Always includes: **all settings except machine-local keys** (`windowBounds`, `historyDir`, `claudePath`) — i.e. themes, custom models, **API keys**, **`customEndpoints` with tokens** — plus **provider login files** (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json` + `google_accounts.json`) and the project **skills** store (project data, restored with the rest). The Backup dialog offers "app data only" vs "+ agent sessions" (the latter also bundles transcripts + `.convo.json`/`.archive.jsonl`). The zip contains secrets in plaintext — keep it private.

---

## 7. Process model & lifecycle (`main.js`)

1. **Portable mode** (before `store` loads): a `portable.flag`/`AtomNano-Data` folder next to the exe redirects userData and `CLAUDE_CONFIG_DIR` there, copying credentials in.
2. **Single-instance lock**: a second launch focuses/uses the existing instance.
3. **Window-per-project**: each `BrowserWindow` is one project folder; `openWindows` are restored on boot; bounds persisted.
4. **IPC registration** via `handle(channel, fn)` (`ipc/index.js`) → returns `{ ok:true, data }` or `{ ok:false, error }`; preload's `invoke()` unwraps/throws. `registerAll(ctx)` runs once in `app.whenReady`; each `ipc/<domain>.js` registers its own channels. |
5. **Broadcast/emitter**: `claude` (and fleet, etc.) `setEmitter()` → `broadcast(channel, payload)` fan-outs to every live window, so other windows see updates.
6. **File watching**: one recursive watcher per window root, coalesced, emitting `fs:changed`.
7. **TS utility process** spun up on demand and idle-killed; search runs in worker threads — heavy work stays off the main thread.

### Turn run loop (`session.run`)

1. Renderer `atom.sessions.send` → `sessions:send` → `session.run(id, payload)` (`src/main/session/index.js`).
2. Build options (cwd, model, permission mode, effort, model-selected 1M beta, `resume` = the native session id); the user's exact text first, explicit workflow data (a role child's attached skills, reviewer advice, plan) after it; whatever record the thread has not seen travels via `session/transfer.js`. Skills and briefs are sent once per native thread (2026-09-18): each turn hashes its skill snapshot (`skillsHash` over the project key and the sorted `[id, updatedAt]` pairs) and, on Codex, its role / agents brief (`briefHash`); the binding caches the hashes the thread ACCEPTED (Codex app-server `onTurnId`, Codex exec thread id + `turn.started`, Claude `system/init`), and later turns send the full procedures only when the hash changed — otherwise one pointer line, or one clearing line when the set became empty. Claude's briefs stay in `systemPrompt.append`; stateless custom HTTP resends the full digests every request; Claude's `skills` query option is omitted, so native Claude skills follow the CLI defaults.
3. Stream `query()` messages → normalize to `session:message`, `session:partial`, tool cards, `session:edited-files`; tool calls gate through `canUseTool` → `session:permission` → renderer modal → `sessions:permission-response`.
4. **Resilience:** errors are classified — *transient* (network/429/529/5xx) retries with exponential backoff **keeping `claudeSessionId`** (context preserved); only a genuine "session not found" triggers a single fresh retry; exhausted retries surface an error but **never drop the resume id**, so a resend continues seamlessly.
5. On finish: persist the transcript (archive-first cap → `.archive.jsonl`), acknowledge the thread's cursor, emit `session:status`.

---

## 8. Workflow — the Orchestrator as primary (2026-09-16; the Orchestrator above the Planner since 2026-09-17)

A **workflow** assigns a model — provider · model · effort · **access** (Full access by default, Accept edits, Ask, Read-only) — to each **role**: the **Orchestrator** (the primary) and its four workers Planner, Coder, Reviewer, Tester, plus a **sub-agent lane** (0–20 agents) per worker role — on any provider (Claude roles get the Task tool with the lane as `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, Codex roles get Codex's multi-agent feature with the lane as `agents.max_concurrent_threads_per_session`). Workflows have a name and live in a global **library** (save / load / rename / clone / delete / import / export as JSON); the **active** workflow is chosen **per chat tab** (`session.workflow`, 2026-09-18 — each tab picks independently; the studio's Library menu loads, saves as or clones "for this tab"), falling back to the project's active workflow (`settings.workflow`) for tabs that never chose; `settings.workflows` is the library. The user designs them on the **Workflow studio** canvas (`src/renderer/workflow/`, §5). A workflow saved before the Orchestrator existed (the primary's picks under `roles.planner`) is migrated on read: those picks move to `roles.orchestrator`, and the Planner takes the worker defaults (`migrateLegacyPrimary` in `session/workflow.js`, `ipc/workflow.js` and `renderer/workflow/model.js`).

**The task board (session level).** Every orchestrator session owns one board (`session.tasks`, persisted, copied by synthesize): the Orchestrator creates the tasks first (`atomnano tasks add … --set "<title>"`), starts / finishes them as it goes, hands one to a role with `--task T12` (the job links to it: todo → doing / review / test, and the job's end leaves a note), and a task can be sent to the Planner, the Reviewer or the Tester as the work requires. Tasks are numbered `T1, T2, …` across the session and grouped into **sets**: when every task of the current set is finished and new tasks arrive, they open a new set with its own title, so a long session reads as "Set 1 · Payments · 20 tasks · done", "Set 2 · Notifications · 3 / 8". The **Board dock** (`panels/board.js`) shows the active set expanded and finished sets collapsed, with user actions (add, new set, rename, status, delete); the planner's chat shows one live checklist card per set (`role: "tasks"`); the composer chip shows the active set's progress. Main: `session/tasks.js` (`boardFor`, `addTasks`, `updateTask`, `openTaskSet`, `removeTask`, `taskInfo`, `boardSummaryText`, `linkJobToTask`), events `tasks:update`.

**The Orchestrator is the primary.** While the active workflow is enabled, the model the user chats with runs with the orchestrator role's picks and receives the **orchestrator brief** (generated from the roles table, or the user's override) — on Claude as `systemPrompt.append`, on Codex / custom as a labelled appendix after the user's text. The brief tells it that it manages, orchestrates and monitors every other role and how to triage: simple requests (questions, summaries, explanations, advice, any non-coding work) it answers itself with no roles and no board; a small, clear code change goes straight to the Coder; for larger or unclear coding work it has the Planner draft the plan (`atomnano plan "…" --wait --timeout 540`, a read-only worker whose sub-agent lane is for parallel investigation), decides on it and hands it to the Coder with `--from <planner job id>` — the planner job's SAVED result is appended to the Coder's task as one labelled block; after code changes the Reviewer and the Tester check the result (both at once), fix-ups go straight back to the Coder with `--from <reviewer job id>`; it keeps the task board current for delegated multi-step work, monitors the jobs (waiting with `--wait --timeout 540`, then `atomnano wait <id> --timeout 540`, its shell tool at 600 s) and reports — all through the `atomnano` CLI, which it runs from its Bash tool; the CLI reaches the **control server** (`control/server.js`), which calls `session/workflow.js`. The generated brief is compact (≈3,150 characters with the default roles; every rule kept). Each delegation is a **job**: a child session (`parentId` → the orchestrator, `role`, its own `provider`) run through the ordinary `run()` path with that role's model / effort / access, lane and attached skills, so permissions, Stop, the record and provider continuity work exactly as for any tab; a command job runs a shell command in the project folder. A job carries its task text, then (with `--from`) the source job's saved result — resolved through `jobsFor` over the live registry and the persisted history, same orchestrator only, ended jobs only, refused before any side effect otherwise —, then the board task line, the files of interest and, with `--context`, the orchestrator's conversation so far condensed like a synthesized handoff (`synthesizeSeed`: cached memory reused, selected recent evidence, source retrieval, session map, board). Job results return to the orchestrator as the CLI's output; the orchestrator's chat shows one `role: "job"` card per job (status, elapsed, result preview, edited files, Open tab / Stop), each job has its own tab with a role badge, and the studio animates the roles while they work. With `workflow.enabled === false` nothing changes for any turn — the briefs are an explicit, user-designed workflow, never a hidden layer (harness: `scripts/test-workflow.js`, `scripts/test-workflow-cli.js`, `scripts/test-workflow-skills.js`, `scripts/test-tasks.js`, `smoke-tests/test-workflow-studio.js`). Until 2026-09-17 the Planner was the primary; the user moved every managing / orchestrating / monitoring duty to the new Orchestrator node above it, and the Planner became a worker that plans. The workflow and the composer's solo sub-agents are **exclusive** (2026-09-18): turning one on asks and turns the other off (`workflow/model.js setWorkflowEnabled` / `chat/composer.js setSoloAgents`), the orchestrator's own turn never gets the Task tool, and turning the workflow off only flips `enabled` on the tab's own copy so the chip's switch turns it straight back on. A solo turn carries a one-sentence **mode note** (`session/workflow.js modeBrief`; `settings.modeNote`) so the model knows the workflow is off and whether solo sub-agents are on — and, when the workflow was switched off mid-work, the open board items and recent jobs to continue from itself.

---

## 9. Conventions an AI should follow when editing

- **UI is vanilla JS** — build DOM with `h()`; reuse `modalShell`, `dropdown`, `toast`, `confirmDialog`, `showContextMenu`. No frameworks, no inline styles where a CSS class exists; respect the `--var` theme tokens (never hardcode colors).
- **All renderer↔main traffic goes through preload** — add a namespaced method in `preload.js` + a `handle()` in the domain's `src/main/ipc/<domain>.js` (a new domain = a new module listed in `ipc/index.js`); never expose Node directly to the renderer.
- **Persistence** goes through `storage/store.js` (sessions/settings) or the dedicated subsystem store (skills/testdir/fleet). Keep new secret-ish settings in `GLOBAL_ONLY`.
- **Provider work** belongs in `providers/` (`catalog.js`, `custom-api.js`, `council.js`, the Codex transports); the Claude turn lives in `session/anthropic.js` + `session/anthropic-events.js`, the Codex turn in `session/openai.js`. Preserve the resilience contract (never drop a native thread binding on a transient error). New session methods go in the concern's module and are picked up by `session/index.js`.
- **Editor changes** edit `cm-src.js`, then run `npm run build:cm` (the committed `cm.bundle.js` is generated — never hand-edit it).
- **Heavy/optional deps** (Prettier, TypeScript, CodeMirror, localmind models) are lazy-loaded — keep them off the startup path.
- After backend changes run `npm test` (module-load check, session suites, UI suites); after UI changes also run `node scripts/check-renderer.js` and a smoke test (`npm run test:appearance-e2e` boots the real app). New renderer code goes in the feature's module under `src/renderer/<area>/`, styles in the owning `styles/NN-*.css` partial.

---

*Generated as a context briefing. File paths and the IPC namespace list were verified against the source tree; catalog-level details (per-module function names) reflect the modules' documented responsibilities.*
