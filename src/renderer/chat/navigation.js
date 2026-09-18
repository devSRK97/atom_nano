/* AtomNano renderer — Conversation window — paginated message region, find, prompt timeline, synthesize.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { $, baseName, fmtTime, h, toast } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { openInEditor } from "../editor/editor-pane.js";
import { switchTab } from "../git/conflicts-ui.js";
import { icon } from "../icons.js";
import { persistTabs } from "../workspace/projects.js";
import { autoGrow } from "./composer.js";
import { PROVIDER_NAME, metaKey, modelName, openImageViewer, renderLive, renderMessage, renderPerms, scrollBottom, setFollowTail, updateScrollBtn } from "./messages.js";
import { MEM_CAP, addTabState } from "./tabs.js";

/* ============================================================
   CHAT RENDER
   ============================================================ */
export function chatRegions() {
  let msgs = $("chatMessages");
  if (!msgs) {
    const chat = $("chat");
    chat.innerHTML = "";
    chat.append(
      h("div", { id: "chatMessages", class: "chat-messages-host" }),
      h("div", { id: "chatLive" }),
      h("div", { id: "chatPerms" }));
    msgs = $("chatMessages");
  }
  return { msgs, live: $("chatLive"), perms: $("chatPerms") };
}
export const RENDER_STEP = 60;   // messages loaded per page (scroll-to-top / scroll-to-bottom / jump)
// Shared by the scroll auto-loader AND the "load earlier" button. Without one
// guard across both, scrolling to the top starts a load while a click starts a
// second one for the same range — duplicated messages and a wasted disk read.
export let _loadingOlder = false;
export const MAX_RENDER = 150;   // hard cap on rendered messages while following live tail

// Sliding window: ts.viewStart = index of the first message currently in the DOM.
// Only [viewStart .. end] is rendered; older messages auto-load when you scroll
// to the top, and the oldest are trimmed from the DOM as new ones arrive — so
// even an all-day session keeps a small, constant DOM/RAM footprint.

export function renderChat() {
  const ts = activeTS();
  const chat = $("chat");
  chat.innerHTML = "";
  chat.append(h("div", { id: "chatMessages" }), h("div", { id: "chatLive" }), h("div", { id: "chatPerms" }));
  // The chat overlays live in #main (so they don't scroll away), which means they
  // survive a tab switch. Reset them here so every session starts clean instead of
  // inheriting the previous conversation's search, dots and filter.
  resetChatOverlays();
  if (!ts) return;
  ts.viewStart = Math.max(0, ts.messages.length - RENDER_STEP); // fresh tail on (re)open
  renderMessagesRegion();
  renderLive();
  renderPerms();
  scrollBottom(true);
}
/* ============================================================
   CONVERSATION NAVIGATION — Ctrl+F · prompt timeline · synthesize
   ============================================================ */
// Start a fresh session seeded with the synthesized context of an existing one.
const synthesisRequests = new Map();
export async function synthesizeSession(id) {
  if (synthesisRequests.has(id)) return synthesisRequests.get(id);
  const pending = (async () => {
    const view = await atom.sessions.synthesize(id).catch((e) => { toast("Synthesize failed: " + ((e && e.message) || e), "alert"); return null; });
    if (!view) return null;
    addTabState(view);
    if (!state.order.includes(view.id)) state.order.push(view.id);
    await switchTab(view.id);
    persistTabs();
    toast("Fresh session seeded with the synthesized context", "sparkle");
    return view;
  })();
  synthesisRequests.set(id, pending);
  try { return await pending; }
  finally { if (synthesisRequests.get(id) === pending) synthesisRequests.delete(id); }
}
/* Every chat overlay is session-scoped: it belongs to the conversation you're
 * looking at, not to the window. They're parented to #main (so they stay pinned
 * while the transcript scrolls), so switching sessions has to clear them by hand —
 * otherwise a new tab inherits the previous chat's find highlights, timeline dots
 * and model filter. `chatFind` in particular holds DOM nodes from the old session. */
