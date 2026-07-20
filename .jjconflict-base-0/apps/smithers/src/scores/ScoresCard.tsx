import { openSurface } from "../app/navigation";
import {
  metricsFromScores,
  resolveActiveRunId,
  runLabel,
  scoreTone,
  summaryStats,
} from "./scoreReport";
import { useScoresStore } from "./scoresStore";

function ChartIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 3v18h18M7 14l3-4 3 3 5-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Compact eval scorecard for the chat log: a live summary of the active run's
 * scorer results. Reads the SAME live store the `/scores` surface does (fed by
 * `ScoresBridge` over the `listScores` RPC), so the card never renders a seeded
 * suite — it mirrors whatever the gateway holds for the selected/most-recent run.
 */
export function ScoresCard() {
  const runs = useScoresStore((state) => state.runs);
  const scoreRows = useScoresStore((state) => state.scoreRows);
  const selectedRunId = useScoresStore((state) => state.selectedRunId);

  const activeRunId = resolveActiveRunId(runs, selectedRunId);
  const run = activeRunId == null ? undefined : runs.find((candidate) => candidate.runId === activeRunId);
  const metrics = metricsFromScores(scoreRows, activeRunId);
  const stats = summaryStats(metrics);
  const meanScore = metrics.scores.length > 0 ? metrics.scores.reduce((sum, row) => sum + row.score, 0) / metrics.scores.length : null;

  const tiles: { name: string; value: string }[] = [
    { name: "evals", value: String(stats.evaluations) },
    { name: "mean", value: stats.mean },
    { name: "avg dur", value: stats.avgDuration },
  ];

  return (
    <article className="list-card" data-testid="scores-card">
      <header className="card-head">
        <span className="card-icon">
          <ChartIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Scores{run ? ` · ${runLabel(run)}` : ""}</div>
          <div className="card-sub">
            {activeRunId == null ? "no scored runs yet" : "live scorer results"}
          </div>
        </div>
        <div className="card-head-right">
          {meanScore != null ? (
            <span className={`status-pill ${scoreTone(meanScore)}`}>
              <span className="status-dot" />
              {meanScore.toFixed(2)}
            </span>
          ) : null}
          <button
            className="card-link"
            type="button"
            onClick={() => openSurface({ kind: "scores" })}
          >
            Open scores ›
          </button>
        </div>
      </header>
      <div className="card-body">
        <div className="score-tiles">
          {tiles.map((tile) => (
            <div className="score-tile" key={tile.name}>
              <div className="tile-name">{tile.name}</div>
              <div className="tile-value">{tile.value}</div>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}
