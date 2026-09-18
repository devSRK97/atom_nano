"use strict";
/* IPC registry. Every renderer-facing handler lives in one ./<domain>.js module here (mirroring the
 * src/main/<domain>/ folders); main.js calls registerAll(ctx) once from app.whenReady() with the pieces
 * only the bootstrap owns (the window registry + helpers, the TS bridge, lifecycle hooks). Nothing in
 * this folder runs at require time — the modules only define functions — so the module graph loads
 * without Electron (scripts/check-requires.js). */
const { ipcMain } = require("electron");

function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    try { return { ok: true, data: await fn(e, ...args) }; }
    catch (err) {
      console.error(`[ipc:${channel}]`, err);
      // Typed errors (git) keep their classification + complete diagnostics for the UI.
      return { ok: false, error: err && err.message ? err.message : String(err), type: err && err.type ? String(err.type) : undefined, details: err && typeof err.details === "string" ? err.details : undefined, code: err && err.code != null ? err.code : undefined };
    }
  });
}

// Registration order is not significant — channels are unique (ipcMain.handle throws on a duplicate)
// — so the modules are simply listed by domain.
const MODULES = [
  require("./window"), require("./settings"), require("./auth"), require("./providers"),
  require("./sessions"), require("./agents"), require("./db"), require("./files"), require("./terminal"),
  require("./git"), require("./lang"), require("./skills"), require("./fleet"), require("./mcp"),
  require("./testing"), require("./workflow"), require("./tasks"), require("./test-hooks"),
];

function registerAll(ctx) {
  const full = { ...ctx, handle };
  for (const m of MODULES) m.register(full);
}

module.exports = { registerAll };
