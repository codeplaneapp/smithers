/** @jsxImportSource react */
// Delegation tree canvas: extends the cw-graph idiom (ReactFlow + dagre LR)
// with delegation-specific node cards, edge kinds, attention routing, and
// version ghosts. The pure pieces (delegationToFlow, findAttentionTarget) are
// exported for tests; DcNodeCardBody renders without a ReactFlow context so it
// is testable in happy-dom too.
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import dagre from "dagre";
import type { CSSProperties } from "react";
import type { DelegationGraph } from "smithers-orchestrator/gateway-react";
import { EstimateChip, attentionCount, devPreviewOf, gateLabel, gateTitle, type DelegationNode } from "./dc-shared";

const NODE_WIDTH = 240;
const NODE_HEIGHT = 116;

export type DcFlowData = {
  node: DelegationNode;
  selected: boolean;
  onAttention?: (logicalId: string) => void;
};
export type DcFlowNode = Node<DcFlowData, "dcNode">;
type DcEdgeKind = DelegationGraph["edges"][number]["kind"];

// child edges solid; dep/gate edges dashed; probe edges dotted.
const EDGE_STYLE: Record<DcEdgeKind, CSSProperties | undefined> = {
  child: undefined,
  dep: { strokeDasharray: "7 5" },
  gate: { strokeDasharray: "3 6" },
  probe: { strokeDasharray: "2 4" },
};

/**
 * Attention routing: from `fromId`, find the nearest (BFS-shallowest)
 * descendant — following child and probe edges, including the node itself —
 * whose `attention.self` is set (i.e. a human request is pending there).
 */
export function findAttentionTarget(graph: DelegationGraph, fromId: string): string | null {
  const children = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "child" && edge.kind !== "probe") continue;
    const list = children.get(edge.from) ?? [];
    list.push(edge.to);
    children.set(edge.from, list);
  }
  const queue = [fromId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = graph.nodes[id];
    if (node?.attention.self) return id;
    for (const child of children.get(id) ?? []) queue.push(child);
  }
  return null;
}

