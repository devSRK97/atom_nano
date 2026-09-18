"use strict";
/* Index and commit mutations. Staging takes literal NUL-delimited paths (an unborn repository is
 * unstaged by emptying the index, files untouched); commit runs hooks and signing like the CLI; the
 * COMMITPLAN commits a reviewed set of path operations from a TEMPORARY index so exactly the
 * selected content lands while unrelated staged work stays as the user left it; discard / untrack
 * plan per path from status and report every outcome instead of forcing the operation through. */
const fs = require("fs");
const path = require("path");
const { GitError, classifyError, fail, run, withLock, repoIdentity, normPaths, runPaths } = require("./git-runner");
const { status, currentBranch, headOid } = require("./git-status");

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

module.exports = { stage, unstage, stageAll, stageTracked, unstageAll, commit, commitPlan, commitFiles, discard, untrack };
