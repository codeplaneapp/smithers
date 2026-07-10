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
 * (`"agent" | "compute" | "static" | "human"`). Durable human-input gates
 * render as a `task` element whose serialized `props.__smithersKind` is
 * `"human"` (see `components/HumanTask`); newer snapshots also preserve the same
 * semantic on `task.kind`.
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
    /** Current lifecycle state from the run's node rows (latest iteration wins). */
    state?: string;
    attempt?: number;
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
 * Durable human-input gates are checked FIRST: older snapshots render a `task`
 * element carrying `props.__smithersKind === "human"`, while newer snapshots
 * also surface `task.kind === "human"`. Mapping either signal to `"human"` is
 * what lets `humanUtils.isHumanTaskNode` surface CLI guidance instead of
 * approve/deny controls that would strand the run. Container tags keep their own kind (helping `treeUtils`'
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
      if (taskKind === "human") {
        return "human";
      }
      if (taskKind === "approval") {
        return "approval";
      }
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
    case "in-progress":
    case "retrying":
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
      // Any other waiting-* variant (waiting-quota, future park states) is
      // still a wait, not an unknown.
      return state?.startsWith("waiting") ? "waiting" : "queued";
  }
}

/**
 * Derive a per-node status. Snapshots now carry each task node's current
 * lifecycle on `task.state` (attached server-side from the run's node rows),
 * so a task with a known state renders it directly. The remaining fallbacks
 * cover container nodes and older gateways whose snapshots predate state
 * enrichment: the blocked node is `waiting`, the root mirrors the run, a
 * finished run renders everything `ok`, and everything else stays a neutral
 * `queued` rather than inventing a state we do not have.
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
  const taskState = node.task?.state;
  if (taskState) {
    const mapped = toRunStatus(taskState);
    // "queued" is toRunStatus's unknown-state fallback; let unknown states
    // fall through so a finished run still renders them `ok`.
    if (mapped !== "queued") {
      return mapped;
    }
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
  const root = snapshot?.root;
  if (!root) {
    return null;
  }
  if (root.id === 0 && root.name === "(empty)" && (root.children?.length ?? 0) === 0) {
    return null;
  }
  const runState = asRecord(snapshot.runState);
  const runStatus = toRunStatus(typeof runState.state === "string" ? runState.state : undefined);
  const blocked = asRecord(runState.blocked);
  const blockedNodeId = typeof blocked.nodeId === "string" ? blocked.nodeId : undefined;
  return mapNode(root, true, runStatus, blockedNodeId);
}
