/* AtomNano renderer — Message cards — user / assistant / tool / thinking / result cards, live stream, permissions, scrolling.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { MODELS, prettyModelName } from "../core/catalog.js";
import { $, _ctxMenuOpen, baseName, fmtDur, fmtTime, h, mdToRichHtml, relPath, toast } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { cm, openInEditor, parseDiffToGutter, stateActiveFile } from "../editor/editor-pane.js";
import { openSearch } from "../editor/search-palette.js";
import { icon } from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { AG_TERMINAL, agentByToolUse, agentElapsedMs, fmtSpan, openAgents } from "../panels/agents.js";
import { TASK_STATUS_TITLE, openBoard, taskStatusOf } from "../panels/board.js";
import { fileContextMenu } from "../workspace/sidebar.js";
import { permDD, resendPrompt } from "./composer.js";
import { openAccountSwitcher, resumeAuthExpired, startRateTicker } from "./events.js";
import { openSessionTab } from "./history.js";
import { _loadingNewer, _loadingOlder, atTail, attachmentsRow, loadNewer, loadOlder, reloadTail, renderMessagesRegion, renderPromptRail, roleLine } from "./navigation.js";
import { renderTabs, roleMeta } from "./tabs.js";

// (_followTail — is the reader at the tail? — lives with the scroll helpers in chat/messages.js.)

// Infinite scroll: auto-load older messages when the user reaches the top.
export function wireChatScroll() {
  const w = $("chatWrap");
  if (!w) return;
  // Floating "jump to latest" button — shown as soon as the user scrolls up.
  const btn = h("button", { id: "scrollBtn", class: "scroll-bottom hidden", title: "Jump to latest", html: icon("chevronDown", 20), onclick: () => scrollBottom(true) });
  $("main").append(btn);
  w.addEventListener("scroll", () => {
    // Read here, where layout has already settled, rather than in the streaming
    // flush where the same read forces a reflow every frame.
    const ts = activeTS();
    _followTail = nearBottom() && (!ts || atTail(ts));
    updateScrollBtn();
    if (!ts) return;
    // Window detached from the tail (jumped to an older spot): scrolling down
    // pages the NEWER messages back in until the live tail is reached.
    if (!atTail(ts) && !_loadingNewer && w.scrollHeight - w.scrollTop - w.clientHeight < 120) loadNewer();
    if (_loadingOlder) return;   // shared with the "load earlier" button
    if (w.scrollTop <= 60 && (ts.viewStart > 0 || ts.firstIndex > 0)) loadOlder();
  }, { passive: true });
  updateScrollBtn();
}
// Show the jump-to-latest caret once the user is more than ~2 lines off bottom.
export function updateScrollBtn() {
  const w = $("chatWrap"), b = $("scrollBtn");
  if (!w || !b) return;
  const dist = w.scrollHeight - w.scrollTop - w.clientHeight;
  b.classList.toggle("hidden", dist < 48);
}
/* ---------------------------- image viewer ---------------------------- */
export function openImageViewer(src, name) {
  if (!src) { toast("No image to view", "alert"); return; }
  if ($("imgViewer")) $("imgViewer").remove();
  let scale = 1, rot = 0, tx = 0, ty = 0, drag = null;
  const img = h("img", { class: "iv-img", src, draggable: "false" });
  img.addEventListener("error", () => { if (img.dataset.fb !== "1" && name) { /* keep */ } });
  const zlbl = h("span", { class: "iv-zoom" });
  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg) scale(${scale})`; zlbl.textContent = Math.round(scale * 100) + "%"; };
  const zoom = (f) => { scale = Math.min(8, Math.max(0.1, scale * f)); apply(); };
  const stage = h("div", { class: "iv-stage" }, img);
  const onMove = (e) => { if (!drag) return; tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply(); };
  const onUp = () => { drag = null; img.classList.remove("grabbing"); };
  const onKey = (e) => { if (e.key === "Escape") close(); else if (e.key === "+" || e.key === "=") zoom(1.2); else if (e.key === "-") zoom(1 / 1.2); else if (e.key.toLowerCase() === "r") { rot = (rot + 90) % 360; apply(); } };
  const close = () => { ov.remove(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); document.removeEventListener("keydown", onKey); };
  const btn = (icn, title, fn) => h("button", { class: "iv-btn", title, html: icon(icn, 16), onclick: (e) => { e.stopPropagation(); fn(); } });
  const dl = h("a", { class: "iv-btn", title: "Download", href: src, download: name || "image.png", html: icon("download", 16), onclick: (e) => e.stopPropagation() });
  const controls = h("div", { class: "iv-controls", onclick: (e) => e.stopPropagation() },
    btn("minus", "Zoom out (−)", () => zoom(1 / 1.2)), zlbl, btn("plus", "Zoom in (+)", () => zoom(1.2)),
    h("span", { class: "iv-sep" }),
    btn("refresh", "Rotate (R)", () => { rot = (rot + 90) % 360; apply(); }),
    btn("maximize", "Reset", () => { scale = 1; rot = 0; tx = 0; ty = 0; apply(); }),
    dl, h("span", { class: "iv-sep" }), btn("close", "Close (Esc)", close));
  const ov = h("div", { id: "imgViewer", class: "img-viewer", onclick: (e) => { if (e.target === ov || e.target === stage) close(); } }, stage, controls);
  stage.addEventListener("wheel", (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : 0.89); }, { passive: false });
  img.addEventListener("mousedown", (e) => { e.preventDefault(); drag = { x: e.clientX - tx, y: e.clientY - ty }; img.classList.add("grabbing"); });
  window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp); document.addEventListener("keydown", onKey);
  document.body.append(ov); apply();
  return ov;
}
// Hover copy button for a message card — copies the raw text of the prompt/response.
export function msgCopyBtn(text) {
  if (!text) return null;
  return h("button", {
    class: "msg-copy", dataset: { tip: "Copy", tipDir: "top" },
    onclick: async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.blur();   // drop focus so no lingering ring after a click
      try { await atom.clipboard.write(text, mdToRichHtml(text)); btn.classList.add("copied"); btn.innerHTML = icon("check", 12); setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = icon("copy", 12); }, 1200); }
      catch { toast("Copy failed", "alert"); }
    },
  }, h("span", { html: icon("copy", 12) }));
}
// Per-message delete button (hover) — removes the message from the transcript.
export function msgDeleteBtn(mid) {
  if (!mid) return null;
  return h("button", {
    class: "msg-copy msg-del", dataset: { tip: "Delete", tipDir: "top" },
    onclick: (e) => { e.stopPropagation(); e.currentTarget.blur(); deleteMessage(mid); },
  }, h("span", { html: icon("trash", 12) }));
}
// Inline actions shown in the role line (above the message): copy + delete.
export function msgTopActions(m) { return h("span", { class: "msg-actions" }, msgCopyBtn(m.text), msgDeleteBtn(m.id)); }
// Footer actions shown below the message bubble: copy + delete.
export function msgBottomActions(m) { return h("div", { class: "msg-actions msg-actions-btm" }, msgCopyBtn(m.text), msgDeleteBtn(m.id)); }
// Delete a message: remove from the on-disk transcript, then from the live view.
export async function deleteMessage(mid) {
  const ts = activeTS(); if (!ts) return;
  try {
    const ok = await atom.sessions.deleteMessage(ts.meta.id, mid);
    if (ok === false) return;
    const i = ts.messages.findIndex((m) => m.id === mid);
    if (i >= 0) { ts.messages.splice(i, 1); if (ts.totalMessages) ts.totalMessages -= 1; }
    renderMessagesRegion();
    renderPromptRail();
  } catch (e) { toast("Delete failed: " + (e && e.message || e), "alert"); }
}
export const RV_LABEL = { openai: "Codex", google: "Antigravity", anthropic: "Claude", custom: "Custom" };
export const PROVIDER_NAME = { anthropic: "Claude", google: "Antigravity", openai: "OpenAI", custom: "Custom" };
export const THINK_NAMES = { off: "", think: "Think", "think-hard": "Think hard", "think-harder": "Think harder", ultrathink: "Ultrathink", none: "Effort: none", minimal: "Effort: minimal", low: "Effort: low", medium: "Effort: medium", high: "Effort: high", xhigh: "Effort: x-high", max: "Effort: max", ultra: "Effort: ultra", persistent: "Effort: persistent", ultracode: "Effort: ultracode" };
// Pretty model name from the (provider-aware) catalog, else a Claude-id heuristic.
export function modelName(provider, id) {
  if (!id) return "";
  const cat = state.providerCatalog && state.providerCatalog[provider];
  const m = cat && (cat.models || []).find((x) => x.id === id);
  if (m) return m.name;
  const local = MODELS.find((x) => x.id === id);
  return (local && local.name) || prettyModelName(id) || id;
}
// Stable filter key for a reply's provider+model.
export function metaKey(meta) { return meta && meta.provider ? `${meta.provider}|${meta.model || ""}` : ""; }
// The small descriptor row under a reply: provider's model · thinking · reviewers.
export function replyMetaRow(meta) {
  if (!meta || !meta.provider) return null;
  const parts = [h("span", { class: "mm-model", text: modelName(meta.provider, meta.model) || PROVIDER_NAME[meta.provider] || meta.provider })];
  const tn = THINK_NAMES[meta.thinking];
  if (tn) parts.push(h("span", { class: "mm-sep", text: "·" }), h("span", { class: "mm-think", text: tn }));
  if (Array.isArray(meta.reviewers) && meta.reviewers.length) {
    const verb = meta.reviewMode === "after" ? "reviewed by" : "consulted";
    const names = meta.reviewers.map((r) => (RV_LABEL[r.provider] || r.provider) + (r.model ? " " + modelName(r.provider, r.model) : "")).join(", ");
    parts.push(h("span", { class: "mm-rev" }, h("span", { html: icon("shield", 11) }), h("span", { text: `${verb} ${names}` })));
  }
  return h("div", { class: "msg-meta" }, ...parts);
}
// A generated-image message: caption + the image(s) (click to view / download).
export function imageMsgCard(m) {
  const body = h("div", { class: "msg-body" }, roleLine((PROVIDER_NAME[m.provider] || "Image"), m.ts, null));
  body.append(h("div", { class: "img-gen-cap" }, h("span", { html: icon("image", 12) }), h("span", { text: "Generated image · " + (m.prompt || "") + (m.mode === "photo" ? "" : " · vector") })));
  const row = attachmentsRow(m.images);
  if (row) body.append(row);
  return h("div", { class: "msg assistant", dataset: { mid: m.id } }, h("div", { class: "msg-avatar assistant", html: icon("image", 16) }), body);
}
export function reviewerCard(m) {
  const lbl = (RV_LABEL[m.reviewProvider] || m.reviewProvider || "Reviewer") + (m.reviewModel ? " · " + m.reviewModel : "");
  const tag = m.reviewKind === "review" ? "Review" : "Advice";
  const body = h("div", { class: "msg-body" },
    h("div", { class: "msg-role reviewer-role" }, h("span", { class: "rv-tag", text: tag }), h("span", { class: "rv-name", text: lbl }), msgCopyBtn(m.text)));
  // What was actually asked of this reviewer (the primary's question) — collapsed.
  if (m.asked) {
    const det = h("details", { class: "rv-asked" }, h("summary", { text: m.reviewKind === "review" ? "Question + answer sent for review" : "Question sent to this reviewer" }), h("div", { class: "rv-asked-body", text: m.asked }));
    body.append(det);
  }
  // The advice/review itself — COLLAPSED by default with a one-line preview.
  const preview = (m.text || "").replace(/\s+/g, " ").trim();
  const adv = h("details", { class: "rv-advice" },
    h("summary", {}, h("span", { class: "rv-prev", text: (preview.slice(0, 96) || "(no response)") + (preview.length > 96 ? "…" : "") })),
    h("div", { class: "bubble", html: renderMarkdown(m.text || "") }));
  body.append(adv);
  return h("div", { class: "msg reviewer", dataset: { mid: m.id } }, h("div", { class: "msg-avatar reviewer", html: icon("shield", 15) }), body);
}
export function renderMessage(m, ts) {
  switch (m.role) {
    case "user": {
      const body = h("div", { class: "msg-body" }, roleLine("You", m.ts, msgTopActions(m)));
      const att = attachmentsRow(m.attachments);
      if (att) body.append(att);
      if (m.text) body.append(h("div", { class: "bubble user-text", text: m.text }));
      if (state.settings.resendButton !== false && m.text) {
        body.append(h("button", { class: "msg-resend", title: "Resend this prompt", onclick: () => resendPrompt(m.text) },
          h("span", { html: icon("refresh", 12) }), h("span", { text: "Retry" })));
      }
      body.append(msgBottomActions(m));
      return h("div", { class: "msg user", dataset: { mid: m.id } },
        h("div", { class: "msg-avatar user", html: '<b style="font-size:15px">›</b>' }), body);
    }
    case "assistant": {
      // For a custom endpoint, show its NAME as the author (not the generic "Custom").
      const label = (m.meta && (m.meta.endpointName || PROVIDER_NAME[m.meta.provider])) || "Claude";
      const body = h("div", { class: "msg-body" }, roleLine(label, m.ts, msgTopActions(m)), h("div", { class: "bubble", html: renderMarkdown(m.text) }));
      const meta = replyMetaRow(m.meta);
      if (meta) body.append(meta);
      body.append(msgBottomActions(m));
      const ds = { mid: m.id }; if (m.meta) ds.mk = metaKey(m.meta);
      const el = h("div", { class: "msg assistant" + (m.parentToolUseId ? " subagent" : ""), dataset: ds }, h("div", { class: "msg-avatar assistant", html: icon("atom", 17) }), body);
      if (m.parentToolUseId) labelSubagentNode(el, m.parentToolUseId);   // "#n · type" rail label of the agent that produced it
      return el;
    }
    case "reviewer":
      return reviewerCard(m);
    case "planner":
      return plannerCard(m);
    case "image":
      return imageMsgCard(m);
    case "thinking":
      return wrapFlow(thinkingCard(m.text), m.id, m.parentToolUseId);
    case "tool":
      return wrapFlow(toolCard(m, ts), m.id, m.parentToolUseId);
    case "result":
      return wrapFlow(resultLine(m.meta, m.ts), m.id);
    case "error":
      return wrapFlow(h("div", { class: "error-card" }, h("span", { html: icon("alert", 18) }), m.text), m.id);
    case "system":
      return wrapFlow(h("div", { class: "sys-note", text: m.text }), m.id);
    case "summary":
      return wrapFlow(summaryCard(m), m.id);
    case "record":
      return wrapFlow(recordCard(m), m.id);
    case "job":
      return wrapFlow(jobCard(m, ts), m.id);
    case "tasks":
      return wrapFlow(tasksCard(m, ts), m.id);
    default:
      return h("div", { dataset: { mid: m.id } });
  }
}
// The condensed handoff a synthesized session carries from its source: the summary of the oldest
// entries, the session map (goals, outcomes, files, tools) and the recent entries — shown as
// structured sections, with the exact text the model receives one click away (nothing hidden).
// Older seeds without a map fall back to the plain text body.
export function recordCard(m) {
  const meta = m.meta || {};
  const n = (x) => Number(x || 0).toLocaleString();
  const chars = meta.chars || (m.text || "").length;
  const what = meta.selected ? `working memory + ${n(meta.selectedCount)} selected entries`
    : meta.mode === "summary" ? `summary of the ${n(meta.headCount)} oldest + ${n(meta.tailCount)} recent verbatim`
    : meta.mode === "shortened" ? `${n(meta.entries)} entries, long tool output shortened`
      : meta.mode === "exact" ? `${n(meta.entries)} entr${meta.entries === 1 ? "y" : "ies"} verbatim` : "no record entries";
  const structured = !!(meta.map || meta.summary);
  const label = structured
    ? `Continued from “${meta.sourceName || "a previous session"}” — condensed handoff · ${what}${meta.map ? " · session map" : ""} · ${fmtCompactTok(chars)} chars`
    : `Continued from "${meta.sourceName || "a previous session"}" — ${n(meta.entries)} entries carried (${meta.mode === "summary" ? "summary of the oldest entries + recent entries verbatim" : meta.mode === "shortened" ? "verbatim, long tool outputs shortened" : "verbatim"})`;
  const card = h("div", { class: "thinking-card summary-card record-card" + (structured ? " structured" : "") },
    h("div", { class: "thinking-head" }, h("span", { html: icon("history", 15) }), h("span", { text: label }), h("span", { class: "chev", html: icon("chevron", 13) })));
  if (!structured) { card.append(h("div", { class: "thinking-body", text: m.text || "" })); return card; }
  const sec = (title, ...kids) => h("div", { class: "rc-sec" }, h("div", { class: "rc-title", text: title }), ...kids);
  const chip = (t) => h("span", { class: "rc-chip", text: t });
  const body = h("div", { class: "thinking-body rc-body" });
  const map = meta.map;
  if (map) body.append(h("div", { class: "rc-facts" }, chip(`${n(map.total)} entries`), chip(`${n(map.userTurns)} prompts`), chip(`${n(map.assistantTurns)} replies`), chip(`${n(map.toolCalls)} tool calls`), meta.fullChars ? chip(`${fmtCompactTok(meta.fullChars)} chars in the source`) : null));
  if (meta.summary) body.append(sec(meta.selected ? "Saved working memory" : meta.mode === "summary" ? `Summary of the ${n(meta.headCount)} oldest entries` : "Summary", h("div", { class: "rc-md", html: renderMarkdown(meta.summary) })));
  if (map) {
    if (map.goals && map.goals.length) body.append(sec("Goals pursued", h("ul", { class: "rc-list" }, ...map.goals.map((t) => h("li", { text: t })))));
    if (map.outcomes && map.outcomes.length) body.append(sec("Outcomes reported", h("ul", { class: "rc-list" }, ...map.outcomes.map((t) => h("li", { text: t })))));
    if (map.files && map.files.length) body.append(sec("Files worked on", h("div", { class: "rc-files" }, ...map.files.slice(0, 16).map((f) => h("span", { class: "rc-file", title: f.path }, h("span", { class: "rc-file-name", text: baseName(f.path) }), h("span", { class: "rc-file-stat", text: `${f.count}× · +${f.added}/−${f.removed}` }))))));
    if (map.tools && map.tools.length) body.append(sec("Tools used", h("div", { class: "rc-facts" }, ...map.tools.slice(0, 10).map((t) => chip(`${t.name} ${t.count}×`)))));
  }
  if (meta.tailCount) body.append(h("div", { class: "rc-note", text: `The ${n(meta.tailCount)} most recent entr${meta.tailCount === 1 ? "y travels" : "ies travel"} verbatim (long tool inputs/outputs shortened) — see the exact text below.` }));
  if (meta.job && meta.job.calls) body.append(h("div", { class: "rc-note", text: `Summary prepared with ${meta.job.calls} model call${meta.job.calls === 1 ? "" : "s"}${meta.job.input_tokens || meta.job.output_tokens ? ` (${n(meta.job.input_tokens)} in / ${n(meta.job.output_tokens)} out tokens)` : ""}.` }));
  body.append(h("details", { class: "rc-raw" }, h("summary", { text: `Exact text the model receives (${n(chars)} characters)` }), h("pre", { class: "rc-pre", text: m.text || "" })));
  card.append(body);
  return card;
}
// The condensed record a fresh provider thread received when the exact record could not
// fit the model's context window (history.js budgeted transfer). Shown so what the model
// was told is never hidden; collapsed like the reasoning card, expands on click.
export function summaryCard(m) {
  const meta = m.meta || {};
  const who = meta.provider ? (PROVIDER_NAME[meta.provider] || meta.provider) : "the model";
  const label = meta.selected ? `Working context carried into ${who}'s thread · ${Number(meta.bytes || 0).toLocaleString()} bytes${meta.job && meta.job.cached ? " · memory reused" : ""}`
    : `Context summary carried into ${who}'s new thread` + (meta.entries ? ` — ${Number(meta.entries).toLocaleString()} earlier entries condensed` : "");
  return h("div", { class: "thinking-card summary-card" },
    h("div", { class: "thinking-head" }, h("span", { html: icon("history", 15) }), h("span", { text: label }), h("span", { class: "chev", html: icon("chevron", 13) })),
    h("div", { class: "thinking-body", html: renderMarkdown(m.text || "") }));
}
export function wrapFlow(node, mid, parentToolUseId) {
  const el = h("div", { class: "msg flow" + (parentToolUseId ? " subagent" : ""), dataset: { mid } }, node);
  if (parentToolUseId) labelSubagentNode(el, parentToolUseId);
  return el;
}
// A card produced INSIDE a sub-agent carries that agent's number + type in its left gutter (and its
// colour); the registry record may land after the card — relabelSubagentNodes fixes it up then.
export function labelSubagentNode(el, parentToolUseId) {
  el.dataset.ptu = parentToolUseId;
  const a = agentByToolUse(activeTS(), parentToolUseId);
  if (a) { el.dataset.agent = `#${a.n}`; el.title = `Sub-agent #${a.n}${a.type ? " · " + a.type : ""}${a.description ? " — " + a.description : ""}`; el.style.setProperty("--ag-h", String(agentHue(a.n))); }
  else el.dataset.agent = "agent";
}
export function relabelSubagentNodes(ts, agent) {
  if (!agent || !agent.toolUseId) return;
  for (const el of document.querySelectorAll(`#chatMessages .msg.subagent[data-ptu="${CSS.escape(agent.toolUseId)}"]`)) labelSubagentNode(el, agent.toolUseId);
}
// The Planner's plan — its own card (distinct from the Coder's answer), tagged
// with the model that produced it and a note that the Coder implements it.
export function plannerCard(m) {
  const modelLbl = (m.meta && (m.meta.model || PROVIDER_NAME[m.meta.provider])) || "";
  const effortLbl = (m.meta && m.meta.thinking && m.meta.thinking !== "off") ? m.meta.thinking : "";
  const body = h("div", { class: "msg-body" },
    roleLine("Planner", m.ts, msgTopActions(m)),
    h("div", { class: "planner-card" },
      h("div", { class: "planner-head" },
        h("span", { class: "planner-badge" }, h("span", { html: icon("sparkle", 11) }), h("span", { text: "Plan" })),
        modelLbl ? h("span", { class: "planner-model", text: modelLbl + (effortLbl ? " · " + effortLbl : "") }) : null,
        h("span", { class: "planner-note", text: "→ Coder implements this" })),
      h("div", { class: "bubble planner-body", html: renderMarkdown(m.text) })));
  body.append(msgBottomActions(m));
  return h("div", { class: "msg planner", dataset: { mid: m.id } },
    h("div", { class: "msg-avatar planner", html: icon("sparkle", 16) }), body);
}
/* ---- Workflow job cards (docs/WORKFLOW_CONTRACT.md §7) ----
 * Main adds a `role: "job"` message to the ORCHESTRATOR's session when it delegates work to a role
 * (Planner / Coder / Reviewer / Tester): `{ id, role:"job", jobId, jobRole, text: task, ts, meta:{ provider,
 * model, effort, access, agents, sessionId, status, startedTs?, endedTs?, durationMs?, result?,
 * editedFiles?, error?, agentsLive?, kind? } }`, then patches meta.status / result / durationMs /
 * editedFiles through session:message-update; workflow:job events patch the same card in place
 * (chat/events.js → patchJobCard), so the node, its expanded state and a selection survive. */
