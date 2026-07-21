/** @jsxImportSource react */
import type { NodeProps } from "@xyflow/react";
import { WorkflowNode, WorkflowNodeContent } from "@smithers-orchestrator/ui";
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
