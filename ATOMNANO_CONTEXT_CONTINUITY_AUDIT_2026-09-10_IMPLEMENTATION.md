# AtomNano — context continuity audit: implementation status (2026-09-10)

Source: `ATOMNANO_CONTEXT_CONTINUITY_AUDIT_2026-09-10.md` (CTX-001..CTX-019). Every finding was checked against the code; the ones marked **fixed** are implemented with a regression check that asserts the corrected behaviour (the audit's C-ids are kept in `scripts/test-context.js`, built on the audit's own VM-injection harness against the REAL store/history modules on an isolated data home — no model calls, no saved conversations). The items marked **not implemented** are architectural additions listed separately, as the audit asks.

## Test commands

| Command | Scope | Result |
|---|---|---|
| `node scripts/test-context.js` | 41 checks: controls C01–C04/C17/C27/C37/C38 plus converted reproductions C05–C08, C10–C16, C20–C29, C32–C36, C39 and new C05b–d, C07b–c, C19b | 41 passed |
| `node scripts/test-transfer.js` | budgeted transfer tiers, cache, boundaries | 30 passed |
| `npm test` | audit 83 · tool cards 28 · transfer 30 · context 41 · git 155 · git-ui 34 · IPC check · db 267 · db-ui 23 | all passed |

## Findings

| ID | Status | Change | Checks |
|---|---|---|---|
| CTX-001 | fixed | `sessions:synthesize` builds the seed with the same budgeted transfer a thread gets (exact → shortened → cached summary + newest verbatim), sized to the destination model. The seed is one `record` entry (rendered as a collapsible card, model-visible on the first turn), never a user message holding the full transcript. Synthesizing the continuation again stays bounded. | C05, C05c, C05d |
| CTX-002 | fixed | `summarizeRecord` feeds oversized entries in ordered, marked segments (`history.segmentText`, surrogate-safe, paragraph/line cuts); every summariser request stays within half the budget, including the previous summary (compacted first when needed). | C07, C05b |
| CTX-003 | fixed | Size contract in `transferBlock`: an over-long summary is compacted (bounded passes, `compactSummary`), and a block that still exceeds the budget shrinks the verbatim tail share and rolls the cached summary forward; cached summaries pass the same check. | C08, C07b |
| CTX-004 | fixed (bounded) | A prompt larger than ~90% of the model window (text + an allowance per image) is not submitted: visible error, runner released, prompt preserved in the chat. Partial transfers into an existing thread subtract the thread's last known active context (`binding.activeTokens`, recorded from Claude result usage and Codex turn usage). Codex file attachments are native mentions and are not counted; tool schemas are not measured. | C10, C11 |
| CTX-005 | fixed | Record preparation runs inside the run's try/finally in every path (Claude, Codex exec fallback, custom); a summariser failure ends the run as an error with the slot released. `runHeadlessAnthropic` refuses an already-aborted signal and removes its listener. | C33, C36 |
| CTX-006 | fixed | The turn's identity is the user message id (`promptMessageId`), captured in `run()` and passed through reviewers, planner, all three providers and every retry payload; `promptIndexFor` derives the boundary from it. | C12, C13, C37 |
| CTX-007 | fixed | Acceptance is acknowledged on the cursor when the provider takes the input (Claude `system.init`, Codex `turn/started`), history injection is acknowledged immediately after `thread/inject_items`, and `finalizeRun` advances the cursor for accepted turns even when they stopped or failed. Pre-acceptance failures leave the cursor alone. | C14, C15, C16 |
| CTX-008 | fixed | Overflow recovery (`continuationAfter`) transfers the canonical entries the failed attempt produced and appends a labelled continuation note after the user's text asking the model to continue, not redo. Both harnesses. | C34, C39 |
| CTX-009 | fixed (positional model kept) | `store.deleteMessage` moves provider cursors back, drops cached summaries that covered the deleted entry and shifts later ones. Immutable event ids / tombstones were not introduced. | C23, C24 |
| CTX-010 | fixed | Cache reuse accepts a checkpoint that starts earlier than the head; retention keeps the latest checkpoint per start (root first) and trims intermediates only. | C20, C35 |
| CTX-011 | **not implemented** | Indexed archive / off-thread serialisation. `readArchive` still parses the JSONL once per file change (cached by size+mtime); `planTransfer` still serialises the requested span. | — |
| CTX-012 | fixed | The newest entry always travels verbatim as an excerpt (start + end) when it alone exceeds the tail share; a single oversized entry is bounded without any summary call. | C21, C07c |
| CTX-013 | fixed (retrieval tools not added) | Shortened tool results keep head AND tail and name the exact record entry id; the note says to look the entry up, never to re-run. Provider-accessible history search/read tools were not added. | C22 |
| CTX-014 | fixed | Synthesize carries model, effort, permission mode, 1M context and selected skills (`createSession` accepts `oneM`, `selectedSkills`). Native thread ids are not carried. | C06, C06b |
| CTX-015 | fixed | Recovery is a bounded loop (≤ 2 replacement attempts): lost session → new session with the budgeted record; prompt too long → one new session with a summarised record at half the budget; either may follow the other. | C32 |
| CTX-016 | partial | Claude compaction boundaries are recorded (binding telemetry + visible note); polling uses `detail: "summary"`; the meter answers for a live Codex turn from its usage. Native Codex `thread/compact` and pre-send admission from live telemetry were not wired. | C26, C28, C29 |
| CTX-017 | fixed | Codex input totals count `input_tokens` once (cache categories are subsets); Anthropic keeps its three-part accounting; summary calls charge the session and their job. | C25 |
| CTX-018 | **not implemented** | Selected skill bodies are still appended on every prompt (explicit user selection; dedupe across a native thread would change what the user asked to send). | — |
| CTX-019 | fixed | Every summary call is charged to the session totals and to a preparation job (calls, tokens, ms) shown on the summary card and in the transfer note. | C19b |

