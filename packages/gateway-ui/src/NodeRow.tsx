/** @jsxImportSource react */
import { runNodeKey } from "@smithers-orchestrator/gateway-client";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import type { CSSProperties } from "react";
import { StatusPill } from "./StatusPill";

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
        className="gw-node-row"
        data-active={active}
        data-interactive={Boolean(onSelectNode)}
        style={{ "--gw-node-depth": depth } as CSSProperties}
      >
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {node.cardLabel ?? node.name}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted, #52525b)" }}>{node.kind}</span>
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
