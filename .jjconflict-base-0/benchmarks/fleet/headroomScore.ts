import type { SubscriptionUsage } from "./SubscriptionUsage";

/**
 * How much benchmark work a subscription can still absorb, as a 0-1 fraction
 * (1 = fully free, 0 = the most-constrained window is exhausted).
 *
 * The governing window is whichever of the three is closest to its cap, because
 * hitting any one of them throttles the whole account. With no usage data we
 * assume full headroom, which makes `planShards` degrade to plain round-robin.
 */
export function headroomScore(usage: SubscriptionUsage | undefined): number {
  if (!usage) return 1;
  const pcts = [usage.fiveHourPct, usage.weeklyPct, usage.weeklyOpusPct].filter(
    (p): p is number => typeof p === "number" && Number.isFinite(p),
  );
  if (pcts.length === 0) return 1;
  const worst = Math.max(...pcts);
  const headroom = 1 - worst / 100;
  if (headroom < 0) return 0;
  if (headroom > 1) return 1;
  return headroom;
}
