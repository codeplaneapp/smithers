import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Trellis from "../src/Trellis.ts"

const author = Flow.make({
  name: "author",
  capabilities: ["delegate/author"],
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const leaf = Flow.make({
  name: "leaf",
  capabilities: ["delegate/leaf"],
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const envelope: Trellis.Envelope = { fuel: 3, depth: 3, fanout: 2 }

const nested: Trellis.Plan = {
  parallel: [
    { agent: { goal: "a" } },
    { sequence: [{ agent: { goal: "b" } }, { agent: { goal: "c" } }] }
  ]
}

const reported = (
  errors: ReadonlyArray<Trellis.TrellisError>
): ReadonlyArray<readonly [string, string]> => errors.map((error) => [error.code, error.path] as const)

const payload = (node: Graph.GraphNode): unknown =>
  (node.keyMaterial.inputs as ReadonlyArray<{ readonly _tag: string; readonly value?: unknown }>)
    .find((input) => input._tag === "Literal")?.value

const leafCalls = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) =>
    node.kind === "FlowCall" &&
    ((node.keyMaterial.body as { readonly capabilities?: ReadonlyArray<string> }).capabilities ?? []).includes(
      "delegate/leaf"
    )
  )

describe("Trellis", () => {
  it("reports depth, fan-out, and fuel overruns at the offending path", () => {
    expect(Trellis.validate(nested, envelope)).toEqual([])
    expect(reported(Trellis.validate(nested, { fuel: 3, depth: 2, fanout: 2 }))).toEqual([
      ["depth_exceeded", "root.parallel[1].sequence[0]"],
      ["depth_exceeded", "root.parallel[1].sequence[1]"]
    ])
    expect(reported(Trellis.validate(nested, { fuel: 3, depth: 3, fanout: 1 }))).toEqual([
      ["fanout_exceeded", "root"],
      ["fanout_exceeded", "root.parallel[1]"]
    ])
    expect(reported(Trellis.validate(nested, { fuel: 2, depth: 3, fanout: 2 }))).toEqual([
      ["fuel_exhausted", "root"]
    ])
  })

  it("refuses a value that is not a plan and an envelope that is not bounded", () => {
    expect(reported(Trellis.validate({ agent: { goal: "" } }, envelope))).toEqual([
      ["invalid_plan", "root.agent.goal"]
    ])
    expect(reported(Trellis.validate({ sequence: [{ swarm: [] }] }, envelope))).toEqual([
      ["invalid_plan", "root.sequence[0]"]
    ])
    expect(reported(Trellis.validate(nested, { fuel: 0, depth: 3, fanout: 2 }))).toEqual([
      ["invalid_envelope", "root"]
    ])
  })

  it("refuses a container that holds no members", () => {
    expect(reported(Trellis.validate({ sequence: [] }, envelope))).toEqual([
      ["invalid_plan", "root"]
    ])
    expect(reported(Trellis.validate({ sequence: [{ parallel: [] }] }, envelope))).toEqual([
      ["invalid_plan", "root.sequence[0]"]
    ])
    // The closed grammar shows the constraint to the model that answers in it.
    expect(Schema.decodeUnknownResult(Trellis.Plan)({ sequence: [] })._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(Trellis.Plan)({ parallel: [] })._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(Trellis.Plan)(nested)._tag).toBe("Success")
  })

  it.effect("stops when continue asks for a round that costs no fuel", () =>
    Effect.gen(function*() {
      let continued = 0
      const trace: Array<string> = []
      const result = yield* Trellis.run("ship it", {
        envelope,
        author: () => Effect.succeed({ agent: { goal: "only" } }),
        continue: () => Effect.sync(() => (continued += 1, { sequence: [] })),
        leaf: ({ goal }) =>
          Effect.sync(() => {
            trace.push(goal)
            return goal
          })
      })

      expect(trace).toEqual(["only"])
      expect(continued).toBe(1)
      expect(result.rounds).toHaveLength(1)
      expect(result.remaining).toBe(envelope.fuel - 1)
    }))

  it.effect("runs the authored plan with real concurrency and charges one fuel unit per leaf", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const gate = yield* Latch.make()
      const result = yield* Trellis.run("ship it", {
        envelope,
        author: () => Effect.succeed(nested),
        leaf: ({ goal }) =>
          Effect.gen(function*() {
            trace.push(`${goal} start`)
            if (goal === "a") yield* gate.await
            if (goal === "b") yield* gate.open
            trace.push(`${goal} end`)
            return goal.toUpperCase()
          })
      })

      expect(result.rounds).toHaveLength(1)
      expect(result.rounds[0]?.result).toEqual(["A", ["B", "C"]])
      expect(result.remaining).toBe(0)
      // "a" is still in flight when "b" starts: the two parallel members overlap.
      expect(trace.indexOf("b start")).toBeLessThan(trace.indexOf("a end"))
      // The sequence stays ordered inside that parallel member.
      expect(trace.indexOf("b end")).toBeLessThan(trace.indexOf("c start"))
    }))

  it.effect("never exceeds the declared concurrency bound", () =>
    Effect.gen(function*() {
      const plan: Trellis.Plan = {
        parallel: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }]
      }
      const peak = (concurrency: number) =>
        Effect.gen(function*() {
          let inFlight = 0
          let observed = 0
          yield* Trellis.run("ship it", {
            envelope: { fuel: 2, depth: 2, fanout: 2 },
            concurrency,
            author: () => Effect.succeed(plan),
            leaf: () =>
              Effect.gen(function*() {
                inFlight += 1
                observed = Math.max(observed, inFlight)
                yield* Effect.yieldNow
                inFlight -= 1
                return "done"
              })
          })
          return observed
        })

      expect(yield* peak(1)).toBe(1)
      expect(yield* peak(2)).toBe(2)
    }))

  it.effect("fails fuel_exhausted before running the third leaf", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const failure = yield* Trellis.run("ship it", {
        envelope: { fuel: 2, depth: 2, fanout: 2 },
        author: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }] }),
        continue: () => Effect.succeed({ agent: { goal: "c" } }),
        leaf: ({ goal }) =>
          Effect.sync(() => {
            trace.push(goal)
            return goal
          })
      }).pipe(Effect.flip)

      expect(failure.code).toBe("fuel_exhausted")
      expect(trace).toEqual(["a", "b"])
    }))

  it.effect("re-authors a second round and stops when continue returns nothing", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const plans: ReadonlyArray<Trellis.Plan> = [
        { agent: { goal: "first" } },
        { agent: { goal: "second" } }
      ]
      const result = yield* Trellis.run("ship it", {
        envelope: { fuel: 3, depth: 1, fanout: 1 },
        author: () => Effect.succeed(plans[0]),
        continue: ({ round }) => Effect.succeed(round === 1 ? plans[1] : undefined),
        leaf: ({ goal }) =>
          Effect.sync(() => {
            trace.push(goal)
            return goal
          })
      })

      expect(trace).toEqual(["first", "second"])
      expect(result.rounds.map((round) => round.plan)).toEqual(plans)
      expect(result.remaining).toBe(1)
    }))

  it.effect("refuses a plan the model authored outside the envelope", () =>
    Effect.gen(function*() {
      const failure = yield* Trellis.run("ship it", {
        envelope: { fuel: 2, depth: 1, fanout: 2 },
        author: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        leaf: ({ goal }) => Effect.succeed(goal)
      }).pipe(Effect.flip)

      expect(failure.code).toBe("depth_exceeded")
      expect(failure.path).toBe("root.sequence[0]")
    }))

  it("declares one leaf call per fuel unit, each shaped like the leaf run hands over", () => {
    const trellis = Trellis.make({ author, leaf, envelope })

    expect(Flow.isFlow(trellis)).toBe(true)
    const graph = Graph.build(trellis, "ship it")
    expect(leafCalls(graph)).toHaveLength(envelope.fuel)
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(envelope.fuel + 1)
    // The declared payload is a Leaf, which is what `run` and `execute` hand a
    // leaf flow. A declaration cannot know the goals, so the plan stands in for
    // them and the path names the slot.
    expect(leafCalls(graph).map((node) => Object.keys(payload(node) as object).sort())).toEqual(
      Array.from({ length: envelope.fuel }, () => ["goal", "path"])
    )
    expect(leafCalls(graph).map((node) => (payload(node) as { readonly path: string }).path)).toEqual([
      "slot-0",
      "slot-1",
      "slot-2"
    ])
    expect(() => Trellis.make({ author, leaf, envelope: { fuel: 0, depth: 1, fanout: 1 } })).toThrow(
      Trellis.TrellisError
    )
  })

  it("compiles a plan into the calls the plan names", () => {
    const compiled = Flow.make({
      input: Schema.Unknown,
      output: Schema.Unknown,
      body: () => Trellis.compile(nested, { leaf })
    })
    const graph = Graph.build(compiled, "ship it")

    expect(leafCalls(graph)).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
    expect(Trellis.leaves(nested)).toEqual([
      { goal: "a", path: "root.parallel[0]" },
      { goal: "b", path: "root.parallel[1].sequence[0]" },
      { goal: "c", path: "root.parallel[1].sequence[1]" }
    ])
  })
})
