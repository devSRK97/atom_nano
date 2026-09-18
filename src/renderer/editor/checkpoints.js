/* AtomNano renderer — Checkpoints — snapshot / restore the open files around an agent run.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { closeModal, confirmDialog, h, modalShell, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { scheduleGitRefresh } from "../git/sidebar.js";
import { gitProjectRoot } from "../git/titlebar.js";
import { icon } from "../icons.js";
import { gitGutterRefreshAll, loadPaneFile, renderEditorTabs, stateActiveFile } from "./editor-pane.js";
import { updateEditorStatus } from "./symbols.js";

/* ============================================================
   CHECKPOINTS — snapshot/restore the open files around an agent run.
   A reversible "undo the whole edit" independent of Git: one is captured
   automatically before each message you send, plus on demand.
   ============================================================ */
export let _cpSeq = 0;
export async function createCheckpoint(label) {
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
export async function restoreCheckpoint(id) {
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
export function openCheckpoints() {
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
