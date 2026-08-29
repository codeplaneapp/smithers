import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as Recursion from "../src/Recursion.ts"

const child = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

describe("Recursion", () => {
  it("declares a child under an attenuated envelope", () => {
    const recursive = Recursion.recurse({ child, fuel: 4, depth: 3, fanout: 2 })

    expect(Flow.isFlow(recursive)).toBe(true)
    expect(recursive.body?.("root").ast._tag).toBe("FlowCall")
    const graph = Graph.build(recursive, {
      input: "root",
      children: [
        { input: "left", children: [{ input: "leaf" }] },
        { input: "right" }
      ]
    })
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(4)
  })

  it("rejects exhausted and widened bounds", () => {
    expect(() => Recursion.recurse({ child, fuel: 0, depth: 1, fanout: 1 })).toThrow(PatternError)
    expect(() =>
      Recursion.recurse({
        child,
        fuel: 3,
        depth: 2,
        fanout: 2,
        parent: { fuel: 2, depth: 2, fanout: 2 }
      })
    ).toThrow(PatternError)
    expect(() =>
      Graph.build(
        Recursion.recurse({ child, fuel: 3, depth: 3, fanout: 1 }),
        { input: "root", children: [{ input: "a" }, { input: "b" }] }
      )
    ).toThrow(PatternError)
    expect(() =>
      Graph.build(
        Recursion.recurse({ child, fuel: 2, depth: 3, fanout: 2 }),
        {
          input: "root",
          children: [{ input: "a", children: [{ input: "b" }] }]
        }
      )
    ).toThrow(PatternError)
  })

  it("refuses a symbolic tree instead of silently planning one leaf", () => {
    const recursive = Recursion.recurse({ child, fuel: 4, depth: 3, fanout: 2 })
    const composed = Flow.make({
      input: Schema.Unknown,
      output: Schema.Unknown,
      body: (input) => Node.andThen(Node.succeed(input), (value) => recursive(value))
    })

    expect(() => Graph.build(composed, { input: "root" })).toThrow(
      "Recursion input must be a literal tree available while planning"
    )
  })
})
