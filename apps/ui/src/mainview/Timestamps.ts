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

/*
 * A short age for a recent instant (`4 min ago`) — the vocabulary the sync
 * cards use for "last sync" and rate-limit resets (ADR 0005). An unparseable
 * stamp renders verbatim rather than a lie; past a day the stamp vocabulary
 * reads better than an hour count.
 */
export const ageLabel = (iso: string, now: number = Date.now()): string => {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return timeLabel(at, now)
}

/*
 * A short distance to an instant still AHEAD (`in 12 min`, `at 12:40`) — the
 * vocabulary for a rate-limit reset (ADR 0005 "Rate limits"). `ageLabel`
 * clamps a future instant to "just now", which told the user a limit had
 * already reset while GitHub would still refuse the call; a reset is always
 * ahead, so it needs its own words. An instant already reached reads `now`;
 * an unparseable stamp renders verbatim rather than a lie.
 */
export const untilLabel = (iso: string, now: number = Date.now()): string => {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const seconds = Math.round((at - now) / 1000)
  if (seconds <= 0) return "now"
  if (seconds < 60) return "in under a minute"
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `in ${minutes} min`
  return `at ${timeLabel(at, now)}`
}
