/* AtomNano renderer — Shared renderer state (open tabs, editor, project, git) and the IPC bridge handle.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
export const atom = window.atomnano;
/* ----------------------------- state ----------------------------- */
export const state = {
  settings: null,
  activeTabId: null,
  order: [],                 // open tab ids in order
  tabs: new Map(),           // id -> tab state
  // Workflow (orchestrator-as-primary): role jobs by id and the live stage per session — fed by
  // workflow:job / workflow:stage events, read by the studio canvas, the composer chip and job cards.
  workflow: { jobs: new Map(), stages: new Map(), library: [], active: null },
  // open files: [{path,name,content,saved,dirty,lang}]; panes[i] = path shown in pane i
  editor: { open: [], active: null, fontSize: 13, split: false, splitDir: "v", panes: [null, null], focused: 0 },
  selectedFolder: null,               // last folder clicked in the tree
  findContext: "editor",              // "editor" | "folder" — what Ctrl+F targets
  project: "",                        // this window's project folder
  sidebarView: "files",               // "files" | "git" — what the left pane shows
  git: { repos: [], statuses: {}, message: "", expanded: new Set(), selected: new Set(), pushing: new Set() },  // discovered repos + per-repo status + commit msg + expanded accordions + selected files (repo\0path) for commit + repos with a push in flight
};
export function activeTS() { return state.tabs.get(state.activeTabId) || null; }
