/* AtomNano renderer — Git Center — header, toolbar, operation banner, tabs, the compare bar and renderMain (draws the current tab).
 * One of the modules the former single gitcenter.js was split into (see git/center/index.js). */
import { act, confirmDanger, forAll, openResolver, prompt, syncMutationControls } from "./actions.js";
import { renderBranches, renderRemotes, renderStashes, renderTags } from "./branches.js";
import { renderChanges } from "./changes.js";
import { renderCompare } from "./compare.js";
import { renderHistory } from "./history.js";
import { doMerge, doNewBranch, doPush, doRebase, doReset, doStash, kindOf, pullPicker } from "./ops.js";
import { refreshRepo, selectRepo } from "./repos.js";
import { alive, conflicts, D, empty, errText, h, icon, isOpen, per, q, repoName, S, stat, statusOk, TABS } from "./state.js";
import { pickList } from "./widgets.js";

/* ============================ head: repo dropdown ============================ */
export function renderRepoDD() {
  const host = q(".gitc-repodd-host"); if (!host) return;
  host.innerHTML = "";
  const sub = q(".gitc-sub"); if (sub) sub.textContent = S.repo || (S.repos.length ? `${S.repos.length} repositories` : "");
  if (!S.repos.length) return;
  const s = stat(S.repo) || {};
  const n = (s.files || []).length, conf = conflicts(S.repo).length, bad = !!S.repo && !statusOk(S.repo);
  const btn = h("button", { class: "gitc-repodd" + (bad ? " error" : ""), title: "Switch repository", "aria-haspopup": "listbox", onclick: (e) => {
    const items = S.repos.map((r) => { const st2 = stat(r) || {}; const k = (st2.files || []).length; const err = st2.state === "error"; return { value: r, label: repoName(r), icon: err ? "alert" : "branch", hint: err ? "status unavailable" : st2.detached ? "detached HEAD" : st2.unborn ? `${st2.branch} (no commits yet)` : (st2.branch || ""), badge: k ? String(k) : "" }; });
    pickList(e.currentTarget, { items, value: S.repo, placeholder: "Search repositories…", width: 360, onPick: (r) => { if (r !== S.repo) selectRepo(r); } });
  } },
    h("span", { class: "gitc-repodd-ic", html: icon(bad ? "alert" : "branch", 14) }),
    h("span", { class: "gitc-repodd-name", text: repoName(S.repo) }),
    h("span", { class: "gitc-repodd-branch", text: s.detached ? "detached HEAD" : (s.branch || "") + (s.unborn ? " · no commits yet" : "") }),
    n ? h("span", { class: "gitc-badge" + (conf ? " danger" : ""), title: conf ? `${conf} conflicted` : `${n} changed files`, text: String(n) }) : null,
    s.ahead ? h("span", { class: "gitc-ab up", title: `${s.ahead} commit${s.ahead === 1 ? "" : "s"} to push` }, h("span", { html: icon("arrowUp", 10) }), String(s.ahead)) : null,
    s.behind ? h("span", { class: "gitc-ab down", title: `${s.behind} commit${s.behind === 1 ? "" : "s"} to pull` }, h("span", { html: icon("arrowUp", 10, "flip") }), String(s.behind)) : null,
    h("span", { class: "gitc-ref-caret", html: icon("chevronDown", 12) }));
  host.append(btn);
}
// Status state strip: error (no snapshot), stale (old snapshot shown), or hidden when ready.
export function renderStateBar() {
  const el = q(".gitc-state"); if (!el) return;
  const s = S.repo ? stat(S.repo) : null;
  el.innerHTML = ""; el.classList.remove("error", "stale");
  if (!s || s.state === "ready" || !S.repo) { el.classList.add("hidden"); syncMutationControls(); return; }
  el.classList.remove("hidden"); el.classList.add(s.stale ? "stale" : "error");
  el.append(h("span", { class: "gitc-state-ic", html: icon("alert", 14) }),
    h("b", { text: s.state === "notRepo" ? "Not a Git repository" : s.stale ? "Showing the last known state" : "Repository state unavailable" }),
    h("span", { text: s.stale ? `The latest status read failed (${s.error}). Changes are read-only until a refresh succeeds.` : (s.error || "git status failed") }),
    s.type ? h("code", { text: s.type }) : null,
    h("div", { class: "gitc-spacer" }),
    h("button", { class: "gitc-act sm primary", onclick: () => refreshRepo(S.repo) }, h("span", { html: icon("refresh", 13) }), "Retry"));
  syncMutationControls();
}

