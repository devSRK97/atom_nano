// esbuild entry for the renderer terminal emulator. `npm run build:term` bundles
// this (plus xterm's CSS) into xterm.bundle.js / xterm.bundle.css, which
// index.html loads as a classic script before app.js. The renderer reads
// window.Terminal / window.FitAddon; if the bundle is absent the terminal
// silently falls back to its legacy line-oriented pane.
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

globalThis.Terminal = Terminal;
globalThis.FitAddon = FitAddon;
