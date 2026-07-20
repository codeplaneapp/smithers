/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { useGatewayNodeOutput } from "@smithers-orchestrator/gateway-react";
import { AgentOutput, parseAgentOutput } from "@smithers-orchestrator/ui";
import { theme } from "./theme";

export type NodeOutputViewProps = {
  runId: string | undefined;
  nodeId: string | undefined;
  iteration?: number;
  className?: string;
  style?: CSSProperties;
};

/**
 * The lifecycle bucket a node-output envelope resolves to: `pending` (not run
 * yet), `failed` (errored before producing), or `produced` (has a row — the
 * bucket a bare row or string also falls into).
 */
export type NodeOutputStatus = "pending" | "failed" | "produced";

export type UnwrappedNodeOutput = {
  status: NodeOutputStatus;
  /** The output row once the `{ status, row }` envelope is peeled off (`null` when absent). */
  row: unknown;
};

/**
 * Peel the gateway `getNodeOutput` envelope down to a `{ status, row }` pair.
 * The gateway returns `{ status: "pending" | "failed" | "produced", row }`, but
 * older/direct callers may hand back a bare row (object or string); those are
 * treated as already `produced`. This is the ONE place gateway-ui unwraps the
 * envelope — {@link formatOutput} and {@link NodeOutputCard} both build on it so
 * the convention lives in a single spot.
 */
export function unwrapNodeOutput(data: unknown): UnwrappedNodeOutput {
  if (data != null && typeof data === "object") {
    const envelope = data as Record<string, unknown>;
    if (envelope.status === "pending") return { status: "pending", row: null };
    if (envelope.status === "failed") return { status: "failed", row: null };
    if (envelope.status === "produced") return { status: "produced", row: envelope.row ?? null };
  }
  return { status: "produced", row: data ?? null };
}

export function formatOutput(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  const { status, row: payload } = unwrapNodeOutput(data);
  if (status === "pending") return "Output is not available yet.";
  if (status === "failed") return "This node failed before producing output.";
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  const record = payload as Record<string, unknown>;
  // Common shapes: { output } or { text } carry the human-readable payload.
  if (typeof record.output === "string") return record.output;
  if (typeof record.text === "string") return record.text;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/**
 * The output of a single node, fetched on demand via {@link useGatewayNodeOutput}.
 * Renders recognizable agent rows through the shared agentic composition and
 * keeps pretty JSON for arbitrary output. Wire it to {@link RunTree}'s
 * `onSelectNode` to inspect a node.
 */
export function NodeOutputView({ runId, nodeId, iteration, className, style }: NodeOutputViewProps) {
  const { data, loading, error } = useGatewayNodeOutput({ runId, nodeId, iteration });
  const { status, row } = unwrapNodeOutput(data);
  const waiting = loading && data == null;
  const agentOutput = nodeId && !error && !waiting && status === "produced"
    ? parseAgentOutput(row)
    : null;
  const fallback = !nodeId
    ? "Select a node to see its output."
    : error
      ? error.message
      : waiting
        ? "Loading…"
        : formatOutput(data) || "No output.";

  return (
    <div
      className={className}
      style={{
        margin: 0,
        padding: 12,
        overflow: "auto",
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radius,
        fontFamily: theme.fontSans,
        fontSize: 12,
        color: theme.text,
        ...style,
      }}
    >
      {agentOutput ? (
        <AgentOutput model={agentOutput} />
      ) : (
        <pre
          data-slot="node-output-fallback"
          style={{
            margin: 0,
            fontFamily: theme.fontMono,
            whiteSpace: "pre-wrap",
          }}
        >
          {fallback}
        </pre>
      )}
    </div>
  );
}
