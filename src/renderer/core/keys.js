/* AtomNano renderer — Global keyboard shortcuts and the pane resizers.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { stopSession } from "../chat/composer.js";
import { openHistory } from "../chat/history.js";
import { updateScrollBtn } from "../chat/messages.js";
import { openPromptPicker } from "../chat/navigation.js";
import { computeSessionOverflow } from "../chat/tabs.js";
import { cm, computeEditorOverflow, newUntitledFile, saveEditorAs, stateActiveFile, toggleMarkdownPreview, toggleSplit } from "../editor/editor-pane.js";
import { closeEditorFile, editorFindReferences, handleFind, navGo, openSymbolPicker, saveEditorFile, toggleProblems } from "../editor/symbols.js";
import { closeTab, newTab, switchTab } from "../git/conflicts-ui.js";
import { toggleChat } from "../panels/changes.js";
import { openSettings } from "../settings/settings.js";
import { pickAndOpenProject } from "../workspace/projects.js";
import { toggleTerminal } from "../workspace/terminal.js";
import { $, closeModal, hideContextMenu } from "./dom.js";
import { activeTS, state } from "./state.js";

/* ============================================================
   KEYS + RESIZERS
   ============================================================ */
export function wireGlobalKeys() {
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
export function cycleTab(dir) {
  const i = state.order.indexOf(state.activeTabId);
  const n = (i + dir + state.order.length) % state.order.length;
  switchTab(state.order[n]);
}
export function wireResizers() {
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
export function makeResizer(el, onMove) {
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
