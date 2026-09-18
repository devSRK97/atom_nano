/* AtomNano renderer — Events from the main process — session messages, status, partials, permissions, auth, network.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { $, copyText, h, mdToRichHtml, selectionHtml, showContextMenu, styleRichHtml, toast } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { cm, openInEditor } from "../editor/editor-pane.js";
import { refreshGit } from "../git/sidebar.js";
import { scheduleAgentsRender, updateCpuMeter, upsertAgentRecord } from "../panels/agents.js";
import { scheduleBoardRender } from "../panels/board.js";
import { currentDock, renderChanges } from "../panels/changes.js";
import { renderFleet, setFleetSnap } from "../panels/fleet.js";
import { renderTests } from "../panels/tests.js";
import { openSettings } from "../settings/settings.js";
import { notifyWorkflow, onWorkflowJob as workflowJobChanged, onWorkflowStage as workflowStageChanged, refreshWorkflowChip, tabWorkflow } from "../workflow/index.js";
import { renderTree } from "../workspace/sidebar.js";
import { dispatchNextQueued, refreshAgentsBtn, refreshAuthBanner, refreshCtxChip, renderAgentsStrip, renderSuggestChips, startCtxMeter, stopCtxMeter, updateCpuStrip, updateSendButton, updateStats } from "./composer.js";
import { openSessionTabQuiet } from "./history.js";
import { _followTail, JOB_TERMINAL, cancelLiveUpdate, patchJobCard, patchTasksCard, patchToolCard, relabelSubagentNodes, renderLive, renderMessage, renderPerms, revealToolDetail, scheduleLiveUpdate, scrollBottom, tasksCardMetaFor, waitForEditor } from "./messages.js";
import { applyModelFilter, atTail, reloadTail, renderNewMsgBadge, trimRenderedTop } from "./navigation.js";
import { MEM_CAP, renderTabs } from "./tabs.js";

// Apply a message patch: top-level fields replace; a `meta` patch MERGES into the message's meta. A job
// card's meta.status / result / editedFiles arrive as meta patches — replacing the object would drop the
// provider / model / sessionId the card was created with. (No other card is patched through `meta`.)
export function mergePatch(target, patch) {
  if (!patch || typeof patch !== "object") return target;
  const { meta, ...rest } = patch;
  Object.assign(target, rest);
  if (meta && typeof meta === "object") target.meta = Object.assign({}, target.meta || {}, meta);
  return target;
}
// The fields of a workflow:job event the planner's job card shows — merged into the card's message
// meta so the renderer's copy follows the job stream even before the persisted patch lands.
export const JOB_EVENT_FIELDS = ["status", "result", "durationMs", "editedFiles", "startedTs", "endedTs", "agentsLive", "error", "exitCode", "tokensIn", "tokensOut", "provider", "model", "effort", "access", "agents", "skills", "sessionId", "kind", "command"];
// A job changed: update the planner tab's job message and patch its card in place (found by data-job).
// Returns false when the planner is not open in this window or the message is outside the in-memory
// window (main's session:message-update patch covers the persisted copy either way).
export function applyWorkflowJob(job) {
  if (!job || !job.id || !job.parentId) return false;
  const ts = state.tabs.get(job.parentId);
  if (!ts) return false;
  const m = ts.messages.find((x) => x.role === "job" && x.jobId === job.id);
  if (!m) return false;
  const meta = m.meta || (m.meta = {});
  for (const k of JOB_EVENT_FIELDS) if (job[k] !== undefined) meta[k] = job[k];
  if (!m.jobRole && job.role) m.jobRole = job.role;
  if (job.parentId !== state.activeTabId) return true;
  const card = document.querySelector(`#chatMessages .job-card[data-job="${CSS.escape(String(job.id))}"]`);
  if (card && patchJobCard(card, m, ts) && _followTail && JOB_TERMINAL.has(String(job.status || ""))) scrollBottom(true);   // the result landed → the card grew
  return true;
}
// Task board (docs/WORKFLOW_CONTRACT.md §8): tasks:update carries the WHOLE board after any change. It becomes the
// tab's copy (ts.board), each set's chat card gets its meta rebuilt from it and — when the tab is the active one —
// patched in place, the Board dock re-renders when open and the composer chip follows. Main's persisted
// session:message-update patch for the same card arrives too; both paths converge on the same meta.
export function applyTasksUpdate(sessionId, board) {
  const ts = state.tabs.get(sessionId);
  if (!ts || !board || typeof board !== "object") return false;
  ts.board = board;
  const active = sessionId === state.activeTabId;
  for (const set of Array.isArray(board.sets) ? board.sets : []) {
    if (!set || set.id == null) continue;
    const m = ts.messages.find((x) => x.role === "tasks" && (x.setId === set.id || (x.meta && x.meta.setId === set.id)));
    if (!m) continue;
    m.meta = Object.assign({}, m.meta || {}, tasksCardMetaFor(board, set));
    if (!active) continue;
    const node = document.querySelector(`#chatMessages .tasks-card[data-set="${CSS.escape(String(set.id))}"]`);
    if (node) patchTasksCard(node, m);
  }
  if (active) { scheduleBoardRender(); refreshWorkflowChip(); }
  return true;
}

/* ============================================================
   EVENTS FROM MAIN
   ============================================================ */
