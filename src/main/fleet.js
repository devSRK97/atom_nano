"use strict";
/* FLEET — dispatch many background agents against a queue, safely.
 *
 * You enqueue tasks; a scheduler runs up to N concurrently, each as its own
 * background session (openable as a tab to watch). The hard problem with several
 * agents in ONE working tree is two of them editing the same file at once — so:
 *
 *   FileLockManager: the first time an agent edits a file, that file is CLAIMED
 *   for its task. If another running agent tries to edit a claimed file, the
 *   edit is DENIED at the permission layer with a message telling it to work
 *   elsewhere and come back — "self-determining" conflict avoidance. Each agent
 *   is also told up-front who is in the workspace and which files are held.
 *
 * The runner is injectable so the queue/scheduler/locks can be tested without a
 * live model. Tasks persist to userData/fleet.json; anything left "running" when
 * the app died is marked interrupted on next boot.
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const store = require("./store");

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update", "create_file", "str_replace"]);
const fileOf = () => path.join(app.getPath("userData"), "fleet.json");
const now = () => Date.now();
const normFile = (f) => String(f || "").replace(/\\/g, "/").toLowerCase();
const rel = (p, cwd) => {
  const a = (p || "").replace(/\\/g, "/"), b = (cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return a.toLowerCase().startsWith(b.toLowerCase() + "/") ? a.slice(b.length + 1) : a;
};

// ---- file claims shared across all running fleet agents ----
class FileLockManager {
  constructor() { this.byFile = new Map(); this.label = new Map(); }
  name(taskId, label) { this.label.set(taskId, label); }
  tryClaim(taskId, file) {
    const f = normFile(file);
    const cur = this.byFile.get(f);
    if (!cur || cur === taskId) { this.byFile.set(f, taskId); return { ok: true }; }
    return { ok: false, holder: cur, holderName: this.label.get(cur) || "another agent" };
  }
  filesOf(taskId) { return [...this.byFile.entries()].filter(([, t]) => t === taskId).map(([f]) => f); }
  heldByOthers(taskId) { return [...this.byFile.entries()].filter(([, t]) => t !== taskId).map(([f, t]) => ({ file: f, holder: this.label.get(t) || "agent" })); }
  releaseAll(taskId) { for (const [f, t] of [...this.byFile]) if (t === taskId) this.byFile.delete(f); }
}

class Fleet {
  constructor() {
    this.tasks = new Map();      // id -> task
    this.locks = new FileLockManager();
    this.emit = () => {};
    this.runner = null;          // (sessionId, opts) => Promise ; defaults to claude.run
    this.saveTimer = null;
    this._loaded = false;
  }

  configure({ emit, runner } = {}) {
    if (emit) this.emit = emit;
    if (runner) this.runner = runner;
    this.load();
  }
  _runner() { return this.runner || ((sid, opts) => require("./claude").run(sid, opts)); }
  maxConcurrent() {
    const n = +(store.getSettings().fleetMaxConcurrent);
    if (n >= 1 && n <= 8) return Math.floor(n);
    const cores = (os.cpus() || []).length || 4;
    return Math.max(1, Math.min(4, cores - 2));
  }

  load() {
    if (this._loaded) return;
    this._loaded = true;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(fileOf(), "utf8")); } catch { /* fresh */ }
    for (const t of (data && data.tasks) || []) {
      if (t.status === "running" || t.status === "queued") { t.status = t.status === "running" ? "interrupted" : "queued"; }
      this.tasks.set(t.id, t);
    }
    // resume anything still queued from a previous session
    if ([...this.tasks.values()].some((t) => t.status === "queued")) setTimeout(() => this.schedule(), 300);
  }
  save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try { fs.writeFileSync(fileOf(), JSON.stringify({ version: 1, tasks: [...this.tasks.values()].map((t) => this._persistShape(t)) })); }
      catch { /* non-fatal */ }
    }, 300);
  }
  _persistShape(t) {
    const { id, name, prompt, cwd, model, sessionId, status, error, conflicts, createdAt, startedAt, finishedAt } = t;
    return { id, name, prompt, cwd, model, sessionId, status, error, conflicts, createdAt, startedAt, finishedAt };
  }

  uid() { return store.uid(); }

  // Enqueue one task. Creates its own session so its transcript is openable.
  enqueue({ cwd, prompt, model, name } = {}) {
    if (!prompt || !cwd) throw new Error("Fleet task needs a prompt and a cwd");
    const id = this.uid();
    const label = (name && String(name).trim()) || squashName(prompt);
    const sess = store.createSession({ cwd, name: "🛰 " + label, model });
    const task = {
      id, name: label, prompt: String(prompt), cwd, model: model || null,
      sessionId: sess.id, status: "queued", error: null, conflicts: 0, claimed: [],
      createdAt: now(), startedAt: 0, finishedAt: 0,
    };
    this.tasks.set(id, task);
    this.locks.name(id, label);
    this.save(); this.emit("fleet:update", this.snapshot());
    this.schedule();
    return this.publicTask(task);
  }
  // Enqueue several at once (manual multi-agent dispatch).
  enqueueMany(cwd, items = []) { return items.map((it) => this.enqueue({ cwd, prompt: typeof it === "string" ? it : it.prompt, model: it && it.model, name: it && it.name })); }

  runningCount() { let n = 0; for (const t of this.tasks.values()) if (t.status === "running") n++; return n; }

  schedule() {
    const cap = this.maxConcurrent();
    for (const t of this.tasks.values()) {
      if (this.runningCount() >= cap) break;
      if (t.status === "queued") this._start(t);
    }
  }

  // Build the per-task permission gate: auto-allow everything EXCEPT an edit to a
  // file another running agent currently holds (deny + tell it to move on).
  _guard(task) {
    return (toolName, input) => {
      if (EDIT_TOOLS.has(toolName)) {
        const file = input && (input.file_path || input.notebook_path || input.path);
        if (file) {
          const res = this.locks.tryClaim(task.id, file);
          if (!res.ok) {
            task.conflicts = (task.conflicts || 0) + 1;
            this.emit("fleet:update", this.snapshot());
            return { behavior: "deny", message: `"${rel(file, task.cwd)}" is currently being edited by another agent (${res.holderName}). Switch to a different file and return to this one later — do not wait or retry in a loop.` };
          }
          task.claimed = this.locks.filesOf(task.id).map((f) => rel(f, task.cwd));
          this.emit("fleet:update", this.snapshot());
        }
      }
      return { behavior: "allow", updatedInput: input };
    };
  }
  _awareness(task) {
    const others = [...this.tasks.values()].filter((t) => t.id !== task.id && t.status === "running");
    const held = this.locks.heldByOthers(task.id).map((h) => `${rel(h.file, task.cwd)} (${h.holder})`);
    return (
      `You are background fleet agent "${task.name}". ${others.length} other agent(s) are working in THIS SAME workspace concurrently. ` +
      `To prevent clashes, the system will DENY your edit if another agent is currently editing that file — if that happens, move to a different file and come back later; never wait or retry in a loop. ` +
      (held.length ? `Files currently held by others: ${held.join(", ")}. ` : `No files are held by others right now. `) +
      `Stay strictly within your task and don't touch unrelated files.`
    );
  }

  async _start(task) {
    task.status = "running"; task.startedAt = now(); task.error = null;
    this.locks.name(task.id, task.name);
    this.save(); this.emit("fleet:update", this.snapshot());
    const opts = {
      text: task.prompt,
      model: task.model || undefined,
      permissionMode: "default",          // so edits actually flow through our gate
      background: true,
      canUseToolOverride: this._guard(task),
      extraSystem: this._awareness(task),
      fleet: { taskId: task.id },
    };
    try {
      await this._runner()(task.sessionId, opts);
      const meta = store.getMeta(task.sessionId);
      task.status = (meta && meta.status === "error") ? "error" : "done";
    } catch (e) {
      task.status = "error"; task.error = String((e && e.message) || e);
    } finally {
      this.locks.releaseAll(task.id);
      task.claimed = [];
      task.finishedAt = now();
      this.save(); this.emit("fleet:update", this.snapshot());
      this.schedule();                    // pull the next queued task in
    }
  }

  async cancel(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (t.status === "running") { try { await require("./claude").interrupt(t.sessionId, "stop"); } catch { /* ignore */ } }
    t.status = "canceled"; t.finishedAt = now();
    this.locks.releaseAll(id);
    this.save(); this.emit("fleet:update", this.snapshot()); this.schedule();
    return true;
  }
  retry(id) {
    const t = this.tasks.get(id);
    if (!t || t.status === "running" || t.status === "queued") return false;
    t.status = "queued"; t.error = null; t.conflicts = 0; t.finishedAt = 0;
    this.save(); this.emit("fleet:update", this.snapshot()); this.schedule();
    return true;
  }
  remove(id) {
    const t = this.tasks.get(id);
    if (!t || t.status === "running") return false;
    this.tasks.delete(id); this.locks.releaseAll(id);
    this.save(); this.emit("fleet:update", this.snapshot());
    return true;
  }
  clearFinished() {
    for (const [id, t] of [...this.tasks]) if (["done", "error", "canceled", "interrupted"].includes(t.status)) this.tasks.delete(id);
    this.save(); this.emit("fleet:update", this.snapshot()); return true;
  }

  publicTask(t) {
    return {
      id: t.id, name: t.name, prompt: t.prompt, cwd: t.cwd, model: t.model,
      sessionId: t.sessionId, status: t.status, error: t.error || null,
      conflicts: t.conflicts || 0, claimed: t.claimed || [],
      createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
    };
  }
  snapshot() {
    const tasks = [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map((t) => this.publicTask(t));
    return { tasks, running: this.runningCount(), queued: tasks.filter((t) => t.status === "queued").length, maxConcurrent: this.maxConcurrent() };
  }
  list() { return this.snapshot(); }

  // Called on quit: mark live tasks so the user sees why they stopped.
  markInterruptedOnQuit() {
    for (const t of this.tasks.values()) if (t.status === "running") { t.status = "interrupted"; t.finishedAt = now(); }
    try { fs.writeFileSync(fileOf(), JSON.stringify({ version: 1, tasks: [...this.tasks.values()].map((x) => this._persistShape(x)) })); } catch { /* best effort */ }
  }
}

function squashName(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Task"; }

module.exports = new Fleet();
