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
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { ApprovalPayload, ApprovalTarget, PlanCard } from "@smthrs/control/ControlSchema"
import { Effect, Fiber, type Scope, Stream } from "effect"
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

const askTarget = (runId: string, requestId: string): Extract<ApprovalTarget, { readonly _tag: "Node" }> => ({
  _tag: "Node",
  runId,
  requestId,
  digest: `digest-${requestId}`,
  envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} }
})

const askPayload = (runId: string, requestId: string): ApprovalPayload => ({
  target: askTarget(runId, requestId),
  scope: "run",
  idempotencyKey: `approve:${requestId}`
})

/**
 * Parks a launched run on an approval, the way a run really parks: the ask is
 * registered with the control plane, journaled with the payload
 * `AgentSession.authorize` writes, and the run's status is moved to
 * `waiting-approval` through the same fenced transition `AgentSession.settle`
 * uses. Without the status write the run is not parked, and the workspace
 * inbox is scoped to parked runs.
 */
const parkOnApproval = (runId: string, requestId: string, question: string) =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime
    const payload = askPayload(runId, requestId)
    yield* runtime.registerApproval(askTarget(runId, requestId))
    yield* emit(runId, "control.approval.requested", { runId, requestId, question, payload })
    const fence = yield* runtime.claimFence(runId)
    yield* runtime.writeStatus(runId, fence, "waiting-approval")
    yield* emit(runId, "control.run.waiting-approval", { runId, status: "waiting-approval" })
    return payload
  })

const test = <E>(title: string, body: () => Effect.Effect<void, E, Scope.Scope>) =>
  it(title, () => Effect.runPromise(Effect.scoped(body())))

describe("gateway projections over a real SQLite control plane", () => {
  test("projects an approval request into a pending row carrying its decision payload", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      yield* parkOnApproval(runId, "gate-1", "Ship it?")

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

      // The workspace inbox is the same gate, reached the way an operator
      // reaches it: over every run the control plane reports as parked.
      const inbox = (yield* projections.snapshot({ _tag: "approvals" }))
        .rows as ReadonlyArray<GatewayProjection.ApprovalRow>
      expect(inbox).toMatchObject([{ runId, requestId: "gate-1", title: "Ship it?", status: "pending" }])
    }).pipe(Effect.provide(stack())))

  test("lists one pending gate per parked run and drops the one that was decided", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const control = yield* Control
      const first = yield* launch
      const second = yield* launch
      const decided = yield* parkOnApproval(first, "gate-a", "Merge?")
      yield* parkOnApproval(second, "gate-b", "Deploy?")

      const before = (yield* projections.snapshot({ _tag: "approvals" }))
        .rows as ReadonlyArray<GatewayProjection.ApprovalRow>
      expect(before.map((row) => row.requestId).sort()).toEqual(["gate-a", "gate-b"])

      yield* control.approve(decided)
      const after = (yield* projections.snapshot({ _tag: "approvals" }))
        .rows as ReadonlyArray<GatewayProjection.ApprovalRow>
      // The decided gate leaves the inbox; the other run is still waiting.
      expect(after.map((row) => row.requestId)).toEqual(["gate-b"])

      const closed = (yield* projections.snapshot({ _tag: "approvals", runId: first }))
        .rows as ReadonlyArray<GatewayProjection.ApprovalRow>
      // `ControlLive` journals the decision with `tokenId`, which for a Node
      // target is the request id, so the row it closed is the row it named.
      expect(closed).toMatchObject([{ requestId: "gate-a", status: "approved", title: "Merge?" }])
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

      yield* emit(runId, "control.approval.approved", {
        tokenId: "gate-2",
        target: "Node",
        scope: "run",
        envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} },
        principal: { id: "operator", kind: "cli", stampedAt: 1 }
      })
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
      // This run was never parked, so the workspace inbox, which is scoped to
      // the runs the control plane reports as waiting, does not list it.
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
      // Exactly the payloads `@smthrs/agent` `AgentSession` journals: no node
      // id, no run id, no stamp. The projection keys the call by the ordinal
      // it opened on, because that is all the emitter gives it.
      yield* emit(runId, "control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" })
      yield* emit(runId, "control.agent.cell-call-started", { flowName: "write", input: { path: "src/index.ts" } })
      yield* emit(runId, "control.agent.cell-call-settled", {
        flowName: "write",
        outcome: "success",
        value: "wrote src/index.ts"
      })
      yield* emit(runId, "control.agent.model-settled", {
        text: "done",
        usage: { inputTokens: 120, outputTokens: 34 },
        durationMillis: 42
      })
      // The run really finishes: the status moves under the run's own fence
      // and is journaled after it, which is the order `AgentSession.settle`
      // writes them in. The summary's status is the row's, so a fold that read
      // it off the journal alone would report the run's previous state.
      const runtime = yield* ControlRuntime
      const fence = yield* runtime.claimFence(runId)
      yield* runtime.writeStatus(runId, fence, "completed")
      yield* emit(runId, "control.run.completed", { runId, status: "completed" })

      const summary = ((yield* projections.snapshot({ _tag: "run-summary", runId })).rows as ReadonlyArray<
        GatewayProjection.RunSummaryRow
      >)[0]
      expect(summary?.seat).toBe("opus")
      expect(summary?.turns).toBe(1)
      expect(summary?.editsSucceeded).toBe(1)
      expect(summary?.inputTokens).toBe(120)
      expect(summary?.status).toBe("completed")
      expect(summary?.verdict).toBe("completed")
      expect(summary?.diagnosis).toContain("Verdict")
      expect(summary?.diagnosis).toContain(runId)

      const tree = (yield* projections.snapshot({ _tag: "run-tree", runId })).rows as ReadonlyArray<
        GatewayProjection.RunTreeRow
      >
      expect(tree).toMatchObject([{ nodeId: "call-1", label: "write", status: "completed", seat: "opus" }])

      const output = (yield* projections.snapshot({ _tag: "node-output", runId, nodeId: "call-1" }))
        .rows as ReadonlyArray<GatewayProjection.NodeOutputRow>
      expect(output).toMatchObject([{ nodeId: "call-1", outcome: "success", output: "wrote src/index.ts" }])

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

  test("sends one arrived event per run-events delta, never the log again", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      yield* emit(runId, "control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" })
      yield* emit(runId, "control.agent.model-settled", { text: "done", usage: {} })

      // A follower asked for what is new. Recomputing `run-events` re-read the
      // whole history and re-sent it on every frame, which is quadratic in run
      // length and is the opposite of following.
      const following = yield* Effect.forkChild(
        Stream.runCollect(
          Stream.take(
            Stream.filter(
              projections.subscribe({ _tag: "run-events", runId }),
              (frame) => frame._tag === "delta"
            ),
            1
          )
        )
      )
      yield* Effect.sleep("100 millis")
      yield* emit(runId, "control.run.completed", { runId, status: "completed" })
      const frames = yield* Fiber.join(following)

      const delta = frames[0]
      expect(delta?._tag).toBe("delta")
      if (delta?._tag !== "delta") return
      const rows = delta.delta as ReadonlyArray<{ readonly runId?: string; readonly kind: string }>
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ runId, kind: "control.run.completed" })

      // The snapshot of the same selector still carries the whole log, so the
      // delta is an addition to it and not a different projection.
      const snapshot = (yield* projections.snapshot({ _tag: "run-events", runId })).rows
      expect(snapshot.length).toBeGreaterThan(1)
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
