/**
 * Failure raised when a cancellation request could not be made durable.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Raised when `interrupt` could not durably record its cancellation request.
 *
 * This is a **typed failure**, never a defect, and never swallowed. A durable
 * runtime records operator intent before it interrupts anything: the record is
 * what tells the interruption handler that a cancellation happened rather than
 * a shutdown (issue #26), what survives the requesting process dying, and what
 * a parked or cross-process run is eventually cancelled by. A durable runtime
 * records the run and all linked descendants in one transaction. A storage
 * failure on any write leaves every request unchanged: the run is still
 * running and still cancellable, so the caller sees this typed failure and can
 * retry instead of receiving false success.
 *
 * A runtime that keeps no durable cancellation record — the in-memory engine —
 * never raises it, so its `Effect<void>` remains assignable to the widened
 * contract and no in-memory caller has to handle anything.
 *
 * The error is declared here because it is part of the `interrupt` contract
 * this package owns; the durable implementation lives in
 * `@smthrs/engine-store`'s `RunDriver`.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class CancelRequestFailed extends Schema.TaggedError<CancelRequestFailed>()(
  "flows/engine/CancelRequestFailed",
  {
    /** Stable public error code. */
    code: Schema.Literal("cancel_request_failed"),
    /** The execution whose cancellation could not be recorded. */
    executionId: Schema.String,
    /** The storage failure, rendered for an operator. */
    reason: Schema.String
  }
) {}
