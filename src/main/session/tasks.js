"use strict";
/* Task board — the orchestrator session's ONE board of tasks, grouped into SETS. Contract: docs/WORKFLOW_CONTRACT.md §8.
 *
 * Agents (the orchestrator through the `atomnano tasks` CLI, the user through the Board dock) create the tasks
 * first, then update each one as it is done; a task can be handed to a role by starting a job with
 * `--task T3` (startRoleJob → linkJobToTask). Tasks are numbered session-wide (T1, T2 …) and live in
 * sets: exactly one set is "active" at a time (or none). When every task of the active set is finished
 * and new tasks arrive, they open a NEW set ("a new set of tasks"); an explicit `--set "<title>"` opens a
 * new set at once and leaves the previous one "done" (everything terminal) or "closed" (work still open).
 *
 * Storage: `session.tasks = { seq, setSeq, sets, items }` on the ORCHESTRATOR session (persisted by
 * store.normalizeSession, which also cleans a legacy / malformed shape; copied by synthesize). A child
 * job session (parentId) addresses its orchestrator's board, so `atomnano tasks done T3` from inside a coder
 * job updates the one board. The board is bounded to 400 items / 60 sets — the oldest DONE sets go first.
 *
 * Every change: the session is scheduled for write, `tasks:update { sessionId, board }` is broadcast with
 * the WHOLE board (boardFor), and the orchestrator's chat card for the set — one `role: "tasks"` card per SET,
 * `{ id, role: "tasks", setId, text: set.title, ts, meta: { setN, title, status, items: [{ n, title, status,
 * role }] } }` — is added or patched with its FULL meta (session:message-update). The card is app-side:
 * history.isHistoryMessage does not know the role, so it is never part of the model-visible record.
 *
 * STANDING RULE: nothing here adds hidden prompt layers. The only model-visible texts are the explicit
 * §8.2 paragraph of the orchestrator brief (workflow.js), the labelled task line a child job started with
 * `--task` receives after its task text, and the board summary inside a synthesize seed. */
const store = require("../storage/store");

const STATUSES = ["todo", "doing", "review", "test", "done", "blocked", "dropped"];
const TERMINAL = new Set(["done", "dropped"]);
const STATUS_ALIAS = { todo: "todo", open: "todo", reopen: "todo", start: "doing", started: "doing", doing: "doing", review: "review", reviewing: "review", test: "test", testing: "test", done: "done", finish: "done", finished: "done", complete: "done", completed: "done", block: "blocked", blocked: "blocked", drop: "dropped", dropped: "dropped", cancel: "dropped", cancelled: "dropped" };
const ROLE_ALIAS = { orchestrator: "orchestrator", primary: "orchestrator", planner: "planner", plan: "planner", coder: "coder", code: "coder", reviewer: "reviewer", review: "reviewer", tester: "tester", test: "tester" };
const JOB_STATUS = { planner: "doing", coder: "doing", reviewer: "review", tester: "test" };   // what a role's job means for the task it works on
const DEFAULT_BY = "orchestrator";   // who acts when nobody is named: the CLI is the orchestrator's hands (the planner's before 2026-09-17)
const MAX_ITEMS = 400;
const MAX_SETS = 60;
const SUMMARY_CHARS = 3000;   // boardSummaryText never grows past this (the synthesize seed keeps its own budget)

const emptyBoard = () => ({ seq: 0, setSeq: 0, sets: [], items: [] });
const copySet = (s) => ({ ...s });
const copyItem = (i) => ({ ...i, jobIds: (i.jobIds || []).slice(), notes: (i.notes || []).map((n) => ({ ...n })) });
const oneLine = (s, max) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length <= max ? s : s.slice(0, max - 1).replace(/[\s,;:]+\S*$/, "") + "…"; };
function countsOf(items) {
  let total = 0, open = 0, done = 0;
  for (const i of items) { total++; if (i.status === "done") done++; else if (!TERMINAL.has(i.status)) open++; }
  return { total, open, done };
}
const itemsOf = (board, set) => board.items.filter((i) => i.setId === set.id);
// "every item terminal" — an EMPTY set does not count (a freshly opened set must receive the next tasks).
const allTerminal = (board, set) => { const mine = itemsOf(board, set); return mine.length > 0 && mine.every((i) => TERMINAL.has(i.status)); };
const activeSet = (board) => board.sets.find((s) => s.status === "active") || null;

