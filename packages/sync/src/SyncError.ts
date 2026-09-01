/**
 * Stable, schema-backed failures for the sync boundary.
 *
 * @since 0.1.0
 */
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { Resync } from "./SyncProtocol.ts"

/**
 * Stable error codes returned by sync operations.
 *
 * `compacted` reports that the request's cursor for one run starts below that
 * run's compaction floor, so the entries it asks for have been deleted. It is
 * its own code rather than an `unknown` because it is RECOVERABLE and nothing
 * else here is: the accompanying {@link SyncError.resync} names the checkpoint
 * to resume from, and a follower that applies it converges. Folding it into
 * `unknown` cost the checkpoint, and with it every path back.
 *
 * @category models
 * @since 0.1.0
 */
export const ErrorCode = Schema.Literals([
  "invalid_request",
  "unauthorized",
  "not_found",
  "gap_detected",
  "backpressure",
  "frame_too_large",
  "decode_failed",
  "transport_failed",
  "protocol_violation",
  "optimistic_timeout",
  "compacted",
  "closed",
  "unknown"
]).annotate({ identifier: "@smthrs/sync/ErrorCode" })

/**
 * Stable error code returned by a sync operation.
 *
 * @category models
 * @since 0.1.0
 */
export type ErrorCode = typeof ErrorCode.Type

/**
 * Error raised by sync validation, transport, framing, or subscription work.
 *
 * `resync` is set only on `compacted`, and names the run and the checkpoint
 * sequence a follower resumes from. It is optional so every other code keeps
 * the shape it already had on the wire.
 *
 * @category errors
 * @since 0.1.0
 */
export class SyncError extends Schema.TaggedError<SyncError>()("@smthrs/sync/SyncError", {
  code: ErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
  resync: Schema.optional(Resync)
}) {
  /**
   * Returns `true` when a value is a `SyncError`.
   *
   * @since 0.1.0
   */
  static readonly is = (value: unknown): value is SyncError => Predicate.isTagged(value, "@smthrs/sync/SyncError")
}

/**
 * Terminal error raised when a server frame starts beyond the client's
 * covered cursor.
 *
 * @category errors
 * @since 0.1.0
 */
export class SyncGapError extends Schema.TaggedError<SyncGapError>()("@smthrs/sync/SyncGapError", {
  runId: JournalEvent.RunId,
  expectedFrom: JournalEvent.Seq,
  receivedFrom: JournalEvent.Seq
}) {}
