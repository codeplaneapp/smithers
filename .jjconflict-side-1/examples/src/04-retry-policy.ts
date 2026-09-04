/**
 * Retry a flaky action, and read the policy that decides when to stop.
 *
 * `RetryPolicy` is data. `nextDelay` and `decide` are pure functions over that
 * data, so a deployment can inspect a backoff ladder without running anything.
 * `Action.retry` is the runtime side: it re-dispatches the action and
 * advances `Action.CurrentAttempt`, which is the attempt number the durable
 * store addresses each attempt row by.
 */
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

class Flaky extends Schema.TaggedError<Flaky>()("examples/Flaky", {
  message: Schema.String
}) {}

/** Give up after four attempts; the third is the last that can be retried. */
export const policy = RetryPolicy.make({
  initialMs: 100,
  factor: 2,
  maxMs: 1_000,
  maxAttempts: 4,
  nonRetryable: ["examples/Fatal"]
})

/** The un-jittered backoff ladder this policy produces. */
export const ladder: ReadonlyArray<number | null> = [1, 2, 3, 4].map((attempt) =>
  Option.getOrNull(RetryPolicy.nextDelay(policy, attempt))
)

/** A non-retryable tag short-circuits the ladder regardless of attempt. */
export const fatalDecision = RetryPolicy.decide(policy, {
  attempt: 1,
  error: { _tag: "examples/Fatal" }
})

/**
 * The declared step the flow's body names. Its implementation is where the
 * retry loop lives, because retrying is what the atom does; the plan shows one
 * node either way.
 */
export const Release = Action.make("examples/Release", {
  payload: { release: Schema.String },
  success: Schema.String
})

export const Publish = Flow.make("examples/Publish", {
  payload: { release: Schema.String },
  success: Schema.String,
  body: (payload) => Release.call(payload)
})

export interface Summary {
  readonly result: string
  readonly dispatches: number
  readonly attempts: ReadonlyArray<number>
}

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    let dispatches = 0
    const attempts: Array<number> = []

    const Upload = Action.make({
      name: "examples/Upload",
      success: Schema.String,
      error: Flaky,
      tier: "sealed",
      execute: Effect.gen(function*() {
        const attempt = yield* Action.CurrentAttempt
        attempts.push(attempt)
        dispatches += 1
        return attempt < 3
          ? yield* Effect.fail(new Flaky({ message: `attempt ${attempt} lost the connection` }))
          : "uploaded"
      })
    })

    const publish = ({ release }: { readonly release: string }) =>
      Action.retry(Upload, { times: 3 }).pipe(
        Effect.map((outcome) => `${release}:${outcome}`),
        Effect.catchTag("examples/Flaky", (error) => Effect.succeed(`${release}:failed:${error.message}`))
      )

    const result = yield* Effect.scoped(
      Publish.execute({ release: "v1" }, { executionId: "publish-1" }).pipe(
        Effect.provide(
          Layer.mergeAll(Release.toLayer(publish), Interpreter.layer(Publish)).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(durableEngine(filename, "retry-worker"))
          )
        )
      )
    )

    return { result, dispatches, attempts }
  }).pipe(Effect.orDie)
