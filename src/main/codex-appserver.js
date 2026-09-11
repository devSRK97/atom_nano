"use strict";
/* OPENAI (CODEX) PRIMARY — live transport via `codex app-server` (JSON-RPC over stdio).
 *
 * Why not `codex exec --experimental-json` (codex.js)? Measured on Codex 0.153:
 *   - agent text arrives ONLY as whole `item.completed` messages → no streaming;
 *   - approval requests are auto-DECLINED in exec mode, so under a policy that
 *     asks (e.g. enterprise-managed `approval_policy = untrusted`) every shell
 *     command fails instantly with empty output;
 *   - no graceful interrupt (the child is killed).
 * app-server gives token deltas (`item/agentMessage/delta`), live command output
 * (`item/commandExecution/outputDelta`), approval requests routed to the CLIENT
 * (`item/commandExecution/requestApproval`, …) which we answer from the app's own
 * permission mode / permission cards, `turn/interrupt`, `turn/steer` (Enter mid-turn
 * appends to the running turn), `thread/inject_items` (lossless conversation
 * transfer into a thread), thread resume, thread-level `config` (the app's
 * web-search choice → `web_search`; an explicit reasoning-summary choice), and
 * `account/read` / `account/login/start` so the EFFECTIVE account is known — so a
 * Codex turn behaves like the Claude one: streaming, ordered tool cards, stop,
 * queue, permissions. Field names verified against
 * `codex app-server generate-json-schema` (0.153.4).
 *
 * AUTH CONTEXTS. One app-server process per authentication context:
 *   "login"            the user's Codex login in the real CODEX_HOME (~/.codex)
 *   "apikey:<hash>"    a saved OpenAI API key, in an ISOLATED home under userData
 *                      (Codex persists an API-key login into that home's auth.json,
 *                      so the user's ChatGPT login is never overwritten)
 * A thread is bound to the context it was created in (session.bindings[…].account);
 * runs, steering, interrupts and history injection are routed to that context's
 * server. Contexts run side by side — an account switch never has to stop another
 * account's turn.
 *
 * Framing (observed): newline-delimited JSON, no `jsonrpc` field.
 *   client→server request  {id, method, params}      server reply {id, result|error}
 *   server→client request  {id, method, params}      we reply     {id, result|error}
 *   notification           {method, params}
 * Every failure is returned as a value (never thrown) so claude.js can fall back
 * to the exec transport or report a recoverable state. */
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const CLIENT = { name: "atomnano", title: "AtomNano", version: (() => { try { return require(path.join(__dirname, "..", "..", "package.json")).version || "0"; } catch { return "0"; } })() };
const REQ_TIMEOUT = 60000;
// Server notifications this client never reads AND that carry real volume:
// turn/diff/updated re-sends the whole cumulative diff after every file change;
// fuzzy-file-search sessions belong to a feature the app doesn't use. Everything
// else (lifecycle, auth, usage, progress) keeps flowing — the UI reads it.
const OPT_OUT_NOTIFICATIONS = ["turn/diff/updated", "fuzzyFileSearch/sessionUpdated", "fuzzyFileSearch/sessionCompleted"];
// Codex `web_search` modes (0.153 schema: WebSearchMode). Preference order used when
// the user's choice is disallowed by managed requirements.
const WEB_SEARCH_MODES = ["disabled", "cached", "indexed", "live"];
const REASONING_SUMMARIES = ["auto", "concise", "detailed", "none"];
/* Normalise the app's openaiWebSearch setting to a Codex web_search mode.
 *   true → "live", false → "disabled", a valid mode string → itself,
 *   anything else (unset / "default") → undefined = leave Codex's own config alone. */
function webSearchMode(v) {
  if (v === true) return "live";
  if (v === false) return "disabled";
  return WEB_SEARCH_MODES.includes(v) ? v : undefined;
}

/* ------------------------------ auth contexts ------------------------------ */
function apiKeyHash(key) { return crypto.createHash("sha256").update(String(key || "")).digest("hex").slice(0, 12); }
function ctxKeyOf(auth) { return auth && auth.apiKey ? "apikey:" + apiKeyHash(auth.apiKey) : "login"; }
let userDataDir = null;
function setUserData(d) { if (d) userDataDir = d; }
function userData() {
  if (userDataDir) return userDataDir;
  try { userDataDir = require("electron").app.getPath("userData"); } catch { userDataDir = path.join(require("os").tmpdir(), "atomnano"); }
  return userDataDir;
}
function loginHome() { return process.env.CODEX_HOME || path.join(require("os").homedir(), ".codex"); }
// Isolated Codex home for API-key contexts. Seeded once with the user's
// config.toml (model defaults, MCP servers…) so behaviour matches their login
// context; auth.json in it only ever holds the API key.
function apiKeyHome(auth) {
  const dir = path.join(userData(), "codex-home-apikey-" + apiKeyHash(auth.apiKey));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(loginHome(), "config.toml"), dst = path.join(dir, "config.toml");
    if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
  } catch { /* the server still starts with defaults */ }
  return dir;
}

