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
    expect(() => Recursion.recurse({ child, fuel: 0, depth: 1, fanout: 1 })).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Recursion bounds must be positive safe integers"
      })
    )
    expect(() =>
      Recursion.recurse({
        child,
        fuel: 3,
        depth: 2,
        fanout: 2,
        parent: { fuel: 2, depth: 2, fanout: 2 }
      })
    ).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Nested recursion may attenuate but cannot widen its parent envelope"
      })
    )
    expect(() =>
      Recursion.recurse({
        child,
        fuel: 2,
        depth: 3,
        fanout: 2,
        parent: { fuel: 2, depth: 2, fanout: 2 }
      })
    ).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Nested recursion may attenuate but cannot widen its parent envelope"
      })
    )
    expect(() =>
      Recursion.recurse({
        child,
        fuel: 2,
        depth: 2,
        fanout: 3,
        parent: { fuel: 2, depth: 2, fanout: 2 }
      })
    ).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Nested recursion may attenuate but cannot widen its parent envelope"
      })
    )
    expect(() =>
      Graph.build(
        Recursion.recurse({ child, fuel: 3, depth: 3, fanout: 1 }),
        { input: "root", children: [{ input: "a" }, { input: "b" }] }
      )
    ).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Recursive child fan-out exceeds the envelope"
      })
    )
    expect(() =>
      Graph.build(
        Recursion.recurse({ child, fuel: 2, depth: 3, fanout: 2 }),
        {
          input: "root",
          children: [{ input: "a", children: [{ input: "b" }] }]
        }
      )
    ).toThrow(
      expect.objectContaining({ code: "recursion_bound", message: "Recursion fuel is exhausted" })
    )
  })

  it("admits the declared depth and refuses one level past it", () => {
    const recursive = Recursion.recurse({ child, fuel: 4, depth: 3, fanout: 1 })
    const atBound = {
      input: "root",
      children: [{ input: "middle", children: [{ input: "leaf" }] }]
    }
    const pastBound = {
      input: "root",
      children: [{ input: "middle", children: [{ input: "leaf", children: [{ input: "past" }] }] }]
    }

    expect(Graph.nodes(Graph.build(recursive, atBound)).filter((node) => node.kind === "FlowCall")).toHaveLength(3)
    expect(() => Graph.build(recursive, pastBound)).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Recursive child depth exceeds the envelope"
      })
    )
  })

  it("refuses a symbolic tree instead of silently planning one leaf", () => {
    const recursive = Recursion.recurse({ child, fuel: 4, depth: 3, fanout: 2 })
    const composed = Flow.make({
      input: Schema.Unknown,
      output: Schema.Unknown,
      body: (input) => Node.andThen(Node.succeed(input), (value) => recursive(value))
    })

    expect(() => Graph.build(composed, { input: "root" })).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Recursion input must be a literal tree available while planning"
      })
    )
  })
})
