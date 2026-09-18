"use strict";
/* Anthropic primary — SDK message stream → the canonical record and renderer events.
 *
 * handleMessage turns every SDK message (init, stream deltas, tool calls / results, background
 * task lifecycle, result) into session messages + IPC events; the task bookkeeping keeps the run's
 * input open while background agents are alive (ending it makes the CLI refuse every later tool). */
const path = require("path");
const store = require("../storage/store");
const history = require("../storage/history");
const { partialToolInput } = require("./tool-args");
const { isPromptTooLong } = require("./errors");
const { STREAM_ARGS_MS, STREAM_ARGS_SCAN_MAX, excerptArgs, scanJsonState, EDIT_TOOLS, toolResultText, computeDiff, sumModelUsage } = require("./tools");
const agentsMod = require("../agents/subagents");
const A_TERMINAL = agentsMod.TERMINAL;

// Background-task lifecycle events the SDK delivers as `system` messages (see SDKTaskStartedMessage …).
const TASK_EVENT_SUBTYPES = new Set(["task_started", "task_progress", "task_notification", "task_updated", "background_tasks_changed"]);

const methods = {
  handleMessage(session, m, runner) {
    const sessionId = session.id;
    // Preserve a cancelled command's actual outcome during graceful drain, even if the next
    // turn has reserved the slot. Only an existing tool card owned by this run may change.
    if (runner && runner.interrupted && m.type === "user") {
      for (const b of (m.message && m.message.content) || []) {
        if (!b || b.type !== "tool_result") continue;
        const target = session.messages.find((x) => x.role === "tool" && x.toolUseId === b.tool_use_id && x.runId === runner.id);
        if (target) this.updateMessage(session, target.id, { status: target.status === "done" ? "done" : "interrupted", result: toolResultText(b.content), endedTs: store.nowISO() });
      }
      return;
    }
    if (runner && runner.id) {
      const owner = this.runners.get(sessionId);
      const latest = this._lastRunId && this._lastRunId.get(sessionId);
      if ((owner && owner !== runner) || (latest && latest !== runner.id)) return;
    }
    // Graceful Stop can still deliver the cancelled tool's result. It cannot bind a late
    // init, acknowledge a new prompt, publish output, or alter the replacement's context.
    if (runner && runner.interrupted) {
      if (m.type === "result") { runner.resultSeen = true; if (runner.releaseInput) runner.releaseInput(); }
      return;
    }
    const parent = m.parent_tool_use_id || null;   // non-null: produced inside a subagent
    // Anything the model produced for this turn (text, thinking, a tool call, a tool result):
    // a `result` arriving BEFORE any of it is not this turn's end (see the "result" case).
    if (runner && (m.type === "assistant" || m.type === "user" || m.type === "stream_event" || m.type === "tool_progress")) {
      runner.sawOutput = true;
      // The CLI is producing output again (a wake-up turn after a task reported): its own result
      // decides when the input ends — cancel any release that an earlier result scheduled.
      if (runner._taskIdle) { clearTimeout(runner._taskIdle); runner._taskIdle = null; }
      if (runner._releaseTimer) { clearTimeout(runner._releaseTimer); runner._releaseTimer = null; }
      // Output means the API answered: a "requesting" / "retrying" / "preparing" live label is over.
      if (runner.live && (runner.live.retry || runner.live.status === "requesting" || runner.live.status === "preparing")) this.setLive(session, runner, { retry: null, status: null, label: null });
    }
    // Background-task lifecycle arrives as SYSTEM messages with these subtypes (SDKTaskStartedMessage
    // etc. — never as top-level types); route them to the task handler by their subtype.
    const kind = m.type === "system" && TASK_EVENT_SUBTYPES.has(m.subtype) ? m.subtype : m.type;
    switch (kind) {
      case "system":
        if (m.subtype === "init") {
          // After a conversation_reset in THIS run the CLI's active conversation is the fresh one: an init (or
          // result) that still names a RETIRED conversation's id — ANY conversation this run reset away from, not
          // only the last one (with just the last remembered, two resets then an init naming the first rebound it,
          // 2026-09-18) — is late output of a cleared context. Decided BEFORE either binding branch: the replacement
          // branch below used to bind whatever id it was handed, so a reset followed by an init naming the old
          // conversation rebound the old thread during a rollover (2026-09-18). A retired id binds nothing, ends no
          // pending replacement (freshThread stays), commits nothing and is no acceptance.
          const clearedId = !!(runner && runner.retiredIds instanceof Set && m.session_id && runner.retiredIds.has(m.session_id));
          if (runner && runner.freshThread && m.session_id && !clearedId) {
            // A REPLACEMENT native session (rollover / overflow / lost session) accepted its input: only
            // now does it take the binding over from the thread it replaces — with a reset cursor and
            // measurement. A failure before this point left the previous thread bound and resumable.
            runner.freshThread = false;
            history.setBinding(session, "anthropic", { id: m.session_id, syncedIndex: -1, account: "", activeTokens: 0, ctxUsage: null });
          } else if (m.session_id && !clearedId) history.setBinding(session, "anthropic", { id: m.session_id });
          if (m.model) this.registerModel(m.model);
          // The CLI accepted this turn's input: the native session now holds the current prompt
          // (and whatever record was transferred with it). Acknowledge that on the cursor NOW, so a
          // later stop/failure never re-transfers an accepted prompt (see finalizeRun) — and record what
          // the session now holds of the delivery cache: the frozen attempt's skills hash (index.js
          // commitAttempt), so the next turn sends a pointer instead of the procedures. The guards above
          // (owner / latest run, interrupted) keep a late init of a stopped or replaced run from doing either.
          // After a conversation_reset of this run NOTHING is committed by this run any more: the attempt was
          // composed for the OLD context and is retired with it (runner.attempt = null — its frozen hash must never
          // be recommitted, it certifies procedures the fresh context never received); the fresh context holds
          // none of the record and none of the procedures, so the NEXT user turn's attempt is that context's first
          // (no accepted hash → the digests in full; cursor −1 → the record transfers) and ITS init commits.
          if (runner && !clearedId && !runner.resetSeen) {
            runner.accepted = true;
            const b = history.bindingFor(session, "anthropic");
            this.commitAttempt(session, "anthropic", runner, Number.isFinite(runner.promptIndex) && b.syncedIndex < runner.promptIndex ? { syncedIndex: runner.promptIndex } : null);
          }
          if (this._lastRun && this._lastRun.sessionId === sessionId) this._lastRun.init = { model: m.model, permissionMode: m.permissionMode, mcpServers: (m.mcp_servers || []).map((s) => `${s.name}:${s.status}`), toolCount: (m.tools || []).length };
        } else if (m.subtype === "compact_boundary") {
          // Claude compacted its own context: record it (telemetry + a visible note) — the native
          // session continues; the app keeps its complete record.
          const cm = m.compact_metadata || {};
          const b = history.bindingFor(session, "anthropic");
          history.setBinding(session, "anthropic", { compactions: (b.compactions || 0) + 1, lastCompaction: { trigger: cm.trigger || "auto", preTokens: cm.pre_tokens || 0, postTokens: cm.post_tokens || null, ts: store.nowISO() }, ...(cm.post_tokens ? { activeTokens: cm.post_tokens } : {}) });
          if (this._lastRun && this._lastRun.sessionId === sessionId) this._lastRun.compactions = (this._lastRun.compactions || 0) + 1;
          this.addMessage(session, { id: store.uid(), role: "system", text: `Claude compacted its context (${cm.trigger === "manual" ? "requested" : "automatic"}${cm.pre_tokens ? `, ${Number(cm.pre_tokens).toLocaleString("en-US")} tokens before` : ""}${cm.post_tokens ? `, ${Number(cm.post_tokens).toLocaleString("en-US")} after` : ""}). The complete record stays in this chat.`, ts: store.nowISO() });
        } else if (m.subtype === "status") {
          // Transient phase the CLI is in (compacting its context / waiting for the API): shown as
          // the live label instead of a bare "Thinking"; a failed compaction is said out loud.
          this.setLive(session, runner, { status: m.status || null });
          if (m.compact_result === "failed") this.addMessage(session, { id: store.uid(), role: "system", text: `Claude's context compaction failed${m.compact_error ? ": " + m.compact_error : ""}. The turn continues with the full context.`, ts: store.nowISO() });
        } else if (m.subtype === "api_retry") {
          // The CLI retries the API call itself (overloaded / rate limit / server error): the label
          // says so with the attempt count, and one note per turn explains the wait.
          const why = String(m.error || "").replace(/_/g, " ");
          this.setLive(session, runner, { retry: { attempt: m.attempt || 1, max: m.max_retries || 0, delayMs: m.retry_delay_ms || 0, error: why, status: m.error_status || null } });
          if (runner && !runner._retryNoted) { runner._retryNoted = true; this.addMessage(session, { id: store.uid(), role: "system", text: `Claude's API call is being retried${m.max_retries ? ` (attempt ${m.attempt || 1} of ${m.max_retries})` : ""}${why ? " — " + why : ""}${m.error_status ? ` (HTTP ${m.error_status})` : ""}. Your turn is unchanged; this can take a moment.`, ts: store.nowISO() }); }
        } else if (m.subtype === "model_refusal_fallback") {
          const what = m.api_refusal_category ? ` (${String(m.api_refusal_category).replace(/_/g, " ")})` : "";
          this.addMessage(session, { id: store.uid(), role: "system", text: `Safeguards flagged the request${what}; Claude retried it on ${m.fallback_model}${m.scope === "local" ? " for that sub-task only" : " for the rest of this session"}.${m.api_refusal_explanation ? " " + m.api_refusal_explanation : m.content ? " " + m.content : ""}`, ts: store.nowISO() });
        } else if (m.subtype === "model_refusal_no_fallback") {
          const what = m.api_refusal_category ? ` (${String(m.api_refusal_category).replace(/_/g, " ")})` : "";
          this.addMessage(session, { id: store.uid(), role: "system", text: `Claude declined this request${what}.${m.api_refusal_explanation ? " " + m.api_refusal_explanation : m.content ? " " + m.content : ""} No fallback model is configured, so the turn ends here.`, ts: store.nowISO() });
        } else if (m.subtype === "permission_denied") {
          // Auto-denied without a prompt (a deny rule, dontAsk / auto mode): the user never saw a
          // card, so say which tool was refused and why.
          const agentN = m.agent_id && this.agentNumberFor ? this.agentNumberFor(sessionId, m.agent_id, m.tool_use_id) : null;
          this.addMessage(session, { id: store.uid(), role: "system", text: `${agentN ? `Agent #${agentN}: ` : ""}${m.tool_name} was denied automatically${m.decision_reason ? ` — ${m.decision_reason}` : m.decision_reason_type ? ` (${String(m.decision_reason_type).replace(/_/g, " ")})` : ""}.${m.message ? " " + m.message : ""}`, ts: store.nowISO() });
        } else if (m.subtype === "informational") {
          if (m.content) this.addMessage(session, { id: store.uid(), role: "system", text: `${m.level === "warning" ? "Warning: " : ""}${m.content}`, ts: store.nowISO() });
        } else if (m.subtype === "notification") {
          if (m.text && m.priority !== "low") this.send("session:notice", { sessionId, text: String(m.text), priority: m.priority || "medium", key: m.key || "" });
        } else if (m.subtype === "mirror_error") {
          console.warn("[claude:mirror]", m.error);
        }
        // session_state_changed / thinking_tokens / commands_changed / hook_* carry nothing the chat shows.
        return;

      case "tool_use_summary": {
        // The model's own one-line account of a batch of tool calls: kept on the last card of the batch.
        const ids = Array.isArray(m.preceding_tool_use_ids) ? m.preceding_tool_use_ids : [];
        const lastId = ids[ids.length - 1];
        const target = lastId ? [...session.messages].reverse().find((x) => x.role === "tool" && x.toolUseId === lastId) : null;
        if (target && m.summary) this.updateMessage(session, target.id, { aiSummary: String(m.summary), aiSummaryCovers: ids.length });
        return;
      }
      case "auth_status": {
        this.setLive(session, runner, { auth: !!m.isAuthenticating });
        if (m.error) this.addMessage(session, { id: store.uid(), role: "system", text: `Claude sign-in problem: ${m.error}`, ts: store.nowISO() });
        return;
      }
      case "conversation_reset": {
        /* /clear inside the CLI, a plan-mode exit or a fresh-session flow (SDKConversationResetMessage): the CLI mounts
         * a NEW conversation under new_conversation_id — a context that has seen NOTHING of this chat: not the record
         * this run transferred, not the skill procedures it delivered (2026-09-18) — and KEEPS WORKING ON THE CURRENT
         * TASK in it, as it compacted it. NOTHING IS INJECTED MID-RUN (decision 2026-09-18, after the round-3 review:
         * a restore written onto the run's own input stream could land after the task had finished, was acknowledged
         * by an init before the CLI had consumed it, was not bound to its query generation and had no final budget
         * check). Instead:
         *   - bind the fresh id NOW with the cursor at −1: nothing claims the fresh context holds anything. The id
         *     change makes history.setBinding drop skillsHash / briefHash / briefKinds (they belong to the thread);
         *     with no new id reported, or the same one, they are dropped explicitly below;
         *   - retire the run's frozen attempt (runner.attempt = null) and its acceptance: the attempt was composed
         *     FOR THE OLD CONTEXT — a pointer attempt certifies procedures the fresh context never got — so its hash
         *     is never committed by this run (init / result / run end all check resetSeen);
         *   - remember EVERY id this run reset away from (retiredIds — the bound id and the one the message names):
         *     a later init / result of this run naming any of them is late output of a cleared context and rebinds
         *     nothing. Only the LAST one used to be kept, so two resets then an init naming the first rebound it.
         * The current turn finishes in the fresh context as the CLI left it; the run's end does not advance the
         * cursor (anthropic.js). The NEXT user turn's attempt is composed for the fresh context — no accepted hash →
         * the digests in full, cursor −1 → the whole record transfers — and its init commits hash + cursor to the new
         * id. The role / agents briefs are unaffected: Claude gets them in systemPrompt.append on every request. */
        const prevId = history.bindingFor(session, "anthropic").id || null;
        const fresh = m.new_conversation_id || m.session_id || null;
        const b = history.setBinding(session, "anthropic", { ...(fresh ? { id: fresh } : {}), syncedIndex: -1, account: "", activeTokens: 0, activeTokensTs: store.nowISO(), ctxUsage: null });
        if (!fresh || fresh === prevId) { delete b.skillsHash; delete b.briefHash; delete b.briefKinds; }   // no new id reported (setBinding drops them only on an id change): the caches still describe the cleared context
        if (runner) {
          runner.attempt = null; runner.accepted = false; runner.resetSeen = true;
          for (const retired of [prevId, m.session_id]) if (retired && retired !== fresh) (runner.retiredIds ||= new Set()).add(retired);
        }
        if (this._lastRun && this._lastRun.sessionId === sessionId) this._lastRun.conversationReset = fresh || true;
        this.addMessage(session, { id: store.uid(), role: "system", text: "Claude started a fresh conversation context (/clear). The complete record stays in this chat.", ts: store.nowISO() });
        return;
      }
      case "rate_limit_event": {
        const info = m.rate_limit_info || {};
        if (info.status === "rejected" && runner && !runner._rateNoted) {
          runner._rateNoted = true;
          const when = info.resetsAt ? new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toLocaleString() : "";
          this.addMessage(session, { id: store.uid(), role: "system", text: `Claude usage limit reached${info.rateLimitType ? ` (${String(info.rateLimitType).replace(/_/g, " ")})` : ""}${when ? `; it resets ${when}` : ""}.`, ts: store.nowISO() });
        }
        return;
      }

      case "prompt_suggestion":
        if (m.suggestion) this.send("session:prompt-suggestion", { sessionId, suggestion: String(m.suggestion) });
        return;

      case "stream_event": {
        const ev = m.event;
        if (!ev) return;
        if (parent) {
          // Subagent output streams into ITS Task card, never the main reply.
          if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") this.send("session:partial", { sessionId, index: ev.index, kind: "text", delta: ev.delta.text, parent });
          return;
        }
        if (ev.type === "message_start") { this.send("session:partial-reset", { sessionId }); return; }
        // Earliest tool visibility: a tool_use block starting is already a card
        // ("preparing"), and its streamed JSON arguments fill the card in as they arrive.
        if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "tool_use") {
          const b = ev.content_block;
          const existing = session.messages.find((x) => x.role === "tool" && x.toolUseId === b.id);
          if (!existing) {
            const mid = store.uid();
            (runner && (runner.streamTools = runner.streamTools || new Map()) || new Map()).set(ev.index, { id: mid, toolUseId: b.id, json: "" });
            // A sub-agent is numbered the moment it is announced — the card carries the number.
            const agent = this.isAgentTool(b.name) ? this.agentAnnounce(session, runner, { toolUseId: b.id, msgId: mid, input: b.input, status: "queued" }).agent : null;
            this.addMessage(session, { id: mid, role: "tool", toolName: b.name, toolUseId: b.id, runId: runner ? runner.id : undefined, toolInput: b.input && Object.keys(b.input).length ? b.input : {}, status: "preparing", ts: store.nowISO(), ...(agent ? { agentN: agent.n } : {}) });
          }
          return;
        }
        if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta") this.send("session:partial", { sessionId, index: ev.index, kind: "text", delta: ev.delta.text });
          else if (ev.delta.type === "thinking_delta") this.send("session:partial", { sessionId, index: ev.index, kind: "thinking", delta: ev.delta.thinking });
          else if (ev.delta.type === "input_json_delta" && runner && runner.streamTools) {
            const st = runner.streamTools.get(ev.index);
            if (st) {
              const frag = ev.delta.partial_json || "";
              st.json += frag;
              // The complete object is persisted the moment it closes (an incremental brace/string
              // scan — no re-parse of the whole body per fragment). Before that the arguments are shown
              // as they take shape, COALESCED: at most one renderer update per STREAM_ARGS_MS per card,
              // carrying the top-level fields that have fully arrived (file_path, command, pattern …)
              // and a bounded excerpt of the raw JSON. (Sending the whole growing body on every fragment
              // cost O(n²) bytes over IPC and a full re-layout per fragment for a large Write.)
              if (scanJsonState(st, frag)) {
                if (st.timer) { clearTimeout(st.timer); st.timer = null; }
                try { const parsed = JSON.parse(st.json); st.dirty = false; this.updateMessage(session, st.id, { toolInput: parsed, partialInput: undefined, partialBytes: undefined }); return; } catch { /* not valid yet — keep streaming */ }
              }
              st.dirty = true;
              if (!st.timer) st.timer = setTimeout(() => { st.timer = null; this.flushStreamArgs(session, runner, ev.index, st); }, STREAM_ARGS_MS);
            }
          }
        }
        return;
      }

      case "tool_progress": {
        // Elapsed-time heartbeat for a running tool (NOT stdout) — the card shows it is alive.
        const target = [...session.messages].reverse().find((x) => x.role === "tool" && x.toolUseId === m.tool_use_id);
        if (target && (target.status === "queued" || target.status === "preparing")) this.markToolStarted(session, runner, m.tool_use_id);   // a heartbeat proves it runs
        if (target) this.send("session:message-update", { sessionId, messageId: target.id, patch: { elapsedSeconds: m.elapsed_time_seconds, taskId: m.task_id || undefined, subagentType: m.subagent_type || undefined } });
        if (target && this.isAgentTool(target.toolName)) { const a = this.agentFind(session, { toolUseId: m.tool_use_id }); if (a) this.agentPatch(session, a, { status: A_TERMINAL.has(a.status) ? a.status : "running", elapsedSeconds: m.elapsed_time_seconds, ...(m.task_id ? { taskId: m.task_id } : {}), ...(m.subagent_type ? { type: m.subagent_type } : {}) }); }
        return;
      }
      case "background_tasks_changed": {
        // Authoritative live set (REPLACE semantics). Ambient tasks (watchers) are not activity.
        if (runner) this.syncTasks(session, runner, (Array.isArray(m.tasks) ? m.tasks : []).filter((t) => t && !t.ambient).map((t) => [t.task_id, t.description || ""]));
        return;
      }
      case "task_updated": return;   // backgrounding / rename patches — the set itself is tracked via the other events
      case "task_started": case "task_progress": case "task_notification": {
        // Native background tasks (background Bash, local agents, workflows): lifecycle on the tool
        // card that owns them, and the run's "still busy" set — live background work keeps the input
        // stream open past a turn's result (see the "result" case) until everything has reported.
        const tid = m.task_id;
        const target = tid ? [...session.messages].reverse().find((x) => x.role === "tool" && (x.taskId === tid || x.toolUseId === m.tool_use_id)) : null;
        const patch = { taskId: tid };
        if (kind === "task_started" && runner && tid) this.syncTasks(session, runner, [...(runner.activeTasks || new Map()).entries(), [tid, m.description || ""]]);
        if (kind === "task_notification" && runner && tid && runner.activeTasks) this.syncTasks(session, runner, [...runner.activeTasks.entries()].filter(([id]) => id !== tid));
        if (kind === "task_started") { patch.background = m.is_backgrounded !== false; patch.progress = m.description || "started in the background"; }
        if (kind === "task_progress") patch.progress = m.description || m.summary || "running…";
        if (kind === "task_notification") { patch.status = m.status === "failed" ? "error" : "done"; patch.result = m.summary || m.description || (m.status === "failed" ? "Background task failed." : "Background task completed."); patch.endedTs = store.nowISO(); if (m.output_file) patch.outputFile = m.output_file; }
        if (target) this.updateMessage(session, target.id, patch);
        else if (kind === "task_notification") this.addMessage(session, { id: store.uid(), role: "system", text: `Background task ${m.status === "failed" ? "failed" : "finished"}${m.summary ? ": " + m.summary : ""}`, ts: store.nowISO() });
        // Sub-agent registry: a local_agent task (or a task whose tool card is a Task) is an agent.
        if (tid && (m.task_type === "local_agent" || (target && this.isAgentTool(target.toolName)) || m.subagent_type)) {
          const a = this.agentFind(session, { taskId: tid }) || (m.tool_use_id ? this.agentFind(session, { toolUseId: m.tool_use_id }) : null) || (target ? this.agentFind(session, { toolUseId: target.toolUseId }) : null) || this.agentAnnounce(session, runner, { toolUseId: m.tool_use_id || null, msgId: target ? target.id : null, input: { description: m.description, subagent_type: m.subagent_type, prompt: m.prompt }, status: "running" }).agent;
          const u = m.usage || {};
          if (kind === "task_started") this.agentPatch(session, a, { taskId: tid, status: "running", background: m.is_backgrounded !== false, ...(m.spawn_depth ? { depth: m.spawn_depth } : {}), ...(m.subagent_type ? { type: m.subagent_type } : {}), ...(m.description ? { description: m.description } : {}), ...(m.prompt ? { prompt: m.prompt } : {}) });
          else if (kind === "task_progress") this.agentPatch(session, a, { taskId: tid, status: "running", progress: m.summary || m.description || a.progress, lastTool: m.last_tool_name || a.lastTool, toolUses: u.tool_uses || 0, tokens: u.total_tokens || 0, durationMs: u.duration_ms || 0 });
          else if (kind === "task_notification") this.agentPatch(session, a, { taskId: tid, status: m.status === "failed" ? "error" : m.status === "stopped" ? "stopped" : "done", result: m.summary || a.result, outputFile: m.output_file || a.outputFile, toolUses: u.tool_uses || 0, tokens: u.total_tokens || 0, durationMs: u.duration_ms || 0 });
        }
        return;
      }

      case "assistant": {
        const blocks = (m.message && m.message.content) || [];
        // The reply was cut at the output-token ceiling: say so once (the text card above ends mid-way).
        if ((m.error === "max_output_tokens" || (m.message && m.message.stop_reason === "max_tokens")) && !parent && runner && !runner._maxOutNoted) {
          runner._maxOutNoted = true;
          this.addMessage(session, { id: store.uid(), role: "system", text: "The reply reached the model's output-token limit and was cut off. Ask it to continue.", ts: store.nowISO() });
        }
        for (const b of blocks) {
          if (b.type === "text" && b.text) {
            this.addMessage(session, { id: store.uid(), role: "assistant", text: b.text, ts: store.nowISO(), meta: session._replyMeta || null, ...(parent ? { parentToolUseId: parent } : {}) });
          } else if (b.type === "thinking" && b.thinking) {
            this.addMessage(session, { id: store.uid(), role: "thinking", text: b.thinking, ts: store.nowISO(), ...(parent ? { parentToolUseId: parent } : {}) });
          } else if (b.type === "tool_use") {
            let filePath = b.input && (b.input.file_path || b.input.notebook_path || b.input.file || b.input.path);
            if (filePath && session.cwd && !path.isAbsolute(filePath)) filePath = path.join(session.cwd, filePath);
            if (EDIT_TOOLS.has(b.name)) this.trackEdit(session, filePath, b.name, computeDiff(b.name, b.input));
            // Upsert: the card may already exist from content_block_start. With the PreToolUse hook
            // active the card WAITS ("queued") until the CLI starts the tool — tools announced
            // together run one after another when a command is among them.
            const started = !!(runner && runner.startedTools && runner.startedTools.has(b.id));
            const status = started || !(runner && runner.hooksActive) ? "running" : "queued";
            const existing = session.messages.find((x) => x.role === "tool" && x.toolUseId === b.id);
            const mid = existing ? existing.id : store.uid();
            // Sub-agent registry: the full input (description, prompt, type, background) is known now.
            const agent = this.isAgentTool(b.name) ? this.agentAnnounce(session, runner, { toolUseId: b.id, msgId: mid, input: b.input, parentToolUseId: parent, status: started ? "running" : "queued" }).agent : null;
            if (existing) this.updateMessage(session, existing.id, { toolName: b.name, toolInput: b.input, status, partialInput: undefined, partialBytes: undefined, ...(agent ? { agentN: agent.n } : {}) });
            else this.addMessage(session, { id: mid, role: "tool", toolName: b.name, toolUseId: b.id, runId: runner ? runner.id : undefined, toolInput: b.input, status, ts: store.nowISO(), ...(parent ? { parentToolUseId: parent } : {}), ...(agent ? { agentN: agent.n } : {}) });
          }
        }
        if (!parent) this.send("session:partial-reset", { sessionId });
        this.clearStreamTools(runner);
        return;
      }

      case "user": {
        const blocks = (m.message && m.message.content) || [];
        for (const b of blocks) {
          if (b && b.type === "tool_result") {
            const target = [...session.messages].reverse().find((x) => x.role === "tool" && x.toolUseId === b.tool_use_id);
            // A tool cancelled by Stop keeps its "interrupted" state; its (interrupted) result text is kept.
            const cancelled = runner && runner.interrupted && target && target.status === "interrupted";
            const patch = { status: cancelled ? "interrupted" : (b.is_error ? "error" : "done"), result: toolResultText(b.content), endedTs: store.nowISO() };
            if (target) this.updateMessage(session, target.id, patch);
            // A foreground agent ends with its tool_result; a backgrounded one only got the launch
            // placeholder here and reports later through task_notification.
            if (target && this.isAgentTool(target.toolName)) {
              const a = this.agentFind(session, { toolUseId: b.tool_use_id });
              if (a && !a.background && !agentsMod.looksBackgrounded(patch.result)) this.agentPatch(session, a, { status: cancelled ? "interrupted" : (b.is_error ? "error" : "done"), result: patch.result });
              else if (a) this.agentPatch(session, a, { background: true, status: "running" });
            }
          }
        }
        return;
      }

      case "result": {
        // A ZERO-TURN success result BEFORE any output of this turn is the CLI finalising something
        // else (on resume it closes a queued task notification that way: num_turns 0, ~50 ms) — not
        // this turn's end. Nothing is recorded for it and the input stream stays open, so permission
        // prompts keep working. A genuine result always has turns (or is an error).
        if (runner && !runner.sawOutput && !m.is_error && m.num_turns === 0) {
          runner.earlyResults = (runner.earlyResults || 0) + 1;
          console.warn(`[claude:run] early result ignored (no output yet; subtype=${m.subtype}, turns=${m.num_turns})`);
          return;
        }
        // (A result of a run whose conversation was reset never rebinds a RETIRED conversation's id — see conversation_reset.)
        if (m.session_id && !(runner && runner.retiredIds instanceof Set && runner.retiredIds.has(m.session_id))) history.setBinding(session, "anthropic", { id: m.session_id });
        // Structured overload/rate-limit termination arrives as an ERROR RESULT with
        // api_error_status → the same preserve-turn + backoff retry as a thrown error.
        if (m.is_error && (m.api_error_status === 429 || m.api_error_status === 529)) {
          const err = new Error(`Claude API ${m.api_error_status} — overloaded/rate-limited, auto-retrying`);
          err.api_error_status = m.api_error_status;
          throw err;
        }
        // "Prompt is too long" arrives as an error RESULT: hand it to the run so it can start
        // a new native session with a summarised record instead of failing the turn.
        if (m.is_error && isPromptTooLong(String(m.result || "") + " " + (Array.isArray(m.errors) ? m.errors.map(String).join(" ") : ""))) {
          const err = new Error("Claude rejected the request as too large for the model's context window: " + String(m.result || (Array.isArray(m.errors) && m.errors[0]) || "prompt is too long"));
          err.promptTooLong = true;
          throw err;
        }
        if (runner) runner.resultSeen = true;
        session.totalCostUsd = (session.totalCostUsd || 0) + (m.total_cost_usd || 0);
        const turnUsage = sumModelUsage(m.modelUsage);
        if (turnUsage) {
          session.totalTokensIn = (session.totalTokensIn || 0) + turnUsage.inputTokens + turnUsage.cacheReadInputTokens + turnUsage.cacheCreationInputTokens;
          session.totalTokensOut = (session.totalTokensOut || 0) + turnUsage.outputTokens;
        } else if (m.usage) {
          session.totalTokensIn = (session.totalTokensIn || 0) + (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
          session.totalTokensOut = (session.totalTokensOut || 0) + (m.usage.output_tokens || 0);
        }
        const meta = {
          subtype: m.subtype, isError: !!m.is_error,
          costUsd: m.total_cost_usd || 0, totalCostUsd: session.totalCostUsd,
          durationMs: m.duration_ms || 0, numTurns: m.num_turns || 0,
          usage: m.usage || null, modelUsage: m.modelUsage || null, turnUsage: turnUsage || null,
          provider: "anthropic",
        };
        // Active native context ≈ the last request's full input (uncached + cache read + cache
        // creation). Remembered on the binding so a later partial transfer into THIS thread
        // budgets against what the thread already holds.
        if (m.usage && !m.is_error) {
          const active = (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
          if (active > 0) history.setBinding(session, "anthropic", { activeTokens: active, activeTokensTs: store.nowISO() });
          // The context window the CLI actually used for THIS session's model (modelUsage[model]
          // .contextWindow — 1M when the model has it natively or the beta was honoured, 200K when
          // not): remembered per model + 1M choice, so budgets and the rollover decision compare the
          // measured fill against the real window rather than the catalog's guess.
          // Recorded only while THIS run still owns the session and its dispatch scope (model + 1M
          // choice, snapshotted on the runner) is still the session's — a result that lands after a
          // replacement run or a scope change describes a thread / scope that is no longer current.
          if (m.modelUsage && this.noteReportedWindow && (!runner || !this.measurementCurrent || this.measurementCurrent(session, runner))) {
            const want = (runner && runner.model) || session.model || "";
            const keys = Object.keys(m.modelUsage);
            const key = keys.find((k) => k === want) || keys.find((k) => m.modelUsage[k] && m.modelUsage[k].canonicalModel === want) || (keys.length === 1 && (!want || runner) ? keys[0] : null);
            const mu = key ? m.modelUsage[key] : null;
            if (mu && mu.contextWindow > 0) this.noteReportedWindow(session, "anthropic", want || key, mu.contextWindow, { source: "modelUsage", cliModel: key, ...(runner && typeof runner.oneM === "boolean" ? { oneM: runner.oneM } : {}) });
          }
          // The CLI's own measurement of how full the context is (answered from this response's
          // usage) — the chip and the rollover decision prefer it over the estimate above.
          if (runner && !runner.interrupted) this.captureContextUsage(session, runner);
          else this.send("session:context", { sessionId, info: this.contextInfo(sessionId) });
        }
        // This turn is over. The input stream is released only when NO background work the CLI
        // started is alive (background Bash, agents, workflows, monitors): with the stream ended the
        // CLI keeps such tasks running but can no longer reach the app for permission or hook
        // round-trips, and refuses every tool they (or the wake-up turn their report triggers) call
        // with "The user doesn't want to take this action right now". task_started for work launched
        // in this turn arrives ~1 s AFTER the result, so the release waits a grace period first.
        if (runner) { runner.resultSeen = true; this.scheduleRelease(session, runner); }
        if (runner && runner.interrupted) { store.scheduleWrite(sessionId); return; }
        // Classify BEFORE finalisation: anything that is not a clean success is a
        // failed run — error subtypes (max turns, budget, execution error) AND a
        // "success" frame flagged is_error. The run's terminal state follows this.
        const failed = !!m.is_error || (m.subtype && m.subtype !== "success");
        if (failed) {
          const detail = m.subtype && m.subtype !== "success" ? m.subtype.replace(/^error_/, "").replace(/_/g, " ") : "error";
          const errs = Array.isArray(m.errors) && m.errors.length ? " — " + m.errors.map((x) => String(x)).join("; ") : (m.result && typeof m.result === "string" && m.is_error ? " — " + m.result : "");
          this.addMessage(session, { id: store.uid(), role: "error", text: `Run ended: ${detail}${errs}`, ts: store.nowISO(), meta });
          if (runner) runner.failed = true;
        } else {
          this.addMessage(session, { id: store.uid(), role: "result", text: "", ts: store.nowISO(), meta });
          // A long-lived process (background agents alive for hours) emits many results before the
          // run ends: the rolling digest follows each of them, not only the final termination.
          // (maybeDigest guards itself: one owner per session, fill ≥ half, a dozen new entries.)
          if (runner && this.maybeDigest && runner.bindingProvider === "anthropic") this.maybeDigest(session).catch((e) => console.warn("[context:digest]", (e && e.message) || e));
        }
        store.scheduleWrite(sessionId);
        return;
      }
      default:
        return;
    }
  },

  /* Transient live state of a run (what the CLI is doing while nothing streams): compacting /
   * requesting / retrying / signing in / preparing the record (with a label). Kept on the runner,
   * sent whole to the renderer, which shows it as the typing label. A patch with only nulls clears it. */
  setLive(session, runner, patch) {
    if (!runner) return;
    // Only the run that owns the session's slot may change what the tab shows: a stopped run winding
    // down (or a replaced one) keeps its own bookkeeping but never wipes or relabels a newer run's stream.
    const cur = this.runners.get(session.id);
    if (cur && cur !== runner) return;
    const live = { status: null, retry: null, auth: false, label: null, ...(runner.live || {}), ...(patch || {}) };
    if (runner.live && live.status === runner.live.status && live.auth === runner.live.auth && live.label === runner.live.label && JSON.stringify(live.retry) === JSON.stringify(runner.live.retry)) return;
    const shown = live.status || live.retry || live.auth ? live : null;   // nothing to show = null, on the runner too (sessions:run-state reads it)
    if (!runner.live && !shown) return;
    runner.live = shown;
    this.send("session:live", { sessionId: session.id, live: shown });
  },

  /* Background-task bookkeeping for one run. `entries` = the live set [[task_id, description]].
   * While tasks are alive after a result the run stays open (note shown once); when the last one
   * reports, the CLI normally wakes the agent (a follow-up turn whose result schedules the release)
   * — if it stays quiet, the input is released after taskIdleReleaseMs. */
  syncTasks(session, runner, entries) {
    runner.activeTasks = new Map(entries);
    if (runner.activeTasks.size > 0) {
      if (runner._releaseTimer) { clearTimeout(runner._releaseTimer); runner._releaseTimer = null; }   // a result already came — hold instead
      if (runner._taskIdle) { clearTimeout(runner._taskIdle); runner._taskIdle = null; }
      if (runner.resultSeen && !runner.awaitingTasks) {
        runner.awaitingTasks = true;
        const n = runner.activeTasks.size;
        this.addMessage(session, { id: store.uid(), role: "system", text: `${n} background task${n === 1 ? "" : "s"} still running — this reply stays open until ${n === 1 ? "it reports" : "they report"} back (Stop ends ${n === 1 ? "it" : "them"}).`, ts: store.nowISO() });
      }
    } else if (runner.awaitingTasks && !runner._taskIdle && !runner.ended) {
      runner._taskIdle = setTimeout(() => { runner._taskIdle = null; if (!runner.ended && runner.releaseInput) runner.releaseInput(); }, this.taskIdleReleaseMs);
    }
  },

  // A turn's result: end the input once no background task is alive — after a grace period, because
  // task_started for work launched in the turn is delivered AFTER the result.
  scheduleRelease(session, runner) {
    if (!runner || runner.ended) return;
    if (runner.interrupted) { if (runner.releaseInput) runner.releaseInput(); return; }
    clearTimeout(runner._releaseTimer);
    runner._releaseTimer = setTimeout(() => {
      runner._releaseTimer = null;
      if (runner.ended) return;
      if (runner.activeTasks && runner.activeTasks.size > 0) { this.syncTasks(session, runner, [...runner.activeTasks.entries()]); return; }
      if (runner.releaseInput) runner.releaseInput();
    }, this.resultReleaseGraceMs);
  },

  // PreToolUse (or a first heartbeat): the CLI is running this tool now — its card leaves the queue.
  // Remembered on the runner too, for a hook that fires before the card's upsert has arrived.
  markToolStarted(session, runner, toolUseId) {
    if (!toolUseId) return;
    if (runner) (runner.startedTools = runner.startedTools || new Set()).add(toolUseId);
    const target = [...session.messages].reverse().find((x) => x.role === "tool" && x.toolUseId === toolUseId);
    if (target && (target.status === "queued" || target.status === "preparing")) this.updateMessage(session, target.id, { status: "running", startedTs: store.nowISO() });
  },

  // One coalesced update for a tool card whose arguments are still streaming (see input_json_delta).
  flushStreamArgs(session, runner, index, st) {
    if (!st || !st.dirty || !runner || !runner.streamTools || runner.streamTools.get(index) !== st) return;
    st.dirty = false;
    try { const parsed = JSON.parse(st.json); this.updateMessage(session, st.id, { toolInput: parsed, partialInput: undefined, partialBytes: undefined }); return; } catch { /* still streaming */ }
    const known = st.json.length <= STREAM_ARGS_SCAN_MAX ? partialToolInput(st.json) : {};
    this.send("session:message-update", { sessionId: session.id, messageId: st.id, patch: { partialInput: excerptArgs(st.json), partialBytes: st.json.length, ...(Object.keys(known).length ? { toolInput: known } : {}) } });
  },

  clearStreamTools(runner) {
    if (!runner || !runner.streamTools) return;
    for (const st of runner.streamTools.values()) { if (st.timer) { clearTimeout(st.timer); st.timer = null; } st.dirty = false; }
    runner.streamTools.clear();
  },
};

module.exports = { methods };
