/**
 * Probes sandbox liveness under a deadline.
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { HealthState } from "./HealthState.ts"
import { Healthy } from "./Healthy.ts"
import type { PingProvider } from "./PingProvider.ts"
import type { ProbeOptions } from "./ProbeOptions.ts"
import { Unhealthy } from "./Unhealthy.ts"

/**
 * Default deadline used when a probe does not specify one.
 *
 * @private
 * @since 0.1.0
 */
const defaultDeadline: Duration.Input = "5 seconds"

/**
 * Runs one ping under a deadline and reports a typed health state.
 *
 * A failed ping becomes `Unhealthy(reason: "ping_failed")`; a ping that
 * outlives the deadline becomes `Unhealthy(reason: "unresponsive")`. The
 * probe opens a `SandboxHealth.probe` span annotated with the outcome, and a
 * failed ping's full cause is logged at debug level — the flattened `message`
 * on the reported state is a summary, not the only record of the failure.
 *
 * @category constructors
 * @since 0.1.0
 */
export const probe = (
  provider: PingProvider,
  options?: ProbeOptions
): Effect.Effect<HealthState> =>
  Effect.timeoutOrElse(
    Effect.matchEffect(provider.ping, {
      onSuccess: (): Effect.Effect<HealthState> => Effect.succeed(new Healthy()),
      onFailure: (error): Effect.Effect<HealthState> =>
        Effect.logDebug("sandbox ping failed", Cause.fail(error)).pipe(
          Effect.as(
            new Unhealthy({
              component: "sandbox",
              reason: "ping_failed",
              message: error.message
            })
          )
        )
    }),
    {
      duration: options?.deadline ?? defaultDeadline,
      orElse: () =>
        Effect.succeed<HealthState>(
          new Unhealthy({
            component: "sandbox",
            reason: "unresponsive",
            message: "sandbox ping did not answer within the probe deadline"
          })
        )
    }
  ).pipe(
    Effect.tap((state) => Effect.annotateCurrentSpan({ outcome: state._tag === "Healthy" ? "healthy" : state.reason })),
    Effect.withSpan("SandboxHealth.probe", {}, { captureStackTrace: false })
  )
