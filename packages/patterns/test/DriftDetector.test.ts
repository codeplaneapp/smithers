import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as DriftDetector from "../src/DriftDetector.ts"

const flowNamed = (capability: string): Flow.Any =>
  Flow.make({
    name: capability,
    capabilities: [capability],
    input: Schema.Unknown,
    output: Schema.Unknown,
    body: (input) => Node.succeed(input)
  })

const capture = flowNamed("drift/capture")
const compare = flowNamed("drift/compare")
const alert = flowNamed("drift/alert")

const callsTo = (graph: Graph.Graph, capability: string): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) =>
    node.kind === "FlowCall" &&
    (node.keyMaterial.body as { readonly capabilities?: ReadonlyArray<string> }).capabilities?.includes(capability) ===
      true
  )

interface Snapshot {
  readonly checksum: string
}

describe("DriftDetector", () => {
  it("declares capture, compare, and the alert arm", () => {
    const detector = DriftDetector.make({ capture, compare, alert, baseline: { checksum: "a" } })
    const graph = Graph.build(detector, { target: "config" })

    expect(Flow.isFlow(detector)).toBe(true)
    expect(callsTo(graph, "drift/capture")).toHaveLength(1)
    expect(callsTo(graph, "drift/compare")).toHaveLength(1)
    expect(callsTo(graph, "drift/alert")).toHaveLength(1)
  })

  it("declares no alert call when the detector only reports", () => {
    const detector = DriftDetector.make({ capture, compare, baseline: { checksum: "a" } })
    const graph = Graph.build(detector, { target: "config" })

    expect(callsTo(graph, "drift/alert")).toHaveLength(0)
    expect(callsTo(graph, "drift/compare")).toHaveLength(1)
  })

  it.effect("alerts once with the comparison when the snapshot drifted", () =>
    Effect.gen(function*() {
      const alerted: Array<unknown> = []
      const result = yield* DriftDetector.run({ target: "config" }, {
        baseline: { checksum: "a" } as Snapshot,
        capture: () => Effect.succeed({ checksum: "b" }),
        compare: ({ baseline, snapshot }) =>
          Effect.succeed({ drifted: snapshot.checksum !== baseline.checksum, from: baseline.checksum }),
        alert: (input) => Effect.sync(() => (alerted.push(input.comparison), "paged"))
      })

      expect(result.drifted).toBe(true)
      expect(result.snapshot).toEqual({ checksum: "b" })
      expect(result.alert).toBe("paged")
      expect(alerted).toEqual([{ drifted: true, from: "a" }])
    }))

  it.effect("skips the alert when nothing drifted", () =>
    Effect.gen(function*() {
      let alerts = 0
      const result = yield* DriftDetector.run({ target: "config" }, {
        baseline: { checksum: "a" } as Snapshot,
        capture: () => Effect.succeed({ checksum: "a" }),
        compare: ({ baseline, snapshot }) => Effect.succeed({ drifted: snapshot.checksum !== baseline.checksum }),
        alert: () => Effect.sync(() => (++alerts, "paged"))
      })

      expect(result.drifted).toBe(false)
      expect(result.alert).toBeUndefined()
      expect(alerts).toBe(0)
    }))

  it.effect("hands the baseline to capture and compare", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      yield* DriftDetector.run({ target: "config" }, {
        baseline: { checksum: "a" } as Snapshot,
        capture: (input) => Effect.sync(() => (seen.push(input.baseline), { checksum: "a" })),
        compare: (input) => Effect.sync(() => (seen.push(input.baseline), { drifted: false }))
      })

      expect(seen).toEqual([{ checksum: "a" }, { checksum: "a" }])
    }))

  it.effect("lets a custom alertIf override the default reader", () =>
    Effect.gen(function*() {
      let alerts = 0
      const result = yield* DriftDetector.run({ target: "config" }, {
        baseline: 100,
        capture: () => Effect.succeed(140),
        compare: ({ baseline, snapshot }) => Effect.succeed({ delta: snapshot - baseline }),
        alertIf: (comparison) => comparison.delta > 25,
        alert: () => Effect.sync(() => (++alerts, "paged"))
      })

      expect(result.drifted).toBe(true)
      expect(alerts).toBe(1)
    }))

  it.effect("reports drift without alerting when no alert is configured", () =>
    Effect.gen(function*() {
      const result = yield* DriftDetector.run({ target: "config" }, {
        baseline: { checksum: "a" } as Snapshot,
        capture: () => Effect.succeed({ checksum: "b" }),
        compare: ({ baseline, snapshot }) => Effect.succeed({ drifted: snapshot.checksum !== baseline.checksum }),
        alertIf: undefined
      })

      expect(result.drifted).toBe(true)
      expect(result.alert).toBeUndefined()
      expect(result.comparison).toEqual({ drifted: true })
    }))

  it("reads the drift signals a comparison may carry", () => {
    expect(DriftDetector.drifted(true)).toBe(true)
    expect(DriftDetector.drifted({ drifted: true })).toBe(true)
    expect(DriftDetector.drifted({ drifted: false })).toBe(false)
    expect(DriftDetector.drifted("changed")).toBe(false)
  })
})
