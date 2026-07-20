import "./approvals.css";
import {
  filterPending,
  formatTimestamp,
  gateLabel,
  orderHistory,
  prettyJson,
  shortRunId,
  waitTime,
  waitTimeTone,
  type ApprovalDecision,
  type ApprovalGate,
} from "./approvals";
import { useApprovalsStore, type ApprovalsTab } from "./approvalsStore";

const TABS: { id: ApprovalsTab; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "history", label: "History" },
];

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

/** One pending-gate row in the queue rail. */
function PendingRow({ gate }: { gate: ApprovalGate }) {
  const selectedId = useApprovalsStore((state) => state.selectedId);
  const actingId = useApprovalsStore((state) => state.actingId);
  const nowMs = useApprovalsStore((state) => state.nowMs);
  const select = useApprovalsStore((state) => state.select);

  const busy = actingId === gate.id;
  const tone = waitTimeTone(gate.requestedAtMs, nowMs);

  return (
    <button
      type="button"
      className={selectedId === gate.id ? "appr-row is-on" : "appr-row"}
      onClick={() => select(gate.id)}
      data-testid="approvals-pending-row"
    >
      <span className={busy ? "appr-ring is-busy" : "appr-ring is-pending"} aria-hidden="true" />
      <div className="appr-row-main">
        <div className="appr-gate">{gateLabel(gate)}</div>
        <div className="appr-runid">Run: {shortRunId(gate.runId)}</div>
      </div>
      {gate.source === "synthetic" ? <span className="appr-synthetic">SYNTHETIC</span> : null}
      <span className={`appr-wait ${tone}`}>{waitTime(gate.requestedAtMs, nowMs)}</span>
    </button>
  );
}

/** One resolved-decision row in the history rail. */
function HistoryRow({ decision }: { decision: ApprovalDecision }) {
  const selectedId = useApprovalsStore((state) => state.selectedId);
  const select = useApprovalsStore((state) => state.select);

  const approved = decision.action === "approved";
  const tone = approved ? "tone-ok" : "tone-failed";

  return (
    <button
      type="button"
      className={selectedId === decision.id ? "appr-row is-on" : "appr-row"}
      onClick={() => select(decision.id)}
      data-testid="approvals-history-row"
    >
      <span className={`appr-ring ${tone}`} aria-hidden="true">
        {approved ? "✓" : "✕"}
      </span>
      <div className="appr-row-main">
        <div className="appr-gate">{gateLabel(decision)}</div>
        <div className="appr-runid">Run: {shortRunId(decision.runId)}</div>
      </div>
      {decision.source === "synthetic" ? <span className="appr-synthetic">SYNTHETIC</span> : null}
      <span className={`appr-action-tag ${tone}`}>{approved ? "APPROVED" : "DENIED"}</span>
    </button>
  );
}

/** A single labeled metadata fact row, rendered only when its value exists. */
function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <>
      <div className="appr-meta-label">{label}</div>
      <div className="appr-meta-value">{value}</div>
    </>
  );
}

