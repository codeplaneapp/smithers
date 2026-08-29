/**
 * The fencing token the journal accepts on durable appends.
 *
 * `OwnerId` lives here rather than with the ownership *arbitration* in
 * `@smthrs/run-store` because the journal is what it fences: `emitDurable`
 * takes an owner and refuses the append when the persisted fence has moved on.
 * The journal therefore defines the token, and the run store — which stores it
 * on runs and arbitrates who holds it — imports it.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 * Schema boundary: `docs/specs/Research/Smithers Deviations 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * A process identity scoped to a host and a unique ownership nonce.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const OwnerId = Schema.Struct({
  hostId: Schema.String,
  pid: Schema.Number,
  nonce: Schema.String
})

/**
 * A process identity scoped to a host and a unique ownership nonce.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type OwnerId = typeof OwnerId.Type
