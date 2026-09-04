// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Defines typed action execution and identity failures.
 *
 * The `_tag` strings below were settled under `@smthrs/flow/` for
 * 1.0.0-rc.0. The RC makes no compatibility promise to 0.x journals, and
 * these tags freeze when the RC ships.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Marker an action implementation or adapter raises for an infrastructure
 * event it wants the action's `interruptRetryPolicy` to retry. Shipped engines
 * do not synthesize it from ordinary fiber interruption.
 *
 * @category errors
 * @since 0.1.0
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
 * An action spent its infrastructure-interrupt retry policy without reaching
 * an ordinary success or failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class InfraInterruptRetriesExhausted extends Schema.TaggedError<InfraInterruptRetriesExhausted>()(
  "@smthrs/flow/InfraInterruptRetriesExhausted",
  {
    code: Schema.Literal("infra_interrupt_retries_exhausted").pipe(
      Schema.withConstructorDefault(Effect.succeed("infra_interrupt_retries_exhausted"))
    ),
    actionName: Schema.String,
    attempts: Schema.Number,
    interrupt: InfraInterrupt,
    /**
     * The sentence an operator reads out of a rendered cause. The typed fields
     * beside it are what a log pipeline keys on.
     */
    message: Schema.String
  }
) {}

/**
 * An irreversible action attempted a retry without declaring an
 * idempotency key.
 *
 * @category errors
 * @since 0.1.0
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
 * concurrently, either keyless invocations of one declaration or same-key
 * invocations at a non-sealed tier (issue #130), so their ordinals, and with
 * them their step keys, attempt rows, and recorded outcomes, would be
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
