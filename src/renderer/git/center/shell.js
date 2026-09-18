/* AtomNano renderer — Git Center — the overlay shell: open / close, focus trap and keys, live operation events, the operation strip.
 * One of the modules the former single gitcenter.js was split into (see git/center/index.js). */
import { exitCompare, renderRepoDD, renderTabs, setTab } from "./render.js";
import { loadRepos, refreshAll, refreshRepo, selectRepo } from "./repos.js";
import { alive, D, empty, h, icon, isOpen, q, S, setDeps, spinner } from "./state.js";
import { closePick } from "./widgets.js";

/* ============================ open / close ============================ */
export async function openGitCenter(deps, { repo, tab } = {}) {
  setDeps(deps);
  if (isOpen()) { if (repo) await selectRepo(repo); if (tab) setTab(tab); return; }
  const gen = ++S.gen;
  S.mode = tab === "compare" ? "compare" : "tabs";
  S.tab = tab && tab !== "compare" ? tab : "changes";
  S.opener = document.activeElement;
  S.back = h("div", { class: "gitc-overlay", onmousedown: (e) => { if (e.target === S.back) close(); } });
  const panel = h("div", { class: "gitc-panel", tabindex: "-1", role: "dialog", "aria-modal": "true", "aria-label": "Git" },
    h("div", { class: "gitc-head" },
      h("span", { class: "gitc-ic", html: icon("git", 18) }),
      h("div", { class: "gitc-title" }, h("h3", { text: "Git" })),
      h("div", { class: "gitc-repodd-host" }),
      h("div", { class: "gitc-progress", role: "progressbar", "aria-hidden": "true" }),
      h("div", { class: "gitc-spacer" }),
      h("span", { class: "gitc-sub" }),
      h("button", { class: "gitc-hbtn", title: "Refresh  R", "aria-label": "Refresh", html: icon("refresh", 15), onclick: () => refreshAll() }),
      h("button", { class: "gitc-hbtn close", title: "Close  Esc", "aria-label": "Close", html: icon("close", 16), onclick: () => close() })),
    h("div", { class: "gitc-body" },
      h("div", { class: "gitc-main" },
        h("div", { class: "gitc-bar", role: "toolbar", "aria-label": "Repository actions" }),
        h("div", { class: "gitc-state hidden", role: "status" }),
        h("div", { class: "gitc-oplog hidden", role: "status", "aria-live": "polite" }),
        h("div", { class: "gitc-banner hidden", role: "region", "aria-label": "Operation in progress" }),
        h("div", { class: "gitc-tabs", role: "tablist" }),
        h("div", { class: "gitc-cmpbar hidden" }),
        h("div", { class: "gitc-content" }))));
  S.back.append(panel);
  document.getElementById("modalRoot").append(S.back);
  bindKeys();
  subscribeEvents();
  setTimeout(() => { try { if (isOpen()) panel.focus({ preventScroll: true }); } catch { /* ignore */ } }, 0);

  renderTabs();
  q(".gitc-content").append(spinner("Discovering repositories…"));
  await loadRepos();
  if (!alive(gen)) return;                                   // closed during discovery: nothing to do, no error
  const want = repo && S.repos.includes(repo) ? repo : (S.repos.includes(S.repo) ? S.repo : S.repos[0] || "");
  if (!want) { const c = q(".gitc-content"); c.innerHTML = ""; c.append(S.discoveryError ? empty("alert", "Couldn't look for repositories", S.discoveryError) : empty("branch", "No Git repository here", "Open a folder that is (or contains) a Git repository.")); renderRepoDD(); return; }
  await selectRepo(want);
}
export function close() {
  closePick();
  S.gen++;                                                   // every pending load is now obsolete
  for (const off of S.unsub.splice(0)) { try { off(); } catch { /* */ } }
  if (S.back) S.back.remove();
  S.back = null;
  unbindKeys();
  const op = S.opener; S.opener = null;
  if (op && op.isConnected && typeof op.focus === "function") { try { op.focus({ preventScroll: true }); } catch { /* */ } }
}
export let _keys = null;
export function bindKeys() {
  if (_keys) return;
  _keys = (e) => {
    if (!isOpen()) return;
    // Only when THIS overlay is topmost (nothing stacked above it).
    if (document.querySelector(".merge-overlay, .diff-overlay, .compare-overlay, .modal-backdrop, .ctx-menu:not(.hidden), .gitc-pick, .gitc-pop")) return;
    const typing = e.target && /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName);
    if (e.key === "Escape") { e.preventDefault(); if (typing) e.target.blur(); else if (S.mode === "compare") exitCompare(); else close(); }
    else if (!typing && (e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); refreshAll(); }
    else if (e.key === "Tab") {
      // focus trap: cycle within the panel
      const panel = q(".gitc-panel"); if (!panel) return;
      const f = [...panel.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener("keydown", _keys, true);
}
export function unbindKeys() { if (_keys) { document.removeEventListener("keydown", _keys, true); _keys = null; } }
// Live operation events (start / output / end) and external repository changes.
export function subscribeEvents() {
  const ev = D.atom && D.atom.events;
  if (!ev) return;
  if (ev.onGitProgress) S.unsub.push(ev.onGitProgress((e) => onGitProgress(e)));
  if (ev.onGitChanged) S.unsub.push(ev.onGitChanged((e) => onGitChanged(e)));
}
export const _changedT = new Map();
export function onGitChanged(e) {
  const repo = e && e.repo; if (!repo || !isOpen()) return;
  const key = S.repos.find((r) => r.toLowerCase() === String(repo).replace(/\\/g, "/").toLowerCase()) || repo;
  if (!S.repos.includes(key)) return;
  clearTimeout(_changedT.get(key));
  _changedT.set(key, setTimeout(() => { _changedT.delete(key); if (!S.inflight.get(key)) refreshRepo(key, { quiet: true }); }, 350));   // coalesced; never while our own op runs
}
// Operation strip: label · last line git printed · Cancel (for the current repo's operation).
export function onGitProgress(e) {
  if (!e || !e.opId) return;
  if (e.kind === "start") S.ops.set(e.opId, { label: e.label, cwd: (e.cwd || "").replace(/\\/g, "/"), line: "", started: Date.now() });
  const op = S.ops.get(e.opId); if (!op) return;
  if (e.kind === "output") { const lines = String(e.text || "").split(/\r|\n/).map((s) => s.trim()).filter(Boolean); if (lines.length) op.line = lines[lines.length - 1]; }
  if (e.kind === "end") { S.ops.delete(e.opId); }
  renderOpLog();
}
export function renderOpLog() {
  const el = q(".gitc-oplog"); if (!el) return;
  const mine = [...S.ops.entries()].filter(([, op]) => !op.cwd || !S.repo || op.cwd.toLowerCase() === S.repo.replace(/\\/g, "/").toLowerCase());
  if (!mine.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const [opId, op] = mine[mine.length - 1];
  el.classList.remove("hidden"); el.innerHTML = "";
  el.append(h("span", { class: "gitc-oplog-label", text: op.label || "git" }), h("span", { class: "gitc-oplog-line", text: op.line || "running…", title: op.line || "" }),
    h("button", { class: "gitc-oplog-cancel", title: "Stop this git operation", onclick: () => { D.atom.git.cancel(opId).catch(() => {}); } }, "Cancel"));
}
