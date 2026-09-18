/* Settings › Providers — one card per provider (click to manage in a focused modal), the
 * one-click updater and the per-provider tool list. */
import { h } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { icon } from "../icons.js";
import { field } from "./controls.js";
import { openProviderModal } from "./provider-modal.js";
import { createUpdatePanels } from "./updates.js";

export const PROV_DEFS = [
  { id: "anthropic", name: "Anthropic (Claude)", keyField: "apiKey", icon: "atom", tagline: "Default primary" },
  { id: "openai", name: "OpenAI (Codex / GPT)", keyField: "openaiApiKey", icon: "cpu", tagline: "Primary · Codex SDK" },
  { id: "custom", name: "Custom (any API)", keyField: "customApiKey", baseUrl: true, icon: "globe", tagline: "Your endpoint" },
];

export function providersCategory() {
  const grid = h("div", { class: "prov-grid" });
  async function renderProviders() {
    const pst = await atom.providers.authStatus().catch(() => ({}));
    let anth = null; try { anth = await atom.auth.status(); } catch { /* */ }
    const primary = state.settings.llmProvider || "anthropic";
    grid.innerHTML = "";
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
  }
  renderProviders();
  const { updBox, toolsBox } = createUpdatePanels();
  return {
    id: "providers", label: "Providers", ic: "globe", group: "Model",
    blurb: "Who runs the primary turn, how you are signed in, and the CLIs and SDKs that power each provider.",
    items: () => [
      field("Providers & Authentication", grid, "Anthropic (Agent SDK), OpenAI (Codex SDK) and Custom can each run the primary turn. Click a provider to authorize, add an API key or make it the primary.", { wide: true, keywords: "login sign in api key anthropic openai codex custom endpoint primary account" }),
      field("Updates", updBox, "Updates the Claude CLI (brings the newest models) and the Agent SDK in place — no terminal. You'll be asked to restart when it's done.", { wide: true, keywords: "upgrade version cli sdk newest models" }),
      field("Provider tools", toolsBox, "Each provider's CLI + SDK update in place. Updating re-discovers that provider's models and reasoning-effort levels.", { wide: true, keywords: "codex claude cli sdk install version" }),
    ],
  };
}
