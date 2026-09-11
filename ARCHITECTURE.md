# AtomNano — Architecture & Context Guide

> **Purpose of this file:** a single, self-contained briefing an AI assistant (or a new engineer) can read to gain full working context on the AtomNano codebase before making changes. It describes the real, verified structure of the app — file responsibilities, the IPC contract, the data model, the agent subsystems, the renderer, and the build.

---

## 0. What AtomNano is

AtomNano is a **Windows desktop GUI for Claude Code**, built on **Electron** with the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). It is a polished IDE-grade shell around an autonomous coding agent: a file tree + CodeMirror 6 editor + git view on the left/middle, and a multi-session chat with the agent on the right. Beyond a plain chat client it adds multi-provider routing, background fleets, per-project memory, learned skills, and a test-authoring director.

- **App id:** `com.atomailabs.atomnano` · **Product:** `AtomNano` · **Vendor:** Atom AI Labs
- **Stack:** vanilla JS (no React/Vue), Electron main/preload/renderer split, hand-rolled DOM helper `h()`.
- **History:** evolved from an app called "AtomCode" (kept as a backup tree at `E:\Mac\AtomCode`). AtomNano is the live product.

### Directory shape

```
E:\Mac\AtomNano\
  src/
    main/        # Node/Electron main process — 34 modules (see §1)
    renderer/    # UI: app.js, index.html, styles.css, markdown.js, icons.js
      editor/    # CodeMirror 6 source (cm-src.js) → built bundle (cm.bundle.js) + cmchunk/*
  build/         # icon.ico / icon.png (packaging resources)
  smoke-tests/   # Playwright-driven smoke tests (NOT shipped)
  electron-builder.yml
  package.json
```

---

## 1. Main process modules (`src/main/`)

The main process is the trust boundary: it owns the filesystem, spawns CLIs, talks to provider APIs, and persists everything. The renderer reaches it **only** through the preload IPC bridge (§2).

### Core runtime

| File | Responsibility |
|------|----------------|
| **main.js** | App lifecycle. Portable-mode detection (data folder next to the exe), single-instance lock, window-per-project model, file-system watching, and **all IPC handler registration** via the `handle()` wrapper. Wires emitters from `claude`/`fleet`/etc. to `broadcast()`. |
| **store.js** | Persistence. `settings.json` in userData + one JSON file per session in `historyDir`. **Lazy-load**: a lightweight metadata index is built at startup; full sessions parse from disk on demand and cache once touched. Owns per-project settings merge and `GLOBAL_ONLY` keys. |
| **claude.js** | Claude Agent SDK wrapper. One `query()` per turn, context preserved via the SDK `resume` (CLI session id). Adaptive vs legacy thinking budgets, permission bridge (`canUseTool` → renderer prompt), error classification + **transient-retry resilience**, message normalization → IPC events. Key: `run()`, `discoverModels()`, `classifyError()`. |
| **auth.js** | CLI detection and login. `status()`, `whereClaude()`, `openLoginTerminal()`. Reads `~/.claude/.credentials.json` / env key. |
| **files.js** | File tree + IO: `listDir`, `readFile` (size + binary detect, 80 MB cap), `write`, `reveal`, `trash`, terminal open, import resolution, name/content search entrypoints. |
| **git.js** | Thin wrapper over the system `git` binary (uses OS credential helper). `repos`, `status`, `branch`, stage/commit/push/pull, `diff`, branches/checkout/merge, discard, ref-diffs. |
| **zipper.js** | Minimal dependency-free ZIP read/write (zlib DEFLATE). Builds the userdata backup bundle. |

### Providers & model routing

| File | Responsibility |
|------|----------------|
| **providers.js** | Provider capability **catalog** (Anthropic / OpenAI / Google / Custom): models, reasoning controls, context-window flags, and how each runs as *primary* (sdk/acp/cli). Live model discovery via provider APIs. `get()`, `discover()`, `context1M()`. |
| **customApi.js** | Raw-HTTP custom-API template engine. Substitutes `{{prompt}}/{{system}}/{{model}}` into a JSON body template, parses headers, extracts the reply via a JSON path. Tests endpoints. |
| **council.js** | Runs **other** providers as non-interactive reviewers (consult-before / review-after). Spawns `codex exec` (OpenAI), `agy` (Antigravity/Google, with a `--log-file` non-TTY workaround), or `claude -p`. `reviewerRun()`, `present()`, output cleaners. *(Internal — not a preload namespace.)* |
| **googlePrimary.js** | **Opt-in legacy** Google primary over ACP (`gemini --experimental-acp`), JSON-RPC 2.0 over stdio. Gated by `settings.legacyGeminiACP`. |
| **agyDb.js** | Recovers an assistant reply from agy's per-conversation SQLite DB when print-mode stdout is empty (a non-TTY agy bug). Minimal protobuf wire scan via bundled `sql.js`. |
| **imagegen.js** | Image generation: vector (SVG via a text model) or raster (OpenAI `gpt-image-1` / Google Imagen). Backend injectable for tests. |
| **mcpConfig.js** | MCP server config bridge — reads/writes `~/.gemini/config/mcp_config.json` (shared with the Antigravity IDE). `list/upsert/remove/rename`. |

