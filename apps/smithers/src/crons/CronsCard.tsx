import { Badge, EmptyState, Skeleton } from "@smthrs/ui";
import { openSurface } from "../app/navigation";
import { sortCrons, summarizeCrons } from "./crons";
import { useCronsStore } from "./cronsStore";

function ClockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The inline triggers card: enabled count and the first few triggers. */
export function CronsCard() {
  const crons = useCronsStore((state) => state.crons);
  const loading = useCronsStore((state) => state.loading);
  const error = useCronsStore((state) => state.error);
  const openCreate = useCronsStore((state) => state.openCreate);
  const summary = summarizeCrons(crons);
  const shown = sortCrons(crons).slice(0, 4);

  return (
    <article className="list-card" data-testid="crons-card">
      <header className="card-head">
        <span className="card-icon">
          <ClockIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Triggers</div>
          <div className="card-sub">
            {summary.enabled} enabled trigger{summary.enabled === 1 ? "" : "s"}
          </div>
        </div>
        <button className="card-link" type="button" onClick={() => openSurface({ kind: "crons" })}>
          Open triggers ›
        </button>
      </header>

      <div className="card-body card-body-flush">
        {loading && crons.length === 0 ? (
          <div role="status">
            <Skeleton style={{ height: 44, margin: 12 }} />
            <span className="sui-sr-only">Loading cron triggers…</span>
          </div>
        ) : error && crons.length === 0 ? (
          <EmptyState title="Cron triggers unavailable" description={error} role="alert" />
        ) : shown.length === 0 ? (
          <EmptyState title="No cron triggers found" description="Create one to schedule workflows." />
        ) : (
          <>
            {shown.map((cron) => (
              <div className="list-row" key={cron.id}>
                <div className="list-text">
                  <div className="list-name">{cron.name}</div>
                  <div className="list-meta">
                    <code className="cron-pattern">{cron.pattern}</code> · {cron.workflowPath}
                  </div>
                </div>
                <div className="list-tags">
                  <Badge
                    variant={cron.enabled ? "success" : "muted"}
                    data-status={cron.enabled ? "enabled" : "disabled"}
                  >
                    {cron.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
              </div>
            ))}
            {summary.total > shown.length ? <div className="rev-more">+{summary.total - shown.length} more</div> : null}
          </>
        )}
      </div>

      <footer className="card-foot">
        <button
          className="btn"
          type="button"
          onClick={() => {
            openCreate();
            openSurface({ kind: "crons" });
          }}
        >
          New trigger
        </button>
      </footer>
    </article>
  );
}