export function wireEvents() {
  atom.events.onFleet((snap) => { setFleetSnap(snap); if (currentDock() === "fleet") renderFleet(); });
  atom.events.onDirector(() => { if (currentDock() === "tests") renderTests(); });
  atom.events.onSubagentBlocked(() => toast("Sub-agent spawn blocked — enable 'Sub agents' to allow delegation", "shield"));
  // A settings / session / archive write failed in main: say so — never let the UI
  // imply something was saved when the bytes didn't land.
  atom.events.onStoreError((info) => {
    const what = info && info.kind === "settings" ? "Settings could not be saved" : info && info.kind === "archive" ? "Conversation history could not be archived (nothing was removed)" : "Conversation could not be saved to disk";
    toast(`${what}: ${(info && info.detail) || "write failed"}`, "alert", { ms: 8000 });
  });
  // A rejected IPC call that nobody caught (e.g. a settings save that failed on
  // disk) must still be visible instead of vanishing into the console.
  window.addEventListener("unhandledrejection", (ev) => {
    const msg = ev && ev.reason && (ev.reason.message || String(ev.reason));
    if (msg) toast(msg.length > 220 ? msg.slice(0, 220) + "…" : msg, "alert", { ms: 7000 });
  });
  atom.events.onPromptSuggestion(({ sessionId, suggestion }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts || !suggestion) return;
    ts.suggestion = suggestion;
    if (sessionId === state.activeTabId) renderSuggestChips();
  });
  atom.events.onMessage(({ sessionId, message }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    if (message.role === "result" && message.meta) ts.meta.totalCostUsd = message.meta.totalCostUsd;
    const active = sessionId === state.activeTabId;
    // A just-sent prompt forces one jump to the tail even if the user was scrolled
    // up (see send()). The flag clears on the user message it was set for, so the
    // reply after it follows the normal "only scroll if already at the bottom" rule.
    const forced = active && ts._forceScrollOnce;
    if (forced && message.role === "user") ts._forceScrollOnce = false;
    // The in-memory window is detached from the tail (user jumped to an older prompt
    // or search hit): a new message can't be appended to a non-contiguous window.
    // Count it on the jump-to-latest button; the tail reloads when they go back down
    // (a sent prompt forces that jump right away).
    if (!atTail(ts)) {
      ts.totalMessages = (ts.totalMessages || 0) + 1;
      if (forced) { reloadTail(ts).then(() => scrollBottom(true)); return; }
      ts.unseenNew = (ts.unseenNew || 0) + 1;
      if (active) { renderNewMsgBadge(); renderLive(); }
      return;
    }
    ts.messages.push(message);
    ts.totalMessages = (ts.totalMessages || 0) + 1;
    // Following = the user was at the tail (the scroll listener's verdict). It is decided BEFORE the
    // new node is appended and then applied as a forced scroll: measuring "near the bottom" after a
    // tall card landed (sub-agents add many at once) used to fail the 140 px test and detach the view.
    const following = forced ? true : (active ? _followTail : true);
    // Bound in-memory messages: when following the tail, drop the oldest from RAM
    // (they stay one scroll-up away — paged back in from disk).
    if (following && ts.messages.length > MEM_CAP) {
      const drop = ts.messages.length - MEM_CAP;
      ts.messages.splice(0, drop);
      ts.firstIndex += drop;
      ts.viewStart = Math.max(0, (ts.viewStart || 0) - drop);
    }
    if (active) {
      const msgs = $("chatMessages");
      const empty = msgs.querySelector(".chat-empty");
      if (empty) { msgs.innerHTML = ""; ts.viewStart = Math.max(0, ts.messages.length - 1); }
      msgs.append(renderMessage(message, ts));
      if (ts.modelFilter && message.role === "assistant") applyModelFilter(ts);   // a filter applies to new replies too
      if (following) { trimRenderedTop(); scrollBottom(true); }  // only trim/scroll when at the tail
      renderLive();
    }
  });

  atom.events.onMessageUpdate(({ sessionId, messageId, patch }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    const m = ts.messages.find((x) => x.id === messageId);
    if (m) {
      mergePatch(m, patch);
      if (sessionId === state.activeTabId) {
        const node = document.querySelector(`#chatMessages [data-mid="${messageId}"]`);
        // Patch the existing card IN PLACE: its DOM node (and with it the user's
        // expanded state, scroll position and text selection) survives every
        // status / output update. Only when in-place patching isn't possible does
        // the node get rebuilt — and then the open state is carried over.
        if (node) {
          if (m.role === "tool" && patchToolCard(node, m, ts)) { /* patched in place */ }
          else if (m.role === "job" && patchJobCard(node, m, ts)) { /* patched in place */ }
          else if (m.role === "tasks" && patchTasksCard(node, m)) { /* patched in place */ }
          else {
            const wasOpen = !!node.querySelector(".tool-card.open, .thinking-card.open, .job-card.open");
            const fresh = renderMessage(m, ts);
            if (wasOpen) { const c = fresh.querySelector(".tool-card, .thinking-card, .job-card"); if (c) c.classList.add("open"); }
            node.replaceWith(fresh);
          }
          // A card that grew (result landed, detail rebuilt) must not push the tail out of view.
          if (_followTail && (patch.status || patch.result != null || (patch.meta && (patch.meta.status || patch.meta.result != null)))) scrollBottom(true);
        }
      }
      return;
    }
    // Out-of-window patch: queue it so the next time the user scrolls older
    // messages back into view, we apply the latest patch rather than rendering
    // a stale "running" tool card. (Main has already persisted the change.)
    if (!ts._pendingPatches) ts._pendingPatches = new Map();
    const prev = ts._pendingPatches.get(messageId) || {};
    ts._pendingPatches.set(messageId, mergePatch(prev, patch));
  });

  // Workflow (orchestrator-as-primary, docs/WORKFLOW_CONTRACT.md §3/§6): a job change updates the studio's
  // copy, patches the orchestrator's job card in place and refreshes the composer chip; a stage change drives
  // the chip and the tab strip; a child session created for an orchestrator open in THIS window gets a tab right
  // after its parent — without stealing focus — ONLY when job tabs are opted in (workflow.openJobTabs; off by
  // default since 2026-09-17: jobs run in the background and their cards / the studio open a tab on demand).
  // The bridge grows these listeners with the workflow build; a preload without them must not break wiring.
  const onEv = (name, cb) => { const f = atom.events && atom.events[name]; if (typeof f === "function") f(cb); };
  onEv("onWorkflowJob", (payload) => {
    const job = payload && payload.job;
    if (!job) return;
    workflowJobChanged({ job });
    applyWorkflowJob(job);
    refreshWorkflowChip();
  });
  onEv("onWorkflowStage", (payload) => { workflowStageChanged(payload); refreshWorkflowChip(); renderTabs(); });
  onEv("onSessionCreated", (payload) => {
    const { view, parentId, role, autoOpen } = payload || {};
    if (!view || !view.id || !parentId || !state.tabs.has(parentId)) return;   // not an orchestrator open in this window
    // main resolves the project's workflow and says whether tabs are opted in (autoOpen); an older main
    // without the flag falls back to this window's settings. Default: no tab — the job runs in the background.
    const wanted = autoOpen !== undefined ? autoOpen === true : tabWorkflow(parentId).openJobTabs === true;   // the ORCHESTRATOR tab's workflow (per-session)
    if (!wanted) return;
    openSessionTabQuiet({ ...view, parentId: view.parentId || parentId, role: view.role || role || null });
  });
  // Task board (§8): the whole board after any change → the tab, the set cards, the dock, the chip.
  onEv("onTasks", (payload) => { if (payload && payload.sessionId) { applyTasksUpdate(payload.sessionId, payload.board); notifyWorkflow(); } });   // the studio's board block follows live
  // A session's OWN workflow changed (a studio edit, a library load, a clone — here or in another window): mirror it
  // on the tab so the chips and the studio read it (per-session selection, contract §10).
  onEv("onSessionWorkflow", (payload) => { const ts = payload && payload.sessionId ? state.tabs.get(payload.sessionId) : null; if (ts) { ts.wfOwn = payload.workflow && typeof payload.workflow === "object" ? payload.workflow : null; notifyWorkflow(); if (payload.sessionId === state.activeTabId) refreshAgentsBtn(); } });   // the Agents button reads "workflow" while the tab's workflow is on

  atom.events.onStatus(({ sessionId, status, provider, model, effort, resumeAt, attempt }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    ts._statusVersion = (ts._statusVersion || 0) + 1;
    ts._statusAt = Date.now();   // a workflow stage older than this cannot claim the orchestrator is still running (workflow/live.js primaryRunning)
    ts.meta.status = status;
    // Snapshot of what THIS run was dispatched with — the live reply is labelled
    // from it, not from whatever the dropdowns say now.
    if (status === "running" && provider) ts.meta.run = { provider, model: model || "", effort: effort || "" };
    if (status === "auth-expired" && provider) ts.meta.authProvider = provider;
    if (status !== "auth-expired") ts.meta.authProvider = null;
    if (status === "ratelimited") { ts.meta.rateResumeAt = resumeAt || 0; ts.meta.rateAttempt = attempt || 0; }
    else { ts.meta.rateResumeAt = 0; ts.meta.rateAttempt = 0; }
    // Run ended → drop the live thinking/streaming region immediately (don't wait
    // for a separate partial-reset), and clear the transient "stopping" state.
    if (status !== "running") { ts.streaming.clear(); ts.stopping = false; ts.live = null; clearTimeout(ts._stopTimer); }
    // SDK capability UI: a new turn clears the last suggestion + starts the live
    // context meter; a finished turn stops the meter and clears subagent progress.
    if (status === "running") { ts.suggestion = null; if (sessionId === state.activeTabId) startCtxMeter(sessionId); }
    else { if (sessionId === state.activeTabId) stopCtxMeter(); }
    renderTabs();
    if (sessionId === state.activeTabId) { updateSendButton(); renderLive(); renderSuggestChips(); }
    // Only drain the queue on CLEAN terminations. On error/offline/interrupted
    // we'd otherwise fire identical failing prompts one after another, burning
    // API credits. The user resends manually once they've fixed the cause.
    if ((status === "idle" || status === "done") && ts.queue && ts.queue.length) {
      setTimeout(() => dispatchNextQueued(sessionId), 30);   // near-immediate; dispatch re-queues if backend still tearing down
    }
  });

  atom.events.onPartial(({ sessionId, index, kind, delta, parent }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    if (parent) return;        // a subagent's stream — it renders inside its own Task card, never the main reply
    if (ts.stopping) return;   // user clicked stop — drop any in-flight tokens
    // Late partials arriving after a terminal status (race across IPC channels)
    // would re-populate streaming and resurrect the typing dots. Drop them.
    if (ts.meta.status !== "running") return;
    const cur = ts.streaming.get(index) || { kind, text: "" };
    cur.kind = kind; cur.text += delta || "";
    ts.streaming.set(index, cur);
    if (sessionId === state.activeTabId) scheduleLiveUpdate();   // coalesced to one DOM sync per frame
  });

  atom.events.onPartialReset(({ sessionId, index }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    // With an index only that stream is dropped (e.g. the live reasoning bubble once
    // its card is in the transcript) — the text stream keeps flowing.
    if (typeof index === "number") ts.streaming.delete(index); else ts.streaming.clear();
    if (sessionId === state.activeTabId) { cancelLiveUpdate(); renderLive(); }
  });

  atom.events.onEditedFiles(({ sessionId, files }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    ts.editedFiles = files;
    if (sessionId === state.activeTabId) {
      updateStats();
      renderChanges();   // refresh only if the panel is already open; never auto-open
      if (state.sidebarView === "files") renderTree(); else refreshGit();
    }
  });

  atom.events.onPermission((req) => {
    const { sessionId, requestId, toolName } = req;
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    // Auto-allow tools the user already approved "for this session".
    if (ts.autoAllow && ts.autoAllow.has(toolName) && toolName !== "ExitPlanMode" && toolName !== "AskUserQuestion") {
      atom.sessions.permissionResponse(requestId, { allow: true, message: "" });
      return;
    }
    // The card carries everything the CLI told us: its own prompt sentence (title), the rule
    // reason / blocked path, whether it offered "always allow" rules, and the asking sub-agent.
    ts.pendingPerms.push({ ...req, shownAt: Date.now() });   // waits for the user — no deadline
    renderTabs();
    if (sessionId === state.activeTabId) { renderPerms(); renderLive(); }
  });

  // What the CLI is doing while nothing streams (compacting / requesting / retrying / signing in):
  // the live label says so instead of a bare "Thinking".
  atom.events.onLive(({ sessionId, live }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    if (live && (ts.stopping || ts.meta.status !== "running")) return;
    ts.live = live || null;
    if (sessionId === state.activeTabId) renderLive();
  });
  // A one-line notification the CLI asked the host to show.
  atom.events.onNotice(({ sessionId, text, priority }) => {
    if (!text) return;
    const ts = state.tabs.get(sessionId);
    toast((ts && sessionId !== state.activeTabId ? `${ts.meta.name}: ` : "") + text, priority === "high" || priority === "immediate" ? "alert" : "chat", { ms: priority === "immediate" ? 9000 : 5000 });
  });
  // Sub-agent registry: one record changed (announced / progress / finished). The tab keeps the
  // copy; the Agents button, the strip above the composer, the nested-output labels and the
  // dock follow.
  atom.events.onAgents(({ sessionId, agent }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts || !agent) return;
    upsertAgentRecord(ts, agent);
    if (sessionId !== state.activeTabId) return;
    refreshAgentsBtn(); renderAgentsStrip(); relabelSubagentNodes(ts, agent); scheduleAgentsRender();
  });
  // CPU governor picture (every 2 s while agents run or a panel watches).
  atom.events.onCpu((snap) => { state.cpu = snap; updateCpuStrip(snap); updateCpuMeter(snap); });
  // Context window fill / digest for the composer chip.
  atom.events.onContext(({ sessionId, info }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    ts.ctxInfo = info || null;
    if (sessionId === state.activeTabId) refreshCtxChip();
  });

  // Stop / abort dismisses any in-flight permission cards on the main side —
  // the renderer drops the matching pendingPerms entry so a stale card doesn't
  // outlive the run that asked for it.
  atom.events.onPermissionCancel(({ sessionId, requestId }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    const before = ts.pendingPerms.length;
    ts.pendingPerms = ts.pendingPerms.filter((p) => p.requestId !== requestId);
    if (ts.pendingPerms.length === before) return;
    renderTabs();
    if (sessionId === state.activeTabId) { renderPerms(); renderLive(); }
  });

  // Network auto-resume: when connection comes back (from main process polling
  // or the browser's own online event), retry any sessions that went offline.
  atom.events.onNetStatus(({ online }) => {
    if (online) {
      for (const [id, ts] of state.tabs) {
        if (ts.meta.status === "offline") atom.sessions.retry(id).catch(() => {});
      }
    }
    renderTabs();
    if (activeTS()) { updateSendButton(); renderLive(); }
  });
  window.addEventListener("online", () => {
    for (const [id, ts] of state.tabs) {
      if (ts.meta.status === "offline") atom.sessions.retry(id).catch(() => {});
    }
  });

  // Auth auto-resume: when a provider flips back to signed-in (main process polls
  // login state), any session paused by an expired token resumes itself — context
  // preserved. The main process already fires the retry; here we just refresh UI
  // and also opportunistically nudge any auth-paused tabs (covers manual re-login).
  atom.events.onAuthStatus(({ providers }) => {
    const anySignedIn = providers && Object.values(providers).some(Boolean);
    if (anySignedIn) {
      for (const [id, ts] of state.tabs) {
        if (ts.meta.status === "auth-expired") atom.sessions.retry(id).catch(() => {});
      }
    }
    refreshAuthBanner();
    renderTabs();
    if (activeTS()) { updateSendButton(); renderLive(); }
  });
}
// Open the sign-in flow for a paused session's provider, then let the main-process
// auth poller auto-resume it. Falls back to a manual retry nudge after the OAuth
// round-trip in case the poller hasn't ticked yet.
export async function resumeAuthExpired(provider) {
  const prov = provider || (state.settings && state.settings.llmProvider) || "anthropic";
  try {
    if (prov === "custom") { openSettings(); return; }
    await atom.providers.authorize(prov);
    toast("Complete the sign-in — your session resumes automatically.", "key");
  } catch (e) {
    toast("Couldn't open sign-in: " + ((e && e.message) || e), "alert");
  }
  // Nudge resume after the browser auth completes (poller also covers this).
  const nudge = () => { for (const [id, ts] of state.tabs) if (ts.meta.status === "auth-expired") atom.sessions.retry(id).catch(() => {}); };
  setTimeout(nudge, 5000); setTimeout(nudge, 12000);
}
// Account switcher popup — shows saved credential profiles and lets the user
// switch without losing context. After switching, all auth-expired / rate-limited
// sessions auto-retry via the main-process auth poller.
export async function openAccountSwitcher(anchor) {
  // Which CLI login the active provider uses: Codex for OpenAI, Claude otherwise.
  const prov = (state.settings.llmProvider === "openai") ? "openai" : "anthropic";
  let profiles = [];
  try { profiles = await atom.profiles.list(prov); } catch { /* ignore */ }
  const items = [];
  for (const p of profiles) {
    const lbl = (p.email || p.label) + (p.sub ? ` (${p.sub})` : "") + (p.active ? " ✓" : "") + (p.expired ? " — expired" : "");
    items.push({ label: lbl, icon: p.active ? "check" : "user", onClick: async () => {
      if (p.active) { toast("Already using this account", "check"); return; }
      try {
        const r = await atom.profiles.switch(p.label, prov);
        if (r.ok) {
          toast("Switched account — resuming sessions…", "key");
          for (const [id, ts] of state.tabs) {
            if (ts.meta.status === "auth-expired" || ts.meta.status === "ratelimited") atom.sessions.retry(id).catch(() => {});
          }
          setTimeout(() => { refreshAuthBanner(); renderTabs(); if (activeTS()) { updateSendButton(); renderLive(); } }, 500);
        } else { toast(r.detail || "Switch failed", "alert"); }
      } catch (e) { toast("Switch failed: " + ((e && e.message) || e), "alert"); }
    } });
  }
  if (!profiles.length) items.push({ label: `No saved ${prov === "openai" ? "Codex" : "Claude"} accounts`, icon: "info" });
  items.push({ sep: true });
  items.push({ label: "Save current login", icon: "plus", onClick: async () => {
    try {
      const r = await atom.profiles.saveCurrent(prov);
      if (r.ok) toast((r.created || !r.updated ? "Account saved as " : "Refreshed saved account ") + r.label, "check");
      else toast(r.detail || "Nothing to save", "alert");
    } catch (e) { toast("Save failed: " + ((e && e.message) || e), "alert"); }
  } });
  items.push({ label: "Add new account…", icon: "key", onClick: async () => {
    try {
      await atom.providers.authorize(prov);
      toast("Complete the login in the terminal — the new account is saved automatically.", "key");
    } catch (e) { toast("Couldn't open login: " + ((e && e.message) || e), "alert"); }
  } });
  items.push({ label: "Sign out (keeps saved accounts)", icon: "x", danger: true, onClick: async () => {
    const r = await atom.profiles.logout(prov).catch((e) => ({ ok: false, detail: e.message }));
    if (r.ok) { toast(r.savedAs ? `Signed out — “${r.savedAs}” stays saved` : "Signed out", "key"); setTimeout(() => { refreshAuthBanner(); renderTabs(); }, 300); }
    else toast(r.detail || "Sign out failed", "alert");
  } });
  const rect = anchor.getBoundingClientRect();
  showContextMenu(rect.left, rect.bottom + 4, items);
}
// Live countdown for a rate-limited session's auto-retry — updates just the
// banner text each second (no full re-render), self-stops when the wait ends.
export let _rateTicker = null;
export function startRateTicker() {
  if (_rateTicker) return;
  _rateTicker = setInterval(() => {
    const ts = activeTS();
    const el = document.querySelector(".rate-countdown");
    if (!ts || ts.meta.status !== "ratelimited" || !ts.meta.rateResumeAt || !el) { clearInterval(_rateTicker); _rateTicker = null; return; }
    const secs = Math.max(0, Math.round((ts.meta.rateResumeAt - Date.now()) / 1000));
    el.textContent = `Rate limited — auto-retrying in ${secs}s. Your message and context are preserved.`;
  }, 1000);
}
/* Custom theme-aware tooltips. Any element with [data-tip] gets one; [data-tip-dir]
   = top | bottom | left | right (default top). Used for the timeline dots (left)
   and copy buttons (top). */
