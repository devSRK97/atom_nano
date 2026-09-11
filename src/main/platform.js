"use strict";
/* Host-platform helpers — the ONE place that knows how Windows, macOS and Linux differ for what
 * AtomNano does with the OS: running a command line through the user's shell, locating a CLI,
 * opening a terminal at a folder or with a command (CLI logins), killing a process tree, the
 * frameless-window chrome, and the PATH a Finder-launched app is missing on macOS.
 * Every helper reads process.platform at CALL time so the behaviour is testable per platform. */
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const plat = () => process.platform;
const isWin = () => plat() === "win32";
const isMac = () => plat() === "darwin";
const pathDelim = () => (isWin() ? ";" : ":");   // follows the (possibly stubbed) platform, not the host's path module

/* A command LINE run through the user's shell (npm view …, codex --version …). Windows: cmd.exe;
 * elsewhere a login shell so PATH additions from ~/.zprofile / ~/.bash_profile are honoured. */
function shellCommand(line) {
  return isWin() ? { file: "cmd.exe", args: ["/c", line] } : { file: "/bin/sh", args: ["-lc", line] };
}
/* A CLI that is an npm shim on Windows (codex.cmd, claude.cmd, npm.cmd) needs cmd.exe to run;
 * on macOS/Linux the binary is spawned directly (no shell, so paths with spaces survive). */
function cliCommand(bin, args = []) {
  return isWin() ? { file: "cmd.exe", args: ["/c", bin, ...args] } : { file: bin, args: [...args] };
}
function whichCommand() { return isWin() ? "where" : "which"; }
// First PATH hit for a program name, "" when absent. Never throws.
function which(bin, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      cp.execFile(whichCommand(), [bin], { timeout, windowsHide: true }, (err, out) => {
        if (err) return resolve("");
        resolve((String(out || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]) || "");
      });
    } catch { resolve(""); }
  });
}

/* The user's interactive shell for the integrated terminal. macOS has shipped zsh as the default
 * since Catalina; the login flag makes the terminal see the same PATH as Terminal.app. */
function defaultShell() {
  if (isWin()) return { command: process.env.COMSPEC || "cmd.exe", args: [], login: false };
  const sh = process.env.SHELL || (isMac() ? "/bin/zsh" : "/bin/bash");
  return { command: sh, args: ["-l", "-i"], login: true };
}

/* Where the Claude CLI is installed, most likely first. The native installer puts it in
 * ~/.local/bin on every platform; Homebrew / npm-global / the CLI's own migration folder follow. */
function claudeCandidates(home = os.homedir()) {
  if (isWin()) return [path.join(home, ".local", "bin", "claude.exe"), path.join(home, "AppData", "Local", "Programs", "claude", "claude.exe")];
  return [
    path.join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
    path.join(home, ".claude", "local", "claude"),
    path.join(home, ".npm-global", "bin", "claude"), path.join(home, ".volta", "bin", "claude"),
  ];
}

/* Kill a process AND everything it started. Windows needs taskkill /T (child.kill only reaches
 * the parent); POSIX kills the process group when the child leads one, else the process. */
function killTree(pid, signal = "SIGTERM") {
  if (!pid) return false;
  try {
    if (isWin()) { cp.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {}); return true; }
    try { process.kill(-pid, signal); } catch { process.kill(pid, signal); }
    return true;
  } catch { return false; }
}

