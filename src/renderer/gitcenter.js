/* GIT CENTER — one modal for everything Git across every repo in the project.
 *
 *   ┌ [repo ▾] [Fetch] [Pull ▾] [Push] [Branch] [Stash] [⋮]              [Compare and Merge] ┐
 *   │ Changes · History · Branches · Stashes · Tags · Remotes                                  │
 *   │   (or the merge view bar: Source · Target · [Compare] [Create Merge] [Rebase] · summary) │
 *   │ ┌ tree / list ─┃─ diff (expandable) ─────────────────────────────────────────────────┐  │
 *   └─┴──────────────┸────────────────────────────────────────────────────────────────────┴──┘
 *
 * Pure UI: every git call goes through `atom.git.*` (main/git.js). Shared app
 * helpers (DOM builder, toasts, dialogs, diff renderer, the guided conflict
 * resolver) are injected via `deps` so this module stays decoupled from app.js.
 *
 * Contracts (audit 2026-09-09):
 *   REPO-BOUND     every action captures its repository (and the reviewed ids) when
 *                  it STARTS; switching repos afterwards never redirects it. Results
 *                  refresh and toast for the repo they ran in.
 *   PER-REPO STATE drafts, amend, selection, history/compare/stash/tag view state and
 *                  push continuations live in S.per[repo]; the S.chg/S.hist/... getters
 *                  resolve to the current repo's record.
 *   RESULTS        mutations resolve { ok, state: success|conflict|rejected|choice|partial|
 *                  failed }; every consumer branches on `state`; failures throw typed errors.
 *   GENERATIONS    loaded data is committed only if repo + request generation still match.
 *   STATUS STATES  ready | error | stale — a failed status never renders as "clean".
 *   STABLE SHELL   the Changes tab keeps its commit box + diff pane mounted across refreshes
 *                  (focus/caret/scroll survive); long lists are windowed.
 * Layering: this overlay (z 490) sits UNDER the diff / conflict overlays, the
 * modal shell and the small prompt dialogs. Pickers and confirm popovers are
 * fixed-position and sit above everything (z 700). */

let D = null;                 // injected deps (see openGitCenter)
const S = {                   // modal state (global part)
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
function freshPer() {
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
function per(repo) { if (!repo) return freshPer(); return S.per[repo] || (S.per[repo] = freshPer()); }
const TABS = [
  { id: "changes", name: "Changes", icon: "commit" },
  { id: "history", name: "History", icon: "history" },
  { id: "branches", name: "Branches", icon: "branch" },
  { id: "stashes", name: "Stashes", icon: "download" },
  { id: "tags", name: "Tags", icon: "key" },
  { id: "remotes", name: "Remotes", icon: "globe" },
];

const h = (...a) => D.h(...a);
const icon = (...a) => D.icon(...a);
const shortRef = (r) => (r || "").replace(/^origin\//, "");
const repoName = (p) => D.repoName(p);
const abs = (repo, rel) => repo.replace(/[\\/]+$/, "") + "/" + rel;
const alive = (gen) => S.back && document.body.contains(S.back) && gen === S.gen;
const isOpen = () => !!(S.back && document.body.contains(S.back));
const fmtDate = (iso) => { try { const d = new Date(iso); return isNaN(d) ? (iso || "") : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return iso || ""; } };
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : n + " B";
const stat = (repo) => S.statuses[repo] || null;
const statusOk = (repo) => { const s = stat(repo); return !!(s && s.repo && s.state !== "error"); };
const conflicts = (repo) => (((stat(repo) || {}).files) || []).filter((f) => f.conflict).map((f) => f.path);
const q = (sel) => (S.back ? S.back.querySelector(sel) : null);
const spinner = (text) => h("div", { class: "gitc-loading", role: "status" }, h("span", { html: icon("spinner", 18, "spin") }), h("span", { text: text || "Loading…" }));
const empty = (ic, title, sub) => h("div", { class: "gitc-empty" }, h("span", { class: "ge-ic", html: icon(ic, 30) }), h("div", { class: "ge-title", text: title }), sub ? h("div", { class: "ge-sub", text: sub }) : null);
const fileIcon = (p, size = 14) => { const m = D.fileMeta(D.baseName(p)); return h("span", { class: "gitc-fico " + m.cls, html: icon(m.ic, size) }); };
const codeChip = (f) => h("span", { class: "gitc-code c-" + (f.code || f.index || (f.label === "Untracked" ? "U" : f.label === "Unversioned" ? "X" : "M")), text: f.label || f.code || "" });
const pm = (f) => (f.adds == null && f.dels == null) ? null : h("span", { class: "gitc-pm" }, f.binary ? h("span", { class: "ds-bin", text: "bin" }) : [h("span", { class: "ds-add", text: "+" + (f.adds || 0) }), h("span", { class: "ds-del", text: "−" + (f.dels || 0) })]);
// `mut` marks buttons that mutate the repo: they are disabled (not just dimmed) while it is busy or unreadable.
const iconBtn = (ic, title, onClick, cls = "") => h("button", { class: "gitc-ibtn " + cls, title, "aria-label": title, html: icon(ic, 13), onclick: (e) => { e.stopPropagation(); onClick(e); } });
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem("gitc." + k)); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem("gitc." + k, JSON.stringify(v)); } catch { /* */ } };
// Keyboard activation for click-only rows (Enter / Space), plus focusability.
function rowA11y(el, label) { el.tabIndex = 0; el.setAttribute("role", "button"); if (label) el.setAttribute("aria-label", label); el.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); el.click(); } }); return el; }
const errText = (e) => (e && (e.message || e.error)) || String(e || "");

