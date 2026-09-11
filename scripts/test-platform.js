"use strict";
/* Platform-layer regression suite (src/main/platform.js) — the ONE module that knows how Windows,
 * macOS and Linux differ. Each helper is exercised under every platform by stubbing
 * process.platform; child processes are stubbed (nothing is spawned, no terminal opens).
 * Run: node scripts/test-platform.js */
const path = require("path");
const os = require("os");
const cp = require("child_process");
const P = require("../src/main/platform");

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 600) : ""}`); } }
function on(platform, fn) {
  const d = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, "platform", d); }
}
const withEnv = (patch, fn) => { const saved = {}; for (const k of Object.keys(patch)) { saved[k] = process.env[k]; if (patch[k] == null) delete process.env[k]; else process.env[k] = patch[k]; } try { return fn(); } finally { for (const k of Object.keys(patch)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } } };

// P01 command lines through the shell
{ const w = on("win32", () => P.shellCommand("npm view x version")), m = on("darwin", () => P.shellCommand("npm view x version")), l = on("linux", () => P.shellCommand("codex --version"));
  check("P01", "shellCommand: cmd.exe /c on Windows, a LOGIN sh -lc elsewhere (PATH from the profile)", w.file === "cmd.exe" && w.args.join(" ") === "/c npm view x version" && m.file === "/bin/sh" && m.args[0] === "-lc" && m.args[1] === "npm view x version" && l.file === "/bin/sh", { w, m, l }); }
// P02 npm-shim CLIs
{ const w = on("win32", () => P.cliCommand("npm", ["i", "-g", "pkg@latest"])), m = on("darwin", () => P.cliCommand("npm", ["i", "-g", "pkg@latest"]));
  check("P02", "cliCommand: Windows shims run via cmd.exe /c, macOS spawns the binary directly (paths with spaces survive)", w.file === "cmd.exe" && w.args.join(" ") === "/c npm i -g pkg@latest" && m.file === "npm" && m.args.join(" ") === "i -g pkg@latest", { w, m }); }
// P03 the terminal's shell
{ const w = withEnv({ COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, () => on("win32", () => P.defaultShell()));
  const m = withEnv({ SHELL: null }, () => on("darwin", () => P.defaultShell()));
  const m2 = withEnv({ SHELL: "/opt/homebrew/bin/fish" }, () => on("darwin", () => P.defaultShell()));
  const l = withEnv({ SHELL: null }, () => on("linux", () => P.defaultShell()));
  check("P03", "defaultShell: cmd.exe on Windows; zsh as a login+interactive shell on macOS (user's $SHELL honoured); bash on Linux", w.command.endsWith("cmd.exe") && w.args.length === 0 && m.command === "/bin/zsh" && m.args.join(" ") === "-l -i" && m2.command === "/opt/homebrew/bin/fish" && l.command === "/bin/bash", { w, m, m2, l }); }
// P04 where the Claude CLI lives
{ const home = "/Users/dev";
  const m = on("darwin", () => P.claudeCandidates(home)), w = on("win32", () => P.claudeCandidates("C:\\Users\\dev"));
  check("P04", "claudeCandidates: the native ~/.local/bin install first on every platform, then Homebrew / npm-global / the CLI's own folder", m[0] === path.join(home, ".local", "bin", "claude") && m.includes("/opt/homebrew/bin/claude") && m.includes("/usr/local/bin/claude") && m.some((p) => p.endsWith(path.join(".claude", "local", "claude"))) && w[0].endsWith(path.join(".local", "bin", "claude.exe")) && w.every((p) => p.endsWith(".exe")), { m, w }); }
// P05 opening the user's terminal
{ const wDir = on("win32", () => P.terminalCommand({ cwd: "C:\\proj" })), wCmd = on("win32", () => P.terminalCommand({ command: '"C:\\p\\claude.exe" login', title: "AtomNano - Claude Login" }));
  const mDir = on("darwin", () => P.terminalCommand({ cwd: "/Users/dev/My Proj" })), mCmd = on("darwin", () => P.terminalCommand({ cwd: "/Users/dev/it's", command: "codex login" }));
  const lin = withEnv({ SHELL: "/bin/bash", PATH: os.tmpdir() }, () => on("linux", () => P.terminalCommand({ cwd: "/home/dev/p", command: "claude login" })));
  check("P05a", "Windows: Windows Terminal at the folder via start; a command opens cmd /k with a quoted title", wDir.file === "cmd.exe" && wDir.args.includes("wt.exe") && wDir.args.includes("C:\\proj") && wCmd.args[1] === 'start "AtomNano - Claude Login" cmd /k "C:\\p\\claude.exe" login' && wCmd.opts.shell === true, { wDir, wCmd });
  check("P05b", "macOS: Terminal.app via osascript — cd to the (shell-quoted) folder, run the command, activate", mDir.file === "osascript" && /tell application "Terminal" to do script/.test(mDir.args[1]) && mDir.args[1].includes("cd '/Users/dev/My Proj'") && mDir.args[3] === 'tell application "Terminal" to activate' && mCmd.args[1].includes("cd '/Users/dev/it'\\\\''s' && codex login") && mDir.opts.detached === true, { mDir: mDir.args, mCmd: mCmd.args });
  check("P05c", "Linux: a desktop terminal (fallback xterm) running bash -lc with the command, then an interactive shell", lin.file === "xterm" && lin.args[0] === "-e" && /claude login/.test(lin.args[1]) && /exec \/bin\/bash/.test(lin.args[1]), lin); }
// P06 killing a process tree (spawn / process.kill stubbed)
{ const spawns = []; const origSpawn = cp.spawn; cp.spawn = (f, a) => { spawns.push({ f, a }); return { on() { return this; } }; };
  const kills = []; const origKill = process.kill; process.kill = (pid, sig) => { kills.push([pid, sig]); if (pid < 0) throw new Error("ESRCH"); return true; };
  try {
    const w = on("win32", () => P.killTree(4242)), m = on("darwin", () => P.killTree(777, "SIGKILL")), none = on("darwin", () => P.killTree(0));
    check("P06", "killTree: taskkill /T /F on Windows; the process GROUP first, then the pid, on POSIX; no pid → false", w === true && spawns[0].f === "taskkill" && spawns[0].a.join(" ") === "/pid 4242 /T /F" && m === true && kills[0][0] === -777 && kills[0][1] === "SIGKILL" && kills[1][0] === 777 && none === false, { spawns, kills });
  } finally { cp.spawn = origSpawn; process.kill = origKill; } }
// P07 PATH merging for Finder-launched apps
{ const real = "./node_modules", bogus = "./definitely-missing-" + Date.now();   // colon-free paths that do / don't exist on the host
  const merged = on("darwin", () => P.mergePath("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin:/Users/dev/.local/bin", [real, bogus, real])).split(":");
  check("P07", "mergePath: login-shell PATH first, launchd PATH after, common tool dirs only when they exist, no duplicates", merged[0] === "/opt/homebrew/bin" && merged.indexOf("/usr/bin") === 1 && merged.includes("/bin") && merged.includes("/Users/dev/.local/bin") && merged.filter((p) => p === real).length === 1 && !merged.includes(bogus) && merged.filter((p) => p === "/usr/bin").length === 1, merged);
  const origExec = cp.execFileSync; let probed = false; cp.execFileSync = () => { probed = true; return ""; };
  try { const before = process.env.PATH; const w = on("win32", () => P.fixPath()); check("P07b", "fixPath is a no-op on Windows (no shell probe, PATH unchanged)", w === before && !probed && process.env.PATH === before, { probed }); }
  finally { cp.execFileSync = origExec; } }
// P08 window chrome
{ const m = on("darwin", () => P.windowChrome()), w = on("win32", () => P.windowChrome()), l = on("linux", () => P.windowChrome());
  check("P08", "windowChrome: macOS keeps native inset traffic lights (no frame:false); Windows/Linux are frameless with a hidden title bar", m.titleBarStyle === "hiddenInset" && m.frame === undefined && m.trafficLightPosition && m.trafficLightPosition.x > 0 && w.frame === false && w.titleBarStyle === "hidden" && l.frame === false, { m, w, l }); }
// P09 which
{ check("P09", "whichCommand: where on Windows, which elsewhere", on("win32", () => P.whichCommand()) === "where" && on("darwin", () => P.whichCommand()) === "which" && on("linux", () => P.whichCommand()) === "which");
  const origExec = cp.execFile; cp.execFile = (f, a, o, cb) => { cb(null, f === "where" ? "C:\\x\\claude.exe\r\nC:\\y\\claude.cmd\r\n" : "/opt/homebrew/bin/claude\n"); };
  try {
    Promise.all([on("win32", () => P.which("claude")), on("darwin", () => P.which("claude"))]).then(([w, m]) => {
      check("P09b", "which() returns the first hit per platform", w === "C:\\x\\claude.exe" && m === "/opt/homebrew/bin/claude", { w, m });
      cp.execFile = origExec;
      finish();
    });
  } catch (e) { cp.execFile = origExec; check("P09b", "which() resolves", false, String(e)); finish(); } }

function finish() {
  console.log(`Platform: ${pass} passed, ${failN} failed`);
  if (failures.length) console.log("Failures:\n  " + failures.join("\n  "));
  process.exit(failN ? 1 : 0);
}
