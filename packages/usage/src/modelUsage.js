/**
 * Token counters emitted by the flows model stream. `inputTokens` includes
 * cached reads and writes; the other input counters are breakdowns.
 *
 * This module intentionally consumes the structural ModelEvent contract. It
 * does not import a runtime schema, so persisted/replayed events can be folded
 * without constructing Effect schema values first.
 */

/** @param {unknown} value */
function count(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** @param {unknown} value */
function record(value) {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/**
 * Convert one flows `ModelEvent.Usage` event to Smithers' durable usage row.
 * Returns null for non-usage events and for empty provider reports.
 *
 * @param {unknown} value
 * @returns {{ inputTokens: number; freshInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; totalTokens: number } | null}
 */
export function usageFromModelEvent(value) {
  const event = record(value);
  if (event?.type !== "usage") return null;
  const inputTokens = count(event.inputTokens);
  const outputTokens = count(event.outputTokens);
  const cacheReadTokens = count(event.cachedInputTokens);
  const cacheWriteTokens = count(event.cacheWriteTokens);
  const reasoningTokens = count(event.reasoningTokens);
  const reportedTotal = count(event.totalTokens);
  if (!(inputTokens > 0 || outputTokens > 0 || reportedTotal > 0)) return null;
  return {
    inputTokens,
    freshInputTokens: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
  };
}

/** @param {unknown} value @returns {Array<Record<string, unknown>>} */
function modelEventsIn(value) {
  if (Array.isArray(value)) return value.flatMap(modelEventsIn);
  const item = record(value);
  if (!item) return [];
  if (item.type === "usage" || item.type === "settle") return [item];
  for (const key of ["modelEvent", "event", "payload", "payloadJson", "data", "events"]) {
    if (key in item) {
      const found = modelEventsIn(item[key]);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/**
 * Fold persisted flows model events. Providers may refine a usage event before
 * `settle`, so only the last usage report in each settled request is counted.
 * Concatenated replay streams are therefore safe from cumulative double-counts.
 *
 * @param {Iterable<unknown>} values
 */
export function foldModelUsageEvents(values) {
  const total = {
    inputTokens: 0,
    freshInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requests: 0,
  };
  let pending = null;
  const commit = () => {
    if (!pending) return;
    for (const key of [
      "inputTokens",
      "freshInputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "reasoningTokens",
      "totalTokens",
    ]) {
      total[key] += pending[key];
    }
    total.requests += 1;
    pending = null;
  };
  for (const value of values) {
    for (const event of modelEventsIn(value)) {
      if (event.type === "usage") pending = usageFromModelEvent(event);
      else if (event.type === "settle") commit();
    }
  }
  commit();
  return total;
}
