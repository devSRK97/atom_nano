"use strict";
/* DBM — multi-database manager backend (MySQL, PostgreSQL, Oracle, MongoDB, SQLite,
 * SQL Server, Redis). Drivers are ordinary npm packages loaded at first use.
 *
 * Contracts (audit ATOMNANO_DB_MANAGEMENT_AUDIT_2026-09-09):
 *
 *   STORE      userData/db-connections.json is a versioned document written
 *              atomically (temp + rename, .bak kept). Read/parse failures are typed
 *              errors, never an empty list that a later save would overwrite.
 *   SECRETS    passwords / URIs are stored as a typed envelope { $enc: 1, data }
 *              (Electron safeStorage). list() never returns secret values — only
 *              hasPassword/hasUri/secretLocked; the form keeps a secret with
 *              { $keep: true }, clears it with "", reveals it only on explicit request.
 *              If OS encryption is unavailable a secret is NOT written in plaintext:
 *              the save fails with type "secret-unavailable" and the UI offers a
 *              session-only credential (setSessionSecret) instead.
 *   REVISIONS  every save bumps conn.rev. Operations submitted with expectRev are
 *              rejected (type "stale-connection") when the profile changed meanwhile.
 *   CONNECTIONS one live handle per profile with a generation token: concurrent cold
 *              opens share one promise, a disconnect during open closes the late
 *              handle, a failed verification closes the pool, close() is awaited.
 *              Pool error listeners exist before connecting (idle errors never throw).
 *   SESSIONS   a query tab owns a SESSION (pinned client) so BEGIN/COMMIT, SET/USE,
 *              temp tables and search_path belong to that tab. Health checks never
 *              use a session client.
 *   RETRY      a transport error never re-runs a statement that may have mutated
 *              state: mutations surface as type "outcome-unknown"; only classified
 *              reads outside a transaction retry once on a fresh handle.
 *   POLICY     enforced in main on the PARSED statement (sqlscript.classify): CTE
 *              bodies, EXEC/CALL, comments, quoted/qualified names, Mongo operations
 *              and Redis commands. Unknown mutating constructs are blocked when a
 *              protection is enabled.
 *   VALUES     one typed wire contract. Cells are JSON primitives or tagged objects:
 *              { $t:"bigint", v } · { $t:"bytes", b64, len } · { $t:"oid", v } ·
 *              { $t:"date", v } · { $t:"json", v } · { $t:"decimal", v }. Nothing is
 *              rounded through Number; blobs keep their bytes. Generated mutations
 *              bind PARAMETERS (never interpolated literals).
 *   IDENTITY   row edits/deletes require the COMPLETE primary key with non-NULL
 *              typed values and run inside a transaction that verifies exactly one
 *              row matched (rolled back otherwise).
 *   RESULTS    positional columns (duplicates kept), every result set returned,
 *              user SQL is never rewritten: previews wrap a confirmed SELECT in a
 *              derived table (shown as effectiveSql) or use driver cursors, and
 *              `hasMore` says whether more rows exist. */
/* Layout: this file is the facade every caller requires — the export list below is the contract.
 * The implementation lives in the db-*.js siblings: db-common (errors, engine catalog), db-drivers
 * (npm drivers, per-engine connect), db-connections (live handles, sessions), db-store (profiles,
 * secrets), db-values (typed cells, identifiers), db-policy (classification, enforcement), db-exec
 * (statement execution, retry, transactions, cancel), db-query (test / ping / query / explain,
 * session API), db-schema (catalog introspection), db-rows (row identity, mutations, browse) and
 * db-ddl (column / index DDL, schema plans). */
const S = require("./sqlscript");
const { DbError, POLICIES } = require("./db-common");
const { installDriver, driverInstalled, connect } = require("./db-drivers");
const { live, sessions, open, closeOne, closeAll, sessionClose, sessionState } = require("./db-connections");
const { kinds, list, save, remove, revealSecret, setSessionSecret, getConn, sessionSecrets, readStore, writeStore, sealSecret, openSecret } = require("./db-store");
const { quoteIdent, qualify, objIdent, sqlLiteral, cell, cellText, bindValue, isTag } = require("./db-values");
const { splitCmd, redisQuote, mongoClassify, redisClassify, enforcePolicy, tableCls } = require("./db-policy");
const { cancel, withTx, ph } = require("./db-exec");
const { test, ping, query, parallelQuery, splitScript, formatSql, sessionOpen, sessionSet, explain } = require("./db-query");
const { schema, schemaMore, columns, keyColumns, tableInfo } = require("./db-schema");
const { insertRow, updateRows, deleteRows, count, browse } = require("./db-rows");
const { addColumn, dropColumn, renameColumn, addIndex, dropIndex, reorderColumns, schemaPlan, buildColumnType, TX_DDL, mysqlColumnDef, defaultLit } = require("./db-ddl");

module.exports = {
  DbError, kinds, list, save, remove, revealSecret, setSessionSecret, test, ping, schema, schemaMore, columns, keyColumns, query, parallelQuery, splitScript, formatSql,
  sessionOpen, sessionClose, sessionSet, sessionState, cancel,
  addColumn, dropColumn, renameColumn, addIndex, dropIndex, reorderColumns, schemaPlan, installDriver, driverInstalled, closeAll, disconnect: closeOne,
  tableInfo, count, browse, insertRow, updateRows, deleteRows, explain,
  // shared with db-io / tests
  quoteIdent, qualify, objIdent, literal: sqlLiteral, sqlLiteral, cell, cellText, bindValue, isTag, buildColumnType, classify: S.classify, splitCmd, redisQuote, mongoClassify, redisClassify, enforcePolicy, tableCls, getConn, open, withTx, ph, TX_DDL, POLICIES,
  __internals: { live, sessions, connect, sessionSecrets, readStore, writeStore, sealSecret, openSecret, mysqlColumnDef, defaultLit },
};
