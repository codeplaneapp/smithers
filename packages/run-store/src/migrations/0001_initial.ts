/**
 * Initial durable run and attempt schema.
 *
 * Schema boundary: `docs/pages/concepts/durable-execution-model.md`.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_runs` and `flows_attempts` tables and their indexes.
 *
 * @category migrations
 * @since 0.1.0
 */
const initial: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_runs (
    run_id TEXT PRIMARY KEY CHECK (length(run_id) > 0),
    status TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0 AND created_at_ms <= 9007199254740991),
    started_at_ms INTEGER CHECK (started_at_ms IS NULL OR (typeof(started_at_ms) = 'integer' AND started_at_ms >= 0 AND started_at_ms <= 9007199254740991)),
    finished_at_ms INTEGER CHECK (finished_at_ms IS NULL OR (typeof(finished_at_ms) = 'integer' AND finished_at_ms >= 0 AND finished_at_ms <= 9007199254740991)),
    owner_host_id TEXT,
    owner_pid INTEGER,
    owner_nonce TEXT,
    heartbeat_at_ms INTEGER CHECK (heartbeat_at_ms IS NULL OR (typeof(heartbeat_at_ms) = 'integer' AND heartbeat_at_ms >= 0 AND heartbeat_at_ms <= 9007199254740991)),
    claim_host_id TEXT,
    claim_pid INTEGER,
    claim_nonce TEXT,
    claimed_at_ms INTEGER CHECK (claimed_at_ms IS NULL OR (typeof(claimed_at_ms) = 'integer' AND claimed_at_ms >= 0 AND claimed_at_ms <= 9007199254740991)),
    parent_run_id TEXT CHECK (parent_run_id IS NULL OR length(parent_run_id) > 0),
    cancel_requested_at_ms INTEGER CHECK (cancel_requested_at_ms IS NULL OR (typeof(cancel_requested_at_ms) = 'integer' AND cancel_requested_at_ms >= 0 AND cancel_requested_at_ms <= 9007199254740991)),
    waiting_reason TEXT CHECK (waiting_reason IS NULL OR length(waiting_reason) > 0),
    waiting_wake_at_ms INTEGER CHECK (waiting_wake_at_ms IS NULL OR (typeof(waiting_wake_at_ms) = 'integer' AND waiting_wake_at_ms >= 0 AND waiting_wake_at_ms <= 9007199254740991)),
    waiting_token TEXT CHECK (waiting_token IS NULL OR length(waiting_token) > 0),
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    CHECK (status IN ('pending', 'running', 'suspended', 'completed', 'failed', 'cancelled')),
    CHECK (
      (
        status = 'running' AND
        owner_host_id IS NOT NULL AND
        length(owner_host_id) > 0 AND
        owner_pid IS NOT NULL AND
        typeof(owner_pid) = 'integer' AND owner_pid >= 0 AND
        owner_nonce IS NOT NULL AND
        length(owner_nonce) > 0 AND
        heartbeat_at_ms IS NOT NULL
      ) OR (
        status <> 'running' AND
        owner_host_id IS NULL AND
        owner_pid IS NULL AND
        owner_nonce IS NULL AND
        heartbeat_at_ms IS NULL
      )
    ),
    CHECK (
      (claim_host_id IS NULL AND claim_pid IS NULL AND claim_nonce IS NULL AND claimed_at_ms IS NULL) OR
      (claim_host_id IS NOT NULL AND length(claim_host_id) > 0 AND
       claim_pid IS NOT NULL AND typeof(claim_pid) = 'integer' AND claim_pid >= 0 AND
       claim_nonce IS NOT NULL AND length(claim_nonce) > 0 AND claimed_at_ms IS NOT NULL)
    ),
    CHECK (
      (waiting_reason IS NULL AND waiting_wake_at_ms IS NULL AND waiting_token IS NULL) OR
      waiting_reason IS NOT NULL
    ),
    FOREIGN KEY (parent_run_id) REFERENCES flows_runs (run_id)
  )`

  yield* sql`CREATE INDEX flows_runs_parent_run_id_idx ON flows_runs (parent_run_id)`
  yield* sql`CREATE INDEX flows_runs_cancel_requested_idx ON flows_runs (cancel_requested_at_ms) WHERE cancel_requested_at_ms IS NOT NULL`
  yield* sql`CREATE INDEX flows_runs_waiting_reason_wake_at_idx ON flows_runs (waiting_reason, waiting_wake_at_ms) WHERE waiting_reason IS NOT NULL`

  yield* sql`CREATE TABLE flows_attempts (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    step_key_digest TEXT NOT NULL CHECK (length(step_key_digest) > 0),
    attempt INTEGER NOT NULL CHECK (typeof(attempt) = 'integer' AND attempt >= 0 AND attempt <= 9007199254740991),
    state TEXT NOT NULL CHECK (length(state) > 0),
    started_at_ms INTEGER NOT NULL CHECK (typeof(started_at_ms) = 'integer' AND started_at_ms >= 0 AND started_at_ms <= 9007199254740991),
    finished_at_ms INTEGER CHECK (finished_at_ms IS NULL OR (typeof(finished_at_ms) = 'integer' AND finished_at_ms >= 0 AND finished_at_ms <= 9007199254740991)),
    heartbeat_at_ms INTEGER CHECK (heartbeat_at_ms IS NULL OR (typeof(heartbeat_at_ms) = 'integer' AND heartbeat_at_ms >= 0 AND heartbeat_at_ms <= 9007199254740991)),
    checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
    meta_json TEXT NOT NULL CHECK (json_valid(meta_json)),
    PRIMARY KEY (run_id, step_key_digest, attempt),
    FOREIGN KEY (run_id) REFERENCES flows_runs (run_id)
  )`
})

export default initial
