/* AtomNano renderer — Integrated terminal — themed shell panel docked at the bottom.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { $, h, toast } from "../core/dom.js";
import { activeTS, atom, state } from "../core/state.js";
import { esc } from "../git/titlebar.js";
import { icon } from "../icons.js";

/* ============================================================
   INTEGRATED TERMINAL — a themed shell panel docked at the bottom.
   "Open Terminal here" hands you off to the OS console: another window, its own
   colours, and output the app can never see. This keeps the shell in the app, so
   an installer or a build is something you watch in place.
   Each tab is one child process (main/terminal.js). Per tab: interrupt, clear,
   close. Output is appended as it streams; scroll sticks to the bottom unless
   you have scrolled up to read something.
   ============================================================ */
export const _term = { open: false, tabs: [], active: null, panes: new Map(), wired: false };
// The shell writes ANSI even with TERM=dumb (git, npm). Strip it rather than
// half-render it — colour is not worth an escape-sequence parser here.
export function stripAnsi(s) { return String(s).replace(/\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\][^]*(|\\)/g, ""); }
/* A terminal gets one of two panes, chosen from its backend (meta.pty):
 *   - xterm.js grid, when the backend is a real PTY and the xterm bundle is
 *     present. A full terminal emulator: renders ANSI/colour/cursor, and every
 *     keystroke (arrows, Tab, Ctrl-C) is forwarded to the PTY, so npx installer
 *     menus and curses UIs work.
 *   - legacy <pre> + one input line, when there is no PTY (pipe fallback) or the
 *     xterm bundle wasn't built. You type a whole line and press Enter. */
