/* Settings › Storage — backup / restore, where sessions live, the Claude CLI path, the
 * environment API key switch, and where the app keeps its data. */
import { h, toast } from "../core/dom.js";
import { atom } from "../core/state.js";
import { icon } from "../icons.js";
import { chooseDialog } from "../workspace/projects.js";
import { boolSetting, field, kvGrid, section } from "./controls.js";

export function storageCategory({ s, auth, info }) {
  // Back up & restore — a personal migration archive. INCLUDES provider logins, API keys, custom
  // APIs (with tokens), project data, projects and preferences. Two scopes: app data, or + all sessions.
  const backupRow = h("div", { class: "st-btn-row" },
    h("button", { class: "btn btn-ghost btn-sm", html: `${icon("download", 14)}<span>Backup…</span>`, onclick: async () => {
      const choice = await chooseDialog({
        title: "Back up AtomNano", ic: "download",
        message: "Saves your provider logins, API keys, custom APIs (with tokens), project data, projects and preferences. Choose what to include:",
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
        // (Per-project data files — the workflow roles' skill store — are restored too; described as
        //  project data, not counted, since 2026-09-18.)
        chooseDialog({
          title: "Backup restored", ic: "check",
          message: `Restored your settings, API keys, custom APIs and project data${parts.length ? " (" + parts.join(", ") + ")" : ""}. Restart AtomNano to apply everything?`,
          choices: [{ label: "Restart now", value: "restart", primary: true }, { label: "Later", value: null }],
        }).then((c) => { if (c === "restart") atom.app.relaunch(); });
      } catch (e) { toast("Restore failed: " + e.message, "alert"); }
    } }));

  // Session history folder
  const histInput = h("input", { class: "input st-mono", value: s.historyDir, readonly: "true" });
  const histRow = h("div", { class: "input-row" }, histInput,
    h("button", { class: "btn btn-ghost btn-sm", text: "Browse", onclick: async () => { const p = await atom.dialog.pickHistory(); if (p) { s.historyDir = p; histInput.value = p; await atom.settings.set({ historyDir: p }); toast("History folder updated"); } } }),
    h("button", { class: "btn btn-ghost btn-sm", title: "Open the folder", html: icon("external", 14), onclick: () => atom.sessions.openHistory() }));

  // Claude CLI path
  const pathInput = h("input", { class: "input st-mono", value: s.claudePath || "", placeholder: auth.cliPath || "auto-detect (claude on PATH)" });
  pathInput.addEventListener("change", () => atom.settings.set({ claudePath: pathInput.value.trim() }).then(() => { s.claudePath = pathInput.value.trim(); toast("CLI path saved"); }));

  const envKey = boolSetting("useEnvApiKey", { label: "Use ANTHROPIC_API_KEY from the environment" });

  const openData = () => atom.shell.openExternal("file://" + (info.userData || "").replace(/\\/g, "/"));
  const facts = kvGrid([
    ["Version", `AtomNano v${info.version || "?"}`],
    [info.portable ? "Data folder (portable)" : "Data folder", info.userData || "—", { mono: true, onclick: openData }],
    auth.cliPath ? ["Claude CLI", auth.cliPath + (auth.version ? ` · v${auth.version}` : ""), { mono: true }] : null,
  ]);

  return {
    id: "storage", label: "Storage", ic: "settings", group: "System",
    blurb: "Where your sessions and data live, and how to move them to another machine.",
    items: () => [
      section("Your data", "download"),
      field("Back up & restore", backupRow, "The backup includes provider logins, API keys, custom APIs (with tokens), project data, projects and preferences. Keep the file private — it contains your secrets.", { keywords: "export import migrate archive" }),
      field("Session history folder", histRow, "Each session is stored as a JSON file here.", { wide: true, keywords: "sessions path directory" }),
      section("Claude CLI", "terminal"),
      field("Claude CLI path", pathInput, "Leave blank to auto-detect. API keys live under Providers.", { wide: true, keywords: "binary executable location" }),
      field("Environment API key", envKey, auth.envKeyPresent ? "ANTHROPIC_API_KEY is set in this environment. Off = the CLI login is used instead." : "No ANTHROPIC_API_KEY in the environment.", { keywords: "env var anthropic key" }),
      section("About", "info"),
      field("This installation", facts, info.portable ? "Portable: data lives next to the app." : "Data is in your user profile. Click the folder to open it.", { wide: true, keywords: "version about folder location" }),
    ],
  };
}