/** The pending-gate detail: metadata, payload, note, and the decision actions. */
function PendingDetail({ gate }: { gate: ApprovalGate }) {
  const nowMs = useApprovalsStore((state) => state.nowMs);
  const note = useApprovalsStore((state) => state.noteById[gate.id] ?? "");
  const pendingDenyId = useApprovalsStore((state) => state.pendingDenyId);
  const actingId = useApprovalsStore((state) => state.actingId);
  const setNote = useApprovalsStore((state) => state.setNote);
  const approve = useApprovalsStore((state) => state.approve);
  const requestDeny = useApprovalsStore((state) => state.requestDeny);
  const cancelDeny = useApprovalsStore((state) => state.cancelDeny);
  const confirmDeny = useApprovalsStore((state) => state.confirmDeny);

  const label = gateLabel(gate);
  const payload = prettyJson(gate.payload);
  const confirming = pendingDenyId === gate.id;
  const busy = actingId === gate.id;

  return (
    <div className="appr-detail-scroll" data-testid="approvals-detail">
      <div className="rev-detail-head">
        <div className="rev-detail-title">{label}</div>
        <span className="state-badge tone-waiting">PENDING</span>
      </div>

      <div className="appr-meta">
        <MetaRow label="Run ID" value={gate.runId} />
        <MetaRow label="Node ID" value={gate.nodeId} />
        <MetaRow label="Iteration" value={gate.iteration !== undefined ? String(gate.iteration) : undefined} />
        <MetaRow label="Workflow" value={gate.workflowPath} />
        <MetaRow label="Requested" value={formatTimestamp(gate.requestedAtMs)} />
        <MetaRow label="Status" value="PENDING" />
        <MetaRow label="Wait Time" value={waitTime(gate.requestedAtMs, nowMs)} />
        <MetaRow label="Source" value={gate.source ? gate.source.toUpperCase() : undefined} />
      </div>

      {gate.source === "synthetic" ? (
        <p className="appr-synthetic-note">
          This approval was derived from run inspection because no native approval transport was
          available.
        </p>
      ) : null}

      {payload !== "" ? (
        <>
          <div className="appr-eyebrow">Context / Payload</div>
          <pre className="appr-payload" data-testid="approvals-payload">
            {payload}
          </pre>
        </>
      ) : null}

      <input
        className="field-input appr-note"
        data-testid="approvals-note"
        placeholder="Add a decision note (optional)…"
        value={note}
        onChange={(event) => setNote(gate.id, event.target.value)}
        disabled={busy}
      />

      {confirming ? (
        <div className="appr-confirm" data-testid="approvals-deny-confirm">
          <div className="appr-confirm-msg">
            Deny approval for <b>{label}</b> on run <b>{shortRunId(gate.runId)}</b>? This will fail
            the waiting gate.
          </div>
          <div className="appr-actions">
            <button
              className="btn btn-deny"
              type="button"
              data-testid="approvals-deny-commit"
              onClick={() => confirmDeny(gate.id)}
              disabled={busy}
            >
              Deny Approval
            </button>
            <button className="btn" type="button" onClick={cancelDeny} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="appr-actions">
          <button
            className="btn btn-brand"
            type="button"
            data-testid="approvals-approve"
            onClick={() => approve(gate.id)}
            disabled={busy}
          >
            Approve
          </button>
          <button
            className="btn btn-deny"
            type="button"
            data-testid="approvals-deny"
            onClick={() => requestDeny(gate.id)}
            disabled={busy}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

/** The resolved-decision detail: metadata + payload, no actions. */
function HistoryDetail({ decision }: { decision: ApprovalDecision }) {
  const nowMs = useApprovalsStore((state) => state.nowMs);
  const label = gateLabel(decision);
  const payload = prettyJson(decision.payload);
  const approved = decision.action === "approved";

  return (
    <div className="appr-detail-scroll" data-testid="approvals-detail">
      <div className="rev-detail-head">
        <div className="rev-detail-title">{label}</div>
        <span className={`state-badge ${approved ? "tone-ok" : "tone-failed"}`}>
          {approved ? "APPROVED" : "DENIED"}
        </span>
      </div>

      <div className="appr-meta">
        <MetaRow label="Run ID" value={decision.runId} />
        <MetaRow label="Node ID" value={decision.nodeId} />
        <MetaRow
          label="Iteration"
          value={decision.iteration !== undefined ? String(decision.iteration) : undefined}
        />
        <MetaRow label="Workflow" value={decision.workflowPath} />
        <MetaRow label="Requested" value={formatTimestamp(decision.requestedAtMs)} />
        <MetaRow label="Status" value={decision.action.toUpperCase()} />
        <MetaRow label="Wait Time" value={waitTime(decision.requestedAtMs, decision.resolvedAtMs)} />
        <MetaRow label="Source" value={decision.source ? decision.source.toUpperCase() : undefined} />
        <MetaRow label="Resolved" value={formatTimestamp(decision.resolvedAtMs)} />
        <MetaRow label="Resolved By" value={decision.resolvedBy} />
        <MetaRow label="Note" value={decision.note} />
        <MetaRow label="Reason" value={decision.reason} />
      </div>

      {decision.source === "synthetic" ? (
        <p className="appr-synthetic-note">
          This approval was derived from run inspection because no native approval transport was
          available.
        </p>
      ) : null}

      {payload !== "" ? (
        <>
          <div className="appr-eyebrow">Context / Payload</div>
          <pre className="appr-payload" data-testid="approvals-payload">
            {payload}
          </pre>
        </>
      ) : null}
    </div>
  );
}

/** The full approvals surface: the pending queue or decision history + detail. */
export function ApprovalsCanvas() {
  const tab = useApprovalsStore((state) => state.tab);
  const gates = useApprovalsStore((state) => state.gates);
  const decisions = useApprovalsStore((state) => state.decisions);
  const selectedId = useApprovalsStore((state) => state.selectedId);
  const setTab = useApprovalsStore((state) => state.setTab);

  const pending = filterPending(gates);
  const history = orderHistory(decisions);

  const selectedGate = tab === "pending" ? pending.find((gate) => gate.id === selectedId) ?? null : null;
  const selectedDecision =
    tab === "history" ? history.find((decision) => decision.id === selectedId) ?? null : null;
  const listEmpty = tab === "pending" ? pending.length === 0 : history.length === 0;

  return (
    <section className="surface" data-testid="approvals-canvas">
      <header className="surface-head">
        <span className="surface-title">Approvals</span>
        <span className="surface-sub">
          {pending.length} pending · {decisions.length} decided
        </span>
        <div className="seg" data-testid="approvals-tabs">
          {TABS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={tab === option.id ? "is-on" : ""}
              onClick={() => setTab(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      <div className="appr-body">
        <div className="appr-list">
          {tab === "pending" ? (
            pending.length > 0 ? (
              pending.map((gate) => <PendingRow key={gate.id} gate={gate} />)
            ) : (
              <div className="appr-empty" data-testid="approvals-empty">
                <ShieldIcon />
                No pending approvals
              </div>
            )
          ) : history.length > 0 ? (
            history.map((decision) => <HistoryRow key={decision.id} decision={decision} />)
          ) : (
            <div className="appr-empty" data-testid="approvals-empty">
              <ShieldIcon />
              No recent decisions
            </div>
          )}
        </div>

        <div className="appr-detail">
          {selectedGate ? (
            <PendingDetail gate={selectedGate} />
          ) : selectedDecision ? (
            <HistoryDetail decision={selectedDecision} />
          ) : listEmpty ? (
            <div className="appr-detail-empty">Nothing to review.</div>
          ) : (
            <div className="appr-placeholder" data-testid="approvals-placeholder">
              <ShieldIcon />
              Select an approval
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
