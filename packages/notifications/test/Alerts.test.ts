/**
 * Alert policy over a real journal: which conditions a run's entries leave
 * open, when a policy raises them, and what makes a delivery happen exactly
 * once across a crash.
 *
 * The delay half runs on the test clock and the durability half on the real
 * SQLite journal. Both are the point: a policy that fired immediately would
 * page on every transient stall, and a delivery that lived in memory would
 * page twice after a restart.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Alerts from "../src/Alerts.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const runId = "run-1"

const policy: Alerts.Policy = {
  defaults: { severity: "warning", owner: "oncall" },
  rules: {
    "waiting-approval": { afterMs: 60_000, runbook: "https://runbook/approvals" },
    stalled: { afterMs: 30_000, severity: "critical" }
  }
}

const entry = (
  seq: number,
  emittedAtMs: number,
  eventType: string,
  payload: Record<string, unknown>
): JournalEvent.Entry =>
  new JournalEvent.Entry({
    runId: JournalEvent.RunId.make(runId),
    seq: JournalEvent.Seq.make(seq),
    eventId: `event-${seq}`,
    sourceId: JournalEvent.SourceId.make("/test"),
    sourceSeq: JournalEvent.SourceSeq.make(seq),
    emittedAtMs,
    eventType,
    payload,
    meta: {}
  })

describe("Alerts.conditions", () => {
  it("opens a condition at the entry that first reported it", () => {
    const open = Alerts.conditions(policy, runId, [
      entry(1, 1_000, "control.run.accepted", { status: "accepted" }),
      entry(2, 5_000, "control.run.parked", { status: "waiting-approval" }),
      entry(3, 9_000, "control.run.parked", { status: "waiting-approval" })
    ])

    // The SECOND report does not restart the clock: the run has been waiting
    // since the first one.
    expect(open).toEqual([{ runId, condition: "waiting-approval", since: 5_000 }])
  })

  it("closes a condition when the same field reports something else", () => {
    const open = Alerts.conditions(policy, runId, [
      entry(1, 5_000, "control.run.parked", { status: "waiting-approval" }),
      entry(2, 7_000, "control.run.resume", { status: "running" })
    ])

    expect(open).toEqual([])
  })

  it("keeps one condition's entries from closing another's", () => {
    const open = Alerts.conditions(policy, runId, [
      entry(1, 5_000, "control.run.parked", { status: "waiting-approval" }),
      entry(2, 6_000, "control.monitor.beat", { health: "stalled" }),
      entry(3, 7_000, "control.monitor.beat", { health: "healthy" })
    ])

    // The beat that cleared the stall says nothing about the approval.
    expect(open).toEqual([{ runId, condition: "waiting-approval", since: 5_000 }])
  })

  it("ignores an entry that carries neither field", () => {
    const open = Alerts.conditions(policy, runId, [
      entry(1, 5_000, "control.run.parked", { status: "waiting-approval" }),
      entry(2, 6_000, "flows.engine.attempt-started", { action: "Review" })
    ])

    expect(open).toEqual([{ runId, condition: "waiting-approval", since: 5_000 }])
  })

  it("ignores a condition the policy has no rule for", () => {
    const open = Alerts.conditions(policy, runId, [entry(1, 5_000, "control.run.failed", { status: "failed" })])

    expect(open).toEqual([])
  })
})

describe("Alerts.decide", () => {
  const open: Alerts.Open = { runId, condition: "waiting-approval", since: 1_000 }

  it("raises nothing one millisecond before the delay elapses", () => {
    expect(Alerts.decide(policy, [open], 60_999)).toEqual([])
  })

  it("raises the alert the instant the delay elapses", () => {
    expect(Alerts.decide(policy, [open], 61_000)).toEqual([{
      runId,
      condition: "waiting-approval",
      since: 1_000,
      firedAt: 61_000,
      severity: "warning",
      owner: "oncall",
      runbook: "https://runbook/approvals",
      coalescingKey: "run-1:waiting-approval"
    }])
  })

  it("lets a rule override the policy's default severity", () => {
    const raised = Alerts.decide(policy, [{ runId, condition: "stalled", since: 0 }], 30_000)

    expect(raised.map((alert) => alert.severity)).toEqual(["critical"])
  })

  it("stamps the same firing time however late the tick that reads it runs", () => {
    // `firedAt` is the instant the condition outlived its delay, not the
    // instant a process happened to look. A tick an hour late has to raise the
    // byte-identical alert, because the admitted notification's id is stable
    // and the queue refuses a reused id with different content.
    const onTime = Alerts.decide(policy, [open], 61_000)
    const late = Alerts.decide(policy, [open], 3_661_000)

    expect(onTime).toEqual(late)
    expect(late.map((alert) => alert.firedAt)).toEqual([61_000])
  })
})

/** A sink the test drives: it fails until told to succeed, and counts sends. */
const controllableSink = () => {
  const sent: Array<Alerts.Alert> = []
  let outcome: "ok" | "fail" | "die" = "ok"
  const layer = Layer.succeed(Alerts.Sink)({
    deliver: (alert) =>
      Effect.suspend(() => {
        if (outcome === "die") return Effect.die(new Error("the notifier crashed"))
        if (outcome === "fail") return Effect.fail(new Alerts.AlertError({ message: "pager refused" }))
        sent.push(alert)
        return Effect.void
      })
  })
  return {
    layer,
    sent,
    set: (next: "ok" | "fail" | "die") => {
      outcome = next
    }
  }
}

