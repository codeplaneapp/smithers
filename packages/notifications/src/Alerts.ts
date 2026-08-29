/**
 * Alert policy: run conditions that have lasted too long, turned into durable,
 * coalesced, delivered-once notifications.
 *
 * A notification queue answers "tell this run something". An alert answers the
 * question nobody is around to ask: a run has been waiting for an approval for
 * an hour, and the person who could grant it does not know. The two are the
 * same machinery — an alert is admitted as a coalesced system event — and
 * differ only in who decides to write one.
 *
 * ## Journal time, not wall time
 *
 * A condition's clock starts at the journal entry that opened it, which makes
 * the decision replayable: the same journal produces the same alerts, whatever
 * process reads it and whenever. A restart re-derives every open condition
 * from the entries rather than from a timer it lost.
 *
 * ## Delivered at least once
 *
 * The admission is idempotent on the notification id, so re-admitting the same
 * alert writes nothing new, and `flows.alerts.delivered` is journaled AFTER
 * the sink accepted the page and is checked before the sink is called again.
 * That ordering is deliberate and it is the reason the guarantee is
 * at-least-once rather than exactly-once: a process that dies between the
 * accepted send and the delivery record has paged, left no evidence of it, and
 * will page again on the next tick. The alternative — recording the delivery
 * first — turns the same crash into a page nobody ever receives, which for an
 * alert is the worse failure.
 *
 * So the sink owns the last mile: {@link SinkService.deliver} MUST be
 * idempotent on {@link alertId}, which is stable for the life of one condition
 * and reaches the sink on every alert it is handed. A sink that fails journals
 * `flows.alerts.failed` and the alert is retried on the next tick, because a
 * refused page is not a delivered page.
 *
 * ## Conditions are data
 *
 * A condition is a payload field with a value: `status` is `waiting-approval`,
 * `health` is `stalled`. Those are the fields control-plane entries and monitor
 * beats already carry, so a deployment that journals a different vocabulary
 * supplies its own detectors instead of a fork of this module.
 *
 * @since 0.1.0
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import { Clock, Context, Effect, Layer, Result, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as NotificationModel from "./Notification.ts"
import { type NotificationError, NotificationQueue } from "./NotificationQueue.ts"

/**
 * The journal event type one delivered alert is recorded under.
 *
 * @category constants
 * @since 0.1.0
 */
export const deliveredEventType = "flows.alerts.delivered"

/**
 * The journal event type one failed delivery attempt is recorded under.
 *
 * @category constants
 * @since 0.1.0
 */
export const failedEventType = "flows.alerts.failed"

/**
 * How loud an alert is.
 *
 * @category models
 * @since 0.1.0
 */
export const Severity = Schema.Literals(["info", "warning", "critical"])

/**
 * How loud an alert is.
 *
 * @category models
 * @since 0.1.0
 */
export type Severity = typeof Severity.Type

/**
 * How a condition is recognized in the journal.
 *
 * `field` names a payload key, `value` the value that means the condition
 * holds, and `eventTypes` narrows which entries are consulted at all. An entry
 * that carries the field with a different value CLOSES the condition, which is
 * what makes a resume clear an approval alert without a second vocabulary for
 * "cleared".
 *
 * @category models
 * @since 0.1.0
 */
