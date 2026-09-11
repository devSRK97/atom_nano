#!/usr/bin/env node
"use strict";
/* AtomNano CLI launcher.
 *
 * Runs the AtomNano app headlessly (inside Electron, so it shares the GUI's
 * settings / providers / custom endpoints / keys) and forwards your arguments.
 *
 *   node bin/atomnano.js run "explain this repo"
 *   node bin/atomnano.js run -P custom -m my-llm "hello"
 *   echo "hi" | node bin/atomnano.js run
 *
 * When installed (npm i -g / npm link) it's just:  atomnano run "..."
 */
const { spawn } = require("child_process");
const path = require("path");

const appRoot = path.join(__dirname, "..");
let electronExe;
try { electronExe = require("electron"); }            // the electron npm pkg exports the binary path
catch { electronExe = process.platform === "win32" ? "electron.cmd" : "electron"; }

function launch(stdinData) {
  const env = { ...process.env, ATOMNANO_CLI: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" };
  // Forward piped stdin via env — Electron doesn't reliably inherit a stdin pipe
  // across the launcher hop on Windows. (Plenty for prompts; env caps ~32KB.)
  if (stdinData) env.ATOMNANO_STDIN = stdinData.slice(0, 30000);
  const child = spawn(electronExe, [appRoot, ...process.argv.slice(2)], { stdio: ["ignore", "inherit", "inherit"], env });
  child.on("exit", (code, sig) => { if (sig) process.kill(process.pid, sig); else process.exit(code == null ? 1 : code); });
  child.on("error", (e) => { process.stderr.write("atomnano: failed to launch — " + e.message + "\n"); process.exit(1); });
}

// Read piped stdin in the launcher (Node handles this cleanly), then spawn.
if (process.stdin.isTTY) { launch(""); }
else {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { data += d; });
  process.stdin.on("end", () => launch(data));
  process.stdin.on("error", () => launch(data));
  process.stdin.resume();
  setTimeout(() => launch(data), 4000);   // safety: never block forever on a stray stdin
}
