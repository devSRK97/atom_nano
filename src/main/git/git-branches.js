"use strict";
/* Branches and tags. Listing (plain and detailed with tracking info), checkout by ref kind (a local
 * branch is switched to BY NAME and stays attached, anything else detaches at its commit — never a
 * same-named file), create / delete / rename / set-upstream, checking out a remote-tracking branch
 * with an explicit choice when a local name clashes, and tags (remote deletion FIRST, fully
 * qualified refs so a same-named branch is never touched, phases reported independently). */
const { GitError, fail, run, withLock, assertRefName, resolveRev, refKind, assertExpected } = require("./git-runner");
const { currentBranch, headOid } = require("./git-status");
const { cfg, pushBranch } = require("./git-remotes");
const { repoState } = require("./git-merge");

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

module.exports = { branches, checkout, branchesDetailed, branchCreate, branchDelete, branchRename, setUpstream, checkoutRemote, tags, tagCreate, tagDelete, pushTag };