// A status word → the contract's status (a few plain aliases: start → doing, block → blocked, drop → dropped …).
function statusOf(v) {
  const st = STATUS_ALIAS[String(v === undefined || v === null ? "" : v).trim().toLowerCase()];
  if (!st) throw new Error(`Unknown task status "${v}". Statuses: ${STATUSES.join(", ")}.`);
  return st;
}
// A role word → orchestrator | planner | coder | reviewer | tester; empty → null (no role).
function roleOf(v) {
  if (v === undefined || v === null || v === "") return null;
  const r = ROLE_ALIAS[String(v).trim().toLowerCase()];
  if (!r) throw new Error(`Unknown role "${v}". Roles: orchestrator, planner, coder, reviewer, tester.`);
  return r;
}
// A task by reference: "T12" / "t12" / 12 / "12" (its number) or its id; an item-like object by id / n.
function findTask(board, ref) {
  if (ref === undefined || ref === null || ref === "") return null;
  if (typeof ref === "object") ref = ref.id || ref.n;
  const s = String(ref).trim();
  const m = /^[Tt]?(\d+)$/.exec(s);
  if (m) { const byN = board.items.find((i) => i.n === +m[1]); if (byN) return byN; }
  return board.items.find((i) => i.id === s) || null;
}
const refText = (ref) => (ref && typeof ref === "object" ? String(ref.id || ref.n || "") : String(ref));
// Is this text nothing but a task reference ("T3")? Used by startRoleJob: `atomnano run coder T3`.
const isBareRef = (s) => /^[Tt]\d+$/.test(String(s || "").trim());

/* Keep the board within its bounds. Order: the oldest DONE sets (every item terminal) with their items,
 * then the oldest other finished sets, then — only when the active set alone is over the limit — its
 * oldest terminal items, then its oldest items. The active set itself is never removed. */
function pruneBoard(board) {
  const active = activeSet(board);
  const over = () => board.items.length > MAX_ITEMS || board.sets.length > MAX_SETS;
  const dropSet = (set) => { board.sets = board.sets.filter((s) => s !== set); board.items = board.items.filter((i) => i.setId !== set.id); };
  while (over()) { const s = board.sets.find((x) => x !== active && x.status === "done"); if (!s) break; dropSet(s); }
  while (over()) { const s = board.sets.find((x) => x !== active); if (!s) break; dropSet(s); }
  if (board.items.length > MAX_ITEMS) {
    const drop = new Set();
    for (const i of board.items) { if (board.items.length - drop.size <= MAX_ITEMS) break; if (TERMINAL.has(i.status)) drop.add(i.id); }
    for (const i of board.items) { if (board.items.length - drop.size <= MAX_ITEMS) break; drop.add(i.id); }
    board.items = board.items.filter((i) => !drop.has(i.id));
  }
}

