"use strict";
/* Git integration — a precise wrapper over the system `git` executable.
 *
 * Contracts (shared by every IPC route, Git Center and the legacy panels):
 *
 *   RUNNER      spawn-based, streamed stdout/stderr (stateful UTF-8 decoding),
 *               per-call timeouts, operation ids + cancellation, complete
 *               diagnostics (never truncated into a 400-char blob), and a mutation
 *               QUEUE per repository (keyed by the common Git dir) so two mutations
 *               sharing an index/refs never interleave. Read work runs freely.
 *   REFS        every user-supplied branch / tag / revision is validated before
 *               any command runs: names must pass `git check-ref-format`, may not
 *               start with "-", and revisions resolve to an object id with an
 *               explicit end-of-options boundary. Commands take fully qualified
 *               refs (refs/heads/…, refs/tags/…) so a name can never become an
 *               option. Mutations that were reviewed against specific object ids
 *               revalidate them right before running (`expect`).
 *   PATHS       paths from status / the UI are LITERAL: transported NUL-delimited
 *               over stdin (--pathspec-from-file=- --pathspec-file-nul) with
 *               --literal-pathspecs, so `a[1].txt` never also matches `a1.txt`,
 *               Windows argument-length limits don't apply, and quoting/escaping
 *               never leaks into a path. Status uses porcelain v2 -z (real bytes).
 *   RESULTS     mutations return { ok, state: "success"|"conflict"|"failed"|
 *               "partial", …phases }. Conflicts are results, not exceptions.
 *               Failures throw GitError { type, summary, details, code }.
 *   COMMITPLAN  a reviewed set of path operations is committed from a TEMPORARY
 *               index (HEAD + exactly the selected paths, renames as pairs,
 *               explicit untrack intent honoured), through `git commit` so hooks
 *               and signing still run; only the selected entries are then
 *               reconciled in the real index. Unrelated staged work is untouched.
 *
 * Credentials are never handled here: pull/push rely on the user's configured
 * credential helper / SSH agent, exactly like running git in a terminal. */
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const { AsyncLocalStorage } = require("async_hooks");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DEVNULL = process.platform === "win32" ? "NUL" : "/dev/null";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
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

/* ============================== discovery ============================== */
// Explicit repository probe: { repo, root, error?, type? } — a missing git
// executable or an inaccessible path is an ERROR, never "not a repo".
async function probe(cwd) {
  if (!cwd) return { repo: false, root: "" };
  const r = await run(cwd, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], 8000);
  if (r.ok) { const [inside, top] = r.stdout.split(/\r?\n/); return { repo: /true/.test(inside || ""), root: (top || "").trim().replace(/\\/g, "/") }; }
  const type = classifyError(r.stderr, r);
  if (type === "notRepo" || /not a git repository/i.test(r.stderr)) return { repo: false, root: "" };
  return { repo: false, root: "", error: (r.stderr || r.error || "").trim().split("\n")[0], type };
}
async function isRepo(cwd) { const p = await probe(cwd); if (p.error) throw new GitError(p.error, { type: p.type }); return p.repo; }
async function repoRoot(cwd) { const p = await probe(cwd).catch(() => ({ root: "" })); return p.root || ""; }
async function repos(root) {
  if (!root) return [];
  const p = await probe(root);
  if (p.error) throw new GitError(p.error, { type: p.type });
  if (p.repo && p.root) return [p.root];
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { throw new GitError(`Cannot read ${root}: ${e.message}`, { type: "permission" }); }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules" || e.name === "$RECYCLE.BIN" || e.name.startsWith(".")) continue;
    const sub = path.join(root, e.name);
    try { fs.statSync(path.join(sub, ".git")); out.push(sub.replace(/\\/g, "/")); } catch { /* not a repo */ }
  }
  return out;
}
async function repoForFile(filePath) { if (!filePath) return ""; try { return await repoRoot(path.dirname(filePath)); } catch { return ""; } }
function isRepoDir(dir) { if (!dir) return false; try { return fs.existsSync(path.join(dir, ".git")); } catch { return false; } }

/* ============================== status (porcelain v2, NUL) ============================== */
const LABELS = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Conflict", "?": "Untracked", "!": "Ignored" };
function labelFor(index, worktree, untracked) {
  if (untracked && !index && !worktree) return "Untracked";
  const code = index && index !== "." ? index : worktree;
  return LABELS[code] || "Changed";
}
/* One record per path:
 *   { path, orig, index, worktree, staged, unstaged, untracked, conflict, label,
 *     stagedDelete, keptOnDisk, mode, x, y }
 * `index` / `worktree` are the two porcelain columns ("." = unchanged); `x`/`y`
 * mirror them as the legacy single letters. A path that is staged-deleted AND
 * present untracked (the "unversioned" case) is ONE record with keptOnDisk=true. */
async function status(cwd, { paths } = {}) {
  const p = await probe(cwd);
  if (p.error) throw new GitError(p.error, { type: p.type });
  if (!p.repo) return { repo: false };
  // (`git status` has no --pathspec-from-file; a path filter is applied to the parsed records.)
  const r = await run(cwd, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--renames"], 30000);
  if (!r.ok) fail(r, "git status failed");
  const only = paths && paths.length ? new Set(normPaths(paths)) : null;
  const recs = r.stdout.split("\0");
  let branch = "", oid = "", upstream = "", ahead = 0, behind = 0, detached = false, unborn = false;
  const files = [];
  const byPath = new Map();
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    if (rec.startsWith("# ")) {
      const [, key, ...rest] = rec.split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") { oid = val === "(initial)" ? "" : val; unborn = val === "(initial)"; }
      else if (key === "branch.head") { if (val === "(detached)") detached = true; else branch = val; }
      else if (key === "branch.upstream") upstream = val;
      else if (key === "branch.ab") { const m = /\+(\d+) -(\d+)/.exec(val); if (m) { ahead = +m[1]; behind = +m[2]; } }
      continue;
    }
    const t = rec[0];
    if (t === "1" || t === "2") {
      // 1 XY sub mH mI mW hH hI path        2 XY sub mH mI mW hH hI Xscore path\0orig
      const parts = rec.split(" ");
      const xy = parts[1];
      const fixed = t === "1" ? 8 : 9;
      let rest = rec; for (let k = 0; k < fixed; k++) rest = rest.slice(rest.indexOf(" ") + 1);
      const pth = rest;
      let orig = "";
      if (t === "2") { orig = recs[++i] || ""; }
      const X = xy[0], Y = xy[1];
      const index = X === "." ? "" : X, worktree = Y === "." ? "" : Y;
      const rec2 = { path: pth, orig, index, worktree, x: X === "." ? " " : X, y: Y === "." ? " " : Y, mode: parts[5] || "",
        staged: !!index, unstaged: !!worktree, untracked: false, conflict: false, stagedDelete: index === "D", keptOnDisk: false,
        label: labelFor(index, worktree, false) };
      files.push(rec2); byPath.set(pth, rec2);
    } else if (t === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = rec.split(" ");
      const xy = parts[1];
      let rest = rec; for (let k = 0; k < 10; k++) rest = rest.slice(rest.indexOf(" ") + 1);
      const rec2 = { path: rest, orig: "", index: xy[0], worktree: xy[1], x: xy[0], y: xy[1], staged: false, unstaged: true, untracked: false, conflict: true, stagedDelete: false, keptOnDisk: false, label: "Conflict", conflictKind: xy };
      files.push(rec2); byPath.set(rest, rec2);
    } else if (t === "?" || t === "!") {
      const pth = rec.slice(2);
      const prev = byPath.get(pth);
      if (prev && prev.stagedDelete) { prev.keptOnDisk = true; prev.untracked = true; prev.label = "Unversioned"; continue; }   // rm --cached: one record
      const rec2 = { path: pth, orig: "", index: "", worktree: t, x: t, y: t, staged: false, unstaged: true, untracked: t === "?", ignored: t === "!", conflict: false, stagedDelete: false, keptOnDisk: false, label: t === "?" ? "Untracked" : "Ignored" };
      files.push(rec2); byPath.set(pth, rec2);
    }
  }
  const list = only ? files.filter((f) => only.has(f.path) || (f.orig && only.has(f.orig))) : files;
  list.sort((a, b) => a.path.localeCompare(b.path));
  return { repo: true, root: p.root, branch, oid, upstream, ahead, behind, detached, unborn, files: list, clean: list.length === 0, state: "ready" };
}
async function currentBranch(cwd) {
  const r = await run(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], 8000);   // works on an unborn branch too
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  const d = await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], 8000);
  return d.ok ? d.stdout.trim() : "";
}
async function headOid(cwd) { const r = await run(cwd, ["rev-parse", "--verify", "-q", "HEAD"], 8000); return r.ok ? r.stdout.trim() : ""; }

/* ============================== staging ============================== */
async function stage(cwd, files) {
  const list = normPaths(files);
  if (!list.length) return { ok: true, state: "success", count: 0 };
  return withLock(cwd, async () => {
    const r = await runPaths(cwd, ["add", "-A"], list);
    if (!r.ok) fail(r, "git add failed");
    return { ok: true, state: "success", count: list.length };
  });
}
async function unstage(cwd, files) {
  const list = normPaths(files);
  if (!list.length) return { ok: true, state: "success", count: 0 };
  return withLock(cwd, async () => {
    const head = await headOid(cwd);
    // Unborn: nothing to reset against → remove the entries from the index (files stay).
    const r = head ? await runPaths(cwd, ["reset", "-q", "HEAD"], list) : await runPaths(cwd, ["rm", "--cached", "-r", "-q"], list);
    if (!r.ok) fail(r, "git reset failed");
    return { ok: true, state: "success", count: list.length };
  });
}
async function stageAll(cwd) { return withLock(cwd, async () => { const r = await run(cwd, ["add", "-A"]); if (!r.ok) fail(r, "git add -A failed"); return { ok: true, state: "success" }; }); }
async function stageTracked(cwd) { return withLock(cwd, async () => { const r = await run(cwd, ["add", "-u"]); if (!r.ok) fail(r, "git add -u failed"); return { ok: true, state: "success" }; }); }
async function unstageAll(cwd) {
  return withLock(cwd, async () => {
    const head = await headOid(cwd);
    // Unborn repository: reset HEAD has nothing to reset to; emptying the index
    // unstages everything while every working file stays exactly as it is.
    const r = head ? await run(cwd, ["reset", "-q", "HEAD"]) : await run(cwd, ["read-tree", "--empty"]);
    if (!r.ok) fail(r, "git reset failed");
    return { ok: true, state: "success" };
  });
}