export function resetChatOverlays() {
  closeChatSearch();                                   // also clears highlights + chatFind state
  const rail = $("promptRail"); if (rail) { rail.innerHTML = ""; rail.classList.add("hidden"); }
  const mf = $("modelFilter"); if (mf) mf.remove();
}
// Ctrl+F search over the loaded conversation: highlight + next/prev.
export let chatFind = { hits: [], idx: -1, matchCase: false };
export function openChatSearch() {
  if ($("chatSearch")) { const i = $("chatFindInput"); if (i) i.focus(); return; }
  // Anchored to #main (which does NOT scroll), not #chatWrap — an absolutely
  // positioned child of the scroll container scrolls away with the content.
  const wrap = $("main"); if (!wrap) return;
  const input = h("input", { id: "chatFindInput", class: "cf-input", placeholder: "Find in conversation…", spellcheck: "false" });
  const count = h("span", { id: "chatFindCount", class: "cf-count" });
  // Match-case toggle (like the editor's find) — re-runs the search on toggle.
  const mcase = h("button", { class: "cf-btn cf-case" + (chatFind.matchCase ? " active" : ""), title: "Match case", dataset: { tip: "Match case", tipDir: "top" }, text: "Aa",
    onclick: () => { chatFind.matchCase = !chatFind.matchCase; mcase.classList.toggle("active", chatFind.matchCase); doChatFind(input.value); input.focus(); } });
  const prev = h("button", { class: "cf-btn cf-prev", title: "Previous (Shift+Enter)", html: icon("chevronDown", 14), onclick: () => stepChatFind(-1) });
  const next = h("button", { class: "cf-btn", title: "Next (Enter)", html: icon("chevronDown", 14), onclick: () => stepChatFind(1) });
  const close = h("button", { class: "cf-btn", title: "Close (Esc)", html: icon("close", 14), onclick: closeChatSearch });
  const bar = h("div", { id: "chatSearch", class: "chat-search" }, h("span", { class: "cf-ico", html: icon("search", 14) }), input, mcase, count, prev, next, close);
  wrap.appendChild(bar);
  // Full-session (on-disk) results panel — covers messages beyond the in-memory
  // window, including pruned/archived ones the DOM highlighter can't reach.
  wrap.appendChild(h("div", { id: "chatFindResults", style: "position:fixed; z-index:60; width:min(560px,60vw); max-height:44vh; overflow:auto; background:var(--bg-3); border:1px solid var(--line-2); border-radius:8px; box-shadow:var(--sh-pop); padding:4px; display:none;" }));
  input.addEventListener("input", () => doChatFind(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeChatSearch(); }
    else if (e.key === "Enter") { e.preventDefault(); stepChatFind(e.shiftKey ? -1 : 1); }
  });
  input.focus();
}
export function closeChatSearch() { const b = $("chatSearch"); if (b) b.remove(); const r = $("chatFindResults"); if (r) r.remove(); clearTimeout(_diskFindTimer); clearChatHighlights(); chatFind = { hits: [], idx: -1, matchCase: false }; }
// Full-session on-disk search (within the active session only). Runs alongside the
// DOM highlighter so matches in older/archived messages — not currently rendered —
// still surface. Clicking a hit that IS on screen jumps to it.
export let _diskFindTimer = null;
export function runDiskFind(q) {
  const box = $("chatFindResults"); if (!box) return;
  const ts = activeTS();
  if (!ts || !q) { box.style.display = "none"; box.innerHTML = ""; return; }
  atom.sessions.search(ts.meta.id, q).then((res) => {
    if (!$("chatFindResults") || ($("chatFindInput") || {}).value !== q) return;   // stale
    const matches = (res && res.matches) || [];
    box.innerHTML = "";
    if (!matches.length) { box.style.display = "none"; return; }
    const bar = $("chatSearch"); if (bar) { const r = bar.getBoundingClientRect(); box.style.top = (r.bottom + 4) + "px"; box.style.right = Math.max(8, window.innerWidth - r.right) + "px"; }
    const inView = new Set([...document.querySelectorAll("#chatMessages .msg[data-mid]")].map((e) => e.dataset.mid));
    const older = matches.filter((m) => !inView.has(m.mid)).length;
    const total = res.total || matches.length;
    box.append(h("div", { style: "padding:5px 8px; font-size:11px; opacity:.65;", text: `${total.toLocaleString()} match${total === 1 ? "" : "es"} in this session${older ? ` · ${older} not on screen — click to load` : ""}${total > matches.length ? ` · showing first ${matches.length}` : ""}` }));
    for (const m of matches) {
      const visible = m.mid && inView.has(m.mid);
      const when = m.ts ? new Date(m.ts).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      box.append(h("div", { class: "cf-hit-row", title: visible ? "Jump to message" : "Loads this part of the conversation and jumps to it",
        onclick: () => { if (typeof m.index === "number") jumpToIndex(m.index, q); else if (m.mid) jumpToMessage(m.mid); } },
        h("span", { class: "cf-hit-role", text: (m.role || "") + (m.archived ? " · archived" : "") }),
        h("span", { class: "cf-hit-snip", text: m.snippet || "" }),
        h("span", { class: "cf-hit-when", text: when })));
    }
    box.style.display = "block";
  }).catch(() => {});
}
export function clearChatHighlights() {
  document.querySelectorAll("#chatMessages mark.cf-hit").forEach((m) => { const p = m.parentNode; m.replaceWith(document.createTextNode(m.textContent)); if (p) p.normalize(); });
}
export function doChatFind(q) {
  clearChatHighlights();
  chatFind = { hits: [], idx: -1, matchCase: chatFind.matchCase };
  const count = $("chatFindCount");
  if (!q) { if (count) count.textContent = ""; clearTimeout(_diskFindTimer); const rb = $("chatFindResults"); if (rb) { rb.style.display = "none"; rb.innerHTML = ""; } return; }
  let rx; try { rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), chatFind.matchCase ? "g" : "gi"); } catch { return; }
  const hits = [];
  for (const msg of document.querySelectorAll("#chatMessages .msg")) {
    const walker = document.createTreeWalker(msg, NodeFilter.SHOW_TEXT, null);
    const nodes = []; let n;
    while ((n = walker.nextNode())) { const pe = n.parentElement; if (pe && pe.closest("button, .msg-time, .msg-role, script, style")) continue; if (n.nodeValue && n.nodeValue.trim()) nodes.push(n); }
    for (const tn of nodes) wrapChatMatches(tn, rx, hits);
  }
  chatFind.hits = hits;
  if (count) count.textContent = hits.length ? `1/${hits.length}` : "0/0";
  if (hits.length) stepChatFind(1, true);
  // Also search the FULL session on disk (older/archived messages the DOM lacks).
  clearTimeout(_diskFindTimer);
  _diskFindTimer = setTimeout(() => runDiskFind(q), 200);
}
export function wrapChatMatches(textNode, rx, hits) {
  const text = textNode.nodeValue; rx.lastIndex = 0;
  let m, last = 0, any = false; const frag = document.createDocumentFragment();
  while ((m = rx.exec(text))) {
    any = true;
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement("mark"); mark.className = "cf-hit"; mark.textContent = m[0]; frag.appendChild(mark); hits.push(mark);
    last = m.index + m[0].length;
    if (rx.lastIndex === m.index) rx.lastIndex++;
  }
  if (any) { if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last))); textNode.replaceWith(frag); }
}
export function stepChatFind(dir, first) {
  if (!chatFind.hits.length) return;
  if (chatFind.idx >= 0 && chatFind.hits[chatFind.idx]) chatFind.hits[chatFind.idx].classList.remove("cf-active");
  chatFind.idx = first ? 0 : (chatFind.idx + dir + chatFind.hits.length) % chatFind.hits.length;
  const m = chatFind.hits[chatFind.idx];
  if (m) { m.classList.add("cf-active"); m.scrollIntoView({ block: "center", behavior: "smooth" }); }
  const count = $("chatFindCount"); if (count) count.textContent = `${chatFind.idx + 1}/${chatFind.hits.length}`;
}
// Prompt timeline: one dot per user prompt on the right rail; hover → tooltip,
// click → jump to that prompt.
// The dot rail is retired: prompts live in a searchable dropdown next to the
// search icon (openPromptPicker), which also covers prompts not in RAM.
export function renderPromptRail() { const rail = $("promptRail"); if (rail) { rail.innerHTML = ""; rail.classList.add("hidden"); } }
export function jumpToMessage(mid) {
  const node = document.querySelector(`#chatMessages .msg[data-mid="${CSS.escape(mid)}"]`);
  if (node) { node.scrollIntoView({ block: "center", behavior: "smooth" }); node.classList.add("msg-flash"); setTimeout(() => node.classList.remove("msg-flash"), 1200); }
  return !!node;
}
/* ---- paginated window helpers (global indexes; archive + live) ---- */
// Is the in-memory window contiguous with the live tail?
export function atTail(ts) { return !ts || (ts.firstIndex || 0) + (ts.messages ? ts.messages.length : 0) >= (ts.totalMessages || 0); }
export let _loadingNewer = false;
// Page NEWER messages into a detached window (scrolling down after a jump).
export async function loadNewer() {
  const ts = activeTS();
  if (!ts || _loadingNewer || atTail(ts)) return;
  _loadingNewer = true;
  try {
    const end = ts.firstIndex + ts.messages.length;
    const r = await atom.sessions.messages(ts.meta.id, Math.min(ts.totalMessages || end + RENDER_STEP, end + RENDER_STEP), RENDER_STEP).catch(() => null);
    if (!r || !r.messages || !r.messages.length) return;
    const skip = Math.max(0, end - r.firstIndex);           // overlap with what we already hold
    const add = r.messages.slice(skip);
    if (r.total) ts.totalMessages = Math.max(ts.totalMessages || 0, r.total);
    if (!add.length) return;
    ts.messages = ts.messages.concat(add);
    // Bound RAM from the top while paging down (the top stays one scroll-up away).
    if (ts.messages.length > MEM_CAP) { const drop = ts.messages.length - MEM_CAP; ts.messages.splice(0, drop); ts.firstIndex += drop; ts.viewStart = Math.max(0, (ts.viewStart || 0) - drop); }
    const w = $("chatWrap"); const oldTop = w.scrollTop;
    renderMessagesRegion();
    // Appending below doesn't move what the user is reading — keep the same offset.
    w.scrollTop = oldTop;
    if (atTail(ts)) { ts.unseenNew = 0; renderNewMsgBadge(); }
  } finally { _loadingNewer = false; }
}
// Replace the window with the live tail (jump to latest from a detached window).
export async function reloadTail(ts) {
  const r = await atom.sessions.messages(ts.meta.id, ts.totalMessages || 0, RENDER_STEP * 2).catch(() => null);
  if (!r) return;
  ts.messages = r.messages || []; ts.firstIndex = r.firstIndex || 0;
  if (r.total) ts.totalMessages = r.total;
  ts.viewStart = Math.max(0, ts.messages.length - RENDER_STEP);
  ts.unseenNew = 0;
  if (ts === activeTS()) { renderMessagesRegion(); renderNewMsgBadge(); }
}
// Bring a GLOBAL message index on screen: expand the window if it's in RAM,
// otherwise load a page centred on it (from the archive if that's where it is),
// then scroll to it and flash it. `q` re-applies a find highlight after the jump.
export async function jumpToIndex(g, q) {
  const ts = activeTS(); if (!ts) return;
  g = Math.max(0, Math.min(g, Math.max(0, (ts.totalMessages || 1) - 1)));
  const end = ts.firstIndex + ts.messages.length;
  if (g >= ts.firstIndex && g < end) {
    const local = g - ts.firstIndex;
    if (local < (ts.viewStart || 0)) { ts.viewStart = Math.max(0, local - 3); renderMessagesRegion(); }
  } else {
    const start = Math.max(0, g - Math.floor(RENDER_STEP / 2));
    const pageEnd = Math.min(ts.totalMessages || start + RENDER_STEP, start + RENDER_STEP);
    const r = await atom.sessions.messages(ts.meta.id, pageEnd, RENDER_STEP).catch(() => null);
    if (!r || !r.messages || !r.messages.length) { toast("Couldn't load that part of the conversation", "alert"); return; }
    ts.messages = r.messages; ts.firstIndex = r.firstIndex; if (r.total) ts.totalMessages = r.total;
    ts.viewStart = 0;
    renderMessagesRegion();
  }
  setFollowTail(false);
  const m = ts.messages[g - ts.firstIndex];
  const go = () => { if (m && m.id) jumpToMessage(m.id); if (q && $("chatSearch")) doChatFind(q); updateScrollBtn(); renderNewMsgBadge(); };
  requestAnimationFrame(() => requestAnimationFrame(go));
}
// "N new" pill on the jump-to-latest button while the window is detached.
export function renderNewMsgBadge() {
  const b = $("scrollBtn"); const ts = activeTS();
  if (!b) return;
  const n = ts && !atTail(ts) ? (ts.unseenNew || 0) : 0;
  b.dataset.count = n ? (n > 99 ? "99+" : String(n)) : "";
  if (ts && !atTail(ts)) b.classList.remove("hidden");
  b.title = n ? `${n} new message${n > 1 ? "s" : ""} — jump to latest` : "Jump to latest";
}
// Prompt picker: every user prompt in the session (from disk, archive included),
// searchable; pick one → the transcript loads that spot and scrolls to it.
export let _promptCache = { id: "", total: -1, prompts: [] };
export async function openPromptPicker(anchor) {
  const ts = activeTS(); if (!ts) return;
  const old = $("promptPicker"); if (old) { old.remove(); return; }
  const wrap = $("main"); if (!wrap) return;
  const input = h("input", { class: "cf-input", placeholder: "Search prompts…", spellcheck: "false" });
  const count = h("span", { class: "pp-count" });
  const list = h("div", { class: "pp-list" }, h("div", { class: "pp-empty", text: "Loading…" }));
  const box = h("div", { id: "promptPicker", class: "prompt-picker" },
    h("div", { class: "pp-head" }, h("span", { class: "cf-ico", html: icon("chat", 14) }), input, count, h("button", { class: "cf-btn", title: "Close (Esc)", html: icon("close", 14), onclick: () => box.remove() })),
    list);
  wrap.appendChild(box);
  if (anchor && anchor.getBoundingClientRect) { const r = anchor.getBoundingClientRect(), m = wrap.getBoundingClientRect(); box.style.top = (r.bottom - m.top + 6) + "px"; box.style.right = Math.max(8, m.right - r.right) + "px"; }
  const outside = (e) => { if (!box.contains(e.target) && e.target !== anchor) { box.remove(); document.removeEventListener("mousedown", outside, true); } };
  document.addEventListener("mousedown", outside, true);
  let prompts = [];
  if (_promptCache.id === ts.meta.id && _promptCache.total === (ts.totalMessages || 0)) prompts = _promptCache.prompts;
  else { try { prompts = (await atom.sessions.prompts(ts.meta.id)).prompts || []; } catch { prompts = []; } _promptCache = { id: ts.meta.id, total: ts.totalMessages || 0, prompts }; }
  if (!document.body.contains(box)) return;
  let sel = -1, vis = prompts;
  const curIdx = ts.firstIndex + (ts.viewStart || 0);            // roughly what's on screen
  const fmtWhen = (iso) => { if (!iso) return ""; const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "2-digit" }); };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    vis = q ? prompts.filter((p) => p.text.toLowerCase().includes(q)) : prompts;
    count.textContent = q ? `${vis.length} / ${prompts.length}` : String(prompts.length);
    list.innerHTML = "";
    if (!vis.length) { list.append(h("div", { class: "pp-empty", text: prompts.length ? "No prompts match." : "No prompts yet." })); return; }
    // Nearest prompt at/before the visible window is marked as "you are here".
    let cur = -1; for (let i = 0; i < vis.length; i++) if (vis[i].index <= curIdx + 2) cur = i;
    if (sel < 0) sel = cur >= 0 ? cur : vis.length - 1;
    const frag = document.createDocumentFragment();
    vis.forEach((p, i) => frag.append(h("div", { class: "pp-item" + (i === sel ? " sel" : "") + (i === cur ? " cur" : ""), dataset: { i: String(i) }, title: p.text, onclick: () => pick(i) },
      h("span", { class: "pp-n", text: "#" + (prompts.indexOf(p) + 1) }),
      h("span", { class: "pp-text", text: p.text || "(empty prompt)" }),
      h("span", { class: "pp-time", text: fmtWhen(p.ts) }))));
    list.append(frag);
    const selEl = list.children[sel]; if (selEl) selEl.scrollIntoView({ block: "nearest" });
  };
  const pick = (i) => { const p = vis[i]; if (!p) return; box.remove(); document.removeEventListener("mousedown", outside, true); jumpToIndex(p.index); };
  input.addEventListener("input", () => { sel = -1; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); box.remove(); document.removeEventListener("mousedown", outside, true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(vis.length - 1, sel + 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(sel); }
  });
  draw();
  input.focus();
}
// Messages above the rendered window: firstIndex is GLOBAL (archived messages
// included — they page in from disk like any other), viewStart is within RAM.
export function hiddenOlderCount(ts) { return (ts.firstIndex || 0) + (ts.viewStart || 0); }
export function archivedOlderCount() { return 0; }   // archived turns are loadable now — nothing to flag
export function topSentinel(hidden) {
  // It IS a button — label it like one. ("scroll up to load" read as a passive
  // hint, so clicking it felt broken even when the click was doing its job.)
  const n = Math.min(hidden, RENDER_STEP);
  const text = hidden > 0 ? `Load ${n} earlier message${n > 1 ? "s" : ""}${hidden > RENDER_STEP ? ` (${hidden.toLocaleString()} more above)` : ""}` : "Start of conversation";
  // Bound on mousedown, not click: a re-render (streaming flush, or the scroll
  // auto-loader firing as you reach the top) swaps this node out between press and
  // release, so the click event never lands on the same element and is dropped.
  return h("div", { class: "load-more" + (hidden > 0 ? "" : " load-more-static"), onmousedown: hidden > 0 ? ((e) => { if (e.button === 0) { e.preventDefault(); loadOlder(); } }) : null },
    h("span", { html: icon("history", 13) }),
    h("span", { text }));
}
// Below a detached window: how many newer messages remain, click to page them in.
export function bottomSentinel(ts) {
  const remaining = Math.max(0, (ts.totalMessages || 0) - (ts.firstIndex + ts.messages.length));
  if (!remaining) return null;
  const n = Math.min(remaining, RENDER_STEP);
  return h("div", { class: "load-more load-more-bottom", onmousedown: (e) => { if (e.button === 0) { e.preventDefault(); loadNewer(); } } },
    h("span", { html: icon("chevronDown", 13) }),
    h("span", { text: `Load ${n} newer message${n > 1 ? "s" : ""}${remaining > RENDER_STEP ? ` (${remaining.toLocaleString()} more below)` : ""}` }),
    h("button", { class: "load-more-jump", text: "Jump to latest", onmousedown: (e) => { e.stopPropagation(); e.preventDefault(); scrollBottom(true); } }));
}
export function renderMessagesRegion() {
  const ts = activeTS();
  const msgs = $("chatMessages");
  if (!msgs || !ts) return;
  msgs.innerHTML = "";
  const total = ts.messages.length;
  if (!total && !ts.firstIndex) {
    // Empty session (e.g. a brand-new tab): still refresh the overlays, or the
    // PREVIOUS session's prompt-rail dots and model filter stay on screen — they
    // live in #main, which isn't rebuilt per tab.
    msgs.append(emptyState());
    renderPromptRail();
    renderModelFilter();
    return;
  }
  if (ts.viewStart == null || ts.viewStart > total) ts.viewStart = Math.max(0, total - RENDER_STEP);
  const hidden = hiddenOlderCount(ts);
  if (hidden > 0 || archivedOlderCount(ts)) msgs.append(topSentinel(hidden));
  for (let i = ts.viewStart; i < total; i++) msgs.append(renderMessage(ts.messages[i], ts));
  if (!atTail(ts)) { const bs = bottomSentinel(ts); if (bs) msgs.append(bs); }
  renderNewMsgBadge();
  renderPromptRail();
  renderModelFilter();            // top-right provider/model filter (when a chat mixes them)
  applyModelFilter(ts);
  if ($("chatSearch")) doChatFind($("chatFindInput") ? $("chatFindInput").value : "");  // re-apply highlights after a re-render
}
// When a conversation has replies from ≥2 distinct provider+model combos, show a
// filter pinned top-right; picking one fades the replies that don't match.
export function renderModelFilter() {
  const ts = activeTS(); const wrap = $("main");   // non-scrolling parent — stays pinned top-right
  if (!ts || !wrap) { const e = $("modelFilter"); if (e) e.remove(); return; }
  const seen = new Map();   // "provider|model" → meta
  for (const m of ts.messages) if (m.role === "assistant" && m.meta && m.meta.provider) { const k = metaKey(m.meta); if (!seen.has(k)) seen.set(k, m.meta); }
  if (ts.modelFilter && ![...seen.keys()].includes(ts.modelFilter)) ts.modelFilter = null;
  let el = $("modelFilter");
  if (!el) { el = h("div", { id: "modelFilter", class: "model-filter" }); wrap.appendChild(el); }
  el.innerHTML = "";
  // Expanding search icon (replaces the old bare filter) — opens the in-conversation
  // + on-disk search for THIS session. Always present, top-right.
  el.append(h("button", { class: "mf-search", title: "Search this conversation (Ctrl+F)", html: icon("search", 13), onclick: () => openChatSearch() }));
  // Prompt picker — every prompt in this session (archive included), searchable;
  // pick one to load that part of the transcript and scroll to it.
  el.append(h("button", { class: "mf-search mf-prompts", title: "Prompts in this conversation (Ctrl+Shift+P)", html: icon("chat", 13) + icon("chevronDown", 10), onclick: (e) => openPromptPicker(e.currentTarget) }));
  // Model-filter chips only when the conversation actually mixes ≥2 provider/models.
  if (seen.size >= 2) {
    const chip = (key, label, cls) => h("button", { class: "mf-chip" + ((ts.modelFilter || null) === key ? " active" : "") + (cls ? " " + cls : ""), text: label, title: key ? `Show only replies from ${label}` : "Show every reply", onclick: () => { ts.modelFilter = key; renderModelFilter(); applyModelFilter(ts); } });
    // An ACTIVE filter is always visible as such, with a one-click way out.
    el.append(chip(null, ts.modelFilter ? "Show all ✕" : "All", ts.modelFilter ? "mf-clear" : ""));
    for (const [k, meta] of seen) el.append(chip(k, meta.endpointName || modelName(meta.provider, meta.model) || PROVIDER_NAME[meta.provider] || meta.provider));
  } else if (ts.modelFilter) { ts.modelFilter = null; applyModelFilter(ts); }
}
export function applyModelFilter(ts) {
  const f = ts && ts.modelFilter;
  for (const el of document.querySelectorAll("#chatMessages .msg.assistant")) el.classList.toggle("msg-filtered", !!f && el.dataset.mk !== f);
}
export function ensureTopSentinel() {
  const ts = activeTS();
  const msgs = $("chatMessages");
  if (!msgs || !ts) return;
  const existing = msgs.querySelector(".load-more");
  if (existing) existing.remove();
  const hidden = hiddenOlderCount(ts);
  if (hidden > 0 || archivedOlderCount(ts)) msgs.insertBefore(topSentinel(hidden), msgs.firstChild);
}
// Load an older page — first expand the in-memory window, then fetch the next
// page from disk — keeping the viewport anchored on what the user was reading.
// A small spinner pins to the top while the disk page loads.
export async function loadOlder() {
  const ts = activeTS();
  if (!ts || _loadingOlder) return;
  _loadingOlder = true;
  try { await loadOlderInner(ts); } finally { _loadingOlder = false; }
}
export async function loadOlderInner(ts) {
  const w = $("chatWrap");
  const oldH = w.scrollHeight, oldTop = w.scrollTop;
  if (ts.viewStart > 0) {
    ts.viewStart = Math.max(0, ts.viewStart - RENDER_STEP);
    renderMessagesRegion();
    w.scrollTop = oldTop + (w.scrollHeight - oldH);
    return;
  }
  if (ts.firstIndex > 0) {
    const spin = h("div", { class: "load-older" }, h("span", { class: "spinner" }), h("span", { text: "Loading earlier messages…" }));
    $("chatMessages").prepend(spin);
    const t0 = performance.now();
    const r = await atom.sessions.messages(ts.meta.id, ts.firstIndex, RENDER_STEP).catch(() => null);
    // keep the spinner visible long enough to register (avoids a 1-frame flash)
    const wait = Math.max(0, 180 - (performance.now() - t0));
    if (wait) await new Promise((res) => setTimeout(res, wait));
    spin.remove();
    if (r && r.messages && r.messages.length) {
      ts.messages = r.messages.concat(ts.messages);
      ts.firstIndex = r.firstIndex;
      if (r.total) ts.totalMessages = Math.max(ts.totalMessages || 0, r.total);
      ts.viewStart = 0;
      // Keep RAM bounded while paging UP: drop the newest part of the window (it's
      // one scroll-down away). The window is then detached from the tail; scrolling
      // down pages it back in.
      if (ts.messages.length > MEM_CAP) ts.messages.length = MEM_CAP;
      // Apply any patches that arrived for messages while they were outside
      // the in-RAM window (e.g. tool cards whose result arrived after MEM_CAP
      // trim) so they don't render as stale "running" cards.
      if (ts._pendingPatches && ts._pendingPatches.size) {
        for (const m of r.messages) {
          const p = ts._pendingPatches.get(m.id);
          if (p) { Object.assign(m, p); ts._pendingPatches.delete(m.id); }
        }
      }
      renderMessagesRegion();
      w.scrollTop = oldTop + (w.scrollHeight - oldH);
    }
  }
}
// Drop the oldest rendered nodes once we exceed MAX_RENDER (only while the user
// is following the live tail, so we never yank away history they're reading).
export function trimRenderedTop() {
  const ts = activeTS();
  const msgs = $("chatMessages");
  if (!ts || !msgs) return;
  const nodes = msgs.querySelectorAll(".msg");
  const over = nodes.length - MAX_RENDER;
  if (over > 0) {
    for (let i = 0; i < over; i++) nodes[i].remove();
    ts.viewStart += over;
    ensureTopSentinel();
  }
}
export function emptyState() {
  const ts = activeTS();
  const suggestions = [
    { t: "Explain this codebase", s: "Give me a high-level tour of the project structure and key files." },
    { t: "Find and fix a bug", s: "Look for issues in the code and propose fixes." },
    { t: "Add a feature", s: "Implement a new feature end to end with tests." },
    { t: "Write tests", s: "Add unit tests for the most important modules." },
  ];
  const grid = h("div", { class: "suggest-grid" });
  for (const s of suggestions) grid.append(h("button", { class: "suggest", onclick: () => { const ta = $("promptInput"); ta.value = s.s; ta.focus(); autoGrow(); } },
    h("b", { text: s.t }), s.s));
  return h("div", { class: "chat-empty" },
    h("span", { class: "ce-mark", html: icon("atom", 70) }),
    h("h2", { text: "Start building with Claude" }),
    h("p", { html: `Working in <b style="color:var(--text-2)">${baseName(state.project || ts.meta.cwd)}</b>. Pick a folder on the left, then describe what you want done — AtomNano runs Claude Code's full toolset right here.` }),
    grid);
}
export function roleLine(label, tsIso, copyBtn) {
  // DOM order [label, copy, time]: assistant rows read "Claude · copy · time"; user
  // rows are row-reversed in CSS → "time · copy · You", i.e. copy sits before "You".
  return h("div", { class: "msg-role" }, h("span", { class: "msg-role-label", text: label }), copyBtn || null, h("span", { class: "msg-time", text: fmtTime(tsIso) }));
}
export function imgSrc(a) { return a.data ? `data:${a.mediaType || "image/png"};base64,${a.data}` : a.path ? "file:///" + String(a.path).replace(/\\/g, "/") : a.thumb || ""; }
export function attachmentsRow(atts) {
  if (!atts || !atts.length) return null;
  const row = h("div", { class: "msg-attachments" });
  for (const a of atts) {
    if (a.kind === "image" && (a.thumb || a.data || a.path)) {
      // Prefer the full image (data ▸ file path) for a crisp preview; the thumb
      // is only a fallback (e.g. a pasted image after reload).
      const im = h("img", { class: "msg-att-img", src: imgSrc(a) || a.thumb, title: "Click to view · " + (a.name || "image"), onclick: () => openImageViewer(imgSrc(a) || a.thumb, a.name) });
      im.addEventListener("error", () => { if (a.thumb && im.src !== a.thumb) im.src = a.thumb; });
      row.append(im);
    } else {
      row.append(h("span", { class: "msg-att-file", title: "Open · " + (a.path || a.name), onclick: () => openAttachment(a) },
        h("span", { html: icon("file", 12) }), h("span", { text: a.name || baseName(a.path || "file") })));
    }
  }
  return row;
}
// Open a non-image attachment: text-ish files in the editor, otherwise externally.
export function openAttachment(a) {
  if (!a) return;
  if (a.kind === "image") return openImageViewer(imgSrc(a), a.name);
  if (a.path && /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|xml|yml|yaml|csv|log|py|go|rs|java|c|cpp|h|sh)$/i.test(a.path)) { Promise.resolve(openInEditor(a.path)).catch(() => atom.shell.openExternal("file:///" + a.path.replace(/\\/g, "/"))); return; }
  if (a.path) atom.shell.openExternal("file:///" + a.path.replace(/\\/g, "/"));
}
