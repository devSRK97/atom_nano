# AtomNano — Architecture & Context Overview

> Hand-off document. Read this first to get full context on what AtomNano is,
> how it's structured, how data flows, the conventions used, and the
> non-obvious decisions/gotchas. Pair with `README.md` (user-facing).

---

## 1. What it is

**AtomNano** is a Windows desktop GUI for **Claude Code**, built with Electron and
the official **Claude Agent SDK**. It lets a
user run multiple Claude Code sessions in parallel tabs, browse/edit project
files in a built-in minimal code editor, search the project, watch which files
Claude edits, and manage everything (history, themes, auth, updates) from one
warm-dark UI.

- **Location:** `E:\Mac\AtomNano`
- **Owner:** Atom AI Labs
- **Platform:** Windows 10/11 x64 only.
- **Version:** 1.0.0 · appId `com.atomailabs.atomnano`.

It does **not** reimplement Claude's tools — it drives the real Claude Code
harness via the SDK (`systemPrompt: { preset: "claude_code" }`,
`settingSources: ["user","project","local"]`), so Read/Edit/Write/Bash/Grep/Glob/
Task/Web/etc. behave exactly like the CLI.

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Electron 42** | frameless window, custom title bar, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`, preload bridge |
| Agent | **@anthropic-ai/claude-agent-sdk** ^0.3.158 | ESM, loaded via dynamic `import()` from CJS |
| Renderer | **Vanilla JS (ES modules)** | no framework; hand-rolled DOM via `h()` helper |
| Packaging | **electron-builder 26** | NSIS installer; `asar: false` |
| Search | **Node `worker_threads`** | project search runs off the main thread |
| Testing | **Playwright** (`_electron`) | drives the real app, screenshots; devDependency |

Runtime deps: only `@anthropic-ai/claude-agent-sdk`. Dev: `electron`,
`electron-builder`, `playwright`.

---

## 3. Process model & file map

Electron is multi-process: **main** (Node/CJS), **renderer** (Chromium, the UI),
plus GPU/utility processes. The Claude CLI is spawned as its **own process** per
run, and **project search runs in a worker thread** — so heavy work stays off the
UI thread and uses multiple cores.

```
src/main/   (Node, CommonJS — the "backend")
  main.js          App lifecycle, BrowserWindow, portable-mode detection,
                   ALL ipcMain handlers, close-confirm dialog, renderer
                   console/crash forwarding. Sets claude.setEmitter(...).
  preload.js       contextBridge → exposes window.atomnano.* to the renderer.
  store.js         settings.json (userData) + one JSON file per session in the
                   history folder. In-memory cache + debounced writes.
  claude.js        SessionManager — wraps the Agent SDK query(). Streaming,
                   permissions, message normalization, edited-file + line-diff
                   tracking, env building, prompt building, CLI resolution.
  files.js         File tree (listDir), read/write, reveal, openPath, trash
                   (Recycle Bin). Delegates search to the worker.
  search-core.js   PURE search logic (walk, matchers, binary detect, content +
                   name search). No Electron deps → safe in a worker.
  search-worker.js worker_threads entry: runs search-core, posts result.
  auth.js          CLI detection (`where claude`), login status, login terminal,
                   update check/run. Honors CLAUDE_CONFIG_DIR (portable).

src/renderer/   (Chromium, ES modules — the "frontend")
  index.html       Static shell: #titlebar (brand + #tbActions File/Git toolbar),
                   #sidebar (file tree / git commit view), #editorPane,
                   #main (#chatHeader session-tabs + chat + composer),
                   #changesPanel, #ctxMenu, #modalRoot, #toast.
  app.js           The controller. State, tabs, file tree, editor, find/search,
                   composer, prompt queue, settings, history, events. (~big)
  styles.css       Warm-dark theme + alternate themes (html[data-theme]) +
                   every component style. Accent-derived colors use color-mix.
  markdown.js      Dependency-free Markdown → HTML (escapes first; code fences,
                   inline, lists, headings, links, blockquote).
  icons.js         Inline SVG icon set: icon(name, size, extraClass).

scripts/
  generate-icon.js Pure-Node PNG+ICO generator (the amber "atom" mark).
  install.bat      npm install + icon.
  dev.bat          electron . --dev (DevTools).
  start.bat        electron . (no DevTools).
  build.bat        npm run dist  → dist\AtomNano-Setup-<ver>.exe (installer).
  pack-dir.bat     npm run pack  → dist\win-unpacked\ + portable.flag (PORTABLE).
  run-unpacked.bat launches the portable build.