/* ============================== commit + CommitPlan ============================== */
// Plain commit of the index (or `-a`). Message-only amend keeps the existing tree.
async function commit(cwd, message, { all, amend } = {}) {
  if ((!message || !message.trim()) && !amend) throw new GitError("Commit message is empty.", { type: "invalid" });
  return withLock(cwd, async () => {
    const args = ["commit"];
    if (all) args.push("-a");
    if (amend) args.push("--amend");
    if (message && message.trim()) args.push("-m", message); else args.push("--no-edit");
    const r = await run(cwd, args);
    if (!r.ok) fail(r, "git commit failed");
    return { ok: true, state: "success", commit: await headOid(cwd), branch: await currentBranch(cwd), output: (r.stdout || "").trim() };
  });
}
/* Reviewed commit plan → one commit containing EXACTLY the selected path
 * operations, built in a temporary index:
 *   plan.paths   [{ path, orig?, untrack? }]  (strings allowed)
 *   plan.message string (required unless amend + message-only)
 *   plan.amend   true → rewrite HEAD: tree = HEAD's tree + the selected paths
 *   plan.expectHead  oid HEAD must still have (review binding)
 * Steps: temp index ← HEAD tree (or empty for a root commit); `add -A` the
 * selected paths (working-tree content, deletions, both halves of a rename);
 * `rm --cached` for explicit untrack intent; `git commit` with GIT_INDEX_FILE (hooks
 * + signing run normally); then reconcile ONLY the selected entries in the real
 * index to HEAD. Result phases: { committed, reconciled }. */
async function commitPlan(cwd, plan = {}) {
  const message = plan.message == null ? "" : String(plan.message);
  const amend = !!plan.amend;
  const items = (Array.isArray(plan.paths) ? plan.paths : []).map((p) => typeof p === "string" ? { path: p } : (p || {})).filter((p) => p && p.path);
  if (!message.trim() && !amend) throw new GitError("Commit message is empty.", { type: "invalid" });
  if (!items.length && !amend) throw new GitError("No files selected to commit.", { type: "invalid" });
  const paths = normPaths(items.map((i) => i.path));
  const origs = normPaths(items.filter((i) => i.orig).map((i) => i.orig));
  const untrack = normPaths(items.filter((i) => i.untrack).map((i) => i.path));
  const addList = [...new Set([...paths.filter((p) => !untrack.includes(p)), ...origs])];
  return withLock(cwd, async () => {
    const id = await repoIdentity(cwd);
    const head = await headOid(cwd);
    if (plan.expectHead && plan.expectHead !== head) throw new GitError(`HEAD moved since you reviewed (${String(plan.expectHead).slice(0, 7)} → ${String(head || "unborn").slice(0, 7)}). Refresh and review again.`, { type: "invalid" });
    if (amend && !head) throw new GitError("There is no commit to amend yet.", { type: "invalid" });
    const tmp = path.join(id.gitDir, `atomnano-index-${process.pid}-${Date.now()}`);
    const env = { GIT_INDEX_FILE: tmp };
    const result = { ok: false, state: "failed", committed: false, reconciled: false, commit: "", branch: "", paths: paths.length, untracked: untrack.length };
    try {
      // 1. temp index = HEAD's tree (amend: the tree being rewritten is HEAD's own)
      const rt = head ? await run(cwd, ["read-tree", head], { env }) : await run(cwd, ["read-tree", "--empty"], { env });
      if (!rt.ok) fail(rt, "could not prepare the commit index");
      // 2. exactly the selected paths from the working tree (adds, edits, deletions, rename pairs)
      if (addList.length) { const a = await runPaths(cwd, ["add", "-A"], addList, { env }); if (!a.ok) fail(a, "git add failed"); }
      // 3. explicit untrack intent: remove from the commit's tree, keep the file on disk
      if (untrack.length) { const rm = await runPaths(cwd, ["rm", "--cached", "-r", "-q", "--ignore-unmatch"], untrack, { env }); if (!rm.ok) fail(rm, "git rm --cached failed"); }
      // 4. the commit itself (hooks, signing, author/committer config all apply)
      const args = ["commit"];
      if (amend) args.push("--amend");
      if (message.trim()) args.push("-m", message); else args.push("--no-edit");
      const c = await run(cwd, args, { env });
      if (!c.ok) {
        const out = (c.stderr + c.stdout).toLowerCase();
        if (/nothing to commit|nothing added to commit|no changes added/.test(out)) throw new GitError("Nothing to commit for the selected files (they match HEAD).", { type: "invalid", details: c.stderr + c.stdout });
        fail(c, "git commit failed");
      }
      result.committed = true;
      result.commit = await headOid(cwd);
      result.branch = await currentBranch(cwd);
      result.output = (c.stdout || "").trim();
      // 5. reconcile ONLY the selected entries in the real index to the new HEAD;
      //    every other staged entry is left exactly as the user had it.
      //    (a path absent from BOTH the new HEAD and the real index — e.g. the old name
      //    of an already-staged rename — has nothing to reconcile; git reports it as
      //    "did not match", which is not a failure here.)
      const rec = [...new Set([...paths, ...origs])];
      let rr = rec.length ? await runPaths(cwd, ["reset", "-q", "HEAD"], rec) : { ok: true };
      if (!rr.ok) {
        const errs = [];
        for (const p of rec) { const one = await runPaths(cwd, ["reset", "-q", "HEAD"], [p]); if (!one.ok && !/did not match/i.test(one.stderr + one.stdout)) errs.push(`${p}: ${(one.stderr || one.stdout || one.error).trim()}`); }
        rr = errs.length ? { ok: false, text: errs.join("\n") } : { ok: true };
      }
      if (!rr.ok) { result.state = "partial"; result.ok = true; result.reconcileError = rr.text; return result; }
      result.reconciled = true; result.ok = true; result.state = "success";
      return result;
    } finally { try { fs.unlinkSync(tmp); } catch { /* */ } try { fs.unlinkSync(tmp + ".lock"); } catch { /* */ } }
  });
}
// Legacy entry point (renderer + tests): commit exactly these files.
async function commitFiles(cwd, message, files, opts = {}) { return commitPlan(cwd, { message, paths: normPaths(files), amend: !!(opts && opts.amend), expectHead: opts && opts.expectHead }); }

/* ============================== remotes: pull / fetch / push ============================== */
function conflictOr(r, what) {
  const output = (r.stdout + r.stderr).trim();
  if (r.ok) return { ok: true, state: "success", conflict: false, output };
  if (/^CONFLICT \(/m.test(output) || /could not apply/i.test(output) || /automatic merge failed/i.test(output) || /fix conflicts and (then )?run/i.test(output)) return { ok: false, state: "conflict", conflict: true, output };
  fail(r, what);
}
/* What changed between two commits, for the pull / push result toasts:
 * files touched, +/- lines (tree-to-tree diff, so a rebase counts what the working
 * tree actually gained) and the commits `from..to` (omitted when not meaningful).
 * Never throws — a summary that cannot be computed is simply absent. */
async function changeSummary(cwd, from, to, { commits = true } = {}) {
  if (!from || !to) return null;
  if (from === to) return { files: 0, insertions: 0, deletions: 0, commits: 0 };
  try {
    const [stat, count] = await Promise.all([
      run(cwd, ["diff", "--shortstat", "--end-of-options", from, to], 30000),
      commits ? run(cwd, ["rev-list", "--count", "--end-of-options", `${from}..${to}`], 15000) : Promise.resolve(null),
    ]);
    if (!stat.ok) return null;
    const line = String(stat.stdout || "").trim();
    const num = (re) => { const m = line.match(re); return m ? parseInt(m[1], 10) : 0; };
    const out = { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?\(\+\)/), deletions: num(/(\d+) deletions?\(-\)/) };
    if (count && count.ok) out.commits = parseInt(count.stdout.trim(), 10) || 0;
    return out;
  } catch { return null; }
}
async function pull(cwd, { rebase } = {}) {
  return withLock(cwd, async () => {
    const branch = await currentBranch(cwd);
    const before = await headOid(cwd);
    const r = await run(cwd, ["-c", "core.editor=true", "pull", rebase ? "--rebase" : "--no-rebase"], 300000);
    const res = conflictOr(r, "git pull failed");
    const after = res.ok ? await headOid(cwd) : "";
    return { ...res, branch, upToDate: /already up to date/i.test(res.output || ""), before, after, summary: res.ok ? await changeSummary(cwd, before, after, { commits: !rebase }) : null };
  });
}
// Pull a specific remote branch (or the upstream when `branch` is absent). A
// remote WITHOUT a branch is an incomplete request — rejected before git runs.
async function pullFrom(cwd, { remote, branch, rebase } = {}) {
  if (remote && !branch) throw new GitError("Pick the remote branch to pull (a remote alone is ambiguous).", { type: "invalid" });
  if (remote) await assertRefName(cwd, remote, "remote");
  if (branch) await assertRefName(cwd, branch, "branch");
  return withLock(cwd, async () => {
    const current = await currentBranch(cwd);
    const before = await headOid(cwd);
    const args = ["-c", "core.editor=true", "pull", rebase ? "--rebase" : "--no-rebase"];
    if (branch) args.push("--", remote || "origin", `refs/heads/${branch}`);
    const r = await run(cwd, args, 300000);
    const res = conflictOr(r, "git pull failed");
    const after = res.ok ? await headOid(cwd) : "";
    return { ...res, branch: current, from: branch ? `${remote || "origin"}/${branch}` : "", upToDate: /already up to date/i.test(res.output || ""), before, after, summary: res.ok ? await changeSummary(cwd, before, after, { commits: !rebase }) : null };
  });
}
async function fetch(cwd, { remote, prune = false } = {}) {
  if (remote) await assertRefName(cwd, remote, "remote");
  const args = ["fetch", "--progress", ...(prune ? ["--prune"] : []), ...(remote ? ["--", remote] : ["--all"])];
  const r = await run(cwd, args, 300000);
  if (!r.ok) fail(r, "git fetch failed");
  return { ok: true, state: "success", output: (r.stdout + r.stderr).trim() };
}
const cfg = async (cwd, key) => { const r = await run(cwd, ["config", "--get", key], 8000); return r.ok ? r.stdout.trim() : ""; };
/* Where would `branch` actually be published? Git's own rules: branch.<b>.pushRemote →
 * remote.pushDefault → branch.<b>.remote → "origin"; destination = branch.<b>.merge
 * when push.default is upstream/tracking, else the same name (simple/current).
 * Returns the RESOLVED plan the UI shows and the push executes: nothing is guessed
 * at execution time. hasUpstream=false means initial publication (needs an
 * explicit destination choice). */
