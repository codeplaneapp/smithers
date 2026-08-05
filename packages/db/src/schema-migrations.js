import { Effect } from "effect";
import { POSTGRES, quoteIdentifier, translateDdl } from "./dialect.js";

const MIGRATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS _smithers_schema_migrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL,
    checksum TEXT,
    destructive INTEGER NOT NULL DEFAULT 0,
    details_json TEXT
  )`;

const DELETE_DUPLICATE_SCORER_ROWS_SQL = `DELETE FROM _smithers_scorers
  WHERE id IN (
    SELECT id
    FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY run_id, node_id, iteration, attempt, scorer_id, source
               ORDER BY scored_at_ms DESC, id DESC
             ) AS duplicate_rank
      FROM _smithers_scorers
    ) ranked
    WHERE duplicate_rank > 1
  )`;
const CREATE_SCORER_IDENTITY_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS _smithers_scorers_identity_uidx
  ON _smithers_scorers (run_id, node_id, iteration, attempt, scorer_id, source)`;

const RUN_CANCELLATION_ATTRIBUTION_COLUMNS = [
  ["cancel_request_id", "cancel_request_id TEXT"],
  ["cancel_request_source", "cancel_request_source TEXT"],
  ["cancel_request_client_identity", "cancel_request_client_identity TEXT"],
  ["cancel_request_client_pid", "cancel_request_client_pid INTEGER"],
];

const RUN_OWNED_FOREIGN_KEY_TABLES = [
  {
    table: "_smithers_frames",
    columns: [
      "run_id",
      "frame_no",
      "created_at_ms",
      "xml_json",
      "xml_hash",
      "encoding",
      "mounted_task_ids_json",
      "task_index_json",
      "note",
    ],
    defaults: { encoding: "'full'" },
  },
  {
    table: "_smithers_node_diffs",
    columns: ["run_id", "node_id", "iteration", "base_ref", "diff_json", "computed_at_ms", "size_bytes"],
  },
  {
    table: "_smithers_time_travel_audit",
    columns: ["id", "run_id", "from_frame_no", "to_frame_no", "caller", "timestamp_ms", "result", "duration_ms"],
  },
];

const LEGACY_COLUMN_MIGRATIONS = [
  {
    id: "0002_attempt_legacy_columns",
    name: "Add legacy attempt operational columns",
    table: "_smithers_attempts",
    columns: [
      ["response_text", "response_text TEXT"],
      ["jj_cwd", "jj_cwd TEXT"],
      ["heartbeat_at_ms", "heartbeat_at_ms INTEGER"],
      ["heartbeat_data_json", "heartbeat_data_json TEXT"],
      ["cached", "cached INTEGER DEFAULT 0"],
      ["meta_json", "meta_json TEXT"],
    ],
  },
  {
    id: "0003_run_legacy_columns",
    name: "Add legacy run operational columns",
    table: "_smithers_runs",
    columns: [
      ["workflow_path", "workflow_path TEXT"],
      ["started_at_ms", "started_at_ms INTEGER"],
      ["finished_at_ms", "finished_at_ms INTEGER"],
      ["workflow_hash", "workflow_hash TEXT"],
      ["heartbeat_at_ms", "heartbeat_at_ms INTEGER"],
      ["runtime_owner_id", "runtime_owner_id TEXT"],
      ["cancel_requested_at_ms", "cancel_requested_at_ms INTEGER"],
      ["hijack_requested_at_ms", "hijack_requested_at_ms INTEGER"],
      ["hijack_target", "hijack_target TEXT"],
      ["vcs_type", "vcs_type TEXT"],
      ["vcs_root", "vcs_root TEXT"],
      ["vcs_revision", "vcs_revision TEXT"],
      ["parent_run_id", "parent_run_id TEXT"],
      ["error_json", "error_json TEXT"],
      ["config_json", "config_json TEXT"],
    ],
  },
  {
    id: "0004_approval_payload_columns",
    name: "Add approval payload columns",
    table: "_smithers_approvals",
    columns: [
      ["request_json", "request_json TEXT"],
      ["decision_json", "decision_json TEXT"],
      ["auto_approved", "auto_approved INTEGER NOT NULL DEFAULT 0"],
    ],
  },
  {
    id: "0005_alert_model_extensions",
    name: "Add alert model extension columns",
    table: "_smithers_alerts",
    columns: [
      ["fingerprint", "fingerprint TEXT"],
      ["node_id", "node_id TEXT"],
      ["iteration", "iteration INTEGER"],
      ["owner", "owner TEXT"],
      ["runbook", "runbook TEXT"],
      ["labels_json", "labels_json TEXT"],
      ["reaction_json", "reaction_json TEXT"],
      ["source_event_type", "source_event_type TEXT"],
      ["first_fired_at_ms", "first_fired_at_ms INTEGER"],
      ["last_fired_at_ms", "last_fired_at_ms INTEGER"],
      ["occurrence_count", "occurrence_count INTEGER DEFAULT 1"],
      ["silenced_until_ms", "silenced_until_ms INTEGER"],
      ["acknowledged_by", "acknowledged_by TEXT"],
      ["resolved_by", "resolved_by TEXT"],
    ],
  },
  {
    id: "0006_frame_encoding_column",
    name: "Add frame encoding column",
    table: "_smithers_frames",
    columns: [["encoding", "encoding TEXT NOT NULL DEFAULT 'full'"]],
  },
  {
    id: "0007_event_timestamp_column",
    name: "Add event timestamp column",
    table: "_smithers_events",
    columns: [["timestamp_ms", "timestamp_ms INTEGER NOT NULL DEFAULT 0"]],
  },
  {
    id: "0021_memory_fact_provenance_columns",
    name: "Add provenance columns to memory facts",
    table: "_smithers_memory_facts",
    columns: [
      ["run_id", "run_id TEXT"],
      ["node_id", "node_id TEXT"],
      ["iteration", "iteration INTEGER"],
    ],
  },
  {
    id: "0022_memory_message_iteration_column",
    name: "Add iteration provenance column to memory messages",
    table: "_smithers_memory_messages",
    columns: [["iteration", "iteration INTEGER"]],
  },
];

