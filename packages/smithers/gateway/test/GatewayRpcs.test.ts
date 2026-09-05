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
import * as ApprovalAuthority from "@smthrs/control/ApprovalAuthority"
import { Control } from "@smthrs/control/Control"
import { layerNoopAuth } from "@smthrs/control/ControlRpcs"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { ApprovalPayload, ApprovalTarget, PlanCard } from "@smthrs/control/ControlSchema"
import { RunStore } from "@smthrs/run-store"
import { Effect, Fiber, Layer, Schema, type Scope, Stream } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import type * as GatewayProjection from "../src/GatewayProjection.ts"
import { GatewayRpcs, SubmitApprovalOutput } from "../src/GatewayRpcs.ts"
import * as GatewayServer from "../src/GatewayServer.ts"
import { Projections } from "../src/Projections.ts"
import { driverFence, emit, stack } from "./GatewayStack.ts"

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
  Layer.provideMerge(stack({
    approvalAuthority: Effect.runSync(ApprovalAuthority.make([
      {
        principal: { id: "local", kind: "operator" },
        scopes: ["once", "run", "remembered"],
        targets: ["Plan", "Node"]
      },
      {
        principal: { id: principal.id, kind: principal.kind },
        scopes: ["once", "run", "remembered"],
        targets: ["Plan", "Node"]
      }
    ]))
  }))
)

const test = <E>(title: string, body: () => Effect.Effect<void, E, Scope.Scope>) =>
  it(title, () => Effect.runPromise(Effect.scoped(body())))

