import type { CollectionConfig } from "@tanstack/react-db";
import type { PersistenceAdapter, PersistedRow } from "./PersistenceAdapter.ts";
import { resolveLazy, type LazyValue } from "./resolveLazy.ts";

type SyncReturn = void | (() => void) | { cleanup?: () => void };

type PersistedCollectionOptions<TRow extends object, TKey extends string | number> = CollectionConfig<TRow, TKey> & {
  persistence: LazyValue<PersistenceAdapter | undefined>;
  schemaVersion: LazyValue<string>;
  maxRows?: number;
  /**
   * Per-row transform applied only on the way into the persistence adapter, so
   * a collection can keep large blobs out of its durable copy while the live
   * in-memory row stays intact (see `sanitizeRunEventRowForPersistence`).
   */
  sanitizeRow?: (row: TRow) => TRow;
};

function normalizeCleanup(result: SyncReturn): (() => void) | undefined {
  if (typeof result === "function") return result;
  if (typeof result === "object" && result !== null) return result.cleanup;
  return undefined;
}

function withoutVirtualFields<TRow extends object>(row: TRow): TRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("$") && value !== undefined) {
      out[key] = value;
    }
  }
  return out as TRow;
}

function keyString(key: string | number): string {
  return typeof key === "number" ? `n:${key}` : `s:${key}`;
}

function sortKeys(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

export function persistedCollectionOptions<TRow extends object, TKey extends string | number>(
  options: PersistedCollectionOptions<TRow, TKey>,
): CollectionConfig<TRow, TKey> {
  const { persistence, schemaVersion, maxRows, sanitizeRow, ...sourceConfig } = options;
  const sourceSync = sourceConfig.sync;
  const id = sourceConfig.id ?? "";

  return {
    ...sourceConfig,
    sync: {
      ...sourceSync,
      sync(api) {
        let cleanedUp = false;
        let sourceCleanup: (() => void) | undefined;
        let markedReady = false;
        let hydrating = false;
        let persistChain = Promise.resolve();
        let pendingSnapshot = false;

        const markReadyOnce = () => {
          if (markedReady) return;
          markedReady = true;
          api.markReady();
        };

        const snapshotRows = (): PersistedRow<TRow>[] => {
          const keys = Array.from(api.collection.keys()).sort(sortKeys);
          const bounded = maxRows && keys.length > maxRows ? keys.slice(keys.length - maxRows) : keys;
          return bounded
            .map((key) => {
              const row = api.collection.get(key);
              if (!row) return undefined;
              const clean = withoutVirtualFields(row as TRow);
              return { key: keyString(key), row: sanitizeRow ? sanitizeRow(clean) : clean };
            })
            .filter((row): row is PersistedRow<TRow> => row !== undefined);
        };

        const enqueuePersist = (adapter: PersistenceAdapter, version: string) => {
          if (hydrating || cleanedUp || pendingSnapshot) return;
          pendingSnapshot = true;
          persistChain = persistChain
            .then(async () => {
              pendingSnapshot = false;
              if (!cleanedUp) {
                await adapter.saveRows({ collectionId: id, schemaVersion: version, rows: snapshotRows() });
              }
            })
            .catch(() => {
              pendingSnapshot = false;
            });
        };

        void (async () => {
          const [adapter, version] = await Promise.all([
            resolveLazy(persistence),
            resolveLazy(schemaVersion),
          ]);
          if (cleanedUp || !adapter) {
            if (!cleanedUp) {
              sourceCleanup = normalizeCleanup(sourceSync.sync({ ...api, markReady: markReadyOnce }) as SyncReturn);
            }
            return;
          }

          try {
            const cachedRows = await adapter.loadRows<TRow>(id, version);
            if (cleanedUp) return;
            if (cachedRows.length > 0) {
              hydrating = true;
              api.begin({ immediate: true });
              for (const { row } of cachedRows) {
                const key = sourceConfig.getKey(row);
                api.write({ type: api.collection.has(key) ? "update" : "insert", value: row });
              }
              api.commit();
              hydrating = false;
              markReadyOnce();
            }
          } catch {
            hydrating = false;
          }

          if (cleanedUp) return;
          let inTransaction = false;
          const wrappedApi = {
            ...api,
            begin: (beginOptions?: { immediate?: boolean }) => {
              inTransaction = true;
              api.begin(beginOptions);
            },
            write: api.write,
            commit: () => {
              api.commit();
              if (inTransaction) {
                enqueuePersist(adapter, version);
                inTransaction = false;
              }
            },
            markReady: markReadyOnce,
          };
          sourceCleanup = normalizeCleanup(sourceSync.sync(wrappedApi) as SyncReturn);
        })().catch(() => {
          if (!markedReady && !cleanedUp) markReadyOnce();
        });

        return () => {
          cleanedUp = true;
          sourceCleanup?.();
        };
      },
    },
  };
}
