import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Escalation from "../src/Escalation.ts"
import { PatternError } from "../src/PatternError.ts"

const rung = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

describe("Escalation", () => {
  it("declares every bounded escalation rung", () => {
    const escalation = Escalation.make({ rungs: [rung, rung], accept: rung })

    expect(Flow.isFlow(escalation)).toBe(true)
    expect(escalation.body?.("request").ast._tag).toBe("AndThen")
    const graph = Graph.build(escalation, "request")
    const calls = Graph.nodes(graph).filter((node) => node.kind === "FlowCall")
    expect(calls).toHaveLength(4)
    expect(calls[1]?.keyMaterial.inputs).toContainEqual({
      _tag: "Ref",
      from: "root.andThen",
      path: []
    })
  })

  it("rejects an empty ladder", () => {
    expect(() => Escalation.make({ rungs: [], accept: rung })).toThrow(PatternError)
  })

  it.effect("stops operational escalation after acceptance", () =>
    Effect.gen(function*() {
      const attempted: Array<string> = []
      const result = yield* Escalation.run("request", {
        rungs: [
          () =>
            Effect.sync(() => {
              attempted.push("first")
              return "draft"
            }),
          () =>
            Effect.sync(() => {
              attempted.push("second")
              return "accepted"
            }),
          () =>
            Effect.sync(() => {
              attempted.push("third")
              return "unreachable"
            })
        ],
        accept: (value) => Effect.succeed(value === "accepted")
      })

      expect(result).toBe("accepted")
      expect(attempted).toEqual(["first", "second"])
    }))
})