/* ------------------------------ transport ------------------------------ */
const servers = new Map();        // ctxKey → s
const threadOwner = new Map();    // threadId → s (which context's server owns a live thread)
const globalListeners = new Set();   // notices without a thread (config warnings…)

function log(...a) { console.log("[codex-app]", ...a); }
function binary() {
  try { const cm = require("./codexmodels"); const list = cm.candidates(); return list[0] || ""; } catch { return ""; }
}

function start(auth) {
  const key = ctxKeyOf(auth);
  const cur = servers.get(key);
  if (cur && cur.child && !cur.dead) return cur.ready;
  const file = binary();
  if (!file) return Promise.reject(new Error("no codex binary found (install @openai/codex-sdk or the Codex CLI)"));
  const s = { key, auth: { apiKey: auth && auth.apiKey ? String(auth.apiKey) : "" }, child: null, pending: new Map(), nextId: 1, threads: new Map(), stderr: [], dead: false, dec: new StringDecoder("utf8"), errDec: new StringDecoder("utf8"), buf: "", account: null, req: { approval: null, sandbox: null, webSearch: null } };
  servers.set(key, s);
  s.ready = new Promise((resolve, reject) => {
    let child;
    const env = { ...process.env };
    if (s.auth.apiKey) env.CODEX_HOME = apiKeyHome(s.auth);
    try { child = spawn(file, ["app-server"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env }); }
    catch (e) { s.dead = true; return reject(e); }
    s.child = child;
    // Stateful UTF-8 decoding: a multi-byte character split across two stdout
    // chunks must not become U+FFFD replacement characters in the stream.
    child.stdout.on("data", (d) => onData(s, s.dec.write(d)));
    child.stderr.on("data", (d) => { const t = s.errDec.write(d); s.stderr.push(t); if (s.stderr.length > 40) s.stderr.shift(); if (/error|panic/i.test(t) && !/rejected by user|Rejected\(/i.test(t)) log("stderr:", t.slice(0, 300).trim()); });
    child.on("error", (e) => { s.dead = true; failAll(s, "codex app-server failed to start: " + e.message); reject(e); });
    child.on("exit", (code, sig) => { s.dead = true; onData(s, s.dec.end()); log(`app-server[${key}] exited (${code ?? sig})`); failAll(s, `codex app-server exited (${code ?? sig})`); reject(new Error("app-server exited")); });
    request(s, "initialize", { clientInfo: CLIENT, capabilities: { optOutNotificationMethods: OPT_OUT_NOTIFICATIONS } }, 30000)
      .then(async (r) => {
        try { child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n"); } catch { /* */ }
        // Enterprise-managed requirements restrict approval policies / sandbox modes /
        // web-search modes (e.g. no "never", no "danger-full-access", no "live"). Learn
        // them once so every turn asks for an ALLOWED value instead of tripping a
        // fallback warning or error.
        try {
          const q = await request(s, "configRequirements/read", {}, 10000); const req = (q && q.requirements) || {};
          const arr = (v) => (Array.isArray(v) ? v : null);
          s.req = { approval: arr(req.allowedApprovalPolicies), sandbox: arr(req.allowedSandboxModes), webSearch: arr(req.allowedWebSearchModes) };
          if (s.req.approval || s.req.sandbox || s.req.webSearch) log("requirements:", JSON.stringify(s.req));
        } catch { s.req = { approval: null, sandbox: null, webSearch: null }; }
        // Authentication: an API-key context must be IN api-key mode with THIS key
        // before any turn starts; confirm via account/read rather than assuming.
        try { await ensureAuth(s); } catch (e) { log("auth setup failed:", e.message); }
        resolve(r);
      })
      .catch(reject);
  });
  s.ready.catch(() => {});
  return s.ready;
}
async function ensureAuth(s) {
  let acct = await readAccount(s);
  if (s.auth.apiKey) {
    const wantMode = acct && acct.type === "apiKey";
    if (!wantMode || s.needsKeyLogin) {
      await request(s, "account/login/start", { type: "apiKey", apiKey: s.auth.apiKey }, 20000);
      acct = await readAccount(s);
    }
    if (!acct || acct.type !== "apiKey") throw new Error("Codex did not switch to API-key authentication");
  }
  s.account = acct;
  return acct;
}
async function readAccount(s) {
  const r = await request(s, "account/read", {}, 15000);
  const a = r && r.account;
  s.account = a || null;
  return a || null;
}
function serverFor(auth) { return servers.get(ctxKeyOf(auth)) || null; }
function stop(auth) {
  if (auth === undefined) { for (const s of servers.values()) killServer(s); servers.clear(); threadOwner.clear(); return; }
  const s = serverFor(auth);
  if (s) { killServer(s); servers.delete(s.key); for (const [t, o] of threadOwner) if (o === s) threadOwner.delete(t); }
}
function killServer(s) { if (s && s.child && !s.dead) { try { s.child.kill(); } catch { /* */ } } }
process.on("exit", () => stop());

function failAll(s, message) {
  for (const [, p] of s.pending) { clearTimeout(p.timer); p.reject(new Error(message)); }
  s.pending.clear();
  for (const [, ctx] of s.threads) { try { ctx.fail(message); } catch { /* */ } }
  s.threads.clear();
}
function onData(s, chunk) {
  if (!chunk) return;
  s.buf += chunk;
  let i;
  while ((i = s.buf.indexOf("\n")) >= 0) {
    const line = s.buf.slice(0, i).trim();
    s.buf = s.buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    try { dispatch(s, msg); } catch (e) { log("dispatch error:", e.message); }
  }
}
function write(s, obj) { try { s.child.stdin.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; } }
function request(s, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = s.nextId++;
    const timer = setTimeout(() => { s.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs || REQ_TIMEOUT);
    s.pending.set(id, { resolve, reject, timer, method });
    if (!write(s, { id, method, params: params || {} })) { clearTimeout(timer); s.pending.delete(id); reject(new Error("app-server stdin closed")); }
  });
}
function dispatch(s, msg) {
  const hasId = msg.id !== undefined && msg.id !== null;
  if (hasId && msg.method) return onServerRequest(s, msg);              // server → client request
  if (hasId) {                                                           // reply to one of ours
    const p = s.pending.get(msg.id); if (!p) return;
    s.pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) { const e = new Error((msg.error && msg.error.message) || "request failed"); e.code = msg.error && msg.error.code; e.data = msg.error && msg.error.data; p.reject(e); }
    else p.resolve(msg.result);
    return;
  }
  if (msg.method) return onNotification(s, msg.method, msg.params || {});
}
function ctxFor(s, threadId) { return threadId ? s.threads.get(threadId) : null; }

