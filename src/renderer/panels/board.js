/* AtomNano renderer — Task board dock (docs/WORKFLOW_CONTRACT.md §8): the planner session's centralised
 * board of numbered tasks (T1, T2 …) grouped in SETS — the Planner creates them with `atomnano tasks add …`
 * and the roles update them as they work; the user adds, renames, re-states and deletes tasks here. The tab
 * keeps the board (ts.board — from the session view, then every tasks:update through chat/events.js); this
 * dock shows the active set expanded and finished sets collapsed, the per-set chat card (chat/messages.js
 * tasksCard) opens the dock on a row, and the composer chip (workflow/live.js) reads the same board. */
import { roleMeta } from "../chat/tabs.js";
import { $, confirmDialog, h, promptDialog, showContextMenu, timeAgo, toast } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { icon } from "../icons.js";
import { refreshWorkflowChip } from "../workflow/index.js";
import { currentDock, dockHead, showDock, toggleBoard } from "./changes.js";

/* ---------------- the board model (contract §8) ---------------- */
export const TASK_STATUSES = ["todo", "doing", "review", "test", "done", "blocked", "dropped"];
export const TASK_TERMINAL = new Set(["done", "dropped"]);
export const TASK_STATUS_TITLE = { todo: "To do", doing: "In progress", review: "In review", test: "In test", done: "Done", blocked: "Blocked", dropped: "Dropped" };
export const TASKS_UNAVAILABLE = "The task board service is not available in this build yet";
export function hasTasksService(fn) { const t = atom && atom.tasks; return !!(t && typeof t[fn] === "function"); }
export function taskStatusOf(it) { const s = String((it && it.status) || "todo").toLowerCase(); return TASK_STATUS_TITLE[s] ? s : "todo"; }
export function taskRef(it) { return "T" + (it && it.n != null ? it.n : "?"); }
export function boardMs(v) { if (!v) return 0; if (typeof v === "number") return v; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : 0; }
export function boardErrText(e) { return (e && (e.message || e.error)) || String(e || "Something went wrong"); }
// done / dropped / open counts and the bar percentages of a list of items.
export function progressOf(items) {
  let done = 0, dropped = 0;
  for (const it of items) { const s = taskStatusOf(it); if (s === "done") done++; else if (s === "dropped") dropped++; }
  const total = items.length;
  return { total, done, dropped, open: total - done - dropped, pctDone: total ? (done / total) * 100 : 0, pctDropped: total ? (dropped / total) * 100 : 0 };
}
// The tab's board normalised — whatever shape arrived (boardFor's output, the raw session.tasks record, nothing):
// sets, items, the active set id and the counts. Never throws.
export function normalizeBoard(raw) {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const sets = Array.isArray(b.sets) ? b.sets.filter((s) => s && s.id != null) : [];
  const items = (Array.isArray(b.items) ? b.items : Array.isArray(raw) ? raw : []).filter((i) => i && i.n != null);
  const act = sets.find((s) => b.active != null && s.id === b.active) || sets.find((s) => s.status === "active") || null;
  const p = progressOf(items);
  return { seq: +b.seq || 0, setSeq: +b.setSeq || 0, sets, items, active: act ? act.id : null, counts: { total: p.total, open: p.open, done: p.done, dropped: p.dropped } };
}
export function boardOf(ts) { return normalizeBoard(ts && ts.board); }
export function itemsOfSet(board, setId) { return board.items.filter((i) => i.setId === setId); }
export function activeSetOf(board) { return board.active != null ? board.sets.find((s) => s.id === board.active) || null : null; }
// "Set 2 · Payments" — just "Set 2" when the title is the default one.
export function setLabel(set) { if (!set) return "Tasks"; const t = String(set.title || "").trim(); return t && t !== `Set ${set.n}` ? `Set ${set.n} · ${t}` : `Set ${set.n}`; }
// Sets in display order: the active set first, then the others newest first; items without a known set trail.
export function boardGroups(board) {
  const groups = [];
  const act = activeSetOf(board);
  if (act) groups.push({ set: act, items: itemsOfSet(board, act.id) });
  for (const s of board.sets.filter((s) => !act || s.id !== act.id).sort((a, b) => (+b.n || 0) - (+a.n || 0))) groups.push({ set: s, items: itemsOfSet(board, s.id) });
  const known = new Set(board.sets.map((s) => s.id));
  const loose = board.items.filter((i) => i.setId == null || !known.has(i.setId));
  if (loose.length) groups.push({ set: null, items: loose });
  return groups;
}
// The jobs linked to a task (state.workflow.jobs — a job the studio has not seen yet is shown by id).
export function linkedJobs(it) {
  const ids = Array.isArray(it.jobIds) ? it.jobIds : [];
  const all = ids.map((id) => state.workflow.jobs.get(id) || { id, status: "unknown", role: "" });
  return { all, live: all.filter((j) => j.status === "running" || j.status === "queued").length };
}

