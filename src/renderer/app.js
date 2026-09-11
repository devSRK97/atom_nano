import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
// CodeMirror 6 (~285 KB + language chunks) is loaded on demand the first time an
// editor surface is shown — a chat-only session never pays its parse/heap cost.
let createEditor = null, _cmLoading = null;
function ensureCmModule() {
  if (createEditor) return Promise.resolve(createEditor);
  if (!_cmLoading) _cmLoading = import("./editor/cm.bundle.js").then((m) => { createEditor = m.createEditor; return createEditor; });
  return _cmLoading;
}
import { parseUnifiedDiff, processHunk } from "./diff.js";
import { parseConflicts, assembleResolved, previewFor, isFullyResolved, normalizeForEdit, restoreFormat } from "./conflicts.js";
import { openGitCenter, changeText } from "./gitcenter.js";
import { mountDbManager } from "./dbm.js";

const atom = window.atomnano;

/* ----------------------------- constants ----------------------------- */
const BUILTIN_MODELS = [
  { id: "claude-fable-5-1", name: "Fable 5.1", desc: "Newest Fable — most intelligent, top-tier agentic coding" },
  { id: "claude-opus-5", name: "Opus 5", desc: "Newest Opus — strongest reasoning & agentic coding" },
  { id: "claude-fable-5", name: "Fable 5", desc: "Most powerful — top-tier reasoning & agentic work" },
  { id: "claude-opus-4-8", name: "Opus 4.8", desc: "Most capable Opus — deep reasoning & complex builds" },
  { id: "claude-opus-4-7", name: "Opus 4.7", desc: "Previous Opus — strong reasoning" },
  { id: "claude-opus-4-6", name: "Opus 4.6", desc: "Older Opus — capable all-rounder" },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6", desc: "Balanced speed and capability" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", desc: "Fastest — quick edits & questions" },
];
const MODELS = [...BUILTIN_MODELS]; // mutable: discovered (top) + custom (bottom) merged in
// LLM provider — chosen before the model. Anthropic + Custom (Anthropic-compatible
// base URL) run through the Agent SDK today; OpenAI/Google are authorize-ready and
// route generation in a later phase.
const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", desc: "Claude — default, fully supported" },
  { id: "openai", name: "OpenAI", desc: "GPT / Codex (authorize + API)" },
  { id: "custom", name: "Custom API", desc: "Anthropic-compatible base URL + key" },
];

// Newly-released models discovered from the CLI (concrete ids), shown at the top.
let DISCOVERED_MODELS = [];
function prettyModelName(id) {
  // Family-agnostic (so new model lines like "fable" render nicely) and date-safe
  // (a trailing YYYYMMDD snapshot must not be mistaken for a minor version).
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?:-|$))?/.exec(id || "");
  if (!m) return id;
  const fam = `${m[1][0].toUpperCase()}${m[1].slice(1)}`;
  return m[3] !== undefined ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`;
}
// Rebuild the model list: brand-new discovered models first, then the built-ins,
// then user custom models — de-duped.
// Base Anthropic list: the main-process catalog when loaded (single source of
// truth), else the renderer's built-in seed.
function baseModels() {
  const cat = state.providerCatalog && state.providerCatalog.anthropic;
  return cat && Array.isArray(cat.models) && cat.models.length ? cat.models.map((m) => ({ id: m.id, name: m.name, desc: m.desc })) : BUILTIN_MODELS;
}
function rebuildModels() {
  MODELS.length = 0;
  const base = baseModels();
  const builtin = new Set(base.map((m) => m.id));
  const custom = state.settings && Array.isArray(state.settings.customModels) ? state.settings.customModels : [];
  const customIds = new Set(custom.map((m) => m.id));
  for (const id of DISCOVERED_MODELS) if (!builtin.has(id) && !customIds.has(id)) MODELS.push({ id, name: prettyModelName(id), desc: "Newly released" });
  MODELS.push(...base);
  for (const m of custom) if (m && m.id && !MODELS.find((x) => x.id === m.id)) MODELS.push({ id: m.id, name: m.name || m.id, desc: "Custom model" });
  if (typeof modelDD !== "undefined" && modelDD) modelDD._refresh();
}
function applyCustomModels(list) {
  if (list) state.settings.customModels = list;
  rebuildModels();
}

// Which reasoning control the current provider exposes: "thinking" (Claude/Gemini
// thinking levels) or "effort" (OpenAI reasoning effort). Drives the thinking
// dropdown's options + icon.
let REASONING_KIND = "thinking";

/* Switch the composer to a provider: discover its live models + reasoning
 * controls + 1M-context flags and rebuild the model / thinking dropdowns and the
 * 1M toggle to match. Called on boot and whenever the primary provider changes.
 */
function applyProviderModels(provider, res, { announce, prevIds } = {}) {
  if (!res || !Array.isArray(res.models)) return;
  if ((state.settings.llmProvider || "anthropic") !== provider) return;   // provider changed again mid-flight
  const before = prevIds || new Set(MODELS.map((m) => m.id));
  const sameProvider = state._modelsProvider === provider;
  state._modelsProvider = provider;
  MODELS.length = 0;
  // one compact subtitle line per option (context size lives in Settings → Tools)
  for (const m of res.models) { const d = String(m.desc || ""); MODELS.push({ id: m.id, name: m.name, desc: d.length > 44 ? d.slice(0, 43).replace(/[\s,;:]+\S*$/, "") + "…" : d }); }
  state.modelCaps = {};
  state.modelEfforts = {};   // per-model effort ladders (Codex) → the effort dropdown adapts to the picked model
  for (const m of res.models) { state.modelCaps[m.id] = !!m.ctx1m; if (Array.isArray(m.efforts) && m.efforts.length) state.modelEfforts[m.id] = { efforts: m.efforts, def: m.defaultEffort || "" }; }

  REASONING_KIND = res.reasoning || "thinking";
  if (Array.isArray(res.reasoningLevels) && res.reasoningLevels.length) { THINKING.length = 0; for (const l of res.reasoningLevels) THINKING.push(l); state.fullLadder = res.reasoningLevels.slice(); }

  // Keep the selected model + reasoning level valid for the new provider.
  if (!MODELS.find((m) => m.id === state.settings.defaultModel)) {
    const v = res.defaultModel || (MODELS[0] && MODELS[0].id) || "";
    state.settings.defaultModel = v; atom.settings.set({ defaultModel: v }).catch(() => {});
  }
  if (!THINKING.find((l) => l.id === state.settings.defaultThinking)) {
    const v = res.defaultReasoning || (THINKING[0] && THINKING[0].id) || "off";
    state.settings.defaultThinking = v; atom.settings.set({ defaultThinking: v }).catch(() => {});
  }
  syncEffortForModel();

  if (providerDD) providerDD._refresh();
  if (modelDD) modelDD._refresh();
  if (thinkDD) { thinkDD._setIcon(REASONING_KIND === "effort" ? "sparkle" : "brain"); thinkDD._refresh(); }
  updateOneMVisibility();
  if (announce) {
    // Anthropic: ids the CLI probe learned. Codex: anything the (updated) binary's
    // catalog lists that wasn't in the dropdown before — same "new model" toast.
    const fresh = provider === "anthropic"
      ? MODELS.filter((m) => m.desc === "Newly released" && !before.has(m.id))
      : (sameProvider && res.fromCatalog ? MODELS.filter((m) => !before.has(m.id)) : []);
    if (fresh.length) toast(`New model${fresh.length > 1 ? "s" : ""} available: ${fresh.map((m) => m.name).join(", ")}`, "sparkle");
  }
}
// `force` re-runs the CLI alias probe even if its cache is fresh (after an update);
// `instant:false` skips the immediate static-catalog apply (used when only
// refining an already-correct list, so discovered models don't blink out).
async function loadProviderModels(provider, { announce, force, instant = true } = {}) {
  provider = provider || state.settings.llmProvider || "anthropic";
  const cat = state.providerCatalog && state.providerCatalog[provider];
  // CUSTOM: the model list IS the set of configured endpoints. Build it locally
  // from settings so the endpoint names show in the dropdown instantly (and there
  // is no remote model list to discover for a custom API).
  if (provider === "custom") {
    const eps = Array.isArray(state.settings.customEndpoints) ? state.settings.customEndpoints.filter((e) => e && e.id) : [];
    const models = eps.length
      ? eps.map((e) => ({ id: e.id, name: e.name || e.id, desc: "Custom API" }))
      : (Array.isArray(state.settings.customModels) ? state.settings.customModels.filter((m) => m && m.id).map((m) => ({ id: m.id, name: m.name || m.id, desc: "Custom model" })) : []);
    applyProviderModels("custom", {
      models,
      reasoning: (cat && cat.reasoning) || "thinking",
      reasoningLevels: (cat && cat.reasoningLevels) || THINKING,
      defaultModel: (models[0] && models[0].id) || "",
      defaultReasoning: "off",
    }, { announce });
    return;
  }
  // What the dropdown held BEFORE this load (same provider only) — so the "new
  // models" toast after an update compares against the pre-update list, not the
  // instant pass below.
  const prevIds = state._modelsProvider === provider ? new Set(MODELS.map((m) => m.id)) : null;
  // INSTANT: apply the known catalog for this provider so the dropdowns switch
  // immediately (no waiting on a network round-trip).
  if (cat && instant) applyProviderModels(provider, { models: cat.models, reasoning: cat.reasoning, reasoningLevels: cat.reasoningLevels, defaultModel: cat.defaultModel, defaultReasoning: cat.defaultReasoning }, { prevIds });
  // REFINE: live discovery (concrete Anthropic ids / Codex binary catalog /
  // API-discovered models) in the background, then re-apply if still selected.
  let res;
  try { res = await atom.models.discover(provider, force ? { force: true } : null); } catch { return; }
  applyProviderModels(provider, res, { announce, prevIds });
}
const THINKING = [
  { id: "low", name: "Effort: low", desc: "Minimal — skips thinking on easy prompts" },
  { id: "medium", name: "Effort: medium", desc: "Balanced" },
  { id: "high", name: "Effort: high", desc: "Thorough — Opus 4.8 default" },
  { id: "xhigh", name: "Effort: x-high", desc: "Deeper reasoning (Opus 4.7/4.8)" },
  { id: "max", name: "Effort: max", desc: "Maximum (Claude 4.6+ / Sonnet 5 / Fable 5)" },
  { id: "ultracode", name: "Effort: ultracode", desc: "x-high + a workflow per task — many agents, many tokens" },
];
const PERMS = [
  { id: "acceptEdits", name: "Accept edits", desc: "Auto-apply edits, run tools", icon: "check" },
  { id: "default", name: "Ask each time", desc: "Confirm before each tool", icon: "shield" },
  { id: "plan", name: "Plan mode", desc: "Plan only — makes no changes", icon: "list" },
  { id: "bypassPermissions", name: "Full access", desc: "Never ask — run everything", icon: "sparkle" },
];
const FONT_SIZES = { small: 13, medium: 14, large: 15 };

/* ----------------------------- state ----------------------------- */
const state = {
  settings: null,
  activeTabId: null,
  order: [],                 // open tab ids in order
  tabs: new Map(),           // id -> tab state
  // open files: [{path,name,content,saved,dirty,lang}]; panes[i] = path shown in pane i
  editor: { open: [], active: null, fontSize: 13, split: false, splitDir: "v", panes: [null, null], focused: 0 },
  selectedFolder: null,               // last folder clicked in the tree
  findContext: "editor",              // "editor" | "folder" — what Ctrl+F targets
  project: "",                        // this window's project folder
  sidebarView: "files",               // "files" | "git" — what the left pane shows
  git: { repos: [], statuses: {}, message: "", expanded: new Set(), selected: new Set(), pushing: new Set() },  // discovered repos + per-repo status + commit msg + expanded accordions + selected files (repo\0path) for commit + repos with a push in flight
};

function activeTS() { return state.tabs.get(state.activeTabId) || null; }

/* ----------------------------- DOM helpers ----------------------------- */
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}
const $ = (id) => document.getElementById(id);

function timeAgo(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
function baseName(p) { return (p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p; }
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}
function relPath(full, root) {
  if (!full || !root) return full;
  const f = full.replace(/\\/g, "/"), r = root.replace(/\\/g, "/").replace(/\/$/, "");
  return f.startsWith(r) ? f.slice(r.length).replace(/^\//, "") || baseName(full) : full;
}
function fmtDur(ms) { return ms ? (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`) : "—"; }
function fmtTime(iso) {
  try { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
  catch { return ""; }
}

let toastTimer = null;
function toast(msg, ic = "check", opts = {}) {
  const t = $("toast");
  t.className = "toast" + (opts.tone ? " toast-" + opts.tone : "");
  const dots = opts.dots ? `<span class="tdots"><i></i><i></i><i></i></span>` : "";
  t.innerHTML = `${icon(ic, 16, opts.spin ? "spin" : "")}<span>${msg}</span>${dots}`;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  if (!opts.sticky) toastTimer = setTimeout(() => t.classList.add("hidden"), opts.ms || 2200);
}
function hideToast() { clearTimeout(toastTimer); const t = $("toast"); if (t) t.classList.add("hidden"); }
async function copyText(text, label = "Copied to clipboard", html) {
  try { await atom.clipboard.write(text, html || null); toast(label); } catch { toast("Copy failed", "alert"); }
}
// Render an assistant/user message's markdown to standalone HTML for the clipboard,
// with inline styles so tables/code keep their structure when pasted into Word,
// Google Docs, email, etc. (those apps ignore the app's CSS classes). The plain-text
// flavor stays the raw markdown — perfect for a text editor or .md file.
function styleRichHtml(html) {
  const cellBase = "border:1px solid #bbb;padding:4px 9px;text-align:left";
  const styled = String(html || "")
    .replace(/<table[^>]*>/g, '<table style="border-collapse:collapse;border:1px solid #bbb">')
    .replace(/<th([^>]*)>/g, `<th$1 style="${cellBase};background:#f2f2f2;font-weight:600">`)
    .replace(/<td([^>]*)>/g, `<td$1 style="${cellBase}">`)
    .replace(/<pre[^>]*>/g, '<pre style="background:#f5f5f5;padding:10px;border-radius:5px;white-space:pre-wrap;font-family:Consolas,Menlo,monospace">')
    .replace(/<code>/g, '<code style="font-family:Consolas,Menlo,monospace">');
  return '<div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5">' + styled + "</div>";
}
function mdToRichHtml(md) { return styleRichHtml(renderMarkdown(md || "")); }
// The current selection's HTML (preserves rendered tables/styling for a partial copy).
function selectionHtml() {
  const s = window.getSelection && window.getSelection();
  if (!s || !s.rangeCount || s.isCollapsed) return "";
  const div = document.createElement("div");
  for (let i = 0; i < s.rangeCount; i++) div.appendChild(s.getRangeAt(i).cloneContents());
  return div.innerHTML;
}

/* ----------------------------- dropdown -----------------------------
   Menu is rendered fixed on <body> so it is never clipped by the composer. */
function dropdown({ ic, items, getValue, onSelect, align = "left" }) {
  const dd = h("div", { class: "dd" });
  const trigger = h("button", { class: "dd-trigger" });
  dd.append(trigger);
  let _ic = ic;
  function refresh() {
    const it = items.find((i) => i.id === getValue()) || items[0];
    trigger.innerHTML = `${_ic ? icon(_ic, 15, "dd-ico") : ""}<span class="dd-val">${it ? it.name : ""}</span>${icon("chevronDown", 13, "dd-caret")}`;
  }
  dd._setIcon = (n) => { _ic = n; refresh(); };
  let menu = null;
  function teardown() {
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", close);
  }
  function close() { if (menu) { menu.remove(); menu = null; } dd.classList.remove("open"); teardown(); }
  function outside(e) { if (!dd.contains(e.target) && (!menu || !menu.contains(e.target))) close(); }
  // A scrolling page would orphan this fixed-position menu, so we close on scroll —
  // EXCEPT the chat's own auto-scroll while a reply streams, which must not nuke a
  // dropdown the user just opened. Scrolls anywhere else still close it.
  function onScroll(e) {
    const t = e.target;
    if (t && t.nodeType === 1 && (t.id === "chatWrap" || (t.closest && t.closest("#chatWrap")))) return;
    close();
  }
  function position() {
    const r = trigger.getBoundingClientRect();
    menu.style.minWidth = Math.max(230, r.width) + "px";
    // Open on the side with more room and cap height to it, so a long model list
    // scrolls inside the menu instead of overflowing off-screen (top or bottom).
    const margin = 10, gap = 6;
    const spaceAbove = r.top - margin - gap;
    const spaceBelow = window.innerHeight - r.bottom - margin - gap;
    const up = spaceAbove >= spaceBelow;
    menu.style.maxHeight = Math.max(140, up ? spaceAbove : spaceBelow) + "px";
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const top = up ? Math.max(margin, r.top - mh - gap) : r.bottom + gap;
    let left = align === "right" ? r.right - mw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    menu.style.top = top + "px";
    menu.style.left = left + "px";
  }
  function open() {
    if (menu) return close();
    menu = h("div", { class: "dd-menu dd-fixed" });
    const val = getValue();
    for (const it of items) {
      menu.append(h("div", { class: "dd-item" + (it.id === val ? " sel" : ""), onclick: () => { close(); onSelect(it.id); refresh(); } },
        h("span", { class: "di-check", html: icon("check", 14) }),
        h("div", { class: "di-main" },
          h("div", { class: "di-title", text: it.name }),
          it.desc ? h("div", { class: "di-desc", text: it.desc }) : null)));
    }
    document.body.append(menu);
    dd.classList.add("open");
    position();
    setTimeout(() => {
      document.addEventListener("mousedown", outside, true);
      document.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", close);
    }, 0);
  }
  trigger.addEventListener("click", open);
  refresh();
  dd._refresh = refresh;
  return dd;
}

/* ----------------------------- context menu ----------------------------- */
let _ctxMenuOpen = false;
function showContextMenu(x, y, items) {
  const menu = $("ctxMenu");
  menu.innerHTML = "";
  for (const it of items) {
    if (it.sep) { menu.append(h("div", { class: "ctx-sep" })); continue; }
    menu.append(h("div", { class: "ctx-item" + (it.danger ? " danger" : ""), onclick: () => { hideContextMenu(); it.onClick(); } },
      h("span", { html: icon(it.icon || "dot", 16) }), h("span", { text: it.label })));
  }
  menu.classList.remove("hidden");
  _ctxMenuOpen = true;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
}
function hideContextMenu() { $("ctxMenu").classList.add("hidden"); _ctxMenuOpen = false; }
document.addEventListener("mousedown", (e) => { if (!$("ctxMenu").contains(e.target)) hideContextMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && _ctxMenuOpen) hideContextMenu(); });

/* ---- right-click menu for text inputs / textareas (Cut/Copy/Paste/Select All) ---- */
const _INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", "password", "number", ""]);
function inputSel(el) { const s = el.selectionStart || 0, e = el.selectionEnd || 0; return { s, e, has: s !== e }; }
async function inputCopy(el) { const { s, e, has } = inputSel(el); const t = has ? el.value.slice(s, e) : el.value; if (t) await atom.clipboard.write(t); }
async function inputCut(el) {
  if (el.readOnly || el.disabled) return;
  const { s, e, has } = inputSel(el);
  await atom.clipboard.write(has ? el.value.slice(s, e) : el.value);
  el.focus();
  if (has) el.setSelectionRange(s, e); else el.select();
  document.execCommand("delete");
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
async function inputPaste(el) {
  if (el.readOnly || el.disabled) return;
  const t = await atom.clipboard.read().catch(() => "");
  if (!t) return;
  const { s, e } = inputSel(el);
  el.focus(); el.setSelectionRange(s, e);
  document.execCommand("insertText", false, t);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
function inputContextMenu(ev, el) {
  ev.preventDefault();
  const ro = el.readOnly || el.disabled;
  const items = [];
  if (!ro) items.push({ label: "Cut", icon: "cut", onClick: () => inputCut(el) });
  items.push({ label: "Copy", icon: "copy", onClick: () => inputCopy(el) });
  if (!ro) items.push({ label: "Paste", icon: "paste", onClick: () => inputPaste(el) });
  items.push({ sep: true }, { label: "Select all", icon: "list", onClick: () => { el.focus(); el.select(); } });
  showContextMenu(ev.clientX, ev.clientY, items);
}
// Delegated: any text input / textarea gets the menu (the code editor has its own).
document.addEventListener("contextmenu", (e) => {
  const el = e.target;
  if (!el) return;   // CodeMirror has its own context menu (wired in cm-src.js)
  const isTA = el.tagName === "TEXTAREA";
  const isInput = el.tagName === "INPUT" && _INPUT_TYPES.has((el.type || "text").toLowerCase());
  if (!isTA && !isInput) return;
  inputContextMenu(e, el);
});

/* ----------------------------- modals ----------------------------- */
function openModal(node) {
  const back = h("div", { class: "modal-backdrop", onmousedown: (e) => { if (e.target === back) closeModal(back); } });
  back.append(node);
  $("modalRoot").append(back);
  // Move focus into the dialog so the element that opened it (e.g. titlebar
  // Close) can't intercept Enter/Esc, and the modal is keyboard-reachable.
  try { node.setAttribute("tabindex", "-1"); setTimeout(() => { if (document.body.contains(node)) node.focus({ preventScroll: true }); }, 0); } catch { /* ignore */ }
  return back;
}
// Every close path (buttons, ×, backdrop, Escape) ends here, so dialogs that await
// an answer can settle on "modal-closed" exactly once — never a dangling Promise.
function closeModal(back) { if (!back) return; back.remove(); try { back.dispatchEvent(new Event("modal-closed")); } catch { /* */ } }
function modalShell({ title, ic, wide, body, footer }) {
  const back = { current: null };
  const node = h("div", { class: "modal" + (wide ? " wide" : "") },
    h("div", { class: "modal-head" },
      h("span", { class: "mh-ico", html: icon(ic || "settings", 19) }),
      h("h3", { text: title }),
      h("button", { class: "mh-close", html: icon("close", 16), onclick: () => closeModal(back.current) })),
    h("div", { class: "modal-body" }, body),
    footer ? h("div", { class: "modal-foot" }, footer) : null);
  back.current = openModal(node);
  return back.current;
}

/* ============================================================
   STANDALONE DBM WINDOW
   ============================================================ */
async function initStandaloneDbm() {
  // apply saved theme/font before showing anything
  try { const s = await atom.settings.get(); applyTheme(s.theme); applyFontSize(s.fontSize); } catch {}
  // window controls
  $("brandMark").innerHTML = icon("db", 16);
  document.querySelector(".brand-name").innerHTML = 'Atom<span class="brand-accent">Nano</span>&thinsp;<span style="opacity:.45;font-weight:400">· DB</span>';
  // close the DBM window immediately on confirm (no agent sessions to worry about)
  atom.win.onConfirmClose(() => atom.win.forceClose());
  // mount DBM inside #body (already a flex row container)
  const bodyEl = $("body");
  bodyEl.innerHTML = "";
  const root = h("div", { id: "dbmRoot" });
  bodyEl.append(root);
  await openDbManagerFull(root);
}

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  // window controls
  $("brandMark").innerHTML = icon("atom", 20);
  $("winMin").innerHTML = icon("minimize", 15);
  $("winMax").innerHTML = icon("maximize", 13);
  $("winClose").innerHTML = icon("close", 15);
  $("winMin").onclick = () => atom.win.minimize();
  $("winMax").onclick = () => atom.win.maximize();
  $("winClose").onclick = () => atom.win.close();
  atom.win.onMaxChange((max) => { $("winMax").innerHTML = icon(max ? "restore" : "maximize", 13); });
  // Host platform: macOS keeps its native traffic lights (our window buttons hide, the title bar
  // leaves room for them) and names the "taskbar" tile the Dock tile.
  atom.app.info().then((i) => { state.platform = i && i.platform; if (state.platform === "darwin") document.body.classList.add("mac"); }).catch(() => {});
  // Standalone DBM window — load the full manager, skip chat/session init.
  if (new URLSearchParams(window.location.search).get("dbm") === "1") { await initStandaloneDbm(); return; }
  // Close confirmation — same in-app modal as the project chooser (no native box).
  atom.win.onConfirmClose(({ running, isLast, project }) => {
    // Multiple windows = multiple projects. Say which one is closing, and make
    // clear that a non-last window closes just that window (the app stays open).
    const name = project ? String(project).replace(/\\/g, "/").split("/").filter(Boolean).pop() : "";
    const last = isLast !== false;
    const title = last ? "Close AtomNano" : `Close ${name || "this window"}`;
    const label = last ? "Close AtomNano" : "Close window";
    const tail = last
      ? "Open sessions are saved to history and can be reopened anytime."
      : `Other windows stay open. ${name ? "This project's" : "Its"} sessions are saved to history.`;
    confirmDialog({
      title, ic: "alert", confirmLabel: label,
      message: running
        ? `${running} session${running > 1 ? "s are" : " is"} still running in ${name || "this project"} and will be stopped. ${tail}`
        : tail,
      onConfirm: () => atom.win.forceClose(),
    });
  });
  // project name shown after the brand (distinguishes windows)
  $("brandMark").parentElement.append(h("span", { class: "brand-project", id: "brandProject" }));
  // Chat show/hide toggle lives in the title bar so it stays reachable even when
  // the chat section (which now holds the session tabs) is collapsed.
  const chatToggle = h("button", { id: "chatToggle", class: "win-btn", title: "Hide chat (Ctrl+\\)", html: icon("chat", 15), onclick: () => toggleChat() });
  $("winMin").parentElement.insertBefore(chatToggle, $("winMin"));
  // top-right sequence: "Code Agent" label, then Settings, then the chat toggle
  const settingsBtn = h("button", { id: "tbSettings", class: "win-btn", title: "Settings (Ctrl+,)", html: icon("settings", 15), onclick: () => openSettings() });
  $("winMin").parentElement.insertBefore(settingsBtn, chatToggle);
  // DBM — database manager, sits right after the gear.
  const dbmBtn = h("button", { id: "tbDbm", class: "win-btn", title: "Database Manager", html: icon("db", 15), onclick: () => atom.db.openWindow() });
  $("winMin").parentElement.insertBefore(dbmBtn, chatToggle);
  // Terminal toggle — sits before the "Code Agent" label in the top-right run.
  const terminalBtn = h("button", { id: "terminalBtn", class: "win-btn", title: "Terminal (Ctrl+`)", html: icon("terminal", 15), onclick: () => toggleTerminal() });
  $("winMin").parentElement.insertBefore(terminalBtn, settingsBtn);
  $("winMin").parentElement.insertBefore(h("span", { class: "tb-agent-label", text: "Code Agent" }), terminalBtn);
  wireTerminalEvents();

  // "Update available" chip (before the window controls)
  const chip = h("button", { class: "update-chip hidden", id: "updateChip", title: "An update is available — open Settings", onclick: () => openSettings() },
    h("span", { html: icon("arrowUp", 13) }), h("span", { text: "Update" }));
  $("winMin").parentElement.insertBefore(chip, $("winMin"));

  state.settings = await atom.settings.get();
  applyTheme(state.settings.theme || state.settings.accent || "amber");
  applyFontSize(state.settings.fontSize);
  state.editor.fontSize = state.settings.editorFontSize || 13;
  applyEditorZoom();
  applyEditorFontFamily(state.settings.editorFontFamily);
  DISCOVERED_MODELS = Array.isArray(state.settings.discoveredModels) ? state.settings.discoveredModels : [];
  applyCustomModels(state.settings.customModels);
  // Newly-discovered Anthropic ids only refresh the model list while Anthropic is
  // the active provider (otherwise they'd clobber Gemini/OpenAI's catalog).
  atom.events.onModels(({ ids, provider }) => {
    // Codex: the installed Codex re-listed its models (update / login switch) —
    // re-apply if Codex is the active provider, with the "new models" toast.
    if (provider === "openai") { if ((state.settings.llmProvider || "anthropic") === "openai") loadProviderModels("openai", { announce: true, instant: false }); return; }
    if (!Array.isArray(ids)) return;
    DISCOVERED_MODELS = ids;
    // A model learned mid-run (first prompt on a brand-new model) or by another
    // window: re-apply through the single provider path (catalog + discovered +
    // custom) so it lands in the dropdown right away, with a toast.
    if ((state.settings.llmProvider || "anthropic") === "anthropic") loadProviderModels("anthropic", { announce: true, instant: false });
  });
  // Saved-login bookkeeping happens in the main process (token rotation, logins made
  // in a terminal, sign-outs). Reflect it: refresh the auth banner and say what happened.
  if (atom.profiles && atom.profiles.onChanged) atom.profiles.onChanged(({ provider, label, created, loggedOut, loggedIn }) => {
    const brand = provider === "openai" ? "Codex" : "Claude";
    if (loggedOut) toast(`${brand} signed out — saved accounts are kept`, "key", { ms: 4000 });
    else if (created) toast(`New ${brand} login saved as “${label}”`, "key", { ms: 4000 });
    else if (loggedIn) toast(`${brand} signed in${label ? " as " + label : ""}`, "key", { ms: 3000 });
    setTimeout(() => { try { refreshAuthBanner(); renderTabs(); } catch { /* not built yet */ } }, 200);
  });
  atom.events.onFsChange(() => onFsChanged());   // keep tree/editor/git in sync with external changes
  // Git METADATA changed outside the app (terminal commit / checkout / fetch / index-only
  // staging — none of which the tree watcher sees): refresh the sidebar's repo snapshot and
  // the editor gutters. Coalesced; the Git Center subscribes to the same event itself.
  if (atom.events.onGitChanged) atom.events.onGitChanged(() => { if (state._fsSyncOff) return; scheduleGitRefresh(); try { gitGutterRefreshAll(); } catch { /* */ } });
  state.providerCatalog = await atom.providers.catalog().catch(() => null);   // reviewer model pickers
  // Google was removed as a provider — migrate any session pinned to it.
  if (state.settings.llmProvider === "google") { state.settings.llmProvider = "anthropic"; atom.settings.set({ llmProvider: "anthropic" }).catch(() => {}); }
  if (Array.isArray(state.settings.reviewers)) {
    const noG = state.settings.reviewers.filter((r) => r && r.provider !== "google");
    if (noG.length !== state.settings.reviewers.length) { state.settings.reviewers = noG; atom.settings.set({ reviewers: noG }).catch(() => {}); }
  }
  loadProviderModels(state.settings.llmProvider || "anthropic", { announce: true });   // models + reasoning + 1M for the active provider

  // This window's project (folder), passed by the main process.
  state.project = (await atom.win.project().catch(() => "")) || state.settings.lastFolder;
  applyWindowTitle();
  // Taskbar "New Window" → prompt the user to choose a project for this window.
  atom.win.pickOnOpen().then((pick) => { if (pick) setTimeout(() => pickProjectForNewWindow(), 250); }).catch(() => {});

  const list = await atom.sessions.list();
  seedRecentsIfEmpty(list);
  pushRecent(state.project);
  const existing = new Set(list.map((s) => s.id));
  const pt = await atom.project.getTabs(state.project).catch(() => null);
  let open = ((pt && pt.openTabIds) || []).filter((id) => existing.has(id));
  let activeId = pt && pt.activeTabId;
  // legacy fallback (pre multi-window): global openTabIds for the last folder
  if (!open.length && samePath(state.project, state.settings.lastFolder) && Array.isArray(state.settings.openTabIds)) {
    open = state.settings.openTabIds.filter((id) => existing.has(id));
    activeId = activeId || state.settings.activeTabId;
  }
  // else: most recent existing session in this project
  if (!open.length) {
    const inProj = list.filter((s) => samePath(s.cwd, state.project)).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    if (inProj.length) open = [inProj[0].id];
  }
  if (!open.length) { const s = await atom.sessions.create({ cwd: state.project }); open = [s.id]; }
  for (const id of open) { const v = await atom.sessions.get(id); if (v) addTabState(v); }
  state.order = open.filter((id) => state.tabs.has(id));
  state.activeTabId = state.tabs.has(activeId) ? activeId : state.order[0];

  buildComposer();
  wireChatHeader();
  renderTabs();
  await switchTab(state.activeTabId, true);

  // Restore this project's open editor file tabs (quietly skip any that are gone).
  const savedFiles = (pt && pt.editorOpenFiles) || (samePath(state.project, state.settings.lastFolder) ? state.settings.editorOpenFiles : null) || [];
  for (const p of savedFiles) { const sz = await atom.files.size(p).catch(() => -1); if (sz >= 0 && sz <= 5 * 1024 * 1024) await openInEditor(p, true); }  // skip missing/huge on restore
  const savedActive = (pt && pt.editorActiveFile) || (samePath(state.project, state.settings.lastFolder) ? state.settings.editorActiveFile : null);
  if (savedActive && state.editor.open.find((f) => f.path === savedActive)) activateEditorFile(savedActive);
  restoreSplit(pt);

  wireEvents();
  wireGlobalKeys();
  setupLsp();
  initTooltips();
  wireChatDelegation();
  wireChatScroll();
  wireResizers();
  renderTitlebarActions();
  refreshGit();                          // populate branch + git toolbar state
  window.addEventListener("focus", () => { if (gitProjectRoot()) scheduleGitRefresh(); refreshAuthBanner(); refreshUsage(); });   // keep git status + auth banner + usage fresh
  checkUpdatesAndChip();
  refreshUsage();                        // real Claude usage for the active-tab tooltip
  setInterval(() => refreshUsage(), 60000);

  // Automation-only hook (Playwright sets navigator.webdriver); never present in
  // normal use, so it can't be reached by users.
  if (navigator.webdriver) {
    window.__openInEditor = (p) => openInEditor(p); window.__openSearch = (o) => openSearch(o || {}); window.__cm = () => cm;
    window.__copyText = (t, label, html) => copyText(t, label, html); window.__mdToRichHtml = (md) => mdToRichHtml(md);
    // ---- editor tab overflow drivers ----
    window.__etOverflow = () => { const host = $("editorTabs"); const ov = host && host.querySelector(".et-overflow"); const menu = document.querySelector(".et-menu"); return { hiddenCount: ov ? (ov._hidden || []).length : 0, menuOpen: !!menu, menuRows: menu ? menu.querySelectorAll(".et-menu-row").length : 0, menuPaths: menu ? [...menu.querySelectorAll(".et-menu-name")].map((n) => n.title) : [], visiblePaths: host ? [...host.querySelectorAll(".editor-tab:not(.et-hidden)")].map((t) => t.dataset.path) : [] }; };
    window.__etForce = (px) => { const host = $("editorTabs"); if (host) host.style.maxWidth = (px || 220) + "px"; computeEditorOverflow(); return window.__etOverflow(); };
    window.__etOpenMenu = () => { const ov = $("editorTabs") && $("editorTabs").querySelector(".et-overflow"); if (ov && !ov.classList.contains("hidden")) editorOverflowMenu({ currentTarget: ov }); return window.__etOverflow(); };
    window.__etRemoveFirst = () => { const x = document.querySelector(".et-menu .et-menu-row .et-menu-x"); if (x) x.click(); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.__etOverflow())))); };
    window.__etClickOutside = () => { document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return window.__etOverflow(); };
    window.__gotoDef = (pos) => { const f = stateActiveFile(); if (f) editorGotoDefinition(f, pos); };
    window.__sidebarView = (v) => setSidebarView(v);
    window.__renderGitView = (s) => { const repo = (s && s.__repo) || "repo"; state.git.repos = s && s.repo ? [repo] : []; state.git.statuses = s && s.repo ? { [repo]: s } : {}; state.git.selected = new Set(); state.sidebarView = "git"; renderTitlebarActions(); renderFolderActions(); renderGitView(); };
    window.__pushRepo = (r) => pushRepo(r);
    // ---- multi-project git drivers (selection-based commit/push/pull) ----
    window.__setProject = async (p) => { state.project = p; state.sidebarView = "git"; renderSidebar(); await refreshGit(); return { repos: state.git.repos.slice() }; };
    window.__refreshGit = () => refreshGit();
    window.__gitRepos = () => (state.git.repos || []).slice();
    window.__gitSelect = (repo, paths, on = true) => { for (const p of [].concat(paths)) setSel(repo, p, on); renderGitView(); return totalSelected(); };
    window.__gitSelectAll = (on = true) => { for (const r of state.git.repos || []) for (const f of repoFiles(r)) setSel(r, f.path, on); renderGitView(); return totalSelected(); };
    window.__gitSelected = () => [...state.git.selected];
    window.__setGitMessage = (m) => { state.git.message = m; const t = document.getElementById("gvMessage"); if (t) t.value = m; };
    window.__commitSelected = (push) => commitSelected(push);
    window.__pushAll = () => pushAll();
    window.__pullAll = () => pullAll();
    window.__gitStatuses = () => JSON.parse(JSON.stringify(state.git.statuses));
    // ---- commit-view context menus + compare-branches drivers ----
    window.__openCompare = (repo, source, target) => openCompare(repo, source, target);
    window.__openBranchMenu = (repo) => openBranchMenu(repo, { clientX: 120, clientY: 120 });
    window.__hideCtx = () => hideContextMenu();
    window.__gitFileMenu = (repo, f) => gitFileMenu({ clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} }, repo, f);
    window.__gitRepoMenu = (repo, tracked, untracked) => gitRepoMenu({ clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} }, repo, tracked || [], untracked || []);
    window.__ctxItems = () => [...document.querySelectorAll("#ctxMenu .ctx-item")].map((el) => el.textContent.trim());
    window.__ctxClick = (label) => { const el = [...document.querySelectorAll("#ctxMenu .ctx-item")].find((e) => e.textContent.trim() === label); if (el) { el.click(); return true; } return false; };
    window.__gitStage = (repo, paths) => gitStageFiles(repo, paths);
    window.__gitUnstage = (repo, paths) => gitUnstageFiles(repo, paths);
    // ---- filesystem-sync drivers ----
    window.__openTree = async (p) => { state.project = p; state.sidebarView = "files"; await renderSidebar(); return state._watchedRoot || ""; };
    window.__treeNames = () => [...document.querySelectorAll("#fileTree .tw-name")].map((e) => e.textContent);
    window.__watchedRoot = () => state._watchedRoot || "";
    window.__editorCM = () => (cm ? cm.view.state.doc.toString() : null);
    window.__editorState = () => { const f = stateActiveFile(); if (f) syncFileContent(f, cm); return f ? { path: f.path, content: f.content, saved: f.saved, dirty: f.dirty } : null; };
    window.__editorType = (text) => { const f = stateActiveFile(); if (!f) return; f.content = text; f.dirty = (f.content !== f.saved); if (cm) cm.setDoc(text, f.lang); renderEditorTabs(); };
    window.__lastToast = () => { const t = document.getElementById("toast"); return t && !t.classList.contains("hidden") ? t.textContent.trim() : ""; };
    window.__setFsSync = (on) => { state._fsSyncOff = !on; };
    window.__setSetting = (k, v) => { state.settings[k] = v; };   // test hook: flip a live setting
    // ---- navigation drivers ----
    window.__symbols = () => fetchEditorSymbols();
    window.__openSymbolPicker = () => openSymbolPicker();
    window.__breadcrumbs = () => [...document.querySelectorAll("#editorBreadcrumbs .bc-seg span:last-child")].map((e) => e.textContent);
    window.__findReferences = () => editorFindReferences();
    window.__refs = () => (state.editor.refs || []).slice();
    window.__jumpTo = (p, line, col) => jumpTo(p, null, line, col);
    window.__navBack = () => navGo(-1);
    window.__navForward = () => navGo(1);
    window.__gitGutter = () => [...document.querySelectorAll("#editorBody .cm-git-gutter .cm-gitbar")].map((e) => e.className.replace("cm-gitbar", "").trim()).filter((c) => c && c !== "none");
    window.__imageShown = () => { const i = document.querySelector("#editorBody .img-preview"); return !!(i && i.getAttribute("src")); };
    window.__toggleMdPreview = () => toggleMarkdownPreview();
    window.__mdPreviewHtml = () => { const p = document.getElementById("mdPreview"); return p ? p.innerHTML : ""; };
    window.__scanProjectProblems = async () => { state.editor.problemsOpen = true; state.editor.problemsScope = "project"; await scanProjectProblems(); return (state.editor.projDiags || []).slice(); };
    // ---- chat/agent-panel drivers ----
    window.__reloadTab = async (id) => { id = id || state.activeTabId; const v = await atom.sessions.get(id); if (v) addTabState(v); await switchTab(id, true); };
    window.__setEditedFiles = (files) => { const ts = activeTS(); if (ts) { ts.editedFiles = files || []; updateStats(); renderChanges(); } };
    window.__toggleChanges = () => toggleChanges();
    window.__toggleFleet = () => toggleFleet();
    window.__toggleSkills = () => toggleSkills();
    window.__fleetSnap = () => fleetSnap;
    window.__dispatchFleet = async (text) => { showDock("fleet"); await renderFleet(); const ta = $("fleetInput"); if (ta) { ta.value = text; fleetDraft = text; } await dispatchFleet(); return fleetSnap; };
    window.__skillNames = () => [...document.querySelectorAll("#skillsPanel .skill-name")].map((e) => e.textContent);
    window.__toggleTests = () => toggleTests();
    window.__testRows = () => [...document.querySelectorAll("#testsPanel .test-row")].map((r) => ({ name: r.querySelector(".test-name") && r.querySelector(".test-name").textContent, status: (r.querySelector(".test-badge") && r.querySelector(".test-badge").textContent) || "", adapter: (r.querySelector(".test-adp") && r.querySelector(".test-adp").textContent) || "" }));
    window.__goalRows = () => [...document.querySelectorAll("#testsPanel .goal-row")].map((r) => ({ prompt: r.querySelector(".goal-name") && r.querySelector(".goal-name").textContent, status: (r.querySelector(".goal-badge") && r.querySelector(".goal-badge").textContent) || "" }));
    window.__chatFind = (q) => { openChatSearch(); doChatFind(q); return { count: chatFind.hits.length, label: $("chatFindCount") && $("chatFindCount").textContent }; };
    window.__chatFindStep = (d) => { stepChatFind(d); return chatFind.idx; };
    window.__closeChatFind = () => closeChatSearch();
    window.__promptDots = () => [...document.querySelectorAll("#promptRail .rail-dot")].map((d) => d.getAttribute("data-tip") || d.title);
    window.__hoverTip = (sel) => { const el = document.querySelector(sel); if (!el) return null; el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); return true; };
    window.__tipState = () => { const t = document.getElementById("tooltip"); if (!t) return null; const dir = [...t.classList].find((c) => c.startsWith("tip-")) || ""; return { show: t.classList.contains("show"), dir, text: t.textContent, left: parseFloat(t.style.left) || 0 }; };
    window.__clickPromptDot = (i) => { const d = document.querySelectorAll("#promptRail .rail-dot")[i]; if (d) { d.click(); return true; } return false; };
    window.__synthesize = async (id) => { await synthesizeSession(id); const ts = activeTS(); return ts ? { id: ts.meta.id, name: ts.meta.name, first: (ts.messages[0] || {}).text || "" } : null; };
    window.__injectPerm = (toolName, msLeft) => { const ts = activeTS(); if (!ts) return 0; ts.pendingPerms.push({ requestId: "rq" + ts.pendingPerms.length + "_" + msLeft, toolName: toolName || "Bash", input: { command: "echo hi" }, shownAt: Date.now(), deadline: Date.now() + (msLeft || 300000) }); renderPerms(); return ts.pendingPerms.length; };
    window.__permInfo = () => { const ts = activeTS(); const chip = document.querySelector("#chatPerms .perm-countdown"); return { pending: ts ? ts.pendingPerms.length : 0, total: ts ? ts.pendingPerms.length + (ts.permFlash || []).length : 0, countdown: chip ? chip.textContent : null, answeredVisible: !!document.querySelector("#chatPerms .perm-answered"), tick: !!document.querySelector("#chatPerms .perm-tick") }; };
    window.__answerPerm = () => { const ts = activeTS(); const p = ts && ts.pendingPerms.find((x) => !x.answered); if (p) respondPerm(ts, p, true); return !!p; };
    window.__openSettings = () => openSettings();
    window.__settingsCat = (label) => { const b = [...document.querySelectorAll(".st-cat")].find((x) => x.textContent.trim() === label); if (b) { b.click(); return true; } return false; };
    window.__setRunning = (on) => { const ts = activeTS(); if (ts) { ts.meta.status = on ? "running" : "idle"; updateSendButton(); } };
    // ---- streaming render coalescing + dropdown stability while generating ----
    window.__streamPartial = (index, kind, delta) => { const ts = activeTS(); if (!ts) return; ts.meta.status = "running"; const cur = ts.streaming.get(index) || { kind, text: "" }; cur.kind = kind; cur.text += delta || ""; ts.streaming.set(index, cur); scheduleLiveUpdate(); };
    window.__liveRafPending = () => !!(_liveRaf || _liveTimer);
    window.__liveText = () => { const ls = $("chatLive") && $("chatLive").querySelector(".stream-lines"); return ls ? ls.textContent.replace(/​/g, "") : ""; };
    window.__clearStream = () => { const ts = activeTS(); if (ts) { ts.streaming.clear(); ts.meta.status = "idle"; } cancelLiveUpdate(); renderLive(); };
    window.__openFirstDD = () => { const t = document.querySelector(".dd-trigger"); if (t) t.click(); return document.querySelectorAll(".dd-menu").length; };
    window.__ddMenuCount = () => document.querySelectorAll(".dd-menu").length;
    window.__scrollChat = () => { const w = $("chatWrap"); if (w) w.dispatchEvent(new Event("scroll", { bubbles: true })); };
    window.__scrollElsewhere = () => { (document.querySelector("#sidebar") || document.body).dispatchEvent(new Event("scroll", { bubbles: true })); };
    window.__composerSend = (text, opts) => { const ta = $("promptInput"); ta.value = text || ""; ta.dispatchEvent(new Event("input")); return send(opts || {}); };
    window.__composerState = () => { const b = $("sendBtn"), qb = $("queueBtn"); return { sendStop: b.classList.contains("stop"), sendInterrupt: b.classList.contains("interrupt-now"), sendTitle: b.title, queueVisible: !!(qb && !qb.classList.contains("hidden")) }; };
    window.__queueState = () => { const ts = activeTS(); return { len: (ts.queue || []).length, texts: (ts.queue || []).map((q) => q.text), nums: [...document.querySelectorAll("#queueStrip .queue-num")].map((n) => n.textContent) }; };
    window.__pressEnter = (mods) => { const ta = $("promptInput"); const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ctrlKey: !!(mods && mods.ctrl), metaKey: !!(mods && mods.meta), shiftKey: !!(mods && mods.shift) }); ta.dispatchEvent(ev); return ev.defaultPrevented; };
    window.__dispatchQueued = (id) => dispatchNextQueued(id || state.activeTabId);
    window.__resetTabState = () => { const ts = activeTS(); if (ts) { ts.queue = []; ts.stopping = false; ts._dispatching = false; clearTimeout(ts._stopTimer); clearTimeout(ts._dispatchRetry); ts.streaming.clear(); } renderQueue(); updateSendButton(); };
    window.__loadOlder = () => loadOlder();
    // ---- provider / model capability drivers ----
    window.__providerState = () => ({ provider: state.settings.llmProvider || "anthropic", models: MODELS.map((m) => m.id), reasoning: REASONING_KIND, thinking: THINKING.map((t) => t.id), defaultModel: state.settings.defaultModel, defaultThinking: state.settings.defaultThinking, oneMVisible: !!($("oneMWrap") && !$("oneMWrap").classList.contains("hidden")) });
    window.__switchProvider = async (p) => { setSharedSetting("llmProvider", p); await loadProviderModels(p); return window.__providerState(); };
    window.__setModel = (id) => { setSharedSetting("defaultModel", id); if (modelDD) modelDD._refresh(); return window.__providerState(); };
    // ---- reply meta + model filter drivers ----
    window.__injectReply = (meta, text) => { const ts = activeTS(); ts.messages.push({ id: "r" + ts.messages.length, role: "assistant", text: text || "reply", ts: new Date().toISOString(), meta }); renderMessagesRegion(); };
    window.__replyMetas = () => [...document.querySelectorAll("#chatMessages .msg.assistant")].map((el) => ({ label: (el.querySelector(".msg-role-label") || {}).textContent, meta: (el.querySelector(".msg-meta") || {}).textContent || "", mk: el.dataset.mk || "", filtered: el.classList.contains("msg-filtered") }));
    window.__modelFilter = () => { const el = $("modelFilter"); return el ? { chips: [...el.querySelectorAll(".mf-chip")].map((c) => ({ text: c.textContent, active: c.classList.contains("active") })) } : null; };
    window.__clickFilterChip = (text) => { const el = $("modelFilter"); const c = el && [...el.querySelectorAll(".mf-chip")].find((x) => x.textContent === text); if (c) c.click(); return window.__replyMetas(); };
    window.__chatFindCase = (on, q) => { openChatSearch(); const i = $("chatFindInput"); if (i && q != null) i.value = q; chatFind.matchCase = !!on; const b = document.querySelector(".cf-case"); if (b) b.classList.toggle("active", chatFind.matchCase); doChatFind(i ? i.value : ""); return chatFind.hits.length; };
    window.__setAttachments = (atts) => { const ts = activeTS(); ts.attachments = atts || []; renderAttachments(); };
    window.__setPrompt = (t) => { const i = $("promptInput"); if (i) { i.value = t || ""; autoGrow(); updateSendButton(); } };
    // ---- reviewer collapse + image viewer drivers ----
    window.__injectReviewer = (text) => { const ts = activeTS(); ts.messages.push({ id: "rv" + ts.messages.length, role: "reviewer", reviewProvider: "google", reviewModel: "gemini-3.1-pro-preview", reviewKind: "consult", asked: "Conversation so far…\nThe user now asks: extend to 150", text: text || "Keep the same structure but add detail on observability; aim for ~150 words.", ts: new Date().toISOString() }); renderMessagesRegion(); };
    window.__reviewerState = () => { const d = document.querySelector("#chatMessages .msg.reviewer .rv-advice"); return d ? { collapsedByDefault: !d.open, preview: (d.querySelector(".rv-prev") || {}).textContent, hasAsked: !!document.querySelector("#chatMessages .msg.reviewer .rv-asked") } : null; };
    window.__injectImageMsg = (data, mediaType) => { const ts = activeTS(); ts.messages.push({ id: "im" + ts.messages.length, role: "user", text: "see this", attachments: [{ kind: "image", name: "x.gif", data, mediaType: mediaType || "image/gif", thumb: "data:image/gif;base64,THUMBONLY" }], ts: new Date().toISOString() }); renderMessagesRegion(); const el = document.querySelector("#chatMessages .msg.user .msg-att-img"); return el ? el.getAttribute("src") : null; };
    window.__imgIntent = (t) => looksLikeImageRequest(t);
    window.__openImageViewer = (src) => { openImageViewer(src || "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "test.png"); return window.__imageViewer(); };
    window.__imageViewer = () => { const v = $("imgViewer"); if (!v) return null; const img = v.querySelector(".iv-img"); return { present: true, controls: [...v.querySelectorAll(".iv-btn")].map((b) => b.title).filter(Boolean), download: !!v.querySelector("a.iv-btn[download]"), zoom: (v.querySelector(".iv-zoom") || {}).textContent, transform: img.style.transform }; };
    window.__ivBtn = (re) => { const b = [...document.querySelectorAll("#imgViewer .iv-btn")].find((x) => new RegExp(re, "i").test(x.title)); if (b) b.click(); return window.__imageViewer(); };
    window.__ivClose = () => { const b = [...document.querySelectorAll("#imgViewer .iv-btn")].find((x) => /Close/.test(x.title)); if (b) b.click(); return !!$("imgViewer"); };
    window.__chatInfo = () => { const ts = activeTS(); return ts ? { total: ts.totalMessages || ts.messages.length, inRam: ts.messages.length, firstIndex: ts.firstIndex || 0, viewStart: ts.viewStart || 0, rendered: document.querySelectorAll("#chatMessages .msg").length } : null; };
    // ---- checkpoints ----
    window.__createCheckpoint = (l) => createCheckpoint(l);
    window.__checkpoints = () => (state.checkpoints || []).map((c) => ({ id: c.id, label: c.label, files: c.files.length }));
    window.__restoreCheckpoint = (id) => restoreCheckpoint(id);
    // ---- split-editor drivers ----
    window.__splitEditor = () => toggleSplit();
    window.__closeSplit = () => closeSplit();
    window.__splitOrientation = () => toggleSplitOrientation();
    window.__focusPane = (i) => focusPane(i);
    window.__paneCm = (i) => editors[i] || null;
    window.__splitInfo = () => ({
      split: state.editor.split, dir: state.editor.splitDir, focused: state.editor.focused,
      panes: state.editor.panes.slice(), editors: editors.filter(Boolean).length,
      linked: !!(editors[0] && editors[0].isLinked && editors[0].isLinked()),
      hosts: document.querySelectorAll("#editorBody .epane").length,
    });
    // ---- diff + merge drivers ----
    window.__openDiff = (repo, path) => { const s = state.git.statuses[repo]; const f = ((s && s.files) || []).find((x) => x.path === path) || { path, label: "" }; openDiff(repo, f); };
    window.__diffView = (v) => setDiffView(v);
    window.__closeDiff = () => closeDiff();
    window.__diffInfo = () => {
      const back = document.querySelector(".diff-overlay");
      if (!back) return null;
      const q = (sel) => back.querySelectorAll(sel).length;
      return {
        open: true, view: gDiffView,
        adds: _diffNav.parsed ? _diffNav.parsed.adds : 0,
        dels: _diffNav.parsed ? _diffNav.parsed.dels : 0,
        binary: _diffNav.parsed ? _diffNav.parsed.binary : false,
        name: (back.querySelector(".dfh-name") || {}).textContent || "",
        stat: (back.querySelector(".dfh-stat") || {}).textContent || "",
        count: (back.querySelector(".dfh-count") || {}).textContent || "",
        hunks: q(".diff-hunkhdr"),
        splitRows: q(".diff-content.is-split .dsr"),
        unifiedRows: q(".diff-content.is-unified .dl:not(.hunk)"),
        addEls: q(".diff-content .dsc.add, .diff-content .dl.add"),
        delEls: q(".diff-content .dsc.del, .diff-content .dl.del"),
        words: q(".diff-content .wd"),
      };
    };
    window.__gitCheckout = (repo, branch) => gitCheckout(repo, branch);
    window.__gitCheckoutNew = (repo, name) => gitCheckoutNew(repo, name);
    window.__gitMerge = (repo, branch) => gitMerge(repo, branch);
    window.__gitMergeAbort = (repo) => gitMergeAbort(repo);
    // ---- conflict resolver drivers ----
    window.__openConflictResolver = (repo, p) => openConflictResolver(repo, p);
    window.__resolveConflict = (id, choice) => resolveConflict(id, choice);
    window.__bulkResolve = (choice) => bulkResolve(choice);
    window.__markFileResolved = () => markFileResolved();
    window.__completeMerge = () => completeMerge();
    window.__closeMerge = () => closeMerge();
    window.__mergeInfo = () => {
      const back = document.querySelector(".merge-overlay");
      if (!back) return null;
      return {
        open: true, file: _merge.path,
        total: _merge.parsed ? _merge.parsed.count : 0,
        resolved: mergeResolvedCount(),
        files: conflictedFiles(_merge.repo).length,
        cards: back.querySelectorAll(".mg-card:not(.malformed)").length,
        resolvedCards: back.querySelectorAll(".mg-card.resolved").length,
        completeDisabled: !!back.querySelector("#mgComplete").disabled,
        allset: !!back.querySelector(".merge-allset"),
        op: _merge.op, sides: { ..._merge.sides }, kind: _merge.fileInfo ? _merge.fileInfo.kind : "",
        legend: { mine: (back.querySelector(".mgl-cur") || {}).textContent || "", incoming: (back.querySelector(".mgl-inc") || {}).textContent || "" },
      };
    };
  }
}

/* Is the reader sitting at the tail? Kept up to date from scroll events so the
 * streaming flush never has to measure it — see updateLiveText. Starts true: an
 * empty or freshly-opened conversation is already at its end. */
let _followTail = true;

// Infinite scroll: auto-load older messages when the user reaches the top.
function wireChatScroll() {
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
function updateScrollBtn() {
  const w = $("chatWrap"), b = $("scrollBtn");
  if (!w || !b) return;
  const dist = w.scrollHeight - w.scrollTop - w.clientHeight;
  b.classList.toggle("hidden", dist < 48);
}

async function checkUpdatesAndChip(opts) {
  try {
    const u = await atom.updates.check(opts || null);
    state.updates = u;
    const chip = $("updateChip");
    if (chip) chip.classList.toggle("hidden", !(u && u.updateAvailable));
  } catch { /* offline / npm missing — ignore */ }
}

function addTabState(view) {
  const meta = {
    id: view.id, name: view.name, cwd: view.cwd, model: view.model,
    permissionMode: view.permissionMode, thinking: view.thinking, oneM: view.oneM,
    claudeSessionId: view.claudeSessionId, status: view.status || "idle",
    createdAt: view.createdAt, updatedAt: view.updatedAt, totalCostUsd: view.totalCostUsd,
  };
  state.tabs.set(view.id, {
    meta,
    messages: view.messages || [],                 // in-memory window (tail)
    firstIndex: view.firstIndex || 0,              // global index of messages[0]
    totalMessages: view.totalMessages != null ? view.totalMessages : (view.messages ? view.messages.length : 0),
    archivedCount: view.archivedCount || 0,        // oldest msgs pruned past the cap, folded into session memory
    editedFiles: view.editedFiles || [],
    streaming: new Map(),
    pendingPerms: [],
    // Tools the user chose to allow "for this session". Persisted on the
     // session record (view.autoAllow is an array) so the choice survives a tab
     // close, app restart, or window reopen.
    autoAllow: new Set(Array.isArray(view.autoAllow) ? view.autoAllow : []),
    attachments: [],
    queue: [],
    draft: "",
    tree: null,
    // Sticky per-tab skill selection (persisted on the session). Applied on every send.
    selectedSkills: new Set(Array.isArray(view.selectedSkills) ? view.selectedSkills : []),
  });
}

const MEM_CAP = 240;   // max messages kept in renderer memory per tab — a paginated window, never the whole transcript

function saveProjectState() {
  if (!state.project) return;
  atom.project.saveTabs(state.project, {
    openTabIds: state.order, activeTabId: state.activeTabId,
    // Untitled buffers have no path to come back from — persisting one would only
    // produce a tab that fails to restore.
    editorOpenFiles: state.editor.open.filter((f) => !f.untitled).map((f) => f.path),
    editorActiveFile: isUntitled(state.editor.active) ? null : state.editor.active,
    editorSplit: state.editor.split, editorSplitDir: state.editor.splitDir,
    editorPanes: state.editor.panes.map((p) => (isUntitled(p) ? null : p)),
  }).catch(() => {});
}

function persistTabs() {
  saveProjectState();
  if (state.project) { state.settings.lastFolder = state.project; atom.settings.set({ lastFolder: state.project }).catch(() => {}); }
}

function persistEditor() { saveProjectState(); }

/* ----------------------------- accent / font ----------------------------- */
function applyTheme(t) { document.documentElement.setAttribute("data-theme", t || "amber"); }
// Window title bar + OS title (taskbar hover / Alt-Tab) show the project folder.
function applyWindowTitle() {
  const name = baseName(state.project) || "AtomNano";
  document.title = name;          // taskbar / Alt-Tab show the project name only
  const el = $("brandProject");
  if (el) { el.textContent = state.project ? `${name}  (${state.project})` : name; el.title = state.project; }
  applyTaskbarTag(name);
}

// Curated DARK colors (white text always reads well).
const TAG_COLORS = ["#8c2f2f", "#2f5f8c", "#2f7a55", "#5d2f8c", "#8c6a2f", "#2f3a8c", "#8c2f63", "#3a4d5c", "#4d3a2f", "#2f6e6e", "#6e2f2f", "#2f5c3a"];
function tagColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % TAG_COLORS.length;
  return TAG_COLORS[h];
}
function projectKeyOf(p) { return (p || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase(); }

// Per-project taskbar tile record: { tagColor, tagText (≤ 4 letters, "" = project name), tagSize (%) }.
const TAG_TEXT_MAX = 4, TAG_SIZE_MIN = 50, TAG_SIZE_MAX = 150, TAG_SIZE_STEP = 10;
function projectTagRec() { return (state.settings.projects && state.settings.projects[projectKeyOf(state.project)]) || {}; }
// The fixed tile color for this window's project: use the saved one, or assign
// (hash) once and persist it so it never changes again.
function projectColor() {
  const rec = projectTagRec();
  if (rec.tagColor) return rec.tagColor;
  const col = tagColor(baseName(state.project) || "AtomNano");
  saveProjectTag({ tagColor: col });
  return col;
}
function saveProjectColor(col) { saveProjectTag({ tagColor: col }); }
function saveProjectTag(patch) {
  if (!state.project) return;
  const k = projectKeyOf(state.project);
  state.settings.projects = state.settings.projects || {};
  state.settings.projects[k] = { ...(state.settings.projects[k] || {}), path: state.project, ...patch };
  atom.project.saveTabs(state.project, patch).catch(() => {});
}
// Letters on the tile: the custom text (letters/digits only, at most 4) or the project name's.
function tagLetters(custom, name) {
  const clean = (s) => String(s || "").replace(/[^a-z0-9]/gi, "").slice(0, TAG_TEXT_MAX).toUpperCase();
  return clean(custom) || clean(name) || "AQ";
}
function tagSizePct(v) { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== "" && v != null ? Math.max(TAG_SIZE_MIN, Math.min(TAG_SIZE_MAX, n)) : 100; }
// White letters on dark tiles, near-black on light custom colours.
function tagTextColor(bg) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(bg || "").trim()); if (!m) return "#ffffff";
  const v = parseInt(m[1], 16), r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62 ? "#1c1410" : "#ffffff";
}

function drawAtomBadge(ctx, cx, cy, r) {
  ctx.save();
  // dark disc so the amber atom reads on any tile color
  ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, Math.PI * 2); ctx.fillStyle = "rgba(18,13,10,0.6)"; ctx.fill();
  ctx.strokeStyle = "#f0a94e"; ctx.lineWidth = 2.2;
  for (const ang of [Math.PI / 4, -Math.PI / 4]) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
    ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.46, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  ctx.beginPath(); ctx.arc(cx, cy, 3.2, 0, Math.PI * 2); ctx.fillStyle = "#f0a94e"; ctx.fill();
  ctx.restore();
}

// The tile itself (S×S): rounded colour tile, semibold letters, atom badge top-left.
// 100 % = the largest size that fills the tile width (≤ 80px on a 128 tile); `size`
// scales that, but letters never overflow the tile — `dataset.capped` says when a
// larger request could not be honoured. Used for the taskbar icon and the Settings
// preview. Returns the canvas.
function renderTagTile({ text, color, size = 100, S = 128, badge = true } = {}) {
  const c = document.createElement("canvas"); c.width = S; c.height = S;
  const ctx = c.getContext("2d");
  const r = Math.round(S * 0.17);
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.arcTo(S, 0, S, S, r); ctx.arcTo(S, S, 0, S, r); ctx.arcTo(0, S, 0, 0, r); ctx.arcTo(0, 0, S, 0, r); ctx.closePath();
  ctx.fillStyle = color || "#3a4d5c"; ctx.fill();
  ctx.fillStyle = tagTextColor(color);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const font = (px) => `600 ${px}px "Segoe UI", system-ui, sans-serif`;
  const maxW = S - Math.round(S * 0.094), maxFs = Math.round(S * 0.82);
  const fits = (px) => { ctx.font = font(px); return ctx.measureText(text).width <= maxW; };
  let fit = Math.round(S * 0.625);                                  // 100 %: fill the width (80px on a 128 tile)
  while (!fits(fit) && fit > 10) fit -= 2;
  const requested = Math.round(fit * (tagSizePct(size) / 100));
  let fs = Math.min(requested, maxFs);
  while (!fits(fs) && fs > 10) fs -= 2;
  ctx.font = font(fs);
  ctx.fillText(text, S / 2, S * 0.6);
  if (badge) drawAtomBadge(ctx, Math.round(S * 0.195), Math.round(S * 0.195), S * 0.1);   // AtomNano mark, top-left
  c.dataset.fontPx = String(fs);
  c.dataset.capped = fs < requested ? "1" : "";
  return c;
}
// Window/taskbar icon for this window's project: its colour, its letters (custom
// text or the project name) and its text size, all saved per project.
function applyTaskbarTag(name) {
  try {
    const rec = projectTagRec();
    const c = renderTagTile({ text: tagLetters(rec.tagText, name), color: projectColor(), size: rec.tagSize });
    atom.win.setTagIcon(c.toDataURL("image/png")).catch(() => {});
  } catch { /* ignore */ }
}
function applyFontSize(f) { document.body.style.fontSize = (FONT_SIZES[f] || 14) + "px"; }
function applyEditorZoom() { document.documentElement.style.setProperty("--ed-font", (state.editor.fontSize || 13) + "px"); if (cm) cm.remeasure(); }
// Editor font family — a named choice or "default" (falls back to --font-mono).
const EDITOR_FONTS = [
  { id: "default", name: "Default", stack: "" },
  { id: "cascadia", name: "Cascadia Code", stack: '"Cascadia Code", "Cascadia Mono", monospace' },
  { id: "jetbrains", name: "JetBrains Mono", stack: '"JetBrains Mono", monospace' },
  { id: "fira", name: "Fira Code", stack: '"Fira Code", monospace' },
  { id: "consolas", name: "Consolas", stack: 'Consolas, "Courier New", monospace' },
  { id: "system", name: "System mono", stack: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
];
function applyEditorFontFamily(fam) {
  const f = EDITOR_FONTS.find((x) => x.id === fam);
  const stack = f ? f.stack : "";
  if (stack) document.documentElement.style.setProperty("--ed-font-family", stack);
  else document.documentElement.style.removeProperty("--ed-font-family");
  if (cm) cm.remeasure();
}
function changeEditorZoom(dir) {
  let fs = state.editor.fontSize || 13;
  fs = dir === 0 ? 13 : Math.max(9, Math.min(28, fs + dir));
  state.editor.fontSize = fs;
  applyEditorZoom();
  atom.settings.set({ editorFontSize: fs }).catch(() => {});
  const f = stateActiveFile(); if (f) updateEditorStatus(f);
}

/* ============================================================
   TABS
   ============================================================ */
// HTML5 drag-to-reorder. Returns props to spread onto an h() element; onReorder
// gets (draggedId, targetId).
function dragProps(id, onReorder) {
  return {
    draggable: "true",
    ondragstart: (e) => { e.dataTransfer.setData("text/atom-tab", id); e.dataTransfer.effectAllowed = "move"; e.currentTarget.classList.add("dragging"); },
    ondragend: (e) => { e.currentTarget.classList.remove("dragging"); document.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over")); },
    ondragover: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; e.currentTarget.classList.add("drag-over"); },
    ondragleave: (e) => { e.currentTarget.classList.remove("drag-over"); },
    ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove("drag-over"); const from = e.dataTransfer.getData("text/atom-tab"); if (from) onReorder(from, id); },
  };
}
function moveInArray(arr, fromIdx, toIdx) { if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return; const [it] = arr.splice(fromIdx, 1); arr.splice(toIdx, 0, it); }
function reorderSessionTabs(fromId, toId) {
  if (fromId === toId) return;
  moveInArray(state.order, state.order.indexOf(fromId), state.order.indexOf(toId));
  renderTabs(); persistTabs();
}
function reorderEditorTabs(fromPath, toPath) {
  if (fromPath === toPath) return;
  const arr = state.editor.open;
  moveInArray(arr, arr.findIndex((f) => f.path === fromPath), arr.findIndex((f) => f.path === toPath));
  renderEditorTabs(); renderEditor(); persistEditor();
}

// Session tabs now live in the chat-panel header strip and overflow into a
// dropdown the same way the editor tabs do.
// Real Claude subscription usage (five-hour + weekly windows) for the active-tab
// tooltip. Fetched from the OAuth usage API via main; cached + refreshed on a
// timer. `_usage` holds the last good snapshot. `_usageAttempted` flips true
// after the first fetch (success OR failure) so the tooltip stops saying
// "loading…" once we know the result — previously a null return kept it stuck.
let _usage = null, _usageAttempted = false;
async function refreshUsage(force) {
  let u = null;
  try { u = await atom.usage.get(force); } catch { /* ignore */ }
  _usageAttempted = true;
  if (u) _usage = u;
  const a = state.tabs.get(state.activeTabId); if (a) applyTabTip();
}
function fmtResetTime(iso) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d)) return "";
  const now = new Date();
  const mins = Math.round((d - now) / 60000);
  let rel;
  if (mins <= 0) rel = "now";
  else if (mins < 60) rel = `in ${mins}m`;
  else if (mins < 60 * 24) { const hh = Math.floor(mins / 60), mm = mins % 60; rel = `in ${hh}h${mm ? " " + mm + "m" : ""}`; }
  else rel = `in ${Math.round(mins / (60 * 24))}d`;
  const sameDay = d.toDateString() === now.toDateString();
  const clock = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const when = sameDay ? clock : d.toLocaleDateString([], { weekday: "short" }) + " " + clock;
  return `resets ${when} (${rel})`;
}
// Build the active tab's tooltip text: real usage windows + working dir. If the
// fetch has been attempted and there's no data, we fall through to a plain path
// tooltip instead of a stuck "loading…" (that was the reported bug — API-key
// users and offline states left the hover permanently loading).
function usageTipText(ts) {
  const cwd = ts && ts.meta.cwd ? ts.meta.cwd : "";
  // Live context-window fill for this tab (from getContextUsage while running) —
  // the info that used to sit in the composer chip now lives here.
  let ctxLine = "";
  if (ts && ts.ctxUsage && ts.ctxUsage.totalTokens) {
    const u = ts.ctxUsage;
    const pct = u.percentage != null ? Math.round(u.percentage) : (u.maxTokens ? Math.round(u.totalTokens / u.maxTokens * 100) : null);
    ctxLine = `Context: ${pct != null ? pct + "% · " : ""}${(u.totalTokens / 1000).toFixed(1)}k${u.maxTokens ? " / " + (u.maxTokens / 1000).toFixed(0) + "k" : ""} tokens`;
  }
  const cwdBlock = cwd ? "\n\n" + cwd : "";
  if (!_usage) {
    if (!_usageAttempted) return ["Claude usage — loading…", ctxLine].filter(Boolean).join("\n") + cwdBlock;
    // Attempted, no plan data — still show context (if any) + the path.
    return [ctxLine, cwd || (ts && ts.meta.name) || ""].filter(Boolean).join("\n\n") || "";
  }
  const lines = [];
  const fh = _usage.fiveHour, wk = _usage.sevenDay, op = _usage.sevenDayOpus, so = _usage.sevenDaySonnet;
  if (fh) lines.push(`5-hour: ${Math.round(fh.utilization)}% used · ${fmtResetTime(fh.resetsAt)}`);
  if (wk) lines.push(`Weekly: ${Math.round(wk.utilization)}% used · ${fmtResetTime(wk.resetsAt)}`);
  if (op && op.utilization != null) lines.push(`Weekly (Opus): ${Math.round(op.utilization)}%`);
  if (so && so.utilization != null && (!op || op.utilization == null)) lines.push(`Weekly (Sonnet): ${Math.round(so.utilization)}%`);
  if (ctxLine) lines.push(ctxLine);
  if (!lines.length) return cwd || "";
  return "Claude usage\n" + lines.join("\n") + cwdBlock;
}
// Set data-tip on each tab: the ACTIVE tab gets the rich usage tooltip; others
// just show their working dir. Uses the custom (copy-style) tooltip everywhere.
function applyTabTip() {
  const wrap = $("tabs");
  if (!wrap) return;
  for (const el of wrap.querySelectorAll(".cht-tab")) {
    const id = el.dataset.id; const ts = state.tabs.get(id);
    if (!ts) continue;
    if (id === state.activeTabId) el.setAttribute("data-tip", usageTipText(ts));
    else el.setAttribute("data-tip", ts.meta.cwd || ts.meta.name);
  }
}

// Coalesce renderTabs() calls to one DOM rebuild per animation frame. Callers
// fire it liberally (every message, every status change, every permission event
// — 20+ times per turn on a busy session), and each call blows away and rebuilds
// the whole tab strip. With many tabs open that's real reflow work.
let _tabsRaf = 0;
function renderTabs() {
  if (_tabsRaf) return;
  _tabsRaf = requestAnimationFrame(() => { _tabsRaf = 0; renderTabsNow(); });
}
// Tab status indicator glyph: running → 3-dot bounce; done → filled check;
// error / rate-limit / usage-exceeded / offline / auth → red cross; idle → gray
// dot; attention (permission needed) → blinking accent dot.
function statusGlyph(status) {
  if (status === "running") return `<span class="ts-dots"><i></i><i></i><i></i></span>`;
  if (status === "done") return icon("check", 11);
  if (status === "error" || status === "ratelimited" || status === "offline" || status === "auth-expired") return icon("close", 11);
  if (status === "attention") return `<span class="ts-dot ts-attn"></span>`;
  return `<span class="ts-dot"></span>`;   // idle
}
function makeTabEl(id) {
  const tab = h("div", Object.assign({
    class: "cht-tab",
    dataset: { id },
    "data-tip-dir": "bottom",
    onclick: () => switchTab(id),
    ondblclick: () => renameSession(id),
    oncontextmenu: (e) => { e.preventDefault(); tabContextMenu(e, id); },
    onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } },
  }, dragProps(id, reorderSessionTabs)),
    h("span", { class: "tab-status" }),
    h("span", { class: "ct-name" }),
    h("button", { class: "ct-x", html: icon("close", 12), onclick: (e) => { e.stopPropagation(); closeTab(id); } }));
  return tab;
}
// Reconcile the tab strip IN-PLACE (reuse existing elements, update only what
// changed) instead of nuking innerHTML. During generation renderTabs() fires
// ~20×/turn; a full rebuild destroyed the element under the cursor each time,
// which reset the hover-tooltip timer so the usage tooltip could never stay up.
// Reusing elements keeps the hovered node alive → the tooltip persists. It's
// also far less reflow.
function renderTabsNow() {
  const wrap = $("tabs");
  if (!wrap) return;
  const existing = new Map([...wrap.querySelectorAll(":scope > .cht-tab")].map((el) => [el.dataset.id, el]));
  let prev = null;   // for ordering
  for (const id of state.order) {
    const ts = state.tabs.get(id);
    if (!ts) continue;
    const status = ts.pendingPerms.length ? "attention" : (ts.meta.status || "idle");
    const isActive = id === state.activeTabId;
    const tip = isActive ? usageTipText(ts) : (ts.meta.cwd || ts.meta.name);
    let tab = existing.get(id);
    if (tab) existing.delete(id);
    else tab = makeTabEl(id);
    // Update only changed bits (avoids clobbering a hovered element's identity).
    tab.classList.toggle("active", isActive);
    const st = tab.querySelector(".tab-status"); const wantSt = "tab-status " + status;
    if (st.className !== wantSt) { st.className = wantSt; st.innerHTML = statusGlyph(status); }
    const nm = tab.querySelector(".ct-name"); if (nm.textContent !== ts.meta.name) nm.textContent = ts.meta.name;
    if (tab.getAttribute("data-tip") !== tip) tab.setAttribute("data-tip", tip);
    // Order: put this tab right after `prev`. If it's already there, don't touch
    // it (moving the hovered element would drop its tooltip too).
    const anchor = prev ? prev.nextSibling : wrap.firstChild;
    if (anchor !== tab) wrap.insertBefore(tab, anchor);
    prev = tab;
  }
  for (const el of existing.values()) el.remove();   // drop closed tabs
  requestAnimationFrame(computeSessionOverflow);
}

// One-time wiring for the chat header's overflow + History/New-session buttons.
function wireChatHeader() {
  const ov = $("tabOverflow");
  if (ov) { ov.innerHTML = ""; ov.append(h("span", { html: icon("chevronDown", 16) }), h("span", { class: "ct-badge" })); ov.onclick = (e) => sessionOverflowMenu(e); }
  const nt = $("newTab"); if (nt) { nt.innerHTML = icon("plus", 18); nt.onclick = () => newTab(); }
  // Visible affordance for conversation search — Ctrl+F was the only way in before.
  const sb = $("chatSearchBtn"); if (sb) { sb.innerHTML = icon("search", 16); sb.onclick = () => openChatSearch(); }
  // Header "More" — Skills / Fleet / Tests / Import / History live behind this
  // single 3-dot menu, leaving only the provider dropdown + plus visible.
  const more = $("chatMore");
  if (more) {
    more.innerHTML = icon("moreVert", 18);
    more.onclick = async (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      const subOn = !!state.settings.subAgents;
      const subN = Math.max(1, Math.min(8, +state.settings.subAgentsMax || 3));
      const items = [
        { label: "Skills", icon: "sparkle", onClick: () => toggleSkills() },
        { label: "Fleet", icon: "cpu", onClick: () => toggleFleet() },
        { label: "Tests", icon: "checkCircle", onClick: () => toggleTests() },
        { sep: true },
        { label: `Sub agents: ${subOn ? "On" : "Off"}`, icon: subOn ? "checkCircle" : "git",
          onClick: () => { const v = !state.settings.subAgents; setSharedSetting("subAgents", v); toast(`Sub agents ${v ? "on" : "off"}`, "git"); } },
      ];
      if (subOn) items.push({ label: `Max parallel: ${subN}  (click to cycle)`, icon: "git",
        onClick: () => { const next = subN >= 8 ? 1 : subN + 1; setSharedSetting("subAgentsMax", next); toast(`Max subagents: ${next}`, "git"); } });
      // Recent conversations — loaded LIVE from disk each time the menu opens, so it
      // reflects sessions created/updated in other windows since this tab loaded.
      let recents = [];
      try {
        const proj = state.project || (activeTS() && activeTS().meta.cwd);
        const all = await atom.sessions.list();
        recents = all.filter((s) => !proj || samePath(s.cwd, proj)).slice(0, 6);
      } catch { /* ignore — menu still opens without recents */ }
      items.push({ sep: true });
      if (recents.length) {
        items.push({ label: "Recent conversations", icon: "history" });   // header (no onClick)
        for (const s of recents) items.push({ label: s.name || "Untitled", icon: state.tabs.has(s.id) ? "checkCircle" : "chat", onClick: () => openSessionTab(s.id) });
        items.push({ sep: true });
      }
      items.push(
        { label: "Import conversation…", icon: "upload", onClick: () => importConversation() },
        { label: "All history…", icon: "history", onClick: () => openHistory() },
      );
      showContextMenu(r.right - 220, r.bottom + 4, items);
    };
  }
}

// Hide session tabs that don't fit; the overflow button lists them. Mirrors
// computeEditorOverflow — the active tab is always kept visible.
function computeSessionOverflow() {
  const host = $("chatHeader"); const scroll = $("tabs"); const ov = $("tabOverflow");
  if (!host || !scroll || !ov) return;
  const tabs = [...scroll.querySelectorAll(".cht-tab")];
  tabs.forEach((t) => t.classList.remove("cht-hidden"));
  ov.classList.add("hidden"); ov._hidden = [];
  if (tabs.length <= 1) return;
  const actions = host.querySelector(".cht-actions");
  const avail = host.clientWidth - (actions ? actions.offsetWidth : 0);
  const widths = new Map(tabs.map((t) => [t, t.offsetWidth]));
  const total = tabs.reduce((s, t) => s + widths.get(t), 0);
  if (total <= avail) return;
  const reserve = 38;
  const hidden = []; let used = 0;
  for (const t of tabs) {
    const w = widths.get(t);
    if (used + w <= avail - reserve) used += w;
    else { t.classList.add("cht-hidden"); hidden.push(t.dataset.id); }
  }
  const active = state.activeTabId;
  if (active && hidden.includes(active)) {
    const aEl = tabs.find((t) => t.dataset.id === active);
    aEl.classList.remove("cht-hidden");
    hidden.splice(hidden.indexOf(active), 1);
    let w2 = tabs.filter((t) => !t.classList.contains("cht-hidden")).reduce((s, t) => s + widths.get(t), 0);
    const vis = tabs.filter((t) => !t.classList.contains("cht-hidden") && t.dataset.id !== active);
    for (let i = vis.length - 1; i >= 0 && w2 > avail - reserve; i--) { vis[i].classList.add("cht-hidden"); w2 -= widths.get(vis[i]); hidden.push(vis[i].dataset.id); }
  }
  if (!hidden.length) return;
  ov.classList.remove("hidden");
  ov._hidden = hidden;
  const badge = ov.querySelector(".ct-badge"); if (badge) badge.textContent = String(hidden.length);
}

// Bring a hidden session tab into view (move to end → last visible) + activate.
function revealSessionTab(id) {
  const from = state.order.indexOf(id);
  if (from >= 0) { const [it] = state.order.splice(from, 1); state.order.push(it); persistTabs(); }
  switchTab(id);
}

// Dropdown listing session tabs that don't fit; each reveals or closes.
function sessionOverflowMenu(e) {
  const ov = e.currentTarget;
  const ids = (ov._hidden || []).filter((id) => state.tabs.has(id));
  closeEtMenu(); hideContextMenu();
  if (!ids.length) return;
  const menu = h("div", { class: "et-menu" });
  for (const id of ids) {
    const ts = state.tabs.get(id);
    const status = ts.pendingPerms.length ? "attention" : (ts.meta.status || "idle");
    menu.append(h("div", { class: "et-menu-row" + (id === state.activeTabId ? " active" : ""), onclick: () => { closeEtMenu(); revealSessionTab(id); } },
      h("span", { class: "tab-status " + status, style: "width:9px;height:9px;border-radius:50%;flex-shrink:0" }),
      h("span", { class: "et-menu-name", text: ts.meta.name, title: ts.meta.cwd }),
      h("button", { class: "et-menu-x", title: "Close", html: icon("close", 12), onclick: (ev) => { ev.stopPropagation(); closeEtMenu(); closeTab(id); } })));
  }
  document.body.append(menu);
  const r = ov.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + "px";
  menu.style.left = Math.max(8, Math.min(r.right - 240, window.innerWidth - 248)) + "px";
  setTimeout(() => document.addEventListener("mousedown", etMenuOutside, true), 0);
}

/* ============================================================
   TITLEBAR: File menu + Git toolbar (pull / commit / push)
   ============================================================ */
function gitProjectRoot() { return state.project || activeTS()?.meta.cwd || ""; }
function repoName(p) { return (p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p; }
function gitTotalChanges() { return (state.git.repos || []).reduce((n, r) => { const s = state.git.statuses[r]; return n + ((s && s.files) ? s.files.length : 0); }, 0); }
function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

/* ---- commit selection: a Set of "repo\x1fpath" keys, decoupled from git's index.
   Ticking a file (or folder) only SELECTS it; staging happens at commit time. */
function selKey(repo, p) { return repo + "\n" + p; }
function isSel(repo, p) { return state.git.selected.has(selKey(repo, p)); }
function setSel(repo, p, on) { const k = selKey(repo, p); if (on) state.git.selected.add(k); else state.git.selected.delete(k); }
function repoFiles(repo) { const s = state.git.statuses[repo]; return (s && s.files) || []; }
function repoSelectedPaths(repo) { return repoFiles(repo).filter((f) => isSel(repo, f.path)).map((f) => f.path); }
function selectionByRepo() { return (state.git.repos || []).map((repo) => ({ repo, files: repoSelectedPaths(repo) })).filter((g) => g.files.length); }
function totalSelected() { return (state.git.repos || []).reduce((n, r) => n + repoSelectedPaths(r).length, 0); }
function setRepoSelection(repo, files, on) { for (const f of files) setSel(repo, f.path, on); afterGitSelectionChange(); }
function afterGitSelectionChange() { renderGitView(); }
// A repo is pushable if it has commits the upstream lacks, or has never been pushed.
function gitPushable(repo) { const s = state.git.statuses[repo]; return !!s && (s.ahead > 0 || !s.upstream); }

// Title bar now holds only the File menu — Pull/Push/Commit moved into the
// project-dropdown row (see renderFolderActions).
function renderTitlebarActions() {
  const host = $("tbActions");
  if (!host) return;
  host.innerHTML = "";
  host.append(h("button", { class: "tb-btn", title: "File", onclick: (e) => fileMenu(e) },
    h("span", { html: icon("file", 15) }), h("span", { text: "File" })));
}

// Everything the Git Center module (gitcenter.js) borrows from app.js — passed
// explicitly so the module stays decoupled. All functions are hoisted; `state`
// and `atom` exist by the time a button is clicked.
function gitCenterDeps() {
  return {
    h, icon, atom, state, toast, esc, repoName, baseName, fileMeta,
    parseUnifiedDiff, renderDiffContent, diffEmpty, getDiffView: () => gDiffView, setDiffView,
    refreshGit, refreshTree, openInEditor, openConflictResolver, conflictedFiles, showMenuAt,
    chooseDialog, promptDialog, confirmDialog, modalShell, projectRoot: gitProjectRoot,
  };
}

// The project-dropdown row's action buttons. Files view → [Search, Git,
// Collapse, Pull, Commit]; the Git/commit view swaps Collapse for a Back arrow. Git buttons only
// appear when the folder is (or contains) a repo. (No standalone Push — pushing
// happens via Commit & Push, the per-project push button, or the row's menu.)
function renderFolderActions() {
  const host = $("folderActions");
  if (!host) return;
  host.innerHTML = "";
  const inGit = state.sidebarView === "git";
  if (inGit) {
    host.append(h("button", { class: "sb-act", title: "Back to files", onclick: () => setSidebarView("files") },
      h("span", { html: icon("chevronLeft", 14) }), "Back"));
  } else {
    // Project search — folders, file names and file contents, with filters.
    host.append(h("button", { class: "sb-act icon-only", title: "Search folders, files & contents in this project", onclick: () => { const ts = activeTS(); openSearch({ root: (ts && ts.meta.cwd) || state.project, mode: "content" }); } },
      h("span", { html: icon("search", 14) })));
    // Git Center — every repo, source → target merge/rebase, history, branches, stashes…
    host.append(h("button", { class: "sb-act icon-only", title: "Git Center — repositories, branches, merge & conflicts, history, stashes, tags", onclick: () => openGitCenter(gitCenterDeps(), {}) },
      h("span", { html: icon("git", 14) })));
    host.append(h("button", { class: "sb-act", title: "Collapse all", onclick: () => { const ts = activeTS(); if (ts) { ts.tree.expanded.clear(); renderTree(); } } },
      h("span", { html: icon("list", 14) }), "Collapse"));
  }
  const repos = state.git.repos || [];
  if (!repos.length) return;
  const behind = repos.reduce((n, r) => { const s = state.git.statuses[r]; return n + ((s && s.behind) || 0); }, 0);
  host.append(h("button", { class: "sb-act", title: repos.length > 1 ? "Pull all projects" : "Pull (git pull)", onclick: () => pullAll() },
    h("span", { html: icon("pull", 14) }), behind ? `Pull (${behind})` : "Pull"));
  const total = gitTotalChanges();
  // Opens the full Review & Commit modal directly — does NOT switch the
  // sidebar away from the file tree the user is currently looking at.
  host.append(h("button", { class: "sb-act" + (inGit ? " active" : ""), title: "Review & commit changes", onclick: () => {
    if (!total) { toast("No changes to commit", "alert"); return; }
    openCommitModal(false);
  } },
    h("span", { html: icon("commit", 14) }), total ? `Commit (${total})` : "Commit"));
}

function fileMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 4, [
    { label: "New file", icon: "file", onClick: () => newUntitledFile() },
    { label: "Open folder…", icon: "folderOpen", onClick: () => pickAndOpenProject() },
    { label: "New session", icon: "plus", onClick: () => newTab() },
    { sep: true },
    { label: "Search in project", icon: "search", onClick: () => openSearch({ mode: "content", root: state.project }) },
    { label: "Import conversation…", icon: "download", onClick: () => importConversation() },
    { sep: true },
    { label: "Settings", icon: "settings", onClick: () => openSettings() },
  ]);
}

/* ============================================================
   GIT: per-repo discovery + status, commit view (replaces the tree)
   ============================================================ */
function setSidebarView(view) {
  state.sidebarView = view === "git" ? "git" : "files";
  renderSidebar();
  if (state.sidebarView === "git") refreshGit();
}

let _refreshGitT = 0;
function scheduleGitRefresh() { clearTimeout(_refreshGitT); _refreshGitT = setTimeout(() => refreshGit(), 250); }

// Discover the project's repo(s) (itself, or its repo subfolders) and fetch the
// status of each — the commit view shows them all, grouped by folder.
async function refreshGit() {
  const root = gitProjectRoot();
  let repos = [];
  if (root) { try { repos = await atom.git.repos(root); } catch { repos = []; } }
  state.git.repos = repos;
  try { if (atom.git.watch) atom.git.watch(repos).catch(() => {}); } catch { /* optional */ }
  renderFolderActions();
  const statuses = {};
  // A status read that FAILS is an error state (last snapshot kept, marked stale) — it is
  // never presented as a clean tree, and its repo is never silently dropped.
  await Promise.all(repos.map(async (r) => {
    const prev = state.git.statuses[r];
    try { const s = await atom.git.status(r); statuses[r] = s && s.repo === false ? { repo: false, state: "notRepo", files: [], branch: "", error: "Not a Git repository" } : { ...s, state: "ready", error: "" }; }
    catch (e) { statuses[r] = { ...(prev && prev.repo ? prev : { repo: true, branch: "", files: [] }), state: "error", stale: !!(prev && prev.state === "ready"), error: e.message || String(e), type: e.type, files: (prev && prev.files) || [], clean: false }; }
  }));
  state.git.statuses = statuses;
  // Drop selections whose file no longer appears in the status (committed/reverted).
  const valid = new Set();
  for (const r of repos) { const s = statuses[r]; if (s && s.files) for (const f of s.files) valid.add(selKey(r, f.path)); }
  for (const k of [...state.git.selected]) if (!valid.has(k)) state.git.selected.delete(k);
  renderFolderActions();
  if (state.sidebarView === "git") renderGitView();
}

function gitBranchOf(repo) {
  const s = state.git.statuses[repo];
  return (s && s.branch) || "";
}

/* ---- multi-project pull / push, with progress + per-project summary toasts ---- */

// Pull a single repo (used by a tree folder's right-click "Git pull").
async function gitPull(repo) {
  if (!repo) return;
  toast("Pulling " + esc(repoName(repo)) + "…", "spinner", { sticky: true, spin: true });
  try {
    const r = await atom.git.pull(repo);
    await refreshGit(); refreshTree(true);
    // A conflicted pull resolves with ok:false / state:"conflict" — it is NOT a success.
    if (r && (r.conflict || r.state === "conflict")) { if (state.sidebarView !== "git") setSidebarView("git"); toast(`<b>Pull of ${esc(repoName(repo))} needs your help</b><span class="toast-sub">Conflicts to resolve — then continue the ${esc(r.op || "merge")} from the banner.</span>`, "alert", { ms: 7000 }); openConflictResolver(repo); return; }
    if (r && r.ok === false) { toast("Pull failed (" + esc(repoName(repo)) + "): " + esc(r.error || r.output || r.state), "alert", { ms: 6000 }); return; }
    const sub = r.upToDate ? "already up to date" : changeText(r.summary, { verb: "updated" });
    toast(`<b>Pulled ${esc(repoName(repo))} → ${esc(r.branch || "")}</b>${sub ? `<span class="toast-sub">${esc(sub)}</span>` : ""}`, "checkCircle", { ms: 4200 });
  } catch (e) { toast("Pull failed (" + esc(repoName(repo)) + "): " + esc(e.message), "alert", { ms: 6000 }); }
}

// Pull every discovered project, one after another, with a live progress toast
// and a final summary naming each project and its branch.
async function pullAll() {
  const repos = state.git.repos || [];
  if (!repos.length) return;
  const results = [];
  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    toast(`Pulling ${esc(repoName(repo))}…  (${i + 1}/${repos.length})`, "spinner", { sticky: true, spin: true });
    try {
      const r = await atom.git.pull(repo);
      if (r && (r.conflict || r.state === "conflict")) results.push({ repo, ok: false, branch: r.branch, error: "conflicts to resolve (open the Changes view)", conflict: true });
      else if (r && r.ok === false) results.push({ repo, ok: false, branch: r.branch, error: r.error || r.output || r.state || "failed" });
      else results.push({ repo, ok: true, branch: r.branch, upToDate: r.upToDate, summary: r.summary });
    }
    catch (e) { results.push({ repo, ok: false, error: e.message }); }
  }
  summaryToast("Pulled", results, { changedWord: "updated" });
  await refreshGit(); refreshTree(true);
  if (results.some((r) => r.conflict) && state.sidebarView !== "git") setSidebarView("git");
}

// Push a list of repos sequentially with progress; returns per-repo results.
async function pushReposList(repos, { verb = "Pushed" } = {}) {
  const list = (repos || []).filter(Boolean);
  if (!list.length) return [];
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const repo = list[i];
    const branch = gitBranchOf(repo) || (await atom.git.branch(repo).catch(() => "")) || "";
    state.git.pushing.add(repo);
    if (state.sidebarView === "git") renderGitView();
    toast(`Pushing ${esc(repoName(repo))}${branch ? " · " + esc(branch) : ""}  (${i + 1}/${list.length})`, "spinner", { sticky: true, spin: true, dots: true });
    try {
      const r = await atom.git.push(repo);   // resolved destination (branch remote / pushRemote / pushDefault) — never an invented origin
      if (r && r.state === "rejected") results.push({ repo, ok: false, branch: r.branch || branch, error: `rejected by ${r.remote || "the remote"} — pull first (${(r.error || "").split("\n")[0]})`, rejected: true });
      else if (r && r.ok === false) results.push({ repo, ok: false, branch: r.branch || branch, error: r.error || r.state || "failed" });
      else results.push({ repo, ok: true, branch: r.branch || branch, upToDate: r.upToDate, dest: r.remote && r.dest ? `${r.remote}/${r.dest}` : "", summary: r.summary, newRef: r.newRef });
    }
    catch (e) { results.push({ repo, ok: false, branch, error: e.message }); }
    finally { state.git.pushing.delete(repo); if (state.sidebarView === "git") renderGitView(); }
  }
  summaryToast(verb, results);
  return results;
}

// Push every project that has unpushed commits (or no upstream yet).
async function pushAll() {
  const repos = (state.git.repos || []).filter(gitPushable);
  if (!repos.length) { toast("Nothing to push — all projects up to date", "push", { ms: 2600 }); return; }
  await pushReposList(repos, { verb: "Pushed" });
  await refreshGit();
}

// Thin wrapper kept for the per-repo push button + test hook.
async function pushRepo(repo) { const r = await pushReposList([repo], { verb: "Pushed" }); return !!(r[0] && r[0].ok); }

// One shared summary toast for pull/push/commit results: success lists every
// project → branch; partial/total failure shows the errors.
function summaryToast(verb, results, { changedWord } = {}) {
  const okR = results.filter((r) => r.ok), bad = results.filter((r) => !r.ok);
  // "(12 files updated · +340 −22 · 3 commits)" when the backend reported what moved
  const tail = (r) => r.upToDate ? " (up to date)" : r.newRef ? " (new branch published)" : r.summary ? ` (${changeText(r.summary, { verb: changedWord || "changed", commitsFirst: !changedWord })})` : (changedWord ? ` (${changedWord})` : "");
  const line = (r) => `${esc(repoName(r.repo))} → ${esc(r.dest || r.branch || "?")}${tail(r)}`;
  const errLine = (r) => `${esc(repoName(r.repo))}: ${esc(r.error)}`;
  if (okR.length && !bad.length) {
    if (okR.length === 1) toast(`${verb} ${line(okR[0])}`, "checkCircle", { ms: 4200 });
    else toast(`<b>${verb} ${okR.length} projects</b><span class="toast-sub">${okR.map(line).join("<br>")}</span>`, "checkCircle", { ms: 5200 });
  } else if (okR.length && bad.length) {
    toast(`<b>${verb} ${okR.length}, ${bad.length} failed</b><span class="toast-sub">${[...okR.map(line), ...bad.map(errLine)].join("<br>")}</span>`, "alert", { ms: 7000 });
  } else {
    toast(`<b>${verb === "Pulled" ? "Pull" : "Push"} failed</b><span class="toast-sub">${bad.map(errLine).join("<br>")}</span>`, "alert", { ms: 7000 });
  }
}

// Commit the SELECTED files in each project (selection is staged then committed
// with the same pathspec). The button decides whether the committed projects are
// then pushed. Falls back to the lone dirty repo when nothing is ticked.
// "Review & commit changes" modal — a polished two-pane workflow:
//   ▸ left pane: file list grouped by repo, each file with its type-coloured
//     icon, +/− stats, type badge, individual checkbox + select-all
//   ▸ right pane: live unified diff preview of the focused file with green/red
//     line highlighting
//   ▸ bottom: commit message + summary chip + Cancel / Commit / Commit & Push
// `defaultPush` pre-selects which action gets visual primacy (the button the
// user actually clicked on the side panel).
async function openCommitModal(defaultPush) {
  const repos = (state.git.repos || []).filter((r) => { const s = state.git.statuses[r]; return s && s.files && s.files.length; });
  if (!repos.length) { toast("No changes to commit", "alert"); return; }
  // If the user hasn't selected anything yet, default-select everything they
  // currently have changes in — single-repo workspaces especially expect this.
  const anySel = repos.some((r) => repoFiles(r).some((f) => isSel(r, f.path)));
  if (!anySel) for (const r of repos) for (const f of repoFiles(r)) setSel(r, f.path, !f.conflict);

  const body = h("div", { class: "commit-modal" });

  // Per-repo collapsed/expanded state (id-keyed Set). Default = expanded.
  const collapsed = new Set();

  // Tab strip: switches the modal between Commit and Merge modes. Both keep
  // the same chrome (header, footer); only the body content swaps.
  let mode = "commit";
  const tabCommit = h("button", { class: "cm-tab active", text: "Commit", onclick: () => setMode("commit") });
  const tabMerge = h("button", { class: "cm-tab", text: "Merge", onclick: () => setMode("merge") });
  const tabStrip = h("div", { class: "cm-tabs" }, tabCommit, tabMerge);
  // Containers for the two sub-views. The merge view is built lazily — first
  // time the user clicks the tab.
  const commitView = h("div", { class: "cm-view commit-view" });
  const mergeView = h("div", { class: "cm-view merge-view hidden" });
  let mergeBuilt = false;
  body.append(tabStrip, commitView, mergeView);

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    tabCommit.classList.toggle("active", mode === "commit");
    tabMerge.classList.toggle("active", mode === "merge");
    commitView.classList.toggle("hidden", mode !== "commit");
    mergeView.classList.toggle("hidden", mode !== "merge");
    // Lazy-build the merge view on first show.
    if (mode === "merge" && !mergeBuilt) { mergeBuilt = true; buildMergeView(); }
    // Footer chip + action buttons change shape between modes.
    updateFooterForMode();
  }

  // --- LEFT pane: file list -------------------------------------------------
  const leftPane = h("div", { class: "cm-files-pane" });
  const summaryEl = h("div", { class: "cm-files-summary" });
  const selectAllRow = h("label", { class: "cm-select-all" },
    h("input", { type: "checkbox", id: "cmSelectAll" }),
    h("span", { text: "Select all" }));
  selectAllRow.querySelector("input").addEventListener("change", (ev) => {
    const on = ev.target.checked;
    for (const r of repos) for (const f of repoFiles(r)) setSel(r, f.path, on && !f.conflict);
    redraw();
  });
  leftPane.append(h("div", { class: "cm-files-head" }, summaryEl, selectAllRow));
  const filesList = h("div", { class: "cm-files-list" });
  leftPane.append(filesList);

  // --- Draggable divider between left + right panes -----------------------
  const divider = h("div", { class: "cm-divider", title: "Drag to resize" });
  // Mouse drag → CSS variable on the outer .cm-main grid, clamped to a sane
  // min/max so the left pane never collapses to zero or eats the right one.
  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.classList.add("cm-resizing");
    const main = body.querySelector(".cm-main");
    const startX = e.clientX;
    const startWidth = leftPane.getBoundingClientRect().width;
    const totalWidth = main.getBoundingClientRect().width;
    const onMove = (m) => {
      const next = Math.max(220, Math.min(totalWidth - 320, startWidth + (m.clientX - startX)));
      main.style.setProperty("--cm-left", next + "px");
    };
    const onUp = () => {
      document.body.classList.remove("cm-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  // --- RIGHT pane: diff preview --------------------------------------------
  const rightPane = h("div", { class: "cm-diff-pane" });
  rightPane.append(h("div", { class: "cm-diff-empty" }, h("span", { html: icon("gitCompare", 28) }), h("span", { text: "Click a file to preview its diff" })));
  let activeFilePath = null;

  // --- BOTTOM: commit message + actions ------------------------------------
  const msg = h("textarea", { class: "cm-msg", placeholder: "Write a clear, one-line summary. Add details below if needed.", spellcheck: "false", rows: "3" });
  msg.value = state.git.message || "";
  msg.addEventListener("input", () => { state.git.message = msg.value; updateButtons(); });
  // Ctrl/Cmd+Enter = primary action (commit, or commit & push if that's the
  // default the user opened this from).
  msg.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); (defaultPush ? doCommitPush : doCommit)(); }
  });

  const cancelBtn = h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => closeModal(modal) });
  const commitBtn = h("button", { class: "btn" + (defaultPush ? "" : " btn-primary"), text: "Commit", onclick: () => doCommit() });
  const commitPushBtn = h("button", { class: "btn" + (defaultPush ? " btn-primary" : ""), text: "Commit & Push", onclick: () => doCommitPush() });
  const actionsRight = h("div", { class: "cm-actions-right" }, cancelBtn, commitBtn, commitPushBtn);
  const statsChip = h("div", { class: "cm-stats-chip" });

  commitView.append(
    h("div", { class: "cm-main" }, leftPane, divider, rightPane),
    h("div", { class: "cm-bottom" },
      h("div", { class: "cm-msg-label" },
        h("span", { class: "cm-msg-label-text", text: "Commit message" }),
        h("span", { class: "cm-msg-hint", text: "Ctrl+Enter to commit" })),
      msg));

  // Footer holds two button bundles, one per mode. We swap them when the user
  // switches tabs so the same modal-foot lives in both flows.
  const mergeBtn = h("button", { class: "btn btn-primary", text: "Merge", disabled: true, onclick: () => doMerge() });
  const createMrBtn = h("button", { class: "btn", text: "Open as merge request", disabled: true, onclick: () => openAsMergeRequest() });
  const mergeCancelBtn = h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => closeModal(modal) });
  const mergeStatsChip = h("div", { class: "cm-stats-chip", text: "Select branches to compare" });
  const commitFootGroup = h("div", { class: "cm-foot-group" }, statsChip, h("div", { class: "spacer" }), actionsRight);
  const mergeFootGroup = h("div", { class: "cm-foot-group hidden" }, mergeStatsChip, h("div", { class: "spacer" }), mergeCancelBtn, createMrBtn, mergeBtn);
  const footer = h("div", { class: "cm-foot" }, commitFootGroup, mergeFootGroup);
  function updateFooterForMode() {
    commitFootGroup.classList.toggle("hidden", mode !== "commit");
    mergeFootGroup.classList.toggle("hidden", mode !== "merge");
  }

  const modal = modalShell({ title: "Review & commit changes", ic: "commit", wide: true, body, footer });

  // --- MERGE view (built lazily on first tab switch) ---------------------
  let mergeState = { repo: null, source: null, target: null, commits: null, files: null, fileDiffs: new Map(), activeFile: null };
  function buildMergeView() {
    const allRepos = (state.git.repos || []).slice();
    const repoSel = h("select", { class: "cm-merge-select" });
    for (const r of allRepos) repoSel.append(h("option", { value: r, text: repoName(r) }));
    const sourceSel = h("select", { class: "cm-merge-select", disabled: true });
    const targetSel = h("select", { class: "cm-merge-select", disabled: true });
    const compareBtn = h("button", { class: "btn btn-primary cm-merge-compare", text: "Compare", disabled: true,
      onclick: () => runCompare(repoSel.value, sourceSel.value, targetSel.value) });
    const swapBtn = h("button", { class: "btn btn-ghost cm-merge-swap", title: "Swap source and target", html: icon("refresh", 13),
      onclick: () => { const a = sourceSel.value; sourceSel.value = targetSel.value; targetSel.value = a; updateCompareReadiness(); } });

    const pickerBar = h("div", { class: "cm-merge-picker" },
      h("div", { class: "cm-merge-field" }, h("label", { text: "Project" }), repoSel),
      h("div", { class: "cm-merge-field" }, h("label", { text: "Source (FROM)" }), sourceSel),
      swapBtn,
      h("div", { class: "cm-merge-field" }, h("label", { text: "Target (INTO)" }), targetSel),
      compareBtn);

    const summaryBar = h("div", { class: "cm-merge-summary hidden" });
    const compareBody = h("div", { class: "cm-merge-results hidden" });
    const initialMsg = h("div", { class: "cm-merge-initial" },
      h("span", { html: icon("gitCompare", 36) }),
      h("h3", { text: "Compare and merge branches" }),
      h("p", { text: "Pick a project, then choose the source and target branches. Compare shows what will land before you merge." }));

    mergeView.append(pickerBar, summaryBar, initialMsg, compareBody);

    // Load branches for the selected repo + auto-pick a sensible default
    // (source = current branch, target = main/master/develop if present).
    async function reloadBranches(repo) {
      sourceSel.innerHTML = ""; targetSel.innerHTML = "";
      sourceSel.disabled = targetSel.disabled = true;
      summaryBar.classList.add("hidden"); summaryBar.innerHTML = "";
      compareBody.classList.add("hidden"); compareBody.innerHTML = "";
      initialMsg.classList.remove("hidden");
      mergeBtn.disabled = createMrBtn.disabled = true;
      mergeStatsChip.textContent = "Loading branches…";
      let info;
      try { info = await atom.git.branches(repo); }
      catch (e) { mergeStatsChip.textContent = "Couldn't list branches: " + e.message; return; }
      // Real IPC shape: { locals, remotes } (legacy `local` / `remote` still accepted).
      // Sources may be any ref; TARGETS are local branches only (a remote-tracking ref or
      // tag would be checked out detached and the merge would update nothing).
      const localsList = Array.from(new Set((info.locals || info.local || []).filter(Boolean)));
      const remotesList = Array.from(new Set((info.remotes || info.remote || []).filter(Boolean)));
      const unique = Array.from(new Set([...localsList, ...remotesList]));
      for (const b of unique) sourceSel.append(h("option", { value: b, text: b }));
      for (const b of localsList) targetSel.append(h("option", { value: b, text: b }));
      const current = info.current || (state.git.statuses[repo] && state.git.statuses[repo].branch) || "";
      const defaultTarget = localsList.find((b) => /^(main|master|develop|trunk)$/.test(b)) || localsList[0];
      sourceSel.value = current || unique[0] || "";
      targetSel.value = defaultTarget && defaultTarget !== sourceSel.value ? defaultTarget : (localsList.find((b) => b !== sourceSel.value) || "");
      sourceSel.disabled = targetSel.disabled = false;
      mergeStatsChip.textContent = "Click Compare to load changes";
      updateCompareReadiness();
    }
    function updateCompareReadiness() { compareBtn.disabled = !sourceSel.value || !targetSel.value || sourceSel.value === targetSel.value; }

    repoSel.addEventListener("change", () => reloadBranches(repoSel.value));
    sourceSel.addEventListener("change", updateCompareReadiness);
    targetSel.addEventListener("change", updateCompareReadiness);

    // Auto-select the repo the user was looking at, or the only repo.
    repoSel.value = repos[0] || allRepos[0];
    reloadBranches(repoSel.value);

    // Compare → fetch commits + files, then render the GitLab-style results.
    async function runCompare(repo, source, target) {
      mergeState = { repo, source, target, commits: null, files: null, fileDiffs: new Map(), activeFile: null };
      compareBtn.disabled = true;
      compareBtn.innerHTML = `${icon("spinner", 13, "spin")}<span style="margin-left:6px">Comparing…</span>`;
      mergeStatsChip.textContent = `Comparing ${source} → ${target}…`;
      initialMsg.classList.add("hidden");
      summaryBar.classList.remove("hidden");
      summaryBar.innerHTML = "";
      summaryBar.append(h("div", { class: "cm-merge-loading" }, h("span", { html: icon("spinner", 14, "spin") }), h("span", { text: "Loading commits and changed files…" })));
      try {
        const [cRes, fRes] = await Promise.all([
          atom.git.commitsBetween(repo, target, source).catch((e) => ({ error: e.message, commits: [] })),
          atom.git.changedBetween(repo, target, source).catch((e) => ({ error: e.message, files: [] })),
        ]);
        mergeState.commits = cRes.commits || [];
        mergeState.files = fRes.files || [];
        renderCompareResults(cRes, fRes);
      } catch (e) {
        summaryBar.innerHTML = "";
        summaryBar.append(h("div", { class: "cm-merge-error", text: "Compare failed: " + e.message }));
      } finally {
        compareBtn.disabled = false; compareBtn.textContent = "Compare";
        updateCompareReadiness();
      }
    }

    // The GitLab-style compare results: top stats bar, then 50/50 split with
    // commits on the left and changed files on the right (click a file to
    // expand its diff inline).
    function renderCompareResults(cRes, fRes) {
      const commits = mergeState.commits, files = mergeState.files;
      summaryBar.innerHTML = "";
      summaryBar.append(
        h("div", { class: "cm-merge-stat" }, h("span", { class: "n", text: String(commits.length) }), h("span", { class: "k", text: commits.length === 1 ? "commit" : "commits" })),
        h("div", { class: "cm-merge-arrow", text: "·" }),
        h("div", { class: "cm-merge-stat" }, h("span", { class: "n", text: String(files.length) }), h("span", { class: "k", text: files.length === 1 ? "file" : "files" })),
        h("div", { class: "cm-merge-arrow", text: "·" }),
        h("div", { class: "cm-merge-branchpair" },
          h("span", { class: "cm-merge-branch-from", text: mergeState.source }),
          h("span", { html: icon("chevron", 12), style: "transform: rotate(0deg); opacity:.5;" }),
          h("span", { class: "cm-merge-branch-to", text: mergeState.target })));

      compareBody.classList.remove("hidden");
      compareBody.innerHTML = "";

      // Left: commit list
      const commitsCol = h("div", { class: "cm-merge-col cm-merge-commits" });
      commitsCol.append(h("div", { class: "cm-merge-col-head", text: `Commits (${commits.length})` }));
      const cList = h("div", { class: "cm-merge-col-body" });
      if (!commits.length) cList.append(h("div", { class: "cm-merge-empty", text: "No new commits on source. Source is up to date with target." }));
      else for (const c of commits) {
        cList.append(h("div", { class: "cm-merge-commit", title: `${c.full}\n${c.subject}\n— ${c.author} · ${c.date}` },
          h("span", { class: "cm-commit-hash", text: c.hash }),
          h("div", { class: "cm-commit-body" },
            h("div", { class: "cm-commit-subject", text: c.subject }),
            h("div", { class: "cm-commit-meta", text: `${c.author} · ${c.date}` }))));
      }
      commitsCol.append(cList);

      // Right: files list — click to expand inline diff
      const filesCol = h("div", { class: "cm-merge-col cm-merge-files" });
      filesCol.append(h("div", { class: "cm-merge-col-head", text: `Changed files (${files.length})` }));
      const fList = h("div", { class: "cm-merge-col-body" });
      if (!files.length) fList.append(h("div", { class: "cm-merge-empty", text: "No file changes. Branches are identical for files." }));
      else for (const f of files) {
        const fm = fileMeta(baseName(f.path));
        const statCls = f.code === "A" ? "added" : f.code === "D" ? "deleted" : "modified";
        const row = h("div", { class: "cm-merge-file" },
          h("div", { class: "cm-merge-file-head" },
            h("span", { class: "cm-merge-file-caret", html: icon("chevron", 12) }),
            h("span", { class: "cm-merge-file-ic " + fm.cls, html: icon(fm.ic, 13) }),
            h("span", { class: "cm-merge-file-name " + fm.cls, text: baseName(f.path) }),
            h("span", { class: "cm-merge-file-path", text: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "" }),
            h("span", { class: "cm-merge-file-stat " + statCls, text: f.label })),
          h("div", { class: "cm-merge-file-diff hidden" }));
        const head = row.querySelector(".cm-merge-file-head");
        const diffSlot = row.querySelector(".cm-merge-file-diff");
        head.addEventListener("click", async () => {
          const expanded = !diffSlot.classList.contains("hidden");
          if (expanded) { diffSlot.classList.add("hidden"); row.classList.remove("expanded"); return; }
          row.classList.add("expanded"); diffSlot.classList.remove("hidden");
          if (!mergeState.fileDiffs.has(f.path)) {
            diffSlot.innerHTML = ""; diffSlot.append(h("div", { class: "cm-diff-loading" }, h("span", { html: icon("spinner", 14, "spin") }), h("span", { text: "Loading diff…" })));
            try {
              const d = await atom.git.refDiff(mergeState.repo, mergeState.target, mergeState.source, f.path);
              mergeState.fileDiffs.set(f.path, d.text || "");
            } catch (e) { mergeState.fileDiffs.set(f.path, ""); }
          }
          const text = mergeState.fileDiffs.get(f.path) || "";
          diffSlot.innerHTML = "";
          if (!text.trim()) { diffSlot.append(h("div", { class: "cm-merge-empty cm-merge-empty-small", text: "No textual diff (binary or empty)." })); return; }
          const pre = h("pre", { class: "cm-diff-body" });
          let html = "";
          for (const ln of text.split("\n")) {
            let cls = "";
            if (ln.startsWith("@@")) cls = "diff-hunk";
            else if (ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff ") || ln.startsWith("index ")) cls = "diff-meta";
            else if (ln.startsWith("+")) cls = "diff-add";
            else if (ln.startsWith("-")) cls = "diff-del";
            html += `<span class="${cls}">${esc(ln)}</span>\n`;
          }
          pre.innerHTML = html;
          diffSlot.append(pre);
        });
        fList.append(row);
      }
      filesCol.append(fList);
      compareBody.append(commitsCol, filesCol);

      // Update footer
      mergeStatsChip.textContent = `${commits.length} commit${commits.length === 1 ? "" : "s"} · ${files.length} file${files.length === 1 ? "" : "s"} · ${mergeState.source} → ${mergeState.target}`;
      mergeBtn.disabled = !commits.length;
      createMrBtn.disabled = !commits.length;
    }

    // Perform the merge — opens the existing Commit Progress modal so the
    // user sees a single uniform "operation in flight" UX for both flows.
    async function doMerge() {
      if (!mergeState.repo || !mergeState.source || !mergeState.target) return;
      const c = await confirmDialog({
        title: "Merge branches?",
        message: `Merge ${mergeState.source} into ${mergeState.target} in ${repoName(mergeState.repo)}? This creates a merge commit on ${mergeState.target}.`,
        confirmLabel: "Merge",
      });
      if (!c) return;
      mergeBtn.disabled = true; createMrBtn.disabled = true;
      mergeBtn.innerHTML = `${icon("spinner", 13, "spin")}<span style="margin-left:6px">Merging…</span>`;
      try {
        const r = await atom.git.mergeBranches(mergeState.repo, mergeState.source, mergeState.target, `Merge ${mergeState.source} into ${mergeState.target}`);
        await refreshGit(); refreshTree(true);
        if (r.state === "conflict" || r.conflict) {
          closeModal(modal);
          toast(`<b>Merge needs your help: ${esc(mergeState.source)} → ${esc(mergeState.target)}</b><span class="toast-sub">Resolve each conflict, then complete the merge.</span>`, "alert", { ms: 6000 });
          openConflictResolver(mergeState.repo);
        } else if (r.ok) {
          toast(`Merged ${esc(mergeState.source)} → ${esc(mergeState.target)} (${r.upToDate ? "already up to date" : r.fastForward ? "fast-forward" : "merge commit"})`, "checkCircle", { ms: 3500 });
          closeModal(modal);
        } else toast("Merge failed: " + esc(r.error || r.output || r.state), "alert", { ms: 6000 });
      } catch (e) { toast("Merge failed: " + esc(e.message), "alert", { ms: 6000 }); }
      finally { mergeBtn.disabled = false; createMrBtn.disabled = false; mergeBtn.textContent = "Merge"; }
    }

    // Build a "compare" URL for GitHub / GitLab / Bitbucket and open it. Lets
    // teams that gate merges through code review jump straight into the right
    // page on the remote with both branches pre-filled.
    async function openAsMergeRequest() {
      if (!mergeState.repo) return;
      let url = "";
      try { const r = await atom.git.remoteUrl(mergeState.repo, "origin"); url = r.url || ""; } catch { /* */ }
      if (!url) { toast("No remote 'origin' configured for this repo", "alert"); return; }
      // Normalise common SSH form: git@host:user/repo.git → https://host/user/repo
      let web = url.replace(/\.git$/, "").replace(/^git@([^:]+):/, "https://$1/");
      const target = mergeState.target, source = mergeState.source;
      let final = "";
      if (/github\.com/.test(web)) final = `${web}/compare/${encodeURIComponent(target)}...${encodeURIComponent(source)}?expand=1`;
      else if (/gitlab/.test(web)) final = `${web}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(source)}&merge_request[target_branch]=${encodeURIComponent(target)}`;
      else if (/bitbucket/.test(web)) final = `${web}/pull-requests/new?source=${encodeURIComponent(source)}&dest=${encodeURIComponent(target)}`;
      else final = `${web}/compare/${encodeURIComponent(target)}...${encodeURIComponent(source)}`;
      atom.shell.openExternal(final).catch(() => {});
      toast("Opening merge request page in your browser…", "external");
    }

    // Expose to outer scope so the footer buttons can call them.
    mergeView._doMerge = doMerge;
    mergeView._openMr = openAsMergeRequest;
  }
  function doMerge() { if (mergeView._doMerge) mergeView._doMerge(); }
  function openAsMergeRequest() { if (mergeView._openMr) mergeView._openMr(); }

  // Re-render everything that depends on selection / messages.
  function redraw() {
    filesList.innerHTML = "";
    let totalFiles = 0, selFiles = 0;
    for (const repo of repos) {
      const files = repoFiles(repo).slice().sort((a, b) => a.path.localeCompare(b.path));
      if (!files.length) continue;
      const selInRepo = files.filter((f) => isSel(repo, f.path)).length;
      const eligibleInRepo = files.filter((f) => !f.conflict).length;
      totalFiles += files.length;
      selFiles += selInRepo;
      const isCollapsed = collapsed.has(repo);

      // Project-level tri-state checkbox — like the old git panel, lets you
      // toggle every file in the repo with one click. `indeterminate` fires
      // when only some files in the repo are picked.
      const repoCb = h("input", { type: "checkbox" });
      repoCb.checked = eligibleInRepo > 0 && selInRepo === eligibleInRepo;
      repoCb.indeterminate = selInRepo > 0 && selInRepo < eligibleInRepo;
      repoCb.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const on = ev.target.checked;
        for (const f of files) if (!f.conflict) setSel(repo, f.path, on);
        redraw();
      });

      const status = state.git.statuses[repo] || {};
      const branchStr = status.branch || "(detached)";
      const aheadBehind = (status.ahead ? `↑${status.ahead}` : "") + (status.behind ? `↓${status.behind}` : "");

      const caret = h("span", { class: "cm-repo-caret" + (isCollapsed ? " collapsed" : ""), html: icon("chevronDown", 12) });

      const stageAllBtn = h("button", { class: "cm-mini-btn", title: "Stage all files in this project", onclick: async (ev) => {
        ev.stopPropagation();
        try { await atom.git.stageAll(repo); await refreshGit(); redraw(); }
        catch (e) { toast("Stage all failed: " + e.message, "alert"); }
      } }, "Stage all");
      const unstageBtn = h("button", { class: "cm-mini-btn", title: "Unstage all files in this project", onclick: async (ev) => {
        ev.stopPropagation();
        try { await atom.git.unstageAll(repo); await refreshGit(); redraw(); }
        catch (e) { toast("Unstage failed: " + e.message, "alert"); }
      } }, "Unstage");

      const repoHead = h("div", { class: "cm-repo-head" + (isCollapsed ? " collapsed" : ""), onclick: (ev) => {
        // Click anywhere except the checkbox or action buttons toggles collapse.
        if (ev.target.tagName === "INPUT" || ev.target.closest(".cm-mini-btn")) return;
        if (isCollapsed) collapsed.delete(repo); else collapsed.add(repo);
        redraw();
      } },
        caret,
        repoCb,
        h("span", { class: "cm-repo-ic", html: icon("branch", 13) }),
        h("span", { class: "cm-repo-name", text: repoName(repo) }),
        h("span", { class: "cm-repo-branch", text: branchStr }),
        aheadBehind ? h("span", { class: "cm-repo-ab", text: aheadBehind }) : null,
        h("span", { class: "cm-repo-spacer" }),
        h("span", { class: "cm-repo-count", text: `${selInRepo}/${files.length}` }),
        stageAllBtn,
        unstageBtn);
      filesList.append(repoHead);

      if (isCollapsed) continue;

      for (const f of files) {
        const fm = fileMeta(baseName(f.path));
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
        const sel = isSel(repo, f.path);
        const stat = (f.label || "").trim();
        const statCls = stat === "Untracked" ? "untracked" : stat === "Deleted" ? "deleted" : stat === "Added" ? "added" : "modified";
        const cb = h("input", { type: "checkbox" });
        cb.checked = sel; cb.disabled = !!f.conflict;
        cb.addEventListener("click", (ev) => { ev.stopPropagation(); setSel(repo, f.path, cb.checked); redraw(); });
        const row = h("div", {
          class: "cm-file" + (sel ? " sel" : "") + (f.conflict ? " conflict" : "") + (activeFilePath === f.path ? " active" : ""),
          onclick: () => showDiff(repo, f),
          oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); gitFileMenu(e, repo, f); },
        },
          cb,
          h("span", { class: "cm-file-ic " + fm.cls, html: icon(fm.ic, 14) }),
          h("span", { class: "cm-file-name " + fm.cls, text: baseName(f.path) }),
          dir ? h("span", { class: "cm-file-dir", text: dir }) : null,
          h("span", { class: "cm-file-stat " + statCls, text: stat || "M" }));
        filesList.append(row);
      }
    }
    summaryEl.textContent = `${selFiles}/${totalFiles} file${totalFiles === 1 ? "" : "s"} selected`;
    selectAllRow.querySelector("input").checked = selFiles === totalFiles && totalFiles > 0;
    selectAllRow.querySelector("input").indeterminate = selFiles > 0 && selFiles < totalFiles;
    statsChip.textContent = `${selFiles} file${selFiles === 1 ? "" : "s"} ready to commit`;
    updateButtons();
  }

  function updateButtons() {
    const selFiles = repos.reduce((n, r) => n + repoFiles(r).filter((f) => isSel(r, f.path)).length, 0);
    const ready = !!msg.value.trim() && selFiles > 0;
    commitBtn.disabled = !ready;
    commitPushBtn.disabled = !ready;
  }

  // Show the unified diff for one file in the right pane, with line-level
  // colour for added / removed / hunk-header lines. Reuses parseUnifiedDiff
  // so the rendering matches the inline diff view.
  async function showDiff(repo, f) {
    activeFilePath = f.path;
    // Spotlight the active row in the list without a full redraw.
    for (const row of filesList.querySelectorAll(".cm-file.active")) row.classList.remove("active");
    const all = filesList.querySelectorAll(".cm-file");
    for (const row of all) {
      if (row.querySelector(".cm-file-name") && row.querySelector(".cm-file-name").textContent === baseName(f.path)) row.classList.add("active");
    }
    rightPane.innerHTML = "";
    const fm = fileMeta(baseName(f.path));
    rightPane.append(h("div", { class: "cm-diff-head" },
      h("span", { class: "cm-diff-ic " + fm.cls, html: icon(fm.ic, 14) }),
      h("span", { class: "cm-diff-name " + fm.cls, text: baseName(f.path) }),
      h("span", { class: "cm-diff-path", text: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "" }),
      h("div", { class: "spacer" }),
      h("button", { class: "btn btn-ghost btn-sm", title: "Open full diff view", onclick: () => { closeModal(modal); openDiff(repo, f); } }, h("span", { html: icon("external", 12) }), h("span", { text: "Open" }))));
    const loading = h("div", { class: "cm-diff-loading" }, h("span", { html: icon("spinner", 18, "spin") }), h("span", { text: "Loading diff…" }));
    rightPane.append(loading);
    let res;
    try { res = await atom.git.fileDiff(repo, f.path); }
    catch (e) { res = { text: "", error: e.message }; }
    if (activeFilePath !== f.path) return;   // user moved on to another file mid-load
    loading.remove();
    if (res.error || !res.text || !res.text.trim()) {
      rightPane.append(h("div", { class: "cm-diff-empty cm-diff-empty-small" }, h("span", { text: res.error || (f.label === "Untracked" ? "New file — no prior version to compare" : "No textual diff available") })));
      return;
    }
    const parsed = parseUnifiedDiff(res.text);
    const statRow = h("div", { class: "cm-diff-stat" },
      h("span", { class: "ds-add", text: `+${parsed.adds}` }),
      h("span", { class: "ds-del", text: `−${parsed.dels}` }),
      parsed.binary ? h("span", { class: "ds-bin", text: "binary" }) : null);
    rightPane.append(statRow);
    if (parsed.binary) return;
    const pre = h("pre", { class: "cm-diff-body" });
    const lines = res.text.split("\n");
    let html = "";
    for (const ln of lines) {
      let cls = "";
      if (ln.startsWith("@@")) cls = "diff-hunk";
      else if (ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff ") || ln.startsWith("index ")) cls = "diff-meta";
      else if (ln.startsWith("+")) cls = "diff-add";
      else if (ln.startsWith("-")) cls = "diff-del";
      html += `<span class="${cls}">${esc(ln)}</span>\n`;
    }
    pre.innerHTML = html;
    rightPane.append(pre);
  }

  async function doCommit() { await runCommitFromModal(false); }
  async function doCommitPush() { await runCommitFromModal(true); }
  async function runCommitFromModal(push) {
    state.git.message = msg.value;
    const message = (msg.value || "").trim();
    if (!message) { toast("Enter a commit message", "alert"); return; }
    // Build the per-repo plan from the current selection.
    const plan = [];
    for (const repo of repos) {
      const sel = repoFiles(repo).filter((f) => isSel(repo, f.path));
      if (sel.length) plan.push({ repo, files: sel.map((f) => f.path) });
    }
    if (!plan.length) { toast("Tick at least one file", "alert"); return; }
    // Close the review modal first so the progress modal isn't underneath it.
    closeModal(modal);
    await openCommitProgressModal(plan, message, push);
  }

  // Auto-focus the most recently changed file's diff for instant context.
  redraw();
  const first = repos[0] && repoFiles(repos[0]).filter((f) => isSel(repos[0], f.path))[0];
  if (first) showDiff(repos[0], first);
  setTimeout(() => msg.focus(), 60);
}

// Live progress modal — runs the commit pipeline (commit → optional push) against
// each project and renders a row per repo with the current phase, branch, file
// count, and a spinner / check / cross. Closes automatically when everything
// finishes successfully; otherwise leaves the modal open so the user can read the
// errors and retry.
//
// Phases are recorded PER ROW: `plan.committed` holds the created commit id, so a
// retry after "commit ok, push failed" resumes at the push of that exact commit —
// it never re-stages or re-commits (which could create a second, unintended commit).
async function openCommitProgressModal(plan, message, push) {
  const body = h("div", { class: "commit-progress" });
  const headLine = h("div", { class: "cp-headline" }, h("span", { class: "cp-spin", html: icon("spinner", 14, "spin") }), h("span", { text: push ? "Committing & pushing…" : "Committing…" }));
  const rowsHost = h("div", { class: "cp-rows" });
  body.append(headLine, rowsHost);

  // Pre-render one row per repo in pending state.
  const state2 = plan.map((p) => {
    const status = state.git.statuses[p.repo] || {};
    const r = { plan: p, branch: p.branch || status.branch || "(detached)", phase: "pending", message: "", ok: null, failedPhase: "" };
    r.dom = h("div", { class: "cp-row pending" },
      h("span", { class: "cp-row-ic", html: icon("dot", 14) }),
      h("div", { class: "cp-row-body" },
        h("div", { class: "cp-row-head" },
          h("span", { class: "cp-row-name", text: repoName(p.repo) }),
          h("span", { class: "cp-row-branch", html: icon("branch", 10) + ` <span>${esc(r.branch)}</span>` }),
          h("span", { class: "cp-row-count", text: p.committed ? `committed ${String(p.committed).slice(0, 7)}` : `${p.files.length} file${p.files.length === 1 ? "" : "s"}` })),
        h("div", { class: "cp-row-phase", text: "Waiting…" })));
    rowsHost.append(r.dom);
    return r;
  });

  const closeBtn = h("button", { class: "btn btn-ghost", text: "Hide", onclick: () => closeModal(modal) });
  const retryBtn = h("button", { class: "btn btn-primary", text: "Retry failed", onclick: () => {
    // Only re-run the rows that failed — and only their UNFINISHED phases (the plan
    // objects carry `committed`, so a push-only failure retries the push alone).
    closeModal(modal);
    const failed = state2.filter((r) => r.ok === false).map((r) => r.plan);
    if (failed.length) openCommitProgressModal(failed, message, push);
  } });
  retryBtn.style.display = "none";
  const footer = h("div", { class: "cp-foot" }, h("div", { class: "spacer" }), retryBtn, closeBtn);

  const modal = modalShell({ title: push ? "Commit & Push" : "Commit", ic: "commit", body, footer });

  function setPhase(r, phase, message, ok) {
    r.phase = phase; r.message = message || "";
    r.dom.className = "cp-row " + phase;
    const ic = r.dom.querySelector(".cp-row-ic");
    ic.innerHTML = phase === "doing" ? icon("spinner", 14, "spin")
                 : phase === "ok"     ? icon("check", 14)
                 : phase === "error"  ? icon("x", 14)
                 : icon("dot", 14);
    r.dom.querySelector(".cp-row-phase").textContent = message || "";
    if (ok === true || ok === false) r.ok = ok;
  }

  // Run sequentially so the user sees a clear order of operations.
  let okCount = 0, errCount = 0, committedNotPushed = 0;
  for (const r of state2) {
    const p = r.plan;
    try {
      if (!p.committed) {
        setPhase(r, "doing", `Committing ${p.files.length} file${p.files.length === 1 ? "" : "s"} on ${r.branch}…`);
        const res = await atom.git.commitFiles(p.repo, message, p.files);   // reviewed CommitPlan: exactly these files
        if (!res || res.committed === false) throw Object.assign(new Error((res && res.error) || "commit failed"), { phase: "commit" });
        p.committed = res.commit || "HEAD"; p.branch = res.branch || r.branch; r.branch = p.branch;
        if (res.state === "partial") toast(`<b>${esc(repoName(p.repo))}: committed, index not fully reconciled</b><span class="toast-sub">${esc(res.reconcileError || "")}</span>`, "alert", { ms: 7000 });
      }
      const short = String(p.committed).slice(0, 7);
      if (push) {
        // Resume/run the push of the RECORDED commit: the branch must still be the one it was made on.
        setPhase(r, "doing", `Pushing ${r.branch} (${short})…`);
        let cur = "";
        try { cur = await atom.git.branch(p.repo); } catch { /* checked by git below */ }
        if (cur && p.branch && cur !== p.branch) throw Object.assign(new Error(`branch changed since the commit (now on ${cur}) — push ${p.branch} from the Git Center`), { phase: "push" });
        const pushRes = await atom.git.push(p.repo).catch((e) => { throw Object.assign(new Error("push: " + e.message), { phase: "push" }); });
        if (pushRes && pushRes.state === "rejected") throw Object.assign(new Error(`push rejected by ${pushRes.remote || "the remote"} — pull first`), { phase: "push" });
        if (pushRes && pushRes.ok === false) throw Object.assign(new Error("push: " + (pushRes.error || pushRes.state)), { phase: "push" });
        p.pushed = true;
        const dest = pushRes && pushRes.remote && pushRes.dest ? `${pushRes.remote}/${pushRes.dest}` : (p.branch || r.branch);
        setPhase(r, "ok", pushRes && pushRes.upToDate ? `Committed ${short} · already up to date on ${dest}` : `Committed ${short} & pushed → ${dest}`, true);
      } else {
        setPhase(r, "ok", `Committed ${short} → ${p.branch || r.branch}`, true);
      }
      okCount++;
    } catch (e) {
      const phase = e.phase || (r.plan.committed ? "push" : "commit");
      r.failedPhase = phase;
      if (phase === "push") committedNotPushed++;
      setPhase(r, "error", phase === "push" ? `Committed ${String(r.plan.committed).slice(0, 7)} — push failed: ${e.message || e}` : `Commit failed: ${e.message || e}`, false);
      errCount++;
    }
  }

  // Final headline + auto-dismiss on clean run. Partial success is stated as such.
  const headIc = headLine.querySelector(".cp-spin");
  if (errCount === 0) {
    headIc.innerHTML = icon("check", 14);
    headLine.querySelector("span:last-child").textContent = `Done · ${okCount} project${okCount === 1 ? "" : "s"} ${push ? "committed & pushed" : "committed"}`;
    headLine.classList.add("ok");
    setTimeout(() => { closeModal(modal); refreshGit(); refreshTree(true); }, 1100);
  } else {
    headIc.innerHTML = icon("alert", 14);
    headLine.querySelector("span:last-child").textContent = `${okCount} done · ${errCount} failed${committedNotPushed ? ` (${committedNotPushed} committed but not pushed — Retry pushes only)` : ""}`;
    headLine.classList.add("error");
    retryBtn.style.display = "";
    retryBtn.textContent = committedNotPushed && committedNotPushed === errCount ? "Retry push" : "Retry failed";
    closeBtn.textContent = "Close";
    refreshGit();
  }
}

async function commitSelected(push) {
  const message = (state.git.message || "").trim();
  if (!message) { toast("Enter a commit message first", "alert"); return; }
  let groups = selectionByRepo();
  if (!groups.length) {
    const dirty = (state.git.repos || []).filter((r) => { const s = state.git.statuses[r]; return s && s.files && s.files.length; });
    if (dirty.length === 1) groups = [{ repo: dirty[0], files: repoFiles(dirty[0]).map((f) => f.path) }];
    else { toast("Tick the files (or a folder) you want to commit", "alert"); return; }
  }
  // EVERY repository's result is kept for the summary — a later success never hides an
  // earlier failure. Commits go through the reviewed CommitPlan (exactly these files).
  const results = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    toast(`Committing ${esc(repoName(g.repo))}…  (${i + 1}/${groups.length})`, "commit", { sticky: true, spin: true });
    try { const r = await atom.git.commitFiles(g.repo, message, g.files); results.push(r && r.committed === false ? { repo: g.repo, ok: false, error: r.error || "commit failed" } : { repo: g.repo, ok: true, branch: r.branch, commit: r.commit, partial: r.state === "partial" }); }
    catch (e) { results.push({ repo: g.repo, ok: false, error: e.message }); }
  }
  const committed = results.filter((r) => r.ok);
  if (!committed.length) { summaryToast("Committed", results); await refreshGit(); return; }
  if (push) {
    const pushed = await pushReposList(committed.map((c) => c.repo), { verb: "Committed & pushed" });
    const failedCommits = results.filter((r) => !r.ok);
    if (failedCommits.length) toast(`<b>${failedCommits.length} commit${failedCommits.length === 1 ? "" : "s"} failed</b><span class="toast-sub">${failedCommits.map((r) => esc(repoName(r.repo)) + ": " + esc(r.error)).join("<br>")}${pushed.some((p) => p.ok) ? "<br>(other repositories were committed and pushed)" : ""}</span>`, "alert", { ms: 8000 });
  } else summaryToast("Committed", results);
  // The commit message is kept until you change it (per request).
  await refreshGit(); refreshTree(true);
}

function gitFileRow(repo, f) {
  const statClass = f.conflict ? "conflict" : (f.label === "Untracked" ? "untracked" : (f.staged ? "staged" : "unstaged"));
  const ext = (f.path.split(".").pop() || "").toLowerCase();
  const cb = h("input", { type: "checkbox", class: "aqx-check" });
  // Checkbox = SELECTION (for the next commit), not an immediate stage. Staging
  // happens when Commit / Commit & Push runs.
  cb.checked = isSel(repo, f.path);
  cb.addEventListener("click", (ev) => { ev.stopPropagation(); setSel(repo, f.path, cb.checked); afterGitSelectionChange(); });
  const slash = f.path.lastIndexOf("/");
  const dir = slash >= 0 ? f.path.slice(0, slash) : "";
  return h("div", { class: "gv-file" + (isSel(repo, f.path) ? " sel" : "") + (f.conflict ? " conflict" : ""), title: (f.conflict ? "Resolve conflicts · " : "View diff · ") + f.path, onclick: () => f.conflict ? openConflictResolver(repo, f.path) : openDiff(repo, f), oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); gitFileMenu(e, repo, f); } },
    cb,
    (function(){const m=fileMeta(baseName(f.path));return h("span",{class:"gvf-ico "+m.cls,html:icon(m.ic,14)});})(),
    h("span", { class: "gvf-name", text: baseName(f.path) }),
    h("span", { class: "gvf-path", text: dir }),
    h("span", { class: "gvf-stat " + statClass, text: f.label }));
}

/* ---- commit-view right-click actions (stage / unstage / discard / rollback) ----
   The checkbox is SELECTION; these menu actions touch the git index/working tree
   directly (real stage/unstage), and "Discard" rolls a file back to HEAD. */
async function gitStageFiles(repo, paths) {
  const list = [].concat(paths).filter(Boolean);
  if (!list.length) return;
  try { await atom.git.stage(repo, list); await refreshGit(); }
  catch (e) { toast("Stage failed: " + esc(e.message), "alert", { ms: 5000 }); }
}
async function gitUnstageFiles(repo, paths) {
  const list = [].concat(paths).filter(Boolean);
  if (!list.length) return;
  try { await atom.git.unstage(repo, list); await refreshGit(); }
  catch (e) { toast("Unstage failed: " + esc(e.message), "alert", { ms: 5000 }); }
}
async function gitStageAllRepo(repo) {
  try { await atom.git.stageAll(repo); await refreshGit(); }
  catch (e) { toast("Stage failed: " + esc(e.message), "alert", { ms: 5000 }); }
}
async function gitUnstageAllRepo(repo) {
  try { await atom.git.unstageAll(repo); await refreshGit(); }
  catch (e) { toast("Unstage failed: " + esc(e.message), "alert", { ms: 5000 }); }
}
// Discard (rollback) — destructive, so confirm first. Drops selection for the
// reverted files and refreshes both the commit view and the file tree.
function gitDiscardFiles(repo, paths, what) {
  const list = [].concat(paths).filter(Boolean);
  if (!list.length) return;
  const label = what || (list.length === 1 ? baseName(list[0]) : `${list.length} files`);
  confirmDialog({
    title: "Discard changes?", ic: "alert", danger: true, confirmLabel: "Discard changes",
    message: `This reverts ${label} to the last committed state and deletes any untracked content. This can’t be undone.`,
    onConfirm: async () => {
      try {
        // Per-path phase outcomes: a failed prerequisite stops that path; partial work is
        // reported as partial, never as complete success.
        const r = await atom.git.discard(repo, list);
        const failed = (r && r.results || []).filter((x) => !x.ok);
        for (const p of list) if (!failed.some((x) => x.path === p)) setSel(repo, p, false);
        if (r && r.ok) toast(`Discarded changes in ${esc(label)}`, "undo", { ms: 3000 });
        else toast(`<b>Discard ${r && r.state === "partial" ? "partly done" : "failed"}</b><span class="toast-sub">${failed.map((x) => `${esc(x.path)} (${esc(x.phase || "")}): ${esc(x.error || "failed")}`).join("<br>") || esc((r && r.error) || "")}</span>`, "alert", { ms: 8000 });
        await refreshGit(); refreshTree(true);
      } catch (e) { toast("Discard failed: " + esc(e.message), "alert", { ms: 6000 }); }
    },
  });
}

// Right-click menu for a single changed file in the commit view.
function gitFileMenu(ev, repo, f) {
  const abs = repo.replace(/[\\/]+$/, "") + "/" + f.path;
  const selected = isSel(repo, f.path);
  const untracked = f.label === "Untracked";
  const items = [];
  if (f.conflict) items.push({ label: "Resolve conflicts", icon: "git", onClick: () => openConflictResolver(repo, f.path) });
  else items.push({ label: "View diff", icon: "eye", onClick: () => openDiff(repo, f) });
  items.push({ label: "Open file", icon: "external", onClick: () => openInEditor(abs) });
  items.push({ sep: true });
  items.push({ label: selected ? "Deselect for commit" : "Select for commit", icon: selected ? "minus" : "check", onClick: () => { setSel(repo, f.path, !selected); afterGitSelectionChange(); } });
  if (f.unstaged || untracked) items.push({ label: "Stage", icon: "plus", onClick: () => gitStageFiles(repo, [f.path]) });
  if (f.staged) items.push({ label: "Unstage", icon: "minus", onClick: () => gitUnstageFiles(repo, [f.path]) });
  items.push({ sep: true });
  items.push({ label: "Copy path", icon: "copy", onClick: () => copyText(f.path, "Copied relative path") });
  items.push({ label: "Copy full path", icon: "copy", onClick: () => copyText('"' + abs + '"', "Copied full path") });
  items.push({ label: "Reveal in Explorer", icon: "folderOpen", onClick: () => atom.files.reveal(abs) });
  items.push({ sep: true });
  items.push({ label: untracked ? "Delete file" : "Discard changes", icon: untracked ? "trash" : "undo", danger: true, onClick: () => gitDiscardFiles(repo, [f.path], baseName(f.path)) });
  showContextMenu(ev.clientX, ev.clientY, items);
}

// Right-click menu for a project group header in the commit view.
function gitRepoMenu(ev, repo, tracked, untracked) {
  const s = state.git.statuses[repo] || {};
  const allPaths = (s.files || []).map((f) => f.path);
  const trackedList = tracked || [];
  const hasStaged = (s.files || []).some((f) => f.staged);
  const items = [
    { label: "Stage all changes", icon: "plus", onClick: () => gitStageAllRepo(repo) },
  ];
  if (hasStaged) items.push({ label: "Unstage all", icon: "minus", onClick: () => gitUnstageAllRepo(repo) });
  items.push(
    { sep: true },
    { label: "Select all for commit", icon: "check", onClick: () => setRepoSelection(repo, trackedList, true) },
    { label: "Clear selection", icon: "x", onClick: () => setRepoSelection(repo, trackedList, false) },
    { sep: true },
    { label: "Branches…", icon: "branch", onClick: () => openBranchMenu(repo, ev) },
    { label: "Compare & merge…", icon: "gitCompare", onClick: () => openCompare(repo) },
    { sep: true },
    { label: "Pull", icon: "pull", onClick: () => gitPull(repo) },
  );
  if (gitPushable(repo)) items.push({ label: "Push", icon: "push", onClick: () => pushRepo(repo).then(() => refreshGit()) });
  items.push(
    { sep: true },
    { label: "Reveal in Explorer", icon: "folderOpen", onClick: () => atom.files.reveal(repo) },
    { label: "Refresh", icon: "refresh", onClick: () => refreshGit() },
  );
  if (allPaths.length) items.push({ sep: true }, { label: "Discard all changes", icon: "undo", danger: true, onClick: () => gitDiscardFiles(repo, allPaths, `all changes in ${repoName(repo)}`) });
  showContextMenu(ev.clientX, ev.clientY, items);
}

// Build the persistent commit-view shell once (so the message box keeps focus +
// text across status refreshes); only the file list is re-rendered on refresh.
function buildGitShell() {
  const view = h("div", { class: "git-view" });
  view.append(h("div", { class: "gv-head" },
    h("div", { class: "gv-head-actions" },
      h("button", { id: "gvBranch", class: "gv-iconbtn", title: "Branches", html: icon("branch", 15), onclick: (e) => openBranchFlow(e) }),
      h("button", { id: "gvCompare", class: "gv-iconbtn", title: "Compare & merge branches", html: icon("gitCompare", 15), onclick: (e) => openCompareFlow(e) }),
      h("button", { id: "gvPull", class: "gv-iconbtn", title: "Pull all projects", html: icon("pull", 15), onclick: () => pullAll() }),
      h("button", { class: "gv-iconbtn", title: "Refresh", html: icon("refresh", 15), onclick: () => refreshGit() })),
    h("div", { class: "gv-branch" }, h("span", { html: icon("git", 15) }), h("span", { class: "gvb-name", text: "Commit" }), h("span", { class: "gvh-count gv-track" }))));
  const msg = h("textarea", { id: "gvMessage", placeholder: "Commit message", spellcheck: "false" });
  msg.value = state.git.message || "";
  msg.addEventListener("input", () => { state.git.message = msg.value; });
  view.append(h("div", { class: "gv-msg" }, msg));
  view.append(h("div", { class: "gv-actions" },
    h("button", { id: "gvCommit", class: "btn btn-primary", text: "Commit…", onclick: () => openCommitModal(false) }),
    h("button", { id: "gvCommitPush", class: "btn btn-ghost", text: "Commit & Push…", onclick: () => openCommitModal(true) })));
  view.append(h("div", { class: "gv-list" }));
  return view;
}

function renderGitView() {
  const host = $("fileTree");
  if (!host) return;
  let view = host.querySelector(".git-view");
  if (!view) { host.innerHTML = ""; view = buildGitShell(); host.append(view); }
  const total = gitTotalChanges();
  const repos = state.git.repos || [];
  const cnt = view.querySelector(".gvh-count");
  if (cnt) cnt.textContent = total ? `${total} change${total > 1 ? "s" : ""}` : (repos.length ? "clean" : "");
  // Header shows the current branch (when all repos share one); else "Commit"
  // and each accordion shows its own branch.
  const nameEl = view.querySelector(".gvb-name");
  if (nameEl) {
    const branches = [...new Set(repos.map((r) => gitBranchOf(r)).filter(Boolean))];
    nameEl.textContent = branches.length === 1 ? branches[0] : "Commit";
    nameEl.title = branches.length === 1 ? "Current branch: " + branches[0] : "";
  }
  // Commit buttons reflect how many files are selected for the next commit.
  const sel = totalSelected();
  const cBtn = view.querySelector("#gvCommit"); if (cBtn) cBtn.textContent = sel ? `Commit (${sel})` : "Commit";
  const cpBtn = view.querySelector("#gvCommitPush"); if (cpBtn) cpBtn.textContent = sel ? `Commit & Push (${sel})` : "Commit & Push";
  const pullBtn = view.querySelector("#gvPull");
  const behind = repos.filter((r) => { const s = state.git.statuses[r]; return s && s.behind; }).length;
  if (pullBtn) pullBtn.classList.toggle("hot", behind > 0);
  renderGitGroups(view.querySelector(".gv-list"));
}

// One group per repo (project folder): a folder checkbox/Stage all/Unstage row,
// then its tracked changes, then a separate Untracked subsection.
function renderGitGroups(list) {
  if (!list) return;
  list.innerHTML = "";
  const repos = state.git.repos || [];
  if (!repos.length) { list.append(h("div", { class: "gv-empty" }, h("span", { html: icon("branch", 32) }), "No Git repository in this folder or its subfolders.")); return; }
  // ---- Merge-in-progress banner: any repo with conflicts gets a clear call to resolve ----
  for (const repo of repos) {
    const conflicts = conflictedFiles(repo);
    if (!conflicts.length) continue;
    list.append(h("div", { class: "gv-merge-banner" },
      h("div", { class: "gmb-head" },
        h("span", { class: "gmb-ic", html: icon("alert", 16) }),
        h("div", { class: "gmb-head-text" },
          h("span", { class: "gmb-title", text: "Merge in progress" }),
          h("span", { class: "gmb-repo", text: repoName(repo) }))),
      h("div", { class: "gmb-sub" },
        h("b", { text: `${conflicts.length} conflicted file${conflicts.length === 1 ? "" : "s"}` }),
        " — resolve them, then complete the merge."),
      h("div", { class: "gmb-actions" },
        h("button", { class: "gmb-btn primary", onclick: () => openConflictResolver(repo) },
          h("span", { class: "gmb-btn-ic", html: icon("git", 14) }), "Resolve conflicts"),
        h("button", { class: "gmb-btn", onclick: () => gitMergeAbort(repo) }, "Abort"))));
  }
  let anyTracked = false;
  const untrackedByRepo = [];   // [{ repo, files }] — gathered for the separate accordion
  // ---- Tracked changes: one accordion per project folder (untracked excluded) ----
  for (const repo of repos) {
    const s = state.git.statuses[repo];
    if (!s || !s.repo || !s.files) continue;
    // Status could not be read: say so (with the error and a retry) instead of showing "clean".
    if (s.state === "error") list.append(h("div", { class: "gv-merge-banner gv-status-error" },
      h("div", { class: "gmb-head" }, h("span", { class: "gmb-ic", html: icon("alert", 16) }), h("div", { class: "gmb-head-text" }, h("span", { class: "gmb-title", text: s.stale ? "Showing the last known state" : "Repository state unavailable" }), h("span", { class: "gmb-repo", text: repoName(repo) }))),
      h("div", { class: "gmb-sub" }, h("span", { text: s.error || "git status failed" })),
      h("div", { class: "gmb-actions" }, h("button", { class: "gmb-btn primary", onclick: () => refreshGit() }, "Retry"))));
    const tracked = s.files.filter((f) => f.label !== "Untracked");
    const untracked = s.files.filter((f) => f.label === "Untracked");
    if (untracked.length) untrackedByRepo.push({ repo, files: untracked });
    if (!tracked.length) continue;
    anyTracked = true;
    const allSel = tracked.every((f) => isSel(repo, f.path));
    const someSel = tracked.some((f) => isSel(repo, f.path));
    const open = state.git.expanded.has(repo);   // collapsed by default
    const folderCb = h("input", { type: "checkbox", class: "aqx-check" });
    folderCb.checked = allSel; folderCb.indeterminate = someSel && !allSel;
    // Folder checkbox SELECTS/deselects this folder's tracked changes for commit.
    folderCb.addEventListener("click", (ev) => { ev.stopPropagation(); setRepoSelection(repo, tracked, folderCb.checked); });
    const rowKids = [
      h("span", { class: "gvr-chev", html: icon("chevron", 13) }),
      folderCb,
      h("span", { class: "gvf-ico", html: icon("branch", 14) }),
      h("span", { class: "gvr-name", text: repoName(repo) }),
      h("button", { class: "gvr-branch", title: "Branches & merge — " + (s.branch || ""), onclick: (e) => { e.stopPropagation(); openBranchMenu(repo, e); } },
        h("span", { class: "gvrb-ico", html: icon("branch", 11) }),
        h("span", { text: (s.branch || "") + (s.ahead ? ` ↑${s.ahead}` : "") + (s.behind ? ` ↓${s.behind}` : "") })),
      h("span", { class: "gvr-count", text: String(tracked.length) }),
      h("button", { class: "gvr-act", title: "Select all tracked changes in this folder", onclick: (e) => { e.stopPropagation(); setRepoSelection(repo, tracked, true); } }, "Select all"),
      h("button", { class: "gvr-act", title: "Clear this folder's selection", onclick: (e) => { e.stopPropagation(); setRepoSelection(repo, tracked, false); } }, "Clear"),
    ];
    // Per-project Push button when this folder has unpushed commits (spins while pushing).
    const busy = state.git.pushing.has(repo);
    if (gitPushable(repo) || busy) rowKids.push(h("button", { class: "gvr-push" + (busy ? " busy" : ""), disabled: busy, title: busy ? "Pushing " + repoName(repo) + "…" : "Push " + repoName(repo) + (s.branch ? " · " + s.branch : ""), html: icon(busy ? "spinner" : "push", 13, busy ? "spin" : ""), onclick: (e) => { e.stopPropagation(); if (!busy) pushRepo(repo).then(() => refreshGit()); } }));
    list.append(h("div", { class: "gv-repo" + (open ? " open" : ""), title: repo, onclick: () => toggleGitRepo(repo), oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); gitRepoMenu(e, repo, tracked, untracked); } }, ...rowKids));
    if (open) for (const f of tracked) list.append(gitFileRow(repo, f));
  }

  // ---- Untracked files: one top-level accordion, grouped by project. Tick them
  // to include them in the commit — they are staged automatically at commit time. ----
  const totalUntracked = untrackedByRepo.reduce((n, g) => n + g.files.length, 0);
  if (totalUntracked) {
    const open = state.git.expanded.has("__untracked__");
    const allU = untrackedByRepo.flatMap((g) => g.files.map((f) => ({ repo: g.repo, path: f.path })));
    const allUSel = allU.every((u) => isSel(u.repo, u.path));
    const someUSel = allU.some((u) => isSel(u.repo, u.path));
    const uCb = h("input", { type: "checkbox", class: "aqx-check" });
    uCb.checked = allUSel; uCb.indeterminate = someUSel && !allUSel;
    uCb.addEventListener("click", (ev) => { ev.stopPropagation(); for (const u of allU) setSel(u.repo, u.path, uCb.checked); afterGitSelectionChange(); });
    list.append(h("div", { class: "gv-repo gv-untracked" + (open ? " open" : ""), title: "Untracked files — tick to include them in the commit", onclick: () => toggleGitRepo("__untracked__") },
      h("span", { class: "gvr-chev", html: icon("chevron", 13) }),
      uCb,
      h("span", { class: "gvf-ico", html: icon("folderPlus", 14) }),
      h("span", { class: "gvr-name", text: "Untracked files" }),
      h("span", { class: "gvr-branch", text: "" }),
      h("span", { class: "gvr-count", text: String(totalUntracked) }),
      h("button", { class: "gvr-act", title: "Select all untracked files", onclick: (e) => { e.stopPropagation(); for (const u of allU) setSel(u.repo, u.path, true); afterGitSelectionChange(); } }, "Select all")));
    if (open) {
      for (const { repo, files } of untrackedByRepo) {
        list.append(h("div", { class: "gv-subsection" },
          h("span", { class: "gvf-ico", html: icon("branch", 12) }),
          h("span", { text: repoName(repo) }),
          h("span", { class: "gvs-count", text: String(files.length) }),
          h("span", { class: "gvs-act", onclick: (e) => { e.stopPropagation(); setRepoSelection(repo, files, true); } }, "Select all")));
        for (const f of files) list.append(gitFileRow(repo, f));
      }
    }
  }

  if (!anyTracked && !totalUntracked) list.append(h("div", { class: "gv-empty" }, h("span", { html: icon("check", 32) }), "Nothing to commit — all folders clean."));
}

// Expand/collapse a repo's accordion in the commit view.
function toggleGitRepo(repo) {
  if (state.git.expanded.has(repo)) state.git.expanded.delete(repo);
  else state.git.expanded.add(repo);
  renderGitView();
}

/* ============================================================
   GIT DIFF VIEWER — a polished overlay with split / unified views,
   word-level highlights, ± stats and prev/next file navigation.
   ============================================================ */
let gDiffView = (() => { try { return localStorage.getItem("aqx.diffView") || "split"; } catch { return "split"; } })();
const _diffNav = { files: [], index: 0, parsed: null, repo: "", file: null };
let _diffKeyHandler = null;

function diffNavList() {
  const files = [];
  for (const repo of state.git.repos || []) {
    const s = state.git.statuses[repo];
    if (s && s.files) for (const f of s.files) files.push({ repo, path: f.path, label: f.label });
  }
  return files;
}

// Open the diff overlay for a changed file. Builds the prev/next list from every
// changed file across all projects so you can flip through a review in place.
function openDiff(repo, fileObj) {
  _diffNav.files = diffNavList();
  _diffNav.index = _diffNav.files.findIndex((x) => x.repo === repo && x.path === fileObj.path);
  if (_diffNav.index < 0) { _diffNav.files = [{ repo, path: fileObj.path, label: fileObj.label }]; _diffNav.index = 0; }
  bindDiffKeys();
  showDiffFor(repo, fileObj);
}

function navDiff(delta) {
  if (_diffNav.files.length < 2) return;
  _diffNav.index = (_diffNav.index + delta + _diffNav.files.length) % _diffNav.files.length;
  const n = _diffNav.files[_diffNav.index];
  showDiffFor(n.repo, n);
}

function setDiffView(v) {
  gDiffView = v === "unified" ? "unified" : "split";
  try { localStorage.setItem("aqx.diffView", gDiffView); } catch { /* ignore */ }
  const back = document.querySelector(".diff-overlay");
  if (!back) return;
  updateDiffSeg(back);
  if (_diffNav.parsed) {
    const body = back.querySelector(".diff-body");
    body.innerHTML = "";
    body.append(renderDiffContent(_diffNav.parsed));
  }
}

function bindDiffKeys() {
  if (_diffKeyHandler) return;
  _diffKeyHandler = (e) => {
    if (!document.querySelector(".diff-overlay")) return;
    if (e.key === "Escape") { e.preventDefault(); closeDiff(); }
    else if (e.key === "]" || (e.key === "ArrowDown" && e.altKey)) { e.preventDefault(); navDiff(1); }
    else if (e.key === "[" || (e.key === "ArrowUp" && e.altKey)) { e.preventDefault(); navDiff(-1); }
    else if (e.key === "u") { e.preventDefault(); setDiffView("unified"); }
    else if (e.key === "s") { e.preventDefault(); setDiffView("split"); }
  };
  document.addEventListener("keydown", _diffKeyHandler, true);
}

function closeDiff() {
  const b = document.querySelector(".diff-overlay");
  if (b) b.remove();
  if (_diffKeyHandler) { document.removeEventListener("keydown", _diffKeyHandler, true); _diffKeyHandler = null; }
}

function ensureDiffOverlay() {
  let back = document.querySelector(".diff-overlay");
  if (back) return back;
  back = h("div", { class: "diff-overlay", onmousedown: (e) => { if (e.target === back) closeDiff(); } });
  const panel = h("div", { class: "diff-panel" },
    h("div", { class: "diff-head" },
      h("span", { class: "dfh-ico" }),
      h("div", { class: "dfh-title" }, h("span", { class: "dfh-name" }), h("span", { class: "dfh-path" })),
      h("span", { class: "dfh-stat" }),
      h("div", { class: "dfh-spacer" }),
      h("span", { class: "dfh-count" }),
      h("div", { class: "dfh-seg" },
        h("button", { class: "dfh-seg-btn", dataset: { view: "split" }, text: "Split", onclick: () => setDiffView("split") }),
        h("button", { class: "dfh-seg-btn", dataset: { view: "unified" }, text: "Unified", onclick: () => setDiffView("unified") })),
      h("button", { class: "dfh-btn", title: "Previous file  [", html: icon("chevron", 16, "flip"), onclick: () => navDiff(-1) }),
      h("button", { class: "dfh-btn", title: "Next file  ]", html: icon("chevron", 16), onclick: () => navDiff(1) }),
      h("button", { class: "dfh-btn", title: "Open file in editor", html: icon("external", 15), onclick: () => { const n = _diffNav.files[_diffNav.index]; closeDiff(); if (n) openInEditor(n.repo.replace(/[\\/]+$/, "") + "/" + n.path); } }),
      h("button", { class: "dfh-btn close", title: "Close  Esc", html: icon("close", 16), onclick: () => closeDiff() })),
    h("div", { class: "diff-body" }));
  back.append(panel);
  $("modalRoot").append(back);
  return back;
}

function updateDiffSeg(back) {
  for (const b of back.querySelectorAll(".dfh-seg-btn")) b.classList.toggle("active", b.dataset.view === gDiffView);
}

async function showDiffFor(repo, fileObj) {
  const back = ensureDiffOverlay();
  _diffNav.repo = repo; _diffNav.file = fileObj;
  const body = back.querySelector(".diff-body");
  body.innerHTML = "";
  body.append(h("div", { class: "diff-loading" }, h("span", { html: icon("spinner", 22, "spin") }), h("span", { text: "Loading diff…" })));
  // header
  const ext = (fileObj.path.split(".").pop() || "").toLowerCase();
  (function(){const m=fileMeta(baseName(fileObj.path||fileObj));const el=back.querySelector(".dfh-ico");el.innerHTML=icon(m.ic,17);el.className="dfh-ico "+m.cls;})();
  back.querySelector(".dfh-name").textContent = baseName(fileObj.path);
  const slash = fileObj.path.lastIndexOf("/");
  back.querySelector(".dfh-path").textContent = (slash >= 0 ? fileObj.path.slice(0, slash) + "/ · " : "") + repoName(repo);
  const cnt = back.querySelector(".dfh-count");
  cnt.textContent = _diffNav.files.length > 1 ? `${_diffNav.index + 1} / ${_diffNav.files.length}` : "";
  updateDiffSeg(back);

  let res;
  try { res = await atom.git.fileDiff(repo, fileObj.path); } catch (e) { res = { text: "", error: e.message }; }
  if (back !== document.querySelector(".diff-overlay")) return;   // closed/navigated away
  const parsed = parseUnifiedDiff(res.text || "");
  _diffNav.parsed = parsed;
  back.querySelector(".dfh-stat").innerHTML = parsed.binary
    ? `<span class="ds-bin">binary</span>`
    : `<span class="ds-add">+${parsed.adds}</span><span class="ds-del">−${parsed.dels}</span>`;
  body.innerHTML = "";
  if (res.error) { body.append(diffEmpty("alert", "Couldn’t load diff", res.error)); return; }
  if (parsed.binary) { body.append(diffEmpty("eye", "Binary file", "No text diff to show.")); return; }
  if (!parsed.hunks.length) {
    body.append(diffEmpty("check", fileObj.label === "Untracked" ? "New file" : "No changes",
      fileObj.label === "Untracked" ? "Open it to view its contents." : "This file matches HEAD."));
    return;
  }
  body.append(renderDiffContent(parsed));
}

function diffEmpty(ic, title, sub) {
  return h("div", { class: "diff-empty" },
    h("span", { class: "de-ic", html: icon(ic, 34) }),
    h("div", { class: "de-title", text: title }),
    sub ? h("div", { class: "de-sub", text: sub }) : null);
}

function diffCode(parts, text) {
  const el = h("span", { class: "dl-code" });
  if (parts) { for (const p of parts) el.append(p.ch ? h("span", { class: "wd", text: p.t }) : document.createTextNode(p.t)); }
  else el.append(document.createTextNode(text != null ? text : ""));
  return el;
}

function unifiedRow(r) {
  const cls = r.kind === "add" ? "add" : r.kind === "del" ? "del" : "ctx";
  return h("div", { class: "dl " + cls },
    h("span", { class: "dl-no", text: r.oldNo != null ? String(r.oldNo) : "" }),
    h("span", { class: "dl-no", text: r.newNo != null ? String(r.newNo) : "" }),
    h("span", { class: "dl-gut", text: r.kind === "add" ? "+" : r.kind === "del" ? "−" : "" }),
    diffCode(r.parts, r.text));
}

function splitCell(no, parts, text, cls) {
  return h("div", { class: "dsc " + cls },
    h("span", { class: "dl-no", text: no != null ? String(no) : "" }),
    diffCode(parts, text));
}

function splitRow(r) {
  let left, right;
  if (r.kind === "ctx") { left = splitCell(r.old.no, null, r.old.text, "ctx"); right = splitCell(r.new.no, null, r.new.text, "ctx"); }
  else if (r.kind === "mod") { left = splitCell(r.old.no, r.old.parts, null, "del"); right = splitCell(r.new.no, r.new.parts, null, "add"); }
  else if (r.kind === "del") { left = splitCell(r.old.no, null, r.old.text, "del"); right = splitCell(null, null, "", "empty"); }
  else { left = splitCell(null, null, "", "empty"); right = splitCell(r.new.no, null, r.new.text, "add"); }
  return h("div", { class: "dsr" }, left, right);
}

function renderDiffContent(parsed) {
  const wrap = h("div", { class: "diff-content " + (gDiffView === "split" ? "is-split" : "is-unified") });
  for (const hunk of parsed.hunks) {
    wrap.append(h("div", { class: "diff-hunkhdr", text: hunk.header }));
    const { unified, split } = processHunk(hunk.lines);
    if (gDiffView === "split") for (const r of split) wrap.append(splitRow(r));
    else for (const r of unified) wrap.append(unifiedRow(r));
  }
  return wrap;
}

/* ============================================================
   GIT BRANCHES + MERGE
   ============================================================ */
async function openBranchMenu(repo, ev) {
  let info;
  try { info = await atom.git.branches(repo); } catch (e) { toast("Couldn’t list branches: " + e.message, "alert"); return; }
  const others = info.locals.filter((b) => b !== info.current);
  const items = [{ label: info.current + "  (current)", icon: "check", onClick: () => {} }];
  if (others.length) {
    items.push({ sep: true });
    for (const b of others) items.push({ label: "Switch to " + b, icon: "branch", onClick: () => gitCheckout(repo, b) });
  }
  items.push({ sep: true }, { label: "New branch…", icon: "plus", onClick: () => promptNewBranch(repo) });
  // Merging lives in the compare view now (pick source + target, review, then merge).
  if (others.length || info.remotes.length) items.push({ label: "Compare & merge…", icon: "gitCompare", onClick: () => openCompare(repo) });
  if (info.merging) items.push({ sep: true }, { label: "Abort merge", icon: "x", danger: true, onClick: () => gitMergeAbort(repo) });
  showMenuAt(ev, items);
}

// Open a context menu anchored to an element (event.currentTarget) or a point.
function showMenuAt(ev, items) {
  let x = 0, y = 0;
  const t = ev && ev.currentTarget;
  if (t && t.getBoundingClientRect) { const r = t.getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
  else if (ev) { x = ev.clientX || 0; y = (ev.clientY || 0) + 4; }
  showContextMenu(x, y, items);
}

async function gitCheckout(repo, branch) {
  toast(`Switching ${esc(repoName(repo))} → ${esc(branch)}…`, "branch", { sticky: true, spin: true });
  try {
    const r = await atom.git.checkout(repo, branch);
    state.git.selected.clear();
    toast(`Switched ${esc(repoName(repo))} to ${esc(r.branch)}`, "checkCircle", { ms: 3000 });
    await refreshGit(); refreshTree(true);
  } catch (e) { toast(`Checkout failed (${esc(repoName(repo))}): ${esc(e.message)}`, "alert", { ms: 6000 }); }
}

async function gitMerge(repo, branch) {
  toast(`Merging ${esc(branch)} → ${esc(repoName(repo))}…`, "git", { sticky: true, spin: true });
  try {
    const r = await atom.git.merge(repo, branch);
    if (r.ok) {
      const how = r.upToDate ? "already up to date" : (r.fastForward ? "fast-forward" : "merged");
      toast(`Merged ${esc(branch)} → ${esc(r.into)} (${how})`, "checkCircle", { ms: 4200 });
    } else if (r.conflict) {
      if (state.sidebarView !== "git") setSidebarView("git");
      toast(`<b>Merge conflicts in ${esc(repoName(repo))}</b><span class="toast-sub">Resolve the conflicted files, then commit — or abort from the branch menu.</span>`, "alert", { ms: 7000 });
    }
    await refreshGit(); refreshTree(true);
  } catch (e) { toast(`Merge failed (${esc(repoName(repo))}): ${esc(e.message)}`, "alert", { ms: 6000 }); }
}

// Abort whatever operation is in progress (merge / rebase / cherry-pick / revert / bisect —
// main dispatches to the matching git command from the repo's actual state).
async function gitMergeAbort(repo) {
  try { const r = await atom.git.mergeAbort(repo); toast(`Aborted ${esc(r && r.op || "merge")} in ${esc(repoName(repo))}`, "checkCircle", { ms: 3000 }); await refreshGit(); refreshTree(true); }
  catch (e) { toast(`Abort failed (${esc(repoName(repo))}): ${esc(e.message)}`, "alert", { ms: 5000 }); }
}

// Branch entry from the git-view header: 1 repo → its branch menu; many → pick a
// project first.
function openBranchFlow(ev) {
  const repos = state.git.repos || [];
  if (!repos.length) return;
  if (repos.length === 1) return openBranchMenu(repos[0], ev);
  showMenuAt(ev, repos.map((r) => ({ label: repoName(r) + "  —  " + (gitBranchOf(r) || "?"), icon: "branch", onClick: (e) => openBranchMenu(r, ev) })));
}

function promptNewBranch(repo) {
  promptDialog({
    title: "New branch", ic: "branch", placeholder: "feature/my-branch", confirmLabel: "Create & switch",
    onConfirm: (name) => { name = (name || "").trim(); if (!name) return; gitCheckoutNew(repo, name); },
  });
}
async function gitCheckoutNew(repo, name) {
  toast(`Creating ${esc(name)}…`, "branch", { sticky: true, spin: true });
  try { const r = await atom.git.checkout(repo, name, { create: true }); toast(`Created & switched to ${esc(r.branch)}`, "checkCircle", { ms: 3200 }); await refreshGit(); refreshTree(true); }
  catch (e) { toast(`Create branch failed: ${esc(e.message)}`, "alert", { ms: 6000 }); }
}

/* ============================================================
   COMPARE BRANCHES — review what a SOURCE branch adds over a
   TARGET branch (file list + per-file diff), then merge source
   into target (a local "merge request" review-then-merge flow).
   Defaults: source = current branch, target = main.
   ============================================================ */
const _cmp = { repo: "", source: "", target: "", files: [], index: -1, branches: null };

function shortRef(r) { return (r || "").replace(/^origin\//, ""); }

// Pick a sensible default target: prefer main/master, else the first branch
// that isn't the source.
function defaultTarget(info, source) {
  const all = [...info.locals, ...info.remotes];
  for (const pref of ["main", "master"]) if (info.locals.includes(pref) && pref !== source) return pref;
  return all.find((b) => b !== source) || source;
}

// Entry from the git-view header: one repo → compare it; many → pick a project.
function openCompareFlow(ev) {
  const repos = state.git.repos || [];
  if (!repos.length) { toast("No Git repository here", "alert"); return; }
  if (repos.length === 1) return openCompare(repos[0]);
  showMenuAt(ev, repos.map((r) => ({ label: repoName(r) + "  —  " + (gitBranchOf(r) || "?"), icon: "gitCompare", onClick: () => openCompare(r) })));
}

async function openCompare(repo, sourceRef, targetRef) {
  let info;
  try { info = await atom.git.branches(repo); } catch (e) { toast("Couldn’t list branches: " + esc(e.message), "alert"); return; }
  const all = [...info.locals, ...info.remotes];
  if (all.length < 2) { toast("Need at least two branches to compare", "alert"); return; }
  _cmp.repo = repo;
  _cmp.branches = info;
  _cmp.source = sourceRef || info.current || all[0] || "";          // default: current branch
  _cmp.target = targetRef || defaultTarget(info, _cmp.source);      // default: main
  _cmp.files = []; _cmp.index = -1;
  ensureCompareOverlay();
  renderCompareHead();
  await loadCompareFiles();
}

function ensureCompareOverlay() {
  let back = document.querySelector(".compare-overlay");
  if (back) return back;
  back = h("div", { class: "compare-overlay", onmousedown: (e) => { if (e.target === back) closeCompare(); } });
  const panel = h("div", { class: "compare-panel" },
    h("div", { class: "cmp-head" },
      h("span", { class: "cmp-ic", html: icon("gitCompare", 17) }),
      h("div", { class: "cmp-refs" },
        h("span", { class: "cmp-reflabel", text: "Source" }),
        h("button", { class: "cmp-ref source", title: "Choose the source branch (the changes being merged)", onclick: (e) => pickCompareRef(e, "source") }),
        h("span", { class: "cmp-arrow", html: icon("chevron", 14) }),
        h("span", { class: "cmp-reflabel", text: "Target" }),
        h("button", { class: "cmp-ref target", title: "Choose the target branch (merged into)", onclick: (e) => pickCompareRef(e, "target") }),
        h("button", { class: "cmp-swap", title: "Swap source / target", html: icon("refresh", 14), onclick: () => swapCompare() })),
      h("div", { class: "dfh-spacer" }),
      h("span", { class: "cmp-count" }),
      h("button", { class: "cmp-merge btn btn-primary", onclick: () => mergeFromCompare() }, "Merge"),
      h("button", { class: "dfh-btn close", title: "Close  Esc", html: icon("close", 16), onclick: () => closeCompare() })),
    h("div", { class: "cmp-body" },
      h("div", { class: "cmp-files" }),
      h("div", { class: "cmp-diff" })));
  back.append(panel);
  $("modalRoot").append(back);
  bindCompareKeys();
  return back;
}

function renderCompareHead() {
  const back = document.querySelector(".compare-overlay");
  if (!back) return;
  const setRef = (sel, name) => { const b = back.querySelector(sel); b.innerHTML = ""; b.append(h("span", { class: "cmp-ref-ic", html: icon("branch", 12) }), h("span", { class: "cmp-ref-name", text: shortRef(name) || "—" })); };
  setRef(".cmp-ref.source", _cmp.source);
  setRef(".cmp-ref.target", _cmp.target);
  const mergeBtn = back.querySelector(".cmp-merge");
  const canMerge = _cmp.source && _cmp.target && _cmp.source !== _cmp.target;
  mergeBtn.textContent = canMerge ? `Merge ${shortRef(_cmp.source)} → ${shortRef(_cmp.target)}` : "Merge";
  mergeBtn.disabled = !canMerge;
  mergeBtn.title = canMerge ? `Merge “${_cmp.source}” into “${_cmp.target}”` : "Pick two different branches to merge";
}

async function loadCompareFiles() {
  const back = document.querySelector(".compare-overlay");
  if (!back) return;
  const filesEl = back.querySelector(".cmp-files");
  const countEl = back.querySelector(".cmp-count");
  filesEl.innerHTML = "";
  if (!_cmp.source || !_cmp.target || _cmp.source === _cmp.target) {
    filesEl.append(h("div", { class: "cmp-empty" }, h("span", { html: icon("gitCompare", 24) }), h("div", { text: _cmp.source === _cmp.target ? "Pick two different branches." : "Choose branches to compare." })));
    countEl.textContent = "";
    showCompareDiffPlaceholder("Pick a source and target branch to see what would merge.");
    return;
  }
  filesEl.append(h("div", { class: "cmp-loading" }, h("span", { html: icon("spinner", 18, "spin") }), h("span", { text: "Comparing…" })));
  let res;
  // What `source` adds over `target` = git diff target...source (three-dot).
  try { res = await atom.git.changedBetween(_cmp.repo, _cmp.target, _cmp.source); }
  catch (e) { filesEl.innerHTML = ""; filesEl.append(h("div", { class: "cmp-empty" }, h("span", { html: icon("alert", 24) }), h("div", { text: "Compare failed: " + e.message }))); return; }
  if (back !== document.querySelector(".compare-overlay")) return;
  _cmp.files = res.files || [];
  countEl.textContent = _cmp.files.length ? `${_cmp.files.length} file${_cmp.files.length === 1 ? "" : "s"} changed` : "no differences";
  filesEl.innerHTML = "";
  if (!_cmp.files.length) {
    filesEl.append(h("div", { class: "cmp-empty" }, h("span", { html: icon("checkCircle", 26) }), h("div", { text: `${shortRef(_cmp.source)} has nothing to merge into ${shortRef(_cmp.target)}.` })));
    showCompareDiffPlaceholder("These branches have no differences.");
    return;
  }
  _cmp.files.forEach((f, i) => {
    const ext = (f.path.split(".").pop() || "").toLowerCase();
    const slash = f.path.lastIndexOf("/");
    filesEl.append(h("div", { class: "cmp-file", dataset: { i: String(i) }, title: f.label + " · " + f.path, onclick: () => showCompareDiff(i) },
      (function(){const m=fileMeta(baseName(f.path));return h("span",{class:"gvf-ico "+m.cls,html:icon(m.ic,14)});})(),
      h("span", { class: "gvf-name", text: baseName(f.path) }),
      h("span", { class: "gvf-path", text: slash >= 0 ? f.path.slice(0, slash) : "" }),
      h("span", { class: "gvf-stat cmp-stat-" + (f.code || "M"), text: f.label })));
  });
  showCompareDiff(0);
}

async function showCompareDiff(i) {
  const back = document.querySelector(".compare-overlay");
  if (!back || !_cmp.files[i]) return;
  _cmp.index = i;
  for (const el of back.querySelectorAll(".cmp-file")) el.classList.toggle("active", +el.dataset.i === i);
  const f = _cmp.files[i];
  const diffEl = back.querySelector(".cmp-diff");
  diffEl.innerHTML = "";
  diffEl.append(h("div", { class: "diff-loading" }, h("span", { html: icon("spinner", 22, "spin") }), h("span", { text: "Loading diff…" })));
  let res;
  try { res = await atom.git.refDiff(_cmp.repo, _cmp.target, _cmp.source, f.path); }
  catch (e) { res = { text: "", error: e.message }; }
  if (back !== document.querySelector(".compare-overlay") || _cmp.index !== i) return;
  const parsed = parseUnifiedDiff(res.text || "");
  const ext = (f.path.split(".").pop() || "").toLowerCase();
  diffEl.innerHTML = "";
  const head = h("div", { class: "cmp-diff-head" },
    (function(){const m=fileMeta(baseName(f.path||f));return h("span",{class:"dfh-ico "+m.cls,html:icon(m.ic,16)});})(),
    h("span", { class: "cmp-diff-name", text: f.path }),
    h("div", { class: "dfh-spacer" }),
    parsed.binary ? h("span", { class: "ds-bin", text: "binary" })
      : h("span", { class: "cmp-diff-stat" }, h("span", { class: "ds-add", text: "+" + parsed.adds }), h("span", { class: "ds-del", text: "−" + parsed.dels })));
  diffEl.append(head);
  if (res.error) { diffEl.append(diffEmpty("alert", "Couldn’t load diff", res.error)); return; }
  if (parsed.binary) { diffEl.append(diffEmpty("eye", "Binary file", "No text diff to show.")); return; }
  if (!parsed.hunks.length) { diffEl.append(diffEmpty("check", "No line changes", "File metadata changed only.")); return; }
  // The compare pane is narrow — render unified regardless of the global setting.
  const saved = gDiffView; gDiffView = "unified";
  const content = renderDiffContent(parsed);
  gDiffView = saved;
  diffEl.append(h("div", { class: "cmp-diff-scroll" }, content));
}

function showCompareDiffPlaceholder(msg) {
  const back = document.querySelector(".compare-overlay");
  if (!back) return;
  const d = back.querySelector(".cmp-diff");
  d.innerHTML = "";
  d.append(h("div", { class: "cmp-diff-empty" }, h("span", { html: icon("gitCompare", 30) }), h("div", { text: msg || "Select a file to see the diff." })));
}

function pickCompareRef(ev, which) {
  const info = _cmp.branches;
  if (!info) return;
  const all = [...info.locals, ...info.remotes];
  const cur = which === "source" ? _cmp.source : _cmp.target;
  showMenuAt(ev, all.map((b) => ({
    label: b + (b === info.current ? "  (current)" : ""), icon: b === cur ? "check" : "branch",
    onClick: () => { if (which === "source") _cmp.source = b; else _cmp.target = b; renderCompareHead(); loadCompareFiles(); },
  })));
}

function swapCompare() { const a = _cmp.source; _cmp.source = _cmp.target; _cmp.target = a; renderCompareHead(); loadCompareFiles(); }

// Local merge from the compare view (the "merge request"): merge the selected
// SOURCE branch into the selected TARGET, with a custom merge-commit message.
function mergeFromCompare() {
  const { repo, source, target } = _cmp;
  if (!source || !target || source === target) { toast("Pick two different branches to merge", "alert"); return; }
  const cur = _cmp.branches ? _cmp.branches.current : "";
  const note = target === cur ? "" : ` “${shortRef(target)}” will be checked out first.`;
  promptDialog({
    title: `Merge ${shortRef(source)} → ${shortRef(target)}`, ic: "merge",
    message: `Merging “${shortRef(source)}” into “${shortRef(target)}” in ${repoName(repo)}.${note}`,
    placeholder: "Merge commit message",
    value: `Merge branch '${shortRef(source)}' into ${shortRef(target)}`,
    confirmLabel: `Merge into ${shortRef(target)}`,
    onConfirm: (msg) => { closeCompare(); gitMergeBranches(repo, source, target, (msg || "").trim()); },
  });
}

// Merge source → target with an optional commit message. The backend checks out
// target then merges source, so this works even when target isn't checked out.
// On conflict we land on target, show the merge banner, and open the guided
// resolver straight away so the user is never left stuck.
async function gitMergeBranches(repo, source, target, message) {
  toast(`Merging ${esc(source)} → ${esc(target)}…`, "merge", { sticky: true, spin: true });
  try {
    const r = await atom.git.mergeBranches(repo, source, target, message);
    state.git.selected.clear();
    if (state.sidebarView !== "git") setSidebarView("git");
    await refreshGit(); refreshTree(true);
    if (r.ok) {
      const how = r.upToDate ? "already up to date" : (r.fastForward ? "fast-forward" : "merged");
      toast(`Merged ${esc(source)} → ${esc(target)} (${how}) · now on ${esc(target)}`, "checkCircle", { ms: 4400 });
    } else if (r.conflict) {
      toast(`<b>Merge needs your help: ${esc(source)} → ${esc(target)}</b><span class="toast-sub">You’re on ${esc(target)}. Resolve each conflict below, then complete the merge.</span>`, "alert", { ms: 6500 });
      openConflictResolver(repo);   // jump straight into guided, card-per-conflict resolution
    }
  } catch (e) { toast(`<b>Merge failed</b><span class="toast-sub">${esc(repoName(repo))}: ${esc(e.message)}</span>`, "alert", { ms: 7000 }); }
}

function closeCompare() {
  const b = document.querySelector(".compare-overlay");
  if (b) b.remove();
  if (_cmpKeyHandler) { document.removeEventListener("keydown", _cmpKeyHandler, true); _cmpKeyHandler = null; }
}

let _cmpKeyHandler = null;
function bindCompareKeys() {
  if (_cmpKeyHandler) return;
  _cmpKeyHandler = (e) => {
    if (!document.querySelector(".compare-overlay")) return;
    if (e.key === "Escape") { e.preventDefault(); closeCompare(); }
    else if (_cmp.files.length && (e.key === "]" || (e.key === "ArrowDown" && e.altKey))) { e.preventDefault(); showCompareDiff((_cmp.index + 1) % _cmp.files.length); }
    else if (_cmp.files.length && (e.key === "[" || (e.key === "ArrowUp" && e.altKey))) { e.preventDefault(); showCompareDiff((_cmp.index - 1 + _cmp.files.length) % _cmp.files.length); }
  };
  document.addEventListener("keydown", _cmpKeyHandler, true);
}

/* ============================================================
   MERGE CONFLICT RESOLVER — guided, card-per-conflict UI.
   Each conflict is one click to keep Mine / Incoming / Both, or edit by hand;
   cards collapse to the resolved result as you go, then "Complete" continues
   the operation.

   Conflict SESSION contract (audit 2026-09-09, GIT-006/007/021/025/026/027):
   · every load and save is bound to { repo, path, generation }; a slower, older
     read can never replace another file's content, and a save only ever writes
     the file it was loaded from;
   · per-file drafts (choices + custom text) live in _merge.sessions[path] and
     survive navigation; closing with unsaved choices asks first;
   · "Mine" / "Incoming" are mapped through the OPERATION-AWARE side descriptor
     from repoState() (rebase / cherry-pick / revert swap git's ours/theirs) — the
     same descriptor Git Center's whole-file buttons use, so both agree;
   · modify/delete, binary, unreadable and oversized files get WHOLE-FILE choices
     (resolveWith) instead of an empty line editor; unterminated markers are kept
     verbatim and block "resolved" until fixed by hand;
   · a save keeps the file's EOL / BOM / final-newline, is checked against the
     bytes that were loaded (writeChecked) and stages only after it succeeded;
   · Complete/Continue may legitimately stop at the NEXT conflict of a rebase or
     sequence: the resolver stays open and shows it — no completion toast.
   ============================================================ */
const _merge = { repo: "", files: [], index: 0, path: "", parsed: null, choices: {}, custom: {}, gen: 0, sessions: {}, sides: { mine: "ours", incoming: "theirs" }, op: "merge", opDetail: "", fileInfo: null };

function conflictedFiles(repo) {
  const s = state.git.statuses[repo];
  return ((s && s.files) || []).filter((f) => f.conflict).map((f) => f.path);
}
const mergeOpName = () => ({ merge: "merge", rebase: "rebase", "cherry-pick": "cherry-pick", revert: "revert", bisect: "bisect" })[_merge.op] || "merge";
const mergeOpTitle = () => { const n = mergeOpName(); return n.charAt(0).toUpperCase() + n.slice(1); };
// The user's meaning → the marker side git uses for it in THIS operation.
const mineChoice = () => _merge.sides.mine || "ours";
const incomingChoice = () => _merge.sides.incoming || "theirs";
const bothChoice = () => (mineChoice() === "ours" ? "both" : "both-rev");          // mine first, then incoming
const mineLines = (seg) => (mineChoice() === "ours" ? seg.ours : seg.theirs);
const incomingLines = (seg) => (mineChoice() === "ours" ? seg.theirs : seg.ours);
// Accepts a MEANING ("mine" | "incoming" | "both") or a raw git side ("ours" | "theirs" | "both-rev" | "custom").
function mapChoice(choice) { return choice === "mine" ? mineChoice() : choice === "incoming" ? incomingChoice() : choice === "both" ? bothChoice() : choice; }
function choiceLabel(choice) {
  if (choice === mineChoice()) return "Mine";
  if (choice === incomingChoice()) return "Incoming";
  if (choice === "both" || choice === "both-rev") return choice === bothChoice() ? "Both (mine + incoming)" : "Both (incoming + mine)";
  if (choice === "custom") return "Edited";
  return "Resolved";
}
async function loadOpState(repo) {
  try { const st = await atom.git.repoState(repo); _merge.sides = (st && st.sides) || { mine: "ours", incoming: "theirs" }; _merge.op = (st && st.op) || "merge"; _merge.opDetail = (st && st.detail) || ""; }
  catch { _merge.sides = { mine: "ours", incoming: "theirs" }; _merge.op = "merge"; _merge.opDetail = ""; }
}

// Open the resolver for a repo, starting at a specific file (or the first conflict).
// `explicitFiles` lets a caller that already knows the conflicted paths (Git Center)
// open the resolver without depending on the sidebar's git state being loaded.
async function openConflictResolver(repo, startPath, explicitFiles) {
  const files = (Array.isArray(explicitFiles) && explicitFiles.length) ? explicitFiles : conflictedFiles(repo);
  if (!files.length) { toast("No conflicts to resolve", "check"); return; }
  if (_merge.repo !== repo) _merge.sessions = {};          // drafts are repo-local
  _merge.repo = repo;
  _merge.files = files;
  _merge.index = Math.max(0, files.indexOf(startPath));
  await loadOpState(repo);
  bindMergeKeys();
  await loadConflictFile();
}

/* Load the current file. Bound to { repo, path, gen }: whatever lands after the
 * user moved on (or the overlay closed) is dropped instead of displayed. */
async function loadConflictFile() {
  const back = ensureMergeOverlay();
  const repo = _merge.repo;
  const path = _merge.files[_merge.index];
  const gen = ++_merge.gen;
  _merge.path = path; _merge.parsed = null; _merge.fileInfo = null;
  const sess = _merge.sessions[path] || (_merge.sessions[path] = { choices: {}, custom: {}, raw: null, fmt: null, saved: false });
  _merge.choices = sess.choices; _merge.custom = sess.custom;     // per-file draft, shared by reference
  const body = back.querySelector(".merge-body");
  body.innerHTML = "";
  body.append(h("div", { class: "diff-loading" }, h("span", { html: icon("spinner", 22, "spin") }), h("span", { text: "Loading conflicts…" })));
  const abs = repo.replace(/[\\/]+$/, "") + "/" + path;
  const [data, stages, st] = await Promise.all([
    atom.files.read(abs).catch((e) => ({ error: e.message })),
    atom.git.conflictStages(repo, path).catch(() => null),
    atom.git.repoState(repo).catch(() => null),
  ]);
  if (back !== document.querySelector(".merge-overlay") || _merge.repo !== repo || _merge.path !== path || _merge.gen !== gen) return;   // stale: another file / repo is showing now
  if (st) { _merge.sides = st.sides || _merge.sides; _merge.op = st.op || _merge.op; _merge.opDetail = st.detail || ""; }
  const readable = data && !data.error && !data.isBinary && !data.tooLarge;
  const fmt = readable ? normalizeForEdit(data.content || "") : null;
  sess.raw = data && !data.error && !data.isBinary && !data.tooLarge ? (data.content == null ? "" : data.content) : null;
  sess.fmt = fmt; sess.saved = false;
  const kind = stages && stages.modifyDelete ? "modifyDelete" : (stages && stages.binary) || (data && data.isBinary) ? "binary" : data && data.tooLarge ? "tooLarge" : data && data.error ? "error" : "text";
  _merge.fileInfo = { stages, data, kind, error: data && data.error };
  _merge.parsed = readable ? parseConflicts(fmt.text) : { segments: [], count: 0, malformed: [], markerSize: 7 };
  // choices for conflict ids that no longer exist (the file changed) are dropped
  const ids = new Set(_merge.parsed.segments.filter((s) => s.type === "conflict").map((s) => s.id));
  for (const k of Object.keys(sess.choices)) if (!ids.has(+k)) { delete sess.choices[k]; delete sess.custom[k]; }
  renderMergeFile();
}

function ensureMergeOverlay() {
  let back = document.querySelector(".merge-overlay");
  if (back) return back;
  back = h("div", { class: "merge-overlay", onmousedown: (e) => { if (e.target === back) closeMerge(); } });
  const panel = h("div", { class: "merge-panel", role: "dialog", "aria-modal": "true", "aria-label": "Resolve conflicts", tabindex: "-1" },
    h("div", { class: "merge-head" },
      h("span", { class: "mgh-ico", html: icon("git", 17) }),
      h("div", { class: "mgh-title" }, h("span", { class: "mgh-name" }), h("span", { class: "mgh-sub" })),
      h("div", { class: "mgh-progress" }, h("span", { class: "mgh-bar" }, h("span", { class: "mgh-bar-fill" })), h("span", { class: "mgh-count" })),
      h("div", { class: "dfh-spacer" }),
      h("button", { class: "dfh-btn", title: "Previous conflicted file  [", "aria-label": "Previous file", html: icon("chevron", 16, "flip"), onclick: () => navMergeFile(-1) }),
      h("button", { class: "dfh-btn", title: "Next conflicted file  ]", "aria-label": "Next file", html: icon("chevron", 16), onclick: () => navMergeFile(1) }),
      h("button", { class: "dfh-btn close", title: "Close  Esc", "aria-label": "Close", html: icon("close", 16), onclick: () => closeMerge() })),
    h("div", { class: "merge-toolbar" },
      h("div", { class: "mg-legend" },
        h("span", { class: "mg-chip current" }, h("i"), h("span", { class: "mgl-cur", text: "Mine" })),
        h("span", { class: "mg-chip incoming" }, h("i"), h("span", { class: "mgl-inc", text: "Incoming" })),
        h("span", { class: "mg-chip op", title: "Which git side each label maps to in this operation" }, h("span", { class: "mgl-op" }))),
      h("div", { class: "dfh-spacer" }),
      h("button", { class: "mg-bulk", title: "Keep MY version for every conflict in this file (overrides the incoming changes)", onclick: () => bulkResolve("mine") }, "Keep all mine"),
      h("button", { class: "mg-bulk", title: "Accept the INCOMING version for every conflict in this file (overrides my changes)", onclick: () => bulkResolve("incoming") }, "Accept all incoming")),
    h("div", { class: "merge-body" }),
    h("div", { class: "merge-foot" },
      h("span", { class: "mgf-status", role: "status" }),
      h("div", { class: "dfh-spacer" }),
      h("button", { class: "btn btn-ghost", id: "mgAbort", text: "Abort merge", onclick: async () => { const op = mergeOpName(); if (await confirmDialog({ title: `Abort ${op}`, danger: true, message: `Abort the ${op} in ${repoName(_merge.repo)} and return to the state before it started? Unsaved resolution choices are discarded.`, confirmLabel: "Abort" })) { closeMerge({ force: true }); gitMergeAbort(_merge.repo); } } }),
      h("button", { class: "btn btn-ghost", id: "mgResolveFile", text: "Mark file resolved", onclick: () => markFileResolved() }),
      h("button", { class: "btn btn-primary", id: "mgComplete", text: "Complete merge", onclick: () => completeMerge() })));
  back.append(panel);
  $("modalRoot").append(back);
  setTimeout(() => { try { if (back.isConnected) panel.focus({ preventScroll: true }); } catch { /* */ } }, 0);
  return back;
}

function renderMergeFile() {
  const back = document.querySelector(".merge-overlay");
  if (!back) return;
  const p = _merge.parsed, fi = _merge.fileInfo || { kind: "text" };
  const opT = mergeOpTitle();
  back.querySelector(".mgh-name").textContent = baseName(_merge.path);
  const dir = _merge.path.includes("/") ? _merge.path.slice(0, _merge.path.lastIndexOf("/")) + "/ · " : "";
  back.querySelector(".mgh-sub").textContent = dir + repoName(_merge.repo) + `  ·  ${opT}${_merge.opDetail ? " " + _merge.opDetail : ""}`
    + (_merge.files.length > 1 ? `  ·  file ${_merge.index + 1}/${_merge.files.length}` : "");
  // Labels: concrete branch/commit names from the markers, mapped through the side descriptor.
  const firstC = p.segments.find((s) => s.type === "conflict");
  const oursLabel = firstC ? (firstC.oursLabel || "HEAD") : "HEAD", theirsLabel = firstC ? (firstC.theirsLabel || "incoming") : "incoming";
  const mineLabel = (mineChoice() === "ours" ? oursLabel : theirsLabel).replace(/^HEAD$/, gitBranchOf(_merge.repo) || "HEAD");
  const incLabel = mineChoice() === "ours" ? theirsLabel : oursLabel;
  back.querySelector(".mgl-cur").textContent = "Mine · " + mineLabel;
  back.querySelector(".mgl-inc").textContent = "Incoming · " + incLabel;
  back.querySelector(".mgl-op").textContent = `${opT}: mine = git ${mineChoice()}, incoming = git ${incomingChoice()}`;
  back.querySelector("#mgAbort").textContent = `Abort ${mergeOpName()}`;
  back.querySelector("#mgComplete").textContent = _merge.op === "merge" ? "Complete merge" : `Continue ${mergeOpName()}`;
  const body = back.querySelector(".merge-body");
  body.innerHTML = "";
  if (fi.kind !== "text") { body.append(renderFileLevelCard(fi)); updateMergeProgress(); return; }
  if (p.malformed && p.malformed.length) body.append(h("div", { class: "mg-card malformed" }, h("div", { class: "mgc-bar" }, h("span", { class: "mgc-warn", html: icon("alert", 13) }), h("span", { class: "mgc-title", text: `${p.malformed.length} unterminated conflict block${p.malformed.length === 1 ? "" : "s"} kept verbatim` }), h("div", { class: "dfh-spacer" }), h("button", { class: "mgc-change", onclick: () => openInEditor(_merge.repo.replace(/[\\/]+$/, "") + "/" + _merge.path) }, "Open in editor")), h("div", { class: "mg-note", text: `Markers of width ${p.markerSize} did not close properly (starting at line${p.malformed.length === 1 ? "" : "s"} ${p.malformed.map((m) => m.startLine + 1).join(", ")}). Nothing was dropped; fix the block by hand, then reload this file.` })));
  for (const seg of p.segments) {
    if (seg.type === "text") {
      if (seg.lines.length === 1 && seg.lines[0] === "") continue;
      body.append(h("pre", { class: "mg-context", text: seg.lines.join("\n") }));
    } else {
      body.append(renderConflictCard(seg));
    }
  }
  if (!p.count && !(p.malformed && p.malformed.length)) body.append(h("div", { class: "mg-card" }, h("div", { class: "mg-note", text: "No conflict markers in this file (it may already be resolved). Mark it resolved to stage it, or take a whole side below." }), fileLevelButtons(fi)));
  updateMergeProgress();
}

// Whole-file choices for content the line resolver cannot handle. The deleted side
// of a modify/delete conflict is honoured as a deletion (never a failing checkout).
function renderFileLevelCard(fi) {
  const st = fi.stages || {};
  const mineStage = mineChoice() === "ours" ? st.ours : st.theirs, incStage = mineChoice() === "ours" ? st.theirs : st.ours;
  const why = fi.kind === "modifyDelete" ? `One side deleted this file while the other changed it. ${!mineStage ? "Your side (mine) deleted it" : "The incoming side deleted it"}; the other side kept it${mineStage && incStage ? "" : " modified"}.`
    : fi.kind === "binary" ? "This is a binary file — there is no line-level merge. Take one whole side."
    : fi.kind === "tooLarge" ? `This file is too large to resolve line by line here (${(fi.data.size / 1048576).toFixed(1)} MB). Take one whole side, or resolve it in your editor and mark it resolved.`
    : `The file could not be read${fi.error ? ": " + fi.error : ""}. Take one whole side, or fix it in your editor.`;
  return h("div", { class: "mg-card filelevel" },
    h("div", { class: "mgc-bar" }, h("span", { class: "mgc-warn", html: icon("alert", 13) }), h("span", { class: "mgc-title", text: fi.kind === "modifyDelete" ? "Modify / delete conflict" : fi.kind === "binary" ? "Binary conflict" : fi.kind === "tooLarge" ? "File too large for line resolution" : "File unreadable" })),
    h("div", { class: "mg-note", text: why }),
    fileLevelButtons(fi));
}
function fileLevelButtons(fi) {
  const st = (fi && fi.stages) || {};
  const mineStage = mineChoice() === "ours" ? st.ours : st.theirs, incStage = mineChoice() === "ours" ? st.theirs : st.ours;
  const has = !!(fi && fi.stages);
  return h("div", { class: "mgc-actions filelevel" },
    h("button", { class: "mgc-act cur", title: `git checkout --${mineChoice()} (whole file)`, onclick: () => resolveWholeFile("mine") }, has && !mineStage ? "Keep mine (deletes the file)" : "Keep mine (whole file)"),
    h("button", { class: "mgc-act inc", title: `git checkout --${incomingChoice()} (whole file)`, onclick: () => resolveWholeFile("incoming") }, has && !incStage ? "Accept incoming (deletes the file)" : "Accept incoming (whole file)"),
    h("button", { class: "mgc-act edit", title: "Open the file in the editor", onclick: () => openInEditor(_merge.repo.replace(/[\\/]+$/, "") + "/" + _merge.path) }, h("span", { html: icon("pencil", 13) }), "Edit"));
}
async function resolveWholeFile(which) {
  const repo = _merge.repo, rel = _merge.path, gen = _merge.gen;
  const side = which === "mine" ? mineChoice() : incomingChoice();
  let r;
  try { r = await atom.git.resolveWith(repo, [rel], side); } catch (e) { toast(`Couldn't resolve ${esc(baseName(rel))}: ${esc(e.message)}`, "alert", { ms: 6000 }); return; }
  if (!r || !r.ok) { toast(`Couldn't resolve ${esc(baseName(rel))}: ${esc((r && r.results && r.results[0] && r.results[0].error) || (r && r.error) || "failed")}`, "alert", { ms: 6000 }); return; }
  const deleted = (r.results || []).some((x) => x.action === "deleted");
  toast(deleted ? `${esc(baseName(rel))} deleted (that side had removed it) and staged` : `${esc(baseName(rel))}: kept ${which === "mine" ? "your" : "the incoming"} version and staged`, "checkCircle", { ms: 3000 });
  if (_merge.repo !== repo || _merge.path !== rel || _merge.gen !== gen) return;
  delete _merge.sessions[rel];
  await afterFileResolved(repo);
}

function renderConflictCard(seg) {
  const choice = _merge.choices[seg.id];
  const card = h("div", { class: "mg-card" + (choice ? " resolved" : ""), dataset: { id: String(seg.id) } });
  if (choice) {
    // collapsed → show the resolved result with a way to change it
    const resultText = choice === "custom" ? (_merge.custom[seg.id] || "") : previewFor(seg, choice);
    card.append(
      h("div", { class: "mgc-bar resolved" },
        h("span", { class: "mgc-tick", html: icon("checkCircle", 14) }),
        h("span", { class: "mgc-kept", text: "Kept: " + choiceLabel(choice) }),
        h("div", { class: "dfh-spacer" }),
        h("button", { class: "mgc-change", onclick: () => { delete _merge.choices[seg.id]; renderMergeFile(); } }, "Change")),
      h("pre", { class: "mg-result", text: resultText }));
    return card;
  }
  // open → choices + the two sides (mine on the left, whatever git side that is)
  card.append(
    h("div", { class: "mgc-bar" },
      h("span", { class: "mgc-warn", html: icon("alert", 13) }),
      h("span", { class: "mgc-title", text: "Conflict #" + (seg.id + 1) }),
      h("div", { class: "dfh-spacer" }),
      h("div", { class: "mgc-actions" },
        h("button", { class: "mgc-act cur", title: `Keep my changes (1) — git ${mineChoice()}`, onclick: () => resolveConflict(seg.id, "mine") }, "Keep mine"),
        h("button", { class: "mgc-act inc", title: `Accept the incoming changes (2) — git ${incomingChoice()}`, onclick: () => resolveConflict(seg.id, "incoming") }, "Accept incoming"),
        h("button", { class: "mgc-act both", title: "Keep both, mine first (3)", onclick: () => resolveConflict(seg.id, "both") }, "Both"),
        h("button", { class: "mgc-act edit", title: "Edit manually", "aria-label": "Edit manually", onclick: () => editConflict(seg.id) }, h("span", { html: icon("pencil", 13) })))),
    h("div", { class: "mgc-sides" },
      sidePane("current", mineLines(seg), () => resolveConflict(seg.id, "mine")),
      sidePane("incoming", incomingLines(seg), () => resolveConflict(seg.id, "incoming"))));
  return card;
}

function sidePane(kind, lines, onAccept) {
  const el = h("div", { class: "mgc-side " + kind, onclick: onAccept, title: "Click to keep this side", role: "button", tabindex: "0" },
    h("div", { class: "mgs-lines" }, h("pre", { text: lines.join("\n") || " " })));
  el.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); onAccept(); } });
  return el;
}

function resolveConflict(id, choice) {
  _merge.choices[id] = mapChoice(choice);
  delete _merge.custom[id];
  renderMergeFile();
}

function editConflict(id) {
  const seg = _merge.parsed.segments.find((s) => s.type === "conflict" && s.id === id);
  if (!seg) return;
  const initial = _merge.choices[id] === "custom" ? (_merge.custom[id] || "") : previewFor(seg, _merge.choices[id] || bothChoice());
  const card = document.querySelector(`.mg-card[data-id="${id}"]`);
  if (!card) return;
  card.innerHTML = "";
  const ta = h("textarea", { class: "mgc-editor", spellcheck: "false", "aria-label": `Edit conflict ${id + 1}` });
  ta.value = initial;
  card.append(
    h("div", { class: "mgc-bar" }, h("span", { class: "mgc-title", text: "Edit conflict #" + (id + 1) }),
      h("div", { class: "dfh-spacer" }),
      h("button", { class: "mgc-act both", onclick: () => { _merge.custom[id] = ta.value; _merge.choices[id] = "custom"; renderMergeFile(); } }, "Save"),
      h("button", { class: "mgc-change", onclick: () => renderMergeFile() }, "Cancel")),
    ta);
  setTimeout(() => ta.focus(), 20);
}

function bulkResolve(choice) {
  const c = mapChoice(choice);
  for (const seg of _merge.parsed.segments) if (seg.type === "conflict") { _merge.choices[seg.id] = c; delete _merge.custom[seg.id]; }
  renderMergeFile();
}

function mergeResolvedCount() { return _merge.parsed ? _merge.parsed.segments.filter((s) => s.type === "conflict" && _merge.choices[s.id]).length : 0; }
function mergeHasDrafts() { return Object.values(_merge.sessions).some((s) => s && !s.saved && Object.keys(s.choices || {}).length); }

function updateMergeProgress() {
  const back = document.querySelector(".merge-overlay");
  if (!back) return;
  const total = _merge.parsed ? _merge.parsed.count : 0;
  const done = mergeResolvedCount();
  const fi = _merge.fileInfo || { kind: "text" };
  const malformed = _merge.parsed && _merge.parsed.malformed ? _merge.parsed.malformed.length : 0;
  back.querySelector(".mgh-count").textContent = `${done}/${total}`;
  back.querySelector(".mgh-bar-fill").style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
  const textOk = fi.kind === "text" && _merge.parsed && isFullyResolved(_merge.parsed, _merge.choices);
  const resolveBtn = back.querySelector("#mgResolveFile");
  resolveBtn.disabled = !textOk;
  resolveBtn.textContent = _merge.files.length > 1 ? "Resolve file & next" : "Mark file resolved";
  back.querySelector(".mgf-status").textContent = fi.kind !== "text" ? "Choose a whole side for this file."
    : malformed ? `${malformed} malformed conflict block${malformed === 1 ? "" : "s"} — fix by hand before marking resolved.`
    : textOk ? (total ? "All conflicts in this file resolved." : "No markers left — mark the file resolved to stage it.")
    : `${total - done} conflict${total - done === 1 ? "" : "s"} left in this file.`;
}

/* Write the resolved file (original EOL/BOM/final-newline restored; only if the file
 * still holds the bytes that were loaded), stage it, then advance to the next
 * conflicted file — or show "all set" when this was the last one. */
async function markFileResolved() {
  const repo = _merge.repo, rel = _merge.path, gen = _merge.gen;
  const sess = _merge.sessions[rel];
  if (!sess || !_merge.parsed || !isFullyResolved(_merge.parsed, _merge.choices)) { toast("Resolve every conflict in this file first", "alert"); return; }
  const content = restoreFormat(assembleResolved(_merge.parsed, _merge.choices, _merge.custom), sess.fmt || {});
  const abs = repo.replace(/[\\/]+$/, "") + "/" + rel;
  let w;
  try { w = await atom.files.writeChecked(abs, content, sess.raw); }
  catch (e) { toast("Couldn't save resolution: " + esc(e.message), "alert", { ms: 6000 }); return; }
  if (!w || !w.ok) {
    toast(`<b>${esc(baseName(rel))} changed on disk</b><span class="toast-sub">Another editor or process modified it since it was loaded. Nothing was written; reloading it now.</span>`, "alert", { ms: 6500 });
    if (_merge.repo === repo && _merge.path === rel && _merge.gen === gen) await loadConflictFile();
    return;
  }
  try { await atom.git.stage(repo, [rel]); }
  catch (e) { toast(`Saved ${esc(baseName(rel))}, but staging failed: ${esc(e.message)}`, "alert", { ms: 6000 }); return; }
  sess.saved = true;
  if (_merge.repo !== repo || _merge.gen !== gen) return;   // the user moved on while saving — the saved file is done, the view is theirs
  await afterFileResolved(repo);
}
// After a file is resolved+staged: re-read the conflict list from git (never from stale sidebar state) and continue.
async function afterFileResolved(repo) {
  await refreshGit();
  let remaining = conflictedFiles(repo);
  try { const st = await atom.git.status(repo); if (st && st.files) remaining = st.files.filter((f) => f.conflict).map((f) => f.path); } catch { /* keep sidebar view */ }
  if (_merge.repo !== repo || !document.querySelector(".merge-overlay")) return;
  _merge.files = remaining;
  if (!remaining.length) { toast(`Resolved ${esc(repoName(repo))} — ready to ${_merge.op === "merge" ? "complete the merge" : "continue the " + mergeOpName()}`, "checkCircle", { ms: 3000 }); renderMergeDone(); return; }
  _merge.index = 0;
  await loadConflictFile();
}

function renderMergeDone() {
  const back = document.querySelector(".merge-overlay");
  if (!back) return;
  _merge.path = ""; _merge.parsed = null; _merge.fileInfo = null;
  back.querySelector(".merge-body").innerHTML = "";
  back.querySelector(".merge-body").append(h("div", { class: "merge-allset" },
    h("span", { class: "ms-ic", html: icon("checkCircle", 40) }),
    h("div", { class: "ms-title", text: "All conflicts resolved" }),
    h("div", { class: "ms-sub", text: _merge.op === "merge" ? "Click “Complete merge” to create the merge commit." : `Click “Continue ${mergeOpName()}” — it may stop again at the next conflicting commit.` })));
  back.querySelector(".mgh-name").textContent = repoName(_merge.repo);
  back.querySelector(".mgh-sub").textContent = `${mergeOpTitle()} · ready to continue`;
  back.querySelector("#mgResolveFile").disabled = true;
  back.querySelector(".mgh-bar-fill").style.width = "100%";
  back.querySelector(".mgh-count").textContent = "done";
  back.querySelector(".mgf-status").textContent = "Every conflicted file is resolved + staged.";
}

/* Continue the operation. The backend dispatches merge / rebase / cherry-pick / revert
 * --continue from the repo's real state and may report the NEXT conflict of a sequence:
 * then the resolver reloads and stays open — a completion toast is shown only when the
 * operation has actually finished. */
async function completeMerge() {
  const repo = _merge.repo;
  let remaining = conflictedFiles(repo);
  try { const st = await atom.git.status(repo); if (st && st.files) remaining = st.files.filter((f) => f.conflict).map((f) => f.path); } catch { /* use sidebar view */ }
  if (remaining.length) { toast("Resolve the remaining conflicts first", "alert"); _merge.files = remaining; _merge.index = 0; await loadConflictFile(); return; }
  const opT = mergeOpTitle();
  let r;
  try { r = await atom.git.mergeContinue(repo); }
  catch (e) { toast(`Couldn't complete the ${esc(mergeOpName())}: ${esc(e.message)}`, "alert", { ms: 6000 }); return; }
  await refreshGit(); refreshTree(true);
  if (r && (r.conflict || r.state === "conflict" || r.stillInProgress)) {
    await loadOpState(repo);
    let files = [];
    try { const st = await atom.git.status(repo); files = ((st && st.files) || []).filter((f) => f.conflict).map((f) => f.path); } catch { /* */ }
    toast(`<b>${esc(opT)} continues — ${files.length ? `${files.length} conflicted file${files.length === 1 ? "" : "s"} in the next commit` : "stopped again"}</b><span class="toast-sub">${esc(_merge.opDetail || "")}${files.length ? " Resolve them, then continue again." : " Check the banner in the Changes view."}</span>`, "alert", { ms: 7000 });
    if (!document.querySelector(".merge-overlay")) return;
    _merge.sessions = {};
    if (files.length) { _merge.files = files; _merge.index = 0; await loadConflictFile(); } else renderMergeDone();
    return;
  }
  if (r && r.ok === false) { toast(`<b>${esc(opT)} did not complete</b><span class="toast-sub">${esc(r.error || r.output || r.state || "")}</span>`, "alert", { ms: 7000 }); return; }
  closeMerge({ force: true });
  toast(`<b>${esc(opT)} completed on ${esc(repoName(repo))}</b><span class="toast-sub">Now on ${esc((r && r.branch) || "")}.</span>`, "checkCircle", { ms: 4200 });
}

function navMergeFile(delta) {
  const files = conflictedFiles(_merge.repo).length ? conflictedFiles(_merge.repo) : (_merge.files || []);
  if (files.length < 2) return;
  _merge.files = files;
  _merge.index = (_merge.index + delta + files.length) % files.length;
  loadConflictFile();   // drafts of the file we leave stay in _merge.sessions
}

// Close the resolver. Unsaved resolution choices are confirmed first (force skips that).
function closeMerge({ force } = {}) {
  const b = document.querySelector(".merge-overlay");
  if (!b) return;
  const really = () => {
    b.remove();
    _merge.gen++;
    if (_mergeKeyHandler) { document.removeEventListener("keydown", _mergeKeyHandler, true); _mergeKeyHandler = null; }
  };
  if (!force && mergeHasDrafts()) {
    confirmDialog({ title: "Discard resolution choices?", danger: true, message: "Some conflict choices in this session were not saved (Mark file resolved). Close anyway and discard them?", confirmLabel: "Discard & close" }).then((ok) => { if (ok) { _merge.sessions = {}; really(); } });
    return;
  }
  really();
}

let _mergeKeyHandler = null;
function bindMergeKeys() {
  if (_mergeKeyHandler) return;
  _mergeKeyHandler = (e) => {
    if (!document.querySelector(".merge-overlay")) return;
    if (document.querySelector("#modalRoot .modal-backdrop")) return;                 // a dialog is stacked on top
    if (e.target && /^(TEXTAREA|INPUT)$/.test(e.target.tagName)) return;   // don't hijack the editor
    if (e.key === "Escape") { e.preventDefault(); closeMerge(); }
    else if (e.key === "]") { e.preventDefault(); navMergeFile(1); }
    else if (e.key === "[") { e.preventDefault(); navMergeFile(-1); }
    else {
      // 1/2/3 resolve the first still-open conflict (quick keyboard flow) — same mapping as the buttons
      const map = { "1": "mine", "2": "incoming", "3": "both" };
      if (map[e.key] && _merge.parsed) {
        const open = _merge.parsed.segments.find((s) => s.type === "conflict" && !_merge.choices[s.id]);
        if (open) { e.preventDefault(); resolveConflict(open.id, map[e.key]); }
      }
    }
  };
  document.addEventListener("keydown", _mergeKeyHandler, true);
}

function tabContextMenu(e, id) {
  const idx = state.order.indexOf(id);
  const others = state.order.filter((x) => x !== id);
  const toRight = state.order.slice(idx + 1);
  const items = [
    { label: "Rename session", icon: "pencil", onClick: () => renameSession(id) },
    { label: "New session here", icon: "plus", onClick: () => newTab(state.tabs.get(id)?.meta.cwd) },
    { label: "Synthesize → new session", icon: "sparkle", onClick: () => synthesizeSession(id) },
    { sep: true },
    { label: "Export (full)", icon: "download", onClick: () => atom.sessions.export([id], "full").then((r) => { if (r && r.path) toast(`Exported (full)`, "download"); }).catch((e) => toast("Export failed: " + e.message, "alert")) },
    { label: "Export (compact)", icon: "download", onClick: () => atom.sessions.export([id], "compact").then((r) => { if (r && r.path) toast(`Exported (compact)`, "download"); }).catch((e) => toast("Export failed: " + e.message, "alert")) },
    { label: "Open history folder", icon: "history", onClick: () => atom.sessions.openHistory() },
    { sep: true },
    { label: "Close tab", icon: "close", onClick: () => closeTab(id) },
  ];
  if (others.length) items.push({ label: "Close other tabs", icon: "close", onClick: () => closeOtherTabs(id) });
  if (toRight.length) items.push({ label: "Close tabs to the right", icon: "close", onClick: () => closeTabsToRight(id) });
  items.push({ sep: true }, { label: "Delete from history", icon: "trash", danger: true, onClick: () => deleteSession(id) });
  showContextMenu(e.clientX, e.clientY, items);
}

async function switchTab(id, force) {
  if (!state.tabs.has(id)) return;
  // save current draft
  const prev = activeTS();
  if (prev && !force) prev.draft = $("promptInput")?.value || "";
  state.activeTabId = id;
  const ts = state.tabs.get(id);
  renderTabs();
  await renderSidebar();
  refreshComposer();
  renderChat();
  renderChanges();
  refreshSkillsBtn();   // badge reflects the active tab's sticky skill selection
  persistTabs();
}

// New session: ALWAYS a brand-new session with fresh composer state (empty draft,
// attachments, queue, permissions, selected skills; no native thread; no carried
// conversation). The previous tab keeps its own draft and running work untouched.
// (A blank tab is no longer reused — it may hold an unsent draft, images or a
// skill selection the user does not want in the new conversation.)
async function newTab(cwd) {
  const folder = cwd || state.project || activeTS()?.meta.cwd || state.settings.lastFolder;
  const s = await atom.sessions.create({
    cwd: folder,
    model: state.settings.defaultModel,
    permissionMode: state.settings.defaultPermissionMode,
    thinking: state.settings.defaultThinking,
  });
  addTabState(s);
  state.order.push(s.id);
  await switchTab(s.id);
}

function tabIsEmpty(ts) { return ts && !ts.totalMessages && (!ts.messages || !ts.messages.length); }

async function closeTab(id) {
  const ts = state.tabs.get(id);
  if (!ts) return;
  const isEmpty = tabIsEmpty(ts);
  const isLast = state.order.length <= 1;
  if (isLast && isEmpty) return;          // nothing to close — keep the single empty tab
  if (!isEmpty || ts.meta.status === "running") {
    confirmDialog({
      title: "Close session tab?",
      message: ts.meta.status === "running"
        ? "This session is still running — closing the tab won't stop it. It stays in History and can be reopened."
        : "This conversation stays in History and can be reopened anytime.",
      confirmLabel: "Close tab",
      onConfirm: () => finishCloseTab(id, isEmpty),
    });
    return;
  }
  finishCloseTab(id, isEmpty);
}

async function finishCloseTab(id, isEmpty) {
  const idx = state.order.indexOf(id);
  const ts = state.tabs.get(id);
  // Clear any per-tab timers/listeners before dropping the ref so they can't
  // fire against a closed tab (and keep a zombie reference alive).
  if (ts) {
    if (ts._stopTimer) clearTimeout(ts._stopTimer);
    if (ts._permFlashTimers) for (const t of ts._permFlashTimers) clearTimeout(t);
    // Tab being closed while still running → interrupt the backend so the
    // session doesn't keep burning tokens for output the user will never see.
    if (ts.meta.status === "running" && !isEmpty) {
      atom.sessions.interrupt(id, "stop").catch(() => {});
    }
  }
  state.order = state.order.filter((x) => x !== id);
  state.tabs.delete(id);
  if (isEmpty) atom.sessions.delete(id).catch(() => {});   // discard the throwaway empty session
  if (state.order.length === 0) { await newTab(); return; } // exactly one fresh session
  if (state.activeTabId === id) await switchTab(state.order[Math.min(idx, state.order.length - 1)]);
  else renderTabs();
  persistTabs();
}

// Close many tabs at once (editor-style). Empty throwaway tabs are discarded;
// real conversations stay in History. One confirmation, not one per tab.
async function bulkCloseTabs(idsToClose, keepId) {
  idsToClose = idsToClose.filter((i) => state.tabs.has(i) && i !== keepId);
  if (!idsToClose.length) return;
  const nonEmpty = idsToClose.filter((i) => !tabIsEmpty(state.tabs.get(i)));
  const proceed = async () => {
    for (const i of idsToClose) {
      const empty = tabIsEmpty(state.tabs.get(i));
      state.order = state.order.filter((x) => x !== i);
      state.tabs.delete(i);
      if (empty) atom.sessions.delete(i).catch(() => {}); // discard throwaway empty session
    }
    if (!state.order.length) { await newTab(); return; }
    const active = state.tabs.has(keepId) ? keepId : state.order[0];
    await switchTab(active, true);
    persistTabs();
    toast(`Closed ${idsToClose.length} tab${idsToClose.length > 1 ? "s" : ""}`, "close");
  };
  if (nonEmpty.length) {
    confirmDialog({
      title: `Close ${idsToClose.length} tab${idsToClose.length > 1 ? "s" : ""}?`,
      message: `${nonEmpty.length} conversation${nonEmpty.length > 1 ? "s stay" : " stays"} in History and can be reopened anytime. Empty tabs are discarded.`,
      confirmLabel: "Close tabs",
      onConfirm: proceed,
    });
  } else { proceed(); }
}
function closeOtherTabs(id) { return bulkCloseTabs(state.order.filter((x) => x !== id), id); }
function closeTabsToRight(id) { const i = state.order.indexOf(id); return bulkCloseTabs(state.order.slice(i + 1), id); }

async function deleteSession(id, onDeleted) {
  confirmDialog({
    title: "Delete session?",
    message: "This permanently removes the session and its history from disk. This cannot be undone.",
    danger: true, confirmLabel: "Delete",
    onConfirm: async () => {
      await atom.sessions.delete(id);
      if (state.tabs.has(id)) await finishCloseTab(id, false); // force-close without re-prompting
      toast("Session deleted", "trash");
      if (onDeleted) onDeleted();
    },
  });
}

function renameSession(id, onSaved, prefill) {
  const ts = state.tabs.get(id);
  const input = h("input", { class: "input", value: prefill != null ? prefill : (ts ? ts.meta.name : ""), maxlength: "80" });
  const back = modalShell({
    title: "Rename session", ic: "pencil",
    body: h("div", { class: "field" }, h("label", { text: "Session name" }), input),
    footer: [
      h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => closeModal(back) }),
      h("button", { class: "btn btn-primary", text: "Save", onclick: save }),
    ],
  });
  setTimeout(() => { input.focus(); input.select(); }, 30);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  async function save() {
    const name = input.value.trim() || "Untitled session";
    await atom.sessions.rename(id, name);
    if (ts) ts.meta.name = name;
    closeModal(back);
    renderTabs();
    if (onSaved) onSaved(name);
  }
}

/* ============================================================
   SIDEBAR + FILE TREE
   ============================================================ */
async function renderSidebar() {
  const ts = activeTS();
  if (!ts) return;
  const bar = $("folderBar");
  bar.innerHTML = "";
  bar.append(
    h("button", { class: "folder-pick", title: state.project + "  —  switch / open project", onclick: (e) => openProjectMenu(e) },
      h("span", { class: "fp-icon", html: icon("folderOpen", 17) }),
      h("span", { class: "fp-name", text: baseName(state.project) }),
      h("span", { html: icon("chevronDown", 14) })),
    h("div", { class: "folder-actions", id: "folderActions" }));
  renderFolderActions();

  // footer removed — Settings lives top-right; History is in the chat header.
  $("sidebarFooter").innerHTML = "";

  await ensureTreeRoot(ts);
  if (state.sidebarView === "git") renderGitView();
  else renderTree();
}

async function ensureTreeRoot(ts) {
  const root = state.project || ts.meta.cwd;
  if (!ts.tree || ts.tree.root !== root) ts.tree = { root, expanded: new Set(), cache: new Map() };
  if (!ts.tree.cache.has(ts.tree.root)) {
    try { const d = await atom.files.list(ts.tree.root); ts.tree.cache.set(ts.tree.root, d.entries); }
    catch { ts.tree.cache.set(ts.tree.root, null); }
  }
  setWatchRoot(ts.tree.root);   // watch the active tree root for external changes
}

// Tell the main process which folder to watch (only when it actually changes).
function setWatchRoot(root) {
  if (!root || root === state._watchedRoot) return;
  state._watchedRoot = root;
  try { atom.files.watch(root); } catch { /* ignore */ }
}

function renderTree() {
  if (state.sidebarView !== "files") return;   // the Git/Changes view owns #fileTree right now — don't clobber it
  const ts = activeTS();
  const host = $("fileTree");
  host.innerHTML = "";
  if (!ts) return;
  const root = ts.tree.root;
  const entries = ts.tree.cache.get(root);
  if (entries === null) { host.append(h("div", { class: "tree-empty", text: "Folder not accessible." })); return; }
  if (!entries) { host.append(h("div", { class: "tree-loading", text: "Loading…" })); return; }
  const editedSet = new Set(ts.editedFiles.map((f) => f.path));
  renderTreeLevel(host, entries, 0, ts, editedSet);
}

// Highlight the row of the currently-open editor file (without rebuilding the
// tree). Called whenever the active editor file changes.
function highlightTreeFile() {
  if (state.sidebarView !== "files") return;
  const host = $("fileTree"); if (!host) return;
  host.querySelectorAll(".tree-row.active").forEach((r) => r.classList.remove("active"));
  const active = state.editor.active;
  if (!active) return;
  let row = null;
  try { row = host.querySelector(`.tree-row[data-path="${CSS.escape(active)}"]`); } catch { /* invalid selector */ }
  if (row && row.dataset.dir === "0") row.classList.add("active");
}

function renderTreeLevel(host, entries, depth, ts, editedSet) {
  if (!entries.length) { host.append(h("div", { class: "tree-empty", style: `padding-left:${12 + depth * 14}px`, text: "empty" })); return; }
  for (const e of entries) {
    const isOpen = ts.tree.expanded.has(e.path);
    const row = h("div", {
      class: "tree-row" + (e.isDir ? " is-dir" : "") + (isOpen ? " open" : "") + (e.skip || e.hidden ? " dim" : "") + (e.isDir && e.path === state.selectedFolder ? " selected" : "") + (!e.isDir && e.path === state.editor.active ? " active" : ""),
      style: `padding-left:${6 + depth * 14}px`,
      dataset: { path: e.path, dir: e.isDir ? "1" : "0" },
      onclick: () => {
        if (e.isDir) { state.selectedFolder = e.path; state.findContext = "folder"; toggleDir(e); }
        else { state.findContext = "editor"; openInEditor(e.path); }
      },
      oncontextmenu: (ev) => { ev.preventDefault(); if (e.isDir) state.selectedFolder = e.path; fileContextMenu(ev, e); },
    },
      e.isDir ? h("span", { class: "tw-chev", html: icon("chevron", 13) }) : h("span", { class: "tw-chev" }),
      e.isDir
        ? h("span", { class: "tw-icon ft-folder", html: icon(isOpen ? "folderOpen" : "folder", 15) })
        : (function () { const m = fileMeta(e.name); return h("span", { class: "tw-icon " + m.cls, html: icon(m.ic, 15) }); })(),
      h("span", { class: "tw-name" + (e.isDir ? "" : " " + fileMeta(e.name).cls), text: e.name }),
      editedSet.has(e.path) ? h("span", { class: "edit-badge", html: icon("dot", 10) }) : null);
    host.append(row);
    if (e.isDir && isOpen) {
      const children = ts.tree.cache.get(e.path);
      const childHost = h("div", { class: "tree-children" });
      host.append(childHost);
      if (children === undefined) childHost.append(h("div", { class: "tree-loading", style: `padding-left:${12 + (depth + 1) * 14}px`, text: "Loading…" }));
      else if (children === null) childHost.append(h("div", { class: "tree-empty", text: "—" }));
      else renderTreeLevel(childHost, children, depth + 1, ts, editedSet);
    }
  }
}

async function toggleDir(e) {
  const ts = activeTS();
  if (ts.tree.expanded.has(e.path)) { ts.tree.expanded.delete(e.path); renderTree(); return; }
  ts.tree.expanded.add(e.path);
  if (!ts.tree.cache.has(e.path)) {
    renderTree();
    try { const d = await atom.files.list(e.path); ts.tree.cache.set(e.path, d.entries); }
    catch { ts.tree.cache.set(e.path, null); }
  }
  renderTree();
}

async function refreshTree(silent) {
  const ts = activeTS();
  if (!ts) return;
  ts.tree.cache.clear();
  await ensureTreeRoot(ts);
  // reload expanded dirs
  for (const p of ts.tree.expanded) { try { const d = await atom.files.list(p); ts.tree.cache.set(p, d.entries); } catch { ts.tree.cache.set(p, null); } }
  renderTree();
  if (!silent) toast("File tree refreshed", "refresh");   // silent when called as a side-effect of a git op (keeps the git summary toast)
}

let _fsChangeT = 0;
// An external change under the watched root (another app/editor, the AI agent's
// edits, or a git operation) → resync the file tree, the git status (when the
// commit view is showing), and any open editor files. Debounced so a burst of
// filesystem events triggers a single resync.
function onFsChanged() {
  if (state._fsSyncOff) return;   // test seam: suites that inject fake state disable this
  clearTimeout(_fsChangeT);
  _fsChangeT = setTimeout(async () => {
    try { await refreshTree(true); } catch { /* ignore */ }
    if (state.sidebarView === "git") { try { await refreshGit(); } catch { /* ignore */ } }
    try { await syncOpenFilesFromDisk(); } catch { /* ignore */ }
  }, 180);
}

// Reload open editor files whose on-disk content changed out from under us.
// Files with UNSAVED edits are never clobbered — they keep the user's text and
// raise a one-time "changed on disk" notice instead.
async function syncOpenFilesFromDisk() {
  if (!state.editor.open.length) return;
  const reloaded = new Set(); let conflict = null, changed = false;
  for (const f of state.editor.open.slice()) {
    let data;
    try { data = await atom.files.read(f.path); } catch { data = null; }
    if (!data || data.error || data.tooLarge || data.isBinary) continue;
    const disk = (data.content || "").replace(/\r\n/g, "\n");
    if (disk === f.saved) { if (f._diskConflict) { f._diskConflict = false; changed = true; } continue; }
    if (f.dirty) { if (!f._diskConflict) { f._diskConflict = true; conflict = f; changed = true; } continue; }
    f.content = disk; f.saved = disk; f._diskConflict = false; f._stale = false; changed = true;
    f.eol = /\r\n/.test(data.content || "") ? "crlf" : "lf";
    reloaded.add(f.path);
  }
  // Reload any pane currently showing a file whose disk content changed.
  if (reloaded.size) for (let p = 0; p < 2; p++) if (state.editor.panes[p] && reloaded.has(state.editor.panes[p])) loadPaneFile(p, true);
  if (changed) { renderEditorTabs(); const af = stateActiveFile(); if (af) updateEditorStatus(af); }
  gitGutterRefreshAll();   // external git ops (checkout/pull) change the diff vs HEAD
  if (conflict) toast(`"${conflict.name}" changed on disk — your unsaved edits were kept`, "alert", { ms: 4500 });
}

// File-type metadata for editor tabs + the project tree. Each entry maps to
// an existing icon and a CSS class — the class drives a subtle WebStorm-style
// colour on the icon glyph + a muted tint on the filename. Extensions match
// case-insensitively; filename special-cases (e.g. Dockerfile, package.json)
// override the extension match. Unknown types fall back to a plain "file"
// glyph in the default text colour.
const FILE_TYPE_BY_EXT = {
  // JS/TS family
  js: "js", mjs: "js", cjs: "js", jsx: "jsx",
  ts: "ts", tsx: "tsx", "d.ts": "ts",
  // Web
  html: "html", htm: "html",
  css: "css", scss: "scss", sass: "scss", less: "css",
  vue: "vue", svelte: "svelte", astro: "astro",
  // Data
  json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml", toml: "yaml",
  xml: "xml", csv: "csv", tsv: "csv",
  // Backend langs
  py: "py", rb: "rb", php: "php", go: "go", rs: "rs",
  java: "java", kt: "kt", swift: "swift", scala: "scala",
  c: "c", cc: "c", cpp: "c", h: "c", hpp: "c", cs: "cs",
  // Shell + scripts
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
  bat: "bat", cmd: "bat", ps1: "ps", psm1: "ps",
  // Docs
  md: "md", markdown: "md", mdx: "md",
  txt: "txt", rst: "txt", adoc: "txt",
  pdf: "pdf",
  // Config / DevOps
  env: "env", ini: "ini", cfg: "ini", conf: "ini",
  lock: "lock",
  dockerfile: "docker",
  // Images
  png: "img", jpg: "img", jpeg: "img", gif: "img", webp: "img",
  svg: "svg", ico: "img", bmp: "img",
  // Misc
  sql: "sql",
  ipynb: "ipynb",
  proto: "proto",
  gradle: "gradle",
  log: "log",
};
const FILE_TYPE_BY_NAME = {
  "package.json": "pkg-json", "package-lock.json": "lock",
  "tsconfig.json": "tsconfig", "tsconfig.base.json": "tsconfig",
  "jsconfig.json": "tsconfig",
  "dockerfile": "docker", "docker-compose.yml": "docker", "docker-compose.yaml": "docker",
  ".dockerignore": "docker",
  ".gitignore": "git", ".gitattributes": "git", ".gitkeep": "git",
  ".npmrc": "npm", ".npmignore": "npm",
  ".env": "env", ".env.local": "env", ".env.development": "env", ".env.production": "env",
  ".eslintrc": "lint", ".eslintrc.json": "lint", ".eslintrc.js": "lint", ".eslintrc.cjs": "lint",
  ".prettierrc": "lint", ".prettierrc.json": "lint", "prettier.config.js": "lint",
  "makefile": "makefile",
  "readme.md": "readme", "readme": "readme",
  "license": "license", "license.md": "license", "license.txt": "license",
  "changelog.md": "md",
};
// Each type → { ic: <existing icon name from icons.js>, cls: "ft-<type>" }.
// The cls hooks the CSS-var colour pair (icon + name tint). Icon names
// reuse what's already in icons.js so we don't bloat the SVG bundle.
const FILE_TYPE_META = {
  js:        { ic: "jsLetters",  cls: "ft-js" },
  jsx:       { ic: "atom",       cls: "ft-jsx" },         // React component — atomic-orbital glyph
  ts:        { ic: "tsLetters",  cls: "ft-ts" },
  tsx:       { ic: "atom",       cls: "ft-tsx" },         // React component (TS)
  html:      { ic: "globe",    cls: "ft-html" },
  css:       { ic: "fileCode", cls: "ft-css" },
  scss:      { ic: "fileCode", cls: "ft-scss" },
  vue:       { ic: "fileCode", cls: "ft-vue" },
  svelte:    { ic: "fileCode", cls: "ft-svelte" },
  astro:     { ic: "fileCode", cls: "ft-astro" },
  json:      { ic: "jsonBraces", cls: "ft-json" },
  yaml:      { ic: "list",     cls: "ft-yaml" },
  xml:       { ic: "fileCode", cls: "ft-xml" },
  csv:       { ic: "list",     cls: "ft-csv" },
  py:        { ic: "fileCode", cls: "ft-py" },
  rb:        { ic: "fileCode", cls: "ft-rb" },
  php:       { ic: "fileCode", cls: "ft-php" },
  go:        { ic: "fileCode", cls: "ft-go" },
  rs:        { ic: "fileCode", cls: "ft-rs" },
  java:      { ic: "fileCode", cls: "ft-java" },
  kt:        { ic: "fileCode", cls: "ft-kt" },
  swift:     { ic: "fileCode", cls: "ft-swift" },
  scala:     { ic: "fileCode", cls: "ft-scala" },
  c:         { ic: "fileCode", cls: "ft-c" },
  cs:        { ic: "fileCode", cls: "ft-cs" },
  sh:        { ic: "terminal", cls: "ft-sh" },
  bat:       { ic: "terminal", cls: "ft-bat" },
  ps:        { ic: "terminal", cls: "ft-ps" },
  md:        { ic: "file",     cls: "ft-md" },
  txt:       { ic: "file",     cls: "ft-txt" },
  pdf:       { ic: "file",     cls: "ft-pdf" },
  env:       { ic: "key",      cls: "ft-env" },
  ini:       { ic: "settings", cls: "ft-ini" },
  lock:      { ic: "shield",   cls: "ft-lock" },
  docker:    { ic: "cpu",      cls: "ft-docker" },
  img:       { ic: "image",    cls: "ft-img" },
  svg:       { ic: "image",    cls: "ft-svg" },
  sql:       { ic: "list",     cls: "ft-sql" },
  ipynb:     { ic: "fileCode", cls: "ft-py" },
  proto:     { ic: "fileCode", cls: "ft-proto" },
  gradle:    { ic: "fileCode", cls: "ft-gradle" },
  log:       { ic: "file",     cls: "ft-log" },
  "pkg-json":{ ic: "jsonBraces", cls: "ft-pkgjson" },
  tsconfig:  { ic: "jsonBraces", cls: "ft-tsconfig" },
  git:       { ic: "git",      cls: "ft-git" },
  npm:       { ic: "list",     cls: "ft-npm" },
  lint:      { ic: "check",    cls: "ft-lint" },
  makefile:  { ic: "terminal", cls: "ft-makefile" },
  readme:    { ic: "file",     cls: "ft-readme" },
  license:   { ic: "shield",   cls: "ft-license" },
};
// Look up icon + class for one filename. Special-case names (Dockerfile,
// README, .env, package.json…) win over the trailing-extension match.
function fileMeta(name) {
  if (!name) return { ic: "file", cls: "" };
  const low = String(name).toLowerCase();
  const byName = FILE_TYPE_BY_NAME[low];
  if (byName && FILE_TYPE_META[byName]) return FILE_TYPE_META[byName];
  // Handle compound extensions like ".d.ts" before plain ".ts".
  if (low.endsWith(".d.ts") && FILE_TYPE_META.ts) return FILE_TYPE_META.ts;
  const dot = low.lastIndexOf(".");
  if (dot < 0 || dot === low.length - 1) return { ic: "file", cls: "" };
  const ext = low.slice(dot + 1);
  const type = FILE_TYPE_BY_EXT[ext];
  return (type && FILE_TYPE_META[type]) || { ic: "file", cls: "" };
}
// Back-compat: keep the old single-icon-name API for any caller still using it.
function fileIcon(extOrName) { return fileMeta(extOrName).ic; }

/* ---- tree file operations -------------------------------------------------
 * The tree could read, reveal and open, but never create, rename or delete —
 * every one of those meant leaving the app or asking the agent to do it. */
function parentDir(p) { return String(p || "").replace(/[\\/][^\\/]*$/, "") || p; }

function promptNewEntry(parent, isDir) {
  promptDialog({
    title: isDir ? "New folder" : "New file",
    ic: isDir ? "folderPlus" : "file",
    placeholder: isDir ? "components" : "utils.ts",
    confirmLabel: "Create",
    onConfirm: async (name) => {
      name = (name || "").trim();
      if (!name) return;
      // A path in the name creates the intermediate folders — "a/b/c.ts" just works.
      const target = parent.replace(/[\\/]+$/, "") + "/" + name.replace(/^[\\/]+/, "");
      try {
        if (isDir) await atom.files.createFolder(target);
        else await atom.files.createFile(target, "");
        await refreshTree(true);
        if (!isDir) await openInEditor(target);
        toast(`Created ${esc(baseName(target))}`, "checkCircle", { ms: 2200 });
      } catch (err) { toast(`Create failed: ${esc(err.message)}`, "alert", { ms: 6000 }); }
    },
  });
}

function promptRename(e) {
  promptDialog({
    title: "Rename", ic: "edit", value: e.name, placeholder: e.name, confirmLabel: "Rename",
    onConfirm: async (name) => {
      name = (name || "").trim();
      if (!name || name === e.name) return;
      try {
        // state.project lets the language service rewrite the imports that
        // pointed at the old path — see files:rename in main.
        const r = await atom.files.rename(e.path, name, state.project);
        await refreshTree(true);
        // Keep an open editor tab pointing at the file under its new name.
        const open = state.editor.open.find((f) => f.path === e.path);
        if (open) { closeEditorFile(e.path); if (!r.isDir) await openInEditor(r.path); }
        const fixed = r.refactor && r.refactor.files
          ? ` — updated imports in ${r.refactor.files} file${r.refactor.files === 1 ? "" : "s"}`
          : "";
        toast(`Renamed to ${esc(baseName(r.path))}${fixed}`, "checkCircle", { ms: 3600 });
      } catch (err) { toast(`Rename failed: ${esc(err.message)}`, "alert", { ms: 6000 }); }
    },
  });
}

function confirmDelete(e) {
  chooseDialog({
    title: e.isDir ? "Delete folder" : "Delete file", ic: "trash",
    message: `Move “${e.name}” to the Recycle Bin?${e.isDir ? " Everything inside goes with it." : ""}`,
    choices: [
      { label: "Delete", value: "del", primary: true },
      { label: "Cancel", value: null },
    ],
  }).then(async (choice) => {
    if (choice !== "del") return;
    try {
      await atom.files.trash(e.path);
      if (!e.isDir) closeEditorFile(e.path);   // sync, and a no-op when it isn't open
      await refreshTree(true);
      toast(`${esc(e.name)} moved to the Recycle Bin`, "checkCircle", { ms: 2600 });
    } catch (err) { toast(`Delete failed: ${esc(err.message)}`, "alert", { ms: 6000 }); }
  });
}

async function fileContextMenu(ev, e) {
  const x = ev.clientX, y = ev.clientY;
  const ts = activeTS();
  const items = [
    { label: "Copy absolute path", icon: "copy", onClick: () => copyText('"' + e.path + '"', "Absolute path copied") },
    { label: "Copy relative path", icon: "copy", onClick: () => copyText(relPath(e.path, ts.meta.cwd), "Relative path copied") },
    { label: "Copy name", icon: "copy", onClick: () => copyText(e.name, "Name copied") },
    { sep: true },
    { label: "Reveal in File Explorer", icon: "external", onClick: () => atom.files.reveal(e.path) },
  ];
  // Folders get "Search folder" (replacing the old OS "Open folder"); files keep OS-open.
  if (e.isDir) items.push({ label: "Search folder", icon: "search", onClick: () => openSearch({ mode: "content", root: e.path }) });
  else items.push({ label: "Open file (default app)", icon: "external", onClick: () => atom.files.open(e.path) });
  /* Create / rename / delete. New items land INSIDE a folder and BESIDE a file,
   * which is what every file tree does and what the click position implies. */
  const parent = e.isDir ? e.path : parentDir(e.path);
  items.push(
    { sep: true },
    { label: "New file…", icon: "file", onClick: () => promptNewEntry(parent, false) },
    { label: "New folder…", icon: "folderPlus", onClick: () => promptNewEntry(parent, true) },
    { label: "Rename…", icon: "edit", onClick: () => promptRename(e) },
    { label: "Delete", icon: "trash", onClick: () => confirmDelete(e) },
  );
  if (!e.isDir) items.splice(5, 0, { label: "Open in editor", icon: "fileCode", onClick: () => openInEditor(e.path) });
  if (e.isDir) {
    items.push(
      { sep: true },
      { label: "Open Terminal here", icon: "terminal", onClick: () => atom.files.openTerminal(e.path).catch((err) => toast("Couldn't open terminal: " + err.message, "alert")) },
      { label: "Set as working folder", icon: "folderOpen", onClick: () => setWorkingFolder(e.path) });
    // If this folder is a git repo, offer Pull (commit/push live in the panel).
    let isRepo = false; try { isRepo = await atom.git.isRepoDir(e.path); } catch { /* ignore */ }
    if (isRepo) items.push({ sep: true }, { label: "Git pull", icon: "pull", onClick: () => gitPull(e.path) }, { label: "Open commit view", icon: "commit", onClick: () => setSidebarView("git") });
  }
  items.push({ sep: true }, { label: e.isDir ? "Delete folder" : "Delete file", icon: "trash", danger: true, onClick: () => deleteTreeItem(e) });
  showContextMenu(x, y, items);
}

function deleteTreeItem(e) {
  confirmDialog({
    title: e.isDir ? "Delete folder?" : "Delete file?",
    message: `"${e.name}" will be moved to the Recycle Bin.`,
    danger: true, confirmLabel: "Delete",
    onConfirm: async () => {
      try { await atom.files.trash(e.path); }
      catch (err) { toast("Delete failed: " + err.message, "alert"); return; }
      // close it in the editor if open (no unsaved prompt — it's gone)
      const oi = state.editor.open.findIndex((f) => f.path === e.path);
      if (oi >= 0) {
        state.editor.open.splice(oi, 1);
        if (state.editor.active === e.path) state.editor.active = state.editor.open[0] ? state.editor.open[0].path : null;
        updateEditorLayout();
      }
      if (state.selectedFolder === e.path) state.selectedFolder = null;
      await refreshTree();
      toast((e.isDir ? "Folder" : "File") + " moved to Recycle Bin", "trash");
    },
  });
}

// Re-root THIS window to a subfolder (tree + new sessions).
async function setWorkingFolder(folder) {
  state.project = folder;
  state.settings.lastFolder = folder;
  pushRecent(folder);
  applyWindowTitle();
  for (const ts of state.tabs.values()) ts.tree = null;
  await atom.settings.set({ lastFolder: folder });
  await renderSidebar();
  persistTabs();
  toast("Project folder set to " + baseName(folder), "folderOpen");
}

/* ============================================================
   PROJECTS / MULTI-WINDOW
   ============================================================ */
// Persistent recents (most-recent first), shared across windows.
function pushRecent(p) {
  if (!p) return;
  let arr = (state.settings.recentProjects || []).filter((x) => !samePath(x, p));
  arr.unshift(p);
  arr = arr.slice(0, 15);
  state.settings.recentProjects = arr;
  atom.settings.set({ recentProjects: arr }).catch(() => {});
}
function removeRecent(p) {
  state.settings.recentProjects = (state.settings.recentProjects || []).filter((x) => !samePath(x, p));
  atom.settings.set({ recentProjects: state.settings.recentProjects }).catch(() => {});
}
function seedRecentsIfEmpty(sessions) {
  if ((state.settings.recentProjects || []).length) return;
  const seen = new Set(); const arr = [];
  for (const s of (sessions || []).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))) {
    const k = projectKeyOf(s.cwd); if (s.cwd && !seen.has(k)) { seen.add(k); arr.push(s.cwd); }
  }
  if (arr.length) { state.settings.recentProjects = arr.slice(0, 15); atom.settings.set({ recentProjects: state.settings.recentProjects }).catch(() => {}); }
}

function closeProjectMenu() {
  const m = $("projMenu"); if (m) m.remove();
  document.removeEventListener("mousedown", projMenuOutside, true);
}
function projMenuOutside(e) {
  const m = $("projMenu"); const bar = document.querySelector(".folder-pick");
  if (m && !m.contains(e.target) && !(bar && bar.contains(e.target))) closeProjectMenu();
}
function buildRecents(sub) {
  sub.innerHTML = "";
  const recents = (state.settings.recentProjects || []).filter((p) => !samePath(p, state.project));
  if (!recents.length) { sub.append(h("div", { class: "pm-empty", text: "No recent projects" })); return; }
  for (const p of recents) {
    sub.append(h("div", { class: "pm-recent", title: p, onclick: () => { closeProjectMenu(); chooseOpenProject(p); } },
      h("span", { class: "pm-fico", html: icon("folderOpen", 14) }),
      h("span", { class: "pm-rmeta" }, h("span", { class: "pm-rname", text: baseName(p) }), h("span", { class: "pm-rpath", text: p })),
      h("button", { class: "pm-x", title: "Remove from recents", html: icon("close", 12), onclick: (ev) => { ev.stopPropagation(); removeRecent(p); buildRecents(sub); } })));
  }
}
function openProjectMenu(e) {
  if ($("projMenu")) { closeProjectMenu(); return; }
  const r = e.currentTarget.getBoundingClientRect();
  const menu = h("div", { class: "proj-menu", id: "projMenu" });
  const sub = h("div", { class: "pm-sub" });
  buildRecents(sub);
  menu.append(
    h("div", { class: "pm-item", onclick: () => { closeProjectMenu(); pickAndOpenProject(); } },
      h("span", { class: "pm-ico", html: icon("folderPlus", 15) }), h("span", { class: "pm-label", text: "Open Folder…" })),
    h("div", { class: "pm-item pm-has-sub" },
      h("span", { class: "pm-ico", html: icon("history", 15) }), h("span", { class: "pm-label", text: "Recents" }),
      h("span", { class: "pm-arrow", html: icon("chevron", 13) }), sub),
    h("div", { class: "pm-item", onclick: () => { closeProjectMenu(); openSettings(); } },
      h("span", { class: "pm-ico", html: icon("settings", 15) }), h("span", { class: "pm-label", text: "Settings" })));
  document.body.append(menu);
  const mw = menu.offsetWidth;
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + "px";
  menu.style.top = (r.bottom + 4) + "px";
  setTimeout(() => document.addEventListener("mousedown", projMenuOutside, true), 0);
}

async function pickAndOpenProject() {
  const picked = await atom.dialog.pickFolder(state.project);
  if (picked) chooseOpenProject(picked);
}

// A fresh "New Window" (from the taskbar): pick a project and open it IN this
// window — unless it's already open elsewhere, then focus that one.
async function pickProjectForNewWindow() {
  const picked = await atom.dialog.pickFolder(state.project);
  if (!picked || samePath(picked, state.project)) return;
  if (await atom.win.isOpen(picked).catch(() => false)) {
    atom.win.openProject(picked);   // focus the existing window
    toast(`“${baseName(picked)}” is already open — switched to its window`, "folderOpen");
    return;
  }
  pushRecent(picked); switchProjectInPlace(picked);
}

async function chooseOpenProject(path) {
  if (samePath(path, state.project)) return;
  // If this folder is already open in another window, just focus it — never a duplicate.
  if (await atom.win.isOpen(path).catch(() => false)) {
    pushRecent(path); atom.win.openProject(path);
    toast(`“${baseName(path)}” is already open — switched to its window`, "folderOpen");
    return;
  }
  chooseDialog({
    title: "Open project", ic: "folderOpen",
    message: `Open “${baseName(path)}” in a new window, or switch this window to it?`,
    choices: [
      { label: "New window", value: "new", primary: true },
      { label: "This window", value: "this" },
      { label: "Cancel", value: null },
    ],
  }).then((choice) => {
    if (choice === "new") { pushRecent(path); atom.win.openProject(path); }
    else if (choice === "this") { pushRecent(path); switchProjectInPlace(path); }
  });
}

async function switchProjectInPlace(path) {
  saveProjectState();
  state.project = path;
  // Tell main this window is now THIS project, then load THIS project's settings
  // (provider/model/theme/… are per-project) and re-apply them.
  await atom.win.setProject(path).catch(() => {});
  try {
    state.settings = await atom.settings.get();
    applyTheme(state.settings.theme || state.settings.accent || "amber");
    applyFontSize(state.settings.fontSize);
    await loadProviderModels(state.settings.llmProvider || "anthropic");
    if (providerDD) providerDD._refresh(); if (modelDD) modelDD._refresh(); if (thinkDD) thinkDD._refresh(); if (permDD) permDD._refresh();
    updateOneMVisibility();
  } catch { /* keep current settings on failure */ }
  state.settings.lastFolder = path;
  applyWindowTitle();
  state.tabs.clear(); state.order = [];
  state.editor.open = []; state.editor.active = null;
  state.editor.split = false; state.editor.panes = [null, null]; state.editor.focused = 0;
  if (editors[1]) { editors[1].destroy(); editors[1] = null; }
  const list = await atom.sessions.list();
  const pt = await atom.project.getTabs(path).catch(() => null);
  let open = ((pt && pt.openTabIds) || []).filter((id) => list.find((s) => s.id === id));
  if (!open.length) { const inProj = list.filter((s) => samePath(s.cwd, path)).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")); if (inProj.length) open = [inProj[0].id]; }
  if (!open.length) { const s = await atom.sessions.create({ cwd: path }); open = [s.id]; }
  for (const id of open) { const v = await atom.sessions.get(id); if (v) addTabState(v); }
  state.order = open.filter((id) => state.tabs.has(id));
  state.activeTabId = (pt && state.tabs.has(pt.activeTabId)) ? pt.activeTabId : state.order[0];
  updateEditorLayout();
  renderTabs();
  await switchTab(state.activeTabId, true);
  const savedFiles = (pt && pt.editorOpenFiles) || [];
  for (const p of savedFiles) { const sz = await atom.files.size(p).catch(() => -1); if (sz >= 0 && sz <= 5 * 1024 * 1024) await openInEditor(p, true); }  // skip missing/huge on restore
  if (pt && pt.editorActiveFile && state.editor.open.find((f) => f.path === pt.editorActiveFile)) activateEditorFile(pt.editorActiveFile);
  restoreSplit(pt);
  await atom.settings.set({ lastFolder: path });
  toast("Switched to " + baseName(path), "folderOpen");
}

// Re-open a saved split layout (two panes) from persisted project state.
function restoreSplit(pt) {
  if (!pt || !pt.editorSplit || state.editor.open.length < 1) return;
  const has = (p) => p && state.editor.open.find((f) => f.path === p);
  const p0 = has(pt.editorPanes && pt.editorPanes[0]) ? pt.editorPanes[0] : state.editor.active;
  let p1 = has(pt.editorPanes && pt.editorPanes[1]) ? pt.editorPanes[1] : null;
  if (!p1) p1 = (state.editor.open.find((f) => f.path !== p0) || {}).path || p0;
  if (!p0 || !p1) return;
  state.editor.split = true;
  state.editor.splitDir = pt.editorSplitDir === "h" ? "h" : "v";
  state.editor.panes = [p0, p1];
  state.editor.focused = 0;
  state.editor.active = p0;
  renderEditor();
}

// A small modal with 2–3 choice buttons → resolves to the chosen value (or null).
function chooseDialog({ title, ic, message, choices }) {
  return new Promise((resolve) => {
    let result = null, done = false;
    const finish = () => { if (done) return; done = true; resolve(result); };
    const buttons = choices.map((c) => h("button", {
      class: "btn " + (c.primary ? "btn-primary" : "btn-ghost"),
      text: c.label, onclick: () => { result = c.value; closeModal(back); },
    }));
    const back = modalShell({
      title: title || "Choose", ic: ic || "folderOpen",
      body: h("div", { style: "color:var(--text-2); line-height:1.6; font-size:13.5px", text: message || "" }),
      footer: buttons,
    });
    back.addEventListener("modal-closed", finish);   // × / backdrop / Escape → null, never a dangling Promise
  });
}

/* ============================================================
   FILE VIEWER
   ============================================================ */
async function openFileViewer(filePath) {
  const data = await atom.files.read(filePath).catch((e) => ({ error: String(e) }));
  let body;
  if (data.error) body = h("div", { class: "error-card" }, h("span", { html: icon("alert", 18) }), data.error);
  else if (data.tooLarge) body = h("div", { class: "sys-note", text: `File is too large to preview (${(data.size / 1048576).toFixed(1)} MB).` });
  else if (data.isBinary) body = h("div", { class: "sys-note", text: "Binary file — cannot preview as text." });
  else body = h("div", {},
    h("div", { class: "fv-meta" }, h("span", { html: icon("file", 13) }), h("span", { text: filePath }), h("span", { text: `· ${data.content.split("\n").length} lines` })),
    h("pre", { class: "fv-pre", text: data.content }));

  const back = modalShell({
    title: baseName(filePath), ic: "file", wide: true, body,
    footer: [
      h("button", { class: "btn btn-ghost btn-sm", text: "Reveal in Explorer", onclick: () => atom.files.reveal(filePath) }),
      h("button", { class: "btn btn-ghost btn-sm", text: "Open externally", onclick: () => atom.files.open(filePath) }),
      data && data.content ? h("button", { class: "btn btn-ghost btn-sm", text: "Copy contents", onclick: () => copyText(data.content, "File contents copied") }) : null,
      h("button", { class: "btn btn-primary btn-sm", text: "Close", onclick: () => closeModal(back) }),
    ],
  });
}

/* ============================================================
   COMPOSER
   ============================================================ */
let providerDD, modelDD, thinkDD, permDD;

// "Reviewers" — pick provider+model combos to consult before / review after.
// Reviewer providers — includes Claude so you can have a second Claude model
// critique the primary's answer (the primary's own model is excluded below).
const RV_PROVIDERS = [
  { id: "anthropic", name: "Claude (Anthropic)", ph: "default model" },
  { id: "openai", name: "Codex (OpenAI)", ph: "gpt-5.5" },
];
let _rvPop = null;
function reviewersControl() {
  const btn = h("button", { id: "reviewersBtn", class: "rv-btn", onclick: (e) => { e.stopPropagation(); toggleReviewersPopover(btn); } });
  btn._refresh = () => { const n = (state.settings.reviewers || []).length; btn.innerHTML = `${icon("shield", 14, "dd-ico")}<span>Reviewers${n ? " · " + n : ""}</span>`; btn.classList.toggle("active", n > 0); };
  btn._refresh();
  return btn;
}
function closeReviewersPopover() { if (_rvPop) { _rvPop.remove(); _rvPop = null; document.removeEventListener("mousedown", _rvOutside, true); } }
function _rvOutside(e) { if (_rvPop && !_rvPop.contains(e.target) && !e.target.closest("#reviewersBtn")) closeReviewersPopover(); }
function toggleReviewersPopover(anchor) {
  if (_rvPop) { closeReviewersPopover(); return; }
  const pop = h("div", { class: "rv-pop" });
  const renderPop = () => {
    pop.innerHTML = "";
    const mode = state.settings.reviewMode === "after" ? "after" : "before";
    pop.append(h("div", { class: "rv-pop-head" }, h("span", { html: icon("shield", 13) }), h("span", { text: "Reviewers" })));
    pop.append(h("div", { class: "rv-mode" },
      h("button", { class: "rv-mode-b" + (mode === "before" ? " active" : ""), text: "Consult before", title: "Reviewers advise, then Claude answers", onclick: () => { setSharedSetting("reviewMode", "before"); renderPop(); } }),
      h("button", { class: "rv-mode-b" + (mode === "after" ? " active" : ""), text: "Review after", title: "Claude answers, then reviewers critique", onclick: () => { setSharedSetting("reviewMode", "after"); renderPop(); } })));
    const primaryProv = state.settings.llmProvider || "anthropic";
    for (const prov of RV_PROVIDERS) {
      const cur = (state.settings.reviewers || []).find((r) => r.provider === prov.id);
      const cb = h("input", { type: "checkbox", class: "aqx-check" }); cb.checked = !!cur;
      // Model picker from the provider catalog. For the provider that's the
      // current primary, drop the primary model so a reviewer is always a
      // DIFFERENT model (review with a fresh perspective).
      const cat = (state.providerCatalog && state.providerCatalog[prov.id]) || { models: [] };
      const exclude = prov.id === primaryProv ? state.settings.defaultModel : null;
      const opts = (cat.models || []).filter((m) => m.id !== exclude);
      const model = h("select", { class: "rv-model input" });
      model.append(h("option", { value: "", text: "Default model" }));
      for (const m of opts) model.append(h("option", { value: m.id, text: m.name }));
      model.value = cur ? (cur.model || "") : "";
      const sync = () => {
        const arr = (state.settings.reviewers || []).filter((r) => r.provider !== prov.id);
        if (cb.checked) arr.push({ provider: prov.id, model: (model.value || "").trim() });
        setSharedSetting("reviewers", arr);
        const b = $("reviewersBtn"); if (b && b._refresh) b._refresh();
      };
      cb.addEventListener("change", sync); model.addEventListener("change", sync);
      pop.append(h("label", { class: "rv-row" }, cb, h("span", { class: "rv-prov", text: prov.name }), model));
    }
    pop.append(h("div", { class: "rv-pop-hint", text: "Reviewers run via their CLIs (authorize in Settings)." }));
  };
  renderPop();
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + "px";
  _rvPop = pop;
  setTimeout(() => document.addEventListener("mousedown", _rvOutside, true), 0);
}

// "Roles" — a per-session Planner that drafts a plan (its OWN provider/model/
// effort) before the primary Coder implements it. Pipeline: Plan → Code → Review.
// The Coder is your primary model (the model dropdown); Reviewers keep their own
// button. Configured exactly like Reviewers, so it feels the same.
let _rolesPop = null;
function rolesControl() {
  const btn = h("button", { id: "rolesBtn", class: "rv-btn", onclick: (e) => { e.stopPropagation(); toggleRolesPopover(btn); } });
  btn._refresh = () => { const on = !!(state.settings.planner && state.settings.planner.enabled); btn.innerHTML = `${icon("sparkle", 14, "dd-ico")}<span>Roles${on ? " · Plan→Code" : ""}</span>`; btn.classList.toggle("active", on); };
  btn._refresh();
  return btn;
}
function closeRolesPopover() { if (_rolesPop) { _rolesPop.remove(); _rolesPop = null; document.removeEventListener("mousedown", _rolesOutside, true); } }
function _rolesOutside(e) { if (_rolesPop && !_rolesPop.contains(e.target) && !e.target.closest("#rolesBtn")) closeRolesPopover(); }
function toggleRolesPopover(anchor) {
  if (_rolesPop) { closeRolesPopover(); return; }
  const pop = h("div", { class: "rv-pop" });
  const getP = () => (state.settings.planner && typeof state.settings.planner === "object") ? state.settings.planner : { enabled: false, provider: "openai", model: "", effort: "" };
  const save = (patch) => { const p = { ...getP(), ...patch }; setSharedSetting("planner", p); const b = $("rolesBtn"); if (b && b._refresh) b._refresh(); };
  const render = () => {
    pop.innerHTML = "";
    const p = getP();
    pop.append(h("div", { class: "rv-pop-head" }, h("span", { html: icon("sparkle", 13) }), h("span", { text: "Roles — Plan → Code → Review" })));

    const cb = h("input", { type: "checkbox", class: "aqx-check" }); cb.checked = !!p.enabled;
    cb.addEventListener("change", () => save({ enabled: cb.checked }));
    const prov = h("select", { class: "rv-model input" });
    for (const rp of RV_PROVIDERS) prov.append(h("option", { value: rp.id, text: rp.name }));
    prov.value = p.provider || "openai";
    const cat = () => (state.providerCatalog && state.providerCatalog[prov.value]) || { models: [], reasoningLevels: [] };
    const model = h("select", { class: "rv-model input" });
    const effort = h("select", { class: "rv-model input" });
    const fillModel = () => { model.innerHTML = ""; model.append(h("option", { value: "", text: "Default model" })); for (const m of (cat().models || [])) model.append(h("option", { value: m.id, text: m.name })); model.value = p.model || ""; };
    const fillEffort = () => { effort.innerHTML = ""; effort.append(h("option", { value: "", text: "Default effort" })); for (const lv of (cat().reasoningLevels || [])) effort.append(h("option", { value: lv.id, text: lv.name })); effort.value = p.effort || ""; };
    fillModel(); fillEffort();
    prov.addEventListener("change", () => { save({ provider: prov.value, model: "", effort: "" }); render(); });
    model.addEventListener("change", () => save({ model: model.value }));
    effort.addEventListener("change", () => save({ effort: effort.value }));
    pop.append(h("label", { class: "rv-row" }, cb, h("span", { class: "rv-prov", text: "Planner" }), prov));
    pop.append(h("div", { class: "rv-row", style: "padding-left:26px; gap:6px;" }, model, effort));

    const primModel = state.settings.defaultModel || "your primary model";
    pop.append(h("div", { class: "rv-pop-hint", text: `Coder = your primary model (${primModel}) — set it in the model dropdown. Reviewers run after (Reviewers button).` }));
    pop.append(h("div", { class: "rv-pop-hint", text: "The Planner drafts a plan (reads the repo, never edits), then the Coder implements it in the same session — different models, no context lost." }));
  };
  render();
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + "px";
  _rolesPop = pop;
  setTimeout(() => document.addEventListener("mousedown", _rolesOutside, true), 0);
}

/* ============================================================
   INTEGRATED TERMINAL — a themed shell panel docked at the bottom.
   "Open Terminal here" hands you off to the OS console: another window, its own
   colours, and output the app can never see. This keeps the shell in the app, so
   a skill install or a build is something you watch in place.
   Each tab is one child process (main/terminal.js). Per tab: interrupt, clear,
   close. Output is appended as it streams; scroll sticks to the bottom unless
   you have scrolled up to read something.
   ============================================================ */
const _term = { open: false, tabs: [], active: null, panes: new Map(), wired: false };

// The shell writes ANSI even with TERM=dumb (git, npm). Strip it rather than
// half-render it — colour is not worth an escape-sequence parser here.
function stripAnsi(s) { return String(s).replace(/\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\][^]*(|\\)/g, ""); }

/* A terminal gets one of two panes, chosen from its backend (meta.pty):
 *   - xterm.js grid, when the backend is a real PTY and the xterm bundle is
 *     present. A full terminal emulator: renders ANSI/colour/cursor, and every
 *     keystroke (arrows, Tab, Ctrl-C) is forwarded to the PTY, so npx installer
 *     menus and curses UIs work.
 *   - legacy <pre> + one input line, when there is no PTY (pipe fallback) or the
 *     xterm bundle wasn't built. You type a whole line and press Enter. */
function termIsXterm(id) {
  const m = _term.tabs.find((t) => t.id === id);
  return !!(window.Terminal && m && m.pty);
}

// Real terminal emulator. Nothing is echoed locally — the PTY echoes input, so
// what you type appears because the shell sent it back.
function makeXtermPane(id) {
  const host = h("div", { class: "term-xterm", dataset: { id } });
  const term = new window.Terminal({
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    fontFamily: "var(--font-mono), Consolas, 'Cascadia Mono', monospace",
    fontSize: 13,
    theme: { background: "#0b0d12", foreground: "#d6d9df", cursor: "#f0b000", cursorAccent: "#0b0d12" },
  });
  const fit = window.FitAddon ? new window.FitAddon() : null;
  if (fit) term.loadAddon(fit);
  term.open(host);
  try { fit && fit.fit(); } catch { /* not laid out yet — ResizeObserver will */ }
  // Keystrokes → PTY stdin.
  term.onData((d) => atom.terminal.write(id, d));
  // When the grid changes size, tell the PTY so wrapping / full-screen apps fit.
  term.onResize(({ cols, rows }) => atom.terminal.resize(id, cols, rows));
  // Refit as the dock / window resizes and when the tab is (re)shown.
  const ro = new ResizeObserver(() => { try { fit && fit.fit(); } catch { /* hidden */ } });
  ro.observe(host);
  return { el: host, term, fit, ro, mode: "xterm" };
}

function termPane(id) {
  let pane = _term.panes.get(id);
  if (pane) return pane;
  if (termIsXterm(id)) {
    pane = makeXtermPane(id);
    _term.panes.set(id, pane);
    return pane;
  }
  // Legacy line pane: a <pre> of transcript with the caret living INSIDE it, as
  // the last child, so you type right after the prompt the shell printed. Each
  // pane keeps its own half-typed line and history across tab switches.
  const input = h("input", { class: "term-input", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-label": "Terminal input" });
  const el = h("pre", { class: "term-out", dataset: { id } });
  el.append(input);
  el.addEventListener("mousedown", (e) => {
    if (e.target === input) return;
    setTimeout(() => { if (!String(window.getSelection())) input.focus(); }, 0);
  });
  pane = { el, input, history: [], hix: 0, mode: "legacy" };
  _term.panes.set(id, pane);
  wireTermInput(id, pane);
  return pane;
}

// Route one chunk of shell output to its pane: xterm renders raw ANSI, the
// legacy pane strips it.
function termWrite(id, chunk) {
  const pane = termPane(id);
  if (pane.mode === "xterm") pane.term.write(chunk);
  else termAppend(id, chunk);
}

function termAppend(id, chunk) {
  const pane = termPane(id);
  const el = pane.el;
  // "Stuck to the bottom" unless the user scrolled up — the usual terminal rule.
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  el.insertBefore(document.createTextNode(stripAnsi(chunk)), pane.input);
  // Cap the DOM: 4000 lines is far more scrollback than anyone reads, and an
  // unbounded <pre> makes a long `npm install` crawl. Only the transcript is
  // rebuilt — the caret is a sibling and has to survive it.
  if (el.childNodes.length > 900) {
    const text = el.textContent.split("\n").slice(-4000).join("\n");
    while (el.firstChild && el.firstChild !== pane.input) el.removeChild(el.firstChild);
    el.insertBefore(document.createTextNode(text), pane.input);
  }
  if (stick) el.scrollTop = el.scrollHeight;
}

/* The caret sizes itself to what you've typed. In a monospace <pre> a `ch` is
 * exactly one column, so the cursor lands where the next character will. */
function termGrow(input) { input.style.width = Math.max(1, input.value.length + 1) + "ch"; }

function wireTermInput(id, pane) {
  const input = pane.input;
  input.addEventListener("input", () => termGrow(input));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = input.value;
      input.value = ""; termGrow(input);
      if (cmd.trim()) { pane.history.push(cmd); if (pane.history.length > 200) pane.history.shift(); }
      pane.hix = pane.history.length;
      // No TTY means the shell never echoes what we sent, so the transcript would
      // read as answers with no questions. Write the line where it was typed.
      termAppend(id, cmd + "\n");
      atom.terminal.run(id, cmd);
      return;
    }
    // Ctrl+C is a copy when there's a selection and an interrupt when there isn't
    // — the same rule every terminal uses.
    if (e.key === "c" && (e.ctrlKey || e.metaKey) && !String(window.getSelection())) {
      e.preventDefault(); atom.terminal.interrupt(id); termAppend(id, "^C\n"); return;
    }
    if (e.key === "l" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); clearTerm(id); return; }
    // Command history, the one terminal affordance nobody forgives its absence.
    if (e.key === "ArrowUp") { e.preventDefault(); if (pane.hix > 0) { pane.hix--; input.value = pane.history[pane.hix] || ""; termGrow(input); } return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (pane.hix < pane.history.length - 1) { pane.hix++; input.value = pane.history[pane.hix] || ""; }
      else { pane.hix = pane.history.length; input.value = ""; }
      termGrow(input);
    }
  });
  termGrow(input);
}

function renderTermTabs() {
  const strip = $("termTabs"); if (!strip) return;
  strip.innerHTML = "";
  for (const t of _term.tabs) {
    const active = t.id === _term.active;
    const tab = h("div", { class: "term-tab" + (active ? " active" : "") + (t.exited ? " exited" : ""), title: `${t.shell} — ${t.cwd}`,
      onclick: () => setActiveTerm(t.id) },
      h("span", { html: icon("terminal", 12) }),
      h("span", { class: "term-tab-name", text: t.title || t.shell }),
      h("button", { class: "term-tab-x", html: icon("close", 11), title: "Close terminal", onclick: (e) => { e.stopPropagation(); closeTerm(t.id); } }));
    strip.append(tab);
  }
  strip.append(h("button", { class: "term-new", html: icon("plus", 13), title: "New terminal", onclick: () => newTerm() }));
}

function setActiveTerm(id) {
  _term.active = id;
  const body = $("termBody"); if (!body) return;
  body.innerHTML = "";
  renderTermTabs();
  if (!id) return;
  const pane = termPane(id);
  body.append(pane.el);
  if (pane.mode === "xterm") {
    // Re-attaching detached it from layout; fit to the panel and focus the grid.
    try { pane.fit && pane.fit.fit(); } catch { /* not visible yet */ }
    pane.term.focus();
  } else {
    pane.el.scrollTop = pane.el.scrollHeight;
    pane.input.focus();
  }
}

async function newTerm(opts = {}) {
  const ts = activeTS();
  const cwd = opts.cwd || (ts && ts.meta.cwd) || state.project;
  const meta = await atom.terminal.create({ cwd, title: opts.title });
  if (!meta || meta.error) { toast("Terminal failed: " + esc((meta && meta.error) || "unknown"), "alert", { ms: 6000 }); return null; }
  _term.tabs.push(meta);
  setActiveTerm(meta.id);
  return meta;
}

// Tear an xterm pane down so its ResizeObserver and render loop don't leak.
function disposeTermPane(pane) {
  if (pane && pane.mode === "xterm") {
    try { pane.ro.disconnect(); } catch { /* gone */ }
    try { pane.term.dispose(); } catch { /* gone */ }
  }
}

async function closeTerm(id) {
  try { await atom.terminal.kill(id); } catch { /* already gone */ }
  disposeTermPane(_term.panes.get(id));
  _term.tabs = _term.tabs.filter((t) => t.id !== id);
  _term.panes.delete(id);
  if (_term.active === id) setActiveTerm(_term.tabs.length ? _term.tabs[_term.tabs.length - 1].id : null);
  else renderTermTabs();
}

async function clearTerm(id) {
  if (!id) return;
  await atom.terminal.clear(id).catch(() => {});
  const pane = _term.panes.get(id);
  if (!pane) return;
  if (pane.mode === "xterm") { pane.term.clear(); pane.term.focus(); return; }
  while (pane.el.firstChild && pane.el.firstChild !== pane.input) pane.el.removeChild(pane.el.firstChild);
  pane.input.focus();
}

function buildTerminalDock() {
  if ($("termDock")) return $("termDock");
  const out = h("div", { class: "term-body", id: "termBody" });

  const dock = h("div", { class: "term-dock hidden", id: "termDock" },
    h("div", { class: "term-resizer", id: "termResizer", title: "Drag to resize" }),
    h("div", { class: "term-head" },
      h("div", { class: "term-tabs", id: "termTabs" }),
      h("div", { class: "term-actions" },
        h("button", { class: "term-act", html: icon("stop", 13), title: "Interrupt (Ctrl+C)", onclick: () => { atom.terminal.interrupt(_term.active); if (!termIsXterm(_term.active)) termAppend(_term.active, "^C\n"); } }),
        h("button", { class: "term-act", html: icon("refresh", 13), title: "Clear", onclick: () => clearTerm(_term.active) }),
        h("button", { class: "term-act", html: icon("trash", 13), title: "Delete this terminal", onclick: () => closeTerm(_term.active) }),
        h("button", { class: "term-act", html: icon("close", 13), title: "Hide panel (Ctrl+`)", onclick: () => toggleTerminal(false) }))),
    out);
  document.body.append(dock);

  // Drag the top edge to resize.
  let dragging = false;
  dock.querySelector("#termResizer").addEventListener("mousedown", (e) => { dragging = true; e.preventDefault(); document.body.style.cursor = "ns-resize"; });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const px = Math.max(140, Math.min(window.innerHeight - 120, window.innerHeight - e.clientY));
    dock.style.height = px + "px";
  });
  window.addEventListener("mouseup", () => { if (dragging) { dragging = false; document.body.style.cursor = ""; } });
  return dock;
}

async function toggleTerminal(force) {
  const dock = buildTerminalDock();
  const open = force === undefined ? !_term.open : !!force;
  _term.open = open;
  dock.classList.toggle("hidden", !open);
  const btn = $("terminalBtn"); if (btn) btn.classList.toggle("active", open);
  if (open) {
    if (!_term.tabs.length) await newTerm();
    else setActiveTerm(_term.active || _term.tabs[0].id);
  }
}

/* Resolve once the new shell has written something (its banner + prompt), or
 * give up after a moment — a shell that says nothing is not worth stalling on. */
function termFirstPrompt(id, ms = 1500) {
  const pane = _term.panes.get(id);
  if (pane && pane.el.textContent) return Promise.resolve();
  return new Promise((resolve) => {
    let off = null;
    const finish = () => { if (off) { off(); off = null; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(finish, ms);
    off = atom.events.onTerminalData(({ id: tid }) => { if (tid === id) setTimeout(finish, 60); });
  });
}

/* Run a command in a terminal at project scope and surface it — the entry point
 * features use (skill installs) rather than making the user retype a command. */
async function runInTerminal(command, opts = {}) {
  await toggleTerminal(true);
  const meta = await newTerm({ cwd: opts.cwd, title: opts.title });
  if (!meta) return null;
  // Let the shell print its banner and first prompt before echoing the command,
  // so it reads as a line typed at that prompt rather than one that arrived
  // before the shell had started.
  await termFirstPrompt(meta.id);
  // The legacy pane has no TTY echo, so we print the line ourselves; an xterm/PTY
  // terminal echoes what we write, so printing it too would duplicate it.
  if (!termIsXterm(meta.id)) termAppend(meta.id, command + "\n");
  if (typeof opts.onExit !== "function") { await atom.terminal.run(meta.id, command); return meta; }
  // Subscribe BEFORE running, and hold anything that arrives before the token is
  // known: the completion is a shell write, the token is an IPC reply, and there
  // is no ordering guarantee between them.
  let tok = null, fired = false;
  const early = [];
  const offs = [];
  const done = (code) => {
    if (fired) return;
    fired = true;
    for (const f of offs) { try { f(); } catch { /* already gone */ } }
    opts.onExit(code);
  };
  offs.push(atom.events.onTerminalCommandExit((ev) => {
    if (ev.id !== meta.id) return;
    if (!tok) early.push(ev);
    else if (ev.token === tok) done(ev.code);
  }));
  // A shell that dies mid-install is also an ending, just an uglier one.
  offs.push(atom.events.onTerminalExit(({ id, code }) => { if (id === meta.id) done(code == null ? -1 : code); }));
  tok = await atom.terminal.runTracked(meta.id, command).catch(() => null);
  // No token means the shell never took the command — say so rather than leaving
  // the caller waiting on a completion that cannot arrive.
  if (!tok) done(-1);
  else { const hit = early.find((e) => e.token === tok); if (hit) done(hit.code); }
  return meta;
}

function wireTerminalEvents() {
  if (_term.wired) return;
  _term.wired = true;
  atom.events.onTerminalData(({ id, chunk }) => { if (_term.panes.has(id) || _term.tabs.some((t) => t.id === id)) termWrite(id, chunk); });
  atom.events.onTerminalExit(({ id, code }) => {
    const t = _term.tabs.find((x) => x.id === id);
    if (t) { t.exited = true; t.code = code; renderTermTabs(); }
  });
  atom.events.onTerminalCleared(({ id }) => {
    const p = _term.panes.get(id);
    if (!p) return;
    if (p.mode === "xterm") { p.term.clear(); return; }
    while (p.el.firstChild && p.el.firstChild !== p.input) p.el.removeChild(p.el.firstChild);
  });
  atom.events.onTerminalClosed(({ id }) => {
    disposeTermPane(_term.panes.get(id));
    _term.tabs = _term.tabs.filter((t) => t.id !== id);
    _term.panes.delete(id);
    if (_term.active === id) setActiveTerm(_term.tabs.length ? _term.tabs[_term.tabs.length - 1].id : null);
    else renderTermTabs();
  });
}

/* ---------------- Skills control (multi-select + install) ---------------------
 * A composer button (before Reviewers) opening a popover that lets you:
 *   - check installed skills to apply on EVERY send in this tab (sticky), persisted
 *     on the session as `selectedSkills`;
 *   - install one, either way an author might ship it:
 *       Git — paste a SKILL.md / repo / JSON link, fetched and written in place;
 *       CLI — type the installer the author documents (`npx impeccable install …`,
 *             `pip install …`, a plugin CLI) and it runs in an integrated terminal
 *             rooted at the project, so you watch it the way you would in a shell.
 * A CLI install is deliberately NOT special-cased per tool: whatever the command
 * drops into the skills folder is picked up on exit, and from then on the skill's
 * own SKILL.md governs how it is used — same as one installed from a link.
 */
let _skPop = null;
function skillsControl() {
  const btn = h("button", { id: "skillsBtn", class: "rv-btn", onclick: (e) => { e.stopPropagation(); toggleSkillsPopover(btn); } });
  btn._refresh = () => { const ts = activeTS(); const n = ts && ts.selectedSkills ? ts.selectedSkills.size : 0; btn.innerHTML = `${icon("sparkle", 14, "dd-ico")}<span>Skills${n ? " · " + n : ""}</span>`; btn.classList.toggle("active", n > 0); };
  btn._refresh();
  return btn;
}
function refreshSkillsBtn() { const b = $("skillsBtn"); if (b && b._refresh) b._refresh(); }
function closeSkillsPopover() { if (_skPop) { _skPop.remove(); _skPop = null; document.removeEventListener("mousedown", _skOutside, true); } }
function _skOutside(e) { if (_skPop && !_skPop.contains(e.target) && !e.target.closest("#skillsBtn")) closeSkillsPopover(); }
// Persist the sticky selection onto the session (survives restart) + local tab state.
async function setSelectedSkills(ts, set) {
  ts.selectedSkills = set;
  refreshSkillsBtn();
  try { await atom.sessions.update(ts.meta.id, { selectedSkills: [...set] }); } catch { /* non-fatal */ }
}
function toggleSkillsPopover(anchor) {
  if (_skPop) { closeSkillsPopover(); return; }
  const ts = activeTS(); if (!ts) return;
  const cwd = ts.meta.cwd;
  if (!ts.selectedSkills) ts.selectedSkills = new Set();
  const pop = h("div", { class: "rv-pop sk-pop" });
  let installed = [];
  let mode = state.settings.skillInstallMode === "cli" ? "cli" : "git";   // remembered across opens

  const renderInstalled = (host) => {
    host.innerHTML = "";
    if (!installed.length) { host.append(h("div", { class: "rv-pop-hint", text: "No skills installed yet — add one below." })); return; }
    for (const s of installed) {
      const cb = h("input", { type: "checkbox", class: "aqx-check" });
      cb.checked = ts.selectedSkills.has(s.id);
      cb.addEventListener("change", () => {
        const set = new Set(ts.selectedSkills);
        if (cb.checked) set.add(s.id); else set.delete(s.id);
        setSelectedSkills(ts, set);
      });
      const del = h("button", { class: "sk-del", title: "Uninstall", html: icon("trash", 12), onclick: async (e) => {
        e.preventDefault(); e.stopPropagation();
        try { await atom.skills.remove(cwd, s.id); const set = new Set(ts.selectedSkills); set.delete(s.id); await setSelectedSkills(ts, set); await loadInstalled(); } catch (err) { toast("Remove failed: " + err.message, "alert"); }
      } });
      host.append(h("label", { class: "rv-row sk-row" }, cb,
        h("div", { class: "sk-meta" }, h("span", { class: "rv-prov", text: s.name }), s.description ? h("span", { class: "sk-desc", text: s.description }) : null),
        del));
    }
  };
  const loadInstalled = async () => {
    try { installed = (await atom.skills.list(cwd)) || []; } catch { installed = []; }
    const host = pop.querySelector(".sk-installed"); if (host) renderInstalled(host);
    refreshSkillsBtn();
  };

  pop.append(h("div", { class: "rv-pop-head" }, h("span", { html: icon("sparkle", 13) }), h("span", { text: "Skills" })));
  pop.append(h("div", { class: "sk-section-label", text: "Installed — check to apply on every message" }));
  pop.append(h("div", { class: "sk-installed" }));
  /* Install — one input, two sources. Git fetches and writes the skill itself;
   * CLI hands the command to a real shell because an installer may prompt, take a
   * minute, or fail in a way only its own output explains. */
  const inp = h("input", { class: "input sk-url", spellcheck: "false" });
  const goBtn = h("button", { class: "sk-install", text: "Install" });
  const hint = h("div", { class: "rv-pop-hint" });

  const applyMode = () => {
    for (const b of pop.querySelectorAll(".sk-mode button")) b.classList.toggle("active", b.dataset.mode === mode);
    inp.placeholder = mode === "git"
      ? "github.com/owner/repo  ·  …/SKILL.md  ·  JSON link"
      : "npx impeccable install <skill>";
    hint.textContent = mode === "git"
      ? "Fetched and written into this project's skills folder."
      : "Runs in a terminal at the project root. Whatever it installs is picked up when it finishes.";
    inp.value = "";
  };
  const seg = h("div", { class: "segmented sk-mode" },
    h("button", { dataset: { mode: "git" }, text: "Install from Git", onclick: () => { mode = "git"; applyMode(); setSharedSetting("skillInstallMode", "git"); inp.focus(); } }),
    h("button", { dataset: { mode: "cli" }, text: "Install by CLI", onclick: () => { mode = "cli"; applyMode(); setSharedSetting("skillInstallMode", "cli"); inp.focus(); } }));

  const doInstall = async () => {
    const val = (inp.value || "").trim(); if (!val) return;
    if (mode === "cli") {
      // Hand it to a terminal and get out of the way — the popover would only
      // cover the output the user now needs to watch.
      closeSkillsPopover();
      await runInTerminal(val, {
        cwd,
        title: "skill install",
        onExit: (code) => {
          // Re-list either way: a partial install still leaves something to see,
          // and a non-zero exit is the terminal's story to tell, not a toast's.
          loadInstalled();
          if (code === 0) toast("Install finished — skill list refreshed.", "sparkle");
          else toast(`Installer exited with code ${code} — see the terminal.`, "alert", { ms: 6000 });
        },
      });
      return;
    }
    goBtn.disabled = true; goBtn.textContent = "…";
    try { const r = await atom.skills.importUrl(cwd, val); toast(`Installed ${Array.isArray(r) ? r.length : 1} skill(s)`, "sparkle"); inp.value = ""; await loadInstalled(); }
    catch (e) { toast("Install failed: " + e.message, "alert"); }
    finally { goBtn.disabled = false; goBtn.textContent = "Install"; }
  };
  goBtn.onclick = doInstall;
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doInstall(); } });

  pop.append(h("div", { class: "sk-section-label", text: "Install a skill" }));
  pop.append(seg);
  pop.append(h("div", { class: "sk-url-row sk-install-row" }, inp, goBtn));
  pop.append(hint);
  applyMode();

  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  // Fit-to-viewport: open on the side with more room and cap height to it. When
  // opening UPWARD, BOTTOM-anchor the popover just above the button — so as the
  // async installed/marketplace lists populate, it grows upward (never crosses
  // the button or clips off the bottom); overflow scrolls inside.
  const gap = 8, margin = 10;
  const spaceAbove = r.top - margin - gap;
  const spaceBelow = window.innerHeight - r.bottom - margin - gap;
  const useAbove = spaceAbove >= spaceBelow;
  pop.style.maxHeight = Math.max(200, useAbove ? spaceAbove : spaceBelow) + "px";
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  if (useAbove) { pop.style.bottom = (window.innerHeight - r.top + gap) + "px"; pop.style.top = "auto"; }
  else { pop.style.top = (r.bottom + gap) + "px"; pop.style.bottom = "auto"; }
  _skPop = pop;
  setTimeout(() => document.addEventListener("mousedown", _skOutside, true), 0);
  loadInstalled();
}

function buildComposer() {
  const host = $("composer");
  const ta = h("textarea", { id: "promptInput", rows: "1", placeholder: "Ask AtomNano…  (Enter to send · Shift+Enter newline · while running: Enter interrupts & runs now, or steers a Codex turn · Ctrl+Enter queues)" });
  ta.addEventListener("input", () => { autoGrow(); updateSendButton(); });
  // While running + text: Enter INTERRUPTS the current reply and runs now (default);
  // Ctrl/Cmd+Enter instead adds it to the queue.
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send({ queue: e.ctrlKey || e.metaKey }); } });
  ta.addEventListener("paste", onPaste);

  // Model / thinking / permission / 1M are SHARED across all sessions.
  providerDD = dropdown({ ic: "globe", items: PROVIDERS, getValue: () => state.settings.llmProvider || "anthropic", onSelect: (v) => {
    setSharedSetting("llmProvider", v);
    loadProviderModels(v, { announce: true });   // discover its models / reasoning / 1M flags
    // The composer-area auth banner is the persistent indicator now — the
    // brief toast is a nudge that fades; the banner stays until signed in.
    refreshAuthBanner();
    if (v === "google") toast("Switched to Antigravity — sign in if prompted.", "sparkle");
    else if (v === "openai") toast("Switched to OpenAI / Codex — sign in if prompted.", "sparkle");
    else if (v === "custom" && !state.settings.customApiBaseUrl) toast("Set a Custom API base URL + key in Settings → Providers.", "globe");
  } });
  modelDD = dropdown({ ic: "cpu", items: MODELS, getValue: () => state.settings.defaultModel, onSelect: (v) => setSharedSetting("defaultModel", v) });
  thinkDD = dropdown({ ic: "brain", items: THINKING, getValue: () => state.settings.defaultThinking, onSelect: (v) => setSharedSetting("defaultThinking", v) });
  permDD = dropdown({ ic: "shield", items: PERMS, getValue: () => state.settings.defaultPermissionMode, onSelect: (v) => setSharedSetting("defaultPermissionMode", v) });

  // While a reply is generating AND there's text, the primary button INTERRUPTS the
  // current reply and runs the typed message now (Enter); this secondary button (placed
  // before it) only ADDS the message to the queue to run after the current reply.
  const queueBtn = h("button", { id: "queueBtn", class: "send-btn queue-btn hidden", html: icon("list", 16), onclick: () => send({ queue: true }), title: "Add to queue — runs after the current reply (Ctrl+Enter)" });
  const sendBtn = h("button", { id: "sendBtn", class: "send-btn", html: icon("arrowUp", 19), onclick: () => send(), title: "Send (Enter)" });
  // Import lives in the chat-header "More" menu now (chatMore), not in the composer.
  const reviewersBtn = reviewersControl();   // consult-before / review-after with other providers
  const rolesBtn = rolesControl();           // Planner role (Plan → Code) — its own model/effort/provider
  const skillsBtn = skillsControl();         // multi-select installed skills + install from Git / by CLI (before Reviewers)

  const oneM = h("label", { class: "onem-toggle", id: "oneMWrap", title: "Use the 1,000,000-token context window (Opus 4.6+ and Sonnet 4.6+)" },
    h("input", { type: "checkbox", id: "oneMToggle", onchange: (e) => onToggleOneM(e.target.checked) }),
    h("span", { class: "om-ico", html: icon("sparkle", 12) }),
    h("span", { text: "1M context" }));

  // Sub-agents control moved to the chat-header "More" (3-dots) menu — see
  // wireChatHeader(). Image generation still works via "/image <prompt>".
  const stats = h("div", { class: "stats-strip", id: "statsStrip" });
  const tray = h("div", { class: "attach-tray hidden", id: "attachTray" });

  const box = h("div", { class: "composer-box", id: "composerBox" }, tray, ta,
    h("div", { class: "composer-toolbar" }, modelDD, thinkDD, permDD, h("div", { class: "spacer" }), queueBtn, sendBtn));
  // The primary-provider dropdown lives in the tab bar (chat header), before the
  // Skills icon — it's a workspace-level choice, not a per-message one.
  const hp = $("headerProvider"); if (hp) { hp.innerHTML = ""; hp.append(providerDD); }
  ta.addEventListener("focus", () => box.classList.add("focused"));
  ta.addEventListener("blur", () => box.classList.remove("focused"));
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("dragover"); });
  box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove("dragover"); });
  box.addEventListener("drop", onDrop);

  host.innerHTML = "";
  host.append(h("div", { class: "composer-inner" },
    h("div", { class: "queue-strip hidden", id: "queueStrip" }),
    h("div", { class: "suggest-chips hidden", id: "suggestChips" }),
    h("div", { class: "composer-meta" }, stats, h("div", { class: "spacer" }), skillsBtn, rolesBtn, reviewersBtn, oneM),
    h("div", { class: "auth-banner hidden", id: "authBanner" }),
    box));
  refreshAuthBanner();
  renderSuggestChips();
}

// --- Prompt suggestion chip (promptSuggestions) ---------------------------
// One predicted next-prompt, shown after the reply. Click fills the composer.
function renderSuggestChips() {
  const host = $("suggestChips"); if (!host) return;
  const ts = activeTS();
  const sug = ts && ts.suggestion;
  host.innerHTML = "";
  if (!sug || (ts && ts.meta.status === "running")) { host.classList.add("hidden"); return; }
  host.classList.remove("hidden");
  host.append(
    h("span", { class: "sc-ic", html: icon("sparkle", 12) }),
    h("button", { class: "suggest-chip", text: sug, title: "Use this prompt", onclick: () => {
      const ta = $("promptInput"); if (ta) { ta.value = sug; ta.dispatchEvent(new Event("input")); ta.focus(); }
      ts.suggestion = null; renderSuggestChips();
    } }),
    h("button", { class: "sc-x", html: icon("close", 11), title: "Dismiss", onclick: () => { ts.suggestion = null; renderSuggestChips(); } }));
}

// --- Live context-window usage --------------------------------------------
// Polls the running turn's real context fill (getContextUsage) and stashes it on
// the tab. No visible chip — the info surfaces in the session-tab hover tooltip
// (see usageTipText), alongside the plan-usage windows.
let _ctxTimer = null;
function startCtxMeter(sessionId) {
  stopCtxMeter();
  const tick = async () => {
    if (state.activeTabId !== sessionId) return;
    const ts = state.tabs.get(sessionId);
    if (!ts || ts.meta.status !== "running") { stopCtxMeter(); return; }
    try { const u = await atom.sessions.contextUsage(sessionId); if (u && u.totalTokens) { ts.ctxUsage = u; applyTabTip(); } } catch { /* between turns → ignore */ }
  };
  tick();
  _ctxTimer = setInterval(tick, 3000);
}
function stopCtxMeter() { if (_ctxTimer) { clearInterval(_ctxTimer); _ctxTimer = null; } }

// Show a clear "sign-in required" banner above the composer when the active
// primary provider isn't authenticated yet. Reads atom.providers.authStatus()
// and renders provider-specific messaging + a one-click sign-in button that
// fires the same OAuth flow as Settings → Providers.
async function refreshAuthBanner() {
  const el = $("authBanner");
  if (!el) return;
  const provider = state.settings.llmProvider || "anthropic";
  let st = {};
  try { st = await atom.providers.authStatus(); } catch { /* ignore — banner just stays hidden */ }
  const p = st[provider] || {};
  // "Signed in" means: an OAuth credential is on disk OR a user-set API key
  // covers this provider. For custom providers a baseUrl + key combo also
  // counts. If the provider entry was never returned, hide rather than scare.
  const signedIn = !!(p.loggedIn || p.key);
  if (signedIn || !PROVIDER_NEEDS_AUTH[provider]) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const meta = PROVIDER_NEEDS_AUTH[provider];
  el.innerHTML = "";
  el.classList.remove("hidden");
  el.append(
    h("span", { class: "auth-banner-ic", html: icon(meta.icon, 14) }),
    h("div", { class: "auth-banner-body" },
      h("div", { class: "auth-banner-title", text: meta.title }),
      h("div", { class: "auth-banner-sub", text: meta.sub })),
    h("button", { class: "btn btn-primary btn-sm", text: meta.action, onclick: async () => {
      if (provider === "custom") { openSettings(); return; }   // baseUrl + key form lives there
      try { await atom.providers.authorize(provider); if (meta.toast) toast(meta.toast, "globe"); }
      catch (e) { toast("Sign-in failed to open: " + e.message, "alert"); }
      // Re-check after a beat — browser auth finishes asynchronously.
      setTimeout(refreshAuthBanner, 4000);
      setTimeout(refreshAuthBanner, 12000);
    } }),
    h("button", { class: "auth-banner-x", html: icon("close", 12), title: "Dismiss for now", onclick: () => el.classList.add("hidden") }),
  );
}

// Per-provider auth banner copy. `anthropic` is excluded — its sign-in flow
// lives in the welcome screen + Settings → Storage already, and most users
// arrive already signed in via the Claude CLI.
const PROVIDER_NEEDS_AUTH = {
  google: {
    icon: "globe",
    title: "Sign in to Antigravity to use Google as the primary",
    sub: "agy uses your Google account via browser OAuth. Tokens are stored in ~/.gemini/.",
    action: "Sign in",
    toast: "Antigravity login opened in a new window. Complete it in the browser, then return.",
  },
  openai: {
    icon: "globe",
    title: "Sign in to OpenAI / Codex to use it as the primary",
    sub: "codex login uses your OpenAI account via browser OAuth.",
    action: "Sign in",
    toast: "OpenAI login opened in a new window. Complete it, then return.",
  },
  custom: {
    icon: "key",
    title: "Configure your Custom provider to use it",
    sub: "Set a base URL and API key in Settings → Providers.",
    action: "Open settings",
    toast: "",
  },
};

function renderQueue() {
  const el = $("queueStrip");
  if (!el) return;
  const ts = activeTS();
  const q = ts ? ts.queue : [];
  el.innerHTML = "";
  if (!q || !q.length) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const collapsed = !!(ts && ts._queueCollapsed);
  // Header doubles as a hide/show toggle for the whole queue.
  el.append(h("div", { class: "queue-head", title: collapsed ? "Show queued messages" : "Hide queued messages",
    onclick: () => { if (ts) { ts._queueCollapsed = !ts._queueCollapsed; renderQueue(); } } },
    h("span", { class: "qh-chev", html: icon(collapsed ? "chevronRight" : "chevronDown", 12) }),
    h("span", { html: icon("list", 12) }),
    h("span", { text: `Queued — runs after the current reply (${q.length})` })));
  if (collapsed) return;
  const list = h("div", { class: "queue-list" });   // scrollable, capped height
  q.forEach((item, i) => {
    list.append(h("div", { class: "queue-item" },
      h("span", { class: "queue-num", text: String(i + 1) }),
      h("span", { class: "queue-text", text: item.text || "(attachments only)" }),
      item.attachments && item.attachments.length ? h("span", { class: "queue-att", html: icon("file", 11) + " " + item.attachments.length }) : null,
      h("button", { class: "queue-copy", html: icon("copy", 12), title: "Copy queued text", onclick: async (e) => {
        const b = e.currentTarget;
        try { await atom.clipboard.write(item.text || ""); b.innerHTML = icon("check", 12); setTimeout(() => { b.innerHTML = icon("copy", 12); }, 1200); }
        catch { toast("Copy failed", "alert"); }
      } }),
      h("button", { class: "queue-x", html: icon("close", 12), title: "Remove from queue", onclick: () => { ts.queue.splice(i, 1); renderQueue(); } })));
  });
  el.append(list);
}

function refreshComposer() {
  const ts = activeTS();
  if (!ts) return;
  if (providerDD) providerDD._refresh(); modelDD._refresh(); thinkDD._refresh(); permDD._refresh();
  const ta = $("promptInput");
  ta.value = ts.draft || "";
  const om = $("oneMToggle"); if (om) om.checked = !!state.settings.oneM;
  const sa = $("subAgentsToggle"); if (sa) sa.checked = !!state.settings.subAgents;
  const sm = $("subAgentsMax"); if (sm) sm.classList.toggle("hidden", !state.settings.subAgents);
  const sv = $("subAgentsVal"); if (sv) sv.textContent = String(state.settings.subAgentsMax || 3);
  updateOneMVisibility();
  renderAttachments();
  renderQueue();
  updateStats();
  autoGrow();
  updateSendButton();
  // Rebind the SDK capability UIs (suggestion chip / live context meter) to the
  // now-active tab.
  renderSuggestChips();
  if (ts.meta.status === "running") startCtxMeter(ts.meta.id); else stopCtxMeter();
}

// Per Anthropic docs, the 1M-token context window is available on Opus 4.6+ and
// Sonnet 4.6+ (Haiku and Sonnet ≤4.5 are 200K). For these models 1M is the
// default; the context-1m beta we pass is the explicit opt-in (harmless if already on).
function modelSupports1M(id) {
  // Provider-reported capability wins (covers Gemini + discovered ids); fall back
  // to the Anthropic version heuristic when we have no catalog entry.
  if (state.modelCaps && Object.prototype.hasOwnProperty.call(state.modelCaps, id)) return !!state.modelCaps[id];
  const m = /claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec((id || "").toLowerCase());
  if (!m) return /opus|sonnet|fable/i.test(id || "");    // fable + unknown opus/sonnet → assume supported
  const fam = m[1], major = +m[2], minor = +m[3];
  if (fam === "haiku") return false;
  return major > 4 || (major === 4 && minor >= 6);        // Opus/Sonnet 4.6+
}
// Show the 1M checkbox only for models that support it; if the model doesn't,
// hide it and clear the flag so we never send the beta for an unsupported model.
function updateOneMVisibility() {
  const wrap = $("oneMWrap");
  if (!wrap) return;
  const supported = modelSupports1M(state.settings.defaultModel);
  wrap.classList.toggle("hidden", !supported);
  if (!supported && state.settings.oneM) {
    state.settings.oneM = false;
    atom.settings.set({ oneM: false }).catch(() => {});
    const om = $("oneMToggle"); if (om) om.checked = false;
  }
}

// Model / thinking / permission / 1M are shared across every session.
function setSharedSetting(key, val) {
  state.settings[key] = val;
  atom.settings.set({ [key]: val }).catch(() => {});
  if (key === "defaultModel") { updateOneMVisibility(); syncEffortForModel(); }
  // Picking a permission mode applies to the active tab's RUNNING turn too (Full access
  // must stop asking now, not at the next send): Claude's live setPermissionMode and the
  // app's own gate / Codex's per-request decisions all read the session's mode.
  if (key === "defaultPermissionMode") { const ts = activeTS(); if (ts && ts.meta) { ts.meta.permissionMode = val; atom.sessions.setModeLive(ts.meta.id, val).catch(() => {}); } }
}
// Codex models differ in the efforts they accept (GPT-5.5: low…x-high; 5.6 Sol:
// …max, ultra). Show only the picked model's ladder and move the selection to the
// model's own default when the current level isn't available on it.
function syncEffortForModel() {
  if ((state.settings.llmProvider || "anthropic") !== "openai" || !state.fullLadder) return;
  const info = state.modelEfforts && state.modelEfforts[state.settings.defaultModel];
  const ladder = info ? state.fullLadder.filter((l) => info.efforts.includes(l.id)) : state.fullLadder;
  if (!ladder.length) return;
  THINKING.length = 0; for (const l of ladder) THINKING.push({ ...l, desc: (l.desc || "").replace(/ — .*$/, "") });
  if (!THINKING.find((l) => l.id === state.settings.defaultThinking)) {
    const v = (info && info.def && THINKING.find((l) => l.id === info.def)) ? info.def : THINKING[Math.min(THINKING.length - 1, 2)].id;
    state.settings.defaultThinking = v; atom.settings.set({ defaultThinking: v }).catch(() => {});
    toast(`Effort set to ${v} — the only levels ${(MODELS.find((m) => m.id === state.settings.defaultModel) || {}).name || "this model"} accepts are ${THINKING.map((l) => l.id).join(", ")}`, "sparkle", { ms: 3500 });
  }
  if (thinkDD) thinkDD._refresh();
}
function onToggleOneM(checked) { setSharedSetting("oneM", checked); }
function stepSubAgents(delta) {
  const cur = Math.max(1, Math.min(8, +state.settings.subAgentsMax || 3));
  const next = Math.max(1, Math.min(8, cur + delta));
  if (next === cur) return;
  setSharedSetting("subAgentsMax", next);
  const sv = $("subAgentsVal"); if (sv) sv.textContent = String(next);
}

function updateStats() {
  const el = $("statsStrip"); if (!el) return;
  const ts = activeTS();
  const files = ts ? ts.editedFiles : [];
  if (!files.length) { el.classList.remove("clickable"); el.innerHTML = `<span class="stat-muted">No file changes yet</span>`; el.onclick = null; return; }
  const added = files.reduce((s, f) => s + (f.added || 0), 0);
  const removed = files.reduce((s, f) => s + (f.removed || 0), 0);
  el.classList.add("clickable");
  el.innerHTML =
    `<span class="stat">${icon("pencil", 12)} ${files.length} file${files.length > 1 ? "s" : ""} changed</span>` +
    `<span class="stat add">+${added}</span><span class="stat del">−${removed}</span>` +
    `<span class="stat-hint">lines</span>`;
  el.onclick = () => { if ($("changesPanel").classList.contains("hidden")) toggleChanges(); };
}

/* ---- attachments (paste / drop images & files) ---- */
function onPaste(e) {
  const dt = e.clipboardData; if (!dt) return;
  const imageItems = [...(dt.items || [])].filter((it) => it.kind === "file" && it.type.startsWith("image/"));
  if (imageItems.length) {
    e.preventDefault();
    for (const it of imageItems) { const f = it.getAsFile(); if (f) addImageFile(f); }
    return;
  }
  const pathed = [...(dt.files || [])].filter((f) => f.path);
  if (pathed.length) { e.preventDefault(); for (const f of pathed) addPathFile(f); }
}
function onDrop(e) {
  e.preventDefault();
  $("composerBox").classList.remove("dragover");
  const files = [...(e.dataTransfer.files || [])];
  if (files.length) {
    for (const f of files) {
      if (f.type && f.type.startsWith("image/")) addImageFile(f);
      else if (f.path) addPathFile(f);
      else addImageFile(f);
    }
    return;
  }
  // No files → a selected-text drag (from the editor, a chat message, etc.).
  // Drop it into the prompt box at the caret instead of discarding it.
  const text = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text");
  if (text) insertIntoComposer(text);
}

// Insert text into the prompt box at the caret (replacing any selection), keeping
// the draft + autosize + send-button state in sync.
function insertIntoComposer(text) {
  const ta = $("promptInput"); if (!ta) return;
  const ts = activeTS();
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const caret = start + text.length;
  ta.focus();
  try { ta.setSelectionRange(caret, caret); } catch { /* ignore */ }
  if (ts) ts.draft = ta.value;
  autoGrow();
  updateSendButton();
}
function addPathFile(file) {
  const ts = activeTS(); if (!ts) return;
  ts.attachments.push({ kind: "file", name: file.name, path: file.path, mediaType: file.type });
  renderAttachments();
}
function addImageFile(file) {
  const ts = activeTS(); if (!ts) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || "");
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return;
    const data = dataUrl.slice(comma + 1);
    const mediaType = dataUrl.slice(5, comma).split(";")[0] || file.type || "image/png";
    makeThumb(dataUrl).then((thumb) => {
      ts.attachments.push({ kind: "image", name: file.name || "pasted-image.png", data, mediaType, thumb });
      renderAttachments();
    });
  };
  reader.readAsDataURL(file);
}
// Thumbnail sized for crisp display: the inline preview can render ~220px wide,
// so target ~2.5× that and account for the screen's pixel ratio (Hi-DPI laptops
// were upscaling a 160px thumb → blurry). Never upscales past the source.
function makeThumb(dataUrl, max = Math.min(900, Math.round(560 * (window.devicePixelRatio || 1)))) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale)), hh = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas"); c.width = w; c.height = hh;
      const ctx = c.getContext("2d"); if (ctx) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; }
      try { ctx.drawImage(img, 0, 0, w, hh); res(c.toDataURL("image/jpeg", 0.92)); }
      catch { res(dataUrl); }
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });
}
function renderAttachments() {
  const tray = $("attachTray"); if (!tray) return;
  const ts = activeTS();
  const atts = ts ? ts.attachments : [];
  tray.innerHTML = "";
  if (!atts || !atts.length) { tray.classList.add("hidden"); return; }
  tray.classList.remove("hidden");
  atts.forEach((a, i) => {
    const chip = h("div", { class: "attach-chip" });
    if (a.kind === "image") { const t = h("img", { class: "attach-thumb", src: imgSrc(a) || a.thumb, title: "Click to view", onclick: () => openImageViewer(imgSrc(a) || a.thumb, a.name) }); chip.append(t); }
    else chip.append(h("span", { class: "attach-fico", html: icon("file", 14) }));
    chip.append(h("span", { class: "attach-name", text: a.name || (a.kind === "image" ? "image" : "file") }));
    chip.append(h("button", { class: "attach-x", html: icon("close", 12), title: "Remove", onclick: () => { ts.attachments.splice(i, 1); renderAttachments(); } }));
    tray.append(chip);
  });
}

function autoGrow() {
  const ta = $("promptInput");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 260) + "px";
}

async function updateTabSetting(key, val) {
  const ts = activeTS();
  if (!ts) return;
  ts.meta[key] = val;
  await atom.sessions.update(ts.meta.id, { [key]: val });
}

function updateSendButton() {
  const ts = activeTS();
  const btn = $("sendBtn");
  const qbtn = $("queueBtn");
  const box = $("composerBox");
  if (!btn || !ts) return;
  const running = ts.meta.status === "running";
  const ta = $("promptInput");
  const hasText = !!((ta && ta.value.trim()) || (ts.attachments && ts.attachments.length));
  box.classList.toggle("running", running || !!ts.stopping);
  const hideQueue = () => { if (qbtn) qbtn.classList.add("hidden"); };
  if (ts.stopping) {
    // Interrupt in flight — show it's working on stopping, ignore further clicks.
    btn.classList.remove("queue", "interrupt-now"); btn.classList.add("stop"); btn.innerHTML = icon("stop", 16); btn.title = "Stopping…"; btn.disabled = true;
    hideQueue();
    return;
  }
  const offline = ts.meta.status === "offline";
  if (offline) {
    btn.classList.remove("queue", "interrupt-now", "stop"); btn.innerHTML = icon("wifiOff", 16); btn.title = "Offline — will retry when connection returns";
    btn.disabled = true;
    box.classList.add("running");
    hideQueue();
    return;
  }
  if (ts.meta.status === "auth-expired") {
    // Paused awaiting re-login. Clicking the button opens the sign-in flow; the
    // run resumes automatically once auth is restored (context preserved).
    btn.classList.remove("queue", "interrupt-now", "stop"); btn.innerHTML = icon("key", 16);
    btn.title = "Login expired — sign in to resume (context preserved)";
    btn.disabled = false;
    box.classList.add("running");
    hideQueue();
    return;
  }
  if (ts.meta.status === "ratelimited") {
    // Rate-limited — auto-retrying. Button stops the auto-retry (context kept).
    btn.classList.remove("queue", "interrupt-now"); btn.classList.add("stop"); btn.innerHTML = icon("history", 16);
    btn.title = "Rate limited — auto-retrying. Click to stop (your message stays).";
    btn.disabled = false;
    box.classList.add("running");
    hideQueue();
    return;
  }
  if (running && !hasText) {
    // Nothing typed → the primary button stops the run.
    btn.classList.remove("queue", "interrupt-now"); btn.classList.add("stop"); btn.innerHTML = icon("stop", 16); btn.title = "Stop (Esc)";
    hideQueue();
  } else if (running && hasText) {
    // Generating + text → Enter INTERRUPTS & runs now (primary); a Queue button sits
    // before it to instead add the message to the queue.
    btn.classList.remove("stop", "queue"); btn.classList.add("interrupt-now"); btn.innerHTML = icon("arrowUp", 19); btn.title = "Interrupt & run now (Enter)";
    if (qbtn) qbtn.classList.remove("hidden");
  } else {
    // Idle → send.
    btn.classList.remove("stop", "queue", "interrupt-now"); btn.innerHTML = icon("arrowUp", 19); btn.title = "Send (Enter)";
    hideQueue();
  }
  btn.disabled = false;
}

function stopSession(id) {
  const ts = state.tabs.get(id);
  if (!ts) return;
  if (ts.queue && ts.queue.length) { ts.queue = []; if (id === state.activeTabId) renderQueue(); }
  // Hard stop: drop the live partials/thinking immediately so the UI snaps to
  // a stopped state instead of pulsing "Thinking…" during the abort window.
  ts.streaming.clear();
  ts.stopping = true;
  if (id === state.activeTabId) { updateSendButton(); renderLive(); }
  atom.sessions.interrupt(id, "stop");
  // Safety net: a terminal status normally clears this within ~600ms; never
  // let the button stay stuck on "Stopping…" if that event is somehow missed.
  clearTimeout(ts._stopTimer);
  ts._stopTimer = setTimeout(() => {
    if (ts.stopping) {
      ts.stopping = false;
      ts.meta.status = "idle";
      if (id === state.activeTabId) { updateSendButton(); renderLive(); renderTabs(); }
    }
  }, 1200);
}

// (The Optimise / Distill pre-mind was removed: nothing rewrites or strips a request
//  before the model sees it.)

// Conservatively detect a "make me an image" request in natural language —
// requires a generation verb + an image noun, and bails on coding contexts
// (docker image, image upload component, base image, etc.) to avoid misfires.
function looksLikeImageRequest(t) {
  t = String(t || "");
  const verb = /\b(generate|create|make|draw|paint|render|design|sketch|illustrate)\b/i;
  const noun = /\b(image|images|picture|pictures|pic|photo|photos|logo|icon|illustration|drawing|artwork|portrait|poster|wallpaper|avatar|sticker|painting|emoji|thumbnail)\b/i;
  const code = /\b(docker|container|kubernetes|component|upload|picker|gallery|carousel|css|html|react|vue|svelte|button|form\b|api|endpoint|function|class|file|disk|iso|\bvm\b|build|deploy|base ?image|src=|https?:|crop|resize|optimi[sz]e|compress|sprite|favicon|placeholder|<img|tag)\b/i;
  return verb.test(t) && noun.test(t) && !code.test(t);
}
// Generate an image from a prompt — the prompt + result/error arrive as messages
// (added in the main process), so the renderer just kicks it off.
function generateImage(prompt) {
  const ts = activeTS(); if (!ts || !prompt) return;
  ts.meta.status = "running"; updateSendButton();
  atom.image.generate(ts.meta.id, prompt).then((r) => { if (r && r.ok) toast(`Image generated · ${r.provider}`, "image"); }).catch((e) => toast("Image generation failed: " + e.message, "alert"));
}

async function send(opts = {}) {
  const ts = activeTS();
  if (!ts) return;
  // Paused awaiting re-login → the send button is a "sign in & resume" affordance.
  if (ts.meta.status === "auth-expired") { resumeAuthExpired(ts.meta.authProvider || ts.meta.provider); return; }
  const ta = $("promptInput");
  const text = ta.value.trim();
  const attachments = ts.attachments || [];
  // Rate-limited + nothing typed → the button stops the auto-retry (context kept).
  if (ts.meta.status === "ratelimited" && !text && !attachments.length) { stopSession(ts.meta.id); return; }
  const running = ts.meta.status === "running";
  // Stop button: running + nothing typed → interrupt (and clear queue).
  if (running && !text && !attachments.length) { stopSession(ts.meta.id); return; }
  if (!text && !attachments.length) return;
  // "/image <prompt>" OR a natural-language image request → generate an image
  // instead of a chat turn (so the text model can't falsely claim it made one).
  // Skip the natural-language heuristic if the user attached files — they
  // probably want the model to look at the attachment, not silently throw it
  // away and run text-to-image on a prompt that mentioned "image".
  const igm = text.match(/^\/(?:image|img|imagine)\s+([\s\S]+)/i);
  const heuristicImage = !attachments.length && looksLikeImageRequest(text);
  if (!running && (igm || heuristicImage)) { const p = igm ? igm[1].trim() : text; ta.value = ""; ts.draft = ""; autoGrow(); ts.attachments = []; renderAttachments(); generateImage(p); return; }

  ta.value = ""; ts.draft = ""; autoGrow();
  ts.attachments = []; renderAttachments();
  const extraSystem = undefined;   // the message is sent exactly as written — no local rewriting layer
  // Sending is an explicit "I'm done reading back" — if the user had scrolled up,
  // jump to the latest so they see their own message and the reply arriving. The
  // message itself renders a moment later (it round-trips through the backend), so
  // also arm a one-shot flag that forces the scroll when it actually lands.
  ts._forceScrollOnce = true;
  scrollBottom(true);

  if (running) {
    const item = { id: "q" + Math.random().toString(36).slice(2, 9), text, attachments, extraSystem };
    if (opts.queue) {
      // Explicit queue (the Queue button / Ctrl+Enter): run it after the current reply.
      ts.queue.push(item);
      renderQueue();
      updateSendButton();
      toast(`Queued — #${ts.queue.length} in line`, "list");
    } else {
      // Codex turn: STEER it — the message joins the running turn (turn/steer) and
      // the model picks it up at its next step, nothing is stopped or re-run. Any
      // other case (Claude, no live turn, turn just finished) falls through to the
      // interrupt path below.
      let steered = false;
      try { const r = await atom.sessions.steer(ts.meta.id, { text, attachments }); steered = !!(r && r.steered); } catch { steered = false; }
      if (steered) { toast("Added to the running turn", "send"); return; }
      // Default while generating (Enter / primary button): INTERRUPT the current reply
      // and run this now. Snap the UI to a stopped state IMMEDIATELY (drop live
      // partials/thinking, flip the button) so it doesn't keep visibly streaming
      // during the abort round-trip — same instant feedback as the Stop button.
      // The stop is graceful (resumable); onStatus(idle) then clears `stopping`
      // and dispatchNextQueued runs this item (and any queued after it).
      ts.queue.unshift(item);
      renderQueue();
      ts.streaming.clear();
      ts.stopping = true;
      if (ts.meta.id === state.activeTabId) { updateSendButton(); renderLive(); }
      atom.sessions.interrupt(ts.meta.id, "replace");
      // Safety net: if the terminal status is somehow missed, don't leave the
      // composer stuck on "Stopping…" — clear it and let the queue drain.
      clearTimeout(ts._stopTimer);
      ts._stopTimer = setTimeout(() => {
        if (ts.stopping) {
          ts.stopping = false; ts.meta.status = "idle";
          if (ts.meta.id === state.activeTabId) { updateSendButton(); renderLive(); renderTabs(); }
          dispatchNextQueued(ts.meta.id);
        }
      }, 1200);
      toast("Interrupting — running your message now…", "stop");
    }
    return;
  }
  ts.meta.status = "running";
  ts.suggestion = null; renderSuggestChips();
  updateSendButton();
  createCheckpoint("Before: " + (text.slice(0, 48) || "agent run")).catch(() => {});   // snapshot so the run is reversible
  try { await atom.sessions.send(ts.meta.id, { text, attachments, extraSystem, ...sharedRunOpts() }); }
  catch (e) {
    // The composer was already cleared — put the prompt (and attachments) back so
    // a failed send (backend still tearing down, transient error) loses nothing.
    toast("Failed: " + e.message, "alert");
    ts.meta.status = "idle";
    const ta2 = $("promptInput");
    if (ta2 && !ta2.value.trim()) { ta2.value = text; ts.draft = text; autoGrow(); }
    if (attachments.length && !(ts.attachments || []).length) { ts.attachments = attachments; renderAttachments(); }
    updateSendButton();
  }
}

// Import a saved conversation from the composer, open it as a tab, scroll to end.
async function importConversation() {
  try {
    const r = await atom.sessions.import();
    if (!r || r.canceled) return;
    toast(`Imported ${r.count} conversation${r.count > 1 ? "s" : ""}`, "upload");
    if (r.first && r.first.id) {
      await openSessionTab(r.first.id);
      setTimeout(() => scrollBottom(true), 140);
    }
  } catch (e) { toast("Import failed: " + e.message, "alert"); }
}

// Resend an earlier prompt: drop its text into the composer and send (which
// queues it if a reply is already running).
function resendPrompt(text) {
  const ts = activeTS();
  if (!ts) return;
  const ta = $("promptInput");
  ta.value = text;
  ts.draft = text;
  autoGrow();
  ta.focus();
  send();
}

// The run options shared by every session (model/thinking/permission/1M).
function sharedRunOpts() {
  return {
    model: state.settings.defaultModel,
    permissionMode: state.settings.defaultPermissionMode,
    thinking: state.settings.defaultThinking,
    oneM: !!state.settings.oneM,
    subAgents: !!state.settings.subAgents,
    subAgentsMax: Math.max(1, Math.min(8, +state.settings.subAgentsMax || 3)),
    // Never let a reviewer be the EXACT primary (same provider + same model) — a
    // model reviewing itself adds nothing. Same provider with a different model is fine.
    reviewers: (Array.isArray(state.settings.reviewers) ? state.settings.reviewers : [])
      .filter((r) => !(r.provider === (state.settings.llmProvider || "anthropic") && r.model && r.model === state.settings.defaultModel)),
    reviewMode: state.settings.reviewMode === "after" ? "after" : "before",
    // Planner role (Plan → Code). Only sent when enabled; the Coder is the primary
    // model above, so the plan is drafted by planner.model and implemented by it.
    planner: (state.settings.planner && state.settings.planner.enabled && (state.settings.planner.provider || state.settings.planner.model))
      ? { enabled: true, provider: state.settings.planner.provider || "anthropic", model: state.settings.planner.model || "", effort: state.settings.planner.effort || "" }
      : null,
  };
}

async function dispatchNextQueued(sessionId) {
  const ts = state.tabs.get(sessionId);
  if (!ts || !ts.queue || !ts.queue.length) return;
  if (ts._dispatching) return;            // a dispatch attempt is already in flight
  ts._dispatching = true;
  const retry = (ms = 140) => { ts._dispatching = false; clearTimeout(ts._dispatchRetry); ts._dispatchRetry = setTimeout(() => dispatchNextQueued(sessionId), ms); };
  try {
    // An interrupt is async on the backend — the previous run may still be tearing
    // down when idle is first observed. Dispatching now would throw "already
    // running", so wait until the backend is genuinely idle (short poll).
    let stillRunning = false;
    try { stillRunning = await atom.sessions.running(sessionId); } catch { /* treat as idle */ }
    if (stillRunning) { retry(); return; }
    if (!ts.queue.length) { ts._dispatching = false; return; }
    const next = ts.queue.shift();
    ts.meta.status = "running";
    if (sessionId === state.activeTabId) { renderQueue(); updateSendButton(); }
    renderTabs();
    try {
      await atom.sessions.send(sessionId, { text: next.text, attachments: next.attachments, extraSystem: next.extraSystem, ...sharedRunOpts() });
      ts._dispatching = false;
    } catch (e) {
      // NEVER drop the user's prompt. Re-queue at the FRONT and retry.
      //   - "already running" → we raced the teardown; retry fast.
      //   - any other error → transient hiccup; a few quick retries before we
      //     give up and surface a toast (so a blip can't silently lose the msg).
      next._tries = (next._tries || 0) + 1;
      ts.queue.unshift(next);
      if (sessionId === state.activeTabId) renderQueue();
      if (/already running/i.test(e && e.message || "")) retry(120);
      else if (next._tries < 4) retry(400);
      else {
        // Give up on auto-retry — but never lose the prompt or leave the tab stuck
        // on "running": drop it from the queue INTO the composer, and go idle.
        ts.queue.shift(); ts._dispatching = false;
        ts.meta.status = "idle";
        const ta = $("promptInput");
        if (sessionId === state.activeTabId && ta && !ta.value.trim()) { ta.value = next.text || ""; ts.draft = next.text || ""; autoGrow(); }
        else if (next.text) ts.draft = next.text;   // inactive tab: restored when it's switched to
        if (Array.isArray(next.attachments) && next.attachments.length && !(ts.attachments || []).length) { ts.attachments = next.attachments; if (sessionId === state.activeTabId) renderAttachments(); }
        if (sessionId === state.activeTabId) { renderQueue(); updateSendButton(); }
        renderTabs();
        toast("Queued run failed: " + (e && e.message || e) + " — your message is back in the composer.", "alert");
      }
    }
  } catch (e) {
    // Outer failure (rare — e.g. the running() probe) — keep the queue intact and
    // try again shortly rather than losing anything.
    retry(400);
  }
}

/* ============================================================
   CHAT RENDER
   ============================================================ */
function chatRegions() {
  let msgs = $("chatMessages");
  if (!msgs) {
    const chat = $("chat");
    chat.innerHTML = "";
    chat.append(
      h("div", { id: "chatMessages", class: "chat-messages-host" }),
      h("div", { id: "chatLive" }),
      h("div", { id: "chatPerms" }));
    msgs = $("chatMessages");
  }
  return { msgs, live: $("chatLive"), perms: $("chatPerms") };
}

const RENDER_STEP = 60;   // messages loaded per page (scroll-to-top / scroll-to-bottom / jump)
// Shared by the scroll auto-loader AND the "load earlier" button. Without one
// guard across both, scrolling to the top starts a load while a click starts a
// second one for the same range — duplicated messages and a wasted disk read.
let _loadingOlder = false;
const MAX_RENDER = 150;   // hard cap on rendered messages while following live tail

// Sliding window: ts.viewStart = index of the first message currently in the DOM.
// Only [viewStart .. end] is rendered; older messages auto-load when you scroll
// to the top, and the oldest are trimmed from the DOM as new ones arrive — so
// even an all-day session keeps a small, constant DOM/RAM footprint.

function renderChat() {
  const ts = activeTS();
  const chat = $("chat");
  chat.innerHTML = "";
  chat.append(h("div", { id: "chatMessages" }), h("div", { id: "chatLive" }), h("div", { id: "chatPerms" }));
  // The chat overlays live in #main (so they don't scroll away), which means they
  // survive a tab switch. Reset them here so every session starts clean instead of
  // inheriting the previous conversation's search, dots and filter.
  resetChatOverlays();
  if (!ts) return;
  ts.viewStart = Math.max(0, ts.messages.length - RENDER_STEP); // fresh tail on (re)open
  renderMessagesRegion();
  renderLive();
  renderPerms();
  scrollBottom(true);
}

/* ============================================================
   CONVERSATION NAVIGATION — Ctrl+F · prompt timeline · synthesize
   ============================================================ */
// Start a fresh session seeded with the synthesized context of an existing one.
async function synthesizeSession(id) {
  const view = await atom.sessions.synthesize(id).catch((e) => { toast("Synthesize failed: " + ((e && e.message) || e), "alert"); return null; });
  if (!view) return;
  addTabState(view);
  if (!state.order.includes(view.id)) state.order.push(view.id);
  await switchTab(view.id);
  persistTabs();
  toast("Fresh session seeded with the synthesized context", "sparkle");
}

/* Every chat overlay is session-scoped: it belongs to the conversation you're
 * looking at, not to the window. They're parented to #main (so they stay pinned
 * while the transcript scrolls), so switching sessions has to clear them by hand —
 * otherwise a new tab inherits the previous chat's find highlights, timeline dots
 * and model filter. `chatFind` in particular holds DOM nodes from the old session. */
function resetChatOverlays() {
  closeChatSearch();                                   // also clears highlights + chatFind state
  const rail = $("promptRail"); if (rail) { rail.innerHTML = ""; rail.classList.add("hidden"); }
  const mf = $("modelFilter"); if (mf) mf.remove();
}

// Ctrl+F search over the loaded conversation: highlight + next/prev.
let chatFind = { hits: [], idx: -1, matchCase: false };
function openChatSearch() {
  if ($("chatSearch")) { const i = $("chatFindInput"); if (i) i.focus(); return; }
  // Anchored to #main (which does NOT scroll), not #chatWrap — an absolutely
  // positioned child of the scroll container scrolls away with the content.
  const wrap = $("main"); if (!wrap) return;
  const input = h("input", { id: "chatFindInput", class: "cf-input", placeholder: "Find in conversation…", spellcheck: "false" });
  const count = h("span", { id: "chatFindCount", class: "cf-count" });
  // Match-case toggle (like the editor's find) — re-runs the search on toggle.
  const mcase = h("button", { class: "cf-btn cf-case" + (chatFind.matchCase ? " active" : ""), title: "Match case", dataset: { tip: "Match case", tipDir: "top" }, text: "Aa",
    onclick: () => { chatFind.matchCase = !chatFind.matchCase; mcase.classList.toggle("active", chatFind.matchCase); doChatFind(input.value); input.focus(); } });
  const prev = h("button", { class: "cf-btn cf-prev", title: "Previous (Shift+Enter)", html: icon("chevronDown", 14), onclick: () => stepChatFind(-1) });
  const next = h("button", { class: "cf-btn", title: "Next (Enter)", html: icon("chevronDown", 14), onclick: () => stepChatFind(1) });
  const close = h("button", { class: "cf-btn", title: "Close (Esc)", html: icon("close", 14), onclick: closeChatSearch });
  const bar = h("div", { id: "chatSearch", class: "chat-search" }, h("span", { class: "cf-ico", html: icon("search", 14) }), input, mcase, count, prev, next, close);
  wrap.appendChild(bar);
  // Full-session (on-disk) results panel — covers messages beyond the in-memory
  // window, including pruned/archived ones the DOM highlighter can't reach.
  wrap.appendChild(h("div", { id: "chatFindResults", style: "position:fixed; z-index:60; width:min(560px,60vw); max-height:44vh; overflow:auto; background:var(--bg-3); border:1px solid var(--line-2); border-radius:8px; box-shadow:var(--sh-pop); padding:4px; display:none;" }));
  input.addEventListener("input", () => doChatFind(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeChatSearch(); }
    else if (e.key === "Enter") { e.preventDefault(); stepChatFind(e.shiftKey ? -1 : 1); }
  });
  input.focus();
}
function closeChatSearch() { const b = $("chatSearch"); if (b) b.remove(); const r = $("chatFindResults"); if (r) r.remove(); clearTimeout(_diskFindTimer); clearChatHighlights(); chatFind = { hits: [], idx: -1, matchCase: false }; }
// Full-session on-disk search (within the active session only). Runs alongside the
// DOM highlighter so matches in older/archived messages — not currently rendered —
// still surface. Clicking a hit that IS on screen jumps to it.
let _diskFindTimer = null;
function runDiskFind(q) {
  const box = $("chatFindResults"); if (!box) return;
  const ts = activeTS();
  if (!ts || !q) { box.style.display = "none"; box.innerHTML = ""; return; }
  atom.sessions.search(ts.meta.id, q).then((res) => {
    if (!$("chatFindResults") || ($("chatFindInput") || {}).value !== q) return;   // stale
    const matches = (res && res.matches) || [];
    box.innerHTML = "";
    if (!matches.length) { box.style.display = "none"; return; }
    const bar = $("chatSearch"); if (bar) { const r = bar.getBoundingClientRect(); box.style.top = (r.bottom + 4) + "px"; box.style.right = Math.max(8, window.innerWidth - r.right) + "px"; }
    const inView = new Set([...document.querySelectorAll("#chatMessages .msg[data-mid]")].map((e) => e.dataset.mid));
    const older = matches.filter((m) => !inView.has(m.mid)).length;
    const total = res.total || matches.length;
    box.append(h("div", { style: "padding:5px 8px; font-size:11px; opacity:.65;", text: `${total.toLocaleString()} match${total === 1 ? "" : "es"} in this session${older ? ` · ${older} not on screen — click to load` : ""}${total > matches.length ? ` · showing first ${matches.length}` : ""}` }));
    for (const m of matches) {
      const visible = m.mid && inView.has(m.mid);
      const when = m.ts ? new Date(m.ts).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      box.append(h("div", { class: "cf-hit-row", title: visible ? "Jump to message" : "Loads this part of the conversation and jumps to it",
        onclick: () => { if (typeof m.index === "number") jumpToIndex(m.index, q); else if (m.mid) jumpToMessage(m.mid); } },
        h("span", { class: "cf-hit-role", text: (m.role || "") + (m.archived ? " · archived" : "") }),
        h("span", { class: "cf-hit-snip", text: m.snippet || "" }),
        h("span", { class: "cf-hit-when", text: when })));
    }
    box.style.display = "block";
  }).catch(() => {});
}
function clearChatHighlights() {
  document.querySelectorAll("#chatMessages mark.cf-hit").forEach((m) => { const p = m.parentNode; m.replaceWith(document.createTextNode(m.textContent)); if (p) p.normalize(); });
}
function doChatFind(q) {
  clearChatHighlights();
  chatFind = { hits: [], idx: -1, matchCase: chatFind.matchCase };
  const count = $("chatFindCount");
  if (!q) { if (count) count.textContent = ""; clearTimeout(_diskFindTimer); const rb = $("chatFindResults"); if (rb) { rb.style.display = "none"; rb.innerHTML = ""; } return; }
  let rx; try { rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), chatFind.matchCase ? "g" : "gi"); } catch { return; }
  const hits = [];
  for (const msg of document.querySelectorAll("#chatMessages .msg")) {
    const walker = document.createTreeWalker(msg, NodeFilter.SHOW_TEXT, null);
    const nodes = []; let n;
    while ((n = walker.nextNode())) { const pe = n.parentElement; if (pe && pe.closest("button, .msg-time, .msg-role, script, style")) continue; if (n.nodeValue && n.nodeValue.trim()) nodes.push(n); }
    for (const tn of nodes) wrapChatMatches(tn, rx, hits);
  }
  chatFind.hits = hits;
  if (count) count.textContent = hits.length ? `1/${hits.length}` : "0/0";
  if (hits.length) stepChatFind(1, true);
  // Also search the FULL session on disk (older/archived messages the DOM lacks).
  clearTimeout(_diskFindTimer);
  _diskFindTimer = setTimeout(() => runDiskFind(q), 200);
}
function wrapChatMatches(textNode, rx, hits) {
  const text = textNode.nodeValue; rx.lastIndex = 0;
  let m, last = 0, any = false; const frag = document.createDocumentFragment();
  while ((m = rx.exec(text))) {
    any = true;
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement("mark"); mark.className = "cf-hit"; mark.textContent = m[0]; frag.appendChild(mark); hits.push(mark);
    last = m.index + m[0].length;
    if (rx.lastIndex === m.index) rx.lastIndex++;
  }
  if (any) { if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last))); textNode.replaceWith(frag); }
}
function stepChatFind(dir, first) {
  if (!chatFind.hits.length) return;
  if (chatFind.idx >= 0 && chatFind.hits[chatFind.idx]) chatFind.hits[chatFind.idx].classList.remove("cf-active");
  chatFind.idx = first ? 0 : (chatFind.idx + dir + chatFind.hits.length) % chatFind.hits.length;
  const m = chatFind.hits[chatFind.idx];
  if (m) { m.classList.add("cf-active"); m.scrollIntoView({ block: "center", behavior: "smooth" }); }
  const count = $("chatFindCount"); if (count) count.textContent = `${chatFind.idx + 1}/${chatFind.hits.length}`;
}

// Prompt timeline: one dot per user prompt on the right rail; hover → tooltip,
// click → jump to that prompt.
// The dot rail is retired: prompts live in a searchable dropdown next to the
// search icon (openPromptPicker), which also covers prompts not in RAM.
function renderPromptRail() { const rail = $("promptRail"); if (rail) { rail.innerHTML = ""; rail.classList.add("hidden"); } }
function jumpToMessage(mid) {
  const node = document.querySelector(`#chatMessages .msg[data-mid="${CSS.escape(mid)}"]`);
  if (node) { node.scrollIntoView({ block: "center", behavior: "smooth" }); node.classList.add("msg-flash"); setTimeout(() => node.classList.remove("msg-flash"), 1200); }
  return !!node;
}

/* ---- paginated window helpers (global indexes; archive + live) ---- */
// Is the in-memory window contiguous with the live tail?
function atTail(ts) { return !ts || (ts.firstIndex || 0) + (ts.messages ? ts.messages.length : 0) >= (ts.totalMessages || 0); }
let _loadingNewer = false;
// Page NEWER messages into a detached window (scrolling down after a jump).
async function loadNewer() {
  const ts = activeTS();
  if (!ts || _loadingNewer || atTail(ts)) return;
  _loadingNewer = true;
  try {
    const end = ts.firstIndex + ts.messages.length;
    const r = await atom.sessions.messages(ts.meta.id, Math.min(ts.totalMessages || end + RENDER_STEP, end + RENDER_STEP), RENDER_STEP).catch(() => null);
    if (!r || !r.messages || !r.messages.length) return;
    const skip = Math.max(0, end - r.firstIndex);           // overlap with what we already hold
    const add = r.messages.slice(skip);
    if (r.total) ts.totalMessages = Math.max(ts.totalMessages || 0, r.total);
    if (!add.length) return;
    ts.messages = ts.messages.concat(add);
    // Bound RAM from the top while paging down (the top stays one scroll-up away).
    if (ts.messages.length > MEM_CAP) { const drop = ts.messages.length - MEM_CAP; ts.messages.splice(0, drop); ts.firstIndex += drop; ts.viewStart = Math.max(0, (ts.viewStart || 0) - drop); }
    const w = $("chatWrap"); const oldTop = w.scrollTop;
    renderMessagesRegion();
    // Appending below doesn't move what the user is reading — keep the same offset.
    w.scrollTop = oldTop;
    if (atTail(ts)) { ts.unseenNew = 0; renderNewMsgBadge(); }
  } finally { _loadingNewer = false; }
}
// Replace the window with the live tail (jump to latest from a detached window).
async function reloadTail(ts) {
  const r = await atom.sessions.messages(ts.meta.id, ts.totalMessages || 0, RENDER_STEP * 2).catch(() => null);
  if (!r) return;
  ts.messages = r.messages || []; ts.firstIndex = r.firstIndex || 0;
  if (r.total) ts.totalMessages = r.total;
  ts.viewStart = Math.max(0, ts.messages.length - RENDER_STEP);
  ts.unseenNew = 0;
  if (ts === activeTS()) { renderMessagesRegion(); renderNewMsgBadge(); }
}
// Bring a GLOBAL message index on screen: expand the window if it's in RAM,
// otherwise load a page centred on it (from the archive if that's where it is),
// then scroll to it and flash it. `q` re-applies a find highlight after the jump.
async function jumpToIndex(g, q) {
  const ts = activeTS(); if (!ts) return;
  g = Math.max(0, Math.min(g, Math.max(0, (ts.totalMessages || 1) - 1)));
  const end = ts.firstIndex + ts.messages.length;
  if (g >= ts.firstIndex && g < end) {
    const local = g - ts.firstIndex;
    if (local < (ts.viewStart || 0)) { ts.viewStart = Math.max(0, local - 3); renderMessagesRegion(); }
  } else {
    const start = Math.max(0, g - Math.floor(RENDER_STEP / 2));
    const pageEnd = Math.min(ts.totalMessages || start + RENDER_STEP, start + RENDER_STEP);
    const r = await atom.sessions.messages(ts.meta.id, pageEnd, RENDER_STEP).catch(() => null);
    if (!r || !r.messages || !r.messages.length) { toast("Couldn't load that part of the conversation", "alert"); return; }
    ts.messages = r.messages; ts.firstIndex = r.firstIndex; if (r.total) ts.totalMessages = r.total;
    ts.viewStart = 0;
    renderMessagesRegion();
  }
  _followTail = false;
  const m = ts.messages[g - ts.firstIndex];
  const go = () => { if (m && m.id) jumpToMessage(m.id); if (q && $("chatSearch")) doChatFind(q); updateScrollBtn(); renderNewMsgBadge(); };
  requestAnimationFrame(() => requestAnimationFrame(go));
}
// "N new" pill on the jump-to-latest button while the window is detached.
function renderNewMsgBadge() {
  const b = $("scrollBtn"); const ts = activeTS();
  if (!b) return;
  const n = ts && !atTail(ts) ? (ts.unseenNew || 0) : 0;
  b.dataset.count = n ? (n > 99 ? "99+" : String(n)) : "";
  if (ts && !atTail(ts)) b.classList.remove("hidden");
  b.title = n ? `${n} new message${n > 1 ? "s" : ""} — jump to latest` : "Jump to latest";
}
// Prompt picker: every user prompt in the session (from disk, archive included),
// searchable; pick one → the transcript loads that spot and scrolls to it.
let _promptCache = { id: "", total: -1, prompts: [] };
async function openPromptPicker(anchor) {
  const ts = activeTS(); if (!ts) return;
  const old = $("promptPicker"); if (old) { old.remove(); return; }
  const wrap = $("main"); if (!wrap) return;
  const input = h("input", { class: "cf-input", placeholder: "Search prompts…", spellcheck: "false" });
  const count = h("span", { class: "pp-count" });
  const list = h("div", { class: "pp-list" }, h("div", { class: "pp-empty", text: "Loading…" }));
  const box = h("div", { id: "promptPicker", class: "prompt-picker" },
    h("div", { class: "pp-head" }, h("span", { class: "cf-ico", html: icon("chat", 14) }), input, count, h("button", { class: "cf-btn", title: "Close (Esc)", html: icon("close", 14), onclick: () => box.remove() })),
    list);
  wrap.appendChild(box);
  if (anchor && anchor.getBoundingClientRect) { const r = anchor.getBoundingClientRect(), m = wrap.getBoundingClientRect(); box.style.top = (r.bottom - m.top + 6) + "px"; box.style.right = Math.max(8, m.right - r.right) + "px"; }
  const outside = (e) => { if (!box.contains(e.target) && e.target !== anchor) { box.remove(); document.removeEventListener("mousedown", outside, true); } };
  document.addEventListener("mousedown", outside, true);
  let prompts = [];
  if (_promptCache.id === ts.meta.id && _promptCache.total === (ts.totalMessages || 0)) prompts = _promptCache.prompts;
  else { try { prompts = (await atom.sessions.prompts(ts.meta.id)).prompts || []; } catch { prompts = []; } _promptCache = { id: ts.meta.id, total: ts.totalMessages || 0, prompts }; }
  if (!document.body.contains(box)) return;
  let sel = -1, vis = prompts;
  const curIdx = ts.firstIndex + (ts.viewStart || 0);            // roughly what's on screen
  const fmtWhen = (iso) => { if (!iso) return ""; const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "2-digit" }); };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    vis = q ? prompts.filter((p) => p.text.toLowerCase().includes(q)) : prompts;
    count.textContent = q ? `${vis.length} / ${prompts.length}` : String(prompts.length);
    list.innerHTML = "";
    if (!vis.length) { list.append(h("div", { class: "pp-empty", text: prompts.length ? "No prompts match." : "No prompts yet." })); return; }
    // Nearest prompt at/before the visible window is marked as "you are here".
    let cur = -1; for (let i = 0; i < vis.length; i++) if (vis[i].index <= curIdx + 2) cur = i;
    if (sel < 0) sel = cur >= 0 ? cur : vis.length - 1;
    const frag = document.createDocumentFragment();
    vis.forEach((p, i) => frag.append(h("div", { class: "pp-item" + (i === sel ? " sel" : "") + (i === cur ? " cur" : ""), dataset: { i: String(i) }, title: p.text, onclick: () => pick(i) },
      h("span", { class: "pp-n", text: "#" + (prompts.indexOf(p) + 1) }),
      h("span", { class: "pp-text", text: p.text || "(empty prompt)" }),
      h("span", { class: "pp-time", text: fmtWhen(p.ts) }))));
    list.append(frag);
    const selEl = list.children[sel]; if (selEl) selEl.scrollIntoView({ block: "nearest" });
  };
  const pick = (i) => { const p = vis[i]; if (!p) return; box.remove(); document.removeEventListener("mousedown", outside, true); jumpToIndex(p.index); };
  input.addEventListener("input", () => { sel = -1; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); box.remove(); document.removeEventListener("mousedown", outside, true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(vis.length - 1, sel + 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(sel); }
  });
  draw();
  input.focus();
}

// Messages above the rendered window: firstIndex is GLOBAL (archived messages
// included — they page in from disk like any other), viewStart is within RAM.
function hiddenOlderCount(ts) { return (ts.firstIndex || 0) + (ts.viewStart || 0); }
function archivedOlderCount() { return 0; }   // archived turns are loadable now — nothing to flag
function topSentinel(hidden) {
  // It IS a button — label it like one. ("scroll up to load" read as a passive
  // hint, so clicking it felt broken even when the click was doing its job.)
  const n = Math.min(hidden, RENDER_STEP);
  const text = hidden > 0 ? `Load ${n} earlier message${n > 1 ? "s" : ""}${hidden > RENDER_STEP ? ` (${hidden.toLocaleString()} more above)` : ""}` : "Start of conversation";
  // Bound on mousedown, not click: a re-render (streaming flush, or the scroll
  // auto-loader firing as you reach the top) swaps this node out between press and
  // release, so the click event never lands on the same element and is dropped.
  return h("div", { class: "load-more" + (hidden > 0 ? "" : " load-more-static"), onmousedown: hidden > 0 ? ((e) => { if (e.button === 0) { e.preventDefault(); loadOlder(); } }) : null },
    h("span", { html: icon("history", 13) }),
    h("span", { text }));
}
// Below a detached window: how many newer messages remain, click to page them in.
function bottomSentinel(ts) {
  const remaining = Math.max(0, (ts.totalMessages || 0) - (ts.firstIndex + ts.messages.length));
  if (!remaining) return null;
  const n = Math.min(remaining, RENDER_STEP);
  return h("div", { class: "load-more load-more-bottom", onmousedown: (e) => { if (e.button === 0) { e.preventDefault(); loadNewer(); } } },
    h("span", { html: icon("chevronDown", 13) }),
    h("span", { text: `Load ${n} newer message${n > 1 ? "s" : ""}${remaining > RENDER_STEP ? ` (${remaining.toLocaleString()} more below)` : ""}` }),
    h("button", { class: "load-more-jump", text: "Jump to latest", onmousedown: (e) => { e.stopPropagation(); e.preventDefault(); scrollBottom(true); } }));
}

function renderMessagesRegion() {
  const ts = activeTS();
  const msgs = $("chatMessages");
  if (!msgs || !ts) return;
  msgs.innerHTML = "";
  const total = ts.messages.length;
  if (!total && !ts.firstIndex) {
    // Empty session (e.g. a brand-new tab): still refresh the overlays, or the
    // PREVIOUS session's prompt-rail dots and model filter stay on screen — they
    // live in #main, which isn't rebuilt per tab.
    msgs.append(emptyState());
    renderPromptRail();
    renderModelFilter();
    return;
  }
  if (ts.viewStart == null || ts.viewStart > total) ts.viewStart = Math.max(0, total - RENDER_STEP);
  const hidden = hiddenOlderCount(ts);
  if (hidden > 0 || archivedOlderCount(ts)) msgs.append(topSentinel(hidden));
  for (let i = ts.viewStart; i < total; i++) msgs.append(renderMessage(ts.messages[i], ts));
  if (!atTail(ts)) { const bs = bottomSentinel(ts); if (bs) msgs.append(bs); }
  renderNewMsgBadge();
  renderPromptRail();
  renderModelFilter();            // top-right provider/model filter (when a chat mixes them)
  applyModelFilter(ts);
  if ($("chatSearch")) doChatFind($("chatFindInput") ? $("chatFindInput").value : "");  // re-apply highlights after a re-render
}

// When a conversation has replies from ≥2 distinct provider+model combos, show a
// filter pinned top-right; picking one fades the replies that don't match.
function renderModelFilter() {
  const ts = activeTS(); const wrap = $("main");   // non-scrolling parent — stays pinned top-right
  if (!ts || !wrap) { const e = $("modelFilter"); if (e) e.remove(); return; }
  const seen = new Map();   // "provider|model" → meta
  for (const m of ts.messages) if (m.role === "assistant" && m.meta && m.meta.provider) { const k = metaKey(m.meta); if (!seen.has(k)) seen.set(k, m.meta); }
  if (ts.modelFilter && ![...seen.keys()].includes(ts.modelFilter)) ts.modelFilter = null;
  let el = $("modelFilter");
  if (!el) { el = h("div", { id: "modelFilter", class: "model-filter" }); wrap.appendChild(el); }
  el.innerHTML = "";
  // Expanding search icon (replaces the old bare filter) — opens the in-conversation
  // + on-disk search for THIS session. Always present, top-right.
  el.append(h("button", { class: "mf-search", title: "Search this conversation (Ctrl+F)", html: icon("search", 13), onclick: () => openChatSearch() }));
  // Prompt picker — every prompt in this session (archive included), searchable;
  // pick one to load that part of the transcript and scroll to it.
  el.append(h("button", { class: "mf-search mf-prompts", title: "Prompts in this conversation (Ctrl+Shift+P)", html: icon("chat", 13) + icon("chevronDown", 10), onclick: (e) => openPromptPicker(e.currentTarget) }));
  // Model-filter chips only when the conversation actually mixes ≥2 provider/models.
  if (seen.size >= 2) {
    const chip = (key, label, cls) => h("button", { class: "mf-chip" + ((ts.modelFilter || null) === key ? " active" : "") + (cls ? " " + cls : ""), text: label, title: key ? `Show only replies from ${label}` : "Show every reply", onclick: () => { ts.modelFilter = key; renderModelFilter(); applyModelFilter(ts); } });
    // An ACTIVE filter is always visible as such, with a one-click way out.
    el.append(chip(null, ts.modelFilter ? "Show all ✕" : "All", ts.modelFilter ? "mf-clear" : ""));
    for (const [k, meta] of seen) el.append(chip(k, meta.endpointName || modelName(meta.provider, meta.model) || PROVIDER_NAME[meta.provider] || meta.provider));
  } else if (ts.modelFilter) { ts.modelFilter = null; applyModelFilter(ts); }
}
function applyModelFilter(ts) {
  const f = ts && ts.modelFilter;
  for (const el of document.querySelectorAll("#chatMessages .msg.assistant")) el.classList.toggle("msg-filtered", !!f && el.dataset.mk !== f);
}

function ensureTopSentinel() {
  const ts = activeTS();
  const msgs = $("chatMessages");
  if (!msgs || !ts) return;
  const existing = msgs.querySelector(".load-more");
  if (existing) existing.remove();
  const hidden = hiddenOlderCount(ts);
  if (hidden > 0 || archivedOlderCount(ts)) msgs.insertBefore(topSentinel(hidden), msgs.firstChild);
}

// Load an older page — first expand the in-memory window, then fetch the next
// page from disk — keeping the viewport anchored on what the user was reading.
// A small spinner pins to the top while the disk page loads.
async function loadOlder() {
  const ts = activeTS();
  if (!ts || _loadingOlder) return;
  _loadingOlder = true;
  try { await loadOlderInner(ts); } finally { _loadingOlder = false; }
}
async function loadOlderInner(ts) {
  const w = $("chatWrap");
  const oldH = w.scrollHeight, oldTop = w.scrollTop;
  if (ts.viewStart > 0) {
    ts.viewStart = Math.max(0, ts.viewStart - RENDER_STEP);
    renderMessagesRegion();
    w.scrollTop = oldTop + (w.scrollHeight - oldH);
    return;
  }
  if (ts.firstIndex > 0) {
    const spin = h("div", { class: "load-older" }, h("span", { class: "spinner" }), h("span", { text: "Loading earlier messages…" }));
    $("chatMessages").prepend(spin);
    const t0 = performance.now();
    const r = await atom.sessions.messages(ts.meta.id, ts.firstIndex, RENDER_STEP).catch(() => null);
    // keep the spinner visible long enough to register (avoids a 1-frame flash)
    const wait = Math.max(0, 180 - (performance.now() - t0));
    if (wait) await new Promise((res) => setTimeout(res, wait));
    spin.remove();
    if (r && r.messages && r.messages.length) {
      ts.messages = r.messages.concat(ts.messages);
      ts.firstIndex = r.firstIndex;
      if (r.total) ts.totalMessages = Math.max(ts.totalMessages || 0, r.total);
      ts.viewStart = 0;
      // Keep RAM bounded while paging UP: drop the newest part of the window (it's
      // one scroll-down away). The window is then detached from the tail; scrolling
      // down pages it back in.
      if (ts.messages.length > MEM_CAP) ts.messages.length = MEM_CAP;
      // Apply any patches that arrived for messages while they were outside
      // the in-RAM window (e.g. tool cards whose result arrived after MEM_CAP
      // trim) so they don't render as stale "running" cards.
      if (ts._pendingPatches && ts._pendingPatches.size) {
        for (const m of r.messages) {
          const p = ts._pendingPatches.get(m.id);
          if (p) { Object.assign(m, p); ts._pendingPatches.delete(m.id); }
        }
      }
      renderMessagesRegion();
      w.scrollTop = oldTop + (w.scrollHeight - oldH);
    }
  }
}

// Drop the oldest rendered nodes once we exceed MAX_RENDER (only while the user
// is following the live tail, so we never yank away history they're reading).
function trimRenderedTop() {
  const ts = activeTS();
  const msgs = $("chatMessages");
  if (!ts || !msgs) return;
  const nodes = msgs.querySelectorAll(".msg");
  const over = nodes.length - MAX_RENDER;
  if (over > 0) {
    for (let i = 0; i < over; i++) nodes[i].remove();
    ts.viewStart += over;
    ensureTopSentinel();
  }
}

function emptyState() {
  const ts = activeTS();
  const suggestions = [
    { t: "Explain this codebase", s: "Give me a high-level tour of the project structure and key files." },
    { t: "Find and fix a bug", s: "Look for issues in the code and propose fixes." },
    { t: "Add a feature", s: "Implement a new feature end to end with tests." },
    { t: "Write tests", s: "Add unit tests for the most important modules." },
  ];
  const grid = h("div", { class: "suggest-grid" });
  for (const s of suggestions) grid.append(h("button", { class: "suggest", onclick: () => { const ta = $("promptInput"); ta.value = s.s; ta.focus(); autoGrow(); } },
    h("b", { text: s.t }), s.s));
  return h("div", { class: "chat-empty" },
    h("span", { class: "ce-mark", html: icon("atom", 70) }),
    h("h2", { text: "Start building with Claude" }),
    h("p", { html: `Working in <b style="color:var(--text-2)">${baseName(state.project || ts.meta.cwd)}</b>. Pick a folder on the left, then describe what you want done — AtomNano runs Claude Code's full toolset right here.` }),
    grid);
}

function roleLine(label, tsIso, copyBtn) {
  // DOM order [label, copy, time]: assistant rows read "Claude · copy · time"; user
  // rows are row-reversed in CSS → "time · copy · You", i.e. copy sits before "You".
  return h("div", { class: "msg-role" }, h("span", { class: "msg-role-label", text: label }), copyBtn || null, h("span", { class: "msg-time", text: fmtTime(tsIso) }));
}
function imgSrc(a) { return a.data ? `data:${a.mediaType || "image/png"};base64,${a.data}` : a.path ? "file:///" + String(a.path).replace(/\\/g, "/") : a.thumb || ""; }
function attachmentsRow(atts) {
  if (!atts || !atts.length) return null;
  const row = h("div", { class: "msg-attachments" });
  for (const a of atts) {
    if (a.kind === "image" && (a.thumb || a.data || a.path)) {
      // Prefer the full image (data ▸ file path) for a crisp preview; the thumb
      // is only a fallback (e.g. a pasted image after reload).
      const im = h("img", { class: "msg-att-img", src: imgSrc(a) || a.thumb, title: "Click to view · " + (a.name || "image"), onclick: () => openImageViewer(imgSrc(a) || a.thumb, a.name) });
      im.addEventListener("error", () => { if (a.thumb && im.src !== a.thumb) im.src = a.thumb; });
      row.append(im);
    } else {
      row.append(h("span", { class: "msg-att-file", title: "Open · " + (a.path || a.name), onclick: () => openAttachment(a) },
        h("span", { html: icon("file", 12) }), h("span", { text: a.name || baseName(a.path || "file") })));
    }
  }
  return row;
}
// Open a non-image attachment: text-ish files in the editor, otherwise externally.
function openAttachment(a) {
  if (!a) return;
  if (a.kind === "image") return openImageViewer(imgSrc(a), a.name);
  if (a.path && /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|xml|yml|yaml|csv|log|py|go|rs|java|c|cpp|h|sh)$/i.test(a.path)) { Promise.resolve(openInEditor(a.path)).catch(() => atom.shell.openExternal("file:///" + a.path.replace(/\\/g, "/"))); return; }
  if (a.path) atom.shell.openExternal("file:///" + a.path.replace(/\\/g, "/"));
}

/* ---------------------------- image viewer ---------------------------- */
function openImageViewer(src, name) {
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
function msgCopyBtn(text) {
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
function msgDeleteBtn(mid) {
  if (!mid) return null;
  return h("button", {
    class: "msg-copy msg-del", dataset: { tip: "Delete", tipDir: "top" },
    onclick: (e) => { e.stopPropagation(); e.currentTarget.blur(); deleteMessage(mid); },
  }, h("span", { html: icon("trash", 12) }));
}
// Inline actions shown in the role line (above the message): copy + delete.
function msgTopActions(m) { return h("span", { class: "msg-actions" }, msgCopyBtn(m.text), msgDeleteBtn(m.id)); }
// Footer actions shown below the message bubble: copy + delete.
function msgBottomActions(m) { return h("div", { class: "msg-actions msg-actions-btm" }, msgCopyBtn(m.text), msgDeleteBtn(m.id)); }
// Delete a message: remove from the on-disk transcript, then from the live view.
async function deleteMessage(mid) {
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

const RV_LABEL = { openai: "Codex", google: "Antigravity", anthropic: "Claude", custom: "Custom" };
const PROVIDER_NAME = { anthropic: "Claude", google: "Antigravity", openai: "OpenAI", custom: "Custom" };
const THINK_NAMES = { off: "", think: "Think", "think-hard": "Think hard", "think-harder": "Think harder", ultrathink: "Ultrathink", none: "Effort: none", minimal: "Effort: minimal", low: "Effort: low", medium: "Effort: medium", high: "Effort: high", xhigh: "Effort: x-high", max: "Effort: max", ultra: "Effort: ultra", persistent: "Effort: persistent", ultracode: "Effort: ultracode" };
// Pretty model name from the (provider-aware) catalog, else a Claude-id heuristic.
function modelName(provider, id) {
  if (!id) return "";
  const cat = state.providerCatalog && state.providerCatalog[provider];
  const m = cat && (cat.models || []).find((x) => x.id === id);
  if (m) return m.name;
  const local = MODELS.find((x) => x.id === id);
  return (local && local.name) || prettyModelName(id) || id;
}
// Stable filter key for a reply's provider+model.
function metaKey(meta) { return meta && meta.provider ? `${meta.provider}|${meta.model || ""}` : ""; }
// The small descriptor row under a reply: provider's model · thinking · reviewers.
function replyMetaRow(meta) {
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
function imageMsgCard(m) {
  const body = h("div", { class: "msg-body" }, roleLine((PROVIDER_NAME[m.provider] || "Image"), m.ts, null));
  body.append(h("div", { class: "img-gen-cap" }, h("span", { html: icon("image", 12) }), h("span", { text: "Generated image · " + (m.prompt || "") + (m.mode === "photo" ? "" : " · vector") })));
  const row = attachmentsRow(m.images);
  if (row) body.append(row);
  return h("div", { class: "msg assistant", dataset: { mid: m.id } }, h("div", { class: "msg-avatar assistant", html: icon("image", 16) }), body);
}
function reviewerCard(m) {
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
function renderMessage(m, ts) {
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
      return h("div", { class: "msg assistant" + (m.parentToolUseId ? " subagent" : ""), dataset: ds }, h("div", { class: "msg-avatar assistant", html: icon("atom", 17) }), body);
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
    default:
      return h("div", { dataset: { mid: m.id } });
  }
}
// The bounded conversation record a synthesized session carries from its source (exact,
// shortened or summary + recent entries, sized to the model). It IS part of what the model
// receives on the first turn, so it is shown in full — collapsed, expandable.
function recordCard(m) {
  const meta = m.meta || {};
  const mode = meta.mode === "summary" ? "summary of the oldest entries + recent entries verbatim" : meta.mode === "shortened" ? "verbatim, long tool outputs shortened" : "verbatim";
  const label = `Continued from "${meta.sourceName || "a previous session"}" — ${Number(meta.entries || 0).toLocaleString()} entries carried (${mode})`;
  return h("div", { class: "thinking-card summary-card record-card" },
    h("div", { class: "thinking-head" }, h("span", { html: icon("history", 15) }), h("span", { text: label }), h("span", { class: "chev", html: icon("chevron", 13) })),
    h("div", { class: "thinking-body", text: m.text || "" }));
}
// The condensed record a fresh provider thread received when the exact record could not
// fit the model's context window (history.js budgeted transfer). Shown so what the model
// was told is never hidden; collapsed like the reasoning card, expands on click.
function summaryCard(m) {
  const meta = m.meta || {};
  const who = meta.provider ? (PROVIDER_NAME[meta.provider] || meta.provider) : "the model";
  const label = `Context summary carried into ${who}'s new thread` + (meta.entries ? ` — ${Number(meta.entries).toLocaleString()} earlier entries condensed` : "");
  return h("div", { class: "thinking-card summary-card" },
    h("div", { class: "thinking-head" }, h("span", { html: icon("history", 15) }), h("span", { text: label }), h("span", { class: "chev", html: icon("chevron", 13) })),
    h("div", { class: "thinking-body", html: renderMarkdown(m.text || "") }));
}
function wrapFlow(node, mid, parentToolUseId) { return h("div", { class: "msg flow" + (parentToolUseId ? " subagent" : ""), dataset: { mid } }, node); }

// The Planner's plan — its own card (distinct from the Coder's answer), tagged
// with the model that produced it and a note that the Coder implements it.
function plannerCard(m) {
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

function thinkingCard(text) {
  const card = h("div", { class: "thinking-card" },
    h("div", { class: "thinking-head" }, h("span", { html: icon("brain", 15) }), h("span", { text: "Reasoning" }), h("span", { class: "chev", html: icon("chevron", 13) })),
    h("div", { class: "thinking-body", text: text }));
  return card;
}

// One tool call = ONE card that advances through preparing (arguments still
// streaming) → running (→ awaiting approval) → done | error | interrupted, and is
// patched in place on every update (see patchToolCard) so its DOM node, expansion
// and selection survive.
function toolStateHtml(m) {
  return m.status === "done" ? `<span class="tool-state done">${icon("check", 14)}</span>`
    : m.status === "error" ? `<span class="tool-state error">${icon("x", 14)}</span>`
      : m.status === "interrupted" ? `<span class="tool-state interrupted" title="Stopped before this finished">${icon("stop", 12)}</span>`
        : m.status === "preparing" ? `<span class="tool-state preparing" title="Preparing the call…"><span class="spinner"></span></span>`
          : `<span class="tool-state running"><span class="spinner"></span></span>`;
}
function fmtElapsed(s) { s = Math.max(0, Math.round(+s || 0)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; }
// Patch an existing tool card's status, summary, elapsed/progress and result in
// place. Returns false when the card's shape changed (renamed tool) so the caller
// rebuilds it instead.
function patchToolCard(node, m, ts) {
  const card = node.querySelector(".tool-card");
  if (!card) return false;
  const nameEl = card.querySelector(".tool-name");
  const shownName = nameEl ? nameEl.textContent : "";
  const displayName = splitToolName(m.toolName).name;
  if (shownName && displayName && shownName !== displayName) return false;
  card.className = "tool-card " + (m.status || "running") + (card.classList.contains("open") ? " open" : "");
  const stateEl = card.querySelector(".tool-state"); if (stateEl && stateEl.parentElement) stateEl.parentElement.innerHTML = toolStateHtml(m);
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
function revealToolDetail(card, m) {
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
function splitToolName(tn) {
  tn = String(tn || "");
  let m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tn) || (tn.startsWith("mcp__") ? /^mcp__(.+?)__(.+)$/.exec(tn) : null);
  if (m) return { server: m[1], name: m[2] };
  m = /^mcp:([^/]+)\/(.+)$/.exec(tn);
  if (m) return { server: m[1], name: m[2] };
  return { server: "", name: tn };
}
function toolCard(m, ts) {
  const card = h("div", { class: "tool-card " + (m.status || "running"), dataset: { mid: m.id } });
  const stateIco = toolStateHtml(m);
  // Also compute the result size — MCP calls often return large blobs (search hits,
  // file contents, memory retrievals), and the char/token count is the closest thing
  // to "cost" we can attribute.
  const tn = m.toolName || "";
  const { server: serverTag, name: displayName } = splitToolName(tn);
  const resSize = mcpResultSize(m);
  card.append(
    h("div", { class: "tool-head" },
      h("span", { class: "tool-ico", html: icon(toolIcon(tn), 15) }),
      serverTag ? h("span", { class: "tool-mcp-tag", title: `MCP server: ${serverTag}`, text: serverTag }) : null,
      h("span", { class: "tool-name", text: displayName }),
      m.background ? h("span", { class: "tool-bg", text: "background" }) : null,
      toolSummaryEl(m, ts),
      resSize ? h("span", { class: "tool-size", title: `${resSize.chars} chars returned  (~${resSize.tokens} tokens the model reads back — the FULL result, not a truncated copy)`, text: `${fmtCompactTok(resSize.chars)}c · ~${fmtCompactTok(resSize.tokens)}t` }) : null,
      (m.status === "running" && m.elapsedSeconds != null) ? h("span", { class: "tool-elapsed", text: fmtElapsed(m.elapsedSeconds) }) : null,
      h("span", { html: stateIco }),
      h("span", { class: "tool-chev", html: icon("chevron", 14) })),
    toolDetail(m));
  return card;
}
// Pull the tool-result payload size off a tool message. Anthropic sends the
// result back as `m.result` (string) or content array. We treat char count as
// authoritative and estimate tokens at ~1 per 4 chars (rough English rule).
function mcpResultSize(m) {
  if (!m || m.status === "running") return null;
  const raw = m.result;
  let text = "";
  if (typeof raw === "string") text = raw;
  else if (Array.isArray(raw)) text = raw.map((b) => (typeof b === "string" ? b : b && b.text) || "").join("");
  else if (raw && typeof raw === "object" && typeof raw.text === "string") text = raw.text;
  if (!text) return null;
  return { chars: text.length, tokens: Math.max(1, Math.round(text.length / 4)) };
}
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PATH_TOOLS = new Set(["Grep", "Glob"]);
// The card's summary: a clickable file link for file tools, "pattern in <folder>" with a
// clickable folder/file for searches, plain text otherwise. Both harnesses feed the same
// shape — Claude's tool_use input, Codex items mapped by claude.js (cat → Read, rg → Grep …).
function toolSummaryEl(m, ts) {
  const i = (m.toolInput && typeof m.toolInput === "object") ? m.toolInput : {};
  const str = (v) => (typeof v === "string" && v ? v : "");
  const fp = str(i.file_path) || str(i.notebook_path) || (FILE_TOOLS.has(m.toolName) ? str(i.path) : "");
  if (fp && FILE_TOOLS.has(m.toolName)) {
    const isEdit = m.toolName !== "Read";
    const suffix = (m.toolName === "Edit" || m.toolName === "MultiEdit") ? " · edit" : m.toolName === "Write" ? " · write" : "";
    return h("a", {
      class: "tool-summary file-link", text: relPath(fp, ts.meta.cwd) + suffix, title: isEdit ? fp + "  (click → jump to the change)" : fp,
      onclick: (e) => { e.stopPropagation(); if (isEdit) openEditAtChange(fp, m); else openInEditor(fp); },
      oncontextmenu: (ev) => { ev.preventDefault(); ev.stopPropagation(); fileContextMenu(ev, { path: fp, name: baseName(fp), isDir: false }); },
    });
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
async function openPathTarget(p, query) {
  let isDir = false;
  try { await atom.files.list(p); isDir = true; } catch { isDir = false; }
  if (isDir) openSearch({ mode: "content", root: p, query: query || "" });
  else openInEditor(p);
}
// Open a file the agent edited and land on the exact changed section: search for
// the edit's inserted text first (exact), then fall back to the first changed
// line vs git HEAD, then plain open.
// The first editor open lazy-loads CodeMirror — wait until the target file is live.
async function waitForEditor(fp, ms = 2500) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (cm && stateActiveFile() && stateActiveFile().path === fp && cm._loaded === fp) return true;
    if (cm && stateActiveFile() && stateActiveFile().path === fp && cm.docText().length) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !!(cm && stateActiveFile() && stateActiveFile().path === fp);
}
async function openEditAtChange(fp, m) {
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
async function openFileAtFirstChange(fp, alreadyOpen) {
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
function toolDetail(m) {
  const det = h("div", { class: "tool-detail" });
  const i = (m.toolInput && typeof m.toolInput === "object") ? m.toolInput : null;
  const label = (t) => h("div", { class: "det-label", text: t });
  const pre = (t, cls) => h("pre", { class: cls || "", text: t == null || t === "" ? "—" : String(t) });
  const tn = m.toolName || "";
  const isStr = (v) => typeof v === "string";
  if (i && (tn === "Write" || tn === "NotebookEdit") && isStr(i.content ?? i.new_source)) {
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
  if (m.outputFile) det.append(label("Output file"), pre(m.outputFile));
  if (m.result != null && m.result !== "") det.append(label("Result"), pre(m.result));
  return det;
}
function toolIcon(name) {
  const map = { Read: "eye", Edit: "pencil", Write: "pencil", MultiEdit: "pencil", NotebookEdit: "pencil", Delete: "trash", Bash: "terminal", BashOutput: "terminal", Grep: "search", Glob: "search", Task: "sparkle", WebFetch: "globe", WebSearch: "globe", TodoWrite: "list" };
  return map[name] || "cpu";
}
// One-line summary of a tool call. The call's arguments may still be STREAMING (status
// "preparing": the harness announced the tool before its JSON arguments finished), so
// every field is optional here — a missing path/command reads "preparing…", never
// "undefined". Once the field arrives the card is patched (see patchToolCard).
function toolSummary(m, ts) {
  const i = (m.toolInput && typeof m.toolInput === "object") ? m.toolInput : {};
  const str = (v) => (typeof v === "string" && v ? v : "");
  const rel = (p) => (str(p) ? relPath(p, ts.meta.cwd) : "");
  const pending = m.status === "preparing" || m.status === "running" ? "preparing…" : "";
  const filed = (p, suffix) => (str(p) ? rel(p) + suffix : pending);
  switch (m.toolName) {
    case "Read": return rel(i.file_path) || pending;
    case "Edit": case "MultiEdit": return filed(i.file_path, " · edit");
    case "Write": return filed(i.file_path, " · write");
    case "Delete": return filed(i.file_path, " · delete");
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
function resultLine(meta, tsIso) {
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
  if (meta.provider === "openai" && meta.account) wrap.append(h("span", { class: "r-item", title: "Account the Codex runtime reported for this turn", text: String(meta.account) }));
  if (typeof meta.costUsd === "number" && meta.costUsd > 0) wrap.append(h("span", { class: "r-item", text: `$${meta.costUsd.toFixed(4)}` }));
  if (tsIso) wrap.append(h("span", { class: "r-item", text: fmtTime(tsIso) }));
  return wrap;
}
// Compact token count — 1234 → "1.2k", 15600 → "15.6k". Same fmtCompact idea we
// had for the removed headroom tile, restored here scoped to token counts.
function fmtCompactTok(n) {
  n = Math.round(+n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/* live streaming region */
function liveStreamText() {
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
function renderLive() {
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
          h("span", { class: "typing-label", text: "Thinking" }),
          h("div", { class: "typing" }, h("span"), h("span"), h("span"))))));
  }
  scrollBottom();
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
const MAX_LINE_CHARS = 2000;
// Label for the live bubble: the provider/model THIS run was dispatched with
// (snapshotted on the "running" status), falling back to the current setting
// only when no run snapshot exists.
function liveRunLabel(ts) {
  const r = ts && ts.meta && ts.meta.run;
  const prov = (r && r.provider) || state.settings.llmProvider || "anthropic";
  const base = PROVIDER_NAME[prov] || "Claude";
  return r && r.model ? `${base} · ${r.model}${r.effort ? " · " + r.effort : ""}` : base;
}

function splitStreamLines(text) {
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

function syncStreamLines(container, text, initial) {
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
let _liveRaf = 0, _liveTimer = 0, _liveGen = 0;
// Whichever scheduler fires first CANCELS its peer (not just forgets its handle) and
// checks it still belongs to the current view generation — so a paused rAF that
// wakes up later, or a stale timer, can never flush against another tab or run.
function flushLive(gen) {
  if (_liveRaf) { cancelAnimationFrame(_liveRaf); _liveRaf = 0; }
  if (_liveTimer) { clearTimeout(_liveTimer); _liveTimer = 0; }
  if (gen !== _liveGen) return;
  updateLiveText();
}
function scheduleLiveUpdate() {
  if (_liveRaf || _liveTimer) return;
  const gen = _liveGen;
  _liveRaf = requestAnimationFrame(() => flushLive(gen));
  // Fallback: when the window is occluded the compositor can pause rAF entirely, so
  // a reply would visibly stall. A ~100ms timer guarantees the stream keeps flowing
  // even with no frames; whichever fires first wins and cancels the other.
  _liveTimer = setTimeout(() => flushLive(gen), 100);
}
function cancelLiveUpdate() {
  _liveGen++;   // anything already scheduled belongs to the old view
  if (_liveRaf) { cancelAnimationFrame(_liveRaf); _liveRaf = 0; }
  if (_liveTimer) { clearTimeout(_liveTimer); _liveTimer = 0; }
}

// Lightweight per-token update — patches line text in place (no rebuild, no
// markdown re-parse), only falling back to a full rebuild when the structure
// (thinking ⇄ text ⇄ typing) actually changes.
function updateLiveText() {
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
function renderPerms() {
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
    host.append(h("div", { class: "perm-card" },
      h("div", { class: "perm-head" }, h("span", { html: icon("shield", 16) }), "Allow ", h("span", { class: "perm-tool", text: p.toolName }), "?", permCountdownChip(p)),
      h("div", { class: "perm-input", text: inputStr }),
      h("div", { class: "perm-actions" },
        h("button", { class: "btn btn-ghost btn-sm", text: "Deny", onclick: () => respondPerm(ts, p, false) }),
        h("button", { class: "btn btn-ghost btn-sm", title: `Allow all ${p.toolName} calls in this tab`, text: "Allow for session", onclick: () => respondPerm(ts, p, true, { always: true }) }),
        h("button", { class: "btn btn-primary btn-sm", text: "Allow once", onclick: () => respondPerm(ts, p, true) }))));
  }
  if (ts.pendingPerms.some((p) => !p.answered)) startPermTimer();
  scrollBottom();
}

// A user decision (permission / plan / question) waits for YOU: the run is paused until
// you answer, and nothing is decided on your behalf. The chip shows how long it has been
// waiting (the tab is marked "attention" meanwhile). The former 5-minute auto-decline made
// tools appear "denied" whenever a prompt sat unanswered while you were reading elsewhere.
function fmtCountdown(ms) { ms = Math.max(0, ms); const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
function permCountdownChip(p) { return h("span", { class: "perm-countdown", dataset: { rq: p.requestId }, title: "Waiting for your decision — the run is paused until you answer", text: "waiting " + fmtCountdown(Date.now() - (p.shownAt || Date.now())) }); }
function answeredCard(p) {
  return h("div", { class: "perm-card perm-answered" },
    h("div", { class: "perm-head" }, h("span", { class: "perm-tick", html: icon("check", 15) }),
      h("span", { class: "perm-answer-label", text: (p.answerLabel || "Answered") + (p.toolName ? " — " + p.toolName : "") })));
}
let _permTimer = null;
function startPermTimer() { if (!_permTimer) _permTimer = setInterval(permTick, 1000); }
function stopPermTimer() { if (_permTimer) { clearInterval(_permTimer); _permTimer = null; } }
function permTick() {
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
function planCard(ts, p) {
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
function applyPermissionMode(ts, mode) {
  state.settings.defaultPermissionMode = mode;
  atom.settings.set({ defaultPermissionMode: mode }).catch(() => {});
  if (permDD && permDD._refresh) permDD._refresh();
  if (ts && ts.meta) { ts.meta.permissionMode = mode; atom.sessions.setModeLive(ts.meta.id, mode).catch(() => {}); }
}
// Claude called AskUserQuestion — render its questions as radio (single) or
// checkbox (multi) pickers. The user's selection is delivered back as the tool
// response so Claude can continue with the chosen answer(s).
function askCard(ts, p) {
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
function respondPerm(ts, p, allow, opts = {}) {
  if (p.answered) return;
  if (allow && opts.always) {
    (ts.autoAllow || (ts.autoAllow = new Set())).add(p.toolName);
    // Persist so "for this session" survives a tab close / app restart.
    atom.sessions.update(ts.meta.id, { autoAllow: [...ts.autoAllow] }).catch(() => {});
  }
  atom.sessions.permissionResponse(p.requestId, { allow, message: allow ? "" : (opts.message || "Denied by user"), ...(allow && opts.answers ? { answers: opts.answers } : {}), ...(allow && opts.updatedInput ? { updatedInput: opts.updatedInput } : {}) });
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
function nearBottom() {
  const w = $("chatWrap");
  return w.scrollHeight - w.scrollTop - w.clientHeight < 140;
}
function scrollBottom(force) {
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

/* ============================================================
   CHANGES PANEL
   ============================================================ */
// The right side hosts one of three mutually-exclusive docks (Changes / Fleet /
// Skills), all sharing the same resizable width (--changes-w).
const DOCKS = { changes: "changesPanel", fleet: "fleetPanel", skills: "skillsPanel", tests: "testsPanel" };
function currentDock() {
  for (const [name, id] of Object.entries(DOCKS)) if (!$(id).classList.contains("hidden")) return name;
  return null;
}
function showDock(name) {
  for (const [n, id] of Object.entries(DOCKS)) $(id).classList.toggle("hidden", n !== name);
  $("changesResizer").classList.toggle("hidden", !name);
  const fb = $("fleetBtn"), sb = $("skillsBtn"), tb = $("testsBtn");
  if (fb) fb.classList.toggle("active", name === "fleet");
  if (sb) sb.classList.toggle("active", name === "skills");
  if (tb) tb.classList.toggle("active", name === "tests");
}
function toggleDock(name, render) {
  if (currentDock() === name) { showDock(null); return; }
  showDock(name); render();
}
function toggleChanges() { toggleDock("changes", renderChanges); }
function toggleFleet() { if (currentDock() === "fleet") { showDock(null); } else { showDock("fleet"); renderFleet(); refreshFleet(); } }
function toggleSkills() { toggleDock("skills", renderSkills); }
function toggleTests() { toggleDock("tests", renderTests); }

// Shared dock header (icon + title + subtitle + extra buttons + close).
function dockHead(ic, title, sub, onClose, extra = []) {
  return h("div", { class: "changes-head" },
    h("span", { html: icon(ic, 16) }),
    h("span", { class: "ch-title", text: title }),
    sub ? h("span", { class: "ch-count", text: sub }) : null,
    h("div", { class: "spacer" }),
    ...extra,
    h("button", { class: "ch-close", html: icon("close", 15), onclick: onClose }));
}

// Show/hide the whole Claude chat section (#main: chat + composer). Default = shown.
// When hidden, the editor (or file tree) fills the space. State is per-session-run
// only — it always starts shown on launch.
function toggleChat(force) {
  const hide = force != null ? force : !document.body.classList.contains("chat-collapsed");
  document.body.classList.toggle("chat-collapsed", hide);
  const btn = $("chatToggle");
  if (btn) { btn.classList.toggle("active", hide); btn.title = hide ? "Show chat (Ctrl+\\)" : "Hide chat (Ctrl+\\)"; }
  if (!hide) scrollBottom(true);   // re-anchor the conversation when shown again
  requestAnimationFrame(computeEditorOverflow);  // editor width changed
}
function renderChanges() {
  const ts = activeTS();
  const panel = $("changesPanel");
  if (panel.classList.contains("hidden")) return;
  panel.innerHTML = "";
  const files = ts ? ts.editedFiles : [];
  panel.append(h("div", { class: "changes-head" },
    h("span", { html: icon("pencil", 16) }),
    h("span", { class: "ch-title", text: "Changed files" }),
    h("span", { class: "ch-count", text: String(files.length) }),
    h("button", { class: "ch-close", html: icon("close", 15), onclick: toggleChanges })));
  const list = h("div", { class: "changes-list" });
  if (!files.length) list.append(h("div", { class: "changes-empty", text: "No files changed yet in this session." }));
  else for (const f of files.slice().reverse()) {
    list.append(h("div", {
      class: "change-row", title: "Open and jump to the first change", onclick: () => openFileAtFirstChange(f.path),
      oncontextmenu: (ev) => { ev.preventDefault(); fileContextMenu(ev, { path: f.path, name: baseName(f.path), isDir: false }); },
    },
      h("div", { class: "change-ico", html: icon("fileCode", 15) }),
      h("div", { class: "change-meta" },
        h("div", { class: "change-name", text: baseName(f.path) }),
        h("div", { class: "change-path", text: relPath(f.path, ts.meta.cwd) })),
      h("div", { class: "change-diff" },
        f.added ? h("span", { class: "d-add", text: "+" + f.added }) : null,
        f.removed ? h("span", { class: "d-del", text: "−" + f.removed }) : null,
        f.count > 1 ? h("span", { class: "change-count", text: "×" + f.count }) : null)));
  }
  panel.append(list);
}

/* ============================================================
   FLEET PANEL — dispatch background agents on a queue
   ============================================================ */
let fleetSnap = { tasks: [], running: 0, queued: 0, maxConcurrent: 0 };
let fleetDraft = "";

function refreshFleet() { atom.fleet.list().then((s) => { fleetSnap = s || fleetSnap; if (currentDock() === "fleet") renderFleet(); }).catch(() => {}); }

async function renderFleet() {
  const panel = $("fleetPanel");
  if (!panel || panel.classList.contains("hidden")) return;
  const draft = ($("fleetInput") ? $("fleetInput").value : fleetDraft) || "";
  panel.innerHTML = "";
  panel.append(dockHead("cpu", "Fleet", `${fleetSnap.running} running · ${fleetSnap.queued} queued`, toggleFleet, [
    h("button", { class: "dock-mini", title: "Clear finished tasks", html: icon("trash", 14), onclick: async () => { await atom.fleet.clearFinished().catch(() => {}); refreshFleet(); } }),
  ]));

  const ta = h("textarea", { class: "fleet-input", id: "fleetInput", rows: "3", spellcheck: "false",
    placeholder: state.project ? "Describe a task for a background agent…\nOne task per line — each line runs as its own agent." : "Open a project to dispatch agents.",
    disabled: !state.project, oninput: (e) => { fleetDraft = e.target.value; } });
  ta.value = draft;
  const conc = h("input", { type: "number", min: "1", max: "8", class: "fleet-conc", title: "Max agents running at once",
    value: String(fleetSnap.maxConcurrent || ""), onchange: (e) => { const n = Math.max(1, Math.min(8, +e.target.value || 1)); atom.settings.set({ fleetMaxConcurrent: n }).then(() => refreshFleet()); } });
  const dispatch = h("button", { class: "fleet-dispatch", disabled: !state.project, onclick: () => dispatchFleet() },
    h("span", { html: icon("send", 14) }), h("span", { text: "Dispatch" }));
  panel.append(h("div", { class: "fleet-compose" }, ta,
    h("div", { class: "fleet-compose-row" },
      h("label", { class: "fleet-conc-l", title: "Max concurrent agents" }, h("span", { html: icon("cpu", 12) }), conc),
      h("div", { class: "spacer" }), dispatch)));

  const list = h("div", { class: "fleet-list" });
  if (!fleetSnap.tasks.length) list.append(h("div", { class: "dock-empty", text: "No background tasks yet." }));
  for (const t of fleetSnap.tasks) list.append(fleetRow(t));
  panel.append(list);
}

async function dispatchFleet() {
  if (!state.project) return;
  const ta = $("fleetInput");
  const items = (ta ? ta.value : "").split("\n").map((s) => s.trim()).filter(Boolean).map((p) => ({ prompt: p }));
  if (!items.length) return;
  fleetDraft = ""; if (ta) ta.value = "";
  try { const made = await atom.fleet.enqueueMany(state.project, items); toast(`Dispatched ${made.length} agent${made.length > 1 ? "s" : ""}`, "cpu"); }
  catch (e) { toast(String((e && e.message) || e), "alert"); }
  refreshFleet();
}

const FLEET_BADGE = { queued: "Queued", running: "Running", done: "Done", error: "Failed", canceled: "Canceled", interrupted: "Interrupted", blocked: "Waiting" };
function fleetRow(t) {
  const st = t.status;
  const acts = [h("button", { class: "fleet-act", title: "Open transcript", html: icon("eye", 13), onclick: () => { openSessionTab(t.sessionId); } })];
  if (st === "running" || st === "queued") acts.push(h("button", { class: "fleet-act", title: "Cancel", html: icon("stop", 13), onclick: async () => { await atom.fleet.cancel(t.id).catch(() => {}); refreshFleet(); } }));
  if (["error", "canceled", "interrupted"].includes(st)) acts.push(h("button", { class: "fleet-act", title: "Retry", html: icon("refresh", 13), onclick: async () => { await atom.fleet.retry(t.id).catch(() => {}); refreshFleet(); } }));
  if (["done", "error", "canceled", "interrupted"].includes(st)) acts.push(h("button", { class: "fleet-act", title: "Remove", html: icon("close", 13), onclick: async () => { await atom.fleet.remove(t.id).catch(() => {}); refreshFleet(); } }));
  const claimed = (t.claimed || []).length
    ? h("div", { class: "fleet-claims" }, ...t.claimed.slice(0, 5).map((f) => h("span", { class: "fleet-chip", title: "editing " + f, text: baseName(f) })))
    : null;
  return h("div", { class: "fleet-row" },
    h("div", { class: "fleet-row-top" },
      h("span", { class: "fleet-badge fb-" + st, text: FLEET_BADGE[st] || st }),
      h("span", { class: "fleet-name", text: t.name, title: t.prompt }),
      h("div", { class: "spacer" }),
      t.conflicts ? h("span", { class: "fleet-conflict", title: t.conflicts + " same-file conflict(s) avoided", text: "⚠ " + t.conflicts }) : null),
    claimed,
    t.error ? h("div", { class: "fleet-err", text: t.error }) : null,
    h("div", { class: "fleet-row-acts" }, ...acts));
}

/* ============================================================
   SKILLS PANEL — marketplace, scout, hub, cross-project, import
   ============================================================ */
let skillsFormOpen = false;
let skillsFormDefaults = null;
let skillsSource = "my";          // "my" | "hub" | "import"
let skillsScoutQuery = "";
let skillsScoutResults = null;
let skillsHubCategory = "All";

async function renderSkills() {
  const panel = $("skillsPanel");
  if (!panel || panel.classList.contains("hidden")) return;
  panel.innerHTML = "";
  panel.append(dockHead("sparkle", "Skills", "", toggleSkills, [
    h("button", { class: "dock-mini", title: "Create new skill", html: icon("plus", 15), onclick: () => {
      skillsFormOpen = !skillsFormOpen; skillsFormDefaults = null; skillsSource = "my"; skillsScoutResults = null; renderSkills();
    } }),
  ]));
  if (!state.project) { panel.append(h("div", { class: "dock-empty", text: "Open a project to manage skills." })); return; }

  // Scout search bar
  const scoutInput = h("input", { class: "scout-input", placeholder: "Scout: describe what skill you need…", value: skillsScoutQuery,
    oninput: (e) => { skillsScoutQuery = e.target.value; },
    onkeydown: (e) => { if (e.key === "Enter") doSkillScout(); } });
  const clearBtn = skillsScoutResults ? h("button", { class: "scout-clear", title: "Clear results", html: icon("close", 12),
    onclick: () => { skillsScoutQuery = ""; skillsScoutResults = null; renderSkills(); } }) : null;
  panel.append(h("div", { class: "scout-bar" }, scoutInput, clearBtn,
    h("button", { class: "scout-btn", onclick: doSkillScout }, h("span", { html: icon("search", 13) }), h("span", { text: "Scout" }))));

  // Scout results replace normal view while active
  if (skillsScoutResults) { panel.append(renderScoutResults(skillsScoutResults)); return; }

  // Source pills (My Skills / Skill Hub / Import)
  const srcBar = h("div", { class: "skills-src-bar" });
  for (const [val, lbl, ic] of [["my", "My Skills", "sparkle"], ["hub", "Skill Hub", "globe"], ["import", "Import", "download"]]) {
    srcBar.append(h("button", { class: "skills-src-pill" + (skillsSource === val ? " active" : ""), onclick: () => { skillsSource = val; renderSkills(); } },
      h("span", { html: icon(ic, 12) }), h("span", { text: lbl })));
  }
  panel.append(srcBar);

  const list = h("div", { class: "skills-list" });
  if (skillsSource === "my") await renderMySkills(list);
  else if (skillsSource === "hub") await renderHubSkills(list);
  else if (skillsSource === "import") await renderImportSkills(list);
  panel.append(list);
}

async function doSkillScout() {
  if (!state.project || !skillsScoutQuery.trim()) return;
  try { skillsScoutResults = await atom.skills.scout(state.project, skillsScoutQuery); renderSkills(); }
  catch (e) { toast(String((e && e.message) || e), "alert"); }
}

function renderScoutResults(res) {
  const wrap = h("div", { class: "skills-list" });
  const { hub: hubHits, crossProject: xpHits, generated } = res;
  if (hubHits && hubHits.length) {
    wrap.append(h("div", { class: "skills-section" }, h("span", { html: icon("globe", 12) }), h("span", { text: `From Skill Hub (${hubHits.length})` })));
    for (const s of hubHits) wrap.append(hubSkillCard(s));
  }
  if (xpHits && xpHits.length) {
    wrap.append(h("div", { class: "skills-section" }, h("span", { html: icon("folder", 12) }), h("span", { text: `From other projects (${xpHits.length})` })));
    for (const s of xpHits) wrap.append(xpSkillCard(s));
  }
  if ((!hubHits || !hubHits.length) && (!xpHits || !xpHits.length))
    wrap.append(h("div", { class: "dock-empty", text: "No matching skills found." }));
  if (generated) {
    wrap.append(h("div", { class: "scout-gen" },
      h("span", { class: "scout-gen-text", text: "Not what you need?" }),
      h("button", { class: "scout-gen-btn", onclick: () => {
        skillsFormOpen = true; skillsFormDefaults = generated; skillsScoutResults = null; skillsSource = "my"; renderSkills();
      } }, h("span", { html: icon("sparkle", 13) }), h("span", { text: "Generate custom skill" }))));
  }
  return wrap;
}

// ---- My Skills view ----
async function renderMySkills(list) {
  if (skillsFormOpen) list.append(skillForm(skillsFormDefaults));
  const all = await atom.skills.list(state.project).catch(() => []);
  const active = all.filter((s) => s.status === "active");
  const suggested = all.filter((s) => s.status === "suggested");
  if (suggested.length) {
    list.append(h("div", { class: "skills-section" }, h("span", { html: icon("sparkle", 12) }), h("span", { text: "Learned by the apprentice" })));
    for (const s of suggested) list.append(skillRow(s, true));
  }
  list.append(h("div", { class: "skills-section" }, h("span", { text: "Your skills (" + active.length + ")" })));
  if (!active.length && !suggested.length) list.append(h("div", { class: "dock-empty", text: "No skills yet — create one, browse the Hub, or let the apprentice learn." }));
  for (const s of active) list.append(skillRow(s, false));
}

// ---- Skill Hub view ----
async function renderHubSkills(list) {
  const catBar = h("div", { class: "hub-cat-bar" });
  for (const c of ["All", "Backend", "Frontend", "Testing", "DevOps", "Workflow"]) {
    catBar.append(h("button", { class: "hub-cat" + (skillsHubCategory === c ? " active" : ""), text: c,
      onclick: () => { skillsHubCategory = c; renderSkills(); } }));
  }
  list.append(catBar);
  const skills = await atom.skills.hub(skillsHubCategory).catch(() => []);
  if (!skills.length) { list.append(h("div", { class: "dock-empty", text: "No skills in this category." })); return; }
  for (const s of skills) list.append(hubSkillCard(s));
}

function hubSkillCard(s) {
  return h("div", { class: "skill-row hub" },
    h("div", { class: "skill-row-top" },
      h("span", { class: "skill-name", text: s.name }),
      s.category ? h("span", { class: "skill-tag cat", text: s.category }) : null,
      s.popular ? h("span", { class: "skill-tag popular", text: "Popular" }) : null,
      h("div", { class: "spacer" }),
      h("button", { class: "skill-act accept", title: "Install to my skills", html: icon("download", 13), onclick: async () => {
        await atom.skills.importSkill(state.project, s).catch((e) => toast(String((e && e.message) || e), "alert"));
        toast(`Installed "${s.name}"`, "sparkle"); renderSkills();
      } })),
    s.description ? h("div", { class: "skill-desc", text: s.description }) : null,
    (s.tags || []).length ? h("div", { class: "skill-tags" }, ...s.tags.slice(0, 5).map((t) => h("span", { class: "skill-chip", text: t }))) : null);
}

// ---- Import view (cross-project + URL) ----
async function renderImportSkills(list) {
  const urlIn = h("input", { class: "skf-in", placeholder: "Paste skill URL (JSON, SKILL.md, or GitHub link)…" });
  list.append(h("div", { class: "import-url-bar" }, urlIn,
    h("button", { class: "scout-btn", onclick: async () => {
      if (!urlIn.value.trim()) return;
      try {
        const res = await atom.skills.importUrl(state.project, urlIn.value.trim());
        toast(`Imported ${Array.isArray(res) ? res.length : 1} skill(s)`, "sparkle"); urlIn.value = ""; renderSkills();
      } catch (e) { toast(String((e && e.message) || e), "alert"); }
    } }, h("span", { html: icon("download", 13) }), h("span", { text: "Fetch" }))));

  list.append(h("div", { class: "skills-section" }, h("span", { html: icon("folder", 12) }), h("span", { text: "From your other projects" })));
  const xp = await atom.skills.crossProject(state.project).catch(() => []);
  if (!xp.length) { list.append(h("div", { class: "dock-empty", text: "No skills found in other projects yet." })); return; }
  for (const group of xp) {
    list.append(h("div", { class: "import-proj-head" },
      h("span", { html: icon("folder", 12) }), h("span", { text: group.project }),
      h("span", { class: "ch-count", text: String(group.skills.length) })));
    for (const s of group.skills) list.append(xpSkillCard(s));
  }
}

function xpSkillCard(s) {
  return h("div", { class: "skill-row xp" },
    h("div", { class: "skill-row-top" },
      h("span", { class: "skill-name", text: s.name }),
      s.project ? h("span", { class: "skill-tag xp-tag", text: s.project }) : null,
      s.source === "learned" ? h("span", { class: "skill-tag learned", text: "learned" }) : null,
      h("div", { class: "spacer" }),
      h("button", { class: "skill-act accept", title: "Import to my project", html: icon("download", 13), onclick: async () => {
        await atom.skills.importSkill(state.project, s).catch((e) => toast(String((e && e.message) || e), "alert"));
        toast(`Imported "${s.name}"`, "sparkle"); renderSkills();
      } })),
    s.description ? h("div", { class: "skill-desc", text: s.description }) : null);
}

// ---- Shared skill helpers ----
function skillForm(defaults) {
  const d = defaults || {};
  const name = h("input", { class: "skf-in", placeholder: "Skill name (e.g. Add IPC handler)", value: d.name || "" });
  const desc = h("input", { class: "skf-in", placeholder: "One-line description", value: d.description || "" });
  const steps = h("textarea", { class: "skf-ta", rows: "6", spellcheck: "false",
    placeholder: "The procedure — the steps the agent should follow when this skill is invoked.", value: d.steps || "" });
  const trig = h("input", { class: "skf-in", placeholder: "Trigger words, comma-separated (optional)", value: (d.triggers || []).join(", ") });
  return h("div", { class: "skill-form" }, name, desc, steps, trig,
    h("div", { class: "skf-row" },
      h("div", { class: "spacer" }),
      h("button", { class: "skf-cancel", text: "Cancel", onclick: () => { skillsFormOpen = false; skillsFormDefaults = null; renderSkills(); } }),
      h("button", { class: "skf-save", text: "Create skill", onclick: async () => {
        if (!name.value.trim()) { toast("Name the skill first", "alert"); return; }
        await atom.skills.create(state.project, {
          name: name.value, description: desc.value, steps: steps.value,
          triggers: trig.value.split(",").map((s) => s.trim()).filter(Boolean),
        }).catch((e) => toast(String((e && e.message) || e), "alert"));
        skillsFormOpen = false; skillsFormDefaults = null; renderSkills();
      } })));
}

function skillRow(s, isSuggested) {
  const acts = [];
  if (isSuggested) {
    acts.push(h("button", { class: "skill-act accept", title: "Add to your skills", html: icon("check", 13), onclick: async () => { await atom.skills.promote(state.project, s.id).catch(() => {}); renderSkills(); } }));
    acts.push(h("button", { class: "skill-act", title: "Dismiss", html: icon("close", 13), onclick: async () => { await atom.skills.remove(state.project, s.id).catch(() => {}); renderSkills(); } }));
  } else {
    acts.push(h("button", { class: "skill-act", title: "Use now (insert into the prompt)", html: icon("arrowUp", 13), onclick: () => useSkill(s) }));
    acts.push(h("button", { class: "skill-act", title: "Export as JSON", html: icon("upload", 13), onclick: async () => {
      const data = await atom.skills.exportSkill(state.project, s.id).catch(() => null);
      if (data) { await atom.clipboard.write(JSON.stringify(data, null, 2)); toast("Skill JSON copied to clipboard", "copy"); }
    } }));
    acts.push(h("button", { class: "skill-act", title: "Delete", html: icon("trash", 13), onclick: () => confirmDialog({ title: "Delete skill", message: `Delete the skill "${s.name}"?`, confirmLabel: "Delete", danger: true, onConfirm: async () => { await atom.skills.remove(state.project, s.id).catch(() => {}); renderSkills(); } }) }));
  }
  return h("div", { class: "skill-row" + (isSuggested ? " suggested" : "") },
    h("div", { class: "skill-row-top" },
      h("span", { class: "skill-name", text: s.name }),
      s.source === "learned" ? h("span", { class: "skill-tag learned", text: "learned" }) :
        s.source === "imported" ? h("span", { class: "skill-tag imported", text: "imported" }) : null,
      h("div", { class: "spacer" }),
      s.uses ? h("span", { class: "skill-uses", title: s.uses + " uses", text: "×" + s.uses }) : null),
    s.description ? h("div", { class: "skill-desc", text: s.description }) : null,
    (s.files || []).length ? h("div", { class: "skill-files", text: s.files.slice(0, 4).map(baseName).join(" · ") }) : null,
    h("div", { class: "skill-row-acts" }, ...acts));
}

function useSkill(s) {
  const ta = $("promptInput");
  if (!ta) return;
  const tok = "/" + s.slug + " ";
  ta.value = tok + ta.value.replace(new RegExp("^/" + s.slug + "\\s*"), "");
  ta.focus();
  try { ta.dispatchEvent(new Event("input")); } catch { /* ignore */ }
  showDock(null);
  toast(`Skill "${s.name}" ready — finish the prompt and send`, "sparkle");
}

/* ============================================================
   TESTS PANEL — per-project test catalog (Test Director)
   ============================================================ */
let testsFilter = "all";
const TEST_CATS = ["all", "smoke", "regression", "e2e", "unit", "integration", "visual"];

async function renderTests() {
  const panel = $("testsPanel");
  if (!panel || panel.classList.contains("hidden")) return;
  let peek = null, tests = [], goals = [];
  if (state.project) {
    peek = await atom.testdir.peek(state.project).catch(() => null);
    tests = await atom.testdir.list(state.project, testsFilter === "all" ? {} : { category: testsFilter }).catch(() => []);
    goals = await atom.testdir.goals(state.project).catch(() => []);
  }
  panel.innerHTML = "";
  const pk = peek || { total: 0, pass: 0, fail: 0, quarantined: 0 };
  panel.append(dockHead("checkCircle", "Tests", `${pk.pass}/${pk.total} green`, toggleTests, [
    h("button", { class: "dock-mini", title: "Run smoke tests", html: icon("send", 14), onclick: () => runTestsCategory("smoke") }),
    h("button", { class: "dock-mini", title: "Run all (regression)", html: icon("refresh", 14), onclick: () => runTestsCategory(null) }),
  ]));
  if (!state.project) { panel.append(h("div", { class: "dock-empty", text: "Open a project to manage tests." })); return; }

  // Goal → Green composer + active goals
  const gi = h("textarea", { class: "goal-input", id: "goalInput", rows: "2", spellcheck: "false", placeholder: "Goal → Green — describe what to build; the agent writes tests and drives to green." });
  panel.append(h("div", { class: "goal-compose" }, gi,
    h("div", { class: "goal-compose-row" }, h("span", { class: "goal-hint", text: "agent authors tests → builds → auto-fixes → gates" }), h("div", { class: "spacer" }),
      h("button", { class: "goal-plan", onclick: () => planGoal() }, h("span", { html: icon("sparkle", 13) }), h("span", { text: "Plan" })))));
  if (goals.length) { const gl = h("div", { class: "goal-list" }); for (const g of goals.slice(0, 6)) gl.append(goalRow(g)); panel.append(gl); }

  panel.append(h("div", { class: "tests-filter" }, ...TEST_CATS.map((c) =>
    h("button", { class: "tcat" + (testsFilter === c ? " active" : ""), onclick: () => { testsFilter = c; renderTests(); }, text: c }))));

  const list = h("div", { class: "tests-list" });
  if (!tests.length) list.append(h("div", { class: "dock-empty", text: "No tests yet. Give the agent a goal — it authors tests here and runs them in the embedded browser." }));
  for (const t of tests) list.append(testRow(t));
  panel.append(list);
}

function testRow(t) {
  const run = h("button", { class: "test-act", title: "Run this test", html: icon("send", 13), onclick: async () => {
    const r = await atom.testdir.run(state.project, t.id).catch(() => null);
    toast(`${t.title}: ${r ? r.status : "error"}`, r && r.status === "pass" ? "check" : "alert");
    renderTests();
  } });
  const del = h("button", { class: "test-act", title: "Delete", html: icon("trash", 13), onclick: () => confirmDialog({ title: "Delete test", message: `Delete “${t.title}”?`, confirmLabel: "Delete", danger: true, onConfirm: async () => { await atom.testdir.remove(state.project, t.id).catch(() => {}); renderTests(); } }) });
  return h("div", { class: "test-row" },
    h("div", { class: "test-row-top" },
      h("span", { class: "test-badge tb-" + (t.status || "unknown"), text: t.status || "unknown" }),
      h("span", { class: "test-name", text: t.title, title: t.title }),
      t.locked ? h("span", { class: "test-lock", title: "Locked to an approved spec — append-only", html: icon("shield", 11) }) : null,
      h("div", { class: "spacer" })),
    h("div", { class: "test-meta" },
      h("span", { class: "test-cat", text: t.category }),
      h("span", { class: "test-adp", title: t.adapter === "browser" ? "runs in the embedded browser" : "runs as a node process", text: t.adapter }),
      t.flaky ? h("span", { class: "test-flaky", text: "flaky" }) : null),
    (t.coveredFiles || []).length ? h("div", { class: "test-files", text: t.coveredFiles.slice(0, 3).map(baseName).join(" · ") }) : null,
    h("div", { class: "test-row-acts" }, run, del));
}

async function runTestsCategory(cat) {
  if (!state.project) return;
  toast(cat ? `Running ${cat} tests…` : "Running all tests…", "refresh");
  const r = await atom.testdir.runSelection(state.project, cat ? { category: cat } : {}).catch(() => null);
  if (r) toast(`${r.pass}/${r.total} passed`, r.fail === 0 ? "check" : "alert");
  renderTests();
}

const GOAL_BADGE = { draft: "Draft", approved: "Approved", authoring: "Authoring", building: "Building", red: "Red", fixing: "Fixing", gating: "Gating", complete: "Complete", blocked: "Blocked", "no-tests": "No tests" };
function goalRow(g) {
  const acts = [];
  if (g.status === "draft" && (g.spec || []).length) acts.push(h("button", { class: "goal-act run", onclick: () => approveAndRun(g.id) }, h("span", { html: icon("check", 12) }), h("span", { text: "Approve & Run" })));
  else if (g.status === "blocked") acts.push(h("button", { class: "goal-act", onclick: () => approveAndRun(g.id, true) }, h("span", { html: icon("refresh", 12) }), h("span", { text: "Retry" })));
  return h("div", { class: "goal-row" },
    h("div", { class: "goal-row-top" },
      h("span", { class: "goal-badge gb-" + g.status, text: GOAL_BADGE[g.status] || g.status }),
      h("span", { class: "goal-name", text: g.prompt, title: g.prompt }), h("div", { class: "spacer" })),
    (g.spec || []).length ? h("div", { class: "goal-spec" }, ...g.spec.slice(0, 5).map((b) => h("div", { class: "goal-bullet" }, h("span", { class: "gbid", text: b.id }), h("span", { class: "gbtext", text: b.text })))) : null,
    acts.length ? h("div", { class: "goal-row-acts" }, ...acts) : null);
}
async function planGoal() {
  const ta = $("goalInput");
  if (!ta || !state.project) return;
  const prompt = ta.value.trim();
  if (!prompt) return;
  ta.value = "";
  // Seed a one-bullet spec from the goal; a live spec-author agent refines this later.
  await atom.director.plan(state.project, prompt, { spec: [{ text: prompt }] }).catch((e) => toast(String((e && e.message) || e), "alert"));
  renderTests();
}
async function approveAndRun(id, retry) {
  if (!state.project) return;
  if (!retry) await atom.director.approve(state.project, id).catch(() => {});
  renderTests();
  toast("Running goal to green…", "refresh");
  const r = await atom.director.run(state.project, id).catch((e) => ({ status: "error", reason: String((e && e.message) || e) }));
  toast(`Goal ${r.status}${r.reason ? " — " + r.reason : ""}`, r.status === "complete" ? "check" : "alert");
  renderTests();
}

/* ============================================================
   EVENTS FROM MAIN
   ============================================================ */
function wireEvents() {
  atom.events.onFleet((snap) => { fleetSnap = snap || fleetSnap; if (currentDock() === "fleet") renderFleet(); });
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
    const following = forced ? true : (active ? nearBottom() : true);
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
      if (following) { trimRenderedTop(); scrollBottom(forced); }  // only trim/scroll when at the tail
      renderLive();
    }
  });

  atom.events.onMessageUpdate(({ sessionId, messageId, patch }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    const m = ts.messages.find((x) => x.id === messageId);
    if (m) {
      Object.assign(m, patch);
      if (sessionId === state.activeTabId) {
        const node = document.querySelector(`#chatMessages [data-mid="${messageId}"]`);
        // Patch the existing card IN PLACE: its DOM node (and with it the user's
        // expanded state, scroll position and text selection) survives every
        // status / output update. Only when in-place patching isn't possible does
        // the node get rebuilt — and then the open state is carried over.
        if (node) {
          if (m.role === "tool" && patchToolCard(node, m, ts)) { /* patched in place */ }
          else {
            const wasOpen = !!node.querySelector(".tool-card.open, .thinking-card.open");
            const fresh = renderMessage(m, ts);
            if (wasOpen) { const c = fresh.querySelector(".tool-card, .thinking-card"); if (c) c.classList.add("open"); }
            node.replaceWith(fresh);
          }
        }
      }
      return;
    }
    // Out-of-window patch: queue it so the next time the user scrolls older
    // messages back into view, we apply the latest patch rather than rendering
    // a stale "running" tool card. (Main has already persisted the change.)
    if (!ts._pendingPatches) ts._pendingPatches = new Map();
    const prev = ts._pendingPatches.get(messageId) || {};
    ts._pendingPatches.set(messageId, Object.assign(prev, patch));
  });

  atom.events.onStatus(({ sessionId, status, provider, model, effort, resumeAt, attempt }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
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
    if (status !== "running") { ts.streaming.clear(); ts.stopping = false; }
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

  atom.events.onPermission(({ sessionId, requestId, toolName, input }) => {
    const ts = state.tabs.get(sessionId);
    if (!ts) return;
    // Auto-allow tools the user already approved "for this session".
    if (ts.autoAllow && ts.autoAllow.has(toolName) && toolName !== "ExitPlanMode" && toolName !== "AskUserQuestion") {
      atom.sessions.permissionResponse(requestId, { allow: true, message: "" });
      return;
    }
    ts.pendingPerms.push({ requestId, toolName, input, shownAt: Date.now() });   // waits for the user — no deadline
    renderTabs();
    if (sessionId === state.activeTabId) { renderPerms(); renderLive(); }
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
async function resumeAuthExpired(provider) {
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
async function openAccountSwitcher(anchor) {
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
let _rateTicker = null;
function startRateTicker() {
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
function initTooltips() {
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
async function openChatFileLink(rawPath, line) {
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
function wireChatDelegation() {
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

/* ============================================================
   HISTORY MODAL
   ============================================================ */
async function openHistory() {
  let list = await atom.sessions.list();
  const currentProject = state.project || (activeTS() && activeTS().meta.cwd) || state.settings.lastFolder;
  let scope = "current"; // default: only this project's sessions
  const selected = new Set();

  const body = h("div", {});
  const scopeSeg = segmented(["current", "all"], scope, (v) => { scope = v; draw(); }, { current: `This project — ${baseName(currentProject)}`, all: "All projects" });
  const search = h("input", { class: "input", placeholder: "Search sessions by name or folder…" });
  const selAll = h("label", { class: "hist-selall" }, h("input", { type: "checkbox", onchange: (e) => toggleAll(e.target.checked) }), h("span", { text: "Select all" }));
  const listHost = h("div", { style: "margin-top:10px; display:flex; flex-direction:column; gap:6px; max-height:48vh; overflow:auto;" });
  body.append(scopeSeg, h("div", { class: "field", style: "margin:10px 0 0" }, search), h("div", { class: "hist-bar" }, selAll), listHost);

  let exportBtn;
  function filtered() {
    const f = search.value.trim().toLowerCase();
    let rows = list.slice();
    if (scope === "current" && currentProject) rows = rows.filter((s) => samePath(s.cwd, currentProject));
    if (f) rows = rows.filter((s) => s.name.toLowerCase().includes(f) || (s.cwd || "").toLowerCase().includes(f));
    return rows;
  }
  function toggleAll(on) {
    const rows = filtered();
    if (on) rows.forEach((s) => selected.add(s.id)); else rows.forEach((s) => selected.delete(s.id));
    draw();
  }
  function updateExportBtn() {
    if (!exportBtn) return;
    exportBtn.disabled = selected.size === 0;
    exportBtn.querySelector(".lbl").textContent = selected.size ? `Export selected (${selected.size})` : "Export selected";
  }

  function draw() {
    listHost.innerHTML = "";
    const rows = filtered();
    if (!rows.length) { listHost.append(h("div", { class: "changes-empty", text: scope === "current" ? "No sessions for this project yet." : "No sessions found." })); updateExportBtn(); return; }
    for (const s of rows) {
      const isOpen = state.tabs.has(s.id);
      const meta = scope === "all"
        ? `${baseName(s.cwd)} · ${s.messageCount} msgs · ${timeAgo(s.updatedAt)}`
        : `${s.messageCount} msgs · ${timeAgo(s.updatedAt)}`;
      const check = h("input", { type: "checkbox", class: "hist-check", onclick: (ev) => { ev.stopPropagation(); if (ev.target.checked) selected.add(s.id); else selected.delete(s.id); updateExportBtn(); } });
      check.checked = selected.has(s.id);
      listHost.append(h("div", { class: "change-row", style: "border:1px solid var(--line-soft)" },
        check,
        h("div", { class: "change-ico", html: icon("history", 15) }),
        h("div", { class: "change-meta" }, h("div", { class: "change-name", text: s.name }), h("div", { class: "change-path", text: meta })),
        h("button", { class: "btn btn-ghost btn-sm", html: icon("download", 13), title: "Export this conversation", onclick: () => doExport([s.id]) }),
        h("button", { class: "btn btn-ghost btn-sm", text: isOpen ? "Switch" : "Open", onclick: () => { closeModal(back); openSessionTab(s.id); } }),
        h("button", { class: "btn btn-ghost btn-sm", html: icon("pencil", 13), title: "Rename", onclick: () => renameSession(s.id, (name) => { s.name = name; draw(); }, s.name) }),
        h("button", { class: "btn btn-danger btn-sm", html: icon("trash", 13), title: "Delete", onclick: () => deleteSession(s.id, () => { selected.delete(s.id); list = list.filter((x) => x.id !== s.id); draw(); }) })));
    }
    updateExportBtn();
  }

  async function doExport(ids) {
    // Show a small inline picker for full vs compact before exporting.
    const pick = await new Promise((res) => {
      const bg = h("div", { class: "modal-bg", style: "z-index:9999", onclick: (ev) => { if (ev.target === bg) { bg.remove(); res(null); } } });
      const box = h("div", { class: "modal", style: "max-width:340px" },
        h("div", { class: "modal-title", text: "Export mode" }),
        h("div", { class: "modal-body", style: "display:flex;flex-direction:column;gap:8px;padding:12px 16px" },
          h("button", { class: "btn btn-primary", text: "Full (all messages)", onclick: () => { bg.remove(); res("full"); } }),
          h("button", { class: "btn btn-secondary", text: "Compact (digest + recent)", onclick: () => { bg.remove(); res("compact"); } }),
          h("div", { class: "text-secondary", style: "font-size:11px;margin-top:4px", text: "Full: re-importable, includes every message and tool call. Compact: lightweight summary with goals, outcomes, recent exchanges." })),
        h("div", { class: "modal-actions" }, h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => { bg.remove(); res(null); } })));
      bg.append(box); document.body.append(bg);
    });
    if (!pick) return;
    try { const r = await atom.sessions.export(ids, pick); if (r && r.path) toast(`Exported ${r.count} conversation${r.count > 1 ? "s" : ""} (${r.mode || pick})`, "download"); }
    catch (e) { toast("Export failed: " + e.message, "alert"); }
  }
  async function doImport() {
    try {
      const r = await atom.sessions.import();
      if (!r || r.canceled) return;
      toast(`Imported ${r.count} conversation${r.count > 1 ? "s" : ""}`, "upload");
      list = await atom.sessions.list();
      draw();
    } catch (e) { toast("Import failed: " + e.message, "alert"); }
  }

  search.addEventListener("input", draw);
  draw();

  exportBtn = h("button", { class: "btn btn-ghost", disabled: true, onclick: () => doExport([...selected]) }, h("span", { html: icon("download", 14) }), h("span", { class: "lbl", text: "Export selected" }));
  const back = modalShell({
    title: "Session history", ic: "history", wide: true, body,
    footer: [
      h("button", { class: "btn btn-ghost", html: `${icon("upload", 14)} Import…`, onclick: doImport }),
      exportBtn,
      h("button", { class: "btn btn-ghost", text: "History folder", onclick: () => atom.sessions.openHistory() }),
      h("button", { class: "btn btn-primary", text: "Done", onclick: () => closeModal(back) }),
    ],
  });
  updateExportBtn();
}

async function openSessionTab(id) {
  if (state.tabs.has(id)) { await switchTab(id); return; }
  const full = await atom.sessions.get(id);
  if (!full) return;
  addTabState(full);
  state.order.push(id);
  await switchTab(id);
}

/* ============================================================
   SETTINGS MODAL
   ============================================================ */
/* ============================================================
   DBM — DATABASE MANAGER
   ============================================================ */
// The Database Manager lives in dbm.js (virtualised object list + result grids,
// Browse / Structure / Query modes). This wrapper hands it the app helpers it
// borrows so the module stays decoupled from app.js.
async function openDbManagerFull(mountEl) {
  return mountDbManager(mountEl, { h, icon, toast, atom, showContextMenu, chooseDialog, promptDialog, modalShell, closeModal });
}




async function openSettings() {
  const s = state.settings;
  const auth = await atom.auth.status().catch(() => ({ loggedIn: false, cliFound: false }));
  const info = await atom.app.info().catch(() => ({ version: "?" }));

  const body = h("div", {});

  // (Claude authorization + the per-provider Authorize/API key flows now live in
  // the Providers section, each opened in a focused modal — see openProviderModal.)

  // Theme
  const THEMES = [
    { id: "amber", name: "Amber", bg: "#222020", ac: "#f0a94e" },
    { id: "ember", name: "Ember", bg: "#222020", ac: "#ef7d4c" },
    { id: "gold", name: "Gold", bg: "#222020", ac: "#e8c25a" },
    { id: "rose", name: "Rose", bg: "#222020", ac: "#e88a72" },
    { id: "gunmetal", name: "Gunmetal", bg: "#1b1f24", ac: "#6fb3d6" },
    { id: "gray", name: "Gray", bg: "#1f1f1f", ac: "#9fb4c4" },
    { id: "blue", name: "Blue", bg: "#0f1623", ac: "#5b9bf0" },
    { id: "light", name: "Light", bg: "#faf8f5", ac: "#cf8a2e" },
  ];
  let curTheme = s.theme || s.accent || "amber";
  const themeRow = h("div", { class: "theme-row" });
  function drawThemes() {
    themeRow.innerHTML = "";
    for (const t of THEMES) themeRow.append(h("button", {
      class: "theme-swatch" + (t.id === curTheme ? " sel" : ""), title: t.name,
      onclick: () => { curTheme = t.id; s.theme = t.id; applyTheme(t.id); atom.settings.set({ theme: t.id }); drawThemes(); },
    },
      h("span", { class: "ts-prev", style: `background:${t.bg}` }, h("span", { class: "ts-dot", style: `background:${t.ac}` })),
      h("span", { class: "ts-name", text: t.name })));
  }
  drawThemes();

  // Taskbar / Dock tile (saved per project): live preview · custom letters (≤ 4) · text size · colour
  const isMac = state.platform === "darwin", dockWord = isMac ? "Dock" : "taskbar";
  const projName = () => baseName(state.project) || "AtomNano";
  const tilePreview = h("div", { class: "tile-preview", title: `How this window shows on the ${dockWord}` });
  const tileSizeUp = h("button", { class: "btn btn-ghost btn-sm", text: "+", title: "Larger text", "aria-label": "Larger tile text" });
  const tileSizeNote = h("span", { class: "hint tile-ctl-hint" });
  const drawTile = () => {
    tilePreview.innerHTML = "";
    const rec = projectTagRec();
    const c = renderTagTile({ text: tagLetters(rec.tagText, projName()), color: projectColor(), size: rec.tagSize });
    c.className = "tile-canvas"; tilePreview.append(c);
    const capped = c.dataset.capped === "1";           // the letters already fill the tile: "+" would change nothing
    tileSizeUp.disabled = capped;
    tileSizeNote.textContent = capped ? "Fills the tile — fewer letters can go bigger" : "";
  };
  const applyTile = () => { applyWindowTitle(); drawTile(); };
  const tileText = h("input", { class: "input tile-text", maxlength: String(TAG_TEXT_MAX), placeholder: tagLetters("", projName()), value: projectTagRec().tagText || "", spellcheck: "false", autocomplete: "off", "aria-label": `Taskbar tile text (up to ${TAG_TEXT_MAX} letters)` });
  tileText.oninput = () => { const v = tileText.value.replace(/[^a-z0-9]/gi, "").slice(0, TAG_TEXT_MAX).toUpperCase(); if (v !== tileText.value) tileText.value = v; saveProjectTag({ tagText: v }); applyTile(); };
  const tileSizeVal = h("span", { class: "step-val", text: tagSizePct(projectTagRec().tagSize) + "%" });
  const setTileSize = (n) => { const v = tagSizePct(n); saveProjectTag({ tagSize: v }); tileSizeVal.textContent = v + "%"; applyTile(); };
  tileSizeUp.onclick = () => setTileSize(tagSizePct(projectTagRec().tagSize) + TAG_SIZE_STEP);
  const tileSizeRow = h("div", { class: "stepper" },
    h("button", { class: "btn btn-ghost btn-sm", text: "−", title: "Smaller text", "aria-label": "Smaller tile text", onclick: () => setTileSize(tagSizePct(projectTagRec().tagSize) - TAG_SIZE_STEP) }),
    tileSizeVal,
    tileSizeUp,
    h("button", { class: "btn btn-ghost btn-sm", text: "Reset", onclick: () => setTileSize(100) }));
  const tileBox = h("div", { class: "tile-box" }, tilePreview,
    h("div", { class: "tile-controls" },
      h("div", { class: "tile-ctl" }, h("span", { class: "tile-ctl-label", text: "Text" }), tileText, h("span", { class: "hint tile-ctl-hint", text: `Up to ${TAG_TEXT_MAX} letters · blank = project name` })),
      h("div", { class: "tile-ctl" }, h("span", { class: "tile-ctl-label", text: "Size" }), tileSizeRow, tileSizeNote)));
  drawTile();
  // colour: the curated swatches plus a free colour picker (the last swatch)
  const colorRow = h("div", { class: "theme-row tag-colors" });
  const customPick = h("input", { type: "color", class: "tag-custom-input", "aria-label": "Custom tile colour" });
  function drawColors() {
    colorRow.innerHTML = "";
    const cur = (projectColor() || "").toLowerCase();
    for (const col of TAG_COLORS) {
      colorRow.append(h("button", {
        class: "tag-swatch" + (col.toLowerCase() === cur ? " sel" : ""), title: col, "aria-label": `Tile colour ${col}`, style: `background:${col}`,
        onclick: () => { saveProjectColor(col); applyTile(); drawColors(); toast("Tile color saved for this project"); },
      }));
    }
    const isCustom = /^#[0-9a-f]{6}$/i.test(cur) && !TAG_COLORS.some((c) => c.toLowerCase() === cur);
    customPick.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : "#3a4d5c";
    colorRow.append(h("label", { class: "tag-swatch tag-custom" + (isCustom ? " sel" : ""), title: isCustom ? `Custom colour ${cur} — click to change` : "Pick any colour", style: isCustom ? `background:${cur}` : "" },
      h("span", { class: "tag-custom-ic", text: "+" }), customPick));
  }
  customPick.oninput = () => { saveProjectColor(customPick.value); applyTile(); };   // live while dragging in the picker
  customPick.onchange = () => { drawColors(); toast("Tile color saved for this project"); };
  drawColors();

  // Font size segmented (coerce any legacy numeric value to a named size)
  const curSize = ["small", "medium", "large"].includes(s.fontSize) ? s.fontSize : "medium";
  const fontSeg = segmented(["small", "medium", "large"], curSize, (v) => { s.fontSize = v; applyFontSize(v); atom.settings.set({ fontSize: v }); }, { small: "Small", medium: "Medium", large: "Large" });

  // Resend button on my messages (Agent)
  const resendSeg = segmented(["off", "on"], s.resendButton !== false ? "on" : "off",
    (v) => { s.resendButton = v === "on"; atom.settings.set({ resendButton: s.resendButton }); renderChat(); },
    { off: "Off", on: "On" });

  // Prevent the computer/display from sleeping during long agent jobs
  const sleepSeg = segmented(["off", "on"], s.preventSleep ? "on" : "off",
    (v) => { s.preventSleep = v === "on"; atom.settings.set({ preventSleep: s.preventSleep }); },
    { off: "Off", on: "On" });
  // (Caveman brevity, smart thinking gate, frugal context, code-output thrift, read
  //  memoizer, auto skill creator and command-parallelism env tuning were removed:
  //  AtomNano adds no behavioural instructions or hidden tuning to a run.)
  // Editor font family
  const curEdFont = EDITOR_FONTS.find((f) => f.id === s.editorFontFamily) ? s.editorFontFamily : "default";
  const edFontSel = inlineSelect(EDITOR_FONTS.map((f) => ({ id: f.id, name: f.name })), curEdFont,
    (v) => { s.editorFontFamily = v; applyEditorFontFamily(v); atom.settings.set({ editorFontFamily: v }); });

  // Editor font size (stepper)
  const edSizeVal = h("span", { class: "step-val", text: (s.editorFontSize || 13) + "px" });
  const setEdSize = (n) => {
    state.editor.fontSize = Math.max(9, Math.min(28, n));
    s.editorFontSize = state.editor.fontSize;
    applyEditorZoom();
    atom.settings.set({ editorFontSize: state.editor.fontSize });
    edSizeVal.textContent = state.editor.fontSize + "px";
  };
  const edSizeRow = h("div", { class: "stepper" },
    h("button", { class: "btn btn-ghost btn-sm", text: "−", title: "Smaller", onclick: () => setEdSize((s.editorFontSize || 13) - 1) }),
    edSizeVal,
    h("button", { class: "btn btn-ghost btn-sm", text: "+", title: "Larger", onclick: () => setEdSize((s.editorFontSize || 13) + 1) }),
    h("button", { class: "btn btn-ghost btn-sm", text: "Reset", onclick: () => setEdSize(13) }));

  // Editor analysis layers — each applied live to the open editor.
  const stickySeg = segmented(["off", "on"], s.editorStickyScroll ? "on" : "off",
    (v) => { s.editorStickyScroll = v === "on"; atom.settings.set({ editorStickyScroll: s.editorStickyScroll }); if (cm) cm.setSticky(s.editorStickyScroll); },
    { off: "Off", on: "On" });
  const highlightSeg = segmented(["off", "on"], s.editorHighlight === false ? "off" : "on",
    (v) => { s.editorHighlight = v === "on"; atom.settings.set({ editorHighlight: s.editorHighlight }); if (cm) cm.setHighlight(s.editorHighlight); },
    { off: "Off", on: "On" });
  const lintSeg = segmented(["off", "on"], s.editorLint === false ? "off" : "on",
    (v) => { s.editorLint = v === "on"; atom.settings.set({ editorLint: s.editorLint }); if (cm) cm.setLint(s.editorLint); },
    { off: "Off", on: "On" });
  const semanticSeg = segmented(["off", "on"], s.editorSemantic === false ? "off" : "on",
    (v) => { s.editorSemantic = v === "on"; atom.settings.set({ editorSemantic: s.editorSemantic }); if (cm) cm.setSemantic(s.editorSemantic); },
    { off: "Off", on: "On" });
  const fmtSaveSeg = segmented(["off", "on"], s.editorFormatOnSave ? "on" : "off",
    (v) => { s.editorFormatOnSave = v === "on"; atom.settings.set({ editorFormatOnSave: s.editorFormatOnSave }); },
    { off: "Off", on: "On" });
  const wrapSeg = segmented(["off", "on"], s.editorWordWrap ? "on" : "off",
    (v) => { s.editorWordWrap = v === "on"; atom.settings.set({ editorWordWrap: s.editorWordWrap }); if (cm) cm.setWrap(s.editorWordWrap); },
    { off: "Off", on: "On" });
  const bracketSeg = segmented(["off", "on"], s.editorBracketColors === false ? "off" : "on",
    (v) => { s.editorBracketColors = v === "on"; atom.settings.set({ editorBracketColors: s.editorBracketColors }); if (cm) cm.setBracketColors(s.editorBracketColors); },
    { off: "Off", on: "On" });
  const trimSeg = segmented(["off", "on"], s.editorTrimWhitespace ? "on" : "off",
    (v) => { s.editorTrimWhitespace = v === "on"; atom.settings.set({ editorTrimWhitespace: s.editorTrimWhitespace }); },
    { off: "Off", on: "On" });
  const finalNlSeg = segmented(["off", "on"], s.editorFinalNewline ? "on" : "off",
    (v) => { s.editorFinalNewline = v === "on"; atom.settings.set({ editorFinalNewline: s.editorFinalNewline }); },
    { off: "Off", on: "On" });
  const renderWsSeg = segmented(["off", "on"], s.editorRenderWhitespace ? "on" : "off",
    (v) => { s.editorRenderWhitespace = v === "on"; atom.settings.set({ editorRenderWhitespace: s.editorRenderWhitespace }); if (cm) cm.setWhitespace(s.editorRenderWhitespace); },
    { off: "Off", on: "On" });
  const autoSaveSeg = segmented(["off", "on"], s.editorAutoSave ? "on" : "off",
    (v) => { s.editorAutoSave = v === "on"; atom.settings.set({ editorAutoSave: s.editorAutoSave }); },
    { off: "Off", on: "On" });
  const inlaySeg = segmented(["off", "on"], s.editorInlayHints ? "on" : "off",
    (v) => { s.editorInlayHints = v === "on"; atom.settings.set({ editorInlayHints: s.editorInlayHints }); for (const e of editors) if (e) e.setInlayHints(s.editorInlayHints); },
    { off: "Off", on: "On" });
  const guidesSeg = segmented(["off", "on"], s.editorIndentGuides ? "on" : "off",
    (v) => { s.editorIndentGuides = v === "on"; atom.settings.set({ editorIndentGuides: s.editorIndentGuides }); for (const e of editors) if (e) e.setIndentGuides(s.editorIndentGuides); },
    { off: "Off", on: "On" });

  // Shared model / perm / thinking (apply to ALL sessions; mirror the composer)
  const defModel = inlineSelect(MODELS, s.defaultModel, (v) => { s.defaultModel = v; atom.settings.set({ defaultModel: v }); if (modelDD) modelDD._refresh(); updateOneMVisibility(); });
  const defPerm = inlineSelect(PERMS, s.defaultPermissionMode, (v) => { s.defaultPermissionMode = v; atom.settings.set({ defaultPermissionMode: v }); if (permDD) permDD._refresh(); });
  const defThink = inlineSelect(THINKING, s.defaultThinking, (v) => { s.defaultThinking = v; atom.settings.set({ defaultThinking: v }); if (thinkDD) thinkDD._refresh(); });

  // Custom models (so new models from a CLI update can be picked up)
  const cmInput = h("textarea", { class: "input", rows: "3", style: "font-family:var(--font-mono); font-size:12px; resize:vertical;" , placeholder: "one per line:  claude-opus-4-9 | Opus 4.9" });
  cmInput.value = (s.customModels || []).map((m) => m.id + (m.name ? " | " + m.name : "")).join("\n");
  cmInput.addEventListener("change", () => {
    const list = cmInput.value.split("\n").map((ln) => ln.trim()).filter(Boolean).map((ln) => { const [id, name] = ln.split("|").map((x) => x.trim()); return { id, name: name || id }; }).filter((m) => m.id);
    s.customModels = list; atom.settings.set({ customModels: list }); applyCustomModels(list); toast("Models updated");
  });

  // Updates — runs seamlessly in-app (no terminal), updates CLI + SDK, then
  // offers to restart.
  const updBox = h("div", { class: "field" });
  let updBusy = false;
  let updLog = [];
  async function runUpdateFlow() {
    if (updBusy) return;
    updBusy = true; updLog = ["Starting update…"]; renderUpdates();
    const off = atom.updates.onProgress(({ message }) => { updLog.push(message); renderUpdates(); });
    let res = null;
    try { res = await atom.updates.run(); }
    catch (e) { updLog.push("Update error: " + e.message); }
    await new Promise((r) => setTimeout(r, 80));   // let any trailing progress lines flush
    if (off) off();
    updBusy = false;
    await checkUpdatesAndChip({ fresh: true });   // refresh installed-vs-latest (bypass the npm cache)
    state.providerCatalog = await atom.providers.catalog().catch(() => state.providerCatalog);   // refresh capability catalog
    // Re-discover models + thinking levels + 1M flags — FORCE the live CLI alias
    // probe (fable/opus/sonnet/haiku) and toast any new models the update brought.
    await loadProviderModels(state.settings.llmProvider || "anthropic", { announce: true, force: true });
    renderUpdates();
    renderTools();
    if (res) {
      const fmt = (r) => (r && r.ok ? (r.detail || "updated") : ("failed" + (r && r.detail ? ` — ${r.detail}` : "")));
      const parts = [`Claude CLI: ${fmt(res.cli)}`, `Agent SDK: ${fmt(res.sdk)}`];
      if (res.ok && res.changed) {
        chooseDialog({
          title: "Update complete", ic: "check",
          message: `${parts.join(" · ")}. Restart AtomNano now to use the new version?`,
          choices: [{ label: "Restart now", value: "restart", primary: true }, { label: "Later", value: null }],
        }).then((c) => { if (c === "restart") atom.app.relaunch(); });
      } else if (res.ok) {
        toast(`Already up to date · ${parts.join(" · ")}`, "check");
      } else {
        toast(`Update didn't complete — ${parts.join(" · ")}`, "alert");
      }
    }
  }
  function renderUpdates() {
    updBox.innerHTML = "";
    updBox.append(h("label", { text: "Updates" }));
    const u = state.updates;
    const host = h("div", {});
    if (!u) host.append(h("div", { class: "hint", style: "margin:0", text: "Compare your installed Claude CLI and Agent SDK against the latest published versions." }));
    else {
      const mk = (name, info) => h("div", { class: "upd-row" },
        h("span", { class: "upd-name", text: name }),
        h("span", { class: "upd-ver", text: info.updateAvailable ? `${info.current || "?"}  →  ${info.latest}` : (info.current || "?") }),
        h("span", { class: "upd-badge " + (info.updateAvailable ? "new" : "ok"), text: info.updateAvailable ? "update available" : "up to date" }));
      host.append(mk("Claude CLI", u.cli || {}), mk("Agent SDK", u.sdk || {}));
    }
    const canUpdate = !!(u && u.updateAvailable);
    updBox.append(host,
      h("div", { style: "display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;" },
        h("button", { class: "btn btn-ghost btn-sm", disabled: updBusy, html: `${icon("refresh", 14)}<span>Check for updates</span>`, onclick: async () => { toast("Checking…", "refresh"); await checkUpdatesAndChip({ fresh: true }); renderUpdates(); renderTools(); } }),
        (canUpdate || updBusy) ? h("button", { class: "btn btn-primary btn-sm", disabled: updBusy, html: `${icon("arrowUp", 14)}<span>${updBusy ? "Updating…" : "Update now"}</span>`, onclick: () => runUpdateFlow() }) : null));
    if (updLog.length) {
      const logEl = h("div", { class: "upd-log" });
      for (const line of updLog) logEl.append(h("div", { class: "upd-log-line", text: line }));
      updBox.append(logEl);
    }
    updBox.append(h("div", { class: "hint", text: "Updates the Claude CLI (brings the newest models) and the Agent SDK in place — no terminal. You'll be asked to restart when it's done." }));
  }
  renderUpdates();

  // ---- Provider tools — update the CLI + SDK that power each provider, grouped
  // per provider. (Anthropic also has the one-click "Updates" box above.) ----
  const toolsBox = h("div", { class: "field" });
  const PROVIDER_TOOLS = [
    { provider: "anthropic", label: "Anthropic (Claude)", keys: ["claudeCli", "agentSdk"] },
    { provider: "openai", label: "OpenAI (Codex)", keys: ["codex", "codexSdk"] },
  ];
  let toolsGen = 0;   // stale-render guard for the async second pass
  async function renderTools() {
    const gen = ++toolsGen;
    toolsBox.innerHTML = "";
    toolsBox.append(h("label", { text: "Provider tools — update per provider" }));
    // Pass 1 — installed versions (offline, instant).
    const tv = await atom.updates.toolVersions().catch(() => null);
    if (gen !== toolsGen) return;
    if (!tv) { toolsBox.append(h("div", { class: "hint", style: "margin:0", text: "Couldn't detect the tools." })); return; }
    const verEls = {}, btnEls = {};
    for (const grp of PROVIDER_TOOLS) {
      if (!grp.keys.some((k) => tv[k])) continue;
      toolsBox.append(h("div", { style: "font-size:11px; font-weight:600; opacity:.65; margin:12px 0 4px; text-transform:uppercase; letter-spacing:.04em;", text: grp.label }));
      const list = h("div", { class: "tools-list" });
      for (const key of grp.keys) {
        const t = tv[key]; if (!t) continue;
        const verEl = h("span", { class: "tool-ver" + (t.present ? "" : " absent"), text: t.present ? ("v" + (t.version || "?")) : "not installed" });
        const btn = h("button", { class: "btn btn-ghost btn-sm", html: `${icon("arrowUp", 13)}<span>${t.present ? "Update" : "Install"}</span>`, onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; b.innerHTML = `${icon("spinner", 13)}<span>…</span>`;
          const r = await atom.updates.updateTool(key).catch((err) => ({ ok: false, detail: (err && err.message) || "failed" }));
          // Installed-on-disk vs ACTIVE: an update is only "active" once the runtime
          // that serves turns actually runs it — say which it is.
          const act = r.ok ? (r.restartRequired ? " · installed — restart AtomNano to activate" : (r.activation ? " · " + r.activation : "")) : "";
          toast(`${t.name} — ${r.detail || (r.ok ? "updated" : "update failed")}${act}`, r.ok ? (r.restartRequired ? "alert" : "check") : "alert", { ms: r.ok && (r.restartRequired || r.activation) ? 8000 : 4000 });
          if (r.ok) {
            // Refresh the capability catalog, then FORCE re-discovery of the ACTIVE
            // provider's models + reasoning-effort levels, so a model that shipped
            // with this update shows up right now (not after the first prompt).
            state.providerCatalog = await atom.providers.catalog().catch(() => state.providerCatalog);
            await loadProviderModels(state.settings.llmProvider || "anthropic", { announce: true, force: true });
            checkUpdatesAndChip({ fresh: true }).then(() => renderUpdates());
          }
          renderTools();
        } });
        verEls[key] = verEl; btnEls[key] = btn;
        list.append(h("div", { class: "tool-row" }, h("div", { class: "tool-meta" }, h("span", { class: "tool-name", text: t.name }), verEl), btn));
      }
      toolsBox.append(list);
    }
    toolsBox.append(h("div", { class: "hint", text: "Each provider's CLI + SDK update in place — no terminal. Updating re-discovers that provider's models and reasoning-effort levels." }));
    // Where the Codex model list comes from — the installed binary's own catalog
    // (so a Codex update = new models, automatically), or the built-in seed.
    const oc = state.providerCatalog && state.providerCatalog.openai;
    if (oc && Array.isArray(oc.models) && oc.models.length) {
      const src = oc.catalogSource === "live" || oc.catalogSource === "account" ? "the models your Codex login can use (from Codex)" : oc.catalogSource === "bundled" ? "the installed Codex binary's catalog (sign in to Codex for your account's list)" : "the built-in list";
      toolsBox.append(h("div", { class: "hint", style: "margin-top:4px", text: `Codex models (${oc.models.length}): ${oc.models.map((m) => m.name).join(", ")} — ${src}.` }));
    }
    // Pass 2 — latest published versions (network; memoised in main) → "v1 → v2".
    const latest = await atom.updates.toolLatest(tv).catch(() => null);
    if (gen !== toolsGen || !latest) return;
    for (const key of Object.keys(latest)) {
      const l = latest[key], t = tv[key], el = verEls[key];
      if (!l || !t || !el || !t.present) continue;
      if (l.updateAvailable) {
        el.textContent = `v${t.version}  →  ${l.latest}`;
        el.style.color = "var(--accent)";
        if (btnEls[key]) { btnEls[key].classList.remove("btn-ghost"); btnEls[key].classList.add("btn-primary"); }
      } else if (l.latest) {
        el.title = `latest ${l.latest} — up to date`;
      }
    }
  }
  renderTools();

  // ---- Providers & Authentication — one card per provider; click to manage
  // (Authorize / API key) in a focused modal. ----
  const PROV_DEFS = [
    { id: "anthropic", name: "Anthropic (Claude)", keyField: "apiKey", icon: "atom", tagline: "Default primary" },
    { id: "openai", name: "OpenAI (Codex / GPT)", keyField: "openaiApiKey", icon: "cpu", tagline: "Primary · Codex SDK" },
    { id: "custom", name: "Custom (any API)", keyField: "customApiKey", baseUrl: true, icon: "globe", tagline: "Your endpoint" },
  ];
  const providersBox = h("div", { class: "field" });
  async function renderProviders() {
    providersBox.innerHTML = "";
    providersBox.append(h("label", { text: "Providers & Authentication" }));
    const pst = await atom.providers.authStatus().catch(() => ({}));
    let anth = null; try { anth = await atom.auth.status(); } catch { /* */ }
    const primary = state.settings.llmProvider || "anthropic";
    const grid = h("div", { class: "prov-grid" });
    for (const p of PROV_DEFS) {
      const ps = pst[p.id] || {};
      const loggedIn = p.id === "anthropic" ? (anth && anth.loggedIn) || ps.loggedIn : ps.loggedIn;
      const authed = loggedIn || ps.key;
      const statusTxt = loggedIn ? "Authorized" : ps.key ? "API key" : "Not set";
      const isPrimary = p.id === primary;
      grid.append(h("button", { class: "prov-card" + (isPrimary ? " primary" : ""), onclick: () => openProviderModal(p, renderProviders) },
        h("span", { class: "pc-ic", html: icon(p.icon || "globe", 16) }),
        h("span", { class: "pc-main" },
          h("span", { class: "pc-name-row" }, h("span", { class: "pc-name", text: p.name }), isPrimary ? h("span", { class: "pc-primary", text: "Primary" }) : null),
          h("span", { class: "pc-sub", text: p.tagline })),
        h("span", { class: "prov-status " + (authed ? "on" : "off"), text: statusTxt }),
        h("span", { class: "pc-arrow", html: icon("chevronRight", 15) })));
    }
    providersBox.append(grid, h("div", { class: "hint", text: "Anthropic (Agent SDK), OpenAI (Codex SDK) and Custom can each run the primary turn. Click a provider to authorize or add an API key." }));
  }
  renderProviders();

  // history folder
  const histInput = h("input", { class: "input", value: s.historyDir, readonly: "true" });
  const histRow = h("div", { class: "input-row" }, histInput,
    h("button", { class: "btn btn-ghost btn-sm", text: "Browse", onclick: async () => { const p = await atom.dialog.pickHistory(); if (p) { s.historyDir = p; histInput.value = p; await atom.settings.set({ historyDir: p }); toast("History folder updated"); } } }),
    h("button", { class: "btn btn-ghost btn-sm", html: icon("external", 14), onclick: () => atom.sessions.openHistory() }));

  // claude path
  const pathInput = h("input", { class: "input", value: s.claudePath || "", placeholder: auth.cliPath || "auto-detect (claude on PATH)" });
  pathInput.addEventListener("change", () => atom.settings.set({ claudePath: pathInput.value.trim() }).then(() => { s.claudePath = pathInput.value.trim(); toast("CLI path saved"); }));

  // api key
  const keyInput = h("input", { class: "input", type: "password", value: s.apiKey || "", placeholder: "sk-ant-… (optional — overrides CLI login)" });
  keyInput.addEventListener("change", () => atom.settings.set({ apiKey: keyInput.value.trim() }).then(() => { s.apiKey = keyInput.value.trim(); toast("API key saved"); }));

  // use environment ANTHROPIC_API_KEY?
  const envSeg = segmented(["off", "on"], s.useEnvApiKey ? "on" : "off", (v) => { s.useEnvApiKey = v === "on"; atom.settings.set({ useEnvApiKey: s.useEnvApiKey }); }, { off: "Ignore env key (use CLI login)", on: "Use ANTHROPIC_API_KEY env" });

  // Back up & restore — a personal migration archive. INCLUDES provider logins,
  // API keys, custom APIs (with tokens), skills, projects and preferences. Two
  // scopes: app data only, or app data + all agent sessions.
  const backupRow = h("div", { style: "display:flex; gap:8px; flex-wrap:wrap;" },
    h("button", { class: "btn btn-ghost btn-sm", html: `${icon("download", 14)}<span>Backup…</span>`, onclick: async () => {
      const choice = await chooseDialog({
        title: "Back up AtomNano", ic: "download",
        message: "Saves your provider logins, API keys, custom APIs (with tokens), skills, projects and preferences. Choose what to include:",
        choices: [
          { label: "Application data only", value: "app", primary: true },
          { label: "Application data + agent sessions", value: "full" },
          { label: "Cancel", value: null },
        ],
      });
      if (!choice) return;
      try {
        const r = await atom.userdata.export({ includeSessions: choice === "full" });
        if (r && r.canceled) return;
        if (r && r.path) {
          const bits = [`${r.endpoints || 0} custom API${r.endpoints === 1 ? "" : "s"}`, `${r.auth || 0} login${r.auth === 1 ? "" : "s"}`];
          if (choice === "full") bits.push(`${r.sessions} session${r.sessions === 1 ? "" : "s"}`);
          toast("Backed up — " + bits.join(", "), "download");
        }
      } catch (e) { toast("Backup failed: " + e.message, "alert"); }
    } }),
    h("button", { class: "btn btn-ghost btn-sm", html: `${icon("upload", 14)}<span>Restore…</span>`, onclick: async () => {
      try {
        const r = await atom.userdata.import();
        if (!r || r.canceled) return;
        const parts = [];
        if (r.auth) parts.push(`${r.auth} provider login${r.auth === 1 ? "" : "s"}`);
        if (r.sessions) parts.push(`${r.sessions} session${r.sessions === 1 ? "" : "s"}`);
        if (r.skills) parts.push(`${r.skills} skill${r.skills === 1 ? "" : "s"}`);
        chooseDialog({
          title: "Backup restored", ic: "check",
          message: `Restored your settings, API keys and custom APIs${parts.length ? " (" + parts.join(", ") + ")" : ""}. Restart AtomNano to apply everything?`,
          choices: [{ label: "Restart now", value: "restart", primary: true }, { label: "Later", value: null }],
        }).then((c) => { if (c === "restart") atom.app.relaunch(); });
      } catch (e) { toast("Restore failed: " + e.message, "alert"); }
    } }));

  // ---- MCP servers — shared with Antigravity (agy) + Antigravity IDE via
  // ~/.gemini/config/mcp_config.json. Anything configured here is also picked
  // up by agy on its next run. ----
  const mcpBox = h("div", { class: "field" });
  async function renderMcp() {
    mcpBox.innerHTML = "";
    mcpBox.append(h("label", { text: "MCP servers — shared with Antigravity" }));
    let data; try { data = await atom.mcp.list(); } catch (e) { data = { servers: [], readError: e.message }; }
    if (data.readError) mcpBox.append(h("div", { class: "hint", style: "color:var(--red)", text: "Couldn't read mcp_config.json: " + data.readError }));
    const list = h("div", { class: "mcp-list" });
    if (!data.servers.length) list.append(h("div", { class: "hint", style: "margin:0", text: "No MCP servers configured yet." }));
    else for (const srv of data.servers) {
      const summary = srv.kind === "http" ? srv.serverUrl : (srv.command + (srv.args && srv.args.length ? " " + srv.args.join(" ") : ""));
      list.append(h("div", { class: "mcp-row" },
        h("div", { class: "mcp-meta" },
          h("div", { class: "mcp-name" },
            h("span", { class: "mcp-kind", text: srv.kind === "http" ? "HTTP" : "STDIO" }),
            h("span", { text: srv.name })),
          h("div", { class: "mcp-sub", text: summary || "(empty)", title: summary })),
        h("div", { class: "mcp-actions" },
          h("button", { class: "btn btn-ghost btn-sm", text: "Edit", onclick: () => openMcpEditor(srv, renderMcp) }),
          h("button", { class: "btn btn-ghost btn-sm", text: "Remove", onclick: async () => {
            const c = await confirmDialog({ title: "Remove MCP server?", message: `'${srv.name}' will be deleted from ~/.gemini/config/mcp_config.json.`, danger: true, confirmLabel: "Remove" });
            if (c) { try { await atom.mcp.remove(srv.name); renderMcp(); } catch (e) { toast("Remove failed: " + e.message, "alert"); } }
          } }))));
    }
    mcpBox.append(list);
    mcpBox.append(h("div", { class: "mcp-bar" },
      h("button", { class: "btn btn-primary btn-sm", html: `${icon("plus", 13)}<span>Add MCP server…</span>`, onclick: () => openMcpEditor(null, renderMcp) }),
      h("button", { class: "btn btn-ghost btn-sm", html: `${icon("external", 13)}<span>Open config file</span>`, onclick: () => atom.mcp.openFile().catch(() => {}) })));
    mcpBox.append(h("div", { class: "hint", text: "Edits the file Antigravity (agy) and the Antigravity IDE read: ~/.gemini/config/mcp_config.json. Note: per the Antigravity docs, env-var forwarding to MCP servers is broken — keys must be hardcoded here." }));
  }
  renderMcp();

  // ---- Cross-tool skill bridge — mirror project skills to ~/.gemini/skills/ ----
  const skillBridgeBox = h("div", { class: "field" });
  function renderSkillBridge() {
    skillBridgeBox.innerHTML = "";
    // Antigravity (agy) integration was removed — the skill-export bridge is gone.
    skillBridgeBox.append(h("div", { class: "hint", text: "Antigravity (agy) integration was removed in this build. The skill-export-to-Antigravity bridge is no longer available." }));
  }
  renderSkillBridge();

  // ---- atomnano CLI — enable (npm link onto PATH) + usage instructions ----
  const cliBox = h("div", { class: "field" });
  const CLI_EXAMPLES = [
    ["Ask using your configured primary", 'atomnano run "explain this project"'],
    ["Pick a provider / model (or custom endpoint)", 'atomnano run -P custom -m glm-5.2 "hello"'],
    ["Thinking effort + 1M context (Claude)", 'atomnano run -t ultrathink --1m "design a rate limiter"'],
    ["Let it use tools (edit files, run commands)", 'atomnano run --agent "add a README here"'],
    ["Pipe input from other commands", 'git diff | atomnano run -s "Review this diff"'],
    ["Inspect your configuration", "atomnano providers   ·   atomnano models   ·   atomnano endpoints"],
  ];
  async function renderCliBox() {
    cliBox.innerHTML = "";
    cliBox.append(h("label", { text: "Command-line interface (atomnano)" }));
    let st = {}; try { st = await atom.cli.status(); } catch { /* */ }
    const linked = !!(st && st.linked);
    const seg = segmented(["off", "on"], linked ? "on" : "off", async (v) => {
      if (v === "on") {
        toast("Linking atomnano onto your PATH…", "cpu");
        const r = await atom.cli.enable().catch((e) => ({ ok: false, detail: e.message }));
        if (r && r.ok) toast("atomnano CLI enabled — use it from any terminal", "check");
        else toast("Couldn't link: " + ((r && r.detail) || "check npm is installed"), "alert");
      } else {
        await atom.cli.disable().catch(() => {});
        toast("atomnano CLI disabled");
      }
      renderCliBox();
    }, { off: "Off", on: "On" });
    cliBox.append(seg);

    cliBox.append(h("div", { class: "hint", style: "margin-top:6px",
      text: linked ? `Enabled — \`atomnano\` is on your PATH${st.path ? " (" + st.path + ")" : ""}. Reuses the providers, models, custom APIs and keys configured above.`
        : st.packaged ? "Run from source to auto-link, or add the app's bin folder to PATH manually."
        : "Turn on to run npm link so the atomnano command works in any terminal." }));

    // Usage block — copyable examples
    const usage = h("div", { class: "cli-usage" });
    usage.append(h("div", { class: "cli-usage-head", text: "Usage" }));
    for (const [desc, cmd] of CLI_EXAMPLES) {
      usage.append(h("div", { class: "cli-ex" },
        h("div", { class: "cli-ex-desc", text: desc }),
        h("div", { class: "cli-ex-row" },
          h("code", { class: "cli-ex-cmd", text: cmd }),
          h("button", { class: "cli-ex-copy", title: "Copy", html: icon("copy", 13), onclick: () => { atom.clipboard.write(cmd); toast("Copied", "copy"); } }))));
    }
    usage.append(h("div", { class: "hint", style: "margin-top:6px", text: "Defaults to text-only (safe); add --agent for tool use. Run `atomnano help` for all flags. Exit code 0 = ok, errors go to stderr so pipes stay clean." }));
    cliBox.append(usage);
  }
  renderCliBox();

  // ---- Agent SDK capability controls (0.3.22x) — mirror store.js defaults ----
  const onoff = { off: "Off", on: "On" };
  const ckptSeg = segmented(["off", "on"], s.enableFileCheckpointing !== false ? "on" : "off",
    (v) => { s.enableFileCheckpointing = v === "on"; atom.settings.set({ enableFileCheckpointing: s.enableFileCheckpointing }); }, onoff);
  const progSeg = segmented(["off", "on"], s.agentProgressSummaries !== false ? "on" : "off",
    (v) => { s.agentProgressSummaries = v === "on"; atom.settings.set({ agentProgressSummaries: s.agentProgressSummaries }); }, onoff);
  const subTxtSeg = segmented(["off", "on"], s.forwardSubagentText !== false ? "on" : "off",
    (v) => { s.forwardSubagentText = v === "on"; atom.settings.set({ forwardSubagentText: s.forwardSubagentText }); }, onoff);
  const suggSeg = segmented(["off", "on"], s.promptSuggestions ? "on" : "off",
    (v) => { s.promptSuggestions = v === "on"; atom.settings.set({ promptSuggestions: s.promptSuggestions }); }, onoff);
  const skillsInput = h("input", { class: "input", placeholder: "none · all · pdf, docx", value: typeof s.sdkSkills === "string" ? s.sdkSkills : "none" });
  skillsInput.onchange = () => { s.sdkSkills = (skillsInput.value.trim() || "none"); atom.settings.set({ sdkSkills: s.sdkSkills }); };
  const addDirsInput = h("input", { class: "input", placeholder: "C:\\lib, D:\\shared (absolute)", value: Array.isArray(s.additionalDirectories) ? s.additionalDirectories.join(", ") : "" });
  addDirsInput.onchange = () => { s.additionalDirectories = addDirsInput.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean); atom.settings.set({ additionalDirectories: s.additionalDirectories }); };
  const disToolsInput = h("input", { class: "input", placeholder: "e.g. WebFetch, WebSearch", value: Array.isArray(s.disallowedTools) ? s.disallowedTools.join(", ") : "" });
  disToolsInput.onchange = () => { s.disallowedTools = disToolsInput.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean); atom.settings.set({ disallowedTools: s.disallowedTools }); };

  // ---- category-based layout: left nav + right content ----
  const CATS = [
    { id: "providers", label: "Providers", ic: "globe", items: () => [providersBox, updBox, toolsBox] },
    { id: "integrations", label: "Integrations", ic: "git", items: () => [mcpBox, skillBridgeBox, cliBox] },
    { id: "appearance", label: "Appearance", ic: "eye", items: () => [
      field("Theme", themeRow),
      field(isMac ? "Dock tile" : "Taskbar tile", tileBox, `The letters this project's window shows ${isMac ? "in the Dock (while it is focused)" : "on the Windows taskbar"} and their size. Saved for this project.`),
      field(isMac ? "Dock tile color" : "Taskbar tile color", colorRow, "Pick a swatch, or any colour with the last one. Light colours get dark letters automatically."),
    ] },
    { id: "agent", label: "Agent", ic: "atom", items: () => [
      field("Interface size (zoom)", fontSeg, "Zoom level for the chat."),
      field("Model (all sessions)", defModel, "Shared across every session."),
      field("Permission mode", defPerm),
      field("Thinking level", defThink),
      field("Resend button", resendSeg, "Show a Resend button under each of your messages."),
      field("Prevent sleep", sleepSeg, "Keep the computer awake while AtomNano runs (long agent jobs)."),
      field("Custom models", cmInput, "Add model IDs released after this build."),
    ] },
    { id: "sdk", label: "Agent SDK", ic: "cpu", items: () => [
      field("File checkpoints", ckptSeg, "Back up files before edits so a turn's changes can be rewound (Rewind button under your messages). Small disk overhead."),
      field("Subagent progress", progSeg, "Live status blurbs for running subagents (needs Sub agents on)."),
      field("Subagent transcript", subTxtSeg, "Stream subagents' own text + thinking into a nested view (needs Sub agents on)."),
      field("Prompt suggestions", suggSeg, "Show a predicted next-prompt chip after each reply. Nearly free (rides the cache)."),
      field("Native SDK skills", skillsInput, "Anthropic's built-in skills (pdf, docx…). \"none\", \"all\", or comma-separated names. Separate from AtomNano's own skills."),
      field("Extra read directories", addDirsInput, "Absolute paths the agent may read beyond the project folder."),
      field("Disabled tools", disToolsInput, "Built-in tool names to remove from the agent entirely (e.g. WebFetch)."),
    ] },
    { id: "editor", label: "Editor", ic: "fileCode", items: () => [
      field("Font style", edFontSel, "Font family used by the code editor."),
      field("Font size", edSizeRow, "Also adjustable with Ctrl + / Ctrl -."),
      field("Syntax highlighting", highlightSeg, "Grammar-based token colours (~35 languages)."),
      field("Syntax errors", lintSeg, "Underline grammar parse errors (off-thread)."),
      field("Semantic analysis (TS)", semanticSeg, "Project-wide diagnostics for JS/TS. Powers completion, hover, quick-fix, rename, format."),
      field("Format on save", fmtSaveSeg, "Run the formatter when you save."),
      field("Word wrap", wrapSeg, "Wrap long lines (Alt+Z)."),
      field("Bracket pair colours", bracketSeg, "Rainbow brackets by depth."),
      field("Trim whitespace on save", trimSeg, "Remove trailing spaces/tabs when saving."),
      field("Final newline", finalNlSeg, "Ensure file ends with a newline."),
      field("Render whitespace", renderWsSeg, "Show dots for spaces and arrows for tabs."),
      field("Auto-save", autoSaveSeg, "Save after a short pause in typing."),
      field("Inlay hints", inlaySeg, "Inline parameter-name and type hints from TS / LSP."),
      field("Indent guides", guidesSeg, "Very subtle vertical lines at each indent level."),
      field("Sticky scroll", stickySeg, "Pin enclosing function/class headers at the top."),
    ] },
    { id: "storage", label: "Storage", ic: "settings", items: () => [
      field("Back up & restore", backupRow, "Backup includes provider logins, API keys, custom APIs (with tokens), skills, projects and preferences. Keep the file private — it contains your secrets."),
      field("Session history folder", histRow, "Each session is stored as a JSON file here."),
      field("Claude CLI path", pathInput, "Leave blank to auto-detect. (API keys live under Providers.)"),
      field("Environment API key", envSeg, auth.envKeyPresent ? "ANTHROPIC_API_KEY detected. Ignored by default (CLI login)." : "No ANTHROPIC_API_KEY in environment."),
      field(info.portable ? "Data location (Portable)" : "Data location",
        h("div", { class: "input", style: "font-family:var(--font-mono); font-size:11.5px; word-break:break-all; cursor:pointer", text: info.userData, onclick: () => atom.shell.openExternal("file://" + (info.userData || "").replace(/\\/g, "/")) }),
        info.portable ? "Data lives next to the app." : "Data is in your user profile."),
      h("div", { class: "hint", style: "text-align:center; margin-top:6px;", text: `AtomNano v${info.version}` }),
    ] },
  ];
  const stNav = h("div", { class: "st-nav" });
  const stContent = h("div", { class: "st-content" });
  let activeCat = CATS[0].id;
  function drawCat() {
    stNav.innerHTML = ""; stContent.innerHTML = "";
    for (const c of CATS) stNav.append(h("button", { class: "st-cat" + (c.id === activeCat ? " active" : ""), onclick: () => { activeCat = c.id; drawCat(); } },
      h("span", { class: "st-cat-ic", html: icon(c.ic, 15) }), h("span", { text: c.label })));
    const cat = CATS.find((c) => c.id === activeCat) || CATS[0];
    for (const el of cat.items()) stContent.append(el);
  }
  drawCat();
  body.append(h("div", { class: "st-layout" }, stNav, stContent));
  const back = modalShell({ title: "Settings", ic: "settings", wide: true, body, footer: [h("button", { class: "btn btn-primary", text: "Done", onclick: () => closeModal(back) })] });
}

// Per-provider management modal — Authorize (browser/CLI login) and an optional
// API key, in one focused place. `onChange` re-renders the providers list so the
// card status + Primary mark stay live. Opens on top of the Settings modal.
// MCP server editor — add or edit a single server in ~/.gemini/config/mcp_config.json.
// stdio mode → command + args + env, http mode → serverUrl + authProviderType.
function openMcpEditor(existing, onSaved) {
  const isNew = !existing;
  const init = existing || { name: "", kind: "stdio", command: "", args: [], env: {}, serverUrl: "", authProviderType: "" };
  let kind = init.kind === "http" ? "http" : "stdio";

  const nameInput = h("input", { class: "input", placeholder: "e.g. github, postgres", value: init.name || "" });
  if (!isNew) nameInput.disabled = true;

  const kindSeg = segmented(["stdio", "http"], kind, (v) => { kind = v; redraw(); }, { stdio: "STDIO (process)", http: "HTTP" });

  // stdio fields
  const cmdInput = h("input", { class: "input", placeholder: "command, e.g. npx", value: init.command || "" });
  const argsInput = h("input", { class: "input", placeholder: "args (space-separated), e.g. -y @modelcontextprotocol/server-github", value: (init.args || []).join(" ") });
  const envBox = h("div", { class: "mcp-env" });
  let envRows = Object.keys(init.env || {}).map((k) => ({ k, v: init.env[k] }));
  if (!envRows.length) envRows.push({ k: "", v: "" });
  function drawEnv() {
    envBox.innerHTML = "";
    envRows.forEach((row, i) => {
      const k = h("input", { class: "input mcp-env-k", placeholder: "VAR", value: row.k });
      const v = h("input", { class: "input mcp-env-v", placeholder: "value", value: row.v });
      const x = h("button", { class: "btn btn-ghost btn-sm", html: icon("close", 12), onclick: () => { envRows.splice(i, 1); if (!envRows.length) envRows.push({ k: "", v: "" }); drawEnv(); } });
      k.addEventListener("input", () => { envRows[i].k = k.value; });
      v.addEventListener("input", () => { envRows[i].v = v.value; });
      envBox.append(h("div", { class: "mcp-env-row" }, k, v, x));
    });
    envBox.append(h("button", { class: "btn btn-ghost btn-sm", html: `${icon("plus", 12)}<span>Add var</span>`, onclick: () => { envRows.push({ k: "", v: "" }); drawEnv(); } }));
  }
  drawEnv();

  // http fields
  const urlInput = h("input", { class: "input", placeholder: "https://server.example.com/mcp", value: init.serverUrl || "" });
  const authInput = h("input", { class: "input", placeholder: "(optional) authProviderType", value: init.authProviderType || "" });

  const form = h("div", { class: "mcp-form" });
  function redraw() {
    form.innerHTML = "";
    form.append(field("Name", nameInput, isNew ? "Lowercase identifier — used to reference the server." : "(read-only — use Rename to change)"));
    form.append(field("Transport", kindSeg));
    if (kind === "stdio") {
      form.append(field("Command", cmdInput, "Executable that speaks MCP over stdio."));
      form.append(field("Args", argsInput, "Space-separated. Escape with quotes if needed."));
      form.append(field("Environment", envBox, "Hardcode credentials here — env-var forwarding is broken in agy today."));
    } else {
      form.append(field("Server URL", urlInput, "Use serverUrl (not the deprecated httpUrl)."));
      form.append(field("Auth provider type", authInput, "Optional."));
    }
  }
  redraw();

  function parseArgs(s) {
    const out = []; let i = 0, cur = "", q = null;
    while (i < s.length) {
      const c = s[i++];
      if (q) { if (c === q) { q = null; } else { cur += c; } continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } continue; }
      cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }

  const m = modalShell({
    title: isNew ? "Add MCP server" : `Edit MCP server — ${init.name}`,
    ic: "git", wide: true, body: form,
    footer: h("div", { class: "modal-actions" },
      h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => m.close() }),
      h("button", { class: "btn btn-primary", text: isNew ? "Add" : "Save", onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) { toast("Name is required", "alert"); return; }
        if (isNew && !/^[a-z0-9_\-]+$/i.test(name)) { toast("Name must be alphanumeric / dash / underscore.", "alert"); return; }
        const patch = kind === "stdio"
          ? {
              command: cmdInput.value.trim(),
              args: parseArgs(argsInput.value),
              env: Object.fromEntries(envRows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v])),
              serverUrl: "", authProviderType: "",
            }
          : {
              serverUrl: urlInput.value.trim(),
              authProviderType: authInput.value.trim(),
              command: "", args: [], env: {},
            };
        if (kind === "stdio" && !patch.command) { toast("Command is required for STDIO servers", "alert"); return; }
        if (kind === "http" && !patch.serverUrl) { toast("serverUrl is required for HTTP servers", "alert"); return; }
        try { await atom.mcp.upsert(name, patch); m.close(); if (onSaved) onSaved(); toast(isNew ? "MCP server added" : "MCP server saved", "check"); }
        catch (e) { toast("Save failed: " + e.message, "alert"); }
      } })),
  });
}

async function openProviderModal(p, onChange) {
  const s = state.settings;
  const isAnthropic = p.id === "anthropic";
  const canPrimary = p.id === "anthropic" || p.id === "google" || p.id === "custom";
  const firstWord = p.name.split(" ")[0];
  const body = h("div", { class: "prov-modal" });
  let backRef = null;
  let custEdit = null;   // null = endpoint list; object = endpoint being added/edited

  async function render() {
    body.innerHTML = "";
    const pst = await atom.providers.authStatus().catch(() => ({}));
    const ps = pst[p.id] || {};
    let loggedIn = ps.loggedIn, methodTxt = "", detail = "";
    if (isAnthropic) { const a = await atom.auth.status().catch(() => ({})); loggedIn = a.loggedIn || ps.loggedIn; methodTxt = a.loggedIn ? `Signed in — ${a.authMethod || "CLI login"}` : ""; detail = a.cliFound ? `Claude CLI: ${a.cliPath}${a.version ? " · v" + a.version : ""}` : "Claude CLI not found on PATH — set its path in Storage."; }
    else methodTxt = loggedIn ? "Signed in via CLI / browser login" : "";
    // For custom, "connected" means at least one endpoint is configured.
    const custCount = p.id === "custom" ? epList().length : 0;
    if (p.id === "custom") methodTxt = custCount ? `${custCount} endpoint${custCount > 1 ? "s" : ""} configured` : "";
    const authed = p.id === "custom" ? custCount > 0 : (loggedIn || ps.key);
    const isPrimary = (s.llmProvider || "anthropic") === p.id;

    // status header
    body.append(h("div", { class: "pm-status" },
      h("span", { class: "status-pill " + (authed ? "ok" : "bad") }, h("span", { class: "dot" }), authed ? "Connected" : "Not connected"),
      isPrimary ? h("span", { class: "pc-primary", text: "Primary" }) : null,
      h("span", { class: "hint", style: "margin:0", text: methodTxt || (p.id === "custom" ? "Add an endpoint to get started" : ps.key ? "Using an API key" : "Not connected yet") })));

    // sign-in
    if (ps.canAuthorize !== false) {
      body.append(section("Sign in", "shield"));
      const authBtn = h("button", { class: "btn btn-primary", html: `${icon("shield", 14)}<span>Authorize ${firstWord}</span>`, onclick: async () => {
        if (isAnthropic) { await atom.auth.openLogin(); toast("Login terminal opened — finish /login, then Re-check"); }
        else { const r = await atom.providers.authorize(p.id).catch(() => ({ ok: false })); toast(r.ok ? "Opened a login window — finish there, then Re-check" : (r.detail || "Use an API key instead"), r.ok ? "shield" : "alert"); }
      } });
      body.append(h("div", { class: "pm-row" }, authBtn, h("button", { class: "btn btn-ghost", html: `${icon("refresh", 14)}<span>Re-check</span>`, onclick: () => render() })));
      if (detail) body.append(h("div", { class: "hint", text: detail }));
    }

    // Saved accounts (Claude and Codex CLI logins) — switch between logins without
    // re-authorizing. Saved copies are kept fresh automatically as tokens rotate.
    if (isAnthropic || p.id === "openai") {
      const prov = p.id === "openai" ? "openai" : "anthropic";
      const brand = prov === "openai" ? "Codex" : "Claude";
      body.append(section("Saved accounts", "user"));
      const profBox = h("div", { class: "prof-list" });
      let profiles = [], live = null;
      try { profiles = await atom.profiles.list(prov); } catch { /* ignore */ }
      try { live = await atom.profiles.live(prov); } catch { /* ignore */ }
      if (live && live.loggedIn && !live.savedAs) profBox.append(h("div", { class: "hint", text: `Signed in${live.email ? " as " + live.email : ""}${live.sub ? " (" + live.sub + ")" : ""} — not saved yet. It's saved automatically on the next token refresh, or click “Save current login”.` }));
      if (profiles.length) {
        for (const pf of profiles) {
          const rename = h("button", { class: "prof-act", html: icon("pencil", 12), title: "Rename", onclick: () => {
            promptDialog({ title: "Rename saved account", ic: "user", message: "A friendly name to tell your accounts apart.", placeholder: "e.g. Work · Personal", value: pf.label, confirmLabel: "Rename", onConfirm: async (name) => {
              if (!name || !name.trim()) return;
              const r = await atom.profiles.rename(pf.label, name.trim(), prov).catch((e) => ({ ok: false, detail: e.message }));
              if (r.ok) { toast("Renamed to " + r.label, "check"); render(); } else toast(r.detail || "Rename failed", "alert");
            } });
          } });
          const exp = h("button", { class: "prof-act", html: icon("download", 12), title: "Export this account", onclick: async () => {
            const r = await atom.profiles.export(pf.label, prov).catch((e) => ({ ok: false, detail: e.message }));
            if (r.ok) toast("Exported to " + r.path, "download");
            else if (!r.canceled) toast(r.detail || "Export failed", "alert");
          } });
          const subLine = pf.active ? "Active — currently signed in" + (pf.sub ? " · " + pf.sub : "") : (pf.expired ? "Expired — sign in to this account again and re-save" : (pf.email && pf.email !== pf.label ? pf.email : (pf.sub ? brand + " " + pf.sub : "saved login")));
          profBox.append(h("div", { class: "prof-item" + (pf.active ? " active" : "") + (pf.expired ? " expired" : "") },
            h("span", { class: "prof-ic", html: icon(pf.active ? "check" : pf.expired ? "alert" : "user", 14) }),
            h("span", { class: "prof-main" },
              h("span", { class: "prof-email", text: pf.label || pf.email || (pf.sub ? brand + " " + pf.sub : "account") }),
              h("span", { class: "prof-sub", text: subLine })),
            pf.active
              ? h("span", { class: "prof-tag", text: "Active" })
              : h("button", { class: "btn btn-sm", text: "Switch", disabled: !!pf.expired, title: pf.expired ? "This saved login has expired" : `Sign in as ${pf.label}`, onclick: async () => {
                  const r = await atom.profiles.switch(pf.label, prov).catch((e) => ({ ok: false, detail: e.message }));
                  if (r.ok) {
                    // Show what the RUNTIME acknowledges after the switch (Codex account/read), not just the profile label.
                    const ack = r.runtimeAccount ? ` · runtime reports ${r.runtimeAccount.email || r.runtimeAccount.type}${r.runtimeAccount.planType ? " (" + r.runtimeAccount.planType + ")" : ""}` : "";
                    toast(r.already ? ("Already signed in as " + (pf.label || pf.email)) : ("Switched to " + (pf.label || pf.email) + ack + " — paused sessions resume…"), "key", { ms: 6000 });
                    for (const [id, ts2] of state.tabs) {
                      if (ts2.meta.status === "auth-expired" || ts2.meta.status === "ratelimited") atom.sessions.retry(id).catch(() => {});
                    }
                    render();                 // refresh this modal (status header + Active markers)
                    if (onChange) onChange();  // and the Providers card behind it
                  } else { toast(r.detail || "Switch failed", "alert", { ms: r.expired ? 8000 : 4000 }); }
                } }),
            rename, exp,
            h("button", { class: "prof-act prof-del", html: icon("trash", 12), title: "Remove saved account", onclick: async () => {
              await atom.profiles.delete(pf.label, prov).catch(() => {});
              toast("Removed " + (pf.label || pf.email));
              render();
            } })));
        }
      } else {
        profBox.append(h("div", { class: "hint", text: `No saved ${brand} accounts yet. Logins are saved automatically; save now to switch quickly when rate-limited.` }));
      }
      body.append(profBox);
      body.append(h("div", { class: "pm-row" },
        h("button", { class: "btn btn-ghost", html: `${icon("plus", 14)}<span>Save current login</span>`, onclick: async () => {
          const r = await atom.profiles.saveCurrent(prov).catch((e) => ({ ok: false, detail: e.message }));
          if (r.ok) { toast((r.created || !r.updated ? "Saved as " : "Refreshed ") + r.label, "check"); render(); }
          else toast(r.detail || "No active login to save", "alert");
        } }),
        h("button", { class: "btn btn-ghost", html: `${icon("upload", 14)}<span>Import account</span>`, title: `Import a ${brand} credential file exported from another machine`, onclick: async () => {
          const r = await atom.profiles.import(prov).catch((e) => ({ ok: false, detail: e.message }));
          if (r.ok) { toast("Imported as " + r.label, "check"); render(); }
          else if (!r.canceled) toast(r.detail || "Import failed", "alert");
        } }),
        (live && live.loggedIn) ? h("button", { class: "btn btn-ghost", html: `${icon("x", 14)}<span>Sign out</span>`, title: "Sign out of the CLI login — saved accounts are kept and can be restored with Switch", onclick: async () => {
          const r = await atom.profiles.logout(prov).catch((e) => ({ ok: false, detail: e.message }));
          if (r.ok) { toast(r.savedAs ? `Signed out — “${r.savedAs}” stays saved` : "Signed out", "key"); render(); if (onChange) onChange(); }
          else toast(r.detail || "Sign out failed", "alert");
        } }) : null));
    }

    if (p.id === "custom") {
      // Custom = a list of named endpoints (the ONLY way to configure it — no
      // separate base-URL/key block, which was confusing). Each endpoint carries
      // its own URL + key + model + payload.
      body.append(customAdvanced());
    } else {
      // API key (modal-based, optional)
      body.append(section("API key", "globe"));
      const keyIn = h("input", { class: "input", type: "password", placeholder: ps.key ? "•••••••• (set — type to replace)" : "Paste an API key (optional)" });
      const saveKey = h("button", { class: "btn btn-primary", text: "Save", onclick: () => { if (!keyIn.value.trim()) return; s[p.keyField] = keyIn.value.trim(); atom.settings.set({ [p.keyField]: s[p.keyField] }).then(() => { toast("API key saved"); render(); }); } });
      const removeKey = ps.key ? h("button", { class: "btn btn-ghost", text: "Remove", onclick: () => { s[p.keyField] = ""; atom.settings.set({ [p.keyField]: "" }).then(() => { toast("API key removed"); render(); }); } }) : null;
      body.append(h("div", { class: "pm-row" }, keyIn, saveKey, removeKey));
    }

    // Codex web search — sent as the thread's `web_search` config on every OpenAI
    // turn (app-server and the exec fallback alike). "" = don't override Codex's
    // own ~/.codex/config.toml (whose default is cached).
    if (p.id === "openai") {
      body.append(section("Web search", "globe"));
      const WS = ["live", "cached", "disabled", ""];
      const WS_LABEL = { live: "Live", cached: "Cached", disabled: "Off", "": "Codex default" };
      const raw = s.openaiWebSearch;
      const cur = raw === true ? "live" : raw === false ? "disabled" : (WS.includes(raw) || raw === "indexed") ? raw : "live";
      body.append(segmented(WS, cur, (v) => { s.openaiWebSearch = v; atom.settings.set({ openaiWebSearch: v }).then(() => toast("Codex web search: " + WS_LABEL[v])); }, WS_LABEL));
      body.append(h("div", { class: "hint", text: "Live fetches current pages. Cached answers from Codex's search cache (fast, can be stale). Off blocks web search for the model. Codex default leaves ~/.codex/config.toml in charge. Managed Codex requirements can narrow this — the nearest allowed mode is used." }));
      // Reasoning summaries (the Codex "thinking" cards): an explicit choice, or the
      // Codex default — the app never forces a mode.
      body.append(section("Reasoning summaries", "brain"));
      const RS = ["", "auto", "concise", "detailed", "none"];
      const RS_LABEL = { "": "Codex default", auto: "Auto", concise: "Concise", detailed: "Detailed", none: "Off" };
      const curRs = RS.includes(s.codexReasoningSummary) ? s.codexReasoningSummary : "";
      body.append(segmented(RS, curRs, (v) => { s.codexReasoningSummary = v; atom.settings.set({ codexReasoningSummary: v }).then(() => toast("Codex reasoning summaries: " + RS_LABEL[v])); }, RS_LABEL));
      body.append(h("div", { class: "hint", text: "Codex shows a summary of its reasoning, not the raw reasoning. Sent as the thread's model_reasoning_summary only when you pick a value here." }));
      // The account the Codex runtime is ACTUALLY using (read from the runtime, not a label).
      const acctRow = h("div", { class: "hint", text: "Effective Codex account: reading…" });
      body.append(acctRow);
      atom.codex.account().then((a) => { acctRow.textContent = a && a.type ? `Effective Codex account (runtime): ${a.type}${a.email ? " · " + a.email : ""}${a.planType ? " · " + a.planType : ""}${s.openaiApiKey ? "  (API-key context)" : ""}` : (a && a.error ? "Effective Codex account: unavailable — " + a.error : "Effective Codex account: not signed in"); }).catch(() => { acctRow.textContent = "Effective Codex account: unavailable"; });
    }

    // make primary
    if (canPrimary && !isPrimary) {
      body.append(h("button", { class: "btn btn-ghost pm-primary", html: `${icon("check", 14)}<span>Make ${firstWord} the primary</span>`, onclick: () => { setSharedSetting("llmProvider", p.id); loadProviderModels(p.id); toast(`${firstWord} is now the primary`); render(); } }));
    }
    const note = p.id === "openai" ? "OpenAI runs the primary turn via the Codex SDK — live streaming, tool cards, and thread resume." : p.id === "google" ? "Antigravity (agy) was removed from this build." : "Runs the primary turn directly.";
    body.append(h("div", { class: "hint", text: note }));
    if (onChange) onChange();   // keep the underlying card live
  }

  // ---- Custom provider: request payload + response output-key configuration ----
  // Lets the user point AtomNano at ANY HTTP API, not just Anthropic-compatible
  // ones, by giving a request payload template and the JSON path to the reply.
  const CUSTOM_PRESETS = {
    openai: {
      label: "OpenAI-style",
      headers: "Authorization: Bearer {{apiKey}}",
      payload: '{\n  "model": "{{model}}",\n  "messages": [\n    { "role": "system", "content": "{{system}}" },\n    { "role": "user", "content": "{{prompt}}" }\n  ]\n}',
      output: "choices[0].message.content",
    },
    anthropic: {
      label: "Anthropic-style",
      headers: "x-api-key: {{apiKey}}\nanthropic-version: 2023-06-01",
      payload: '{\n  "model": "{{model}}",\n  "max_tokens": 4096,\n  "system": "{{system}}",\n  "messages": [\n    { "role": "user", "content": "{{prompt}}" }\n  ]\n}',
      output: "content[0].text",
    },
    gemini: {
      label: "Gemini-style",
      headers: "x-goog-api-key: {{apiKey}}",
      payload: '{\n  "system_instruction": { "parts": [ { "text": "{{system}}" } ] },\n  "contents": [ { "parts": [ { "text": "{{prompt}}" } ] } ]\n}',
      output: "candidates[0].content.parts[0].text",
    },
  };

  const slugifyEp = (name) => (String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "endpoint");
  // Rewrite a pasted payload (with hardcoded message text) to use {{prompt}}/{{system}}.
  function autofixPayload(text) {
    let obj; try { obj = JSON.parse(text); } catch { return null; }
    let changed = false;
    if (Array.isArray(obj.messages)) {
      let lastUser = null;
      for (const m of obj.messages) {
        if (!m || typeof m !== "object") continue;
        if (m.role === "user") lastUser = m;
        if (m.role === "system" && typeof m.content === "string") { m.content = "{{system}}"; changed = true; }
      }
      if (lastUser) { lastUser.content = "{{prompt}}"; changed = true; }
      else { obj.messages.push({ role: "user", content: "{{prompt}}" }); changed = true; }
    } else if (Array.isArray(obj.contents)) {
      const last = obj.contents[obj.contents.length - 1];
      if (last && Array.isArray(last.parts) && last.parts[0]) { last.parts[0].text = "{{prompt}}"; changed = true; }
    } else {
      for (const k of ["prompt", "input", "text", "query", "message", "question"]) {
        if (k in obj && typeof obj[k] === "string") { obj[k] = "{{prompt}}"; changed = true; break; }
      }
    }
    return changed ? JSON.stringify(obj, null, 2) : null;
  }
  const epList = () => Array.isArray(s.customEndpoints) ? s.customEndpoints : [];
  const saveEndpoints = (list) => {
    s.customEndpoints = list; atom.settings.set({ customEndpoints: list });
    if ((s.llmProvider || "anthropic") === "custom") loadProviderModels("custom");
  };

  function customAdvanced() {
    // One-time migration: fold any legacy single base-URL/key config into a named
    // endpoint so there's exactly one way to manage custom APIs (and nothing is lost).
    if (!epList().length && (s.customApiBaseUrl || s.customEndpoint)) {
      const legacy = {
        id: "custom-default", name: "Custom endpoint",
        endpoint: s.customEndpoint || s.customApiBaseUrl || "",
        apiKey: s.customApiKey || "", model: s.defaultModel && !/claude|gpt|gemini/i.test(s.defaultModel) ? s.defaultModel : "",
        headers: s.customHeaders || (s.customApiKey ? "Authorization: Bearer {{apiKey}}" : "Authorization: Bearer {{apiKey}}"),
        payloadTemplate: s.customPayloadTemplate || CUSTOM_PRESETS.openai.payload,
        outputPath: s.customOutputPath || "choices[0].message.content",
      };
      saveEndpoints([legacy]);
    }

    const wrap = h("div", { class: "cust-adv" });
    wrap.append(section("Custom API endpoints", "cpu"));

    if (custEdit) { wrap.append(endpointEditor(custEdit)); return wrap; }

    // Endpoint list — each one is a selectable "model" for the Custom provider.
    const list = epList();
    if (!list.length) {
      wrap.append(h("div", { class: "hint", text: "Add one or more named API endpoints (e.g. \"Test Local LLM 5.3\"). Each becomes a selectable model when Custom is the provider — point it at any OpenAI-, Gemini- or custom-shaped API." }));
    } else {
      const rows = h("div", { class: "cust-ep-list" });
      for (const ep of list) {
        const isSel = (s.llmProvider || "anthropic") === "custom" && s.defaultModel === ep.id;
        rows.append(h("div", { class: "cust-ep-row" + (isSel ? " selected" : ""), title: "Edit this endpoint", onclick: () => { custEdit = { ...ep }; render(); } },
          h("span", { class: "cust-ep-ic", html: icon("globe", 14) }),
          h("div", { class: "cust-ep-meta" },
            h("div", { class: "cust-ep-name" }, h("span", { text: ep.name || ep.id }), isSel ? h("span", { class: "cust-ep-badge", text: "selected" }) : null),
            h("div", { class: "cust-ep-url", text: ep.endpoint || "(no URL)" })),
          h("button", { class: "cust-ep-act", title: "Edit endpoint", html: icon("edit", 14), onclick: (e) => { e.stopPropagation(); custEdit = { ...ep }; render(); } }),
          h("button", { class: "cust-ep-act", title: "Duplicate (copies the token too)", html: icon("copy", 14), onclick: (e) => {
            e.stopPropagation();
            // Clone EVERYTHING incl. the apiKey into a new draft — change a few fields and save.
            custEdit = { ...ep, id: "", name: (ep.name || ep.id) + " copy" };
            render();
          } }),
          h("button", { class: "cust-ep-act danger", title: "Delete endpoint", html: icon("trash", 14), onclick: (e) => {
            e.stopPropagation();
            confirmDialog({ title: "Delete endpoint", message: `Delete the endpoint “${ep.name || ep.id}”?`, confirmLabel: "Delete", danger: true, onConfirm: () => {
              saveEndpoints(epList().filter((x) => x.id !== ep.id)); toast("Endpoint removed"); render();
            } });
          } })));
      }
      wrap.append(rows);
    }
    wrap.append(h("button", { class: "btn btn-primary cust-ep-add", html: `${icon("plus", 14)}<span>Add endpoint</span>`,
      onclick: () => { custEdit = { id: "", name: "", endpoint: "", apiKey: "", model: "", headers: "", payloadTemplate: "", outputPath: "" }; render(); } }));
    return wrap;
  }

  // Inline editor for a single endpoint (add or edit), with presets + live Test.
  function endpointEditor(ep) {
    const wrap = h("div", { class: "cust-editor" });
    const isNew = !ep.id;

    const name = h("input", { class: "input", placeholder: "Name (e.g. Test Local LLM 5.3)", value: ep.name || "" });
    wrap.append(field("Name", name));

    const presetRow = h("div", { class: "cust-presets" }, h("span", { class: "cust-presets-l", text: "Quick start:" }));
    for (const key of ["openai", "anthropic", "gemini"]) {
      const pr = CUSTOM_PRESETS[key];
      presetRow.append(h("button", { class: "btn btn-ghost btn-sm", text: pr.label, onclick: () => {
        headers.value = pr.headers; payload.value = pr.payload; outPath.value = pr.output; toast(pr.label + " template loaded");
      } }));
    }
    wrap.append(presetRow);

    const endpoint = h("input", { class: "input", placeholder: "https://api.example.com/v1/chat/completions", value: ep.endpoint || "" });
    wrap.append(field("Endpoint URL", endpoint));

    const keyIn = h("input", { class: "input", type: "password", placeholder: ep.apiKey ? "•••••••• (set — type to replace)" : "API key (optional)" });
    const modelIn = h("input", { class: "input cust-code", placeholder: "model id sent as {{model}} (e.g. llama-5.3)", value: ep.model || "" });
    wrap.append(h("div", { class: "cust-two" }, field("API key", keyIn), field("Model ({{model}})", modelIn)));

    const headers = h("textarea", { class: "input cust-ta", rows: "2", spellcheck: "false", placeholder: "Authorization: Bearer {{apiKey}}" });
    headers.value = ep.headers || "";
    wrap.append(field("Headers — one per line, {{apiKey}} substituted", headers));

    const payload = h("textarea", { class: "input cust-ta cust-code", rows: "7", spellcheck: "false", placeholder: '{ "model": "{{model}}", "messages": [ { "role": "user", "content": "{{prompt}}" } ] }' });
    payload.value = ep.payloadTemplate || "";
    wrap.append(field("Request payload — JSON template ({{prompt}} · {{system}} · {{model}})", payload));

    // Warn (+ one-click fix) when the payload has no {{prompt}} — otherwise every
    // turn sends the same hardcoded text (the classic "pasted a curl example" trap).
    const autofixBtn = h("button", { class: "btn btn-sm cust-autofix", text: "Insert {{prompt}} automatically", onclick: () => {
      const fixed = autofixPayload(payload.value);
      if (fixed) { payload.value = fixed; checkPayload(); toast("Payload now uses {{prompt}} / {{system}}", "check"); }
      else toast("Couldn't auto-insert — put {{prompt}} where the user message text goes", "alert");
    } });
    const payloadWarn = h("div", { class: "cust-warn hidden" },
      h("span", { html: icon("alert", 13) }),
      h("span", { text: "No {{prompt}} placeholder — every turn would send the same text. Replace the user message with {{prompt}}." }),
      autofixBtn);
    wrap.append(payloadWarn);
    const checkPayload = () => { payloadWarn.classList.toggle("hidden", /\{\{\s*prompt\s*\}\}/.test(payload.value)); };
    payload.addEventListener("input", checkPayload);
    checkPayload();

    const outPath = h("input", { class: "input cust-code", placeholder: "choices[0].message.content", value: ep.outputPath || "" });
    wrap.append(field("Output path — where the reply text lives in the response", outPath));

    // Test
    const result = h("div", { class: "cust-test-result" });
    const testBtn = h("button", { class: "btn btn-ghost", html: `${icon("send", 14)}<span>Test</span>`, onclick: async () => {
      if (!endpoint.value.trim()) { toast("Enter an endpoint URL first", "alert"); return; }
      result.innerHTML = ""; result.append(h("div", { class: "cust-test-loading" }, h("span", { html: icon("spinner", 14) }), h("span", { text: "Sending a test prompt…" })));
      let r; try {
        r = await atom.providers.testCustom({ endpoint: endpoint.value.trim(), headers: headers.value, payloadTemplate: payload.value, outputPath: outPath.value.trim(),
          model: modelIn.value.trim(), apiKey: keyIn.value.trim() || ep.apiKey || "", prompt: "Reply with the single word: pong" });
      } catch (e) { result.innerHTML = ""; result.append(h("div", { class: "cust-test-err", text: String((e && e.message) || e) })); return; }
      renderTestResult(r);
    } });
    wrap.append(h("div", { class: "pm-row" }, testBtn, h("span", { class: "hint", style: "margin:0", text: "Sends one sample prompt; click a detected key to set the output path." })));
    wrap.append(result);

    // Save / Cancel
    const saveBtn = h("button", { class: "btn btn-primary", text: isNew ? "Add endpoint" : "Save", onclick: () => {
      const nm = name.value.trim();
      if (!nm) { toast("Name the endpoint first", "alert"); return; }
      if (!endpoint.value.trim()) { toast("Enter an endpoint URL", "alert"); return; }
      const list = epList().slice();
      const id = ep.id || (slugifyEp(nm) + "-" + Math.random().toString(36).slice(2, 6));
      const next = { id, name: nm, endpoint: endpoint.value.trim(),
        apiKey: keyIn.value.trim() || ep.apiKey || "", model: modelIn.value.trim(),
        headers: headers.value, payloadTemplate: payload.value, outputPath: outPath.value.trim() };
      const idx = list.findIndex((e) => e.id === id);
      if (idx >= 0) list[idx] = next; else list.push(next);
      saveEndpoints(list);
      custEdit = null; toast(isNew ? "Endpoint added" : "Endpoint saved"); render();
    } });
    const cancelBtn = h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => { custEdit = null; render(); } });
    wrap.append(h("div", { class: "pm-row cust-editor-foot" }, h("div", { class: "spacer" }), cancelBtn, saveBtn));

    function renderTestResult(r) {
      result.innerHTML = "";
      const okExtract = r.ok && r.text;
      result.append(h("div", { class: "cust-test-head" },
        h("span", { class: "status-pill " + (r.status >= 200 && r.status < 300 ? "ok" : "bad") }, h("span", { class: "dot" }), r.status ? ("HTTP " + r.status) : "No response"),
        okExtract ? h("span", { class: "cust-test-ok", text: r.usedPath ? ("captured via " + r.usedPath) : "captured" }) : null));
      if (r.error && !okExtract) result.append(h("div", { class: "cust-test-err", text: r.error }));
      if (okExtract) {
        result.append(h("div", { class: "cust-test-label", text: "Captured output" }));
        result.append(h("div", { class: "cust-test-output", text: r.text.length > 600 ? r.text.slice(0, 600) + "…" : r.text }));
      }
      if (r.candidates && r.candidates.length) {
        result.append(h("div", { class: "cust-test-label", text: "Detected text keys — click to use as the output path" }));
        const chips = h("div", { class: "cust-keys" });
        for (const c of r.candidates.slice(0, 12)) {
          chips.append(h("button", { class: "cust-key" + (c.path === outPath.value.trim() ? " active" : ""), title: c.sample,
            onclick: () => { outPath.value = c.path; renderTestResult(r); toast("Output path set to " + c.path); } },
            h("span", { class: "cust-key-path", text: c.path }),
            h("span", { class: "cust-key-sample", text: c.sample })));
        }
        result.append(chips);
      }
      if (r.raw) {
        const pre = h("pre", { class: "cust-test-raw", text: prettyJson(r.raw) });
        result.append(h("details", { class: "cust-test-details" }, h("summary", { text: "Raw response" }), pre));
      }
    }
    function prettyJson(str) { try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; } }

    return wrap;
  }

  await render();
  backRef = modalShell({ title: p.name, ic: p.icon || "globe", body, footer: [h("button", { class: "btn btn-primary", text: "Done", onclick: () => closeModal(backRef) })] });
}

function field(label, control, hint) {
  return h("div", { class: "field" }, h("label", { text: label }), control, hint ? h("div", { class: "hint", text: hint }) : null);
}
function section(label, ic) {
  return h("div", { class: "set-section" }, ic ? h("span", { html: icon(ic, 14) }) : null, h("span", { text: label }));
}
function segmented(values, current, onPick, labels = {}) {
  const seg = h("div", { class: "segmented" });
  const buttons = new Map();
  for (const v of values) {
    const btn = h("button", { class: current === v ? "active" : "", text: labels[v] || v, onclick: () => {
      buttons.forEach((b, key) => b.classList.toggle("active", key === v));
      onPick(v);
    } });
    buttons.set(v, btn);
    seg.append(btn);
  }
  return seg;
}
function inlineSelect(items, current, onPick) {
  const wrap = h("div", { class: "segmented", style: "flex-wrap:wrap" });
  const draw = (cur) => {
    wrap.innerHTML = "";
    for (const it of items) wrap.append(h("button", { class: it.id === cur ? "active" : "", text: it.name, onclick: () => { onPick(it.id); draw(it.id); } }));
  };
  draw(current);
  return wrap;
}

/* ============================================================
   CONFIRM DIALOG
   ============================================================ */
/* Dialog contract (shared by every caller, Git Center included): each dialog RETURNS
 * a Promise that settles exactly once on every close path — confirm, Cancel, ×,
 * backdrop, Escape. `onConfirm` / `onCancel` callbacks are still honoured for the
 * older call sites. confirmDialog → boolean · promptDialog → string | null ·
 * chooseDialog → choice value | null. */
function confirmDialog({ title, message, confirmLabel = "Confirm", danger, ic, onConfirm, onCancel }) {
  return new Promise((resolve) => {
    let result = false, done = false;
    const finish = () => { if (done) return; done = true; resolve(result); try { if (result) { if (onConfirm) onConfirm(); } else if (onCancel) onCancel(); } catch (e) { console.error(e); } };
    const back = modalShell({
      title, ic: ic || (danger ? "alert" : "check"),
      body: h("div", { style: "color:var(--text-2); line-height:1.6; font-size:13.5px", text: message }),
      footer: [
        h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => closeModal(back) }),
        h("button", { class: "btn " + (danger ? "btn-danger" : "btn-primary"), text: confirmLabel, onclick: () => { result = true; closeModal(back); } }),
      ],
    });
    back.addEventListener("modal-closed", finish);
  });
}

// A small single-line text-input dialog (e.g. "New branch…"). Enter confirms; any dismissal → null.
function promptDialog({ title, ic = "edit", message, placeholder = "", value = "", confirmLabel = "OK", onConfirm, onCancel }) {
  return new Promise((resolve) => {
    let result = null, done = false;
    const finish = () => { if (done) return; done = true; resolve(result); try { if (result != null) { if (onConfirm) onConfirm(result); } else if (onCancel) onCancel(); } catch (e) { console.error(e); } };
    const input = h("input", { class: "prompt-input", type: "text", placeholder, value, spellcheck: "false", "aria-label": title || placeholder || "Value" });
    const submit = () => { result = input.value; closeModal(back); };
    const back = modalShell({
      title, ic,
      body: h("div", {},
        message ? h("div", { style: "color:var(--text-2);line-height:1.6;font-size:13px;margin-bottom:9px", text: message }) : null,
        input),
      footer: [
        h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => closeModal(back) }),
        h("button", { class: "btn btn-primary", text: confirmLabel, onclick: submit }),
      ],
    });
    back.addEventListener("modal-closed", finish);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    setTimeout(() => { if (back.isConnected) { input.focus(); input.select(); } }, 30);
  });
}

/* ============================================================
   KEYS + RESIZERS
   ============================================================ */
function wireGlobalKeys() {
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;

    // Modal/dialog keys take priority: Enter confirms (the primary/OK button),
    // Esc closes (cancel). Skips Enter when typing in a text field.
    const backs = document.querySelectorAll("#modalRoot .modal-backdrop");
    const top = backs[backs.length - 1];
    if (top) {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        const closeBtn = top.querySelector(".mh-close");
        if (closeBtn) closeBtn.click(); else closeModal(top);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !mod) {
        const t = e.target, inModal = !!(t && top.contains(t)), tag = ((t && t.tagName) || "").toLowerCase(), type = ((t && t.type) || "").toLowerCase();
        // Only let a focused control swallow Enter when it's INSIDE the dialog —
        // otherwise the element that opened the modal (e.g. the titlebar Close
        // button) would re-fire instead of confirming.
        const typing = inModal && (tag === "textarea" || (tag === "input" && !["checkbox", "radio", "button", "submit"].includes(type)));
        const onControl = inModal && (tag === "button" || tag === "a" || tag === "select");
        if (!typing && !onControl) {
          const primary = top.querySelector(".modal-foot .btn-primary, .modal-foot .btn-danger");
          if (primary) { e.preventDefault(); primary.click(); return; }
        }
      }
    }

    if (e.altKey && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight") && state.editor.active && state.findContext === "editor") { e.preventDefault(); navGo(e.key === "ArrowLeft" ? -1 : 1); return; }
    if (e.shiftKey && e.key === "F12") { e.preventDefault(); if (state.editor.active) editorFindReferences(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === "v") { e.preventDefault(); toggleMarkdownPreview(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); if (state.editor.active) openSymbolPicker(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === "m") { e.preventDefault(); if (state.editor.active) toggleProblems(); }
    else if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); handleFind(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); const mf = $("modelFilter"); openPromptPicker(mf ? mf.querySelector(".mf-prompts") : null); }
    else if (mod && e.key.toLowerCase() === "p") { e.preventDefault(); pickAndOpenProject(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === "s") { e.preventDefault(); const af = stateActiveFile(); if (af) saveEditorAs(af); }
    else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (state.editor.active) saveEditorFile(state.editor.active); }
    else if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newUntitledFile(); }
    else if (mod && e.key.toLowerCase() === "t") { e.preventDefault(); newTab(); }
    else if (mod && e.key.toLowerCase() === "w") {
      e.preventDefault();
      if (state.editor.active) closeEditorFile(state.editor.active);
      else if (state.activeTabId) closeTab(state.activeTabId);
    }
    else if (mod && e.key.toLowerCase() === "r") { e.preventDefault(); } // block page reload; editor handles redo itself
    else if (mod && e.key === ",") { e.preventDefault(); openSettings(); }
    else if (mod && e.key.toLowerCase() === "h") { e.preventDefault(); openHistory(); }
    else if (mod && e.key === "\\") { e.preventDefault(); if (cm && cm.view.hasFocus && stateActiveFile()) toggleSplit(); else toggleChat(); }
    else if (mod && e.key === "`") { e.preventDefault(); toggleTerminal(); }
    else if (mod && e.key === "Tab") { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") {
      hideContextMenu();
      const ts = activeTS();
      if (ts && ts.meta.status === "running") stopSession(ts.meta.id);
    }
  });
}
function cycleTab(dir) {
  const i = state.order.indexOf(state.activeTabId);
  const n = (i + dir + state.order.length) % state.order.length;
  switchTab(state.order[n]);
}

function wireResizers() {
  makeResizer($("sidebarResizer"), (dx) => {
    const w = Math.max(200, Math.min(460, parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w")) + dx));
    document.documentElement.style.setProperty("--sidebar-w", w + "px");
  });
  makeResizer($("editorResizer"), (dx) => {
    const w = Math.max(320, Math.min(window.innerWidth - 560, parseInt(getComputedStyle(document.documentElement).getPropertyValue("--editor-w")) + dx));
    document.documentElement.style.setProperty("--editor-w", w + "px");
    computeEditorOverflow();
  });
  window.addEventListener("resize", () => { computeEditorOverflow(); computeSessionOverflow(); updateScrollBtn(); });
  makeResizer($("changesResizer"), (dx) => {
    const w = Math.max(240, Math.min(520, parseInt(getComputedStyle(document.documentElement).getPropertyValue("--changes-w")) - dx));
    document.documentElement.style.setProperty("--changes-w", w + "px");
  });
}
function makeResizer(el, onMove) {
  if (!el) return;
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    let last = e.clientX;
    const move = (ev) => { onMove(ev.clientX - last); last = ev.clientX; };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); document.body.style.cursor = ""; };
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

/* ============================================================
   CODE EDITOR (CodeMirror 6 — see src/renderer/editor/cm-src.js)
   ============================================================ */
function langOf(p) { return (p.split(".").pop() || "").toLowerCase(); }
function escHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
// Image files open in the in-editor previewer (SVG stays editable text).
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const MD_EXTS = new Set(["md", "markdown", "mdx"]);

function stateActiveFile() { return state.editor.open.find((x) => x.path === state.editor.active); }

function activateEditorFile(filePath) {
  if (!state.editor.open.find((f) => f.path === filePath)) return;
  const idx = state.editor.focused;
  if (state.editor.panes[idx] === filePath) return;
  // Already shown in the other pane → just move focus there (no second copy).
  const other = idx === 0 ? 1 : 0;
  if (state.editor.split && state.editor.panes[other] === filePath) { focusPane(other); persistEditor(); return; }
  // Remember the outgoing pane file's scroll + folds + live text before swapping.
  if (editors[idx]) { const cur = paneFile(idx); if (cur) { cur.scrollTop = editors[idx].getScrollTop(); cur.folds = editors[idx].getFolds(); syncFileContent(cur, editors[idx]); } }
  const target = state.editor.open.find((f) => f.path === filePath);
  const wasImage = !!$("editorBody").querySelector(".img-view");
  state.editor.panes[idx] = filePath;
  state.editor.active = filePath;          // keep the tab order; activation never reorders
  // Crossing an image↔code boundary needs a full re-render (image branch re-attaches editors).
  if ((target && target.kind === "image") || wasImage) { renderEditorTabs(); renderEditor(); highlightTreeFile(); persistEditor(); return; }
  relinkPanes();                           // unlink before swapping the doc
  loadPaneFile(idx, true);
  relinkPanes();                           // relink if now the same file as the other pane
  renderEditorTabs();
  highlightTreeFile();
  persistEditor();
}

/* ---------------- Untitled buffers ------------------------------------------
 * Ctrl+N gives you somewhere to type before you have decided where it belongs —
 * a tab with no file behind it. The path is a scheme, not a location, so nothing
 * that walks the filesystem (git gutter, the language service, the tree, session
 * restore) can mistake the buffer for something on disk. It becomes a real file
 * only when you say where, at which point the tab is reopened from that path so
 * language, gutter and diagnostics all arrive with it.
 */
const UNTITLED = "untitled:";
function isUntitled(p) { return typeof p === "string" && p.startsWith(UNTITLED); }
let _untitledSeq = 0;

function newUntitledFile() {
  let name, path;
  do { name = `Untitled-${++_untitledSeq}`; path = UNTITLED + name; }
  while (state.editor.open.some((f) => f.path === path));
  state.findContext = "editor";
  // Same hand-off as opening a real file: the outgoing pane keeps its place.
  const fidx = state.editor.focused;
  if (editors[fidx]) { const cur = paneFile(fidx); if (cur) { cur.scrollTop = editors[fidx].getScrollTop(); cur.folds = editors[fidx].getFolds(); syncFileContent(cur, editors[fidx]); } }
  state.editor.open.push({ path, name, content: "", saved: "", dirty: false, lang: "", scrollTop: 0, eol: "lf", untitled: true });
  state.editor.panes[fidx] = path;
  state.editor.active = path;
  updateEditorLayout();
  highlightTreeFile();
  persistEditor();
  focusEditorSoon();
}

/* Put the cursor in the editor once there is one. The first editor surface in a
 * session loads CodeMirror on demand, so the pane can be several frames away —
 * focusing on the next frame would focus nothing at all. */
function focusEditorSoon(tries = 60) {
  const ed = editors[state.editor.focused] || cm;
  if (ed) { ed.focus(); return; }
  if (tries > 0) requestAnimationFrame(() => focusEditorSoon(tries - 1));
}

/* Ask where a buffer should go and write it there. Returns the chosen path, or
 * null when the user backs out of the picker. Used both for a scratch tab that
 * has never had a path and for Save As on a file that has one. */
async function promptWriteBufferTo(f) {
  for (let p = 0; p < 2; p++) if (state.editor.panes[p] === f.path && editors[p]) { syncFileContent(f, editors[p]); break; }
  const dir = (state.project || "").replace(/[\\/]+$/, "");
  const suggest = f.untitled ? (dir ? dir + "\\" + f.name : f.name) : f.path;
  // Written with the file's own line endings, the same as an ordinary save.
  const body = f.eol === "crlf" ? f.content.replace(/\r?\n/g, "\r\n") : f.content;
  let res;
  try { res = await atom.files.saveAs({ defaultPath: suggest, content: body }); }
  catch (e) { toast("Save failed: " + e.message, "alert"); return null; }
  if (!res || res.canceled || !res.path) return null;
  return res.path;
}

/* Write the buffer somewhere and keep editing it THERE — reopened from the new
 * path, so syntax, git gutter and diagnostics all arrive with the extension. */
async function saveEditorAs(f) {
  if (!f || f.kind === "image") return false;
  const written = await promptWriteBufferTo(f);
  if (!written) return false;
  const pane = state.editor.panes.indexOf(f.path);
  dropEditorFile(f.path);
  // Saving onto a path that is already open would otherwise leave that tab
  // showing what the file used to contain.
  if (state.editor.open.some((x) => samePath(x.path, written))) dropEditorFile(written);
  if (pane >= 0 && state.editor.split) state.editor.focused = pane;
  await openInEditor(written);
  return true;
}

async function openInEditor(filePath, quiet) {
  state.findContext = "editor";
  if (state.editor.open.find((f) => f.path === filePath)) { activateEditorFile(filePath); return; }
  // Remember the outgoing focused-pane file's folds + live text before swapping.
  const fidx = state.editor.focused;
  if (editors[fidx]) { const cur = paneFile(fidx); if (cur) { cur.scrollTop = editors[fidx].getScrollTop(); cur.folds = editors[fidx].getFolds(); syncFileContent(cur, editors[fidx]); } }
  // Image files → in-editor preview (no document/CM, no disk read of bytes here).
  if (IMAGE_EXTS.has(langOf(filePath))) {
    state.editor.open.push({ path: filePath, name: baseName(filePath), content: "", saved: "", dirty: false, lang: langOf(filePath), scrollTop: 0, eol: "lf", kind: "image" });
    state.editor.panes[fidx] = filePath;
    state.editor.active = filePath;
    updateEditorLayout();
    highlightTreeFile();
    persistEditor();
    return;
  }
  const data = await atom.files.read(filePath).catch((e) => ({ error: String(e) }));
  if (data.error) { if (!quiet) toast("Cannot open: " + data.error, "alert"); return; }
  if (data.tooLarge) { if (!quiet) toast("File too large to open in editor", "alert"); return; }
  if (data.isBinary) { if (!quiet) { toast("Binary file — opening externally"); atom.files.open(filePath); } return; }
  // Normalise to LF so the editor document, dirty-tracking and offsets all agree
  // (CRLF would otherwise drift between the on-disk bytes and CodeMirror's doc).
  const content = (data.content || "").replace(/\r\n/g, "\n");
  const eol = /\r\n/.test(data.content || "") ? "crlf" : "lf";   // detect line ending before normalising
  state.editor.open.push({ path: filePath, name: baseName(filePath), content, saved: content, dirty: false, lang: langOf(filePath), scrollTop: 0, eol });  // new files open at the end
  state.editor.panes[fidx] = filePath;     // the new file lands in the focused pane
  state.editor.active = filePath;
  updateEditorLayout();
  highlightTreeFile();
  persistEditor();
}

function updateEditorLayout() {
  const has = state.editor.open.length > 0;
  $("editorPane").classList.toggle("hidden", !has);
  $("editorResizer").classList.toggle("hidden", !has);
  renderEditorTabs();
  renderEditor();   // handles both the populated and the empty (destroy editors) states
}

let _prevTabPaths = new Set();
function renderEditorTabs() {
  const host = $("editorTabs");
  host.innerHTML = "";
  const scroll = h("div", { class: "et-scroll" });
  const nowPaths = new Set(state.editor.open.map((f) => f.path));
  for (const f of state.editor.open) {
    scroll.append(h("div", Object.assign({
      class: "editor-tab" + (f.path === state.editor.active ? " active" : "") + (_prevTabPaths.size && !_prevTabPaths.has(f.path) ? " et-enter" : ""),
      dataset: { path: f.path },
      title: f.untitled ? `${f.name} — not saved yet` : f.path,
      onclick: () => activateEditorFile(f.path),
      oncontextmenu: (ev) => { ev.preventDefault(); editorTabContextMenu(ev, f); },
      onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeEditorFile(f.path); } },
    }, dragProps(f.path, reorderEditorTabs)),
      (function () { const m = fileMeta(f.name); return h("span", { class: "et-ico " + m.cls, html: icon(m.ic, 13) }); })(),
      h("span", { class: "et-name " + fileMeta(f.name).cls, text: f.name }),
      f.dirty ? h("span", { class: "et-dirty" }) : null,
      h("button", { class: "et-x", html: icon("close", 12), onclick: (e) => { e.stopPropagation(); closeEditorFile(f.path); } })));
  }
  host.append(scroll);
  const ov = h("button", { class: "et-overflow hidden", title: "Hidden tabs", onclick: (e) => editorOverflowMenu(e) },
    h("span", { html: icon("chevronDown", 16) }),
    h("span", { class: "et-badge hidden" }));
  host.append(ov);
  // Split controls: toggle split, and (when split) flip orientation.
  if (state.editor.split) {
    host.append(h("button", { class: "et-split", title: "Switch split orientation", html: icon(state.editor.splitDir === "h" ? "splitV" : "splitH", 15), onclick: toggleSplitOrientation }));
  }
  host.append(h("button", { class: "et-split" + (state.editor.split ? " active" : ""), title: state.editor.split ? "Close split (Ctrl+\\)" : "Split editor (Ctrl+\\)", html: icon(state.editor.splitDir === "h" ? "splitH" : "splitV", 15), onclick: toggleSplit }));
  const af = stateActiveFile();
  if (af && MD_EXTS.has((af.lang || "").toLowerCase())) {
    host.append(h("button", { class: "et-split" + (state.editor.mdPreview ? " active" : ""), title: "Toggle Markdown preview (Ctrl+Shift+V)", html: icon("eye", 15), onclick: toggleMarkdownPreview }));
  }
  _prevTabPaths = nowPaths;   // newly-opened tabs animate in on the next render
  requestAnimationFrame(computeEditorOverflow);
}

// Hide tabs that don't fit the visible width; the overflow button lists them.
// The active tab is always kept visible (shown as the last visible one).
function computeEditorOverflow() {
  const host = $("editorTabs");
  if (!host) return;
  const scroll = host.querySelector(".et-scroll");
  const ov = host.querySelector(".et-overflow");
  if (!scroll || !ov) return;
  const tabs = [...scroll.querySelectorAll(".editor-tab")];
  tabs.forEach((t) => t.classList.remove("et-hidden"));
  ov.classList.add("hidden");
  ov._hidden = [];
  if (tabs.length <= 1) return;
  // Width actually available to the tab strip. host.clientWidth is the WHOLE
  // header — it includes the padding and the trailing controls (split, split
  // orientation, Markdown preview, overflow), none of which live inside
  // .et-scroll. Measuring against it over-allocated by 36–100px, so the last tab
  // was rendered past the edge and .et-scroll{overflow:hidden} clipped it — which
  // is why its close button disappeared once a second tab opened.
  const cs = getComputedStyle(host);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const trailing = [...host.children]
    .filter((c) => c !== scroll && !c.classList.contains("et-overflow"))
    .reduce((s, c) => s + c.offsetWidth, 0);
  const avail = Math.max(0, host.clientWidth - padX - trailing);
  const widths = new Map(tabs.map((t) => [t, t.offsetWidth]));
  const total = tabs.reduce((s, t) => s + widths.get(t), 0);
  if (total <= avail) return;                 // everything fits
  const reserve = 38;                         // room for the overflow button (34px + slack)
  const hidden = [];
  let used = 0;
  for (const t of tabs) {
    const w = widths.get(t);
    if (used + w <= avail - reserve) used += w;
    else { t.classList.add("et-hidden"); hidden.push(t.dataset.path); }
  }
  // Keep the active tab visible — if it got hidden, show it and drop visible
  // tabs from the right until it fits.
  const active = state.editor.active;
  if (active && hidden.includes(active)) {
    const aEl = tabs.find((t) => t.dataset.path === active);
    aEl.classList.remove("et-hidden");
    hidden.splice(hidden.indexOf(active), 1);
    let w2 = tabs.filter((t) => !t.classList.contains("et-hidden")).reduce((s, t) => s + widths.get(t), 0);
    const vis = tabs.filter((t) => !t.classList.contains("et-hidden") && t.dataset.path !== active);
    for (let i = vis.length - 1; i >= 0 && w2 > avail - reserve; i--) {
      vis[i].classList.add("et-hidden"); w2 -= widths.get(vis[i]); hidden.push(vis[i].dataset.path);
    }
  }
  if (!hidden.length) return;
  ov.classList.remove("hidden");
  ov._hidden = hidden;
  const badge = ov.querySelector(".et-badge");
  badge.textContent = String(hidden.length);
  badge.classList.remove("hidden");
}

// Bring a hidden tab into view: move it to the end of the strip so it becomes
// the last visible tab (not the first), then activate it. Since the active tab
// is always kept visible, it ends up as the rightmost visible one.
function revealEditorTab(path) {
  const arr = state.editor.open;
  const from = arr.findIndex((f) => f.path === path);
  if (from < 0) { activateEditorFile(path); return; }
  const [it] = arr.splice(from, 1);
  arr.push(it);
  activateEditorFile(path);   // sets active + renders + persists
}

// Dropdown listing the tabs that don't fit. Each row reveals (→ last visible)
// or closes that file.
function editorOverflowMenu(e) {
  const ov = e.currentTarget;
  closeEtMenu();
  hideContextMenu();
  const menu = h("div", { class: "et-menu" });
  document.body.append(menu);
  const position = () => {
    // Re-find the overflow button on every call — `closeEditorFile` triggers
    // a renderEditorTabs() that detaches the original `ov` reference, and a
    // detached node's getBoundingClientRect() returns all zeros, slamming the
    // menu into the top-left corner.
    const live = document.querySelector("#editorTabs .et-overflow") || ov;
    const r = live.getBoundingClientRect();
    if (!r.width && !r.height) return;   // not on screen yet — try again next frame
    menu.style.top = (r.bottom + 4) + "px";
    menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + "px";
  };
  // (re)build rows from the CURRENTLY-hidden tabs only; closing one stays open.
  function build() {
    const files = (ov._hidden || []).map((p) => state.editor.open.find((f) => f.path === p)).filter(Boolean);
    if (!files.length) { closeEtMenu(); return; }
    menu.innerHTML = "";
    for (const f of files) {
      const fm = fileMeta(f.name);
      menu.append(h("div", { class: "et-menu-row" + (f.path === state.editor.active ? " active" : ""), onclick: () => { closeEtMenu(); revealEditorTab(f.path); } },
        h("span", { class: "et-ico " + fm.cls, html: icon(fm.ic, 13) }),
        h("span", { class: "et-menu-name " + fm.cls, text: f.name, title: f.path }),
        f.dirty ? h("span", { class: "et-dirty" }) : null,
        h("button", { class: "et-menu-x", title: "Close", html: icon("close", 12), onclick: (ev) => { ev.stopPropagation(); closeEditorFile(f.path); requestAnimationFrame(() => { computeEditorOverflow(); build(); }); } })));
    }
    position();
  }
  build();
  if (!document.querySelector(".et-menu")) return;   // nothing hidden → already closed
  setTimeout(() => document.addEventListener("mousedown", etMenuOutside, true), 0);
}
function closeEtMenu() { const m = document.querySelector(".et-menu"); if (m) m.remove(); document.removeEventListener("mousedown", etMenuOutside, true); }
function etMenuOutside(e) { const m = document.querySelector(".et-menu"); if (m && !m.contains(e.target)) closeEtMenu(); }

// CodeMirror 6 editors, one per pane. `cm` always aliases the FOCUSED pane's
// editor so the ~100 existing `cm.*`/`stateActiveFile()` call sites keep working
// (commands act on the focused pane). The second pane only exists while split.
let cm = null;
const editors = [null, null];   // editors[paneIdx]

function paneFile(idx) { const p = state.editor.panes[idx]; return p ? state.editor.open.find((f) => f.path === p) : null; }

// Build the createEditor options for a given pane. Pane-fired callbacks
// (change/cursor/scroll/save/goto) resolve THAT pane's file; command callbacks
// (quick-fix/rename/format/go-to-line) act on the focused pane via cm.
function editorOptsFor(idx) {
  return {
    sticky: !!state.settings.editorStickyScroll,
    lint: state.settings.editorLint !== false,
    semantic: state.settings.editorSemantic !== false,
    highlight: state.settings.editorHighlight !== false,
    // Semantic diagnostics: JS/TS via the TypeScript service, everything else
    // via an LSP server (Python/Go/Rust/C++/PHP…), both in the main process.
    semanticProvider: (text) => {
      const af = paneFile(idx);
      if (!af) return Promise.resolve([]);
      const lang = (af.lang || "").toLowerCase(), root = tsRootFor(af);
      if (TS_LANGS.has(lang)) return atom.ts.diagnose(root, af.path, text).catch(() => []);
      if (LSP_EXTS.has(lang) && atom.lsp) return atom.lsp.diagnose(root, lang, af.path, text).catch(() => []);
      return Promise.resolve([]);
    },
    // On-demand language requests (completion, hover, signature, format, …).
    tsRequest: (kind, payload) => {
      const af = paneFile(idx);
      if (!af) return Promise.resolve(null);
      const lang = (af.lang || "").toLowerCase(), root = tsRootFor(af);
      if (TS_LANGS.has(lang) && atom.ts) return atom.ts.req(kind, root, af.path, payload).catch(() => null);
      if (LSP_EXTS.has(lang) && atom.lsp) return atom.lsp.req(kind, root, lang, af.path, payload).catch(() => null);
      return Promise.resolve(null);
    },
    semanticLangs: SEMANTIC_EXTS,
    onQuickFix: (from, to) => editorQuickFix(from, to),
    onRename: (pos) => editorRename(pos),
    onFormat: () => editorFormat(),
    wrap: !!state.settings.editorWordWrap,
    bracketColors: state.settings.editorBracketColors !== false,
    whitespace: !!state.settings.editorRenderWhitespace,
    inlayHints: !!state.settings.editorInlayHints,
    indentGuides: !!state.settings.editorIndentGuides,
    onGoToLine: () => editorGoToLinePrompt(),
    onDiagnostics: () => { if (idx === state.editor.focused) onEditorDiagnostics(); },
    onChange: () => onCmChange(idx),
    onCursor: (line, col) => { if (idx === state.editor.focused) scheduleCursorUI(idx, line, col); },
    onScroll: (top) => { const af = paneFile(idx); if (af) af.scrollTop = top; },
    onSave: () => { const af = paneFile(idx); if (af) saveEditorFile(af.path); },
    onGotoDef: (pos) => { const af = paneFile(idx); if (af) editorGotoDefinition(af, pos); },
    onContextMenu: (x, y) => editorCtxMenu(x, y),
  };
}

// Make pane `idx` the focused one — `cm`, the active file, the tab highlight and
// the status bar all follow it.
function focusPane(idx) {
  if (!editors[idx]) return;
  state.editor.focused = idx;
  cm = editors[idx];
  state.editor.active = state.editor.panes[idx];
  state.findContext = "editor";
  updatePaneFocusUI();
  renderEditorTabs();
  const f = paneFile(idx); if (f) updateEditorStatus(f);
  highlightTreeFile();
  onEditorDiagnostics();
}

function updatePaneFocusUI() {
  const body = $("editorBody");
  if (!body) return;
  [...body.querySelectorAll(".epane")].forEach((el, i) => el.classList.toggle("is-focused", state.editor.split && i === state.editor.focused));
}

// Same file in both panes ⇒ link them so edits live-sync (independent scroll/
// cursor/folds). Otherwise unlink. Docs are identical when linked, by construction.
function relinkPanes() {
  if (editors[0] && editors[0].unlinkPeer) editors[0].unlinkPeer();
  if (editors[1] && editors[1].unlinkPeer) editors[1].unlinkPeer();
  if (state.editor.split && editors[0] && editors[1] &&
      state.editor.panes[0] && state.editor.panes[0] === state.editor.panes[1]) {
    editors[0].linkPeer(editors[1]);
    editors[1].linkPeer(editors[0]);
  }
}

// Load pane idx's target file into its editor (idempotent — tracks the loaded
// path so re-renders don't reset scroll). Restores scroll + folds.
function loadPaneFile(idx, force) {
  const ed = editors[idx];
  if (!ed) return;
  const f = paneFile(idx);
  if (!f) { ed.setDoc("", ""); ed._loaded = null; return; }
  if (!force && ed._loaded === f.path) return;
  ed._loaded = f.path;
  // Replacing the doc ourselves (opening a file, or refreshing one the agent just
  // edited on disk) is not a user edit. Flag it so onCmChange doesn't light up the
  // tab's unsaved dot — CodeMirror reports a programmatic setDoc as a doc change
  // exactly like typing. Dispatch is synchronous, so the flag brackets it.
  _programmaticDoc++;
  try { ed.setDoc(f.content, f.lang); } finally { _programmaticDoc--; }
  requestAnimationFrame(() => { if (editors[idx] === ed) { ed.setScrollTop(f.scrollTop || 0); if (f.folds && f.folds.length) ed.setFolds(f.folds); } });
  applyEditorConfig(f, ed);
  gitGutterFor(ed, f);
  if (idx === state.editor.focused) { state.editor.diags = []; setTimeout(() => onEditorDiagnostics(), 700); scheduleSymbolRefresh(); }
}

// Build (or rebuild) the pane DOM. Existing editor .dom nodes are re-attached
// rather than recreated, so split/unsplit/orientation toggles never lose state.
function renderEditor() {
  const body = $("editorBody");
  if (!stateActiveFile()) {
    for (let i = 0; i < 2; i++) if (editors[i]) { editors[i].destroy(); editors[i] = null; }
    cm = null; state.editor.split = false; state.editor.panes = [null, null]; state.editor.focused = 0;
    body.innerHTML = "";
    body.append(h("div", { class: "editor-empty" }, h("span", { class: "ee-mark", html: icon("fileCode", 54) }), h("p", { text: "No file open" })));
    $("editorStatus").innerHTML = "";
    return;
  }
  // Image files render in the previewer, not CodeMirror (editors are kept alive,
  // just detached, so switching back to a code file is instant).
  if (stateActiveFile().kind === "image") {
    for (const ed of editors) if (ed && ed.dom.parentNode) ed.dom.parentNode.removeChild(ed.dom);
    body.classList.remove("is-split", "split-h");
    renderImageView(body, stateActiveFile());
    renderBreadcrumbs();
    updateEditorStatus(stateActiveFile(), 1, 1);
    return;
  }
  if (!state.editor.panes[0]) state.editor.panes[0] = state.editor.active;
  // First editor surface in this session → load CodeMirror on demand, then re-render.
  if (!createEditor) {
    body.innerHTML = "";
    body.append(h("div", { class: "editor-empty" }, h("span", { class: "ee-mark spin", html: icon("spinner", 40) }), h("p", { text: "Loading editor…" })));
    ensureCmModule().then(() => { if (stateActiveFile()) renderEditor(); });
    return;
  }
  body.classList.toggle("is-split", !!state.editor.split);
  body.classList.toggle("split-h", !!state.editor.split && state.editor.splitDir === "h");
  // Detach existing editor DOM (keeps the views alive) before rebuilding hosts.
  for (const ed of editors) if (ed && ed.dom.parentNode) ed.dom.parentNode.removeChild(ed.dom);
  body.innerHTML = "";

  ensurePane(0, body);
  if (state.editor.split) {
    body.append(h("div", { class: "epane-div", title: "Drag to resize", onmousedown: startPaneResize }));
    ensurePane(1, body);
  } else if (editors[1]) {
    editors[1].destroy(); editors[1] = null; state.editor.panes[1] = null;
  }

  cm = editors[state.editor.focused] || editors[0];
  updatePaneFocusUI();
  relinkPanes();
  for (const ed of editors) if (ed) ed.remeasure();
  const ff = paneFile(state.editor.focused); if (ff) updateEditorStatus(ff);
  renderMarkdownPreview();   // sync/remove the md overlay for the active file
}

// Create pane idx's editor inside a fresh host (or re-attach the existing one).
function ensurePane(idx, body) {
  const host = h("div", { class: "epane" + (state.editor.split && idx === state.editor.focused ? " is-focused" : "") });
  body.append(host);
  if (!editors[idx]) {
    const f = paneFile(idx) || stateActiveFile();
    editors[idx] = createEditor(host, Object.assign(editorOptsFor(idx), { doc: (f && f.content) || "", lang: (f && f.lang) || "" }));
    editors[idx]._loaded = f ? f.path : null;
    editors[idx].view.contentDOM.addEventListener("focus", () => focusPane(idx));
    loadPaneFile(idx, true);
  } else {
    host.append(editors[idx].dom);
    loadPaneFile(idx);
    const f = paneFile(idx);   // re-attaching the DOM can reset scroll — restore it
    if (f) requestAnimationFrame(() => { if (editors[idx]) editors[idx].setScrollTop(f.scrollTop || 0); });
  }
}

// Render an image file in #editorBody (data URL from main; capped size).
async function renderImageView(body, f) {
  body.innerHTML = "";
  const img = h("img", { class: "img-preview", alt: f.name });
  const meta = h("div", { class: "img-meta", text: "Loading…" });
  body.append(h("div", { class: "img-view" }, img, meta));
  const d = await atom.files.dataUrl(f.path).catch(() => null);
  if (stateActiveFile() !== f) return;   // switched away while loading
  if (d && d.dataUrl) {
    img.src = d.dataUrl;
    img.onload = () => { meta.textContent = `${img.naturalWidth} × ${img.naturalHeight}  ·  ${(d.size / 1024).toFixed(1)} KB`; };
  } else { meta.textContent = "Can't preview this image (too large or unreadable)."; }
}

// Markdown preview overlay (Ctrl+Shift+V) — rendered HTML over the editor body.
function toggleMarkdownPreview() {
  const f = stateActiveFile();
  if (!f || !MD_EXTS.has((f.lang || "").toLowerCase())) return;
  state.editor.mdPreview = !state.editor.mdPreview;
  renderMarkdownPreview();
  renderEditorTabs();
}
function renderMarkdownPreview() {
  const body = $("editorBody");
  if (!body) return;
  let layer = document.getElementById("mdPreview");
  const f = stateActiveFile();
  const on = state.editor.mdPreview && f && MD_EXTS.has((f.lang || "").toLowerCase());
  if (!on) { if (layer) layer.remove(); return; }
  if (!layer) {
    layer = h("div", { id: "mdPreview", class: "md-preview" });
    layer.addEventListener("click", onMdPreviewClick);
    layer.addEventListener("contextmenu", onMdPreviewContext);
    body.appendChild(layer);
  }
  const text = (cm && cm.docText()) || f.content || "";
  // This re-renders on every keystroke; without this the reader is thrown back
  // to the top of the document each time a character is typed.
  const keepScroll = layer.scrollTop;
  layer.innerHTML = "";
  /* `bubble` is the class the conversation renders markdown into. Sharing it is
   * the point: the preview then cannot drift from how the agent panel looks, and
   * it is also what makes the text selectable — the app sets user-select:none
   * globally and .bubble is where that is deliberately turned back on. */
  const doc = h("div", { class: "md-preview-body bubble", html: renderMarkdown(text, { images: true, localLinks: true }) });
  layer.append(mdPreviewBar(f, text), doc);
  resolveMdImages(doc, mdBaseDir(f));
  layer.scrollTop = keepScroll;
}

// The folder a preview's relative links and images resolve against.
function mdBaseDir(f) {
  if (!f || f.untitled) return state.project || "";
  return f.path.replace(/[\\/][^\\/]*$/, "");
}
function mdResolve(base, rel) {
  const r = String(rel || "").replace(/^\.\//, "");
  if (/^[a-zA-Z]:[\\/]/.test(r) || r.startsWith("/")) return r;   // already absolute
  let dir = base;
  let rest = r;
  while (/^\.\.[\\/]/.test(rest)) { dir = dir.replace(/[\\/][^\\/]*$/, ""); rest = rest.slice(3); }
  return dir ? dir + "\\" + rest.replace(/\//g, "\\") : rest;
}

/* A relative <img> can't resolve against the app's own URL, so each one is read
 * off disk and inlined. Failures are left showing their alt text rather than a
 * broken-image icon — a missing asset is the document's problem to show, not an
 * error to interrupt the reader with. */
function resolveMdImages(host, base) {
  for (const img of host.querySelectorAll("img[data-rel]")) {
    const abs = mdResolve(base, img.dataset.rel);
    atom.files.dataUrl(abs)
      .then((d) => { if (d && d.dataUrl) img.src = d.dataUrl; else img.classList.add("missing"); })
      .catch(() => img.classList.add("missing"));
  }
}

/* The preview is a document, so it gets a document's affordances: its name, a
 * copy of the whole thing, and a way back to the source. */
function mdPreviewBar(f, text) {
  return h("div", { class: "mdp-bar" },
    h("span", { class: "mdp-ico", html: icon("eye", 13) }),
    h("span", { class: "mdp-name", text: f.name }),
    h("span", { class: "mdp-spacer" }),
    h("button", { class: "mdp-act", title: "Copy the whole document as Markdown", onclick: () => copyText(text, "Markdown copied", mdToRichHtml(text)) },
      h("span", { html: icon("copy", 13) }), h("span", { text: "Copy" })),
    h("button", { class: "mdp-act", title: "Back to the source (Ctrl+Shift+V)", onclick: () => toggleMarkdownPreview() },
      h("span", { html: icon("close", 13) })));
}

function onMdPreviewClick(e) {
  const copyBtn = e.target.closest(".codeblock-copy");
  if (copyBtn) {
    const code = copyBtn.closest(".codeblock").querySelector("code");
    copyText(code ? code.textContent : "", "Code copied");
    return;
  }
  // A path-shaped inline code span is a real file here, so it opens one.
  const fp = e.target.closest(".md-fp");
  if (fp && fp.dataset.fp) {
    const cur = stateActiveFile();
    openInEditor(mdResolve(mdBaseDir(cur), fp.dataset.fp));
    return;
  }
  const link = e.target.closest(".md-link");
  if (!link) return;
  e.preventDefault();
  const href = link.dataset.href || "";
  if (/^https?:/i.test(href)) { atom.shell.openExternal(href); return; }
  if (href.startsWith("#")) {
    const target = document.getElementById(href.slice(1));
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (/^mailto:/i.test(href)) { atom.shell.openExternal(href); return; }
  // A relative link points at a file sitting next to this one — open it.
  const f = stateActiveFile();
  openInEditor(mdResolve(mdBaseDir(f), href.replace(/#.*$/, "")));
}

// Same right-click copy the conversation offers — a preview you can't quote from
// is a screenshot.
function onMdPreviewContext(e) {
  const sel = (window.getSelection && String(window.getSelection())) || "";
  const f = stateActiveFile();
  const items = [];
  if (sel.trim()) {
    const selHtml = selectionHtml();
    items.push({ label: "Copy", icon: "copy", onClick: () => copyText(sel, "Copied", selHtml ? styleRichHtml(selHtml) : null) });
  }
  if (f) {
    const text = (cm && cm.docText()) || f.content || "";
    items.push({ label: sel.trim() ? "Copy whole document" : "Copy document", icon: "copy", onClick: () => copyText(text, "Markdown copied", mdToRichHtml(text)) });
    items.push({ sep: true });
    items.push({ label: "Back to source", icon: "fileCode", onClick: () => toggleMarkdownPreview() });
  }
  if (!items.length) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, items);
}

/* ---- split controls ---- */
function toggleSplit() {
  if (!stateActiveFile()) return;
  if (state.editor.split) { closeSplit(); return; }
  syncFileContent(paneFile(0), editors[0]);        // pane 1 loads from f.content — make it current
  state.editor.split = true;
  state.editor.panes[1] = state.editor.panes[0];   // duplicate focused file → same-file live split
  renderEditor();
  persistEditor();
}
function closeSplit() {
  if (!state.editor.split) return;
  state.editor.split = false;
  if (editors[1]) { editors[1].destroy(); editors[1] = null; }
  state.editor.panes[1] = null;
  state.editor.focused = 0;
  cm = editors[0];
  renderEditor();
  persistEditor();
}
function toggleSplitOrientation() {
  if (!state.editor.split) return;
  state.editor.splitDir = state.editor.splitDir === "h" ? "v" : "h";
  $("editorBody").style.removeProperty("--epane0");   // reset any drag-set sizing
  renderEditor();
  persistEditor();
}

// Drag the divider to resize the two panes (flex-basis on the first pane).
function startPaneResize(e) {
  e.preventDefault();
  const body = $("editorBody");
  const horiz = state.editor.splitDir === "h";
  const rect = body.getBoundingClientRect();
  const onMove = (ev) => {
    const frac = horiz ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
    const pct = Math.max(0.15, Math.min(0.85, frac)) * 100;
    body.style.setProperty("--epane0", pct + "%");
    for (const ed of editors) if (ed) ed.remeasure();
  };
  const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); document.body.style.userSelect = ""; };
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// Resolve .editorconfig for a file (cached) and apply its indent settings to the
// given editor (defaults to the focused pane).
async function applyEditorConfig(f, ed) {
  if (!atom.editorconfig) return;
  if (f.ec === undefined) { try { f.ec = (await atom.editorconfig(f.path)) || {}; } catch { f.ec = {}; } }
  ed = ed || cm;
  if (!ed) return;
  const ec = f.ec || {};
  if (ec.indent_style === "tab") ed.setIndent(+(ec.tab_width || (ec.indent_size !== "tab" && ec.indent_size) || 4), true);
  else if (ec.indent_size && ec.indent_size !== "tab") ed.setIndent(+ec.indent_size, false);
  else ed.setIndent(2, false);
  // .editorconfig end_of_line wins over the detected EOL (only crlf/lf are written).
  if ((ec.end_of_line === "crlf" || ec.end_of_line === "lf") && f.eol !== ec.end_of_line) { f.eol = ec.end_of_line; if (stateActiveFile() === f) updateEditorStatus(f); }
}

// Pull the live editor text into the file record — called lazily (save, pane
// switch, search) instead of on every keystroke, so typing never pays O(n).
function syncFileContent(f, ed) {
  if (!f || !ed || !f._stale) return;
  f.content = ed.docText();
  f._stale = false;
}

let autoSaveTimer = null;
// >0 while WE replace an editor's document (file open / disk refresh after the
// agent edited it). Only edits made outside this window are the user's.
let _programmaticDoc = 0;
function onCmChange(idx) {
  const f = (idx == null) ? stateActiveFile() : paneFile(idx);
  if (!f) return;
  const ed = (idx == null) ? cm : editors[idx];
  // Programmatic load: the doc was set FROM f.content, so nothing is stale and the
  // unsaved state is exactly "does the buffer differ from what's on disk". Compare
  // directly instead of falling through to the heuristic below, which assumes any
  // change is the user's and marks big docs dirty outright — that's what made the
  // agent's file edits show a pending-change dot on the tab.
  if (_programmaticDoc) {
    f._stale = false;
    const pending = f.content !== f.saved;
    if (pending !== f.dirty) { f.dirty = pending; renderEditorTabs(); updateEditorStatus(f); }
    return;
  }
  f._stale = true;   // f.content is now behind the editor; sync lazily
  // Dirty check without building the full doc string: any change marks dirty;
  // small docs get the exact "undo back to saved" check, big docs stay dirty.
  let dirty = true;
  const len = ed ? ed.view.state.doc.length : -1;
  if (ed && len === f.saved.length && len < 262_144) {
    dirty = ed.docText() !== f.saved;
    if (!dirty) { f.content = f.saved; f._stale = false; }
  }
  if (dirty !== f.dirty) { f.dirty = dirty; renderEditorTabs(); updateEditorStatus(f); }
  if (idx == null || idx === state.editor.focused) { scheduleSymbolRefresh(); if (state.editor.mdPreview) renderMarkdownPreview(); }
  // Auto-save can't apply to a buffer with no path — it would throw a file picker
  // in the user's face 1.2s after they started typing.
  if (dirty && state.settings.editorAutoSave && !f.untitled) {
    const target = f.path;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => { autoSaveTimer = null; const af = stateActiveFile(); if (af && af.path === target && af.dirty) saveEditorFile(target); }, 1200);
  }
}

// Cursor-driven UI (status bar + breadcrumbs) coalesced to one update per frame —
// rebuilding them per keypress/cursor-move costs DOM churn on every keystroke.
let _cursorRaf = 0, _cursorArgs = null;
function scheduleCursorUI(idx, line, col) {
  _cursorArgs = { idx, line, col };
  if (_cursorRaf) return;
  _cursorRaf = requestAnimationFrame(() => {
    _cursorRaf = 0;
    const a = _cursorArgs;
    if (!a || a.idx !== state.editor.focused) return;
    const af = paneFile(a.idx);
    if (af) updateEditorStatus(af, a.line, a.col);
    updateBreadcrumbsCursor();
  });
}

// Flip a file's line-ending style (LF ⇄ CRLF). Persisted on next save.
function toggleEditorEol(f) {
  if (!f) return;
  f.eol = (f.eol === "crlf") ? "lf" : "crlf";
  f.dirty = true;   // an EOL change is itself a pending write
  renderEditorTabs(); updateEditorStatus(f);
}

/* ---- editor context menu (CM6) ---- */
function editorCtxMenu(x, y) {
  if (!cm) return;
  const hasSel = !cm.selection().empty;
  const f = stateActiveFile();
  const lang = f ? (f.lang || "").toLowerCase() : "";
  const semantic = TS_LANGS.has(lang) || LSP_EXTS.has(lang);
  showContextMenu(x, y, [
    ...(semantic ? [
      { label: "Go to definition", icon: "external", onClick: () => { const af = stateActiveFile(); if (af && cm) editorGotoDefinition(af, cm.cursor()); } },
      { label: "Find all references", icon: "gitCompare", onClick: () => editorFindReferences() },
      { label: "Go to symbol…", icon: "list", onClick: () => openSymbolPicker() },
      { sep: true },
    ] : []),
    { label: "Cut", icon: "cut", onClick: cmCut },
    { label: "Copy", icon: "copy", onClick: cmCopy },
    { label: "Paste", icon: "paste", onClick: cmPaste },
    { sep: true },
    { label: "Select all", icon: "list", onClick: () => cm.selectAll() },
    { sep: true },
    { label: hasSel ? "Upper case" : "Upper case line", icon: "caseUpper", onClick: () => cmCase(true) },
    { label: hasSel ? "Lower case" : "Lower case line", icon: "caseLower", onClick: () => cmCase(false) },
    { sep: true },
    { label: "Sort lines A→Z", icon: "list", onClick: () => cm.sortLines(false) },
    { label: "Sort lines Z→A", icon: "list", onClick: () => cm.sortLines(true) },
    { label: "Join lines", icon: "merge", onClick: () => cm.joinLines() },
  ]);
}
// Copy/Cut/case fall back to the current line when there's no selection (VS Code-style).
function cmRange() { const s = cm.selection(); return s.empty ? cm.lineRangeAt(cm.cursor()) : { from: s.from, to: s.to, text: s.text }; }
async function cmCopy() { const r = cmRange(); if (r.text) { await atom.clipboard.write(r.text); toast("Copied", "copy"); } }
async function cmCut() { const r = cmRange(); if (!r.text) return; await atom.clipboard.write(r.text); cm.replaceRange(r.from, r.to, ""); }
async function cmPaste() { const text = await atom.clipboard.read().catch(() => ""); if (text == null || text === "") return; const s = cm.selection(); cm.replaceRange(s.from, s.to, text); }
function cmCase(upper) {
  const r = cmRange();
  const out = upper ? r.text.toUpperCase() : r.text.toLowerCase();
  if (!r.text || out === r.text) return;
  cm.replaceRange(r.from, r.to, out);
  cm.selectRange(r.from, r.from + out.length);
}

/* ---- Ctrl/Cmd-click go-to-definition (js · ts · python · json) ---- */
const GOTODEF_LANGS = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "python", "json"]);
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// The identifier token under an offset (word chars + $).
function identAt(text, pos) {
  const isW = (ch) => ch != null && /[A-Za-z0-9_$]/.test(ch);
  let i = pos;
  if (!isW(text[i]) && isW(text[i - 1])) i--;
  if (!isW(text[i])) return "";
  let s = i, e = i;
  while (s > 0 && isW(text[s - 1])) s--;
  while (e < text.length && isW(text[e])) e++;
  return text.slice(s, e);
}
// If the column sits inside a quoted string on this line, return its contents.
function quotedStringAt(line, col) {
  const re = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(line))) {
    const inner = m.index + 1, end = m.index + m[0].length - 1;
    if (col >= inner && col <= end) return m[2];
  }
  return null;
}
// Regex(es) that mark a definition of `word` for the language.
function defRegexes(word, lang) {
  const W = escRe(word);
  if (lang === "py" || lang === "python") return [new RegExp(`\\bdef\\s+${W}\\b`), new RegExp(`\\bclass\\s+${W}\\b`), new RegExp(`^\\s*${W}\\s*=`)];
  return [
    new RegExp(`\\b(?:function|class)\\s+${W}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${W}\\b`),
    new RegExp(`\\b${W}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\(|[\\w$]+\\s*=>)`),
    new RegExp(`\\b${W}\\s*\\([^)]*\\)\\s*\\{`),
  ];
}
// Find a definition of `word` in `text`; return the offset of `word`, or -1.
function findDefinition(text, word, lang, skipLineStart) {
  if (lang === "json") return -1;
  const res = defRegexes(word, lang);
  const lines = text.split("\n");
  let off = 0, fallback = -1;
  for (const ln of lines) {
    if (res.some((r) => r.test(ln))) {
      const idx = ln.indexOf(word);
      const at = off + (idx >= 0 ? idx : 0);
      if (off !== skipLineStart) return at;   // prefer a line other than where you clicked
      fallback = at;
    }
    off += ln.length + 1;
  }
  return fallback;
}
async function editorGotoOffset(filePath, offset, len) {
  if (state.editor.active !== filePath) await openInEditor(filePath);
  requestAnimationFrame(() => { if (cm) cm.gotoOffset(offset, len); });
}
function editorGotoDefinition(f, pos) {
  const lang = (f.lang || "").toLowerCase();
  if (!GOTODEF_LANGS.has(lang) && !LSP_EXTS.has(lang)) return;
  navMark();   // record where we jumped FROM so Alt+Left returns here
  // CM6's document is the source of truth — `pos` is an offset into it, so
  // resolve everything against cm.docText() (consistent line endings).
  const text = (cm && cm.docText()) || f.content || "";
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = text.indexOf("\n", pos); if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  const col = pos - lineStart;

  // 1) import/require path, or a relative path string (also JSON)
  const q = quotedStringAt(line, col);
  if (q && (/\b(?:import|require|from|export)\b/.test(line) || lang === "json" || /^[./]/.test(q))) {
    const rel = /^[./]/.test(q);
    // Non-relative specifiers can be tsconfig `paths` aliases (@/utils/x) — the TS
    // service resolves those exactly; only call it a real external module if it can't.
    if (!rel && TS_LANGS.has(lang) && atom.ts) {
      atom.ts.req("definition", tsRootFor(f), f.path, { text, pos })
        .then((d) => {
          if (d && d.file && !/[\\/]node_modules[\\/]/.test(d.file)) editorGotoOffset(d.file, d.start, d.length);
          else toast(`External module “${q}”`, "globe");
        })
        .catch(() => toast(`External module “${q}”`, "globe"));
      return;
    }
    if (rel) {
      atom.files.resolveImport(f.path, q).then((p) => {
        if (p) openInEditor(p);
        else toast(`Can't find “${q}”`, "alert");
      });
    } else {
      toast(`External module “${q}”`, "globe");
    }
    return;
  }
  if (lang === "json") return;   // no symbol resolution in JSON

  const root = tsRootFor(f);
  // Heuristic fallback: this-file symbol, then a fast project-wide source search.
  const heuristic = () => {
    const word = identAt(text, pos);
    if (!word) return;
    const localOff = findDefinition(text, word, lang, lineStart);
    if (localOff >= 0) { editorGotoOffset(f.path, localOff, word.length); return; }
    atom.files.findDefinition(root, word, lang).then((hit) => {
      if (hit && hit.path) editorGoToLine(hit.path, hit.line, word, true);
      else toast(`No definition found for “${word}”`, "search");
    }).catch(() => toast(`No definition found for “${word}”`, "search"));
  };

  // 2) JS/TS: ask the TypeScript service for an exact, cross-file definition first.
  if (TS_LANGS.has(lang) && atom.ts) {
    atom.ts.req("definition", root, f.path, { text, pos })
      .then((d) => { if (d && d.file) editorGotoOffset(d.file, d.start, d.length); else heuristic(); })
      .catch(heuristic);
    return;
  }
  // 2b) LSP languages: ask the language server (returns file + line/col).
  if (LSP_EXTS.has(lang) && atom.lsp) {
    atom.lsp.req("definition", root, lang, f.path, { text, pos })
      .then((d) => { if (d && d.file) { openInEditor(d.file).then(() => { if (cm) cm.gotoLine(d.line, d.col); }); } else heuristic(); })
      .catch(heuristic);
    return;
  }
  heuristic();
}

const TS_LANGS = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"]);
const LSP_EXTS = new Set();                         // file exts with an LSP server (filled at startup)
const SEMANTIC_EXTS = new Set(TS_LANGS);            // union of TS + LSP exts → gates the editor's semantic features
// Discover available LSP servers and live-update diagnostics they push.
function setupLsp() {
  if (!atom.lsp) return;
  const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
  atom.lsp.langs().then((list) => { for (const e of (list || [])) { LSP_EXTS.add(e); SEMANTIC_EXTS.add(e); } }).catch(() => {});
  atom.lsp.onDiagnostics(({ file }) => {
    const af = stateActiveFile();
    if (af && cm && file && norm(af.path) === norm(file)) { cm.forceRelint(); setTimeout(onEditorDiagnostics, 250); }
  });
}

// Format the active file: TypeScript service for JS/TS, Prettier for
// JSON/CSS/HTML/Markdown/YAML/…, an LSP server otherwise.
const PRETTIER_LANGS = new Set(["json", "jsonc", "json5", "webmanifest", "css", "scss", "less", "html", "htm", "xhtml", "vue", "md", "markdown", "mdx", "yaml", "yml", "graphql", "gql"]);
async function editorFormat() {
  const f = stateActiveFile();
  if (!f || !cm) return false;
  const lang = (f.lang || "").toLowerCase(), root = tsRootFor(f), text = cm.docText();
  try {
    if (TS_LANGS.has(lang) && atom.ts) { const edits = await atom.ts.req("format", root, f.path, { text }); if (edits && edits.length) { cm.applyEdits(edits); return true; } return false; }
    if (PRETTIER_LANGS.has(lang) && atom.prettier) { const out = await atom.prettier.format(text, lang, 2); if (out != null && out !== text) { cm.applyEdits([{ from: 0, to: text.length, text: out }]); return true; } return false; }
    if (LSP_EXTS.has(lang) && atom.lsp) { const edits = await atom.lsp.req("format", root, lang, f.path, { text }); if (edits && edits.length) { cm.applyEdits(edits); return true; } return false; }
  } catch { /* ignore */ }
  return false;
}
function tsRootFor(f) {
  const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
  let root = state.project || "";
  if (!root || !norm(f.path).startsWith(norm(root))) root = f.path.replace(/[\\/][^\\/]*$/, "");
  return root;
}

/* ---- git gutter: parse a `git diff HEAD` into per-line add/change/del marks ---- */
function parseDiffToGutter(text) {
  const marks = [];
  let newLine = 0, inHunk = false, pendingDel = 0;
  for (const ln of (text || "").split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
    if (m) { if (pendingDel > 0 && newLine > 0) marks.push({ line: Math.max(1, newLine - 1), type: "del" }); newLine = +m[1]; inHunk = true; pendingDel = 0; continue; }
    if (!inHunk) continue;
    const c = ln[0];
    if (c === "+") { marks.push({ line: newLine, type: pendingDel > 0 ? "change" : "add" }); if (pendingDel > 0) pendingDel--; newLine++; }
    else if (c === "-") { pendingDel++; }
    else if (c === "\\") { /* "\ No newline at end of file" */ }
    else { if (pendingDel > 0) { marks.push({ line: Math.max(1, newLine - 1), type: "del" }); pendingDel = 0; } newLine++; }
  }
  if (pendingDel > 0 && newLine > 0) marks.push({ line: Math.max(1, newLine - 1), type: "del" });
  return marks;
}
async function gitGutterFor(ed, f) {
  if (!ed || !f || !ed.setGitGutter) return;
  let cwd = null;
  try { cwd = await atom.git.repoForFile(f.path); } catch { /* ignore */ }
  if (!cwd) { ed.setGitGutter([]); return; }
  try { const d = await atom.git.fileDiff(cwd, f.path); ed.setGitGutter(parseDiffToGutter((d && d.text) || "")); }
  catch { ed.setGitGutter([]); }
}
function gitGutterRefreshAll() { for (let i = 0; i < 2; i++) if (editors[i]) gitGutterFor(editors[i], paneFile(i)); }

/* ============================================================
   CHECKPOINTS — snapshot/restore the open files around an agent run.
   A reversible "undo the whole edit" independent of Git: one is captured
   automatically before each message you send, plus on demand.
   ============================================================ */
let _cpSeq = 0;
async function createCheckpoint(label) {
  state.checkpoints = state.checkpoints || [];
  const open = state.editor.open.filter((f) => f.kind !== "image");
  if (!open.length) return null;
  const files = [];
  for (const f of open) {
    try { const d = await atom.files.read(f.path); if (d && !d.error && !d.isBinary && !d.tooLarge) files.push({ path: f.path, content: d.content || "" }); } catch { /* ignore */ }
  }
  if (!files.length) return null;
  const cp = { id: "cp" + (++_cpSeq), label: label || "Checkpoint", time: Date.now(), files };
  state.checkpoints.unshift(cp);
  if (state.checkpoints.length > 15) state.checkpoints.pop();   // bounded history
  const f = stateActiveFile(); if (f) updateEditorStatus(f);
  return cp;
}
async function restoreCheckpoint(id) {
  const cp = (state.checkpoints || []).find((c) => c.id === id);
  if (!cp) return;
  let n = 0;
  for (const fl of cp.files) { try { await atom.files.write(fl.path, fl.content); n++; } catch { /* ignore */ } }
  // reflect the restored bytes in any open editor + reload its pane
  for (const f of state.editor.open) {
    const snap = cp.files.find((x) => x.path === f.path);
    if (snap) { f.content = snap.content.replace(/\r\n/g, "\n"); f.saved = f.content; f.dirty = false; f._diskConflict = false; }
  }
  for (let p = 0; p < 2; p++) if (state.editor.panes[p]) loadPaneFile(p, true);
  renderEditorTabs(); gitGutterRefreshAll();
  if (gitProjectRoot()) scheduleGitRefresh();
  toast(`Restored checkpoint — ${n} file${n === 1 ? "" : "s"}`, "undo", { ms: 3000 });
}
function openCheckpoints() {
  const list = h("div", { class: "search-results" });
  const createBtn = h("button", { class: "btn", html: icon("history", 14) + "<span>Create checkpoint now</span>", onclick: async () => { await createCheckpoint("Manual checkpoint"); draw(); } });
  const body = h("div", {}, h("div", { class: "cp-actions" }, createBtn), list);
  const back = modalShell({ title: "Checkpoints", ic: "history", body });
  back.querySelector(".modal").classList.add("search-modal");
  function draw() {
    list.innerHTML = "";
    const cps = state.checkpoints || [];
    if (!cps.length) { list.append(h("div", { class: "search-empty", text: "No checkpoints yet. One is captured automatically before each message you send." })); return; }
    for (const cp of cps) {
      list.append(h("div", { class: "sr-name-row cp-row" },
        h("span", { class: "sym-ic", html: icon("history", 15) }),
        h("span", { class: "srn-name", text: cp.label }),
        h("span", { class: "srn-path", text: `${cp.files.length} file${cp.files.length === 1 ? "" : "s"} · ${new Date(cp.time).toLocaleTimeString()}` }),
        h("button", { class: "cp-restore", text: "Restore", onclick: () => {
          closeModal(back);
          confirmDialog({ title: "Restore checkpoint?", message: `Overwrite ${cp.files.length} file(s) with this snapshot? Any later edits to them will be lost.`, danger: true, confirmLabel: "Restore", onConfirm: () => restoreCheckpoint(cp.id) });
        } })));
    }
  }
  draw();
}

/* ============================================================
   NAVIGATION — document symbols (outline / breadcrumbs / go-to-symbol)
   ============================================================ */
const SYMBOL_LANGS = () => new Set([...TS_LANGS, ...LSP_EXTS]);
// Map TS/LSP symbol-kind strings to an icon + a CSS class for colouring.
const SYM_ICON = { class: "box", interface: "box", "type-parameter": "box", struct: "box", enum: "list", "enum-member": "dot", method: "sparkle", function: "sparkle", constructor: "sparkle", property: "dot", field: "dot", variable: "dot", constant: "dot", module: "folder", namespace: "folder", "var": "dot", "let": "dot", "const": "dot", alias: "box", parameter: "dot" };
const symIcon = (k) => SYM_ICON[(k || "").toLowerCase()] || "dot";

let _symCache = { path: null, token: 0, symbols: [] };
let _symFetchTimer = null;
async function fetchEditorSymbols() {
  const f = stateActiveFile();
  if (!f) return [];
  const lang = (f.lang || "").toLowerCase(), root = tsRootFor(f), text = (cm && cm.docText()) || f.content || "";
  try {
    if (TS_LANGS.has(lang) && atom.ts) return (await atom.ts.req("documentSymbols", root, f.path, { text })) || [];
    if (LSP_EXTS.has(lang) && atom.lsp) return (await atom.lsp.req("documentSymbols", root, lang, f.path, { text })) || [];
  } catch { /* ignore */ }
  return [];
}
// Refresh the symbol cache for the active file (debounced), then redraw breadcrumbs.
function scheduleSymbolRefresh() {
  clearTimeout(_symFetchTimer);
  const f = stateActiveFile();
  if (!f || !SYMBOL_LANGS().has((f.lang || "").toLowerCase())) { _symCache = { path: f ? f.path : null, token: 0, symbols: [] }; renderBreadcrumbs(); return; }
  // Each refetch ships the full document over IPC — debounce harder on big files.
  const delay = (cm && cm.view.state.doc.length > 300_000) ? 2000 : 500;
  _symFetchTimer = setTimeout(async () => {
    const path = f.path;
    const symbols = await fetchEditorSymbols();
    if (stateActiveFile() && stateActiveFile().path === path) { _symCache = { path, token: 0, symbols }; renderBreadcrumbs(); }
  }, delay);
}
// Symbols whose range encloses `pos`, outermost-first → the breadcrumb chain.
function symbolChainAt(pos) {
  return (_symCache.symbols || []).filter((s) => s.from <= pos && pos <= s.to).sort((a, b) => a.from - b.from || b.to - a.to);
}

function renderBreadcrumbs() {
  const bar = $("editorBreadcrumbs");
  if (!bar) return;
  const f = stateActiveFile();
  const symsSupported = f && SYMBOL_LANGS().has((f.lang || "").toLowerCase());
  if (!f || !symsSupported || !(_symCache.symbols && _symCache.symbols.length)) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  bar.classList.remove("hidden");
  bar.innerHTML = "";
  // path crumb (opens the symbol picker) + the enclosing symbol chain
  const pos = cm ? cm.cursor() : 0;
  const chain = symbolChainAt(pos);
  const seg = (label, ic, onclick, cls) => h("button", { class: "bc-seg" + (cls ? " " + cls : ""), onclick }, ic ? h("span", { class: "bc-ic", html: icon(ic, 13) }) : null, h("span", { text: label }));
  bar.append(seg(f.name, "fileCode", () => openSymbolPicker(), "bc-file"));
  for (const s of chain) {
    bar.append(h("span", { class: "bc-sep", html: icon("chevron", 12) }));
    bar.append(seg(s.name, symIcon(s.kind), () => jumpTo(f.path, s.from)));
  }
}

function updateBreadcrumbsCursor() { if (!$("editorBreadcrumbs").classList.contains("hidden")) renderBreadcrumbs(); }

// Ctrl+Shift+O — fuzzy go-to-symbol over the active file's document symbols.
async function openSymbolPicker() {
  const f = stateActiveFile();
  if (!f) return;
  let symbols = _symCache.path === f.path ? _symCache.symbols : null;
  const input = h("input", { placeholder: "Go to symbol…  (type to filter)", spellcheck: "false" });
  const results = h("div", { class: "search-results" });
  const summary = h("div", { class: "search-summary" });
  const body = h("div", {}, h("div", { class: "search-input-row" }, h("div", { class: "si-wrap" }, h("span", { html: icon("list", 16) }), input)), summary, results);
  const back = modalShell({ title: "Go to symbol", ic: "list", wide: true, body });
  back.querySelector(".modal").classList.add("search-modal");
  setTimeout(() => input.focus(), 40);

  let sel = 0, filtered = [];
  function draw() {
    const q = input.value.trim().toLowerCase();
    filtered = (symbols || []).filter((s) => !q || s.name.toLowerCase().includes(q));
    summary.textContent = symbols == null ? "Loading symbols…" : `${filtered.length} symbol${filtered.length !== 1 ? "s" : ""}`;
    results.innerHTML = "";
    if (!filtered.length) { results.append(h("div", { class: "search-empty", text: symbols == null ? "…" : "No symbols." })); return; }
    sel = Math.max(0, Math.min(sel, filtered.length - 1));
    filtered.slice(0, 500).forEach((s, i) => {
      results.append(h("div", { class: "sr-name-row sym-row" + (i === sel ? " active" : ""), style: `padding-left:${8 + (s.depth || 0) * 14}px`, onclick: () => pick(s) },
        h("span", { class: "sym-ic sym-" + (s.kind || "").toLowerCase().replace(/[^a-z]/g, ""), html: icon(symIcon(s.kind), 14) }),
        h("span", { class: "srn-name", text: s.name }), h("span", { class: "srn-path", text: s.kind || "" })));
    });
  }
  function pick(s) { closeModal(back); jumpTo(f.path, s.from); }
  input.addEventListener("input", () => { sel = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closeModal(back);
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); draw(); scrollSel(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); scrollSel(); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[sel]) pick(filtered[sel]); }
  });
  function scrollSel() { const el = results.querySelector(".sym-row.active"); if (el) el.scrollIntoView({ block: "nearest" }); }
  draw();
  if (symbols == null) { symbols = await fetchEditorSymbols(); draw(); }
}
function applyEditsToString(s, edits) {
  for (const e of [...edits].sort((a, b) => b.from - a.from)) s = s.slice(0, e.from) + (e.text || "") + s.slice(e.to);
  return s;
}
// Apply TS FileTextChanges: the active file goes through the editor (undoable);
// other files are read, edited by offset and written back.
async function applyTsFileChanges(changes, activePath) {
  const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
  let n = 0;
  for (const fc of (changes || [])) {
    if (norm(fc.fileName) === norm(activePath) && cm) cm.applyEdits(fc.edits);
    else { try { const data = await atom.files.read(fc.fileName); await atom.files.write(fc.fileName, applyEditsToString((data.content || "").replace(/\r\n/g, "\n"), fc.edits)); } catch { /* ignore */ } }
    n++;
  }
  if (n) { toast("Applied fix", "checkCircle", { ms: 1600 }); if (state.sidebarView === "git") refreshGit(); refreshTree(true); }
}
// Quick fixes / code actions (Ctrl+.) — TS code fixes + organize imports.
async function editorQuickFix(from, to) {
  const f = stateActiveFile();
  if (!f || !atom.ts || !TS_LANGS.has((f.lang || "").toLowerCase())) return;
  const text = (cm && cm.docText()) || f.content || "";
  let fixes = null;
  try { fixes = await atom.ts.req("codeFixes", tsRootFor(f), f.path, { text, start: from, end: to }); } catch { /* ignore */ }
  if (!fixes || !fixes.length) { toast("No quick fixes here", "check", { ms: 1800 }); return; }
  const c = cm && cm.coordsAtPos(from);
  showContextMenu(c ? c.left : 240, c ? c.bottom + 4 : 240,
    fixes.map((fx) => ({ label: (fx.description || "Fix").slice(0, 70), icon: fx.fixName === "organizeImports" ? "list" : "sparkle", onClick: () => applyTsFileChanges(fx.changes, f.path) })));
}
// Rename symbol (F2) — project-wide, across files.
async function editorRename(pos) {
  const f = stateActiveFile();
  if (!f || !atom.ts || !TS_LANGS.has((f.lang || "").toLowerCase())) return;
  const text = (cm && cm.docText()) || f.content || "";
  let info = null;
  try { info = await atom.ts.req("rename", tsRootFor(f), f.path, { text, pos }); } catch { /* ignore */ }
  if (!info || !info.files || !Object.keys(info.files).length) { toast("Can’t rename this symbol", "alert", { ms: 2500 }); return; }
  const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
  const activeKey = Object.keys(info.files).find((k) => norm(k) === norm(f.path));
  const locs = (activeKey && info.files[activeKey]) || [];
  const cur = locs.length && cm ? cm.slice(locs[0].from, locs[0].to) : "";
  promptDialog({
    title: "Rename symbol", ic: "pencil", value: cur, placeholder: "New name", confirmLabel: "Rename",
    onConfirm: async (newName) => {
      newName = (newName || "").trim();
      if (!newName || newName === cur) return;
      let files = 0, total = 0;
      for (const [fname, ls] of Object.entries(info.files)) {
        const edits = ls.map((l) => ({ from: l.from, to: l.to, text: (l.prefix || "") + newName + (l.suffix || "") }));
        if (norm(fname) === norm(f.path) && cm) cm.applyEdits(edits);
        else { try { const data = await atom.files.read(fname); await atom.files.write(fname, applyEditsToString((data.content || "").replace(/\r\n/g, "\n"), edits)); } catch { /* ignore */ } }
        files++; total += edits.length;
      }
      toast(`Renamed ${total} occurrence${total === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`, "checkCircle", { ms: 3500 });
      if (state.sidebarView === "git") refreshGit();
      refreshTree(true);
    },
  });
}

function updateEditorStatus(f, line, col) {
  const bar = $("editorStatus");
  if (!bar || !f) return;
  if (line == null) {
    // No caret info supplied — read it from the live editor (or default to 1,1).
    if (cm) { const pos = cm.cursor(); line = cm.lineOf(pos); col = pos - cm.lineRangeAt(pos).from + 1; }
    else { line = 1; col = 1; }
  }
  bar.innerHTML = "";
  bar.append(
    h("span", { text: (f.lang || "text").toUpperCase() }),
    h("span", { text: `Ln ${line}, Col ${col}` }),
    h("span", { class: "es-eol", title: "Line endings — click to toggle", text: (f.eol || "lf").toUpperCase(), onclick: () => toggleEditorEol(f) }),
    problemsBadge(),
    h("span", { class: "es-spacer" }),
    h("div", { class: "es-zoom" },
      h("button", { title: "Zoom out (Ctrl+-)", text: "−", onclick: () => changeEditorZoom(-1) }),
      h("span", { class: "es-zlabel", title: "Reset zoom (Ctrl+0)", text: (state.editor.fontSize || 13) + "px", onclick: () => changeEditorZoom(0) }),
      h("button", { title: "Zoom in (Ctrl+=)", text: "+", onclick: () => changeEditorZoom(1) })),
    h("span", { class: "es-cp", title: "Checkpoints — snapshot/restore (auto-saved before each agent run)", onclick: () => openCheckpoints() }, h("span", { html: icon("history", 12) }), h("span", { text: (state.checkpoints && state.checkpoints.length) ? String(state.checkpoints.length) : "" })),
    f.dirty ? h("span", { class: "es-dirty", text: "● unsaved" }) : h("span", { text: "saved" }),
    h("span", { class: "es-save", text: "Save (Ctrl+S)", onclick: () => saveEditorFile(f.path) }));
}

// ---- Problems panel + go-to-line (Editor UX) ----
function problemsBadge() {
  const d = state.editor.diags || [];
  const e = d.filter((x) => x.severity === "error").length, w = d.filter((x) => x.severity === "warning").length;
  const txt = (e || w) ? `${e} error${e === 1 ? "" : "s"}${w ? `, ${w} warning${w === 1 ? "" : "s"}` : ""}` : "No problems";
  return h("span", { class: "es-problems" + ((e || w) ? " has" : "") + (state.editor.problemsOpen ? " active" : ""), title: "Toggle Problems panel (Ctrl+Shift+M)", onclick: () => toggleProblems() }, txt);
}
function onEditorDiagnostics() {
  state.editor.diags = cm ? cm.diagnosticsDetailed() : [];
  const f = stateActiveFile();
  if (f) updateEditorStatus(f);
  if (state.editor.problemsOpen) renderProblems();
}
function toggleProblems() {
  state.editor.problemsOpen = !state.editor.problemsOpen;
  renderProblems();
  const f = stateActiveFile();
  if (f) updateEditorStatus(f);
  if (cm) cm.remeasure();
}
async function scanProjectProblems() {
  const f = stateActiveFile();
  if (!f || !cm || !TS_LANGS.has((f.lang || "").toLowerCase()) || !atom.ts) { state.editor.projDiags = []; renderProblems(); return; }
  state.editor.projDiags = null;   // loading
  renderProblems();
  let res = [];
  try { res = await atom.ts.req("projectDiagnostics", tsRootFor(f), f.path, { text: cm.docText() }) || []; } catch { res = []; }
  state.editor.projDiags = res;
  if (state.editor.problemsOpen && state.editor.problemsScope === "project") renderProblems();
}
function renderProblems() {
  const pane = $("editorPane");
  if (!pane) return;
  let panel = $("editorProblems");
  if (!state.editor.problemsOpen) { if (panel) panel.classList.add("hidden"); return; }
  if (!panel) { panel = h("div", { id: "editorProblems", class: "editor-problems" }); pane.insertBefore(panel, $("editorStatus")); }
  panel.classList.remove("hidden");
  panel.innerHTML = "";
  const scope = state.editor.problemsScope === "project" ? "project" : "file";
  const fileDiags = state.editor.diags || [];
  const projDiags = state.editor.projDiags;
  const f = stateActiveFile();
  const canProject = f && TS_LANGS.has((f.lang || "").toLowerCase());
  const tab = (id, label) => h("button", { class: "ep-tab" + (scope === id ? " active" : ""), text: label, onclick: () => { state.editor.problemsScope = id; if (id === "project" && state.editor.projDiags == null) scanProjectProblems(); else renderProblems(); } });
  const head = h("div", { class: "ep-head" }, h("span", { html: icon("alert", 13) }), h("span", { text: "Problems" }), tab("file", "This file"));
  if (canProject) head.append(tab("project", "Project"));
  head.append(h("div", { class: "es-spacer" }),
    h("button", { class: "ep-close", html: icon("close", 14), title: "Close", onclick: () => toggleProblems() }));
  panel.append(head);

  if (scope === "project") {
    if (projDiags == null) { panel.append(h("div", { class: "ep-empty", text: "Scanning the project…" })); return; }
    if (!projDiags.length) { panel.append(h("div", { class: "ep-empty", text: "No problems in the project." })); return; }
    const byFile = new Map();
    for (const d of projDiags) { if (!byFile.has(d.file)) byFile.set(d.file, []); byFile.get(d.file).push(d); }
    const list = h("div", { class: "ep-list" });
    for (const [file, items] of byFile) {
      list.append(h("div", { class: "ref-file-head" }, h("span", { html: icon("fileCode", 13) }), h("span", { class: "srf-name", text: baseName(file) }), h("span", { class: "srf-path", text: relPath(file, state.project || "") }), h("span", { class: "srf-count", text: String(items.length) })));
      for (const d of items) list.append(h("div", { class: "ep-item " + (d.severity || "info"), onclick: () => jumpTo(file, null, d.line, d.col) },
        h("span", { class: "ep-sev " + (d.severity || "info"), html: icon(d.severity === "warning" ? "eye" : d.severity === "error" ? "alert" : "dot", 12) }),
        h("span", { class: "ep-msg", text: d.message.replace(/\n/g, " ") }),
        h("span", { class: "ep-loc", text: `Ln ${d.line}:${d.col}` })));
    }
    panel.append(list);
    return;
  }

  if (!fileDiags.length) { panel.append(h("div", { class: "ep-empty", text: "No problems detected in this file." })); return; }
  const list = h("div", { class: "ep-list" });
  for (const d of fileDiags) {
    list.append(h("div", { class: "ep-item " + (d.severity || "info"), onclick: () => { if (cm) cm.gotoLine(d.line, d.col); } },
      h("span", { class: "ep-sev " + (d.severity || "info"), html: icon(d.severity === "warning" ? "eye" : d.severity === "error" ? "alert" : "dot", 12) }),
      h("span", { class: "ep-msg", text: d.message.replace(/\n/g, " ") }),
      h("span", { class: "ep-loc", text: `Ln ${d.line}:${d.col}` })));
  }
  panel.append(list);
}
function editorGoToLinePrompt() {
  if (!cm) return;
  const total = cm.view.state.doc.lines;
  promptDialog({
    title: "Go to line", ic: "list", message: `Line 1 – ${total}  (line or line:column)`, placeholder: "e.g. 120 or 120:5", confirmLabel: "Go",
    onConfirm: (v) => { const m = /(\d+)(?::(\d+))?/.exec(String(v || "")); if (!m) return; const n = Math.min(+m[1], total); if (n >= 1) cm.gotoLine(n, m[2] ? +m[2] : 1); },
  });
}

/* ---- jump history (Alt+Left / Alt+Right) ---- */
const _nav = { stack: [], idx: -1 };
function navLoc() { const f = stateActiveFile(); return (f && cm) ? { path: f.path, pos: cm.cursor() } : null; }
function navSame(a, b) { return a && b && a.path === b.path && Math.abs(a.pos - b.pos) < 3; }
// Record the current caret as a history entry (truncating any forward history).
function navMark() {
  const loc = navLoc(); if (!loc) return;
  if (navSame(_nav.stack[_nav.idx], loc)) return;
  _nav.stack = _nav.stack.slice(0, _nav.idx + 1);
  _nav.stack.push(loc); _nav.idx = _nav.stack.length - 1;
  if (_nav.stack.length > 80) { _nav.stack.shift(); _nav.idx--; }
}
// Jump to a location, recording the SOURCE for back/forward. The destination is
// committed lazily on the first Back (navGo), so positions are real caret offsets.
async function jumpTo(path, pos, line, col) {
  navMark();
  await openInEditor(path);
  requestAnimationFrame(() => { if (!cm) return; if (pos != null) cm.gotoOffset(pos, 0); else cm.gotoLine(line || 1, col || 1); });
}
async function navGo(dir) {
  if (dir < 0) navMark();   // commit the current caret before stepping back (browser model)
  const ni = _nav.idx + dir;
  if (ni < 0 || ni >= _nav.stack.length) return;
  _nav.idx = ni;
  const l = _nav.stack[ni];
  await openInEditor(l.path);
  requestAnimationFrame(() => { if (!cm) return; if (l.pos != null) cm.gotoOffset(l.pos, 0); else cm.gotoLine(l.line || 1, l.col || 1); });
}

/* ---- find all references (Shift+F12) → docked references panel ---- */
async function editorFindReferences() {
  const f = stateActiveFile();
  if (!f || !cm) return;
  const lang = (f.lang || "").toLowerCase(), root = tsRootFor(f), text = cm.docText(), pos = cm.cursor();
  if (!TS_LANGS.has(lang) && !LSP_EXTS.has(lang)) { toast("References aren't available for this language", "alert"); return; }
  const word = cm.wordAt(pos);
  state.editor.refs = null; state.editor.refsOpen = true; state.editor.refsWord = word ? word.word : "";
  renderReferences();   // show "searching…"
  let refs = null;
  try {
    if (TS_LANGS.has(lang) && atom.ts) refs = await atom.ts.req("references", root, f.path, { text, pos });
    else if (LSP_EXTS.has(lang) && atom.lsp) refs = await atom.lsp.req("references", root, lang, f.path, { text, pos });
  } catch { /* ignore */ }
  state.editor.refs = refs || [];
  if (state.editor.refsOpen) renderReferences();
}
function closeReferences() { state.editor.refsOpen = false; const p = $("editorRefs"); if (p) p.classList.add("hidden"); if (cm) cm.remeasure(); }
function renderReferences() {
  const pane = $("editorPane");
  if (!pane) return;
  let panel = $("editorRefs");
  if (!state.editor.refsOpen) { if (panel) panel.classList.add("hidden"); return; }
  if (!panel) { panel = h("div", { id: "editorRefs", class: "editor-problems" }); pane.insertBefore(panel, $("editorStatus")); }
  panel.classList.remove("hidden");
  panel.innerHTML = "";
  const refs = state.editor.refs;
  const n = refs ? refs.length : 0;
  panel.append(h("div", { class: "ep-head" },
    h("span", { html: icon("gitCompare", 13) }),
    h("span", { text: refs == null ? `Finding references…` : `References to "${state.editor.refsWord || "symbol"}" · ${n}` }),
    h("div", { class: "es-spacer" }),
    h("button", { class: "ep-close", html: icon("close", 14), title: "Close", onclick: () => closeReferences() })));
  if (refs == null) { panel.append(h("div", { class: "ep-empty", text: "Searching the project…" })); return; }
  if (!n) { panel.append(h("div", { class: "ep-empty", text: "No references found." })); return; }
  // group by file
  const byFile = new Map();
  for (const r of refs) { const k = r.file; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(r); }
  const list = h("div", { class: "ep-list" });
  for (const [file, items] of byFile) {
    list.append(h("div", { class: "ref-file-head" }, h("span", { html: icon("fileCode", 13) }), h("span", { class: "srf-name", text: baseName(file) }), h("span", { class: "srf-path", text: relPath(file, state.project || "") }), h("span", { class: "srf-count", text: String(items.length) })));
    for (const r of items) {
      list.append(h("div", { class: "ep-item", onclick: () => jumpTo(file, null, r.line, r.col) },
        h("span", { class: "ep-sev", html: icon(r.isWrite ? "pencil" : "dot", 12) }),
        h("span", { class: "ep-msg", text: `${baseName(file)}` }),
        h("span", { class: "ep-loc", text: `Ln ${r.line}:${r.col}` })));
    }
  }
  panel.append(list);
}

async function saveEditorFile(path) {
  const f = state.editor.open.find((x) => x.path === path);
  if (!f) return;
  // Ctrl+S on a buffer with no path is the "where?" question, and it applies even
  // to an untouched one — that is how you turn a scratch tab into a file.
  if (f.untitled) return void saveEditorAs(f);
  if (!f.dirty) return;
  // Pull the live text from whichever pane shows this file (lazy content sync).
  for (let p = 0; p < 2; p++) if (state.editor.panes[p] === path && editors[p]) { syncFileContent(f, editors[p]); break; }
  // Format on save (JS/TS) when enabled — runs the TS formatter before writing.
  if (state.settings.editorFormatOnSave && cm && state.editor.active === path && TS_LANGS.has((f.lang || "").toLowerCase())) {
    try { await cm.formatDoc(); f.content = cm.docText(); } catch { /* ignore */ }
  }
  // Trim trailing whitespace + final newline (EditorConfig overrides the setting).
  const ec = f.ec || {};
  const trim = ("trim_trailing_whitespace" in ec) ? ec.trim_trailing_whitespace === true : !!state.settings.editorTrimWhitespace;
  const finalNL = ("insert_final_newline" in ec) ? ec.insert_final_newline === true : !!state.settings.editorFinalNewline;
  if ((trim || finalNL) && cm && state.editor.active === path) {
    try { f.content = cm.normalizeWhitespace(trim, finalNL); } catch { /* ignore */ }
  }
  // The editor doc is always LF internally; restore the file's own EOL on write.
  const onDisk = f.eol === "crlf" ? f.content.replace(/\r?\n/g, "\r\n") : f.content;
  // No success toast — the status bar + tab dirty dot already indicate the save.
  try { await atom.files.write(f.path, onDisk); f.saved = f.content; f.dirty = false; renderEditorTabs(); updateEditorStatus(f); gitGutterRefreshAll(); if (gitProjectRoot()) scheduleGitRefresh(); }
  catch (e) { toast("Save failed: " + e.message, "alert"); }
}

/* Take a file out of the editor without touching disk: drop the tab, refill any
 * pane that was showing it (preferring a file the other pane isn't on), and
 * collapse the split if a pane can't be filled. */
function dropEditorFile(path) {
  const idx = state.editor.open.findIndex((x) => x.path === path);
  if (idx < 0) return;
  state.editor.open.splice(idx, 1);
  for (let p = 0; p < 2; p++) {
    if (state.editor.panes[p] !== path) continue;
    const otherPath = state.editor.panes[p === 0 ? 1 : 0];
    const diff = state.editor.open.find((x) => x.path !== otherPath);
    state.editor.panes[p] = (diff && diff.path) || otherPath || null;
  }
  if (state.editor.split && (!state.editor.panes[0] || !state.editor.panes[1])) {
    state.editor.split = false;
    if (editors[1]) { editors[1].destroy(); editors[1] = null; }
    state.editor.panes[1] = null; state.editor.focused = 0;
  }
  if (!state.editor.panes[0]) state.editor.panes[0] = state.editor.open.length ? state.editor.open[Math.min(idx, state.editor.open.length - 1)].path : null;
  state.editor.active = state.editor.panes[state.editor.focused] || (state.editor.open[0] && state.editor.open[0].path) || null;
  updateEditorLayout();
  highlightTreeFile();
  persistEditor();
}

function closeEditorFile(path) {
  const f = state.editor.open.find((x) => x.path === path);
  if (!f) return;
  const doClose = () => dropEditorFile(path);
  // An untitled buffer has nowhere to be saved TO, so the honest question is
  // "where?", not "are you sure?" — cancelling the picker leaves the tab open
  // rather than quietly discarding what the user just chose to keep.
  if (f.untitled) {
    if (!f.dirty) { doClose(); return; }
    saveChangesDialog({ name: f.name, onSave: async () => { if (await promptWriteBufferTo(f)) doClose(); }, onDiscard: doClose });
    return;
  }
  if (f.dirty) {
    saveChangesDialog({ name: f.name, onSave: async () => { await saveEditorFile(path); doClose(); }, onDiscard: doClose });
    return;
  }
  doClose();
}

/* Save / Don't save / Cancel — the three answers a close on unsaved work has.
 * confirmDialog only offers two, and "Cancel or lose it" isn't the choice. */
function saveChangesDialog({ name, onSave, onDiscard }) {
  const back = modalShell({
    title: `Save changes to ${name}?`, ic: "alert",
    body: h("div", { style: "color:var(--text-2); line-height:1.6; font-size:13.5px", text: "Your changes will be lost if you don't save them." }),
    footer: [
      h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => closeModal(back) }),
      h("button", { class: "btn btn-danger", text: "Don't save", onclick: () => { closeModal(back); onDiscard(); } }),
      h("button", { class: "btn btn-primary", text: "Save", onclick: () => { closeModal(back); onSave(); } }),
    ],
  });
}

function editorTabContextMenu(ev, f) {
  // An untitled buffer has no path to copy, reveal or hand to another app — the
  // only thing worth offering is giving it one.
  showContextMenu(ev.clientX, ev.clientY, f.untitled ? [
    { label: "Save as…", icon: "download", onClick: () => saveEditorAs(f) },
    { sep: true },
    { label: "Close", icon: "close", onClick: () => closeEditorFile(f.path) },
  ] : [
    { label: "Copy file path", icon: "copy", onClick: () => copyText('"' + f.path + '"', "File path copied") },
    { label: "Copy file name", icon: "copy", onClick: () => copyText(f.name, "File name copied") },
    { sep: true },
    { label: "Save as…", icon: "download", onClick: () => saveEditorAs(f) },
    { label: "Open in File Explorer", icon: "external", onClick: () => atom.files.reveal(f.path) },
    { label: "Open externally", icon: "external", onClick: () => atom.files.open(f.path) },
    { sep: true },
    { label: "Close", icon: "close", onClick: () => closeEditorFile(f.path) },
    { label: "Close others", icon: "close", onClick: () => { state.editor.open = state.editor.open.filter((x) => x.path === f.path); state.editor.split = false; if (editors[1]) { editors[1].destroy(); editors[1] = null; } state.editor.panes = [f.path, null]; state.editor.focused = 0; state.editor.active = f.path; updateEditorLayout(); persistEditor(); } },
  ]);
}

async function editorGoToLine(path, line, query, caseSensitive) {
  await openInEditor(path);
  requestAnimationFrame(() => { if (cm) cm.gotoLine(line, 1, query || null); });
}

/* ---- Ctrl+F routing: editor → CM6's search panel; folder/global → palette ---- */
function handleFind() {
  const ae = document.activeElement;
  // Inside the code editor → CM6's own find panel.
  if (cm && cm.view.dom.contains(ae)) { cm.openSearch(); return; }
  // In the agent panel (input focused, or chat is the visible surface) → conversation search.
  const main = $("main");
  const inChat = main && ae && (main.contains(ae) || ae.id === "promptInput");
  if (!document.body.classList.contains("chat-collapsed") && (inChat || !state.editor.active)) { openChatSearch(); return; }
  if (state.findContext === "folder" && state.selectedFolder) return openSearch({ mode: "content", root: state.selectedFolder });
  if (state.editor.active && cm) { cm.openSearch(); return; }
  openSearch({});
}

/* ============================================================
   SEARCH PALETTE (Ctrl+F on a folder / global): file names / contents
   ============================================================ */
// Filters persist for the session: `scope` = one sub-folder (absolute path) to
// search in; `include` / `exclude` = comma-separated globs / .ext / path segments.
const searchState = { mode: "content", caseSensitive: false, wholeWord: false, regex: false, scope: "", include: "", exclude: "" };
function pathInside(p, root) {
  if (!p || !root) return false;
  const f = p.replace(/\\/g, "/").toLowerCase(), r = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return f.startsWith(r + "/");
}
// Expand every ancestor of `folderPath` in the file tree (loading levels on
// demand, like clicking would), select the folder, and scroll it into view.
async function revealFolderInTree(folderPath) {
  const ts = activeTS(); if (!ts || !folderPath) return;
  if (state.sidebarView !== "files") setSidebarView("files");
  const root = (ts.tree.root || "").replace(/[\\/]+$/, "");
  if (!pathInside(folderPath, root)) return;                 // outside this tree
  const sep = root.includes("\\") ? "\\" : "/";
  const ensure = async (dir) => { if (!ts.tree.cache.has(dir)) { try { const d = await atom.files.list(dir); ts.tree.cache.set(dir, d.entries); } catch { ts.tree.cache.set(dir, null); } } };
  await ensure(root);
  let cur = root;
  for (const s of relPath(folderPath, root).split(/[\\/]/).filter(Boolean)) { cur = cur + sep + s; ts.tree.expanded.add(cur); await ensure(cur); }
  state.selectedFolder = cur; state.findContext = "folder";
  renderTree();
  try { const row = $("fileTree").querySelector(`.tree-row[data-path="${CSS.escape(cur)}"]`); if (row) row.scrollIntoView({ block: "center" }); } catch { /* ignore */ }
}

// `rx` = treat q as a regular expression. An invalid pattern falls back to a
// literal match (the user is often mid-typing "foo(" — never throw at them).
function patternFor(q, ww, rx) {
  if (rx) { try { new RegExp(q); return q; } catch { /* fall through to literal */ } }
  let pat = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (ww && !rx) pat = `(?<![\\w$])${pat}(?![\\w$])`;
  return pat;
}
function highlightQuery(text, q, cs, ww, rx) {
  const esc = escHtml(text);
  if (!q) return esc;
  const pat = patternFor(q, ww, rx);
  try { return esc.replace(new RegExp(pat, (cs ? "g" : "gi") + (rx ? "m" : "")), (mm) => `<mark>${mm}</mark>`); } catch { return esc; }
}
function localMatcher(q, cs, ww, rx) {
  const pat = patternFor(q, ww, rx);
  let re = null; try { re = new RegExp(pat, (cs ? "" : "i") + (rx ? "m" : "")); } catch { /* */ }
  return (line) => re ? re.test(line) : (cs ? line.includes(q) : line.toLowerCase().includes(q.toLowerCase()));
}

function openSearch({ mode, root, query } = {}) {
  const ts = activeTS();
  const searchRoot = root || (ts ? ts.meta.cwd : state.settings.lastFolder);
  searchState.mode = mode || (state.editor.active ? "file" : "content");
  // A folder scope from an earlier search only carries over inside this root.
  if (searchState.scope && !pathInside(searchState.scope, searchRoot)) searchState.scope = "";

  const input = h("input", { placeholder: "Search…", value: query || "", spellcheck: "false" });
  const caseBtn = h("button", { class: "search-opt" + (searchState.caseSensitive ? " on" : ""), title: "Match case", text: "Aa", onclick: () => { searchState.caseSensitive = !searchState.caseSensitive; caseBtn.classList.toggle("on", searchState.caseSensitive); run(); } });
  const wordBtn = h("button", { class: "search-opt" + (searchState.wholeWord ? " on" : ""), title: "Whole word", html: "<u>ab</u>", onclick: () => { searchState.wholeWord = !searchState.wholeWord; wordBtn.classList.toggle("on", searchState.wholeWord); run(); } });
  // Regex mode. Whole-word is meaningless for a pattern, so it's disabled while on.
  const reBtn = h("button", { class: "search-opt" + (searchState.regex ? " on" : ""), title: "Use regular expression", text: ".*", onclick: () => { searchState.regex = !searchState.regex; reBtn.classList.toggle("on", searchState.regex); wordBtn.disabled = searchState.regex; run(); } });
  wordBtn.disabled = !!searchState.regex;
  const filtersOn = () => !!(searchState.scope || searchState.include || searchState.exclude);
  const filterBtn = h("button", { class: "search-opt" + (filtersOn() ? " on" : ""), title: "Filters — folder scope, include / exclude patterns", html: icon("filter", 14), onclick: () => { const open = filters.classList.toggle("open"); if (open) incInput.focus(); } });
  const siWrap = h("div", { class: "si-wrap" }, h("span", { html: icon("search", 16) }), input, caseBtn, wordBtn, reBtn, filterBtn);
  input.addEventListener("focus", () => siWrap.classList.add("focused"));
  input.addEventListener("blur", () => siWrap.classList.remove("focused"));

  // ---- filters: folder scope + include / exclude patterns ----
  const scopeSel = h("select", { title: "Limit the search to one folder" });
  const incInput = h("input", { placeholder: "*.js, *.md, src/**", value: searchState.include, spellcheck: "false", title: "Only these paths — globs, .ext, or folder names (comma-separated)" });
  const excInput = h("input", { placeholder: "node_modules, *.log, dist", value: searchState.exclude, spellcheck: "false", title: "Skip these paths — globs, .ext, or folder names (comma-separated)" });
  const clearBtn = h("button", { class: "search-filter-clear", text: "Clear", onclick: () => { searchState.scope = searchState.include = searchState.exclude = ""; incInput.value = excInput.value = ""; scopeSel.value = ""; syncFilterBtn(); run(); } });
  const filters = h("div", { class: "search-filters" + (filtersOn() ? " open" : "") },
    h("div", { class: "search-filter" }, h("label", { text: "In" }), scopeSel),
    h("div", { class: "search-filter" }, h("label", { text: "Include" }), incInput),
    h("div", { class: "search-filter" }, h("label", { text: "Exclude" }), excInput),
    clearBtn);
  function syncFilterBtn() { filterBtn.classList.toggle("on", filtersOn()); }
  let scopeDirs = [];   // top-level folders of the root (filled async)
  function fillScopes() {
    scopeSel.innerHTML = "";
    scopeSel.append(h("option", { value: "", text: "Whole project" }));
    const seen = new Set();
    const add = (p, label) => { if (!p || seen.has(p.toLowerCase())) return; seen.add(p.toLowerCase()); scopeSel.append(h("option", { value: p, text: label || relPath(p, searchRoot) + "/" })); };
    if (state.selectedFolder && pathInside(state.selectedFolder, searchRoot)) add(state.selectedFolder, "Selected: " + relPath(state.selectedFolder, searchRoot) + "/");
    if (searchState.scope) add(searchState.scope);
    for (const d of scopeDirs) add(d);
    scopeSel.value = searchState.scope || "";
  }
  fillScopes();
  atom.files.list(searchRoot).then((d) => { scopeDirs = ((d && d.entries) || []).filter((e) => e.isDir && !e.skip).map((e) => e.path); fillScopes(); }).catch(() => {});
  scopeSel.addEventListener("change", () => { searchState.scope = scopeSel.value; syncFilterBtn(); run(); });
  let ftimer = null;
  const onFilterInput = () => { searchState.include = incInput.value.trim(); searchState.exclude = excInput.value.trim(); syncFilterBtn(); clearTimeout(ftimer); ftimer = setTimeout(run, 300); };
  for (const el of [incInput, excInput]) {
    el.addEventListener("input", onFilterInput);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(ftimer); onFilterInput(); clearTimeout(ftimer); run(); } else if (e.key === "Escape") closeModal(back); });
  }
  // Scope the search to a folder (from a folder result's "search inside" action).
  function scopeTo(dir) { searchState.scope = dir; fillScopes(); syncFilterBtn(); filters.classList.add("open"); searchState.mode = "content"; drawModes(); run(); }
  const effRoot = () => searchState.scope || searchRoot;
  // Filters are resolved against the PROJECT root (base) even when scoped, so
  // "src/**" means the same thing whichever folder is selected.
  const fopts = () => ({ root: effRoot(), base: searchRoot, include: searchState.include || undefined, exclude: searchState.exclude || undefined });
  const filterNote = () => { const p = []; if (searchState.scope) p.push("in " + relPath(searchState.scope, searchRoot) + "/"); if (searchState.include) p.push(searchState.include); if (searchState.exclude) p.push("− " + searchState.exclude); return p.length ? " · " + p.join(" · ") : ""; };

  const modesRow = h("div", { class: "search-modes" });
  const MODES = [{ id: "file", name: "This file", icon: "fileCode" }, { id: "folders", name: "Folders", icon: "folder" }, { id: "names", name: "File names", icon: "file" }, { id: "content", name: "In files", icon: "search" }];
  function drawModes() { modesRow.innerHTML = ""; for (const m of MODES) modesRow.append(h("button", { class: "search-mode" + (m.id === searchState.mode ? " active" : ""), onclick: () => { searchState.mode = m.id; drawModes(); run(); } }, h("span", { html: icon(m.icon, 15) }), m.name)); }
  drawModes();

  const summary = h("div", { class: "search-summary" });
  const results = h("div", { class: "search-results" });
  const body = h("div", {}, h("div", { class: "search-input-row" }, siWrap), filters, modesRow, summary, results);
  const back = modalShell({ title: "Search", ic: "search", wide: true, body });
  back.querySelector(".modal").classList.add("search-modal");
  setTimeout(() => { input.focus(); input.select(); }, 40);

  let timer = null;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 260); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); run(); } else if (e.key === "Escape") closeModal(back); });

  function matchPreview(m, q) {
    const wrap = h("div", { style: "display:inline-block; vertical-align:top" });
    if (m.before != null) wrap.append(h("div", { class: "srm-ctx", text: m.before }));
    wrap.append(h("div", { class: "srm-hit", html: highlightQuery(m.text, q, searchState.caseSensitive, searchState.wholeWord, searchState.regex) }));
    if (m.after != null) wrap.append(h("div", { class: "srm-ctx", text: m.after }));
    return wrap;
  }

  async function run() {
    const q = input.value.trim();
    results.innerHTML = ""; summary.textContent = "";
    if (!q) { results.append(h("div", { class: "search-empty", text: "Type to search." })); return; }

    if (searchState.mode === "file") {
      const f = stateActiveFile();
      if (!f) { results.append(h("div", { class: "search-empty", text: "No file open. Open a file to search within it." })); return; }
      syncFileContent(f, cm);   // f.content is lazily synced — bring it current first
      const match = localMatcher(q, searchState.caseSensitive, searchState.wholeWord, searchState.regex);
      const lines = f.content.split("\n");
      let count = 0; const frag = [];
      for (let i = 0; i < lines.length && frag.length < 800; i++) if (match(lines[i])) { count++; frag.push({ line: i + 1, text: lines[i].slice(0, 240) }); }
      summary.textContent = `${count} match${count !== 1 ? "es" : ""} in this file`;
      if (!count) { results.append(h("div", { class: "search-empty", text: "No matches in this file." })); return; }
      for (const r of frag) results.append(h("div", { class: "sr-match", onclick: () => { closeModal(back); editorGoToLine(f.path, r.line, q, searchState.caseSensitive); } },
        h("span", { class: "srm-line", text: String(r.line) }), matchPreview({ text: r.text, before: null, after: null }, q)));
      return;
    }

    summary.textContent = "Searching…";
    if (searchState.mode === "names" || searchState.mode === "folders") {
      const kind = searchState.mode === "folders" ? "folders" : "files";
      const r = await atom.files.searchNames({ ...fopts(), query: q, kind }).catch(() => ({ files: [] }));
      const noun = kind === "folders" ? "folder" : "file";
      summary.textContent = `${r.files.length} ${noun}${r.files.length !== 1 ? "s" : ""}${r.truncated ? "+" : ""}${filterNote()}`;
      if (!r.files.length) { results.append(h("div", { class: "search-empty", text: `No ${noun}s match.` })); return; }
      for (const f of r.files) {
        if (f.isDir) {
          // Folder hit: click reveals it in the tree; the trailing action scopes
          // a content search to it without leaving the modal.
          results.append(h("div", { class: "sr-name-row is-dir", title: "Reveal in file tree", onclick: () => { closeModal(back); revealFolderInTree(f.path); } },
            h("span", { class: "tw-icon ft-folder", html: icon("folder", 15) }), h("span", { class: "srn-name", text: f.name }), h("span", { class: "srn-path", text: relPath(f.path, searchRoot) }),
            h("button", { class: "srn-act", title: "Search inside this folder", html: icon("search", 13), onclick: (ev) => { ev.stopPropagation(); scopeTo(f.path); } })));
        } else {
          const sm = fileMeta(f.name);
          results.append(h("div", { class: "sr-name-row", onclick: () => { closeModal(back); openInEditor(f.path); } },
            h("span", { class: "tw-icon " + sm.cls, html: icon(sm.ic, 15) }), h("span", { class: "srn-name " + sm.cls, text: f.name }), h("span", { class: "srn-path", text: relPath(f.path, searchRoot) })));
        }
      }
      return;
    }

    // content
    const r = await atom.files.searchContent({ ...fopts(), query: q, caseSensitive: searchState.caseSensitive, wholeWord: searchState.wholeWord, regex: searchState.regex }).catch(() => ({ results: [], fileCount: 0, matchCount: 0 }));
    summary.textContent = `${r.matchCount} result${r.matchCount !== 1 ? "s" : ""} in ${r.fileCount} file${r.fileCount !== 1 ? "s" : ""}${r.truncated ? " · truncated" : ""}${filterNote()}`;
    if (!r.results.length) { results.append(h("div", { class: "search-empty", text: "No matches found." })); return; }
    for (const file of r.results) {
      const grp = h("div", { class: "sr-file" });
      grp.append(h("div", { class: "sr-file-head", onclick: () => { closeModal(back); openInEditor(file.path); } },
        h("span", { html: icon("fileCode", 14) }), h("span", { class: "srf-name", text: file.name }),
        h("span", { class: "srf-path", text: relPath(file.path, searchRoot) }), h("span", { class: "srf-count", text: String(file.matches.length) })));
      for (const m of file.matches) grp.append(h("div", { class: "sr-match", onclick: () => { closeModal(back); editorGoToLine(file.path, m.line, q, searchState.caseSensitive); } },
        h("span", { class: "srm-line", text: String(m.line) }), matchPreview(m, q)));
      results.append(grp);
    }
  }
  run();
}

/* ----------------------------- go ----------------------------- */
init()
  .then(() => console.log("AtomNano renderer initialized OK"))
  .catch((e) => { console.error("AtomNano init failed:", e && e.stack ? e.stack : e); document.body.innerHTML = `<pre style="padding:40px;color:#e87a64">AtomNano failed to start:\n${e.stack || e}</pre>`; });
