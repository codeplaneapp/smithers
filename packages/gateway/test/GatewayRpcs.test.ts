/**
 * The gateway's own remote procedures, against a real SQLite control plane.
 *
 * The remaining three requirements the old `packages/server` suite pinned live
 * here:
 *
 * - `server-resume-lifecycle`: approving a parked node resumes the run it
 *   parked, in ONE call. A product client never issues a second manual resume,
 *   because a lost second call is exactly the state a human reads as "I
 *   approved it and nothing happened".
 * - `index-run-lifecycle-coverage`: a launch that succeeds and a launch that
 *   fails both leave a readable run, not a hole.
 * - `xcombo-child-visibility-gateway`: a child run of a listed parent is
 *   itself listed, carrying the parent it came from.
 */
import { describe, expect, it } from "@effect/vitest"
import { Control } from "@smthrs/control/Control"
import { layerNoopAuth } from "@smthrs/control/ControlRpcs"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { ApprovalPayload, ApprovalTarget, PlanCard } from "@smthrs/control/ControlSchema"
import { RunStore } from "@smthrs/run-store"
import { Effect, Layer, type Scope, Stream } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import type * as GatewayProjection from "../src/GatewayProjection.ts"
import { GatewayRpcs } from "../src/GatewayRpcs.ts"
import * as GatewayServer from "../src/GatewayServer.ts"
import { Projections } from "../src/Projections.ts"
import { stack } from "./GatewayStack.ts"

const principal = { id: "gateway-test", kind: "test", stampedAt: 1 }

const approvalOf = (card: PlanCard): ApprovalPayload => ({
  target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

const launch = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: {} })
  yield* control.approve(approvalOf(card))
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
  return receipt.runId
})

/** The gateway's handlers over the real stack, reachable as an RPC client. */
const served = Layer.merge(GatewayServer.layerHandlers, layerNoopAuth(principal)).pipe(
  Layer.provideMerge(stack())
)

const test = <E>(title: string, body: () => Effect.Effect<void, E, Scope.Scope>) =>
  it(title, () => Effect.runPromise(Effect.scoped(body())))

describe("Approval.Submit", () => {
  test("approves a parked node and resumes its run in one call", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const runtime = yield* ControlRuntime
      const runId = yield* launch
      const target: ApprovalTarget = {
        _tag: "Node",
        runId,
        requestId: "gate",
        digest: "gate-digest",
        envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} }
      }
      // The run registers its gate and parks on it exactly as
      // `AgentSession.authorize` and `AgentSession.settle` do: the ask is
      // registered, then the run's status is moved under its own fence.
      yield* runtime.registerApproval(target)
      const fence = yield* runtime.claimFence(runId)
      yield* runtime.writeStatus(runId, fence, "waiting-approval")
      expect((yield* runtime.getRun(runId)).status).toBe("waiting-approval")

      const submitted = yield* rpc["Approval.Submit"]({
        target,
        scope: "run",
        idempotencyKey: "approve:gate",
        decision: "approve"
      })

      expect(submitted.decision._tag).toBe("Accepted")
      // One call, two mutations: the grant AND the restart. Nothing is left
      // for the client to remember to do.
      expect(submitted.resume).toBeDefined()
      // The run really left the parked state, which is the requirement
      // `server-resume-lifecycle` pinned: an approval that grants but never
      // restarts is the state a human reads as "nothing happened".
      expect((yield* runtime.getRun(runId)).status).not.toBe("waiting-approval")
      const events = yield* Stream.runCollect(
        (yield* Control).watch({ runId, follow: false })
      )
      // `Control.resume` journals `control.run.resume`, which is an operation
      // and not a status. The verdict must still read the run's own status:
      // folding a status off the `control.run.` prefix made it read "resume".
      expect(events.map((event) => event.kind)).toContain("control.run.resume")
      const summary = ((yield* (yield* Projections).snapshot({ _tag: "run-summary", runId }))
        .rows as ReadonlyArray<GatewayProjection.RunSummaryRow>)[0]
      const resumed = yield* runtime.getRun(runId)
      expect(summary?.verdict).toBe(resumed.status)
      expect(summary?.status).toBe(resumed.status)
    }).pipe(Effect.provide(served)))

  test("denies a gate without resuming the run it parked", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const runtime = yield* ControlRuntime
      const runId = yield* launch
      const target: ApprovalTarget = {
        _tag: "Node",
        runId,
        requestId: "denied-gate",
        digest: "denied-digest",
        envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} }
      }
      yield* runtime.registerApproval(target)
      const fence = yield* runtime.claimFence(runId)
      yield* runtime.writeStatus(runId, fence, "waiting-approval")

      const submitted = yield* rpc["Approval.Submit"]({
        target,
        scope: "run",
        idempotencyKey: "deny:gate",
        decision: "deny"
      })

      expect(submitted.decision._tag).toBe("Accepted")
      // A denial means the run stays where it is.
      expect(submitted.resume).toBeUndefined()
      expect((yield* runtime.getRun(runId)).status).toBe("waiting-approval")
    }).pipe(Effect.provide(served)))

  test("approves a plan without a run to resume", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })

      const submitted = yield* rpc["Approval.Submit"]({
        target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
        scope: "run",
        idempotencyKey: `approve:${card.planId}`,
        decision: "approve"
      })

      expect(submitted.decision._tag).toBe("Accepted")
      expect(submitted.resume).toBeUndefined()
    }).pipe(Effect.provide(served)))

  test("denies a plan, which has no run to resume either way", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })

      const submitted = yield* rpc["Approval.Submit"]({
        target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
        scope: "run",
        idempotencyKey: `deny:${card.planId}`,
        decision: "deny"
      })

      expect(submitted.decision._tag).toBe("Accepted")
      expect(submitted.resume).toBeUndefined()
    }).pipe(Effect.provide(served)))
})

