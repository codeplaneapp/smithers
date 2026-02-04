import React from "react";
import type {
  WorkflowProps,
  TaskProps,
  SequenceProps,
  ParallelProps,
  BranchProps,
  RalphProps,
} from "./types";
export function Workflow(props: WorkflowProps) {
  return React.createElement("smithers:workflow", props, props.children);
}

export function Task<Row>(props: TaskProps<Row>) {
  const { children, agent, ...rest } = props as any;
  if (agent) {
    return React.createElement(
      "smithers:task",
      { ...rest, agent, __smithersKind: "agent" },
      String(children ?? ""),
    );
  }
  const nextProps = { ...rest, __smithersKind: "static", __smithersPayload: children, __payload: children } as any;
  return React.createElement("smithers:task", nextProps, null);
}

export function Sequence(props: SequenceProps) {
  if (props.skipIf) return null;
  return React.createElement("smithers:sequence", props, props.children);
}

export function Parallel(props: ParallelProps) {
  if (props.skipIf) return null;
  return React.createElement("smithers:parallel", props, props.children);
}

export function Branch(props: BranchProps) {
  if (props.skipIf) return null;
  const chosen = props.if ? props.then : props.else ?? null;
  return React.createElement("smithers:branch", props, chosen);
}

export function Ralph(props: RalphProps) {
  if (props.skipIf) return null;
  return React.createElement("smithers:ralph", props, props.children);
}
