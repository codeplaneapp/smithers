/**
 * Scoped live scorer runner.
 *
 * @see docs/specs/Concepts/Scoring.md
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Runner from "./Runner.ts"
import * as Scorer from "./Scorer.ts"
import * as ScoreStore from "./ScoreStore.ts"

/**
 * Live runner worker configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly concurrency?: number | undefined
  /** Maximum queued jobs; submission backpressures when this bound is full. */
  readonly capacity?: number | undefined
}

const concurrency = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 1

const capacity = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 1_024

/**
 * Provides a scoped non-blocking queue and a blocking batch runner.
 *
 * Scorer failures become inconclusive observations. Fiber interruption still
 * propagates, while score-store failures never fail the target or batch.
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
      const execute = (job: Runner.Job): Effect.Effect<ScoreStore.Observation> =>
        job.score.pipe(
          Effect.flatMap(Scorer.validate),
          Effect.map((result): ScoreStore.ScoreObservation => ({
            ...job.observation,
            kind: "score",
            score: result.score,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
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
              Effect.catch(() => Effect.succeed(false)),
              Effect.as(observation)
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
      return Runner.make({
        submit: (job) => Queue.offer(queue, job).pipe(Effect.asVoid),
        runBatch: (jobs, batchOptions) =>
          Effect.forEach(jobs, execute, {
            concurrency: concurrency(batchOptions?.concurrency ?? options.concurrency)
          })
      })
    })
  )
