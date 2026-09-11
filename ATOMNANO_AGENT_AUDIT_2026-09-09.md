**AtomNano agent, context, credentials and rendering audit — 9 September 2026**

Project: E:\Mac\AtomNano. This is an implementation handoff covering Claude/Anthropic and OpenAI/Codex, including the later requests about Bash/Grep visibility, new sessions, provider/account switching and removal of application-added instructions and caps. Production application code was not changed during this audit.

The important outcome is that visible chat history is not a reliable indicator of what the next model receives. There are confirmed paths that discard the current prompt, omit images, lose Codex resume metadata on reload, or replace conversation history with short summaries. Authentication and rendering have separate defects.

**Verification and limits**

The installed versions inspected were Claude Agent SDK 0.3.263, Codex SDK 0.153.4 and Electron 42.3.0; synthetic checks ran with Node v24.14.1. Six isolated, fileless harnesses executed real project modules/functions with mocked credentials, filesystem failures, SDK events, JSON-RPC processes or minimal DOM/scheduler objects. All harnesses exited successfully: 40 checks, comprising 34 reproductions of faulty or unwanted behavior and six confirmations of intended behavior. Several checks concern the same finding; this is not a claim of 34 independent bugs.

The audit did not run paid model requests, alter real credentials, perform actual updates or measure a live Electron rendering trace. The screenshot's original image file was not available, so grey-text causes below are identified from code and synthetic behavior rather than a visual match to that screenshot. Existing smoke tests were inspected, not claimed to have passed.

P1 means fix before relying on normal agent operation, continuity or saved state. P2 means a material reliability/UX issue. “Reproduced” means a deterministic synthetic check exercised project code; “code-confirmed” means the relevant execution path was traced. Runtime uncertainties are explicitly identified.

**Direct answers**

- **Bash/Grep while running:** Claude has a running-card path, but drops early tool events and progress/background-task events. Codex app-server has command-output delta handling; its frequent card replacements can collapse the open output panel. SDK/CLI fallback output is less capable. Do not promise streaming search results or stdout when the native tool only provides a final result.
- **Brand-new session:** the store creates fresh IDs and empty conversation state for both providers. The UI can instead reuse an “empty” tab that still contains a draft, attachments or selected skills. Even a truly fresh session receives prior project memory by default. Shared account/project settings and files are separate from conversation history.
- **Same conversation, another provider:** full continuity is not reliable. The live switch clears both native IDs and rebuilds context from lossy summaries. With memory off, switching to OpenAI can send only the current prompt. Removing summaries alone would make this worse; a lossless conversation-transfer path is required.
- **Same conversation, another account:** the credential-file switch exists, but identity matching and runtime invalidation have defects. Claude may replace native history with a short handoff; OpenAI does not apply the same reset flag. The effective account must be acknowledged by the runtime, not inferred from a profile label.
- **Selected model/effort:** supported Codex values do reach the outgoing app-server turn/start parameters. The captured fixtures verified high/xhigh and the selected model. This verifies request wiring, not which remote model actually served a paid request. Remapping, live steering and misleading metadata remain problems.

**Codex integration decision**

Keep app-server for the interactive product: it is the documented interface for custom clients needing authentication, conversation history, approvals and streamed events. The TypeScript SDK is used by this project's exec fallback; replacing app-server with that fallback would not solve the live UI issues. See the official [Codex app-server guide](https://developers.openai.com/codex/app-server) and [Codex SDK guide](https://developers.openai.com/codex/sdk). The defects are in AtomNano's integration and state handling, not evidence that choosing app-server was incorrect.

**Findings to implement**

**F01 · P1 · Saved OpenAI API key is ignored by the primary Codex transport**

Reproduced with a synthetic saved key: app-server.run receives no API key or authentication selection. The key is passed only to the SDK fallback. The primary process inherits process.env and the CLI login, while the UI treats a saved key as connected. A user can therefore select API-key access and actually use another available login, or fail to authenticate.

Evidence: [src/main/claude.js:1616](E:/Mac/AtomNano/src/main/claude.js:1616), [src/main/codex-appserver.js:70](E:/Mac/AtomNano/src/main/codex-appserver.js:70), [src/renderer/app.js:8363](E:/Mac/AtomNano/src/renderer/app.js:8363).

Required change: Add one provider authentication coordinator. Activate the selected key or subscription account through the supported app-server authentication contract before starting a turn, then confirm the active identity/authentication mode. Keep secrets in main-process storage and display the effective account. Share the same selected auth context across discovery, execution and supported recovery paths.

Acceptance: With subscription account A available and synthetic API-key account B selected, the transport must authenticate B before turn/start. Test key-only, subscription-only, expired-key, logout and switching cases; never log key values.

**F28 · P1 · Reloading a session drops Codex thread identity and last-provider metadata**

Reproduced through an actual save/reload using a virtual filesystem: the transcript remained, but codexThreadId disappeared. normalizeSession also drops lastProvider, which the provider-switch guard requires. Claude's native session ID does survive. OpenAI therefore starts fresh after reload/eviction, and provider-switch detection can fail after reload. An older Claude ID can survive without the metadata needed to know whether it is current.

Evidence: [src/main/store.js:225](E:/Mac/AtomNano/src/main/store.js:225), [src/main/store.js:330](E:/Mac/AtomNano/src/main/store.js:330), [src/main/claude.js:800](E:/Mac/AtomNano/src/main/claude.js:800), [src/main/claude.js:1603](E:/Mac/AtomNano/src/main/claude.js:1603).

Required change: Version the persisted session schema and round-trip provider thread IDs, last provider, account/home binding, synchronization position and usage fields. Migrate old sessions conservatively; recover a missing ID only from reliable native metadata, never by guessing. Keep transcript provenance distinct from the active provider.

Acceptance: Save/reload, evict/reload, export/import and restart with Claude and Codex histories. Assert thread identity and last-provider metadata explicitly. Test a provider switch before and after a restart; no stale history may be mistaken for a fully synchronized thread.

**F30 · P1 · Provider switching within one conversation transfers lossy or no prior context**

Reproduced in both directions: switching to Claude dropped an exact prior constraint located after the handoff's per-message cap; switching to OpenAI with memory off sent only Continue. The live guard clears both native IDs. Claude then receives a clipped handoff; OpenAI uses a short digest below 200 messages, a clipped handoff above that threshold, or no digest when memory is off. The visible transcript remains complete enough to conceal the gap.

Evidence: [src/main/claude.js:800](E:/Mac/AtomNano/src/main/claude.js:800), [src/main/claude.js:988](E:/Mac/AtomNano/src/main/claude.js:988), [src/main/claude.js:1387](E:/Mac/AtomNano/src/main/claude.js:1387), [src/main/convo.js:115](E:/Mac/AtomNano/src/main/convo.js:115).

Required change: Introduce a durable canonical conversation and a lossless provider-transfer adapter independent of memory/optimization settings. Retain native thread bindings and record which canonical messages each has received. On a switch, synchronize the missing recorded conversation data exactly before the next request; establish a new binding only when required. Carry completed tool results as history, never execute them again during transfer.

Acceptance: Use Claude → Codex → Claude and Codex → Claude → Codex with long constraints, corrections, code, images and tool outputs. Repeat with memory off and across restart. Inspect the destination input/history and verify every required source sentinel and attachment is present exactly once.

