import { describe, expectTypeOf, it } from "@effect/vitest"
import { Effects, Flow, Graph, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as WithCache from "../src/WithCache.ts"

describe("WithCache", () => {
  it("rejects an unsealed inner flow", () => {
    const inner = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })

    try {
      WithCache.withCache(inner)
      throw new Error("expected withCache to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(PatternError)
      expect(error).toMatchObject({ code: "invalid_decorator" })
    }
  })

  it("marks the wrapper sealed without emitting an unconsumed marker", () => {
    const inner = Flow.make({
      name: "read",
      input: Schema.String,
      output: Schema.String,
      effects: Effects.make({
        reads: ["workspace/**"],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize"
      }),
      body: () => Node.dynamic({ output: Schema.String })
    })
    const cached = WithCache.withCache(inner)
    const graph = Graph.build(cached, "file")
    expect((cached as typeof inner).name).toBe("withCache(read)")
    expect((cached as typeof inner).effects).toMatchObject({ mode: "hermetic", tier: "sealed" })
    expect(Graph.nodes(graph).some((node) => JSON.stringify(node.keyMaterial).includes("StepKeyCache"))).toBe(false)
    expect(Graph.nodes(graph).filter((node) => node.kind === "Dynamic")).toHaveLength(1)
  })

  it("does not expose an unsupported TTL option", () => {
    expectTypeOf(WithCache.withCache).parameters.toEqualTypeOf<[inner: Flow.Any]>()
  })
})
