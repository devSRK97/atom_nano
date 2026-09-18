/* GIT CENTER — one modal for everything Git across every repo in the project.
 *
 *   ┌ [repo ▾] [Fetch] [Pull ▾] [Push] [Branch] [Stash] [⋮]              [Compare and Merge] ┐
 *   │ Changes · History · Branches · Stashes · Tags · Remotes                                  │
 *   │   (or the merge view bar: Source · Target · [Compare] [Create Merge] [Rebase] · summary) │
 *   │ ┌ tree / list ─┃─ diff (expandable) ─────────────────────────────────────────────────┐  │
 *   └─┴──────────────┸────────────────────────────────────────────────────────────────────┴──┘
 *
 * Pure UI: every git call goes through `atom.git.*` (main/git.js). Shared app
 * helpers (DOM builder, toasts, dialogs, diff renderer, the guided conflict
 * resolver) are injected via `deps` so this module stays decoupled from app.js.
 *
 * Contracts (audit 2026-09-09):
 *   REPO-BOUND     every action captures its repository (and the reviewed ids) when
 *                  it STARTS; switching repos afterwards never redirects it. Results
 *                  refresh and toast for the repo they ran in.
 *   PER-REPO STATE drafts, amend, selection, history/compare/stash/tag view state and
 *                  push continuations live in S.per[repo]; the S.chg/S.hist/... getters
 *                  resolve to the current repo's record.
 *   RESULTS        mutations resolve { ok, state: success|conflict|rejected|choice|partial|
 *                  failed }; every consumer branches on `state`; failures throw typed errors.
 *   GENERATIONS    loaded data is committed only if repo + request generation still match.
 *   STATUS STATES  ready | error | stale — a failed status never renders as "clean".
 *   STABLE SHELL   the Changes tab keeps its commit box + diff pane mounted across refreshes
 *                  (focus/caret/scroll survive); long lists are windowed.
 * Layering: this overlay (z 490) sits UNDER the diff / conflict overlays, the
 * modal shell and the small prompt dialogs. Pickers and confirm popovers are
 * fixed-position and sit above everything (z 700).
 *
 * Modules (this folder): state · widgets · shell · repos · actions · ops · render · compare · changes ·
 * history · branches — this entry re-exports the public API and the test-harness internals. */
import { act, forAll, prompt } from "./actions.js";
import { doMerge, doPush, doRebase } from "./ops.js";
import { enterCompare, renderCmpBar, renderMain, runCompare, setTab } from "./render.js";
import { offerContinuation, refreshAll, refreshRepo, selectRepo } from "./repos.js";
import { close, onGitChanged, onGitProgress } from "./shell.js";
import { per, S } from "./state.js";
import { closePick, confirmPop, pickList } from "./widgets.js";

export { openGitCenter } from "./shell.js";
export { changeText } from "./ops.js";

// Internals for the component test harness (scripts/test-git-ui.js). Not used by the app.
export const __gitcInternals = { S, per, selectRepo, refreshAll, refreshRepo, act, forAll, setTab, enterCompare, runCompare, renderCmpBar, renderMain, doPush, doMerge, doRebase, close, prompt, confirmPop, pickList, closePick, offerContinuation, onGitChanged, onGitProgress };
