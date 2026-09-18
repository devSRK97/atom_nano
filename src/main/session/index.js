"use strict";
/*
 * Session manager — drives one conversation ("session") through whichever
 * provider is selected: Anthropic (Claude Agent SDK), OpenAI (Codex app-server,
 * with the Codex SDK exec transport as fallback) or a Custom raw-HTTP endpoint.
 *
 * WHAT THE MODEL RECEIVES. The user's message text, exactly. Attachments as the
 * provider's native inputs (images by durable path; files by path / native
 * mention / full inline content). Conversation continuity comes from the
 * provider's own thread (resume) — and, when that thread has not seen part of
 * the canonical record (provider switch, lost thread, fresh thread), from an
 * EXACT transfer of the missing messages (history.js): never a summary, never
 * clipped, tool calls as completed history. Explicit user workflows (a role's
 * attached skills, configured reviewers / planner, fleet notes) travel as clearly
 * labelled conversation data appended after the user's own text — and a persistent
 * thread gets the skills / briefs in full only when new or changed, else one pointer
 * line (the delivery cache on its binding, see skillSnapshot / composeAttempt). The
 * app adds no behavioural instructions, no caps, no hidden effort/model/summary changes.
 *
 * LAYOUT (src/main/session/): this file holds the class core (state, run dispatch, the
 * canonical-record writers, terminal states) and assembles the per-concern method modules:
 *   anthropic.js / anthropic-events.js  Claude Agent SDK runner + its message stream
 *   openai.js · custom-http.js          Codex app-server / exec runner · raw HTTP endpoint
 *   transfer.js                         record transfer sized to the model (+ summaries)
 *   roles.js                            reviewers (council) + planner role
 *   permissions.js · control.js         permission bridge · stop / steer / live controls
 *   recovery.js                         preserved turns: offline / auth / rate-limit replay
 *   workflow.js                         orchestrator-as-primary: role briefs, child-session jobs, command jobs
 *   tasks.js                            the session's task board: sets + tasks, per-set chat cards, tasks:update
 *   sdk.js · errors.js · tools.js       pure helpers (SDK loader, error classes, tool utils)
 *
 * Emits normalized events to the renderer:
 *   session:status         { sessionId, status, provider?, model?, effort? }
 *   session:message        { sessionId, message }
 *   session:message-update { sessionId, messageId, patch }
 *   session:partial        { sessionId, index, kind, delta, parent? }
 *   session:partial-reset  { sessionId, index? }
 *   session:edited-files   { sessionId, files }
 *   session:permission     { sessionId, requestId, toolName, input }
 */
const path = require("path");
const store = require("../storage/store");
const history = require("../storage/history");
const attachmentsStore = require("../storage/attachments");

const { setSDK, effortFor, applyThinking, normEffort, supportsXhigh, supportsAdaptiveThinking } = require("./sdk");
const { describeError, isRateLimitError, isNetworkError, isAuthError, isPromptTooLong, isSessionGone } = require("./errors");
const { INTERRUPT_GRACE_MS, sumModelUsage, computeDiff, toolResultText } = require("./tools");
const { SUMMARY_INSTRUCTIONS } = require("./transfer");

/* Role-only skill delivery + the per-thread delivery cache (2026-09-18).
 * Only a PERSISTENT ROLE SESSION — a planner / coder / reviewer child of an orchestrator (workflow.js
 * SKILL_ROLES) — carries an effective skill selection: the skills attached to its role. It survives the
 * individual jobs (the role's session is reused task after task), so no live job is required. A plain
 * chat's legacy `selectedSkills` has no effect any more. What a thread has ALREADY received is remembered
 * on its binding (history.js: bindings.<provider>.skillsHash, and briefHash for Codex) so that an unchanged
 * selection travels as one pointer line instead of the full procedures on every turn. */
const SKILL_ROLE_SESSIONS = ["planner", "coder", "reviewer"];
const SKILL_MISSING = "missing";   // a selected id with no record contributes this marker to the hash — creating the skill later changes the hash
const sha256 = (v) => require("crypto").createHash("sha256").update(JSON.stringify(v)).digest("hex");
// The canonical project identity in the skills hash (skills are per project; the same id under another project is another skill).
const projectKey = (cwd) => String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const SKILLS_LABEL = "Skills the user selected for this message (their saved procedures";
const SKILLS_CLEARED = "Skills: none are attached to this conversation any more — the skill procedures provided earlier in this conversation no longer apply.";
/* Codex brief delivery lines (2026-09-18). The pointer names ONLY the briefs currently active (a pointer that
 * reaffirmed "any sub-agents brief given earlier" kept a removed agents brief alive); a set that went from
 * something to nothing gets one explicit clearing line; a CHANGED set names each brief kind that is gone. */
const BRIEFS_CLEARED = "Briefs: none apply to this conversation any more — the role brief and any sub-agents brief given earlier in this conversation no longer apply.";
const ROLE_BRIEF_GONE = "Role brief: none applies to this conversation any more — any role brief given earlier in this conversation no longer applies.";
const AGENTS_BRIEF_GONE = "Sub-agents: no sub-agents brief applies to this conversation any more — any sub-agents brief given earlier in this conversation no longer applies.";

