"use strict";
/* IPC: language tooling — the TypeScript service bridge (ts:*, over the utility process main.js
 * owns, reached through ctx.tsCall), the generic LSP (lsp:*), EditorConfig (editorconfig:get) and
 * Prettier (prettier:*). */
const { BrowserWindow } = require("electron");
const lsp = require("../lang/lsp");
// Heavy/rarely-needed modules are loaded on first use, NOT at boot. Prettier is
// large — a user editing only Python (LSP) or plain text should never pay for it.
let _prettier, _editorconfig;
const prettierMod = () => (_prettier || (_prettier = require("prettier")));
const editorconfigMod = () => (_editorconfig || (_editorconfig = require("editorconfig")));
const PRETTIER_PARSER = { json: "json", jsonc: "json", json5: "json", webmanifest: "json", css: "css", scss: "scss", less: "less", html: "html", htm: "html", xhtml: "html", vue: "vue", md: "markdown", markdown: "markdown", mdx: "mdx", yaml: "yaml", yml: "yaml", graphql: "graphql", gql: "graphql" };

function register(ctx) {
  const { handle, tsCall } = ctx;
  // ---- TypeScript language service — project-wide, in an idle-killed utility process ----
  handle("ts:diagnose", async (_e, root, file, text) => tsCall("diagnose", [root, file, text]));
  handle("ts:request", async (_e, kind, root, file, payload) => tsCall("request", [kind, root, file, payload]));
  // ---- generic LSP (Python/Go/Rust/C++/PHP… when a server is available) ----
  handle("lsp:langs", async () => lsp.availableExts());
  handle("lsp:diagnose", async (_e, root, ext, file, text) => lsp.diagnose(root, ext, file, text));
  handle("lsp:request", async (_e, kind, root, ext, file, payload) => lsp.request(kind, root, ext, file, payload));
  lsp.setDiagnosticsListener((filePath) => { for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send("lsp:diagnostics", { file: filePath }); } catch { /* ignore */ } } });
  // ---- EditorConfig (.editorconfig) resolved for a file ----
  handle("editorconfig:get", async (_e, filePath) => { try { return await editorconfigMod().parse(filePath); } catch { return {}; } });

  // ---- Prettier formatting for non-TS languages (JSON/CSS/HTML/Markdown/YAML…) ----
  handle("prettier:langs", async () => Object.keys(PRETTIER_PARSER));
  handle("prettier:format", async (_e, text, lang, tabSize) => {
    const parser = PRETTIER_PARSER[(lang || "").toLowerCase()];
    if (!parser) return null;
    try { return await prettierMod().format(text || "", { parser, tabWidth: tabSize || 2, endOfLine: "lf" }); } catch { return null; }
  });
}

module.exports = { register };
