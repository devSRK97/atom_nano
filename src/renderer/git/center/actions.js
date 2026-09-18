/* AtomNano renderer — Git Center — running one repo-bound action (busy state, typed results, conflicts), all-repos runs, failure toasts, prompts and confirms.
 * One of the modules the former single gitcenter.js was split into (see git/center/index.js). */
import { renderBar, renderCmpBar, renderMain, renderStateBar, renderTabs } from "./render.js";
import { refreshAll, refreshRepo } from "./repos.js";
import { conflicts, D, errText, h, icon, isOpen, q, repoName, S, statusOk } from "./state.js";
import { pickList } from "./widgets.js";

/* ============================ actions ============================ */
/* Run ONE mutating action for ONE repository (captured at the start, never re-read
 * from S.repo). Busy state disables mutation controls semantically; a second
 * submission for the same repo while one is in flight is ignored. The typed result
 * is returned: { ok, state, ... } — conflicts open the Changes tab (or `onConflict`),
 * failures toast with complete diagnostics, never a success message. */
export async function act(label, fn, { repo = S.repo, silent, onConflict, refresh = true } = {}) {
  if (!repo) return { ok: false, state: "failed", error: "No repository selected" };
  if (S.inflight.get(repo)) { D.toast(`<b>${D.esc(S.inflight.get(repo))}</b><span class="toast-sub">is still running in ${D.esc(repoName(repo))} — wait for it to finish.</span>`, "alert", { ms: 2600 }); return { ok: false, state: "busy", busy: true }; }
  S.inflight.set(repo, label); S.busy++; setBusy(true);
  if (!silent) D.toast(D.esc(label) + "…", "spinner", { sticky: true, spin: true });
  let res = null, err = null;
  try { res = await fn(repo); } catch (e) { err = e; }
  S.inflight.delete(repo); S.busy--; setBusy(S.busy > 0);
  if (err) { failToast(label, err, repo); if (refresh) await refreshRepo(repo); return { ok: false, state: "failed", error: errText(err), type: err && err.type, details: err && err.details, failed: true }; }
  if (refresh) await refreshRepo(repo);
  const state = res && res.state ? res.state : (res && res.ok === false ? (res.conflict ? "conflict" : "failed") : "success");
  if (state === "conflict" || (res && res.conflict)) {
    D.toast(`<b>${D.esc(label)}: conflicts in ${D.esc(repoName(repo))}</b><span class="toast-sub">Per file: Keep mine · Accept incoming · Resolve lines… — then Continue from the banner.</span>`, "alert", { ms: 6500 });
    if (onConflict) onConflict(res); else if (repo === S.repo) showConflicts();
    return { ...res, ok: false, state: "conflict", conflict: true };
  }
  if (state === "rejected" || state === "choice" || state === "busy") return res;
  if (state === "partial") { D.toast(`<b>${D.esc(label)}: partly done</b><span class="toast-sub">${D.esc(partialSummary(res))}</span>`, "alert", { ms: 7000 }); return res; }
  if (state === "failed" || (res && res.ok === false)) { D.toast(`<b>${D.esc(label)} failed</b><span class="toast-sub">${D.esc(res && (res.error || res.message) || "see details")}</span>`, "alert", { ms: 7000 }); return { ...res, ok: false, state: "failed", failed: true }; }
  if (!silent) D.toast(D.esc(label) + " done", "checkCircle", { ms: 2600 });
  return res || { ok: true, state: "success" };
}
export function partialSummary(res) {
  if (!res) return "";
  if (Array.isArray(res.results)) { const bad = res.results.filter((x) => !x.ok); return bad.map((x) => `${x.path || ""}${x.phase ? ` (${x.phase})` : ""}: ${x.error || "failed"}`).join(" · ") || res.error || ""; }
  if (res.reconcileError) return `Committed ${String(res.commit || "").slice(0, 7)}, but the index could not be updated for: ${res.reconcileError}`;
  if (res.phases) return Object.entries(res.phases).filter(([, v]) => v).map(([k, v]) => `${k}: ${v.ok ? "done" : (v.error || "failed")}`).join(" · ");
  return res.error || "";
}
// Failure toast with a "Details" affordance that opens the complete diagnostics.
export function failToast(label, err, repo) {
  const msg = errText(err);
  const details = err && err.details;
  D.toast(`<b>${D.esc(label)} failed${repo ? ` (${D.esc(repoName(repo))})` : ""}</b><span class="toast-sub">${D.esc(msg)}${details && details.trim() && details.trim() !== msg ? " — details in the Git panel" : ""}</span>`, "alert", { ms: 7000 });
  if (details && details.trim() && details.trim() !== msg && isOpen()) showErrorDetails(label, err);
}
export function showErrorDetails(label, err) {
  const st = q(".gitc-state"); if (!st) return;
  st.classList.remove("hidden", "stale"); st.classList.add("error"); st.innerHTML = "";
  st.append(h("span", { class: "gitc-state-ic", html: icon("alert", 14) }), h("b", { text: `${label} failed` }), h("span", { text: errText(err) }),
    h("div", { class: "gitc-spacer" }),
    h("button", { class: "gitc-act sm", onclick: () => { const back = D.modalShell({ title: `${label} — git output`, ic: "alert", wide: true, body: h("div", {}, err.type ? h("span", { class: "gitc-errtype", text: err.type }) : null, h("pre", { class: "gitc-errdetails", text: err.details || errText(err) })) }); back.querySelector(".modal").classList.add("gitc-fileview-modal"); } }, "Details"),
    h("button", { class: "gitc-act sm", onclick: () => renderStateBar() }, "Dismiss"));
}
export function setBusy(on) {
  const p = q(".gitc-progress"); if (p) { p.classList.toggle("on", !!on); p.setAttribute("aria-hidden", on ? "false" : "true"); }
  if (S.back) { S.back.classList.toggle("busy", !!on); const panel = q(".gitc-panel"); if (panel) panel.setAttribute("aria-busy", on ? "true" : "false"); }
  syncMutationControls();
}
// Buttons that mutate are DISABLED (keyboard included) while the repo is busy or unreadable.
export function syncMutationControls() {
  if (!S.back) return;
  const busy = !!S.inflight.get(S.repo), bad = !!S.repo && !statusOk(S.repo);
  S.back.classList.toggle("readonly", bad);
  for (const el of S.back.querySelectorAll(".gitc-act.mut, .gitc-ibtn.mut, .gitc-hbtn.mut")) { if (busy || bad) { if (!el.disabled) { el.dataset.busyDisabled = "1"; el.disabled = true; } } else if (el.dataset.busyDisabled) { delete el.dataset.busyDisabled; el.disabled = false; } }
}
/* Run one action per repository, sequentially, and summarise EVERY result by state
 * (success / conflict / rejected / failed / partial). A conflict is never a success. */