### Agent subsystems

| File | Responsibility |
|------|----------------|
| **fleet.js** | Background task queue. Up to N concurrent agents per project; a **FileLockManager** prevents two tasks editing the same file (the loser is told to work elsewhere). Persists to `fleet.json`. `enqueue()`, `schedule()`. |
| **skills.js** | Per-project reusable procedures **+ apprentice learning**: logs every finished run (intent signature = two longest keywords) and suggests a skill when the same intent recurs ≥3×. Stored at `userData/skills/<projectKey>.json`, bounded (~80). |
| **director.js** | **Test Director** state machine: `draft → author(TESTER) → build(BUILDER) → red → fix (oracle-guarded, ≤3) → gate (mutation + flake) → complete`. `classifyFailure()` biases to fixing code; ambiguous failures escalate. Agent runner injectable. |
| **testdir.js** | Per-project test **catalog + integrity guard**. Tests map to frozen spec-bullet IDs; append-only guard rejects weakening a locked test (assertion count can't drop, no `skip/only`). Capability adapters: browser (via testhost) vs node (spawn). |
| **testhost.js** / **testhost-preload.js** | Embedded hidden-Chromium test executor. Deterministic (hermetic network, seeded RNG, frozen clock). Compiles declarative steps (`click/fill/expectText/eval`) into page expressions. |

### Memory & context (zero-LLM by default)

| File | Responsibility |
|------|----------------|
| **convo.js** | Per-session "session memory" — a bounded ~1.8 KB digest (goals/outcomes/files/tools) merging a **live** scan of recent messages with a **pruned** sidecar (`<id>.convo.json`) distilled from messages dropped past the cap. Injected on resume so a long chat never loses its thread. |
| **convo-graph.js** | Segments a chat into topic **threads** (BM25 lexical cohesion). When a prompt references an earlier thread ("go back to auth"), recalls that thread's digest. Lexical, deterministic, no embeddings. |
| **graph.js** | Per-**project** auto-maintained memory graph: records prompt topic + file-touch deltas + co-edit edges after each run; injects a compact digest before each turn. Bounded (≈200 files / 30 topics / 300 edges). |
| **context.js** | Unified workspace context registry — composes a ~2.8 KB block (project memory + tree + load-bearing files + capabilities + skills + conversation recall) for the system prompt. Providers register via `register(fn)`. |
| **distill.js** | Local "pre-mind": deterministically classifies the prompt (design/bugfix/refactor/explain) and extracts only the relevant slice of attachments using CPU worker threads. Optional neural refiner. |
| **capabilities.js** | Scans `package.json` scripts/bin + source (routes, exports) into a bounded, 15s-cached capabilities digest. |
| **localmind.js** | Optional embedded local optimizer — downloads small Qwen2.5-Coder GGUF models into `userData/models/` on demand, lazy-loads on first use, unloads after idle. Hardware-gated (RAM/cores/GPU probe). |

### Language intelligence

| File | Responsibility |
|------|----------------|
| **lsp.js** | Generic LSP client over stdio. Bundled **pyright** for Python; PATH-found `gopls`/`rust-analyzer`/`clangd`/`intelephense` for others. Diagnostics, hover, completion, definition, formatting; offset↔line/char mapping. |
| **ast.js** | TypeScript-AST code analysis (lazy) for the Test Director — precise imports/classify/assertions/mutations, with regex fallback on parse failure. |
| **ts-host.js** / **tsserver.js** | TypeScript service in a **dedicated utility process** (idle-killed ~5 min) so TS memory stays off the main thread. Message-RPC: quickInfo, definition, refactors. |
| **search-core.js** / **search-worker.js** | Pure (Electron-free) project search run in **worker threads** — dir walk with skip-list + binary detection, name + regex content search, capped per file (50) and total (2000). |

---

## 2. IPC surface (`src/main/preload.js`)

The renderer accesses everything through `window.atom.*`. Every call is an `invoke()` that unwraps a `{ ok, data } | { ok:false, error }` envelope and throws on error. **Verified top-level namespaces:**

```
app  win  project  settings  auth  updates  providers  models  distill  image
mcp  antigravity  cli  localmind  userdata  dialog  sessions  files  git  ts
editorconfig  graph  convo  convograph  context  capabilities  skills  fleet
director  testdir  testhost  test  lsp  prettier  clipboard  shell  events
```

Notable namespaces:

- **`atom.sessions`** — `list, create, synthesize, get, messages, rename, update, delete, send, interrupt, running, permissionResponse, openHistory, export, import, retry`. `synthesize(srcId)` forks a fresh session seeded with the source's digest + last ~30 turns + edited-files (a frozen snapshot; see §3).
- **`atom.providers`** — `authStatus, authorize, catalog, testCustom`. **`atom.models.discover(provider)`** resolves the live model list.
- **`atom.fleet`** — `list, enqueue, enqueueMany, cancel` + `onProgress/onTaskUpdate` events.
- **`atom.skills`** — `list, create, update, remove, promote, mine, peek, hub, crossProject, scout, import*, export`.
- **`atom.director` / `atom.testdir` / `atom.testhost` / `atom.test`** — Test Director surface.
- **`atom.graph / convo / convograph / context / capabilities`** — `peek(...)` inspectors for the memory subsystems.
- **`atom.localmind`** — `probe, recommend, catalog, status, download, installEngine, set, remove, unload` + progress events.
- **`atom.userdata`** — `export(opts)` / `import()` (full backup; see §6).
- **`atom.ts`** — `diagnose`, `req(kind, …)` to the TS utility process. **`atom.lsp`**, **`atom.prettier`**, **`atom.editorconfig`** back editor intelligence.

### Event channels (`atom.events.on*`)

- **Session:** `session:status`, `session:message`, `session:message-update`, `session:partial`, `session:partial-reset`, `session:edited-files`, `session:permission`.
- **App/window:** `app:confirm-close`, `win:maximized-change`, `models:update`.
- **Subsystems:** fleet task progress/updates, file-watch `fs:changed`, update progress.

---

## 3. Data model & storage (`store.js`)

### Session (one `<id>.json` in `historyDir`)

```jsonc
{
  "id": "hex", "name": "…", "cwd": "<project folder>",
  "model": "claude-opus-4-8", "permissionMode": "acceptEdits",
  "thinking": "off", "oneM": false,
  "claudeSessionId": "<CLI resume id|null>",
  "status": "idle", "createdAt": "ISO", "updatedAt": "ISO",
  "messages": [ /* user/assistant/thinking/tool/result/system/error */ ],
  "editedFiles": [ { "path", "count", "added", "removed" } ],
  "totalCostUsd": 0
}
```

**Sidecars** (same dir): `<id>.convo.json` (pruned session memory) and `<id>.archive.jsonl` (messages dropped past the message cap, one per line).

### Settings (`settings.json` in userData)

- **Provider/model:** `llmProvider`, `defaultModel`, `defaultThinking`, `customApiBaseUrl`, `customMode`, `customEndpoint/Headers/PayloadTemplate/OutputPath`, **`customEndpoints[]`** (each with its own `apiKey`), `customModels[]`, `discoveredModels[]`.
- **Secrets:** `apiKey` (Anthropic), `openaiApiKey`, `geminiApiKey`, `customApiKey`, `useEnvApiKey`.
- **Workspace:** `historyDir`, `lastFolder`, `projects{}` (per-project tab/editor state + `tagColor`), `openWindows[]`, `recentProjects[]`, `windowBounds`.
- **Per-project overrides:** `projectSettings[projectKey]` overrides global for model/thinking/editor/agent toggles — **except `GLOBAL_ONLY`** keys (all secrets, `customEndpoints`, `claudePath`, `historyDir`, `windowBounds`, `projects/openWindows/lastFolder/recentProjects`, `discoveredModels/customModels`, `localOptimizer`, `projectSettings`).

### Other per-project stores (userData)

`graphs/<projectKey>.json` (memory graph) · `skills/<projectKey>.json` (skills + apprentice log) · `tests/<projectKey>.json` (test catalog) · `fleet.json` (shared task queue).

### `synthesize` (fork-with-context)

`sessions:synthesize` creates a **new** session (new `claudeSessionId`, no replayed transcript) and pushes **one system message** = header + `convo.digestFor(src)` + last ~30 user/assistant turns (≤10 KB) + top edited files, and copies `editedFiles`. It is a **frozen snapshot** at fork time; it does not inherit the source's `.convo.json` and does not pull the project-wide graph.

---

## 4. Providers & model invocation

`providers.js` holds a `CATALOG` keyed by provider, each with `{ label, reasoning, reasoningLevels, defaultModel, primary, models[] }`.

| Provider | Primary path | Reasoning | Notes |
|----------|--------------|-----------|-------|
| **Anthropic** | SDK (`claude.run`) | thinking levels | Concrete model ids discovered from the `claude` CLI and prepended to the list. |
| **Google (Gemini)** | ACP via `agy` (or legacy `gemini`) | thinking levels | agy has a non-TTY stdout bug → `--log-file` / `agyDb` recovery. |
| **OpenAI (Codex)** | CLI (`codex exec`) — currently via council path | effort levels | Live model list from API. |
| **Custom** | SDK (Anthropic-compatible base URL) or raw HTTP template | per-config | `customEndpoints[]` take precedence over legacy `customModels`. |

Discovery order: static catalog → CLI discovery (Anthropic) → API discovery (OpenAI/Google) → custom endpoints. `context1M(provider, modelId)` reports 1M-context support (Anthropic: Opus/Sonnet 4.6+ and Fable yes, Haiku no).

**Reviewers** (any provider) run through `council.reviewerRun()` regardless of the primary.

---

## 5. Renderer (`src/renderer/`)

- **`index.html`** regions: `#titlebar`, `#sidebar` (folder bar + file tree), `#editorPane` (tabs + body + status), `#main` (chat header with session tabs + composer + chat list), `#changesPanel`, and dockable panels for fleet/skills/tests. `#modalRoot`, `#ctxMenu`, `#toast` are global overlays.
- **`app.js`** (large, single file): a `state` object (settings, `tabs` Map, `order`, `editor`, `git`, `project`, `sidebarView`) and a DOM helper **`h(tag, props, ...kids)`** used everywhere. UI primitives: `dropdown()`, `modalShell()/openModal()`, `showContextMenu()`, `toast()`, `confirmDialog()`. Sessions render as `.cht-tab`s; the composer holds provider/model/thinking/permission dropdowns, 1M toggle, attachments, send/interrupt.
- **Editor** (CodeMirror 6): source is **`editor/cm-src.js`**, bundled by esbuild into **`cm.bundle.js`** + split `cmchunk/*` language chunks, **lazy-loaded** on first file open. **Verified wired features:** line numbers, active-line highlight, fold gutter, **rainbow bracket-pair colors** (`.cm-br0/1/…`), **indentation markers**, **sticky scroll**, **inlay hints**, **lint gutter** (parse + TS-type diagnostics), **autocompletion**, and **Emmet** (`abbreviationTracker`). Common grammars eager; others dynamic-imported with plain-text fallback. *(Note: a `@replit/codemirror-minimap` dependency is present in package.json but is **not** imported/wired — there is no minimap in the editor.)*
- **Theming** (`styles.css`): CSS custom properties on `:root`, switched by `html[data-theme="amber|ember|gold|rose|gunmetal|gray|blue|light"]`. Accent-derived colors via `color-mix`. Syntax token colors are CSS variables, so the editor restyles live with the app theme.
- **Markdown** (`markdown.js`) renders assistant messages; code blocks are syntax-highlighted. **`icons.js`** is an inline-SVG set returned by `icon(name, size, class)`.

---

## 6. Build, packaging & backup

### Scripts (`package.json`)

- `icon` → generate `build/icon.ico` from PNG.
- `build:cm` → esbuild `cm-src.js` → `cm.bundle.js` (+ `cmchunk/[hash]`) and `cm-worker.js` → `cm-worker.bundle.js` (esm, minified, `--target=chrome120`).
- `pack` → `electron-builder --win --dir` (unpacked). `dist` → `electron-builder --win` (NSIS installer).

### `electron-builder.yml`

```yaml
appId: com.atomailabs.atomnano
productName: AtomNano
copyright: Copyright © 2026 Atom AI Labs
asar: false        # SDK is ESM + spawns native binaries → asar breaks resolution
files:             # exclude dist/scripts/smoke-tests/maps + the SDK's platform binaries
win:  { target: [{ target: nsis, arch: [x64] }], icon: build/icon.ico,
        artifactName: ${productName}-Setup-${version}.${ext} }
nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
        deleteAppDataOnUninstall: false }
```

**exe metadata mapping:** Company name ← `package.json` `author.name`; Product name ← `productName`; Copyright ← `copyright`; Version ← `package.json` `version`. Installer publisher ← `win.publisherName` (falls back to `author.name`). The ~236 MB bundled SDK platform binaries are **excluded** — AtomNano drives the user's installed `claude` CLI.

### Backup (`atom.userdata.export`)

A **full personal migration archive** (zip). Always includes: **all settings except machine-local keys** (`windowBounds`, `historyDir`, `claudePath`) — i.e. themes, custom models, **API keys**, **`customEndpoints` with tokens** — plus **provider login files** (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json` + `google_accounts.json`) and learned **skills**. The Backup dialog offers "app data only" vs "+ agent sessions" (the latter also bundles transcripts + `.convo.json`/`.archive.jsonl`). The zip contains secrets in plaintext — keep it private.

---

## 7. Process model & lifecycle (`main.js`)

1. **Portable mode** (before `store` loads): a `portable.flag`/`AtomNano-Data` folder next to the exe redirects userData and `CLAUDE_CONFIG_DIR` there, copying credentials in.
2. **Single-instance lock**: a second launch focuses/uses the existing instance.
3. **Window-per-project**: each `BrowserWindow` is one project folder; `openWindows` are restored on boot; bounds persisted.
4. **IPC registration** via `handle(channel, fn)` → returns `{ ok:true, data }` or `{ ok:false, error }`; preload's `invoke()` unwraps/throws.
5. **Broadcast/emitter**: `claude` (and fleet, etc.) `setEmitter()` → `broadcast(channel, payload)` fan-outs to every live window, so other windows see updates.
6. **File watching**: one recursive watcher per window root, coalesced, emitting `fs:changed`.
7. **TS utility process** spun up on demand and idle-killed; search runs in worker threads — heavy work stays off the main thread.

### Turn run loop (`claude.run`)

1. Renderer `atom.sessions.send` → `sessions:send` → `claude.run(id, payload)`.
2. Build options (cwd, model, permission mode, thinking, optional 1M beta, `resume` = `claudeSessionId`); inject context (graph/skills/convo/capabilities via `context.js`).
3. Stream `query()` messages → normalize to `session:message`, `session:partial`, tool cards, `session:edited-files`; tool calls gate through `canUseTool` → `session:permission` → renderer modal → `sessions:permission-response`.
4. **Resilience:** errors are classified — *transient* (network/429/529/5xx) retries with exponential backoff **keeping `claudeSessionId`** (context preserved); only a genuine "session not found" triggers a single fresh retry; exhausted retries surface an error but **never drop the resume id**, so a resend continues seamlessly.
5. On finish: persist transcript, fold old messages to `.convo.json`/`.archive.jsonl`, record into graph/skills/testdir, emit `session:status`.

---

## 8. Conventions an AI should follow when editing

- **UI is vanilla JS** — build DOM with `h()`; reuse `modalShell`, `dropdown`, `toast`, `confirmDialog`, `showContextMenu`. No frameworks, no inline styles where a CSS class exists; respect the `--var` theme tokens (never hardcode colors).
- **All renderer↔main traffic goes through preload** — add a namespaced method in `preload.js` + a `handle()` in `main.js`; never expose Node directly to the renderer.
- **Persistence** goes through `store.js` (sessions/settings) or the dedicated subsystem store (graph/skills/testdir/fleet). Keep new secret-ish settings in `GLOBAL_ONLY`.
- **Provider work** belongs in `providers.js`/`customApi.js`/`council.js`; the SDK turn lives in `claude.js`. Preserve the resilience contract (don't null `claudeSessionId` on transient errors).
- **Editor changes** edit `cm-src.js`, then run `npm run build:cm` (the committed `cm.bundle.js` is generated — never hand-edit it).
- **Heavy/optional deps** (Prettier, TypeScript, CodeMirror, localmind models) are lazy-loaded — keep them off the startup path.
- After backend changes, there are Playwright smoke tests under `smoke-tests/`; after UI changes, verify the app boots (`npm start`).

---

*Generated as a context briefing. File paths and the IPC namespace list were verified against the source tree; catalog-level details (per-module function names) reflect the modules' documented responsibilities.*