export const ACCESS_LABEL = { bypassPermissions: "Full access", acceptEdits: "Accept edits", default: "Ask", plan: "Read-only", read: "Read-only" };
export const JOB_TERMINAL = new Set(["done", "error", "stopped"]);
export const JOB_PREVIEW_CHARS = 600;
export function jobStatusOf(m) { return String((m.meta && m.meta.status) || "running").toLowerCase(); }
export function jobRoleOf(m) { return String(m.jobRole || (m.meta && m.meta.role) || "coder").toLowerCase(); }
// When the job started, in ms: meta.startedTs (ISO or ms) else the card's own timestamp.
export function jobStartMs(m) { const meta = m.meta || {}; const v = meta.startedTs || m.ts; const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : Date.now(); }
// Elapsed: the recorded duration once terminal (else started → ended), else the time since it started.
export function jobElapsedMs(m) {
  const meta = m.meta || {};
  if (JOB_TERMINAL.has(jobStatusOf(m))) {
    if (meta.durationMs) return Math.max(0, +meta.durationMs || 0);
    if (meta.endedTs) return Math.max(0, new Date(meta.endedTs).getTime() - jobStartMs(m));
    return 0;
  }
  return Math.max(0, Date.now() - jobStartMs(m));
}
// The status glyph carries data-state so patchJobCard leaves it alone while the status is unchanged
// (rebuilding it on every update would restart the ring's animation).
export function jobStatusHtml(st) {
  const wrap = (inner, title) => `<span class="job-status ${st}" data-state="${st}" title="${title}">${inner}</span>`;
  return st === "done" ? wrap(icon("check", 13), "Finished")
    : st === "error" ? wrap(icon("x", 13), "Failed")
      : st === "stopped" ? wrap(icon("stop", 11), "Stopped")
        : st === "queued" ? wrap('<span class="job-dot"></span>', "Waiting to start")
          : wrap('<span class="job-ring"></span>', "Working");
}
// The descriptor line: provider · model · effort · access · agents (the live count while it runs) · files.
export function jobMetaEl(m) {
  const meta = m.meta || {};
  const parts = [];
  if (meta.provider) parts.push(h("span", { class: "jm-prov", text: PROVIDER_NAME[meta.provider] || meta.provider }));
  if (meta.model) parts.push(h("span", { class: "jm-model", text: modelName(meta.provider, meta.model) || meta.model }));
  if (meta.effort) parts.push(h("span", { class: "jm-effort", text: `${meta.effort} effort` }));
  if (meta.access) parts.push(h("span", { class: "jm-access", text: ACCESS_LABEL[meta.access] || meta.access }));
  const n = +meta.agents || 0, live = meta.agentsLive ? +meta.agentsLive.running || 0 : 0;
  if (live && !JOB_TERMINAL.has(jobStatusOf(m))) parts.push(h("span", { class: "jm-agents live", text: `${live} of ${Math.max(n, live)} agent${Math.max(n, live) === 1 ? "" : "s"} running` }));
  else if (meta.agents != null) parts.push(h("span", { class: "jm-agents", text: n ? `${n} agent${n === 1 ? "" : "s"}` : "solo" }));
  const ns = Array.isArray(meta.skills) ? meta.skills.length : 0;
  if (ns) parts.push(h("span", { class: "jm-skills", title: "Skills attached to this role — their procedures travelled with the task", text: `${ns} skill${ns === 1 ? "" : "s"}` }));
  const nf = Array.isArray(meta.editedFiles) ? meta.editedFiles.length : 0;
  if (nf) parts.push(h("span", { class: "jm-files", text: `${nf} file${nf === 1 ? "" : "s"} edited` }));
  if (meta.kind === "command" && meta.exitCode != null) parts.push(h("span", { class: "jm-exit", text: `exit ${meta.exitCode}` }));
  const row = h("div", { class: "job-meta" });
  parts.forEach((p, i) => { if (i) row.append(h("span", { class: "jm-sep", text: "·" })); row.append(p); });
  return row;
}
// The job's report once it is terminal: the first ~600 chars rendered (expand for all), the error line.
// data-key lets patchJobCard keep the node (and a "Show all" the user opened) while the text is unchanged.
export function jobResultEl(m) {
  const meta = m.meta || {};
  const st = jobStatusOf(m);
  if (!JOB_TERMINAL.has(st)) return null;
  const text = String(meta.result || "").trim(), err = String(meta.error || "").trim();
  if (!text && !err && st !== "stopped") return null;
  const wrap = h("div", { class: "job-result", dataset: { key: `${st}|${text.length}|${err.length}` } });
  if (err) wrap.append(h("div", { class: "job-error" }, h("span", { html: icon("alert", 13) }), h("span", { text: err })));
  if (!text) { if (st === "stopped" && !err) wrap.append(h("div", { class: "job-note", text: "Stopped before it reported back." })); return wrap; }
  const long = text.length > JOB_PREVIEW_CHARS;
  // the preview ends on a word boundary when one is near; a single long token is cut as is
  const cut = text.slice(0, JOB_PREVIEW_CHARS), trimmed = cut.replace(/\s+\S*$/, "");
  const prev = long ? (trimmed.length >= JOB_PREVIEW_CHARS * 0.8 ? trimmed : cut) + "…" : text;
  const body = h("div", { class: "bubble job-result-body", html: renderMarkdown(prev) });
  wrap.append(h("div", { class: "job-result-label", text: st === "error" ? "Reported" : "Result" }), body);
  if (long) {
    const all = `Show all · ${fmtCompactTok(text.length)} chars`;
    const more = h("button", { class: "job-result-more", text: all, onclick: (e) => { e.stopPropagation(); const open = wrap.classList.toggle("open"); body.innerHTML = renderMarkdown(open ? text : prev); more.textContent = open ? "Show less" : all; } });
    wrap.append(more);
  }
  return wrap;
}
// Files the job edited — chips that open the file (paths relative to the orchestrator's project).
export function jobFilesEl(m, ts) {
  const files = (m.meta && Array.isArray(m.meta.editedFiles)) ? m.meta.editedFiles.filter((f) => f && f.path) : [];
  if (!files.length) return null;
  const cwd = ts && ts.meta ? ts.meta.cwd : "";
  const wrap = h("div", { class: "job-files", dataset: { key: files.map((f) => `${f.path}:${f.added || 0}:${f.removed || 0}`).join("|") } });
  for (const f of files.slice(0, 12)) wrap.append(h("button", { class: "job-file", title: f.path + "  (click → open)", onclick: (e) => { e.stopPropagation(); openInEditor(f.path); } },
    h("span", { class: "jf-name", text: relPath(f.path, cwd) || baseName(f.path) }),
    (f.added || f.removed) ? h("span", { class: "jf-stat", text: `+${f.added || 0} −${f.removed || 0}` }) : null));
  if (files.length > 12) wrap.append(h("span", { class: "job-file more", text: `+${files.length - 12} more` }));
  return wrap;
}
// "Open tab" (the job's own session) and "Stop" (CSS-hidden once the job is terminal).
export function jobActsEl(m) {
  const meta = m.meta || {};
  const acts = h("div", { class: "job-acts" });
  if (meta.sessionId) acts.append(h("button", { class: "btn btn-ghost btn-sm job-open", title: "Open this job's own session tab", onclick: (e) => { e.stopPropagation(); openSessionTab(meta.sessionId); } }, h("span", { html: icon("external", 12) }), h("span", { text: "Open tab" })));
  if (m.jobId) acts.append(h("button", { class: "btn btn-ghost btn-sm job-stop", title: "Stop this job", onclick: async (e) => {
    e.stopPropagation(); const b = e.currentTarget; b.disabled = true;
    try {
      const r = atom.workflow && atom.workflow.stop ? await atom.workflow.stop(m.jobId) : { ok: false, detail: "Workflow control is not available in this build" };
      if (r && r.ok !== false) toast("Stopping the job…", "stop"); else { toast((r && r.detail) || "Could not stop the job", "alert"); b.disabled = false; }
    } catch (err) { toast("Could not stop the job: " + ((err && err.message) || err), "alert"); b.disabled = false; }
  } }, h("span", { html: icon("stop", 11) }), h("span", { text: "Stop" })));
  return acts;
}
// One delegated job = ONE card: role badge · elapsed · status ring, the task (two lines, click to expand),
// the descriptor line, then — once it is terminal — the result preview and the edited files, and the actions.
export function jobCard(m, ts) {
  const meta = m.meta || {};
  const st = jobStatusOf(m), role = jobRoleOf(m), rm = roleMeta(role);
  const task = String(m.text || meta.task || meta.command || "").trim();
  const card = h("div", { class: `job-card st-${st} role-${role}`, dataset: { job: m.jobId || "", started: String(jobStartMs(m)) } });
  card.append(h("div", { class: "job-head", onclick: (e) => { if (e.target.closest("button, a")) return; card.classList.toggle("open"); } },
    h("span", { class: "job-role", title: `${rm.name} job${meta.kind === "command" ? " — a command run" : ""}` }, h("span", { html: icon(meta.kind === "command" ? "terminal" : rm.icon, 12) }), h("span", { text: rm.name })),
    h("span", { class: "job-elapsed", text: fmtSpan(jobElapsedMs(m)) }),
    h("span", { class: "job-state-wrap", html: jobStatusHtml(st) }),
    h("span", { class: "job-chev", html: icon("chevron", 13) })));
  card.append(h("div", { class: "job-task" + (meta.kind === "command" ? " cmd" : ""), text: task || "(no task text)", onclick: () => card.classList.add("open") }));
  card.append(jobMetaEl(m));
  const res = jobResultEl(m); if (res) card.append(res);
  const files = jobFilesEl(m, ts); if (files) card.append(files);
  card.append(jobActsEl(m));
  if (!JOB_TERMINAL.has(st)) startJobTicker();
  return card;
}
// Patch a job card in place (node = the .msg wrapper or the card). Status class, glyph (only when the
// status changed), elapsed, task, descriptor line; the result and files are rebuilt only when their
// content changed. Returns false when the node holds no job card (the caller rebuilds).
export function patchJobCard(node, m, ts) {
  const card = node && node.classList && node.classList.contains("job-card") ? node : (node && node.querySelector ? node.querySelector(".job-card") : null);
  if (!card) return false;
  const st = jobStatusOf(m), role = jobRoleOf(m);
  card.className = `job-card st-${st} role-${role}` + (card.classList.contains("open") ? " open" : "");
  card.dataset.started = String(jobStartMs(m));
  const stEl = card.querySelector(".job-status");
  if (stEl && stEl.dataset.state !== st && stEl.parentElement) stEl.parentElement.innerHTML = jobStatusHtml(st);
  const el = card.querySelector(".job-elapsed"); if (el) el.textContent = fmtSpan(jobElapsedMs(m));
  const task = String(m.text || (m.meta && (m.meta.task || m.meta.command)) || "").trim();
  const taskEl = card.querySelector(".job-task"); if (taskEl && task && taskEl.textContent !== task) taskEl.textContent = task;
  const metaEl = card.querySelector(".job-meta"); const freshMeta = jobMetaEl(m);
  if (metaEl && metaEl.textContent !== freshMeta.textContent) metaEl.replaceWith(freshMeta);
  const swap = (sel, fresh, beforeSel) => {
    const cur = card.querySelector(sel);
    if (cur && !fresh) cur.remove();
    else if (fresh && (!cur || cur.dataset.key !== fresh.dataset.key)) { if (cur) cur.replaceWith(fresh); else card.querySelector(beforeSel).before(fresh); }
  };
  swap(".job-result", jobResultEl(m), ".job-files, .job-acts");
  swap(".job-files", jobFilesEl(m, ts), ".job-acts");
  // the child session id can land a moment after the card: add "Open tab" then
  if (m.meta && m.meta.sessionId && !card.querySelector(".job-open")) { const acts = card.querySelector(".job-acts"); if (acts) acts.replaceWith(jobActsEl(m)); }
  if (!JOB_TERMINAL.has(st)) startJobTicker();
  return true;
}
// Live elapsed on running job cards (main patches on state changes, not per second): one interval
// while any running / queued card is in the transcript, reading the start time each card carries.
export let _jobTicker = null;
export function startJobTicker() {
  if (_jobTicker) return;
  _jobTicker = setInterval(() => {
    const live = document.querySelectorAll("#chatMessages .job-card.st-running, #chatMessages .job-card.st-queued");
    if (!live.length) { stopJobTicker(); return; }
    const now = Date.now();
    for (const c of live) { const el = c.querySelector(".job-elapsed"); const from = +c.dataset.started || 0; if (el && from) el.textContent = fmtSpan(now - from); }
  }, 1000);
}
export function stopJobTicker() { if (_jobTicker) { clearInterval(_jobTicker); _jobTicker = null; } }
/* ---- Task board cards (docs/WORKFLOW_CONTRACT.md §8.4) ----
 * Main adds ONE `role: "tasks"` message per SET to the orchestrator's session — `{ id, role:"tasks", setId,
 * text: set.title, ts, meta:{ setN, title, status: "active"|"done"|"closed", items:[{ n, title, status, role }] } }` —
 * and patches the FULL meta on every change (session:message-update); tasks:update events rebuild the same meta
 * from the board (chat/events.js applyTasksUpdate). Both paths patch the card IN PLACE (patchTasksCard), so the
 * node and its collapsed state survive. A row click opens the Board dock on that task (panels/board.js). */
