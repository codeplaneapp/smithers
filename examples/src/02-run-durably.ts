/**
 * Run a flow on the durable engine and read the journal it wrote.
 *
 * The authoring model is the one example 01 introduces: `Bundle` is the
 * declared atom the flow's `body` names, and `Compile` is the sealed action
 * that atom's implementation runs. What changes here is the engine underneath:
 * `EngineStore` claims a run row, fences it with a heartbeat, persists every
 * action attempt, and commits each lifecycle event in the same transaction as
 * the state transition it describes.
 */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

/**
 * The declared atom the body names. Declaration and implementation are
 * separate: this value is pure data and travels anywhere, and the layer below
 * attaches the code on a host that can run it.
 */
export const Bundle = Action.make("examples/Bundle", {
  payload: { target: Schema.String },
  success: Schema.String
})

export const Build = Flow.make("examples/Build", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Bundle.call(payload)
})

/**
 * A sealed action with a cache key input. The identity is what makes the
 * recorded result addressable across runs; without it the action would fall
 * back to a run-local invocation key.
 *
 * DECIDED (2026-08-11, pending review): the target stays OUT of this
 * declaration and is stamped on by the caller. A sealed key is built from the
 * action name, its declared `idempotencyKey`, and its schemas — never from
 * the payload — so moving `target` in here would make two targets share one
 * cache row. Inputs that vary per call belong in the calling step, or in an
 * `idempotencyKey` that names them.
 */
export const Compile = Action.make({
  name: "examples/Compile",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "examples/compile/v1",
  execute: Effect.succeed("dist/server.js")
})

export interface Summary {
  readonly result: string
  readonly eventTypes: ReadonlyArray<string>
}

/** Executes the flow, then reads back the durable journal for that run. */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const result = yield* Build.execute({ target: "server" }, { executionId: "build-1" })
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: "build-1" as JournalEvent.RunId, limit: 200 })
    return {
      result,
      eventTypes: page.entries.map((entry) => entry.eventType)
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Bundle.toLayer(({ target }) => Effect.map(Compile, (artifact) => `${artifact}?target=${target}`)),
        Interpreter.layer(Build)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(durableEngine(filename, "examples-worker"))
      )
    ),
    Effect.scoped,
    Effect.orDie
  )
