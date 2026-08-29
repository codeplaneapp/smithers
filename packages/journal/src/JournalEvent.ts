/**
 * Durable event-envelope schemas for the journal.
 *
 * Governing design: `docs/specs/Concepts/Journal Queue.md`.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Schema for an identifier of one durable run.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const RunId = Schema.String.pipe(Schema.brand("@smthrs/journal/JournalEvent/RunId"))

/**
 * Branded identifier of one durable run.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type RunId = typeof RunId.Type

/**
 * Schema for the canonical, durable sequence number within a run.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("@smthrs/journal/JournalEvent/Seq")
)

/**
 * Canonical durable per-run sequence number.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Seq = typeof Seq.Type

/**
 * Schema for an event producer identifier.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const SourceId = Schema.String.pipe(Schema.brand("@smthrs/journal/JournalEvent/SourceId"))

/**
 * Identifier of an event producer.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SourceId = typeof SourceId.Type

/**
 * Schema for a producer-local event sequence number.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const SourceSeq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("@smthrs/journal/JournalEvent/SourceSeq")
)

/**
 * Producer-local event sequence number.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SourceSeq = typeof SourceSeq.Type

/**
 * Schema for an event submitted to the journal.
 *
 * Event types and values intentionally remain an open envelope. The durable
 * core never closes this into an interpreter-specific union.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export class Input extends Schema.Class<Input>("@smthrs/journal/JournalEvent/Input")({
  runId: RunId,
  sourceId: SourceId,
  sourceSeq: Schema.optional(SourceSeq),
  eventType: Schema.String,
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
 * @slop
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
 * @slop
 */
export const makeEventId = (runId: RunId, sourceId: SourceId, sourceSeq: SourceSeq): string =>
  `flows:event:${runId.length}:${runId}${sourceId.length}:${sourceId}${sourceSeq}`
