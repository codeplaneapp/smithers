/**
 * Initial durable journal event schema.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_journal_events` table and its event-type index.
 *
 * @category migrations
 * @since 0.1.0
 */
export const initial: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_journal_events (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0 AND seq <= 9007199254740991),
    event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) > 0),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    source_seq INTEGER NOT NULL CHECK (typeof(source_seq) = 'integer' AND source_seq >= 0 AND source_seq <= 9007199254740991),
    emitted_at_ms INTEGER NOT NULL CHECK (typeof(emitted_at_ms) = 'integer' AND emitted_at_ms >= 0 AND emitted_at_ms <= 9007199254740991),
    event_type TEXT NOT NULL CHECK (length(event_type) > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    meta_json TEXT NOT NULL CHECK (json_valid(meta_json)),
    PRIMARY KEY (run_id, seq),
    UNIQUE (run_id, source_id, source_seq)
  )`

  yield* sql`CREATE INDEX flows_journal_events_event_type_idx ON flows_journal_events (event_type)`
})
