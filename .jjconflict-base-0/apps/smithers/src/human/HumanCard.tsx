import { useCardUiStore } from "../cards/cardUiStore";
import { useChatStore } from "../chat/chatStore";

function ChatIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M8 9h8M8 13h5M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const OPTIONS = ["staging", "production", "cancel"];

/** A human task: the run asks a question; you answer with an option chip. */
export function HumanCard() {
  const say = useChatStore((state) => state.say);
  const picked = useCardUiStore((state) => state.humanPicked);
  const pick = useCardUiStore((state) => state.pickHuman);

  return (
    <article className="gate-card is-human" data-testid="human-card">
      <header className="card-head">
        <span className="card-icon icon-human">
          <ChatIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">The run needs your input</div>
          <div className="card-sub">human task · deploy target</div>
        </div>
      </header>
      <div className="card-body">
        <p className="gate-summary">Which environment should I deploy to?</p>
        <div className="opt-row">
          {OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={option === picked ? "opt is-pick" : "opt"}
              onClick={() => {
                pick(option);
                say(`Deploy target: ${option}.`);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}