const TRACE = !!process.env.ATOMNANO_CODEX_TRACE;   // set to log every app-server notification (debugging)
function onNotification(s, method, p) {
  if (TRACE && !/tokenUsage|mcpServer|remoteControl/.test(method)) log("trace", method, JSON.stringify(p).slice(0, 220));
  if (method === "account/updated" || method === "account/login/completed") { readAccount(s).catch(() => {}); }
  const ctx = ctxFor(s, p.threadId);
  // Server-wide notices (no thread): config / deprecation warnings.
  if (!ctx) {
    if (method === "configWarning" || method === "deprecationNotice" || method === "warning") {
      const text = (p.summary || p.message || "") + (p.details ? ` — ${p.details}` : "");
      for (const cb of globalListeners) { try { cb(text); } catch { /* */ } }
      for (const [, c] of s.threads) c.notice(text);
    }
    return;
  }
  ctx.onNotification(method, p);
}
function onServerRequest(s, msg) {
  const p = msg.params || {};
  const ctx = ctxFor(s, p.threadId);
  const reply = (result) => write(s, { id: msg.id, result });
  const replyErr = (code, message) => write(s, { id: msg.id, error: { code, message } });
  // A request for a thread we do not track (a sub-agent's child thread, a thread id that
  // differs from the one we resumed) still belongs to the user's ONE running turn on this
  // server: route it there so the user is asked instead of a silent decline.
  let target = ctx;
  if (!target && s.threads.size === 1) { target = [...s.threads.values()][0]; target.notice && target.notice(`Codex asked for approval on thread ${p.threadId || "?"} (a sub-agent) — routed to this turn.`); }
  if (!target) { // nobody to ask → safest answer per kind, and say so
    log("server request without a live turn:", msg.method, p.threadId);
    if (msg.method === "item/commandExecution/requestApproval" || msg.method === "item/fileChange/requestApproval") return reply({ decision: "decline" });
    if (msg.method === "item/tool/requestUserInput") return reply({ answers: {} });
    if (msg.method === "mcpServer/elicitation/request") return reply({ action: "decline", content: null, _meta: null });
    return replyErr(-32601, "unsupported: " + msg.method);
  }
  target.onServerRequest(msg.method, p).then((res) => {
    if (res && res.__error) return replyErr(res.code || -32000, res.message || "declined");
    reply(res);
  }).catch((e) => replyErr(-32000, String((e && e.message) || e)));
}

