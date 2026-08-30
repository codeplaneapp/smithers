/**
 * The served rows, as pure folds.
 *
 * Every fixture here is the payload a real emitter writes, field for field:
 *
 * - `control.agent.*` from `@smthrs/agent` `AgentSession`, which journals
 *   `{seat, contextDigest}`, `{flowName, input}`, and `{flowName, outcome,
 *   message, value}`. None of them carries a node id, a run id, or a stamp,
 *   so none appears in a fixture here either.
 * - `control.approval.approved` and `control.approval.denied` from
 *   `@smthrs/control` `ControlLive`, which journals `{tokenId, target, scope,
 *   envelope, principal}`.
 *
 * The suites against the real control plane prove these rows reach a client,
 * and `RealEngineRun.test.ts` proves a run the durable engine really executed
 * reads back through them. These prove what is in the rows, including what a
 * happy path never produces: a decision that names no token, a settlement with
 * no open call, a settled call whose value is not a string.
 */
import type { ControlSchema } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as GatewayProjection from "../src/GatewayProjection.ts"

let sequence = 0

const event = (kind: string, payload: unknown, occurredAt = 0): ControlSchema.ControlEvent => ({
  sequence: (sequence += 1),
  kind,
  runId: "run-1",
  occurredAt,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

/** An event with no run id at all, which a malformed journal can produce. */
const orphan = (kind: string, payload: unknown): ControlSchema.ControlEvent => ({
  sequence: (sequence += 1),
  kind,
  occurredAt: 0,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

const run: ControlSchema.RunSummary = {
  runId: "run-1",
  flowId: "deploy",
  status: "running",
  createdAt: 10,
  updatedAt: 20
}

describe("GatewayProjection.runSummary", () => {
  it("carries only the optional fields the run actually has", () => {
    const row = GatewayProjection.runSummary(run, [])
    expect(row).toMatchObject({ runId: "run-1", flowId: "deploy", status: "running", createdAt: 10, updatedAt: 20 })
    expect(Object.keys(row)).not.toContain("planId")
    expect(Object.keys(row)).not.toContain("cancellation")
    expect(Object.keys(row)).not.toContain("steeringPending")
  })

  it("carries every optional field the run does have", () => {
    const row = GatewayProjection.runSummary(
      {
        ...run,
        planId: "plan-1",
        planDigest: "digest-1",
        parentRunId: "parent-1",
        lineageId: "lineage-1",
        roundOrdinal: 2,
        waitingReason: "approval",
        steering: { pending: 3 },
        cancellation: { requestedAt: 5, source: "control", reason: "stop" }
      },
      [event("control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" })]
    )
    expect(row).toMatchObject({
      planId: "plan-1",
      planDigest: "digest-1",
      parentRunId: "parent-1",
      lineageId: "lineage-1",
      roundOrdinal: 2,
      waitingReason: "approval",
      steeringPending: 3,
      cancellation: { source: "control", reason: "stop" },
      seat: "opus"
    })
  })
})

describe("GatewayProjection.runTree", () => {
  it("keys each call by the ordinal it opened on, because the emitter names no node", () => {
    const rows = GatewayProjection.runTree(run, [
      event("control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" }),
      event("control.agent.cell-call-started", { flowName: "write", input: { path: "a" } }, 1),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "ok" }, 2),
      event("control.agent.cell-call-started", { flowName: "read", input: {} }, 3),
      event("control.agent.cell-call-settled", { flowName: "read", outcome: "failure", message: "no" }, 4),
      event("control.agent.cell-call-started", { flowName: "grep", input: {} }, 5)
    ])
    expect(rows).toMatchObject([
      { nodeId: "call-1", label: "write", status: "completed", seat: "opus", startedAt: 1, endedAt: 2 },
      { nodeId: "call-2", label: "read", status: "failed", endedAt: 4 },
      { nodeId: "call-3", label: "grep", status: "running" }
    ])
    // A node still open has no end.
    expect(Object.keys(rows[2] ?? {})).not.toContain("endedAt")
  })

  it("settles the oldest open call of the settlement's flow, not the newest", () => {
    const rows = GatewayProjection.runTree(run, [
      event("control.agent.cell-call-started", { flowName: "write", input: {} }, 1),
      event("control.agent.cell-call-started", { flowName: "read", input: {} }, 2),
      event("control.agent.cell-call-started", { flowName: "write", input: {} }, 3),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success" }, 4)
    ])
    expect(rows.map((row) => `${row.nodeId}:${row.status}`)).toEqual([
      "call-1:completed",
      "call-2:running",
      "call-3:running"
    ])
  })

  it("names a call whose flow name is missing after the ordinal it opened on", () => {
    const rows = GatewayProjection.runTree({ ...run, parentRunId: "parent-1" }, [
      event("control.agent.cell-call-started", {}),
      event("control.agent.cell-call-settled", {})
    ])
    expect(rows).toMatchObject([{ nodeId: "call-1", label: "call-1", status: "completed", parentRunId: "parent-1" }])
  })

  it("drops a settlement that matches no open call", () => {
    expect(GatewayProjection.runTree(run, [event("control.agent.cell-call-settled", { flowName: "write" })]))
      .toEqual([])
  })

  it("keeps the seat from the last turn that named one", () => {
    const rows = GatewayProjection.runTree(run, [
      event("control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" }),
      event("control.agent.turn-opened", { contextDigest: "ctx" }),
      event("control.agent.cell-call-started", { flowName: "write" })
    ])
    expect(rows[0]?.seat).toBe("opus")
  })
})

