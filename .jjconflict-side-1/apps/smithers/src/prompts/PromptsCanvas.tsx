import "./prompts.css";
import { discoverImports, discoverInputs, type Input } from "./promptsSource";
import {
  selectDraft,
  selectHasInputChanges,
  selectHasSourceChanges,
  usePromptsStore,
  type PromptTab,
} from "./promptsStore";

const TABS: { id: PromptTab; label: string }[] = [
  { id: "source", label: "Source" },
  { id: "imports", label: "Imports" },
  { id: "inputs", label: "Inputs" },
  { id: "preview", label: "Preview" },
];

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

/** The left rail: one selectable row per prompt (id + entryFile). */
function PromptList() {
  const prompts = usePromptsStore((state) => state.prompts);
  const selectedId = usePromptsStore((state) => state.selectedId);
  const select = usePromptsStore((state) => state.select);

  if (prompts.length === 0) {
    return (
      <div className="rev-list prompts-list">
        <div className="rev-empty">
          <DocIcon />
          No prompts found
        </div>
      </div>
    );
  }

  return (
    <div className="rev-list prompts-list">
      {prompts.map((prompt) => {
        const on = prompt.id === selectedId;
        return (
          <button
            // Key by entryFile (the workspace-relative path, unique per file) not
            // id: a `foo.md`/`foo.mdx` pair strips to the same id, and a duplicate
            // React key drops/dupes a row. The gateway collection is already keyed
            // by entryFile; mirror that here so both variants render distinctly.
            key={prompt.entryFile}
            type="button"
            className={on ? "prompts-row is-on" : "prompts-row"}
            onClick={() => select(prompt.id)}
            data-testid="prompts-row"
          >
            <span className={on ? "prompts-row-icon is-on" : "prompts-row-icon"}>
              <DocIcon />
            </span>
            <span className="prompts-row-main">
              <span className="prompts-row-id">{prompt.id}</span>
              <span className="prompts-row-file">{prompt.entryFile}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The inline discard guard, shown above the editor when a switch was intercepted. */
function DiscardBar() {
  const pendingId = usePromptsStore((state) => state.pendingSelectId);
  const confirmDiscard = usePromptsStore((state) => state.confirmDiscard);
  const cancelDiscard = usePromptsStore((state) => state.cancelDiscard);
  if (pendingId == null) return null;
  return (
    <div className="prompts-discard-bar" data-testid="prompts-discard">
      <span>Discard changes?</span>
      <div className="rev-create-actions">
        <button className="btn btn-deny" type="button" onClick={confirmDiscard}>
          Discard
        </button>
        <button className="btn" type="button" onClick={cancelDiscard}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The Source tab: a full-height monospace editor bound to the active draft. */
function SourceTab() {
  const selectedId = usePromptsStore((state) => state.selectedId);
  const draft = usePromptsStore(selectDraft);
  const editSource = usePromptsStore((state) => state.editSource);
  return (
    <textarea
      className="rev-editor prompts-editor"
      value={draft}
      spellCheck={false}
      onChange={(event) => editSource(selectedId, event.target.value)}
      data-testid="prompts-editor"
    />
  );
}

/** The Imports tab: every ES import + MDX component tag the source pulls in. */
function ImportsTab() {
  const draft = usePromptsStore(selectDraft);
  const imports = discoverImports(draft);
  if (imports.length === 0) {
    return <div className="prompts-imports-empty">No imports</div>;
  }
  return (
    <div className="prompts-imports" data-testid="prompts-imports">
      {imports.map((entry) => (
        <div className="prompts-import-row" key={entry.name}>
          <span className="prompts-import-name">{entry.name}</span>
          <span className="prompts-import-path">{entry.path}</span>
        </div>
      ))}
    </div>
  );
}

/** One discovered input field row: name + type pill + a value input. */
function InputRow({ input, value }: { input: Input; value: string }) {
  const selectedId = usePromptsStore((state) => state.selectedId);
  const setValue = usePromptsStore((state) => state.setValue);
  return (
    <div className="prompts-input-row">
      <div className="prompts-input-head">
        <span className="prompts-input-name">{input.name}</span>
        {input.type ? <span className="prompts-type-pill">{input.type}</span> : null}
      </div>
      <input
        className="field-input is-mono"
        placeholder={input.default || "Value…"}
        value={value}
        onChange={(event) => setValue(selectedId, input.name, event.target.value)}
        data-testid="prompts-input"
      />
    </div>
  );
}

/** The Inputs tab: the DISCOVERED INPUTS form + the "Preview with values" action. */
function InputsTab() {
  const selectedId = usePromptsStore((state) => state.selectedId);
  const draft = usePromptsStore(selectDraft);
  // Select the stable per-prompt record (undefined when untouched) and default in
  // the render body, so the selector never returns a fresh `{}` per render.
  const stored = usePromptsStore((state) => state.valuesById[state.selectedId]);
  const values = stored ?? {};
  const unsaved = usePromptsStore(selectHasInputChanges);
  const renderNow = usePromptsStore((state) => state.renderNow);
  const inputs = discoverInputs(draft);

  return (
    <div className="prompts-inputs" data-testid="prompts-inputs">
      <div className="prompts-inputs-head">
        <span className="rev-create-head">Discovered inputs</span>
        {unsaved ? <span className="prompts-unsaved-pill">Unsaved values</span> : null}
      </div>
      {inputs.length > 0 ? (
        <>
          {inputs.map((input) => (
            <InputRow key={input.name} input={input} value={values[input.name] ?? ""} />
          ))}
          <button
            className="btn btn-brand"
            type="button"
            onClick={() => renderNow(selectedId)}
          >
            Preview with values
          </button>
        </>
      ) : (
        <div className="prompts-inputs-empty">No inputs discovered</div>
      )}
    </div>
  );
}

/** The Preview tab: the rendered text, a Rendering… row, or the empty + Generate. */
function PreviewTab() {
  const selectedId = usePromptsStore((state) => state.selectedId);
  const previewing = usePromptsStore((state) => state.previewing);
  const preview = usePromptsStore((state) => state.previewById[state.selectedId] ?? null);
  const renderNow = usePromptsStore((state) => state.renderNow);

  if (previewing) {
    return (
      <div className="prompts-rendering" data-testid="prompts-rendering">
        <span className="prompts-spinner" />
        Rendering…
      </div>
    );
  }
  if (preview == null) {
    return (
      <div className="prompts-preview-empty">
        <span>No preview available</span>
        <button className="btn btn-brand" type="button" onClick={() => renderNow(selectedId)}>
          Generate Preview
        </button>
      </div>
    );
  }
  return (
    <pre className="prompts-preview-pane" data-testid="prompts-preview">
      {preview}
    </pre>
  );
}

/** The detail pane: tab bar (with Save + unsaved dot) over the active tab body. */
function PromptDetail() {
  const selectedId = usePromptsStore((state) => state.selectedId);
  const tab = usePromptsStore((state) => state.tab);
  const setTab = usePromptsStore((state) => state.setTab);
  const save = usePromptsStore((state) => state.save);
  const sourceDirty = usePromptsStore(selectHasSourceChanges);
  const inputsDirty = usePromptsStore(selectHasInputChanges);

  return (
    <div className="rev-detail prompts-detail">
      <div className="prompts-tabs" data-testid="prompts-tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={tab === entry.id ? "prompts-tab is-on" : "prompts-tab"}
            onClick={() => setTab(entry.id)}
            data-testid={`prompts-tab-${entry.id}`}
          >
            {entry.label}
            {entry.id === "inputs" && inputsDirty ? (
              <span className="prompts-tab-dot" />
            ) : null}
          </button>
        ))}
        {sourceDirty ? (
          <button
            className="btn btn-brand prompts-save-btn"
            type="button"
            onClick={() => save(selectedId)}
            data-testid="prompts-save"
          >
            Save
          </button>
        ) : null}
      </div>

      <DiscardBar />

      <div className="prompts-tab-body">
        {tab === "source" ? <SourceTab /> : null}
        {tab === "imports" ? <ImportsTab /> : null}
        {tab === "inputs" ? <InputsTab /> : null}
        {tab === "preview" ? <PreviewTab /> : null}
      </div>
    </div>
  );
}

/** The full prompts EDITOR surface: a prompt list rail and a tabbed detail pane. */
export function PromptsCanvas() {
  const prompts = usePromptsStore((state) => state.prompts);
  const selected = usePromptsStore(
    (state) => state.prompts.find((prompt) => prompt.id === state.selectedId) ?? null,
  );
  const draft = usePromptsStore(selectDraft);

  // The header sub echoes the selected entryFile + discovered-input count, the
  // way VcsCanvas shows branch@head · counts. Count is derived from the live
  // draft so it tracks edits, not the seed.
  const count = selected ? discoverInputs(draft).length : 0;

  return (
    <section className="surface" data-testid="prompts-canvas">
      <header className="surface-head">
        <span className="surface-title">Prompts</span>
        {selected ? (
          <span className="surface-sub">
            <code className="cron-pattern">{selected.entryFile}</code> · {count} input
            {count === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="surface-sub">{prompts.length} prompts</span>
        )}
      </header>

      <div className="rev-body prompts-body">
        <PromptList />
        {selected ? <PromptDetail /> : <div className="rev-detail-empty">Select a prompt</div>}
      </div>
    </section>
  );
}
