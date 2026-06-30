import "./workflowEditor.css";
import {
  changedFileCount,
  DOCTOR_SEVERITY_GLYPH,
  FIELD_KIND_LABEL,
  findWorkflowDoc,
  inputPipeline,
  summarizeDoctor,
  toneForDoctorSeverity,
  toneForRunStatus,
  toneForWorkflowStatus,
  WORKFLOW_STATUS_LABEL,
  type LaunchField,
  type WorkflowDoc,
  type WorkflowImport,
} from "./workflowDocs";
import { openSurface } from "../app/navigation";
import { useWorkflowEditorStore, type WorkflowEditorTab } from "./workflowEditorStore";

// --- small inline glyphs (currentColor, sized by font) ----------------------

function BranchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" width="14" height="14">
      <path
        d="M6 3v12M6 21a2 2 0 1 0 0-.01M6 3a2 2 0 1 0 0 .01M18 9a2 2 0 1 0 0-.01M18 9c0 4-6 2-6 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ImportGlyph({ kind }: { kind: WorkflowImport["kind"] }) {
  // Puzzlepiece for a component, doc for a prompt.
  return kind === "component" ? <span aria-hidden="true">🧩</span> : <span aria-hidden="true">📄</span>;
}

// --- tabs -------------------------------------------------------------------

const ALL_TABS: { id: WorkflowEditorTab; label: string }[] = [
  { id: "source", label: "Workflow" },
  { id: "imports", label: "Imports" },
  { id: "runs", label: "Runs" },
  { id: "app", label: "App" },
  { id: "launch", label: "Launch" },
];

/** Tabs available for a doc: the App tab only when a frontend descriptor exists. */
function availableTabs(doc: WorkflowDoc): typeof ALL_TABS {
  return ALL_TABS.filter((tab) => tab.id !== "app" || doc.frontend !== null);
}

// --- the rail ---------------------------------------------------------------

