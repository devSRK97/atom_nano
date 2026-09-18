/* AtomNano renderer — Entry — boots the renderer (init) and wires every module together.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { autoGrow, buildComposer, dispatchNextQueued, looksLikeImageRequest, modelDD, refreshAuthBanner, renderAttachments, renderQueue, send, setSharedSetting, toggleReviewersPopover, updateSendButton, updateStats } from "./chat/composer.js";
import { initTooltips, wireChatDelegation, wireEvents } from "./chat/events.js";
import { _liveRaf, _liveTimer, cancelLiveUpdate, openImageViewer, renderLive, renderPerms, respondPerm, scheduleLiveUpdate, wireChatScroll } from "./chat/messages.js";
import { chatFind, closeChatSearch, doChatFind, loadOlder, openChatSearch, renderMessagesRegion, stepChatFind, synthesizeSession } from "./chat/navigation.js";
import { addTabState, refreshUsage, renderTabs, wireChatHeader } from "./chat/tabs.js";
import { MODELS, REASONING_KIND, THINKING, applyCustomModels, loadProviderModels, setDiscoveredModels } from "./core/catalog.js";
import { $, confirmDialog, copyText, h, hideContextMenu, mdToRichHtml, samePath, toast } from "./core/dom.js";
import { wireGlobalKeys, wireResizers } from "./core/keys.js";
import { activeTS, atom, state } from "./core/state.js";
import { applyEditorFontFamily, applyEditorZoom, applyFontSize, applyTheme, applyWindowTitle } from "./core/theme.js";
import { createCheckpoint, restoreCheckpoint } from "./editor/checkpoints.js";
import { activateEditorFile, closeSplit, cm, computeEditorOverflow, editorGotoDefinition, editorOverflowMenu, editors, focusPane, gitGutterRefreshAll, openInEditor, renderEditorTabs, setupLsp, stateActiveFile, syncFileContent, toggleMarkdownPreview, toggleSplit, toggleSplitOrientation } from "./editor/editor-pane.js";
import { openSearch } from "./editor/search-palette.js";
import { editorFindReferences, fetchEditorSymbols, jumpTo, navGo, openSymbolPicker, scanProjectProblems } from "./editor/symbols.js";
import { gitCheckout, gitCheckoutNew, gitMerge, gitMergeAbort, openBranchMenu } from "./git/branches.js";
import { _merge, bulkResolve, closeMerge, completeMerge, conflictedFiles, markFileResolved, mergeResolvedCount, openConflictResolver, resolveConflict, switchTab } from "./git/conflicts-ui.js";
import { _diffNav, closeDiff, gDiffView, openCompare, openDiff, setDiffView } from "./git/diff-viewer.js";
import { commitSelected, gitFileMenu, gitRepoMenu, gitStageFiles, gitUnstageFiles, pullAll, pushAll, pushRepo, refreshGit, renderGitView, scheduleGitRefresh, setSidebarView } from "./git/sidebar.js";
import { gitProjectRoot, renderFolderActions, renderTitlebarActions, repoFiles, setSel, totalSelected } from "./git/titlebar.js";
import { icon } from "./icons.js";
import { renderChanges, showDock, toggleChanges, toggleChat, toggleFleet, toggleTests } from "./panels/changes.js";
import { dispatchFleet, fleetSnap, renderFleet, setFleetDraft } from "./panels/fleet.js";
import { checkUpdatesAndChip, openDbManagerFull, openSettings } from "./settings/settings.js";
import { openWorkflowStudio } from "./workflow/index.js";
import { pickProjectForNewWindow, pushRecent, restoreSplit, seedRecentsIfEmpty } from "./workspace/projects.js";
import { onFsChanged, renderSidebar } from "./workspace/sidebar.js";
import { toggleTerminal, wireTerminalEvents } from "./workspace/terminal.js";

/* ============================================================
   STANDALONE DBM WINDOW
   ============================================================ */
export async function initStandaloneDbm() {
  // apply saved theme/font before showing anything
  try { const s = await atom.settings.get(); applyTheme(s.theme); applyFontSize(s.fontSize); } catch {}
  // window controls
  $("brandMark").innerHTML = icon("db", 16);
  document.querySelector(".brand-name").innerHTML = 'Atom<span class="brand-accent">Nano</span>&thinsp;<span style="opacity:.45;font-weight:400">· DB</span>';
  // close the DBM window immediately on confirm (no agent sessions to worry about)
  atom.win.onConfirmClose(() => atom.win.forceClose());
  // mount DBM inside #body (already a flex row container)
  const bodyEl = $("body");
  bodyEl.innerHTML = "";
  const root = h("div", { id: "dbmRoot" });
  bodyEl.append(root);
  await openDbManagerFull(root);
}
/* ============================================================
   INIT
   ============================================================ */