build/icon.ico|png Generated app icon (see generate-icon.js).
electron-builder.yml  NSIS config; asar:false; excludes bundled SDK platform binaries.
```

---

## 4. IPC surface (`window.atomnano`, defined in preload.js)

Request/response use `ipcMain.handle` wrapped as `{ ok, data | error }`; the
preload unwraps and throws on error. Main→renderer push events use
`webContents.send` and are subscribed via `atom.events.*`.

```
atom.app.info()                         → {version, platform, home, userData, portable, dataDir}
atom.win.{minimize,maximize,close,isMaximized,onMaxChange}
atom.settings.{get,set(partial)}
atom.auth.{status,openLogin}
atom.updates.{check,run}
atom.dialog.{pickFolder(def),pickHistory}
atom.sessions.{list,create,get,rename,update,delete,send,interrupt,running,
               permissionResponse(reqId,decision),openHistory}
atom.files.{list(dir),read(p),write(p,content),reveal(p),open(p),trash(p),
            searchNames(opts),searchContent(opts)}
atom.clipboard.write(text)
atom.shell.openExternal(url)
atom.events.on{Message,MessageUpdate,Status,Partial,PartialReset,
               EditedFiles,Permission}(cb)
```

Main→renderer event channels: `session:status`, `session:message`,
`session:message-update`, `session:partial`, `session:partial-reset`,
`session:edited-files`, `session:permission`, `win:maximized-change`.

---

## 5. Claude Agent SDK integration (`claude.js`) — the core

### Run model
**One `query()` call per turn**, with `resume: <claudeSessionId>` to continue
context. The CLI session id is captured from the `system/init` and `result`
messages and stored on the session. This is simpler/more robust than a
long-lived streaming generator and survives app restarts.

### Options passed to `query()`
```js
{
  cwd, model, permissionMode,
  includePartialMessages: true,                       // streaming deltas
  systemPrompt: { type:"preset", preset:"claude_code" },
  settingSources: ["user","project","local"],         // full harness behavior
  abortController,                                     // for stop/interrupt
  canUseTool,                                          // permission bridge → UI
  env: buildEnv(settings),
  maxThinkingTokens,        // only when thinking level > off
  betas: ["context-1m-2025-08-07"],   // only when 1M toggle on
  pathToClaudeCodeExecutable: <resolved installed claude.exe>,  // see gotchas
  resume: <claudeSessionId>,          // when continuing
}
```

### Message normalization
SDK messages are converted to UI message objects with `role`:
`user | assistant | thinking | tool | result | error | system`.
- `assistant` text/thinking/tool_use blocks → separate messages.
- `tool` messages carry `{toolName, toolUseId, toolInput, status, result}`;
  `status` updated from the matching `tool_result` (running→done/error).
- `stream_event` deltas → `session:partial` (live typing); reset on
  `message_start` and after each assistant commit.
- `result` → a `result` message with `{durationMs, numTurns, costUsd, usage}`
  (UI shows **time, not cost**).

### Edited-file + line tracking
On edit-tool `tool_use` (Edit/Write/MultiEdit/NotebookEdit), `trackEdit` records
`{path, count, added, removed}` (line diff computed by `computeDiff`) and emits
`session:edited-files`. Powers the Changes panel, the composer stats strip, and
the tree edit badges.

### Permissions
`canUseTool` forwards a `session:permission` event to the renderer and awaits a
response (`atom.sessions.permissionResponse`). Modes: `acceptEdits` (default),
`default` (ask each time), `plan`, `bypassPermissions` (full access).

### Attachments
`buildPrompt(text, attachments, session)`: plain text → string. With images →
one-shot streaming user message with base64 `image` blocks. Files → referenced
by absolute path appended to the prompt (Claude reads them with its tools).

### Models / thinking
- Models: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`,
  plus user **custom models** (settings.customModels).
- Thinking → `maxThinkingTokens`: off=0, think=4k, think-hard=10k,
  think-harder=20k, ultrathink=~32k.

---

## 6. Data model & persistence (`store.js`)

**Settings (global, shared by every session)** — `settings.json` in userData:
```
theme, fontSize, editorFontSize,
defaultModel, defaultPermissionMode, defaultThinking, oneM, customModels[],
historyDir, claudePath, apiKey, useEnvApiKey, confirmClose,
lastFolder, windowBounds, openTabIds[], activeTabId
```
> Model / thinking / permission / 1M are intentionally **global** — changing them
> in the composer affects all sessions and persists.

