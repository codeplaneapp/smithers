/**
 * SQLite schema and lazy FTS operations.
 *
 * @see https://smithers.sh/api/memory
 *
 * @since 0.1.0
 */
import type { DatabaseError } from "@smthrs/database/DurableWriter"
import * as Effect from "effect/Effect"
import type * as SqlError from "effect/unstable/sql/SqlError"
import type { DatabaseService } from "../Database.ts"
import type { Kind } from "../Namespace.ts"
import { searchableText } from "./Text.ts"

/**
 * The pair of services the memory schema operates through.
 *
 * `@smthrs/database` split its old `Database` service into Effect's own
 * `SqlClient` for queries and a `DurableWriter` for writes. These helpers take
 * both together because an FTS projection has to run inside the very write
 * transaction that changed the authoritative row.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type { DatabaseService } from "../Database.ts"

/**
 * A record projected into a namespace-kind FTS table.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface FtsRecord {
  readonly recordId: string
  readonly recordKind: "fact" | "note"
  readonly namespaceId: string
  readonly key: string
  readonly text: string
}

/**
 * Raw rank row returned by SQLite FTS5.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface FtsMatch {
  readonly record_id: string
  readonly record_kind: "fact" | "note"
  readonly rank: number
}

const ftsTable = (kind: Kind): string => `memory_fts_${kind}`
const compositeMessagePrimaryKey = /PRIMARY\s+KEY\s*\(\s*thread_id\s*,\s*id\s*\)/iu

/**
 * Creates every authoritative memory table idempotently in one database
 * write transaction. The statements mirror `src/migrations/*.sql`.
 *
 * @category migrations
 * @since 0.1.0
 * @slop
 */
