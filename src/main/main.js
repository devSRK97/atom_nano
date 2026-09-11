"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, powerSaveBlocker, Menu } = require("electron");
const platform = require("./platform");
// macOS/Linux: a Finder/Dock-launched app has launchd's minimal PATH — merge the login shell's PATH
// (Homebrew, ~/.local/bin, nvm/volta…) FIRST, before anything looks for claude / codex / git / npm.
try { platform.fixPath(); } catch { /* best effort */ }
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

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
  try {
    const appCreds = path.join(claudeDir, ".credentials.json");
    const homeCreds = path.join(os.homedir(), ".claude", ".credentials.json");
    const marker = path.join(claudeDir, LOGOUT_MARKER);
    if (fs.existsSync(appCreds)) { try { if (fs.existsSync(marker)) fs.unlinkSync(marker); } catch { /* */ } return; }
    if (fs.existsSync(marker)) return;           // intentionally logged out — stay logged out
    if (fs.existsSync(homeCreds)) fs.copyFileSync(homeCreds, appCreds);
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

const store = require("./store");
const files = require("./files");
const auth = require("./auth");
const claude = require("./claude");
const fleet = require("./fleet");
const terminal = require("./terminal");
const zipper = require("./zipper");
const { utilityProcess } = require("electron");
const git = require("./git");
const lsp = require("./lsp");
// Heavy/rarely-needed modules are loaded on first use, NOT at boot. Prettier is
// large — a user editing only Python (LSP) or plain text should never pay for it.
let _prettier, _editorconfig;
const prettierMod = () => (_prettier || (_prettier = require("prettier")));
const editorconfigMod = () => (_editorconfig || (_editorconfig = require("editorconfig")));

// ---- CLI MODE -----------------------------------------------------------
// When launched with a CLI subcommand (run / providers / models / endpoints …)
// or --cli, run headless: no window, no single-instance lock, no IPC. Reuses the
// same settings / providers / custom endpoints / keys as the GUI. Detected here,
// before the single-instance lock, so other processes can invoke it freely.
{
  const cliMod = require("../cli/cli");
  const cliArgs = process.argv.slice(process.defaultApp ? 2 : 1);
  if (cliMod.isCliInvocation(cliArgs)) {
    try { app.disableHardwareAcceleration(); } catch { /* */ }
    app.whenReady().then(async () => {
      let code = 0;
      try { code = await cliMod.run(cliArgs); }
      catch (e) { process.stderr.write("atomnano: " + ((e && e.message) || e) + "\n"); code = 1; }
      process.exitCode = code || 0;
      app.quit();
    });
    return;   // CommonJS module scope — skip all GUI startup below.
  }
}

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
  tsChild = utilityProcess.fork(path.join(__dirname, "ts-host.js"), [], { serviceName: "atomnano-tsserver" });
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
const PRETTIER_PARSER = { json: "json", jsonc: "json", json5: "json", webmanifest: "json", css: "css", scss: "scss", less: "less", html: "html", htm: "html", xhtml: "html", vue: "vue", md: "markdown", markdown: "markdown", mdx: "mdx", yaml: "yaml", yml: "yaml", graphql: "graphql", gql: "graphql" };

// A full backup is a personal migration archive — it INCLUDES secrets (provider
// API keys, custom-endpoint tokens) and the provider login files, so restoring on
// another machine keeps you signed in. Only truly machine-local state is skipped.
const EXPORT_SKIP_KEYS = new Set(["windowBounds", "historyDir", "claudePath"]);

// Provider authorization files on disk (CLI logins) — backed up so the restore
// is fully signed in. Relative names are preserved under auth/ in the zip.
function providerAuthFiles() {
  const home = os.homedir();
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  // One resolver for every provider home (login, status, profiles, backup): an
  // explicit CODEX_HOME is honoured everywhere, never just in some paths.
  const codexDir = auth.profiles.codexHome();
  return [
    { rel: "claude/.credentials.json", abs: path.join(claudeDir, ".credentials.json") },
    { rel: "codex/auth.json", abs: path.join(codexDir, "auth.json") },
    { rel: "gemini/oauth_creds.json", abs: path.join(home, ".gemini", "oauth_creds.json") },
    { rel: "gemini/google_accounts.json", abs: path.join(home, ".gemini", "google_accounts.json") },
  ];
}

// Build the backup zip. opts.includeSessions → also bundle every conversation.
// Always includes: ALL settings (incl. secrets + custom endpoints with tokens),
// provider login files, and learned skills.
function buildUserdataBundle(opts = {}) {
  const includeSessions = !!opts.includeSessions;
  const s = store.getSettings();
  const prefs = {};
  for (const k of Object.keys(s)) { if (EXPORT_SKIP_KEYS.has(k)) continue; prefs[k] = s[k]; }
  const projectPaths = Object.values(s.projects || {}).map((p) => p && p.path).filter(Boolean);
  const historyDir = s.historyDir;
  const skillsDir = path.join(app.getPath("userData"), "skills");

  // Provider authorizations (CLI login files)
  let authCount = 0;
  const authEntries = [];
  for (const a of providerAuthFiles()) {
    try { if (fs.existsSync(a.abs)) { authEntries.push({ name: `auth/${a.rel}`, data: fs.readFileSync(a.abs) }); authCount++; } } catch { /* skip */ }
  }
  const providerKeysPresent = ["apiKey", "openaiApiKey", "geminiApiKey", "customApiKey"].filter((k) => s[k]);
  const endpointCount = Array.isArray(s.customEndpoints) ? s.customEndpoints.length : 0;

  const sessions = includeSessions ? store.listSessions().map((m) => store.getSession(m.id)).filter(Boolean) : [];
  const entries = [
    { name: "manifest.json", data: JSON.stringify({
      atomnano: 1, kind: "userdata", version: 3, app: "AtomNano", exportedAt: new Date().toISOString(),
      currentProject: s.lastFolder || null, projects: projectPaths, recentProjects: s.recentProjects || [],
      sessionCount: sessions.length, includeSessions, authFiles: authCount, providerKeys: providerKeysPresent.length, customEndpoints: endpointCount,
      includes: ["settings", "secrets", "provider-auth", "custom-endpoints", "skills", ...(includeSessions ? ["conversations"] : [])],
    }, null, 2) },
    { name: "preferences.json", data: JSON.stringify(prefs, null, 2) },
    ...authEntries,
  ];
  for (const sess of sessions) {
    entries.push({ name: `sessions/${sess.id}.json`, data: JSON.stringify(sess, null, 2) });
    for (const ext of [".convo.json", ".archive.jsonl"]) { try { const p = path.join(historyDir, sess.id + ext); if (fs.existsSync(p)) entries.push({ name: `sessions/${sess.id}${ext}`, data: fs.readFileSync(p, "utf8") }); } catch { /* skip */ } }
  }
  let skillCount = 0;
  try { for (const f of fs.readdirSync(skillsDir)) if (f.endsWith(".json")) { entries.push({ name: `skills/${f}`, data: fs.readFileSync(path.join(skillsDir, f), "utf8") }); skillCount++; } } catch { /* no skills */ }
  return { buf: zipper.zip(entries), sessions: sessions.length, projects: projectPaths.length, skills: skillCount, auth: authCount, endpoints: endpointCount };
}
function applyUserdataBundle(buf) {
  const files2 = zipper.unzip(buf);
  const byName = {}; for (const f of files2) byName[f.name.replace(/\\/g, "/")] = f.data;
  let manifest = {}; try { manifest = JSON.parse((byName["manifest.json"] || Buffer.from("{}")).toString("utf8")); } catch { /* tolerate */ }
  if (manifest.kind && manifest.kind !== "userdata") throw new Error("This zip is not an AtomNano data backup");
  const histDir = store.getSettings().historyDir;
  const skillsDir = path.join(app.getPath("userData"), "skills");
  const authByRel = {}; for (const a of providerAuthFiles()) authByRel["auth/" + a.rel] = a.abs;
  let sessionsRestored = 0, skillsRestored = 0, authRestored = 0;
  for (const f of files2) {
    const n = f.name.replace(/\\/g, "/");
    if (/^sessions\/[^/.]+\.json$/.test(n)) { try { const sess = JSON.parse(f.data.toString("utf8")); if (store.writeSessionRaw(sess)) sessionsRestored++; } catch { /* skip corrupt */ } }
    else if (/^sessions\/[^/]+\.(convo\.json|archive\.jsonl)$/.test(n)) { try { fs.mkdirSync(histDir, { recursive: true }); fs.writeFileSync(path.join(histDir, path.basename(n)), f.data); } catch { /* skip */ } }
    else if (/^skills\/[^/]+\.json$/.test(n)) { try { fs.mkdirSync(skillsDir, { recursive: true }); fs.writeFileSync(path.join(skillsDir, path.basename(n)), f.data); skillsRestored++; } catch { /* skip */ } }
    else if (authByRel[n]) { try { const dest = authByRel[n]; fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, f.data); authRestored++; } catch { /* skip */ } }
  }
  let prefs = {}; try { prefs = JSON.parse((byName["preferences.json"] || Buffer.from("{}")).toString("utf8")); } catch { /* tolerate */ }
  const cur = store.getSettings();
  const merged = {};
  for (const k of Object.keys(prefs)) {
    if (EXPORT_SKIP_KEYS.has(k)) continue;   // restore everything incl. secrets + custom endpoints
    if (k === "projects") merged.projects = { ...(cur.projects || {}), ...(prefs.projects || {}) };
    else if (k === "recentProjects") merged.recentProjects = [...new Set([...(prefs.recentProjects || []), ...(cur.recentProjects || [])])].slice(0, 20);
    else merged[k] = prefs[k];
  }
  if (Object.keys(merged).length) store.saveSettings(merged);
  return { sessions: sessionsRestored, skills: skillsRestored, auth: authRestored, projects: (manifest.projects || []).length, manifest };
}
if (process.env.ATOMNANO_TEST) { global.__claude = claude; global.__auth = auth; global.__store = store; global.__defaultMcp = require("./defaultMcp"); } // test hooks only

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
  registerIpc();
  // Never LRU-evict a session with a live turn — claude.js mutates the loaded
  // object in place across the async run; evicting would risk a divergent reload.
  store.setBusyCheck((id) => { try { return claude.isRunning(id); } catch { return false; } });
  claude.setEmitter((channel, payload) => broadcast(channel, payload));
  // Persistence failures (settings / session / archive writes) reach every window
  // as a visible error — "saved" is never claimed for bytes that didn't land.
  store.onError((info) => broadcast("store:error", info));
  try { require("./codex-appserver").setUserData(app.getPath("userData")); } catch { /* */ }
  try { require("./attachments").setDir(path.join(app.getPath("userData"), "attachments")); } catch { /* */ }

  // Background fleet: broadcast task updates so every window's Fleet panel stays live.
  fleet.configure({ emit: (channel, payload) => broadcast(channel, payload) });
  // Terminal output has to reach the renderer as it arrives, not on request.
  terminal.configure({ emit: (channel, payload) => broadcast(channel, payload) });
  // Test Director (goal→green): broadcast goal status transitions.
  require("./director").setEmitter((channel, payload) => broadcast(channel, payload));

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
app.on("before-quit", () => { try { require("./db").closeAll(); } catch { /* ignore */ } claude.markInterruptedOnQuit(); claude.interruptAll(); try { fleet.markInterruptedOnQuit(); } catch { /* ignore */ } store.flushAll(); try { lsp.shutdownAll(); } catch { /* ignore */ } try { terminal.killAll(); } catch { /* ignore */ } try { require("./testhost").dispose(); } catch { /* ignore */ } try { if (tsChild) tsChild.kill(); } catch { /* ignore */ } });

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

