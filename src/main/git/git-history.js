"use strict";
/* Reading history and content. Diffs honour an EXPLICIT baseline (staged = HEAD ↔ index, default =
 * index ↔ working tree, untracked = no-index; a clean tracked file is an empty diff, never a
 * fabricated all-added one), comparisons between refs (name-status + numstat, -z), paged commit
 * lists, commitInfo versus an explicit parent (a root commit against the empty tree), TYPED file
 * contents at a ref (binary vs UTF-8 chunks split on a character boundary) and the zip snapshots
 * (archiveZip, commitZip — temp file + atomic publish). */
const fs = require("fs");
const path = require("path");
const { GitError, fail, run, runBuf, resolveRev, normPaths, optionLike } = require("./git-runner");
const { LABELS } = require("./git-status");

const DEVNULL = process.platform === "win32" ? "NUL" : "/dev/null";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
  fs.writeFileSync(tmp, require("../workspace/zipper").zip(entries));
  fs.renameSync(tmp, outPath);
  return { ok: true, state: failed.length ? "partial" : "success", path: outPath, files: entries.length - 2, skipped, failed, size: fs.statSync(outPath).size, commit: info.full, parent: info.parent };
}

module.exports = { diff, fileDiff, parseNameStatusZ, attachNumstatZ, resolveRefs, changedBetween, refDiff, commitsBetween, aheadBehind, log, commitInfo, commitFileDiff, looksBinary, fileAt, archiveZip, commitZip };
