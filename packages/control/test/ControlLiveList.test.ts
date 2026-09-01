/**
 * `ControlLive` away from the happy path: paging and filtering a listing, the
 * decisions and mutations the shared contract does not exercise, and what each
 * collaborator's refusal is reported as.
 */
import { Journal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { InvalidInput, LaunchFailed, PersistenceError, PlanDenied } from "../src/ControlError.ts"
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
  it("pages valid flow listings and refuses sizes or cursors that cannot make progress", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      return {
        all: yield* control.list({ _tag: "flows" }),
        invalidLimits: yield* Effect.forEach([0, -1, 2.7, Number.NaN, Number.POSITIVE_INFINITY], (limit) =>
          control.list({ _tag: "flows", limit }).pipe(Effect.flip)),
        exact: yield* control.list({ _tag: "flows", limit: 3 }),
        tail: yield* control.list({ _tag: "flows", cursor: "2" }),
        beyond: yield* control.list({ _tag: "flows", cursor: "9" }),
        unparsable: yield* control.list({ _tag: "flows", cursor: "not-a-cursor" }).pipe(Effect.flip)
      }
    }))

    expect(items(observed.all)).toEqual(["system/test", "review/pull-request", "release/train"])
    for (const error of observed.invalidLimits) {
      expect(error).toBeInstanceOf(InvalidInput)
      expect((error as InvalidInput).code).toBe("invalid_input")
      expect((error as InvalidInput).issue).toContain("limit")
    }
    // A page that lands exactly on the end carries no next cursor.
    expect(observed.exact).not.toHaveProperty("nextCursor")
    expect(items(observed.tail)).toEqual(["release/train"])
    expect(observed.beyond).toEqual({ _tag: "flows", items: [] })
    expect(observed.unparsable).toBeInstanceOf(InvalidInput)
    expect((observed.unparsable as InvalidInput).issue).toContain("cursor")
  })

  it("bounds an omitted limit and walks every cursor to exhaustion without repeating one", async () => {
    const defaultPageSize = 100
    const catalog = Array.from({ length: defaultPageSize + 23 }, (_, index): MemoryFlow => ({
      flowId: `flow/${String(index).padStart(3, "0")}`,
      description: `Flow ${index}`,
      deployClass: false,
      envelope
    }))
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const first = yield* control.list({ _tag: "flows" })
        const pages: Array<ListResponse> = []
        const cursors: Array<readonly [string | undefined, string | undefined]> = []
        let cursor: string | undefined
        do {
          const current = cursor
          const listed = yield* control.list({ _tag: "flows", ...(cursor === undefined ? {} : { cursor }) })
          pages.push(listed)
          cursor = listed.nextCursor
          cursors.push([current, cursor])
        } while (cursor !== undefined && pages.length < 10)
        return { first, pages, cursors }
      }),
      live({ runtime: memoryRuntime({ flows: catalog }) })
    )

    expect(observed.first.items).toHaveLength(defaultPageSize)
    expect(observed.first.nextCursor).toBe(String(defaultPageSize))
    expect(observed.pages.flatMap(items)).toHaveLength(catalog.length)
    expect(new Set(observed.pages.flatMap(items)).size).toBe(catalog.length)
    expect(observed.cursors.every(([current, next]) => next === undefined || next !== current)).toBe(true)
    expect(observed.cursors.at(-1)?.[1]).toBeUndefined()
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

  it("uses the direct run lookup for a runId filter, including a missing run", async () => {
    let listRunsCalls = 0
    const guardedRuntime = Layer.effect(ControlRuntime)(
      Effect.map(ControlRuntime, (runtime) =>
        ControlRuntime.of({
          ...runtime,
          listRuns: Effect.sync(() => {
            listRunsCalls += 1
            throw new Error("listRuns must not serve an exact run lookup")
          })
        }))
    ).pipe(Layer.provide(memoryRuntime({ flows })))

    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const { runId } = yield* start("system/test", "direct-lookup")
        return {
          found: yield* control.list({ _tag: "runs", filters: { runId } }),
          missing: yield* control.list({ _tag: "runs", filters: { runId: "run-missing" } }),
          runId
        }
      }),
      live({ runtime: guardedRuntime })
    )

    expect(items(observed.found)).toEqual([observed.runId])
    expect(observed.missing).toEqual({ _tag: "runs", items: [] })
    expect(listRunsCalls).toBe(0)
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

  it("replays the same intent when object keys arrive in a different order", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId } = yield* start("system/test", "canonical-intent")
      const first = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload: { decision: "ship", score: 1 } },
        idempotencyKey: "signal:canonical"
      })
      const replay = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload: { score: 1, decision: "ship" } },
        idempotencyKey: "signal:canonical"
      })
      return { first, replay, delivered: yield* runtime.deliveredSignals(runId) }
    }))

    expect(observed.first._tag).toBe("Accepted")
    expect(observed.replay._tag).toBe("AlreadyApplied")
    expect(observed.delivered).toHaveLength(1)
  })

  it("treats a nested principal in signal data as caller intent", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId } = yield* start("system/test", "nested-principal")
      const first = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload: { principal: "alice" } },
        idempotencyKey: "signal:nested-principal"
      })
      const conflict = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload: { principal: "bob" } },
        idempotencyKey: "signal:nested-principal"
      })
      return { first, conflict, delivered: yield* runtime.deliveredSignals(runId) }
    }))

    expect(observed.first._tag).toBe("Accepted")
    expect(observed.conflict._tag).toBe("Conflict")
    expect(observed.delivered.map((signal) => signal.payload)).toEqual([{ principal: "alice" }])
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
    expect(observed.started).toBeInstanceOf(PlanDenied)
    expect((observed.started as PlanDenied).planId).toBe(observed.stored.card.planId)
  })

  it("answers Terminal on every run-verb resume replay after the run settled", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const { runId } = yield* start("system/test", "terminal-resume")
      yield* control.cancel({ runId, idempotencyKey: "cancel:resume" })
      const first = yield* control.run({ _tag: "Resume", runId, idempotencyKey: "rejoin:terminal" })
      const again = yield* control.run({ _tag: "Resume", runId, idempotencyKey: "rejoin:terminal" })
      return { first, again, runId }
    }))

    expect(observed.first).toEqual({ _tag: "Terminal", runId: observed.runId, status: "cancelled" })
    expect(observed.again).toEqual(observed.first)
  })

  it("journals a run-verb resume under the durable resume event kind", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const journal = yield* Journal.Journal
      const { runId } = yield* start("system/test", "resume-kind")
      yield* park(yield* ControlRuntime, runId)
      const receipt = yield* control.run({ _tag: "Resume", runId, idempotencyKey: "rejoin:kind" })
      yield* journal.flush
      const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
      return { receipt, runId, kinds: events.map((event) => event.kind) }
    }))

    expect(observed.receipt).toEqual({ _tag: "Accepted", receiptId: "rejoin:kind", runId: observed.runId })
    expect(observed.kinds).toContain("control.run.resume")
    expect(observed.kinds).not.toContain("control.run.resumed")
  })

  it("journals one creation when a keyed plan is replayed", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const journal = yield* Journal.Journal
      const input = { flowId: "system/test", input: { suite: "plan-replay" }, idempotencyKey: "plan:replay" }
      const first = yield* control.plan(input)
      const again = yield* control.plan(input)
      yield* journal.flush
      const events = yield* control.watch({ runId: `plan:${first.planId}`, follow: false }).pipe(Stream.runCollect)
      return { first, again, created: events.filter((event) => event.kind === "control.plan.created") }
    }))

    expect(observed.again).toEqual(observed.first)
    expect(observed.created).toHaveLength(1)
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

  it("refuses a steer whose embedded run id disagrees before admitting anything", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const notifications = yield* NotificationQueue.NotificationQueue
      const { runId } = yield* start("system/test", "steer-run-mismatch")
      const error = yield* control.steer({
        runId,
        message: { messageId: "steer-mismatch", runId: "run-someone-else", body: "stop", principal, createdAt: 1 },
        idempotencyKey: "steer:mismatch"
      }).pipe(Effect.flip)
      return { error, pending: yield* notifications.pending(runId) }
    }))

    expect(observed.error).toBeInstanceOf(InvalidInput)
    expect((observed.error as InvalidInput).code).toBe("invalid_input")
    expect((observed.error as InvalidInput).issue).toContain("message.runId")
    expect(observed.pending).toEqual([])
  })

  it("keeps the message's stated creation time on the enqueue record", async () => {
    // `steerItem` strips the control envelope before the message reaches the
    // queue, so the journal entry is the only place `createdAt` survives. It
    // is the caller's own statement, not a server stamp: over RPC the server's
    // clock is already on `message.principal.stampedAt`.
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const journal = yield* Journal.Journal
      const { runId } = yield* start("system/test", "steer-created-at")
      yield* control.steer({
        runId,
        message: { messageId: "steer-time", runId, body: "continue", principal, createdAt: 1712 },
        idempotencyKey: "steer:time"
      })
      yield* journal.flush
      const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
      return events.find((event) => event.kind === "control.steer.enqueued")
    }))

    expect(observed?.payload).toMatchObject({ messageId: "steer-time", createdAt: 1712 })
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