async function pushPlan(cwd, { branch } = {}) {
  const b = branch || await currentBranch(cwd);
  if (!b || b === "HEAD") throw new GitError("Detached HEAD — check out a branch to push.", { type: "invalid" });
  await assertRefName(cwd, b, "branch");
  const pushRemote = await cfg(cwd, `branch.${b}.pushRemote`), pushDefault = await cfg(cwd, "remote.pushDefault"), upRemote = await cfg(cwd, `branch.${b}.remote`);
  const merge = await cfg(cwd, `branch.${b}.merge`);
  const mode = (await cfg(cwd, "push.default")) || "simple";
  const remote = pushRemote || pushDefault || upRemote || "";
  const upstreamRef = merge ? merge.replace(/^refs\/heads\//, "") : "";
  let dest = b;
  if ((mode === "upstream" || mode === "tracking") && upstreamRef) dest = upstreamRef;
  else if (mode === "simple" && upstreamRef && upstreamRef !== b && remote === upRemote) dest = null;   // git refuses: simple requires same name
  const url = remote ? await cfg(cwd, `remote.${remote}.pushurl`) || await cfg(cwd, `remote.${remote}.url`) : "";
  const remotesR = await run(cwd, ["remote"], 8000);
  const remotesList = remotesR.ok ? remotesR.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  const localOid = await resolveRev(cwd, `refs/heads/${b}`).catch(() => "");
  const remoteOid = remote && dest ? await resolveRev(cwd, `refs/remotes/${remote}/${dest}`).catch(() => "") : "";
  return { branch: b, remote, url, dest, upstream: upRemote && upstreamRef ? `${upRemote}/${upstreamRef}` : "", hasUpstream: !!(upRemote && upstreamRef), pushDefault: mode, remotes: remotesList, localOid, remoteOid, simpleMismatch: dest === null };
}
/* Push exactly the reviewed plan. `remote` + `dest` are REQUIRED for a branch push
 * (the UI passes the resolved PushPlan); `setUpstream` only when asked; force =
 * --force-with-lease pinned to `expectedRemoteOid` when known. `tag` pushes one
 * fully qualified tag; `tags` all tags; `deleteRemote` deletes a remote branch. */
async function pushBranch(cwd, { branch, remote, dest, setUpstream, force, expectedRemoteOid, tags, tag, deleteRemote, deleteTag } = {}) {
  const args = ["push", "--porcelain", "--progress"];
  if (!remote) {
    if (!branch || tags || tag || deleteTag || deleteRemote) throw new GitError("Choose the remote to push to.", { type: "invalid" });
    const plan = await pushPlan(cwd, { branch });
    if (!plan.remote) throw new GitError(`“${plan.branch}” has no remote configured — pick one to publish to.`, { type: "invalid" });
    remote = plan.remote; dest = dest || plan.dest || plan.branch;
  }
  await assertRefName(cwd, remote, "remote");
  if (force) args.push(expectedRemoteOid ? `--force-with-lease=refs/heads/${dest || branch}:${expectedRemoteOid}` : "--force-with-lease");
  if (deleteRemote) { await assertRefName(cwd, deleteRemote, "branch"); args.push("--delete", "--", remote, `refs/heads/${deleteRemote}`); }
  else if (deleteTag) { await assertRefName(cwd, deleteTag, "tag"); args.push("--delete", "--", remote, `refs/tags/${deleteTag}`); }
  else if (tag) { await assertRefName(cwd, tag, "tag"); args.push("--", remote, `refs/tags/${tag}:refs/tags/${tag}`); }
  else if (tags) { args.push("--tags", "--", remote); }
  else {
    if (!branch) throw new GitError("Branch is required.", { type: "invalid" });
    await assertRefName(cwd, branch, "branch");
    const d = dest || branch;
    await assertRefName(cwd, d, "branch");
    if (setUpstream) args.push("--set-upstream");
    args.push("--", remote, `refs/heads/${branch}:refs/heads/${d}`);
  }
  return withLock(cwd, async () => {
    const r = await run(cwd, args, 300000);
    const output = (r.stdout + r.stderr).trim();
    if (!r.ok) {
      const rejected = /\brejected\b|non-fast-forward|fetch first|stale info|failed to push some refs/i.test(output);
      if (rejected) return { ok: false, state: "rejected", rejected: true, output, remote, dest: dest || branch, error: output.split("\n").find((l) => /rejected|error/i.test(l)) || "push rejected" };
      fail(r, "git push failed");
    }
    // --porcelain: "<flag>\t<from>:<to>\t<old>..<new>" (fast-forward), "<old>...<new>" (forced), "[new branch]", "[up to date]"
    const range = output.match(/^[ +\-*!=]\t\S+:\S+\t([0-9a-f]+)\.\.\.?([0-9a-f]+)/m);
    const newRef = /\t\[new (branch|tag)\]/.test(output);
    const summary = range ? await changeSummary(cwd, range[1], range[2]) : null;
    return { ok: true, state: "success", output, remote, dest: dest || branch || tag || "", upToDate: /everything up-to-date|\[up to date\]/i.test(output), setUpstream: !!setUpstream, newRef, summary };
  });
}
// Legacy `push`: publish the current branch to its RESOLVED destination; never
// invents origin, never changes upstream unless the caller asks (`setUpstream`).
async function push(cwd, { setUpstream, remote: remoteOverride, dest: destOverride } = {}) {
  const plan = await pushPlan(cwd, {});
  const remote = remoteOverride || plan.remote;
  if (!remote) throw new GitError(`“${plan.branch}” has no upstream — choose a remote to publish to (Push & set upstream).`, { type: "invalid", details: `remotes: ${plan.remotes.join(", ") || "none"}` });
  const r = await pushBranch(cwd, { branch: plan.branch, remote, dest: destOverride || plan.dest || plan.branch, setUpstream: !!setUpstream || (!plan.hasUpstream && !!remoteOverride) });
  return { ...r, branch: plan.branch, plan };
}

/* ============================== diffs (explicit baselines) ============================== */
// Where does `file` live? { inHead, inIndex, exists }
async function fileState(cwd, file) {
  // (`ls-files` has no --pathspec-from-file; one literal path as an argument is exact and short)
  const [ls, head] = await Promise.all([
    run(cwd, ["--literal-pathspecs", "ls-files", "-z", "--", file], 15000),
    run(cwd, ["cat-file", "-e", `HEAD:${file}`], 15000),
  ]);
  let exists = false; try { exists = fs.existsSync(path.join(cwd, file)); } catch { /* */ }
  return { inIndex: ls.ok && !!ls.stdout.replace(/\0/g, ""), inHead: head.ok, exists };
}
async function noIndexDiff(cwd, file) {
  // exit code 1 = differences (expected for a new file); anything else is an error
  const u = await run(cwd, ["--literal-pathspecs", "diff", "--no-color", "--no-index", "--", DEVNULL, file], 30000);
  if (u.code !== 0 && u.code !== 1 && !u.ok) fail(u, "git diff --no-index failed");
  return u.stdout || "";
}
// One baseline, honoured exactly:  staged → HEAD ↔ index;  default → index ↔ working tree.
// A clean tracked file returns an EMPTY successful diff (never a fabricated all-added file).
async function diff(cwd, file, { staged } = {}) {
  const [f] = normPaths([file]);
  const st = await fileState(cwd, f);
  if (!st.inIndex && !st.inHead) {
    if (!st.exists) throw new GitError(`${f} does not exist.`, { type: "notFound" });
    return staged ? { text: "", mode: "staged", untracked: true } : { text: await noIndexDiff(cwd, f), mode: "untracked", untracked: true };
  }
  const args = ["--literal-pathspecs", "diff", "--no-color"];
  if (staged) args.push("--cached");
  args.push("--", f);
  const r = await run(cwd, args, 30000);
  if (!r.ok) fail(r, "git diff failed");
  return { text: r.stdout || "", mode: staged ? "staged" : "working" };
}
// HEAD ↔ working tree (what a commit of this file's working content would land).
async function fileDiff(cwd, file) {
  const [f] = normPaths([file]);
  const st = await fileState(cwd, f);
  if (st.inHead) {
    const r = await run(cwd, ["--literal-pathspecs", "diff", "--no-color", "HEAD", "--", f], 30000);
    if (!r.ok) fail(r, "git diff failed");
    return { text: r.stdout || "", mode: "head" };
  }
  if (st.inIndex && !st.exists) {   // staged new file deleted from disk → show what the index holds
    const s = await run(cwd, ["--literal-pathspecs", "diff", "--no-color", "--cached", "--", f], 30000);
    if (!s.ok) fail(s, "git diff --cached failed");
    return { text: s.stdout || "", mode: "staged" };
  }
  if (!st.exists) throw new GitError(`${f} does not exist.`, { type: "notFound" });
  return { text: await noIndexDiff(cwd, f), mode: st.inIndex ? "added" : "untracked" };
}

/* ============================== branches ============================== */
async function branches(cwd) {
  const current = await currentBranch(cwd);
  const lr = await run(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], 8000);
  if (!lr.ok) fail(lr, "git branch failed");
  const locals = lr.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const rr = await run(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"], 8000);
  if (!rr.ok) fail(rr, "git branch -r failed");
  const remotes = rr.stdout.split(/\r?\n/).map((s) => s.trim()).filter((b) => b && !/\/HEAD$/.test(b));
  const st = await repoState(cwd);
  return { current, locals, remotes, local: locals, remote: remotes, merging: st.merging, state: st };
}
async function checkout(cwd, branch, { create, from, expect } = {}) {
  return withLock(cwd, async () => {
    if (create) {
      const name = await assertRefName(cwd, branch, "branch");
      const start = from ? await resolveRev(cwd, from) : "";
      const r = await run(cwd, ["switch", "-c", name, ...(start ? [start] : [])], 60000);
      if (!r.ok) fail(r, "git switch -c failed");
      return { ok: true, state: "success", branch: await currentBranch(cwd), created: true, output: (r.stdout + r.stderr).trim() };
    }
    const k = await refKind(cwd, branch);
    if (k.kind === "unknown") throw new GitError(`“${branch}” is not a branch, tag or commit here.`, { type: "notFound" });
    await assertExpected(cwd, expect);
    // A local branch is switched to BY NAME (stays attached); anything else detaches at its
    // commit. `git switch` takes no pathspecs, so a same-named file can never be meant.
    const r = k.kind === "local" ? await run(cwd, ["switch", "--no-guess", branch], 60000) : await run(cwd, ["switch", "--detach", k.oid], 60000);
    if (!r.ok) fail(r, "git switch failed");
    return { ok: true, state: "success", branch: await currentBranch(cwd), detached: k.kind !== "local", output: (r.stdout + r.stderr).trim() };
  });
}
function parseTrack(s) {
  const ahead = /ahead (\d+)/.exec(s || ""), behind = /behind (\d+)/.exec(s || "");
  return { ahead: ahead ? +ahead[1] : 0, behind: behind ? +behind[1] : 0, gone: /gone/.test(s || "") };
}
async function branchesDetailed(cwd) {
  const current = await currentBranch(cwd);
  const head = await headOid(cwd);
  const fmt = "%(refname:short)%09%(refname)%09%(upstream:short)%09%(upstream:track)%09%(objectname:short)%09%(objectname)%09%(committerdate:relative)%09%(committerdate:iso-strict)%09%(contents:subject)%09%(HEAD)%09%(authorname)";
  const parse = (out, kind) => (out || "").split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const [name, full, upstream, track, hash, oid, rel, date, subject, headMark, author] = l.split("\t");
    return { name, full, kind, upstream: upstream || "", ...parseTrack(track), hash, oid, rel, date, subject: subject || "", author: author || "", current: headMark === "*" };
  });
  const [lr, rr, st] = await Promise.all([
    run(cwd, ["for-each-ref", "--sort=-committerdate", `--format=${fmt}`, "refs/heads"], 15000),
    run(cwd, ["for-each-ref", "--sort=-committerdate", `--format=${fmt}`, "refs/remotes"], 15000),
    repoState(cwd),
  ]);
  if (!lr.ok) fail(lr, "git for-each-ref failed");
  if (!rr.ok) fail(rr, "git for-each-ref failed");
  const locals = parse(lr.stdout, "local");
  const remotes = parse(rr.stdout, "remote").filter((b) => !/\/HEAD$/.test(b.name));
  return { current, headOid: head, unborn: !head, detached: !head ? false : current === "HEAD", locals, remotes, state: st, merging: st.merging };
}
async function branchCreate(cwd, name, { from, checkout: co } = {}) {
  const n = await assertRefName(cwd, name, "branch");
  const start = from ? await resolveRev(cwd, from) : "";
  return withLock(cwd, async () => {
    const args = co ? ["switch", "-c", n] : ["branch", "--", n];
    if (start) args.push(start);
    const r = await run(cwd, args, 60000);
    if (!r.ok) fail(r, "git branch failed");
    return { ok: true, state: "success", branch: n, from: start || "HEAD", current: await currentBranch(cwd) };
  });
}
async function branchDelete(cwd, name, { force, remote } = {}) {
  if (remote) {
    const m = /^([^/]+)\/(.+)$/.exec(name || "");
    if (!m) throw new GitError("Remote branch must look like origin/name.", { type: "invalid" });
    await assertRefName(cwd, m[1], "remote"); await assertRefName(cwd, m[2], "branch");
    const r = await pushBranch(cwd, { remote: m[1], deleteRemote: m[2] });
    return { ...r, deleted: name };
  }
  const n = await assertRefName(cwd, name, "branch");
  return withLock(cwd, async () => {
    const r = await run(cwd, ["branch", force ? "-D" : "-d", "--", n], 30000);
    if (!r.ok) {
      if (/not fully merged/i.test(r.stderr + r.stdout)) return { ok: false, state: "failed", unmerged: true, message: (r.stderr || r.stdout).trim().split("\n")[0] };
      fail(r, "git branch -d failed");
    }
    return { ok: true, state: "success", deleted: n };
  });
}
async function branchRename(cwd, oldName, newName) {
  const a = await assertRefName(cwd, oldName, "branch"), b = await assertRefName(cwd, newName, "branch");
  return withLock(cwd, async () => { const r = await run(cwd, ["branch", "-m", "--", a, b], 30000); if (!r.ok) fail(r, "git branch -m failed"); return { ok: true, state: "success", branch: b }; });
}
async function setUpstream(cwd, branch, upstream) {
  const b = await assertRefName(cwd, branch, "branch");
  const m = /^([^/]+)\/(.+)$/.exec(String(upstream || ""));
  if (!m) throw new GitError("Upstream must look like remote/branch.", { type: "invalid" });
  await assertRefName(cwd, m[1], "remote"); await assertRefName(cwd, m[2], "branch");
  const k = await refKind(cwd, upstream);
  if (k.kind !== "remote") throw new GitError(`“${upstream}” is not a known remote-tracking branch (fetch first).`, { type: "notFound" });
  return withLock(cwd, async () => { const r = await run(cwd, ["branch", `--set-upstream-to=${upstream}`, "--", b], 30000); if (!r.ok) fail(r, "git branch --set-upstream-to failed"); return { ok: true, state: "success" }; });
}
/* Check out a remote-tracking branch as a LOCAL tracking branch. If a local branch
 * of the same name already exists but is NOT this remote branch (different
 * upstream or a different tip), the caller must choose: { mode: "existing" } to
 * switch to it anyway, or { mode: "new", name } to create a distinct tracking
 * branch. Without a choice the mismatch is reported (nothing is checked out). */
