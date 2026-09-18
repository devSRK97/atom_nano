"use strict";
/* IPC: tasks:* — the orchestrator session's TASK BOARD for the renderer (docs/WORKFLOW_CONTRACT.md §8.3):
 * read the board, add tasks, patch one (status / role / title / detail / note), open a new set, remove a
 * task. Every mutation here is a USER action (`by: "user"`); the CLI's calls arrive through the control
 * server with `by: "orchestrator"` (or the calling child's role). The methods are the session manager's tasks
 * mixin (§8.1: boardFor · addTasks · updateTask · openTaskSet · removeTask); that mixin broadcasts
 * `tasks:update { sessionId, board }` after any change — the replies below carry the fresh board too, so
 * the dock can redraw at once. The board belongs to the ORCHESTRATOR: a role child's id resolves to its parent.
 * Test seam: ctx may carry { store, manager } fakes — the real singletons are required lazily otherwise. */

const str = (v) => (v == null ? "" : String(v));
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// "T12" · "t12" · "#12" · "12" → "T12"; anything else is an item id.
function taskRef(v) { const s = str(v).trim(); const m = /^#?[tT]?(\d+)$/.exec(s); return m ? "T" + parseInt(m[1], 10) : s; }

// { titles | title | items | set } from the renderer → the manager's addTasks request (only the keys given).
function addRequest(req) {
  const r = isObj(req) ? req : {};
  const out = {};
  const titles = Array.isArray(r.titles) ? r.titles.map((t) => str(t).trim()).filter(Boolean) : str(r.titles || r.title).trim() ? [str(r.titles || r.title).trim()] : [];
  const items = (Array.isArray(r.items) ? r.items : []).map((it) => {
    if (typeof it === "string") return { title: it.trim() };
    if (!isObj(it)) return null;
    const o = { title: str(it.title).trim() };
    if (str(it.detail).trim()) o.detail = str(it.detail);
    if (str(it.role).trim()) o.role = str(it.role).trim().toLowerCase();
    return o;
  }).filter((it) => it && it.title);
  if (titles.length) out.titles = titles;
  if (items.length) out.items = items;
  if (!titles.length && !items.length) throw new Error("A task title is required");
  const setTitle = isObj(r.set) ? str(r.set.title).trim() : str(r.set).trim();
  if (setTitle) out.set = { title: setTitle };
  return out;
}

function register(ctx) {
  const { handle } = ctx;
  const store = ctx.store || require("../storage/store");
  const manager = ctx.manager || require("../session/index");
  const BY = { by: "user" };
  const need = (name) => { if (typeof manager[name] !== "function") throw new Error("The task board is not available in this build"); return manager[name].bind(manager); };
  // The FULL record of the board's owner: the session itself, or the orchestrator of a role child.
  const ownerOf = (sessionId) => {
    if (!sessionId) throw new Error("A session is required");
    let s = store.getSession(sessionId);
    if (!s) throw new Error("Session not found");
    if (s.role && s.parentId) { const p = store.getSession(s.parentId); if (p) s = p; }
    return s;
  };
  const boardOf = (s) => need("boardFor")(store.getSession(s.id) || s);

  handle("tasks:get", async (_e, sessionId) => { const s = ownerOf(sessionId); return { board: boardOf(s), sessionId: s.id }; });
  handle("tasks:add", async (_e, sessionId, req) => {
    const s = ownerOf(sessionId);
    const out = await need("addTasks")(s.id, addRequest(req), BY);
    return { set: (out && out.set) || null, items: out && Array.isArray(out.items) ? out.items : [], board: boardOf(s), sessionId: s.id };
  });
  handle("tasks:update", async (_e, sessionId, ref, patch) => {
    const s = ownerOf(sessionId);
    const p = isObj(patch) ? patch : {};
    const body = {};
    for (const k of ["status", "role", "title", "detail", "note"]) if (p[k] !== undefined) body[k] = k === "role" ? (str(p[k]).trim().toLowerCase() || null) : p[k];
    if (!Object.keys(body).length) throw new Error("Nothing to update — pass status, role, title, detail or note");
    const item = await need("updateTask")(s.id, taskRef(ref), body, BY);
    return { item, board: boardOf(s), sessionId: s.id };
  });
  handle("tasks:new-set", async (_e, sessionId, title) => {
    const s = ownerOf(sessionId);
    const t = str(title).trim();
    if (!t) throw new Error("A title for the new set is required");
    const set = await need("openTaskSet")(s.id, t, BY);
    return { set, board: boardOf(s), sessionId: s.id };
  });
  handle("tasks:remove", async (_e, sessionId, ref) => {
    const s = ownerOf(sessionId);
    const ok = await need("removeTask")(s.id, taskRef(ref));
    return { ok: ok !== false, board: boardOf(s), sessionId: s.id };
  });
}

module.exports = { register, addRequest, taskRef };
