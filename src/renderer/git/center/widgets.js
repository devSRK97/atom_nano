/* AtomNano renderer — Git Center — generic widgets: anchored pick list, confirm popover, split panes, collapsible sections, windowed lists, the shared diff pane and file rows.
 * One of the modules the former single gitcenter.js was split into (see git/center/index.js). */
import { codeChip, D, errText, fileIcon, h, icon, iconBtn, lsGet, lsSet, pm, rowA11y, spinner } from "./state.js";

/* ============================ generic widgets ============================ */
// Searchable, keyboard-navigable list anchored under an element. Bounded height
// (scrolls inside), groups, hints, optional footer (e.g. a "rebase" toggle).
// Every dismissal route (pick, Escape, outside click, resize, closePick) settles
// `onCancel` exactly once when nothing was picked.
export let _pick = null;
export function closePick() { if (_pick) { const p = _pick; _pick = null; clearTimeout(p.timer); p.el.remove(); document.removeEventListener("mousedown", p.out, true); window.removeEventListener("resize", p.close); if (!p.picked && p.onCancel) { try { p.onCancel(); } catch { /* */ } } } }
export function pickList(anchor, { items, value, onPick, onCancel, placeholder = "Search…", width, footer, emptyText = "No matches", label }) {
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
export function confirmPop(anchor, { title, message, confirmLabel = "Confirm", danger, ic, fields = [], width = 340, details }) {
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
export function splitPane(parts, { key, sizes = [], min = 180 }) {
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
export function section({ id, title, count, danger, actions, bar, body, open = true, onToggle }) {
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
export const VIRTUAL_MIN = 200;
export function virtualList(scroller, rows, rowH, render, { onRendered } = {}) {
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
/* ============================ diff pane (shared) ============================ */
// `expandable`: an Expand button re-renders the same diff in a large modal on top.
// Every load carries a request id: a slower, older response never replaces a newer one.
export function diffPane({ expandable = true } = {}) {
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
export function fileRow(f, { active, onClick, actions, title } = {}) {
  const slash = f.path.lastIndexOf("/");
  const row = h("div", { class: "gitc-file" + (active ? " active" : "") + (f.conflict ? " conflict" : ""), title: title || (f.label ? f.label + " · " : "") + f.path + (f.orig ? ` (from ${f.orig})` : ""), onclick: onClick },
    fileIcon(f.path), h("span", { class: "gitc-file-name", text: D.baseName(f.path) }),
    h("span", { class: "gitc-file-path", text: (f.orig ? `${f.orig} → ` : "") + (slash >= 0 ? f.path.slice(0, slash) : "") }),
    pm(f), codeChip(f),
    actions ? h("span", { class: "gitc-file-acts" }, ...actions) : null);
  return rowA11y(row, `${f.label || ""} ${f.path}`);
}
