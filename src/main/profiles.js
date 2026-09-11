"use strict";
/* Credential PROFILES for CLI logins — Anthropic (Claude Code) and OpenAI (Codex).
 *
 * The live login is ONE file the CLI owns and rewrites whenever it refreshes its
 * OAuth tokens (access AND refresh tokens rotate; the old refresh token is then
 * dead). A saved profile is a copy of that file. That makes rotation the whole
 * problem: a copy taken at save time goes stale the first time the account is
 * used, and restoring a stale copy later yields a login that can never refresh.
 *
 * Rotation-proof rules used here:
 *   1. `_active.json` remembers WHICH profile the live login came from. Every
 *      write to the live file (watched, polled) is mirrored into that profile,
 *      so the saved copy is always the newest tokens — even after a crash.
 *   2. Switching away first mirrors the live file into its profile, then copies
 *      the target in. Switching TO a profile whose refresh token has expired is
 *      refused with `expired: true` (sign in again) instead of installing a
 *      dead credential.
 *   3. Identity is the account (email / account id from the OAuth profile or the
 *      id_token JWT), never the token and never the plan name. Tokens are only a
 *      last-resort fingerprint.
 *
 * Layout per provider: <configDir>/profiles/<label>.json (+ _active.json,
 * _meta.json sidecars; "_" files are never listed as profiles). */
const fs = require("fs");
const os = require("os");
const path = require("path");

