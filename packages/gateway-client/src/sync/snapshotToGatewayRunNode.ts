import type { GatewayRunNode } from "./GatewayRunNode.ts";
import { asRecord } from "../objectGuards.ts";

/**
 * A node in a `getDevToolsSnapshot` payload. The gateway builds this tree from a
 * run's execution frames, so a run with no frames yet returns the sentinel empty
 * root (`id: 0`, `name: "(empty)"`).
 *
 * The shape mirrors `DevToolsNode` from `getDevToolsSnapshot` on the server: the
 * structural tag lands on `type` as a LOWERCASE `DevToolsNodeType`
 * (`"task"`, `"approval"`, `"loop"`, `"wait-for-event"`, …) — NOT a capitalized
 * component name — and the logical task descriptor carries the semantic `kind`
 * (`"agent" | "compute" | "static"`). Durable human-input gates render as a
 * `task` element whose serialized `props.__smithersKind` is `"human"` (see
 * `components/HumanTask`), which is the ONLY reliable human signal (the task
 * descriptor collapses `"human"` down to `"static"`).
 */
export type DevToolsSnapshotNode = {
  id: number | string;
  name: string;
  type?: string;
  props?: Record<string, unknown>;
  task?: {
    nodeId?: string;
    kind?: string;
    label?: string;
    iteration?: number;
  };
  children?: DevToolsSnapshotNode[];
};

/** The full `getDevToolsSnapshot` RPC payload, narrowed to what the run tree needs. */
export type DevToolsSnapshot = {
  root?: DevToolsSnapshotNode;
  runState?: { state?: string; blocked?: { nodeId?: string } };
};

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

/**
 * Map the real `getDevToolsSnapshot` node onto the graph/tree palette. The
 * gateway emits LOWERCASE `DevToolsNodeType` tags, so switch on those — the
 * capitalized component names never appear on real data.
 *
 * Durable human-input gates are checked FIRST: they render as a `task` element
 * carrying `props.__smithersKind === "human"` (the task descriptor's `kind`
 * flattens `"human"` to `"static"`, so `props.__smithersKind` is the honest
 * signal). Mapping them to `"human"` is what lets `humanUtils.isHumanTaskNode`
 * surface CLI guidance instead of approve/deny controls that would strand the
 * run. Container tags keep their own kind (helping `treeUtils`'
 * `CONTAINER_KINDS` detection); everything unrecognized falls back to the
 * neutral `compute`.
 */
function nodeKind(node: DevToolsSnapshotNode): string {
  const props = node.props ?? {};
  const smithersKind =
    typeof props.__smithersKind === "string" ? props.__smithersKind : undefined;
  if (smithersKind === "human") {
    return "human";
  }
  switch (node.type) {
    case "approval":
      return "approval";
    case "wait-for-event":
    case "timer":
      return "signal";
    case "loop":
      return "loop";
    case "parallel":
      return "parallel";
    case "saga":
      return "saga";
    case "try-catch":
      return "try-catch";
    case "workflow":
      return "workflow";
    case "task": {
      const taskKind = node.task?.kind;
      if (taskKind === "compute" || smithersKind === "compute") {
        return "compute";
      }
      return "agent";
    }
    default:
      return "compute";
  }
}

/**
 * Collapse a gateway run/lifecycle state onto the tones the run UI knows.
 * Mirrors `apps/smithers`'s `toNodeStatus`; unknown/empty falls back to the
 * neutral `queued`. `cancelled` is preserved as its OWN tone (not collapsed to
 * `failed`) so a deliberate cancel renders dim/grey rather than as a red error —
 * matching `runStatusFromFrame` and the header's cancelled status dot.
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
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "failed":
    case "errored":
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
  const iteration = node.task?.iteration;
  return {
    // The snapshot's structural `node.id` is assigned uniquely per position in
    // the tree (`assignId` in getDevToolsSnapshot), so it is the stable, unique
    // row key. The logical `id` (task.nodeId) can repeat across loop/retry
    // attempts, so it cannot be the row key — but it IS what the RPCs speak.
    key: String(node.id),
    id: nodeId(node),
    name: nodeName(node),
    kind: nodeKind(node),
    status: nodeStatus(node, isRoot, runStatus, blockedNodeId),
    ...(typeof iteration === "number" ? { iteration } : {}),
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
