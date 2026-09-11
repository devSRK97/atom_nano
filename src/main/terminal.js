"use strict";
/* INTEGRATED TERMINAL — a real shell, rendered by AtomNano instead of by the OS.
 *
 * "Open Terminal here" launched Windows Terminal / an OS console: a separate
 * window, its own colours, its own font, and nothing the app can read back. That
 * is fine for ad-hoc work and useless for anything the app needs to observe —
 * installing a skill, watching a build, reading why a command failed.
 *
 * This keeps the shell inside the app: one child process per terminal, output
 * streamed to the renderer as it arrives, input written back on stdin.
 *
 * TWO BACKENDS, picked at runtime per terminal:
 *   - PTY (preferred): node-pty gives a real pseudo-terminal, so isatty() is
 *     true. Interactive prompts (npx installer menus with arrow-key selection),
 *     colours, progress bars, and full-screen curses UIs (vim, htop) all work,
 *     and Ctrl-C is a real SIGINT to the foreground process, not a kill.
 *   - PIPES (fallback): if node-pty can't load (native binary missing / ABI
 *     mismatch), we degrade to plain child_process pipes with TERM=dumb. Same as
 *     before: no TTY, no interactive menus, but installs / builds / git still
 *     work. The app never breaks just because the native module isn't present.
 *
 * The renderer decides how to draw a terminal from meta.pty: xterm.js grid when
 * true, the legacy line-oriented <pre> when false.
 */
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");

const MAX_BUFFER = 400_000;   // ~400KB of scrollback kept per terminal, server-side
const terms = new Map();      // id -> { id, pty|proc, cwd, shell, title, buf, exited, code }
let seq = 0;
let emit = () => {};

function configure(opts) { if (opts && typeof opts.emit === "function") emit = opts.emit; }

/* node-pty is a native module rebuilt per Electron version. Load it lazily and
 * tolerate its absence: whichever prebuilt/official variant is installed wins,
 * and if none load we fall back to pipes. Cached so we only probe once. */
let _ptyMod;
function loadPty() {
  if (_ptyMod !== undefined) return _ptyMod;
  // node-pty first: it's the variant `scripts/rebuild-pty.js` compiles against the
  // app's Electron ABI. The prebuilt-multiarch forks are fallbacks for platforms/
  // Electron versions where a matching prebuilt binary exists (no compiler needed).
  const candidates = [
    "node-pty",
    "@homebridge/node-pty-prebuilt-multiarch",
    "node-pty-prebuilt-multiarch",
  ];
  for (const name of candidates) {
    try {
      const mod = require(name);
      if (mod && typeof mod.spawn === "function") { _ptyMod = mod; return _ptyMod; }
    } catch { /* not installed / failed to load — try the next */ }
  }
  _ptyMod = null;
  console.warn("[terminal] node-pty unavailable — falling back to pipe mode (no interactive TTY). Run `npm install` and, if needed, `npx electron-rebuild -f`.");
  return _ptyMod;
}

/* Shell for the PTY backend. Under a pseudo-terminal the shell is interactive
 * on its own — no `/Q` echo-suppression, no `-Command -` piping tricks. */
function ptyShellFor() {
  // Windows: cmd.exe. macOS/Linux: the user's $SHELL (zsh on macOS) as a LOGIN interactive shell,
  // so the integrated terminal sees the same PATH (Homebrew, nvm, ~/.local/bin) as Terminal.app.
  const sh = require("./platform").defaultShell();
  return { command: sh.command, args: sh.args, name: path.basename(sh.command) };
}

/* Env for the PTY backend: advertise a colour terminal and clear the vars the
 * pipe backend used to force plain output. */
function ptyEnv() {
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  return env;
}

/* Shell for the PIPE fallback (no PTY).
 * Windows: cmd.exe reads commands from stdin and prints its own prompt, which is
 * exactly the loop we want. PowerShell needs `-Command -` for the same effect. */
function shellFor() {
  if (process.platform === "win32") {
    const comspec = process.env.COMSPEC || "cmd.exe";
    return { command: comspec, args: ["/Q"], name: path.basename(comspec) };
  }
  const sh = require("./platform").defaultShell();
  return { command: sh.command, args: sh.args, name: path.basename(sh.command) };
}