**F31 · P1 integration gap · Account switching is not scoped or acknowledged consistently by provider runtime**

Reproduced: the OpenAI path consumed _forceFreshNextTurn but resumed the same old Codex thread. Also reproduced: forceFreshAllSessions returned zero with global provider=openai even when an Anthropic session existed. The login-change callback is not provider-scoped; it refreshes UI/catalog state without an app-server account acknowledgement or restart. Claude's forced fresh path changes context through the lossy handoff. Whether a particular live Codex binary notices an external auth-file change needs a native integration test; the app currently provides no reliable acknowledgement.

Evidence: [src/main/main.js:590](E:/Mac/AtomNano/src/main/main.js:590), [src/main/profiles.js:214](E:/Mac/AtomNano/src/main/profiles.js:214), [src/main/claude.js:746](E:/Mac/AtomNano/src/main/claude.js:746), [src/main/claude.js:846](E:/Mac/AtomNano/src/main/claude.js:846), [src/main/claude.js:2713](E:/Mac/AtomNano/src/main/claude.js:2713), [src/main/codex-appserver.js:63](E:/Mac/AtomNano/src/main/codex-appserver.js:63).

Required change: Make account switching a provider-scoped transaction. Pin the active run to its original auth context, serialize the switch at a defined boundary, activate/verify the new account, invalidate only affected runtime/catalog bindings, and preserve the canonical conversation independently. Do not clear transcript context merely to reload credentials. Reject stale async identity/watcher results that belong to an older credential snapshot.

Acceptance: With two projects and both providers active, switch one provider's account. Verify unrelated runs and permissions remain unchanged. Confirm the new account from the runtime before the next turn and verify that the same conversation data is available. Exercise in-flight runs, expired credentials, token refresh and switching back.

**F02 · P1 · Codex's 24,000-character cap can remove the user's current request**

Reproduced: a long prefix produced a 24,027-character outgoing string with the current-request sentinel missing. The code assembles prefixes and attachments before the user's text, then keeps the beginning. It also reads only eight files and only the first 12,000 characters of each; steering repeats those attachment cuts.

Evidence: [src/main/claude.js:281](E:/Mac/AtomNano/src/main/claude.js:281), [src/main/claude.js:1373](E:/Mac/AtomNano/src/main/claude.js:1373), [src/main/claude.js:1396](E:/Mac/AtomNano/src/main/claude.js:1396), [src/main/claude.js:2535](E:/Mac/AtomNano/src/main/claude.js:2535).

Required change: Remove these application prompt/file-count/content caps as requested. Pass the exact current request and all explicitly attached content through the attachment-aware adapter. Report actual provider input-limit errors without silently clipping or rewriting input.

Acceptance: Put unique sentinels at the beginning, middle and end of a long request and every attached file, including a ninth file. All must survive request construction for initial sends, retries and steering.

**F03 · P1 · Pasted and dropped images are missing from Codex input and are not durably retained**

Reproduced: one attachment containing image data became zero transport images. The renderer creates data/mediaType/thumbnail attachments without a durable path. Codex filters to attachments with paths; its SDK fallback accepts only promptText here. Persisted user messages retain thumbnails/metadata but omit the original image bytes. The image-without-a-file-path notice in this conversation matches this application branch.

Evidence: [src/renderer/app.js:4886](E:/Mac/AtomNano/src/renderer/app.js:4886), [src/main/claude.js:764](E:/Mac/AtomNano/src/main/claude.js:764), [src/main/claude.js:1382](E:/Mac/AtomNano/src/main/claude.js:1382), [src/main/claude.js:1618](E:/Mac/AtomNano/src/main/claude.js:1618), [src/main/codex.js:43](E:/Mac/AtomNano/src/main/codex.js:43).

Required change: Persist original attachments in an application attachment store before dispatch, give them stable IDs and paths, and pass supported structured image inputs to the active provider. Retain originals for retries, reopen and provider transfer. Reject unsupported transport capabilities visibly instead of silently substituting a notice.

Acceptance: Paste an image, send it, retry, restart, reopen, switch Claude to Codex and back, and verify the same original attachment is available at every applicable send. Do not use a thumbnail as the original.

**F04 · P1 · Claude error results are finalized as successful runs**

Reproduced with error_max_budget_usd: an error card was added, but session.status became done and runner.completedClean became true. Only specific 429/529 result frames become exceptions. Other error results reach normal finalization; success-subtype frames with is_error are also not classified correctly. This can trigger queued work or automatic repair after failure.

Evidence: [src/main/claude.js:2116](E:/Mac/AtomNano/src/main/claude.js:2116), [src/main/claude.js:2148](E:/Mac/AtomNano/src/main/claude.js:2148), [src/main/claude.js:1186](E:/Mac/AtomNano/src/main/claude.js:1186), [src/main/claude.js:1898](E:/Mac/AtomNano/src/main/claude.js:1898).

Required change: Classify the SDK result before finalization and use a single terminal-state transition. Preserve the actual error details and distinguish failed, interrupted, waiting-for-auth and completed states. Only genuine success may dispatch success-dependent work.

Acceptance: Cover error_during_execution, error_max_turns, error_max_budget_usd, success with is_error, rate limits and a normal success. Failed runs must never become completedClean or trigger automatic follow-up.

**F05 · P1 · Codex profiles for different accounts sharing an email overwrite each other**

Reproduced with personal/work account IDs and the same email: saving Work retained one Personal profile and overwrote its credentials. sameAccount gives email equality precedence over differing stable account IDs; switchTo can also report already active for the wrong workspace/account.

Evidence: [src/main/profiles.js:58](E:/Mac/AtomNano/src/main/profiles.js:58), [src/main/profiles.js:89](E:/Mac/AtomNano/src/main/profiles.js:89), [src/main/profiles.js:172](E:/Mac/AtomNano/src/main/profiles.js:172), [src/main/profiles.js:202](E:/Mac/AtomNano/src/main/profiles.js:202).

Required change: Use provider, authentication mode and stable account/workspace ID as the identity key. Treat email as a display label. Preserve distinct account IDs even when emails match, and bind token-rotation updates to the identity of the credential snapshot being updated.

Acceptance: Save, switch, refresh, rename and export two accounts with the same email and different account IDs. Both profiles must remain distinct and the selected account ID must match the effective runtime identity.

**F06 · P1 · Stopping one session cancels permission requests belonging to other sessions**

Reproduced: finalizing Stop for session A invoked session B's pending permission resolver with a denial. The finalizer loops over the manager-wide resolver map without checking session ownership and labels cancellations with A's session ID.

Evidence: [src/main/claude.js:1875](E:/Mac/AtomNano/src/main/claude.js:1875).

Required change: Store session ID and run ID with each permission request. Cancel and resolve only requests owned by the stopped run. Discard late responses using the same ownership check.

Acceptance: Run A and B concurrently, leave B waiting for approval, and stop A. B's request must remain available and continue normally when answered.

**F07 · P1 · Settings and credential-key saves can report success after a disk failure**

Reproduced with a virtual ENOSPC error: saveSettings returned the new synthetic key even though no settings file was written. RAM is updated first and writeSettingsFile catches the failure. The UI can say saved/connected, but a restart restores old settings.

Evidence: [src/main/store.js:166](E:/Mac/AtomNano/src/main/store.js:166), [src/main/store.js:205](E:/Mac/AtomNano/src/main/store.js:205), [src/main/main.js:561](E:/Mac/AtomNano/src/main/main.js:561).

