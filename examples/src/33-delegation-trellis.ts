/**
 * Run a plan a model authored, durably, one trampoline round per plan.
 *
 * A flow body is built before it runs, so a body can only branch on values it
 * already holds. A delegated plan is not one: it is written while the run is in
 * flight. That is the whole reason `@smthrs/patterns` splits `Trellis` into a
 * declaration half and a runtime half, and it is why the durable recipe is a
 * handoff rather than a loop inside one round.
 *
 * The two rounds below are those halves:
 *
 * 1. `Delegate` calls the author step and hands the plan off with `.to`. The
 *    plan leaves this round as the next round's PAYLOAD, which is what makes it
 *    ordinary data by the time anything reads it.
 * 2. `RunPlan` receives that payload, so `Trellis.validate` and `Trellis.leaves`
 *    run over a real plan while the graph is being built. The leaves become one
 *    `Node.all` join of durable steps, and the round settles.
 *
 * Each round is its own journal segment, so a crash resumes at a round boundary
 * and never inside a tree no graph described. See
 * `docs/pages/api/patterns-delegation.md`.
 */
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import { Trellis } from "@smthrs/patterns"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

/** The bounds this delegation admits a plan under. */
export const envelope: Trellis.Envelope = { fuel: 4, depth: 3, fanout: 3 }

/**
 * The step that authors a plan. A real one calls a model with
 * `Trellis.Plan` as its output schema; this one is scripted so the example
 * runs offline and the assertions stay exact.
 */
export const AuthorPlan = Action.make("examples/AuthorPlan", {
  payload: { goal: Schema.String },
  success: Trellis.Plan
})

/** The step one leaf of the plan turns into. */
export const DelegateWork = Action.make("examples/DelegateWork", {
  payload: { goal: Schema.String, path: Schema.String },
  success: Schema.String
})

/**
 * Round two: the plan arrives as data, so the body reads it.
 *
 * `Trellis.validate` runs here rather than in the author round because this is
 * the round that would spend the fuel. A refused plan settles with the code and
 * the plan path that names the fault, and no leaf step is ever dispatched.
 */
export const RunPlan = Flow.make("examples/RunPlan", {
  payload: { goal: Schema.String, plan: Trellis.Plan },
  success: Schema.Array(Schema.String),
  body: ({ goal, plan }: { readonly goal: string; readonly plan: Trellis.Plan }) => {
    const refusals = Trellis.validate(plan, envelope)
    const refused = refusals[0]
    if (refused !== undefined) return Node.succeed([`refused:${refused.code}:${refused.path}`])

    const leaves = Trellis.leaves(plan)
    const calls: Record<string, Node.Node<string, never, Action.Requirement<"examples/DelegateWork">>> = {}
    leaves.forEach((leaf, index) => {
      calls[`leaf-${index}`] = DelegateWork.call({ goal: leaf.goal, path: leaf.path })
    })

    // The join is built from the plan's own leaf list, so the graph has exactly
    // one node per leaf and the outputs come back in plan order.
    return Node.all(calls).pipe(
      Node.map(Node.capture({ count: leaves.length }, (results: Readonly<Record<string, string>>) =>
        leaves.map((_, index) => results[`leaf-${index}`] as string)))
    )
  }
})

/**
 * Round one: author a plan, then hand off.
 *
 * The body never looks inside the plan. It cannot: at build time the author's
 * result is a placeholder the engine substitutes later. Handing it to the next
 * round is what turns it into a value a body can read.
 */
export const Delegate = Flow.make("examples/Delegate", {
  payload: { goal: Schema.String },
  success: Schema.Array(Schema.String),
  body: ({ goal }: { readonly goal: string }) =>
    AuthorPlan.call({ goal }).pipe(
      Node.andThen(Node.capture({ goal }, (plan) => RunPlan.to({ goal, plan })))
    )
})

/** What {@link main} reports back to the test. */
export interface Summary {
  readonly result: ReadonlyArray<string>
  readonly authored: number
  readonly dispatched: ReadonlyArray<string>
  readonly leafNodes: number
}

/** The plan the scripted author returns: one leaf, then two run together. */
export const plan: Trellis.Plan = {
  sequence: [
    { agent: { goal: "outline" } },
    { parallel: [{ agent: { goal: "draft" } }, { agent: { goal: "review" } }] }
  ]
}

/**
 * Counts the steps round two's graph actually contains for a plan.
 *
 * `RunPlan` calls exactly one action, so every `ActionCall` in its graph is a
 * leaf of the plan. The count is read off the built graph rather than off the
 * plan, which is what makes it evidence that the plan drove the topology and
 * not a shape written by hand.
 */
export const leafNodesFor = (authored: Trellis.Plan): number =>
  Graph.nodes(Graph.build(RunPlan, { goal: "ship the release notes", plan: authored }))
    .filter((node) => node.kind === "ActionCall").length

/** Runs the two rounds over one SQLite file and reports what each step did. */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    let authored = 0
    const dispatched: Array<string> = []

    const authorPlan = AuthorPlan.toLayer(() =>
      Effect.sync(() => {
        authored += 1
        return plan
      })
    )

    const delegateWork = DelegateWork.toLayer(({ goal, path }) =>
      Effect.sync(() => {
        dispatched.push(`${goal}@${path}`)
        return goal.toUpperCase()
      })
    )

    const result = yield* Effect.scoped(
      Delegate.execute({ goal: "ship the release notes" }, { executionId: "delegate-1" }).pipe(
        Effect.provide(
          Layer.mergeAll(
            authorPlan,
            delegateWork,
            Interpreter.layer(Delegate),
            Interpreter.layer(RunPlan)
          ).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(durableEngine(filename, "delegation-worker"))
          )
        )
      )
    )

    return { result, authored, dispatched, leafNodes: leafNodesFor(plan) }
  }).pipe(Effect.orDie)
