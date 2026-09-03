import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Intervene from "../src/Intervene.ts"
import { PatternError } from "../src/PatternError.ts"
import * as WithApproval from "../src/WithApproval.ts"

const step = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const gate = Flow.make({
  name: "human-approval",
  input: Schema.Unknown,
  output: WithApproval.Approved,
  body: () => Node.dynamic({ output: WithApproval.Approved })
})

const literal = (node: Graph.GraphNode): Record<string, unknown> => {
  const first = node.keyMaterial.inputs[0]
  return first !== undefined && first._tag === "Literal" && typeof first.value === "object" && first.value !== null
    ? first.value as Record<string, unknown>
    : {}
}

const calls = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) => node.kind === "FlowCall")

describe("Intervene", () => {
  it("declares read, propose, apply, and report", () => {
    const graph = Graph.build(
      Intervene.make({ read: step, propose: step, apply: step, report: step, dryRun: false }),
      "refactor"
    )

    expect(calls(graph).map((node) => literal(node).phase)).toEqual(["read", "propose", "apply", "report"])
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("drops the apply call on a dry run", () => {
    const graph = Graph.build(
      Intervene.make({ read: step, propose: step, apply: step, report: step, dryRun: true }),
      "refactor"
    )

    expect(calls(graph).map((node) => literal(node).phase)).toEqual(["read", "propose", "report"])
    expect(literal(calls(graph)[2]!).dryRun).toBe(true)
  })

  it("declares the approval call before apply only when an approval is configured", () => {
    const gated = Graph.build(
      Intervene.make({
        read: step,
        propose: step,
        apply: step,
        report: step,
        dryRun: false,
        approval: gate,
        reason: "rewrite the module"
      }),
      "refactor"
    )
    const ungated = Graph.build(
      Intervene.make({ read: step, propose: step, apply: step, report: step, dryRun: false }),
      "refactor"
    )

    // `withApproval` contributes two wrapper calls (the decorator and the
    // declaration it wraps) that carry the apply input, then the approval, then
    // the apply flow itself.
    const phases = calls(gated).map((node) => literal(node).scope === "run" ? "approval" : literal(node).phase)
    expect(phases).toEqual(["read", "propose", "apply", "apply", "approval", "apply", "report"])
    expect(phases.indexOf("approval")).toBeLessThan(phases.lastIndexOf("apply"))
    expect(calls(ungated).some((node) => literal(node).scope === "run")).toBe(false)
    expect(Graph.diagnostics(gated)).toEqual([])
  })

  it("rejects an approval flow that permits denial", () => {
    const permissive = Flow.make({
      input: Schema.Unknown,
      output: Schema.String,
      body: () => Node.succeed("approved")
    })

    expect(() =>
      Intervene.make({
        read: step,
        propose: step,
        apply: step,
        report: step,
        dryRun: false,
        approval: permissive
      })
    ).toThrow(expect.objectContaining({
      code: "invalid_decorator",
      message: "The bound flow has an incompatible output schema: expected Literal, received String"
    }))
    expect(() =>
      Intervene.make({
        read: step,
        propose: step,
        apply: step,
        report: step,
        dryRun: false,
        approval: permissive
      })
    ).toThrow(PatternError)
  })

  it.effect("never applies on a dry run and reports the proposal", () =>
    Effect.gen(function*() {
      let applied = 0

      const report = yield* Intervene.run("refactor", {
        dryRun: true,
        read: () => Effect.succeed(["a.ts", "b.ts"]),
        propose: ({ context }) => Effect.succeed({ edits: context.length }),
        apply: () =>
          Effect.sync(() => {
            applied += 1
            return "written"
          }),
        report: (args) => Effect.succeed(args)
      })

      expect(applied).toBe(0)
      expect(report).toEqual({
        input: "refactor",
        proposal: { edits: 2 },
        applied: undefined,
        dryRun: true
      })
    }))

  it.effect("applies and reports what was written when the approval decodes", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []

      const report = yield* Intervene.run("refactor", {
        dryRun: false,
        read: () => Effect.sync(() => trace.push("read")).pipe(Effect.as(["a.ts"])),
        propose: () => Effect.sync(() => trace.push("propose")).pipe(Effect.as({ edits: 1 })),
        approval: () => Effect.sync(() => trace.push("approve")).pipe(Effect.as("approved")),
        apply: () => Effect.sync(() => trace.push("apply")).pipe(Effect.as("written")),
        report: (args) => Effect.sync(() => trace.push("report")).pipe(Effect.as(args))
      })

      expect(trace).toEqual(["read", "propose", "approve", "apply", "report"])
      expect(report).toMatchObject({ applied: "written", dryRun: false })
    }))

  it.effect("applies directly when no approval callback is configured", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const report = yield* Intervene.run("refactor", {
        dryRun: false,
        read: () => Effect.sync(() => (trace.push("read"), ["a.ts"])),
        propose: () => Effect.sync(() => (trace.push("propose"), { edits: 1 })),
        apply: () => Effect.sync(() => (trace.push("apply"), "written")),
        report: (args) => Effect.sync(() => (trace.push("report"), args))
      })

      expect(trace).toEqual(["read", "propose", "apply", "report"])
      expect(report).toMatchObject({ applied: "written", dryRun: false })
    }))

  it.effect("stops before apply when the approval is denied", () =>
    Effect.gen(function*() {
      let applied = 0

      const failure = yield* Intervene.run("refactor", {
        dryRun: false,
        read: () => Effect.succeed(["a.ts"]),
        propose: () => Effect.succeed({ edits: 1 }),
        approval: () => Effect.succeed("denied"),
        apply: () =>
          Effect.sync(() => {
            applied += 1
            return "written"
          }),
        report: (args) => Effect.succeed(args)
      }).pipe(Effect.flip)

      expect(failure._tag).toBe("SchemaError")
      expect(applied).toBe(0)
    }))

  it("gives two approval reasons different step identity", () => {
    const material = (reason: string) =>
      Graph.nodes(Graph.build(
        Intervene.make({ read: step, propose: step, apply: step, report: step, dryRun: false, reason }),
        "refactor"
      ))

    const rename = material("rename the symbol")
    const rewrite = material("rewrite the greeting")

    expect(rename.map((node) => node.kind)).toEqual(rewrite.map((node) => node.kind))
    expect(rename.map((node) => node.keyMaterial.body)).not.toEqual(rewrite.map((node) => node.keyMaterial.body))
  })
})
