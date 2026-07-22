/** @jsxImportSource react */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { WorkflowNode, WorkflowNodeContent } from "@smithers-orchestrator/ui";
import type { SmithersFlowNode } from "./WorkflowGraph";

/**
 * The exact handle pair every `smithersTask` node renderer must render:
 * a target handle on the left and a source handle on the right (no ids).
 * Custom renderers passed via `WorkflowGraphProps.nodeTypes` MUST render
 * `<SmithersNodeHandles />` inside the node root or their edges detach.
 * `isConnectable` is wired straight from the node props ReactFlow hands the
 * renderer so a read-only graph's handles are honestly inert — `<Handle>`
 * defaults to connectable and never reads the node's own flags.
 */
export function SmithersNodeHandles({ isConnectable = true }: { isConnectable?: boolean }) {
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={isConnectable}
        isConnectableStart={isConnectable}
        isConnectableEnd={isConnectable}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
        isConnectableStart={isConnectable}
        isConnectableEnd={isConnectable}
      />
    </>
  );
}

/**
 * The default `smithersTask` renderer: the renderer-neutral canvas anatomy
 * from @smithers-orchestrator/ui (WorkflowNode card, kind badge, shared
 * StatusPill status vocabulary, content line) composed inside
 * {@link SmithersNodeHandles} so edges stay attached. This is the visual
 * language WorkflowGraph paints by default — there is no competing graph
 * model; `nodeTypes` overrides replace it per graph.
 */
export function SmithersCanvasNode({ data, selected, isConnectable }: NodeProps<SmithersFlowNode>) {
  return (
    <WorkflowNode title={data.label} kind={data.kind} status={data.status} selected={selected}>
      <SmithersNodeHandles isConnectable={isConnectable} />
      {data.output ? <WorkflowNodeContent>{data.output}</WorkflowNodeContent> : null}
    </WorkflowNode>
  );
}
