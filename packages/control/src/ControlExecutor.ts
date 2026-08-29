/**
 * Acceptance port from the control plane into a real run executor.
 *
 * Governing contract: `docs/specs/Concepts/Control API.md`.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer } from "effect"
import type { LaunchFailed } from "./ControlError.ts"
import type { StoredPlan } from "./ControlRuntime.ts"
import type { RunSummary } from "./ControlSchema.ts"

/**
 * One stored plan and the run summary it is being started as.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Launch {
  readonly plan: StoredPlan
  readonly run: RunSummary
}

/**
 * Whether the executor took the launch now or queued it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Acceptance = "accepted" | "pending"

/**
 * The acceptance port: the control plane hands a launch over and learns
 * only whether it was accepted.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly launch: (input: Launch) => Effect.Effect<Acceptance, LaunchFailed>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class ControlExecutor extends Context.Service<ControlExecutor, Service>()(
  "/control/ControlExecutor"
) {}

/**
 * Builds a {@link Service} from an implementation of its one method.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => ControlExecutor.of(implementation)

/**
 * A {@link Service} that accepts every launch as `pending` and starts
 * nothing. Overrides replace individual methods.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    launch: Effect.fn("ControlExecutor.launch")(() => Effect.succeed("pending" as const)),
    ...overrides
  })

/**
 * Provides {@link ControlExecutor} from an implementation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (implementation: Service): Layer.Layer<ControlExecutor> =>
  Layer.succeed(ControlExecutor)(make(implementation))

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ControlExecutor> =>
  Layer.succeed(ControlExecutor)(makeNoop(overrides))