/* ============================ generic widgets ============================ */
// Searchable, keyboard-navigable list anchored under an element. Bounded height
// (scrolls inside), groups, hints, optional footer (e.g. a "rebase" toggle).
// Every dismissal route (pick, Escape, outside click, resize, closePick) settles
// `onCancel` exactly once when nothing was picked.
let _pick = null;
function closePick() { if (_pick) { const p = _pick; _pick = null; clearTimeout(p.timer); p.el.remove(); document.removeEventListener("mousedown", p.out, true); window.removeEventListener("resize", p.close); if (!p.picked && p.onCancel) { try { p.onCancel(); } catch { /* */ } } } }
function pickList(anchor, { items, value, onPick, onCancel, placeholder = "Search…", width, footer, emptyText = "No matches", label }) {
  closePick();
  const el = h("div", { class: "gitc-pick", role: "listbox", "aria-label": label || placeholder });
  const input = h("input", { class: "gitc-pick-in", placeholder, spellcheck: "false", "aria-label": placeholder });
  const list = h("div", { class: "gitc-pick-list" });
  el.append(h("div", { class: "gitc-pick-search" }, h("span", { html: icon("search", 13) }), input), list, footer ? h("div", { class: "gitc-pick-foot" }, footer) : null);
  document.body.append(el);
  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: window.innerWidth / 2 - 140, width: 280, top: window.innerHeight / 2, bottom: window.innerHeight / 2 };
  const w = Math.max(width || 0, r.width, 280);
  const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
  const up = below < 280 && above > below;
  const maxH = Math.max(220, Math.min(460, up ? above : below));
  el.style.width = Math.min(w, window.innerWidth - 16) + "px";
  el.style.maxHeight = maxH + "px";
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  if (up) el.style.bottom = (window.innerHeight - r.top + 4) + "px"; else el.style.top = (r.bottom + 4) + "px";
  let cursor = 0, shown = [];
  const norm = (s) => String(s || "").toLowerCase();
  const rec = { el, picked: false, onCancel, timer: null };
  const pick = (it) => { rec.picked = true; closePick(); onPick(it.value, it); };
  const draw = () => {
    const needle = norm(input.value).trim().split(/\s+/).filter(Boolean);
    shown = items.filter((it) => !needle.length || needle.every((n) => norm(it.label).includes(n) || norm(it.hint).includes(n) || norm(it.group).includes(n)));
    list.innerHTML = "";
    if (!shown.length) { list.append(h("div", { class: "gitc-pick-empty", text: emptyText })); return; }
    cursor = Math.max(0, Math.min(cursor, shown.length - 1));
    let lastGroup = null;
    shown.forEach((it, i) => {
      if (it.group && it.group !== lastGroup) { list.append(h("div", { class: "gitc-pick-group", text: it.group })); lastGroup = it.group; }
      const row = h("div", { class: "gitc-pick-item" + (i === cursor ? " cur" : "") + (it.value === value ? " sel" : "") + (it.danger ? " danger" : ""), role: "option", "aria-selected": it.value === value ? "true" : "false", onmousedown: (e) => e.preventDefault(), onclick: () => pick(it), onmousemove: () => { if (cursor !== i) { cursor = i; for (const c of list.children) c.classList.remove("cur"); row.classList.add("cur"); } } },
        h("span", { class: "gitc-pick-ic", html: icon(it.value === value ? "check" : (it.icon || "branch"), 13) }),
        h("span", { class: "gitc-pick-label", text: it.label }),
        it.hint ? h("span", { class: "gitc-pick-hint", text: it.hint }) : null,
        it.badge ? h("span", { class: "gitc-pick-badge", text: it.badge }) : null);
      list.append(row);
    });
    const cur = list.querySelector(".gitc-pick-item.cur"); if (cur) cur.scrollIntoView({ block: "nearest" });
  };
  const close = () => closePick();
  const out = (e) => { if (!el.contains(e.target)) close(); };
  input.addEventListener("input", () => { cursor = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); cursor = Math.min(shown.length - 1, cursor + 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cursor = Math.max(0, cursor - 1); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); const it = shown[cursor]; if (it) pick(it); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  rec.out = out; rec.close = close;
  _pick = rec;
  rec.timer = setTimeout(() => { if (_pick === rec) document.addEventListener("mousedown", out, true); }, 0);   // cancelled if closed first
  window.addEventListener("resize", close);
  const selIdx = items.findIndex((it) => it.value === value); if (selIdx >= 0) cursor = selIdx;
  draw();
  setTimeout(() => { if (_pick === rec) input.focus(); }, 10);
  return el;
}
// Small anchored confirmation (push / merge / rebase / stash …) with optional fields.
// Resolves { ok, values } — values from `fields` ({ id, type: "text"|"check", label, value, placeholder }).
// Settles exactly once on Confirm, Cancel, Escape, outside click or window resize.
function confirmPop(anchor, { title, message, confirmLabel = "Confirm", danger, ic, fields = [], width = 340, details }) {
  return new Promise((resolve) => {
    closePick();
    const el = h("div", { class: "gitc-pop" + (danger ? " danger" : ""), role: "dialog", "aria-modal": "false", "aria-label": title });
    const inputs = {};
    const body = h("div", { class: "gitc-pop-body" }, message ? h("div", { class: "gitc-pop-msg", text: message }) : null, details ? h("div", { class: "gitc-pop-details" }, ...[].concat(details).map((d) => h("div", { class: "gitc-pop-detail" }, h("span", { class: "gitc-pop-dk", text: d.k }), h("code", { text: d.v }))) ) : null);
    for (const f of fields) {
      if (f.type === "check") { const cb = h("input", { type: "checkbox", class: "aqx-check" }); cb.checked = !!f.value; inputs[f.id] = cb; body.append(h("label", { class: "gitc-check" }, cb, h("span", { text: f.label }))); }
      else { const inp = h(f.multiline ? "textarea" : "input", { class: "gitc-input grow", placeholder: f.placeholder || "", spellcheck: "true", rows: f.multiline ? "2" : undefined, "aria-label": f.label || f.placeholder || f.id }); inp.value = f.value || ""; inputs[f.id] = inp; body.append(f.label ? h("div", { class: "gitc-pop-label", text: f.label }) : null, inp); }
    }
    let done = false, timer = null;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); el.remove(); document.removeEventListener("mousedown", out, true); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", onResize); const values = {}; for (const k of Object.keys(inputs)) values[k] = inputs[k].type === "checkbox" ? inputs[k].checked : inputs[k].value; resolve({ ok, values }); };
    const out = (e) => { if (!el.contains(e.target)) finish(false); };
    const onResize = () => finish(false);
    const key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } else if (e.key === "Enter" && !(e.target && e.target.tagName === "TEXTAREA")) { e.preventDefault(); finish(true); } };
    el.append(
      h("div", { class: "gitc-pop-head" }, h("span", { class: "gitc-pop-ic", html: icon(ic || (danger ? "alert" : "check"), 15) }), h("span", { text: title })),
      body,
      h("div", { class: "gitc-pop-acts" }, h("button", { class: "gitc-act sm", onclick: () => finish(false) }, "Cancel"), h("button", { class: "gitc-act sm " + (danger ? "danger" : "primary"), onclick: () => finish(true) }, confirmLabel)));
    document.body.append(el);
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: window.innerWidth / 2 - width / 2, right: window.innerWidth / 2 + width / 2, top: window.innerHeight / 2, bottom: window.innerHeight / 2 };
    el.style.width = Math.min(width, window.innerWidth - 16) + "px";
    const eh = el.offsetHeight || 160;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    el.style.left = left + "px";
    if (r.bottom + 6 + eh < window.innerHeight - 8) el.style.top = (r.bottom + 6) + "px"; else el.style.top = Math.max(8, r.top - eh - 6) + "px";
    timer = setTimeout(() => { if (done) return; document.addEventListener("mousedown", out, true); document.addEventListener("keydown", key, true); window.addEventListener("resize", onResize); const first = el.querySelector("input:not([type=checkbox]), textarea"); if (first) first.focus(); else el.querySelector(".gitc-act.primary, .gitc-act.danger").focus(); }, 0);
  });
}
// Resizable columns: every part but the last keeps an explicit width (persisted per key).
// Dividers are keyboard separators (← → resize, Home resets).
function splitPane(parts, { key, sizes = [], min = 180 }) {
  const wrap = h("div", { class: "gitc-split" });
  const saved = lsGet("split." + key, null);
  const save = () => lsSet("split." + key, parts.slice(0, -1).map((p) => Math.round(p.getBoundingClientRect().width)));
  parts.forEach((el, i) => {
    el.classList.add("gitc-split-part");
    if (i < parts.length - 1) {
      const w = (saved && saved[i]) || sizes[i] || 300;
      el.style.flex = "0 0 auto"; el.style.width = w + "px";
      const div = h("div", { class: "gitc-divider", title: "Drag to resize · double-click to reset · ← → with keyboard", role: "separator", "aria-orientation": "vertical", tabindex: "0", "aria-label": "Resize panes" });
      const clamp = (w2) => { const total = wrap.getBoundingClientRect().width; return Math.max(min, Math.min(total - min * (parts.length - 1 - i) - 20, w2)); };
      div.addEventListener("dblclick", () => { el.style.width = (sizes[i] || 300) + "px"; save(); });
      div.addEventListener("keydown", (e) => {
        const cur = el.getBoundingClientRect().width;
        if (e.key === "ArrowLeft") { e.preventDefault(); el.style.width = clamp(cur - 24) + "px"; save(); }
        else if (e.key === "ArrowRight") { e.preventDefault(); el.style.width = clamp(cur + 24) + "px"; save(); }
        else if (e.key === "Home") { e.preventDefault(); el.style.width = (sizes[i] || 300) + "px"; save(); }
      });
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const startX = e.clientX, startW = el.getBoundingClientRect().width;
        div.classList.add("dragging"); document.body.classList.add("gitc-resizing");
        const move = (ev) => { el.style.width = clamp(startW + ev.clientX - startX) + "px"; };
        const upH = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", upH); div.classList.remove("dragging"); document.body.classList.remove("gitc-resizing"); save(); };
        document.addEventListener("mousemove", move); document.addEventListener("mouseup", upH);
      });
      wrap.append(el, div);
    } else { el.style.flex = "1 1 0"; el.style.minWidth = "0"; wrap.append(el); }
  });
  return wrap;
}
// Collapsible section. The header is one large click target (chevron · title ·
// count · a single select-all checkbox on the right); bulk actions live in an
// optional contextual `bar` at the top of the body, shown when files are selected.
function section({ id, title, count, danger, actions, bar, body, open = true, onToggle }) {
  const sec = h("div", { class: "gitc-sec" + (danger ? " conflict" : "") + (open ? " open" : "") });
  const head = h("div", { class: "gitc-sec-head", title: "Click to collapse / expand", role: "button", tabindex: "0", "aria-expanded": open ? "true" : "false", onclick: (e) => { if (e.target.closest("button, input, label")) return; sec.classList.toggle("open"); head.setAttribute("aria-expanded", sec.classList.contains("open") ? "true" : "false"); if (onToggle) onToggle(sec.classList.contains("open")); }, onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === head) { e.preventDefault(); head.click(); } } },
    h("span", { class: "gitc-sec-chev", html: icon("chevron", 12) }),
    h("span", { class: "gitc-sec-title", text: title }),
    count != null ? h("span", { class: "gitc-col-count" + (danger ? " danger" : ""), text: String(count) }) : null,
    h("div", { class: "gitc-spacer" }),
    h("span", { class: "gitc-sec-acts" }, ...(actions || [])));
  sec.append(head, h("div", { class: "gitc-sec-body" }, bar || null, body));
  sec.dataset.id = id || "";
  return sec;
}
/* Windowed list: only the rows near the viewport are mounted, the rest is one
 * spacer. `rows` is the full dataset (never truncated); `render(row, i)` builds
 * one element; `rowH` is the fixed row height. Small lists render plainly. */
const VIRTUAL_MIN = 200;
function virtualList(scroller, rows, rowH, render, { onRendered } = {}) {
  const host = h("div", { class: "gitc-vlist", style: `position:relative;height:${rows.length * rowH}px` });
  if (rows.length < VIRTUAL_MIN) { host.style.height = ""; host.style.position = ""; rows.forEach((r, i) => host.append(render(r, i))); if (onRendered) onRendered(); host._refresh = () => {}; return host; }
  let last = null, raf = 0;
  const draw = () => {
    raf = 0;
    if (!host.isConnected) return;
    const sTop = scroller.scrollTop, sH = scroller.clientHeight || 600;
    const hostTop = host.offsetTop;
    const first = Math.max(0, Math.floor((sTop - hostTop) / rowH) - 8), lastIdx = Math.min(rows.length, Math.ceil((sTop - hostTop + sH) / rowH) + 8);
    if (last && last[0] === first && last[1] === lastIdx) return;
    last = [first, lastIdx];
    host.innerHTML = "";
    for (let i = first; i < lastIdx; i++) { const el = render(rows[i], i); el.style.position = "absolute"; el.style.top = (i * rowH) + "px"; el.style.left = "0"; el.style.right = "0"; el.style.height = rowH + "px"; host.append(el); }
    if (onRendered) onRendered();
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(draw); };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  host._refresh = () => { last = null; draw(); };
  host._dispose = () => scroller.removeEventListener("scroll", onScroll);
  // First window: as soon as the caller has appended the host (microtask), and again on
  // the next frame once layout is known. `draw` is idempotent for an unchanged window.
  Promise.resolve().then(draw);
  requestAnimationFrame(() => { last = null; draw(); });
  return host;
}

