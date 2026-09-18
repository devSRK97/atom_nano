/* AtomNano renderer — DOM helpers — h(), toast, tooltips, dropdowns, context menu, modals and dialogs.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { icon } from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { atom } from "./state.js";

/* ----------------------------- DOM helpers ----------------------------- */
export function h(tag, props = {}, ...kids) {
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
export const $ = (id) => document.getElementById(id);
export function timeAgo(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
export function baseName(p) { return (p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p; }
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}
export function relPath(full, root) {
  if (!full || !root) return full;
  const f = full.replace(/\\/g, "/"), r = root.replace(/\\/g, "/").replace(/\/$/, "");
  return f.startsWith(r) ? f.slice(r.length).replace(/^\//, "") || baseName(full) : full;
}
export function fmtDur(ms) { return ms ? (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`) : "—"; }
export function fmtTime(iso) {
  try { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
  catch { return ""; }
}
export let toastTimer = null;
export function toast(msg, ic = "check", opts = {}) {
  const t = $("toast");
  t.className = "toast" + (opts.tone ? " toast-" + opts.tone : "");
  const dots = opts.dots ? `<span class="tdots"><i></i><i></i><i></i></span>` : "";
  t.innerHTML = `${icon(ic, 16, opts.spin ? "spin" : "")}<span>${msg}</span>${dots}`;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  if (!opts.sticky) toastTimer = setTimeout(() => t.classList.add("hidden"), opts.ms || 2200);
}
export function hideToast() { clearTimeout(toastTimer); const t = $("toast"); if (t) t.classList.add("hidden"); }
export async function copyText(text, label = "Copied to clipboard", html) {
  try { await atom.clipboard.write(text, html || null); toast(label); } catch { toast("Copy failed", "alert"); }
}
// Render an assistant/user message's markdown to standalone HTML for the clipboard,
// with inline styles so tables/code keep their structure when pasted into Word,
// Google Docs, email, etc. (those apps ignore the app's CSS classes). The plain-text
// flavor stays the raw markdown — perfect for a text editor or .md file.
export function styleRichHtml(html) {
  const cellBase = "border:1px solid #bbb;padding:4px 9px;text-align:left";
  const styled = String(html || "")
    .replace(/<table[^>]*>/g, '<table style="border-collapse:collapse;border:1px solid #bbb">')
    .replace(/<th([^>]*)>/g, `<th$1 style="${cellBase};background:#f2f2f2;font-weight:600">`)
    .replace(/<td([^>]*)>/g, `<td$1 style="${cellBase}">`)
    .replace(/<pre[^>]*>/g, '<pre style="background:#f5f5f5;padding:10px;border-radius:5px;white-space:pre-wrap;font-family:Consolas,Menlo,monospace">')
    .replace(/<code>/g, '<code style="font-family:Consolas,Menlo,monospace">');
  return '<div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5">' + styled + "</div>";
}
export function mdToRichHtml(md) { return styleRichHtml(renderMarkdown(md || "")); }
// The current selection's HTML (preserves rendered tables/styling for a partial copy).
export function selectionHtml() {
  const s = window.getSelection && window.getSelection();
  if (!s || !s.rangeCount || s.isCollapsed) return "";
  const div = document.createElement("div");
  for (let i = 0; i < s.rangeCount; i++) div.appendChild(s.getRangeAt(i).cloneContents());
  return div.innerHTML;
}
/* ----------------------------- dropdown -----------------------------
   Menu is rendered fixed on <body> so it is never clipped by the composer. */
export function dropdown({ ic, items, getValue, onSelect, align = "left" }) {
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
export let _ctxMenuOpen = false;
export function showContextMenu(x, y, items) {
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
export function hideContextMenu() { $("ctxMenu").classList.add("hidden"); _ctxMenuOpen = false; }
document.addEventListener("mousedown", (e) => { if (!$("ctxMenu").contains(e.target)) hideContextMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && _ctxMenuOpen) hideContextMenu(); });
/* ---- right-click menu for text inputs / textareas (Cut/Copy/Paste/Select All) ---- */
export const _INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", "password", "number", ""]);
export function inputSel(el) { const s = el.selectionStart || 0, e = el.selectionEnd || 0; return { s, e, has: s !== e }; }
export async function inputCopy(el) { const { s, e, has } = inputSel(el); const t = has ? el.value.slice(s, e) : el.value; if (t) await atom.clipboard.write(t); }
export async function inputCut(el) {
  if (el.readOnly || el.disabled) return;
  const { s, e, has } = inputSel(el);
  await atom.clipboard.write(has ? el.value.slice(s, e) : el.value);
  el.focus();
  if (has) el.setSelectionRange(s, e); else el.select();
  document.execCommand("delete");
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
export async function inputPaste(el) {
  if (el.readOnly || el.disabled) return;
  const t = await atom.clipboard.read().catch(() => "");
  if (!t) return;
  const { s, e } = inputSel(el);
  el.focus(); el.setSelectionRange(s, e);
  document.execCommand("insertText", false, t);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
export function inputContextMenu(ev, el) {
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
export function openModal(node) {
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
export function closeModal(back) { if (!back) return; back.remove(); try { back.dispatchEvent(new Event("modal-closed")); } catch { /* */ } }
export function modalShell({ title, ic, wide, body, footer }) {
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
   CONFIRM DIALOG
   ============================================================ */
/* Dialog contract (shared by every caller, Git Center included): each dialog RETURNS
 * a Promise that settles exactly once on every close path — confirm, Cancel, ×,
 * backdrop, Escape. `onConfirm` / `onCancel` callbacks are still honoured for the
 * older call sites. confirmDialog → boolean · promptDialog → string | null ·
 * chooseDialog → choice value | null. */
export function confirmDialog({ title, message, confirmLabel = "Confirm", danger, ic, onConfirm, onCancel }) {
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
export function promptDialog({ title, ic = "edit", message, placeholder = "", value = "", confirmLabel = "OK", onConfirm, onCancel }) {
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
