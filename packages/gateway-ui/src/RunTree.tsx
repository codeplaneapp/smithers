import type { CSSProperties } from "react";
import { useGatewayRunTree } from "@smithers-orchestrator/gateway-react";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import { NodeRow } from "./NodeRow";
import { theme } from "./theme";

export type RunTreeProps = {
  /** The run to render the node tree for. */
  runId: string | undefined;
  /** Called when a node row is clicked (e.g. to show its output). */
  onSelectNode?: (node: GatewayRunNode) => void;
  /** The currently selected node id, highlighted. */
  activeNodeId?: string;
  className?: string;
  style?: CSSProperties;
};

/**
 * The live node tree for a run. Reads {@link useGatewayRunTree} (initial
 * snapshot + live updates) and renders an indented, status-tagged tree. Pass
 * `onSelectNode` to drive a {@link NodeOutputView}.
 */
export function RunTree({ runId, onSelectNode, activeNodeId, className, style }: RunTreeProps) {
  const { root, isLoading, error } = useGatewayRunTree(runId);

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        background: theme.panel,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radius,
        overflow: "auto",
        ...style,
      }}
    >
      {!runId ? (
        <div style={{ color: theme.textDim, fontSize: 13, padding: 10 }}>Select a run.</div>
      ) : null}
      {error ? <div style={{ color: "#f85149", fontSize: 13, padding: 10 }}>{error.message}</div> : null}
      {runId && isLoading && !root ? (
        <div style={{ color: theme.textDim, fontSize: 13, padding: 10 }}>Loading…</div>
      ) : null}
      {root ? (
        <NodeRow node={root} depth={0} activeNodeId={activeNodeId} onSelectNode={onSelectNode} />
      ) : null}
    </div>
  );
}