/* ============================ open / close ============================ */
export async function openGitCenter(deps, { repo, tab } = {}) {
  D = deps;
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
function close() {
  closePick();
  S.gen++;                                                   // every pending load is now obsolete
  for (const off of S.unsub.splice(0)) { try { off(); } catch { /* */ } }
  if (S.back) S.back.remove();
  S.back = null;
  unbindKeys();
  const op = S.opener; S.opener = null;
  if (op && op.isConnected && typeof op.focus === "function") { try { op.focus({ preventScroll: true }); } catch { /* */ } }
}
let _keys = null;
function bindKeys() {
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
function unbindKeys() { if (_keys) { document.removeEventListener("keydown", _keys, true); _keys = null; } }
// Live operation events (start / output / end) and external repository changes.
function subscribeEvents() {
  const ev = D.atom && D.atom.events;
  if (!ev) return;
  if (ev.onGitProgress) S.unsub.push(ev.onGitProgress((e) => onGitProgress(e)));
  if (ev.onGitChanged) S.unsub.push(ev.onGitChanged((e) => onGitChanged(e)));
}
const _changedT = new Map();
function onGitChanged(e) {
  const repo = e && e.repo; if (!repo || !isOpen()) return;
  const key = S.repos.find((r) => r.toLowerCase() === String(repo).replace(/\\/g, "/").toLowerCase()) || repo;
  if (!S.repos.includes(key)) return;
  clearTimeout(_changedT.get(key));
  _changedT.set(key, setTimeout(() => { _changedT.delete(key); if (!S.inflight.get(key)) refreshRepo(key, { quiet: true }); }, 350));   // coalesced; never while our own op runs
}
// Operation strip: label · last line git printed · Cancel (for the current repo's operation).
function onGitProgress(e) {
  if (!e || !e.opId) return;
  if (e.kind === "start") S.ops.set(e.opId, { label: e.label, cwd: (e.cwd || "").replace(/\\/g, "/"), line: "", started: Date.now() });
  const op = S.ops.get(e.opId); if (!op) return;
  if (e.kind === "output") { const lines = String(e.text || "").split(/\r|\n/).map((s) => s.trim()).filter(Boolean); if (lines.length) op.line = lines[lines.length - 1]; }
  if (e.kind === "end") { S.ops.delete(e.opId); }
  renderOpLog();
}
function renderOpLog() {
  const el = q(".gitc-oplog"); if (!el) return;
  const mine = [...S.ops.entries()].filter(([, op]) => !op.cwd || !S.repo || op.cwd.toLowerCase() === S.repo.replace(/\\/g, "/").toLowerCase());
  if (!mine.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const [opId, op] = mine[mine.length - 1];
  el.classList.remove("hidden"); el.innerHTML = "";
  el.append(h("span", { class: "gitc-oplog-label", text: op.label || "git" }), h("span", { class: "gitc-oplog-line", text: op.line || "running…", title: op.line || "" }),
    h("button", { class: "gitc-oplog-cancel", title: "Stop this git operation", onclick: () => { D.atom.git.cancel(opId).catch(() => {}); } }, "Cancel"));
}

/* ============================ data loading ============================ */
async function loadRepos() {
  const root = D.projectRoot();
  let repos = [];
  S.discoveryError = "";
  try { repos = root ? await D.atom.git.repos(root) : []; } catch (e) { repos = []; S.discoveryError = errText(e); }
  if (!isOpen()) return;
  S.repos = repos;
  try { if (D.atom.git.watch) D.atom.git.watch(repos).catch(() => {}); } catch { /* optional */ }
  await loadStatuses();
}
/* Status snapshot per repo. A FAILED read keeps the previous snapshot and marks it
 * stale/error — it is never presented as a clean tree. */
async function loadStatus(repo) {
  const prev = S.statuses[repo];
  try {
    const s = await D.atom.git.status(repo);
    return s && s.repo === false ? { repo: false, state: "notRepo", files: [], branch: "", error: "Not a Git repository (anymore)." } : { ...s, state: "ready", error: "" };
  } catch (e) {
    // `stale` = an older SUCCESSFUL snapshot is being shown (it survives repeated failures)
    return { ...(prev && prev.repo ? prev : { repo: true, branch: "", files: [] }), state: "error", stale: !!(prev && (prev.state === "ready" || prev.stale)), error: errText(e), type: e && e.type, files: (prev && prev.files) || [], clean: false };
  }
}
async function loadStatuses() {
  const gen = S.gen;
  const st = {};
  await Promise.all(S.repos.map(async (r) => { st[r] = await loadStatus(r); }));
  if (!isOpen() || gen !== S.gen) { Object.assign(S.statuses, st); return; }   // still record — data is repo-keyed, not view-keyed
  S.statuses = { ...S.statuses, ...st };
  renderRepoDD(); renderStateBar();
}
function pickRefs(repo) {
  const P = per(repo), info = S.infos[repo]; if (!info) return;
  const names = new Set([...info.locals.map((b) => b.name), ...info.remotes.map((b) => b.name)]);
  if (!names.has(P.source)) P.source = info.current && info.current !== "HEAD" ? info.current : (info.locals[0] ? info.locals[0].name : "");
  if (!names.has(P.target) || P.target === P.source) P.target = defaultTargetFor(repo);
}
async function selectRepo(repo) {
  const gen = ++S.gen;
  const prev = S.repo;
  S.repo = repo;
  if (prev !== repo) { const P = per(repo); P.cmp = { ...P.cmp, compared: false, ready: false, ids: null, sel: null }; P.chg.diffKey = P.chg.diffKey || null; }
  renderRepoDD(); renderBar(); renderBanner(); renderStateBar(); renderOpLog();
  const c = q(".gitc-content"); if (c) { c.innerHTML = ""; c.append(spinner("Reading branches…")); }
  let info = null, err = null;
  try { info = await D.atom.git.branchesDetailed(repo); } catch (e) { err = e; }
  if (!alive(gen) || S.repo !== repo) { if (info) S.infos[repo] = info; return; }   // stale response: record for its own repo only, never render
  if (err) { c.innerHTML = ""; c.append(empty("alert", "Couldn't read this repository", errText(err))); return; }
  S.infos[repo] = info;
  pickRefs(repo);
  renderBar(); renderBanner(); renderTabs();
  await renderMain();                                        // (bumps S.gen for its own loads)
  if (isOpen() && S.repo === repo) offerContinuation(repo);
}
function defaultTargetFor(repo) {
  const info = S.infos[repo], P = per(repo);
  const locals = info ? info.locals.map((b) => b.name) : [];
  for (const p of ["main", "master", "develop"]) if (locals.includes(p) && p !== P.source) return p;
  const all = [...locals, ...(info ? info.remotes.map((b) => b.name) : [])];
  return all.find((b) => b !== P.source) || "";
}
function defaultTarget() { return defaultTargetFor(S.repo); }
/* Re-read ONE repository (status + branches) and redraw if it is the visible one.
 * The Changes shell is kept mounted, so a draft being typed is never disturbed. */
async function refreshRepo(repo, { quiet = false, keepTab = true, skipStatus = false } = {}) {
  if (!isOpen() || !repo) return;
  const gen = S.gen;
  const [st, info] = await Promise.all([skipStatus ? Promise.resolve(S.statuses[repo]) : loadStatus(repo), D.atom.git.branchesDetailed(repo).catch(() => null)]);
  if (!isOpen()) return;
  if (st) S.statuses[repo] = st;
  if (info) S.infos[repo] = info;
  if (repo !== S.repo || gen !== S.gen) { renderRepoDD(); return; }
  pickRefs(repo);
  renderRepoDD(); renderBar(); renderBanner(); renderStateBar(); renderTabs(); renderCmpBar();
  if (keepTab) await renderMain({ soft: true });
  if (!quiet) { try { D.refreshGit(); D.refreshTree(true); } catch { /* sidebar sync is best-effort */ } }
  offerContinuation(repo);
}
// Re-read everything and redraw the current repo.
async function refreshAll({ keepTab = true } = {}) {
  if (!isOpen()) return;
  const gen = S.gen;
  await loadStatuses();
  if (!S.repo || !alive(gen)) return;
  await refreshRepo(S.repo, { keepTab, skipStatus: true });   // statuses were just read for every repo
}
/* A push that was waiting on a pull/merge/rebase in THIS repo: offered only when
 * the same repo is visible, its operation finished, nothing is conflicted and the
 * branch still matches what the continuation was created for. */
async function offerContinuation(repo) {
  const P = per(repo), c = P.continuation;
  if (!c || c.kind !== "push" || repo !== S.repo || c.offering) return;
  const s = stat(repo), info = S.infos[repo];
  if (!statusOk(repo) || !info || (info.state && info.state.op) || conflicts(repo).length) return;
  if (info.current !== c.branch) { P.continuation = null; return; }   // switched branch meanwhile → the push no longer applies
  c.offering = true;
  const r = await confirmPop(q(".gitc-act.pushbtn") || q(".gitc-bar"), { title: `Push ${c.branch} now?`, ic: "push", message: `The remote changes are merged into “${c.branch}” in ${repoName(repo)}. Push your commits to ${c.remote}/${c.dest} now?`, confirmLabel: "Push" });
  c.offering = false;
  if (P.continuation !== c) return;                          // aborted / replaced meanwhile
  P.continuation = null;
  if (r.ok && S.repo === repo && (stat(repo) || {}).branch === c.branch) doPush({ repo, skipConfirm: true, remote: c.remote, dest: c.dest });
}

/* ============================ actions ============================ */
/* Run ONE mutating action for ONE repository (captured at the start, never re-read
 * from S.repo). Busy state disables mutation controls semantically; a second
 * submission for the same repo while one is in flight is ignored. The typed result
 * is returned: { ok, state, ... } — conflicts open the Changes tab (or `onConflict`),
 * failures toast with complete diagnostics, never a success message. */
async function act(label, fn, { repo = S.repo, silent, onConflict, refresh = true } = {}) {
  if (!repo) return { ok: false, state: "failed", error: "No repository selected" };
  if (S.inflight.get(repo)) { D.toast(`<b>${D.esc(S.inflight.get(repo))}</b><span class="toast-sub">is still running in ${D.esc(repoName(repo))} — wait for it to finish.</span>`, "alert", { ms: 2600 }); return { ok: false, state: "busy", busy: true }; }
  S.inflight.set(repo, label); S.busy++; setBusy(true);
  if (!silent) D.toast(D.esc(label) + "…", "spinner", { sticky: true, spin: true });
  let res = null, err = null;
  try { res = await fn(repo); } catch (e) { err = e; }
  S.inflight.delete(repo); S.busy--; setBusy(S.busy > 0);
  if (err) { failToast(label, err, repo); if (refresh) await refreshRepo(repo); return { ok: false, state: "failed", error: errText(err), type: err && err.type, details: err && err.details, failed: true }; }
  if (refresh) await refreshRepo(repo);
  const state = res && res.state ? res.state : (res && res.ok === false ? (res.conflict ? "conflict" : "failed") : "success");
  if (state === "conflict" || (res && res.conflict)) {
    D.toast(`<b>${D.esc(label)}: conflicts in ${D.esc(repoName(repo))}</b><span class="toast-sub">Per file: Keep mine · Accept incoming · Resolve lines… — then Continue from the banner.</span>`, "alert", { ms: 6500 });
    if (onConflict) onConflict(res); else if (repo === S.repo) showConflicts();
    return { ...res, ok: false, state: "conflict", conflict: true };
  }
  if (state === "rejected" || state === "choice" || state === "busy") return res;
  if (state === "partial") { D.toast(`<b>${D.esc(label)}: partly done</b><span class="toast-sub">${D.esc(partialSummary(res))}</span>`, "alert", { ms: 7000 }); return res; }
  if (state === "failed" || (res && res.ok === false)) { D.toast(`<b>${D.esc(label)} failed</b><span class="toast-sub">${D.esc(res && (res.error || res.message) || "see details")}</span>`, "alert", { ms: 7000 }); return { ...res, ok: false, state: "failed", failed: true }; }
  if (!silent) D.toast(D.esc(label) + " done", "checkCircle", { ms: 2600 });
  return res || { ok: true, state: "success" };
}
function partialSummary(res) {
  if (!res) return "";
  if (Array.isArray(res.results)) { const bad = res.results.filter((x) => !x.ok); return bad.map((x) => `${x.path || ""}${x.phase ? ` (${x.phase})` : ""}: ${x.error || "failed"}`).join(" · ") || res.error || ""; }
  if (res.reconcileError) return `Committed ${String(res.commit || "").slice(0, 7)}, but the index could not be updated for: ${res.reconcileError}`;
  if (res.phases) return Object.entries(res.phases).filter(([, v]) => v).map(([k, v]) => `${k}: ${v.ok ? "done" : (v.error || "failed")}`).join(" · ");
  return res.error || "";
}
// Failure toast with a "Details" affordance that opens the complete diagnostics.
function failToast(label, err, repo) {
  const msg = errText(err);
  const details = err && err.details;
  D.toast(`<b>${D.esc(label)} failed${repo ? ` (${D.esc(repoName(repo))})` : ""}</b><span class="toast-sub">${D.esc(msg)}${details && details.trim() && details.trim() !== msg ? " — details in the Git panel" : ""}</span>`, "alert", { ms: 7000 });
  if (details && details.trim() && details.trim() !== msg && isOpen()) showErrorDetails(label, err);
}
function showErrorDetails(label, err) {
  const st = q(".gitc-state"); if (!st) return;
  st.classList.remove("hidden", "stale"); st.classList.add("error"); st.innerHTML = "";
  st.append(h("span", { class: "gitc-state-ic", html: icon("alert", 14) }), h("b", { text: `${label} failed` }), h("span", { text: errText(err) }),
    h("div", { class: "gitc-spacer" }),
    h("button", { class: "gitc-act sm", onclick: () => { const back = D.modalShell({ title: `${label} — git output`, ic: "alert", wide: true, body: h("div", {}, err.type ? h("span", { class: "gitc-errtype", text: err.type }) : null, h("pre", { class: "gitc-errdetails", text: err.details || errText(err) })) }); back.querySelector(".modal").classList.add("gitc-fileview-modal"); } }, "Details"),
    h("button", { class: "gitc-act sm", onclick: () => renderStateBar() }, "Dismiss"));
}
function setBusy(on) {
  const p = q(".gitc-progress"); if (p) { p.classList.toggle("on", !!on); p.setAttribute("aria-hidden", on ? "false" : "true"); }
  if (S.back) { S.back.classList.toggle("busy", !!on); const panel = q(".gitc-panel"); if (panel) panel.setAttribute("aria-busy", on ? "true" : "false"); }
  syncMutationControls();
}
// Buttons that mutate are DISABLED (keyboard included) while the repo is busy or unreadable.
function syncMutationControls() {
  if (!S.back) return;
  const busy = !!S.inflight.get(S.repo), bad = !!S.repo && !statusOk(S.repo);
  S.back.classList.toggle("readonly", bad);
  for (const el of S.back.querySelectorAll(".gitc-act.mut, .gitc-ibtn.mut, .gitc-hbtn.mut")) { if (busy || bad) { if (!el.disabled) { el.dataset.busyDisabled = "1"; el.disabled = true; } } else if (el.dataset.busyDisabled) { delete el.dataset.busyDisabled; el.disabled = false; } }
}
/* Run one action per repository, sequentially, and summarise EVERY result by state
 * (success / conflict / rejected / failed / partial). A conflict is never a success. */
async function forAll(label, fn, filter) {
  const list = S.repos.filter((r) => !filter || filter(r));
  if (!list.length) { D.toast("Nothing to " + label.toLowerCase(), "check"); return [];
  }
  const results = [];
  for (const r of list) {
    D.toast(`${D.esc(label)} ${D.esc(repoName(r))}…`, "spinner", { sticky: true, spin: true });
    if (S.inflight.get(r)) { results.push({ r, state: "busy", ok: false, err: "another operation is running" }); continue; }
    S.inflight.set(r, label); S.busy++; setBusy(true);
    try {
      const res = await fn(r);
      const state = res && res.state ? res.state : (res && res.ok === false ? (res.conflict ? "conflict" : "failed") : "success");
      results.push({ r, res, state, ok: state === "success", err: state === "success" ? "" : (state === "conflict" ? "conflicts to resolve" : state === "rejected" ? (res.error || "push rejected — pull first") : (res && (res.error || res.message)) || state) });
    } catch (e) { results.push({ r, state: "failed", ok: false, err: errText(e) }); }
    finally { S.inflight.delete(r); S.busy--; setBusy(S.busy > 0); }
  }
  const bad = results.filter((x) => !x.ok);
  D.toast(bad.length ? `<b>${D.esc(label)}: ${results.length - bad.length} ok, ${bad.length} need attention</b><span class="toast-sub">${bad.map((x) => D.esc(repoName(x.r)) + ": " + D.esc(x.err)).join("<br>")}</span>` : `${D.esc(label)} done for ${results.length} repo${results.length > 1 ? "s" : ""}`, bad.length ? "alert" : "checkCircle", { ms: bad.length ? 8000 : 3200 });
  await refreshAll();
  const conf = results.find((x) => x.state === "conflict");
  if (conf && conf.r === S.repo) showConflicts();
  return results;
}
// Line-level resolver (full-screen overlay on top of the Git Center). The conflicted
// paths are passed explicitly so it never depends on the sidebar's git state.
function openResolver(file, repo = S.repo) {
  const list = conflicts(repo);
  if (!list.length) { refreshRepo(repo); return; }
  Promise.resolve(D.refreshGit()).catch(() => {}).then(() => D.openConflictResolver(repo, file || list[0], list));
}
// Conflicts arrived (pull / merge / rebase): land on the Changes tab where every
// conflicted file has Keep mine / Accept incoming / Resolve lines… — no modal jumps.
function showConflicts() { S.mode = "tabs"; S.tab = "changes"; renderBar(); renderTabs(); renderCmpBar(); renderMain(); }
async function confirmDanger(title, message, label) {
  const c = await D.chooseDialog({ title, ic: "alert", message, choices: [{ label, value: "yes", primary: true }, { label: "Cancel", value: null }] });
  return c === "yes";
}
// Text prompt → string, or null on ANY dismissal (Cancel, ×, Escape, backdrop).
function prompt(opts) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const r = D.promptDialog({ ...opts, onConfirm: (v) => finish(v == null ? "" : v), onCancel: () => finish(null) });
    if (r && typeof r.then === "function") r.then((v) => finish(v === undefined ? null : v), () => finish(null));
  });
}
// Choose a remote by name: the only one when one exists, else a picker. `prefer` wins when present.
async function chooseRemote(repo, anchor, { prefer, title = "Which remote?" } = {}) {
  let names = [];
  try { names = (await D.atom.git.remotes(repo)).remotes.map((r) => r.name); } catch { names = []; }
  if (!names.length) { D.toast("This repository has no remotes — add one in the Remotes tab.", "alert"); return ""; }
  if (prefer && names.includes(prefer)) return prefer;
  if (names.length === 1) return names[0];
  return new Promise((resolve) => pickList(anchor || q(".gitc-bar"), { items: names.map((n) => ({ value: n, label: n, icon: "globe" })), placeholder: title, width: 320, onPick: (v) => resolve(v), onCancel: () => resolve("") }));
}
// --- branch-level operations (each captures `repo` when it starts) ---
const kindOf = (repo, name) => { const info = S.infos[repo]; if (!info || !name) return "unknown"; if (info.locals.some((b) => b.name === name)) return "local"; if (info.remotes.some((b) => b.name === name)) return "remote"; if (per(repo).tg.list.some((t) => t.name === name)) return "tag"; return "unknown"; };
async function doMerge(source, target, anchor, repo = S.repo) {
  if (!source || !target || source === target) { D.toast("Pick two different branches", "alert"); return; }
  const tk = kindOf(repo, target);
  if (tk !== "local") {
    D.toast(`<b>“${D.esc(target)}” can't be a merge target</b><span class="toast-sub">${tk === "remote" ? "It is a remote-tracking branch — check it out as a local branch (Branches tab), then merge into that." : tk === "tag" ? "Tags can't receive merges — pick a local branch." : "Merge targets must be local branches."}</span>`, "alert", { ms: 6500 });
    return;
  }
  const info = S.infos[repo], cur = info ? info.current : "";
  const note = target === cur ? "" : ` “${shortRef(target)}” is checked out first.`;
  const P = per(repo);
  const expect = P.cmp.ready && P.cmp.ids ? P.cmp.ids : await D.atom.git.resolveRefs(repo, [source, target]).catch(() => null);
  const c = await confirmPop(anchor || q(".gitc-act.mergebtn"), { title: `Merge ${shortRef(source)} → ${shortRef(target)}`, ic: "merge", message: `Merges “${shortRef(source)}” into “${shortRef(target)}” in ${repoName(repo)}.${note}`, confirmLabel: "Merge", details: expect ? [{ k: "source", v: `${source} @ ${String(expect[source] || "?").slice(0, 10)}` }, { k: "target", v: `${target} @ ${String(expect[target] || "?").slice(0, 10)}` }] : null, fields: [{ id: "msg", label: "Merge commit message", value: `Merge branch '${shortRef(source)}' into ${shortRef(target)}`, placeholder: "Merge commit message" }] });
  if (!c.ok) return;
  const r = await act(`Merge ${shortRef(source)} → ${shortRef(target)}`, () => D.atom.git.mergeBranches(repo, source, target, (c.values.msg || "").trim(), { expect: expect || undefined }), { repo, silent: true });
  if (r && r.ok) D.toast(`Merged ${D.esc(shortRef(source))} → ${D.esc(shortRef(target))} in ${D.esc(repoName(repo))} (${r.upToDate ? "already up to date" : r.fastForward ? "fast-forward" : "merge commit"})`, "checkCircle", { ms: 4200 });
}
async function doRebase(branch, onto, anchor, repo = S.repo) {
  if (!branch || !onto || branch === onto) { D.toast("Pick two different branches", "alert"); return; }
  if (kindOf(repo, branch) !== "local") { D.toast(`<b>“${D.esc(branch)}” can't be rebased</b><span class="toast-sub">Only a LOCAL branch (the source) can be rebased; remote-tracking branches and tags are valid targets, not sources.</span>`, "alert", { ms: 6000 }); return; }
  const P = per(repo);
  const expect = P.cmp.ready && P.cmp.ids ? P.cmp.ids : await D.atom.git.resolveRefs(repo, [branch, onto]).catch(() => null);
  const c = await confirmPop(anchor || q(".gitc-act.rebasebtn"), { title: `Rebase ${shortRef(branch)} onto ${shortRef(onto)}`, danger: true, message: `Rewrites the commits of “${branch}” on top of “${onto}” in ${repoName(repo)}. If “${branch}” was already pushed you'll need a force push afterwards. “${branch}” is checked out.`, confirmLabel: "Rebase", details: expect ? [{ k: "branch", v: `${branch} @ ${String(expect[branch] || "?").slice(0, 10)}` }, { k: "onto", v: `${onto} @ ${String(expect[onto] || "?").slice(0, 10)}` }] : null });
  if (!c.ok) return;
  const r = await act(`Rebase ${shortRef(branch)} onto ${shortRef(onto)}`, () => D.atom.git.rebase(repo, onto, { branch, expect: expect || undefined }), { repo, silent: true });
  if (r && r.ok) D.toast(r.upToDate ? `${D.esc(branch)} is already up to date with ${D.esc(onto)}` : `Rebased ${D.esc(branch)} onto ${D.esc(onto)} in ${D.esc(repoName(repo))}`, "checkCircle", { ms: 4000 });
}
/* Check out a branch. A remote ref is checked out as a tracking local branch; when a
 * same-named local branch exists but is NOT that remote branch, the user chooses
 * explicitly (switch to the existing one, or create a distinct tracking branch). */
