/**
 * Non-blocking and blocking scorer runner contract.
 *
 * @see docs/specs/Concepts/Scoring.md
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { Result as ScorerResult } from "./Scorer.ts"
import { ScorerError } from "./ScorerError.ts"
import type { Observation, ObservationBase } from "./ScoreStore.ts"

/**
 * One scorer execution request.
 *
 * @category models
 * @since 0.1.0
 */
export interface Job {
  readonly identity: string
  readonly observation: Pick<ObservationBase, "targetStepKey" | "scorerKey">
  readonly score: Effect.Effect<ScorerResult, unknown>
  readonly at: number
}

/**
 * Batch execution options.
 *
 * @category models
 * @since 0.1.0
 */
export interface BatchOptions {
  readonly concurrency?: number | undefined
}

/**
 * Runtime scorer runner implementation.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly submit: (job: Job) => Effect.Effect<void>
  readonly runBatch: (
    jobs: ReadonlyArray<Job>,
    options?: BatchOptions | undefined
  ) => Effect.Effect<ReadonlyArray<Observation>>
}

/**
 * Context service for live and batch scorer execution.
 *
 * @category services
 * @since 0.1.0
 */
export class Runner extends Context.Service<Runner, Service>()("flows/scorers/Runner") {}

/**
 * Constructs a scorer runner.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (service: Service): Service => Runner.of(service)

/**
 * Constructs an inoperative scorer runner.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service =>
  Runner.of({
    submit: () => Effect.void,
    runBatch: () => Effect.succeed([])
  })

/**
 * Provides the inoperative scorer runner.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Runner> = Layer.succeed(Runner)(makeNoop())

/**
 * Converts a scorer failure into a typed inconclusive observation.
 *
 * The reason names the cause. It is the only field that reaches a report, so a
 * fixed sentence made a scorer that threw a `TypeError`, which is a bug to fix,
 * indistinguishable from an unreachable judge, which is an outage to wait out.
 *
 * @category converting
 * @since 0.1.0
 */
export const inconclusive = (job: Job, cause: unknown): Observation => {
  const failure = new ScorerError({
    code: "inconclusive",
    message: "Scorer execution was inconclusive",
    cause
  })
  return {
    ...job.observation,
    kind: "inconclusive",
    reason: `${failure.message}: ${String(Cause.isCause(cause) ? Cause.squash(cause) : cause)}`,
    at: job.at
  }
}
