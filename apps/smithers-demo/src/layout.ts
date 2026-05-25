import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";
import type { WorkflowNodeSpec, WorkflowSpec } from "./workflowModel";

export type SmithersFlowData = WorkflowNodeSpec & {
  status: "ready" | "running" | "blocked";
};

export type SmithersFlowNode = Node<SmithersFlowData>;

export type LayoutOptions = {
  nodeWidth?: number;
  nodeHeight?: number;
  rankdir?: "TB" | "LR";
  ranksep?: number;
  nodesep?: number;
};

export type Rect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 96;

function makeStatus(node: WorkflowNodeSpec): SmithersFlowData["status"] {
  if (node.kind === "approval") return "blocked";
  if (node.dependsOn.length === 0) return "running";
  return "ready";
}

export function workflowToFlow(spec: WorkflowSpec, options: LayoutOptions = {}) {
  const nodeWidth = options.nodeWidth ?? DEFAULT_NODE_WIDTH;
  const nodeHeight = options.nodeHeight ?? DEFAULT_NODE_HEIGHT;
  const graph = new dagre.graphlib.Graph();

  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: options.rankdir ?? "LR",
    ranksep: options.ranksep ?? 130,
    nodesep: options.nodesep ?? 90,
    marginx: 32,
    marginy: 32,
  });

  for (const node of spec.nodes) {
    graph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
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
        x: Math.round(positioned.x - nodeWidth / 2),
        y: Math.round(positioned.y - nodeHeight / 2),
      },
      data: {
        ...node,
        status: makeStatus(node),
      },
      width: nodeWidth,
      height: nodeHeight,
    };
  });

  const edges: Edge[] = spec.nodes.flatMap((node) =>
    node.dependsOn.map((dependency) => ({
      id: `${dependency}->${node.id}`,
      source: dependency,
      target: node.id,
      animated: node.kind === "approval",
      type: "smoothstep",
    })),
  );

  return { nodes, edges };
}

export function nodeRects(nodes: SmithersFlowNode[], options: LayoutOptions = {}): Rect[] {
  const width = options.nodeWidth ?? DEFAULT_NODE_WIDTH;
  const height = options.nodeHeight ?? DEFAULT_NODE_HEIGHT;
  return nodes.map((node) => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width,
    height,
  }));
}

export function findOverlappingRects(rects: Rect[], padding = 0) {
  const overlaps: Array<[string, string]> = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const separated =
        a.x + a.width + padding <= b.x ||
        b.x + b.width + padding <= a.x ||
        a.y + a.height + padding <= b.y ||
        b.y + b.height + padding <= a.y;
      if (!separated) overlaps.push([a.id, b.id]);
    }
  }
  return overlaps;
}

export function validateLayout(nodes: SmithersFlowNode[], options: LayoutOptions = {}) {
  const overlaps = findOverlappingRects(nodeRects(nodes, options), 12);
  return {
    valid: overlaps.length === 0,
    overlaps,
  };
}