export async function forAll(label, fn, filter) {
  const list = S.repos.filter((r) => !filter || filter(r));
  if (!list.length) { D.toast("Nothing to " + label.toLowerCase(), "check"); return [];
  }
  const results = [];
  for (const r of list) {
    D.toast(`${D.esc(label)} ${D.esc(repoName(r))}…`, "spinner", { sticky: true, spin: true });
    if (S.inflight.get(r)) { results.push({ r, state: "busy", ok: false, err: "another operation is running" }); continue; }
    S.inflight.set(r, label); S.busy++; setBusy(true);
    try {
      const res = await fn(r);
      const state = res && res.state ? res.state : (res && res.ok === false ? (res.conflict ? "conflict" : "failed") : "success");
      results.push({ r, res, state, ok: state === "success", err: state === "success" ? "" : (state === "conflict" ? "conflicts to resolve" : state === "rejected" ? (res.error || "push rejected — pull first") : (res && (res.error || res.message)) || state) });
    } catch (e) { results.push({ r, state: "failed", ok: false, err: errText(e) }); }
    finally { S.inflight.delete(r); S.busy--; setBusy(S.busy > 0); }
  }
  const bad = results.filter((x) => !x.ok);
  D.toast(bad.length ? `<b>${D.esc(label)}: ${results.length - bad.length} ok, ${bad.length} need attention</b><span class="toast-sub">${bad.map((x) => D.esc(repoName(x.r)) + ": " + D.esc(x.err)).join("<br>")}</span>` : `${D.esc(label)} done for ${results.length} repo${results.length > 1 ? "s" : ""}`, bad.length ? "alert" : "checkCircle", { ms: bad.length ? 8000 : 3200 });
  await refreshAll();
  const conf = results.find((x) => x.state === "conflict");
  if (conf && conf.r === S.repo) showConflicts();
  return results;
}
// Line-level resolver (full-screen overlay on top of the Git Center). The conflicted
// paths are passed explicitly so it never depends on the sidebar's git state.
export function openResolver(file, repo = S.repo) {
  const list = conflicts(repo);
  if (!list.length) { refreshRepo(repo); return; }
  Promise.resolve(D.refreshGit()).catch(() => {}).then(() => D.openConflictResolver(repo, file || list[0], list));
}
// Conflicts arrived (pull / merge / rebase): land on the Changes tab where every
// conflicted file has Keep mine / Accept incoming / Resolve lines… — no modal jumps.
export function showConflicts() { S.mode = "tabs"; S.tab = "changes"; renderBar(); renderTabs(); renderCmpBar(); renderMain(); }
export async function confirmDanger(title, message, label) {
  const c = await D.chooseDialog({ title, ic: "alert", message, choices: [{ label, value: "yes", primary: true }, { label: "Cancel", value: null }] });
  return c === "yes";
}
// Text prompt → string, or null on ANY dismissal (Cancel, ×, Escape, backdrop).
export function prompt(opts) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const r = D.promptDialog({ ...opts, onConfirm: (v) => finish(v == null ? "" : v), onCancel: () => finish(null) });
    if (r && typeof r.then === "function") r.then((v) => finish(v === undefined ? null : v), () => finish(null));
  });
}
// Choose a remote by name: the only one when one exists, else a picker. `prefer` wins when present.
export async function chooseRemote(repo, anchor, { prefer, title = "Which remote?" } = {}) {
  let names = [];
  try { names = (await D.atom.git.remotes(repo)).remotes.map((r) => r.name); } catch { names = []; }
  if (!names.length) { D.toast("This repository has no remotes — add one in the Remotes tab.", "alert"); return ""; }
  if (prefer && names.includes(prefer)) return prefer;
  if (names.length === 1) return names[0];
  return new Promise((resolve) => pickList(anchor || q(".gitc-bar"), { items: names.map((n) => ({ value: n, label: n, icon: "globe" })), placeholder: title, width: 320, onPick: (v) => resolve(v), onCancel: () => resolve("") }));
}
