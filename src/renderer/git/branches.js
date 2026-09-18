/* AtomNano renderer — Branches and merge.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { promptDialog, showContextMenu, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { refreshTree } from "../workspace/sidebar.js";
import { openCompare } from "./diff-viewer.js";
import { gitBranchOf, refreshGit, setSidebarView } from "./sidebar.js";
import { esc, repoName } from "./titlebar.js";

/* ============================================================
   GIT BRANCHES + MERGE
   ============================================================ */
export async function openBranchMenu(repo, ev) {
  let info;
  try { info = await atom.git.branches(repo); } catch (e) { toast("Couldn’t list branches: " + e.message, "alert"); return; }
  const others = info.locals.filter((b) => b !== info.current);
  const items = [{ label: info.current + "  (current)", icon: "check", onClick: () => {} }];
  if (others.length) {
    items.push({ sep: true });
    for (const b of others) items.push({ label: "Switch to " + b, icon: "branch", onClick: () => gitCheckout(repo, b) });
  }
  items.push({ sep: true }, { label: "New branch…", icon: "plus", onClick: () => promptNewBranch(repo) });
  // Merging lives in the compare view now (pick source + target, review, then merge).
  if (others.length || info.remotes.length) items.push({ label: "Compare & merge…", icon: "gitCompare", onClick: () => openCompare(repo) });
  if (info.merging) items.push({ sep: true }, { label: "Abort merge", icon: "x", danger: true, onClick: () => gitMergeAbort(repo) });
  showMenuAt(ev, items);
}
// Open a context menu anchored to an element (event.currentTarget) or a point.
export function showMenuAt(ev, items) {
  let x = 0, y = 0;
  const t = ev && ev.currentTarget;
  if (t && t.getBoundingClientRect) { const r = t.getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
  else if (ev) { x = ev.clientX || 0; y = (ev.clientY || 0) + 4; }
  showContextMenu(x, y, items);
}
export async function gitCheckout(repo, branch) {
  toast(`Switching ${esc(repoName(repo))} → ${esc(branch)}…`, "branch", { sticky: true, spin: true });
  try {
    const r = await atom.git.checkout(repo, branch);
    state.git.selected.clear();
    toast(`Switched ${esc(repoName(repo))} to ${esc(r.branch)}`, "checkCircle", { ms: 3000 });
    await refreshGit(); refreshTree(true);
  } catch (e) { toast(`Checkout failed (${esc(repoName(repo))}): ${esc(e.message)}`, "alert", { ms: 6000 }); }
}
export async function gitMerge(repo, branch) {
  toast(`Merging ${esc(branch)} → ${esc(repoName(repo))}…`, "git", { sticky: true, spin: true });
  try {
    const r = await atom.git.merge(repo, branch);
    if (r.ok) {
      const how = r.upToDate ? "already up to date" : (r.fastForward ? "fast-forward" : "merged");
      toast(`Merged ${esc(branch)} → ${esc(r.into)} (${how})`, "checkCircle", { ms: 4200 });
    } else if (r.conflict) {
      if (state.sidebarView !== "git") setSidebarView("git");
      toast(`<b>Merge conflicts in ${esc(repoName(repo))}</b><span class="toast-sub">Resolve the conflicted files, then commit — or abort from the branch menu.</span>`, "alert", { ms: 7000 });
    }
    await refreshGit(); refreshTree(true);
  } catch (e) { toast(`Merge failed (${esc(repoName(repo))}): ${esc(e.message)}`, "alert", { ms: 6000 }); }
}
// Abort whatever operation is in progress (merge / rebase / cherry-pick / revert / bisect —
// main dispatches to the matching git command from the repo's actual state).
export async function gitMergeAbort(repo) {
  try { const r = await atom.git.mergeAbort(repo); toast(`Aborted ${esc(r && r.op || "merge")} in ${esc(repoName(repo))}`, "checkCircle", { ms: 3000 }); await refreshGit(); refreshTree(true); }
  catch (e) { toast(`Abort failed (${esc(repoName(repo))}): ${esc(e.message)}`, "alert", { ms: 5000 }); }
}
// Branch entry from the git-view header: 1 repo → its branch menu; many → pick a
// project first.
export function openBranchFlow(ev) {
  const repos = state.git.repos || [];
  if (!repos.length) return;
  if (repos.length === 1) return openBranchMenu(repos[0], ev);
  showMenuAt(ev, repos.map((r) => ({ label: repoName(r) + "  —  " + (gitBranchOf(r) || "?"), icon: "branch", onClick: (e) => openBranchMenu(r, ev) })));
}
export function promptNewBranch(repo) {
  promptDialog({
    title: "New branch", ic: "branch", placeholder: "feature/my-branch", confirmLabel: "Create & switch",
    onConfirm: (name) => { name = (name || "").trim(); if (!name) return; gitCheckoutNew(repo, name); },
  });
}
export async function gitCheckoutNew(repo, name) {
  toast(`Creating ${esc(name)}…`, "branch", { sticky: true, spin: true });
  try { const r = await atom.git.checkout(repo, name, { create: true }); toast(`Created & switched to ${esc(r.branch)}`, "checkCircle", { ms: 3200 }); await refreshGit(); refreshTree(true); }
  catch (e) { toast(`Create branch failed: ${esc(e.message)}`, "alert", { ms: 6000 }); }
}
