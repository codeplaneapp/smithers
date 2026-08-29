/**
 * `ControlLive.watch`: the finite snapshot, the followed tail, and the
 * deduplication that joins them.
 *
 * The snapshot pins its own high-water mark with indexed probes, so the
 * interesting cases are the ones a real journal reaches rarely — an empty
 * partition, a cursor already at the mark, the largest representable
 * sequence, and a page read that fails half way through.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Deferred, Effect, Fiber, Layer, PubSub, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { Unavailable } from "../src/ControlError.ts"
import { ControlRuntime, type MemoryFlow } from "../src/ControlRuntime.ts"
import type { ControlEvent, Envelope } from "../src/ControlSchema.ts"
import { live, memoryRuntime, type Stack } from "./TestStack.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }

const flows: ReadonlyArray<MemoryFlow> = [
  { flowId: "system/test", description: "Reserved test system flow", deployClass: false, envelope }
]

const run = <A, E>(
  body: Effect.Effect<A, E, Stack>,
  stack: Layer.Layer<Stack> = live({ runtime: memoryRuntime({ flows }) })
): Promise<A> => Effect.runPromise(body.pipe(Effect.provide(stack), Effect.scoped, Effect.orDie))

/** Plans, approves, and starts one run, then flushes what it journaled. */
const start = (suffix: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const journal = yield* Journal.Journal
    const card = yield* control.plan({ flowId: "system/test", input: { suite: suffix } })
    yield* control.approve({ ...card.approval, idempotencyKey: `approve:${suffix}` })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${suffix}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a started run")
    yield* journal.flush
    return { card, runId: receipt.runId }
  })

/**
 * A committed journal row, optionally without the run it belongs to.
 *
 * `ControlEvent` declares `runId` optional, so the projection has to survive
 * an entry that carries none.
 */
const entry = (seq: number, runId?: string): JournalEvent.Entry =>
  ({
    ...(runId === undefined ? {} : { runId: JournalEvent.RunId.make(runId) }),
    seq: JournalEvent.Seq.make(seq),
    eventId: `event-${seq}`,
    sourceId: JournalEvent.SourceId.make("/control"),
    sourceSeq: JournalEvent.SourceSeq.make(seq),
    emittedAtMs: seq,
    eventType: "control.test",
    payload: { seq },
    meta: null
  }) as unknown as JournalEvent.Entry

const sequences = (events: ReadonlyArray<ControlEvent>): ReadonlyArray<number> => events.map((event) => event.sequence)

describe("ControlLive.watch failures", () => {
  it("reports a journal that cannot stream or page as an unavailable watch", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        return {
          followed: yield* Effect.flip(Stream.runCollect(control.watch({ runId: "run-1" }))),
          snapshot: yield* Effect.flip(Stream.runCollect(control.watch({ runId: "run-1", follow: false })))
        }
      }),
      live({
        runtime: memoryRuntime({ flows }),
        journal: Journal.layerNoop(),
        notifications: NotificationQueue.layerNoop()
      })
    )

    expect(observed.followed).toBeInstanceOf(Unavailable)
    expect((observed.followed as Unavailable).feature).toBe("watch")
    expect(observed.snapshot).toBeInstanceOf(Unavailable)
    expect((observed.snapshot as Unavailable).feature).toBe("watch")
  })

  it("reports a page read that fails after the high-water mark was pinned", async () => {
    const failingPages = Layer.effect(
      Journal.Journal,
      Effect.map(Journal.Journal, (journal) =>
        Journal.make({
          ...journal,
          // The probes that pin the tail read one row at a time; only the
          // snapshot's own paging asks for a full page.
          entries: (options) =>
            options.limit === 1024
              ? Effect.fail(new Journal.JournalError({ code: "unknown", message: "page read failed" }))
              : journal.entries(options)
        }))
    ).pipe(Layer.provide(TestJournal.layer()), Layer.orDie)

    const error = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const { runId } = yield* start("pages")
        return yield* Effect.flip(Stream.runCollect(control.watch({ runId, follow: false })))
      }),
      live({ runtime: memoryRuntime({ flows }), journal: failingPages })
    )

    expect(error).toBeInstanceOf(Unavailable)
    expect((error as Unavailable).feature).toBe("watch")
  })
})

