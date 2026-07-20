import { useCardUiStore } from "../cards/cardUiStore";
import { useChatStore } from "../chat/chatStore";
import { fillTemplate, PROMPT_TEMPLATES } from "./promptTemplates";

function ListIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M4 7h16M4 12h10M4 17h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Prompt picker card: choose a template, preview it, send it to the composer. */
export function PromptsCard() {
  const fill = useChatStore((state) => state.fill);
  const storedId = useCardUiStore((state) => state.promptActiveId);
  const setPromptActive = useCardUiStore((state) => state.setPromptActive);
  const activeId = storedId ?? PROMPT_TEMPLATES[0].id;
  const active = PROMPT_TEMPLATES.find((entry) => entry.id === activeId)!;
  const parts = active.body.split("{target}");

  return (
    <article className="list-card" data-testid="prompts-card">
      <header className="card-head">
        <span className="card-icon">
          <ListIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Prompts</div>
          <div className="card-sub">pick a template to fill the composer</div>
        </div>
      </header>
      <div className="card-body">
        <div className="file-tabs">
          {PROMPT_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className={template.id === activeId ? "file-tab is-on" : "file-tab"}
              onClick={() => setPromptActive(template.id)}
            >
              {template.name}
            </button>
          ))}
        </div>
        <div className="field">
          <label>{active.field}</label>
          <div className="field-input">target…</div>
        </div>
        <div className="prompt-preview">
          {parts[0]}
          <span className="prompt-slot">{`{target}`}</span>
          {parts[1]}
        </div>
      </div>
      <footer className="card-foot">
        <button
          className="btn btn-brand"
          type="button"
          onClick={() => fill(fillTemplate(active, ""))}
        >
          Use prompt
        </button>
        <span className="card-link">edit templates ›</span>
      </footer>
    </article>
  );
}
