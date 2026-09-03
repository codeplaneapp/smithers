/**
 * Journal projection for pending notifications.
 *
 * @since 0.1.0
 */
import { Projection as JournalProjection } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as NotificationEvent from "./NotificationEvent.ts"
import * as NotificationState from "./NotificationState.ts"

/**
 * Re-derives pending notifications from admitted and promoted journal events.
 * Foreign journal entries leave the state unchanged.
 *
 * The projection reads at `NotificationState.defaultCapacity`, which is what a
 * queue built with `NotificationQueue.layer` enforces. A deployment that raised
 * the bound with `NotificationQueue.layerWith` derives its own projection from
 * `NotificationState` rather than reading this one, which would report a
 * shorter queue than the run actually holds.
 *
 * @category projections
 * @since 0.1.0
 */
export const derive = JournalProjection.make({
  name: "flows/notifications",
  initial: NotificationState.empty(NotificationState.defaultCapacity),
  reduce: (state, entry) => {
    const decoded = NotificationEvent.fromEntry(entry)
    if (Option.isNone(decoded)) return Effect.succeed(state)

    const event = decoded.value
    if (NotificationEvent.isAdmitted(event)) {
      return Effect.succeed(
        NotificationState.applyAdmission(state, event.notification, entry.seq, event.decision)
      )
    }
    return Effect.succeed(NotificationState.applyPromoted(state, event.ids))
  }
})
