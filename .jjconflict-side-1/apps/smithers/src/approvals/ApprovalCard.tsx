import { useCardUiStore } from "../cards/cardUiStore";
import { useChatStore } from "../chat/chatStore";
import { useRunsStore } from "../runs/runsStore";
import { selectApproval } from "../runs/selectApproval";
import { selectRun } from "../runs/selectRun";
import { useElapsed } from "../runs/useElapsed";

function WarnIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * An approval gate, surfaced inline where the run paused. Amber means waiting.
 * Approve/Deny resolve the gate on the engine and the run resumes (or fails).
 */
export function ApprovalCard({ runId }: { runId: string }) {
  const runs = useRunsStore((state) => state.runs);
  const approve = useRunsStore((state) => state.approve);
  const deny = useRunsStore((state) => state.deny);
  const say = useChatStore((state) => state.say);
  const note = useCardUiStore((state) => state.noteByRun[runId] ?? "");
  const setNote = useCardUiStore((state) => state.setNote);
  const approval = selectApproval(runs, runId);
  const run = selectRun(runs, runId);
  const elapsed = useElapsed(run?.startedAtMs ?? Date.now(), approval?.status === "pending");

  if (!approval) {
    return null;
  }

  if (approval.status !== "pending") {
    const resolved = approval.status === "approved";
    return (
      <article className={`gate-card is-${approval.status}`} data-testid="approval-card">
        <header className="card-head">
          <span className={`card-icon ${resolved ? "icon-ok" : "icon-fail"}`}>
            <WarnIcon />
          </span>
          <div className="card-headings">
            <div className="card-title">
              {resolved ? "Approved" : "Denied"} · deploy
            </div>
            <div className="card-sub">gate · {approval.gate}</div>
          </div>
        </header>
      </article>
    );
  }

  return (
    <article className="gate-card is-pending" data-testid="approval-card">
      <header className="card-head">
        <span className="card-icon icon-warn">
          <WarnIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Approval needed</div>
          <div className="card-sub">gate · {approval.gate}</div>
        </div>
        <div className="card-head-right">
          <span className="status-pill tone-waiting">
            <span className="status-dot" />
            waiting · {elapsed}
          </span>
        </div>
      </header>

      <div className="card-body">
        <p className="gate-summary">
          Deploy <b>auth refactor</b> to <b>production</b>. 8 files changed, all
          checks green.
        </p>
        <input
          className="gate-note"
          data-testid="approval-note"
          placeholder="Add a note (optional)…"
          value={note}
          onChange={(event) => setNote(runId, event.target.value)}
        />
      </div>

      <footer className="card-foot">
        <button
          className="btn btn-brand"
          type="button"
          data-testid="approval-approve"
          onClick={() => {
            approve(runId, note || undefined);
            say("Approved. Deploying auth refactor to production…");
          }}
        >
          Approve
        </button>
        <button
          className="btn btn-deny"
          type="button"
          data-testid="approval-deny"
          onClick={() => {
            deny(runId, note || undefined);
            say("Denied. The deploy gate was rejected; the run is stopped.");
          }}
        >
          Deny
        </button>
        <button
          className="card-link"
          type="button"
          onClick={() =>
            say(
              "This step deploys to production, which is gated by the workflow's `<Approval>` node. Approve to continue, or Deny to stop the run.",
            )
          }
        >
          why is this gated? ›
        </button>
      </footer>
    </article>
  );
}
