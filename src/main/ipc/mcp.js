"use strict";
/* IPC: the MCP server config bridge — mcp:* (list / upsert / remove / rename / open the file),
 * backed by src/main/providers/mcp-config.js. */
const { shell } = require("electron");

function register(ctx) {
  const { handle } = ctx;
  // MCP server bridge — manages the user's MCP server config file.
  const mcpConfig = require("../providers/mcp-config");
  handle("mcp:list", async () => mcpConfig.list());
  handle("mcp:upsert", async (_e, name, patch) => mcpConfig.upsert(name, patch || {}));
  handle("mcp:remove", async (_e, name) => mcpConfig.remove(name));
  handle("mcp:rename", async (_e, oldName, newName) => mcpConfig.rename(oldName, newName));
  handle("mcp:open-file", async () => { await shell.openPath(mcpConfig.configFile()); return true; });
}

module.exports = { register };