/* ---------------- dock state ---------------- */
export let boardFilter = "all";               // all | open | done
export const boardOpenSets = new Map();       // setId → the user's explicit expand/collapse (else: open iff active)
export const boardOpenTasks = new Set();      // "T12" refs whose detail is expanded
export let _bdTicker = null, _bdRenderTimer = null;
export function isSetOpen(board, set) { if (!set) return true; if (boardOpenSets.has(set.id)) return boardOpenSets.get(set.id); return set.id === board.active; }
export const TASK_ONGOING = new Set(["doing", "review", "test"]);   // being worked right now (a role has it)
export function passesFilter(it) { const s = taskStatusOf(it); return boardFilter === "all" || (boardFilter === "open" ? !TASK_TERMINAL.has(s) : boardFilter === "ongoing" ? TASK_ONGOING.has(s) : s === "done"); }
// Relative times age: a slow re-render while the dock is open (stops itself when it closes).
export function startBoardTicker() { if (!_bdTicker) _bdTicker = setInterval(() => { if (currentDock() !== "board") { stopBoardTicker(); return; } renderBoard(); }, 30000); }
export function stopBoardTicker() { if (_bdTicker) { clearInterval(_bdTicker); _bdTicker = null; } }
// Coalesce a burst of tasks:update events into one re-render.
export function scheduleBoardRender() { if (currentDock() !== "board") return; clearTimeout(_bdRenderTimer); _bdRenderTimer = setTimeout(() => { _bdRenderTimer = null; renderBoard(); }, 60); }
// Pull the board from main (a tab opened before the service answered has the view's copy only), re-render the dock
// when it is open and refresh the composer chip. Never throws — without the service the tab's copy stays.
export async function refreshBoardDock() {
  const ts = activeTS(); if (!ts) return;
  if (hasTasksService("get")) {
    try {
      const r = await atom.tasks.get(ts.meta.id);
      const b = r && typeof r === "object" ? (r.board && typeof r.board === "object" ? r.board : (Array.isArray(r.items) ? r : null)) : null;
      if (b) ts.board = b;
    } catch { /* keep the tab's copy */ }
  }
  if (currentDock() === "board") renderBoard();
  refreshWorkflowChip();
}
// Show the dock (when closed); with a ref, expand that task's set and detail and bring the row into view.
export function openBoard({ ref } = {}) {
  if (currentDock() !== "board") showDock("board");
  if (ref) {
    boardOpenTasks.add(ref);
    const it = boardOf(activeTS()).items.find((i) => taskRef(i) === ref);
    if (it && it.setId != null) boardOpenSets.set(it.setId, true);
    if (it && !passesFilter(it)) boardFilter = "all";
  }
  renderBoard();
  refreshBoardDock().then(() => { if (ref) flashTask(ref); });
}
export function flashTask(ref) {
  const row = document.querySelector(`#boardPanel .bd-task[data-ref="${CSS.escape(ref)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1400);
}

/* ---------------- user actions (atom.tasks) ---------------- */
export async function tasksCall(fn, ...args) {
  if (!hasTasksService(fn)) { toast(TASKS_UNAVAILABLE, "alert"); return null; }
  try { const r = await atom.tasks[fn](...args); refreshBoardDock(); return r === undefined ? true : r; }
  catch (e) { toast(boardErrText(e), "alert"); return null; }
}
export async function addTaskPrompt(ts) {
  if (!ts) return;
  const title = await promptDialog({ title: "Add task", ic: "plus", message: "Added to the active set — when the current set is finished, a new set opens for it.", placeholder: "What needs doing?", confirmLabel: "Add" });
  if (title == null || !title.trim()) return;
  if (await tasksCall("add", ts.meta.id, { titles: [title.trim()] })) toast("Task added", "check");
}
export async function newSetPrompt(ts) {
  if (!ts) return;
  const title = await promptDialog({ title: "New set of tasks", ic: "folderPlus", message: "Closes the current set (its open tasks stay visible) and opens a new one for the next batch of work.", placeholder: "Set title, e.g. Payments", confirmLabel: "Open set" });
  if (title == null || !title.trim()) return;
  if (await tasksCall("newSet", ts.meta.id, title.trim())) toast(`Set “${title.trim()}” opened`, "check");
}
export function setTaskStatus(ts, it, status) { return tasksCall("update", ts.meta.id, taskRef(it), { status }); }
export async function renameTaskPrompt(ts, it) {
  const t = await promptDialog({ title: `Rename ${taskRef(it)}`, ic: "pencil", value: it.title || "", placeholder: "Task title", confirmLabel: "Rename" });
  if (t == null || !t.trim() || t.trim() === it.title) return;
  await tasksCall("update", ts.meta.id, taskRef(it), { title: t.trim() });
}
export async function noteTaskPrompt(ts, it) {
  const t = await promptDialog({ title: `Note on ${taskRef(it)}`, ic: "edit", message: it.title || "", placeholder: "A note for whoever works this task", confirmLabel: "Add note" });
  if (t == null || !t.trim()) return;
  await tasksCall("update", ts.meta.id, taskRef(it), { note: t.trim() });
}
export async function deleteTaskConfirm(ts, it) {
  const yes = await confirmDialog({ title: `Delete ${taskRef(it)}?`, message: `“${it.title || "(untitled)"}” is removed from the board. Prefer Drop to keep a record of a task that is no longer needed.`, confirmLabel: "Delete", danger: true });
  if (!yes) return;
  if (await tasksCall("remove", ts.meta.id, taskRef(it))) { boardOpenTasks.delete(taskRef(it)); toast(`${taskRef(it)} deleted`, "trash"); }
}
// The ⋯ menu: Start · Done · Review · Test · Block · Drop (· Reopen) · Rename · Add note · Delete.
export const TASK_ACTIONS = [
  { status: "doing", label: "Start", icon: "activity" }, { status: "done", label: "Done", icon: "check" }, { status: "review", label: "Review", icon: "eye" },
  { status: "test", label: "Test", icon: "checkCircle" }, { status: "blocked", label: "Block", icon: "alert" }, { status: "dropped", label: "Drop", icon: "x" }, { status: "todo", label: "Reopen", icon: "refresh" },
];
export function taskMenu(ev, ts, it) {
  ev.preventDefault(); ev.stopPropagation();
  const st = taskStatusOf(it);
  const items = [];
  for (const a of TASK_ACTIONS) {
    if (a.status === st) continue;
    if (a.status === "todo" && !TASK_TERMINAL.has(st) && st !== "blocked") continue;
    items.push({ label: a.label, icon: a.icon, onClick: () => setTaskStatus(ts, it, a.status) });
  }
  items.push({ sep: true }, { label: "Rename…", icon: "pencil", onClick: () => renameTaskPrompt(ts, it) }, { label: "Add note…", icon: "edit", onClick: () => noteTaskPrompt(ts, it) },
    { sep: true }, { label: "Delete", icon: "trash", danger: true, onClick: () => deleteTaskConfirm(ts, it) });
  showContextMenu(ev.clientX, ev.clientY, items);
}
export function openJobTabFor(j) {
  if (!j || !j.sessionId) { toast("This job has no session tab", "info"); return; }
  import("../chat/history.js").then((m) => m.openSessionTab(j.sessionId)).catch((e) => toast(boardErrText(e), "alert"));
}

/* ---------------- the dock ---------------- */
export function renderBoard() {
  const panel = $("boardPanel");
  if (!panel || panel.classList.contains("hidden")) return;
  const ts = activeTS();
  const board = boardOf(ts);
  const act = activeSetOf(board);
  const prog = progressOf(act ? itemsOfSet(board, act.id) : board.items);   // the set being worked on, else the whole board
  const listEl = panel.querySelector(".bd-list");
  const scrollTop = listEl ? listEl.scrollTop : 0;
  panel.innerHTML = "";
  panel.append(dockHead("checkCircle", "Task board", prog.total ? `${prog.done} / ${prog.total} done` : "", toggleBoard, [
    h("button", { class: "dock-mini bd-hbtn", title: "New set — close the current set and start a new group of tasks", html: icon("folderPlus", 15), onclick: () => newSetPrompt(ts) }),
    h("button", { class: "dock-mini bd-hbtn", title: "Add a task", html: icon("plus", 15), onclick: () => addTaskPrompt(ts) }),
  ]));
  if (ts) panel.append(boardSummaryEl(ts, board, act, prog));
  panel.append(boardFilterEl());
  const body = h("div", { class: "bd-list" });
  if (!ts) body.append(h("div", { class: "dock-empty", text: "Open a conversation to see its task board." }));
  else if (!board.items.length && !board.sets.length) body.append(boardEmptyEl());
  else for (const g of boardGroups(board)) body.append(setGroupEl(ts, board, g));
  panel.append(body);
  body.scrollTop = scrollTop;
  startBoardTicker();
}
export function boardSummaryEl(ts, board, act, prog) {
  const bits = [];
  // Ongoing (a role has it) and remaining (still to pick up) are what the user follows live (2026-09-17).
  const items = act ? itemsOfSet(board, act.id) : board.items;
  const ongoing = items.filter((i) => TASK_ONGOING.has(taskStatusOf(i))).length, remaining = items.filter((i) => ["todo", "blocked"].includes(taskStatusOf(i))).length;
  if (prog.total) { if (ongoing) bits.push(`${ongoing} ongoing`); if (remaining) bits.push(`${remaining} remaining`); bits.push(`${prog.done} done`); if (prog.dropped) bits.push(`${prog.dropped} dropped`); }
  if (board.sets.length > 1) bits.push(`${board.sets.length} sets`);
  return h("div", { class: "bd-summary" },
    h("div", { class: "bd-sum-line" },
      h("span", { class: "bd-session", title: ts.meta.cwd || "", text: ts.meta.name || "Session" }),
      h("span", { class: "bd-sum-set", text: act ? setLabel(act) : (board.sets.length ? "All sets" : "") })),
    progressBarEl(prog, "bd-bar"),
    h("div", { class: "bd-sum-nums", text: bits.join(" · ") || "No tasks yet" }));
}
export function progressBarEl(p, cls) {
  return h("div", { class: cls, role: "progressbar", "aria-valuenow": String(Math.round(p.pctDone)), "aria-valuemin": "0", "aria-valuemax": "100", title: `${p.done} of ${p.total} done${p.dropped ? `, ${p.dropped} dropped` : ""}` },
    h("i", { class: "done", style: `width:${p.pctDone.toFixed(1)}%` }),
    h("i", { class: "dropped", style: `width:${p.pctDropped.toFixed(1)}%` }));
}
export function boardFilterEl() {
  const seg = h("div", { class: "bd-seg", role: "tablist" });
  for (const [id, label] of [["all", "All"], ["ongoing", "Ongoing"], ["open", "Open"], ["done", "Done"]]) seg.append(h("button", { class: "bd-seg-btn" + (boardFilter === id ? " active" : ""), text: label, onclick: () => { boardFilter = id; renderBoard(); } }));
  return h("div", { class: "bd-filter" }, seg);
}
export function boardEmptyEl() {
  return h("div", { class: "dock-empty bd-empty" },
    h("div", {}, "No tasks yet — the Orchestrator creates them with ", h("code", { text: "atomnano tasks add …" }), ", or add one here."),
    h("button", { class: "bd-empty-add", onclick: () => addTaskPrompt(activeTS()) }, h("span", { html: icon("plus", 13) }), h("span", { text: "Add task" })));
}
// One set: a head line ("Set 1 · Payments · 20 tasks · done ✓", click to expand) and, when open, its task rows.
export function setGroupEl(ts, board, { set, items }) {
  const open = isSetOpen(board, set);
  const st = set ? String(set.status || "active").toLowerCase() : "loose";
  const p = progressOf(items);
  const sum = st === "active" ? `${p.done} / ${p.total}` : `${p.total} task${p.total === 1 ? "" : "s"}`;
  const g = h("div", { class: `bd-set st-${st}` + (open ? " open" : ""), dataset: { set: set ? String(set.id) : "" } });
  g.append(h("div", { class: "bd-set-head", title: open ? "Collapse this set" : "Expand this set", onclick: () => { if (set) boardOpenSets.set(set.id, !open); renderBoard(); } },
    h("span", { class: "bd-set-chev", html: icon(open ? "chevronDown" : "chevronRight", 13) }),
    h("span", { class: "bd-set-n", text: set ? `Set ${set.n}` : "Tasks" }),
    set && set.title && set.title !== `Set ${set.n}` ? h("span", { class: "bd-set-title", text: set.title }) : null,
    h("span", { class: "bd-set-sum", text: sum }),
    set ? h("span", { class: `bd-set-tag st-${st}`, html: st === "done" ? `done ${icon("check", 10)}` : st }) : null));
  if (open) {
    const body = h("div", { class: "bd-set-body" });
    const shown = items.filter(passesFilter).sort((a, b) => (+a.n || 0) - (+b.n || 0));
    if (!shown.length) body.append(h("div", { class: "bd-none", text: items.length ? (boardFilter === "open" ? "No open tasks in this set." : boardFilter === "ongoing" ? "Nothing is being worked on in this set right now." : "No finished tasks in this set.") : "No tasks in this set yet." }));
    for (const it of shown) body.append(taskRowEl(ts, it));
    g.append(body);
  }
  return g;
}
export function taskStatusChip(st) {
  return h("span", { class: `bd-status st-${st}`, title: TASK_STATUS_TITLE[st] },
    st === "doing" ? h("i", { class: "bd-dot" }) : st === "done" ? h("span", { class: "bd-st-ic", html: icon("check", 10) }) : null,
    h("span", { text: st }));
}
export function taskTimeEl(it) {
  const doneAt = taskStatusOf(it) === "done" ? boardMs(it.doneTs) : 0;
  const at = doneAt || boardMs(it.updatedTs) || boardMs(it.createdTs);
  if (!at) return null;
  return h("span", { class: "bd-time", title: `${doneAt ? "Done" : "Updated"} ${new Date(at).toLocaleString()}`, text: `${doneAt ? "done " : ""}${timeAgo(at)}` });
}
// One task: T-number badge · title · ⋯, then status chip · role chip · live jobs · time; the detail when expanded.
export function taskRowEl(ts, it) {
  const st = taskStatusOf(it), ref = taskRef(it), open = boardOpenTasks.has(ref);
  const role = it.role ? String(it.role).toLowerCase() : "";
  const jobs = linkedJobs(it);
  const row = h("div", { class: `bd-task st-${st}` + (open ? " open" : ""), dataset: { ref, status: st } });
  row.append(h("div", { class: "bd-task-row1", onclick: (e) => { if (e.target.closest("button")) return; if (open) boardOpenTasks.delete(ref); else boardOpenTasks.add(ref); renderBoard(); }, oncontextmenu: (e) => taskMenu(e, ts, it) },
    h("span", { class: "bd-badge", text: ref }),
    h("span", { class: "bd-title", text: it.title || "(untitled)" }),
    h("button", { class: "bd-menu", title: "Task actions", html: icon("moreVert", 15), onclick: (e) => taskMenu(e, ts, it) })));
  row.append(h("div", { class: "bd-task-row2" },
    taskStatusChip(st),
    role ? h("span", { class: `bd-role role-${role}`, title: `${roleMeta(role).name}'s task` }, h("span", { html: icon(roleMeta(role).icon, 10) }), h("span", { text: role })) : null,
    jobs.live ? h("span", { class: "bd-jobs-live", title: `${jobs.live} job${jobs.live === 1 ? "" : "s"} running on this task` }, h("span", { class: "ag-orbit sm", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("span", { text: String(jobs.live) }))
      : (jobs.all.length ? h("span", { class: "bd-jobs-n", text: `${jobs.all.length} job${jobs.all.length === 1 ? "" : "s"}` }) : null),
    h("span", { class: "spacer" }),
    taskTimeEl(it)));
  if (open) row.append(taskDetailEl(ts, it, jobs));
  return row;
}
export function taskDetailEl(ts, it, jobs) {
  const det = h("div", { class: "bd-detail" });
  if (it.detail) det.append(h("div", { class: "bd-det-text", text: it.detail }));
  const notes = Array.isArray(it.notes) ? it.notes.filter((n) => n && n.text) : [];
  if (notes.length) det.append(h("div", { class: "bd-det-label", text: "Notes" }), h("div", { class: "bd-notes" }, ...notes.slice(-8).map((n) => h("div", { class: "bd-note" },
    h("span", { class: "bd-note-by", text: n.by || "" }),
    n.ts ? h("span", { class: "bd-note-time", title: new Date(boardMs(n.ts)).toLocaleString(), text: timeAgo(boardMs(n.ts)) }) : null,
    h("span", { class: "bd-note-text", text: n.text })))));
  if (jobs.all.length) det.append(h("div", { class: "bd-det-label", text: "Jobs" }), h("div", { class: "bd-jobs" }, ...jobs.all.map((j) => jobChipEl(j))));
  const meta = [];
  if (it.createdTs) meta.push(`created ${timeAgo(boardMs(it.createdTs))}`);
  if (it.updatedTs) meta.push(`updated ${timeAgo(boardMs(it.updatedTs))}`);
  if (it.doneTs) meta.push(`done ${new Date(boardMs(it.doneTs)).toLocaleTimeString()}`);
  if (meta.length) det.append(h("div", { class: "bd-det-meta", text: meta.join(" · ") }));
  if (!it.detail && !notes.length && !jobs.all.length) det.append(h("div", { class: "bd-det-none", text: "No detail, notes or jobs yet." }));
  return det;
}
export function jobChipEl(j) {
  const st = String(j.status || "unknown").toLowerCase();
  const role = j.role ? roleMeta(j.role).name : "Job";
  const label = st === "running" ? "running" : st === "queued" ? "queued" : st === "done" ? "done" : st === "error" ? "failed" : st === "stopped" ? "stopped" : "—";
  return h("button", { class: `bd-job st-${st}`, title: j.task ? `${role}: ${j.task}` : `${role} job ${j.id}`, onclick: (e) => { e.stopPropagation(); openJobTabFor(j); } },
    h("span", { class: "bd-job-role", text: role.toLowerCase() }), h("span", { class: "bd-job-st", text: label }));
}
// Automation hook (Playwright sets navigator.webdriver, like app.js's __* hooks): smoke-tests/test-task-board.js opens the dock through it.
if (typeof navigator !== "undefined" && navigator.webdriver) window.__toggleBoard = toggleBoard;
export { toggleBoard };