/* --------------------------- permission mapping --------------------------- */
// The app's permission modes → Codex approval policy + sandbox, clamped to what the
// (possibly enterprise-managed) requirements allow. Preference order per mode; the
// first allowed wins; if none is allowed the field is omitted (server default).
// The user's mode is still honoured exactly, because WE answer every approval
// request Codex sends (Full access auto-accepts, Plan declines, others ask).
const PREFS = {
  bypassPermissions: { approval: ["never", "on-request", "untrusted"], sandbox: ["danger-full-access", "workspace-write", "read-only"] },
  acceptEdits: { approval: ["on-request", "untrusted"], sandbox: ["workspace-write", "read-only"] },
  plan: { approval: ["on-request", "untrusted"], sandbox: ["read-only", "workspace-write"] },
  default: { approval: ["untrusted", "on-request"], sandbox: ["workspace-write", "read-only"] },
};
function policyFor(mode, req) {
  const pref = PREFS[mode] || PREFS.default;
  const pick = (want, allowed) => { if (!allowed) return want[0]; const hit = want.find((w) => allowed.includes(w)); return hit || undefined; };
  const out = {};
  const ap = pick(pref.approval, req && req.approval); if (ap) out.approvalPolicy = ap;
  const sb = pick(pref.sandbox, req && req.sandbox); if (sb) out.sandbox = sb;
  return out;
}
/* The app's web-search choice → `web_search` config for this thread, clamped to
 * allowedWebSearchModes. A disallowed choice degrades toward "less internet"
 * (live → indexed → cached → disabled) so a managed "no live search" policy still
 * leaves search on rather than silently falling back to the server default.
 * Returns undefined when the app has no opinion (Codex's own config applies). */
function webSearchFor(setting, req) {
  const want = webSearchMode(setting);
  if (!want) return undefined;
  const allowed = req && req.webSearch;
  if (!allowed || allowed.includes(want)) return want;
  const order = WEB_SEARCH_MODES.slice(0, WEB_SEARCH_MODES.indexOf(want) + 1).reverse();
  return order.find((m) => allowed.includes(m));
}
// A requirements violation reads like: invalid value for `sandbox_mode`: `X` is not in the allowed set […]
const isRequirementsError = (e) => /not in the allowed set|disallowed by requirements/i.test(String((e && e.message) || e || ""));
// A resume whose thread is simply gone (cleared sessions, other machine, other
// account's home) — distinct from transient / auth / policy failures.
const isThreadLost = (e) => /no rollout found|not found|unknown thread|no such thread|does not exist/i.test(String((e && e.message) || e || ""));
const isAuthFailure = (e) => /unauthori[sz]ed|401|403|not logged in|login required|auth/i.test(String((e && e.message) || e || ""));

/* ------------------------------ one turn ------------------------------ */
/* run({ apiKey, model, effort, cwd, promptText, images, files, resumeId, mode, webSearch, reasoningSummary, signal, on, decide, beforeTurn })
 *  apiKey:      the app's saved OpenAI key → this turn runs in the API-key auth context
 *               (isolated Codex home). Absent → the user's Codex login.
 *  webSearch:   the app's openaiWebSearch setting (true/false/"disabled"|"cached"|"indexed"|"live");
 *               unset → Codex's own config.toml `web_search` applies (its default is "cached").
 *  reasoningSummary: explicit "auto"|"concise"|"detailed"|"none"; unset → Codex default.
 *  files:       [{ path, name }] attached text files → native `mention` inputs (Codex reads them itself)
 *  beforeTurn:  async (threadId, isNew) → called once the thread exists, BEFORE turn/start
 *               (the caller injects conversation history here for a new thread).
 *  on.onThreadId(id) · onTurnId(id) · onTextDelta(d) · onAgentMessage(text, item) ·
 *  onReasoningDelta(d) · onReasoning(text) · onToolStart(item) · onToolOutput(itemId, delta) ·
 *  onToolUpdate(item) · onToolEnd(item) · onPlan(steps, explanation) · onNotice(text) ·
 *  onRetry(text) · onUsage(usage) · onRerouted(from, to, reason) · onAccount(account)
 *  decide(kind, params, ctx) → Promise<result>  kind: command | fileChange | permissions | userInput | elicitation | toolCall
 * Returns { ok, text, threadId, turnId, usage, account, error, errorInfo, aborted, loadFailed, threadLost, resumeFailed }.
 *   threadLost   — the resumed thread no longer exists: the caller owns recovery
 *                  (new thread + exact history transfer); nothing was generated.
 *   resumeFailed — resume failed for a transient/auth/policy reason: the thread
 *                  reference is preserved; nothing was generated. */