**Session** — one JSON file per session in `historyDir`:
```
id, name, cwd, model, permissionMode, thinking, oneM,
claudeSessionId, status, createdAt, updatedAt,
messages[], editedFiles[], totalCostUsd
```

Sessions are **tagged by project via their `cwd`**. They're stored flat in one
folder, but the **History modal defaults to the current project** (filters by
`cwd === active session's cwd`, case-insensitive) with a **"This project / All
projects"** toggle. So opening a different working folder only shows that
project's sessions by default.

**Data locations**
- Installed build → `%APPDATA%\AtomNano\` (`settings.json`, `sessions\`).
- Portable build → `<exeDir>\AtomNano-Data\` (`settings.json`, `sessions\`,
  `claude\`). See §9.

---

## 7. Renderer architecture (`app.js`)

Single `state` object:
```
state = {
  settings,                       // the global settings
  order: [tabId...], activeTabId, // open session tabs
  tabs: Map<id, TabState>,        // per-session UI state
  editor: { open:[file...], active, fontSize },  // shared code editor
  selectedFolder, findContext,    // for Ctrl+F routing
  updates,                        // last update-check result
}
TabState = { meta, messages[], editedFiles[], streaming:Map, pendingPerms[],
             attachments[], queue[], draft, tree }
```

Helpers: `h(tag,props,...kids)` builds DOM; `icon()` SVG; `dropdown()` (menus
render **fixed on document.body** so they're never clipped); `showContextMenu()`;
`modalShell()`/`confirmDialog()`; `toast()`.

### Major UI areas
- **Title bar** — brand + `#tbActions`: **File** menu (open folder / new session /
  search / import / settings) and a **Git** toolbar (branch label + Pull / Commit /
  Push). Window controls + a chat show/hide toggle sit on the right.
- **Session tabs** — live in the chat-panel header (`#chatHeader`): `.cht-tab`
  strip (status dot, rename on dbl-click, drag-reorder, close, context menu) that
  **overflows into a dropdown like the editor tabs** (`computeSessionOverflow`),
  with History + New-session (＋) at the right end.
- **Sidebar** — folder picker + lazy file tree (the open editor file is
  highlighted, `.tree-row.active`); right-click context menu (copy paths, reveal,
  open, open-in-editor, search-in-folder, set working folder, **delete → Recycle
  Bin**). Swaps to a **WebStorm-style git commit view** (`renderGitView`) when you
  click Commit — staged/unstaged sections with stage checkboxes, a message box and
  Commit / Commit & Push, with a "Back to files" toggle. Git itself is
  `src/main/git.js` (system `git` via execFile; pull/push use your credential
  helper).
- **Editor pane** (middle) — **CodeMirror 6** editor:
  - Wrapper `src/renderer/editor/cm-src.js` → bundled by esbuild to
    `cm.bundle.js` (the renderer imports the **bundle**, not node_modules).
    **Re-run `npm run build:cm` after editing `cm-src.js`** (wired into dist/pack).
    `@codemirror/*` + `@lezer/highlight` are **devDependencies** (inlined into the
    bundle → excluded from the installer).
  - **Themed via CSS variables** (`--tok-comment/string/keyword/number/fn/type/
    prop/punct`, `--code-text`, `--accent`, …), so syntax colours follow the app
    theme live — no editor reconfigure on theme switch. Token vars live in
    `styles.css` (`:root` dark + `html[data-theme="light"]`).
  - One reused CM6 instance (`let cm` in `app.js`); switching tabs swaps the
    document (`cm.setDoc`) rather than rebuilding the editor — fast even at 1M
    lines (CM6 virtualizes natively). File content normalised to **LF** on open.
  - File tabs, overflow dropdown, **Ctrl+S save**, **zoom** (status-bar ±,
    Ctrl+= / − / 0 → `--ed-font` var, `cm.remeasure()`), native undo/redo + a
    rich default keymap.
  - **Smart double-click** selects one identifier segment (`- . _` kept, `.`
    separates) — custom handler in `cm-src.js`.
  - **Ctrl/Cmd-click go-to-definition** (js/ts/py/json): import paths, local
    symbols, project-wide fallback via the search worker. Ctrl-hover underlines
    the target (`.cm-link-target` + `.cm-ctrl` cursor).
  - **Right-click context menu**: Cut/Copy/Paste/Select all/Upper/Lower (driven
    by CM6 selection ops; falls back to the current line when nothing selected).
  - Status bar: lang, Ln/Col, zoom, save.