## Files

- `src/main/history.js` — record role, `indexOfMessage`, head+tail shortening with entry ids, `excerptText`, `segmentText`, non-empty tail, wider cache reuse, protected retention, exports.
- `src/main/claude.js` — prompt identity (`promptMessageId` / `promptIndexFor`), preparation inside the run lifecycle, bounded recovery loop with `continuationAfter`, acceptance/acknowledgement cursors, size contract (`compactSummary`), segmented summarisation with usage jobs, compaction boundary telemetry, context meter, Codex usage arithmetic, local prompt-size preflight (Claude, Codex, custom).
- `src/main/store.js` — `createSession` settings, deletion adjusts cursors/summaries.
- `src/main/main.js` — bounded synthesize handler.
- `src/renderer/app.js` — `record` card.
- `scripts/test-context.js` (new), `scripts/test-transfer.js` (marker text), `smoke-tests/test-chat-nav.js` (seed assertion), `package.json`.

## Not verified here

No live Claude or Codex run, no real prompt-too-long or context-exceeded event, no packaged app; summariser behaviour is exercised with an injected fake that complies with compaction requests. Character counts stand in for tokenizer counts (4 chars/token, conservative). The Electron smoke `smoke-tests/test-chat-nav.js` covers the synthesize UI flow but was not re-run in this pass.

## Follow-up 2026-09-10 — run control (permission channel, streaming lag, Stop)

Observed live inside AtomNano (tool calls failing with `Tool permission request failed: AbortError: Stream closed`), diagnosed from the SDK bundle and the session record, fixed in `src/main/claude.js` / `src/renderer/app.js`, covered by `node scripts/test-run-control.js` (12 checks) and `scripts/test-tool-cards.js` U2/U13.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every permission-gated tool (Edit, Write, non-allowlisted Bash) fails immediately with "Stream closed" for a whole turn; Read/Grep and allowlisted commands still work. | The Agent SDK closes the CLI's stdin as soon as the prompt generator has ended AND a first `result` arrived (`Query.streamInput` → `waitForFirstResult` → `endInput`). AtomNano's generator yielded one message and ended at once. On `--resume` the CLI first finalised a queued task notification as a zero-turn `result` (session record: `durationMs 56, numTurns 0`), so stdin was closed before the user's turn began — permission responses and interrupts had no channel. | `buildPrompt(…, hold)` keeps the stream open until the run releases it; the release happens on THIS turn's `result` (after output was seen), on Stop, or when the run ends. A success `result` before any output is ignored (`runner.earlyResults`), nothing is recorded for it. (R01, R02) |
| Read/Write/Edit cards lag while a big file streams. | Each `input_json_delta` re-sent the whole accumulated JSON over IPC and re-scanned it (O(n²)); the renderer rebuilt the card's expanded detail (the full body) on every update even while collapsed. | Main coalesces streaming arguments to one update per 120 ms per card with a bounded excerpt (`partialInput` ≤ 6 KB) + `partialBytes`; `patchToolCard` rebuilds the detail only when the card is open or the call finished, and `revealToolDetail` rebuilds a stale detail on expand. (R03, U2, U13) |
| Parallel tool calls. | Verified: cards are keyed by content-block index / `tool_use_id` (Claude) and item id (Codex); results are matched by id, out of order is fine. | Regression only. (R04) |
| Stop left the command running; the CLI was killed but not its shell children (Windows `child.kill` is not tree-aware). | `interrupt()` aborted the transport FIRST, so the SDK killed the CLI before `query.interrupt()` could reach it, and the graceful path never ran. | Graceful-first: `query.interrupt()` → release the input stream → the CLI cancels the tool (killing its shell) and ends the turn; only after `interruptGraceMs` (4 s) the transport is aborted and the whole process tree is killed (`taskkill /T /F` with the pid captured by our `spawnClaudeCodeProcess`, which mirrors the SDK's spawn options). A replacing run waits for the stopped one to drain (`awaitDrain`). A cancelled tool keeps its "interrupted" state; the stopped turn's late result adds no card. (R05–R08) |

Test fakes: any fake SDK must read the prompt stream concurrently (first message, drain in the background) — `scripts/test-context.js` was updated; draining it to completion before yielding would deadlock against the held-open stream.
