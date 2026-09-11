# AtomNano Git audit and implementation handoff

Date: 2026-09-09  
Project: `E:\Mac\AtomNano`  
Scope: the complete Git module and its integration surfaces. This is a new document, separate from `ATOMNANO_AGENT_AUDIT_2026-09-09.md`.

The Git feature set is broad, but several everyday paths can act on the wrong repository, commit unexpected content, select extra files, publish to the wrong destination, or misreport incomplete operations. Fix the data and operation contracts before adding more Git UI features.

This review identifies **40 findings: 17 P1 and 23 P2**, plus **10 explicitly separated feature gaps**. **60 characterization checks** were executed: **52 unwanted behaviors reproduced, seven expected behaviors verified, and one rendering measurement**. All final checks matched their stated characterization. This does **not** mean the module is fixed or ready to release.

No production source, real user credentials, existing project history or hosted remote was changed by this audit. New audit documents/evidence were saved; actual Git mutations ran only in fresh temporary fixtures with isolated Git configuration and local fixture remotes. Browser checks loaded original Git UI code with stubbed IPC in a blank, isolated Chromium document.

## Instructions for the implementing AI

Implement the P1/P2 findings below in dependency order. Preserve the existing file-selection workflow, standard Git hooks/signing/credential helpers and the positive behaviors listed later. Treat each finding's acceptance criteria as the required result, and add desired-behavior regression tests. Keep the legacy entry points coherent with Git Center.

Use one typed repository/operation/commit-plan model across main, preload and every renderer entry point. Do not repair only one visible button when the same backend or contract is shared. Do not implement optional GAP items as a substitute for fixing the core findings.

The supplied harnesses characterize the current code. A matching reproduction assertion means a bug is present. **Do not use their present success result as a release gate after implementation, or change production code to preserve a reproduced bug.** Convert relevant cases to assertions of the corrected behavior and retain the isolated fixtures.

No implementation was performed as part of this document. Re-read the referenced code before editing; source hashes appear at the end because this folder has no `.git` baseline to identify a revision.

## Coverage and validation limits

The review covered all **65 exported methods** in [src/main/git.js:841](E:/Mac/AtomNano/src/main/git.js:841), their Git IPC/preload routes, the whole Git Center module, the legacy commit/merge/compare/diff/conflict flows, shared diff/conflict parsers, file read/write/watch behavior, ZIP generation, Git CSS and seven existing Git/editor-gutter smoke suites plus the ZIP smoke entry point. Shared large files such as app.js/main.js were reviewed for the Git paths and their dependencies; this document does not claim a fresh audit of every unrelated feature in those files.

Runtime: git version 2.52.0.windows.1; Node v24.14.1; installed Playwright Chromium in headless mode for component checks. Backend tests call the original source against native Git. UI tests use the original module/functions and CSS, with fixture IPC and placeholder icons. They do not constitute a full Electron release test or a network/authentication test.

Not exercised live: real GitHub/GitLab/Bitbucket repositories, credential-manager/SSH/GPG dialogs, actual user account switching, network cancellation, packaged Electron, Linux/macOS or an actual multi-window app session. Large-file/rendering results are scoped to the supplied fixture and are not a universal latency guarantee. Those integration checks are included in the implementation exit criteria.

The existing full-app smoke tests were read rather than run against the user's application profile; their isolation problems are covered by GIT-040.

## Feature inventory

| Feature | Backend methods reviewed | Current state |
| --- | --- | --- |
| Repository discovery | `isRepo`, `repoRoot`, `repos`, `repoForFile`, `isRepoDir` | Existing repository or immediate child repositories; no clone/init UI. |
| Status and operation state | `status`, `currentBranch`, `repoState` | Changes, current branch, ahead/behind and operation banners; parsing/failure gaps. |
| Staging | `stage`, `unstage`, `stageAll`, `stageTracked`, `unstageAll` | File/all/tracked-only staging; selection is separate; unborn and path transport bugs. |
| Commit and amend | `commit`, `commitFiles` | Selection-driven commits and amend; reviewed content/selection integrity needs repair. |
| Discard and unversion | `discard`, `untrack` | Restore/remove changes and stop tracking; rename and failure handling need repair. |
| Working diffs and gutter | `diff`, `fileDiff` | Staged/working/HEAD and untracked diffs; baseline fallback is incorrect. |
| Branches and upstreams | `branches`, `branchesDetailed`, `checkout`, `checkoutRemote`, `branchCreate`, `branchDelete`, `branchRename`, `setUpstream` | Local/remote branch lists, create/checkout/delete/rename/track; ref identity gaps. |
| Compare | `changedBetween`, `refDiff`, `commitsBetween`, `aheadBehind` | Three-dot file comparison, source-only commits and counts; failure gating/cap gaps. |
| History mutations | `merge`, `mergeBranches`, `rebase`, `cherryPick`, `revert`, `reset` | Merge/rebase/cherry-pick/revert and reset modes; operation contracts need work. |
| Recovery and resolution | `mergeAbort`, `mergeContinue`, `rebaseSkip`, `resolveWith` | Continue/abort/skip and whole-file side resolution; incomplete operation/type coverage. |
| Fetch, pull and push | `fetch`, `pull`, `pullFrom`, `push`, `pushBranch` | Single/batch remote operations and force-with-lease; destination inconsistency and progress gaps. |
| History inspection | `log`, `commitInfo`, `commitFileDiff`, `fileAt` | Paged log, search, details, file diff and historical content; parent/read fidelity gaps. |
| Stashes | `stashList`, `stashSave`, `stashApply`, `stashDrop`, `stashShow`, `stashFileDiff` | Save/apply/pop/drop and file previews; unstable index identity. |
| Tags | `tags`, `tagCreate`, `tagDelete` | Lightweight/annotated create, list, checkout/export/push/delete through UI; namespace/partial-result gaps. |
| Remotes | `remotes`, `remoteUrl`, `remoteAdd`, `remoteRemove` | List/add/remove/reveal and fetch; limited URL editing and parsing. |
| Snapshots | `archiveZip`, `commitZip` | Whole-tree and changed-files ZIP; whole-tree binary smoke passed, changed-files fidelity fails. |

Other reviewed UI features include multi-repository selections/batches, commit-and-push progress/retry, split/unified/expanded diffs, file history, remote browser links, comparison direction, operation banners, whole-file and line-level resolution, keyboard/picker behavior and repository switching while work is running.

Git authentication uses the system Git credential helper/SSH environment. Claude/OpenAI provider selection and their saved API/OAuth accounts are separate from Git remote authentication and Git author identity. Continuing to use system Git is a reasonable integration choice; replacing it with another Git library is not necessary to fix these findings.

## Finding index

