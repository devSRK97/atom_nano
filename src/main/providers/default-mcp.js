"use strict";
/* Default MCP servers wired into every AtomNano session.
 *
 * NOW EMPTY — MCP is strictly opt-in (user entries in mcpConfig.js). Every
 * mounted MCP server's FULL tool schemas ride the prompt on every turn; a
 * multi-tool server costs thousands of input tokens per turn, uncached
 * whenever the config changes, whether or not any of its tools get called.
 *
 * Removal history:
 *  codebase-memory-mcp — removed 2026-07: its dozens of tool schemas cost more
 *    per turn than the exploratory Reads/Greps they replaced, and the built-in
 *    context/graph layers (context.js, graph.js) already cover orientation.
 *    Re-add per-project via mcpConfig if a workspace genuinely needs the graph:
 *    { command: "npx", args: ["-y", "codebase-memory-mcp"] }.
 *  headroom — removed earlier: its content-router excludes Read/Glob/Grep tool
 *    outputs — the exact traffic AtomNano sessions produce — so real-world
 *    savings measured 0% on 51k tokens across 6 requests with ~1.8s added
 *    latency per turn.
 *
 * composeMcpServers stays: it maps user-configured mcpConfig entries into the
 * SDK shape, and a future default can slot back in with one entry.
 */
const DEFAULTS = {};

// Merge the defaults with any user-added entries from mcpConfig.js. User entries
// with the same name WIN — if a power user pins a specific version or points at
// a local binary, we don't overwrite it.
function composeMcpServers(userEntries, opts) {
  const enabled = !opts || opts.enableDefaultMcp !== false;
  const out = {};
  if (enabled) for (const [k, v] of Object.entries(DEFAULTS)) out[k] = { ...v };
  if (userEntries && typeof userEntries === "object") {
    for (const [k, v] of Object.entries(userEntries)) {
      if (!v) continue;
      // The mcpConfig list() shape → SDK shape.
      if (v.serverUrl) out[k] = { type: v.serverUrl.startsWith("http") && !v.sse ? "http" : "sse", url: v.serverUrl };
      else if (v.command) out[k] = { type: "stdio", command: v.command, args: v.args || [], env: v.env || undefined };
      else if (v.type && v.command) out[k] = v;
    }
  }
  return out;
}

module.exports = { DEFAULTS, composeMcpServers };
