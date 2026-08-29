/**
 * Journal-backed durable notification admission and turn-boundary drain.
 *
 * Governing contract: `docs/specs/Concepts/Notification Queue.md`.
 *
 * @since 0.1.0
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import type * as NotificationModel from "./Notification.ts"
import * as NotificationEvent from "./NotificationEvent.ts"
import * as NotificationState from "./NotificationState.ts"
import { defaultCapacity } from "./Projection.ts"

/**
 * The queue could not be reached or served the request.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class NotificationError extends Schema.TaggedError<NotificationError>()(
  "/notifications/NotificationError",
  {
    code: Schema.Literal("notification_unavailable").pipe(
      Schema.withConstructorDefault(Effect.succeed("notification_unavailable"))
    ),
    message: Schema.String
  }
) {}

/**
 * What admitting one notification decided: its durable sequence number and
 * whether the id had already been admitted.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface AdmissionReceipt {
  readonly notificationId: string
  readonly decision: NotificationState.AdmissionDecision
  readonly seq: number
  readonly duplicate: boolean
}

/**
 * The boundary a drain is attempted at, and whether the run would go idle
 * if nothing were delivered.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface DrainInput {
  readonly runId: string
  readonly targetLineageId: string
  readonly boundary: string
  readonly wouldIdle: boolean
}

/**
 * The notifications this boundary delivers, and whether the boundary had
 * already drained.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface DrainReceipt {
  readonly notifications: ReadonlyArray<NotificationModel.Notification>
  readonly boundary: string
  readonly duplicate: boolean
}

/**
 * The durable pending queue: admit a notification exactly once, and drain
 * what a boundary is allowed to deliver.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly admit: (
    runId: string,
    notification: NotificationModel.Notification
  ) => Effect.Effect<AdmissionReceipt, Journal.JournalError | NotificationError>
  readonly drain: (
    input: DrainInput
  ) => Effect.Effect<DrainReceipt, Journal.JournalError | NotificationError>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class NotificationQueue extends Context.Service<NotificationQueue, Service>()(
  "/notifications/NotificationQueue"
) {}

/**
 * Builds a {@link Service} from an implementation of its methods.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => NotificationQueue.of(implementation)

const unavailable = (operation: string): NotificationError =>
  new NotificationError({ message: `${operation} is unavailable` })

/**
 * A {@link Service} that fails both methods as unavailable. Overrides
 * replace individual methods.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    admit: Effect.fn("NotificationQueue.admit")(() => Effect.fail(unavailable("admit"))),
    drain: Effect.fn("NotificationQueue.drain")(() => Effect.fail(unavailable("drain"))),
    ...overrides
  })

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<NotificationQueue> =>
  Layer.succeed(NotificationQueue)(makeNoop(overrides))

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return String(JSON.stringify(value))
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${
    Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`
    ).join(",")
  }}`
}

const sameNotification = (
  left: NotificationModel.Notification,
  right: NotificationModel.Notification
): boolean => canonical(left) === canonical(right)

interface Loaded {
  readonly entries: ReadonlyArray<JournalEvent.Entry>
  readonly state: NotificationState.State
  readonly notifications: ReadonlyMap<string, NotificationModel.Notification>
}

const load = (
  journal: Journal.Service,
  runId: JournalEvent.RunId
): Effect.Effect<Loaded, Journal.JournalError> =>
  Effect.gen(function*() {
    const entries: Array<JournalEvent.Entry> = []
    let after: JournalEvent.Seq | undefined
    while (true) {
      // `after` is an exact-optional property upstream, so an explicit
      // `undefined` is not the same as an absent key.
      const page = yield* journal.entries({ runId, ...(after === undefined ? {} : { after }), limit: 512 })
      entries.push(...page.entries)
      if (!page.hasMore || page.entries.length === 0) break
      after = page.entries.at(-1)!.seq
    }

    let state = NotificationState.empty(defaultCapacity)
    const notifications = new Map<string, NotificationModel.Notification>()
    for (const entry of entries) {
      const decoded = NotificationEvent.fromEntry(entry)
      if (Option.isNone(decoded)) continue
      if ("notification" in decoded.value) {
        notifications.set(decoded.value.notification.id, decoded.value.notification)
        state = NotificationState.applyAdmission(
          state,
          decoded.value.notification,
          entry.seq,
          decoded.value.decision
        )
      } else {
        state = NotificationState.applyPromoted(state, decoded.value.ids)
      }
    }
    return { entries, state, notifications }
  })

const admissionSource = (id: string): JournalEvent.SourceId =>
  JournalEvent.SourceId.make(`/notifications/admission/${id}`)

const drainSource = (boundary: string): JournalEvent.SourceId =>
  JournalEvent.SourceId.make(`/notifications/drain/${boundary}`)

/**
 * Journal-backed production layer. Admission and drain evidence is written
 * through `emitDurable`, so both return only after the corresponding entry is
 * durably committed — a dropped lifecycle event is unrepresentable.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<NotificationQueue, never, Journal.Journal> = Layer.effect(
  NotificationQueue,
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const operations = yield* Semaphore.make(1)
    return make({
      admit: Effect.fn("NotificationQueue.admit")((rawRunId, notification) =>
        operations.withPermits(1)(journal.transact(Effect.gen(function*() {
          const runId = JournalEvent.RunId.make(rawRunId)
          const loaded = yield* load(journal, runId)
          const prior = loaded.entries.find((entry) => {
            const decoded = NotificationEvent.fromEntry(entry)
            return Option.isSome(decoded) &&
              "notification" in decoded.value &&
              decoded.value.notification.id === notification.id
          })
          if (prior !== undefined) {
            const decoded = NotificationEvent.fromEntry(prior)
            if (
              Option.isNone(decoded) ||
              !("notification" in decoded.value) ||
              !sameNotification(decoded.value.notification, notification)
            ) {
              return yield* new Journal.JournalError({
                code: "idempotency_conflict",
                message: `Notification id ${notification.id} was reused with different content`
              })
            }
            return {
              notificationId: notification.id,
              decision: decoded.value.decision,
              seq: prior.seq,
              duplicate: true
            }
          }

          const admission = NotificationState.admit(
            loaded.state,
            notification,
            loaded.entries.at(-1)?.seq === undefined ? 0 : loaded.entries.at(-1)!.seq + 1
          )
          // Unfenced: the queue is an external admission channel — the
          // notifying process owns no run, and admissions are
          // first-writer-wins on the notification id.
          const receipt = yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId,
              sourceId: admissionSource(notification.id),
              sourceSeq: JournalEvent.SourceSeq.make(0),
              eventType: NotificationEvent.AdmittedEventType,
              payload: {
                notification,
                decision: admission.decision
              }
            })
          )
          return {
            notificationId: notification.id,
            decision: admission.decision,
            seq: receipt.seq,
            duplicate: receipt._tag === "Duplicate"
          }
        })))
      ),
      drain: Effect.fn("NotificationQueue.drain")((input) =>
        operations.withPermits(1)(journal.transact(Effect.gen(function*() {
          const runId = JournalEvent.RunId.make(input.runId)
          const loaded = yield* load(journal, runId)
          const prior = loaded.entries.flatMap((entry) =>
            Option.match(NotificationEvent.fromEntry(entry), {
              onNone: () => [],
              onSome: (event) => "boundary" in event ? [event] : []
            })
          ).find((event) =>
            event.boundary === input.boundary &&
            event.targetLineageId === input.targetLineageId
          )
          if (prior !== undefined) {
            return {
              notifications: prior.ids.flatMap((id) => {
                const notification = loaded.notifications.get(id)
                return notification === undefined ? [] : [notification]
              }),
              boundary: input.boundary,
              duplicate: true
            }
          }

          const cutoff = loaded.entries.at(-1)?.seq ?? 0
          const steers = NotificationState.promoteSteers(
            loaded.state,
            cutoff,
            input.targetLineageId
          )
          const queued = input.wouldIdle && steers.promoted.length === 0
            ? NotificationState.promoteQueued(steers.state, input.targetLineageId)
            : { state: steers.state, promoted: [] }
          const promoted = [...steers.promoted, ...queued.promoted].map((item) => item.notification)
          // Unfenced: a drain promotes notifications for a run the draining
          // boundary does not own; the promotion record is first-writer-wins.
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId,
              sourceId: drainSource(input.boundary),
              sourceSeq: JournalEvent.SourceSeq.make(0),
              eventType: NotificationEvent.PromotedEventType,
              payload: {
                boundary: input.boundary,
                targetLineageId: input.targetLineageId,
                ids: promoted.map((notification) => notification.id)
              }
            })
          )
          return {
            notifications: promoted,
            boundary: input.boundary,
            duplicate: false
          }
        })))
      )
    })
  })
)
