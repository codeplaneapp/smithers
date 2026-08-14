import { EmptyState, Skeleton } from "@smthrs/ui";
import { openSurface } from "../app/navigation";
import { StatusPill } from "../cards/StatusPill";
import { RunTree } from "../runs/RunTree";
import { useGatewayRunTree } from "../sync/useGatewayRunTree";

export function GatewayRunCard({ workflowKey, runId }: { workflowKey: string; runId: string }) {
  const runTree = useGatewayRunTree(runId);
  const steps = runTree.root?.children ?? [];

  return (
    <article className="run-card" data-testid="gateway-run-card">
      <header className="card-head">
        <span className="card-icon" aria-hidden="true">
          S
        </span>
        <div className="card-headings">
          <div className="card-title">{workflowKey}</div>
          <div className="card-sub">gateway run {runId}</div>
        </div>
        <div className="card-head-right">
          <StatusPill status={runTree.status} />
        </div>
      </header>

      <div className="card-body">
        {runTree.isLoading && !runTree.root ? (
          <div className="surface-empty" role="status">
            <Skeleton style={{ width: "80%", height: 48 }} />
            <span className="sui-sr-only">Loading run...</span>
          </div>
        ) : runTree.root ? (
          steps.length > 0 ? (
            <ul className="step-list">
              {steps.slice(0, 6).map((step) => (
                <li className={step.status === "queued" ? "step is-dim" : "step"} key={step.id}>
                  <span className="step-dot" />
                  <span className="step-label">{step.cardLabel ?? step.name}</span>
                  <span className="step-meta">{step.meta}</span>
                </li>
              ))}
            </ul>
          ) : (
            <RunTree root={runTree.root} selectedId={runTree.root.id} onSelect={() => {}} />
          )
        ) : (
          <EmptyState
            className="surface-empty"
            title={runTree.error ? "Run unavailable" : undefined}
            description={runTree.error ? runTree.error.message : "No execution tree yet."}
            role={runTree.error ? "alert" : undefined}
          />
        )}
      </div>

      <footer className="card-foot">
        <button
          className="btn btn-brand"
          type="button"
          onClick={() => openSurface({ kind: "gatewayRun", workflowKey, runId })}
        >
          Open
        </button>
      </footer>
    </article>
  );
}
