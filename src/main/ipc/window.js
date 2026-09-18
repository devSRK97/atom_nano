"use strict";
/* IPC: the app and its windows — app:info, the win:* frame controls (minimize / maximize / close,
 * project binding, taskbar tile + overlay icons), the OS folder pickers (dialog:*), clipboard:* and
 * shell:open-external. Every window-bound route resolves the caller through ctx.winFrom. */
const { app, ipcMain, dialog, shell, clipboard, nativeImage } = require("electron");
const os = require("os");
const store = require("../storage/store");

function register(ctx) {
  const { handle, portableInfo, windows, winFrom, projectOf, windowForProject, focusOrCreateWindow, syncOpenWindows } = ctx;
  // ---- App / window ----
  handle("app:info", async () => ({ version: app.getVersion(), platform: process.platform, home: os.homedir(), userData: app.getPath("userData"), portable: portableInfo.portable, dataDir: portableInfo.dataDir }));
  handle("win:project", async (e) => projectOf(winFrom(e)));
  handle("win:open-project", async (e, project) => { if (!project) return { ok: false }; const reused = !!windowForProject(project); focusOrCreateWindow(project); return { ok: true, reused }; });
  handle("win:is-open", async (_e, project) => !!windowForProject(project));
  // Should this window prompt for a project on open? (taskbar "New Window")
  handle("win:pick-on-open", async (e) => { const r = windows.get(winFrom(e) && winFrom(e).webContents.id); return !!(r && r.pick); });
  // An in-place project switch must update this window's project so per-project
  // settings (getSettings/saveSettings keyed by project) resolve correctly.
  handle("win:set-project", async (e, project) => { const w = winFrom(e); const r = w && windows.get(w.webContents.id); if (r && project) { r.project = project; r.pick = false; store.saveSettings({ lastFolder: project }); syncOpenWindows(); } return { ok: true }; });
  handle("win:set-overlay", async (e, dataUrl, label) => {
    if (process.platform !== "win32") return { ok: true };
    const w = winFrom(e);
    if (!w || w.isDestroyed()) return { ok: false };
    try { w.setOverlayIcon(dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, label || ""); } catch { /* ignore */ }
    return { ok: true };
  });
  // Replace the taskbar/window icon with the per-project colored tag tile. On macOS the tile is
  // the Dock icon while that window is focused (one Dock icon per app — it follows the focus).
  handle("win:set-tag-icon", async (e, dataUrl) => {
    const w = winFrom(e);
    if (!w || w.isDestroyed()) return { ok: false };
    let img = null;
    try { img = dataUrl ? nativeImage.createFromDataURL(dataUrl) : null; } catch { img = null; }
    try {
      if (process.platform === "win32") { if (img) w.setIcon(img); w.setOverlayIcon(null, ""); }   // remove any old round badge
      else if (process.platform === "darwin") { const r = windows.get(w.webContents.id); if (r) r.tagIcon = img; if (img && app.dock && w.isFocused()) app.dock.setIcon(img); }
      else if (img) w.setIcon(img);
    } catch { /* ignore */ }
    return { ok: true };
  });
  ipcMain.on("win:minimize", (e) => { const w = winFrom(e); if (w) w.minimize(); });
  ipcMain.on("win:maximize", (e) => { const w = winFrom(e); if (w) (w.isMaximized() ? w.unmaximize() : w.maximize()); });
  ipcMain.on("win:close", (e) => { const w = winFrom(e); if (w) w.close(); });
  ipcMain.on("win:force-close", (e) => { const w = winFrom(e); if (w) { w._allowClose = true; w.close(); } });
  ipcMain.on("app:relaunch", () => {
    for (const v of windows.values()) { try { v.win._allowClose = true; } catch { /* gone */ } }
    try { store.flushAll(); } catch { /* ignore */ }
    app.relaunch();
    app.quit();
  });
  handle("win:is-maximized", async (e) => { const w = winFrom(e); return w ? w.isMaximized() : false; });

  // ---- Dialogs (scoped to the calling window) ----
  handle("dialog:pick-folder", async (e, defaultPath) => {
    const res = await dialog.showOpenDialog(winFrom(e), { title: "Select a project folder", defaultPath: defaultPath || store.getSettings().lastFolder, properties: ["openDirectory", "createDirectory"] });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });
  handle("dialog:pick-history", async (e) => {
    const res = await dialog.showOpenDialog(winFrom(e), { title: "Select a folder to store session history", defaultPath: store.getSettings().historyDir, properties: ["openDirectory", "createDirectory"] });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });

  // ---- Clipboard / external ----
  handle("clipboard:write", async (_e, text, html) => {
    // When the caller provides rendered HTML (e.g. a markdown table/styled reply),
    // write BOTH flavors: plain text (the markdown source — pastes cleanly into a
    // text editor or .md file) and HTML (pastes as a real styled table into Word,
    // Google Docs, email, etc.). Apps pick the richest flavor they understand.
    if (html) clipboard.write({ text: String(text || ""), html: String(html) });
    else clipboard.writeText(String(text || ""));
    return true;
  });
  handle("clipboard:read", async () => clipboard.readText());

  handle("shell:open-external", async (_e, url) => { await shell.openExternal(url); return true; });
}

module.exports = { register };
