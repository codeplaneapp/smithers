import "@xyflow/react/dist/style.css";
import { memo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import type { SmithersFlowNode } from "./workflowFlow";

function SmithersTaskNode({ data }: NodeProps<SmithersFlowNode>) {
  return (
    <div className={`smithers-node smithers-node-${data.kind}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-kicker">{data.kind}</div>
      <div className="node-title">{data.label}</div>
      <div className="node-output">{data.output}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { smithersTask: SmithersTaskNode };

// Hoisted so ReactFlow receives the same object reference on every render and
// doesn't treat each parent re-render as a prop change.
const FIT_VIEW_OPTIONS = { padding: 0.18 };
const PRO_OPTIONS = { hideAttribution: true };

/** A static, read-only n8n-style render of a Smithers workflow. */
function WorkflowGraphImpl({
  nodes,
  edges,
  theme = "light",
}: {
  nodes: SmithersFlowNode[];
  edges: Edge[];
  theme?: "light" | "dark";
}) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={theme}
      fitView
      fitViewOptions={FIT_VIEW_OPTIONS}
      minZoom={0.35}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={PRO_OPTIONS}
    >
      <Background gap={26} color={theme === "dark" ? "#2a2a2e" : "#e2e7ef"} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export const WorkflowGraph = memo(WorkflowGraphImpl);
