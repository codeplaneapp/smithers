/**
 * The schema objects `DurableEngineState` creates outside the journal
 * migration, and the inventory of what porting them to another
 * dialect costs.
 *
 * The canonical `flows_*` migrations live in `@smthrs/journal`; these
 * statements are engine-store-owned storage created idempotently at
 * construction instead (issues #40/#41/#79/#81). That is a deliberate lane
 * boundary, not an oversight — but it left the statements invisible to the
 * pg-porting plan in `docs/migration/smithers-replacement-gaps.md`, which
 * scoped only the journal migration's SQLite-specific DDL. Declaring them here
 * makes the inventory machine-readable: a test diffs the database's schema
 * objects across `make` against this list, so no engine-owned statement can
 * be added without appearing in the porting inventory (issue #92).
 *
 * @since 0.1.0
 */
import type { Service as WriterService } from "@smthrs/database/DurableWriter"
import * as Effect from "effect/Effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * SQL dialects a statement is known to be accepted by, verbatim.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Dialect = "sqlite" | "postgres"

/**
 * One engine-store-owned schema object.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Statement {
  /** The schema object's name, as it appears in the catalog. */
  readonly name: string
  /** Why the object exists, by issue. */
  readonly reason: string
  /**
   * Dialects that accept this statement unchanged. A statement listing only
   * `"sqlite"` must be rewritten before a Postgres/PGlite `Database` layer
   * can construct this service — `make` pipes every one of them through
   * `Effect.orDie`, so an unported statement is a construction-time defect,
   * not a recoverable error.
   */
  readonly dialects: ReadonlyArray<Dialect>
  readonly ddl: string
}

/**
 * The porting inventory: every engine-store-owned statement, in creation order.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const statements: ReadonlyArray<Statement> = [
  {
    name: "flows_run_parents",
    reason:
      "Durable run-parent edges for the run DAG (issues #40/#41). `seq` is a store-global insertion order used only to list a run's parents oldest first; cycle rejection happens atomically inside `recordRunParent`'s transaction, so no UNIQUE(seq) is needed (issues #54/#66). PRIMARY KEY (child_id, parent_id) is the edge uniqueness constraint. There is deliberately no FK to `flows_runs`: the tables live in different migration lanes.",
    dialects: ["sqlite", "postgres"],
    ddl: `
      CREATE TABLE IF NOT EXISTS flows_run_parents (
        child_id TEXT NOT NULL CHECK (length(child_id) > 0),
        parent_id TEXT NOT NULL CHECK (length(parent_id) > 0),
        seq BIGINT NOT NULL CHECK (
          typeof(seq) = 'integer' AND seq >= 0 AND seq <= 9007199254740991
        ),
        PRIMARY KEY (child_id, parent_id)
      )
    `
  },
  {
    name: "flows_run_parents_parent_idx",
    reason:
      "Serves reverse-direction cleanup (`removeRunParentsForRun`, for lanes that clear edges without deleting run rows); the cycle walk itself reads by `child_id` via the primary key.",
    dialects: ["sqlite", "postgres"],
    ddl: `
      CREATE INDEX IF NOT EXISTS flows_run_parents_parent_idx
      ON flows_run_parents (parent_id)
    `
  },
  {
    name: "flows_run_parents_gc",
    reason:
      "Database-level GC enforcement (issue #81): any lane that deletes a run row — retention, time-travel archival, a future prune job — drops that run's parent edges in the same transaction, whether or not it knows to call `removeRunParentsForRun`, so ghost edges can never accumulate into future cycle walks.",
    // SQLite-exclusive: the inline BEGIN...END body and the implicit
    // per-row firing have no Postgres equivalent — porting means a
    // `CREATE FUNCTION ... RETURNS trigger` plus
    // `CREATE TRIGGER ... FOR EACH ROW EXECUTE FUNCTION`.
    dialects: ["sqlite"],
    ddl: `
      CREATE TRIGGER IF NOT EXISTS flows_run_parents_gc
      AFTER DELETE ON flows_runs
      BEGIN
        DELETE FROM flows_run_parents
        WHERE child_id = OLD.run_id OR parent_id = OLD.run_id;
      END
    `
  },
  {
    name: "flows_runs_stale_running_idx",
    reason:
      "Serves the stale-running sweep's per-tick predicate (issue #79): `status = 'running' AND heartbeat_at_ms < cutoff`, ordered by heartbeat. A partial index keeps it tiny — only live running rows appear.",
    // Partial indexes are valid Postgres since 9.5, so this one ports as-is.
    dialects: ["sqlite", "postgres"],
    ddl: `
      CREATE INDEX IF NOT EXISTS flows_runs_stale_running_idx
      ON flows_runs (heartbeat_at_ms)
      WHERE status = 'running'
    `
  }
]

/**
 * Creates the engine-store-owned objects, idempotently, in inventory order.
 *
 * `flows_runs` must already exist — every query in this service assumes a
 * migrated database, so `make` composes over one by construction.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const apply = (sql: SqlClient.SqlClient, writer: WriterService): Effect.Effect<void> =>
  Effect.forEach(
    statements,
    (statement) => writer.write(sql.unsafe(statement.ddl)).pipe(Effect.orDie),
    { discard: true }
  )