Required change: Write settings atomically, propagate write failures through IPC, and commit the in-memory settings only after persistence succeeds. Preserve the previous valid file. Apply the same persistence/error contract to project settings and account-selection metadata.

Acceptance: Inject ENOSPC, EPERM and an interrupted write. The save must fail visibly, the old settings must remain valid, and restart must not reveal an unreported rollback.

**F08 · P1 · History archiving removes messages even when the archive write fails**

Reproduced with a 20-message test threshold: the 21st message caused one old message to be removed, archivedCount increased, and no archive was written after ENOSPC. The splice occurs before durable append; archive errors are swallowed. Later persistence can make the loss permanent. Session flush errors are also only logged.

Evidence: [src/main/store.js:302](E:/Mac/AtomNano/src/main/store.js:302), [src/main/store.js:497](E:/Mac/AtomNano/src/main/store.js:497).

Required change: Make transcript storage durable before changing in-memory/archive indexes. Use a recoverable append/commit design and surface save failures. Keep full content on disk while paging views; a memory-window limit must not become a history-loss limit.

Acceptance: Fail the archive append and main-session write separately, then reopen. Every original message must remain recoverable and counts must match persisted messages. Verify a retry does not duplicate archived rows.

**F09 · P1 · A failed Codex resume silently starts an empty thread**

Reproduced: a thread/resume error led to a successful new thread whose input was only Continue. The caller had skipped history preparation because it believed it was resuming. The transport catches almost every resume error and starts over without returning a context-reset state.

Evidence: [src/main/codex-appserver.js:247](E:/Mac/AtomNano/src/main/codex-appserver.js:247), [src/main/claude.js:1387](E:/Mac/AtomNano/src/main/claude.js:1387).

Required change: Preserve the existing thread reference on transient/authentication failures. Treat a missing thread as an explicit recovery state and use the complete canonical conversation when recovery is supported. Never report continuity merely because a new thread started successfully.

Acceptance: Simulate missing-thread, auth, network and managed-policy failures. No case may silently issue Continue to a blank thread or lose the original resume reference.

**F10 · P1 · The final Codex CLI fallback loses execution context and streaming capabilities**

Code-confirmed: the final fallback uses the reviewer CLI runner with only model, prompt and effort. It does not receive the session cwd, native resume ID, selected key, attachments, live approval handler or cancellation signal. runProc inherits the application's working directory. This path can behave differently from the same request through app-server and cannot provide the normal live command-output experience.

Evidence: [src/main/claude.js:1642](E:/Mac/AtomNano/src/main/claude.js:1642), [src/main/claude.js:1661](E:/Mac/AtomNano/src/main/claude.js:1661), [src/main/council.js:54](E:/Mac/AtomNano/src/main/council.js:54), [src/main/council.js:76](E:/Mac/AtomNano/src/main/council.js:76).

Required change: Keep app-server as the interactive Codex transport. Remove the automatic batch-reviewer fallback from interactive turns. Return a recoverable transport-unavailable state when the required interactive capabilities are unavailable; preserve the request and conversation for retry. Do not silently downgrade an interactive agent run.

Acceptance: Force app-server/SDK launch failures. The app must preserve the request, identify the failed transport and avoid running commands under an inherited application cwd or different account.

**F11 · P1 · Claude ignores early Bash/Grep tool events and execution/background-task progress**

Reproduced: content_block_start(tool_use) and input_json_delta emitted no card/update. tool_progress and task_started/task_progress/task_notification also emitted no updates, including a background failure. The completed assistant tool_use block does correctly create a running card before tool_result; tool_result correctly finishes it. Thus the running state is partially implemented, but early activity, elapsed progress and background lifecycle are missing. A quick command can finish before the browser paints the temporary running state.

Evidence: [src/main/claude.js:2055](E:/Mac/AtomNano/src/main/claude.js:2055), [src/main/claude.js:2076](E:/Mac/AtomNano/src/main/claude.js:2076), [src/main/claude.js:2101](E:/Mac/AtomNano/src/main/claude.js:2101), [node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5332](E:/Mac/AtomNano/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5332), [node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5210](E:/Mac/AtomNano/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5210).

Required change: Upsert one tool record by run/parent/tool-use ID from the earliest supported event. Show preparing/awaiting-approval/running/completed/failed/interrupted states as supported events arrive; merge partial arguments and progress into that same record. Handle native background task IDs and final notifications. Display a running command or search summary without requiring an expanded result panel.

Acceptance: A delayed Bash fixture must show its command and running state before completion, then elapsed/progress updates and its final result in the same card. Test Grep, parallel tools, denied tools, background Bash, background failures and subagent tools. Do not invent stdout chunks: tool_progress contains elapsed status, not raw Bash stdout.

**F13 · P1 · Claude parent and subagent streams share the same block identity**

Reproduced with parent and child text at block index 0: both were sent as the same session/index stream, and the child final text became an untagged main assistant message. parent_tool_use_id and native message identity are discarded. A child message_start can also reset the parent stream.

Evidence: [src/main/claude.js:1099](E:/Mac/AtomNano/src/main/claude.js:1099), [src/main/claude.js:2058](E:/Mac/AtomNano/src/main/claude.js:2058), [src/main/claude.js:2061](E:/Mac/AtomNano/src/main/claude.js:2061), [src/main/claude.js:2073](E:/Mac/AtomNano/src/main/claude.js:2073).

Required change: Carry session, run, native message/item, block index and parent-tool IDs through main, IPC, persistence and renderer. Render child output within its own task/thread. Scope resets to the exact message/block stream.

Acceptance: Interleave parent text, two subagents, tool results and message starts with identical numeric block indexes. Every delta and final block must stay in its own transcript without resets or text mixing.

**F21 · P1 — remove layer · Application rotation and distilled memory replace exact conversation context**

Code-confirmed: Claude rotates after fixed turn counts, model/account changes and certain errors, then quotes at most 28 recent messages, clips user text to 300 characters and assistant text to 320, removes fenced code, and applies 9,000/12,000-character handoff budgets. The digest clips goals/outcomes to 120 characters. Fresh sessions also inject previous project memory. A separate reproduced bug makes the idle guard see the just-added user message instead of the previous idle time.

Evidence: [src/main/claude.js:279](E:/Mac/AtomNano/src/main/claude.js:279), [src/main/claude.js:295](E:/Mac/AtomNano/src/main/claude.js:295), [src/main/claude.js:345](E:/Mac/AtomNano/src/main/claude.js:345), [src/main/claude.js:735](E:/Mac/AtomNano/src/main/claude.js:735), [src/main/claude.js:988](E:/Mac/AtomNano/src/main/claude.js:988), [src/main/convo.js:115](E:/Mac/AtomNano/src/main/convo.js:115), [src/main/context.js:21](E:/Mac/AtomNano/src/main/context.js:21).

Required change: Remove the application rotation, summary/digest injection and automatic project-memory layers as requested. Preserve native conversation state and recorded source history. Do not repair the stale-idle heuristic as the target design removes it. Implement the provider-transfer contract before removing the current lossy bridge.

Acceptance: Put a requirement after character 300, a correction late in the conversation and essential fenced code in earlier turns. Model changes, long runs, restart and provider/account switches must preserve the recorded data; brand-new sessions must not receive prior project-memory text.