/* ============================ bar / banner / tabs ============================ */
export function refItems(cur) {
  const items = [];
  if (!S.info) return items;
  for (const b of S.info.locals) items.push({ value: b.name, label: b.name, icon: b.current ? "check" : "branch", group: "Local", hint: b.current ? "current" : (b.subject || "").slice(0, 40) });
  for (const b of S.info.remotes) items.push({ value: b.name, label: b.name, icon: "cloudDown", group: "Remote", hint: (b.subject || "").slice(0, 40) });
  for (const t of S.tg.list) items.push({ value: t.name, label: t.name, icon: "key", group: "Tags", hint: (t.subject || "").slice(0, 40) });
  return items.map((it) => ({ ...it, icon: it.value === cur ? "check" : it.icon }));
}
export function refButton(which) {
  const val = which === "source" ? S.source : S.target;
  return h("button", { class: "gitc-ref " + which, title: which === "source" ? "Source branch — the changes being merged / compared" : "Target branch — merged into (must be a local branch to merge)", "aria-label": `${which} branch: ${val || "none"}`, onclick: (e) => {
    const cur = which === "source" ? S.source : S.target;
    pickList(e.currentTarget, { items: refItems(cur), value: cur, placeholder: `Search ${which} branch…`, width: 360, onPick: (b) => { if (which === "source") S.source = b; else S.target = b; resetCompare(); renderBar(); renderCmpBar(); renderMain(); } });
  } },
    h("span", { class: "gitc-ref-ic", html: icon("branch", 12) }),
    h("span", { class: "gitc-ref-name", text: val || "—" }),
    h("span", { class: "gitc-ref-caret", html: icon("chevronDown", 12) }));
}
export function renderBar() {
  const bar = q(".gitc-bar"); if (!bar) return;
  bar.innerHTML = "";
  if (!S.repo) return;
  const repo = S.repo;
  const info = S.info || {}, cur = info.current || "";
  const s = stat(repo) || {};
  const inCmp = S.mode === "compare";
  bar.append(
    h("button", { class: "gitc-act mut", title: "Fetch all remotes (prune)", onclick: () => act("Fetch", () => D.atom.git.fetch(repo), { repo }) }, h("span", { html: icon("cloudDown", 14) }), "Fetch"),
    h("button", { class: "gitc-act mut" + (s.behind ? " hot" : ""), title: "Pull — pick the branch to pull from", "aria-haspopup": "listbox", onclick: (e) => pullPicker(e.currentTarget) }, h("span", { html: icon("pull", 14) }), "Pull", s.behind ? h("span", { class: "gitc-cnt", text: String(s.behind) }) : null, h("span", { class: "gitc-ref-caret", html: icon("chevronDown", 11) })),
    h("button", { class: "gitc-act mut pushbtn" + (s.ahead || (s.branch && !s.upstream && !s.detached && !s.unborn) ? " hot" : ""), disabled: !!info.unborn, title: info.unborn ? "Make the first commit before pushing" : s.ahead ? `Push ${s.ahead} commit${s.ahead === 1 ? "" : "s"} · right-click for more` : "Push the current branch · right-click for more", onclick: (e) => doPush({ repo, anchor: e.currentTarget }), oncontextmenu: (e) => { e.preventDefault(); D.showMenuAt(e, [{ label: "Push & set upstream…", icon: "cloudUp", onClick: () => doPush({ repo, setUpstream: true }) }, { label: "Force push (with lease)…", icon: "alert", danger: true, onClick: () => doPush({ repo, force: true }) }, { sep: true }, { label: "Push tags…", icon: "key", onClick: () => doPush({ repo, tags: true }) }]); } }, h("span", { html: icon("push", 14) }), "Push", s.ahead ? h("span", { class: "gitc-cnt", text: String(s.ahead) }) : null),
    h("button", { class: "gitc-act mut", title: "New branch from the current HEAD", onclick: () => doNewBranch("", repo) }, h("span", { html: icon("plus", 14) }), "Branch"),
    h("button", { class: "gitc-act mut stashbtn", title: "Stash local changes", onclick: (e) => doStash(e.currentTarget, repo) }, h("span", { html: icon("download", 14) }), "Stash"),
    h("button", { class: "gitc-act icon", title: "More…", "aria-label": "More actions", "aria-haspopup": "menu", html: icon("moreVert", 15), onclick: (e) => D.showMenuAt(e, [
      { label: "Push & set upstream…", icon: "cloudUp", onClick: () => doPush({ repo, setUpstream: true }) },
      { label: "Force push (with lease)…", icon: "alert", danger: true, onClick: () => doPush({ repo, force: true }) },
      { label: "Push tags…", icon: "key", onClick: () => doPush({ repo, tags: true }) },
      { sep: true },
      { label: "Cherry-pick commit by hash…", icon: "commit", onClick: async () => { const hsh = await prompt({ title: "Cherry-pick", ic: "commit", message: `Apply which commit onto “${cur}” in ${repoName(repo)}?`, placeholder: "commit hash", confirmLabel: "Cherry-pick" }); if (hsh && hsh.trim()) act(`Cherry-pick ${hsh.trim().slice(0, 7)}`, () => D.atom.git.cherryPick(repo, [hsh.trim()]), { repo }); } },
      { label: "Reset current branch to…", icon: "undo", onClick: async () => { const ref = await prompt({ title: "Reset to", ic: "undo", message: "Branch, tag or commit to reset the current branch to.", placeholder: "origin/main · HEAD~1 · a1b2c3d", confirmLabel: "Choose mode…" }); if (ref && ref.trim()) doReset(ref.trim(), repo); } },
      { sep: true },
      { label: "Fetch all repositories", icon: "cloudDown", onClick: () => forAll("Fetch", (r) => D.atom.git.fetch(r)) },
      { label: "Pull all repositories", icon: "pull", onClick: () => forAll("Pull", (r) => D.atom.git.pull(r)) },
      { label: "Push all repositories", icon: "push", onClick: () => forAll("Push", (r) => D.atom.git.push(r), (r) => { const st2 = stat(r); return !!st2 && statusOk(r) && !st2.unborn && (st2.ahead > 0 || !st2.upstream); }) },
      { sep: true },
      { label: "Open repository folder", icon: "folderOpen", onClick: () => D.atom.files.reveal(repo) },
      { label: "Copy repository path", icon: "copy", onClick: () => { D.atom.clipboard.write(repo); D.toast("Path copied", "check"); } },
    ]) }),
    h("div", { class: "gitc-spacer" }),
    h("span", { class: "gitc-cur", title: "Checked-out branch" }, h("span", { html: icon("check", 12) }), h("span", { text: s.detached ? "detached HEAD" : (cur || "—") + (info.unborn ? " (no commits yet)" : "") })),
    // Merge / Rebase live in the compare bar: they unlock only after Compare ran and showed differences.
    h("button", { class: "gitc-act comparebtn" + (inCmp ? " active" : ""), title: inCmp ? "Back to Changes / History…" : "Open the merge view: pick two branches, Compare, then Create Merge", "aria-pressed": inCmp ? "true" : "false", onclick: () => (inCmp ? exitCompare() : enterCompare()) }, h("span", { html: icon("gitCompare", 14) }), inCmp ? "Close compare" : "Compare and Merge"));
  syncMutationControls();
}
export const OP_NAMES = { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert", bisect: "Bisect" };
// Operation banner: actions come from the backend's per-state list (continue /
// skip / abort / bisect-reset) — never a generic commit or an unrelated abort.
export function renderBanner() {
  const b = q(".gitc-banner"); if (!b) return;
  const repo = S.repo;
  const st = S.info && S.info.state ? S.info.state : null;
  const conf = repo ? conflicts(repo).length : 0;
  if (!st || !st.op) { b.classList.add("hidden"); b.innerHTML = ""; return; }
  b.classList.remove("hidden"); b.innerHTML = "";
  const opName = OP_NAMES[st.op] || st.op;
  const actions = Array.isArray(st.actions) ? st.actions : [];
  const bisect = st.op === "bisect";
  b.append(...[
    h("span", { class: "gitc-banner-ic", html: icon("alert", 16) }),
    h("div", { class: "gitc-banner-text" },
      h("b", { text: `${opName} in progress` + (st.detail ? ` — ${st.detail}` : "") }),
      h("span", { text: bisect ? "A bisect is running. Mark commits good/bad from a terminal, or reset the bisect to return to the branch." : conf ? `${conf} conflicted file${conf === 1 ? "" : "s"} — keep yours or accept incoming per file (Changes tab), or open one for line-level choices. Sides: mine = git ${st.sides ? st.sides.mine : "ours"}.` : `All conflicts resolved — continue to finish the ${opName.toLowerCase()}, or abort to go back.` })),
    h("div", { class: "gitc-spacer" }),
    conf && !bisect ? h("button", { class: "gitc-act primary", onclick: () => openResolver(undefined, repo) }, h("span", { html: icon("git", 14) }), "Resolve conflicts") : null,
    actions.includes("continue") ? h("button", { class: "gitc-act mut" + (conf ? "" : " primary"), disabled: !!conf, title: conf ? "Resolve conflicts first" : `Finish the ${opName.toLowerCase()}`, onclick: () => act(`Continue ${opName.toLowerCase()}`, () => D.atom.git.mergeContinue(repo), { repo, silent: true }).then((r) => { if (r && r.ok) D.toast(r.stillInProgress ? `${opName} continues — next step` : `${opName} completed on ${D.esc(r.branch || "")}`, "checkCircle", { ms: 3200 }); }) }, h("span", { html: icon("check", 14) }), "Continue") : null,
    actions.includes("skip") ? h("button", { class: "gitc-act mut", title: "Skip the current commit", onclick: () => act("Skip commit", () => D.atom.git.rebaseSkip(repo), { repo }) }, "Skip") : null,
    actions.includes("bisect-reset") ? h("button", { class: "gitc-act mut primary", title: "End the bisect and return to the original branch", onclick: () => act("Reset bisect", () => D.atom.git.bisectReset(repo), { repo }) }, "Reset bisect") : null,
    actions.includes("abort") ? h("button", { class: "gitc-act mut danger", onclick: async () => { if (await confirmDanger(`Abort ${opName.toLowerCase()}`, `Abort the ${opName.toLowerCase()} in ${repoName(repo)} and return to the state before it started?`, "Abort")) { per(repo).continuation = null; act(`Abort ${opName.toLowerCase()}`, () => D.atom.git.mergeAbort(repo), { repo }); } } }, h("span", { html: icon("x", 14) }), "Abort") : null,
  ].filter(Boolean));
  syncMutationControls();
}
export function renderTabs() {
  const t = q(".gitc-tabs"); if (!t) return;
  t.innerHTML = "";
  t.classList.toggle("hidden", S.mode === "compare");
  const s = S.repo ? stat(S.repo) : null;
  const n = s && s.files ? s.files.length : 0;
  for (const tab of TABS) {
    const badge = tab.id === "changes" && n ? h("span", { class: "gitc-tab-badge" + (conflicts(S.repo).length ? " danger" : ""), text: String(n) }) : (tab.id === "stashes" && S.st.list.length ? h("span", { class: "gitc-tab-badge", text: String(S.st.list.length) }) : null);
    t.append(h("button", { class: "gitc-tab" + (tab.id === S.tab ? " active" : ""), role: "tab", "aria-selected": tab.id === S.tab ? "true" : "false", onclick: () => setTab(tab.id), onkeydown: (e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const i = TABS.findIndex((x) => x.id === S.tab); const nx = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]; setTab(nx.id); const btn = [...t.children][TABS.indexOf(nx)]; if (btn) btn.focus(); } } }, h("span", { html: icon(tab.icon, 14) }), tab.name, badge));
  }
}
export function setTab(id) { if (id === "compare") { enterCompare(); return; } S.mode = "tabs"; S.tab = id; renderBar(); renderTabs(); renderCmpBar(); renderMain(); }
// The merge view: Source · Target · Compare · Create Merge · Rebase. Nothing is compared
// until the user clicks Compare; a review is dropped whenever a ref changes.
export function enterCompare() { S.mode = "compare"; resetCompare(); renderBar(); renderTabs(); renderCmpBar(); renderMain(); }
export function exitCompare() { S.mode = "tabs"; renderBar(); renderTabs(); renderCmpBar(); renderMain(); }
export function resetCompare(repo = S.repo) { if (!repo) return; Object.assign(per(repo).cmp, { compared: false, ready: false, ids: null, error: "" }); }
/* Compare = re-read the repository (status + branches) and then load the review of
 * source → target. Create Merge / Rebase arm from that review only. */
