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
 * model; `nodeTypes` overrides replace it per graph. The `gw-canvas-node`
 * class adds the kind-colored left rail from gatewayUiCss.
 */
export function SmithersCanvasNode({ data, selected, isConnectable }: NodeProps<SmithersFlowNode>) {
  return (
    <WorkflowNode
      title={data.label}
      kind={data.kind}
      status={data.status}
      selected={selected}
      className="gw-canvas-node"
      // The graph canvas is a labelled region, not a listbox: suppress the
      // option role WorkflowNode would otherwise emit for a selectable card,
      // or every node is an orphaned option in the accessibility tree.
      // Selection stays visible via data-selected and the wrapper focus ring.
      role={undefined}
      aria-selected={undefined}
    >
      <SmithersNodeHandles isConnectable={isConnectable} />
      {data.output ? <WorkflowNodeContent>{data.output}</WorkflowNodeContent> : null}
    </WorkflowNode>
  );
}