const EXTRA_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS _smithers_runs_parent_idx ON _smithers_runs (parent_run_id)`,
  `CREATE INDEX IF NOT EXISTS _smithers_alerts_fingerprint_idx ON _smithers_alerts (fingerprint)`,
  `CREATE INDEX IF NOT EXISTS _smithers_alerts_run_status_idx ON _smithers_alerts (run_id, status)`,
];

const TOOL_EFFECT_JOURNAL_COLUMNS = [
  ["kind", "kind TEXT"],
  ["side_effect", "side_effect INTEGER"],
  ["idempotent", "idempotent INTEGER"],
  ["accepts_idempotency_key", "accepts_idempotency_key INTEGER"],
  ["has_revert", "has_revert INTEGER"],
  ["idempotency_key", "idempotency_key TEXT"],
  // null | reverting | reverted | revert-failed | revert-stale
  ["revert_status", "revert_status TEXT"],
  ["reverted_at_ms", "reverted_at_ms INTEGER"],
  ["revert_error_json", "revert_error_json TEXT"],
  ["forced_past_json", "forced_past_json TEXT"],
];

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 */
function tableExists(sqlite, table) {
  return Boolean(sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
}

/**
 * Extract the target table name from a `CREATE INDEX ... ON <table> (...)`
 * statement so the "current indexes" migration can skip an index whose table a
 * later migration has not created yet (e.g. a store upgrading from a ledger that
 * predates `_smithers_docs`). Returns null when no table can be parsed, in which
 * case the statement runs unguarded.
 *
 * @param {string} statement
 * @returns {string | null}
 */
function indexTargetTable(statement) {
  const match = /\bON\s+"?([A-Za-z0-9_]+)"?/i.exec(statement);
  return match ? match[1] : null;
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 */
function tableColumnNames(sqlite, table) {
  if (!tableExists(sqlite, table)) {
    return new Set();
  }
  return new Set(
    sqlite
      .query(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map((row) => row.name)
      .filter((name) => typeof name === "string"),
  );
}

/**
 * Backfill legacy output rows after the current schema has pre-created the
 * provenance table. The migration ledger, rather than table presence, is the
 * completion marker: table creation happens in the current-schema bootstrap.
 */
function backfillOutputProvenanceSqlite(sqlite) {
  if (!tableExists(sqlite, "_smithers_output_provenance") || !tableExists(sqlite, "_smithers_nodes")) {
    return { backfilled: 0 };
  }
  const outputTables = new Set(
    sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_smithers_%' ORDER BY name")
      .all()
      .map((row) => row.name)
      .filter((name) => typeof name === "string"),
  );
  const nodes = sqlite
    .query(
      "SELECT DISTINCT run_id, output_table FROM _smithers_nodes WHERE output_table IS NOT NULL ORDER BY run_id, output_table",
    )
    .all();
  const nextByRun = new Map();
  let backfilled = 0;
  for (const node of nodes) {
    const candidate = String(node.output_table);
    // Older node rows sometimes stored the schema key instead of the
    // physical table name. Resolve it from the actual SQLite catalog.
    const tableName = outputTables.has(candidate)
      ? candidate
      : [...outputTables].find((name) => name === candidate.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    if (!tableName) continue;
    const columns = tableColumnNames(sqlite, tableName);
    if (!columns.has("run_id") || !columns.has("node_id") || !columns.has("iteration")) continue;
    const rows = sqlite
      .query(`SELECT run_id, node_id, iteration FROM ${quoteIdentifier(tableName)} WHERE run_id = ? ORDER BY rowid`)
      .all(node.run_id);
    for (const row of rows) {
      const iteration = Number(row.iteration ?? 0);
      const found = sqlite
        .query(
          `SELECT 1 FROM _smithers_output_provenance WHERE run_id = ? AND output_table = ? AND node_id = ? AND iteration = ? LIMIT 1`,
        )
        .get(row.run_id, tableName, row.node_id, iteration);
      if (found) continue;
      let next = nextByRun.get(row.run_id);
      if (next === undefined) {
        next = Number(
          sqlite
            .query(
              "SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM (SELECT seq FROM _smithers_output_provenance WHERE run_id = ? UNION ALL SELECT seq FROM _smithers_signals WHERE run_id = ?)",
            )
            .get(row.run_id, row.run_id)?.seq ?? 0,
        );
      }
      sqlite.run(
        "INSERT INTO _smithers_output_provenance (run_id, output_table, node_id, iteration, seq) VALUES (?, ?, ?, ?, ?)",
        row.run_id,
        tableName,
        row.node_id,
        iteration,
        next,
      );
      nextByRun.set(row.run_id, next + 1);
      backfilled += 1;
    }
  }
  return { backfilled };
}

function indexExists(sqlite, index) {
  return Boolean(sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index));
}

const SNAPSHOT_SQLITE_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS _smithers_snapshot_payload_refs_insert
     AFTER INSERT ON _smithers_snapshot_payload_refs
     BEGIN
       SELECT RAISE(ABORT, 'snapshot payload reference does not match a compact snapshot')
       WHERE NOT EXISTS (
         SELECT 1 FROM _smithers_snapshots
         WHERE run_id = NEW.run_id
           AND frame_no = NEW.frame_no
           AND content_hash = NEW.content_hash
           AND nodes_json = '' AND outputs_json = '' AND ralph_json = '' AND input_json = ''
       );
       SELECT RAISE(ABORT, 'missing snapshot content')
       WHERE NOT EXISTS (
         SELECT 1 FROM _smithers_snapshot_contents WHERE content_hash = NEW.content_hash
       );
       UPDATE _smithers_snapshot_contents
       SET ref_count = ref_count + 1
       WHERE content_hash = NEW.content_hash;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _smithers_snapshot_payload_refs_delete
     AFTER DELETE ON _smithers_snapshot_payload_refs
     BEGIN
       UPDATE _smithers_snapshot_contents
       SET ref_count = ref_count - 1
       WHERE content_hash = OLD.content_hash;
       DELETE FROM _smithers_snapshot_contents
       WHERE content_hash = OLD.content_hash AND ref_count = 0;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _smithers_snapshot_payload_refs_update
     AFTER UPDATE OF content_hash ON _smithers_snapshot_payload_refs
     WHEN OLD.content_hash IS NOT NEW.content_hash
     BEGIN
       SELECT RAISE(ABORT, 'snapshot payload reference does not match a compact snapshot')
       WHERE NOT EXISTS (
         SELECT 1 FROM _smithers_snapshots
         WHERE run_id = NEW.run_id
           AND frame_no = NEW.frame_no
           AND content_hash = NEW.content_hash
           AND nodes_json = '' AND outputs_json = '' AND ralph_json = '' AND input_json = ''
       );
       SELECT RAISE(ABORT, 'missing snapshot content')
       WHERE NOT EXISTS (
         SELECT 1 FROM _smithers_snapshot_contents WHERE content_hash = NEW.content_hash
       );
       UPDATE _smithers_snapshot_contents
       SET ref_count = ref_count - 1
       WHERE content_hash = OLD.content_hash;
       DELETE FROM _smithers_snapshot_contents
       WHERE content_hash = OLD.content_hash AND ref_count = 0;
       UPDATE _smithers_snapshot_contents
       SET ref_count = ref_count + 1
       WHERE content_hash = NEW.content_hash;
     END`,
  // `smithersSnapshots` remains a public low-level table API. If an inline
  // writer replaces a compact row, retire its content reference in the same
  // statement so mixed-version writers remain readable and do not leak the
  // formerly referenced content.
  `CREATE TRIGGER IF NOT EXISTS _smithers_snapshots_payload_refs_reconcile
     AFTER UPDATE OF content_hash, nodes_json, outputs_json, ralph_json, input_json ON _smithers_snapshots
     WHEN EXISTS (
       SELECT 1 FROM _smithers_snapshot_payload_refs
       WHERE run_id = NEW.run_id
         AND frame_no = NEW.frame_no
         AND (
           content_hash IS NOT NEW.content_hash
           OR NOT (NEW.nodes_json = '' AND NEW.outputs_json = '' AND NEW.ralph_json = '' AND NEW.input_json = '')
         )
     )
     BEGIN
       DELETE FROM _smithers_snapshot_payload_refs
       WHERE run_id = NEW.run_id AND frame_no = NEW.frame_no;
     END`,
  // Foreign-key cascades normally own this deletion. The trigger keeps the
  // invariant on SQLite-compatible edge runtimes that reject PRAGMA
  // foreign_keys while remaining a no-op when the FK already cascaded.
  `CREATE TRIGGER IF NOT EXISTS _smithers_snapshots_payload_refs_cascade
     AFTER DELETE ON _smithers_snapshots
     BEGIN
       DELETE FROM _smithers_snapshot_payload_refs
       WHERE run_id = OLD.run_id AND frame_no = OLD.frame_no;
     END`,
];

// An unreleased compressed-payload prototype (superseded by 0025's
// content-addressed tables) installed these triggers. Later prototype
// iterations removed the _smithers_snapshot_payloads.ref_count column their
// bodies update, and SQLite compiles trigger bodies when the triggering
// statement is prepared, so a store that ran the prototype fails EVERY
// _smithers_snapshots insert with "no such column: ref_count" even though
// payload_hash is NULL. 0026 retires the triggers; the payloads table itself
// stays readable for legacy payload_b64 lookups.
const SNAPSHOT_PROTOTYPE_TRIGGERS = [
  ["_smithers_snapshot_payload_insert", "_smithers_snapshots"],
  ["_smithers_snapshot_payload_delete", "_smithers_snapshots"],
  ["_smithers_snapshot_payload_update", "_smithers_snapshots"],
  ["_smithers_snapshot_payload_immutable", "_smithers_snapshot_payloads"],
];

const SNAPSHOT_POSTGRES_FUNCTION = `CREATE OR REPLACE FUNCTION _smithers_snapshot_payload_refcount() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM _smithers_snapshots
      WHERE run_id = NEW.run_id
        AND frame_no = NEW.frame_no
        AND content_hash = NEW.content_hash
        AND nodes_json = '' AND outputs_json = '' AND ralph_json = '' AND input_json = ''
    ) THEN
      RAISE EXCEPTION 'snapshot payload reference does not match a compact snapshot' USING ERRCODE = 'foreign_key_violation';
    END IF;
    UPDATE _smithers_snapshot_contents SET ref_count = ref_count + 1 WHERE content_hash = NEW.content_hash;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'missing snapshot content %', NEW.content_hash USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE _smithers_snapshot_contents SET ref_count = ref_count - 1 WHERE content_hash = OLD.content_hash;
    DELETE FROM _smithers_snapshot_contents WHERE content_hash = OLD.content_hash AND ref_count = 0;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' AND OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN
    IF NOT EXISTS (
      SELECT 1 FROM _smithers_snapshots
      WHERE run_id = NEW.run_id
        AND frame_no = NEW.frame_no
        AND content_hash = NEW.content_hash
        AND nodes_json = '' AND outputs_json = '' AND ralph_json = '' AND input_json = ''
    ) THEN
      RAISE EXCEPTION 'snapshot payload reference does not match a compact snapshot' USING ERRCODE = 'foreign_key_violation';
    END IF;
    UPDATE _smithers_snapshot_contents SET ref_count = ref_count - 1 WHERE content_hash = OLD.content_hash;
    DELETE FROM _smithers_snapshot_contents WHERE content_hash = OLD.content_hash AND ref_count = 0;
    UPDATE _smithers_snapshot_contents SET ref_count = ref_count + 1 WHERE content_hash = NEW.content_hash;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'missing snapshot content %', NEW.content_hash USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END $$`;

const SNAPSHOT_POSTGRES_RECONCILE_FUNCTION = `CREATE OR REPLACE FUNCTION _smithers_snapshot_parent_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM _smithers_snapshot_payload_refs
  WHERE run_id = NEW.run_id
    AND frame_no = NEW.frame_no
    AND (
      content_hash IS DISTINCT FROM NEW.content_hash
      OR NOT (NEW.nodes_json = '' AND NEW.outputs_json = '' AND NEW.ralph_json = '' AND NEW.input_json = '')
    );
  RETURN NEW;
END $$`;

async function installSnapshotTriggersPostgres(pgConn) {
  await pgConn.query({ text: SNAPSHOT_POSTGRES_FUNCTION });
  await pgConn.query({ text: SNAPSHOT_POSTGRES_RECONCILE_FUNCTION });
  await pgConn.query({
    text: `DROP TRIGGER IF EXISTS _smithers_snapshot_payload_refcount ON _smithers_snapshot_payload_refs`,
  });
  await pgConn.query({
    text: `CREATE TRIGGER _smithers_snapshot_payload_refcount AFTER INSERT OR UPDATE OF content_hash OR DELETE ON _smithers_snapshot_payload_refs FOR EACH ROW EXECUTE FUNCTION _smithers_snapshot_payload_refcount()`,
  });
  await pgConn.query({ text: `DROP TRIGGER IF EXISTS _smithers_snapshot_parent_reconcile ON _smithers_snapshots` });
  await pgConn.query({
    text: `CREATE TRIGGER _smithers_snapshot_parent_reconcile AFTER UPDATE OF content_hash, nodes_json, outputs_json, ralph_json, input_json ON _smithers_snapshots FOR EACH ROW EXECUTE FUNCTION _smithers_snapshot_parent_reconcile()`,
  });
}

/**
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows?: readonly Record<string, unknown>[] }> }} pgConn
 * @param {string} table
 */
async function tableExistsPostgres(pgConn, table) {
  const result = await pgConn.query({
    text: "SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1 LIMIT 1",
    values: [table],
  });
  return Boolean(result.rows?.[0]);
}

/**
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows?: readonly Record<string, unknown>[] }> }} pgConn
 * @param {string} table
 */
async function tableColumnNamesPostgres(pgConn, table) {
  if (!(await tableExistsPostgres(pgConn, table))) {
    return new Set();
  }
  const result = await pgConn.query({
    text: "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
    values: [table],
  });
  return new Set((result.rows ?? []).map((row) => row.name).filter((name) => typeof name === "string"));
}

