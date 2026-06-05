import type { CSSProperties } from "react";
import { STORE_WORKFLOWS, type StoreWorkflow } from "./workflows";

/** The "app store" of workflows — a browsable grid of cards you can open. */
export function WorkflowStore({
  onOpen,
}: {
  onOpen: (workflow: StoreWorkflow) => void;
}) {
  return (
    <div className="store">
      <div className="store-inner">
        <header className="store-header">
          <h1 className="store-title">Workflow Store</h1>
          <p className="store-subtitle">
            Pick a workflow to get started — each one drops you straight into a
            guided task.
          </p>
        </header>

        <div className="store-grid">
          {STORE_WORKFLOWS.map((workflow) => (
            <button
              className="store-card"
              key={workflow.id}
              style={{ "--card-color": workflow.color } as CSSProperties}
              type="button"
              onClick={() => onOpen(workflow)}
            >
              <span className="store-icon" aria-hidden="true">
                {workflow.icon}
              </span>
              <span className="store-card-head">
                <span className="store-name">{workflow.name}</span>
                <span className="store-tag">{workflow.category}</span>
              </span>
              <span className="store-desc">{workflow.description}</span>
              <span className="store-open">Open →</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