/* Knowing when ONE command finished.
 * The shell outlives everything it runs, so its exit says nothing about an
 * install that just completed. The portable signal is to ask the shell itself:
 * append an `echo <marker>_<exit-code>_` after the command, then filter that
 * marker back out of the stream so the renderer only ever sees real output. */
const MARK_PREFIX = "__ATOM_CMD__";
const MARK_RE = /__ATOM_CMD__(\d+)_(-?\d+)_\r?\n/g;
const MARK_DONE = /^__ATOM_CMD__\d+_-?\d+_\r?\n/;
let cmdSeq = 0;

// Where a marker starts arriving but hasn't finished — that tail is held back so
// it is never printed half now, half on the next read.
function partialMarkIndex(s) {
  const i = s.lastIndexOf(MARK_PREFIX);
  if (i >= 0 && !MARK_DONE.test(s.slice(i))) return i;
  for (let n = Math.min(MARK_PREFIX.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(MARK_PREFIX.slice(0, n))) return s.length - n;
  }
  return -1;
}

function push(t, chunk) {
  if (!chunk) return;
  let s = (t.pend || "") + String(chunk);
  t.pend = "";
  s = s.replace(MARK_RE, (_m, token, code) => {
    emit("terminal:command-exit", { id: t.id, token: MARK_PREFIX + token, code: Number(code) });
    return "";
  });
  const cut = partialMarkIndex(s);
  if (cut >= 0) { t.pend = s.slice(cut); s = s.slice(0, cut); }
  if (!s) return;
  t.buf += s;
  if (t.buf.length > MAX_BUFFER) t.buf = t.buf.slice(t.buf.length - MAX_BUFFER);
  emit("terminal:data", { id: t.id, chunk: s });
}

/* Create a terminal rooted at `cwd` (the project folder, so `npx …` resolves the
 * project's own binaries and installs land in the right place). Tries PTY first,
 * degrades to pipes if node-pty is unavailable or the spawn throws. */
