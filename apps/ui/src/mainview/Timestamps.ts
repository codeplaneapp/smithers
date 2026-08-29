/*
 * One timestamp vocabulary for the whole app.
 *
 * A bare clock reading is only unambiguous within the calendar day it was
 * stamped in. The transcript is persisted, so reopening it tomorrow — or
 * leaving a session open across midnight — rendered a message from last week
 * as `11:51 PM`, indistinguishable from one three minutes ago (§28.9). A
 * stamp outside today therefore says which day it belongs to.
 */

/** The clock reading in the user's locale — never zero-padded by hand. */
const clock = (at: Date): string => at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

/** Whole days between two instants, by calendar day rather than by elapsed time. */
const dayGap = (at: Date, now: Date): number => {
  const day = (value: Date): number => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000
  return day(now) - day(at)
}

/**
 * A stamp for the transcript and its cards: the time alone inside today,
 * "Yesterday" the day before, and the date beyond that.
 */
export const timeLabel = (createdAt: number, now: number = Date.now()): string => {
  const at = new Date(createdAt)
  const gap = dayGap(at, new Date(now))
  if (gap <= 0) return clock(at)
  if (gap === 1) return `Yesterday ${clock(at)}`
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(at)}`
}
