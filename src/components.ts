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
  if (props.agent) {
    return React.createElement("smithers:task", props, props.children as any);
  }
  const { children, ...rest } = props as any;
  const nextProps = { ...rest, __payload: children } as any;
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
  if (process.env.SMITHERS_DEBUG) {
    console.error("[smithers] Ralph render", props.id ?? "(auto)", props.until);
  }
  return React.createElement("smithers:ralph", props, props.children);
}