export async function runCompare() {
  const repo = S.repo;
  if (!repo || !S.source || !S.target || S.source === S.target) return;
  const btn = q(".gitc-cmpbar .cmp-run"); if (btn) btn.disabled = true;
  await refreshRepo(repo, { quiet: true });
  if (!isOpen() || S.repo !== repo || S.mode !== "compare") return;
  Object.assign(S.cmp, { compared: true, ready: false, ids: null, error: "" });
  renderCmpBar();
  await renderMain();
}
export function renderCmpBar() {
  const cb = q(".gitc-cmpbar"); if (!cb) return;
  cb.innerHTML = "";
  cb.classList.toggle("hidden", S.mode !== "compare");
  if (S.mode !== "compare" || !S.repo) return;
  const repo = S.repo, info = S.info || {}, C = S.cmp;
  const canCompare = !!(S.source && S.target && S.source !== S.target);
  const reviewed = canCompare && C.compared && C.ready && !C.error;          // Compare clicked and loaded completely
  const differences = reviewed && !!((C.ab && C.ab.onlyB > 0) || C.files.length);   // the source has something the target lacks
  const targetLocal = kindOf(repo, S.target) === "local", sourceLocal = kindOf(repo, S.source) === "local";
  const swap = () => { const a = S.source; S.source = S.target; S.target = a; resetCompare(); renderBar(); renderCmpBar(); renderMain(); };
  cb.append(
    h("span", { class: "gitc-reflabel", text: "Source" }), refButton("source"),
    h("button", { class: "gitc-swap", title: "Swap source / target", "aria-label": "Swap source and target", html: icon("refresh", 13), onclick: swap }),
    h("span", { class: "gitc-reflabel", text: "Target" }), refButton("target"),
    h("button", { class: "gitc-act primary cmp-run", disabled: !canCompare, title: !canCompare ? "Pick two different branches" : `Refresh ${repoName(repo)} and compare “${S.source}” with “${S.target}”`, onclick: () => runCompare() }, h("span", { html: icon("gitCompare", 14) }), "Compare"),
    h("button", { class: "gitc-act mut mergebtn", disabled: !differences || !targetLocal,
      title: !C.compared ? "Click Compare first — Create Merge activates when the comparison shows differences" : !C.ready ? (C.error ? "The comparison did not load completely — click Compare again" : "Comparing…") : !differences ? `Nothing to merge — “${S.source}” has no commits that “${S.target}” lacks` : !targetLocal ? `“${S.target}” is not a local branch — check it out first, then merge into it` : `Merge “${S.source}” into “${S.target}”`,
      onclick: (e) => doMerge(S.source, S.target, e.currentTarget, repo) }, h("span", { html: icon("merge", 14) }), "Create Merge"),
    h("button", { class: "gitc-act mut rebasebtn", disabled: !reviewed || !sourceLocal || !!info.unborn,
      title: !reviewed ? "Click Compare first" : !sourceLocal ? `“${S.source}” is not a local branch — only local branches can be rebased` : `Rebase “${S.source}” onto “${S.target}”`,
      onclick: (e) => doRebase(S.source, S.target, e.currentTarget, repo) }, h("span", { html: icon("gitCompare", 14) }), "Rebase"),
    h("div", { class: "gitc-cmp-summary" }));
  syncMutationControls();
}
/* Draw the current tab. `soft` = a refresh: the Changes tab updates its mounted shell
 * in place (keeps the commit box, its focus/caret and the diff pane); other tabs redraw. */
export async function renderMain({ soft = false } = {}) {
  const c = q(".gitc-content"); if (!c || !S.repo || !S.info) return;
  const gen = ++S.gen;
  if (S.mode !== "compare" && S.tab === "changes") { try { await renderChanges(c, gen, { soft }); } catch (e) { if (alive(gen)) { c.innerHTML = ""; c.append(empty("alert", "Couldn't load", errText(e))); } } return; }
  c.innerHTML = "";
  const fn = S.mode === "compare" ? renderCompare : ({ history: renderHistory, branches: renderBranches, stashes: renderStashes, tags: renderTags, remotes: renderRemotes }[S.tab] || renderChanges);
  try { await fn(c, gen); } catch (e) { if (alive(gen)) { c.innerHTML = ""; c.append(empty("alert", "Couldn't load", errText(e))); } }
}
