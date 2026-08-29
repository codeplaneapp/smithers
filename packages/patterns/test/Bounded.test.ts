import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Bounded from "../src/Bounded.ts"
import { PatternError } from "../src/PatternError.ts"

const worker = Flow.make({
  name: "worker",
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const members = (names: ReadonlyArray<string>): Record<string, Node.Any> =>
  Object.fromEntries(names.map((name) => [name, worker(name) as Node.Any]))

const graphOf = (node: Node.Node<unknown, unknown>): Graph.Graph =>
  Graph.build(Flow.make({ input: Schema.Unknown, output: Schema.Unknown, body: () => node }), undefined)

const memberNode = (graph: Graph.Graph, name: string): Graph.GraphNode | undefined =>
  Graph.nodes(graph).find((node) => node.id.endsWith(`.all.${name}`))

describe("Bounded", () => {
  it("splits members into sequential batches of the declared width", () => {
    const graph = graphOf(Bounded.all(members(["a", "b", "c", "d", "e"]), { concurrency: 2 }))
    const joins = Graph.nodes(graph).filter((node) => node.kind === "All")

    expect(joins).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(5)
  })

  it("runs a higher priority member in an earlier batch", () => {
    const graph = graphOf(
      Bounded.all(
        { ...members(["a", "b", "c"]), late: Node.priority(worker("late") as Node.Any, 9) },
        { concurrency: 2 }
      )
    )
    const batchOf = (name: string): string | undefined => memberNode(graph, name)?.id.split(".all.")[0]

    expect(batchOf("late")).toBe(batchOf("a"))
    expect(batchOf("b")).toBe(batchOf("c"))
    expect(batchOf("late")).not.toBe(batchOf("b"))
  })

  it("applies the container priority only to members that declare none", () => {
    const graph = graphOf(
      Bounded.all(
        { ...members(["a"]), urgent: Node.priority(worker("urgent") as Node.Any, 9) },
        { concurrency: 2, priority: 3 }
      )
    )

    expect(memberNode(graph, "a")?.priority).toBe(3)
    expect(memberNode(graph, "urgent")?.priority).toBe(9)
  })

  it("rejects an empty record and an invalid width", () => {
    expect(() => Bounded.all({}, { concurrency: 2 })).toThrow(PatternError)
    expect(() => Bounded.all(members(["a"]), { concurrency: 0 })).toThrow(PatternError)
  })

  it.effect("keeps run within the concurrency bound and starts the highest priority first", () =>
    Effect.gen(function*() {
      // Both admitted members park on a gate the test holds shut, so the third
      // cannot start until the test opens it. What `started` reports is the
      // bound, not a yield ordering.
      const gate = yield* Latch.make(false)
      const admitted = yield* Latch.make(false)
      const started: Array<string> = []
      let live = 0
      let peak = 0
      const member = (name: string) =>
        Effect.gen(function*() {
          started.push(name)
          live = live + 1
          peak = Math.max(peak, live)
          if (started.length === 2) yield* admitted.open
          yield* gate.await
          live = live - 1
          return name.toUpperCase()
        })

      const fiber = yield* Effect.forkChild(
        Bounded.run(
          { a: member("a"), b: member("b"), c: member("c"), d: member("d"), e: member("e") },
          { concurrency: 2, priorities: { e: 9 } }
        ),
        { startImmediately: true }
      )
      yield* admitted.await
      expect(started).toHaveLength(2)
      expect(started[0]).toBe("e")

      yield* gate.open
      const values = yield* Fiber.join(fiber)

      expect(peak).toBe(2)
      expect(values).toEqual({ a: "A", b: "B", c: "C", d: "D", e: "E" })
    }))

  // `run` refuses with a TYPED failure, not a defect: a caller that composes it
  // has `PatternError` in the error channel and must be able to recover with
  // `Effect.catchTag`. A thrown refusal would be a `Die` no handler can claim.
  it.effect("fails run with a typed PatternError for an empty record or an invalid width", () =>
    Effect.gen(function*() {
      const none: Readonly<Record<string, Effect.Effect<number>>> = {}
      const empty = yield* Effect.flip(Bounded.run(none, { concurrency: 1 }))
      const width = yield* Effect.flip(Bounded.run({ a: Effect.succeed(1) }, { concurrency: -1 }))

      expect(empty).toBeInstanceOf(PatternError)
      expect(empty.code).toBe("invalid_decorator")
      expect(width).toBeInstanceOf(PatternError)
      expect(width.code).toBe("invalid_decorator")
    }))

  it.effect("lets a caller recover the run refusal by tag", () =>
    Effect.gen(function*() {
      const none: Readonly<Record<string, Effect.Effect<number>>> = {}
      const recovered = yield* Effect.catchTag(
        Bounded.run(none, { concurrency: 1 }),
        "flows/patterns/PatternError",
        (error) => Effect.succeed(error.code)
      )

      expect(recovered).toBe("invalid_decorator")
    }))
})
