/**
 * Alert policy: run conditions that have lasted too long, turned into durable,
 * coalesced, delivered-once notifications.
 *
 * A notification queue answers "tell this run something". An alert answers the
 * question nobody is around to ask: a run has been waiting for an approval for
 * an hour, and the person who could grant it does not know. The two are the
 * same machinery, since an alert is admitted as a coalesced system event, and
 * they differ only in who decides to write one.
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
 * will page again on the next tick. Recording the delivery first turns the
 * same crash into a page nobody ever receives, which for an alert is the worse
 * failure.
 *
 * So the sink owns the last mile: {@link SinkService.deliver} MUST be
 * idempotent on {@link alertId}, which is stable for the life of one condition
 * and reaches the sink on every alert it is handed. A sink that fails journals
 * `flows.alerts.failed` once per failure code and the alert is retried on the
 * next tick, because a refused page is not a delivered page.
 *
 * ## What a refusal costs
 *
 * The queue can refuse the admission when a run already holds its capacity of
 * pending notifications. A tick that is refused pages nobody: the alert comes
 * back in {@link Tick.refused}, the refusal is journaled, and the next tick
 * tries again once a boundary has drained. Calling the sink anyway would page
 * about an alert the run will never see.
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
import { Clock, Context, Duration, Effect, Layer, Result, Schema } from "effect"
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
 * One entry is written per alert per failure code, never one per tick: a
 * webhook that stays down for an hour leaves one record, not a hundred and
 * twenty that every later tick has to read past.
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
 * `afterMs` is a whole, non-negative number of milliseconds. The bound is the
 * schema's job because the delay is also arithmetic on journal time: a `NaN`
 * delay fires on the first tick and stamps a `firedAt` that JSON writes as
 * `null`, and a negative one fires with a `firedAt` earlier than the condition
 * it describes.
 *
 * @category models
 * @since 0.1.0
 */
export const Rule = Schema.Struct({
  afterMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
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
 * The key an alert coalesces on: one open condition on one run.
 *
 * Each component is percent-encoded before it is joined, so a run id or a
 * condition name containing the separator cannot forge another pair's key and
 * suppress a page that belongs to somebody else. Both components are values a
 * deployment chooses, which is why the encoding is not optional.
 *
 * @param runId the run the condition is open on
 * @param condition the condition name the policy uses
 * @category getters
 * @since 1.0.0
 */
export const coalescingKey = (runId: string, condition: string): string =>
  `${encodeURIComponent(runId)}:${encodeURIComponent(condition)}`

/**
 * The identity a delivery is recorded under.
 *
 * The opening time is part of it on purpose. A condition that clears and
 * re-opens is a NEW alert, because the second approval wait is not the first
 * one, and a key without the time would suppress it forever.
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
 * Folds one entry into the open-condition map. Shared by the exported
 * projection and the runtime's incremental read, so both decide a condition
 * the same way.
 *
 * The alerter's own records are never evidence about a condition. They are
 * written into the same journal they are read from, and they carry the alert's
 * own vocabulary: a refusal reports the answering HTTP `status`, which a
 * detector watching the run's `status` would read as the condition clearing.
 * A page would then close the condition it paged about and the next tick would
 * re-open it, so a webhook that answered 503 once would alert forever.
 */
const observe = (
  policy: Policy,
  detectors: Readonly<Record<string, Detector>>,
  entry: JournalEvent.Entry,
  payload: Readonly<Record<string, unknown>>,
  open: Map<string, number>
): void => {
  if (entry.eventType === deliveredEventType || entry.eventType === failedEventType) return
  for (const condition of Object.keys(policy.rules)) {
    const detector = detectors[condition]
    if (detector === undefined) continue
    if (detector.eventTypes !== undefined && !detector.eventTypes.includes(entry.eventType)) continue
    // Own properties only. `in` walks `Object.prototype`, so a detector named
    // `toString` or `constructor` would read every record-shaped entry in the
    // run as evidence and close the condition on all of them.
    if (!Object.hasOwn(payload, detector.field)) continue
    if (payload[detector.field] === detector.value) {
      if (!open.has(condition)) open.set(condition, entry.emittedAtMs)
    } else {
      open.delete(condition)
    }
  }
}

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
    observe(policy, detectors, entry, payload, open)
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
 * the delay, because most stalls clear themselves.
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
      coalescingKey: coalescingKey(condition.runId, condition.condition),
      ...(owner === undefined ? {} : { owner }),
      ...(runbook === undefined ? {} : { runbook })
    }]
  })

/**
 * Why a sink did not take an alert.
 *
 * `sink_rejected` is an answer that refused the page, `sink_unreachable` a
 * request that never got one, and `sink_timeout` one that got no answer inside
 * the sink's bound.
 *
 * @category models
 * @since 1.0.0
 */