- **Find / Search**
  - **In-editor find** = CM6's own search panel (Ctrl+F when editor focused →
    `cm.openSearch()`); themed via `aqxTheme`.
  - **Search palette** (Ctrl+F on a selected folder, or right-click folder →
    Search in folder): modes **This file / File names / In files (content)**;
    content results grouped by file with **3-line previews** + match counts;
    click → opens file at the exact line. Runs in the **worker**.
- **Composer**
  - Auto-growing prompt textarea; paste/drop **images** (→ vision) & **files**
    (→ path refs) with chips.
  - Shared dropdowns: **model / thinking / permission** + **1M context** toggle.
  - **Stats strip** (files changed, +/− lines) above the box.
  - **Prompt queue**: sending while a run is active enqueues (numbered 1,2,…);
    queued items auto-run when the current reply finishes. Send button = Stop
    (red) when running with empty box; Stop clears the queue.
- **Chat** — Markdown, collapsible Thinking cards, tool cards (clickable file
  links), result line (time), permission prompt cards; **user messages
  right-aligned** with timestamps. Rendering is **windowed/virtualized**:
  `renderMessagesRegion()` shows `[ts.viewStart .. end]`; **infinite scroll**
  auto-loads older pages (`loadOlder`, `RENDER_STEP=30`) on scroll-to-top, and
  `trimRenderedTop()` drops the oldest DOM nodes past `MAX_RENDER=80` while
  following the live tail — so an all-day session stays light. **Streaming is
  flicker-free**: `updateLiveText()` patches a plain text node in place per
  token (no markdown re-parse / no rebuild); Markdown is applied once when the
  message commits.
- **Changes panel** — edited files with +/− line badges; click to open.
- **Settings modal** — auth status, **Updates**, theme picker, interface size,
  shared model/permission/thinking, **custom models**, history folder, CLI path,
  API key, env-key toggle, data location/portable status.

---

## 8. Themes

`html[data-theme="..."]` sets CSS custom properties.
- Warm (warm-dark base, accent only): `amber` (default), `ember`, `gold`, `rose`.
- Full palettes: `gunmetal`, `gray`, `blue`, `light`.
Accent-derived highlights (search marks, glow, selection) use `color-mix(in srgb,
var(--accent) …)` so they adapt to any theme. Code/editor text uses
`--code-text` (overridden per theme). The setting key is `theme` (legacy `accent`
is read as a fallback).

---

## 9. Portable mode

If **`portable.flag`** or an **`AtomNano-Data`** folder sits next to
`AtomNano.exe`, `main.js` (before requiring `store`) calls
`app.setPath("userData", <exeDir>/AtomNano-Data)` and sets
`process.env.CLAUDE_CONFIG_DIR = <…>/AtomNano-Data/claude`. So **settings,
sessions, API key, and the Claude login all live next to the app** and travel
when the `win-unpacked` folder is copied. On first run it **seeds** the portable
`claude/.credentials.json` from the machine's `~/.claude`. `pack-dir.bat` creates
the flag; the **installer build does not** (installed = `%APPDATA%`).

**App-level Claude home (non-portable default).** When not portable, `main.js`
still points `CLAUDE_CONFIG_DIR` at an app-owned home — `<userData>/claude` — and
seeds `.credentials.json` from `~/.claude` on first run. So AtomNano keeps **one
login shared across every project/window**, independent of the OS-level
`~/.claude` (the terminal `claude` login), and the two never clobber each other.
Because `CLAUDE_CONFIG_DIR` relocates the *whole* Claude home, AtomNano runs read
app-home `settings.json` / `CLAUDE.md` / agents — **not** the user's global
`~/.claude` ones. An explicit `CLAUDE_CONFIG_DIR` already in the environment wins.

---

## 10. Auth & updates (`auth.js`)

- **Auth:** uses the Claude CLI's stored login. `status()` reports CLI path,
  version, and login (reads `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json`).
  "Open login terminal" spawns `claude /login` (inherits CLAUDE_CONFIG_DIR).
- **Updates:** `checkUpdates()` compares installed CLI (`claude --version`) and
  SDK (node_modules package.json) against `npm view <pkg> version`. If the CLI is
  behind, Settings shows **Update Claude** (runs `claude update`, which also
  brings new models) and a title-bar **Update** chip appears (checked on startup).
- **New models:** add IDs in Settings → **Custom models** (`id | Name` per line)
  to use models released after this build.

---

