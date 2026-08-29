/**
 * The `ControlLive` contract, as a suite any `ControlRuntime` must pass.
 *
 * The in-memory runtime and the durable one are two implementations of one
 * port, so the interesting assertions belong to neither. They live here and are
 * run against both — an adapter that only satisfies its own tests is how a
 * port silently forks into two behaviours.
 *
 * Contract source: `.smithers/tickets/control-runtime-engine-integration.md`.
 */
import { Journal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Cause, Effect, Exit, Fiber, type Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { type ApprovalInput, Control } from "../src/Control.ts"
import { AlreadyResolved, ClaimLost, EnvelopeMismatch, PlanDigestMismatch, RunNotFound } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { Envelope, PlanCard, Principal } from "../src/ControlSchema.ts"

/** Every service a contract test may reach for. */
export type Stack =
  | Control
  | ControlRuntime
  | Journal.Journal
  | NotificationQueue.NotificationQueue

/**
 * Builds a complete Control stack. It is a function so every test gets a fresh
 * database, and it takes an executor so the launch-acceptance test can observe
 * a real one.
 */
export type Harness = (executor?: ControlExecutor.Service | undefined) => Layer.Layer<Stack>

const approval = (
  card: PlanCard,
  idempotencyKey: string,
  envelope: Envelope = card.envelope
): ApprovalInput => ({
  target: {
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope
  },
  scope: card.approval.scope,
  idempotencyKey
})

const start = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({
    flowId: "system/test",
    input: { suite: "control" }
  })
  yield* control.approve(approval(card, `approve:${card.planId}`))
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
    return yield* Effect.die("expected an accepted run")
  }
  return { card, runId: receipt.runId }
})

/**
 * Registers the shared contract against one runtime.
 *
 * @param name the runtime under test, used as the describe block's title
 * @param harness builds a fresh Control stack per test
 */