export async function init() {
  // window controls
  $("brandMark").innerHTML = icon("atom", 20);
  $("winMin").innerHTML = icon("minimize", 15);
  $("winMax").innerHTML = icon("maximize", 13);
  $("winClose").innerHTML = icon("close", 15);
  $("winMin").onclick = () => atom.win.minimize();
  $("winMax").onclick = () => atom.win.maximize();
  $("winClose").onclick = () => atom.win.close();
  atom.win.onMaxChange((max) => { $("winMax").innerHTML = icon(max ? "restore" : "maximize", 13); });
  // Host platform: macOS keeps its native traffic lights (our window buttons hide, the title bar
  // leaves room for them) and names the "taskbar" tile the Dock tile.
  atom.app.info().then((i) => { state.platform = i && i.platform; if (state.platform === "darwin") document.body.classList.add("mac"); }).catch(() => {});
  // Standalone DBM window — load the full manager, skip chat/session init.
  if (new URLSearchParams(window.location.search).get("dbm") === "1") { await initStandaloneDbm(); return; }
  // Close confirmation — same in-app modal as the project chooser (no native box).
  atom.win.onConfirmClose(({ running, isLast, project }) => {
    // Multiple windows = multiple projects. Say which one is closing, and make
    // clear that a non-last window closes just that window (the app stays open).
    const name = project ? String(project).replace(/\\/g, "/").split("/").filter(Boolean).pop() : "";
    const last = isLast !== false;
    const title = last ? "Close AtomNano" : `Close ${name || "this window"}`;
    const label = last ? "Close AtomNano" : "Close window";
    const tail = last
      ? "Open sessions are saved to history and can be reopened anytime."
      : `Other windows stay open. ${name ? "This project's" : "Its"} sessions are saved to history.`;
    confirmDialog({
      title, ic: "alert", confirmLabel: label,
      message: running
        ? `${running} session${running > 1 ? "s are" : " is"} still running in ${name || "this project"} and will be stopped. ${tail}`
        : tail,
      onConfirm: () => atom.win.forceClose(),
    });
  });
  // project name shown after the brand (distinguishes windows)
  $("brandMark").parentElement.append(h("span", { class: "brand-project", id: "brandProject" }));
  // Chat show/hide toggle lives in the title bar so it stays reachable even when
  // the chat section (which now holds the session tabs) is collapsed.
  const chatToggle = h("button", { id: "chatToggle", class: "win-btn", title: "Hide chat (Ctrl+\\)", html: icon("chat", 15), onclick: () => toggleChat() });
  $("winMin").parentElement.insertBefore(chatToggle, $("winMin"));
  // top-right sequence: "Code Agent" label, then Settings, then the chat toggle
  const settingsBtn = h("button", { id: "tbSettings", class: "win-btn", title: "Settings (Ctrl+,)", html: icon("settings", 15), onclick: () => openSettings() });
  $("winMin").parentElement.insertBefore(settingsBtn, chatToggle);
  // DBM — database manager, sits right after the gear.
  const dbmBtn = h("button", { id: "tbDbm", class: "win-btn", title: "Database Manager", html: icon("db", 15), onclick: () => atom.db.openWindow() });
  $("winMin").parentElement.insertBefore(dbmBtn, chatToggle);
  // Terminal toggle — sits before the "Code Agent" label in the top-right run.
  const terminalBtn = h("button", { id: "terminalBtn", class: "win-btn", title: "Terminal (Ctrl+`)", html: icon("terminal", 15), onclick: () => toggleTerminal() });
  $("winMin").parentElement.insertBefore(terminalBtn, settingsBtn);
  $("winMin").parentElement.insertBefore(h("span", { class: "tb-agent-label", text: "Code Agent" }), terminalBtn);
  wireTerminalEvents();

  // "Update available" chip (before the window controls)
  const chip = h("button", { class: "update-chip hidden", id: "updateChip", title: "An update is available — open Settings", onclick: () => openSettings() },
    h("span", { html: icon("arrowUp", 13) }), h("span", { text: "Update" }));
  $("winMin").parentElement.insertBefore(chip, $("winMin"));

  state.settings = await atom.settings.get();
  applyTheme(state.settings.theme || state.settings.accent || "amber");
  applyFontSize(state.settings.fontSize);
  state.editor.fontSize = state.settings.editorFontSize || 13;
  applyEditorZoom();
  applyEditorFontFamily(state.settings.editorFontFamily);
  setDiscoveredModels(state.settings.discoveredModels);
  applyCustomModels(state.settings.customModels);
  // Newly-discovered Anthropic ids only refresh the model list while Anthropic is
  // the active provider (otherwise they'd clobber Gemini/OpenAI's catalog).
  atom.events.onModels(({ ids, provider }) => {
    // Codex: the installed Codex re-listed its models (update / login switch) —
    // re-apply if Codex is the active provider, with the "new models" toast.
    if (provider === "openai") { if ((state.settings.llmProvider || "anthropic") === "openai") loadProviderModels("openai", { announce: true, instant: false }); return; }
    if (!Array.isArray(ids)) return;
    setDiscoveredModels(ids);
    // A model learned mid-run (first prompt on a brand-new model) or by another
    // window: re-apply through the single provider path (catalog + discovered +
    // custom) so it lands in the dropdown right away, with a toast.
    if ((state.settings.llmProvider || "anthropic") === "anthropic") loadProviderModels("anthropic", { announce: true, instant: false });
  });
  // Saved-login bookkeeping happens in the main process (token rotation, logins made
  // in a terminal, sign-outs). Reflect it: refresh the auth banner and say what happened.
  if (atom.profiles && atom.profiles.onChanged) atom.profiles.onChanged(({ provider, label, created, loggedOut, loggedIn }) => {
    const brand = provider === "openai" ? "Codex" : "Claude";
    if (loggedOut) toast(`${brand} signed out — saved accounts are kept`, "key", { ms: 4000 });
    else if (created) toast(`New ${brand} login saved as “${label}”`, "key", { ms: 4000 });
    else if (loggedIn) toast(`${brand} signed in${label ? " as " + label : ""}`, "key", { ms: 3000 });
    setTimeout(() => { try { refreshAuthBanner(); renderTabs(); } catch { /* not built yet */ } }, 200);
  });
  atom.events.onFsChange(() => onFsChanged());   // keep tree/editor/git in sync with external changes
  // Git METADATA changed outside the app (terminal commit / checkout / fetch / index-only
  // staging — none of which the tree watcher sees): refresh the sidebar's repo snapshot and
  // the editor gutters. Coalesced; the Git Center subscribes to the same event itself.
  if (atom.events.onGitChanged) atom.events.onGitChanged(() => { if (state._fsSyncOff) return; scheduleGitRefresh(); try { gitGutterRefreshAll(); } catch { /* */ } });
  state.providerCatalog = await atom.providers.catalog().catch(() => null);   // reviewer model pickers
  // Google was removed as a provider — migrate any session pinned to it.
  if (state.settings.llmProvider === "google") { state.settings.llmProvider = "anthropic"; atom.settings.set({ llmProvider: "anthropic" }).catch(() => {}); }
  if (Array.isArray(state.settings.reviewers)) {
    const noG = state.settings.reviewers.filter((r) => r && r.provider !== "google");
    if (noG.length !== state.settings.reviewers.length) { state.settings.reviewers = noG; atom.settings.set({ reviewers: noG }).catch(() => {}); }
  }
  loadProviderModels(state.settings.llmProvider || "anthropic", { announce: true });   // models + reasoning + 1M for the active provider

  // This window's project (folder), passed by the main process.
  state.project = (await atom.win.project().catch(() => "")) || state.settings.lastFolder;
  applyWindowTitle();
  // Taskbar "New Window" → prompt the user to choose a project for this window.
  atom.win.pickOnOpen().then((pick) => { if (pick) setTimeout(() => pickProjectForNewWindow(), 250); }).catch(() => {});

  const list = await atom.sessions.list();
  seedRecentsIfEmpty(list);
  pushRecent(state.project);
  const existing = new Set(list.map((s) => s.id));
  const pt = await atom.project.getTabs(state.project).catch(() => null);
  let open = ((pt && pt.openTabIds) || []).filter((id) => existing.has(id));
  let activeId = pt && pt.activeTabId;
  // legacy fallback (pre multi-window): global openTabIds for the last folder
  if (!open.length && samePath(state.project, state.settings.lastFolder) && Array.isArray(state.settings.openTabIds)) {
    open = state.settings.openTabIds.filter((id) => existing.has(id));
    activeId = activeId || state.settings.activeTabId;
  }
  // else: most recent existing session in this project
  if (!open.length) {
    const inProj = list.filter((s) => samePath(s.cwd, state.project)).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    if (inProj.length) open = [inProj[0].id];
  }
  if (!open.length) { const s = await atom.sessions.create({ cwd: state.project }); open = [s.id]; }
  for (const id of open) { const v = await atom.sessions.get(id); if (v) addTabState(v); }
  state.order = open.filter((id) => state.tabs.has(id));
  state.activeTabId = state.tabs.has(activeId) ? activeId : state.order[0];

  buildComposer();
  wireChatHeader();
  renderTabs();
  await switchTab(state.activeTabId, true);

  // Restore this project's open editor file tabs (quietly skip any that are gone).
  const savedFiles = (pt && pt.editorOpenFiles) || (samePath(state.project, state.settings.lastFolder) ? state.settings.editorOpenFiles : null) || [];
  for (const p of savedFiles) { const sz = await atom.files.size(p).catch(() => -1); if (sz >= 0 && sz <= 5 * 1024 * 1024) await openInEditor(p, true); }  // skip missing/huge on restore
  const savedActive = (pt && pt.editorActiveFile) || (samePath(state.project, state.settings.lastFolder) ? state.settings.editorActiveFile : null);
  if (savedActive && state.editor.open.find((f) => f.path === savedActive)) activateEditorFile(savedActive);
  restoreSplit(pt);

  wireEvents();
  wireGlobalKeys();
  setupLsp();
  initTooltips();
  wireChatDelegation();
  wireChatScroll();
  wireResizers();
  renderTitlebarActions();
  refreshGit();                          // populate branch + git toolbar state
  window.addEventListener("focus", () => { if (gitProjectRoot()) scheduleGitRefresh(); refreshAuthBanner(); refreshUsage(); });   // keep git status + auth banner + usage fresh
  checkUpdatesAndChip();
  refreshUsage();                        // real Claude usage for the active-tab tooltip
  setInterval(() => refreshUsage(), 60000);

  // Automation-only hook (Playwright sets navigator.webdriver); never present in
  // normal use, so it can't be reached by users.
  if (navigator.webdriver) {
    window.__openInEditor = (p) => openInEditor(p); window.__openSearch = (o) => openSearch(o || {}); window.__cm = () => cm;
    window.__copyText = (t, label, html) => copyText(t, label, html); window.__mdToRichHtml = (md) => mdToRichHtml(md);
    // ---- editor tab overflow drivers ----
    window.__etOverflow = () => { const host = $("editorTabs"); const ov = host && host.querySelector(".et-overflow"); const menu = document.querySelector(".et-menu"); return { hiddenCount: ov ? (ov._hidden || []).length : 0, menuOpen: !!menu, menuRows: menu ? menu.querySelectorAll(".et-menu-row").length : 0, menuPaths: menu ? [...menu.querySelectorAll(".et-menu-name")].map((n) => n.title) : [], visiblePaths: host ? [...host.querySelectorAll(".editor-tab:not(.et-hidden)")].map((t) => t.dataset.path) : [] }; };
    window.__etForce = (px) => { const host = $("editorTabs"); if (host) host.style.maxWidth = (px || 220) + "px"; computeEditorOverflow(); return window.__etOverflow(); };
    window.__etOpenMenu = () => { const ov = $("editorTabs") && $("editorTabs").querySelector(".et-overflow"); if (ov && !ov.classList.contains("hidden")) editorOverflowMenu({ currentTarget: ov }); return window.__etOverflow(); };
    window.__etRemoveFirst = () => { const x = document.querySelector(".et-menu .et-menu-row .et-menu-x"); if (x) x.click(); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.__etOverflow())))); };
    window.__etClickOutside = () => { document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return window.__etOverflow(); };
    window.__gotoDef = (pos) => { const f = stateActiveFile(); if (f) editorGotoDefinition(f, pos); };
    window.__sidebarView = (v) => setSidebarView(v);
    window.__renderGitView = (s) => { const repo = (s && s.__repo) || "repo"; state.git.repos = s && s.repo ? [repo] : []; state.git.statuses = s && s.repo ? { [repo]: s } : {}; state.git.selected = new Set(); state.sidebarView = "git"; renderTitlebarActions(); renderFolderActions(); renderGitView(); };
    window.__pushRepo = (r) => pushRepo(r);
    // ---- multi-project git drivers (selection-based commit/push/pull) ----
    window.__setProject = async (p) => { state.project = p; state.sidebarView = "git"; renderSidebar(); await refreshGit(); return { repos: state.git.repos.slice() }; };
    window.__refreshGit = () => refreshGit();
    window.__gitRepos = () => (state.git.repos || []).slice();
    window.__gitSelect = (repo, paths, on = true) => { for (const p of [].concat(paths)) setSel(repo, p, on); renderGitView(); return totalSelected(); };
    window.__gitSelectAll = (on = true) => { for (const r of state.git.repos || []) for (const f of repoFiles(r)) setSel(r, f.path, on); renderGitView(); return totalSelected(); };
    window.__gitSelected = () => [...state.git.selected];
    window.__setGitMessage = (m) => { state.git.message = m; const t = document.getElementById("gvMessage"); if (t) t.value = m; };
    window.__commitSelected = (push) => commitSelected(push);
    window.__pushAll = () => pushAll();
    window.__pullAll = () => pullAll();
    window.__gitStatuses = () => JSON.parse(JSON.stringify(state.git.statuses));
    // ---- commit-view context menus + compare-branches drivers ----
    window.__openCompare = (repo, source, target) => openCompare(repo, source, target);
    window.__openBranchMenu = (repo) => openBranchMenu(repo, { clientX: 120, clientY: 120 });
    window.__hideCtx = () => hideContextMenu();
    window.__gitFileMenu = (repo, f) => gitFileMenu({ clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} }, repo, f);
    window.__gitRepoMenu = (repo, tracked, untracked) => gitRepoMenu({ clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} }, repo, tracked || [], untracked || []);
    window.__ctxItems = () => [...document.querySelectorAll("#ctxMenu .ctx-item")].map((el) => el.textContent.trim());
    window.__ctxClick = (label) => { const el = [...document.querySelectorAll("#ctxMenu .ctx-item")].find((e) => e.textContent.trim() === label); if (el) { el.click(); return true; } return false; };
    window.__gitStage = (repo, paths) => gitStageFiles(repo, paths);
    window.__gitUnstage = (repo, paths) => gitUnstageFiles(repo, paths);
    // ---- filesystem-sync drivers ----
    window.__openTree = async (p) => { state.project = p; state.sidebarView = "files"; await renderSidebar(); return state._watchedRoot || ""; };
    window.__treeNames = () => [...document.querySelectorAll("#fileTree .tw-name")].map((e) => e.textContent);
    window.__watchedRoot = () => state._watchedRoot || "";
    window.__editorCM = () => (cm ? cm.view.state.doc.toString() : null);
    window.__editorState = () => { const f = stateActiveFile(); if (f) syncFileContent(f, cm); return f ? { path: f.path, content: f.content, saved: f.saved, dirty: f.dirty } : null; };
    window.__editorType = (text) => { const f = stateActiveFile(); if (!f) return; f.content = text; f.dirty = (f.content !== f.saved); if (cm) cm.setDoc(text, f.lang); renderEditorTabs(); };
    window.__lastToast = () => { const t = document.getElementById("toast"); return t && !t.classList.contains("hidden") ? t.textContent.trim() : ""; };
    window.__setFsSync = (on) => { state._fsSyncOff = !on; };
    window.__setSetting = (k, v) => { state.settings[k] = v; };   // test hook: flip a live setting
    // ---- navigation drivers ----
    window.__symbols = () => fetchEditorSymbols();
    window.__openSymbolPicker = () => openSymbolPicker();
    window.__breadcrumbs = () => [...document.querySelectorAll("#editorBreadcrumbs .bc-seg span:last-child")].map((e) => e.textContent);
    window.__findReferences = () => editorFindReferences();
    window.__refs = () => (state.editor.refs || []).slice();
    window.__jumpTo = (p, line, col) => jumpTo(p, null, line, col);
    window.__navBack = () => navGo(-1);
    window.__navForward = () => navGo(1);
    window.__gitGutter = () => [...document.querySelectorAll("#editorBody .cm-git-gutter .cm-gitbar")].map((e) => e.className.replace("cm-gitbar", "").trim()).filter((c) => c && c !== "none");
    window.__imageShown = () => { const i = document.querySelector("#editorBody .img-preview"); return !!(i && i.getAttribute("src")); };
    window.__toggleMdPreview = () => toggleMarkdownPreview();
    window.__mdPreviewHtml = () => { const p = document.getElementById("mdPreview"); return p ? p.innerHTML : ""; };
    window.__scanProjectProblems = async () => { state.editor.problemsOpen = true; state.editor.problemsScope = "project"; await scanProjectProblems(); return (state.editor.projDiags || []).slice(); };
    // ---- chat/agent-panel drivers ----
    window.__reloadTab = async (id) => { id = id || state.activeTabId; const v = await atom.sessions.get(id); if (v) addTabState(v); await switchTab(id, true); };
    window.__setEditedFiles = (files) => { const ts = activeTS(); if (ts) { ts.editedFiles = files || []; updateStats(); renderChanges(); } };
    window.__toggleChanges = () => toggleChanges();
    window.__toggleReviewers = () => toggleReviewersPopover(document.getElementById("chatMore"));   // Reviewers live in the header ⋮ menu (2026-09-17)
    window.__toggleFleet = () => toggleFleet();
    window.__fleetSnap = () => fleetSnap;
    window.__dispatchFleet = async (text) => { showDock("fleet"); await renderFleet(); const ta = $("fleetInput"); if (ta) { ta.value = text; setFleetDraft(text); } await dispatchFleet(); return fleetSnap; };
    window.__toggleTests = () => toggleTests();
    window.__testRows = () => [...document.querySelectorAll("#testsPanel .test-row")].map((r) => ({ name: r.querySelector(".test-name") && r.querySelector(".test-name").textContent, status: (r.querySelector(".test-badge") && r.querySelector(".test-badge").textContent) || "", adapter: (r.querySelector(".test-adp") && r.querySelector(".test-adp").textContent) || "" }));
    window.__goalRows = () => [...document.querySelectorAll("#testsPanel .goal-row")].map((r) => ({ prompt: r.querySelector(".goal-name") && r.querySelector(".goal-name").textContent, status: (r.querySelector(".goal-badge") && r.querySelector(".goal-badge").textContent) || "" }));
    window.__chatFind = (q) => { openChatSearch(); doChatFind(q); return { count: chatFind.hits.length, label: $("chatFindCount") && $("chatFindCount").textContent }; };
    window.__chatFindStep = (d) => { stepChatFind(d); return chatFind.idx; };
    window.__closeChatFind = () => closeChatSearch();
    window.__promptDots = () => [...document.querySelectorAll("#promptRail .rail-dot")].map((d) => d.getAttribute("data-tip") || d.title);
    window.__hoverTip = (sel) => { const el = document.querySelector(sel); if (!el) return null; el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); return true; };
    window.__tipState = () => { const t = document.getElementById("tooltip"); if (!t) return null; const dir = [...t.classList].find((c) => c.startsWith("tip-")) || ""; return { show: t.classList.contains("show"), dir, text: t.textContent, left: parseFloat(t.style.left) || 0 }; };
    window.__clickPromptDot = (i) => { const d = document.querySelectorAll("#promptRail .rail-dot")[i]; if (d) { d.click(); return true; } return false; };
    window.__synthesize = async (id) => { const view = await synthesizeSession(id); return view ? { id: view.id, name: view.name, first: (view.messages[0] || {}).text || "" } : null; };
    window.__injectPerm = (toolName, msLeft) => { const ts = activeTS(); if (!ts) return 0; ts.pendingPerms.push({ requestId: "rq" + ts.pendingPerms.length + "_" + msLeft, toolName: toolName || "Bash", input: { command: "echo hi" }, shownAt: Date.now(), deadline: Date.now() + (msLeft || 300000) }); renderPerms(); return ts.pendingPerms.length; };
    window.__permInfo = () => { const ts = activeTS(); const chip = document.querySelector("#chatPerms .perm-countdown"); return { pending: ts ? ts.pendingPerms.length : 0, total: ts ? ts.pendingPerms.length + (ts.permFlash || []).length : 0, countdown: chip ? chip.textContent : null, answeredVisible: !!document.querySelector("#chatPerms .perm-answered"), tick: !!document.querySelector("#chatPerms .perm-tick") }; };
    window.__answerPerm = () => { const ts = activeTS(); const p = ts && ts.pendingPerms.find((x) => !x.answered); if (p) respondPerm(ts, p, true); return !!p; };
    window.__openSettings = () => openSettings();
    // ---- workflow (orchestrator-as-primary): the studio, the orchestrator's job cards, child tabs ----
    window.__openWorkflow = () => openWorkflowStudio();
    window.__jobCards = () => [...document.querySelectorAll("#chatMessages .job-card")].map((c) => ({ job: c.dataset.job, status: ([...c.classList].find((x) => x.startsWith("st-")) || "").slice(3), role: ([...c.classList].find((x) => x.startsWith("role-")) || "").slice(5), elapsed: (c.querySelector(".job-elapsed") || {}).textContent || "", result: !!c.querySelector(".job-result"), files: c.querySelectorAll(".job-file").length }));
    window.__tabOrder = () => state.order.map((id) => { const t = state.tabs.get(id); return { id, name: t ? t.meta.name : "", parentId: t ? t.meta.parentId : null, role: t ? t.meta.role : null, active: id === state.activeTabId }; });
    window.__settingsCat = (label) => { const b = [...document.querySelectorAll(".st-cat")].find((x) => x.dataset.label === label || x.textContent.trim() === label); if (b) { b.click(); return true; } return false; };
    window.__setRunning = (on) => { const ts = activeTS(); if (ts) { ts.meta.status = on ? "running" : "idle"; updateSendButton(); } };
    // ---- streaming render coalescing + dropdown stability while generating ----
    window.__streamPartial = (index, kind, delta) => { const ts = activeTS(); if (!ts) return; ts.meta.status = "running"; const cur = ts.streaming.get(index) || { kind, text: "" }; cur.kind = kind; cur.text += delta || ""; ts.streaming.set(index, cur); scheduleLiveUpdate(); };
    window.__liveRafPending = () => !!(_liveRaf || _liveTimer);
    window.__liveText = () => { const ls = $("chatLive") && $("chatLive").querySelector(".stream-lines"); return ls ? ls.textContent.replace(/​/g, "") : ""; };
    window.__clearStream = () => { const ts = activeTS(); if (ts) { ts.streaming.clear(); ts.meta.status = "idle"; } cancelLiveUpdate(); renderLive(); };
    window.__openFirstDD = () => { const t = document.querySelector(".dd-trigger"); if (t) t.click(); return document.querySelectorAll(".dd-menu").length; };
    window.__ddMenuCount = () => document.querySelectorAll(".dd-menu").length;
    window.__scrollChat = () => { const w = $("chatWrap"); if (w) w.dispatchEvent(new Event("scroll", { bubbles: true })); };
    window.__scrollElsewhere = () => { (document.querySelector("#sidebar") || document.body).dispatchEvent(new Event("scroll", { bubbles: true })); };
    window.__composerSend = (text, opts) => { const ta = $("promptInput"); ta.value = text || ""; ta.dispatchEvent(new Event("input")); return send(opts || {}); };
    window.__composerState = () => { const b = $("sendBtn"), qb = $("queueBtn"); return { sendStop: b.classList.contains("stop"), sendInterrupt: b.classList.contains("interrupt-now"), sendTitle: b.title, queueVisible: !!(qb && !qb.classList.contains("hidden")) }; };
    window.__queueState = () => { const ts = activeTS(); return { len: (ts.queue || []).length, texts: (ts.queue || []).map((q) => q.text), nums: [...document.querySelectorAll("#queueStrip .queue-num")].map((n) => n.textContent) }; };
    window.__pressEnter = (mods) => { const ta = $("promptInput"); const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ctrlKey: !!(mods && mods.ctrl), metaKey: !!(mods && mods.meta), shiftKey: !!(mods && mods.shift) }); ta.dispatchEvent(ev); return ev.defaultPrevented; };
    window.__dispatchQueued = (id) => dispatchNextQueued(id || state.activeTabId);
    window.__resetTabState = () => { const ts = activeTS(); if (ts) { ts.queue = []; ts.stopping = false; ts._dispatching = false; clearTimeout(ts._stopTimer); clearTimeout(ts._dispatchRetry); ts.streaming.clear(); } renderQueue(); updateSendButton(); };
    window.__loadOlder = () => loadOlder();
    // ---- provider / model capability drivers ----
    window.__providerState = () => ({ provider: state.settings.llmProvider || "anthropic", models: MODELS.map((m) => m.id), reasoning: REASONING_KIND, thinking: THINKING.map((t) => t.id), defaultModel: state.settings.defaultModel, defaultThinking: state.settings.defaultThinking, oneMVisible: !!($("oneMWrap") && !$("oneMWrap").classList.contains("hidden")) });
    window.__switchProvider = async (p) => { setSharedSetting("llmProvider", p); await loadProviderModels(p); return window.__providerState(); };
    window.__setModel = (id) => { setSharedSetting("defaultModel", id); if (modelDD) modelDD._refresh(); return window.__providerState(); };
    // ---- reply meta + model filter drivers ----
    window.__injectReply = (meta, text) => { const ts = activeTS(); ts.messages.push({ id: "r" + ts.messages.length, role: "assistant", text: text || "reply", ts: new Date().toISOString(), meta }); renderMessagesRegion(); };
    window.__replyMetas = () => [...document.querySelectorAll("#chatMessages .msg.assistant")].map((el) => ({ label: (el.querySelector(".msg-role-label") || {}).textContent, meta: (el.querySelector(".msg-meta") || {}).textContent || "", mk: el.dataset.mk || "", filtered: el.classList.contains("msg-filtered") }));
    window.__modelFilter = () => { const el = $("modelFilter"); return el ? { chips: [...el.querySelectorAll(".mf-chip")].map((c) => ({ text: c.textContent, active: c.classList.contains("active") })) } : null; };
    window.__clickFilterChip = (text) => { const el = $("modelFilter"); const c = el && [...el.querySelectorAll(".mf-chip")].find((x) => x.textContent === text); if (c) c.click(); return window.__replyMetas(); };
    window.__chatFindCase = (on, q) => { openChatSearch(); const i = $("chatFindInput"); if (i && q != null) i.value = q; chatFind.matchCase = !!on; const b = document.querySelector(".cf-case"); if (b) b.classList.toggle("active", chatFind.matchCase); doChatFind(i ? i.value : ""); return chatFind.hits.length; };
    window.__setAttachments = (atts) => { const ts = activeTS(); ts.attachments = atts || []; renderAttachments(); };
    window.__setPrompt = (t) => { const i = $("promptInput"); if (i) { i.value = t || ""; autoGrow(); updateSendButton(); } };
    // ---- reviewer collapse + image viewer drivers ----
    window.__injectReviewer = (text) => { const ts = activeTS(); ts.messages.push({ id: "rv" + ts.messages.length, role: "reviewer", reviewProvider: "google", reviewModel: "gemini-3.1-pro-preview", reviewKind: "consult", asked: "Conversation so far…\nThe user now asks: extend to 150", text: text || "Keep the same structure but add detail on observability; aim for ~150 words.", ts: new Date().toISOString() }); renderMessagesRegion(); };
    window.__reviewerState = () => { const d = document.querySelector("#chatMessages .msg.reviewer .rv-advice"); return d ? { collapsedByDefault: !d.open, preview: (d.querySelector(".rv-prev") || {}).textContent, hasAsked: !!document.querySelector("#chatMessages .msg.reviewer .rv-asked") } : null; };
    window.__injectImageMsg = (data, mediaType) => { const ts = activeTS(); ts.messages.push({ id: "im" + ts.messages.length, role: "user", text: "see this", attachments: [{ kind: "image", name: "x.gif", data, mediaType: mediaType || "image/gif", thumb: "data:image/gif;base64,THUMBONLY" }], ts: new Date().toISOString() }); renderMessagesRegion(); const el = document.querySelector("#chatMessages .msg.user .msg-att-img"); return el ? el.getAttribute("src") : null; };
    window.__imgIntent = (t) => looksLikeImageRequest(t);
    window.__openImageViewer = (src) => { openImageViewer(src || "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "test.png"); return window.__imageViewer(); };
    window.__imageViewer = () => { const v = $("imgViewer"); if (!v) return null; const img = v.querySelector(".iv-img"); return { present: true, controls: [...v.querySelectorAll(".iv-btn")].map((b) => b.title).filter(Boolean), download: !!v.querySelector("a.iv-btn[download]"), zoom: (v.querySelector(".iv-zoom") || {}).textContent, transform: img.style.transform }; };
    window.__ivBtn = (re) => { const b = [...document.querySelectorAll("#imgViewer .iv-btn")].find((x) => new RegExp(re, "i").test(x.title)); if (b) b.click(); return window.__imageViewer(); };
    window.__ivClose = () => { const b = [...document.querySelectorAll("#imgViewer .iv-btn")].find((x) => /Close/.test(x.title)); if (b) b.click(); return !!$("imgViewer"); };
    window.__chatInfo = () => { const ts = activeTS(); return ts ? { total: ts.totalMessages || ts.messages.length, inRam: ts.messages.length, firstIndex: ts.firstIndex || 0, viewStart: ts.viewStart || 0, rendered: document.querySelectorAll("#chatMessages .msg").length } : null; };
    // ---- checkpoints ----
    window.__createCheckpoint = (l) => createCheckpoint(l);
    window.__checkpoints = () => (state.checkpoints || []).map((c) => ({ id: c.id, label: c.label, files: c.files.length }));
    window.__restoreCheckpoint = (id) => restoreCheckpoint(id);
    // ---- split-editor drivers ----
    window.__splitEditor = () => toggleSplit();
    window.__closeSplit = () => closeSplit();
    window.__splitOrientation = () => toggleSplitOrientation();
    window.__focusPane = (i) => focusPane(i);
    window.__paneCm = (i) => editors[i] || null;
    window.__splitInfo = () => ({
      split: state.editor.split, dir: state.editor.splitDir, focused: state.editor.focused,
      panes: state.editor.panes.slice(), editors: editors.filter(Boolean).length,
      linked: !!(editors[0] && editors[0].isLinked && editors[0].isLinked()),
      hosts: document.querySelectorAll("#editorBody .epane").length,
    });
    // ---- diff + merge drivers ----
    window.__openDiff = (repo, path) => { const s = state.git.statuses[repo]; const f = ((s && s.files) || []).find((x) => x.path === path) || { path, label: "" }; openDiff(repo, f); };
    window.__diffView = (v) => setDiffView(v);
    window.__closeDiff = () => closeDiff();
    window.__diffInfo = () => {
      const back = document.querySelector(".diff-overlay");
      if (!back) return null;
      const q = (sel) => back.querySelectorAll(sel).length;
      return {
        open: true, view: gDiffView,
        adds: _diffNav.parsed ? _diffNav.parsed.adds : 0,
        dels: _diffNav.parsed ? _diffNav.parsed.dels : 0,
        binary: _diffNav.parsed ? _diffNav.parsed.binary : false,
        name: (back.querySelector(".dfh-name") || {}).textContent || "",
        stat: (back.querySelector(".dfh-stat") || {}).textContent || "",
        count: (back.querySelector(".dfh-count") || {}).textContent || "",
        hunks: q(".diff-hunkhdr"),
        splitRows: q(".diff-content.is-split .dsr"),
        unifiedRows: q(".diff-content.is-unified .dl:not(.hunk)"),
        addEls: q(".diff-content .dsc.add, .diff-content .dl.add"),
        delEls: q(".diff-content .dsc.del, .diff-content .dl.del"),
        words: q(".diff-content .wd"),
      };
    };
    window.__gitCheckout = (repo, branch) => gitCheckout(repo, branch);
    window.__gitCheckoutNew = (repo, name) => gitCheckoutNew(repo, name);
    window.__gitMerge = (repo, branch) => gitMerge(repo, branch);
    window.__gitMergeAbort = (repo) => gitMergeAbort(repo);
    // ---- conflict resolver drivers ----
    window.__openConflictResolver = (repo, p) => openConflictResolver(repo, p);
    window.__resolveConflict = (id, choice) => resolveConflict(id, choice);
    window.__bulkResolve = (choice) => bulkResolve(choice);
    window.__markFileResolved = () => markFileResolved();
    window.__completeMerge = () => completeMerge();
    window.__closeMerge = () => closeMerge();
    window.__mergeInfo = () => {
      const back = document.querySelector(".merge-overlay");
      if (!back) return null;
      return {
        open: true, file: _merge.path,
        total: _merge.parsed ? _merge.parsed.count : 0,
        resolved: mergeResolvedCount(),
        files: conflictedFiles(_merge.repo).length,
        cards: back.querySelectorAll(".mg-card:not(.malformed)").length,
        resolvedCards: back.querySelectorAll(".mg-card.resolved").length,
        completeDisabled: !!back.querySelector("#mgComplete").disabled,
        allset: !!back.querySelector(".merge-allset"),
        op: _merge.op, sides: { ..._merge.sides }, kind: _merge.fileInfo ? _merge.fileInfo.kind : "",
        legend: { mine: (back.querySelector(".mgl-cur") || {}).textContent || "", incoming: (back.querySelector(".mgl-inc") || {}).textContent || "" },
      };
    };
  }
}
/* ----------------------------- go ----------------------------- */
init()
  .then(() => console.log("AtomNano renderer initialized OK"))
  .catch((e) => { console.error("AtomNano init failed:", e && e.stack ? e.stack : e); document.body.innerHTML = `<pre style="padding:40px;color:#e87a64">AtomNano failed to start:\n${e.stack || e}</pre>`; });
