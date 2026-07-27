import type { FlowKind, Run } from "./Run.ts";

/**
 * One node spec in the pure graph projection `runToFlowSpec` derives from a
 * run. Mirrors multi's `askme/flowGraph.ts` `FlowNodeSpec` shape structurally
 * (identical field names/types, including `kind: FlowKind`) without importing
 * it: that module pulls in `dagre` + `@xyflow/react` for the LAYOUT step,
 * which ui-core must not depend on (see `Run.ts`'s `FlowKind` comment).
 */
export type FlowNodeSpec = {
  id: string;
  label: string;
  kind: FlowKind;
  output: string;
  dependsOn: string[];
};

export type FlowSpec = {
  name: string;
  description: string;
  nodes: FlowNodeSpec[];
};

/**
 * Adapt a live run into the flow-graph projection a layout engine turns into
 * positioned nodes/edges. Ported from multi's `src/runs/runToFlow.ts`, split
 * at the layout boundary: this half (Run -> FlowSpec) is pure and
 * platform-neutral, so it lives in ui-core; the half that lays the spec out
 * (multi's `flowSpecToGraph`: dagre + `@xyflow/react` types) stays in multi's
 * `askme/flowGraph.ts`, each platform free to lay a `FlowSpec` out however it
 * renders a graph (dagre+xyflow for multi's DOM canvas, a terminal grid for
 * packages/tui's opentui GraphMode).
 */
export function runToFlowSpec(run: Run): FlowSpec {
  const steps = run.root.children ?? [];
  return {
    name: run.title,
    description: "",
    nodes: steps.map((step, index) => ({
      id: step.id,
      label: step.name,
      kind: step.kind,
      output: step.meta ?? step.status,
      dependsOn: index === 0 ? [] : [steps[index - 1]!.id],
    })),
  };
}
