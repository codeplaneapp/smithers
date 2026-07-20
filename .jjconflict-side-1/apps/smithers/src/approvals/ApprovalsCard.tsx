import { openSurface } from "../app/navigation";
import { filterPending, gateLabel, shortRunId, waitTime, waitTimeTone } from "./approvals";
import { useApprovalsStore } from "./approvalsStore";

function ShieldIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3 5 6v5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6l-7-3z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The inline approvals card: the pending queue head and a jump to the canvas. */
export function ApprovalsCard() {
  const gates = useApprovalsStore((state) => state.gates);
  const nowMs = useApprovalsStore((state) => state.nowMs);

  const pending = filterPending(gates);
  const shown = pending.slice(0, 4);

  return (
    <article className="list-card appr-card" data-testid="approvals-card">
      <header className="card-head">
        <span className="card-icon icon-warn">
          <ShieldIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Approvals</div>
          <div className="card-sub">{pending.length} pending</div>
        </div>
        <button className="card-link" type="button" onClick={() => openSurface({ kind: "approvals" })}>
          Open approvals ›
        </button>
      </header>

      <div className="card-body card-body-flush">
        {shown.length > 0 ? (
          shown.map((gate) => (
            <div className="list-row" key={gate.id}>
              <span className="appr-ring is-pending" aria-hidden="true" />
              <div className="list-text">
                <div className="list-name">{gateLabel(gate)}</div>
                <div className="list-meta">Run: {shortRunId(gate.runId)}</div>
              </div>
              <div className="list-tags">
                <span className={`appr-wait ${waitTimeTone(gate.requestedAtMs, nowMs)}`}>
                  {waitTime(gate.requestedAtMs, nowMs)}
                </span>
              </div>
            </div>
          ))
        ) : (
          <div className="vcs-more">No pending approvals.</div>
        )}
        {pending.length > shown.length ? (
          <div className="vcs-more">+{pending.length - shown.length} more</div>
        ) : null}
      </div>

      <footer className="card-foot">
        <button className="btn btn-brand" type="button" onClick={() => openSurface({ kind: "approvals" })}>
          Review
        </button>
      </footer>
    </article>
  );
}