/* The command that opens the user's terminal — at `cwd`, optionally running `command` in it
 * (CLI login flows stay in the user's own terminal). Pure: returns { file, args, opts }. */
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const appleQ = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
function terminalCommand({ cwd, command, title } = {}) {
  const dir = cwd || os.homedir();
  if (isWin()) {
    // `start` needs the (quoted) title as its first argument; wt.exe is resolved via start so the WindowsApps alias works.
    if (command) return { file: "cmd.exe", args: ["/c", `start "${title || "AtomNano"}" cmd /k ${command}`], opts: { detached: true, stdio: "ignore", windowsHide: false, shell: true } };
    return { file: "cmd.exe", args: ["/c", "start", "", "wt.exe", "-d", dir], opts: { detached: true, stdio: "ignore", windowsHide: true } };
  }
  if (isMac()) {
    const line = `cd ${shq(dir)}${command ? " && " + command : ""}`;
    return { file: "osascript", args: ["-e", `tell application "Terminal" to do script "${appleQ(line)}"`, "-e", 'tell application "Terminal" to activate'], opts: { detached: true, stdio: "ignore" } };
  }
  const line = `cd ${shq(dir)}${command ? " && " + command : ""}; exec ${process.env.SHELL || "bash"}`;
  const term = ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"].find((t) => onPath(t)) || "xterm";
  const args = term === "gnome-terminal" ? ["--working-directory=" + dir, "--", "bash", "-lc", line] : ["-e", `bash -lc ${shq(line)}`];
  return { file: term, args, opts: { detached: true, stdio: "ignore" } };
}
function openTerminal(spec) {
  const c = terminalCommand(spec);
  const child = cp.spawn(c.file, c.args, c.opts);
  child.on("error", () => {});
  child.unref();
  return true;
}
function onPath(cmd) {
  const exts = isWin() ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of (process.env.PATH || "").split(pathDelim())) for (const e of exts) { try { if (dir && fs.existsSync(path.join(dir, cmd + e))) return path.join(dir, cmd + e); } catch { /* */ } }
  return "";
}

/* macOS (and Linux desktops): an app launched from Finder / the Dock inherits launchd's minimal
 * PATH (/usr/bin:/bin:/usr/sbin:/sbin) — Homebrew, ~/.local/bin, nvm/volta and npm-global tools
 * (claude, codex, git, node, npm) are invisible. Merge the login shell's PATH and the usual tool
 * folders once at startup. Pure part (mergePath) is unit-tested; fixPath does the shell probe. */
const COMMON_TOOL_DIRS = (home) => [
  path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
  path.join(home, ".npm-global", "bin"), path.join(home, ".volta", "bin"), path.join(home, ".cargo", "bin"),
  path.join(home, ".claude", "local"),
];
function mergePath(current, loginPath, extraDirs = []) {
  const seen = new Set(), out = [];
  const add = (p) => { const s = String(p || "").trim(); if (!s || seen.has(s)) return; seen.add(s); out.push(s); };
  for (const p of String(loginPath || "").split(pathDelim())) add(p);
  for (const p of String(current || "").split(pathDelim())) add(p);
  for (const d of extraDirs) { try { if (fs.existsSync(d)) add(d); } catch { /* */ } }
  return out.join(pathDelim());
}
let pathFixed = false;
function fixPath() {
  if (pathFixed || isWin()) return process.env.PATH || "";
  pathFixed = true;
  let login = "";
  try {
    const sh = process.env.SHELL || (isMac() ? "/bin/zsh" : "/bin/bash");
    login = cp.execFileSync(sh, ["-ilc", 'echo -n "$PATH"'], { timeout: 4000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { /* no login shell — the common folders below still apply */ }
  process.env.PATH = mergePath(process.env.PATH, login, COMMON_TOOL_DIRS(os.homedir()));
  return process.env.PATH;
}

/* Frameless-window chrome. Windows/Linux draw their own title bar with min/max/close buttons;
 * macOS keeps the native traffic lights inset into our title bar (the renderer hides its buttons). */
function windowChrome() {
  return isMac() ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 13 } } : { frame: false, titleBarStyle: "hidden" };
}

module.exports = { isWin, isMac, shellCommand, cliCommand, which, whichCommand, defaultShell, claudeCandidates, killTree, terminalCommand, openTerminal, onPath, mergePath, fixPath, windowChrome, COMMON_TOOL_DIRS };