describe("GatewayProjection.approvals", () => {
  const payload = {
    target: { _tag: "Node", runId: "run-1", requestId: "gate", digest: "d", envelope: {} },
    scope: "run",
    idempotencyKey: "k"
  }

  it("titles a request with its question and falls back to the request id", () => {
    const rows = GatewayProjection.approvals([
      event("control.approval.requested", { runId: "run-1", requestId: "gate", question: "Ship?", payload }),
      event("control.approval.requested", { runId: "run-1", requestId: "mute", payload })
    ])
    expect(rows.map((row) => row.title)).toEqual(["Ship?", "Approval needed — mute"])
  })

  it("takes the run from the event when the payload does not name one", () => {
    const rows = GatewayProjection.approvals([
      event("control.approval.requested", { requestId: "gate", payload })
    ])
    expect(rows[0]?.runId).toBe("run-1")
  })

  it("drops a request missing its request id, run, or payload", () => {
    expect(
      GatewayProjection.approvals([
        event("control.approval.requested", { runId: "run-1", payload }),
        orphan("control.approval.requested", { requestId: "gate", payload }),
        event("control.approval.requested", { runId: "run-1", requestId: "gate" })
      ])
    ).toEqual([])
  })

  it("decides only the gate the decision's token names", () => {
    // `SqlControlRuntime.lookupApproval` mints the token id from the target,
    // and for a Node target that is the request id, so one decision closes one
    // gate even while two are open.
    const rows = GatewayProjection.approvals([
      event("control.approval.requested", { runId: "run-1", requestId: "first", payload }),
      event("control.approval.requested", { runId: "run-1", requestId: "second", payload }),
      event("control.approval.approved", {
        tokenId: "second",
        target: "Node",
        scope: "run",
        envelope: {},
        principal: { id: "operator", kind: "cli", stampedAt: 1 }
      })
    ])
    expect(rows.map((row) => `${row.requestId}:${row.status}`)).toEqual(["first:pending", "second:approved"])
  })

  it("closes the oldest pending gate when a decision names no token", () => {
    const rows = GatewayProjection.approvals([
      event("control.approval.requested", { runId: "run-1", requestId: "first", payload }),
      event("control.approval.requested", { runId: "run-1", requestId: "second", payload }),
      event("control.approval.denied", { target: "Node", scope: "run" }),
      event("control.approval.approved", { target: "Node", scope: "run" }),
      event("control.approval.approved", { target: "Node", scope: "run" })
    ])
    // Two decisions for two gates; a third finds nothing pending and changes
    // nothing, so the first decision on a gate stays the decision.
    expect(rows.map((row) => `${row.requestId}:${row.status}`)).toEqual(["first:denied", "second:approved"])
  })

  it("ignores an event that is neither a request nor a decision", () => {
    expect(GatewayProjection.approvals([event("control.run.accepted", { runId: "run-1", status: "accepted" })]))
      .toEqual([])
  })
})

