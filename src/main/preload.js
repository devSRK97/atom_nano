"use strict";
const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).then((res) => {
    if (res && res.ok) return res.data;
    const err = new Error(res && res.error ? res.error : `IPC error: ${channel}`);
    // Typed failures (git) keep their classification and complete diagnostics.
    if (res && res.type) err.type = res.type;
    if (res && res.details) err.details = res.details;
    if (res && res.code != null) err.code = res.code;
    throw err;
  });
}

function on(channel, cb) {
  const wrapped = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("atomnano", {
  app: { info: () => invoke("app:info"), relaunch: () => ipcRenderer.send("app:relaunch") },
  win: {
    minimize: () => ipcRenderer.send("win:minimize"),
    maximize: () => ipcRenderer.send("win:maximize"),
    close: () => ipcRenderer.send("win:close"),
    forceClose: () => ipcRenderer.send("win:force-close"),
    onConfirmClose: (cb) => on("app:confirm-close", cb),
    isMaximized: () => invoke("win:is-maximized"),
    onMaxChange: (cb) => on("win:maximized-change", cb),
    project: () => invoke("win:project"),
    openProject: (path) => invoke("win:open-project", path),
    isOpen: (path) => invoke("win:is-open", path),
    pickOnOpen: () => invoke("win:pick-on-open"),
    setProject: (path) => invoke("win:set-project", path),
    setOverlay: (dataUrl, label) => invoke("win:set-overlay", dataUrl, label),
    setTagIcon: (dataUrl) => invoke("win:set-tag-icon", dataUrl),
  },
  project: {
    getTabs: (p) => invoke("project:get-tabs", p),
    saveTabs: (p, data) => invoke("project:save-tabs", p, data),
  },
  settings: {
    get: () => invoke("settings:get"),
    set: (partial) => invoke("settings:set", partial),
  },
  auth: {
    status: () => invoke("auth:status"),
    openLogin: () => invoke("auth:open-login"),
  },
  updates: {
    check: (opts) => invoke("updates:check", opts || null),          // { fresh } bypasses the npm-latest cache
    run: () => invoke("updates:run"),
    onProgress: (cb) => on("updates:progress", cb),
    toolVersions: () => invoke("tools:versions"),                    // installed versions (fast, offline)
    toolLatest: (installed, opts) => invoke("tools:latest", installed || null, opts || null),   // latest published per tool
    updateTool: (tool) => invoke("tools:update", tool),
  },
  providers: {
    authStatus: () => invoke("provider:auth-status"),
    authorize: (provider) => invoke("provider:authorize", provider),
    catalog: () => invoke("providers:catalog"),
    testCustom: (cfg) => invoke("provider:test-custom", cfg),
  },
  // Saved CLI logins for Claude ("anthropic", default) and Codex ("openai").
  profiles: {
    list: (provider) => invoke("profiles:list", provider || "anthropic"),
    live: (provider) => invoke("profiles:live", provider || "anthropic"),
    save: (label, provider) => invoke("profiles:save", label, provider || "anthropic"),
    saveCurrent: (provider) => invoke("profiles:save-current", provider || "anthropic"),
    switch: (label, provider) => invoke("profiles:switch", label, provider || "anthropic"),
    logout: (provider) => invoke("profiles:logout", provider || "anthropic"),
    delete: (label, provider) => invoke("profiles:delete", label, provider || "anthropic"),
    rename: (oldLabel, newLabel, provider) => invoke("profiles:rename", oldLabel, newLabel, provider || "anthropic"),
    export: (label, provider) => invoke("profiles:export", label, provider || "anthropic"),
    import: (provider) => invoke("profiles:import", provider || "anthropic"),
    onChanged: (cb) => on("profiles:changed", cb),
  },
  usage: { get: (force) => invoke("usage:get", force) },
  db: {
    // Profiles: list() carries NO secret values (hasPassword / hasUri / secretLocked / rev).
    kinds: () => invoke("db:kinds"),
    list: () => invoke("db:list"),
    save: (conn) => invoke("db:save", conn),                                  // password/uri: string | "" (clear) | { $keep: true }
    remove: (id) => invoke("db:remove", id),
    revealSecret: (id, field) => invoke("db:reveal-secret", id, field),      // explicit request only
    setSessionSecret: (id, fields) => invoke("db:session-secret", id, fields), // in-memory credential (never persisted)
    test: (connOrId) => invoke("db:test", connOrId),
    schema: (id) => invoke("db:schema", id),
    schemaMore: (id, opts) => invoke("db:schema-more", id, opts || null),    // Redis: continue the key scan / MATCH
    columns: (id, table) => invoke("db:columns", id, table),
    // Statements: opts { limit, session, opId, expectRev, argv (Redis) }. Cells are typed (see db.js VALUES).
    query: (id, text, opts) => invoke("db:query", id, text, opts || null),
    parallelQuery: (id, queries, opts) => invoke("db:parallel-query", id, queries, opts || null),
    splitScript: (id, text) => invoke("db:split-script", id, text),          // dialect-aware statements + parse errors
    formatSql: (id, text) => invoke("db:format-sql", id, text),
    sessionOpen: (id) => invoke("db:session-open", id),                      // a tab's pinned client (transactions, SET/USE)
    sessionClose: (sid, opts) => invoke("db:session-close", sid, opts || null),
    sessionSet: (sid, patch) => invoke("db:session-set", sid, patch),
    cancel: (opId) => invoke("db:cancel", opId),
    addColumn: (id, table, col, opts) => invoke("db:add-column", id, table, col, opts || null),   // opts.dryRun → SQL preview only
    dropColumn: (id, table, name, opts) => invoke("db:drop-column", id, table, name, opts || null),
    renameColumn: (id, table, oldName, newName, opts) => invoke("db:rename-column", id, table, oldName, newName, opts || null),
    addIndex: (id, table, spec, opts) => invoke("db:add-index", id, table, spec, opts || null),
    dropIndex: (id, table, name, opts) => invoke("db:drop-index", id, table, name, opts || null),
    schemaPlan: (id, table, plan, opts) => invoke("db:schema-plan", id, table, plan, opts || null),   // reviewed rename/drop/reorder plan; opts.dryRun
    ping: (id) => invoke("db:ping", id),
    exportFile: (opts) => invoke("db:export-file", opts),          // CSV / JSON / SQL / XLSX via save dialog (streams; complete|cancelled|failed)
    exportCancel: (token) => invoke("db:export-cancel", token),
    importPick: (opts) => invoke("db:import-pick", opts),          // open dialog → parsed preview + job token
    importRun: (opts) => invoke("db:import-run", opts),
    importCancel: (token) => invoke("db:import-cancel", token),
    importDiscard: (token) => invoke("db:import-discard", token),
    jobStatus: (token) => invoke("db:job-status", token),
    jobs: () => invoke("db:jobs"),
    onIoProgress: (cb) => on("db:io-progress", cb),
    reorderColumns: (id, table, order, opts) => invoke("db:reorder-columns", id, table, order, opts || null),
    tableInfo: (id, table) => invoke("db:table-info", id, table),            // columns + indexes + foreign keys + DDL
    count: (id, table, where) => invoke("db:count", id, table, where || ""),  // exact COUNT(*) (optionally filtered)
    browse: (id, table, opts) => invoke("db:browse", id, table, opts || null),   // one stable server-side page (hasMore, never an estimate)
    insertRow: (id, table, values, opts) => invoke("db:insert-row", id, table, values, opts || null),
    updateRows: (id, table, spec, opts) => invoke("db:update-rows", id, table, spec, opts || null), // { pk, set } — complete PK, returns the persisted row
    deleteRows: (id, table, pks, opts) => invoke("db:delete-rows", id, table, pks, opts || null),
    explain: (id, text) => invoke("db:explain", id, text),
    installDriver: (kind) => invoke("db:install-driver", kind),
    disconnect: (id) => invoke("db:disconnect", id),
    openWindow: () => invoke("db:open-window"),
  },
  models: {
    // provider optional → defaults to the current primary provider in main
    // opts.force → re-run the CLI alias probe even if the cache is fresh (after an update)
    discover: (provider, opts) => invoke("models:discover", provider, opts || null),
  },
  // The Codex runtime's EFFECTIVE account (type / email / plan) via account/read.
  codex: { account: (force) => invoke("codex:account", !!force), onAccount: (cb) => on("codex:account", cb) },
  image: {
    generate: (sessionId, prompt, opts) => invoke("image:generate", sessionId, prompt, opts),
  },
  mcp: {
    list: () => invoke("mcp:list"),
    upsert: (name, patch) => invoke("mcp:upsert", name, patch),
    remove: (name) => invoke("mcp:remove", name),
    rename: (oldName, newName) => invoke("mcp:rename", oldName, newName),
    openFile: () => invoke("mcp:open-file"),
  },
  // antigravity bridge removed — agy CLI integration is gone.
  cli: {
    status: () => invoke("cli:status"),
    enable: () => invoke("cli:enable"),
    disable: () => invoke("cli:disable"),
  },
  userdata: {
    export: (opts) => invoke("userdata:export", opts),
    import: () => invoke("userdata:import"),
  },
  dialog: {
    pickFolder: (d) => invoke("dialog:pick-folder", d),
    pickHistory: () => invoke("dialog:pick-history"),
  },
  sessions: {
    list: () => invoke("sessions:list"),
    create: (o) => invoke("sessions:create", o),
    synthesize: (srcId) => invoke("sessions:synthesize", srcId),
    get: (id) => invoke("sessions:get", id),
    messages: (id, end, count) => invoke("sessions:messages", id, end, count),
    search: (id, query) => invoke("sessions:search", id, query),   // full-text within one session (incl. archived); hits carry a global index
    prompts: (id) => invoke("sessions:prompts", id),               // every user prompt (archive + live) with its global index
    rename: (id, name) => invoke("sessions:rename", id, name),
    update: (id, patch) => invoke("sessions:update", id, patch),
    delete: (id) => invoke("sessions:delete", id),
    deleteMessage: (id, mid) => invoke("sessions:delete-message", id, mid),
    send: (id, payload) => invoke("sessions:send", id, payload),
    interrupt: (id, reason) => invoke("sessions:interrupt", id, reason),
    steer: (id, payload) => invoke("sessions:steer", id, payload),   // Codex: add to the running turn without stopping it
    running: (id) => invoke("sessions:running", id),
    runState: (id) => invoke("sessions:run-state", id),
    lastRun: () => invoke("sessions:last-run"),   // per-run diagnostics (provider, transport, auth context, sent model/effort, transferred entries)
    permissionResponse: (requestId, decision) => ipcRenderer.send("sessions:permission-response", requestId, decision),
    openHistory: () => invoke("sessions:open-history"),
    export: (ids, mode) => invoke("sessions:export", ids, mode),
    import: () => invoke("sessions:import"),
    retry: (id) => invoke("sessions:retry", id),
    // Live-query control requests (only act while a turn is running; see claude.js).
    contextUsage: (id) => invoke("sessions:context-usage", id),   // exact context-window breakdown
    mcpStatus: (id) => invoke("sessions:mcp-status", id),         // live MCP server health
    rewind: (id, userMessageId) => invoke("sessions:rewind", id, userMessageId), // rewind files to a past turn
    setModelLive: (id, model) => invoke("sessions:set-model-live", id, model),   // change model mid-turn
    setModeLive: (id, mode) => invoke("sessions:set-mode-live", id, mode),       // change permission mode mid-turn
  },
  files: {
    list: (d) => invoke("files:list", d),
    watch: (root) => invoke("files:watch", root),
    read: (p) => invoke("files:read", p),
    dataUrl: (p) => invoke("files:data-url", p),
    write: (p, content) => invoke("files:write", p, content),
    // Replace a file only if it still holds `expected` (the text that was loaded) → { ok } or { ok:false, conflict:true }
    writeChecked: (p, content, expected) => invoke("files:write-checked", p, content, expected),
    saveAs: (opts) => invoke("files:save-as", opts),
    reveal: (p) => invoke("files:reveal", p),
    open: (p) => invoke("files:open", p),
    openTerminal: (p) => invoke("files:open-terminal", p),
    resolveImport: (from, spec) => invoke("files:resolve-import", from, spec),
    size: (p) => invoke("files:size", p),
    trash: (p) => invoke("files:trash", p),
    createFile: (p, content) => invoke("files:create-file", p, content),
    createFolder: (p) => invoke("files:create-folder", p),
    // `root` is the project root — the language service needs it to rewrite the
    // imports that pointed at the old path (see files:rename in main).
    rename: (p, newName, root) => invoke("files:rename", p, newName, root),
    move: (from, to, root) => invoke("files:move", from, to, root),
    replaceInFiles: (opts) => invoke("files:replace-in-files", opts),
    findDefinition: (root, word, lang) => invoke("files:find-definition", root, word, lang),
    searchNames: (opts) => invoke("files:search-names", opts),
    searchContent: (opts) => invoke("files:search-content", opts),
  },
  git: {
    // Results of mutations are { ok, state: "success"|"conflict"|"rejected"|"choice"|"partial"|"failed", … };
    // failures THROW an Error carrying .type (notRepo|lock|auth|network|permission|invalid|notFound|timeout|…) and .details.
    cancel: (opId) => invoke("git:cancel", opId),                                  // stop the git processes of a running operation (see events.onGitProgress)
    watch: (repos) => invoke("git:watch", repos),                                  // watch these repos' .git metadata → events.onGitChanged
    repos: (root) => invoke("git:repos", root),
    probe: (cwd) => invoke("git:probe", cwd),                                      // { repo, root, error?, type? } — "not a repo" vs "cannot tell" are distinct
    isRepoDir: (dir) => invoke("git:is-repo-dir", dir),
    repoForFile: (filePath) => invoke("git:repo-for-file", filePath),
    status: (cwd, opts) => invoke("git:status", cwd, opts || null),
    branch: (cwd) => invoke("git:branch", cwd),
    stage: (cwd, files) => invoke("git:stage", cwd, files),
    unstage: (cwd, files) => invoke("git:unstage", cwd, files),
    stageAll: (cwd) => invoke("git:stage-all", cwd),
    stageTracked: (cwd) => invoke("git:stage-tracked", cwd),
    unstageAll: (cwd) => invoke("git:unstage-all", cwd),
    commit: (cwd, message, opts) => invoke("git:commit", cwd, message, opts),
    commitFiles: (cwd, message, files, opts) => invoke("git:commit-files", cwd, message, files, opts || null),
    // Reviewed plan: { message, paths: [{ path, orig?, untrack? }], amend?, expectHead? } → exactly those paths, hooks run
    commitPlan: (cwd, plan) => invoke("git:commit-plan", cwd, plan),
    pull: (cwd, opts) => invoke("git:pull", cwd, opts || null),
    push: (cwd, opts) => invoke("git:push", cwd, opts || null),
    pushPlan: (cwd, opts) => invoke("git:push-plan", cwd, opts || null),             // where a push would really go (remote, dest, upstream, oids)
    diff: (cwd, file, opts) => invoke("git:diff", cwd, file, opts),
    fileDiff: (cwd, file) => invoke("git:file-diff", cwd, file),
    branches: (cwd) => invoke("git:branches", cwd),
    checkout: (cwd, branch, opts) => invoke("git:checkout", cwd, branch, opts),
    merge: (cwd, branch, opts) => invoke("git:merge", cwd, branch, opts || null),
    mergeBranches: (cwd, source, target, message, opts) => invoke("git:merge-branches", cwd, source, target, message, opts || null),
    mergeAbort: (cwd) => invoke("git:merge-abort", cwd),
    mergeContinue: (cwd) => invoke("git:merge-continue", cwd),
    discard: (cwd, files) => invoke("git:discard", cwd, files),
    changedBetween: (cwd, from, to) => invoke("git:changed-between", cwd, from, to),
    commitsBetween: (cwd, from, to, opts) => invoke("git:commits-between", cwd, from, to, opts || null),
    refDiff: (cwd, from, to, file) => invoke("git:ref-diff", cwd, from, to, file),
    remoteUrl: (cwd, name) => invoke("git:remote-url", cwd, name),
    // ---- Git Center ----
    repoState: (cwd) => invoke("git:repo-state", cwd),
    rebaseSkip: (cwd) => invoke("git:rebase-skip", cwd),
    bisectReset: (cwd) => invoke("git:bisect-reset", cwd),
    fetch: (cwd, opts) => invoke("git:fetch", cwd, opts || null),
    pushBranch: (cwd, opts) => invoke("git:push-branch", cwd, opts || null),
    pullOpts: (cwd, opts) => invoke("git:pull-opts", cwd, opts || null),
    commitOpts: (cwd, message, opts) => invoke("git:commit", cwd, message, opts || null),
    log: (cwd, opts) => invoke("git:log", cwd, opts || null),
    commitInfo: (cwd, hash, opts) => invoke("git:commit-info", cwd, hash, opts || null),
    commitFileDiff: (cwd, hash, file, opts) => invoke("git:commit-file-diff", cwd, hash, file, opts || null),
    fileAt: (cwd, ref, file, opts) => invoke("git:file-at", cwd, ref, file, opts || null),   // typed: { binary, size, content, truncated, nextOffset }
    aheadBehind: (cwd, a, b) => invoke("git:ahead-behind", cwd, a, b),
    resolveRefs: (cwd, names) => invoke("git:resolve-refs", cwd, names),
    branchesDetailed: (cwd) => invoke("git:branches-detailed", cwd),
    branchCreate: (cwd, name, opts) => invoke("git:branch-create", cwd, name, opts || null),
    branchDelete: (cwd, name, opts) => invoke("git:branch-delete", cwd, name, opts || null),
    branchRename: (cwd, oldName, newName) => invoke("git:branch-rename", cwd, oldName, newName),
    setUpstream: (cwd, branch, upstream) => invoke("git:set-upstream", cwd, branch, upstream),
    checkoutRemote: (cwd, remoteBranch, opts) => invoke("git:checkout-remote", cwd, remoteBranch, opts || null),   // may return { state:"choice", existing, remote }
    rebase: (cwd, onto, opts) => invoke("git:rebase", cwd, onto, opts || null),
    cherryPick: (cwd, hashes, opts) => invoke("git:cherry-pick", cwd, hashes, opts || null),
    revert: (cwd, hash, opts) => invoke("git:revert", cwd, hash, opts || null),
    reset: (cwd, ref, mode, opts) => invoke("git:reset", cwd, ref, mode, opts || null),
    stashList: (cwd) => invoke("git:stash-list", cwd),
    stashSave: (cwd, opts) => invoke("git:stash-save", cwd, opts || null),
    // stash identity is the OBJECT ID: pass { hash } (an index is accepted only as a fallback)
    stashApply: (cwd, sel, opts) => invoke("git:stash-apply", cwd, sel, opts || null),
    stashDrop: (cwd, sel) => invoke("git:stash-drop", cwd, sel),
    stashShow: (cwd, sel) => invoke("git:stash-show", cwd, sel),
    stashFileDiff: (cwd, sel, file) => invoke("git:stash-file-diff", cwd, sel, file),
    tags: (cwd) => invoke("git:tags", cwd),
    tagCreate: (cwd, name, opts) => invoke("git:tag-create", cwd, name, opts || null),
    tagDelete: (cwd, name, opts) => invoke("git:tag-delete", cwd, name, opts || null),     // { remote } → remote first, then local; phases reported
    pushTag: (cwd, name, opts) => invoke("git:push-tag", cwd, name, opts || null),
    remotes: (cwd) => invoke("git:remotes", cwd),
    remoteAdd: (cwd, name, url) => invoke("git:remote-add", cwd, name, url),
    remoteRemove: (cwd, name) => invoke("git:remote-remove", cwd, name),
    remoteSetUrl: (cwd, name, url, opts) => invoke("git:remote-set-url", cwd, name, url, opts || null),
    untrack: (cwd, files) => invoke("git:untrack", cwd, files),                       // stop tracking, keep on disk
    pullFrom: (cwd, opts) => invoke("git:pull-from", cwd, opts || null),              // { remote, branch, rebase }
    conflictStages: (cwd, file) => invoke("git:conflict-stages", cwd, file),          // { base, ours, theirs, binary, modifyDelete }
    resolveWith: (cwd, files, side) => invoke("git:resolve-with", cwd, files, side),  // whole-file ours/theirs + stage (side = git's own ours/theirs)
    archiveZip: (cwd, ref, suggested) => invoke("git:archive-zip", cwd, ref, suggested),
    commitZip: (cwd, hash, suggested, opts) => invoke("git:commit-zip", cwd, hash, suggested, opts || null),
  },
  ts: {
    diagnose: (root, file, text) => invoke("ts:diagnose", root, file, text),
    req: (kind, root, file, payload) => invoke("ts:request", kind, root, file, payload),
  },
  editorconfig: (filePath) => invoke("editorconfig:get", filePath),
  // This project's skills (the Workflow studio's Skills modal is the only UI, 2026-09-18).
  skills: {
    list: (cwd) => invoke("skills:list", cwd),
    create: (cwd, input) => invoke("skills:create", cwd, input),
    update: (cwd, id, patch) => invoke("skills:update", cwd, id, patch),
    remove: (cwd, id) => invoke("skills:remove", cwd, id),
    importUrl: (cwd, url) => invoke("skills:import-url", cwd, url),   // JSON (object / array) or SKILL.md → skills
  },
  // Sub-agents (Task / Agent tool workers): the session's registry, the CPU governor, per-agent stop.
  agents: {
    list: (id) => invoke("agents:list", id),            // { agents:[…], total, running, seq }
    cpu: () => invoke("agents:cpu"),                    // governor snapshot: cores, busy %, slots, throttled
    stop: (id, taskId) => invoke("agents:stop", id, taskId),
  },
  // Context window: fill / effective window / rolling digest for the composer chip.
  context: {
    info: (id) => invoke("context:info", id),
    rollover: (id, on) => invoke("context:rollover", id, on),   // continue in a fresh native session on the next message
    digest: (id) => invoke("context:digest", id),               // build / refresh the rolling digest now
    digestText: (id) => invoke("context:digest-text", id),
  },
  // Workflow (orchestrator-as-primary; docs/WORKFLOW_CONTRACT.md §6): the ACTIVE workflow + the saved
  // library, role jobs of an orchestrator session, the generated orchestrator brief, the CLI control server.
  // PER-SESSION (contract §10, 2026-09-18): pass the session id and the call reads / writes THAT tab's own
  // workflow (a tab without one shows the project's and gets its own copy on the first edit); without it the
  // project's active workflow — of `cwd` when given, else of this window's current project. The renderer passes
  // the project it CAPTURED when the action started (round 4, 2026-09-18 — the library calls take it as their
  // trailing argument): a Save As whose name dialog was still open when the user switched projects is saved into
  // the project it was started in, not the one current when the IPC arrives. With a session id the cwd is
  // ignored — the tab's project is the session's own. `scope` in the reply says which one answered ("session" | "project").
  workflow: {
    get: (cwd, sessionId) => invoke("workflow:get", cwd, sessionId),                 // { active, scope, library, control:{ url, running, binDir } }
    set: (patch, cwd, sessionId) => invoke("workflow:set", patch, cwd, sessionId),   // deep-merge patch into the active workflow → { active, scope }
    clearSession: (sessionId) => invoke("workflow:clear", sessionId),                 // drop the tab's own workflow → the project's → { active, scope:"project" }
    save: (name, id, sessionId, cwd) => invoke("workflow:save", name, id, sessionId, cwd),     // active → library entry (new, or overwrite id) → { library, active, entry, scope }
    load: (id, sessionId, cwd) => invoke("workflow:load", id, sessionId, cwd),                 // library entry → active → { active, scope }
    remove: (id, sessionId, cwd) => invoke("workflow:delete", id, sessionId, cwd),             // → { library, active }
    rename: (id, name, sessionId, cwd) => invoke("workflow:rename", id, name, sessionId, cwd), // → { library, active }
    duplicate: (id, name) => invoke("workflow:duplicate", id, name),                 // → { library, entry }
    exportOne: (id, path) => invoke("workflow:export", id, path),  // id null = active; path omitted → save dialog → { ok, path } | { canceled }
    importFile: (path) => invoke("workflow:import", path),         // path omitted → open dialog → { entry, library } | { canceled }
    jobs: (sessionId) => invoke("workflow:jobs", sessionId),       // → { jobs }
    run: (sessionId, req) => invoke("workflow:run", sessionId, req),   // { role, task, files, agents, taskRef?, context?, fresh?, fromJob? } → { job } (fromJob: a finished job of this orchestrator whose saved result travels with the task)
    stop: (jobId) => invoke("workflow:stop", jobId),               // → { ok, detail? }
    stopAll: (sessionId) => invoke("workflow:stopAll", sessionId), // every live job of the orchestrator → { stopped }
    brief: (sessionId) => invoke("workflow:brief", sessionId),     // → { text, generated }
    control: () => invoke("workflow:control"),                     // → { url, running, binDir }
  },
  // Task board of an orchestrator session (contract §8.3) — user actions (`by: "user"`). A role child's id
  // resolves to its orchestrator's board. Every reply carries the fresh `board`; changes also arrive as events.onTasks.
  tasks: {
    get: (sessionId) => invoke("tasks:get", sessionId),                             // → { board, sessionId }
    add: (sessionId, req) => invoke("tasks:add", sessionId, req),                   // { titles | items:[{ title, detail?, role? }], set?:{ title } } → { set, items, board }
    update: (sessionId, ref, patch) => invoke("tasks:update", sessionId, ref, patch),   // ref "T12" | id; { status?, role?, title?, detail?, note? } → { item, board }
    newSet: (sessionId, title) => invoke("tasks:new-set", sessionId, title),        // → { set, board }
    remove: (sessionId, ref) => invoke("tasks:remove", sessionId, ref),             // → { ok, board }
  },
  fleet: {
    list: () => invoke("fleet:list"),
    enqueue: (cwd, task) => invoke("fleet:enqueue", cwd, task),
    enqueueMany: (cwd, items) => invoke("fleet:enqueue-many", cwd, items),
    cancel: (id) => invoke("fleet:cancel", id),
    retry: (id) => invoke("fleet:retry", id),
    remove: (id) => invoke("fleet:remove", id),
    clearFinished: () => invoke("fleet:clear-finished"),
  },
  testdir: {
    list: (cwd, filter) => invoke("testdir:list", cwd, filter),
    get: (cwd, id) => invoke("testdir:get", cwd, id),
    upsert: (cwd, t, opts) => invoke("testdir:upsert", cwd, t, opts),
    remove: (cwd, id) => invoke("testdir:remove", cwd, id),
    retag: (cwd, id, patch) => invoke("testdir:retag", cwd, id, patch),
    select: (cwd, sel) => invoke("testdir:select", cwd, sel),
    run: (cwd, id, opts) => invoke("testdir:run", cwd, id, opts),
    runSelection: (cwd, sel, opts) => invoke("testdir:run-selection", cwd, sel, opts),
    flakeGate: (cwd, ids, n) => invoke("testdir:flake-gate", cwd, ids, n),
    peek: (cwd) => invoke("testdir:peek", cwd),
    classify: (source) => invoke("testdir:classify", source),
    integrity: (oldT, newT) => invoke("testdir:integrity", oldT, newT),
    goalCreate: (cwd, g) => invoke("testdir:goal-create", cwd, g),
    goalUpdate: (cwd, id, patch) => invoke("testdir:goal-update", cwd, id, patch),
    goalApprove: (cwd, id) => invoke("testdir:goal-approve", cwd, id),
    goalAttach: (cwd, gid, tid) => invoke("testdir:goal-attach", cwd, gid, tid),
    goals: (cwd) => invoke("testdir:goals", cwd),
    goalGreen: (cwd, id) => invoke("testdir:goal-green", cwd, id),
  },
  testhost: { run: (target, steps) => invoke("testhost:run", target, steps) },
  director: {
    plan: (cwd, prompt, opts) => invoke("director:plan", cwd, prompt, opts),
    approve: (cwd, goalId) => invoke("director:approve", cwd, goalId),
    run: (cwd, goalId, opts) => invoke("director:run", cwd, goalId, opts),
  },
  test: {
    fleetFakeRunner: (holdMs) => invoke("test:fleet-fake-runner", holdMs),
    fleetLog: () => invoke("test:fleet-log"),
    councilRunner: () => invoke("test:council-runner"),
    councilConsult: (cwd, reviewers, prompt) => invoke("test:council-consult", cwd, reviewers, prompt),
    councilReview: (cwd, reviewers, prompt, answer) => invoke("test:council-review", cwd, reviewers, prompt, answer),
    lastRunPayload: () => invoke("test:last-run-payload"),
    clearLastRunPayload: () => invoke("test:clear-last-run-payload"),
    fakeRunning: (id, on) => invoke("test:fake-running", id, on),
    settingsScope: () => invoke("test:settings-scope"),
    newPickWindow: () => invoke("test:new-pick-window"),
    openaiRun: (cwd, text) => invoke("test:openai-run", cwd, text),
    imagegenFake: (fail, vector) => invoke("test:imagegen-fake", fail, vector),
    discoverFake: (provider) => invoke("test:discover-fake", provider),
    directorScenario: (cwd, scenario) => invoke("test:director-scenario", cwd, scenario),
    astProbe: (kind, source) => invoke("test:ast", kind, source),
    userdataExport: (p) => invoke("test:userdata-export", p),
    userdataImport: (p) => invoke("test:userdata-import", p),
  },
  prettier: { langs: () => invoke("prettier:langs"), format: (text, lang, tabSize) => invoke("prettier:format", text, lang, tabSize) },
  lsp: {
    langs: () => invoke("lsp:langs"),
    diagnose: (root, ext, file, text) => invoke("lsp:diagnose", root, ext, file, text),
    req: (kind, root, ext, file, payload) => invoke("lsp:request", kind, root, ext, file, payload),
    onDiagnostics: (cb) => on("lsp:diagnostics", cb),
  },
  clipboard: { write: (t, html) => invoke("clipboard:write", t, html), read: () => invoke("clipboard:read") },
  shell: { openExternal: (u) => invoke("shell:open-external", u) },
  events: {
    onMessage: (cb) => on("session:message", cb),
    onMessageUpdate: (cb) => on("session:message-update", cb),
    onStatus: (cb) => on("session:status", cb),
    onPartial: (cb) => on("session:partial", cb),
    onPartialReset: (cb) => on("session:partial-reset", cb),
    onEditedFiles: (cb) => on("session:edited-files", cb),
    onPermission: (cb) => on("session:permission", cb),
    onPermissionCancel: (cb) => on("session:permission-cancel", cb),
    // Transient run state (compacting / requesting / retrying / signing in) → the live label.
    onLive: (cb) => on("session:live", cb),
    // Sub-agent registry changes { sessionId, agent, total, running, seq }; CPU governor snapshots; context info.
    onAgents: (cb) => on("agents:update", cb),
    onCpu: (cb) => on("agents:cpu", cb),
    onContext: (cb) => on("session:context", cb),
    // A one-line notification the CLI asked the host to show (toast).
    onNotice: (cb) => on("session:notice", cb),
    onModels: (cb) => on("models:update", cb),
    onFsChange: (cb) => on("fs:changed", cb),
    // Git: live operation events { kind: "start"|"output"|"end", opId, label, cwd, stream, text, ok, error } and
    // repository metadata changes made outside the app { repo } (see git.watch).
    onGitProgress: (cb) => on("git:progress", cb),
    onGitChanged: (cb) => on("git:changed", cb),
    onFleet: (cb) => on("fleet:update", cb),
    onDirector: (cb) => on("director:update", cb),
    onSubagentBlocked: (cb) => on("subagent:blocked", cb),
    // A settings / session / archive write failed — the UI must say so.
    onStoreError: (cb) => on("store:error", cb),
    onPromptSuggestion: (cb) => on("session:prompt-suggestion", cb), // predicted next prompt (composer chip)
    onNetStatus: (cb) => on("net:status", cb),
    onAuthStatus: (cb) => on("auth:status", cb),
    // Integrated terminal: output arrives as it is produced, not on request.
    onTerminalData: (cb) => on("terminal:data", cb),
    onTerminalExit: (cb) => on("terminal:exit", cb),
    onTerminalClosed: (cb) => on("terminal:closed", cb),
    onTerminalCleared: (cb) => on("terminal:cleared", cb),
    // One command finished (not the shell) — carries the token runTracked returned.
    onTerminalCommandExit: (cb) => on("terminal:command-exit", cb),
    // Workflow: a role/command job changed { job }; an orchestrator's stage changed { sessionId, stage, status,
    // jobId?, provider, model }; a child session was created for a job { view, parentId, role }.
    onWorkflowJob: (cb) => on("workflow:job", cb),
    onWorkflowStage: (cb) => on("workflow:stage", cb),
    onSessionCreated: (cb) => on("session:created", cb),
    // A session's OWN workflow changed { sessionId, workflow | null } (null = back to the project's).
    onSessionWorkflow: (cb) => on("session:workflow", cb),
    // Task board: the WHOLE board of an orchestrator session after any change { sessionId, board }.
    onTasks: (cb) => on("tasks:update", cb),
  },
  terminal: {
    create: (opts) => invoke("terminal:create", opts),
    write: (id, data) => invoke("terminal:write", id, data),
    run: (id, command) => invoke("terminal:run", id, command),
    runTracked: (id, command) => invoke("terminal:run-tracked", id, command),
    resize: (id, cols, rows) => invoke("terminal:resize", id, cols, rows),
    interrupt: (id) => invoke("terminal:interrupt", id),
    clear: (id) => invoke("terminal:clear", id),
    kill: (id) => invoke("terminal:kill", id),
    list: () => invoke("terminal:list"),
    buffer: (id) => invoke("terminal:buffer", id),
    rename: (id, title) => invoke("terminal:rename", id, title),
  },
});