// Provider-scoped reaction to a changed login (switch / sign-in / sign-out). Only
// that provider's runtime bindings and catalogs are refreshed; every window's auth
// banner updates; conversation records are untouched. Returns the account the
// runtime acknowledges (Codex) or null.
async function onProviderLoginChanged(provider) {
  let ack = null;
  if (provider === "openai") {
    try { ack = await require("./codex-appserver").refreshLoginContext(); } catch { ack = null; }
    try { require("./providers").refreshCodexModels(); } catch { /* ignore */ }   // a different Codex login may see different models
    broadcast("codex:account", { account: ack });
  }
  try {
    const st = auth.providerAuthStatus();
    const cur = {}; for (const p of ["anthropic", "openai", "google", "custom"]) cur[p] = !!(st[p] && (st[p].loggedIn || st[p].key));
    broadcast("auth:status", { providers: cur });
  } catch { /* ignore */ }
  return ack;
}

function registerIpc() {
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

  // ---- Settings ----
  // Settings are PER-PROJECT (keyed by the requesting window's project), with a
  // global fallback for machine/account-level keys (see store.GLOBAL_ONLY).
  handle("settings:get", async (e) => store.getSettings(projectOf(winFrom(e))));
  handle("settings:set", async (e, partial) => { const s = store.saveSettings(partial || {}, projectOf(winFrom(e))); if (partial && "preventSleep" in partial) applyPreventSleep(s.preventSleep); return s; });

  // ---- Auth / updates ----
  handle("auth:status", async () => auth.status());
  handle("auth:open-login", async () => auth.openLoginTerminal());
  handle("updates:check", async (_e, opts) => auth.checkUpdates(opts || {}));
  handle("updates:run", async (e) => {
    const w = winFrom(e);
    const send = (message) => { if (w && !w.isDestroyed()) w.webContents.send("updates:progress", { message }); };
    const busy = claude.runningCount();
    if (busy > 0) send(`⚠ ${busy} session${busy > 1 ? "s are" : " is"} running — the Claude CLI binary can't be replaced while it is in use. Stop them if the CLI step fails.`);
    const r = await auth.updateAll(send);
    try { claude.resetCliCache(); } catch { /* ignore */ }
    return r;
  });
  // ---- per-tool versions + per-item update, per-provider authorize ----
  handle("tools:versions", async () => auth.toolVersions());
  handle("tools:latest", async (_e, installed, opts) => auth.toolLatest(installed || null, opts || {}));
  // Per-tool update. Serialized (one install at a time), and honest about what is
  // ACTIVE: the Codex app-server is stopped so the next turn spawns the new binary
  // (a running turn keeps the old one until it finishes); an already-imported Codex
  // SDK / Agent SDK module stays the old version in this process until relaunch,
  // which the result says explicitly (installedVersion vs activeVersion).
  let updateInFlight = null;
  handle("tools:update", async (e, tool) => {
    if (updateInFlight) return { ok: false, detail: `Another update (${updateInFlight}) is still running — wait for it to finish.`, busy: true };
    updateInFlight = tool;
    const w = winFrom(e);
    try {
      const r = await auth.updateTool(tool, (message) => { if (w && !w.isDestroyed()) w.webContents.send("updates:progress", { message }); });
      try { claude.resetCliCache(); } catch { /* ignore */ }
      if (r && r.ok) {
        const changed = r.before && r.after && r.before !== r.after;
        if (tool === "codexSdk" || tool === "codex") {
          const appserver = require("./codex-appserver");
          const wasBusy = appserver.busy();
          if (!wasBusy) appserver.stop();
          try { require("./codex").resetSdk(); } catch { /* */ }
          try { require("./providers").refreshCodexModels(); } catch { /* */ }
          r.activation = wasBusy ? "A Codex turn is running — the new version starts with the next Codex turn after it finishes." : "The next Codex turn starts the updated binary.";
          if (changed && require("./codex").sdkLoaded()) r.restartRequired = true;
        }
        if (tool === "agentSdk" && changed) { r.restartRequired = true; r.activation = "The Agent SDK is loaded once per process — restart AtomNano to run the new version."; }
        if (tool === "claudeCli") r.activation = "The next Claude turn spawns the updated CLI.";
      }
      return r;
    } finally { updateInFlight = null; }
  });
  handle("provider:auth-status", async () => auth.providerAuthStatus());
  handle("provider:authorize", async (_e, provider) => auth.authorizeProvider(provider));
  // ---- credential profiles (multi-account; Claude + Codex) ----
  // A login change is a PROVIDER-SCOPED transaction: only that provider's runtime
  // bindings are refreshed (Codex: the login-context app-server re-reads auth.json
  // once idle and the effective account is read back from the runtime; Claude: the
  // CLI reads its credential file per spawn, and native transcripts live in the app
  // home, so resumed sessions simply continue under the new login). Conversation
  // records are never cleared to reload credentials. Running turns keep the
  // credentials they started with; the switch applies at the next turn boundary.
  const afterLoginChange = (provider) => onProviderLoginChanged(provider);
  handle("profiles:list", async (_e, provider) => auth.listProfiles(provider));
  handle("profiles:live", async (_e, provider) => auth.liveLogin(provider));
  handle("profiles:save", async (_e, label, provider) => auth.saveCurrentAsProfile(label, provider));
  handle("profiles:save-current", async (_e, provider) => auth.saveNewLoginAsProfile(provider));
  handle("profiles:switch", async (_e, label, provider) => {
    const r = auth.switchProfile(label, provider);
    if (r && r.ok && !r.already) {
      const ack = await afterLoginChange(provider);
      if (ack) r.runtimeAccount = ack;   // what the runtime ACTUALLY reports after the switch
    }
    return r;
  });
  handle("profiles:logout", async (_e, provider) => {
    const r = await auth.logout(provider);
    if (r && r.ok) await afterLoginChange(provider);
    return r;
  });
  // The account the Codex runtime is actually using (type / email / plan), read from
  // app-server `account/read` — never inferred from a profile label.
  handle("codex:account", async (_e, force) => {
    try { const s = store.getSettings(); return await require("./codex-appserver").accountRead({ apiKey: s.openaiApiKey || "" }, { force: !!force }); } catch (e) { return { error: String((e && e.message) || e) }; }
  });
  handle("profiles:delete", async (_e, label, provider) => auth.deleteProfile(label, provider));
  handle("profiles:rename", async (_e, oldLabel, newLabel, provider) => auth.renameProfile(oldLabel, newLabel, provider));
  handle("profiles:export", async (e, label, provider) => {
    const P = auth.profiles;
    const def = String(label || "account").replace(/[^a-zA-Z0-9_@.\-]/g, "_") + P.exportExt(provider || "anthropic");
    const res = await dialog.showSaveDialog(winFrom(e), { title: "Export saved account", defaultPath: def, filters: [P.fileFilter(provider || "anthropic")] });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    return auth.exportProfile(label, res.filePath, provider);
  });
  handle("profiles:import", async (e, provider) => {
    const P = auth.profiles;
    const res = await dialog.showOpenDialog(winFrom(e), { title: "Import saved account", properties: ["openFile"], filters: [P.fileFilter(provider || "anthropic")] });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
    return auth.importProfile(res.filePaths[0], "", provider);
  });
  // ---- real Claude subscription usage (for the active-tab tooltip) ----
  handle("usage:get", async (_e, force) => auth.fetchUsage(force));
  // (headroom:stats handler removed with the headroom integration.)
  // Probe a raw-HTTP custom provider with a sample prompt. Returns the raw JSON
  // response + extracted text + every detected reply key, so the modal's Test
  // button can show the response and help the user pick the right Output path.
  handle("provider:test-custom", async (_e, cfg) => {
    const customApi = require("./customApi");
    const s = store.getSettings();
    const c = cfg || {};
    const r = await customApi.call({
      endpoint: c.endpoint != null ? c.endpoint : s.customEndpoint,
      headers: c.headers != null ? c.headers : s.customHeaders,
      payloadTemplate: c.payloadTemplate != null ? c.payloadTemplate : s.customPayloadTemplate,
      outputPath: c.outputPath != null ? c.outputPath : s.customOutputPath,
      model: c.model || s.defaultModel || "",
      prompt: c.prompt || "Reply with the single word: pong",
      system: c.system || "",
      apiKey: c.apiKey != null ? c.apiKey : s.customApiKey,
    });
    // Truncate the raw body for transport; keep candidates + extracted text whole.
    return { ok: r.ok, status: r.status || 0, text: r.text || "", usedPath: r.usedPath || null,
      candidates: r.candidates || [], error: r.error || null,
      raw: (r.raw || "").slice(0, 8000), json: r.json || null };
  });

  // ---- Dialogs (scoped to the calling window) ----
  handle("dialog:pick-folder", async (e, defaultPath) => {
    const res = await dialog.showOpenDialog(winFrom(e), { title: "Select a project folder", defaultPath: defaultPath || store.getSettings().lastFolder, properties: ["openDirectory", "createDirectory"] });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });
  handle("dialog:pick-history", async (e) => {
    const res = await dialog.showOpenDialog(winFrom(e), { title: "Select a folder to store session history", defaultPath: store.getSettings().historyDir, properties: ["openDirectory", "createDirectory"] });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });

  // ---- Sessions (lazy: get/messages return windows, not full arrays) ----
  handle("sessions:list", async () => store.listSessions());
  handle("sessions:create", async (_e, opts) => store.createSession(opts || {}));
  // "Continue in a new session": an EXPLICIT action that starts a fresh session
  // (new id, no native threads) carrying the COMPLETE, verbatim record of the
  // source conversation — every message including archived ones — as a
  // conversation-record entry. Nothing is summarised or clipped, and the entry
  // says exactly what it carries. The first turn transfers it to the provider.
  // The record is BOUNDED to the destination model's context window exactly like a thread
  // transfer (exact when it fits, shortened tool payloads, otherwise a cached/rolled summary of
  // the oldest entries plus the most recent entries verbatim) and travels as one "record" entry
  // the first turn transfers to the provider. The source keeps its complete transcript; the
  // session's settings (model, effort, permission mode, 1M context, selected skills) carry over.
  handle("sessions:synthesize", async (_e, srcId) => {
    const src = store.getSession(srcId);
    if (!src) return null;
    const history = require("./history");
    const settings = store.getSettings(src.cwd);
    const provider = settings.llmProvider || "anthropic";
    const last = history.lastGlobalIndex(src);
    const tb = await claude.transferBlock(src, provider, { model: src.model, from: -1, to: last, promptChars: 4000, label: "The new session" });
    const head = `Continued from "${src.name || "a previous session"}" — ${tb.mode === "summary" ? "a summary of the oldest entries and the most recent entries verbatim" : tb.mode === "shortened" ? "the record of that conversation (conversation text verbatim, long tool inputs/outputs shortened)" : "the complete record of that conversation, verbatim"} (${tb.count} entr${tb.count === 1 ? "y" : "ies"}) follows. Tool entries are completed results, not requests to run again.\n\n`;
    const files = (src.editedFiles || []).filter((f) => f && f.path);
    const view = store.createSession({ cwd: src.cwd, name: "↻ " + (src.name || "Session"), model: src.model, thinking: src.thinking, permissionMode: src.permissionMode, oneM: !!src.oneM, selectedSkills: Array.isArray(src.selectedSkills) ? src.selectedSkills.slice() : [] });
    const full = store.getSession(view.id);
    if (full) {
      full.editedFiles = JSON.parse(JSON.stringify(files));
      if (tb.count) full.messages.push({ id: store.uid(), role: "record", text: head + tb.text, ts: store.nowISO(), carriedRecord: true, carriedFrom: srcId, carriedCount: tb.count, meta: { sourceName: src.name || "", sourceId: srcId, entries: tb.count, mode: tb.mode, sourceLastIndex: last, chars: (head + tb.text).length } });
      store.flush(view.id);
    }
    return store.getSessionView(view.id);
  });
  handle("sessions:get", async (_e, id) => store.getSessionView(id));
  handle("sessions:messages", async (_e, id, end, count) => store.getMessagesRange(id, end, count));
  handle("sessions:search", async (_e, id, query) => store.searchSession(id, query));
  handle("sessions:prompts", async (_e, id) => store.listPrompts(id));

  // ---- DBM (database manager) ----
  // ---- Database Manager ----
  // Every DB route validates its payload shape at the boundary (audit DB-045): ids and
  // names are strings, object references are strings or { schema, table }, option bags
  // are plain objects with finite integers. Typed DbErrors keep type/details/hint.
  const db = require("./db");
  const V = {
    id: (v) => { if (typeof v !== "string" || !v || v.length > 200) throw new db.DbError("Invalid connection id.", { type: "invalid" }); return v; },
    str: (v, what, max = 4000) => { if (typeof v !== "string" || v.length > max) throw new db.DbError(`Invalid ${what}.`, { type: "invalid" }); return v; },
    text: (v, what) => { if (typeof v !== "string") throw new db.DbError(`Invalid ${what}.`, { type: "invalid" }); return v; },
    ref: (v) => { if (typeof v === "string") return V.str(v, "object name", 600); if (v && typeof v === "object" && typeof (v.table || v.name) === "string") return { schema: typeof v.schema === "string" ? v.schema : "", table: v.table || v.name }; throw new db.DbError("Invalid object reference.", { type: "invalid" }); },
    obj: (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}),
    opts: (v) => { const o = V.obj(v); for (const k of ["limit", "offset", "batch", "expectRev"]) if (o[k] != null && (!Number.isFinite(+o[k]) || +o[k] < 0)) throw new db.DbError(`Invalid ${k}.`, { type: "invalid" }); if (o.session != null && typeof o.session !== "string") throw new db.DbError("Invalid session.", { type: "invalid" }); if (o.argv != null && !Array.isArray(o.argv)) throw new db.DbError("Invalid argv.", { type: "invalid" }); return o; },
    list: (v, what) => { if (!Array.isArray(v)) throw new db.DbError(`Invalid ${what}.`, { type: "invalid" }); return v; },
  };
  handle("db:kinds", async () => db.kinds());
  handle("db:list", async () => db.list());
  handle("db:save", async (_e, conn) => db.save(V.obj(conn)));
  handle("db:remove", async (_e, id) => db.remove(V.id(id)));
  handle("db:reveal-secret", async (_e, id, field) => db.revealSecret(V.id(id), V.str(field, "field", 20)));
  handle("db:session-secret", async (_e, id, fields) => db.setSessionSecret(V.id(id), V.obj(fields)));
  handle("db:test", async (_e, connOrId) => db.test(typeof connOrId === "string" ? V.id(connOrId) : V.obj(connOrId)));
  handle("db:schema", async (_e, id) => db.schema(V.id(id)));
  handle("db:schema-more", async (_e, id, opts) => db.schemaMore(V.id(id), V.opts(opts)));
  handle("db:columns", async (_e, id, table) => db.columns(V.id(id), V.ref(table)));
  handle("db:query", async (_e, id, text, opts) => db.query(V.id(id), V.text(text == null ? "" : text, "statement"), V.opts(opts)));
  handle("db:parallel-query", async (_e, id, queries, opts) => db.parallelQuery(V.id(id), V.list(queries || [], "queries").map((q) => V.text(q, "statement")), V.opts(opts)));
  handle("db:split-script", async (_e, id, text) => db.splitScript(V.id(id), V.text(text == null ? "" : text, "script")));
  handle("db:format-sql", async (_e, id, text) => db.formatSql(V.id(id), V.text(text == null ? "" : text, "script")));
  handle("db:session-open", async (_e, id) => db.sessionOpen(V.id(id)));
  handle("db:session-close", async (_e, sid, opts) => db.sessionClose(V.str(sid, "session", 64), V.obj(opts)));
  handle("db:session-set", async (_e, sid, patch) => db.sessionSet(V.str(sid, "session", 64), V.obj(patch)));
  handle("db:cancel", async (_e, opId) => db.cancel(V.str(opId, "operation id", 64)));
  handle("db:add-column", async (_e, id, table, col, opts) => db.addColumn(V.id(id), V.ref(table), V.obj(col), V.opts(opts)));
  handle("db:drop-column", async (_e, id, table, name, opts) => db.dropColumn(V.id(id), V.ref(table), V.str(name, "column", 256), V.opts(opts)));
  handle("db:rename-column", async (_e, id, table, oldName, newName, opts) => db.renameColumn(V.id(id), V.ref(table), V.str(oldName, "column", 256), V.str(newName, "column", 256), V.opts(opts)));
  handle("db:add-index", async (_e, id, table, spec, opts) => db.addIndex(V.id(id), V.ref(table), V.obj(spec), V.opts(opts)));
  handle("db:drop-index", async (_e, id, table, name, opts) => db.dropIndex(V.id(id), V.ref(table), V.str(name, "index", 256), V.opts(opts)));
  handle("db:schema-plan", async (_e, id, table, plan, opts) => db.schemaPlan(V.id(id), V.ref(table), V.obj(plan), V.opts(opts)));
  handle("db:ping", async (_e, id) => db.ping(V.id(id)));
  const dbio = require("./db-io");
  handle("db:export-file", async (e, opts) => dbio.exportFile(winFrom(e), V.opts(opts)));
  handle("db:export-cancel", async (_e, token) => dbio.exportCancel(V.str(token, "token", 64)));
  handle("db:import-pick", async (e, opts) => dbio.importPick(winFrom(e), V.opts(opts)));
  handle("db:import-run", async (e, opts) => dbio.importRun(winFrom(e), V.opts(opts)));
  handle("db:import-cancel", async (_e, token) => dbio.importCancel(V.str(token, "token", 64)));
  handle("db:import-discard", async (_e, token) => dbio.importDiscard(V.str(token, "token", 64)));
  handle("db:job-status", async (_e, token) => dbio.jobStatus(V.str(token, "token", 64)));
  handle("db:jobs", async (e) => dbio.jobsFor(winFrom(e)));
  handle("db:reorder-columns", async (_e, id, table, order, opts) => db.reorderColumns(V.id(id), V.ref(table), V.list(order || [], "order"), V.opts(opts)));
  handle("db:table-info", async (_e, id, table) => db.tableInfo(V.id(id), V.ref(table)));
  handle("db:count", async (_e, id, table, where) => db.count(V.id(id), V.ref(table), V.str(where == null ? "" : where, "filter")));
  handle("db:browse", async (_e, id, table, opts) => db.browse(V.id(id), V.ref(table), V.opts(opts)));
  handle("db:insert-row", async (_e, id, table, values, opts) => db.insertRow(V.id(id), V.ref(table), V.obj(values), V.opts(opts)));
  handle("db:update-rows", async (_e, id, table, spec, opts) => db.updateRows(V.id(id), V.ref(table), V.obj(spec), V.opts(opts)));
  handle("db:delete-rows", async (_e, id, table, pks, opts) => db.deleteRows(V.id(id), V.ref(table), V.list(pks || [], "keys"), V.opts(opts)));
  handle("db:explain", async (_e, id, text) => db.explain(V.id(id), V.text(text == null ? "" : text, "statement")));
  handle("db:install-driver", async (_e, kind) => db.installDriver(V.str(kind, "kind", 20)));
  handle("db:disconnect", async (_e, id) => { await db.disconnect(V.id(id)); return true; });
  handle("db:open-window", async () => {
    const dbWin = new BrowserWindow({
      width: 1200, height: 760, minWidth: 900, minHeight: 520,
      ...platform.windowChrome(), backgroundColor: "#1a1512", show: false,
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false },
    });
    dbWin.loadFile(INDEX_HTML, { query: { dbm: "1" } });
    const sendMax = () => { if (!dbWin.isDestroyed()) dbWin.webContents.send("win:maximized-change", dbWin.isMaximized()); };
    dbWin.on("maximize", sendMax); dbWin.on("unmaximize", sendMax);
    dbWin.once("ready-to-show", () => dbWin.show());
    return true;
  });
  handle("sessions:rename", async (_e, id, name) => { store.updateSession(id, { name: (name || "Untitled session").trim() }); return store.getMeta(id); });
  handle("sessions:update", async (_e, id, patch) => { store.updateSession(id, patch || {}); return store.getMeta(id); });
  handle("sessions:delete", async (_e, id) => { await claude.interrupt(id); return store.deleteSession(id); });
  handle("sessions:delete-message", async (_e, id, mid) => store.deleteMessage(id, mid));
  handle("sessions:send", async (_e, id, payload) => {
    if (process.env.ATOMNANO_TEST) global.__lastRunPayload = payload || {};
    // Pre-flight failures (already running, missing session, immediate validation)
    // need to reach the renderer so the user sees a toast instead of a silent
    // dropped prompt. Wait one microtask so a synchronous throw surfaces here.
    let preflightErr = null;
    const p = claude.run(id, payload || {}).catch((err) => {
      console.error("[run]", err);
      preflightErr = err;
    });
    await Promise.race([p, new Promise((r) => setImmediate(r))]);
    if (preflightErr) throw preflightErr;
    return { started: true };
  });
  handle("sessions:interrupt", async (_e, id, reason) => claude.interrupt(id, reason || "stop"));
  // Enter mid-turn on a Codex session: append to the running turn (turn/steer) instead
  // of interrupting. Returns { steered:false } when there's nothing steerable.
  handle("sessions:steer", async (_e, id, payload) => claude.steer(id, payload || {}));
  handle("sessions:running", async (_e, id) => claude.isRunning(id));
  // Per-run diagnostics: provider / transport / auth context / requested+sent
  // model & effort / transferred entries / native ids — secrets never included.
  handle("sessions:last-run", async () => { const r = claude.lastRunInfo(); return r ? { sessionId: r.sessionId, runId: r.runId, sent: r.sent, init: r.init, resumeRequested: r.resumeRequested, resumedFresh: !!r.resumedFresh, ultracodeApplied: !!r.ultracodeApplied } : null; });
  handle("sessions:retry", async (_e, id) => claude.retryPending(id));
  // Live-query control requests — only act while a turn is running (fresh query per
  // turn), so these return null/false between turns. See SessionManager._liveQuery.
  handle("sessions:context-usage", async (_e, id) => claude.contextUsage(id));
  handle("sessions:mcp-status", async (_e, id) => claude.mcpStatus(id));
  handle("sessions:rewind", async (_e, id, userMessageId) => claude.rewindFiles(id, userMessageId));
  handle("sessions:set-model-live", async (_e, id, model) => claude.setModelLive(id, model));
  handle("sessions:set-mode-live", async (_e, id, mode) => claude.setPermissionModeLive(id, mode));
  ipcMain.on("sessions:permission-response", (_e, requestId, decision) => claude.respondPermission(requestId, decision));
  handle("sessions:open-history", async () => { await shell.openPath(store.getSettings().historyDir); return true; });

  // Export one or many conversations. Two modes:
  //   "full"    (default) — every message, tool call, attachment. Re-importable.
  //   "compact" — distilled digest + last 40 exchanges + editedFiles + meta.
  //              Much smaller (~5-20 KB vs megabytes for long chats) and readable.
  handle("sessions:export", async (e, ids, mode) => {
    // Full export = the COMPLETE transcript (archive + live) per session.
    const raw = (Array.isArray(ids) ? ids : [ids]).map((id) => (mode === "compact" ? store.getSession(id) : store.exportSession(id))).filter(Boolean);
    if (!raw.length) throw new Error("Nothing to export");
    const compact = mode === "compact";
    const tag = compact ? ".compact" : "";
    const def = raw.length === 1
      ? ((raw[0].name || "session").replace(/[^a-z0-9_\- ]/gi, "").trim().slice(0, 60) || "session") + `${tag}.atomnano.json`
      : `atomnano-conversations-${raw.length}${tag}.atomnano.json`;
    const res = await dialog.showSaveDialog(winFrom(e), { title: `Export conversation(s)${compact ? " (compact)" : ""}`, defaultPath: def, filters: [{ name: "AtomNano conversations", extensions: ["json"] }] });
    if (res.canceled || !res.filePath) return { canceled: true };

    let list;
    if (compact) {
      const convo = require("./convo");
      list = raw.map((s) => {
        const digest = (() => { try { return convo.digestFor(s) || ""; } catch { return ""; } })();
        const msgs = (s.messages || []);
        const recent = []; let used = 0;
        for (let i = msgs.length - 1; i >= 0 && recent.length < 40; i--) {
          const m = msgs[i];
          if (!m || !m.text || (m.role !== "user" && m.role !== "assistant" && m.role !== "system" && m.role !== "error")) continue;
          const text = String(m.text).length > 800 ? String(m.text).slice(0, 800) + "…" : String(m.text);
          const entry = { role: m.role, text, ts: m.ts };
          if (m.meta) entry.meta = m.meta;
          if (used + text.length > 16000 && recent.length >= 6) break;
          recent.unshift(entry); used += text.length;
        }
        return {
          id: s.id, name: s.name, cwd: s.cwd, model: s.model, thinking: s.thinking, oneM: s.oneM,
          createdAt: s.createdAt, updatedAt: s.updatedAt,
          totalMessages: msgs.length + (s.archivedCount || 0),
          totalCostUsd: s.totalCostUsd || 0,
          editedFiles: (s.editedFiles || []).map((f) => ({ path: f.path, count: f.count, added: f.added, removed: f.removed })),
          digest,
          recentMessages: recent,
          _compact: true,
        };
      });
    } else {
      list = raw;
    }
    fs.writeFileSync(res.filePath, JSON.stringify({ atomnano: 1, version: compact ? 2 : 3, mode: compact ? "compact" : "full", exportedAt: new Date().toISOString(), sessions: list }, null, 2));
    return { path: res.filePath, count: list.length, mode: compact ? "compact" : "full", messages: compact ? undefined : list.reduce((n, s) => n + (s.messages || []).length, 0) };
  });
  // Import a bundle (single or many) → new sessions, transcript preserved.
  handle("sessions:import", async (e) => {
    const res = await dialog.showOpenDialog(winFrom(e), { title: "Import conversation(s)", properties: ["openFile"], filters: [{ name: "AtomNano conversations", extensions: ["json"] }] });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    let raw;
    try { raw = JSON.parse(fs.readFileSync(res.filePaths[0], "utf8")); } catch { throw new Error("Could not read the file"); }
    const arr = Array.isArray(raw.sessions) ? raw.sessions : (raw.session ? [raw.session] : (Array.isArray(raw) ? raw : [raw]));
    const views = arr.map((s) => store.importSession(s)).filter(Boolean);
    if (!views.length) throw new Error("No valid AtomNano conversations in that file");
    return { count: views.length, sessions: views, first: views[0] };
  });

  // ---- Full user-data backup/restore (preferences + tabs/projects/recents +
  // last 7 sessions), bundled as a single .zip ----
  handle("userdata:export", async (e, opts) => {
    const includeSessions = !!(opts && opts.includeSessions);
    const bundle = buildUserdataBundle({ includeSessions });
    const tag = includeSessions ? "full" : "app";
    const def = `atomnano-backup-${tag}-${new Date().toISOString().slice(0, 10)}.zip`;
    const res = await dialog.showSaveDialog(winFrom(e), { title: "Back up AtomNano data", defaultPath: def, filters: [{ name: "AtomNano backup", extensions: ["zip"] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, bundle.buf);
    return { path: res.filePath, sessions: bundle.sessions, projects: bundle.projects, skills: bundle.skills, auth: bundle.auth, endpoints: bundle.endpoints, includeSessions };
  });
  handle("userdata:import", async (e) => {
    const res = await dialog.showOpenDialog(winFrom(e), { title: "Import AtomNano data", properties: ["openFile"], filters: [{ name: "AtomNano backup", extensions: ["zip"] }] });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    let buf;
    try { buf = fs.readFileSync(res.filePaths[0]); } catch { throw new Error("Could not read the file"); }
    let out;
    try { out = applyUserdataBundle(buf); } catch (err) { throw new Error(err.message || "Not a valid AtomNano backup (.zip)"); }
    return { ok: true, ...out };
  });

  // ---- Per-project window state ----
  handle("project:get-tabs", async (_e, p) => store.getProjectTabs(p));
  handle("project:save-tabs", async (_e, p, data) => { if (p) store.setProjectTabs(p, data || {}); return true; });

  // ---- Files ----
  handle("files:list", async (_e, dirPath) => files.listDir(dirPath));
  handle("files:watch", async (e, root) => { startWatch(winFrom(e), root); return { root: root || "" }; });
  handle("files:read", async (_e, filePath) => files.readFile(filePath));
  // Read a (small) binary file as a data: URL — used by the in-editor image preview.
  handle("files:data-url", async (_e, filePath) => {
    const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml", avif: "image/avif" };
    try {
      const st = fs.statSync(filePath);
      if (st.size > 20 * 1024 * 1024) return null;   // refuse very large images
      const ext = (filePath.split(".").pop() || "").toLowerCase();
      const mime = MIME[ext] || "application/octet-stream";
      return { dataUrl: `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`, size: st.size, mime };
    } catch { return null; }
  });
  handle("files:write", async (_e, filePath, content) => files.writeFile(filePath, content));
  handle("files:write-checked", async (_e, filePath, content, expected) => files.writeFileChecked(filePath, content, expected));
  /* Where should this buffer live? Asked for a file that has never had a path —
   * a new tab the user typed into — so the OS picker is the right surface: it is
   * the only one that can create folders, overwrite-confirm, and reach outside
   * the project. Returns the chosen path so the editor can reopen it for real. */
  handle("files:save-as", async (e, opts) => {
    const { defaultPath, content } = opts || {};
    const res = await dialog.showSaveDialog(winFrom(e), {
      title: "Save As",
      defaultPath: defaultPath || undefined,
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    await files.writeFile(res.filePath, String(content ?? ""));
    return { path: res.filePath };
  });
  handle("files:reveal", async (_e, p) => files.reveal(p));
  handle("files:open", async (_e, p) => files.openPath(p));
  handle("files:trash", async (_e, p) => files.trash(p));
  /* Renaming a file breaks every import that pointed at it. The language service
   * can rewrite them — including the relative specifiers INSIDE the moved file,
   * which now resolve from a different directory — but only while its program
   * still knows the old path, so the edits are captured first and written after
   * the rename lands. Best-effort throughout: a project with no tsconfig, or a
   * path the service can't map, leaves imports untouched rather than failing the
   * rename the user actually asked for. */
  const fileRenameEdits = async (root, oldPath, newPath) => {
    if (!root) return null;
    try { return await tsCall("request", ["fileRename", root, oldPath, { oldPath, newPath }]); }
    catch { return null; }
  };
  const samePath = (a, b) => String(a || "").replace(/\\/g, "/").toLowerCase() === String(b || "").replace(/\\/g, "/").toLowerCase();
  const applyRenameEdits = async (edits, oldPath, newPath) => {
    const list = (edits && edits.files) || [];
    if (!list.length) return { files: 0, edits: 0 };
    let touched = 0, applied = 0;
    for (const fc of list) {
      // Edits for the moved file itself are addressed to its OLD name; its
      // content is unchanged by the move, so the offsets still line up.
      const target = samePath(fc.fileName, oldPath) ? newPath : fc.fileName;
      let text; try { text = fs.readFileSync(target, "utf8"); } catch { continue; }
      let next = text;
      for (const e of [...(fc.edits || [])].sort((a, b) => b.from - a.from)) next = next.slice(0, e.from) + e.text + next.slice(e.to);
      if (next === text) continue;
      try { fs.writeFileSync(target, next, "utf8"); touched++; applied += (fc.edits || []).length; } catch { /* read-only — report the rest */ }
    }
    return { files: touched, edits: applied };
  };
  // Create / rename / move, and replace-across-files. Each throws on conflict so
  // the renderer can surface the reason instead of silently clobbering.
  /* Integrated terminal — a shell inside the app, so a command's output is
   * something the app can show and read back (see terminal.js). */
  handle("terminal:create", async (_e, opts) => terminal.create(opts || {}));
  handle("terminal:write", async (_e, id, data) => terminal.write(id, data));
  handle("terminal:run", async (_e, id, command) => terminal.run(id, command));
handle("terminal:run-tracked", async (_e, id, command) => terminal.runTracked(id, command));
  handle("terminal:resize", async (_e, id, cols, rows) => terminal.resize(id, cols, rows));
  handle("terminal:interrupt", async (_e, id) => terminal.interrupt(id));
  handle("terminal:clear", async (_e, id) => terminal.clear(id));
  handle("terminal:kill", async (_e, id) => terminal.kill(id));
  handle("terminal:list", async () => terminal.list());
  handle("terminal:buffer", async (_e, id) => terminal.buffer(id));
  handle("terminal:rename", async (_e, id, title) => terminal.rename(id, title));

  handle("files:create-file", async (_e, p, content) => files.createFile(p, content));
  handle("files:create-folder", async (_e, p) => files.createFolder(p));
  handle("files:rename", async (_e, p, newName, root) => {
    const target = path.join(path.dirname(p), String(newName || "").trim());
    // Edits MUST be computed before the move: the language service answers from a
    // program built on the old path, and once the file is gone it can't.
    const edits = await fileRenameEdits(root, p, target);
    const res = await files.renamePath(p, newName);
    const refactor = res.unchanged ? null : await applyRenameEdits(edits, p, res.path);
    return { ...res, refactor };
  });
  handle("files:move", async (_e, from, to, root) => {
    const edits = await fileRenameEdits(root, from, to);
    const res = await files.movePath(from, to);
    const refactor = await applyRenameEdits(edits, from, res.path);
    return { ...res, refactor };
  });
  handle("files:replace-in-files", async (_e, opts) => files.replaceInFiles(opts || {}));
  // Resolve a relative import/require specifier to an on-disk file (for go-to-definition).
  handle("files:resolve-import", async (_e, fromFile, spec) => {
    try {
      if (!fromFile || !spec) return null;
      const target = path.resolve(path.dirname(fromFile), spec);
      const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py"];
      for (const ext of exts) { const p = target + ext; if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; }
      for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py"]) { const p = path.join(target, "index" + ext); if (fs.existsSync(p)) return p; }
      if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
      return null;
    } catch { return null; }
  });
  handle("files:open-terminal", async (_e, p) => {
    let cwd = p;
    try { if (cwd && fs.existsSync(cwd) && !fs.statSync(cwd).isDirectory()) cwd = path.dirname(cwd); } catch { /* use as-is */ }
    if (!cwd || !fs.existsSync(cwd)) throw new Error("Folder no longer exists");
    // The user's terminal at the folder: Windows Terminal, macOS Terminal.app, or the desktop's default.
    platform.openTerminal({ cwd });
    return true;
  });
  handle("files:find-definition", async (_e, root, word, lang) => files.findDefinition({ root, word, lang }));
  handle("files:size", async (_e, p) => files.fileSize(p));
  handle("files:search-names", async (_e, opts) => files.searchNames(opts || {}));
  handle("files:search-content", async (_e, opts) => files.searchContent(opts || {}));

  // ---- Git ----
  // Every mutating route runs as ONE operation: its git processes share an id, their
  // live output (fetch/push progress, hooks, credential prompts) is broadcast as
  // git:progress, and the renderer can cancel by id. Reads run plainly.
  git.setProgressSink((ev) => broadcast("git:progress", ev));
  const gitOp = (label, fn) => async (_e, cwd, ...args) => git.runInOperation({ label, cwd }, () => fn(cwd, ...args));
  handle("git:cancel", async (_e, opId) => git.cancel(opId));
  handle("git:watch", async (e, repos) => { startGitWatch(winFrom(e), repos); return true; });
  handle("git:repos", async (_e, root) => git.repos(root));
  handle("git:probe", async (_e, cwd) => git.probe(cwd));
  handle("git:is-repo-dir", async (_e, dir) => git.isRepoDir(dir));
  handle("git:repo-for-file", async (_e, filePath) => git.repoForFile(filePath));
  handle("git:status", async (_e, cwd, opts) => git.status(cwd, opts || {}));
  handle("git:branch", async (_e, cwd) => git.currentBranch(cwd));
  handle("git:stage", gitOp("Stage", (cwd, files2) => git.stage(cwd, files2)));
  handle("git:unstage", gitOp("Unstage", (cwd, files2) => git.unstage(cwd, files2)));
  handle("git:stage-all", gitOp("Stage all", (cwd) => git.stageAll(cwd)));
  handle("git:stage-tracked", gitOp("Stage tracked", (cwd) => git.stageTracked(cwd)));
  handle("git:unstage-all", gitOp("Unstage all", (cwd) => git.unstageAll(cwd)));
  handle("git:commit", gitOp("Commit", (cwd, message, opts) => git.commit(cwd, message, opts || {})));
  handle("git:commit-files", gitOp("Commit", (cwd, message, files2, opts) => git.commitFiles(cwd, message, files2, opts || {})));
  handle("git:commit-plan", gitOp("Commit", (cwd, plan) => git.commitPlan(cwd, plan || {})));
  handle("git:pull", gitOp("Pull", (cwd, opts) => git.pull(cwd, opts || {})));
  handle("git:push", gitOp("Push", (cwd, opts) => git.push(cwd, opts || {})));
  handle("git:push-plan", async (_e, cwd, opts) => git.pushPlan(cwd, opts || {}));
  handle("git:diff", async (_e, cwd, file, opts) => git.diff(cwd, file, opts || {}));
  handle("git:file-diff", async (_e, cwd, file) => git.fileDiff(cwd, file));
  handle("git:branches", async (_e, cwd) => git.branches(cwd));
  handle("git:checkout", gitOp("Checkout", (cwd, branch, opts) => git.checkout(cwd, branch, opts || {})));
  handle("git:merge", gitOp("Merge", (cwd, branch, opts) => git.merge(cwd, branch, opts || {})));
  handle("git:merge-branches", gitOp("Merge", (cwd, source, target, message, opts) => git.mergeBranches(cwd, source, target, message, opts || {})));
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
  // (The auto-maintained project memory graph, conversation digest / thread graph
  //  and capabilities graph were removed: no app-authored context is injected into
  //  runs any more. The compact export still uses convo.digestFor explicitly.)

  // ---- skills (the user's explicit library: create / import / select per tab) ----
  const skills = require("./skills");
  handle("skills:list", async (_e, cwd) => skills.list(cwd));
  handle("skills:create", async (_e, cwd, input) => skills.create(cwd, input || {}));
  handle("skills:update", async (_e, cwd, id, patch) => skills.update(cwd, id, patch || {}));
  handle("skills:remove", async (_e, cwd, id) => skills.remove(cwd, id));
  handle("skills:promote", async (_e, cwd, id) => skills.promote(cwd, id));
  handle("skills:peek", async (_e, cwd) => skills.peek(cwd));
  handle("skills:hub", async (_e, category) => skills.hub(category));
  handle("skills:cross-project", async (_e, cwd) => skills.crossProject(cwd));
  handle("skills:scout", async (_e, cwd, query) => skills.scout(cwd, query));
  handle("skills:import-skill", async (_e, cwd, input) => skills.importSkill(cwd, input || {}));
  handle("skills:import-url", async (_e, cwd, url) => skills.importFromUrl(cwd, url));
  handle("skills:export-skill", async (_e, cwd, id) => skills.exportSkill(cwd, id));
  handle("skills:marketplace", async (_e, opts) => skills.marketplace(opts || {}));
  handle("skills:install", async (_e, cwd, entry) => skills.installMarketplace(cwd, entry || {}));

  // ---- fleet (background agents on a queue, same-file conflict prevention) ----
  handle("fleet:list", async () => fleet.list());
  handle("fleet:enqueue", async (_e, cwd, task) => fleet.enqueue({ cwd, ...(task || {}) }));
  handle("fleet:enqueue-many", async (_e, cwd, items) => fleet.enqueueMany(cwd, items || []));
  handle("fleet:cancel", async (_e, id) => fleet.cancel(id));
  handle("fleet:retry", async (_e, id) => fleet.retry(id));
  handle("fleet:remove", async (_e, id) => fleet.remove(id));
  handle("fleet:clear-finished", async () => fleet.clearFinished());

  // ---- Test Director: per-project test catalog + embedded-browser executor ----
  const testdir = require("./testdir");
  handle("testdir:list", async (_e, cwd, filter) => testdir.list(cwd, filter || {}));
  handle("testdir:get", async (_e, cwd, id) => testdir.get(cwd, id));
  handle("testdir:upsert", async (_e, cwd, t, opts) => testdir.upsert(cwd, t || {}, opts || {}));
  handle("testdir:remove", async (_e, cwd, id) => testdir.remove(cwd, id));
  handle("testdir:retag", async (_e, cwd, id, patch) => testdir.retag(cwd, id, patch || {}));
  handle("testdir:select", async (_e, cwd, sel) => testdir.select(cwd, sel || {}));
  handle("testdir:run", async (_e, cwd, id, opts) => testdir.runTest(cwd, id, opts || {}));
  handle("testdir:run-selection", async (_e, cwd, sel, opts) => testdir.runSelection(cwd, sel || {}, opts || {}));
  handle("testdir:flake-gate", async (_e, cwd, ids, n) => testdir.flakeGate(cwd, ids || [], n || 3));
  handle("testdir:peek", async (_e, cwd) => testdir.peek(cwd));
  handle("testdir:classify", async (_e, source) => testdir.classifyByImports(source || ""));
  handle("testdir:integrity", async (_e, oldT, newT) => testdir.checkIntegrity(oldT || {}, newT || {}));
  handle("testdir:goal-create", async (_e, cwd, g) => testdir.createGoal(cwd, g || {}));
  handle("testdir:goal-update", async (_e, cwd, id, patch) => testdir.updateGoal(cwd, id, patch || {}));
  handle("testdir:goal-approve", async (_e, cwd, id) => testdir.approveGoal(cwd, id));
  handle("testdir:goal-attach", async (_e, cwd, gid, tid) => testdir.attachTest(cwd, gid, tid));
  handle("testdir:goals", async (_e, cwd) => testdir.listGoals(cwd));
  handle("testdir:goal-green", async (_e, cwd, id) => testdir.goalGreen(cwd, id));
  handle("testhost:run", async (_e, target, steps) => require("./testhost").runSteps(target, steps, { now: Date.now }));

  // ---- Test Director Phase 2: goal → GREEN orchestrator ----
  const director = require("./director");
  handle("director:plan", async (_e, cwd, prompt, opts) => director.plan(cwd, prompt, opts || {}));
  handle("director:approve", async (_e, cwd, goalId) => director.approve(cwd, goalId));
  handle("director:run", async (_e, cwd, goalId, opts) => director.runGoal(cwd, goalId, opts || {}));

  // ---- test-only hooks (deterministic fleet/heal without a live model) ----
  // A scripted ACP agent (transport) for the Gemini primary test: speaks the
  // same JSON-RPC the real CLI does — streams text + a thought, opens a tool
  // call, asks permission, writes a file via fs/write_text_file, then ends.
  function makeFakeAcp() {
    let onLine = null, onClose = null, aid = 0;
    const pending = {};
    const emit = (o) => setImmediate(() => onLine && onLine(JSON.stringify(o)));
    const notify = (method, params) => emit({ jsonrpc: "2.0", method, params });
    const request = (method, params, cb) => { const id = "a" + (++aid); pending[id] = cb; emit({ jsonrpc: "2.0", id, method, params }); };
    const upd = (update) => notify("session/update", { sessionId: "s1", update });
    return {
      write: (s) => {
        let m; try { m = JSON.parse(s); } catch { return; }
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending[m.id]) { const cb = pending[m.id]; delete pending[m.id]; cb(m.result); return; }
        if (m.method === "initialize") return emit({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
        if (m.method === "session/new") return emit({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
        // Resume: replay one history chunk (the client must SUPPRESS it), then ack.
        if (m.method === "session/load") { upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED HISTORY — should be suppressed" } }); return emit({ jsonrpc: "2.0", id: m.id, result: null }); }
        if (m.method === "session/prompt") {
          const pid = m.id;
          global.__geminiPromptBlocks = (m.params && m.params.prompt) || null;   // capture for attachment assertions
          upd({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "considering the request…" } });
          upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
          upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "from Gemini" } });
          upd({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Write out.txt", kind: "edit", status: "pending", locations: [{ path: "out.txt" }], rawInput: { file_path: "out.txt", content: "hi" } });
          request("session/request_permission", { sessionId: "s1", toolCall: { title: "Write out.txt", kind: "edit", rawInput: { file_path: "out.txt", content: "hi" } }, options: [{ optionId: "allow1", kind: "allow_once", name: "Allow" }, { optionId: "reject1", kind: "reject_once", name: "Reject" }] }, (result) => {
            global.__geminiPerm = result && result.outcome;
            const allowed = result && result.outcome && result.outcome.outcome === "selected" && /allow/i.test(result.outcome.optionId || "");
            if (allowed) {
              request("fs/write_text_file", { sessionId: "s1", path: "out.txt", content: "hi from gemini" }, () => {
                upd({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "wrote out.txt" } }] });
                emit({ jsonrpc: "2.0", id: pid, result: { stopReason: "end_turn" } });
              });
            } else {
              upd({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
              emit({ jsonrpc: "2.0", id: pid, result: { stopReason: "end_turn" } });
            }
          });
          return;
        }
        if (m.id !== undefined) emit({ jsonrpc: "2.0", id: m.id, result: null });
      },
      onLine: (cb) => { onLine = cb; },
      onClose: (cb) => { onClose = cb; },
      kill: () => { if (onClose) onClose(0); },
    };
  }
  if (process.env.ATOMNANO_TEST) {
    handle("test:fleet-fake-runner", async (_e, holdMs) => {
      // A runner that simulates an agent editing the file named in its prompt
      // ("edit <relpath>"), exercising the FileLockManager without the SDK.
      const testLog = (global.__fleetTestLog = []);
      fleet.configure({ runner: (sessionId, opts) => new Promise((resolve) => {
        const cwd = (store.getSession(sessionId) || {}).cwd || "";
        const m = /edit\s+(\S+)/i.exec(opts.text || "");
        if (m && opts.canUseToolOverride) {
          const file = cwd.replace(/[\\/]+$/, "") + "/" + m[1];
          const dec = opts.canUseToolOverride("Edit", { file_path: file });
          testLog.push({ sessionId, file: m[1], behavior: dec && dec.behavior });
        }
        setTimeout(resolve, holdMs || 250);
      }) });
      return true;
    });
    handle("test:fleet-log", async () => global.__fleetTestLog || []);
    handle("test:council-runner", async () => { require("./council").setRunner(async (provider, model, prompt) => ({ ok: true, text: `[${provider}/${model || "default"}] ${/proposed this answer/.test(prompt) ? "REVIEW" : "ADVICE"}: noted` })); return true; });
    handle("test:council-consult", async (_e, cwd, reviewers, prompt) => {
      const sess = store.createSession({ cwd: cwd || os.homedir(), name: "council" });
      const full = store.getSession(sess.id);
      // seed a prior exchange so we can verify the reviewer is given context
      full.messages.push({ id: store.uid(), role: "assistant", text: "DevOps is a culture bridging dev and ops.", ts: store.nowISO() });
      full.messages.push({ id: store.uid(), role: "user", text: prompt || "", ts: store.nowISO() });
      const digest = await claude.consultReviewers(full, reviewers || [], prompt || "");
      return { digest, messages: full.messages.filter((m) => m.role === "reviewer").map((m) => ({ provider: m.reviewProvider, model: m.reviewModel, kind: m.reviewKind, text: m.text, asked: m.asked })) };
    });
    handle("test:council-review", async (_e, cwd, reviewers, prompt, answer) => {
      const sess = store.createSession({ cwd: cwd || os.homedir(), name: "council2" });
      const full = store.getSession(sess.id);
      full.messages.push({ id: store.uid(), role: "assistant", text: answer || "the answer", ts: store.nowISO() });
      await claude.reviewAfter(full, reviewers || [], prompt || "");
      return { messages: full.messages.filter((m) => m.role === "reviewer").map((m) => ({ provider: m.reviewProvider, model: m.reviewModel, kind: m.reviewKind, text: m.text })) };
    });
    // Gemini primary — drive the REAL GeminiClient over a scripted in-process ACP
    // agent (no live CLI). Exercises JSON-RPC framing, streaming, tool cards,
    // the permission round-trip, and client-side fs writes.
    handle("test:last-run-payload", async () => global.__lastRunPayload || null);
    handle("test:clear-last-run-payload", async () => { global.__lastRunPayload = null; return true; });
    // Pin/unpin a fake live runner so claude.isRunning(id) reports a busy session —
    // lets tests exercise the queue-dispatch readiness gate without a real SDK turn.
    handle("test:fake-running", async (_e, id, on) => {
      if (on) claude.runners.set(id, { running: true, fake: true });
      else { const r = claude.runners.get(id); if (r && r.fake) claude.runners.delete(id); }
      return claude.isRunning(id);
    });
    handle("test:new-pick-window", async () => { createWindow(null, { pick: true }); return true; });
    handle("test:settings-scope", async () => {
      const A = "/tmp/projA", B = "/tmp/projB";
      store.saveSettings({ llmProvider: "google", defaultModel: "gemini-3.1-pro-preview", theme: "blue" }, A);
      store.saveSettings({ llmProvider: "openai", defaultModel: "gpt-5.5", theme: "rose", apiKey: "sk-secret-xyz" }, B);
      const a = store.getSettings(A), b = store.getSettings(B), g = store.getSettings();
      return { aProvider: a.llmProvider, aModel: a.defaultModel, aTheme: a.theme, bProvider: b.llmProvider, bModel: b.defaultModel, bTheme: b.theme, globalApiKey: g.apiKey, aSeesGlobalKey: a.apiKey, aHasProvider: "llmProvider" in (store.getSettings().projectSettings || {}) };
    });
    handle("test:imagegen-fake", async (_e, fail, vector) => {
      const ig = require("./imagegen");
      if (vector) {
        ig.setBackend(null);
        ig.setTextRunner(async () => fail ? { ok: false, error: "the model's CLI isn't authorized" } : { ok: true, text: 'Sure: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a1a1a"/><circle cx="32" cy="28" r="14" fill="#f0a94e"/></svg> there you go.' });
      } else {
        ig.setBackend(async ({ prompt }) => { if (fail) throw new Error("Add an OpenAI API key (with image access) in Settings → Providers."); return [{ data: "R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", mediaType: "image/gif" }]; });
      }
      return true;
    });
    handle("test:openai-run", async (_e, cwd, text) => {
      require("./council").setRunner(async (provider, model, prompt, opts) => ({ ok: true, text: `[${provider}/${model}] effort=${opts && opts.effort} :: ${/extend/.test(prompt) ? "extended" : "answered"}` }));
      store.saveSettings({ llmProvider: "openai", defaultModel: "gpt-5.5", defaultThinking: "high" });
      const sess = store.createSession({ cwd: cwd || os.homedir(), name: "openai" });
      await claude.run(sess.id, { text: text || "extend to 120 words", model: "gpt-5.5", thinking: "high" });
      const full = store.getSession(sess.id);
      return { msgs: full.messages.map((m) => ({ role: m.role, text: (m.text || "").slice(0, 90), provider: m.meta && m.meta.provider })), lastRun: claude._lastRun && claude._lastRun.sent };
    });
    handle("test:discover-fake", async (_e, provider) => {
      require("./providers").setModelFetcher(async (prov) => prov === "openai" ? [{ id: "gpt-6-turbo", name: "GPT-6 Turbo" }, { id: "gpt-5.5", name: "GPT-5.5" }] : prov === "google" ? [{ id: "gemini-4.0-pro", name: "Gemini 4.0 Pro", ctx1m: true }] : []);
      return require("./providers").discover(provider, { keys: { openai: "k", google: "k" } });
    });
    // (Gemini / Antigravity and local-optimizer test handlers were removed with those integrations.)
    handle("test:userdata-export", async (_e, p) => {
      const b = buildUserdataBundle();
      fs.writeFileSync(p, b.buf);
      const unz = zipper.unzip(b.buf);
      const names = unz.map((f) => f.name.replace(/\\/g, "/"));
      const pe = unz.find((f) => /preferences\.json$/.test(f.name));
      const prefs = pe ? JSON.parse(pe.data.toString("utf8")) : {};
      return { sessions: b.sessions, skills: b.skills, names, prefKeys: Object.keys(prefs), hasSecret: prefs.apiKey !== undefined, hasSubAgents: prefs.subAgents !== undefined };
    });
    handle("test:userdata-import", async (_e, p) => applyUserdataBundle(fs.readFileSync(p)));
    handle("test:ast", async (_e, kind, source) => {
      const ast = require("./ast");
      if (kind === "available") return ast.available();
      if (kind === "classify") return ast.classify(source, "probe.tsx");
      if (kind === "assertions") return ast.assertions(source, "probe.ts");
      if (kind === "mutate") return ast.mutate(source, 8);
      if (kind === "imports") return ast.imports(source, "probe.ts");
      return null;
    });
    // Drive the goal→green orchestrator deterministically with a scripted "agent".
    handle("test:director-scenario", async (_e, cwd, scenario) => {
      const fsx = require("fs"), p = require("path");
      const td = require("./testdir");
      const calc = p.join(cwd, "calc.js"), test = p.join(cwd, "calc.test.js");
      require("./director").setAgentRunner(async (ctx) => {
        if (ctx.role === "tester") {
          // "weak" → a test with no real assertion; others → a real assertion on add()
          const body = scenario === "weak"
            ? "process.exit(0)\n"
            : "const c=require('./calc'); if(c.add(2,3)!==5){console.error('add wrong');process.exit(1)} process.exit(0)\n";
          fsx.writeFileSync(test, body);
          const up = td.upsert(cwd, { title: "add works", adapter: "node", category: "regression", file: "calc.test.js", coveredFiles: [cwd + "/calc.js"], bulletIds: scenario === "ambiguous" ? [] : (ctx.spec || []).map((b) => b.id) });
          if (up.ok) td.attachTest(cwd, ctx.goalId, up.test.id);
        } else if (ctx.role === "builder") {
          fsx.writeFileSync(calc, scenario === "weak" ? "exports.add=(a,b)=>a + b;\n" : "exports.add=(a,b)=>a + b + 1;\n");
        } else if (ctx.role === "fixer") {
          if (scenario !== "exhausted") fsx.writeFileSync(calc, "exports.add=(a,b)=>a + b;\n");
        }
      });
      return true;
    });
  }
  // ---- Prettier formatting for non-TS languages (JSON/CSS/HTML/Markdown/YAML…) ----
  handle("prettier:langs", async () => Object.keys(PRETTIER_PARSER));
  handle("prettier:format", async (_e, text, lang, tabSize) => {
    const parser = PRETTIER_PARSER[(lang || "").toLowerCase()];
    if (!parser) return null;
    try { return await prettierMod().format(text || "", { parser, tabWidth: tabSize || 2, endOfLine: "lf" }); } catch { return null; }
  });
  handle("git:merge-abort", gitOp("Abort", (cwd) => git.mergeAbort(cwd)));
  handle("git:merge-continue", gitOp("Continue", (cwd) => git.mergeContinue(cwd)));
  handle("git:discard", gitOp("Discard", (cwd, files2) => git.discard(cwd, files2)));
  handle("git:changed-between", async (_e, cwd, from, to) => git.changedBetween(cwd, from, to));
  handle("git:commits-between", async (_e, cwd, from, to, opts) => git.commitsBetween(cwd, from, to, opts || {}));
  handle("git:ref-diff", async (_e, cwd, from, to, file) => git.refDiff(cwd, from, to, file));
  handle("git:remote-url", async (_e, cwd, name) => git.remoteUrl(cwd, name));
  // ---- Git Center ----
  handle("git:repo-state", async (_e, cwd) => git.repoState(cwd));
  handle("git:rebase-skip", gitOp("Skip", (cwd) => git.rebaseSkip(cwd)));
  handle("git:bisect-reset", gitOp("Bisect reset", (cwd) => git.bisectReset(cwd)));
  handle("git:fetch", gitOp("Fetch", (cwd, opts) => git.fetch(cwd, opts || {})));
  handle("git:push-branch", gitOp("Push", (cwd, opts) => git.pushBranch(cwd, opts || {})));
  handle("git:pull-opts", gitOp("Pull", (cwd, opts) => git.pull(cwd, opts || {})));
  handle("git:log", async (_e, cwd, opts) => git.log(cwd, opts || {}));
  handle("git:commit-info", async (_e, cwd, hash, opts) => git.commitInfo(cwd, hash, opts || {}));
  handle("git:commit-file-diff", async (_e, cwd, hash, file, opts) => git.commitFileDiff(cwd, hash, file, opts || {}));
  handle("git:file-at", async (_e, cwd, ref, file, opts) => git.fileAt(cwd, ref, file, opts || {}));
  handle("git:ahead-behind", async (_e, cwd, a, b) => git.aheadBehind(cwd, a, b));
  handle("git:resolve-refs", async (_e, cwd, names) => git.resolveRefs(cwd, names || []));
  handle("git:branches-detailed", async (_e, cwd) => git.branchesDetailed(cwd));
  handle("git:branch-create", gitOp("Create branch", (cwd, name, opts) => git.branchCreate(cwd, name, opts || {})));
  handle("git:branch-delete", gitOp("Delete branch", (cwd, name, opts) => git.branchDelete(cwd, name, opts || {})));
  handle("git:branch-rename", gitOp("Rename branch", (cwd, oldName, newName) => git.branchRename(cwd, oldName, newName)));
  handle("git:set-upstream", gitOp("Set upstream", (cwd, branch, upstream) => git.setUpstream(cwd, branch, upstream)));
  handle("git:checkout-remote", gitOp("Checkout", (cwd, remoteBranch, opts) => git.checkoutRemote(cwd, remoteBranch, opts || {})));
  handle("git:rebase", gitOp("Rebase", (cwd, onto, opts) => git.rebase(cwd, onto, opts || {})));
  handle("git:cherry-pick", gitOp("Cherry-pick", (cwd, hashes, opts) => git.cherryPick(cwd, hashes, opts || {})));
  handle("git:revert", gitOp("Revert", (cwd, hash, opts) => git.revert(cwd, hash, opts || {})));
  handle("git:reset", gitOp("Reset", (cwd, ref, mode, opts) => git.reset(cwd, ref, mode, opts || {})));
  handle("git:stash-list", async (_e, cwd) => git.stashList(cwd));
  handle("git:stash-save", gitOp("Stash", (cwd, opts) => git.stashSave(cwd, opts || {})));
  handle("git:stash-apply", gitOp("Apply stash", (cwd, sel, opts) => git.stashApply(cwd, sel, opts || {})));
  handle("git:stash-drop", gitOp("Drop stash", (cwd, sel) => git.stashDrop(cwd, sel)));
  handle("git:stash-show", async (_e, cwd, sel) => git.stashShow(cwd, sel));
  handle("git:stash-file-diff", async (_e, cwd, sel, file) => git.stashFileDiff(cwd, sel, file));
  handle("git:tags", async (_e, cwd) => git.tags(cwd));
  handle("git:tag-create", gitOp("Create tag", (cwd, name, opts) => git.tagCreate(cwd, name, opts || {})));
  handle("git:tag-delete", gitOp("Delete tag", (cwd, name, opts) => git.tagDelete(cwd, name, opts || {})));
  handle("git:push-tag", gitOp("Push tag", (cwd, name, opts) => git.pushTag(cwd, name, opts || {})));
  handle("git:remotes", async (_e, cwd) => git.remotes(cwd));
  handle("git:remote-add", gitOp("Add remote", (cwd, name, url) => git.remoteAdd(cwd, name, url)));
  handle("git:remote-remove", gitOp("Remove remote", (cwd, name) => git.remoteRemove(cwd, name)));
  handle("git:remote-set-url", gitOp("Set remote URL", (cwd, name, url, opts) => git.remoteSetUrl(cwd, name, url, opts || {})));
  // ---- Git Center v2: unversion, pull-from-branch, snapshots, whole-file conflict resolution ----
  handle("git:untrack", gitOp("Unversion", (cwd, files2) => git.untrack(cwd, files2)));
  handle("git:pull-from", gitOp("Pull", (cwd, opts) => git.pullFrom(cwd, opts || {})));
  handle("git:conflict-stages", async (_e, cwd, file) => git.conflictStages(cwd, file));
  handle("git:resolve-with", gitOp("Resolve", (cwd, files2, side) => git.resolveWith(cwd, files2, side)));
  handle("git:archive-zip", async (e, cwd, ref, suggested) => {
    const res = await dialog.showSaveDialog(winFrom(e), { title: "Save repository snapshot", defaultPath: suggested || "snapshot.zip", filters: [{ name: "ZIP archive", extensions: ["zip"] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    return git.runInOperation({ label: "Archive", cwd }, () => git.archiveZip(cwd, ref, res.filePath));
  });
  handle("git:commit-zip", async (e, cwd, hash, suggested, opts) => {
    const res = await dialog.showSaveDialog(winFrom(e), { title: "Save the files changed in this commit", defaultPath: suggested || "changed-files.zip", filters: [{ name: "ZIP archive", extensions: ["zip"] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    return git.runInOperation({ label: "Export commit", cwd }, () => git.commitZip(cwd, hash, res.filePath, opts || {}));
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
  // Provider-aware: resolve the live model list + reasoning controls (thinking
  // levels vs reasoning effort) + 1M-context flags for the chosen provider.
  handle("models:discover", async (_e, provider, opts) => {
    const s = store.getSettings();
    const p = provider || s.llmProvider || "anthropic";
    return require("./providers").discover(p, { claudeRef: claude, customModels: s.customModels, customEndpoints: s.customEndpoints, keys: { openai: s.openaiApiKey, google: s.geminiApiKey, anthropic: s.apiKey }, force: !!(opts && opts.force) });
  });
  handle("providers:catalog", async () => require("./providers").catalog());
  // Codex re-listed its models (after an update, login switch, or server-side
  // change) → every window re-applies the OpenAI list (with the new-models toast).
  require("./providers").onCodexModelsChange(() => broadcast("models:update", { provider: "openai" }));

  // Image generation — prompt → image(s), added to the conversation as a viewable
  // + downloadable message. Provider auto-picked from available keys unless given.
  require("./imagegen").setTextRunner((p, m, prompt, o) => require("./council").reviewerRun(p, m, prompt, o));
  handle("image:generate", async (e, sessionId, prompt, opts) => {
    opts = opts || {};
    const sess0 = store.getSession(sessionId);
    const s = store.getSettings((sess0 && sess0.cwd) || projectOf(winFrom(e)));
    const sess = sess0;
    if (!sess) return { ok: false, error: "no session" };
    const primary = s.llmProvider || "anthropic";
    const rasterKey = s.openaiApiKey ? "openai" : s.geminiApiKey ? "google" : null;
    // Default = VECTOR (SVG) via the primary CLI — no API key needed. PHOTO
    // (raster) only when explicitly asked AND an image API key exists.
    const mode = opts.mode || (opts.photo && rasterKey ? "photo" : "vector");
    const provider = mode === "photo" ? (rasterKey || "openai") : primary;
    // Claim the runner slot BEFORE we mutate the session — otherwise a concurrent
    // claude.run() would silently steal the slot and image gen leaks a dangling
    // user message + status event onto a session that has its own real run.
    const ctl = claude.registerExternalRunner(sessionId, { label: "image: " + prompt.slice(0, 60) });
    if (!ctl) return { ok: false, error: "This tab is already running — wait for it to finish." };
    claude.addMessage(sess, { id: store.uid(), role: "user", text: prompt, attachments: [], ts: store.nowISO() });
    store.updateSession(sessionId, { status: "running" }); claude.send("session:status", { sessionId, status: "running" });
    try {
      const imgs = await require("./imagegen").generate({ mode, provider, model: s.defaultModel, effort: s.defaultThinking, prompt, size: opts.size, n: opts.n, keys: { openai: s.openaiApiKey, google: s.geminiApiKey }, signal: ctl.signal });
      if (ctl.isAborted()) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (!imgs.length) throw new Error("no image returned");
      const images = imgs.map((im, i) => ({ kind: "image", data: im.data, mediaType: im.mediaType || "image/png", name: `generated-${i + 1}.${(im.mediaType || "").includes("svg") ? "svg" : "png"}` }));
      claude.addMessage(sess, { id: store.uid(), role: "image", prompt, provider, mode, images, ts: store.nowISO() });
      store.updateSession(sessionId, { status: "done" }); claude.send("session:status", { sessionId, status: "done" });
      return { ok: true, count: images.length, provider, mode };
    } catch (err) {
      if ((err && err.name === "AbortError") || ctl.isAborted()) {
        claude.addMessage(sess, { id: store.uid(), role: "system", text: "Image generation stopped.", ts: store.nowISO() });
        store.updateSession(sessionId, { status: "idle" }); claude.send("session:status", { sessionId, status: "idle" });
        return { ok: false, error: "stopped" };
      }
      claude.addMessage(sess, { id: store.uid(), role: "error", text: "Image generation failed — " + String((err && err.message) || err), ts: store.nowISO() });
      store.updateSession(sessionId, { status: "error" }); claude.send("session:status", { sessionId, status: "error" });
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      ctl.unregister();
    }
  });

  // (The Optimise/Distill pre-mind and the embedded local optimizer were removed —
  //  the request is sent exactly as written; no local rewriting layer exists.)

  // MCP server bridge — manages the user's MCP server config file.
  const mcpConfig = require("./mcpConfig");
  handle("mcp:list", async () => mcpConfig.list());
  handle("mcp:upsert", async (_e, name, patch) => mcpConfig.upsert(name, patch || {}));
  handle("mcp:remove", async (_e, name) => mcpConfig.remove(name));
  handle("mcp:rename", async (_e, oldName, newName) => mcpConfig.rename(oldName, newName));
  handle("mcp:open-file", async () => { await shell.openPath(mcpConfig.configFile()); return true; });

  // Skills-export-to-Antigravity handler was removed along with the agy CLI integration.

  handle("shell:open-external", async (_e, url) => { await shell.openExternal(url); return true; });

  // ---- atomnano CLI: enable = `npm link` so `atomnano` is on PATH globally ----
  const runNpm = (args, cwd, timeoutMs = 120000) => new Promise((resolve) => {
    const isWin = process.platform === "win32";
    let child;
    try { child = spawn(isWin ? "npm.cmd" : "npm", args, { cwd, windowsHide: true, shell: isWin }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    let out = "", er = "";
    const t = setTimeout(() => { try { child.kill(); } catch { /* */ } resolve({ ok: false, error: "npm timed out" }); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { er += d; });
    child.on("error", (e) => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ ok: code === 0, code, out, err: er }); });
  });
  const cliWhich = () => new Promise((resolve) => {
    const isWin = process.platform === "win32";
    let child;
    try { child = spawn(isWin ? "where" : "which", ["atomnano"], { windowsHide: true }); }
    catch { return resolve(""); }
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve((out.trim().split(/\r?\n/)[0] || "").trim()));
  });
  const cliStatus = async () => {
    const p = await cliWhich();
    return { linked: !!p, path: p, appRoot: app.getAppPath(), packaged: app.isPackaged, platform: process.platform };
  };
  handle("cli:status", async () => cliStatus());
  handle("cli:enable", async () => {
    if (app.isPackaged) return { ok: false, detail: "In the installed app, add the app folder's bin to PATH manually. Auto-link works when running from source.", status: await cliStatus() };
    const r = await runNpm(["link"], app.getAppPath());
    store.saveSettings({ cliEnabled: !!r.ok });
    return { ok: r.ok, detail: r.ok ? "" : String(r.err || r.error || "npm link failed").slice(-500), status: await cliStatus() };
  });
  handle("cli:disable", async () => {
    const r = await runNpm(["rm", "-g", "atomnano"], app.getAppPath());
    store.saveSettings({ cliEnabled: false });
    return { ok: true, detail: r.ok ? "" : String(r.err || r.error || "").slice(-300), status: await cliStatus() };
  });
}
