/**
 * `ControlLive` away from the happy path: paging and filtering a listing, the
 * decisions and mutations the shared contract does not exercise, and what each
 * collaborator's refusal is reported as.
 */
import { Journal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Effect, type Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { ClaimLost, LaunchFailed, PersistenceError } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime, type MemoryFlow } from "../src/ControlRuntime.ts"
import type { Envelope, ListResponse, Principal, Receipt } from "../src/ControlSchema.ts"
import { park } from "./Park.ts"
import { descriptor, live, memoryRuntime, type Stack } from "./TestStack.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }
const principal: Principal = { id: "operator", kind: "test", stampedAt: 1 }

/** Three flows, so a page boundary can be named exactly. */
const flows: ReadonlyArray<MemoryFlow> = [
  { flowId: "system/test", description: "Reserved test system flow", deployClass: false, envelope },
  { flowId: "review/pull-request", description: "Review a pull request.", deployClass: false, envelope },
  { flowId: "release/train", description: "Ship a release.", deployClass: true, envelope }
]

const run = <A, E>(
  body: Effect.Effect<A, E, Stack>,
  stack: Layer.Layer<Stack> = live({ runtime: memoryRuntime({ flows }) })
): Promise<A> => Effect.runPromise(body.pipe(Effect.provide(stack), Effect.scoped, Effect.orDie))

/** Plans, approves, and starts one run of `flowId`. */
const start = (flowId: string, suffix: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const card = yield* control.plan({ flowId, input: { suite: suffix } })
    yield* control.approve({ ...card.approval, idempotencyKey: `approve:${suffix}` })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${suffix}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a started run")
    return { card, runId: receipt.runId }
  })

const items = (listed: ListResponse): ReadonlyArray<string> =>
  listed._tag === "flows" ? listed.items.map((item) => item.flowId) : listed.items.map((item) => item.runId)

describe("ControlLive listings", () => {
  it("pages a flow listing at zero, mid-page, exactly-at-limit, and past the end", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      return {
        all: yield* control.list({ _tag: "flows" }),
        empty: yield* control.list({ _tag: "flows", limit: 0 }),
        negative: yield* control.list({ _tag: "flows", limit: -1 }),
        fractional: yield* control.list({ _tag: "flows", limit: 2.7 }),
        exact: yield* control.list({ _tag: "flows", limit: 3 }),
        tail: yield* control.list({ _tag: "flows", cursor: "2" }),
        beyond: yield* control.list({ _tag: "flows", cursor: "9" }),
        unparsable: yield* control.list({ _tag: "flows", cursor: "not-a-cursor" })
      }
    }))

    expect(items(observed.all)).toEqual(["system/test", "review/pull-request", "release/train"])
    // A zero-sized page still reports where the next one starts.
    expect(observed.empty).toEqual({ _tag: "flows", items: [], nextCursor: "0" })
    expect(observed.negative).toEqual({ _tag: "flows", items: [], nextCursor: "0" })
    expect(items(observed.fractional)).toEqual(["system/test", "review/pull-request"])
    expect(observed.fractional).toMatchObject({ nextCursor: "2" })
    // A page that lands exactly on the end carries no next cursor.
    expect(observed.exact).not.toHaveProperty("nextCursor")
    expect(items(observed.tail)).toEqual(["release/train"])
    expect(observed.beyond).toEqual({ _tag: "flows", items: [] })
    // An unparsable cursor restarts at the beginning rather than failing.
    expect(items(observed.unparsable)).toEqual(items(observed.all))
  })

  it("prefers the registry's descriptors over the runtime's catalog and pages them the same way", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        return {
          all: yield* control.list({ _tag: "flows" }),
          first: yield* control.list({ _tag: "flows", limit: 1 })
        }
      }),
      live({
        runtime: memoryRuntime({ flows }),
        registry: Registry.layerNoop({
          list: () =>
            Effect.succeed([
              descriptor("review/pull-request", "Review a pull request."),
              descriptor("release/train", "Ship a release.")
            ])
        })
      })
    )

    expect(observed.all).toEqual({
      _tag: "flows",
      items: [
        { flowId: "review/pull-request", description: "Review a pull request." },
        { flowId: "release/train", description: "Ship a release." }
      ]
    })
    expect(observed.first).toMatchObject({ nextCursor: "1" })
    expect(items(observed.first)).toEqual(["review/pull-request"])
  })

  it("filters runs by identifier, flow, and status, and combines them with paging", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const first = yield* start("system/test", "one")
      const second = yield* start("review/pull-request", "two")
      yield* park(yield* ControlRuntime, second.runId)
      return {
        byFlow: yield* control.list({ _tag: "runs", filters: { flowId: "review/pull-request" } }),
        byStatus: yield* control.list({ _tag: "runs", filters: { status: "accepted" } }),
        byAll: yield* control.list({
          _tag: "runs",
          filters: { runId: second.runId, flowId: "review/pull-request", status: "parked" }
        }),
        contradictory: yield* control.list({
          _tag: "runs",
          filters: { runId: first.runId, status: "parked" }
        }),
        paged: yield* control.list({ _tag: "runs", limit: 1 }),
        firstRunId: first.runId,
        secondRunId: second.runId
      }
    }))

    expect(items(observed.byFlow)).toEqual([observed.secondRunId])
    expect(items(observed.byStatus)).toEqual([observed.firstRunId])
    expect(items(observed.byAll)).toEqual([observed.secondRunId])
    // Filters intersect: a run matching one but not the other is excluded.
    expect(observed.contradictory).toEqual({ _tag: "runs", items: [] })
    expect(items(observed.paged)).toEqual([observed.firstRunId])
    expect(observed.paged).toMatchObject({ nextCursor: "1" })
  })
})

