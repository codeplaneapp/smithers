import { openSurface } from "../app/navigation";
import {
  changedFileCount,
  toneForWorkflowStatus,
  WORKFLOW_STATUS_LABEL,
  type WorkflowDoc,
} from "./workflowDocs";
import { useWorkflowEditorStore } from "./workflowEditorStore";

function BranchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
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

/**
 * The inline workflow-editor card: the selected workflow's name, path, status,
 * its first few imports, an unsaved hint, and a jump into the editor surface.
 * Mirrors VcsCard — a compact chat summary that escalates to the full canvas.
 */
export function WorkflowEditorCard() {
  const doc = useWorkflowEditorStore(
    (state) => state.workflows.find((w) => w.id === state.selectedId) ?? state.workflows[0] ?? null,
  );
  const changed = useWorkflowEditorStore((state) => {
    const target = state.workflows.find((w) => w.id === state.selectedId) ?? state.workflows[0] ?? null;
    if (!target) return 0;
    return changedFileCount(target, state.sourceDraft, state.importDrafts);
  });
  const runDoctor = useWorkflowEditorStore((state) => state.runDoctor);

  if (!doc) {
    return (
      <article className="list-card" data-testid="workflow-editor-card">
        <div className="card-body">No workflows installed.</div>
      </article>
    );
  }

  const shownImports = doc.imports.slice(0, 4);

  return (
    <article className="list-card" data-testid="workflow-editor-card">
      <header className="card-head">
        <span className="card-icon">
          <BranchIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">{doc.name}</div>
          <div className="card-sub">
            <code className="cron-pattern">{doc.filePath}</code>
          </div>
        </div>
        <button
          className="card-link"
          type="button"
          onClick={() => openSurface({ kind: "workflowEditor", id: doc.id })}
        >
          Open editor ›
        </button>
      </header>

      <div className="card-body card-body-flush">
        <div className="list-row">
          <span className={`state-badge ${toneForWorkflowStatus(doc.status)}`}>
            {WORKFLOW_STATUS_LABEL[doc.status]}
          </span>
          {changed > 0 ? (
            <span className="mini-tag tone-waiting">{changed} unsaved</span>
          ) : null}
        </div>
        {shownImports.map((file) => (
          <div className="list-row" key={file.path}>
            <span aria-hidden="true">{file.kind === "component" ? "🧩" : "📄"}</span>
            <div className="list-text">
              <div className="list-name">{file.name}</div>
            </div>
          </div>
        ))}
      </div>

      <footer className="card-foot">
        <button className="btn" type="button" onClick={runDoctor}>
          Run Doctor
        </button>
        <button
          className="btn btn-brand"
          type="button"
          onClick={() => openSurface({ kind: "workflowEditor", id: doc.id })}
        >
          Open editor ›
        </button>
      </footer>
    </article>
  );
}
