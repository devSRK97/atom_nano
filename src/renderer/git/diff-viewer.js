/* AtomNano renderer — Diff viewer (split / unified) and branch comparison.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { $, baseName, h, promptDialog, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { parseUnifiedDiff, processHunk } from "../diff.js";
import { openInEditor } from "../editor/editor-pane.js";
import { icon } from "../icons.js";
import { fileMeta, refreshTree } from "../workspace/sidebar.js";
import { showMenuAt } from "./branches.js";
import { openConflictResolver } from "./conflicts-ui.js";
import { gitBranchOf, refreshGit, setSidebarView } from "./sidebar.js";
import { esc, repoName } from "./titlebar.js";

/* ============================================================
   GIT DIFF VIEWER — a polished overlay with split / unified views,
   word-level highlights, ± stats and prev/next file navigation.
   ============================================================ */
export let gDiffView = (() => { try { return localStorage.getItem("aqx.diffView") || "split"; } catch { return "split"; } })();
export const _diffNav = { files: [], index: 0, parsed: null, repo: "", file: null };
export let _diffKeyHandler = null;
export function diffNavList() {
  const files = [];
  for (const repo of state.git.repos || []) {
    const s = state.git.statuses[repo];
    if (s && s.files) for (const f of s.files) files.push({ repo, path: f.path, label: f.label });
  }
  return files;
}
// Open the diff overlay for a changed file. Builds the prev/next list from every
// changed file across all projects so you can flip through a review in place.
export function openDiff(repo, fileObj) {
  _diffNav.files = diffNavList();
  _diffNav.index = _diffNav.files.findIndex((x) => x.repo === repo && x.path === fileObj.path);
  if (_diffNav.index < 0) { _diffNav.files = [{ repo, path: fileObj.path, label: fileObj.label }]; _diffNav.index = 0; }
  bindDiffKeys();
  showDiffFor(repo, fileObj);
}
export function navDiff(delta) {
  if (_diffNav.files.length < 2) return;
  _diffNav.index = (_diffNav.index + delta + _diffNav.files.length) % _diffNav.files.length;
  const n = _diffNav.files[_diffNav.index];
  showDiffFor(n.repo, n);
}
export function setDiffView(v) {
  gDiffView = v === "unified" ? "unified" : "split";
  try { localStorage.setItem("aqx.diffView", gDiffView); } catch { /* ignore */ }
  const back = document.querySelector(".diff-overlay");
  if (!back) return;
  updateDiffSeg(back);
  if (_diffNav.parsed) {
    const body = back.querySelector(".diff-body");
    body.innerHTML = "";
    body.append(renderDiffContent(_diffNav.parsed));
  }
}
export function bindDiffKeys() {
  if (_diffKeyHandler) return;
  _diffKeyHandler = (e) => {
    if (!document.querySelector(".diff-overlay")) return;
    if (e.key === "Escape") { e.preventDefault(); closeDiff(); }
    else if (e.key === "]" || (e.key === "ArrowDown" && e.altKey)) { e.preventDefault(); navDiff(1); }
    else if (e.key === "[" || (e.key === "ArrowUp" && e.altKey)) { e.preventDefault(); navDiff(-1); }
    else if (e.key === "u") { e.preventDefault(); setDiffView("unified"); }
    else if (e.key === "s") { e.preventDefault(); setDiffView("split"); }
  };
  document.addEventListener("keydown", _diffKeyHandler, true);
}
export function closeDiff() {
  const b = document.querySelector(".diff-overlay");
  if (b) b.remove();
  if (_diffKeyHandler) { document.removeEventListener("keydown", _diffKeyHandler, true); _diffKeyHandler = null; }
}
export function ensureDiffOverlay() {
  let back = document.querySelector(".diff-overlay");
  if (back) return back;
  back = h("div", { class: "diff-overlay", onmousedown: (e) => { if (e.target === back) closeDiff(); } });
  const panel = h("div", { class: "diff-panel" },
    h("div", { class: "diff-head" },
      h("span", { class: "dfh-ico" }),
      h("div", { class: "dfh-title" }, h("span", { class: "dfh-name" }), h("span", { class: "dfh-path" })),
      h("span", { class: "dfh-stat" }),
      h("div", { class: "dfh-spacer" }),
      h("span", { class: "dfh-count" }),
      h("div", { class: "dfh-seg" },
        h("button", { class: "dfh-seg-btn", dataset: { view: "split" }, text: "Split", onclick: () => setDiffView("split") }),
        h("button", { class: "dfh-seg-btn", dataset: { view: "unified" }, text: "Unified", onclick: () => setDiffView("unified") })),
      h("button", { class: "dfh-btn", title: "Previous file  [", html: icon("chevron", 16, "flip"), onclick: () => navDiff(-1) }),
      h("button", { class: "dfh-btn", title: "Next file  ]", html: icon("chevron", 16), onclick: () => navDiff(1) }),
      h("button", { class: "dfh-btn", title: "Open file in editor", html: icon("external", 15), onclick: () => { const n = _diffNav.files[_diffNav.index]; closeDiff(); if (n) openInEditor(n.repo.replace(/[\\/]+$/, "") + "/" + n.path); } }),
      h("button", { class: "dfh-btn close", title: "Close  Esc", html: icon("close", 16), onclick: () => closeDiff() })),
    h("div", { class: "diff-body" }));
  back.append(panel);
  $("modalRoot").append(back);
  return back;
}
export function updateDiffSeg(back) {
  for (const b of back.querySelectorAll(".dfh-seg-btn")) b.classList.toggle("active", b.dataset.view === gDiffView);
}
export async function showDiffFor(repo, fileObj) {
  const back = ensureDiffOverlay();
  _diffNav.repo = repo; _diffNav.file = fileObj;
  const body = back.querySelector(".diff-body");
  body.innerHTML = "";
  body.append(h("div", { class: "diff-loading" }, h("span", { html: icon("spinner", 22, "spin") }), h("span", { text: "Loading diff…" })));
  // header
  const ext = (fileObj.path.split(".").pop() || "").toLowerCase();
  (function(){const m=fileMeta(baseName(fileObj.path||fileObj));const el=back.querySelector(".dfh-ico");el.innerHTML=icon(m.ic,17);el.className="dfh-ico "+m.cls;})();
  back.querySelector(".dfh-name").textContent = baseName(fileObj.path);
  const slash = fileObj.path.lastIndexOf("/");
  back.querySelector(".dfh-path").textContent = (slash >= 0 ? fileObj.path.slice(0, slash) + "/ · " : "") + repoName(repo);
  const cnt = back.querySelector(".dfh-count");
  cnt.textContent = _diffNav.files.length > 1 ? `${_diffNav.index + 1} / ${_diffNav.files.length}` : "";
  updateDiffSeg(back);

  let res;
  try { res = await atom.git.fileDiff(repo, fileObj.path); } catch (e) { res = { text: "", error: e.message }; }
  if (back !== document.querySelector(".diff-overlay")) return;   // closed/navigated away
  const parsed = parseUnifiedDiff(res.text || "");
  _diffNav.parsed = parsed;
  back.querySelector(".dfh-stat").innerHTML = parsed.binary
    ? `<span class="ds-bin">binary</span>`
    : `<span class="ds-add">+${parsed.adds}</span><span class="ds-del">−${parsed.dels}</span>`;
  body.innerHTML = "";
  if (res.error) { body.append(diffEmpty("alert", "Couldn’t load diff", res.error)); return; }
  if (parsed.binary) { body.append(diffEmpty("eye", "Binary file", "No text diff to show.")); return; }
  if (!parsed.hunks.length) {
    body.append(diffEmpty("check", fileObj.label === "Untracked" ? "New file" : "No changes",
      fileObj.label === "Untracked" ? "Open it to view its contents." : "This file matches HEAD."));
    return;
  }
  body.append(renderDiffContent(parsed));
}
export function diffEmpty(ic, title, sub) {
  return h("div", { class: "diff-empty" },
    h("span", { class: "de-ic", html: icon(ic, 34) }),
    h("div", { class: "de-title", text: title }),
    sub ? h("div", { class: "de-sub", text: sub }) : null);
}
export function diffCode(parts, text) {
  const el = h("span", { class: "dl-code" });
  if (parts) { for (const p of parts) el.append(p.ch ? h("span", { class: "wd", text: p.t }) : document.createTextNode(p.t)); }
  else el.append(document.createTextNode(text != null ? text : ""));
  return el;
}
export function unifiedRow(r) {
  const cls = r.kind === "add" ? "add" : r.kind === "del" ? "del" : "ctx";
  return h("div", { class: "dl " + cls },
    h("span", { class: "dl-no", text: r.oldNo != null ? String(r.oldNo) : "" }),
    h("span", { class: "dl-no", text: r.newNo != null ? String(r.newNo) : "" }),
    h("span", { class: "dl-gut", text: r.kind === "add" ? "+" : r.kind === "del" ? "−" : "" }),
    diffCode(r.parts, r.text));
}
export function splitCell(no, parts, text, cls) {
  return h("div", { class: "dsc " + cls },
    h("span", { class: "dl-no", text: no != null ? String(no) : "" }),
    diffCode(parts, text));
}
export function splitRow(r) {
  let left, right;
  if (r.kind === "ctx") { left = splitCell(r.old.no, null, r.old.text, "ctx"); right = splitCell(r.new.no, null, r.new.text, "ctx"); }
  else if (r.kind === "mod") { left = splitCell(r.old.no, r.old.parts, null, "del"); right = splitCell(r.new.no, r.new.parts, null, "add"); }
  else if (r.kind === "del") { left = splitCell(r.old.no, null, r.old.text, "del"); right = splitCell(null, null, "", "empty"); }
  else { left = splitCell(null, null, "", "empty"); right = splitCell(r.new.no, null, r.new.text, "add"); }
  return h("div", { class: "dsr" }, left, right);
}
export function renderDiffContent(parsed) {
  const wrap = h("div", { class: "diff-content " + (gDiffView === "split" ? "is-split" : "is-unified") });
  for (const hunk of parsed.hunks) {
    wrap.append(h("div", { class: "diff-hunkhdr", text: hunk.header }));
    const { unified, split } = processHunk(hunk.lines);
    if (gDiffView === "split") for (const r of split) wrap.append(splitRow(r));
    else for (const r of unified) wrap.append(unifiedRow(r));
  }
  return wrap;
}
/* ============================================================
   COMPARE BRANCHES — review what a SOURCE branch adds over a
   TARGET branch (file list + per-file diff), then merge source
   into target (a local "merge request" review-then-merge flow).
   Defaults: source = current branch, target = main.
   ============================================================ */
