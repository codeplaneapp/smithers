/**
 * Durable generations distinguish histories that reuse journal sequences.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Installs the generation table idempotently. Both the SQL journal and time
 * travel initialize it, including databases whose migration ladder already
 * passed the journal's reserved block.
 *
 * @category migrations
 * @since 1.0.0-rc.0
 */
export const initialize = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE IF NOT EXISTS flows_journal_generations (
      run_id TEXT PRIMARY KEY NOT NULL CHECK (length(run_id) > 0),
      generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation > 0 AND generation <= 9007199254740991),
      after_seq INTEGER NOT NULL CHECK (typeof(after_seq) = 'integer' AND after_seq >= -1 AND after_seq <= 9007199254740991)
    )
  `
})