/** Pure derivation from the folded DelegationGraph to ReactFlow nodes/edges. */
export function delegationToFlow(
  graph: DelegationGraph,
  options: { selectedId?: string | null; onAttention?: (logicalId: string) => void } = {},
): { nodes: DcFlowNode[]; edges: Edge[] } {
  const nodeList = Object.values(graph.nodes);
  const ids = new Set(nodeList.map((node) => node.logicalId));
  const edgeList = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));

  const layout = new dagre.graphlib.Graph();
  layout.setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: "LR", ranksep: 120, nodesep: 70, marginx: 32, marginy: 32 });
  for (const node of nodeList) layout.setNode(node.logicalId, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edgeList) layout.setEdge(edge.from, edge.to);
  dagre.layout(layout);

  // v2 higher-order orchestration: when dcPlan.orchestration === "workflow"
  // lands, a workflow-authored node renders here as a nested COLLAPSED
  // authored subgraph (expand-on-click) instead of a flat card — this map is
  // the subtree-renderer extension point.
  const nodes: DcFlowNode[] = nodeList.map((node) => {
    const positioned = layout.node(node.logicalId);
    return {
      id: node.logicalId,
      type: "dcNode",
      position: {
        x: Math.round((positioned?.x ?? 0) - NODE_WIDTH / 2),
        y: Math.round((positioned?.y ?? 0) - NODE_HEIGHT / 2),
      },
      data: {
        node,
        selected: options.selectedId === node.logicalId,
        onAttention: options.onAttention,
      },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const edges: Edge[] = edgeList.map((edge) => ({
    id: `${edge.kind}:${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
    type: "smoothstep",
    style: EDGE_STYLE[edge.kind],
    animated: edge.kind === "child" && graph.nodes[edge.to]?.status === "running",
  }));
  return { nodes, edges };
}

/**
 * The node card content (no ReactFlow Handles, so it renders standalone):
 * tier chip · kind · version badge · pulsing attention badge · title ·
 * status · estimate chip · gate chips · ghost of the previous version.
 */
export function DcNodeCardBody({
  node,
  selected = false,
  onAttention,
}: {
  node: DelegationNode;
  selected?: boolean;
  onAttention?: (logicalId: string) => void;
}) {
  const attention = attentionCount(node);
  const devPreview = devPreviewOf(node);
  const className = [
    "dc-card",
    `dc-card-${node.kind}`,
    `is-${node.status}`,
    node.status === "invalidated" ? "is-invalidated" : "",
    selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className} data-testid={`dc-node-${node.logicalId}`} data-logical-id={node.logicalId}>
      {node.version > 1 ? (
        // Invalidated prior version ghosts behind the current card instead of
        // disappearing; click the card + version list to inspect it.
        <div className="dc-ghost" data-testid={`dc-ghost-${node.logicalId}`} aria-hidden="true">
          ✕ v{node.version - 1}
        </div>
      ) : null}
      <div className="dc-kicker">
        <span className={`dc-tier dc-tier-${node.tier}`}>{node.tier}</span>
        <span className="dc-kind">{node.kind}</span>
        {node.version > 1 ? (
          <span className="dc-version" data-testid={`dc-version-badge-${node.logicalId}`}>
            v{node.version}
          </span>
        ) : null}
        {attention > 0 ? (
          <button
            type="button"
            className="dc-att"
            data-testid={`dc-att-${node.logicalId}`}
            title="A human is needed here or below — click to jump to it"
            onClick={(event) => {
              event.stopPropagation();
              onAttention?.(node.logicalId);
            }}
          >
            ⚠ {attention}
          </button>
        ) : null}
      </div>
      <div className="dc-title">
        {node.status === "invalidated" ? "✕ " : ""}
        {node.title || node.logicalId}
      </div>
      <div className="dc-meta">
        <span className={`dc-status dc-status-${node.status}`}>{node.status}</span>
        <EstimateChip node={node} />
        {devPreview ? (
          // The developer preview is a REQUIRED backpressure gate: a failed
          // build reads as a failed gate (red), not a cosmetic miss.
          <span
            className={"dc-devpreview-chip" + (devPreview.builtOk ? "" : " is-failed")}
            data-testid={`dc-devpreview-chip-${node.logicalId}`}
            title={devPreview.title || `developer preview (${devPreview.kind})`}
          >
            {devPreview.builtOk ? `▶ ${devPreview.kind}` : "✕ preview failed"}
          </span>
        ) : null}
      </div>
      {node.gates.length > 0 ? (
        <div className="dc-gates">
          {node.gates.map((gate, index) => (
            <span key={index} className={`dc-gate dc-gate-${gate.method}`} title={gateTitle(gate)}>
              {gateLabel(gate)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DcNode({ data }: NodeProps<DcFlowNode>) {
  return (
    <div className="dc-flownode">
      <Handle type="target" position={Position.Left} />
      <DcNodeCardBody node={data.node} selected={data.selected} onAttention={data.onAttention} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { dcNode: memo(DcNode) };
const FIT_VIEW_OPTIONS = { padding: 0.18 };
const PRO_OPTIONS = { hideAttribution: true };

type CanvasProps = {
  graph: DelegationGraph;
  selectedId: string | null;
  onSelect: (logicalId: string | null) => void;
};

function CanvasInner({ graph, selectedId, onSelect }: CanvasProps) {
  const flow = useReactFlow();

  // Attention routing: clicking a ⚠ badge selects + zooms to the nearest
  // descendant that actually needs the human.
  const handleAttention = useCallback(
    (logicalId: string) => {
      const target = findAttentionTarget(graph, logicalId) ?? logicalId;
      onSelect(target);
      void flow.fitView({ nodes: [{ id: target }], duration: 500, padding: 0.4, maxZoom: 1.25 });
    },
    [graph, onSelect, flow],
  );

  const { nodes, edges } = useMemo(
    () => delegationToFlow(graph, { selectedId, onAttention: handleAttention }),
    [graph, selectedId, handleAttention],
  );

  // Nodes stream in while planning fans out — re-fit so the growing tree stays
  // in view (new DOM nodes get the dc-node-in mount animation via CSS).
  const previousCount = useRef(0);
  useEffect(() => {
    if (nodes.length > previousCount.current && previousCount.current > 0) {
      void flow.fitView({ duration: 400, padding: 0.18 });
    }
    previousCount.current = nodes.length;
  }, [nodes.length, flow]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode="system"
      fitView
      fitViewOptions={FIT_VIEW_OPTIONS}
      minZoom={0.25}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={PRO_OPTIONS}
      onNodeClick={(_event, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
    >
      <Background gap={26} color="var(--graph-dots)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function DelegationGraphCanvasImpl(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export const DelegationGraphCanvas = memo(DelegationGraphCanvasImpl);
