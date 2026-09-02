/**
 * Authoritative SQL memory contract store.
 *
 * @see docs/specs/Concepts/Memory.md
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { resolveNamespace } from "./internal/Bank.ts"
import * as Sql from "./internal/Sql.ts"
import { canonicalJson, compareText, literalFtsQuery, retainedTags, searchableText } from "./internal/Text.ts"
import { MemoryError } from "./MemoryError.ts"
import * as Namespace from "./Namespace.ts"

/**
 * Explicit run coordinates attached to a memory write.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Provenance {
  readonly runId?: string | null | undefined
  readonly nodeId?: string | null | undefined
  readonly iteration?: number | null | undefined
}

/**
 * A current fact row.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Fact {
  readonly namespace: Namespace.Namespace
  readonly key: string
  readonly value: unknown
  readonly ttlMs?: number | undefined
  readonly provenance: Provenance
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

/**
 * Input for a last-write-wins fact update.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface PutFactInput {
  readonly namespace: Namespace.Namespace
  readonly key: string
  /**
   * Value stored through a `JSON.stringify` round trip.
   *
   * `NaN` and `Infinity` become `null`; `undefined`, function, and symbol
   * members are dropped; and sparse array slots become `null`. A later
   * `getFact` can therefore return a value that differs from the input.
   *
   * @category models
   * @since 0.1.0
   */
  readonly value: unknown
  readonly ttlMs?: number | undefined
  readonly provenance: Provenance
}

