import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import { useSyncClient } from "./useSyncClient.ts";

/** The five tones the run UI knows; mirrors `snapshotToGatewayRunNode`'s output. */
export type NodeStatus = "ok" | "running" | "queued" | "failed" | "waiting";

export type UseGatewayRunTreeResult = {
  /** The run tree with `children` rebuilt from the flat collection, or null when empty. */
  root: GatewayRunNode | null;
  /** Every flattened node row, keyed by id in the collection. */
  nodes: ReadonlyArray<GatewayRunNode>;
  /** The run-level status (the root node's status). */
  status: NodeStatus;
  isLoading: boolean;
  error: Error | undefined;
};

/**
 * Rebuild the nested `children` tree from the flat, `childIds`-keyed rows the
 * `nodes` collection stores. The collection holds the surgical diff of
 * `snapshotToGatewayRunNode`'s output (reconciled per devtools frame), so this
 * is a cheap pointer-chase over already-deduped rows.
 */
function buildRunTree(rows: readonly GatewayRunNode[]): GatewayRunNode | null {
  if (rows.length === 0) return null;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const build = (node: GatewayRunNode): GatewayRunNode => ({
    ...node,
    children: (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is GatewayRunNode => child !== undefined)
      .map(build),
  });
  const root = rows.find((row) => !row.parentId) ?? rows[0];
  return build(root);
}

/**
 * Live query over the per-run `nodes` collection (initial `getDevToolsSnapshot`
 * + `streamDevTools`, reconciled into the collection). Consumers re-render only
 * for the nodes that actually changed instead of remounting the whole tree on
 * every devtools frame — the headline win over the old whole-tree refetch.
 */
export function useGatewayRunTree(runId: string | undefined): UseGatewayRunTreeResult {
  const registry = useSyncClient();
  const collection = runId ? registry.nodes(runId) : undefined;

  const live = useLiveQuery(
    (q) => (collection ? q.from({ row: collection }) : undefined),
    [collection],
  );

  const nodes = (live.data ?? []) as GatewayRunNode[];
  const root = useMemo(() => buildRunTree(nodes), [nodes]);
  const status = (root?.status ?? "queued") as NodeStatus;
  const isLoading = Boolean(runId) && !live.isReady && nodes.length === 0;
  return {
    root,
    nodes,
    status,
    isLoading,
    error: live.isError ? new Error("Failed to load run tree.") : undefined,
  };
}
