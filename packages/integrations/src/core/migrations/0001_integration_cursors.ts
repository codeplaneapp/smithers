/** @since 1.0.0 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** @category migrations @since 1.0.0 */
const integrationCursors: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS smithers_integration_cursors (
    source_id TEXT PRIMARY KEY,
    cursor TEXT,
    updated_at_ms INTEGER NOT NULL
  )`
})

export default integrationCursors
