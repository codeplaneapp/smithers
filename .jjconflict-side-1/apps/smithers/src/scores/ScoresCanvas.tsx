import "./scores.css";
import {
  cacheHitPercent,
  costPerRun,
  EM_DASH,
  formatScore,
  formatUsd,
  humanizeDurationMs,
  humanizeTokens,
  metricsFromScores,
  resolveActiveRunId,
  runLabel,
  scorerAggregates,
  scoreTone,
  summaryStats,
  truncateMiddle,
  type CostReport,
  type LatencyReport,
  type RunMetrics,
  type ScoreRow,
  type TokenReport,
} from "./scoreReport";
import { useScoresStore, type ScoreTab } from "./scoresStore";

const TABS: { id: ScoreTab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "metrics", label: "Metrics" },
  { id: "recent", label: "Recent" },
];

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One label-left / value-right detail row inside a Metrics panel. */
function DetailRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="scores-detail-row">
      <span className="scores-detail-label">{label}</span>
      <span className={tone ? `scores-detail-value ${tone}` : "scores-detail-value"}>{value}</span>
    </div>
  );
}

/** The six Summary tiles + the per-scorer aggregate cards. */
function SummaryTab({ metrics }: { metrics: RunMetrics }) {
  const stats = summaryStats(metrics);
  const aggregates = scorerAggregates(metrics.scores);
  const tiles: { name: string; value: string }[] = [
    { name: "evaluations", value: String(stats.evaluations) },
    { name: "mean score", value: stats.mean },
    { name: "tokens", value: stats.tokens },
    { name: "avg duration", value: stats.avgDuration },
    { name: "cache hit", value: stats.cacheHitRate },
    { name: "est. cost", value: stats.estCost },
  ];

  return (
    <div data-testid="scores-tab-summary">
      <div className="score-tiles scores-tiles-6">
        {tiles.map((tile) => (
          <div className="score-tile" key={tile.name}>
            <div className="tile-name">{tile.name}</div>
            <div className="tile-value">{tile.value}</div>
          </div>
        ))}
      </div>

      <div className="scores-section-head">Per-scorer statistics</div>
      {aggregates.length > 0 ? (
        aggregates.map((aggregate) => (
          <div className="scores-aggregate" key={aggregate.scorer}>
            <div className="scores-aggregate-head">
              <span className="scores-aggregate-name">{aggregate.scorer}</span>
              <span className="scores-aggregate-count">
                {aggregate.count} {aggregate.count === 1 ? "eval" : "evals"}
              </span>
            </div>
            <div className="scores-aggregate-cells">
              {(
                [
                  { label: "Mean", value: aggregate.mean },
                  { label: "Min", value: aggregate.min },
                  { label: "Max", value: aggregate.max },
                  { label: "P50", value: aggregate.p50 },
                ] as const
              ).map((cell) => (
                <div className="scores-cell" key={cell.label}>
                  <div className="scores-cell-label">{cell.label}</div>
                  <div
                    className={
                      cell.value == null
                        ? "scores-cell-value tone-faint"
                        : `scores-cell-value ${scoreTone(cell.value)}`
                    }
                  >
                    {formatScore(cell.value)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="scores-panel-empty">No scorer data</div>
      )}
    </div>
  );
}

/** The Token Usage panel: totals, optional cache rows, and a byPeriod table. */
function TokenPanel({ tokens }: { tokens: TokenReport }) {
  const hasData = tokens.total > 0;
  const hasCache = tokens.cacheRead != null || tokens.cacheWrite != null;
  const hitPercent = cacheHitPercent(tokens);

  return (
    <div className="scores-panel">
      <div className="scores-panel-title">Token Usage</div>
      {hasData ? (
        <>
          <DetailRow label="Total" value={humanizeTokens(tokens.total)} />
          <DetailRow label="Input" value={humanizeTokens(tokens.input)} />
          <DetailRow label="Output" value={humanizeTokens(tokens.output)} />
          {hasCache ? (
            <>
              <DetailRow label="Cache read" value={humanizeTokens(tokens.cacheRead ?? 0)} />
              <DetailRow label="Cache write" value={humanizeTokens(tokens.cacheWrite ?? 0)} />
              <DetailRow
                label="Cache hit %"
                value={hitPercent == null ? EM_DASH : `${hitPercent.toFixed(1)}%`}
              />
            </>
          ) : null}
          {tokens.byPeriod.length > 0 ? (
            <>
              <div className="scores-period-divider" />
              <div className="scores-period-table">
                <span className="scores-period-head">Period</span>
                <span className="scores-period-head is-num">Input</span>
                <span className="scores-period-head is-num">Output</span>
                {tokens.byPeriod.map((row) => (
                  <div className="scores-period-row" key={row.period}>
                    <span className="scores-period-cell is-label">
                      {truncateMiddle(row.period, 30)}
                    </span>
                    <span className="scores-period-cell is-num">{humanizeTokens(row.input)}</span>
                    <span className="scores-period-cell is-num">{humanizeTokens(row.output)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : (
        <div className="scores-panel-empty">No token data available.</div>
      )}
    </div>
  );
}

/** The Latency panel: count + the mean/min/p50/p95/max duration rows. */
function LatencyPanel({ latency }: { latency: LatencyReport }) {
  return (
    <div className="scores-panel">
      <div className="scores-panel-title">Latency</div>
      {latency.count > 0 ? (
        <>
          <DetailRow label="Count" value={`${latency.count} nodes`} />
          <DetailRow label="Mean" value={humanizeDurationMs(latency.mean)} />
          <DetailRow label="Min" value={humanizeDurationMs(latency.min)} />
          <DetailRow label="P50" value={humanizeDurationMs(latency.p50)} />
          <DetailRow label="P95" value={humanizeDurationMs(latency.p95)} />
          <DetailRow label="Max" value={humanizeDurationMs(latency.max)} />
        </>
      ) : (
        <div className="scores-panel-empty">No latency data available.</div>
      )}
    </div>
  );
}

/** The Cost Tracking panel: USD totals, per-run, and a byPeriod table. */
function CostPanel({ cost }: { cost: CostReport }) {
  const hasData = cost.total > 0;
  const perRun = costPerRun(cost);

  return (
    <div className="scores-panel">
      <div className="scores-panel-title">Cost Tracking</div>
      {hasData ? (
        <>
          <DetailRow label="Total" value={`${formatUsd(cost.total)} USD`} />
          <DetailRow label="Input" value={`${formatUsd(cost.input)} USD`} />
          <DetailRow label="Output" value={`${formatUsd(cost.output)} USD`} />
          {cost.runCount > 0 ? (
            <>
              <DetailRow label="Runs" value={String(cost.runCount)} />
              <DetailRow label="Per run" value={perRun == null ? EM_DASH : formatUsd(perRun)} />
            </>
          ) : null}
          {cost.byPeriod.length > 0 ? (
            <>
              <div className="scores-period-divider" />
              <div className="scores-period-table">
                <span className="scores-period-head">Period</span>
                <span className="scores-period-head is-num">Total</span>
                <span className="scores-period-head is-num">Runs</span>
                {cost.byPeriod.map((row) => (
                  <div className="scores-period-row" key={row.period}>
                    <span className="scores-period-cell is-label">
                      {truncateMiddle(row.period, 30)}
                    </span>
                    <span className="scores-period-cell is-num">{formatUsd(row.total)}</span>
                    <span className="scores-period-cell is-num">{row.runs}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : (
        <div className="scores-panel-empty">No cost data available.</div>
      )}
    </div>
  );
}

/**
 * The Summaries panel: daily (most recent period) and weekly cost derived from
 * the cost byPeriod; falls back to an aggregate total when periods are absent.
 * Under Path A the `_smithers_scorers` rows carry no cost data, so `byPeriod` is
 * empty and this renders its "no summary data" branch — kept general so it lights
 * up unchanged if a cost source is added later.
 */
function SummariesPanel({ cost }: { cost: CostReport }) {
  const today = cost.byPeriod.length > 0 ? cost.byPeriod[0] : undefined;
  let weekTotal = 0;
  let weekRuns = 0;
  for (const row of cost.byPeriod) {
    weekTotal += row.total;
    weekRuns += row.runs;
  }

  return (
    <div className="scores-panel">
      <div className="scores-panel-title">Summaries</div>
      {cost.byPeriod.length > 0 ? (
        <>
          <DetailRow
            label="Daily cost (latest)"
            value={
              today == null
                ? `${formatUsd(0)} (0 runs)`
                : `${formatUsd(today.total)} (${today.runs} run${today.runs === 1 ? "" : "s"})`
            }
          />
          <DetailRow
            label="Weekly cost (7d)"
            value={`${formatUsd(weekTotal)} (${weekRuns} run${weekRuns === 1 ? "" : "s"})`}
          />
        </>
      ) : cost.total > 0 ? (
        <>
          <DetailRow label="Aggregate total" value={`${formatUsd(cost.total)} USD`} />
          <div className="scores-panel-empty">Per-period breakdown not available.</div>
        </>
      ) : (
        <div className="scores-panel-empty">No summary data available.</div>
      )}
    </div>
  );
}

/** The Metrics tab: four stacked panels keyed off the active run. */
function MetricsTab({ metrics }: { metrics: RunMetrics }) {
  return (
    <div data-testid="scores-tab-metrics">
      <TokenPanel tokens={metrics.tokens} />
      <LatencyPanel latency={metrics.latency} />
      <CostPanel cost={metrics.cost} />
      <SummariesPanel cost={metrics.cost} />
    </div>
  );
}

/** The Recent tab: a flat list of recent evals, newest first. */
function RecentTab({ scores }: { scores: ScoreRow[] }) {
  return (
    <div data-testid="scores-tab-recent">
      {scores.length > 0 ? (
        scores.map((row, index) => {
          const tone = scoreTone(row.score);
          return (
            <div className="scores-recent-row" key={`${row.scorer}-${index}`}>
              <span className={`scores-score-dot ${tone}`} />
              <div className="scores-recent-main">
                <div className="scores-recent-scorer">{row.scorer}</div>
                {row.reason ? <div className="scores-reason">{row.reason}</div> : null}
                <div className="scores-when">{row.scoredAt}</div>
              </div>
              <div className="scores-recent-right">
                <div className={`scores-recent-score ${tone}`}>{formatScore(row.score)}</div>
              </div>
            </div>
          );
        })
      ) : (
        <div className="scores-panel-empty">No recent evaluations</div>
      )}
    </div>
  );
}

/** The full scores surface: run selector header, tab strip, and the active tab. */
export function ScoresCanvas() {
  const runs = useScoresStore((state) => state.runs);
  const scoreRows = useScoresStore((state) => state.scoreRows);
  const selectedRunId = useScoresStore((state) => state.selectedRunId);
  const tab = useScoresStore((state) => state.tab);
  const setTab = useScoresStore((state) => state.setTab);
  const selectRun = useScoresStore((state) => state.selectRun);
  const refresh = useScoresStore((state) => state.refresh);

  const activeRunId = resolveActiveRunId(runs, selectedRunId);

  if (activeRunId == null) {
    return (
      <section className="surface scores-canvas" data-testid="scores-canvas">
        <header className="surface-head">
          <span className="surface-title">Scores</span>
        </header>
        <div className="surface-empty" data-testid="scores-empty">
          No runs available
        </div>
      </section>
    );
  }

  const metrics = metricsFromScores(scoreRows, activeRunId);

  return (
    <section className="surface scores-canvas" data-testid="scores-canvas">
      <header className="surface-head">
        <span className="surface-title">Scores</span>
        <select
          className="scores-selector"
          value={activeRunId}
          onChange={(event) => selectRun(event.target.value)}
          data-testid="scores-run-selector"
        >
          {runs.map((run) => (
            <option key={run.runId} value={run.runId}>
              {runLabel(run)}
            </option>
          ))}
        </select>
        <button
          className="scores-refresh"
          type="button"
          onClick={refresh}
          title="Refresh scores"
          data-testid="scores-refresh"
        >
          <RefreshIcon />
        </button>
      </header>

      <div className="scores-tabs">
        <div className="seg" data-testid="scores-tabs">
          {TABS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={tab === option.id ? "is-on" : ""}
              onClick={() => setTab(option.id)}
              data-testid={`scores-tab-${option.id}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="scores-scroll">
        {tab === "summary" ? <SummaryTab metrics={metrics} /> : null}
        {tab === "metrics" ? <MetricsTab metrics={metrics} /> : null}
        {tab === "recent" ? <RecentTab scores={metrics.scores} /> : null}
      </div>
    </section>
  );
}
