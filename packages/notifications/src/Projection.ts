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
 * The default maximum number of pending notifications retained per run.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultCapacity = 128

/**
 * Re-derives pending notifications from admitted and promoted journal events.
 * Foreign journal entries leave the state unchanged.
 *
 * @category projections
 * @since 0.1.0
 * @slop
 */
export const derive = JournalProjection.make({
  name: "flows/notifications",
  initial: NotificationState.empty(defaultCapacity),
  reduce: (state, entry) => {
    const decoded = NotificationEvent.fromEntry(entry)
    if (Option.isNone(decoded)) return Effect.succeed(state)

    const event = decoded.value
    if ("notification" in event) {
      return Effect.succeed(
        NotificationState.applyAdmission(state, event.notification, entry.seq, event.decision)
      )
    }
    return Effect.succeed(NotificationState.applyPromoted(state, event.ids))
  }
})
