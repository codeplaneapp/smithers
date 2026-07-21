import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";

/**
 * Logical-node status index over a run tree's flattened rows.
 *
 * Tree rows are keyed per structural position, so loop/retry attempts share a
 * logical `id` across several rows. Every hand-rolled workflow UI re-invented
 * the same rank-merge to answer "what is node X doing *now*"; this is that
 * merge, promoted to one helper. Ranks: `running` wins (an active attempt beats
 * a failed earlier one), then `failed`, `waiting`, `ok`, `cancelled`, `queued`.
 */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  cancelled: 1,
  ok: 2,
  waiting: 3,
  failed: 4,
  running: 5,
};

function rank(status: string | undefined): number {
  return STATUS_RANK[status ?? "queued"] ?? 0;
}

/** Map of logical node id → merged status string (`ok`/`running`/`queued`/`failed`/`waiting`/`cancelled`). */
export type NodeStatusIndex = ReadonlyMap<string, string>;

/**
 * Build a {@link NodeStatusIndex} from {@link useGatewayRunTree}'s `nodes`
 * rows, merging duplicate logical ids by activity rank.
 *
 * @example
 * const tree = useGatewayRunTree(runId);
 * const statuses = nodeStatusIndex(tree.nodes);
 * statuses.get("implement"); // "running"
 */
export function nodeStatusIndex(
  nodes: ReadonlyArray<Pick<GatewayRunNode, "id" | "status">>,
): NodeStatusIndex {
  const index = new Map<string, string>();
  for (const node of nodes) {
    if (!node.id) continue;
    const status = typeof node.status === "string" ? node.status : "queued";
    const existing = index.get(node.id);
    if (existing === undefined || rank(status) >= rank(existing)) index.set(node.id, status);
  }
  return index;
}

/**
 * Roll a pipeline of nodes (e.g. one fleet item's `implement → gate → review →
 * commit` stages) up into a single status:
 *
 * - any stage `running` → `running` (a review-loop retry reads as in-flight,
 *   not as its earlier failure)
 * - else any `failed` → `failed`, any `waiting` → `waiting`
 * - all `ok` → `ok`; partially complete → `running`; untouched → `queued`
 */
export function rollupNodeStatus(index: NodeStatusIndex, nodeIds: readonly string[]): string {
  const statuses = nodeIds.map((id) => index.get(id) ?? "queued");
  if (statuses.length === 0) return "queued";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("waiting")) return "waiting";
  if (statuses.every((status) => status === "ok")) return "ok";
  if (statuses.some((status) => status === "ok")) return "running";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  return "queued";
}
