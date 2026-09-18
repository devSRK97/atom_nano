/* AtomNano renderer — Git Center — the Compare (merge view): commits and source changes of source → target, commit rows.
 * One of the modules the former single gitcenter.js was split into (see git/center/index.js). */
import { renderCmpBar, renderMain, setTab } from "./render.js";
import { abs, alive, D, empty, errText, h, icon, iconBtn, q, repoName, rowA11y, S, shortRef, spinner } from "./state.js";
import { diffPane, fileRow, splitPane, virtualList } from "./widgets.js";

/* ============================ Compare (mode) ============================ */
/* Ready (→ Create Merge / Rebase enabled) ONLY when the user clicked Compare, every
 * read succeeded and both refs resolved; the resolved ids are the review identity
 * that merge/rebase re-check. */
export async function renderCompare(c, gen) {
  const repo = S.repo, src = S.source, tgt = S.target, C = S.cmp;
  let summary = q(".gitc-cmp-summary"); if (summary) summary.innerHTML = "";
  if (!src || !tgt || src === tgt) { c.append(empty("gitCompare", src === tgt && src ? "Pick two different branches" : "Pick a source and a target branch", "Compare shows the SOURCE changes that merging into target would bring (three-dot diff, not the resolved merge tree). Create Merge unlocks when the review shows differences.")); return; }
  if (!C.compared) { c.append(empty("gitCompare", "Ready to compare", `Click Compare to refresh ${repoName(repo)} and review what merging “${shortRef(src)}” into “${shortRef(tgt)}” would bring. Create Merge unlocks when the review shows differences.`)); return; }
  const commitsCol = h("div", { class: "gitc-col" }, h("div", { class: "gitc-col-head" }, h("span", { html: icon("commit", 13) }), h("span", { class: "gitc-col-title", text: "Commits" }), h("span", { class: "gitc-col-count" })), h("div", { class: "gitc-col-body" }, spinner("Comparing…")));
  const filesCol = h("div", { class: "gitc-col" }, h("div", { class: "gitc-col-head" }, h("span", { html: icon("fileCode", 13) }), h("span", { class: "gitc-col-title", text: "Source changes" }), h("span", { class: "gitc-col-count" })), h("div", { class: "gitc-col-body" }, spinner()));
  const pane = diffPane();
  c.append(splitPane([commitsCol, filesCol, pane], { key: "compare", sizes: [300, 300] }));
  if (summary) summary.append(spinner("Comparing branches…"));
  const req = ++C.req;
  const PAGE = 200;
  const [ids, ab, commits, files] = await Promise.all([
    D.atom.git.resolveRefs(repo, [src, tgt]).catch((e) => ({ error: errText(e) })),
    D.atom.git.aheadBehind(repo, tgt, src).catch((e) => ({ error: errText(e) })),
    D.atom.git.commitsBetween(repo, tgt, src, { limit: PAGE, skip: 0 }).catch((e) => ({ error: errText(e), commits: [] })),
    D.atom.git.changedBetween(repo, tgt, src).catch((e) => ({ error: errText(e), files: [] })),
  ]);
  if (!alive(gen) || S.repo !== repo || C.req !== req) return;
  const idErr = ids.error || (!ids[src] ? `“${src}” did not resolve` : "") || (!ids[tgt] ? `“${tgt}” did not resolve` : "");
  const errors = [idErr, ab.error, commits.error, files.error].filter(Boolean);
  Object.assign(C, { commits: commits.commits || [], files: files.files || [], sel: null, ab: ab.error ? null : ab, hasMore: !!commits.hasMore, ready: errors.length === 0, error: errors.join(" · "), ids: errors.length ? null : { [src]: ids[src], [tgt]: ids[tgt] } });
  renderCmpBar();   // Create Merge / Rebase armed only on a complete, successful review with differences
  summary = q(".gitc-cmp-summary");   // (the bar was just rebuilt)
  if (summary) {
    summary.innerHTML = "";
    if (errors.length) summary.append(h("span", { class: "gitc-cmp-arrow", html: icon("alert", 14) }), h("span", { class: "gitc-cmp-ab danger" }, h("b", { text: "Incomplete comparison" }), h("span", { class: "gitc-muted", text: ` · ${errors.join(" · ")}` })), h("button", { class: "gitc-act sm", onclick: () => renderMain() }, "Retry"));
    else summary.append(
      h("span", { class: "gitc-cmp-arrow", html: icon("chevronRight", 14) }),
      h("span", { class: "gitc-cmp-ab" },
        h("b", { text: String(ab.onlyB) }), ` commit${ab.onlyB === 1 ? "" : "s"} to merge`, ab.onlyA ? h("span", { class: "gitc-muted", text: ` · ${shortRef(src)} is ${ab.onlyA} behind ${shortRef(tgt)}` }) : h("span", { class: "gitc-muted good", text: " · fast-forward possible" }),
        C.files.length ? h("span", { class: "gitc-muted", text: ` · ${C.files.length} file${C.files.length === 1 ? "" : "s"}` }) : null,
        h("span", { class: "gitc-muted", title: "The review is bound to these commits; Merge / Rebase re-check them before running", text: ` · ${String(ids[src]).slice(0, 7)}…${String(ids[tgt]).slice(0, 7)}` })));
  }
  const cb = commitsCol.querySelector(".gitc-col-body"); cb.innerHTML = "";
  const countEl = commitsCol.querySelector(".gitc-col-count");
  const drawCommits = () => {
    cb.innerHTML = "";
    countEl.textContent = String(C.commits.length) + (C.hasMore ? "+" : "");
    if (commits.error) { cb.append(empty("alert", "Couldn't list commits", commits.error)); return; }
    if (!C.commits.length) { cb.append(empty("checkCircle", "Nothing to merge", `${shortRef(src)} has no commits that ${shortRef(tgt)} lacks.`)); return; }
    cb.append(virtualList(cb, C.commits, 46, (cm) => commitRow(cm, { onClick: () => openCommitInHistory(cm.full || cm.hash), compact: true })));
    if (C.hasMore) cb.append(h("button", { class: "gitc-more", onclick: async (e) => {
      e.currentTarget.disabled = true;
      let more; try { more = await D.atom.git.commitsBetween(repo, tgt, src, { limit: PAGE, skip: C.commits.length }); } catch (err) { D.toast("Couldn't load more commits: " + D.esc(errText(err)), "alert"); return; }
      if (!alive(gen) || C.req !== req) return;
      const seen = new Set(C.commits.map((x) => x.full || x.hash));
      C.commits = C.commits.concat((more.commits || []).filter((x) => !seen.has(x.full || x.hash))); C.hasMore = !!more.hasMore;
      drawCommits();
    } }, `Load more (${C.commits.length} shown)`));
  };
  drawCommits();
  const fb = filesCol.querySelector(".gitc-col-body"); fb.innerHTML = "";
  filesCol.querySelector(".gitc-col-count").textContent = String(C.files.length);
  if (files.error) fb.append(empty("alert", "Couldn't diff", files.error));
  else if (!C.files.length) fb.append(empty("check", "No file differences"));
  else {
    const show = (i) => {
      C.sel = i;
      for (const el of fb.querySelectorAll(".gitc-file")) el.classList.toggle("active", +el.dataset.i === i);
      const f = C.files[i];
      pane._show(f.path, () => D.atom.git.refDiff(repo, tgt, src, f.path), { sub: `source changes · ${shortRef(tgt)}…${shortRef(src)}`, actions: [iconBtn("external", "Open in editor", () => D.openInEditor(abs(repo, f.path)))] });
    };
    fb.append(virtualList(fb, C.files, 30, (f, i) => { const row = fileRow(f, { active: C.sel === i, onClick: () => show(i) }); row.dataset.i = String(i); return row; }));
    show(0);
  }
}
export function commitRow(cm, { onClick, active, compact, menu } = {}) {
  const refs = (cm.refs || []).filter(Boolean);
  const row = h("div", { class: "gitc-commit" + (active ? " active" : "") + (compact ? " compact" : ""), onclick: onClick, oncontextmenu: menu ? (e) => { e.preventDefault(); menu(e); } : null },
    h("span", { class: "gitc-commit-dot" }),
    h("div", { class: "gitc-commit-main" },
      h("div", { class: "gitc-commit-subject" }, h("span", { text: cm.subject || "(no subject)" }), ...refs.map((r) => h("span", { class: "gitc-refchip" + (/^HEAD/.test(r) ? " head" : /^tag: /.test(r) ? " tag" : /\//.test(r) ? " remote" : ""), text: r.replace(/^HEAD -> /, "").replace(/^tag: /, "") }))),
      h("div", { class: "gitc-commit-meta" }, h("span", { class: "gitc-hash", text: cm.hash }), h("span", { text: cm.author || "" }), h("span", { class: "gitc-muted", text: cm.rel || cm.date || "" }))),
    menu ? h("button", { class: "gitc-ibtn", title: "Actions", "aria-label": "Commit actions", "aria-haspopup": "menu", html: icon("moreVert", 14), onclick: (e) => { e.stopPropagation(); menu(e); } }) : null);
  return rowA11y(row, `Commit ${cm.hash} ${cm.subject || ""}`);
}
export async function openCommitInHistory(hash) { S.hist.sel = hash; S.hist.search = ""; setTab("history"); }
