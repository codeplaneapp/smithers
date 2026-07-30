import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError as EffectSqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";
import { Effect, Layer, ManagedRuntime, Scope, Semaphore, Stream } from "effect";
import { POSTGRES, SQLITE, jsonExtractText, translatePlaceholders } from "./dialect.js";
import {
  runSmithersSchemaMigrations,
  runSmithersSchemaInitSqliteAsync,
  runSmithersSchemaInitPostgres,
} from "./schema-migrations.js";
import { camelToSnake } from "./utils/camelToSnake.js";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("bun:sqlite").Database} Database */
/** @typedef {import("./SqlMessageStorageEventHistoryQuery.ts").SqlMessageStorageEventHistoryQuery} SqlMessageStorageEventHistoryQuery */

class SqlError extends EffectSqlError {
  constructor(options) {
    super({ reason: new UnknownError(options) });
  }
}
/**
 * @typedef {string | number | bigint | boolean | Uint8Array | null | undefined} SqliteParam
 */
/**
 * @typedef {{
 *   dialect: "sqlite";
 *   driver: "external-sqlite" | "cloudflare-sqlite";
 *   queryAllRaw: (statement: string, params?: ReadonlyArray<unknown>) => ReadonlyArray<Record<string, unknown>> | Promise<ReadonlyArray<Record<string, unknown>>>;
 *   queryValuesRaw?: (statement: string, params?: ReadonlyArray<unknown>) => ReadonlyArray<ReadonlyArray<unknown>> | Promise<ReadonlyArray<ReadonlyArray<unknown>>>;
 *   execute?: (statement: string, params?: ReadonlyArray<unknown>) => unknown | Promise<unknown>;
 *   supportsTransactions?: boolean;
 *   transaction?: <T>(operation: () => T | Promise<T>) => T | Promise<T>;
 * }} ExternalSqliteDescriptor
 */

const ATTR_DB_SYSTEM_NAME = "db.system.name";
const POSTGRES_SEQUENCE_ALLOCATION_MAX_ATTEMPTS = 128;
/**
 * @param {string} dialect
 * @param {string} operation
 * @param {string} statement
 * @param {unknown} cause
 */
