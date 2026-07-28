/**
 * The run domain model, ported from multi's `src/runs/Run.ts`. A Run is a tree
 * of nodes the agent executes; the chat surfaces it as a live card, and the
 * canvas opens it as an inspector. Statuses drive every state color in the UI
 * (see statusMeta.ts).
 *
 * `NodeStatus` lives in statusMeta.ts (ui-core landed statusMeta.ts before this
 * module during phase 1; multi has the dependency direction reversed —
 * Run.ts defines it there and statusMeta.ts imports it).
 */
import type { NodeStatus } from "./statusMeta.ts";

export type { NodeStatus };

/**
 * The Smithers node kinds — each maps to a colored accent in the graph.
 * Inlined from multi's `askme/flowGraph.ts` `FlowKind` (a plain string union
 * with no runtime dependency): importing that module directly would pull in
 * `dagre` + `@xyflow/react`, which ui-core must not depend on.
 */
export type FlowKind = "agent" | "compute" | "approval" | "merge" | "loop" | "branch" | "signal" | "human";

export type ToolVerb = "Edit" | "Write" | "Read" | "Bash" | "Grep";

export type ToolCall = {
  id: string;
  verb: ToolVerb;
  target: string;
  status: NodeStatus;
  /** Line deltas, shown on Edit/Write calls. */
  add?: number;
  del?: number;
};

export type RunNode = {
  id: string;
  /** Tree label, e.g. "edit-files" or "auth/session.ts". */
  name: string;
  /** Friendlier label for the run card, e.g. "Edit 6 files". */
  cardLabel?: string;
  /** Kind drives graph coloring; reuses the workflow node palette. */
  kind: FlowKind;
  status: NodeStatus;
  /** Right-aligned meta on a row, e.g. "8s" / "running" / "queued". */
  meta?: string;
  agent?: string;
  /** Node output, shown on the inspector's Output tab. */
  output?: string;
  toolCalls?: ToolCall[];
  children?: RunNode[];
};

export type Run = {
  id: string;
  /** Display title, e.g. "Implement · auth refactor". */
  title: string;
  model: string;
  /** Short run number shown as "run 4821". */
  runId: string;
  status: NodeStatus;
  startedAtMs: number;
  /** Current frame and total, used by the time-travel scrubber. */
  frame: number;
  frameCount: number;
  root: RunNode;
};

/** Depth-first lookup by node id. */
export function findNode(node: RunNode, id: string): RunNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/** The run card lists the top-level steps; gate nodes are surfaced separately. */
export function runSteps(run: Run): RunNode[] {
  return run.root.children ?? [];
}