async function run({ apiKey, model, effort, cwd, promptText, images, files, resumeId, mode, summary, config, webSearch, reasoningSummary, signal, on, decide, beforeTurn } = {}) {
  on = on || {}; const call = (fn, ...a) => { try { return fn && fn(...a); } catch (e) { log("callback error:", e.message); } };
  const auth = { apiKey: apiKey || "" };
  const aborted = () => !!(signal && signal.aborted);
  const bail = (extra) => ({ ok: false, aborted: true, threadId: resumeId || null, ...(extra || {}) });
  let s;
  try { await start(auth); s = serverFor(auth); } catch (e) { return { ok: false, loadFailed: true, error: "codex app-server unavailable: " + ((e && e.message) || e) }; }
  if (aborted()) return bail();
  if (s.auth.apiKey && !(s.account && s.account.type === "apiKey")) {
    try { await ensureAuth(s); } catch (e) { return { ok: false, error: "Codex API-key authentication failed: " + ((e && e.message) || e), authFailed: true, threadId: resumeId || null }; }
    if (aborted()) return bail();
  }
  call(on.onAccount, s.account);

  let pol = policyFor(mode, s.req);
  // "Full access" under enterprise-managed requirements: Codex may forbid `never` / the
  // unsandboxed mode. The app still auto-approves every request Codex sends, but sandbox
  // restrictions (network, paths outside the workspace) still apply — say so, once per turn.
  if (mode === "bypassPermissions" && (pol.approvalPolicy !== "never" || pol.sandbox !== "danger-full-access")) {
    call(on.onNotice, `Full access is limited by your Codex requirements (approval policy "${pol.approvalPolicy || "server default"}", sandbox "${pol.sandbox || "server default"}"). AtomNano auto-approves every request Codex makes, but the sandbox may still block network access or paths outside the workspace.`);
  }
  // Thread-level config overrides (thread/start + thread/resume accept `config`):
  // the app's web-search choice and, only when the user picked one, a reasoning
  // summary mode. Without `web_search` here Codex silently uses ~/.codex/config.toml.
  const ws = webSearchFor(webSearch, s.req);
  if (webSearchMode(webSearch) && ws !== webSearchMode(webSearch)) call(on.onNotice, ws ? `Web search "${webSearchMode(webSearch)}" is not allowed by your Codex requirements — using "${ws}".` : `Web search "${webSearchMode(webSearch)}" is not allowed by your Codex requirements — using the Codex default.`);
  const cfg = { ...(config && typeof config === "object" ? config : {}), ...(ws ? { web_search: ws } : {}) };
  const rsum = REASONING_SUMMARIES.includes(reasoningSummary) ? reasoningSummary : (REASONING_SUMMARIES.includes(summary) ? summary : undefined);
  if (rsum) cfg.model_reasoning_summary = rsum;
  const common = () => ({ cwd: cwd || process.cwd(), model: model || undefined, ...(pol.approvalPolicy ? { approvalPolicy: pol.approvalPolicy } : {}), ...(pol.sandbox ? { sandbox: pol.sandbox } : {}), ...(Object.keys(cfg).length ? { config: cfg } : {}) });
  // Requirements we didn't know about (or that changed) → retry once with server defaults.
  const withPolicyRetry = async (fn) => { try { return await fn(); } catch (e) { if (!isRequirementsError(e) || (!pol.approvalPolicy && !pol.sandbox)) throw e; log("requirements rejected our policy, retrying with defaults:", String(e.message).slice(0, 160)); pol = {}; return fn(); } };

  // 1. thread: resume the saved one, else start fresh. A failed resume is NEVER
  //    papered over with a blank thread — the caller decides how to recover.
  let threadId = null, isNew = false;
  try {
    if (resumeId) {
      // "Enter interrupts & runs now": the previous turn on this thread may still be
      // winding down from turn/interrupt — wait for it (bounded) before resuming.
      const prev = s.threads.get(resumeId);
      if (prev && prev.done) await Promise.race([prev.done, new Promise((r) => setTimeout(r, 4500))]);
      if (aborted()) return bail();
      try {
        // excludeTurns: we only need the id back — the app keeps its own transcript.
        const r = await withPolicyRetry(() => request(s, "thread/resume", { threadId: resumeId, excludeTurns: true, ...common() }));
        threadId = (r && r.thread && r.thread.id) || resumeId;
      } catch (e) {
        if (/already/i.test(String(e.message || ""))) threadId = resumeId;
        else if (isThreadLost(e)) return { ok: false, threadLost: true, error: "Codex thread no longer exists: " + e.message, threadId: resumeId };
        else return { ok: false, resumeFailed: true, authFailed: isAuthFailure(e), error: "Codex could not resume the thread: " + e.message, threadId: resumeId };
      }
    }
    if (aborted()) return bail();
    if (!threadId) { const r = await withPolicyRetry(() => request(s, "thread/start", { ...common(), threadSource: "atomnano" })); threadId = r && r.thread && r.thread.id; isNew = true; }
  } catch (e) { return { ok: false, error: "codex thread start failed: " + ((e && e.message) || e), threadId: resumeId || null }; }
  if (!threadId) return { ok: false, error: "codex thread start returned no id", threadId: resumeId || null };
  threadOwner.set(threadId, s);
  call(on.onThreadId, threadId, isNew, s.key);
  if (aborted()) return bail({ threadId });
  if (beforeTurn) {
    try { await beforeTurn(threadId, isNew); } catch (e) { return { ok: false, error: "conversation transfer failed: " + ((e && e.message) || e), threadId }; }
    if (aborted()) return bail({ threadId });
  }

  // 2. per-thread context receives notifications + server requests until the turn completes
  let finish;
  const done = new Promise((r) => { finish = r; });
  const st = { turnId: null, text: [], msgText: new Map(), reasonLen: new Map(), usage: null, finished: false, errorMsg: "", errorInfo: null, retryTimer: null };
  const items = new Map();   // itemId → last seen item
  const TOOL_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "imageView", "imageGeneration", "sleep"]);
  const end = (res) => {
    if (st.finished) return;
    st.finished = true; clearTimeout(st.retryTimer); s.threads.delete(threadId); finish(res);
    // A login change arrived while this turn ran: now that the server is idle, drop
    // it so the next start re-reads auth.json under the newly selected account.
    if (s.restartWhenIdle && !s.threads.size) { s.restartWhenIdle = false; setTimeout(() => { if (!s.threads.size) { killServer(s); if (servers.get(s.key) === s) servers.delete(s.key); } }, 0); }
  };
  const ctx = {
    done,
    get turnId() { return st.turnId; },   // steer() checks the live turn before appending to it
    notice: (t) => call(on.onNotice, t),
    fail: (message) => end({ ok: false, error: message, threadId, turnId: st.turnId, usage: st.usage }),
    onNotification: (method, p) => {
      if (st.turnId && p.turnId && p.turnId !== st.turnId && method !== "thread/tokenUsage/updated") return;   // another turn on this thread (shouldn't happen)
      switch (method) {
        // The turn id also comes back in the turn/start response (below); whichever
        // lands first wins and the other is a no-op, so onTurnId fires exactly once.
        case "turn/started": if (p.turn && p.turn.id && p.turn.id !== st.turnId) { st.turnId = p.turn.id; call(on.onTurnId, st.turnId); } break;
        case "item/started": {
          const it = p.item; if (!it) break; items.set(it.id, it);
          if (TOOL_TYPES.has(it.type)) call(on.onToolStart, it);
          else if (it.type === "enteredReviewMode") call(on.onNotice, "Codex entered review mode" + (it.review ? `: ${it.review}` : ""));
          break;
        }
        case "item/agentMessage/delta": st.msgText.set(p.itemId, (st.msgText.get(p.itemId) || "") + (p.delta || "")); call(on.onTextDelta, p.delta || ""); break;
        case "item/plan/delta": call(on.onTextDelta, p.delta || ""); break;
        case "item/reasoning/summaryTextDelta": case "item/reasoning/textDelta": st.reasonLen.set(p.itemId, (st.reasonLen.get(p.itemId) || 0) + (p.delta || "").length); call(on.onReasoningDelta, p.delta || ""); break;
        // a new summary part → one line break, only after existing text (no blank gaps)
        case "item/reasoning/summaryPartAdded": if (st.reasonLen.get(p.itemId)) { st.reasonLen.set(p.itemId, st.reasonLen.get(p.itemId) + 1); call(on.onReasoningDelta, "\n"); } break;
        case "item/commandExecution/outputDelta": call(on.onToolOutput, p.itemId, p.delta || ""); break;
        case "item/fileChange/outputDelta": call(on.onToolOutput, p.itemId, p.delta || ""); break;
        case "item/fileChange/patchUpdated": case "item/mcpToolCall/progress": {
          const prev = items.get(p.itemId); if (prev) call(on.onToolUpdate, { ...prev, ...(p.item || {}), progress: p.message || undefined });
          break;
        }
        case "item/completed": {
          const it = p.item; if (!it) break; items.set(it.id, it);
          if (it.type === "agentMessage") {
            const text = it.text || st.msgText.get(it.id) || "";
            if (text) st.text.push(text);
            call(on.onAgentMessage, text, it);
          } else if (it.type === "plan") {
            if (it.text) { st.text.push(it.text); call(on.onAgentMessage, it.text, it); }
          } else if (it.type === "reasoning") {
            const parts = ((it.summary && it.summary.length) ? it.summary : (it.content || [])).map((x) => String(x || "").trim()).filter(Boolean);
            call(on.onReasoning, parts.join("\n"));
          } else if (TOOL_TYPES.has(it.type)) call(on.onToolEnd, it);
          else if (it.type === "contextCompaction") call(on.onNotice, "Codex compacted the conversation context.");
          else if (it.type === "exitedReviewMode") call(on.onNotice, "Codex review finished" + (it.review ? `: ${it.review.slice(0, 400)}` : ""));
          break;
        }
        case "turn/plan/updated": call(on.onPlan, p.plan || [], p.explanation || ""); break;
        case "thread/tokenUsage/updated": {
          const tu = p.tokenUsage || {};
          const norm = (u) => u ? { input_tokens: u.inputTokens || 0, cached_input_tokens: u.cachedInputTokens || 0, cache_write_input_tokens: u.cacheWriteInputTokens || 0, output_tokens: u.outputTokens || 0, reasoning_output_tokens: u.reasoningOutputTokens || 0, total_tokens: u.totalTokens || 0 } : null;
          // `last` = this turn so far (cumulative within the turn); `total` = the
          // whole thread. Both are exposed; the caller applies the turn's FINAL
          // `last` once at turn/completed, never per notification.
          const last = norm(tu.last), total = norm(tu.total);
          if (last || total) { st.usage = { ...(last || total), last, total, context_window: tu.modelContextWindow || null }; call(on.onUsage, st.usage); }
          break;
        }
        case "model/rerouted": call(on.onRerouted, p.fromModel, p.toModel, p.reason); break;
        case "warning": call(on.onNotice, p.message || ""); break;
        case "error": {
          const msg = (p.error && p.error.message) || "error";
          if (p.willRetry) { call(on.onRetry, msg); break; }
          st.errorMsg = msg; st.errorInfo = (p.error && p.error.codexErrorInfo) || null;
          // turn/completed(failed) normally follows; if it doesn't, don't hang the tab
          clearTimeout(st.retryTimer); st.retryTimer = setTimeout(() => end({ ok: false, error: st.errorMsg, errorInfo: st.errorInfo, threadId, turnId: st.turnId, usage: st.usage }), 15000);
          break;
        }
        case "turn/completed": {
          const t = p.turn || {};
          if (st.turnId && t.id && t.id !== st.turnId) break;
          if (t.status === "interrupted") return end({ ok: false, aborted: true, threadId, turnId: st.turnId, usage: st.usage, text: st.text.join("\n\n") });
          if (t.status === "failed") { const em = (t.error && t.error.message) || st.errorMsg || "turn failed"; return end({ ok: false, error: em, errorInfo: (t.error && t.error.codexErrorInfo) || st.errorInfo, threadId, turnId: st.turnId, usage: st.usage, text: st.text.join("\n\n") }); }
          return end({ ok: true, text: st.text.join("\n\n"), threadId, turnId: st.turnId, usage: st.usage, account: s.account });
        }
        case "thread/closed": end({ ok: false, error: "Codex closed the thread", threadId, turnId: st.turnId, usage: st.usage }); break;
        default: break;
      }
    },
    onServerRequest: async (method, p) => {
      const item = items.get(p.itemId) || null;
      const ask = async (kind, extra) => { if (!decide) return null; return decide(kind, { ...p, ...(extra || {}) }, { item, threadId, turnId: st.turnId }); };
      switch (method) {
        case "item/commandExecution/requestApproval": { const r = await ask("command"); return { decision: (r && r.decision) || "decline" }; }
        case "item/fileChange/requestApproval": { const r = await ask("fileChange"); return { decision: (r && r.decision) || "decline" }; }
        case "item/permissions/requestApproval": {
          const r = await ask("permissions");
          if (r && r.grant) {   // grant exactly what was requested (GrantedPermissionProfile has optional, non-null fields)
            const req = p.permissions || {}; const granted = {};
            if (req.network) granted.network = req.network;
            if (req.fileSystem) granted.fileSystem = req.fileSystem;
            return { permissions: granted, scope: r.scope || "turn" };
          }
          return { __error: true, code: -32000, message: (r && r.message) || "Permission declined by user" };
        }
        case "item/tool/requestUserInput": { const r = await ask("userInput"); return { answers: (r && r.answers) || {} }; }
        case "mcpServer/elicitation/request": { const r = await ask("elicitation"); return r && r.action ? r : { action: "decline", content: null, _meta: null }; }
        case "item/tool/call": return { __error: true, code: -32601, message: "no dynamic tools registered" };
        default: return { __error: true, code: -32601, message: "unsupported: " + method };
      }
    },
  };
  s.threads.set(threadId, ctx);

  // 3. the turn. Input = the exact prompt text, attached files as native mentions
  //    (Codex reads them itself — no inlining, no size caps), images as localImage.
  const input = [{ type: "text", text: String(promptText || ""), text_elements: [] }];
  for (const f of (files || [])) if (f && f.path) input.push({ type: "mention", name: f.name || path.basename(f.path), path: f.path });
  for (const im of (images || [])) if (im && im.path) input.push({ type: "localImage", path: im.path });
  // Cancellation must be honoured at EVERY await above and right before turn/start —
  // a Stop during thread/resume or thread/start must never launch generation.
  if (aborted()) { s.threads.delete(threadId); return bail({ threadId }); }
  const doInterrupt = () => { if (st.finished) return; interrupt(threadId, st.turnId).catch(() => {}); setTimeout(() => end({ ok: false, aborted: true, threadId, turnId: st.turnId, usage: st.usage, text: st.text.join("\n\n") }), 4000); };
  const onAbort = () => doInterrupt();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    // Sandbox is set at thread level (a per-turn sandboxPolicy would override a
    // managed permission profile and trip a warning); approval policy per turn so a
    // mode change between turns applies without a new thread.
    const turnParams = { threadId, input, cwd: cwd || process.cwd(), ...(pol.approvalPolicy ? { approvalPolicy: pol.approvalPolicy } : {}), model: model || undefined, effort: effort || undefined, ...(rsum ? { summary: rsum } : {}) };
    if (TRACE) log("trace turn/start", JSON.stringify({ ...turnParams, input: `[${String(promptText || "").length} chars, ${input.length - 1} attachments]` }));
    if (aborted()) { s.threads.delete(threadId); if (signal) signal.removeEventListener("abort", onAbort); return bail({ threadId }); }
    const r = await withPolicyRetry(() => request(s, "turn/start", turnParams));
    if (r && r.turn && r.turn.id && !st.turnId) { st.turnId = r.turn.id; call(on.onTurnId, st.turnId); }
  } catch (e) {
    s.threads.delete(threadId);
    if (signal) signal.removeEventListener("abort", onAbort);
    return { ok: false, error: "codex turn start failed: " + ((e && e.message) || e), threadId };
  }
  if (aborted() && !st.finished) doInterrupt();
  const res = await done;
  if (signal) signal.removeEventListener("abort", onAbort);
  if (aborted() && !res.aborted && !res.ok) res.aborted = true;
  if (!res.account) res.account = s.account;
  return res;
}

