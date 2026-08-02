import type { ExtractOptions, WorkflowGraph } from "@smthrs/graph";
import type { WorkflowElement } from "./WorkflowElement.ts";

export type WorkflowGraphRenderer = {
  render(element: WorkflowElement, opts?: ExtractOptions): Promise<WorkflowGraph> | WorkflowGraph;
};