async function doCheckout(name, { remote } = {}, repo = S.repo) {
  if (!remote) { await act(`Checkout ${shortRef(name)}`, () => D.atom.git.checkout(repo, name), { repo }); return; }
  const r = await act(`Checkout ${name}`, () => D.atom.git.checkoutRemote(repo, name), { repo, silent: true });
  if (r && r.state === "choice") {
    const ex = r.existing || {};
    const why = !ex.tracksThis ? `tracks ${ex.upstream || "no upstream"}` : "points at a different commit";
    const alt = `${ex.name}-${String(name).split("/")[0]}`;
    const c = await D.chooseDialog({ title: `“${ex.name}” already exists locally`, ic: "branch", message: `A local branch named “${ex.name}” exists but is not “${name}” (it ${why}; ${String(ex.oid || "").slice(0, 7)} vs ${String((r.remote || {}).oid || "").slice(0, 7)}). What should happen?`, choices: [{ label: `Create “${alt}” tracking ${name}`, value: "new", primary: true }, { label: `Switch to existing “${ex.name}”`, value: "existing" }, { label: "Cancel", value: null }] });
    if (!c) return;
    const r2 = await act(`Checkout ${name}`, () => D.atom.git.checkoutRemote(repo, name, c === "new" ? { mode: "new", name: alt } : { mode: "existing" }), { repo, silent: true });
    if (r2 && r2.ok) D.toast(`Now on ${D.esc(r2.branch || "")}`, "checkCircle", { ms: 2600 });
    return;
  }
  if (r && r.ok) D.toast(`Now on ${D.esc(r.branch || "")}${r.created ? " (new tracking branch)" : ""}`, "checkCircle", { ms: 2600 });
}
async function doNewBranch(from, repo = S.repo) {
  const name = await prompt({ title: "New branch", ic: "branch", message: from ? `Starting from “${String(from).slice(0, 12)}” in ${repoName(repo)}.` : `Starting from the current HEAD of ${repoName(repo)}.`, placeholder: "feature/my-branch", confirmLabel: "Create & switch" });
  if (name == null || !name.trim()) return;
  await act(`Create ${name.trim()}`, () => D.atom.git.branchCreate(repo, name.trim(), { from: from || undefined, checkout: true }), { repo });
}
async function doDeleteBranch(b, { remote } = {}, repo = S.repo) {
  if (remote) {
    if (!(await confirmDanger("Delete remote branch", `Delete “${b}” on the remote? Other people's clones will lose it on their next fetch.`, "Delete on remote"))) return;
    await act(`Delete ${b}`, () => D.atom.git.branchDelete(repo, b, { remote: true }), { repo });
    return;
  }
  if (!(await confirmDanger("Delete branch", `Delete local branch “${b}” in ${repoName(repo)}?`, "Delete"))) return;
  const r = await act(`Delete ${b}`, () => D.atom.git.branchDelete(repo, b), { repo, silent: true, refresh: false });
  if (r && r.unmerged) {
    if (await confirmDanger("Branch not fully merged", `“${b}” has commits that aren't merged anywhere else. Force-delete and lose them?`, "Force delete")) await act(`Force delete ${b}`, () => D.atom.git.branchDelete(repo, b, { force: true }), { repo });
    else await refreshRepo(repo);
    return;
  }
  if (r && r.ok) D.toast(`Deleted ${D.esc(b)}`, "checkCircle", { ms: 2600 });
  await refreshRepo(repo);
}
async function doRename(b, repo = S.repo) {
  const name = await prompt({ title: "Rename branch", ic: "pencil", placeholder: "new-name", value: b, confirmLabel: "Rename" });
  if (name == null || !name.trim() || name.trim() === b) return;
  await act(`Rename ${b} → ${name.trim()}`, () => D.atom.git.branchRename(repo, b, name.trim()), { repo });
}
async function doSetUpstream(b, repo = S.repo) {
  const info = S.infos[repo];
  const remotes = info ? info.remotes.map((r) => r.name) : [];
  const guess = remotes.find((r) => shortRef(r) === b) || `origin/${b}`;
  const up = await prompt({ title: "Set upstream", ic: "cloudUp", message: `Track which remote branch for “${b}”?`, placeholder: "origin/branch", value: guess, confirmLabel: "Set upstream" });
  if (up == null || !up.trim()) return;
  await act(`Set upstream of ${b}`, () => D.atom.git.setUpstream(repo, b, up.trim()), { repo });
}
/* Push exactly what the review shows. The destination is RESOLVED first (git's own
 * push-remote / upstream / push.default rules) and displayed as remote + full
 * destination ref; execution passes that same plan. No upstream → the user picks
 * the remote explicitly (initial publication). Rejected → pull-then-push flow with
 * a repo-bound continuation. */