P1: fix before relying on the affected mutation/export workflow. P2: correctness, recovery, performance or integration work needed for a dependable Git module. Feature gaps are separately prioritized and are not all current defects.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| [GIT-001](#git-001) | P1 | Branch, tag and revision inputs can turn into destructive Git options | G14, G15, G16 |
| [GIT-002](#git-002) | P1 | A selected filename can match and modify additional files | G13 |
| [GIT-003](#git-003) | P1 | Quoted porcelain filenames break status-driven actions | G01, G31 |
| [GIT-004](#git-004) | P1 | Operations can change repository after the user starts them | U04, U05, U11 |
| [GIT-005](#git-005) | P1 | Pending push and commit state leak between repositories | U02, U03 |
| [GIT-006](#git-006) | P1 | The conflict resolver can write one file's contents into another | U12 |
| [GIT-007](#git-007) | P1 | Line-by-line rebase resolution reverses the meaning of Keep mine | U13 |
| [GIT-008](#git-008) | P1 | Amend includes staged changes outside the selected files | G08 |
| [GIT-009](#git-009) | P1 | The diff preview can omit changes that Commit will include | G09, G07 |
| [GIT-010](#git-010) | P1 | Unversion is undone by the next selection-driven commit | G10 |
| [GIT-011](#git-011) | P1 | Rename selection commits only half the change and discard fails to restore it | G11, G12 |
| [GIT-012](#git-012) | P1 | Discard can delete content after its prerequisite command fails | G35 |
| [GIT-013](#git-013) | P1 | Push can publish to a different remote or branch than the UI describes | G17 |
| [GIT-014](#git-014) | P1 | Merge targets can be remote-tracking refs or tags, leaving detached work | G18 |
| [GIT-015](#git-015) | P1 | Stash actions can affect a different stash than the selected one | G26 |
| [GIT-016](#git-016) | P2 | Tag deletion can partially succeed and short tag names are ambiguous | G30, G36 |
| [GIT-017](#git-017) | P1 | Changed-files exports can silently omit files and overwrite their metadata name | G20, G31, G27 |
| [GIT-018](#git-018) | P2 | Clean tracked files are displayed as entirely added | G05, G06 |
| [GIT-019](#git-019) | P2 | The diff parser drops real content that resembles file headers | U16 |
| [GIT-020](#git-020) | P2 | Merge commits can show no changed files and no diff | G19 |
| [GIT-021](#git-021) | P1 | Conflict results are reported as successful pull or completed rebase | G29, G33, U06, U14 |
| [GIT-022](#git-022) | P2 | Repository and history loads can overwrite newer UI state | U01, U08, U10 |
| [GIT-023](#git-023) | P2 | Git failures are presented as a clean repository | U22 |
| [GIT-024](#git-024) | P2 | Compare enables mutation even when its review failed | U07 |
| [GIT-025](#git-025) | P2 | Operation recovery controls do not match all detected Git states | G25, G24 |
| [GIT-026](#git-026) | P2 | The resolver cannot reliably handle deletion, binary or unsupported marker conflicts | G23, U17 |
| [GIT-027](#git-027) | P2 | Conflict save changes line endings and can lose resolution drafts | U15 |
| [GIT-028](#git-028) | P2 | Historical file preview corrupts binary representation and silently truncates text | G32 |
| [GIT-029](#git-029) | P2 | Large file selections fail at the Windows argument-length limit | G34 |
| [GIT-030](#git-030) | P2 | Git operations expose no live process output or cancellation | Source review |
| [GIT-031](#git-031) | P2 | Git Center does not automatically receive external repository updates | Source review |
| [GIT-032](#git-032) | P2 | Refreshing and expanding rebuilds the UI and long lists block the renderer | U09, U20 |
| [GIT-033](#git-033) | P2 | Unborn repositories show the wrong branch and Unstage all fails | G02, G03, G04 |
| [GIT-034](#git-034) | P2 | Remote list parsing drops valid local URLs and checkout can select the wrong tracking branch | G21, G22 |
| [GIT-035](#git-035) | P2 | The legacy Review & commit Merge tab has incompatible API contracts | U23, U24 |
| [GIT-036](#git-036) | P2 | Retry failed can recommit after only the push failed | U18 |
| [GIT-037](#git-037) | P2 | Canceled dialogs leave unresolved action promises and widget cleanup is incomplete | Source review |
| [GIT-038](#git-038) | P2 | Git controls have keyboard, accessibility and reduced-motion gaps | U19, U21 |
| [GIT-039](#git-039) | P2 | History limits and silent partial reads make reviews incomplete | Source review |
| [GIT-040](#git-040) | P2 | Git smoke tests do not cover the maintained Git Center and lack profile isolation | Source review |

## Findings and concrete fixes

<a id="git-001"></a>

### GIT-001 — P1 — Branch, tag and revision inputs can turn into destructive Git options

**Evidence:** [src/main/git.js:580](E:/Mac/AtomNano/src/main/git.js:580); [src/main/git.js:660](E:/Mac/AtomNano/src/main/git.js:660); [src/main/git.js:733](E:/Mac/AtomNano/src/main/git.js:733); [src/renderer/gitcenter.js:1078](E:/Mac/AtomNano/src/renderer/gitcenter.js:1078). Checks: G14, G15, G16. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Creating a branch named `-D` with an existing branch as the start point and Check out disabled deletes that existing branch, then reports creation success. A reset reference of `--hard` overrides the chosen Soft mode and discards working changes. Creating a lightweight tag named `-d` at an existing tag deletes that tag. These are option-injection bugs despite the correct use of `shell:false`.

**Fix.** Validate branch/tag names in main with Git's ref-name rules; resolve free-form revisions to verified object IDs using an explicit end-of-options boundary. Build command-specific argument lists from validated values and fully qualified refs. Apply this at the IPC/backend boundary to every ref-taking method, including checkout, reset, merge/rebase, cherry-pick/revert, archive and tag operations. Use the same normalized target in the confirmation and execution.

**Acceptance.** Invalid names and option-looking refs fail validation before any mutation. Test the three reproductions plus an invalid revision, a normal branch, a tag/branch name collision and `HEAD~1`. Verify HEAD, branches, tags, index and working files remain unchanged after rejected inputs.

Git explicitly recommends an end-of-options boundary when verifying untrusted revision names. [Git rev-parse](https://git-scm.com/docs/git-rev-parse).

<a id="git-002"></a>

### GIT-002 — P1 — A selected filename can match and modify additional files

**Evidence:** [src/main/git.js:131](E:/Mac/AtomNano/src/main/git.js:131); [src/main/git.js:181](E:/Mac/AtomNano/src/main/git.js:181); [src/main/git.js:386](E:/Mac/AtomNano/src/main/git.js:386); [src/main/git.js:787](E:/Mac/AtomNano/src/main/git.js:787). Checks: G13. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Selecting only `a[1].txt` stages both that file and `a1.txt`. The path separator `--` prevents option parsing but does not disable Git pathspec matching. The same raw path lists are reused by commit, discard, unstage, untrack and conflict actions, so selection boundaries are unreliable.

**Fix.** Treat paths obtained from status or selected in the UI as literal paths. Centralize literal path handling, use NUL-delimited input for commands supporting it, and retain the repository-relative path without display escaping. Validate containment and preserve exact case. Expand directories into the reviewed path set before mutation.

**Acceptance.** With bracket-containing names and neighboring pattern matches, each selected-file action affects exactly the selected paths. Include file names containing spaces, Unicode and a leading hyphen. Unselected disk contents and index entries must remain byte-identical.

<a id="git-003"></a>

### GIT-003 — P1 — Quoted porcelain filenames break status-driven actions

**Evidence:** [src/main/git.js:93](E:/Mac/AtomNano/src/main/git.js:93); [src/main/git.js:386](E:/Mac/AtomNano/src/main/git.js:386); [src/main/git.js:406](E:/Mac/AtomNano/src/main/git.js:406); [src/main/git.js:504](E:/Mac/AtomNano/src/main/git.js:504); [src/main/git.js:516](E:/Mac/AtomNano/src/main/git.js:516). Checks: G01, G31. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Status returns display-quoted names such as `"space name.txt"` and C-escaped Unicode paths as the actual `path` value. Staging that returned name fails. Rename/name-status/numstat parsing also splits human-formatted lines without decoding. This affects Changes, history, comparison, conflict navigation and changed-files exports.

**Fix.** Adopt porcelain v2 with NUL records for status, and NUL-safe name-status/numstat parsing for other commands. Parse rename records according to their documented record ordering; keep source/destination paths separate. Retain raw identity independently from labels and rendering. Do not fix this by globally changing the user's `core.quotePath` setting.

**Acceptance.** Round-trip spaced, Unicode, renamed and bracket-containing paths through status, stage, commit, discard, diff and export. Include platform-valid tab/newline filenames in non-Windows CI. Every backend path equals the real repository path, without surrounding quotes or escape sequences.

The NUL porcelain format avoids display quoting and has specific rename field ordering. [Git status format](https://git-scm.com/docs/git-status#_porcelain_format_version_1).

<a id="git-004"></a>

### GIT-004 — P1 — Operations can change repository after the user starts them

**Evidence:** [src/renderer/gitcenter.js:310](E:/Mac/AtomNano/src/renderer/gitcenter.js:310); [src/renderer/gitcenter.js:932](E:/Mac/AtomNano/src/renderer/gitcenter.js:932); [src/renderer/gitcenter.js:414](E:/Mac/AtomNano/src/renderer/gitcenter.js:414); [src/renderer/styles.css:1682](E:/Mac/AtomNano/src/renderer/styles.css:1682); [src/main/git.js:16](E:/Mac/AtomNano/src/main/git.js:16). Checks: U04, U05, U11. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Git actions read mutable `S.repo` again after awaits. The browser reproduction stages repository A and then calls amend on B after a repository switch. Commit & Push commits A but opens a Push B confirmation. The busy class only blocks pointer events on some buttons: a focused Fetch button can run a second operation with Enter, while the repository picker remains usable. The backend has no transaction queue across multi-step mutations.

**Fix.** Capture repository, worktree/common Git directory, ref IDs, selected paths and options in an immutable operation request. Execute multi-step mutations in main against that request under a repository mutation queue. Key completion events by operation and repository. Guard keyboard activation and duplicate submissions using actual disabled/in-flight state. Repository navigation must not redirect an operation.

**Acceptance.** Switch repositories or close/reopen Git Center while stage, commit, amend, pull, merge, reset and push are pending. Every stage and result stays bound to its initiating repository. Double click and keyboard repeat submit once. Different independent repositories may run concurrently; mutations sharing a Git directory are serialized.

<a id="git-005"></a>

### GIT-005 — P1 — Pending push and commit state leak between repositories

**Evidence:** [src/renderer/gitcenter.js:19](E:/Mac/AtomNano/src/renderer/gitcenter.js:19); [src/renderer/gitcenter.js:258](E:/Mac/AtomNano/src/renderer/gitcenter.js:258); [src/renderer/gitcenter.js:299](E:/Mac/AtomNano/src/renderer/gitcenter.js:299); [src/renderer/gitcenter.js:436](E:/Mac/AtomNano/src/renderer/gitcenter.js:436). Checks: U02, U03. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** `selectRepo` keeps the prior commit message and Amend flag. Tags, history selection/filter, stash selection and branch form state also live globally. More seriously, `pendingPush` is one boolean: resolving or merely refreshing clean repository B can offer to push B for a failed push originating in A.

**Fix.** Store drafts, amend state, history/filter/selection, tags and stash view data per repository. Replace `pendingPush` with a repository-bound continuation containing operation ID, source ref, remote, destination ref and expected commit. Clear or suspend that continuation on cancellation/abort and validate it before offering a retry. Restore only that repository's own draft.

**Acceptance.** Set a draft and Amend in A, then visit B: B shows its own state. A's rejected-push recovery never opens a push prompt for B. Abort/cancel removes the matching continuation; closing and reopening preserves only intentional repository-local state.

<a id="git-006"></a>

### GIT-006 — P1 — The conflict resolver can write one file's contents into another

**Evidence:** [src/renderer/app.js:2901](E:/Mac/AtomNano/src/renderer/app.js:2901); [src/renderer/app.js:2912](E:/Mac/AtomNano/src/renderer/app.js:2912); [src/renderer/app.js:3075](E:/Mac/AtomNano/src/renderer/app.js:3075); [src/renderer/app.js:3122](E:/Mac/AtomNano/src/renderer/app.js:3122). Checks: U12. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** `loadConflictFile` verifies only that the same overlay still exists. Reading A, navigating to B, and receiving A last replaces the shared parsed content while `_merge.path` still names B. Clicking resolve then writes A's chosen contents into B. The original resolver functions reproduced the wrong write through captured file IPC. Navigating also clears unsaved conflict choices without a per-file draft.

**Fix.** Bind every load and save to repository, path, request generation and original content/index identity. Commit loaded data only if all identities still match. Keep resolution drafts per file. Before saving, compare the expected disk/index version; if another editor or agent changed it, require a fresh comparison. Write atomically and stage only after a successful validated save.

**Acceptance.** Delay reads and reverse their completion order across files and repositories. A's response never changes B's displayed or saved content. Navigate away and back without losing choices. An external file edit during resolution is detected before overwrite. A failed save never stages the file.

<a id="git-007"></a>

### GIT-007 — P1 — Line-by-line rebase resolution reverses the meaning of Keep mine

**Evidence:** [src/renderer/gitcenter.js:866](E:/Mac/AtomNano/src/renderer/gitcenter.js:866); [src/renderer/app.js:2949](E:/Mac/AtomNano/src/renderer/app.js:2949); [src/renderer/app.js:2991](E:/Mac/AtomNano/src/renderer/app.js:2991); [src/renderer/app.js:3037](E:/Mac/AtomNano/src/renderer/app.js:3037). Checks: U13. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** The whole-file Git Center action correctly swaps Git's sides during rebase. The guided resolver always maps Keep mine to marker `ours` and Accept incoming to `theirs`, including bulk actions and keys 1/2. During rebase, marker `ours` is normally the branch being rebased onto. The two resolution UIs therefore make opposite choices for the same wording.

**Fix.** Create one operation-aware side descriptor from index stages and repository operation state. Use it for whole-file, line-level, bulk, preview and keyboard actions. Display concrete branch/commit labels alongside the user-facing meaning. Keep both ordering must use the same descriptor.

**Acceptance.** Reproduce identical conflicts under merge, rebase, pull-with-rebase, cherry-pick and stash application. Keep mine, its bulk form and key 1 retain the user's intended version in every supported operation. Whole-file and line-level choices agree.

Git documents that rebase reverses the usual interpretation of the index sides. [Git checkout: ours/theirs](https://git-scm.com/docs/git-checkout).

<a id="git-008"></a>

### GIT-008 — P1 — Amend includes staged changes outside the selected files

**Evidence:** [src/renderer/gitcenter.js:932](E:/Mac/AtomNano/src/renderer/gitcenter.js:932); [src/main/git.js:166](E:/Mac/AtomNano/src/main/git.js:166). Checks: G08. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** The Amend confirmation says it rewrites the last commit with the selected changes. The handler stages selected paths and runs a plain amend of the entire index. An unselected file already staged elsewhere is committed as well. With no selected files, a message-only amend can also include staged content.

**Fix.** Route normal commit and amend through the same reviewed CommitPlan. Build the selected commit tree in an isolated temporary index; preserve unrelated entries in the user's real index and reconcile only approved paths after success. Message-only amend must reuse the existing commit tree. Preserve normal hooks and signing behavior.

**Acceptance.** Stage B, select only A, and amend: B's new content stays staged and is absent from the amended commit. Repeat with no selection and only a message change. Verify unrelated index entries survive hook/signing failure and cancellation.

<a id="git-009"></a>

### GIT-009 — P1 — The diff preview can omit changes that Commit will include

**Evidence:** [src/renderer/gitcenter.js:790](E:/Mac/AtomNano/src/renderer/gitcenter.js:790); [src/renderer/gitcenter.js:803](E:/Mac/AtomNano/src/renderer/gitcenter.js:803); [src/renderer/gitcenter.js:932](E:/Mac/AtomNano/src/renderer/gitcenter.js:932); [src/main/git.js:181](E:/Mac/AtomNano/src/main/git.js:181). Checks: G09, G07. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** A file with staged and unstaged edits is previewed with the working-tree-versus-index diff, while Commit stages and commits its complete working-tree contents. Previously staged additions can therefore be omitted from the review. Selection is intentionally separate from staging and defaults to all versioned changes; that design is visible in existing tests, but the preview does not match it.

**Fix.** Keep the existing file-selection workflow explicit. Generate the review from the exact CommitPlan tree versus its parent/HEAD, including both staged and unstaged selected content. Expose separate staged and unstaged inspection views with clear labels. Make selecting files and staging changes visibly different actions.

**Acceptance.** Stage one edit, make another unstaged edit, then review the file. The default commit preview shows every change that will land, and the final commit diff matches it. Unselected staged files remain staged as the existing positive test requires.

Path-limited commits normally take selected working-tree contents while leaving unrelated staged paths out. [Git commit: only](https://git-scm.com/docs/git-commit).

<a id="git-010"></a>

### GIT-010 — P1 — Unversion is undone by the next selection-driven commit

**Evidence:** [src/main/git.js:787](E:/Mac/AtomNano/src/main/git.js:787); [src/main/git.js:181](E:/Mac/AtomNano/src/main/git.js:181); [src/renderer/gitcenter.js:782](E:/Mac/AtomNano/src/renderer/gitcenter.js:782); [src/renderer/gitcenter.js:815](E:/Mac/AtomNano/src/renderer/gitcenter.js:815). Checks: G10. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** `untrack` correctly removes the file from the index while keeping it on disk. Status then contains a staged deletion and an untracked entry for the same path. The UI maps rows/selections by path alone, and Commit runs `git add` on that path, restoring tracking and often failing with nothing to commit. The staged removal cannot be completed reliably through this workflow.

**Fix.** Represent index change and working-tree/untracked state as distinct parts of one path record. Preserve explicit untrack/delete intent in CommitPlan. Commit the approved removal from the temporary index without re-adding the kept working file. Offer a separate, explicit ignore action rather than implicitly editing .gitignore.

**Acceptance.** Unversion a tracked file, review, and commit its removal. HEAD no longer contains it; its disk bytes remain unchanged. The remaining untracked entry is visible once. Retrying after a failure must not start tracking it again.

<a id="git-011"></a>

### GIT-011 — P1 — Rename selection commits only half the change and discard fails to restore it

**Evidence:** [src/main/git.js:109](E:/Mac/AtomNano/src/main/git.js:109); [src/main/git.js:181](E:/Mac/AtomNano/src/main/git.js:181); [src/main/git.js:386](E:/Mac/AtomNano/src/main/git.js:386); [src/renderer/gitcenter.js:790](E:/Mac/AtomNano/src/renderer/gitcenter.js:790). Checks: G11, G12. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Status retains `orig`, but action payloads use only the new path. Committing a staged rename leaves both old and new names in HEAD and the old deletion staged. Discarding only the renamed path in the fixture deletes the destination and leaves the original missing with its deletion staged, while returning success.

**Fix.** Treat a rename as an operation containing both paths and any content edit. Expand CommitPlan and discard plans accordingly. Preserve source/destination identity through IPC and use explicit index/HEAD snapshots to restore both names. Do not reconstruct a rename from a display label or a path-filtered status that has lost its pairing.

**Acceptance.** Test pure rename, rename plus edit, directory rename, case-only rename on Windows, and paths with spaces. A selected rename produces the intended tree with no leftover deletion. Discard restores the original path and HEAD content and removes the uncommitted destination.

<a id="git-012"></a>

### GIT-012 — P1 — Discard can delete content after its prerequisite command fails

**Evidence:** [src/main/git.js:386](E:/Mac/AtomNano/src/main/git.js:386); [src/renderer/gitcenter.js:810](E:/Mac/AtomNano/src/renderer/gitcenter.js:810); [src/renderer/app.js:2178](E:/Mac/AtomNano/src/renderer/app.js:2178). Checks: G35. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Discard ignores failure of its status command, ignores the reset result for staged-new files, and suppresses every filesystem deletion error. With a fixture index.lock present, reset fails, but the file is deleted and the function returns success while its blob remains staged as `AD`. Other failed deletions can also be reported as completed.

**Fix.** Validate the full discard plan before mutation, stop when a prerequisite fails, and report per-path phase outcomes. Check resolved paths and file types before deleting, including directory/ignored-content boundaries. Use a recoverable trash/checkpoint for new files where feasible. Never remove Git lock files to force an operation through.

**Acceptance.** Hold an index lock or inject a filesystem permission failure. Discard reports the failed phase, does not delete a staged-new file after failed reset, and never reports complete success for partial work. Verify tracked restoration, new-file removal and rename restoration separately.

<a id="git-013"></a>

### GIT-013 — P1 — Push can publish to a different remote or branch than the UI describes

**Evidence:** [src/main/git.js:464](E:/Mac/AtomNano/src/main/git.js:464); [src/main/git.js:202](E:/Mac/AtomNano/src/main/git.js:202); [src/renderer/gitcenter.js:414](E:/Mac/AtomNano/src/renderer/gitcenter.js:414); [src/renderer/gitcenter.js:1140](E:/Mac/AtomNano/src/renderer/gitcenter.js:1140); [src/main/git.js:796](E:/Mac/AtomNano/src/main/git.js:796). Checks: G17. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Git Center explicitly calls `pushBranch` with a short local branch and defaults the remote to origin. Its confirmation describes the configured upstream. A fixture tracking upstream/review instead updates origin/main. Explicit branch pushes bypass configured push-remote and destination behavior; force push also sets upstream. Legacy push uses a different path, making behavior inconsistent. Source inspection also shows that a remote-only pushBranch option is ignored without branch/tags, and pullFrom ignores its remote option when branch is absent.

**Fix.** Resolve an explicit PushPlan using Git's configured push remote/refspec rules, including a destination branch whose name differs from the local branch. Show the resolved remote URL/name and fully qualified destination before executing that same plan. Require a deliberate selection for initial publication when no destination is configured. Preserve force-with-lease with an expected remote object ID; never change upstream as a side effect of Force alone. Honor an explicitly supplied remote even when a branch is omitted, or reject the incomplete request before running Git.

**Acceptance.** Test origin, a non-origin upstream, pushRemote, differently named destination, no upstream, multiple remotes, detached HEAD and tag/branch collisions. The ref shown in review is the only ref updated. Pull and push may intentionally use different remotes. Include remote-only backend option tests.

Git's destination rules include the branch remote, push-remote configuration and refspec behavior; a hard-coded origin/short-branch pair is not equivalent. [Git push](https://git-scm.com/docs/git-push).

<a id="git-014"></a>

### GIT-014 — P1 — Merge targets can be remote-tracking refs or tags, leaving detached work

**Evidence:** [src/renderer/gitcenter.js:524](E:/Mac/AtomNano/src/renderer/gitcenter.js:524); [src/renderer/gitcenter.js:360](E:/Mac/AtomNano/src/renderer/gitcenter.js:360); [src/renderer/gitcenter.js:1120](E:/Mac/AtomNano/src/renderer/gitcenter.js:1120); [src/main/git.js:286](E:/Mac/AtomNano/src/main/git.js:286). Checks: G18. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Source and target pickers both accept local branches, remote refs and cached tags. Selecting origin/main as the merge target checks it out detached, merges there, and reports a merge into origin/main even though that ref is unchanged. Rebase's local-branch guard checks only the origin/ prefix, so other remote names and tags are not reliably rejected.

**Fix.** Model refs with a kind and full refname. A merge target and the branch being rebased must be an explicit local branch; remote refs/tags remain valid comparison sources or rebase destinations. To work from a remote target, first create/select a named local tracking branch. Revalidate its expected object ID immediately before mutation.

**Acceptance.** Remote refs from origin and another remote, tags, and detached commits cannot become an implicit writable branch target. A successful merge/rebase leaves HEAD on the named local branch and updates that branch. Compare still supports read-only arbitrary refs.

<a id="git-015"></a>

### GIT-015 — P1 — Stash actions can affect a different stash than the selected one

**Evidence:** [src/main/git.js:669](E:/Mac/AtomNano/src/main/git.js:669); [src/main/git.js:693](E:/Mac/AtomNano/src/main/git.js:693); [src/main/git.js:697](E:/Mac/AtomNano/src/main/git.js:697); [src/renderer/gitcenter.js:1174](E:/Mac/AtomNano/src/renderer/gitcenter.js:1174). Checks: G26. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Stash rows include a stable hash but apply, pop, show and drop send only a numeric index. In the fixture, selecting stash 0, creating a newer stash, then dropping index 0 deletes the newer stash and leaves the selected one. Another window, terminal or concurrent action can renumber these entries.

**Fix.** Carry the stash object ID as identity. Apply/show by that ID. Before drop/pop, resolve the current reflog entry for the expected ID under the operation queue and reject a stale/ambiguous selection. After apply conflicts, preserve the stash and explain the remaining resolution/drop step.

**Acceptance.** Open A, create/drop another stash externally, then apply/pop/drop the originally selected stash. Only the expected hash is affected, or a clear stale-selection error appears. Include pop conflicts and repeated clicks.

Stash numbers identify positions in a changing reflog; the stash object itself has a stable ID. [Git stash](https://git-scm.com/docs/git-stash).

<a id="git-016"></a>

### GIT-016 — P2 — Tag deletion can partially succeed and short tag names are ambiguous

**Evidence:** [src/main/git.js:741](E:/Mac/AtomNano/src/main/git.js:741); [src/main/git.js:464](E:/Mac/AtomNano/src/main/git.js:464); [src/renderer/gitcenter.js:1225](E:/Mac/AtomNano/src/renderer/gitcenter.js:1225). Checks: G30, G36. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Delete locally + on origin deletes the local tag first. If the remote fails, the UI receives only a failure while the local tag is already gone. A branch and tag both named v1 make the remote delete ambiguous, reproducing that partial state. Push this tag also sends the short name through the branch push method.

**Fix.** Use fully qualified refs/tags names for tag publication/deletion. Resolve and retain the expected tag object ID, report local and remote phases independently, and retry only unfinished work. For combined deletion, perform the confirmed remote deletion first and then delete the matching local tag, reporting any remaining local failure without hiding the completed remote step.

**Acceptance.** Test same-named branch/tag, offline/missing remote, remote rejection and tag changed since confirmation. No branch is pushed/deleted through a tag action. A failure report states exactly which side changed and allows a safe phase-specific retry.

<a id="git-017"></a>

### GIT-017 — P1 — Changed-files exports can silently omit files and overwrite their metadata name

**Evidence:** [src/main/git.js:813](E:/Mac/AtomNano/src/main/git.js:813); [src/main/git.js:778](E:/Mac/AtomNano/src/main/git.js:778); [src/main/zipper.js:27](E:/Mac/AtomNano/src/main/zipper.js:27); [src/renderer/gitcenter.js:489](E:/Mac/AtomNano/src/renderer/gitcenter.js:489). Checks: G20, G31, G27. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** commitZip silently skips every failed blob read. A real Unicode filename is omitted while the export returns success. A project file named COMMIT.txt produces duplicate archive entries when audit metadata is added. Deleted paths are skipped but the response has no skipped list, despite the UI expecting one. All contents are accumulated and compressed synchronously, and the minimal ZIP writer has no ZIP64 support or UTF-8 filename flag.

**Fix.** Resolve an explicit export manifest from a validated commit and parent. Put source files under a files/ directory and metadata at the archive root to avoid name collisions. Never silently skip a non-deleted path; fail or return an explicitly incomplete manifest with reasons. Preserve binary bytes, modes/link types and Unicode ZIP metadata. Stream export/compression outside the Electron UI/main hot path, write a temporary archive and publish it atomically only on successful completion. Use native archive for full-tree snapshots.

**Acceptance.** Export a root commit, merge commit, rename, deletion-only commit, binary, Unicode and real COMMIT.txt. Verify unique entry names and exact bytes with an independent ZIP reader. An unreadable or oversized file cannot produce a normal success result. Interrupted exports do not replace an existing destination with a partial archive.

<a id="git-018"></a>

### GIT-018 — P2 — Clean tracked files are displayed as entirely added

**Evidence:** [src/main/git.js:216](E:/Mac/AtomNano/src/main/git.js:216); [src/main/git.js:232](E:/Mac/AtomNano/src/main/git.js:232); [src/renderer/app.js:9733](E:/Mac/AtomNano/src/renderer/app.js:9733). Checks: G05, G06. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** An empty successful tracked diff falls through to `git diff --no-index NUL file`. A clean tracked file therefore becomes an untracked all-added diff, including in the editor gutter. The same fallback turns an empty staged diff into the whole unstaged file. Git failures can also be masked by this fallback.

**Fix.** Determine tracked/untracked state independently. Honor the requested baseline: HEAD versus working tree, index versus working tree, or HEAD versus index. Return an empty successful diff for a clean tracked baseline. Use the no-index path only for a confirmed untracked regular file, and distinguish expected diff exit code 1 from operational errors.

**Acceptance.** Clean tracked files have no diff/gutter marks. Staged view of a file with only unstaged edits is empty. A confirmed untracked file is all-added. Invalid paths and Git failures show an error, not fabricated changes or a clean result.

<a id="git-019"></a>

### GIT-019 — P2 — The diff parser drops real content that resembles file headers

**Evidence:** [src/renderer/diff.js:6](E:/Mac/AtomNano/src/renderer/diff.js:6); [src/renderer/app.js:2567](E:/Mac/AtomNano/src/renderer/app.js:2567). Checks: U16. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Metadata/header filtering runs even inside a hunk. A deleted content line beginning `-- ` becomes a raw `--- ` line and is discarded as an old-file header; an added content line beginning `++ ` is similarly dropped. The reproduction loses both changed lines and reports +0/-0.

**Fix.** Make parsing stateful: recognize file metadata only outside hunks and consume hunk body lines using their prefix and declared old/new counts. Preserve no-newline markers and file/mode/rename metadata in the result. Explicitly identify combined diffs or request a supported ordinary diff rather than treating unsupported output as empty.

**Acceptance.** Render SQL-style `-- comment`, added `++ ...`, normal headers, empty lines, CRLF content and missing-final-newline changes. Counts, line numbers and text must match Git output. Binary and metadata-only changes remain distinguishable.

<a id="git-020"></a>

### GIT-020 — P2 — Merge commits can show no changed files and no diff

**Evidence:** [src/main/git.js:526](E:/Mac/AtomNano/src/main/git.js:526); [src/main/git.js:541](E:/Mac/AtomNano/src/main/git.js:541); [src/renderer/gitcenter.js:1002](E:/Mac/AtomNano/src/renderer/gitcenter.js:1002). Checks: G19. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** commitInfo and commitFileDiff use default git show behavior for merges. A normal merge with distinct changes on each parent yields an empty files list and empty file diff, although its first-parent diff contains feature.txt. The UI says the commit changes no files, and changed-files export shares this result. The comment claiming first-parent behavior is inaccurate.

**Fix.** Choose an explicit comparison parent for commit inspection; default to first parent and expose a parent selector for merges. Obtain name-status, numstat, patch and export membership from the same selected parent and commit IDs. Compare a root commit against the empty tree.

**Acceptance.** Show a clean merge, a manually resolved merge, an octopus merge and a root commit. The displayed parent is explicit, and file counts/diffs/export membership agree with that parent. No ordinary merge is mislabeled empty because of combined-diff defaults.

Combined merge diffs are a different format; an explicit parent comparison avoids treating an unsupported/default merge display as a normal file diff. [Git show](https://git-scm.com/docs/git-show#_combined_diff_format).

<a id="git-021"></a>

### GIT-021 — P1 — Conflict results are reported as successful pull or completed rebase

**Evidence:** [src/main/git.js:195](E:/Mac/AtomNano/src/main/git.js:195); [src/main/git.js:364](E:/Mac/AtomNano/src/main/git.js:364); [src/renderer/gitcenter.js:330](E:/Mac/AtomNano/src/renderer/gitcenter.js:330); [src/renderer/app.js:1408](E:/Mac/AtomNano/src/renderer/app.js:1408); [src/renderer/app.js:1420](E:/Mac/AtomNano/src/renderer/app.js:1420); [src/renderer/app.js:3110](E:/Mac/AtomNano/src/renderer/app.js:3110); [src/renderer/app.js:2112](E:/Mac/AtomNano/src/renderer/app.js:2112). Checks: G29, G33, U06, U14. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** The backend correctly returns `{ok:false, conflict:true}` for a conflicted pull and for a rebase that stops at another commit. Git Center's forAll and the legacy pull handlers treat a resolved Promise as success. The guided resolver's completeMerge closes and shows Merge completed even when mergeContinue reports another rebase conflict. The older commitSelected batch path also accumulates only successes for its final summary, allowing a later success toast to hide an earlier repository's failed commit.

**Fix.** Define one result contract with explicit success, conflict, failed, canceled and partial states. Make all single/multi-repository consumers branch on that state. A continuation that conflicts again keeps the resolver open, reloads operation state and affected files, and preserves any pending push for the same operation. Summaries must retain every repository's result.

**Acceptance.** Pull-all with one conflict reports that repository as needing resolution. Resolve the first of two rebase conflicts: the next appears and no completion toast or push is produced. Exercise the same result handling through Git Center, tree menus, legacy panels and retry flows.

<a id="git-022"></a>

### GIT-022 — P2 — Repository and history loads can overwrite newer UI state

**Evidence:** [src/renderer/gitcenter.js:245](E:/Mac/AtomNano/src/renderer/gitcenter.js:245); [src/renderer/gitcenter.js:258](E:/Mac/AtomNano/src/renderer/gitcenter.js:258); [src/renderer/gitcenter.js:285](E:/Mac/AtomNano/src/renderer/gitcenter.js:285); [src/renderer/gitcenter.js:980](E:/Mac/AtomNano/src/renderer/gitcenter.js:980); [src/renderer/gitcenter.js:187](E:/Mac/AtomNano/src/renderer/gitcenter.js:187); [src/renderer/app.js:1383](E:/Mac/AtomNano/src/renderer/app.js:1383). Checks: U01, U08, U10. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** `selectRepo` assigns S.info before checking its generation, so an older A response can overwrite B's state even when it is not rendered. History searches within the same render use the same generation and append obsolete results. Closing during initial discovery can dereference a missing content node. The legacy refresh/compare code also lacks complete request identity checks.

**Fix.** Keep loaded data local until repository and request-generation validation passes. Use separate request IDs for repository selection, history query/page, commit detail, diff and initial open lifecycle. Include query/filter/offset in cache keys; deduplicate commit IDs and block duplicate page loads. Invalidate and settle pending UI work on close. Apply the same pattern to legacy compare and editor-gutter callbacks.

**Acceptance.** Reverse completion order for repo, filter, page and file reads; only the newest matching request may update the view. Close/reopen during discovery without rejected promises or orphan dialogs. Stale history results and duplicate pages never appear.

<a id="git-023"></a>

### GIT-023 — P2 — Git failures are presented as a clean repository

**Evidence:** [src/main/git.js:37](E:/Mac/AtomNano/src/main/git.js:37); [src/main/git.js:93](E:/Mac/AtomNano/src/main/git.js:93); [src/renderer/gitcenter.js:252](E:/Mac/AtomNano/src/renderer/gitcenter.js:252); [src/renderer/gitcenter.js:782](E:/Mac/AtomNano/src/renderer/gitcenter.js:782); [src/renderer/app.js:1383](E:/Mac/AtomNano/src/renderer/app.js:1383). Checks: U22. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Status exceptions become synthetic repositories with an empty files array; Git Center then says Working tree clean. The legacy fallback even sets clean:true. isRepo also collapses missing Git, inaccessible paths and command failures into false, so repository discovery can hide a configuration problem as No Git repository.

**Fix.** Represent loading, ready, error, stale and not-a-repository explicitly. Retain the last successful snapshot with a stale/error label and disable mutations that require current state. Surface command-not-found, permissions, trust/safe-directory, timeout and invalid repository as distinct actionable errors. Do not add broad safe.directory trust automatically.

**Acceptance.** Inject status timeout, missing Git and inaccessible .git conditions. The UI never claims clean or silently removes the repo. Recovery refresh updates the same repo and restores actions only after a valid status snapshot.

<a id="git-024"></a>

### GIT-024 — P2 — Compare enables mutation even when its review failed

**Evidence:** [src/renderer/gitcenter.js:700](E:/Mac/AtomNano/src/renderer/gitcenter.js:700); [src/renderer/gitcenter.js:717](E:/Mac/AtomNano/src/renderer/gitcenter.js:717); [src/renderer/gitcenter.js:542](E:/Mac/AtomNano/src/renderer/gitcenter.js:542); [src/renderer/app.js:2713](E:/Mac/AtomNano/src/renderer/app.js:2713). Checks: U07. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Compare catches commit/file/count failures separately but still sets ready:true, which enables Merge and Rebase. The legacy compare button similarly gates on ref names rather than a completed valid review. Changes to branch tips after review are not represented in an immutable comparison identity.

**Fix.** Require successful comparison inputs and resolved source/target object IDs before marking review ready. Show partial read results as partial and keep review-dependent actions disabled. Bind the approval to those exact IDs; invalidate it on a ref/repository change and revalidate before mutation. Label a three-dot source diff as source changes, since it is not a prediction of the resolved merge tree.

**Acceptance.** Fail any comparison request or move either ref after review. The UI must not execute a previously armed operation silently. Refreshing a successful review enables it again with the new IDs and clear comparison direction.

<a id="git-025"></a>

### GIT-025 — P2 — Operation recovery controls do not match all detected Git states

**Evidence:** [src/main/git.js:323](E:/Mac/AtomNano/src/main/git.js:323); [src/main/git.js:352](E:/Mac/AtomNano/src/main/git.js:352); [src/main/git.js:364](E:/Mac/AtomNano/src/main/git.js:364); [src/main/git.js:378](E:/Mac/AtomNano/src/main/git.js:378); [src/renderer/gitcenter.js:578](E:/Mac/AtomNano/src/renderer/gitcenter.js:578); [src/renderer/app.js:2930](E:/Mac/AtomNano/src/renderer/app.js:2930). Checks: G25, G24. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** repoState detects bisect, but the banner routes Abort to merge --abort and Continue toward a commit, neither of which implements bisect recovery. The guided resolver always says merge even for rebase/cherry-pick/stash conflicts. Stash conflicts have no normal merge operation to complete. The backend's no-operation Continue fell back to commit and was rejected by Git's empty-message check in the fixture; no accidental commit was reproduced. Sequencer-only/empty-stop states are not explicitly modeled.

**Fix.** Define operation-specific available actions and dispatch them in main: merge/rebase/cherry-pick/revert continue/abort/skip as supported, bisect reset/good/bad as appropriate, and resolve-only for stash conflicts. Recognize sequencer and empty-commit stop states. Reject Continue when there is no compatible operation. Disable normal selected-file Commit while a merge/rebase continuation must finish.

**Acceptance.** Cover merge, two-stop rebase, cherry-pick, revert, bisect, stash conflicts and no active operation. Labels and actions match the actual state. Failed state inspection cannot lead to a generic commit or an unrelated abort.

<a id="git-026"></a>

### GIT-026 — P2 — The resolver cannot reliably handle deletion, binary or unsupported marker conflicts

**Evidence:** [src/main/git.js:832](E:/Mac/AtomNano/src/main/git.js:832); [src/renderer/app.js:2912](E:/Mac/AtomNano/src/renderer/app.js:2912); [src/renderer/app.js:3056](E:/Mac/AtomNano/src/renderer/app.js:3056); [src/renderer/conflicts.js:4](E:/Mac/AtomNano/src/renderer/conflicts.js:4); [src/renderer/conflicts.js:43](E:/Mac/AtomNano/src/renderer/conflicts.js:43); [src/main/files.js:109](E:/Mac/AtomNano/src/main/files.js:109). Checks: G23, U17. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Choosing the deleted side of a modify/delete conflict calls checkout --ours/--theirs for a nonexistent index stage and fails. Binary, too-large and read-error responses are treated as empty text by the line resolver; zero parsed conflicts leave its resolution button unusable without explaining the file type. Marker parsing hard-codes seven-character separators. Unterminated diff3 markers lose base/incoming text in parser round-trip and leave count inconsistent. The ordinary UI prevents resolving that malformed example, so parser loss was not reproduced as an on-disk overwrite.

**Fix.** Read unmerged index stages and file types first. Represent a missing stage as deletion and resolve it with the appropriate index removal. Route binary, symlink, submodule, unreadable and oversized cases to explicit supported actions. Use a lossless parser with completeness/errors and configured marker widths; never silently reconstruct malformed input. Block invalid custom results or make an explicit unresolved-marker decision.

**Acceptance.** Handle modify/delete and add/add, binary conflicts, custom marker sizes, diff3, truncated markers and read errors. Both sides remain inspectable when present. A deleted-side choice actually stages deletion. Unsupported content remains byte-preserved and clearly identified.

<a id="git-027"></a>

### GIT-027 — P2 — Conflict save changes line endings and can lose resolution drafts

**Evidence:** [src/renderer/app.js:2912](E:/Mac/AtomNano/src/renderer/app.js:2912); [src/renderer/app.js:3020](E:/Mac/AtomNano/src/renderer/app.js:3020); [src/renderer/app.js:3075](E:/Mac/AtomNano/src/renderer/app.js:3075); [src/renderer/app.js:3122](E:/Mac/AtomNano/src/renderer/app.js:3122); [src/main/files.js:146](E:/Mac/AtomNano/src/main/files.js:146). Checks: U15. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** The loader normalizes CRLF to LF and the save path writes that normalized text directly. The fixture converts a CRLF conflict file to LF. Moving to another file clears choices/custom edits; closing the overlay also discards uncommitted resolution choices. The generic writer assumes UTF-8 and carries no encoding metadata.

**Fix.** Keep original encoding, BOM, newline convention and final-newline state with each file's resolution draft. Preserve them on validated atomic save. Persist choices/custom text per conflict file during navigation, and explicitly handle closing with unsaved resolution edits. Coordinate with external/editor changes using the identity checks in GIT-006.

**Acceptance.** Resolve Windows CRLF files without changing untouched line endings or BOM. Round-trip a missing final newline. Navigate across files and back with custom edits intact. Reject unsupported encodings rather than rewriting them as replacement characters.

<a id="git-028"></a>

### GIT-028 — P2 — Historical file preview corrupts binary representation and silently truncates text

**Evidence:** [src/main/git.js:546](E:/Mac/AtomNano/src/main/git.js:546); [src/renderer/gitcenter.js:1057](E:/Mac/AtomNano/src/renderer/gitcenter.js:1057). Checks: G32. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** fileAt decodes every blob as UTF-8; binary bytes 0xFF/0x80 become replacement characters. Text over 1,500,000 characters is sliced and an annotation is appended to the content itself, with no structured truncated flag or way to load the rest. The current viewer is read-only, so this finding concerns inspection fidelity, not an observed save-back corruption.

**Fix.** Return typed blob metadata with binary/encoding, byte length, truncation and a continuation mechanism. Keep content separate from status messages. Use a binary/image-specific preview or exact-byte download when appropriate, and fetch large text in chunks. Make deleted-file inspection point to the selected parent version rather than an absent blob.

**Acceptance.** Binary previews never masquerade as decoded source text. Text past the current limit is accessible in full, including multibyte boundaries. Any partial display states its extent and provides the remaining content; export preserves original bytes.

<a id="git-029"></a>

### GIT-029 — P2 — Large file selections fail at the Windows argument-length limit

**Evidence:** [src/main/git.js:131](E:/Mac/AtomNano/src/main/git.js:131); [src/main/git.js:181](E:/Mac/AtomNano/src/main/git.js:181); [src/main/git.js:386](E:/Mac/AtomNano/src/main/git.js:386); [src/main/git.js:832](E:/Mac/AtomNano/src/main/git.js:832). Checks: G34. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** Selected-file operations spread every path into process arguments. A fixture with 440 valid filenames produces about 39,929 path characters and stage fails with spawn ENAMETOOLONG. Stage All succeeds on those same files. Large selections can therefore fail despite every individual file being valid.

**Fix.** Move selected path lists to NUL-delimited stdin or a temporary pathspec file for commands that support it, with literal semantics. For commands that lack that interface, use bounded batches under one operation plan and expose partial failures; do not split one logical commit into multiple commits. Reuse this transport across stage/unstage/discard/resolve and the CommitPlan.

**Acceptance.** Operate on thousands of long paths on Windows. Selected staging and commit succeed without truncating the selection. Check progress/cancellation between safe batches and preserve all nonselected paths.

<a id="git-030"></a>

### GIT-030 — P2 — Git operations expose no live process output or cancellation

**Evidence:** [src/main/git.js:16](E:/Mac/AtomNano/src/main/git.js:16); [src/main/git.js:31](E:/Mac/AtomNano/src/main/git.js:31); [src/main/git.js:778](E:/Mac/AtomNano/src/main/git.js:778); [src/main/main.js:1024](E:/Mac/AtomNano/src/main/main.js:1024); [src/main/preload.js:193](E:/Mac/AtomNano/src/main/preload.js:193); [src/renderer/gitcenter.js:310](E:/Mac/AtomNano/src/renderer/gitcenter.js:310). Source-confirmed behavior or implementation gap; a dedicated runtime reproduction was not added.

**Issue and impact.** Every Git command is buffered by execFile until completion. The UI can show an indeterminate strip/toast, but cannot display native fetch/push progress, hook output, signing/authentication waits or cancel its owned process. Errors are reduced to four lines and 400 characters, while broad output regexes classify conflicts and push rejection. A long-running or timed-out process can leave unclear partial state.

**Fix.** Introduce one main-process operation runner using streamed stdout/stderr, operation IDs, explicit phases and typed results. Decode stream chunks correctly, preserve carriage-return progress, use --progress where needed and keep a bounded visible log backed by complete diagnostics. Provide Cancel for the owned process tree, configurable timeouts and post-cancel state refresh. Scrub only repository-routing environment variables such as inherited GIT_DIR/WORK_TREE/INDEX_FILE; preserve legitimate Git/SSH/helper configuration.

**Acceptance.** A slow local transfer or hook shows command start and changing output before exit. UTF-8 split across chunks is intact. Cancel reports canceled/partial accurately and affects only the owned process. Network, hook, signing, lock and timeout errors retain useful diagnostics and do not become success or automatic conflict recovery.

<a id="git-031"></a>

### GIT-031 — P2 — Git Center does not automatically receive external repository updates

**Evidence:** [src/renderer/app.js:3452](E:/Mac/AtomNano/src/renderer/app.js:3452); [src/renderer/app.js:1383](E:/Mac/AtomNano/src/renderer/app.js:1383); [src/main/files.js:11](E:/Mac/AtomNano/src/main/files.js:11); [src/main/files.js:156](E:/Mac/AtomNano/src/main/files.js:156); [src/renderer/gitcenter.js:245](E:/Mac/AtomNano/src/renderer/gitcenter.js:245); [src/renderer/gitcenter.js:285](E:/Mac/AtomNano/src/renderer/gitcenter.js:285). Source-confirmed behavior or implementation gap; a dedicated runtime reproduction was not added.

**Issue and impact.** The filesystem watcher ignores .git. External file changes refresh the sidebar only when its Git view is active; they do not refresh Git Center's separate S.statuses or S.info. Index-only staging, a commit of already-staged content, fetches and some ref operations can leave the displayed files, branch or ahead/behind counts stale until manual refresh.

**Fix.** Publish a shared repository snapshot/event service consumed by all Git surfaces. Observe relevant worktree and Git metadata changes with debouncing/coalescing; invalidate snapshots after in-app operations and on window focus. Refresh only affected repositories and preserve active UI state. Validate expected state again before a destructive operation rather than relying on watcher timing.

**Acceptance.** While Git Center is open, stage, unstage, commit, fetch and switch branches from a terminal or agent. Both Git surfaces update promptly, including metadata-only changes, without destroying a draft or stealing focus. Repeated events coalesce and do not run overlapping full refreshes.

<a id="git-032"></a>

### GIT-032 — P2 — Refreshing and expanding rebuilds the UI and long lists block the renderer

**Evidence:** [src/renderer/gitcenter.js:623](E:/Mac/AtomNano/src/renderer/gitcenter.js:623); [src/renderer/gitcenter.js:782](E:/Mac/AtomNano/src/renderer/gitcenter.js:782); [src/renderer/gitcenter.js:830](E:/Mac/AtomNano/src/renderer/gitcenter.js:830); [src/renderer/gitcenter.js:980](E:/Mac/AtomNano/src/renderer/gitcenter.js:980); [src/renderer/app.js:2567](E:/Mac/AtomNano/src/renderer/app.js:2567); [src/renderer/diff.js:33](E:/Mac/AtomNano/src/renderer/diff.js:33). Checks: U09, U20. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** renderMain clears and recreates the entire content tree. Refresh replaces a focused commit textarea, moving focus to BODY even though the draft text survives. Directory toggles also recreate the view/diff. In one headless run, 5,000 changed files created 5,000 rows and 65,075 content DOM nodes, with about 266 ms for renderMain; this is a local component measurement, not a packaged-app frame-rate benchmark. Diff processing and word LCS are synchronous, and history redraws all loaded rows.

**Fix.** Keep the shell, commit form and active diff mounted. Update keyed rows and counters, retain caret/selection/scroll, cache parsed diffs by exact identities and virtualize large file/history/diff lists. Move expensive parsing/word diff into a worker or scheduled chunks. Keep bounded rendering without discarding underlying content. Prefer stable content plus a subtle progress indicator to repeated blank/loading transitions.

**Acceptance.** Stage a file while typing a draft: focus, caret and draft remain stable. Expand a folder without resetting the diff or scroll. Profile 5,000-file and large-diff fixtures on the target Electron build; keep interaction work within a documented frame/latency budget and DOM size tied to the viewport. Content remains fully accessible.

<a id="git-033"></a>

### GIT-033 — P2 — Unborn repositories show the wrong branch and Unstage all fails

**Evidence:** [src/main/git.js:93](E:/Mac/AtomNano/src/main/git.js:93); [src/main/git.js:126](E:/Mac/AtomNano/src/main/git.js:126); [src/main/git.js:160](E:/Mac/AtomNano/src/main/git.js:160); [src/renderer/gitcenter.js:258](E:/Mac/AtomNano/src/renderer/gitcenter.js:258). Checks: G02, G03, G04. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** The initial porcelain header is parsed as branch No instead of main. Unstage All invokes reset HEAD and fails before the first commit. Per-file unstage and discard of a staged-new file worked correctly with the tested Git version; those should not be treated as failures. Branch/history pickers do not have a clear unborn state.

**Fix.** Parse explicit porcelain branch headers and represent unborn HEAD separately from detached HEAD. Resolve the symbolic branch name even when no commit exists. Clear the unborn index using an empty-tree/index operation that preserves working files. Disable history/rebase/amend/push actions that require a commit and explain the first-commit path.

**Acceptance.** Initialize a repository and use Changes before its first commit: the chosen branch name is correct, stage and both unstage variants work, and file bytes remain intact. First commit produces a normal branch snapshot and enables the appropriate features.

<a id="git-034"></a>

### GIT-034 — P2 — Remote list parsing drops valid local URLs and checkout can select the wrong tracking branch

**Evidence:** [src/main/git.js:750](E:/Mac/AtomNano/src/main/git.js:750); [src/main/git.js:620](E:/Mac/AtomNano/src/main/git.js:620); [src/renderer/gitcenter.js:1128](E:/Mac/AtomNano/src/renderer/gitcenter.js:1128); [src/renderer/gitcenter.js:1238](E:/Mac/AtomNano/src/renderer/gitcenter.js:1238). Checks: G21, G22. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** The whitespace-based remote -v parser omits a valid filesystem remote containing spaces and overwrites multiple URLs into one string. Separately, Check out as a tracking local branch silently checks out any existing same-named local branch, even if it points elsewhere and has no matching upstream. The fixture chooses local feature instead of the selected origin/feature commit.

**Fix.** Read remote names and complete fetch/push URL arrays through configuration-aware Git queries. For remote checkout, resolve the selected remote ref and inspect the existing local branch's upstream/identity. Offer an explicit existing-branch choice or create a uniquely named tracking branch; do not imply that an unrelated branch is the selected remote.

**Acceptance.** List Windows local remotes with spaces, SSH URLs and distinct/multiple push URLs without losing data. With feature already tracking another remote or at a different commit, remote checkout must clearly identify what will be checked out and preserve existing local work.

<a id="git-035"></a>

### GIT-035 — P2 — The legacy Review & commit Merge tab has incompatible API contracts

**Evidence:** [src/renderer/app.js:1657](E:/Mac/AtomNano/src/renderer/app.js:1657); [src/main/git.js:243](E:/Mac/AtomNano/src/main/git.js:243); [src/renderer/app.js:1796](E:/Mac/AtomNano/src/renderer/app.js:1796); [src/renderer/app.js:8644](E:/Mac/AtomNano/src/renderer/app.js:8644). Checks: U23, U24. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** The embedded merge screen reads info.local/info.remote while the backend returns locals/remotes, so its branch pickers are empty. Its merge action also awaits confirmDialog as a Boolean Promise, but confirmDialog is callback-based and returns undefined. Confirming that dialog calls a missing onConfirm handler. Repairing only the branch-field mismatch leaves the merge action broken.

**Fix.** Consolidate this screen onto the same typed branch/comparison/action services as Git Center. Use one Promise-based dialog contract that resolves on all close paths and migrate callers coherently. Keep the legacy entry point working or intentionally route it into the maintained Git Center flow.

**Acceptance.** Open Review & commit, select Merge, choose two branches, review, cancel, then confirm a merge. Branches load from the real IPC shape; cancel performs no mutation; confirmation invokes exactly one intended merge; no page errors occur.

<a id="git-036"></a>

### GIT-036 — P2 — Retry failed can recommit after only the push failed

**Evidence:** [src/renderer/app.js:2028](E:/Mac/AtomNano/src/renderer/app.js:2028); [src/renderer/app.js:2052](E:/Mac/AtomNano/src/renderer/app.js:2052); [src/renderer/app.js:2074](E:/Mac/AtomNano/src/renderer/app.js:2074). Checks: U18. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** The legacy Commit & Push progress row stores one overall Boolean. If commit succeeds and push fails, Retry failed runs the whole commit pipeline again. The reproduction calls commit twice but push only once, then gets stuck at nothing to commit. If files changed in between, the retry could create an unintended additional commit.

**Fix.** Persist independent stage/commit/push phase outcomes with the committed object ID and destination PushPlan. A failed push retry must resume from push after validating that identity. Represent partial success in the headline and per-repository rows and preserve successful repositories when others fail.

**Acceptance.** Make commit succeed and the first push fail. Retry sends the recorded commit without restaging/recommitting, even if new working changes exist. A multi-repository batch retries only unfinished phases and correctly reports committed-but-not-pushed state.

<a id="git-037"></a>

### GIT-037 — P2 — Canceled dialogs leave unresolved action promises and widget cleanup is incomplete

**Evidence:** [src/renderer/gitcenter.js:357](E:/Mac/AtomNano/src/renderer/gitcenter.js:357); [src/renderer/gitcenter.js:61](E:/Mac/AtomNano/src/renderer/gitcenter.js:61); [src/renderer/gitcenter.js:117](E:/Mac/AtomNano/src/renderer/gitcenter.js:117); [src/renderer/app.js:3920](E:/Mac/AtomNano/src/renderer/app.js:3920); [src/renderer/app.js:8656](E:/Mac/AtomNano/src/renderer/app.js:8656). Source-confirmed behavior or implementation gap; a dedicated runtime reproduction was not added.

**Issue and impact.** Git Center wraps promptDialog with a Promise resolved only by confirmation. Cancel/close/Escape never settle it. chooseDialog settles only through its choice buttons, not shell close. Pickers add outside-click listeners on a deferred timer, which can run after a close. Native append calls in pickList and unlabeled confirm fields also append literal null when optional children are absent.

**Fix.** Use a shared dialog lifecycle with a single idempotent finish function returning a typed confirmed/canceled result on buttons, Escape, backdrop, window resize and parent close. Cancel delayed listener/focus registration and clean up on disposal. Filter absent children before native append. Keep focus restoration tied to a still-connected opener.

**Acceptance.** Every dismissal route settles the awaiting action exactly once and performs no mutation. Open/close/reopen rapidly without leaked listeners or orphan popovers. Repo/branch pickers and unlabeled fields display no literal null text.

<a id="git-038"></a>

### GIT-038 — P2 — Git controls have keyboard, accessibility and reduced-motion gaps

**Evidence:** [src/renderer/gitcenter.js:187](E:/Mac/AtomNano/src/renderer/gitcenter.js:187); [src/renderer/gitcenter.js:690](E:/Mac/AtomNano/src/renderer/gitcenter.js:690); [src/renderer/gitcenter.js:752](E:/Mac/AtomNano/src/renderer/gitcenter.js:752); [src/renderer/gitcenter.js:149](E:/Mac/AtomNano/src/renderer/gitcenter.js:149); [src/renderer/styles.css:660](E:/Mac/AtomNano/src/renderer/styles.css:660); [src/renderer/styles.css:1622](E:/Mac/AtomNano/src/renderer/styles.css:1622). Checks: U19, U21. Runtime evidence applies to those cases; additional linked paths were inspected in source.

**Issue and impact.** The Git panel lacks dialog/aria-modal semantics, file/commit rows are click-only divs without keyboard activation, splitters are mouse-only, and selection controls rely heavily on titles. No Git-specific focus trap/restore is installed. The actual CSS still runs diff-fade and the progress animation under prefers-reduced-motion: reduce. Existing picker arrow-key handling and some native checkboxes are useful foundations.

**Fix.** Add appropriate dialog, tree/list, tab and separator semantics with accessible labels, roving focus, keyboard activation and visible focus. Keep action buttons reachable without hover and preserve focus after row updates. Provide keyboard split resizing, focus trap/restore and reduced-motion rules for every Git overlay/picker/popover/progress animation.

**Acceptance.** Complete stage/review/commit, branch selection, history navigation and conflict resolution using keyboard only. Verify screen-reader names/states, focus return, high-contrast modes, zoom/narrow windows and reduced motion. Busy state is enforced semantically as well as visually.

<a id="git-039"></a>

### GIT-039 — P2 — History limits and silent partial reads make reviews incomplete

**Evidence:** [src/main/git.js:437](E:/Mac/AtomNano/src/main/git.js:437); [src/main/git.js:477](E:/Mac/AtomNano/src/main/git.js:477); [src/main/git.js:526](E:/Mac/AtomNano/src/main/git.js:526); [src/main/git.js:541](E:/Mac/AtomNano/src/main/git.js:541); [src/main/git.js:703](E:/Mac/AtomNano/src/main/git.js:703); [src/renderer/gitcenter.js:700](E:/Mac/AtomNano/src/renderer/gitcenter.js:700). Source-confirmed behavior or implementation gap; a dedicated runtime reproduction was not added.

**Issue and impact.** Compare stops at 500 commits and shows a plus marker with no way to load the rest. History has pages, but query/duplicate-page correctness needs GIT-022. Several secondary Git reads, including commit name/numstat and some diff/stash reads, use stdout even if the command failed. Historical file truncation and subprocess caps are separate content limits. File history also depends on user log.follow configuration rather than an explicit product choice.

**Fix.** Paginate comparison commits using stable ref IDs and return explicit complete/partial/error state for every read. Check each subprocess result and propagate an actionable error rather than substituting an empty list. Make rename-follow behavior explicit for single-file history. Preserve UI virtualization and bounded caches while providing access to all results.

**Acceptance.** Review more than 500 source commits and reach the final one without duplication or omissions. Fail one secondary read and show the failure rather than No changes. Follow a renamed file across its earlier name when the UI claims full file history, documenting Git's nonlinear-history limits.

Single-file rename following is an explicit Git history behavior with limitations on nonlinear history. [Git log](https://git-scm.com/docs/git-log).

<a id="git-040"></a>

### GIT-040 — P2 — Git smoke tests do not cover the maintained Git Center and lack profile isolation

**Evidence:** [smoke-tests/test-git-multi.js:37](E:/Mac/AtomNano/smoke-tests/test-git-multi.js:37); [smoke-tests/test-git-multi.js:47](E:/Mac/AtomNano/smoke-tests/test-git-multi.js:47); [smoke-tests/test-git-conflict.js:20](E:/Mac/AtomNano/smoke-tests/test-git-conflict.js:20); [src/main/main.js:25](E:/Mac/AtomNano/src/main/main.js:25); [src/main/main.js:49](E:/Mac/AtomNano/src/main/main.js:49); [package.json:15](E:/Mac/AtomNano/package.json:15). Source-confirmed behavior or implementation gap; a dedicated runtime reproduction was not added.

**Issue and impact.** The existing Git smoke suites exercise legacy __git/__openDiff/__openConflictResolver hooks; no Git Center coverage was found in them. Tests use fixed temporary paths and recursively delete them, and launch AtomNano with ATOMNANO_TEST without a dedicated userData/credential-home configuration. That flag exposes test hooks and skips selected behaviors; it does not isolate startup settings/login seeding. package.json has no unified test script.

**Fix.** Create a standard test bootstrap with unique fixture roots, isolated Electron userData and explicit empty provider/Git homes, deterministic Git identity/configuration and local-only remotes. Verify cleanup containment and await process exit. Add primary Git Center contract/component tests and a smaller full Electron end-to-end matrix. Turn each applicable audit reproduction into a desired-behavior regression test and wire CI commands.

**Acceptance.** Run the Git suite twice concurrently without sharing paths or profiles. Verify real user settings/accounts are untouched. CI covers the actual Git Center entry point, legacy routing, all result states and each P1 reproduction. A failing assertion must produce a nonzero result and cleanup must leave no running app processes.

## Feature gaps and improvements

These are bounded follow-on capabilities or incomplete features. P2 GAP items should be designed alongside the related fixes; P3 items are optional scope after the core findings pass. A missing advanced feature is not evidence that ordinary native Git behavior is broken.

| ID | Priority | Capability | Present limitation | Concrete implementation and acceptance |
| --- | --- | --- | --- | --- |
| GAP-01 | P3 | Initialize or clone a repository | Only discovery of existing repos exists. | Add explicit Init and Clone flows with validated destination, existing-folder rules, progress/cancel and a local-repository fixture. Use the shared runner and OS credential helper. |
| GAP-02 | P2 | Workspace repository and worktree management | Discovery returns the containing repo or immediate child repos; deeper/nested repos are not listed and submodules/worktrees lack dedicated management. | Add an explicit repository list and bounded discovery with visible scope/results. Model common Git dir and worktree separately; identify submodules and open their own repository view. Test nested repos, .git files and linked worktrees. |
| GAP-03 | P3 | Stage/unstage or commit selected hunks | The UI selects whole files; there are no hunk/line staging controls. | After CommitPlan is reliable, add hunk selection with exact base/index identity and preview. Preserve nonselected hunks, binary handling and changed-on-disk checks. |
| GAP-04 | P3 | Graph, blame and reflog recovery | History already returns parents, but there is no branch graph, blame view or reflog recovery flow. | Use a virtualized graph and explicit file blame/reflog inspection. Recovery actions show the exact ref/commit and use the same validated mutation plan. |
| GAP-05 | P2 | Merge-parent choice and sequenced history operations | cherryPick/revert silently use mainline 1 for a single merge; cherryPick accepts arrays but checks merge-parent requirements only for a one-item list. UI has no interactive rebase plan. | Expose/record parent choice and preflight every item in a sequence. A sequence containing a merge must not fail halfway merely because its required parent was never planned. Add reorder/squash only after continue/abort/skip state coverage exists. |
| GAP-06 | P3 | Stash scope and index restoration | Save supports keepIndex in backend but not the UI; apply/pop expose no restore-index option or selected-path scope. | Expose intentional stash scope and index restoration with clear preview. Verify staged versus unstaged content before/after apply and preserve the stash on conflict. |
| GAP-07 | P2 | Edit remote URLs and choose publication targets | UI supports Add/Remove, while push/tag flows repeatedly assume origin. There is no complete remote/refspec editor. | Add validated fetch/push URL editing and per-operation destination selection. Show multiple push URLs explicitly and avoid deleting/recreating a remote just to change its URL. |
| GAP-08 | P3 | Git identity/authentication diagnostics | Git uses system helper/SSH configuration; the UI does not expose effective author/committer/signing identity or a Git-specific account workflow. | Show effective repository Git identity and selected remote, and provide bounded connection diagnostics through the runner. Keep Git auth separate from Claude/OpenAI accounts; do not store or substitute provider API keys as Git credentials. |
| GAP-09 | P3 | Hosted pull/merge-request workflow | A browser URL helper exists in the legacy merge view; there is no provider API workflow for PR/MR creation, reviews, checks or protected-branch policy. | First repair that entry point and normalize typed remote refs when constructing links. Treat hosted API integration as an optional separate feature with explicit remote/provider support and credentials. |
| GAP-10 | P3 | Explicit pull policy and advanced repository capabilities | The pull choice is merge/rebase; LFS, sparse checkout, signed-commit prompts, submodule operations and very large repositories have no capability-specific UI. | Expose the chosen pull policy, including ff-only where supported, and detect capabilities needed by the opened repo. Report unavailable requirements or external helper waits clearly; retain native Git behavior and never silently bypass hooks/signing. |

For stash restoration, Git distinguishes restoring working changes from restoring their staged/index state. Expose that choice rather than implying Apply always recreates the original staging. [Git stash index restoration](https://git-scm.com/docs/git-stash).

## UI changes: before, after and why

| Before | After | Why |
| --- | --- | --- |
| Pending work uses the currently selected repository. | Every operation shows its captured repository/branch and stays attached to them. | Prevents changes in the wrong workspace. |
| Push text describes upstream while execution may choose origin. | Show the exact resolved remote and destination ref used by execution. | Makes publication review accurate. |
| Selection, staging and complete working-file commits are mixed together. | Separate selection/staging controls and preview the exact selected CommitPlan. | The user can tell which content will land. |
| Refresh removes the current form and diff. | Keep stable controls and update keyed data in place. | Preserves typing, caret, scroll and visual continuity. |
| A status failure produces Working tree clean. | Show last-known data with an error/stale label and a retry. | Prevents confidence in an unknown state. |
| A spinner is the only long-operation feedback. | Display phases, live output, elapsed time, cancellation and persistent final results. | Makes hooks, transfers and waits understandable. |
| Every conflict is labeled as a merge with generic Mine/Incoming. | Show operation-aware branches/commits and file-type-aware choices. | Prevents reversed rebase decisions and dead ends. |
| A second rebase conflict closes the resolver as completed. | Advance to the next actual conflict and show progress across the sequence. | Keeps recovery and pending push state correct. |
| Thousands of rows/diff lines mount together. | Virtualize the viewport and load/parse progressively without omitting content. | Keeps interactions responsive. |
| Small optional UI children can render as literal null. | Filter absent children and use intentional empty states. | Removes visual artifacts. |
| Mouse-only rows/dividers and animated reduced-motion state. | Keyboard-accessible controls, clear focus and respected motion preference. | Makes the complete flow usable beyond mouse input. |
| Generic Retry reruns stage/commit/push. | Retry the failed phase against its recorded commit and destination. | Prevents duplicate commits and preserves partial success. |

Use quiet, stable transitions when loading diffs and statuses. Preserve panel dimensions, keep the previous valid content visible while refreshing, and avoid repeated fade-in or full redraw on every Git event. Reduce motion to immediate state changes. Performance optimizations should bound work and DOM size, not remove files or truncate the underlying review.

## Implementation order and target contracts

| Phase | Work | Findings | Required outcome |
| --- | --- | --- | --- |
| 0 | Isolate tests and freeze contracts | GIT-040 | A deterministic test bootstrap, baseline fixtures and shared result/request shape; no user profile access. |
| 1 | Make backend mutations precise | GIT-001, GIT-002, GIT-003, GIT-004, GIT-012, GIT-013, GIT-014, GIT-015, GIT-016, GIT-029, GIT-030 | Validated literal paths/refs, native Git runner, explicit targets, process ownership, serialization, typed phase results. |
| 2 | Bind UI data and continuations to their repository | GIT-005, GIT-022, GIT-023, GIT-024, GIT-031, GIT-037 | Repository-local state, per-request generations, reliable error/stale states, comparison readiness, shared refresh and settled dialogs. |
| 3 | Make reviewed commits and retries exact | GIT-008, GIT-009, GIT-010, GIT-011, GIT-033, GIT-036 | CommitPlan/temporary index, consistent amend/untrack/rename handling, unborn support and phase-specific retry. |
| 4 | Make conflict recovery safe and operation-aware | GIT-006, GIT-007, GIT-021, GIT-025, GIT-026, GIT-027 | File/version-bound conflict sessions, correct side labels, file-type/EOL handling and correct sequence continuation. |
| 5 | Make inspection and export faithful | GIT-017, GIT-018, GIT-019, GIT-020, GIT-028, GIT-034, GIT-035, GIT-039 | Correct diff baselines/parser/parents, complete typed reads, remote/legacy contracts, paging and verified archives. |
| 6 | Polish and verify the complete UI | GIT-032, GIT-038 | Stable rendering, virtualized lists/diffs, keyboard/focus behavior, reduced motion and packaged Electron verification. |

Implement one coherent design:

1. **Repository identity and snapshot.** Use canonical worktree root plus common Git directory as identity. Include known/error/stale state, branch kind/name, HEAD object ID, upstream/push destinations, index/working change records and active Git operation. Keep the original filename separate from UI text. Read-only refreshes should avoid unnecessary optional Git index locks.
2. **Operation request and result.** Capture operation ID, repository identity, expected ref IDs, paths and options before awaiting user input or subprocesses. Validate again in main. A result records success/conflict/failed/canceled/partial, phase outcomes, affected refs/files, useful diagnostics and refreshed state. Every UI surface consumes this same result shape.
3. **Git runner.** Stream output and progress, own the child process lifetime, serialize mutations sharing repository metadata, and give read work an appropriate concurrency limit. Preserve normal Git credential helpers, SSH, hooks and signing. Keep complete diagnostics available without rendering unbounded output on each event. Cancellation and timeouts must refresh state rather than assume rollback.
4. **CommitPlan.** Record selected file operations, source/destination of renames, explicit removals/untrack intent, exact content/blob IDs, parent/HEAD identity and message/amend intent. Preview that exact tree. Build it in a temporary index, run a single commit, then reconcile only selected entries in the real index. Preserve unrelated staged data and expose partial phases if HEAD advances but index reconciliation fails. Do not automatically reset history to conceal a partial failure.
5. **Conflict session.** Bind every file to its operation/repo/path, index stage object IDs, loaded disk version, encoding/EOL, parsed completeness and per-file draft. Share one side mapping between whole-file and line actions. A save validates the expected version and writes atomically before staging; a continuation can legitimately stop at another conflict.
6. **Read/export identity.** Key history, compare, file and diff queries by resolved commit/parent IDs and filters. Use explicit paging/typed content. Export a complete manifest with unique paths and exact bytes, and publish only the finished archive.
7. **Stable renderer.** Keep the Git shell and active editors/forms mounted. Apply keyed updates, retain focus/scroll/caret, virtualize long lists and schedule expensive parsing away from input handling. Operation state remains observable after navigation or hiding the panel.

These are design recommendations based on the traced failures. Validate the detailed Git command choices with fixtures before replacing the existing implementation, especially temporary-index reconciliation, hooks/signing, worktree locking and operation cancellation.

## Limits and optimizations to change

| Current behavior | Location | Required change |
| --- | --- | --- |
| Historical text sliced at 1,500,000 characters with a notice appended into content. | src/main/git.js:546 | Remove silent content slicing; use typed/paged preview and exact download. |
| Compare stops after 500 commits with only a plus marker. | src/main/git.js:437 | Make every commit accessible with paging tied to resolved refs. |
| History defaults to 100 items and caps a single call at 1,000. | src/main/git.js:477 | Keep a bounded page size, but implement reliable continuation/deduplication and access to all history. |
| Process stdout/stderr buffered to 32 MiB. | src/main/git.js:19 | Stream or spool as appropriate; treat limits as explicit failures/partial results, never No changes. |
| Each blob export buffers up to 256 MiB; all entries stay in memory for synchronous compression. | src/main/git.js:778; src/main/git.js:813 | Stream blobs/archive work and report incomplete reads precisely; use an archive implementation suited to the supported size. |
| Word-level diff falls back when token-table work exceeds 60,000 cells. | src/renderer/diff.js:38 | A full-line fallback preserves text and is acceptable; move costly work off the UI thread rather than silently dropping content. |
| All loaded file/history/diff rows are rendered. | src/renderer/gitcenter.js:782; src/renderer/app.js:2567 | Virtualize visible rows and retain the full underlying dataset. |
| Every selected path becomes a process argument. | src/main/git.js:131 | Use NUL path input/bounded safe transport; never shorten the user's selection. |
| Error details are cut to four lines/400 characters. | src/main/git.js:31 | Show a concise summary plus complete redacted diagnostics and explicit error type. |

The desired outcome is complete, accurate access with smooth UI updates. Removing all pagination, caching or rendering bounds would amplify the measured blocking work; replace content-losing limits with accessible continuation and efficient rendering.

## Behaviors to preserve

| Check | Verified behavior |
| --- | --- |
| G04 | Discard of a staged-new file in an unborn repo successfully unstages and removes that file in the tested Git version. |
| G07 | An ordinary selected-file commit leaves unrelated staged file content out of the commit and still staged. |
| G24 | With no operation or prepared message, native Git rejects the current generic Continue fallback instead of creating a commit. Add an application-level state guard without weakening this outcome. |
| G27 | A native whole-tree ZIP preserved the fixture's binary bytes exactly. |
| G28 | Native checkout rejected an overwrite of conflicting uncommitted work and left the current branch/file unchanged. |
| G29 | The backend exposes a pull conflict as a resolved conflict result with ok:false. Repair consumers rather than hiding that state. |
| G33 | Rebase continuation can return the next conflict. This is expected sequence behavior and must remain visible. |

Source review also confirmed useful existing choices: argv-based spawning with shell disabled, `--force-with-lease` for the force-push path, explicit destructive-action confirmations, normal native Git helper/hook integration, native archive for full snapshots, and text-node rendering for ordinary filenames/diff contents. Preserve these foundations while fixing the missing boundaries and state handling.

## Evidence files and reproducibility

| File | Purpose |
| --- | --- |
| [backend-characterization.cjs](audit-evidence/git-2026-09-09/backend-characterization.cjs) | 33 checks against fresh native Git repositories; original backend loaded with fixture-bound process/filesystem calls. |
| [backend-results.json](audit-evidence/git-2026-09-09/backend-results.json) | Final results G01–G33, with observed outputs and fixture root. |
| [supplemental-characterization.cjs](audit-evidence/git-2026-09-09/supplemental-characterization.cjs) | Three native Git checks for argument length, discard prerequisite failure and ambiguous tag deletion. |
| [supplemental-results.json](audit-evidence/git-2026-09-09/supplemental-results.json) | Final results G34–G36. |
| [ui-characterization.cjs](audit-evidence/git-2026-09-09/ui-characterization.cjs) | 24 original-component browser checks with mocked IPC; includes selected extracted legacy functions. |
| [ui-results.json](audit-evidence/git-2026-09-09/ui-results.json) | Final results U01–U24, including rendering measurement. |
| [review-manifest.json](audit-evidence/git-2026-09-09/review-manifest.json) | Reviewed source hashes, export inventory, finding-to-check mapping and totals. |

The preliminary `*-results-initial.json` files preserve initial hypotheses and a UI fixture naming-collision diagnosis. They are not the final result set and are excluded from the totals above. In particular, initial suspicions about per-file unborn unstage and no-operation Continue causing a commit were rejected or narrowed after native Git tests.

From the project root, the current characterization commands are:

- `node audit-evidence/git-2026-09-09/backend-characterization.cjs . audit-evidence/git-2026-09-09/backend-results.json`
- `node audit-evidence/git-2026-09-09/supplemental-characterization.cjs . audit-evidence/git-2026-09-09/supplemental-results.json`
- `node audit-evidence/git-2026-09-09/ui-characterization.cjs . audit-evidence/git-2026-09-09/ui-results.json`

The harnesses use existing project dependencies. Native-Git harnesses create unique temporary directories, isolate Git configuration/identity and leave their fixture roots recorded for inspection; they do not recursively delete existing user directories. Browser checks run headless and do not start AtomNano or load its profile. Repeated runs create fresh fixtures and overwrite the explicitly named result JSON. Do not point fixture mutations or remote tests at a user's working repository.

### Executed check ledger

A reproduced row means the unwanted behavior is present in the reviewed code. Verified rows are positive cases. The measurement row is observational.

| ID | Result | Case |
| --- | --- | --- |
| G01 | Reproduced | Porcelain paths are quoted and unusable for staging |
| G02 | Reproduced | Unborn status reports branch No |
| G03 | Reproduced | Unstage-all fails before first commit; per-file unstage works |
| G04 | Verified | Discard on unborn added file unstages and deletes it |
| G05 | Reproduced | Clean tracked file becomes all-added diff |
| G06 | Reproduced | Empty staged diff shows entire unstaged file |
| G07 | Verified | Selected commit preserves unrelated staged change |
| G08 | Reproduced | Amend sequence includes unselected staged file |
| G09 | Reproduced | Working-tree preview omits staged content that selected commit includes |
| G10 | Reproduced | Unversion followed by selected-file commit tracks file again |
| G11 | Reproduced | Committing rename destination leaves old path in HEAD |
| G12 | Reproduced | Discard of renamed path fails to restore original path |
| G13 | Reproduced | Pathspec brackets stage another file as well |
| G14 | Reproduced | Create-branch input -D deletes the start-point branch |
| G15 | Reproduced | Soft reset with ref --hard discards working changes |
| G16 | Reproduced | Tag creation input -d deletes existing tag |
| G17 | Reproduced | Push defaults origin despite configured upstream name |
| G18 | Reproduced | Merge into a remote ref leaves merge commit detached |
| G19 | Reproduced | Merge commit info and file diff omit first-parent change |
| G20 | Reproduced | Commit ZIP duplicates COMMIT.txt metadata name |
| G21 | Reproduced | Space-containing filesystem remote is missing from list |
| G22 | Reproduced | Remote checkout silently uses unrelated same-named local branch |
| G23 | Reproduced | Accept deleted side of modify/delete conflict fails |
| G24 | Verified | Continue without operation is rejected by native empty-message check |
| G25 | Reproduced | Abort bisect routes to merge abort |
| G26 | Reproduced | Stale stash index drops a different stash after new stash |
| G27 | Verified | Full archive preserves binary bytes |
| G28 | Verified | Native checkout protects conflicting uncommitted changes |
| G29 | Verified | Pull conflict is a resolved result with ok false |
| G30 | Reproduced | Tag remote failure leaves local tag already deleted |
| G31 | Reproduced | Commit ZIP silently skips quoted Unicode path |
| G32 | Reproduced | Historical binary file decodes into replacement characters |
| G33 | Verified | Rebase continue can return another conflict |
| G34 | Reproduced | Large selected file list exceeds Windows process argument limit |
| G35 | Reproduced | Discard deletes staged-new file after reset fails with index lock |
| G36 | Reproduced | Remote tag deletion uses an ambiguous unqualified ref |
| U01 | Reproduced | Late repository read overwrites current repository info |
| U02 | Reproduced | Commit draft and amend flag carry into another repository |
| U03 | Reproduced | Pending push from A offers push on repository B |
| U04 | Reproduced | Commit-and-push follows repository switched while commit runs |
| U05 | Reproduced | Amend commits repository B after staging repository A |
| U06 | Reproduced | Pull-all reports conflict result as success |
| U07 | Reproduced | Failed compare still enables Merge and Rebase |
| U08 | Reproduced | History search appends a late obsolete result |
| U09 | Reproduced | Refresh replaces focused commit textarea |
| U10 | Reproduced | Closing during initial discovery rejects the open operation |
| U11 | Reproduced | Busy strip permits a keyboard-activated second Git operation |
| U12 | Reproduced | Conflict read race can write file A contents to file B |
| U13 | Reproduced | Line-level Keep mine takes upstream side during rebase |
| U14 | Reproduced | Complete resolver closes and reports success on next rebase conflict |
| U15 | Reproduced | Conflict save changes CRLF line endings to LF |
| U16 | Reproduced | Unified diff parser drops changed lines resembling file headers |
| U17 | Reproduced | Unterminated conflict does not round-trip all input text |
| U18 | Reproduced | Commit-and-push retry repeats commit after push alone failed |
| U19 | Reproduced | Git overlay and progress still animate with reduced motion |
| U20 | Measured | Large Changes view mounts all rows and records render cost |
| U21 | Reproduced | Git dialog lacks dialog semantics and contains plain div rows |
| U22 | Reproduced | Status failure is presented as a clean working tree |
| U23 | Reproduced | Legacy merge picker reads singular branch fields from plural API |
| U24 | Reproduced | Legacy merge awaits callback-only confirm dialog |

## Implementation exit criteria

Each finding's Acceptance paragraph is required in addition to this integration matrix.

| Area | Required verification |
| --- | --- |
| File identity and selection | Spaced/Unicode/bracket/leading-hyphen paths, rename plus edit, case-only rename, tracked deletion plus kept untracked file, thousands of long paths, and preservation of unrelated index entries. |
| Commit semantics | Normal selected commit, message-only/selected amend, root commit, hook/signing failure, concurrent edits, commit-success/push-failure retry, and index reconciliation failure after commit creation. |
| Target identity | Same/different remote names, push-remote rules, different destination branch name, branch/tag collisions, no upstream, detached/unborn state, stale expected refs and force-with-lease rejection. |
| Concurrency and lifecycle | Switch project/repository/window mid-operation; rapid keyboard/click submissions; out-of-order repo/history/diff reads; close/reopen during discovery; fresh per-repo draft/continuation state. |
| Conflicts | Merge, multi-stop rebase, cherry-pick, revert, stash, bisect, modify/delete, add/add, binary, diff3/custom/malformed markers, EOL/BOM, external changes and incomplete custom edits. |
| Inspection/export | Correct clean/staged/working baseline, header-like content lines, no-final-newline, root/merge parent selection, binary/large/history paging, exact ZIP manifest/bytes, deleted-only commit and interruption/failure. |
| Live operation behavior | Streaming output before exit, partial UTF-8 and carriage returns, helper/hook/signing waits, typed auth/network/lock errors, timeout/cancel and accurate final state. |
| Rendering/accessibility | Target Electron profiling for long file/history/diff views; stable focus/caret/scroll; viewport-bound DOM; keyboard-only completion, screen-reader semantics, zoom and reduced motion. |
| Test isolation | Unique fixture/profile roots, no real credentials or hosted remotes, contained cleanup, concurrent test runs and reliable process exit. |
| Compatibility | Git Center and every retained legacy/tree/editor entry point exercise the same contracts and show the same repository and results. |

For any supported remote provider/authentication setup that cannot be exercised in local CI, record a bounded manual test on a dedicated test account/repository. An unavailable external environment must be reported as unverified; it must not be represented as a passing integration check.

## Reviewed source identity

There was no `.git` directory in `E:\Mac\AtomNano` at review time. These hashes identify the source read for this audit; they are not a repository commit ID.

| Source | Lines including final split line | SHA-256 |
| --- | --- | --- |
| src/main/git.js | 853 | `c063eb51acfa56079387e3cbf71739e29e4eedd5e9add8555f9f0c3b441728a8` |
| src/main/main.js | 1464 | `279dd21ce41e082e2855effcb578b93b2b39c355a9fffc5695da2857704f5842` |
| src/main/preload.js | 386 | `07ceb60b968e23de9083f37df3cdfeb34e04decb0637d2c2844fa0a5bf5d5e65` |
| src/main/files.js | 288 | `bd161190d99c53ffca2072fc87aa6e1cc73245d20e6375b47e568817050c080c` |
| src/main/zipper.js | 115 | `f101d0d78962995833a72c71ea7705f05bac60ddca61866adf61c919e5724c99` |
| src/renderer/gitcenter.js | 1266 | `65d3b404fb178e59bf4607637d9a29426f0d92b3429c8f2427746be4dfa5f6b5` |
| src/renderer/app.js | 10468 | `a75a43c7b6285d1de07cda71500647eae5da24a977cb9ad4a95c2d2a6e82cfc0` |
| src/renderer/diff.js | 85 | `8e4f9b504d5f531b4a588af63400c4e96531624c96f67216a9d7c4829297091a` |
| src/renderer/conflicts.js | 77 | `848e6b32706882d9b1c2bd8c21646f65aecddd27f9780fe935e4b1a9b3c235f5` |
| src/renderer/styles.css | 3258 | `1048c4b5a68adcba21d8f35633972bc944c8d578aedc6e052bd94e099b0327ec` |

Line references identify the reviewed source and may shift during implementation. The implementing AI should map each finding to the corresponding function after refactoring and update this document or a completion checklist with code changes, desired-behavior test evidence and remaining unverified integrations.
