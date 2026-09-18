/* AtomNano renderer — Git sidebar — repo discovery, status, commit view.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { $, baseName, closeModal, confirmDialog, copyText, h, modalShell, showContextMenu, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { parseUnifiedDiff } from "../diff.js";
import { openInEditor } from "../editor/editor-pane.js";
import { icon } from "../icons.js";
import { fileMeta, refreshTree, renderSidebar } from "../workspace/sidebar.js";
import { gitMergeAbort, openBranchFlow, openBranchMenu } from "./branches.js";
import { changeText } from "./center/index.js";
import { conflictedFiles, openConflictResolver } from "./conflicts-ui.js";
import { openCompare, openCompareFlow, openDiff } from "./diff-viewer.js";
import { afterGitSelectionChange, esc, gitProjectRoot, gitPushable, gitTotalChanges, isSel, renderFolderActions, repoFiles, repoName, selKey, selectionByRepo, setRepoSelection, setSel, totalSelected } from "./titlebar.js";

/* ============================================================
   GIT: per-repo discovery + status, commit view (replaces the tree)
   ============================================================ */
export function setSidebarView(view) {
  state.sidebarView = view === "git" ? "git" : "files";
  renderSidebar();
  if (state.sidebarView === "git") refreshGit();
}
export let _refreshGitT = 0;
export function scheduleGitRefresh() { clearTimeout(_refreshGitT); _refreshGitT = setTimeout(() => refreshGit(), 250); }
// Discover the project's repo(s) (itself, or its repo subfolders) and fetch the
// status of each — the commit view shows them all, grouped by folder.
export async function refreshGit() {
  const root = gitProjectRoot();
  let repos = [];
  if (root) { try { repos = await atom.git.repos(root); } catch { repos = []; } }
  state.git.repos = repos;
  try { if (atom.git.watch) atom.git.watch(repos).catch(() => {}); } catch { /* optional */ }
  renderFolderActions();
  const statuses = {};
  // A status read that FAILS is an error state (last snapshot kept, marked stale) — it is
  // never presented as a clean tree, and its repo is never silently dropped.
  await Promise.all(repos.map(async (r) => {
    const prev = state.git.statuses[r];
    try { const s = await atom.git.status(r); statuses[r] = s && s.repo === false ? { repo: false, state: "notRepo", files: [], branch: "", error: "Not a Git repository" } : { ...s, state: "ready", error: "" }; }
    catch (e) { statuses[r] = { ...(prev && prev.repo ? prev : { repo: true, branch: "", files: [] }), state: "error", stale: !!(prev && prev.state === "ready"), error: e.message || String(e), type: e.type, files: (prev && prev.files) || [], clean: false }; }
  }));
  state.git.statuses = statuses;
  // Drop selections whose file no longer appears in the status (committed/reverted).
  const valid = new Set();
  for (const r of repos) { const s = statuses[r]; if (s && s.files) for (const f of s.files) valid.add(selKey(r, f.path)); }
  for (const k of [...state.git.selected]) if (!valid.has(k)) state.git.selected.delete(k);
  renderFolderActions();
  if (state.sidebarView === "git") renderGitView();
}
export function gitBranchOf(repo) {
  const s = state.git.statuses[repo];
  return (s && s.branch) || "";
}
/* ---- multi-project pull / push, with progress + per-project summary toasts ---- */

