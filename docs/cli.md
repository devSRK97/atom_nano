# AtomNano CLI (`atomnano`)

The `atomnano` command is the **hands of the Orchestrator**. In a workflow the model you chat with (the
Orchestrator) manages, orchestrates and monitors the worker roles — Planner, Coder, Reviewer, Tester —
by running these commands from its Bash tool; you can run the same commands from any terminal while the
app is open. The CLI never talks to a model itself: it calls the **running app** over a local control
server (`127.0.0.1`, per-launch token), and the app runs each delegated task as a **job** — a child
session with that role's provider, model, effort, access and sub-agent lane, visible as its own tab next
to the orchestrator's. (Until 2026-09-17 the Planner was the primary; it is now a worker that drafts
the plan, and the Orchestrator above it took over every controlling duty.)

The former headless CLI (`atomnano run "prompt"`, which started Electron without a window) was
removed on 2026-09-16 and replaced by this one.

---

## 1. Where it works

- **Inside the app's own processes — nothing to install.** The app exports `ATOMNANO_CONTROL`,
  `ATOMNANO_TOKEN` and `ATOMNANO_NODE` to every process it starts and puts its `bin/` folder first on
  their `PATH`: the Claude CLI behind the Orchestrator's Bash tool, Codex, the integrated terminal.
- **From an outside terminal** the CLI finds the app through `<userData>/control.json` (written at
  start, removed at quit). To have `atomnano` on your own PATH: Settings → Integrations →
  **Command-line interface** → On (runs `npm link`), or `npm link` in the app folder, or run it in
  place with `node bin/atomnano.js …`.
- The shims `bin/atomnano.cmd` (Windows) and `bin/atomnano` (sh) run the script with the app's own
  runtime (`ATOMNANO_NODE`, Electron run as Node) when the app exported it, else with `node`.

---

## 2. Commands

```
atomnano status                              app, your orchestrator session, the active workflow, its jobs
atomnano roles                               the role table (provider / model / effort / access) — the orchestrator first
atomnano run <role> "<task>" [--from JOB] [--files a,b] [--agents N] [--context] [--fresh] [--wait] [--timeout s] [--session ID] [--json]
atomnano plan "<request>" ...                = run planner (drafts the implementation plan; read-only)
atomnano coder "<task>" ...                  = run coder
atomnano review "<task>" ...                 = run reviewer
atomnano test ["<task>"] [--cmd "npm test"]  tester job; with --cmd a plain command job (stdout+stderr, exit code)
atomnano jobs [--session ID] [--json]        jobs of the orchestrator session
atomnano job <id>                            one job: state, model, files, result head
atomnano wait <id> [--timeout s]             block until the job ends; prints its result
atomnano result <id>                         the finished job's result text
atomnano log <id> [--tail n]                 recent transcript of the job's session
atomnano stop <id> | stop --all              stop a running job / every live job of the orchestrator
atomnano sessions | providers | models [-P provider]
atomnano help | version
```