async function checkoutRemote(cwd, remoteBranch, { mode, name } = {}) {
  const m = /^([^/]+)\/(.+)$/.exec(remoteBranch || "");
  if (!m) throw new GitError("Remote branch must look like origin/name.", { type: "invalid" });
  await assertRefName(cwd, m[1], "remote"); await assertRefName(cwd, m[2], "branch");
  const rk = await refKind(cwd, remoteBranch);
  if (rk.kind !== "remote") throw new GitError(`“${remoteBranch}” is not a known remote-tracking branch (fetch first).`, { type: "notFound" });
  const local = mode === "new" ? await assertRefName(cwd, name || m[2], "branch") : m[2];
  return withLock(cwd, async () => {
    const lk = await refKind(cwd, local);
    if (lk.kind === "local" && mode !== "existing" && mode !== "new") {
      const up = await cfg(cwd, `branch.${local}.remote`), mg = (await cfg(cwd, `branch.${local}.merge`)).replace(/^refs\/heads\//, "");
      const tracksThis = up === m[1] && mg === m[2];
      const sameTip = lk.oid === rk.oid;
      if (!tracksThis || !sameTip) return { ok: false, state: "choice", needsChoice: true, existing: { name: local, oid: lk.oid, upstream: up && mg ? `${up}/${mg}` : "", tracksThis, sameTip }, remote: { name: remoteBranch, oid: rk.oid } };
    }
    let r;
    if (lk.kind === "local" && mode !== "new") r = await run(cwd, ["switch", "--no-guess", local], 60000);
    else if (lk.kind === "local" && mode === "new") throw new GitError(`A local branch named “${local}” already exists — pick another name.`, { type: "invalid" });
    else r = await run(cwd, ["switch", "-c", local, "--track", remoteBranch], 60000);
    if (!r.ok) fail(r, "git switch failed");
    return { ok: true, state: "success", branch: await currentBranch(cwd), created: lk.kind !== "local" };
  });
}

/* ============================== merge / rebase / cherry-pick / revert / reset ============================== */
// Merge a ref into the CURRENT branch (must be on a local branch).
async function merge(cwd, branch, { expect } = {}) {
  const k = await refKind(cwd, branch);
  if (k.kind === "unknown") throw new GitError(`“${branch}” is not a branch, tag or commit here.`, { type: "notFound" });
  return withLock(cwd, async () => {
    const into = await currentBranch(cwd);
    if (!into || into === "HEAD") throw new GitError("Check out a local branch before merging (HEAD is detached).", { type: "invalid" });
    await assertExpected(cwd, expect);
    const r = await run(cwd, ["merge", "--no-edit", k.full || k.oid], 120000);
    const res = conflictOr(r, "git merge failed");
    return { ...res, into, from: branch, upToDate: /already up to date/i.test(res.output), fastForward: /fast-forward/i.test(res.output) };
  });
}
/* Merge `source` INTO `target`. The TARGET must be a LOCAL branch (a remote-tracking
 * ref or tag would be checked out detached and the "merge" would update nothing);
 * the source may be any ref. `expect` binds the reviewed object ids. */
async function mergeBranches(cwd, source, target, message, { expect } = {}) {
  if (!source || !target) throw new GitError("Both branches are required.", { type: "invalid" });
  if (source === target) throw new GitError("Source and target are the same branch.", { type: "invalid" });
  const tk = await refKind(cwd, target);
  if (tk.kind !== "local") throw new GitError(tk.kind === "remote" ? `“${target}” is a remote-tracking branch. Check it out as a local branch first, then merge into that.` : tk.kind === "tag" ? `“${target}” is a tag — merge targets must be local branches.` : `“${target}” is not a local branch.`, { type: "invalid" });
  const sk = await refKind(cwd, source);
  if (sk.kind === "unknown") throw new GitError(`“${source}” is not a branch, tag or commit here.`, { type: "notFound" });
  return withLock(cwd, async () => {
    await assertExpected(cwd, expect);
    const start = await currentBranch(cwd);
    if (start !== target) { const co = await run(cwd, ["switch", "--no-guess", target], 60000); if (!co.ok) fail(co, `Couldn't check out ${target}`); }
    const args = ["merge"];
    if (message && message.trim()) args.push("-m", message.trim()); else args.push("--no-edit");
    args.push(sk.full || sk.oid);
    const r = await run(cwd, args, 120000);
    const res = conflictOr(r, "git merge failed");
    return { ...res, into: target, from: source, upToDate: /already up to date/i.test(res.output), fastForward: /fast-forward/i.test(res.output), branch: await currentBranch(cwd) };
  });
}
async function rebase(cwd, onto, { branch, expect } = {}) {
  if (!onto) throw new GitError("Rebase target is required.", { type: "invalid" });
  const ok = await refKind(cwd, onto);
  if (ok.kind === "unknown") throw new GitError(`“${onto}” is not a branch, tag or commit here.`, { type: "notFound" });
  if (branch) { const bk = await refKind(cwd, branch); if (bk.kind !== "local") throw new GitError(`“${branch}” is not a local branch — only local branches can be rebased.`, { type: "invalid" }); }
  return withLock(cwd, async () => {
    await assertExpected(cwd, expect);
    const start = await currentBranch(cwd);
    if (!branch && (!start || start === "HEAD")) throw new GitError("Check out a local branch to rebase (HEAD is detached).", { type: "invalid" });
    if (branch && branch !== start) { const co = await run(cwd, ["switch", "--no-guess", branch], 60000); if (!co.ok) fail(co, `Couldn't check out ${branch}`); }
    const r = await run(cwd, ["-c", "core.editor=true", "rebase", ok.full || ok.oid], 300000);
    const res = conflictOr(r, "git rebase failed");
    return { ...res, onto, branch: branch || start, upToDate: /up to date/i.test(res.output) };
  });
}
async function isMergeCommit(cwd, oid) { const r = await run(cwd, ["rev-list", "--parents", "-n", "1", oid], 8000); return r.ok && r.stdout.trim().split(/\s+/).length > 2; }
// Every item is resolved and preflighted first: a merge commit needs an explicit
// mainline (`mainline`, default 1) and is never guessed halfway through a sequence.
async function cherryPick(cwd, hashes, { noCommit, mainline } = {}) {
  const list = (Array.isArray(hashes) ? hashes : [hashes]).filter(Boolean);
  if (!list.length) throw new GitError("Pick at least one commit.", { type: "invalid" });
  const oids = []; let anyMerge = false;
  for (const h of list) { const oid = await resolveRev(cwd, h); oids.push(oid); if (await isMergeCommit(cwd, oid)) anyMerge = true; }
  const ml = anyMerge ? Math.max(1, +mainline || 1) : 0;
  return withLock(cwd, async () => {
    const r = await run(cwd, ["-c", "core.editor=true", "cherry-pick", ...(ml ? ["-m", String(ml)] : []), ...(noCommit ? ["-n"] : []), ...oids], 120000);
    return { ...conflictOr(r, "git cherry-pick failed"), branch: await currentBranch(cwd), mainline: ml || undefined };
  });
}
async function revert(cwd, hash, { noCommit, mainline } = {}) {
  const oid = await resolveRev(cwd, hash);
  const ml = (await isMergeCommit(cwd, oid)) ? Math.max(1, +mainline || 1) : 0;
  return withLock(cwd, async () => {
    const r = await run(cwd, ["-c", "core.editor=true", "revert", "--no-edit", ...(ml ? ["-m", String(ml)] : []), ...(noCommit ? ["-n"] : []), oid], 120000);
    return { ...conflictOr(r, "git revert failed"), branch: await currentBranch(cwd), mainline: ml || undefined };
  });
}
// The chosen MODE is the only mode applied; the reference is resolved to an object
// id first, so a value like "--hard" can never sneak in as an option.
async function reset(cwd, ref, mode = "mixed", { expect } = {}) {
  if (!["soft", "mixed", "hard"].includes(mode)) throw new GitError("Reset mode must be soft, mixed or hard.", { type: "invalid" });
  const oid = await resolveRev(cwd, ref);
  return withLock(cwd, async () => {
    await assertExpected(cwd, expect);
    const r = await run(cwd, ["reset", `--${mode}`, oid], 60000);   // (`--` would turn the id into a PATH)
    if (!r.ok) fail(r, "git reset failed");
    return { ok: true, state: "success", mode, to: oid, output: (r.stdout || "").trim() };
  });
}

/* ============================== in-progress operations ============================== */
async function gitDir(cwd) { try { return (await repoIdentity(cwd)).gitDir; } catch { return ""; } }
/* Which multi-step operation is the repo in? Marker files in .git decide, and each
 * state lists the actions that are actually valid for it. */
async function repoState(cwd) {
  const g = await gitDir(cwd);
  const has = (p) => { try { return !!g && fs.existsSync(path.join(g, p)); } catch { return false; } };
  const merging = has("MERGE_HEAD"), rebasing = has("rebase-merge") || has("rebase-apply");
  const cherryPicking = has("CHERRY_PICK_HEAD"), reverting = has("REVERT_HEAD"), bisecting = has("BISECT_LOG");
  const sequencer = has("sequencer/todo");
  let op = merging ? "merge" : rebasing ? "rebase" : cherryPicking ? "cherry-pick" : reverting ? "revert" : bisecting ? "bisect" : "";
  if (!op && sequencer) {   // a multi-commit cherry-pick/revert stopped between commits (e.g. empty commit)
    try { const todo = fs.readFileSync(path.join(g, "sequencer/todo"), "utf8"); op = /^revert/m.test(todo) ? "revert" : "cherry-pick"; } catch { op = "cherry-pick"; }
  }
  let detail = "";
  if (rebasing) {
    try {
      const dir = has("rebase-merge") ? "rebase-merge" : "rebase-apply";
      const onto = fs.readFileSync(path.join(g, dir, "onto"), "utf8").trim().slice(0, 7);
      const head = fs.readFileSync(path.join(g, dir, "head-name"), "utf8").trim().replace(/^refs\/heads\//, "");
      detail = `${head} onto ${onto}`;
    } catch { /* partial state */ }
  } else if (merging) {
    try { detail = fs.readFileSync(path.join(g, "MERGE_MSG"), "utf8").split("\n")[0].trim(); } catch { /* ignore */ }
  }
  const actions = op === "merge" ? ["continue", "abort"] : op === "rebase" ? ["continue", "skip", "abort"] : (op === "cherry-pick" || op === "revert") ? ["continue", "skip", "abort"] : op === "bisect" ? ["bisect-reset"] : [];
  // Conflict sides for THIS operation: during a rebase / cherry-pick / revert git's
  // "ours" is the branch being rebased onto (upstream) and "theirs" is the user's
  // own commit — the opposite of a merge. One descriptor for every resolver.
  const swapped = rebasing || cherryPicking || reverting || (!!op && op !== "merge" && op !== "bisect");
  const sides = swapped ? { mine: "theirs", incoming: "ours" } : { mine: "ours", incoming: "theirs" };
  return { op, merging, rebasing, cherryPicking, reverting, bisecting, sequencer, detail, actions, sides, swapped };
}
async function mergeAbort(cwd) {
  return withLock(cwd, async () => {
    const st = await repoState(cwd);
    if (!st.op) throw new GitError("No merge, rebase, cherry-pick, revert or bisect is in progress.", { type: "invalid" });
    const args = st.rebasing ? ["rebase", "--abort"] : st.cherryPicking || (st.op === "cherry-pick") ? ["cherry-pick", "--abort"] : st.reverting || st.op === "revert" ? ["revert", "--abort"] : st.bisecting ? ["bisect", "reset"] : ["merge", "--abort"];
    const r = await run(cwd, args, 30000);
    if (!r.ok) fail(r, `git ${args.join(" ")} failed`);
    return { ok: true, state: "success", op: st.op };
  });
}
// Continue the in-progress operation once every conflict is resolved + staged.
// A rebase / sequence may stop AGAIN at the next conflicting commit → state
// "conflict" (expected). Without an operation there is nothing to continue.
async function mergeContinue(cwd) {
  return withLock(cwd, async () => {
    const st = await repoState(cwd);
    if (!st.op) throw new GitError("No merge, rebase, cherry-pick or revert is in progress.", { type: "invalid" });
    if (st.bisecting && !st.merging && !st.rebasing) throw new GitError("A bisect is in progress — mark commits good/bad or reset the bisect.", { type: "invalid" });
    const unresolved = await run(cwd, ["diff", "--name-only", "-z", "--diff-filter=U"], 8000);
    if (unresolved.ok && unresolved.stdout.replace(/\0/g, "")) throw new GitError("Still unresolved: " + unresolved.stdout.split("\0").filter(Boolean).join(", "), { type: "invalid" });
    let r;
    if (st.rebasing) r = await run(cwd, ["-c", "core.editor=true", "rebase", "--continue"], 120000);
    else if (st.cherryPicking || st.op === "cherry-pick") r = await run(cwd, ["-c", "core.editor=true", "cherry-pick", "--continue"], 60000);
    else if (st.reverting || st.op === "revert") r = await run(cwd, ["-c", "core.editor=true", "revert", "--continue"], 60000);
    else r = await run(cwd, ["commit", "--no-edit"], 30000);
    const res = conflictOr(r, `git ${st.op} --continue failed`);
    const after = await repoState(cwd);
    return { ...res, op: st.op, branch: await currentBranch(cwd), stillInProgress: !!after.op, next: after };
  });
}
async function rebaseSkip(cwd) {
  return withLock(cwd, async () => {
    const st = await repoState(cwd);
    const cmd = st.rebasing ? "rebase" : st.cherryPicking || st.op === "cherry-pick" ? "cherry-pick" : st.reverting || st.op === "revert" ? "revert" : "";
    if (!cmd) throw new GitError("Nothing to skip — no rebase, cherry-pick or revert is in progress.", { type: "invalid" });
    const r = await run(cwd, ["-c", "core.editor=true", cmd, "--skip"], 60000);
    return { ...conflictOr(r, `git ${cmd} --skip failed`), op: cmd, branch: await currentBranch(cwd) };
  });
}
async function bisectReset(cwd) { return withLock(cwd, async () => { const r = await run(cwd, ["bisect", "reset"], 30000); if (!r.ok) fail(r, "git bisect reset failed"); return { ok: true, state: "success" }; }); }

/* ============================== discard (planned, per-path outcomes) ============================== */
/* Restore/remove local changes for exactly these paths. Phases per path:
 *   tracked      → checkout HEAD -- path            (renames: BOTH names)
 *   staged-new   → reset HEAD -- path, then delete   (delete only after a successful reset)
 *   untracked    → delete
 * The plan is validated from status first; a failed prerequisite stops that path's
 * later phases; every path reports its outcome; ok=false if anything failed. Lock
 * files are never removed to force the operation through. */
async function discard(cwd, files) {
  const list = normPaths(files);
  if (!list.length) return { ok: true, state: "success", results: [] };
  return withLock(cwd, async () => {
    const st = await status(cwd, { paths: list });
    if (!st.repo) throw new GitError("Not a git repository.", { type: "notRepo" });
    const results = [];
    const rowsByPath = new Map(st.files.map((f) => [f.path, f]));
    const restoreHead = [], resetNew = [], deleteAfterReset = [], deleteNow = [];
    for (const p of list) {
      const f = rowsByPath.get(p);
      if (!f) { results.push({ path: p, phase: "plan", ok: true, note: "no local changes" }); continue; }
      if (f.untracked && !f.stagedDelete) deleteNow.push(p);
      else if (f.index === "A") { resetNew.push(p); deleteAfterReset.push(p); }
      else if (f.index === "R" || f.orig) { restoreHead.push(f.orig || p); if (f.orig) deleteAfterReset.push(p); resetNew.push(p); }
      else restoreHead.push(p);
    }
    const okSet = new Set();
    if (restoreHead.length) {
      // HEAD may lack a renamed-away original in a partially staged state → checkout per batch, fall back per path
      const r = await runPaths(cwd, ["checkout", "HEAD"], restoreHead);
      if (r.ok) for (const p of restoreHead) { okSet.add(p); results.push({ path: p, phase: "restore", ok: true }); }
      else for (const p of restoreHead) { const one = await runPaths(cwd, ["checkout", "HEAD"], [p]); if (one.ok) { okSet.add(p); results.push({ path: p, phase: "restore", ok: true }); } else results.push({ path: p, phase: "restore", ok: false, error: (one.stderr || one.stdout || one.error).trim(), type: classifyError(one.stderr, one) }); }
    }
    if (resetNew.length) {
      const head = await headOid(cwd);
      const r = head ? await runPaths(cwd, ["reset", "-q", "HEAD"], resetNew) : await runPaths(cwd, ["rm", "--cached", "-r", "-q"], resetNew);
      if (r.ok) for (const p of resetNew) okSet.add("reset:" + p);
      else for (const p of resetNew) results.push({ path: p, phase: "unstage", ok: false, error: (r.stderr || r.stdout || r.error).trim(), type: classifyError(r.stderr, r) });
    }
    const rm = (p, phase) => {
      const abs = path.join(cwd, p);
      try { const s = fs.lstatSync(abs); if (s.isDirectory() && !s.isSymbolicLink()) fs.rmSync(abs, { recursive: true, force: false }); else fs.unlinkSync(abs); results.push({ path: p, phase, ok: true }); }
      catch (e) { if (e.code === "ENOENT") results.push({ path: p, phase, ok: true, note: "already absent" }); else results.push({ path: p, phase, ok: false, error: e.message, type: "permission" }); }
    };
    for (const p of deleteAfterReset) { if (okSet.has("reset:" + p)) rm(p, "delete"); else results.push({ path: p, phase: "delete", ok: false, error: "skipped — unstage failed, the file was left in place" }); }
    for (const p of deleteNow) rm(p, "delete");
    const failed = results.filter((x) => !x.ok);
    return { ok: failed.length === 0, state: failed.length === 0 ? "success" : (failed.length === results.length ? "failed" : "partial"), results, failed: failed.length };
  });
}
// Stop tracking files but keep them on disk ("unversion"): git rm --cached.
async function untrack(cwd, files) {
  const list = normPaths(files);
  if (!list.length) throw new GitError("No files given.", { type: "invalid" });
  return withLock(cwd, async () => { const r = await runPaths(cwd, ["rm", "--cached", "-r", "-q"], list); if (!r.ok) fail(r, "git rm --cached failed"); return { ok: true, state: "success", files: list.length }; });
}

/* ============================== conflicts ============================== */
// Unmerged index stages for a path: { base, ours, theirs } each { oid, mode } or null.
async function conflictStages(cwd, file) {
  const [f] = normPaths([file]);
  const r = await run(cwd, ["--literal-pathspecs", "ls-files", "-u", "-z", "--", f], 15000);
  if (!r.ok) fail(r, "git ls-files -u failed");
  const out = { base: null, ours: null, theirs: null, path: f };
  for (const rec of r.stdout.split("\0")) {
    const m = /^(\d+) ([0-9a-f]+) ([123])\t(.*)$/.exec(rec);
    if (!m) continue;
    const entry = { mode: m[1], oid: m[2] };
    if (m[3] === "1") out.base = entry; else if (m[3] === "2") out.ours = entry; else out.theirs = entry;
  }
  let binary = false;
  for (const e of [out.ours, out.theirs]) if (e && e.oid) { const t = await runBuf(cwd, ["cat-file", "-p", e.oid], 15000); if (t.ok && looksBinary(t.stdout)) binary = true; }
  return { ...out, binary, modifyDelete: !!((out.ours && !out.theirs) || (!out.ours && out.theirs)), addAdd: !out.base && !!out.ours && !!out.theirs };
}
/* Resolve conflicted files wholesale by taking one side (`side` is git's own
 * "ours" | "theirs" — callers map keep-mine / accept-incoming with repoState().sides).
 * A side whose index stage is MISSING (modify/delete) means "deleted": the file is
 * removed from the index and the working tree instead of a failing checkout. */
async function resolveWith(cwd, files, side) {
  const list = normPaths(files);
  if (!list.length) return { ok: true, state: "success", count: 0 };
  if (side !== "ours" && side !== "theirs") throw new GitError("side must be ours or theirs", { type: "invalid" });
  return withLock(cwd, async () => {
    const results = [];
    const take = [], remove = [];
    for (const p of list) {
      const st = await conflictStages(cwd, p);
      const stage = side === "ours" ? st.ours : st.theirs;
      if (!st.ours && !st.theirs && !st.base) { results.push({ path: p, ok: false, error: "not a conflicted path" }); continue; }
      if (stage) take.push(p); else remove.push(p);
    }
    if (take.length) { const r = await runPaths(cwd, ["checkout", `--${side}`], take); if (!r.ok) fail(r, `git checkout --${side} failed`); const a = await runPaths(cwd, ["add", "-A"], take); if (!a.ok) fail(a, "git add failed"); for (const p of take) results.push({ path: p, ok: true, action: "kept" }); }
    if (remove.length) { const r = await runPaths(cwd, ["rm", "-q", "--ignore-unmatch"], remove); if (!r.ok) fail(r, "git rm failed"); for (const p of remove) results.push({ path: p, ok: true, action: "deleted" }); }
    const failed = results.filter((x) => !x.ok).length;
    return { ok: failed === 0, state: failed ? "partial" : "success", count: list.length, side, results };
  });
}

/* ============================== compare / history ============================== */
function parseNameStatusZ(out) {
  const recs = (out || "").split("\0");
  const files = [];
  for (let i = 0; i < recs.length; i++) {
    const st = recs[i];
    if (!st) continue;
    const code = st[0];
    if (code === "R" || code === "C") { const orig = recs[++i] || "", p = recs[++i] || ""; files.push({ path: p, orig, code, score: +st.slice(1) || 0, label: LABELS[code] || "Changed" }); }
    else { const p = recs[++i] || ""; files.push({ path: p, orig: "", code, label: LABELS[code] || "Changed" }); }
  }
  return files;
}
function attachNumstatZ(files, out) {
  // -z numstat: "adds\tdels\t" then for renames "\0old\0new\0", else "path\0"
  const recs = (out || "").split("\0");
  const stats = new Map();
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]; if (!rec) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(rec);
    if (!m) continue;
    let p = m[3];
    if (p === "") { i++; p = recs[++i] || ""; }   // rename: old\0new
    stats.set(p, { adds: m[1] === "-" ? null : +m[1], dels: m[2] === "-" ? null : +m[2], binary: m[1] === "-" });
  }
  for (const f of files) { const s = stats.get(f.path); if (s) Object.assign(f, s); }
  return files;
}
async function resolveRefs(cwd, names) {
  const out = {};
  for (const n of (names || [])) out[n] = await resolveRev(cwd, n).catch(() => "");
  return out;
}
// Files that merging `to` into `from` would bring (three-dot: merge-base…to). Both refs are resolved first.
async function changedBetween(cwd, from, to) {
  if (!from || !to) throw new GitError("Both branches are required.", { type: "invalid" });
  const a = await resolveRev(cwd, from), b = await resolveRev(cwd, to);
  const [ns, num] = await Promise.all([
    run(cwd, ["diff", "-z", "--name-status", "-M", `${a}...${b}`], 30000),
    run(cwd, ["diff", "-z", "--numstat", "-M", `${a}...${b}`], 30000),
  ]);
  if (!ns.ok) fail(ns, "git diff failed");
  if (!num.ok) fail(num, "git diff --numstat failed");
  return { from, to, fromOid: a, toOid: b, files: attachNumstatZ(parseNameStatusZ(ns.stdout), num.stdout), complete: true };
}
async function refDiff(cwd, from, to, file) {
  const a = await resolveRev(cwd, from), b = await resolveRev(cwd, to);
  const [f] = normPaths([file]);
  const r = await run(cwd, ["--literal-pathspecs", "diff", "--no-color", "-M", `${a}...${b}`, "--", f], 30000);
  if (!r.ok) fail(r, "git diff failed");
  return { text: r.stdout || "", fromOid: a, toOid: b };
}
async function remoteUrl(cwd, name = "origin") { return { url: await cfg(cwd, `remote.${name}.url`), pushUrl: await cfg(cwd, `remote.${name}.pushurl`) }; }
// Commits on `to` not on `from`, PAGED (skip/limit) with stable resolved ids.
async function commitsBetween(cwd, from, to, { skip = 0, limit = 200 } = {}) {
  if (!from || !to) throw new GitError("Both branches are required.", { type: "invalid" });
  const a = await resolveRev(cwd, from), b = await resolveRev(cwd, to);
  const n = Math.max(1, Math.min(+limit || 200, 1000));
  const fmt = "%h%x1f%s%x1f%an%x1f%ar%x1f%H%x1e";
  const r = await run(cwd, ["log", `-${n + 1}`, `--skip=${Math.max(0, +skip || 0)}`, `--pretty=format:${fmt}`, `${a}..${b}`], 30000);
  if (!r.ok) fail(r, "git log failed");
  const commits = [];
  for (const rec of (r.stdout || "").split("\x1e")) {
    const line = rec.replace(/^\r?\n/, ""); if (!line.trim()) continue;
    const parts = line.split("\x1f"); if (parts.length < 5) continue;
    commits.push({ hash: parts[0], subject: parts[1], author: parts[2], date: parts[3], full: parts[4] });
  }
  const hasMore = commits.length > n;
  if (hasMore) commits.length = n;
  return { from, to, fromOid: a, toOid: b, commits, hasMore, truncated: hasMore, skip: +skip || 0, complete: !hasMore };
}
async function aheadBehind(cwd, a, b) {
  const oa = await resolveRev(cwd, a), ob = await resolveRev(cwd, b);
  const r = await run(cwd, ["rev-list", "--left-right", "--count", `${oa}...${ob}`], 15000);
  if (!r.ok) fail(r, "git rev-list failed");
  const [onlyA, onlyB] = r.stdout.trim().split(/\s+/).map((n) => +n || 0);
  return { a, b, aOid: oa, bOid: ob, onlyA, onlyB };
}
// Commits on a ref (or all refs), newest first; NUL-safe records; explicit `follow`
// for single-file history (Git's rename following, with its non-linear limits).
async function log(cwd, { ref = "HEAD", limit = 100, skip = 0, search = "", author = "", file = "", all = false, follow = false } = {}) {
  const n = Math.max(1, Math.min(+limit || 100, 1000));
  const fmt = "%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%ar%x1f%D%x1f%s%x1e";
  const args = ["log", `-${n + 1}`, `--skip=${Math.max(0, +skip || 0)}`, `--pretty=format:${fmt}`];
  if (all) args.push("--all"); else if (ref) { if (optionLike(ref)) throw new GitError("Invalid ref.", { type: "invalid" }); args.push("--end-of-options", ref); }
  if (search) args.push("-i", `--grep=${search}`);
  if (author) args.push(`--author=${author}`);
  if (file) { if (follow) args.push("--follow"); args.push("--", ...normPaths([file])); }
  const r = await run(cwd, args, 30000);
  if (!r.ok) fail(r, "git log failed");
  const commits = [];
  const seen = new Set();
  for (const rec of (r.stdout || "").split("\x1e")) {
    const line = rec.replace(/^\r?\n/, ""); if (!line.trim()) continue;
    const p = line.split("\x1f"); if (p.length < 9) continue;
    if (seen.has(p[0])) continue; seen.add(p[0]);
    commits.push({ full: p[0], hash: p[1], parents: p[2].split(" ").filter(Boolean), author: p[3], email: p[4], date: p[5], rel: p[6], refs: p[7].split(",").map((s) => s.trim()).filter(Boolean), subject: p[8] });
  }
  const hasMore = commits.length > n; if (hasMore) commits.length = n;
  return { commits, hasMore, skip: +skip || 0 };
}
/* One commit: metadata + the files it changed versus an EXPLICIT parent (default
 * the first parent; a root commit is compared with the empty tree). `parent` may
 * be an index (1-based) or an oid. Every read is checked — a failed secondary read
 * is an error, never an empty list. */
