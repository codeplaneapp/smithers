/** @jsxImportSource react */
import { useState } from "react";

export type LaunchState = { runId: string | null; error: string | null };

export type StartPaneProps = {
  /** True when the spec is missing or the seeded stub: the pane is the landing view and cannot be dismissed. */
  stub: boolean;
  onClose: (() => void) | null;
  onCreateApp: (description: string) => void;
  onGenerateDocs: () => void;
  createState: LaunchState;
  generateState: LaunchState;
  /** Detached bug-scan run id once ddd-generate-docs reports its kickoff. */
  bugScanRunId: string;
  /** Same-origin href to another workflow's run UI (e.g. create-workflow). */
  workflowUiHref: (workflowKey: string, runId: string) => string;
};

function LaunchStatus({ state, label, href }: { state: LaunchState; label: string; href?: string }) {
  if (state.error) {
    return (
      <p className="start-status" data-testid="ddd-start-error">
        <span className="badge bad">Failed</span> {state.error}
      </p>
    );
  }
  if (!state.runId) return null;
  return (
    <p className="start-status" data-testid="ddd-start-launched">
      <span className="badge ok">Running</span> {label}{" "}
      {href ? (
        <a className="doc-link" href={href} target="_blank" rel="noreferrer">
          open run UI ↗
        </a>
      ) : (
        <span className="pill">{state.runId}</span>
      )}
    </p>
  );
}

/**
 * The way in. Two honest entries: scaffold a brand-new app (via the
 * create-workflow authoring workflow, which builds the app's builder workflow)
 * or generate the spec from the code that already exists (ddd-generate-docs,
 * which then kicks off the async bug scan).
 */
export function StartPane(props: StartPaneProps) {
  const [description, setDescription] = useState("");
  const canCreate = description.trim().length >= 8;

  return (
    <div className="start pane scroll" data-testid="ddd-start-pane">
      <section className="card start-intro">
        <div className="card-head">
          <h2>{props.stub ? "Set up docs-driven development" : "Start something new"}</h2>
          {props.onClose ? (
            <button type="button" className="icon-button" aria-label="Close" onClick={props.onClose}>
              ×
            </button>
          ) : null}
        </div>
        <p>
          Docs-driven development keeps a living spec of your product and puts agents to work closing the gaps
          in it. Start from a brand-new app idea, or point it at the code you already have.
        </p>
      </section>

      <div className="grid2 start-options">
        <section className="card" data-testid="ddd-start-create">
          <span className="eyebrow">New app</span>
          <h2>Create a new app</h2>
          <p>
            Describe the app. Smithers authors a dedicated builder workflow for it (clarify, design, scaffold,
            verify), then that workflow builds the app docs-first: its spec stays the source of truth while the
            code grows to match.
          </p>
          <textarea
            className="search-input start-textarea"
            data-testid="ddd-start-description"
            placeholder="A CLI that turns a folder of markdown notes into a searchable static site…"
            value={description}
            rows={4}
            onChange={(event) => setDescription(event.target.value)}
          />
          <div className="start-actions">
            <button
              type="button"
              className="button primary"
              data-testid="ddd-start-create-launch"
              disabled={!canCreate || !!props.createState.runId}
              onClick={() => props.onCreateApp(description.trim())}
            >
              Create app + builder workflow
            </button>
          </div>
          <LaunchStatus
            state={props.createState}
            label="create-workflow is designing the builder."
            href={props.createState.runId ? props.workflowUiHref("create-workflow", props.createState.runId) : undefined}
          />
        </section>

        <section className="card" data-testid="ddd-start-generate">
          <span className="eyebrow">Existing code</span>
          <h2>Generate docs from this repo</h2>
          <p>
            Agents read your README, docs, and code, then write the feature spec with honest statuses: proven
            things are fixed, everything else is recorded as a gap. When the spec lands, an async bug scan
            starts hunting your code and files tickets for what it can verify.
          </p>
          <div className="start-actions">
            <button
              type="button"
              className="button primary"
              data-testid="ddd-start-generate-launch"
              disabled={!!props.generateState.runId}
              onClick={props.onGenerateDocs}
            >
              Generate docs
            </button>
          </div>
          <LaunchStatus state={props.generateState} label="ddd-generate-docs is reading your repo." />
          {props.bugScanRunId ? (
            <p className="start-status" data-testid="ddd-start-bug-scan">
              <span className="badge ok">Bug scan</span> Async scan running as <span className="pill">{props.bugScanRunId}</span>;
              confirmed findings appear in Tickets.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
