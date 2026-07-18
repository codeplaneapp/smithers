import { estimateCostUsd } from "@smithers-orchestrator/scorers/estimateCostUsd";
import { modelTokenPrices } from "@smithers-orchestrator/scorers/modelTokenPrices";

const value = (
  row,
  camel,
  snake = camel.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
) => row[camel] ?? row[snake];
const number = (raw) => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};
const finiteNumber = (raw) => {
  const parsed = typeof raw === "number" || typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const allFree = (price) =>
  price.input === 0 && price.output === 0 && price.cacheRead === 0 && price.cacheWrite === 0;

/** Aggregate persisted attempt-completion usage without exposing raw events. */
export function aggregateTokenUsageEvents(rows, { nowMs = Date.now(), bucketMs = 60_000, maxBuckets = 60 } = {}) {
  const groups = new Map();
  const buckets = new Map();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    tokens: 0,
    costUsd: 0,
    eventCount: 0,
  };
  let firstTimestampMs;
  let lastTimestampMs;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.type !== "TokenUsageReported") continue;
    let payload;
    try {
      payload = JSON.parse(row.payloadJson ?? row.payload_json);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    const model = typeof payload.model === "string" && payload.model ? payload.model : "unknown";
    // Engine is the execution dimension. Older emitters called it agent, so
    // keep that spelling as a wire-compatible fallback.
    const engineValue = payload.engine ?? payload.agent;
    const engine = typeof engineValue === "string" && engineValue ? engineValue : "unknown";
    // Timestamp is part of the canonical event payload, but old/imported rows
    // may only carry the persisted event-column value.
    const timestampMs = finiteNumber(value(payload, "timestampMs") ?? value(row, "timestampMs"));
    if (timestampMs === undefined) continue;
    const usage = {
      inputTokens: number(value(payload, "inputTokens")),
      outputTokens: number(value(payload, "outputTokens")),
      cacheReadTokens: number(value(payload, "cacheReadTokens")),
      cacheWriteTokens: number(value(payload, "cacheWriteTokens")),
      reasoningTokens: number(value(payload, "reasoningTokens")),
    };
    // BudgetTracker accumulates only request input/output. Cache and reasoning
    // are useful detail fields but must not inflate the run-token budget.
    usage.tokens = usage.inputTokens + usage.outputTokens;
    const embedded = finiteNumber(value(payload, "costUsd") ?? payload.cost);
    const costUsd = embedded ?? estimateCostUsd({ model, ...usage });
    const key = `${engine}\u00b7${model}`;
    const group = groups.get(key) ?? {
      engine,
      model,
      ...Object.fromEntries(Object.keys(usage).map((field) => [field, 0])),
      costUsd: 0,
      eventCount: 0,
      firstTimestampMs: timestampMs,
      lastTimestampMs: timestampMs,
      missingEmbeddedCost: false,
    };
    for (const field of Object.keys(usage)) group[field] += usage[field];
    group.costUsd += costUsd;
    group.eventCount++;
    group.missingEmbeddedCost ||= embedded === undefined;
    group.firstTimestampMs = Math.min(group.firstTimestampMs, timestampMs);
    group.lastTimestampMs = Math.max(group.lastTimestampMs, timestampMs);
    groups.set(key, group);
    for (const field of Object.keys(usage)) totals[field] += usage[field];
    totals.costUsd += costUsd;
    totals.eventCount++;
    firstTimestampMs = firstTimestampMs === undefined ? timestampMs : Math.min(firstTimestampMs, timestampMs);
    lastTimestampMs = lastTimestampMs === undefined ? timestampMs : Math.max(lastTimestampMs, timestampMs);
    const startMs = Math.floor(timestampMs / bucketMs) * bucketMs;
    const bucket = buckets.get(startMs) ?? { startMs, tokens: 0, eventCount: 0 };
    bucket.tokens += usage.tokens;
    bucket.eventCount++;
    buckets.set(startMs, bucket);
  }
  const resultGroups = [...groups.values()].map(({ missingEmbeddedCost, ...group }) => ({
    ...group,
    // A single event-supplied cost cannot price the other unknown-model events:
    // displaying their partial sum as authoritative would understate the run.
    priced: !(group.tokens > 0 && allFree(modelTokenPrices(group.model)) && missingEmbeddedCost),
  }));
  const resultBuckets = [...buckets.values()].sort((a, b) => a.startMs - b.startMs).slice(-maxBuckets);
  return { totals, groups: resultGroups, buckets: resultBuckets, firstTimestampMs, lastTimestampMs, generatedAtMs: nowMs };
}