export const migrate = (database: DatabaseService): Effect.Effect<void, DatabaseError | SqlError.SqlError> => {
  const { sql } = database
  return database.write(
    Effect.gen(function*() {
      yield* sql`CREATE TABLE IF NOT EXISTS memory_facts (
        namespace_kind TEXT NOT NULL,
        namespace_id TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        tags_json TEXT CHECK (tags_json IS NULL OR json_valid(tags_json)),
        ttl_ms INTEGER,
        provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (namespace_kind, namespace_id, fact_key),
        CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
        CHECK (length(namespace_id) > 0),
        CHECK (length(fact_key) > 0),
        CHECK (ttl_ms IS NULL OR ttl_ms >= 0)
      )`
      const factColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(memory_facts)`
      if (!factColumns.some((column) => column.name === "tags_json")) {
        yield* sql`ALTER TABLE memory_facts
          ADD COLUMN tags_json TEXT CHECK (tags_json IS NULL OR json_valid(tags_json))`
      }
      yield* sql`CREATE INDEX IF NOT EXISTS memory_facts_expiry_idx
        ON memory_facts (updated_at_ms, ttl_ms) WHERE ttl_ms IS NOT NULL`
      yield* sql`CREATE TABLE IF NOT EXISTS memory_threads (
        thread_id TEXT PRIMARY KEY CHECK (length(thread_id) > 0),
        namespace_kind TEXT NOT NULL,
        namespace_id TEXT NOT NULL,
        title TEXT,
        metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
        CHECK (length(namespace_id) > 0)
      )`
      yield* sql`CREATE TABLE IF NOT EXISTS memory_messages (
        id TEXT NOT NULL CHECK (length(id) > 0),
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        PRIMARY KEY (thread_id, id),
        FOREIGN KEY (thread_id) REFERENCES memory_threads (thread_id)
      )`
      const messageTables = yield* sql<{ readonly sql: string | null }>`SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'memory_messages'`
      const messageDefinition = messageTables[0]?.sql
      if (messageDefinition !== undefined && !compositeMessagePrimaryKey.test(messageDefinition ?? "")) {
        yield* sql`CREATE TABLE memory_messages_v2 (
          id TEXT NOT NULL CHECK (length(id) > 0),
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          at_ms INTEGER NOT NULL,
          PRIMARY KEY (thread_id, id),
          FOREIGN KEY (thread_id) REFERENCES memory_threads (thread_id)
        )`
        yield* sql`INSERT INTO memory_messages_v2 (id, thread_id, role, text, at_ms)
          SELECT id, thread_id, role, text, at_ms FROM memory_messages`
        yield* sql`DROP TABLE memory_messages`
        yield* sql`ALTER TABLE memory_messages_v2 RENAME TO memory_messages`
      }
      yield* sql`CREATE INDEX IF NOT EXISTS memory_messages_thread_order_idx
        ON memory_messages (thread_id, at_ms, id)`
      yield* sql`CREATE TABLE IF NOT EXISTS memory_notes (
        id TEXT PRIMARY KEY CHECK (length(id) > 0),
        namespace_kind TEXT NOT NULL,
        namespace_id TEXT NOT NULL,
        text TEXT NOT NULL,
        tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
        provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
        status TEXT NOT NULL DEFAULT 'accepted',
        created_at_ms INTEGER NOT NULL,
        CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
        CHECK (length(namespace_id) > 0),
        CHECK (status IN ('pending', 'accepted', 'rejected'))
      )`
      yield* sql`CREATE INDEX IF NOT EXISTS memory_notes_namespace_order_idx
        ON memory_notes (namespace_kind, namespace_id, created_at_ms, id)`
      yield* sql`CREATE TABLE IF NOT EXISTS memory_note_supersedes (
        superseder_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (superseder_id, target_id),
        FOREIGN KEY (superseder_id) REFERENCES memory_notes (id),
        FOREIGN KEY (target_id) REFERENCES memory_notes (id),
        CHECK (superseder_id <> target_id)
      )`
      yield* sql`CREATE TABLE IF NOT EXISTS memory_fts_kinds (
        namespace_kind TEXT PRIMARY KEY,
        enabled_at_ms INTEGER NOT NULL,
        CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global'))
      )`
      yield* sql`CREATE TABLE IF NOT EXISTS memory_vectors (
        record_kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        namespace_kind TEXT NOT NULL,
        namespace_id TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_bytes BLOB NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (
          namespace_kind, namespace_id, record_kind, record_id, embedding_model
        ),
        CHECK (record_kind IN ('fact', 'note')),
        CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
        CHECK (length(record_id) > 0),
        CHECK (length(namespace_id) > 0),
        CHECK (length(embedding_model) > 0),
        CHECK (length(content_digest) > 0),
        CHECK (dimensions > 0)
      )`
      yield* sql`CREATE INDEX IF NOT EXISTS memory_vectors_namespace_idx
        ON memory_vectors (namespace_kind, namespace_id, embedding_model, updated_at_ms)`
    })
  )
}

/**
 * Returns whether a namespace kind has opted into FTS5.
 *
 * @category queries
 * @since 0.1.0
 * @slop
 */
export const isFtsEnabled = (
  database: DatabaseService,
  kind: Kind
): Effect.Effect<boolean, SqlError.SqlError> =>
  database.sql<{ readonly enabled: number }>`
    SELECT 1 AS enabled FROM memory_fts_kinds WHERE namespace_kind = ${kind}
  `.pipe(Effect.map((rows) => rows.length > 0))

/**
 * Creates and fully backfills one namespace-kind FTS5 table.
 *
 * This Effect must be run inside `Database.write`.
 *
 * @category migrations
 * @since 0.1.0
 * @slop
 */
export const enableFts = (
  database: DatabaseService,
  kind: Kind,
  enabledAtMs: number
): Effect.Effect<void, SqlError.SqlError> => {
  const { sql } = database
  const table = sql.literal(ftsTable(kind))
  return Effect.gen(function*() {
    yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS ${table}
      USING fts5(record_id UNINDEXED, record_kind UNINDEXED, namespace_id UNINDEXED, record_key, text)`
    yield* sql`INSERT INTO memory_fts_kinds (namespace_kind, enabled_at_ms)
      VALUES (${kind}, ${enabledAtMs})
      ON CONFLICT (namespace_kind) DO NOTHING`
    yield* sql`DELETE FROM ${table}`
    const facts = yield* sql<{
      readonly fact_key: string
      readonly namespace_id: string
      readonly value_json: string
    }>`SELECT fact_key, namespace_id, value_json
      FROM memory_facts WHERE namespace_kind = ${kind}
      ORDER BY namespace_id, fact_key`
    for (const fact of facts) {
      const value = JSON.parse(fact.value_json) as unknown
      yield* sql`INSERT INTO ${table} (record_id, record_kind, namespace_id, record_key, text)
        VALUES (${fact.fact_key}, 'fact', ${fact.namespace_id}, ${fact.fact_key}, ${searchableText(value)})`
    }
    yield* sql`INSERT INTO ${table} (record_id, record_kind, namespace_id, record_key, text)
      SELECT id, 'note', namespace_id, id, text
      FROM memory_notes WHERE namespace_kind = ${kind}`
  })
}

/**
 * Replaces one authoritative record's FTS projection when its kind is enabled.
 *
 * This Effect must be run inside the authoritative record's
 * `Database.write` transaction.
 *
 * @category projections
 * @since 0.1.0
 * @slop
 */
export const replaceFtsRecord = (
  database: DatabaseService,
  kind: Kind,
  record: FtsRecord
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function*() {
    if (!(yield* isFtsEnabled(database, kind))) {
      return
    }
    const { sql } = database
    const table = sql.literal(ftsTable(kind))
    yield* sql`DELETE FROM ${table}
      WHERE record_id = ${record.recordId}
        AND record_kind = ${record.recordKind}
        AND namespace_id = ${record.namespaceId}`
    yield* sql`INSERT INTO ${table} (record_id, record_kind, namespace_id, record_key, text)
      VALUES (${record.recordId}, ${record.recordKind}, ${record.namespaceId}, ${record.key}, ${record.text})`
  })

/**
 * Deletes one authoritative record's FTS projection when its kind is enabled.
 *
 * @category projections
 * @since 0.1.0
 * @slop
 */
export const deleteFtsRecord = (
  database: DatabaseService,
  kind: Kind,
  record: Pick<FtsRecord, "recordId" | "recordKind" | "namespaceId">
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function*() {
    if (!(yield* isFtsEnabled(database, kind))) return
    const table = database.sql.literal(ftsTable(kind))
    yield* database.sql`DELETE FROM ${table}
      WHERE record_id = ${record.recordId}
        AND record_kind = ${record.recordKind}
        AND namespace_id = ${record.namespaceId}`
  })

/**
 * Searches one namespace-kind FTS5 table in raw BM25 rank order.
 *
 * `offset` lets a caller walk the ranked matches in pages. A match can be
 * dropped by a status, supersession, or tag filter the FTS table knows nothing
 * about, so returning the caller's page size in one shot would under-fill the
 * answer; paging is what lets the store keep asking until it has enough.
 *
 * @category queries
 * @since 0.1.0
 * @slop
 */
export const searchFts = (
  database: DatabaseService,
  kind: Kind,
  namespaceId: string,
  query: string,
  limit: number,
  offset = 0
): Effect.Effect<ReadonlyArray<FtsMatch>, SqlError.SqlError> => {
  const { sql } = database
  const tableName = ftsTable(kind)
  const table = sql.literal(tableName)
  const bm25 = sql.literal(`bm25(${tableName})`)
  return sql<FtsMatch>`SELECT record_id, record_kind, ${bm25} AS rank
    FROM ${table}
    WHERE ${table} MATCH ${query} AND namespace_id = ${namespaceId}
    ORDER BY rank
    LIMIT ${limit} OFFSET ${offset}`
}
