# AtomNano Git audit — implementation checklist

Date: 2026-09-10  
Source audit: `ATOMNANO_GIT_AUDIT_2026-09-09.md` (40 findings, GIT-001 … GIT-040)  
Project: `E:\Mac\AtomNano`

This document records what was changed for each finding, where the desired-behaviour regression tests live, and which integrations remain unverified. The audit's characterization harnesses are **not** used as a release gate (see "Evidence" below).

## Test commands

| Command | What it covers | Result on 2026-09-10 |
| --- | --- | --- |
| `node scripts/test-git.js` | Backend (`src/main/git.js`) against native Git in fresh temp repositories with isolated Git configuration and local bare remotes. 161 checks: literal paths, porcelain v2, CommitPlan, ref validation, PushPlan, merge/rebase target rules, conflict results and sides, discard outcomes, diff baselines, stash-by-id, tag phases, explicit merge parents, typed `fileAt`, remotes, unborn repositories, ZIP manifest, cherry-pick/revert mainline, runner queue/cancel/env, pull/push change summaries (G20). | 161 passed |
| `node scripts/test-git-ui.js` | Renderer components (`gitcenter.js`, the conflict resolver, dialogs and the commit-progress modal extracted from `app.js`, `diff.js`, `conflicts.js`, `styles.css`) in headless Chromium with fixture IPC. 39 checks: U01–U24 converted to desired behaviour plus X01–X08 (target identity, resolved push plan, stash identity, binary preview, merge parent selector, external refresh, live operation strip, unborn state) and X09–X13 (Unversioned section, click-to-preview, Compare and Merge flow, pull/push toasts, row layout). Writes `test-results/git-ui.json`. | 39 passed |
| `npm test` | `scripts/test-audit.js` + the two suites above (plus the tool-card, transfer, context, permission and DB suites added later). | 83 + 161 + 39 passed |
| `npm run test:git-e2e` | Real Electron: `smoke-tests/test-git-conflict.js` and `smoke-tests/test-git-multi.js`, now with unique fixture roots and an isolated app profile (`smoke-tests/_env.js`). | conflict suite 15/15; multi suite 20/20 |

## Finding → change → test

Phase numbers follow the audit's implementation order.

