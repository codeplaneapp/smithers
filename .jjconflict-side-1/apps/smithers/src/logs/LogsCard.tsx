import { openSurface } from "../app/navigation";
import { AUTH_REFACTOR_LOG } from "./logLines";

function LogsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 6h16M4 12h16M4 18h10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

/** Inline transcript preview for a run, with a jump to the full logs surface. */
export function LogsCard({ runId }: { runId: string }) {
  const preview = AUTH_REFACTOR_LOG.filter((line) => line.role !== "noise").slice(0, 4);

  return (
    <article className="list-card logs-card" data-testid="logs-card">
      <header className="card-head">
        <span className="card-icon">
          <LogsIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Logs</div>
          <div className="card-sub">
            {AUTH_REFACTOR_LOG.length} lines · run {runId.replace(/^run-/, "")}
          </div>
        </div>
        <button
          className="card-link"
          type="button"
          onClick={() => openSurface({ kind: "logs", runId })}
        >
          Open logs ›
        </button>
      </header>

      <div className="card-body">
        <div className="logs-stream">
          {preview.map((line, index) => (
            <div className={`log-line role-${line.role}`} key={`${line.role}-${index}`}>
              <span className="log-role">{line.role} ›</span> {line.text}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}
