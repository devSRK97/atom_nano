/* AtomNano renderer — Git Center — the Branches, Stashes, Tags and Remotes tabs.
 * One of the modules the former single gitcenter.js was split into (see git/center/index.js). */
import { act, chooseRemote, confirmDanger, prompt } from "./actions.js";
import { doCheckout, doDeleteBranch, doMerge, doPush, doRebase, doRename, doSetUpstream, doStash, downloadSnapshot } from "./ops.js";
import { enterCompare, refItems, renderBar, renderCmpBar, renderMain, renderTabs, resetCompare, setTab } from "./render.js";
import { alive, D, empty, errText, h, icon, iconBtn, repoName, rowA11y, S, spinner } from "./state.js";
import { diffPane, fileRow, pickList, splitPane, virtualList } from "./widgets.js";

/* ============================ Branches ============================ */
export async function renderBranches(c, gen) {
  const repo = S.repo, info = S.info, B = S.br;
  const wrap = h("div", { class: "gitc-brs" });
  const nameIn = h("input", { class: "gitc-input", placeholder: "new-branch-name", value: B.newName || "", spellcheck: "false", "aria-label": "New branch name" });
  const fromBtn = h("button", { class: "gitc-ref source", title: "Start point", "aria-haspopup": "listbox", onclick: (e) => pickList(e.currentTarget, { items: [{ value: "", label: `HEAD (${info.current})`, icon: "check", group: "Current" }, ...refItems(B.from)], value: B.from || "", placeholder: "Search start point…", width: 360, onPick: (v) => { B.from = v; fromBtn.querySelector(".gitc-ref-name").textContent = v || `HEAD (${info.current})`; } }) },
    h("span", { class: "gitc-ref-ic", html: icon("branch", 12) }), h("span", { class: "gitc-ref-name", text: B.from || `HEAD (${info.current})` }), h("span", { class: "gitc-ref-caret", html: icon("chevronDown", 12) }));
  const coCb = h("input", { type: "checkbox", class: "aqx-check", "aria-label": "Check out the new branch" }); coCb.checked = B.checkout !== false;
  const create = async () => {
    const name = nameIn.value.trim(); if (!name) { nameIn.focus(); return; }
    B.newName = ""; B.checkout = coCb.checked;
    await act(`Create ${name}`, () => D.atom.git.branchCreate(repo, name, { from: B.from || undefined, checkout: coCb.checked }), { repo });
  };
  nameIn.addEventListener("input", () => { B.newName = nameIn.value; });
  nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
  wrap.append(h("div", { class: "gitc-form" },
    h("span", { class: "gitc-form-ic", html: icon("plus", 14) }), nameIn,
    h("span", { class: "gitc-muted", text: "from" }), fromBtn,
    h("label", { class: "gitc-check" }, coCb, h("span", { text: "Check out" })),
    h("button", { class: "gitc-act primary mut", onclick: create }, "Create branch")));
  const local = h("div", { class: "gitc-col" }, h("div", { class: "gitc-col-head" }, h("span", { html: icon("branch", 13) }), h("span", { class: "gitc-col-title", text: "Local" }), h("span", { class: "gitc-col-count", text: String(info.locals.length) })));
  const remote = h("div", { class: "gitc-col" }, h("div", { class: "gitc-col-head" }, h("span", { html: icon("cloudDown", 13) }), h("span", { class: "gitc-col-title", text: "Remote" }), h("span", { class: "gitc-col-count", text: String(info.remotes.length) }), h("div", { class: "gitc-spacer" }), h("button", { class: "gitc-link mut", onclick: () => act("Fetch", () => D.atom.git.fetch(repo), { repo }) }, "Fetch")));
  const lb = h("div", { class: "gitc-col-body" }), rb = h("div", { class: "gitc-col-body" });
  local.append(lb); remote.append(rb);
  wrap.append(splitPane([local, remote], { key: "branches", sizes: [Math.round((S.back ? S.back.clientWidth : 1200) * 0.45)], min: 280 })); c.append(wrap);
  const setRef = (which, name) => { if (which === "source") S.source = name; else S.target = name; resetCompare(); renderBar(); renderCmpBar(); };
  const chip = (txt, cls) => h("span", { class: "gitc-refchip " + (cls || ""), text: txt });
  if (info.unborn) lb.append(h("div", { class: "gitc-sec-empty", text: `“${info.current}” has no commits yet — it becomes a real branch with the first commit.` }));
  if (!info.locals.length && !info.unborn) lb.append(empty("branch", "No local branches"));
  const localRow = (b) => {
    const isSrc = b.name === S.source, isTgt = b.name === S.target;
    return rowA11y(h("div", { class: "gitc-branch" + (b.current ? " current" : ""), title: b.subject, oncontextmenu: (e) => { e.preventDefault(); localMenu(e, b); } },
      h("span", { class: "gitc-branch-ic", html: icon(b.current ? "check" : "branch", 14) }),
      h("div", { class: "gitc-branch-main" },
        h("div", { class: "gitc-branch-name" }, h("span", { text: b.name }), b.current ? chip("current", "head") : null, isSrc ? chip("source", "source") : null, isTgt ? chip("target", "target") : null,
          b.upstream ? h("span", { class: "gitc-upstream", title: "Upstream" }, h("span", { html: icon("cloudUp", 11) }), b.gone ? b.upstream + " (gone)" : b.upstream) : h("span", { class: "gitc-upstream none", text: "no upstream" }),
          b.ahead ? h("span", { class: "gitc-ab up", text: `↑${b.ahead}` }) : null, b.behind ? h("span", { class: "gitc-ab down", text: `↓${b.behind}` }) : null),
        h("div", { class: "gitc-branch-meta" }, h("span", { class: "gitc-hash", text: b.hash }), h("span", { class: "gitc-branch-subject", text: b.subject }), h("span", { class: "gitc-muted", text: b.rel }))),
      h("span", { class: "gitc-branch-acts" },
        b.current ? null : iconBtn("check", "Check out", () => doCheckout(b.name, {}, repo), "mut"),
        iconBtn("gitCompare", "Compare as source", () => { setRef("source", b.name); enterCompare(); }, isSrc ? "on" : ""),
        iconBtn("merge", "Set as target", () => setRef("target", b.name), isTgt ? "on" : ""),
        iconBtn("moreVert", "More…", (e) => localMenu(e, b)))), `Branch ${b.name}`);
  };
  lb.append(virtualList(lb, info.locals, 52, localRow));
  if (!info.remotes.length) rb.append(empty("cloudDown", "No remote branches", "Fetch to see branches on the remote."));
  const remoteRow = (b) => {
    const isSrc = b.name === S.source, isTgt = b.name === S.target;
    return rowA11y(h("div", { class: "gitc-branch remote", title: b.subject, oncontextmenu: (e) => { e.preventDefault(); remoteMenu(e, b); } },
      h("span", { class: "gitc-branch-ic", html: icon("cloudDown", 14) }),
      h("div", { class: "gitc-branch-main" },
        h("div", { class: "gitc-branch-name" }, h("span", { text: b.name }), isSrc ? chip("source", "source") : null, isTgt ? chip("target (read-only — check out to merge into)", "target") : null),
        h("div", { class: "gitc-branch-meta" }, h("span", { class: "gitc-hash", text: b.hash }), h("span", { class: "gitc-branch-subject", text: b.subject }), h("span", { class: "gitc-muted", text: b.rel }))),
      h("span", { class: "gitc-branch-acts" },
        iconBtn("check", "Check out as a tracking local branch", () => doCheckout(b.name, { remote: true }, repo), "mut"),
        iconBtn("gitCompare", "Compare as source", () => { setRef("source", b.name); enterCompare(); }, isSrc ? "on" : ""),
        iconBtn("merge", "Set as compare target (read-only)", () => setRef("target", b.name), isTgt ? "on" : ""),
        iconBtn("moreVert", "More…", (e) => remoteMenu(e, b)))), `Remote branch ${b.name}`);
  };
  rb.append(virtualList(rb, info.remotes, 52, remoteRow));
  function localMenu(e, b) {
    const cur = info.current;
    D.showMenuAt(e, [
      ...(b.current || info.unborn ? [] : [{ label: "Check out", icon: "check", onClick: () => doCheckout(b.name, {}, repo) }, { label: `Merge into ${cur}…`, icon: "merge", onClick: () => doMerge(b.name, cur, e.currentTarget, repo) }, { label: `Rebase ${cur} onto ${b.name}…`, icon: "gitCompare", onClick: () => doRebase(cur, b.name, e.currentTarget, repo) }]),
      { label: "Compare as source", icon: "gitCompare", onClick: () => { setRef("source", b.name); enterCompare(); } },
      { sep: true },
      { label: "Rename…", icon: "pencil", onClick: () => doRename(b.name, repo) },
      { label: b.upstream ? "Change upstream…" : "Set upstream…", icon: "cloudUp", onClick: () => doSetUpstream(b.name, repo) },
      { label: b.upstream ? `Push ${b.name}…` : `Publish ${b.name}…`, icon: "push", onClick: (ev) => doPush({ repo, branch: b.name, anchor: ev && ev.currentTarget }) },
      { label: "Copy name", icon: "copy", onClick: () => { D.atom.clipboard.write(b.name); D.toast("Copied", "check"); } },
      ...(b.current ? [] : [{ sep: true }, { label: "Delete branch…", icon: "trash", danger: true, onClick: () => doDeleteBranch(b.name, {}, repo) }]),
    ]);
  }
  function remoteMenu(e, b) {
    const cur = info.current;
    D.showMenuAt(e, [
      { label: "Check out (track)", icon: "check", onClick: () => doCheckout(b.name, { remote: true }, repo) },
      ...(info.unborn ? [] : [{ label: `Merge into ${cur}…`, icon: "merge", onClick: () => doMerge(b.name, cur, e.currentTarget, repo) },
        { label: "Pull this branch into " + cur, icon: "pull", onClick: () => { const [rn, ...rest] = b.name.split("/"); act(`Pull ${b.name}`, () => D.atom.git.pullFrom(repo, { remote: rn, branch: rest.join("/"), rebase: false }), { repo }); } }]),
      { label: "Compare as source", icon: "gitCompare", onClick: () => { setRef("source", b.name); enterCompare(); } },
      { label: "Copy name", icon: "copy", onClick: () => { D.atom.clipboard.write(b.name); D.toast("Copied", "check"); } },
      { sep: true },
      { label: "Delete on remote…", icon: "trash", danger: true, onClick: () => doDeleteBranch(b.name, { remote: true }, repo) },
    ]);
  }
  if (!alive(gen)) return;
}