/* "12 files updated · +340 −22 · 3 commits" — from the `summary` git.js attaches to a
 * pull / push result (tree-to-tree diff of the moved ref). Empty when unknown. */
export function changeText(sum, { verb = "updated", commitsFirst = false } = {}) {
  if (!sum) return "";
  const n = (k, one, many) => `${sum[k]} ${sum[k] === 1 ? one : many}`;
  const commits = sum.commits ? n("commits", "commit", "commits") : "";
  if (!sum.files) return [commits, "no file changes"].filter(Boolean).join(" · ");
  const parts = [`${n("files", "file", "files")} ${verb}`];
  if (sum.insertions || sum.deletions) parts.push(`+${sum.insertions} −${sum.deletions}`);
  if (commits) commitsFirst ? parts.unshift(commits) : parts.push(commits);
  return parts.join(" · ");
}
function pullToast(r, from) {
  if (r.upToDate) { D.toast(`Already up to date with ${D.esc(from)}`, "checkCircle", { ms: 3200 }); return; }
  const sub = changeText(r.summary, { verb: "updated" });
  D.toast(`<b>Pulled ${D.esc(from)} into ${D.esc(r.branch || "")}</b>${sub ? `<span class="toast-sub">${D.esc(sub)}</span>` : ""}`, "checkCircle", { ms: 4500 });
}
async function doPush({ repo = S.repo, branch, force, setUpstream, tags, skipConfirm, anchor, remote: remoteOverride, dest: destOverride } = {}) {
  const info = S.infos[repo] || {};
  const s = stat(repo) || {};
  const btn = anchor || q(".gitc-act.pushbtn");
  if (info.unborn) { D.toast("Nothing to push yet — make the first commit.", "alert"); return; }
  if (tags) {
    const remote = await chooseRemote(repo, btn, { prefer: remoteOverride || (s.upstream || "").split("/")[0], title: "Push all tags to which remote?" });
    if (!remote) return;
    if (!skipConfirm) { const c = await confirmPop(btn, { title: "Push tags", ic: "push", message: `Pushes every local tag of ${repoName(repo)} to “${remote}”.`, confirmLabel: "Push tags" }); if (!c.ok) return; }
    const r = await act("Push tags", () => D.atom.git.pushBranch(repo, { tags: true, remote }), { repo, silent: true });
    if (r && r.ok) D.toast(r.upToDate ? "Tags already up to date" : `Pushed tags to ${D.esc(remote)}`, "checkCircle", { ms: 3000 });
    return;
  }
  const cur = branch || (info.current && info.current !== "HEAD" ? info.current : "");
  if (!cur) { D.toast("Detached HEAD — check out a branch to push.", "alert"); return; }
  let plan;
  try { plan = await D.atom.git.pushPlan(repo, { branch: cur }); } catch (e) { failToast(`Push ${cur}`, e, repo); return; }
  let remote = remoteOverride || plan.remote, dest = destOverride || plan.dest || cur;
  if (plan.simpleMismatch && !destOverride) { D.toast(`<b>push.default=simple refuses this push</b><span class="toast-sub">“${D.esc(cur)}” tracks “${D.esc(plan.upstream)}” (a different name). Push explicitly to that branch or rename one of them.</span>`, "alert", { ms: 8000 }); return; }
  if (!remote) {
    remote = await chooseRemote(repo, btn, { title: `Publish “${cur}” to which remote?` });
    if (!remote) return;
    setUpstream = true;
  }
  if (force) {
    const c = await confirmPop(btn, { title: `Force push ${cur}`, danger: true, message: `Rewrites “${dest}” on “${remote}” (with lease${plan.remoteOid ? ` on ${plan.remoteOid.slice(0, 7)}` : ""}). Anyone else's work on it must be rebased.`, details: [{ k: "repo", v: repoName(repo) }, { k: "to", v: `${remote} → refs/heads/${dest}` }, { k: "url", v: plan.url || "?" }], confirmLabel: "Force push" });
    if (!c.ok) return;
  } else if (!skipConfirm) {
    const willTrack = setUpstream || !plan.hasUpstream;
    const c = await confirmPop(btn, { title: `Push ${cur}`, ic: "push", message: willTrack ? `“${cur}” will be published to “${remote}” as “${dest}” and start tracking it.` : `${s.ahead ? `${s.ahead} commit${s.ahead === 1 ? "" : "s"} to push` : "Nothing new to push"}${s.behind ? `. The remote has ${s.behind} newer commit${s.behind === 1 ? "" : "s"} — the push may be rejected until you pull.` : ""}`, details: [{ k: "repo", v: repoName(repo) }, { k: "to", v: `${remote} → refs/heads/${dest}` }, { k: "url", v: plan.url || "?" }], confirmLabel: willTrack ? "Publish" : "Push" });
    if (!c.ok) return;
    if (willTrack) setUpstream = true;
  }
  const label = force ? `Force push ${cur}` : `Push ${cur}`;
  const r = await act(label, () => D.atom.git.pushBranch(repo, { branch: cur, remote, dest, force: !!force, setUpstream: !!setUpstream, expectedRemoteOid: force ? plan.remoteOid || undefined : undefined }), { repo, silent: true, refresh: false });
  if (r && r.state === "rejected") { await refreshRepo(repo); return handleRejectedPush({ repo, branch: cur, remote, dest }); }
  await refreshRepo(repo);
  if (!r || !r.ok) return;
  if (r.upToDate) { D.toast(`Everything up to date (${D.esc(remote)}/${D.esc(dest)})`, "checkCircle", { ms: 3000 }); return; }
  const sub = r.newRef ? `new branch published${r.setUpstream ? " · tracking set" : ""}` : changeText(r.summary, { verb: "changed", commitsFirst: true });
  D.toast(`<b>Pushed ${D.esc(cur)} → ${D.esc(remote)}/${D.esc(dest)}</b>${sub ? `<span class="toast-sub">${D.esc(sub)}</span>` : ""}`, "checkCircle", { ms: 4500 });
}
async function handleRejectedPush({ repo, branch, remote, dest }) {
  const s = stat(repo) || {};
  const c = await D.chooseDialog({
    title: `Remote has new commits (${repoName(repo)})`, ic: "alert",
    message: `The push of “${branch}” to ${remote}/${dest} was rejected because the remote moved on${s.behind ? ` (${s.behind} newer commit${s.behind === 1 ? "" : "s"})` : ""}. Bring those commits in first; if any file conflicts, you'll pick keep-mine / accept-incoming per file or per change, then the push runs again.`,
    choices: [{ label: "Pull & merge, then push", value: "merge", primary: true }, { label: "Pull with rebase, then push", value: "rebase" }, { label: "Cancel", value: null }],
  });
  if (!c) return;
  const P = per(repo);
  P.continuation = { kind: "push", repo, branch, remote, dest, created: Date.now() };
  // pullFrom reports conflicts as a result (not an error) → the operation stays in progress and the push waits for it
  const r = await act(c === "rebase" ? "Pull (rebase)" : "Pull", () => D.atom.git.pullFrom(repo, { remote, branch: dest, rebase: c === "rebase" }), { repo, silent: true, onConflict: () => { if (repo === S.repo) showConflicts(); } });
  if (r && r.state === "conflict") { D.toast("<b>Conflicts to resolve</b><span class=\"toast-sub\">Per file: Keep mine · Accept incoming · Resolve lines… Then Continue — the push is offered again afterwards.</span>", "alert", { ms: 8000 }); return; }
  if (!r || !r.ok) { P.continuation = null; return; }
  // pulled cleanly → refreshRepo (run by act) offered the push; if the offer didn't fire, push now
  if (P.continuation && P.continuation.branch === branch) { P.continuation = null; await doPush({ repo, branch, remote, dest, skipConfirm: true }); }
}
function pullPicker(btn) {
  const repo = S.repo;
  const info = S.infos[repo] || { locals: [], remotes: [] };
  const s = stat(repo) || {};
  const rebaseCb = h("input", { type: "checkbox", class: "aqx-check" }); rebaseCb.checked = !!lsGet("pull.rebase", false);
  rebaseCb.addEventListener("change", () => lsSet("pull.rebase", rebaseCb.checked));
  const items = [];
  if (s.upstream) items.push({ value: "@upstream", label: `Pull from upstream (${s.upstream})`, icon: "pull", group: "Tracking", hint: s.behind ? `↓${s.behind}` : "" });
  const remotes = {};
  for (const b of info.remotes) { const rn = b.name.split("/")[0]; (remotes[rn] = remotes[rn] || []).push(b); }
  for (const rn of Object.keys(remotes)) for (const b of remotes[rn]) items.push({ value: b.name, label: b.name, icon: "cloudDown", group: `Remote · ${rn}`, hint: b.subject ? b.subject.slice(0, 40) : "" });
  if (!items.length) items.push({ value: "@upstream", label: "Pull (no remote branches known — fetch first)", icon: "pull" });
  pickList(btn, {
    items, placeholder: "Search branches to pull from…", width: 380,
    footer: h("label", { class: "gitc-check" }, rebaseCb, h("span", { text: "Rebase instead of merge" })),
    onPick: async (v) => {
      const rebase = rebaseCb.checked;
      const upstream = v === "@upstream";
      const [remote, ...rest] = upstream ? [] : v.split("/");
      const opts = upstream ? { rebase } : { remote, branch: rest.join("/"), rebase };
      const r = await act(upstream ? (rebase ? "Pull (rebase)" : "Pull") : `Pull ${v}${rebase ? " (rebase)" : ""}`, () => D.atom.git.pullFrom(repo, opts), { repo, silent: true });
      if (r && r.ok) pullToast(r, upstream ? (r.from || s.upstream || "upstream") : v);
    },
  });
}
async function doStash(anchor, repo = S.repo) {
  const c = await confirmPop(anchor || q(".gitc-act.stashbtn"), { title: "Stash changes", ic: "download", message: `Parks the local changes of ${repoName(repo)} so the tree is clean; re-apply them from the Stashes tab.`, confirmLabel: "Stash", fields: [{ id: "msg", placeholder: "Optional message" }, { id: "untracked", type: "check", label: "Include untracked files", value: false }, { id: "keepIndex", type: "check", label: "Keep staged changes in the index", value: false }] });
  if (!c.ok) return;
  const r = await act("Stash", () => D.atom.git.stashSave(repo, { message: c.values.msg, includeUntracked: !!c.values.untracked, keepIndex: !!c.values.keepIndex }), { repo, silent: true });
  if (r && r.nothing) D.toast("No local changes to stash", "check"); else if (r && r.ok) D.toast("Stashed", "checkCircle", { ms: 2400 });
}
async function doReset(ref, repo = S.repo) {
  const info = S.infos[repo] || {};
  let ids = null; try { ids = await D.atom.git.resolveRefs(repo, [ref]); } catch { /* validated again below */ }
  if (ids && !ids[ref]) { D.toast(`“${D.esc(ref)}” is not a known revision`, "alert"); return; }
  const mode = await D.chooseDialog({ title: `Reset ${info.current || ""} to ${String(ids && ids[ref] ? ids[ref] : ref).slice(0, 12)}`, ic: "undo", message: "Soft keeps your changes staged · Mixed keeps them unstaged · Hard DISCARDS every local change and commit after this point.", choices: [{ label: "Soft", value: "soft" }, { label: "Mixed", value: "mixed", primary: true }, { label: "Hard", value: "hard" }, { label: "Cancel", value: null }] });
  if (!mode) return;
  if (mode === "hard" && !(await confirmDanger("Hard reset", `This permanently discards uncommitted changes in ${repoName(repo)} and moves the branch. Continue?`, "Hard reset"))) return;
  await act(`Reset (${mode}) to ${String(ref).slice(0, 7)}`, () => D.atom.git.reset(repo, ref, mode, { expect: ids && ids[ref] ? { [ref]: ids[ref] } : undefined }), { repo });
}
// Snapshots from History: whole tree at a commit, or just the files it changed (vs an explicit parent).
async function downloadSnapshot(hash, kind, { parent, repo = S.repo } = {}) {
  const short = String(hash).slice(0, 7);
  const base = `${repoName(repo)}-${short}${kind === "files" ? "-changed-files" : ""}.zip`;
  D.toast(kind === "files" ? "Collecting changed files…" : "Archiving repository…", "spinner", { sticky: true, spin: true });
  let r;
  try { r = kind === "files" ? await D.atom.git.commitZip(repo, hash, base, { parent: parent || undefined }) : await D.atom.git.archiveZip(repo, hash, base); }
  catch (e) { failToast("Download", e, repo); return; }
  if (!r || r.canceled) { D.toast("Cancelled", "check", { ms: 1200 }); return; }
  const skipped = (r.skipped || []).length, failed = (r.failed || []).length;
  D.toast(`<b>${failed ? "Saved (incomplete) " : "Saved "}${D.esc(D.baseName(r.path))}</b><span class="toast-sub">${kind === "files" ? `${r.files} file${r.files === 1 ? "" : "s"} under files/` : "full repository at " + short}${r.size ? " · " + fmtSize(r.size) : ""}${skipped ? ` · ${skipped} deleted path${skipped === 1 ? "" : "s"} listed in manifest.json` : ""}${failed ? ` · ${failed} unreadable file${failed === 1 ? "" : "s"} — see manifest.json` : ""}</span>`, failed ? "alert" : "checkCircle", { ms: failed ? 8000 : 6000 });
  try { D.atom.files.reveal(r.path); } catch { /* optional */ }
}

