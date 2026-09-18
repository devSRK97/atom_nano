"use strict";
/* atomnano CLI — argument parsing, command dispatch, exit codes (docs/WORKFLOW_CONTRACT.md §5; the task
 * board commands §8.3). Plain Node, no Electron: every command is one or two JSON calls to the running
 * app's control server (src/main/control/server.js) through ./client.js. main(argv, io?) resolves with
 * the exit code and never throws; io = { stdout, stderr, env } lets tests capture output (defaults:
 * process streams/env).
 *
 * Exit codes: 0 ok · 1 usage / server error · 2 AtomNano is not running · 3 the awaited job ended in
 * error or was stopped. Output is short and machine-friendly — the Orchestrator model reads it.
 *
 * Waiting (2026-09-18): a long-poll is sliced into SLICE_S (240 s) requests under the server's 600 s cap; the
 * brief tells the orchestrator to use `--wait --timeout 540` and repeat `atomnano wait <id> --timeout 540`
 * with its shell tool set to 600 s, so one call never outlives the tool. `--from <job id>` (run / plan / coder /
 * review / test-as-role) travels as body `from` to POST /v1/jobs — the finished job whose saved result the
 * server's manager appends to the task; `test --cmd … --from` is refused (a command job has no role). */
const { createClient, CliError } = require("./client");
const F = require("./format");

const HELP = `atomnano — delegate work to AtomNano's workflow roles (Planner / Coder / Reviewer / Tester) from the command line
The caller is the Orchestrator: the model you chat with, which manages, orchestrates and monitors the roles.

USAGE
  atomnano status                              app, your orchestrator session, the active workflow, its jobs
  atomnano roles                               the role table (provider / model / effort / access)
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
  atomnano context search "terms" --session ID [--before INDEX] [--limit N] [--json]
  atomnano context read INDEX --session ID [--offset BYTES] [--limit BYTES] [--json]
  atomnano help | version

TASK BOARD (one board per orchestrator session; tasks are grouped into sets)
  atomnano tasks [--all] [--json]              the board: the active set with its tasks, finished sets one line each (--all: every task)
  atomnano tasks add "title" ["title" …] [--detail "…"] [--role coder] [--set "New set title"]
  atomnano tasks set "Title"                   open a new set now (closes the current one)
  atomnano tasks start|done|review|test|block|drop T12 [T13 …] [--note "…"]
  atomnano tasks note T12 "text" | show T12 | edit T12 [--title "…"] [--detail "…"] [--role r] | sets
  atomnano run <role> "<task>" --task T12      link the job to a task (it moves to doing / review / test with the role)

OPTIONS
  --session ID   the orchestrator session (default: $ATOMNANO_SESSION, else the single running orchestrator)
  --from JOB     append that finished job's saved result to the task — a Planner's plan or a Reviewer's findings handed to the Coder
                 (a job of this orchestrator that has ended; role jobs only — not "test --cmd")
  --wait         block until the job is terminal and print its result text (implied by --timeout)
  --timeout s    stop waiting after s seconds; the job keeps running (default: wait until it ends). From a shell tool with a 600 s
                 limit use 540, then "atomnano wait <id> --timeout 540" until the job ends
  --files a,b    files the role should look at first       --agents N   the role's sub-agent lane for this job (0 = solo; any provider)
  --task T12     the board task a job works on (run / plan / coder / review / test)
  --context      hand the role the orchestrator's conversation so far, condensed (summary · recent turns · session map · board)
  --fresh        a new session for the role — by default a role's next task runs in its existing session and keeps its context
  --json         print the server's JSON reply instead of text

EXIT CODES   0 ok · 1 usage or server error · 2 AtomNano is not running · 3 the awaited job failed or was stopped`;

const ROLE_ALIAS = { planner: "planner", plan: "planner", coder: "coder", code: "coder", reviewer: "reviewer", review: "reviewer", tester: "tester", test: "tester" };
const ROLE_CMD = { planner: "plan", coder: "coder", reviewer: "review", tester: "test" };   // the shorthand command of each role
const PRIMARY = "orchestrator";
const TERMINAL = new Set(["done", "error", "stopped"]);
const SLICE_S = 240;   // one long-poll request; Node's fetch gives up on response headers after 300 s
const DEFAULT_TEST_TASK = "Run the project's test suite and report the results: failing tests with file:line, the error text and the likely cause. Do not change code.";
const BOOL_FLAGS = new Set(["wait", "json", "help", "version", "all", "context"]);
const SHORT = { s: "session", P: "provider", p: "provider", f: "files", t: "timeout", n: "tail", h: "help", v: "version", c: "cmd", a: "agents", j: "json", w: "wait" };
const LONG_ALIAS = { command: "cmd", file: "files", agent: "agents", sess: "session", provider: "provider", notes: "note", details: "detail" };
// `atomnano tasks <verb> T12` → the status the verb sets (contract §8.3).
const TASK_STATUS_CMD = { start: "doing", doing: "doing", done: "done", finish: "done", review: "review", test: "test", block: "blocked", blocked: "blocked", drop: "dropped", dropped: "dropped", todo: "todo", reopen: "todo" };

