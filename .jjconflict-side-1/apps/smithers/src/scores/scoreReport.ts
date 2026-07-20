/**
 * The scores surface: scorer/eval results for a run, plus the latency the
 * `smithers scores` view rolls up. Ported from the Swift ScoresView (run
 * selector + Summary/Metrics/Recent tabs), now driven by the LIVE gateway:
 * `ScoresBridge` pulls a run's rows over the `listScores` RPC (the
 * `_smithers_scorers` table) and pushes them into `scoresStore`; the canvas
 * aggregates them ON-DEMAND here via the pure roll-ups below.
 *
 * Path A (locked, docs/p1b-plan §3.3): there is NO `_smithers_run_metrics`
 * table / `getRunMetrics` RPC. The `_smithers_scorers` row carries the scorer
 * verdict + its latency/duration ONLY — there is no token or cost data on the
 * wire — so `metricsFromScores` builds a real Latency panel and leaves the
 * Token/Cost panels empty (the canvas already em-dashes those branches).
 *
 * Everything here is pure (scoreTone, humanize*, formatUsd, mean,
 * resolveActiveRunId, normalizeRunId, scorerAggregates, summaryStats,
 * metricsFromScores), so the formatters, selectors, and the live aggregation
 * are unit-tested without a DOM or a gateway (see scoresDomain.test.ts).
 */

// ---------------------------------------------------------------------------
// Canvas domain: runs, scores, and per-run metrics derived from live rows.
// ---------------------------------------------------------------------------

export type RunStatus = "completed" | "running" | "failed";

/** A run the score selector lists. `workflowName` is null when the run is anonymous. */
export type ScoresRun = {
  runId: string;
  workflowName: string | null;
  status: RunStatus;
};

/** One scorer's verdict on one eval, newest-first in the seed. */
export type ScoreRow = {
  scorer: string;
  score: number;
  reason?: string;
  /** Fixed display timestamp (no wall-clock); rendered verbatim. */
  scoredAt: string;
};

/** One labeled bucket in a byPeriod table (token/cost breakdowns). */
export type TokenPeriod = { period: string; input: number; output: number };
export type CostPeriod = { period: string; total: number; runs: number };

/** Token usage for a run; cache fields are absent when the provider reports none. */
export type TokenReport = {
  total: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  byPeriod: TokenPeriod[];
};

/** Per-node latency stats (ms); count 0 means no latency data. */
export type LatencyReport = {
  count: number;
  mean: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
};

/** Cost roll-up (USD); runCount 0 means no per-run breakdown. */
export type CostReport = {
  total: number;
  input: number;
  output: number;
  runCount: number;
  byPeriod: CostPeriod[];
};

/** Everything the three tabs render for one run, all keyed off the same runId. */
export type RunMetrics = {
  scores: ScoreRow[];
  tokens: TokenReport;
  latency: LatencyReport;
  cost: CostReport;
};

/** Per-scorer aggregate, computed from a run's ScoreRows for the Summary tab. */
export type ScorerAggregate = {
  scorer: string;
  count: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
};

/** The six Summary-tab tiles, each already humanized or em-dashed. */
export type SummaryStats = {
  evaluations: number;
  mean: string;
  tokens: string;
  avgDuration: string;
  cacheHitRate: string;
  estCost: string;
};

/** Em-dash placeholder for any metric that is unavailable. */
export const EM_DASH = "—";

// ---- Pure formatters -------------------------------------------------------

/**
 * Trim and null out an empty/whitespace run id so resolveActiveRunId can fall
 * back to the first run cleanly.
 */
