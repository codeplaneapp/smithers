import type { GatewayRunNode, GatewayRunNodeAgent, GatewayRunNodeAgentRef } from "./GatewayRunNode.ts";
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
    /** Legacy plain-string agent prop (only ever a string in frame props). */
    agent?: string;
    /** Declared `<Task agent={...}>` summary from the frame task index. */
    agentSummary?: { label?: string; engine?: string; model?: string; chain?: Array<{ label?: string; engine?: string; model?: string }> };
    /** Agent the latest attempt actually executed on (attempt metadata). */
    agentRan?: { agentId?: string; engine?: string; model?: string };
    label?: string;
    iteration?: number;
    /** Current lifecycle state from the run's node rows (latest iteration wins). */
    state?: string;
    attempt?: number;
    /** Attempt budget (declared retries + 1) when finite. */
    maxAttempts?: number;
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
 *
 * Also normalizes multiplayer `_smithers_nodes` rows (`mapSmithersElectricRow`),
 * whose persisted vocabulary (`in-progress`, `finished`, `pending`, …) must land
 * on the same tones as this local snapshot path.
 */
export function toRunStatus(state: string | undefined): string {
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
    case "paused":
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
    // A terminal run can strand node rows at in-progress (the engine died or
    // was cancelled mid-task); "running" on a dead run is a lie — render the
    // run's own terminal tone instead.
    if (mapped === "running" && (runStatus === "ok" || runStatus === "cancelled" || runStatus === "failed")) {
      return runStatus === "ok" ? "ok" : "cancelled";
    }
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

/**
 * Roll a container's status up from its children: containers (workflow,
 * sequence, parallel, worktree, …) have no node rows of their own, so their
 * honest tone is the aggregate of what is happening beneath them. Any running
 * child wins, then waiting, then "all terminal" resolves to failed (if any
 * child failed) or ok; a mix of terminal and queued children stays queued.
 */
function rollupStatus(own: string, children: GatewayRunNode[]): string {
  if (own !== "queued" || children.length === 0) {
    return own;
  }
  let sawFailed = false;
  let sawCancelled = false;
  let allTerminal = true;
  for (const child of children) {
    switch (child.status) {
      case "running":
        return "running";
      case "waiting":
        return "waiting";
      case "failed":
        sawFailed = true;
        break;
      case "cancelled":
        sawCancelled = true;
        break;
      case "ok":
        break;
      default:
        allTerminal = false;
    }
  }
  if (!allTerminal) {
    return "queued";
  }
  if (sawFailed) {
    return "failed";
  }
  if (sawCancelled) {
    return "cancelled";
  }
  return "ok";
}

function agentRef(value: { label?: string; engine?: string; model?: string } | undefined): GatewayRunNodeAgentRef | undefined {
  if (!value) {
    return undefined;
  }
  const name = typeof value.label === "string" && value.label ? value.label : undefined;
  const engine = typeof value.engine === "string" && value.engine ? value.engine : undefined;
  const model = typeof value.model === "string" && value.model ? value.model : undefined;
  if (!name && !engine && !model) {
    return undefined;
  }
  return {
    ...(name ? { name } : {}),
    ...(engine ? { engine } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * The node's agent for the run UI. Structured metadata (declared summary
 * and/or the acting agent from attempt metadata) wins; a legacy plain-string
 * agent prop passes through unchanged. `name` falls back to engine/model so
 * chips keep rendering when the declaration carries no label.
 */
function nodeAgent(node: DevToolsSnapshotNode): GatewayRunNode["agent"] {
  const task = node.task;
  const declared = agentRef(task?.agentSummary);
  const chain = (task?.agentSummary?.chain ?? [])
    .map(agentRef)
    .filter((entry): entry is GatewayRunNodeAgentRef => entry !== undefined);
  const ranRaw = task?.agentRan;
  const ranEngine = typeof ranRaw?.engine === "string" && ranRaw.engine ? ranRaw.engine : undefined;
  const ranModel = typeof ranRaw?.model === "string" && ranRaw.model ? ranRaw.model : undefined;
  const ranAgentId = typeof ranRaw?.agentId === "string" && ranRaw.agentId ? ranRaw.agentId : undefined;
  const ranOn = ranEngine || ranModel || ranAgentId
    ? {
        ...(ranEngine ? { engine: ranEngine } : {}),
        ...(ranModel ? { model: ranModel } : {}),
        ...(ranAgentId ? { agentId: ranAgentId } : {}),
      }
    : undefined;
  if (!declared && chain.length === 0 && !ranOn) {
    const legacy = task?.agent ?? (typeof (node.props ?? {}).agent === "string" ? String((node.props ?? {}).agent) : undefined);
    return typeof legacy === "string" && legacy ? legacy : undefined;
  }
  const agent: GatewayRunNodeAgent = { ...(declared ?? {}) };
  if (!agent.name) {
    agent.name = agent.engine ?? agent.model ?? ranEngine ?? ranAgentId;
  }
  if (chain.length > 0) {
    agent.chain = chain;
  }
  if (ranOn) {
    agent.ranOn = ranOn;
  }
  return agent;
}

function mapNode(
  node: DevToolsSnapshotNode,
  isRoot: boolean,
  runStatus: string,
  blockedNodeId: string | undefined,
): GatewayRunNode {
  const iteration = node.task?.iteration;
  const agent = nodeAgent(node);
  const attempt = node.task?.attempt;
  const maxAttempts = node.task?.maxAttempts;
  const children = (node.children ?? []).map((child) =>
    mapNode(child, false, runStatus, blockedNodeId),
  );
  const ownStatus = nodeStatus(node, isRoot, runStatus, blockedNodeId);
  return {
    // The snapshot's structural `node.id` is assigned uniquely per position in
    // the tree (`assignId` in getDevToolsSnapshot), so it is the stable, unique
    // row key. The logical `id` (task.nodeId) can repeat across loop/retry
    // attempts, so it cannot be the row key — but it IS what the RPCs speak.
    key: String(node.id),
    id: nodeId(node),
    name: nodeName(node),
    kind: nodeKind(node),
    status: isRoot || node.task ? ownStatus : rollupStatus(ownStatus, children),
    ...(typeof iteration === "number" ? { iteration } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(typeof attempt === "number" && Number.isFinite(attempt) ? { attempt } : {}),
    ...(typeof maxAttempts === "number" && Number.isFinite(maxAttempts) ? { maxAttempts } : {}),
    children,
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
