/** @jsxImportSource react */
// n8n-style workflow graph: ReactFlow renders the canvas, dagre computes a
// left-to-right layout, and each node is a self-styled SmithersTaskNode card.
// Ported from the Smithers create-workflow UI's `cw-graph` into a generic,
// props-driven gateway-ui component — feed it a WorkflowSpecNode[] and it draws
// the DAG. Styling follows the shared `theme` tokens (so it tracks light/dark),
// and the required react-flow base stylesheet ships inline via `workflowGraphCss`
// because the gateway bundles UI with Bun.build and drops `.css` imports.
import { memo, useMemo, useSyncExternalStore, type CSSProperties } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import dagre from "dagre";
import { resolveTheme, subscribeTheme, theme, type ResolvedTheme } from "./theme";
import { workflowGraphCss } from "./workflowGraphCss";

export type NodeKind =
  | "agent"
  | "compute"
  | "approval"
  | "merge"
  | "loop"
  | "branch"
  | "signal"
  | "human";

export type FlowNodeStatus = "running" | "done" | "failed" | "pending";

export type FlowNodeData = {
  label: string;
  kind: NodeKind;
  output: string;
  status?: FlowNodeStatus;
};

export type SmithersFlowNode = Node<FlowNodeData, "smithersTask">;

/**
 * One node in the workflow DAG. `dependsOn` lists the ids this node waits on;
 * edges are drawn dep → node. `status` and `output` are optional so a caller can
 * render a static shape and layer live run state in later.
 */
export type WorkflowSpecNode = {
  id: string;
  label: string;
  kind: NodeKind;
  output?: string;
  status?: FlowNodeStatus;
  dependsOn?: string[];
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;

// Left-border accent per node kind — the one bit of palette that is intrinsic to
// the card rather than a theme token, mirrored from the create-workflow graph.
const KIND_ACCENT: Record<NodeKind, string> = {
  agent: "#0f8f78",
  approval: "#bf5b16",
  compute: "#356fd2",
  loop: "#6d56d8",
  branch: "#61738a",
  signal: "#61738a",
  merge: "#2670a9",
  human: "#a34d9f",
};

// Status → dot color, derived from the shared theme tokens so it follows the
// active light/dark theme (running = brand, done = green, failed = red).
const STATUS_DOT_COLOR: Record<FlowNodeStatus, string> = {
  running: theme.accent,
  done: theme.success,
  failed: theme.danger,
  pending: theme.textDim,
};

function cardStyle(kind: NodeKind, status: FlowNodeData["status"]): CSSProperties {
  const borderColor =
    status === "done"
      ? `color-mix(in srgb, ${theme.success} 45%, ${theme.border})`
      : status === "failed"
        ? `color-mix(in srgb, ${theme.danger} 55%, ${theme.border})`
        : theme.border;
  const baseShadow = `0 8px 18px color-mix(in srgb, ${theme.text} 8%, transparent)`;
  return {
    display: "grid",
    gap: 6,
    alignContent: "center",
    boxSizing: "border-box",
    width: NODE_WIDTH,
    minHeight: NODE_HEIGHT,
    padding: "14px 16px",
    border: `1px solid ${borderColor}`,
    borderLeft: `5px solid ${KIND_ACCENT[kind]}`,
    borderRadius: 7,
    background: theme.panel,
    fontFamily: theme.fontSans,
    boxShadow:
      status === "running"
        ? `0 0 0 2px color-mix(in srgb, ${theme.accent} 55%, transparent), ${baseShadow}`
        : baseShadow,
  };
}

const KICKER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: theme.textDim,
  fontSize: 11,
  fontWeight: 800,
  textTransform: "uppercase",
};

