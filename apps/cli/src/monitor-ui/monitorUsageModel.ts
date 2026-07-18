import { asArray, asNumber, asString, isRecord } from "./monitorModel.ts";

const value = (
  row: Record<string, unknown>,
  camel: string,
  snake = camel.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
) => row[camel] ?? row[snake];

const num = (row: Record<string, unknown>, key: string) => asNumber(value(row, key)) ?? 0;

const dataOf = (body: unknown): unknown =>
  isRecord(body) && body.ok === true && "data" in body ? body.data : body;

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  tokens: number;
  costUsd: number;
};

export type RunTokenUsage = {
  totals: UsageTotals;
  groups: Array<Record<string, unknown>>;
  buckets: Array<Record<string, unknown>>;
};

export function runTokenUsageOf(body: unknown): RunTokenUsage | null {
  body = dataOf(body);
  if (!isRecord(body) || !isRecord(body.totals)) return null;
  const totals = body.totals;
  return {
    totals: {
      inputTokens: num(totals, "inputTokens"),
      outputTokens: num(totals, "outputTokens"),
      cacheReadTokens: num(totals, "cacheReadTokens"),
      cacheWriteTokens: num(totals, "cacheWriteTokens"),
      reasoningTokens: num(totals, "reasoningTokens"),
      tokens: num(totals, "tokens"),
      costUsd: num(totals, "costUsd"),
    },
    groups: asArray(body.groups).filter(isRecord),
    buckets: asArray(body.buckets).filter(isRecord),
  };
}

export function usageReportsOf(body: unknown): Array<Record<string, unknown>> {
  return asArray(dataOf(body)).filter(isRecord);
}

export function costRowsOf(body: unknown) {
  const usage = runTokenUsageOf(body);
  if (!usage) return { rows: [], totalUsd: 0, unpriced: false };
  const rows = usage.groups.map((group) => ({
    model: asString(value(group, "model")) ?? "unknown",
    engine: asString(value(group, "engine")) ?? asString(value(group, "agent")) ?? "unknown",
    tokens: num(group, "tokens"),
    costUsd: num(group, "costUsd"),
    priced: value(group, "priced") !== false,
  }));
  return { rows, totalUsd: usage.totals.costUsd, unpriced: rows.some((row) => !row.priced) };
}

export function burnRateTokensPerMin(buckets: Array<Record<string, unknown>>, nowMs: number, windowMs = 5 * 60_000): number | null {
  const valid = buckets.filter((bucket) => {
    const start = num(bucket, "startMs");
    return start > nowMs - windowMs && start <= nowMs;
  });
  if (!valid.length) return null;
  const tokens = valid.reduce((sum, bucket) => sum + num(bucket, "tokens"), 0);
  const first = Math.min(...valid.map((bucket) => num(bucket, "startMs")));
  return tokens / Math.max(1, (nowMs - first) / 60_000);
}

export function projectedRunTokens(totals: UsageTotals, progressRatio: number | undefined, active = true): number | null {
  return active && progressRatio !== undefined && progressRatio >= 0.05 && progressRatio <= 1 ? totals.tokens / progressRatio : null;
}

export type PercentSample = { atMs: number; percent: number };

// useNowMs ticks each second. Keep more than five minutes so the runout
// estimator's minimum observation span remains reachable between API polls.
export function pushPercentSample(samples: PercentSample[], percent: number, atMs: number, max = 600): PercentSample[] {
  return [...samples, { percent, atMs }].slice(-max);
}

export function percentBurnPerMin(samples: PercentSample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const durationMs = last.atMs - first.atMs;
  return durationMs >= 300_000 && last.percent > first.percent
    ? (last.percent - first.percent) / (durationMs / 60_000)
    : null;
}

export function projectWindowRunout(samples: PercentSample[], resetsAtMs: number): number | null {
  const rate = percentBurnPerMin(samples);
  if (!rate) return null;
  const last = samples[samples.length - 1];
  const at = last.atMs + ((100 - last.percent) / rate) * 60_000;
  return at < resetsAtMs ? at : null;
}

export function runoutWarning(runoutAtMs: number | null, resetsAtMs: number): string | null {
  if (!runoutAtMs || resetsAtMs - runoutAtMs < 60_000) return null;
  const minutes = Math.round((resetsAtMs - runoutAtMs) / 60_000);
  // Keep sub-hour gaps in minutes: rounding a ten-minute gap up to "~1h"
  // overstates a warning whose whole purpose is an honest time comparison.
  const lead = minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
  return `runs out ~${lead} before reset`;
}

export function formatTokensCompact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}