function create({ cwd, title, cols, rows } = {}) {
  const id = "t" + (++seq) + "_" + Date.now().toString(36);
  const dir = cwd && require("fs").existsSync(cwd) ? cwd : os.homedir();
  const wantCols = Number(cols) > 0 ? Math.floor(cols) : 80;
  const wantRows = Number(rows) > 0 ? Math.floor(rows) : 24;
  const t = { id, pty: null, proc: null, cwd: dir, shell: "", title: title || "", buf: "", pend: "", exited: false, code: null, cols: wantCols, rows: wantRows };

  const ptyMod = loadPty();
  if (ptyMod) {
    try {
      const sh = ptyShellFor();
      const p = ptyMod.spawn(sh.command, sh.args, { name: "xterm-256color", cols: wantCols, rows: wantRows, cwd: dir, env: ptyEnv() });
      t.pty = p; t.shell = sh.name; t.title = t.title || sh.name;
      terms.set(id, t);
      p.onData((d) => push(t, String(d)));
      p.onExit(({ exitCode }) => {
        t.exited = true; t.code = exitCode;
        push(t, `\n[process exited with code ${exitCode}]\n`);
        emit("terminal:exit", { id, code: exitCode });
      });
      return meta(t);
    } catch (e) {
      // PTY loaded but couldn't spawn this terminal — fall through to pipes.
      console.warn(`[terminal] PTY spawn failed (${e.message}); using pipe fallback`);
      t.pty = null;
    }
  }

  // ---- Pipe fallback (no TTY) ----
  const sh = shellFor();
  let proc;
  try {
    proc = spawn(sh.command, sh.args, {
      cwd: dir,
      env: { ...process.env, TERM: "dumb", FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
    });
  } catch (e) {
    terms.delete(id);
    return { error: `cannot start ${sh.name}: ${e.message}` };
  }
  t.proc = proc; t.shell = sh.name; t.title = t.title || sh.name;
  terms.set(id, t);
  proc.stdout.on("data", (d) => push(t, d.toString()));
  proc.stderr.on("data", (d) => push(t, d.toString()));
  proc.on("error", (e) => push(t, `\n[${sh.name}: ${e.message}]\n`));
  proc.on("exit", (code) => {
    t.exited = true; t.code = code;
    push(t, `\n[process exited with code ${code}]\n`);
    emit("terminal:exit", { id, code });
  });
  return meta(t);
}

// A command typed by the user, or handed over by a feature (skill install).
function write(id, data) {
  const t = terms.get(id);
  if (!t || t.exited) return false;
  try {
    if (t.pty) t.pty.write(String(data ?? ""));
    else t.proc.stdin.write(String(data ?? ""));
    return true;
  } catch { return false; }
}

// Run one command line — the newline is what makes the shell execute it.
function run(id, command) { return write(id, String(command ?? "").replace(/\r?\n$/, "") + os.EOL); }

/* Same, but returns a token that `terminal:command-exit` will carry when this
 * command (not the shell) finishes. Both lines are written together; the shell
 * reads them one at a time, so the exit code is already set when the echo is
 * parsed. Returns null if the terminal is gone. */
function runTracked(id, command) {
  const t = terms.get(id);
  if (!t || t.exited) return null;
  const n = ++cmdSeq;
  const token = MARK_PREFIX + n;
  const echo = process.platform === "win32"
    ? `echo ${token}_%ERRORLEVEL%_`
    : `echo ${token}_$?_`;
  const ok = write(id, String(command ?? "").replace(/\r?\n$/, "") + os.EOL + echo + os.EOL);
  return ok ? token : null;
}

/* Resize the pseudo-terminal grid so full-screen programs lay out correctly.
 * No-op (but truthy) for the pipe fallback, which has no TTY to resize. */
function resize(id, cols, rows) {
  const t = terms.get(id);
  if (!t || t.exited) return false;
  const c = Number(cols) > 0 ? Math.floor(cols) : t.cols;
  const r = Number(rows) > 0 ? Math.floor(rows) : t.rows;
  t.cols = c; t.rows = r;
  if (!t.pty) return true;
  try { t.pty.resize(c, r); return true; } catch { return false; }
}

/* Stop whatever is running. With a PTY, ^C is a real SIGINT to the foreground
 * process group — the correct, cancellable interrupt. Without one there is no
 * controlling TTY, so the child tree is killed instead: on Windows via taskkill,
 * the only way to reach grandchildren (npm → node → the actual program). */
function interrupt(id) {
  const t = terms.get(id);
  if (!t || t.exited) return false;
  try {
    if (t.pty) { t.pty.write("\x03"); return true; }
    if (process.platform === "win32") require("./platform").killTree(t.proc.pid);
    else t.proc.kill("SIGINT");
    return true;
  } catch { return false; }
}

function clear(id) {
  const t = terms.get(id);
  if (!t) return false;
  t.buf = "";
  emit("terminal:cleared", { id });
  return true;
}

function kill(id) {
  const t = terms.get(id);
  if (!t) return false;
  try {
    if (t.pty) t.pty.kill();
    else if (process.platform === "win32" && !t.exited) require("./platform").killTree(t.proc.pid);
    else if (t.proc) t.proc.kill();
  } catch { /* already gone */ }
  terms.delete(id);
  emit("terminal:closed", { id });
  return true;
}

function killAll() { for (const id of [...terms.keys()]) kill(id); }

function meta(t) { return { id: t.id, cwd: t.cwd, shell: t.shell, title: t.title, exited: t.exited, code: t.code, pty: !!t.pty }; }
function list() { return [...terms.values()].map(meta); }
// The full scrollback, so a reopened panel shows what it missed.
function buffer(id) { const t = terms.get(id); return t ? t.buf : ""; }
function rename(id, title) { const t = terms.get(id); if (!t) return false; t.title = String(title || t.shell); emit("terminal:renamed", { id, title: t.title }); return true; }

module.exports = { configure, create, write, run, runTracked, resize, interrupt, clear, kill, killAll, list, buffer, rename };
