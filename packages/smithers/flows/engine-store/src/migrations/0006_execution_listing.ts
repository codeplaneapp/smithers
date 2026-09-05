/**
 * Indexed engine execution observation and ordering.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Brings existing spawn edges into the migration ladder and binds changes to
 * their child's run revision. Run-store owns the shared revision triggers.
 * @category migrations
 * @since 1.0.0
 */
export const executionListing: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS flows_run_parents (
    child_id TEXT NOT NULL CHECK (length(child_id) > 0),
    parent_id TEXT NOT NULL CHECK (length(parent_id) > 0),
    seq BIGINT NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0 AND seq <= 9007199254740991),
    PRIMARY KEY (child_id, parent_id)
  )`
  yield* sql`CREATE INDEX IF NOT EXISTS flows_run_parents_parent_idx ON flows_run_parents (parent_id)`
  yield* sql`CREATE INDEX flows_run_parents_first_idx ON flows_run_parents (child_id, seq, parent_id)`
  yield* sql`CREATE INDEX flows_run_parents_children_idx ON flows_run_parents (parent_id, seq, child_id)`
  yield* sql`CREATE TRIGGER IF NOT EXISTS flows_run_parents_gc AFTER DELETE ON flows_runs
    BEGIN DELETE FROM flows_run_parents WHERE child_id = OLD.run_id OR parent_id = OLD.run_id; END`
  yield* sql`ALTER TABLE flows_runs ADD COLUMN execution_parent_id TEXT`
  yield* sql`ALTER TABLE flows_runs ADD COLUMN execution_flow TEXT
    GENERATED ALWAYS AS (json_extract(state_json, '$.flowName')) VIRTUAL`
  yield* sql`ALTER TABLE flows_runs ADD COLUMN execution_lineage TEXT
    GENERATED ALWAYS AS (COALESCE(lineage_id, run_id)) VIRTUAL`
  yield* sql`CREATE INDEX flows_runs_round_page_idx ON flows_runs (execution_lineage, COALESCE(round_ordinal, 0), run_id)`
  yield* sql`CREATE TRIGGER flows_runs_creation_immutable BEFORE UPDATE OF created_at_ms ON flows_runs
    WHEN NEW.created_at_ms <> OLD.created_at_ms
    BEGIN SELECT RAISE(ABORT, 'execution creation key is immutable'); END`
  yield* sql`UPDATE flows_runs SET execution_parent_id = COALESCE(parent_run_id,
    (SELECT parent_id FROM flows_run_parents WHERE child_id = run_id ORDER BY seq, parent_id LIMIT 1))`
  for (const operation of ["INSERT", "UPDATE OF parent_run_id"] as const) {
    yield* sql.unsafe(`CREATE TRIGGER flows_runs_effective_parent_${operation === "INSERT" ? "insert" : "update"}
      AFTER ${operation} ON flows_runs BEGIN
        UPDATE flows_runs SET execution_parent_id = COALESCE(NEW.parent_run_id,
          (SELECT parent_id FROM flows_run_parents WHERE child_id = NEW.run_id ORDER BY seq, parent_id LIMIT 1))
        WHERE run_id = NEW.run_id;
      END`)
  }
  for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
    const row = operation === "DELETE" ? "OLD" : "NEW"
    yield* sql.unsafe(`CREATE TRIGGER flows_run_parents_revision_${operation.toLowerCase()}
      AFTER ${operation} ON flows_run_parents BEGIN
        UPDATE flows_runs SET execution_parent_id = COALESCE(parent_run_id,
          (SELECT parent_id FROM flows_run_parents WHERE child_id = run_id ORDER BY seq, parent_id LIMIT 1))
        WHERE run_id = ${row}.child_id ${operation === "UPDATE" ? "OR run_id = OLD.child_id" : ""};
      END`)
  }
  // Every subset of the five equality filters has its creation-order suffix.
  // This avoids rare combined predicates degrading to whole-history scans.
  const fields = ["status", "execution_flow", "execution_parent_id", "execution_lineage", "waiting_reason"]
  for (let mask = 0; mask < 32; mask++) {
    const columns = fields.filter((_, index) => (mask & (1 << index)) !== 0)
    yield* sql.unsafe(`CREATE INDEX flows_runs_listing_${mask} ON flows_runs
      (${[...columns, "created_at_ms", "run_id"].join(", ")})`)
  }
})
