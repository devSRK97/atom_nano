/* AtomNano renderer — Fleet dock — background agents on a queue.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { openSessionTab } from "../chat/history.js";
import { $, baseName, h, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { icon } from "../icons.js";
import { currentDock, dockHead, toggleFleet } from "./changes.js";

/* ============================================================
   FLEET PANEL — dispatch background agents on a queue
   ============================================================ */
export let fleetSnap = { tasks: [], running: 0, queued: 0, maxConcurrent: 0 };
export let fleetDraft = "";
// Setters for other modules (an imported binding cannot be assigned directly).
export function setFleetSnap(snap) { fleetSnap = snap || fleetSnap; }
export function setFleetDraft(text) { fleetDraft = text; }
export function refreshFleet() { atom.fleet.list().then((s) => { fleetSnap = s || fleetSnap; if (currentDock() === "fleet") renderFleet(); }).catch(() => {}); }
export async function renderFleet() {
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
export async function dispatchFleet() {
  if (!state.project) return;
  const ta = $("fleetInput");
  const items = (ta ? ta.value : "").split("\n").map((s) => s.trim()).filter(Boolean).map((p) => ({ prompt: p }));
  if (!items.length) return;
  fleetDraft = ""; if (ta) ta.value = "";
  try { const made = await atom.fleet.enqueueMany(state.project, items); toast(`Dispatched ${made.length} agent${made.length > 1 ? "s" : ""}`, "cpu"); }
  catch (e) { toast(String((e && e.message) || e), "alert"); }
  refreshFleet();
}
export const FLEET_BADGE = { queued: "Queued", running: "Running", done: "Done", error: "Failed", canceled: "Canceled", interrupted: "Interrupted", blocked: "Waiting" };
export function fleetRow(t) {
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
