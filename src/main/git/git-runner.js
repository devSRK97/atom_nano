"use strict";
/* How git is invoked, and what may reach it. The spawn-based runner (streamed UTF-8 output with
 * stateful decoding, per-call timeouts, operation ids + cancellation, complete diagnostics, a
 * mutation QUEUE per common Git dir so two mutations sharing an index never interleave), the typed
 * GitError with its classifier, conflictOr (a conflict is a RESULT the UI resolves, not an
 * exception) and the validation of every user-supplied ref / revision / path before any command
 * runs — names pass check-ref-format, revisions resolve behind --end-of-options, paths travel
 * NUL-delimited over stdin with --literal-pathspecs. */
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const { AsyncLocalStorage } = require("async_hooks");
const fs = require("fs");
const path = require("path");

const IS_WIN = process.platform === "win32";

/* ============================== errors ============================== */
class GitError extends Error {
  constructor(summary, { type = "git", details = "", code = null, args = null } = {}) {
    super(summary);
    this.name = "GitError";
    this.type = type;           // notRepo | noGit | lock | auth | network | permission | timeout | canceled | invalid | conflict | notFound | git
    this.details = details;     // COMPLETE stderr/stdout (for the diagnostics view)
    this.code = code;
    this.args = args;
  }
  toJSON() { return { message: this.message, type: this.type, details: this.details, code: this.code }; }
}
function classifyError(text, r) {
  const t = String(text || "").toLowerCase();
  if (r && r.timedOut) return "timeout";
  if (r && r.canceled) return "canceled";
  if (/spawn git enoent|not recognized as an internal|command not found/.test(t) || (r && /ENOENT/.test(r.error || ""))) return "noGit";
  if (/not a git repository/.test(t)) return "notRepo";
  if (/index\.lock|unable to create '.*\.lock'|another git process/.test(t)) return "lock";
  if (/authentication failed|could not read username|permission denied \(publickey\)|invalid credentials|403|unauthori[sz]ed/.test(t)) return "auth";
  if (/could not resolve host|unable to access|connection (refused|timed out|reset)|network is unreachable|failed to connect/.test(t)) return "network";
  if (/permission denied|eacces|eperm|unsafe repository|safe\.directory/.test(t)) return "permission";
  if (/unknown revision|bad revision|not a valid object name|did not match any file|pathspec .* did not match|no such ref|unknown commit/.test(t)) return "notFound";
  return "git";
}
// Surface a complete, typed error from a failed git invocation. The message is a
// concise first line; `details` keeps everything git said.
function fail(r, fallback, forceType) {
  const details = ((r.stderr || "") + (r.stderr && r.stdout ? "\n" : "") + (r.stdout || "") || r.error || "").trim();
  const lines = (details || "").split("\n").map((s) => s.trim()).filter(Boolean);
  // git's own verdict ("fatal:"/"error:") beats hook chatter or progress lines
  const first = lines.find((l) => /^(fatal|error):/i.test(l)) || lines[0] || fallback || "git command failed";
  const summary = first.length > 300 ? first.slice(0, 297) + "…" : first;
  throw new GitError(summary, { type: forceType || classifyError(details || r.error, r), details: details || r.error || "", code: r.code, args: r.args || null });
}
// A mutation's verdict: success, a CONFLICT (a result the caller resolves, never an exception) or a typed failure.
function conflictOr(r, what) {
  const output = (r.stdout + r.stderr).trim();
  if (r.ok) return { ok: true, state: "success", conflict: false, output };
  if (/^CONFLICT \(/m.test(output) || /could not apply/i.test(output) || /automatic merge failed/i.test(output) || /fix conflicts and (then )?run/i.test(output)) return { ok: false, state: "conflict", conflict: true, output };
  fail(r, what);
}

/* ============================== runner ============================== */
const als = new AsyncLocalStorage();            // { opId, label, cwd } for progress + cancel
const ops = new Map();                          // opId → { children: Set<child>, canceled }
let progressSink = null;
let opSeq = 0;
function setProgressSink(fn) { progressSink = typeof fn === "function" ? fn : null; }
function emit(ev) { if (progressSink) { try { progressSink(ev); } catch { /* sink must never break git */ } } }
// Run `fn` as ONE user-visible operation: every git process started inside it
// shares the operation id (progress, cancel), and the caller sees start/end events.
async function runInOperation({ label, cwd }, fn) {
  const opId = `git-${Date.now().toString(36)}-${(++opSeq).toString(36)}`;
  const op = { children: new Set(), canceled: false };
  ops.set(opId, op);
  emit({ kind: "start", opId, label: label || "", cwd: cwd || "" });
  const t0 = Date.now();
  try {
    const res = await als.run({ opId, label, cwd }, fn);
    emit({ kind: "end", opId, ok: true, ms: Date.now() - t0 });
    return res;
  } catch (e) {
    emit({ kind: "end", opId, ok: false, error: (e && e.message) || String(e), type: (e && e.type) || "git", ms: Date.now() - t0 });
    throw e;
  } finally { ops.delete(opId); }
}
function currentOp() { return als.getStore() || null; }
// Cancel every git process still running under an operation. Git leaves the repo
// consistent (index.lock is removed by the dying process); callers re-read state.
function cancel(opId) {
  const op = ops.get(opId);
  if (!op) return false;
  op.canceled = true;
  for (const child of op.children) { try { if (IS_WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGTERM"); } catch { /* */ } }
  return true;
}
// Environment for a git child. Inherited repository-routing variables would make
// git act on another repo than `cwd`; everything else (credential helpers, SSH,
// GPG, editors configured by the user) is preserved.
function gitEnv(extra) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "auto", GIT_OPTIONAL_LOCKS: "0" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[k];
  return Object.assign(env, extra || {});
}
/* Run `git <args>` in cwd with no shell. Options:
 *   timeout (ms) · stdin (string|Buffer) · env (extra vars) · buffer (Buffer stdout)
 *   maxBytes (default 64 MiB → error "output too large", never silently cut)
 * Output is streamed: every stdout/stderr chunk reaches the progress sink with the
 * operation id, so fetch/push progress, hook output and credential waits are
 * visible while they happen. Resolves { ok, code, stdout, stderr, error, ms }. */
function run(cwd, args, opts = {}) {
  const timeout = typeof opts === "number" ? opts : (opts.timeout || 120000);
  const o = typeof opts === "number" ? {} : opts;
  const op = currentOp();
  const reg = op ? ops.get(op.opId) : null;
  const maxBytes = o.maxBytes || 64 * 1024 * 1024;
  return new Promise((resolve) => {
    const t0 = Date.now();
    // A missing working directory would surface as "spawn git ENOENT" — indistinguishable
    // from a missing git executable. Report it for what it is.
    let cwdOk = true; try { cwdOk = !cwd || fs.statSync(cwd).isDirectory(); } catch { cwdOk = false; }
    if (!cwdOk) return resolve({ ok: false, code: -1, stdout: o.buffer ? Buffer.alloc(0) : "", stderr: `fatal: folder does not exist: ${cwd}`, error: "", args, ms: 0 });
    let child;
    try { child = spawn("git", args, { cwd, env: gitEnv(o.env), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { return resolve({ ok: false, code: -1, stdout: o.buffer ? Buffer.alloc(0) : "", stderr: "", error: e.message, args, ms: 0 }); }
    if (reg) reg.children.add(child);
    child.stdin.on("error", () => { /* child exited before reading stdin (EPIPE) — its exit code tells the story */ });
    const outChunks = [], errChunks = [];
    let outBytes = 0, tooLarge = false, timedOut = false;
    const dec = new StringDecoder("utf8"), edec = new StringDecoder("utf8");
    let outText = "", errText = "";
    const onLine = (stream, text) => { if (op && text) emit({ kind: "output", opId: op.opId, cwd, stream, text }); };
    child.stdout.on("data", (b) => {
      outBytes += b.length;
      if (outBytes > maxBytes) { tooLarge = true; try { child.kill(); } catch { /* */ } return; }
      if (o.buffer) outChunks.push(b); else { const s = dec.write(b); outText += s; onLine("stdout", s); }
    });
    child.stderr.on("data", (b) => { const s = edec.write(b); errText += s; errChunks.push(b); onLine("stderr", s); });
    const timer = setTimeout(() => { timedOut = true; try { if (IS_WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGTERM"); } catch { /* */ } }, timeout);
    let settled = false;
    const finish = (code, err) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (reg) reg.children.delete(child);
      if (!o.buffer) outText += dec.end();
      errText += edec.end();
      const canceled = !!(reg && reg.canceled);
      const ok = !err && code === 0 && !tooLarge && !timedOut && !canceled;
      resolve({
        ok, code: typeof code === "number" ? code : (err ? -1 : 0),
        stdout: o.buffer ? Buffer.concat(outChunks) : outText,
        stderr: errText,
        error: err ? (err.message || String(err)) : tooLarge ? `git output exceeded ${Math.round(maxBytes / 1048576)} MiB` : timedOut ? `git ${args[0] || ""} timed out after ${Math.round(timeout / 1000)}s` : canceled ? "canceled" : "",
        timedOut, canceled, tooLarge, args, ms: Date.now() - t0,
      });
    };
    child.on("error", (e) => finish(-1, e));
    child.on("close", (code) => finish(code, null));
    if (o.stdin != null) { try { child.stdin.end(o.stdin); } catch { /* */ } } else { try { child.stdin.end(); } catch { /* */ } }
  });
}
const runBuf = (cwd, args, timeout = 60000) => run(cwd, args, { timeout, buffer: true, maxBytes: 512 * 1024 * 1024 });

/* ============================== repo identity + mutation queue ============================== */
const locks = new Map();   // commonDir → tail promise
async function repoIdentity(cwd) {
  const r = await run(cwd, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], 8000);
  if (!r.ok) fail(r, "not a git repository");
  const [top, gitDir, common] = r.stdout.split(/\r?\n/).map((s) => s.trim());
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(cwd, p)).replace(/\\/g, "/");
  return { root: (top || cwd).replace(/\\/g, "/"), gitDir: abs(gitDir || ".git"), commonDir: abs(common || gitDir || ".git") };
}
// Serialize mutations that share a Git directory. Independent repos run concurrently.
// Re-entrant within one async context: a locked operation that calls another locked
// helper on the same repo (tag delete → remote push) runs it inline instead of
// waiting on itself.
const heldLocks = new AsyncLocalStorage();
async function withLock(cwd, fn) {
  let key = cwd;
  try { key = (await repoIdentity(cwd)).commonDir.toLowerCase(); } catch { /* not a repo → the operation reports it */ }
  const held = heldLocks.getStore() || new Set();
  if (held.has(key)) return fn();
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  locks.set(key, prev.then(() => mine));
  await prev;
  try { return await heldLocks.run(new Set([...held, key]), fn); }
  finally { release(); if (locks.get(key) === mine) locks.delete(key); }
}

/* ============================== validation ============================== */
const optionLike = (s) => /^-/.test(String(s || ""));
// A branch / tag / remote NAME the user typed (or picked). Fully qualified refs are
// built from it; the name itself must be a valid, non-option shorthand.
async function assertRefName(cwd, name, kind = "branch") {
  const n = String(name == null ? "" : name).trim();
  if (!n) throw new GitError(`${kind} name is empty.`, { type: "invalid" });
  if (optionLike(n)) throw new GitError(`“${n}” is not a valid ${kind} name (it looks like a command option).`, { type: "invalid" });
  if (/[\s~^:?*[\\]|\.\.|@\{|^\/|\/$|\/\/|^\.|\/\.|\.lock$/.test(n)) throw new GitError(`“${n}” is not a valid ${kind} name.`, { type: "invalid" });
  const full = kind === "tag" ? `refs/tags/${n}` : kind === "remote" ? `refs/remotes/${n}/x` : `refs/heads/${n}`;
  const r = await run(cwd || process.cwd(), ["check-ref-format", full], 5000);   // `full` always starts with "refs/"
  if (!r.ok) throw new GitError(`“${n}” is not a valid ${kind} name.`, { type: "invalid", details: r.stderr });
  return n;
}
// Resolve a free-form revision (branch, tag, hash, HEAD~1, origin/x…) to a commit
// object id. Option-looking input is refused before git ever sees it.
async function resolveRev(cwd, rev, { kind = "commit" } = {}) {
  const s = String(rev == null ? "" : rev).trim();
  if (!s) throw new GitError("Revision is empty.", { type: "invalid" });
  if (optionLike(s)) throw new GitError(`“${s}” is not a valid revision (it looks like a command option).`, { type: "invalid" });
  const r = await run(cwd, ["rev-parse", "--verify", "-q", "--end-of-options", kind === "commit" ? `${s}^{commit}` : s], 8000);
  if (!r.ok || !r.stdout.trim()) throw new GitError(`“${s}” is not a known revision in this repository.`, { type: "notFound", details: r.stderr });
  return r.stdout.trim();
}
// What kind of ref is `name`? { kind: "local"|"remote"|"tag"|"commit"|"unknown", full, oid }
async function refKind(cwd, name) {
  const s = String(name || "").trim();
  if (!s || optionLike(s)) return { kind: "unknown", full: "", oid: "" };
  for (const [kind, full] of [["local", `refs/heads/${s}`], ["tag", `refs/tags/${s}`], ["remote", `refs/remotes/${s}`]]) {
    const r = await run(cwd, ["rev-parse", "--verify", "-q", "--end-of-options", full], 8000);
    if (r.ok && r.stdout.trim()) return { kind, full, oid: r.stdout.trim() };
  }
  try { return { kind: "commit", full: "", oid: await resolveRev(cwd, s) }; } catch { return { kind: "unknown", full: "", oid: "" }; }
}
// `expect` = { name: oid } captured at review time → every ref must still point there.
async function assertExpected(cwd, expect) {
  if (!expect || typeof expect !== "object") return;
  for (const [name, oid] of Object.entries(expect)) {
    if (!oid) continue;
    const now = await resolveRev(cwd, name).catch(() => "");
    if (now !== oid) throw new GitError(`“${name}” moved since you reviewed it (${String(oid).slice(0, 7)} → ${String(now || "gone").slice(0, 7)}). Refresh and review again.`, { type: "invalid" });
  }
}
// Literal repo-relative paths: no empty entries, no absolute paths, no traversal,
// bytes exactly as given (never trimmed — a trailing space is part of a name).
function normPaths(files) {
  const out = [];
  for (const f of (Array.isArray(files) ? files : [files])) {
    const p = typeof f === "string" ? f : (f && f.path);
    if (p == null || p === "") continue;
    const s = String(p).replace(/\\/g, "/");
    if (/^\/|^[a-zA-Z]:\//.test(s)) throw new GitError(`“${s}” is not a repository-relative path.`, { type: "invalid" });
    if (s.split("/").some((seg) => seg === "..")) throw new GitError(`“${s}” escapes the repository.`, { type: "invalid" });
    out.push(s);
  }
  return out;
}
const nulList = (paths) => paths.map((p) => p + "\0").join("");
// Run a path-taking command with the paths on stdin (NUL-delimited, literal).
function runPaths(cwd, args, paths, opts = {}) {
  return run(cwd, ["--literal-pathspecs", ...args, "--pathspec-from-file=-", "--pathspec-file-nul"], { ...opts, stdin: nulList(paths) });
}

module.exports = { GitError, classifyError, fail, conflictOr, run, runBuf, runInOperation, cancel, setProgressSink, withLock, repoIdentity, optionLike, assertRefName, resolveRev, refKind, assertExpected, normPaths, runPaths };
