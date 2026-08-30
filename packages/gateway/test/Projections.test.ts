/**
 * The served read path, against a real SQLite control plane.
 *
 * Three of the eight requirements the old `packages/server` suite pinned live
 * here, re-expressed on the rc.0 boundary:
 *
 * - `mirror-approval-projection`: an approval request reaches a pending row
 *   carrying the payload that decides it, and a decision clears it without
 *   discarding the request.
 * - `mirror-cancellation-projection`: a cancellation's source, reason, and
 *   principal reach the run's terminal row.
 * - `whatHappenedRoute`: a run's diagnosis answers from the run's own facts,
 *   an unknown run is refused by name, and a node's output is addressable.
 */
import { describe, expect, it } from "@effect/vitest"
import { Control } from "@smthrs/control/Control"
import type { ApprovalPayload, PlanCard } from "@smthrs/control/ControlSchema"
import { Effect, type Scope } from "effect"
import type * as GatewayProjection from "../src/GatewayProjection.ts"
import { Projections } from "../src/Projections.ts"
import { defaultCadenceStack, emit, stack } from "./GatewayStack.ts"

const approvalOf = (card: PlanCard): ApprovalPayload => ({
  target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

/** Plans, approves, and starts one run; returns its id. */
const launch = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: { suite: "gateway" } })
  yield* control.approve(approvalOf(card))
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected an accepted run")
  return receipt.runId
})

const askPayload = (runId: string, requestId: string): ApprovalPayload => ({
  target: {
    _tag: "Node",
    runId,
    requestId,
    digest: `digest-${requestId}`,
    envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} }
  },
  scope: "run",
  idempotencyKey: `approve:${requestId}`
})

const test = <E>(title: string, body: () => Effect.Effect<void, E, Scope.Scope>) =>
  it(title, () => Effect.runPromise(Effect.scoped(body())))

