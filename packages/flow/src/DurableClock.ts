// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Durable timers for flow sleeps.
 *
 * `make` creates a `DurableClock` with a name, duration, and deferred wake-up
 * signal. `sleep` ignores zero durations, runs short sleeps through an
 * in-memory action, and schedules longer sleeps through the `FlowRuntime`
 * before awaiting the durable deferred tied to the clock.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import * as Action from "./Action/index.ts"
import * as DurableDeferred from "./DurableDeferred.ts"
import { FlowInstance } from "./FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"

const TypeId = "~effect/flow/DurableClock"

/**
 * Represents a durable flow timer with a name, duration, and deferred
 * completed when the timer wakes.
 *
 * @category models
 * @since 4.0.0
 * @slop
 */
export interface DurableClock {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly duration: Duration.Duration
  readonly deferred: DurableDeferred.DurableDeferred<typeof Schema.Void>
}

/**
 * Creates a durable clock definition and its associated deferred wake-up
 * signal.
 *
 * @category constructors
 * @since 4.0.0
 * @slop
 */
export const make = (options: {
  readonly name: string
  readonly duration: Duration.Input
}): DurableClock => ({
  [TypeId]: TypeId,
  name: options.name,
  duration: Duration.fromInputUnsafe(options.duration),
  deferred: DurableDeferred.make(`DurableClock/${options.name}`)
})

/**
 * Waits inside a flow, using an in-memory action for durations at or
 * below the threshold and scheduling a durable clock for longer durations.
 *
 * @category sleeping
 * @since 4.0.0
 * @slop
 */
export const sleep: (
  options: {
    readonly name: string
    readonly duration: Duration.Input
    /**
     * If the duration is less than or equal to this threshold, the clock will
     * be executed in memory.
     *
     * @default 60 seconds
     */
    readonly inMemoryThreshold?: Duration.Input | undefined
  }
) => Effect.Effect<
  void,
  never,
  Crypto.Crypto | FlowRuntime | FlowInstance
> =
  // Untraced because durable sleeps are recursively resumed by the engine.
  Effect.fnUntraced(function*(options: {
    readonly name: string
    readonly duration: Duration.Input
    readonly inMemoryThreshold?: Duration.Input | undefined
  }) {
    const duration = Duration.fromInputUnsafe(options.duration)
    if (Duration.isZero(duration)) {
      return
    }

    const inMemoryThreshold = options.inMemoryThreshold
      ? Duration.fromInputUnsafe(options.inMemoryThreshold)
      : defaultInMemoryThreshold

    if (Duration.isLessThanOrEqualTo(duration, inMemoryThreshold)) {
      return yield* Action.make({
        name: `DurableClock/${options.name}`,
        tier: "sealed",
        execute: Effect.sleep(duration)
      })
    }

    const engine = yield* FlowRuntime
    const instance = yield* FlowInstance
    const clock = make(options)
    yield* engine.scheduleClock(instance.flow, {
      executionId: instance.executionId,
      clock
    })
    return yield* DurableDeferred.await(clock.deferred)
  })

const defaultInMemoryThreshold = Duration.seconds(60)
