# AtomNano

A beautiful, warm-dark **Windows desktop GUI for Claude Code**, powered by the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
Run multiple Claude Code sessions in parallel tabs, browse your project files,
watch which files get edited in real time, and keep a renamable history of every
session — all in a polished native-feeling app.

![AtomNano](build/icon.png)

## Features

- **Parallel session tabs** — run several Claude Code conversations at once. Each
  tab shows live status: **idle**, **running** (pulsing), **done**, **error**, or
  **needs attention** (waiting for a permission).
- **Full Claude Code harness** — uses the official Agent SDK with the
  `claude_code` system preset and your real user/project settings, so every tool
  (Read, Edit, Write, Bash, Grep, Glob, Task, Web…) works exactly as in the CLI.
- **Live file tree** — left navigation shows all files & folders of the working
  directory. Right-click any item for **Copy absolute path**, **Copy relative
  path**, **Reveal in File Explorer**, **Open**, **Preview**, and **Set as working
  folder**.
- **Changed-files panel** — see exactly which files Claude edited/created this
  session, with edit counts; click to preview.
- **Rich composer** — model picker (Opus 4.8 / Sonnet 4.6 / Haiku 4.5), thinking
  level (Off → Ultrathink), and permission mode (Accept edits / Ask each time /
  Plan / Full access).
- **Streaming output** with live typing, collapsible reasoning blocks, and
  collapsible tool cards (input + result).
- **History** — every session is stored as a JSON file in a folder you choose.
  Rename, reopen, search, and delete sessions anytime.
- **Authorization** — if you're already logged in via the Claude CLI, AtomNano
  uses that login automatically. Settings shows your auth status and can open a
  login terminal or accept an API key.
- **Warm dark theme** with selectable accents (Amber / Ember / Gold / Rose),
  adjustable interface size, custom title bar, and resizable panes.

## Requirements

- Windows 10/11 (x64), or macOS 12+ (see [macOS](#macos))
- [Node.js](https://nodejs.org) 18+ (only needed to run from source / build)
- The [Claude CLI](https://docs.claude.com/en/docs/claude-code) installed and
  logged in (`claude` on your PATH). AtomNano reuses its credentials.

## Run from source

```bat
scripts\install.bat   :: installs dependencies + builds the icon
scripts\dev.bat       :: launches AtomNano with DevTools
```

(or `scripts\start.bat` to run without DevTools)

## Build a Windows installer

```bat
scripts\build.bat
```

This produces `dist\AtomNano-Setup-<version>.exe` — a standard NSIS installer
with Start Menu and desktop shortcuts and a chooseable install directory.

## Portable (unpacked) build

```bat
scripts\pack-dir.bat     :: builds a portable folder at dist\win-unpacked\
scripts\run-unpacked.bat :: runs it
```

The portable build keeps **all data — settings, session history, API key, and
your Claude login — inside `dist\win-unpacked\AtomNano-Data\`** (next to the
`.exe`). Copy the whole `win-unpacked` folder to a USB stick or another PC and
everything comes with you. On first run it seeds the login from your existing
`~/.claude`; after that, the portable folder is the source of truth.

(Portable mode activates automatically whenever a `portable.flag` file or an
`AtomNano-Data` folder sits next to `AtomNano.exe`. The **installed** version
stores data in `%APPDATA%\AtomNano` as usual.)

## macOS

AtomNano runs on macOS too (Apple Silicon and Intel). The macOS build is an unsigned
dev build — no Apple account needed. Everything macOS-specific is in [`mac/`](mac/README.md):

```bat
mac\build-mac.bat     :: from WINDOWS: builds the DMG on a free GitHub Actions macOS runner and downloads it to dist\mac\
```

```sh
mac/build.sh          # on a Mac: dist/AtomNano-<version>-mac-<arch>.dmg
mac/dev.sh            # on a Mac: run from source
```

First launch of the unsigned app: right-click → Open, or
`xattr -dr com.apple.quarantine /Applications/AtomNano.app`. See `mac/README.md` for
requirements (Claude CLI), the GitHub setup, and how to sign later.

## Authorizing Claude

1. Make sure the Claude CLI is installed and you've logged in once:
   open a terminal and run `claude` then `/login`.
2. AtomNano automatically uses `~/.claude/.credentials.json`.
3. In **Settings → Claude authorization** you can verify status, open a login
   terminal, point AtomNano at a specific `claude.exe`, or paste an API key.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+T` | New session tab |
| `Ctrl+W` | Close tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+H` | History |
| `Ctrl+,` | Settings |
| `Enter` | Send · `Shift+Enter` newline |
| `Esc` | Stop the running session / close menus |

## Architecture

```
src/main/        Electron main process (Node, CommonJS)
  main.js        window + IPC wiring
  preload.js     secure contextBridge API (window.atomnano)
  claude.js      Claude Agent SDK session manager (streaming, permissions)
  store.js       settings + session persistence
  files.js       file tree / read / reveal
  auth.js        CLI detection + login
src/renderer/    UI (vanilla ES modules, no framework)
  app.js         controller + state
  styles.css     warm dark theme
  markdown.js    dependency-free markdown renderer
  icons.js       inline SVG icon set
scripts/         .bat build/run scripts
build/           generated app icon
```

Built by Atom AI Labs.
