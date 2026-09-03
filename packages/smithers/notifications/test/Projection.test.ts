import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.ts"
import * as NotificationEvent from "../src/NotificationEvent.ts"
import * as NotificationState from "../src/NotificationState.ts"
import * as Projection from "../src/Projection.ts"

const runId = "notification-projection" as JournalEvent.RunId
const sourceId = "notification-test" as JournalEvent.SourceId

const notification = (
  id: string,
  payload = id
): Notification => ({
  id,
  _tag: "human-followup",
  delivery: "queue",
  targetLineageId: "notification-projection/root",
  provenance: {
    sourceRunId: "source",
    sourceLineageId: "source/root",
    sourceTurn: 0,
    sourceActor: "test"
  },
  payload
})

const input = (eventType: string, payload: unknown): JournalEvent.Input =>
  new JournalEvent.Input(
    {
      runId,
      sourceId,
      eventType,
      payload
    },
    { disableChecks: true }
  )

const runJournal = <A, E>(effect: Effect.Effect<A, E, Journal.Journal>) =>
  effect.pipe(Effect.provide(TestJournal.layer()), Effect.scoped)

describe("Notification projection", () => {
  it("rejects malformed owned event payloads", () => {
    const malformedAdmitted = new JournalEvent.Entry({
      ...input(NotificationEvent.AdmittedEventType, {
        notification: { _tag: "human-followup", id: 1, payload: null },
        decision: "unknown"
      }),
      seq: 0 as JournalEvent.Seq,
      eventId: "malformed-admitted",
      sourceSeq: 0 as JournalEvent.SourceSeq,
      emittedAtMs: 0,
      meta: null
    })
    const malformedPromoted = new JournalEvent.Entry({
      ...input(NotificationEvent.PromotedEventType, {
        boundary: 1,
        ids: ["one", 2]
      }),
      seq: 1 as JournalEvent.Seq,
      eventId: "malformed-promoted",
      sourceSeq: 1 as JournalEvent.SourceSeq,
      emittedAtMs: 0,
      meta: null
    })

    expect(NotificationEvent.fromEntry(malformedAdmitted)._tag).toBe("None")
    expect(NotificationEvent.fromEntry(malformedPromoted)._tag).toBe("None")
  })

  it("replays admitted events to the same state as the pure fold", async () => {
    const notifications = [notification("one"), notification("two"), notification("three")]
    let expected = Projection.derive.initial
    for (let index = 0; index < notifications.length; index++) {
      expected = NotificationState.admit(expected, notifications[index]!, index).state
    }

    const states = await Effect.runPromise(
      runJournal(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* Effect.forEach(
            notifications,
            (value) =>
              journal.emitDurableUnfenced(
                input("flows/notifications/Admitted", {
                  notification: value,
                  decision: "admitted"
                })
              ),
            { discard: true }
          )
          yield* journal.flush
          return yield* journal.project(Projection.derive, { runId }).pipe(Stream.take(4), Stream.runCollect)
        })
      )
    )

    expect(states.at(-1)).toEqual(expected)
  })

  it("removes promoted notification ids during replay", async () => {
    const states = await Effect.runPromise(
      runJournal(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* journal.emitDurableUnfenced(
            input("flows/notifications/Admitted", {
              notification: notification("one"),
              decision: "admitted"
            })
          )
          yield* journal.emitDurableUnfenced(
            input("flows/notifications/Promoted", {
              boundary: "would-idle",
              targetLineageId: "notification-projection/root",
              ids: ["one"]
            })
          )
          yield* journal.flush
          return yield* journal.project(Projection.derive, { runId }).pipe(Stream.take(3), Stream.runCollect)
        })
      )
    )

    expect(states.at(-1)?.items).toEqual([])
  })

  it("ignores foreign events and records rejected admissions without queueing them", async () => {
    const states = await Effect.runPromise(
      runJournal(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* journal.emitDurableUnfenced(input("foreign", { value: true }))
          yield* journal.emitDurableUnfenced(
            input(NotificationEvent.AdmittedEventType, {
              notification: notification("full"),
              decision: "rejected-full"
            })
          )
          yield* journal.flush
          return yield* journal.project(Projection.derive, { runId }).pipe(Stream.take(3), Stream.runCollect)
        })
      )
    )
    expect(states.at(-1)?.items).toEqual([])
  })
})
