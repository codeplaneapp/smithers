import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { Database } from "@flows/database"

const SOURCE_ID = "smithers"

const throwMapped = (method) => (cause) => {
  const message = cause instanceof Error ? cause.message : String(cause)
  const error = new Error(`flows journal shim ${method}: ${message}`)
  error.cause = cause
  throw error
}

/**
 * SmithersDb journal-event methods over flows_journal_events.
 *
 * Deliberately NOT built on @flows/journal SqlJournal: SqlJournal hydrates its
 * per-run seq clock into process memory at layer startup and allocates
 * synchronously thereafter. Any second writer (another engine process, a
 * supervisor, or SQL outside the service) forks the seq clock and collides on
 * the (run_id, seq) primary key. Smithers instead allocates seq in SQL under
 * the write lock, which is safe for multi-writer single-file SQLite. This
 * shim keeps smithers' allocation discipline on the flows table.
 *
 * Dedup: smithers content-dedups on (run_id, timestamp_ms, type,
 * payload_json); flows' (run_id, source_id, source_seq) uniqueness is
 * preserved by setting source_id='smithers' and source_seq=seq.
 */
export const createJournalShim = (boundary) => {
  let dbPromise
  const getDb = () => dbPromise ??= boundary.run(Effect.service(Database.Database))

  const insertEventWithNextSeq = async (row) => {
    try {
      const db = await getDb()
      return await boundary.run(
        db.write(
          Effect.gen(function*() {
            const existing = yield* db.sql`
              SELECT seq FROM flows_journal_events
              WHERE run_id = ${row.runId}
                AND emitted_at_ms = ${row.timestampMs}
                AND event_type = ${row.type}
                AND payload_json = ${row.payloadJson}
              ORDER BY seq DESC
              LIMIT 1
            `
            if (existing[0] !== undefined) return Number(existing[0].seq)
            const last = yield* db.sql`
              SELECT MAX(seq) AS "maxSeq" FROM flows_journal_events WHERE run_id = ${row.runId}
            `
            const seq = last[0]?.maxSeq === null || last[0]?.maxSeq === undefined ? 0 : Number(last[0].maxSeq) + 1
            yield* db.sql`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json
              ) VALUES (
                ${row.runId}, ${seq}, ${randomUUID()}, ${SOURCE_ID}, ${seq},
                ${row.timestampMs}, ${row.type}, ${row.payloadJson}, '{}'
              )
            `
            return seq
          })
        )
      )
    } catch (cause) {
      throwMapped("insertEventWithNextSeq")(cause)
    }
  }

  const getLastEventSeq = async (runId) => {
    try {
      const db = await getDb()
      const rows = await boundary.run(db.sql`
        SELECT seq FROM flows_journal_events WHERE run_id = ${runId} ORDER BY seq DESC LIMIT 1
      `)
      return rows[0] === undefined ? undefined : Number(rows[0].seq)
    } catch (cause) {
      throwMapped("getLastEventSeq")(cause)
    }
  }

  const listEventHistory = async (runId, query = {}) => {
    try {
      const db = await getDb()
      const clauses = ["run_id = ?", "seq > ?"]
      const params = [runId, query.afterSeq ?? -1]
      if (typeof query.sinceTimestampMs === "number") {
        clauses.push("emitted_at_ms >= ?")
        params.push(query.sinceTimestampMs)
      }
      if (query.types && query.types.length > 0) {
        clauses.push(`event_type IN (${query.types.map(() => "?").join(", ")})`)
        params.push(...query.types)
      }
      if (query.nodeId) {
        clauses.push("json_extract(payload_json, '$.nodeId') = ?")
        params.push(query.nodeId)
      }
      const limit = Math.max(1, Math.floor(query.limit ?? 200))
      const rows = await boundary.run(
        db.sql.unsafe(
          `SELECT run_id, seq, emitted_at_ms AS timestamp_ms, event_type AS type, payload_json
           FROM flows_journal_events
           WHERE ${clauses.join(" AND ")}
           ORDER BY seq ASC
           LIMIT ?`,
          [...params, limit]
        )
      )
      return rows.map((row) => ({
        runId: row.run_id,
        seq: Number(row.seq),
        timestampMs: Number(row.timestamp_ms),
        type: row.type,
        payloadJson: row.payload_json
      }))
    } catch (cause) {
      throwMapped("listEventHistory")(cause)
    }
  }

  return { insertEventWithNextSeq, getLastEventSeq, listEventHistory }
}