describe("Projection.Snapshot and Projection.Subscribe", () => {
  test("answers a snapshot with the rows and the cursor they were read at", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const runId = yield* launch
      const snapshot = yield* rpc["Projection.Snapshot"]({ selector: { _tag: "run-summary", runId } })
      expect(snapshot.cursor).toMatchObject({ projection: "run-summary", runId })
      expect(snapshot.rows).toHaveLength(1)
    }).pipe(Effect.provide(served)))

  test("streams a subscription's snapshot frames through the RPC group", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const runId = yield* launch
      const frames = yield* Stream.runCollect(
        Stream.take(rpc["Projection.Subscribe"]({ selector: { _tag: "run-summary", runId } }), 3)
      )
      expect(frames.map((frame) => frame._tag)).toEqual(["snapshot-start", "row", "snapshot-end"])
    }).pipe(Effect.provide(served)))

  test("refuses a projection of an unknown run with a typed gateway error", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const failure = yield* Effect.flip(
        rpc["Projection.Snapshot"]({ selector: { _tag: "run-summary", runId: "nope" } })
      )
      expect(failure.code).toBe("run_unavailable")
    }).pipe(Effect.provide(served)))
})

describe("run visibility", () => {
  test("lists a child run beside the parent it came from", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runs = yield* RunStore.RunStore
      const parentRunId = yield* launch
      // A child run is a run the engine created under a parent. Whatever
      // created it, the ordinary listing every run surface renders must show
      // it — a child that only a debug escape hatch can see is a child a human
      // cannot reach.
      yield* runs.create(`${parentRunId}:child`, "{}", { parentRunId })

      const rows = (yield* projections.snapshot({ _tag: "workspace-runs" })).rows as ReadonlyArray<
        GatewayProjection.RunSummaryRow
      >
      const child = rows.find((row) => row.runId === `${parentRunId}:child`)
      expect(rows.map((row) => row.runId)).toContain(parentRunId)
      expect(child).toBeDefined()
      expect(child?.parentRunId).toBe(parentRunId)
    }).pipe(Effect.provide(served)))

  test("keeps a run readable after a launch the executor refused", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      // The noop executor takes nothing, so the run stays pending rather than
      // running. It is still a run, still listed, and still diagnosable — a
      // refused launch must not leave a hole where a run should be.
      const rows = (yield* projections.snapshot({ _tag: "run-summary", runId })).rows as ReadonlyArray<
        GatewayProjection.RunSummaryRow
      >
      expect(rows[0]?.runId).toBe(runId)
      expect(rows[0]?.diagnosis).toContain("Verdict")
    }).pipe(Effect.provide(served)))
})