class SessionManager {
  constructor() {
    this.runners = new Map();          // sessionId → runner (one live run per session)
    this.permResolvers = new Map();    // requestId → { sessionId, runId, resolve }
    this.draining = new Map();         // sessionId → promise of a stopped run that is still winding down
    this.interruptGraceMs = INTERRUPT_GRACE_MS;
    this.taskIdleReleaseMs = 20000;    // after the LAST background task reports: wait this long for the CLI's follow-up turn before ending the input
    this.resultReleaseGraceMs = 2500;  // after a turn's result: wait this long for late task_started events before ending the input
    this.emit = () => {};
    this.cachedCliPath = null;
  }

  setEmitter(fn) { this.emit = fn; }

  send(channel, payload) { try { this.emit(channel, payload); } catch { /* window gone */ } }

  isRunning(id) { const r = this.runners.get(id); return !!(r && r.running); }

  runningCount() { let n = 0; for (const r of this.runners.values()) if (r.running) n++; return n; }

  runningCountForCwd(cwd) {
    if (!cwd) return this.runningCount();
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const want = norm(cwd);
    let n = 0;
    for (const [id, r] of this.runners) {
      if (!r || !r.running) continue;
      try { const s = store.getSession(id); if (s && norm(s.cwd) === want) n++; } catch { /* session gone */ }
    }
    return n;
  }

  addMessage(session, msg) {
    session.messages.push(msg);
    store.enforceCap(session);   // memory window; nothing is lost (archive-first)
    store.scheduleWrite(session.id);
    this.send("session:message", { sessionId: session.id, message: msg });
  }

  updateMessage(session, messageId, patch) {
    const m = session.messages.find((x) => x.id === messageId);
    if (m) Object.assign(m, patch);
    store.scheduleWrite(session.id);
    this.send("session:message-update", { sessionId: session.id, messageId, patch });
  }

  // Every file an edit tool touched, cumulatively for the session (no cap — the
  // Changed-files panel and exports must be able to show the complete list).
  trackEdit(session, filePath, toolName, diff) {
    if (!filePath) return;
    let e = session.editedFiles.find((x) => x.path === filePath);
    if (!e) { e = { path: filePath, count: 0, added: 0, removed: 0 }; session.editedFiles.push(e); }
    e.count++; e.tool = toolName; e.ts = store.nowISO();
    if (diff) { e.added = (e.added || 0) + (diff.added || 0); e.removed = (e.removed || 0) + (diff.removed || 0); }
    (session._runTouched = session._runTouched || []).push({ path: filePath, added: (diff && diff.added) || 0, removed: (diff && diff.removed) || 0 });
    store.scheduleWrite(session.id);
    this.send("session:edited-files", { sessionId: session.id, files: session.editedFiles });
  }

  // Map a raw SDK/transport error to a clear, user-facing sentence.
  describeError(e) { return describeError(e); }

  // Explicit user workflow data appended AFTER the user's own text — clearly
  // labelled conversation data, never an instruction prefix. The user's text is
  // always first and byte-exact.
  // `skillsNote` / `briefNote` are the one-line forms of a persistent thread's delivery cache (see skillDelivery /
  // composeAttempt): a pointer to procedures / briefs the thread already holds, or the explicit clearing line.
  // `briefsReplace` = the thread holds an EARLIER brief set and this one differs (briefDelivery "full" with a previous
  // hash): each present brief is labelled as replacing its predecessor; `roleBriefGone` / `agentsBriefGone` add one
  // explicit line for a brief KIND the thread received before that is absent now (composeAttempt decides from the
  // committed composition — an agents brief switched off used to vanish silently while later pointers reaffirmed it, 2026-09-18).
  workflowAppendix({ skillDigests, skillsNote, skillsReplace, extraSystem, reviewerDigest, roleBrief, agentsBrief, briefNote, briefsReplace, roleBriefGone, agentsBriefGone }) {
    const parts = [];
    if (skillDigests && skillDigests.length) parts.push(SKILLS_LABEL + (skillsReplace ? "; they replace any skills given earlier in this conversation" : "") + "):\n\n" + skillDigests.join("\n\n---\n\n"));
    else if (skillsNote) parts.push(String(skillsNote));
    // The Workflow role brief (orchestrator / planner / coder / reviewer / tester) — Codex and custom endpoints
    // have no system-prompt channel, so it travels as labelled data; Claude gets it as systemPrompt.append instead.
    if (roleBrief) parts.push("Role brief for this conversation (configured by the user in the Workflow studio" + (briefsReplace ? "; it replaces any role brief given earlier in this conversation" : "") + "):\n" + String(roleBrief));
    else if (roleBriefGone) parts.push(ROLE_BRIEF_GONE);
    // The sub-agents brief of a solo turn with the Agents switch on (session/subagents.js agentsBrief) — the
    // same explicit instruction Claude gets in its system-prompt append (Codex roles: 2026-09-17).
    if (agentsBrief) parts.push("Sub-agents (the Agents switch the user turned on" + (briefsReplace ? "; it replaces any sub-agents brief given earlier in this conversation" : "") + "):\n" + String(agentsBrief));
    else if (agentsBriefGone) parts.push(AGENTS_BRIEF_GONE);
    if (!roleBrief && !agentsBrief && briefNote) parts.push(String(briefNote));
    if (extraSystem) parts.push(String(extraSystem));
    if (reviewerDigest) parts.push(reviewerDigest);
    return parts.length ? "\n\n" + parts.join("\n\n") : "";
  }