**F29 · P1 — requested clean-session behavior · The New session button can reuse a tab containing unsent state**

Reproduced: a tab with zero sent messages but an unsent draft, image, selected skill and session permission was reused; zero sessions were created. tabIsEmpty only checks message counts. The actual store factory is correct: it creates distinct IDs, no native resume IDs, no messages, no pending retry and empty session permissions/skills.

Evidence: [src/renderer/app.js:3193](E:/Mac/AtomNano/src/renderer/app.js:3193), [src/renderer/app.js:3211](E:/Mac/AtomNano/src/renderer/app.js:3211), [src/renderer/app.js:837](E:/Mac/AtomNano/src/renderer/app.js:837), [src/main/store.js:400](E:/Mac/AtomNano/src/main/store.js:400).

Required change: Make an explicit New session action create a fresh session and fresh composer state. Remove the blank-tab reuse optimization for this action as requested. Preserve the previous tab/draft separately. Apply the instruction-removal requirements so the new session receives no prior project-memory or automatic skill injection.

Acceptance: Create a draft with images and selected skills, click New session, then send through each provider. The new session must have a new ID, empty draft/attachments/queue/permissions/skills, no native resume ID and no previous conversation or project-memory injection. Opening it must not cancel another tab's running job.

**F12 · P2 · Live tool cards and response blocks are replaced, collapsing output and replaying fades**

Code-confirmed with an additional line-animation reproduction: message updates replace the entire card, losing its DOM-only open state and selection. Codex output updates can do this every 200 ms. renderLive clears and rebuilds the live region after persistent messages and structural changes; existing lines are animated again. This explains output panels closing and text repeatedly fading during transitions.

Evidence: [src/renderer/app.js:5993](E:/Mac/AtomNano/src/renderer/app.js:5993), [src/renderer/app.js:7097](E:/Mac/AtomNano/src/renderer/app.js:7097), [src/renderer/app.js:7109](E:/Mac/AtomNano/src/renderer/app.js:7109), [src/renderer/app.js:6210](E:/Mac/AtomNano/src/renderer/app.js:6210), [src/renderer/styles.css:653](E:/Mac/AtomNano/src/renderer/styles.css:653), [src/main/claude.js:1483](E:/Mac/AtomNano/src/main/claude.js:1483).

Required change: Maintain stable keyed DOM nodes for messages, blocks and tool cards. Store expansion state by message ID and patch status/output in place. Commit a live block without remounting unchanged text. Animate only newly introduced content once.

Acceptance: Expand a long-running command, select earlier output, receive multiple output/status patches, then complete the tool. Expansion and selection must survive. Existing reply text must retain its nodes and opacity during thinking/tool/final transitions.

**F14 · P2 · A stopped Claude run can reset the stream of the replacement run**

Code-confirmed: interrupt frees the running slot so a replacement can start. The old run's finally block unconditionally sends session:partial-reset before checking whether it still owns the runner slot. The new stream can therefore be cleared by old cleanup.

Evidence: [src/main/claude.js:1232](E:/Mac/AtomNano/src/main/claude.js:1232), [src/main/claude.js:2487](E:/Mac/AtomNano/src/main/claude.js:2487).

Required change: Use immutable run IDs and ownership checks for every delta, reset, tool update and terminal event. Ignore cleanup from superseded runs; cancellation and completion must be idempotent.

Acceptance: Delay old-run teardown, start a replacement and emit new text, then release the old finally block. The replacement text, status and pending permissions must remain intact.

**F15 · P2 · Codex can corrupt Unicode when stdout chunks split a UTF-8 character**

Reproduced by splitting an emoji across two Buffer chunks: the streamed and final response contained replacement characters. String(buffer) decodes each chunk independently before JSONL reassembly.

Evidence: [src/main/codex-appserver.js:73](E:/Mac/AtomNano/src/main/codex-appserver.js:73), [src/main/codex-appserver.js:106](E:/Mac/AtomNano/src/main/codex-appserver.js:106).

Required change: Decode stdout with a stateful UTF-8 decoder or setEncoding before assembling JSONL messages. Apply the same rule to streamed command output and stderr where text must be preserved.

Acceptance: Split JSON events at every byte boundary across emoji, Hindi and other multibyte text. Final and streamed strings must exactly match the original UTF-8 text.

**F16 · P2 · Stop during Codex thread initialization can still start generation**

Reproduced by aborting during thread/start: turn/start was still sent. Cancellation is checked initially, but the interrupt listener is attached after the asynchronous thread and turn initialization steps.

Evidence: [src/main/codex-appserver.js:218](E:/Mac/AtomNano/src/main/codex-appserver.js:218), [src/main/codex-appserver.js:247](E:/Mac/AtomNano/src/main/codex-appserver.js:247), [src/main/codex-appserver.js:367](E:/Mac/AtomNano/src/main/codex-appserver.js:367), [src/main/codex-appserver.js:375](E:/Mac/AtomNano/src/main/codex-appserver.js:375).

Required change: Check the signal and run ownership after each awaited initialization step and immediately before turn/start. Install cancellation handling early and dispose it on every completion/error path.

Acceptance: Stop while initialize, thread/resume and thread/start are pending. Resolving those requests afterward must not launch a new turn or change a replacement run's state.

**F17 · P2 · Requested model/effort, live selection and reply labels can disagree**

Reproduced: an API-only model unknown to the Codex execution catalog was remapped to its default. Discovery can expose API-only models that the execution resolver then replaces. Claude also normalizes unsupported effort values and has a legacy smart-thinking gate. Mid-turn Codex Enter steers only text/images, so changing the dropdown does not change that running turn. The live provider label reads current settings rather than the originating run; reroute notices do not update the reply metadata.

Evidence: [src/main/providers.js:201](E:/Mac/AtomNano/src/main/providers.js:201), [src/main/providers.js:349](E:/Mac/AtomNano/src/main/providers.js:349), [src/main/claude.js:112](E:/Mac/AtomNano/src/main/claude.js:112), [src/main/claude.js:1113](E:/Mac/AtomNano/src/main/claude.js:1113), [src/main/claude.js:1639](E:/Mac/AtomNano/src/main/claude.js:1639), [src/renderer/app.js:5139](E:/Mac/AtomNano/src/renderer/app.js:5139), [src/renderer/app.js:6283](E:/Mac/AtomNano/src/renderer/app.js:6283).

Required change: Use one capability catalog for selection and execution. Remove heuristic downshifts and automatic replacement as requested; prevent unsupported selections or surface an explicit capability error. Snapshot provider/account/model/effort at dispatch, show those values on the running reply, and show the next-turn selection separately. Record requested, sent and acknowledged/served values when the protocol exposes them.

Acceptance: Test every offered effort for each installed model, unavailable/API-only models, server rerouting, a provider change during streaming, and Enter after a model/effort change. Never label requested values as verified served values. Freeze retry identity unless the user explicitly resubmits with changed settings.

**F18 · P2 — UX behavior · Some grey text is deliberate filtering or secondary-text styling**

Code-confirmed: .msg.assistant.msg-filtered reduces opacity to 0.28. Model filters intentionally dim replies from other models/providers. Reasoning text and tool output use secondary colors; ordinary assistant text uses the main text color. These mechanisms are distinct from the repeated streaming fade in F12.

