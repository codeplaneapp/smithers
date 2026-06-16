import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { syncKeyFingerprint, type SyncKey } from "@smithers-orchestrator/gateway-client";
import { useSyncClient } from "./useSyncClient.ts";
import type { GatewayCollectionStatusRow } from "./GatewayCollections.ts";

export function useGatewayCollectionStatus(key: SyncKey): GatewayCollectionStatusRow {
  const registry = useSyncClient();
  const id = useMemo(() => syncKeyFingerprint(key), [key]);
  const collection = registry.collectionStatus(key);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection, id]);
  const row = ((live.data ?? []) as GatewayCollectionStatusRow[]).find((item) => item.key === id);
  return row ?? { key: id, status: "idle", error: undefined, revision: 0 };
}
