/**
 * A snapshot of one Claude subscription's rate-limit windows, as reported by
 * `GET /api/oauth/usage` (see `packages/usage`). Percentages are 0-100.
 *
 * `weeklyOpusPct` is the binding constraint for a benchmark fleet: the weekly
 * Opus cap (~24-40 Opus-hours/week on Max 20x) is what runs out first when many
 * agents share one account.
 */
export type SubscriptionUsage = {
  fiveHourPct?: number;
  weeklyPct?: number;
  weeklyOpusPct?: number;
  /** ISO time the most-constrained window resets, if known. */
  resetsAt?: string;
};
