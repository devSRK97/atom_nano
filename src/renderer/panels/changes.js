/* AtomNano renderer — Changed-files dock.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { openFileAtFirstChange, scrollBottom } from "../chat/messages.js";
import { $, baseName, h, relPath } from "../core/dom.js";
import { activeTS } from "../core/state.js";
import { computeEditorOverflow } from "../editor/editor-pane.js";
import { icon } from "../icons.js";
import { fileContextMenu } from "../workspace/sidebar.js";
import { refreshBoardDock, renderBoard } from "./board.js";
import { refreshFleet, renderFleet } from "./fleet.js";
import { renderTests } from "./tests.js";

/* ============================================================
   CHANGES PANEL
   ============================================================ */
// The right side hosts one of the mutually-exclusive docks (Changes / Fleet / Tests / Agents /
// Task board), all sharing the same resizable width (--changes-w). (The Skills dock left on
// 2026-09-18 — skills live in the Workflow Studio's Skills modal.)
export const DOCKS = { changes: "changesPanel", fleet: "fleetPanel", tests: "testsPanel", agents: "agentsPanel", board: "boardPanel" };
export function currentDock() {
  for (const [name, id] of Object.entries(DOCKS)) if (!$(id).classList.contains("hidden")) return name;
  return null;
}
export function showDock(name) {
  for (const [n, id] of Object.entries(DOCKS)) $(id).classList.toggle("hidden", n !== name);
  $("changesResizer").classList.toggle("hidden", !name);
  const fb = $("fleetBtn"), tb = $("testsBtn");
  if (fb) fb.classList.toggle("active", name === "fleet");
  if (tb) tb.classList.toggle("active", name === "tests");
}
export function toggleDock(name, render) {
  if (currentDock() === name) { showDock(null); return; }
  showDock(name); render();
}
export function toggleChanges() { toggleDock("changes", renderChanges); }
export function toggleFleet() { if (currentDock() === "fleet") { showDock(null); } else { showDock("fleet"); renderFleet(); refreshFleet(); } }
export function toggleTests() { toggleDock("tests", renderTests); }
// Task board (docs/WORKFLOW_CONTRACT.md §8): render the tab's copy at once, then pull the board from main.
export function toggleBoard() { if (currentDock() === "board") { showDock(null); } else { showDock("board"); renderBoard(); refreshBoardDock(); } }
// Shared dock header (icon + title + subtitle + extra buttons + close).
export function dockHead(ic, title, sub, onClose, extra = []) {
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
export function toggleChat(force) {
  const hide = force != null ? force : !document.body.classList.contains("chat-collapsed");
  document.body.classList.toggle("chat-collapsed", hide);
  const btn = $("chatToggle");
  if (btn) { btn.classList.toggle("active", hide); btn.title = hide ? "Show chat (Ctrl+\\)" : "Hide chat (Ctrl+\\)"; }
  if (!hide) scrollBottom(true);   // re-anchor the conversation when shown again
  requestAnimationFrame(computeEditorOverflow);  // editor width changed
}
export function renderChanges() {
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
