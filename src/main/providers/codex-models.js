"use strict";
/* Codex model catalog — the models THIS login can actually use, from Codex itself.
 *
 * Codex has no public "list models" API for ChatGPT logins, but the CLI knows:
 *   1. LIVE    `codex debug models` — the catalog Codex will use right now for the
 *              current account (server list, refreshed by etag). ~45 ms when the
 *              cache is fresh, a network round-trip otherwise. Async.
 *   2. ACCOUNT `~/.codex/models_cache.json` — that same server list as Codex last
 *              cached it. Sync + instant; what the UI shows immediately.
 *   3. BUNDLED the catalog embedded in the codex binary (`{ "models": [...] }`) —
 *              every model this Codex version knows, not account-filtered. Used
 *              before the first login (no cache yet).
 *   4. SEED    providers.js' static list, only if no Codex binary exists at all.
 *
 * Every entry carries slug, display name, description, visibility, priority,
 * context window, supported/default reasoning efforts and any `upgrade`
 * (retirement → replacement). Updating Codex → new binary + refreshed server list
 * → new models appear, exactly like the Claude alias probe for Anthropic. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execFile } = require("child_process");

const EXE = process.platform === "win32" ? "codex.exe" : "codex";
const PLAT = `${process.platform}-${process.arch}`;
const appRoot = () => path.join(__dirname, "..", "..", "..");
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const accountCacheFile = () => path.join(codexHome(), "models_cache.json");
function cacheFile() {
  try { const { app } = require("electron"); if (app && app.getPath) return path.join(app.getPath("userData"), "models", "codex-catalog.json"); } catch { /* not in electron */ }
  return path.join(os.tmpdir(), "atomnano-codex-catalog.json");
}
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
function vendorBins(pkgDir) {
  const out = [];
  try { for (const triple of fs.readdirSync(pkgDir)) out.push(path.join(pkgDir, triple, "bin", EXE)); } catch { /* absent */ }
  return out;
}
// Where the Codex binary may live, most authoritative first: the SDK's vendored
// copy (what actually runs our turns), then the global npm install, then PATH.
function candidates() {
  const out = [];
  out.push(...vendorBins(path.join(appRoot(), "node_modules", "@openai", `codex-${PLAT}`, "vendor")));
  if (process.env.APPDATA) out.push(...vendorBins(path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", `codex-${PLAT}`, "vendor")));
  for (const prefix of ["/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules", "/usr/lib/node_modules", path.join(os.homedir(), ".npm-global", "lib", "node_modules"), path.join(os.homedir(), ".volta", "tools", "shared")]) out.push(...vendorBins(path.join(prefix, "@openai", "codex", "node_modules", "@openai", `codex-${PLAT}`, "vendor")));
  if (process.platform === "darwin") out.push("/opt/homebrew/bin/codex", "/usr/local/bin/codex", path.join(os.homedir(), ".local", "bin", "codex"));
  try {
    const w = execFileSync(process.platform === "win32" ? "where" : "which", ["codex"], { timeout: 5000, windowsHide: true }).toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const p of w) {
      // npm shim (codex / codex.cmd) → the real binary is vendored under its node_modules
      out.push(...vendorBins(path.join(path.dirname(p), "node_modules", "@openai", "codex", "node_modules", "@openai", `codex-${PLAT}`, "vendor")));
      // a bare native binary on PATH (brew / cargo install) — on Windows only a real .exe counts
      if (process.platform === "win32" ? /\.exe$/i.test(p) : !path.extname(p)) out.push(p);
    }
  } catch { /* not on PATH */ }
  return [...new Set(out)].filter(isFile);
}
// `where`/`which` costs ~40ms — memoise the candidate list briefly; the binary
// itself is stat'ed on every load so an in-place update is still caught at once.
let candMemo = { at: 0, list: [] };
function candidatesCached(force) {
  if (force || Date.now() - candMemo.at > 30000) candMemo = { at: Date.now(), list: candidates() };
  return candMemo.list;
}
const CACHE_VER = 3;   // maximum capacity is now separate from the client's default window
function binaryKey(file) {
  try { const st = fs.statSync(file); return `v${CACHE_VER}|${file}|${st.size}|${Math.round(st.mtimeMs)}`; } catch { return ""; }
}

/* ---------------- 3. bundled catalog: chunked scan of the binary ---------------- */
function extractCatalog(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const CH = 8 * 1024 * 1024;
    const markers = [Buffer.from('"models": ['), Buffer.from('"models":[')];
    let pos = 0, carry = Buffer.alloc(0), found = -1;
    while (pos < size && found < 0) {
      const buf = Buffer.alloc(Math.min(CH, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      const joined = carry.length ? Buffer.concat([carry, buf.slice(0, n)]) : buf.slice(0, n);
      for (const m of markers) { const i = joined.indexOf(m); if (i >= 0) { found = pos - carry.length + i; break; } }
      carry = joined.slice(Math.max(0, joined.length - 32));
      pos += n;
    }
    if (found < 0) return null;
    const start = Math.max(0, found - 256);
    const win = Buffer.alloc(Math.min(3 * 1024 * 1024, size - start));
    fs.readSync(fd, win, 0, win.length, start);
    const s = win.toString("latin1");
    const open = s.lastIndexOf("{", found - start);
    if (open < 0) return null;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = open; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    const json = JSON.parse(Buffer.from(s.slice(open, end + 1), "latin1").toString("utf8"));
    return Array.isArray(json.models) ? json.models : null;
  } finally { fs.closeSync(fd); }
}
let bundledMemo = null;   // { key, models }
function bundled(file, force) {
  const key = binaryKey(file);
  if (!key) return [];
  if (!force && bundledMemo && bundledMemo.key === key) return bundledMemo.models;
  const cf = cacheFile();
  if (!force) { try { const j = JSON.parse(fs.readFileSync(cf, "utf8")); if (j && j.key === key && Array.isArray(j.models) && j.models.length) { bundledMemo = { key, models: j.models }; return j.models; } } catch { /* no cache */ } }
  let models = [];
  try { models = normalize(extractCatalog(file)); } catch (e) { console.warn("[codex] bundled catalog parse failed:", e.message); }
  bundledMemo = { key, models };
  if (models.length) { try { fs.mkdirSync(path.dirname(cf), { recursive: true }); fs.writeFileSync(cf, JSON.stringify({ key, file, models, at: Date.now() })); } catch { /* best-effort */ } }
  return models;
}

/* ---------------- 2. account list: Codex's own server cache ---------------- */
let acctMemo = null;   // { key, models, fetchedAt }
function accountCached() {
  const f = accountCacheFile();
  let st; try { st = fs.statSync(f); } catch { return null; }
  const key = `${f}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (acctMemo && acctMemo.key === key) return acctMemo;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const models = normalize(j && j.models);
    if (!models.length) return null;
    acctMemo = { key, models, fetchedAt: Date.parse(j.fetched_at || "") || st.mtimeMs, clientVersion: j.client_version || "" };
    return acctMemo;
  } catch { return null; }
}

/* ---------------- 1. live: `codex debug models` ---------------- */
let live = { at: 0, models: null, inflight: null, account: undefined };
const listeners = new Set();
function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
const sig = (models) => (models || []).map((m) => `${m.id}:${m.visibility}:${m.ctx}:${m.defaultCtx}:${(m.efforts || []).join(",")}`).join("|");
// Who is signed in to Codex right now (account id from the ChatGPT id_token, else
// the API key). The model list is PER ACCOUNT, and Codex's own models_cache.json is
// not — so a different identity must force a fresh server fetch.
function authIdentity() {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(codexHome(), "auth.json"), "utf8"));
    const t = a && a.tokens;
    if (t && t.account_id) return "acct:" + t.account_id;
    if (t && t.id_token) {
      const part = String(t.id_token).split(".")[1] || "";
      const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      const au = claims["https://api.openai.com/auth"] || {};
      return "acct:" + (au.chatgpt_account_id || claims.email || claims.sub || "?");
    }
    if (a && a.OPENAI_API_KEY) return "key:" + String(a.OPENAI_API_KEY).slice(-6);
  } catch { /* not logged in */ }
  return "none";
}
// Ask Codex for the catalog it would use right now (network refresh when its
// cache is stale). Rate-limited to once a minute unless forced; a login change
// forces it and clears Codex's account-agnostic cache so the fetch is genuine.
// Resolves to the normalized list, or null on failure/timeout (callers fall back to 2/3).
function refresh({ force, timeoutMs } = {}) {
  if (live.inflight) return live.inflight;
  const acct = authIdentity();
  const switched = live.account !== undefined && live.account !== acct;
  if (switched) { force = true; console.log("[codex] login changed → re-listing models for", acct); }
  if (!force && live.models && Date.now() - live.at < 60000) return Promise.resolve(live.models);
  const file = candidatesCached(!!force)[0];
  if (!file) return Promise.resolve(null);
  // Forced (login switch / update): drop Codex's cache so it can't serve the previous
  // account's list. Keep a copy to restore if the fetch fails (offline).
  let backup = null;
  if (force) { try { backup = fs.readFileSync(accountCacheFile()); fs.unlinkSync(accountCacheFile()); acctMemo = null; } catch { backup = null; } }
  live.inflight = new Promise((resolve) => {
    const prev = sig(currentModels());
    let done = false;
    const finish = (models) => {
      if (done) return; done = true; live.inflight = null;
      if (models && models.length) {
        live = { at: Date.now(), models, inflight: null, account: acct };
        if (sig(models) !== prev || switched) for (const cb of listeners) { try { cb(models); } catch { /* listener */ } }
      } else if (backup && !fs.existsSync(accountCacheFile())) { try { fs.writeFileSync(accountCacheFile(), backup); acctMemo = null; } catch { /* */ } }
      resolve(models && models.length ? models : null);
    };
    let child;
    try {
      child = execFile(file, ["debug", "models"], { timeout: timeoutMs || 20000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: process.env }, (err, stdout) => {
        if (err) { console.warn("[codex] debug models failed:", String(err.message || err).slice(0, 200)); return finish(null); }
        try { const j = JSON.parse(String(stdout)); finish(normalize(Array.isArray(j) ? j : (j && j.models))); }
        catch (e) { console.warn("[codex] debug models parse failed:", e.message); finish(null); }
      });
      if (child.stdin) { try { child.stdin.end(); } catch { /* */ } }
    } catch (e) { console.warn("[codex] debug models spawn failed:", e.message); finish(null); }
  });
  return live.inflight;
}

/* ---------------- normalize + selection ---------------- */
const contextNumber = (n) => Number.isSafeInteger(+n) && +n > 0 ? +n : 0;
function normalize(models) {
  return (models || []).filter((m) => m && m.slug).map((m) => ({
    id: m.slug, name: m.display_name || m.slug, desc: m.description || "",
    visibility: m.visibility || "list", priority: Number.isFinite(+m.priority) ? +m.priority : 999,
    ctx: Math.max(contextNumber(m.max_context_window), contextNumber(m.context_window)) || null,
    defaultCtx: contextNumber(m.context_window) || null,
    efforts: (m.supported_reasoning_levels || []).map((l) => l && l.effort).filter(Boolean),
    effortDesc: Object.fromEntries((m.supported_reasoning_levels || []).filter((l) => l && l.effort).map((l) => [l.effort, l.description || ""])),
    defaultEffort: m.default_reasoning_level || "",
    upgrade: m.upgrade && m.upgrade.model ? { model: m.upgrade.model, at: m.upgrade.retirement_at || "" } : null,
    plans: Array.isArray(m.available_in_plans) ? m.available_in_plans : null,
    api: m.supported_in_api,
  })).sort((a, b) => a.priority - b.priority);
}
// The user's own Codex defaults (what the TUI would use) — respected as ours.
function readConfigDefaults() {
  try {
    const t = fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8");
    const top = t.split(/^\s*\[/m)[0];   // top-level keys only (not [profiles.x])
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(top), e = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top);
    return { model: m ? m[1] : "", effort: e ? e[1] : "" };
  } catch { return { model: "", effort: "" }; }
}
// The live list is only trusted for the account it was fetched for.
const liveValid = () => !!(live.models && live.models.length && (live.account === undefined || live.account === authIdentity()));
function currentModels() {
  if (liveValid()) return live.models;
  const a = accountCached(); if (a) return a.models;
  const file = candidatesCached(false)[0];
  return file ? bundled(file, false) : [];
}
// Sync snapshot: { source: "live"|"account"|"bundled"|"none", file, models, defaults }.
function load({ force } = {}) {
  const file = candidatesCached(!!force)[0] || "";
  let source = "none", models = [];
  if (live.models && live.models.length && !liveValid()) { refresh({ force: true }).catch(() => {}); }   // login changed → re-list in the background
  if (liveValid() && (!force || Date.now() - live.at < 5000)) { source = "live"; models = live.models; }
  else {
    const a = accountCached();
    if (a) { source = "account"; models = a.models; }
    else if (file) { models = bundled(file, !!force); if (models.length) source = "bundled"; }
  }
  return { source, file, models, defaults: readConfigDefaults(), at: Date.now() };
}
const listed = (models) => (models || []).filter((m) => m.visibility !== "hide");
// Everything Codex knows about a model id — the account list first, then the
// bundled catalog (which still describes retired ids and their `upgrade` target).
function lookup(id) {
  const want = String(id || "").toLowerCase();
  const hit = currentModels().find((m) => m.id.toLowerCase() === want);
  if (hit) return hit;
  const file = candidatesCached(false)[0];
  return file ? (bundled(file, false).find((m) => m.id.toLowerCase() === want) || null) : null;
}

module.exports = { load, refresh, onChange, lookup, authIdentity, candidates, extractCatalog, normalize, readConfigDefaults, listed, codexHome, accountCacheFile };
