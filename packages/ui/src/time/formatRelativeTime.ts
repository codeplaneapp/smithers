const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Human timestamp label: relative under 24h ("just now", "3m ago",
 * "2h 14m ago"), an absolute locale date+time beyond. Future timestamps
 * (clock skew) clamp to "just now".
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const delta = now - ts;
  if (delta < MINUTE_MS) return "just now";
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