async function indexExistsPostgres(pgConn, index) {
  const result = await pgConn.query({
    text: "SELECT 1 AS ok FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1 LIMIT 1",
    values: [index],
  });
  return Boolean(result.rows?.[0]);
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 */
function tableHasRunForeignKey(sqlite, table) {
  if (!tableExists(sqlite, table)) {
    return false;
  }
  return sqlite
    .query(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
    .all()
    .some(
      (row) =>
        row.from === "run_id" &&
        row.table === "_smithers_runs" &&
        row.to === "run_id" &&
        String(row.on_delete ?? "").toUpperCase() === "CASCADE",
    );
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 * @param {string} [whereSql]
 */
function countRows(sqlite, table, whereSql = "") {
  const row = sqlite.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} ${whereSql}`).get();
  return Number(row?.count ?? 0);
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 */
function nextLegacyTableName(sqlite, table) {
  let suffix = 0;
  while (true) {
    const candidate = `${table}__legacy_fk_${suffix}`;
    if (!tableExists(sqlite, candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

/**
 * @param {string} table
 * @param {readonly string[]} createTableStatements
 */
function createTableStatementFor(table, createTableStatements) {
  const statement = createTableStatements.find((candidate) =>
    candidate.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
  );
  if (!statement) {
    throw new Error(`Missing create statement for ${table}`);
  }
  return statement;
}

/**
 * @param {readonly string[]} createTableStatements
 */
function currentTableNames(createTableStatements) {
  return createTableStatements
    .map((statement) =>
      statement.match(/CREATE TABLE IF NOT EXISTS\s+("?[_a-zA-Z0-9]+"?)\s*\(/i)?.[1]?.replace(/^"|"$/g, ""),
    )
    .filter((name) => typeof name === "string" && name.length > 0);
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 * @param {string} column
 * @param {string} definition
 */
function addColumnIfMissing(sqlite, table, column, definition) {
  const columns = tableColumnNames(sqlite, table);
  if (columns.has(column)) {
    return false;
  }
  sqlite.run(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${definition}`);
  return true;
}

/**
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<unknown> }} pgConn
 * @param {string} table
 * @param {string} column
 * @param {string} definition
 */
async function addColumnIfMissingPostgres(pgConn, table, column, definition) {
  const columns = await tableColumnNamesPostgres(pgConn, table);
  if (columns.has(column)) {
    return false;
  }
  await pgConn.query({
    text: `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${translateDdl(POSTGRES, definition)}`,
  });
  return true;
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {{ table: string; columns: readonly string[]; defaults?: Record<string, string>; }} config
 * @param {readonly string[]} createTableStatements
 */
function rebuildRunOwnedForeignKeyTable(sqlite, config, createTableStatements) {
  if (!tableExists(sqlite, config.table)) {
    return { table: config.table, beforeCount: 0, keptCount: 0, droppedCount: 0, skipped: "missing" };
  }
  if (tableHasRunForeignKey(sqlite, config.table)) {
    const count = countRows(sqlite, config.table);
    return { table: config.table, beforeCount: count, keptCount: count, droppedCount: 0, skipped: "has_fk" };
  }

  const beforeCount = countRows(sqlite, config.table);
  const legacyTable = nextLegacyTableName(sqlite, config.table);
  sqlite.run("PRAGMA foreign_keys = OFF");
  sqlite.run("BEGIN IMMEDIATE");
  try {
    sqlite.run(`ALTER TABLE ${quoteIdentifier(config.table)} RENAME TO ${quoteIdentifier(legacyTable)}`);
    sqlite.run(createTableStatementFor(config.table, createTableStatements));
    const legacyColumns = tableColumnNames(sqlite, legacyTable);
    const columnSql = config.columns.map(quoteIdentifier).join(", ");
    const selectSql = config.columns
      .map((column) => (legacyColumns.has(column) ? quoteIdentifier(column) : (config.defaults?.[column] ?? "NULL")))
      .join(", ");
    const validRunWhere = legacyColumns.has("run_id")
      ? `WHERE ${quoteIdentifier("run_id")} IN (SELECT run_id FROM ${quoteIdentifier("_smithers_runs")})`
      : "WHERE 0";
    const keptCount = countRows(sqlite, legacyTable, validRunWhere);
    sqlite.run(`INSERT INTO ${quoteIdentifier(config.table)} (${columnSql})
           SELECT ${selectSql} FROM ${quoteIdentifier(legacyTable)} ${validRunWhere}`);
    sqlite.run(`DROP TABLE ${quoteIdentifier(legacyTable)}`);
    sqlite.run("COMMIT");
    return {
      table: config.table,
      beforeCount,
      keptCount,
      droppedCount: beforeCount - keptCount,
    };
  } catch (error) {
    try {
      sqlite.run("ROLLBACK");
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  } finally {
    sqlite.run("PRAGMA foreign_keys = ON");
  }
}

/**
 * @param {readonly string[]} statements
 */
function checksumForStatements(statements) {
  return statements.join("\n-- statement --\n");
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} id
 */
function hasMigrationRecord(sqlite, id) {
  return Boolean(sqlite.query("SELECT id FROM _smithers_schema_migrations WHERE id = ? LIMIT 1").all(id)[0]);
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 */
function loadAppliedMigrationIds(sqlite) {
  return new Set(
    sqlite
      .query("SELECT id FROM _smithers_schema_migrations")
      .all()
      .map((/** @type {{ id: string }} */ row) => row.id),
  );
}

/**
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows?: readonly Record<string, unknown>[] }> }} pgConn
 */
async function loadAppliedMigrationIdsPostgres(pgConn) {
  const result = await pgConn.query({ text: "SELECT id FROM _smithers_schema_migrations" });
  return new Set((result.rows ?? []).map((row) => row.id).filter((id) => typeof id === "string"));
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {{ id: string; name: string; checksum?: string; destructive?: boolean; }} migration
 * @param {unknown} details
 */
function recordMigration(sqlite, migration, details) {
  sqlite
    .query(
      `INSERT INTO _smithers_schema_migrations (id, name, applied_at_ms, checksum, destructive, details_json)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO NOTHING`,
    )
    .run(
      migration.id,
      migration.name,
      Date.now(),
      migration.checksum ?? null,
      migration.destructive ? 1 : 0,
      details === undefined ? null : JSON.stringify(details),
    );
}

/**
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<unknown> }} pgConn
 * @param {{ id: string; name: string; checksum?: string; destructive?: boolean; }} migration
 * @param {unknown} details
 */
async function recordMigrationPostgres(pgConn, migration, details) {
  await pgConn.query({
    text: `INSERT INTO _smithers_schema_migrations
          (id, name, applied_at_ms, checksum, destructive, details_json)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO NOTHING`,
    values: [
      migration.id,
      migration.name,
      Date.now(),
      migration.checksum ?? null,
      migration.destructive ? 1 : 0,
      details === undefined ? null : JSON.stringify(details),
    ],
  });
}

/**
 * @param {{ id: string; destructive?: boolean; }} migration
 * @param {any} details
 */
function logDestructiveMigration(migration, details) {
  if (!migration.destructive || !details?.tables) {
    return;
  }
  const droppedCount = details.tables.reduce((sum, row) => sum + Number(row.droppedCount ?? 0), 0);
  if (droppedCount <= 0) {
    return;
  }
  // Route through Effect's structured logger (spans + annotations reach the
  // observability sink) instead of console.warn, which bypasses it.
  Effect.runSync(
    Effect.logWarning(`migration ${migration.id} dropped ${droppedCount} orphan run-owned rows`).pipe(
      Effect.annotateLogs({
        migrationId: migration.id,
        droppedCount,
        droppedTables: details.tables,
      }),
      Effect.withLogSpan("db:schema-migration"),
    ),
  );
}

/**
 * Run one SQLite schema migration inside an Effect span while preserving the
 * existing synchronous migration API.
 *
 * @param {{
 *   id: string;
 *   name: string;
 *   checksum?: string;
 *   destructive?: boolean;
 *   isApplied: (sqlite: import("bun:sqlite").Database) => boolean;
 *   up: (sqlite: import("bun:sqlite").Database) => unknown;
 * }} migration
 * @param {() => unknown} run
 */
function runSqliteMigrationSpan(migration, run) {
  const start = Date.now();
  return Effect.runSync(
    Effect.sync(() => {
      const details = run();
      const durationMs = Date.now() - start;
      Effect.runSync(
        Effect.logDebug("db.schema_migration.applied").pipe(
          Effect.annotateLogs({
            dbDialect: "sqlite",
            migrationId: migration.id,
            migrationName: migration.name,
            durationMs,
          }),
        ),
      );
      return details;
    }).pipe(
      Effect.annotateLogs({
        dbDialect: "sqlite",
        migrationId: migration.id,
        migrationName: migration.name,
      }),
      Effect.withLogSpan("db:schema-migration"),
    ),
  );
}

/**
 * @param {{
 *   createTableStatements: readonly string[];
 *   createIndexStatements: readonly string[];
 * }} context
 */
function buildMigrations(context) {
  const columnMigrations = LEGACY_COLUMN_MIGRATIONS.map((config) => ({
    id: config.id,
    name: config.name,
    checksum: checksumForStatements(
      config.columns.map(([, definition]) => `ALTER TABLE ${config.table} ADD COLUMN ${definition}`),
    ),
    isApplied: (sqlite) => {
      const columns = tableColumnNames(sqlite, config.table);
      return config.columns.every(([column]) => columns.has(column));
    },
    isAppliedPostgres: async (pgConn) => {
      const columns = await tableColumnNamesPostgres(pgConn, config.table);
      return config.columns.every(([column]) => columns.has(column));
    },
    up: (sqlite) => {
      // A column migration only adds columns to an existing table; the base
      // 0001 migration owns table creation. If the table is absent (a store
      // whose ledger recorded 0001 but predates this table), skip rather than
      // throw "no such table" — mirrors how the index migrations skip indexes
      // whose table is absent and let the create-table migration own it.
      if (!tableExists(sqlite, config.table)) {
        return { table: config.table, addedColumns: [], skipped: "missing_table" };
      }
      const addedColumns = [];
      for (const [column, definition] of config.columns) {
        if (addColumnIfMissing(sqlite, config.table, column, definition)) {
          addedColumns.push(column);
        }
      }
      return { table: config.table, addedColumns };
    },
    upPostgres: async (pgConn) => {
      if (!(await tableExistsPostgres(pgConn, config.table))) {
        return { table: config.table, addedColumns: [], skipped: "missing_table" };
      }
      const addedColumns = [];
      for (const [column, definition] of config.columns) {
        if (await addColumnIfMissingPostgres(pgConn, config.table, column, definition)) {
          addedColumns.push(column);
        }
      }
      return { table: config.table, addedColumns };
    },
  }));
  return [
    {
      id: "0001_current_tables",
      name: "Create current Smithers tables",
      checksum: checksumForStatements(context.createTableStatements),
      isApplied: () => false,
      isAppliedPostgres: async (pgConn) => {
        const names = currentTableNames(context.createTableStatements);
        for (const name of names) {
          if (!(await tableExistsPostgres(pgConn, name))) {
            return false;
          }
        }
        return true;
      },
      up: (sqlite) => {
        for (const statement of context.createTableStatements) {
          sqlite.run(statement);
        }
        return { statementCount: context.createTableStatements.length };
      },
      upPostgres: async (pgConn) => {
        for (const statement of context.createTableStatements) {
          await pgConn.query({ text: translateDdl(POSTGRES, statement) });
        }
        return { statementCount: context.createTableStatements.length };
      },
    },
    ...columnMigrations,
    {
      id: "0011_add_node_diffs",
      name: "Add node diff cache table",
      checksum: "packages/db/migrations/0011_add_node_diffs.sql",
      isApplied: (sqlite) => tableExists(sqlite, "_smithers_node_diffs"),
      isAppliedPostgres: (pgConn) => tableExistsPostgres(pgConn, "_smithers_node_diffs"),
      up: (sqlite) => {
        sqlite.run(createTableStatementFor("_smithers_node_diffs", context.createTableStatements));
        return { table: "_smithers_node_diffs" };
      },
      upPostgres: async (pgConn) => {
        await pgConn.query({
          text: translateDdl(POSTGRES, createTableStatementFor("_smithers_node_diffs", context.createTableStatements)),
        });
        return { table: "_smithers_node_diffs" };
      },
    },
    {
      id: "0012_add_time_travel_audit",
      name: "Add time-travel audit table",
      checksum: "packages/db/migrations/0012_add_time_travel_audit.sql",
      isApplied: (sqlite) =>
        tableExists(sqlite, "_smithers_time_travel_audit") &&
        tableColumnNames(sqlite, "_smithers_time_travel_audit").has("duration_ms"),
      isAppliedPostgres: async (pgConn) =>
        (await tableExistsPostgres(pgConn, "_smithers_time_travel_audit")) &&
        (await tableColumnNamesPostgres(pgConn, "_smithers_time_travel_audit")).has("duration_ms"),
      up: (sqlite) => {
        if (!tableExists(sqlite, "_smithers_time_travel_audit")) {
          sqlite.run(createTableStatementFor("_smithers_time_travel_audit", context.createTableStatements));
          return { table: "_smithers_time_travel_audit", created: true };
        }
        addColumnIfMissing(sqlite, "_smithers_time_travel_audit", "duration_ms", "duration_ms INTEGER");
        return { table: "_smithers_time_travel_audit", addedColumns: ["duration_ms"] };
      },
      upPostgres: async (pgConn) => {
        if (!(await tableExistsPostgres(pgConn, "_smithers_time_travel_audit"))) {
          await pgConn.query({
            text: translateDdl(
              POSTGRES,
              createTableStatementFor("_smithers_time_travel_audit", context.createTableStatements),
            ),
          });
          return { table: "_smithers_time_travel_audit", created: true };
        }
        const added = await addColumnIfMissingPostgres(
          pgConn,
          "_smithers_time_travel_audit",
          "duration_ms",
          "duration_ms INTEGER",
        );
        return { table: "_smithers_time_travel_audit", addedColumns: added ? ["duration_ms"] : [] };
      },
    },
    {
      id: "0013_run_owned_foreign_keys",
      name: "Rebuild run-owned tables with cascading foreign keys",
      checksum: checksumForStatements(RUN_OWNED_FOREIGN_KEY_TABLES.map((config) => config.table)),
      destructive: true,
      isApplied: (sqlite) =>
        RUN_OWNED_FOREIGN_KEY_TABLES.every((config) => tableHasRunForeignKey(sqlite, config.table)),
      isAppliedPostgres: () => true,
      up: (sqlite) => {
        const tables = RUN_OWNED_FOREIGN_KEY_TABLES.map((config) =>
          rebuildRunOwnedForeignKeyTable(sqlite, config, context.createTableStatements),
        );
        const violations = sqlite.query("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(
            `SQLite foreign key check failed after Smithers schema migration: ${JSON.stringify(violations)}`,
          );
        }
        return { tables };
      },
      upPostgres: async () => ({ skipped: "sqlite_only" }),
    },
    {
      id: "0014_current_indexes",
      name: "Create current Smithers indexes",
      checksum: checksumForStatements([...context.createIndexStatements, ...EXTRA_INDEX_STATEMENTS]),
      isApplied: () => false,
      isAppliedPostgres: () => false,
      up: (sqlite) => {
        let applied = 0;
        let skipped = 0;
        for (const statement of [...context.createIndexStatements, ...EXTRA_INDEX_STATEMENTS]) {
          const target = indexTargetTable(statement);
          // Skip indexes whose table a later migration creates; running
          // them here would throw "no such table" on a store whose
          // ledger predates that table (e.g. `_smithers_docs`).
          if (target && !tableExists(sqlite, target)) {
            skipped += 1;
            continue;
          }
          sqlite.run(statement);
          applied += 1;
        }
        return { statementCount: applied, skipped };
      },
      upPostgres: async (pgConn) => {
        let applied = 0;
        let skipped = 0;
        for (const statement of [...context.createIndexStatements, ...EXTRA_INDEX_STATEMENTS]) {
          const target = indexTargetTable(statement);
          if (target && !(await tableExistsPostgres(pgConn, target))) {
            skipped += 1;
            continue;
          }
          await pgConn.query({ text: translateDdl(POSTGRES, statement) });
          applied += 1;
        }
        return { statementCount: applied, skipped };
      },
    },
    {
      id: "0015_add_workspace_states",
      name: "Add workspace snapshot states table",
      checksum: "packages/db/migrations/0015_add_workspace_states.sql",
      isApplied: (sqlite) => tableExists(sqlite, "_smithers_workspace_states"),
      isAppliedPostgres: (pgConn) => tableExistsPostgres(pgConn, "_smithers_workspace_states"),
      up: (sqlite) => {
        sqlite.run(createTableStatementFor("_smithers_workspace_states", context.createTableStatements));
        return { table: "_smithers_workspace_states" };
      },
      upPostgres: async (pgConn) => {
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_workspace_states", context.createTableStatements),
          ),
        });
        return { table: "_smithers_workspace_states" };
      },
    },
    {
      id: "0016_add_workspace_checkpoints",
      name: "Add workspace snapshot checkpoints table",
      checksum: "packages/db/migrations/0016_add_workspace_checkpoints.sql",
      isApplied: (sqlite) => tableExists(sqlite, "_smithers_workspace_checkpoints"),
      isAppliedPostgres: (pgConn) => tableExistsPostgres(pgConn, "_smithers_workspace_checkpoints"),
      up: (sqlite) => {
        sqlite.run(createTableStatementFor("_smithers_workspace_checkpoints", context.createTableStatements));
        return { table: "_smithers_workspace_checkpoints" };
      },
      upPostgres: async (pgConn) => {
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_workspace_checkpoints", context.createTableStatements),
          ),
        });
        return { table: "_smithers_workspace_checkpoints" };
      },
    },
    {
      id: "0017_add_scorer_context_columns",
      name: "Add scorer context correlation columns",
      checksum: "packages/db/migrations/0017_add_scorer_context_columns.sql",
      isApplied: (sqlite) => {
        const columns = tableColumnNames(sqlite, "_smithers_scorers");
        return columns.has("ground_truth_json") && columns.has("context_json");
      },
      isAppliedPostgres: async (pgConn) => {
        const columns = await tableColumnNamesPostgres(pgConn, "_smithers_scorers");
        return columns.has("ground_truth_json") && columns.has("context_json");
      },
      up: (sqlite) => {
        const addedColumns = [];
        if (addColumnIfMissing(sqlite, "_smithers_scorers", "ground_truth_json", "ground_truth_json TEXT")) {
          addedColumns.push("ground_truth_json");
        }
        if (addColumnIfMissing(sqlite, "_smithers_scorers", "context_json", "context_json TEXT")) {
          addedColumns.push("context_json");
        }
        return { table: "_smithers_scorers", addedColumns };
      },
      upPostgres: async (pgConn) => {
        if (!(await tableExistsPostgres(pgConn, "_smithers_scorers"))) {
          return { table: "_smithers_scorers", addedColumns: [], skipped: "missing_table" };
        }
        const addedColumns = [];
        if (
          await addColumnIfMissingPostgres(pgConn, "_smithers_scorers", "ground_truth_json", "ground_truth_json TEXT")
        ) {
          addedColumns.push("ground_truth_json");
        }
        if (await addColumnIfMissingPostgres(pgConn, "_smithers_scorers", "context_json", "context_json TEXT")) {
          addedColumns.push("context_json");
        }
        return { table: "_smithers_scorers", addedColumns };
      },
    },
    {
      id: "0018_add_docs",
      name: "Add docs (tickets/plans/specs/proposals) table",
      checksum: "packages/db/migrations/0018_add_docs.sql",
      isApplied: (sqlite) => tableExists(sqlite, "_smithers_docs"),
      isAppliedPostgres: (pgConn) => tableExistsPostgres(pgConn, "_smithers_docs"),
      up: (sqlite) => {
        sqlite.run(createTableStatementFor("_smithers_docs", context.createTableStatements));
        sqlite.run(`CREATE INDEX IF NOT EXISTS _smithers_docs_kind_live_idx
    ON _smithers_docs (kind, deleted_at_ms, updated_at_ms)`);
        return { table: "_smithers_docs" };
      },
      upPostgres: async (pgConn) => {
        await pgConn.query({
          text: translateDdl(POSTGRES, createTableStatementFor("_smithers_docs", context.createTableStatements)),
        });
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            `CREATE INDEX IF NOT EXISTS _smithers_docs_kind_live_idx
    ON _smithers_docs (kind, deleted_at_ms, updated_at_ms)`,
          ),
        });
        return { table: "_smithers_docs" };
      },
    },
    {
      id: "0019_add_integration_tables",
      name: "Add integration delivery-dedupe and polling-cursor tables",
      checksum: "packages/db/migrations/0019_add_integration_tables.sql",
      isApplied: (sqlite) =>
        tableExists(sqlite, "_smithers_integration_deliveries") && tableExists(sqlite, "_smithers_integration_cursors"),
      isAppliedPostgres: async (pgConn) =>
        (await tableExistsPostgres(pgConn, "_smithers_integration_deliveries")) &&
        (await tableExistsPostgres(pgConn, "_smithers_integration_cursors")),
      up: (sqlite) => {
        sqlite.run(createTableStatementFor("_smithers_integration_deliveries", context.createTableStatements));
        sqlite.run(createTableStatementFor("_smithers_integration_cursors", context.createTableStatements));
        return { tables: ["_smithers_integration_deliveries", "_smithers_integration_cursors"] };
      },
      upPostgres: async (pgConn) => {
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_integration_deliveries", context.createTableStatements),
          ),
        });
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_integration_cursors", context.createTableStatements),
          ),
        });
        return { tables: ["_smithers_integration_deliveries", "_smithers_integration_cursors"] };
      },
    },
    {
      id: "0020_run_pause_column",
      name: "Add graceful-pause request column to runs",
      checksum: "packages/db/migrations/0020_run_pause_column.sql",
      isApplied: (sqlite) => tableColumnNames(sqlite, "_smithers_runs").has("pause_requested_at_ms"),
      isAppliedPostgres: async (pgConn) =>
        (await tableColumnNamesPostgres(pgConn, "_smithers_runs")).has("pause_requested_at_ms"),
      up: (sqlite) => {
        if (!tableExists(sqlite, "_smithers_runs")) {
          return { table: "_smithers_runs", addedColumns: [] };
        }
        const added = addColumnIfMissing(
          sqlite,
          "_smithers_runs",
          "pause_requested_at_ms",
          "pause_requested_at_ms INTEGER",
        );
        return { table: "_smithers_runs", addedColumns: added ? ["pause_requested_at_ms"] : [] };
      },
      upPostgres: async (pgConn) => {
        if (!(await tableExistsPostgres(pgConn, "_smithers_runs"))) {
          return { table: "_smithers_runs", addedColumns: [] };
        }
        const added = await addColumnIfMissingPostgres(
          pgConn,
          "_smithers_runs",
          "pause_requested_at_ms",
          "pause_requested_at_ms INTEGER",
        );
        return { table: "_smithers_runs", addedColumns: added ? ["pause_requested_at_ms"] : [] };
      },
    },
    {
      id: "0023_add_memory_notes",
      name: "Add append-only memory notes and supersession junction tables",
      checksum: "packages/db/migrations/0023_add_memory_notes.sql",
      isApplied: (sqlite) =>
        tableExists(sqlite, "_smithers_memory_notes") && tableExists(sqlite, "_smithers_memory_note_supersessions"),
      isAppliedPostgres: async (pgConn) =>
        (await tableExistsPostgres(pgConn, "_smithers_memory_notes")) &&
        (await tableExistsPostgres(pgConn, "_smithers_memory_note_supersessions")),
      up: (sqlite) => {
        sqlite.run(createTableStatementFor("_smithers_memory_notes", context.createTableStatements));
        sqlite.run(createTableStatementFor("_smithers_memory_note_supersessions", context.createTableStatements));
        sqlite.run(`CREATE INDEX IF NOT EXISTS _smithers_memory_notes_namespace_idx
    ON _smithers_memory_notes (namespace, status, created_at_ms)`);
        sqlite.run(`CREATE INDEX IF NOT EXISTS _smithers_memory_note_supersessions_target_idx
    ON _smithers_memory_note_supersessions (supersedes_id)`);
        return { tables: ["_smithers_memory_notes", "_smithers_memory_note_supersessions"] };
      },
      upPostgres: async (pgConn) => {
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_memory_notes", context.createTableStatements),
          ),
        });
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_memory_note_supersessions", context.createTableStatements),
          ),
        });
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            `CREATE INDEX IF NOT EXISTS _smithers_memory_notes_namespace_idx
    ON _smithers_memory_notes (namespace, status, created_at_ms)`,
          ),
        });
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            `CREATE INDEX IF NOT EXISTS _smithers_memory_note_supersessions_target_idx
    ON _smithers_memory_note_supersessions (supersedes_id)`,
          ),
        });
        return { tables: ["_smithers_memory_notes", "_smithers_memory_note_supersessions"] };
      },
    },
    {
      // 0024 was used briefly by an unreleased compressed-payload
      // prototype. Use a new id and new table names so dogfood stores can
      // retain those rows while upgrading without a table rewrite.
      id: "0025_snapshot_contents",
      name: "Add content-addressed snapshot storage without rewriting snapshots",
      checksum: checksumForStatements([
        "_smithers_snapshot_contents",
        "_smithers_snapshot_payload_refs",
        "_smithers_snapshot_payload_refs_content_hash_idx",
        ...SNAPSHOT_SQLITE_TRIGGERS,
      ]),
      isApplied: (sqlite) =>
        tableExists(sqlite, "_smithers_snapshots") &&
        tableExists(sqlite, "_smithers_snapshot_contents") &&
        tableExists(sqlite, "_smithers_snapshot_payload_refs") &&
        indexExists(sqlite, "_smithers_snapshot_payload_refs_content_hash_idx") &&
        sqlite
          .query(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_smithers_snapshot%payload_refs_%'",
          )
          .get().count === SNAPSHOT_SQLITE_TRIGGERS.length,
      isAppliedPostgres: async (pgConn) => {
        if (
          !(await tableExistsPostgres(pgConn, "_smithers_snapshots")) ||
          !(await tableExistsPostgres(pgConn, "_smithers_snapshot_contents")) ||
          !(await tableExistsPostgres(pgConn, "_smithers_snapshot_payload_refs")) ||
          !(await indexExistsPostgres(pgConn, "_smithers_snapshot_payload_refs_content_hash_idx"))
        ) {
          return false;
        }
        const triggers = await pgConn.query({
          text: `SELECT tgname FROM pg_trigger
                           WHERE tgname IN ('_smithers_snapshot_payload_refcount', '_smithers_snapshot_parent_reconcile')
                             AND NOT tgisinternal`,
        });
        return new Set((triggers.rows ?? []).map((row) => row.tgname)).size === 2;
      },
      up: (sqlite) => {
        if (!tableExists(sqlite, "_smithers_snapshots")) {
          if (tableExists(sqlite, "_smithers_snapshots_0024_legacy")) {
            throw new Error(
              "0025 found _smithers_snapshots_0024_legacy without the live snapshot table; restore the interrupted prototype migration before continuing",
            );
          }
          sqlite.run(createTableStatementFor("_smithers_snapshots", context.createTableStatements));
        }
        sqlite.run(createTableStatementFor("_smithers_snapshot_contents", context.createTableStatements));
        sqlite.run(createTableStatementFor("_smithers_snapshot_payload_refs", context.createTableStatements));
        sqlite.run(`CREATE INDEX IF NOT EXISTS _smithers_snapshot_payload_refs_content_hash_idx
    ON _smithers_snapshot_payload_refs (content_hash)`);
        for (const trigger of SNAPSHOT_SQLITE_TRIGGERS) sqlite.run(trigger);
        return {
          tables: ["_smithers_snapshot_contents", "_smithers_snapshot_payload_refs"],
          triggers: SNAPSHOT_SQLITE_TRIGGERS.length,
        };
      },
      upPostgres: async (pgConn) => {
        if (!(await tableExistsPostgres(pgConn, "_smithers_snapshots"))) {
          await pgConn.query({
            text: translateDdl(POSTGRES, createTableStatementFor("_smithers_snapshots", context.createTableStatements)),
          });
        }
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_snapshot_contents", context.createTableStatements),
          ),
        });
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_snapshot_payload_refs", context.createTableStatements),
          ),
        });
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            `CREATE INDEX IF NOT EXISTS _smithers_snapshot_payload_refs_content_hash_idx
    ON _smithers_snapshot_payload_refs (content_hash)`,
          ),
        });
        await installSnapshotTriggersPostgres(pgConn);
        return { tables: ["_smithers_snapshot_contents", "_smithers_snapshot_payload_refs"], triggers: 2 };
      },
    },
    {
      id: "0026_drop_snapshot_prototype_triggers",
      name: "Drop unreleased compressed-payload prototype snapshot triggers",
      checksum: checksumForStatements(SNAPSHOT_PROTOTYPE_TRIGGERS.map(([name]) => `DROP TRIGGER IF EXISTS ${name}`)),
      isApplied: (sqlite) =>
        sqlite
          .query(
            `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN (${SNAPSHOT_PROTOTYPE_TRIGGERS.map(() => "?").join(", ")})`,
          )
          .get(...SNAPSHOT_PROTOTYPE_TRIGGERS.map(([name]) => name)).count === 0,
      isAppliedPostgres: async (pgConn) => {
        const triggers = await pgConn.query({
          text: "SELECT tgname FROM pg_trigger WHERE tgname = ANY($1) AND NOT tgisinternal",
          values: [SNAPSHOT_PROTOTYPE_TRIGGERS.map(([name]) => name)],
        });
        return (triggers.rows ?? []).length === 0;
      },
      up: (sqlite) => {
        const droppedTriggers = [];
        for (const [name] of SNAPSHOT_PROTOTYPE_TRIGGERS) {
          if (!sqlite.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name)) {
            continue;
          }
          sqlite.run(`DROP TRIGGER IF EXISTS ${name}`);
          droppedTriggers.push(name);
        }
        return { droppedTriggers };
      },
      upPostgres: async (pgConn) => {
        const droppedTriggers = [];
        for (const [name, table] of SNAPSHOT_PROTOTYPE_TRIGGERS) {
          if (!(await tableExistsPostgres(pgConn, table))) {
            continue;
          }
          await pgConn.query({ text: `DROP TRIGGER IF EXISTS ${name} ON ${table}` });
          droppedTriggers.push(name);
        }
        return { droppedTriggers };
      },
    },
    {
      id: "0027_add_rewind_leases",
      name: "Add durable rewind lease table",
      checksum: "packages/db/migrations/0027_add_rewind_leases.sql",
      isApplied: (sqlite) => tableExists(sqlite, "_smithers_rewind_leases"),
      isAppliedPostgres: (pgConn) => tableExistsPostgres(pgConn, "_smithers_rewind_leases"),
      up: (sqlite) => {
        sqlite.run(createTableStatementFor("_smithers_rewind_leases", context.createTableStatements));
        return { table: "_smithers_rewind_leases" };
      },
      upPostgres: async (pgConn) => {
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_rewind_leases", context.createTableStatements),
          ),
        });
        return { table: "_smithers_rewind_leases" };
      },
    },
    {
      id: "0028_sandbox_heartbeat_column",
      name: "Add sandbox heartbeat timestamp",
      checksum: "packages/db/migrations/0028_add_sandbox_heartbeat.sql",
      isApplied: (sqlite) => tableColumnNames(sqlite, "_smithers_sandboxes").has("heartbeat_at_ms"),
      isAppliedPostgres: async (pgConn) =>
        (await tableColumnNamesPostgres(pgConn, "_smithers_sandboxes")).has("heartbeat_at_ms"),
      up: (sqlite) => {
        if (!tableExists(sqlite, "_smithers_sandboxes")) {
          return { table: "_smithers_sandboxes", addedColumns: [], skipped: "missing_table" };
        }
        const added = addColumnIfMissing(sqlite, "_smithers_sandboxes", "heartbeat_at_ms", "heartbeat_at_ms INTEGER");
        return { table: "_smithers_sandboxes", addedColumns: added ? ["heartbeat_at_ms"] : [] };
      },
      upPostgres: async (pgConn) => {
        if (!(await tableExistsPostgres(pgConn, "_smithers_sandboxes"))) {
          return { table: "_smithers_sandboxes", addedColumns: [], skipped: "missing_table" };
        }
        const added = await addColumnIfMissingPostgres(
          pgConn,
          "_smithers_sandboxes",
          "heartbeat_at_ms",
          "heartbeat_at_ms INTEGER",
        );
        return { table: "_smithers_sandboxes", addedColumns: added ? ["heartbeat_at_ms"] : [] };
      },
    },
    {
      id: "0029_integration_delivery_claims",
      name: "Add retryable integration delivery claims",
      checksum: "packages/db/migrations/0029_add_integration_delivery_claims.sql",
      isApplied: (sqlite) => {
        const columns = tableColumnNames(sqlite, "_smithers_integration_deliveries");
        return (
          columns.has("status") &&
          columns.has("claim_token") &&
          columns.has("claim_expires_at_ms") &&
          columns.has("completed_at_ms")
        );
      },
      isAppliedPostgres: async (pgConn) => {
        const columns = await tableColumnNamesPostgres(pgConn, "_smithers_integration_deliveries");
        return (
          columns.has("status") &&
          columns.has("claim_token") &&
          columns.has("claim_expires_at_ms") &&
          columns.has("completed_at_ms")
        );
      },
      up: (sqlite) => {
        const addedColumns = [];
        if (
          addColumnIfMissing(
            sqlite,
            "_smithers_integration_deliveries",
            "status",
            "status TEXT NOT NULL DEFAULT 'completed'",
          )
        ) {
          addedColumns.push("status");
        }
        if (addColumnIfMissing(sqlite, "_smithers_integration_deliveries", "claim_token", "claim_token TEXT")) {
          addedColumns.push("claim_token");
        }
        if (
          addColumnIfMissing(
            sqlite,
            "_smithers_integration_deliveries",
            "claim_expires_at_ms",
            "claim_expires_at_ms INTEGER",
          )
        ) {
          addedColumns.push("claim_expires_at_ms");
        }
        if (
          addColumnIfMissing(sqlite, "_smithers_integration_deliveries", "completed_at_ms", "completed_at_ms INTEGER")
        ) {
          addedColumns.push("completed_at_ms");
        }
        return { table: "_smithers_integration_deliveries", addedColumns };
      },
      upPostgres: async (pgConn) => {
        const addedColumns = [];
        if (
          await addColumnIfMissingPostgres(
            pgConn,
            "_smithers_integration_deliveries",
            "status",
            "status TEXT NOT NULL DEFAULT 'completed'",
          )
        ) {
          addedColumns.push("status");
        }
        if (
          await addColumnIfMissingPostgres(
            pgConn,
            "_smithers_integration_deliveries",
            "claim_token",
            "claim_token TEXT",
          )
        ) {
          addedColumns.push("claim_token");
        }
        if (
          await addColumnIfMissingPostgres(
            pgConn,
            "_smithers_integration_deliveries",
            "claim_expires_at_ms",
            "claim_expires_at_ms INTEGER",
          )
        ) {
          addedColumns.push("claim_expires_at_ms");
        }
        if (
          await addColumnIfMissingPostgres(
            pgConn,
            "_smithers_integration_deliveries",
            "completed_at_ms",
            "completed_at_ms INTEGER",
          )
        ) {
          addedColumns.push("completed_at_ms");
        }
        return { table: "_smithers_integration_deliveries", addedColumns };
      },
    },
    {
      id: "0030_output_provenance",
      name: "Add durable output completion provenance and backfill legacy rows",
      checksum: "packages/db/migrations/0030_output_provenance.sql",
      // 0001/current-schema bootstrap creates this table before the
      // migration runner. Presence therefore cannot mean backfill ran.
      // Both dialects re-run the (idempotent, ON CONFLICT DO NOTHING)
      // backfill rather than short-circuiting on a ledger marker: writing
      // a marker into details_json makes a migrated target's ledger row
      // diverge from its source, breaking the row-for-row copy contract.
      isApplied: () => false,
      isAppliedPostgres: async () => false,
      up: (sqlite) => {
        sqlite.run(createTableStatementFor("_smithers_output_provenance", context.createTableStatements));
        if (!tableExists(sqlite, "_smithers_nodes"))
          return { table: "_smithers_output_provenance", backfilled: 0, skipped: "missing_nodes" };
        const nodes = sqlite
          .query(`SELECT DISTINCT run_id, output_table FROM _smithers_nodes ORDER BY run_id, output_table`)
          .all();
        let inserted = 0;
        for (const node of nodes) {
          if (typeof node.output_table !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.output_table)) continue;
          let rows;
          const tableName = tableExists(sqlite, node.output_table)
            ? node.output_table
            : [
                ...new Set(
                  sqlite
                    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_smithers_%'")
                    .all()
                    .map((row) => row.name),
                ),
              ].find((name) => name === node.output_table.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
          if (!tableName) continue;
          rows = sqlite
            .query(
              `SELECT node_id, COALESCE(iteration, 0) AS iteration FROM ${quoteIdentifier(tableName)} WHERE run_id = ? ORDER BY rowid`,
            )
            .all(node.run_id);
          for (const row of rows) {
            const next = sqlite
              .query(
                `SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM (SELECT seq FROM _smithers_output_provenance WHERE run_id = ? UNION ALL SELECT seq FROM _smithers_signals WHERE run_id = ?)`,
              )
              .get(node.run_id, node.run_id);
            sqlite.run(
              `INSERT OR IGNORE INTO _smithers_output_provenance (run_id, output_table, node_id, iteration, seq) VALUES (?, ?, ?, ?, ?)`,
              node.run_id,
              tableName,
              row.node_id,
              Number(row.iteration ?? 0),
              Number(next.seq),
            );
            inserted += 1;
          }
        }
        return { table: "_smithers_output_provenance", backfilled: inserted };
      },
      upPostgres: async (pgConn) => {
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_output_provenance", context.createTableStatements),
          ),
        });
        if (!(await tableExistsPostgres(pgConn, "_smithers_nodes")))
          return { table: "_smithers_output_provenance", backfilled: 0, skipped: "missing_nodes" };
        const nodes = await pgConn.query({
          text: `SELECT DISTINCT run_id, output_table FROM _smithers_nodes ORDER BY run_id, output_table`,
        });
        const catalog = await pgConn.query({
          text: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name",
        });
        const physicalTables = new Set(
          (catalog.rows ?? []).map((row) => row.name).filter((name) => typeof name === "string"),
        );
        const columnsByTable = new Map();
        for (const tableName of physicalTables) {
          const columns = await pgConn.query({
            text: "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
            values: [tableName],
          });
          columnsByTable.set(
            tableName,
            new Set((columns.rows ?? []).map((row) => row.name).filter((name) => typeof name === "string")),
          );
        }
        const signalsExist = physicalTables.has("_smithers_signals");
        let inserted = 0;
        for (const node of nodes.rows ?? []) {
          if (typeof node.output_table !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.output_table)) continue;
          const tableName = physicalTables.has(node.output_table)
            ? node.output_table
            : [...physicalTables].find(
                (name) => name === node.output_table.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
              );
          if (
            !tableName ||
            tableName.startsWith("_smithers_") ||
            !["run_id", "node_id", "iteration"].every((column) => columnsByTable.get(tableName)?.has(column))
          )
            continue;
          const quotedTable = quoteIdentifier(tableName);
          const rows = (
            await pgConn.query({
              text: `SELECT node_id, COALESCE(iteration, 0) AS iteration FROM ${quotedTable} WHERE run_id = $1 ORDER BY node_id, iteration`,
              values: [node.run_id],
            })
          ).rows;
          for (const row of rows) {
            const next = await pgConn.query({
              text: `SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM (SELECT seq FROM _smithers_output_provenance WHERE run_id = $1${signalsExist ? " UNION ALL SELECT seq FROM _smithers_signals WHERE run_id = $1" : ""})`,
              values: [node.run_id],
            });
            await pgConn.query({
              text: `INSERT INTO _smithers_output_provenance (run_id, output_table, node_id, iteration, seq) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
              values: [node.run_id, tableName, row.node_id, Number(row.iteration ?? 0), Number(next.rows[0].seq)],
            });
            inserted += 1;
          }
        }
        return { table: "_smithers_output_provenance", backfilled: inserted };
      },
    },
    {
      id: "0031_side_effect_journal",
      name: "Persist side-effect provenance and add retained tool-call archive",
      checksum: "packages/db/migrations/0031_side_effect_journal.sql",
      isApplied: (sqlite) => {
        const columns = tableColumnNames(sqlite, "_smithers_tool_calls");
        return (
          TOOL_EFFECT_JOURNAL_COLUMNS.every(([column]) => columns.has(column)) &&
          tableExists(sqlite, "_smithers_tool_call_archive")
        );
      },
      isAppliedPostgres: async (pgConn) => {
        const columns = await tableColumnNamesPostgres(pgConn, "_smithers_tool_calls");
        return (
          TOOL_EFFECT_JOURNAL_COLUMNS.every(([column]) => columns.has(column)) &&
          (await tableExistsPostgres(pgConn, "_smithers_tool_call_archive"))
        );
      },
      up: (sqlite) => {
        if (!tableExists(sqlite, "_smithers_tool_calls")) {
          sqlite.run(createTableStatementFor("_smithers_tool_calls", context.createTableStatements));
        }
        const addedColumns = [];
        for (const [column, definition] of TOOL_EFFECT_JOURNAL_COLUMNS) {
          if (addColumnIfMissing(sqlite, "_smithers_tool_calls", column, definition)) {
            addedColumns.push(column);
          }
        }
        sqlite.run(createTableStatementFor("_smithers_tool_call_archive", context.createTableStatements));
        return {
          table: "_smithers_tool_calls",
          addedColumns,
          archiveTable: "_smithers_tool_call_archive",
        };
      },
      upPostgres: async (pgConn) => {
        if (!(await tableExistsPostgres(pgConn, "_smithers_tool_calls"))) {
          await pgConn.query({
            text: translateDdl(
              POSTGRES,
              createTableStatementFor("_smithers_tool_calls", context.createTableStatements),
            ),
          });
        }
        const addedColumns = [];
        for (const [column, definition] of TOOL_EFFECT_JOURNAL_COLUMNS) {
          if (await addColumnIfMissingPostgres(pgConn, "_smithers_tool_calls", column, definition)) {
            addedColumns.push(column);
          }
        }
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_tool_call_archive", context.createTableStatements),
          ),
        });
        return {
          table: "_smithers_tool_calls",
          addedColumns,
          archiveTable: "_smithers_tool_call_archive",
        };
      },
    },
    {
      id: "0032_tool_call_tokens",
      name: "Fence tool-call completion with unique per-call tokens",
      checksum: "packages/db/migrations/0032_tool_call_tokens.sql",
      isApplied: (sqlite) => {
        const liveColumns = tableColumnNames(sqlite, "_smithers_tool_calls");
        const archiveColumns = tableColumnNames(sqlite, "_smithers_tool_call_archive");
        return (
          liveColumns.has("call_token") &&
          archiveColumns.has("call_token") &&
          indexExists(sqlite, "_smithers_tool_calls_call_token_uidx") &&
          indexExists(sqlite, "_smithers_tool_call_archive_call_token_uidx")
        );
      },
      isAppliedPostgres: async (pgConn) => {
        const liveColumns = await tableColumnNamesPostgres(pgConn, "_smithers_tool_calls");
        const archiveColumns = await tableColumnNamesPostgres(pgConn, "_smithers_tool_call_archive");
        return (
          liveColumns.has("call_token") &&
          archiveColumns.has("call_token") &&
          (await indexExistsPostgres(pgConn, "_smithers_tool_calls_call_token_uidx")) &&
          (await indexExistsPostgres(pgConn, "_smithers_tool_call_archive_call_token_uidx"))
        );
      },
      up: (sqlite) => {
        addColumnIfMissing(sqlite, "_smithers_tool_calls", "call_token", "call_token TEXT");
        addColumnIfMissing(sqlite, "_smithers_tool_call_archive", "call_token", "call_token TEXT");
        sqlite.run(
          "CREATE UNIQUE INDEX IF NOT EXISTS _smithers_tool_calls_call_token_uidx ON _smithers_tool_calls (call_token)",
        );
        sqlite.run(
          "CREATE UNIQUE INDEX IF NOT EXISTS _smithers_tool_call_archive_call_token_uidx ON _smithers_tool_call_archive (call_token)",
        );
        return {
          liveTable: "_smithers_tool_calls",
          archiveTable: "_smithers_tool_call_archive",
          column: "call_token",
        };
      },
      upPostgres: async (pgConn) => {
        await addColumnIfMissingPostgres(pgConn, "_smithers_tool_calls", "call_token", "call_token TEXT");
        await addColumnIfMissingPostgres(pgConn, "_smithers_tool_call_archive", "call_token", "call_token TEXT");
        await pgConn.query({
          text: "CREATE UNIQUE INDEX IF NOT EXISTS _smithers_tool_calls_call_token_uidx ON _smithers_tool_calls (call_token)",
        });
        await pgConn.query({
          text: "CREATE UNIQUE INDEX IF NOT EXISTS _smithers_tool_call_archive_call_token_uidx ON _smithers_tool_call_archive (call_token)",
        });
        return {
          liveTable: "_smithers_tool_calls",
          archiveTable: "_smithers_tool_call_archive",
          column: "call_token",
        };
      },
    },
    {
      id: "0033_scorer_identity",
      name: "Deduplicate scorer results and enforce durable scorer identity",
      checksum: "packages/db/migrations/0033_scorer_identity.sql",
      destructive: true,
      isApplied: (sqlite) => indexExists(sqlite, "_smithers_scorers_identity_uidx"),
      isAppliedPostgres: (pgConn) => indexExistsPostgres(pgConn, "_smithers_scorers_identity_uidx"),
      up: (sqlite) => {
        let created = false;
        if (!tableExists(sqlite, "_smithers_scorers")) {
          sqlite.run(createTableStatementFor("_smithers_scorers", context.createTableStatements));
          created = true;
        }
        const before = Number(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_scorers").get()?.count ?? 0);
        sqlite.run(DELETE_DUPLICATE_SCORER_ROWS_SQL);
        sqlite.run(CREATE_SCORER_IDENTITY_INDEX_SQL);
        const after = Number(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_scorers").get()?.count ?? 0);
        return { table: "_smithers_scorers", created, deletedDuplicates: before - after };
      },
      upPostgres: async (pgConn) => {
        let created = false;
        if (!(await tableExistsPostgres(pgConn, "_smithers_scorers"))) {
          await pgConn.query({
            text: translateDdl(POSTGRES, createTableStatementFor("_smithers_scorers", context.createTableStatements)),
          });
          created = true;
        }
        const deleted = await pgConn.query({ text: DELETE_DUPLICATE_SCORER_ROWS_SQL });
        await pgConn.query({ text: CREATE_SCORER_IDENTITY_INDEX_SQL });
        return { table: "_smithers_scorers", created, deletedDuplicates: Number(deleted.rowCount ?? 0) };
      },
    },
    {
      id: "0034_run_cancellation_attribution",
      name: "Add cancellation attribution columns to runs",
      checksum: checksumForStatements(
        RUN_CANCELLATION_ATTRIBUTION_COLUMNS.map(
          ([, definition]) => `ALTER TABLE _smithers_runs ADD COLUMN ${definition}`,
        ),
      ),
      isApplied: (sqlite) => {
        const columns = tableColumnNames(sqlite, "_smithers_runs");
        return RUN_CANCELLATION_ATTRIBUTION_COLUMNS.every(([column]) => columns.has(column));
      },
      isAppliedPostgres: async (pgConn) => {
        const columns = await tableColumnNamesPostgres(pgConn, "_smithers_runs");
        return RUN_CANCELLATION_ATTRIBUTION_COLUMNS.every(([column]) => columns.has(column));
      },
      up: (sqlite) => {
        if (!tableExists(sqlite, "_smithers_runs")) {
          return { table: "_smithers_runs", addedColumns: [], skipped: "missing_table" };
        }
        const addedColumns = [];
        for (const [column, definition] of RUN_CANCELLATION_ATTRIBUTION_COLUMNS) {
          if (addColumnIfMissing(sqlite, "_smithers_runs", column, definition)) {
            addedColumns.push(column);
          }
        }
        return { table: "_smithers_runs", addedColumns };
      },
      upPostgres: async (pgConn) => {
        if (!(await tableExistsPostgres(pgConn, "_smithers_runs"))) {
          return { table: "_smithers_runs", addedColumns: [], skipped: "missing_table" };
        }
        const addedColumns = [];
        for (const [column, definition] of RUN_CANCELLATION_ATTRIBUTION_COLUMNS) {
          if (await addColumnIfMissingPostgres(pgConn, "_smithers_runs", column, definition)) {
            addedColumns.push(column);
          }
        }
        return { table: "_smithers_runs", addedColumns };
      },
    },
    {
      id: "0035_ralph_exhausted",
      name: "Add loop-exhaustion flag to ralph state",
      checksum: "packages/db/migrations/0035_add_ralph_exhausted.sql",
      isApplied: (sqlite) => tableColumnNames(sqlite, "_smithers_ralph").has("exhausted"),
      isAppliedPostgres: async (pgConn) => (await tableColumnNamesPostgres(pgConn, "_smithers_ralph")).has("exhausted"),
      up: (sqlite) => {
        if (!tableExists(sqlite, "_smithers_ralph")) {
          return { table: "_smithers_ralph", addedColumns: [], skipped: "missing_table" };
        }
        const added = addColumnIfMissing(
          sqlite,
          "_smithers_ralph",
          "exhausted",
          "exhausted INTEGER NOT NULL DEFAULT 0",
        );
        return { table: "_smithers_ralph", addedColumns: added ? ["exhausted"] : [] };
      },
      upPostgres: async (pgConn) => {
        if (!(await tableExistsPostgres(pgConn, "_smithers_ralph"))) {
          return { table: "_smithers_ralph", addedColumns: [], skipped: "missing_table" };
        }
        const added = await addColumnIfMissingPostgres(
          pgConn,
          "_smithers_ralph",
          "exhausted",
          "exhausted INTEGER NOT NULL DEFAULT 0",
        );
        return { table: "_smithers_ralph", addedColumns: added ? ["exhausted"] : [] };
      },
    },
    {
      id: "0036_agent_processes",
      name: "Track live agent subprocesses so orphaned agents can be reaped",
      checksum: "packages/db/migrations/0036_add_agent_processes.sql",
      isApplied: (sqlite) => tableExists(sqlite, "_smithers_agent_processes"),
      isAppliedPostgres: (pgConn) => tableExistsPostgres(pgConn, "_smithers_agent_processes"),
      up: (sqlite) => {
        sqlite.run(createTableStatementFor("_smithers_agent_processes", context.createTableStatements));
        return { table: "_smithers_agent_processes", created: true };
      },
      upPostgres: async (pgConn) => {
        await pgConn.query({
          text: translateDdl(
            POSTGRES,
            createTableStatementFor("_smithers_agent_processes", context.createTableStatements),
          ),
        });
        return { table: "_smithers_agent_processes", created: true };
      },
    },
  ];
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {{
 *   createTableStatements: readonly string[];
 *   createIndexStatements: readonly string[];
 * }} context
 */
export function runSmithersSchemaMigrations(sqlite, context) {
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run(MIGRATION_TABLE_SQL);
  const applied = loadAppliedMigrationIds(sqlite);
  for (const migration of buildMigrations(context)) {
    if (applied.has(migration.id) || hasMigrationRecord(sqlite, migration.id)) {
      continue;
    }
    const details = runSqliteMigrationSpan(migration, () => {
      const alreadyApplied = migration.isApplied(sqlite);
      return alreadyApplied ? { skipped: "schema_already_matches" } : migration.up(sqlite);
    });
    logDestructiveMigration(migration, details);
    recordMigration(sqlite, migration, details);
    applied.add(migration.id);
  }
  // Databases upgraded by the rejected 0030 implementation may already
  // have a ledger row because table presence was mistaken for completion.
  // Re-run the idempotent data backfill so those stores converge too.
  backfillOutputProvenanceSqlite(sqlite);
  // CREATE TRIGGER IF NOT EXISTS is metadata-only and repairs a manually
  // dropped lifecycle trigger without rerunning any recorded migration.
  for (const trigger of SNAPSHOT_SQLITE_TRIGGERS) sqlite.run(trigger);
}

/**
 * Initialize a SQLite-compatible async storage backend with the current Smithers
 * schema. This is intentionally narrower than the bun:sqlite migration runner:
 * Cloudflare Durable Object SQLite is normally provisioned fresh per namespace,
 * and its SQL API is not a bun:sqlite client. The statements are idempotent, so
 * repeated boots converge without relying on driver-specific PRAGMA helpers.
 *
 * @param {{ execute: (statement: string, params?: readonly unknown[]) => Promise<unknown> | unknown }} storage
 * @param {{
 *   createTableStatements: readonly string[];
 *   createIndexStatements: readonly string[];
 * }} context
 */
export async function runSmithersSchemaInitSqliteAsync(storage, context) {
  try {
    await storage.execute("PRAGMA foreign_keys = ON");
  } catch {
    // Some SQLite-compatible edge runtimes reject PRAGMA writes. The schema
    // DDL below is still safe and idempotent.
  }
  await storage.execute(MIGRATION_TABLE_SQL);
  for (const statement of context.createTableStatements) {
    await storage.execute(statement);
  }
  const runColumns = new Set(
    (await storage.queryAllRaw('PRAGMA table_info("_smithers_runs")'))
      .map((row) => row.name)
      .filter((name) => typeof name === "string"),
  );
  for (const [column, definition] of RUN_CANCELLATION_ATTRIBUTION_COLUMNS) {
    if (!runColumns.has(column)) {
      await storage.execute(`ALTER TABLE _smithers_runs ADD COLUMN ${definition}`);
    }
  }
  // External SQLite backends do not run the versioned migration ledger. Apply
  // the scorer identity repair explicitly so existing stores converge too.
  await storage.execute(DELETE_DUPLICATE_SCORER_ROWS_SQL);
  await storage.execute(CREATE_SCORER_IDENTITY_INDEX_SQL);
  // External SQLite stores use this async bootstrap path and may already
  // contain user output tables. Run the data portion of 0030 explicitly;
  // CREATE TABLE IF NOT EXISTS above must not make it look applied.
  const tables = await storage.queryAllRaw(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_smithers_%' ORDER BY name",
  );
  const outputTables = new Set(tables.map((row) => row.name).filter((name) => typeof name === "string"));
  const nodes = await storage.queryAllRaw(
    "SELECT DISTINCT run_id, output_table FROM _smithers_nodes WHERE output_table IS NOT NULL ORDER BY run_id, output_table",
  );
  const nextByRun = new Map();
  for (const node of nodes) {
    const candidate = String(node.output_table);
    const tableName = outputTables.has(candidate)
      ? candidate
      : [...outputTables].find((name) => name === candidate.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    if (!tableName) continue;
    const columns = new Set(
      (await storage.queryAllRaw(`PRAGMA table_info(${quoteIdentifier(tableName)})`)).map((row) => row.name),
    );
    if (!columns.has("run_id") || !columns.has("node_id") || !columns.has("iteration")) continue;
    const rows = await storage.queryAllRaw(
      `SELECT run_id, node_id, iteration FROM ${quoteIdentifier(tableName)} WHERE run_id = ? ORDER BY rowid`,
      [node.run_id],
    );
    for (const row of rows) {
      const iteration = Number(row.iteration ?? 0);
      const found = await storage.queryOneRaw(
        "SELECT 1 FROM _smithers_output_provenance WHERE run_id = ? AND output_table = ? AND node_id = ? AND iteration = ? LIMIT 1",
        [row.run_id, tableName, row.node_id, iteration],
      );
      if (found) continue;
      let next = nextByRun.get(row.run_id);
      if (next === undefined)
        next = Number(
          (
            await storage.queryOneRaw(
              "SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM (SELECT seq FROM _smithers_output_provenance WHERE run_id = ? UNION ALL SELECT seq FROM _smithers_signals WHERE run_id = ?)",
              [row.run_id, row.run_id],
            )
          )?.seq ?? 0,
        );
      await storage.execute(
        "INSERT INTO _smithers_output_provenance (run_id, output_table, node_id, iteration, seq) VALUES (?, ?, ?, ?, ?)",
        [row.run_id, tableName, row.node_id, iteration, next],
      );
      nextByRun.set(row.run_id, next + 1);
    }
  }
  for (const statement of SNAPSHOT_SQLITE_TRIGGERS) await storage.execute(statement);
  for (const statement of [...context.createIndexStatements, ...EXTRA_INDEX_STATEMENTS]) {
    await storage.execute(statement);
  }
}

/**
 * Run one Postgres schema migration inside an Effect span so OTLP-backed
 * runtimes can attribute long DDL steps and log-only runtimes still get a
 * structured event.
 *
 * @param {{
 *   id: string;
 *   name: string;
 *   checksum?: string;
 *   destructive?: boolean;
 *   isAppliedPostgres?: (pgConn: any) => Promise<boolean> | boolean;
 *   upPostgres?: (pgConn: any) => Promise<unknown>;
 * }} migration
 * @param {() => Promise<unknown>} run
 */
async function runPostgresMigrationSpan(migration, run) {
  const start = Date.now();
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const details = await run();
        const durationMs = Date.now() - start;
        await Effect.runPromise(
          Effect.logDebug("db.schema_migration.applied").pipe(
            Effect.annotateLogs({
              dbDialect: "postgres",
              migrationId: migration.id,
              migrationName: migration.name,
              durationMs,
            }),
          ),
        );
        return details;
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.annotateLogs({
        dbDialect: "postgres",
        migrationId: migration.id,
        migrationName: migration.name,
      }),
      Effect.withLogSpan("db:schema-migration"),
    ),
  );
}

/**
 * Versioned PostgreSQL schema migration runner. It shares the SQLite migration
 * ledger ids so the current server schema head is available on both dialects.
 * A fresh Postgres database applies the current DDL in 0001 and records the
 * historical SQLite-only/additive steps as already satisfied.
 *
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows?: readonly Record<string, unknown>[] } | unknown> }} pgConn
 * @param {{
 *   createTableStatements: readonly string[];
 *   createIndexStatements: readonly string[];
 * }} context
 * @returns {Promise<void>}
 */
export async function runSmithersSchemaMigrationsPostgres(pgConn, context) {
  await pgConn.query({ text: translateDdl(POSTGRES, MIGRATION_TABLE_SQL) });
  const applied = await loadAppliedMigrationIdsPostgres(pgConn);
  for (const migration of buildMigrations(context)) {
    const alreadyAppliedInLedger = applied.has(migration.id);
    if (alreadyAppliedInLedger && migration.isAppliedPostgres && (await migration.isAppliedPostgres(pgConn))) {
      continue;
    }
    const details = await runPostgresMigrationSpan(migration, async () => {
      await pgConn.query({ text: "BEGIN" });
      try {
        const alreadyApplied = migration.isAppliedPostgres ? await migration.isAppliedPostgres(pgConn) : false;
        const nextDetails = alreadyApplied
          ? { skipped: "schema_already_matches" }
          : await migration.upPostgres?.(pgConn);
        await recordMigrationPostgres(pgConn, migration, nextDetails);
        await pgConn.query({ text: "COMMIT" });
        return nextDetails;
      } catch (error) {
        try {
          await pgConn.query({ text: "ROLLBACK" });
        } catch {
          // Preserve the original migration failure.
        }
        throw error;
      }
    });
    logDestructiveMigration(migration, details);
    applied.add(migration.id);
  }
}

/**
 * PostgreSQL schema initialization. A fresh PostgreSQL database starts at the
 * current schema, so it skips the SQLite-only legacy column/foreign-key
 * migrations entirely and simply creates every current table and index
 * idempotently, with DDL translated to PostgreSQL types. Tables are created in
 * declaration order, which keeps foreign-key references valid (referenced
 * tables precede their dependents).
 *
 * @param {{ query: (config: { text: string }) => Promise<unknown> }} pgConn
 * @param {{
 *   createTableStatements: readonly string[];
 *   createIndexStatements: readonly string[];
 * }} context
 * @returns {Promise<void>}
 */
export async function runSmithersSchemaInitPostgres(pgConn, context) {
  // The migration runner creates current tables and installs the dialect-specific
  // lifecycle trigger as part of 0025, including on a fresh database.
  await runSmithersSchemaMigrationsPostgres(pgConn, context);
}
