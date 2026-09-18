/* AtomNano renderer — Merge-conflict resolver — one card per conflict.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { refreshComposer } from "../chat/composer.js";
import { renderChat, synthesizeSession } from "../chat/navigation.js";
import { addTabState, renderTabs } from "../chat/tabs.js";
import { assembleResolved, isFullyResolved, normalizeForEdit, parseConflicts, previewFor, restoreFormat } from "../conflicts.js";
import { $, baseName, closeModal, confirmDialog, h, modalShell, showContextMenu, toast } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { openInEditor } from "../editor/editor-pane.js";
import { icon } from "../icons.js";
import { renderChanges } from "../panels/changes.js";
import { persistTabs } from "../workspace/projects.js";
import { refreshTree, renderSidebar } from "../workspace/sidebar.js";
import { gitMergeAbort } from "./branches.js";
import { gitBranchOf, refreshGit } from "./sidebar.js";
import { esc, repoName } from "./titlebar.js";

/* ============================================================
   MERGE CONFLICT RESOLVER — guided, card-per-conflict UI.
   Each conflict is one click to keep Mine / Incoming / Both, or edit by hand;
   cards collapse to the resolved result as you go, then "Complete" continues
   the operation.

   Conflict SESSION contract (audit 2026-09-09, GIT-006/007/021/025/026/027):
   · every load and save is bound to { repo, path, generation }; a slower, older
     read can never replace another file's content, and a save only ever writes
     the file it was loaded from;
   · per-file drafts (choices + custom text) live in _merge.sessions[path] and
     survive navigation; closing with unsaved choices asks first;
   · "Mine" / "Incoming" are mapped through the OPERATION-AWARE side descriptor
     from repoState() (rebase / cherry-pick / revert swap git's ours/theirs) — the
     same descriptor Git Center's whole-file buttons use, so both agree;
   · modify/delete, binary, unreadable and oversized files get WHOLE-FILE choices
     (resolveWith) instead of an empty line editor; unterminated markers are kept
     verbatim and block "resolved" until fixed by hand;
   · a save keeps the file's EOL / BOM / final-newline, is checked against the
     bytes that were loaded (writeChecked) and stages only after it succeeded;
   · Complete/Continue may legitimately stop at the NEXT conflict of a rebase or
     sequence: the resolver stays open and shows it — no completion toast.
   ============================================================ */
export const _merge = { repo: "", files: [], index: 0, path: "", parsed: null, choices: {}, custom: {}, gen: 0, sessions: {}, sides: { mine: "ours", incoming: "theirs" }, op: "merge", opDetail: "", fileInfo: null };
export function conflictedFiles(repo) {
  const s = state.git.statuses[repo];
  return ((s && s.files) || []).filter((f) => f.conflict).map((f) => f.path);
}
export const mergeOpName = () => ({ merge: "merge", rebase: "rebase", "cherry-pick": "cherry-pick", revert: "revert", bisect: "bisect" })[_merge.op] || "merge";
export const mergeOpTitle = () => { const n = mergeOpName(); return n.charAt(0).toUpperCase() + n.slice(1); };
// The user's meaning → the marker side git uses for it in THIS operation.
export const mineChoice = () => _merge.sides.mine || "ours";
export const incomingChoice = () => _merge.sides.incoming || "theirs";
export const bothChoice = () => (mineChoice() === "ours" ? "both" : "both-rev");          // mine first, then incoming
export const mineLines = (seg) => (mineChoice() === "ours" ? seg.ours : seg.theirs);
export const incomingLines = (seg) => (mineChoice() === "ours" ? seg.theirs : seg.ours);
// Accepts a MEANING ("mine" | "incoming" | "both") or a raw git side ("ours" | "theirs" | "both-rev" | "custom").
export function mapChoice(choice) { return choice === "mine" ? mineChoice() : choice === "incoming" ? incomingChoice() : choice === "both" ? bothChoice() : choice; }
export function choiceLabel(choice) {
  if (choice === mineChoice()) return "Mine";
  if (choice === incomingChoice()) return "Incoming";
  if (choice === "both" || choice === "both-rev") return choice === bothChoice() ? "Both (mine + incoming)" : "Both (incoming + mine)";
  if (choice === "custom") return "Edited";
  return "Resolved";
}
export async function loadOpState(repo) {
  try { const st = await atom.git.repoState(repo); _merge.sides = (st && st.sides) || { mine: "ours", incoming: "theirs" }; _merge.op = (st && st.op) || "merge"; _merge.opDetail = (st && st.detail) || ""; }
  catch { _merge.sides = { mine: "ours", incoming: "theirs" }; _merge.op = "merge"; _merge.opDetail = ""; }
}
// Open the resolver for a repo, starting at a specific file (or the first conflict).
// `explicitFiles` lets a caller that already knows the conflicted paths (Git Center)
// open the resolver without depending on the sidebar's git state being loaded.
export async function openConflictResolver(repo, startPath, explicitFiles) {
  const files = (Array.isArray(explicitFiles) && explicitFiles.length) ? explicitFiles : conflictedFiles(repo);
  if (!files.length) { toast("No conflicts to resolve", "check"); return; }
  if (_merge.repo !== repo) _merge.sessions = {};          // drafts are repo-local
  _merge.repo = repo;
  _merge.files = files;
  _merge.index = Math.max(0, files.indexOf(startPath));
  await loadOpState(repo);
  bindMergeKeys();
  await loadConflictFile();
}
/* Load the current file. Bound to { repo, path, gen }: whatever lands after the
 * user moved on (or the overlay closed) is dropped instead of displayed. */
