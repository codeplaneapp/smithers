/** @jsxImportSource react */
// n8n-style workflow graph: ReactFlow renders the canvas, dagre computes a
// left-to-right layout, and each node paints the shared canvas anatomy from
// @smithers-orchestrator/ui (WorkflowNode card + StatusPill status vocabulary)
// via SmithersCanvasNode. Ported from the Smithers create-workflow UI's
// `cw-graph` into a generic, props-driven gateway-ui component — feed it a
// WorkflowSpecNode[] and it draws the DAG. The graph composes the shared
// WorkflowCanvas region rather than inventing its own frame, and the required
// react-flow base stylesheet ships inline via `workflowGraphCss` because the
// gateway bundles UI with Bun.build and drops `.css` imports.
import {
  memo,
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  addEdge,
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import dagre from "dagre";
import { EmptyState, WorkflowCanvas } from "@smithers-orchestrator/ui";
import {
  ensureGatewayUiStyles,
  resolveTheme,
  subscribeTheme,
  theme,
  visuallyHidden,
  type ResolvedTheme,
} from "./theme";
import { workflowGraphChromeCss, workflowGraphCss } from "./workflowGraphCss";
import { SmithersCanvasNode, SmithersNodeHandles } from "./SmithersCanvasNode";

export { SmithersCanvasNode, SmithersNodeHandles };

/**
 * @deprecated The default `smithersTask` renderer now composes the shared
 * @smithers-orchestrator/ui canvas anatomy; this alias of
 * {@link SmithersCanvasNode} keeps the old import path working. The legacy
 * inline-styled card (kind kicker + hardcoded status dot) is gone — statuses
 * flow through the shared status vocabulary instead.
 */
export const SmithersTaskNode = SmithersCanvasNode;

export type NodeKind = "agent" | "compute" | "approval" | "merge" | "loop" | "branch" | "signal" | "human";

/**
 * @deprecated The common status subset, kept for compatibility. Node statuses
 * accept any string and resolve through the shared
 * @smithers-orchestrator/ui status vocabulary (`statusClass`/`formatStatus`).
 */
export type FlowNodeStatus = "running" | "done" | "failed" | "pending";

export type FlowNodeData = {
  label: string;
  kind: NodeKind;
  output: string;
  /** Any status string; rendered through the shared status vocabulary. */
  status?: string;
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
  status?: string;
  dependsOn?: string[];
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;

const defaultNodeTypes: NodeTypes = { smithersTask: memo(SmithersCanvasNode) };
const FIT_VIEW_OPTIONS = { padding: 0.18 };
const PRO_OPTIONS = { hideAttribution: true };

/**
 * Lay a WorkflowSpecNode[] out left-to-right with dagre and return the ReactFlow
 * `nodes`/`edges`. Pure — no DOM, no ReactFlow context — so it is safe to call
 * (and unit-test) directly. Edges reference only ids present in `spec`, so a
 * dangling `dependsOn` is dropped rather than producing an orphan edge. Every
 * node carries an `ariaLabel` so keyboard-focused nodes are named for
 * assistive technology (ReactFlow paints it as the wrapper's `aria-label`).
 * `readOnly` is baked onto every node (not just the ReactFlow props) so the
 * contract is honest even before ReactFlow's store updater effects run —
 * including the server-rendered first paint.
 */
export function workflowToFlow(
  spec: WorkflowSpecNode[],
  options?: { readOnly?: boolean },
): {
  nodes: SmithersFlowNode[];
  edges: Edge[];
} {
  const readOnly = options?.readOnly ?? true;
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
      ariaLabel: `${node.label} (${node.kind} node)`,
      draggable: !readOnly,
      connectable: !readOnly,
      deletable: !readOnly,
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
  /**
   * Read-only canvas (the default): nodes cannot be dragged, connected, or
   * deleted — ReactFlow's mutation affordances are all off. Pass `false` to
   * opt an editable graph into drag/connect mutations. Nodes stay
   * keyboard-focusable and selectable either way.
   */
  readOnly?: boolean;
  /**
   * Called after an editable (`readOnly={false}`) connect gesture adds an
   * edge to the graph. The edge is already in the rendered state when this
   * fires; use it to persist the mutation back to the caller's model.
   */
  onConnect?: (connection: Connection) => void;
  /**
   * Extra/override ReactFlow node renderers, merged over the default as
   * `{ smithersTask: memo(SmithersCanvasNode), ...nodeTypes }`. Passing the
   * required `smithersTask` key (the type every {@link workflowToFlow} node
   * emits) replaces the default card. Any custom renderer MUST render
   * {@link SmithersNodeHandles} inside its node root or its edges detach.
   */
  nodeTypes?: NodeTypes;
};

function WorkflowGraphImpl({
  spec,
  className,
  style,
  readOnly = true,
  onConnect,
  nodeTypes: nodeTypesProp,
}: WorkflowGraphProps) {
  const initial = useMemo(() => workflowToFlow(spec, { readOnly }), [spec, readOnly]);
  // Controlled state: selection, drag, delete and connect gestures emit
  // change events that must be applied back or the graph silently ignores
  // them. `useNodesState`/`useEdgesState` apply them truthfully; a spec or
  // readOnly change re-syncs the laid-out model.
  const [nodes, setNodes, onNodesChange] = useNodesState<SmithersFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  useEffect(() => {
    setNodes(initial.nodes);
    setEdges(initial.edges);
  }, [initial, setNodes, setEdges]);
  const handleConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      setEdges((current) => addEdge(connection, current));
      onConnect?.(connection);
    },
    [readOnly, setEdges, onConnect],
  );
  const nodeTypes = useMemo<NodeTypes>(
    () => (nodeTypesProp ? { ...defaultNodeTypes, ...nodeTypesProp } : defaultNodeTypes),
    [nodeTypesProp],
  );
  const colorMode = useSyncExternalStore<ResolvedTheme>(subscribeTheme, resolveTheme, () => "light");
  useInsertionEffect(ensureGatewayUiStyles, []);
  return (
    <WorkflowCanvas
      className={className ?? "smithers-graph"}
      data-theme-mode={colorMode}
      role="region"
      aria-label="Workflow graph"
      style={{ position: "relative", height: "100%", minHeight: 320, ...style }}
    >
      {/* react-flow's base stylesheet plus Smithers chrome, shipped inline so it survives Bun.build. */}
      <style>{workflowGraphCss + workflowGraphChromeCss}</style>
      <p style={visuallyHidden}>
        Workflow graph. Tab moves keyboard focus between nodes; use the canvas controls to zoom.
      </p>
      {spec.length === 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <EmptyState description="This workflow has no nodes yet." />
        </div>
      ) : null}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        nodeTypes={nodeTypes}
        colorMode={colorMode}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.3}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : "Backspace"}
        nodesFocusable
        proOptions={PRO_OPTIONS}
      >
        <Background gap={26} color={theme.border} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </WorkflowCanvas>
  );
}

/**
 * An n8n-style workflow DAG canvas. Feed it a {@link WorkflowSpecNode} array and
 * it lays the graph out with dagre ({@link workflowToFlow}) and renders each node
 * as a {@link SmithersCanvasNode} card — the shared
 * @smithers-orchestrator/ui canvas anatomy, inside the shared `WorkflowCanvas`
 * region, with statuses piped through the shared status vocabulary. Read-only
 * by default (nodes are not draggable, connectable, or deletable, but remain
 * keyboard-focusable with visible focus and accessible names) and generic —
 * it is not wired to any particular workflow's ids.
 *
 * @example
 * <WorkflowGraph spec={[
 *   { id: "plan", label: "Plan", kind: "agent" },
 *   { id: "build", label: "Build", kind: "agent", status: "running", dependsOn: ["plan"] },
 * ]} />
 */
export const WorkflowGraph = memo(WorkflowGraphImpl);
