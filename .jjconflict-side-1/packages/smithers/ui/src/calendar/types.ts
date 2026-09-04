/**
 * The calendar lane's data model. Pure data in, rendered chrome out — the
 * component never fetches; a host binding (a cron-schedule hook, say) expands
 * its own domain rows into these events.
 */
export type CalendarEvent = {
  /** Stable unique id (used for keys and click identity). */
  id: string;
  title: string;
  /** Unix epoch milliseconds. */
  start: number;
  /** Unix epoch milliseconds; point events omit it. */
  end?: number;
  /** Render in the all-day lane (week) / without a time prefix (month). */
  allDay?: boolean;
  /** Recurrence descriptor (rrule, cron pattern, ...) shown as metadata only. */
  rrule?: string;
  /** Grouping/label key; drives the default tint when `color` is absent. */
  source?: string;
  /** Shared status vocabulary string; rendered as the chip's status dot. */
  status?: string;
  /** Optional navigation target when the event has no click handler. */
  href?: string;
  /** Explicit CSS color override; bypasses the per-source tint rotation. */
  color?: string;
};

export type CalendarView = "month" | "week" | "agenda";