async function commitInfo(cwd, hash, { parent } = {}) {
  const oid = await resolveRev(cwd, hash);
  const fmt = "%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%ar%x1f%cn%x1f%cI%x1f%D%x1f%s%x1f%b";
  const r = await run(cwd, ["show", "-s", `--pretty=format:${fmt}`, "--end-of-options", oid], 15000);
  if (!r.ok) fail(r, "git show failed");
  const p = r.stdout.split("\x1f");
  const parents = (p[2] || "").split(" ").filter(Boolean);
  let base = EMPTY_TREE, parentIndex = 0;
  if (parents.length) {
    if (parent == null || parent === "") { base = parents[0]; parentIndex = 1; }
    else if (/^\d+$/.test(String(parent))) { const i = +parent; if (i < 1 || i > parents.length) throw new GitError(`Parent ${i} does not exist (commit has ${parents.length}).`, { type: "invalid" }); base = parents[i - 1]; parentIndex = i; }
    else { base = await resolveRev(cwd, parent); parentIndex = parents.indexOf(base) + 1; }
  }
  const [ns, num] = await Promise.all([
    run(cwd, ["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--name-status", base, oid], 30000),
    run(cwd, ["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--numstat", base, oid], 30000),
  ]);
  if (!ns.ok) fail(ns, "git diff-tree failed");
  if (!num.ok) fail(num, "git diff-tree --numstat failed");
  const files = attachNumstatZ(parseNameStatusZ(ns.stdout), num.stdout);
  return { full: p[0], hash: p[1], parents, parent: base, parentIndex, isMerge: parents.length > 1, isRoot: parents.length === 0, author: p[3], email: p[4], date: p[5], rel: p[6], committer: p[7], commitDate: p[8], refs: (p[9] || "").split(",").map((s) => s.trim()).filter(Boolean), subject: p[10], body: (p[11] || "").trim(), files, adds: files.reduce((n, f) => n + (f.adds || 0), 0), dels: files.reduce((n, f) => n + (f.dels || 0), 0) };
}
async function commitFileDiff(cwd, hash, file, { parent } = {}) {
  const info = await commitInfo(cwd, hash, { parent });
  const [f] = normPaths([file]);
  const r = await run(cwd, ["--literal-pathspecs", "diff", "--no-color", "-M", info.parent, info.full, "--", f], 30000);
  if (!r.ok) fail(r, "git diff failed");
  return { text: r.stdout || "", parent: info.parent, commit: info.full };
}
function looksBinary(buf) {
  const len = Math.min(buf.length, 8192);
  let sus = 0;
  for (let i = 0; i < len; i++) { const c = buf[i]; if (c === 0) return true; if (c < 7 || (c > 14 && c < 32)) sus++; }
  return sus / Math.max(len, 1) > 0.12;
}
/* A file's contents at a ref — TYPED: { binary, size, encoding, content, truncated,
 * offset, nextOffset } — never decoded bytes pretending to be text, never a notice
 * appended to the content. Text is served in chunks (`offset`/`limit` bytes, split
 * on a UTF-8 boundary); binary is served as base64 with a size so the UI can offer
 * an exact download instead of a mangled preview. */
