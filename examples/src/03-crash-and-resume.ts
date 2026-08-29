/**
 * Suspend a run, drop the engine, and resume from durable state.
 *
 * Each phase builds its own engine over the same SQLite file, which is what a
 * process restart looks like from the database's point of view. Phase one runs
 * until `DurableDeferred.await` finds no recorded completion, suspends, and
 * releases ownership. Phase two attaches the same implementation, completes the
 * deferred, and drives the run to a result.
 *
 * The flow is a body over one declared step, `Assess`. Its implementation is
 * where the durable wait lives, which is what makes the counters below the
 * replay contract: the step's implementation runs twice, and the sealed
 * action in front of the suspension dispatches once.
 */
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

export const Assess = Action.make("examples/Assess", {
  payload: { document: Schema.String },
  success: Schema.String
})

export const Review = Flow.make("examples/Review", {
  payload: { document: Schema.String },
  success: Schema.String,
  body: (payload) => Assess.call(payload)
})

export const Approval = DurableDeferred.make("examples/approval", {
  success: Schema.String
})

export interface Summary {
  readonly result: string
  readonly readDispatches: number
  readonly stepEntries: number
}

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    let readDispatches = 0
    let stepEntries = 0

    const ReadDocument = Action.make({
      name: "examples/ReadDocument",
      success: Schema.String,
      tier: "sealed",
      idempotencyKey: "examples/read-document/v1",
      execute: Effect.sync(() => {
        readDispatches += 1
        return "draft body"
      })
    })

    const assess = ({ document }: { readonly document: string }) =>
      Effect.gen(function*() {
        stepEntries += 1
        const body = yield* ReadDocument
        const verdict = yield* DurableDeferred.await(Approval)
        return `${document}:${body}:${verdict}`
      })

    const engine = (hostId: string) =>
      Layer.mergeAll(Assess.toLayer(assess), Interpreter.layer(Review)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(durableEngine(filename, hostId))
      )

    // Phase one: the run suspends at the deferred and releases its claim.
    yield* Effect.scoped(
      Review.execute({ document: "rfc" }, { executionId: "review-1", discard: true }).pipe(
        Effect.provide(engine("worker-a"))
      )
    )

    // Phase two: a fresh engine completes the deferred and finishes the run.
    const result = yield* Effect.scoped(
      Effect.gen(function*() {
        const flowEngine = yield* FlowRuntime.FlowRuntime
        yield* flowEngine.deferredDone(Approval, {
          flowName: Review._tag,
          executionId: "review-1",
          deferredName: Approval.name,
          exit: Exit.succeed("approved")
        })
        return yield* Review.execute({ document: "rfc" }, { executionId: "review-1" })
      }).pipe(Effect.provide(engine("worker-b")))
    )

    return { result, readDispatches, stepEntries }
  }).pipe(Effect.orDie)
