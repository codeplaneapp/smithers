import { useCardUiStore } from "../cards/cardUiStore";
import { useChatStore } from "../chat/chatStore";

function SignalIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16M5 19a1 1 0 1 0 0 .01"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A run blocked on an external event; deliver the signal or let it fire. */
export function SignalCard({ event }: { event: string }) {
  const say = useChatStore((state) => state.say);
  const delivered = useCardUiStore((state) => state.deliveredByEvent[event] ?? false);
  const deliver = useCardUiStore((state) => state.deliverSignal);

  return (
    <article className="list-card" data-testid="signal-card">
      <header className="card-head">
        <span className="card-icon">
          <SignalIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Waiting for event</div>
          <div className="card-sub">
            run 4830 · <code className="cron-pattern">{event}</code>
          </div>
        </div>
        <div className="card-head-right">
          <span className={`status-pill ${delivered ? "tone-ok" : "tone-waiting"}`}>
            <span className="status-dot" />
            {delivered ? "delivered" : "blocked"}
          </span>
        </div>
      </header>
      {!delivered ? (
        <footer className="card-foot">
          <button
            className="btn btn-brand"
            type="button"
            onClick={() => {
              deliver(event);
              say(`Delivered signal "${event}". The run resumed.`);
            }}
          >
            Deliver signal
          </button>
          <span className="card-foot-note">or fires on the real event</span>
        </footer>
      ) : null}
    </article>
  );
}