export function tasksCardItems(m) { const items = m && m.meta && Array.isArray(m.meta.items) ? m.meta.items : []; return items.filter((it) => it && it.n != null); }
export function tasksProgress(items) {
  let done = 0, dropped = 0;
  for (const it of items) { const s = taskStatusOf(it); if (s === "done") done++; else if (s === "dropped") dropped++; }
  return { total: items.length, done, dropped, open: items.length - done - dropped };
}
export function tasksCountText(p) { return `${p.done} of ${p.total} done` + (p.dropped ? ` · ${p.dropped} dropped` : ""); }
export function tasksSetStatus(m) { const s = String((m.meta && m.meta.status) || "active").toLowerCase(); return s === "done" || s === "closed" ? s : "active"; }
// The set's title for the header — "" when it is the default "Set <n>" (the "SET n" tag already says so).
export function tasksTitleOf(m) { const meta = m.meta || {}; const t = String(meta.title || m.text || "").trim(); return meta.setN != null && t === `Set ${meta.setN}` ? "" : t; }
export function tasksRowKey(it) { return `${taskStatusOf(it)}|${it.role || ""}|${it.title || ""}`; }
// The glyph per status: ☐ todo · pulsing dot doing · eye review · check-circle test · ✓ done · ⚠ blocked · × dropped.
// data-state lets the patcher leave it alone while the status is unchanged (rebuilding restarts the dot's pulse).
export function taskGlyphHtml(st) {
  const wrap = (inner) => `<span class="tk-glyph ${st}" data-state="${st}" title="${TASK_STATUS_TITLE[st] || st}">${inner}</span>`;
  return st === "done" ? wrap(icon("check", 12))
    : st === "doing" ? wrap('<i class="tk-dot"></i>')
      : st === "review" ? wrap(icon("eye", 12))
        : st === "test" ? wrap(icon("checkCircle", 12))
          : st === "blocked" ? wrap(icon("alert", 12))
            : st === "dropped" ? wrap(icon("x", 12))
              : wrap('<i class="tk-box"></i>');
}
export function tasksBarEl(p) {
  const pct = (n) => (p.total ? ((n / p.total) * 100).toFixed(1) : "0") + "%";
  return h("div", { class: "tk-bar", title: tasksCountText(p) }, h("i", { class: "tk-bar-done", style: `width:${pct(p.done)}` }), h("i", { class: "tk-bar-drop", style: `width:${pct(p.dropped)}` }));
}
export function tasksRowEl(it) {
  const st = taskStatusOf(it), ref = "T" + it.n, role = it.role ? String(it.role).toLowerCase() : "";
  return h("div", { class: `tk-row st-${st}`, dataset: { ref, key: tasksRowKey(it) }, title: "Open on the task board", onclick: () => openBoard({ ref }) },
    h("span", { class: "tk-badge", text: ref }),
    h("span", { class: "tk-glyph-wrap", html: taskGlyphHtml(st) }),
    h("span", { class: "tk-name", text: it.title || "(untitled)" }),
    role ? h("span", { class: `tk-role role-${role}`, text: roleMeta(role).name.toLowerCase() }) : null);
}
// Update a row in place: classes, the glyph only when the status changed, the title, the role chip.
export function patchTasksRow(row, it) {
  const st = taskStatusOf(it), role = it.role ? String(it.role).toLowerCase() : "";
  row.className = `tk-row st-${st}`;
  row.dataset.key = tasksRowKey(it);
  const g = row.querySelector(".tk-glyph"); if (g && g.dataset.state !== st && g.parentElement) g.parentElement.innerHTML = taskGlyphHtml(st);
  const nm = row.querySelector(".tk-name"); const title = it.title || "(untitled)"; if (nm && nm.textContent !== title) nm.textContent = title;
  const rc = row.querySelector(".tk-role");
  if (role && !rc) row.append(h("span", { class: `tk-role role-${role}`, text: roleMeta(role).name.toLowerCase() }));
  else if (!role && rc) rc.remove();
  else if (rc && !rc.classList.contains("role-" + role)) { rc.className = `tk-role role-${role}`; rc.textContent = roleMeta(role).name.toLowerCase(); }
}
// One set = ONE card: list icon · "Set 2" · title · "3 of 8 done" · chevron (collapses the checklist), a thin bar, the rows.
export function tasksCard(m, ts) {   // ts: the card builders share one signature (renderMessage); the set card needs nothing from the tab
  const meta = m.meta || {};
  const items = tasksCardItems(m), p = tasksProgress(items), st = tasksSetStatus(m);
  const card = h("div", { class: `tasks-card st-${st}`, dataset: { set: String(m.setId || meta.setId || "") } });
  card.append(h("div", { class: "tk-head", title: "Collapse / expand the checklist", onclick: (e) => { if (e.target.closest("button, a")) return; card.classList.toggle("collapsed"); } },
    h("span", { class: "tk-ico", html: icon("list", 14) }),
    h("span", { class: "tk-set", text: meta.setN != null ? `Set ${meta.setN}` : "Tasks" }),
    h("span", { class: "tk-title", text: tasksTitleOf(m) }),
    h("span", { class: "tk-count", text: tasksCountText(p) }),
    h("span", { class: "tk-chev", html: icon("chevron", 13) })));
  card.append(tasksBarEl(p));
  const body = h("div", { class: "tk-body" });
  for (const it of items) body.append(tasksRowEl(it));
  if (!items.length) body.append(h("div", { class: "tk-empty", text: "No tasks in this set yet." }));
  card.append(body);
  return card;
}
// Patch a tasks card in place (node = the .msg wrapper or the card) from m.meta: status class (the collapsed state is
// kept), header texts, the bar, and the rows — updated, reordered, added or removed by their T-number. Returns false
// when the node holds no tasks card (the caller rebuilds).
export function patchTasksCard(node, m) {
  const card = node && node.classList && node.classList.contains("tasks-card") ? node : (node && node.querySelector ? node.querySelector(".tasks-card") : null);
  if (!card) return false;
  const meta = m.meta || {};
  const items = tasksCardItems(m), p = tasksProgress(items), st = tasksSetStatus(m);
  card.className = `tasks-card st-${st}` + (card.classList.contains("collapsed") ? " collapsed" : "");
  if (m.setId || meta.setId) card.dataset.set = String(m.setId || meta.setId);
  const setText = (sel, text) => { const el = card.querySelector(sel); if (el && el.textContent !== text) el.textContent = text; };
  setText(".tk-set", meta.setN != null ? `Set ${meta.setN}` : "Tasks");
  setText(".tk-title", tasksTitleOf(m));
  setText(".tk-count", tasksCountText(p));
  const bar = card.querySelector(".tk-bar"); if (bar) bar.replaceWith(tasksBarEl(p));
  const body = card.querySelector(".tk-body"); if (!body) return true;
  const existing = new Map([...body.querySelectorAll(".tk-row")].map((r) => [r.dataset.ref, r]));
  let prev = null;
  for (const it of items) {
    const ref = "T" + it.n;
    let row = existing.get(ref);
    if (row) { existing.delete(ref); if (row.dataset.key !== tasksRowKey(it)) patchTasksRow(row, it); }
    else row = tasksRowEl(it);
    const anchor = prev ? prev.nextSibling : body.firstChild;
    if (anchor !== row) body.insertBefore(row, anchor);
    prev = row;
  }
  for (const r of existing.values()) r.remove();
  const emptyEl = body.querySelector(".tk-empty");
  if (items.length && emptyEl) emptyEl.remove();
  else if (!items.length && !emptyEl) body.append(h("div", { class: "tk-empty", text: "No tasks in this set yet." }));
  return true;
}
// The card's meta rebuilt from the board a tasks:update carried (chat/events.js) — the same shape main persists.
export function tasksCardMetaFor(board, set) {
  const items = (board && Array.isArray(board.items) ? board.items : []).filter((i) => i && i.setId === set.id && i.n != null);
  return { setId: set.id, setN: set.n, title: set.title, status: set.status, items: items.map((i) => ({ n: i.n, title: i.title, status: i.status, role: i.role || null })) };
}
export function thinkingCard(text) {
  const card = h("div", { class: "thinking-card" },
    h("div", { class: "thinking-head" }, h("span", { html: icon("brain", 15) }), h("span", { text: "Reasoning" }), h("span", { class: "chev", html: icon("chevron", 13) })),
    h("div", { class: "thinking-body", text: text }));
  return card;
}
// One tool call = ONE card that advances through preparing (arguments still
// streaming) → running (→ awaiting approval) → done | error | interrupted, and is
// patched in place on every update (see patchToolCard) so its DOM node, expansion
// and selection survive.
// The state icon carries data-state so patchToolCard can leave it untouched while the status is
// unchanged — rebuilding it on every heartbeat restarted the spinner's animation mid-turn.
export function toolStateHtml(m) {
  const st = m.status || "running";
  const wrap = (inner, title) => `<span class="tool-state ${st}" data-state="${st}"${title ? ` title="${title}"` : ""}>${inner}</span>`;
  const agentic = isAgentTool(m.toolName);
  return st === "done" ? wrap(icon("check", 14))
    : st === "error" ? wrap(icon("x", 14))
      : st === "interrupted" ? wrap(icon("stop", 12), "Stopped before this finished")
        : st === "preparing" ? wrap('<span class="spinner"></span>', "Preparing the call…")
          : st === "queued" ? wrap('<span class="queued-dot"></span>', agentic ? "Waiting for a CPU slot / for the agent to start" : "Waiting — starts when the command before it has finished")
            : agentic ? `<span class="tool-state running agent-run" data-state="running" title="Agent working"><span class="ag-orbit"><i></i><i></i><i></i></span></span>`
              : wrap('<span class="spinner"></span>');
}
export function fmtElapsed(s) { s = Math.max(0, Math.round(+s || 0)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; }
// Patch an existing tool card's status, summary, elapsed/progress and result in
// place. Returns false when the card's shape changed (renamed tool) so the caller
// rebuilds it instead.
export function patchToolCard(node, m, ts) {
  const card = node.querySelector(".tool-card");
  if (!card) return false;
  const nameEl = card.querySelector(".tool-name");
  const shownName = nameEl ? nameEl.textContent : "";
  const displayName = splitToolName(m.toolName).name;
  if (shownName && displayName && shownName !== displayName) return false;
  const agentic = isAgentTool(m.toolName);
  card.className = "tool-card " + (m.status || "running") + (card.classList.contains("open") ? " open" : "") + (agentic ? " agent" : "");
  if (agentic) {
    // the agent number can arrive a moment after the card (registry announce); the live progress line follows the record
    if (m.agentN) { card.style.setProperty("--ag-h", String(agentHue(m.agentN))); if (!card.querySelector(".agent-num")) { const ico = card.querySelector(".tool-ico"); if (ico) ico.after(agentBadge(m)); } }
    const cur = card.querySelector(".agent-progress"), fresh = agentProgressEl(m);
    if (cur && fresh) { if (cur.textContent !== fresh.textContent) cur.replaceWith(fresh); } else if (cur && !fresh) cur.remove(); else if (!cur && fresh) { const head = card.querySelector(".tool-head"); if (head) head.after(fresh); }
  }
  // Swap the state icon ONLY when the status changed: a spinner that survives the per-second
  // heartbeats and streaming updates keeps turning smoothly instead of restarting each time.
  const stateEl = card.querySelector(".tool-state");
  if (stateEl && stateEl.parentElement && stateEl.dataset.state !== (m.status || "running")) stateEl.parentElement.innerHTML = toolStateHtml(m);
  // The summary's SHAPE changes while a call streams in: the "preparing…" span becomes a
  // clickable file link the moment the path has arrived. Swap the element then; otherwise
  // only its text is touched, so the user's selection and scroll position survive.
  const sum = card.querySelector(".tool-summary");
  if (sum) {
    const fresh = toolSummaryEl(m, ts);
    const linky = (el) => el.classList.contains("file-link") || !!el.querySelector(".file-link");
    if (linky(sum) !== linky(fresh) || (linky(fresh) && sum.textContent !== fresh.textContent)) sum.replaceWith(fresh);
    else if (!linky(sum) && sum.textContent !== fresh.textContent) sum.textContent = fresh.textContent;
  }
  let el = card.querySelector(".tool-elapsed");
  if (m.status === "running" && m.elapsedSeconds != null) { if (!el) { el = h("span", { class: "tool-elapsed" }); const st = card.querySelector(".tool-state"); if (st && st.parentElement) st.parentElement.before(el); } el.textContent = fmtElapsed(m.elapsedSeconds); }
  else if (el) el.remove();
  let bg = card.querySelector(".tool-bg");
  if (m.background && !bg) { bg = h("span", { class: "tool-bg", text: "background" }); const tn = card.querySelector(".tool-name"); if (tn) tn.after(bg); }
  // The expanded detail (arguments, streaming body, result) is rebuilt only while it is VISIBLE or
  // when the call reaches its final state — a collapsed card streaming a large Write would otherwise
  // re-layout its whole body on every update. A collapsed detail left stale is rebuilt on expand.
  const det = card.querySelector(".tool-detail");
  if (det) {
    const terminal = m.status === "done" || m.status === "error" || m.status === "interrupted";
    if (card.classList.contains("open") || terminal) { det.replaceWith(toolDetail(m)); delete card.dataset.detailStale; }
    else card.dataset.detailStale = "1";
  }
  return true;
}
// Rebuild a tool card's detail that was left stale while collapsed (called when it is expanded).
export function revealToolDetail(card, m) {
  if (!card || !card.dataset.detailStale) return false;
  delete card.dataset.detailStale;
  const det = card.querySelector(".tool-detail");
  if (det && m) det.replaceWith(toolDetail(m));
  return true;
}
// Tool names from both harnesses. Claude's MCP tools are "mcp__<server>__<tool>" (the
// Agent SDK's naming convention); Codex MCP calls are mapped by claude.js to
// "mcp:<server>/<tool>". Either way the card shows a compact server tag + the tool's
// own name — and patchToolCard must use the SAME split, or a card would be rebuilt
// (losing its expanded state) on every update.
export function splitToolName(tn) {
  tn = String(tn || "");
  let m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tn) || (tn.startsWith("mcp__") ? /^mcp__(.+?)__(.+)$/.exec(tn) : null);
  if (m) return { server: m[1], name: m[2] };
  m = /^mcp:([^/]+)\/(.+)$/.exec(tn);
  if (m) return { server: m[1], name: m[2] };
  return { server: "", name: tn };
}
/* ---- sub-agent cards: number badge, type, live progress line, info popover ---- */
export function isAgentTool(name) { return /^(Task|Agent)$/i.test(String(name || "")); }
// A stable, well-separated hue per agent number (golden-angle spacing) — shared by the card, the
// nested output rail, the strip chip and the Agents panel row.
export function agentHue(n) { return Math.round(((+n || 0) * 137.508) % 360); }
export function agentBadge(m) {
  if (!m || !m.agentN) return null;
  return h("span", { class: "agent-num", style: `--ag-h:${agentHue(m.agentN)}`, title: `Sub-agent #${m.agentN}`, text: `#${m.agentN}` });
}
export function agentInfoBtn(m, ts) {
  return h("button", { class: "agent-info", title: "What this agent is for — purpose, brief, status", html: icon("info", 13), onclick: (e) => { e.stopPropagation(); showAgentInfo(m, ts, e.currentTarget); } });
}
// The line under an agent card's head while it works: the model's progress blurb (or the gate state).
export function agentProgressEl(m) {
  if (!m) return null;
  const live = m.status === "running" || m.status === "queued" || m.status === "preparing";
  if (!live) return null;
  const waiting = m.agentStatus === "waiting" || m.agentGate === "waiting";
  const txt = waiting ? "Waiting for a free CPU slot — the machine is busy" : (m.agentProgress || m.progress || "");
  if (!txt) return null;
  return h("div", { class: "agent-progress" + (waiting ? " waiting" : "") },
    h("span", { class: "ag-orbit sm" }, h("i"), h("i"), h("i")),
    h("span", { class: "agent-progress-text", text: txt }),
    m.agentLastTool && !waiting ? h("span", { class: "agent-progress-tool", text: m.agentLastTool }) : null);
}
export function toolCard(m, ts) {
  const tn = m.toolName || "";
  const agentic = isAgentTool(tn);
  const i = (m.toolInput && typeof m.toolInput === "object") ? m.toolInput : {};
  const card = h("div", { class: "tool-card " + (m.status || "running") + (agentic ? " agent" : ""), dataset: { mid: m.id }, style: agentic && m.agentN ? `--ag-h:${agentHue(m.agentN)}` : undefined });
  const stateIco = toolStateHtml(m);
  // Also compute the result size — MCP calls often return large blobs (search hits,
  // file contents, memory retrievals), and the char/token count is the closest thing
  // to "cost" we can attribute.
  const { server: serverTag, name: displayName } = splitToolName(tn);
  const resSize = mcpResultSize(m);
  card.append(
    h("div", { class: "tool-head" },
      h("span", { class: "tool-ico", html: icon(agentic ? "agents" : toolIcon(tn), 15) }),
      agentic ? agentBadge(m) : null,
      serverTag ? h("span", { class: "tool-mcp-tag", title: `MCP server: ${serverTag}`, text: serverTag }) : null,
      h("span", { class: "tool-name", text: displayName }),
      agentic && typeof i.subagent_type === "string" && i.subagent_type ? h("span", { class: "agent-type", text: i.subagent_type }) : null,
      m.background ? h("span", { class: "tool-bg", text: "background" }) : null,
      toolSummaryEl(m, ts),
      resSize ? h("span", { class: "tool-size", title: `${resSize.chars} chars returned  (~${resSize.tokens} tokens the model reads back — the FULL result, not a truncated copy)`, text: `${fmtCompactTok(resSize.chars)}c · ~${fmtCompactTok(resSize.tokens)}t` }) : null,
      (m.status === "running" && m.elapsedSeconds != null) ? h("span", { class: "tool-elapsed", text: fmtElapsed(m.elapsedSeconds) }) : null,
      agentic ? agentInfoBtn(m, ts) : null,
      h("span", { html: stateIco }),
      h("span", { class: "tool-chev", html: icon("chevron", 14) })));
  // native append() would stringify a null child — only add the progress line when there is one
  const prog = agentic ? agentProgressEl(m) : null;
  if (prog) card.append(prog);
  card.append(toolDetail(m));
  return card;
}
// The agent's purpose at a click: description, brief, type / model / background, timings, usage,
// gate outcome, result — from the registry record when the tab has it, else from the tool input.
let _agInfoPop = null;
export function closeAgentInfo() { if (_agInfoPop) { _agInfoPop.remove(); _agInfoPop = null; document.removeEventListener("mousedown", _agInfoOutside, true); document.removeEventListener("keydown", _agInfoKey, true); } }
function _agInfoOutside(e) { if (_agInfoPop && !_agInfoPop.contains(e.target)) closeAgentInfo(); }
function _agInfoKey(e) { if (e.key === "Escape") closeAgentInfo(); }
export function showAgentInfo(m, ts, anchor) {
  closeAgentInfo();
  const i = (m.toolInput && typeof m.toolInput === "object") ? m.toolInput : {};
  const a = agentByToolUse(ts || activeTS(), m.toolUseId) || { n: m.agentN, description: i.description, prompt: i.prompt, type: i.subagent_type, model: i.model, background: !!i.run_in_background || !!m.background, status: m.status, result: m.result, ts: m.ts, startedTs: m.startedTs, endedTs: m.endedTs, toolUses: m.agentToolUses, taskId: m.taskId };
  const pop = h("div", { class: "ag-info-pop", style: `--ag-h:${agentHue(a.n || 0)}` });
  const live = !AG_TERMINAL.has(a.status);
  pop.append(h("div", { class: "ag-info-head" },
    a.n ? h("span", { class: "agent-num", text: `#${a.n}` }) : null,
    h("span", { text: a.n ? `Sub-agent #${a.n}` : "Sub-agent" }),
    a.type ? h("span", { class: "agent-type", text: a.type }) : null,
    h("span", { class: "spacer" }),
    h("span", { class: "ag-status st-" + (a.status || "running"), text: (a.status === "waiting" ? "Waiting for CPU" : a.status === "error" ? "Failed" : a.status || "running") }),
    h("button", { class: "agent-info", title: "Close", html: icon("close", 13), onclick: () => closeAgentInfo() })));
  pop.append(h("div", { class: "ag-info-desc", text: a.description || i.description || "(no description given)" }));
  if (a.prompt || i.prompt) pop.append(h("div", { class: "ag-det-label", text: "Brief handed to the agent" }), h("pre", { class: "ag-pre", text: a.prompt || i.prompt }));
  const meta = [];
  if (a.model || i.model) meta.push(["Model", a.model || i.model]);
  meta.push(["Runs", a.background ? "in the background" : "in the foreground"]);
  if (a.depth > 1) meta.push(["Nesting depth", String(a.depth)]);
  if (a.startedTs || a.ts) meta.push([live ? "Running for" : "Took", fmtSpan(agentElapsedMs(a))]);
  if (a.toolUses) meta.push(["Tool calls", String(a.toolUses)]);
  if (a.tokens) meta.push(["Tokens", String(a.tokens)]);
  if (a.lastTool && live) meta.push(["Last tool", a.lastTool]);
  if (a.gate) meta.push(["CPU slot", a.gate === "waited" ? `granted after ${fmtSpan(a.waitMs)}` : a.gate]);
  pop.append(h("div", { class: "ag-meta-grid" }, ...meta.map(([k, v]) => h("div", { class: "ag-meta-cell" }, h("span", { class: "k", text: k }), h("span", { class: "v", text: v })))));
  if (a.progress || m.agentProgress) pop.append(h("div", { class: "ag-det-label", text: live ? "Latest progress" : "Last activity" }), h("div", { class: "ag-info-desc", text: a.progress || m.agentProgress }));
  if (a.result) pop.append(h("div", { class: "ag-det-label", text: live ? "Latest report" : "Result" }), h("pre", { class: "ag-pre", text: a.result }));
  const acts = h("div", { class: "ag-info-acts" });
  acts.append(h("button", { class: "btn btn-ghost btn-sm", text: "Agents panel", onclick: () => { closeAgentInfo(); openAgents(live ? "live" : "history"); } }));
  if (live && a.taskId && ts) acts.append(h("button", { class: "btn btn-ghost btn-sm", text: "Stop this agent", onclick: async () => { const r = await atom.agents.stop(ts.meta.id, a.taskId).catch((e) => ({ ok: false, detail: e.message })); toast(r && r.ok ? `Stopping agent #${a.n}…` : (r && r.detail) || "Could not stop the agent", r && r.ok ? "stop" : "alert"); closeAgentInfo(); } }));
  pop.append(acts);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const below = window.innerHeight - r.bottom > pop.offsetHeight + 16 || r.top < pop.offsetHeight + 16;
  pop.style.left = Math.max(8, Math.min(r.left - 200, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - pop.offsetHeight - 6)) + "px";
  _agInfoPop = pop;
  setTimeout(() => { document.addEventListener("mousedown", _agInfoOutside, true); document.addEventListener("keydown", _agInfoKey, true); }, 0);
}
// Pull the tool-result payload size off a tool message. Anthropic sends the
// result back as `m.result` (string) or content array. We treat char count as
// authoritative and estimate tokens at ~1 per 4 chars (rough English rule).
export function mcpResultSize(m) {
  if (!m || m.status === "running" || m.status === "queued" || m.status === "preparing") return null;
  const raw = m.result;
  let text = "";
  if (typeof raw === "string") text = raw;
  else if (Array.isArray(raw)) text = raw.map((b) => (typeof b === "string" ? b : b && b.text) || "").join("");
  else if (raw && typeof raw === "object" && typeof raw.text === "string") text = raw.text;
  if (!text) return null;
  return { chars: text.length, tokens: Math.max(1, Math.round(text.length / 4)) };
}
export const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const PATH_TOOLS = new Set(["Grep", "Glob"]);
// The card's summary: a clickable file link for file tools, "pattern in <folder>" with a
// clickable folder/file for searches, plain text otherwise. Both harnesses feed the same
// shape — Claude's tool_use input, Codex items mapped by claude.js (cat → Read, rg → Grep …).
export function toolSummaryEl(m, ts) {
  const i = (m.toolInput && typeof m.toolInput === "object") ? m.toolInput : {};
  const str = (v) => (typeof v === "string" && v ? v : "");
  const fp = str(i.file_path) || str(i.notebook_path) || (FILE_TOOLS.has(m.toolName) ? str(i.path) : "");
  if (fp && FILE_TOOLS.has(m.toolName)) {
    const isEdit = m.toolName !== "Read";
    // The action (Write / Edit / Read) is the card's bold tool name on the left — it is not repeated after
    // the path (the " · write" / " · edit" suffix showed the same word twice, user request 2026-09-17).
    const st = isEdit ? editStats(m) : null;   // "+64 −1": lines added (green) / removed (red) by this edit (user request 2026-09-17)
    return h("a", {
      class: "tool-summary file-link", title: isEdit ? fp + "  (click → jump to the change)" : fp,
      onclick: (e) => { e.stopPropagation(); if (isEdit) openEditAtChange(fp, m); else openInEditor(fp); },
      oncontextmenu: (ev) => { ev.preventDefault(); ev.stopPropagation(); fileContextMenu(ev, { path: fp, name: baseName(fp), isDir: false }); },
    }, h("span", { text: relPath(fp, ts.meta.cwd) }),
    st ? h("span", { class: "ts-stat", title: `${st.added} line${st.added === 1 ? "" : "s"} added, ${st.removed} removed` }, h("span", { class: "ts-add", text: `+${st.added}` }), h("span", { class: "ts-del", text: `−${st.removed}` })) : null);
  }
  const sp = str(i.path);
  if (sp && PATH_TOOLS.has(m.toolName)) {
    const looksFile = /\.[A-Za-z0-9]{1,8}$/.test(baseName(sp));
    const link = h("a", {
      class: "file-link path-link", text: relPath(sp, ts.meta.cwd) || baseName(sp), title: sp + (looksFile ? "  (click → open)" : "  (click → search this folder)"),
      onclick: (e) => { e.stopPropagation(); openPathTarget(sp, m.toolName === "Grep" ? str(i.pattern) : ""); },
      oncontextmenu: (ev) => { ev.preventDefault(); ev.stopPropagation(); fileContextMenu(ev, { path: sp, name: baseName(sp), isDir: !looksFile }); },
    });
    return h("span", { class: "tool-summary" }, h("span", { text: (str(i.pattern) || (m.status === "preparing" ? "preparing…" : "")) + " in " }), link);
  }
  return h("span", { class: "tool-summary", text: toolSummary(m, ts) });
}
// A search's path argument may be a file or a folder — ask the file system, then open the
// file in the editor, or the search panel scoped to that folder with the pattern prefilled.
export async function openPathTarget(p, query) {
  let isDir = false;
  try { await atom.files.list(p); isDir = true; } catch { isDir = false; }
  if (isDir) openSearch({ mode: "content", root: p, query: query || "" });
  else openInEditor(p);
}
// Open a file the agent edited and land on the exact changed section: search for
// the edit's inserted text first (exact), then fall back to the first changed
// line vs git HEAD, then plain open.
// The first editor open lazy-loads CodeMirror — wait until the target file is live.
export async function waitForEditor(fp, ms = 2500) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (cm && stateActiveFile() && stateActiveFile().path === fp && cm._loaded === fp) return true;
    if (cm && stateActiveFile() && stateActiveFile().path === fp && cm.docText().length) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !!(cm && stateActiveFile() && stateActiveFile().path === fp);
}
export async function openEditAtChange(fp, m) {
  await openInEditor(fp);
  if (!(await waitForEditor(fp))) return;
  const i = m.toolInput || {};
  let needle = "";
  if (m.toolName === "Edit") needle = i.new_string || i.old_string || "";
  else if (m.toolName === "MultiEdit") needle = (Array.isArray(i.edits) && i.edits[0] && (i.edits[0].new_string || i.edits[0].old_string)) || "";
  else if (m.toolName === "NotebookEdit") needle = i.new_source || "";
  const line1 = (needle || "").split("\n").map((l) => l.trim()).find((l) => l.length >= 4) || "";
  if (line1) {
    const off = cm.docText().indexOf(line1);
    if (off >= 0) { cm.gotoOffset(off, Math.min(line1.length, 200)); return; }
  }
  openFileAtFirstChange(fp, true);   // fallback: first git-changed line (already open)
}
// Open a file and scroll to its first changed line vs HEAD (used by the
// Changed-files panel and as the edit-jump fallback).
export async function openFileAtFirstChange(fp, alreadyOpen) {
  if (!alreadyOpen) { await openInEditor(fp); if (!(await waitForEditor(fp))) return; }
  if (!cm || !stateActiveFile() || stateActiveFile().path !== fp) return;
  try {
    const cwd = await atom.git.repoForFile(fp);
    if (!cwd) return;
    const d = await atom.git.fileDiff(cwd, fp);
    const marks = parseDiffToGutter((d && d.text) || "");
    if (marks.length && cm && stateActiveFile() && stateActiveFile().path === fp) cm.gotoLine(marks[0].line, 1);
  } catch { /* plain open is fine */ }
}
// Expanded tool card. Known tools get readable fields — file contents and edits as
// real text (not JSON-escaped strings), the command verbatim, before/after for an
// edit — instead of a raw JSON dump; anything else falls back to the JSON view.
export function toolDetail(m) {
  const det = h("div", { class: "tool-detail" });
  const i = (m.toolInput && typeof m.toolInput === "object") ? m.toolInput : null;
  const label = (t) => h("div", { class: "det-label", text: t });
  const pre = (t, cls) => h("pre", { class: cls || "", text: t == null || t === "" ? "—" : String(t) });
  const tn = m.toolName || "";
  const isStr = (v) => typeof v === "string";
  if (i && isAgentTool(tn)) {
    // a sub-agent: what it was asked to do, in words — never a JSON dump
    det.append(label("Purpose"), pre(i.description));
    if (isStr(i.prompt) && i.prompt) det.append(label("Brief"), pre(i.prompt));
    if (isStr(i.subagent_type) && i.subagent_type) det.append(label("Agent type"), pre(i.subagent_type + (i.model ? ` · model ${i.model}` : "")));
    if (i.run_in_background) det.append(label("Runs"), pre("in the background — the primary agent continues meanwhile"));
  } else if (i && (tn === "Write" || tn === "NotebookEdit") && isStr(i.content ?? i.new_source)) {
    det.append(label("File"), pre(i.file_path || i.notebook_path), label("Content"), pre(i.content ?? i.new_source, "det-new"));
  } else if (i && tn === "Edit" && (isStr(i.old_string) || isStr(i.new_string))) {
    det.append(label("File"), pre(i.file_path),
      h("div", { class: "det-diff" },
        h("div", { class: "det-diff-col" }, label("Before"), pre(i.old_string, "det-old")),
        h("div", { class: "det-diff-col" }, label("After"), pre(i.new_string, "det-new"))));
    if (i.rename_to) det.append(label("Renamed to"), pre(i.rename_to));
  } else if (i && tn === "MultiEdit" && Array.isArray(i.edits)) {
    det.append(label("File"), pre(i.file_path));
    i.edits.forEach((e, k) => det.append(h("div", { class: "det-diff" },
      h("div", { class: "det-diff-col" }, label(`Edit ${k + 1} · before`), pre(e && e.old_string, "det-old")),
      h("div", { class: "det-diff-col" }, label("after"), pre(e && e.new_string, "det-new")))));
  } else if (i && tn === "Bash" && isStr(i.command)) {
    det.append(label("Command"), pre(i.command));
    if (i.description) det.append(label("Purpose"), pre(i.description));
    if (i.cwd) det.append(label("Directory"), pre(i.cwd));
  } else if (i && tn === "Delete" && i.file_path) {
    det.append(label("Deleted file"), pre(i.file_path));
  } else if (i && tn === "Read" && i.file_path) {
    det.append(label("File"), pre(i.file_path + (i.offset ? `   (from line ${i.offset}${i.limit ? `, ${i.limit} lines` : ""})` : "")));
    if (Array.isArray(i.files) && i.files.length > 1) det.append(label("Also"), pre(i.files.slice(1).join("\n")));
    if (i.command) det.append(label("Command"), pre(i.command));
  } else if (i && (tn === "Grep" || tn === "Glob") && isStr(i.pattern)) {
    det.append(label("Pattern"), pre(i.pattern));
    if (i.path) det.append(label("In"), pre(i.path));
    if (i.glob) det.append(label("Files"), pre(i.glob));
    if (i.command) det.append(label("Command"), pre(i.command));
  } else if (m.status === "preparing" && m.partialInput) {
    det.append(label("Arguments (streaming)" + (m.partialBytes ? ` · ${fmtCompactTok(m.partialBytes)} chars so far` : "")), pre(m.partialInput));
  } else {
    let inputStr;
    try { inputStr = typeof m.toolInput === "string" ? m.toolInput : JSON.stringify(m.toolInput, null, 2); }
    catch { inputStr = String(m.toolInput); }
    det.append(label("Input"), pre(inputStr));
  }
  if (m.progress) det.append(h("div", { class: "det-progress", text: String(m.progress) }));
  if (m.aiSummary) det.append(label(m.aiSummaryCovers > 1 ? `What the model says this batch of ${m.aiSummaryCovers} calls did` : "What the model says this did"), pre(m.aiSummary));
  if (m.outputFile) det.append(label("Output file"), pre(m.outputFile));
  if (m.result != null && m.result !== "") det.append(label("Result"), pre(m.result));
  return det;
}
export function toolIcon(name) {
  const map = { Read: "eye", Edit: "pencil", Write: "pencil", MultiEdit: "pencil", NotebookEdit: "pencil", Delete: "trash", Bash: "terminal", BashOutput: "terminal", Grep: "search", Glob: "search", Task: "sparkle", WebFetch: "globe", WebSearch: "globe", TodoWrite: "list" };
  return map[name] || "cpu";
}
// One-line summary of a tool call. The call's arguments may still be STREAMING (status
// "preparing": the harness announced the tool before its JSON arguments finished), so
// every field is optional here — a missing path/command reads "preparing…", never
// "undefined". Once the field arrives the card is patched (see patchToolCard).
// Lines added / removed by an edit tool call, from its own input — the arithmetic main uses for the
// changed-files counts: Edit = the new string against the old, MultiEdit = the sum, Write = the file's lines.
// null while the arguments are still streaming in (no strings yet) and for other tools.
export function editStats(m) {
  const i = (m && m.toolInput && typeof m.toolInput === "object") ? m.toolInput : {};
  const lines = (s) => (typeof s === "string" && s ? s.split("\n").length : 0);
  switch (m && m.toolName) {
    case "Edit": return typeof i.new_string === "string" || typeof i.old_string === "string" ? { added: lines(i.new_string), removed: lines(i.old_string) } : null;
    case "MultiEdit": { const ed = Array.isArray(i.edits) ? i.edits : []; if (!ed.length) return null; let a = 0, r = 0; for (const e of ed) { a += lines(e && e.new_string); r += lines(e && e.old_string); } return { added: a, removed: r }; }
    case "Write": return typeof i.content === "string" ? { added: lines(i.content), removed: 0 } : null;
    default: return null;
  }
}
export function toolSummary(m, ts) {
  const i = (m.toolInput && typeof m.toolInput === "object") ? m.toolInput : {};
  const str = (v) => (typeof v === "string" && v ? v : "");
  const rel = (p) => (str(p) ? relPath(p, ts.meta.cwd) : "");
  const pending = m.status === "preparing" || m.status === "running" || m.status === "queued" ? "preparing…" : "";
  // File tools: the path alone — the action is the card's tool name (no " · write" / " · edit" repeat, 2026-09-17).
  const filed = (p) => (str(p) ? rel(p) : pending);
  switch (m.toolName) {
    case "Read": return rel(i.file_path) || pending;
    case "Edit": case "MultiEdit": return filed(i.file_path);
    case "Write": return filed(i.file_path);
    case "Delete": return filed(i.file_path);
    case "NotebookEdit": return rel(i.notebook_path) || pending;
    case "Bash": return str(i.command) || str(i.description) || pending;
    case "Grep": return str(i.pattern) ? i.pattern + (str(i.path) ? " in " + rel(i.path) : "") : pending;
    case "Glob": return str(i.pattern) ? i.pattern + (str(i.path) ? " in " + rel(i.path) : "") : pending;
    case "Task": return str(i.description) || str(i.subagent_type) || pending;
    case "WebFetch": return str(i.url) || pending;
    case "WebSearch": return str(i.query) || pending;
    case "TodoWrite": return "update task list";
    default: {
      const v = Object.values(i).find((x) => typeof x === "string" && x);
      return v ? v.slice(0, 120) : pending;
    }
  }
}
export function resultLine(meta, tsIso) {
  meta = meta || {};
  const wrap = h("div", { class: "result-line" });
  wrap.append(h("span", { class: "r-item", html: `${icon("check", 12)} done` }));
  if (meta.durationMs) wrap.append(h("span", { class: "r-item", html: `${icon("history", 12)} ${fmtDur(meta.durationMs)}` }));
  if (meta.numTurns) wrap.append(h("span", { class: "r-item", text: `${meta.numTurns} turn${meta.numTurns > 1 ? "s" : ""}` }));
  // Per-turn token usage — reads Anthropic's usage envelope from the run result.
  const u = meta.usage || null;
  if (u) {
    const inT = u.input_tokens || 0, outT = u.output_tokens || 0;
    const cacheR = u.cache_read_input_tokens || 0, cacheW = u.cache_creation_input_tokens || 0;
    if (inT || outT) wrap.append(h("span", { class: "r-item", title: `input ${inT}   output ${outT}`, text: `${fmtCompactTok(inT)}↑ ${fmtCompactTok(outT)}↓` }));
    if (cacheR) wrap.append(h("span", { class: "r-item", title: `cache-read ${cacheR} tokens (~0.1× cost)`, text: `${fmtCompactTok(cacheR)}⚡` }));
    if (cacheW) wrap.append(h("span", { class: "r-item", title: `cache-write ${cacheW} tokens`, text: `${fmtCompactTok(cacheW)}✎` }));
    if (meta.contextWindow) wrap.append(h("span", { class: "r-item", title: "Model context window (reported by the provider)", text: `${fmtCompactTok(meta.contextWindow)} ctx` }));
  }
  // The account (email / login name) the runtime reported is kept in the record's meta but not shown
  // under the reply (user request 2026-09-17) — the Providers settings page is where accounts live.
  if (typeof meta.costUsd === "number" && meta.costUsd > 0) wrap.append(h("span", { class: "r-item", text: `$${meta.costUsd.toFixed(4)}` }));
  if (tsIso) wrap.append(h("span", { class: "r-item", text: fmtTime(tsIso) }));
  return wrap;
}
// Compact token count — 1234 → "1.2k", 15600 → "15.6k". Same fmtCompact idea we
// had for the removed headroom tile, restored here scoped to token counts.
export function fmtCompactTok(n) {
  n = Math.round(+n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}
/* live streaming region */
export function liveStreamText() {
  const ts = activeTS();
  if (!ts) return { thinkText: "", text: "" };
  const entries = [...ts.streaming.entries()].sort((a, b) => a[0] - b[0]);
  return {
    thinkText: entries.filter(([, v]) => v.kind === "thinking").map(([, v]) => v.text).join(""),
    text: entries.filter(([, v]) => v.kind === "text").map(([, v]) => v.text).join(""),
  };
}
// Full (re)build of the live region. Used on status/structure changes.
// Streaming text is split into per-line elements: the active (last) line grows
// in place (no flicker), and each *newly completed* line fades in subtly.
export function renderLive() {
  cancelLiveUpdate();   // a full rebuild supersedes any pending per-frame text sync
  const ts = activeTS();
  const live = $("chatLive");
  if (!live) return;
  live.innerHTML = "";
  if (!ts) return;
  if (ts.meta.status === "offline") {
    live.append(h("div", { class: "msg assistant live-typing offline-banner" },
      h("div", { class: "msg-avatar assistant", html: icon("wifiOff", 17) }),
      h("div", { class: "msg-body" },
        h("div", { class: "typing-row" },
          h("span", { class: "typing-label", text: "Connection lost — will resume automatically" }),
          h("button", { class: "btn-sm", text: "Retry now", onclick: () => {
            const id = state.activeTabId; if (id) atom.sessions.retry(id);
          } })))));
    scrollBottom();
    return;
  }
  if (ts.meta.status === "auth-expired") {
    const prov = ts.meta.authProvider || ts.meta.provider || "anthropic";
    const label = ({ anthropic: "Claude", openai: "OpenAI", google: "Antigravity", custom: "your API" })[prov] || prov;
    const row = h("div", { class: "typing-row" },
      h("span", { class: "typing-label", text: `Paused — your ${label} login expired. Sign in and this continues with full context.` }),
      h("button", { class: "btn-sm", text: "Sign in", onclick: () => resumeAuthExpired(prov) }),
      h("button", { class: "btn-sm ghost", text: "Switch account", title: "Switch to another saved account", onclick: (e) => openAccountSwitcher(e.currentTarget) }),
      h("button", { class: "btn-sm ghost", text: "Resume now", title: "Already signed in? Resume immediately", onclick: () => {
        const id = state.activeTabId; if (id) atom.sessions.retry(id);
      } }));
    live.append(h("div", { class: "msg assistant live-typing auth-paused-banner" },
      h("div", { class: "msg-avatar assistant", html: icon("key", 17) }),
      h("div", { class: "msg-body" }, row)));
    scrollBottom();
    return;
  }
  if (ts.meta.status === "ratelimited") {
    const secs = ts.meta.rateResumeAt ? Math.max(0, Math.round((ts.meta.rateResumeAt - Date.now()) / 1000)) : 0;
    const waiting = !!ts.meta.rateResumeAt;
    const label = waiting
      ? `Rate limited — auto-retrying in ${secs}s. Your message and context are preserved.`
      : "Rate limited — your message and context are preserved.";
    live.append(h("div", { class: "msg assistant live-typing rate-paused-banner" },
      h("div", { class: "msg-avatar assistant", html: icon("history", 17) }),
      h("div", { class: "msg-body" },
        h("div", { class: "typing-row" },
          h("span", { class: "typing-label rate-countdown", text: label }),
          h("button", { class: "btn-sm", text: "Retry now", onclick: () => { const id = state.activeTabId; if (id) atom.sessions.retry(id); } }),
          h("button", { class: "btn-sm ghost", text: "Switch account", title: "Switch to another saved account", onclick: (e) => openAccountSwitcher(e.currentTarget) })))));
    if (waiting) startRateTicker();
    scrollBottom();
    return;
  }
  if (ts.stopping) {
    live.append(h("div", { class: "msg assistant live-typing" },
      h("div", { class: "msg-avatar assistant", html: icon("atom", 17) }),
      h("div", { class: "msg-body" },
        h("div", { class: "typing-row" },
          h("span", { class: "typing-label", text: "Stopping" }),
          h("div", { class: "typing" }, h("span"), h("span"), h("span"))))));
    scrollBottom();
    return;
  }
  const { thinkText, text } = liveStreamText();
  if (thinkText) {
    const card = thinkingCard(thinkText);
    card.classList.add("open", "live-thinking");
    live.append(h("div", { class: "msg flow" }, card));
  }
  if (text) {
    const linesWrap = h("div", { class: "stream-lines" });
    const bubble = h("div", { class: "bubble streaming" }, linesWrap);
    live.append(h("div", { class: "msg assistant live-assistant" },
      h("div", { class: "msg-avatar assistant", html: icon("atom", 17) }),
      h("div", { class: "msg-body" }, h("div", { class: "msg-role", text: liveRunLabel(ts) }), bubble)));   // live bubble names the provider/model that is ACTUALLY streaming this run
    syncStreamLines(linesWrap, text, true);
  } else if (ts.meta.status === "running" && !thinkText && !ts.pendingPerms.length) {
    live.append(h("div", { class: "msg assistant live-typing" },
      h("div", { class: "msg-avatar assistant", html: icon("atom", 17) }),
      h("div", { class: "msg-body" },
        h("div", { class: "typing-row" },
          h("span", { class: "typing-label", text: liveLabel(ts) }),
          h("div", { class: "typing" }, h("span"), h("span"), h("span"))))));
  }
  scrollBottom();
}
// The typing label: what the CLI reported it is doing (session:live), else "Thinking".
export function liveLabel(ts) {
  const l = ts && ts.live;
  if (!l) return "Thinking";
  if (l.retry) { const r = l.retry; return `Retrying the API call${r.max ? ` (${r.attempt} of ${r.max})` : ""}${r.error ? ` — ${r.error}` : ""}`; }
  if (l.status === "compacting") return "Compacting context";
  if (l.status === "preparing") return l.label || "Preparing conversation context";
  if (l.status === "requesting") return "Waiting for the model";
  if (l.auth) return "Signing in";
  return "Thinking";
}
// Diff the streamed text into line elements. Only the active line's text changes
// per token; brand-new lines are appended with a one-shot fade-in. The blinking
// caret rides at the end of the last line.
//
// Streaming only ever APPENDS to the buffer, so when the new text extends the text
// we synced last frame we skip straight to the previously-last line (the only old
// line that can have grown) instead of re-walking every line div. That turns the
// per-frame cost from O(total lines) into O(new lines) — flat as the reply grows.
//
// EVERY line of the in-flight reply stays in the DOM: the user can scroll up and
// read (or select) the start while the end is still being written. Offscreen
// lines are virtualised with content-visibility (styles.css), so the per-frame
// layout cost is bounded by the visible part, not by the reply's length.
// A line with no newline in it is a single text node, and one 120k-character
// node is re-laid-out in full on every token. Segmenting makes that incremental;
// each segment is far wider than the pane, so it still reads as one paragraph.
export const MAX_LINE_CHARS = 2000;
// Label for the live bubble: the provider/model THIS run was dispatched with
// (snapshotted on the "running" status), falling back to the current setting
// only when no run snapshot exists.
export function liveRunLabel(ts) {
  const r = ts && ts.meta && ts.meta.run;
  const prov = (r && r.provider) || state.settings.llmProvider || "anthropic";
  const base = PROVIDER_NAME[prov] || "Claude";
  return r && r.model ? `${base} · ${r.model}${r.effort ? " · " + r.effort : ""}` : base;
}
export function splitStreamLines(text) {
  const raw = text.split("\n");
  let out = null;
  for (let i = 0; i < raw.length; i++) {
    const ln = raw[i];
    if (ln.length <= MAX_LINE_CHARS) { if (out) out.push(ln); continue; }
    if (!out) out = raw.slice(0, i);
    for (let p = 0; p < ln.length; p += MAX_LINE_CHARS) out.push(ln.slice(p, p + MAX_LINE_CHARS));
  }
  return out || raw;
}
export function syncStreamLines(container, text, initial) {
  if (container.__txt === text) return;            // nothing changed this frame
  const append = container.__txt && text.length > container.__txt.length && text.startsWith(container.__txt);
  const arr = splitStreamLines(text);
  if (!append && container.__txt) container.textContent = "";   // buffer replaced (reset) → rebuild
  const kids = container.children;
  // On a pure append, lines before the previous last one are byte-identical — start
  // the diff at that last line. Otherwise (rebuild / replace) walk from the top.
  let i = append ? Math.max(0, kids.length - 1) : 0;
  for (; i < arr.length; i++) {
    if (i < kids.length) {
      if (kids[i].firstChild && kids[i].firstChild.nodeValue !== arr[i]) kids[i].firstChild.nodeValue = arr[i] || "​";
    } else {
      const ln = document.createElement("div");
      const anim = !(initial && i === 0);
      ln.className = "sl" + (anim ? " sl-in" : "");
      // Drop the class once it has played. It was never removed before, so a long
      // reply ended up with thousands of elements permanently carrying a filled
      // animation — and the class opts a line out of content-visibility, which is
      // what keeps offscreen lines from being laid out on every token.
      if (anim) ln.addEventListener("animationend", () => ln.classList.remove("sl-in"), { once: true });
      ln.appendChild(document.createTextNode(arr[i] || "​"));
      container.appendChild(ln);
    }
  }
  while (kids.length > arr.length) container.removeChild(container.lastChild);
  container.__txt = text;
  const last = container.lastChild;
  if (last) {
    let caret = container.querySelector(".stream-caret");
    if (!caret) { caret = document.createElement("span"); caret.className = "stream-caret"; }
    last.appendChild(caret);
  }
}
// Tokens can arrive dozens of times per second. Rebuilding the live text on every
// one floods the main thread (slow Stop, laggy paste, dropped frames). Instead we
// coalesce: each delta just updates the streaming buffer and asks for ONE DOM sync
// on the next animation frame. Render rate is capped at the display refresh,
// independent of token rate, so the UI stays responsive while generating.
export let _liveRaf = 0, _liveTimer = 0, _liveGen = 0;
// Whichever scheduler fires first CANCELS its peer (not just forgets its handle) and
// checks it still belongs to the current view generation — so a paused rAF that
// wakes up later, or a stale timer, can never flush against another tab or run.
export function flushLive(gen) {
  if (_liveRaf) { cancelAnimationFrame(_liveRaf); _liveRaf = 0; }
  if (_liveTimer) { clearTimeout(_liveTimer); _liveTimer = 0; }
  if (gen !== _liveGen) return;
  updateLiveText();
}
export function scheduleLiveUpdate() {
  if (_liveRaf || _liveTimer) return;
  const gen = _liveGen;
  _liveRaf = requestAnimationFrame(() => flushLive(gen));
  // Fallback: when the window is occluded the compositor can pause rAF entirely, so
  // a reply would visibly stall. A ~100ms timer guarantees the stream keeps flowing
  // even with no frames; whichever fires first wins and cancels the other.
  _liveTimer = setTimeout(() => flushLive(gen), 100);
}
export function cancelLiveUpdate() {
  _liveGen++;   // anything already scheduled belongs to the old view
  if (_liveRaf) { cancelAnimationFrame(_liveRaf); _liveRaf = 0; }
  if (_liveTimer) { clearTimeout(_liveTimer); _liveTimer = 0; }
}
// Lightweight per-token update — patches line text in place (no rebuild, no
// markdown re-parse), only falling back to a full rebuild when the structure
// (thinking ⇄ text ⇄ typing) actually changes.
export function updateLiveText() {
  const live = $("chatLive");
  const ts = activeTS();
  if (!live || !ts) return;
  const { thinkText, text } = liveStreamText();
  const thinkBody = live.querySelector(".live-thinking .thinking-body");
  const linesWrap = live.querySelector(".live-assistant .stream-lines");
  const haveTyping = !!live.querySelector(".live-typing");
  if ((!!thinkText) !== (!!thinkBody) || (!!text) !== (!!linesWrap) || (text && haveTyping)) { renderLive(); return; }
  // Compare against a cached string instead of reading the DOM's textContent
  // (which rebuilds the whole string every frame) — only write when it changed.
  if (thinkBody && thinkBody.__txt !== thinkText) { thinkBody.textContent = thinkText; thinkBody.__txt = thinkText; }
  if (linesWrap) syncStreamLines(linesWrap, text, false);
  // Pinning to the tail costs a synchronous layout, and measuring whether to pin
  // costs another — done right after mutating the DOM, on every streamed token.
  // Whether the reader is at the bottom only changes when they scroll, so it is
  // tracked there instead and this path pays nothing while they are reading back.
  const w = $("chatWrap");
  if (w && !_ctxMenuOpen && _followTail) w.scrollTop = w.scrollHeight;
}
/* permission cards */
export function renderPerms() {
  const ts = activeTS();
  const host = $("chatPerms");
  if (!host) return;
  host.innerHTML = "";
  if (!ts) return;
  for (const p of (ts.permFlash || [])) host.append(answeredCard(p));   // brief green-tick confirmations
  for (const p of ts.pendingPerms) {
    if (p.toolName === "ExitPlanMode") { host.append(planCard(ts, p)); continue; }
    if (p.toolName === "AskUserQuestion" && p.input && Array.isArray(p.input.questions)) { host.append(askCard(ts, p)); continue; }
    let inputStr;
    try { inputStr = typeof p.input === "string" ? p.input : JSON.stringify(p.input, null, 2); } catch { inputStr = String(p.input); }
    // The CLI's own prompt sentence ("Claude wants to run npm test") leads when it sent one; the
    // asking sub-agent is named; a rule's reason / blocked path is shown under the input.
    const head = h("div", { class: "perm-head" }, h("span", { html: icon("shield", 16) }));
    if (p.agentN) head.append(h("span", { class: "perm-agent", text: `Agent #${p.agentN}` }));
    if (p.title) head.append(h("span", { class: "perm-title", text: p.title }), h("span", { class: "perm-tool perm-tool-sub", text: p.displayName || p.toolName }));
    else head.append("Allow ", h("span", { class: "perm-tool", text: p.displayName || p.toolName }), "?");
    head.append(permCountdownChip(p));
    const reason = p.decisionReason || p.blockedPath ? h("div", { class: "perm-reason" }, h("span", { html: icon("info", 13) }), h("span", { text: [p.decisionReason, p.blockedPath ? `Path outside the allowed directories: ${p.blockedPath}` : ""].filter(Boolean).join(" · ") })) : null;
    host.append(h("div", { class: "perm-card" },
      head,
      p.description && p.description !== p.title ? h("div", { class: "perm-desc", text: p.description }) : null,
      h("div", { class: "perm-input", text: inputStr }),
      reason,
      h("div", { class: "perm-actions" },
        h("button", { class: "btn btn-ghost btn-sm", text: "Deny", onclick: () => respondPerm(ts, p, false) }),
        h("button", { class: "btn btn-ghost btn-sm", title: p.canRemember ? `Allow ${p.displayName || p.toolName} for the rest of this session — the CLI records the rule it suggested` : `Allow all ${p.toolName} calls in this tab`, text: "Allow for session", onclick: () => respondPerm(ts, p, true, { always: true }) }),
        h("button", { class: "btn btn-primary btn-sm", text: "Allow once", onclick: () => respondPerm(ts, p, true) }))));
  }
  if (ts.pendingPerms.some((p) => !p.answered)) startPermTimer();
  scrollBottom();
}
// A user decision (permission / plan / question) waits for YOU: the run is paused until
// you answer, and nothing is decided on your behalf. The chip shows how long it has been
// waiting (the tab is marked "attention" meanwhile). The former 5-minute auto-decline made
// tools appear "denied" whenever a prompt sat unanswered while you were reading elsewhere.
export function fmtCountdown(ms) { ms = Math.max(0, ms); const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
export function permCountdownChip(p) { return h("span", { class: "perm-countdown", dataset: { rq: p.requestId }, title: "Waiting for your decision — the run is paused until you answer", text: "waiting " + fmtCountdown(Date.now() - (p.shownAt || Date.now())) }); }
export function answeredCard(p) {
  return h("div", { class: "perm-card perm-answered" },
    h("div", { class: "perm-head" }, h("span", { class: "perm-tick", html: icon("check", 15) }),
      h("span", { class: "perm-answer-label", text: (p.answerLabel || "Answered") + (p.toolName ? " — " + p.toolName : "") })));
}
export let _permTimer = null;
export function startPermTimer() { if (!_permTimer) _permTimer = setInterval(permTick, 1000); }
export function stopPermTimer() { if (_permTimer) { clearInterval(_permTimer); _permTimer = null; } }
export function permTick() {
  const now = Date.now(); let anyPending = false;
  for (const ts of state.tabs.values()) for (const p of ts.pendingPerms) if (!p.answered) anyPending = true;
  const ats = activeTS();
  if (ats) for (const p of ats.pendingPerms) {
    if (p.answered) continue;
    const chip = document.querySelector(`#chatPerms .perm-countdown[data-rq="${CSS.escape(p.requestId)}"]`);
    if (chip) { const waited = now - (p.shownAt || now); chip.textContent = "waiting " + fmtCountdown(waited); chip.classList.toggle("perm-urgent", waited > 5 * 60 * 1000); }
  }
  if (!anyPending) stopPermTimer();
}
// Claude is in plan mode and presented a plan — let the user approve or refine.
export function planCard(ts, p) {
  const plan = (p.input && (p.input.plan || p.input.text)) || "_(no plan text provided)_";
  return h("div", { class: "perm-card plan-card" },
    h("div", { class: "perm-head" }, h("span", { html: icon("list", 16) }), h("span", { class: "perm-tool", text: "Claude has a plan — review it" }), permCountdownChip(p)),
    h("div", { class: "plan-body bubble", html: renderMarkdown(plan) }),
    h("div", { class: "perm-actions" },
      h("button", { class: "btn btn-ghost btn-sm", text: "Keep planning", onclick: () => respondPerm(ts, p, false, { message: "Don't start yet — keep refining the plan." }) }),
      // Approving the plan leaves Plan mode (as Claude Code's own prompt does): the session's
      // working mode becomes the chosen one NOW (live) and for the next turns — otherwise the
      // next message would silently plan again instead of implementing.
      h("button", { class: "btn btn-ghost btn-sm", title: "Implement the plan; confirm each edit and command", text: "Approve — ask for edits", onclick: () => { applyPermissionMode(ts, "default"); respondPerm(ts, p, true); } }),
      h("button", { class: "btn btn-primary btn-sm", title: "Implement the plan; edits are applied automatically, commands still ask", text: "Approve — auto-accept edits", onclick: () => { applyPermissionMode(ts, "acceptEdits"); respondPerm(ts, p, true); } })));
}
// Set the working permission mode for a tab: the shared default (next sends) AND the running
// turn (Claude's live setPermissionMode / Codex's per-request decisions read it immediately).
export function applyPermissionMode(ts, mode) {
  state.settings.defaultPermissionMode = mode;
  atom.settings.set({ defaultPermissionMode: mode }).catch(() => {});
  if (permDD && permDD._refresh) permDD._refresh();
  if (ts && ts.meta) { ts.meta.permissionMode = mode; atom.sessions.setModeLive(ts.meta.id, mode).catch(() => {}); }
}
// Claude called AskUserQuestion — render its questions as radio (single) or
// checkbox (multi) pickers. The user's selection is delivered back as the tool
// response so Claude can continue with the chosen answer(s).
export function askCard(ts, p) {
  const questions = p.input.questions || [];
  const sel = questions.map(() => new Set());     // chosen option indexes per question
  const card = h("div", { class: "perm-card ask-card" });
  card.append(h("div", { class: "perm-head" }, h("span", { html: icon("chat", 16) }), h("span", { class: "perm-tool", text: "Claude is asking" }), permCountdownChip(p)));

  let submit;
  const updateSubmit = () => { if (submit) submit.disabled = !questions.every((q, qi) => sel[qi].size > 0); };

  questions.forEach((q, qi) => {
    const multi = !!q.multiSelect;
    const opts = Array.isArray(q.options) ? q.options : [];
    const optsHost = h("div", { class: "ask-opts" });
    opts.forEach((o, oi) => {
      const id = `ask_${p.requestId}_${qi}_${oi}`;
      const inputEl = h("input", { type: multi ? "checkbox" : "radio", id, name: `ask_${p.requestId}_${qi}`, class: multi ? "aqx-check" : "aqx-radio" });
      inputEl.addEventListener("change", () => {
        if (multi) { inputEl.checked ? sel[qi].add(oi) : sel[qi].delete(oi); }
        else { sel[qi].clear(); if (inputEl.checked) sel[qi].add(oi); }
        updateSubmit();
      });
      optsHost.append(h("label", { class: "ask-opt", for: id }, inputEl,
        h("div", { class: "ask-opt-main" },
          h("div", { class: "ask-opt-label", text: o.label }),
          o.description ? h("div", { class: "ask-opt-desc", text: o.description }) : null)));
    });
    card.append(h("div", { class: "ask-q" },
      h("div", { class: "ask-qhead" },
        q.header ? h("span", { class: "ask-tag", text: q.header }) : null,
        h("span", { class: "ask-qtext", text: q.question || "" })),
      multi ? h("div", { class: "ask-multi", text: "Select all that apply" }) : null,
      optsHost));
  });

  submit = h("button", { class: "btn btn-primary btn-sm", disabled: true, text: "Send answer", onclick: () => {
    // The SDK's contract: the question is ALLOWED with `answers` (question text → chosen
    // label(s), comma-separated). Denying with the answers in a message reaches the model as a
    // permission denial — the old behaviour that looked like "permissions getting denied".
    const answers = {};
    const lines = questions.map((q, qi) => {
      const chosen = [...sel[qi]].map((oi) => (q.options[oi] || {}).label).filter(Boolean);
      answers[q.question || q.header] = chosen.join(", ");
      return `• ${q.header || q.question}: ${chosen.join(", ")}`;
    });
    respondPerm(ts, p, true, { answers, message: "The user answered your question(s):\n" + lines.join("\n") });
  } });
  card.append(h("div", { class: "perm-actions" },
    h("button", { class: "btn btn-ghost btn-sm", text: "Skip", onclick: () => respondPerm(ts, p, false, { message: "The user dismissed the question without choosing. Ask again or proceed with your best judgement." }) }),
    submit));
  return card;
}
export function respondPerm(ts, p, allow, opts = {}) {
  if (p.answered) return;
  if (allow && opts.always) {
    (ts.autoAllow || (ts.autoAllow = new Set())).add(p.toolName);
    // Persist so "for this session" survives a tab close / app restart.
    atom.sessions.update(ts.meta.id, { autoAllow: [...ts.autoAllow] }).catch(() => {});
  }
  // `always` also travels to the main process: when the CLI offered "always allow" rules for this
  // call, they are handed back so the CLI itself stops asking (not just this tab's auto-allow list).
  atom.sessions.permissionResponse(p.requestId, { allow, message: allow ? "" : (opts.message || "Denied by user"), ...(allow && opts.always ? { always: true } : {}), ...(allow && opts.answers ? { answers: opts.answers } : {}), ...(allow && opts.updatedInput ? { updatedInput: opts.updatedInput } : {}) });
  // Remove from PENDING immediately (so running/thinking UI resumes), then show a
  // brief green-tick "answered" card from a separate transient list.
  p.answered = true;
  p.answerLabel = (p.toolName === "AskUserQuestion" || p.toolName === "ExitPlanMode") ? "Answered" : (allow ? (opts.always ? "Allowed for session" : "Allowed") : "Denied");
  ts.pendingPerms = ts.pendingPerms.filter((x) => x.requestId !== p.requestId);
  (ts.permFlash = ts.permFlash || []).push(p);
  if (state.activeTabId === ts.meta.id) { renderPerms(); renderLive(); }
  renderTabs();
  setTimeout(() => {
    ts.permFlash = (ts.permFlash || []).filter((x) => x.requestId !== p.requestId);
    if (state.activeTabId === ts.meta.id) renderPerms();
  }, 1100);
}
/* scroll */
/* Is the reader sitting at the tail? Kept up to date from scroll events so the
 * streaming flush never has to measure it — see updateLiveText. Starts true: an
 * empty or freshly-opened conversation is already at its end. Other modules
 * change it through setFollowTail (an imported binding cannot be assigned). */
export let _followTail = true;
export function setFollowTail(v) { _followTail = !!v; }
export function nearBottom() {
  const w = $("chatWrap");
  return w.scrollHeight - w.scrollTop - w.clientHeight < 140;
}
export function scrollBottom(force) {
  const w = $("chatWrap");
  if (!w) return;
  if (_ctxMenuOpen) return;
  // Jumping to the latest from a detached window (older prompt / search hit):
  // reload the live tail first, then scroll.
  const ts = activeTS();
  if (force && ts && !atTail(ts)) { reloadTail(ts).then(() => scrollBottom(true)); return; }
  if (!(force || nearBottom())) { updateScrollBtn(); return; }  // content grew but user is reading up
  _followTail = true;   // jumping to the tail is exactly what "following" means
  const go = () => { w.scrollTop = w.scrollHeight; updateScrollBtn(); };
  requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
  setTimeout(go, 60);
  if (force) setTimeout(go, 240); // settle after images/long content lay out
}
