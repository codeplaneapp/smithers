import { useEffect, useState } from "react";
import { useGatewayApprovals, useGatewayRuns } from "smthrs/gateway-react";
import {
  ApprovalPanel,
  ConnectionBadge,
  RunEventLog,
  RunTree,
  StatusPill,
  WorkflowUiShell,
} from "smthrs/gateway-ui";
import { Card, CardContent, CardHeader, CardTitle } from "smthrs/ui";

/**
 * Live view of every run in the container workspace.
 *
 * All state comes from the gateway. Nothing here simulates progress: a run
 * shows the status the engine recorded, and the approval buttons post a real
 * decision through the gateway RPC.
 */
export function App() {
  const { data: runs, error } = useGatewayRuns();
  const { data: approvals } = useGatewayApprovals();
  const [activeRunId, setActiveRunId] = useState(undefined);
  const list = runs ?? [];

  // Follow the newest run until the viewer picks one.
  useEffect(() => {
    if (!activeRunId && list.length > 0) {
      setActiveRunId(list[0].id ?? list[0].runId);
    }
  }, [activeRunId, list]);

  useEffect(() => {
    window.parent.postMessage({ type: "smithers-approval-count", count: approvals?.length ?? 0 }, "*");
  }, [approvals]);

  return (
    <WorkflowUiShell
      title="Smithers in a WebContainer"
      meta={<ConnectionBadge />}
      testId="stereos-demo-app"
    >
      {error ? <p data-testid="gateway-error">Gateway error: {String(error)}</p> : null}

      <Card data-testid="runs">
        <CardHeader><CardTitle>Runs ({list.length})</CardTitle></CardHeader>
        <CardContent>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {list.map((run) => {
            const id = run.id ?? run.runId;
            return (
              <li key={id} data-testid="run-row" data-workflow={run.workflow} data-status={run.status}>
                <button
                  type="button"
                  onClick={() => setActiveRunId(id)}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    width: "100%",
                    background: id === activeRunId ? "rgba(127,127,127,0.15)" : "transparent",
                    border: 0,
                    padding: "6px 8px",
                    cursor: "pointer",
                    font: "inherit",
                    color: "inherit",
                    textAlign: "left",
                  }}
                >
                  <StatusPill status={run.status} />
                  <span>{run.workflow ?? id}</span>
                </button>
              </li>
            );
          })}
        </ul>
        </CardContent>
      </Card>

      <Card data-testid="approvals">
        <CardHeader><CardTitle>Approvals</CardTitle></CardHeader>
        <CardContent>
        <ApprovalPanel empty={<p data-testid="no-approvals">No gate is waiting.</p>} />
        </CardContent>
      </Card>

      <Card data-testid="run-tree">
        <CardHeader><CardTitle>Nodes</CardTitle></CardHeader>
        <CardContent>
        <RunTree runId={activeRunId} />
        </CardContent>
      </Card>

      <Card data-testid="run-events">
        <CardHeader><CardTitle>Events</CardTitle></CardHeader>
        <CardContent>
        <RunEventLog runId={activeRunId} maxEvents={200} />
        </CardContent>
      </Card>
    </WorkflowUiShell>
  );
}
