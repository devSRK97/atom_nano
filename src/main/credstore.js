"use strict";
/* Where the Claude CLI keeps its OAuth login — and therefore where AtomNano must read and
 * write it (profiles, "Save current login", the terminal-login import, logout):
 *
 *   macOS    Keychain generic password. account = "claude-code-user"; service =
 *            "Claude Code-credentials" for the default ~/.claude home, or
 *            "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR).hex.slice(0,8)>" for a custom
 *            home (AtomNano runs with its own). <home>/.credentials.json is only the CLI's
 *            plaintext fallback when the Keychain is unavailable.
 *   others   <home>/.credentials.json.
 *
 * (Scheme read from Claude Code 2.1.263: `security find-generic-password -a claude-code-user -w
 * -s <service>`, writes via `security -i` / `add-generic-password -U … -X <hex>`.) Access goes
 * through the same /usr/bin/security the CLI uses, so the Keychain ACL never prompts.
 * Everything is synchronous (a `security` call takes ~20 ms) so the profile code stays simple. */
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ACCOUNT = "claude-code-user";
const FILE = ".credentials.json";
const usesKeychain = () => process.platform === "darwin" && !process.env.ATOMNANO_NO_KEYCHAIN;
const defaultHome = () => path.join(os.homedir(), ".claude");
const homeDir = () => process.env.CLAUDE_CONFIG_DIR || defaultHome();

/* Keychain service name for a Claude home. `isDefault` = the CLI ran WITHOUT CLAUDE_CONFIG_DIR
 * (the user's own terminal) → no hash suffix. The hash is over the config-dir string exactly as
 * the CLI sees it in its environment (NFC-normalised), so AtomNano's own home and the CLI it
 * spawns with that same CLAUDE_CONFIG_DIR value agree on the entry. */
function keychainService(configDir, { isDefault = false } = {}) {
  if (isDefault) return "Claude Code-credentials";
  const h = crypto.createHash("sha256").update(String(configDir).normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${h}`;
}
const filePath = (configDir) => path.join(configDir, FILE);

function keychainRead(service) {
  try {
    const out = cp.execFileSync("security", ["find-generic-password", "-a", ACCOUNT, "-w", "-s", service], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    const s = String(out || "").trim();
    return s || null;
  } catch { return null; }
}
function keychainWrite(service, text) {
  // `security -i` reads the command from stdin; -X passes the secret hex-encoded so no quoting issue can corrupt it.
  const hex = Buffer.from(String(text), "utf8").toString("hex");
  cp.execFileSync("security", ["-i"], { input: `add-generic-password -U -a "${ACCOUNT}" -s "${service}" -X "${hex}"\n`, timeout: 8000, stdio: ["pipe", "ignore", "ignore"] });
}
function keychainDelete(service) {
  try { cp.execFileSync("security", ["delete-generic-password", "-a", ACCOUNT, "-s", service], { timeout: 8000, stdio: "ignore" }); return true; } catch { return false; }
}
const parse = (s) => { try { const j = JSON.parse(s); return j && typeof j === "object" ? j : null; } catch { return null; } };

/* The live login of a Claude home: { json, source: "keychain"|"file"|null, raw, mtime, service, file }.
 * macOS: Keychain first, the plaintext file as the CLI's fallback. */
function readLive(configDir = homeDir(), opts = {}) {
  const file = filePath(configDir);
  const out = { json: null, source: null, raw: "", mtime: 0, service: usesKeychain() ? keychainService(configDir, opts) : "", file };
  if (out.service) {
    const raw = keychainRead(out.service);
    if (raw) { const j = parse(raw); if (j) return { ...out, json: j, source: "keychain", raw }; }
  }
  try { const raw = fs.readFileSync(file, "utf8"); const j = parse(raw); if (j) { let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch { /* */ } return { ...out, json: j, source: "file", raw, mtime }; } } catch { /* absent */ }
  return out;
}
/* Install a login into a Claude home: the Keychain entry the CLI will read (macOS) AND the file
 * (the CLI's fallback, and what non-Keychain platforms use). File written 0600 via temp+rename. */
function writeLive(configDir, json, opts = {}) {
  const text = JSON.stringify(json, null, 2);
  fs.mkdirSync(configDir, { recursive: true });
  const file = filePath(configDir), tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (usesKeychain()) keychainWrite(keychainService(configDir, opts), text);
  return { file, service: usesKeychain() ? keychainService(configDir, opts) : "" };
}
function removeLive(configDir, opts = {}) {
  let ok = true;
  try { if (fs.existsSync(filePath(configDir))) fs.unlinkSync(filePath(configDir)); } catch { ok = false; }
  if (usesKeychain()) keychainDelete(keychainService(configDir, opts));
  return ok;
}
/* Change stamp for the rotation watcher: Keychain content hash on macOS (no mtime there), else
 * the file's mtime. Falsy when there is no login. */
function liveStamp(configDir = homeDir(), opts = {}) {
  if (usesKeychain()) {
    const raw = keychainRead(keychainService(configDir, opts));
    if (raw) return "kc:" + crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
  }
  try { return fs.statSync(filePath(configDir)).mtimeMs || 0; } catch { return 0; }
}
/* The user's OWN terminal login: `claude login` run without CLAUDE_CONFIG_DIR → the default home
 * and (macOS) the unsuffixed Keychain service. */
function osLogin() { return readLive(defaultHome(), { isDefault: true }); }
// Human-readable location of a home's login, for Settings.
function describe(configDir = homeDir(), opts = {}) { return usesKeychain() ? `macOS Keychain · ${keychainService(configDir, opts)}` : filePath(configDir); }

module.exports = { ACCOUNT, FILE, usesKeychain, keychainService, filePath, readLive, writeLive, removeLive, liveStamp, osLogin, describe, homeDir, defaultHome };
