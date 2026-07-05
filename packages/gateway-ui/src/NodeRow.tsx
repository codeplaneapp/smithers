/** @jsxImportSource react */
import { runNodeKey } from "@smithers-orchestrator/gateway-client";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import { StatusPill } from "./StatusPill";
import { theme } from "./theme";

export type NodeRowProps = {
  node: GatewayRunNode;
  depth: number;
  activeNodeId?: string;
  onSelectNode?: (node: GatewayRunNode) => void;
};

/**
 * One indented, status-tagged row in a {@link RunTree}, recursing over
 * `node.children`. Child React keys come from {@link runNodeKey} (unique per
 * structural position), NOT the logical `id`: loop/retry attempts share an `id`
 * and differ only by `iteration`, so keying on `id` collapses them into one row.
 */
export function NodeRow({ node, depth, activeNodeId, onSelectNode }: NodeRowProps) {
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
          background: active ? `color-mix(in srgb, ${theme.accent} 10%, transparent)` : "transparent",
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
