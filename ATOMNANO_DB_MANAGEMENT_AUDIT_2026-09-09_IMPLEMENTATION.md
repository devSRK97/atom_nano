# AtomNano — DB management audit implementation (2026-09-10)

Source baseline: `ATOMNANO_DB_MANAGEMENT_AUDIT_2026-09-09.md` (51 findings DB-001..DB-051, 10 gaps G01–G10).
Every finding below is implemented in source with a regression test that asserts the **corrected** behaviour
(the audit's characterization checks DB-Bxx / DB-Uxx were converted, keeping their IDs). No test runs against a
saved user profile or a live database: the backend suite stubs Electron with a temp `userData`, uses real
`better-sqlite3` on temp files and **fake drivers** for the six server engines; the UI suite loads the original
renderer module in headless Chromium with fixture IPC; the Electron smoke uses an isolated profile and a temp
SQLite file.

## Test commands

| Command | What it proves | Result |
|---|---|---|
| `node scripts/test-db.js` | Backend contracts (store, secrets, lifecycle, sessions, identity, policies, typed values, parser, import/export jobs, formats, schema plans) — 267 checks | 267 passed |
| `node scripts/test-db-ui.js` | Renderer behaviour against the real `dbm.js`, `styles.css`, `sqlscript.js` and the real dialog helpers — 23 checks (U01..U20 + extras) | 23 passed |
| `node smoke-tests/test-db-manager.js` (`npm run test:db-e2e`) | Real Electron, isolated profile: form → SQLite connection → statement-by-statement run → grid → browse/paging → inline edit persisted → structure → store on disk; no renderer errors | 14 passed |
| `node scripts/_xcheck-db-ipc.js` | Static: every `db.*`/`dbio.*` call in main.js exists; every preload `db:*` channel has a handler; every bridge method the renderer uses exists in preload | clean |
| `npm test` | audit 83 + git 155 + git-ui 34 + db 267 + db-ui 23 | all passed |

## Files

| File | Change |
|---|---|
| `src/main/sqlscript.js` | **New.** Shared tokenizer/splitter/classifier/formatter (dialects: mysql, postgres, sqlite, mssql, oracle). Strings, quoted identifiers, comments, `/*! */` executable comments, `$tag$` bodies, `DELIMITER`, `GO`, Oracle `/` and PL/SQL blocks, `BEGIN…END` depth for routines/triggers. Unterminated constructs are errors. `END$$`-style glued delimiters are split (fixed during this work). |
| `src/main/db.js` | **Rewritten.** Versioned atomic connection store (`.tmp` → fsync → verify → `.bak` → rename), typed errors (`store`, `store-corrupt`, `secret-unavailable`, `secret-locked`, `stale-connection`, `identity`, `outcome-unknown`, `session-gone`, `policy`, `driver-missing`, `driver-broken`, …). Secrets as `{ $enc:1, data }` envelopes, `{ $keep:true }`, session-only secrets, legacy plaintext migration, locked ciphertext preserved. Connection revisions (`rev`/`expectRev`). Generation-tracked live handles, one shared cold open, disconnect-during-open closes the late handle. Per-tab sessions with pinned clients, transaction tracking, `lostTx` after transport loss (added during this work: `closeHandle` keeps session records on transport failures). No blind replay: writes → `outcome-unknown`; reads outside a transaction retry once. Parsed policy enforcement (SQL, Mongo, Redis) incl. structured mutations and imports. Typed wire cells (`bigint`, `bytes`, `oid`, `date`, `json`, `decimal`, `num`, `uuid`), bound parameters for every generated statement, complete-PK identity with cardinality check inside a transaction and persisted-row re-read. Positional columns (duplicates kept), multiple result sets, `hasMore` instead of hidden truncation, derived-table preview only for confirmed SELECTs on mysql/pg (disclosed via `effectiveSql`), streaming stop for mssql, result sets for Oracle, no injected hints, Oracle autocommit as a visible session setting, LOBs fetched as content. Stable browse ordering (sort + PK tie-breaker / rowid / ctid), exact totals only on request. Schema plans (`schemaPlan` dry-run/apply with per-step states, transactional where the engine allows), complete MySQL column definitions for reorder, add-column type builder that ignores inactive parameters, `defaultLit`. SQLite opens without rewriting pragmas; missing files are errors unless `createIfMissing`; `readOnly`. Cancel protocol (`opId` → engine-specific cancel). |
| `src/main/db-io.js` | **Rewritten.** Streaming exports to a `.part` file published on completion, no row ceiling, explicit `done / cancelled (.partial.ext) / failed`, Mongo CSV as the union of fields over every page (JSONL spool), SQL export requires a SQL engine and a target table. Import jobs: `picked → running → done | cancelled | failed`, token bound to window + connection revision + table, expiry, exactly-once run, engine batch limits (`batchLimit`), bound parameters, per-batch `committed / failed / unattempted / unknown`, atomic empty-first on SQL engines (one transaction, rolled back on failure), Mongo empty-first only with `acknowledgeNonAtomic`, policy check before the first row, error list capped in the result but complete in an artifact file. Validation failures put the job back to `picked` (fixed during this work). Cancel is acknowledged; closing a dialog never cancels. |
| `src/main/db-formats.js` | **New.** ZIP (CRC-verified, bounded expansion), XLSX writer that refuses to truncate (cell address in the error) and keeps >15-digit numbers as text, XLSX reader (1900/1904, error cells, big numbers, sheet selection), text decoding (BOMs, UTF-16), CSV parser (unquoted empty → NULL, `""` → empty string, blank lines counted, malformed quoting is a located error), CSV writer that round-trips NULL vs empty. |
| `src/main/db-io-worker.js` | **New.** File parsing off the main thread (`worker_threads`). `src/main/db-worker.js` deleted. |
| `src/main/main.js` | DB IPC handlers replaced: argument validators (`V.id/str/text/ref/obj/opts/list`), 44 `db:*` channels incl. sessions, cancel, secrets, schema plans, import/export jobs. |
| `src/main/preload.js` | Matching bridge methods (`revealSecret`, `setSessionSecret`, `sessionOpen/Close/Set`, `cancel`, `splitScript`, `formatSql`, `schemaPlan`, `exportCancel`, `importCancel/Discard`, `jobStatus`, `jobs`, `onIoProgress`, opts on mutations). |
| `src/renderer/dbm.js` | **Rewritten.** Run context captured per run (connection id, revision, session, statements); statement rows `queued → running → done / failed / unknown / not run`; Stop → `cancel(opId)`; a closed busy tab detaches (remaining statements are never sent). Per-tab sessions and transaction badge; Oracle autocommit toggle. Accessible virtual grid (roles, roving tabindex, arrow keys, `aria-sort`), typed cell display/edit (`parseEdit` keeps tag kinds), server-persisted value after edits, conflicts keep the original and re-read. Browse: Next follows `hasMore`, estimates advisory (`~`), exact totals only after Count, stable-order note. Connection form edits a deep copy; secrets `{ $keep }` / clear / reveal / session-only fallback when secure storage is unavailable; TLS verify vs insecure with CA/server name; policies from `kinds().policies`. Import dialog as a job (Cancel acknowledged, Close hides, counts from the result, non-atomic acknowledgement for Mongo). Export as a job with Cancel; SQL export asks for a target. Structure with per-table pending plans → exact dry run → apply with step states; add-column dialog clears inactive parameters and previews the server's dry run; add-index. Database-controlled names rendered as text. Dispose releases every listener. Query history with retention/privacy preferences; execution log with `unknown` state. |
| `src/renderer/styles.css` | Contrast for status/log/pager text, visible focus for grid/lists/tabs, statement-state chips, unknown-outcome styling, transaction badge, TLS box, import/plan step UI. |
| `src/renderer/app.js` | Unchanged for DB (already passes `{ h, icon, toast, atom, showContextMenu, chooseDialog, promptDialog, modalShell, closeModal }`; dismissed dialogs resolve — DB-050 — from the Git audit work). |
| `scripts/test-db.js`, `scripts/test-db-ui.js`, `smoke-tests/test-db-manager.js`, `scripts/_xcheck-db-ipc.js`, `package.json` | New suites and scripts (`test`, `test:db`, `test:db-ui`, `test:db-e2e`). |

## Finding → change → test

| ID | Change | Tests |
|---|---|---|
| DB-001 | Run context captured per run; detached tab never sends remaining statements; `expectRev` on every mutation | U07, B14 |
| DB-002 | Per-tab sessions (`sessionOpen/Close/Set`), pinned clients, `inTx`/`lostTx`, rollback on close | B14, B49, smoke |
| DB-003 | Writes on transport loss → `outcome-unknown` (sent once); reads retry once outside transactions; session survives with `lostTx` | B13, U20 |
| DB-004 | Complete-PK identity, NULL/extra/missing/expression rejected, cardinality check in a transaction | B19, B20 |
| DB-005 | `bigint` tags end to end; SQLite `defaultSafeIntegers`; bound as exact values | B21, B23 |
| DB-006 | Parsed classification (comments, CTE writes, quoted names, IF EXISTS, PRAGMA read vs assignment, procedures) | B15, parser checks |
| DB-007 | `mongoClassify` ($out/$merge, commands, unknown ops blocked), `redisClassify` (DEL/UNLINK/FLUSH*, EVAL, per-key protection) | B16, B17, B18 |
| DB-008 | Empty-first atomic on SQL engines; Mongo needs `acknowledgeNonAtomic`; validation before any write | B34 |
| DB-009 | Job cancel acknowledged, stops before the next batch; Close only hides; result kept in `jobStatus` | B35, I01 |
| DB-010 | Mongo export: union of fields over all pages, rows remapped | B40, B41 |
| DB-011 | `formatSql` touches only tokens outside strings/comments; unparsable text returned unchanged | U01 |
| DB-012 | One splitter for backend, importer and editor; errors refuse the run | U02, B47, B48 |
| DB-013 | Pool error listeners mark the handle broken; next call re-opens | B11 |
| DB-014 | Read errors ≠ empty store; corrupt store is typed and untouched; atomic write with `.bak`; `rev` conflicts | B01, B02, B06 |
| DB-015 | Envelopes, no silent downgrade (`secret-unavailable`), session-only secrets, locked ciphertext preserved, legacy migration | B03, B04, B05 |
| DB-016 | `sslMode` verify/insecure → `rejectUnauthorized`, CA file, server name, mssql `encrypt`/`trustServerCertificate`; missing CA is typed | B07 |
| DB-017 | Lossless `cell()`; bytes keep full content; display is renderer-side | B23, B28, B29, B43 |
| DB-018 | Streaming export, no ceiling, explicit partial on cancel | B42, E01 |
| DB-019 | Update returns the persisted row; grid shows it; not-found keeps original and re-reads | U05 |
| DB-020 | Single in-flight guard for insert/add-column/apply | U06 |
| DB-021 | Shared cold open, throw-away test handle, disconnect-during-open closes late handle | B08, B09, B10 |
| DB-022 | Status generations; late ping results ignored; auth → `error` (never `reconnecting`) | U11 |
| DB-023 | Form edits `structuredClone`; Cancel changes nothing | U09 |
| DB-024 | Per-statement blocks; earlier results kept; rest marked not run | U08 |
| DB-025 | Oracle test via `pool.getConnection` | B12 |
| DB-026 | SQLite dispatch by prepared statement (`reader`) | B25 |
| DB-027 | No regex caps; derived-table preview only for confirmed SELECTs, disclosed; verbatim otherwise; mssql stream stop | B26, B27 |
| DB-028 | Positional columns, duplicate names kept, multiple result sets | B22 |
| DB-029 | Worker removed; representation independent of size | B24, B29 |
| DB-030 | Bound parameters for generated mutations; `{ raw }` validated | identity block (B30 labels) |
| DB-031 | Oracle `fetchTypeHandler` (CLOB → string, BLOB → buffer), result sets | B31 (oracle) |
| DB-032 | Stable ORDER BY (sort + PK / rowid / ctid), `hasMore`, exact totals only | U04, browse checks |
| DB-033 | `committed / failed / unattempted / unknown`, error artifact | B38, B33, I02 |
| DB-034 | Token owner/connection/table/revision/state checks, expiry, exactly once | B36, B37 |
| DB-035 | `batchLimit` per engine | B39 |
| DB-036 | CSV NULL vs empty, blank lines, located errors | B46, B53 |
| DB-037 | XLSX no truncation, 1904 dates, error cells, big numbers | B44, B45, B53 |
| DB-038 | Worker-thread parsing, bounded zip expansion, CRC | zip checks |
| DB-039 | `opId` cancel protocol; Stop button | U19, cancel checks |
| DB-040 | Pending plan → exact dry run → apply with step states; failed plans stay reviewable | U14, U15 |
| DB-041 | `mysqlColumnDef` complete (generated, collation, defaults, extras, comment) | B32 |
| DB-042 | Type change clears inactive parameters; `defaultLit`; revision-bound preview | U16, B33 |
| DB-043 | Structured `{ schema, table }` identity; first-dot split only for schema engines | B31, B43 |
| DB-044 | SQL export needs SQL engine + target; dialect literals | DB-044 checks, E01 |
| DB-045 | Names rendered as text; IPC validators; identifier/fragment validation | U17, DB-045 checks |
| DB-046 | `list()` never returns secrets; reveal is explicit; history retention/privacy prefs | B06, S01 |
| DB-047 | `driver-missing` vs `driver-broken`; install verified by load | DB-047 checks |
| DB-048 | Grid roles/focus/keyboard; contrast | U18 |
| DB-049 | Draft/pending/transaction confirmations on close; fresh tab objects; `dispose()` | U10 |
| DB-050 | Every dismissal resolves (`modal-closed`) | U12, U13 |
| DB-051 | Redis argv from `splitCmd` (quotes, escapes) or structured `argv`; one key per argument | B30 |

## Deliberate limits changed

Preview row limit is a visible setting with `hasMore` (no clamp to 5000 and no hidden LIMIT in the user's SQL);
browse page size is a page, never data scope; Oracle hints and forced autocommit removed; SQLite pragmas not
rewritten; export ceiling removed; import batch follows engine limits; error list complete in an artifact;
history/log retention are preferences; XLSX limits are errors, not silent slices.

## Not verified here (engine-specific limitations)

- Fake drivers prove the module's contract (what is sent, how results/errors are handled), **not** real server
  integration. MySQL, PostgreSQL, SQL Server, Oracle, MongoDB and Redis were not exercised against live servers,
  nor TLS against real certificates. The SQLite path is real (backend suite and Electron smoke).
- Packaged Windows build / driver ABI loading was not rebuilt in this pass; `installDriver` verifies by loading and
  reports `install-failed / rebuild-failed / load-failed` distinctly.
- Import token expiry (30 min) is implemented but not time-travelled in tests.

## Gaps G01–G10

Not implemented (feature additions, listed separately from correctness as the audit asks). The corrected contracts
they depend on — connection revisions, sessions, typed values, plans, jobs — are in place.
