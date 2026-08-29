import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as ReviewLoop from "../src/ReviewLoop.ts"

const step = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

describe("ReviewLoop", () => {
  it("declares a bounded produce-review-revise loop", () => {
    const loop = ReviewLoop.make({ produce: step, review: step, revise: step, maxRounds: 2 })

    expect(Flow.isFlow(loop)).toBe(true)
    expect(loop.body?.("draft").ast._tag).toBe("AndThen")
    const graph = Graph.build(loop, "draft")
    const calls = Graph.nodes(graph).filter((node) => node.kind === "FlowCall")
    expect(calls).toHaveLength(4)
    expect(calls[2]?.keyMaterial.inputs).toEqual(expect.arrayContaining([
      { _tag: "Ref", from: "root.andThen", path: [] },
      { _tag: "Ref", from: "root.then.andThen", path: [] }
    ]))
  })

  it("rejects a zero-round loop", () => {
    expect(() => ReviewLoop.make({ produce: step, review: step, revise: step, maxRounds: 0 })).toThrow(PatternError)
  })

  it.effect("short-circuits operational review after approval", () =>
    Effect.gen(function*() {
      const reviewed: Array<number> = []
      const result = yield* ReviewLoop.run("draft", {
        maxRounds: 4,
        produce: (input) => Effect.succeed(input),
        review: (_output, round) =>
          Effect.sync(() => {
            reviewed.push(round)
            return { approved: round === 2 }
          }),
        revise: ({ output }) => Effect.succeed(`${output}-revised`)
      })

      expect(result).toBe("draft-revised")
      expect(reviewed).toEqual([1, 2])
    }))
})