const stack = (sink: Layer.Layer<Alerts.Sink>) =>
  Alerts.layer(policy).pipe(
    Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, sink)),
    Layer.provideMerge(TestJournal.layer()),
    Layer.provideMerge(TestClock.layer())
  )

/** Journals the entry a control plane writes when a run parks for approval. */
const parkForApproval = Effect.flatMap(Journal.Journal, (journal) =>
  journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId: JournalEvent.RunId.make(runId),
      sourceId: JournalEvent.SourceId.make("/control"),
      eventType: "control.run.parked",
      payload: { runId, status: "waiting-approval" }
    })
  ))

const resumed = Effect.flatMap(Journal.Journal, (journal) =>
  journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId: JournalEvent.RunId.make(runId),
      sourceId: JournalEvent.SourceId.make("/control"),
      eventType: "control.run.resume",
      payload: { runId, status: "running" }
    })
  ))

const countEntries = (eventType: string) =>
  Effect.flatMap(
    Journal.Journal,
    (journal) =>
      journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 }).pipe(
        Effect.map((page) => page.entries.filter((item) => item.eventType === eventType).length)
      )
  )

describe("Alerts.layer over a real journal", () => {
  it("stays quiet until the delay elapses and then admits one coalesced event", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        const queue = yield* NotificationQueue.NotificationQueue
        yield* parkForApproval
        yield* TestClock.adjust("59 seconds")
        const early = yield* alerts.tick(runId)
        const pendingEarly = yield* queue.pending(runId)
        yield* TestClock.adjust("1 second")
        const late = yield* alerts.tick(runId)
        return { early, pendingEarly, late, pending: yield* queue.pending(runId) }
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed.early.delivered).toEqual([])
    expect(observed.pendingEarly).toEqual([])
    expect(observed.late.delivered.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.pending).toHaveLength(1)
    expect(observed.pending[0]).toMatchObject({
      _tag: "system-event",
      delivery: "queue",
      coalescingKey: "run-1:waiting-approval",
      payload: { condition: "waiting-approval", severity: "warning", owner: "oncall" }
    })
    expect(sink.sent).toHaveLength(1)
  })

  it("never delivers the same alert twice, however often it ticks", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        const first = yield* alerts.tick(runId)
        const second = yield* alerts.tick(runId)
        const third = yield* alerts.tick(runId)
        return { first, second, third, delivered: yield* countEntries(Alerts.deliveredEventType) }
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed.first.delivered).toHaveLength(1)
    expect(observed.second.suppressed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.third.delivered).toEqual([])
    expect(observed.delivered).toBe(1)
    expect(sink.sent).toHaveLength(1)
  })

  it("stops alerting once the run resumes", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("30 seconds")
        yield* resumed
        yield* TestClock.adjust("5 minutes")
        return yield* alerts.tick(runId)
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed).toEqual({ delivered: [], failed: [], suppressed: [] })
    expect(sink.sent).toEqual([])
  })

  it("delivers once when the notifier crashes between the admission and the send", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        const queue = yield* NotificationQueue.NotificationQueue
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        // The admission committed; the process died before the page went out.
        sink.set("die")
        const crashed = yield* Effect.exit(alerts.tick(runId))
        const admittedAfterCrash = yield* countEntries("flows/notifications/Admitted")
        const deliveredAfterCrash = yield* countEntries(Alerts.deliveredEventType)
        // The replacement process ticks.
        sink.set("ok")
        const recovered = yield* alerts.tick(runId)
        return {
          crashed,
          admittedAfterCrash,
          deliveredAfterCrash,
          recovered,
          admitted: yield* countEntries("flows/notifications/Admitted"),
          delivered: yield* countEntries(Alerts.deliveredEventType),
          pending: yield* queue.pending(runId)
        }
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed.crashed._tag).toBe("Failure")
    expect(observed.admittedAfterCrash).toBe(1)
    expect(observed.deliveredAfterCrash).toBe(0)
    // The re-admission is idempotent on the alert id, so the crash cost a
    // duplicate admission the queue dropped, not a duplicate page.
    expect(observed.admitted).toBe(1)
    expect(observed.delivered).toBe(1)
    expect(observed.pending).toHaveLength(1)
    expect(observed.recovered.delivered).toHaveLength(1)
    expect(sink.sent).toHaveLength(1)
  })

  it("journals a refused delivery and retries it on the next tick", async () => {
    const sink = controllableSink()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        sink.set("fail")
        const refused = yield* alerts.tick(runId)
        const failedEntries = yield* countEntries(Alerts.failedEventType)
        const deliveredWhileFailing = yield* countEntries(Alerts.deliveredEventType)
        sink.set("ok")
        // The clock MOVES between the refusal and the retry, because in
        // production it always does. The retry re-admits the same alert id, so
        // an alert whose content varied with the reading time would be refused
        // by the queue as an idempotency conflict and never page at all.
        yield* TestClock.adjust("5 minutes")
        const retried = yield* alerts.tick(runId)
        return {
          refused,
          failedEntries,
          deliveredWhileFailing,
          retried,
          delivered: yield* countEntries(Alerts.deliveredEventType)
        }
      }).pipe(Effect.provide(stack(sink.layer)), Effect.scoped, Effect.orDie)
    )

    expect(observed.refused.failed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.refused.delivered).toEqual([])
    expect(observed.failedEntries).toBe(1)
    expect(observed.deliveredWhileFailing).toBe(0)
    // A refused page is not a delivered page, so the next tick tries again.
    expect(observed.retried.delivered).toHaveLength(1)
    expect(observed.delivered).toBe(1)
    expect(sink.sent).toHaveLength(1)
  })
})

