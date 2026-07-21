import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";

/**
 * Logical-node status index over a run tree's flattened rows.
 *
 * Tree rows are keyed per structural position, so loop/retry attempts share a
 * logical `id` across several rows. Every hand-rolled workflow UI re-invented
 * the same merge to answer "what is node X doing *now*"; this is that merge,
 * promoted to one helper. The latest execution (iteration, then attempt) is
 * authoritative; activity rank — `running`, then `failed`, `waiting`, `ok`,
 * `cancelled`, `queued` — only breaks ties within the same execution.
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

type StatusRow = Pick<GatewayRunNode, "id" | "status" | "iteration" | "attempt">;

/**
 * True when `a` is a more recent execution of the same logical node than `b`:
 * higher iteration, then higher attempt, then activity rank as the tie-break
 * for rows of the same execution (a still-running duplicate beats a settled
 * one).
 */
function newer(a: StatusRow, b: StatusRow): boolean {
  const iterA = a.iteration ?? 0;
  const iterB = b.iteration ?? 0;
  if (iterA !== iterB) return iterA > iterB;
  const attemptA = a.attempt ?? 0;
  const attemptB = b.attempt ?? 0;
  if (attemptA !== attemptB) return attemptA > attemptB;
  return rank(typeof a.status === "string" ? a.status : "queued") >= rank(typeof b.status === "string" ? b.status : "queued");
}

/**
 * Build a {@link NodeStatusIndex} from {@link useGatewayRunTree}'s `nodes`
 * rows. Duplicate logical ids resolve to the LATEST execution (iteration,
 * then attempt) so a recovered loop/retry node reads `ok`, not its stale
 * earlier failure; activity rank only breaks ties within the same execution.
 *
 * @example
 * const tree = useGatewayRunTree(runId);
 * const statuses = nodeStatusIndex(tree.nodes);
 * statuses.get("implement"); // "running"
 */
export function nodeStatusIndex(nodes: ReadonlyArray<StatusRow>): NodeStatusIndex {
  const best = new Map<string, StatusRow>();
  for (const node of nodes) {
    if (!node.id) continue;
    const existing = best.get(node.id);
    if (existing === undefined || newer(node, existing)) best.set(node.id, node);
  }
  const index = new Map<string, string>();
  for (const [id, row] of best) index.set(id, typeof row.status === "string" ? row.status : "queued");
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