Options: `--session ID` (the orchestrator session; default `$ATOMNANO_SESSION`, else the single running
orchestrator), `--wait` (block until the job is terminal and print its result text; implied by
`--timeout`), `--timeout s` (return after s seconds with the job still running — from a shell tool with a
600 s limit use 540, see §8), `--from JOB` (append that finished job's saved result to the task — a Planner's
plan or a Reviewer's findings handed to the Coder, see §9), `--files a,b` (files the role should look at first),
`--agents N` (the role's sub-agent lane for this job, 0 = solo — on any provider), `--task T12` (link the job to a
task on the board), `--context` (hand the role the orchestrator's conversation so far, condensed exactly like a
synthesized handoff: cached working memory, selected recent evidence, source references, the session map and the
board), `--fresh` (a new session for the role instead of its persistent one), `--json` (the server's JSON reply,
for every command). Roles accept the aliases `plan`, `code`, `review`, `test`. `atomnano run orchestrator` is
refused — the orchestrator is the calling session.

### Read saved context

The full transcript stays in its source session even when a handoff is compact. Retrieval is read-only and uses the same authenticated local control server:

```sh
atomnano context search "account switch" --session ID --limit 12 --json
atomnano context read 123 --session ID --json
atomnano context read MESSAGE_ID --session ID --offset 8192 --limit 8192 --json
```

Search includes archived messages and recorded tool inputs/results. Continue with `--before` using `nextBefore`. Read accepts a zero-based global index or stable message ID; continue with `--offset` using `nextOffset`. Read pages default to 8 KiB and allow 64 bytes–32 KiB. Search returns up to 50 bounded snippets. No provider request is made by these commands. [Context policy](CONTEXT.md).

### Task board (one board per planner session)

```
atomnano tasks [--all] [--json]                         the board: the active set expanded, finished sets one line each
atomnano tasks add "title" ["title" …] [--detail "…"] [--role coder] [--set "New set title"]
atomnano tasks set "Title"                              open a new set now (a new batch of work)
atomnano tasks start|done|review|test|block|drop T12 [--note "…"]
atomnano tasks note T12 "text"    atomnano tasks show T12    atomnano tasks sets
atomnano tasks edit T12 [--title "…"] [--detail "…"] [--role reviewer]   ·   atomnano tasks reopen T12
atomnano run coder "…" --task T12                       the job is linked to the task (todo → doing / review / test)
```

Tasks are numbered `T1, T2, …` across the session and grouped into **sets**. When every task of the
current set is finished and new tasks arrive, they open a new set with its own title; `tasks set`
opens one explicitly. Sample:

```
$ atomnano tasks add "Design schema" "Build API" "Write tests" --set "Sprint 1"
added 3 tasks → Set 1 · Sprint 1
  T1  todo  -  Design schema
  T2  todo  -  Build API
  T3  todo  -  Write tests
$ atomnano tasks done T1 --note "schema in db/schema.sql"
T1  done  -  Design schema
$ atomnano tasks
Set 1 · Sprint 1 · 1/3 done · active
  T1  done  -  Design schema
  T2  todo  -  Build API
  T3  todo  -  Write tests
```

A child session (a coder / reviewer / tester job) that runs `atomnano tasks …` updates its orchestrator's
board, signed with its role. A job started with both `--task T12` and `--from <id>` receives the source result
first and the task line after it (§9).

Exit codes: **0** ok · **1** usage or server error · **2** AtomNano is not running · **3** the awaited
job failed or was stopped.

---

## 3. Typical orchestrator session

```bash
atomnano roles                                   # what each role runs on
atomnano plan "Add input validation to src/api.js without changing the error shape" --wait --timeout 540   # the Planner drafts the plan → job-1
atomnano coder "Implement the plan" --from job-1 --wait --timeout 540        # the saved plan travels with the task
atomnano review "the changes in src/api.js" --wait --timeout 540            # → job-3
atomnano coder "Address the review findings" --from job-3 --wait --timeout 540
atomnano test --cmd "npm test" --wait --timeout 540   # a plain command job: output + exit code
atomnano jobs                                    # everything this orchestrator started
atomnano stop j3                                 # a job that went astray
```

A job's result comes back as the command's output, so the Orchestrator reads it like any tool result.
Without `--wait` a job keeps running in the background; `atomnano wait <id> --timeout 540` catches up later.
A waited job that has not ended after the timeout prints one line — `job job-2 still running after 9m 0s · coder —
atomnano wait job-2 --timeout 540` (a paused child reads `running (paused: offline)`) — and exits 0; `--json`
prints the job object instead.

---

## 4. Control server (for tooling)

`GET /v1/ping · status · roles · sessions · providers · models`, `POST /v1/jobs` (body `taskRef` links
a task; body `from` names the finished job whose saved result travels with the task — the manager receives it
as `fromJob`; blank → 400, not this session's job → 404, not ended → 400), `GET /v1/jobs`, `GET /v1/jobs/:id[/wait|/log]`
(`wait?timeout=` is capped at 600 s), `POST /v1/jobs/:id/stop`, `POST /v1/jobs/stop-all`, `POST /v1/tests`,
and the board: `GET /v1/tasks[?all=1]`, `POST /v1/tasks`, `POST /v1/tasks/sets`, `GET|PATCH /v1/tasks/:ref`
— all JSON, `Authorization: Bearer <token>`, bound to `127.0.0.1`. The URL and token are in
`ATOMNANO_CONTROL` / `ATOMNANO_TOKEN` (or `control.json`). Contract: `docs/WORKFLOW_CONTRACT.md`.

---

## 5. Troubleshooting

- **exit 2 "AtomNano is not running"** — start the app; from an outside terminal make sure the same
  user profile is used (`ATOMNANO_USER_DATA` when the app runs with an isolated profile).
- **"specify --session"** — more than one orchestrator is running, or the caller is a Codex orchestrator (no
  per-session env). Pass `--session <id>`; the orchestrator brief tells the model its id.
- **A job never finishes** — `atomnano job <id>` shows whether its child turn is paused (offline,
  login, rate limit); `atomnano stop <id>` ends it.

## 6. Role sessions and stopping (2026-09-17)

A role keeps ONE session per orchestrator: `atomnano coder "next task"` runs in the Coder's existing tab, so its
native thread resumes and it remembers what it did before. A role whose session is still busy gets a second
tab; `--fresh` forces a brand-new session for that job. Every role has its own sub-agent lane (`roles.<role>.agents`
in the Workflow studio, `--agents N` for one job) and is told to use it in parallel when the task divides.

Stop on the orchestrator's turn leaves the jobs running with their sub-agents — the next orchestrator turn picks their
results up with `atomnano jobs` / `atomnano wait <id>`. To end every job of the orchestrator: `atomnano stop --all`
(or "Stop all jobs" in the Workflow studio). With the workflow **off**, `atomnano run …` and `atomnano test …`
are refused: the conversation runs solo.

## 7. The Orchestrator above the Planner; lanes on every provider (2026-09-17, evening)

The **Orchestrator** is the primary — the model you chat with — and it owns every managing, orchestrating and
monitoring duty: it has the **Planner** (now a worker role, read-only by default) draft the plan with
`atomnano plan "…" --wait`, decides on it, delegates the implementation to the Coder, has the Reviewer and the
Tester check the result, keeps the task board current and reports. `atomnano roles` lists the orchestrator first
("the calling session — you"); `atomnano sessions` shows root sessions as `orchestrator`; the board's default
actor (`by`) is `orchestrator`.

The Orchestrator's brief triages each request: simple ones (questions, summaries, explanations, advice, any
non-coding work) it answers itself with no roles and no board; a small, clear code change goes straight to the
Coder; the Planner is used for larger or unclear coding work, and its plan is handed to the Coder with
`--from <planner job id>`; review findings go back to the Coder with `--from <reviewer job id>` (§9).

A role's sub-agent lane now counts on **every provider**: a Claude role gets the Task tool with the lane as its
cap, a Codex role gets Codex's own multi-agent feature (`features.multi_agent` on, `agents.max_concurrent_threads_per_session`
= the lane; a lane of 0 turns the feature off for that job). The Workflow studio no longer says "Claude only" —
the stepper, the lane and the "N agents" chip work for the Reviewer on OpenAI exactly as for the Coder on Claude.

