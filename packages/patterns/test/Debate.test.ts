import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Debate from "../src/Debate.ts"
import { PatternError } from "../src/PatternError.ts"

const participant = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

describe("Debate", () => {
  it("declares bounded participant and judge calls", () => {
    const debate = Debate.make({
      proponent: participant,
      opponent: participant,
      judge: participant,
      rounds: 2
    })

    expect(Flow.isFlow(debate)).toBe(true)
    expect(debate.body?.("topic").ast._tag).toBe("AndThen")
    const graph = Graph.build(debate, "topic")
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(5)
    expect(debate.implementation?._tag).toBe("Body")
    if (debate.implementation?._tag === "Body") {
      expect(debate.implementation.algorithm).toBe("sha256-source-captures/v3")
    }
  })

  it("rejects an unbounded round count", () => {
    expect(() => Debate.make({ proponent: participant, opponent: participant, judge: participant, rounds: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Debate rounds must be a positive safe integer, received 0"
      })
    )
  })

  it.effect("runs participants with a real accumulated transcript", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      const result = yield* Debate.run("topic", {
        rounds: 2,
        proponent: ({ input, round, transcript }) => {
          seen.push(["proponent", input, round, transcript.length])
          return Effect.succeed(`p${round}`)
        },
        opponent: ({ input, proponent, round, transcript }) => {
          seen.push(["opponent", input, proponent, round, transcript.length])
          return Effect.succeed(`o${round}`)
        },
        judge: ({ input, transcript }) => Effect.succeed({ input, transcript })
      })

      expect(seen).toEqual([
        ["proponent", "topic", 1, 0],
        ["opponent", "topic", "p1", 1, 0],
        ["proponent", "topic", 2, 1],
        ["opponent", "topic", "p2", 2, 1]
      ])
      expect(result).toEqual({
        input: "topic",
        transcript: [
          { proponent: "p1", opponent: "o1" },
          { proponent: "p2", opponent: "o2" }
        ]
      })
    }))

  it.effect("hands every callback a frozen transcript copy", () =>
    Effect.gen(function*() {
      const retained: Array<ReadonlyArray<Debate.RuntimeTurn<unknown, unknown>>> = []
      const tryForge = (transcript: ReadonlyArray<Debate.RuntimeTurn<unknown, unknown>>) => {
        retained.push(transcript)
        try {
          ;(transcript as Array<Debate.RuntimeTurn<unknown, unknown>>).push({
            proponent: "forged",
            opponent: "forged"
          })
        } catch {
          // A frozen transcript refuses the forged turn.
        }
      }
      const result = yield* Debate.run("topic", {
        rounds: 2,
        proponent: ({ round, transcript }) => {
          tryForge(transcript)
          return Effect.succeed(`p${round}`)
        },
        opponent: ({ round, transcript }) => {
          tryForge(transcript)
          return Effect.succeed(`o${round}`)
        },
        judge: ({ transcript }) => {
          tryForge(transcript)
          return Effect.succeed(transcript)
        }
      })

      expect(retained.every(Object.isFrozen)).toBe(true)
      expect(retained.map((transcript) => transcript.length)).toEqual([0, 0, 1, 1, 2])
      expect(result).toEqual([
        { proponent: "p1", opponent: "o1" },
        { proponent: "p2", opponent: "o2" }
      ])
    }))

  it.effect("rejects an invalid runtime round count", () =>
    Effect.gen(function*() {
      const failure = yield* Debate.run("topic", {
        rounds: 0,
        proponent: () => Effect.succeed("unused"),
        opponent: () => Effect.succeed("unused"),
        judge: () => Effect.succeed("unused")
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Debate rounds must be a positive safe integer, received 0")
    }))
})