// Graceful stop of the running turn (the turn then completes with status "interrupted").
async function interrupt(threadId, turnId) {
  const s = threadOwner.get(threadId);
  if (!s || s.dead || !threadId || !turnId) return false;
  try { await request(s, "turn/interrupt", { threadId, turnId }, 10000); return true; } catch (e) { log("interrupt failed:", e.message); return false; }
}
/* Steer the RUNNING turn: append new user input to it without stopping (what
 * Codex's own TUI does on Enter mid-turn). `expectedTurnId` is a precondition —
 * the server rejects the request if that turn already finished, so the caller
 * can fall back to interrupt + new turn. Returns { ok, turnId } | { ok:false, error }. */
async function steer(threadId, turnId, promptText, images, files) {
  const s = threadOwner.get(threadId);
  if (!s || s.dead || !threadId || !turnId) return { ok: false, error: "no active codex turn" };
  const ctx = s.threads.get(threadId);
  if (!ctx || (ctx.turnId && ctx.turnId !== turnId)) return { ok: false, error: "turn is not running" };
  const input = [{ type: "text", text: String(promptText || ""), text_elements: [] }];
  for (const f of (files || [])) if (f && f.path) input.push({ type: "mention", name: f.name || path.basename(f.path), path: f.path });
  for (const im of (images || [])) if (im && im.path) input.push({ type: "localImage", path: im.path });
  try { const r = await request(s, "turn/steer", { threadId, expectedTurnId: turnId, input }, 10000); return { ok: true, turnId: (r && r.turnId) || turnId }; }
  catch (e) { log("steer failed:", e.message); return { ok: false, error: (e && e.message) || String(e) }; }
}
/* Append conversation history to a thread's model-visible context WITHOUT starting
 * generation (`thread/inject_items`, Responses API items). This is how a Codex
 * thread receives the exact record of turns that happened on another provider /
 * in a thread that was lost. Throws on failure — a transfer that silently didn't
 * happen would leave the model missing context it is believed to have. */