describe("ControlLive mutations", () => {
  it("reports a key reused for a different mutation as a conflict without applying it", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId } = yield* start("system/test", "conflict")
      const first = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload: null },
        idempotencyKey: "signal:key"
      })
      const conflict = yield* control.signal({
        runId,
        signal: { name: "rejected", payload: null },
        idempotencyKey: "signal:key"
      })
      const delivered = yield* runtime.deliveredSignals(runId)
      return { first, conflict, delivered }
    }))

    expect(observed.first._tag).toBe("Accepted")
    expect(observed.conflict).toEqual({
      _tag: "Conflict",
      message: "idempotency key signal:signal:key was used for another mutation"
    })
    expect(observed.delivered.map((signal) => signal.name)).toEqual(["reviewed"])
  })

  it("denies a plan without installing a grant and refuses to start it afterwards", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const card = yield* control.plan({ flowId: "system/test", input: { suite: "denied" } })
      const receipt = yield* control.deny({ ...card.approval, idempotencyKey: "deny:one" })
      const grants = yield* runtime.grants
      const stored = yield* runtime.getPlan(card.planId)
      const started = yield* Effect.flip(control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "run:denied"
      }))
      return { receipt, grants, stored, started }
    }))

    expect(observed.receipt).toEqual({ _tag: "Accepted", receiptId: "deny:one" })
    // Only an approval installs an envelope; a denial installs nothing.
    expect(observed.grants).toEqual([])
    expect(observed.stored.decision).toBe("denied")
    expect(observed.started).toBeInstanceOf(ClaimLost)
  })

  it("resumes a parked run through the run verb and reports a terminal one as terminal", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const { runId } = yield* start("system/test", "resume")
      yield* park(yield* ControlRuntime, runId)
      const resumed = yield* control.run({ _tag: "Resume", runId, idempotencyKey: "rejoin:resume" })
      const listed = yield* control.list({ _tag: "runs", filters: { runId } })
      yield* control.cancel({ runId, idempotencyKey: "cancel:resume" })
      const terminal = yield* control.run({ _tag: "Resume", runId, idempotencyKey: "rejoin:resume-again" })
      return { resumed, listed, terminal, runId }
    }))

    expect(observed.resumed).toEqual({ _tag: "Accepted", receiptId: "rejoin:resume", runId: observed.runId })
    expect(observed.listed).toMatchObject({ items: [{ status: "accepted" }] })
    expect(observed.terminal).toEqual({ _tag: "Terminal", runId: observed.runId, status: "cancelled" })
  })

  it("leaves a run pending when no executor is composed at all", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const journal = yield* Journal.Journal
        const { runId } = yield* start("system/test", "no-executor")
        yield* journal.flush
        const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
        const listed = yield* control.list({ _tag: "runs", filters: { runId } })
        return { events, listed }
      }),
      live({ runtime: memoryRuntime({ flows }), executor: "absent" })
    )

    // An absent acceptance port is not a failed launch: the run is recorded
    // as pending and stays where the executor would have picked it up.
    expect(observed.events.map((event) => event.kind)).toEqual([
      "control.run.accepted",
      "control.run.pending"
    ])
    expect(observed.listed).toMatchObject({ items: [{ status: "accepted" }] })
  })

  it("reports a refusing journal as a persistence failure naming the event it lost", async () => {
    const error = await run(
      Effect.gen(function*() {
        const control = yield* Control
        return yield* Effect.flip(control.plan({ flowId: "system/test", input: {} }))
      }),
      live({
        runtime: memoryRuntime({ flows }),
        journal: Journal.layerNoop(),
        notifications: NotificationQueue.layerNoop()
      })
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toBe("control.plan.created")
    expect((error as PersistenceError).message).toBe("Failed to persist control.plan.created")
  })

  it("reports a refusing notification queue as a persistence failure, not a lost steer", async () => {
    const error = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const { runId } = yield* start("system/test", "steer")
        return yield* Effect.flip(control.steer({
          runId,
          message: { messageId: "steer-1", runId, body: "", principal, createdAt: 1 },
          idempotencyKey: "steer:key"
        }))
      }),
      live({ runtime: memoryRuntime({ flows }), notifications: NotificationQueue.layerNoop() })
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toBe("control.steer.notification")
  })

  it("admits an empty steering body and keeps a second steer of the same run queued behind it", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const notifications = yield* NotificationQueue.NotificationQueue
      const { runId } = yield* start("system/test", "steering")
      const receipts: Array<Receipt> = []
      for (const body of ["", "second"]) {
        receipts.push(
          yield* control.steer({
            runId,
            message: { messageId: `steer-${body.length}`, runId, body, principal, createdAt: 1 },
            idempotencyKey: `steer:${body.length}`
          })
        )
      }
      const drained = yield* notifications.drain({
        runId,
        targetLineageId: runId,
        boundary: `${runId}/turn-1`,
        wouldIdle: false
      })
      return { receipts, drained }
    }))

    expect(observed.receipts.map((receipt) => receipt._tag)).toEqual(["Accepted", "Accepted"])
    expect(observed.drained.notifications.map((notification) => notification.payload)).toEqual([
      { kind: "Message", body: "" },
      { kind: "Message", body: "second" }
    ])
  })
})