export function termIsXterm(id) {
  const m = _term.tabs.find((t) => t.id === id);
  return !!(window.Terminal && m && m.pty);
}
// Real terminal emulator. Nothing is echoed locally — the PTY echoes input, so
// what you type appears because the shell sent it back.
export function makeXtermPane(id) {
  const host = h("div", { class: "term-xterm", dataset: { id } });
  const term = new window.Terminal({
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    fontFamily: "var(--font-mono), Consolas, 'Cascadia Mono', monospace",
    fontSize: 13,
    theme: { background: "#0b0d12", foreground: "#d6d9df", cursor: "#f0b000", cursorAccent: "#0b0d12" },
  });
  const fit = window.FitAddon ? new window.FitAddon() : null;
  if (fit) term.loadAddon(fit);
  term.open(host);
  try { fit && fit.fit(); } catch { /* not laid out yet — ResizeObserver will */ }
  // Keystrokes → PTY stdin.
  term.onData((d) => atom.terminal.write(id, d));
  // When the grid changes size, tell the PTY so wrapping / full-screen apps fit.
  term.onResize(({ cols, rows }) => atom.terminal.resize(id, cols, rows));
  // Refit as the dock / window resizes and when the tab is (re)shown.
  const ro = new ResizeObserver(() => { try { fit && fit.fit(); } catch { /* hidden */ } });
  ro.observe(host);
  return { el: host, term, fit, ro, mode: "xterm" };
}
export function termPane(id) {
  let pane = _term.panes.get(id);
  if (pane) return pane;
  if (termIsXterm(id)) {
    pane = makeXtermPane(id);
    _term.panes.set(id, pane);
    return pane;
  }
  // Legacy line pane: a <pre> of transcript with the caret living INSIDE it, as
  // the last child, so you type right after the prompt the shell printed. Each
  // pane keeps its own half-typed line and history across tab switches.
  const input = h("input", { class: "term-input", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-label": "Terminal input" });
  const el = h("pre", { class: "term-out", dataset: { id } });
  el.append(input);
  el.addEventListener("mousedown", (e) => {
    if (e.target === input) return;
    setTimeout(() => { if (!String(window.getSelection())) input.focus(); }, 0);
  });
  pane = { el, input, history: [], hix: 0, mode: "legacy" };
  _term.panes.set(id, pane);
  wireTermInput(id, pane);
  return pane;
}
// Route one chunk of shell output to its pane: xterm renders raw ANSI, the
// legacy pane strips it.
export function termWrite(id, chunk) {
  const pane = termPane(id);
  if (pane.mode === "xterm") pane.term.write(chunk);
  else termAppend(id, chunk);
}
export function termAppend(id, chunk) {
  const pane = termPane(id);
  const el = pane.el;
  // "Stuck to the bottom" unless the user scrolled up — the usual terminal rule.
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  el.insertBefore(document.createTextNode(stripAnsi(chunk)), pane.input);
  // Cap the DOM: 4000 lines is far more scrollback than anyone reads, and an
  // unbounded <pre> makes a long `npm install` crawl. Only the transcript is
  // rebuilt — the caret is a sibling and has to survive it.
  if (el.childNodes.length > 900) {
    const text = el.textContent.split("\n").slice(-4000).join("\n");
    while (el.firstChild && el.firstChild !== pane.input) el.removeChild(el.firstChild);
    el.insertBefore(document.createTextNode(text), pane.input);
  }
  if (stick) el.scrollTop = el.scrollHeight;
}
/* The caret sizes itself to what you've typed. In a monospace <pre> a `ch` is
 * exactly one column, so the cursor lands where the next character will. */
export function termGrow(input) { input.style.width = Math.max(1, input.value.length + 1) + "ch"; }
export function wireTermInput(id, pane) {
  const input = pane.input;
  input.addEventListener("input", () => termGrow(input));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = input.value;
      input.value = ""; termGrow(input);
      if (cmd.trim()) { pane.history.push(cmd); if (pane.history.length > 200) pane.history.shift(); }
      pane.hix = pane.history.length;
      // No TTY means the shell never echoes what we sent, so the transcript would
      // read as answers with no questions. Write the line where it was typed.
      termAppend(id, cmd + "\n");
      atom.terminal.run(id, cmd);
      return;
    }
    // Ctrl+C is a copy when there's a selection and an interrupt when there isn't
    // — the same rule every terminal uses.
    if (e.key === "c" && (e.ctrlKey || e.metaKey) && !String(window.getSelection())) {
      e.preventDefault(); atom.terminal.interrupt(id); termAppend(id, "^C\n"); return;
    }
    if (e.key === "l" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); clearTerm(id); return; }
    // Command history, the one terminal affordance nobody forgives its absence.
    if (e.key === "ArrowUp") { e.preventDefault(); if (pane.hix > 0) { pane.hix--; input.value = pane.history[pane.hix] || ""; termGrow(input); } return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (pane.hix < pane.history.length - 1) { pane.hix++; input.value = pane.history[pane.hix] || ""; }
      else { pane.hix = pane.history.length; input.value = ""; }
      termGrow(input);
    }
  });
  termGrow(input);
}
export function renderTermTabs() {
  const strip = $("termTabs"); if (!strip) return;
  strip.innerHTML = "";
  for (const t of _term.tabs) {
    const active = t.id === _term.active;
    const tab = h("div", { class: "term-tab" + (active ? " active" : "") + (t.exited ? " exited" : ""), title: `${t.shell} — ${t.cwd}`,
      onclick: () => setActiveTerm(t.id) },
      h("span", { html: icon("terminal", 12) }),
      h("span", { class: "term-tab-name", text: t.title || t.shell }),
      h("button", { class: "term-tab-x", html: icon("close", 11), title: "Close terminal", onclick: (e) => { e.stopPropagation(); closeTerm(t.id); } }));
    strip.append(tab);
  }
  strip.append(h("button", { class: "term-new", html: icon("plus", 13), title: "New terminal", onclick: () => newTerm() }));
}
export function setActiveTerm(id) {
  _term.active = id;
  const body = $("termBody"); if (!body) return;
  body.innerHTML = "";
  renderTermTabs();
  if (!id) return;
  const pane = termPane(id);
  body.append(pane.el);
  if (pane.mode === "xterm") {
    // Re-attaching detached it from layout; fit to the panel and focus the grid.
    try { pane.fit && pane.fit.fit(); } catch { /* not visible yet */ }
    pane.term.focus();
  } else {
    pane.el.scrollTop = pane.el.scrollHeight;
    pane.input.focus();
  }
}
export async function newTerm(opts = {}) {
  const ts = activeTS();
  const cwd = opts.cwd || (ts && ts.meta.cwd) || state.project;
  const meta = await atom.terminal.create({ cwd, title: opts.title });
  if (!meta || meta.error) { toast("Terminal failed: " + esc((meta && meta.error) || "unknown"), "alert", { ms: 6000 }); return null; }
  _term.tabs.push(meta);
  setActiveTerm(meta.id);
  return meta;
}
// Tear an xterm pane down so its ResizeObserver and render loop don't leak.
export function disposeTermPane(pane) {
  if (pane && pane.mode === "xterm") {
    try { pane.ro.disconnect(); } catch { /* gone */ }
    try { pane.term.dispose(); } catch { /* gone */ }
  }
}
export async function closeTerm(id) {
  try { await atom.terminal.kill(id); } catch { /* already gone */ }
  disposeTermPane(_term.panes.get(id));
  _term.tabs = _term.tabs.filter((t) => t.id !== id);
  _term.panes.delete(id);
  if (_term.active === id) setActiveTerm(_term.tabs.length ? _term.tabs[_term.tabs.length - 1].id : null);
  else renderTermTabs();
}
export async function clearTerm(id) {
  if (!id) return;
  await atom.terminal.clear(id).catch(() => {});
  const pane = _term.panes.get(id);
  if (!pane) return;
  if (pane.mode === "xterm") { pane.term.clear(); pane.term.focus(); return; }
  while (pane.el.firstChild && pane.el.firstChild !== pane.input) pane.el.removeChild(pane.el.firstChild);
  pane.input.focus();
}
export function buildTerminalDock() {
  if ($("termDock")) return $("termDock");
  const out = h("div", { class: "term-body", id: "termBody" });

  const dock = h("div", { class: "term-dock hidden", id: "termDock" },
    h("div", { class: "term-resizer", id: "termResizer", title: "Drag to resize" }),
    h("div", { class: "term-head" },
      h("div", { class: "term-tabs", id: "termTabs" }),
      h("div", { class: "term-actions" },
        h("button", { class: "term-act", html: icon("stop", 13), title: "Interrupt (Ctrl+C)", onclick: () => { atom.terminal.interrupt(_term.active); if (!termIsXterm(_term.active)) termAppend(_term.active, "^C\n"); } }),
        h("button", { class: "term-act", html: icon("refresh", 13), title: "Clear", onclick: () => clearTerm(_term.active) }),
        h("button", { class: "term-act", html: icon("trash", 13), title: "Delete this terminal", onclick: () => closeTerm(_term.active) }),
        h("button", { class: "term-act", html: icon("close", 13), title: "Hide panel (Ctrl+`)", onclick: () => toggleTerminal(false) }))),
    out);
  document.body.append(dock);

  // Drag the top edge to resize.
  let dragging = false;
  dock.querySelector("#termResizer").addEventListener("mousedown", (e) => { dragging = true; e.preventDefault(); document.body.style.cursor = "ns-resize"; });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const px = Math.max(140, Math.min(window.innerHeight - 120, window.innerHeight - e.clientY));
    dock.style.height = px + "px";
  });
  window.addEventListener("mouseup", () => { if (dragging) { dragging = false; document.body.style.cursor = ""; } });
  return dock;
}
export async function toggleTerminal(force) {
  const dock = buildTerminalDock();
  const open = force === undefined ? !_term.open : !!force;
  _term.open = open;
  dock.classList.toggle("hidden", !open);
  const btn = $("terminalBtn"); if (btn) btn.classList.toggle("active", open);
  if (open) {
    if (!_term.tabs.length) await newTerm();
    else setActiveTerm(_term.active || _term.tabs[0].id);
  }
}
/* Resolve once the new shell has written something (its banner + prompt), or
 * give up after a moment — a shell that says nothing is not worth stalling on. */
