import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import { buildGatewayRunTree } from "./buildGatewayRunTree.ts";
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
  const root = useMemo(() => buildGatewayRunTree(nodes), [nodes]);
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
