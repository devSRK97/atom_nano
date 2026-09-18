/* AtomNano renderer — History modal — every saved conversation.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { baseName, closeModal, h, modalShell, samePath, timeAgo, toast } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { deleteSession, renameSession, switchTab } from "../git/conflicts-ui.js";
import { icon } from "../icons.js";
import { segmented } from "../settings/settings.js";
import { persistTabs } from "../workspace/projects.js";
import { addTabState, renderTabs } from "./tabs.js";

/* ============================================================
   HISTORY MODAL
   ============================================================ */
export async function openHistory() {
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
export async function openSessionTab(id) {
  if (state.tabs.has(id)) { await switchTab(id); return; }
  const full = await atom.sessions.get(id);
  if (!full) return;
  addTabState(full);
  state.order.push(id);
  await switchTab(id);
}
// Open a tab for a session view WITHOUT switching to it — a role job's child session landing in
// the orchestrator's window (session:created). The tab goes right after its parent (after any earlier
// siblings, so jobs keep their start order); focus, the composer and the chat stay where they are.
// The tab order is persisted the way openSessionTab's switch persists it. Returns false if the
// session already has a tab.
export function openSessionTabQuiet(view) {
  if (!view || !view.id || state.tabs.has(view.id)) return false;
  addTabState(view);
  const parentIdx = view.parentId ? state.order.indexOf(view.parentId) : -1;
  if (parentIdx < 0) state.order.push(view.id);
  else {
    let at = parentIdx + 1;
    while (at < state.order.length) { const t = state.tabs.get(state.order[at]); if (t && t.meta.parentId === view.parentId) at++; else break; }
    state.order.splice(at, 0, view.id);
  }
  renderTabs();
  persistTabs();
  return true;
}
