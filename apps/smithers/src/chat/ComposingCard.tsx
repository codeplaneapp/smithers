import { useComposeHandoffStore } from "./composeHandoffStore";

export function ComposingCard() {
  const card = useComposeHandoffStore((state) => state.card);
  const registerCard = useComposeHandoffStore((state) => state.registerCard);
  if (!card) return null;

  return (
    <article aria-live="polite" className={`composing-card composing-card-${card.status}`} ref={registerCard}>
      <div className="composing-card-head">
        <span className="composing-card-dot" aria-hidden="true" />
        <span className="composing-card-title">{card.title}</span>
        <span className="composing-card-status">{card.status === "streaming" ? "Composing" : "Submitting"}</span>
      </div>
      <pre className="composing-card-text">
        {card.visibleText}
        {card.status === "streaming" ? <span className="composing-caret" /> : null}
      </pre>
    </article>
  );
}
