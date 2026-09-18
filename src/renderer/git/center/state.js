/* AtomNano renderer — Git Center — injected deps, the modal state S with its per-repo records, and the small shared helpers.
 * One of the modules the former single gitcenter.js was split into (see git/center/index.js). */

export let D = null;                 // injected deps (see openGitCenter)
export function setDeps(deps) { D = deps; }
export const S = {                   // modal state (global part)
  back: null, repo: "", repos: [], statuses: {}, infos: {}, per: {},
  mode: "tabs",               // "tabs" | "compare"  (Create Merge / Rebase only enable after the user clicked Compare)
  tab: "changes", busy: 0, gen: 0, inflight: new Map(), ops: new Map(), opener: null, unsub: [],
  get info() { return S.infos[S.repo] || null; },
  set info(v) { S.infos[S.repo] = v; },
  get chg() { return per(S.repo).chg; }, get hist() { return per(S.repo).hist; }, get cmp() { return per(S.repo).cmp; }, set cmp(v) { per(S.repo).cmp = v; },
  get br() { return per(S.repo).br; }, get st() { return per(S.repo).st; }, get tg() { return per(S.repo).tg; }, get rm() { return per(S.repo).rm; },
  get source() { return per(S.repo).source; }, set source(v) { per(S.repo).source = v; },
  get target() { return per(S.repo).target; }, set target(v) { per(S.repo).target = v; },
};
// Repository-local record. Nothing here leaks into another repo.
export function freshPer() {
  return {
    source: "", target: "", continuation: null,
    hist: { commits: [], skip: 0, hasMore: false, search: "", all: false, sel: null, info: null, file: null, fileFilter: "", parent: null, req: 0 },
    chg: { sel: new Set(), collapsed: {}, diffKey: null, amend: false, msg: "", view: "commit", shell: null },
    // compared = the user clicked Compare for the current source/target; ready = that review loaded completely
    cmp: { commits: [], files: [], sel: null, ab: null, compared: false, ready: false, ids: null, error: "", hasMore: false, req: 0 },
    br: { newName: "", from: "", checkout: true },
    st: { list: [], sel: null, files: [], file: null },
    tg: { list: [] }, rm: { list: [] },
  };
}
export function per(repo) { if (!repo) return freshPer(); return S.per[repo] || (S.per[repo] = freshPer()); }
export const TABS = [
  { id: "changes", name: "Changes", icon: "commit" },
  { id: "history", name: "History", icon: "history" },
  { id: "branches", name: "Branches", icon: "branch" },
  { id: "stashes", name: "Stashes", icon: "download" },
  { id: "tags", name: "Tags", icon: "key" },
  { id: "remotes", name: "Remotes", icon: "globe" },
];

export const h = (...a) => D.h(...a);
export const icon = (...a) => D.icon(...a);
export const shortRef = (r) => (r || "").replace(/^origin\//, "");
export const repoName = (p) => D.repoName(p);
export const abs = (repo, rel) => repo.replace(/[\\/]+$/, "") + "/" + rel;
export const alive = (gen) => S.back && document.body.contains(S.back) && gen === S.gen;
export const isOpen = () => !!(S.back && document.body.contains(S.back));
export const fmtDate = (iso) => { try { const d = new Date(iso); return isNaN(d) ? (iso || "") : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return iso || ""; } };
export const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : n + " B";
export const stat = (repo) => S.statuses[repo] || null;
export const statusOk = (repo) => { const s = stat(repo); return !!(s && s.repo && s.state !== "error"); };
export const conflicts = (repo) => (((stat(repo) || {}).files) || []).filter((f) => f.conflict).map((f) => f.path);
export const q = (sel) => (S.back ? S.back.querySelector(sel) : null);
export const spinner = (text) => h("div", { class: "gitc-loading", role: "status" }, h("span", { html: icon("spinner", 18, "spin") }), h("span", { text: text || "Loading…" }));
export const empty = (ic, title, sub) => h("div", { class: "gitc-empty" }, h("span", { class: "ge-ic", html: icon(ic, 30) }), h("div", { class: "ge-title", text: title }), sub ? h("div", { class: "ge-sub", text: sub }) : null);
export const fileIcon = (p, size = 14) => { const m = D.fileMeta(D.baseName(p)); return h("span", { class: "gitc-fico " + m.cls, html: icon(m.ic, size) }); };
export const codeChip = (f) => h("span", { class: "gitc-code c-" + (f.code || f.index || (f.label === "Untracked" ? "U" : f.label === "Unversioned" ? "X" : "M")), text: f.label || f.code || "" });
export const pm = (f) => (f.adds == null && f.dels == null) ? null : h("span", { class: "gitc-pm" }, f.binary ? h("span", { class: "ds-bin", text: "bin" }) : [h("span", { class: "ds-add", text: "+" + (f.adds || 0) }), h("span", { class: "ds-del", text: "−" + (f.dels || 0) })]);
// `mut` marks buttons that mutate the repo: they are disabled (not just dimmed) while it is busy or unreadable.
export const iconBtn = (ic, title, onClick, cls = "") => h("button", { class: "gitc-ibtn " + cls, title, "aria-label": title, html: icon(ic, 13), onclick: (e) => { e.stopPropagation(); onClick(e); } });
export const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem("gitc." + k)); return v == null ? d : v; } catch { return d; } };
export const lsSet = (k, v) => { try { localStorage.setItem("gitc." + k, JSON.stringify(v)); } catch { /* */ } };
// Keyboard activation for click-only rows (Enter / Space), plus focusability.
export function rowA11y(el, label) { el.tabIndex = 0; el.setAttribute("role", "button"); if (label) el.setAttribute("aria-label", label); el.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); el.click(); } }); return el; }
export const errText = (e) => (e && (e.message || e.error)) || String(e || "");
