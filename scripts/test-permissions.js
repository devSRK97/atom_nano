"use strict";
/* Permission-flow regression suite — DESIRED behaviour for the causes of "permissions
 * getting denied while the agent is working", and for the access modes on both harnesses:
 *   · AskUserQuestion is answered as ALLOW + updatedInput.answers (SDK contract), never as a
 *     denial carrying the answers in its message;
 *   · no 5-minute auto-decline in the renderer — a prompt waits for the user;
 *   · the permission mode is read LIVE: Full access never asks, Accept edits auto-allows edit
 *     tools, Plan/Ask reach the user; a mode picked while the turn runs applies to it;
 *   · Codex: Full access auto-accepts commands / file changes / permissions, Plan declines
 *     them, Ask asks; approvals for an untracked (sub-agent) thread go to the live turn;
 *   · run-scoped cancellation is unchanged (stop/replace only affects its own run).
 * Same harness as scripts/test-context.js: the ORIGINAL claude.js in a VM with injected
 * providers; the REAL store/history on an isolated data home; no model calls.
 * Run: node scripts/test-permissions.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const ROOT = path.join(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-perms-"));
process.env.ATOMNANO_MAX_MESSAGES = "60";
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, "claude-home"); fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
process.env.CODEX_HOME = path.join(HOME, "codex-home"); fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === "electron") return { app: { getPath: (k) => (k === "userData" ? HOME : os.homedir()), getAppPath: () => ROOT, isPackaged: false } }; return origLoad.call(this, req, ...rest); };

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 600) : ""}`); } }
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 180000);
const tick = () => new Promise((r) => setImmediate(r));

const store = require(path.join(ROOT, "src/main/store.js"));
const history = require(path.join(ROOT, "src/main/history.js"));
store.loadSettings();
const src = fs.readFileSync(path.join(ROOT, "src/main/claude.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "src/renderer/app.js"), "utf8");

function environment() {
  const sdkCalls = [], appCalls = [], perms = [], sends = [];
  const control = { sdk: null, app: null };
  const providers = { get: (p) => ({ label: p, models: p === "openai" ? [{ id: "gpt-5.5", ctx: 272000 }] : [{ id: "claude-opus-4-8", ctx: 200000 }], defaultModel: p === "openai" ? "gpt-5.5" : "claude-opus-4-8", defaultReasoning: "low" }), context1M: () => false, resolveOpenAIModelStrict: (id) => ({ model: id || "gpt-5.5" }), resolveOpenAIModel: (id) => ({ model: id || "gpt-5.5" }), openaiEffortStrict: (e) => ({ effort: e || "low" }), openaiEffort: () => "low" };
  const sdk = { query(opts) { return (async function* () {
    const call = { options: opts.options, resume: opts.options.resume || null, permissionMode: opts.options.permissionMode, allowBypass: opts.options.allowDangerouslySkipPermissions, canUseTool: opts.options.canUseTool, setModeCalls: [] }; sdkCalls.push(call);
    if (control.sdk) { yield* control.sdk(call); return; }
    yield { type: "system", subtype: "init", session_id: opts.options.resume || "native-claude" };
    yield { type: "result", subtype: "success", is_error: false, session_id: "native-claude", usage: {} };
  })(); } };
  const appserver = {
    ctxKeyOf: () => "login",
    async run(opts) { const id = opts.resumeId || "native-openai-1"; const call = { opts, id, decisions: [] }; appCalls.push(call); opts.on.onThreadId(id, !opts.resumeId, "login"); await opts.beforeTurn(id, !opts.resumeId); opts.on.onTurnId("turn-1"); if (control.app) return control.app(opts, call); return { ok: true, text: "done", threadId: id }; },
    async injectItems() { return { ok: true }; }, interrupt: async () => true, steer: async () => ({ ok: true }),
  };
  const req = (name) => {
    const map = { path, fs, os, crypto: require("crypto"), child_process: require("child_process"), "./store": store, "./history": history, "./auth": {}, "./attachments": { persistAll: (a) => a, light: (a) => a, readBase64: () => "" }, "./tool-args": require(path.join(ROOT, "src/main/tool-args.js")), "./providers": providers, "./codex-appserver": appserver, "./codex": { run: async () => ({ ok: true, text: "x" }) }, "./codex-cards": { unwrapCmd: (x) => x, parseDiff: () => ({ oldText: "", newText: "", added: 0, removed: 0 }), classifyCmd: () => null }, "./council": { reviewerRun: async () => ({ ok: true, text: "advice" }), label: () => "R" }, "./customApi": { getEndpoint: () => null, call: async () => ({ ok: true, text: "c" }) } };
    if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
    throw new Error("Unexpected manager dependency " + name);
  };
  const mod = { exports: {} };
  vm.runInNewContext(src + "\nsdkPromise = Promise.resolve(__auditSdk);", { module: mod, exports: mod.exports, require: req, __filename: path.join(ROOT, "src/main/claude.js"), __dirname: path.join(ROOT, "src/main"), process, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, URL, TextEncoder, TextDecoder, console: { log() {}, warn() {}, error() {} }, __auditSdk: sdk }, { filename: "claude.js" });
  const M = mod.exports;
  M.send = (name, data) => { sends.push({ name, data }); if (name === "session:permission") perms.push(data); };
  M.buildEnv = () => ({}); M.resolveCli = async () => ""; M.composeMcp = () => ({}); M.registerModel = () => {}; M.scheduleRetry = () => {};
  const make = (opts = {}) => { const v = store.createSession({ cwd: HOME, name: "perm", model: opts.model || "claude-opus-4-8", thinking: "low", permissionMode: opts.permissionMode || "default" }); return store.getSession(v.id); };
  const setProvider = (p) => store.saveSettings({ llmProvider: p });
  return { M, make, sdkCalls, appCalls, perms, sends, control, setProvider };
}

async function main() {
  // ---- P01: AskUserQuestion is ALLOWED with answers (Claude canUseTool contract) ----
  { const e = environment(); const s = e.make();
    const input = { questions: [{ question: "Which database?", header: "Database", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }], multiSelect: false }] };
    const p = e.M.requestPermission(s.id, "AskUserQuestion", input, undefined, "run-1");
    await tick();
    const rq = e.perms[0];
    e.M.respondPermission(rq.requestId, { allow: true, answers: { "Which database?": "Postgres" } });
    const r = await p;
    check("P01", "an answered question resolves as ALLOW with updatedInput.answers (question text → label)", r.behavior === "allow" && r.updatedInput && r.updatedInput.answers && r.updatedInput.answers["Which database?"] === "Postgres" && Array.isArray(r.updatedInput.questions), r);
    const p2 = e.M.requestPermission(s.id, "AskUserQuestion", input, undefined, "run-1"); await tick();
    e.M.respondPermission(e.perms[1].requestId, { allow: false, message: "The user dismissed the question without choosing." });
    const r2 = await p2;
    check("P01b", "a skipped question is a denial with the explanation", r2.behavior === "deny" && /dismissed/.test(r2.message)); }
  // ---- P02: renderer sends answers as allow; no auto-decline exists any more ----
  { const askBlock = appSrc.slice(appSrc.indexOf("function askCard("), appSrc.indexOf("function respondPerm("));
    check("P02", "renderer: the question card submits ALLOW with an answers map (question text → labels)", /respondPerm\(ts, p, true, \{ answers/.test(askBlock) && /answers\[q\.question \|\| q\.header\] = chosen\.join\(", "\)/.test(askBlock));
    check("P03", "renderer: the 5-minute auto-decline is gone (prompts wait for the user)", !/auto-declined/.test(appSrc) && !/deadline: Date\.now\(\) \+ 5 \* 60 \* 1000/.test(appSrc) && /waiting for your decision/i.test(appSrc));
    check("P04", "renderer: picking a permission mode applies it to the running turn (setModeLive) and plan approval leaves Plan mode", /atom\.sessions\.setModeLive\(ts\.meta\.id, val\)/.test(appSrc) && /function applyPermissionMode/.test(appSrc) && /Approve — auto-accept edits/.test(appSrc) && /Approve — ask for edits/.test(appSrc)); }

  // ---- P05–P08: Claude canUseTool reads the LIVE mode ----
  { const e = environment(); const s = e.make({ permissionMode: "default" });
    const ac = new AbortController();
    const gate = e.M.composeCanUseTool(s.id, "run-1", null, ac, false, s.permissionMode);
    const pending = gate("Bash", { command: "npm test" });   // default → asks
    await tick();
    check("P05", "Ask mode: a Bash call reaches the user", e.perms.length === 1 && e.perms[0].toolName === "Bash");
    e.M.respondPermission(e.perms[0].requestId, { allow: true });
    check("P05b", "…and an allow resolves it", (await pending).behavior === "allow");
    s.permissionMode = "bypassPermissions";                     // the user switched to Full access mid-turn
    const r = await gate("Bash", { command: "rm -rf build" });
    check("P06", "Full access picked mid-turn: the SAME gate stops asking (auto-allow)", r.behavior === "allow" && e.perms.length === 1, { perms: e.perms.length });
    s.permissionMode = "acceptEdits";
    const edit = await gate("Edit", { file_path: "a.js", old_string: "a", new_string: "b" });
    const bash = gate("Bash", { command: "ls" }); await tick();
    check("P07", "Accept edits: edit tools auto-allow, commands still ask", edit.behavior === "allow" && e.perms.length === 2 && e.perms[1].toolName === "Bash");
    e.M.respondPermission(e.perms[1].requestId, { allow: false, message: "no" }); await bash;
    s.permissionMode = "bypassPermissions";
    const q = gate("AskUserQuestion", { questions: [] }); await tick();
    check("P08", "Full access never auto-answers a QUESTION or a plan review — those still reach the user", e.perms.length === 3 && e.perms[2].toolName === "AskUserQuestion");
    e.M.respondPermission(e.perms[2].requestId, { allow: false, message: "skip" }); await q;
    const sub = await gate("Task", { description: "x" });
    check("P09", "sub-agent tools stay structurally denied while the toggle is off (with the reason)", sub.behavior === "deny" && /Sub-agents are disabled/.test(sub.message)); }
  // ---- P10: Claude run options — bypass flag always on so live switching works; the mode is what was picked ----
  { const e = environment(); e.setProvider("anthropic"); const s = e.make({ permissionMode: "plan" });
    await e.M.run(s.id, { text: "plan it", permissionMode: "plan" });
    check("P10", "Plan mode is passed to the SDK as-is and bypass is enabled for later live switching", e.sdkCalls[0].permissionMode === "plan" && e.sdkCalls[0].allowBypass === true, { mode: e.sdkCalls[0].permissionMode, allowBypass: e.sdkCalls[0].allowBypass });
    await e.M.run(s.id, { text: "go", permissionMode: "bypassPermissions" });
    check("P10b", "Full access is passed to the SDK with the safety flag", e.sdkCalls[1].permissionMode === "bypassPermissions" && e.sdkCalls[1].allowBypass === true);
    const ok = await e.M.setPermissionModeLive(s.id, "acceptEdits");
    check("P11", "setPermissionModeLive updates the session even between turns (no live query)", s.permissionMode === "acceptEdits" && ok === false); }

  // ---- P12–P15: Codex decisions per mode (decide) ----
  const codexDecisions = async (mode, kinds) => {
    const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5", permissionMode: mode });
    const out = {};
    e.control.app = async (opts) => { for (const k of kinds) out[k] = await opts.decide(k, { itemId: "i1", command: "ls", reason: "r", permissions: { network: { access: true } }, grantRoot: "C:\\p", questions: [] }, { item: null }); return { ok: true, text: "done" }; };
    await e.M.run(s.id, { text: "do", permissionMode: mode });
    return { out, e };
  };
  { const { out, e } = await codexDecisions("bypassPermissions", ["command", "fileChange", "permissions"]);
    check("P12", "Codex Full access: commands, file changes and permission grants are auto-accepted without asking", out.command.decision === "accept" && out.fileChange.decision === "accept" && out.permissions.grant === true && e.perms.length === 0, out); }
  { const { out, e } = await codexDecisions("plan", ["command", "fileChange", "permissions"]);
    check("P13", "Codex Plan mode: nothing that changes state is approved", out.command.decision === "decline" && out.fileChange.decision === "decline" && out.permissions.grant === false && e.perms.length === 0, out); }
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5", permissionMode: "acceptEdits" });
    let fc, cmd;
    e.control.app = async (opts) => { fc = await opts.decide("fileChange", { itemId: "i1" }, { item: null }); const p = opts.decide("command", { itemId: "i2", command: "npm test" }, { item: null }); await tick(); e.M.respondPermission(e.perms[0].requestId, { allow: true }); cmd = await p; return { ok: true, text: "done" }; };
    await e.M.run(s.id, { text: "do", permissionMode: "acceptEdits" });
    check("P14", "Codex Accept edits: file changes auto-accept, a command asks the user and honours the answer", fc.decision === "accept" && e.perms.length === 1 && e.perms[0].toolName === "Bash" && cmd.decision === "accept", { fc, cmd }); }
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5", permissionMode: "default" });
    let first, second;
    e.control.app = async (opts) => { const p = opts.decide("command", { itemId: "i1", command: "ls" }, { item: null }); await tick(); e.M.respondPermission(e.perms[0].requestId, { allow: false, message: "no" }); first = await p; s.permissionMode = "bypassPermissions"; second = await opts.decide("command", { itemId: "i2", command: "ls" }, { item: null }); return { ok: true, text: "done" }; };
    await e.M.run(s.id, { text: "do", permissionMode: "default" });
    check("P15", "Codex Ask mode asks; switching to Full access mid-turn stops asking for the next request", first.decision === "decline" && second.decision === "accept" && e.perms.length === 1); }
  { const e = environment(); e.setProvider("openai"); const s = e.make({ model: "gpt-5.5", permissionMode: "default" });
    let ans;
    e.control.app = async (opts) => { const p = opts.decide("userInput", { itemId: "i1", questions: [{ id: "q1", header: "Database", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }] }, { item: null }); await tick(); e.M.respondPermission(e.perms[0].requestId, { allow: true, answers: { "Which database?": "Postgres, SQLite" } }); ans = await p; return { ok: true, text: "done" }; };
    await e.M.run(s.id, { text: "do", permissionMode: "default" });
    check("P16", "Codex user-input questions receive the chosen labels from the allow+answers reply", ans && ans.answers.q1 && ans.answers.q1.answers.join("|") === "Postgres|SQLite", ans); }

  // ---- P17: Codex approvals for an untracked (sub-agent) thread go to the live turn ----
  { const appserver = require(path.join(ROOT, "src/main/codex-appserver.js"));
    const I = appserver.__internals;
    const writes = [];
    const decisions = [];
    const ctx = { notice: (t) => decisions.push({ notice: t }), onServerRequest: async (method, p) => { decisions.push({ method, threadId: p.threadId }); return { decision: "accept" }; } };
    const s = { threads: new Map([["thr-main", ctx]]), child: { stdin: { write: (line) => { writes.push(JSON.parse(line)); return true; } } }, dead: false };
    I.onServerRequest(s, { id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thr-subagent", itemId: "x" } });
    await tick(); await tick();
    check("P17", "an approval for an untracked thread is routed to the single live turn (asked, not declined)", decisions.some((d) => d.method === "item/commandExecution/requestApproval" && d.threadId === "thr-subagent") && writes.some((w) => w.id === 7 && w.result && w.result.decision === "accept") && decisions.some((d) => /sub-agent/.test(d.notice || "")), { decisions, writes });
    const s2 = { threads: new Map(), child: { stdin: { write: (line) => { writes.push(JSON.parse(line)); return true; } } }, dead: false };
    I.onServerRequest(s2, { id: 8, method: "item/fileChange/requestApproval", params: { threadId: "thr-x" } });
    await tick();
    check("P17b", "with no live turn at all the safest answer (decline) is still given", writes.some((w) => w.id === 8 && w.result.decision === "decline"));
    const pol = appserver.policyFor("bypassPermissions", { approval: ["on-request", "untrusted"], sandbox: ["workspace-write", "read-only"] });
    check("P18", "managed requirements clamp Full access to the strongest ALLOWED policy (never silently dropped)", pol.approvalPolicy === "on-request" && pol.sandbox === "workspace-write", pol);
    check("P18b", "without requirements Full access asks for never + unsandboxed", JSON.stringify(appserver.policyFor("bypassPermissions", null)) === JSON.stringify({ approvalPolicy: "never", sandbox: "danger-full-access" }) && appserver.policyFor("plan", null).sandbox === "read-only"); }

  // ---- P19: run-scoped cancellation is unchanged ----
  { const e = environment(); const a = e.make(), b = e.make();
    const pA = e.M.requestPermission(a.id, "Bash", { command: "a" }, undefined, "run-A");
    const pB = e.M.requestPermission(b.id, "Bash", { command: "b" }, undefined, "run-B");
    await tick();
    e.M.cancelPermissionsFor(a.id, "run-A", "Stopped");
    const rA = await pA; let rB = "pending"; pB.then((x) => { rB = x; }); await tick();
    check("P19", "stopping one run cancels only its own prompt (the other stays pending)", rA.behavior === "deny" && rB === "pending");
    e.M.respondPermission(e.perms[1].requestId, { allow: true }); await pB; }

  console.log(`\nPermissions: ${pass} passed, ${failN} failed`);
  if (failN) { console.log(failures.map((f) => " - " + f).join("\n")); process.exitCode = 1; }
  clearTimeout(watchdog);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
