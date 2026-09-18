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
/* Layout: this file is the facade every caller requires — the export list below is the contract.
 * The implementation lives in the git-*.js siblings: git-runner (errors, process runner, cancel,
 * mutation queue, ref / path validation), git-status (discovery, porcelain status, HEAD), git-commit
 * (staging, commit, CommitPlan, discard), git-remotes (pull / fetch / push plans, remote config),
 * git-branches (branches, checkout, tags), git-merge (merge / rebase / cherry-pick / revert / reset,
 * in-progress state, conflicts), git-history (diffs, log, commit info, file contents, zip snapshots)
 * and git-stash (stashes by object id). */
const { GitError, run, runInOperation, cancel, setProgressSink, withLock, repoIdentity, assertRefName, resolveRev, refKind, normPaths } = require("./git-runner");
const { probe, isRepo, isRepoDir, repoRoot, repos, repoForFile, status, currentBranch, headOid } = require("./git-status");
const { stage, unstage, stageAll, stageTracked, unstageAll, commit, commitFiles, commitPlan, discard, untrack } = require("./git-commit");
const { pull, pullFrom, fetch, pushPlan, pushBranch, push, changeSummary, remoteUrl, remotes, remoteAdd, remoteRemove, remoteSetUrl } = require("./git-remotes");
const { branches, branchesDetailed, checkout, checkoutRemote, branchCreate, branchDelete, branchRename, setUpstream, tags, tagCreate, tagDelete, pushTag } = require("./git-branches");
const { merge, mergeBranches, rebase, cherryPick, revert, reset, repoState, mergeAbort, mergeContinue, rebaseSkip, bisectReset, conflictStages, resolveWith } = require("./git-merge");
const { diff, fileDiff, changedBetween, refDiff, commitsBetween, aheadBehind, log, commitInfo, commitFileDiff, fileAt, archiveZip, commitZip, resolveRefs } = require("./git-history");
const { stashList, stashSave, stashApply, stashDrop, stashShow, stashFileDiff } = require("./git-stash");

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
