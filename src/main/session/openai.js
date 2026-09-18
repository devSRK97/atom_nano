"use strict";
/* OpenAI / Codex primary — streaming via the Codex app-server (codex-appserver.js) with the
 * Codex SDK exec transport as fallback: live text + reasoning, per-tool cards, approvals answered
 * by the app, thread resume and EXACT conversation transfer into the thread (inject_items). */
const path = require("path");
const store = require("../storage/store");
const history = require("../storage/history");
const auth = require("../auth/cli-auth");
const { isNetworkError, isRateLimitError, isPromptTooLong } = require("./errors");

const methods = {
  /* ----------------------------- OpenAI / Codex primary -----------------------------
   * Streaming primary via the Codex app-server (codex-appserver.js): live text +
   * reasoning deltas, per-tool cards, live command output, approvals answered by
   * the app, token usage, thread resume and EXACT conversation transfer into the
   * thread (thread/inject_items). Falls back to the Codex SDK exec transport when
   * the app-server cannot start; if neither transport is available the request is
   * preserved as a recoverable state — never downgraded to a batch CLI run.
   */
  async runOpenAI(sessionId, session, { text, attachments, reviewers, reviewMode, background, fleet, extraSystem, roleBrief, subAgents, subAgentsMax, promptMessageId, provider, workflowJob, reservation }, reviewerBeforeDigest, settings, dispatched) {
    const providers = require("../providers/catalog");
    settings = settings || store.getSettings(session.cwd);
    // Strict capability checks: the model must be listed for this Codex install /
    // account and the effort must be on that model's ladder. No remapping. A run that cannot
    // start frees the reserved slot before its error is recorded.
    const wanted = /gpt|^o\d|codex|daybreak/i.test(session.model || "") ? session.model : "";
    const rs = providers.resolveOpenAIModelStrict(wanted);
    if (rs.error) { this.releaseRun(sessionId, reservation); return this.failRun(session, rs.error); }
    const model = rs.model;
    const re = providers.openaiEffortStrict(session.thinking, model);
    if (re.error) { this.releaseRun(sessionId, reservation); return this.failRun(session, re.error); }
    const effort = re.effort;

    // SUB-AGENTS on Codex (2026-09-17): a workflow role's lane, or the composer's Agents switch, maps to
    // Codex's own multi-agent feature — `features.multi_agent` on with the lane as the cap
    // (`agents.max_concurrent_threads_per_session`), off for a role whose lane is 0 (solo). An ordinary
    // turn with the switch off passes no override at all: Codex's own config decides, as before. The
    // Codex collaborator items (collabAgentToolCall / subAgentActivity) land in the same agent registry
    // as Claude's Task calls, so the studio and the job cards show them alike.
    const agentsMod = require("../agents/subagents");
    const subOn = !!subAgents;
    const subMax = subOn ? agentsMod.clampMax(subAgentsMax) : 0;
    const agentCfg = subOn ? { "features.multi_agent": true, "agents.max_concurrent_threads_per_session": subMax } : (workflowJob ? { "features.multi_agent": false } : {});
    // A workflow ROLE job carries the lane instruction inside its role brief; a solo turn gets the same
    // explicit sub-agents brief Claude gets (shown by the Agents popover), as labelled data.
    const agentsBrief = subOn && !workflowJob ? this.agentsBrief(subMax) : "";
    // The role skills of a persistent role session, frozen for THIS turn (index.js skillSnapshot): the names are
    // chat metadata; what each attempt sends is decided per thread below.
    const snap = this.skillSnapshot(session);
    const skillNames = snap.names;
    // The appendix of ONE attempt, composed for the thread it addresses (2026-09-18): a RESUMED thread gets the
    // role / agents briefs and the skill procedures only when new or changed — otherwise one pointer line (a
    // clearing line once when the skills went away); a FRESH thread (initial, lost-thread recovery, overflow
    // replacement, fresh exec fallback) gets them in full, whatever the still-bound old thread's binding says.
    // Composed once per kind (invoke marks a skill used, so it runs once per turn for what is sent); the thread
    // commits the attempt's hashes when it ACCEPTS the input (onTurnId / the exec acknowledgement).
    const composed = {};
    const composeFor = (resume) => {
      const key = resume ? "resume" : "fresh";
      if (!composed[key]) {
        const at = this.composeAttempt(session, { snap, prev: resume ? history.bindingFor(session, "openai") : null, roleBrief, agentsBrief, briefs: true, extraSystem, reviewerDigest: reviewerBeforeDigest });
        at.promptText = (text || "") + at.appendix;   // exact user text first; no caps
        composed[key] = at;
      }
      return composed[key];
    };
    let attempt = null;   // the attempt being dispatched — budgets and the acknowledgement follow it, never the first composition
    const atts = attachments || [];
    const files = atts.filter((a) => a.kind !== "image" && a.path).map((a) => ({ path: a.path, name: a.name }));
    const images = atts.filter((a) => a.kind === "image" && a.path).map((a) => ({ path: a.path }));

    session._replyMeta = this.replyMeta("openai", model, effort, reviewers, reviewMode);
    // The run takes over the slot run() reserved (see control.js claimRun); null = stopped or
    // replaced during setup — the stop already recorded the outcome, nothing starts.
    const runner = this.claimRun(sessionId, reservation, { promptText: text || "", codex: true, provider: "openai", model, effort, attempt: null });
    if (!runner) return;
    runner.subAgentsMax = subMax;   // the cap THIS run was dispatched with (the governor's policy reads it — subagents.js governorSettings)
    const abortController = runner.abortController;
    const runId = runner.id;
    // This run may act on the session only while it still OWNS the slot and was not stopped. Every
    // transport callback and every branch after an await checks this first: a late answer, item,
    // usage report or error from a run that Stop released — or that a newer run replaced — changes
    // nothing (no reply appended, no cursor moved, no status / retry / binding written).
    const stale = () => !!(runner.interrupted || abortController.signal.aborted || this.runners.get(sessionId) !== runner);
    const live = (fn) => (...a) => { if (stale()) return undefined; return fn(...a); };
    const stoppedError = (msg) => { const e = new Error(msg || "Stopped"); e.name = "AbortError"; return e; };
    // Record preparation (a transfer that may summarise) shows as the tab's live label and is cleared when done.
    const preparing = (label) => { if (!stale()) this.setLive(session, runner, { status: "preparing", label: label || "Preparing the conversation record" }); };
    const prepared = () => { if (runner.live && runner.live.status === "preparing") this.setLive(session, runner, { status: null, label: null }); };
    const appserver = require("../providers/codex-appserver");
    const authCtx = { apiKey: settings.openaiApiKey || "" };
    const ctxKey = appserver.ctxKeyOf(authCtx);
    // The binding is only a resume candidate when it was created in THIS auth
    // context — a thread from another account/home is never resumed under this one.
    const binding = history.bindingFor(session, "openai");
    if (binding.account && binding.account !== ctxKey) {
      // Capabilities and usage learned under another account do not constrain the new one.
      // Keep its native id/cursor until the replacement has acknowledged our saved context.
      history.setBinding(session, "openai", { reportedWindow: null, learnedWindow: null, ctxUsage: null, activeTokens: 0 });
    }
    const resumeId = binding.id && (!binding.account || binding.account === ctxKey) ? binding.id : null;
    const promptIndex = this.promptIndexFor(session, promptMessageId);
    runner.promptIndex = promptIndex; runner.bindingProvider = "openai";
    // The prompt alone must fit the model's window (images count as native inputs, files are
    // read by Codex itself — only the text is measured here). Measured on the attempt that is dispatched first.
    attempt = composeFor(!!resumeId);
    const ctxTokens = this.contextTokensFor("openai", model, session);
    // Configure the advertised native capacity. A reported usage window may already reserve
    // a percentage for output, so feeding that figure back into config would shrink each turn.
    const modelInfo = (providers.get("openai").models || []).find((m) => m.id === model);
    const nativeWindow = modelInfo && +modelInfo.ctx > 0 ? Math.floor(+modelInfo.ctx) : ctxTokens;
    if (attempt.promptText.length + images.length * 6400 > ctxTokens * history.CHARS_PER_TOKEN * 0.9) {
      this.releaseRun(sessionId, runner);
      return this.failRun(session, `Your message alone is about ${Math.round(attempt.promptText.length / history.CHARS_PER_TOKEN).toLocaleString("en-US")} tokens — larger than the model's context window (${ctxTokens.toLocaleString("en-US")} tokens). It was not sent. Split it, or attach the large part as a file Codex can read in pieces.`);
    }
    this._lastRun = { sessionId, runId, sent: { provider: "openai", model, effort, authContext: ctxKey, threadResumed: !!resumeId, skills: skillNames, skillsMode: attempt.skillsMode, briefMode: attempt.briefMode, background: !!background, fleet: !!(fleet && fleet.taskId), files: files.length, images: images.length, subAgents: subMax, agentsBrief: !!agentsBrief, roleBrief: roleBrief ? String(roleBrief).length : 0 }, init: null };
    // The attempt about to be dispatched: the runner carries it (the acknowledgements commit its hashes), the diagnostics name its delivery.
    const dispatching = (resume) => { attempt = composeFor(resume); runner.attempt = attempt; if (this._lastRun && this._lastRun.sessionId === sessionId) { this._lastRun.sent.skillsMode = attempt.skillsMode; this._lastRun.sent.briefMode = attempt.briefMode; } return attempt; };

    const pendingRetry = () => ({ text, attachments, reviewers, reviewMode, background, fleet, extraSystem, resumeContinuation: true, promptMessageId, provider, roleBrief, workflowJob });

    // ---- Tool cards: map Codex thread items to the app's live tool messages ----
    const toolMsgId = new Map();   // codex item.id (or item.id#i for one file of a patch) -> our tool message id
    const itemsSeen = new Map();   // codex item.id -> last item seen (enriches approval cards)
    const kindOf = (c) => (c && c.kind && typeof c.kind === "object") ? c.kind.type : (c && c.kind);
    const absp = (p) => (p && session.cwd && !path.isAbsolute(p)) ? path.join(session.cwd, p) : p;
    const cards = require("../providers/codex-cards");
    const unwrapCmd = cards.unwrapCmd, parseDiff = cards.parseDiff;
    const classifyCmd = (cmd) => cards.classifyCmd(cmd, absp);
    const changeCards = (it) => (it.changes || []).map((c, i) => {
      const kind = kindOf(c) || "update", d = parseDiff(c.diff), fp = absp(c.path);
      const key = `${it.id}#${i}`;
      if (kind === "add") return { key, fp, d, toolName: "Write", toolInput: { file_path: fp, content: d.newText } };
      if (kind === "delete") return { key, fp, d, toolName: "Delete", toolInput: { file_path: fp } };
      return { key, fp, d, toolName: "Edit", toolInput: { file_path: fp, old_string: d.oldText, new_string: d.newText, ...(c.kind && c.kind.move_path ? { rename_to: absp(c.kind.move_path) } : {}) } };
    });
    const cardFor = (it) => {
      const t = it.type;
      if (t === "commandExecution" || t === "command_execution") {
        const acts = Array.isArray(it.commandActions) ? it.commandActions : [];
        const a = acts[0];
        if (a && acts.every((x) => x.type === "read") && a.path) return { toolName: "Read", toolInput: { file_path: absp(a.path), ...(acts.length > 1 ? { files: acts.map((x) => absp(x.path)) } : {}) } };
        if (a && a.type === "listFiles" && acts.length === 1) return { toolName: "Glob", toolInput: { pattern: (a.path ? String(a.path).replace(/[\\/]+$/, "") + "/" : "") + "*", ...(a.path ? { path: absp(a.path) } : {}) } };
        if (a && a.type === "search" && acts.length === 1) return { toolName: "Grep", toolInput: { pattern: a.query || unwrapCmd(a.command || it.command), ...(a.path ? { path: absp(a.path) } : {}) } };
        const bare = unwrapCmd(it.command);
        const own = classifyCmd(bare);
        if (own) return { toolName: own.toolName, toolInput: { ...own.toolInput, command: bare } };
        return { toolName: "Bash", toolInput: { command: bare, ...(it.cwd && it.cwd !== session.cwd ? { cwd: it.cwd } : {}) } };
      }
      if (t === "webSearch" || t === "web_search") return { toolName: "WebSearch", toolInput: { query: it.query || "" } };
      if (t === "mcpToolCall" || t === "mcp_tool_call") return { toolName: `mcp:${it.server}/${it.tool}`, toolInput: it.arguments };
      if (t === "dynamicToolCall") return { toolName: it.tool || "tool", toolInput: it.arguments || {} };
      if (t === "imageView") return { toolName: "Read", toolInput: { file_path: absp(it.path || "") } };
      if (t === "collabAgentToolCall") return { toolName: "Task", toolInput: { description: it.prompt || String(it.tool || "agent"), ...(it.model ? { subagent_type: it.model } : {}) } };
      if (t === "subAgentActivity") return { toolName: "Task", toolInput: { description: `${it.kind || "sub-agent"} ${it.agentPath || ""}`.trim() } };
      if (t === "imageGeneration") return { toolName: "ImageGeneration", toolInput: { prompt: it.prompt || "" } };
      if (t === "todo_list") return { toolName: "TodoWrite", toolInput: { todos: (it.items || []).map((x) => ({ content: x.text, status: x.completed ? "completed" : "pending" })) } };
      return { toolName: t, toolInput: {} };
    };
    const isFileChange = (it) => it.type === "fileChange" || it.type === "file_change";
    const addCard = (key, itemId, c) => {
      const mid = store.uid();
      toolMsgId.set(key, mid);
      // A Codex collaborator / sub-agent activity is an agent in the registry too — same numbering.
      const agent = c.toolName === "Task" && this.agentAnnounce ? this.agentAnnounce(session, runner, { toolUseId: itemId, msgId: mid, input: c.toolInput, status: "running" }).agent : null;
      this.addMessage(session, { id: mid, role: "tool", toolName: c.toolName, toolUseId: itemId, runId, toolInput: c.toolInput, status: "running", ts: store.nowISO(), ...(agent ? { agentN: agent.n } : {}) });
      return mid;
    };
    const startCard = (it) => {
      itemsSeen.set(it.id, it);
      if (isFileChange(it)) {
        for (const c of changeCards(it)) {
          if (toolMsgId.has(c.key)) continue;
          addCard(c.key, it.id, c);
          this.trackEdit(session, c.fp, c.toolName, { added: c.d.added, removed: c.d.removed });
        }
        return;
      }
      if (toolMsgId.has(it.id)) return;
      addCard(it.id, it.id, cardFor(it));
    };
    // Live command output: deltas are batched into the running card ~5×/s. The full
    // output is kept; the renderer pages/virtualises long results.
    const outBuf = new Map(), outTimer = new Map();
    const flushOut = (itemId) => { const t = outTimer.get(itemId); if (t) clearTimeout(t); outTimer.delete(itemId); const mid = toolMsgId.get(itemId); if (mid && outBuf.has(itemId)) this.updateMessage(session, mid, { result: outBuf.get(itemId) || "" }); };
    const onToolOutput = (itemId, delta) => { if (!delta) return; outBuf.set(itemId, (outBuf.get(itemId) || "") + delta); if (!outTimer.has(itemId)) outTimer.set(itemId, setTimeout(() => flushOut(itemId), 200)); };
    const endCard = (it) => {
      itemsSeen.set(it.id, it);
      const declined = it.status === "declined";
      if (isFileChange(it)) {
        const cs = changeCards(it);
        if (!cs.length && !toolMsgId.has(it.id)) addCard(it.id, it.id, { toolName: "Edit", toolInput: {} });
        const failed = declined || it.status === "failed";
        for (const c of cs) {
          if (!toolMsgId.has(c.key)) { addCard(c.key, it.id, c); this.trackEdit(session, c.fp, c.toolName, { added: c.d.added, removed: c.d.removed }); }
          const result = declined ? "Declined — not applied." : failed ? "Failed to apply this change." : `${c.toolName === "Write" ? "Wrote" : c.toolName === "Delete" ? "Deleted" : "Updated"} ${path.basename(c.fp || "")}  (+${c.d.added} −${c.d.removed})`;
          this.updateMessage(session, toolMsgId.get(c.key), { status: failed ? "error" : "done", toolInput: c.toolInput, result, endedTs: store.nowISO() });
        }
        return;
      }
      let mid = toolMsgId.get(it.id);
      if (!mid) { startCard(it); mid = toolMsgId.get(it.id); }
      const t0 = outTimer.get(it.id); if (t0) { clearTimeout(t0); outTimer.delete(it.id); }
      const exit = typeof it.exitCode === "number" ? it.exitCode : (typeof it.exit_code === "number" ? it.exit_code : null);
      const failed = declined || it.status === "failed" || (exit !== null && exit !== 0) || it.success === false;
      let result = "";
      const t = it.type;
      if (t === "commandExecution" || t === "command_execution") result = it.aggregatedOutput || it.aggregated_output || outBuf.get(it.id) || "";
      else if (t === "mcpToolCall" || t === "mcp_tool_call") result = it.error ? (it.error.message || "") : ((it.result && Array.isArray(it.result.content)) ? it.result.content.map((c) => (c && c.text) || "").filter(Boolean).join("\n") : "");
      else if (t === "dynamicToolCall") result = (it.contentItems || []).map((c) => (c && (c.text || c.output)) || "").filter(Boolean).join("\n");
      else if (t === "webSearch" || t === "web_search") result = it.query || "";
      if (declined) result = (result ? result + "\n" : "") + "Declined — not run.";
      else if (exit !== null && exit !== 0) result = (result ? result + "\n" : "") + `exit code ${exit}`;
      // Codex often classifies a command (read/search/list) only at completion → re-derive the card.
      const c = cardFor(it);
      const cur = session.messages.find((x) => x.id === mid);
      const rename = cur && (cur.toolName !== c.toolName || JSON.stringify(cur.toolInput) !== JSON.stringify(c.toolInput)) ? { toolName: c.toolName, toolInput: c.toolInput } : {};
      this.updateMessage(session, mid, { status: failed ? "error" : "done", result: String(result || ""), endedTs: store.nowISO(), ...rename });
      if (this.agentFind) { const a = this.agentFind(session, { toolUseId: it.id }); if (a) this.agentPatch(session, a, { status: failed ? "error" : "done", result: String(result || "") }); }
      outBuf.delete(it.id);
    };
    let planMid = null;
    const onPlan = (steps, explanation) => {
      const todos = (steps || []).map((s) => ({ content: s.step, status: s.status === "inProgress" ? "in_progress" : (s.status || "pending") }));
      if (!todos.length) return;
      if (!planMid) { planMid = store.uid(); this.addMessage(session, { id: planMid, role: "tool", toolName: "TodoWrite", toolUseId: planMid, runId, toolInput: { todos }, status: "done", result: explanation || "", ts: store.nowISO() }); }
      else this.updateMessage(session, planMid, { toolInput: { todos }, result: explanation || "" });
    };
    const notice = (msg) => {
      const t = "Codex: " + String(msg || "").trim();
      if (!msg) return;
      const seen = (this._codexNotices ||= new Map()).get(session.id) || new Set();
      this._codexNotices.set(session.id, seen);
      if (seen.has(t)) { console.warn("[codex]", String(msg).slice(0, 200)); return; }
      seen.add(t);
      this.addMessage(session, { id: store.uid(), role: "system", text: t, ts: store.nowISO() });
    };
    let assistantCount = 0;
    const onAgentMessage = (t) => {
      if (!t || !t.trim()) return;
      this.send("session:partial-reset", { sessionId, index: 0 });
      this.addMessage(session, { id: store.uid(), role: "assistant", text: t, ts: store.nowISO(), meta: session._replyMeta });
      assistantCount++;
    };
    // Approvals: decided from the tab's permission mode, read LIVE so a mid-turn
    // change applies to the next request. Full access → auto-approve; Plan → nothing
    // that changes state; Accept edits → file changes auto, commands ask; Ask → ask.
    const permModeNow = () => session.permissionMode || settings.defaultPermissionMode || "default";
    const askUser = async (toolName, input) => { const d = await this.requestPermission(sessionId, toolName, input, abortController.signal, runId); return !!(d && d.behavior === "allow"); };
    const decide = async (kind, p, c) => {
      const mode = permModeNow();
      if (stale()) return { decision: "cancel", grant: false, answers: {} };
      const item = (c && c.item) || itemsSeen.get(p.itemId) || null;
      if (kind === "command") {
        if (mode === "bypassPermissions") return { decision: "accept" };
        if (mode === "plan") return { decision: "decline" };
        const cc = item ? cardFor({ ...item, command: p.command || item.command, commandActions: p.commandActions || item.commandActions }) : { toolName: "Bash", toolInput: { command: unwrapCmd(p.command || "") } };
        const ok = await askUser(cc.toolName, { ...cc.toolInput, ...(p.reason ? { description: p.reason } : {}), ...(p.kind === "writeStdin" ? { stdin: true } : {}) });
        return { decision: ok ? "accept" : "decline" };
      }
      if (kind === "fileChange") {
        if (mode === "bypassPermissions" || mode === "acceptEdits") return { decision: "accept" };
        if (mode === "plan") return { decision: "decline" };
        const cs = item ? changeCards(item) : [];
        const first = cs[0] || { toolName: "Edit", toolInput: { file_path: p.grantRoot || "" } };
        const ok = await askUser(first.toolName, { ...first.toolInput, ...(cs.length > 1 ? { files: cs.map((x) => x.fp) } : {}), ...(p.reason ? { reason: p.reason } : {}) });
        return { decision: ok ? "accept" : "decline" };
      }
      if (kind === "permissions") {
        if (mode === "bypassPermissions" || mode === "acceptEdits") return { grant: true, scope: "turn" };
        if (mode === "plan") return { grant: false, message: "Plan mode — no additional permissions" };
        const ok = await askUser("Permissions", { reason: p.reason || "", ...(p.permissions || {}) });
        return ok ? { grant: true, scope: "turn" } : { grant: false, message: "Declined by user" };
      }
      if (kind === "userInput") {
        const qs = (p.questions || []).map((q) => ({ header: q.header || q.id, question: q.question, multiSelect: false, options: (q.options || []).map((o) => ({ label: o.label, description: o.description || "" })).concat(q.isOther ? [{ label: "Other", description: "Something else" }] : []) }));
        if (!qs.length) return { answers: {} };
        const d = await this.requestPermission(sessionId, "AskUserQuestion", { questions: qs }, abortController.signal, runId);
        // The renderer answers as ALLOW with updatedInput.answers (question text → "label, label");
        // an older message-line form is still understood.
        const given = (d && d.behavior === "allow" && d.updatedInput && d.updatedInput.answers && typeof d.updatedInput.answers === "object") ? d.updatedInput.answers : null;
        const lines = given ? [] : String((d && d.message) || "").split("\n").map((l) => l.replace(/^•\s*/, "").trim()).filter(Boolean);
        const answers = {};
        for (const q of (p.questions || [])) {
          const label = String(q.header || q.id || q.question || "");
          let picked = null;
          if (given) { const v = given[q.question] != null ? given[q.question] : given[label]; if (typeof v === "string") picked = v; }
          else { const line = lines.find((l) => l.startsWith(label + ":")); if (line) picked = line.slice(label.length + 1); }
          if (picked != null) answers[q.id] = { answers: String(picked).split(",").map((s) => s.trim()).filter(Boolean) };
        }
        return { answers };
      }
      if (kind === "elicitation") return { action: "decline", content: null, _meta: null };
      return null;
    };

    // Conversation transfer into the Codex thread. A NEW thread receives everything
    // before the current prompt; a resumed thread receives only what it missed.
    // Sized to the model (exact → shortened tool payloads → cached working memory + selected evidence).
    // After a "context window exceeded" failure the retry forces the summary within half the budget.
    let transferOpts = { forceSummary: false, budgetScale: 1, to: promptIndex - 1, extra: "" };
    // A record prepared BEFORE a replacement thread is started (the overflow recovery below): the
    // thread's beforeTurn injects it instead of preparing its own.
    let preparedSeed = null;
    // A NEW app-server thread is bound to the session only once it holds the record it was started
    // for (the injection acknowledged, or nothing to inject) — and only by a run that still owns the
    // session then. Until that moment the PREVIOUS binding (id, account, cursor) stays as it was: a
    // Stop or a failure between thread/start and the acknowledgement loses no resumable thread, and
    // never leaves an empty thread with a reset cursor.
    const bindPending = (syncedIndex) => { const p = runner.pendingThread; if (!p) return; runner.pendingThread = null; history.setBinding(session, "openai", { id: p.id, account: p.account, syncedIndex, activeTokens: 0 }); };
    const transferInto = async (threadId, isNew) => {
      if (stale()) throw stoppedError("Stopped before the record was transferred");
      const b = history.bindingFor(session, "openai");
      const from = isNew ? -1 : b.syncedIndex;
      const to = transferOpts.to;
      if (from >= to) { if (isNew) bindPending(-1); return 0; }
      let tb;
      if (isNew && preparedSeed) { tb = preparedSeed; preparedSeed = null; }
      else {
        preparing(isNew ? "Preparing the conversation record for the new thread" : "Preparing the conversation record this thread has not seen");
        // Budgeted against the prompt of the attempt actually being dispatched (a fresh thread carries the full appendices).
        tb = await this.transferBlock(session, "openai", { model, from, to, promptChars: attempt.promptText.length + (transferOpts.extra || "").length, signal: abortController.signal, forceSummary: transferOpts.forceSummary, budgetScale: transferOpts.budgetScale, activeTokens: from > -1 ? (b.activeTokens || 0) : 0, onProgress: preparing });
        if (stale()) throw stoppedError("Stopped while the record was being prepared");
        prepared();
      }
      if (!tb.count) { if (isNew) bindPending(-1); return 0; }
      await appserver.injectItems(threadId, tb.items);
      // The acknowledgement may land after Stop — or after a replacement run bound its own thread and
      // cursor: then this run records nothing (the replacement's binding is not ours to move).
      if (stale()) throw stoppedError("Stopped after the record was transferred");
      // ACKNOWLEDGED: the thread holds this span now. Recorded immediately so a failure later in
      // the turn (network, cancel) never injects the same history a second time.
      if (isNew) bindPending(to); else history.setBinding(session, "openai", { syncedIndex: to });
      this.addMessage(session, { id: store.uid(), role: "system", text: tb.note.replace(/\.$/, "") + " — injected into its thread.", ts: store.nowISO() });
      if (this._lastRun && this._lastRun.sessionId === sessionId) { this._lastRun.sent.transferredEntries = tb.count; this._lastRun.sent.transferMode = tb.mode; }
      return tb.count;
    };
    const contextExceeded = (r) => !!r && !r.ok && !r.aborted && (isPromptTooLong(r.error) || (r.errorInfo && (r.errorInfo === "contextWindowExceeded" || (typeof r.errorInfo === "object" && "contextWindowExceeded" in r.errorInfo))));
    // ONE overflow recovery: a new thread with a summarised record at half the budget. The
    // replacement record is prepared FIRST — it can take a while and can be stopped — and the
    // current thread stays bound until it exists: a Stop here loses nothing, the next message still
    // resumes the existing thread. Work the failing attempt already did (canonical entries after
    // the prompt) travels too, and the model is asked to continue rather than redo it.
    const prepareOverflowSeed = async ({ to, extra }) => {
      preparing("Preparing a summarised conversation record after the context overflow");
      // The replacement is a FRESH thread: its seed is budgeted against the full-appendix prompt it will carry.
      const seed = await this.transferBlock(session, "openai", { model, from: -1, to, promptChars: composeFor(false).promptText.length + (extra || "").length, signal: abortController.signal, forceSummary: true, budgetScale: 0.5, onProgress: preparing });
      if (stale()) return null;
      prepared();
      return seed;
    };

    let turnUsage = null;
    try {
      this.send("session:partial-reset", { sessionId });
      const permMode = permModeNow();
      const streamOn = {
        onThreadId: live((id, isNew, ctx) => {
          if (isNew === true) { runner.pendingThread = { id, account: ctx || ctxKey }; return; }   // bound once its record is in (see transferInto)
          // A resumed thread, or the exec transport's thread (reported at its first event, once the
          // prompt — record included — is in): another id than the bound one replaces it here.
          const b = history.bindingFor(session, "openai");
          history.setBinding(session, "openai", { id, account: ctx || ctxKey, ...(b.id && b.id !== id ? { activeTokens: 0 } : {}) });
        }),
        onAccount: live((acct) => { if (acct && session._replyMeta) { session._replyMeta.account = acct.email || acct.type; session._replyMeta.accountType = acct.type; } }),
        onTextDelta: live((d) => this.send("session:partial", { sessionId, index: 0, kind: "text", delta: d })),
        // Codex reasoning summaries are markdown headlines ("**Planning rollback**"); the thinking card is plain text.
        onReasoningDelta: live((d) => this.send("session:partial", { sessionId, index: 1, kind: "thinking", delta: String(d || "").replace(/\*\*/g, "") })),
        onReasoning: live((t) => { const tt = String(t || "").replace(/\*\*/g, "").trim(); this.send("session:partial-reset", { sessionId, index: 1 }); if (tt) this.addMessage(session, { id: store.uid(), role: "thinking", text: tt, ts: store.nowISO() }); }),
        onToolStart: live(startCard), onToolEnd: live(endCard),
        onUsage: live((u) => {
          turnUsage = u; runner.usage = u;
          if (u && u.context_window > 0) this.noteReportedWindow(session, "openai", model, u.context_window, { source: "codex", oneM: runner.oneM });
        }),
      };
      // Each app-server attempt composes its own appendix AFTER its resume path is chosen (dispatching): a
      // resumed thread → what changed; a new thread (initial, lost, overflow replacement) → everything.
      const runApp = (resume) => appserver.run({
        apiKey: authCtx.apiKey,
        model, effort, cwd: session.cwd, promptText: dispatching(!!resume).promptText + (transferOpts.extra || ""), images, files,
        config: { model_context_window: nativeWindow, model_auto_compact_token_limit: Math.floor(nativeWindow * 0.9), ...agentCfg },
        resumeId: resume,
        mode: permMode, signal: abortController.signal, decide,
        reasoningSummary: settings.codexReasoningSummary || undefined,
        webSearch: settings.openaiWebSearch,
        beforeTurn: transferInto,
        on: {
          ...streamOn,
          onTurnId: live((turnId) => {
            runner.query = { interrupt: () => appserver.interrupt(session.codexThreadId, turnId), steer: (t, imgs, fls) => appserver.steer(session.codexThreadId, turnId, t, imgs, fls) };
            // The turn started: the thread has accepted this prompt. Acknowledge it on the cursor now
            // so a stop/failure later never re-injects an accepted prompt (see finalizeRun) — and record what the
            // thread now holds: the frozen attempt's brief / skills hashes (index.js commitAttempt), so the next turn
            // sends pointers. Thread creation and the record injection alone never did this; `live` keeps a late
            // callback of a stopped or replaced run from touching a newer binding.
            runner.accepted = true;
            const b = history.bindingFor(session, "openai");
            this.commitAttempt(session, "openai", runner, b.id && b.syncedIndex < promptIndex ? { syncedIndex: promptIndex } : null);
          }),
          onAgentMessage: live(onAgentMessage), onToolOutput: live(onToolOutput), onPlan: live(onPlan), onNotice: live(notice),
          onToolUpdate: live((it) => { itemsSeen.set(it.id, it); if (it.progress) { const mid = toolMsgId.get(it.id); if (mid) this.updateMessage(session, mid, { progress: String(it.progress) }); } }),
          onRetry: live((m) => notice("Reconnecting… " + m)),
          onRerouted: live((from, to, reason) => { notice(`rerouted ${from} → ${to}${reason ? ` (${typeof reason === "string" ? reason : JSON.stringify(reason)})` : ""}`); if (session._replyMeta) { session._replyMeta.servedModel = to; } }),
        },
      });
      let res = await runApp(resumeId);
      // The resumed thread is gone: explicit recovery — a new thread that receives
      // the FULL record, announced. Never a blank thread pretending to continue.
      if (res.threadLost && !stale()) {
        console.warn("[codex] thread lost —", res.error);
        history.dropBinding(session, "openai");
        this.addMessage(session, { id: store.uid(), role: "system", text: "Codex's thread for this conversation no longer exists. A new thread is being started with the conversation record.", ts: store.nowISO() });
        res = await runApp(null);
      }
      // The thread (or the injected record) does not fit the model's window: ONE recovery —
      // a new thread that receives a summarised record within half the budget (prepared BEFORE
      // the current thread is unbound — see prepareOverflowSeed).
      if (contextExceeded(res) && !stale() && !runner.retriedTooLong) {
        runner.retriedTooLong = true;
        console.warn("[codex] context window exceeded — new thread with a summarised record:", res.error);
        const cont = this.continuationAfter(session, promptIndex);
        transferOpts = { forceSummary: true, budgetScale: 0.5, to: cont.to, extra: cont.note };
        runner.accepted = false;   // the thread rejected this turn: a Stop during the seed must not acknowledge the prompt on its cursor
        preparedSeed = await prepareOverflowSeed({ to: cont.to, extra: cont.note });
        if (!preparedSeed) { this.finalizeRun(session, runner, { aborted: true }); return; }   // Stop during the seed: the thread stays bound
        // The full thread stays bound until the replacement thread has ACCEPTED the record (bindPending
        // after the injection is acknowledged): a Stop or a failure in between keeps id, account and cursor.
        this.addMessage(session, { id: store.uid(), role: "system", text: `Codex rejected the request as too large for the model's context window. A new thread is being started with saved working memory, selected recent evidence and references to the full record.${cont.count ? ` The ${cont.count} entr${cont.count === 1 ? "y" : "ies"} the interrupted attempt produced travel with it, and the model is asked to continue rather than start over.` : ""}`, ts: store.nowISO() });
        if (this._lastRun && this._lastRun.sessionId === sessionId) { this._lastRun.sent.promptTooLongRecovery = true; this._lastRun.sent.continuationEntries = cont.count; }
        res = await runApp(null);
      }
      // FALLBACK: app-server unavailable → the Codex SDK exec transport (coarser
      // streaming; approvals cannot be asked). Same exact text, attachments and record.
      if (res.loadFailed && !stale()) {
        notice("app-server unavailable — using the Codex SDK exec transport (no live streaming or approvals). " + String(res.error || ""));
        const codex = require("../providers/codex-exec");
        const b = history.bindingFor(session, "openai");
        // An account/home change starts a fresh exec thread. Its context is empty even when
        // the previous account's binding cursor was fully synced.
        const execResume = b.id && (!b.account || b.account === ctxKey) ? b.id : null;
        const sync = execResume ? history.pendingSync(session, "openai", promptIndex)
          : { from: -1, to: promptIndex - 1, needed: promptIndex > 0 };
        const execOpts = (resume) => ({ apiKey: authCtx.apiKey || undefined, model, effort, contextWindow: nativeWindow, cwd: session.cwd, attachments: atts, resumeId: resume, signal: abortController.signal, webSearch: settings.openaiWebSearch, reasoningSummary: settings.codexReasoningSummary || undefined, readOnly: permMode === "plan", config: agentCfg, on: { ...streamOn, onErrorItem: live(notice) } });
        // thread.started identifies a thread; turn.started acknowledges the submitted input.
        // Keep the old binding until that acknowledgement, including when an account changed.
        // `at` is the attempt this exec call dispatches (composed after ITS resume path was chosen): the
        // acknowledgement commits its brief / skills hashes together with the id and the cursor — a new
        // native id clears the old thread's hashes first (history.setBinding) and takes these.
        const runExec = async (resume, prompt, at) => {
          let nativeId = resume, accepted = false;
          const acknowledge = () => {
            if (!accepted || !nativeId || stale()) return;
            const current = history.bindingFor(session, "openai");
            const syncedIndex = Math.max(promptIndex, transferOpts.to);
            history.setBinding(session, "openai", { id: nativeId, account: ctxKey, syncedIndex: nativeId === current.id ? Math.max(current.syncedIndex, syncedIndex) : syncedIndex, ...(nativeId !== current.id ? { activeTokens: 0, ctxUsage: null } : {}), ...(at && at.commit ? at.commit : {}) });
            runner.accepted = true;
          };
          const opts = execOpts(resume);
          const result = await codex.run({ ...opts, promptText: prompt, on: { ...opts.on,
            onThreadId: live((id) => { nativeId = id; acknowledge(); }),
            onTurnStarted: live(() => { accepted = true; acknowledge(); }),
          } });
          // Older transports may omit turn.started; a completed reply is also proof of acceptance.
          if (result && result.ok && !stale()) { nativeId = result.threadId || nativeId; accepted = true; acknowledge(); }
          return result;
        };
        const withRecord = (tb, at) => (tb && tb.text ? tb.text + "\n\n---\n\n" : "") + at.promptText + (transferOpts.extra || "");
        // The first exec attempt follows the same resume decision as the app-server would have (an account change
        // → fresh); its record is budgeted against that attempt's prompt.
        let execAt = dispatching(!!execResume);
        if (sync.needed) preparing("Preparing the conversation record this thread has not seen");
        const block = sync.needed ? await this.transferBlock(session, "openai", { model, from: sync.from, to: sync.to, promptChars: execAt.promptText.length, signal: abortController.signal, ...transferOpts, onProgress: preparing }) : { text: "", count: 0, mode: "none", note: "" };
        if (stale()) { this.finalizeRun(session, runner, { aborted: true }); return; }
        prepared();
        if (block.count) this.addMessage(session, { id: store.uid(), role: "system", text: block.note, ts: store.nowISO() });
        const execRes = await runExec(execResume, withRecord(block, execAt), execAt);
        if (execRes.threadLost && !stale()) {
          history.dropBinding(session, "openai");
          execAt = dispatching(false);   // a new thread: the full appendices, and the record budgeted for them
          preparing("Preparing the conversation record for the new thread");
          const full = await this.transferBlock(session, "openai", { model, from: -1, to: promptIndex - 1, promptChars: execAt.promptText.length, signal: abortController.signal, ...transferOpts, onProgress: preparing });
          if (stale()) { this.finalizeRun(session, runner, { aborted: true }); return; }
          prepared();
          this.addMessage(session, { id: store.uid(), role: "system", text: `Codex's thread for this conversation no longer exists. Starting a new one. ${full.note}`.trim(), ts: store.nowISO() });
          res = await runExec(null, withRecord(full, execAt), execAt);
        } else res = execRes;
        if (contextExceeded(res) && !stale() && !runner.retriedTooLong) {
          runner.retriedTooLong = true; runner.accepted = false;
          // Preserve actions completed by this failed attempt and keep the old thread until the
          // replacement acknowledges the input, just as for app-server overflow recovery.
          const cont = this.continuationAfter(session, promptIndex);
          transferOpts = { forceSummary: true, budgetScale: 0.5, to: cont.to, extra: cont.note };
          execAt = dispatching(false);   // the replacement is a fresh thread: full appendices (the seed is budgeted for them)
          const tb = await prepareOverflowSeed({ to: cont.to, extra: cont.note });
          if (!tb) { this.finalizeRun(session, runner, { aborted: true }); return; }
          this.addMessage(session, { id: store.uid(), role: "system", text: `Codex rejected the request as too large for the model's context window. Starting a new thread. ${tb.note}`.trim(), ts: store.nowISO() });
          res = await runExec(null, withRecord(tb, execAt), execAt);
        }
        if (res.usage && !turnUsage) turnUsage = res.usage;
      }
      // Stopped or replaced while the transport answered: whatever came back is NOT applied — no
      // reply, no cursor / binding change, no status, no preserved retry (the stop recorded the turn).
      if (stale()) { this.finalizeRun(session, runner, { aborted: true }); return; }
      for (const itemId of Array.from(outTimer.keys())) flushOut(itemId);   // pending command output → cards

      // NEITHER transport could run: recoverable state. The request is preserved for
      // Retry; nothing is silently downgraded to a batch CLI run.
      if (res.loadFailed) {
        session._pendingRetry = pendingRetry();
        this.addMessage(session, { id: store.uid(), role: "error", text: "Codex is unavailable: neither the app-server nor the Codex SDK could start (" + String(res.error || "unknown error") + "). Your message is preserved — fix the Codex install (Settings → Providers → Tools) and click Retry.", ts: store.nowISO() });
        runner.failed = true;
        this.finalizeRun(session, runner, { aborted: false, failed: true });
        return;
      }
      const info = res.errorInfo;
      const infoIs = (k) => info === k || (info && typeof info === "object" && k in info);
      if (res.ok) {
        this.send("session:partial-reset", { sessionId });
        if (!assistantCount && (res.text || "").trim()) this.addMessage(session, { id: store.uid(), role: "assistant", text: res.text, ts: store.nowISO(), meta: session._replyMeta });
        else if (!assistantCount) this.addMessage(session, { id: store.uid(), role: "system", text: "Codex finished the turn with no text reply.", ts: store.nowISO() });
        // Usage: apply the turn's FINAL numbers exactly once (Codex reports cumulative-within-turn).
        const u = (turnUsage && (turnUsage.last || turnUsage)) || (res.usage && (res.usage.last || res.usage)) || null;
        if (u) {
          // OpenAI's usage contract: cached / cache-write tokens are SUBSETS of input_tokens (unlike
          // Anthropic's three separate input components) — count the input once.
          session.totalTokensIn = (session.totalTokensIn || 0) + (u.input_tokens || 0);
          session.totalTokensOut = (session.totalTokensOut || 0) + (u.output_tokens || 0);
          this.addMessage(session, { id: store.uid(), role: "result", text: "", ts: store.nowISO(), meta: { subtype: "success", isError: false, usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: u.cached_input_tokens || 0, cache_creation_input_tokens: u.cache_write_input_tokens || 0, cacheIsSubsetOfInput: true }, contextWindow: turnUsage && turnUsage.context_window || null, provider: "openai", account: session._replyMeta && session._replyMeta.account || "" } });
          history.setBinding(session, "openai", { activeTokens: (u.input_tokens || 0), activeTokensTs: store.nowISO() });
        }
        session._retryAttempt = 0;
        history.setBinding(session, "openai", { syncedIndex: history.lastGlobalIndex(session) });
        store.scheduleWrite(sessionId);
        this.finalizeRun(session, runner, { aborted: false });
      } else if (res.aborted || runner.interrupted || abortController.signal.aborted) {
        this.finalizeRun(session, runner, { aborted: true });
      } else if (isRateLimitError(res.error) || infoIs("rateLimitExceeded") || infoIs("usageLimitExceeded") || infoIs("serverOverloaded")) {
        session._pendingRetry = pendingRetry();
        runner.running = false; if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId);
        this.scheduleRetry(sessionId, "ratelimited");
        return;
      } else if (isNetworkError(res.error) || infoIs("httpConnectionFailed") || infoIs("responseStreamConnectionFailed") || infoIs("responseStreamDisconnected")) {
        session._pendingRetry = pendingRetry();
        store.updateSession(sessionId, { status: "offline" }); this.send("session:status", { sessionId, status: "offline" });
      } else if (res.authFailed || infoIs("unauthorized")) {
        // Login expired / key rejected: pause with the request preserved (the thread
        // binding is kept — it is still this account's thread).
        const payload = pendingRetry();
        session._pendingRetry = payload;
        this.addMessage(session, { id: store.uid(), role: "system", text: "Your OpenAI (Codex) login is not valid right now — this session is paused. Sign in again (Settings → Providers) and it resumes automatically.", ts: store.nowISO() });
        store.updateSession(sessionId, { status: "auth-expired", pendingRun: { payload, reason: "auth", provider: "openai", at: store.nowISO() } });
        this.send("session:status", { sessionId, status: "auth-expired", provider: "openai" });
      } else {
        const hint = res.resumeFailed ? "  (The existing Codex thread is kept — retry when Codex is reachable.)"
          : infoIs("contextWindowExceeded") ? "  (Context window exceeded — start a new session or let Codex compact.)"
          : infoIs("sandboxError") ? "  (Sandbox error — try Full access, or check the Windows sandbox setup in Codex.)"
          : "";
        this.addMessage(session, { id: store.uid(), role: "error", text: "OpenAI / Codex run failed: " + (res.error || "no output") + hint, ts: store.nowISO() });
        runner.failed = true;
        this.finalizeRun(session, runner, { aborted: false, failed: true });
      }
    } catch (e) {
      // An error from a run that was stopped or replaced meanwhile (a connection reset after Stop,
      // a cancelled transfer) is that run's business only: it must never mark the tab offline, pause
      // it, or queue a retry of a prompt the user already abandoned.
      if (stale()) { this.finalizeRun(session, runner, { aborted: true }); return; }
      console.error("[openai:run]", e);
      if (isNetworkError(e)) {
        session._pendingRetry = pendingRetry();
        store.updateSession(sessionId, { status: "offline" }); this.send("session:status", { sessionId, status: "offline" });
      } else if (isRateLimitError(e)) {
        session._pendingRetry = pendingRetry();
        this.scheduleRetry(sessionId, "ratelimited");
      } else {
        this.addMessage(session, { id: store.uid(), role: "error", text: "OpenAI / Codex run failed: " + String((e && e.message) || e), ts: store.nowISO() });
        runner.failed = true;
        this.finalizeRun(session, runner, { aborted: false, failed: true });
      }
    } finally {
      // Offline/auth/rate pauses skip finalization to retain their retry status. The native
      // thread still owns accepted tool outcomes; acknowledge those before releasing the run.
      this.acknowledgeAcceptedRun(session, runner);
      // …and what such a paused run left "running" (tool cards, agents) ends with its process.
      if (!runner.finalized) this.pauseRunLeftovers(session, runner);
      for (const t of outTimer.values()) clearTimeout(t);
      runner.running = false; runner.ended = true;
      prepared();
      clearTimeout(runner._graceTimer);
      if (this.runners.get(sessionId) === runner) { this.send("session:partial-reset", { sessionId }); this.runners.delete(sessionId); }
      if (this.draining.get(sessionId) === runner.done) this.draining.delete(sessionId);
      this.cancelPermissionsFor(sessionId, runId, "Run ended");
      store.flush(sessionId);
      if (runner._resolveDone) runner._resolveDone();
    }

    if (Array.isArray(reviewers) && reviewers.length && reviewMode === "after" && runner.completedClean && !background && !(fleet && fleet.taskId)) {
      try { await this.reviewAfter(session, reviewers, text || "", promptMessageId); } catch (e) { console.error("[council:after]", e); }
    }
  },
};

module.exports = { methods };
