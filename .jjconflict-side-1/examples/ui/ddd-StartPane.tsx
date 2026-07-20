/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { formatStatus, isTerminalRunStatus, statusClass } from "./ddd-shared";

export type LaunchState = {
  runId: string | null;
  error: string | null;
  pending?: boolean;
  status?: string;
  statusLoading?: boolean;
  statusError?: string;
};

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
  /** Kickoff summary when the scan was blocked or failed instead of launched. */
  bugScanSummary?: string;
  /** Same-origin href to another workflow's run UI (e.g. create-workflow). */
  workflowUiHref: (workflowKey: string, runId: string) => string;
  /** Reloads the current DDD UI after generated modules have changed. */
  onReload?: () => void;
};

export type NewEntryMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateApp: (description: string) => void;
  onGenerateDocs: () => void;
  createState: LaunchState;
  generateState: LaunchState;
  bugScanRunId: string;
  bugScanSummary?: string;
  workflowUiHref: (workflowKey: string, runId: string) => string;
};

function launchIsActive(state: LaunchState): boolean {
  if (!state.runId) return false;
  if (!state.status) return true;
  return !isTerminalRunStatus(state.status);
}

function LaunchStatus({ state, label, href, testId = "ddd-start-launched" }: { state: LaunchState; label: string; href?: string; testId?: string }) {
  if (state.pending) {
    return (
      <p className="start-status" data-testid={`${testId}-launching`}>
        <span className="badge warn">Launching</span> {label}
      </p>
    );
  }
  if (state.error) {
    return (
      <p className="start-status" data-testid="ddd-start-error">
        <span className="badge bad">Failed</span> {state.error}
      </p>
    );
  }
  if (!state.runId) return null;
  const status = state.status || "running";
  const terminal = isTerminalRunStatus(status);
  return (
    <p className="start-status" data-testid={testId}>
      <span className={`badge ${statusClass(status)}`}>{state.statusLoading ? "Checking" : formatStatus(status)}</span> {label}{" "}
      {href ? (
        <a className="doc-link" href={href} target="_blank" rel="noreferrer">
          open run UI ↗
        </a>
      ) : (
        <span className="pill">{state.runId}</span>
      )}
      {terminal ? <span className="pill muted">Ready for another launch</span> : null}
      {state.statusError ? <span className="badge bad" data-testid={`${testId}-status-error`} title={state.statusError}>Status unavailable</span> : null}
    </p>
  );
}

function BugScanStatus({ runId, summary, href }: { runId: string; summary?: string; href?: string }) {
  if (runId) {
    return (
      <p className="start-status" data-testid="ddd-start-bug-scan">
        <span className="badge ok">Bug scan</span> Async scan running{" "}
        {href ? (
          <a className="doc-link" href={href} target="_blank" rel="noreferrer">
            {runId}
          </a>
        ) : (
          <span className="pill">{runId}</span>
        )}{" "}
        confirmed findings appear in Tickets.
      </p>
    );
  }
  if (!summary) return null;
  const failed = /failed|blocked|not approved/i.test(summary);
  return (
    <p className="start-status" data-testid="ddd-start-bug-scan-blocked">
      <span className={`badge ${failed ? "bad" : "warn"}`}>{failed ? "Bug scan blocked" : "Bug scan"}</span>
      {summary}
    </p>
  );
}

