import type { Edge } from "@xyflow/react";
import {
  workflowToFlow,
  type SmithersFlowNode,
  type WorkflowSpec,
} from "../askme/workflowFlow";
import type { Run } from "./Run";

/**
 * Adapt a live run into the same flow shape the WorkflowGraph already renders,
 * so the inspector's Graph tab reuses the existing node component and dagre
 * layout. Node output shows the live status.
 */
export function runToFlow(run: Run): {
  nodes: SmithersFlowNode[];
  edges: Edge[];
} {
  const steps = run.root.children ?? [];
  const spec: WorkflowSpec = {
    name: run.title,
    description: "",
    nodes: steps.map((step, index) => ({
      id: step.id,
      label: step.name,
      kind: step.kind,
      output: step.meta ?? step.status,
      dependsOn: index === 0 ? [] : [steps[index - 1].id],
    })),
  };
  return workflowToFlow(spec);
}
