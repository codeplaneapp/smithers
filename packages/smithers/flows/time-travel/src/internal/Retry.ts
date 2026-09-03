/**
 * Tier-aware retry planning and execution.
 *
 * @since 0.1.0
 */
import { Jj } from "@smthrs/jj"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import type { EffectRecord } from "../EffectBoundary.ts"
import { error, type TimeTravelError } from "../TimeTravelError.ts"
import { EffectHandlerRegistry } from "./EffectHandlerRegistry.ts"

/**
 * Fresh attempt identity supplied to a rerun.
 *
 * Provider streams are always restarted from their durable boundary and never
 * resumed at an in-stream offset.
 *
 * @since 0.1.0
 * @category models
 */
export interface AttemptContext {
  readonly attempt: number
  readonly nonce: string
  readonly idempotencyKey?: string | undefined
  readonly restartAt: "durable-boundary"
  readonly resumeProviderStream: false
}

/**
 * A typed reason retry cannot safely invoke the action.
 *
 * @since 0.1.0
 * @category models
 */
export type BlockedReason =
  | "not_durable_boundary"
  | "idempotency_key_required"
  | "compensation_snapshot_missing"

/**
 * Retry result.
 *
 * @since 0.1.0
 * @category models
 */
export type Outcome<A> =
  | {
    readonly _tag: "CacheHit"
    readonly value: unknown
    readonly attempt: number
    readonly nonce: string
  }
  | {
    readonly _tag: "Rerun"
    readonly value: A
    readonly context: AttemptContext
  }
  | {
    readonly _tag: "Blocked"
    readonly reason: BlockedReason
    readonly message: string
    readonly attempt: number
    readonly nonce: string
  }

/**
 * Retry construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options<A, E, R> {
  readonly effect: EffectRecord
  readonly previousAttempt: number
  readonly previousNonce: string
  readonly rerun: (context: AttemptContext) => Effect.Effect<A, E, R>
  readonly makeNonce?: (
    effect: EffectRecord,
    attempt: number
  ) => Effect.Effect<string> | undefined
}

const freshNonce = <A, E, R>(
  options: Options<A, E, R>,
  attempt: number
): Effect.Effect<string> => {
  const generated = options.makeNonce?.(options.effect, attempt)
  return (generated ?? Random.nextInt.pipe(
    Effect.map((random) => `${options.effect.id}:attempt:${attempt}:nonce:${random}`)
  )).pipe(
    Effect.map((nonce) =>
      nonce === options.previousNonce
        ? `${nonce}:retry:${attempt}`
        : nonce
    )
  )
}

/**
 * Retries one effect according to its recorded tier.
 *
 * Sealed work first consults the cache and never invokes its producer on a
 * hit. Compensable work restores its pre-attempt jj snapshot before rerun.
 * Irreversible work returns a typed blocked outcome without an idempotency
 * key. Every actual rerun receives a strictly newer attempt and fresh nonce.
 *
 * @since 0.1.0
 * @category constructors
 */
export const retry = <A, E, R>(
  options: Options<A, E, R>
): Effect.Effect<
  Outcome<A>,
  E | TimeTravelError,
  R | CacheStore.CacheStore | EffectHandlerRegistry | Jj
> =>
  Effect.fn("Retry.retry")(() =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        effectId: options.effect.id,
        tier: options.effect.tier,
        previousAttempt: options.previousAttempt
      })
      const attempt = options.previousAttempt + 1
      const nonce = yield* freshNonce(options, attempt)
      const blocked = (
        reason: BlockedReason,
        message: string
      ): Outcome<A> => ({
        _tag: "Blocked",
        reason,
        message,
        attempt,
        nonce
      })

      if (!options.effect.durableBoundary) {
        return blocked(
          "not_durable_boundary",
          `effect ${options.effect.id} can only restart at its previous durable boundary`
        )
      }

      const cache = yield* CacheStore.CacheStore
      const registry = yield* EffectHandlerRegistry
      const jj = yield* Jj

      if (options.effect.tier === "sealed" && options.effect.cacheKey !== undefined) {
        const cached = yield* cache.get(options.effect.cacheKey).pipe(
          Effect.mapError((cause) =>
            error("unknown", `could not consult sealed retry ${options.effect.cacheKey}`, cause)
          )
        )
        if (Option.isSome(cached)) {
          const outcome: Outcome<A> = {
            _tag: "CacheHit",
            value: cached.value.result,
            attempt,
            nonce
          }
          return outcome
        }
      }

      if (options.effect.tier === "compensable") {
        if (options.effect.changeId === undefined) {
          return blocked(
            "compensation_snapshot_missing",
            `effect ${options.effect.id} has no pre-attempt jj snapshot`
          )
        }
        yield* jj.restore(options.effect.changeId).pipe(
          Effect.mapError((cause) =>
            error(
              "compensation_failed",
              `could not restore ${options.effect.changeId} before retry`,
              cause
            )
          )
        )
      }

      if (options.effect.tier === "irreversible") {
        const handler = registry.resolve(options.effect.kind)
        const requiresKey = handler?.requiresIdempotencyKey ?? true
        if (requiresKey && options.effect.idempotencyKey === undefined) {
          return blocked(
            "idempotency_key_required",
            `irreversible effect ${options.effect.id} requires an idempotency key before retry`
          )
        }
      }

      const context: AttemptContext = {
        attempt,
        nonce,
        ...(options.effect.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.effect.idempotencyKey }),
        restartAt: "durable-boundary",
        resumeProviderStream: false
      }
      const value = yield* options.rerun(context)
      const outcome: Outcome<A> = { _tag: "Rerun", value, context }
      return outcome
    })
  )()
