import { asNumber, asString, pick, type RunRow } from "./monitorModel.ts";
import { costRowsOf, runTokenUsageOf } from "./monitorUsageModel.ts";

const dayStart = (nowMs: number): number => {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/** Runs are deliberately scoped to this gateway and to their local start day. */
export function runsStartedTodayOf(runs: RunRow[], nowMs: number): RunRow[] {
  const cutoff = dayStart(nowMs);
  return runs.filter((run) => {
    const row = run as Record<string, unknown>;
    const started = asNumber(pick(row, "startedAtMs", "started_at_ms")) ?? asNumber(pick(row, "createdAtMs", "created_at_ms"));
    return started !== undefined && started >= cutoff && started <= nowMs;
  });
}

export function runIdOf(run: RunRow): string | undefined {
  return asString(pick(run as Record<string, unknown>, "runId", "run_id"));
}

/** The landing card must not turn a busy workspace into an unbounded request burst. */
export function capCostFetchSet(runIds: string[], max = 25): { runIds: string[]; skippedCount: number } {
  const unique = [...new Set(runIds.filter(Boolean))];
  return { runIds: unique.slice(0, max), skippedCount: Math.max(0, unique.length - max) };
}

export type CostEnvelope = { body?: unknown; failed?: boolean };

export function foldWorkspaceCost(envelopes: CostEnvelope[], skippedCount = 0) {
  let totalUsd = 0;
  let pricedRuns = 0;
  let unpricedRuns = 0;
  let failedRuns = 0;
  for (const envelope of envelopes) {
    if (envelope.failed) { failedRuns++; continue; }
    const usage = runTokenUsageOf(envelope.body);
    if (!usage) { failedRuns++; continue; }
    const costs = costRowsOf(envelope.body);
    if (costs.unpriced) unpricedRuns++;
    else { pricedRuns++; totalUsd += costs.totalUsd; }
  }
  return { totalUsd, pricedRuns, unpricedRuns, failedRuns, fetchedCount: envelopes.length, skippedCount };
}
