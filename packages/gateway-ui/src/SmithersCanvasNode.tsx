/** @jsxImportSource react */
import type { NodeProps } from "@xyflow/react";
// House rules reserve packages/ui/src/index.ts for the integration lane, so
// the canvas anatomy is not on the @smithers-orchestrator/ui barrel yet. This
// deep source import is the interim path; integration swaps it for the barrel
// when it lands the lane's export block (integrationContract E).
import { WorkflowNode, WorkflowNodeContent } from "../../ui/src/canvas/WorkflowCanvas";
import { SmithersNodeHandles, type SmithersFlowNode } from "./WorkflowGraph";

export { SmithersNodeHandles };

/**
 * The shipped custom `smithersTask` renderer: the renderer-neutral canvas
 * anatomy from @smithers-orchestrator/ui (WorkflowNode card, kind badge,
 * StatusPill, content line) composed inside {@link SmithersNodeHandles} so
 * edges stay attached. This is the visual language WorkflowGraph adopts —
 * there is no competing graph model; opt in per graph with
 * `<WorkflowGraph nodeTypes={{ smithersTask: SmithersCanvasNode }} />`.
 */
export function SmithersCanvasNode({ data, selected }: NodeProps<SmithersFlowNode>) {
  return (
    <WorkflowNode title={data.label} kind={data.kind} status={data.status} selected={selected}>
      <SmithersNodeHandles />
      {data.output ? <WorkflowNodeContent>{data.output}</WorkflowNodeContent> : null}
    </WorkflowNode>
  );
}