export function initTooltips() {
  if (document.getElementById("tooltip")) return;
  const tip = h("div", { id: "tooltip", class: "tooltip" });
  document.body.appendChild(tip);
  let timer = null, cur = null;
  const hide = () => { clearTimeout(timer); tip.classList.remove("show"); cur = null; };
  const show = (el) => {
    const text = el.getAttribute("data-tip"); if (!text) return;
    const dir = el.getAttribute("data-tip-dir") || "top";
    tip.textContent = text;
    tip.className = "tooltip tip-" + dir;
    const r = el.getBoundingClientRect();
    requestAnimationFrame(() => {
      const t = tip.getBoundingClientRect();
      let x, y;
      if (dir === "left") { x = r.left - t.width - 9; y = r.top + r.height / 2 - t.height / 2; }
      else if (dir === "right") { x = r.right + 9; y = r.top + r.height / 2 - t.height / 2; }
      else if (dir === "bottom") { x = r.left + r.width / 2 - t.width / 2; y = r.bottom + 8; }
      else { x = r.left + r.width / 2 - t.width / 2; y = r.top - t.height - 8; }
      x = Math.max(6, Math.min(x, window.innerWidth - t.width - 6));
      y = Math.max(6, Math.min(y, window.innerHeight - t.height - 6));
      tip.style.left = Math.round(x) + "px"; tip.style.top = Math.round(y) + "px";
      tip.classList.add("show");
    });
  };
  document.body.addEventListener("mouseover", (e) => {
    // Any element with a native `title` is upgraded to the themed tooltip: move
    // the text to data-tip and strip `title` so the OS tooltip never shows. This
    // gives every tooltip in the app the same copy-tooltip styling.
    let el = e.target.closest("[data-tip], [title]");
    if (el && !el.hasAttribute("data-tip")) {
      const t = el.getAttribute("title");
      if (t) { el.setAttribute("data-tip", t); el.removeAttribute("title"); }
    }
    if (el === cur) return;
    clearTimeout(timer); tip.classList.remove("show"); cur = el;
    if (el) timer = setTimeout(() => show(el), 320);
  });
  document.body.addEventListener("mouseout", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el && cur === el && (!e.relatedTarget || !el.contains(e.relatedTarget))) hide();
  });
  document.body.addEventListener("mousedown", hide, true);
  // Only hide on a scroll that actually MOVES the anchored element. The chat
  // auto-scrolls as the agent streams new messages; that must NOT close a tooltip
  // anchored to a header session tab (the header doesn't scroll). Hide only when
  // the scrolled container actually contains the current anchor.
  window.addEventListener("scroll", (e) => {
    if (!cur) return;
    const t = e.target;
    if (t === document || t === window || (t && t.contains && t.contains(cur))) hide();
  }, true);
}
// Resolve a chat file reference (absolute, or relative to the tab's project) and
// open it in the editor at the requested line. A `:line` suffix glued to the path
// is split off here as well (models write `src/a.js:12` inside code spans).
export async function openChatFileLink(rawPath, line) {
  let p = String(rawPath || "").trim();
  if (!p) return;
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(p);
  if (m && !/^[a-zA-Z]:$/.test(m[1])) { p = m[1]; if (!line) line = +m[2]; }
  const ts = activeTS();
  const cwd = (ts && ts.meta.cwd) || state.project || "";
  const isAbs = /^[a-zA-Z]:[\\/]|^\\\\|^\//.test(p);
  const full = isAbs ? p : (cwd ? cwd.replace(/[\\/]+$/, "") + "/" + p.replace(/^[.][\\/]/, "") : p);
  try { await openInEditor(full); } catch { toast("Could not open " + full, "alert"); return; }
  if (line > 0) { try { if (await waitForEditor(full)) cm.gotoLine(line, 1); } catch { /* opened without positioning */ } }
}
/* chat-level click delegation */
export function wireChatDelegation() {
  $("chat").addEventListener("click", (e) => {
    const copyBtn = e.target.closest(".codeblock-copy");
    if (copyBtn) {
      const code = copyBtn.closest(".codeblock").querySelector("code");
      copyText(code ? code.textContent : "", "Code copied");
      return;
    }
    // In-app file links ([label](path:line) and path-shaped inline code) open the
    // editor at that location; only http(s) targets leave the app. Nothing here is
    // ever passed to a shell.
    const fileLink = e.target.closest(".md-file");
    if (fileLink) { e.preventDefault(); openChatFileLink(fileLink.dataset.path, +fileLink.dataset.line || 0); return; }
    const fp = e.target.closest(".md-fp");
    if (fp && fp.dataset.fp) { e.preventDefault(); openChatFileLink(fp.dataset.fp, 0); return; }
    const link = e.target.closest(".md-link");
    if (link) { e.preventDefault(); const href = link.dataset.href || ""; if (/^https?:\/\//i.test(href)) atom.shell.openExternal(href); return; }
    const th = e.target.closest(".thinking-head");
    if (th) { th.closest(".thinking-card").classList.toggle("open"); return; }
    const tool = e.target.closest(".tool-head");
    if (tool) {
      const card = tool.closest(".tool-card");
      const open = card.classList.toggle("open");
      if (open && card.dataset.detailStale) { const ts = activeTS(); revealToolDetail(card, ts && ts.messages.find((x) => x.id === card.dataset.mid)); }
      return;
    }
  });
  // Right-click in the conversation → Copy the current text selection (and/or the
  // whole message you clicked on).
  $("chat").addEventListener("contextmenu", (e) => {
    const sel = (window.getSelection && String(window.getSelection())) || "";
    const items = [];
    if (sel.trim()) { const selHtml = selectionHtml(); items.push({ label: "Copy", icon: "copy", onClick: () => copyText(sel, "Copied", selHtml ? styleRichHtml(selHtml) : null) }); }
    const msgEl = e.target.closest(".msg[data-mid]");
    if (msgEl) {
      const ts = activeTS();
      const m = ts && ts.messages.find((x) => x.id === msgEl.dataset.mid);
      if (m && m.text) items.push({ label: sel.trim() ? "Copy whole message" : "Copy message", icon: "copy", onClick: () => copyText(m.text, "Message copied", mdToRichHtml(m.text)) });
      // Rewind file edits back to the state at this user turn (SDK file checkpoints).
      // Works only while that turn is still running — the checkpoints live in the
      // active CLI process; otherwise the app's Checkpoints panel is the anytime undo.
      if (m && m.role === "user" && ts) items.push({ label: "Rewind files to here", icon: "undo", onClick: async () => {
        const r = await atom.sessions.rewind(ts.meta.id, m.id).catch((err) => ({ ok: false, detail: err && err.message }));
        if (r && r.ok) toast("Files rewound to this point", "undo");
        else toast((r && r.detail) || "Rewind unavailable — use Checkpoints for an idle session", "alert");
      } });
    }
    if (!items.length) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, items);
  });
}
