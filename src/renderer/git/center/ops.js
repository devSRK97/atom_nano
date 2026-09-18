/* AtomNano renderer — Git Center — branch-level operations: merge, rebase, checkout, create / delete / rename, upstream, push (resolved plan) and pull, stash, reset, snapshots.
 * One of the modules the former single gitcenter.js was split into (see git/center/index.js). */
import { act, chooseRemote, confirmDanger, failToast, prompt, showConflicts } from "./actions.js";
import { refreshRepo } from "./repos.js";
import { D, fmtSize, h, lsGet, lsSet, per, q, repoName, S, shortRef, stat } from "./state.js";
import { confirmPop, pickList } from "./widgets.js";

// --- branch-level operations (each captures `repo` when it starts) ---
export const kindOf = (repo, name) => { const info = S.infos[repo]; if (!info || !name) return "unknown"; if (info.locals.some((b) => b.name === name)) return "local"; if (info.remotes.some((b) => b.name === name)) return "remote"; if (per(repo).tg.list.some((t) => t.name === name)) return "tag"; return "unknown"; };
export async function doMerge(source, target, anchor, repo = S.repo) {
  if (!source || !target || source === target) { D.toast("Pick two different branches", "alert"); return; }
  const tk = kindOf(repo, target);
  if (tk !== "local") {
    D.toast(`<b>“${D.esc(target)}” can't be a merge target</b><span class="toast-sub">${tk === "remote" ? "It is a remote-tracking branch — check it out as a local branch (Branches tab), then merge into that." : tk === "tag" ? "Tags can't receive merges — pick a local branch." : "Merge targets must be local branches."}</span>`, "alert", { ms: 6500 });
    return;
  }
  const info = S.infos[repo], cur = info ? info.current : "";
  const note = target === cur ? "" : ` “${shortRef(target)}” is checked out first.`;
  const P = per(repo);
  const expect = P.cmp.ready && P.cmp.ids ? P.cmp.ids : await D.atom.git.resolveRefs(repo, [source, target]).catch(() => null);
  const c = await confirmPop(anchor || q(".gitc-act.mergebtn"), { title: `Merge ${shortRef(source)} → ${shortRef(target)}`, ic: "merge", message: `Merges “${shortRef(source)}” into “${shortRef(target)}” in ${repoName(repo)}.${note}`, confirmLabel: "Merge", details: expect ? [{ k: "source", v: `${source} @ ${String(expect[source] || "?").slice(0, 10)}` }, { k: "target", v: `${target} @ ${String(expect[target] || "?").slice(0, 10)}` }] : null, fields: [{ id: "msg", label: "Merge commit message", value: `Merge branch '${shortRef(source)}' into ${shortRef(target)}`, placeholder: "Merge commit message" }] });
  if (!c.ok) return;
  const r = await act(`Merge ${shortRef(source)} → ${shortRef(target)}`, () => D.atom.git.mergeBranches(repo, source, target, (c.values.msg || "").trim(), { expect: expect || undefined }), { repo, silent: true });
  if (r && r.ok) D.toast(`Merged ${D.esc(shortRef(source))} → ${D.esc(shortRef(target))} in ${D.esc(repoName(repo))} (${r.upToDate ? "already up to date" : r.fastForward ? "fast-forward" : "merge commit"})`, "checkCircle", { ms: 4200 });
}
export async function doRebase(branch, onto, anchor, repo = S.repo) {
  if (!branch || !onto || branch === onto) { D.toast("Pick two different branches", "alert"); return; }
  if (kindOf(repo, branch) !== "local") { D.toast(`<b>“${D.esc(branch)}” can't be rebased</b><span class="toast-sub">Only a LOCAL branch (the source) can be rebased; remote-tracking branches and tags are valid targets, not sources.</span>`, "alert", { ms: 6000 }); return; }
  const P = per(repo);
  const expect = P.cmp.ready && P.cmp.ids ? P.cmp.ids : await D.atom.git.resolveRefs(repo, [branch, onto]).catch(() => null);
  const c = await confirmPop(anchor || q(".gitc-act.rebasebtn"), { title: `Rebase ${shortRef(branch)} onto ${shortRef(onto)}`, danger: true, message: `Rewrites the commits of “${branch}” on top of “${onto}” in ${repoName(repo)}. If “${branch}” was already pushed you'll need a force push afterwards. “${branch}” is checked out.`, confirmLabel: "Rebase", details: expect ? [{ k: "branch", v: `${branch} @ ${String(expect[branch] || "?").slice(0, 10)}` }, { k: "onto", v: `${onto} @ ${String(expect[onto] || "?").slice(0, 10)}` }] : null });
  if (!c.ok) return;
  const r = await act(`Rebase ${shortRef(branch)} onto ${shortRef(onto)}`, () => D.atom.git.rebase(repo, onto, { branch, expect: expect || undefined }), { repo, silent: true });
  if (r && r.ok) D.toast(r.upToDate ? `${D.esc(branch)} is already up to date with ${D.esc(onto)}` : `Rebased ${D.esc(branch)} onto ${D.esc(onto)} in ${D.esc(repoName(repo))}`, "checkCircle", { ms: 4000 });
}
/* Check out a branch. A remote ref is checked out as a tracking local branch; when a
 * same-named local branch exists but is NOT that remote branch, the user chooses
 * explicitly (switch to the existing one, or create a distinct tracking branch). */