export async function loadConflictFile() {
  const back = ensureMergeOverlay();
  const repo = _merge.repo;
  const path = _merge.files[_merge.index];
  const gen = ++_merge.gen;
  _merge.path = path; _merge.parsed = null; _merge.fileInfo = null;
  const sess = _merge.sessions[path] || (_merge.sessions[path] = { choices: {}, custom: {}, raw: null, fmt: null, saved: false });
  _merge.choices = sess.choices; _merge.custom = sess.custom;     // per-file draft, shared by reference
  const body = back.querySelector(".merge-body");
  body.innerHTML = "";
  body.append(h("div", { class: "diff-loading" }, h("span", { html: icon("spinner", 22, "spin") }), h("span", { text: "Loading conflicts…" })));
  const abs = repo.replace(/[\\/]+$/, "") + "/" + path;
  const [data, stages, st] = await Promise.all([
    atom.files.read(abs).catch((e) => ({ error: e.message })),
    atom.git.conflictStages(repo, path).catch(() => null),
    atom.git.repoState(repo).catch(() => null),
  ]);
  if (back !== document.querySelector(".merge-overlay") || _merge.repo !== repo || _merge.path !== path || _merge.gen !== gen) return;   // stale: another file / repo is showing now
  if (st) { _merge.sides = st.sides || _merge.sides; _merge.op = st.op || _merge.op; _merge.opDetail = st.detail || ""; }
  const readable = data && !data.error && !data.isBinary && !data.tooLarge;
  const fmt = readable ? normalizeForEdit(data.content || "") : null;
  sess.raw = data && !data.error && !data.isBinary && !data.tooLarge ? (data.content == null ? "" : data.content) : null;
  sess.fmt = fmt; sess.saved = false;
  const kind = stages && stages.modifyDelete ? "modifyDelete" : (stages && stages.binary) || (data && data.isBinary) ? "binary" : data && data.tooLarge ? "tooLarge" : data && data.error ? "error" : "text";
  _merge.fileInfo = { stages, data, kind, error: data && data.error };
  _merge.parsed = readable ? parseConflicts(fmt.text) : { segments: [], count: 0, malformed: [], markerSize: 7 };
  // choices for conflict ids that no longer exist (the file changed) are dropped
  const ids = new Set(_merge.parsed.segments.filter((s) => s.type === "conflict").map((s) => s.id));
  for (const k of Object.keys(sess.choices)) if (!ids.has(+k)) { delete sess.choices[k]; delete sess.custom[k]; }
  renderMergeFile();
}
export function ensureMergeOverlay() {
  let back = document.querySelector(".merge-overlay");
  if (back) return back;
  back = h("div", { class: "merge-overlay", onmousedown: (e) => { if (e.target === back) closeMerge(); } });
  const panel = h("div", { class: "merge-panel", role: "dialog", "aria-modal": "true", "aria-label": "Resolve conflicts", tabindex: "-1" },
    h("div", { class: "merge-head" },
      h("span", { class: "mgh-ico", html: icon("git", 17) }),
      h("div", { class: "mgh-title" }, h("span", { class: "mgh-name" }), h("span", { class: "mgh-sub" })),
      h("div", { class: "mgh-progress" }, h("span", { class: "mgh-bar" }, h("span", { class: "mgh-bar-fill" })), h("span", { class: "mgh-count" })),
      h("div", { class: "dfh-spacer" }),
      h("button", { class: "dfh-btn", title: "Previous conflicted file  [", "aria-label": "Previous file", html: icon("chevron", 16, "flip"), onclick: () => navMergeFile(-1) }),
      h("button", { class: "dfh-btn", title: "Next conflicted file  ]", "aria-label": "Next file", html: icon("chevron", 16), onclick: () => navMergeFile(1) }),
      h("button", { class: "dfh-btn close", title: "Close  Esc", "aria-label": "Close", html: icon("close", 16), onclick: () => closeMerge() })),
    h("div", { class: "merge-toolbar" },
      h("div", { class: "mg-legend" },
        h("span", { class: "mg-chip current" }, h("i"), h("span", { class: "mgl-cur", text: "Mine" })),
        h("span", { class: "mg-chip incoming" }, h("i"), h("span", { class: "mgl-inc", text: "Incoming" })),
        h("span", { class: "mg-chip op", title: "Which git side each label maps to in this operation" }, h("span", { class: "mgl-op" }))),
      h("div", { class: "dfh-spacer" }),
      h("button", { class: "mg-bulk", title: "Keep MY version for every conflict in this file (overrides the incoming changes)", onclick: () => bulkResolve("mine") }, "Keep all mine"),
      h("button", { class: "mg-bulk", title: "Accept the INCOMING version for every conflict in this file (overrides my changes)", onclick: () => bulkResolve("incoming") }, "Accept all incoming")),
    h("div", { class: "merge-body" }),
    h("div", { class: "merge-foot" },
      h("span", { class: "mgf-status", role: "status" }),
      h("div", { class: "dfh-spacer" }),
      h("button", { class: "btn btn-ghost", id: "mgAbort", text: "Abort merge", onclick: async () => { const op = mergeOpName(); if (await confirmDialog({ title: `Abort ${op}`, danger: true, message: `Abort the ${op} in ${repoName(_merge.repo)} and return to the state before it started? Unsaved resolution choices are discarded.`, confirmLabel: "Abort" })) { closeMerge({ force: true }); gitMergeAbort(_merge.repo); } } }),
      h("button", { class: "btn btn-ghost", id: "mgResolveFile", text: "Mark file resolved", onclick: () => markFileResolved() }),
      h("button", { class: "btn btn-primary", id: "mgComplete", text: "Complete merge", onclick: () => completeMerge() })));
  back.append(panel);
  $("modalRoot").append(back);
  setTimeout(() => { try { if (back.isConnected) panel.focus({ preventScroll: true }); } catch { /* */ } }, 0);
  return back;
}
export function renderMergeFile() {
  const back = document.querySelector(".merge-overlay");
  if (!back) return;
  const p = _merge.parsed, fi = _merge.fileInfo || { kind: "text" };
  const opT = mergeOpTitle();
  back.querySelector(".mgh-name").textContent = baseName(_merge.path);
  const dir = _merge.path.includes("/") ? _merge.path.slice(0, _merge.path.lastIndexOf("/")) + "/ · " : "";
  back.querySelector(".mgh-sub").textContent = dir + repoName(_merge.repo) + `  ·  ${opT}${_merge.opDetail ? " " + _merge.opDetail : ""}`
    + (_merge.files.length > 1 ? `  ·  file ${_merge.index + 1}/${_merge.files.length}` : "");
  // Labels: concrete branch/commit names from the markers, mapped through the side descriptor.
  const firstC = p.segments.find((s) => s.type === "conflict");
  const oursLabel = firstC ? (firstC.oursLabel || "HEAD") : "HEAD", theirsLabel = firstC ? (firstC.theirsLabel || "incoming") : "incoming";
  const mineLabel = (mineChoice() === "ours" ? oursLabel : theirsLabel).replace(/^HEAD$/, gitBranchOf(_merge.repo) || "HEAD");
  const incLabel = mineChoice() === "ours" ? theirsLabel : oursLabel;
  back.querySelector(".mgl-cur").textContent = "Mine · " + mineLabel;
  back.querySelector(".mgl-inc").textContent = "Incoming · " + incLabel;
  back.querySelector(".mgl-op").textContent = `${opT}: mine = git ${mineChoice()}, incoming = git ${incomingChoice()}`;
  back.querySelector("#mgAbort").textContent = `Abort ${mergeOpName()}`;
  back.querySelector("#mgComplete").textContent = _merge.op === "merge" ? "Complete merge" : `Continue ${mergeOpName()}`;
  const body = back.querySelector(".merge-body");
  body.innerHTML = "";
  if (fi.kind !== "text") { body.append(renderFileLevelCard(fi)); updateMergeProgress(); return; }
  if (p.malformed && p.malformed.length) body.append(h("div", { class: "mg-card malformed" }, h("div", { class: "mgc-bar" }, h("span", { class: "mgc-warn", html: icon("alert", 13) }), h("span", { class: "mgc-title", text: `${p.malformed.length} unterminated conflict block${p.malformed.length === 1 ? "" : "s"} kept verbatim` }), h("div", { class: "dfh-spacer" }), h("button", { class: "mgc-change", onclick: () => openInEditor(_merge.repo.replace(/[\\/]+$/, "") + "/" + _merge.path) }, "Open in editor")), h("div", { class: "mg-note", text: `Markers of width ${p.markerSize} did not close properly (starting at line${p.malformed.length === 1 ? "" : "s"} ${p.malformed.map((m) => m.startLine + 1).join(", ")}). Nothing was dropped; fix the block by hand, then reload this file.` })));
  for (const seg of p.segments) {
    if (seg.type === "text") {
      if (seg.lines.length === 1 && seg.lines[0] === "") continue;
      body.append(h("pre", { class: "mg-context", text: seg.lines.join("\n") }));
    } else {
      body.append(renderConflictCard(seg));
    }
  }
  if (!p.count && !(p.malformed && p.malformed.length)) body.append(h("div", { class: "mg-card" }, h("div", { class: "mg-note", text: "No conflict markers in this file (it may already be resolved). Mark it resolved to stage it, or take a whole side below." }), fileLevelButtons(fi)));
  updateMergeProgress();
}
// Whole-file choices for content the line resolver cannot handle. The deleted side
// of a modify/delete conflict is honoured as a deletion (never a failing checkout).
export function renderFileLevelCard(fi) {
  const st = fi.stages || {};
  const mineStage = mineChoice() === "ours" ? st.ours : st.theirs, incStage = mineChoice() === "ours" ? st.theirs : st.ours;
  const why = fi.kind === "modifyDelete" ? `One side deleted this file while the other changed it. ${!mineStage ? "Your side (mine) deleted it" : "The incoming side deleted it"}; the other side kept it${mineStage && incStage ? "" : " modified"}.`
    : fi.kind === "binary" ? "This is a binary file — there is no line-level merge. Take one whole side."
    : fi.kind === "tooLarge" ? `This file is too large to resolve line by line here (${(fi.data.size / 1048576).toFixed(1)} MB). Take one whole side, or resolve it in your editor and mark it resolved.`
    : `The file could not be read${fi.error ? ": " + fi.error : ""}. Take one whole side, or fix it in your editor.`;
  return h("div", { class: "mg-card filelevel" },
    h("div", { class: "mgc-bar" }, h("span", { class: "mgc-warn", html: icon("alert", 13) }), h("span", { class: "mgc-title", text: fi.kind === "modifyDelete" ? "Modify / delete conflict" : fi.kind === "binary" ? "Binary conflict" : fi.kind === "tooLarge" ? "File too large for line resolution" : "File unreadable" })),
    h("div", { class: "mg-note", text: why }),
    fileLevelButtons(fi));
}
export function fileLevelButtons(fi) {
  const st = (fi && fi.stages) || {};
  const mineStage = mineChoice() === "ours" ? st.ours : st.theirs, incStage = mineChoice() === "ours" ? st.theirs : st.ours;
  const has = !!(fi && fi.stages);
  return h("div", { class: "mgc-actions filelevel" },
    h("button", { class: "mgc-act cur", title: `git checkout --${mineChoice()} (whole file)`, onclick: () => resolveWholeFile("mine") }, has && !mineStage ? "Keep mine (deletes the file)" : "Keep mine (whole file)"),
    h("button", { class: "mgc-act inc", title: `git checkout --${incomingChoice()} (whole file)`, onclick: () => resolveWholeFile("incoming") }, has && !incStage ? "Accept incoming (deletes the file)" : "Accept incoming (whole file)"),
    h("button", { class: "mgc-act edit", title: "Open the file in the editor", onclick: () => openInEditor(_merge.repo.replace(/[\\/]+$/, "") + "/" + _merge.path) }, h("span", { html: icon("pencil", 13) }), "Edit"));
}
export async function resolveWholeFile(which) {
  const repo = _merge.repo, rel = _merge.path, gen = _merge.gen;
  const side = which === "mine" ? mineChoice() : incomingChoice();
  let r;
  try { r = await atom.git.resolveWith(repo, [rel], side); } catch (e) { toast(`Couldn't resolve ${esc(baseName(rel))}: ${esc(e.message)}`, "alert", { ms: 6000 }); return; }
  if (!r || !r.ok) { toast(`Couldn't resolve ${esc(baseName(rel))}: ${esc((r && r.results && r.results[0] && r.results[0].error) || (r && r.error) || "failed")}`, "alert", { ms: 6000 }); return; }
  const deleted = (r.results || []).some((x) => x.action === "deleted");
  toast(deleted ? `${esc(baseName(rel))} deleted (that side had removed it) and staged` : `${esc(baseName(rel))}: kept ${which === "mine" ? "your" : "the incoming"} version and staged`, "checkCircle", { ms: 3000 });
  if (_merge.repo !== repo || _merge.path !== rel || _merge.gen !== gen) return;
  delete _merge.sessions[rel];
  await afterFileResolved(repo);
}
export function renderConflictCard(seg) {
  const choice = _merge.choices[seg.id];
  const card = h("div", { class: "mg-card" + (choice ? " resolved" : ""), dataset: { id: String(seg.id) } });
  if (choice) {
    // collapsed → show the resolved result with a way to change it
    const resultText = choice === "custom" ? (_merge.custom[seg.id] || "") : previewFor(seg, choice);
    card.append(
      h("div", { class: "mgc-bar resolved" },
        h("span", { class: "mgc-tick", html: icon("checkCircle", 14) }),
        h("span", { class: "mgc-kept", text: "Kept: " + choiceLabel(choice) }),
        h("div", { class: "dfh-spacer" }),
        h("button", { class: "mgc-change", onclick: () => { delete _merge.choices[seg.id]; renderMergeFile(); } }, "Change")),
      h("pre", { class: "mg-result", text: resultText }));
    return card;
  }
  // open → choices + the two sides (mine on the left, whatever git side that is)
  card.append(
    h("div", { class: "mgc-bar" },
      h("span", { class: "mgc-warn", html: icon("alert", 13) }),
      h("span", { class: "mgc-title", text: "Conflict #" + (seg.id + 1) }),
      h("div", { class: "dfh-spacer" }),
      h("div", { class: "mgc-actions" },
        h("button", { class: "mgc-act cur", title: `Keep my changes (1) — git ${mineChoice()}`, onclick: () => resolveConflict(seg.id, "mine") }, "Keep mine"),
        h("button", { class: "mgc-act inc", title: `Accept the incoming changes (2) — git ${incomingChoice()}`, onclick: () => resolveConflict(seg.id, "incoming") }, "Accept incoming"),
        h("button", { class: "mgc-act both", title: "Keep both, mine first (3)", onclick: () => resolveConflict(seg.id, "both") }, "Both"),
        h("button", { class: "mgc-act edit", title: "Edit manually", "aria-label": "Edit manually", onclick: () => editConflict(seg.id) }, h("span", { html: icon("pencil", 13) })))),
    h("div", { class: "mgc-sides" },
      sidePane("current", mineLines(seg), () => resolveConflict(seg.id, "mine")),
      sidePane("incoming", incomingLines(seg), () => resolveConflict(seg.id, "incoming"))));
  return card;
}
export function sidePane(kind, lines, onAccept) {
  const el = h("div", { class: "mgc-side " + kind, onclick: onAccept, title: "Click to keep this side", role: "button", tabindex: "0" },
    h("div", { class: "mgs-lines" }, h("pre", { text: lines.join("\n") || " " })));
  el.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); onAccept(); } });
  return el;
}
export function resolveConflict(id, choice) {
  _merge.choices[id] = mapChoice(choice);
  delete _merge.custom[id];
  renderMergeFile();
}
export function editConflict(id) {
  const seg = _merge.parsed.segments.find((s) => s.type === "conflict" && s.id === id);
  if (!seg) return;
  const initial = _merge.choices[id] === "custom" ? (_merge.custom[id] || "") : previewFor(seg, _merge.choices[id] || bothChoice());
  const card = document.querySelector(`.mg-card[data-id="${id}"]`);
  if (!card) return;
  card.innerHTML = "";
  const ta = h("textarea", { class: "mgc-editor", spellcheck: "false", "aria-label": `Edit conflict ${id + 1}` });
  ta.value = initial;
  card.append(
    h("div", { class: "mgc-bar" }, h("span", { class: "mgc-title", text: "Edit conflict #" + (id + 1) }),
      h("div", { class: "dfh-spacer" }),
      h("button", { class: "mgc-act both", onclick: () => { _merge.custom[id] = ta.value; _merge.choices[id] = "custom"; renderMergeFile(); } }, "Save"),
      h("button", { class: "mgc-change", onclick: () => renderMergeFile() }, "Cancel")),
    ta);
  setTimeout(() => ta.focus(), 20);
}
export function bulkResolve(choice) {
  const c = mapChoice(choice);
  for (const seg of _merge.parsed.segments) if (seg.type === "conflict") { _merge.choices[seg.id] = c; delete _merge.custom[seg.id]; }
  renderMergeFile();
}
export function mergeResolvedCount() { return _merge.parsed ? _merge.parsed.segments.filter((s) => s.type === "conflict" && _merge.choices[s.id]).length : 0; }
export function mergeHasDrafts() { return Object.values(_merge.sessions).some((s) => s && !s.saved && Object.keys(s.choices || {}).length); }
export function updateMergeProgress() {
  const back = document.querySelector(".merge-overlay");
  if (!back) return;
  const total = _merge.parsed ? _merge.parsed.count : 0;
  const done = mergeResolvedCount();
  const fi = _merge.fileInfo || { kind: "text" };
  const malformed = _merge.parsed && _merge.parsed.malformed ? _merge.parsed.malformed.length : 0;
  back.querySelector(".mgh-count").textContent = `${done}/${total}`;
  back.querySelector(".mgh-bar-fill").style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
  const textOk = fi.kind === "text" && _merge.parsed && isFullyResolved(_merge.parsed, _merge.choices);
  const resolveBtn = back.querySelector("#mgResolveFile");
  resolveBtn.disabled = !textOk;
  resolveBtn.textContent = _merge.files.length > 1 ? "Resolve file & next" : "Mark file resolved";
  back.querySelector(".mgf-status").textContent = fi.kind !== "text" ? "Choose a whole side for this file."
    : malformed ? `${malformed} malformed conflict block${malformed === 1 ? "" : "s"} — fix by hand before marking resolved.`
    : textOk ? (total ? "All conflicts in this file resolved." : "No markers left — mark the file resolved to stage it.")
    : `${total - done} conflict${total - done === 1 ? "" : "s"} left in this file.`;
}
/* Write the resolved file (original EOL/BOM/final-newline restored; only if the file
 * still holds the bytes that were loaded), stage it, then advance to the next
 * conflicted file — or show "all set" when this was the last one. */
