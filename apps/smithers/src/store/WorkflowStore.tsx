import type { CSSProperties, ReactElement } from "react";
import { useGatewayWorkflows } from "@smithers-orchestrator/gateway-react";
import { openSurface } from "../app/navigation";
import { APPS } from "../apps/appCatalog";
import { openApp } from "../apps/openApp";
import { GatewayWorkflowsSection } from "../gateway/GatewayWorkflowsSection";
import { useLocalModeRefetch } from "../sync/useLocalModeRefetch";
import { openWorkflow } from "./openWorkflow";
import { WORKFLOW_DOCS } from "./workflowDocs";
import { mapToStoreWorkflows } from "./workflowMetadata";
import type { StoreWorkflow } from "./workflows";

// The ids the workflow editor seeds a document for — only these can be edited.
// WORKFLOW_DOCS stays LOCAL (editor scaffold synthesized from .tsx on disk; the
// backend has no AST parser) — see docs/p1a-plan.md §3.D.
const EDITABLE_IDS = new Set(WORKFLOW_DOCS.map((doc) => doc.id));

/**
 * The "app store" of workflows — a browsable grid of cards you can open.
 *
 * INSTALLED-ONLY (docs/p1a-plan.md §3.D, Option A): the catalog is sourced from
 * the LIVE gateway registry via `useGatewayWorkflows({ filter: { hasUi: true } })`
 * — there is no in-app seed/demo catalog and no fake "Available" gallery. Every
 * card is a real, registered workflow. Display metadata (`icon`/`category`/
 * `color`) and the chat-affordance fields are merged client-side in
 * `mapToStoreWorkflows` (the RPC carries none of them); unknown ids fall back to
 * generic styling rather than crashing the grid.
 */
export function WorkflowStore() {
  // `hasUi: true` mirrors the gateway's own workflow list — these are the
  // workflows that have a custom UI mounted and are the ones the store surfaces.
  const { data, loading, refetch } = useGatewayWorkflows({
    filter: { hasUi: true },
  });
  // LOCAL-MODE freshness: the `workflows` collection is pull-only (registered at
  // gateway boot, no stream). Poll on a modest interval so a workflow registered
  // mid-session appears without a reload — same primitive the runs/approvals
  // bridges use. Removed on the cloud/Electric streaming path (P5).
  useLocalModeRefetch(refetch);
  const installed = mapToStoreWorkflows(data ?? []);

  return <WorkflowStoreContent installed={installed} loading={loading} />;
}

/**
 * Render the store once its live registry query has been resolved. Keeping the
 * query boundary separate gives browser coverage a repeatable way to exercise
 * the loading and empty presentations while the routed surface continues to
 * use the real Gateway collection above.
 */
export function WorkflowStoreContent({
  installed,
  loading,
  includeGatewaySection = true,
}: {
  installed: StoreWorkflow[];
  loading: boolean;
  includeGatewaySection?: boolean;
}) {
  return (
    <div className="store">
      <div className="store-inner">
        <header className="store-header">
          <h1 className="store-title">Workflow Store</h1>
          <p className="store-subtitle">
            Open an installed workflow to drop into a guided task. The catalog is
            the live set of workflows registered on your gateway.
          </p>
        </header>

        <AppsSection />

        {loading && installed.length === 0 ? (
          <p className="store-empty" data-testid="store-loading">
            Loading workflows…
          </p>
        ) : installed.length === 0 ? (
          <p className="store-empty" data-testid="store-empty">
            No workflows registered on the gateway yet.
          </p>
        ) : null}

        <StoreSection
          count={`${installed.length} ready to run`}
          title="Installed"
          workflows={installed}
          renderCard={(workflow) => (
            <button
              className="store-card"
              key={workflow.id}
              style={{ "--card-color": workflow.color } as CSSProperties}
              type="button"
              onClick={() => openWorkflow(workflow)}
            >
              <StoreCardBody workflow={workflow} />
              <span
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}
              >
                <span className="store-open">Open →</span>
                {EDITABLE_IDS.has(workflow.id) ? (
                  // Edit jumps straight to the workflow editor surface. It lives
                  // inside the card button, so stop the click from also firing
                  // the card's Open handler.
                  <span
                    className="store-open"
                    role="button"
                    tabIndex={0}
                    style={{ opacity: 0.85 }}
                    onClick={(event) => {
                      event.stopPropagation();
                      openSurface({ kind: "workflowEditor", id: workflow.id });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        openSurface({ kind: "workflowEditor", id: workflow.id });
                      }
                    }}
                  >
                    Edit ›
                  </span>
                ) : null}
              </span>
            </button>
          )}
        />

        {includeGatewaySection ? <GatewayWorkflowsSection /> : null}
      </div>
    </div>
  );
}

export function AppsSection() {
  return (
    <section className="store-section">
      <div className="store-section-head">
        <h2 className="store-section-title">Apps</h2>
        <span className="store-section-count">{APPS.length} ready to open</span>
      </div>
      <div className="store-grid">
        {APPS.map((app) => (
          <button
            className="store-card"
            key={app.id}
            style={{ "--card-color": app.color } as CSSProperties}
            type="button"
            onClick={() => openApp(app.id)}
          >
            <span className="store-card-head">
              <span className="store-name">
                {app.icon} {app.name}
              </span>
              <span className="store-tag">App</span>
            </span>
            <span className="store-open">Open →</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** A titled grid of workflow cards. */
function StoreSection({
  title,
  count,
  workflows,
  renderCard,
}: {
  title: string;
  count: string;
  workflows: StoreWorkflow[];
  renderCard: (workflow: StoreWorkflow) => ReactElement;
}) {
  return (
    <section className="store-section">
      <div className="store-section-head">
        <h2 className="store-section-title">{title}</h2>
        <span className="store-section-count">{count}</span>
      </div>
      <div className="store-grid">{workflows.map(renderCard)}</div>
    </section>
  );
}

/** The title, tag, and description shared by every card. */
function StoreCardBody({ workflow }: { workflow: StoreWorkflow }) {
  return (
    <>
      <span className="store-card-head">
        <span className="store-name">{workflow.name}</span>
        <span className="store-tag">{workflow.category}</span>
      </span>
      <span className="store-desc">{workflow.description}</span>
    </>
  );
}
