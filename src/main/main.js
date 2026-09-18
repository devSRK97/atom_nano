"use strict";
const { app, BrowserWindow, powerSaveBlocker, Menu } = require("electron");
const platform = require("./platform");
// macOS/Linux: a Finder/Dock-launched app has launchd's minimal PATH — merge the login shell's PATH
// (Homebrew, ~/.local/bin, nvm/volta…) FIRST, before anything looks for claude / codex / git / npm.
try { platform.fixPath(); } catch { /* best effort */ }
const path = require("path");
const os = require("os");
const fs = require("fs");

// ---- Portable mode -------------------------------------------------------
// If "portable.flag" or an "AtomNano-Data" folder sits next to the executable,
// keep ALL data — settings, session history, API key, AND the Claude login —
// inside that folder, so the whole app folder can be copied to another machine.
// Must run before ./store is required (store reads userData at load time).
//
// App-level Claude home (non-portable, default): AtomNano keeps its OWN Claude
// config home under userData — one login SHARED by every project/window, and
// independent of the OS-level ~/.claude, so it never clobbers (or is clobbered
// by) the user's terminal `claude` login. CLAUDE_CONFIG_DIR relocates the whole
// Claude home (login + settings + CLAUDE.md + transcripts), not just creds, so
// AtomNano runs read app-home config rather than ~/.claude — matching how
// portable mode already behaves. An explicit CLAUDE_CONFIG_DIR in the env wins.
let portableInfo = { portable: false, dataDir: "" };
// Marker written by an in-app Claude logout. While it exists the app home is
// deliberately signed out: the startup seed below must NOT silently re-import the
// OS-level terminal login (that made every logout undo itself on the next start).
// It is removed the moment a login exists in the app home again.
const LOGOUT_MARKER = ".atomnano-logged-out";
function seedClaudeHome(claudeDir) {
  // First-run only: carry the existing OS login into the app home so switching
  // to an app-level home doesn't log the user out. After that the app home is
  // authoritative; a later logout here won't touch ~/.claude (and vice versa).
  // (credstore: on macOS the logins live in the Keychain, not in .credentials.json.)
  try {
    const credstore = require("./auth/credstore");
    const marker = path.join(claudeDir, LOGOUT_MARKER);
    if (credstore.readLive(claudeDir).json) { try { if (fs.existsSync(marker)) fs.unlinkSync(marker); } catch { /* */ } return; }
    if (fs.existsSync(marker)) return;           // intentionally logged out — stay logged out
    const home = credstore.osLogin();
    if (home.json) credstore.writeLive(claudeDir, home.json);
  } catch { /* ignore */ }
}
try {
  const exeDir = path.dirname(app.getPath("exe"));
  if (fs.existsSync(path.join(exeDir, "portable.flag")) || fs.existsSync(path.join(exeDir, "AtomNano-Data"))) {
    const dataDir = path.join(exeDir, "AtomNano-Data");
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath("userData", dataDir);
    const claudeDir = path.join(dataDir, "claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    seedClaudeHome(claudeDir);
    portableInfo = { portable: true, dataDir };
  } else if (process.env.ATOMNANO_USER_DATA) {
    // Test isolation: an explicit userData root (settings, sessions, Claude home) so a
    // smoke run never reads or writes the developer's real profile / logins.
    const dataDir = path.resolve(process.env.ATOMNANO_USER_DATA);
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath("userData", dataDir);
    const claudeDir = path.join(dataDir, "claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    if (!process.env.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = claudeDir;   // empty provider home — no seeding from ~/.claude
  } else if (!process.env.CLAUDE_CONFIG_DIR) {
    const claudeDir = path.join(app.getPath("userData"), "claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    seedClaudeHome(claudeDir);
  }
} catch { /* ignore */ }

const store = require("./storage/store");
const files = require("./workspace/files");
const auth = require("./auth/cli-auth");
const claude = require("./session/index");
const fleet = require("./agents/fleet");
const terminal = require("./workspace/terminal");
const { utilityProcess } = require("electron");
const lsp = require("./lang/lsp");
// Renderer-facing IPC handlers, one module per domain (./ipc/<domain>.js; see ./ipc/index.js).
// Required after the modules above so the store is already bound to the final userData path.
const ipc = require("./ipc");
// The `atomnano` CLI (bin/atomnano.js, plain Node — it never launches Electron) talks to THIS process
// over the local control server started in whenReady below (src/main/control/server.js).
const control = require("./control/server");

// ---- GPU: full hardware acceleration for the GUI -------------------------
// Must run before app "ready". Keeps GPU compositing/rasterization on even
// when Chromium's driver blocklist would silently fall back to software, and
// on dual-GPU machines asks for the discrete GPU instead of the power-saving
// integrated one.
try {
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
  app.commandLine.appendSwitch("enable-features", "CanvasOopRasterization");
  if (process.platform === "darwin") app.commandLine.appendSwitch("force_high_performance_gpu");
} catch { /* ignore */ }

// ---- TypeScript service in a dedicated, idle-killed utility process ----
// Runs the whole TS compiler off the main thread (own core) and lets the OS
// reclaim its ~tens of MB when idle by killing the process (in-process disposal
// can't — V8 doesn't return heap to the OS). Respawns transparently on demand.
// 5 min: long enough that completions don't pay a cold respawn mid-session, short
// enough that the OS still reclaims the TS memory once you stop editing TS.
const TS_IDLE_MS = +process.env.ATOMNANO_TS_IDLE_MS || 5 * 60 * 1000;
let tsChild = null, tsSeq = 0, tsIdleTimer = null;
const tsPending = new Map();
function tsProc() {
  if (tsChild) return tsChild;
  tsChild = utilityProcess.fork(path.join(__dirname, "lang", "ts-host.js"), [], { serviceName: "atomnano-tsserver" });
  tsChild.on("message", (m) => { const r = tsPending.get(m.id); if (r) { tsPending.delete(m.id); r(m.result); } });
  tsChild.on("exit", () => { tsChild = null; for (const r of tsPending.values()) r(null); tsPending.clear(); });
  return tsChild;
}
function tsBumpIdle() {
  if (tsIdleTimer) clearTimeout(tsIdleTimer);
  tsIdleTimer = setTimeout(() => { if (tsChild) { try { tsChild.kill(); } catch { /* ignore */ } tsChild = null; } }, TS_IDLE_MS);
  if (tsIdleTimer.unref) tsIdleTimer.unref();
}
function tsCall(method, args) {
  return new Promise((resolve) => {
    let child; try { child = tsProc(); } catch { resolve(null); return; }
    const id = ++tsSeq;
    const timer = setTimeout(() => { if (tsPending.has(id)) { tsPending.delete(id); resolve(null); } }, 30000);
    tsPending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    try { child.postMessage({ id, method, args }); } catch { tsPending.delete(id); clearTimeout(timer); resolve(null); }
    tsBumpIdle();
  });
}

if (process.env.ATOMNANO_TEST) { global.__claude = claude; global.__auth = auth; global.__store = store; global.__defaultMcp = require("./providers/default-mcp"); } // test hooks only

const isDev = process.argv.includes("--dev");
const INDEX_HTML = path.join(__dirname, "..", "renderer", "index.html");

// Each window is a "project" (folder). windows: wcId -> { win, project }
const windows = new Map();

if (!process.env.ATOMNANO_TEST) {
  if (!app.requestSingleInstanceLock()) { app.quit(); }
  else app.on("second-instance", (_e, argv) => {
    // The taskbar "New Window" jump-list task relaunches us with --new-window:
    // open a fresh window that prompts the user to pick a project.
    if (Array.isArray(argv) && argv.includes("--new-window")) { createWindow(null, { pick: true }); return; }
    const w = [...windows.values()][0]; if (w) { if (w.win.isMinimized()) w.win.restore(); w.win.focus(); }
  });
}

function broadcast(channel, payload) {
  for (const { win } of windows.values()) if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function winFrom(e) { return BrowserWindow.fromWebContents(e.sender); }
function projectOf(win) { const r = win && windows.get(win.webContents.id); return r ? r.project : store.getSettings().lastFolder; }
// Normalize a folder path so the same project (case/trailing-slash/separator
// variants) maps to one key — matches store.js so settings + windows agree.
function normProj(p) { return p ? String(p).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() : ""; }
function windowForProject(project) { const k = normProj(project); if (!k) return null; for (const r of windows.values()) if (normProj(r.project) === k) return r.win; return null; }
// Open a project — but if it's ALREADY open in a window, focus that one instead
// of creating a duplicate (one window per project).
function focusOrCreateWindow(project) {
  const existing = windowForProject(project);
  if (existing) { if (existing.isMinimized()) existing.restore(); if (!existing.isVisible()) existing.show(); existing.focus(); return existing; }
  return createWindow(project);
}
function syncOpenWindows() {
  const projs = [...windows.values()].map((r) => r.project).filter(Boolean);
  store.setOpenWindows([...new Set(projs)]);
}

// ---- file-system watch (keeps the renderer's file tree / editor in sync with
// external changes). One recursive watcher per window, following its tree root.
function startWatch(win, root) {
  if (!win || win.isDestroyed()) return;
  const rec = windows.get(win.webContents.id);
  if (!rec) return;
  if (rec.watchRoot === root && rec.watcher) return;     // already watching this root
  stopWatch(rec);
  rec.watchRoot = root || "";
  if (!root) return;
  rec.watcher = files.watchTree(root, () => {
    clearTimeout(rec.watchTimer);
    rec.watchTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.send("fs:changed", { root });
    }, 220);                                              // coalesce bursts of fs events
  });
}
function stopWatch(rec) {
  if (!rec) return;
  clearTimeout(rec.watchTimer);
  if (rec.watcher) { try { rec.watcher.close(); } catch { /* ignore */ } rec.watcher = null; }
  rec.watchRoot = "";
  if (rec.gitWatchers) { for (const w of rec.gitWatchers.values()) { try { w.close(); } catch { /* ignore */ } } rec.gitWatchers.clear(); }
}
// Git metadata watch: the tree watcher deliberately ignores `.git`, so a commit,
// checkout, fetch or merge made from a terminal would never reach the Git views.
// One metadata watcher per discovered repository (HEAD, index, refs, operation
// markers — not objects or lock files) → "git:changed" { repo }, coalesced.
function startGitWatch(win, repos) {
  if (!win || win.isDestroyed()) return;
  const rec = windows.get(win.webContents.id);
  if (!rec) return;
  rec.gitWatchers = rec.gitWatchers || new Map();
  const want = new Set((Array.isArray(repos) ? repos : []).filter(Boolean).map(String));
  for (const [repo, w] of [...rec.gitWatchers]) if (!want.has(repo)) { try { w.close(); } catch { /* ignore */ } rec.gitWatchers.delete(repo); }
  for (const repo of want) {
    if (rec.gitWatchers.has(repo)) continue;
    const w = files.watchGitMeta(repo, () => { if (win && !win.isDestroyed()) win.webContents.send("git:changed", { repo }); });
    if (w) rec.gitWatchers.set(repo, w);
  }
}

function attachConsole(win) {
  const wc = win.webContents;
  wc.on("console-message", (...a) => {
    const ev = a[0];
    let level, message, source, line;
    if (ev && typeof ev === "object" && "message" in ev) { level = ev.level; message = ev.message; source = ev.sourceId; line = ev.lineNumber; }
    else { level = a[1]; message = a[2]; line = a[3]; source = a[4]; }
    const isErr = level === 3 || level === "error";
    if (isErr || isDev) console.log(`[renderer${isErr ? ":error" : ""}] ${message}${source ? ` (${source}:${line})` : ""}`);
  });
  wc.on("render-process-gone", (_e, d) => console.error("[render-process-gone]", d && d.reason, d && d.exitCode));
  wc.on("did-fail-load", (_e, code, desc) => console.error("[did-fail-load]", code, desc));
}

function createWindow(project, opts = {}) {
  const settings = store.getSettings();
  const proj = project || settings.lastFolder || os.homedir();
  const b = settings.windowBounds || {};
  const offset = windows.size * 30;
  const win = new BrowserWindow({
    width: b.width || 1360, height: b.height || 880,
    x: b.x != null ? b.x + offset : undefined, y: b.y != null ? b.y + offset : undefined,
    minWidth: 960, minHeight: 620, ...platform.windowChrome(),   // frameless; macOS keeps its inset traffic lights
    backgroundColor: "#1a1512", show: false,
    icon: path.join(__dirname, "..", "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    // backgroundThrottling:false — Chromium otherwise throttles requestAnimationFrame
    // and timers to ~1fps when the window is occluded/backgrounded. Since live reply
    // streaming renders on rAF, a backgrounded window (e.g. while a smoke test runs in
    // front, or you're in another app) would appear frozen / "Not Responding" mid-reply.
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false, backgroundThrottling: false },
  });
  const wcId = win.webContents.id; // capture now — webContents is gone by "closed"
  windows.set(wcId, { win, project: proj, pick: !!opts.pick });
  // Give each window its OWN taskbar tile: a UNIQUE AppUserModelID per window
  // (not per project) so even two windows of the same folder don't group.
  if (process.platform === "win32") {
    try { win.setAppDetails({ appId: "com.atomailabs.atomnano.win" + wcId }); } catch { /* ignore */ }
  }
  win.loadFile(INDEX_HTML, { query: { project: proj } });
  win.once("ready-to-show", () => { if (b.maximized && windows.size === 1) win.maximize(); win.show(); if (isDev) win.webContents.openDevTools({ mode: "detach" }); });
  attachConsole(win);

  const sendMax = () => { if (!win.isDestroyed()) win.webContents.send("win:maximized-change", win.isMaximized()); };
  win.on("maximize", sendMax); win.on("unmaximize", sendMax);

  win.on("close", (e) => {
    if (win.isDestroyed()) return;
    try {
      if (!win.isMaximized()) store.saveSettings({ windowBounds: { ...win.getBounds(), maximized: false } });
      else store.saveSettings({ windowBounds: { ...(store.getSettings().windowBounds || {}), maximized: true } });
    } catch { /* window already gone */ }
    const isLast = windows.size <= 1;
    // Confirm on EVERY window, not just the last one. Each window holds a
    // different project with its own sessions, so closing a non-last window can
    // still discard running work — skipping the prompt there lost it silently.
    if (win._allowClose || process.env.ATOMNANO_TEST || !store.getSettings().confirmClose) return;
    e.preventDefault();
    // Ask the renderer to show the in-app confirm modal (matches the project
    // chooser). It replies via win:force-close when the user confirms.
    // Count only THIS window's project so a quiet window doesn't warn about
    // another window's run.
    const running = claude.runningCountForCwd ? claude.runningCountForCwd(proj) : (claude.runningCount ? claude.runningCount() : 0);
    if (!win.isDestroyed()) {
      // The close was likely triggered from the taskbar (right-click → Close,
      // hover-preview ✕) where the window is minimized or behind other apps —
      // surface it so the in-app confirm modal is actually visible.
      try {
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.setAlwaysOnTop(true); win.setAlwaysOnTop(false);   // pop to front without staying pinned
        win.focus();
      } catch { /* window already gone */ }
      win.webContents.send("app:confirm-close", { running, isLast, project: proj });
    }
  });
  win.on("closed", () => { stopWatch(windows.get(wcId)); windows.delete(wcId); syncOpenWindows(); });

  syncOpenWindows();
  return win;
}

// Keep the machine awake during long agent jobs when the user opts in.
let sleepBlockerId = null;
function applyPreventSleep(on) {
  try {
    if (on && sleepBlockerId == null) sleepBlockerId = powerSaveBlocker.start("prevent-display-sleep");
    else if (!on && sleepBlockerId != null) { powerSaveBlocker.stop(sleepBlockerId); sleepBlockerId = null; }
  } catch { /* unsupported platform */ }
}

app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("com.atomailabs.atomnano");
  store.loadSettings();
  applyPreventSleep(store.getSettings().preventSleep);
  store.loadAllSessions();
  // The renderer-facing IPC lives in ./ipc/<domain>.js. The handlers receive what only this
  // bootstrap owns: the window registry + helpers, the TS bridge, and the lifecycle hooks
  // (sleep blocker, provider-login reaction) that the startup code here shares with them.
  ipc.registerAll({
    portableInfo, windows, INDEX_HTML,
    winFrom, projectOf, windowForProject, focusOrCreateWindow, syncOpenWindows, createWindow, broadcast,
    startWatch, startGitWatch, applyPreventSleep, onProviderLoginChanged, tsCall,
  });
  // Never LRU-evict a session with a live turn — claude.js mutates the loaded
  // object in place across the async run; evicting would risk a divergent reload.
  store.setBusyCheck((id) => { try { return claude.isRunning(id); } catch { return false; } });
  claude.setEmitter((channel, payload) => broadcast(channel, payload));
  // Control server for the `atomnano` CLI: exports ATOMNANO_CONTROL / ATOMNANO_TOKEN / ATOMNANO_NODE
  // and prepends bin/ to PATH so the Planner's Bash tool (and any terminal spawned from here) can
  // delegate to the Coder / Reviewer / Tester roles. Best effort — startup never waits on or fails for it.
  try {
    control.start({ manager: claude, store, version: app.getVersion(), userData: app.getPath("userData"), binDir: path.join(app.getAppPath(), "bin") })
      .then((c) => { if (isDev) console.log("[control] listening at", c.url); })
      .catch((e) => console.warn("[control] not started:", (e && e.message) || e));
  } catch (e) { console.warn("[control] not started:", (e && e.message) || e); }
  // Persistence failures (settings / session / archive writes) reach every window
  // as a visible error — "saved" is never claimed for bytes that didn't land.
  store.onError((info) => broadcast("store:error", info));
  try { require("./providers/codex-appserver").setUserData(app.getPath("userData")); } catch { /* */ }
  try { require("./storage/attachments").setDir(path.join(app.getPath("userData"), "attachments")); } catch { /* */ }

  // Background fleet: broadcast task updates so every window's Fleet panel stays live.
  fleet.configure({ emit: (channel, payload) => broadcast(channel, payload) });
  // Terminal output has to reach the renderer as it arrives, not on request.
  terminal.configure({ emit: (channel, payload) => broadcast(channel, payload) });
  // Test Director (goal→green): broadcast goal status transitions.
  require("./testing/director").setEmitter((channel, payload) => broadcast(channel, payload));

  let toOpen = store.getOpenWindows().filter(Boolean);
  // de-dupe by normalized path
  const seen = new Set();
  toOpen = toOpen.filter((p) => { const k = p.replace(/[\\/]+$/, "").toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!toOpen.length) toOpen = [store.getSettings().lastFolder || os.homedir()];
  // Launched via the taskbar "New Window" task while not running → start in pick mode.
  if (process.argv.includes("--new-window")) createWindow(null, { pick: true });
  else for (const p of toOpen) createWindow(p);

  // Taskbar (Windows jump list) right-click → "New Window" → user picks a project.
  if (process.platform === "win32") {
    try {
      app.setUserTasks([{ program: process.execPath, arguments: "--new-window", title: "New Window", description: "Open a new AtomNano window and choose a project", iconPath: process.execPath, iconIndex: 0 }]);
    } catch (e) { console.error("[jumplist]", e && e.message); }
  }
  // macOS: the standard application menu (⌘Q, ⌘C/⌘V, Window, zoom) plus New Window; the Dock
  // menu mirrors the Windows jump list, and the Dock icon shows the focused project's tile.
  if (process.platform === "darwin") {
    try {
      const newWindow = { label: "New Window", accelerator: "CommandOrControl+Shift+N", click: () => createWindow(null, { pick: true }) };
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { label: "File", submenu: [newWindow, { type: "separator" }, { role: "close" }] }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]));
      if (app.dock) app.dock.setMenu(Menu.buildFromTemplate([newWindow]));
    } catch (e) { console.error("[mac-menu]", e && e.message); }
    app.on("browser-window-focus", (_e, w) => { const r = w && !w.isDestroyed() && windows.get(w.webContents.id); if (r && r.tagIcon && app.dock) { try { app.dock.setIcon(r.tagIcon); } catch { /* */ } } });
  }

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(null, { pick: true }); });

  // Network auto-resume: when connectivity returns, retry all sessions that
  // went offline mid-run. Also broadcast the event so the renderer can update UI.
  let _wasOnline = true;
  const checkOnline = () => {
    const online = require("electron").net.online;
    if (online && !_wasOnline) {
      console.log("[net] connection restored — retrying offline sessions");
      const n = claude.retryAllOffline();
      if (n) console.log(`[net] retrying ${n} session(s)`);
      broadcast("net:status", { online: true });
    } else if (!online && _wasOnline) {
      broadcast("net:status", { online: false });
    }
    _wasOnline = online;
  };
  setInterval(checkOnline, 3000);

  // Auth auto-resume: poll each provider's login state. When a provider flips from
  // signed-out → signed-in (i.e. the user re-authenticated), resume every session
  // that was paused by an expired token for that provider — context intact. Also
  // rebroadcast the status so the renderer can refresh its auth banner instantly.
  let _authState = null;
  const checkAuth = () => {
    let st;
    try { st = auth.providerAuthStatus(); } catch { return; }
    const signedIn = (p) => !!(st[p] && (st[p].loggedIn || st[p].key));
    const cur = {}; for (const p of ["anthropic", "openai", "google", "custom"]) cur[p] = signedIn(p);
    if (_authState) {
      let changed = false;
      for (const p of Object.keys(cur)) {
        if (cur[p] && !_authState[p]) {
          changed = true;
          const n = claude.retryAllAuthExpired(p);
          if (n) console.log(`[auth] ${p} re-authenticated — resuming ${n} paused session(s)`);
          if (p === "anthropic" || p === "openai") try { Promise.resolve(auth.saveNewLoginAsProfile(p)).catch(() => {}); } catch { /* ignore */ }
        } else if (cur[p] !== _authState[p]) { changed = true; }
      }
      if (changed) broadcast("auth:status", { providers: cur });
    }
    _authState = cur;
  };
  setInterval(checkAuth, 4000);
  checkAuth();
  // Credential rotation watcher: mirrors every CLI token refresh into the saved
  // profile it belongs to, auto-saves logins made outside the app, and notes
  // sign-outs — for both Claude and Codex. Windows get "profiles:changed".
  try {
    auth.profiles.startWatcher((provider, info) => {
      if (info && info.loggedOut) {
        broadcast("profiles:changed", { provider, loggedOut: true, was: info.was || "" });
        // Provider-scoped: only THIS provider's runtime bindings are refreshed.
        // Conversation records are untouched — a login change never clears context.
        onProviderLoginChanged(provider);
        checkAuth();
        return;
      }
      // Changed / first seen: reconcile (resolving the account's email first for
      // Claude) — mirrors a rotation, or saves a login made outside the app.
      const snapshotAt = Date.now();
      Promise.resolve(auth.saveNewLoginAsProfile(provider)).then((r) => {
        if (!info || info.initial) return;                       // startup pass: no toast
        // Identity resolved for an OLDER credential snapshot must not relabel a newer one.
        if (auth.profiles.lastChangeAt && auth.profiles.lastChangeAt(provider) > snapshotAt) return;
        broadcast("profiles:changed", { provider, label: (r && r.label) || "", created: !!(r && r.created), rotated: !!(r && r.rotated), loggedIn: !!(info && info.loggedIn) });
        if ((r && r.created) || (info && info.loggedIn)) onProviderLoginChanged(provider);
        checkAuth();
      }).catch(() => {});
    });
  } catch (e) { console.warn("[auth] credential watcher failed to start:", e.message); }
});