// → { cmd, pos: [every positional incl. cmd], flags }
function parseArgs(argv) {
  const flags = {}, pos = [];
  const takesValue = (k) => !BOOL_FLAGS.has(k);
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--") { pos.push(...argv.slice(i + 1).map(String)); break; }
    if (a.startsWith("--")) {
      let key = a.slice(2), val;
      const eq = key.indexOf("=");
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      key = LONG_ALIAS[key] || key;
      if (val === undefined) {
        if (takesValue(key) && i + 1 < argv.length && !(String(argv[i + 1]).startsWith("--"))) val = String(argv[++i]);
        else val = true;
      }
      flags[key] = val;
    } else if (/^-[A-Za-z]$/.test(a)) {
      const key = SHORT[a[1]] || a[1];
      if (takesValue(key) && i + 1 < argv.length && !(String(argv[i + 1]).startsWith("-") && String(argv[i + 1]).length > 1 && !/^-\d/.test(String(argv[i + 1])))) flags[key] = String(argv[++i]);
      else flags[key] = true;
    } else pos.push(a);
  }
  return { cmd: pos[0] || "", pos, flags };
}
function version() { try { return require("../../package.json").version; } catch { return "0"; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function qs(obj) { const parts = []; for (const k of Object.keys(obj)) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(obj[k])); return parts.length ? "?" + parts.join("&") : ""; }
function num(v, def) { if (v == null || v === true) return def; const n = parseFloat(String(v)); return Number.isFinite(n) ? n : def; }
function splitList(v) { if (v == null || v === true) return []; return String(v).split(",").map((s) => s.trim()).filter(Boolean); }
const enc = encodeURIComponent;
// A flag's text value ("" when absent or given without a value).
function flagStr(a, key) { const v = a.flags[key]; return v == null || v === true ? "" : String(v); }
// "T12" · "t12" · "#12" · "12" → "T12"; anything else passes through as an item id ("" when empty).
function taskRefArg(v) { const s = String(v == null ? "" : v).trim(); const m = /^#?[tT]?(\d+)$/.exec(s); return m ? "T" + parseInt(m[1], 10) : s; }
// --from <job id> (2026-09-18): the finished job whose saved result the role receives with its task. A bare --from
// or a blank value is a usage error here (exit 1) — nothing is sent for it.
function fromJobArg(a, role) {
  const v = flagStr(a, "from").trim();
  if (!v) throw new CliError(`--from needs a job id — usage: atomnano ${ROLE_CMD[role] || role} "<task>" --from <job id> [--wait]`, 1);
  return v;
}

// ---------------------------------------------------------------- shared pieces
function sessionParam(ctx) { const f = ctx.a.flags.session; return (f && f !== true ? String(f) : "") || ctx.env.ATOMNANO_SESSION || ""; }
// The project folder the caller is in (--cwd wins): status / roles show ITS active workflow when no planner session resolves.
function cwdParam(ctx) { const f = ctx.a.flags.cwd; return f && f !== true ? String(f) : (ctx.cwd || process.cwd()); }
function waitTotal(a) {
  const wants = !!a.flags.wait || a.flags.timeout != null;
  if (!wants) return 0;
  if (a.flags.timeout == null || a.flags.timeout === true) return Infinity;
  return Math.max(0, num(a.flags.timeout, 0));
}
function jobLabel(job) { return job.kind === "command" ? `command ${JSON.stringify(F.oneLine(job.command, 60))}` : (job.role || "job"); }
function jobsTable(jobs, indent = "") {
  return F.table(jobs, [
    { key: "id", label: "id" },
    { label: "role", get: (j) => (j.kind === "command" ? "command" : j.role || "") },
    { label: "status", get: (j) => F.statusLabel(j) },
    { label: "time", get: (j) => F.jobDuration(j) },
    { label: "task", get: (j) => (j.kind === "command" ? j.command : j.task), max: 70 },
  ], { indent });
}
function rolesOneLine(roles) {
  if (!roles) return "";
  return ["planner", "coder", "reviewer", "tester"].map((r) => {
    const x = roles[r]; if (!x) return "";
    if (x.enabled === false) return `${r} off`;
    return `${r} ${x.provider || "(composer)"}/${x.effort || "default"}/${F.accessLabel(x.access)}${x.agents ? ` ×${x.agents}` : ""}`;   // ×N = the role's sub-agent lane (any provider)
  }).filter(Boolean).join(" · ");
}
async function waitLoop(c, job, remaining) {
  while (job && !TERMINAL.has(job.status) && remaining > 0) {
    const slice = Math.min(remaining, SLICE_S);
    const t0 = Date.now();
    const r = await c.request("GET", `/v1/jobs/${enc(job.id)}/wait?timeout=${slice}`, undefined, { timeoutMs: (slice + 30) * 1000 });
    job = (r && r.job) || job;
    remaining -= slice;
    if (!TERMINAL.has(job.status) && remaining > 0 && Date.now() - t0 < 1000) await sleep(1000);   // never spin on a manager that answers early
  }
  return job;
}
// Prints a job (started / finished / still running) and returns the exit code.
function report(ctx, job, { waited }) {
  const { out, err, a } = ctx;
  const bad = job.status === "error" || job.status === "stopped";
  if (a.flags.json) { out(F.json({ job })); return waited && bad ? 3 : 0; }
  const child = job.sessionId ? ` · session ${job.sessionId}` : "";
  const linked = job.taskN != null && job.taskN !== "" ? ` · task T${job.taskN}` : "";
  const model = job.kind === "command" ? "" : ` · ${job.provider || "?"}/${job.model || "default"} · effort ${job.effort || "default"} · access ${F.accessLabel(job.access)}${job.agents ? ` · ${job.agents} agents` : ""}`;
  if (!waited) {
    out(`job ${job.id} ${F.statusLabel(job) || "started"} · ${jobLabel(job)}${linked}${model}${child}\n  atomnano wait ${job.id} --timeout 540   # block until it ends and print the result\n`);
    return 0;
  }
  // Waited and not over yet: ONE short line (2026-09-18 — the orchestrator reads it as a tool result and waits
  // again); a paused child shows through statusLabel ("running (paused: offline)"); exit 0 — nothing failed.
  if (!TERMINAL.has(job.status)) {
    out(`job ${job.id} still ${F.statusLabel(job) || "running"} after ${F.jobDuration(job)} · ${jobLabel(job)} — atomnano wait ${job.id} --timeout 540\n`);
    return 0;
  }
  const result = job.result == null ? "" : String(job.result);
  if (result) out(result.endsWith("\n") ? result : result + "\n");
  const bits = [`job ${job.id}`, jobLabel(job), job.status, F.jobDuration(job)];
  if (linked) bits.push(linked.slice(3));
  if (job.kind === "command" && job.exitCode != null) bits.push(`exit ${job.exitCode}`);
  const edited = F.editedSummary(job.editedFiles); if (edited) bits.push(edited);
  if (child) bits.push(`session ${job.sessionId}`);
  err(`[${bits.join(" · ")}]\n`);
  if (bad) { err(`atomnano: job ${job.id} ${job.status}${job.error ? ": " + F.oneLine(job.error, 400) : ""}\n`); return 3; }
  return 0;
}

// ---------------------------------------------------------------- commands
async function cmdStatus(ctx) {
  const c = ctx.client();
  const r = await c.request("GET", "/v1/status" + qs({ session: sessionParam(ctx), cwd: cwdParam(ctx) }));
  if (ctx.a.flags.json) { ctx.out(F.json(r)); return 0; }
  const s = r.session, wf = r.workflow || {}, jobs = Array.isArray(r.jobs) ? r.jobs : [];
  const live = jobs.filter((j) => !TERMINAL.has(j.status)).length;
  const lines = [
    `AtomNano ${r.version || ""} · ${r.url || c.url} · pid ${r.pid}`,
    s ? `session   ${s.id}  ${JSON.stringify(F.oneLine(s.name, 50))}  ${s.running ? "running" : s.status || "idle"}  ${s.cwd}` : `session   none resolved — pass --session <id> or set ATOMNANO_SESSION${r.cwd ? ` (workflow shown for ${r.cwd})` : ""}`,
    `workflow  ${wf.name || "Solo"} (${wf.enabled ? "enabled" : "off"})${wf.enabled ? " — " + rolesOneLine(wf.roles) : ""}`,
  ];
  const b = r.board;
  if (b && b.counts && b.counts.total) lines.push(`tasks     ${b.counts.done}/${b.counts.total} done${b.active ? ` · Set ${b.active.n} ${JSON.stringify(F.oneLine(b.active.title, 40))}` : " · no active set"}   (atomnano tasks)`);
  lines.push(`jobs      ${jobs.length}${jobs.length ? ` (${live} running)` : ""}`);
  if (jobs.length) lines.push(jobsTable(jobs, "  "));
  ctx.out(lines.join("\n") + "\n");
  return 0;
}
async function cmdRoles(ctx) {
  const c = ctx.client();
  const r = await c.request("GET", "/v1/roles" + qs({ session: sessionParam(ctx), cwd: cwdParam(ctx) }));
  if (ctx.a.flags.json) { ctx.out(F.json(r)); return 0; }
  const roles = r.roles || {};
  const rows = [PRIMARY, "planner", "coder", "reviewer", "tester"].filter((k) => roles[k]).map((k) => {
    const x = roles[k]; const primary = k === PRIMARY;
    // the note: the orchestrator is the caller; a worker's lane (any provider), the tester's command
    const note = primary ? "the calling session — you" : [x.agents ? `${x.agents} sub-agents` : (k === "coder" ? "solo" : ""), k === "tester" && x.command ? `cmd: ${x.command}` : ""].filter(Boolean).join(" · ");
    return { role: k, on: primary ? "-" : x.enabled === false ? "no" : "yes", provider: x.provider || "(composer)", model: x.model || (primary && !x.provider ? "(composer)" : "(default)"), effort: x.effort || (primary ? "-" : "default"), access: F.accessLabel(x.access), note };
  });
  ctx.out(`workflow ${JSON.stringify(r.name || "Solo")} — ${r.enabled ? "enabled" : "off"}${r.session ? ` · session ${r.session}` : ""}\n`);
  ctx.out(F.table(rows, [{ key: "role", label: "role" }, { key: "on", label: "on" }, { key: "provider", label: "provider" }, { key: "model", label: "model" }, { key: "effort", label: "effort" }, { key: "access", label: "access" }, { key: "note", label: "note" }]) + "\n");
  return 0;
}
async function runRole(ctx, role, task) {
  const { a } = ctx;
  task = String(task == null ? "" : task).trim();
  if (!task) throw new CliError(`Missing task — usage: atomnano ${ROLE_CMD[role] || role} "<task>" [--wait]`, 1);
  // The whole body is validated BEFORE the client exists: a usage error (a bare --from) is exit 1 whether or not
  // the app is running — constructing the client first turned it into exit 2 "AtomNano is not running" (2026-09-18).
  const total = waitTotal(a), first = Math.min(total, SLICE_S);
  const body = { session: sessionParam(ctx) || undefined, role, task, files: splitList(a.flags.files), wait: first > 0 ? first : 0 };
  if (a.flags.agents != null && a.flags.agents !== true) body.agents = Math.max(0, Math.min(20, Math.trunc(num(a.flags.agents, 0))));
  if (flagStr(a, "task")) body.taskRef = taskRefArg(a.flags.task);
  if (a.flags.from !== undefined) body.from = fromJobArg(a, role);   // the finished job whose saved result travels with the task (the server hands it on as fromJob)
  if (a.flags.context) body.context = true;
  if (a.flags.fresh) body.fresh = true;   // a new session for the role; by default its next task continues in its existing session
  const c = ctx.client();
  let { job } = await c.request("POST", "/v1/jobs", body, { timeoutMs: (first + 90) * 1000 });
  if (total > first) job = await waitLoop(c, job, total - first);
  return report(ctx, job, { waited: total > 0 });
}
async function cmdRun(ctx) {
  const roleIn = String(ctx.a.pos[1] || "").toLowerCase();
  const role = ROLE_ALIAS[roleIn];
  if (!role) throw new CliError(roleIn === PRIMARY || roleIn === "primary" ? "The orchestrator is this session — delegate to planner, coder, reviewer or tester" : `Usage: atomnano run <planner|coder|reviewer|tester> "<task>" [--wait]`, 1);
  return runRole(ctx, role, ctx.a.pos.slice(2).join(" "));
}
async function cmdTest(ctx) {
  const { a } = ctx;
  const cmd = a.flags.cmd != null && a.flags.cmd !== true ? String(a.flags.cmd).trim() : "";
  if (!cmd) return runRole(ctx, "tester", a.pos.slice(1).join(" ").trim() || DEFAULT_TEST_TASK);
  // --from hands a finished job's RESULT to a role; a command job runs a command — there is no role to hand it to.
  if (a.flags.from !== undefined) throw new CliError('--from hands a finished job\'s result to a role, but `atomnano test --cmd` runs a command, not the Tester role — drop --from, or run the Tester as a role: atomnano test "<task>" --from <job id>', 1);
  const total = waitTotal(a), first = Math.min(total, SLICE_S);
  const body = { session: sessionParam(ctx) || undefined, command: cmd, wait: first > 0 ? first : 0 };
  if (flagStr(a, "task")) body.taskRef = taskRefArg(a.flags.task);
  const c = ctx.client();   // after the arguments — see runRole
  let { job } = await c.request("POST", "/v1/tests", body, { timeoutMs: (first + 90) * 1000 });
  if (total > first) job = await waitLoop(c, job, total - first);
  return report(ctx, job, { waited: total > 0 });
}
async function cmdJobs(ctx) {
  const c = ctx.client();
  const r = await c.request("GET", "/v1/jobs" + qs({ session: sessionParam(ctx) }));
  if (ctx.a.flags.json) { ctx.out(F.json(r)); return 0; }
  const jobs = Array.isArray(r.jobs) ? r.jobs : [];
  ctx.out(jobs.length ? jobsTable(jobs) + "\n" : `no jobs${r.session ? ` for session ${r.session}` : ""}\n`);
  return 0;
}
function needId(ctx, what) { const id = ctx.a.pos[1]; if (!id) throw new CliError(`Usage: atomnano ${what} <job id>`, 1); return String(id); }
async function cmdJob(ctx) {
  const id = needId(ctx, "job");
  const c = ctx.client();
  const { job } = await c.request("GET", `/v1/jobs/${enc(id)}`);
  if (ctx.a.flags.json) { ctx.out(F.json({ job })); return 0; }
  const lines = [`job ${job.id} · ${jobLabel(job)} · ${F.statusLabel(job)}${job.kind === "command" && job.exitCode != null ? ` (exit ${job.exitCode})` : ""} · ${F.jobDuration(job)}`];
  if (job.kind !== "command") {
    lines.push(`session   ${job.sessionId || "-"}${job.parentId ? `  (orchestrator ${job.parentId})` : ""}`);
    lines.push(`model     ${job.provider || "?"}/${job.model || "default"} · effort ${job.effort || "default"} · access ${F.accessLabel(job.access)}${job.agents != null ? ` · ${job.agents} agents` : ""}${job.agentsLive && job.agentsLive.total ? ` (${job.agentsLive.running} live of ${job.agentsLive.total})` : ""}`);
  } else if (job.parentId) lines.push(`session   orchestrator ${job.parentId}`);
  if (job.task && job.kind !== "command") lines.push(`task      ${F.oneLine(job.task, 200)}`);
  if (job.taskN != null && job.taskN !== "") lines.push(`board     T${job.taskN}   (atomnano tasks show T${job.taskN})`);
  const edited = F.editedSummary(job.editedFiles);
  if (edited) lines.push(`files     ${edited}: ${job.editedFiles.slice(0, 8).map((f) => f.path).join(", ")}${job.editedFiles.length > 8 ? ", …" : ""}`);
  if (job.tokensIn || job.tokensOut) lines.push(`tokens    in ${job.tokensIn || 0} · out ${job.tokensOut || 0}`);
  if (job.error) lines.push(`error     ${F.oneLine(job.error, 300)}`);
  const result = job.result == null ? "" : String(job.result);
  if (result) {
    const head = result.length > 1500 ? result.slice(0, 1500) + `\n… (${result.length} chars — atomnano result ${job.id} prints all of it)` : result;
    lines.push("result", head.replace(/\n$/, ""));
  } else if (!TERMINAL.has(job.status)) lines.push(`(running — atomnano wait ${job.id} blocks until it ends)`);
  ctx.out(lines.join("\n") + "\n");
  return 0;
}
async function cmdWait(ctx) {
  const id = needId(ctx, "wait");
  const c = ctx.client();
  let { job } = await c.request("GET", `/v1/jobs/${enc(id)}`);
  const total = ctx.a.flags.timeout != null && ctx.a.flags.timeout !== true ? Math.max(0, num(ctx.a.flags.timeout, 0)) : Infinity;
  job = await waitLoop(c, job, total);
  return report(ctx, job, { waited: true });
}
async function cmdResult(ctx) {
  const id = needId(ctx, "result");
  const c = ctx.client();
  const { job } = await c.request("GET", `/v1/jobs/${enc(id)}`);
  if (ctx.a.flags.json) { ctx.out(F.json({ job })); return 0; }
  if (!TERMINAL.has(job.status)) { ctx.err(`atomnano: job ${job.id} is still ${F.statusLabel(job)} — atomnano wait ${job.id} blocks until it ends\n`); return 1; }
  const result = job.result == null ? "" : String(job.result);
  ctx.out(result ? (result.endsWith("\n") ? result : result + "\n") : "(empty result)\n");
  if (job.status === "error" || job.status === "stopped") { ctx.err(`atomnano: job ${job.id} ${job.status}${job.error ? ": " + F.oneLine(job.error, 400) : ""}\n`); return 3; }
  return 0;
}
async function cmdLog(ctx) {
  const id = needId(ctx, "log");
  const c = ctx.client();
  const tail = ctx.a.flags.tail != null && ctx.a.flags.tail !== true ? Math.max(1, Math.trunc(num(ctx.a.flags.tail, 40))) : 40;
  const r = await c.request("GET", `/v1/jobs/${enc(id)}/log` + qs({ tail }));
  if (ctx.a.flags.json) { ctx.out(F.json(r)); return 0; }
  const text = r.text == null ? "" : String(r.text);
  ctx.out(text ? (text.endsWith("\n") ? text : text + "\n") : "(no log yet)\n");
  return 0;
}
async function cmdStop(ctx) {
  const c = ctx.client();
  if (ctx.a.flags.all) {   // every live job of the orchestrator (Stop on the orchestrator's turn leaves them running)
    const r = await c.request("POST", "/v1/jobs/stop-all", { session: sessionParam(ctx) || undefined });
    if (ctx.a.flags.json) { ctx.out(F.json(r)); return 0; }
    ctx.out(`stopped ${r.stopped} job${r.stopped === 1 ? "" : "s"}\n`); return 0;
  }
  const id = needId(ctx, "stop");
  const r = await c.request("POST", `/v1/jobs/${enc(id)}/stop`, {});
  if (ctx.a.flags.json) { ctx.out(F.json(r)); return r.ok ? 0 : 1; }
  if (r.ok) { ctx.out(r.detail && /already/i.test(r.detail) ? `${r.detail}\n` : `stopped ${id}${r.job && r.job.status ? ` · ${r.job.status}` : ""}\n`); return 0; }
  ctx.err(`atomnano: could not stop ${id}${r.detail ? ": " + r.detail : ""}\n`);
  return 1;
}
async function cmdSessions(ctx) {
  const c = ctx.client();
  const r = await c.request("GET", "/v1/sessions");
  if (ctx.a.flags.json) { ctx.out(F.json(r)); return 0; }
  const rows = Array.isArray(r.sessions) ? r.sessions : [];
  ctx.out(rows.length ? F.table(rows, [
    { key: "id", label: "id" },
    { label: "status", get: (s) => (s.running ? "running" : s.status || "idle") },
    { label: "role", get: (s) => s.role || PRIMARY },
    { key: "name", label: "name", max: 40 },
    { key: "cwd", label: "cwd", max: 60 },
  ]) + "\n" : "no sessions\n");
  return 0;
}
async function cmdContext(ctx) {
  const sub = ctx.a.pos[1], value = ctx.a.pos.slice(2).join(" ");
  if (!["search", "read"].includes(sub) || !value) throw new CliError('Use: atomnano context search "terms" | read INDEX --session ID', 1);
  const query = { session: sessionParam(ctx), limit: flagStr(ctx.a, "limit") };
  if (sub === "search") { query.query = value; query.before = flagStr(ctx.a, "before"); }
  else { query.ref = value; query.offset = flagStr(ctx.a, "offset"); }
  const r = await ctx.client().request("GET", "/v1/context/" + sub + qs(query));
  if (ctx.a.flags.json) { ctx.out(F.json(r)); return 0; }
  if (sub === "read") {
    ctx.out(`[${r.session} / entry ${r.index} / ${r.id} / ${r.role}]\n${r.text}\n`);
    if (r.nextOffset != null) ctx.out(`More: atomnano context read ${r.index} --session ${r.session} --offset ${r.nextOffset}\n`);
  } else {
    ctx.out((r.matches || []).map((m) => `[entry ${m.index} / ${m.id} / ${m.role}]\n${m.snippet}`).join("\n\n") + (r.matches.length ? "\n" : "No matching history.\n"));
    if (r.nextBefore != null) ctx.out(`More matches: repeat this search with --before ${r.nextBefore}\n`);
  }
  return 0;
}
async function cmdProviders(ctx) {
  const c = ctx.client();
  const r = await c.request("GET", "/v1/providers");
  if (ctx.a.flags.json) { ctx.out(F.json(r)); return 0; }
  const rows = Array.isArray(r.providers) ? r.providers : [];
  ctx.out(F.table(rows, [
    { key: "id", label: "id" }, { key: "label", label: "label" },
    { label: "authorized", get: (p) => (p.authorized ? "yes" : "no") },
    { label: "default model", get: (p) => p.defaultModel || "-" },
    { label: "current", get: (p) => (p.current ? "*" : "") },
  ]) + "\n");
  return 0;
}
async function cmdModels(ctx) {
  const c = ctx.client();
  const r = await c.request("GET", "/v1/models" + qs({ provider: ctx.a.flags.provider && ctx.a.flags.provider !== true ? ctx.a.flags.provider : "" }));
  if (ctx.a.flags.json) { ctx.out(F.json(r)); return 0; }
  const models = Array.isArray(r.models) ? r.models : [];
  const lines = [`models for ${r.provider}${r.defaultModel ? ` (default ${r.defaultModel})` : ""}`];
  lines.push(models.length ? F.table(models, [{ key: "id", label: "id" }, { key: "name", label: "name", max: 50 }], { indent: "  " }) : "  (none — configure this provider in the app)");
  if (Array.isArray(r.reasoningLevels) && r.reasoningLevels.length) lines.push(`efforts: ${r.reasoningLevels.map((l) => l.id).join(" · ")}`);
  ctx.out(lines.join("\n") + "\n");
  return 0;
}

/* atomnano tasks … — the orchestrator session's task board (contract §8.3). Sub-commands: (none) / board ·
 * sets · add · set · show · note · edit · start|done|review|test|block|drop [T12 …]. Human output reuses
 * the board's row format everywhere so the orchestrator reads one shape; --json prints the server's reply. */
async function cmdTasks(ctx) {
  const { a } = ctx;
  const sub = String(a.pos[1] || "").toLowerCase();
  const c = ctx.client();
  const session = sessionParam(ctx) || undefined;
  const json = (o) => { ctx.out(F.json(o)); return 0; };
  const board = async (all) => c.request("GET", "/v1/tasks" + qs({ session: sessionParam(ctx), all: all ? "1" : "" }));
  const patchOne = (ref, patch) => c.request("PATCH", `/v1/tasks/${enc(ref)}`, { session, ...patch });
  const lastNote = (item) => (item && Array.isArray(item.notes) && item.notes.length ? item.notes[item.notes.length - 1] : null);
  const printItems = (items, note) => {
    ctx.out(F.taskRows(items, "") + "\n");
    if (note) for (const it of items) { const n = lastNote(it); ctx.out(`  ${F.taskRef(it)} note (${(n && n.by) || PRIMARY}): ${F.oneLine((n && n.text) || note, 300)}\n`); }
  };

  if (!sub || sub === "board" || sub === "list" || sub === "ls") {
    const r = await board(!!a.flags.all);
    if (a.flags.json) return json(r);
    ctx.out(F.boardText(r.board || {}, { all: !!a.flags.all }) + "\n");
    return 0;
  }
  if (sub === "sets") {
    const r = await board(true);
    if (a.flags.json) return json(r);
    const b = r.board || {};
    const sets = (Array.isArray(b.sets) ? b.sets : []).filter(Boolean).slice().sort((x, y) => (+y.n || 0) - (+x.n || 0));
    ctx.out(sets.length ? sets.map((s) => F.setLine(s, b.items || [])).join("\n") + "\n" : 'no sets yet — atomnano tasks add "title" --set "Set title"\n');
    return 0;
  }
  if (sub === "add") {
    const titles = a.pos.slice(2).map((s) => String(s).trim()).filter(Boolean);
    if (!titles.length) throw new CliError('Usage: atomnano tasks add "title" ["title" …] [--detail "…"] [--role coder] [--set "New set title"]   (a set alone: atomnano tasks set "Title")', 1);
    const detail = flagStr(a, "detail"), role = flagStr(a, "role"), setTitle = flagStr(a, "set");
    const body = { session };
    if (detail || role) body.items = titles.map((t) => ({ title: t, ...(detail ? { detail } : {}), ...(role ? { role } : {}) })); else body.titles = titles;
    if (setTitle) body.set = { title: setTitle };
    const r = await c.request("POST", "/v1/tasks", body);
    if (a.flags.json) return json(r);
    const items = Array.isArray(r.items) ? r.items : [];
    ctx.out(`added ${items.length} task${items.length === 1 ? "" : "s"}${r.set ? ` → Set ${r.set.n} · ${F.oneLine(r.set.title, 60)}` : ""}\n${F.taskRows(items)}\n`);
    return 0;
  }
  if (sub === "set" || sub === "new-set" || sub === "newset" || sub === "open") {
    const title = a.pos.slice(2).join(" ").trim();
    if (!title) throw new CliError('Usage: atomnano tasks set "Title"   (opens a new set of tasks; the current one is closed)', 1);
    const r = await c.request("POST", "/v1/tasks/sets", { session, title });
    if (a.flags.json) return json(r);
    ctx.out(r.set ? `opened Set ${r.set.n} · ${F.oneLine(r.set.title, 60)}\n` : "opened a new set\n");
    return 0;
  }
  if (sub === "show" || sub === "info" || sub === "get") {
    const ref = taskRefArg(a.pos[2]);
    if (!ref) throw new CliError("Usage: atomnano tasks show T12", 1);
    const r = await c.request("GET", `/v1/tasks/${enc(ref)}` + qs({ session: sessionParam(ctx) }));
    if (a.flags.json) return json(r);
    ctx.out(F.taskDetail(r.item || {}, r.set) + "\n");
    return 0;
  }
  if (sub === "note") {
    const ref = taskRefArg(a.pos[2]);
    const text = a.pos.slice(3).join(" ").trim() || flagStr(a, "note").trim();
    if (!ref || !text) throw new CliError('Usage: atomnano tasks note T12 "text"', 1);
    const r = await patchOne(ref, { note: text });
    if (a.flags.json) return json(r);
    printItems([r.item], text);
    return 0;
  }
  if (sub === "edit" || sub === "rename") {
    const ref = taskRefArg(a.pos[2]);
    const patch = {};
    const title = sub === "rename" ? a.pos.slice(3).join(" ").trim() : flagStr(a, "title").trim();
    if (title) patch.title = title;
    if (a.flags.detail !== undefined) patch.detail = flagStr(a, "detail");
    if (a.flags.role !== undefined) patch.role = flagStr(a, "role");
    if (flagStr(a, "note").trim()) patch.note = flagStr(a, "note").trim();
    if (!ref || !Object.keys(patch).length) throw new CliError('Usage: atomnano tasks edit T12 [--title "…"] [--detail "…"] [--role planner|coder|reviewer|tester|orchestrator|""]   ·   atomnano tasks rename T12 "new title"', 1);
    const r = await patchOne(ref, patch);
    if (a.flags.json) return json(r);
    printItems([r.item], patch.note);
    return 0;
  }
  const status = TASK_STATUS_CMD[sub];
  if (status) {
    const refs = a.pos.slice(2).map(taskRefArg).filter(Boolean);
    if (!refs.length) throw new CliError(`Usage: atomnano tasks ${sub} T12 [T13 …] [--note "…"]`, 1);
    const patch = { status };
    const note = flagStr(a, "note").trim(); if (note) patch.note = note;
    if (flagStr(a, "role")) patch.role = flagStr(a, "role");
    const results = [];
    for (const ref of refs) results.push(await patchOne(ref, patch));
    if (a.flags.json) return json(results.length === 1 ? results[0] : { items: results.map((r) => r.item), session: results[0].session });
    printItems(results.map((r) => r.item), note);
    return 0;
  }
  throw new CliError(`Unknown tasks command "${sub}" — one of: add, set, start, done, review, test, block, drop, note, edit, show, sets (atomnano help)`, 1);
}

const COMMANDS = {
  status: cmdStatus, roles: cmdRoles, run: cmdRun, tasks: cmdTasks, task: cmdTasks, board: cmdTasks,
  plan: (ctx) => runRole(ctx, "planner", ctx.a.pos.slice(1).join(" ")), planner: (ctx) => runRole(ctx, "planner", ctx.a.pos.slice(1).join(" ")),
  coder: (ctx) => runRole(ctx, "coder", ctx.a.pos.slice(1).join(" ")), code: (ctx) => runRole(ctx, "coder", ctx.a.pos.slice(1).join(" ")),
  review: (ctx) => runRole(ctx, "reviewer", ctx.a.pos.slice(1).join(" ")), reviewer: (ctx) => runRole(ctx, "reviewer", ctx.a.pos.slice(1).join(" ")),
  test: cmdTest, tester: cmdTest,
  jobs: cmdJobs, job: cmdJob, wait: cmdWait, result: cmdResult, log: cmdLog, stop: cmdStop,
  sessions: cmdSessions, context: cmdContext, providers: cmdProviders, models: cmdModels,
};

// main(argv, io?) → exit code. io: { stdout(s), stderr(s), env, cwd, client? } (tests capture output here; `client`
// replaces the HTTP client — scripts/test-workflow-cli.js drives the 540 s wait slicing through a fake without waiting).
async function main(argv, io = {}) {
  const out = (s) => { if (io.stdout) io.stdout(s); else process.stdout.write(s); };
  const err = (s) => { if (io.stderr) io.stderr(s); else process.stderr.write(s); };
  const env = io.env || process.env;
  const a = parseArgs(Array.isArray(argv) ? argv : []);
  try {
    if (!a.cmd || a.cmd === "help" || a.flags.help) { out(HELP + "\n"); return 0; }
    if (a.cmd === "version" || a.flags.version) { out(`atomnano ${version()}\n`); return 0; }
    const fn = COMMANDS[a.cmd];
    if (!fn) { err(`atomnano: unknown command "${a.cmd}" — try: atomnano help\n`); return 1; }
    let client = null;
    const ctx = { a, out, err, env, cwd: io.cwd || "", client: () => (client || (client = io.client || createClient(env))) };
    const code = await fn(ctx);
    return Number.isInteger(code) ? code : 0;
  } catch (e) {
    if (e instanceof CliError) {
      err(`atomnano: ${e.message}\n`);
      const list = e.data && Array.isArray(e.data.sessions) ? e.data.sessions : [];
      if (list.length) err("  sessions:\n" + list.map((s) => `    ${s.id}  ${s.running ? "running" : s.status || "idle"}  ${JSON.stringify(F.oneLine(s.name, 40))}  ${s.cwd || ""}`).join("\n") + "\n");
      return e.code || 1;
    }
    err(`atomnano: ${(e && e.message) || e}\n`);
    return 1;
  }
}

module.exports = { main, parseArgs, HELP, SLICE_S };
