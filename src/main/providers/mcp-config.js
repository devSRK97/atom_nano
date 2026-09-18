"use strict";
/* MCP server config — bridge to the file Antigravity (agy) and the Antigravity
 * IDE both read from: ~/.gemini/config/mcp_config.json.
 *
 * Per the Antigravity docs the schema is:
 *   {
 *     mcpServers: {
 *       "<name>": {
 *         command?: string,
 *         args?: string[],
 *         env?: Record<string,string>,    // NOTE: env-vars are NOT forwarded by agy
 *                                         // today — keys must be hardcoded here.
 *         serverUrl?: string,             // use serverUrl, NOT the older httpUrl
 *         authProviderType?: string,
 *       }
 *     }
 *   }
 *
 * AtomNano reads from and writes to the same file so any MCP servers the user
 * configures here are also available to agy + the Antigravity IDE. No private
 * AtomNano-only state — one source of truth shared across the suite.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function configDir() { return path.join(os.homedir(), ".gemini", "config"); }
function configFile() { return path.join(configDir(), "mcp_config.json"); }

function readRaw() {
  const file = configFile();
  if (!fs.existsSync(file)) return { mcpServers: {} };
  try {
    const raw = fs.readFileSync(file, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return { mcpServers: {} };
    if (!obj.mcpServers || typeof obj.mcpServers !== "object") obj.mcpServers = {};
    return obj;
  } catch (e) {
    return { mcpServers: {}, _readError: String((e && e.message) || e) };
  }
}

function writeRaw(obj) {
  const file = configFile();
  fs.mkdirSync(configDir(), { recursive: true });
  // Pretty-print so the file is comfortable to hand-edit too. Two-space indent
  // matches the convention used by the Antigravity IDE.
  const text = JSON.stringify(obj, null, 2) + "\n";
  fs.writeFileSync(file, text);
}

// List configured MCP servers as an array (renderer-friendly).
function list() {
  const cfg = readRaw();
  const out = [];
  for (const name of Object.keys(cfg.mcpServers || {})) {
    const s = cfg.mcpServers[name] || {};
    out.push({
      name,
      command: s.command || "",
      args: Array.isArray(s.args) ? s.args : [],
      env: s.env && typeof s.env === "object" ? s.env : {},
      serverUrl: s.serverUrl || "",
      authProviderType: s.authProviderType || "",
      // Convenience flag for the UI: stdio vs HTTP.
      kind: s.serverUrl ? "http" : (s.command ? "stdio" : "unknown"),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { file: configFile(), servers: out, readError: cfg._readError || null };
}

// Upsert a single server. Pass null/undefined fields to leave them unchanged;
// pass empty string/array/object to clear them.
function upsert(name, patch) {
  if (!name || typeof name !== "string") throw new Error("server name required");
  const cfg = readRaw();
  const prev = cfg.mcpServers[name] || {};
  const next = { ...prev };
  if (patch && typeof patch === "object") {
    if ("command" in patch) {
      if (patch.command) next.command = String(patch.command); else delete next.command;
    }
    if ("args" in patch) {
      if (Array.isArray(patch.args) && patch.args.length) next.args = patch.args.map(String);
      else delete next.args;
    }
    if ("env" in patch) {
      if (patch.env && typeof patch.env === "object" && Object.keys(patch.env).length) {
        next.env = {}; for (const k of Object.keys(patch.env)) next.env[k] = String(patch.env[k] == null ? "" : patch.env[k]);
      } else delete next.env;
    }
    if ("serverUrl" in patch) {
      if (patch.serverUrl) next.serverUrl = String(patch.serverUrl); else delete next.serverUrl;
    }
    if ("authProviderType" in patch) {
      if (patch.authProviderType) next.authProviderType = String(patch.authProviderType); else delete next.authProviderType;
    }
  }
  cfg.mcpServers[name] = next;
  writeRaw(cfg);
  return next;
}

function remove(name) {
  if (!name) return false;
  const cfg = readRaw();
  if (!(name in (cfg.mcpServers || {}))) return false;
  delete cfg.mcpServers[name];
  writeRaw(cfg);
  return true;
}

// Rename a server. Returns true if it happened.
function rename(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return false;
  const cfg = readRaw();
  if (!(oldName in (cfg.mcpServers || {}))) return false;
  if (newName in (cfg.mcpServers || {})) throw new Error("a server named '" + newName + "' already exists");
  cfg.mcpServers[newName] = cfg.mcpServers[oldName];
  delete cfg.mcpServers[oldName];
  writeRaw(cfg);
  return true;
}

module.exports = { list, upsert, remove, rename, configFile, configDir };
