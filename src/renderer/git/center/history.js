/* AtomNano renderer — Git Center — the History tab: paged, searchable log with commit details, typed historical file view, tags from commits.
 * One of the modules the former single gitcenter.js was split into (see git/center/index.js). */
import { act, confirmDanger, failToast, prompt } from "./actions.js";
import { commitRow } from "./compare.js";
import { doNewBranch, doReset, downloadSnapshot } from "./ops.js";
import { abs, alive, D, empty, errText, fmtDate, fmtSize, h, icon, iconBtn, per, repoName, S, spinner } from "./state.js";
import { diffPane, fileRow, pickList, splitPane, virtualList } from "./widgets.js";

/* ============================ History ============================ */
/* Every load (query / page / detail / file) carries a request id; an older response
 * that lands later is dropped. Pages are deduplicated by commit id. Merge commits are
 * compared with an EXPLICIT parent (default first) that the user can switch. */
export async function renderHistory(c, gen) {
  const repo = S.repo, H = S.hist, info0 = S.info || {};
  const list = h("div", { class: "gitc-col wide" });
  const detail = h("div", { class: "gitc-detail" });
  const search = h("input", { class: "gitc-input", placeholder: "Search subjects & messages…", value: H.search || "", spellcheck: "false", "aria-label": "Search history" });
  const allCb = h("input", { type: "checkbox", class: "aqx-check", "aria-label": "All branches" }); allCb.checked = !!H.all;
  const refLabel = () => H.all ? "all branches" : (S.source || "HEAD");
  const fileChip = h("button", { class: "gitc-refchip source gitc-filechip" + (H.fileFilter ? "" : " hidden"), title: "Only commits touching this file (follows renames) — click to clear", onclick: () => { H.fileFilter = ""; syncChip(); load(true); } });
  const syncChip = () => { fileChip.classList.toggle("hidden", !H.fileFilter); fileChip.textContent = H.fileFilter ? `${D.baseName(H.fileFilter)} ×` : ""; };
  syncChip();
  const head = h("div", { class: "gitc-col-head" }, h("span", { html: icon("history", 13) }), h("span", { class: "gitc-col-title", text: refLabel() }), h("span", { class: "gitc-col-count" }), fileChip, h("div", { class: "gitc-spacer" }),
    h("label", { class: "gitc-check", title: "Show commits from every branch" }, allCb, h("span", { text: "All" })), search);
  const body = h("div", { class: "gitc-col-body" });
  list.append(head, body);
  c.append(splitPane([list, detail], { key: "history", sizes: [420], min: 300 }));
  if (info0.unborn) { body.append(empty("history", "No commits yet", "Make the first commit from the Changes tab.")); detail.append(empty("history", "No commit selected")); return; }
  let t = null;
  search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { H.search = search.value.trim(); H.skip = 0; load(true); }, 280); });
  allCb.addEventListener("change", () => { H.all = allCb.checked; H.skip = 0; load(true); head.querySelector(".gitc-col-title").textContent = refLabel(); });
  let loading = false, vhost = null;
  const load = async (reset) => {
    if (loading && !reset) return;                          // one page at a time
    const req = ++H.req; loading = true;
    if (reset) { H.commits = []; body.innerHTML = ""; body.append(spinner("Reading history…")); }
    const skip = H.commits.length;
    const query = { ref: S.source || "HEAD", limit: 100, skip, search: H.search, all: H.all, file: H.fileFilter || "", follow: !!H.fileFilter };
    let r;
    try { r = await D.atom.git.log(repo, query); }
    catch (e) { loading = false; if (!alive(gen) || H.req !== req) return; body.innerHTML = ""; body.append(empty("alert", "Couldn't read history", errText(e))); return; }
    loading = false;
    if (!alive(gen) || H.req !== req || S.repo !== repo) return;   // obsolete query / page / repo
    const seen = new Set(H.commits.map((x) => x.full));
    H.commits = H.commits.concat((r.commits || []).filter((x) => !seen.has(x.full))); H.hasMore = !!r.hasMore;
    draw();
    if (reset) { if (H.sel && H.commits.some((x) => x.full === H.sel)) showDetail(H.sel); else if (H.commits[0]) showDetail(H.commits[0].full); else { detail.innerHTML = ""; detail.append(empty("history", "No commit selected")); } }
  };
  const draw = () => {
    body.innerHTML = "";
    head.querySelector(".gitc-col-count").textContent = String(H.commits.length) + (H.hasMore ? "+" : "");
    if (!H.commits.length) { body.append(empty("history", H.search || H.fileFilter ? "No matching commits" : "No commits yet")); return; }
    vhost = virtualList(body, H.commits, 46, (cm) => { const row = commitRow(cm, { active: H.sel === cm.full, onClick: () => showDetail(cm.full), menu: (e) => commitMenu(e, cm) }); row.dataset.full = cm.full; return row; });
    body.append(vhost);
    if (H.hasMore) body.append(h("button", { class: "gitc-more", onclick: () => load(false) }, `Load more (${H.commits.length} shown)`));
  };
  const downloadMenu = (e, hash, parent) => D.showMenuAt(e, [
    { label: "Full repository at this commit (.zip)", icon: "download", onClick: () => downloadSnapshot(hash, "repo", { repo }) },
    { label: `Only the files this commit changed (.zip)${parent ? " — vs the shown parent" : ""}`, icon: "fileCode", onClick: () => downloadSnapshot(hash, "files", { repo, parent }) },
  ]);
  const showDetail = async (hash, parentSel) => {
    H.sel = hash;
    const req = ++H.req;   // a detail load supersedes older detail/page reads for the view
    for (const el of body.querySelectorAll(".gitc-commit")) el.classList.toggle("active", el.dataset.full === hash);
    detail.innerHTML = ""; detail.append(spinner("Loading commit…"));
    let info;
    try { info = await D.atom.git.commitInfo(repo, hash, { parent: parentSel || undefined }); } catch (e) { if (alive(gen) && H.req === req) { detail.innerHTML = ""; detail.append(empty("alert", "Couldn't load commit", errText(e))); } return; }
    if (!alive(gen) || H.sel !== hash || H.req !== req || S.repo !== repo) return;
    H.info = info; H.parent = info.parentIndex || null;
    detail.innerHTML = "";
    const pane = diffPane();
    const filesEl = h("div", { class: "gitc-detail-files" });
    const parentPick = info.isMerge ? h("button", { class: "gitc-ref", title: "Merge commit — choose which parent the changes are compared against", "aria-haspopup": "listbox", onclick: (e) => pickList(e.currentTarget, { items: info.parents.map((p, i) => ({ value: i + 1, label: `vs parent ${i + 1}  ${p.slice(0, 7)}`, icon: "commit", hint: i === 0 ? "first parent (the branch merged into)" : "the merged branch" })), value: info.parentIndex, placeholder: "Compare against…", width: 320, onPick: (v) => showDetail(hash, v) }) }, h("span", { class: "gitc-ref-ic", html: icon("merge", 12) }), h("span", { class: "gitc-ref-name", text: `vs parent ${info.parentIndex} · ${String(info.parent).slice(0, 7)}` }), h("span", { class: "gitc-ref-caret", html: icon("chevronDown", 12) })) : null;
    const filesCol = h("div", { class: "gitc-col" }, h("div", { class: "gitc-col-head" }, h("span", { html: icon("fileCode", 13) }), h("span", { class: "gitc-col-title", text: info.isRoot ? "Files (root commit)" : "Files" }), h("span", { class: "gitc-col-count", text: String(info.files.length) }), parentPick, h("div", { class: "gitc-spacer" }), h("span", { class: "gitc-pm" }, h("span", { class: "ds-add", text: "+" + info.adds }), h("span", { class: "ds-del", text: "−" + info.dels }))), filesEl);
    const cur = (S.infos[repo] || {}).current || "";
    detail.append(
      h("div", { class: "gitc-detail-head" },
        h("div", { class: "gitc-detail-subject" }, h("span", { text: info.subject }), ...(info.refs || []).map((r) => h("span", { class: "gitc-refchip" + (/^HEAD/.test(r) ? " head" : /^tag: /.test(r) ? " tag" : /\//.test(r) ? " remote" : ""), text: r.replace(/^HEAD -> /, "").replace(/^tag: /, "") }))),
        h("div", { class: "gitc-detail-meta" },
          h("button", { class: "gitc-hash copy", title: "Copy full hash", onclick: () => { D.atom.clipboard.write(info.full); D.toast("Hash copied", "check"); } }, h("span", { html: icon("copy", 11) }), info.hash),
          h("span", { text: `${info.author} <${info.email}>` }), h("span", { class: "gitc-muted", text: fmtDate(info.date) + (info.rel ? ` (${info.rel})` : "") }),
          info.isMerge ? h("span", { class: "gitc-refchip", text: `merge commit · ${info.parents.length} parents` }) : null),
        info.body ? h("pre", { class: "gitc-detail-body", text: info.body }) : null,
        h("div", { class: "gitc-detail-acts" },
          h("button", { class: "gitc-act sm mut", title: "Check out this commit (detached HEAD)", onclick: () => act(`Checkout ${info.hash}`, () => D.atom.git.checkout(repo, info.full), { repo }) }, h("span", { html: icon("check", 13) }), "Checkout"),
          h("button", { class: "gitc-act sm mut", onclick: () => doNewBranch(info.full, repo) }, h("span", { html: icon("branch", 13) }), "Branch here"),
          h("button", { class: "gitc-act sm mut", onclick: () => doNewTag(info.full, repo) }, h("span", { html: icon("key", 13) }), "Tag here"),
          h("button", { class: "gitc-act sm mut", title: `Apply this commit onto ${cur}${info.isMerge ? ` (mainline = parent ${info.parentIndex})` : ""}`, onclick: () => act(`Cherry-pick ${info.hash}`, () => D.atom.git.cherryPick(repo, [info.full], { mainline: info.isMerge ? info.parentIndex : undefined }), { repo }) }, h("span", { html: icon("commit", 13) }), "Cherry-pick"),
          h("button", { class: "gitc-act sm mut", title: "Create a commit that undoes this one", onclick: async () => { if (await confirmDanger("Revert commit", `Create a new commit that reverses “${info.subject}”${info.isMerge ? ` (relative to parent ${info.parentIndex})` : ""}?`, "Revert")) act(`Revert ${info.hash}`, () => D.atom.git.revert(repo, info.full, { mainline: info.isMerge ? info.parentIndex : undefined }), { repo }); } }, h("span", { html: icon("undo", 13) }), "Revert"),
          h("button", { class: "gitc-act sm", title: "Download the repository at this point, or just its changed files", "aria-haspopup": "menu", onclick: (e) => downloadMenu(e, info.full, info.isMerge ? info.parentIndex : undefined) }, h("span", { html: icon("download", 13) }), "Download", h("span", { class: "gitc-ref-caret", html: icon("chevronDown", 11) })),
          h("button", { class: "gitc-act sm danger mut", title: "Move the current branch to this commit", onclick: () => doReset(info.full, repo) }, h("span", { html: icon("alert", 13) }), "Reset here"))),
      splitPane([filesCol, pane], { key: "commit", sizes: [300], min: 220 }));
    const showFile = (i) => {
      const f = info.files[i]; H.file = f.path;
      for (const el of filesEl.querySelectorAll(".gitc-file")) el.classList.toggle("active", +el.dataset.i === i);
      const deleted = f.code === "D";
      pane._show(f.path, () => D.atom.git.commitFileDiff(repo, info.full, f.path, { parent: info.parentIndex || undefined }), { sub: `${info.hash} vs ${String(info.parent).slice(0, 7)}${f.orig ? ` · renamed from ${f.orig}` : ""}`, actions: [iconBtn("eye", deleted ? "View the file as it was in the parent" : "View file at this commit", () => viewFileAt(deleted ? info.parent : info.full, deleted ? (f.orig || f.path) : f.path, repo)), iconBtn("history", "History of this file (follows renames)", () => { H.search = ""; search.value = ""; H.fileFilter = f.path; syncChip(); load(true); }), iconBtn("external", "Open current version in editor", () => D.openInEditor(abs(repo, f.path)))] });
    };
    if (!info.files.length) filesEl.append(empty("check", "No file changes", info.isMerge ? `Identical to parent ${info.parentIndex} — try another parent.` : ""));
    filesEl.append(virtualList(filesEl, info.files, 30, (f, i) => { const row = fileRow(f, { onClick: () => showFile(i) }); row.dataset.i = String(i); return row; }));
    if (info.files.length) showFile(Math.max(0, info.files.findIndex((f) => f.path === H.file)));
    else pane._placeholder("This commit changes no files against the selected parent.");
  };
  const commitMenu = (e, cm) => D.showMenuAt(e, [
    { label: "Copy hash", icon: "copy", onClick: () => { D.atom.clipboard.write(cm.full); D.toast("Hash copied", "check"); } },
    { label: "Checkout (detached)", icon: "check", onClick: () => act(`Checkout ${cm.hash}`, () => D.atom.git.checkout(repo, cm.full), { repo }) },
    { label: "New branch here…", icon: "branch", onClick: () => doNewBranch(cm.full, repo) },
    { label: "New tag here…", icon: "key", onClick: () => doNewTag(cm.full, repo) },
    { sep: true },
    { label: "Download repository at this commit (.zip)…", icon: "download", onClick: () => downloadSnapshot(cm.full, "repo", { repo }) },
    { label: "Download changed files (.zip)…", icon: "fileCode", onClick: () => downloadSnapshot(cm.full, "files", { repo }) },
    { sep: true },
    { label: `Cherry-pick onto ${(S.infos[repo] || {}).current || ""}`, icon: "commit", onClick: () => act(`Cherry-pick ${cm.hash}`, () => D.atom.git.cherryPick(repo, [cm.full]), { repo }) },
    { label: "Revert…", icon: "undo", onClick: async () => { if (await confirmDanger("Revert commit", `Create a new commit that reverses “${cm.subject}”?`, "Revert")) act(`Revert ${cm.hash}`, () => D.atom.git.revert(repo, cm.full), { repo }); } },
    { label: "Reset current branch here…", icon: "alert", danger: true, onClick: () => doReset(cm.full, repo) },
  ]);
  await load(true);
}
/* Typed historical file view: binary → size + exact-bytes download (never decoded
 * text); text → the first chunk with an explicit "N of M bytes" line and Load more. */
export async function viewFileAt(ref, file, repo = S.repo) {
  let r;
  try { r = await D.atom.git.fileAt(repo, ref, file, { base64: true }); } catch (e) { failToast("Read file", e, repo); return; }
  const title = `${D.baseName(file)} @ ${String(ref).slice(0, 7)}`;
  if (r.binary) {
    const dl = () => { try { const bytes = Uint8Array.from(atob(r.base64 || ""), (ch) => ch.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes])); const a = h("a", { href: url, download: D.baseName(file) }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); } catch (e) { D.toast("Download failed: " + D.esc(errText(e)), "alert"); } };
    const back = D.modalShell({ title, ic: "eye", body: h("div", { class: "gitc-fileview-bin" }, h("div", { text: `Binary file · ${fmtSize(r.size || 0)}` }), h("div", { class: "gitc-muted", text: "Binary content is not shown as text. Download the exact bytes instead." }), h("button", { class: "gitc-act primary", style: "margin-top:12px", onclick: dl }, h("span", { html: icon("download", 13) }), "Download exact bytes")) });
    back.querySelector(".modal").classList.add("gitc-fileview-modal");
    return;
  }
  const pre = h("pre", { class: "gitc-fileview", text: r.content || "" });
  const more = h("div", { class: "gitc-fileview-more" });
  const wrap = h("div", {}, pre, more);
  let next = r.nextOffset, shown = (r.content || "").length ? Buffer_len(r.content) : 0;
  const syncMore = () => { more.innerHTML = ""; if (next == null) { more.append(h("span", { text: `${fmtSize(r.size || 0)} · complete` })); return; } more.append(h("span", { text: `Showing ${fmtSize(shown)} of ${fmtSize(r.size || 0)}` }), h("button", { class: "gitc-act sm", onclick: async (e) => { e.currentTarget.disabled = true; try { const n = await D.atom.git.fileAt(repo, ref, file, { offset: next }); pre.textContent += n.content || ""; shown = next + Buffer_len(n.content || ""); next = n.nextOffset; syncMore(); } catch (err) { D.toast("Couldn't load more: " + D.esc(errText(err)), "alert"); e.currentTarget.disabled = false; } } }, "Load more"), h("button", { class: "gitc-act sm", onclick: async (e) => { e.currentTarget.disabled = true; try { while (next != null) { const n = await D.atom.git.fileAt(repo, ref, file, { offset: next, limit: 8_000_000 }); pre.textContent += n.content || ""; shown = next + Buffer_len(n.content || ""); next = n.nextOffset; } syncMore(); } catch (err) { D.toast("Couldn't load the rest: " + D.esc(errText(err)), "alert"); } } }, "Load all")); };
  syncMore();
  const back = D.modalShell({ title, ic: "eye", wide: true, body: wrap });
  back.querySelector(".modal").classList.add("gitc-fileview-modal");
}
export const Buffer_len = (s) => { try { return new TextEncoder().encode(s).length; } catch { return s.length; } };
export async function doNewTag(ref, repo = S.repo) {
  const name = await prompt({ title: "New tag", ic: "key", message: `Tag ${ref ? String(ref).slice(0, 12) : "HEAD"} in ${repoName(repo)}.`, placeholder: "v1.2.0", confirmLabel: "Next: message" });
  if (name == null || !name.trim()) return;
  const msg = await prompt({ title: `Tag ${name.trim()}`, ic: "key", message: "Optional annotation message (leave empty for a lightweight tag).", placeholder: "Release notes…", confirmLabel: "Create tag" });
  if (msg == null) return;
  await act(`Tag ${name.trim()}`, () => D.atom.git.tagCreate(repo, name.trim(), { ref: ref || undefined, message: msg }), { repo });
  per(repo).tg.list = [];
}