async function injectItems(threadId, items) {
  const s = threadOwner.get(threadId);
  if (!s || s.dead) throw new Error("no codex server owns thread " + threadId);
  if (!Array.isArray(items) || !items.length) return { ok: true, count: 0 };
  await request(s, "thread/inject_items", { threadId, items }, 60000);
  return { ok: true, count: items.length };
}
// Live, account-aware model list from Codex itself (used by codexmodels as a source).
async function listModels(auth) {
  await start(auth || {});
  const s = serverFor(auth || {});
  const r = await request(s, "model/list", {}, 20000);
  return (r && r.data) || [];
}
// The account the app-server is ACTUALLY using (type / email / plan) — read from the
// runtime, never inferred from a profile label. `force` re-reads after a switch.
async function accountRead(auth, { force } = {}) {
  await start(auth || {});
  const s = serverFor(auth || {});
  if (force || !s.account) await readAccount(s);
  return s.account;
}
/* After the user's Codex login file changed (profile switch / sign-out / sign-in):
 * restart the login-context server when it is idle so it re-reads auth.json, then
 * confirm the effective account. A busy server is flagged to restart when its last
 * turn finishes (running turns keep their original credentials). Returns the
 * account the runtime reports, or null when signed out. */
async function refreshLoginContext() {
  const s = servers.get("login");
  if (s && !s.dead) {
    if (s.threads.size) { s.restartWhenIdle = true; return s.account; }
    stop({});
  }
  try { return await accountRead({}, { force: true }); } catch { return null; }
}
function onNotice(cb) { globalListeners.add(cb); return () => globalListeners.delete(cb); }
function alive(auth) { const s = auth === undefined ? [...servers.values()].some((x) => x.child && !x.dead) : serverFor(auth); return !!(s && (auth === undefined ? s : (s.child && !s.dead))); }
function requirements(auth) { const s = serverFor(auth || {}); return (s && s.req) || { approval: null, sandbox: null, webSearch: null }; }
function busy() { for (const s of servers.values()) if (s.threads.size) return true; return false; }

module.exports = {
  run, interrupt, steer, injectItems, listModels, accountRead, refreshLoginContext, policyFor, requirements, webSearchMode, webSearchFor, WEB_SEARCH_MODES, REASONING_SUMMARIES,
  start, stop, alive, busy, onNotice, ctxKeyOf, setUserData,
  __internals: { onData, isThreadLost, isRequirementsError, StringDecoder, onServerRequest, servers, threadOwner },
};
