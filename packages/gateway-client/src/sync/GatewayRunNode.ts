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
  agent?: string;
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