// macOS apps stay in the Dock with no windows (⌘N / Dock → New Window reopens one); elsewhere the app exits.
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { try { control.stop(); } catch { /* ignore */ } try { require("./db/db").closeAll(); } catch { /* ignore */ } claude.markInterruptedOnQuit(); claude.interruptAll(); try { fleet.markInterruptedOnQuit(); } catch { /* ignore */ } store.flushAll(); try { lsp.shutdownAll(); } catch { /* ignore */ } try { terminal.killAll(); } catch { /* ignore */ } try { require("./testing/testhost").dispose(); } catch { /* ignore */ } try { if (tsChild) tsChild.kill(); } catch { /* ignore */ } });

// Provider-scoped reaction to a changed login (switch / sign-in / sign-out). Only
// that provider's runtime bindings and catalogs are refreshed; every window's auth
// banner updates; conversation records are untouched. Returns the account the
// runtime acknowledges (Codex) or null.
async function onProviderLoginChanged(provider) {
  let ack = null;
  if (provider === "openai") {
    try { ack = await require("./providers/codex-appserver").refreshLoginContext(); } catch { ack = null; }
    try { require("./providers/catalog").refreshCodexModels(); } catch { /* ignore */ }   // a different Codex login may see different models
    broadcast("codex:account", { account: ack });
  }
  try {
    const st = auth.providerAuthStatus();
    const cur = {}; for (const p of ["anthropic", "openai", "google", "custom"]) cur[p] = !!(st[p] && (st[p].loggedIn || st[p].key));
    broadcast("auth:status", { providers: cur });
  } catch { /* ignore */ }
  return ack;
}
