/**
 * Deleting run history that has outlived its usefulness.
 *
 * Nothing in the durable stores forgets on its own: a finished run keeps its
 * row, every attempt, every journal event, and every archived frame forever.
 * That is the right default — a run's history is the only account of what an
 * agent did to a repository — and it is why `smithers gc` exists rather than a
 * background sweeper. Retention is an operator decision, taken explicitly,
 * with a dry run available before anything is deleted.
 *
 * The operation is deliberately one pass over one database and takes the
 * database as a service, so a host with a split control/engine layout runs it
 * once per file rather than hard-coding either layout here.
 *
 * Only terminal runs are ever considered. A `pending`, `running`, or
 * `suspended` row belongs to work that can still resume, and its parent may be
 * terminal, so descendants are collected before deletion and a run whose
 * lineage still holds a live descendant is kept.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/**
 * Run statuses that make a row eligible for deletion.
 *
 * @category constants
 * @since 1.0.0
 */
export const terminalStatuses: ReadonlyArray<string> = ["completed", "failed", "cancelled"]

/**
 * Every table a deleted run leaves rows in, and the column naming the run.
 *
 * Tables are listed rather than discovered from foreign keys because the set
 * spans four packages that migrate into one database, and a silently missing
 * entry is exactly the leak this module exists to close. A table that is not
 * present in the database is skipped: a host that composed only some of the
 * stores still gets a complete sweep of the ones it has.
 *
 * @category constants
 * @since 1.0.0
 */
export const runScopedTables: ReadonlyArray<readonly [table: string, column: string]> = [
  ["flows_attempts", "run_id"],
  ["flows_deferred_completions", "execution_id"],
  ["flows_clock_deadlines", "execution_id"],
  ["flows_journal_events", "run_id"],
  ["flows_journal_checkpoints", "run_id"],
  ["flows_step_cache_recorded", "recorded_run_id"],
  ["flows_time_travel_archive", "run_id"],
  ["flows_time_travel_snapshots", "run_id"],
  ["flows_time_travel_audits", "run_id"],
  ["flows_time_travel_edges", "child_run_id"],
  ["control_run_messages", "run_id"],
  ["control_runs", "run_id"]
]

/**
 * What one retention pass would delete, or did.
 *
 * @category models
 * @since 1.0.0
 */
export interface Report {
  readonly database: string
  /** The threshold, as an epoch millisecond value. */
  readonly olderThanMs: number
  readonly runs: ReadonlyArray<string>
  /** Rows deleted per table; empty under a dry run. */
  readonly deleted: Readonly<Record<string, number>>
  readonly dryRun: boolean
}

/**
 * Arguments accepted by {@link collect}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** Delete terminal runs that finished strictly before this epoch millisecond. */
  readonly olderThanMs: number
  readonly dryRun?: boolean | undefined
  /** A label for the report; the host's database path. */
  readonly database?: string | undefined
}

/** Whether a table exists in the connected database. */
const hasTable = (table: string): Effect.Effect<boolean, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
    `
    return rows.length > 0
  })

/**
 * The terminal runs eligible for deletion, oldest first.
 *
 * A run with a non-terminal descendant is excluded: deleting a parent whose
 * child is still running would break the `parent_run_id` foreign key and cut
 * the live run's lineage.
 *
 * @category getters
 * @since 1.0.0
 */
export const eligible = (
  olderThanMs: number
): Effect.Effect<ReadonlyArray<string>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    if (!(yield* hasTable("flows_runs"))) return []
    const rows = yield* sql<{ readonly run_id: string }>`
      SELECT run_id FROM flows_runs
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND COALESCE(finished_at_ms, created_at_ms) < ${olderThanMs}
        AND run_id NOT IN (
          SELECT parent_run_id FROM flows_runs
          WHERE parent_run_id IS NOT NULL AND status NOT IN ('completed', 'failed', 'cancelled')
        )
      ORDER BY COALESCE(finished_at_ms, created_at_ms) ASC
    `
    return rows.map((row) => row.run_id)
  })

/** One `IN` list is one bound parameter per id, and SQLite caps how many one statement may carry. */
const chunkSize = 500

const chunks = (ids: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
  const out: Array<ReadonlyArray<string>> = []
  for (let index = 0; index < ids.length; index += chunkSize) out.push(ids.slice(index, index + chunkSize))
  return out
}

/**
 * Runs one retention pass.
 *
 * Under `dryRun` nothing is written and `deleted` is empty: the report names
 * exactly the runs a real pass would remove, which is what makes
 * `smithers gc --dry-run` worth trusting.
 *
 * @category constructors
 * @since 1.0.0
 */
export const collect = (
  options: Options
): Effect.Effect<Report, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const runs = yield* eligible(options.olderThanMs)
    const dryRun = options.dryRun === true
    const report: Report = {
      database: options.database ?? "",
      olderThanMs: options.olderThanMs,
      runs,
      deleted: {},
      dryRun
    }
    if (dryRun || runs.length === 0) return report

    const deleted: Record<string, number> = {}
    // Child rows first, then the run rows they reference: the parent delete
    // would otherwise fail the foreign keys the schema declares. Ids are
    // chunked because one `IN` list is one bound parameter per id, and SQLite
    // caps how many a statement may carry.
    for (const [table, column] of runScopedTables) {
      if (!(yield* hasTable(table))) continue
      let count = 0
      for (const chunk of chunks(runs)) {
        const rows = yield* sql<{ readonly total: number }>`
          SELECT COUNT(*) AS total FROM ${sql.literal(table)} WHERE ${sql.in(column, chunk)}
        `
        // Summed rather than read out of `rows[0]`: an aggregate returns
        // exactly one row, so the index-and-default form was a branch no test
        // could ever take.
        for (const row of rows) count += row.total
        yield* sql`DELETE FROM ${sql.literal(table)} WHERE ${sql.in(column, chunk)}`
      }
      if (count > 0) deleted[table] = count
    }
    for (const chunk of chunks(runs)) {
      yield* sql`DELETE FROM flows_runs WHERE ${sql.in("run_id", chunk)}`
    }
    deleted["flows_runs"] = runs.length
    return { ...report, deleted }
  })
