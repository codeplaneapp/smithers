/** @jsxImportSource react */
// n8n-style workflow graph, ported from multi's workflow graph idiom. ReactFlow
// renders the canvas; dagre computes a left-to-right layout.
import { memo, useMemo } from "react";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import dagre from "dagre";

export type NodeKind = "agent" | "compute" | "approval" | "merge" | "loop" | "branch" | "signal" | "human";

export type FlowNodeData = {
  label: string;
  kind: NodeKind;
  output: string;
  status?: "running" | "done" | "failed" | "pending";
};

export type SmithersFlowNode = Node<FlowNodeData, "smithersTask">;

export type WorkflowSpecNode = {
  id: string;
  label: string;
  kind: NodeKind;
  output: string;
  status?: FlowNodeData["status"];
  dependsOn: string[];
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;

const STATUS_CLASS: Record<NonNullable<FlowNodeData["status"]>, string> = {
  running: "is-running",
  done: "is-done",
  failed: "is-failed",
  pending: "",
};
const STATUS_DOT: Record<NonNullable<FlowNodeData["status"]>, string> = {
  running: "run",
  done: "ok",
  failed: "bad",
  pending: "",
};

function SmithersTaskNode({ data }: NodeProps<SmithersFlowNode>) {
  const statusClass = data.status ? STATUS_CLASS[data.status] : "";
  const dotClass = data.status ? STATUS_DOT[data.status] : "";
  return (
    <div className={`smithers-node smithers-node-${data.kind} ${statusClass}`.trim()}>
      <Handle type="target" position={Position.Left} />
      <div className="node-kicker">
        {data.status ? <span className={`node-dot ${dotClass}`.trim()} /> : null}
        {data.kind}
      </div>
      <div className="node-title">{data.label}</div>
      {data.output ? <div className="node-output">{data.output}</div> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { smithersTask: memo(SmithersTaskNode) };
const FIT_VIEW_OPTIONS = { padding: 0.18 };
const PRO_OPTIONS = { hideAttribution: true };

export function workflowToFlow(spec: WorkflowSpecNode[]): {
  nodes: SmithersFlowNode[];
  edges: Edge[];
} {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", ranksep: 130, nodesep: 90, marginx: 32, marginy: 32 });

  for (const node of spec) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const node of spec) {
    for (const dep of node.dependsOn) {
      if (spec.some((candidate) => candidate.id === dep)) graph.setEdge(dep, node.id);
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
      data: { label: node.label, kind: node.kind, output: node.output, status: node.status },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const edges: Edge[] = spec.flatMap((node) =>
    node.dependsOn
      .filter((dep) => spec.some((candidate) => candidate.id === dep))
      .map((dep) => ({
        id: `${dep}->${node.id}`,
        source: dep,
        target: node.id,
        type: "smoothstep",
      })),
  );
  return { nodes, edges };
}

function WorkflowGraphImpl({ spec }: { spec: WorkflowSpecNode[] }) {
  const { nodes, edges } = useMemo(() => workflowToFlow(spec), [spec]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode="system"
      fitView
      fitViewOptions={FIT_VIEW_OPTIONS}
      minZoom={0.3}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={PRO_OPTIONS}
    >
      <Background gap={26} color="var(--graph-dots)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export const WorkflowGraph = memo(WorkflowGraphImpl);