/** Every request one webhook sink made, with its JSON body already decoded. */
interface Sent {
  readonly url: string
  readonly method: string
  readonly authorization: string | undefined
  readonly body: unknown
}

const decodeBody = (body: HttpBody.HttpBody): unknown =>
  body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode((body as HttpBody.Uint8Array).body)) as unknown
    : undefined

/**
 * A real `HttpClient` that answers with whatever the test scripts.
 *
 * The sink under test is the composition of `client.execute` with the status
 * rule, so a double for the client is the smallest thing that still exercises
 * the request the sink builds and the answer it interprets.
 */
const recordingClient = (
  answer: (attempt: number, request: HttpClientRequest.HttpClientRequest) => Response | HttpClientError.HttpClientError
) => {
  const sent: Array<Sent> = []
  const layer = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) => {
      const answered = answer(sent.length, request)
      sent.push({
        url: request.url,
        method: request.method,
        authorization: request.headers["authorization"],
        body: decodeBody(request.body)
      })
      return answered instanceof HttpClientError.HttpClientError
        ? Effect.fail(answered)
        : Effect.succeed(HttpClientResponse.fromWeb(request, answered))
    })
  )
  return { layer, sent }
}

const webhookStack = (
  answer: (attempt: number, request: HttpClientRequest.HttpClientRequest) => Response | HttpClientError.HttpClientError
) => {
  const client = recordingClient(answer)
  const sink = Alerts.layerWebhook({
    url: "https://pager.test/alerts",
    headers: { authorization: "Bearer token" }
  }).pipe(Layer.provide(client.layer))
  return { client, stack: stack(sink) }
}

