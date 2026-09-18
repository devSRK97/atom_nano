"use strict";
/* IPC: settings:* (per-project, with a global fallback), project:* tab state, the full user-data
 * backup/restore zip (userdata:* — the bundle builders live here and are exported so the test
 * hooks can exercise them), and the atomnano CLI link (cli:*). */
const { app, dialog } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const store = require("../storage/store");
const auth = require("../auth/cli-auth");
const zipper = require("../workspace/zipper");
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
// Always includes: ALL settings (incl. secrets + custom endpoints with tokens), the PER-PROJECT
// overrides (store.projectSettings — each project's active workflow, provider / model picks, theme,
// agent toggles; getSettings() hides that map, so it is added explicitly — 2026-09-18), provider login
// files, and the per-project skill files (userData/skills/<key>.json — the store the Workflow Studio
// attaches to its roles; restored workflows need them).
// Machine-local keys are dropped from the global preferences AND from every project's overrides.
const stripMachineLocal = (obj) => { const out = {}; for (const k of Object.keys(obj || {})) if (!EXPORT_SKIP_KEYS.has(k)) out[k] = obj[k]; return out; };
function buildUserdataBundle(opts = {}) {
  const includeSessions = !!opts.includeSessions;
  const s = store.getSettings();
  const prefs = stripMachineLocal(s);
  const perProject = store.getProjectSettingsMap();
  const projectSettings = {};
  for (const k of Object.keys(perProject)) { const ov = stripMachineLocal(perProject[k]); if (Object.keys(ov).length) projectSettings[k] = ov; }
  prefs.projectSettings = projectSettings;
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
      includes: ["settings", "project-settings", "secrets", "provider-auth", "custom-endpoints", "skills", ...(includeSessions ? ["conversations"] : [])],
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
    else if (k === "projectSettings") {
      // Per-project overrides merge PROJECT BY PROJECT (the bundle's values win, like the globals above): a project
      // this machine already knows keeps the keys the bundle does not carry; machine-local keys never come back.
      const have = store.getProjectSettingsMap(), src = prefs.projectSettings && typeof prefs.projectSettings === "object" ? prefs.projectSettings : {};
      const out = { ...have };
      for (const pk of Object.keys(src)) { if (!src[pk] || typeof src[pk] !== "object" || Array.isArray(src[pk])) continue; out[pk] = { ...(have[pk] || {}), ...stripMachineLocal(src[pk]) }; }
      merged.projectSettings = out;   // a GLOBAL_ONLY key: saveSettings writes the whole map
    }
    else merged[k] = prefs[k];
  }
  if (Object.keys(merged).length) store.saveSettings(merged);
  return { sessions: sessionsRestored, skills: skillsRestored, auth: authRestored, projects: (manifest.projects || []).length, manifest };
}

function register(ctx) {
  const { handle, winFrom, projectOf, applyPreventSleep } = ctx;
  // ---- Settings ----
  // Settings are PER-PROJECT (keyed by the requesting window's project), with a
  // global fallback for machine/account-level keys (see store.GLOBAL_ONLY).
  handle("settings:get", async (e) => store.getSettings(projectOf(winFrom(e))));
  handle("settings:set", async (e, partial) => { const s = store.saveSettings(partial || {}, projectOf(winFrom(e))); if (partial && "preventSleep" in partial) applyPreventSleep(s.preventSleep); return s; });

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

module.exports = { register, buildUserdataBundle, applyUserdataBundle };