export const _cmp = { repo: "", source: "", target: "", files: [], index: -1, branches: null };
export function shortRef(r) { return (r || "").replace(/^origin\//, ""); }
// Pick a sensible default target: prefer main/master, else the first branch
// that isn't the source.
export function defaultTarget(info, source) {
  const all = [...info.locals, ...info.remotes];
  for (const pref of ["main", "master"]) if (info.locals.includes(pref) && pref !== source) return pref;
  return all.find((b) => b !== source) || source;
}
// Entry from the git-view header: one repo → compare it; many → pick a project.
export function openCompareFlow(ev) {
  const repos = state.git.repos || [];
  if (!repos.length) { toast("No Git repository here", "alert"); return; }
  if (repos.length === 1) return openCompare(repos[0]);
  showMenuAt(ev, repos.map((r) => ({ label: repoName(r) + "  —  " + (gitBranchOf(r) || "?"), icon: "gitCompare", onClick: () => openCompare(r) })));
}
export async function openCompare(repo, sourceRef, targetRef) {
  let info;
  try { info = await atom.git.branches(repo); } catch (e) { toast("Couldn’t list branches: " + esc(e.message), "alert"); return; }
  const all = [...info.locals, ...info.remotes];
  if (all.length < 2) { toast("Need at least two branches to compare", "alert"); return; }
  _cmp.repo = repo;
  _cmp.branches = info;
  _cmp.source = sourceRef || info.current || all[0] || "";          // default: current branch
  _cmp.target = targetRef || defaultTarget(info, _cmp.source);      // default: main
  _cmp.files = []; _cmp.index = -1;
  ensureCompareOverlay();
  renderCompareHead();
  await loadCompareFiles();
}
export function ensureCompareOverlay() {
  let back = document.querySelector(".compare-overlay");
  if (back) return back;
  back = h("div", { class: "compare-overlay", onmousedown: (e) => { if (e.target === back) closeCompare(); } });
  const panel = h("div", { class: "compare-panel" },
    h("div", { class: "cmp-head" },
      h("span", { class: "cmp-ic", html: icon("gitCompare", 17) }),
      h("div", { class: "cmp-refs" },
        h("span", { class: "cmp-reflabel", text: "Source" }),
        h("button", { class: "cmp-ref source", title: "Choose the source branch (the changes being merged)", onclick: (e) => pickCompareRef(e, "source") }),
        h("span", { class: "cmp-arrow", html: icon("chevron", 14) }),
        h("span", { class: "cmp-reflabel", text: "Target" }),
        h("button", { class: "cmp-ref target", title: "Choose the target branch (merged into)", onclick: (e) => pickCompareRef(e, "target") }),
        h("button", { class: "cmp-swap", title: "Swap source / target", html: icon("refresh", 14), onclick: () => swapCompare() })),
      h("div", { class: "dfh-spacer" }),
      h("span", { class: "cmp-count" }),
      h("button", { class: "cmp-merge btn btn-primary", onclick: () => mergeFromCompare() }, "Merge"),
      h("button", { class: "dfh-btn close", title: "Close  Esc", html: icon("close", 16), onclick: () => closeCompare() })),
    h("div", { class: "cmp-body" },
      h("div", { class: "cmp-files" }),
      h("div", { class: "cmp-diff" })));
  back.append(panel);
  $("modalRoot").append(back);
  bindCompareKeys();
  return back;
}
export function renderCompareHead() {
  const back = document.querySelector(".compare-overlay");
  if (!back) return;
  const setRef = (sel, name) => { const b = back.querySelector(sel); b.innerHTML = ""; b.append(h("span", { class: "cmp-ref-ic", html: icon("branch", 12) }), h("span", { class: "cmp-ref-name", text: shortRef(name) || "—" })); };
  setRef(".cmp-ref.source", _cmp.source);
  setRef(".cmp-ref.target", _cmp.target);
  const mergeBtn = back.querySelector(".cmp-merge");
  const canMerge = _cmp.source && _cmp.target && _cmp.source !== _cmp.target;
  mergeBtn.textContent = canMerge ? `Merge ${shortRef(_cmp.source)} → ${shortRef(_cmp.target)}` : "Merge";
  mergeBtn.disabled = !canMerge;
  mergeBtn.title = canMerge ? `Merge “${_cmp.source}” into “${_cmp.target}”` : "Pick two different branches to merge";
}
export async function loadCompareFiles() {
  const back = document.querySelector(".compare-overlay");
  if (!back) return;
  const filesEl = back.querySelector(".cmp-files");
  const countEl = back.querySelector(".cmp-count");
  filesEl.innerHTML = "";
  if (!_cmp.source || !_cmp.target || _cmp.source === _cmp.target) {
    filesEl.append(h("div", { class: "cmp-empty" }, h("span", { html: icon("gitCompare", 24) }), h("div", { text: _cmp.source === _cmp.target ? "Pick two different branches." : "Choose branches to compare." })));
    countEl.textContent = "";
    showCompareDiffPlaceholder("Pick a source and target branch to see what would merge.");
    return;
  }
  filesEl.append(h("div", { class: "cmp-loading" }, h("span", { html: icon("spinner", 18, "spin") }), h("span", { text: "Comparing…" })));
  let res;
  // What `source` adds over `target` = git diff target...source (three-dot).
  try { res = await atom.git.changedBetween(_cmp.repo, _cmp.target, _cmp.source); }
  catch (e) { filesEl.innerHTML = ""; filesEl.append(h("div", { class: "cmp-empty" }, h("span", { html: icon("alert", 24) }), h("div", { text: "Compare failed: " + e.message }))); return; }
  if (back !== document.querySelector(".compare-overlay")) return;
  _cmp.files = res.files || [];
  countEl.textContent = _cmp.files.length ? `${_cmp.files.length} file${_cmp.files.length === 1 ? "" : "s"} changed` : "no differences";
  filesEl.innerHTML = "";
  if (!_cmp.files.length) {
    filesEl.append(h("div", { class: "cmp-empty" }, h("span", { html: icon("checkCircle", 26) }), h("div", { text: `${shortRef(_cmp.source)} has nothing to merge into ${shortRef(_cmp.target)}.` })));
    showCompareDiffPlaceholder("These branches have no differences.");
    return;
  }
  _cmp.files.forEach((f, i) => {
    const ext = (f.path.split(".").pop() || "").toLowerCase();
    const slash = f.path.lastIndexOf("/");
    filesEl.append(h("div", { class: "cmp-file", dataset: { i: String(i) }, title: f.label + " · " + f.path, onclick: () => showCompareDiff(i) },
      (function(){const m=fileMeta(baseName(f.path));return h("span",{class:"gvf-ico "+m.cls,html:icon(m.ic,14)});})(),
      h("span", { class: "gvf-name", text: baseName(f.path) }),
      h("span", { class: "gvf-path", text: slash >= 0 ? f.path.slice(0, slash) : "" }),
      h("span", { class: "gvf-stat cmp-stat-" + (f.code || "M"), text: f.label })));
  });
  showCompareDiff(0);
}
export async function showCompareDiff(i) {
  const back = document.querySelector(".compare-overlay");
  if (!back || !_cmp.files[i]) return;
  _cmp.index = i;
  for (const el of back.querySelectorAll(".cmp-file")) el.classList.toggle("active", +el.dataset.i === i);
  const f = _cmp.files[i];
  const diffEl = back.querySelector(".cmp-diff");
  diffEl.innerHTML = "";
  diffEl.append(h("div", { class: "diff-loading" }, h("span", { html: icon("spinner", 22, "spin") }), h("span", { text: "Loading diff…" })));
  let res;
  try { res = await atom.git.refDiff(_cmp.repo, _cmp.target, _cmp.source, f.path); }
  catch (e) { res = { text: "", error: e.message }; }
  if (back !== document.querySelector(".compare-overlay") || _cmp.index !== i) return;
  const parsed = parseUnifiedDiff(res.text || "");
  const ext = (f.path.split(".").pop() || "").toLowerCase();
  diffEl.innerHTML = "";
  const head = h("div", { class: "cmp-diff-head" },
    (function(){const m=fileMeta(baseName(f.path||f));return h("span",{class:"dfh-ico "+m.cls,html:icon(m.ic,16)});})(),
    h("span", { class: "cmp-diff-name", text: f.path }),
    h("div", { class: "dfh-spacer" }),
    parsed.binary ? h("span", { class: "ds-bin", text: "binary" })
      : h("span", { class: "cmp-diff-stat" }, h("span", { class: "ds-add", text: "+" + parsed.adds }), h("span", { class: "ds-del", text: "−" + parsed.dels })));
  diffEl.append(head);
  if (res.error) { diffEl.append(diffEmpty("alert", "Couldn’t load diff", res.error)); return; }
  if (parsed.binary) { diffEl.append(diffEmpty("eye", "Binary file", "No text diff to show.")); return; }
  if (!parsed.hunks.length) { diffEl.append(diffEmpty("check", "No line changes", "File metadata changed only.")); return; }
  // The compare pane is narrow — render unified regardless of the global setting.
  const saved = gDiffView; gDiffView = "unified";
  const content = renderDiffContent(parsed);
  gDiffView = saved;
  diffEl.append(h("div", { class: "cmp-diff-scroll" }, content));
}
export function showCompareDiffPlaceholder(msg) {
  const back = document.querySelector(".compare-overlay");
  if (!back) return;
  const d = back.querySelector(".cmp-diff");
  d.innerHTML = "";
  d.append(h("div", { class: "cmp-diff-empty" }, h("span", { html: icon("gitCompare", 30) }), h("div", { text: msg || "Select a file to see the diff." })));
}
export function pickCompareRef(ev, which) {
  const info = _cmp.branches;
  if (!info) return;
  const all = [...info.locals, ...info.remotes];
  const cur = which === "source" ? _cmp.source : _cmp.target;
  showMenuAt(ev, all.map((b) => ({
    label: b + (b === info.current ? "  (current)" : ""), icon: b === cur ? "check" : "branch",
    onClick: () => { if (which === "source") _cmp.source = b; else _cmp.target = b; renderCompareHead(); loadCompareFiles(); },
  })));
}
export function swapCompare() { const a = _cmp.source; _cmp.source = _cmp.target; _cmp.target = a; renderCompareHead(); loadCompareFiles(); }
// Local merge from the compare view (the "merge request"): merge the selected
// SOURCE branch into the selected TARGET, with a custom merge-commit message.
export function mergeFromCompare() {
  const { repo, source, target } = _cmp;
  if (!source || !target || source === target) { toast("Pick two different branches to merge", "alert"); return; }
  const cur = _cmp.branches ? _cmp.branches.current : "";
  const note = target === cur ? "" : ` “${shortRef(target)}” will be checked out first.`;
  promptDialog({
    title: `Merge ${shortRef(source)} → ${shortRef(target)}`, ic: "merge",
    message: `Merging “${shortRef(source)}” into “${shortRef(target)}” in ${repoName(repo)}.${note}`,
    placeholder: "Merge commit message",
    value: `Merge branch '${shortRef(source)}' into ${shortRef(target)}`,
    confirmLabel: `Merge into ${shortRef(target)}`,
    onConfirm: (msg) => { closeCompare(); gitMergeBranches(repo, source, target, (msg || "").trim()); },
  });
}
// Merge source → target with an optional commit message. The backend checks out
// target then merges source, so this works even when target isn't checked out.
// On conflict we land on target, show the merge banner, and open the guided
// resolver straight away so the user is never left stuck.
export async function gitMergeBranches(repo, source, target, message) {
  toast(`Merging ${esc(source)} → ${esc(target)}…`, "merge", { sticky: true, spin: true });
  try {
    const r = await atom.git.mergeBranches(repo, source, target, message);
    state.git.selected.clear();
    if (state.sidebarView !== "git") setSidebarView("git");
    await refreshGit(); refreshTree(true);
    if (r.ok) {
      const how = r.upToDate ? "already up to date" : (r.fastForward ? "fast-forward" : "merged");
      toast(`Merged ${esc(source)} → ${esc(target)} (${how}) · now on ${esc(target)}`, "checkCircle", { ms: 4400 });
    } else if (r.conflict) {
      toast(`<b>Merge needs your help: ${esc(source)} → ${esc(target)}</b><span class="toast-sub">You’re on ${esc(target)}. Resolve each conflict below, then complete the merge.</span>`, "alert", { ms: 6500 });
      openConflictResolver(repo);   // jump straight into guided, card-per-conflict resolution
    }
  } catch (e) { toast(`<b>Merge failed</b><span class="toast-sub">${esc(repoName(repo))}: ${esc(e.message)}</span>`, "alert", { ms: 7000 }); }
}
export function closeCompare() {
  const b = document.querySelector(".compare-overlay");
  if (b) b.remove();
  if (_cmpKeyHandler) { document.removeEventListener("keydown", _cmpKeyHandler, true); _cmpKeyHandler = null; }
}
export let _cmpKeyHandler = null;
export function bindCompareKeys() {
  if (_cmpKeyHandler) return;
  _cmpKeyHandler = (e) => {
    if (!document.querySelector(".compare-overlay")) return;
    if (e.key === "Escape") { e.preventDefault(); closeCompare(); }
    else if (_cmp.files.length && (e.key === "]" || (e.key === "ArrowDown" && e.altKey))) { e.preventDefault(); showCompareDiff((_cmp.index + 1) % _cmp.files.length); }
    else if (_cmp.files.length && (e.key === "[" || (e.key === "ArrowUp" && e.altKey))) { e.preventDefault(); showCompareDiff((_cmp.index - 1 + _cmp.files.length) % _cmp.files.length); }
  };
  document.addEventListener("keydown", _cmpKeyHandler, true);
}