export const Detector = Schema.Struct({
  field: Schema.NonEmptyString,
  value: Schema.NonEmptyString,
  eventTypes: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

/**
 * How a condition is recognized in the journal.
 *
 * @category models
 * @since 0.1.0
 */
export type Detector = typeof Detector.Type

/**
 * What to do about one condition, and after how long.
 *
 * @category models
 * @since 0.1.0
 */
export const Rule = Schema.Struct({
  afterMs: Schema.Number,
  severity: Schema.optional(Severity),
  owner: Schema.optional(Schema.String),
  runbook: Schema.optional(Schema.String)
})

/**
 * What to do about one condition, and after how long.
 *
 * @category models
 * @since 0.1.0
 */
export type Rule = typeof Rule.Type

/**
 * The conditions a policy alerts on and the delays it alerts after.
 *
 * `defaults` fills in what a rule leaves out, so a policy states the delay per
 * condition and the ownership once.
 *
 * @category models
 * @since 0.1.0
 */
export const Policy = Schema.Struct({
  defaults: Schema.optional(Schema.Struct({
    severity: Schema.optional(Severity),
    owner: Schema.optional(Schema.String),
    runbook: Schema.optional(Schema.String)
  })),
  rules: Schema.Record(Schema.String, Rule),
  /** Detectors for conditions this deployment names itself. */
  detectors: Schema.optional(Schema.Record(Schema.String, Detector))
})

/**
 * The conditions a policy alerts on and the delays it alerts after.
 *
 * @category models
 * @since 0.1.0
 */
export type Policy = typeof Policy.Type

/**
 * The four conditions a control plane journals out of the box.
 *
 * `status` rides on every `control.run.*` entry, and `health` on every
 * `control.monitor.beat`. A deployment whose supervisor journals a park reason
 * gets `quota-parked` from the same field the run summary reports it under.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultDetectors: Readonly<Record<string, Detector>> = {
  "waiting-approval": { field: "status", value: "waiting-approval" },
  failed: { field: "status", value: "failed" },
  stalled: { field: "health", value: "stalled" },
  "quota-parked": { field: "waitingReason", value: "quota" }
}

/**
 * A condition that is open on a run, and when it opened.
 *
 * @category models
 * @since 0.1.0
 */
export interface Open {
  readonly runId: string
  readonly condition: string
  /** The journal time of the entry that opened the condition. */
  readonly since: number
}

/**
 * One alert a policy decided to raise.
 *
 * @category models
 * @since 0.1.0
 */
export interface Alert {
  readonly runId: string
  readonly condition: string
  readonly since: number
  /**
   * The journal instant the condition outlived its delay: `since` plus the
   * rule's `afterMs`, never the wall clock of whichever tick noticed.
   */
  readonly firedAt: number
  readonly severity: Severity
  readonly coalescingKey: string
  readonly owner?: string | undefined
  readonly runbook?: string | undefined
}

/**
 * The identity a delivery is recorded under.
 *
 * The opening time is part of it on purpose. A condition that clears and
 * re-opens is a NEW alert — the second approval wait is not the first one — and
 * a key without the time would suppress it forever.
 *
 * @param alert the alert
 * @category getters
 * @since 0.1.0
 */
export const alertId = (alert: Pick<Alert, "coalescingKey" | "since">): string =>
  `alert:${alert.coalescingKey}:${alert.since}`

const detectorsOf = (policy: Policy): Readonly<Record<string, Detector>> => ({
  ...defaultDetectors,
  ...policy.detectors
})

const payloadRecord = (payload: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Readonly<Record<string, unknown>>
    : undefined

/**
 * Every condition a run's journal leaves open, with the time each opened.
 *
 * An entry that carries a detector's field opens the condition when the value
 * matches and closes it when it does not. Entries the detector does not name
 * are ignored entirely, so a monitor beat cannot close an approval wait and an
 * approval cannot close a stall.
 *
 * @param policy the policy whose detectors decide what counts
 * @param runId the run the entries belong to
 * @param entries the run's journal, oldest first
 * @category projections
 * @since 0.1.0
 */
export const conditions = (
  policy: Policy,
  runId: string,
  entries: ReadonlyArray<JournalEvent.Entry>
): ReadonlyArray<Open> => {
  const detectors = detectorsOf(policy)
  const open = new Map<string, number>()
  for (const entry of entries) {
    const payload = payloadRecord(entry.payload)
    if (payload === undefined) continue
    for (const condition of Object.keys(policy.rules)) {
      const detector = detectors[condition]
      if (detector === undefined) continue
      if (detector.eventTypes !== undefined && !detector.eventTypes.includes(entry.eventType)) continue
      if (!(detector.field in payload)) continue
      if (payload[detector.field] === detector.value) {
        if (!open.has(condition)) open.set(condition, entry.emittedAtMs)
      } else {
        open.delete(condition)
      }
    }
  }
  return Array.from(open, ([condition, since]) => ({ runId, condition, since }))
}

/**
 * The alerts a policy raises for the conditions open at `now`.
 *
 * Pure, and a function of journal time: the same journal raises the same
 * alerts in any process, at any instant past the delay. `now` decides WHETHER
 * an alert is raised; it never appears in one. A condition that has been open
 * for less than its rule's delay raises nothing, which is the whole point of
 * the delay — most stalls clear themselves.
 *
 * @param policy the policy
 * @param open the conditions the journal left open
 * @param now the instant to judge them at
 * @category projections
 * @since 0.1.0
 */
export const decide = (
  policy: Policy,
  open: ReadonlyArray<Open>,
  now: number
): ReadonlyArray<Alert> =>
  open.flatMap((condition) => {
    const rule = policy.rules[condition.condition]
    if (rule === undefined) return []
    if (now - condition.since < rule.afterMs) return []
    const severity = rule.severity ?? policy.defaults?.severity ?? "warning"
    const owner = rule.owner ?? policy.defaults?.owner
    const runbook = rule.runbook ?? policy.defaults?.runbook
    return [{
      runId: condition.runId,
      condition: condition.condition,
      since: condition.since,
      // Derived from the journal, not read off the clock. The alert id is
      // stable across ticks, and the queue refuses a reused id whose content
      // changed, so an alert stamped with the reading time would become
      // permanently undeliverable the moment a tick refused and time moved on.
      firedAt: condition.since + rule.afterMs,
      severity,
      coalescingKey: `${condition.runId}:${condition.condition}`,
      ...(owner === undefined ? {} : { owner }),
      ...(runbook === undefined ? {} : { runbook })
    }]
  })

/**
 * A sink refused or could not take an alert.
 *
 * @category errors
 * @since 0.1.0
 */
export class AlertError extends Schema.TaggedError<AlertError>()(
  "/notifications/AlertError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Where a raised alert is sent.
 *
 * Injected rather than fixed, because who gets paged is a deployment's
 * decision and the policy is not: the same rules feed a webhook in production
 * and nothing at all in a test.
 *
 * @category services
 * @since 0.1.0
 */
export interface SinkService {
  /**
   * Sends one alert, and does so idempotently on {@link alertId}.
   *
   * Delivery is at-least-once: the `flows.alerts.delivered` record is written
   * after this effect succeeds, so a process that dies in between pages again
   * on the next tick. Every field of the alert — {@link Alert.firedAt}
   * included — is derived from the journal, so the same alert is byte-identical
   * on every attempt and `alertId(alert)` is the deduplication key a receiving
   * system should key on. A sink that cannot dedupe is a sink that will
   * occasionally page twice about one condition.
   *
   * A failure means the page did not go out. Succeeding on a page that was
   * dropped is the one thing this port must never do.
   */
  readonly deliver: (alert: Alert) => Effect.Effect<void, AlertError>
}

/**
 * The {@link SinkService} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class Sink extends Context.Service<Sink, SinkService>()("/notifications/AlertSink") {}

/**
 * A sink that accepts every alert and sends it nowhere.
 *
 * The admission and the delivery record still happen, so a composition without
 * an outbound channel still has the durable evidence of what it would have
 * paged about.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Sink> = Layer.succeed(Sink)({ deliver: () => Effect.void })

/**
 * A sink that POSTs each alert to one webhook.
 *
 * A non-2xx response is a failure, not a delivery. Paging is exactly the case
 * where a silently dropped request is worse than a retry.
 *
 * @param options the endpoint and any headers it needs
 * @category layers
 * @since 0.1.0
 */
export const layerWebhook = (
  options: { readonly url: string; readonly headers?: Readonly<Record<string, string>> | undefined }
): Layer.Layer<Sink, never, HttpClient.HttpClient> =>
  Layer.effect(
    Sink,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      return {
        deliver: (alert) =>
          client.execute(
            HttpClientRequest.post(options.url).pipe(
              (request) =>
                options.headers === undefined ? request : HttpClientRequest.setHeaders(request, options.headers),
              HttpClientRequest.bodyJsonUnsafe(alert)
            )
          ).pipe(
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? Effect.void
                : Effect.fail(
                  new AlertError({ message: `Alert webhook answered ${response.status}` })
                )
            ),
            Effect.catchTag("HttpClientError", (cause) =>
              Effect.fail(new AlertError({ message: "Alert webhook could not be reached", cause })))
          )
      }
    })
  )

/**
 * What one tick decided.
 *
 * @category models
 * @since 0.1.0
 */
export interface Tick {
  /** Alerts raised and delivered on this tick. */
  readonly delivered: ReadonlyArray<Alert>
  /** Alerts the sink refused on this tick. They are retried on the next one. */
  readonly failed: ReadonlyArray<Alert>
  /** Alerts that had already been delivered, and were not delivered again. */
  readonly suppressed: ReadonlyArray<Alert>
}

/**
 * The alert runtime: one tick per run.
 *
 * @category services
 * @since 0.1.0
 */
export interface RuntimeService {
  /**
   * Reads one run's journal and pages about whatever has waited too long.
   *
   * The two failures stay apart because they mean different things to an
   * operator. A `JournalError` is the alerter's own record channel failing —
   * it read no entries, or it could not write the delivery record. A
   * `NotificationError` is the notification queue refusing the admission, so
   * the alert exists and has nowhere durable to sit. Neither is a sink
   * failure: a refused page is journaled as `flows.alerts.failed` and retried
   * on the next tick, and it comes back in {@link Tick.failed}.
   */
  readonly tick: (runId: string) => Effect.Effect<Tick, Journal.JournalError | NotificationError>
}

/**
 * The {@link RuntimeService} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class AlertRuntime extends Context.Service<AlertRuntime, RuntimeService>()(
  "/notifications/AlertRuntime"
) {}

const entriesOf = (
  journal: Journal.Service,
  runId: JournalEvent.RunId
): Effect.Effect<ReadonlyArray<JournalEvent.Entry>, Journal.JournalError> =>
  Effect.gen(function*() {
    const entries: Array<JournalEvent.Entry> = []
    let after: JournalEvent.Seq | undefined
    while (true) {
      const page = yield* journal.entries({ runId, ...(after === undefined ? {} : { after }), limit: 512 })
      entries.push(...page.entries)
      if (!page.hasMore || page.entries.length === 0) break
      after = page.entries.at(-1)!.seq
    }
    return entries
  })

const alertNotification = (alert: Alert): NotificationModel.Notification => ({
  _tag: "system-event",
  id: alertId(alert),
  targetLineageId: alert.runId,
  delivery: "queue",
  coalescingKey: alert.coalescingKey,
  provenance: {
    sourceRunId: alert.runId,
    sourceLineageId: alert.runId,
    sourceTurn: 0,
    sourceActor: "alerts"
  },
  payload: {
    condition: alert.condition,
    severity: alert.severity,
    since: alert.since,
    firedAt: alert.firedAt,
    ...(alert.owner === undefined ? {} : { owner: alert.owner }),
    ...(alert.runbook === undefined ? {} : { runbook: alert.runbook })
  }
})

/**
 * The alert runtime over one policy.
 *
 * A tick reads the run's journal, derives the open conditions, decides which
 * have outlived their delay, and for each one that has not already been
 * delivered: admits a coalesced system event, sends it to the sink, and
 * journals the delivery. The admission comes first because it is idempotent
 * and the send is not — a crash between them costs a duplicate admission,
 * which the queue drops. A crash between an accepted send and the delivery
 * record costs a duplicate PAGE, which is why {@link SinkService.deliver} is
 * required to dedupe on {@link alertId}.
 *
 * @param policy the rules to enforce
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  policy: Policy
): Layer.Layer<AlertRuntime, never, Journal.Journal | NotificationQueue | Sink> =>
  Layer.effect(
    AlertRuntime,
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const queue = yield* NotificationQueue
      const sink = yield* Sink

      const record = (
        eventType: string,
        alert: Alert,
        detail?: string
      ): Effect.Effect<void, Journal.JournalError> =>
        journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(alert.runId),
            sourceId: JournalEvent.SourceId.make(`/notifications/alerts/${alertId(alert)}`),
            eventType,
            payload: {
              runId: alert.runId,
              condition: alert.condition,
              since: alert.since,
              severity: alert.severity,
              alertId: alertId(alert),
              ...(detail === undefined ? {} : { detail })
            }
          })
        ).pipe(Effect.asVoid)

      return AlertRuntime.of({
        tick: Effect.fn("AlertRuntime.tick")(function*(runId: string) {
          const journalRunId = JournalEvent.RunId.make(runId)
          const entries = yield* entriesOf(journal, journalRunId)
          const now = yield* Clock.currentTimeMillis
          const raised = decide(policy, conditions(policy, runId, entries), now)
          const alreadyDelivered = new Set(
            entries.filter((entry) => entry.eventType === deliveredEventType).flatMap((entry) => {
              const payload = payloadRecord(entry.payload)
              const id = payload?.["alertId"]
              return typeof id === "string" ? [id] : []
            })
          )
          const delivered: Array<Alert> = []
          const failed: Array<Alert> = []
          const suppressed: Array<Alert> = []
          for (const alert of raised) {
            if (alreadyDelivered.has(alertId(alert))) {
              suppressed.push(alert)
              continue
            }
            // Raised unchanged: a queue that refuses the admission is not the
            // journal failing, and calling it `sink_failed` would send an
            // operator looking at the webhook.
            yield* queue.admit(runId, alertNotification(alert))
            const outcome = yield* Effect.result(sink.deliver(alert))
            if (Result.isFailure(outcome)) {
              yield* record(failedEventType, alert, outcome.failure.message)
              failed.push(alert)
            } else {
              yield* record(deliveredEventType, alert)
              delivered.push(alert)
            }
          }
          return { delivered, failed, suppressed }
        })
      })
    })
  )
