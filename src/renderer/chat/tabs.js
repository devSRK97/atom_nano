/* AtomNano renderer — Session tabs (the chat header) and per-tab state.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { $, h, hideContextMenu, samePath, showContextMenu, toast } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { closeEtMenu, etMenuOutside, renderEditor, renderEditorTabs } from "../editor/editor-pane.js";
import { closeTab, newTab, renameSession, switchTab, tabContextMenu } from "../git/conflicts-ui.js";
import { icon } from "../icons.js";
import { toggleAgents } from "../panels/agents.js";
import { refreshBoardDock } from "../panels/board.js";
import { toggleBoard, toggleFleet, toggleTests } from "../panels/changes.js";
import { persistEditor, persistTabs } from "../workspace/projects.js";
import { toggleWorkflowStudio } from "../workflow/index.js";
import { importConversation, toggleReviewersPopover, toggleRolesPopover } from "./composer.js";
import { openHistory, openSessionTab } from "./history.js";
import { openChatSearch } from "./navigation.js";

// The workflow roles (docs/WORKFLOW_CONTRACT.md): display name + icon, shared by the child-tab badge,
// the job cards in the orchestrator's chat and the overflow menu. The hue per role is CSS (`.role-<role>`).
export const ROLE_META = { orchestrator: { name: "Orchestrator", icon: "cpu" }, planner: { name: "Planner", icon: "brain" }, coder: { name: "Coder", icon: "fileCode" }, reviewer: { name: "Reviewer", icon: "shield" }, tester: { name: "Tester", icon: "checkCircle" } };
export function roleMeta(role) { const r = String(role || "").toLowerCase(); return ROLE_META[r] || { name: r ? r.charAt(0).toUpperCase() + r.slice(1) : "Job", icon: "agents" }; }

export function addTabState(view) {
  const meta = {
    id: view.id, name: view.name, cwd: view.cwd, model: view.model,
    permissionMode: view.permissionMode, thinking: view.thinking, oneM: view.oneM,
    claudeSessionId: view.claudeSessionId, status: view.status || "idle",
    createdAt: view.createdAt, updatedAt: view.updatedAt, totalCostUsd: view.totalCostUsd,
    // A role job's child session (workflow): its planner, role, the provider it runs on, its job.
    parentId: view.parentId || null, role: view.role || null, provider: view.provider || null, jobId: view.jobId || null,
  };
  state.tabs.set(view.id, {
    meta,
    // The tab's OWN workflow (per-session selection, docs/WORKFLOW_CONTRACT.md §10): null = the project's
    // active workflow. Mirrored from workflow:* replies and session:workflow events (workflow/model.js).
    wfOwn: view.workflow && typeof view.workflow === "object" ? view.workflow : null,
    messages: view.messages || [],                 // in-memory window (tail)
    firstIndex: view.firstIndex || 0,              // global index of messages[0]
    totalMessages: view.totalMessages != null ? view.totalMessages : (view.messages ? view.messages.length : 0),
    archivedCount: view.archivedCount || 0,        // oldest msgs pruned past the cap, folded into session memory
    editedFiles: view.editedFiles || [],
    streaming: new Map(),
    pendingPerms: [],
    // Tools the user chose to allow "for this session". Persisted on the
     // session record (view.autoAllow is an array) so the choice survives a tab
     // close, app restart, or window reopen.
    autoAllow: new Set(Array.isArray(view.autoAllow) ? view.autoAllow : []),
    attachments: [],
    queue: [],
    draft: "",
    tree: null,
    // (No per-tab skill selection: a plain chat carries no skills — only a workflow role's job session does,
    //  set by main from the role's attached skills, docs/WORKFLOW_CONTRACT.md. 2026-09-18)
    // Sub-agent registry (persisted on the session): every worker launched here, numbered.
    agents: Array.isArray(view.agents) ? view.agents : [],
    ctxInfo: null,   // context window fill / digest (session:context)
    // Task board (docs/WORKFLOW_CONTRACT.md §8): the session's board as the view carried it (`tasks`), then every
    // tasks:update. Read through panels/board.js boardOf(ts), which normalises either shape.
    board: view.tasks && typeof view.tasks === "object" ? view.tasks : (view.board && typeof view.board === "object" ? view.board : null),
  });
}
export const MEM_CAP = 240;
/* ============================================================
   TABS
   ============================================================ */
