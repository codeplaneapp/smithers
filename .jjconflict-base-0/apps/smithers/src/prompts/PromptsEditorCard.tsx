import { openSurface } from "../app/navigation";
import { summarize } from "./promptsSource";
import { usePromptsStore } from "./promptsStore";

function DocIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 3h7l4 4v14H7zM14 3v4h4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 12h6M9 16h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The inline prompts-EDITOR card (distinct from the prompt-picker `PromptsCard`):
 * the first ~4 prompts with their entryFile + input count, and an
 * "Open editor ›" jump to the full editor canvas.
 */
export function PromptsEditorCard() {
  const prompts = usePromptsStore((state) => state.prompts);
  const select = usePromptsStore((state) => state.select);
  const renderNow = usePromptsStore((state) => state.renderNow);
  const firstId = usePromptsStore((state) => state.prompts[0]?.id ?? null);
  const shown = prompts.slice(0, 4);

  return (
    <article className="list-card" data-testid="prompts-editor-card">
      <header className="card-head">
        <span className="card-icon">
          <DocIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Prompts</div>
          <div className="card-sub">
            {prompts.length} prompt{prompts.length === 1 ? "" : "s"} · edit, preview, save
          </div>
        </div>
        <button
          className="card-link"
          type="button"
          onClick={() => openSurface({ kind: "prompts" })}
        >
          Open editor ›
        </button>
      </header>

      <div className="card-body card-body-flush">
        {shown.map((prompt) => {
          const { inputCount } = summarize(prompt);
          return (
            <button
              key={prompt.id}
              type="button"
              className="list-row prompts-card-row"
              onClick={() => {
                select(prompt.id);
                openSurface({ kind: "prompts" });
              }}
            >
              <div className="list-text">
                <div className="list-name">{prompt.id}</div>
                <div className="list-meta">{prompt.entryFile}</div>
              </div>
              <div className="list-tags">
                <span className="mini-tag">
                  {inputCount} input{inputCount === 1 ? "" : "s"}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <footer className="card-foot">
        <button
          className="btn"
          type="button"
          onClick={() => {
            if (firstId) renderNow(firstId);
            openSurface({ kind: "prompts" });
          }}
        >
          Preview
        </button>
        <button
          className="btn btn-brand"
          type="button"
          onClick={() => openSurface({ kind: "prompts" })}
        >
          New prompt
        </button>
      </footer>
    </article>
  );
}
