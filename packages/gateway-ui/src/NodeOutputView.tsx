/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { useGatewayNodeOutput } from "@smithers-orchestrator/gateway-react";
import { theme } from "./theme";

export type NodeOutputViewProps = {
  runId: string | undefined;
  nodeId: string | undefined;
  iteration?: number;
  className?: string;
  style?: CSSProperties;
};

function render(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  const record = data as Record<string, unknown>;
  // Common shapes: { output } or { text } carry the human-readable payload.
  if (typeof record.output === "string") return record.output;
  if (typeof record.text === "string") return record.text;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/**
 * The output of a single node, fetched on demand via {@link useGatewayNodeOutput}.
 * Renders the node's `output`/`text` field when present, else pretty JSON. Wire
 * it to {@link RunTree}'s `onSelectNode` to inspect a node.
 */
export function NodeOutputView({ runId, nodeId, iteration, className, style }: NodeOutputViewProps) {
  const { data, loading, error } = useGatewayNodeOutput({ runId, nodeId, iteration });

  return (
    <pre
      className={className}
      style={{
        margin: 0,
        padding: 12,
        overflow: "auto",
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radius,
        fontFamily: theme.fontMono,
        fontSize: 12,
        color: theme.text,
        whiteSpace: "pre-wrap",
        ...style,
      }}
    >
      {!nodeId
        ? "Select a node to see its output."
        : error
          ? error.message
          : loading
            ? "Loading…"
            : render(data) || "No output."}
    </pre>
  );
}
