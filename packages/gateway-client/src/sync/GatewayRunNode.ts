/** One display-safe agent reference: label/engine/model strings only. */
export type GatewayRunNodeAgentRef = {
  name?: string;
  engine?: string;
  model?: string;
};

/**
 * Structured agent assignment for a task node. The top-level fields describe
 * the DECLARED assignment (the workflow's `<Task agent={...}>` prop, known
 * even for queued nodes); `chain` lists a declared failover chain in order;
 * `ranOn` is what the latest attempt ACTUALLY executed on (from attempt
 * metadata — may differ from the declaration after failover, and is the only
 * signal on runs recorded before declared-agent capture).
 */
export type GatewayRunNodeAgent = GatewayRunNodeAgentRef & {
  chain?: ReadonlyArray<GatewayRunNodeAgentRef>;
  ranOn?: { engine?: string; model?: string; agentId?: string };
};

export type GatewayRunNode = {
  /**
   * Unique row identity, distinct per structural position in the run tree — so
   * loop/retry attempts that share a logical `id` (and differ only by
   * `iteration`) become DISTINCT rows instead of collapsing to the first. Use
   * this (via {@link runNodeKey}) for collection `getKey`, React keys, and the
   * `parentId`/`childIds` tree links. Falls back to `id` when absent (test
   * fixtures and legacy rows). The logical `id` (+ `iteration`) is what the
   * `getNodeOutput`/`getNodeDiff`/approval RPCs speak — keep using `id` there.
   */
  key?: string;
  /** The logical node id used by `getNodeOutput`/`getNodeDiff`/approval RPCs. */
  id: string;
  name: string;
  cardLabel?: string;
  kind: string;
  status: string;
  /**
   * Loop/retry iteration this node row represents. Sourced from the snapshot's
   * `task.iteration`; absent for container nodes that have no task identity.
   * Consumers thread it into `getNodeOutput`/approval lookups so loops and
   * retries read the right attempt rather than always iteration 0.
   */
  iteration?: number;
  meta?: string;
  /**
   * The task's agent: a structured {@link GatewayRunNodeAgent} when the
   * snapshot carries agent metadata, or a plain string on legacy rows.
   */
  agent?: string | GatewayRunNodeAgent;
  /** Latest attempt number for the node's state-bearing iteration. */
  attempt?: number;
  /** Attempt budget (declared retries + 1) when finite. */
  maxAttempts?: number;
  /**
   * The task's initial prompt (from the latest attempt's metadata, bounded for
   * display). Absent for queued nodes and tasks with no prompt.
   */
  prompt?: string;
  output?: string;
  toolCalls?: ReadonlyArray<Record<string, unknown>>;
  /** The parent row's `key` (see {@link key}) — NOT its logical `id`. */
  parentId?: string;
  /** Each child row's `key` (see {@link key}) — NOT its logical `id`. */
  childIds?: readonly string[];
  children?: GatewayRunNode[];
};

/** The unique row key for tree links / collection keys: `key` with an `id` fallback. */
export function runNodeKey(node: GatewayRunNode): string {
  return node.key ?? node.id;
}