Skills: a project's AtomNano skills reach the Planner, Coder and Reviewer sessions **only** through the Workflow
Studio's Skills modal (one checkbox per role); a plain chat has no skills UI. Native Claude skills follow the
Claude CLI's own defaults — AtomNano passes no skills option of its own.

## 8. Waiting: 540 s slices under a 600 s shell timeout (2026-09-18, evening)

The Orchestrator runs the CLI from a shell tool whose own time limit is typically 10 minutes. The brief therefore
says: run with `--wait --timeout 540` (the command returns after 540 s while the job keeps running), then repeat
`atomnano wait <id> --timeout 540` until the job ends, and set the shell tool's timeout to 600 s for these calls.
Internally the CLI long-polls the server in 240 s slices (`SLICE_S`; a `--timeout 540` becomes 240 + 240 + 60 s
requests, each with its own HTTP timeout) under the server's unchanged 600 s cap (`MAX_WAIT_S`). A job still
running when the timeout passes prints one short line and exits 0 (see §3); the brief's CLI examples no longer
carry `--json`, which remains available on every command.

## 9. Handing one job's result to the next role: `--from` (2026-09-18, evening)

`atomnano run coder "Implement the plan" --from job-123` appends the **saved result** of job `job-123` to the
task the Coder receives:

```
Implement the plan

Result of planner job job-123 (the plan):
<the planner job's saved result>
```

The block comes right after the task text, before the board task line (`--task`), the files (`--files`) and the
`--context` block. A Planner source is labelled `(the plan)`, a Reviewer source `(the review findings)`, anything
else `(the result)` (a command job reads `command job`). The source must be a job of the **same** orchestrator
(live or in its persisted history) that has **ended**: `done`, `error` and `stopped` are accepted and an
unsuccessful end is named in the label — `(the plan — the job ended in error: Exit code 3.)`, `(the result — the
job was stopped)` — while an empty saved result reads `(empty result)`. What travels is the job's saved
`result` exactly as `atomnano result <id>` prints it (trailing whitespace dropped, nothing expanded or cut) —
never the later transcript of the role's reused tab. The job keeps its own task text and records `fromJob`
(`atomnano job <id> --json`).

Refused, with nothing started: a bare or blank `--from` (exit 1: `--from needs a job id — usage: atomnano coder
"<task>" --from <job id> [--wait]`), an id that is not among the session's jobs (`No job <id> among session <sid>'s
jobs — --from takes the id of a finished job of this orchestrator (atomnano jobs)`), another orchestrator's job,
a job that is still running (`Job <id> is still running — wait for it (atomnano wait <id> --timeout 540) before
handing its result on.`), and `atomnano test --cmd "…" --from <id>` (exit 1 — a command job runs a command, not
the Tester role; `atomnano test "<task>" --from <id>` runs the Tester as a role).