function WorkflowRail({
  workflows,
  selectedId,
  onSelect,
}: {
  workflows: WorkflowDoc[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (workflows.length === 0) {
    return (
      <div className="rev-list">
        <div className="rev-empty">
          <BranchIcon /> No workflows found
        </div>
      </div>
    );
  }
  return (
    <div className="rev-list" data-testid="wfe-rail">
      {workflows.map((doc) => (
        <button
          key={doc.id}
          type="button"
          className={selectedId === doc.id ? "rev-row is-on" : "rev-row"}
          onClick={() => onSelect(doc.id)}
          data-testid="wfe-rail-row"
        >
          <span className="rev-dot">
            <BranchIcon />
          </span>
          <div className="rev-row-main">
            <div className="rev-row-title">{doc.name}</div>
            <div className="wfe-rail-path">{doc.filePath}</div>
            <div className="wfe-rail-badges">
              <span className={`state-badge ${toneForWorkflowStatus(doc.status)}`}>
                {WORKFLOW_STATUS_LABEL[doc.status]}
              </span>
              {doc.lastRunStatus ? (
                <span className={`mini-tag ${toneForRunStatus(doc.lastRunStatus)}`}>
                  LAST {doc.lastRunStatus.toUpperCase()}
                </span>
              ) : null}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// --- Workflow (source) tab --------------------------------------------------

function SourceTab() {
  const sourceDraft = useWorkflowEditorStore((state) => state.sourceDraft);
  const setSource = useWorkflowEditorStore((state) => state.setSource);
  const doc = useWorkflowEditorStore((state) =>
    findWorkflowDoc(state.workflows, state.selectedId),
  );
  const modified = doc !== null && doc.source !== sourceDraft;

  return (
    <div className="wfe-editor-pane" data-testid="wfe-source-tab">
      {modified ? (
        <div className="wfe-modified-strip" data-testid="wfe-modified-strip">
          <span className="wfe-unsaved-dot" /> Modified — unsaved changes
        </div>
      ) : null}
      <textarea
        className="rev-editor"
        spellCheck={false}
        value={sourceDraft}
        onChange={(event) => setSource(event.target.value)}
        data-testid="wfe-source-editor"
      />
    </div>
  );
}

// --- Imports tab ------------------------------------------------------------

function ImportsTab({ doc }: { doc: WorkflowDoc }) {
  const selectedImportPath = useWorkflowEditorStore((state) => state.selectedImportPath);
  const importDrafts = useWorkflowEditorStore((state) => state.importDrafts);
  const selectImport = useWorkflowEditorStore((state) => state.selectImport);
  const setImportDraft = useWorkflowEditorStore((state) => state.setImportDraft);

  if (doc.imports.length === 0) {
    return (
      <div className="rev-detail-empty" data-testid="wfe-imports-empty">
        🗄 No imports found
      </div>
    );
  }

  const components = doc.imports.filter((file) => file.kind === "component");
  const prompts = doc.imports.filter((file) => file.kind === "prompt");
  const active = doc.imports.find((file) => file.path === selectedImportPath) ?? null;
  const activeDirty =
    active !== null &&
    importDrafts[active.path] !== undefined &&
    importDrafts[active.path] !== active.source;

  function section(label: string, files: WorkflowImport[]) {
    if (files.length === 0) return null;
    return (
      <div key={label}>
        <div className="wfe-import-section-head">{label}</div>
        {files.map((file) => {
          const dirty =
            importDrafts[file.path] !== undefined && importDrafts[file.path] !== file.source;
          return (
            <button
              key={file.path}
              type="button"
              className={selectedImportPath === file.path ? "wfe-import-row is-on" : "wfe-import-row"}
              onClick={() => selectImport(file.path)}
              data-testid="wfe-import-row"
            >
              <span className="wfe-import-icon">
                <ImportGlyph kind={file.kind} />
              </span>
              <div className="wfe-import-row-text">
                <div className="wfe-import-name">{file.name}</div>
                <div className="wfe-import-path">{file.path}</div>
              </div>
              {dirty ? <span className="wfe-unsaved-dot" /> : null}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="wfe-imports-split" data-testid="wfe-imports-tab">
      <aside className="wfe-imports-rail">
        {section("COMPONENTS", components)}
        {section("PROMPTS", prompts)}
      </aside>
      <div className="wfe-imports-editor">
        {active ? (
          <>
            <div className="wfe-fileinfo-bar">
              <ImportGlyph kind={active.kind} />
              <span className="wfe-fileinfo-path">{active.path}</span>
              <span className="wfe-import-kind">
                {active.kind === "component" ? "Component" : "Prompt"}
              </span>
              {activeDirty ? <span className="wfe-unsaved-dot" /> : null}
            </div>
            <textarea
              className="rev-editor"
              spellCheck={false}
              value={importDrafts[active.path] ?? active.source}
              onChange={(event) => setImportDraft(active.path, event.target.value)}
              data-testid="wfe-import-editor"
            />
          </>
        ) : (
          <div className="rev-detail-empty">Select an imported file to edit</div>
        )}
      </div>
    </div>
  );
}

// --- Launch tab: Doctor section ---------------------------------------------

function DoctorSection({ doc }: { doc: WorkflowDoc }) {
  const doctorRun = useWorkflowEditorStore((state) => state.doctorRun);
  const runDoctor = useWorkflowEditorStore((state) => state.runDoctor);
  const summary = summarizeDoctor(doc.doctorIssues);
  const clean = summary.error === 0 && summary.warning === 0;

  return (
    <div className="wfe-section" data-testid="wfe-doctor">
      <div className="wfe-section-head">
        Workflow Doctor
        <span className="wfe-section-spacer" />
        <button className="btn" type="button" onClick={runDoctor} data-testid="wfe-run-doctor">
          🩺 Run Doctor
        </button>
      </div>
      {!doctorRun || doc.doctorIssues.length === 0 ? (
        <div className="wfe-doctor-empty">Run diagnostics to verify workflow launch readiness.</div>
      ) : (
        <>
          {doc.doctorIssues.map((issue, index) => (
            <div
              key={`${issue.severity}-${index}`}
              className={`wfe-doctor-issue ${toneForDoctorSeverity(issue.severity)}`}
            >
              <span className="wfe-doctor-glyph">{DOCTOR_SEVERITY_GLYPH[issue.severity]}</span>
              <div>
                <div>{issue.message}</div>
                {issue.detail ? <div className="wfe-doctor-issue-detail">{issue.detail}</div> : null}
              </div>
            </div>
          ))}
          <div className={`wfe-doctor-summary ${clean ? "is-ok" : "is-warn"}`}>
            {clean ? "All checks passed." : "Issues found. Review warnings and errors above."}
          </div>
        </>
      )}
    </div>
  );
}

// --- Launch tab: DAG section ------------------------------------------------

function DagSection({ doc }: { doc: WorkflowDoc }) {
  const showDagDetails = useWorkflowEditorStore((state) => state.showDagDetails);
  const toggleDagDetails = useWorkflowEditorStore((state) => state.toggleDagDetails);
  const pipeline = inputPipeline(doc);
  const dag = doc.dag;

  return (
    <div className="wfe-section" data-testid="wfe-dag">
      <div className="wfe-section-head">
        Workflow DAG
        <span className="wfe-section-spacer" />
        <button className="btn" type="button" onClick={toggleDagDetails}>
          {showDagDetails ? "Hide Details" : "Show Details"}
        </button>
      </div>

      <div className="wfe-dag-meta">
        <span className={`wfe-dag-mode ${dag.mode === "inferred" ? "is-inferred" : "is-explicit"}`}>
          {dag.mode === "inferred" ? "INFERRED" : "EXPLICIT"}
        </span>{" "}
        entry <code>{dag.entry}</code> · {dag.nodes.length} node
        {dag.nodes.length === 1 ? "" : "s"} /{" "}
        {dag.nodes.reduce((sum, node) => sum + node.edges.length, 0)} edge
        {dag.nodes.reduce((sum, node) => sum + node.edges.length, 0) === 1 ? "" : "s"}
      </div>

      {dag.nodes.length > 0 ? (
        dag.nodes.map((node) => (
          <div className="wfe-dag-node" key={node.id} data-testid="wfe-dag-node">
            <div className="wfe-dag-node-head">
              <span className="wfe-dag-node-id">{node.id}</span>
              {node.outputTable ? <span className="mini-tag">{node.outputTable}</span> : null}
              {node.needsApproval ? <span className="mini-tag tone-waiting">approval</span> : null}
            </div>
            {node.edges.length > 0 ? (
              <div className="wfe-dag-edges">→ {node.edges.join(", ")}</div>
            ) : null}
          </div>
        ))
      ) : pipeline.length > 0 ? (
        <div className="wfe-dag-pipeline" data-testid="wfe-dag-pipeline">
          {pipeline.map((step, index) => (
            <span key={`${step}-${index}`} style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
              <span className="wfe-pipe-chip">{step}</span>
              {index < pipeline.length - 1 ? <span className="wfe-pipe-arrow">→</span> : null}
            </span>
          ))}
        </div>
      ) : (
        <div className="wfe-doctor-empty">No graph nodes detected.</div>
      )}

      {showDagDetails && doc.launchFields.length > 0 ? (
        <div className="wfe-dag-schema" data-testid="wfe-dag-schema">
          <div className="wfe-import-section-head">SCHEMA DETAILS</div>
          {doc.launchFields.map((field) => (
            <div className="wfe-dag-schema-row" key={field.key}>
              <span className="wfe-launch-field-name">{field.key}</span>
              <code>{FIELD_KIND_LABEL[field.type]}</code>
              <code>key: {field.key}</code>
              {field.defaultValue !== undefined && field.defaultValue !== "" ? (
                <code>default: {field.defaultValue}</code>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// --- Launch tab: typed inputs + Run -----------------------------------------

function LaunchFieldRow({ field }: { field: LaunchField }) {
  const value = useWorkflowEditorStore((state) => state.launchInputs[field.key] ?? "");
  const error = useWorkflowEditorStore((state) => state.validationErrors[field.key]);
  const setInput = useWorkflowEditorStore((state) => state.setInput);
  const toggleBoolInput = useWorkflowEditorStore((state) => state.toggleBoolInput);

  const jsonPlaceholder =
    field.type === "object" ? "{}" : field.type === "array" ? "[]" : "JSON value";

  return (
    <div className="wfe-launch-field" data-testid="wfe-launch-field">
      <div className="wfe-launch-field-head">
        <span className="wfe-launch-field-name">{field.key}</span>
        <span className="wfe-field-kind">{FIELD_KIND_LABEL[field.type]}</span>
        {field.required ? <span className="wfe-field-required">required</span> : null}
      </div>

      {field.type === "boolean" ? (
        <button
          type="button"
          className={value === "true" ? "wfe-bool-toggle is-true" : "wfe-bool-toggle"}
          onClick={() => toggleBoolInput(field.key)}
        >
          {value === "true" ? "true" : "false"}
        </button>
      ) : field.type === "object" || field.type === "array" || field.type === "json" ? (
        <textarea
          className="field-input is-mono is-area"
          placeholder={jsonPlaceholder}
          value={value}
          onChange={(event) => setInput(field.key, event.target.value)}
        />
      ) : (
        <input
          className={field.type === "number" ? "field-input is-mono" : "field-input"}
          placeholder={field.defaultValue || "Value…"}
          value={value}
          onChange={(event) => setInput(field.key, event.target.value)}
        />
      )}

      {error ? <div className="wfe-field-error">{error}</div> : null}
    </div>
  );
}

function LaunchInputsSection({ doc }: { doc: WorkflowDoc }) {
  const launching = useWorkflowEditorStore((state) => state.launching);
  const validationErrors = useWorkflowEditorStore((state) => state.validationErrors);
  const pendingRunConfirm = useWorkflowEditorStore((state) => state.pendingRunConfirm);
  const runWorkflow = useWorkflowEditorStore((state) => state.runWorkflow);
  const confirmRun = useWorkflowEditorStore((state) => state.confirmRun);
  const cancelRun = useWorkflowEditorStore((state) => state.cancelRun);

  const hasErrors = Object.keys(validationErrors).length > 0;
  const disabled = launching || hasErrors;

  return (
    <div className="wfe-section" data-testid="wfe-launch-inputs">
      <div className="wfe-section-head">Launch Inputs</div>
      {doc.launchFields.length === 0 ? (
        <div className="wfe-launch-empty">
          No dynamic input fields were detected. Running this workflow will require confirmation.
        </div>
      ) : (
        doc.launchFields.map((field) => <LaunchFieldRow key={field.key} field={field} />)
      )}

      {pendingRunConfirm ? (
        <div className="wfe-confirm" data-testid="wfe-run-confirm">
          <div className="wfe-confirm-msg">Run "{doc.name}" with no input form?</div>
          <div className="wfe-confirm-actions">
            <button className="btn btn-brand" type="button" onClick={confirmRun}>
              Run Workflow
            </button>
            <button className="btn" type="button" onClick={cancelRun}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="wfe-launch-foot">
          <button
            className="btn btn-brand"
            type="button"
            onClick={runWorkflow}
            disabled={disabled}
            data-testid="wfe-run-workflow"
          >
            {launching ? "Launching..." : "Run Workflow"}
          </button>
        </div>
      )}

      {doc.lastRunStatus ? (
        <div className="wfe-last-run">Last run: {doc.lastRunStatus}</div>
      ) : null}
      {doc.runError ? <div className="wfe-run-error">Run failed: {doc.runError}</div> : null}
    </div>
  );
}

function LaunchTab({ doc }: { doc: WorkflowDoc }) {
  return (
    <div className="wfe-tab-body" data-testid="wfe-launch-tab">
      <DoctorSection doc={doc} />
      <DagSection doc={doc} />
      <LaunchInputsSection doc={doc} />
    </div>
  );
}

// --- Runs tab ---------------------------------------------------------------

function RunsTab({ doc }: { doc: WorkflowDoc }) {
  const runs = doc.runs;
  return (
    <div className="wfe-tab-body" data-testid="wfe-runs-tab">
      <div className="wfe-runs-head">
        {runs.length} run{runs.length === 1 ? "" : "s"}
        <span className="wfe-section-spacer" />
        <button className="btn" type="button">
          ↻ Refresh
        </button>
      </div>
      {runs.length === 0 ? (
        <div className="rev-detail-empty">
          <div>No runs yet</div>
          <div className="wfe-rail-path">Launch this workflow from the Launch tab</div>
        </div>
      ) : (
        runs.map((run) => (
          <button
            key={run.id}
            type="button"
            className="wfe-runs-row"
            onClick={() => openSurface({ kind: "inspector", runId: run.id })}
            data-testid="wfe-runs-row"
          >
            <span className={`rev-dot ${toneForRunStatus(run.status)}`} />
            <span className="wfe-runs-row-id">{run.id.slice(0, 12)}</span>
            <span className={`state-badge ${toneForRunStatus(run.status)}`}>
              {run.status.toUpperCase()}
            </span>
            <span className="wfe-run-summary">
              <span>{run.whenLabel}</span>
              <span>{run.elapsedLabel}</span>
              <span>
                {run.doneNodes}/{run.totalNodes} tasks
              </span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}

// --- App tab (frontend panel) -----------------------------------------------

const PHASE_META = {
  starting: { label: "Starting", glyph: "⚡", tone: "tone-waiting" },
  ready: { label: "Live", glyph: "📡", tone: "tone-ok" },
  failed: { label: "Failed", glyph: "▲", tone: "tone-failed" },
} as const;

function AppTab({ doc }: { doc: WorkflowDoc }) {
  const frontendPhase = useWorkflowEditorStore((state) => state.frontendPhase);
  const restartFrontend = useWorkflowEditorStore((state) => state.restartFrontend);

  if (!doc.frontend) {
    return (
      <div className="wfe-tab-body" data-testid="wfe-app-tab">
        <div className="wfe-frontend-empty">
          <div className="wfe-frontend-empty-title">No custom frontend</div>
          <div className="wfe-rail-path">
            Add a <code>&lt;workflow&gt;.frontend/manifest.json</code> bundle next to the workflow to
            expose an app here.
          </div>
        </div>
      </div>
    );
  }

  const phase = PHASE_META[frontendPhase];

  return (
    <div className="wfe-tab-body" data-testid="wfe-app-tab">
      <div className="wfe-frontend-head">
        <div className="wfe-frontend-head-text">
          <div className="wfe-frontend-name">{doc.frontend.name}</div>
          <div className="wfe-frontend-sub">
            {doc.frontend.framework} frontend served from {doc.frontend.dir}
          </div>
        </div>
        <span className={`wfe-frontend-phase ${phase.tone}`}>
          <span aria-hidden="true">{phase.glyph}</span> {phase.label}
        </span>
        <button className="btn" type="button" onClick={restartFrontend}>
          Restart
        </button>
      </div>

      {frontendPhase === "starting" ? (
        <div className="wfe-frontend-body">
          <div className="wfe-frontend-body-inner">
            <span aria-hidden="true">⏳</span> Starting frontend…
          </div>
        </div>
      ) : frontendPhase === "failed" ? (
        <div className="wfe-frontend-body">
          <div className="wfe-frontend-body-inner">
            <span aria-hidden="true">▲</span>
            <div>Frontend failed to start.</div>
            <button className="btn btn-brand" type="button" onClick={restartFrontend}>
              Retry
            </button>
          </div>
        </div>
      ) : (
        <div className="wfe-frontend-body">
          <div className="wfe-frontend-body-inner">
            <div className="wfe-frontend-name">{doc.frontend.name}</div>
            <div className="wfe-rail-path">Ready · served from {doc.frontend.dir}</div>
            <button className="btn" type="button">
              Open In Browser ↗
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- the detail pane (tab bar + active tab) ---------------------------------

function DetailPane({ doc }: { doc: WorkflowDoc }) {
  const tab = useWorkflowEditorStore((state) => state.tab);
  const setTab = useWorkflowEditorStore((state) => state.setTab);
  const sourceDraft = useWorkflowEditorStore((state) => state.sourceDraft);
  const importDrafts = useWorkflowEditorStore((state) => state.importDrafts);
  const saving = useWorkflowEditorStore((state) => state.saving);
  const saveAll = useWorkflowEditorStore((state) => state.saveAll);

  const tabs = availableTabs(doc);
  // If the App tab vanished (no descriptor) while active, fall back to Workflow.
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "source";
  const changed = changedFileCount(doc, sourceDraft, importDrafts);

  return (
    <div className="rev-detail" data-testid="wfe-detail">
      <DiscardConfirm />
      <div className="wfe-tabs" data-testid="wfe-tabs">
        {tabs.map((entry) => {
          const count =
            entry.id === "imports"
              ? doc.imports.length
              : entry.id === "runs"
                ? doc.runs.length
                : null;
          return (
            <button
              key={entry.id}
              type="button"
              className={activeTab === entry.id ? "wfe-tab is-on" : "wfe-tab"}
              onClick={() => setTab(entry.id)}
              data-testid={`wfe-tab-${entry.id}`}
            >
              {entry.label}
              {count !== null && count > 0 ? <span className="mini-tag">{count}</span> : null}
            </button>
          );
        })}
        {changed > 0 ? (
          <div className="wfe-unsaved">
            <span className="wfe-unsaved-count" data-testid="wfe-unsaved-count">
              <span className="wfe-unsaved-dot" /> {changed} unsaved
            </span>
            <button
              className="btn btn-brand"
              type="button"
              onClick={saveAll}
              disabled={saving}
              data-testid="wfe-save-all"
            >
              Save All
            </button>
          </div>
        ) : null}
      </div>

      {activeTab === "source" ? <SourceTab /> : null}
      {activeTab === "imports" ? <ImportsTab doc={doc} /> : null}
      {activeTab === "runs" ? <RunsTab doc={doc} /> : null}
      {activeTab === "app" ? <AppTab doc={doc} /> : null}
      {activeTab === "launch" ? <LaunchTab doc={doc} /> : null}
    </div>
  );
}

// --- the unsaved-changes confirm gate ---------------------------------------

function DiscardConfirm() {
  const pendingSelectId = useWorkflowEditorStore((state) => state.pendingSelectId);
  const sourceDraft = useWorkflowEditorStore((state) => state.sourceDraft);
  const importDrafts = useWorkflowEditorStore((state) => state.importDrafts);
  const doc = useWorkflowEditorStore((state) =>
    findWorkflowDoc(state.workflows, state.selectedId),
  );
  const confirmDiscard = useWorkflowEditorStore((state) => state.confirmDiscard);
  const cancelDiscard = useWorkflowEditorStore((state) => state.cancelDiscard);

  if (pendingSelectId === null || doc === null) return null;
  const changed = changedFileCount(doc, sourceDraft, importDrafts);

  return (
    <div className="wfe-confirm wfe-confirm-inset" data-testid="wfe-discard-confirm">
      <div className="wfe-confirm-msg">
        Unsaved Changes — you have unsaved changes to {changed} file{changed === 1 ? "" : "s"}.
        Discard them?
      </div>
      <div className="wfe-confirm-actions">
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

// --- the surface ------------------------------------------------------------

/**
 * The workflow editor surface: a left rail of installed workflows and a five-tab
 * detail pane (Workflow | Imports | Runs | App | Launch). The route param is
 * reconciled into the store's selection by the route page (`setRoute`) before
 * this renders, so the canvas reads `selectedId` straight from the store — the
 * URL stays the source of truth without a useEffect. Selecting a rail row routes
 * through `select`, which guards on unsaved changes.
 */
export function WorkflowEditorCanvas({ id }: { id: string }) {
  const workflows = useWorkflowEditorStore((state) => state.workflows);
  const selectedId = useWorkflowEditorStore((state) => state.selectedId);
  const select = useWorkflowEditorStore((state) => state.select);

  // The route page has already reconciled `id` -> selectedId; fall back to it
  // here only when the store has not caught up (e.g. an unknown id).
  const doc =
    findWorkflowDoc(workflows, selectedId) ?? findWorkflowDoc(workflows, id);

  return (
    <section className="surface" data-testid="workflow-editor-canvas">
      <header className="surface-head">
        <span className="surface-title">{doc ? doc.name : "Workflows"}</span>
        {doc ? <span className="surface-sub">{doc.filePath}</span> : null}
      </header>

      <div className="rev-body">
        <WorkflowRail workflows={workflows} selectedId={selectedId} onSelect={select} />

        {doc ? <DetailPane doc={doc} /> : (
          <div className="rev-detail-empty">
            <BranchIcon /> Select a workflow
          </div>
        )}
      </div>
    </section>
  );
}