describe("ControlLive executor acceptance", () => {
  it("surfaces an executor's refusal as a launch failure, and settles the run it recorded", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const failure = yield* Effect.flip(start("system/test", "refused"))
        const listed = yield* control.list({ _tag: "runs" })
        return { failure, listed }
      }),
      live({
        runtime: memoryRuntime({ flows }),
        executor: ControlExecutor.makeNoop({
          launch: Effect.fn("RefusingExecutor.launch")(({ run }) =>
            Effect.fail(new LaunchFailed({ runId: run.runId, message: "no capacity" }))
          )
        })
      })
    )

    expect(observed.failure).toBeInstanceOf(LaunchFailed)
    expect((observed.failure as LaunchFailed).message).toBe("no capacity")
    // The run row survives the refusal, because the acceptance decision is
    // separate from the record of the run having been accepted — but it
    // survives settled. Left `accepted`, it was a run nothing would ever drive
    // and nothing but `smithers cancel` could end (Phase 7 verdict
    // cd14388ed7).
    expect(observed.listed).toMatchObject({ items: [{ status: "failed" }] })
  })

  it("marks a run running only once the executor takes it, under its own fence", async () => {
    const accepted: Array<string> = []
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const journal = yield* Journal.Journal
        const { runId } = yield* start("system/test", "accepted")
        yield* journal.flush
        const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
        return { runId, events }
      }),
      live({
        runtime: memoryRuntime({ flows }),
        executor: ControlExecutor.makeNoop({
          launch: Effect.fn("AcceptingExecutor.launch")(({ plan, run }) =>
            Effect.sync(() => {
              accepted.push(`${plan.card.planId}:${run.runId}`)
              return "accepted" as const
            })
          )
        })
      })
    )

    expect(accepted).toEqual([`plan-1:${observed.runId}`])
    expect(observed.events.map((event) => event.kind)).toEqual([
      "control.run.accepted",
      "control.run.running"
    ])
  })
})