async function fileAt(cwd, ref, file, { offset = 0, limit = 1_500_000, base64 = false } = {}) {
  const oid = await resolveRev(cwd, ref);
  const [f] = normPaths([file]);
  const sz = await run(cwd, ["cat-file", "-s", `${oid}:${f}`], 15000);
  if (!sz.ok) fail(sz, `${f} is not in ${String(ref).slice(0, 12)}`, "notFound");
  const size = +sz.stdout.trim() || 0;
  const b = await runBuf(cwd, ["cat-file", "-p", `${oid}:${f}`], 120000);
  if (!b.ok) fail(b, "git cat-file failed");
  const buf = b.stdout;
  const binary = looksBinary(buf);
  if (binary) return { binary: true, size, encoding: "binary", content: "", truncated: false, base64: base64 ? buf.toString("base64") : undefined, offset: 0, nextOffset: null };
  const start = Math.max(0, Math.min(+offset || 0, buf.length));
  let end = Math.min(buf.length, start + Math.max(1024, +limit || 1_500_000));
  while (end < buf.length && end > start && (buf[end] & 0xC0) === 0x80) end--;   // don't split a UTF-8 sequence
  return { binary: false, size, encoding: "utf8", content: buf.subarray(start, end).toString("utf8"), truncated: end < buf.length || start > 0, offset: start, nextOffset: end < buf.length ? end : null, lines: undefined };
}

