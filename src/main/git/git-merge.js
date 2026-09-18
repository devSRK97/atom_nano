"use strict";
/* Multi-step history operations and their conflicts. merge / mergeBranches (the target must be a
 * LOCAL branch), rebase, cherry-pick / revert (a merge commit needs an explicit mainline, never
 * guessed halfway through a sequence), reset by resolved object id; repoState reads the .git marker
 * files to say which operation is in progress, which actions are valid and which side is "mine"
 * (swapped during rebase / cherry-pick / revert); continue / abort / skip dispatch on it;
 * conflictStages / resolveWith take one side per path, treating a missing stage as a deletion. */
const fs = require("fs");
const path = require("path");
const { GitError, fail, run, runBuf, withLock, repoIdentity, refKind, resolveRev, assertExpected, normPaths, runPaths, conflictOr } = require("./git-runner");
const { currentBranch } = require("./git-status");
const { looksBinary } = require("./git-history");

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

module.exports = { merge, mergeBranches, rebase, cherryPick, revert, reset, repoState, mergeAbort, mergeContinue, rebaseSkip, bisectReset, conflictStages, resolveWith };
