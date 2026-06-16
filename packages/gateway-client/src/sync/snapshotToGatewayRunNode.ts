import type { GatewayRunNode } from "./GatewayRunNode.ts";

/**
 * A node in a `getDevToolsSnapshot` payload. The gateway builds this tree from a
 * run's execution frames, so a run with no frames yet returns the sentinel empty
 * root (`id: 0`, `name: "(empty)"`).
 */
export type DevToolsSnapshotNode = {
  id: number | string;
  name: string;
  type?: string;
  props?: Record<string, unknown>;
  task?: { nodeId?: string; label?: string; iteration?: number };
  children?: DevToolsSnapshotNode[];
};

/** The full `getDevToolsSnapshot` RPC payload, narrowed to what the run tree needs. */
export type DevToolsSnapshot = {
  root?: DevToolsSnapshotNode;
  runState?: { state?: string; blocked?: { nodeId?: string } };
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * The logical node id. `getNodeOutput` and approval rows speak the *logical* task
 * id (e.g. `plan`), so key on `task.nodeId` when present and fall back to the
 * structural id for container nodes (Workflow / Sequence) that have no task
 * identity.
 */
function nodeId(node: DevToolsSnapshotNode): string {
  return node.task?.nodeId ?? String(node.id);
}

function nodeName(node: DevToolsSnapshotNode): string {
  const props = node.props ?? {};
  const label =
    node.task?.label ??
    (typeof props.label === "string" ? props.label : undefined) ??
    (typeof props.name === "string" ? props.name : undefined);
  return label ?? node.task?.nodeId ?? node.name;
}

/** Map the structural tag onto the graph palette; default neutral `compute`. */
function nodeKind(node: DevToolsSnapshotNode): string {
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
 * Collapse a gateway run/lifecycle state onto the five tones the run UI knows.
 * Mirrors `apps/smithers`'s `toNodeStatus`; unknown/empty falls back to the
 * neutral `queued`.
 */
function toRunStatus(state: string | undefined): string {
  switch (state) {
    case "running":
      return "running";
    case "succeeded":
    case "finished":
    case "completed":
    case "ok":
      return "ok";
    case "failed":
    case "errored":
    case "cancelled":
    case "canceled":
      return "failed";
    case "waiting-approval":
    case "waiting-event":
    case "waiting-timer":
    case "waiting":
    case "blocked":
      return "waiting";
    default:
      return "queued";
  }
}

/**
 * Derive a per-node status. The snapshot tree carries no per-node lifecycle, so
 * the honest signals are the run-level state and the blocked node a paused run
 * waits on: the blocked node is `waiting`, the root mirrors the run, and when a
 * run has finished every node is `ok`. Otherwise leave it `queued` (neutral)
 * rather than inventing a state we do not have.
 */
function nodeStatus(
  node: DevToolsSnapshotNode,
  isRoot: boolean,
  runStatus: string,
  blockedNodeId: string | undefined,
): string {
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
  node: DevToolsSnapshotNode,
  isRoot: boolean,
  runStatus: string,
  blockedNodeId: string | undefined,
): GatewayRunNode {
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
 * Map a real `getDevToolsSnapshot` payload into a `GatewayRunNode` tree (with
 * `children` populated; pass the result through `flattenGatewayRunNode` to get
 * the flat, `childIds`/`parentId`-keyed rows the `nodes` collection stores).
 * Returns null for the gateway's empty-root placeholder (a run with no frames
 * yet) so consumers can show their empty state.
 */
export function snapshotToGatewayRunNode(
  snapshot: DevToolsSnapshot | null | undefined,
): GatewayRunNode | null {
  const root = (snapshot as DevToolsSnapshot | null | undefined)?.root;
  if (!root) {
    return null;
  }
  if (root.id === 0 && root.name === "(empty)" && (root.children?.length ?? 0) === 0) {
    return null;
  }
  const runState = asRecord((snapshot as DevToolsSnapshot).runState);
  const runStatus = toRunStatus(typeof runState.state === "string" ? runState.state : undefined);
  const blocked = asRecord(runState.blocked);
  const blockedNodeId = typeof blocked.nodeId === "string" ? blocked.nodeId : undefined;
  return mapNode(root, true, runStatus, blockedNodeId);
}