describe("ControlLive.watch snapshots", () => {
  it("returns an empty snapshot for a partition with no entries at all", async () => {
    const events = await run(Effect.gen(function*() {
      const control = yield* Control
      return yield* Stream.runCollect(control.watch({ runId: "run-never-journaled", follow: false }))
    }))

    expect(events).toEqual([])
  })

  it("returns an empty snapshot when the cursor already sits at the high-water mark", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const { runId } = yield* start("cursor")
      const all = yield* Stream.runCollect(control.watch({ runId, follow: false }))
      const highWater = Math.max(...sequences(all))
      return {
        all,
        atMark: yield* Stream.runCollect(control.watch({ runId, follow: false, afterSequence: highWater })),
        beyondMark: yield* Stream.runCollect(control.watch({ runId, follow: false, afterSequence: highWater + 1 })),
        beforeMark: yield* Stream.runCollect(control.watch({ runId, follow: false, afterSequence: highWater - 1 })),
        highWater
      }
    }))

    expect(observed.all.length).toBeGreaterThan(1)
    expect(observed.atMark).toEqual([])
    expect(observed.beyondMark).toEqual([])
    // One before the mark is the boundary that still has something to replay.
    expect(sequences(observed.beforeMark)).toEqual([observed.highWater])
  })

  it("resolves a finite snapshot when the newest sequence is the largest representable one", async () => {
    const extremeJournal = Layer.succeed(
      Journal.Journal,
      Journal.makeNoop({
        entries: (options) =>
          Effect.succeed({
            entries: [
              options.after === undefined ? entry(1, "run-extreme") : entry(Number.MAX_SAFE_INTEGER, "run-extreme")
            ],
            hasMore: false
          })
      })
    )

    const events = await run(
      Effect.gen(function*() {
        const control = yield* Control
        return yield* Stream.runCollect(control.watch({ runId: "run-extreme", follow: false }))
      }),
      live({
        runtime: memoryRuntime({ flows }),
        journal: extremeJournal,
        notifications: NotificationQueue.layerNoop()
      })
    )

    // The probe stops the moment it sees the maximum sequence rather than
    // stepping past it, and the snapshot still terminates.
    expect(events).toEqual([
      { sequence: 1, kind: "control.test", runId: "run-extreme", occurredAt: 1, payload: { seq: 1 } }
    ])
  })

  it("covers every run and plan partition when no run is named", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const { card, runId } = yield* start("unscoped")
      const orphan = yield* control.plan({ flowId: "system/test", input: { suite: "orphan" } })
      const journal = yield* Journal.Journal
      yield* journal.flush
      const events = yield* Stream.runCollect(control.watch({ follow: false }))
      return { events, card, orphan, runId }
    }))

    const partitions = new Set(observed.events.map((event) => event.runId))
    expect(partitions).toEqual(
      new Set([
        `plan:${observed.card.planId}`,
        `plan:${observed.orphan.planId}`,
        observed.runId
      ])
    )
  })
})

describe("ControlLive.watch following", () => {
  it("merges every partition with the committed tail and reports each event once", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const journal = yield* Journal.Journal
      const { card, runId } = yield* start("follow")
      const collected = yield* control.watch({}).pipe(
        Stream.take(5),
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
      const events = yield* Fiber.join(collected).pipe(Effect.timeout("10 seconds"))
      return { events, card, runId }
    }))

    // Sequences are per partition, so identity is the pair. The tail and the
    // run's own partition both carry the new event; the reader sees it once.
    const keys = observed.events.map((event) => `${String(event.runId)}:${event.sequence}`)
    expect(new Set(keys).size).toBe(5)
    expect(keys).toContain(`plan:${observed.card.planId}:0`)
    expect(keys).toContain(`${observed.runId}:0`)
    expect(observed.events.at(-1)).toMatchObject({
      kind: "control.signal.delivered",
      runId: observed.runId
    })
  })

  it("forgets the oldest key once the deduplication window is full", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const subscribed = Deferred.makeUnsafe<void>()
        const published = yield* PubSub.unbounded<JournalEvent.Entry>()
        const scripted = Layer.succeed(
          Journal.Journal,
          Journal.makeNoop({
            changes: PubSub.subscribe(published).pipe(
              Effect.tap(() => Deferred.succeed(subscribed, undefined))
            ),
            stream: () => Stream.empty
          })
        )

        return yield* Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          // One plan, so the merge really does span a partition and the tail.
          yield* runtime.plan({ flowId: "system/test", input: { suite: "window" } })
          const collected = yield* control.watch({}).pipe(
            Stream.take(1026),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true })
          )
          yield* Deferred.await(subscribed)
          for (let seq = 1; seq <= 1025; seq++) {
            yield* PubSub.publish(published, entry(seq))
          }
          // Still inside the window: refused as a repeat.
          yield* PubSub.publish(published, entry(1025))
          // Evicted by the 1025th key: admitted again.
          yield* PubSub.publish(published, entry(1))
          return yield* Fiber.join(collected).pipe(Effect.timeout("20 seconds"))
        }).pipe(
          Effect.provide(live({
            runtime: memoryRuntime({ flows }),
            journal: scripted,
            notifications: NotificationQueue.layerNoop()
          }))
        )
      }).pipe(Effect.scoped, Effect.orDie)
    )

    expect(observed).toHaveLength(1026)
    expect(sequences(observed).slice(0, 3)).toEqual([1, 2, 3])
    expect(sequences(observed).slice(1023, 1025)).toEqual([1024, 1025])
    expect(observed.at(-1)?.sequence).toBe(1)
    // An entry with no run identifier still keys into the window.
    expect(observed.every((event) => event.runId === undefined)).toBe(true)
  })

  it("drops tail entries at or below the cursor the reader supplied", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const subscribed = Deferred.makeUnsafe<void>()
        const published = yield* PubSub.unbounded<JournalEvent.Entry>()
        const scripted = Layer.succeed(
          Journal.Journal,
          Journal.makeNoop({
            changes: PubSub.subscribe(published).pipe(
              Effect.tap(() => Deferred.succeed(subscribed, undefined))
            ),
            stream: () => Stream.empty
          })
        )

        return yield* Effect.gen(function*() {
          const control = yield* Control
          const collected = yield* control.watch({ afterSequence: 10 }).pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true })
          )
          yield* Deferred.await(subscribed)
          yield* PubSub.publish(published, entry(9, "run-1"))
          yield* PubSub.publish(published, entry(10, "run-1"))
          yield* PubSub.publish(published, entry(11, "run-1"))
          return yield* Fiber.join(collected).pipe(Effect.timeout("10 seconds"))
        }).pipe(
          Effect.provide(live({
            runtime: memoryRuntime({ flows }),
            journal: scripted,
            notifications: NotificationQueue.layerNoop()
          }))
        )
      }).pipe(Effect.scoped, Effect.orDie)
    )

    // The cursor is exclusive: 10 is already seen, 11 is the first new one.
    expect(sequences(observed)).toEqual([11])
  })
})