/* ============================== stashes (identity = object id) ============================== */
async function stashList(cwd) {
  const fmt = "%gd%x1f%gs%x1f%ar%x1f%aI%x1f%H";
  const r = await run(cwd, ["stash", "list", `--pretty=format:${fmt}`], 15000);
  if (!r.ok) fail(r, "git stash list failed");
  const stashes = [];
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, msg, rel, date, hash] = line.split("\x1f");
    const idx = +((/\{(\d+)\}/.exec(ref) || [])[1] || stashes.length);
    const bm = /^(?:WIP on|On) ([^:]+): ?(.*)$/.exec(msg || "");
    stashes.push({ index: idx, ref, hash, rel, date, branch: bm ? bm[1] : "", message: bm ? (bm[2] || "(no message)") : (msg || ""), wip: /^WIP on/.test(msg || "") });
  }
  return { stashes };
}
// The CURRENT stash@{n} for an object id — positions renumber whenever stashes change.
async function stashRefFor(cwd, sel) {
  const hash = typeof sel === "object" && sel ? sel.hash : (typeof sel === "string" && /^[0-9a-f]{7,40}$/i.test(sel) ? sel : "");
  const index = typeof sel === "object" && sel ? sel.index : (typeof sel === "number" ? sel : null);
  const { stashes } = await stashList(cwd);
  if (hash) {
    const hit = stashes.find((s) => s.hash === hash || s.hash.startsWith(hash));
    if (!hit) throw new GitError("That stash no longer exists (the stash list changed). Refresh and pick again.", { type: "notFound" });
    return hit;
  }
  if (index == null) throw new GitError("Stash is required.", { type: "invalid" });
  const hit = stashes.find((s) => s.index === +index);
  if (!hit) throw new GitError(`stash@{${index}} does not exist.`, { type: "notFound" });
  return hit;
}
async function stashSave(cwd, { message, includeUntracked, keepIndex, paths } = {}) {
  return withLock(cwd, async () => {
    const args = ["stash", "push"];
    if (includeUntracked) args.push("-u");
    if (keepIndex) args.push("--keep-index");
    if (message && message.trim()) args.push("-m", message.trim());
    const list = paths && paths.length ? normPaths(paths) : null;
    const r = list ? await runPaths(cwd, args, list, { timeout: 60000 }) : await run(cwd, args, 60000);
    if (!r.ok) fail(r, "git stash failed");
    const output = (r.stdout + r.stderr).trim();
    return { ok: true, state: "success", output, nothing: /No local changes to save/i.test(output) };
  });
}
/* Apply / pop by OBJECT ID. `git stash apply` accepts the stash commit itself, so
 * the applied content can never be redirected by renumbering. `drop` (and hence
 * pop's second half) only accepts stash@{n}: it is re-resolved from the hash
 * immediately before running, and the entry is verified to still hold that hash. */
async function dropByHash(cwd, hash) {
  const st = await stashRefFor(cwd, { hash });
  const now = await run(cwd, ["rev-parse", "--verify", "-q", st.ref], 8000);
  if (!now.ok || now.stdout.trim() !== st.hash) throw new GitError("The stash list changed while dropping — nothing was dropped. Refresh and try again.", { type: "invalid" });
  const r = await run(cwd, ["stash", "drop", "-q", st.ref], 30000);
  if (!r.ok) fail(r, "git stash drop failed");
  return st;
}
async function stashApply(cwd, sel, { pop, restoreIndex } = {}) {
  return withLock(cwd, async () => {
    const st = await stashRefFor(cwd, sel);
    const r = await run(cwd, ["stash", "apply", ...(restoreIndex ? ["--index"] : []), st.hash], 60000);
    const res = conflictOr(r, "git stash apply failed");
    let dropped = false;
    if (pop && res.ok) { await dropByHash(cwd, st.hash); dropped = true; }   // like git: a conflicting pop keeps the stash
    return { ...res, hash: st.hash, ref: st.ref, kept: !dropped, dropped };
  });
}
async function stashDrop(cwd, sel) {
  return withLock(cwd, async () => {
    const st = await stashRefFor(cwd, sel);
    await dropByHash(cwd, st.hash);
    return { ok: true, state: "success", hash: st.hash };
  });
}
async function stashShow(cwd, sel) {
  const st = await stashRefFor(cwd, sel);
  const [ns, num] = await Promise.all([
    run(cwd, ["diff", "-z", "--name-status", "-M", `${st.hash}^`, st.hash], 30000),
    run(cwd, ["diff", "-z", "--numstat", "-M", `${st.hash}^`, st.hash], 30000),
  ]);
  if (!ns.ok) fail(ns, "git stash show failed");
  if (!num.ok) fail(num, "git stash show --numstat failed");
  const files = attachNumstatZ(parseNameStatusZ(ns.stdout), num.stdout);
  const u = await run(cwd, ["show", "-z", "--pretty=format:", "--name-only", `${st.hash}^3`], 15000);
  if (u.ok) for (const p of u.stdout.split("\0").map((s) => s.trim()).filter(Boolean)) if (!files.find((f) => f.path === p)) files.push({ path: p, code: "A", label: "Untracked", untracked: true });
  return { files, hash: st.hash, ref: st.ref };
}
async function stashFileDiff(cwd, sel, file) {
  const st = await stashRefFor(cwd, sel);
  const [f] = normPaths([file]);
  const r = await run(cwd, ["--literal-pathspecs", "diff", "--no-color", "-M", `${st.hash}^`, st.hash, "--", f], 30000);
  if (!r.ok) fail(r, "git diff failed");
  if (r.stdout) return { text: r.stdout };
  const u = await run(cwd, ["--literal-pathspecs", "show", "--no-color", "--pretty=format:", `${st.hash}^3`, "--", f], 30000);   // untracked part
  return { text: u.ok ? (u.stdout || "") : "" };
}