Evidence: [src/renderer/styles.css:2152](E:/Mac/AtomNano/src/renderer/styles.css:2152), [src/renderer/styles.css:622](E:/Mac/AtomNano/src/renderer/styles.css:622), [src/renderer/app.js:5645](E:/Mac/AtomNano/src/renderer/app.js:5645).

Required change: Make any active model filter explicit and easy to clear, apply it consistently to incoming and existing messages, and avoid leaving ordinary answers faint after a provider change. Keep body text readable in every theme. Distinguish reasoning with its label/layout rather than very low contrast.

Acceptance: Clear filters and verify ordinary replies remain fully readable for both providers. Exercise filter changes, provider switches, new messages and every supported theme; separately test reduced-motion and streaming transitions.

**F19 · P2 · Long live responses hide earlier lines and change structure when finalized**

Reproduced: a 305-line live reply displayed only lines 5–304, with a hidden-lines indicator; the first five were unavailable in the active block until finalization. Lines longer than 2,000 characters are split into separate block elements. Live text is laid out differently from final Markdown, so headings, lists, tables and code can jump at completion. The full accumulated string is still split each update.

Evidence: [src/renderer/app.js:6310](E:/Mac/AtomNano/src/renderer/app.js:6310), [src/renderer/app.js:6317](E:/Mac/AtomNano/src/renderer/app.js:6317), [src/renderer/app.js:6336](E:/Mac/AtomNano/src/renderer/app.js:6336), [src/renderer/app.js:6279](E:/Mac/AtomNano/src/renderer/app.js:6279), [src/renderer/app.js:5939](E:/Mac/AtomNano/src/renderer/app.js:5939).

Required change: Keep complete text in a canonical buffer and make all of it accessible while streaming. Use viewport virtualization/paging without a destructive tail-only view, and incrementally maintain stable Markdown blocks with a lightweight unfinished tail. Preserve paragraph boundaries and scroll position when committing final content.

Acceptance: Stream over 300 lines, a 120,000-character paragraph, split code fences, lists and tables. Read and select the first lines while new text arrives. Finalization must preserve content, selection, block identity and the reader's scroll anchor.

**F20 · P2 · The background-window timer leaves an uncancelled animation-frame callback**

Reproduced: after the timer fallback fired, its original rAF callback remained queued. A subsequent delta scheduled another frame, leaving two pending callbacks. flushLive clears the rAF handle without cancelling the real callback when the timer wins.

Evidence: [src/renderer/app.js:6383](E:/Mac/AtomNano/src/renderer/app.js:6383).

Required change: Have the winning callback cancel both scheduling handles before clearing them, and associate scheduled work with the current view/run generation. Keep frame coalescing, which improves rendering without changing model input.

Acceptance: Pause rAF, fire the fallback timer, enqueue another delta, then resume rAF. There must be one effective flush for pending work and no stale callback acting on another tab or run.

**F22 · P2 — remove layer · Claude image deduplication can refer to an image no longer available in native context**

Reproduced: send an image successfully, emit native compact_boundary, then attach that image again; the second request contained zero images. Compaction resets readgate but not the image-hash set. Deduplication replaces explicitly reattached bytes with a textual reference to an earlier image.

Evidence: [src/main/claude.js:674](E:/Mac/AtomNano/src/main/claude.js:674), [src/main/claude.js:2028](E:/Mac/AtomNano/src/main/claude.js:2028), [src/main/claude.js:2157](E:/Mac/AtomNano/src/main/claude.js:2157).

Required change: Remove prompt-level image suppression. Resend an explicitly attached image through the provider's supported input format. Content-addressed disk storage may still avoid duplicate files without suppressing model input.

Acceptance: After native compaction, restart, failed attempts and provider switches, explicitly reattaching the image must produce a real image input. Verify storage deduplication does not alter request content.

**F23 · P2 · Claude logout can be undone at startup; OpenAI auth status can use the wrong home**

Reproduced: logout removed the application Claude credential file, but the next startup seed copied the OS login back. The supposed first-run seed has no persisted first-run/logout marker. Also reproduced: credentials in an explicit CODEX_HOME were ignored by providerAuthStatus, which checks ~/.codex/auth.json.

Evidence: [src/main/main.js:22](E:/Mac/AtomNano/src/main/main.js:22), [src/main/main.js:47](E:/Mac/AtomNano/src/main/main.js:47), [src/main/profiles.js:311](E:/Mac/AtomNano/src/main/profiles.js:311), [src/main/auth.js:343](E:/Mac/AtomNano/src/main/auth.js:343).

Required change: Record one-time import and intentional logout state; do not silently reimport credentials after logout. Centralize provider-home resolution for execution, login, profile switching, status, discovery and backup. Honor explicit provider-home configuration consistently.

Acceptance: Log out, close/reopen and verify the logged-out state remains. Use an isolated CODEX_HOME and confirm all account/status paths resolve the same home without reading an unrelated terminal login.

**F24 · P2 · Codex usage is discarded and persisted token totals disappear on reload**

Reproduced: a Codex result containing 100 input tokens did not update session counters. app-server emits onUsage and returns usage, but its caller consumes neither. Separately, saving 100 input/20 output tokens and reloading the session lost both totals because normalizeSession omits the fields. This also affects Claude's accumulated totals.

Evidence: [src/main/codex-appserver.js:307](E:/Mac/AtomNano/src/main/codex-appserver.js:307), [src/main/claude.js:1602](E:/Mac/AtomNano/src/main/claude.js:1602), [src/main/claude.js:1667](E:/Mac/AtomNano/src/main/claude.js:1667), [src/main/store.js:225](E:/Mac/AtomNano/src/main/store.js:225).

Required change: Normalize usage by provider and persist the required fields through the session schema. Apply each turn's final usage once, distinguish last-turn and cumulative events, and show actual context-window data separately from rough estimates. Recover historical totals from persisted result events where possible.

Acceptance: Send repeated cumulative usage notifications, finalize once, restart and reopen. Counts must neither double nor reset; unknown values must remain unknown rather than display as zero usage.

**F25 · P2 · Per-tool updates can show a new disk version while the old runtime remains active**

Code-confirmed: per-tool updates install packages and refresh discovery, but only clear the Claude executable-path cache. ESM imports remain cached and a live Codex app-server is reused. The per-tool UI has no activation/restart flow comparable to the combined update flow. Separate update buttons also do not coordinate concurrent installations.

Evidence: [src/main/auth.js:258](E:/Mac/AtomNano/src/main/auth.js:258), [src/main/main.js:579](E:/Mac/AtomNano/src/main/main.js:579), [src/main/claude.js:42](E:/Mac/AtomNano/src/main/claude.js:42), [src/main/claude.js:429](E:/Mac/AtomNano/src/main/claude.js:429), [src/main/codex.js:17](E:/Mac/AtomNano/src/main/codex.js:17), [src/main/codex-appserver.js:63](E:/Mac/AtomNano/src/main/codex-appserver.js:63), [src/renderer/app.js:7796](E:/Mac/AtomNano/src/renderer/app.js:7796).

Required change: Serialize update operations, coordinate them with active sessions, and distinguish installed-on-disk from active runtime versions. Activate updates through a controlled relaunch/runtime restart after preserving session state. Refresh capabilities from the activated binary and report incomplete/failed installs accurately.

Acceptance: Using a fake installer/runtime, update each SDK and CLI independently and concurrently. The UI must not claim an active upgrade until the restarted runtime reports the new version. Validate failure, binary-in-use and packaged-app paths separately.