describe("Approval.Submit", () => {
  test("delegates one durable resume when a parked node is approved", () =>
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
      const fence = yield* driverFence(runId)
      yield* runtime.writeStatus(runId, fence, "waiting-approval")
      expect((yield* runtime.getRun(runId)).status).toBe("waiting-approval")

      const submitted = yield* rpc["Approval.Submit"]({
        target,
        scope: "run",
        idempotencyKey: "approve:gate",
        decision: "approve"
      })

      expect(submitted.decision._tag).toBe("Accepted")
      const encoded = Schema.encodeUnknownSync(SubmitApprovalOutput)(submitted)
      expect(Object.keys(encoded)).toEqual(["decision"])
      expect(encoded).toEqual({ decision: submitted.decision })
      // This fixture's executor owns no engine row. Control therefore leaves
      // the row parked and records a durable delegation for its real host.
      expect((yield* runtime.getRun(runId)).status).toBe("waiting-approval")
      expect((yield* runtime.pendingResumes).map((entry) => entry.runId)).toEqual([runId])
      const events = yield* Stream.runCollect(
        (yield* Control).watch({ runId, follow: false })
      )
      const kinds = events.map((event) => event.kind)
      expect(kinds.filter((kind) => kind === "control.run.resumed")).toHaveLength(1)
      expect(kinds).not.toContain("control.run.resume")
      const summary = ((yield* (yield* Projections).snapshot({ _tag: "run-summary", runId }))
        .rows as ReadonlyArray<GatewayProjection.RunSummaryRow>)[0]
      const resumed = yield* runtime.getRun(runId)
      expect(summary?.status).toBe(resumed.status)
      expect(summary?.verdict).toContain(resumed.status)
    }).pipe(Effect.provide(served)))

  test("delegates one durable resume when a gate is denied", () =>
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
      const fence = yield* driverFence(runId)
      yield* runtime.writeStatus(runId, fence, "waiting-approval")

      const submitted = yield* rpc["Approval.Submit"]({
        target,
        scope: "run",
        idempotencyKey: "deny:gate",
        decision: "deny"
      })

      expect(submitted.decision._tag).toBe("Accepted")
      expect((yield* runtime.getRun(runId)).status).toBe("waiting-approval")
      expect((yield* runtime.pendingResumes).map((entry) => entry.runId)).toEqual([runId])
      const events = yield* Stream.runCollect((yield* Control).watch({ runId, follow: false }))
      expect(events.map((event) => event.kind).filter((kind) => kind === "control.run.resumed"))
        .toHaveLength(1)
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
    }).pipe(Effect.provide(served)))

  /**
   * `Approval.Submit` is a control mutation wearing a gateway payload, and the
   * decision it records is the one an operator is answerable for. The
   * composition here defaults to `local`/`operator` and the middleware
   * authenticates `gateway-test`, so a handler that never read
   * `ControlPrincipal` writes the wrong name into the journal.
   */
  test("journals the authenticated principal rather than the runtime's default", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })

      yield* rpc["Approval.Submit"]({
        target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
        scope: "run",
        idempotencyKey: `attributed:${card.planId}`,
        decision: "approve"
      })

      const events = yield* Stream.runCollect(control.watch({ runId: `plan:${card.planId}`, follow: false }))
      const decided = events.find((event) => event.kind === "control.approval.approved")
      expect((decided?.payload as { readonly principal?: unknown } | null)?.principal)
        .toMatchObject({ id: "gateway-test", kind: "test" })
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
    }).pipe(Effect.provide(served)))

  /**
   * The typed failures the mount declares, produced over the wire rather than
   * asserted from the schema. A client writes one recovery per tag, so a tag
   * the mount cannot actually produce is a branch nobody's code will ever
   * reach, and a tag it produces as a defect is a branch nobody can catch.
   */
  test("answers a plan digest that does not match with PlanDigestMismatch", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })

      const failure = yield* Effect.flip(rpc["Approval.Submit"]({
        target: { _tag: "Plan", planId: card.planId, digest: "not-the-digest", envelope: card.envelope },
        scope: "run",
        idempotencyKey: `mismatch:${card.planId}`,
        decision: "approve"
      }))
      expect(failure._tag).toBe("/control/PlanDigestMismatch")
    }).pipe(Effect.provide(served)))

  test("answers a second decision on the same gate with AlreadyResolved", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      const target: ApprovalTarget = {
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope
      }

      yield* rpc["Approval.Submit"]({ target, scope: "run", idempotencyKey: "first", decision: "approve" })
      // A different idempotency key makes this a new command rather than a
      // replay of the accepted one, so the gate itself has to refuse it.
      const failure = yield* Effect.flip(
        rpc["Approval.Submit"]({ target, scope: "run", idempotencyKey: "second", decision: "deny" })
      )
      expect(failure._tag).toBe("/control/AlreadyResolved")
    }).pipe(Effect.provide(served)))

  test("answers a decision for a run that does not exist with RunNotFound", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const failure = yield* Effect.flip(rpc["Approval.Submit"]({
        target: {
          _tag: "Node",
          runId: "no-such-run",
          requestId: "gate",
          digest: "gate-digest",
          envelope: { capabilities: [], flows: [], budget: {} }
        },
        scope: "run",
        idempotencyKey: "missing-run",
        decision: "approve"
      }))
      expect(failure._tag).toBe("/control/RunNotFound")
    }).pipe(Effect.provide(served)))

  test("answers a decision for a plan that does not exist with PlanNotFound", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const failure = yield* Effect.flip(rpc["Approval.Submit"]({
        target: {
          _tag: "Plan",
          planId: "no-such-plan",
          digest: "plan-digest",
          envelope: { capabilities: [], flows: [], budget: {} }
        },
        scope: "run",
        idempotencyKey: "missing-plan",
        decision: "approve"
      }))
      expect(failure._tag).toBe("/control/PlanNotFound")
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

  test("passes a resume cursor through the subscription handler", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const runId = yield* launch
      const selector = { _tag: "run-events" as const, runId }
      const snapshot = yield* rpc["Projection.Snapshot"]({ selector })
      // A resumed subscription sends no snapshot frames, so the keepalive
      // channel is the only other thing on the stream: filter to the deltas.
      const following = yield* Effect.forkChild(
        Stream.runCollect(
          Stream.take(
            Stream.filter(
              rpc["Projection.Subscribe"]({ selector, after: snapshot.cursor }),
              (frame) => frame._tag === "delta"
            ),
            1
          )
        )
      )
      yield* Effect.sleep("100 millis")
      yield* emit(runId, "control.run.completed", { runId, status: "completed" })
      const frames = yield* Fiber.join(following)

      expect(frames.map((frame) => frame._tag)).toEqual(["delta"])
      expect(frames[0]?._tag === "delta" && frames[0].cursor.value).toBeGreaterThan(snapshot.cursor.value)
    }).pipe(Effect.provide(served)))

  test("refuses a projection of an unknown run with a typed gateway error", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const failure = yield* Effect.flip(
        rpc["Projection.Snapshot"]({ selector: { _tag: "run-summary", runId: "nope" } })
      )
      // A run the control plane does not have is not a backend failure, and a
      // client decides whether to retry on the difference.
      expect(failure.code).toBe("run_not_found")
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
      // it. A child that only a debug escape hatch can see is a child a human
      // cannot reach.
      //
      // The state the child is created with is an ENGINE-owned state, so it
      // carries the flow name every engine row carries
      // (`@smthrs/engine-store` `DurableEngineState`). `@smthrs/control`
      // decodes that column before it projects the row, so a placeholder `{}`
      // would fail the listing rather than exercise the listing.
      yield* runs.create(`${parentRunId}:child`, JSON.stringify({ flowName: "system/test" }), { parentRunId })

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
      // running. It is still a run, still listed, and still diagnosable. A
      // refused launch must not leave a hole where a run should be.
      const rows = (yield* projections.snapshot({ _tag: "run-summary", runId })).rows as ReadonlyArray<
        GatewayProjection.RunSummaryRow
      >
      expect(rows[0]?.runId).toBe(runId)
      expect(rows[0]?.diagnosis).toContain("Verdict")
    }).pipe(Effect.provide(served)))
})
