"use strict";
/* CLI detection + login status + launching an interactive login terminal. */
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require("./store");
const profiles = require("./profiles");
const platform = require("./platform");

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, shell: false }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || "").toString(), stderr: (stderr || "").toString() });
    });
  });
}

// Locate the Claude CLI. The NATIVE install (~/.local/bin/claude[.exe]) wins over anything
// `where`/`which` finds: machines that once did `npm i -g @anthropic-ai/claude-code` keep a stale
// npm shim on PATH (AppData\Roaming\npm\claude[.cmd], /usr/local/bin/claude) that shadows the
// self-updating native binary — probing/updating THAT copy is why "update" appeared to do
// nothing and new models never showed up. On Windows extensionless shims are not executable via
// execFile, so prefer .exe, then .cmd; on macOS/Linux any PATH hit is a real executable.
async function whereClaude() {
  const settings = store.getSettings();
  if (settings.claudePath && fs.existsSync(settings.claudePath)) return settings.claudePath;
  const [native, ...guesses] = platform.claudeCandidates();
  if (fs.existsSync(native)) return native;
  const r = await run(platform.whichCommand(), ["claude"]);
  if (!r.err && r.stdout.trim()) {
    const lines = r.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const pick = platform.isWin() ? (lines.find((l) => /\.exe$/i.test(l)) || lines.find((l) => /\.cmd$/i.test(l)) || "") : (lines[0] || "");
    if (pick) return pick;
  }
  for (const g of guesses) if (fs.existsSync(g)) return g;
  return "";
}
// Installed CLI version ("2.1.263") or "" when absent/unreadable.
async function cliVersion(cliPath) {
  const p = cliPath || await whereClaude();
  if (!p) return "";
  const r = await run(p, ["--version"]);
  return r.err ? "" : ((r.stdout.match(/\d+\.\d+\.\d+/) || [""])[0]);
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

// The OS-level Claude login (~/.claude), independent of the app's own
// CLAUDE_CONFIG_DIR home. This is where `claude login` lands when the user runs
// it in their OWN terminal (CLAUDE_CONFIG_DIR unset there).
function osCredentialsPath() {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

// Pull the OS-level terminal login into the app home when it's the real current
// login — i.e. the app home has no credentials, or the OS ones are newer (the
// user just ran `claude login` in their own terminal). This imports that login
// into the app so it becomes active AND visible to "Save current login". No-op
// in the common case where the app home already holds the freshest credentials,
// or where CLAUDE_CONFIG_DIR already points at ~/.claude. Returns true if it
// copied anything.
function syncFromOsLogin() {
  try {
    const osCred = osCredentialsPath();
    if (!fs.existsSync(osCred)) return false;
    const appCred = path.join(claudeConfigDir(), ".credentials.json");
    if (path.resolve(osCred) === path.resolve(appCred)) return false; // OS home IS the app home
    let appMtime = -1;
    try { if (fs.existsSync(appCred)) appMtime = fs.statSync(appCred).mtimeMs; } catch { /* treat as missing */ }
    const osMtime = fs.statSync(osCred).mtimeMs;
    if (appMtime >= 0 && osMtime <= appMtime) return false; // app login is at least as fresh — keep it
    // A newer OS login that is a DIFFERENT account must not clobber the account the
    // user chose in the app (they may be using the terminal for another account).
    // Only a same-account refresh (rotated tokens) — or an empty app home — imports.
    if (appMtime >= 0) {
      try {
        const P = require("./profiles");
        const a = P.identityOf(P.PROVIDERS.anthropic, JSON.parse(fs.readFileSync(appCred, "utf8")), "");
        const o = P.identityOf(P.PROVIDERS.anthropic, JSON.parse(fs.readFileSync(osCred, "utf8")), "");
        const comparable = (a.email && o.email) || (a.id && o.id);
        if (comparable && !P.sameAccount(a, o)) return false;
      } catch { /* unreadable — fall through to the copy */ }
    }
    // Never clobber an account the user deliberately switched to in the app with a
    // DIFFERENT account from the terminal — only pull in the same account's newer
    // tokens (or a first login when the app has none).
    if (appMtime >= 0) {
      const p = profiles.PROVIDERS.anthropic;
      const a = p.identity(JSON.parse(fs.readFileSync(appCred, "utf8"))), b = p.identity(JSON.parse(fs.readFileSync(osCred, "utf8")));
      if (profiles.conflict(a, b)) return false;
    }
    fs.mkdirSync(claudeConfigDir(), { recursive: true });
    fs.copyFileSync(osCred, appCred);
    return true;
  } catch { return false; }
}

function credentialsInfo() {
  const credPath = path.join(claudeConfigDir(), ".credentials.json");
  const exists = fs.existsSync(credPath);
  let detail = "";
  if (exists) {
    try {
      const j = JSON.parse(fs.readFileSync(credPath, "utf8"));
      const oauth = j.claudeAiOauth || j.oauth || {};
      if (oauth.subscriptionType) detail = String(oauth.subscriptionType);
      else if (oauth.expiresAt) detail = "OAuth token present";
    } catch { detail = "present"; }
  }
  return { credPath, exists, detail };
}

async function status() {
  const settings = store.getSettings();
  const cliPath = await whereClaude();
  let version = "";
  if (cliPath) {
    const r = await run(cliPath, ["--version"]);
    if (!r.err) version = (r.stdout.match(/\d+\.\d+\.\d+/) || [r.stdout.trim()])[0]; // just the number
  }
  const cred = credentialsInfo();
  const envKey = !!process.env.ANTHROPIC_API_KEY;

  // Effective method, matching claude.js buildEnv() precedence.
  let authMethod = "none";
  if (settings.apiKey) authMethod = "API key (AtomNano settings)";
  else if (settings.useEnvApiKey && envKey) authMethod = "API key (environment)";
  else if (cred.exists) authMethod = `Claude CLI login (${cred.detail || "OAuth"})`;

  return {
    cliFound: !!cliPath,
    cliPath,
    version,
    loggedIn: authMethod !== "none",
    authMethod,
    envKeyPresent: envKey,
    credPath: cred.credPath,
  };
}

async function openLoginTerminal() {
  const cliPath = await whereClaude();
  const bin = cliPath ? `"${cliPath}"` : "claude";
  // The login runs in the USER's terminal (Windows Terminal / cmd, macOS Terminal.app, the desktop's
  // terminal on Linux) so the browser OAuth flow and its prompts behave exactly as in a shell.
  platform.openTerminal({ command: `${bin} login`, title: "AtomNano - Claude Login" });
  return { ok: true };
}

/* ---- updates ---- */
function appRoot() { return path.join(__dirname, "..", ".."); }
// Read an installed package's version from DISK every time. `require()` would
// cache the first package.json for the process lifetime, so after an in-app (or
// manual) `npm i …@latest` the Settings page kept showing the OLD version and
// "update available" — even though the update had actually succeeded.
function installedVersion(...segs) {
  try { return JSON.parse(fs.readFileSync(path.join(appRoot(), "node_modules", ...segs, "package.json"), "utf8")).version || ""; }
  catch { return ""; }
}
function sdkVersion() { return installedVersion("@anthropic-ai", "claude-agent-sdk"); }
function codexSdkVersion() { return installedVersion("@openai", "codex-sdk"); }
// Latest published version, memoised for 10 minutes (each `npm view` is a 1-3 s
// network round-trip; Settings asks for several at once). `fresh` bypasses the cache.
const LATEST_TTL_MS = 10 * 60 * 1000;
const latestCache = new Map();   // pkg -> { at, version }
function npmLatest(pkg, { fresh } = {}) {
  const hit = latestCache.get(pkg);
  if (!fresh && hit && hit.version && Date.now() - hit.at < LATEST_TTL_MS) return Promise.resolve(hit.version);
  return new Promise((resolve) => {
    const c = platform.shellCommand(`npm view ${pkg} version`);
    execFile(c.file, c.args, { timeout: 25000, windowsHide: true }, (err, out) => {
      const v = err ? "" : ((String(out).trim().split(/\r?\n/).pop() || "").trim().match(/\d+\.\d+\.\d+[\w.-]*/) || [""])[0];
      if (v) latestCache.set(pkg, { at: Date.now(), version: v });
      resolve(v || (hit && hit.version) || "");
    });
  });
}
function cmpVer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
async function checkUpdates({ fresh } = {}) {
  const cliPath = await whereClaude();
  const cliCurrent = await cliVersion(cliPath);
  const sdkCurrent = sdkVersion();
  const [cliLatest, sdkLatest] = await Promise.all([npmLatest("@anthropic-ai/claude-code", { fresh }), npmLatest("@anthropic-ai/claude-agent-sdk", { fresh })]);
  const cliUpdate = !!(cliCurrent && cliLatest && cmpVer(cliLatest, cliCurrent) > 0);
  const sdkUpdate = !!(sdkCurrent && sdkLatest && cmpVer(sdkLatest, sdkCurrent) > 0);
  return {
    cli: { current: cliCurrent, latest: cliLatest, updateAvailable: cliUpdate },
    sdk: { current: sdkCurrent, latest: sdkLatest, updateAvailable: sdkUpdate },
    updateAvailable: cliUpdate || sdkUpdate,
  };
}
// Run a program with no shell (so paths with spaces work) and capture output.
function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 180000, windowsHide: true, cwd: opts.cwd, shell: false, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || "").toString(), stderr: (stderr || "").toString(), error: err ? (err.message || String(err)) : "" });
    });
  });
}
function isNpmInstall(cliPath) {
  const p = (cliPath || "").toLowerCase().replace(/\\/g, "/");
  return p.includes("/node_modules/") || p.includes("/npm/") || p.includes("appdata/roaming/npm");
}
function firstLine(s, n = 240) { return String(s || "").split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, n) || ""; }
// "0.3.252 → 0.3.257" | "already up to date (0.3.257)" | "updated"
function versionDelta(before, after) {
  if (before && after && before !== after) return `${before} → ${after}`;
  if (after) return `already up to date (${after})`;
  return "updated";
}
// Install a package into the APP directory. --ignore-scripts skips our own
// postinstall (the node-pty Electron rebuild — minutes long, needs a C++
// toolchain, and irrelevant to an SDK bump); neither SDK ships install scripts.
function npmLocal(pkg) {
  const c = platform.cliCommand("npm", ["i", `${pkg}@latest`, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"]);
  return runCapture(c.file, c.args, { cwd: appRoot(), timeout: 300000 });
}
function npmGlobal(pkg) {
  const c = platform.cliCommand("npm", ["i", "-g", `${pkg}@latest`, "--no-audit", "--no-fund", "--loglevel=error"]);
  return runCapture(c.file, c.args, { timeout: 300000 });
}
// A running binary can't be overwritten (Windows) / a global prefix may need permissions — surface that as a clear hint.
function cliFailHint(r) {
  const s = (r.stderr || "") + (r.stdout || "") + (r.error || "");
  if (/EBUSY|being used by another process|access is denied/i.test(s)) return "binary in use — stop running sessions / close other Claude terminals, then retry";
  if (/EACCES|EPERM/i.test(s)) return platform.isWin() ? "binary in use — stop running sessions / close other Claude terminals, then retry" : "permission denied — the install location needs write access (e.g. fix the npm global prefix), then retry";
  return firstLine(r.stderr) || firstLine(r.stdout) || r.error || "update failed";
}

// Update the Claude CLI in place. Native installs self-update via `claude update`
// (which ALSO reports a leftover npm-global copy — we pass that warning through
// so the user can remove the shadowing install). npm installs update via npm -g.
// We deliberately no longer fall back from native → npm -g: that created a second
// installation that shadowed the native one on PATH and broke discovery.
async function updateClaudeCli(log) {
  const cliPath = await whereClaude();
  const before = await cliVersion(cliPath);
  log(`Updating Claude CLI${before ? ` (installed ${before})` : ""}…`);
  const native = !!cliPath && !isNpmInstall(cliPath);
  const r = native ? await runCapture(cliPath, ["update"], { timeout: 300000 }) : await npmGlobal("@anthropic-ai/claude-code");
  const after = r.ok ? await cliVersion(cliPath) : before;
  const leftover = /Leftover npm global installation/i.test(r.stdout || "");
  if (leftover) log("⚠ A leftover npm-global Claude install shadows the native one — run: npm -g uninstall @anthropic-ai/claude-code");
  return { ok: r.ok, before, after, detail: r.ok ? versionDelta(before, after) : cliFailHint(r), leftoverNpm: leftover };
}
async function updateLocalSdk(pkg, segs, log, label) {
  const before = installedVersion(...segs);
  log(`Updating ${label}${before ? ` (installed ${before})` : ""}…`);
  const r = await npmLocal(pkg);
  const after = installedVersion(...segs);
  // npm can exit non-zero (e.g. peer warnings, EBUSY on an unrelated file) while
  // still having written the new package — trust the version on disk.
  const ok = r.ok || (!!after && !!before && cmpVer(after, before) > 0);
  return { ok, before, after, detail: ok ? versionDelta(before, after) : (firstLine(r.stderr) || r.error || "update failed") };
}

// Seamless, in-process update of the Claude CLI and the bundled Agent SDK.
// onProgress(message) streams status lines to the UI. Returns a structured
// result; never throws.
async function updateAll(onProgress) {
  const log = (m) => { try { onProgress && onProgress(m); } catch { /* ignore */ } };
  const result = { cli: { ok: false, detail: "" }, sdk: { ok: false, detail: "" } };

  result.cli = await updateClaudeCli(log);
  log(result.cli.ok ? `✓ Claude CLI: ${result.cli.detail} (new models ship with it).` : `✗ Claude CLI update failed: ${result.cli.detail}`);

  result.sdk = await updateLocalSdk("@anthropic-ai/claude-agent-sdk", ["@anthropic-ai", "claude-agent-sdk"], log, "Agent SDK");
  log(result.sdk.ok ? `✓ Agent SDK: ${result.sdk.detail}.` : `✗ Agent SDK update failed: ${result.sdk.detail} (use the portable build or run as admin).`);

  result.ok = result.cli.ok || result.sdk.ok;
  result.changed = (result.cli.before && result.cli.after && result.cli.before !== result.cli.after) || (result.sdk.before && result.sdk.after && result.sdk.before !== result.sdk.after);
  log("Done.");
  return result;
}

/* ---- multi-tool versions + per-item update + per-provider authorize ---- */
function cmdVersion(bin) {
  return new Promise((resolve) => {
    const c = platform.shellCommand(`${bin} --version`);
    execFile(c.file, c.args, { timeout: 10000, windowsHide: true }, (err, out, errout) => {
      const s = ((out || "") + (errout || "")).toString();
      resolve({ present: !err && !!s.trim(), version: (s.match(/\d+\.\d+\.\d+/) || [""])[0] });
    });
  });
}
const TOOL_PKGS = { claudeCli: "@anthropic-ai/claude-code", agentSdk: "@anthropic-ai/claude-agent-sdk", codex: "@openai/codex", codexSdk: "@openai/codex-sdk" };
// Installed versions only — fast (no network), so Settings can render at once.
async function toolVersions() {
  const cliPath = await whereClaude();
  const cliVer = await cliVersion(cliPath);
  // Antigravity (agy) integration was removed — only Claude CLI + Codex are tracked.
  const codex = await cmdVersion("codex");
  return {
    claudeCli: { name: "Claude CLI", pkg: TOOL_PKGS.claudeCli, present: !!cliPath, version: cliVer },
    agentSdk: { name: "Agent SDK", pkg: TOOL_PKGS.agentSdk, present: !!sdkVersion(), version: sdkVersion() },
    codex: { name: "Codex CLI", pkg: TOOL_PKGS.codex, present: codex.present, version: codex.version },
    codexSdk: { name: "Codex SDK", pkg: TOOL_PKGS.codexSdk, present: !!codexSdkVersion(), version: codexSdkVersion() },
  };
}
// Latest published version per tool (memoised) + whether it beats the installed one.
async function toolLatest(installed, { fresh } = {}) {
  const keys = Object.keys(TOOL_PKGS);
  const latest = await Promise.all(keys.map((k) => npmLatest(TOOL_PKGS[k], { fresh })));
  const out = {};
  keys.forEach((k, i) => {
    const cur = installed && installed[k] ? installed[k].version : "";
    out[k] = { latest: latest[i], updateAvailable: !!(cur && latest[i] && cmpVer(latest[i], cur) > 0) };
  });
  return out;
}
async function updateTool(tool, onProgress) {
  const log = (m) => { try { onProgress && onProgress(m); } catch { /* ignore */ } };
  if (tool === "claudeCli") return updateClaudeCli(log);
  if (tool === "agentSdk") return updateLocalSdk("@anthropic-ai/claude-agent-sdk", ["@anthropic-ai", "claude-agent-sdk"], log, "Agent SDK");
  if (tool === "codexSdk") return updateLocalSdk("@openai/codex-sdk", ["@openai", "codex-sdk"], log, "Codex SDK");
  if (tool === "codex") {
    const before = (await cmdVersion("codex")).version;
    log(`Updating Codex CLI${before ? ` (installed ${before})` : ""}…`);
    const r = await npmGlobal("@openai/codex");
    const after = r.ok ? (await cmdVersion("codex")).version : before;
    return { ok: r.ok, before, after, detail: r.ok ? versionDelta(before, after) : (firstLine(r.stderr) || r.error || "failed") };
  }
  if (tool === "agy") return { ok: false, detail: "Antigravity (agy) integration was removed from this build." };
  return { ok: false, detail: "unknown tool" };
}
function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }
function providerAuthStatus() {
  const s = store.getSettings();
  const home = os.homedir();
  return {
    anthropic: { key: !!s.apiKey, loggedIn: credentialsInfo().exists, canAuthorize: true },
    // Codex home resolved centrally (profiles.codexHome honours CODEX_HOME).
    openai: { key: !!s.openaiApiKey, loggedIn: fileExists(profiles.PROVIDERS.openai.authPath()), canAuthorize: true },
    google: { key: !!s.geminiApiKey, loggedIn: fileExists(path.join(home, ".gemini", "oauth_creds.json")) || fileExists(path.join(home, ".gemini", "google_accounts.json")), canAuthorize: true },
    custom: { key: !!s.customApiKey, baseUrl: s.customApiBaseUrl || "", canAuthorize: false },
  };
}
// Open an interactive login terminal for the provider (browser OAuth via its CLI).
function authorizeProvider(provider) {
  let cmd = null, title = "AtomNano Login";
  if (provider === "anthropic") return openLoginTerminal();
  if (provider === "openai") { cmd = "codex login"; title = "AtomNano - OpenAI (Codex) Login"; }
  else if (provider === "google") {
    // Antigravity (agy) integration was removed. The Google provider entry is kept
    // for API-key configuration only; there is no CLI-driven OAuth flow.
    return { ok: false, detail: "Google CLI (Antigravity / agy) integration was removed. Use an API key in Settings if needed." };
  }
  if (!cmd) return { ok: false, detail: "This provider uses an API key — paste it above." };
  try { platform.openTerminal({ command: cmd, title }); } catch (e) { return { ok: false, detail: String(e.message || e) }; }
  return { ok: true };
}

/* ---- Credential profiles (Claude + Codex) ----
 * Implemented in profiles.js (rotation-proof mirroring, identity by account, a
 * watcher that keeps saved copies fresh and auto-saves new logins). These thin
 * wrappers keep the historical names; `provider` defaults to Anthropic. */
const PROV = (p) => (p === "openai" || p === "codex" ? "openai" : "anthropic");
function listProfiles(provider) { return profiles.list(PROV(provider)); }
function renameProfile(oldLabel, newLabel, provider) { return profiles.rename(PROV(provider), oldLabel, newLabel); }
function exportProfile(label, destPath, provider) { return profiles.exportTo(PROV(provider), label, destPath); }
function importProfile(srcPath, label, provider) { return profiles.importFrom(PROV(provider), srcPath, label); }
function saveCurrentAsProfile(label, provider) { return profiles.saveCurrent(PROV(provider), label); }
function switchProfile(label, provider) { return profiles.switchTo(PROV(provider), label); }
function deleteProfile(label, provider) { return profiles.remove(PROV(provider), label); }
function liveLogin(provider) { return profiles.liveInfo(PROV(provider)); }
// Claude's credential file carries no email; the OAuth profile API does. Resolve it
// (cached per access token) and hand it to reconcile as the identity hint, so a
// login is matched by ACCOUNT — a rotated token on the same account is mirrored,
// a different account logged in elsewhere is saved as its own profile.
const _emailByToken = new Map();
async function resolveClaudeEmail() {
  try {
    const live = JSON.parse(fs.readFileSync(profiles.PROVIDERS.anthropic.authPath(), "utf8"));
    const o = (live && (live.claudeAiOauth || live.oauth)) || {};
    if (o.email) return o.email;
    const tok = o.accessToken || "";
    if (!tok) return "";
    const hit = _emailByToken.get(tok);
    if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.email;
    const p = await oauthGet("/api/oauth/profile", tok);
    const email = (p && p.account && p.account.email) || "";
    _emailByToken.set(tok, { email, at: Date.now() });
    if (_emailByToken.size > 20) _emailByToken.delete(_emailByToken.keys().next().value);
    return email;
  } catch { return ""; }
}
async function reconcileLogin(provider) {
  const prov = PROV(provider);
  const hint = prov === "anthropic" ? { email: await resolveClaudeEmail() } : {};
  return profiles.reconcile(prov, hint);
}
// Intentional logout. For Claude a marker is left in the app home so neither the
// startup seed nor the terminal-login sync re-imports the OS-level login behind the
// user's back; the marker disappears as soon as a login exists again.
const LOGOUT_MARKER = ".atomnano-logged-out";
function logoutMarkerPath() { return path.join(claudeConfigDir(), LOGOUT_MARKER); }
function isIntentionallyLoggedOut() { return fileExists(logoutMarkerPath()) && !credentialsInfo().exists; }
async function logout(provider) {
  const prov = PROV(provider);
  try { await reconcileLogin(prov); } catch { /* best effort — logout() mirrors again without the hint */ }
  const r = profiles.logout(prov);
  if (r && r.ok && prov === "anthropic") { try { fs.mkdirSync(claudeConfigDir(), { recursive: true }); fs.writeFileSync(logoutMarkerPath(), new Date().toISOString()); } catch { /* */ } }
  return r;
}
function clearLogoutMarker() { try { if (fileExists(logoutMarkerPath())) fs.unlinkSync(logoutMarkerPath()); } catch { /* */ } }

// Fetch REAL Claude subscription usage + reset times from the OAuth usage API
// (the same endpoint Claude Code's /usage command uses). Returns null if not
// OAuth-signed-in or the request fails. Cached briefly to avoid hammering it.
let _usageCache = { at: 0, data: null };
function oauthToken() {
  try {
    const cred = credentialsInfo();
    if (!cred.exists) return "";
    const j = JSON.parse(fs.readFileSync(cred.credPath, "utf8"));
    return (j.claudeAiOauth || j.oauth || {}).accessToken || "";
  } catch { return ""; }
}
function oauthGet(apiPath, tokenOverride) {
  return new Promise((resolve) => {
    const tok = tokenOverride || oauthToken();
    if (!tok) return resolve(null);
    const https = require("https");
    const req = https.request({
      host: "api.anthropic.com", path: apiPath, method: "GET",
      headers: { "Authorization": "Bearer " + tok, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01", "User-Agent": "claude-cli" },
    }, (res) => {
      let d = ""; res.on("data", (c) => d += c);
      res.on("end", () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(d)); } catch { resolve(null); } } else resolve(null); });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(6000, () => { try { req.destroy(); } catch { /* */ } resolve(null); });
    req.end();
  });
}
async function fetchUsage(force) {
  const now = Date.now();
  if (!force && _usageCache.data && (now - _usageCache.at) < 30000) return _usageCache.data;
  const u = await oauthGet("/api/oauth/usage");
  if (!u) return _usageCache.data && (now - _usageCache.at) < 120000 ? _usageCache.data : null;
  const pick = (o) => o ? { utilization: o.utilization, resetsAt: o.resets_at } : null;
  const data = {
    fiveHour: pick(u.five_hour),
    sevenDay: pick(u.seven_day),
    sevenDayOpus: pick(u.seven_day_opus),
    sevenDaySonnet: pick(u.seven_day_sonnet),
    at: now,
  };
  _usageCache = { at: now, data };
  return data;
}
// The account profile (real email, plan) for the active OAuth login.
async function fetchProfile() {
  const p = await oauthGet("/api/oauth/profile");
  if (!p || !p.account) return null;
  return { email: p.account.email || "", name: p.account.display_name || p.account.full_name || "", hasMax: !!p.account.has_claude_max, hasPro: !!p.account.has_claude_pro };
}

// "Save current login": resolve the account identity (email via the OAuth profile
// API for Claude; the id_token for Codex) and save/refresh its profile. A terminal
// login that lives in the OS-level ~/.claude is imported into the app home first.
async function saveNewLoginAsProfile(provider) {
  const prov = PROV(provider);
  // A deliberate logout stays a logout: don't pull the terminal login back in.
  if (prov === "anthropic" && !isIntentionallyLoggedOut()) syncFromOsLogin();
  if (prov === "anthropic" && credentialsInfo().exists) clearLogoutMarker();
  try { return await reconcileLogin(prov); }
  catch (e) { return { ok: false, detail: String(e.message || e) }; }
}

module.exports = { status, openLoginTerminal, whereClaude, cliVersion, checkUpdates, updateAll, toolVersions, toolLatest, updateTool, providerAuthStatus, authorizeProvider, listProfiles, saveCurrentAsProfile, switchProfile, deleteProfile, saveNewLoginAsProfile, renameProfile, exportProfile, importProfile, logout, liveLogin, profiles, fetchUsage, fetchProfile, isIntentionallyLoggedOut, clearLogoutMarker };
