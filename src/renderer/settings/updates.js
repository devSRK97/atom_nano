/* Settings › Providers — the seamless updater (Claude CLI + Agent SDK) and the per-provider
 * tool list (install / update each CLI + SDK in place, re-discovering models afterwards). */
import { loadProviderModels } from "../core/catalog.js";
import { $, h, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { icon } from "../icons.js";
import { chooseDialog } from "../workspace/projects.js";

export async function checkUpdatesAndChip(opts) {
  try {
    const u = await atom.updates.check(opts || null);
    state.updates = u;
    const chip = $("updateChip");
    if (chip) chip.classList.toggle("hidden", !(u && u.updateAvailable));
  } catch { /* offline / npm missing — ignore */ }
}

const PROVIDER_TOOLS = [
  { provider: "anthropic", label: "Anthropic (Claude)", keys: ["claudeCli", "agentSdk"] },
  { provider: "openai", label: "OpenAI (Codex)", keys: ["codex", "codexSdk"] },
];

// Two panels that refresh each other: "Updates" (one-click, restarts when done) and the tool
// list. Returns their elements; the field wrappers around them come from the category.
export function createUpdatePanels() {
  const updBox = h("div", { class: "st-updates" });
  const toolsBox = h("div", { class: "st-tools" });
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
    // Re-discover models + thinking levels + 1M flags — FORCE the live CLI alias probe and toast any new models.
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
    const u = state.updates;
    const host = h("div", { class: "st-upd-rows" });
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
      h("div", { class: "st-btn-row" },
        h("button", { class: "btn btn-ghost btn-sm", disabled: updBusy, html: `${icon("refresh", 14)}<span>Check for updates</span>`, onclick: async () => { toast("Checking…", "refresh"); await checkUpdatesAndChip({ fresh: true }); renderUpdates(); renderTools(); } }),
        (canUpdate || updBusy) ? h("button", { class: "btn btn-primary btn-sm", disabled: updBusy, html: `${icon("arrowUp", 14)}<span>${updBusy ? "Updating…" : "Update now"}</span>`, onclick: () => runUpdateFlow() }) : null));
    if (updLog.length) {
      const logEl = h("div", { class: "upd-log" });
      for (const line of updLog) logEl.append(h("div", { class: "upd-log-line", text: line }));
      updBox.append(logEl);
    }
  }
  let toolsGen = 0;   // stale-render guard for the async second pass
  async function renderTools() {
    const gen = ++toolsGen;
    toolsBox.innerHTML = "";
    // Pass 1 — installed versions (offline, instant).
    const tv = await atom.updates.toolVersions().catch(() => null);
    if (gen !== toolsGen) return;
    if (!tv) { toolsBox.append(h("div", { class: "hint", style: "margin:0", text: "Couldn't detect the tools." })); return; }
    const verEls = {}, btnEls = {};
    for (const grp of PROVIDER_TOOLS) {
      if (!grp.keys.some((k) => tv[k])) continue;
      toolsBox.append(h("div", { class: "st-sub", text: grp.label }));
      const list = h("div", { class: "tools-list" });
      for (const key of grp.keys) {
        const t = tv[key]; if (!t) continue;
        const verEl = h("span", { class: "tool-ver" + (t.present ? "" : " absent"), text: t.present ? ("v" + (t.version || "?")) : "not installed" });
        const btn = h("button", { class: "btn btn-ghost btn-sm", html: `${icon("arrowUp", 13)}<span>${t.present ? "Update" : "Install"}</span>`, onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; b.innerHTML = `${icon("spinner", 13)}<span>…</span>`;
          const r = await atom.updates.updateTool(key).catch((err) => ({ ok: false, detail: (err && err.message) || "failed" }));
          // Installed-on-disk vs ACTIVE: an update is only "active" once the runtime that serves turns runs it — say which it is.
          const act = r.ok ? (r.restartRequired ? " · installed — restart AtomNano to activate" : (r.activation ? " · " + r.activation : "")) : "";
          toast(`${t.name} — ${r.detail || (r.ok ? "updated" : "update failed")}${act}`, r.ok ? (r.restartRequired ? "alert" : "check") : "alert", { ms: r.ok && (r.restartRequired || r.activation) ? 8000 : 4000 });
          if (r.ok) {
            // Refresh the capability catalog, then FORCE re-discovery of the ACTIVE provider's models + effort levels.
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
    // Where the Codex model list comes from — the installed binary's own catalog or the built-in seed.
    const oc = state.providerCatalog && state.providerCatalog.openai;
    if (oc && Array.isArray(oc.models) && oc.models.length) {
      const src = oc.catalogSource === "live" || oc.catalogSource === "account" ? "the models your Codex login can use (from Codex)" : oc.catalogSource === "bundled" ? "the installed Codex binary's catalog (sign in to Codex for your account's list)" : "the built-in list";
      toolsBox.append(h("div", { class: "hint", style: "margin-top:8px", text: `Codex models (${oc.models.length}): ${oc.models.map((m) => m.name).join(", ")} — ${src}.` }));
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
  renderUpdates();
  renderTools();
  return { updBox, toolsBox, renderUpdates, renderTools };
}
