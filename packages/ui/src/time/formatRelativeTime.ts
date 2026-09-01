const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Human timestamp label: relative under 24h ("just now", "3m ago",
 * "2h 14m ago"), an absolute locale date+time beyond. Future timestamps
 * (clock skew) clamp to "just now".
 *
 * The sub-second branch is what the doc has always promised and the code did
 * not have: without it a timestamp created this instant read "0s ago", and so
 * did one a minute in the future.
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  // Outside the ECMAScript time-value range there is no instant to describe,
  // and every branch below would fall through to "Invalid Date, Invalid Date".
  if (!Number.isFinite(ts) || Math.abs(ts) > 8.64e15) return "unknown time";
  const delta = now - ts;
  if (delta < 1000) return "just now";
  if (delta < MINUTE_MS) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m ago`;
  if (delta < DAY_MS) {
    const hours = Math.floor(delta / HOUR_MS);
    const minutes = Math.floor((delta % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours}h ago` : `${hours}h ${minutes}m ago`;
  }
  const date = new Date(ts);
  const datePart = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const timePart = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart}, ${timePart}`;
}
