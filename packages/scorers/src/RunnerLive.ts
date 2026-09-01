/**
 * Scoped live scorer runner.
 *
 * Package documentation: `packages/scorers/docs/api.md`.
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Text from "./internal/text.ts"
import * as Runner from "./Runner.ts"
import * as Scorer from "./Scorer.ts"
import * as ScoreStore from "./ScoreStore.ts"

/**
 * Live runner worker configuration.
 *
 * A value that is not a positive safe integer is coerced to the default rather
 * than rejected, because the layer's error channel is `never` by contract.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** Concurrent workers; defaults to 1. */
  readonly concurrency?: number | undefined
  /** Maximum queued jobs; submission backpressures when this bound is full. Defaults to 1024. */
  readonly capacity?: number | undefined
}

const concurrency = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 1

const capacity = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 1_024

/**
 * Copies a job's scalar fields at the boundary.
 *
 * `submit` returns as soon as the job is queued, so without this the caller can
 * still reach `identity`, `targetStepKey`, or `at` and change them before a
 * worker takes the job. `readonly` is a compile-time promise only, and the
 * mutated values would reach `recordOnce`, breaking both replay and the
 * idempotency the identity exists for.
 *
 * @internal
 */
const snapshot = (job: Runner.Job): Runner.Job => ({
  identity: job.identity,
  observation: {
    targetStepKey: job.observation.targetStepKey,
    scorerKey: job.observation.scorerKey
  },
  score: job.score,
  at: job.at
})

/**
 * Provides a scoped non-blocking queue and a blocking batch runner.
 *
 * Scorer failures become inconclusive observations. Fiber interruption still
 * propagates, while score-store failures never fail the target or batch: they
 * are logged as warnings instead. Total silence was the earlier behavior and
 * it made a persisted observation, a duplicate suppressed by the job-claim
 * table, and an observation lost to a database failure indistinguishable.
 *
 * `submit` does not wait for the scorer to run, but it backpressures once
 * `capacity` queued jobs are outstanding.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: Options = {}): Layer.Layer<Runner.Runner, never, ScoreStore.ScoreStore> =>
  Layer.effect(
    Runner.Runner,
    Effect.gen(function*() {
      const store = yield* ScoreStore.ScoreStore
      const queue = yield* Queue.bounded<Runner.Job>(capacity(options.capacity))
      const execute = (job: Runner.Job): Effect.Effect<Runner.Outcome> =>
        job.score.pipe(
          Effect.flatMap(Scorer.validate),
          Effect.map((result): ScoreStore.ScoreObservation => ({
            targetStepKey: job.observation.targetStepKey,
            scorerKey: job.observation.scorerKey,
            kind: "score",
            score: result.score,
            ...(result.reason === undefined
              ? {}
              : { reason: Text.truncate(result.reason, ScoreStore.maxReasonBytes) }),
            ...(result.meta === undefined ? {} : { meta: result.meta }),
            at: job.at
          })),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.succeed(Runner.inconclusive(job, cause))
          ),
          Effect.flatMap((observation) =>
            store.recordOnce(job.identity, observation).pipe(
              Effect.map((recorded): Runner.Recorded => recorded ? "persisted" : "duplicate"),
              Effect.catch((error) =>
                Effect.logWarning("Could not record a scorer observation", error).pipe(
                  Effect.as<Runner.Recorded>("failed")
                )
              ),
              Effect.map((recorded): Runner.Outcome => ({ identity: job.identity, observation, recorded }))
            )
          )
        )
      const worker = Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap(execute),
          Effect.asVoid
        )
      )
      yield* Effect.forkScoped(
        Effect.forEach(
          Array.from({ length: concurrency(options.concurrency) }),
          () => worker,
          { concurrency: "unbounded", discard: true }
        )
      )
      const runBatchCorrelated: Runner.Service["runBatchCorrelated"] = (jobs, batchOptions) =>
        Effect.forEach(jobs, (job) => execute(snapshot(job)), {
          concurrency: concurrency(batchOptions?.concurrency ?? options.concurrency)
        })
      return Runner.make({
        submit: (job) => Queue.offer(queue, snapshot(job)).pipe(Effect.asVoid),
        runBatch: (jobs, batchOptions) =>
          runBatchCorrelated(jobs, batchOptions).pipe(
            Effect.map((outcomes) => outcomes.map((outcome) => outcome.observation))
          ),
        runBatchCorrelated
      })
    })
  )
