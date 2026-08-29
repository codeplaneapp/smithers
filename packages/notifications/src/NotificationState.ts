/**
 * Pure pending-notification queue state.
 *
 * @since 0.1.0
 */
import type { Notification } from "./Notification.ts"
import { admissionClass, coalesceKey } from "./Notification.ts"

/**
 * A notification retained until it is promoted at a harness safe point.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Pending {
  readonly notification: Notification
  readonly seq: number
}

/**
 * The result recorded for one durable notification admission.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type AdmissionDecision = "admitted" | "coalesced" | "rejected-full"

/**
 * Immutable bounded queue state derived from the notification journal.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface State {
  readonly capacity: number
  readonly items: ReadonlyArray<Pending>
}

/**
 * One pure admission transition and its visible decision.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Admission {
  readonly state: State
  readonly decision: AdmissionDecision
}

/**
 * A pure promotion transition.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Promotion {
  readonly state: State
  readonly promoted: ReadonlyArray<Pending>
}

const immutable = (capacity: number, items: ReadonlyArray<Pending>): State =>
  Object.freeze({
    capacity,
    items: Object.freeze(items.map((item) => Object.freeze({ ...item })))
  })

const normalizedCapacity = (capacity: number): number =>
  Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0

const immutablePromotion = (state: State, promoted: ReadonlyArray<Pending>): Promotion =>
  Object.freeze({
    state,
    promoted: Object.freeze(promoted.map((item) => Object.freeze({ ...item })))
  })

/**
 * Creates an empty bounded notification queue.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const empty = (capacity: number): State => immutable(normalizedCapacity(capacity), [])

/**
 * Admits a notification, coalescing only pending system events with the same
 * key. Coalescing retains the first sequence so replay order remains stable.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const admit = (state: State, notification: Notification, seq: number): Admission => {
  const key = notification._tag === "system-event" ? coalesceKey(notification) : null
  if (key !== null) {
    const index = state.items.findIndex(
      (item) => item.notification._tag === "system-event" && coalesceKey(item.notification) === key
    )
    if (index !== -1) {
      const existing = state.items[index]!
      const items = [...state.items]
      items[index] = { notification, seq: existing.seq }
      return Object.freeze({ state: immutable(state.capacity, items), decision: "coalesced" })
    }
  }

  if (state.items.length >= state.capacity) {
    return Object.freeze({ state, decision: "rejected-full" })
  }

  return Object.freeze({
    state: immutable(state.capacity, [...state.items, { notification, seq }]),
    decision: "admitted"
  })
}

/**
 * Applies the decision already committed in an admission journal event.
 *
 * @category operations
 * @since 0.1.0
 */
export const applyAdmission = (
  state: State,
  notification: Notification,
  seq: number,
  decision: AdmissionDecision
): State => {
  if (decision === "rejected-full") return state
  if (decision === "admitted") {
    return immutable(state.capacity, [...state.items, { notification, seq }])
  }
  const key = notification._tag === "system-event" ? coalesceKey(notification) : null
  const index = key === null ? -1 : state.items.findIndex(
    (item) => item.notification._tag === "system-event" && coalesceKey(item.notification) === key
  )
  if (index === -1) return immutable(state.capacity, [...state.items, { notification, seq }])
  const items = [...state.items]
  items[index] = { notification, seq: items[index]!.seq }
  return immutable(state.capacity, items)
}

/**
 * Returns still-pending notifications in their durable journal order.
 *
 * @category getters
 * @since 0.1.0
 * @slop
 */
export const pending = (
  state: State,
  admission: "steer" | "queue",
  targetLineageId?: string
): ReadonlyArray<Pending> =>
  Object.freeze(
    state.items.filter((item) =>
      admissionClass(item.notification) === admission &&
      (targetLineageId === undefined || item.notification.targetLineageId === targetLineageId)
    )
  )

/**
 * Promotes every steer notification admitted at or before the turn-close
 * cutoff. Notifications admitted after the cutoff remain pending.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const promoteSteers = (state: State, cutoffSeq: number, targetLineageId?: string): Promotion => {
  const promoted: Array<Pending> = []
  const remaining: Array<Pending> = []
  for (const item of state.items) {
    if (
      admissionClass(item.notification) === "steer" &&
      item.seq <= cutoffSeq &&
      (targetLineageId === undefined || item.notification.targetLineageId === targetLineageId)
    ) {
      promoted.push(item)
    } else {
      remaining.push(item)
    }
  }
  return immutablePromotion(immutable(state.capacity, remaining), promoted)
}

/**
 * Promotes exactly the oldest pending queue notification.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const promoteQueued = (state: State, targetLineageId?: string): Promotion => {
  const index = state.items.findIndex((item) =>
    admissionClass(item.notification) === "queue" &&
    (targetLineageId === undefined || item.notification.targetLineageId === targetLineageId)
  )
  if (index === -1) return immutablePromotion(state, [])
  const promoted = state.items[index]!
  return immutablePromotion(
    immutable(state.capacity, [...state.items.slice(0, index), ...state.items.slice(index + 1)]),
    [promoted]
  )
}

/**
 * Applies a durable promotion record while replaying journal history.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const applyPromoted = (state: State, ids: ReadonlyArray<string>): State => {
  if (ids.length === 0) return state
  const promoted = new Set(ids)
  return immutable(state.capacity, state.items.filter((item) => !promoted.has(item.notification.id)))
}
