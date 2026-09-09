import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Loop from "../src/Loop.ts"
import { PatternError } from "../src/PatternError.ts"

const body = Flow.make({
  name: "body",
  capabilities: ["loop/body"],
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const until = Flow.make({
  name: "until",
  capabilities: ["loop/until"],
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const callsTo = (graph: Graph.Graph, capability: string): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) =>
    node.kind === "FlowCall" &&
    (node.keyMaterial.body as { readonly capabilities?: ReadonlyArray<string> }).capabilities?.includes(capability) ===
      true
  )

const literalInput = (node: Graph.GraphNode): Record<string, unknown> => {
  const literal = node.keyMaterial.inputs.find((input) => input._tag === "Literal")
  return (literal as { readonly value: Record<string, unknown> }).value
}

describe("Loop", () => {
  it("declares exactly maxIterations bounded body and predicate calls", () => {
    const loop = Loop.make({ body, until, maxIterations: 3, onMaxReached: "return-last" })

    expect(Flow.isFlow(loop)).toBe(true)
    const graph = Graph.build(loop, "seed")
    expect(callsTo(graph, "loop/body")).toHaveLength(3)
    expect(callsTo(graph, "loop/until")).toHaveLength(3)
    expect(callsTo(graph, "loop/body").map((node) => literalInput(node).iteration)).toEqual([1, 2, 3])
  })

  it("rejects a loop bound below one iteration", () => {
    for (const maxIterations of [0, 1.5]) {
      expect(() => Loop.make({ body, until, maxIterations, onMaxReached: "fail" })).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: "Loop maxIterations must be a positive safe integer"
        })
      )
    }
  })

  it.effect("stops at the first satisfied predicate", () =>
    Effect.gen(function*() {
      const observed: Array<number> = []
      const previously: Array<unknown> = []
      const result = yield* Loop.run("seed", {
        maxIterations: 5,
        onMaxReached: "fail",
        body: ({ input, iteration, previous }) =>
          Effect.sync(() => {
            observed.push(iteration)
            previously.push(previous)
            return `${input}-${iteration}`
          }),
        until: ({ iteration }) => Effect.succeed(iteration === 2)
      })

      expect(result).toEqual({ value: "seed-2", iterations: 2, exhausted: false })
      expect(observed).toEqual([1, 2])
      expect(previously).toEqual([undefined, "seed-1"])
    }))

  it.effect("runs the body once even when the predicate is satisfied from the start", () =>
    Effect.gen(function*() {
      let ran = 0
      const result = yield* Loop.run("seed", {
        maxIterations: 5,
        onMaxReached: "fail",
        body: () => Effect.sync(() => ++ran),
        until: () => Effect.succeed(true)
      })

      expect(result).toEqual({ value: 1, iterations: 1, exhausted: false })
      expect(ran).toBe(1)
    }))

  it("builds the deepest bound it accepts and refuses the next one", () => {
    expect(Graph.nodes(Graph.build(Loop.ralph({ body, maxIterations: 511 }), "seed")).length).toBeGreaterThan(0)
    expect(() => Loop.ralph({ body, maxIterations: 512 })).toThrow(
      new PatternError({
        code: "invalid_decorator",
        message: "Loop maxIterations must be at most 511 to stay inside the plan depth limit, received 512"
      })
    )
    expect(Graph.nodes(Graph.build(Loop.make({ body, until, maxIterations: 255 }), "seed")).length).toBeGreaterThan(0)
    expect(() => Loop.make({ body, until, maxIterations: 256 })).toThrow(
      new PatternError({
        code: "invalid_decorator",
        message: "Loop maxIterations must be at most 255 to stay inside the plan depth limit, received 256"
      })
    )
  })

  it.effect("takes a bound past the declaration ceiling at runtime", () =>
    Effect.gen(function*() {
      const result = yield* Loop.runRalph("goal", {
        maxIterations: 100_000,
        body: ({ iteration }) => Effect.succeed({ done: iteration === 3, iteration })
      })
      expect(result.iterations).toBe(3)
      expect(result.exhausted).toBe(false)
    }))

  it.effect("returns the last value when the bound is reached under return-last", () =>
    Effect.gen(function*() {
      const result = yield* Loop.run(0, {
        maxIterations: 3,
        onMaxReached: "return-last",
        body: ({ iteration }) => Effect.succeed(iteration * 10),
        until: () => Effect.succeed(false)
      })

      expect(result).toEqual({ value: 30, iterations: 3, exhausted: true })
    }))

  it.effect("fails exhausted when the bound is reached under fail", () =>
    Effect.gen(function*() {
      const failure = yield* Loop.run(0, {
        maxIterations: 2,
        onMaxReached: "fail",
        body: ({ iteration }) => Effect.succeed(iteration),
        until: () => Effect.succeed(false)
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("exhausted")
      expect(failure.message).toBe("Loop reached its bound of 2 iterations unsatisfied")
    }))

  it.effect("validates the bound before running any body", () =>
    Effect.gen(function*() {
      let ran = 0
      const failure = yield* Loop.run(0, {
        maxIterations: 0,
        onMaxReached: "fail",
        body: () => Effect.sync(() => ++ran),
        until: () => Effect.succeed(true)
      }).pipe(Effect.flip)

      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Loop maxIterations must be a positive safe integer")
      expect(ran).toBe(0)
    }))

  it.effect("hands the body output to the predicate and the next iteration", () =>
    Effect.gen(function*() {
      const judged: Array<string> = []
      const carried: Array<string | undefined> = []
      const result = yield* Loop.run("seed", {
        maxIterations: 4,
        onMaxReached: "fail",
        body: ({ iteration, previous }) =>
          Effect.sync(() => {
            carried.push(previous)
            return `draft-${iteration}`
          }),
        // The annotation is required because `body` reads `previous`, which
        // leaves TypeScript nothing to infer the loop's value type from. The
        // reference page documents this under "Inline callbacks and
        // inference".
        until: ({ value }: { readonly value: string }) =>
          Effect.sync(() => {
            judged.push(value)
            return value === "draft-3"
          })
      })

      expect(judged).toEqual(["draft-1", "draft-2", "draft-3"])
      expect(carried).toEqual([undefined, "draft-1", "draft-2"])
      expect(result).toEqual({ value: "draft-3", iterations: 3, exhausted: false })
    }))

  it("declares ralph as a body-only bounded loop", () => {
    const loop = Loop.ralph({ body, maxIterations: 3, onMaxReached: "return-last" })
    const graph = Graph.build(loop, "seed")

    expect(callsTo(graph, "loop/body")).toHaveLength(3)
    expect(callsTo(graph, "loop/until")).toHaveLength(0)
  })

  it.effect("stops ralph when the body reports done", () =>
    Effect.gen(function*() {
      const observed: Array<number> = []
      const result = yield* Loop.runRalph("goal", {
        maxIterations: 3,
        onMaxReached: "return-last",
        body: ({ iteration }) =>
          Effect.sync(() => {
            observed.push(iteration)
            return { done: iteration === 2, iteration }
          })
      })

      expect(result).toEqual({ value: { done: true, iteration: 2 }, iterations: 2, exhausted: false })
      expect(observed).toEqual([1, 2])
    }))

  it("declares ralph with no policy as a body-only bounded loop", () => {
    const graph = Graph.build(Loop.ralph({ body, maxIterations: 3 }), "goal")

    expect(callsTo(graph, "loop/body")).toHaveLength(3)
    expect(callsTo(graph, "loop/until")).toHaveLength(0)
  })

  it.effect("returns the last value when ralph reaches its bound with no policy", () =>
    Effect.gen(function*() {
      const result = yield* Loop.runRalph("goal", {
        maxIterations: 3,
        body: ({ iteration }) => Effect.succeed({ done: false, iteration })
      })

      expect(result).toEqual({ value: { done: false, iteration: 3 }, iterations: 3, exhausted: true })
    }))

  it("reads every supported completion signal", () => {
    expect(Loop.done(true)).toBe(true)
    expect(Loop.done("done")).toBe(true)
    expect(Loop.done({ done: true })).toBe(true)
    expect(Loop.done(false)).toBe(false)
    expect(Loop.done({ done: false })).toBe(false)
    expect(Loop.done(undefined)).toBe(false)
    expect(Loop.done("yes")).toBe(false)
    expect(Loop.done("DONE")).toBe(false)
    expect(Loop.done(1)).toBe(false)
    expect(Loop.done({ done: "true" })).toBe(false)
  })
})
