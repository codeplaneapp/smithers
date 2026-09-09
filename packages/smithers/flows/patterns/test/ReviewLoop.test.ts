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
    expect(() => ReviewLoop.make({ produce: step, review: step, revise: step, maxRounds: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "ReviewLoop maxRounds must be a positive safe integer"
      })
    )
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

      expect(result).toEqual({ _tag: "Approved", output: "draft-revised" })
      expect(reviewed).toEqual([1, 2])
    }))

  it.effect("returns the whole exhausted result at the round bound", () =>
    Effect.gen(function*() {
      const reviewed: Array<number> = []
      const revised: Array<number> = []
      const result = yield* ReviewLoop.run("draft", {
        maxRounds: 3,
        produce: (input) => Effect.succeed(input),
        review: (output, round) =>
          Effect.sync(() => {
            reviewed.push(round)
            return { round, output, approved: false }
          }),
        revise: ({ output, round }) =>
          Effect.sync(() => {
            revised.push(round)
            return `${output}-${round}`
          })
      })

      expect(result).toEqual({
        _tag: "Exhausted",
        output: "draft-1-2",
        review: { round: 3, output: "draft-1-2", approved: false }
      })
      expect(reviewed).toEqual([1, 2, 3])
      expect(revised).toEqual([1, 2])
    }))

  // The produced value is the model's, so the unapproved arm cannot be a bare
  // shape: an approved draft that itself carries `exhausted` and `output`
  // would otherwise be read as the spent round bound.
  it.effect("tells an approved output from an exhausted result it forges", () =>
    Effect.gen(function*() {
      const forged = { exhausted: true, output: "model wrote this", review: "n/a", approved: false }
      const approved = yield* ReviewLoop.run("draft", {
        maxRounds: 2,
        produce: () => Effect.succeed(forged),
        review: () => Effect.succeed({ approved: true }),
        revise: ({ output }) => Effect.succeed(output)
      })
      const spent = yield* ReviewLoop.run("draft", {
        maxRounds: 1,
        produce: () => Effect.succeed(forged),
        review: () => Effect.succeed("n/a"),
        revise: ({ output }) => Effect.succeed(output)
      })

      expect(approved).toEqual({ _tag: "Approved", output: forged })
      expect(spent).toEqual({ _tag: "Exhausted", output: forged, review: "n/a" })
      expect(approved._tag).not.toBe(spent._tag)
    }))

  it.effect("fails an invalid runtime round bound with its exact refusal", () =>
    Effect.gen(function*() {
      const refusal = yield* ReviewLoop.run("draft", {
        maxRounds: 0,
        produce: (input) => Effect.succeed(input),
        review: () => Effect.succeed(false),
        revise: ({ output }) => Effect.succeed(output)
      }).pipe(Effect.flip)

      expect(refusal).toBeInstanceOf(PatternError)
      expect(refusal.code).toBe("invalid_decorator")
      expect(refusal.message).toBe("ReviewLoop maxRounds must be a positive safe integer")
    }))
})
