import { useMemo } from "react";
import { useGatewayNodeOutput } from "@smthrs/gateway-react";
import { Button, EmptyState, Skeleton } from "@smthrs/ui";
import { StatusPill } from "../cards/StatusPill";
import type { RunNode } from "../runs/Run";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatAttemptError(value: unknown): string {
  const error = asRecord(value);
  const details = [
    typeof error.name === "string" ? `Name: ${error.name}` : null,
    typeof error.code === "string" ? `Code: ${error.code}` : null,
    typeof error.message === "string" ? `Message: ${error.message}` : null,
    typeof error.attempt === "number" && Number.isFinite(error.attempt) ? `Attempt: ${error.attempt}` : null,
  ].filter((detail): detail is string => detail !== null);
  return details.length > 0 ? details.join("\n") : formatValue(value);
}

export function GatewayNodeDetail({ loadOutput, runId, node }: { loadOutput: boolean; runId: string; node: RunNode }) {
  const outputState = useGatewayNodeOutput({
    runId: loadOutput ? runId : undefined,
    nodeId: loadOutput ? node.id : undefined,
    iteration: 0,
  });
  const response = useMemo(() => {
    if (outputState.data === undefined) {
      return { output: undefined, partial: undefined, attemptError: undefined };
    }
    const record = asRecord(outputState.data);
    return {
      output: "row" in record ? record.row : outputState.data,
      partial: "row" in record ? record.partial : undefined,
      attemptError: "row" in record ? record.error : undefined,
    };
  }, [outputState.data]);
  const { output, partial, attemptError } = response;
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
        ) : outputState.error ? (
          <EmptyState
            className="gw-node-muted"
            title="Output unavailable."
            description="The output could not be loaded."
            action={
              <Button type="button" size="sm" variant="outline" onClick={() => void outputState.refetch()}>
                Retry output
              </Button>
            }
            role="alert"
          />
        ) : outputState.loading || outputState.data === undefined ? (
          <div role="status">
            <Skeleton style={{ height: 56 }} />
            <span className="sui-sr-only">Loading output…</span>
          </div>
        ) : output === null || output === undefined ? (
          <EmptyState className="gw-node-muted" title="No output for this node." />
        ) : (
          <pre className="gw-node-output" data-testid="gateway-node-output">
            {JSON.stringify(output, null, 2)}
          </pre>
        )}
      </div>
      {partial !== null && partial !== undefined ? (
        <div className="gw-node-section">
          <span className="gw-node-label">Partial output</span>
          <pre className="gw-node-output" data-testid="gateway-node-partial">
            {formatValue(partial)}
          </pre>
        </div>
      ) : null}
      {attemptError !== null && attemptError !== undefined ? (
        <div className="gw-node-section">
          <span className="gw-node-label">Failure</span>
          <pre className="gw-node-output" data-testid="gateway-node-error">
            {formatAttemptError(attemptError)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