export const contract = (name: string, harness: Harness): void => {
  const test = <E>(
    title: string,
    body: () => Effect.Effect<void, E, Stack>
  ) =>
    it(title, () =>
      Effect.runPromise(
        body().pipe(
          Effect.provide(harness()),
          Effect.scoped
        )
      ))

  describe(`ControlLive contract (${name})`, () => {
    test("plans, approves, and starts a stored decoded input", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const { card, runId } = yield* start
        const listed = yield* control.list({ _tag: "runs" })

        expect(card.flowId).toBe("system/test")
        expect(listed).toMatchObject({
          _tag: "runs",
          items: [{ runId, planId: card.planId, planDigest: card.digest, status: "accepted" }]
        })
      }))

    test("filters run listings to a matching run identifier", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const { runId } = yield* start
        const listed = yield* control.list({ _tag: "runs", filters: { runId } })

        expect(listed).toMatchObject({ _tag: "runs", items: [{ runId }] })
      }))

    test("returns an empty run listing for a missing run identifier", () =>
      Effect.gen(function*() {
        const control = yield* Control
        yield* start
        const listed = yield* control.list({ _tag: "runs", filters: { runId: "missing-run" } })

        expect(listed).toEqual({ _tag: "runs", items: [] })
      }))

    test("emits a complete approval payload and parks until it is resolved", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({
          flowId: "system/test",
          input: { suite: "gated" },
          idempotencyKey: "plan:gated"
        })
        const pending = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: card.approval.idempotencyKey
        })
        yield* control.approve(card.approval)
        const started = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: card.approval.idempotencyKey
        })

        expect(card.approval).toEqual({
          target: {
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope
          },
          scope: "run",
          idempotencyKey: "plan:gated"
        })
        expect(pending).toEqual({
          _tag: "Parked",
          receiptId: "plan:gated",
          planId: card.planId,
          status: "waiting-approval"
        })
        expect(started).toMatchObject({ _tag: "Accepted", receiptId: "plan:gated" })
      }))

    test("rejects a digest mismatch", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        const error = yield* control.approve({
          ...approval(card, "approve:digest"),
          target: { ...approval(card, "unused").target, digest: "wrong" }
        }).pipe(Effect.flip)

        expect(error).toBeInstanceOf(PlanDigestMismatch)
      }))

    test("exposes missing runtime state as typed failures", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const plan = yield* runtime.getPlan("missing").pipe(Effect.flip)
        const run = yield* runtime.getRun("missing").pipe(Effect.flip)
        const fence = yield* runtime.claimFence("missing").pipe(Effect.flip)
        const steer = yield* runtime.drainSteering("missing").pipe(Effect.flip)

        expect(plan).toBeInstanceOf(RunNotFound)
        expect(run).toBeInstanceOf(RunNotFound)
        expect(fence).toBeInstanceOf(RunNotFound)
        expect(steer).toBeInstanceOf(RunNotFound)
      }))

    test("rejects an envelope mismatch", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        const error = yield* control.approve(approval(card, "approve:envelope", {
          ...card.envelope,
          capabilities: ["fs:write"]
        })).pipe(Effect.flip)

        expect(error).toBeInstanceOf(EnvelopeMismatch)
      }))

    test("resolves approval exactly once and distinguishes replay from conflict", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        const input = approval(card, "approve:once")
        const first = yield* control.approve(input)
        const replay = yield* control.approve(input)
        const conflict = yield* control.deny(approval(card, "deny:after-approve")).pipe(Effect.flip)

        expect(first._tag).toBe("Accepted")
        expect(replay._tag).toBe("AlreadyApplied")
        expect(conflict).toBeInstanceOf(AlreadyResolved)
      }))

    test("installs the whole envelope as one grant before resolving the token", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const card = yield* control.plan({ flowId: "system/test", input: { suite: "grants" } })
        yield* control.approve(approval(card, "approve:grants"))
        const grants = yield* runtime.grants

        expect(grants).toMatchObject([{ tokenId: card.planId, scope: "run", envelope: card.envelope }])
      }))

    test("queues steering until a turn-boundary drain", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const notifications = yield* NotificationQueue.NotificationQueue
        const { runId } = yield* start
        const principal: Principal = { id: "operator", kind: "test", stampedAt: 1 }
        yield* control.steer({
          runId,
          message: {
            messageId: "steer-1",
            runId,
            body: "change course",
            principal,
            createdAt: 1
          },
          idempotencyKey: "steer:key"
        })

        const first = yield* notifications.drain({
          runId,
          targetLineageId: runId,
          boundary: `${runId}/turn-1`,
          wouldIdle: false
        })
        const second = yield* notifications.drain({
          runId,
          targetLineageId: runId,
          boundary: `${runId}/turn-2`,
          wouldIdle: false
        })
        expect(first.notifications).toMatchObject([{
          id: "steer-1",
          delivery: "steer",
          targetLineageId: runId,
          provenance: { sourceActor: "test:operator" },
          payload: { body: "change course" }
        }])
        expect(second.notifications).toEqual([])
      }))

    test("drains queued steering exactly once at a turn boundary", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        const principal: Principal = { id: "operator", kind: "test", stampedAt: 1 }
        yield* runtime.enqueueSteer(runId, {
          messageId: "steer-a",
          runId,
          body: "first",
          principal,
          createdAt: 1
        })
        yield* runtime.enqueueSteer(runId, {
          messageId: "steer-b",
          runId,
          body: "second",
          principal,
          createdAt: 2
        })
        const drained = yield* runtime.drainSteering(runId)
        const again = yield* runtime.drainSteering(runId)

        expect(drained.map((message) => message.messageId)).toEqual(["steer-a", "steer-b"])
        expect(again).toEqual([])
      }))

    test("registers an in-run approval token that approve turns into a grant", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        const envelope: Envelope = { capabilities: [], flows: ["ask"], budget: {} }
        const target = { _tag: "Node" as const, runId, requestId: "ask-1", digest: "ask-digest", envelope }

        // Registration is idempotent: every parked attempt re-registers.
        const first = yield* runtime.registerApproval(target)
        const again = yield* runtime.registerApproval(target)
        expect(first).toEqual({ tokenId: "ask-1", target, resolved: false })
        expect(again).toEqual(first)

        // A target that disagrees with what was registered is refused, exactly
        // as lookupApproval refuses it.
        const mismatched = yield* Effect.flip(runtime.registerApproval({ ...target, digest: "other" }))
        expect(mismatched).toBeInstanceOf(PlanDigestMismatch)

        // The public approve verb resolves the registered token and installs
        // the grant a resumed attempt reads its decision from.
        yield* control.approve({ target, scope: "run", idempotencyKey: "approve:ask-1" })
        const resolved = yield* runtime.registerApproval(target)
        expect(resolved.resolved).toBe(true)
        const grants = yield* runtime.grants
        expect(grants.some((grant) => grant.tokenId === "ask-1")).toBe(true)
      }))

    test("refuses to register an in-run approval against an unknown run", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const missing = yield* Effect.flip(runtime.registerApproval({
          _tag: "Node",
          runId: "run-unknown",
          requestId: "ask-x",
          digest: "ask-digest",
          envelope: { capabilities: [], flows: [], budget: {} }
        }))
        expect(missing).toBeInstanceOf(RunNotFound)
      }))

    it("reports running only after a real executor accepts the launch", async () => {
      const invoked: Array<string> = []
      const executor = ControlExecutor.make({
        launch: Effect.fn("ContractExecutor.launch")(({ run }) =>
          Effect.sync(() => {
            invoked.push(run.runId)
            return "accepted" as const
          })
        )
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const card = yield* control.plan({ flowId: "system/test", input: { executor: true } })
          yield* control.approve(approval(card, "approve:executor"))
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:executor"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected accepted receipt")
          }
          const events = yield* control.watch({ runId: receipt.runId }).pipe(
            Stream.take(2),
            Stream.runCollect
          )
          expect(invoked).toEqual([receipt.runId])
          expect(events.map((event) => event.kind)).toEqual(["control.run.accepted", "control.run.running"])
          const listed = yield* control.list({ _tag: "runs" })
          expect(listed).toMatchObject({ _tag: "runs", items: [{ runId: receipt.runId, status: "running" }] })
        }).pipe(
          Effect.provide(harness(executor)),
          Effect.scoped
        )
      )
    })

    test("delivers a signal without resuming a parked run", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        yield* control.pause({ runId, idempotencyKey: "pause:signal" })
        yield* control.signal({
          runId,
          signal: { name: "reviewed", payload: { ok: true } },
          idempotencyKey: "signal:key"
        })

        const listed = yield* control.list({ _tag: "runs" })
        const signals = yield* runtime.deliveredSignals(runId)
        expect(listed).toMatchObject({ _tag: "runs", items: [{ runId, status: "parked" }] })
        expect(signals).toEqual([{ name: "reviewed", payload: { ok: true } }])
      }))

    test("cancels by interrupting the owning Effect fiber", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        const owner = yield* Effect.never.pipe(Effect.forkChild({ startImmediately: true }))
        yield* runtime.registerFiber(runId, owner)
        const receipt = yield* control.cancel({ runId, idempotencyKey: "cancel:key" })
        const replay = yield* control.cancel({ runId, idempotencyKey: "cancel:key" })
        const exit = yield* Fiber.await(owner)

        expect(receipt).toEqual({ _tag: "Terminal", runId, status: "cancelled" })
        expect(replay).toEqual({ _tag: "AlreadyApplied", receiptId: "cancel:key", runId })
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }))

    test("releases ownership on pause, claims on resume, and rejects stale fences", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        const staleFence = yield* runtime.claimFence(runId)
        yield* control.pause({ runId, idempotencyKey: "pause:fence" })
        const pausedWrite = yield* runtime.writeStatus(runId, staleFence, "running").pipe(Effect.flip)
        const resumed = yield* control.resume({ runId, idempotencyKey: "resume:fence" })
        const resumedWrite = yield* runtime.writeStatus(runId, staleFence, "completed").pipe(Effect.flip)

        expect(pausedWrite).toBeInstanceOf(ClaimLost)
        expect(resumed._tag).toBe("Accepted")
        expect(resumedWrite).toBeInstanceOf(ClaimLost)
      }))

    test("accepts the fence it is currently holding", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        const fence = yield* runtime.claimFence(runId)
        const running = yield* runtime.writeStatus(runId, fence, "running")
        const completed = yield* runtime.writeStatus(runId, fence, "completed")
        const afterTerminal = yield* runtime.writeStatus(runId, fence, "running").pipe(Effect.flip)

        expect(running.status).toBe("running")
        expect(completed.status).toBe("completed")
        // A terminal run released ownership, so even the winning fence is spent.
        expect(afterTerminal).toBeInstanceOf(ClaimLost)
      }))

    test("resuming a terminal run reports the terminal state rather than reclaiming it", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        yield* control.cancel({ runId, idempotencyKey: "cancel:terminal" })
        const resumed = yield* runtime.resume(runId)

        expect(resumed.status).toBe("cancelled")
      }))

    test("watch replays after a cursor and then follows the committed tail", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const journal = yield* Journal.Journal
        const { runId } = yield* start
        yield* control.signal({
          runId,
          signal: { name: "before-watch", payload: null },
          idempotencyKey: "signal:before-watch"
        })
        yield* journal.flush

        const events = yield* control.watch({ runId, afterSequence: 0 }).pipe(
          Stream.filter((event) => event.kind === "control.signal.delivered"),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* control.signal({
          runId,
          signal: { name: "after-watch", payload: null },
          idempotencyKey: "signal:after-watch"
        })
        yield* journal.flush

        expect((yield* Fiber.join(events)).map((event) => event.kind)).toEqual([
          "control.signal.delivered",
          "control.signal.delivered"
        ])
      }))

    test("watch returns a finite durable snapshot when follow is false", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const journal = yield* Journal.Journal
        const { runId } = yield* start
        yield* control.signal({
          runId,
          signal: { name: "snapshot", payload: null },
          idempotencyKey: "signal:snapshot"
        })
        yield* journal.flush

        const events = yield* control.watch({ runId, follow: false }).pipe(
          Stream.runCollect,
          Effect.timeout("1 second")
        )

        expect(events.map((event) => event.kind)).toContain("control.signal.delivered")
      }))

    test("unscoped finite watch includes plan-only journal partitions", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: { snapshot: "plan-only" } })

        const events = yield* control.watch({ follow: false }).pipe(
          Stream.runCollect,
          Effect.timeout("1 second")
        )

        expect(events).toContainEqual(expect.objectContaining({
          kind: "control.plan.created",
          runId: `plan:${card.planId}`
        }))
        expect((yield* control.list({ _tag: "runs" })).items).toEqual([])
      }))
  })
}
