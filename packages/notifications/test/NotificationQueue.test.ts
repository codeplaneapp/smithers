import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const item = (
  id: string,
  delivery: "steer" | "queue",
  targetLineageId = "run/root",
  body = id
): Notification => {
  const common = {
    id,
    targetLineageId,
    provenance: {
      sourceRunId: "operator",
      sourceLineageId: "operator/root",
      sourceTurn: 3,
      sourceActor: "human:will"
    },
    payload: { body }
  }
  return delivery === "steer"
    ? { _tag: "human-steer", delivery, ...common }
    : { _tag: "human-followup", delivery, ...common }
}

const run = <A, E>(
  effect: Effect.Effect<A, E, NotificationQueue.NotificationQueue>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(NotificationQueue.layer),
      Effect.provide(TestJournal.layer()),
      Effect.scoped
    )
  )

describe("NotificationQueue", () => {
  it("durably admits an id exactly once with provenance intact", async () => {
    const notification = item("n-1", "steer")
    const result = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const first = yield* queue.admit("run", notification)
        const retry = yield* queue.admit("run", notification)
        return { first, retry }
      })
    )

    expect(result.first).toMatchObject({ decision: "admitted", duplicate: false })
    expect(result.retry).toMatchObject({
      decision: "admitted",
      duplicate: true,
      seq: result.first.seq
    })
  })

  it("rejects reuse of a stable id for different content", async () => {
    const error = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", item("same", "steer", "run/root", "first"))
        return yield* queue.admit("run", item("same", "steer", "run/root", "second")).pipe(Effect.flip)
      })
    )

    expect(error.code).toBe("idempotency_conflict")
  })

  it("serializes concurrent admissions at the durable capacity", async () => {
    const result = await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const receipts = yield* Effect.all(
        Array.from({ length: 129 }, (_, index) => queue.admit("run", item(`n-${index}`, "steer"))),
        { concurrency: "unbounded" }
      )
      const drained = yield* queue.drain({
        runId: "run",
        targetLineageId: "run/root",
        boundary: "turn",
        wouldIdle: false
      })
      return { receipts, drained }
    }))

    expect(result.receipts.filter((receipt) => receipt.decision === "admitted")).toHaveLength(128)
    expect(result.receipts.filter((receipt) => receipt.decision === "rejected-full")).toHaveLength(1)
    expect(result.drained.notifications).toHaveLength(128)
  })

  it("targets lineage, batches steers, and promotes one queued follow-up only at idle", async () => {
    const result = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", item("root-steer", "steer"))
        yield* queue.admit("run", item("child-steer", "steer", "run/root/child"))
        yield* queue.admit("run", item("root-queued-1", "queue"))
        yield* queue.admit("run", item("root-queued-2", "queue"))

        const active = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "root/turn-1",
          wouldIdle: false
        })
        const child = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root/child",
          boundary: "child/turn-1",
          wouldIdle: false
        })
        const idle = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "root/turn-2",
          wouldIdle: true
        })
        const retry = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "root/turn-2",
          wouldIdle: true
        })
        return { active, child, idle, retry }
      })
    )

    expect(result.active.notifications.map(({ id }) => id)).toEqual(["root-steer"])
    expect(result.child.notifications.map(({ id }) => id)).toEqual(["child-steer"])
    expect(result.idle.notifications.map(({ id }) => id)).toEqual(["root-queued-1"])
    expect(result.retry.notifications.map(({ id }) => id)).toEqual(["root-queued-1"])
    expect(result.retry.duplicate).toBe(true)
  })

  it("provides a typed unavailable noop", async () => {
    const errors = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const admit = yield* queue.admit("run", item("noop", "steer")).pipe(Effect.flip)
        const drain = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "turn",
          wouldIdle: false
        }).pipe(Effect.flip)
        return [admit, drain]
      }).pipe(Effect.provide(NotificationQueue.layerNoop()))
    )
    expect(errors.map((error) => error.code)).toEqual([
      "notification_unavailable",
      "notification_unavailable"
    ])
  })

  it("pages through foreign journal history and ignores missing promoted ids", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const queue = yield* NotificationQueue.NotificationQueue
        yield* Effect.forEach(
          Array.from({ length: 513 }, (_, index) => index),
          (index) =>
            journal.emitDurableUnfenced(
              new JournalEvent.Input({
                runId: JournalEvent.RunId.make("run"),
                sourceId: JournalEvent.SourceId.make("foreign"),
                sourceSeq: JournalEvent.SourceSeq.make(index),
                eventType: "foreign",
                payload: { index }
              })
            ),
          { discard: true }
        )
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make("run"),
            sourceId: JournalEvent.SourceId.make("foreign-promotion"),
            sourceSeq: JournalEvent.SourceSeq.make(0),
            eventType: "flows/notifications/Promoted",
            payload: {
              boundary: "missing",
              targetLineageId: "run/root",
              ids: ["not-admitted"]
            }
          })
        )
        yield* journal.flush
        const missing = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "missing",
          wouldIdle: false
        })
        const arrayPayload = {
          ...item("array", "queue"),
          payload: [1, null, { keep: true }]
        } satisfies Notification
        const admission = yield* queue.admit("run", arrayPayload)
        const duplicate = yield* queue.admit("run", arrayPayload)
        const empty = yield* queue.drain({
          runId: "empty",
          targetLineageId: "empty/root",
          boundary: "empty/turn-1",
          wouldIdle: false
        })
        return { missing, admission, duplicate, empty }
      }).pipe(
        Effect.provide(NotificationQueue.layer),
        Effect.provide(TestJournal.layer()),
        Effect.scoped
      )
    )

    expect(result.missing.notifications).toEqual([])
    expect(result.admission.decision).toBe("admitted")
    expect(result.duplicate.duplicate).toBe(true)
    expect(result.empty.notifications).toEqual([])
  })
})