describe("GatewayProjection.nodeOutput", () => {
  it("records a success value, a failure message, and a non-string value", () => {
    const rows = GatewayProjection.nodeOutput([
      event("control.agent.cell-call-started", { flowName: "a", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "a", outcome: "success", value: "text" }),
      event("control.agent.cell-call-started", { flowName: "b", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "b", outcome: "failure", message: "no" }),
      event("control.agent.cell-call-started", { flowName: "c", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "c", outcome: "success", value: { ok: 1 } }),
      event("control.agent.cell-call-started", { flowName: "d", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "d", outcome: "success" }),
      event("control.agent.cell-call-started", { flowName: "e", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "e", outcome: "failure" })
    ])
    expect(rows).toMatchObject([
      { nodeId: "call-1", outcome: "success", output: "text" },
      { nodeId: "call-2", outcome: "failure", output: "no" },
      { nodeId: "call-3", outcome: "success", output: "{\"ok\":1}" },
      { nodeId: "call-4", outcome: "success", output: "null" },
      { nodeId: "call-5", outcome: "failure", output: "" }
    ])
  })

  it("drops a settlement with no open call and one with no run at all", () => {
    const rows = GatewayProjection.nodeOutput([
      event("control.agent.cell-call-started", {}),
      event("control.agent.cell-call-settled", { outcome: "success", value: "v" }),
      event("control.agent.cell-call-settled", { outcome: "success", value: "late" }),
      orphan("control.agent.cell-call-settled", { outcome: "success", value: "v" })
    ])
    expect(rows).toMatchObject([{ nodeId: "call-1", runId: "run-1", output: "v" }])
  })
})

describe("GatewayProjection.transcript", () => {
  it("numbers turns and renders each reported kind as one line", () => {
    const rows = GatewayProjection.transcript([
      event("control.run.accepted", { runId: "run-1", status: "accepted" }),
      event("control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" }),
      event("control.agent.model-settled", { text: "t", usage: { inputTokens: 3, outputTokens: 4 } }),
      event("control.agent.model-settled", {}),
      event("control.agent.cell-call-started", { flowName: "write", input: {} }),
      event("control.agent.cell-call-started", {}),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success" }),
      event("control.agent.cell-call-settled", { outcome: "failure", message: "no" }),
      event("control.agent.resolved", { text: "done" }),
      event("control.approval.requested", { question: "Ship?" }),
      event("control.agent.turn-closed", {}),
      event("control.plan.created", {}),
      orphan("control.run.completed", {})
    ])
    expect(rows.map((row) => `${row.turn}:${row.text}`)).toEqual([
      "0:run.accepted",
      "1:turn opened · opus",
      "1:model 3 in / 4 out",
      "1:model 0 in / 0 out",
      "1:call write",
      "1:call ?",
      "1:  -> ok",
      "1:  -> FAIL no",
      "1:resolved done",
      "1:approval requested: Ship?",
      "1:agent.turn-closed"
    ])
  })

  it("renders a missing question and an empty resolution without inventing text", () => {
    const rows = GatewayProjection.transcript([
      event("control.approval.requested", {}),
      event("control.agent.resolved", {}),
      event("control.agent.turn-opened", {}),
      event("control.agent.cell-call-settled", { outcome: "failure" })
    ])
    expect(rows.map((row) => row.text)).toEqual([
      "approval requested: ",
      "resolved ",
      "turn opened · ",
      "  -> FAIL "
    ])
  })
})
