import { expect, test } from "bun:test";
import { aggregateTokenUsageEvents } from "../src/gatewayRoutes/getRunTokenUsage.js";

test("aggregates token events, defaults optional splits, and ignores malformed rows", () => {
  const rows = [
    { type: "TokenUsageReported", payloadJson: JSON.stringify({ agent: "a", model: "gpt-5.6-luna", inputTokens: 10, outputTokens: 5, timestampMs: 1_000 }) },
    { type: "TokenUsageReported", payload_json: JSON.stringify({ agent: "a", model: "gpt-5.6-luna", inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, timestampMs: 61_000 }) },
    { type: "TokenUsageReported", payloadJson: "nope" },
  ];
  const result = aggregateTokenUsageEvents(rows, { nowMs: 99_000, maxBuckets: 1 });
  expect(result.totals).toMatchObject({ inputTokens: 12, outputTokens: 8, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 0, tokens: 20, eventCount: 2 });
  expect(result.groups[0]).toMatchObject({ engine: "a", eventCount: 2, firstTimestampMs: 1_000, lastTimestampMs: 61_000, priced: true });
  expect(result).toMatchObject({ firstTimestampMs: 1_000, lastTimestampMs: 61_000 });
  expect(result.buckets).toEqual([{ startMs: 60_000, tokens: 5, eventCount: 1 }]);
  expect(result.totals.costUsd).toBeCloseTo(0.0000601, 10);
});

test("marks unknown priced models unpriced and prefers embedded cost", () => {
  const result = aggregateTokenUsageEvents([{ type: "TokenUsageReported", payloadJson: JSON.stringify({ model: "future", agent: "x", inputTokens: 4, timestampMs: 1, cost: 7 }) }]);
  expect(result.groups[0]).toMatchObject({ priced: true, costUsd: 7 });
  expect(result.totals.costUsd).toBe(7);
});

test("unknown models without an authoritative event cost are unpriced and empty input is zero", () => {
  const result = aggregateTokenUsageEvents([{ type: "TokenUsageReported", payloadJson: JSON.stringify({ model: "future", agent: "x", inputTokens: 4, timestampMs: 1 }) }]);
  expect(result.groups[0]).toMatchObject({ priced: false, costUsd: 0 });
  expect(aggregateTokenUsageEvents([]).totals).toMatchObject({ tokens: 0, eventCount: 0 });
});

test("a mixed unknown-model group stays unpriced when any event lacks its own cost", () => {
  const result = aggregateTokenUsageEvents([
    { type: "TokenUsageReported", payloadJson: JSON.stringify({ model: "future", agent: "x", inputTokens: 4, timestampMs: 1, costUsd: 7 }) },
    { type: "TokenUsageReported", payloadJson: JSON.stringify({ model: "future", agent: "x", inputTokens: 4, timestampMs: 2 }) },
  ]);
  expect(result.groups[0]).toMatchObject({ costUsd: 7, eventCount: 2, priced: false });
});

test("reads snake-case payload fields and falls back to persisted row timestamps", () => {
  const result = aggregateTokenUsageEvents([{
    type: "TokenUsageReported",
    timestamp_ms: 61_000,
    payload_json: JSON.stringify({ model: "future", agent: "x", input_tokens: 4, cost_usd: 2 }),
  }]);
  expect(result.totals).toMatchObject({ inputTokens: 4, tokens: 4, costUsd: 2, eventCount: 1 });
  expect(result).toMatchObject({ firstTimestampMs: 61_000, lastTimestampMs: 61_000 });
});

test("does not treat null cost or non-finite token strings as authoritative numbers", () => {
  const result = aggregateTokenUsageEvents([{
    type: "TokenUsageReported",
    timestampMs: 1,
    payloadJson: JSON.stringify({ model: "future", agent: "x", inputTokens: 4, outputTokens: "Infinity", costUsd: null }),
  }]);
  expect(result.totals).toMatchObject({ inputTokens: 4, outputTokens: 0, tokens: 4, costUsd: 0, eventCount: 1 });
  expect(result.groups[0]).toMatchObject({ priced: false });
});