describe("Alerts.layerWebhook", () => {
  it("posts the alert to the endpoint and calls a 2xx answer a delivery", async () => {
    const webhook = webhookStack(() => new Response("", { status: 202 }))
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        return { tick: yield* alerts.tick(runId), failed: yield* countEntries(Alerts.failedEventType) }
      }).pipe(Effect.provide(webhook.stack), Effect.scoped, Effect.orDie)
    )

    expect(observed.tick.delivered.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.failed).toBe(0)
    expect(webhook.client.sent).toHaveLength(1)
    expect(webhook.client.sent[0]).toMatchObject({
      url: "https://pager.test/alerts",
      method: "POST",
      authorization: "Bearer token"
    })
    expect(webhook.client.sent[0]?.body).toMatchObject({
      runId,
      condition: "waiting-approval",
      severity: "warning",
      owner: "oncall",
      runbook: "https://runbook/approvals"
    })
  })

  it("calls a non-2xx answer a refused page and retries it once the endpoint recovers", async () => {
    const webhook = webhookStack((attempt) => new Response("", { status: attempt === 0 ? 503 : 200 }))
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        const journal = yield* Journal.Journal
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        const refused = yield* alerts.tick(runId)
        const entries = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 })
        const retried = yield* alerts.tick(runId)
        return {
          refused,
          retried,
          detail: entries.entries.find((entry) => entry.eventType === Alerts.failedEventType)?.payload
        }
      }).pipe(Effect.provide(webhook.stack), Effect.scoped, Effect.orDie)
    )

    // A page nobody accepted is not a page that went out.
    expect(observed.refused.delivered).toEqual([])
    expect(observed.refused.failed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.detail).toMatchObject({ detail: "Alert webhook answered 503" })
    expect(observed.retried.delivered).toHaveLength(1)
    expect(webhook.client.sent).toHaveLength(2)
  })

  it("calls an unreachable endpoint a refused page", async () => {
    const webhook = webhookStack((_attempt, request) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "connect ECONNREFUSED" })
      })
    )
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        const journal = yield* Journal.Journal
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        const refused = yield* alerts.tick(runId)
        const entries = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 })
        return {
          refused,
          detail: entries.entries.find((entry) => entry.eventType === Alerts.failedEventType)?.payload
        }
      }).pipe(Effect.provide(webhook.stack), Effect.scoped, Effect.orDie)
    )

    expect(observed.refused.failed.map((alert) => alert.condition)).toEqual(["waiting-approval"])
    expect(observed.detail).toMatchObject({ detail: "Alert webhook could not be reached" })
  })

  it("sends nothing at all through the noop sink", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        return yield* alerts.tick(runId)
      }).pipe(Effect.provide(stack(Alerts.layerNoop)), Effect.scoped, Effect.orDie)
    )

    expect(observed.delivered).toHaveLength(1)
    expect(observed.failed).toEqual([])
  })
})

describe("Alerts.tick over a journal and a queue that can refuse", () => {
  it("reads a condition out of a journal longer than one page", async () => {
    // `entriesOf` pages at 512. A run whose journal is one page long would
    // never take the second read, and the condition that opened on entry 1
    // would be the only one the alerter could ever see.
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const alerts = yield* Alerts.AlertRuntime
        yield* Effect.forEach(
          Array.from({ length: 600 }, (_, index) => index),
          (index) =>
            journal.emitDurableUnfenced(
              new JournalEvent.Input({
                runId: JournalEvent.RunId.make(runId),
                sourceId: JournalEvent.SourceId.make("/control"),
                eventType: "control.run.progress",
                payload: { runId, beat: index }
              })
            ),
          { discard: true }
        )
        // The condition opens PAST the first page, so only a paged read finds it.
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        return yield* alerts.tick(runId)
      }).pipe(
        Effect.provide(
          Alerts.layer(policy).pipe(
            Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, Alerts.layerNoop)),
            Layer.provideMerge(TestJournal.layer({ capacity: 4096 })),
            Layer.provideMerge(TestClock.layer())
          )
        ),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.delivered.map((alert) => alert.condition)).toEqual(["waiting-approval"])
  })

  it("raises the queue's own refusal instead of calling it a journal failure", async () => {
    // A queue that will not take the admission is not the journal failing and
    // not the pager refusing. An operator reading `sink_failed` here would go
    // and check the webhook.
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        yield* TestClock.adjust("2 minutes")
        return yield* Effect.flip(alerts.tick(runId))
      }).pipe(
        Effect.provide(
          Alerts.layer(policy).pipe(
            Layer.provideMerge(Layer.mergeAll(NotificationQueue.layerNoop(), Alerts.layerNoop)),
            Layer.provideMerge(TestJournal.layer()),
            Layer.provideMerge(TestClock.layer())
          )
        ),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(failure._tag).toBe("/notifications/NotificationError")
  })
})

