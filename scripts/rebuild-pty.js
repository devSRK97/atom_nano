"use strict";
/* Build node-pty against the app's Electron ABI so the integrated terminal gets a
 * REAL pseudo-terminal — interactive installer menus (npx … with arrow-key
 * selection), colours, progress bars, and full-screen curses UIs. Runs on
 * `postinstall`; also available as `npm run rebuild:term`.
 *
 * Two Windows build snags are handled here so a plain `npm install` just works:
 *   1. winpty's projects request "Spectre-mitigated" VC++ libraries that most
 *      Visual Studio installs lack (build error MSB8040). The terminal doesn't
 *      need Spectre mitigation, so we turn that project flag off in node-pty's
 *      gyp files before building.
 *   2. winpty runs GetCommitHash.bat during configure; when the environment has
 *      NoDefaultCurrentDirectoryInExePath set, cmd.exe refuses to execute a .bat
 *      from the current directory ("not recognized"). We strip that variable for
 *      the rebuild only.
 *
 * This NEVER fails the install: if the C++ toolchain is missing, we log guidance
 * and exit 0. terminal.js then falls back to pipe mode (no interactive TTY) until
 * a rebuild succeeds — the app keeps working either way.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const ptyDir = path.join(root, "node_modules", "node-pty");

// Turn off winpty/conpty's Spectre-mitigation requirement (avoids MSB8040 on the
// common VS Build Tools install that ships without the Spectre libraries).
function disableSpectre() {
  if (process.platform !== "win32") return;
  const files = [
    path.join(ptyDir, "binding.gyp"),
    path.join(ptyDir, "deps", "winpty", "src", "winpty.gyp"),
  ];
  for (const f of files) {
    try {
      if (!fs.existsSync(f)) continue;
      const before = fs.readFileSync(f, "utf8");
      const after = before.replace(/'SpectreMitigation':\s*'Spectre'/g, "'SpectreMitigation': 'false'");
      if (after !== before) {
        fs.writeFileSync(f, after);
        console.log("[rebuild-pty] disabled Spectre requirement in " + path.basename(f));
      }
    } catch (e) {
      console.warn("[rebuild-pty] could not patch " + f + ": " + e.message);
    }
  }
}

// Every native add-on the app ships. node-pty (terminal) and better-sqlite3 (the
// Database Manager's SQLite driver) are both compiled against Node's ABI by npm
// and must be rebuilt for Electron's before they load in-app.
const NATIVE_MODULES = ["node-pty", "better-sqlite3"];

function main() {
  const present = NATIVE_MODULES.filter((m) => fs.existsSync(path.join(root, "node_modules", m)));
  if (!present.length) {
    console.warn("[rebuild-pty] no native modules installed — skipping.");
    return;
  }
  const cli = path.join(root, "node_modules", "@electron", "rebuild", "lib", "cli.js");
  if (!fs.existsSync(cli)) {
    console.warn("[rebuild-pty] @electron/rebuild not found — skipping (terminal uses pipe fallback; SQLite driver may not load).");
    return;
  }

  if (present.includes("node-pty")) disableSpectre();

  // Let cmd.exe execute winpty's GetCommitHash.bat from the source dir.
  const env = { ...process.env };
  delete env.NoDefaultCurrentDirectoryInExePath;

  console.log(`[rebuild-pty] building ${present.join(", ")} for the app's Electron ABI …`);
  const r = spawnSync(process.execPath, [cli, "-f", "-o", present.join(",")], {
    cwd: root, env, stdio: "inherit",
  });

  if (r.status === 0) {
    console.log("[rebuild-pty] node-pty ready — the integrated terminal has a full interactive TTY.");
  } else {
    console.warn(
      "[rebuild-pty] rebuild did not complete. The terminal will run in pipe mode\n" +
      "              (no interactive installer menus / curses UIs) until this succeeds.\n" +
      "              Fix: install \"Desktop development with C++\" (VS Build Tools) and rerun `npm run rebuild:term`."
    );
  }
}

try { main(); }
catch (e) { console.warn("[rebuild-pty] " + e.message + " — terminal uses pipe fallback."); }
