import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as Runbook from "../src/Runbook.ts"
import * as WithApproval from "../src/WithApproval.ts"

const step = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const approval = Flow.make({
  name: "human-approval",
  input: Schema.Unknown,
  output: WithApproval.Approved,
  body: () => Node.dynamic({ output: WithApproval.Approved })
})

const steps = [
  { id: "backup", flow: step, risk: "safe" as const },
  { id: "deploy", flow: step, risk: "risky" as const },
  { id: "migrate", flow: step, risk: "critical" as const }
]

const literal = (node: Graph.GraphNode): Record<string, unknown> => {
  const first = node.keyMaterial.inputs[0]
  return first !== undefined && first._tag === "Literal" ? first.value as Record<string, unknown> : {}
}

const approvalCalls = (graph: Graph.Graph): ReadonlyArray<Record<string, unknown>> =>
  Graph.nodes(graph)
    .filter((node) => node.kind === "FlowCall")
    .map(literal)
    .filter((value) => value.scope === "run")
    .map((value) => value.input as Record<string, unknown>)
    .sort((left, right) => String(left.step).localeCompare(String(right.step)))

describe("Runbook", () => {
  it("declares an approval call only for a non-safe step", () => {
    const graph = Graph.build(Runbook.make({ steps, approval, onDeny: "fail" }), "release")

    expect(Graph.diagnostics(graph)).toEqual([])
    expect(approvalCalls(graph).map((value) => value.step)).toEqual(["deploy", "migrate"])
  })

  it("marks a critical step's approval elevated and a risky one not", () => {
    const graph = Graph.build(Runbook.make({ steps, approval, onDeny: "fail" }), "release")

    expect(approvalCalls(graph).map((value) => value.elevated)).toEqual([false, true])
    expect(approvalCalls(graph).map((value) => value.risk)).toEqual(["risky", "critical"])
  })

  it("declares no approval call when every step is safe", () => {
    const graph = Graph.build(
      Runbook.make({ steps: [{ id: "backup", flow: step, risk: "safe" }], approval, onDeny: "fail" }),
      "release"
    )

    expect(approvalCalls(graph)).toEqual([])
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(1)
  })

  it("rejects an empty runbook, a duplicate step id, and an approval that permits denial", () => {
    expect(() => Runbook.make({ steps: [], approval, onDeny: "fail" })).toThrow(PatternError)
    expect(() => Runbook.make({ steps: [steps[0]!, steps[0]!], approval, onDeny: "fail" })).toThrow(PatternError)
    const permissive = Flow.make({
      input: Schema.Unknown,
      output: Schema.String,
      body: () => Node.succeed("approved")
    })
    expect(() => Runbook.make({ steps, approval: permissive, onDeny: "fail" })).toThrow(PatternError)
  })

  it.effect("never asks for approval of a safe step", () =>
    Effect.gen(function*() {
      const asked: Array<string> = []

      const result = yield* Runbook.run("release-1", {
        onDeny: "fail",
        approve: (request) =>
          Effect.sync(() => {
            asked.push(request.step)
            return "approved"
          }),
        steps: [
          { id: "backup", risk: "safe", run: () => Effect.succeed("backed up") },
          { id: "deploy", risk: "risky", run: () => Effect.succeed("deployed") }
        ]
      })

      expect(asked).toEqual(["deploy"])
      expect(result.ran).toEqual(["backup", "deploy"])
      expect(result.skipped).toEqual([])
      expect(result.outputs).toEqual({ backup: "backed up", deploy: "deployed" })
    }))

  it.effect("passes elevated true for a critical step and the previous step's output", () =>
    Effect.gen(function*() {
      const requests: Array<{ readonly step: string; readonly elevated: boolean; readonly previous: unknown }> = []

      yield* Runbook.run("release-1", {
        onDeny: "fail",
        approve: (request) =>
          Effect.sync(() => {
            requests.push({ step: request.step, elevated: request.elevated, previous: request.previous })
            return "approved"
          }),
        steps: [
          { id: "deploy", risk: "risky", run: () => Effect.succeed("deployed") },
          { id: "migrate", risk: "critical", run: () => Effect.succeed("migrated") }
        ]
      })

      expect(requests).toEqual([
        { step: "deploy", elevated: false, previous: undefined },
        { step: "migrate", elevated: true, previous: "deployed" }
      ])
    }))

  it.effect("stops the runbook on a denial under onDeny fail", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []

      const failure = yield* Runbook.run("release-1", {
        onDeny: "fail",
        approve: () => Effect.succeed("denied"),
        steps: [
          {
            id: "deploy",
            risk: "risky",
            run: () =>
              Effect.sync(() => {
                ran.push("deploy")
                return "deployed"
              })
          },
          {
            id: "notify",
            risk: "safe",
            run: () =>
              Effect.sync(() => {
                ran.push("notify")
                return "notified"
              })
          }
        ]
      }).pipe(Effect.flip)

      expect(failure._tag).toBe("SchemaError")
      expect(ran).toEqual([])
    }))

  it.effect("skips a denied step and runs the next one under onDeny skip", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []

      const result = yield* Runbook.run("release-1", {
        onDeny: "skip",
        approve: (request) => Effect.succeed(request.step === "deploy" ? "denied" : "approved"),
        steps: [
          {
            id: "deploy",
            risk: "risky",
            run: () =>
              Effect.sync(() => {
                ran.push("deploy")
                return "deployed"
              })
          },
          {
            id: "notify",
            risk: "safe",
            run: () =>
              Effect.sync(() => {
                ran.push("notify")
                return "notified"
              })
          }
        ]
      })

      expect(ran).toEqual(["notify"])
      expect(result.skipped).toEqual(["deploy"])
      expect(result.ran).toEqual(["notify"])
      expect(result.outputs).toEqual({ notify: "notified" })
    }))

  it.effect("hands a skipped step's predecessor to the next step", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []

      yield* Runbook.run("release-1", {
        onDeny: "skip",
        approve: (request) => Effect.succeed(request.step === "deploy" ? "denied" : "approved"),
        steps: [
          { id: "backup", risk: "safe", run: () => Effect.succeed("backed up") },
          { id: "deploy", risk: "risky", run: () => Effect.succeed("deployed") },
          {
            id: "notify",
            risk: "safe",
            run: ({ previous }) =>
              Effect.sync(() => {
                seen.push(previous)
                return "notified"
              })
          }
        ]
      })

      expect(seen).toEqual(["backed up"])
    }))

  it.effect("rejects an empty runbook and a duplicate step id at runtime", () =>
    Effect.gen(function*() {
      const empty = yield* Runbook.run("release-1", {
        onDeny: "fail",
        approve: () => Effect.succeed("approved"),
        steps: []
      }).pipe(Effect.flip)
      expect(empty).toBeInstanceOf(PatternError)

      const duplicate = yield* Runbook.run("release-1", {
        onDeny: "fail",
        approve: () => Effect.succeed("approved"),
        steps: [
          { id: "deploy", risk: "safe", run: () => Effect.succeed("a") },
          { id: "deploy", risk: "safe", run: () => Effect.succeed("b") }
        ]
      }).pipe(Effect.flip)
      expect(duplicate).toBeInstanceOf(PatternError)
    }))

  // A declared plan has no branch to drop a denied step from, and the gated
  // node carries the step's own failures beside the denial, so an arm here
  // would declare that the runbook continues past a FAILED critical step.
  // `make` refuses the option rather than accepting it and building a plan
  // that halts, which is the shape an operator reading the plan would
  // misread as a skip.
  it("refuses onDeny skip at declaration, naming run as the way to skip", () => {
    expect(() => Runbook.make({ steps, approval, onDeny: "skip" })).toThrow(PatternError)
    const refusal = (() => {
      try {
        Runbook.make({ steps, approval, onDeny: "skip" })
        return undefined
      } catch (error) {
        return error as PatternError
      }
    })()

    expect(refusal?.code).toBe("invalid_decorator")
    expect(refusal?.message).toContain("Runbook.make does not support onDeny: \"skip\"")
    expect(refusal?.message).toContain("Runbook.run")
    // The supported declaration is unaffected.
    expect(Graph.diagnostics(Graph.build(Runbook.make({ steps, approval, onDeny: "fail" }), "release")))
      .toEqual([])
  })
})