/** A policy that states delays and nothing else, plus one detector of its own. */
const bare: Alerts.Policy = {
  rules: {
    stalled: { afterMs: 0 },
    "condition-with-no-detector": { afterMs: 0 },
    "beat-only": { afterMs: 0 }
  },
  detectors: {
    "beat-only": { field: "health", value: "stalled", eventTypes: ["control.monitor.beat"] }
  }
}

describe("Alerts over a policy that states only delays", () => {
  it("skips an unreadable payload, a condition with no detector, and an entry the detector does not name", () => {
    const open = Alerts.conditions(bare, runId, [
      // A journal is written by whoever wrote it. A payload that is not a
      // record is not evidence about any condition.
      entry(1, 1_000, "control.monitor.beat", ["not", "a", "record"] as unknown as Record<string, unknown>),
      // `beat-only` names monitor beats, so a park saying the same thing is
      // not its evidence; the default `stalled` detector names no event types
      // and takes it.
      entry(2, 2_000, "control.run.parked", { health: "stalled" }),
      entry(3, 3_000, "control.monitor.beat", { health: "stalled" })
    ])

    expect(open).toEqual([
      { runId, condition: "stalled", since: 2_000 },
      { runId, condition: "beat-only", since: 3_000 }
    ])
  })

  it("raises nothing for a condition it has no rule for and falls back to a warning with no owner", () => {
    const raised = Alerts.decide(
      bare,
      [{ runId, condition: "stalled", since: 0 }, { runId, condition: "condition-nobody-declared", since: 0 }],
      1_000
    )

    expect(raised).toEqual([{
      runId,
      condition: "stalled",
      since: 0,
      firedAt: 0,
      severity: "warning",
      coalescingKey: `${runId}:stalled`
    }])
  })

  it("admits an ownerless alert and ignores a delivery record that names no alert", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const alerts = yield* Alerts.AlertRuntime
        const queue = yield* NotificationQueue.NotificationQueue
        // A delivery record with no alert id suppresses nothing: it is not
        // evidence that this alert, or any alert, went out.
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("/notifications/alerts/other"),
            eventType: Alerts.deliveredEventType,
            payload: { runId, condition: "stalled" }
          })
        )
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("/control"),
            eventType: "control.monitor.beat",
            payload: { runId, health: "stalled" }
          })
        )
        return { tick: yield* alerts.tick(runId), pending: yield* queue.pending(runId) }
      }).pipe(
        Effect.provide(
          Alerts.layer(bare).pipe(
            // No headers on the webhook: the sink posts the alert unadorned.
            Layer.provideMerge(
              Layer.mergeAll(
                NotificationQueue.layer,
                Alerts.layerWebhook({ url: "https://pager.test/bare" }).pipe(
                  Layer.provide(
                    Layer.succeed(HttpClient.HttpClient)(
                      HttpClient.make((request) =>
                        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 })))
                      )
                    )
                  )
                )
              )
            ),
            Layer.provideMerge(TestJournal.layer()),
            Layer.provideMerge(TestClock.layer())
          )
        ),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.tick.delivered.map((alert) => alert.condition)).toEqual(["stalled", "beat-only"])
    expect(observed.pending).toHaveLength(2)
    expect(observed.pending[0]?.payload).toEqual({
      condition: "stalled",
      severity: "warning",
      since: 0,
      firedAt: 0
    })
  })
})