/* ============================ Stashes (identity = object id) ============================ */
export async function renderStashes(c, gen) {
  const repo = S.repo, ST = S.st;
  const listCol = h("div", { class: "gitc-col" }, h("div", { class: "gitc-col-head" }, h("span", { html: icon("download", 13) }), h("span", { class: "gitc-col-title", text: "Stashes" }), h("span", { class: "gitc-col-count" }), h("div", { class: "gitc-spacer" }),
    h("button", { class: "gitc-link mut", onclick: (e) => doStash(e.currentTarget, repo) }, "Stash changes…")));
  const lb = h("div", { class: "gitc-col-body" }); listCol.append(lb);
  const filesCol = h("div", { class: "gitc-col" }, h("div", { class: "gitc-col-head" }, h("span", { html: icon("fileCode", 13) }), h("span", { class: "gitc-col-title", text: "Files" }), h("span", { class: "gitc-col-count" })));
  const fb = h("div", { class: "gitc-col-body" }); filesCol.append(fb);
  const pane = diffPane();
  c.append(splitPane([listCol, filesCol, pane], { key: "stashes", sizes: [320, 280] }));
  lb.append(spinner("Listing stashes…"));
  let r;
  try { r = await D.atom.git.stashList(repo); } catch (e) { if (alive(gen)) { lb.innerHTML = ""; lb.append(empty("alert", "Couldn't list stashes", errText(e))); } return; }
  if (!alive(gen) || S.repo !== repo) return;
  ST.list = r.stashes || [];
  renderTabs();
  lb.innerHTML = ""; listCol.querySelector(".gitc-col-count").textContent = String(ST.list.length);
  if (!ST.list.length) { lb.append(empty("download", "No stashes", "Stash changes to park them without committing.")); fb.append(empty("fileCode", "—")); pane._placeholder("No stash selected."); return; }
  let req = 0;
  const show = async (st) => {
    ST.sel = st.hash;
    const my = ++req;
    for (const el of lb.querySelectorAll(".gitc-stashrow")) el.classList.toggle("active", el.dataset.hash === st.hash);
    fb.innerHTML = ""; fb.append(spinner());
    let sr; try { sr = await D.atom.git.stashShow(repo, { hash: st.hash }); } catch (e) { sr = { files: [], error: errText(e) }; }
    if (!alive(gen) || ST.sel !== st.hash || my !== req) return;
    fb.innerHTML = ""; filesCol.querySelector(".gitc-col-count").textContent = String((sr.files || []).length);
    if (sr.error) { fb.append(empty("alert", "Couldn't read stash", sr.error)); return; }
    if (!sr.files.length) { fb.append(empty("check", "Empty stash")); pane._placeholder(); return; }
    const showFile = (i) => { const f = sr.files[i]; for (const el of fb.querySelectorAll(".gitc-file")) el.classList.toggle("active", +el.dataset.i === i); pane._show(f.path, () => D.atom.git.stashFileDiff(repo, { hash: st.hash }, f.path), { sub: `${st.ref} · ${st.hash.slice(0, 7)}` }); };
    sr.files.forEach((f, i) => { const row = fileRow(f, { onClick: () => showFile(i) }); row.dataset.i = String(i); fb.append(row); });
    showFile(0);
  };
  const applyStash = async (st, pop) => {
    const res = await act(`${pop ? "Pop" : "Apply"} stash ${st.hash.slice(0, 7)}`, () => D.atom.git.stashApply(repo, { hash: st.hash }, { pop }), { repo, silent: true });
    if (res && res.ok) D.toast(pop ? `Popped stash ${D.esc(st.hash.slice(0, 7))}` : `Applied stash ${D.esc(st.hash.slice(0, 7))} (kept)`, "checkCircle", { ms: 2600 });
    else if (res && res.state === "conflict") D.toast(`<b>Stash ${D.esc(st.hash.slice(0, 7))} applied with conflicts</b><span class="toast-sub">The stash is kept. Resolve the files, then drop it yourself.</span>`, "alert", { ms: 7000 });
    if (S.tab === "stashes" && S.repo === repo) renderMain();
  };
  for (const st of ST.list) {
    lb.append(rowA11y(h("div", { class: "gitc-stashrow" + (ST.sel === st.hash ? " active" : ""), dataset: { hash: st.hash }, onclick: () => show(st) },
      h("span", { class: "gitc-stash-idx", title: `stash@{${st.index}} · ${st.hash}`, text: String(st.index) }),
      h("div", { class: "gitc-branch-main" },
        h("div", { class: "gitc-branch-name" }, h("span", { text: st.message }), st.wip ? h("span", { class: "gitc-refchip", text: "WIP" }) : null),
        h("div", { class: "gitc-branch-meta" }, st.branch ? h("span", { class: "gitc-refchip source", text: st.branch }) : null, h("span", { class: "gitc-hash", text: st.hash.slice(0, 7) }), h("span", { class: "gitc-muted", text: st.rel }))),
      h("span", { class: "gitc-branch-acts always" },
        h("button", { class: "gitc-act sm mut", title: "Apply and keep the stash", onclick: (e) => { e.stopPropagation(); applyStash(st, false); } }, "Apply"),
        h("button", { class: "gitc-act sm primary mut", title: "Apply and drop the stash (kept if it conflicts)", onclick: (e) => { e.stopPropagation(); applyStash(st, true); } }, "Pop"),
        iconBtn("trash", "Drop this stash", async () => { if (await confirmDanger("Drop stash", `Drop stash ${st.hash.slice(0, 7)} (“${st.message}”)? This cannot be undone.`, "Drop")) { await act(`Drop stash ${st.hash.slice(0, 7)}`, () => D.atom.git.stashDrop(repo, { hash: st.hash }), { repo }); if (S.tab === "stashes" && S.repo === repo) renderMain(); } }, "danger mut"))), `Stash ${st.index} ${st.message}`));
  }
  const sel = ST.list.find((x) => x.hash === ST.sel) || ST.list[0];
  show(sel);
}

