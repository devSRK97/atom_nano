"use strict";
/* Connection profiles. userData/db-connections.json is a versioned document written atomically
 * (temp + rename, .bak kept) whose read / parse failures are typed errors — never an empty list a
 * later save would overwrite. Secrets are { $enc: 1, data } envelopes sealed with Electron
 * safeStorage: list() exposes presence only, a locked envelope is reported (never blanked), and
 * without OS encryption a secret is refused rather than written in plaintext (session-only
 * credentials exist for that case). Every save bumps rev so stale operations can be rejected. */
const { app, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");
const { DbError, KINDS, TYPES, POLICIES, VALID_KIND, uid } = require("./db-common");
const { driverInstalled } = require("./db-drivers");
const { closeOne } = require("./db-connections");

const CONN_FILE = () => path.join(app.getPath("userData"), "db-connections.json");

/* ============================== connection store ============================== */
const STORE_VERSION = 2;
const SECRET_FIELDS = ["password", "uri"];
function canEncrypt() { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; } }
const isEnvelope = (v) => v && typeof v === "object" && v.$enc === 1 && typeof v.data === "string";
// Encrypt a plaintext secret → envelope. Throws (typed) when secure storage is unavailable.
function sealSecret(plain) {
  if (!canEncrypt()) throw new DbError("Secure credential storage is not available on this system — the secret was not saved.", { type: "secret-unavailable", hint: "Use a session-only credential (kept in memory until the app closes) or fix the OS keychain / DPAPI." });
  try { return { $enc: 1, data: safeStorage.encryptString(String(plain)).toString("base64") }; }
  catch (e) { throw new DbError("Encrypting the credential failed: " + e.message, { type: "secret-unavailable" }); }
}
// Decrypt an envelope → { value } or { locked: true } (ciphertext retained, never blanked).
function openSecret(stored) {
  if (stored == null || stored === "") return { value: "" };
  if (typeof stored === "string" && stored.startsWith("enc:")) { try { return { value: safeStorage.decryptString(Buffer.from(stored.slice(4), "base64")) }; } catch { return { locked: true }; } }   // legacy envelope
  if (isEnvelope(stored)) { try { return { value: safeStorage.decryptString(Buffer.from(stored.data, "base64")) }; } catch { return { locked: true }; } }
  if (typeof stored === "string") return { value: stored, plaintext: true };   // legacy plaintext (migrated on the next save)
  return { value: "" };
}
function readStore() {
  const file = CONN_FILE();
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return { version: STORE_VERSION, connections: [] }; throw new DbError(`Cannot read the connection store (${e.code || e.message}). Nothing was changed.`, { type: "store", code: e.code, details: file }); }
  let j;
  try { j = JSON.parse(raw); } catch (e) { throw new DbError("The connection store is damaged (invalid JSON). It was left untouched — repair or move db-connections.json.", { type: "store-corrupt", details: file + "\n" + e.message }); }
  if (Array.isArray(j)) return { version: 1, connections: j.filter((c) => c && typeof c === "object") };
  if (!j || typeof j !== "object" || !Array.isArray(j.connections)) throw new DbError("The connection store has an unexpected shape. It was left untouched.", { type: "store-corrupt", details: file });
  return j;
}
// Atomic write: temp file in the same folder, fsync, rename; the previous file is kept as .bak.
function writeStore(doc) {
  const file = CONN_FILE();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const text = JSON.stringify({ version: STORE_VERSION, savedAt: new Date().toISOString(), connections: doc.connections }, null, 2);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, "w"); try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (JSON.parse(fs.readFileSync(tmp, "utf8")).connections.length !== doc.connections.length) throw new Error("verification of the written store failed");
    if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + ".bak"); } catch { /* backup is best effort */ } }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw new DbError(`Saving the connection store failed (${e.code || e.message}). The previous store is intact.`, { type: "store", code: e.code, details: file });
  }
}
// Session-only credentials (never persisted): connId → { password?, uri? }
const sessionSecrets = new Map();
function setSessionSecret(id, fields) {
  if (!id || typeof id !== "string") throw new DbError("Connection id is required.", { type: "invalid" });
  const cur = sessionSecrets.get(id) || {};
  for (const f of SECRET_FIELDS) if (fields && typeof fields[f] === "string") { if (fields[f]) cur[f] = fields[f]; else delete cur[f]; }
  if (Object.keys(cur).length) sessionSecrets.set(id, cur); else sessionSecrets.delete(id);
  return { ok: true, fields: Object.keys(cur) };
}
// Public profile: no secret values, only their presence/lock state.
function publicProfile(c) {
  const o = {};
  for (const [k, v] of Object.entries(c)) if (!SECRET_FIELDS.includes(k)) o[k] = v;
  const locked = {};
  o.hasPassword = false; o.hasUri = false;
  for (const f of SECRET_FIELDS) {
    const st = openSecret(c[f]);
    const has = c[f] != null && c[f] !== "";
    if (f === "password") o.hasPassword = has; else o.hasUri = has;
    if (st.locked) locked[f] = true;
    if (st.plaintext) o.legacyPlaintext = true;
  }
  if (sessionSecrets.has(c.id)) o.sessionSecret = Object.keys(sessionSecrets.get(c.id));
  o.secretLocked = locked;
  o.rev = c.rev || 1;
  return o;
}
function list() { return readStore().connections.map(publicProfile); }
// Full profile WITH decrypted secrets — internal use only (connecting).
function getConn(id, expectRev) {
  if (!id || typeof id !== "string") throw new DbError("Connection id is required.", { type: "invalid" });
  const c = readStore().connections.find((x) => x.id === id);
  if (!c) throw new DbError("Connection not found", { type: "not-found" });
  if (expectRev != null && +expectRev !== (c.rev || 1)) throw new DbError("This connection's settings changed since the operation was prepared. Reload and try again.", { type: "stale-connection" });
  const o = { ...c };
  const ss = sessionSecrets.get(id) || {};
  for (const f of SECRET_FIELDS) {
    if (ss[f]) { o[f] = ss[f]; continue; }
    const st = openSecret(c[f]);
    if (st.locked) throw new DbError(`The saved ${f} for “${c.name || id}” cannot be decrypted on this account/machine. Enter it again to continue.`, { type: "secret-locked", hint: "Edit the connection and re-enter the secret, or use a session-only credential." });
    o[f] = st.value || "";
  }
  return o;
}
// Reveal one secret on explicit request (edit form eye button).
function revealSecret(id, field) {
  if (!SECRET_FIELDS.includes(field)) throw new DbError("Unknown secret field.", { type: "invalid" });
  const c = readStore().connections.find((x) => x.id === id);
  if (!c) throw new DbError("Connection not found", { type: "not-found" });
  const ss = sessionSecrets.get(id) || {};
  if (ss[field]) return { value: ss[field], session: true };
  const st = openSecret(c[field]);
  if (st.locked) throw new DbError(`The saved ${field} cannot be decrypted on this account/machine.`, { type: "secret-locked" });
  return { value: st.value || "" };
}
/* Save a profile. Secret fields: undefined / { $keep: true } keep the stored envelope,
 * "" clears, a string is sealed. Legacy plaintext is migrated only when sealing works.
 * The live connection is closed only AFTER persistence succeeded. */
