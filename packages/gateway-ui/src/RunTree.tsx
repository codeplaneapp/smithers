import type { CSSProperties } from "react";
import { useGatewayRunTree } from "@smithers-orchestrator/gateway-react";
import { type GatewayRunNode, runNodeKey } from "@smithers-orchestrator/gateway-client";
import { StatusPill } from "./StatusPill";
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

function NodeRow({
  node,
  depth,
  activeNodeId,
  onSelectNode,
}: {
  node: GatewayRunNode;
  depth: number;
  activeNodeId?: string;
  onSelectNode?: (node: GatewayRunNode) => void;
  key?: string;
}) {
  const active = node.id === activeNodeId;
  return (
    <>
      <button
        type="button"
        onClick={() => onSelectNode?.(node)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          width: "100%",
          padding: "6px 8px",
          paddingLeft: 8 + depth * 16,
          border: "none",
          borderLeft: `2px solid ${active ? theme.accent : "transparent"}`,
          background: active ? `${theme.accent}1a` : "transparent",
          color: theme.text,
          cursor: onSelectNode ? "pointer" : "default",
          textAlign: "left",
          fontFamily: theme.fontSans,
          fontSize: 13,
        }}
      >
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {node.cardLabel ?? node.name}
          </span>
          <span style={{ fontSize: 11, color: theme.textDim }}>{node.kind}</span>
        </span>
        <StatusPill status={node.status} />
      </button>
      {(node.children ?? []).map((child) => (
        <NodeRow
          key={runNodeKey(child)}
          node={child}
          depth={depth + 1}
          activeNodeId={activeNodeId}
          onSelectNode={onSelectNode}
        />
      ))}
    </>
  );
}

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
