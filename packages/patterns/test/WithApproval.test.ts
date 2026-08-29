import { describe, it } from "@effect/vitest"
import { Effects, Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as WithApproval from "../src/WithApproval.ts"

describe("WithApproval", () => {
  it("runs a caller-supplied approval flow before the inner flow", () => {
    const inner = Flow.make({
      name: "publish",
      input: Schema.String,
      output: Schema.String,
      capabilities: ["release:publish"],
      effects: Effects.make({
        reads: [],
        writes: ["release"],
        mode: "expected",
        onConflict: "serialize",
        tier: "irreversible"
      }),
      body: () => Node.dynamic({ output: Schema.String })
    })
    const approval = Flow.make({
      name: "human-approval",
      input: Schema.Unknown,
      output: WithApproval.Approved,
      body: () => Node.dynamic({ output: WithApproval.Approved })
    })
    const approved = WithApproval.withApproval(inner, {
      reason: "publish release",
      approval
    })
    const graph = Graph.build(approved, "v1")

    expect((approved as typeof inner).name).toBe("withApproval(publish)")
    expect((approved as typeof inner).capabilities).toEqual(["release:publish"])
    expect(Graph.nodes(graph).filter((node) => node.kind === "Dynamic")).toHaveLength(2)
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(3)
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it.effect("rejects denial on the typed schema-error channel", () =>
    Effect.gen(function*() {
      const failure = yield* Schema.decodeUnknownEffect(WithApproval.Approved)("denied").pipe(Effect.flip)

      expect(failure._tag).toBe("SchemaError")
    }))

  it("rejects an approval flow whose output permits denial", () => {
    const inner = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const approval = Flow.make({
      input: Schema.Unknown,
      output: Schema.String,
      body: () => Node.succeed("approved")
    })

    expect(() => WithApproval.withApproval(inner, { reason: "publish", approval })).toThrow(
      "The bound flow does not satisfy the slot input and output schemas"
    )
  })
})