export function normalizeRunId(id: string | null | undefined): string | null {
  if (id == null) return null;
  const trimmed = id.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Pick the active run id: the stored selection when it names a run in the list,
 * otherwise the first run, otherwise null (empty list). Mirrors the Swift
 * resolveActiveRunId.
 */
export function resolveActiveRunId(runs: ScoresRun[], selectedRunId: string | null): string | null {
  const normalized = normalizeRunId(selectedRunId);
  if (normalized != null && runs.some((run) => run.runId === normalized)) return normalized;
  return runs.length > 0 ? runs[0].runId : null;
}

/**
 * The score color band: >= 0.8 reads as success, >= 0.5 as warning, lower as
 * danger; non-finite scores are faint. Returns a tone class name so the cells,
 * the recent dots, and the aggregate values all share one rule.
 */
export function scoreTone(score: number): "tone-ok" | "tone-warn" | "tone-fail" | "tone-faint" {
  if (!Number.isFinite(score)) return "tone-faint";
  if (score >= 0.8) return "tone-ok";
  if (score >= 0.5) return "tone-warn";
  return "tone-fail";
}

/** Humanize a token count: >= 1e6 -> 'X.XXM', >= 1e3 -> 'X.XK', else the raw int. */
export function humanizeTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return EM_DASH;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

/** Humanize a duration in ms: >= 60000 -> 'X.Xm', >= 1000 -> 'X.XXs', else 'Xms'. */
export function humanizeDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return EM_DASH;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

/** Format a USD amount to a fixed precision (default 6 for the metric rows). */
export function formatUsd(amount: number, fractionDigits = 6): string {
  if (!Number.isFinite(amount)) return EM_DASH;
  return `$${amount.toFixed(fractionDigits)}`;
}

/** Arithmetic mean of a numeric list, or null when empty. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** A 2-decimal score string, em-dash for null/non-finite. */
export function formatScore(score: number | null): string {
  if (score == null || !Number.isFinite(score)) return EM_DASH;
  return score.toFixed(2);
}

/** Truncate a long label to maxLen with a trailing ellipsis (for period cells). */
export function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return text.slice(0, maxLen);
  const head = Math.ceil((maxLen - 1) / 2);
  const tail = Math.floor((maxLen - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** The first 8 chars of a run id, the short form the selector and rows show. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

/** Strip a leading 'run-' so the fallback label reads 'Run c4f10a99'. */
function runIdTail(runId: string): string {
  return runId.startsWith("run-") ? runId.slice(4) : runId;
}

/** The selector option label: 'workflow · status · short8', or 'Run <8>' anonymous. */
export function runLabel(run: ScoresRun): string {
  if (run.workflowName == null || run.workflowName.trim() === "") {
    return `Run ${shortRunId(runIdTail(run.runId))}`;
  }
  return `${run.workflowName} · ${run.status} · ${shortRunId(runIdTail(run.runId))}`;
}

// ---- Pure aggregations -----------------------------------------------------

/** The median (P50) of a numeric list, or null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Roll a run's ScoreRows into one aggregate card per scorer (first-seen order),
 * each carrying Mean / Min / Max / P50 over that scorer's scores.
 */
export function scorerAggregates(scores: ScoreRow[]): ScorerAggregate[] {
  const order: string[] = [];
  const byScorer = new Map<string, number[]>();
  for (const row of scores) {
    if (!byScorer.has(row.scorer)) {
      byScorer.set(row.scorer, []);
      order.push(row.scorer);
    }
    byScorer.get(row.scorer)!.push(row.score);
  }
  return order.map((scorer) => {
    const values = byScorer.get(scorer)!;
    return {
      scorer,
      count: values.length,
      mean: mean(values),
      min: values.length > 0 ? Math.min(...values) : null,
      max: values.length > 0 ? Math.max(...values) : null,
      p50: median(values),
    };
  });
}

/** The six Summary tiles, derived from a run's full metrics. */
export function summaryStats(metrics: RunMetrics): SummaryStats {
  const scoreValues = metrics.scores.map((row) => row.score);
  const meanScore = mean(scoreValues);
  const cacheRead = metrics.tokens.cacheRead ?? 0;
  const cacheWrite = metrics.tokens.cacheWrite ?? 0;
  const cacheTotal = cacheRead + cacheWrite;
  const cacheable = cacheTotal + metrics.tokens.input;
  const hasCache = metrics.tokens.cacheRead != null || metrics.tokens.cacheWrite != null;

  return {
    evaluations: metrics.scores.length,
    mean: meanScore == null ? EM_DASH : meanScore.toFixed(2),
    tokens: metrics.tokens.total > 0 ? humanizeTokens(metrics.tokens.total) : EM_DASH,
    avgDuration: metrics.latency.count > 0 ? humanizeDurationMs(metrics.latency.mean) : EM_DASH,
    cacheHitRate:
      hasCache && cacheable > 0 ? `${((cacheRead / cacheable) * 100).toFixed(1)}%` : EM_DASH,
    estCost: metrics.cost.total > 0 ? formatUsd(metrics.cost.total, 4) : EM_DASH,
  };
}

/** The cache hit % for the Token Usage panel, or null when no cache data. */
export function cacheHitPercent(tokens: TokenReport): number | null {
  if (tokens.cacheRead == null && tokens.cacheWrite == null) return null;
  const cacheRead = tokens.cacheRead ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const cacheable = cacheRead + cacheWrite + tokens.input;
  if (cacheable <= 0) return null;
  return (cacheRead / cacheable) * 100;
}

/** Per-run cost: total / runCount, or null when runCount is 0. */
export function costPerRun(cost: CostReport): number | null {
  if (cost.runCount <= 0) return null;
  return cost.total / cost.runCount;
}

// ---- Live aggregation (Path A: client-side, from listScores rows) ----------

/**
 * The minimal score-row shape the client-side aggregation needs — a structural
 * subset of `GatewayScoreRow` (the `listScores` RPC row), so the bridge can push
 * gateway rows in directly without a mapping pass. Kept gateway-free here so the
 * domain module stays dependency-light and unit-testable.
 */
export type ScoreSample = {
  runId: string;
  scorerName: string;
  score: number;
  reason?: string | null;
  scoredAtMs: number;
  latencyMs?: number | null;
  durationMs?: number | null;
};

/** An all-empty metrics block (no run selected, or a run with no scorer rows). */
export function emptyRunMetrics(): RunMetrics {
  return {
    scores: [],
    tokens: { total: 0, input: 0, output: 0, byPeriod: [] },
    latency: { count: 0, mean: 0, min: 0, p50: 0, p95: 0, max: 0 },
    cost: { total: 0, input: 0, output: 0, runCount: 0, byPeriod: [] },
  };
}

/**
 * Format a scorer's `scored_at_ms` epoch into the `YYYY-MM-DD HH:mm` label the
 * Recent tab renders. Uses UTC so the rendering is deterministic regardless of
 * the viewer's timezone (load-bearing for the e2e assertion).
 */
export function formatScoredAt(scoredAtMs: number): string {
  if (!Number.isFinite(scoredAtMs)) return EM_DASH;
  return new Date(scoredAtMs).toISOString().slice(0, 16).replace("T", " ");
}

/** The p-th percentile (0..1) of a numeric list by nearest-rank, or null when empty. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * Roll a run's scorer rows' latency samples into a LatencyReport. Each row's
 * `latencyMs` is the scorer's own latency; we fall back to `durationMs` when a
 * row reports no scorer latency. Rows with neither are excluded from `count`, so
 * `count === 0` (and the canvas's "No latency data" branch) is reached honestly
 * when the run recorded no timing at all.
 */
export function latencyFromScores(rows: ScoreSample[]): LatencyReport {
  const samples: number[] = [];
  for (const row of rows) {
    const sample = typeof row.latencyMs === "number" ? row.latencyMs : row.durationMs;
    if (typeof sample === "number" && Number.isFinite(sample)) samples.push(sample);
  }
  if (samples.length === 0) return { count: 0, mean: 0, min: 0, p50: 0, p95: 0, max: 0 };
  return {
    count: samples.length,
    mean: mean(samples) ?? 0,
    min: Math.min(...samples),
    p50: median(samples) ?? 0,
    p95: percentile(samples, 0.95) ?? 0,
    max: Math.max(...samples),
  };
}

/**
 * Build the active run's `RunMetrics` from its live `listScores` rows. Filters
 * to `runId` (the rows are already run-scoped by the RPC, but a stale push
 * during a run switch could carry the previous run's rows), maps each row to a
 * Recent-tab `ScoreRow` newest-first, and derives the Latency panel. Token/Cost
 * stay empty: the `_smithers_scorers` table carries no token/cost data, and
 * Path A computes tiles ONLY from these rows (no run-metrics backend) — so those
 * panels render their honest empty state rather than a fabricated number.
 */
export function metricsFromScores(rows: ScoreSample[], runId: string | null): RunMetrics {
  if (runId == null) return emptyRunMetrics();
  const forRun = rows.filter((row) => row.runId === runId);
  const scores: ScoreRow[] = forRun
    .slice()
    .sort((a, b) => b.scoredAtMs - a.scoredAtMs)
    .map((row) => ({
      scorer: row.scorerName,
      score: row.score,
      reason: row.reason == null || row.reason === "" ? undefined : row.reason,
      scoredAt: formatScoredAt(row.scoredAtMs),
    }));
  return {
    scores,
    tokens: { total: 0, input: 0, output: 0, byPeriod: [] },
    latency: latencyFromScores(forRun),
    cost: { total: 0, input: 0, output: 0, runCount: 0, byPeriod: [] },
  };
}
