import type { SyncKey } from "./SyncKey.ts";
import type { GatewayCollectionStreamConfig } from "./createGatewayCollection.ts";

export type CollectionDef<TRow extends object, TKey extends string | number = string> = {
  key: SyncKey;
  getKey: (row: TRow) => TKey;
  persisted?: boolean;
  maxRows?: number;
  /**
   * Optional per-row transform applied only on the way into client persistence
   * (never to the live in-memory row). Used to keep large blobs out of the
   * durable cache — see `sanitizeRunEventRowForPersistence`.
   */
  sanitizeForPersistence?: (row: TRow) => TRow;
  gateway: {
    method?: string;
    params?: unknown;
    rows?: (payload: unknown) => Iterable<TRow> | Promise<Iterable<TRow>>;
    stream?: GatewayCollectionStreamConfig<TRow, TKey>;
  };
  electric?: {
    shape: {
      table: string;
      where?: string;
      columns?: string[];
    };
  };
};
