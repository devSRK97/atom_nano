/* AtomNano renderer — Git Center — the Changes tab: tri-state file tree, sections (Conflicts · Versioned · Unversioned), the per-repo shell with the commit box.
 * One of the modules the former single gitcenter.js was split into (see git/center/index.js). */
import { act, confirmDanger, openResolver } from "./actions.js";
import { doPush } from "./ops.js";
import { OP_NAMES } from "./render.js";
import { refreshRepo } from "./repos.js";
import { abs, alive, codeChip, D, empty, fileIcon, h, icon, iconBtn, per, pm, q, repoName, rowA11y, S, stat, statusOk } from "./state.js";
import { diffPane, section, splitPane, virtualList } from "./widgets.js";

/* ============================ Changes ============================ */
// Paths → nested tree { dirs: Map<name, node>, files: [f] } for the tri-state tree.
export function buildTree(files) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.dirs.has(name)) node.dirs.set(name, { name, path: (node.path ? node.path + "/" : "") + name, dirs: new Map(), files: [] });
      node = node.dirs.get(name);
    }
    node.files.push(f);
  }
  // collapse single-child directory chains (a/b/c → "a/b/c") like IDE trees
  const squash = (node) => {
    for (const [name, d] of [...node.dirs]) {
      let cur = d;
      while (cur.dirs.size === 1 && cur.files.length === 0) { const [only] = cur.dirs.values(); cur = { ...only, name: cur.name + "/" + only.name }; }
      node.dirs.delete(name); node.dirs.set(cur.name, cur); squash(cur);
    }
  };
  squash(root);
  return root;
}
export const descendants = (node) => { const out = [...node.files]; for (const d of node.dirs.values()) out.push(...descendants(d)); return out; };
export const ROW_H = 26;
// The commit plan item for a status record: rename pairs and untrack intent travel with the path.
export const planItem = (f) => ({ path: f.path, orig: f.orig || undefined, untrack: !!(f.stagedDelete && f.keptOnDisk) || undefined });
/* The Changes tab keeps a per-repo SHELL mounted (left column = sections + commit box,
 * right = diff pane). A refresh rebuilds only the sections; the commit textarea, its
 * focus/caret/scroll and the diff pane are untouched. */
