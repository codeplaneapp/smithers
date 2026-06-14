import { useMemo } from "react";
import { useGatewayNodeOutput } from "@smithers-orchestrator/gateway-react";
import { StatusPill } from "../cards/StatusPill";
import type { RunNode } from "../runs/Run";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function GatewayNodeDetail({
  loadOutput,
  runId,
  node,
}: {
  loadOutput: boolean;
  runId: string;
  node: RunNode;
}) {
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
          <p className="gw-node-muted">Select this node to load its output.</p>
        ) : outputState.loading ? (
          <p className="gw-node-muted">Loading output…</p>
        ) : outputState.error ? (
          <p className="gw-node-muted">Output unavailable.</p>
        ) : output === null || output === undefined ? (
          <p className="gw-node-muted">No output for this node.</p>
        ) : (
          <pre className="gw-node-output" data-testid="gateway-node-output">
            {JSON.stringify(output, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