/* ============================ head: repo dropdown ============================ */
function renderRepoDD() {
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
function renderStateBar() {
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
function refItems(cur) {
  const items = [];
  if (!S.info) return items;
  for (const b of S.info.locals) items.push({ value: b.name, label: b.name, icon: b.current ? "check" : "branch", group: "Local", hint: b.current ? "current" : (b.subject || "").slice(0, 40) });
  for (const b of S.info.remotes) items.push({ value: b.name, label: b.name, icon: "cloudDown", group: "Remote", hint: (b.subject || "").slice(0, 40) });
  for (const t of S.tg.list) items.push({ value: t.name, label: t.name, icon: "key", group: "Tags", hint: (t.subject || "").slice(0, 40) });
  return items.map((it) => ({ ...it, icon: it.value === cur ? "check" : it.icon }));
}
function refButton(which) {
  const val = which === "source" ? S.source : S.target;
  return h("button", { class: "gitc-ref " + which, title: which === "source" ? "Source branch — the changes being merged / compared" : "Target branch — merged into (must be a local branch to merge)", "aria-label": `${which} branch: ${val || "none"}`, onclick: (e) => {
    const cur = which === "source" ? S.source : S.target;
    pickList(e.currentTarget, { items: refItems(cur), value: cur, placeholder: `Search ${which} branch…`, width: 360, onPick: (b) => { if (which === "source") S.source = b; else S.target = b; resetCompare(); renderBar(); renderCmpBar(); renderMain(); } });
  } },
    h("span", { class: "gitc-ref-ic", html: icon("branch", 12) }),
    h("span", { class: "gitc-ref-name", text: val || "—" }),
    h("span", { class: "gitc-ref-caret", html: icon("chevronDown", 12) }));
}
function renderBar() {
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
const OP_NAMES = { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert", bisect: "Bisect" };
// Operation banner: actions come from the backend's per-state list (continue /
// skip / abort / bisect-reset) — never a generic commit or an unrelated abort.
function renderBanner() {
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
function renderTabs() {
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
function setTab(id) { if (id === "compare") { enterCompare(); return; } S.mode = "tabs"; S.tab = id; renderBar(); renderTabs(); renderCmpBar(); renderMain(); }
// The merge view: Source · Target · Compare · Create Merge · Rebase. Nothing is compared
// until the user clicks Compare; a review is dropped whenever a ref changes.
function enterCompare() { S.mode = "compare"; resetCompare(); renderBar(); renderTabs(); renderCmpBar(); renderMain(); }
function exitCompare() { S.mode = "tabs"; renderBar(); renderTabs(); renderCmpBar(); renderMain(); }
function resetCompare(repo = S.repo) { if (!repo) return; Object.assign(per(repo).cmp, { compared: false, ready: false, ids: null, error: "" }); }
/* Compare = re-read the repository (status + branches) and then load the review of
 * source → target. Create Merge / Rebase arm from that review only. */
async function runCompare() {
  const repo = S.repo;
  if (!repo || !S.source || !S.target || S.source === S.target) return;
  const btn = q(".gitc-cmpbar .cmp-run"); if (btn) btn.disabled = true;
  await refreshRepo(repo, { quiet: true });
  if (!isOpen() || S.repo !== repo || S.mode !== "compare") return;
  Object.assign(S.cmp, { compared: true, ready: false, ids: null, error: "" });
  renderCmpBar();
  await renderMain();
}
function renderCmpBar() {
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
async function renderMain({ soft = false } = {}) {
  const c = q(".gitc-content"); if (!c || !S.repo || !S.info) return;
  const gen = ++S.gen;
  if (S.mode !== "compare" && S.tab === "changes") { try { await renderChanges(c, gen, { soft }); } catch (e) { if (alive(gen)) { c.innerHTML = ""; c.append(empty("alert", "Couldn't load", errText(e))); } } return; }
  c.innerHTML = "";
  const fn = S.mode === "compare" ? renderCompare : ({ history: renderHistory, branches: renderBranches, stashes: renderStashes, tags: renderTags, remotes: renderRemotes }[S.tab] || renderChanges);
  try { await fn(c, gen); } catch (e) { if (alive(gen)) { c.innerHTML = ""; c.append(empty("alert", "Couldn't load", errText(e))); } }
}
/* ============================ diff pane (shared) ============================ */
// `expandable`: an Expand button re-renders the same diff in a large modal on top.
// Every load carries a request id: a slower, older response never replaces a newer one.
function diffPane({ expandable = true } = {}) {
  const pane = h("div", { class: "gitc-diff" });
  let last = null, req = 0;
  const build = async (body, loader, head, hdrStat) => {
    const my = ++req;
    body.innerHTML = ""; body.append(spinner("Loading diff…"));
    let res;
    try { res = await loader(); } catch (e) { res = { text: "", error: errText(e) }; }
    if (!body.isConnected || my !== req) return;
    body.innerHTML = "";
    if (res && res.error) { body.append(D.diffEmpty("alert", "Couldn't load diff", res.error)); if (hdrStat) hdrStat.innerHTML = ""; return; }
    const parsed = D.parseUnifiedDiff((res && res.text) || "");
    if (hdrStat) hdrStat.innerHTML = parsed.binary ? `<span class="ds-bin">binary</span>` : `<span class="ds-add">+${parsed.adds}</span><span class="ds-del">−${parsed.dels}</span>`;
    if (parsed.binary) { body.append(D.diffEmpty("eye", "Binary file", "No text diff to show.")); return; }
    if (!parsed.hunks.length) { body.append(D.diffEmpty("check", "No line changes", res && res.note ? res.note : "Metadata-only change, or nothing differs.")); return; }
    body.append(D.renderDiffContent(parsed));
  };
  pane._show = async (title, loader, { sub, actions, toolsLabel, views } = {}) => {
    last = { title, loader, sub, actions, toolsLabel, views };
    pane.innerHTML = "";
    const statEl = h("span", { class: "gitc-diff-stat" });
    // icon buttons stay in the head; full-size buttons (Keep mine / Accept incoming /
    // Resolve…) get their own row so the file name and Split/Unified never get squeezed
    const icons = (actions || []).filter((a) => a && a.classList && a.classList.contains("gitc-ibtn"));
    const buttons = (actions || []).filter((a) => a && !(a.classList && a.classList.contains("gitc-ibtn")));
    const viewSeg = views && views.items && views.items.length > 1 ? h("div", { class: "gitc-seg views", role: "radiogroup", "aria-label": "Diff baseline" }, ...views.items.map((v) => h("button", { class: "gitc-seg-btn" + (v.id === views.current ? " active" : ""), role: "radio", "aria-checked": v.id === views.current ? "true" : "false", title: v.title || "", text: v.label, onclick: () => views.onPick(v.id) }))) : null;
    const head = h("div", { class: "gitc-diff-head" },
      title ? fileIcon(title, 15) : null,
      h("span", { class: "gitc-diff-name", text: title || "", title: title || "" }),
      sub ? h("span", { class: "gitc-diff-sub", text: sub }) : null,
      h("div", { class: "gitc-spacer" }),
      statEl,
      viewSeg,
      h("div", { class: "gitc-seg" },
        h("button", { class: "gitc-seg-btn" + (D.getDiffView() === "split" ? " active" : ""), text: "Split", onclick: () => { D.setDiffView("split"); pane._show(title, loader, { sub, actions, toolsLabel, views }); } }),
        h("button", { class: "gitc-seg-btn" + (D.getDiffView() !== "split" ? " active" : ""), text: "Unified", onclick: () => { D.setDiffView("unified"); pane._show(title, loader, { sub, actions, toolsLabel, views }); } })),
      ...icons,
      expandable ? iconBtn("maximize", "Expand — open this diff in a large window", () => pane._expand()) : null);
    const body = h("div", { class: "gitc-diff-body" });
    const tools = buttons.length ? h("div", { class: "gitc-diff-tools" }, toolsLabel ? h("span", { class: "gitc-diff-tools-label", text: toolsLabel }) : null, ...buttons) : null;
    pane.append(...[head, tools, body].filter(Boolean));
    await build(body, loader, head, statEl);
  };
  // Large modal (stacks above the Git Center) with the same diff + its own split/unified toggle.
  pane._expand = () => {
    if (!last) return;
    const body = h("div", { class: "gitc-diff-body big" });
    const statEl = h("span", { class: "gitc-diff-stat" });
    const seg = h("div", { class: "gitc-seg" });
    const draw = () => { seg.innerHTML = ""; seg.append(h("button", { class: "gitc-seg-btn" + (D.getDiffView() === "split" ? " active" : ""), text: "Split", onclick: () => { D.setDiffView("split"); draw(); build(body, last.loader, null, statEl); } }), h("button", { class: "gitc-seg-btn" + (D.getDiffView() !== "split" ? " active" : ""), text: "Unified", onclick: () => { D.setDiffView("unified"); draw(); build(body, last.loader, null, statEl); } })); };
    draw();
    const wrap = h("div", { class: "gitc-diff big" }, h("div", { class: "gitc-diff-head" }, fileIcon(last.title, 15), h("span", { class: "gitc-diff-name", text: last.title }), last.sub ? h("span", { class: "gitc-diff-sub", text: last.sub }) : null, h("div", { class: "gitc-spacer" }), statEl, seg), body);
    const back = D.modalShell({ title: `${D.baseName(last.title)}${last.sub ? "  ·  " + last.sub : ""}`, ic: "gitCompare", wide: true, body: wrap });
    back.querySelector(".modal").classList.add("gitc-bigdiff-modal");
    build(body, last.loader, null, statEl);
  };
  pane._placeholder = (msg) => { last = null; req++; pane.innerHTML = ""; pane.append(h("div", { class: "gitc-diff-ph" }, h("span", { html: icon("gitCompare", 30) }), h("div", { text: msg || "Select a file to see its diff." }))); };
  pane._placeholder();
  return pane;
}
function fileRow(f, { active, onClick, actions, title } = {}) {
  const slash = f.path.lastIndexOf("/");
  const row = h("div", { class: "gitc-file" + (active ? " active" : "") + (f.conflict ? " conflict" : ""), title: title || (f.label ? f.label + " · " : "") + f.path + (f.orig ? ` (from ${f.orig})` : ""), onclick: onClick },
    fileIcon(f.path), h("span", { class: "gitc-file-name", text: D.baseName(f.path) }),
    h("span", { class: "gitc-file-path", text: (f.orig ? `${f.orig} → ` : "") + (slash >= 0 ? f.path.slice(0, slash) : "") }),
    pm(f), codeChip(f),
    actions ? h("span", { class: "gitc-file-acts" }, ...actions) : null);
  return rowA11y(row, `${f.label || ""} ${f.path}`);
}

/* ============================ Compare (mode) ============================ */
/* Ready (→ Create Merge / Rebase enabled) ONLY when the user clicked Compare, every
 * read succeeded and both refs resolved; the resolved ids are the review identity
 * that merge/rebase re-check. */
async function renderCompare(c, gen) {
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
function commitRow(cm, { onClick, active, compact, menu } = {}) {
  const refs = (cm.refs || []).filter(Boolean);
  const row = h("div", { class: "gitc-commit" + (active ? " active" : "") + (compact ? " compact" : ""), onclick: onClick, oncontextmenu: menu ? (e) => { e.preventDefault(); menu(e); } : null },
    h("span", { class: "gitc-commit-dot" }),
    h("div", { class: "gitc-commit-main" },
      h("div", { class: "gitc-commit-subject" }, h("span", { text: cm.subject || "(no subject)" }), ...refs.map((r) => h("span", { class: "gitc-refchip" + (/^HEAD/.test(r) ? " head" : /^tag: /.test(r) ? " tag" : /\//.test(r) ? " remote" : ""), text: r.replace(/^HEAD -> /, "").replace(/^tag: /, "") }))),
      h("div", { class: "gitc-commit-meta" }, h("span", { class: "gitc-hash", text: cm.hash }), h("span", { text: cm.author || "" }), h("span", { class: "gitc-muted", text: cm.rel || cm.date || "" }))),
    menu ? h("button", { class: "gitc-ibtn", title: "Actions", "aria-label": "Commit actions", "aria-haspopup": "menu", html: icon("moreVert", 14), onclick: (e) => { e.stopPropagation(); menu(e); } }) : null);
  return rowA11y(row, `Commit ${cm.hash} ${cm.subject || ""}`);
}
async function openCommitInHistory(hash) { S.hist.sel = hash; S.hist.search = ""; setTab("history"); }
/* ============================ Changes ============================ */
// Paths → nested tree { dirs: Map<name, node>, files: [f] } for the tri-state tree.
function buildTree(files) {
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
const descendants = (node) => { const out = [...node.files]; for (const d of node.dirs.values()) out.push(...descendants(d)); return out; };
const ROW_H = 26;
// The commit plan item for a status record: rename pairs and untrack intent travel with the path.
const planItem = (f) => ({ path: f.path, orig: f.orig || undefined, untrack: !!(f.stagedDelete && f.keptOnDisk) || undefined });
/* The Changes tab keeps a per-repo SHELL mounted (left column = sections + commit box,
 * right = diff pane). A refresh rebuilds only the sections; the commit textarea, its
 * focus/caret/scroll and the diff pane are untouched. */
async function renderChanges(c, gen, { soft = false } = {}) {
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
function buildChangesShell(repo) {
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
/* ============================ History ============================ */
/* Every load (query / page / detail / file) carries a request id; an older response
 * that lands later is dropped. Pages are deduplicated by commit id. Merge commits are
 * compared with an EXPLICIT parent (default first) that the user can switch. */
async function renderHistory(c, gen) {
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
async function viewFileAt(ref, file, repo = S.repo) {
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
const Buffer_len = (s) => { try { return new TextEncoder().encode(s).length; } catch { return s.length; } };
async function doNewTag(ref, repo = S.repo) {
  const name = await prompt({ title: "New tag", ic: "key", message: `Tag ${ref ? String(ref).slice(0, 12) : "HEAD"} in ${repoName(repo)}.`, placeholder: "v1.2.0", confirmLabel: "Next: message" });
  if (name == null || !name.trim()) return;
  const msg = await prompt({ title: `Tag ${name.trim()}`, ic: "key", message: "Optional annotation message (leave empty for a lightweight tag).", placeholder: "Release notes…", confirmLabel: "Create tag" });
  if (msg == null) return;
  await act(`Tag ${name.trim()}`, () => D.atom.git.tagCreate(repo, name.trim(), { ref: ref || undefined, message: msg }), { repo });
  per(repo).tg.list = [];
}

/* ============================ Branches ============================ */
async function renderBranches(c, gen) {
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
async function renderStashes(c, gen) {
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
async function renderTags(c, gen) {
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
async function renderRemotes(c, gen) {
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

// Internals for the component test harness (scripts/test-git-ui.js). Not used by the app.
export const __gitcInternals = { S, per, selectRepo, refreshAll, refreshRepo, act, forAll, setTab, enterCompare, runCompare, renderCmpBar, renderMain, doPush, doMerge, doRebase, close, prompt, confirmPop, pickList, closePick, offerContinuation, onGitChanged, onGitProgress };
