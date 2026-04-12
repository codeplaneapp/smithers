import type { NodeSnapshot } from "../NodeSnapshot";
/**
 * Given a set of node IDs to reset, compute the full transitive set including
 * all downstream dependents.  In the absence of an explicit dependency graph,
 * we reset every node whose iteration >= the minimum iteration of the reset
 * set. This is intentionally conservative — it re-runs more rather than less.
 */
export declare function expandResetSet(nodes: Record<string, NodeSnapshot>, resetNodeIds: string[]): string[];
