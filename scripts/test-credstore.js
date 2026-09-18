"use strict";
/* Credential-store regression suite — where the Claude login lives per platform (credstore.js)
 * and that the profile code (profiles.js) and the login import (auth.js) go through it.
 * macOS is emulated: process.platform is stubbed to "darwin" and the `security` CLI is replaced
 * by an in-memory Keychain, so nothing on this machine is touched. Temp Claude homes only.
 * Run: node scripts/test-credstore.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");
const Module = require("module");

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 700) : ""}`); } }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-credstore-"));
const APP_HOME = path.join(ROOT, "app-claude"), OS_HOME = path.join(ROOT, "home", ".claude");
fs.mkdirSync(APP_HOME, { recursive: true }); fs.mkdirSync(OS_HOME, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = APP_HOME;
process.env.CODEX_HOME = path.join(ROOT, "codex");
// os.homedir() → our temp home (so the "OS login" is ~/.claude under ROOT)
const realHomedir = os.homedir; os.homedir = () => path.join(ROOT, "home");
// electron is not available in plain Node: store.js (pulled in by auth.js) asks it for userData
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === "electron") return { app: { getPath: () => path.join(ROOT, "userData"), getAppPath: () => path.join(__dirname, ".."), isPackaged: false } }; return origLoad.call(this, req, ...rest); };

/* ---- in-memory Keychain standing in for /usr/bin/security ---- */
const keychain = new Map(); const secCalls = [];
const realExec = cp.execFileSync;
cp.execFileSync = function (file, args, opts) {
  if (file !== "security") return realExec.call(cp, file, args, opts);
  secCalls.push(args.slice(0, 2).join(" "));
  const a = args || [];
  if (a[0] === "find-generic-password") { const svc = a[a.indexOf("-s") + 1], acct = a[a.indexOf("-a") + 1]; const v = keychain.get(acct + "|" + svc); if (v == null) { const e = new Error("The specified item could not be found in the keychain."); e.status = 44; throw e; } return v + "\n"; }
  if (a[0] === "-i") { const m = /add-generic-password -U -a "([^"]+)" -s "([^"]+)" -X "([0-9a-f]*)"/.exec(String(opts && opts.input)); if (!m) throw new Error("bad security -i input: " + (opts && opts.input)); keychain.set(m[1] + "|" + m[2], Buffer.from(m[3], "hex").toString("utf8")); return ""; }
  if (a[0] === "delete-generic-password") { const svc = a[a.indexOf("-s") + 1], acct = a[a.indexOf("-a") + 1]; if (!keychain.delete(acct + "|" + svc)) { const e = new Error("not found"); e.status = 44; throw e; } return ""; }
  throw new Error("unexpected security call " + a.join(" "));
};
function on(platform, fn) { const d = Object.getOwnPropertyDescriptor(process, "platform"); Object.defineProperty(process, "platform", { value: platform, configurable: true }); try { return fn(); } finally { Object.defineProperty(process, "platform", d); } }

const C = require("../src/main/auth/credstore");
const creds = (tag, extra = {}) => ({ claudeAiOauth: { accessToken: "at-" + tag, refreshToken: "rt-" + tag, expiresAt: extra.expiresAt || Date.now() + 3600e3, scopes: ["user:inference"], subscriptionType: extra.sub || "max", ...(extra.email ? { email: extra.email } : {}), ...(extra.id ? { accountUuid: extra.id } : {}) } });
const hash8 = (s) => crypto.createHash("sha256").update(String(s).normalize("NFC")).digest("hex").slice(0, 8);

