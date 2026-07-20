import { openSurface } from "../app/navigation";
import { StatusPill } from "../cards/StatusPill";
import {
  runDisplayName,
  runStatusToNode,
  summarizeRuns,
} from "./runsList";
import { useRunsListStore } from "./runsListStore";

function BoltIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The inline runs card: a count summary, a few active runs, and a jump to the
 *  list surface. Follows VcsCard / IssuesCard exactly. */
export function RunsCard() {
  const runs = useRunsListStore((state) => state.runs);
  const summary = summarizeRuns(runs);
  const active = runs.filter((run) => run.status === "running" || run.status === "waiting");
  const shown = active.slice(0, 4);
  const more = runs.length - shown.length;

  return (
    <article className="list-card runs-card" data-testid="runs-card">
      <header className="card-head">
        <span className="card-icon">
          <BoltIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Runs</div>
          <div className="card-sub">
            {summary.active} active · {summary.done} done · {summary.failed} failed
          </div>
        </div>
        <button className="card-link" type="button" onClick={() => openSurface({ kind: "runs" })}>
          Open runs ›
        </button>
      </header>

      <div className="card-body card-body-flush">
        {shown.map((run) => (
          <div className="list-row" key={run.runId}>
            <StatusPill status={runStatusToNode(run.status)} label={run.status} />
            <div className="list-text">
              <div className="list-name">{runDisplayName(run)}</div>
            </div>
            <div className="list-tags">
              <span className="runs-row-elapsed">{run.elapsedLabel}</span>
            </div>
          </div>
        ))}
        {more > 0 ? <div className="vcs-more">+{more} more</div> : null}
      </div>
    </article>
  );
}