export function NewEntryMenu(props: NewEntryMenuProps) {
  const [description, setDescription] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canCreate = description.trim().length >= 8;
  const createDisabled = !canCreate || !!props.createState.pending || launchIsActive(props.createState);
  const generateDisabled = !!props.generateState.pending || launchIsActive(props.generateState);
  const generatedDocsRunHref = props.generateState.runId
    ? props.workflowUiHref("ddd-generate-docs", props.generateState.runId)
    : undefined;
  const bugScanRunHref = props.bugScanRunId
    ? props.workflowUiHref("ddd-bug-scan", props.bugScanRunId)
    : undefined;

  useEffect(() => {
    if (!props.open || typeof document === "undefined") return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && rootRef.current?.contains(target)) return;
      props.onOpenChange(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") props.onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [props.open, props.onOpenChange]);

  return (
    <div className="new-menu-wrap" ref={rootRef}>
      <button
        type="button"
        className="button"
        data-testid="ddd-open-start"
        aria-haspopup="dialog"
        aria-expanded={props.open}
        onClick={() => props.onOpenChange(!props.open)}
      >
        + New
      </button>
      {props.open ? (
        <section className="new-menu" role="dialog" aria-label="Start new DDD work" data-testid="ddd-new-menu">
          <div className="new-menu-head">
            <h2>Start new work</h2>
            <button type="button" className="icon-button" aria-label="Close new menu" onClick={() => props.onOpenChange(false)}>
              x
            </button>
          </div>
          <label className="filter-field">
            <span>New app</span>
            <textarea
              className="search-input start-textarea"
              data-testid="ddd-new-description"
              placeholder="A CLI that turns markdown notes into a searchable site..."
              value={description}
              rows={3}
              onInput={(event) => setDescription(event.currentTarget.value)}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            className="button primary"
            data-testid="ddd-new-create-launch"
            disabled={createDisabled}
            onClick={() => props.onCreateApp(description.trim())}
          >
            {props.createState.pending ? "Launching builder..." : "Create app + builder workflow"}
          </button>
          <LaunchStatus
            state={props.createState}
            label="create-workflow is designing the builder."
            href={props.createState.runId ? props.workflowUiHref("create-workflow", props.createState.runId) : undefined}
            testId="ddd-new-create-run"
          />
          <div className="new-menu-divider" />
          <button
            type="button"
            className="button"
            data-testid="ddd-new-generate-launch"
            disabled={generateDisabled}
            onClick={props.onGenerateDocs}
          >
            {props.generateState.pending ? "Launching docs..." : "Generate docs from this repo"}
          </button>
          <LaunchStatus
            state={props.generateState}
            label="ddd-generate-docs is reading your repo."
            href={generatedDocsRunHref}
            testId="ddd-new-generate-run"
          />
          <BugScanStatus runId={props.bugScanRunId} summary={props.bugScanSummary} href={bugScanRunHref} />
        </section>
      ) : null}
    </div>
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
  const createDisabled = !canCreate || !!props.createState.pending || launchIsActive(props.createState);
  const generateDisabled = !!props.generateState.pending || launchIsActive(props.generateState);
  const createAgain = !!props.createState.runId && isTerminalRunStatus(props.createState.status);
  const generateAgain = !!props.generateState.runId && isTerminalRunStatus(props.generateState.status);
  const updateDescription = (event: FormEvent<HTMLTextAreaElement>) => setDescription(event.currentTarget.value);
  const generatedDocsRunHref = props.generateState.runId
    ? props.workflowUiHref("ddd-generate-docs", props.generateState.runId)
    : undefined;
  const bugScanRunHref = props.bugScanRunId
    ? props.workflowUiHref("ddd-bug-scan", props.bugScanRunId)
    : undefined;
  const reloadGeneratedDocs = () => {
    if (props.onReload) {
      props.onReload();
      return;
    }
    window.location.reload();
  };

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
            onInput={updateDescription}
            onChange={updateDescription}
          />
          <div className="start-actions">
            <button
              type="button"
              className="button primary"
              data-testid="ddd-start-create-launch"
              disabled={createDisabled}
              onClick={() => props.onCreateApp(description.trim())}
            >
              {props.createState.pending ? "Launching builder..." : createAgain ? "Create another app + builder workflow" : "Create app + builder workflow"}
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
              disabled={generateDisabled}
              onClick={props.onGenerateDocs}
            >
              {props.generateState.pending ? "Launching docs..." : generateAgain ? "Generate docs again" : "Generate docs"}
            </button>
          </div>
          <LaunchStatus
            state={props.generateState}
            label="ddd-generate-docs is reading your repo."
            href={generatedDocsRunHref}
            testId="ddd-start-generate-run"
          />
          <BugScanStatus runId={props.bugScanRunId} summary={props.bugScanSummary} href={bugScanRunHref} />
          {props.generateState.runId ? (
            isTerminalRunStatus(props.generateState.status) ? (
              <div className="start-reload" data-testid="ddd-start-reload-path">
                <p>The generate-docs run finished. Reload this UI to load the generated spec modules.</p>
                <button type="button" className="button primary" data-testid="ddd-start-reload" onClick={reloadGeneratedDocs}>
                  Reload docs
                </button>
              </div>
            ) : (
              <p className="start-status" data-testid="ddd-start-reload-pending">
                <span className="badge warn">Working</span> Reload will be available once the generate-docs run finishes.
              </p>
            )
          ) : null}
        </section>
      </div>
    </div>
  );
}
