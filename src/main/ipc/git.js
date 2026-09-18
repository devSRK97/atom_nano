"use strict";
/* IPC: Git — git:* (status / stage / commit / branches / stashes / remotes / tags, the Git Center
 * routes, snapshots, whole-file conflict resolution) plus the progress sink and the repo-metadata
 * watch. Backed by src/main/git/git.js. */
const { dialog } = require("electron");
const git = require("../git/git");

function register(ctx) {
  const { handle, winFrom, broadcast, startGitWatch } = ctx;
  // ---- Git ----
  // Every mutating route runs as ONE operation: its git processes share an id, their
  // live output (fetch/push progress, hooks, credential prompts) is broadcast as
  // git:progress, and the renderer can cancel by id. Reads run plainly.
  git.setProgressSink((ev) => broadcast("git:progress", ev));
  const gitOp = (label, fn) => async (_e, cwd, ...args) => git.runInOperation({ label, cwd }, () => fn(cwd, ...args));
  handle("git:cancel", async (_e, opId) => git.cancel(opId));
  handle("git:watch", async (e, repos) => { startGitWatch(winFrom(e), repos); return true; });
  handle("git:repos", async (_e, root) => git.repos(root));
  handle("git:probe", async (_e, cwd) => git.probe(cwd));
  handle("git:is-repo-dir", async (_e, dir) => git.isRepoDir(dir));
  handle("git:repo-for-file", async (_e, filePath) => git.repoForFile(filePath));
  handle("git:status", async (_e, cwd, opts) => git.status(cwd, opts || {}));
  handle("git:branch", async (_e, cwd) => git.currentBranch(cwd));
  handle("git:stage", gitOp("Stage", (cwd, files2) => git.stage(cwd, files2)));
  handle("git:unstage", gitOp("Unstage", (cwd, files2) => git.unstage(cwd, files2)));
  handle("git:stage-all", gitOp("Stage all", (cwd) => git.stageAll(cwd)));
  handle("git:stage-tracked", gitOp("Stage tracked", (cwd) => git.stageTracked(cwd)));
  handle("git:unstage-all", gitOp("Unstage all", (cwd) => git.unstageAll(cwd)));
  handle("git:commit", gitOp("Commit", (cwd, message, opts) => git.commit(cwd, message, opts || {})));
  handle("git:commit-files", gitOp("Commit", (cwd, message, files2, opts) => git.commitFiles(cwd, message, files2, opts || {})));
  handle("git:commit-plan", gitOp("Commit", (cwd, plan) => git.commitPlan(cwd, plan || {})));
  handle("git:pull", gitOp("Pull", (cwd, opts) => git.pull(cwd, opts || {})));
  handle("git:push", gitOp("Push", (cwd, opts) => git.push(cwd, opts || {})));
  handle("git:push-plan", async (_e, cwd, opts) => git.pushPlan(cwd, opts || {}));
  handle("git:diff", async (_e, cwd, file, opts) => git.diff(cwd, file, opts || {}));
  handle("git:file-diff", async (_e, cwd, file) => git.fileDiff(cwd, file));
  handle("git:branches", async (_e, cwd) => git.branches(cwd));
  handle("git:checkout", gitOp("Checkout", (cwd, branch, opts) => git.checkout(cwd, branch, opts || {})));
  handle("git:merge", gitOp("Merge", (cwd, branch, opts) => git.merge(cwd, branch, opts || {})));
  handle("git:merge-branches", gitOp("Merge", (cwd, source, target, message, opts) => git.mergeBranches(cwd, source, target, message, opts || {})));

  handle("git:merge-abort", gitOp("Abort", (cwd) => git.mergeAbort(cwd)));
  handle("git:merge-continue", gitOp("Continue", (cwd) => git.mergeContinue(cwd)));
  handle("git:discard", gitOp("Discard", (cwd, files2) => git.discard(cwd, files2)));
  handle("git:changed-between", async (_e, cwd, from, to) => git.changedBetween(cwd, from, to));
  handle("git:commits-between", async (_e, cwd, from, to, opts) => git.commitsBetween(cwd, from, to, opts || {}));
  handle("git:ref-diff", async (_e, cwd, from, to, file) => git.refDiff(cwd, from, to, file));
  handle("git:remote-url", async (_e, cwd, name) => git.remoteUrl(cwd, name));
  // ---- Git Center ----
  handle("git:repo-state", async (_e, cwd) => git.repoState(cwd));
  handle("git:rebase-skip", gitOp("Skip", (cwd) => git.rebaseSkip(cwd)));
  handle("git:bisect-reset", gitOp("Bisect reset", (cwd) => git.bisectReset(cwd)));
  handle("git:fetch", gitOp("Fetch", (cwd, opts) => git.fetch(cwd, opts || {})));
  handle("git:push-branch", gitOp("Push", (cwd, opts) => git.pushBranch(cwd, opts || {})));
  handle("git:pull-opts", gitOp("Pull", (cwd, opts) => git.pull(cwd, opts || {})));
  handle("git:log", async (_e, cwd, opts) => git.log(cwd, opts || {}));
  handle("git:commit-info", async (_e, cwd, hash, opts) => git.commitInfo(cwd, hash, opts || {}));
  handle("git:commit-file-diff", async (_e, cwd, hash, file, opts) => git.commitFileDiff(cwd, hash, file, opts || {}));
  handle("git:file-at", async (_e, cwd, ref, file, opts) => git.fileAt(cwd, ref, file, opts || {}));
  handle("git:ahead-behind", async (_e, cwd, a, b) => git.aheadBehind(cwd, a, b));
  handle("git:resolve-refs", async (_e, cwd, names) => git.resolveRefs(cwd, names || []));
  handle("git:branches-detailed", async (_e, cwd) => git.branchesDetailed(cwd));
  handle("git:branch-create", gitOp("Create branch", (cwd, name, opts) => git.branchCreate(cwd, name, opts || {})));
  handle("git:branch-delete", gitOp("Delete branch", (cwd, name, opts) => git.branchDelete(cwd, name, opts || {})));
  handle("git:branch-rename", gitOp("Rename branch", (cwd, oldName, newName) => git.branchRename(cwd, oldName, newName)));
  handle("git:set-upstream", gitOp("Set upstream", (cwd, branch, upstream) => git.setUpstream(cwd, branch, upstream)));
  handle("git:checkout-remote", gitOp("Checkout", (cwd, remoteBranch, opts) => git.checkoutRemote(cwd, remoteBranch, opts || {})));
  handle("git:rebase", gitOp("Rebase", (cwd, onto, opts) => git.rebase(cwd, onto, opts || {})));
  handle("git:cherry-pick", gitOp("Cherry-pick", (cwd, hashes, opts) => git.cherryPick(cwd, hashes, opts || {})));
  handle("git:revert", gitOp("Revert", (cwd, hash, opts) => git.revert(cwd, hash, opts || {})));
  handle("git:reset", gitOp("Reset", (cwd, ref, mode, opts) => git.reset(cwd, ref, mode, opts || {})));
  handle("git:stash-list", async (_e, cwd) => git.stashList(cwd));
  handle("git:stash-save", gitOp("Stash", (cwd, opts) => git.stashSave(cwd, opts || {})));
  handle("git:stash-apply", gitOp("Apply stash", (cwd, sel, opts) => git.stashApply(cwd, sel, opts || {})));
  handle("git:stash-drop", gitOp("Drop stash", (cwd, sel) => git.stashDrop(cwd, sel)));
  handle("git:stash-show", async (_e, cwd, sel) => git.stashShow(cwd, sel));
  handle("git:stash-file-diff", async (_e, cwd, sel, file) => git.stashFileDiff(cwd, sel, file));
  handle("git:tags", async (_e, cwd) => git.tags(cwd));
  handle("git:tag-create", gitOp("Create tag", (cwd, name, opts) => git.tagCreate(cwd, name, opts || {})));
  handle("git:tag-delete", gitOp("Delete tag", (cwd, name, opts) => git.tagDelete(cwd, name, opts || {})));
  handle("git:push-tag", gitOp("Push tag", (cwd, name, opts) => git.pushTag(cwd, name, opts || {})));
  handle("git:remotes", async (_e, cwd) => git.remotes(cwd));
  handle("git:remote-add", gitOp("Add remote", (cwd, name, url) => git.remoteAdd(cwd, name, url)));
  handle("git:remote-remove", gitOp("Remove remote", (cwd, name) => git.remoteRemove(cwd, name)));
  handle("git:remote-set-url", gitOp("Set remote URL", (cwd, name, url, opts) => git.remoteSetUrl(cwd, name, url, opts || {})));
  // ---- Git Center v2: unversion, pull-from-branch, snapshots, whole-file conflict resolution ----
  handle("git:untrack", gitOp("Unversion", (cwd, files2) => git.untrack(cwd, files2)));
  handle("git:pull-from", gitOp("Pull", (cwd, opts) => git.pullFrom(cwd, opts || {})));
  handle("git:conflict-stages", async (_e, cwd, file) => git.conflictStages(cwd, file));
  handle("git:resolve-with", gitOp("Resolve", (cwd, files2, side) => git.resolveWith(cwd, files2, side)));
  handle("git:archive-zip", async (e, cwd, ref, suggested) => {
    const res = await dialog.showSaveDialog(winFrom(e), { title: "Save repository snapshot", defaultPath: suggested || "snapshot.zip", filters: [{ name: "ZIP archive", extensions: ["zip"] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    return git.runInOperation({ label: "Archive", cwd }, () => git.archiveZip(cwd, ref, res.filePath));
  });
  handle("git:commit-zip", async (e, cwd, hash, suggested, opts) => {
    const res = await dialog.showSaveDialog(winFrom(e), { title: "Save the files changed in this commit", defaultPath: suggested || "changed-files.zip", filters: [{ name: "ZIP archive", extensions: ["zip"] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    return git.runInOperation({ label: "Export commit", cwd }, () => git.commitZip(cwd, hash, res.filePath, opts || {}));
  });
}

module.exports = { register };