export async function renderChanges(c, gen, { soft = false } = {}) {
  const repo = S.repo;
  const info = S.info || {};
  const s = stat(repo) || { files: [] };
  const files = s.files || [];
  const conf = files.filter((f) => f.conflict);
  // Unversioned = new files AND files just unversioned (removal staged, kept on disk):
  // both sit in the Unversioned section; the latter carries a "Track again" action.
  const isUnversioned = (f) => !!(f.untracked || (f.stagedDelete && f.keptOnDisk));
  const versioned = files.filter((f) => !f.conflict && !isUnversioned(f));
  const unversioned = files.filter((f) => !f.conflict && isUnversioned(f));
  const C = S.chg;
  const readable = statusOk(repo);
  // selection: nothing is selected by default — the user ticks what to commit; vanished paths are pruned
  const present = new Set(files.map((f) => f.path));
  for (const p of [...C.sel]) if (!present.has(p)) C.sel.delete(p);
  // ---- shell (built once per repo, reused across refreshes) ----
  let sh = C.shell;
  if (!sh || sh.repo !== repo || !sh.root) { sh = buildChangesShell(repo); C.shell = sh; }
  if (c.firstChild !== sh.root) { c.innerHTML = ""; c.append(sh.root); }
  const { scroll, pane } = sh;
  const scrollTop = scroll.scrollTop;
  scroll.innerHTML = "";
  const byPath = new Map(files.map((f) => [f.path, f]));
  const selected = () => [...C.sel].filter((p) => byPath.has(p));
  const selVersioned = () => selected().filter((p) => { const f = byPath.get(p); return !f.conflict && !isUnversioned(f); });
  const selUnversioned = () => selected().filter((p) => { const f = byPath.get(p); return !f.conflict && isUnversioned(f); });
  const selDeletable = () => selUnversioned().filter((p) => !byPath.get(p).stagedDelete);   // only NEW files can be deleted from disk here
  const cSel = () => selected().filter((p) => byPath.get(p).conflict);
  const stageAct = (label, fn) => act(label, fn, { repo, silent: true });
  // A file the user acted on (unversion / track again / discard) leaves the selection and,
  // if it was the previewed file, the diff pane — nothing gets pre-selected or previewed.
  const dropSel = (paths) => { for (const p of paths) C.sel.delete(p); if (paths.includes(C.diffKey)) C.diffKey = null; };
  const openEditor = (f) => iconBtn("external", "Open in editor", () => D.openInEditor(abs(repo, f.path)));
  const sides = (info.state && info.state.sides) || { mine: "ours", incoming: "theirs" };
  const opName = info.state && info.state.op ? (OP_NAMES[info.state.op] || info.state.op) : "merge";
  // --- diff preview: the DEFAULT view is exactly what Commit will land (HEAD ↔ working
  //     tree for the selected file); Staged / Unstaged are separate labelled baselines.
  const showWorking = (f, viewId) => {
    C.diffKey = f.path;
    for (const el of scroll.querySelectorAll(".gitc-tree-file")) el.classList.toggle("active", el.dataset.path === f.path);
    if (f.conflict) {
      pane._show(f.path, () => D.atom.git.fileDiff(repo, f.path), { sub: `conflicted · ${opName.toLowerCase()} — mine = git ${sides.mine}`, toolsLabel: "Resolve this file:", actions: [h("button", { class: "gitc-act sm mut", title: `Keep my version of this file (git ${sides.mine})`, onclick: () => resolveFiles([f.path], "mine") }, "Keep mine"), h("button", { class: "gitc-act sm mut", title: `Take the incoming version of this file (git ${sides.incoming})`, onclick: () => resolveFiles([f.path], "incoming") }, "Accept incoming"), h("button", { class: "gitc-act primary sm mut", title: "Choose per change (line-level)", onclick: () => openResolver(f.path, repo) }, "Resolve lines…"), openEditor(f)] });
      return;
    }
    const untracked = f.untracked && !f.stagedDelete, unversioned = f.stagedDelete && f.keptOnDisk;
    const view = viewId || C.view || "commit";
    const items = untracked ? [] : unversioned ? [{ id: "commit", label: "Will commit", title: "The removal that a commit of this file lands" }] : [
      { id: "commit", label: "Will commit", title: "HEAD → working tree: exactly what committing this file lands" },
      { id: "staged", label: "Staged", title: "HEAD → index" },
      { id: "unstaged", label: "Unstaged", title: "index → working tree" }];
    const cur = items.some((v) => v.id === view) ? view : "commit";
    const loader = untracked ? () => D.atom.git.fileDiff(repo, f.path)
      : unversioned ? () => D.atom.git.diff(repo, f.path, { staged: true }).then((r) => ({ ...r, note: "The file stops being tracked; it stays on disk." }))
      : cur === "staged" ? () => D.atom.git.diff(repo, f.path, { staged: true })
      : cur === "unstaged" ? () => D.atom.git.diff(repo, f.path)
      : () => D.atom.git.fileDiff(repo, f.path);
    const sub = untracked ? "unversioned · whole file is new" : unversioned ? "unversion · removed from the repo, kept on disk" : cur === "commit" ? (f.orig ? `renamed from ${f.orig} · will commit` : "will commit (HEAD → working tree)") : cur === "staged" ? "staged (HEAD → index)" : "unstaged (index → working tree)";
    pane._show(f.path, loader, { sub, actions: [openEditor(f)], views: items.length > 1 ? { items, current: cur, onPick: (id) => { C.view = id; showWorking(f, id); } } : null });
  };
  const discard = async (paths) => {
    const untracked = paths.filter((p) => { const f = byPath.get(p) || {}; return f.untracked && !f.stagedDelete; });
    const renames = paths.filter((p) => (byPath.get(p) || {}).orig);
    if (!(await confirmDanger(paths.length === 1 ? "Discard changes" : `Discard ${paths.length} files`, `${paths.length === 1 ? `Discard local changes to “${paths[0]}”` : `Discard local changes to ${paths.length} files`} in ${repoName(repo)}? ${untracked.length ? `${untracked.length} unversioned file${untracked.length === 1 ? " is" : "s are"} deleted from disk. ` : ""}${renames.length ? `${renames.length} rename${renames.length === 1 ? " is" : "s are"} undone (original name restored). ` : ""}This cannot be undone.`, "Discard"))) return;
    dropSel(paths);
    const r = await stageAct("Discard", () => D.atom.git.discard(repo, paths));
    if (r && r.ok && r.state === "success") D.toast(`Discarded ${paths.length} file${paths.length === 1 ? "" : "s"}`, "checkCircle", { ms: 2400 });
  };
  const unversion = async (paths) => {
    if (!paths.length) return;
    if (!(await confirmDanger(paths.length === 1 ? "Unversion file" : `Unversion ${paths.length} files`, `Stop tracking ${paths.length === 1 ? `“${paths[0]}”` : `${paths.length} files`}? The file${paths.length === 1 ? "" : "s"} stay on disk and show as Unversioned; commit that removal to make it permanent, and add ${paths.length === 1 ? "it" : "them"} to .gitignore yourself if ${paths.length === 1 ? "it" : "they"} should never be committed.`, "Unversion"))) return;
    dropSel(paths);
    await stageAct("Unversion", () => D.atom.git.untrack(repo, paths));
  };
  // git add: a new file starts being tracked; a just-unversioned file is tracked again.
  const track = async (paths, label) => { if (!paths.length) return; dropSel(paths); await stageAct(label, () => D.atom.git.stage(repo, paths)); };
  const deleteNew = async () => { const paths = selDeletable(); if (!paths.length) { D.toast("<b>Nothing to delete</b><span class=\"toast-sub\">Files you unversioned stay on disk — use Track again to undo, or commit the removal.</span>", "alert", { ms: 4200 }); return; } await discard(paths); };
  // Whole-file resolution: the user's meaning (mine / incoming) is mapped through the
  // OPERATION-AWARE side descriptor from repoState — the same one the line resolver uses.
  const resolveFiles = async (paths, which) => {
    const side = which === "mine" ? sides.mine : sides.incoming;
    const label = which === "mine" ? "Keep mine" : "Accept incoming";
    if (!(await confirmDanger(`${label} for ${paths.length === 1 ? "1 file" : paths.length + " files"}`, `${which === "mine" ? "Your version of each file is kept and the incoming changes to it are dropped." : "The incoming version of each file replaces yours."} (${opName}: this is git's “${side}” side${info.state && info.state.detail ? ` — ${info.state.detail}` : ""}.) A side that deleted the file deletes it.`, label))) return;
    const r = await stageAct(label, () => D.atom.git.resolveWith(repo, paths, side));
    if (r && r.ok && r.results) { const del = r.results.filter((x) => x.action === "deleted").length; if (del) D.toast(`${del} file${del === 1 ? "" : "s"} deleted (that side had removed ${del === 1 ? "it" : "them"})`, "check", { ms: 3200 }); }
  };
  // --- selection plumbing ---
  const bars = [];
  const selBar = (countFn, actions, { always, zeroText } = {}) => { const n = h("span", { class: "gitc-sec-bar-n" }); const bar = h("div", { class: "gitc-sec-bar" }, n, h("div", { class: "gitc-spacer" }), ...actions); bars.push({ bar, countFn, always, zeroText, n }); return bar; };
  const syncBars = () => { for (const b of bars) { const k = b.countFn().length; b.n.textContent = k ? `${k} selected` : (b.zeroText || ""); b.bar.classList.toggle("hidden", !b.always && k === 0); } };
  const refreshChecks = () => {
    for (const cb of scroll.querySelectorAll("input[type=checkbox]")) {
      if (!cb._paths) continue;
      const n = cb._paths.filter((p) => C.sel.has(p)).length;
      cb.checked = n > 0 && n === cb._paths.length; cb.indeterminate = n > 0 && n < cb._paths.length;
    }
    syncBars();
  };
  const setChecked = (paths, on) => { for (const p of paths) { if (on) C.sel.add(p); else C.sel.delete(p); } refreshChecks(); sh.syncCommit(); };
  const checkbox = (paths, title) => { const cb = h("input", { type: "checkbox", class: "aqx-check", title, "aria-label": title, onclick: (e) => { e.stopPropagation(); setChecked(paths, e.currentTarget.checked); } }); cb._paths = paths; return cb; };
  const btn = (label, title, onClick, cls = "") => h("button", { class: "gitc-act sm mut " + cls, title, onclick: onClick }, label);
  const fileActs = (f) => {
    if (f.stagedDelete && f.keptOnDisk) return [iconBtn("plus", "Track again (undo unversion)", () => track([f.path], `Track ${D.baseName(f.path)}`), "mut")];
    if (f.untracked) return [iconBtn("plus", "Move to Versioned (git add)", () => track([f.path], `Version ${D.baseName(f.path)}`), "mut"), iconBtn("trash", "Delete file", () => discard([f.path]), "danger mut")];
    return [f.unstaged ? iconBtn("plus", "Stage", () => stageAct(`Stage ${D.baseName(f.path)}`, () => D.atom.git.stage(repo, [f.path])), "mut") : iconBtn("minus", "Unstage", () => stageAct(`Unstage ${D.baseName(f.path)}`, () => D.atom.git.unstage(repo, [f.path])), "mut"),
      iconBtn("undo", "Discard changes", () => discard([f.path]), "danger mut"),
      iconBtn("moreVert", "More…", (e) => D.showMenuAt(e, [{ label: "Open in editor", icon: "external", onClick: () => D.openInEditor(abs(repo, f.path)) }, { label: "Copy path", icon: "copy", onClick: () => { D.atom.clipboard.write(f.path); D.toast("Copied", "check"); } }, { sep: true }, { label: "Unversion (keep on disk)…", icon: "minus", onClick: () => unversion([f.path]) }, { label: "Discard changes…", icon: "undo", danger: true, onClick: () => discard([f.path]) }]))];
  };
  // --- tree with tri-state checkboxes (windowed when long) ---
  const treeEl = (list, sectionId) => {
    const root = buildTree(list);
    const rows = [];
    const walk = (node, depth) => {
      for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const key = sectionId + ":" + d.path;
        rows.push({ kind: "dir", node: d, depth, key, open: !C.collapsed[key] });
        if (!C.collapsed[key]) walk(d, depth + 1);
      }
      for (const f of node.files.sort((a, b) => a.path.localeCompare(b.path))) rows.push({ kind: "file", f, depth });
    };
    walk(root, 0);
    const render = (r) => {
      if (r.kind === "dir") {
        const kids = descendants(r.node), paths = kids.map((f) => f.path);
        const row = h("div", { class: "gitc-tree-dir" + (r.open ? " open" : ""), style: `--depth:${r.depth}`, "aria-expanded": r.open ? "true" : "false", onclick: () => { if (C.collapsed[r.key]) delete C.collapsed[r.key]; else C.collapsed[r.key] = true; renderChanges(c, gen, { soft: true }); } },
          h("span", { class: "gitc-tree-chev", html: icon("chevron", 12) }), checkbox(paths, "Select all files in this folder"), h("span", { class: "gitc-tree-fico", html: icon(r.open ? "folderOpen" : "folder", 14) }),
          h("span", { class: "gitc-tree-name", text: r.node.name }), h("span", { class: "gitc-col-count", text: String(kids.length) }),
          h("span", { class: "gitc-file-acts" }, iconBtn("check", "Select folder", () => setChecked(paths, true)), iconBtn("minus", "Deselect folder", () => setChecked(paths, false))));
        return rowA11y(row, `Folder ${r.node.name}, ${kids.length} files`);
      }
      const f = r.f;
      const row = h("div", { class: "gitc-tree-file" + (C.diffKey === f.path ? " active" : "") + (f.conflict ? " conflict" : ""), style: `--depth:${r.depth}`, dataset: { path: f.path }, title: `${f.label} · ${f.path}${f.orig ? ` (from ${f.orig})` : ""}`, onclick: () => showWorking(f) },
        checkbox([f.path], `Select ${f.path} for commit`), fileIcon(f.path), h("span", { class: "gitc-tree-name", text: D.baseName(f.path) + (f.orig ? ` ← ${D.baseName(f.orig)}` : "") }),
        f.staged && !f.unstaged && !f.untracked ? h("span", { class: "gitc-staged-dot", title: "Staged" }) : null,
        pm(f), codeChip(f), h("span", { class: "gitc-file-acts" }, ...fileActs(f)));
      return rowA11y(row, `${f.label} ${f.path}`);
    };
    return virtualList(scroll, rows, ROW_H, render, { onRendered: refreshChecks });
  };
  // --- sections ---
  if (!readable) scroll.append(h("div", { class: "gitc-sec-empty", text: s.stale ? "Showing the last successful status — refresh to update." : "The working tree could not be read." }));
  if (conf.length) {
    const target = () => (cSel().length ? cSel() : conf.map((f) => f.path));   // selected conflicts, else all of them
    scroll.append(section({ id: "conflicts", title: "Conflicts", count: conf.length, danger: true, open: !C.collapsed["sec:conflicts"], onToggle: (o) => { C.collapsed["sec:conflicts"] = !o; },
      actions: [checkbox(conf.map((f) => f.path), "Select all conflicted files")],
      bar: selBar(cSel, [
        btn("Keep mine", `Keep MY version of these files (git ${sides.mine}) — drops the incoming changes to them`, () => resolveFiles(target(), "mine")),
        btn("Accept incoming", `Take the INCOMING version of these files (git ${sides.incoming}) — overrides my changes to them`, () => resolveFiles(target(), "incoming")),
        btn("Resolve lines…", "Choose per change, file by file", () => openResolver(cSel()[0], repo), "primary")], { always: true, zeroText: "All conflicted files" }),
      body: h("div", { class: "gitc-tree" }, ...conf.map((f) => rowA11y(h("div", { class: "gitc-tree-file conflict" + (C.diffKey === f.path ? " active" : ""), style: "--depth:0", dataset: { path: f.path }, onclick: () => showWorking(f) },
        checkbox([f.path], `Select ${f.path}`), fileIcon(f.path), h("span", { class: "gitc-tree-name", text: f.path }), h("span", { class: "gitc-code c-U", text: f.conflictKind === "DU" || f.conflictKind === "UD" ? "modify/delete" : f.conflictKind === "AA" ? "add/add" : "Conflict" }),
        h("span", { class: "gitc-file-acts always" }, h("button", { class: "gitc-act sm mut", title: `Keep my version of this file (git ${sides.mine})`, onclick: (e) => { e.stopPropagation(); resolveFiles([f.path], "mine"); } }, "Keep mine"), h("button", { class: "gitc-act sm mut", title: `Take the incoming version of this file (git ${sides.incoming})`, onclick: (e) => { e.stopPropagation(); resolveFiles([f.path], "incoming"); } }, "Accept incoming"), iconBtn("git", "Resolve line by line", () => openResolver(f.path, repo)))), `Conflict ${f.path}`))) }));
  }
  scroll.append(section({ id: "versioned", title: "Versioned", count: versioned.length, open: !C.collapsed["sec:versioned"], onToggle: (o) => { C.collapsed["sec:versioned"] = !o; },
    actions: versioned.length ? [checkbox(versioned.map((f) => f.path), "Select all versioned changes")] : [],
    bar: versioned.length ? selBar(selVersioned, [
      btn("Stage", "Stage the selected files (index only — selection decides what is committed)", () => stageAct("Stage selected", () => D.atom.git.stage(repo, selVersioned()))),
      btn("Unstage", "Unstage the selected files", () => stageAct("Unstage selected", () => D.atom.git.unstage(repo, selVersioned()))),
      btn("Unversion", "Stop tracking the selected files (they stay on disk and move to Unversioned)", () => unversion(selVersioned())),
      btn("Discard", "Discard local changes of the selected files", () => discard(selVersioned()), "danger")]) : null,
    body: versioned.length ? treeEl(versioned, "v") : h("div", { class: "gitc-sec-empty", text: readable ? "No changes to tracked files." : "—" }) }));
  scroll.append(section({ id: "unversioned", title: "Unversioned", count: unversioned.length, open: !C.collapsed["sec:unversioned"], onToggle: (o) => { C.collapsed["sec:unversioned"] = !o; },
    actions: unversioned.length ? [checkbox(unversioned.map((f) => f.path), "Select all unversioned files")] : [],
    bar: unversioned.length ? selBar(selUnversioned, [
      btn("Move to Versioned", "Track the selected files (git add) so they can be committed — also re-tracks files you unversioned", () => track(selUnversioned(), `Version ${selUnversioned().length} file${selUnversioned().length === 1 ? "" : "s"}`), "primary"),
      btn("Delete", "Delete the selected NEW files from disk (files you unversioned are kept)", deleteNew, "danger")]) : null,
    body: unversioned.length ? treeEl(unversioned, "u") : h("div", { class: "gitc-sec-empty", text: readable ? "No unversioned files." : "—" }) }));
  if (!files.length && readable) scroll.append(empty("checkCircle", "Working tree clean", `Nothing to commit on ${s.branch || "this branch"}${s.unborn ? " (no commits yet)" : ""}.`));
  scroll.scrollTop = scrollTop;
  // --- commit box wiring for this render ---
  sh.bind({ repo, files, byPath, conf, selected, info, readable });
  refreshChecks();
  // diff pane: a conflicted file first (it needs the user's decision), else the file the user
  // clicked (kept across refreshes) — never an automatic preview of some other file
  const cur = C.diffKey && byPath.get(C.diffKey);
  if (conf.length && !(cur && cur.conflict)) showWorking(conf[0]);
  else if (cur) showWorking(cur);
  else { C.diffKey = null; pane._placeholder(!readable ? "The working tree could not be read." : files.length ? "Click a file to see its changes." : "Nothing to show — the working tree is clean."); }
  if (!alive(gen)) return;
}
// Shell = left column (sections scroller + commit box) and the diff pane. Built once per repo.
export function buildChangesShell(repo) {
  const C = per(repo).chg;
  const left = h("div", { class: "gitc-chg-left" });
  const scroll = h("div", { class: "gitc-chg-scroll", style: "position:relative" });
  const pane = diffPane();
  const ta = h("textarea", { class: "gitc-msg", placeholder: "Commit message", rows: "3", spellcheck: "true", "aria-label": "Commit message" });
  ta.value = C.msg || "";
  const amend = h("input", { type: "checkbox", class: "aqx-check", "aria-label": "Amend the last commit" }); amend.checked = !!C.amend;
  const commitBtn = h("button", { class: "gitc-act primary mut commitbtn" }, h("span", { html: icon("commit", 14) }), "Commit");
  const commitPushBtn = h("button", { class: "gitc-act mut commitpushbtn" }, h("span", { html: icon("push", 14) }), "Commit & Push");
  const selInfo = h("span", { class: "gitc-muted selinfo", role: "status" });
  const box = h("div", { class: "gitc-commitbox" }, ta, h("div", { class: "gitc-commit-row" }, h("label", { class: "gitc-check" }, amend, h("span", { text: "Amend" })), selInfo), h("div", { class: "gitc-commit-btns" }, commitPushBtn, commitBtn));
  left.append(scroll, box);
  const root = splitPane([left, pane], { key: "changes", sizes: [400], min: 280 });
  const sh = { repo, root, left, scroll, pane, ta, amend, commitBtn, commitPushBtn, selInfo, ctx: null };
  sh.syncCommit = () => {
    const x = sh.ctx; if (!x) return;
    const n = x.selected().filter((p) => !x.byPath.get(p).conflict).length;
    const canAmend = !(x.info && x.info.unborn);
    amend.disabled = !canAmend; amend.title = canAmend ? "" : "No commit to amend yet";
    const ok = x.readable && !x.conf.length && !S.inflight.get(repo) && ((C.amend && canAmend) || (n && ta.value.trim()));
    commitBtn.disabled = !ok; commitPushBtn.disabled = !ok || !!(x.info && x.info.unborn);
    commitBtn.lastChild.textContent = C.amend ? (n ? `Amend (${n})` : "Amend message") : (n ? `Commit (${n})` : "Commit");
    selInfo.textContent = !x.readable ? "Repository state unavailable" : x.conf.length ? "Resolve conflicts before committing" : (n ? `${n} file${n === 1 ? "" : "s"} selected${C.amend ? " → rewrites the last commit" : ""}` : (C.amend ? "Message-only amend (keeps the commit's files)" : "Select files to commit"));
  };
  sh.bind = (ctx) => { sh.ctx = ctx; sh.syncCommit(); };
  ta.addEventListener("input", () => { C.msg = ta.value; sh.syncCommit(); });
  ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !commitBtn.disabled) { e.preventDefault(); doCommit(false); } });
  amend.addEventListener("change", () => { C.amend = amend.checked; sh.syncCommit(); });
  /* Commit EXACTLY the selected path operations through the reviewed CommitPlan
   * (temporary index in main: unrelated staged work is untouched, renames travel as
   * pairs, unversion intent is honoured, hooks/signing run). Amend with a selection
   * rewrites HEAD with only those paths; without one it is message-only. */
  const doCommit = async (push, anchor) => {
    const x = sh.ctx; if (!x || commitBtn.disabled) return;
    const msg = ta.value.trim();
    const items = x.selected().map((p) => x.byPath.get(p)).filter((f) => f && !f.conflict).map(planItem);
    const wasAmend = !!C.amend;
    const expectHead = x.info && x.info.headOid ? x.info.headOid : undefined;
    if (wasAmend && !(await confirmDanger("Amend last commit", (items.length ? `Rewrites the most recent commit of ${repoName(repo)} with ONLY the ${items.length} selected file${items.length === 1 ? "" : "s"}` : `Rewrites the most recent commit of ${repoName(repo)}, keeping its files`) + (msg ? " and the new message." : ".") + " Other staged work stays staged and is not included. Don't amend commits that were already pushed.", "Amend"))) return;
    const r = await act(wasAmend ? "Amend" : "Commit", () => D.atom.git.commitPlan(repo, { message: msg, paths: items, amend: wasAmend, expectHead }), { repo, silent: true, refresh: false });
    if (!r || !r.committed) { await refreshRepo(repo); return; }
    C.msg = ""; C.amend = false; ta.value = ""; amend.checked = false;
    if (r.state === "success") D.toast(wasAmend ? `Amended ${D.esc(String(r.commit || "").slice(0, 7))} in ${D.esc(repoName(repo))}` : `Committed ${items.length} file${items.length === 1 ? "" : "s"} → ${D.esc(String(r.commit || "").slice(0, 7))} in ${D.esc(repoName(repo))}`, "checkCircle", { ms: 2600 });
    await refreshRepo(repo);
    if (push && r.state === "success") await doPush({ repo, anchor: anchor || q(".gitc-act.pushbtn") });
  };
  commitBtn.addEventListener("click", () => doCommit(false));
  commitPushBtn.addEventListener("click", (e) => doCommit(true, e.currentTarget));
  return sh;
}
