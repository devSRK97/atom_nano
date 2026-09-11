# AtomNano database management audit — implementation handoff

Date: 2026-09-09  
Project: `E:\Mac\AtomNano`  
Scope: the Database Manager module, all seven advertised adapters, storage/credentials, query execution, result rendering, row/schema editing, import/export, driver lifecycle and the related Electron IPC/window boundaries.

**51 findings: 22 P1 and 29 P2, plus 10 feature/improvement gaps.** Fix the cross-connection execution, wrong-row mutations, write retries, policy bypasses, credential persistence and incomplete/partial data operations first. This is a separate DB audit; the earlier agent and Git audit documents are not replaced.

This audit added only this report and isolated evidence; it made no application-code, dependency, saved-profile or real-database changes. No credentials were read, no remote database was contacted and no npm installation or production import/export was performed. During final verification, unrelated edits were detected in shared main/preload/styles/package files. Their DB integration points were rechecked and source references refreshed. The shared IPC now preserves type/details/code; this improvement is acknowledged below. The four DB module files and original DB styles were unchanged. Initial and final source fingerprints are retained in the manifest.

## How to use this handoff

P1 means a high-priority risk to data, connection targeting, credential protection or process stability. P2 means a significant correctness, reliability, rendering or usability issue. A finding's evidence distinguishes executed reproductions from source/driver-contract review. Feature gaps are proposed capabilities, not claims that a documented existing feature is broken.

Implement by the dependency waves below, not by patching UI symptoms individually. Preserve original SQL/data and make operations own their connection revision, transaction/session, cancellation and terminal outcome. Keep database/format constraints explicit; remove silent application truncation and unsolicited SQL hints rather than removing correctness checks or virtualization.

## Coverage and evidence

Read all four first-party DB files: `src/main/db.js`, `src/main/db-worker.js`, `src/main/db-io.js`, and `src/renderer/dbm.js`, plus the relevant main/preload handlers, app/dialog helpers, styles, CSP, package/lock metadata and packaging configuration. The export inventory covers **32 db.js exports, 10 db-io.js exports and all 30 db:* IPC handlers**. Shared application files were reviewed at their DB integration points; this is not a claim to have re-audited every unrelated application feature.

| Surface | Reviewed functionality | Evidence / principal findings |
|---|---|---|
| Profiles and credentials | list/save/remove, encryption migration, form test/save/cancel, duplicate, protection policies | DB-014–016, 023, 046; synthetic store/secret fault injection |
| Connections | all seven open/close adapters, pooling, test, ping, concurrent opens, disconnect/reconnect and window lifetime | DB-001–003, 013, 021–025, 049 |
| Discovery | schema, columns, indexes, foreign keys, native/approximate DDL, row counts, Redis SCAN | All adapter branches read; real SQLite row/column operations and mocked UI catalogs; DB-032/043 and G06/G07 |
| Queries | every query branch, parallelQuery, explain, formatting/splitting, history, result sets and caps | DB-002/003/011/012/024–031/039 |
| Row changes | insertRow/updateRows/deleteRows, PK detection, inline edits, insert forms, generated literals | Actual in-memory SQLite reproductions; DB-004/005/017/019/020/030 |
| Schema changes | add/drop/rename column, add/drop index, MySQL reorder, pending changes, preview and policy routing | All exported paths reviewed; DB-006/007/040–043 |
| Import | CSV/TSV/text/SQL/XLSX parsing, mapping, header/null options, batching, empty-first, stop-on-error, tokens/progress | DB-008/009/012/033–038 |
| Export | page/all CSV/JSON/SQL/XLSX, copy TSV/Markdown/JSON/CSV, paging, typed values and file finalization | DB-010/017/018/028/032/037/038/044 |
| Renderer | connection tabs, object list, query/browse/structure modes, virtual rows, status/log, menus/dialogs, editing/paging | Original source and CSS in blank Chromium; DB-001/019/020/022–024/032/040/042/045/048–050 |
| IPC/install/package | exposed DB API, errors/sender handling, standalone window, driver install/load, native Electron ABI | DB-045/047; actual Electron SQLite load succeeded |

**Executed evidence:** 53 backend characterization checks, 20 UI checks and one Electron SQLite runtime check: **74 passed**. Of these, **65 reproduce current defects, 8 are positive controls and 1 is a small rendering measurement**. Passing characterization checks means the recorded current behavior was observed; it does not mean the module is fixed. Additional source, metadata and contrast probes are recorded in the manifest.

- [Backend harness](E:/Mac/AtomNano/audit-evidence/db-2026-09-09/backend-characterization.cjs) and [backend results](E:/Mac/AtomNano/audit-evidence/db-2026-09-09/backend-results.json): the original CommonJS modules use a fake connection store/dialog/filesystem for profiles and I/O. SQL row checks use the installed better-sqlite3 with `:memory:` databases; other engines use explicit recording/fault-injection drivers.
- [UI harness](E:/Mac/AtomNano/audit-evidence/db-2026-09-09/ui-characterization.cjs) and [UI results](E:/Mac/AtomNano/audit-evidence/db-2026-09-09/ui-results.json): the original DB renderer, relevant original app helpers and CSS run in isolated blank Chromium pages with all database IPC mocked. No full application/user profile is launched.
- [Electron SQLite runtime result](E:/Mac/AtomNano/audit-evidence/db-2026-09-09/electron-sqlite-result.json): Electron 42.3.0, embedded Node 24.15.0, ABI 146 successfully loaded the installed driver and queried an in-memory SQLite 3.53.4 database.
- [Review manifest](E:/Mac/AtomNano/audit-evidence/db-2026-09-09/review-manifest.json): source SHA256 fingerprints, export/channel inventory, evidence metadata, severity/test mappings and focused probes.

**Practical limits:** no live MySQL, PostgreSQL, Oracle, MongoDB, SQL Server or Redis server, real TLS endpoint, OS credential failure, packaged installer/update or large production dataset was exercised. Those findings rely on source plus installed driver code/official contracts or explicit mock fault injection and require real-engine acceptance tests. The UI probe verifies component behavior, not a full packaged Electron end-to-end flow.

| Engine | Installed package | Runtime coverage in this audit |
|---|---|---|
| mysql | mysql2 3.24.3 | Adapter source and focused recording/fault-injection probes; no server |
| postgres | pg 8.23.0 | Adapter source and focused recording/fault-injection probes; no server |
| oracle | oracledb 7.0.1 | Installed Pool API checked; recording pool/query/import probes; no server |
| mongodb | mongodb 7.6.0 | Adapter source and focused recording/fault-injection probes; no server |
| sqlite | better-sqlite3 13.0.3 | Actual in-memory driver operations under Node; successful isolated Electron load |
| mssql | mssql 12.7.0 | Adapter source and focused recording/fault-injection probes; no server |
| redis | redis 6.2.1 | Adapter source and focused recording/fault-injection probes; no server |

Positive controls retained: quoted identifier escaping, a normal SQLite keyed edit, zero-row result headers, basic CSV/XLSX values, correct byte-unit formatting, a draft retained through a redraw confirmation, ordinary query rendering and the actual Electron SQLite ABI load. In particular, the byte-size operator-precedence suspicion and an assumption that every redraw silently loses a cell draft were ruled out. SQLite foreign-key enforcement was enabled in the installed driver probe; its absence is not a finding.

## Findings and fixes

| ID | Priority | Finding |
|---|---|---|
| DB-001 | P1 | A busy tab can send later statements to a different connection |
| DB-002 | P1 | Query tabs do not own database sessions or transactions |
| DB-003 | P1 | Automatic reconnect replays writes with unknown commit outcomes |
| DB-004 | P1 | Row mutation accepts ambiguous or incomplete primary keys |
| DB-005 | P1 | Large integer keys round to a different row identity |
| DB-006 | P1 | SQL protection policies are bypassed by valid statement forms |
| DB-007 | P1 | MongoDB and Redis protections are inconsistent or ineffective |
| DB-008 | P1 | Empty-first import can erase existing data before validation fails |
| DB-009 | P1 | Cancel or closing an import dialog does not stop writes |
| DB-010 | P1 | MongoDB export can lose or mislabel every earlier page |
| DB-011 | P1 | Format SQL changes string literals and comments |
| DB-012 | P1 | SQL splitting corrupts scripts and stored-program bodies |
| DB-013 | P1 | Idle PostgreSQL connection errors can escape as unhandled events |
| DB-014 | P1 | Connection saves can falsely succeed or erase a damaged store |
| DB-015 | P1 | Credential encryption silently degrades and can destroy secrets |
| DB-016 | P1 | TLS settings encrypt without authenticating the database server |
| DB-017 | P1 | Display strings replace canonical binary and BSON values |
| DB-018 | P1 | Export ALL silently ends at two million rows |
| DB-019 | P2 | Row edits and deletes update the UI without verifying the persisted result |
| DB-020 | P1 | Several mutation buttons can submit duplicate writes |
| DB-021 | P2 | Connection creation and disposal have races and resource leaks |
| DB-022 | P2 | Health checks can undo disconnects and misclassify ordinary errors |
| DB-023 | P2 | Cancelling profile edits does not restore the original renderer policy |
| DB-024 | P1 | A later query failure hides earlier successful writes and results |
| DB-025 | P2 | Oracle Test connection uses a method that the installed pool does not provide |
| DB-026 | P2 | SQLite dispatch assumes the first keyword determines whether rows are returned |
| DB-027 | P2 | Regex SELECT caps alter valid SQL and conceal incomplete results |
| DB-028 | P2 | Result normalization collapses duplicate columns and additional result sets |
| DB-029 | P2 | Worker normalization changes binary values when results cross 2000 rows |
| DB-030 | P1 | Generated mutations interpolate untyped SQL literals |
| DB-031 | P2 | Oracle LOB query values are never fetched as their actual content |
| DB-032 | P2 | Paging uses unstable order and treats estimates as navigation bounds |
| DB-033 | P2 | Import row counts hide partial commits and cap error details |
| DB-034 | P2 | Import tokens lack expiry enforcement, ownership and a consumed/running state |
| DB-035 | P2 | Import batch size ignores engine-specific statement limits |
| DB-036 | P2 | CSV parsing silently drops valid empty rows and accepts malformed input |
| DB-037 | P2 | The XLSX codec silently changes dates and truncates long text |
| DB-038 | P2 | Import/export processing blocks main and has unbounded expansion/allocation paths |
| DB-039 | P2 | Queries have no cancellation or incremental result protocol |
| DB-040 | P2 | Pending schema changes have inconsistent plans and lose failed work |
| DB-041 | P2 | MySQL column reorder rebuilds incomplete column definitions |
| DB-042 | P2 | Add-column type changes keep hidden parameters and misinterpret defaults |
| DB-043 | P2 | Object identity and catalog metadata are lossy across schemas |
| DB-044 | P2 | SQL export is offered without a valid target or engine dialect |
| DB-045 | P2 | Database-controlled names enter HTML and IPC has no DB-specific boundary validation |
| DB-046 | P2 | All credentials are exposed to renderer lists and query history has no retention controls |
| DB-047 | P2 | Driver installation mutates the application tree without a verified lifecycle |
| DB-048 | P2 | The virtual grid is mouse-dependent and some text has low contrast |
| DB-049 | P2 | Tab/window lifecycle does not protect drafts or release module resources |
| DB-050 | P2 | Dismissed shared confirmation dialogs never resolve |
| DB-051 | P1 | Redis quoted keys can become multiple unintended mutation targets |


### DB-001 — P1: A busy tab can send later statements to a different connection

Applies to: All.  
Source: [src/renderer/dbm.js:296](E:/Mac/AtomNano/src/renderer/dbm.js:296), [src/renderer/dbm.js:800](E:/Mac/AtomNano/src/renderer/dbm.js:800), [src/renderer/dbm.js:815](E:/Mac/AtomNano/src/renderer/dbm.js:815).

**Evidence and impact.** The last tab is reset by mutating its existing object. runQuery reads tab.conn.id for each statement after awaiting the previous one. Closing that tab, opening connection B and resolving the first statement sends the second statement of connection A's script to B. The browser reproduction recorded A → B.

**Fix.** Create an immutable execution context at submission: operation ID, connection ID and configuration revision, tab generation and complete statement list. Main must bind the operation to that revision for its whole lifetime. Closing/reusing a tab may detach or explicitly cancel an operation; it must never retarget it. Reject configuration changes for an active operation or finish it on its original pinned connection.

**Acceptance.** Delay statement 1, close/reuse its tab and open another database. Every remaining statement stays bound to the original database or is cancelled before submission. Repeat while editing/saving the connection and while closing the DBM window.

Checks: DB-U07 in the linked evidence results.

### DB-002 — P1: Query tabs do not own database sessions or transactions

Applies to: MySQL, PostgreSQL, Oracle, SQL Server; shared SQLite/Redis state also needs ownership.  
Source: [src/main/db.js:132](E:/Mac/AtomNano/src/main/db.js:132), [src/main/db.js:527](E:/Mac/AtomNano/src/main/db.js:527), [src/main/db.js:532](E:/Mac/AtomNano/src/main/db.js:532), [src/main/db.js:544](E:/Mac/AtomNano/src/main/db.js:544), [src/main/db.js:586](E:/Mac/AtomNano/src/main/db.js:586), [src/main/db.js:611](E:/Mac/AtomNano/src/main/db.js:611).

