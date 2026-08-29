/** @since 0.1.0 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** @category migrations @since 0.1.0 */
const reservationLease: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE flows_triggers ADD COLUMN active_claimed_at_ms INTEGER`
})

export default reservationLease