export async function doCheckout(name, { remote } = {}, repo = S.repo) {
  if (!remote) { await act(`Checkout ${shortRef(name)}`, () => D.atom.git.checkout(repo, name), { repo }); return; }
  const r = await act(`Checkout ${name}`, () => D.atom.git.checkoutRemote(repo, name), { repo, silent: true });
  if (r && r.state === "choice") {
    const ex = r.existing || {};
    const why = !ex.tracksThis ? `tracks ${ex.upstream || "no upstream"}` : "points at a different commit";
    const alt = `${ex.name}-${String(name).split("/")[0]}`;
    const c = await D.chooseDialog({ title: `“${ex.name}” already exists locally`, ic: "branch", message: `A local branch named “${ex.name}” exists but is not “${name}” (it ${why}; ${String(ex.oid || "").slice(0, 7)} vs ${String((r.remote || {}).oid || "").slice(0, 7)}). What should happen?`, choices: [{ label: `Create “${alt}” tracking ${name}`, value: "new", primary: true }, { label: `Switch to existing “${ex.name}”`, value: "existing" }, { label: "Cancel", value: null }] });
    if (!c) return;
    const r2 = await act(`Checkout ${name}`, () => D.atom.git.checkoutRemote(repo, name, c === "new" ? { mode: "new", name: alt } : { mode: "existing" }), { repo, silent: true });
    if (r2 && r2.ok) D.toast(`Now on ${D.esc(r2.branch || "")}`, "checkCircle", { ms: 2600 });
    return;
  }
  if (r && r.ok) D.toast(`Now on ${D.esc(r.branch || "")}${r.created ? " (new tracking branch)" : ""}`, "checkCircle", { ms: 2600 });
}
export async function doNewBranch(from, repo = S.repo) {
  const name = await prompt({ title: "New branch", ic: "branch", message: from ? `Starting from “${String(from).slice(0, 12)}” in ${repoName(repo)}.` : `Starting from the current HEAD of ${repoName(repo)}.`, placeholder: "feature/my-branch", confirmLabel: "Create & switch" });
  if (name == null || !name.trim()) return;
  await act(`Create ${name.trim()}`, () => D.atom.git.branchCreate(repo, name.trim(), { from: from || undefined, checkout: true }), { repo });
}
export async function doDeleteBranch(b, { remote } = {}, repo = S.repo) {
  if (remote) {
    if (!(await confirmDanger("Delete remote branch", `Delete “${b}” on the remote? Other people's clones will lose it on their next fetch.`, "Delete on remote"))) return;
    await act(`Delete ${b}`, () => D.atom.git.branchDelete(repo, b, { remote: true }), { repo });
    return;
  }
  if (!(await confirmDanger("Delete branch", `Delete local branch “${b}” in ${repoName(repo)}?`, "Delete"))) return;
  const r = await act(`Delete ${b}`, () => D.atom.git.branchDelete(repo, b), { repo, silent: true, refresh: false });
  if (r && r.unmerged) {
    if (await confirmDanger("Branch not fully merged", `“${b}” has commits that aren't merged anywhere else. Force-delete and lose them?`, "Force delete")) await act(`Force delete ${b}`, () => D.atom.git.branchDelete(repo, b, { force: true }), { repo });
    else await refreshRepo(repo);
    return;
  }
  if (r && r.ok) D.toast(`Deleted ${D.esc(b)}`, "checkCircle", { ms: 2600 });
  await refreshRepo(repo);
}
export async function doRename(b, repo = S.repo) {
  const name = await prompt({ title: "Rename branch", ic: "pencil", placeholder: "new-name", value: b, confirmLabel: "Rename" });
  if (name == null || !name.trim() || name.trim() === b) return;
  await act(`Rename ${b} → ${name.trim()}`, () => D.atom.git.branchRename(repo, b, name.trim()), { repo });
}
export async function doSetUpstream(b, repo = S.repo) {
  const info = S.infos[repo];
  const remotes = info ? info.remotes.map((r) => r.name) : [];
  const guess = remotes.find((r) => shortRef(r) === b) || `origin/${b}`;
  const up = await prompt({ title: "Set upstream", ic: "cloudUp", message: `Track which remote branch for “${b}”?`, placeholder: "origin/branch", value: guess, confirmLabel: "Set upstream" });
  if (up == null || !up.trim()) return;
  await act(`Set upstream of ${b}`, () => D.atom.git.setUpstream(repo, b, up.trim()), { repo });
}
/* Push exactly what the review shows. The destination is RESOLVED first (git's own
 * push-remote / upstream / push.default rules) and displayed as remote + full
 * destination ref; execution passes that same plan. No upstream → the user picks
 * the remote explicitly (initial publication). Rejected → pull-then-push flow with
 * a repo-bound continuation. */
