import { expect, test } from "bun:test";
import { burnRateTokensPerMin, costRowsOf, formatDurationCoarse, formatTokensCompact, formatUsd, percentBurnPerMin, projectWindowRunout, projectedRunTokens, pushPercentSample, runTokenUsageOf, runoutWarning, usageReportsOf } from "../src/monitor-ui/monitorUsageModel.ts";

test("reads usage and labels unknown price honestly", () => {
  const body = { totals: { tokens: 100, cost_usd: 1 }, groups: [{ model: "x", agent: "a", tokens: 100, cost_usd: 1, priced: false }], buckets: [] };
  expect(runTokenUsageOf(body)?.totals.costUsd).toBe(1);
  expect(costRowsOf(body)).toMatchObject({ totalUsd: 1, unpriced: true });
});
test("burn and projections withhold dishonest answers", () => {
  expect(burnRateTokensPerMin([{ start_ms: 9 * 60_000, tokens: 20 }], 10 * 60_000)).toBe(20);
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, tokens: 10, costUsd: 0 };
  expect(projectedRunTokens(totals, 0.5)).toBe(20);
  expect(projectedRunTokens(totals, 0.01)).toBeNull();
  const runout = projectWindowRunout([{ atMs: 0, percent: 10 }, { atMs: 600_000, percent: 30 }], 3_000_000);
  expect(runout).toBe(2_700_000);
  expect(runoutWarning(runout, 3_000_000)).toBe("runs out ~5m before reset");
  expect(formatTokensCompact(1_200_000)).toBe("1.2M"); expect(formatUsd(.001)).toBe("<$0.01");
});

test("all readers and percentage sampling are tolerant and preserve a five-minute span", () => {
  expect(runTokenUsageOf({ ok: true, data: { totals: { input_tokens: 2, outputTokens: 3 }, groups: "bad", buckets: {} } })?.totals).toMatchObject({ inputTokens: 2, outputTokens: 3, tokens: 0 });
  expect(runTokenUsageOf({ ok: true, data: [] })).toBeNull();
  expect(usageReportsOf({ ok: true, data: [{ account_label: "a" }, null] })).toHaveLength(1);
  expect(usageReportsOf({ ok: false, data: [{ accountLabel: "a" }] })).toEqual([]);
  let samples = [] as Array<{ atMs: number; percent: number }>;
  for (let i = 0; i <= 300; i++) samples = pushPercentSample(samples, i / 10, i * 1_000);
  expect(samples).toHaveLength(301);
  expect(percentBurnPerMin(samples)).toBeGreaterThan(0);
  expect(pushPercentSample(samples, 99, 999_999, 2)).toHaveLength(2);
  expect(percentBurnPerMin([{ atMs: 0, percent: 20 }, { atMs: 60_000, percent: 10 }])).toBeNull();
  expect(projectWindowRunout([{ atMs: 0, percent: 10 }, { atMs: 600_000, percent: 30 }], 2_000_000)).toBeNull();
  expect(runoutWarning(null, 10)).toBeNull();
  expect(runoutWarning(1_000, 11 * 60_000 + 1_000)).toBe("runs out ~11m before reset");
  expect(runoutWarning(1_000, 121 * 60_000 + 1_000)).toBe("runs out ~2h before reset");
  expect(formatTokensCompact(999)).toBe("999");
  expect(formatUsd(0)).toBe("$0.00");
});

test("reset countdowns are coarse two-unit durations, never a minute pile", () => {
  expect(formatDurationCoarse(8_887 * 60_000)).toBe("6d 4h");
  expect(formatDurationCoarse(59 * 60_000)).toBe("59m");
  expect(formatDurationCoarse(60 * 60_000)).toBe("1h");
  expect(formatDurationCoarse(3 * 3_600_000 + 5 * 60_000)).toBe("3h 5m");
  expect(formatDurationCoarse(48 * 3_600_000)).toBe("2d");
  expect(formatDurationCoarse(-5)).toBe("0m");
});