const TITLE_STYLE: CSSProperties = {
  overflow: "hidden",
  color: theme.text,
  fontSize: 15,
  fontWeight: 800,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const OUTPUT_STYLE: CSSProperties = {
  overflow: "hidden",
  color: theme.textDim,
  fontFamily: theme.fontMono,
  fontSize: 12,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/**
 * The presentational card for one workflow node: a kind kicker (with an optional
 * status dot), the node title, and its latest output line. Rendered by ReactFlow
 * as the `smithersTask` node type, so it is wrapped in target/source handles.
 */
export function SmithersTaskNode({ data }: NodeProps<SmithersFlowNode>) {
  return (
    <div className="smithers-node" data-kind={data.kind} data-status={data.status} style={cardStyle(data.kind, data.status)}>
      <Handle type="target" position={Position.Left} />
      <div className="node-kicker" style={KICKER_STYLE}>
        {data.status ? (
          <span
            aria-hidden
            className="node-dot"
            data-status={data.status}
            style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_DOT_COLOR[data.status] }}
          />
        ) : null}
        {data.kind}
      </div>
      <div className="node-title" style={TITLE_STYLE}>
        {data.label}
      </div>
      {data.output ? (
        <div className="node-output" style={OUTPUT_STYLE}>
          {data.output}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { smithersTask: memo(SmithersTaskNode) };
const FIT_VIEW_OPTIONS = { padding: 0.18 };
const PRO_OPTIONS = { hideAttribution: true };

/**
 * Lay a WorkflowSpecNode[] out left-to-right with dagre and return the ReactFlow
 * `nodes`/`edges`. Pure — no DOM, no ReactFlow context — so it is safe to call
 * (and unit-test) directly. Edges reference only ids present in `spec`, so a
 * dangling `dependsOn` is dropped rather than producing an orphan edge.
 */
export function workflowToFlow(spec: WorkflowSpecNode[]): {
  nodes: SmithersFlowNode[];
  edges: Edge[];
} {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", ranksep: 130, nodesep: 90, marginx: 32, marginy: 32 });

  const ids = new Set(spec.map((node) => node.id));
  for (const node of spec) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const node of spec) {
    for (const dep of node.dependsOn ?? []) {
      if (ids.has(dep)) graph.setEdge(dep, node.id);
    }
  }

  dagre.layout(graph);

  const nodes: SmithersFlowNode[] = spec.map((node) => {
    const positioned = graph.node(node.id);
    return {
      id: node.id,
      type: "smithersTask",
      position: {
        x: Math.round((positioned?.x ?? 0) - NODE_WIDTH / 2),
        y: Math.round((positioned?.y ?? 0) - NODE_HEIGHT / 2),
      },
      data: { label: node.label, kind: node.kind, output: node.output ?? "", status: node.status },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const edges: Edge[] = spec.flatMap((node) =>
    (node.dependsOn ?? [])
      .filter((dep) => ids.has(dep))
      .map((dep) => ({
        id: `${dep}->${node.id}`,
        source: dep,
        target: node.id,
        type: "smoothstep",
      })),
  );
  return { nodes, edges };
}

export type WorkflowGraphProps = {
  /** The workflow DAG to render, one entry per node. */
  spec: WorkflowSpecNode[];
  className?: string;
  style?: CSSProperties;
};

function WorkflowGraphImpl({ spec, className, style }: WorkflowGraphProps) {
  const { nodes, edges } = useMemo(() => workflowToFlow(spec), [spec]);
  const colorMode = useSyncExternalStore<ResolvedTheme>(subscribeTheme, resolveTheme, () => "light");
  return (
    <div
      className={className ?? "smithers-graph"}
      data-theme-mode={colorMode}
      style={{ height: "100%", minHeight: 320, ...style }}
    >
      {/* react-flow's base stylesheet, shipped inline so it survives Bun.build. */}
      <style>{workflowGraphCss}</style>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={colorMode}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.3}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={PRO_OPTIONS}
      >
        <Background gap={26} color={theme.border} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/**
 * An n8n-style workflow DAG canvas. Feed it a {@link WorkflowSpecNode} array and
 * it lays the graph out with dagre ({@link workflowToFlow}) and renders each node
 * as a {@link SmithersTaskNode} card. Read-only (nodes are not draggable or
 * connectable) and generic — it is not wired to any particular workflow's ids.
 *
 * @example
 * <WorkflowGraph spec={[
 *   { id: "plan", label: "Plan", kind: "agent" },
 *   { id: "build", label: "Build", kind: "agent", status: "running", dependsOn: ["plan"] },
 * ]} />
 */
export const WorkflowGraph = memo(WorkflowGraphImpl);