/**
 * Input for an exact fact read.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface GetFactInput {
  readonly namespace: Namespace.Namespace
  readonly key: string
}

/**
 * Input for an ordered namespace fact listing.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ListFactsInput {
  readonly namespace: Namespace.Namespace
  readonly prefix?: string | undefined
}

/**
 * A durable history thread.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Thread {
  readonly id: string
  readonly namespace: Namespace.Namespace
  readonly title?: string | undefined
  readonly metadata?: unknown
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

/**
 * Input for durable thread creation.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CreateThreadInput {
  readonly id?: string | undefined
  readonly namespace: Namespace.Namespace
  readonly title?: string | undefined
  readonly metadata?: unknown
}

/**
 * Input for listing durable threads.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ListThreadsInput {
  readonly namespace?: Namespace.Namespace | undefined
}

/**
 * An ordered history message.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Message {
  readonly threadId: string
  readonly id: string
  readonly role: string
  readonly text: string
  readonly at: number
}

/**
 * Input for an idempotent history append.
 *
 * A message id is unique within its thread.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type AppendMessageInput = Message

/**
 * Input for an ordered thread read.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ListMessagesInput {
  readonly threadId: string
}

/**
 * Input for an exact note read.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface GetNoteInput {
  readonly id: string
}

/**
 * The only mutable state on an append-only note.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const NoteStatus = Schema.Literals(["pending", "accepted", "rejected"])

/**
 * The only mutable state on an append-only note.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type NoteStatus = typeof NoteStatus.Type

/**
 * An append-only knowledge note.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Note {
  readonly namespace: Namespace.Namespace
  readonly id: string
  readonly text: string
  readonly tags: Namespace.Tags
  readonly provenance: Provenance
  readonly status: NoteStatus
  readonly createdAtMs: number
}

/**
 * Input for an append-only note insert.
 *
 * `supersedes`, when present, is persisted in the same write transaction as
 * the new note.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface PutNoteInput {
  readonly namespace: Namespace.Namespace
  readonly id: string
  readonly text: string
  readonly tags: Namespace.Tags
  readonly provenance: Provenance
  readonly status?: NoteStatus | undefined
  readonly supersedes?: ReadonlyArray<string> | undefined
}

/**
 * Input for the note status gate.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SetNoteStatusInput {
  readonly id: string
  readonly status: NoteStatus
}

/**
 * Input for a supersession edge.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SupersedeInput {
  readonly supersederId: string
  readonly targetId: string
}

/**
 * A structured namespace or recall bank name.
 *
 * Explicit `flow-`, `agent-`, `user-`, and `global-` bank prefixes retain
 * their lifetime. Unprefixed banks are flow-local.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type NamespaceInput = Namespace.Namespace | string

/**
 * Status selector accepted by note and search reads.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type StatusFilter = NoteStatus | "any" | ReadonlyArray<NoteStatus>

/**
 * Input for authoritative note reads.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ListNotesInput {
  readonly namespace: NamespaceInput
  readonly tagGroup?: Namespace.TagGroup | undefined
  readonly tagGroups?: ReadonlyArray<Namespace.TagGroup> | undefined
  readonly status?: StatusFilter | undefined
  readonly includeSuperseded?: boolean | undefined
}

/**
 * A normalized authoritative row consumed by recall bindings.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SearchRow {
  readonly id: string
  readonly kind: "fact" | "note"
  readonly bank: string
  readonly namespace: Namespace.Namespace
  readonly key: string
  readonly text: string
  readonly tags: ReadonlyArray<string>
  readonly updatedAtMs: number
  readonly status?: NoteStatus | undefined
}

/**
 * Input for raw authoritative recall rows.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SearchRowsInput extends ListNotesInput {
  readonly limit?: number | undefined
}

/**
 * Input for lazy FTS5 enablement.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type EnableFtsInput = Namespace.Kind

/**
 * Input for direct FTS5 recall.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SearchFtsInput extends SearchRowsInput {
  readonly query: string
}

/**
 * An authoritative FTS result with raw SQLite BM25 rank.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface FtsRow extends SearchRow {
  readonly rank: number
  readonly score: number
}

/**
 * Atomic history compaction input used by Maintenance.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CompactMessagesInput {
  readonly threadId: string
  readonly summary: Message
  readonly deleteIds: ReadonlyArray<string>
}

/**
 * Authoritative memory and maintenance operations.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly putFact: (input: PutFactInput) => Effect.Effect<void, MemoryError>
  readonly getFact: (input: GetFactInput) => Effect.Effect<Fact | undefined, MemoryError>
  readonly deleteFact: (input: GetFactInput) => Effect.Effect<boolean, MemoryError>
  readonly listFacts: (input: ListFactsInput) => Effect.Effect<ReadonlyArray<Fact>, MemoryError>
  readonly listAllFacts: () => Effect.Effect<ReadonlyArray<Fact>, MemoryError>
  readonly createThread: (input: CreateThreadInput) => Effect.Effect<Thread, MemoryError>
  readonly getThread: (threadId: string) => Effect.Effect<Thread | undefined, MemoryError>
  readonly listThreads: (input?: ListThreadsInput | undefined) => Effect.Effect<ReadonlyArray<Thread>, MemoryError>
  readonly deleteThread: (threadId: string) => Effect.Effect<boolean, MemoryError>
  readonly appendMessage: (input: AppendMessageInput) => Effect.Effect<void, MemoryError>
  readonly listMessages: (input: ListMessagesInput) => Effect.Effect<ReadonlyArray<Message>, MemoryError>
  readonly countMessages: (input: ListMessagesInput) => Effect.Effect<number, MemoryError>
  readonly putNote: (input: PutNoteInput) => Effect.Effect<Note, MemoryError>
  readonly getNote: (input: GetNoteInput) => Effect.Effect<Note | undefined, MemoryError>
  readonly setNoteStatus: (input: SetNoteStatusInput) => Effect.Effect<void, MemoryError>
  readonly supersede: (input: SupersedeInput) => Effect.Effect<void, MemoryError>
  readonly listNotes: (input: ListNotesInput) => Effect.Effect<ReadonlyArray<Note>, MemoryError>
  readonly enableFts: (kind: EnableFtsInput) => Effect.Effect<void, MemoryError>
  readonly searchFts: (input: SearchFtsInput) => Effect.Effect<ReadonlyArray<FtsRow>, MemoryError>
  readonly searchRows: (input: SearchRowsInput) => Effect.Effect<ReadonlyArray<SearchRow>, MemoryError>
  readonly deleteExpiredFacts: Effect.Effect<number, MemoryError>
  readonly listThreadIds: Effect.Effect<ReadonlyArray<string>, MemoryError>
  readonly deleteMessages: (
    input: { readonly threadId: string; readonly ids: ReadonlyArray<string> }
  ) => Effect.Effect<number, MemoryError>
  readonly compactMessages: (input: CompactMessagesInput) => Effect.Effect<number, MemoryError>
}

/**
 * Context service for durable cross-run memory.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class MemoryStore extends Context.Service<MemoryStore, Service>()("flows/memory/MemoryStore") {}

interface FactRow {
  readonly namespace_kind: Namespace.Kind
  readonly namespace_id: string
  readonly fact_key: string
  readonly value_json: string
  readonly ttl_ms: number | null
  readonly provenance_json: string
  readonly created_at_ms: number
  readonly updated_at_ms: number
}

interface MessageRow {
  readonly thread_id: string
  readonly id: string
  readonly role: string
  readonly text: string
  readonly at_ms: number
}

interface ThreadRow {
  readonly thread_id: string
  readonly namespace_kind: Namespace.Kind
  readonly namespace_id: string
  readonly title: string | null
  readonly metadata_json: string | null
  readonly created_at_ms: number
  readonly updated_at_ms: number
}

interface NoteRow {
  readonly namespace_kind: Namespace.Kind
  readonly namespace_id: string
  readonly id: string
  readonly text: string
  readonly tags_json: string
  readonly provenance_json: string
  readonly status: NoteStatus
  readonly created_at_ms: number
}

const causeSummary = (cause: unknown): unknown => {
  if (cause instanceof Error) {
    return {
      name: cause.name.slice(0, 128),
      message: cause.message.slice(0, 1_024)
    }
  }
  if (typeof cause === "string") {
    return cause.slice(0, 1_024)
  }
  return { type: cause === null ? "null" : typeof cause }
}

const error = (
  code: MemoryError["code"],
  message: string,
  cause?: unknown,
  path?: ReadonlyArray<string>
): MemoryError =>
  new MemoryError({
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(cause === undefined ? {} : { cause: causeSummary(cause) })
  })

const isMemoryError = (cause: unknown): cause is MemoryError => cause instanceof MemoryError

const storeError = (message: string) => (cause: unknown): MemoryError =>
  isMemoryError(cause) ? cause : error("store", message, cause)

const changed = (result: unknown): number => {
  if (typeof result !== "object" || result === null) {
    return 0
  }
  const changes = "changes" in result ? result.changes : undefined
  const rowsAffected = "rowsAffected" in result ? result.rowsAffected : undefined
  return typeof changes === "number"
    ? changes
    : typeof rowsAffected === "number"
    ? rowsAffected
    : 0
}

const validateNamespace = (
  namespace: Namespace.Namespace
): Effect.Effect<Namespace.Namespace, MemoryError> =>
  Schema.decodeUnknownEffect(Namespace.Namespace)(namespace).pipe(
    Effect.mapError(() => error("invalid_namespace", "memory namespace is invalid"))
  )

const validateTags = (tags: Namespace.Tags): Effect.Effect<Namespace.Tags, MemoryError> =>
  Schema.decodeUnknownEffect(Namespace.Tags)(tags).pipe(
    Effect.mapError(() => error("invalid_tag", "memory tags violate the vocabulary or 16-tag cap"))
  )

const validateNonEmpty = (
  value: string,
  field: string,
  path: ReadonlyArray<string>
): Effect.Effect<string, MemoryError> =>
  value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(error("invalid_argument", `${field} must not be empty`, undefined, path))

const validateTime = (
  value: number,
  field: string,
  path: ReadonlyArray<string>
): Effect.Effect<number, MemoryError> =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(error("invalid_argument", `${field} must be a non-negative safe integer`, undefined, path))

const encodeJson = (
  value: unknown,
  field: string,
  path: ReadonlyArray<string>
): Effect.Effect<string, MemoryError> =>
  Effect.try({
    try: () => {
      const encoded = JSON.stringify(value)
      if (encoded === undefined) {
        throw new TypeError(`${field} is not JSON-serializable`)
      }
      return encoded
    },
    catch: () => error("invalid_argument", `${field} is not JSON-serializable`, undefined, path)
  })

const decodeJson = (value: string, field: string): Effect.Effect<unknown, MemoryError> =>
  Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) => error("store", `could not decode ${field}`, cause)
  })

const decodeProvenance = (value: string): Effect.Effect<Provenance, MemoryError> =>
  decodeJson(value, "provenance").pipe(
    Effect.flatMap((decoded) =>
      typeof decoded === "object" && decoded !== null
        ? Effect.succeed(decoded as Provenance)
        : Effect.fail(error("store", "stored provenance is not an object"))
    )
  )

const decodeTags = (value: string): Effect.Effect<Namespace.Tags, MemoryError> =>
  decodeJson(value, "tags").pipe(
    Effect.flatMap((decoded) =>
      Schema.decodeUnknownEffect(Namespace.Tags)(decoded).pipe(
        Effect.mapError((cause) => error("invalid_tag", "stored tags violate the memory vocabulary", cause))
      )
    )
  )

const decodeFact = (row: FactRow): Effect.Effect<Fact, MemoryError> =>
  Effect.all({
    value: decodeJson(row.value_json, "fact value"),
    provenance: decodeProvenance(row.provenance_json)
  }).pipe(
    Effect.map(({ provenance, value }) => ({
      namespace: { kind: row.namespace_kind, id: row.namespace_id },
      key: row.fact_key,
      value,
      ...(row.ttl_ms === null ? {} : { ttlMs: Number(row.ttl_ms) }),
      provenance,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }))
  )

const decodeNote = (row: NoteRow): Effect.Effect<Note, MemoryError> =>
  Effect.all({
    tags: decodeTags(row.tags_json),
    provenance: decodeProvenance(row.provenance_json)
  }).pipe(
    Effect.map(({ provenance, tags }) => ({
      namespace: { kind: row.namespace_kind, id: row.namespace_id },
      id: row.id,
      text: row.text,
      tags,
      provenance,
      status: row.status,
      createdAtMs: Number(row.created_at_ms)
    }))
  )

const decodeThread = (row: ThreadRow): Effect.Effect<Thread, MemoryError> =>
  (row.metadata_json === null
    ? Effect.succeed(undefined)
    : decodeJson(row.metadata_json, "thread metadata")).pipe(
      Effect.map((metadata) => ({
        id: row.thread_id,
        namespace: { kind: row.namespace_kind, id: row.namespace_id },
        ...(row.title === null ? {} : { title: row.title }),
        ...(metadata === undefined ? {} : { metadata }),
        createdAtMs: Number(row.created_at_ms),
        updatedAtMs: Number(row.updated_at_ms)
      }))
    )

const isExpired = (fact: Fact, now: number): boolean => fact.ttlMs !== undefined && fact.updatedAtMs + fact.ttlMs <= now

const statusMatches = (filter: StatusFilter | undefined, status: NoteStatus): boolean => {
  const selected = filter ?? "accepted"
  return selected === "any" || (Array.isArray(selected) ? selected.includes(status) : selected === status)
}

const DELETE_MESSAGES_CHUNK_SIZE = 900
const DELETE_EXPIRED_FACTS_CHUNK_SIZE = 256

/**
 * Builds the SQL-backed memory service and applies idempotent migrations.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make: Effect.Effect<Service, MemoryError, Crypto.Crypto | DurableWriter | SqlClient.SqlClient> = Effect
  .gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter
    const crypto = yield* Crypto.Crypto
    const database: Sql.DatabaseService = { sql, write: writer.write }
    yield* Sql.migrate(database).pipe(Effect.mapError(storeError("memory migration failed")))

    const listFacts: Service["listFacts"] = (input) =>
      Effect.gen(function*() {
        const namespace = yield* validateNamespace(input.namespace)
        const now = yield* Clock.currentTimeMillis
        const rows = yield* sql<FactRow>`SELECT
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
        FROM memory_facts
        WHERE namespace_kind = ${namespace.kind} AND namespace_id = ${namespace.id}
        ORDER BY fact_key`.pipe(Effect.mapError(storeError("could not list memory facts")))
        const facts = yield* Effect.forEach(rows, decodeFact)
        return facts.filter((fact) =>
          !isExpired(fact, now) && (input.prefix === undefined || fact.key.startsWith(input.prefix))
        )
      })

    const getFact: Service["getFact"] = (input) =>
      Effect.gen(function*() {
        const namespace = yield* validateNamespace(input.namespace)
        yield* validateNonEmpty(input.key, "fact key", ["key"])
        const rows = yield* sql<FactRow>`SELECT
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
        FROM memory_facts
        WHERE namespace_kind = ${namespace.kind}
          AND namespace_id = ${namespace.id}
          AND fact_key = ${input.key}
        LIMIT 1`.pipe(Effect.mapError(storeError("could not read memory fact")))
        if (rows.length === 0) {
          return undefined
        }
        const fact = yield* decodeFact(rows[0]!)
        const now = yield* Clock.currentTimeMillis
        return isExpired(fact, now) ? undefined : fact
      })

    const listAllFacts: Service["listAllFacts"] = () =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const rows = yield* sql<FactRow>`SELECT
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
        FROM memory_facts
        ORDER BY namespace_kind, namespace_id, fact_key`.pipe(
          Effect.mapError(storeError("could not list all memory facts"))
        )
        const facts = yield* Effect.forEach(rows, decodeFact)
        return facts.filter((fact) => !isExpired(fact, now))
      })

    const putFact: Service["putFact"] = (input) =>
      Effect.gen(function*() {
        const namespace = yield* validateNamespace(input.namespace)
        yield* validateNonEmpty(input.key, "fact key", ["key"])
        if (input.ttlMs !== undefined) {
          yield* validateTime(input.ttlMs, "ttlMs", ["ttlMs"])
        }
        const valueJson = yield* encodeJson(input.value, "fact value", ["value"])
        const value = yield* decodeJson(valueJson, "fact value")
        const provenanceJson = yield* encodeJson(input.provenance, "fact provenance", ["provenance"])
        const now = yield* Clock.currentTimeMillis
        yield* database.write(
          Effect.gen(function*() {
            yield* sql`INSERT INTO memory_facts (
            namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
            provenance_json, created_at_ms, updated_at_ms
          ) VALUES (
            ${namespace.kind}, ${namespace.id}, ${input.key}, ${valueJson}, ${input.ttlMs ?? null},
            ${provenanceJson}, ${now}, ${now}
          ) ON CONFLICT (namespace_kind, namespace_id, fact_key) DO UPDATE SET
            value_json = excluded.value_json,
            ttl_ms = excluded.ttl_ms,
            provenance_json = excluded.provenance_json,
            updated_at_ms = excluded.updated_at_ms`
            yield* Sql.replaceFtsRecord(database, namespace.kind, {
              recordId: input.key,
              recordKind: "fact",
              namespaceId: namespace.id,
              key: input.key,
              text: searchableText(value)
            })
          })
        ).pipe(Effect.mapError(storeError("could not write memory fact")))
      })

    const deleteFact: Service["deleteFact"] = (input) =>
      Effect.gen(function*() {
        const namespace = yield* validateNamespace(input.namespace)
        yield* validateNonEmpty(input.key, "fact key", ["key"])
        const deleted = yield* database.write(
          Effect.gen(function*() {
            const result = yield* sql`DELETE FROM memory_facts
            WHERE namespace_kind = ${namespace.kind}
              AND namespace_id = ${namespace.id}
              AND fact_key = ${input.key}`.raw
            yield* Sql.deleteFtsRecord(database, namespace.kind, {
              recordId: input.key,
              recordKind: "fact",
              namespaceId: namespace.id
            })
            yield* sql`DELETE FROM memory_vectors
            WHERE namespace_kind = ${namespace.kind}
              AND namespace_id = ${namespace.id}
              AND record_kind = 'fact'
              AND record_id = ${input.key}`
            return changed(result) > 0
          })
        ).pipe(Effect.mapError(storeError("could not delete memory fact")))
        return deleted
      })

    const getThread: Service["getThread"] = (threadId) =>
      Effect.gen(function*() {
        yield* validateNonEmpty(threadId, "threadId", ["threadId"])
        const rows = yield* sql<ThreadRow>`SELECT
        thread_id, namespace_kind, namespace_id, title, metadata_json,
        created_at_ms, updated_at_ms
        FROM memory_threads WHERE thread_id = ${threadId} LIMIT 1`.pipe(
          Effect.mapError(storeError("could not read memory thread"))
        )
        return rows[0] === undefined ? undefined : yield* decodeThread(rows[0])
      })

    const createThread: Service["createThread"] = (input) =>
      Effect.gen(function*() {
        const namespace = yield* validateNamespace(input.namespace)
        const id = input.id ?? (yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => error("store", "could not generate memory thread id", cause))
        ))
        yield* validateNonEmpty(id, "threadId", ["id"])
        const metadataJson = input.metadata === undefined
          ? null
          : canonicalJson(
            yield* decodeJson(
              yield* encodeJson(input.metadata, "thread metadata", ["metadata"]),
              "thread metadata"
            )
          )
        const now = yield* Clock.currentTimeMillis
        return yield* database.write(
          Effect.gen(function*() {
            const inserted = yield* sql`INSERT INTO memory_threads (
              thread_id, namespace_kind, namespace_id, title, metadata_json,
              created_at_ms, updated_at_ms
            ) VALUES (
              ${id}, ${namespace.kind}, ${namespace.id}, ${input.title ?? null}, ${metadataJson}, ${now}, ${now}
            ) ON CONFLICT (thread_id) DO NOTHING`.raw
            const rows = yield* sql<ThreadRow>`SELECT
              thread_id, namespace_kind, namespace_id, title, metadata_json,
              created_at_ms, updated_at_ms
              FROM memory_threads WHERE thread_id = ${id} LIMIT 1`
            const existing = rows[0]
            if (existing === undefined) {
              return yield* Effect.fail(error("store", "created memory thread could not be read back"))
            }
            if (changed(inserted) === 0) {
              const existingMetadata = existing.metadata_json === null
                ? null
                : canonicalJson(yield* decodeJson(existing.metadata_json, "thread metadata"))
              if (
                existing.namespace_kind !== namespace.kind || existing.namespace_id !== namespace.id ||
                existing.title !== (input.title ?? null) || existingMetadata !== metadataJson
              ) {
                return yield* Effect.fail(
                  error("store", `thread id "${id}" already exists with different creation data`)
                )
              }
            }
            return yield* decodeThread(existing)
          })
        ).pipe(Effect.mapError(storeError("could not create memory thread")))
      })

    const listThreads: Service["listThreads"] = (input = {}) =>
      Effect.gen(function*() {
        const namespace = input.namespace === undefined
          ? undefined
          : yield* validateNamespace(input.namespace)
        const rows = yield* (namespace === undefined
          ? sql<ThreadRow>`SELECT
          thread_id, namespace_kind, namespace_id, title, metadata_json,
          created_at_ms, updated_at_ms
          FROM memory_threads ORDER BY created_at_ms, thread_id`
          : sql<ThreadRow>`SELECT
          thread_id, namespace_kind, namespace_id, title, metadata_json,
          created_at_ms, updated_at_ms
          FROM memory_threads
          WHERE namespace_kind = ${namespace.kind} AND namespace_id = ${namespace.id}
          ORDER BY created_at_ms, thread_id`).pipe(
            Effect.mapError(storeError("could not list memory threads"))
          )
        return yield* Effect.forEach(rows, decodeThread)
      })

    const deleteThread: Service["deleteThread"] = (threadId) =>
      Effect.gen(function*() {
        yield* validateNonEmpty(threadId, "threadId", ["threadId"])
        return yield* database.write(
          Effect.gen(function*() {
            yield* sql`DELETE FROM memory_messages WHERE thread_id = ${threadId}`
            const result = yield* sql`DELETE FROM memory_threads WHERE thread_id = ${threadId}`.raw
            return changed(result) > 0
          })
        ).pipe(Effect.mapError(storeError("could not delete memory thread")))
      })

    const appendMessage: Service["appendMessage"] = (input) =>
      Effect.gen(function*() {
        yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
        yield* validateNonEmpty(input.id, "message id", ["id"])
        yield* validateNonEmpty(input.role, "message role", ["role"])
        yield* validateTime(input.at, "message at", ["at"])
        yield* database.write(
          Effect.gen(function*() {
            yield* sql`INSERT INTO memory_threads (
            thread_id, namespace_kind, namespace_id, created_at_ms, updated_at_ms
          )
            VALUES (${input.threadId}, 'global', 'history', ${input.at}, ${input.at})
            ON CONFLICT (thread_id) DO NOTHING`
            const inserted = yield* sql`INSERT INTO memory_messages (id, thread_id, role, text, at_ms)
            VALUES (${input.id}, ${input.threadId}, ${input.role}, ${input.text}, ${input.at})
            ON CONFLICT (thread_id, id) DO NOTHING`.raw
            if (changed(inserted) > 0) {
              yield* sql`UPDATE memory_threads
              SET updated_at_ms = MAX(updated_at_ms, ${input.at})
              WHERE thread_id = ${input.threadId}`
              return
            }
            const existing = yield* sql<MessageRow>`SELECT thread_id, id, role, text, at_ms
              FROM memory_messages
              WHERE thread_id = ${input.threadId} AND id = ${input.id}
              LIMIT 1`
            const message = existing[0]
            if (message === undefined) {
              return yield* Effect.fail(error("store", "existing memory message could not be read back"))
            }
            const conflict = message.role !== input.role
              ? "role"
              : message.text !== input.text
              ? "text"
              : Number(message.at_ms) !== input.at
              ? "at"
              : undefined
            if (conflict !== undefined) {
              return yield* Effect.fail(
                error(
                  "idempotency_conflict",
                  `message id "${input.id}" already exists in thread "${input.threadId}" with different ${conflict}`,
                  undefined,
                  [conflict]
                )
              )
            }
          })
        ).pipe(Effect.mapError(storeError("could not append memory message")))
      })

    const listMessages: Service["listMessages"] = (input) =>
      Effect.gen(function*() {
        yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
        const rows = yield* sql<MessageRow>`SELECT thread_id, id, role, text, at_ms
        FROM memory_messages
        WHERE thread_id = ${input.threadId}
        ORDER BY at_ms, id`.pipe(Effect.mapError(storeError("could not list memory messages")))
        return rows.map((row) => ({
          threadId: row.thread_id,
          id: row.id,
          role: row.role,
          text: row.text,
          at: Number(row.at_ms)
        }))
      })

    const countMessages: Service["countMessages"] = (input) =>
      Effect.gen(function*() {
        yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
        const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM memory_messages WHERE thread_id = ${input.threadId}
      `.pipe(Effect.mapError(storeError("could not count memory messages")))
        return Number(rows[0]?.count ?? 0)
      })

    const deleteMessageRows = (threadId: string, ids: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        let deleted = 0
        for (let offset = 0; offset < ids.length; offset += DELETE_MESSAGES_CHUNK_SIZE) {
          const chunk = ids.slice(offset, offset + DELETE_MESSAGES_CHUNK_SIZE)
          const result = yield* sql`DELETE FROM memory_messages
          WHERE thread_id = ${threadId} AND ${sql.in("id", chunk)}`.raw
          deleted += changed(result)
        }
        return deleted
      })

    const supersededIds = (
      namespace: Namespace.Namespace
    ): Effect.Effect<ReadonlySet<string>, MemoryError> =>
      sql<{ readonly target_id: string }>`SELECT edges.target_id
      FROM memory_note_supersedes edges
      JOIN memory_notes superseder ON superseder.id = edges.superseder_id
      JOIN memory_notes target ON target.id = edges.target_id
      WHERE superseder.status = 'accepted'
        AND target.namespace_kind = ${namespace.kind}
        AND target.namespace_id = ${namespace.id}`.pipe(
        Effect.map((rows) => new Set(rows.map((row) => row.target_id))),
        Effect.mapError(storeError("could not read memory supersession edges"))
      )

    const readNotes = (
      input: ListNotesInput
    ): Effect.Effect<ReadonlyArray<Note>, MemoryError> =>
      Effect.gen(function*() {
        const { namespace } = yield* resolveNamespace(input.namespace)
        const rows = yield* sql<NoteRow>`SELECT
        namespace_kind, namespace_id, id, text, tags_json,
        provenance_json, status, created_at_ms
        FROM memory_notes
        WHERE namespace_kind = ${namespace.kind} AND namespace_id = ${namespace.id}
        ORDER BY created_at_ms, id`.pipe(Effect.mapError(storeError("could not list memory notes")))
        const notes = yield* Effect.forEach(rows, decodeNote)
        const hidden = input.includeSuperseded === true ? new Set<string>() : yield* supersededIds(namespace)
        return notes.filter((note) =>
          statusMatches(input.status, note.status) &&
          !hidden.has(note.id) &&
          (input.tagGroup === undefined || Namespace.matches(input.tagGroup, note.tags)) &&
          (input.tagGroups === undefined || input.tagGroups.every((group) => Namespace.matches(group, note.tags)))
        )
      })

    const putNote: Service["putNote"] = (input) =>
      Effect.gen(function*() {
        const namespace = yield* validateNamespace(input.namespace)
        yield* validateNonEmpty(input.id, "note id", ["id"])
        const status = input.status ?? "accepted"
        const encodedTags = yield* encodeJson(input.tags, "note tags", ["tags"])
        const tags = yield* validateTags(
          (yield* decodeJson(encodedTags, "note tags")) as Namespace.Tags
        )
        const tagsJson = canonicalJson(tags)
        const encodedProvenance = yield* encodeJson(input.provenance, "note provenance", ["provenance"])
        const provenanceJson = canonicalJson(yield* decodeJson(encodedProvenance, "note provenance"))
        const supersedes = Array.from(new Set(input.supersedes ?? [])).sort(compareText)
        if (supersedes.includes(input.id)) {
          return yield* Effect.fail(error("supersede_conflict", "a note cannot supersede itself"))
        }
        const now = yield* Clock.currentTimeMillis
        const row = yield* database.write(
          Effect.gen(function*() {
            const inserted = yield* sql`INSERT INTO memory_notes (
            namespace_kind, namespace_id, id, text, tags_json,
            provenance_json, status, created_at_ms
          ) VALUES (
            ${namespace.kind}, ${namespace.id}, ${input.id}, ${input.text}, ${tagsJson},
            ${provenanceJson}, ${status}, ${now}
            ) ON CONFLICT (id) DO NOTHING`.raw
            const created = changed(inserted) > 0
            const persisted = yield* sql<NoteRow>`SELECT
            namespace_kind, namespace_id, id, text, tags_json,
            provenance_json, status, created_at_ms
            FROM memory_notes WHERE id = ${input.id} LIMIT 1`
            if (persisted.length === 0) {
              return yield* Effect.fail(error("store", "inserted note could not be read back"))
            }
            const existing = persisted[0]!
            if (!created) {
              const existingProvenance = canonicalJson(
                yield* decodeJson(existing.provenance_json, "note provenance")
              )
              if (
                existing.namespace_kind !== namespace.kind || existing.namespace_id !== namespace.id ||
                existing.text !== input.text || existing.tags_json !== tagsJson ||
                existingProvenance !== provenanceJson
              ) {
                return yield* Effect.fail(
                  error("supersede_conflict", `note id "${input.id}" already exists with different creation data`)
                )
              }
              const persistedEdges = yield* sql<{ readonly target_id: string }>`SELECT target_id
                FROM memory_note_supersedes
                WHERE superseder_id = ${input.id}
                ORDER BY target_id`
              const targets = persistedEdges.map((edge) => edge.target_id).sort(compareText)
              if (
                targets.length !== supersedes.length ||
                targets.some((target, index) => target !== supersedes[index])
              ) {
                return yield* Effect.fail(
                  error("supersede_conflict", `note id "${input.id}" already exists with different supersession data`)
                )
              }
            } else {
              for (const targetId of supersedes) {
                const target = yield* sql<{ readonly id: string }>`
                  SELECT id FROM memory_notes
                  WHERE id = ${targetId}
                    AND namespace_kind = ${namespace.kind}
                    AND namespace_id = ${namespace.id}
                  LIMIT 1
                `
                if (target.length === 0) {
                  return yield* Effect.fail(
                    error("supersede_conflict", `superseded note "${targetId}" does not exist`)
                  )
                }
                yield* sql`INSERT INTO memory_note_supersedes (superseder_id, target_id, created_at_ms)
                  VALUES (${input.id}, ${targetId}, ${now})
                  ON CONFLICT (superseder_id, target_id) DO NOTHING`
              }
              yield* Sql.replaceFtsRecord(database, namespace.kind, {
                recordId: input.id,
                recordKind: "note",
                namespaceId: namespace.id,
                key: input.id,
                text: input.text
              })
            }
            return existing
          })
        ).pipe(Effect.mapError(storeError("could not insert memory note")))
        const note = yield* decodeNote(row)
        return note
      })

    const getNote: Service["getNote"] = (input) =>
      Effect.gen(function*() {
        yield* validateNonEmpty(input.id, "note id", ["id"])
        const rows = yield* sql<NoteRow>`SELECT
        namespace_kind, namespace_id, id, text, tags_json,
        provenance_json, status, created_at_ms
        FROM memory_notes WHERE id = ${input.id} LIMIT 1`.pipe(
          Effect.mapError(storeError("could not read memory note"))
        )
        return rows[0] === undefined ? undefined : yield* decodeNote(rows[0])
      })

    const setNoteStatus: Service["setNoteStatus"] = (input) =>
      Effect.gen(function*() {
        yield* validateNonEmpty(input.id, "note id", ["id"])
        const result = yield* database.write(
          sql`UPDATE memory_notes SET status = ${input.status} WHERE id = ${input.id}`.raw
        ).pipe(Effect.mapError(storeError("could not update memory note status")))
        if (changed(result) === 0) {
          return yield* Effect.fail(error("not_found", `memory note "${input.id}" was not found`))
        }
      })

    const supersede: Service["supersede"] = (input) =>
      Effect.gen(function*() {
        yield* validateNonEmpty(input.supersederId, "supersederId", ["supersederId"])
        yield* validateNonEmpty(input.targetId, "targetId", ["targetId"])
        if (input.supersederId === input.targetId) {
          return yield* Effect.fail(error("supersede_conflict", "a note cannot supersede itself"))
        }
        const now = yield* Clock.currentTimeMillis
        yield* database.write(
          Effect.gen(function*() {
            const rows = yield* sql<{
              readonly id: string
              readonly namespace_kind: Namespace.Kind
              readonly namespace_id: string
            }>`SELECT id, namespace_kind, namespace_id FROM memory_notes
            WHERE id = ${input.supersederId} OR id = ${input.targetId}`
            const found = new Set(rows.map((row) => row.id))
            if (!found.has(input.supersederId) || !found.has(input.targetId)) {
              return yield* Effect.fail(
                error("supersede_conflict", "both superseder and target notes must exist")
              )
            }
            const superseder = rows.find((row) => row.id === input.supersederId)!
            const target = rows.find((row) => row.id === input.targetId)!
            if (
              superseder.namespace_kind !== target.namespace_kind ||
              superseder.namespace_id !== target.namespace_id
            ) {
              return yield* Effect.fail(error("supersede_conflict", "superseder and target must share a namespace"))
            }
            yield* sql`INSERT INTO memory_note_supersedes (superseder_id, target_id, created_at_ms)
            VALUES (${input.supersederId}, ${input.targetId}, ${now})
            ON CONFLICT (superseder_id, target_id) DO NOTHING`
          })
        ).pipe(Effect.mapError(storeError("could not write memory supersession edge")))
      })

    const searchRows: Service["searchRows"] = (input) =>
      Effect.gen(function*() {
        if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 0)) {
          return yield* Effect.fail(
            error("invalid_argument", "searchRows limit must be a non-negative safe integer", undefined, ["limit"])
          )
        }
        const { bank, namespace } = yield* resolveNamespace(input.namespace)
        const [facts, notes] = yield* Effect.all([
          listFacts({ namespace }),
          readNotes(input)
        ])
        const factRows = facts.map((fact): SearchRow => ({
          id: fact.key,
          kind: "fact",
          bank,
          namespace: fact.namespace,
          key: fact.key,
          text: searchableText(fact.value),
          tags: retainedTags(fact.value),
          updatedAtMs: fact.updatedAtMs
        }))
        const noteRows = notes.map((note): SearchRow => ({
          id: note.id,
          kind: "note",
          bank,
          namespace: note.namespace,
          key: note.id,
          text: note.text,
          tags: note.tags,
          updatedAtMs: note.createdAtMs,
          status: note.status
        }))
        const rows = [...factRows, ...noteRows]
          .filter((row) =>
            (input.tagGroup === undefined || Namespace.matches(input.tagGroup, row.tags)) &&
            (input.tagGroups === undefined || input.tagGroups.every((group) => Namespace.matches(group, row.tags)))
          )
          .sort((left, right) => right.updatedAtMs - left.updatedAtMs || compareText(left.key, right.key))
        if (input.limit === undefined) {
          return rows
        }
        return rows.slice(0, input.limit)
      })

    const enableFts: Service["enableFts"] = (kind) =>
      Effect.gen(function*() {
        const decodedKind = yield* Schema.decodeUnknownEffect(Namespace.Kind)(kind).pipe(
          Effect.mapError(() => error("invalid_namespace", "FTS namespace kind is invalid"))
        )
        const now = yield* Clock.currentTimeMillis
        yield* database.write(Sql.enableFts(database, decodedKind, now)).pipe(
          Effect.mapError(storeError(`could not enable FTS for "${decodedKind}"`))
        )
      })

    const searchFts: Service["searchFts"] = (input) =>
      Effect.gen(function*() {
        const limit = input.limit ?? 20
        if (!Number.isSafeInteger(limit) || limit < 0) {
          return yield* Effect.fail(
            error("invalid_argument", "searchFts limit must be a non-negative safe integer", undefined, ["limit"])
          )
        }
        const { namespace } = yield* resolveNamespace(input.namespace)
        const enabled = yield* Sql.isFtsEnabled(database, namespace.kind).pipe(
          Effect.mapError(storeError("could not inspect FTS enablement"))
        )
        if (!enabled) {
          return yield* Effect.fail(
            error(
              "fts_not_enabled",
              `FTS is not enabled for namespace kind "${namespace.kind}"; call enableFts first`
            )
          )
        }
        const query = literalFtsQuery(input.query)
        if (query.length === 0) {
          return []
        }
        if (limit === 0) {
          return []
        }
        const matches = yield* Sql.searchFts(database, namespace.kind, namespace.id, query, limit).pipe(
          Effect.mapError(storeError("memory FTS query failed"))
        )
        const rows = yield* searchRows({
          namespace,
          ...(input.tagGroup === undefined ? {} : { tagGroup: input.tagGroup }),
          ...(input.tagGroups === undefined ? {} : { tagGroups: input.tagGroups }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.includeSuperseded === undefined ? {} : { includeSuperseded: input.includeSuperseded })
        })
        const byId = new Map(rows.map((row) => [`${row.kind}\0${row.id}`, row]))
        const ordered: Array<FtsRow> = []
        for (const match of matches) {
          const row = byId.get(`${match.record_kind}\0${match.record_id}`)
          if (row !== undefined) {
            const rank = Number(match.rank)
            ordered.push({ ...row, rank, score: -rank })
          }
          if (ordered.length === limit) {
            break
          }
        }
        return ordered
      })

    const deleteExpiredFacts: Service["deleteExpiredFacts"] = Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        database.write(
          Effect.gen(function*() {
            let deleted = 0
            let hasMore = true
            while (hasMore) {
              const expiring = yield* sql<{
                readonly namespace_kind: Namespace.Kind
                readonly namespace_id: string
                readonly fact_key: string
              }>`SELECT namespace_kind, namespace_id, fact_key
                FROM memory_facts
                WHERE ttl_ms IS NOT NULL AND updated_at_ms + ttl_ms <= ${now}
                ORDER BY namespace_kind, namespace_id, fact_key
                LIMIT ${DELETE_EXPIRED_FACTS_CHUNK_SIZE}`
              if (expiring.length === 0) {
                break
              }
              for (const fact of expiring) {
                yield* Sql.deleteFtsRecord(database, fact.namespace_kind, {
                  recordId: fact.fact_key,
                  recordKind: "fact",
                  namespaceId: fact.namespace_id
                })
                yield* sql`DELETE FROM memory_vectors
                  WHERE namespace_kind = ${fact.namespace_kind}
                    AND namespace_id = ${fact.namespace_id}
                    AND record_kind = 'fact'
                    AND record_id = ${fact.fact_key}`
                const result = yield* sql`DELETE FROM memory_facts
                  WHERE namespace_kind = ${fact.namespace_kind}
                    AND namespace_id = ${fact.namespace_id}
                    AND fact_key = ${fact.fact_key}
                    AND ttl_ms IS NOT NULL
                    AND updated_at_ms + ttl_ms <= ${now}`.raw
                deleted += changed(result)
              }
              hasMore = expiring.length === DELETE_EXPIRED_FACTS_CHUNK_SIZE
            }
            return deleted
          })
        )
      ),
      Effect.mapError(storeError("could not delete expired memory facts"))
    )

    const listThreadIds: Service["listThreadIds"] = sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM memory_threads ORDER BY created_at_ms, thread_id
  `.pipe(
      Effect.map((rows) => rows.map((row) => row.thread_id)),
      Effect.mapError(storeError("could not list memory threads"))
    )

    const deleteMessages: Service["deleteMessages"] = (input) =>
      Effect.gen(function*() {
        yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
        const ids = Array.from(new Set(input.ids))
        if (ids.length === 0) {
          return 0
        }
        return yield* database.write(deleteMessageRows(input.threadId, ids)).pipe(
          Effect.mapError(storeError("could not delete memory messages"))
        )
      })

    const compactMessages: Service["compactMessages"] = (input) =>
      Effect.gen(function*() {
        if (input.summary.threadId !== input.threadId) {
          return yield* Effect.fail(
            error(
              "invalid_argument",
              "summary threadId must match the compacted thread",
              undefined,
              ["summary", "threadId"]
            )
          )
        }
        const ids = Array.from(new Set(input.deleteIds)).filter((id) => id !== input.summary.id)
        if (ids.length === 0) {
          return 0
        }
        const result = yield* database.write(
          Effect.gen(function*() {
            const inserted = yield* sql`INSERT INTO memory_messages (id, thread_id, role, text, at_ms)
            VALUES (
              ${input.summary.id}, ${input.summary.threadId}, ${input.summary.role},
              ${input.summary.text}, ${input.summary.at}
            ) ON CONFLICT (thread_id, id) DO NOTHING`.raw
            if (changed(inserted) === 0) {
              return yield* Effect.fail(error("store", `summary id "${input.summary.id}" already exists`))
            }
            return yield* deleteMessageRows(input.threadId, ids)
          })
        ).pipe(Effect.mapError(storeError("could not compact memory history")))
        return result
      })

    return MemoryStore.of({
      putFact,
      getFact,
      deleteFact,
      listFacts,
      listAllFacts,
      createThread,
      getThread,
      listThreads,
      deleteThread,
      appendMessage,
      listMessages,
      countMessages,
      putNote,
      getNote,
      setNoteStatus,
      supersede,
      listNotes: readNotes,
      enableFts,
      searchFts,
      searchRows,
      deleteExpiredFacts,
      listThreadIds,
      deleteMessages,
      compactMessages
    })
  })

/**
 * Constructs an unavailable store stub, optionally overriding operations.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string): Effect.Effect<never, MemoryError> =>
    Effect.fail(error("store", `${method} is unavailable`))
  return MemoryStore.of({
    putFact: () => unavailable("putFact"),
    getFact: () => unavailable("getFact"),
    deleteFact: () => unavailable("deleteFact"),
    listFacts: () => unavailable("listFacts"),
    listAllFacts: () => unavailable("listAllFacts"),
    createThread: () => unavailable("createThread"),
    getThread: () => unavailable("getThread"),
    listThreads: () => unavailable("listThreads"),
    deleteThread: () => unavailable("deleteThread"),
    appendMessage: () => unavailable("appendMessage"),
    listMessages: () => unavailable("listMessages"),
    countMessages: () => unavailable("countMessages"),
    putNote: () => unavailable("putNote"),
    getNote: () => unavailable("getNote"),
    setNoteStatus: () => unavailable("setNoteStatus"),
    supersede: () => unavailable("supersede"),
    listNotes: () => unavailable("listNotes"),
    enableFts: () => unavailable("enableFts"),
    searchFts: () => unavailable("searchFts"),
    searchRows: () => unavailable("searchRows"),
    deleteExpiredFacts: unavailable("deleteExpiredFacts"),
    listThreadIds: unavailable("listThreadIds"),
    deleteMessages: () => unavailable("deleteMessages"),
    compactMessages: () => unavailable("compactMessages"),
    ...overrides
  })
}

/**
 * Provides an unavailable memory store.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<MemoryStore> =>
  Layer.succeed(MemoryStore)(makeNoop(overrides))

/**
 * Provides the authoritative SQL memory store over the SQL client and the
 * durable writer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<MemoryStore, MemoryError, Crypto.Crypto | DurableWriter | SqlClient.SqlClient> = Layer
  .effect(
    MemoryStore
  )(make)