export async function markFileResolved() {
  const repo = _merge.repo, rel = _merge.path, gen = _merge.gen;
  const sess = _merge.sessions[rel];
  if (!sess || !_merge.parsed || !isFullyResolved(_merge.parsed, _merge.choices)) { toast("Resolve every conflict in this file first", "alert"); return; }
  const content = restoreFormat(assembleResolved(_merge.parsed, _merge.choices, _merge.custom), sess.fmt || {});
  const abs = repo.replace(/[\\/]+$/, "") + "/" + rel;
  let w;
  try { w = await atom.files.writeChecked(abs, content, sess.raw); }
  catch (e) { toast("Couldn't save resolution: " + esc(e.message), "alert", { ms: 6000 }); return; }
  if (!w || !w.ok) {
    toast(`<b>${esc(baseName(rel))} changed on disk</b><span class="toast-sub">Another editor or process modified it since it was loaded. Nothing was written; reloading it now.</span>`, "alert", { ms: 6500 });
    if (_merge.repo === repo && _merge.path === rel && _merge.gen === gen) await loadConflictFile();
    return;
  }
  try { await atom.git.stage(repo, [rel]); }
  catch (e) { toast(`Saved ${esc(baseName(rel))}, but staging failed: ${esc(e.message)}`, "alert", { ms: 6000 }); return; }
  sess.saved = true;
  if (_merge.repo !== repo || _merge.gen !== gen) return;   // the user moved on while saving — the saved file is done, the view is theirs
  await afterFileResolved(repo);
}
// After a file is resolved+staged: re-read the conflict list from git (never from stale sidebar state) and continue.
export async function afterFileResolved(repo) {
  await refreshGit();
  let remaining = conflictedFiles(repo);
  try { const st = await atom.git.status(repo); if (st && st.files) remaining = st.files.filter((f) => f.conflict).map((f) => f.path); } catch { /* keep sidebar view */ }
  if (_merge.repo !== repo || !document.querySelector(".merge-overlay")) return;
  _merge.files = remaining;
  if (!remaining.length) { toast(`Resolved ${esc(repoName(repo))} — ready to ${_merge.op === "merge" ? "complete the merge" : "continue the " + mergeOpName()}`, "checkCircle", { ms: 3000 }); renderMergeDone(); return; }
  _merge.index = 0;
  await loadConflictFile();
}
export function renderMergeDone() {
  const back = document.querySelector(".merge-overlay");
  if (!back) return;
  _merge.path = ""; _merge.parsed = null; _merge.fileInfo = null;
  back.querySelector(".merge-body").innerHTML = "";
  back.querySelector(".merge-body").append(h("div", { class: "merge-allset" },
    h("span", { class: "ms-ic", html: icon("checkCircle", 40) }),
    h("div", { class: "ms-title", text: "All conflicts resolved" }),
    h("div", { class: "ms-sub", text: _merge.op === "merge" ? "Click “Complete merge” to create the merge commit." : `Click “Continue ${mergeOpName()}” — it may stop again at the next conflicting commit.` })));
  back.querySelector(".mgh-name").textContent = repoName(_merge.repo);
  back.querySelector(".mgh-sub").textContent = `${mergeOpTitle()} · ready to continue`;
  back.querySelector("#mgResolveFile").disabled = true;
  back.querySelector(".mgh-bar-fill").style.width = "100%";
  back.querySelector(".mgh-count").textContent = "done";
  back.querySelector(".mgf-status").textContent = "Every conflicted file is resolved + staged.";
}
/* Continue the operation. The backend dispatches merge / rebase / cherry-pick / revert
 * --continue from the repo's real state and may report the NEXT conflict of a sequence:
 * then the resolver reloads and stays open — a completion toast is shown only when the
 * operation has actually finished. */
