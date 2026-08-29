/**
 * Durable notification payloads and their admission classification.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * Durable origin of a notification.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Provenance = Schema.Struct({
  sourceRunId: Schema.String,
  sourceLineageId: Schema.String,
  sourceTurn: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  sourceActor: Schema.String
})

/**
 * The decoded form of {@link Provenance}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Provenance = typeof Provenance.Type

const common = {
  id: Schema.NonEmptyString,
  targetLineageId: Schema.NonEmptyString,
  provenance: Provenance,
  payload: Schema.Json
}

/**
 * A human message that must reach the model before the current turn closes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const HumanSteer = Schema.TaggedStruct("human-steer", {
  ...common,
  delivery: Schema.Literal("steer")
})

/**
 * A human message that waits for the run to become idle.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const HumanFollowup = Schema.TaggedStruct("human-followup", {
  ...common,
  delivery: Schema.Literal("queue")
})

/**
 * A machine-originated event. Consecutive events sharing a coalescing key
 * collapse to the most recent payload while pending.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const SystemEvent = Schema.TaggedStruct("system-event", {
  ...common,
  delivery: Schema.Literal("queue"),
  coalescingKey: Schema.optional(Schema.String)
})

/**
 * Any durable notification retained by the pending queue.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Notification = Schema.Union([HumanSteer, HumanFollowup, SystemEvent])

/**
 * Any durable notification retained by the pending queue.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Notification = typeof Notification.Type

/**
 * How a notification is allowed to reach the model.
 *
 * `steer` notifications are promoted in a batch at turn close; `queue`
 * notifications are promoted one at a time when the run would otherwise idle.
 *
 * @category getters
 * @since 0.1.0
 * @slop
 */
export const admissionClass = (notification: Notification): "steer" | "queue" => notification.delivery

/**
 * The key a pending notification coalesces on, or `null` when it must never
 * be coalesced. Only system events coalesce, and only when they declare a key.
 *
 * @category getters
 * @since 0.1.0
 * @slop
 */
export const coalesceKey = (notification: Notification): string | null =>
  notification._tag === "system-event" ? notification.coalescingKey ?? null : null
