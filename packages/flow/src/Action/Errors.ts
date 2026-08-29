// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Defines typed action execution and identity failures.
 *
 * The `_tag` strings below keep the `@smthrs/engine/` prefix they were minted
 * with. A tag is wire format: durable stores persist encoded exits carrying
 * it, so renaming one to match this package would make every stored row
 * decode as an unknown error on replay. The owning package moved; the tag did
 * not.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Marker raised by an engine when an action is interrupted by host loss or
 * rebalancing rather than user cancellation.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class InfraInterrupt extends Schema.TaggedError<InfraInterrupt>()(
  "@smthrs/flow/InfraInterrupt",
  {
    code: Schema.Literal("infra_interrupt").pipe(
      Schema.withConstructorDefault(Effect.succeed("infra_interrupt"))
    ),
    reason: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * An irreversible action attempted a retry without declaring an
 * idempotency key.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class IrreversibleRetryRequiresIdempotencyKey
  extends Schema.TaggedError<IrreversibleRetryRequiresIdempotencyKey>()(
    "@smthrs/flow/IrreversibleRetryRequiresIdempotencyKey",
    {
      code: Schema.Literal("irreversible_retry_requires_idempotency_key").pipe(
        Schema.withConstructorDefault(Effect.succeed("irreversible_retry_requires_idempotency_key"))
      ),
      actionName: Schema.String,
      attempt: Schema.Number
    }
  )
{}

/**
 * Two ordinal-keyed invocations of one allocation scope were in flight
 * concurrently — keyless invocations of one declaration, or same-key
 * invocations at a non-sealed tier (issue #130) — so their ordinals, and
 * with them their step keys, attempt rows, and recorded outcomes, would be
 * assigned by fiber arrival order. A crash-resume that replays the fibers in
 * the opposite order would silently hand one invocation the other's recorded
 * outcome (issue #111); Temporal fails such replays with a nondeterminism
 * error, and the engine refuses the hazard up front instead of detecting it
 * after the corruption. Declare an `idempotencyKey` *distinguishing* the
 * invocations to dispatch them concurrently; a sealed action with a key
 * takes a pure cache key and is exempt.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class ConcurrentKeylessDispatch extends Schema.TaggedError<ConcurrentKeylessDispatch>()(
  "@smthrs/flow/ConcurrentKeylessDispatch",
  {
    code: Schema.Literal("concurrent_keyless_dispatch").pipe(
      Schema.withConstructorDefault(Effect.succeed("concurrent_keyless_dispatch"))
    ),
    actionName: Schema.String
  }
) {}

/**
 * A caller-declared object-form `idempotencyKey` carried material canonical
 * serialization rejects. The declaration can be fixed, and the error is
 * non-retryable: the same declaration
 * derives the same rejection on every attempt, so the body never runs.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class UncanonicalIdempotencyKey extends Schema.TaggedError<UncanonicalIdempotencyKey>()(
  "@smthrs/flow/UncanonicalIdempotencyKey",
  {
    code: Schema.Literal("uncanonical_idempotency_key").pipe(
      Schema.withConstructorDefault(Effect.succeed("uncanonical_idempotency_key"))
    ),
    actionName: Schema.String,
    /** Stable reason identifying an RFC 8785 canonicalization failure. */
    reason: Schema.String,
    /** The path of the offending value inside the declared identity. */
    path: Schema.String,
    message: Schema.String
  }
) {}