/* "12 files updated · +340 −22 · 3 commits" — from the `summary` git.js attaches to a
 * pull / push result (tree-to-tree diff of the moved ref). Empty when unknown. */
export function changeText(sum, { verb = "updated", commitsFirst = false } = {}) {
  if (!sum) return "";
  const n = (k, one, many) => `${sum[k]} ${sum[k] === 1 ? one : many}`;
  const commits = sum.commits ? n("commits", "commit", "commits") : "";
  if (!sum.files) return [commits, "no file changes"].filter(Boolean).join(" · ");
  const parts = [`${n("files", "file", "files")} ${verb}`];
  if (sum.insertions || sum.deletions) parts.push(`+${sum.insertions} −${sum.deletions}`);
  if (commits) commitsFirst ? parts.unshift(commits) : parts.push(commits);
  return parts.join(" · ");
}
export function pullToast(r, from) {
  if (r.upToDate) { D.toast(`Already up to date with ${D.esc(from)}`, "checkCircle", { ms: 3200 }); return; }
  const sub = changeText(r.summary, { verb: "updated" });
  D.toast(`<b>Pulled ${D.esc(from)} into ${D.esc(r.branch || "")}</b>${sub ? `<span class="toast-sub">${D.esc(sub)}</span>` : ""}`, "checkCircle", { ms: 4500 });
}
export async function doPush({ repo = S.repo, branch, force, setUpstream, tags, skipConfirm, anchor, remote: remoteOverride, dest: destOverride } = {}) {
  const info = S.infos[repo] || {};
  const s = stat(repo) || {};
  const btn = anchor || q(".gitc-act.pushbtn");
  if (info.unborn) { D.toast("Nothing to push yet — make the first commit.", "alert"); return; }
  if (tags) {
    const remote = await chooseRemote(repo, btn, { prefer: remoteOverride || (s.upstream || "").split("/")[0], title: "Push all tags to which remote?" });
    if (!remote) return;
    if (!skipConfirm) { const c = await confirmPop(btn, { title: "Push tags", ic: "push", message: `Pushes every local tag of ${repoName(repo)} to “${remote}”.`, confirmLabel: "Push tags" }); if (!c.ok) return; }
    const r = await act("Push tags", () => D.atom.git.pushBranch(repo, { tags: true, remote }), { repo, silent: true });
    if (r && r.ok) D.toast(r.upToDate ? "Tags already up to date" : `Pushed tags to ${D.esc(remote)}`, "checkCircle", { ms: 3000 });
    return;
  }
  const cur = branch || (info.current && info.current !== "HEAD" ? info.current : "");
  if (!cur) { D.toast("Detached HEAD — check out a branch to push.", "alert"); return; }
  let plan;
  try { plan = await D.atom.git.pushPlan(repo, { branch: cur }); } catch (e) { failToast(`Push ${cur}`, e, repo); return; }
  let remote = remoteOverride || plan.remote, dest = destOverride || plan.dest || cur;
  if (plan.simpleMismatch && !destOverride) { D.toast(`<b>push.default=simple refuses this push</b><span class="toast-sub">“${D.esc(cur)}” tracks “${D.esc(plan.upstream)}” (a different name). Push explicitly to that branch or rename one of them.</span>`, "alert", { ms: 8000 }); return; }
  if (!remote) {
    remote = await chooseRemote(repo, btn, { title: `Publish “${cur}” to which remote?` });
    if (!remote) return;
    setUpstream = true;
  }
  if (force) {
    const c = await confirmPop(btn, { title: `Force push ${cur}`, danger: true, message: `Rewrites “${dest}” on “${remote}” (with lease${plan.remoteOid ? ` on ${plan.remoteOid.slice(0, 7)}` : ""}). Anyone else's work on it must be rebased.`, details: [{ k: "repo", v: repoName(repo) }, { k: "to", v: `${remote} → refs/heads/${dest}` }, { k: "url", v: plan.url || "?" }], confirmLabel: "Force push" });
    if (!c.ok) return;
  } else if (!skipConfirm) {
    const willTrack = setUpstream || !plan.hasUpstream;
    const c = await confirmPop(btn, { title: `Push ${cur}`, ic: "push", message: willTrack ? `“${cur}” will be published to “${remote}” as “${dest}” and start tracking it.` : `${s.ahead ? `${s.ahead} commit${s.ahead === 1 ? "" : "s"} to push` : "Nothing new to push"}${s.behind ? `. The remote has ${s.behind} newer commit${s.behind === 1 ? "" : "s"} — the push may be rejected until you pull.` : ""}`, details: [{ k: "repo", v: repoName(repo) }, { k: "to", v: `${remote} → refs/heads/${dest}` }, { k: "url", v: plan.url || "?" }], confirmLabel: willTrack ? "Publish" : "Push" });
    if (!c.ok) return;
    if (willTrack) setUpstream = true;
  }
  const label = force ? `Force push ${cur}` : `Push ${cur}`;
  const r = await act(label, () => D.atom.git.pushBranch(repo, { branch: cur, remote, dest, force: !!force, setUpstream: !!setUpstream, expectedRemoteOid: force ? plan.remoteOid || undefined : undefined }), { repo, silent: true, refresh: false });
  if (r && r.state === "rejected") { await refreshRepo(repo); return handleRejectedPush({ repo, branch: cur, remote, dest }); }
  await refreshRepo(repo);
  if (!r || !r.ok) return;
  if (r.upToDate) { D.toast(`Everything up to date (${D.esc(remote)}/${D.esc(dest)})`, "checkCircle", { ms: 3000 }); return; }
  const sub = r.newRef ? `new branch published${r.setUpstream ? " · tracking set" : ""}` : changeText(r.summary, { verb: "changed", commitsFirst: true });
  D.toast(`<b>Pushed ${D.esc(cur)} → ${D.esc(remote)}/${D.esc(dest)}</b>${sub ? `<span class="toast-sub">${D.esc(sub)}</span>` : ""}`, "checkCircle", { ms: 4500 });
}
export async function handleRejectedPush({ repo, branch, remote, dest }) {
  const s = stat(repo) || {};
  const c = await D.chooseDialog({
    title: `Remote has new commits (${repoName(repo)})`, ic: "alert",
    message: `The push of “${branch}” to ${remote}/${dest} was rejected because the remote moved on${s.behind ? ` (${s.behind} newer commit${s.behind === 1 ? "" : "s"})` : ""}. Bring those commits in first; if any file conflicts, you'll pick keep-mine / accept-incoming per file or per change, then the push runs again.`,
    choices: [{ label: "Pull & merge, then push", value: "merge", primary: true }, { label: "Pull with rebase, then push", value: "rebase" }, { label: "Cancel", value: null }],
  });
  if (!c) return;
  const P = per(repo);
  P.continuation = { kind: "push", repo, branch, remote, dest, created: Date.now() };
  // pullFrom reports conflicts as a result (not an error) → the operation stays in progress and the push waits for it
  const r = await act(c === "rebase" ? "Pull (rebase)" : "Pull", () => D.atom.git.pullFrom(repo, { remote, branch: dest, rebase: c === "rebase" }), { repo, silent: true, onConflict: () => { if (repo === S.repo) showConflicts(); } });
  if (r && r.state === "conflict") { D.toast("<b>Conflicts to resolve</b><span class=\"toast-sub\">Per file: Keep mine · Accept incoming · Resolve lines… Then Continue — the push is offered again afterwards.</span>", "alert", { ms: 8000 }); return; }
  if (!r || !r.ok) { P.continuation = null; return; }
  // pulled cleanly → refreshRepo (run by act) offered the push; if the offer didn't fire, push now
  if (P.continuation && P.continuation.branch === branch) { P.continuation = null; await doPush({ repo, branch, remote, dest, skipConfirm: true }); }
}
export function pullPicker(btn) {
  const repo = S.repo;
  const info = S.infos[repo] || { locals: [], remotes: [] };
  const s = stat(repo) || {};
  const rebaseCb = h("input", { type: "checkbox", class: "aqx-check" }); rebaseCb.checked = !!lsGet("pull.rebase", false);
  rebaseCb.addEventListener("change", () => lsSet("pull.rebase", rebaseCb.checked));
  const items = [];
  if (s.upstream) items.push({ value: "@upstream", label: `Pull from upstream (${s.upstream})`, icon: "pull", group: "Tracking", hint: s.behind ? `↓${s.behind}` : "" });
  const remotes = {};
  for (const b of info.remotes) { const rn = b.name.split("/")[0]; (remotes[rn] = remotes[rn] || []).push(b); }
  for (const rn of Object.keys(remotes)) for (const b of remotes[rn]) items.push({ value: b.name, label: b.name, icon: "cloudDown", group: `Remote · ${rn}`, hint: b.subject ? b.subject.slice(0, 40) : "" });
  if (!items.length) items.push({ value: "@upstream", label: "Pull (no remote branches known — fetch first)", icon: "pull" });
  pickList(btn, {
    items, placeholder: "Search branches to pull from…", width: 380,
    footer: h("label", { class: "gitc-check" }, rebaseCb, h("span", { text: "Rebase instead of merge" })),
    onPick: async (v) => {
      const rebase = rebaseCb.checked;
      const upstream = v === "@upstream";
      const [remote, ...rest] = upstream ? [] : v.split("/");
      const opts = upstream ? { rebase } : { remote, branch: rest.join("/"), rebase };
      const r = await act(upstream ? (rebase ? "Pull (rebase)" : "Pull") : `Pull ${v}${rebase ? " (rebase)" : ""}`, () => D.atom.git.pullFrom(repo, opts), { repo, silent: true });
      if (r && r.ok) pullToast(r, upstream ? (r.from || s.upstream || "upstream") : v);
    },
  });
}
export async function doStash(anchor, repo = S.repo) {
  const c = await confirmPop(anchor || q(".gitc-act.stashbtn"), { title: "Stash changes", ic: "download", message: `Parks the local changes of ${repoName(repo)} so the tree is clean; re-apply them from the Stashes tab.`, confirmLabel: "Stash", fields: [{ id: "msg", placeholder: "Optional message" }, { id: "untracked", type: "check", label: "Include untracked files", value: false }, { id: "keepIndex", type: "check", label: "Keep staged changes in the index", value: false }] });
  if (!c.ok) return;
  const r = await act("Stash", () => D.atom.git.stashSave(repo, { message: c.values.msg, includeUntracked: !!c.values.untracked, keepIndex: !!c.values.keepIndex }), { repo, silent: true });
  if (r && r.nothing) D.toast("No local changes to stash", "check"); else if (r && r.ok) D.toast("Stashed", "checkCircle", { ms: 2400 });
}
export async function doReset(ref, repo = S.repo) {
  const info = S.infos[repo] || {};
  let ids = null; try { ids = await D.atom.git.resolveRefs(repo, [ref]); } catch { /* validated again below */ }
  if (ids && !ids[ref]) { D.toast(`“${D.esc(ref)}” is not a known revision`, "alert"); return; }
  const mode = await D.chooseDialog({ title: `Reset ${info.current || ""} to ${String(ids && ids[ref] ? ids[ref] : ref).slice(0, 12)}`, ic: "undo", message: "Soft keeps your changes staged · Mixed keeps them unstaged · Hard DISCARDS every local change and commit after this point.", choices: [{ label: "Soft", value: "soft" }, { label: "Mixed", value: "mixed", primary: true }, { label: "Hard", value: "hard" }, { label: "Cancel", value: null }] });
  if (!mode) return;
  if (mode === "hard" && !(await confirmDanger("Hard reset", `This permanently discards uncommitted changes in ${repoName(repo)} and moves the branch. Continue?`, "Hard reset"))) return;
  await act(`Reset (${mode}) to ${String(ref).slice(0, 7)}`, () => D.atom.git.reset(repo, ref, mode, { expect: ids && ids[ref] ? { [ref]: ids[ref] } : undefined }), { repo });
}
// Snapshots from History: whole tree at a commit, or just the files it changed (vs an explicit parent).
export async function downloadSnapshot(hash, kind, { parent, repo = S.repo } = {}) {
  const short = String(hash).slice(0, 7);
  const base = `${repoName(repo)}-${short}${kind === "files" ? "-changed-files" : ""}.zip`;
  D.toast(kind === "files" ? "Collecting changed files…" : "Archiving repository…", "spinner", { sticky: true, spin: true });
  let r;
  try { r = kind === "files" ? await D.atom.git.commitZip(repo, hash, base, { parent: parent || undefined }) : await D.atom.git.archiveZip(repo, hash, base); }
  catch (e) { failToast("Download", e, repo); return; }
  if (!r || r.canceled) { D.toast("Cancelled", "check", { ms: 1200 }); return; }
  const skipped = (r.skipped || []).length, failed = (r.failed || []).length;
  D.toast(`<b>${failed ? "Saved (incomplete) " : "Saved "}${D.esc(D.baseName(r.path))}</b><span class="toast-sub">${kind === "files" ? `${r.files} file${r.files === 1 ? "" : "s"} under files/` : "full repository at " + short}${r.size ? " · " + fmtSize(r.size) : ""}${skipped ? ` · ${skipped} deleted path${skipped === 1 ? "" : "s"} listed in manifest.json` : ""}${failed ? ` · ${failed} unreadable file${failed === 1 ? "" : "s"} — see manifest.json` : ""}</span>`, failed ? "alert" : "checkCircle", { ms: failed ? 8000 : 6000 });
  try { D.atom.files.reveal(r.path); } catch { /* optional */ }
}
