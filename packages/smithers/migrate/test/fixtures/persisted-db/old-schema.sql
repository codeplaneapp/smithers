-- Verbatim Smithers 0.x table definitions, so the read-only scanner runs
-- against the schema a real 0.x project has on disk.
--
-- `_smithers_schema_migrations` is `MIGRATION_TABLE_SQL` from
-- `/Users/williamcory/smithers/packages/db/src/schema-migrations.js`.
--
-- `_smithers_nodes`, `_smithers_attempts`, and `_smithers_events` are the
-- statements from `context.createTableStatements` (defined as
-- `CREATE_TABLE_STATEMENTS` in
-- `/Users/williamcory/smithers/packages/db/src/sql-message-storage.js`) that
-- migration `0001_current_tables` runs.
--
-- `_smithers_runs` carries the 20 columns a live 0.x database has, matching
-- `/Users/williamcory/plue/.smithers/smithers.db`: the 16 columns of the
-- original table plus the four that later migrations added. The current
-- `CREATE_TABLE_STATEMENTS` entry has more columns, and a database that has
-- not run those migrations is exactly the case the scanner must read.

CREATE TABLE IF NOT EXISTS _smithers_schema_migrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL,
    checksum TEXT,
    destructive INTEGER NOT NULL DEFAULT 0,
    details_json TEXT
  );

CREATE TABLE IF NOT EXISTS _smithers_runs (
    run_id TEXT PRIMARY KEY,
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
    vcs_type TEXT,
    vcs_root TEXT,
    vcs_revision TEXT,
    error_json TEXT,
    config_json TEXT,
    hijack_requested_at_ms INTEGER,
    hijack_target TEXT,
    parent_run_id TEXT,
    pause_requested_at_ms INTEGER
  );

CREATE TABLE IF NOT EXISTS _smithers_nodes (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    last_attempt INTEGER,
    updated_at_ms INTEGER NOT NULL,
    output_table TEXT NOT NULL,
    label TEXT,
    PRIMARY KEY (run_id, node_id, iteration)
  );

CREATE TABLE IF NOT EXISTS _smithers_attempts (
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
    effort TEXT,
    PRIMARY KEY (run_id, node_id, iteration, attempt)
  );

CREATE TABLE IF NOT EXISTS _smithers_events (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );
