import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";

/** The Smithers node kinds — each maps to a colored accent in the graph. */
export type WorkflowKind =
  | "agent"
  | "compute"
  | "approval"
  | "merge"
  | "loop"
  | "branch"
  | "signal"
  | "human";

export type WorkflowNodeSpec = {
  id: string;
  label: string;
  kind: WorkflowKind;
  output: string;
  dependsOn: string[];
};

export type WorkflowSpec = {
  name: string;
  description: string;
  nodes: WorkflowNodeSpec[];
};

export type SmithersFlowNode = Node<WorkflowNodeSpec>;

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;

/**
 * Lay a workflow spec out left-to-right with dagre and convert it into the
 * nodes/edges React Flow renders. Only forward `dependsOn` edges feed dagre, so
 * the layout stays a clean linear flow; loop-back edges are added by callers.
 */
export function workflowToFlow(spec: WorkflowSpec): {
  nodes: SmithersFlowNode[];
  edges: Edge[];
} {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    ranksep: 130,
    nodesep: 90,
    marginx: 32,
    marginy: 32,
  });

  for (const node of spec.nodes) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const node of spec.nodes) {
    for (const dependency of node.dependsOn) {
      graph.setEdge(dependency, node.id);
    }
  }

  dagre.layout(graph);

  const nodes: SmithersFlowNode[] = spec.nodes.map((node) => {
    const positioned = graph.node(node.id);
    return {
      id: node.id,
      type: "smithersTask",
      position: {
        x: Math.round(positioned.x - NODE_WIDTH / 2),
        y: Math.round(positioned.y - NODE_HEIGHT / 2),
      },
      data: node,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });

  const edges: Edge[] = spec.nodes.flatMap((node) =>
    node.dependsOn.map((dependency) => ({
      id: `${dependency}->${node.id}`,
      source: dependency,
      target: node.id,
      type: "smoothstep",
    })),
  );

  return { nodes, edges };
}
