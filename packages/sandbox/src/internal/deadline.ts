/**
 * Bounds a conformance check on the wall clock.
 *
 * @since 0.1.0
 */
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"

/**
 * Completes after `duration` on the platform's own timer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const elapsed = (duration: Duration.Input): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration))
    return Effect.sync(() => clearTimeout(timer))
  })

/**
 * A deadline on the wall clock, not the ambient `Clock`.
 *
 * Provider test suites commonly run under a frozen test clock (`it.effect`
 * provides one), where a clock-based timeout never fires; a conformance suite
 * whose hang protection depends on the very layer a host may freeze would
 * hang exactly when it is needed. The timer here is the platform's own, so a
 * stuck check is convicted under any clock, and losing the race interrupts
 * the check, which closes its scope and ends whatever it spawned.
 *
 * Both conformance suites share this, so neither can be hang-proof while the
 * other is not.
 *
 * @category constructors
 * @since 0.1.0
 */
export const expired = (deadline: Duration.Input): Effect.Effect<never, ProviderError> =>
  Effect.flatMap(
    elapsed(deadline),
    () =>
      Effect.fail(
        new ProviderError({
          code: "timeout",
          message: `the check did not finish within ${Duration.toMillis(deadline)} milliseconds`
        })
      )
  )

/**
 * How long any single conformance check may take before it is convicted as
 * hung. Sized for a backend that provisions a real machine per check.
 *
 * @category models
 * @since 0.1.0
 */
export const defaultCheckTimeout: Duration.Input = Duration.seconds(240)