  // Does this session carry an EFFECTIVE skill selection? Only a persistent role child of an orchestrator does
  // (planner / coder / reviewer — the roles that can have skills attached), whether or not one of its jobs is
  // live right now. A plain chat's legacy `selectedSkills` has no effect (2026-09-18).
  skillsApply(session) { return !!(session && session.parentId && SKILL_ROLE_SESSIONS.includes(session.role)); }

  /* The turn's SKILL SNAPSHOT — taken ONCE per logical turn (every attempt of the run decides and commits from
   * it, so a skill edited while the turn runs is detected on the next turn):
   *   ids      the eligible selection, deduplicated, in selection order
   *   names    the names of the records that exist (chat metadata: the reply's skill chips)
   *   records  [{ id, record | null, digest }] — `digest` is the procedure TEXT, FROZEN here (skills.digest, pure):
   *            what any attempt of this turn sends is exactly what the hash below describes. It used to be read
   *            from the live store at compose time, so an edit or removal between the snapshot and a replacement
   *            attempt (lost session / overflow: a second composeFor) sent NEW text under the OLD hash (2026-09-18).
   *   hash     what the delivery cache compares: sha256 of the canonical project identity plus the SORTED
   *            (id, updatedAt) pairs — a missing record contributes a marker, usage counters are ignored
   *            (markUsed bumps them without touching updatedAt). "" when nothing is deliverable (no existing record).
   *   empty    true when no selected record exists */
  skillSnapshot(session) {
    const ids = this.skillsApply(session) && Array.isArray(session.selectedSkills) ? [...new Set(session.selectedSkills.filter((x) => typeof x === "string" && x))] : [];
    const records = [], names = [];
    let skills = null;
    if (ids.length) { try { skills = require("../agents/skills"); } catch { skills = null; } }
    for (const id of ids) {
      let record = null, digest = "";
      try { record = (skills && skills.get(session.cwd, id)) || null; } catch { record = null; }
      if (record) { try { digest = skills.digest(session.cwd, id) || ""; } catch { digest = ""; } }
      records.push({ id, record, digest });
      if (record) names.push(record.name || id);
    }
    const empty = !names.length;
    const pairs = records.map((r) => [r.id, r.record ? (r.record.updatedAt == null ? "" : String(r.record.updatedAt)) : SKILL_MISSING]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { ids, names, records, empty, hash: empty ? "" : sha256([projectKey(session.cwd), pairs]) };
  }

  /* The procedures to SEND for a snapshot: the texts FROZEN in it — a skill edited or removed since the snapshot still
   * goes out as it was, so the text and the committed hash always agree (the next turn's snapshot notices the change
   * and resends). Usage bookkeeping (skills.markUsed: uses / lastUsed, never updatedAt) runs here, only for what
   * actually goes out — composeAttempt calls this once per attempt kind (resume / fresh) that delivers in full. */
  skillDigests(session, snap) {
    const out = [];
    if (!snap || !snap.records.some((r) => r.record)) return out;
    let skills = null;
    try { skills = require("../agents/skills"); } catch { skills = null; }
    for (const r of snap.records) {
      if (!r.record || !r.digest) continue;
      out.push(r.digest);
      if (skills) { try { skills.markUsed(session.cwd, r.id); } catch { /* bookkeeping only — a removed skill's frozen text still went out */ } }
    }
    return out;
  }

  // The stateless form (custom HTTP: every request carries the full eligible procedures): { digests, names, hash }.
  selectedSkillDigests(session) {
    const snap = this.skillSnapshot(session);
    return { digests: this.skillDigests(session, snap), names: snap.names, hash: snap.hash };
  }

  /* What an attempt sends for the skills to the thread it addresses. `prevHash` = the hash that thread's
   * binding last ACCEPTED ("" / absent for a fresh thread, a legacy binding, or a thread that never got skills):
   *   full     the saved procedures — a fresh thread, a legacy binding (resent once) or a CHANGED selection (a skill
   *            edited, membership changed, a missing skill that exists now); they replace the earlier selection
   *   pointer  one line naming the active skills — the unchanged selection the thread already holds
   *   clear    one explicit line, once — the selection went from something to nothing
   *   none     nothing — no skills now and none before */
  skillDelivery(snap, prevHash) {
    if (!prevHash) return snap.empty ? "none" : "full";
    if (prevHash === snap.hash) return snap.empty ? "none" : "pointer";
    return snap.empty ? "clear" : "full";
  }
  skillsNoteFor(mode, snap) {
    if (mode === "pointer") return "Skills active for this conversation (their saved procedures were provided earlier in this conversation and still apply): " + snap.names.join(", ") + ".";
    if (mode === "clear") return SKILLS_CLEARED;
    return "";
  }
  /* Codex has no system-prompt channel: its role / agents briefs ride in the appendix and are cached the same way as
   * the skills (2026-09-18 — the briefs used to commit a hash even when nothing was present, so removing both briefs
   * sent nothing while recording a change, and removing only the agents brief resent the role brief with no word about
   * the agents brief, which later pointers then reaffirmed). `hash` is "" when neither brief is present, so the modes
   * mirror skillDelivery exactly:
   *   full     both / either brief in full — a fresh thread, a legacy binding, or a CHANGED set (then labelled as
   *            replacing, with an explicit line for each brief kind that is absent now — workflowAppendix)
   *   pointer  one line naming the briefs currently active — the unchanged set the thread already holds
   *   clear    one explicit line, once — the set went from something to nothing (commits "")
   *   none     nothing — no briefs now and none before */
  briefHashOf(roleBrief, agentsBrief) { return roleBrief || agentsBrief ? sha256([String(roleBrief || ""), String(agentsBrief || "")]) : ""; }
  briefDelivery(hash, prevHash, present = !!hash) {
    if (!prevHash) return present ? "full" : "none";
    if (prevHash === hash) return present ? "pointer" : "none";
    return present ? "full" : "clear";
  }
  briefNoteFor(mode, roleBrief, agentsBrief) {
    if (mode === "pointer") {
      const active = [roleBrief ? "the role brief" : "", agentsBrief ? "the sub-agents brief" : ""].filter(Boolean);
      if (!active.length) return "";
      return "Briefs: unchanged — " + active.join(" and ") + " given earlier in this conversation still " + (active.length > 1 ? "apply" : "applies") + ".";
    }
    if (mode === "clear") return BRIEFS_CLEARED;
    return "";
  }

  /* Compose ONE attempt's appendix for a persistent provider. `prev` = the binding of the thread the attempt
   * RESUMES (its accepted hashes decide full / pointer / clear); null for a FRESH thread — the initial thread,
   * a lost-thread recovery, an overflow / rollover replacement, the fresh exec fallback — which has seen nothing,
   * whatever the still-bound old thread's binding says. `briefs` = the briefs travel in the appendix (Codex; Claude
   * keeps them in systemPrompt.append). Reviewer advice and the planner's plan are turn data, outside the hashes.
   * Returns { appendix, skillsMode, briefMode, commit } — `commit` is what the thread's binding records once it
   * ACCEPTS this input (commitAttempt / the exec acknowledgement). */
  composeAttempt(session, { snap, prev, roleBrief, agentsBrief, briefs = false, extraSystem, reviewerDigest }) {
    const prevSkills = prev && typeof prev.skillsHash === "string" ? prev.skillsHash : "";
    const skillsMode = this.skillDelivery(snap, prevSkills);
    const skillDigests = skillsMode === "full" ? this.skillDigests(session, snap) : [];
    const briefHash = this.briefHashOf(roleBrief, agentsBrief);
    const prevBriefs = prev && typeof prev.briefHash === "string" ? prev.briefHash : "";
    const briefMode = briefs ? this.briefDelivery(briefHash, prevBriefs) : "none";
    // The brief COMPOSITION travels with the hash (binding.briefKinds: "r" role, "a" agents): a CHANGED set names a
    // kind as gone only when the thread actually received it — a role job never carries a separate agents brief, so
    // its changed role brief must not announce an agents brief that never was. A binding with a hash but no
    // composition (an older build) cannot tell: every absent kind is named, the safe side.
    const briefKinds = (roleBrief ? "r" : "") + (agentsBrief ? "a" : "");
    const prevKinds = prev && typeof prev.briefKinds === "string" ? prev.briefKinds : null;
    const briefsReplace = briefMode === "full" && !!prevBriefs;
    const gone = (kind) => briefsReplace && !briefKinds.includes(kind) && (prevKinds === null || prevKinds.includes(kind));
    const appendix = this.workflowAppendix({
      skillDigests, skillsNote: this.skillsNoteFor(skillsMode, snap), skillsReplace: skillsMode === "full" && !!prevSkills,
      roleBrief: briefMode === "full" ? roleBrief : "", agentsBrief: briefMode === "full" ? agentsBrief : "", briefsReplace, roleBriefGone: gone("r"), agentsBriefGone: gone("a"),
      briefNote: this.briefNoteFor(briefMode, roleBrief, agentsBrief),
      extraSystem, reviewerDigest,
    });
    return { appendix, skillsMode, briefMode, commit: briefs ? { briefHash, briefKinds, skillsHash: snap.hash } : { skillsHash: snap.hash } };
  }

  // The thread ACCEPTED the attempt's input: its binding records what it now holds (the frozen attempt's hashes),
  // so the next turn on it sends pointers. Only once the native id is bound — thread creation / the record
  // injection alone never marks prompt delivery — and only from callers that verified the run still owns the session.
  commitAttempt(session, provider, runner, extra) {
    const at = runner && runner.attempt;
    const b = history.bindingFor(session, provider);
    if (!b.id) return false;
    const patch = { ...(extra || {}), ...(at && at.commit ? at.commit : {}) };
    if (Object.keys(patch).length) history.setBinding(session, provider, patch);
    return true;
  }

  async run(sessionId, { text, model, permissionMode, thinking, attachments, oneM, subAgents, subAgentsMax, canUseToolOverride, extraSystem, background, fleet, reviewers, reviewMode, planner, resumeContinuation, promptMessageId, provider, roleBrief, workflowJob } = {}) {
    let session = store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (this.isRunning(sessionId)) throw new Error("This tab is already running.");
    // The slot is RESERVED synchronously — before the wait for a stopped run's wind-down and before
    // any asynchronous setup (reviewers, planner, SDK load, record transfer): a second send is refused
    // at once, and Stop at ANY point before dispatch aborts the reservation's signal — the pending
    // send sees it and never starts (see control.js reserveRun / claimRun). Reserving only after the
    // drain left a window in which Stop found no owner and the queued send started afterwards.
    const reservation = this.reserveRun(sessionId, { text, provider });
    let handedOver = false;
    try {
      await this.awaitDrain(sessionId);   // a stopped run may still be winding down gracefully
      // After the wait: stopped, replaced or deleted meanwhile → nothing starts.
      const now = store.getSession(sessionId);
      if (!now) return;
      if (this.setupStopped(reservation) || this.runners.get(sessionId) !== reservation) { this._setupStopNote(now, reservation); return; }
      session = now;
      const r = await this._runSetup(sessionId, session, reservation, { text, model, permissionMode, thinking, attachments, oneM, subAgents, subAgentsMax, canUseToolOverride, extraSystem, background, fleet, reviewers, reviewMode, planner, resumeContinuation, promptMessageId, provider, roleBrief, workflowJob });
      if (!r) return;
      handedOver = true;   // the provider runner claims (or releases) the reservation itself
      return await r();
    } finally {
      if (!handedOver) this.releaseRun(sessionId, reservation);
    }
  }

  // Setup of a turn under its reservation. Returns null when the turn ends here (a pre-flight
  // failure or a stop), else the provider dispatch to run.
  async _runSetup(sessionId, session, reservation, { text, model, permissionMode, thinking, attachments, oneM, subAgents, subAgentsMax, canUseToolOverride, extraSystem, background, fleet, reviewers, reviewMode, planner, resumeContinuation, promptMessageId, provider, roleBrief, workflowJob }) {
    const stopped = () => this.setupStopped(reservation);
    // A workflow JOB's turn replayed after a pause (offline / login / rate limit) runs with the job's own
    // provider · model · effort · access and lane — never with the composer's live picks (applyLivePrefs).
    const liveJob = resumeContinuation && this.liveJobOf ? this.liveJobOf(session, workflowJob) : null;
    if (liveJob) { provider = liveJob.provider; model = liveJob.model; permissionMode = this.accessToPermission(liveJob.access, liveJob.provider); thinking = liveJob.effort; subAgents = liveJob.agents > 0; subAgentsMax = liveJob.agents || subAgentsMax; workflowJob = liveJob.id; }
    // A genuinely NEW prompt supersedes any queued retry payload and resets the
    // backoff. A resumeContinuation run is the SAME turn being retried.
    if (!resumeContinuation) {
      if (session._pendingRetry) delete session._pendingRetry;
      if (session.pendingRun) { session.pendingRun = null; store.updateSession(sessionId, { pendingRun: null }); }
      session._retryAttempt = 0;
      this.cancelScheduledRetry(sessionId);
    }
    if (model) session.model = model;
    if (permissionMode) session.permissionMode = permissionMode;
    if (thinking) session.thinking = thinking;
    if (typeof oneM === "boolean") session.oneM = oneM;
    session._runTouched = [];   // files touched by THIS run
    session._interruptRequested = false;   // a new turn supersedes any stale stop request

    // Durable attachments FIRST: a pasted image gets a file before anything else
    // sees it. A failed write is a visible error, not a silently image-less prompt.
    let atts = Array.isArray(attachments) ? attachments : [];
    try { atts = attachmentsStore.persistAll(atts); }
    catch (e) {
      this.addMessage(session, { id: store.uid(), role: "error", text: "Could not store an attachment before sending (" + ((e && e.message) || e) + "). Nothing was sent.", ts: store.nowISO() });
      store.updateSession(sessionId, { status: "error" }); this.send("session:status", { sessionId, status: "error" });
      return null;
    }
    attachments = atts;

    // The turn's identity is the user MESSAGE (its id), never "the last entry": reviewer /
    // planner / status cards appended before the provider runs must not move the boundary
    // between earlier history and the current prompt. On a retry/continuation the user
    // message is ALREADY in the transcript and its id travels with the retry payload.
    if (!resumeContinuation) {
      const um = { id: store.uid(), role: "user", text, ts: store.nowISO(), attachments: attachmentsStore.light(atts) };
      this.addMessage(session, um);
      promptMessageId = um.id;
    } else if (!promptMessageId || history.indexOfMessage(session, promptMessageId) < 0) {
      for (let i = session.messages.length - 1; i >= 0; i--) { const m = session.messages[i]; if (m && m.role === "user" && !m.steered) { promptMessageId = m.id; break; } }
    }
    const settings = store.getSettings(session.cwd);   // per-project settings (provider/model/flags)
    // The provider: an explicit override (a workflow job) → the session's own pin (a child session runs
    // on its role's provider) → the settings' provider.
    provider = provider || session.provider || settings.llmProvider || "anthropic";
    // WORKFLOW — the ORCHESTRATOR (explicit user configuration, docs/WORKFLOW_CONTRACT.md). While the
    // active workflow is enabled, the primary conversation IS the orchestrator: it runs with the
    // orchestrator role's provider / model / effort / access (empty = the composer's picks) and its brief
    // — the roles table and the atomnano CLI usage the studio shows — reaches the model as its role
    // brief. A child job (session.role), a background turn and a fleet task never become the
    // orchestrator. The legacy Plan → Code step is superseded by the workflow (its Planner is a worker
    // role now, 2026-09-17).
    const wf = this.workflowFor(session, settings);
    const primaryMode = !!(wf.enabled && !session.role && !background && !(fleet && fleet.taskId));
    session._wfPrimary = primaryMode;
    if (primaryMode) {
      const p = wf.roles.orchestrator;
      if (p.provider) provider = p.provider;
      if (p.model) session.model = p.model;
      if (p.effort) session.thinking = p.effort;
      if (p.access) session.permissionMode = this.accessToPermission(p.access, provider);
      roleBrief = this.orchestratorBrief(session, wf, provider);
      planner = null;
      // The workflow's Reviewer role replaces the council: the orchestrator decides when a review happens
      // (2026-09-17). Consulting the council on every primary turn as well doubled the review agents.
      reviewers = [];
      // The workflow and solo sub-agents are EXCLUSIVE (user decision 2026-09-18): the orchestrator fans out
      // only through the roles' lanes — its own turn never gets the Task tool or the solo agents brief, even
      // when the composer's Agents switch was left on.
      subAgents = false; subAgentsMax = undefined;
    } else if (!session.role && !background && !(fleet && fleet.taskId) && !roleBrief && settings.modeNote !== false) {
      // Solo primary turn: ONE sentence tells the model its mode — the workflow is off for this chat, solo
      // sub-agents on or off (user decision 2026-09-18: the model must know the current setting). It travels
      // the brief channel (Claude: systemPrompt.append, cached; Codex: once per thread, re-sent when it changes).
      // `settings.modeNote` (Settings → Agents & context) turns it off for a bare turn.
      roleBrief = this.modeBrief(session, wf, !!subAgents, subAgentsMax);
    }
    roleBrief = roleBrief ? String(roleBrief) : "";
    // Context follows the FINAL selected model, including a workflow role's
    // override. Old saved flags or a parent using a smaller model cannot cap a
    // compatible child model at 200K or omit its native 1M configuration.
    session.oneM = require("../providers/catalog").context1M(provider, session.model);
    // Snapshot of what THIS run was dispatched with — the renderer labels the live
    // reply from it, not from whatever the dropdowns say later.
    const dispatched = { provider, model: session.model, effort: session.thinking, permissionMode: session.permissionMode };
    store.updateSession(sessionId, { status: "running" });
    this.send("session:status", { sessionId, status: "running", ...dispatched });
    if (this.jobRunStarted) this.jobRunStarted(session, workflowJob);   // a workflow job: queued → running
    if (primaryMode) this.workflowStage(sessionId, "orchestrator", "running", { provider, model: session.model });

    // Council — consult-before (an explicit, user-configured workflow with its own visible cards).
    let reviewerBeforeDigest = "";
    if (Array.isArray(reviewers) && reviewers.length && reviewMode === "before") {
      try { reviewerBeforeDigest = await this.consultReviewers(session, reviewers, text || "", promptMessageId, reservation.abortController.signal); } catch (e) { if (!stopped()) console.error("[council:before]", e); }
      // Stop during the consultation: the interrupt already recorded "Stopped by you." and set the
      // tab idle (finalizeRun on the reservation) — nothing is dispatched.
      if (stopped() || session._interruptRequested) { this._setupStopNote(session, reservation); return null; }
    }

    if (provider === "google") {
      this.addMessage(session, { id: store.uid(), role: "error", text: "Google primary (Antigravity / agy) integration was removed from this build. Switch the provider to Anthropic (Claude), OpenAI, or Custom in Settings → Providers.", ts: store.nowISO() });
      store.updateSession(sessionId, { status: "error" }); this.send("session:status", { sessionId, status: "error" });
      return null;
    }

    // Provider continuity: every provider keeps its own binding (native thread +
    // how much of the record it has seen). Switching providers changes which
    // binding generates next — nothing is cleared, and the destination receives
    // the exact messages it has not seen (see runAnthropic / runOpenAI).
    if (session.lastProvider && session.lastProvider !== provider) console.log(`[run] provider switch ${session.lastProvider} → ${provider} — the ${provider} thread will receive the exact missing conversation record`);
    session.lastProvider = provider;
    store.scheduleWrite(sessionId);

    // ROLE PIPELINE — Planner phase (explicit user configuration). The Planner drafts
    // a plan as its own visible card; the Coder receives it as workflow data.
    if (planner && planner.enabled && (planner.provider || planner.model) && !background && !(fleet && fleet.taskId)) {
      let pr = { plan: "", aborted: false };
      try { pr = await this.runPlanner(sessionId, session, { userText: text, planner, settings, promptMessageId, reservation }); }
      catch (e) {
        if (!stopped()) {
          console.error("[planner]", e);
          this.addMessage(session, { id: store.uid(), role: "system", text: "Planner step failed — continuing without a plan. (" + String((e && e.message) || e) + ")", ts: store.nowISO() });
        }
      }
      if (pr.aborted || stopped() || session._interruptRequested) {
        this._setupStopNote(session, reservation, "Stopped during planning.");
        // Only while this reservation still owns the slot: a newer run's stream is never wiped.
        if (this.runners.get(sessionId) === reservation) this.send("session:partial-reset", { sessionId });
        return null;
      }
      if (pr.plan) extraSystem = (extraSystem ? extraSystem + "\n\n" : "") + "Implementation plan produced by the Planner role you configured (the Coder follows it):\n" + pr.plan;
    }
    if (stopped()) { this._setupStopNote(session, reservation); return null; }

    const common = { text, attachments, reviewers, reviewMode, background, fleet, extraSystem, roleBrief, subAgents, subAgentsMax, canUseToolOverride, resumeContinuation, promptMessageId, provider, workflowJob, reservation };
    if (provider === "openai") return () => this.runOpenAI(sessionId, session, common, reviewerBeforeDigest, settings, dispatched);
    if (provider === "custom") {
      const ep = require("../providers/custom-api").getEndpoint(settings, session.model);
      if (ep) return () => this.runCustomHttp(sessionId, session, common, reviewerBeforeDigest, settings, ep);
      if (settings.customMode === "raw") return () => this.runCustomHttp(sessionId, session, common, reviewerBeforeDigest, settings, null);
    }
    return () => this.runAnthropic(sessionId, session, common, reviewerBeforeDigest, settings, provider, dispatched);
  }

  // A stop during setup: the interrupt on the reservation already recorded the stop and set the tab
  // idle; only a stop that bypassed it (legacy _interruptRequested) is recorded here.
  _setupStopNote(session, reservation, text = "Stopped by you.") {
    if (reservation && reservation.finalized) return;
    this.addMessage(session, { id: store.uid(), role: "system", text, ts: store.nowISO() });
    // The status belongs to whoever owns the slot: a reservation that lost it leaves the status alone.
    if (reservation && !this.ownsStatus(session.id, reservation)) return;
    store.updateSession(session.id, { status: "idle" }); this.send("session:status", { sessionId: session.id, status: "idle" });
  }

  // May THIS run still set the tab's status? Not once a newer run owns the slot (a stale completion
  // must never clear a newer state); the run that owns the slot — or a finished one nobody replaced — may.
  ownsStatus(sessionId, runner) {
    const cur = this.runners.get(sessionId);
    return !cur || cur === runner || !cur.running;
  }

  // A run that cannot start (capability / configuration error): one visible error, terminal state "error".
  failRun(session, message) {
    this.addMessage(session, { id: store.uid(), role: "error", text: message, ts: store.nowISO() });
    store.updateSession(session.id, { status: "error" });
    this.send("session:status", { sessionId: session.id, status: "error" });
  }

  // Compact run descriptor stamped onto each assistant reply (provider/model/
  // thinking + reviewers). Pretty labels are resolved in the renderer.
  replyMeta(provider, model, thinking, reviewers, reviewMode) {
    return {
      provider: provider || "anthropic",
      model: model || "",
      thinking: thinking || "off",
      reviewMode: reviewMode === "after" ? "after" : "before",
      reviewers: Array.isArray(reviewers) ? reviewers.map((r) => ({ provider: r.provider, model: r.model || "" })) : [],
    };
  }

  /* ------------------------------- Council ------------------------------- */
  lastAssistantText(session) {
    for (let i = session.messages.length - 1; i >= 0; i--) { const m = session.messages[i]; if (m.role === "assistant" && m.text) return m.text; }
    return "";
  }

  // ONE terminal-state transition per run: completed | failed | interrupted | stopped.
  // Only a GENUINE completion sets completedClean (what gates success-dependent work).
  // The workflow hooks in here too (session/workflow.js): a job's child run ending ends the job,
  // an orchestrator turn ending is its stage's terminal event.
  finalizeRun(session, runner, { aborted, failed }) {
    if (runner.finalized) return;
    runner.finalized = true;
    try { this._finalizeRun(session, runner, { aborted, failed }); }
    finally {
      if (this.workflowRunEnded) {
        try { this.workflowRunEnded(session, runner, (runner.interrupted || aborted) ? "stopped" : (failed || runner.failed) ? "error" : "done"); }
        catch (e) { console.warn("[workflow]", (e && e.message) || e); }
      }
    }
  }

  acknowledgeAcceptedRun(session, runner) {
    const sessionId = session.id;
    // Once the provider ACCEPTED this turn's input, its native thread holds the prompt and
    // everything the turn produced (partial output, tool calls) — even when the turn was stopped
    // or failed afterwards. Acknowledge that on the cursor so the next prompt sends only what is
    // new; a turn rejected BEFORE acceptance (network, prompt too long) leaves the cursor alone.
    const owner = this.runners.get(sessionId), latest = this._lastRunId && this._lastRunId.get(sessionId);
    const mayAcknowledge = (!owner || owner === runner) && (!latest || latest === runner.id);
    if (mayAcknowledge && runner.accepted && runner.bindingProvider && !runner._external && !runner.retargeted) {
      try { history.setBinding(session, runner.bindingProvider, { syncedIndex: history.lastGlobalIndex(session) }); } catch { /* binding update is best effort */ }
    }
  }

  /* Whatever THIS run left in flight ends with it: its tool cards still "running", the sub-agents it
   * launched (their CPU slots freed — see subagents.js closeRunAgents) and the permission prompts it
   * opened. finalizeRun calls it for a stopped / failed run; the runners' cleanup calls it for a run
   * that PAUSED (offline, login, rate limit) — such a run keeps its retry status and never
   * finalises, but its CLI process is gone, so nothing it started is still running. (Before, a paused
   * run left its agents "running" for hours and their slots taken, 2026-09-17.) Once per run. */
  settleRunLeftovers(session, runner, { status = "interrupted", note = "" } = {}) {
    if (!session || !runner || runner._leftoversSettled) return false;
    runner._leftoversSettled = true;
    const sessionId = session.id, stopTs = store.nowISO();
    for (const msg of session.messages) {
      if (msg && msg.role === "tool" && (msg.status === "running" || msg.status === "queued" || msg.status === "preparing") && (!msg.runId || msg.runId === runner.id)) {
        const patch = { status, result: msg.result || note || (status === "error" ? "The run failed before this tool finished." : "Stopped before this tool finished."), endedTs: stopTs };
        Object.assign(msg, patch);
        this.send("session:message-update", { sessionId, messageId: msg.id, patch });
      }
    }
    // Cancel permission cards left in flight FOR THIS RUN ONLY.
    this.cancelPermissionsFor(sessionId, runner.id, "Stopped");
    // Sub-agents of this run that never reported end with it.
    if (this.closeRunAgents) { try { this.closeRunAgents(session, runner, status, note); } catch { /* registry is bookkeeping */ } }
    return true;
  }
  // A run that paused on a recoverable error (its CLI is gone; the turn is retried on a fresh process).
  pauseRunLeftovers(session, runner) {
    return this.settleRunLeftovers(session, runner, { status: "interrupted", note: "Paused before this finished — the turn stopped on a connection, login or rate-limit problem and is retried; the retry starts this step over." });
  }

  _finalizeRun(session, runner, { aborted, failed }) {
    const sessionId = session.id;
    this.acknowledgeAcceptedRun(session, runner);
    if (runner.interrupted || aborted || failed) {
      this.settleRunLeftovers(session, runner, { status: failed && !runner.interrupted && !aborted ? "error" : "interrupted" });
    } else if (this.closeRunAgents) { try { this.closeRunAgents(session, runner, "done"); } catch { /* */ } }
    // The status transition below belongs to the run that owns the slot: a run that was replaced
    // (interrupt released the slot, a newer run took it) records its note but leaves the status alone.
    const setStatus = (status) => { if (!this.ownsStatus(sessionId, runner)) return; store.updateSession(sessionId, { status }); this.send("session:status", { sessionId, status }); };
    // The rolling digest follows a CLEAN Claude turn (and, in anthropic-events.js, every genuine
    // interim result of a long turn). A stopped or aborted turn starts NO new model work: Stop must
    // stop work, not spawn paid summaries — and Stop has already cancelled the session's running
    // preparations (control.js interrupt → cancelPreparations).
    const digest = () => { if (runner.bindingProvider === "anthropic" && this.maybeDigest && !runner.interrupted && !this.setupStopped(runner)) this.maybeDigest(session, { signal: runner.abortController && runner.abortController.signal }).catch((e) => console.warn("[context:digest]", (e && e.message) || e)); };
    if (runner.interrupted) {
      const replacing = runner.interruptReason === "replace";
      this.addMessage(session, { id: store.uid(), role: "system", text: replacing ? "Interrupted — running your new message…" : "Stopped by you.", ts: store.nowISO() });
      setStatus("idle");
      return;
    }
    if (aborted) {
      this.addMessage(session, { id: store.uid(), role: "system", text: "Stopped.", ts: store.nowISO() });
      setStatus("idle");
      return;
    }
    const finalStatus = (failed || runner.failed) ? "error" : "done";
    runner.completedClean = finalStatus === "done";
    setStatus(finalStatus);
    // A clean Claude turn: keep the rolling record digest current in the background (see transfer.js).
    if (runner.completedClean) digest();
  }

  // Per-run diagnostics (what was dispatched / acknowledged), secrets excluded.
  lastRunInfo() { return this._lastRun || null; }
}

// Per-concern method modules → one prototype (each file exports { methods }).
for (const mod of ["./anthropic", "./anthropic-events", "./openai", "./custom-http", "./transfer", "./roles", "./permissions", "./control", "./recovery", "./subagents", "./workflow", "./tasks"]) {
  Object.assign(SessionManager.prototype, require(mod).methods);
}

module.exports = new SessionManager();
module.exports.setSDK = setSDK;   // test seam (like setSummarizer): inject a fake SDK
module.exports.__internals = { effortFor, applyThinking, normEffort, supportsXhigh, supportsAdaptiveThinking, isRateLimitError, isNetworkError, isAuthError, isPromptTooLong, isSessionGone, sumModelUsage, computeDiff, toolResultText, SessionManager, SUMMARY_INSTRUCTIONS };
