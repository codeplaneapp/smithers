/*
 * The event a trigger waits for, in words.
 *
 * A stored trigger carries a five-field cron expression and an optional
 * timezone (`@smthrs/triggers` Schedule). The card states the common shapes
 * in plain English and falls back to the expression itself, never to a
 * guess: a zone the declaration did not name is not printed, because the
 * scheduler's default zone is the store's fact, not this card's.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

const pad = (value: number): string => String(value).padStart(2, "0")

const inRange = (field: string, max: number): number | undefined => {
  if (!/^\d+$/.test(field)) return undefined
  const value = Number(field)
  return value <= max ? value : undefined
}

/** `1,3,5` or `1-5` as day names; undefined for anything the shorthand cannot say. */
const dayNames = (field: string): ReadonlyArray<string> | undefined => {
  const range = /^(\d)-(\d)$/.exec(field)
  const numbers = range === null
    ? field.split(",").map((part) => inRange(part, 7))
    : Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, index) => Number(range[1]) + index)
  if (numbers.some((day) => day === undefined || day > 7)) return undefined
  return numbers.map((day) => DAY_NAMES[(day as number) % 7] as string)
}

const withZone = (text: string, timezone: string | undefined): string =>
  timezone === undefined ? text : `${text} ${timezone}`

/**
 * The plain-English event for one trigger's schedule.
 *
 * @param cron the five-field expression as stored
 * @param timezone the declared zone, when the declaration named one
 */
export const describeSchedule = (cron: string, timezone?: string): string => {
  const fields = cron.trim().split(/\s+/)
  const fallback = withZone(`On the schedule ${cron.trim()}`, timezone)
  if (fields.length !== 5) return fallback
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  const anyDay = dayOfMonth === "*" && month === "*" && dayOfWeek === "*"
  const everyNMinutes = /^\*\/(\d+)$/.exec(minute)
  const everyNHours = /^\*\/(\d+)$/.exec(hour)
  const atMinute = inRange(minute, 59)
  const atHour = inRange(hour, 23)
  if (anyDay && minute === "*" && hour === "*") return "Every minute"
  if (anyDay && everyNMinutes !== null && hour === "*") return `Every ${everyNMinutes[1]} minutes`
  if (anyDay && atMinute !== undefined && hour === "*") {
    return atMinute === 0 ? "Every hour" : `Every hour at ${pad(atMinute)} minutes past`
  }
  if (anyDay && atMinute !== undefined && everyNHours !== null) return `Every ${everyNHours[1]} hours`
  if (atMinute === undefined || atHour === undefined) return fallback
  const time = `${pad(atHour)}:${pad(atMinute)}`
  if (dayOfMonth === "*" && month === "*") {
    if (dayOfWeek === "*") return withZone(`Every day at ${time}`, timezone)
    if (dayOfWeek === "1-5") return withZone(`Every weekday at ${time}`, timezone)
    const days = dayNames(dayOfWeek)
    if (days !== undefined) return withZone(`Every ${days.join(", ")} at ${time}`, timezone)
    return fallback
  }
  const day = inRange(dayOfMonth, 31)
  if (day !== undefined && day > 0 && month === "*" && dayOfWeek === "*") {
    return withZone(`Monthly on day ${day} at ${time}`, timezone)
  }
  return fallback
}