export async function completeMerge() {
  const repo = _merge.repo;
  let remaining = conflictedFiles(repo);
  try { const st = await atom.git.status(repo); if (st && st.files) remaining = st.files.filter((f) => f.conflict).map((f) => f.path); } catch { /* use sidebar view */ }
  if (remaining.length) { toast("Resolve the remaining conflicts first", "alert"); _merge.files = remaining; _merge.index = 0; await loadConflictFile(); return; }
  const opT = mergeOpTitle();
  let r;
  try { r = await atom.git.mergeContinue(repo); }
  catch (e) { toast(`Couldn't complete the ${esc(mergeOpName())}: ${esc(e.message)}`, "alert", { ms: 6000 }); return; }
  await refreshGit(); refreshTree(true);
  if (r && (r.conflict || r.state === "conflict" || r.stillInProgress)) {
    await loadOpState(repo);
    let files = [];
    try { const st = await atom.git.status(repo); files = ((st && st.files) || []).filter((f) => f.conflict).map((f) => f.path); } catch { /* */ }
    toast(`<b>${esc(opT)} continues — ${files.length ? `${files.length} conflicted file${files.length === 1 ? "" : "s"} in the next commit` : "stopped again"}</b><span class="toast-sub">${esc(_merge.opDetail || "")}${files.length ? " Resolve them, then continue again." : " Check the banner in the Changes view."}</span>`, "alert", { ms: 7000 });
    if (!document.querySelector(".merge-overlay")) return;
    _merge.sessions = {};
    if (files.length) { _merge.files = files; _merge.index = 0; await loadConflictFile(); } else renderMergeDone();
    return;
  }
  if (r && r.ok === false) { toast(`<b>${esc(opT)} did not complete</b><span class="toast-sub">${esc(r.error || r.output || r.state || "")}</span>`, "alert", { ms: 7000 }); return; }
  closeMerge({ force: true });
  toast(`<b>${esc(opT)} completed on ${esc(repoName(repo))}</b><span class="toast-sub">Now on ${esc((r && r.branch) || "")}.</span>`, "checkCircle", { ms: 4200 });
}
export function navMergeFile(delta) {
  const files = conflictedFiles(_merge.repo).length ? conflictedFiles(_merge.repo) : (_merge.files || []);
  if (files.length < 2) return;
  _merge.files = files;
  _merge.index = (_merge.index + delta + files.length) % files.length;
  loadConflictFile();   // drafts of the file we leave stay in _merge.sessions
}
// Close the resolver. Unsaved resolution choices are confirmed first (force skips that).
export function closeMerge({ force } = {}) {
  const b = document.querySelector(".merge-overlay");
  if (!b) return;
  const really = () => {
    b.remove();
    _merge.gen++;
    if (_mergeKeyHandler) { document.removeEventListener("keydown", _mergeKeyHandler, true); _mergeKeyHandler = null; }
  };
  if (!force && mergeHasDrafts()) {
    confirmDialog({ title: "Discard resolution choices?", danger: true, message: "Some conflict choices in this session were not saved (Mark file resolved). Close anyway and discard them?", confirmLabel: "Discard & close" }).then((ok) => { if (ok) { _merge.sessions = {}; really(); } });
    return;
  }
  really();
}
export let _mergeKeyHandler = null;
export function bindMergeKeys() {
  if (_mergeKeyHandler) return;
  _mergeKeyHandler = (e) => {
    if (!document.querySelector(".merge-overlay")) return;
    if (document.querySelector("#modalRoot .modal-backdrop")) return;                 // a dialog is stacked on top
    if (e.target && /^(TEXTAREA|INPUT)$/.test(e.target.tagName)) return;   // don't hijack the editor
    if (e.key === "Escape") { e.preventDefault(); closeMerge(); }
    else if (e.key === "]") { e.preventDefault(); navMergeFile(1); }
    else if (e.key === "[") { e.preventDefault(); navMergeFile(-1); }
    else {
      // 1/2/3 resolve the first still-open conflict (quick keyboard flow) — same mapping as the buttons
      const map = { "1": "mine", "2": "incoming", "3": "both" };
      if (map[e.key] && _merge.parsed) {
        const open = _merge.parsed.segments.find((s) => s.type === "conflict" && !_merge.choices[s.id]);
        if (open) { e.preventDefault(); resolveConflict(open.id, map[e.key]); }
      }
    }
  };
  document.addEventListener("keydown", _mergeKeyHandler, true);
}
export function tabContextMenu(e, id) {
  const idx = state.order.indexOf(id);
  const others = state.order.filter((x) => x !== id);
  const toRight = state.order.slice(idx + 1);
  const items = [
    { label: "Rename session", icon: "pencil", onClick: () => renameSession(id) },
    { label: "New session here", icon: "plus", onClick: () => newTab(state.tabs.get(id)?.meta.cwd) },
    { label: "Synthesize → new session", icon: "sparkle", onClick: () => synthesizeSession(id) },
    { sep: true },
    { label: "Export (full)", icon: "download", onClick: () => atom.sessions.export([id], "full").then((r) => { if (r && r.path) toast(`Exported (full)`, "download"); }).catch((e) => toast("Export failed: " + e.message, "alert")) },
    { label: "Export (compact)", icon: "download", onClick: () => atom.sessions.export([id], "compact").then((r) => { if (r && r.path) toast(`Exported (compact)`, "download"); }).catch((e) => toast("Export failed: " + e.message, "alert")) },
    { label: "Open history folder", icon: "history", onClick: () => atom.sessions.openHistory() },
    { sep: true },
    { label: "Close tab", icon: "close", onClick: () => closeTab(id) },
  ];
  if (others.length) items.push({ label: "Close other tabs", icon: "close", onClick: () => closeOtherTabs(id) });
  if (toRight.length) items.push({ label: "Close tabs to the right", icon: "close", onClick: () => closeTabsToRight(id) });
  items.push({ sep: true }, { label: "Delete from history", icon: "trash", danger: true, onClick: () => deleteSession(id) });
  showContextMenu(e.clientX, e.clientY, items);
}
export async function switchTab(id, force) {
  if (!state.tabs.has(id)) return;
  // save current draft
  const prev = activeTS();
  if (prev && !force) prev.draft = $("promptInput")?.value || "";
  state.activeTabId = id;
  const ts = state.tabs.get(id);
  renderTabs();
  await renderSidebar();
  refreshComposer();
  renderChat();
  renderChanges();
  persistTabs();
}
// New session: ALWAYS a brand-new session with fresh composer state (empty draft,
// attachments, queue, permissions; no native thread; no carried conversation).
// The previous tab keeps its own draft and running work untouched.
// (A blank tab is no longer reused — it may hold an unsent draft or images the
// user does not want in the new conversation.)
export async function newTab(cwd) {
  const folder = cwd || state.project || activeTS()?.meta.cwd || state.settings.lastFolder;
  const s = await atom.sessions.create({
    cwd: folder,
    model: state.settings.defaultModel,
    permissionMode: state.settings.defaultPermissionMode,
    thinking: state.settings.defaultThinking,
  });
  addTabState(s);
  state.order.push(s.id);
  await switchTab(s.id);
}
export function tabIsEmpty(ts) { return ts && !ts.totalMessages && (!ts.messages || !ts.messages.length); }
export async function closeTab(id) {
  const ts = state.tabs.get(id);
  if (!ts) return;
  const isEmpty = tabIsEmpty(ts);
  const isLast = state.order.length <= 1;
  if (isLast && isEmpty) return;          // nothing to close — keep the single empty tab
  if (!isEmpty || ts.meta.status === "running") {
    confirmDialog({
      title: "Close session tab?",
      message: ts.meta.status === "running"
        ? "This session is still running — closing the tab won't stop it. It stays in History and can be reopened."
        : "This conversation stays in History and can be reopened anytime.",
      confirmLabel: "Close tab",
      onConfirm: () => finishCloseTab(id, isEmpty),
    });
    return;
  }
  finishCloseTab(id, isEmpty);
}
export async function finishCloseTab(id, isEmpty) {
  const idx = state.order.indexOf(id);
  const ts = state.tabs.get(id);
  // Clear any per-tab timers/listeners before dropping the ref so they can't
  // fire against a closed tab (and keep a zombie reference alive).
  if (ts) {
    if (ts._stopTimer) clearTimeout(ts._stopTimer);
    if (ts._permFlashTimers) for (const t of ts._permFlashTimers) clearTimeout(t);
    // Tab being closed while still running → interrupt the backend so the
    // session doesn't keep burning tokens for output the user will never see.
    if (ts.meta.status === "running" && !isEmpty) {
      atom.sessions.interrupt(id, "stop").catch(() => {});
    }
  }
  state.order = state.order.filter((x) => x !== id);
  state.tabs.delete(id);
  if (isEmpty) atom.sessions.delete(id).catch(() => {});   // discard the throwaway empty session
  if (state.order.length === 0) { await newTab(); return; } // exactly one fresh session
  if (state.activeTabId === id) await switchTab(state.order[Math.min(idx, state.order.length - 1)]);
  else renderTabs();
  persistTabs();
}
// Close many tabs at once (editor-style). Empty throwaway tabs are discarded;
// real conversations stay in History. One confirmation, not one per tab.
export async function bulkCloseTabs(idsToClose, keepId) {
  idsToClose = idsToClose.filter((i) => state.tabs.has(i) && i !== keepId);
  if (!idsToClose.length) return;
  const nonEmpty = idsToClose.filter((i) => !tabIsEmpty(state.tabs.get(i)));
  const proceed = async () => {
    for (const i of idsToClose) {
      const empty = tabIsEmpty(state.tabs.get(i));
      state.order = state.order.filter((x) => x !== i);
      state.tabs.delete(i);
      if (empty) atom.sessions.delete(i).catch(() => {}); // discard throwaway empty session
    }
    if (!state.order.length) { await newTab(); return; }
    const active = state.tabs.has(keepId) ? keepId : state.order[0];
    await switchTab(active, true);
    persistTabs();
    toast(`Closed ${idsToClose.length} tab${idsToClose.length > 1 ? "s" : ""}`, "close");
  };
  if (nonEmpty.length) {
    confirmDialog({
      title: `Close ${idsToClose.length} tab${idsToClose.length > 1 ? "s" : ""}?`,
      message: `${nonEmpty.length} conversation${nonEmpty.length > 1 ? "s stay" : " stays"} in History and can be reopened anytime. Empty tabs are discarded.`,
      confirmLabel: "Close tabs",
      onConfirm: proceed,
    });
  } else { proceed(); }
}
export function closeOtherTabs(id) { return bulkCloseTabs(state.order.filter((x) => x !== id), id); }
export function closeTabsToRight(id) { const i = state.order.indexOf(id); return bulkCloseTabs(state.order.slice(i + 1), id); }
export async function deleteSession(id, onDeleted) {
  confirmDialog({
    title: "Delete session?",
    message: "This permanently removes the session and its history from disk. This cannot be undone.",
    danger: true, confirmLabel: "Delete",
    onConfirm: async () => {
      await atom.sessions.delete(id);
      if (state.tabs.has(id)) await finishCloseTab(id, false); // force-close without re-prompting
      toast("Session deleted", "trash");
      if (onDeleted) onDeleted();
    },
  });
}
export function renameSession(id, onSaved, prefill) {
  const ts = state.tabs.get(id);
  const input = h("input", { class: "input", value: prefill != null ? prefill : (ts ? ts.meta.name : ""), maxlength: "80" });
  const back = modalShell({
    title: "Rename session", ic: "pencil",
    body: h("div", { class: "field" }, h("label", { text: "Session name" }), input),
    footer: [
      h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => closeModal(back) }),
      h("button", { class: "btn btn-primary", text: "Save", onclick: save }),
    ],
  });
  setTimeout(() => { input.focus(); input.select(); }, 30);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  async function save() {
    const name = input.value.trim() || "Untitled session";
    await atom.sessions.rename(id, name);
    if (ts) ts.meta.name = name;
    closeModal(back);
    renderTabs();
    if (onSaved) onSaved(name);
  }
}
