/**
 * Run two flows as real children of a third, join their results, and observe
 * that a re-driven parent does not run them again.
 *
 * `flow.call(payload)` splices a flow's body into the caller's graph: one plan,
 * one run. `flow.child(payload)` is the other thing entirely — a separate
 * durable run with its own row, its own claim, and its own journal, opened
 * through the same `execute` a handler would call. The parent suspends while a
 * child is unsettled and resumes when it settles, and the engine records the
 * lineage edge in `flows_run_parents` so the relationship survives the process
 * that created it.
 *
 * That durability is what the second phase shows. Re-executing the parent under
 * the same execution id observes each child's persisted result instead of
 * starting a second child under the same id, so the children's bodies run once
 * across both executions.
 *
 * The join is an ordinary `Node.all`: two children settle concurrently, and the
 * report step reads each result off the joined placeholder as a payload field.
 */
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

/** The work the first child does. */
export const Bundle = Action.make("examples/Bundle", {
  payload: { target: Schema.String },
  success: Schema.String
})

/** The work the second child does. */
export const Sign = Action.make("examples/Sign", {
  payload: { target: Schema.String },
  success: Schema.String
})

/** The fan-in step: both children's results arrive as payload fields. */
export const Report = Action.make("examples/Report", {
  payload: { bundle: Schema.String, signature: Schema.String },
  success: Schema.String
})

/** The first child, an ordinary flow. Nothing marks it as a child. */
export const Compile = Flow.make("examples/Compile", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload: { readonly target: string }) => Bundle.call(payload)
})

/** The second child. */
export const Notarize = Flow.make("examples/Notarize", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload: { readonly target: string }) => Sign.call(payload)
})

/**
 * The parent. `.child()` is the only difference from an inline call, and it is
 * the difference between one run and three.
 */
export const Release = Flow.make("examples/Release", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: ({ target }: { readonly target: string }) =>
    Node.andThen(
      Node.all({
        bundle: Compile.child({ target }),
        signature: Notarize.child({ target })
      }),
      (results: Planned.Planned<{ readonly bundle: string; readonly signature: string }>) =>
        Report.call({ bundle: results.bundle, signature: results.signature })
    )
})

/** One child run, as durable state records it. */
export interface Child {
  readonly runId: string
  /**
   * The parent the durable edge names.
   *
   * Read from `flows_run_parents` rather than from `RunRow.parentRunId`: that
   * column carries a trampoline's previous round, and a child's link to its
   * parent is the edge table plus the `parentExecutionId` the child's own
   * state document records. `EngineChildren` reads the same two.
   */
  readonly parentId: string
  /** The parent the child's own state document records. */
  readonly parentExecutionId: string | undefined
  readonly status: string
}

/** What the two executions of the parent observed. */
export interface Summary {
  /** The report the first execution produced. */
  readonly report: string
  /** The report the re-driven execution produced. */
  readonly replayed: string
  /** The children the engine linked to the parent, in the order it linked them. */
  readonly children: ReadonlyArray<Child>
  /** How many times each child's body ran across BOTH executions. */
  readonly dispatches: Readonly<Record<string, number>>
}

/** The parent's execution id. Its children derive theirs from it. */
export const releaseRunId = "release-1"

/** Runs the parent twice over one SQLite file and reads its lineage back. */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const dispatches: Record<string, number> = { bundle: 0, sign: 0, report: 0 }

    const bundle = Bundle.toLayer(({ target }) =>
      Effect.sync(() => {
        dispatches.bundle! += 1
        return `dist/${target}.js`
      })
    )
    const sign = Sign.toLayer(({ target }) =>
      Effect.sync(() => {
        dispatches.sign! += 1
        return `${target}.sig`
      })
    )
    const report = Report.toLayer((parts) =>
      Effect.sync(() => {
        dispatches.report! += 1
        return `${parts.bundle} + ${parts.signature}`
      })
    )

    const stack = Layer.mergeAll(
      bundle,
      sign,
      report,
      Interpreter.layer(Release),
      Interpreter.layer(Compile),
      Interpreter.layer(Notarize)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(durableEngine(filename, "examples-release"))
    )

    return yield* Effect.scoped(
      Effect.gen(function*() {
        const first = yield* Release.execute({ target: "server" }, { executionId: releaseRunId })
        // The same execution id: a re-drive, not a second release. The children
        // are read out of durable state rather than started again.
        const replayed = yield* Release.execute({ target: "server" }, { executionId: releaseRunId })

        const state = yield* DurableEngineState.DurableEngineState
        const runs = yield* RunStore.RunStore
        const edges = yield* state.runChildren(releaseRunId)
        const children = yield* Effect.forEach(edges, (edge) =>
          Effect.map(runs.get(edge.childId), (row) => {
            const state = JSON.parse(row.stateJson) as { readonly parentExecutionId?: string }
            return {
              runId: row.runId,
              parentId: edge.parentId,
              parentExecutionId: state.parentExecutionId,
              status: row.status
            } satisfies Child
          }))

        return { report: first, replayed, children, dispatches } satisfies Summary
      }).pipe(Effect.provide(stack))
    )
  }).pipe(Effect.orDie)