export const FailureCode = Schema.Literals(["sink_rejected", "sink_unreachable", "sink_timeout"])

/**
 * Why a sink did not take an alert.
 *
 * @category models
 * @since 1.0.0
 */
export type FailureCode = typeof FailureCode.Type

/**
 * A sink refused or could not take an alert.
 *
 * The error carries a code, the answering status when there was one, and a
 * short reason. It deliberately holds no request: a webhook request carries
 * the credential the deployment handed {@link layerWebhook}, and an error is
 * logged, encoded, and journaled in places a credential must never reach.
 *
 * @category errors
 * @since 0.1.0
 */
export class AlertError extends Schema.TaggedError<AlertError>()(
  "/notifications/AlertError",
  {
    code: FailureCode.pipe(Schema.withConstructorDefault(Effect.succeed("sink_rejected" as const))),
    message: Schema.String,
    /** The HTTP status that refused the page, when the sink speaks HTTP. */
    status: Schema.optional(Schema.Int),
    /** A short, credential-free description of the transport failure. */
    reason: Schema.optional(Schema.String)
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
   * on the next tick. Every field of the alert, {@link Alert.firedAt}
   * included, is derived from the journal, so the same alert is byte-identical
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
 * How long the webhook sink waits for an answer before it calls the page
 * refused.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultWebhookTimeout: Duration.Duration = Duration.seconds(10)

/**
 * A sink that POSTs each alert to one webhook.
 *
 * The body is the alert plus its {@link alertId}, and the same id is sent as
 * an `Idempotency-Key` header, because the package requires the receiver to
 * dedupe on it and a body without it cannot. The header is set after the
 * caller's headers, so it is the one this sink sends.
 *
 * A non-2xx response is a failure, not a delivery, and an endpoint that never
 * answers is a failure after `timeout`. Paging is exactly the case where a
 * silently dropped request is worse than a retry, and a hung request is worse
 * than either: it is indistinguishable from silence, so it must not be
 * possible to wait on one forever.
 *
 * @param options the endpoint, any headers it needs, and how long to wait
 * @category layers
 * @since 0.1.0
 */
export const layerWebhook = (
  options: {
    readonly url: string
    readonly headers?: Readonly<Record<string, string>> | undefined
    readonly timeout?: Duration.Duration | undefined
  }
): Layer.Layer<Sink, never, HttpClient.HttpClient> =>
  Layer.effect(
    Sink,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const timeout = options.timeout ?? defaultWebhookTimeout
      return {
        deliver: (alert) =>
          client.execute(
            HttpClientRequest.post(options.url).pipe(
              (request) =>
                options.headers === undefined ? request : HttpClientRequest.setHeaders(request, options.headers),
              HttpClientRequest.setHeader("Idempotency-Key", alertId(alert)),
              HttpClientRequest.bodyJsonUnsafe({ ...alert, alertId: alertId(alert) })
            )
          ).pipe(
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? Effect.void
                : Effect.fail(
                  new AlertError({
                    code: "sink_rejected",
                    status: response.status,
                    message: `Alert webhook answered ${response.status}`
                  })
                )
            ),
            Effect.timeout(timeout),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                new AlertError({
                  code: "sink_timeout",
                  message: `Alert webhook did not answer within ${Duration.toMillis(timeout)} ms`
                })
              )),
            // The transport error holds the request, and the request holds the
            // caller's headers. Only its reason tag crosses into the failure.
            Effect.catchTag("HttpClientError", (cause) =>
              Effect.fail(
                new AlertError({
                  code: "sink_unreachable",
                  reason: cause.reason._tag,
                  message: "Alert webhook could not be reached"
                })
              ))
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
  /**
   * Alerts the notification queue refused because the run is at capacity. The
   * sink was not called for them, and they are retried on the next tick.
   */
  readonly refused: ReadonlyArray<Alert>
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
   * operator. A `JournalError` is the alerter's own record channel failing: it
   * read no entries, or it could not write the delivery record. A
   * `NotificationError` is the notification queue rejecting the alert outright,
   * which is a producer or storage fault rather than a full queue. Neither is
   * a sink failure: a refused page is journaled as `flows.alerts.failed` and
   * retried on the next tick, and it comes back in {@link Tick.failed}. A queue
   * at capacity is not a failure either; it comes back in {@link Tick.refused}.
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

/**
 * One run's folded alert history: the conditions still open, the alerts
 * already paged, and the sequence the fold stopped at.
 */
interface Watched {
  readonly open: ReadonlyMap<string, number>
  readonly delivered: ReadonlySet<string>
  readonly cursor: number | undefined
}

/** How many runs one alert runtime keeps folded at a time. */
const maximumWatchedRuns = 64

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
 * and the send is not: a crash between them costs a duplicate admission, which
 * the queue drops, while a crash between an accepted send and the delivery
 * record costs a duplicate PAGE, which is why {@link SinkService.deliver} is
 * required to dedupe on {@link alertId}.
 *
 * The policy is decoded when the layer is built, so a rule with an impossible
 * delay fails the composition by name instead of mis-paging at 3am.
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
      const checked = yield* Effect.orDie(Schema.decodeUnknownEffect(Policy)(policy))
      const detectors = detectorsOf(checked)
      const journal = yield* Journal.Journal
      const queue = yield* NotificationQueue
      const sink = yield* Sink
      // Folded history per run, so a tick costs the entries committed since
      // the previous one rather than the run's whole journal.
      const watched = new Map<string, Watched>()

      const observed = (runId: JournalEvent.RunId): Effect.Effect<Watched, Journal.JournalError> =>
        Effect.gen(function*() {
          const base: Watched = watched.get(runId) ??
            { open: new Map(), delivered: new Set(), cursor: undefined }
          const fresh: Array<JournalEvent.Entry> = []
          let after = base.cursor === undefined ? undefined : JournalEvent.Seq.make(base.cursor)
          while (true) {
            const page = yield* journal.entries({ runId, ...(after === undefined ? {} : { after }), limit: 512 })
            fresh.push(...page.entries)
            if (!page.hasMore || page.entries.length === 0) break
            after = page.entries.at(-1)!.seq
          }
          if (fresh.length === 0) return base

          const open = new Map(base.open)
          const delivered = new Set(base.delivered)
          let cursor = base.cursor
          for (const entry of fresh) {
            cursor = entry.seq
            const payload = payloadRecord(entry.payload)
            if (payload === undefined) continue
            if (entry.eventType === deliveredEventType) {
              const id = payload["alertId"]
              if (typeof id === "string") delivered.add(id)
            }
            observe(checked, detectors, entry, payload, open)
          }
          const next: Watched = { open, delivered, cursor }
          watched.delete(runId)
          watched.set(runId, next)
          if (watched.size > maximumWatchedRuns) watched.delete(watched.keys().next().value!)
          return next
        })

      const record = (
        eventType: string,
        alert: Alert,
        source: string,
        outcome: { readonly code?: string | undefined; readonly status?: number | undefined }
      ): Effect.Effect<void, Journal.JournalError> =>
        journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(alert.runId),
            sourceId: JournalEvent.SourceId.make(`/notifications/alerts/${alertId(alert)}/${source}`),
            sourceSeq: JournalEvent.SourceSeq.make(0),
            // One record per alert per outcome. Without an explicit identity
            // the journal allocates a new sequence on every attempt, and a
            // webhook that stays down appends a row per tick forever.
            dedupe: "identity",
            eventType,
            payload: {
              runId: alert.runId,
              condition: alert.condition,
              since: alert.since,
              severity: alert.severity,
              alertId: alertId(alert),
              ...(outcome.code === undefined ? {} : { code: outcome.code }),
              ...(outcome.status === undefined ? {} : { status: outcome.status })
            }
          })
        ).pipe(Effect.asVoid)

      return AlertRuntime.of({
        tick: Effect.fn("AlertRuntime.tick")(function*(runId: string) {
          const journalRunId = JournalEvent.RunId.make(runId)
          const history = yield* observed(journalRunId)
          const now = yield* Clock.currentTimeMillis
          const open = Array.from(history.open, ([condition, since]) => ({ runId, condition, since }))
          const raised = decide(checked, open, now)
          const delivered: Array<Alert> = []
          const failed: Array<Alert> = []
          const refused: Array<Alert> = []
          const suppressed: Array<Alert> = []
          for (const alert of raised) {
            if (history.delivered.has(alertId(alert))) {
              suppressed.push(alert)
              continue
            }
            // Raised unchanged: a queue that rejects the admission outright is
            // not the journal failing, and calling it `sink_failed` would send
            // an operator looking at the webhook.
            const receipt = yield* queue.admit(runId, alertNotification(alert))
            if (receipt.decision === "rejected-full") {
              // The alert has nowhere durable to sit, so paging about it would
              // tell an operator about something the run will never read.
              yield* record(failedEventType, alert, "refused", { code: "notification_full" })
              refused.push(alert)
              continue
            }
            const outcome = yield* Effect.result(sink.deliver(alert))
            if (Result.isFailure(outcome)) {
              yield* record(failedEventType, alert, `failed/${outcome.failure.code}`, {
                code: outcome.failure.code,
                status: outcome.failure.status
              })
              failed.push(alert)
            } else {
              yield* record(deliveredEventType, alert, "delivered", {})
              delivered.push(alert)
            }
          }
          return { delivered, failed, refused, suppressed }
        })
      })
    })
  )