**Evidence and impact.** MySQL/PostgreSQL use pool.query per statement; SQL Server uses a new Request; Oracle checks out/releases a connection for each statement and forces autoCommit:true. BEGIN/COMMIT, USE, SET/search_path, temporary tables and transaction state are not attached to a query tab. All tabs/windows reuse a cache keyed only by saved connection ID. A SQL Server error even recommends SET SHOWPLAN_TEXT despite this routing. [node-postgres transaction contract](https://node-postgres.com/features/transactions) requires a transaction to use one client.

**Fix.** Introduce an execution session owned by a tab/operation, with a checked-out client and explicit transaction state. Route transaction commands, session settings and dependent batches through that client. Keep health checks separate. Define transaction behavior on disconnect, tab close and app quit; await rollback/release. Use dedicated Redis sessions for stateful commands.

**Acceptance.** Two tabs share a saved profile but cannot commit/rollback each other's work or change each other's database/session settings. Verify rollback and temporary-table visibility on each SQL driver; Oracle must honor explicit transaction mode.

Checks: DB-B14, DB-B49 in the linked evidence results.

### DB-003 — P1: Automatic reconnect replays writes with unknown commit outcomes

Applies to: All query adapters.  
Source: [src/main/db.js:493](E:/Mac/AtomNano/src/main/db.js:493), [src/main/db.js:603](E:/Mac/AtomNano/src/main/db.js:603).

**Evidence and impact.** Any query error whose message matches STALE_RE causes a new connection and an unconditional rerun. An INSERT that commits before ECONNRESET is executed twice; the returned result reports one affected row. Non-idempotent Redis commands, Mongo writes, imports and DDL use the same path.

**Fix.** Never automatically replay a submitted mutation or any operation with unknown outcome. Return a typed outcome_unknown result with the operation ID and reconciliation guidance. Restrict automatic read retries to explicitly classified safe operations outside transactions, with bounded attempts and identical connection revisions. Do not classify retryability by arbitrary message text alone.

**Acceptance.** Inject disconnect after server-side commit for INSERT, increment, DDL and import batches. Exactly one submission occurs; UI preserves uncertainty and does not offer a blind automatic retry.

Checks: DB-B13 in the linked evidence results.

### DB-004 — P1: Row mutation accepts ambiguous or incomplete primary keys

Applies to: SQL row editing; Mongo filters also need strict identity validation.  
Source: [src/main/db.js:962](E:/Mac/AtomNano/src/main/db.js:962), [src/main/db.js:979](E:/Mac/AtomNano/src/main/db.js:979), [src/main/db.js:995](E:/Mac/AtomNano/src/main/db.js:995), [src/renderer/dbm.js:1057](E:/Mac/AtomNano/src/renderer/dbm.js:1057).

**Evidence and impact.** The backend only checks that pk is nonempty. A SQLite TEXT PRIMARY KEY permits multiple NULL values; clicking one such row produces WHERE id IS NULL and updates both. Supplying only id for a composite (tenant,id) key also updates two rows. The UI accepts any nonempty subset of key columns returned in a result. [SQLite primary-key semantics](https://www.sqlite.org/lang_createtable.html) document the nullable-key exception.

**Fix.** Resolve real key metadata in main; require the complete key with its original typed values and prohibit ambiguous NULL identities. Use a stable rowid/unique key only where valid and explicitly known. Execute a single-row mutation with a cardinality check inside a transaction and roll back if the match is not exactly one. Reject expression/operator objects in row identity fields.

**Acceptance.** Two NULL-key rows and two tenants sharing an id cannot be edited/deleted together from a single-row action. Stale/partial key metadata is rejected before writing. Test deletion as well as update.

Checks: DB-B19, DB-B20 in the linked evidence results.

### DB-005 — P1: Large integer keys round to a different row identity

Applies to: Confirmed SQLite; MySQL numeric defaults require equivalent validation.  
Source: [src/main/db.js:143](E:/Mac/AtomNano/src/main/db.js:143), [src/main/db.js:176](E:/Mac/AtomNano/src/main/db.js:176), [src/main/db.js:460](E:/Mac/AtomNano/src/main/db.js:460), [src/main/db.js:991](E:/Mac/AtomNano/src/main/db.js:991).

**Evidence and impact.** SQLite integers are fetched as Number without safe-integer handling. IDs 9007199254740992 and 9007199254740993 render identically; editing the second row updates the first. Converting bigint to text in cell() occurs too late when a driver has already rounded it. MySQL configuration also leaves supportBigNumbers/bigNumberStrings at driver defaults.

**Fix.** Configure each adapter for lossless integer/decimal retrieval and preserve typed canonical values independently from display text. Send those canonical values as bound parameters. Reject unsafe numeric identities, and never coerce arbitrary precision numbers through Number in the renderer, worker or export.

**Acceptance.** Adjacent integers above 2^53 remain distinct through browse, sort, copy, edit, delete and export/import. A click on the second row changes only that exact key. Add decimal-scale and bigint boundary fixtures.

Checks: DB-B21 in the linked evidence results.

### DB-006 — P1: SQL protection policies are bypassed by valid statement forms

Applies to: SQL engines.  
Source: [src/main/db.js:495](E:/Mac/AtomNano/src/main/db.js:495), [src/main/db.js:518](E:/Mac/AtomNano/src/main/db.js:518), [src/main/db.js:702](E:/Mac/AtomNano/src/main/db.js:702).

**Evidence and impact.** Policy decisions inspect the first keyword. A writable PostgreSQL CTE is exempted as WITH, including protected-table checks; EXEC sp_rename bypasses blockDDL. Leading comments bypass the keyword flags through direct IPC, although the current editor splitter strips many comments. A protectedTables entry can still catch the commented form by name, so these are distinct bypass conditions. [PostgreSQL data-modifying CTEs](https://www.postgresql.org/docs/current/queries-with.html) can write even when the outer statement is SELECT.

**Fix.** Centralize policy enforcement on parsed operation types and resolved object identities, including CTE bodies, stored commands and adapter-generated operations. Evaluate policies in main for every mutation path. Treat these settings as application protections; a true read-only connection should also use database permissions/session controls. Unknown mutating constructs under a protection policy require an explicit supported outcome rather than permissive fallthrough.

**Acceptance.** Test blockWrite, blockDDL, blockDrop, blockTruncate and protectedTables independently and together against comments, CTE DML, EXEC/RENAME, quoted/schema-qualified objects, SQL files and every structured mutation API.

Checks: DB-B15 in the linked evidence results.

### DB-007 — P1: MongoDB and Redis protections are inconsistent or ineffective

Applies to: MongoDB, Redis.  
Source: [src/main/db.js:551](E:/Mac/AtomNano/src/main/db.js:551), [src/main/db.js:593](E:/Mac/AtomNano/src/main/db.js:593), [src/main/db.js:654](E:/Mac/AtomNano/src/main/db.js:654), [src/main/db.js:688](E:/Mac/AtomNano/src/main/db.js:688), [src/main/db.js:707](E:/Mac/AtomNano/src/main/db.js:707), [src/main/db.js:968](E:/Mac/AtomNano/src/main/db.js:968).

**Evidence and impact.** SQL-keyword checks do not recognize Mongo JSON writes or Redis SET/DEL/FLUSH commands. Mongo field/index DDL calls drivers directly without checkPolicy. Structured Mongo row APIs pass only INSERT/UPDATE/DELETE to policy checking, so protected collection names are absent. Raw Mongo JSON with a literal protected name may be blocked by the name regex, but that does not repair the other paths.

**Fix.** Give each adapter an operation classifier and object-aware authorization check. Enforce it for raw command wrappers, aggregation $out/$merge, field/index mutations, row APIs and import truncate/write operations. Define Redis write/admin command policy explicitly and expose only policies the engine can enforce.

**Acceptance.** With protections enabled, no direct or UI Mongo field/index/import mutation and no Redis write/admin command reaches the driver. Reads remain usable. Test protected collection names independently from blockWrite.

Checks: DB-B16, DB-B17, DB-B18 in the linked evidence results.

### DB-008 — P1: Empty-first import can erase existing data before validation fails

Applies to: All importable engines.  
Source: [src/main/db-io.js:251](E:/Mac/AtomNano/src/main/db-io.js:251), [src/main/db-io.js:273](E:/Mac/AtomNano/src/main/db-io.js:273), [src/main/db-io.js:280](E:/Mac/AtomNano/src/main/db-io.js:280), [src/renderer/dbm.js:1182](E:/Mac/AtomNano/src/renderer/dbm.js:1182).

**Evidence and impact.** Import executes DELETE/TRUNCATE before inserting, with no encompassing transaction or staging plan. In the SQLite reproduction, a constraint error on the first imported row left the original table empty. The confirmation acknowledges deletion but provides no atomic import guarantee or rollback strategy; later failures can also leave a partial replacement.

**Fix.** Preflight mappings, types, constraints and engine capabilities before destructive work. Use transactional delete+load where supported; where TRUNCATE/DDL commits implicitly, use a staging/swap strategy or an explicitly reviewed non-atomic plan. Return a durable per-batch outcome and retain enough state to reconcile a failure.

**Acceptance.** Fail the first and middle batch after an empty-first request. Atomic mode preserves all original rows and removes partial imported data. Non-atomic engines clearly identify committed effects before execution and after failure.

Checks: DB-B34 in the linked evidence results.

### DB-009 — P1: Cancel or closing an import dialog does not stop writes

Applies to: All imports.  
Source: [src/main/db-io.js:252](E:/Mac/AtomNano/src/main/db-io.js:252), [src/main/db-io.js:258](E:/Mac/AtomNano/src/main/db-io.js:258), [src/main/db-io.js:280](E:/Mac/AtomNano/src/main/db-io.js:280), [src/main/db-io.js:296](E:/Mac/AtomNano/src/main/db-io.js:296), [src/renderer/dbm.js:1134](E:/Mac/AtomNano/src/renderer/dbm.js:1134), [src/renderer/dbm.js:1205](E:/Mac/AtomNano/src/renderer/dbm.js:1205).

**Evidence and impact.** importRun holds the imported data in a local variable. importDiscard only deletes the Map entry; running loops keep using their local copy. The visible Cancel button stays usable while writes continue. The reproduction discarded a token during batch one and still executed batch two. X/backdrop close also has no operation lifecycle hook.

**Fix.** Separate closing a view from cancelling a job. Store an abortable operation record in main, check cancellation before every submission and invoke the driver's cancellation API where supported. Await acknowledgement, report already committed/unknown work and define rollback. Keep job progress/outcome accessible after the dialog/window closes.

**Acceptance.** Cancel between batches prevents the next submission; cancel during a query reports the exact terminal state. Closing the dialog neither implies cancellation nor hides an active job. Repeat for SQL scripts and table imports.

Checks: DB-B35 in the linked evidence results.

### DB-010 — P1: MongoDB export can lose or mislabel every earlier page

Applies to: MongoDB.  
Source: [src/main/db.js:435](E:/Mac/AtomNano/src/main/db.js:435), [src/main/db.js:923](E:/Mac/AtomNano/src/main/db.js:923), [src/main/db-io.js:191](E:/Mac/AtomNano/src/main/db-io.js:191), [src/main/db-io.js:214](E:/Mac/AtomNano/src/main/db-io.js:214).

**Evidence and impact.** fetchAll overwrites columns with each page while appending row arrays in their original page order. An empty final page replaces headers with []; exporting exactly 5000 Mongo documents produced 5000 empty JSON objects. A later page with different fields labels earlier values with the wrong column names.

**Fix.** Export Mongo documents with stable field identities and their native typed shape. For tabular formats build and maintain a union schema, remapping each row by field identity, including pages already written/spooled. Preserve headers on empty pages and use EJSON for lossless document export.

**Acceptance.** Export 0, 4999, 5000, 5001 and 10000 documents with disjoint/reordered fields on later pages. Compare every field/value with the source, including NULL, missing fields and BSON types.

Checks: DB-B40, DB-B41 in the linked evidence results.

### DB-011 — P1: Format SQL changes string literals and comments

Applies to: SQL editor.  
Source: [src/renderer/dbm.js:55](E:/Mac/AtomNano/src/renderer/dbm.js:55), [src/renderer/dbm.js:776](E:/Mac/AtomNano/src/renderer/dbm.js:776).

**Evidence and impact.** formatSQL globally collapses whitespace, capitalizes keywords and inserts comma/newline formatting without tokenizing literals/comments. A text value containing repeated spaces, from and a comma is changed by clicking Format. Newline removal can also change which text belongs to a line comment.

**Fix.** Use a maintained dialect-aware SQL formatter/parser configured for the selected engine. Preserve literal/comment contents byte-for-byte. If parsing is unsupported or fails, leave the original editor text intact and return an actionable message. Make formatting one undoable editor action.

**Acceptance.** Format then execute round-trip fixtures containing quoted keywords, whitespace, commas, escaped strings, comments and procedural bodies. The parsed literals and execution effects are identical before/after.

Checks: DB-U01 in the linked evidence results.

### DB-012 — P1: SQL splitting corrupts scripts and stored-program bodies

Applies to: SQL editor and SQL import.  
Source: [src/renderer/dbm.js:61](E:/Mac/AtomNano/src/renderer/dbm.js:61), [src/renderer/dbm.js:810](E:/Mac/AtomNano/src/renderer/dbm.js:810), [src/main/db-io.js:164](E:/Mac/AtomNano/src/main/db-io.js:164), [src/main/db-io.js:235](E:/Mac/AtomNano/src/main/db-io.js:235).

**Evidence and impact.** Both custom scanners remove comments without always retaining a separator; SELECT/*...*/1 becomes SELECT1. Neither understands PostgreSQL dollar quotes or procedural statement boundaries. Import removes DELIMITER lines but still splits on semicolons, and discards executable MySQL version comments. SQL Server GO/bracket syntax and Oracle block terminators are not handled.

**Fix.** Adopt one dialect-aware script execution contract shared by editor and importer. Preserve comments that affect semantics, distinguish client delimiters/batch markers and send supported procedural blocks intact. Refuse unsupported constructs before submitting any part of the script. Keep original statement offsets for errors.

**Acceptance.** Round-trip MySQL dumps/routines, PostgreSQL DO/functions, Oracle PL/SQL, SQLite triggers, SQL Server batches and ordinary quoted semicolons. Parse failures make no writes, and failures identify their exact original statement.

Checks: DB-U02, DB-B47, DB-B48 in the linked evidence results.

### DB-013 — P1: Idle PostgreSQL connection errors can escape as unhandled events

Applies to: PostgreSQL; verify other pool event contracts too.  
Source: [src/main/db.js:153](E:/Mac/AtomNano/src/main/db.js:153), [src/main/db.js:161](E:/Mac/AtomNano/src/main/db.js:161).

**Evidence and impact.** The PostgreSQL Pool has no error listener. pg-pool emits idle-client errors on the pool; query-level try/catch does not catch EventEmitter errors delivered later. A contract-faithful EventEmitter pool reproduced the throw. The installed pg-pool source emits this event. [node-postgres pool events](https://node-postgres.com/apis/pool) describe idle error handling and the need for an error listener.

**Fix.** Attach pool/client error listeners before connecting, classify failures and invalidate the correct connection revision. Convert them to operation/status events without unhandled throws. Avoid destroying another generation's replacement pool; clean up listeners and clients on close.

**Acceptance.** Emit an idle socket/server-restart error with no active query. Electron main remains alive, the affected profile gets an accurate status and the next permitted operation can reconnect.

Checks: DB-B11 in the linked evidence results.

### DB-014 — P1: Connection saves can falsely succeed or erase a damaged store

Applies to: All saved profiles.  
Source: [src/main/db.js:70](E:/Mac/AtomNano/src/main/db.js:70), [src/main/db.js:76](E:/Mac/AtomNano/src/main/db.js:76), [src/main/db.js:81](E:/Mac/AtomNano/src/main/db.js:81), [src/renderer/dbm.js:722](E:/Mac/AtomNano/src/renderer/dbm.js:722).

**Evidence and impact.** saveConns swallows write failures and save/remove still return success. loadConns converts every read/parse error to an empty list; a later save replaces a damaged or temporarily unreadable store. Writes replace the JSON file directly without atomic staging. Renderer connection removal also suppresses IPC errors.

**Fix.** Validate and version the store, distinguish not-found from corruption/I/O failure, and propagate typed persistence errors. Save through a same-directory temporary file with a verified atomic replacement and recoverable backup. Preserve the last readable store; never close/reconfigure a live connection until persistence succeeds. Surface remove failures.

**Acceptance.** Simulate EACCES, full disk, interrupted writes, invalid JSON and an unreadable store. No success toast or profile loss occurs; the original store remains recoverable. Concurrent windows cannot overwrite a newer profile revision.

Checks: DB-B01, DB-B02 in the linked evidence results.

### DB-015 — P1: Credential encryption silently degrades and can destroy secrets

Applies to: All saved passwords/URIs.  
Source: [src/main/db.js:60](E:/Mac/AtomNano/src/main/db.js:60), [src/main/db.js:62](E:/Mac/AtomNano/src/main/db.js:62), [src/main/db.js:66](E:/Mac/AtomNano/src/main/db.js:66), [src/renderer/dbm.js:708](E:/Mac/AtomNano/src/renderer/dbm.js:708).

**Evidence and impact.** Unavailable or failed safeStorage encryption falls back to plaintext despite the form promising OS encryption. An ordinary secret beginning enc: is treated as ciphertext. Decryption errors become empty strings; saving another connection then overwrites the inaccessible ciphertext with an empty field. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) documents platform-dependent availability and backend semantics.

**Fix.** Use a versioned typed credential envelope and explicit unchanged/replace/clear operations. Preserve unreadable ciphertext and report a locked/unavailable state. If secure persistence is unavailable, fail secure saving or offer a clearly identified session-only credential. Migrate legacy plaintext atomically and never infer encryption solely from a user string prefix.

**Acceptance.** Test unavailable storage, encrypt/decrypt failure, OS-user changes, legacy plaintext, empty secrets, secrets beginning enc:, and unrelated profile edits. No path silently writes plaintext or destroys recoverable ciphertext.

Checks: DB-B03, DB-B04, DB-B05 in the linked evidence results.

### DB-016 — P1: TLS settings encrypt without authenticating the database server

Applies to: MySQL, PostgreSQL, SQL Server.  
Source: [src/main/db.js:147](E:/Mac/AtomNano/src/main/db.js:147), [src/main/db.js:158](E:/Mac/AtomNano/src/main/db.js:158), [src/main/db.js:189](E:/Mac/AtomNano/src/main/db.js:189), [src/renderer/dbm.js:649](E:/Mac/AtomNano/src/renderer/dbm.js:649), [src/renderer/dbm.js:680](E:/Mac/AtomNano/src/renderer/dbm.js:680).

**Evidence and impact.** MySQL and PostgreSQL set rejectUnauthorized:false whenever TLS is enabled; SQL Server always sets trustServerCertificate:true. New form defaults also set ssl:false. The UI provides no CA/server-name/verification choice, so checking TLS does not ensure certificate validation.

**Fix.** Default enabled TLS to certificate and hostname verification. Add explicit CA and relevant client-certificate/server-name configuration through a validated adapter contract. If an insecure certificate exception is needed, make it an intentional per-profile setting with an accurate label. Preserve URI TLS semantics for MongoDB/Redis.

**Acceptance.** Trusted certificates connect; untrusted/expired/wrong-host certificates fail in verified mode. Test SQL Server's encrypt option independently from certificate trust. Saving/editing a profile retains the selected mode.

Checks: DB-B07 in the linked evidence results.

### DB-017 — P1: Display strings replace canonical binary and BSON values

Applies to: SQL binary/date/JSON columns; MongoDB BSON.  
Source: [src/main/db.js:460](E:/Mac/AtomNano/src/main/db.js:460), [src/main/db.js:946](E:/Mac/AtomNano/src/main/db.js:946), [src/main/db.js:954](E:/Mac/AtomNano/src/main/db.js:954), [src/main/db-io.js:213](E:/Mac/AtomNano/src/main/db-io.js:213), [src/renderer/dbm.js:943](E:/Mac/AtomNano/src/renderer/dbm.js:943).

**Evidence and impact.** Large binary values become a <binary N bytes> string used by export; small blobs become hex display text. Mongo _id strings that look like 24-digit hex are converted to ObjectId, and strings such as true or a large integer are auto-parsed into different types. The renderer has no independent original type/value to restore.

**Fix.** Define a lossless typed cell/document wire contract with separate display text, canonical values, completeness and editability. Use BSON/EJSON-aware parsing with explicit type selection. Keep blobs as bytes or retrievable handles and refuse lossless export until missing data is fetched. Preserve date/time semantics rather than guessing from display strings.

**Acceptance.** Round-trip binary values above/below 64 bytes, actual ObjectIds versus identically spelled string IDs, dates, decimals, booleans, numeric-looking strings, NULL versus missing, nested objects and arrays. Verify row targeting and exported bytes.

Checks: DB-B23, DB-B28, DB-B29, DB-B43 in the linked evidence results.

### DB-018 — P1: Export ALL silently ends at two million rows

Applies to: All table exports.  
Source: [src/main/db-io.js:191](E:/Mac/AtomNano/src/main/db-io.js:191), [src/main/db-io.js:199](E:/Mac/AtomNano/src/main/db-io.js:199), [src/main/db-io.js:219](E:/Mac/AtomNano/src/main/db-io.js:219), [src/renderer/dbm.js:848](E:/Mac/AtomNano/src/renderer/dbm.js:848).

**Evidence and impact.** fetchAll stops at 2,000,000 rows even if additional pages exist. exportFile reports ok:true and the UI says Exported without an incomplete/truncated status. A recording source with endless full pages returned success after exactly 400 pages.

**Fix.** Remove the silent application ceiling by streaming/spooling export with user-controlled cancellation and honest progress. If a user-selected range/limit is used, record that scope in the result and artifact metadata. Report incomplete output distinctly; format/server limits must not be disguised as a complete export.

**Acceptance.** An export above two million rows either contains the complete requested dataset or ends with an explicit partial/cancelled/failed outcome and retained diagnostics. Never present a capped file as ALL.

Checks: DB-B42 in the linked evidence results.

### DB-019 — P2: Row edits and deletes update the UI without verifying the persisted result

Applies to: Browse editing.  
Source: [src/renderer/dbm.js:1073](E:/Mac/AtomNano/src/renderer/dbm.js:1073), [src/renderer/dbm.js:1085](E:/Mac/AtomNano/src/renderer/dbm.js:1085), [src/main/db.js:979](E:/Mac/AtomNano/src/main/db.js:979).

**Evidence and impact.** An update with affected:0 still replaces the displayed cell with the requested value. Delete removes local rows regardless of the affected count and does not resynchronize pagination totals. Values normalized by the server or triggers are never re-read. Concurrent edits have no row version or per-row queue.

**Fix.** Update UI from confirmed canonical server data. Treat no-match/conflict/error as distinct outcomes and keep the previous cell until resolved. Use optimistic concurrency where supported, serialize edits of the same row, and refresh totals after deletion. Do not infer Mongo no-match solely from modifiedCount: unchanged values can match without modification.

**Acceptance.** Test zero matched rows, unchanged values, concurrent external updates, server coercion/triggers and overlapping edits. The grid shows persisted values and cannot report a saved change that did not occur.

Checks: DB-U05 in the linked evidence results.

### DB-020 — P1: Several mutation buttons can submit duplicate writes

Applies to: Insert dialog and pending structure operations.  
Source: [src/renderer/dbm.js:1219](E:/Mac/AtomNano/src/renderer/dbm.js:1219), [src/renderer/dbm.js:1231](E:/Mac/AtomNano/src/renderer/dbm.js:1231), [src/renderer/dbm.js:1310](E:/Mac/AtomNano/src/renderer/dbm.js:1310).

**Evidence and impact.** The Insert button has no busy guard and remains active while the write is pending. Two quick clicks produced two insertRow calls. Pending structure Save similarly has no operation guard before asynchronous planning/execution.

**Fix.** Use a single operation state for each mutation form, set it before the first await and disable submission until terminal completion. Main should reject duplicate operation IDs and conflicting concurrent schema edits. Preserve a retryable form only when the prior outcome is known, especially after transport errors.

**Acceptance.** Double-click, Enter/click, slow IPC and rapid Save actions submit exactly once. A retry after an unknown commit outcome cannot blindly duplicate the mutation.

Checks: DB-U06 in the linked evidence results.

### DB-021 — P2: Connection creation and disposal have races and resource leaks

Applies to: All connection adapters.  
Source: [src/main/db.js:133](E:/Mac/AtomNano/src/main/db.js:133), [src/main/db.js:136](E:/Mac/AtomNano/src/main/db.js:136), [src/main/db.js:149](E:/Mac/AtomNano/src/main/db.js:149), [src/main/db.js:205](E:/Mac/AtomNano/src/main/db.js:205), [src/main/db.js:261](E:/Mac/AtomNano/src/main/db.js:261).

**Evidence and impact.** open caches only a completed handle, so simultaneous cold calls create multiple pools and overwrite one cache entry. Disconnect during open does not invalidate the eventual handle. Failed verification does not close the newly created pool/client. closeOne does not await asynchronous shutdown; test uses a shared __test__ identifier.

**Fix.** Track a per-profile/revision connection state containing the in-flight promise and a generation token. Close late/failed handles in finally, await drains, and invalidate generations on disconnect/remove/save. Give each unsaved test an isolated identity and always dispose it. Coordinate pool ownership with operation sessions rather than a single mutable cache entry.

**Acceptance.** Concurrent cold schema/query calls create one pool. Disconnect/remove during slow open leaves no live handle. Failed tests and repeated retries return connection counts to baseline; unsaved tests cannot share credentials or handles.

Checks: DB-B08, DB-B09, DB-B10 in the linked evidence results.

### DB-022 — P2: Health checks can undo disconnects and misclassify ordinary errors

Applies to: DBM connection status.  
Source: [src/renderer/dbm.js:391](E:/Mac/AtomNano/src/renderer/dbm.js:391), [src/renderer/dbm.js:428](E:/Mac/AtomNano/src/renderer/dbm.js:428), [src/renderer/dbm.js:436](E:/Mac/AtomNano/src/renderer/dbm.js:436), [src/renderer/dbm.js:749](E:/Mac/AtomNano/src/renderer/dbm.js:749), [src/renderer/dbm.js:1262](E:/Mac/AtomNano/src/renderer/dbm.js:1262).

**Evidence and impact.** checkHealth captures status before awaiting ping. A previously reconnecting connection can be set live after the user disconnects it. Schema/structure errors generally become reconnecting even when they are permissions or unsupported-feature failures; health checks do not consistently apply AUTH_ERR. Toolbar and sidebar disconnect update different sets of tabs. Health polling is sequential across profiles.

**Fix.** Use backend connection revisions and explicit desired state, and ignore results from an obsolete revision/disconnect generation. Return typed authentication/transport/query/metadata errors. Update all views of a connection from one status subscription. Schedule independent health checks without allowing one stalled profile to block the rest.

**Acceptance.** Disconnect during ping remains disconnected; authentication and catalog-permission errors do not enter indefinite reconnect loops. Two tabs/windows agree on status, and a stalled server does not delay health results for another.

Checks: DB-U11 in the linked evidence results.

### DB-023 — P2: Cancelling profile edits does not restore the original renderer policy

Applies to: Connection form.  
Source: [src/renderer/dbm.js:649](E:/Mac/AtomNano/src/renderer/dbm.js:649), [src/renderer/dbm.js:686](E:/Mac/AtomNano/src/renderer/dbm.js:686), [src/renderer/dbm.js:710](E:/Mac/AtomNano/src/renderer/dbm.js:710), [src/renderer/dbm.js:727](E:/Mac/AtomNano/src/renderer/dbm.js:727).

**Evidence and impact.** Object.assign makes a shallow draft, so c.policy still aliases the saved connection object's policy in renderer memory. Toggling a protection and pressing Cancel leaves the renderer changed while main's saved policy is unchanged. Save also retains old tabs' current object, query draft and pending state while changing their connection configuration.

**Fix.** Deep-clone validated profile drafts and apply them only after a successful, revision-checked save. On target/engine changes, explicitly reconcile dependent tabs and cached object/key metadata; keep historical drafts labelled with their original target. Cancel must have no effect on live/saved configuration.

**Acceptance.** Edit/cancel every policy field and connection target; renderer/main profiles remain identical. After a real target change, old object metadata and pending mutations cannot silently apply to the new database.

Checks: DB-U09 in the linked evidence results.

### DB-024 — P1: A later query failure hides earlier successful writes and results

Applies to: Multi-statement query UI.  
Source: [src/renderer/dbm.js:814](E:/Mac/AtomNano/src/renderer/dbm.js:814), [src/renderer/dbm.js:819](E:/Mac/AtomNano/src/renderer/dbm.js:819), [src/renderer/dbm.js:830](E:/Mac/AtomNano/src/renderer/dbm.js:830).

**Evidence and impact.** runQuery collects all results before rendering or logging any success. If statement two fails, statement one's committed write/result is discarded from the UI and only the whole script gets a failure entry. This obscures partial completion and encourages rerunning already committed work.

**Fix.** Create a visible statement record before execution and append each result immediately on completion, with pending/running/succeeded/failed/not-run/unknown states. Preserve prior results after failure. Show transaction versus autocommit behavior and offer resume only from a reviewed, known-safe position.

**Acceptance.** Run success → failure → unsubmitted statement. The first result and affected rows remain visible, the exact failure is identified, and the last statement is labelled not run. Reload/reopen must retain any operation outcome needed to avoid duplicate writes.

Checks: DB-U08 in the linked evidence results.

### DB-025 — P2: Oracle Test connection uses a method that the installed pool does not provide

Applies to: Oracle.  
Source: [src/main/db.js:165](E:/Mac/AtomNano/src/main/db.js:165), [src/main/db.js:271](E:/Mac/AtomNano/src/main/db.js:271), [src/main/db.js:778](E:/Mac/AtomNano/src/main/db.js:778).

**Evidence and impact.** open returns an Oracle Pool, but test calls e.handle.execute. The installed node-oracledb Pool has no execute method. The separate ping path correctly checks out a connection, so Test can fail even when normal operations can connect. [node-oracledb Pool API](https://node-oracledb.readthedocs.io/en/latest/api_manual/pool.html) exposes getConnection rather than execute.

**Fix.** Share a tested adapter ping implementation between test and health checks. For Oracle, acquire a connection, execute the ping, and await release in finally. Preserve the original connect/ping error instead of turning API misuse into an authentication-looking failure.

**Acceptance.** Oracle Test, Save & connect and health ping agree for valid credentials, invalid credentials, bad service names and unavailable servers; no test pool remains cached.

Checks: DB-B12 in the linked evidence results.

### DB-026 — P2: SQLite dispatch assumes the first keyword determines whether rows are returned

Applies to: SQLite.  
Source: [src/main/db.js:574](E:/Mac/AtomNano/src/main/db.js:574).

**Evidence and impact.** Every WITH/PRAGMA is prepared as a reader and passed to all(). A non-row PRAGMA such as foreign_keys = ON throws. A WITH ... INSERT is first rewritten with a row cap and then misclassified. Returning DML and commented statements also need reader-aware handling rather than keyword assumptions. A focused installed-driver probe confirmed INSERT ... RETURNING is a reader, yet run() commits the row and returns only changes/lastInsertRowid; the current query branch therefore discards its returned rows. [better-sqlite3 statement API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) documents reader metadata and statement execution methods.

**Fix.** Prepare the unmodified statement, use the driver's reader metadata to choose row iteration versus run, and explicitly handle multi-statement/transaction commands through the execution contract. Preserve rows from RETURNING and report changes separately. Do not automatically mutate SQLite durability/journal settings merely to test a connection.

**Acceptance.** Cover read/write PRAGMAs, SELECT/VALUES/EXPLAIN, CTE SELECT and CTE DML, RETURNING, comments and transactions against actual better-sqlite3 under Electron.

Checks: DB-B25 in the linked evidence results.

### DB-027 — P2: Regex SELECT caps alter valid SQL and conceal incomplete results

Applies to: All SQL query adapters.  
Source: [src/main/db.js:473](E:/Mac/AtomNano/src/main/db.js:473), [src/main/db.js:521](E:/Mac/AtomNano/src/main/db.js:521), [src/renderer/dbm.js:772](E:/Mac/AtomNano/src/renderer/dbm.js:772), [src/renderer/dbm.js:883](E:/Mac/AtomNano/src/renderer/dbm.js:883).

**Evidence and impact.** capSelect treats every WITH as a SELECT and can append LIMIT to PostgreSQL UPDATE. LIMIT-like text anywhere, including a literal or nested query, suppresses capping; SQL Server CTEs are left uncapped. A bare SELECT capped to two rows reports rowCount:2 and truncated:false even when three rows exist.

**Fix.** Separate user SQL from presentation/fetch policy. Prefer driver cursors or explicit browse-generated SQL; preserve arbitrary SQL exactly. If a supported query is wrapped for preview, use a real dialect parser and show the effective query/scope. Fetch a continuation indicator and expose hasMore/completeness independently from returnedRows. Make preview size a visible preference.

**Acceptance.** CTE writes, nested limits, comments, quoted keywords and SQL Server CTEs execute with unchanged semantics. A limited preview never claims to represent every matching row.

Checks: DB-B26, DB-B27 in the linked evidence results.

### DB-028 — P2: Result normalization collapses duplicate columns and additional result sets

Applies to: SQL drivers, query export/copy.  
Source: [src/main/db.js:435](E:/Mac/AtomNano/src/main/db.js:435), [src/main/db.js:532](E:/Mac/AtomNano/src/main/db.js:532), [src/main/db.js:586](E:/Mac/AtomNano/src/main/db.js:586), [src/renderer/dbm.js:86](E:/Mac/AtomNano/src/renderer/dbm.js:86), [src/main/db-io.js:214](E:/Mac/AtomNano/src/main/db-io.js:214).

**Evidence and impact.** shape stores column names in a Set and reads object properties by name. SELECT 1 AS x,2 AS x becomes one column containing 2. Object-based driver rows may already have lost duplicates before shaping. SQL Server reads only recordset, ignoring additional recordsets; PostgreSQL result arrays are not handled. JSON Object.fromEntries also overwrites duplicate names.

**Fix.** Use positional row results and stable column IDs with labels and type metadata. Represent every result set/command outcome explicitly and preserve ordering. Define an unambiguous JSON export format or require alias resolution instead of silently overwriting duplicate labels.

**Acceptance.** Joins with repeated names, unnamed/empty aliases, multiple result sets and procedures retain all columns and outcomes. CSV/JSON/XLSX exports preserve the same data seen by the driver.

Checks: DB-B22 in the linked evidence results.

### DB-029 — P2: Worker normalization changes binary values when results cross 2000 rows

Applies to: MySQL, PostgreSQL, SQL Server shapeAsync.  
Source: [src/main/db.js:443](E:/Mac/AtomNano/src/main/db.js:443), [src/main/db-worker.js:5](E:/Mac/AtomNano/src/main/db-worker.js:5).

**Evidence and impact.** Sending Buffers through workerData structured clone produces Uint8Array values. db-worker only recognizes Buffer; a short binary cell is 0x0102 below the threshold and a JSON object of numeric byte properties above it. The two copies of cell/shape can also drift over time.

**Fix.** Normalize typed values through one shared, structured-clone-safe wire contract. Handle ArrayBuffer views explicitly and avoid cloning entire results solely for formatting. Use a persistent worker/stream where justified, with identical adapter behavior in every size range.

**Acceptance.** Compare identical typed rows at 0, 2000, 2001 and larger counts. Values, metadata, errors and export bytes are identical across worker and direct paths.

Checks: DB-B24 in the linked evidence results.

### DB-030 — P1: Generated mutations interpolate untyped SQL literals

Applies to: SQL row editing, DDL defaults and SQL imports.  
Source: [src/main/db.js:242](E:/Mac/AtomNano/src/main/db.js:242), [src/main/db.js:962](E:/Mac/AtomNano/src/main/db.js:962), [src/main/db.js:974](E:/Mac/AtomNano/src/main/db.js:974), [src/main/db-io.js:284](E:/Mac/AtomNano/src/main/db-io.js:284).

**Evidence and impact.** Row updates/inserts/imports concatenate literal strings instead of using bound values. SQL Server Unicode strings are emitted without N or typed bindings; date/time, binary and numeric semantics rely on server implicit conversion. MySQL backslash doubling assumes a particular SQL mode. Raw expressions and data values share the same helper. This is a contract/source finding; no live SQL Server or MySQL data-loss claim was tested. [SQL Server constants](https://learn.microsoft.com/en-us/sql/t-sql/data-types/constants-transact-sql?view=sql-server-ver17) distinguish Unicode from ordinary character constants.

**Fix.** Use adapter-specific prepared/bound parameters for all generated data mutations and bind exact database types where required. Keep identifiers structurally quoted and raw expressions explicit, separately validated and excluded from row identities. SQL export must use a dialect-aware literal serializer that preserves Unicode/binary/date semantics.

**Acceptance.** Round-trip non-codepage Unicode into SQL Server NVARCHAR, MySQL strings under both backslash modes, NUL/quotes, binary, decimals and timestamp/time-zone types. Generated values cannot change a WHERE predicate.

Verification: source/contract review; execute the acceptance fixture before closing this finding.

### DB-031 — P2: Oracle LOB query values are never fetched as their actual content

Applies to: Oracle.  
Source: [src/main/db.js:460](E:/Mac/AtomNano/src/main/db.js:460), [src/main/db.js:546](E:/Mac/AtomNano/src/main/db.js:546), [src/main/db.js:549](E:/Mac/AtomNano/src/main/db.js:549).

**Evidence and impact.** Oracle queries use default LOB fetching but cell() serializes generic objects and the connection is released in finally. CLOB/BLOB/NCLOB values can therefore become Lob object representations instead of their contents, without a fetch/read handle for the grid or export. tableInfo has a special DDL fetch conversion but ordinary queries do not. [node-oracledb LOB handling](https://node-oracledb.readthedocs.io/en/latest/user_guide/lob_data.html) returns Lob instances by default and requires explicit consumption.

**Fix.** Define LOB retrieval in the Oracle adapter: explicit small-value fetch conversion or streamed, cancellable handles backed by the correct connection lifetime. Show size/type/completeness in the UI and fetch actual contents for copy/export. Close/destroy every LOB and release its connection after consumption.

**Acceptance.** Browse/view/export small and large CLOB, NCLOB and BLOB values, including multibyte text and cancellation midstream. No object dump is presented as database content and no pool connection leaks.

Verification: source/contract review; execute the acceptance fixture before closing this finding.

### DB-032 — P2: Paging uses unstable order and treats estimates as navigation bounds

Applies to: Browse and ALL export.  
Source: [src/main/db.js:927](E:/Mac/AtomNano/src/main/db.js:927), [src/main/db.js:933](E:/Mac/AtomNano/src/main/db.js:933), [src/main/db-io.js:191](E:/Mac/AtomNano/src/main/db-io.js:191), [src/renderer/dbm.js:1007](E:/Mac/AtomNano/src/renderer/dbm.js:1007), [src/renderer/dbm.js:1013](E:/Mac/AtomNano/src/renderer/dbm.js:1013).

**Evidence and impact.** Browse/export default to OFFSET without a deterministic unique order; SQL Server explicitly orders by (SELECT NULL). Sorting a nonunique column has no key tie-breaker or snapshot. Concurrent changes can duplicate/omit exported rows. In the UI, an estimated zero-row count clamps Next to page one even when a full page is present; the button remains enabled. [PostgreSQL LIMIT/OFFSET behavior](https://www.postgresql.org/docs/current/queries-limit.html) explains why pagination needs a predictable unique order.

**Fix.** Keep estimated counts advisory only. Default browse to a known stable unique order, add unique tie-breakers and use cursor/keyset pagination where possible. For a complete export use an engine-supported consistent snapshot/cursor and declare consistency guarantees when unavailable. Keep exact counts separate from estimates.

**Acceptance.** Stale zero/low estimates never block reaching actual rows. Page/export a table with duplicate sort values while rows change; validate the selected consistency mode and report any limitations.

Checks: DB-U04 in the linked evidence results.

### DB-033 — P2: Import row counts hide partial commits and cap error details

Applies to: Oracle, MongoDB; all imports for error reporting.  
Source: [src/main/db-io.js:259](E:/Mac/AtomNano/src/main/db-io.js:259), [src/main/db-io.js:283](E:/Mac/AtomNano/src/main/db-io.js:283), [src/main/db-io.js:286](E:/Mac/AtomNano/src/main/db-io.js:286), [src/main/db-io.js:294](E:/Mac/AtomNano/src/main/db-io.js:294), [src/renderer/dbm.js:1114](E:/Mac/AtomNano/src/renderer/dbm.js:1114).

**Evidence and impact.** Oracle inserts individual rows inside a batch but increments inserted only after the whole batch succeeds; one committed row followed by an error is reported as zero inserted. Mongo ordered insertMany can also partially succeed before throwing. Errors are sliced to 50, and the UI uses that truncated array length as the error count.

**Fix.** Return committed, attempted, failed, unattempted and unknown counts separately using driver bulk-write results and transaction outcomes. Preserve exact source row/statement locations. Keep a full downloadable error artifact while rendering a bounded view, and expose totalErrors independently from displayed errors.

**Acceptance.** Fail after row one of an Oracle batch and midway through Mongo insertMany; counts match actual committed data. More than 50 failures still report the correct total and remain inspectable.

Checks: DB-B38 in the linked evidence results.

### DB-034 — P2: Import tokens lack expiry enforcement, ownership and a consumed/running state

Applies to: Import IPC.  
Source: [src/main/db-io.js:223](E:/Mac/AtomNano/src/main/db-io.js:223), [src/main/db-io.js:237](E:/Mac/AtomNano/src/main/db-io.js:237), [src/main/db-io.js:248](E:/Mac/AtomNano/src/main/db-io.js:248), [src/main/db-io.js:251](E:/Mac/AtomNano/src/main/db-io.js:251), [src/main/main.js:772](E:/Mac/AtomNano/src/main/main.js:772).

**Evidence and impact.** Expiry is checked only during the next importPick sweep. importRun accepts an expired token and two concurrent runs can consume the same token twice. Tokens are not bound to the originating window, connection revision or target. Parsed data can remain retained after dialog close because cleanup is not universal.

**Fix.** Use cryptographically unique operation handles bound to sender, connection revision and approved import plan. Atomically transition picked → running → terminal, validate expiry at use, and reject duplicate runs. Add deterministic cleanup on cancel/close/expiry and keep necessary outcome metadata separately from parsed payload buffers.

**Acceptance.** Expired, wrong-window, changed-target and already-running tokens are rejected before any write. Concurrent replay executes once, and closed previews release their retained data.

Checks: DB-B36, DB-B37 in the linked evidence results.

### DB-035 — P2: Import batch size ignores engine-specific statement limits

Applies to: SQL Server; MySQL/SQLite/Oracle need capability-aware batching.  
Source: [src/main/db-io.js:278](E:/Mac/AtomNano/src/main/db-io.js:278), [src/main/db-io.js:285](E:/Mac/AtomNano/src/main/db-io.js:285), [src/renderer/dbm.js:1143](E:/Mac/AtomNano/src/renderer/dbm.js:1143).

**Evidence and impact.** The form/backend permit batches of 2000 rows and emit one multi-row VALUES statement. SQL Server limits a direct INSERT ... VALUES constructor to 1000 rows. Batch sizing also ignores statement bytes/packet size and future bound-parameter limits. [SQL Server table value constructor limits](https://learn.microsoft.com/en-us/sql/t-sql/queries/table-value-constructor-transact-sql?view=sql-server-ver17) specify the 1000-row direct INSERT limit.

**Fix.** Have each adapter choose a bulk API or split batches by its supported row, parameter and byte limits. Keep user batch preference distinct from driver constraints. Preserve source-row offsets and atomicity/accounting when splitting. Avoid silently changing data scope to fit a limit.

**Acceptance.** A 2000-row SQL Server import succeeds through supported batches or bulk insert. Wide rows, long strings and low packet/parameter limits split safely and report precise errors.

Checks: DB-B39 in the linked evidence results.

### DB-036 — P2: CSV parsing silently drops valid empty rows and accepts malformed input

Applies to: CSV/TSV/text import and CSV export.  
Source: [src/main/db-io.js:145](E:/Mac/AtomNano/src/main/db-io.js:145), [src/main/db-io.js:159](E:/Mac/AtomNano/src/main/db-io.js:159), [src/main/db-io.js:161](E:/Mac/AtomNano/src/main/db-io.js:161), [src/main/db-io.js:242](E:/Mac/AtomNano/src/main/db-io.js:242).

**Evidence and impact.** A one-column quoted empty record is removed by the empty-row filter. The parser does not reject an unterminated quoted field. CSV export uses the same empty representation for NULL and empty string; import defaults empty cells to NULL, so those values cannot round-trip distinctly. Text files are always read as UTF-8 without an encoding selection.

**Fix.** Use a tested delimited-text parser with explicit dialect/encoding/header/null options and precise malformed-record errors. Preserve quoted empty records and distinguish skipped blank lines from data. Make any lossy NULL/empty conversion a visible mapping choice with a preview; define escaping for spreadsheet formula-like values as an export option.

**Acceptance.** Test one-column empty records, trailing delimiters, CRLF/CR, embedded delimiters/newlines/quotes, BOMs, UTF-16 input, malformed quotes and NULL versus empty string. Compare source/inserted record counts before mutation.

Checks: DB-B46, DB-B53 in the linked evidence results.

### DB-037 — P2: The XLSX codec silently changes dates and truncates long text

Applies to: Excel import/export.  
Source: [src/main/db-io.js:79](E:/Mac/AtomNano/src/main/db-io.js:79), [src/main/db-io.js:85](E:/Mac/AtomNano/src/main/db-io.js:85), [src/main/db-io.js:103](E:/Mac/AtomNano/src/main/db-io.js:103), [src/main/db-io.js:109](E:/Mac/AtomNano/src/main/db-io.js:109), [src/main/db-io.js:135](E:/Mac/AtomNano/src/main/db-io.js:135).

**Evidence and impact.** xlsxRead assumes the 1900 date system and ignores workbook date1904; a synthetic 1904 workbook imports serial 1 as 1899-12-31 rather than 1904-01-02. xlsxWrite silently slices strings to 32767 characters. Numeric cells use Number, formula error cells become null, and only the first sheet is read. Basic values do round-trip in the positive control.

**Fix.** Use a maintained OOXML parser/writer with explicit worksheet selection, date-system/style handling, cached-formula/error policy and lossless numeric/text conversion where representable. Validate workbook row/column/cell limits before export; offer an appropriate alternative format or explicit partial outcome instead of silently truncating.

**Acceptance.** Import 1900/1904 workbooks, dates/times, errors/formulas, shared/inline strings, multiple sheets and long numeric identifiers. Export oversized text/row counts with an explicit result; no date or cell content changes without a selected conversion.

Checks: DB-B44, DB-B45, DB-B53 in the linked evidence results.

### DB-038 — P2: Import/export processing blocks main and has unbounded expansion/allocation paths

Applies to: All I/O formats, especially XLSX.  
Source: [src/main/db-io.js:31](E:/Mac/AtomNano/src/main/db-io.js:31), [src/main/db-io.js:55](E:/Mac/AtomNano/src/main/db-io.js:55), [src/main/db-io.js:191](E:/Mac/AtomNano/src/main/db-io.js:191), [src/main/db-io.js:212](E:/Mac/AtomNano/src/main/db-io.js:212), [src/main/db-io.js:232](E:/Mac/AtomNano/src/main/db-io.js:232).

**Evidence and impact.** Files are loaded wholly into memory, expanded synchronously with inflateRawSync, parsed synchronously, and rows are padded to the widest record. Export accumulates all rows and complete CSV/JSON/XML/ZIP output before writing. The 512 MB compressed/input check does not bound expanded XLSX content or sparse column indices. ZIP CRC, entry bounds and unsupported compression handling are incomplete. No filesystem extraction occurs, so this finding is not a Zip Slip claim.

**Fix.** Move parsing/compression and SQLite/file work off Electron main; stream/spool rows with backpressure. Validate archive structure/CRC and bound decompressed bytes, entry counts and sheet dimensions according to the selected operation/resource policy. Reject unsupported encodings/compression explicitly. Write to a temporary export artifact and finalize only on a verified terminal outcome.

**Acceptance.** Large files remain cancellable and the UI stays responsive. Corrupt archives, high-expansion inputs and extreme column references fail deterministically without exhausting memory. A failed export cannot masquerade as a complete replacement file.

Verification: source/contract review; execute the acceptance fixture before closing this finding.

### DB-039 — P2: Queries have no cancellation or incremental result protocol

Applies to: All; main-thread blocking is direct for SQLite.  
Source: [src/main/db.js:443](E:/Mac/AtomNano/src/main/db.js:443), [src/main/db.js:563](E:/Mac/AtomNano/src/main/db.js:563), [src/main/db.js:574](E:/Mac/AtomNano/src/main/db.js:574), [src/main/db.js:611](E:/Mac/AtomNano/src/main/db.js:611), [src/main/main.js:762](E:/Mac/AtomNano/src/main/main.js:762), [src/renderer/dbm.js:800](E:/Mac/AtomNano/src/renderer/dbm.js:800).

**Evidence and impact.** The IPC contract returns only a completed result; no cancel API or operation stream exists. SQLite prepare/all/run executes synchronously in Electron main. Mongo aggregate/distinct and uncapped SQL paths materialize results before display shaping. New workers only format large results after retrieval. Multiple parallelQuery requests have no application scheduler. The UI row virtualization itself worked: 5000×100 data rendered 18 rows/1818 cells in one 12.4 ms fixture frame; this is not a sustained performance benchmark.

**Fix.** Add operation IDs, cancellation acknowledgement and incremental schema/row/result/error events with sequence numbers and bounded queues. Use driver cursors/stream APIs and a dedicated SQLite worker/process. Schedule main-process work fairly, append UI rows in frame-sized batches and preserve stable column/row identity and scroll state. Show queue/run/fetch/render phases separately.

**Acceptance.** Run a long query, a large result and a stalled query while interacting with other tabs/chat. Stop remains usable; progress is visible before completion; memory is bounded by backpressure; p95 frame/long-task measurements are captured on agreed fixtures.

Checks: DB-U19 in the linked evidence results.

### DB-040 — P2: Pending schema changes have inconsistent plans and lose failed work

Applies to: Structure editor.  
Source: [src/renderer/dbm.js:1268](E:/Mac/AtomNano/src/renderer/dbm.js:1268), [src/renderer/dbm.js:1291](E:/Mac/AtomNano/src/renderer/dbm.js:1291), [src/renderer/dbm.js:1300](E:/Mac/AtomNano/src/renderer/dbm.js:1300), [src/renderer/dbm.js:1310](E:/Mac/AtomNano/src/renderer/dbm.js:1310), [src/main/db.js:665](E:/Mac/AtomNano/src/main/db.js:665).

**Evidence and impact.** Rename v→renamed followed by drop v still executes the old column name. Drop columns precede index drops that may be prerequisites. Reorder preview uses old names while execution uses renamed/filtered names. Mongo previews show SQL even though driver calls mutate documents. All pending work is cleared after any partial failure; switching tables or changing metadata length also resets it. Multi-step addColumn has no transaction around enum creation/alter/comment/index steps.

**Fix.** Create one backend-owned, revisioned schema plan with stable object IDs, dependency ordering and exact preview/execution parity. Resolve rename/drop conflicts before execution. Use transactions where supported and record committed steps where not. Preserve failed/unattempted steps for review and keep pending plans per object until saved or explicitly discarded.

**Acceptance.** Test rename+drop, drop-index+drop-column, rename+reorder, enum creation followed by failure and switching objects. Preview matches actual operations; successful, failed and unattempted steps remain accurately represented.

Checks: DB-U14, DB-U15 in the linked evidence results.

### DB-041 — P2: MySQL column reorder rebuilds incomplete column definitions

Applies to: MySQL/MariaDB.  
Source: [src/main/db.js:732](E:/Mac/AtomNano/src/main/db.js:732), [src/main/db.js:746](E:/Mac/AtomNano/src/main/db.js:746).

**Evidence and impact.** mysqlColumnDef reconstructs MODIFY COLUMN from SHOW FULL COLUMNS, which does not include a generated column's expression. It emits VIRTUAL GENERATED without AS (...), making reordering such a column invalid. The order validator checks length/membership but not uniqueness, so a duplicated column entry can pass validation.

**Fix.** Obtain complete authoritative column definitions, including generation expressions and all attributes, or explicitly reject columns that cannot be reconstructed losslessly. Validate that the requested order is an exact permutation of current column identities under the same schema revision. Do not synthesize destructive DDL from incomplete display metadata.

**Acceptance.** Reorder generated, auto-increment, collated, default-expression and ordinary columns in a disposable MySQL fixture and compare SHOW CREATE TABLE before/after. Duplicate/missing order entries are rejected before DDL.

Checks: DB-B32 in the linked evidence results.

### DB-042 — P2: Add-column type changes keep hidden parameters and misinterpret defaults

Applies to: Add-column form/builders.  
Source: [src/renderer/dbm.js:1429](E:/Mac/AtomNano/src/renderer/dbm.js:1429), [src/renderer/dbm.js:1460](E:/Mac/AtomNano/src/renderer/dbm.js:1460), [src/renderer/dbm.js:1468](E:/Mac/AtomNano/src/renderer/dbm.js:1468), [src/main/db.js:623](E:/Mac/AtomNano/src/main/db.js:623), [src/main/db.js:624](E:/Mac/AtomNano/src/main/db.js:624).

**Evidence and impact.** Changing numeric to text leaves precision/scale in hidden inputs, and collect still submits them; buildColumnType can produce text(10,2). The default suggestions include '', but defaultLit quotes that text again; the SQLite reproduction stored two quote characters rather than an empty value. Debounced previews can also complete out of order and re-enable Add after a newer edit.

**Fix.** Validate type-specific properties in main and clear/ignore inactive form fields. Represent defaults as explicit none/literal/expression/null variants, with type-aware UI. Bind every preview to an immutable form revision, invalidate Add immediately on edits and execute the exact validated revision shown in the preview.

**Acceptance.** Switch among length, precision, enum and custom types; hidden values never alter SQL. Test empty-string defaults, literal NULL versus null, quoted text, expression defaults and reversed preview response order.

Checks: DB-U16, DB-B33 in the linked evidence results.

### DB-043 — P2: Object identity and catalog metadata are lossy across schemas

Applies to: SQL schemas, foreign-key links, generated DDL.  
Source: [src/main/db.js:215](E:/Mac/AtomNano/src/main/db.js:215), [src/main/db.js:226](E:/Mac/AtomNano/src/main/db.js:226), [src/main/db.js:320](E:/Mac/AtomNano/src/main/db.js:320), [src/main/db.js:384](E:/Mac/AtomNano/src/main/db.js:384), [src/main/db.js:805](E:/Mac/AtomNano/src/main/db.js:805), [src/main/db.js:828](E:/Mac/AtomNano/src/main/db.js:828), [src/renderer/dbm.js:1398](E:/Mac/AtomNano/src/renderer/dbm.js:1398).

**Evidence and impact.** Schema/table identity is flattened into one string and split at the first dot; valid dots in individual names become ambiguous. safeIdent trims legal leading/trailing spaces. Oracle metadata mostly reads user_* catalogs even when a qualified owner is passed. MySQL FK metadata omits referenced schema; renderer suffix matching can navigate to the wrong table. Synthesized DDL omits several constraints, expressions/index options and identity attributes, though it is correctly labelled approximate.

**Fix.** Use structured catalog/database/schema/object identifiers and ordinal column IDs throughout IPC and UI. Query owner-aware authoritative catalogs; preserve full FK targets and index definitions. Keep approximate DDL explicitly non-authoritative and provide native schema export/introspection when available. Do not use the approximation as migration input.

**Acceptance.** Test dots, spaces, quotes, mixed case, identical table names in different schemas, cross-schema FKs, generated/identity columns and expression/partial/include indexes. Navigation and mutation always resolve the selected object.

Checks: DB-B31 in the linked evidence results.

### DB-044 — P2: SQL export is offered without a valid target or engine dialect

Applies to: Query results, MongoDB, Redis.  
Source: [src/renderer/dbm.js:900](E:/Mac/AtomNano/src/renderer/dbm.js:900), [src/renderer/dbm.js:906](E:/Mac/AtomNano/src/renderer/dbm.js:906), [src/main/db-io.js:183](E:/Mac/AtomNano/src/main/db-io.js:183), [src/main/db-io.js:215](E:/Mac/AtomNano/src/main/db-io.js:215).

**Evidence and impact.** Query result exports do not pass a target table, so SQL INSERT export writes to the literal placeholder table. The same SQL export option is offered for MongoDB/Redis results, where generated SQL is not executable for that connection. A displayed current-object name is not proof that an arbitrary query result is insertable into that object.

**Fix.** Gate export formats by adapter capability and result provenance. Require an explicit target/mapping for SQL INSERT export of arbitrary query results and validate dialect/column compatibility. Use Mongo EJSON and suitable Redis-native/documented formats; label flat tabular exports as data extracts rather than backups.

**Acceptance.** Every offered export either produces a valid selected-engine artifact with a reviewed target or clearly states its data-extract purpose. Arbitrary joins/projections and NoSQL results cannot silently become INSERT INTO table.

Verification: source/contract review; execute the acceptance fixture before closing this finding.

### DB-045 — P2: Database-controlled names enter HTML and IPC has no DB-specific boundary validation

Applies to: DBM renderer and preload/main boundary.  
Source: [src/renderer/dbm.js:1023](E:/Mac/AtomNano/src/renderer/dbm.js:1023), [src/renderer/app.js:192](E:/Mac/AtomNano/src/renderer/app.js:192), [src/renderer/index.html:5](E:/Mac/AtomNano/src/renderer/index.html:5), [src/main/main.js:517](E:/Mac/AtomNano/src/main/main.js:517), [src/main/main.js:753](E:/Mac/AtomNano/src/main/main.js:753), [src/main/main.js:789](E:/Mac/AtomNano/src/main/main.js:789).

**Evidence and impact.** Browse interpolates it.name into an html property; a database object name containing a harmless <b> marker becomes DOM markup. Production CSP blocks inline scripts, so the reproduction establishes markup injection, not arbitrary code execution. DB handlers accept raw sender arguments without module-specific schemas/ownership checks, and the DBM window uses the full application preload.

**Fix.** Render database/user-derived values only as text nodes and retain a strict CSP. Validate DB IPC payloads, sender/frame ownership, connection revisions, finite integer ranges and typed mutation plans in main. Scope DB windows to a minimal required bridge and apply navigation/window-opening restrictions consistently. Use the shared type/details/code error envelope for DB-specific classifications and safe diagnostics, including adapter-specific state such as an unknown write outcome.

**Acceptance.** Adversarial object names remain literal text. Invalid payloads, unrelated sender/operation handles and stale revisions are rejected before driver calls. Real database values cannot create links/forms/frames inside the application UI.

Checks: DB-U17 in the linked evidence results.

### DB-046 — P2: All credentials are exposed to renderer lists and query history has no retention controls

Applies to: Saved profiles and query history.  
Source: [src/main/db.js:80](E:/Mac/AtomNano/src/main/db.js:80), [src/main/preload.js:83](E:/Mac/AtomNano/src/main/preload.js:83), [src/renderer/dbm.js:221](E:/Mac/AtomNano/src/renderer/dbm.js:221), [src/renderer/dbm.js:234](E:/Mac/AtomNano/src/renderer/dbm.js:234), [src/renderer/dbm.js:523](E:/Mac/AtomNano/src/renderer/dbm.js:523), [src/renderer/dbm.js:677](E:/Mac/AtomNano/src/renderer/dbm.js:677).

**Evidence and impact.** list returns decrypted passwords and complete connection URIs for every profile to any renderer with this bridge. URI fields use visible text. Query text is persisted verbatim in localStorage, including failed statements and any embedded sensitive literals; deleting a connection deliberately retains that history. There is no session-only/history-disable or retention/purge preference.

**Fix.** Return public profile metadata plus hasSecret/locked status. Support unchanged/replace/clear secret edits without exposing existing secret text by default; reveal only on explicit scoped request. Mask credential-bearing URIs in routine UI. Add query-history persistence/retention controls, a session-only mode and clear/purge options with accurate user-facing behavior.

**Acceptance.** Routine list/status/open operations contain no secret values. Editing a nonsecret field retains its secret. Disabled history persists no statements, and profile deletion follows the selected history-retention choice.

Checks: DB-B06 in the linked evidence results.

### DB-047 — P2: Driver installation mutates the application tree without a verified lifecycle

Applies to: On-demand driver installation.  
Source: [src/main/db.js:94](E:/Mac/AtomNano/src/main/db.js:94), [src/main/db.js:112](E:/Mac/AtomNano/src/main/db.js:112), [src/main/db.js:123](E:/Mac/AtomNano/src/main/db.js:123), [src/renderer/dbm.js:249](E:/Mac/AtomNano/src/renderer/dbm.js:249), [package.json:35](E:/Mac/AtomNano/package.json:35), [electron-builder.yml:12](E:/Mac/AtomNano/electron-builder.yml:12).

**Evidence and impact.** installDriver runs npm i in appRoot without a shared installer lock, pinned requested version, rollback or post-install load verification. Missing/failed Electron rebuild can return ok:true. driverInstalled checks resolution, not runtime loading, and loadDriver conflates load errors with absence. All seven drivers are already production dependencies despite comments claiming optional shipment. This checkout's actual SQLite Electron ABI check passed; the finding concerns failure/update handling, not a demonstrated ABI failure.

**Fix.** Choose one supported packaging/install strategy. Prefer shipped, versioned drivers or an isolated managed driver directory; serialize installs and verify load/ABI before reporting ready. Preserve accurate missing/incompatible/install-failed states, record versions and require restart/reload only when actually needed. Keep application dependencies and loaded connections consistent during updates.

**Acceptance.** Test missing npm, unwritable install location, offline install, concurrent requests, corrupt driver, native rebuild failure and successful upgrade/rollback in a packaged fixture. Success requires a real load check under Electron.

Verification: source/contract review; execute the acceptance fixture before closing this finding.

### DB-048 — P2: The virtual grid is mouse-dependent and some text has low contrast

Applies to: DBM UI.  
Source: [src/renderer/dbm.js:145](E:/Mac/AtomNano/src/renderer/dbm.js:145), [src/renderer/dbm.js:152](E:/Mac/AtomNano/src/renderer/dbm.js:152), [src/renderer/dbm.js:174](E:/Mac/AtomNano/src/renderer/dbm.js:174), [src/renderer/styles.css:19](E:/Mac/AtomNano/src/renderer/styles.css:19), [src/renderer/styles.css:2381](E:/Mac/AtomNano/src/renderer/styles.css:2381), [src/renderer/styles.css:2402](E:/Mac/AtomNano/src/renderer/styles.css:2402), [src/renderer/styles.css:2491](E:/Mac/AtomNano/src/renderer/styles.css:2491).

**Evidence and impact.** The result grid uses generic divs without table/grid/header/cell semantics, focusable cells or keyboard editing/sorting/navigation. Its outer focus outline is removed. Default execution-log metadata uses #857769 on #312d2c at about 11.5px: calculated contrast 3.138:1. This explains faint status/log text, although ordinary data cells use a brighter text token. [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) gives a 4.5:1 threshold for ordinary essential text.

**Fix.** Add accessible grid semantics with stable row/column indices, focus management and keyboard equivalents for inspect/copy/edit/sort/context actions. Preserve focus across virtualization and dialogs. Raise essential text contrast and avoid opacity/color-only status communication; test all shipped themes and zoom/font settings.

**Acceptance.** Complete browse, inspect, edit, cancel, sort and export flows using keyboard/screen reader. Small essential text meets the agreed contrast target; focus remains visible and is restored after dialogs.

Checks: DB-U18 in the linked evidence results.

### DB-049 — P2: Tab/window lifecycle does not protect drafts or release module resources

Applies to: DBM workspace.  
Source: [src/renderer/dbm.js:296](E:/Mac/AtomNano/src/renderer/dbm.js:296), [src/renderer/dbm.js:304](E:/Mac/AtomNano/src/renderer/dbm.js:304), [src/renderer/dbm.js:415](E:/Mac/AtomNano/src/renderer/dbm.js:415), [src/renderer/dbm.js:841](E:/Mac/AtomNano/src/renderer/dbm.js:841), [src/renderer/dbm.js:1548](E:/Mac/AtomNano/src/renderer/dbm.js:1548), [src/renderer/app.js:441](E:/Mac/AtomNano/src/renderer/app.js:441), [src/main/main.js:785](E:/Mac/AtomNano/src/main/main.js:785).

**Evidence and impact.** Plain Open creates another tab whenever the current tab already has a connection, despite the Ctrl+Click distinction. Closing tabs/windows has no draft/pending-operation review; connection handles remain in main until explicit disconnect/app quit. DBM auto-opens the first saved profile, and initial render/open can request schema twice. mount installs timers/listeners/progress subscriptions without returning disposal hooks. No persistent query draft/session restoration exists.

**Fix.** Define tab identity and reuse semantics; reserve explicit New tab for duplication. Persist/restorable drafts separately from executed history and retain per-object pending plans. Provide a module disposer and reference-counted/operation-aware connection ownership across windows. Make auto-connect an explicit preference and coalesce schema loads.

**Acceptance.** Repeated normal Open reuses the intended tab; explicit New tab still works. Close/reopen recovers drafts according to preference, active jobs remain visible or are safely cancelled, and repeated mount/open/close does not grow handlers/pools.

Checks: DB-U10 in the linked evidence results.

### DB-050 — P2: Dismissed shared confirmation dialogs never resolve

Applies to: Delete/truncate confirmations, inline-edit blur decisions, import confirmation.  
Source: [src/renderer/app.js:407](E:/Mac/AtomNano/src/renderer/app.js:407), [src/renderer/app.js:416](E:/Mac/AtomNano/src/renderer/app.js:416), [src/renderer/app.js:3920](E:/Mac/AtomNano/src/renderer/app.js:3920), [src/renderer/dbm.js:264](E:/Mac/AtomNano/src/renderer/dbm.js:264), [src/renderer/dbm.js:954](E:/Mac/AtomNano/src/renderer/dbm.js:954).

**Evidence and impact.** chooseDialog resolves only from its choice buttons. X/backdrop removal leaves the Promise pending, so awaiting DB flows never finish their decision path. A grid redraw correctly preserved an edited value through the confirmation in the positive control; the problem is dismissal/lifecycle completion, not automatic loss on every redraw.

**Fix.** Make every modal close path resolve once with an explicit cancel/discard result and invoke cleanup. Add supported keyboard dismissal and focus restoration for the standalone DBM initialization path. Await mutation decisions and reconcile the cell/form after cancellation instead of retaining detached editor state.

**Acceptance.** X, backdrop, Cancel, Escape, parent-window close and ordinary confirm each settle once. No suspended operation, orphaned watcher or lost decision remains; inline edits return to their original confirmed value after discard.

Checks: DB-U12, DB-U13 in the linked evidence results.

### DB-051 — P1: Redis quoted keys can become multiple unintended mutation targets

Applies to: Redis query/templates and key context menu.  
Source: [src/main/db.js:487](E:/Mac/AtomNano/src/main/db.js:487), [src/main/db.js:593](E:/Mac/AtomNano/src/main/db.js:593), [src/renderer/dbm.js:43](E:/Mac/AtomNano/src/renderer/dbm.js:43), [src/renderer/dbm.js:601](E:/Mac/AtomNano/src/renderer/dbm.js:601).

**Evidence and impact.** The key context menu encodes a key with JSON.stringify, but splitCmd does not decode escaped quotes/backslashes. The confirmed key containing a quote and a space, a" b, becomes two arguments: a trailing-backslash key and b followed by a quote. Redis DEL accepts multiple keys, so confirming deletion of one key can target two different keys. Read templates and raw SET commands also fail to preserve exact arguments.

**Fix.** Pass structured argv and exact key bytes from object actions through IPC; do not round-trip object identity through shell-like text. For the command editor, implement a documented Redis-compatible quoting/escaping grammar or a structured argument mode and show parse errors before submission. Resolve policy checks against the final command/argument structure.

**Acceptance.** Round-trip empty keys and keys containing spaces, quotes, backslashes, Unicode and binary bytes. A confirmed single-key DEL reaches the driver with exactly one byte-identical key argument; unrelated similarly spelled keys remain untouched.

Checks: DB-B30 in the linked evidence results.

## Feature and improvement gaps

These are scoped additions for an implementation backlog. Raw queries already provide access to many server features; the gaps below concern safe, discoverable management workflows and capability contracts.

### G01 — Explicit connection modes and target identity

Sequence: After DB-001/002/006/007/016.  
Source: [src/main/db.js:30](E:/Mac/AtomNano/src/main/db.js:30), [src/renderer/dbm.js:649](E:/Mac/AtomNano/src/renderer/dbm.js:649).

Add visible production/development labels, explicit read-only versus read/write mode, database/host/account identity in mutation reviews, and optional session-only credentials. A policy checkbox alone is not a database permission boundary. Mongo/Redis URIs already carry many advanced options; avoid duplicating or discarding those options.

**Acceptance.** The selected host/database/user and allowed operation mode are visible before each mutating plan, and enforced by the adapter/session where supported.

### G02 — Advanced connection configuration and portable profiles

Sequence: After credential/TLS fixes.  
Source: [src/main/db.js:30](E:/Mac/AtomNano/src/main/db.js:30), [src/main/db.js:136](E:/Mac/AtomNano/src/main/db.js:136).

The host-based forms omit supported advanced options such as CA/client certificates, SSH tunnels, socket/service configuration and alternative authentication. Add capabilities selectively per engine. Support profile import/export with secrets excluded by default and an explicit secure migration path.

**Acceptance.** Profiles round-trip nonsecret configuration without losing engine options; credentials remain scoped and encrypted, and unsupported options receive a precise message.

### G03 — Native backup/restore and schema migration plans

Sequence: After data fidelity and atomic operation work.  
Source: [src/main/db-io.js:183](E:/Mac/AtomNano/src/main/db-io.js:183), [src/main/db.js:805](E:/Mac/AtomNano/src/main/db.js:805).

Current CSV/JSON/SQL INSERT/XLSX exports are data extracts, not complete database backups. They omit schema objects, constraints, sequences, indexes, grants and engine-specific state. Add native backup/restore integration or clearly scoped schema+data plans with target/compatibility review and retained results.

**Acceptance.** A disposable database restores with a verified object/data inventory, or the export is explicitly labelled as an incomplete data extract.

### G04 — First-class schema object management

Sequence: After DB-040/041/043.  
Source: [src/main/db.js:648](E:/Mac/AtomNano/src/main/db.js:648), [src/renderer/dbm.js:1240](E:/Mac/AtomNano/src/renderer/dbm.js:1240).

The UI covers column add/rename/drop/reorder and basic index add/drop, plus read-only foreign-key/DDL views. Creating/altering tables, foreign keys, checks, views, triggers, routines, partitions and advanced indexes generally requires raw queries. Add engine-specific editors only where exact metadata/preview/execution can be guaranteed.

**Acceptance.** Every exposed operation has an authoritative preview, dependency checks and engine-specific validation; unsupported operations stay clearly identified as manual-query tasks.

### G05 — SQL editor capabilities

Sequence: After DB-011/012/024/026/027.  
Source: [src/renderer/dbm.js:771](E:/Mac/AtomNano/src/renderer/dbm.js:771), [src/renderer/dbm.js:49](E:/Mac/AtomNano/src/renderer/dbm.js:49).

The editor is a textarea with lightweight formatting/history. Add dialect syntax support, schema-aware completion, error ranges, parameter bindings, reusable saved scripts and safe run-selection/current-statement/batch actions. INSERT templates currently contain '?' for every SQL engine but there is no parameter-entry/binding flow. Disable unsupported Explain actions, especially SQL Server, instead of recommending unreliable session commands.

**Acceptance.** A saved parameterized query runs on its declared dialect/connection revision, formatting preserves semantics, and error/result locations map to the original text.

### G06 — Complete MongoDB document workflows

Sequence: After DB-007/010/017/031/033.  
Source: [src/main/db.js:401](E:/Mac/AtomNano/src/main/db.js:401), [src/main/db.js:551](E:/Mac/AtomNano/src/main/db.js:551), [src/renderer/dbm.js:1163](E:/Mac/AtomNano/src/renderer/dbm.js:1163).

Add EJSON/BSON-aware document editing and import/export, nested-field editing, projection/sort/explain tools, explicit sampling completeness and collection validation/index options. The current sampled flat grid is not a full document schema. There is no JSON file import despite JSON export being offered.

**Acceptance.** ObjectId, string IDs, dates, decimal/long values, missing versus null and nested documents survive a full editing/export/import cycle.

### G07 — Complete Redis key discovery and editing

Sequence: After command parsing and policy/session fixes.  
Source: [src/main/db.js:345](E:/Mac/AtomNano/src/main/db.js:345), [src/main/db.js:487](E:/Mac/AtomNano/src/main/db.js:487), [src/renderer/dbm.js:20](E:/Mac/AtomNano/src/renderer/dbm.js:20).

The sidebar stops scanning around 1000 keys and filtering searches only that loaded subset. Add cursor continuation with deduplication and server-side MATCH, key TTL/memory inspection, safe rename/delete, and type-specific editors for hashes/lists/sets/sorted sets/streams. Preserve key bytes/escaping; the current splitCmd parser does not decode JSON escapes.

**Acceptance.** Keys beyond the first scan page and keys with spaces/quotes/backslashes are reachable and targetable. Expiry and concurrent key changes are handled without implying a complete snapshot.

### G08 — Durable operation history and diagnostics

Sequence: After DB-001/002/003/009/024/033.  
Source: [src/renderer/dbm.js:325](E:/Mac/AtomNano/src/renderer/dbm.js:325), [src/main/main.js:517](E:/Mac/AtomNano/src/main/main.js:517).

Add a redacted operation journal covering connection revision, statement/batch status, transaction state, affected/returned counts, timings and unknown outcomes. Expose active jobs after a dialog/window closes. Distinguish transient transport failures, credentials, policy, syntax, constraint and unsupported-feature errors using stable error codes.

**Acceptance.** After an error/restart, users can determine what committed, what did not run and what remains unknown without rerunning a script to discover its state.

### G09 — Browse and result usability beyond the current grid

Sequence: After row identity/data fidelity/paging fixes.  
Source: [src/renderer/dbm.js:136](E:/Mac/AtomNano/src/renderer/dbm.js:136), [src/renderer/dbm.js:963](E:/Mac/AtomNano/src/renderer/dbm.js:963), [src/renderer/dbm.js:990](E:/Mac/AtomNano/src/renderer/dbm.js:990).

Add column resizing/pinning/hiding and order preferences, multi-column stable sorting, explicit local-versus-server search, typed filters, bulk row review and retrievable large-cell details. Current automatic no-match search casts many columns and can trigger broad scans; missing column metadata can result in no effective server predicate. Preserve virtualization and add horizontal virtualization only when measurements justify it.

**Acceptance.** Search scope and completeness are visible; unsupported conversions fail explicitly; wide results and large cells remain usable without changing their actual data.

### G10 — A repeatable seven-engine release matrix

Sequence: Start with the first remediation wave.  
Source: [package.json:14](E:/Mac/AtomNano/package.json:14), [src/main/db.js:30](E:/Mac/AtomNano/src/main/db.js:30).

No dedicated existing DB regression suite was found in smoke-tests/package scripts. Add isolated real-engine integration jobs plus Electron UI tests using temporary profiles. This audit's characterization tests intentionally pass when current bugs reproduce; they must be converted into correct-behavior regressions as fixes land.

**Acceptance.** CI exercises all seven advertised adapters and packaged Windows/Electron loading, with failure injection for auth/TLS, timeout, cancellation, pool races, partial writes, typed data and imports/exports. Never run against saved user profiles.

## Limits, transformations and optimizations to change deliberately

The request to remove hidden caps/optimizations is relevant here. Preserve complete user data and original SQL. A small rendered page or a bounded work queue is compatible with an uncapped, user-directed operation; silently changing the SQL/result/export is not.

| Current behavior | Authority | Recommended change |
|---|---|---|
| Query defaults to 200 rows and clamps to 5000 | [src/main/db.js:521](E:/Mac/AtomNano/src/main/db.js:521), [src/renderer/dbm.js:772](E:/Mac/AtomNano/src/renderer/dbm.js:772) | Replace the silent SQL rewrite with explicit preview/fetch settings and continuation. Allow complete execution/export without claiming a limited preview is all rows. |
| Bare SELECT/CTE text receives LIMIT/FETCH/TOP through regex | [src/main/db.js:473](E:/Mac/AtomNano/src/main/db.js:473) | Preserve user SQL; use adapter fetch controls/cursors or parser-validated, clearly disclosed preview SQL. |
| Browse server cap 5000; page UI offers 50–2000 | [src/main/db.js:919](E:/Mac/AtomNano/src/main/db.js:919), [src/renderer/dbm.js:999](E:/Mac/AtomNano/src/renderer/dbm.js:999) | Treat this as page size, not data scope. Keep pagination complete and configurable, with stable ordering. |
| Oracle SELECT automatically receives PARALLEL(AUTO) | [src/main/db.js:453](E:/Mac/AtomNano/src/main/db.js:453), [src/main/db.js:543](E:/Mac/AtomNano/src/main/db.js:543) | Remove the injected hint. Only send hints actually supplied by the user or explicitly configured for that operation. |
| Oracle autoCommit:true on ordinary execute calls | [src/main/db.js:546](E:/Mac/AtomNano/src/main/db.js:546) | Replace with a visible transaction/session mode; never imply that a user's BEGIN/ROLLBACK batch is atomic while using forced per-call autocommit. |
| Pools sized to local CPU count; MySQL queueLimit:0 | [src/main/db.js:22](E:/Mac/AtomNano/src/main/db.js:22), [src/main/db.js:143](E:/Mac/AtomNano/src/main/db.js:143), [src/main/db.js:153](E:/Mac/AtomNano/src/main/db.js:153), [src/main/db.js:165](E:/Mac/AtomNano/src/main/db.js:165), [src/main/db.js:190](E:/Mac/AtomNano/src/main/db.js:190) | Use connection budgets based on server/session needs and an explicit scheduler. More local cores do not justify more database connections or unbounded queued requests. |
| SQLite opens missing files and applies WAL/NORMAL/cache/thread pragmas | [src/main/db.js:176](E:/Mac/AtomNano/src/main/db.js:176) | Separate Open existing from Create. Make journal/durability/tuning changes intentional; tests and read-only inspections must not rewrite file/database settings. |
| Results above 2000 rows start a new formatting worker | [src/main/db.js:443](E:/Mac/AtomNano/src/main/db.js:443) | Fix typed clone parity; use a measured worker/stream strategy rather than a result-size-dependent data representation. |
| Binary values above 64 bytes become display markers | [src/main/db.js:464](E:/Mac/AtomNano/src/main/db.js:464) | Keep a display preview only; retain or retrieve original bytes for editing/copy/export. |
| Mongo schema infers fields from the first 100 documents | [src/main/db.js:402](E:/Mac/AtomNano/src/main/db.js:402) | Label sample coverage and allow explicit broader discovery; never treat the sample as an authoritative document schema. |
| Redis sidebar stops around 1000 scanned keys | [src/main/db.js:348](E:/Mac/AtomNano/src/main/db.js:348) | Preserve/continue the cursor, deduplicate and support MATCH/search. Display the loaded subset separately from database key count. |
| ALL export uses 5000-row pages but stops at 2,000,000 rows | [src/main/db-io.js:191](E:/Mac/AtomNano/src/main/db-io.js:191) | Keep chunking/backpressure; remove the silent completeness ceiling. Retain explicit user-selected range limits only. |
| Import rejects files above 512 MB but expands XLSX synchronously without an expanded-size budget | [src/main/db-io.js:55](E:/Mac/AtomNano/src/main/db-io.js:55), [src/main/db-io.js:232](E:/Mac/AtomNano/src/main/db-io.js:232) | Support streaming/spooling for large legitimate files. Validate actual expanded work and provide configurable resource policy/cancellation rather than an arbitrary file-size-only check. |
| Import batch clamps to 2000; defaults 500, Oracle UI 200 | [src/main/db-io.js:278](E:/Mac/AtomNano/src/main/db-io.js:278), [src/renderer/dbm.js:1143](E:/Mac/AtomNano/src/renderer/dbm.js:1143) | Make batch preference explicit while honoring real engine parameter/packet/row constraints. Do not remove SQL Server's server-imposed VALUES limit. |
| Import error details retain only 50 entries in the result | [src/main/db-io.js:265](E:/Mac/AtomNano/src/main/db-io.js:265), [src/main/db-io.js:294](E:/Mac/AtomNano/src/main/db-io.js:294) | Keep a full error artifact and accurate total count; paginate the displayed details. |
| History keeps 50 queries, menu shows 25; log keeps 500 entries and renders 200 | [src/renderer/dbm.js:237](E:/Mac/AtomNano/src/renderer/dbm.js:237), [src/renderer/dbm.js:330](E:/Mac/AtomNano/src/renderer/dbm.js:330), [src/renderer/dbm.js:368](E:/Mac/AtomNano/src/renderer/dbm.js:368), [src/renderer/dbm.js:779](E:/Mac/AtomNano/src/renderer/dbm.js:779) | Separate configurable retention from visible page size. Preserve complete operation outcomes needed for reconciliation, with explicit privacy/retention controls. |
| XLSX text is sliced to 32767 characters | [src/main/db-io.js:85](E:/Mac/AtomNano/src/main/db-io.js:85) | Do not silently discard text. Report the format constraint and offer another format or an explicitly accepted conversion. |
| Lists/grids render only visible rows | [src/renderer/dbm.js:101](E:/Mac/AtomNano/src/renderer/dbm.js:101), [src/renderer/dbm.js:136](E:/Mac/AtomNano/src/renderer/dbm.js:136) | Retain this rendering technique. It does not justify dropping underlying data, changing SQL, or limiting a complete export. |

## UI behavior to aim for

| Before | After | Why |
|---|---|---|
| One Running placeholder until the whole script finishes | Stable statement rows with queued/running/fetching/completed/error/unknown states; append each result when ready | Makes partial completion and actual progress visible. |
| Closing a busy tab permits mutable state to be reused | Operation remains owned by its original connection revision; a close action detaches or explicitly cancels | Prevents writes reaching a different database. |
| Edit text is copied into the grid after a zero-row update | Keep original value until confirmed, show conflict/no-match, and display the server's canonical value | Avoids false success and incorrect follow-up row targeting. |
| Estimated count blocks Next | Estimates are advisory; returned-page state or a cursor drives navigation | Allows browsing tables with stale statistics. |
| ALL export always gets a success toast after the internal ceiling | Complete, partial, cancelled, failed and unknown outcomes are distinct | Makes exported files trustworthy. |
| Cancel closes an import while backend keeps writing | Job cancellation has acknowledgement; committed/unsubmitted rows remain visible | Aligns the control with its actual effect. |
| Small grey log/status metadata at roughly 3.14:1 contrast | Essential text has sufficient theme-specific contrast and a readable size | Addresses faint text without changing database content. |
| Generic div cells and invisible grid focus | Accessible grid semantics, visible focus and complete keyboard actions | Supports keyboard and assistive-technology workflows. |
| Form previews can describe old values or approximate DDL | Revision-bound exact operation preview with target identity | Makes approval/review correspond to the operation that actually runs. |
| History and drafts have mixed implicit retention | Explicit draft recovery, history privacy and operation-retention preferences | Preserves useful work without silently retaining sensitive queries. |

## Recommended implementation order

Start by preserving these source/evidence fingerprints and building disposable fixtures. The existing characterization assertions intentionally recognize bugs; convert each addressed case into an assertion for the corrected behavior, keeping its ID and a note of the previous reproduction.

1. **Operation ownership and mutation protection.** Address DB-001, DB-002, DB-003, DB-004, DB-005, DB-006, DB-007, DB-013, DB-020, DB-021, DB-022, DB-023, DB-024, DB-034, DB-051. Establish operation/connection revisions, exact row identity, retry classification, session ownership and terminal state before exposing more mutation actions. Where a complete correction is not yet available, disable the affected structured mutation with an explicit reason.
2. **Credential, IPC and driver lifecycle.** Address DB-014, DB-015, DB-016, DB-045, DB-046, DB-047. Make persistence atomic, secrets explicit, TLS verified, payloads validated and installation state accurate. This can use the operation revision contract from step 1.
3. **Lossless values and query semantics.** Address DB-011, DB-012, DB-017, DB-019, DB-025, DB-026, DB-027, DB-028, DB-029, DB-030, DB-031, DB-032. Implement the typed result/parameter contract, parser/driver dispatch, complete result sets, correct Oracle behavior and stable pagination. Carry exact key values through the whole path.
4. **Import/export correctness.** Address DB-008, DB-009, DB-010, DB-018, DB-033, DB-035, DB-036, DB-037, DB-038, DB-044. Use the typed values, owned sessions and operation cancellation from earlier steps. Validate mappings/formats, implement atomic/staged mutation where available, and preserve complete outcomes/errors.
5. **Schema plans, rendering and lifecycle polish.** Address DB-039, DB-040, DB-041, DB-042, DB-043, DB-048, DB-049, DB-050. Finish exact DDL plans, per-object drafts, accessible incremental rendering and deterministic disposal. Use measured performance criteria. Add G01–G10 capabilities only on these corrected contracts.

Do not make a large unrelated rewrite of the chat, agent or Git modules. Shared helpers such as dialogs/IPC/installation may need changes, but verify every caller affected by those shared changes. Keep audit/evidence artifacts out of distributable application packages when updating packaging rules.

## Implementation acceptance matrix

Each finding already has a focused acceptance check. The following cross-cutting scenarios define the module-level completion bar.

| Area | Required scenarios | Pass condition |
|---|---|---|
| Target ownership | Two profiles, two tabs/windows, connection edit, slow query, close/reopen during a batch | Every statement uses its captured target/session revision; no operation retargets. |
| Transactions | BEGIN/write/read/ROLLBACK and COMMIT, autocommit, temp objects, session settings, app/window close | State is owned, visible and isolated; rollback and release behavior is verified per engine. |
| Transport failures | Failure before submission, after submission, after commit, idle pool error, repeated disconnect | Safe reads retry only under policy; writes do not replay; main survives; unknown outcomes are retained. |
| Connection lifecycle | Concurrent cold opens, failed tests, save/remove while opening, manual disconnect during ping | No orphan handles, stale resurrection, secret sharing or inconsistent connection status. |
| Credential store | Failed writes, corrupt JSON, locked key store, enc:-prefixed password, nonsecret edit, migration | No plaintext fallback/false success/ciphertext destruction; recoverable, atomic persistence. |
| TLS/auth | Valid/invalid/expired/wrong-host certificates, CA configuration, credentials/service/db failures | Exact selected security mode is used and typed errors identify the failing layer. |
| Protection policies | Each flag alone/together, structured APIs, raw SQL/JSON/Redis, CTEs, commands, import and DDL | Every advertised protection is enforced in main; unsupported guarantees are not claimed. |
| Row identity | Composite/missing/NULL keys, >2^53 values, duplicate display labels, changed/deleted external rows | Single-row actions cannot touch another row or multiple rows; conflicts are explicit. |
| Typed values | Unicode, binary, decimal/bigint, date/time/timezone, JSON/BSON, string versus typed IDs, missing/null/empty | Canonical values survive driver → IPC → worker → grid → mutation/export. |
| Query language | Every SQL dialect, quotes/comments, routines/triggers/CTEs, parameters, RETURNING, result sets | Original semantics and every result are retained; unsupported scripts fail before partial submission. |
| Paging/search | Stale estimates, ties, concurrent data changes, high offsets, missing metadata, local/server search | Reachability, ordering, scope and consistency are accurate and visible. |
| Import | Empty-first, first/middle/last failure, partial bulk success, duplicate/cancel/expired token | Atomicity matches the selected mode and actual committed/failed/unsubmitted counts are reported. |
| Export | Exact page multiples, changing Mongo fields, >2M rows, large binary, interrupted write | No silent field loss/truncation; complete output or explicit partial/failed/cancelled result. |
| File formats | CSV edge cases/encoding, XLSX 1900/1904/multiple sheets/limits, SQL dumps, malformed archives | No silent row/value conversion or unbounded parsing; errors retain source locations. |
| Schema editing | Rename/drop/reorder combinations, dependencies, generated columns, preview races, partial DDL | Preview is exact, execution order is valid and unsuccessful work remains reviewable. |
| Rendering | Long query, many/wide/large-cell results, incremental arrival, focus/scroll, dialog close | No freezing or lost operation state; incremental results remain stable and accessible. |
| Accessibility | Keyboard/screen reader, focus restore, all themes, zoom/font sizes, contrast | Essential operations and status information are perceivable and operable without a mouse. |
| Installation/release | Actual packaged Windows build, every driver load, native ABI, failed/concurrent update | Accurate ready/error states, no dependency corruption and a repeatable verified release path. |

## Handoff instruction for the implementing AI

Implement this DB management backlog in the order above. Start with the P1 data/targeting/security failures and the shared operation, connection-session and typed-value contracts. Treat this Markdown as a review baseline, recheck source fingerprints before editing, and retain any unrelated user changes. Use complete implementations in source files; report changes by file and finding ID without pasting code into chat.

For every completed finding, record the affected files, the behavior change, the regression/real-engine tests run and any engine-specific limitation. Convert the corresponding characterization test from “bug reproduced” to “correct behavior asserted.” Do not claim a mocked driver test proves real server integration. Do not run tests against saved user profiles or live databases; use isolated fixtures and explicit temporary credentials.

Completion means the requested fixes are implemented, each accepted capability has truthful UI behavior, no hidden SQL/data transformation or silent export truncation remains, and the seven-engine/packaged Electron checks relevant to the changes have passed. Remaining feature additions should be listed separately from unresolved correctness findings.
