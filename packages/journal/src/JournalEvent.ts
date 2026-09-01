/**
 * Durable event-envelope schemas for the journal.
 *
 * Governing design: `docs/pages/concepts/journal.md`.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * A UTF-16 surrogate with no partner: a high surrogate not followed by a low
 * one, or a low surrogate not preceded by a high one. `String.isWellFormed`
 * answers the same question but needs the ES2024 lib, which this package does
 * not target.
 */
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * A persistable identifier: non-empty, and representable in the store.
 *
 * SQLite binds a lone UTF-16 surrogate as U+FFFD, so two ill-formed
 * identifiers that differ only in their surrogates land on ONE persisted key.
 * The second run's first event then dedupes into the first run's row and reads
 * by either id return the same history, which destroys run isolation at the
 * persistence boundary. Rejecting ill-formed text at the schema keeps the
 * identifier the caller decoded and the identifier the database stores the
 * same value.
 *
 * The empty string is rejected for a plainer reason: it names nothing, and the
 * journal used to accept it at decode and then reject it at the service, so a
 * caller could hold a "valid" identifier the next call refused.
 */
const identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((value: string) => !loneSurrogate.test(value), { title: "wellFormedIdentifier" })
)

/**
 * Schema for an identifier of one durable run.
 *
 * Non-empty and free of unpaired UTF-16 surrogates, because the store cannot
 * tell two ill-formed identifiers apart.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RunId = identifier.pipe(Schema.brand("@smthrs/journal/JournalEvent/RunId"))

/**
 * Branded identifier of one durable run.
 *
 * @category models
 * @since 0.1.0
 */
export type RunId = typeof RunId.Type

/**
 * Schema for the canonical, durable sequence number within a run.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("@smthrs/journal/JournalEvent/Seq")
)

/**
 * Canonical durable per-run sequence number.
 *
 * @category models
 * @since 0.1.0
 */
export type Seq = typeof Seq.Type

/**
 * Schema for an event producer identifier.
 *
 * Non-empty and free of unpaired UTF-16 surrogates, on the same terms as
 * `RunId`: the pair identifies a producer's retries in the database.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SourceId = identifier.pipe(Schema.brand("@smthrs/journal/JournalEvent/SourceId"))

/**
 * Identifier of an event producer.
 *
 * @category models
 * @since 0.1.0
 */
export type SourceId = typeof SourceId.Type

/**
 * Schema for a producer-local event sequence number.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SourceSeq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("@smthrs/journal/JournalEvent/SourceSeq")
)

/**
 * Producer-local event sequence number.
 *
 * @category models
 * @since 0.1.0
 */
export type SourceSeq = typeof SourceSeq.Type

/**
 * Schema for what a re-emitted `(runId, sourceId, sourceSeq)` identity means.
 *
 * `content` is the default and the strict reading: the identity names one set
 * of bytes, so a producer that re-emits it with different bytes has a bug and
 * the journal says so with `idempotency_conflict`.
 *
 * `identity` is for a producer that derives the sequence from the event
 * itself. There a collision IS the same event observed twice, and the bytes
 * that differ between the two observations are metadata ABOUT the observation
 * rather than the event: when a replayed frame was re-recorded, how long a
 * step took the second time a durable engine served it from its record. The
 * first admitted row stands and the re-emission settles as `Duplicate`. Only
 * declare it with a sequence derived from the event's own content, because
 * the journal then has nothing else with which to notice two different events
 * wearing one identity.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Dedupe = Schema.Literals(["content", "identity"])

/**
 * What a re-emitted producer identity means.
 *
 * @category models
 * @since 0.1.0
 */
export type Dedupe = typeof Dedupe.Type

/**
 * Schema for an event submitted to the journal.
 *
 * Event types and values intentionally remain an open envelope. The durable
 * core never closes this into an interpreter-specific union.
 *
 * @category schemas
 * @since 0.1.0
 */
export class Input extends Schema.Class<Input>("@smthrs/journal/JournalEvent/Input")({
  runId: RunId,
  sourceId: SourceId,
  sourceSeq: Schema.optional(SourceSeq),
  /** How a collision on this event's identity is settled. Defaults to `content`. */
  dedupe: Schema.optional(Dedupe),
  eventType: identifier,
  payload: Schema.Unknown,
  meta: Schema.optional(Schema.Unknown)
}) {}

/**
 * Schema for a committed durable journal row.
 *
 * `seq` is allocated synchronously at journal admission and is the only
 * sequence used for replay and durable provenance. `sourceSeq` identifies
 * retries from one producer.
 *
 * @category schemas
 * @since 0.1.0
 */
export class Entry extends Schema.Class<Entry>("@smthrs/journal/JournalEvent/Entry")({
  runId: RunId,
  seq: Seq,
  eventId: Schema.String,
  sourceId: SourceId,
  sourceSeq: SourceSeq,
  emittedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  eventType: Schema.String,
  payload: Schema.Unknown,
  meta: Schema.Unknown
}) {}

/**
 * Makes a collision-free deterministic event identifier from the idempotency
 * key `(runId, sourceId, sourceSeq)`.
 *
 * Length prefixes preserve tuple boundaries even when identifiers contain the
 * separator. The value is deliberately not random: retrying the same source
 * event must produce the same durable id.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeEventId = (runId: RunId, sourceId: SourceId, sourceSeq: SourceSeq): string =>
  `flows:event:${runId.length}:${runId}${sourceId.length}:${sourceId}${sourceSeq}`