async function save(conn) {
  if (!conn || typeof conn !== "object") throw new DbError("Connection is required.", { type: "invalid" });
  if (!VALID_KIND(conn.kind)) throw new DbError("Unknown database kind: " + conn.kind, { type: "invalid" });
  const store = readStore();
  const isNew = !conn.id;
  if (isNew) conn.id = uid();
  else if (typeof conn.id !== "string") throw new DbError("Invalid connection id.", { type: "invalid" });
  const i = store.connections.findIndex((c) => c.id === conn.id);
  const prev = i >= 0 ? store.connections[i] : null;
  if (!isNew && prev && conn.rev != null && +conn.rev !== (prev.rev || 1)) throw new DbError("Someone else saved this connection meanwhile (another window?). Reload it before saving.", { type: "stale-connection" });
  const out = {};
  for (const [k, v] of Object.entries(conn)) if (!SECRET_FIELDS.includes(k) && !["hasPassword", "hasUri", "secretLocked", "legacyPlaintext", "sessionSecret"].includes(k)) out[k] = v;
  for (const f of SECRET_FIELDS) {
    const v = conn[f];
    if (v === undefined || (v && typeof v === "object" && v.$keep)) {
      // keep — migrating legacy plaintext when we can
      const stored = prev ? prev[f] : undefined;
      if (typeof stored === "string" && stored && !stored.startsWith("enc:") && canEncrypt()) out[f] = sealSecret(stored);
      else if (stored != null) out[f] = stored;
    } else if (v === "" || v === null) { /* cleared */ }
    else if (typeof v === "string") out[f] = sealSecret(v);
    else throw new DbError(`Invalid ${f} value.`, { type: "invalid" });
  }
  if (out.policy && typeof out.policy === "object") { const p = {}; for (const k of POLICIES.sql) if (out.policy[k] !== undefined) p[k] = k === "protectedTables" ? (Array.isArray(out.policy[k]) ? out.policy[k].map(String).filter(Boolean) : []) : !!out.policy[k]; out.policy = p; }
  out.rev = (prev ? (prev.rev || 1) : 0) + 1;
  out.updatedAt = new Date().toISOString();
  if (i >= 0) store.connections[i] = out; else store.connections.push(out);
  writeStore(store);                                       // throws typed — nothing else changed
  await closeOne(conn.id);                                 // config changed → drop the live connection
  return publicProfile(out);
}
async function remove(id) {
  const store = readStore();
  const before = store.connections.length;
  store.connections = store.connections.filter((c) => c.id !== id);
  if (store.connections.length === before) throw new DbError("Connection not found", { type: "not-found" });
  writeStore(store);
  sessionSecrets.delete(id);
  await closeOne(id);
  return { ok: true };
}

// The engine catalog as the connection form sees it: installed drivers and secure-storage availability are live facts, not constants.
function kinds() {
  return Object.entries(KINDS).map(([id, k]) => ({ id, name: k.name, pkg: k.pkg, port: k.port, fields: k.fields, dbLabel: k.dbLabel || "Database", uriPlaceholder: k.uriPlaceholder || "", tls: !!k.tls, installed: driverInstalled(id), types: TYPES[id] || [], policies: POLICIES[id] || POLICIES.sql, secureStorage: canEncrypt() }));
}

module.exports = { SECRET_FIELDS, sealSecret, openSecret, readStore, writeStore, sessionSecrets, setSessionSecret, list, getConn, revealSecret, save, remove, kinds };