// Pull a single repo (used by a tree folder's right-click "Git pull").
export async function gitPull(repo) {
  if (!repo) return;
  toast("Pulling " + esc(repoName(repo)) + "…", "spinner", { sticky: true, spin: true });
  try {
    const r = await atom.git.pull(repo);
    await refreshGit(); refreshTree(true);
    // A conflicted pull resolves with ok:false / state:"conflict" — it is NOT a success.
    if (r && (r.conflict || r.state === "conflict")) { if (state.sidebarView !== "git") setSidebarView("git"); toast(`<b>Pull of ${esc(repoName(repo))} needs your help</b><span class="toast-sub">Conflicts to resolve — then continue the ${esc(r.op || "merge")} from the banner.</span>`, "alert", { ms: 7000 }); openConflictResolver(repo); return; }
    if (r && r.ok === false) { toast("Pull failed (" + esc(repoName(repo)) + "): " + esc(r.error || r.output || r.state), "alert", { ms: 6000 }); return; }
    const sub = r.upToDate ? "already up to date" : changeText(r.summary, { verb: "updated" });
    toast(`<b>Pulled ${esc(repoName(repo))} → ${esc(r.branch || "")}</b>${sub ? `<span class="toast-sub">${esc(sub)}</span>` : ""}`, "checkCircle", { ms: 4200 });
  } catch (e) { toast("Pull failed (" + esc(repoName(repo)) + "): " + esc(e.message), "alert", { ms: 6000 }); }
}
// Pull every discovered project, one after another, with a live progress toast
// and a final summary naming each project and its branch.
export async function pullAll() {
  const repos = state.git.repos || [];
  if (!repos.length) return;
  const results = [];
  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    toast(`Pulling ${esc(repoName(repo))}…  (${i + 1}/${repos.length})`, "spinner", { sticky: true, spin: true });
    try {
      const r = await atom.git.pull(repo);
      if (r && (r.conflict || r.state === "conflict")) results.push({ repo, ok: false, branch: r.branch, error: "conflicts to resolve (open the Changes view)", conflict: true });
      else if (r && r.ok === false) results.push({ repo, ok: false, branch: r.branch, error: r.error || r.output || r.state || "failed" });
      else results.push({ repo, ok: true, branch: r.branch, upToDate: r.upToDate, summary: r.summary });
    }
    catch (e) { results.push({ repo, ok: false, error: e.message }); }
  }
  summaryToast("Pulled", results, { changedWord: "updated" });
  await refreshGit(); refreshTree(true);
  if (results.some((r) => r.conflict) && state.sidebarView !== "git") setSidebarView("git");
}
// Push a list of repos sequentially with progress; returns per-repo results.
export async function pushReposList(repos, { verb = "Pushed" } = {}) {
  const list = (repos || []).filter(Boolean);
  if (!list.length) return [];
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const repo = list[i];
    const branch = gitBranchOf(repo) || (await atom.git.branch(repo).catch(() => "")) || "";
    state.git.pushing.add(repo);
    if (state.sidebarView === "git") renderGitView();
    toast(`Pushing ${esc(repoName(repo))}${branch ? " · " + esc(branch) : ""}  (${i + 1}/${list.length})`, "spinner", { sticky: true, spin: true, dots: true });
    try {
      const r = await atom.git.push(repo);   // resolved destination (branch remote / pushRemote / pushDefault) — never an invented origin
      if (r && r.state === "rejected") results.push({ repo, ok: false, branch: r.branch || branch, error: `rejected by ${r.remote || "the remote"} — pull first (${(r.error || "").split("\n")[0]})`, rejected: true });
      else if (r && r.ok === false) results.push({ repo, ok: false, branch: r.branch || branch, error: r.error || r.state || "failed" });
      else results.push({ repo, ok: true, branch: r.branch || branch, upToDate: r.upToDate, dest: r.remote && r.dest ? `${r.remote}/${r.dest}` : "", summary: r.summary, newRef: r.newRef });
    }
    catch (e) { results.push({ repo, ok: false, branch, error: e.message }); }
    finally { state.git.pushing.delete(repo); if (state.sidebarView === "git") renderGitView(); }
  }
  summaryToast(verb, results);
  return results;
}
// Push every project that has unpushed commits (or no upstream yet).
export async function pushAll() {
  const repos = (state.git.repos || []).filter(gitPushable);
  if (!repos.length) { toast("Nothing to push — all projects up to date", "push", { ms: 2600 }); return; }
  await pushReposList(repos, { verb: "Pushed" });
  await refreshGit();
}
// Thin wrapper kept for the per-repo push button + test hook.
export async function pushRepo(repo) { const r = await pushReposList([repo], { verb: "Pushed" }); return !!(r[0] && r[0].ok); }
// One shared summary toast for pull/push/commit results: success lists every
// project → branch; partial/total failure shows the errors.
export function summaryToast(verb, results, { changedWord } = {}) {
  const okR = results.filter((r) => r.ok), bad = results.filter((r) => !r.ok);
  // "(12 files updated · +340 −22 · 3 commits)" when the backend reported what moved
  const tail = (r) => r.upToDate ? " (up to date)" : r.newRef ? " (new branch published)" : r.summary ? ` (${changeText(r.summary, { verb: changedWord || "changed", commitsFirst: !changedWord })})` : (changedWord ? ` (${changedWord})` : "");
  const line = (r) => `${esc(repoName(r.repo))} → ${esc(r.dest || r.branch || "?")}${tail(r)}`;
  const errLine = (r) => `${esc(repoName(r.repo))}: ${esc(r.error)}`;
  if (okR.length && !bad.length) {
    if (okR.length === 1) toast(`${verb} ${line(okR[0])}`, "checkCircle", { ms: 4200 });
    else toast(`<b>${verb} ${okR.length} projects</b><span class="toast-sub">${okR.map(line).join("<br>")}</span>`, "checkCircle", { ms: 5200 });
  } else if (okR.length && bad.length) {
    toast(`<b>${verb} ${okR.length}, ${bad.length} failed</b><span class="toast-sub">${[...okR.map(line), ...bad.map(errLine)].join("<br>")}</span>`, "alert", { ms: 7000 });
  } else {
    toast(`<b>${verb === "Pulled" ? "Pull" : "Push"} failed</b><span class="toast-sub">${bad.map(errLine).join("<br>")}</span>`, "alert", { ms: 7000 });
  }
}
// Commit the SELECTED files in each project (selection is staged then committed
// with the same pathspec). The button decides whether the committed projects are
// then pushed. Falls back to the lone dirty repo when nothing is ticked.
// "Review & commit changes" modal — a polished two-pane workflow:
//   ▸ left pane: file list grouped by repo, each file with its type-coloured
//     icon, +/− stats, type badge, individual checkbox + select-all
//   ▸ right pane: live unified diff preview of the focused file with green/red
//     line highlighting
//   ▸ bottom: commit message + summary chip + Cancel / Commit / Commit & Push
// `defaultPush` pre-selects which action gets visual primacy (the button the
// user actually clicked on the side panel).
export async function openCommitModal(defaultPush) {
  const repos = (state.git.repos || []).filter((r) => { const s = state.git.statuses[r]; return s && s.files && s.files.length; });
  if (!repos.length) { toast("No changes to commit", "alert"); return; }
  // If the user hasn't selected anything yet, default-select everything they
  // currently have changes in — single-repo workspaces especially expect this.
  const anySel = repos.some((r) => repoFiles(r).some((f) => isSel(r, f.path)));
  if (!anySel) for (const r of repos) for (const f of repoFiles(r)) setSel(r, f.path, !f.conflict);

  const body = h("div", { class: "commit-modal" });

  // Per-repo collapsed/expanded state (id-keyed Set). Default = expanded.
  const collapsed = new Set();

  // Tab strip: switches the modal between Commit and Merge modes. Both keep
  // the same chrome (header, footer); only the body content swaps.
  let mode = "commit";
  const tabCommit = h("button", { class: "cm-tab active", text: "Commit", onclick: () => setMode("commit") });
  const tabMerge = h("button", { class: "cm-tab", text: "Merge", onclick: () => setMode("merge") });
  const tabStrip = h("div", { class: "cm-tabs" }, tabCommit, tabMerge);
  // Containers for the two sub-views. The merge view is built lazily — first
  // time the user clicks the tab.
  const commitView = h("div", { class: "cm-view commit-view" });
  const mergeView = h("div", { class: "cm-view merge-view hidden" });
  let mergeBuilt = false;
  body.append(tabStrip, commitView, mergeView);

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    tabCommit.classList.toggle("active", mode === "commit");
    tabMerge.classList.toggle("active", mode === "merge");
    commitView.classList.toggle("hidden", mode !== "commit");
    mergeView.classList.toggle("hidden", mode !== "merge");
    // Lazy-build the merge view on first show.
    if (mode === "merge" && !mergeBuilt) { mergeBuilt = true; buildMergeView(); }
    // Footer chip + action buttons change shape between modes.
    updateFooterForMode();
  }

  // --- LEFT pane: file list -------------------------------------------------
  const leftPane = h("div", { class: "cm-files-pane" });
  const summaryEl = h("div", { class: "cm-files-summary" });
  const selectAllRow = h("label", { class: "cm-select-all" },
    h("input", { type: "checkbox", id: "cmSelectAll" }),
    h("span", { text: "Select all" }));
  selectAllRow.querySelector("input").addEventListener("change", (ev) => {
    const on = ev.target.checked;
    for (const r of repos) for (const f of repoFiles(r)) setSel(r, f.path, on && !f.conflict);
    redraw();
  });
  leftPane.append(h("div", { class: "cm-files-head" }, summaryEl, selectAllRow));
  const filesList = h("div", { class: "cm-files-list" });
  leftPane.append(filesList);

  // --- Draggable divider between left + right panes -----------------------
  const divider = h("div", { class: "cm-divider", title: "Drag to resize" });
  // Mouse drag → CSS variable on the outer .cm-main grid, clamped to a sane
  // min/max so the left pane never collapses to zero or eats the right one.
  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.classList.add("cm-resizing");
    const main = body.querySelector(".cm-main");
    const startX = e.clientX;
    const startWidth = leftPane.getBoundingClientRect().width;
    const totalWidth = main.getBoundingClientRect().width;
    const onMove = (m) => {
      const next = Math.max(220, Math.min(totalWidth - 320, startWidth + (m.clientX - startX)));
      main.style.setProperty("--cm-left", next + "px");
    };
    const onUp = () => {
      document.body.classList.remove("cm-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  // --- RIGHT pane: diff preview --------------------------------------------
  const rightPane = h("div", { class: "cm-diff-pane" });
  rightPane.append(h("div", { class: "cm-diff-empty" }, h("span", { html: icon("gitCompare", 28) }), h("span", { text: "Click a file to preview its diff" })));
  let activeFilePath = null;

  // --- BOTTOM: commit message + actions ------------------------------------
  const msg = h("textarea", { class: "cm-msg", placeholder: "Write a clear, one-line summary. Add details below if needed.", spellcheck: "false", rows: "3" });
  msg.value = state.git.message || "";
  msg.addEventListener("input", () => { state.git.message = msg.value; updateButtons(); });
  // Ctrl/Cmd+Enter = primary action (commit, or commit & push if that's the
  // default the user opened this from).
  msg.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); (defaultPush ? doCommitPush : doCommit)(); }
  });

  const cancelBtn = h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => closeModal(modal) });
  const commitBtn = h("button", { class: "btn" + (defaultPush ? "" : " btn-primary"), text: "Commit", onclick: () => doCommit() });
  const commitPushBtn = h("button", { class: "btn" + (defaultPush ? " btn-primary" : ""), text: "Commit & Push", onclick: () => doCommitPush() });
  const actionsRight = h("div", { class: "cm-actions-right" }, cancelBtn, commitBtn, commitPushBtn);
  const statsChip = h("div", { class: "cm-stats-chip" });

  commitView.append(
    h("div", { class: "cm-main" }, leftPane, divider, rightPane),
    h("div", { class: "cm-bottom" },
      h("div", { class: "cm-msg-label" },
        h("span", { class: "cm-msg-label-text", text: "Commit message" }),
        h("span", { class: "cm-msg-hint", text: "Ctrl+Enter to commit" })),
      msg));

  // Footer holds two button bundles, one per mode. We swap them when the user
  // switches tabs so the same modal-foot lives in both flows.
  const mergeBtn = h("button", { class: "btn btn-primary", text: "Merge", disabled: true, onclick: () => doMerge() });
  const createMrBtn = h("button", { class: "btn", text: "Open as merge request", disabled: true, onclick: () => openAsMergeRequest() });
  const mergeCancelBtn = h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => closeModal(modal) });
  const mergeStatsChip = h("div", { class: "cm-stats-chip", text: "Select branches to compare" });
  const commitFootGroup = h("div", { class: "cm-foot-group" }, statsChip, h("div", { class: "spacer" }), actionsRight);
  const mergeFootGroup = h("div", { class: "cm-foot-group hidden" }, mergeStatsChip, h("div", { class: "spacer" }), mergeCancelBtn, createMrBtn, mergeBtn);
  const footer = h("div", { class: "cm-foot" }, commitFootGroup, mergeFootGroup);
  function updateFooterForMode() {
    commitFootGroup.classList.toggle("hidden", mode !== "commit");
    mergeFootGroup.classList.toggle("hidden", mode !== "merge");
  }

  const modal = modalShell({ title: "Review & commit changes", ic: "commit", wide: true, body, footer });

  // --- MERGE view (built lazily on first tab switch) ---------------------
  let mergeState = { repo: null, source: null, target: null, commits: null, files: null, fileDiffs: new Map(), activeFile: null };
  function buildMergeView() {
    const allRepos = (state.git.repos || []).slice();
    const repoSel = h("select", { class: "cm-merge-select" });
    for (const r of allRepos) repoSel.append(h("option", { value: r, text: repoName(r) }));
    const sourceSel = h("select", { class: "cm-merge-select", disabled: true });
    const targetSel = h("select", { class: "cm-merge-select", disabled: true });
    const compareBtn = h("button", { class: "btn btn-primary cm-merge-compare", text: "Compare", disabled: true,
      onclick: () => runCompare(repoSel.value, sourceSel.value, targetSel.value) });
    const swapBtn = h("button", { class: "btn btn-ghost cm-merge-swap", title: "Swap source and target", html: icon("refresh", 13),
      onclick: () => { const a = sourceSel.value; sourceSel.value = targetSel.value; targetSel.value = a; updateCompareReadiness(); } });

    const pickerBar = h("div", { class: "cm-merge-picker" },
      h("div", { class: "cm-merge-field" }, h("label", { text: "Project" }), repoSel),
      h("div", { class: "cm-merge-field" }, h("label", { text: "Source (FROM)" }), sourceSel),
      swapBtn,
      h("div", { class: "cm-merge-field" }, h("label", { text: "Target (INTO)" }), targetSel),
      compareBtn);

    const summaryBar = h("div", { class: "cm-merge-summary hidden" });
    const compareBody = h("div", { class: "cm-merge-results hidden" });
    const initialMsg = h("div", { class: "cm-merge-initial" },
      h("span", { html: icon("gitCompare", 36) }),
      h("h3", { text: "Compare and merge branches" }),
      h("p", { text: "Pick a project, then choose the source and target branches. Compare shows what will land before you merge." }));

    mergeView.append(pickerBar, summaryBar, initialMsg, compareBody);

    // Load branches for the selected repo + auto-pick a sensible default
    // (source = current branch, target = main/master/develop if present).
    async function reloadBranches(repo) {
      sourceSel.innerHTML = ""; targetSel.innerHTML = "";
      sourceSel.disabled = targetSel.disabled = true;
      summaryBar.classList.add("hidden"); summaryBar.innerHTML = "";
      compareBody.classList.add("hidden"); compareBody.innerHTML = "";
      initialMsg.classList.remove("hidden");
      mergeBtn.disabled = createMrBtn.disabled = true;
      mergeStatsChip.textContent = "Loading branches…";
      let info;
      try { info = await atom.git.branches(repo); }
      catch (e) { mergeStatsChip.textContent = "Couldn't list branches: " + e.message; return; }
      // Real IPC shape: { locals, remotes } (legacy `local` / `remote` still accepted).
      // Sources may be any ref; TARGETS are local branches only (a remote-tracking ref or
      // tag would be checked out detached and the merge would update nothing).
      const localsList = Array.from(new Set((info.locals || info.local || []).filter(Boolean)));
      const remotesList = Array.from(new Set((info.remotes || info.remote || []).filter(Boolean)));
      const unique = Array.from(new Set([...localsList, ...remotesList]));
      for (const b of unique) sourceSel.append(h("option", { value: b, text: b }));
      for (const b of localsList) targetSel.append(h("option", { value: b, text: b }));
      const current = info.current || (state.git.statuses[repo] && state.git.statuses[repo].branch) || "";
      const defaultTarget = localsList.find((b) => /^(main|master|develop|trunk)$/.test(b)) || localsList[0];
      sourceSel.value = current || unique[0] || "";
      targetSel.value = defaultTarget && defaultTarget !== sourceSel.value ? defaultTarget : (localsList.find((b) => b !== sourceSel.value) || "");
      sourceSel.disabled = targetSel.disabled = false;
      mergeStatsChip.textContent = "Click Compare to load changes";
      updateCompareReadiness();
    }
    function updateCompareReadiness() { compareBtn.disabled = !sourceSel.value || !targetSel.value || sourceSel.value === targetSel.value; }

    repoSel.addEventListener("change", () => reloadBranches(repoSel.value));
    sourceSel.addEventListener("change", updateCompareReadiness);
    targetSel.addEventListener("change", updateCompareReadiness);

    // Auto-select the repo the user was looking at, or the only repo.
    repoSel.value = repos[0] || allRepos[0];
    reloadBranches(repoSel.value);

    // Compare → fetch commits + files, then render the GitLab-style results.
    async function runCompare(repo, source, target) {
      mergeState = { repo, source, target, commits: null, files: null, fileDiffs: new Map(), activeFile: null };
      compareBtn.disabled = true;
      compareBtn.innerHTML = `${icon("spinner", 13, "spin")}<span style="margin-left:6px">Comparing…</span>`;
      mergeStatsChip.textContent = `Comparing ${source} → ${target}…`;
      initialMsg.classList.add("hidden");
      summaryBar.classList.remove("hidden");
      summaryBar.innerHTML = "";
      summaryBar.append(h("div", { class: "cm-merge-loading" }, h("span", { html: icon("spinner", 14, "spin") }), h("span", { text: "Loading commits and changed files…" })));
      try {
        const [cRes, fRes] = await Promise.all([
          atom.git.commitsBetween(repo, target, source).catch((e) => ({ error: e.message, commits: [] })),
          atom.git.changedBetween(repo, target, source).catch((e) => ({ error: e.message, files: [] })),
        ]);
        mergeState.commits = cRes.commits || [];
        mergeState.files = fRes.files || [];
        renderCompareResults(cRes, fRes);
      } catch (e) {
        summaryBar.innerHTML = "";
        summaryBar.append(h("div", { class: "cm-merge-error", text: "Compare failed: " + e.message }));
      } finally {
        compareBtn.disabled = false; compareBtn.textContent = "Compare";
        updateCompareReadiness();
      }
    }

    // The GitLab-style compare results: top stats bar, then 50/50 split with
    // commits on the left and changed files on the right (click a file to
    // expand its diff inline).
    function renderCompareResults(cRes, fRes) {
      const commits = mergeState.commits, files = mergeState.files;
      summaryBar.innerHTML = "";
      summaryBar.append(
        h("div", { class: "cm-merge-stat" }, h("span", { class: "n", text: String(commits.length) }), h("span", { class: "k", text: commits.length === 1 ? "commit" : "commits" })),
        h("div", { class: "cm-merge-arrow", text: "·" }),
        h("div", { class: "cm-merge-stat" }, h("span", { class: "n", text: String(files.length) }), h("span", { class: "k", text: files.length === 1 ? "file" : "files" })),
        h("div", { class: "cm-merge-arrow", text: "·" }),
        h("div", { class: "cm-merge-branchpair" },
          h("span", { class: "cm-merge-branch-from", text: mergeState.source }),
          h("span", { html: icon("chevron", 12), style: "transform: rotate(0deg); opacity:.5;" }),
          h("span", { class: "cm-merge-branch-to", text: mergeState.target })));

      compareBody.classList.remove("hidden");
      compareBody.innerHTML = "";

      // Left: commit list
      const commitsCol = h("div", { class: "cm-merge-col cm-merge-commits" });
      commitsCol.append(h("div", { class: "cm-merge-col-head", text: `Commits (${commits.length})` }));
      const cList = h("div", { class: "cm-merge-col-body" });
      if (!commits.length) cList.append(h("div", { class: "cm-merge-empty", text: "No new commits on source. Source is up to date with target." }));
      else for (const c of commits) {
        cList.append(h("div", { class: "cm-merge-commit", title: `${c.full}\n${c.subject}\n— ${c.author} · ${c.date}` },
          h("span", { class: "cm-commit-hash", text: c.hash }),
          h("div", { class: "cm-commit-body" },
            h("div", { class: "cm-commit-subject", text: c.subject }),
            h("div", { class: "cm-commit-meta", text: `${c.author} · ${c.date}` }))));
      }
      commitsCol.append(cList);

      // Right: files list — click to expand inline diff
      const filesCol = h("div", { class: "cm-merge-col cm-merge-files" });
      filesCol.append(h("div", { class: "cm-merge-col-head", text: `Changed files (${files.length})` }));
      const fList = h("div", { class: "cm-merge-col-body" });
      if (!files.length) fList.append(h("div", { class: "cm-merge-empty", text: "No file changes. Branches are identical for files." }));
      else for (const f of files) {
        const fm = fileMeta(baseName(f.path));
        const statCls = f.code === "A" ? "added" : f.code === "D" ? "deleted" : "modified";
        const row = h("div", { class: "cm-merge-file" },
          h("div", { class: "cm-merge-file-head" },
            h("span", { class: "cm-merge-file-caret", html: icon("chevron", 12) }),
            h("span", { class: "cm-merge-file-ic " + fm.cls, html: icon(fm.ic, 13) }),
            h("span", { class: "cm-merge-file-name " + fm.cls, text: baseName(f.path) }),
            h("span", { class: "cm-merge-file-path", text: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "" }),
            h("span", { class: "cm-merge-file-stat " + statCls, text: f.label })),
          h("div", { class: "cm-merge-file-diff hidden" }));
        const head = row.querySelector(".cm-merge-file-head");
        const diffSlot = row.querySelector(".cm-merge-file-diff");
        head.addEventListener("click", async () => {
          const expanded = !diffSlot.classList.contains("hidden");
          if (expanded) { diffSlot.classList.add("hidden"); row.classList.remove("expanded"); return; }
          row.classList.add("expanded"); diffSlot.classList.remove("hidden");
          if (!mergeState.fileDiffs.has(f.path)) {
            diffSlot.innerHTML = ""; diffSlot.append(h("div", { class: "cm-diff-loading" }, h("span", { html: icon("spinner", 14, "spin") }), h("span", { text: "Loading diff…" })));
            try {
              const d = await atom.git.refDiff(mergeState.repo, mergeState.target, mergeState.source, f.path);
              mergeState.fileDiffs.set(f.path, d.text || "");
            } catch (e) { mergeState.fileDiffs.set(f.path, ""); }
          }
          const text = mergeState.fileDiffs.get(f.path) || "";
          diffSlot.innerHTML = "";
          if (!text.trim()) { diffSlot.append(h("div", { class: "cm-merge-empty cm-merge-empty-small", text: "No textual diff (binary or empty)." })); return; }
          const pre = h("pre", { class: "cm-diff-body" });
          let html = "";
          for (const ln of text.split("\n")) {
            let cls = "";
            if (ln.startsWith("@@")) cls = "diff-hunk";
            else if (ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff ") || ln.startsWith("index ")) cls = "diff-meta";
            else if (ln.startsWith("+")) cls = "diff-add";
            else if (ln.startsWith("-")) cls = "diff-del";
            html += `<span class="${cls}">${esc(ln)}</span>\n`;
          }
          pre.innerHTML = html;
          diffSlot.append(pre);
        });
        fList.append(row);
      }
      filesCol.append(fList);
      compareBody.append(commitsCol, filesCol);

      // Update footer
      mergeStatsChip.textContent = `${commits.length} commit${commits.length === 1 ? "" : "s"} · ${files.length} file${files.length === 1 ? "" : "s"} · ${mergeState.source} → ${mergeState.target}`;
      mergeBtn.disabled = !commits.length;
      createMrBtn.disabled = !commits.length;
    }

    // Perform the merge — opens the existing Commit Progress modal so the
    // user sees a single uniform "operation in flight" UX for both flows.
    async function doMerge() {
      if (!mergeState.repo || !mergeState.source || !mergeState.target) return;
      const c = await confirmDialog({
        title: "Merge branches?",
        message: `Merge ${mergeState.source} into ${mergeState.target} in ${repoName(mergeState.repo)}? This creates a merge commit on ${mergeState.target}.`,
        confirmLabel: "Merge",
      });
      if (!c) return;
      mergeBtn.disabled = true; createMrBtn.disabled = true;
      mergeBtn.innerHTML = `${icon("spinner", 13, "spin")}<span style="margin-left:6px">Merging…</span>`;
      try {
        const r = await atom.git.mergeBranches(mergeState.repo, mergeState.source, mergeState.target, `Merge ${mergeState.source} into ${mergeState.target}`);
        await refreshGit(); refreshTree(true);
        if (r.state === "conflict" || r.conflict) {
          closeModal(modal);
          toast(`<b>Merge needs your help: ${esc(mergeState.source)} → ${esc(mergeState.target)}</b><span class="toast-sub">Resolve each conflict, then complete the merge.</span>`, "alert", { ms: 6000 });
          openConflictResolver(mergeState.repo);
        } else if (r.ok) {
          toast(`Merged ${esc(mergeState.source)} → ${esc(mergeState.target)} (${r.upToDate ? "already up to date" : r.fastForward ? "fast-forward" : "merge commit"})`, "checkCircle", { ms: 3500 });
          closeModal(modal);
        } else toast("Merge failed: " + esc(r.error || r.output || r.state), "alert", { ms: 6000 });
      } catch (e) { toast("Merge failed: " + esc(e.message), "alert", { ms: 6000 }); }
      finally { mergeBtn.disabled = false; createMrBtn.disabled = false; mergeBtn.textContent = "Merge"; }
    }

    // Build a "compare" URL for GitHub / GitLab / Bitbucket and open it. Lets
    // teams that gate merges through code review jump straight into the right
    // page on the remote with both branches pre-filled.
    async function openAsMergeRequest() {
      if (!mergeState.repo) return;
      let url = "";
      try { const r = await atom.git.remoteUrl(mergeState.repo, "origin"); url = r.url || ""; } catch { /* */ }
      if (!url) { toast("No remote 'origin' configured for this repo", "alert"); return; }
      // Normalise common SSH form: git@host:user/repo.git → https://host/user/repo
      let web = url.replace(/\.git$/, "").replace(/^git@([^:]+):/, "https://$1/");
      const target = mergeState.target, source = mergeState.source;
      let final = "";
      if (/github\.com/.test(web)) final = `${web}/compare/${encodeURIComponent(target)}...${encodeURIComponent(source)}?expand=1`;
      else if (/gitlab/.test(web)) final = `${web}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(source)}&merge_request[target_branch]=${encodeURIComponent(target)}`;
      else if (/bitbucket/.test(web)) final = `${web}/pull-requests/new?source=${encodeURIComponent(source)}&dest=${encodeURIComponent(target)}`;
      else final = `${web}/compare/${encodeURIComponent(target)}...${encodeURIComponent(source)}`;
      atom.shell.openExternal(final).catch(() => {});
      toast("Opening merge request page in your browser…", "external");
    }

    // Expose to outer scope so the footer buttons can call them.
    mergeView._doMerge = doMerge;
    mergeView._openMr = openAsMergeRequest;
  }
  function doMerge() { if (mergeView._doMerge) mergeView._doMerge(); }
  function openAsMergeRequest() { if (mergeView._openMr) mergeView._openMr(); }

  // Re-render everything that depends on selection / messages.
  function redraw() {
    filesList.innerHTML = "";
    let totalFiles = 0, selFiles = 0;
    for (const repo of repos) {
      const files = repoFiles(repo).slice().sort((a, b) => a.path.localeCompare(b.path));
      if (!files.length) continue;
      const selInRepo = files.filter((f) => isSel(repo, f.path)).length;
      const eligibleInRepo = files.filter((f) => !f.conflict).length;
      totalFiles += files.length;
      selFiles += selInRepo;
      const isCollapsed = collapsed.has(repo);

      // Project-level tri-state checkbox — like the old git panel, lets you
      // toggle every file in the repo with one click. `indeterminate` fires
      // when only some files in the repo are picked.
      const repoCb = h("input", { type: "checkbox" });
      repoCb.checked = eligibleInRepo > 0 && selInRepo === eligibleInRepo;
      repoCb.indeterminate = selInRepo > 0 && selInRepo < eligibleInRepo;
      repoCb.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const on = ev.target.checked;
        for (const f of files) if (!f.conflict) setSel(repo, f.path, on);
        redraw();
      });

      const status = state.git.statuses[repo] || {};
      const branchStr = status.branch || "(detached)";
      const aheadBehind = (status.ahead ? `↑${status.ahead}` : "") + (status.behind ? `↓${status.behind}` : "");

      const caret = h("span", { class: "cm-repo-caret" + (isCollapsed ? " collapsed" : ""), html: icon("chevronDown", 12) });

      const stageAllBtn = h("button", { class: "cm-mini-btn", title: "Stage all files in this project", onclick: async (ev) => {
        ev.stopPropagation();
        try { await atom.git.stageAll(repo); await refreshGit(); redraw(); }
        catch (e) { toast("Stage all failed: " + e.message, "alert"); }
      } }, "Stage all");
      const unstageBtn = h("button", { class: "cm-mini-btn", title: "Unstage all files in this project", onclick: async (ev) => {
        ev.stopPropagation();
        try { await atom.git.unstageAll(repo); await refreshGit(); redraw(); }
        catch (e) { toast("Unstage failed: " + e.message, "alert"); }
      } }, "Unstage");

      const repoHead = h("div", { class: "cm-repo-head" + (isCollapsed ? " collapsed" : ""), onclick: (ev) => {
        // Click anywhere except the checkbox or action buttons toggles collapse.
        if (ev.target.tagName === "INPUT" || ev.target.closest(".cm-mini-btn")) return;
        if (isCollapsed) collapsed.delete(repo); else collapsed.add(repo);
        redraw();
      } },
        caret,
        repoCb,
        h("span", { class: "cm-repo-ic", html: icon("branch", 13) }),
        h("span", { class: "cm-repo-name", text: repoName(repo) }),
        h("span", { class: "cm-repo-branch", text: branchStr }),
        aheadBehind ? h("span", { class: "cm-repo-ab", text: aheadBehind }) : null,
        h("span", { class: "cm-repo-spacer" }),
        h("span", { class: "cm-repo-count", text: `${selInRepo}/${files.length}` }),
        stageAllBtn,
        unstageBtn);
      filesList.append(repoHead);

      if (isCollapsed) continue;

      for (const f of files) {
        const fm = fileMeta(baseName(f.path));
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
        const sel = isSel(repo, f.path);
        const stat = (f.label || "").trim();
        const statCls = stat === "Untracked" ? "untracked" : stat === "Deleted" ? "deleted" : stat === "Added" ? "added" : "modified";
        const cb = h("input", { type: "checkbox" });
        cb.checked = sel; cb.disabled = !!f.conflict;
        cb.addEventListener("click", (ev) => { ev.stopPropagation(); setSel(repo, f.path, cb.checked); redraw(); });
        const row = h("div", {
          class: "cm-file" + (sel ? " sel" : "") + (f.conflict ? " conflict" : "") + (activeFilePath === f.path ? " active" : ""),
          onclick: () => showDiff(repo, f),
          oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); gitFileMenu(e, repo, f); },
        },
          cb,
          h("span", { class: "cm-file-ic " + fm.cls, html: icon(fm.ic, 14) }),
          h("span", { class: "cm-file-name " + fm.cls, text: baseName(f.path) }),
          dir ? h("span", { class: "cm-file-dir", text: dir }) : null,
          h("span", { class: "cm-file-stat " + statCls, text: stat || "M" }));
        filesList.append(row);
      }
    }
    summaryEl.textContent = `${selFiles}/${totalFiles} file${totalFiles === 1 ? "" : "s"} selected`;
    selectAllRow.querySelector("input").checked = selFiles === totalFiles && totalFiles > 0;
    selectAllRow.querySelector("input").indeterminate = selFiles > 0 && selFiles < totalFiles;
    statsChip.textContent = `${selFiles} file${selFiles === 1 ? "" : "s"} ready to commit`;
    updateButtons();
  }

  function updateButtons() {
    const selFiles = repos.reduce((n, r) => n + repoFiles(r).filter((f) => isSel(r, f.path)).length, 0);
    const ready = !!msg.value.trim() && selFiles > 0;
    commitBtn.disabled = !ready;
    commitPushBtn.disabled = !ready;
  }

  // Show the unified diff for one file in the right pane, with line-level
  // colour for added / removed / hunk-header lines. Reuses parseUnifiedDiff
  // so the rendering matches the inline diff view.
  async function showDiff(repo, f) {
    activeFilePath = f.path;
    // Spotlight the active row in the list without a full redraw.
    for (const row of filesList.querySelectorAll(".cm-file.active")) row.classList.remove("active");
    const all = filesList.querySelectorAll(".cm-file");
    for (const row of all) {
      if (row.querySelector(".cm-file-name") && row.querySelector(".cm-file-name").textContent === baseName(f.path)) row.classList.add("active");
    }
    rightPane.innerHTML = "";
    const fm = fileMeta(baseName(f.path));
    rightPane.append(h("div", { class: "cm-diff-head" },
      h("span", { class: "cm-diff-ic " + fm.cls, html: icon(fm.ic, 14) }),
      h("span", { class: "cm-diff-name " + fm.cls, text: baseName(f.path) }),
      h("span", { class: "cm-diff-path", text: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "" }),
      h("div", { class: "spacer" }),
      h("button", { class: "btn btn-ghost btn-sm", title: "Open full diff view", onclick: () => { closeModal(modal); openDiff(repo, f); } }, h("span", { html: icon("external", 12) }), h("span", { text: "Open" }))));
    const loading = h("div", { class: "cm-diff-loading" }, h("span", { html: icon("spinner", 18, "spin") }), h("span", { text: "Loading diff…" }));
    rightPane.append(loading);
    let res;
    try { res = await atom.git.fileDiff(repo, f.path); }
    catch (e) { res = { text: "", error: e.message }; }
    if (activeFilePath !== f.path) return;   // user moved on to another file mid-load
    loading.remove();
    if (res.error || !res.text || !res.text.trim()) {
      rightPane.append(h("div", { class: "cm-diff-empty cm-diff-empty-small" }, h("span", { text: res.error || (f.label === "Untracked" ? "New file — no prior version to compare" : "No textual diff available") })));
      return;
    }
    const parsed = parseUnifiedDiff(res.text);
    const statRow = h("div", { class: "cm-diff-stat" },
      h("span", { class: "ds-add", text: `+${parsed.adds}` }),
      h("span", { class: "ds-del", text: `−${parsed.dels}` }),
      parsed.binary ? h("span", { class: "ds-bin", text: "binary" }) : null);
    rightPane.append(statRow);
    if (parsed.binary) return;
    const pre = h("pre", { class: "cm-diff-body" });
    const lines = res.text.split("\n");
    let html = "";
    for (const ln of lines) {
      let cls = "";
      if (ln.startsWith("@@")) cls = "diff-hunk";
      else if (ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff ") || ln.startsWith("index ")) cls = "diff-meta";
      else if (ln.startsWith("+")) cls = "diff-add";
      else if (ln.startsWith("-")) cls = "diff-del";
      html += `<span class="${cls}">${esc(ln)}</span>\n`;
    }
    pre.innerHTML = html;
    rightPane.append(pre);
  }

  async function doCommit() { await runCommitFromModal(false); }
  async function doCommitPush() { await runCommitFromModal(true); }
  async function runCommitFromModal(push) {
    state.git.message = msg.value;
    const message = (msg.value || "").trim();
    if (!message) { toast("Enter a commit message", "alert"); return; }
    // Build the per-repo plan from the current selection.
    const plan = [];
    for (const repo of repos) {
      const sel = repoFiles(repo).filter((f) => isSel(repo, f.path));
      if (sel.length) plan.push({ repo, files: sel.map((f) => f.path) });
    }
    if (!plan.length) { toast("Tick at least one file", "alert"); return; }
    // Close the review modal first so the progress modal isn't underneath it.
    closeModal(modal);
    await openCommitProgressModal(plan, message, push);
  }

  // Auto-focus the most recently changed file's diff for instant context.
  redraw();
  const first = repos[0] && repoFiles(repos[0]).filter((f) => isSel(repos[0], f.path))[0];
  if (first) showDiff(repos[0], first);
  setTimeout(() => msg.focus(), 60);
}
// Live progress modal — runs the commit pipeline (commit → optional push) against
// each project and renders a row per repo with the current phase, branch, file
// count, and a spinner / check / cross. Closes automatically when everything
// finishes successfully; otherwise leaves the modal open so the user can read the
// errors and retry.
//
// Phases are recorded PER ROW: `plan.committed` holds the created commit id, so a
// retry after "commit ok, push failed" resumes at the push of that exact commit —
// it never re-stages or re-commits (which could create a second, unintended commit).
export async function openCommitProgressModal(plan, message, push) {
  const body = h("div", { class: "commit-progress" });
  const headLine = h("div", { class: "cp-headline" }, h("span", { class: "cp-spin", html: icon("spinner", 14, "spin") }), h("span", { text: push ? "Committing & pushing…" : "Committing…" }));
  const rowsHost = h("div", { class: "cp-rows" });
  body.append(headLine, rowsHost);

  // Pre-render one row per repo in pending state.
  const state2 = plan.map((p) => {
    const status = state.git.statuses[p.repo] || {};
    const r = { plan: p, branch: p.branch || status.branch || "(detached)", phase: "pending", message: "", ok: null, failedPhase: "" };
    r.dom = h("div", { class: "cp-row pending" },
      h("span", { class: "cp-row-ic", html: icon("dot", 14) }),
      h("div", { class: "cp-row-body" },
        h("div", { class: "cp-row-head" },
          h("span", { class: "cp-row-name", text: repoName(p.repo) }),
          h("span", { class: "cp-row-branch", html: icon("branch", 10) + ` <span>${esc(r.branch)}</span>` }),
          h("span", { class: "cp-row-count", text: p.committed ? `committed ${String(p.committed).slice(0, 7)}` : `${p.files.length} file${p.files.length === 1 ? "" : "s"}` })),
        h("div", { class: "cp-row-phase", text: "Waiting…" })));
    rowsHost.append(r.dom);
    return r;
  });

  const closeBtn = h("button", { class: "btn btn-ghost", text: "Hide", onclick: () => closeModal(modal) });
  const retryBtn = h("button", { class: "btn btn-primary", text: "Retry failed", onclick: () => {
    // Only re-run the rows that failed — and only their UNFINISHED phases (the plan
    // objects carry `committed`, so a push-only failure retries the push alone).
    closeModal(modal);
    const failed = state2.filter((r) => r.ok === false).map((r) => r.plan);
    if (failed.length) openCommitProgressModal(failed, message, push);
  } });
  retryBtn.style.display = "none";
  const footer = h("div", { class: "cp-foot" }, h("div", { class: "spacer" }), retryBtn, closeBtn);

  const modal = modalShell({ title: push ? "Commit & Push" : "Commit", ic: "commit", body, footer });

  function setPhase(r, phase, message, ok) {
    r.phase = phase; r.message = message || "";
    r.dom.className = "cp-row " + phase;
    const ic = r.dom.querySelector(".cp-row-ic");
    ic.innerHTML = phase === "doing" ? icon("spinner", 14, "spin")
                 : phase === "ok"     ? icon("check", 14)
                 : phase === "error"  ? icon("x", 14)
                 : icon("dot", 14);
    r.dom.querySelector(".cp-row-phase").textContent = message || "";
    if (ok === true || ok === false) r.ok = ok;
  }

  // Run sequentially so the user sees a clear order of operations.
  let okCount = 0, errCount = 0, committedNotPushed = 0;
  for (const r of state2) {
    const p = r.plan;
    try {
      if (!p.committed) {
        setPhase(r, "doing", `Committing ${p.files.length} file${p.files.length === 1 ? "" : "s"} on ${r.branch}…`);
        const res = await atom.git.commitFiles(p.repo, message, p.files);   // reviewed CommitPlan: exactly these files
        if (!res || res.committed === false) throw Object.assign(new Error((res && res.error) || "commit failed"), { phase: "commit" });
        p.committed = res.commit || "HEAD"; p.branch = res.branch || r.branch; r.branch = p.branch;
        if (res.state === "partial") toast(`<b>${esc(repoName(p.repo))}: committed, index not fully reconciled</b><span class="toast-sub">${esc(res.reconcileError || "")}</span>`, "alert", { ms: 7000 });
      }
      const short = String(p.committed).slice(0, 7);
      if (push) {
        // Resume/run the push of the RECORDED commit: the branch must still be the one it was made on.
        setPhase(r, "doing", `Pushing ${r.branch} (${short})…`);
        let cur = "";
        try { cur = await atom.git.branch(p.repo); } catch { /* checked by git below */ }
        if (cur && p.branch && cur !== p.branch) throw Object.assign(new Error(`branch changed since the commit (now on ${cur}) — push ${p.branch} from the Git Center`), { phase: "push" });
        const pushRes = await atom.git.push(p.repo).catch((e) => { throw Object.assign(new Error("push: " + e.message), { phase: "push" }); });
        if (pushRes && pushRes.state === "rejected") throw Object.assign(new Error(`push rejected by ${pushRes.remote || "the remote"} — pull first`), { phase: "push" });
        if (pushRes && pushRes.ok === false) throw Object.assign(new Error("push: " + (pushRes.error || pushRes.state)), { phase: "push" });
        p.pushed = true;
        const dest = pushRes && pushRes.remote && pushRes.dest ? `${pushRes.remote}/${pushRes.dest}` : (p.branch || r.branch);
        setPhase(r, "ok", pushRes && pushRes.upToDate ? `Committed ${short} · already up to date on ${dest}` : `Committed ${short} & pushed → ${dest}`, true);
      } else {
        setPhase(r, "ok", `Committed ${short} → ${p.branch || r.branch}`, true);
      }
      okCount++;
    } catch (e) {
      const phase = e.phase || (r.plan.committed ? "push" : "commit");
      r.failedPhase = phase;
      if (phase === "push") committedNotPushed++;
      setPhase(r, "error", phase === "push" ? `Committed ${String(r.plan.committed).slice(0, 7)} — push failed: ${e.message || e}` : `Commit failed: ${e.message || e}`, false);
      errCount++;
    }
  }

  // Final headline + auto-dismiss on clean run. Partial success is stated as such.
  const headIc = headLine.querySelector(".cp-spin");
  if (errCount === 0) {
    headIc.innerHTML = icon("check", 14);
    headLine.querySelector("span:last-child").textContent = `Done · ${okCount} project${okCount === 1 ? "" : "s"} ${push ? "committed & pushed" : "committed"}`;
    headLine.classList.add("ok");
    setTimeout(() => { closeModal(modal); refreshGit(); refreshTree(true); }, 1100);
  } else {
    headIc.innerHTML = icon("alert", 14);
    headLine.querySelector("span:last-child").textContent = `${okCount} done · ${errCount} failed${committedNotPushed ? ` (${committedNotPushed} committed but not pushed — Retry pushes only)` : ""}`;
    headLine.classList.add("error");
    retryBtn.style.display = "";
    retryBtn.textContent = committedNotPushed && committedNotPushed === errCount ? "Retry push" : "Retry failed";
    closeBtn.textContent = "Close";
    refreshGit();
  }
}
export async function commitSelected(push) {
  const message = (state.git.message || "").trim();
  if (!message) { toast("Enter a commit message first", "alert"); return; }
  let groups = selectionByRepo();
  if (!groups.length) {
    const dirty = (state.git.repos || []).filter((r) => { const s = state.git.statuses[r]; return s && s.files && s.files.length; });
    if (dirty.length === 1) groups = [{ repo: dirty[0], files: repoFiles(dirty[0]).map((f) => f.path) }];
    else { toast("Tick the files (or a folder) you want to commit", "alert"); return; }
  }
  // EVERY repository's result is kept for the summary — a later success never hides an
  // earlier failure. Commits go through the reviewed CommitPlan (exactly these files).
  const results = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    toast(`Committing ${esc(repoName(g.repo))}…  (${i + 1}/${groups.length})`, "commit", { sticky: true, spin: true });
    try { const r = await atom.git.commitFiles(g.repo, message, g.files); results.push(r && r.committed === false ? { repo: g.repo, ok: false, error: r.error || "commit failed" } : { repo: g.repo, ok: true, branch: r.branch, commit: r.commit, partial: r.state === "partial" }); }
    catch (e) { results.push({ repo: g.repo, ok: false, error: e.message }); }
  }
  const committed = results.filter((r) => r.ok);
  if (!committed.length) { summaryToast("Committed", results); await refreshGit(); return; }
  if (push) {
    const pushed = await pushReposList(committed.map((c) => c.repo), { verb: "Committed & pushed" });
    const failedCommits = results.filter((r) => !r.ok);
    if (failedCommits.length) toast(`<b>${failedCommits.length} commit${failedCommits.length === 1 ? "" : "s"} failed</b><span class="toast-sub">${failedCommits.map((r) => esc(repoName(r.repo)) + ": " + esc(r.error)).join("<br>")}${pushed.some((p) => p.ok) ? "<br>(other repositories were committed and pushed)" : ""}</span>`, "alert", { ms: 8000 });
  } else summaryToast("Committed", results);
  // The commit message is kept until you change it (per request).
  await refreshGit(); refreshTree(true);
}
export function gitFileRow(repo, f) {
  const statClass = f.conflict ? "conflict" : (f.label === "Untracked" ? "untracked" : (f.staged ? "staged" : "unstaged"));
  const ext = (f.path.split(".").pop() || "").toLowerCase();
  const cb = h("input", { type: "checkbox", class: "aqx-check" });
  // Checkbox = SELECTION (for the next commit), not an immediate stage. Staging
  // happens when Commit / Commit & Push runs.
  cb.checked = isSel(repo, f.path);
  cb.addEventListener("click", (ev) => { ev.stopPropagation(); setSel(repo, f.path, cb.checked); afterGitSelectionChange(); });
  const slash = f.path.lastIndexOf("/");
  const dir = slash >= 0 ? f.path.slice(0, slash) : "";
  return h("div", { class: "gv-file" + (isSel(repo, f.path) ? " sel" : "") + (f.conflict ? " conflict" : ""), title: (f.conflict ? "Resolve conflicts · " : "View diff · ") + f.path, onclick: () => f.conflict ? openConflictResolver(repo, f.path) : openDiff(repo, f), oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); gitFileMenu(e, repo, f); } },
    cb,
    (function(){const m=fileMeta(baseName(f.path));return h("span",{class:"gvf-ico "+m.cls,html:icon(m.ic,14)});})(),
    h("span", { class: "gvf-name", text: baseName(f.path) }),
    h("span", { class: "gvf-path", text: dir }),
    h("span", { class: "gvf-stat " + statClass, text: f.label }));
}
/* ---- commit-view right-click actions (stage / unstage / discard / rollback) ----
   The checkbox is SELECTION; these menu actions touch the git index/working tree
   directly (real stage/unstage), and "Discard" rolls a file back to HEAD. */
