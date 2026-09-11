# Smoke tests

End-to-end smoke tests for AtomNano. Each file launches the real Electron app
via Playwright (`electron.launch`) with `ATOMNANO_TEST=1` (disables the
single-instance lock and exposes `window.__*` automation hooks), drives the real
UI / IPC, and asserts on real behaviour. They print `PASS:` / `FAIL:` lines and
exit non-zero if anything fails.

## Run

From the repo root:

```bat
node smoke-tests\test-git-multi.js      :: one suite
```

Run a few of the core suites:

```bash
for t in test-git-layout test-git-multi test-fs-sync; do node smoke-tests/$t.js; done
```

## Notes

- These are **not** bundled into the app (`electron-builder.yml` ignores
  `smoke-tests/`). They live outside `src/`.
- Most suites create throwaway fixtures under the OS temp dir; git suites build
  real repos with local bare remotes (no network/credentials needed).
- `test-packaged-boot.js` needs a packaged build first (`scripts\pack-dir.bat`);
  the `test-live-*` suites need a logged-in Claude CLI.

## Reusable git fixture (`fixtures/html-project.js`)

A small but real **HTML project** with a branch topology built for exercising
diffs and merges. Prefer this over hand-rolling a repo in new git smokes:

```js
const { buildHtmlFixture } = require("./fixtures/html-project");
const fx = buildHtmlFixture(path.join(os.tmpdir(), "my-test"), { remote: true, dirty: true });
// fx.dir, fx.remote, fx.branches = [main, feature/dark-mode, feature/headline]
```

Topology: `feature/dark-mode` merges **cleanly** into `main`; `feature/headline`
**conflicts** on the hero line. `remote:true` adds a bare `origin` (push/pull);
`dirty:true` leaves an unrelated working diff (about.html modified + NOTES.md
untracked) so there's something to view immediately.

The **same builder** also generates the openable playground project. Recreate it
any time with:

```bat
node smoke-tests\fixtures\html-project.js "E:\Mac\sample-html-project"
```

Open `E:\Mac\sample-html-project` in AtomNano to try branch-switching, merges,
conflicts, and diffs by hand. (It can drift freely — tests rebuild from the
builder, not from the playground.)

## Map of suites

| Area | Suites |
|---|---|
| Git (multi-project commit/push/pull, selection, fs) | `test-git-multi`, `test-git-layout` |
| Git diff viewer (split/unified, word-level, ± stats, nav) | `test-git-diff` |
| Git branches + merge (switch, create, FF/conflict, abort) | `test-git-merge` |
| Merge conflict resolver (keep current/incoming/both, bulk, complete) | `test-git-conflict` |
| HTML-project fixture (diff + clean/conflict merge) | `test-html-fixture` (uses `fixtures/html-project.js`) |
| Filesystem sync (external add/modify/delete → tree + editor) | `test-fs-sync` |
| Editor / CodeMirror | `test-cm6`, `test-crlf-gotodef`, `test-gotodef`, `test-editor-ctxmenu`, `test-editor-links`, `test-large-file-perf`, `test-1m-lines`, `test-1m-support` |
| Tabs / sessions | `test-tabs-dnd`, `test-close-tabs`, `test-close-enter`, `test-chat-toggle`, `test-dblclick` |
| Search / find | `test-find-panel`, `test-input-ctxmenu` |
| Import / export / userdata | `test-export-import`, `test-userdata` |
| Models / updates / misc UI | `test-model-discover`, `test-update-flow`, `test-modal-keys`, `test-theme-borders`, `test-edge-cases`, `test-cmd-parallelism`, `test-ui-batch` |
| Live (need Claude login) | `test-live-smoke`, `test-live-ask`, `test-live-interrupt`, `test-live-discover`, `test-genuine-usage`, `test-ask-and-scroll` |
| Packaged build | `test-packaged-boot` |