**F26 · P2 · Full conversation export omits archived history**

Reproduced with an existing archive sidecar: full export included 20 live messages and archivedCount=1, but omitted the archived message. The exporter serializes getSession's live array without combining the archive. Import does not restore that missing content. The advertised full export is therefore incomplete for archived sessions.

Evidence: [src/main/main.js:793](E:/Mac/AtomNano/src/main/main.js:793), [src/main/main.js:797](E:/Mac/AtomNano/src/main/main.js:797), [src/main/main.js:834](E:/Mac/AtomNano/src/main/main.js:834), [src/main/store.js:415](E:/Mac/AtomNano/src/main/store.js:415).

Required change: Export the complete canonical transcript and attachment references/originals needed for the promised export mode. Use the same history reader as full-history paging/search, and import into a new session without reusing an unrelated native provider transcript.

Acceptance: Archive early messages, export Full, import on an isolated data directory, and compare message IDs/order/text, tool outputs and attachments. Every original message must be recoverable. Keep explicitly compact exports clearly distinguished from full exports.

**F27 · P2 · Chat file:line links do not open their source locations**

Reproduced: a Markdown link to E:/Mac/AtomNano/src/main/auth.js:65 produced no anchor. Chat rendering does not enable the Markdown renderer's local-link option. Inline file promotions also have a preview handler that is not connected to the main chat path.

Evidence: [src/renderer/markdown.js:30](E:/Mac/AtomNano/src/renderer/markdown.js:30), [src/renderer/markdown.js:69](E:/Mac/AtomNano/src/renderer/markdown.js:69), [src/renderer/app.js:7385](E:/Mac/AtomNano/src/renderer/app.js:7385), [src/renderer/app.js:9415](E:/Mac/AtomNano/src/renderer/app.js:9415).

Required change: Use a single safe in-app file-link resolver for chat and previews. Support absolute/relative paths, spaces and line numbers, and open them in the editor. Keep external URL handling separate from local navigation.

Acceptance: Test drive-letter paths, relative paths, spaces, bare filenames with line references and external HTTPS links. Local links must open the requested file/line without passing arbitrary strings to a shell.

**F32 · P2 · Explicitly selected project skills are not applied consistently across providers**

Code-confirmed: the Claude path invokes session.selectedSkills, while OpenAI only tries to auto-match a skill from the prompt when automatic memory is enabled. A checked skill can therefore stop being applied when the provider changes, even though the UI still shows the selection.

Evidence: [src/main/claude.js:949](E:/Mac/AtomNano/src/main/claude.js:949), [src/main/claude.js:1364](E:/Mac/AtomNano/src/main/claude.js:1364).

Required change: Separate explicit user skill selection from automatic prompt injection. Apply explicit selections through each provider's supported integration, show unsupported capabilities, and remove automatic matching/learning from ordinary sends as requested.

Acceptance: Select a project skill without naming it in the prompt, switch providers and verify the explicit selection is either applied correctly or reported unsupported. A new session must start with no carried-over selected skills.

**Required removal scope**

This is the requested implementation target, not a claim that the layers have already been removed. Remove AtomNano-added behavioral instructions, lossy context transformations and artificial generation/content caps. Do not merely turn off their current defaults.

Crucially, preserve the user's exact instructions, including a “Code-output thrift” block when it is actually part of the user's message. Remove the app's automatic duplicate of that block; never strip user text by matching its wording. Preserve explicit user-authored project instructions and the provider's native system behavior. A fresh conversation can still have a configured workspace and native instruction files; this must be distinguishable from old conversation/project-memory injection.

