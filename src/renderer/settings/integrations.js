/* Settings › Integrations — MCP servers and the `atomnano` command-line interface. */
import { h, toast } from "../core/dom.js";
import { atom } from "../core/state.js";
import { icon } from "../icons.js";
import { field, toggle } from "./controls.js";
import { mcpPanel } from "./mcp.js";

// The atomnano command talks to the RUNNING app over its local control server — the Planner
// uses it from its Bash tool to delegate work; you can use the same commands from any terminal.
const CLI_EXAMPLES = [
  ["What is running, which workflow is active", "atomnano status"],
  ["The role table (orchestrator · planner · coder · reviewer · tester)", "atomnano roles"],
  ["Hand a task to the Coder and wait for the result", 'atomnano run coder "Add input validation to src/api.js" --wait'],
  ["Ask the Reviewer / run the Tester", 'atomnano review "the changes in src/api.js" --wait   ·   atomnano test --cmd "npm test" --wait'],
  ["Follow jobs", "atomnano jobs   ·   atomnano wait <id>   ·   atomnano result <id>   ·   atomnano stop <id>"],
  ["Inspect providers and models", "atomnano providers   ·   atomnano models -P openai   ·   atomnano sessions"],
];

// The CLI switch: `npm link` onto PATH, with the current state and a usage block.
export function cliPanel() {
  const box = h("div", { class: "st-cli" });
  async function render() {
    box.innerHTML = "";
    let st = {}; try { st = await atom.cli.status(); } catch { /* */ }
    const linked = !!(st && st.linked);
    const sw = toggle(linked, async (v) => {
      if (v) {
        toast("Linking atomnano onto your PATH…", "cpu");
        const r = await atom.cli.enable().catch((e) => ({ ok: false, detail: e.message }));
        if (r && r.ok) toast("atomnano CLI enabled — use it from any terminal", "check");
        else toast("Couldn't link: " + ((r && r.detail) || "check npm is installed"), "alert");
      } else {
        await atom.cli.disable().catch(() => {});
        toast("atomnano CLI disabled");
      }
      render();
    }, { label: "atomnano command on PATH" });
    box.append(h("div", { class: "st-cli-head" }, sw, h("span", { class: "hint", style: "margin:0",
      text: linked ? `Enabled — \`atomnano\` is on your PATH${st.path ? " (" + st.path + ")" : ""}. It talks to this running app; the Planner role already reaches it without this switch.`
        : st.packaged ? "Run from source to auto-link, or add the app's bin folder to PATH manually. Processes the app starts (the Planner's shell, the integrated terminal) already have it."
        : "Turn on to run npm link so the atomnano command works in any terminal. Processes the app starts already have it on their PATH." })));
    const usage = h("div", { class: "cli-usage" });
    usage.append(h("div", { class: "cli-usage-head", text: "Usage" }));
    for (const [desc, cmd] of CLI_EXAMPLES) {
      usage.append(h("div", { class: "cli-ex" },
        h("div", { class: "cli-ex-desc", text: desc }),
        h("div", { class: "cli-ex-row" },
          h("code", { class: "cli-ex-cmd", text: cmd }),
          h("button", { class: "cli-ex-copy", title: "Copy", html: icon("copy", 13), onclick: () => { atom.clipboard.write(cmd); toast("Copied", "copy"); } }))));
    }
    usage.append(h("div", { class: "hint", style: "margin-top:6px", text: "Add --json for machine-readable output. Run `atomnano help` for every command. Exit codes: 0 ok · 1 usage error · 2 the app is not running · 3 the awaited job failed." }));
    box.append(usage);
  }
  render();
  return box;
}

export function integrationsCategory() {
  return {
    id: "integrations", label: "Integrations", ic: "git", group: "System",
    blurb: "Tool servers the agent can call, and AtomNano from your own terminal.",
    items: () => [
      field("MCP servers", mcpPanel(), "Edits the file Antigravity (agy) and the Antigravity IDE read: ~/.gemini/config/mcp_config.json. Env-var forwarding to MCP servers is broken there — keys must be hardcoded here.", { wide: true, keywords: "model context protocol tools server stdio http" }),
      field("Command-line interface", cliPanel(), "The atomnano command is how the Planner delegates to the other roles — and how you can drive jobs from any terminal while the app runs.", { wide: true, keywords: "cli terminal shell path npm link orchestrator jobs" }),
    ],
  };
}
