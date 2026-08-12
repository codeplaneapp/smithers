/** @jsxImportSource react */
import { runNodeKey } from "@smthrs/gateway-client";
import type { GatewayRunNode } from "@smthrs/gateway-client";
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
  const executionMeta = [
    node.kind,
    typeof node.iteration === "number" ? `iteration ${node.iteration}` : undefined,
    typeof node.attempt === "number" && node.attempt > 0
      ? `attempt ${node.attempt}${typeof node.maxAttempts === "number" ? ` of ${node.maxAttempts}` : ""}`
      : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  return (
    <>
      <button
        type="button"
        onClick={() => onSelectNode?.(node)}
        className="gw-node-row"
        role="treeitem"
        aria-level={depth + 1}
        data-active={active}
        data-interactive={Boolean(onSelectNode)}
        style={{ "--gw-node-depth": depth } as CSSProperties}
      >
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {node.cardLabel ?? node.name}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted, #676676)" }}>{executionMeta}</span>
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
