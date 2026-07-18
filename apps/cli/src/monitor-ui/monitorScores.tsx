/** @jsxImportSource react */
import { useMemo } from "react";
import {
  formatScore,
  scoreRowsOf,
  scoresForNode,
  scoresSummary,
  scoreTone,
  type ScoreRow,
} from "./monitorModel.ts";
import { useJsonApi } from "./monitorShared.tsx";

// ---------------------------------------------------------------------------
// Scores. Scorer results are per-run rows in [0,1] (see scoreRowsOf); the run
// panel collapses to a one-line summary past a handful, and the whole panel
// hides when the run simply has no scores — most runs don't, and an empty
// panel would be noise. The node inspector shows the same rows as chips.
// ---------------------------------------------------------------------------

const SCORES_COLLAPSE_THRESHOLD = 5;

export type RunScores = { rows: ScoreRow[]; loaded: boolean };

export function useRunScores(runId: string | undefined, live: boolean): RunScores {
  const api = useJsonApi(runId ? `/v1/api/scores?runId=${encodeURIComponent(runId)}` : null, live ? 15_000 : null);
  const rows = useMemo(() => scoreRowsOf(api.body), [api.body]);
  return { rows, loaded: api.loaded };
}

function ScoreRowLine({ row }: { row: ScoreRow }) {
  return (
    <div className="mon-score-row" data-testid="monitor-score-row">
      <span className={`mon-pill tone-${scoreTone(row.score)} mon-score-pill`}>
        <span className="mon-dot" aria-hidden />
        {formatScore(row.score)}
      </span>
      <span className="mon-score-name">{row.scorerName}</span>
      <span className="mon-mono mon-dim mon-score-node" title={row.nodeId}>
        {row.nodeId}
        {row.iteration > 0 ? `#${row.iteration}` : ""}
      </span>
      {row.reason ? (
        <span className="mon-dim mon-score-reason" title={row.reason}>
          {row.reason}
        </span>
      ) : null}
    </div>
  );
}

export function ScoresPanel({ scores: { rows, loaded } }: { scores: RunScores }) {
  // No scores → no panel. Most runs never run a scorer; an empty-state panel
  // on every run detail would be pure noise.
  if (!loaded || rows.length === 0) return null;
  const summary = scoresSummary(rows);
  const list = (
    <div className="mon-scores-list">
      {rows.map((row) => (
        <ScoreRowLine key={`${row.nodeId}#${row.iteration}:${row.scorerId}:${row.attempt}`} row={row} />
      ))}
    </div>
  );
  return (
    <section className="mon-panel mon-scores-panel" data-testid="monitor-scores">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">
          Scores <span className="mon-count">{summary.count}</span>
        </h2>
        <span className="mon-dim mon-mono">avg {formatScore(summary.avg)}</span>
      </header>
      {rows.length > SCORES_COLLAPSE_THRESHOLD ? (
        <details className="mon-scores-details">
          <summary className="mon-scores-summary" data-testid="monitor-scores-summary">
            <span className="mon-diff-caret" aria-hidden>
              ▸
            </span>
            {summary.count} scores · avg {formatScore(summary.avg)}
          </summary>
          {list}
        </details>
      ) : (
        list
      )}
    </section>
  );
}

/** Score chips under the inspector's What-happened section — only when this node was scored. */
export function NodeScoreChips({ nodeId, scores: { rows, loaded } }: { nodeId: string; scores: RunScores }) {
  const nodeScores = useMemo(() => scoresForNode(rows, nodeId), [rows, nodeId]);
  if (!loaded || nodeScores.length === 0) return null;
  return (
    <div className="mon-node-scores" data-testid="monitor-node-scores">
      {nodeScores.map((row) => (
        <span
          key={`${row.scorerId}:${row.iteration}:${row.attempt}`}
          className={`mon-chip mon-score-chip tone-${scoreTone(row.score)}`}
          title={row.reason ?? row.scorerName}
        >
          {row.scorerName} {formatScore(row.score)}
        </span>
      ))}
    </div>
  );
}