| ID | Layer | Required result | Starting locations |
|---|---|---|---|
| R01 | Bundled behavior instructions | Remove application injections from caveman.js, frugal.js and codefrugal.js in Claude, Codex, custom and related workflows. Caveman and code-frugal default on; frugal defaults off but can be active in saved settings. | [src/main/store.js:86](E:/Mac/AtomNano/src/main/store.js:86), [src/main/claude.js:886](E:/Mac/AtomNano/src/main/claude.js:886), [src/main/claude.js:1354](E:/Mac/AtomNano/src/main/claude.js:1354), [src/main/claude.js:1761](E:/Mac/AtomNano/src/main/claude.js:1761) |
| R02 | Prompt wrappers and automatic advice | Remove automatic session-context wrappers, generated behavioral prefixes and automatic extraSystem/reviewer/planner advice from ordinary sends. An explicitly invoked workflow may have explicit conversation data, not an invisible additional instruction stack. | [src/main/claude.js:831](E:/Mac/AtomNano/src/main/claude.js:831), [src/main/claude.js:968](E:/Mac/AtomNano/src/main/claude.js:968), [src/main/claude.js:1134](E:/Mac/AtomNano/src/main/claude.js:1134) |
| R03 | Project memory and automatic skills | Remove automatic context.compose, graph/conversation-recall/digest injection, auto-match and auto-learn behavior from ordinary sends and brand-new sessions. Explicit user-selected skills remain explicit and must work consistently; old project-memory files need not be destructively deleted. | [src/main/context.js:20](E:/Mac/AtomNano/src/main/context.js:20), [src/main/claude.js:909](E:/Mac/AtomNano/src/main/claude.js:909), [src/main/claude.js:1364](E:/Mac/AtomNano/src/main/claude.js:1364), [src/main/claude.js:1905](E:/Mac/AtomNano/src/main/claude.js:1905) |
| R04 | Lossy rotation and handoff limits | Remove fixed 90/320-turn and three-hour heuristics, model-change cost-saving resets, 28-message handoffs, 300/320-character quote clipping, fenced-code removal and 9,000/12,000-character handoff budgets. Remove digest goal/outcome clipping from automatic context delivery. | [src/main/claude.js:279](E:/Mac/AtomNano/src/main/claude.js:279), [src/main/claude.js:345](E:/Mac/AtomNano/src/main/claude.js:345), [src/main/claude.js:988](E:/Mac/AtomNano/src/main/claude.js:988), [src/main/convo.js:115](E:/Mac/AtomNano/src/main/convo.js:115) |
| R05 | Prompt and file-content caps | Remove the 24,000-character combined cap, eight-file count limit and 12,000-character per-file cuts from initial sends, steering and custom paths. Never cut the current request. Preserve full durable attachment content and use native supported file/image inputs. | [src/main/claude.js:1373](E:/Mac/AtomNano/src/main/claude.js:1373), [src/main/claude.js:1397](E:/Mac/AtomNano/src/main/claude.js:1397), [src/main/claude.js:1778](E:/Mac/AtomNano/src/main/claude.js:1778), [src/main/claude.js:2535](E:/Mac/AtomNano/src/main/claude.js:2535) |
| R06 | Read and image suppression | Remove prompt-level image omission and readgate duplicate-Read denials. readgate defaults off but remains a live path for saved settings. Keep the actual permission decision; storage deduplication is acceptable only when it does not suppress explicitly requested model input. | [src/main/claude.js:576](E:/Mac/AtomNano/src/main/claude.js:576), [src/main/claude.js:674](E:/Mac/AtomNano/src/main/claude.js:674), [src/main/store.js:91](E:/Mac/AtomNano/src/main/store.js:91) |
| R07 | Application generation budgets | Remove automatic maxBudgetUsd/taskBudgetTokens overrides and migrate saved positive values out of normal requests. Remove application-imposed search/subagent-count caps and the hard-coded delegation count/policy prefix. Retain explicit user-selected permissions and delegation choices through supported structured controls. | [src/main/claude.js:474](E:/Mac/AtomNano/src/main/claude.js:474), [src/main/claude.js:912](E:/Mac/AtomNano/src/main/claude.js:912), [src/main/claude.js:1076](E:/Mac/AtomNano/src/main/claude.js:1076), [src/main/store.js:106](E:/Mac/AtomNano/src/main/store.js:106) |
| R08 | Hidden effort/model/summary changes | Remove smart-thinking downshifts, automatic model substitutions/fallback-model overrides, and forced detailed reasoning-summary overrides. Expose only supported explicit controls. Legacy models requiring a native thinking budget must use a clearly selected supported setting or their native default, not an undocumented approximation. | [src/main/claude.js:112](E:/Mac/AtomNano/src/main/claude.js:112), [src/main/claude.js:144](E:/Mac/AtomNano/src/main/claude.js:144), [src/main/claude.js:1069](E:/Mac/AtomNano/src/main/claude.js:1069), [src/main/claude.js:1624](E:/Mac/AtomNano/src/main/claude.js:1624) |
| R09 | Automatic environment tuning | Remove AtomNano's automatic prompt-cache TTL and build/command parallelism environment changes. Preserve environment values the user configured outside the app. These settings alter runtime behavior and are separate from UI rendering efficiency. | [src/main/claude.js:466](E:/Mac/AtomNano/src/main/claude.js:466), [src/main/claude.js:477](E:/Mac/AtomNano/src/main/claude.js:477), [src/main/store.js:98](E:/Mac/AtomNano/src/main/store.js:98) |
| R10 | MCP/context and notification suppression | Remove token-saving strictMcpConfig behavior as an implicit override of user-configured native MCP sources. Resolve and display the explicitly configured servers. Revisit the blanket app-server notification opt-out list: lifecycle/auth/usage/progress events required by the UI must not be suppressed merely to reduce traffic. | [src/main/claude.js:1049](E:/Mac/AtomNano/src/main/claude.js:1049), [src/main/claude.js:1059](E:/Mac/AtomNano/src/main/claude.js:1059), [src/main/codex-appserver.js:34](E:/Mac/AtomNano/src/main/codex-appserver.js:34) |
| R11 | Automatic additional agent work | Remove default self-heal and other automatically initiated reviewer/planner/skill-learning work after an ordinary send. Keep user-invoked workflows explicit, with their own visible runs and cancellation. Removing content caps must not accidentally make a repair/retry loop unbounded. | [src/main/store.js:94](E:/Mac/AtomNano/src/main/store.js:94), [src/main/claude.js:1243](E:/Mac/AtomNano/src/main/claude.js:1243), [src/main/claude.js:1910](E:/Mac/AtomNano/src/main/claude.js:1910) |
| R12 | Truncated stored tool payloads and hidden live text | Remove 6,000-character stored tool-input and 8,000-character stored-result cuts and the inaccessible 300-line live tail. Keep full canonical payloads, with paged/virtualized views. Audit the 150-file edit-tracker cap so the complete changed-file list remains recoverable. | [src/main/claude.js:282](E:/Mac/AtomNano/src/main/claude.js:282), [src/main/claude.js:1482](E:/Mac/AtomNano/src/main/claude.js:1482), [src/main/claude.js:2091](E:/Mac/AtomNano/src/main/claude.js:2091), [src/renderer/app.js:6310](E:/Mac/AtomNano/src/renderer/app.js:6310) |
| R13 | Dead optimizer integration | The Optimise/Distill UI path already returns immediately. Remove dead hooks/settings/modules that belong only to the retired optimization path after checking their callers; do not report that disabled button as an active cause of ordinary request rewriting. | [src/renderer/app.js:5036](E:/Mac/AtomNano/src/renderer/app.js:5036) |
| R14 | Saved-setting migration and all entry points | Remove obsolete controls and runtime branches, then migrate global/project/portable/imported settings so previous true flags cannot silently reactivate them. Cover normal sends, queued sends, retries, steering, fresh/reopened sessions, provider switches, explicit workflow entry points and CLI entry points. | [src/main/store.js:197](E:/Mac/AtomNano/src/main/store.js:197), [src/main/claude.js:2585](E:/Mac/AtomNano/src/main/claude.js:2585), [src/renderer/app.js:5211](E:/Mac/AtomNano/src/renderer/app.js:5211) |

Removing application caps does not remove the provider's real model/context limits. Surface those limits faithfully rather than inventing an unlimited-context guarantee. Keep cancellation, permissions, transport timeouts and bounded retry handling. Keep non-lossy frame coalescing, viewport virtualization, disk paging and caching needed for responsiveness; none may remove model-visible or recoverable conversation content.

**Required continuity design**

Use one canonical conversation record independent of provider, native thread, account and UI view. Preserve ordered user/assistant messages, completed tool-call/result data, exact text and durable attachment references. Use immutable run IDs and per-provider bindings that record native thread ID, auth-home/account identity and the last canonical message synchronized.

When the user switches provider, synchronize the exact missing recorded conversation data before generating the next reply. This is conversation history, not an application-authored instruction prefix. Transfer tool calls as completed history rather than executing them again. Do not transfer credential data or assume private provider reasoning/cache state is portable.

Use the supported native history mechanism for the installed runtime. The current Codex documentation describes thread/inject_items for adding persisted history without starting generation; verify the installed binary's contract/capabilities before adopting it. See the official [Codex history-injection documentation](https://developers.openai.com/codex/app-server). Do not hand-edit native transcript files or silently substitute short summaries when a required operation is unavailable.

