/* Settings › Integrations › MCP servers — the list shared with Antigravity via
 * ~/.gemini/config/mcp_config.json, and the add / edit editor (stdio or HTTP). */
import { closeModal, confirmDialog, h, modalShell, toast } from "../core/dom.js";
import { atom } from "../core/state.js";
import { icon } from "../icons.js";
import { field, segmented } from "./controls.js";

export function mcpPanel() {
  const box = h("div", { class: "st-mcp" });
  async function renderMcp() {
    box.innerHTML = "";
    let data; try { data = await atom.mcp.list(); } catch (e) { data = { servers: [], readError: e.message }; }
    if (data.readError) box.append(h("div", { class: "hint", style: "color:var(--red)", text: "Couldn't read mcp_config.json: " + data.readError }));
    const list = h("div", { class: "mcp-list" });
    if (!data.servers.length) list.append(h("div", { class: "hint", style: "margin:0", text: "No MCP servers configured yet." }));
    else for (const srv of data.servers) {
      const summary = srv.kind === "http" ? srv.serverUrl : (srv.command + (srv.args && srv.args.length ? " " + srv.args.join(" ") : ""));
      list.append(h("div", { class: "mcp-row" },
        h("div", { class: "mcp-meta" },
          h("div", { class: "mcp-name" },
            h("span", { class: "mcp-kind", text: srv.kind === "http" ? "HTTP" : "STDIO" }),
            h("span", { text: srv.name })),
          h("div", { class: "mcp-sub", text: summary || "(empty)", title: summary })),
        h("div", { class: "mcp-actions" },
          h("button", { class: "btn btn-ghost btn-sm", text: "Edit", onclick: () => openMcpEditor(srv, renderMcp) }),
          h("button", { class: "btn btn-ghost btn-sm", text: "Remove", onclick: async () => {
            const c = await confirmDialog({ title: "Remove MCP server?", message: `'${srv.name}' will be deleted from ~/.gemini/config/mcp_config.json.`, danger: true, confirmLabel: "Remove" });
            if (c) { try { await atom.mcp.remove(srv.name); renderMcp(); } catch (e) { toast("Remove failed: " + e.message, "alert"); } }
          } }))));
    }
    box.append(list);
    box.append(h("div", { class: "mcp-bar" },
      h("button", { class: "btn btn-primary btn-sm", html: `${icon("plus", 13)}<span>Add MCP server…</span>`, onclick: () => openMcpEditor(null, renderMcp) }),
      h("button", { class: "btn btn-ghost btn-sm", html: `${icon("external", 13)}<span>Open config file</span>`, onclick: () => atom.mcp.openFile().catch(() => {}) })));
  }
  renderMcp();
  return box;
}

// Add or edit a single server. stdio → command + args + env; http → serverUrl + authProviderType.
export function openMcpEditor(existing, onSaved) {
  const isNew = !existing;
  const init = existing || { name: "", kind: "stdio", command: "", args: [], env: {}, serverUrl: "", authProviderType: "" };
  let kind = init.kind === "http" ? "http" : "stdio";

  const nameInput = h("input", { class: "input", placeholder: "e.g. github, postgres", value: init.name || "" });
  if (!isNew) nameInput.disabled = true;

  const kindSeg = segmented(["stdio", "http"], kind, (v) => { kind = v; redraw(); }, { stdio: "STDIO (process)", http: "HTTP" });

  // stdio fields
  const cmdInput = h("input", { class: "input", placeholder: "command, e.g. npx", value: init.command || "" });
  const argsInput = h("input", { class: "input", placeholder: "args (space-separated), e.g. -y @modelcontextprotocol/server-github", value: (init.args || []).join(" ") });
  const envBox = h("div", { class: "mcp-env" });
  let envRows = Object.keys(init.env || {}).map((k) => ({ k, v: init.env[k] }));
  if (!envRows.length) envRows.push({ k: "", v: "" });
  function drawEnv() {
    envBox.innerHTML = "";
    envRows.forEach((row, i) => {
      const k = h("input", { class: "input mcp-env-k", placeholder: "VAR", value: row.k });
      const v = h("input", { class: "input mcp-env-v", placeholder: "value", value: row.v });
      const x = h("button", { class: "btn btn-ghost btn-sm", html: icon("close", 12), onclick: () => { envRows.splice(i, 1); if (!envRows.length) envRows.push({ k: "", v: "" }); drawEnv(); } });
      k.addEventListener("input", () => { envRows[i].k = k.value; });
      v.addEventListener("input", () => { envRows[i].v = v.value; });
      envBox.append(h("div", { class: "mcp-env-row" }, k, v, x));
    });
    envBox.append(h("button", { class: "btn btn-ghost btn-sm", html: `${icon("plus", 12)}<span>Add var</span>`, onclick: () => { envRows.push({ k: "", v: "" }); drawEnv(); } }));
  }
  drawEnv();

  // http fields
  const urlInput = h("input", { class: "input", placeholder: "https://server.example.com/mcp", value: init.serverUrl || "" });
  const authInput = h("input", { class: "input", placeholder: "(optional) authProviderType", value: init.authProviderType || "" });

  const form = h("div", { class: "mcp-form" });
  function redraw() {
    form.innerHTML = "";
    form.append(field("Name", nameInput, isNew ? "Lowercase identifier — used to reference the server." : "(read-only — use Rename to change)"));
    form.append(field("Transport", kindSeg));
    if (kind === "stdio") {
      form.append(field("Command", cmdInput, "Executable that speaks MCP over stdio."));
      form.append(field("Args", argsInput, "Space-separated. Escape with quotes if needed."));
      form.append(field("Environment", envBox, "Hardcode credentials here — env-var forwarding is broken in agy today."));
    } else {
      form.append(field("Server URL", urlInput, "Use serverUrl (not the deprecated httpUrl)."));
      form.append(field("Auth provider type", authInput, "Optional."));
    }
  }
  redraw();

  function parseArgs(s) {
    const out = []; let i = 0, cur = "", q = null;
    while (i < s.length) {
      const c = s[i++];
      if (q) { if (c === q) { q = null; } else { cur += c; } continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } continue; }
      cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }

  const m = modalShell({
    title: isNew ? "Add MCP server" : `Edit MCP server — ${init.name}`,
    ic: "git", wide: true, body: form,
    footer: h("div", { class: "modal-actions" },
      h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => closeModal(m) }),
      h("button", { class: "btn btn-primary", text: isNew ? "Add" : "Save", onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) { toast("Name is required", "alert"); return; }
        if (isNew && !/^[a-z0-9_\-]+$/i.test(name)) { toast("Name must be alphanumeric / dash / underscore.", "alert"); return; }
        const patch = kind === "stdio"
          ? {
              command: cmdInput.value.trim(),
              args: parseArgs(argsInput.value),
              env: Object.fromEntries(envRows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v])),
              serverUrl: "", authProviderType: "",
            }
          : {
              serverUrl: urlInput.value.trim(),
              authProviderType: authInput.value.trim(),
              command: "", args: [], env: {},
            };
        if (kind === "stdio" && !patch.command) { toast("Command is required for STDIO servers", "alert"); return; }
        if (kind === "http" && !patch.serverUrl) { toast("serverUrl is required for HTTP servers", "alert"); return; }
        try { await atom.mcp.upsert(name, patch); closeModal(m); if (onSaved) onSaved(); toast(isNew ? "MCP server added" : "MCP server saved", "check"); }
        catch (e) { toast("Save failed: " + e.message, "alert"); }
      } })),
  });
}