## 11. Build & run

```
scripts\install.bat   # npm install + icon
scripts\dev.bat       # run from source (DevTools)
scripts\build.bat     # NSIS installer  → dist\AtomNano-Setup-1.0.0.exe
scripts\pack-dir.bat  # portable build  → dist\win-unpacked\ (+ portable.flag)
scripts\run-unpacked.bat
```
`electron-builder.yml`: `asar:false`; default file set minus dist/scripts/maps
and the bundled SDK **platform binaries**
— AtomNano drives the user's installed `claude.exe` instead.

---

## 12. Testing approach

Verified with **Playwright-Electron** (`_electron.launch({ args:["."], env:{
ATOMNANO_TEST:"1" }})`): launch, drive UI, screenshot, assert. Backend logic
(models × permission modes, search, updates) is also exercised by requiring the
real `store`/`claude`/`auth` with a **mocked `electron`** module via
`Module._load`. The env var `ATOMNANO_TEST=1` disables the single-instance lock
and the close-confirm dialog so tests don't hang.

The suites live in **`smoke-tests/`** (run e.g. `node smoke-tests\test-git-multi.js`);
they're excluded from the packaged build. See `smoke-tests/README.md` for the map.

---

## 13. Non-obvious decisions & gotchas (READ THIS)

1. **Stale `ANTHROPIC_API_KEY` in the environment breaks runs.** This machine
   has an invalid one. `claude.js buildEnv()` **deletes** `ANTHROPIC_API_KEY` /
   `ANTHROPIC_AUTH_TOKEN` from the spawned env unless the user set an API key in
   settings or enabled `useEnvApiKey` — otherwise the CLI prefers the bad key over
   the working OAuth login and every run fails with "Invalid API key".
2. **The SDK's bundled ~236 MB native `claude.exe` is flaky to first-launch on
   Windows** (antivirus race → "exists but failed to launch"). So AtomNano pins
   `pathToClaudeCodeExecutable` to the **user's installed `claude.exe`**
   (auto-detected via `where claude`, override in settings). Bundled platform
   binaries are excluded from the installer.
3. **`asar: false`** — the SDK is ESM and spawns child processes; running from
   plain files avoids ESM-in-asar resolution problems and keeps behavior identical
   to dev.
4. **The code editor is CodeMirror 6**, imported as a pre-built esbuild bundle
   (`cm.bundle.js`). After editing `cm-src.js`, **run `npm run build:cm`** or the
   change won't ship. Theming is CSS-variable driven (no reconfigure on theme
   switch). **Ctrl+R is intercepted globally** to prevent page reload.
5. **Model / thinking / permission / 1M are global** (shared across all sessions),
   stored in settings, not per session.
6. **Per-turn `query()` + `resume`** is the multi-turn strategy (not a persistent
   streaming generator).
7. **userData folder casing**: dev resolves `…\Roaming\atomnano`, packaged
   `…\Roaming\AtomNano` — same folder on case-insensitive Windows.
8. **Dropdown menus render fixed on `document.body`** (not inside the composer)
   so they aren't clipped by `overflow:hidden`.
9. **Project search runs in a worker thread** (`search-worker.js`) — keep
   `search-core.js` free of Electron imports.
10. Renderer is `contextIsolation`+CSP; all privileged ops go through
    `window.atomnano` (preload). Don't add `nodeIntegration`.

---

## 14. How to extend (quick pointers)

- **New IPC call:** add `handle("ns:thing", …)` in `main.js`, expose in
  `preload.js` under `atom.ns.thing`, call from `app.js`.
- **New tool card rendering:** `toolIcon()` / `toolSummary()` / `toolSummaryEl()`
  in `app.js`.
- **New theme:** add an `html[data-theme="x"]{…}` block in `styles.css` (include
  the `--tok-*` syntax-token vars if you want custom code colours — else it
  inherits the `:root` palette) and an entry in the `THEMES` array in
  `openSettings()`.
- **New setting:** add to `DEFAULT_SETTINGS` in `store.js`; read/write via
  `atom.settings`.
- **Editor language / token colours:** add a language to `langFor()` in
  `cm-src.js` (then `npm run build:cm`); tune syntax colours via the `--tok-*`
  CSS vars in `styles.css`. The `aqxHighlight` map ties Lezer tags → those vars.
- **Persisted session shape:** `normalizeSession()` in `store.js`.

---

*Generated as a hand-off doc for AtomNano v1.0.0. If code and this doc disagree,
trust the code and update this file.*
