import type { Item, WindowFilterOutput } from "./schemas";

/** Strict [windowStart, windowEnd) filter on publishedAt only — retrievedAt is never a substitute. */
export function filterToWindow(items: Item[], windowStart: string, windowEnd: string): WindowFilterOutput {
  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  const inWindow = items.filter((item) => {
    if (item.publishedAt === null) return false;
    const publishedMs = Date.parse(item.publishedAt);
    return Number.isFinite(publishedMs) && publishedMs >= startMs && publishedMs < endMs;
  });
  return {
    inWindowCount: inWindow.length,
    droppedCount: items.length - inWindow.length,
    items: inWindow,
    summary: `${inWindow.length} of ${items.length} items fall inside the 24h window; ${items.length - inWindow.length} dropped (out of window or undated).`,
  };
}