/* ============================== tags ============================== */
async function tags(cwd) {
  const fmt = "%(refname:short)%09%(objectname:short)%09%(*objectname:short)%09%(creatordate:relative)%09%(creatordate:iso-strict)%09%(contents:subject)%09%(objecttype)%09%(objectname)%09%(*objectname)";
  const r = await run(cwd, ["for-each-ref", "--sort=-creatordate", `--format=${fmt}`, "refs/tags"], 15000);
  if (!r.ok) fail(r, "git tag list failed");
  const list = (r.stdout || "").split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const [name, obj, target, rel, date, subject, type, oid, targetOid] = l.split("\t");
    return { name, hash: type === "tag" ? target : obj, oid: type === "tag" ? (targetOid || oid) : oid, tagOid: oid, annotated: type === "tag", rel, date, subject: subject || "" };
  });
  return { tags: list };
}
async function tagCreate(cwd, name, { ref, message } = {}) {
  const n = await assertRefName(cwd, name, "tag");
  const oid = ref ? await resolveRev(cwd, ref) : await resolveRev(cwd, "HEAD");
  return withLock(cwd, async () => {
    const args = message && message.trim() ? ["tag", "-a", "-m", message.trim(), "--", n, oid] : ["tag", "--", n, oid];
    const r = await run(cwd, args, 30000);
    if (!r.ok) fail(r, "git tag failed");
    return { ok: true, state: "success", tag: n, at: oid };
  });
}
/* Delete a tag. With `remote`, the REMOTE deletion runs first (fully qualified
 * refs/tags/…, so a same-named branch is never touched); the local tag is deleted
 * only after the remote confirmed. Phases are reported independently. */
async function tagDelete(cwd, name, { remote, expectOid } = {}) {
  const n = await assertRefName(cwd, name, "tag");
  return withLock(cwd, async () => {
    const k = await run(cwd, ["rev-parse", "--verify", "-q", "--end-of-options", `refs/tags/${n}`], 8000);
    if (!k.ok) throw new GitError(`Tag “${n}” does not exist.`, { type: "notFound" });
    if (expectOid && k.stdout.trim() !== expectOid) throw new GitError(`Tag “${n}” changed since you reviewed it.`, { type: "invalid" });
    const phases = { remote: null, local: null };
    if (remote) {
      try { const p = await pushBranch(cwd, { remote, deleteTag: n }); phases.remote = { ok: !!p.ok, output: p.output }; if (!p.ok) return { ok: false, state: "failed", phases, error: p.error || "remote deletion rejected" }; }
      catch (e) { phases.remote = { ok: false, error: e.message, type: e.type }; return { ok: false, state: "failed", phases, error: e.message }; }
    }
    const r = await run(cwd, ["tag", "-d", "--", n], 30000);
    phases.local = { ok: r.ok, output: (r.stdout + r.stderr).trim() };
    if (!r.ok) return { ok: false, state: remote ? "partial" : "failed", phases, error: (r.stderr || r.stdout).trim().split("\n")[0] };
    return { ok: true, state: "success", phases, tag: n };
  });
}
async function pushTag(cwd, name, { remote = "origin" } = {}) { return pushBranch(cwd, { remote, tag: name }); }

/* ============================== remotes (config-aware) ============================== */
async function remotes(cwd) {
  const r = await run(cwd, ["remote"], 15000);
  if (!r.ok) fail(r, "git remote failed");
  const out = [];
  for (const name of r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const fetchUrls = await run(cwd, ["config", "--get-all", `remote.${name}.url`], 8000);
    const pushUrls = await run(cwd, ["config", "--get-all", `remote.${name}.pushurl`], 8000);
    const fetchList = fetchUrls.ok ? fetchUrls.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    const pushList = pushUrls.ok ? pushUrls.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    out.push({ name, fetch: fetchList[0] || "", push: (pushList[0] || fetchList[0] || ""), fetchUrls: fetchList, pushUrls: pushList.length ? pushList : fetchList });
  }
  return { remotes: out };
}
async function remoteAdd(cwd, name, url) {
  const n = await assertRefName(cwd, name, "remote");
  const u = String(url || "").trim();
  if (!u || optionLike(u)) throw new GitError("Remote URL is required.", { type: "invalid" });
  return withLock(cwd, async () => { const r = await run(cwd, ["remote", "add", "--", n, u], 30000); if (!r.ok) fail(r, "git remote add failed"); return { ok: true, state: "success" }; });
}
async function remoteRemove(cwd, name) {
  const n = await assertRefName(cwd, name, "remote");
  return withLock(cwd, async () => { const r = await run(cwd, ["remote", "remove", "--", n], 30000); if (!r.ok) fail(r, "git remote remove failed"); return { ok: true, state: "success" }; });
}
async function remoteSetUrl(cwd, name, url, { push } = {}) {
  const n = await assertRefName(cwd, name, "remote");
  const u = String(url || "").trim();
  if (!u || optionLike(u)) throw new GitError("Remote URL is required.", { type: "invalid" });
  return withLock(cwd, async () => { const r = await run(cwd, ["remote", "set-url", ...(push ? ["--push"] : []), "--", n, u], 30000); if (!r.ok) fail(r, "git remote set-url failed"); return { ok: true, state: "success" }; });
}

/* ============================== snapshots ============================== */
// The whole tree at a ref as a .zip (native git archive) — written to a temp file and
// published atomically, so an interrupted export never replaces an existing archive.
async function archiveZip(cwd, ref, outPath) {
  if (!ref || !outPath) throw new GitError("ref and output path are required.", { type: "invalid" });
  const oid = await resolveRev(cwd, ref);
  const tmp = outPath + ".part-" + process.pid;
  const r = await run(cwd, ["archive", "--format=zip", "-o", tmp, oid], 300000);
  if (!r.ok) { try { fs.unlinkSync(tmp); } catch { /* */ } fail(r, "git archive failed"); }
  fs.renameSync(tmp, outPath);
  return { ok: true, state: "success", path: outPath, size: fs.statSync(outPath).size, commit: oid };
}
/* Only the files a commit changed versus its (explicit) parent, at that commit, as
 * a .zip: source files under files/, metadata (COMMIT.txt + manifest.json) at the
 * root so no project file name can collide. Every non-deleted path is read and
 * verified; a read failure aborts the export (or, with allowIncomplete, is listed
 * in the manifest). Exact bytes; UTF-8 names; temp file + atomic publish. */
async function commitZip(cwd, hash, outPath, { parent, allowIncomplete = false } = {}) {
  if (!hash || !outPath) throw new GitError("commit and output path are required.", { type: "invalid" });
  const info = await commitInfo(cwd, hash, { parent });
  const entries = [], skipped = [], failed = [];
  for (const f of info.files) {
    if (f.code === "D") { skipped.push({ path: f.path, reason: "deleted in this commit" }); continue; }
    const b = await runBuf(cwd, ["cat-file", "-p", `${info.full}:${f.path}`], 120000);
    if (!b.ok) { failed.push({ path: f.path, error: (b.stderr || b.error).trim() }); if (!allowIncomplete) break; continue; }
    entries.push({ name: "files/" + f.path, data: b.stdout });
  }
  if (failed.length && !allowIncomplete) throw new GitError(`Could not read ${failed.length} file${failed.length === 1 ? "" : "s"} at ${info.hash}: ${failed.map((x) => x.path).join(", ")}`, { type: "git", details: failed.map((x) => `${x.path}: ${x.error}`).join("\n") });
  if (!entries.length && !failed.length) throw new GitError("This commit has no file contents to export (deletions only).", { type: "invalid" });
  const manifest = { commit: info.full, parent: info.parent, author: `${info.author} <${info.email}>`, date: info.date, subject: info.subject, files: info.files.map((f) => ({ path: f.path, orig: f.orig || undefined, code: f.code })), skipped, failed, complete: failed.length === 0 };
  entries.push({ name: "COMMIT.txt", data: `${info.full}\nparent ${info.parent}\n${info.author} <${info.email}>\n${info.date}\n\n${info.subject}\n\n${info.body || ""}\n\nFiles:\n${info.files.map((f) => `${f.code}\t${f.path}${f.orig ? `\t(from ${f.orig})` : ""}`).join("\n")}\n` });
  entries.push({ name: "manifest.json", data: JSON.stringify(manifest, null, 2) });
  const tmp = outPath + ".part-" + process.pid;
  fs.writeFileSync(tmp, require("./zipper").zip(entries));
  fs.renameSync(tmp, outPath);
  return { ok: true, state: failed.length ? "partial" : "success", path: outPath, files: entries.length - 2, skipped, failed, size: fs.statSync(outPath).size, commit: info.full, parent: info.parent };
}

module.exports = {
  GitError, run, runInOperation, cancel, setProgressSink, withLock, repoIdentity,
  assertRefName, resolveRev, refKind, resolveRefs, normPaths,
  probe, isRepo, isRepoDir, repoRoot, repos, repoForFile, status, currentBranch, headOid,
  stage, unstage, stageAll, stageTracked, unstageAll, commit, commitFiles, commitPlan,
  pull, pullFrom, fetch, pushPlan, pushBranch, push, pushTag, changeSummary,
  diff, fileDiff, branches, branchesDetailed, checkout, checkoutRemote, branchCreate, branchDelete, branchRename, setUpstream,
  merge, mergeBranches, rebase, cherryPick, revert, reset,
  repoState, mergeAbort, mergeContinue, rebaseSkip, bisectReset,
  discard, untrack, conflictStages, resolveWith,
  changedBetween, refDiff, remoteUrl, commitsBetween, aheadBehind, log, commitInfo, commitFileDiff, fileAt,
  stashList, stashSave, stashApply, stashDrop, stashShow, stashFileDiff,
  tags, tagCreate, tagDelete, remotes, remoteAdd, remoteRemove, remoteSetUrl,
  archiveZip, commitZip,
};
