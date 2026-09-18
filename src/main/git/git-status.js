"use strict";
/* Repository discovery and working-tree status. probe() tells a non-repo apart from an inaccessible
 * path or a missing git executable (those are ERRORS, never "not a repo"); status() parses porcelain
 * v2 -z so paths are real bytes, a rename is one record with its original name, and a staged
 * deletion that is still on disk is ONE "unversioned" record; currentBranch / headOid also work on
 * an unborn branch. */
const fs = require("fs");
const path = require("path");
const { GitError, classifyError, fail, run, normPaths } = require("./git-runner");

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

module.exports = { probe, isRepo, repoRoot, repos, repoForFile, isRepoDir, LABELS, status, currentBranch, headOid };
