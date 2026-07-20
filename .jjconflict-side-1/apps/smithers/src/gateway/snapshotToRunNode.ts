import type { WorkflowKind } from "../askme/workflowFlow";
import type { NodeStatus, RunNode } from "../runs/Run";
import { toNodeStatus } from "./toNodeStatus";

/**
 * The shape of a `getDevToolsSnapshot` payload, narrowed to what the run tree
 * needs. The gateway builds this from a run's execution frames, so a run with no
 * frames yet returns the sentinel empty root (`id: 0`, `name: "(empty)"`).
 */
type SnapshotNode = {
  id: number;
  name: string;
  type?: string;
  props?: Record<string, unknown>;
  task?: { nodeId?: string; label?: string; iteration?: number };
  children?: SnapshotNode[];
};

type Snapshot = {
  root?: SnapshotNode;
  runState?: { state?: string; blocked?: { nodeId?: string } };
};

/**
 * The logical node id. `getNodeOutput` and approval rows speak the *logical*
 * task id (e.g. `plan`), so key on `task.nodeId` when present and fall back to
 * the structural numeric id for container nodes (Workflow / Sequence) that have
 * no task identity.
 */
function nodeId(node: SnapshotNode): string {
  return node.task?.nodeId ?? String(node.id);
}

function nodeName(node: SnapshotNode): string {
  const props = node.props ?? {};
  const label =
    node.task?.label ??
    (typeof props.label === "string" ? props.label : undefined) ??
    (typeof props.name === "string" ? props.name : undefined);
  return label ?? node.task?.nodeId ?? node.name;
}

/** Map the structural tag onto the graph palette; default neutral `compute`. */
function nodeKind(node: SnapshotNode): WorkflowKind {
  switch (node.type) {
    case "Approval":
      return "approval";
    case "Signal":
    case "WaitForEvent":
      return "signal";
    case "Human":
    case "HumanTask":
      return "human";
    case "Loop":
    case "ForEach":
      return "loop";
    case "Task":
    case "Agent":
      return "agent";
    default:
      return "compute";
  }
}

/**
 * Derive a per-node status. The snapshot tree carries no per-node lifecycle, so
 * the honest signals are the run-level state and the blocked node a paused run
 * waits on: the blocked node is `waiting`, the root mirrors the run, and when a
 * run has finished every node is done. Otherwise leave it `queued` (neutral)
 * rather than inventing a state we do not have.
 */
function nodeStatus(
  node: SnapshotNode,
  isRoot: boolean,
  runStatus: NodeStatus,
  blockedNodeId: string | undefined,
): NodeStatus {
  if (blockedNodeId && nodeId(node) === blockedNodeId) {
    return "waiting";
  }
  if (isRoot) {
    return runStatus;
  }
  if (runStatus === "ok") {
    return "ok";
  }
  return "queued";
}

function mapNode(
  node: SnapshotNode,
  isRoot: boolean,
  runStatus: NodeStatus,
  blockedNodeId: string | undefined,
): RunNode {
  return {
    id: nodeId(node),
    name: nodeName(node),
    kind: nodeKind(node),
    status: nodeStatus(node, isRoot, runStatus, blockedNodeId),
    children: (node.children ?? []).map((child) =>
      mapNode(child, false, runStatus, blockedNodeId),
    ),
  };
}

/**
 * Map a real `getDevToolsSnapshot` payload into the app's `RunNode` tree.
 * Returns null for the gateway's empty-root placeholder (a run with no frames
 * yet) so the inspector can show its empty state.
 */
export function snapshotToRunNode(snapshot: Snapshot | null | undefined): RunNode | null {
  const root = snapshot?.root;
  if (!root) {
    return null;
  }
  if (root.id === 0 && root.name === "(empty)" && (root.children?.length ?? 0) === 0) {
    return null;
  }
  const runStatus = toNodeStatus(snapshot?.runState?.state);
  const blockedNodeId = snapshot?.runState?.blocked?.nodeId;
  return mapNode(root, true, runStatus, blockedNodeId);
}
