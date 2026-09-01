/**
 * Durable suspected-edge storage for probabilistic selection.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_selection_suspected_edges` table.
 *
 * @category migrations
 * @since 0.1.0
 */
const selectionStore: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_selection_suspected_edges (
    scope TEXT NOT NULL CHECK (length(scope) > 0),
    affects TEXT NOT NULL CHECK (length(affects) > 0),
    confidence REAL NOT NULL CHECK (
      (typeof(confidence) = 'real' OR typeof(confidence) = 'integer') AND
      confidence >= 0 AND
      confidence <= 1
    ),
    valid_from_ms INTEGER NOT NULL CHECK (
      typeof(valid_from_ms) = 'integer' AND
      valid_from_ms >= 0 AND
      valid_from_ms <= 9007199254740991
    ),
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    PRIMARY KEY (scope, affects)
  )`
})

export default selectionStore