export async function gitStageFiles(repo, paths) {
  const list = [].concat(paths).filter(Boolean);
  if (!list.length) return;
  try { await atom.git.stage(repo, list); await refreshGit(); }
  catch (e) { toast("Stage failed: " + esc(e.message), "alert", { ms: 5000 }); }
}
export async function gitUnstageFiles(repo, paths) {
  const list = [].concat(paths).filter(Boolean);
  if (!list.length) return;
  try { await atom.git.unstage(repo, list); await refreshGit(); }
  catch (e) { toast("Unstage failed: " + esc(e.message), "alert", { ms: 5000 }); }
}
export async function gitStageAllRepo(repo) {
  try { await atom.git.stageAll(repo); await refreshGit(); }
  catch (e) { toast("Stage failed: " + esc(e.message), "alert", { ms: 5000 }); }
}
export async function gitUnstageAllRepo(repo) {
  try { await atom.git.unstageAll(repo); await refreshGit(); }
  catch (e) { toast("Unstage failed: " + esc(e.message), "alert", { ms: 5000 }); }
}
// Discard (rollback) — destructive, so confirm first. Drops selection for the
// reverted files and refreshes both the commit view and the file tree.
export function gitDiscardFiles(repo, paths, what) {
  const list = [].concat(paths).filter(Boolean);
  if (!list.length) return;
  const label = what || (list.length === 1 ? baseName(list[0]) : `${list.length} files`);
  confirmDialog({
    title: "Discard changes?", ic: "alert", danger: true, confirmLabel: "Discard changes",
    message: `This reverts ${label} to the last committed state and deletes any untracked content. This can’t be undone.`,
    onConfirm: async () => {
      try {
        // Per-path phase outcomes: a failed prerequisite stops that path; partial work is
        // reported as partial, never as complete success.
        const r = await atom.git.discard(repo, list);
        const failed = (r && r.results || []).filter((x) => !x.ok);
        for (const p of list) if (!failed.some((x) => x.path === p)) setSel(repo, p, false);
        if (r && r.ok) toast(`Discarded changes in ${esc(label)}`, "undo", { ms: 3000 });
        else toast(`<b>Discard ${r && r.state === "partial" ? "partly done" : "failed"}</b><span class="toast-sub">${failed.map((x) => `${esc(x.path)} (${esc(x.phase || "")}): ${esc(x.error || "failed")}`).join("<br>") || esc((r && r.error) || "")}</span>`, "alert", { ms: 8000 });
        await refreshGit(); refreshTree(true);
      } catch (e) { toast("Discard failed: " + esc(e.message), "alert", { ms: 6000 }); }
    },
  });
}
// Right-click menu for a single changed file in the commit view.
export function gitFileMenu(ev, repo, f) {
  const abs = repo.replace(/[\\/]+$/, "") + "/" + f.path;
  const selected = isSel(repo, f.path);
  const untracked = f.label === "Untracked";
  const items = [];
  if (f.conflict) items.push({ label: "Resolve conflicts", icon: "git", onClick: () => openConflictResolver(repo, f.path) });
  else items.push({ label: "View diff", icon: "eye", onClick: () => openDiff(repo, f) });
  items.push({ label: "Open file", icon: "external", onClick: () => openInEditor(abs) });
  items.push({ sep: true });
  items.push({ label: selected ? "Deselect for commit" : "Select for commit", icon: selected ? "minus" : "check", onClick: () => { setSel(repo, f.path, !selected); afterGitSelectionChange(); } });
  if (f.unstaged || untracked) items.push({ label: "Stage", icon: "plus", onClick: () => gitStageFiles(repo, [f.path]) });
  if (f.staged) items.push({ label: "Unstage", icon: "minus", onClick: () => gitUnstageFiles(repo, [f.path]) });
  items.push({ sep: true });
  items.push({ label: "Copy path", icon: "copy", onClick: () => copyText(f.path, "Copied relative path") });
  items.push({ label: "Copy full path", icon: "copy", onClick: () => copyText('"' + abs + '"', "Copied full path") });
  items.push({ label: "Reveal in Explorer", icon: "folderOpen", onClick: () => atom.files.reveal(abs) });
  items.push({ sep: true });
  items.push({ label: untracked ? "Delete file" : "Discard changes", icon: untracked ? "trash" : "undo", danger: true, onClick: () => gitDiscardFiles(repo, [f.path], baseName(f.path)) });
  showContextMenu(ev.clientX, ev.clientY, items);
}
// Right-click menu for a project group header in the commit view.
export function gitRepoMenu(ev, repo, tracked, untracked) {
  const s = state.git.statuses[repo] || {};
  const allPaths = (s.files || []).map((f) => f.path);
  const trackedList = tracked || [];
  const hasStaged = (s.files || []).some((f) => f.staged);
  const items = [
    { label: "Stage all changes", icon: "plus", onClick: () => gitStageAllRepo(repo) },
  ];
  if (hasStaged) items.push({ label: "Unstage all", icon: "minus", onClick: () => gitUnstageAllRepo(repo) });
  items.push(
    { sep: true },
    { label: "Select all for commit", icon: "check", onClick: () => setRepoSelection(repo, trackedList, true) },
    { label: "Clear selection", icon: "x", onClick: () => setRepoSelection(repo, trackedList, false) },
    { sep: true },
    { label: "Branches…", icon: "branch", onClick: () => openBranchMenu(repo, ev) },
    { label: "Compare & merge…", icon: "gitCompare", onClick: () => openCompare(repo) },
    { sep: true },
    { label: "Pull", icon: "pull", onClick: () => gitPull(repo) },
  );
  if (gitPushable(repo)) items.push({ label: "Push", icon: "push", onClick: () => pushRepo(repo).then(() => refreshGit()) });
  items.push(
    { sep: true },
    { label: "Reveal in Explorer", icon: "folderOpen", onClick: () => atom.files.reveal(repo) },
    { label: "Refresh", icon: "refresh", onClick: () => refreshGit() },
  );
  if (allPaths.length) items.push({ sep: true }, { label: "Discard all changes", icon: "undo", danger: true, onClick: () => gitDiscardFiles(repo, allPaths, `all changes in ${repoName(repo)}`) });
  showContextMenu(ev.clientX, ev.clientY, items);
}
// Build the persistent commit-view shell once (so the message box keeps focus +
// text across status refreshes); only the file list is re-rendered on refresh.
export function buildGitShell() {
  const view = h("div", { class: "git-view" });
  view.append(h("div", { class: "gv-head" },
    h("div", { class: "gv-head-actions" },
      h("button", { id: "gvBranch", class: "gv-iconbtn", title: "Branches", html: icon("branch", 15), onclick: (e) => openBranchFlow(e) }),
      h("button", { id: "gvCompare", class: "gv-iconbtn", title: "Compare & merge branches", html: icon("gitCompare", 15), onclick: (e) => openCompareFlow(e) }),
      h("button", { id: "gvPull", class: "gv-iconbtn", title: "Pull all projects", html: icon("pull", 15), onclick: () => pullAll() }),
      h("button", { class: "gv-iconbtn", title: "Refresh", html: icon("refresh", 15), onclick: () => refreshGit() })),
    h("div", { class: "gv-branch" }, h("span", { html: icon("git", 15) }), h("span", { class: "gvb-name", text: "Commit" }), h("span", { class: "gvh-count gv-track" }))));
  const msg = h("textarea", { id: "gvMessage", placeholder: "Commit message", spellcheck: "false" });
  msg.value = state.git.message || "";
  msg.addEventListener("input", () => { state.git.message = msg.value; });
  view.append(h("div", { class: "gv-msg" }, msg));
  view.append(h("div", { class: "gv-actions" },
    h("button", { id: "gvCommit", class: "btn btn-primary", text: "Commit…", onclick: () => openCommitModal(false) }),
    h("button", { id: "gvCommitPush", class: "btn btn-ghost", text: "Commit & Push…", onclick: () => openCommitModal(true) })));
  view.append(h("div", { class: "gv-list" }));
  return view;
}
export function renderGitView() {
  const host = $("fileTree");
  if (!host) return;
  let view = host.querySelector(".git-view");
  if (!view) { host.innerHTML = ""; view = buildGitShell(); host.append(view); }
  const total = gitTotalChanges();
  const repos = state.git.repos || [];
  const cnt = view.querySelector(".gvh-count");
  if (cnt) cnt.textContent = total ? `${total} change${total > 1 ? "s" : ""}` : (repos.length ? "clean" : "");
  // Header shows the current branch (when all repos share one); else "Commit"
  // and each accordion shows its own branch.
  const nameEl = view.querySelector(".gvb-name");
  if (nameEl) {
    const branches = [...new Set(repos.map((r) => gitBranchOf(r)).filter(Boolean))];
    nameEl.textContent = branches.length === 1 ? branches[0] : "Commit";
    nameEl.title = branches.length === 1 ? "Current branch: " + branches[0] : "";
  }
  // Commit buttons reflect how many files are selected for the next commit.
  const sel = totalSelected();
  const cBtn = view.querySelector("#gvCommit"); if (cBtn) cBtn.textContent = sel ? `Commit (${sel})` : "Commit";
  const cpBtn = view.querySelector("#gvCommitPush"); if (cpBtn) cpBtn.textContent = sel ? `Commit & Push (${sel})` : "Commit & Push";
  const pullBtn = view.querySelector("#gvPull");
  const behind = repos.filter((r) => { const s = state.git.statuses[r]; return s && s.behind; }).length;
  if (pullBtn) pullBtn.classList.toggle("hot", behind > 0);
  renderGitGroups(view.querySelector(".gv-list"));
}
// One group per repo (project folder): a folder checkbox/Stage all/Unstage row,
// then its tracked changes, then a separate Untracked subsection.
export function renderGitGroups(list) {
  if (!list) return;
  list.innerHTML = "";
  const repos = state.git.repos || [];
  if (!repos.length) { list.append(h("div", { class: "gv-empty" }, h("span", { html: icon("branch", 32) }), "No Git repository in this folder or its subfolders.")); return; }
  // ---- Merge-in-progress banner: any repo with conflicts gets a clear call to resolve ----
  for (const repo of repos) {
    const conflicts = conflictedFiles(repo);
    if (!conflicts.length) continue;
    list.append(h("div", { class: "gv-merge-banner" },
      h("div", { class: "gmb-head" },
        h("span", { class: "gmb-ic", html: icon("alert", 16) }),
        h("div", { class: "gmb-head-text" },
          h("span", { class: "gmb-title", text: "Merge in progress" }),
          h("span", { class: "gmb-repo", text: repoName(repo) }))),
      h("div", { class: "gmb-sub" },
        h("b", { text: `${conflicts.length} conflicted file${conflicts.length === 1 ? "" : "s"}` }),
        " — resolve them, then complete the merge."),
      h("div", { class: "gmb-actions" },
        h("button", { class: "gmb-btn primary", onclick: () => openConflictResolver(repo) },
          h("span", { class: "gmb-btn-ic", html: icon("git", 14) }), "Resolve conflicts"),
        h("button", { class: "gmb-btn", onclick: () => gitMergeAbort(repo) }, "Abort"))));
  }
  let anyTracked = false;
  const untrackedByRepo = [];   // [{ repo, files }] — gathered for the separate accordion
  // ---- Tracked changes: one accordion per project folder (untracked excluded) ----
  for (const repo of repos) {
    const s = state.git.statuses[repo];
    if (!s || !s.repo || !s.files) continue;
    // Status could not be read: say so (with the error and a retry) instead of showing "clean".
    if (s.state === "error") list.append(h("div", { class: "gv-merge-banner gv-status-error" },
      h("div", { class: "gmb-head" }, h("span", { class: "gmb-ic", html: icon("alert", 16) }), h("div", { class: "gmb-head-text" }, h("span", { class: "gmb-title", text: s.stale ? "Showing the last known state" : "Repository state unavailable" }), h("span", { class: "gmb-repo", text: repoName(repo) }))),
      h("div", { class: "gmb-sub" }, h("span", { text: s.error || "git status failed" })),
      h("div", { class: "gmb-actions" }, h("button", { class: "gmb-btn primary", onclick: () => refreshGit() }, "Retry"))));
    const tracked = s.files.filter((f) => f.label !== "Untracked");
    const untracked = s.files.filter((f) => f.label === "Untracked");
    if (untracked.length) untrackedByRepo.push({ repo, files: untracked });
    if (!tracked.length) continue;
    anyTracked = true;
    const allSel = tracked.every((f) => isSel(repo, f.path));
    const someSel = tracked.some((f) => isSel(repo, f.path));
    const open = state.git.expanded.has(repo);   // collapsed by default
    const folderCb = h("input", { type: "checkbox", class: "aqx-check" });
    folderCb.checked = allSel; folderCb.indeterminate = someSel && !allSel;
    // Folder checkbox SELECTS/deselects this folder's tracked changes for commit.
    folderCb.addEventListener("click", (ev) => { ev.stopPropagation(); setRepoSelection(repo, tracked, folderCb.checked); });
    const rowKids = [
      h("span", { class: "gvr-chev", html: icon("chevron", 13) }),
      folderCb,
      h("span", { class: "gvf-ico", html: icon("branch", 14) }),
      h("span", { class: "gvr-name", text: repoName(repo) }),
      h("button", { class: "gvr-branch", title: "Branches & merge — " + (s.branch || ""), onclick: (e) => { e.stopPropagation(); openBranchMenu(repo, e); } },
        h("span", { class: "gvrb-ico", html: icon("branch", 11) }),
        h("span", { text: (s.branch || "") + (s.ahead ? ` ↑${s.ahead}` : "") + (s.behind ? ` ↓${s.behind}` : "") })),
      h("span", { class: "gvr-count", text: String(tracked.length) }),
      h("button", { class: "gvr-act", title: "Select all tracked changes in this folder", onclick: (e) => { e.stopPropagation(); setRepoSelection(repo, tracked, true); } }, "Select all"),
      h("button", { class: "gvr-act", title: "Clear this folder's selection", onclick: (e) => { e.stopPropagation(); setRepoSelection(repo, tracked, false); } }, "Clear"),
    ];
    // Per-project Push button when this folder has unpushed commits (spins while pushing).
    const busy = state.git.pushing.has(repo);
    if (gitPushable(repo) || busy) rowKids.push(h("button", { class: "gvr-push" + (busy ? " busy" : ""), disabled: busy, title: busy ? "Pushing " + repoName(repo) + "…" : "Push " + repoName(repo) + (s.branch ? " · " + s.branch : ""), html: icon(busy ? "spinner" : "push", 13, busy ? "spin" : ""), onclick: (e) => { e.stopPropagation(); if (!busy) pushRepo(repo).then(() => refreshGit()); } }));
    list.append(h("div", { class: "gv-repo" + (open ? " open" : ""), title: repo, onclick: () => toggleGitRepo(repo), oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); gitRepoMenu(e, repo, tracked, untracked); } }, ...rowKids));
    if (open) for (const f of tracked) list.append(gitFileRow(repo, f));
  }

  // ---- Untracked files: one top-level accordion, grouped by project. Tick them
  // to include them in the commit — they are staged automatically at commit time. ----
  const totalUntracked = untrackedByRepo.reduce((n, g) => n + g.files.length, 0);
  if (totalUntracked) {
    const open = state.git.expanded.has("__untracked__");
    const allU = untrackedByRepo.flatMap((g) => g.files.map((f) => ({ repo: g.repo, path: f.path })));
    const allUSel = allU.every((u) => isSel(u.repo, u.path));
    const someUSel = allU.some((u) => isSel(u.repo, u.path));
    const uCb = h("input", { type: "checkbox", class: "aqx-check" });
    uCb.checked = allUSel; uCb.indeterminate = someUSel && !allUSel;
    uCb.addEventListener("click", (ev) => { ev.stopPropagation(); for (const u of allU) setSel(u.repo, u.path, uCb.checked); afterGitSelectionChange(); });
    list.append(h("div", { class: "gv-repo gv-untracked" + (open ? " open" : ""), title: "Untracked files — tick to include them in the commit", onclick: () => toggleGitRepo("__untracked__") },
      h("span", { class: "gvr-chev", html: icon("chevron", 13) }),
      uCb,
      h("span", { class: "gvf-ico", html: icon("folderPlus", 14) }),
      h("span", { class: "gvr-name", text: "Untracked files" }),
      h("span", { class: "gvr-branch", text: "" }),
      h("span", { class: "gvr-count", text: String(totalUntracked) }),
      h("button", { class: "gvr-act", title: "Select all untracked files", onclick: (e) => { e.stopPropagation(); for (const u of allU) setSel(u.repo, u.path, true); afterGitSelectionChange(); } }, "Select all")));
    if (open) {
      for (const { repo, files } of untrackedByRepo) {
        list.append(h("div", { class: "gv-subsection" },
          h("span", { class: "gvf-ico", html: icon("branch", 12) }),
          h("span", { text: repoName(repo) }),
          h("span", { class: "gvs-count", text: String(files.length) }),
          h("span", { class: "gvs-act", onclick: (e) => { e.stopPropagation(); setRepoSelection(repo, files, true); } }, "Select all")));
        for (const f of files) list.append(gitFileRow(repo, f));
      }
    }
  }

  if (!anyTracked && !totalUntracked) list.append(h("div", { class: "gv-empty" }, h("span", { html: icon("check", 32) }), "Nothing to commit — all folders clean."));
}
// Expand/collapse a repo's accordion in the commit view.
export function toggleGitRepo(repo) {
  if (state.git.expanded.has(repo)) state.git.expanded.delete(repo);
  else state.git.expanded.add(repo);
  renderGitView();
}
