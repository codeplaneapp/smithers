import { openSurface } from "../app/navigation";
import { StatusPill } from "../cards/StatusPill";
import { runSteps } from "./Run";
import { useElapsed } from "./useElapsed";
import { useRunsStore } from "./runsStore";
import { selectRun } from "./selectRun";
import { statusTone } from "./statusMeta";

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

/** A leaf state dot for a step row (done / running / queued). */
function StepDot({ tone }: { tone: string }) {
  return <span className={`step-dot tone-${tone}`} />;
}

/**
 * The live run card — the agent's reply to a launch. Shows the top-level steps,
 * a ticking elapsed clock, and the run actions. Reads the run live from the
 * engine store by id so the card updates in place as frames advance.
 */
export function RunCard({ runId }: { runId: string }) {
  const runs = useRunsStore((state) => state.runs);
  const cancel = useRunsStore((state) => state.cancel);
  const run = selectRun(runs, runId);
  const running = run?.status === "running" || run?.status === "waiting";
  const elapsed = useElapsed(run?.startedAtMs ?? Date.now(), running);

  if (!run) {
    return null;
  }

  const moreCount = runs.length - 1;

  return (
    <article className="run-card" data-testid="run-card">
      <header className="card-head">
        <span className="card-icon">
          <BoltIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">{run.title}</div>
          <div className="card-sub">
            {run.model} · run {run.runId}
          </div>
        </div>
        <div className="card-head-right">
          <StatusPill status={run.status} />
          {running ? <span className="card-elapsed">{elapsed}</span> : null}
        </div>
      </header>

      <div className="card-body">
        <ul className="step-list">
          {runSteps(run).map((step) => (
            <li
              className={step.status === "queued" ? "step is-dim" : "step"}
              key={step.id}
            >
              <StepDot tone={statusTone(step.status)} />
              <span className="step-label">{step.cardLabel ?? step.name}</span>
              <span className="step-meta">{step.meta}</span>
            </li>
          ))}
        </ul>
      </div>

      <footer className="card-foot">
        <button
          className="btn btn-brand"
          type="button"
          onClick={() => openSurface({ kind: "inspector", runId })}
        >
          Open
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => openSurface({ kind: "logs", runId })}
        >
          Logs
        </button>
        {running ? (
          <button
            className="btn"
            type="button"
            onClick={() => cancel(runId)}
          >
            Cancel
          </button>
        ) : null}
        {moreCount > 0 ? (
          <button className="card-link" type="button">
            {moreCount} more run{moreCount > 1 ? "s" : ""} ›
          </button>
        ) : null}
      </footer>
    </article>
  );
}