(async () => {
  // C01 service / account naming — exactly what Claude Code 2.1.263 uses
  check("C01", "Keychain names: account claude-code-user; default home → 'Claude Code-credentials'; custom home → '-<8 hex of sha256(dir)>'", C.ACCOUNT === "claude-code-user" && C.keychainService(APP_HOME, { isDefault: true }) === "Claude Code-credentials" && C.keychainService(APP_HOME) === "Claude Code-credentials-" + hash8(APP_HOME) && C.keychainService("/Users/x/dir") !== C.keychainService("/Users/x/other"), { svc: C.keychainService(APP_HOME) });

  // C02 macOS: the terminal login sits in the DEFAULT Keychain entry — osLogin() finds it, the app home is still empty
  on("darwin", () => {
    keychain.set(`${C.ACCOUNT}|Claude Code-credentials`, JSON.stringify(creds("term", { sub: "pro" })));
    const osl = C.osLogin(), app = C.readLive(APP_HOME);
    check("C02", "macOS: osLogin() reads the terminal's default Keychain entry; the app home (hashed entry, no file) has no login", osl.source === "keychain" && osl.json.claudeAiOauth.accessToken === "at-term" && app.json === null && app.source === null, { osl: osl.source, app });
  });
  // C03 macOS: writeLive installs Keychain entry + 0600 file; readLive prefers the Keychain; removeLive clears both
  on("darwin", () => {
    C.writeLive(APP_HOME, creds("app"));
    const kc = keychain.get(`${C.ACCOUNT}|${C.keychainService(APP_HOME)}`), file = fs.existsSync(C.filePath(APP_HOME));
    const rl = C.readLive(APP_HOME);
    const stamp1 = C.liveStamp(APP_HOME);
    keychain.set(`${C.ACCOUNT}|${C.keychainService(APP_HOME)}`, JSON.stringify(creds("app-rotated")));   // the CLI refreshed its tokens in the Keychain
    const rl2 = C.readLive(APP_HOME), stamp2 = C.liveStamp(APP_HOME);
    const removed = C.removeLive(APP_HOME);
    check("C03", "macOS: writeLive → Keychain entry + file; readLive prefers the Keychain (sees the CLI's rotation the file missed); liveStamp changes; removeLive clears both", !!kc && JSON.parse(kc).claudeAiOauth.accessToken === "at-app" && file && rl.source === "keychain" && rl2.json.claudeAiOauth.accessToken === "at-app-rotated" && String(stamp1).startsWith("kc:") && stamp1 !== stamp2 && removed && !fs.existsSync(C.filePath(APP_HOME)) && !keychain.has(`${C.ACCOUNT}|${C.keychainService(APP_HOME)}`), { kc: !!kc, file, src: rl.source, rl2: rl2.json && rl2.json.claudeAiOauth.accessToken, stamp1, stamp2, removed });
  });
  // C04 macOS: an app home with only the plaintext fallback file is still read
  on("darwin", () => {
    fs.writeFileSync(C.filePath(APP_HOME), JSON.stringify(creds("filefallback")));
    const rl = C.readLive(APP_HOME);
    fs.unlinkSync(C.filePath(APP_HOME));
    check("C04", "macOS: with no Keychain entry the CLI's plaintext fallback file is read (source 'file', mtime known)", rl.source === "file" && rl.json.claudeAiOauth.accessToken === "at-filefallback" && rl.mtime > 0, { src: rl.source, mtime: rl.mtime });
  });
  // C05 Windows / Linux: files only, security never called
  on("win32", () => {
    const before = secCalls.length;
    C.writeLive(APP_HOME, creds("win"));
    const rl = C.readLive(APP_HOME), st = C.liveStamp(APP_HOME), desc = C.describe(APP_HOME);
    C.removeLive(APP_HOME);
    check("C05", "Windows/Linux: the file is the store — written, read, stamped by mtime, described by path; `security` is never invoked", rl.source === "file" && typeof st === "number" && st > 0 && desc === C.filePath(APP_HOME) && secCalls.length === before && !fs.existsSync(C.filePath(APP_HOME)), { src: rl.source, st, desc, calls: secCalls.length - before });
  });

  // ---- profiles.js + auth.js on the emulated Mac ----
  const profiles = require("../src/main/auth/profiles");
  const auth = require("../src/main/auth/cli-auth");
  on("darwin", () => {
    keychain.clear(); for (const f of fs.readdirSync(APP_HOME)) fs.rmSync(path.join(APP_HOME, f), { recursive: true, force: true });
    // the user logged in from Terminal.app → default Keychain entry only
    keychain.set(`${C.ACCOUNT}|Claude Code-credentials`, JSON.stringify(creds("terminal", { email: "dev@example.com", id: "acc-1" })));
    const before = profiles.liveInfo("anthropic");
    const imported = auth.__syncFromOsLogin();
    const after = profiles.liveInfo("anthropic");
    const saved = profiles.saveCurrent("anthropic", "");
    const list = profiles.list("anthropic");
    check("C06", "\"Save current login\" on macOS: the Terminal login is found in the Keychain, imported into the app home (its own Keychain entry + file) and saved as a profile", before.loggedIn === false && imported === true && after.loggedIn === true && after.email === "dev@example.com" && saved.ok && saved.label === "dev@example.com" && list.length === 1 && list[0].active && keychain.has(`${C.ACCOUNT}|${C.keychainService(APP_HOME)}`) && fs.existsSync(C.filePath(APP_HOME)), { before, imported, after, saved, list, entries: [...keychain.keys()] });
    // a second import of the SAME (unchanged) login is a no-op; a rotated terminal login of the same account is pulled in
    const again = auth.__syncFromOsLogin();
    keychain.set(`${C.ACCOUNT}|Claude Code-credentials`, JSON.stringify(creds("terminal-rotated", { email: "dev@example.com", id: "acc-1", expiresAt: Date.now() + 7200e3 })));
    const rotated = auth.__syncFromOsLogin();
    const live = C.readLive(APP_HOME);
    check("C07", "same account: an unchanged terminal login is not re-imported; a refreshed one (later expiry) is", again === false && rotated === true && live.json.claudeAiOauth.accessToken === "at-terminal-rotated", { again, rotated, tok: live.json && live.json.claudeAiOauth.accessToken });
    // a DIFFERENT account in the terminal never clobbers the account chosen in the app
    keychain.set(`${C.ACCOUNT}|Claude Code-credentials`, JSON.stringify(creds("other", { email: "other@example.com", id: "acc-2", expiresAt: Date.now() + 9000e3 })));
    const clobber = auth.__syncFromOsLogin();
    check("C08", "a different account logged in from the terminal is NOT imported over the app's account", clobber === false && C.readLive(APP_HOME).json.claudeAiOauth.accessToken === "at-terminal-rotated", { clobber });
    // switching profiles writes the Keychain entry the CLI reads; logout removes it
    const alt = creds("alt", { email: "alt@example.com", id: "acc-9" });
    fs.writeFileSync(path.join(APP_HOME, "profiles", "alt@example.com.json"), JSON.stringify(alt));
    const sw = profiles.switchTo("anthropic", "alt@example.com");
    const kc = keychain.get(`${C.ACCOUNT}|${C.keychainService(APP_HOME)}`);
    const out = profiles.logout("anthropic");
    check("C09", "switchTo installs the profile into the app's Keychain entry (+ file); logout removes both", sw.ok && kc && JSON.parse(kc).claudeAiOauth.accessToken === "at-alt" && out.ok && !keychain.has(`${C.ACCOUNT}|${C.keychainService(APP_HOME)}`) && !fs.existsSync(C.filePath(APP_HOME)) && profiles.liveInfo("anthropic").loggedIn === false, { sw, out, entries: [...keychain.keys()] });
    // Settings shows where the login lives
    keychain.set(`${C.ACCOUNT}|${C.keychainService(APP_HOME)}`, JSON.stringify(creds("x")));
    const info = auth.__credentialsInfo();
    check("C10", "Settings describes a Keychain login by its service, never as a missing file", info.exists && info.source === "keychain" && /macOS Keychain · Claude Code-credentials-/.test(info.credPath), info);
  });

  cp.execFileSync = realExec; os.homedir = realHomedir; Module._load = origLoad;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(`Credential store: ${pass} passed, ${failN} failed`);
  if (failures.length) console.log("Failures:\n  " + failures.join("\n  "));
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
