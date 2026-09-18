"use strict";
/* IPC: conversations — sessions:* (list / create / continue-in-a-new-session, lazy message windows,
 * send / steer / interrupt / retry, live model + permission-mode controls, export / import) and the
 * permission-prompt reply. Handlers call the session manager (src/main/session/index.js).
 * scripts/test-context.js extracts the sessions:synthesize handler from this file by text — it
 * slices from that handler's first line to the sessions:get handler, so keep those two adjacent. */
const { ipcMain, dialog, shell } = require("electron");
const fs = require("fs");
const store = require("../storage/store");
const claude = require("../session/index");

function register(ctx) {
  const { handle, winFrom } = ctx;
  // ---- Sessions (lazy: get/messages return windows, not full arrays) ----
  handle("sessions:list", async () => store.listSessions());
  handle("sessions:create", async (_e, opts) => store.createSession(opts || {}));
  // "Synthesize → new session": an EXPLICIT action that starts a fresh session (new id, no native
  // threads) seeded with a CONDENSED handoff of the source conversation — never the multi-megabyte
  // transcript (user decision 2026-09-16). The seed is one "record" entry of about
  // SYNTH_SEED_CHARS: the whole record only when it is that small; otherwise a model-made summary
  // of the oldest entries (the source's cached rolling summaries are reused), the most recent
  // entries verbatim, and the session map — goals, outcomes, files and tools distilled from the
  // record without a model call. The entry says exactly what it carries and the card shows the
  // same text the first turn transfers to the provider. The source keeps its complete transcript;
  // the session's settings (model, effort, permission mode, 1M context, its own workflow) and its task
  // board (contract §8 — a deep copy; the seed's map gets the board's summary) carry over. A skill
  // selection does NOT: skills reach workflow ROLE sessions only (2026-09-18), and a continuation is a
  // plain chat — a copied legacy selection would have no effect there.
  handle("sessions:synthesize", async (_e, srcId) => {
    const src = store.getSession(srcId);
    if (!src) return null;
    const jobs = claude._synthesisJobs || (claude._synthesisJobs = new Map());
    const existing = jobs.get(srcId);
    if (existing && !existing.external.isAborted()) return existing.promise;
    const external = claude.registerExternalRunner(srcId, { label: "Preparing a continuation" });
    if (!external) throw new Error("Stop the running reply before synthesizing this session.");
    const entry = { external, promise: null };
    jobs.set(srcId, entry);
    entry.promise = (async () => {
      let onAbort;
      try {
        store.updateSession(srcId, { status: "running" });
        claude.send("session:status", { sessionId: srcId, status: "running" });
        const onProgress = (label) => external.progress(`${label} — Stop cancels`);
        onProgress("Preparing a continuation");
        const settings = store.getSettings(src.cwd);
        const wf = claude.workflowFor(src, settings);
        const provider = src.provider || (wf.enabled && wf.roles.orchestrator && wf.roles.orchestrator.provider) || src.lastProvider || settings.llmProvider || "anthropic";
        const cancelled = new Promise((resolve) => {
          onAbort = () => resolve(null);
          external.signal.addEventListener("abort", onAbort, { once: true });
          if (external.signal.aborted) onAbort();
        });
        const seed = await Promise.race([claude.synthesizeSeed(src, provider, { model: src.model, signal: external.signal, onProgress }), cancelled]);
        // An abandoned summary may still finish late. It must never create a phantom tab.
        if (!seed || external.isAborted() || store.getSession(srcId) !== src) return null;
        const n = (x) => Number(x || 0).toLocaleString("en-US");
        const what = seed.selected ? `working memory and selected evidence from ${n(seed.count)} source entries, with references for retrieving the full history`
          : seed.mode === "summary" ? `a summary of the ${n(seed.headCount)} oldest entries and the ${n(seed.tailCount)} most recent entr${seed.tailCount === 1 ? "y" : "ies"} verbatim (long tool inputs/outputs shortened)`
          : seed.mode === "shortened" ? `the record of that conversation (${n(seed.count)} entries — conversation text verbatim, long tool inputs/outputs shortened)`
            : seed.mode === "exact" ? `the complete record of that conversation (${n(seed.count)} entr${seed.count === 1 ? "y" : "ies"}, verbatim)` : "";
        const head = `Continued from "${String(src.name || "a previous session").slice(0, 100)}" — a condensed handoff follows: ${[what, seed.mapText ? "a session map (goals, outcomes, files, tools)" : "", seed.boardText ? "the task board (its sets and tasks with their status)" : ""].filter(Boolean).join(", then ")}. Tool entries are completed results, not requests to run again.\n\n`;
        const files = (src.editedFiles || []).filter((f) => f && f.path);
        const view = store.createSession({ cwd: src.cwd, name: "↻ " + (src.name || "Session"), model: src.model, thinking: src.thinking, permissionMode: src.permissionMode, oneM: !!src.oneM, workflow: src.workflow || null });   // the continuation keeps the tab's own workflow (per-session selection); no skill selection (role sessions only)
        const full = store.getSession(view.id);
        if (full) {
          full.editedFiles = JSON.parse(JSON.stringify(files));
          full.tasks = JSON.parse(JSON.stringify(store.normalizeTasks(src.tasks)));   // the task board carries over (deep copy, same numbering)
          if (seed.count || seed.mapText || seed.boardText) full.messages.push({ id: store.uid(), role: "record", text: head + seed.text, ts: store.nowISO(), carriedRecord: true, carriedFrom: srcId, carriedCount: seed.count, meta: { sourceName: src.name || "", sourceId: srcId, entries: seed.count, mode: seed.mode, selected: !!seed.selected, selectedCount: seed.selectedCount || 0, memorySource: seed.memorySource || "", sourceLastIndex: seed.last, chars: (head + seed.text).length, fullChars: seed.fullChars, budget: seed.budget, headCount: seed.headCount, tailCount: seed.tailCount, summary: seed.summary || "", map: seed.map || null, boardText: seed.boardText || "", job: seed.job || null } });
          store.flush(view.id);
        }
        return store.getSessionView(view.id);
      } catch (e) {
        if (external.isAborted()) return null;
        throw e;
      } finally {
        if (onAbort) external.signal.removeEventListener("abort", onAbort);
        if (jobs.get(srcId) === entry) jobs.delete(srcId);
        // Stop or a new turn may already have taken ownership; never publish idle for it.
        if (external.unregister() && store.getSession(srcId) === src) {
          store.updateSession(srcId, { status: "idle" });
          claude.send("session:live", { sessionId: srcId, live: null });
          claude.send("session:status", { sessionId: srcId, status: "idle" });
        }
      }
    })();
    return entry.promise;
  });
  handle("sessions:get", async (_e, id) => store.getSessionView(id));
  handle("sessions:run-state", async (_e, id) => {
    const session = store.getSession(id), runner = claude.runners.get(id);
    const running = claude.isRunning(id);
    return { running, status: running ? "running" : session && session.status === "running" ? "idle" : (session && session.status) || "idle", runId: runner && runner.id || null, stopping: !!(runner && runner.interrupted), live: runner && (runner.live || runner._live) || null };
  });
  handle("sessions:messages", async (_e, id, end, count) => store.getMessagesRange(id, end, count));
  handle("sessions:search", async (_e, id, query) => store.searchSession(id, query));
  handle("sessions:prompts", async (_e, id) => store.listPrompts(id));

  handle("sessions:rename", async (_e, id, name) => { store.updateSession(id, { name: (name || "Untitled session").trim() }); return store.getMeta(id); });
  handle("sessions:update", async (_e, id, patch) => { store.updateSession(id, patch || {}); return store.getMeta(id); });
  handle("sessions:delete", async (_e, id) => { await claude.interrupt(id); return store.deleteSession(id); });
  handle("sessions:delete-message", async (_e, id, mid) => store.deleteMessage(id, mid));
  handle("sessions:send", async (_e, id, payload) => {
    if (process.env.ATOMNANO_TEST) global.__lastRunPayload = payload || {};
    // Pre-flight failures (already running, missing session, immediate validation)
    // need to reach the renderer so the user sees a toast instead of a silent
    // dropped prompt. Wait one microtask so a synchronous throw surfaces here.
    let preflightErr = null;
    const p = claude.run(id, payload || {}).catch((err) => {
      console.error("[run]", err);
      preflightErr = err;
    });
    await Promise.race([p, new Promise((r) => setImmediate(r))]);
    if (preflightErr) throw preflightErr;
    return { started: true };
  });
  handle("sessions:interrupt", async (_e, id, reason) => claude.interrupt(id, reason || "stop"));
  // Enter mid-turn on a Codex session: append to the running turn (turn/steer) instead
  // of interrupting. Returns { steered:false } when there's nothing steerable.
  handle("sessions:steer", async (_e, id, payload) => claude.steer(id, payload || {}));
  handle("sessions:running", async (_e, id) => claude.isRunning(id));
  // Per-run diagnostics: provider / transport / auth context / requested+sent
  // model & effort / transferred entries / native ids — secrets never included.
  handle("sessions:last-run", async () => { const r = claude.lastRunInfo(); return r ? { sessionId: r.sessionId, runId: r.runId, sent: r.sent, init: r.init, resumeRequested: r.resumeRequested, resumedFresh: !!r.resumedFresh, ultracodeApplied: !!r.ultracodeApplied } : null; });
  handle("sessions:retry", async (_e, id) => claude.retryPending(id));
  // Live-query control requests — only act while a turn is running (fresh query per
  // turn), so these return null/false between turns. See SessionManager._liveQuery.
  handle("sessions:context-usage", async (_e, id) => claude.contextUsage(id));
  handle("sessions:mcp-status", async (_e, id) => claude.mcpStatus(id));
  handle("sessions:rewind", async (_e, id, userMessageId) => claude.rewindFiles(id, userMessageId));
  handle("sessions:set-model-live", async (_e, id, model) => claude.setModelLive(id, model));
  handle("sessions:set-mode-live", async (_e, id, mode) => claude.setPermissionModeLive(id, mode));
  ipcMain.on("sessions:permission-response", (_e, requestId, decision) => claude.respondPermission(requestId, decision));
  handle("sessions:open-history", async () => { await shell.openPath(store.getSettings().historyDir); return true; });

  // Export one or many conversations. Two modes:
  //   "full"    (default) — every message, tool call, attachment. Re-importable.
  //   "compact" — distilled digest + last 40 exchanges + editedFiles + meta.
  //              Much smaller (~5-20 KB vs megabytes for long chats) and readable.
  handle("sessions:export", async (e, ids, mode) => {
    // Full export = the COMPLETE transcript (archive + live) per session.
    const raw = (Array.isArray(ids) ? ids : [ids]).map((id) => (mode === "compact" ? store.getSession(id) : store.exportSession(id))).filter(Boolean);
    if (!raw.length) throw new Error("Nothing to export");
    const compact = mode === "compact";
    const tag = compact ? ".compact" : "";
    const def = raw.length === 1
      ? ((raw[0].name || "session").replace(/[^a-z0-9_\- ]/gi, "").trim().slice(0, 60) || "session") + `${tag}.atomnano.json`
      : `atomnano-conversations-${raw.length}${tag}.atomnano.json`;
    const res = await dialog.showSaveDialog(winFrom(e), { title: `Export conversation(s)${compact ? " (compact)" : ""}`, defaultPath: def, filters: [{ name: "AtomNano conversations", extensions: ["json"] }] });
    if (res.canceled || !res.filePath) return { canceled: true };

    let list;
    if (compact) {
      const convo = require("../storage/convo");
      list = raw.map((s) => {
        const digest = (() => { try { return convo.digestFor(s) || ""; } catch { return ""; } })();
        const msgs = (s.messages || []);
        const recent = []; let used = 0;
        for (let i = msgs.length - 1; i >= 0 && recent.length < 40; i--) {
          const m = msgs[i];
          if (!m || !m.text || (m.role !== "user" && m.role !== "assistant" && m.role !== "system" && m.role !== "error")) continue;
          const text = String(m.text).length > 800 ? String(m.text).slice(0, 800) + "…" : String(m.text);
          const entry = { role: m.role, text, ts: m.ts };
          if (m.meta) entry.meta = m.meta;
          if (used + text.length > 16000 && recent.length >= 6) break;
          recent.unshift(entry); used += text.length;
        }
        return {
          id: s.id, name: s.name, cwd: s.cwd, model: s.model, thinking: s.thinking, oneM: s.oneM,
          createdAt: s.createdAt, updatedAt: s.updatedAt,
          totalMessages: msgs.length + (s.archivedCount || 0),
          totalCostUsd: s.totalCostUsd || 0,
          editedFiles: (s.editedFiles || []).map((f) => ({ path: f.path, count: f.count, added: f.added, removed: f.removed })),
          digest,
          recentMessages: recent,
          _compact: true,
        };
      });
    } else {
      list = raw;
    }
    fs.writeFileSync(res.filePath, JSON.stringify({ atomnano: 1, version: compact ? 2 : 3, mode: compact ? "compact" : "full", exportedAt: new Date().toISOString(), sessions: list }, null, 2));
    return { path: res.filePath, count: list.length, mode: compact ? "compact" : "full", messages: compact ? undefined : list.reduce((n, s) => n + (s.messages || []).length, 0) };
  });
  // Import a bundle (single or many) → new sessions, transcript preserved.
  handle("sessions:import", async (e) => {
    const res = await dialog.showOpenDialog(winFrom(e), { title: "Import conversation(s)", properties: ["openFile"], filters: [{ name: "AtomNano conversations", extensions: ["json"] }] });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    let raw;
    try { raw = JSON.parse(fs.readFileSync(res.filePaths[0], "utf8")); } catch { throw new Error("Could not read the file"); }
    const arr = Array.isArray(raw.sessions) ? raw.sessions : (raw.session ? [raw.session] : (Array.isArray(raw) ? raw : [raw]));
    const views = arr.map((s) => store.importSession(s)).filter(Boolean);
    if (!views.length) throw new Error("No valid AtomNano conversations in that file");
    return { count: views.length, sessions: views, first: views[0] };
  });
}

module.exports = { register };