const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const writeJson = (p, j) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); };
const safeLabel = (s) => String(s || "").replace(/[^a-zA-Z0-9_@.\- ]/g, "_").slice(0, 80).trim();
const shortHash = (s) => { try { return require("crypto").createHash("sha256").update(String(s || "")).digest("hex").slice(0, 8); } catch { return "saved"; } };
// Decode a JWT payload without verifying (we only read identity claims from a token we already hold).
function jwtClaims(tok) {
  try { const p = String(tok || "").split("."); if (p.length < 2) return null; return JSON.parse(Buffer.from(p[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { return null; }
}

const PROVIDERS = {
  anthropic: {
    name: "Claude",
    authPath: () => path.join(claudeConfigDir(), ".credentials.json"),
    dir: () => path.join(claudeConfigDir(), "profiles"),
    valid: (j) => !!(j && (j.claudeAiOauth || j.oauth)),
    identity(j) {
      const o = (j && (j.claudeAiOauth || j.oauth)) || {};
      return { email: o.email || o.accountEmailAddress || "", id: o.accountUuid || o.account_uuid || "", fp: o.refreshToken || o.accessToken || "", sub: o.subscriptionType || "", expiresAt: +o.expiresAt || 0, refreshExpiresAt: +o.refreshTokenExpiresAt || 0 };
    },
    // The CLI ignores the extra `email` field; it makes saved copies identifiable.
    stamp(j, email) { const o = j && (j.claudeAiOauth || j.oauth); if (o && email && !o.email) o.email = email; },
    fileFilter: { name: "Claude credentials", extensions: ["json"] }, exportExt: ".claudecreds.json",
  },
  openai: {
    name: "Codex",
    authPath: () => path.join(codexHome(), "auth.json"),
    dir: () => path.join(codexHome(), "profiles"),
    valid: (j) => !!(j && (j.tokens || j.OPENAI_API_KEY)),
    identity(j) {
      const t = (j && j.tokens) || {};
      const idc = jwtClaims(t.id_token) || {}, acc = jwtClaims(t.access_token) || {};
      const auth = idc["https://api.openai.com/auth"] || acc["https://api.openai.com/auth"] || {};
      const prof = idc["https://api.openai.com/profile"] || {};
      const email = idc.email || prof.email || acc.email || "";
      const id = t.account_id || auth.chatgpt_account_id || idc.sub || acc.sub || "";
      const sub = auth.chatgpt_plan_type || (j && j.OPENAI_API_KEY && !j.tokens ? "api key" : "");
      return { email, id, fp: t.refresh_token || t.access_token || (j && j.OPENAI_API_KEY) || "", sub, expiresAt: acc.exp ? acc.exp * 1000 : 0, refreshExpiresAt: 0 };
    },
    stamp() { /* Codex's auth.json is strictly parsed — identity lives in the _meta sidecar */ },
    fileFilter: { name: "Codex credentials", extensions: ["json"] }, exportExt: ".codexauth.json",
  },
};
const P = (provider) => { const p = PROVIDERS[provider === "codex" ? "openai" : (provider || "anthropic")]; if (!p) throw new Error("Unknown provider: " + provider); return p; };
const activeFile = (p) => path.join(p.dir(), "_active.json");
const metaFile = (p) => path.join(p.dir(), "_meta.json");
const getActive = (p) => { const j = readJson(activeFile(p)); return (j && j.label) || ""; };
const setActive = (p, label) => { try { writeJson(activeFile(p), { label: label || "", at: Date.now() }); } catch { /* best effort */ } };
const getMeta = (p) => readJson(metaFile(p)) || {};
const setMeta = (p, label, patch) => { try { const m = getMeta(p); m[label] = { ...(m[label] || {}), ...patch, at: Date.now() }; writeJson(metaFile(p), m); } catch { /* */ } };
const dropMeta = (p, label) => { try { const m = getMeta(p); delete m[label]; writeJson(metaFile(p), m); } catch { /* */ } };
const profilePath = (p, label) => path.join(p.dir(), label + ".json");
const profileLabels = (p) => { try { return fs.readdirSync(p.dir()).filter((f) => f.endsWith(".json") && !f.startsWith("_")).map((f) => f.replace(/\.json$/, "")); } catch { return []; } };
// Identity of a stored profile: the file's own claims, enriched by the sidecar.
function identityOf(p, j, label) {
  const id = p.identity(j || {});
  const m = label ? (getMeta(p)[label] || {}) : {};
  return { ...id, email: id.email || m.email || "", id: id.id || m.id || "" };
}
// Same ACCOUNT? The STABLE account / workspace id is the identity key; an email
// is a display label (one person's personal and work Codex accounts can share an
// email while having different account ids — they must stay distinct profiles).
// Precedence: id → email → (last resort) token fingerprint. Plan names never.
function sameAccount(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  if (a.email && b.email) return a.email.toLowerCase() === b.email.toLowerCase();
  return !!(a.fp && b.fp && a.fp === b.fp);
}
// Are two identities PROVABLY different accounts? Unknown is NOT different: a
// Claude subscription login carries no email and its tokens rotate, so the only
// hard evidence is a differing account id / email — or, when neither side has
// those, a differing plan (two plans can't be one account at one moment).
function conflict(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id !== b.id;
  if (a.email && b.email) return a.email.toLowerCase() !== b.email.toLowerCase();
  if (a.sub && b.sub) return a.sub !== b.sub;
  return false;
}
// Short, non-secret identity handle for a live login (bound to session threads so
// a thread created under one account is never mistaken for another's).
function accountKey(provider) {
  try {
    const p = P(provider);
    const live = readJson(p.authPath());
    if (!p.valid(live)) return "";
    const id = p.identity(live);
    return id.id ? "id:" + shortHash(id.id) : id.email ? "email:" + shortHash(id.email.toLowerCase()) : id.fp ? "fp:" + shortHash(id.fp) : "";
  } catch { return ""; }
}
// Which saved profile is the live login? The tracked label is trusted unless the
// live login is provably another account (someone ran `claude login` / `codex
// login` with a different email); then identity matching; "" when unknown.
// `hint.email` is an identity resolved out-of-band (OAuth profile API).
function activeLabel(provider, hint = {}) {
  const p = P(provider);
  const live = readJson(p.authPath());
  if (!p.valid(live)) return "";
  const labels = profileLabels(p);
  const lid = { ...p.identity(live) }; if (hint.email && !lid.email) lid.email = hint.email;
  const tracked = getActive(p);
  if (tracked && labels.includes(tracked) && !conflict(identityOf(p, readJson(profilePath(p, tracked)), tracked), lid)) return tracked;
  for (const l of labels) if (sameAccount(identityOf(p, readJson(profilePath(p, l)), l), lid)) { setActive(p, l); return l; }
  if (tracked) setActive(p, "");     // tracked profile is NOT this login any more
  return "";
}
// Reconcile the live file with the saved profiles (rotation persistence):
//   · belongs to a saved profile → mirror the fresh tokens into it (+ stamp identity)
//   · unknown account            → save it as a NEW profile (never over another one)
// `hint.email` lets the caller pass an API-resolved email for logins whose file
// has none, which is what keeps a foreign login from being mistaken for rotation.
function reconcile(provider, hint = {}) {
  const p = P(provider);
  const live = readJson(p.authPath());
  if (!p.valid(live)) return { ok: false, reason: "no live login" };
  const lid = { ...p.identity(live) }; if (hint.email && !lid.email) lid.email = hint.email;
  const label = activeLabel(provider, hint);
  if (!label) { const r = saveCurrent(provider, "", { email: lid.email }); return { ...r, created: true }; }
  const target = profilePath(p, label);
  const cur = readJson(target);
  const known = identityOf(p, cur || {}, label);
  const email = lid.email || known.email || "";
  const out = JSON.parse(JSON.stringify(live));
  if (email) p.stamp(out, email);
  const changed = !cur || JSON.stringify(cur) !== JSON.stringify(out);
  if (changed) writeJson(target, out);
  if (email || lid.id || known.id) setMeta(p, label, { email, id: lid.id || known.id });
  setActive(p, label);
  return { ok: true, label, rotated: changed };
}
const persistLive = (provider) => reconcile(provider, {});

/* ------------------------------ public API ------------------------------ */
function list(provider) {
  const p = P(provider);
  const now = Date.now();
  const out = profileLabels(p).map((label) => {
    const j = readJson(profilePath(p, label));
    const id = identityOf(p, j, label);
    let mtime = 0; try { mtime = fs.statSync(profilePath(p, label)).mtimeMs; } catch { /* */ }
    return { label, email: id.email, sub: id.sub, id: id.id ? shortHash(id.id) : "", expired: !!(id.refreshExpiresAt && id.refreshExpiresAt < now), valid: p.valid(j), mtime };
  }).sort((a, b) => a.label.localeCompare(b.label));
  const active = activeLabel(provider);
  for (const x of out) { x.active = x.label === active; delete x.mtime; }
  return out;
}
function saveCurrent(provider, label, opts = {}) {
  const p = P(provider);
  const live = readJson(p.authPath());
  if (!p.valid(live)) return { ok: false, detail: `No active ${p.name} login to save` };
  const lid = p.identity(live);
  const email = opts.email || lid.email;
  if (email && !lid.email) p.stamp(live, email);
  const wanted = safeLabel(label || email || lid.sub || (lid.id ? "account-" + shortHash(lid.id) : "account-" + shortHash(lid.fp)));
  if (!wanted) return { ok: false, detail: "Invalid label" };
  fs.mkdirSync(p.dir(), { recursive: true });
  // Same account already saved → refresh that entry (tokens rotate) instead of adding a duplicate.
  for (const l of profileLabels(p)) {
    if (!sameAccount(identityOf(p, readJson(profilePath(p, l)), l), { ...lid, email })) continue;
    writeJson(profilePath(p, l), live);
    setMeta(p, l, { email, id: lid.id });
    let finalLabel = l;
    // Upgrade a placeholder label ("max", "account-1a2b") once the real email is known.
    if (wanted !== l && wanted.includes("@") && !l.includes("@") && !fs.existsSync(profilePath(p, wanted))) {
      fs.renameSync(profilePath(p, l), profilePath(p, wanted)); const m = getMeta(p); m[wanted] = m[l]; delete m[l]; writeJson(metaFile(p), m); finalLabel = wanted;
    }
    setActive(p, finalLabel);
    return { ok: true, label: finalLabel, updated: true };
  }
  let name = wanted, i = 2;
  while (fs.existsSync(profilePath(p, name))) name = `${wanted}-${i++}`;
  writeJson(profilePath(p, name), live);
  setMeta(p, name, { email, id: lid.id });
  setActive(p, name);
  return { ok: true, label: name };
}
function switchTo(provider, label) {
  const p = P(provider);
  const pf = profilePath(p, label);
  const target = readJson(pf);
  if (!p.valid(target)) return { ok: false, detail: "Saved account not found or unreadable" };
  const tid = identityOf(p, target, label);
  if (tid.refreshExpiresAt && tid.refreshExpiresAt < Date.now()) return { ok: false, expired: true, detail: `The saved login for “${label}” has expired (its refresh token is past its lifetime). Sign in to that account again and re-save it.` };
  const authPath = p.authPath();
  const live = readJson(authPath);
  if (p.valid(live)) {
    if (sameAccount(p.identity(live), tid)) { setActive(p, label); return { ok: true, label, already: true }; }
    // Park the current login in ITS profile so its freshest tokens are what we restore later.
    const cur = activeLabel(provider);
    if (cur && cur !== label) { writeJson(profilePath(p, cur), live); }
    else {
      const lid = p.identity(live);
      const base = lid.email || (lid.id ? "account-" + shortHash(lid.id) : "account-" + shortHash(lid.fp));
      let name = safeLabel(base) || "backup", i = 2;
      while (fs.existsSync(profilePath(p, name))) name = `${safeLabel(base)}-${i++}`;
      writeJson(profilePath(p, name), live); setMeta(p, name, { email: lid.email, id: lid.id });
    }
  }
  // Atomic-ish install: write a temp file next to the target, then rename over it.
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  const tmp = authPath + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(target, null, 2));
  fs.renameSync(tmp, authPath);
  setActive(p, label);
  return { ok: true, label };
}
function remove(provider, label) {
  const p = P(provider);
  try { fs.unlinkSync(profilePath(p, label)); } catch { /* already gone */ }
  dropMeta(p, label);
  if (getActive(p) === label) setActive(p, "");
  return { ok: true };
}
function rename(provider, oldLabel, newLabel) {
  const p = P(provider);
  const src = profilePath(p, oldLabel);
  if (!fs.existsSync(src)) return { ok: false, detail: "Saved account not found" };
  const safe = safeLabel(newLabel);
  if (!safe) return { ok: false, detail: "Invalid name" };
  const dst = profilePath(p, safe);
  if (fs.existsSync(dst) && safe !== oldLabel) return { ok: false, detail: "A saved account with that name already exists" };
  fs.renameSync(src, dst);
  const m = getMeta(p); if (m[oldLabel]) { m[safe] = m[oldLabel]; delete m[oldLabel]; writeJson(metaFile(p), m); }
  if (getActive(p) === oldLabel) setActive(p, safe);
  return { ok: true, label: safe };
}
function exportTo(provider, label, destPath) {
  const p = P(provider);
  const src = profilePath(p, label);
  if (!fs.existsSync(src)) return { ok: false, detail: "Saved account not found" };
  if (!destPath) return { ok: false, detail: "No destination" };
  // Export the FRESHEST copy: if this is the live account, mirror it first.
  if (activeLabel(provider) === label) persistLive(provider);
  try { fs.copyFileSync(src, destPath); return { ok: true, path: destPath }; } catch (e) { return { ok: false, detail: String(e.message || e) }; }
}
function importFrom(provider, srcPath, label) {
  const p = P(provider);
  const j = readJson(srcPath);
  if (!p.valid(j)) return { ok: false, detail: `Not a ${p.name} credential file` };
  const id = p.identity(j);
  const base = safeLabel(label) || id.email || id.sub || path.basename(srcPath).replace(/\.json$/i, "") || "imported";
  fs.mkdirSync(p.dir(), { recursive: true });
  let name = safeLabel(base) || "imported", i = 2;
  while (fs.existsSync(profilePath(p, name))) name = `${safeLabel(base)}-${i++}`;
  writeJson(profilePath(p, name), j);
  setMeta(p, name, { email: id.email, id: id.id });
  return { ok: true, label: name };
}
// Live-login summary for the UI (no secrets).
function liveInfo(provider) {
  const p = P(provider);
  const live = readJson(p.authPath());
  if (!p.valid(live)) return { loggedIn: false };
  const id = p.identity(live);
  return { loggedIn: true, email: id.email, sub: id.sub, savedAs: activeLabel(provider), expiresAt: id.expiresAt || 0, refreshExpiresAt: id.refreshExpiresAt || 0 };
}
const fileFilter = (provider) => P(provider).fileFilter;
const exportExt = (provider) => P(provider).exportExt;

/* ------------------------------ rotation watcher ------------------------------
 * Polls both live files (fs.watch misses the CLI's rename-over-write on Windows).
 * Any change is mirrored into the profile the login came from; listeners get
 * "profiles:changed" so open windows refresh their account lists. */
const stamps = {}, missing = {}, timers = {};
const changedAt = {};   // provider → when the live file was last seen to change (identity-bound async work checks this)
function lastChangeAt(provider) { return changedAt[provider] || 0; }
let watchTimer = 0;
// notify(provider, info): info = { initial } | { changed } | { loggedOut }. The
// caller reconciles (it may resolve the account's email via an API first). A file
// must be missing for TWO polls before it counts as a logout — the CLI replaces
// the file by rename, so a single miss is just the write in flight.
function checkOnce(notify) {
  const fire = (provider, info) => { clearTimeout(timers[provider]); timers[provider] = setTimeout(() => { try { notify && notify(provider, info); } catch { /* */ } }, 500); };
  for (const provider of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[provider];
    let st = 0; try { st = fs.statSync(p.authPath()).mtimeMs; } catch { st = 0; }
    if (stamps[provider] === undefined) { stamps[provider] = st; missing[provider] = st ? 0 : 1; if (st) fire(provider, { initial: true }); continue; }
    if (!st) {
      missing[provider] = (missing[provider] || 0) + 1;
      if (missing[provider] === 2) { const had = getActive(p); if (had) setActive(p, ""); fire(provider, { loggedOut: true, was: had }); }
      stamps[provider] = 0;
      continue;
    }
    const wasMissing = missing[provider] > 0; missing[provider] = 0;
    if (st === stamps[provider] && !wasMissing) continue;
    stamps[provider] = st;
    changedAt[provider] = Date.now();
    fire(provider, { changed: true, loggedIn: wasMissing });
  }
}
function startWatcher(notify, intervalMs = 2500) {
  if (watchTimer) return;
  checkOnce(notify);
  watchTimer = setInterval(() => checkOnce(notify), intervalMs);
}
function stopWatcher() { if (watchTimer) { clearInterval(watchTimer); watchTimer = 0; } }
// Remove the live login file (after mirroring it into its profile) — the CLI
// then reports "not logged in"; any saved account can be restored with one click.
function logout(provider) {
  const p = P(provider);
  try { reconcile(provider, {}); } catch { /* best effort */ }
  const f = p.authPath();
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { return { ok: false, detail: String(e.message || e) }; }
  setActive(p, "");
  return { ok: true };
}

module.exports = { list, saveCurrent, switchTo, remove, rename, exportTo, importFrom, liveInfo, activeLabel, accountKey, persistLive, reconcile, logout, sameAccount, conflict, identityOf, fileFilter, exportExt, startWatcher, stopWatcher, lastChangeAt, jwtClaims, codexHome, claudeConfigDir, PROVIDERS };