// HTML5 drag-to-reorder. Returns props to spread onto an h() element; onReorder
// gets (draggedId, targetId).
export function dragProps(id, onReorder) {
  return {
    draggable: "true",
    ondragstart: (e) => { e.dataTransfer.setData("text/atom-tab", id); e.dataTransfer.effectAllowed = "move"; e.currentTarget.classList.add("dragging"); },
    ondragend: (e) => { e.currentTarget.classList.remove("dragging"); document.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over")); },
    ondragover: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; e.currentTarget.classList.add("drag-over"); },
    ondragleave: (e) => { e.currentTarget.classList.remove("drag-over"); },
    ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove("drag-over"); const from = e.dataTransfer.getData("text/atom-tab"); if (from) onReorder(from, id); },
  };
}
export function moveInArray(arr, fromIdx, toIdx) { if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return; const [it] = arr.splice(fromIdx, 1); arr.splice(toIdx, 0, it); }
export function reorderSessionTabs(fromId, toId) {
  if (fromId === toId) return;
  moveInArray(state.order, state.order.indexOf(fromId), state.order.indexOf(toId));
  renderTabs(); persistTabs();
}
export function reorderEditorTabs(fromPath, toPath) {
  if (fromPath === toPath) return;
  const arr = state.editor.open;
  moveInArray(arr, arr.findIndex((f) => f.path === fromPath), arr.findIndex((f) => f.path === toPath));
  renderEditorTabs(); renderEditor(); persistEditor();
}
// Session tabs now live in the chat-panel header strip and overflow into a
// dropdown the same way the editor tabs do.
// Real Claude subscription usage (five-hour + weekly windows) for the active-tab
// tooltip. Fetched from the OAuth usage API via main; cached + refreshed on a
// timer. `_usage` holds the last good snapshot. `_usageAttempted` flips true
// after the first fetch (success OR failure) so the tooltip stops saying
// "loading…" once we know the result — previously a null return kept it stuck.
export let _usage = null, _usageAttempted = false;
export async function refreshUsage(force) {
  let u = null;
  try { u = await atom.usage.get(force); } catch { /* ignore */ }
  _usageAttempted = true;
  if (u) _usage = u;
  const a = state.tabs.get(state.activeTabId); if (a) applyTabTip();
}
export function fmtResetTime(iso) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d)) return "";
  const now = new Date();
  const mins = Math.round((d - now) / 60000);
  let rel;
  if (mins <= 0) rel = "now";
  else if (mins < 60) rel = `in ${mins}m`;
  else if (mins < 60 * 24) { const hh = Math.floor(mins / 60), mm = mins % 60; rel = `in ${hh}h${mm ? " " + mm + "m" : ""}`; }
  else rel = `in ${Math.round(mins / (60 * 24))}d`;
  const sameDay = d.toDateString() === now.toDateString();
  const clock = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const when = sameDay ? clock : d.toLocaleDateString([], { weekday: "short" }) + " " + clock;
  return `resets ${when} (${rel})`;
}
// Build the active tab's tooltip text: real usage windows + working dir. If the
// fetch has been attempted and there's no data, we fall through to a plain path
// tooltip instead of a stuck "loading…" (that was the reported bug — API-key
// users and offline states left the hover permanently loading).
export function usageTipText(ts) {
  const cwd = ts && ts.meta.cwd ? ts.meta.cwd : "";
  // Live context-window fill for this tab (from getContextUsage while running) —
  // the info that used to sit in the composer chip now lives here.
  let ctxLine = "";
  if (ts && ts.ctxUsage && ts.ctxUsage.totalTokens) {
    const u = ts.ctxUsage;
    const pct = u.percentage != null ? Math.round(u.percentage) : (u.maxTokens ? Math.round(u.totalTokens / u.maxTokens * 100) : null);
    ctxLine = `Context: ${pct != null ? pct + "% · " : ""}${(u.totalTokens / 1000).toFixed(1)}k${u.maxTokens ? " / " + (u.maxTokens / 1000).toFixed(0) + "k" : ""} tokens`;
  }
  const cwdBlock = cwd ? "\n\n" + cwd : "";
  if (!_usage) {
    if (!_usageAttempted) return ["Claude usage — loading…", ctxLine].filter(Boolean).join("\n") + cwdBlock;
    // Attempted, no plan data — still show context (if any) + the path.
    return [ctxLine, cwd || (ts && ts.meta.name) || ""].filter(Boolean).join("\n\n") || "";
  }
  const lines = [];
  const fh = _usage.fiveHour, wk = _usage.sevenDay, op = _usage.sevenDayOpus, so = _usage.sevenDaySonnet;
  if (fh) lines.push(`5-hour: ${Math.round(fh.utilization)}% used · ${fmtResetTime(fh.resetsAt)}`);
  if (wk) lines.push(`Weekly: ${Math.round(wk.utilization)}% used · ${fmtResetTime(wk.resetsAt)}`);
  if (op && op.utilization != null) lines.push(`Weekly (Opus): ${Math.round(op.utilization)}%`);
  if (so && so.utilization != null && (!op || op.utilization == null)) lines.push(`Weekly (Sonnet): ${Math.round(so.utilization)}%`);
  if (ctxLine) lines.push(ctxLine);
  if (!lines.length) return cwd || "";
  return "Claude usage\n" + lines.join("\n") + cwdBlock;
}
// Set data-tip on each tab: the ACTIVE tab gets the rich usage tooltip; others
// just show their working dir. Uses the custom (copy-style) tooltip everywhere.
export function applyTabTip() {
  const wrap = $("tabs");
  if (!wrap) return;
  for (const el of wrap.querySelectorAll(".cht-tab")) {
    const id = el.dataset.id; const ts = state.tabs.get(id);
    if (!ts) continue;
    if (id === state.activeTabId) el.setAttribute("data-tip", usageTipText(ts));
    else el.setAttribute("data-tip", ts.meta.cwd || ts.meta.name);
  }
}
// Coalesce renderTabs() calls to one DOM rebuild per animation frame. Callers
// fire it liberally (every message, every status change, every permission event
// — 20+ times per turn on a busy session), and each call blows away and rebuilds
// the whole tab strip. With many tabs open that's real reflow work.
export let _tabsRaf = 0;
export function renderTabs() {
  if (_tabsRaf) return;
  _tabsRaf = requestAnimationFrame(() => { _tabsRaf = 0; renderTabsNow(); });
}
// The tab the Board dock last followed: the strip re-renders on every switchTab, so an active-tab change is
// noticed here and the dock (when open) and the composer chip follow the new tab's board (panels/board.js).
export let _boardTab = null;
// Tab status indicator glyph: running → 3-dot bounce; done → filled check;
// error / rate-limit / usage-exceeded / offline / auth → red cross; idle → gray
// dot; attention (permission needed) → blinking accent dot.
export function statusGlyph(status) {
  if (status === "running") return `<span class="ts-dots"><i></i><i></i><i></i></span>`;
  if (status === "done") return icon("check", 11);
  if (status === "error" || status === "ratelimited" || status === "offline" || status === "auth-expired") return icon("close", 11);
  if (status === "attention") return `<span class="ts-dot ts-attn"></span>`;
  return `<span class="ts-dot"></span>`;   // idle
}
export function makeTabEl(id) {
  const tab = h("div", Object.assign({
    class: "cht-tab",
    dataset: { id },
    "data-tip-dir": "bottom",
    onclick: () => switchTab(id),
    ondblclick: () => renameSession(id),
    oncontextmenu: (e) => { e.preventDefault(); tabContextMenu(e, id); },
    onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } },
  }, dragProps(id, reorderSessionTabs)),
    h("span", { class: "tab-status" }),
    h("span", { class: "ct-role" }),   // the role badge of a child (job) tab — empty and hidden otherwise
    h("span", { class: "ct-name" }),
    h("button", { class: "ct-x", html: icon("close", 12), onclick: (e) => { e.stopPropagation(); closeTab(id); } }));
  return tab;
}
// A child tab's tooltip: "Coder job of <orchestrator tab>" (the orchestrator's name when its tab is open here).
export function childTabTip(ts) {
  const parent = ts.meta.parentId ? state.tabs.get(ts.meta.parentId) : null;
  return `${roleMeta(ts.meta.role).name} job of ${parent ? parent.meta.name : "an orchestrator session"}`;
}
// Reconcile the tab strip IN-PLACE (reuse existing elements, update only what
// changed) instead of nuking innerHTML. During generation renderTabs() fires
// ~20×/turn; a full rebuild destroyed the element under the cursor each time,
// which reset the hover-tooltip timer so the usage tooltip could never stay up.
// Reusing elements keeps the hovered node alive → the tooltip persists. It's
// also far less reflow.
export function renderTabsNow() {
  const wrap = $("tabs");
  if (!wrap) return;
  const existing = new Map([...wrap.querySelectorAll(":scope > .cht-tab")].map((el) => [el.dataset.id, el]));
  let prev = null;   // for ordering
  for (const id of state.order) {
    const ts = state.tabs.get(id);
    if (!ts) continue;
    const status = ts.pendingPerms.length ? "attention" : (ts.meta.status || "idle");
    const isActive = id === state.activeTabId;
    const child = !!ts.meta.parentId;
    const tip = child ? (isActive ? childTabTip(ts) + "\n\n" + usageTipText(ts) : childTabTip(ts)) : (isActive ? usageTipText(ts) : (ts.meta.cwd || ts.meta.name));
    let tab = existing.get(id);
    if (tab) existing.delete(id);
    else tab = makeTabEl(id);
    // Update only changed bits (avoids clobbering a hovered element's identity).
    tab.classList.toggle("active", isActive);
    const st = tab.querySelector(".tab-status"); const wantSt = "tab-status " + status;
    if (st.className !== wantSt) { st.className = wantSt; st.innerHTML = statusGlyph(status); }
    // A child (job) tab: the `child` class, the role's hue class and the role badge before the name.
    // Its place in the strip is state.order's (openSessionTabQuiet puts it right after its parent).
    tab.classList.toggle("child", child);
    const role = child ? String(ts.meta.role || "job").toLowerCase() : "";
    const rb = tab.querySelector(".ct-role");
    if (rb && (rb.dataset.role || "") !== role) {
      for (const c of [...tab.classList]) if (c.startsWith("role-")) tab.classList.remove(c);
      if (role) tab.classList.add("role-" + role);
      rb.dataset.role = role;
      rb.innerHTML = role ? icon(roleMeta(role).icon, 11) : "";
    }
    const nm = tab.querySelector(".ct-name"); if (nm.textContent !== ts.meta.name) nm.textContent = ts.meta.name;
    if (tab.getAttribute("data-tip") !== tip) tab.setAttribute("data-tip", tip);
    // Order: put this tab right after `prev`. If it's already there, don't touch
    // it (moving the hovered element would drop its tooltip too).
    const anchor = prev ? prev.nextSibling : wrap.firstChild;
    if (anchor !== tab) wrap.insertBefore(tab, anchor);
    prev = tab;
  }
  for (const el of existing.values()) el.remove();   // drop closed tabs
  requestAnimationFrame(computeSessionOverflow);
  if (state.activeTabId !== _boardTab) { _boardTab = state.activeTabId; refreshBoardDock(); }
}
// One-time wiring for the chat header's overflow + History/New-session buttons.
export function wireChatHeader() {
  const ov = $("tabOverflow");
  if (ov) { ov.innerHTML = ""; ov.append(h("span", { html: icon("chevronDown", 16) }), h("span", { class: "ct-badge" })); ov.onclick = (e) => sessionOverflowMenu(e); }
  const nt = $("newTab"); if (nt) { nt.innerHTML = icon("plus", 18); nt.onclick = () => newTab(); }
  // Visible affordance for conversation search — Ctrl+F was the only way in before.
  const sb = $("chatSearchBtn"); if (sb) { sb.innerHTML = icon("search", 16); sb.onclick = () => openChatSearch(); }
  // Header "More" (the ⋮ menu) — the Roles (Planner) setup and Reviewers open their popovers from
  // here; the Workflow studio (skills are attached to its roles there — the per-chat skills entry and
  // the skills dock left this menu on 2026-09-18); the Agents activity, Task board, Fleet and Tests docks;
  // Import / History. Sub-agents themselves are the Agents button in the composer.
  const more = $("chatMore");
  if (more) {
    more.innerHTML = icon("moreVert", 18);
    more.onclick = async (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      const plannerOn = !!(state.settings.planner && state.settings.planner.enabled);
      const nReviewers = (state.settings.reviewers || []).length;
      const items = [
        { label: `Roles · Planner${plannerOn ? " on" : ""}…`, icon: "sparkle", onClick: () => toggleRolesPopover(more) },
        { label: `Reviewers${nReviewers ? " · " + nReviewers : ""}…`, icon: "shield", onClick: () => toggleReviewersPopover(more) },   // moved here from the composer row (2026-09-17)
        { label: "Workflow studio…", icon: "activity", onClick: () => toggleWorkflowStudio() },
        { sep: true },
        { label: "Agents activity", icon: "agents", onClick: () => toggleAgents() },
        { label: "Task board", icon: "checkCircle", onClick: () => toggleBoard() },
        { label: "Fleet", icon: "cpu", onClick: () => toggleFleet() },
        { label: "Tests", icon: "checkCircle", onClick: () => toggleTests() },
      ];
      // Recent conversations — loaded LIVE from disk each time the menu opens, so it
      // reflects sessions created/updated in other windows since this tab loaded.
      let recents = [];
      try {
        const proj = state.project || (activeTS() && activeTS().meta.cwd);
        const all = await atom.sessions.list();
        recents = all.filter((s) => !proj || samePath(s.cwd, proj)).slice(0, 6);
      } catch { /* ignore — menu still opens without recents */ }
      items.push({ sep: true });
      if (recents.length) {
        items.push({ label: "Recent conversations", icon: "history" });   // header (no onClick)
        for (const s of recents) items.push({ label: s.name || "Untitled", icon: state.tabs.has(s.id) ? "checkCircle" : "chat", onClick: () => openSessionTab(s.id) });
        items.push({ sep: true });
      }
      items.push(
        { label: "Import conversation…", icon: "upload", onClick: () => importConversation() },
        { label: "All history…", icon: "history", onClick: () => openHistory() },
      );
      showContextMenu(r.right - 220, r.bottom + 4, items);
    };
  }
}
// Hide session tabs that don't fit; the overflow button lists them. Mirrors
// computeEditorOverflow — the active tab is always kept visible.
export function computeSessionOverflow() {
  const host = $("chatHeader"); const scroll = $("tabs"); const ov = $("tabOverflow");
  if (!host || !scroll || !ov) return;
  const tabs = [...scroll.querySelectorAll(".cht-tab")];
  tabs.forEach((t) => t.classList.remove("cht-hidden"));
  ov.classList.add("hidden"); ov._hidden = [];
  if (tabs.length <= 1) return;
  const actions = host.querySelector(".cht-actions");
  const avail = host.clientWidth - (actions ? actions.offsetWidth : 0);
  const widths = new Map(tabs.map((t) => [t, t.offsetWidth]));
  const total = tabs.reduce((s, t) => s + widths.get(t), 0);
  if (total <= avail) return;
  const reserve = 38;
  const hidden = []; let used = 0;
  for (const t of tabs) {
    const w = widths.get(t);
    if (used + w <= avail - reserve) used += w;
    else { t.classList.add("cht-hidden"); hidden.push(t.dataset.id); }
  }
  const active = state.activeTabId;
  if (active && hidden.includes(active)) {
    const aEl = tabs.find((t) => t.dataset.id === active);
    aEl.classList.remove("cht-hidden");
    hidden.splice(hidden.indexOf(active), 1);
    let w2 = tabs.filter((t) => !t.classList.contains("cht-hidden")).reduce((s, t) => s + widths.get(t), 0);
    const vis = tabs.filter((t) => !t.classList.contains("cht-hidden") && t.dataset.id !== active);
    for (let i = vis.length - 1; i >= 0 && w2 > avail - reserve; i--) { vis[i].classList.add("cht-hidden"); w2 -= widths.get(vis[i]); hidden.push(vis[i].dataset.id); }
  }
  if (!hidden.length) return;
  ov.classList.remove("hidden");
  ov._hidden = hidden;
  const badge = ov.querySelector(".ct-badge"); if (badge) badge.textContent = String(hidden.length);
}
// Bring a hidden session tab into view (move to end → last visible) + activate.
export function revealSessionTab(id) {
  const from = state.order.indexOf(id);
  if (from >= 0) { const [it] = state.order.splice(from, 1); state.order.push(it); persistTabs(); }
  switchTab(id);
}
// Dropdown listing session tabs that don't fit; each reveals or closes.
export function sessionOverflowMenu(e) {
  const ov = e.currentTarget;
  const ids = (ov._hidden || []).filter((id) => state.tabs.has(id));
  closeEtMenu(); hideContextMenu();
  if (!ids.length) return;
  const menu = h("div", { class: "et-menu" });
  for (const id of ids) {
    const ts = state.tabs.get(id);
    const status = ts.pendingPerms.length ? "attention" : (ts.meta.status || "idle");
    menu.append(h("div", { class: "et-menu-row" + (id === state.activeTabId ? " active" : "") + (ts.meta.parentId ? " child role-" + String(ts.meta.role || "job").toLowerCase() : ""), onclick: () => { closeEtMenu(); revealSessionTab(id); } },
      h("span", { class: "tab-status " + status, style: "width:9px;height:9px;border-radius:50%;flex-shrink:0" }),
      ts.meta.parentId ? h("span", { class: "ct-role", dataset: { role: String(ts.meta.role || "job").toLowerCase() }, html: icon(roleMeta(ts.meta.role).icon, 11) }) : null,
      h("span", { class: "et-menu-name", text: ts.meta.name, title: ts.meta.parentId ? childTabTip(ts) : ts.meta.cwd }),
      h("button", { class: "et-menu-x", title: "Close", html: icon("close", 12), onclick: (ev) => { ev.stopPropagation(); closeEtMenu(); closeTab(id); } })));
  }
  document.body.append(menu);
  const r = ov.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + "px";
  menu.style.left = Math.max(8, Math.min(r.right - 240, window.innerWidth - 248)) + "px";
  setTimeout(() => document.addEventListener("mousedown", etMenuOutside, true), 0);
}
