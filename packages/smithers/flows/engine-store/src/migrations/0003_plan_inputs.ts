/**
 * Durable, append-only source observations for compiled plan execution.
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates input generations and marks pre-observation executions as non-recoverable.
 * @since 1.0.0
 * @category migrations
 */
export const planInputs: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE flows_plan_input_legacy_runs (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES flows_runs(run_id) ON DELETE CASCADE
  )`
  // A past source snapshot cannot be reconstructed from the files a completed
  // action may already have changed. Preserve that uncertainty on upgrade.
  yield* sql`INSERT INTO flows_plan_input_legacy_runs (run_id)
    SELECT DISTINCT run_id FROM flows_attempts`
  yield* sql`CREATE TRIGGER flows_plan_input_legacy_runs_no_update
    BEFORE UPDATE ON flows_plan_input_legacy_runs
    BEGIN SELECT RAISE(ABORT, 'legacy plan input uncertainty is immutable'); END`
  yield* sql`CREATE TABLE flows_plan_input_heads (
    run_id TEXT NOT NULL REFERENCES flows_runs(run_id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL CHECK (length(plan_id) > 0),
    base_digest TEXT NOT NULL CHECK (length(base_digest) > 0),
    generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 0 AND generation <= 9007199254740991),
    PRIMARY KEY (run_id, plan_id)
  )`
  yield* sql`CREATE UNIQUE INDEX flows_plan_input_heads_run_idx ON flows_plan_input_heads (run_id)`
  yield* sql`CREATE TABLE flows_plan_input_generations (
    run_id TEXT NOT NULL REFERENCES flows_runs(run_id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL CHECK (length(plan_id) > 0),
    generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 0 AND generation <= 9007199254740991),
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    PRIMARY KEY (run_id, plan_id, generation)
  )`
  yield* sql`CREATE TRIGGER flows_plan_input_generations_no_update
    BEFORE UPDATE ON flows_plan_input_generations
    BEGIN SELECT RAISE(ABORT, 'plan input generations are immutable'); END`
  yield* sql`CREATE TRIGGER flows_plan_input_heads_forward_only
    BEFORE UPDATE ON flows_plan_input_heads
    WHEN NEW.run_id <> OLD.run_id OR NEW.plan_id <> OLD.plan_id OR
      NEW.base_digest <> OLD.base_digest OR NEW.generation <> OLD.generation + 1
    BEGIN SELECT RAISE(ABORT, 'plan input heads only advance one generation'); END`
  for (const table of ["flows_plan_input_legacy_runs", "flows_plan_input_heads", "flows_plan_input_generations"]) {
    // Cascade on run collection is allowed; direct deletion of replay state
    // while its owning run exists is not.
    yield* sql.unsafe(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
      WHEN EXISTS (SELECT 1 FROM flows_runs WHERE run_id = OLD.run_id)
      BEGIN SELECT RAISE(ABORT, 'plan inputs belong to their run'); END`)
  }
})
