/**
 * Selector-correlated gateway row schemas.
 */
import type { ControlSchema } from "@smthrs/control"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as GatewaySchema from "../src/GatewaySchema.ts"

const run: ControlSchema.RunSummary = {
  runId: "run-1",
  flowId: "deploy",
  status: "running",
  createdAt: 1,
  updatedAt: 2
}

const event = (sequence: number, kind: string, payload: unknown): ControlSchema.ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

const started = event(1, "control.agent.cell-call-started", { flowName: "write" })
const settled = event(2, "control.agent.cell-call-settled", {
  flowName: "write",
  outcome: "success",
  value: "done"
})
const approval = event(3, "control.approval.requested", {
  runId: "run-1",
  requestId: "gate",
  question: "Ship?",
  payload: {
    target: {
      _tag: "Node",
      runId: "run-1",
      requestId: "gate",
      digest: "digest",
      envelope: { capabilities: [], flows: [], budget: {} }
    },
    scope: "run",
    idempotencyKey: "approve:gate"
  }
})
const accepted = event(4, "control.run.accepted", { runId: "run-1", status: "accepted" })

describe("GatewaySchema.rowSchemaFor", () => {
  const cases = [
    [{ _tag: "workspace-runs" }, GatewayProjection.runSummary(run, [])],
    [{ _tag: "run-summary", runId: "run-1" }, GatewayProjection.runSummary(run, [])],
    [{ _tag: "run-events", runId: "run-1" }, accepted],
    [{ _tag: "transcript", runId: "run-1" }, GatewayProjection.transcript([accepted])[0]],
    [{ _tag: "run-tree", runId: "run-1" }, GatewayProjection.runTree(run, [started])[0]],
    [{ _tag: "approvals", runId: "run-1" }, GatewayProjection.approvals([approval])[0]],
    [{ _tag: "node-output", runId: "run-1", nodeId: "call-1" }, GatewayProjection.nodeOutput([started, settled])[0]]
  ] as const satisfies ReadonlyArray<readonly [GatewaySchema.ProjectionSelector, unknown]>

  for (const [selector, row] of cases) {
    it(`decodes ${selector._tag} rows and rejects another shape`, () => {
      const schema = GatewaySchema.rowSchemaFor(selector)
      expect(Schema.decodeUnknownSync(schema)(row)).toEqual(row)
      expect(() => Schema.decodeUnknownSync(schema)({ definitelyWrong: true })).toThrow()
    })
  }
})

describe("selector-correlated wire payloads", () => {
  it("rejects rows and deltas that do not belong to their selector", () => {
    const selector = { _tag: "run-summary" as const, runId: "run-1" }
    const cursor = {
      selector,
      projection: selector._tag,
      runId: selector.runId,
      value: 4,
      offset: 0
    }
    for (
      const candidate of [
        { _tag: "row", selector, cursor, row: accepted },
        { _tag: "delta", selector, cursor, delta: [accepted] }
      ]
    ) {
      expect(() => Schema.decodeUnknownSync(GatewaySchema.GatewayFrame)(candidate)).toThrow()
    }
    expect(() => Schema.decodeUnknownSync(GatewaySchema.ProjectionSnapshot)({ selector, cursor, rows: [accepted] }))
      .toThrow()
  })
})
