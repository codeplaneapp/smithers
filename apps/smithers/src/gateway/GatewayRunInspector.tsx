import { useEffect, useMemo } from "react";
import {
  useGatewayApprovals,
  useGatewayMutation,
  useGatewayWorkflows,
} from "@smithers-orchestrator/gateway-react";
import { gatewayKeys } from "@smithers-orchestrator/gateway-client";
import { StatusPill } from "../cards/StatusPill";
import { findNode } from "../runs/Run";
import { RunTree } from "../runs/RunTree";
import { useGatewayRunTree } from "../sync/useGatewayRunTree";
import { GatewayNodeDetail } from "./GatewayNodeDetail";
import { WorkflowRunUi } from "./WorkflowRunUi";
import {
  useGatewayInspectorStore,
  type GatewayRunView,
} from "./gatewayInspectorStore";
import "./gateway.css";

type SubmitApprovalVars = {
  runId: string;
  nodeId: string;
  iteration: number;
  decision: {
    approved: boolean;
    note: string;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function GatewayRunInspector({
  workflowKey,
  runId,
}: {
  workflowKey: string;
  runId: string;
}) {
  const workflows = useGatewayWorkflows({ filter: { hasUi: true } });
  const runTree = useGatewayRunTree(runId);
  const approvals = useGatewayApprovals({ filter: { runId, limit: 20 } });
  const submitApproval = useGatewayMutation<SubmitApprovalVars, unknown>(
    "submitApproval",
    {
      invalidate: [
        gatewayKeys.approvals({ filter: { runId, limit: 20 } }),
        gatewayKeys.runs({}),
        gatewayKeys.run(runId),
      ],
    },
  );
  const storedView = useGatewayInspectorStore((state) => state.viewByRun[runId]);
  const selectedNodeId = useGatewayInspectorStore(
    (state) => state.selectedNodeByRun[runId],
  );
  const setView = useGatewayInspectorStore((state) => state.setView);
  const selectNode = useGatewayInspectorStore((state) => state.selectNode);
  const workflow = useMemo(
    () =>
      (workflows.data ?? [])
        .map(asRecord)
        .find((item) => asString(item.key) === workflowKey),
    [workflowKey, workflows.data],
  );
  const uiPath = workflow && workflow.hasUi === true ? asString(workflow.uiPath) : "";
  const title = asString(workflow?.readableName) || workflowKey;
  const approval = (approvals.data ?? [])
    .find((item) => item.runId === runId && item.nodeId);

  useEffect(() => {
    if (runTree.status === "waiting") {
      void approvals.refetch();
    }
  }, [approvals.refetch, runTree.status]);

  const effectiveView: GatewayRunView = storedView ?? (uiPath ? "flow" : "inspector");
  const tree = runTree.root;
  const activeNodeId = selectedNodeId ?? tree?.id;
  const selected =
    tree && activeNodeId ? findNode(tree, activeNodeId) ?? tree : null;

  const onSelect = (nodeId: string) => {
    selectNode(runId, nodeId);
  };

  const approve = () => {
    if (!approval) return;
    void submitApproval.mutateSafe({
      runId,
      nodeId: approval.nodeId,
      iteration: approval.iteration,
      decision: {
        approved: true,
        note: "Approved from Smithers real e2e UI",
      },
    }).then(() => approvals.refetch());
  };

  return (
    <section className="surface" data-testid="gateway-run-inspector">
      <header className="surface-head">
        <span className="surface-title">{title}</span>
        <StatusPill status={runTree.status} />
        <div className="seg">
          {uiPath ? (
            <button
              type="button"
              className={effectiveView === "flow" ? "is-on" : ""}
              data-testid="gateway-view-flow"
              onClick={() => setView(runId, "flow")}
            >
              Workflow UI
            </button>
          ) : null}
          <button
            type="button"
            className={effectiveView === "inspector" ? "is-on" : ""}
            data-testid="gateway-view-inspector"
            onClick={() => setView(runId, "inspector")}
          >
            Inspector
          </button>
        </div>
      </header>

      {approval ? (
        <div className="gw-approval-banner" data-testid="gateway-approval-banner">
          <div className="gw-approval-copy">
            <span className="gw-approval-title">{approval.requestTitle || "Approval required"}</span>
            {approval.requestSummary ? (
              <span className="gw-approval-summary">{approval.requestSummary}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="gw-btn gw-btn-primary"
            data-testid="gateway-approve-button"
            disabled={submitApproval.isLoading}
            onClick={approve}
          >
            {submitApproval.isLoading ? "Approving" : "Approve"}
          </button>
        </div>
      ) : null}

      {effectiveView === "flow" && uiPath ? (
        <WorkflowRunUi uiPath={uiPath} runId={runId} />
      ) : runTree.isLoading ? (
        <div className="surface-empty">Loading run…</div>
      ) : !tree ? (
        <div className="surface-empty">No execution tree yet.</div>
      ) : (
        <div className="inspector-body">
          <div className="tree-pane">
            <RunTree
              root={tree}
              selectedId={activeNodeId ?? ""}
              onSelect={onSelect}
            />
          </div>
          {selected ? (
            <GatewayNodeDetail
              loadOutput={selectedNodeId !== undefined}
              runId={runId}
              node={selected}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
