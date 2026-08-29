/**
 * Immutable registry for effect-specific compensation handlers.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { EffectRecord, type EffectTier } from "../EffectBoundary.ts"
import { error, type TimeTravelError } from "../TimeTravelError.ts"

/**
 * The classification returned by an irreversible-effect handler during
 * rewind preflight.
 *
 * @since 0.1.0
 * @category models
 */
export const Classification = Schema.Literals(["revertible", "warning", "blocking"])
/**
 * The value form of {@link Classification}.
 *
 * @since 0.1.0
 * @category models
 */
export type Classification = typeof Classification.Type

/**
 * A handler's immutable preflight result.
 *
 * `residue` is always operator-facing disclosure of what remains outside the
 * journal if the boundary is crossed.
 *
 * @since 0.1.0
 * @category models
 */
export const Assessment = Schema.Struct({
  classification: Classification,
  reason: Schema.String,
  residue: Schema.String
})
/**
 * The value form of {@link Assessment}.
 *
 * @since 0.1.0
 * @category models
 */
export type Assessment = typeof Assessment.Type

/**
 * Durable evidence produced after one handler reverses an effect.
 *
 * The receipt contains everything the same handler needs to reverse its
 * compensation during rewind rollback or startup recovery.
 *
 * @since 0.1.0
 * @category models
 */
export const RollbackReceipt = Schema.Struct({
  id: Schema.NonEmptyString,
  effect: EffectRecord,
  data: Schema.Unknown
})
/**
 * The value form of {@link RollbackReceipt}.
 *
 * @since 0.1.0
 * @category models
 */
export type RollbackReceipt = typeof RollbackReceipt.Type

/**
 * A compensation handler registered under a stable effect kind.
 *
 * Handlers are closed values: all services required by `assess`, `revert`,
 * and `rollback` must be provided when the handler layer is constructed.
 *
 * @since 0.1.0
 * @category models
 */
export interface Handler {
  readonly kind: string
  readonly tier: EffectTier
  readonly requiresIdempotencyKey: boolean
  readonly residue: (effect: EffectRecord) => string
  readonly assess?: ((effect: EffectRecord) => Effect.Effect<Assessment, TimeTravelError>) | undefined
  readonly revert: (effect: EffectRecord) => Effect.Effect<unknown, TimeTravelError>
  readonly rollback: (effect: EffectRecord, receipt: unknown) => Effect.Effect<void, TimeTravelError>
}

/**
 * Immutable effect-handler lookup and execution operations.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly handlers: HashMap.HashMap<string, Handler>
  readonly register: (handler: Handler) => Effect.Effect<Service, TimeTravelError>
  readonly resolve: (kind: string) => Handler | undefined
  readonly assess: (effect: EffectRecord) => Effect.Effect<Assessment, TimeTravelError>
  readonly revert: (effect: EffectRecord) => Effect.Effect<RollbackReceipt, TimeTravelError>
  readonly rollback: (receipt: RollbackReceipt) => Effect.Effect<void, TimeTravelError>
}

/**
 * Layer-provided immutable effect-handler registry.
 *
 * @since 0.1.0
 * @category services
 */
export class EffectHandlerRegistry extends Context.Service<EffectHandlerRegistry, Service>()(
  "@smthrs/time-travel/EffectHandlerRegistry"
) {}

const duplicate = (kind: string): TimeTravelError => error("unknown", `effect handler ${kind} is already registered`)

const missing = (kind: string): TimeTravelError =>
  error("irreversible", `no compensation handler is registered for effect kind ${kind}`)

const fromHandlers = (handlers: HashMap.HashMap<string, Handler>): Service => {
  const resolve = (kind: string): Handler | undefined => Option.getOrUndefined(HashMap.get(handlers, kind))

  const service = EffectHandlerRegistry.of({
    handlers,
    register: (handler) =>
      HashMap.has(handlers, handler.kind)
        ? Effect.fail(duplicate(handler.kind))
        : Effect.succeed(fromHandlers(HashMap.set(handlers, handler.kind, handler))),
    resolve,
    assess: (effect) => {
      const handler = resolve(effect.kind)
      if (handler === undefined) {
        return Effect.succeed({
          classification: "blocking" as const,
          reason: `No compensation handler is registered for ${effect.kind}.`,
          residue: effect.residue ?? `The ${effect.kind} effect remains outside the journal.`
        })
      }
      if (handler.tier !== effect.tier) {
        return Effect.succeed({
          classification: "blocking" as const,
          reason: `Handler ${effect.kind} is registered for ${handler.tier}, not ${effect.tier}.`,
          residue: handler.residue(effect)
        })
      }
      if (effect.status !== "succeeded") {
        return Effect.succeed({
          classification: "blocking" as const,
          reason: `Effect ${effect.id} has ${effect.status} completion state.`,
          residue: handler.residue(effect)
        })
      }
      return handler.assess === undefined
        ? Effect.succeed({
          classification: "revertible" as const,
          reason: `Handler ${effect.kind} can compensate the recorded effect.`,
          residue: handler.residue(effect)
        })
        : handler.assess(effect)
    },
    revert: (effect) => {
      const handler = resolve(effect.kind)
      if (handler === undefined) return Effect.fail(missing(effect.kind))
      if (handler.tier !== effect.tier) {
        return Effect.fail(
          error(
            "irreversible",
            `handler ${effect.kind} cannot compensate ${effect.tier} effect ${effect.id}`
          )
        )
      }
      return handler.revert(effect).pipe(
        Effect.map((data) => ({
          id: `${effect.id}:rollback`,
          effect,
          data
        })),
        Effect.mapError((cause) =>
          error("compensation_failed", `handler ${effect.kind} could not revert ${effect.id}`, cause)
        )
      )
    },
    rollback: (receipt) => {
      const handler = resolve(receipt.effect.kind)
      if (handler === undefined) return Effect.fail(missing(receipt.effect.kind))
      return handler.rollback(receipt.effect, receipt.data).pipe(
        Effect.mapError((cause) =>
          error(
            "compensation_failed",
            `handler ${receipt.effect.kind} could not roll back compensation for ${receipt.effect.id}`,
            cause
          )
        )
      )
    }
  })
  return service
}

/**
 * Constructs an immutable registry and rejects duplicate effect kinds before
 * exposing it.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  handlers: Iterable<Handler> = []
): Effect.Effect<Service, TimeTravelError> => {
  let registry = HashMap.empty<string, Handler>()
  for (const handler of handlers) {
    if (HashMap.has(registry, handler.kind)) return Effect.fail(duplicate(handler.kind))
    registry = HashMap.set(registry, handler.kind, handler)
  }
  return Effect.succeed(fromHandlers(registry))
}

/**
 * Constructs an empty immutable registry.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (): Service => fromHandlers(HashMap.empty())

/**
 * Provides an immutable registry after validating all registrations.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  handlers: Iterable<Handler> = []
): Layer.Layer<EffectHandlerRegistry, TimeTravelError> => Layer.effect(EffectHandlerRegistry, make(handlers))

/**
 * Provides an empty immutable registry.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerNoop: Layer.Layer<EffectHandlerRegistry> = Layer.succeed(EffectHandlerRegistry, makeNoop())
