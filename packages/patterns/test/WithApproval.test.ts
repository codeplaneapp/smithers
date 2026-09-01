import { describe, it } from "@effect/vitest"
import { Effects, Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as WithApproval from "../src/WithApproval.ts"

const ApprovalInput = Schema.Struct({
  input: Schema.Unknown,
  reason: Schema.String,
  scope: Schema.String
})

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

  it("accepts an approval flow whose input exactly describes the call payload", () => {
    const inner = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const approval = Flow.make({
      input: ApprovalInput,
      output: WithApproval.Approved,
      body: () => Node.succeed("approved" as const)
    })
    const approved = WithApproval.withApproval(inner, { reason: "publish", approval })

    expect(Graph.diagnostics(Graph.build(approved, "v1"))).toEqual([])
  })

  it("names the input side and both schema tags for an incompatible approval input", () => {
    const inner = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const approval = Flow.make({
      input: Schema.String,
      output: WithApproval.Approved,
      body: () => Node.succeed("approved" as const)
    })

    expect(() => WithApproval.withApproval(inner, { reason: "publish", approval })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The bound flow has an incompatible input schema: expected Objects, received String"
      })
    )
  })

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
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The bound flow has an incompatible output schema: expected Literal, received String"
      })
    )
  })

  it("refuses a blank approval reason with its exact code", () => {
    const inner = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const approval = Flow.make({
      input: Schema.Unknown,
      output: WithApproval.Approved,
      body: () => Node.succeed("approved" as const)
    })

    expect(() => WithApproval.withApproval(inner, { reason: " \t", approval })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Approval reason must not be empty"
      })
    )
    expect(() => WithApproval.withApproval(inner, { reason: " \t", approval })).toThrow(PatternError)
  })
})
