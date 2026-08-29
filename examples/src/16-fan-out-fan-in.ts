/**
 * Fan out over a fixed set of checks, two at a time, urgent ones first, then
 * join every verdict into one report.
 *
 * Three separate ideas meet in this one body, and keeping them apart is the
 * point of the example.
 *
 * **Width is topology, not a runtime flag.** `Node.all` settles its members
 * concurrently with no bound, which is right for three calls and wrong for
 * fifty. The bound here is one `Node.all` per batch, and each batch takes the
 * previous batch's verdicts as payload. That reference is what sequences them:
 * the interpreter settles a node's dependencies before the node, so naming the
 * earlier batch is what stops the later one from starting beside it. An
 * operator reading the plan sees exactly how many checks can be in flight.
 *
 * **Priority is an annotation.** `Node.priority` orders ready work and changes
 * nothing else — it never enters key material, so raising it cannot invalidate
 * a recorded result. Here it decides which members share the first batch, which
 * is what makes the release blocker start first instead of last.
 *
 * **The fan-in is a step.** Each batch settles to a planned record, and each
 * member's verdict is read off it by field access and passed into the
 * collecting step's payload. A planned value may be passed; it may never be
 * computed on. So the report is built by an action that receives five strings,
 * not by a function in the body that tries to concatenate placeholders.
 */
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

/**
 * One check, and the verdict it reports.
 *
 * `after` carries the verdicts the previous batch reported. It is declared
 * rather than ambient because it is the dependency edge: a check that names no
 * predecessor is free to start immediately, and one that names a batch waits
 * for it. The first batch passes `null`.
 */
export const Check = Action.make("examples/Check", {
  payload: {
    name: Schema.String,
    target: Schema.String,
    after: Schema.Json
  },
  success: Schema.String
})

/** The fan-in step: five verdicts arrive as payload fields, one report leaves. */
export const Collect = Action.make("examples/Collect", {
  payload: {
    lint: Schema.String,
    types: Schema.String,
    unit: Schema.String,
    audit: Schema.String,
    licence: Schema.String
  },
  success: Schema.String
})

/** One declared check: what it is called and how urgent it is. */
export interface CheckSpec {
  readonly name: string
  readonly priority: number
}

/**
 * The gate's checks, in declaration order.
 *
 * `audit` blocks a release and `licence` is nearly as urgent, so both carry a
 * priority. The other three state none and keep declaration order behind them.
 */
export const specs: ReadonlyArray<CheckSpec> = [
  { name: "lint", priority: 0 },
  { name: "types", priority: 0 },
  { name: "unit", priority: 0 },
  { name: "audit", priority: 9 },
  { name: "licence", priority: 5 }
]

/**
 * Splits checks into batches of at most `concurrency`, highest priority first
 * and declaration order among equals.
 *
 * The sort is total, so a plan built twice from the same list is identical —
 * which matters, because the batch a check lands in is part of the topology the
 * step keys are derived from.
 */
export const batches = (
  checks: ReadonlyArray<CheckSpec>,
  concurrency: number
): ReadonlyArray<ReadonlyArray<string>> => {
  const order = checks
    .map((spec, index) => ({ spec, index }))
    .sort((left, right) => right.spec.priority - left.spec.priority || left.index - right.index)
    .map((entry) => entry.spec.name)
  const grouped: Array<ReadonlyArray<string>> = []
  for (let offset = 0; offset < order.length; offset += concurrency) {
    grouped.push(order.slice(offset, offset + concurrency))
  }
  return grouped
}

/** The batches the gate declares, before anything runs. */
export const declaredBatches: ReadonlyArray<ReadonlyArray<string>> = batches(specs, 2)

const priorityOf = (name: string): number => specs.find((spec) => spec.name === name)?.priority ?? 0

/** The release gate: five checks, two at a time, one report. */
export const Gate = Flow.make("examples/Gate", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: ({ target }: { readonly target: string }) => {
    const stage = (
      index: number,
      after: Schema.Json,
      collected: Readonly<Record<string, Planned.Planned<string>>>
    ): Node.Node<string, never, Action.Requirement<"examples/Check" | "examples/Collect">> => {
      const batch = declaredBatches[index]
      if (batch === undefined) {
        return Collect.call({
          lint: collected.lint!,
          types: collected.types!,
          unit: collected.unit!,
          audit: collected.audit!,
          licence: collected.licence!
        })
      }
      const members: Record<string, Node.Node<string, never, Action.Requirement<"examples/Check">>> = {}
      for (const name of batch) {
        members[name] = Node.priority(Check.call({ name, target, after }), priorityOf(name))
      }
      return Node.andThen(
        Node.all(members),
        (verdicts: Planned.Planned<Readonly<Record<string, string>>>) => {
          const next: Record<string, Planned.Planned<string>> = { ...collected }
          const fields = verdicts as unknown as Readonly<Record<string, Planned.Planned<string>>>
          for (const name of batch) next[name] = fields[name]!
          return stage(index + 1, verdicts as unknown as Schema.Json, next)
        }
      )
    }
    return stage(0, null, {})
  }
})

/** The priority each check carries in the built plan, by check name. */
export const declaredPriorities = (target = "release"): Readonly<Record<string, number | undefined>> => {
  const found: Record<string, number | undefined> = {}
  for (const node of Graph.nodes(Graph.build(Gate, { target }))) {
    if (node.kind !== "ActionCall") continue
    const payload = node.payload as { readonly name?: unknown } | undefined
    if (typeof payload?.name === "string") found[payload.name] = node.draft.priority
  }
  return found
}

/** What one run of the gate observed. */
export interface Summary {
  /** The report the fan-in step produced. */
  readonly report: string
  /** The order the checks started in. */
  readonly started: ReadonlyArray<string>
  /** The most checks that were ever running at the same moment. */
  readonly maxInFlight: number
  /** How many times each check's body ran. */
  readonly dispatches: Readonly<Record<string, number>>
  /** The distinct lifecycle events the run journalled. */
  readonly eventTypes: ReadonlyArray<string>
}

/** Runs the gate over one SQLite file and reports what the fan-out did. */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const started: Array<string> = []
    const dispatches: Record<string, number> = {}
    let inFlight = 0
    let maxInFlight = 0

    const check = Check.toLayer(({ name }) =>
      Effect.gen(function*() {
        started.push(name)
        dispatches[name] = (dispatches[name] ?? 0) + 1
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        // Long enough that two members of one batch genuinely overlap, short
        // enough that the suite stays quick. Without a suspension point the
        // members would settle one after another and the bound would be
        // unexercised rather than merely untested.
        yield* Effect.sleep("25 millis")
        inFlight -= 1
        return `${name}:clean`
      })
    )

    const collect = Collect.toLayer((verdicts) =>
      Effect.succeed(
        [verdicts.lint, verdicts.types, verdicts.unit, verdicts.audit, verdicts.licence].join(" ")
      )
    )

    const observed = yield* Effect.scoped(
      Effect.gen(function*() {
        const report = yield* Gate.execute({ target: "release" }, { executionId: "gate-1" })
        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: "gate-1" as JournalEvent.RunId, limit: 500 })
        return { report, eventTypes: [...new Set(page.entries.map((entry) => entry.eventType))] }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(check, collect, Interpreter.layer(Gate)).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(durableEngine(filename, "examples-gate"))
          )
        )
      )
    )

    return {
      report: observed.report,
      started,
      maxInFlight,
      dispatches,
      eventTypes: observed.eventTypes
    } satisfies Summary
  }).pipe(Effect.orDie)