function formatSqlErrorMessage(dialect, operation, statement, cause) {
  const compactStatement = statement.replace(/\s+/g, " ").trim();
  const clippedStatement = compactStatement.length > 500 ? `${compactStatement.slice(0, 497)}...` : compactStatement;
  // Cause rendering is best-effort: prefer Error.message, then a raw string,
  // then JSON, falling back to String() for circular values. The resulting
  // message shape is pinned by tests/db-sql-error-message.test.js.
  let causeText;
  if (cause instanceof Error && cause.message) {
    causeText = cause.message;
  } else if (typeof cause === "string") {
    causeText = cause;
  } else {
    try {
      causeText = JSON.stringify(cause);
    } catch {
      causeText = String(cause);
    }
  }
  return `Failed to execute ${dialect} ${operation}: ${causeText}; sql=${clippedStatement}`;
}
const CREATE_TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS _smithers_runs (
    run_id TEXT PRIMARY KEY,
    parent_run_id TEXT,
    workflow_name TEXT NOT NULL,
    workflow_path TEXT,
    workflow_hash TEXT,
    status TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    finished_at_ms INTEGER,
    heartbeat_at_ms INTEGER,
    runtime_owner_id TEXT,
    cancel_requested_at_ms INTEGER,
    pause_requested_at_ms INTEGER,
    hijack_requested_at_ms INTEGER,
    hijack_target TEXT,
    vcs_type TEXT,
    vcs_root TEXT,
    vcs_revision TEXT,
    error_json TEXT,
    config_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_nodes (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    last_attempt INTEGER,
    updated_at_ms INTEGER NOT NULL,
    output_table TEXT NOT NULL,
    label TEXT,
    PRIMARY KEY (run_id, node_id, iteration)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_attempts (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL,
    state TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    heartbeat_at_ms INTEGER,
    heartbeat_data_json TEXT,
    error_json TEXT,
    jj_pointer TEXT,
    response_text TEXT,
    jj_cwd TEXT,
    cached INTEGER DEFAULT 0,
    meta_json TEXT,
    PRIMARY KEY (run_id, node_id, iteration, attempt)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_frames (
    run_id TEXT NOT NULL,
    frame_no INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    xml_json TEXT NOT NULL,
    xml_hash TEXT NOT NULL,
    encoding TEXT NOT NULL DEFAULT 'full',
    mounted_task_ids_json TEXT,
    task_index_json TEXT,
    note TEXT,
    PRIMARY KEY (run_id, frame_no),
    FOREIGN KEY (run_id) REFERENCES _smithers_runs(run_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_approvals (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    requested_at_ms INTEGER,
    decided_at_ms INTEGER,
    note TEXT,
    decided_by TEXT,
    request_json TEXT,
    decision_json TEXT,
    auto_approved INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, node_id, iteration)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_human_requests (
    request_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schema_json TEXT,
    options_json TEXT,
    response_json TEXT,
    requested_at_ms INTEGER NOT NULL,
    answered_at_ms INTEGER,
    answered_by TEXT,
    timeout_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_alerts (
    alert_id TEXT PRIMARY KEY,
    run_id TEXT,
    policy_name TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    fired_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER,
    acknowledged_at_ms INTEGER,
    message TEXT NOT NULL,
    details_json TEXT,
    fingerprint TEXT,
    node_id TEXT,
    iteration INTEGER,
    owner TEXT,
    runbook TEXT,
    labels_json TEXT,
    reaction_json TEXT,
    source_event_type TEXT,
    first_fired_at_ms INTEGER,
    last_fired_at_ms INTEGER,
    occurrence_count INTEGER DEFAULT 1,
    silenced_until_ms INTEGER,
    acknowledged_by TEXT,
    resolved_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_signals (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    signal_name TEXT NOT NULL,
    correlation_id TEXT,
    payload_json TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL,
    received_by TEXT,
    PRIMARY KEY (run_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_cache (
    cache_key TEXT PRIMARY KEY,
    created_at_ms INTEGER NOT NULL,
    workflow_name TEXT NOT NULL,
    node_id TEXT NOT NULL,
    output_table TEXT NOT NULL,
    schema_sig TEXT NOT NULL,
    agent_sig TEXT,
    tools_sig TEXT,
    jj_pointer TEXT,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_node_diffs (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    base_ref TEXT NOT NULL,
    diff_json TEXT NOT NULL,
    computed_at_ms INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    PRIMARY KEY (run_id, node_id, iteration, base_ref),
    FOREIGN KEY (run_id) REFERENCES _smithers_runs(run_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_time_travel_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    from_frame_no INTEGER NOT NULL,
    to_frame_no INTEGER NOT NULL,
    caller TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    result TEXT NOT NULL,
    duration_ms INTEGER,
    FOREIGN KEY (run_id) REFERENCES _smithers_runs(run_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_rewind_leases (
    run_id TEXT PRIMARY KEY,
    owner_token TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_sandboxes (
    run_id TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    runtime TEXT NOT NULL DEFAULT 'bubblewrap',
    remote_run_id TEXT,
    workspace_id TEXT,
    container_id TEXT,
    config_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    heartbeat_at_ms INTEGER,
    shipped_at_ms INTEGER,
    completed_at_ms INTEGER,
    bundle_path TEXT,
    PRIMARY KEY (run_id, sandbox_id)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_tool_calls (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    call_token TEXT,
    tool_name TEXT NOT NULL,
    input_json TEXT,
    output_json TEXT,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    status TEXT NOT NULL,
    error_json TEXT,
    kind TEXT,
    side_effect INTEGER,
    idempotent INTEGER,
    accepts_idempotency_key INTEGER,
    has_revert INTEGER,
    idempotency_key TEXT,
    revert_status TEXT /* null | reverting | reverted | revert-failed | revert-stale */,
    reverted_at_ms INTEGER,
    revert_error_json TEXT,
    forced_past_json TEXT,
    PRIMARY KEY (run_id, node_id, iteration, attempt, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_tool_call_archive (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    call_token TEXT,
    tool_name TEXT NOT NULL,
    input_json TEXT,
    output_json TEXT,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    status TEXT NOT NULL,
    error_json TEXT,
    kind TEXT,
    side_effect INTEGER,
    idempotent INTEGER,
    accepts_idempotency_key INTEGER,
    has_revert INTEGER,
    idempotency_key TEXT,
    revert_status TEXT /* null | reverting | reverted | revert-failed | revert-stale */,
    reverted_at_ms INTEGER,
    revert_error_json TEXT,
    forced_past_json TEXT,
    archived_by_op TEXT NOT NULL,
    archived_at_ms INTEGER NOT NULL,
    archive_reason TEXT NOT NULL,
    PRIMARY KEY (run_id, node_id, iteration, attempt, seq, archived_by_op)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_workspace_states (
    run_id TEXT NOT NULL,
    jj_cwd TEXT NOT NULL,
    jj_commit_id TEXT NOT NULL,
    jj_operation_id TEXT NOT NULL,
    jj_change_id TEXT,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, jj_cwd, jj_commit_id)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_workspace_checkpoints (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    jj_cwd TEXT NOT NULL,
    jj_commit_id TEXT NOT NULL,
    source TEXT NOT NULL,
    tier INTEGER NOT NULL,
    label TEXT,
    tool_use_id TEXT,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, node_id, iteration, attempt, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_events (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_output_provenance (
    run_id TEXT NOT NULL,
    output_table TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (run_id, output_table, node_id, iteration),
    UNIQUE (run_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_ralph (
    run_id TEXT NOT NULL,
    ralph_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, ralph_id)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_cron (
    cron_id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL,
    workflow_path TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    last_run_at_ms INTEGER,
    next_run_at_ms INTEGER,
    error_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_snapshot_contents (
    content_hash TEXT PRIMARY KEY,
    nodes_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    ralph_json TEXT NOT NULL,
    input_json TEXT NOT NULL,
    ref_count INTEGER NOT NULL DEFAULT 0 CHECK (ref_count >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_snapshots (
    run_id TEXT NOT NULL,
    frame_no INTEGER NOT NULL,
    nodes_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    ralph_json TEXT NOT NULL,
    input_json TEXT NOT NULL,
    vcs_pointer TEXT,
    workflow_hash TEXT,
    content_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, frame_no)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_snapshot_payload_refs (
    run_id TEXT NOT NULL,
    frame_no INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (run_id, frame_no),
    FOREIGN KEY (run_id, frame_no) REFERENCES _smithers_snapshots(run_id, frame_no) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (content_hash) REFERENCES _smithers_snapshot_contents(content_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_branches (
    run_id TEXT PRIMARY KEY,
    parent_run_id TEXT NOT NULL,
    parent_frame_no INTEGER NOT NULL,
    branch_label TEXT,
    fork_description TEXT,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_vcs_tags (
    run_id TEXT NOT NULL,
    frame_no INTEGER NOT NULL,
    vcs_type TEXT NOT NULL,
    vcs_pointer TEXT NOT NULL,
    vcs_root TEXT,
    jj_operation_id TEXT,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, frame_no)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_vectors (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    dimensions INTEGER NOT NULL,
    metadata_json TEXT,
    document_id TEXT,
    chunk_index INTEGER,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_scorers (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    scorer_id TEXT NOT NULL,
    scorer_name TEXT NOT NULL,
    source TEXT NOT NULL,
    score REAL NOT NULL,
    reason TEXT,
    meta_json TEXT,
    input_json TEXT,
    output_json TEXT,
    ground_truth_json TEXT,
    context_json TEXT,
    latency_ms REAL,
    scored_at_ms INTEGER NOT NULL,
    duration_ms REAL
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_eval_suites (
    suite_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workflow_key TEXT NOT NULL,
    workflow_path TEXT NOT NULL,
    workflow_root TEXT NOT NULL,
    dataset_json TEXT NOT NULL,
    case_count INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_eval_cases (
    id TEXT PRIMARY KEY,
    eval_run_id TEXT NOT NULL,
    suite_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    case_index INTEGER NOT NULL,
    name TEXT,
    status TEXT NOT NULL,
    case_run_id TEXT,
    input_json TEXT,
    expected_json TEXT,
    actual_json TEXT,
    assertions_json TEXT,
    error TEXT,
    started_at_ms INTEGER,
    finished_at_ms INTEGER,
    duration_ms REAL
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_memory_facts (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    schema_sig TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    ttl_ms INTEGER,
    run_id TEXT,
    node_id TEXT,
    iteration INTEGER,
    PRIMARY KEY (namespace, key)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_memory_threads (
    thread_id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    title TEXT,
    metadata_json TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_memory_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    run_id TEXT,
    node_id TEXT,
    iteration INTEGER,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_memory_notes (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT,
    tags_json TEXT,
    author TEXT,
    status TEXT NOT NULL DEFAULT 'accepted',
    status_changed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    run_id TEXT,
    node_id TEXT,
    iteration INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_memory_note_supersessions (
    note_id TEXT NOT NULL,
    supersedes_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (note_id, supersedes_id)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_docs (
    path TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'ticket',
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_integration_deliveries (
    source_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    event_name TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    claim_token TEXT,
    claim_expires_at_ms INTEGER,
    completed_at_ms INTEGER,
    PRIMARY KEY (source_id, dedupe_key)
  )`,
  `CREATE TABLE IF NOT EXISTS _smithers_integration_cursors (
    source_id TEXT PRIMARY KEY,
    cursor TEXT,
    updated_at_ms INTEGER NOT NULL
  )`,
];
const CREATE_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS _smithers_runs_status_heartbeat_idx
    ON _smithers_runs (status, heartbeat_at_ms)`,
  `CREATE INDEX IF NOT EXISTS _smithers_signals_lookup_idx
    ON _smithers_signals (run_id, signal_name, correlation_id, received_at_ms)`,
  `CREATE INDEX IF NOT EXISTS _smithers_time_travel_audit_lookup_idx
    ON _smithers_time_travel_audit (run_id, caller, timestamp_ms)`,
  `CREATE INDEX IF NOT EXISTS _smithers_docs_kind_live_idx
    ON _smithers_docs (kind, deleted_at_ms, updated_at_ms)`,
  `CREATE INDEX IF NOT EXISTS _smithers_memory_notes_namespace_idx
    ON _smithers_memory_notes (namespace, status, created_at_ms)`,
  `CREATE INDEX IF NOT EXISTS _smithers_memory_note_supersessions_target_idx
    ON _smithers_memory_note_supersessions (supersedes_id)`,
  `CREATE INDEX IF NOT EXISTS _smithers_snapshot_payload_refs_content_hash_idx
    ON _smithers_snapshot_payload_refs (content_hash)`,
  `CREATE INDEX IF NOT EXISTS _smithers_eval_cases_run_idx
    ON _smithers_eval_cases (eval_run_id, case_index)`,
];
/**
 * @param {string} identifier
 * @returns {string}
 */
function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}
/**
 * @param {string} value
 * @returns {string}
 */
function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}
/**
 * @param {SqliteParam} value
 * @returns {Exclude<SqliteParam, undefined>}
 */
function encodeParam(value) {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value ?? null;
}
/**
 * @template T
 * @param {ReadonlyArray<T>} rows
 * @returns {ReadonlyArray<T>}
 */
function transformRowKeys(rows) {
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return row;
    }
    const next = {};
    for (const [key, value] of Object.entries(row)) {
      next[snakeToCamel(key)] = value;
    }
    return next;
  });
}
/**
 * @template T
 * @param {T} row
 * @param {readonly string[]} [booleanColumns]
 * @returns {T}
 */
function applyBooleanColumns(row, booleanColumns) {
  if (!booleanColumns || booleanColumns.length === 0) {
    return row;
  }
  const next = { ...row };
  for (const column of booleanColumns) {
    const current = next[column];
    if (current !== null && current !== undefined) {
      next[column] = Boolean(current);
    }
  }
  return next;
}
/**
 * @param {string} table
 * @param {Record<string, unknown>} row
 * @param {{ orIgnore?: boolean; conflictColumns?: readonly string[]; updateColumns?: readonly string[]; }} [options]
 */
function buildInsertSql(table, row, options, dialect = SQLITE) {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  const columns = entries.map(([key]) => camelToSnake(key));
  const params = entries.map(([, value]) => encodeParam(value));
  const tableSql = quoteIdentifier(table);
  const columnSql = columns.map(quoteIdentifier).join(", ");
  const placeholderSql = columns.map(() => "?").join(", ");
  // SQLite spells the ignore-on-conflict shorthand `INSERT OR IGNORE`;
  // PostgreSQL has no such prefix and instead appends `ON CONFLICT DO NOTHING`.
  const orIgnorePrefix = options?.orIgnore && dialect !== POSTGRES ? " OR IGNORE" : "";
  let statement = `INSERT${orIgnorePrefix} INTO ${tableSql} (${columnSql}) ` + `VALUES (${placeholderSql})`;
  if (options?.conflictColumns && options.conflictColumns.length > 0) {
    const conflictSql = options.conflictColumns.map(camelToSnake).map(quoteIdentifier).join(", ");
    const updateColumns = (options.updateColumns ?? Object.keys(row))
      .map(camelToSnake)
      .filter((column) => !options.conflictColumns.includes(snakeToCamel(column)));
    if (updateColumns.length === 0) {
      statement += ` ON CONFLICT (${conflictSql}) DO NOTHING`;
    } else {
      const updateSql = updateColumns
        .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
        .join(", ");
      statement += ` ON CONFLICT (${conflictSql}) DO UPDATE SET ${updateSql}`;
    }
  } else if (options?.orIgnore && dialect === POSTGRES) {
    statement += ` ON CONFLICT DO NOTHING`;
  }
  return { statement, params };
}
/**
 * @param {string} table
 * @param {Record<string, unknown>} patch
 * @param {string} whereSql
 * @param {ReadonlyArray<SqliteParam>} [params]
 */
function buildUpdateSql(table, patch, whereSql, params = []) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return null;
  }
  const setSql = entries.map(([key]) => `${quoteIdentifier(camelToSnake(key))} = ?`).join(", ");
  return {
    statement: `UPDATE ${quoteIdentifier(table)} SET ${setSql} WHERE ${whereSql}`,
    params: [...entries.map(([, value]) => encodeParam(value)), ...params.map(encodeParam)],
  };
}
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Database}
 */
function resolveSqliteDatabase(db) {
  const isRawClient = (/** @type {any} */ v) =>
    Boolean(v) && typeof v.query === "function" && typeof v.run === "function";
  // A Drizzle BunSQLiteDatabase wraps the raw client; a bun:sqlite Database *is*
  // the raw client. Duck-type instead of `instanceof Database` so this module
  // loads on runtimes without bun:sqlite (Cloudflare Workers / other isolates),
  // where the bun-sqlite path is never taken.
  const wrapped = db?.session?.client ?? db?.$client;
  if (wrapped !== undefined) {
    if (!isRawClient(wrapped)) {
      throw new TypeError("SqlMessageStorage requires a Bun SQLite client.");
    }
    return wrapped;
  }
  if (isRawClient(db)) {
    return db;
  }
  throw new TypeError("SqlMessageStorage requires a Bun SQLite client.");
}
/**
 * @param {unknown} db
 * @returns {db is ExternalSqliteDescriptor}
 */
function isExternalSqliteDescriptor(db) {
  return Boolean(
    db &&
    typeof db === "object" &&
    /** @type {any} */ (db).dialect === SQLITE &&
    (/** @type {any} */ (db).driver === "external-sqlite" || /** @type {any} */ (db).driver === "cloudflare-sqlite") &&
    typeof (/** @type {any} */ (db).queryAllRaw) === "function",
  );
}
/**
 * @param {Database} sqlite
 * @returns {Connection}
 */
function createConnection(sqlite) {
  /**
   * @param {string} statement
   * @param {ReadonlyArray<unknown>} params
   * @param {(<A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined} [transformRows]
   */
  const execute = (statement, params, transformRows) =>
    Effect.gen(function* () {
      const useSafeIntegers = yield* SqlClient.SafeIntegers;
      try {
        const query = sqlite.query(statement);
        // @ts-ignore bun-types missing safeIntegers()
        query.safeIntegers(useSafeIntegers);
        const rows = query.all(...params) ?? [];
        return transformRows ? transformRows(rows) : rows;
      } catch (cause) {
        return yield* Effect.fail(
          new SqlError({
            cause,
            message: formatSqlErrorMessage("SQLite", "statement", statement, cause),
          }),
        );
      }
    });
  return {
    execute: (statement, params, transformRows) => execute(statement, params, transformRows),
    executeRaw: (statement, params) => execute(statement, params, undefined),
    executeValues: (statement, params) =>
      Effect.gen(function* () {
        const useSafeIntegers = yield* SqlClient.SafeIntegers;
        try {
          const query = sqlite.query(statement);
          // @ts-ignore bun-types missing safeIntegers()
          query.safeIntegers(useSafeIntegers);
          return query.values(...params) ?? [];
        } catch (cause) {
          return yield* Effect.fail(
            new SqlError({
              cause,
              message: formatSqlErrorMessage("SQLite", "values statement", statement, cause),
            }),
          );
        }
      }),
    executeUnprepared: (statement, params, transformRows) => execute(statement, params, transformRows),
    executeStream: (statement, params, transformRows) =>
      Stream.fromIterableEffect(execute(statement, params, transformRows)),
  };
}
/**
 * Wraps a raw connection in a scoped `SqlClient` layer. All three drivers
 * (bun-sqlite, external sqlite, postgres) share this body: a one-permit
 * semaphore serializes access to the single underlying connection.
 *
 * The compiler is only exercised by the `sql``` tagged template, which this
 * storage never uses — every query is a pre-built string run through the raw
 * connection (where the Postgres `?`→`$n` rewrite happens), so the SQLite
 * compiler is an inert placeholder for every dialect.
 * @param {Connection} connection
 * @param {string} dbSystemName OpenTelemetry `db.system.name` span attribute value.
 */
function makeSqlClientLayer(connection, dbSystemName) {
  return Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(1);
      const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
      const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
        Effect.as(
          Effect.andThen(
            restore(semaphore.take(1)),
            Effect.tap(Effect.scope, (scope) => Scope.addFinalizer(scope, semaphore.release(1))),
          ),
          connection,
        ),
      );
      const reactivity = yield* Reactivity.make;
      return yield* SqlClient.make({
        acquirer,
        compiler: Statement.makeCompilerSqlite(camelToSnake),
        transactionAcquirer,
        spanAttributes: [[ATTR_DB_SYSTEM_NAME, dbSystemName]],
        transformRows: transformRowKeys,
      }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
    }),
  );
}
/**
 * @param {ExternalSqliteDescriptor} descriptor
 * @returns {Connection}
 */
function createExternalSqliteConnection(descriptor) {
  /**
   * @param {string} statement
   * @param {ReadonlyArray<unknown>} params
   * @param {(<A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined} [transformRows]
   */
  const run = (statement, params, transformRows) =>
    Effect.tryPromise({
      try: async () => {
        const rows = await descriptor.queryAllRaw(statement, params);
        return transformRows ? transformRows(rows) : rows;
      },
      catch: (cause) =>
        new SqlError({
          cause,
          message: formatSqlErrorMessage("SQLite", "external statement", statement, cause),
        }),
    });
  return {
    execute: (statement, params, transformRows) => run(statement, params, transformRows),
    executeRaw: (statement, params) => {
      if (descriptor.execute) {
        return Effect.tryPromise({
          try: async () => {
            const result = await descriptor.execute?.(statement, params);
            return Array.isArray(result) ? result : [];
          },
          catch: (cause) =>
            new SqlError({
              cause,
              message: formatSqlErrorMessage("SQLite", "external execute", statement, cause),
            }),
        });
      }
      return run(statement, params, undefined);
    },
    executeValues: (statement, params) =>
      Effect.tryPromise({
        try: async () => {
          if (descriptor.queryValuesRaw) {
            return await descriptor.queryValuesRaw(statement, params);
          }
          const rows = await descriptor.queryAllRaw(statement, params);
          return rows.map((row) => Object.values(row));
        },
        catch: (cause) =>
          new SqlError({
            cause,
            message: formatSqlErrorMessage("SQLite", "external values statement", statement, cause),
          }),
      }),
    executeUnprepared: (statement, params, transformRows) => run(statement, params, transformRows),
    executeStream: (statement, params, transformRows) =>
      Stream.fromIterableEffect(run(statement, params, transformRows)),
  };
}
/**
 * @param {SqliteParam} value
 * @returns {unknown}
 */
function toPostgresParam(value) {
  // node-postgres maps Buffer → bytea; a bare Uint8Array does not round-trip.
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  }
  // Smithers mirrors SQLite's storage model on Postgres: JSON lives in TEXT
  // columns. SQLite/Drizzle stringify objects automatically; node-postgres does
  // not, so do it here to keep a single encoding contract across dialects.
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}
/**
 * A `@effect/sql` connection backed by a single node-postgres connection (any
 * object exposing `query({ text, values, rowMode })` — a `pg.Client`, or a
 * PGlite socket connection). Smithers writes SQL with `?` placeholders; this
 * connection rewrites them to PostgreSQL's `$n` on the way out, mirroring the
 * SQLite connection so the rest of the adapter is dialect-agnostic.
 * @param {{ query: (config: { text: string; values?: ReadonlyArray<unknown>; rowMode?: "array" }) => Promise<{ rows?: ReadonlyArray<any> }> }} pgConn
 * @returns {Connection}
 */
function createPostgresConnection(pgConn) {
  const run = (statement, params, transformRows) =>
    Effect.tryPromise({
      try: async () => {
        const text = translatePlaceholders(POSTGRES, statement);
        const result = await pgConn.query({ text, values: params.map(toPostgresParam) });
        const rows = result.rows ?? [];
        return transformRows ? transformRows(rows) : rows;
      },
      catch: (cause) =>
        new SqlError({
          cause,
          message: formatSqlErrorMessage("Postgres", "statement", statement, cause),
        }),
    });
  return {
    execute: (statement, params, transformRows) => run(statement, params, transformRows),
    executeRaw: (statement, params) => run(statement, params, undefined),
    executeValues: (statement, params) =>
      Effect.tryPromise({
        try: async () => {
          const text = translatePlaceholders(POSTGRES, statement);
          const result = await pgConn.query({
            text,
            values: params.map(toPostgresParam),
            rowMode: "array",
          });
          return result.rows ?? [];
        },
        catch: (cause) =>
          new SqlError({
            cause,
            message: formatSqlErrorMessage("Postgres", "values statement", statement, cause),
          }),
      }),
    executeUnprepared: (statement, params, transformRows) => run(statement, params, transformRows),
    executeStream: (statement, params, transformRows) =>
      Stream.fromIterableEffect(run(statement, params, transformRows)),
  };
}
export class SqlMessageStorage {
  sqlite;
  /** @type {import("./dialect.js").Dialect} */
  dialect;
  /** @type {"bun-sqlite" | "postgres" | "external-sqlite" | "cloudflare-sqlite"} */
  driverKind;
  /** @type {object | null} */
  pgConn;
  /** @type {ExternalSqliteDescriptor | null} */
  externalSqlite;
  // TODO(Phase 8): Keep this per-DB runtime until the unified runtime can
  // inject a scoped SqlClient without rebuilding the per-connection semaphore.
  runtime;
  tableColumnsCache = new Map();
  /**
   * @param {BunSQLiteDatabase<any> | Database | { dialect: "postgres"; connection: object } | ExternalSqliteDescriptor} db
   */
  constructor(db) {
    if (db && typeof db === "object" && /** @type {any} */ (db).dialect === POSTGRES) {
      this.dialect = POSTGRES;
      this.driverKind = "postgres";
      this.pgConn = /** @type {any} */ (db).connection;
      this.sqlite = null;
      this.externalSqlite = null;
      this.runtime = ManagedRuntime.make(makeSqlClientLayer(createPostgresConnection(this.pgConn), "postgresql"));
    } else if (isExternalSqliteDescriptor(db)) {
      this.dialect = SQLITE;
      this.driverKind = db.driver;
      this.sqlite = null;
      this.pgConn = null;
      this.externalSqlite = db;
      this.runtime = ManagedRuntime.make(makeSqlClientLayer(createExternalSqliteConnection(db), "sqlite"));
    } else {
      this.dialect = SQLITE;
      this.driverKind = "bun-sqlite";
      this.sqlite = resolveSqliteDatabase(db);
      this.pgConn = null;
      this.externalSqlite = null;
      this.runtime = ManagedRuntime.make(makeSqlClientLayer(createConnection(this.sqlite), "sqlite"));
    }
  }
  /**
   * @param {string} table
   * @returns {Set<string> | null}
   */
  getTableColumns(table) {
    const cached = this.tableColumnsCache.get(table);
    if (cached) {
      return cached;
    }
    if (this.dialect === POSTGRES || this.driverKind !== "bun-sqlite") {
      // A fresh PostgreSQL schema has no historical column drift to defend
      // against, and PRAGMA is unavailable. Returning null tells
      // filterKnownColumns to skip filtering, so a genuinely missing column
      // surfaces as a loud insert error rather than a silently dropped field.
      return null;
    }
    const rows = this.sqlite.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
    const columns = new Set(
      rows
        .map((row) => (typeof row.name === "string" ? snakeToCamel(row.name) : ""))
        .filter((value) => value.length > 0),
    );
    this.tableColumnsCache.set(table, columns);
    return columns;
  }
  /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @returns {Record<string, unknown>}
   */
  filterKnownColumns(table, row) {
    const knownColumns = this.getTableColumns(table);
    return Object.fromEntries(
      Object.entries(row).filter(
        ([key, value]) => value !== undefined && (knownColumns === null || knownColumns.has(key)),
      ),
    );
  }
  /**
   * @template A, E
   * @param {Effect.Effect<A, E, SqlClient.SqlClient>} effect
   * @returns {Promise<A>}
   */
  runEffect(effect) {
    return this.runtime.runPromise(effect);
  }
  /**
   * @template A
   * @param {(connection: Connection) => Effect.Effect<A, SqlError>} f
   * @returns {Promise<A>}
   */
  withConnection(f) {
    return this.runEffect(
      Effect.flatMap(SqlClient.SqlClient, (client) => Effect.scoped(Effect.flatMap(client.reserve, f))),
    );
  }
  /**
   * @returns {Effect.Effect<void, never>}
   */
  ensureSchemaEffect() {
    if (this.dialect === POSTGRES) {
      const pgConn = this.pgConn;
      return Effect.tryPromise({
        try: () =>
          runSmithersSchemaInitPostgres(pgConn, {
            createTableStatements: CREATE_TABLE_STATEMENTS,
            createIndexStatements: CREATE_INDEX_STATEMENTS,
          }),
        catch: (cause) => new SqlError({ cause, message: "Failed to initialize Postgres schema" }),
      });
    }
    if (this.externalSqlite) {
      const externalSqlite = this.externalSqlite;
      return Effect.tryPromise({
        try: () =>
          runSmithersSchemaInitSqliteAsync(externalSqlite, {
            createTableStatements: CREATE_TABLE_STATEMENTS,
            createIndexStatements: CREATE_INDEX_STATEMENTS,
          }),
        catch: (cause) => new SqlError({ cause, message: "Failed to initialize SQLite schema" }),
      });
    }
    const sqlite = this.sqlite;
    return Effect.sync(() => {
      runSmithersSchemaMigrations(sqlite, {
        createTableStatements: CREATE_TABLE_STATEMENTS,
        createIndexStatements: CREATE_INDEX_STATEMENTS,
      });
    });
  }
  /**
   * @returns {Promise<number>}
   */
  ensureSchema() {
    return this.runtime.runPromise(this.ensureSchemaEffect());
  }
  /**
   * @template T
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @param {{ booleanColumns?: readonly string[] }} [options]
   * @returns {Promise<Array<T>>}
   */
  queryAll(statement, params = [], options) {
    return this.withConnection((connection) =>
      connection
        .execute(statement, params.map(encodeParam), transformRowKeys)
        .pipe(Effect.map((rows) => rows.map((row) => applyBooleanColumns(row, options?.booleanColumns)))),
    );
  }
  /**
   * @template T
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @param {{ booleanColumns?: readonly string[] }} [options]
   * @returns {Promise<T | undefined>}
   */
  async queryOne(statement, params = [], options) {
    const rows = await this.queryAll(statement, params, options);
    return rows[0];
  }
  /**
   * Like {@link queryAll} but returns rows with their on-disk column names (no
   * snake→camel transform). Used for "raw" output-table reads where callers
   * expect the storage column names verbatim.
   * @template T
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<Array<T>>}
   */
  queryAllRaw(statement, params = []) {
    return this.withConnection((connection) => connection.execute(statement, params.map(encodeParam), undefined));
  }
  /**
   * @template T
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<T | undefined>}
   */
  async queryOneRaw(statement, params = []) {
    const rows = await this.queryAllRaw(statement, params);
    return rows[0];
  }
  /**
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<number>}
   */
  execute(statement, params = []) {
    return this.withConnection((connection) =>
      connection.executeRaw(statement, params.map(encodeParam)).pipe(Effect.asVoid),
    );
  }
  /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @returns {Promise<number>}
   */
  insertIgnore(table, row) {
    const filteredRow = this.filterKnownColumns(table, row);
    const { statement, params } = buildInsertSql(table, filteredRow, { orIgnore: true }, this.dialect);
    return this.execute(statement, params);
  }
  /**
   * Like {@link insertIgnore} but reports whether *this* call is the one that
   * inserted the row. The verdict comes from the insert's own `RETURNING`
   * rows, never from a preceding `SELECT`: PostgreSQL runs Smithers'
   * transactions at READ COMMITTED, so two concurrent claimants can both read
   * no row, and `ON CONFLICT DO NOTHING` then silently no-ops for the loser
   * instead of raising. Only the winner gets a row back.
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @returns {Promise<boolean>}
   */
  async insertIgnoreReturningInserted(table, row) {
    const filteredRow = this.filterKnownColumns(table, row);
    const { statement, params } = buildInsertSql(table, filteredRow, { orIgnore: true }, this.dialect);
    const rows = await this.queryAllRaw(`${statement} RETURNING 1`, params);
    return rows.length > 0;
  }
  /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @param {readonly string[]} conflictColumns
   * @param {readonly string[]} [updateColumns]
   * @returns {Promise<void>}
   */
  upsert(table, row, conflictColumns, updateColumns) {
    const filteredRow = this.filterKnownColumns(table, row);
    const { statement, params } = buildInsertSql(
      table,
      filteredRow,
      {
        conflictColumns,
        updateColumns,
      },
      this.dialect,
    );
    return this.execute(statement, params);
  }
  /**
   * @param {string} table
   * @param {Record<string, unknown>} patch
   * @param {string} whereSql
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<number>}
   */
  updateWhere(table, patch, whereSql, params = []) {
    const built = buildUpdateSql(table, this.filterKnownColumns(table, patch), whereSql, params);
    if (!built) {
      return Promise.resolve(0);
    }
    // Return the affected-row count from the same conditional statement
    // via RETURNING: this is the primitive used by durable compare-and-set
    // callers, and a follow-up SELECT (or a separate changes() read) would
    // reintroduce the race this result is meant to close. The statement
    // must go through the reserved connection like every other write; a
    // direct client.run bypasses the connection serialisation and can
    // interleave into another adapter's open transaction (getting rolled
    // back with it).
    return this.queryAllRaw(`${built.statement} RETURNING 1`, built.params).then((rows) => rows.length);
  }
  /**
   * @param {string} table
   * @param {string} whereSql
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<void>}
   */
  deleteWhere(table, whereSql, params = []) {
    return this.execute(`DELETE FROM ${quoteIdentifier(table)} WHERE ${whereSql}`, params);
  }
  /**
   * @template A
   * @param {() => A | Promise<A>} operation
   * @returns {Promise<A>}
   */
  async transaction(operation) {
    if (this.externalSqlite?.supportsTransactions === false) {
      throw new Error(`The ${this.externalSqlite.driver} descriptor does not support atomic transactions.`);
    }
    if (this.externalSqlite?.transaction) {
      return await this.externalSqlite.transaction(operation);
    }
    if (this.externalSqlite) {
      // A sequence of BEGIN/operation/COMMIT calls is not sufficient here:
      // the descriptor may route each call to a different connection, and
      // other storage calls could interleave. Only a descriptor-owned
      // callback can hold the physical transaction boundary atomically.
      throw new Error(`The ${this.externalSqlite.driver} descriptor must provide an atomic transaction() callback.`);
    }
    return await operation();
  }
  /**
   * Allocate and insert one append-only stream row on PostgreSQL. The insert
   * computes the next sequence and writes it in one statement. A concurrent
   * writer that chose the same sequence gets no RETURNING row, so it must
   * recheck idempotency and retry instead of reporting a row PostgreSQL
   * ignored.
   *
   * The NOT EXISTS predicate is part of the INSERT statement so an identical
   * redelivery that becomes visible after the first lookup cannot consume a
   * second sequence.
   *
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @param {string} dedupeWhereSql
   * @param {ReadonlyArray<SqliteParam>} dedupeParams
   * @returns {Promise<number>}
   */
  async insertWithNextSeqPostgres(table, row, dedupeWhereSql, dedupeParams) {
    if (this.dialect !== POSTGRES) {
      throw new Error("Atomic PostgreSQL sequence allocation requires the postgres dialect.");
    }
    const filteredRow = this.filterKnownColumns(table, row);
    const entries = Object.entries(filteredRow).filter(([key, value]) => key !== "seq" && value !== undefined);
    const runId = entries.find(([key]) => key === "runId")?.[1];
    if (typeof runId !== "string") {
      throw new Error("Atomic PostgreSQL sequence allocation requires a runId.");
    }
    const tableSql = quoteIdentifier(table);
    const columnSql = [...entries.map(([key]) => quoteIdentifier(camelToSnake(key))), quoteIdentifier("seq")].join(
      ", ",
    );
    const valueSql = [...entries.map(() => "?"), "COALESCE(MAX(seq), -1) + 1"].join(", ");
    const insertSql = `INSERT INTO ${tableSql} (${columnSql})
            SELECT ${valueSql}
            FROM ${tableSql}
            WHERE run_id = ?
            HAVING NOT EXISTS (
                SELECT 1 FROM ${tableSql} WHERE ${dedupeWhereSql}
            )
            ON CONFLICT (run_id, seq) DO NOTHING
            RETURNING seq`;
    const insertParams = [...entries.map(([, value]) => value), runId, ...dedupeParams];

    // Smithers-owned transactions use PostgreSQL's default READ COMMITTED
    // isolation, so each retry sees the winner. Keep a hard ceiling for a
    // caller-owned fixed snapshot or sustained contention: failure is loud,
    // and no sequence is reported without a RETURNING row or dedupe match.
    for (let attempt = 0; attempt < POSTGRES_SEQUENCE_ALLOCATION_MAX_ATTEMPTS; attempt += 1) {
      const existing = await this.queryOne(
        `SELECT seq
                FROM ${tableSql}
                WHERE ${dedupeWhereSql}
                ORDER BY seq DESC
                LIMIT 1`,
        dedupeParams,
      );
      if (existing?.seq !== undefined) {
        return Number(existing.seq);
      }
      const inserted = await this.queryAllRaw(insertSql, insertParams);
      if (inserted[0]?.seq !== undefined) {
        return Number(inserted[0].seq);
      }
    }
    throw new Error(
      `PostgreSQL sequence allocation for ${table} did not converge after ${POSTGRES_SEQUENCE_ALLOCATION_MAX_ATTEMPTS} conflicts.`,
    );
  }
  /**
   * @param {{ runId: string; timestampMs: number; type: string; payloadJson: string; }} row
   * @returns {Promise<number>}
   */
  insertEventWithNextSeqPostgres(row) {
    const dedupeWhereSql = `run_id = ?
            AND timestamp_ms = ?
            AND type = ?
            AND payload_json = ?`;
    return this.insertWithNextSeqPostgres("_smithers_events", row, dedupeWhereSql, [
      row.runId,
      row.timestampMs,
      row.type,
      row.payloadJson,
    ]);
  }
  /**
   * @param {{ runId: string; signalName: string; correlationId: string | null; payloadJson: string; receivedAtMs: number; receivedBy?: string | null; }} row
   * @returns {Promise<number>}
   */
  insertSignalWithNextSeqPostgres(row) {
    const dedupeWhereSql = `run_id = ?
            AND signal_name = ?
            AND ${row.correlationId === null ? "correlation_id IS NULL" : "correlation_id = ?"}
            AND payload_json = ?
            AND received_at_ms = ?
            AND ${row.receivedBy == null ? "received_by IS NULL" : "received_by = ?"}`;
    const dedupeParams = [
      row.runId,
      row.signalName,
      ...(row.correlationId === null ? [] : [row.correlationId]),
      row.payloadJson,
      row.receivedAtMs,
      ...(row.receivedBy == null ? [] : [row.receivedBy]),
    ];
    const values = { ...row, receivedBy: row.receivedBy ?? null };
    return (async () => {
      for (let attempt = 0; attempt < POSTGRES_SEQUENCE_ALLOCATION_MAX_ATTEMPTS; attempt += 1) {
        const existing = await this.queryOne(
          `SELECT seq FROM _smithers_signals WHERE ${dedupeWhereSql} ORDER BY seq DESC LIMIT 1`,
          dedupeParams,
        );
        if (existing?.seq !== undefined) return Number(existing.seq);
        const inserted = await this.queryAllRaw(
          `INSERT INTO _smithers_signals (run_id, signal_name, correlation_id, payload_json, received_at_ms, received_by, seq)
                    SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(seq), -1) + 1
                    FROM (SELECT seq FROM _smithers_signals WHERE run_id = ? UNION ALL SELECT seq FROM _smithers_output_provenance WHERE run_id = ?) AS clock
                    WHERE NOT EXISTS (SELECT 1 FROM _smithers_signals WHERE ${dedupeWhereSql})
                    ON CONFLICT (run_id, seq) DO NOTHING RETURNING seq`,
          [
            values.runId,
            values.signalName,
            values.correlationId,
            values.payloadJson,
            values.receivedAtMs,
            values.receivedBy,
            values.runId,
            values.runId,
            ...dedupeParams,
          ],
        );
        if (inserted[0]?.seq !== undefined) return Number(inserted[0].seq);
      }
      throw new Error(
        `PostgreSQL signal sequence allocation did not converge after ${POSTGRES_SEQUENCE_ALLOCATION_MAX_ATTEMPTS} conflicts.`,
      );
    })();
  }
  /**
   * @param {string} runId
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {{ whereSql: string; params: Array<SqliteParam> }}
   */
  buildEventHistoryWhere(runId, query = {}) {
    const clauses = ["run_id = ?", "seq > ?"];
    const params = [runId, query.afterSeq ?? -1];
    if (typeof query.sinceTimestampMs === "number") {
      clauses.push("timestamp_ms >= ?");
      params.push(query.sinceTimestampMs);
    }
    if (query.types && query.types.length > 0) {
      clauses.push(`type IN (${query.types.map(() => "?").join(", ")})`);
      params.push(...query.types);
    }
    if (query.nodeId) {
      clauses.push(`${jsonExtractText(this.dialect, "payload_json", "$.nodeId")} = ?`);
      params.push(query.nodeId);
    }
    return {
      whereSql: clauses.join(" AND "),
      params,
    };
  }
  /**
   * @param {string} runId
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  listEventHistory(runId, query = {}) {
    const limit = Math.max(1, Math.floor(query.limit ?? 200));
    const { whereSql, params } = this.buildEventHistoryWhere(runId, query);
    return this.queryAll(
      `SELECT * FROM _smithers_events
       WHERE ${whereSql}
       ORDER BY seq ASC
       LIMIT ?`,
      [...params, limit],
    );
  }
  /**
   * @param {string} runId
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {Promise<number>}
   */
  async countEventHistory(runId, query = {}) {
    const { whereSql, params } = this.buildEventHistoryWhere(runId, query);
    const row = await this.queryOne(
      `SELECT COUNT(*) AS count
       FROM _smithers_events
       WHERE ${whereSql}`,
      params,
    );
    return Number(row?.count ?? 0);
  }
  /**
   * @param {string} runId
   * @returns {Promise<number | undefined>}
   */
  async getLastEventSeq(runId) {
    const row = await this.queryOne(
      `SELECT seq
       FROM _smithers_events
       WHERE run_id = ?
       ORDER BY seq DESC
       LIMIT 1`,
      [runId],
    );
    return row?.seq;
  }
  /**
   * @param {string} runId
   * @param {string} type
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  listEventsByType(runId, type) {
    return this.queryAll(
      `SELECT *
       FROM _smithers_events
       WHERE run_id = ? AND type = ?
       ORDER BY seq ASC`,
      [runId, type],
    );
  }
  /**
   * @param {string} runId
   * @returns {Promise<number | undefined>}
   */
  async getLastSignalSeq(runId) {
    return this.getLastRunProvenanceSeq(runId);
  }
  /** @param {string} runId @returns {Promise<number | undefined>} */
  async getLastRunProvenanceSeq(runId) {
    const row = await this.queryOne(
      `SELECT seq
       FROM (
         SELECT seq FROM _smithers_signals WHERE run_id = ?
         UNION ALL
         SELECT seq FROM _smithers_output_provenance WHERE run_id = ?
       )
       ORDER BY seq DESC
       LIMIT 1`,
      [runId, runId],
    );
    return row?.seq;
  }
}
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {SqlMessageStorage}
 */
export function getSqlMessageStorage(db) {
  return new SqlMessageStorage(db);
}
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Effect.Effect<void, never>}
 */
export function ensureSqlMessageStorageEffect(db) {
  return getSqlMessageStorage(db).ensureSchemaEffect();
}
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Promise<void>}
 */
export function ensureSqlMessageStorage(db) {
  return getSqlMessageStorage(db).ensureSchema();
}