### Phase 0 — GIT-040 test isolation
- `smoke-tests/_env.js`: unique per-run fixture roots (`fs.mkdtemp`), isolated `ATOMNANO_USER_DATA`, empty `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, `GIT_CONFIG_GLOBAL` + `GIT_CONFIG_NOSYSTEM` for both the app and the test process. `test-git-multi.js` and `test-git-conflict.js` use it; no fixed temp paths, no recursive delete of shared folders.
- `src/main/main.js`: `ATOMNANO_USER_DATA` relocates userData and the Claude home before the store loads (no seeding from `~/.claude`).
- `scripts/test-git-ui.js` (new) covers the maintained Git Center entry point and the legacy resolver/dialog/progress paths; `package.json` gains `test:git-ui` and `test:git-e2e`.
- `test-git-multi.js` records every toast with a MutationObserver and asserts on what was shown: the app has one toast element, and the isolated profile emits first-run notices (“New model available”, “Codex signed out”) that can replace a Git summary within milliseconds. Before this change the suite read whichever toast happened to be visible.

### Phase 1 — precise backend mutations (already landed in `src/main/git.js`, verified by `scripts/test-git.js`)
- GIT-001 ref validation (`assertRefName`, `resolveRev --end-of-options`, fully qualified refs; reset mode separate from ref).
- GIT-002 / GIT-029 literal paths via `--literal-pathspecs --pathspec-from-file=- --pathspec-file-nul` (3,000 paths tested).
- GIT-003 porcelain v2 `-z` status, NUL name-status/numstat parsing, rename pairs.
- GIT-004 backend half: per-repository mutation queue keyed by the common Git dir (`withLock`), reentrant.
- GIT-012 discard as a validated plan with per-path phase outcomes; no delete after a failed unstage; lock files never removed.
- GIT-013 `pushPlan` (branch remote / pushRemote / pushDefault / push.default) + `pushBranch` with explicit remote and destination, `--force-with-lease=<ref>:<oid>`, upstream only when asked; remote-only requests rejected.
- GIT-014 `mergeBranches` requires a local target; `rebase` requires a local branch; `expect` object-id revalidation.
- GIT-015 stash identity by object id (`stashRefFor`, `dropByHash`).
- GIT-016 tag deletion remote-first with `refs/tags/…`, phases reported; tag push fully qualified.
- GIT-030 spawn-based runner: streamed output → `git:progress`, operation ids, `cancel`, complete diagnostics, routing env scrubbed.
- GIT-021/GIT-025 backend: conflict results, `repoState` with `actions` + `sides`, operation-specific continue/abort/skip, bisect reset.
- GIT-026 backend: `conflictStages`, `resolveWith` treats a missing stage as deletion.
- GIT-033 unborn handling, GIT-034 config-aware remotes and `checkoutRemote` choice, GIT-039 paged `commitsBetween`, checked secondary reads, explicit `follow`.
- GIT-017/GIT-020/GIT-028 backend: `commitInfo` with explicit parent (root vs empty tree), `commitZip` manifest under `files/`, atomic publish, UTF-8 ZIP flag; typed `fileAt` (binary/base64, chunked text, UTF-8 boundary).

### Phase 2 — UI data bound to its repository (`src/renderer/gitcenter.js`, rewritten)
- GIT-004: every action captures `repo` at start (`act(label, fn, { repo })`, `doPush({ repo })`, `doMerge(..., repo)`, …) and refreshes/toasts for that repo; duplicate submissions for a busy repo are ignored; mutation buttons are `disabled` (not just pointer-blocked) and the panel is `aria-busy` while busy. Tests U04, U05, U11.
- GIT-005: `S.per[repo]` holds draft, amend, selection, history/compare/stash/tag view state and the push continuation; `pendingPush` boolean removed; `offerContinuation(repo)` runs only for the visible repo, same branch, no operation, no conflicts; abort clears it. Tests U02, U03.
- GIT-022: `selectRepo` keeps loaded data local until repo + generation match (stale reads are recorded for their own repo only); history/detail/compare/diff loads carry request ids; pages deduplicated by commit id; closing during discovery settles `openGitCenter` without an error. Tests U01, U08, U10.
- GIT-023: status states `ready | error | stale | notRepo`; a failed read keeps the last snapshot, shows a `.gitc-state` strip with the error, retry and disables mutations (`readonly`); repository discovery errors are shown, not “No Git repository”. `app.js` `refreshGit` and the sidebar Git view do the same (`gv-status-error`). Test U22.
- GIT-024: compare is `ready` only when all reads and both ref resolutions succeeded; `cmp.ids` bind the review; Merge/Rebase pass `expect`; ref changes reset readiness; partial results are labelled “Incomplete comparison”. Test U07.
- GIT-031: `git.watch(repos)` registered by the sidebar and Git Center; `onGitChanged` refreshes only that repo (coalesced, skipped while our own operation runs) without disturbing the draft; the sidebar refreshes status and editor gutters. Test X06.
- GIT-037: `pickList`/`confirmPop` settle once on every dismissal and cancel deferred listeners; `prompt()` resolves `null` on cancel; `app.js` `confirmDialog` / `promptDialog` / `chooseDialog` return Promises settled on confirm, Cancel, ×, backdrop and Escape (`closeModal` emits `modal-closed`). Test U24.

### Phase 3 — exact reviewed commits (`gitcenter.js` Changes tab + `app.js`)
- GIT-008/GIT-009/GIT-010/GIT-011: the commit box submits a CommitPlan (`commitPlan(repo, { message, paths: [{ path, orig, untrack }], amend, expectHead })`); amend with a selection rewrites HEAD with only those paths, without a selection it is message-only; the default preview is HEAD → working tree (“Will commit”) with separate “Staged” / “Unstaged” baselines; unversioned records carry `untrack`; renames carry `orig` and show `old → new`. Tests U05, U09, backend G03.
- GIT-033 UI: unborn repositories disable Push / Amend / Rebase and say “no commits yet”. Test X08.
- GIT-036: `openCommitProgressModal` records the created commit id per row; “Retry” after a push failure re-pushes that commit (branch identity checked) and never re-commits; partial success is stated in the headline. Test U18.
- GIT-021 legacy: `commitSelected` keeps every repository's result; `pullAll` / `gitPull` / `pushReposList` branch on `state` (conflict, rejected, failed).

### Phase 4 — safe, operation-aware conflict recovery (`app.js` resolver, `gitcenter.js` banner)
- GIT-006: loads and saves are bound to `{ repo, path, gen }`; per-file drafts in `_merge.sessions`; `writeChecked` refuses to overwrite a file changed on disk; staging happens only after a successful write. Tests U12, U15b.
- GIT-007: one side descriptor (`repoState().sides`) maps Keep mine / Accept incoming / Both / keys 1-2-3 / bulk / side panes / whole-file buttons; labels show the git side and branch names. Tests U13, backend G07.
- GIT-021: `completeMerge` keeps the resolver open and reloads when the continuation stops at the next conflict; Git Center's Continue reports “continues — next step”. Test U14.
- GIT-025: the banner renders only the backend's `actions` (continue / skip / abort / bisect-reset); bisect is never routed to merge abort; abort clears the push continuation.
- GIT-026: modify/delete, binary, too-large and unreadable files get whole-file choices (deleted side stages a deletion); malformed markers are shown and block “resolved”. Test U15c, U17.
- GIT-027: EOL, BOM and final newline are preserved on save; closing with unsaved choices asks first. Test U15.

### Phase 5 — faithful inspection and export
- GIT-017 UI: export toasts report files, skipped deletions and unreadable files; “incomplete” archives are labelled.
- GIT-018: backend baselines (clean tracked → empty diff) — `scripts/test-git.js` G09.
- GIT-019: stateful `diff.js` parser — test U16.
- GIT-020: merge commits show “vs parent N” with a selector; file diffs, cherry-pick/revert mainline and changed-files export use the same parent. Test X05.
- GIT-028: binary blobs show size + exact-bytes download, text is paged with “Load more / Load all”. Test X04.
- GIT-034 UI: remotes list fetch/push URLs, URL editing without delete/re-add, remote-checkout choice dialog.
- GIT-035: legacy Merge tab reads `locals`/`remotes`, restricts targets to local branches, awaits the Promise-based confirm, branches on the result state. Test U23.
- GIT-039: compare commits and history page with “Load more”, deduplicated; single-file history follows renames explicitly.
- GIT-015/GIT-016 UI: stash rows act by hash; tag push/delete choose the remote and report phases. Test X03.

### Phase 6 — stable, accessible UI
- GIT-032: the Changes tab keeps a per-repo shell (sections scroller + commit box + diff pane) mounted; refreshes rebuild only the sections and restore scroll; folder toggles never rebuild the diff; long lists (changes tree, history, compare commits/files, branches, tags) are windowed (`virtualList`, full dataset retained). Tests U09, U20.
- GIT-038: panel `role=dialog aria-modal`, tabs `role=tab` with arrow keys, rows focusable with Enter/Space, dividers are keyboard separators (← → Home), focus trap and focus restore, accessible labels on icon buttons, reduced-motion rules for every Git overlay/popover/progress animation. Tests U19, U21.
- GIT-030 UI: live operation strip (label · last output line · Cancel by operation id); failure toasts open complete diagnostics. Test X07.

## Evidence

- `test-results/git-ui.json` — the UI suite's last run.
- `audit-evidence/git-2026-09-09/*-after-fix.json` — the audit's original characterization harnesses re-run against the fixed code. The **backend** harness sandboxes `git.js` in a VM context without timers; the rewritten spawn-based runner needs `setTimeout`, so its 33 rows report harness errors rather than reproductions (the supplemental harness hangs for the same reason and was stopped). The **UI** harness reports no reproduction still matching; 11 rows end in harness errors because its fixture IPC predates `pushPlan`/`commitPlan`/`writeChecked` and its waits time out on dialogs that no longer appear. These files only show that the original reproductions do not run unchanged; the desired-behaviour suites above are the regression tests, as the audit requires.

## Remaining / unverified

- Real hosted remotes (GitHub/GitLab/Bitbucket), credential-manager / SSH / GPG prompts, network cancellation, packaged Electron, Linux/macOS, screen readers and high-contrast modes were not exercised. They must be checked manually on a dedicated test account before release.
- `commitZip` still compresses in the main process (atomically published, manifest complete); streaming compression off the hot path is not implemented.
- Diff parsing and word-level diff still run on the renderer thread (bounded fallback kept); a worker was not added.
- The large-list measurement (5,000 files → viewport-bound rows) is a component measurement, not a packaged-Electron frame budget.
- GAP-01 … GAP-10 (init/clone, worktrees, hunk staging, graph/blame/reflog, interactive rebase, stash scope UI beyond keep-index, full refspec editor, identity diagnostics, hosted PR/MR API, pull policy) were intentionally not implemented; GAP-05 (mainline preflight), GAP-06 (keep-index in the stash dialog) and GAP-07 (fetch/push URL editing) are partially covered by the fixes above.

## Follow-up 2026-09-10 — Changes tab, merge view, toasts, row layout

User-reported issues fixed after the audit (Git Center, `src/renderer/gitcenter.js`, `src/main/git.js`, `src/renderer/styles.css`, `src/renderer/app.js`):

| Issue | Fix | Tests |
| --- | --- | --- |
| Unversion left the file in **Versioned** ("Unversioned" badge, count of Unversioned stayed 0). | `renderChanges` classifies `stagedDelete && keptOnDisk` records as Unversioned (`isUnversioned`); they carry **Track again**; the Unversioned bar's **Move to Versioned** re-tracks both kinds, **Delete** acts only on new files (unversioned tracked files are kept, with a notice). | UI X09, X10 |
| Every versioned file was **selected by default**. | No default selection: the user ticks what to commit (section select-all still ticks everything). `selInit` removed. Files acted on (unversion / track again / discard) leave the selection. | UI U20, U04, U05, X09, X10 |
| The right pane **auto-previewed** a file. | The diff pane shows a file only after a click (kept across refreshes); otherwise "Click a file to see its changes." A file that was unversioned/discarded also leaves the preview. | UI X09, X10 |
| Top **Compare** button; Merge/Rebase in the top bar. | Top button reads **Compare and Merge** and opens the merge view. Merge view bar: Source · swap · Target · **Compare** (refreshes the repository, then loads the review) · **Create Merge** (enabled only when Compare ran, loaded completely and shows differences, target local) · **Rebase** (same review, source local). Changing a ref or swapping drops the review. | UI U07, X11 |
| No toast after pull/push; toasts were **behind** the Git overlay (`.toast` z-index 400 < overlay 490). | `git.js` `pull`/`pullFrom`/`pushBranch` return `summary` (`files`, `insertions`, `deletions`, `commits` from a tree-to-tree diff of the moved ref; `newRef` for a first publication); Git Center and sidebar toasts read "Pulled origin/x into main — 12 files updated · +340 −22 · 3 commits" / "Pushed main → origin/main — 2 commits · 4 files changed · +10 −2". `.toast` z-index raised to 800 (above overlays, modals, pickers). | backend G20; UI X12 |
| Counts and status chips did not sit at the right edge when the left pane was widened (an 84px hover-action rail was reserved). | Hover actions are an absolutely positioned overlay on the row's right edge (shown on hover / keyboard focus, covering the chip); chips and folder counts sit flush right at any pane width. Conflict rows keep their inline always-visible actions. | UI X13 |
