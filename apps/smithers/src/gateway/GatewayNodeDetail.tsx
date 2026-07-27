import { useMemo } from "react";
import { useGatewayNodeOutput } from "@smithers-orchestrator/gateway-react";
import { EmptyState, Skeleton } from "@smithers-orchestrator/ui";
import { StatusPill } from "../cards/StatusPill";
import type { RunNode } from "../runs/Run";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function GatewayNodeDetail({ loadOutput, runId, node }: { loadOutput: boolean; runId: string; node: RunNode }) {
  const outputState = useGatewayNodeOutput({
    runId: loadOutput ? runId : undefined,
    nodeId: loadOutput ? node.id : undefined,
    iteration: 0,
  });
  const output = useMemo(() => {
    if (!outputState.data) return undefined;
    const record = asRecord(outputState.data);
    return "row" in record ? record.row : outputState.data;
  }, [outputState.data]);
  const requested = loadOutput || outputState.loading || outputState.error !== undefined;

  return (
    <div className="gw-node-detail" data-testid="gateway-node-detail">
      <div className="gw-node-head">
        <span className="gw-node-name">{node.name}</span>
        <StatusPill status={node.status} />
      </div>
      <div className="gw-node-section">
        <span className="gw-node-label">Output</span>
        {!requested ? (
          <EmptyState className="gw-node-muted" description="Select this node to load its output." />
        ) : outputState.loading && output === undefined ? (
          <div role="status">
            <Skeleton style={{ height: 56 }} />
            <span className="sui-sr-only">Loading output…</span>
          </div>
        ) : outputState.error && output === undefined ? (
          <EmptyState className="gw-node-muted" title="Output unavailable." role="alert" />
        ) : output === null || output === undefined ? (
          <EmptyState className="gw-node-muted" title="No output for this node." />
        ) : (
          <pre className="gw-node-output" data-testid="gateway-node-output">
            {JSON.stringify(output, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