describe("gateway projections over a real SQLite control plane", () => {
  test("projects an approval request into a pending row carrying its decision payload", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      yield* emit(runId, "control.approval.requested", {
        runId,
        requestId: "gate-1",
        question: "Ship it?",
        payload: askPayload(runId, "gate-1")
      })

      const rows = (yield* projections.snapshot({ _tag: "approvals", runId }))
        .rows as ReadonlyArray<GatewayProjection.ApprovalRow>
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ runId, requestId: "gate-1", title: "Ship it?", status: "pending" })
      // The row carries the submit-ready envelope, so a client decides the
      // gate by handing this payload back rather than rebuilding authority.
      expect(rows[0]?.payload).toMatchObject({
        scope: "run",
        target: { _tag: "Node", runId, requestId: "gate-1" }
      })
    }).pipe(Effect.provide(stack())))

  test("clears a pending approval on a decision without discarding the request", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      yield* emit(runId, "control.approval.requested", {
        runId,
        requestId: "gate-2",
        question: "Ship it?",
        payload: askPayload(runId, "gate-2")
      })
      const pending = (yield* projections.snapshot({ _tag: "approvals", runId })).rows as ReadonlyArray<
        GatewayProjection.ApprovalRow
      >
      expect(pending.map((row) => row.status)).toEqual(["pending"])

      yield* emit(runId, "control.approval.approved", { runId, requestId: "gate-2", scope: "run" })
      const decided = (yield* projections.snapshot({ _tag: "approvals", runId })).rows as ReadonlyArray<
        GatewayProjection.ApprovalRow
      >
      expect(decided.map((row) => row.status)).toEqual(["approved"])
      // The decision event carries no question, so the projection kept the
      // request rather than nulling it.
      expect(decided[0]?.title).toBe("Ship it?")

      const events = (yield* projections.snapshot({ _tag: "run-events", runId })).rows
      // The raw event projection is the same ordered stream every fold reads.
      expect(events.length).toBeGreaterThan(0)

      const inbox = (yield* projections.snapshot({ _tag: "approvals" })).rows
      // The run is not parked, so the workspace inbox — which is scoped to
      // waiting-approval runs — does not carry a decided gate.
      expect(inbox).toHaveLength(0)
    }).pipe(Effect.provide(stack())))

  test("records a cancellation's source, reason, and principal on the run row", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const control = yield* Control
      const runId = yield* launch
      yield* control.cancel({
        runId,
        idempotencyKey: `cancel:${runId}`,
        reason: "worker received SIGTERM",
        principal: { id: "operator", kind: "cli", stampedAt: 1 }
      })

      const rows = (yield* projections.snapshot({ _tag: "run-summary", runId })).rows as ReadonlyArray<
        GatewayProjection.RunSummaryRow
      >
      expect(rows[0]?.cancellation).toMatchObject({
        source: "control",
        reason: "worker received SIGTERM",
        principal: { id: "operator", kind: "cli" }
      })
    }).pipe(Effect.provide(stack())))

  test("diagnoses a run from its own events and addresses one node's output", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      yield* emit(runId, "control.agent.turn-opened", { runId, seat: "opus", at: 1_000 })
      yield* emit(runId, "control.agent.cell-call-started", {
        runId,
        nodeId: "task",
        flowName: "write",
        at: 1_100
      })
      yield* emit(runId, "control.agent.cell-call-settled", {
        runId,
        nodeId: "task",
        flowName: "write",
        outcome: "success",
        value: "wrote src/index.ts",
        at: 1_200
      })
      yield* emit(runId, "control.agent.model-settled", {
        runId,
        usage: { inputTokens: 120, outputTokens: 34 },
        at: 1_300
      })
      yield* emit(runId, "control.run.completed", { runId, at: 1_400 })

      const summary = ((yield* projections.snapshot({ _tag: "run-summary", runId })).rows as ReadonlyArray<
        GatewayProjection.RunSummaryRow
      >)[0]
      expect(summary?.seat).toBe("opus")
      expect(summary?.turns).toBe(1)
      expect(summary?.editsSucceeded).toBe(1)
      expect(summary?.inputTokens).toBe(120)
      expect(summary?.verdict).toBe("completed")
      expect(summary?.diagnosis).toContain("Verdict")
      expect(summary?.diagnosis).toContain(runId)

      const tree = (yield* projections.snapshot({ _tag: "run-tree", runId })).rows as ReadonlyArray<
        GatewayProjection.RunTreeRow
      >
      expect(tree).toMatchObject([{ nodeId: "task", label: "write", status: "completed", seat: "opus" }])

      const output = (yield* projections.snapshot({ _tag: "node-output", runId, nodeId: "task" }))
        .rows as ReadonlyArray<GatewayProjection.NodeOutputRow>
      expect(output).toMatchObject([{ nodeId: "task", outcome: "success", output: "wrote src/index.ts" }])

      const transcript = (yield* projections.snapshot({ _tag: "transcript", runId })).rows as ReadonlyArray<
        GatewayProjection.TranscriptRow
      >
      expect(transcript.map((row) => row.kind)).toContain("control.agent.turn-opened")
      expect(transcript.every((row) => row.runId === runId)).toBe(true)
    }).pipe(Effect.provide(stack())))

  test("refuses a projection of a run the control plane does not have", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "run-summary", runId: "missing-run" }))
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toContain("missing-run")
    }).pipe(Effect.provide(stack())))

  test("refuses plan-cards, which planning returns rather than projecting", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "plan-cards" }))
      expect(failure.code).toBe("unsupported_projection")
    }).pipe(Effect.provide(stack())))

  test("lists every workspace run as a summary row", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      const rows = (yield* projections.snapshot({ _tag: "workspace-runs" })).rows as ReadonlyArray<
        GatewayProjection.RunSummaryRow
      >
      expect(rows.map((row) => row.runId)).toEqual([runId])
      expect(rows[0]?.flowId).toBe("system/test")
    }).pipe(Effect.provide(stack())))

  test("serves the same rows under the shipped keepalive cadence", () =>
    Effect.gen(function*() {
      // The default layer is what a host composes; the suites above pin the
      // rows under a short cadence, and this pins that the shipped one reads
      // the same control plane.
      const projections = yield* Projections
      const runId = yield* launch
      const rows = (yield* projections.snapshot({ _tag: "run-summary", runId })).rows
      expect(rows).toHaveLength(1)
    }).pipe(Effect.provide(defaultCadenceStack)))
})