/* ============================ Tags ============================ */
export async function renderTags(c, gen) {
  const repo = S.repo, T = S.tg;
  const wrap = h("div", { class: "gitc-tags" });
  const nameIn = h("input", { class: "gitc-input", placeholder: "v1.2.0", spellcheck: "false", "aria-label": "Tag name" });
  const refIn = h("input", { class: "gitc-input", placeholder: "ref (default HEAD)", value: "", spellcheck: "false", title: "Branch, tag or commit to tag", "aria-label": "Ref to tag" });
  const msgIn = h("input", { class: "gitc-input grow", placeholder: "Annotation message (optional)", spellcheck: "true", "aria-label": "Tag message" });
  const create = async () => { const name = nameIn.value.trim(); if (!name) { nameIn.focus(); return; } await act(`Tag ${name}`, () => D.atom.git.tagCreate(repo, name, { ref: refIn.value.trim() || undefined, message: msgIn.value }), { repo }); };
  for (const el of [nameIn, refIn, msgIn]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
  wrap.append(h("div", { class: "gitc-form" }, h("span", { class: "gitc-form-ic", html: icon("key", 14) }), nameIn, h("span", { class: "gitc-muted", text: "at" }), refIn, msgIn, h("button", { class: "gitc-act primary mut", onclick: create }, "Create tag"), h("button", { class: "gitc-act mut", title: "Push all tags to a remote you choose", onclick: (e) => doPush({ repo, tags: true, anchor: e.currentTarget }) }, h("span", { html: icon("push", 13) }), "Push tags…")));
  const body = h("div", { class: "gitc-col-body list" }, spinner("Listing tags…"));
  wrap.append(body); c.append(wrap);
  let r;
  try { r = await D.atom.git.tags(repo); } catch (e) { if (alive(gen)) { body.innerHTML = ""; body.append(empty("alert", "Couldn't list tags", errText(e))); } return; }
  if (!alive(gen) || S.repo !== repo) return;
  T.list = r.tags || [];
  body.innerHTML = "";
  if (!T.list.length) { body.append(empty("key", "No tags", "Tag a release point above, or from any commit in History.")); return; }
  const pushTag = async (t, anchor) => {
    const remote = await chooseRemote(repo, anchor, { title: `Push tag ${t.name} to which remote?` });
    if (!remote) return;
    const res = await act(`Push tag ${t.name}`, () => D.atom.git.pushTag(repo, t.name, { remote }), { repo, silent: true });
    if (res && res.ok) D.toast(res.upToDate ? `Tag ${D.esc(t.name)} already on ${D.esc(remote)}` : `Pushed refs/tags/${D.esc(t.name)} → ${D.esc(remote)}`, "checkCircle", { ms: 3000 });
    else if (res && res.state === "rejected") D.toast(`<b>Tag push rejected</b><span class="toast-sub">${D.esc(res.error || "")}</span>`, "alert", { ms: 6000 });
  };
  const deleteTag = async (t, anchor) => {
    const c2 = await D.chooseDialog({ title: "Delete tag", ic: "trash", message: `Delete “${t.name}” (${t.hash})? Deleting on a remote removes refs/tags/${t.name} there first, then locally; a same-named branch is never touched.`, choices: [{ label: "Delete locally", value: "local", primary: true }, { label: "Delete locally + on a remote…", value: "remote" }, { label: "Cancel", value: null }] });
    if (!c2) return;
    let remote;
    if (c2 === "remote") { remote = await chooseRemote(repo, anchor, { title: `Delete ${t.name} on which remote?` }); if (!remote) return; }
    const res = await act(`Delete tag ${t.name}`, () => D.atom.git.tagDelete(repo, t.name, { remote, expectOid: t.tagOid || t.oid }), { repo, silent: true });
    if (!res) return;
    const ph = res.phases || {};
    if (res.ok) D.toast(`Deleted tag ${D.esc(t.name)}${remote ? ` on ${D.esc(remote)} and locally` : ""}`, "checkCircle", { ms: 3000 });
    else D.toast(`<b>Delete tag ${D.esc(t.name)}: ${ph.remote && !ph.remote.ok ? "remote step failed — local tag kept" : ph.local && !ph.local.ok ? (remote ? "removed on the remote, but the local delete failed" : "local delete failed") : "failed"}</b><span class="toast-sub">${D.esc(res.error || "")}</span>`, "alert", { ms: 8000 });
    if (S.tab === "tags" && S.repo === repo) renderMain();
  };
  body.append(virtualList(body, T.list, 52, (t) => rowA11y(h("div", { class: "gitc-branch", title: t.subject },
    h("span", { class: "gitc-branch-ic", html: icon("key", 14) }),
    h("div", { class: "gitc-branch-main" },
      h("div", { class: "gitc-branch-name" }, h("span", { text: t.name }), t.annotated ? h("span", { class: "gitc-refchip tag", text: "annotated" }) : null),
      h("div", { class: "gitc-branch-meta" }, h("span", { class: "gitc-hash", text: t.hash }), h("span", { class: "gitc-branch-subject", text: t.subject }), h("span", { class: "gitc-muted", text: t.rel }))),
    h("span", { class: "gitc-branch-acts" },
      iconBtn("history", "Show in History", () => { S.hist.sel = t.oid || t.hash; S.hist.all = true; setTab("history"); }),
      iconBtn("download", "Download repository at this tag (.zip)", () => downloadSnapshot(t.name, "repo", { repo })),
      iconBtn("check", "Check out (detached)", () => act(`Checkout ${t.name}`, () => D.atom.git.checkout(repo, t.name), { repo }), "mut"),
      iconBtn("push", "Push this tag (refs/tags/…) to a remote…", (e) => pushTag(t, e.currentTarget), "mut"),
      iconBtn("trash", "Delete tag", (e) => deleteTag(t, e.currentTarget), "danger mut"))), `Tag ${t.name}`)));
}

/* ============================ Remotes ============================ */
export async function renderRemotes(c, gen) {
  const repo = S.repo, R = S.rm;
  const wrap = h("div", { class: "gitc-remotes" });
  const nameIn = h("input", { class: "gitc-input", placeholder: "origin", spellcheck: "false", "aria-label": "Remote name" });
  const urlIn = h("input", { class: "gitc-input grow", placeholder: "https://github.com/user/repo.git", spellcheck: "false", "aria-label": "Remote URL" });
  const add = async () => { const n = nameIn.value.trim(), u = urlIn.value.trim(); if (!n || !u) { (n ? urlIn : nameIn).focus(); return; } await act(`Add remote ${n}`, () => D.atom.git.remoteAdd(repo, n, u), { repo }); };
  for (const el of [nameIn, urlIn]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  wrap.append(h("div", { class: "gitc-form" }, h("span", { class: "gitc-form-ic", html: icon("globe", 14) }), nameIn, urlIn, h("button", { class: "gitc-act primary mut", onclick: add }, "Add remote")));
  const body = h("div", { class: "gitc-col-body list" }, spinner("Listing remotes…"));
  wrap.append(body); c.append(wrap);
  let r;
  try { r = await D.atom.git.remotes(repo); } catch (e) { if (alive(gen)) { body.innerHTML = ""; body.append(empty("alert", "Couldn't list remotes", errText(e))); } return; }
  if (!alive(gen) || S.repo !== repo) return;
  R.list = r.remotes || [];
  body.innerHTML = "";
  if (!R.list.length) { body.append(empty("globe", "No remotes", "Add one above to push and pull.")); return; }
  const editUrl = async (rm, push) => {
    const cur = push ? (rm.pushUrls || [])[0] || rm.push : rm.fetch;
    const u = await prompt({ title: `${push ? "Push" : "Fetch"} URL of ${rm.name}`, ic: "globe", message: push ? "The URL pushes go to (fetch URL stays as is)." : "The URL fetches and pulls come from.", placeholder: "https://… or git@…", value: cur || "", confirmLabel: "Save" });
    if (u == null || !u.trim() || u.trim() === cur) return;
    await act(`Set ${push ? "push " : ""}URL of ${rm.name}`, () => D.atom.git.remoteSetUrl(repo, rm.name, u.trim(), { push }), { repo });
    if (S.tab === "remotes" && S.repo === repo) renderMain();
  };
  for (const rm of R.list) {
    const pushUrls = (rm.pushUrls || []).filter((u) => u !== rm.fetch);
    body.append(rowA11y(h("div", { class: "gitc-branch" },
      h("span", { class: "gitc-branch-ic", html: icon("globe", 14) }),
      h("div", { class: "gitc-branch-main" },
        h("div", { class: "gitc-branch-name" }, h("span", { text: rm.name }), (rm.fetchUrls || []).length > 1 ? h("span", { class: "gitc-refchip", text: `${rm.fetchUrls.length} fetch URLs` }) : null),
        h("div", { class: "gitc-branch-meta", style: "flex-wrap:wrap" }, h("span", { class: "gitc-url", text: rm.fetch }), ...pushUrls.map((u) => h("span", { class: "gitc-muted", text: "push: " + u })))),
      h("span", { class: "gitc-branch-acts always" },
        h("button", { class: "gitc-act sm mut", onclick: () => act(`Fetch ${rm.name}`, () => D.atom.git.fetch(repo, { remote: rm.name }), { repo }) }, h("span", { html: icon("cloudDown", 13) }), "Fetch"),
        iconBtn("pencil", "Edit URLs…", (e) => D.showMenuAt(e, [{ label: "Edit fetch URL…", icon: "cloudDown", onClick: () => editUrl(rm, false) }, { label: pushUrls.length ? "Edit push URL…" : "Set a separate push URL…", icon: "cloudUp", onClick: () => editUrl(rm, true) }]), "mut"),
        iconBtn("external", "Open in browser", () => { const u = rm.fetch.replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\//, "https://$1/").replace(/\.git$/, ""); if (/^https?:/.test(u)) D.atom.shell.openExternal(u); else D.toast("Not a web URL", "alert"); }),
        iconBtn("copy", "Copy URL", () => { D.atom.clipboard.write(rm.fetch); D.toast("URL copied", "check"); }),
        iconBtn("trash", "Remove remote", async () => { if (await confirmDanger("Remove remote", `Remove remote “${rm.name}” from ${repoName(repo)}? Its remote-tracking branches are deleted locally (nothing changes on the server).`, "Remove")) act(`Remove ${rm.name}`, () => D.atom.git.remoteRemove(repo, rm.name), { repo }); }, "danger mut"))), `Remote ${rm.name}`));
  }
}