export function termFirstPrompt(id, ms = 1500) {
  const pane = _term.panes.get(id);
  if (pane && pane.el.textContent) return Promise.resolve();
  return new Promise((resolve) => {
    let off = null;
    const finish = () => { if (off) { off(); off = null; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(finish, ms);
    off = atom.events.onTerminalData(({ id: tid }) => { if (tid === id) setTimeout(finish, 60); });
  });
}
/* Run a command in a terminal at project scope and surface it — the entry point
 * features use (e.g. the Workflow Studio running an installer) rather than making
 * the user retype a command. */
export async function runInTerminal(command, opts = {}) {
  await toggleTerminal(true);
  const meta = await newTerm({ cwd: opts.cwd, title: opts.title });
  if (!meta) return null;
  // Let the shell print its banner and first prompt before echoing the command,
  // so it reads as a line typed at that prompt rather than one that arrived
  // before the shell had started.
  await termFirstPrompt(meta.id);
  // The legacy pane has no TTY echo, so we print the line ourselves; an xterm/PTY
  // terminal echoes what we write, so printing it too would duplicate it.
  if (!termIsXterm(meta.id)) termAppend(meta.id, command + "\n");
  if (typeof opts.onExit !== "function") { await atom.terminal.run(meta.id, command); return meta; }
  // Subscribe BEFORE running, and hold anything that arrives before the token is
  // known: the completion is a shell write, the token is an IPC reply, and there
  // is no ordering guarantee between them.
  let tok = null, fired = false;
  const early = [];
  const offs = [];
  const done = (code) => {
    if (fired) return;
    fired = true;
    for (const f of offs) { try { f(); } catch { /* already gone */ } }
    opts.onExit(code);
  };
  offs.push(atom.events.onTerminalCommandExit((ev) => {
    if (ev.id !== meta.id) return;
    if (!tok) early.push(ev);
    else if (ev.token === tok) done(ev.code);
  }));
  // A shell that dies mid-install is also an ending, just an uglier one.
  offs.push(atom.events.onTerminalExit(({ id, code }) => { if (id === meta.id) done(code == null ? -1 : code); }));
  tok = await atom.terminal.runTracked(meta.id, command).catch(() => null);
  // No token means the shell never took the command — say so rather than leaving
  // the caller waiting on a completion that cannot arrive.
  if (!tok) done(-1);
  else { const hit = early.find((e) => e.token === tok); if (hit) done(hit.code); }
  return meta;
}
export function wireTerminalEvents() {
  if (_term.wired) return;
  _term.wired = true;
  atom.events.onTerminalData(({ id, chunk }) => { if (_term.panes.has(id) || _term.tabs.some((t) => t.id === id)) termWrite(id, chunk); });
  atom.events.onTerminalExit(({ id, code }) => {
    const t = _term.tabs.find((x) => x.id === id);
    if (t) { t.exited = true; t.code = code; renderTermTabs(); }
  });
  atom.events.onTerminalCleared(({ id }) => {
    const p = _term.panes.get(id);
    if (!p) return;
    if (p.mode === "xterm") { p.term.clear(); return; }
    while (p.el.firstChild && p.el.firstChild !== p.input) p.el.removeChild(p.el.firstChild);
  });
  atom.events.onTerminalClosed(({ id }) => {
    disposeTermPane(_term.panes.get(id));
    _term.tabs = _term.tabs.filter((t) => t.id !== id);
    _term.panes.delete(id);
    if (_term.active === id) setActiveTerm(_term.tabs.length ? _term.tabs[_term.tabs.length - 1].id : null);
    else renderTermTabs();
  });
}
