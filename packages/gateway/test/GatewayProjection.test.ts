/**
 * The served rows, as pure folds.
 *
 * The suites against the real control plane prove these rows reach a client.
 * These prove what is in them, including the shapes a real journal produces
 * that a happy-path fixture never would: an event with no node id, a decision
 * that arrives before its request, a settled call whose value is not a string.
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
      [event("control.agent.turn-opened", { seat: "opus" })]
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
  it("opens a node on a call and settles it on the matching result", () => {
    const rows = GatewayProjection.runTree(run, [
      event("control.agent.turn-opened", { seat: "opus" }),
      event("control.agent.cell-call-started", { nodeId: "a", flowName: "write", at: 1 }),
      event("control.agent.cell-call-settled", { nodeId: "a", outcome: "success", at: 2 }),
      event("control.agent.cell-call-started", { nodeId: "b", flowName: "read", at: 3 }),
      event("control.agent.cell-call-settled", { nodeId: "b", outcome: "failure", at: 4 }),
      event("control.agent.cell-call-started", { nodeId: "c", flowName: "grep", at: 5 })
    ])
    expect(rows).toMatchObject([
      { nodeId: "a", label: "write", status: "completed", seat: "opus", startedAt: 1, endedAt: 2 },
      { nodeId: "b", label: "read", status: "failed", endedAt: 4 },
      { nodeId: "c", label: "grep", status: "running" }
    ])
    // A node still open has no end.
    expect(Object.keys(rows[2] ?? {})).not.toContain("endedAt")
  })

  it("numbers a call that names no node and carries the parent run", () => {
    const rows = GatewayProjection.runTree({ ...run, parentRunId: "parent-1" }, [
      event("control.agent.cell-call-started", {}),
      event("control.agent.cell-call-settled", {})
    ])
    expect(rows).toMatchObject([{ nodeId: "call-1", label: "call-1", status: "completed", parentRunId: "parent-1" }])
  })

  it("drops a result for a call it never saw open", () => {
    expect(GatewayProjection.runTree(run, [event("control.agent.cell-call-settled", { nodeId: "ghost" })])).toEqual([])
  })

  it("keeps the seat from the last turn that named one", () => {
    const rows = GatewayProjection.runTree(run, [
      event("control.agent.turn-opened", { seat: "opus" }),
      event("control.agent.turn-opened", {}),
      event("control.agent.cell-call-started", { nodeId: "a" })
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

  it("marks a decided gate and leaves an already-decided one alone", () => {
    const denied = GatewayProjection.approvals([
      event("control.approval.requested", { runId: "run-1", requestId: "gate", payload }),
      event("control.approval.denied", { runId: "run-1" }),
      event("control.approval.approved", { runId: "run-1" })
    ])
    // The first decision is the decision; a later event does not overwrite it.
    expect(denied.map((row) => row.status)).toEqual(["denied"])
  })

  it("ignores an event that is neither a request nor a decision", () => {
    expect(GatewayProjection.approvals([event("control.run.accepted", {})])).toEqual([])
  })
})

describe("GatewayProjection.nodeOutput", () => {
  it("records a success value, a failure message, and a non-string value", () => {
    const rows = GatewayProjection.nodeOutput([
      event("control.agent.cell-call-started", { nodeId: "a" }),
      event("control.agent.cell-call-settled", { runId: "run-1", nodeId: "a", outcome: "success", value: "text" }),
      event("control.agent.cell-call-settled", { runId: "run-1", nodeId: "b", outcome: "failure", message: "no" }),
      event("control.agent.cell-call-settled", { runId: "run-1", nodeId: "c", outcome: "success", value: { ok: 1 } }),
      event("control.agent.cell-call-settled", { runId: "run-1", nodeId: "d", outcome: "success" }),
      event("control.agent.cell-call-settled", { runId: "run-1", nodeId: "e", outcome: "failure" })
    ])
    expect(rows).toMatchObject([
      { nodeId: "a", outcome: "success", output: "text" },
      { nodeId: "b", outcome: "failure", output: "no" },
      { nodeId: "c", outcome: "success", output: "{\"ok\":1}" },
      { nodeId: "d", outcome: "success", output: "null" },
      { nodeId: "e", outcome: "failure", output: "" }
    ])
  })

  it("numbers a settled call that names no node, and drops one with no run", () => {
    const rows = GatewayProjection.nodeOutput([
      event("control.agent.cell-call-started", {}),
      event("control.agent.cell-call-settled", { outcome: "success", value: "v" }),
      orphan("control.agent.cell-call-settled", { outcome: "success", value: "v" })
    ])
    expect(rows).toMatchObject([{ nodeId: "call-1", runId: "run-1" }])
  })
})

describe("GatewayProjection.transcript", () => {
  it("numbers turns and renders each reported kind as one line", () => {
    const rows = GatewayProjection.transcript([
      event("control.run.accepted", {}),
      event("control.agent.turn-opened", { seat: "opus" }),
      event("control.agent.model-settled", { usage: { inputTokens: 3, outputTokens: 4 } }),
      event("control.agent.model-settled", {}),
      event("control.agent.cell-call-started", { flowName: "write" }),
      event("control.agent.cell-call-started", {}),
      event("control.agent.cell-call-settled", { outcome: "success" }),
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
