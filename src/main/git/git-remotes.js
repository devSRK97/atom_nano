"use strict";
/* Remotes: pull / fetch / push and the remote configuration. pushPlan resolves Git's own rules
 * (branch.<b>.pushRemote → remote.pushDefault → branch.<b>.remote, then push.default) so nothing is
 * guessed at execution time and "origin" is never invented; pushBranch pushes exactly the reviewed
 * plan with fully qualified refspecs (force = --force-with-lease pinned to the reviewed remote id);
 * changeSummary describes what moved for the result toasts. Credentials are never handled here —
 * the user's helper / SSH agent applies, exactly like a terminal. */
const { GitError, fail, run, withLock, optionLike, assertRefName, resolveRev, conflictOr } = require("./git-runner");
const { currentBranch, headOid } = require("./git-status");

/* ============================== remotes: pull / fetch / push ============================== */
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
async function remoteUrl(cwd, name = "origin") { return { url: await cfg(cwd, `remote.${name}.url`), pushUrl: await cfg(cwd, `remote.${name}.pushurl`) }; }

module.exports = { changeSummary, pull, pullFrom, fetch, cfg, pushPlan, pushBranch, push, remotes, remoteAdd, remoteRemove, remoteSetUrl, remoteUrl };