const methods = {
  /* ------------------------------ resolution ------------------------------ */
  // The session that OWNS the board: a child job session addresses its planner's (root) board.
  _taskOwner(session) {
    let s = session;
    for (let hop = 0; hop < 8 && s && s.parentId; hop++) { const p = store.getSession(s.parentId); if (!p) break; s = p; }
    return s;
  },
  // A session id or object → the owning session; a plain Error when it does not exist.
  _taskSession(sessionId) {
    const s = sessionId && typeof sessionId === "object" ? sessionId : store.getSession(sessionId);
    if (!s) throw new Error("The session was not found.");
    return this._taskOwner(s);
  },
  // The LIVE board object of a session (normalised in place when the shape is not the contract's).
  _board(session) {
    const t = session.tasks;
    if (!t || typeof t !== "object" || Array.isArray(t) || !Array.isArray(t.sets) || !Array.isArray(t.items) || !Number.isFinite(+t.seq) || !Number.isFinite(+t.setSeq)) {
      session.tasks = typeof store.normalizeTasks === "function" ? store.normalizeTasks(t) : emptyBoard();
    }
    return session.tasks;
  },

  /* ------------------------------ reading ------------------------------ */
  // The board as the renderer / CLI see it — a copy, plus the active set id and the counts. Never throws.
  boardFor(session) {
    try {
      const s = session && typeof session === "object" ? session : store.getSession(session);
      const owner = s ? this._taskOwner(s) : null;
      const t = owner ? this._board(owner) : emptyBoard();
      const active = activeSet(t);
      return { seq: t.seq, setSeq: t.setSeq, sets: t.sets.map(copySet), items: t.items.map(copyItem), active: active ? active.id : null, counts: countsOf(t.items) };
    } catch { return { ...emptyBoard(), active: null, counts: { total: 0, open: 0, done: 0 } }; }
  },
  taskInfo(sessionId, ref) {
    const s = sessionId && typeof sessionId === "object" ? sessionId : store.getSession(sessionId);
    if (!s) return null;
    const item = findTask(this._board(this._taskOwner(s)), ref);
    return item ? copyItem(item) : null;
  },
  /* The board as one or two lines of plain facts (for briefs and the synthesize session map), bounded to
   * SUMMARY_CHARS. Line 1: the active set (else the latest one) with its counts and its items —
   *   Task board — Set 2 “Payments” (3 of 8 done): T9 doing coder “Wire the webhook” · T10 todo “Retries” · …
   * (`openOnly` lists only the unfinished items). Line 2: every other set with its counts, newest first. */
  boardSummaryText(session, { openOnly = false } = {}) {
    const b = this.boardFor(session);
    if (!b.sets.length) return "";
    const q = (s) => `“${oneLine(s, 60)}”`;
    const items = (set) => b.items.filter((i) => i.setId === set.id);
    const label = (set) => { const c = countsOf(items(set)); return `Set ${set.n} ${q(set.title)} (${c.done} of ${c.total} done)`; };
    const active = b.active ? b.sets.find((s) => s.id === b.active) : null;
    const shown = active || b.sets[b.sets.length - 1];
    const list = items(shown).filter((i) => !openOnly || !TERMINAL.has(i.status));
    let line = `Task board — ${active ? "" : `every set is finished; the latest is `}${label(shown)}: `;
    const lineMax = Math.floor(SUMMARY_CHARS * 0.72);
    let n = 0;
    for (const i of list) {
      const t = `T${i.n} ${i.status}${i.role ? " " + i.role : ""} ${q(i.title)}`;
      if (line.length + t.length + 3 > lineMax) break;
      line += (n ? " · " : "") + t; n++;
    }
    if (!n) line += list.length ? `… ${list.length} tasks` : openOnly ? "no open tasks" : "no tasks yet";
    else if (n < list.length) line += ` · … ${list.length - n} more`;
    const others = b.sets.filter((s) => s !== shown).reverse();
    if (!others.length) return line;
    let line2 = "Other sets: ", k = 0;
    for (const s of others) {
      const t = `${label(s)} ${s.status}`;
      if (line.length + 1 + line2.length + t.length + 3 > SUMMARY_CHARS) break;
      line2 += (k ? " · " : "") + t; k++;
    }
    if (k < others.length) line2 += `${k ? " · " : ""}… ${others.length - k} more set${others.length - k === 1 ? "" : "s"}`;
    return line + "\n" + line2;
  },

  /* ------------------------------ cards + events ------------------------------ */
  // The card's meta — always the WHOLE object (the renderer applies a patch with Object.assign on m.meta).
  _taskCardMeta(board, set) {
    return { setN: set.n, title: set.title, status: set.status, items: itemsOf(board, set).map((i) => ({ n: i.n, title: i.title, status: i.status, role: i.role })) };
  },
  // One `role: "tasks"` card per SET in the planner's chat (app-side, not part of the model-visible record).
  _taskCard(session, board, set) {
    const card = { id: store.uid(), role: "tasks", setId: set.id, text: set.title, ts: store.nowISO(), meta: this._taskCardMeta(board, set) };
    this.addMessage(session, card);
    return card;
  },
  _taskCardPatch(session, board, set) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m && m.role === "tasks" && m.setId === set.id) { this.updateMessage(session, m.id, { meta: this._taskCardMeta(board, set) }); return; }
    }
  },
  // After any change: persist and broadcast the whole board.
  _taskEmit(session) {
    store.scheduleWrite(session.id);
    this.send("tasks:update", { sessionId: session.id, board: this.boardFor(session) });
  },

  /* ------------------------------ sets ------------------------------ */
  // Close a set that stops being active: "done" when nothing in it is open (an empty set too), else "closed".
  _closeSet(board, set) {
    set.status = itemsOf(board, set).some((i) => !TERMINAL.has(i.status)) ? "closed" : "done";
    set.closedTs = store.nowISO();
  },
  _newSet(board, title, by) {
    const set = { id: store.uid(), n: ++board.setSeq, title: String(title || "").trim() || `Set ${board.setSeq}`, status: "active", createdTs: store.nowISO(), closedTs: null, by: String(by || DEFAULT_BY) };
    board.sets.push(set);
    return set;
  },
  /* A set's status after one of its items changed: the active set becomes "done" when its last open item
   * finishes (it stays visible); a finished set with open work again resumes as the active set when no
   * other set is active (else it is "closed"); a finished set whose last open item finishes is "done". */
  _settleSet(board, set) {
    const mine = itemsOf(board, set);
    const open = mine.some((i) => !TERMINAL.has(i.status));
    if (set.status === "active") { if (mine.length && !open) { set.status = "done"; set.closedTs = store.nowISO(); } return; }
    if (!open) { set.status = "done"; return; }
    if (!activeSet(board)) { set.status = "active"; set.closedTs = null; } else set.status = "closed";
  },
  // An explicit new set (closes the current active one). Empty title → "Set <n>".
  openTaskSet(sessionId, title, { by = DEFAULT_BY } = {}) {
    const session = this._taskSession(sessionId);
    const board = this._board(session);
    const cur = activeSet(board);
    if (cur) { this._closeSet(board, cur); this._taskCardPatch(session, board, cur); }
    const set = this._newSet(board, title, by);
    pruneBoard(board);
    this._taskCard(session, board, set);
    this._taskEmit(session);
    return copySet(set);
  },

  /* ------------------------------ items ------------------------------ */
  /* Add tasks. `titles` (strings) and/or `items` ({ title, detail?, role? }); `role` / `detail` given at
   * the top level apply to every title. Set rule: `set.title` (or a string `set`) → close the current
   * active set and open a new one with that title; no active set, or every item of it terminal → a new
   * set titled "Set <n>"; else append to the active set. Returns copies of the set and the NEW items. */
  addTasks(sessionId, { titles, items, set, role, detail } = {}, { by = DEFAULT_BY } = {}) {
    const session = this._taskSession(sessionId);
    const board = this._board(session);
    const dRole = roleOf(role), dDetail = typeof detail === "string" ? detail.trim() : "";
    const entries = [];
    for (const t of Array.isArray(titles) ? titles : (typeof titles === "string" ? [titles] : [])) { const s = String(t || "").trim(); if (s) entries.push({ title: s, detail: dDetail, role: dRole }); }
    for (const it of Array.isArray(items) ? items : []) {
      if (typeof it === "string") { const s = it.trim(); if (s) entries.push({ title: s, detail: dDetail, role: dRole }); continue; }
      if (!it || typeof it !== "object") continue;
      const s = String(it.title || "").trim(); if (!s) continue;
      entries.push({ title: s, detail: typeof it.detail === "string" ? it.detail.trim() : dDetail, role: it.role === undefined ? dRole : roleOf(it.role) });
    }
    if (!entries.length) throw new Error("At least one task title is required.");
    const setTitle = typeof set === "string" ? set.trim() : (set && typeof set === "object" && typeof set.title === "string") ? set.title.trim() : "";
    let target = activeSet(board), created = false;
    if (setTitle || !target || allTerminal(board, target)) {
      if (target) { this._closeSet(board, target); this._taskCardPatch(session, board, target); }
      target = this._newSet(board, setTitle, by); created = true;
    }
    const now = store.nowISO(), added = [];
    for (const e of entries) {
      const item = { id: store.uid(), n: ++board.seq, setId: target.id, title: e.title, detail: e.detail, status: "todo", role: e.role, jobIds: [], notes: [], createdTs: now, updatedTs: now, doneTs: null };
      board.items.push(item); added.push(item);
    }
    pruneBoard(board);
    if (created) this._taskCard(session, board, target); else this._taskCardPatch(session, board, target);
    this._taskEmit(session);
    const kept = new Set(board.items.map((i) => i.id));
    return { set: copySet(target), items: added.filter((i) => kept.has(i.id)).map(copyItem) };
  },
  /* Update one task: status (any of the contract's; done → doneTs), role, title, detail, a note appended
   * as { ts, by, text }. Validated before anything changes; a plain Error for an unknown ref / bad value. */
  updateTask(sessionId, ref, patch = {}, { by = DEFAULT_BY } = {}) {
    const session = this._taskSession(sessionId);
    const board = this._board(session);
    const item = findTask(board, ref);
    if (!item) throw new Error(`No task "${refText(ref)}" on this board.`);
    const p = patch && typeof patch === "object" ? patch : {};
    const status = p.status === undefined || p.status === null || p.status === "" ? null : statusOf(p.status);
    const role = p.role === undefined ? undefined : roleOf(p.role);
    const title = p.title === undefined ? undefined : String(p.title || "").trim();
    if (title === "") throw new Error("A task title cannot be empty.");
    const now = store.nowISO();
    if (status && status !== item.status) { item.status = status; item.doneTs = status === "done" ? now : null; }
    if (role !== undefined) item.role = role;
    if (title !== undefined) item.title = title;
    if (p.detail !== undefined) item.detail = p.detail === null ? "" : String(p.detail).trim();
    if (typeof p.note === "string" && p.note.trim()) item.notes.push({ ts: now, by: String(by || DEFAULT_BY), text: p.note.trim() });
    item.updatedTs = now;
    const set = board.sets.find((s) => s.id === item.setId);
    if (set) { this._settleSet(board, set); this._taskCardPatch(session, board, set); }
    this._taskEmit(session);
    return copyItem(item);
  },
  // User-only (the Board dock): remove a task. Its set settles (an emptied finished set is "done").
  removeTask(sessionId, ref) {
    const session = this._taskSession(sessionId);
    const board = this._board(session);
    const item = findTask(board, ref);
    if (!item) throw new Error(`No task "${refText(ref)}" on this board.`);
    board.items = board.items.filter((i) => i !== item);
    const set = board.sets.find((s) => s.id === item.setId);
    if (set) { this._settleSet(board, set); this._taskCardPatch(session, board, set); }
    this._taskEmit(session);
    return true;
  },

  /* ------------------------------ jobs ------------------------------ */
  /* Link a job to a task (startRoleJob({ …, taskRef }) → here, before the run starts): job.taskId / taskN,
   * item.jobIds += job.id, the role recorded on the task and — unless the task is already finished — its
   * status follows the role: doing (planner, coder) / review (reviewer) / test (tester). Returns the item. */
  linkJobToTask(job, ref) {
    if (!job || !job.id) throw new Error("A job is required to link a task.");
    const session = this._taskSession(job.parentId);
    const board = this._board(session);
    const item = findTask(board, ref);
    if (!item) throw new Error(`No task "${refText(ref)}" on this board.`);
    const live = (this._jobs && this._jobs.get(job.id)) || job;
    for (const j of new Set([job, live])) { j.taskId = item.id; j.taskN = item.n; }
    if (!item.jobIds.includes(job.id)) item.jobIds.push(job.id);
    const role = ROLE_ALIAS[String(job.role || "").trim().toLowerCase()] || null;
    if (role && JOB_STATUS[role]) { item.role = role; if (!TERMINAL.has(item.status)) item.status = JOB_STATUS[role]; }
    item.updatedTs = store.nowISO();
    const set = board.sets.find((s) => s.id === item.setId);
    if (set) this._taskCardPatch(session, board, set);
    this._taskEmit(session);
    return copyItem(item);
  },
  // _jobEnd's hook: the note "<role> job <id> <status>" on the task (its status is left as it is).
  _taskJobEnded(job) {
    if (!job || !job.taskId) return;
    const session = store.getSession(job.parentId);
    if (!session) return;
    const board = this._board(session);
    const item = board.items.find((i) => i.id === job.taskId);
    if (!item) return;
    const now = store.nowISO();
    item.notes.push({ ts: now, by: String(job.role || "app"), text: `${job.role} job ${job.id} ${job.status}` });
    item.updatedTs = now;
    const set = board.sets.find((s) => s.id === item.setId);
    if (set) this._taskCardPatch(session, board, set);
    this._taskEmit(session);
  },
};

module.exports = { methods, STATUSES, TERMINAL, MAX_ITEMS, MAX_SETS, isBareRef };