On an account change within a provider, preserve the canonical conversation, finish or stop the current run at an explicit boundary, activate the selected authentication context, confirm it, then resume/synchronize the correct thread binding. The documented app-server account/read, account/login/start and account/logout flow gives the application an acknowledgement path; see [Codex account authentication](https://developers.openai.com/codex/app-server).

For New session, allocate new conversation/run bindings with empty composer, attachments, queue, session permissions and selected skills. Keep the previous tab's draft and running work independent. An explicit “continue/synthesize from this conversation” action is a different operation and must accurately describe any history it carries.

**Rendering target**

The requested smooth UI needs stable content identity and incremental updates. It does not require delaying received tokens or discarding older visible text.

| Before | After | Why |
|---|---|---|
| Existing lines fade in again after a tool/thinking transition. | Existing nodes stay fully visible; only new content animates once. | Removes grey flashes and repeated visual resets. |
| A command-output patch replaces its card. | Patch the status, arguments and output of the same card; retain expansion/selection. | Makes live output readable throughout execution. |
| Claude tool input/progress is ignored. | A stable tool row advances through preparing/approval/running/final states. | Shows what the agent is doing before the result arrives. |
| Streaming plain-line layout is replaced by different Markdown geometry. | Keep stable completed Markdown blocks and an incremental unfinished tail. | Reduces completion jumps in code, lists, tables and headings. |
| Earlier live lines disappear after 300 lines. | All content remains accessible through viewport virtualization. | Lets the user read earlier text while the model continues. |
| Background timer leaves a pending rAF behind. | Whichever flush wins cancels its peer and checks view/run generation. | Prevents duplicate work and stale view updates. |
| Model filters make old replies faint without clear context. | Visible filter state and readable normal text across provider changes. | Separates user filtering from a rendering failure. |
| Animations run without a reduced-motion rule. | Respect prefers-reduced-motion and preserve immediate readable content. | Supports accessibility and avoids unnecessary motion. |

Use profiling to validate the result: record event arrival, first visible tool state, DOM commit, long tasks and scroll jumps. Recommended acceptance targets on a declared reference machine are a visible tool state within 100 ms of an actionable event and frame work normally within a 60 Hz frame budget. These are proposed targets, not measurements from this audit. Include 200-event bursts, long code blocks, a 120k-character paragraph, thousands of transcript messages, background/foreground transitions, text selection and scrolling upward. Never hit a performance target by hiding or deleting content.

**Additional improvements**

- Protect application-owned saved API keys and saved profile copies using appropriate OS-backed storage. Native CLIs may require their own credential-file format; do not encrypt that format incompatibly. Make credential-bearing export behavior explicit. This is a hardening recommendation, not a claim that credentials were exposed during this audit.
- Add a per-run diagnostic view showing provider, transport, active account identifier, requested/sent/effective model and effort, native thread ID, synchronization position, attachment counts and active native instruction sources. Redact secrets and keep raw prompts opt-in. Do not expose internal implementation details in the normal conversation flow.
- Generate/validate the app-server protocol adapter against the supported binary version, and exhaustively handle the Claude SDK lifecycle events used by the product. Capability-test updates before marking them active. Keep user-facing unsupported-feature states instead of silent transport downgrades.
- Treat asynchronous account/email resolution and token watchers as identity-bound operations. A response fetched for an older credential snapshot must not rename or reconcile the newly selected account.
- Preserve effective configuration per run and for pending retries. A new dropdown choice should not relabel an old stream, silently reroute a paused request or steer text into an old provider while implying a new provider is running.
- Make tool-output byte/character counts and token estimates honest about their source. Counts based on an 8k-truncated stored result are not the model's full tool-input cost.

**Implementation order**

1. Repair durable session schema, transcript storage and attachment storage: F03, F07, F08, F26 and F28.
2. Repair account identity/activation/logout and provider-scoped switching: F01, F05, F23 and F31.
3. Implement the canonical conversation transfer for provider/account changes, then replace lossy recovery: F09, F21 and F30.
4. Remove the instruction/cap/optimization layers in R01–R14, including persisted-setting migration. Verify exact user input remains unchanged.
5. Normalize event identity and terminal states, then implement tool/background progress and cancellation: F04, F06, F11, F13–F16.
6. Stabilize rendering and clean new-session behavior: F12, F18–F20, F27 and F29.
7. Finish capability/effort/metadata, usage, update activation and explicit skill parity: F17, F24, F25 and F32.

**Acceptance matrix for the implementing AI**

| Area | Required scenarios |
|---|---|
| New session | Claude and Codex; existing unsent draft/images/skills; another tab actively running; prior project memory present; first send has no previous conversation binding. |
| Same conversation/provider | Several turns; long tools; native compaction; interrupted/retried run; close/reopen; full restart; memory eviction. |
| Provider switch | Claude → Codex → Claude and reverse; memory on/off; before/after restart; long exact constraints, code, image and completed-tool sentinels. |
| Account switch | A → B → A within one conversation; same-email accounts with different IDs; API key versus subscription; expired/rotated credentials; two projects/providers concurrently. |
| Model and effort | Every offered supported combination; unsupported values; server reroute; selection change mid-run; queued/retried work. Inspect actual outgoing fields. |
| Streaming tools | Slow Bash, fast Bash, Grep/Glob, concurrent tools, failed/denied tools, background task completion/failure and subagent output. |
| Streaming text | UTF-8 byte splits, partial Markdown boundaries, >300 lines, very long paragraph, thinking/tool/final transitions, scroll-up and reduced motion. |
| Durability and update | Disk full/access denied; archive failure; export/import round trip; per-tool and combined update; activated runtime version after relaunch. |

Preserve tests that already exercise useful behavior, but replace assertions that merely copy the implementation's old limits. The inspected stream smoke test mostly checks a short burst/coalescing scenario; it does not establish smooth long-response transitions. The inspected rotation tests encode the old policy and should not preserve that policy after its removal. Add meaningful tests at the actual adapter/storage/renderer boundaries with isolated data homes; no real credentials or paid provider requests are needed for the regression suite.

**Observed synthetic check results**

The following checks executed project code with controlled fixtures. “Reproduced” means the unwanted behavior was observed; “Passed” means the expected behavior was verified. A harness exiting zero means its observation assertions passed, not that the application is bug-free.

| Suite | Check | Observation |
|---|---|---|
| 1 | profiles same email different account overwrite | Reproduced |
| 1 | settings save reports success after disk failure | Reproduced |
| 1 | claude error result finalized as success | Reproduced |
| 1 | stop cancels other session permission | Reproduced |
| 1 | claude parent and child streams collide | Reproduced |
| 1 | claude idle guard uses just added prompt | Reproduced |
| 1 | openai primary selected model and effort | Passed |
| 1 | openai primary drops saved api key | Reproduced |
| 1 | openai prompt cap removes current request | Reproduced |
| 1 | openai base64 image not sent | Reproduced |
| 1 | openai usage not persisted | Reproduced |
| 1 | markdown local file line link not clickable | Reproduced |
| 2 | codex utf8 split corrupts stream and final | Reproduced |
| 2 | codex model effort reach turn start | Passed |
| 2 | codex resume failure starts fresh without context signal | Reproduced |
| 2 | codex stop during thread start still sends turn | Reproduced |
| 2 | codex api only model remapped to catalog default | Reproduced |
| 3 | claude logout reversed by next startup seed | Reproduced |
| 3 | openai auth status ignores custom codex home | Reproduced |
| 3 | stream timer fallback leaves duplicate animation frames | Reproduced |
| 3 | stream initial rebuild reanimates existing lines | Reproduced |
| 3 | stream long reply hides earlier lines while still running | Reproduced |
| 4 | claude tool start and argument stream are ignored | Reproduced |
| 4 | claude completed tool use creates running card before result | Passed |
| 4 | claude tool and background task progress are ignored | Reproduced |
| 4 | claude tool result completes existing card | Passed |
| 4 | claude image resend is suppressed after native compaction | Reproduced |
| 4 | archive failure still deletes live messages | Reproduced |
| 4 | full conversation export omits archive messages | Reproduced |
| 5 | new session factory clears conversation state for both providers | Passed |
| 5 | codex thread id is lost when session is loaded from disk | Reproduced |
| 5 | claude thread id survives session disk reload | Passed |
| 5 | session token totals are lost on disk reload | Reproduced |
| 5 | new session button reuses tab with draft attachments and skills | Reproduced |
| 5 | fresh session project context includes previous run memory | Reproduced |
| 6 | switch to claude uses lossy handoff without exact prior constraint | Reproduced |
| 6 | switch to openai with memory off sends no prior conversation | Reproduced |
| 6 | openai account force fresh flag consumed without changing resume | Reproduced |
| 6 | account invalidation uses global provider instead of session provider | Reproduced |
| 6 | last provider is dropped while old claude resume id survives | Reproduced |

The real-account/binary activation checks in F25 and F31, and live Electron frame/contrast measurements, remain acceptance work for implementation. The current report establishes code defects and synthetic reproductions without claiming that these external/runtime checks ran.
