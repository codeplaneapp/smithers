import type { CollectionConfig } from "@tanstack/react-db";
import type { GatewayCollectionStore, PersistedRow } from "./PersistentCollectionStore.ts";

/**
 * Wrap a gateway collection's `CollectionConfig` so its rows survive a reload,
 * **without changing the live sync path**. The config we receive is the one
 * `createGatewayCollection` builds (RPC + WS stream); we only decorate it:
 *
 *   - **Hydrate (no flash).** Before the live sync's first network round-trip,
 *     we synchronously read the collection's cached rows from the SQLite store
 *     and emit them as the collection's first `begin → write(insert) → commit`.
 *     `useLiveQuery` therefore renders persisted data on the very first frame
 *     after a reload — no empty state, no re-seed, no fetch flash. When the live
 *     RPC lands moments later, `createGatewayCollection`'s `replaceRows` reconcile
 *     diffs against these hydrated rows and only writes the deltas.
 *
 *   - **Write through.** We subscribe to the collection's change stream and
 *     mirror every insert/update/delete into the store, so the cache always
 *     reflects the latest live snapshot for the next reload.
 *
 * Identity and shape come entirely from the original config (`getKey`,
 * `rowUpdateMode`); this layer is a pure cache around it. Because we hold the
 * config's `getKey`, the serialized row's key always matches the live row's key,
 * so hydrated rows merge cleanly rather than duplicating.
 */

type AnyRow = object;

function stripVirtualFields(row: AnyRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith("$") && v !== undefined) out[k] = v;
  }
  return out;
}

export function withPersistence<TRow extends object, TKey extends string | number>(
  config: CollectionConfig<TRow, TKey>,
  store: GatewayCollectionStore,
): CollectionConfig<TRow, TKey> {
  const collectionId = config.id;
  if (!collectionId) return config;
  const getKey = config.getKey;
  const innerSync = config.sync;

  const serialize = (row: TRow): PersistedRow => ({
    key: String(getKey(row)),
    json: JSON.stringify(stripVirtualFields(row)),
  });

  return {
    ...config,
    sync: {
      ...innerSync,
      sync: (params) => {
        const { begin, write, commit, collection } = params;

        // 1) Hydrate from cache synchronously so the first render after a reload
        //    already has data. Skip if the collection somehow already holds rows.
        let hydrated = false;
        try {
          if (collection.size === 0) {
            const cached = store.read(collectionId);
            if (cached.length > 0) {
              begin();
              for (const { json } of cached) {
                const value = JSON.parse(json) as TRow;
                write({ type: "insert", value });
              }
              commit();
              hydrated = true;
            }
          }
        } catch {
          // A corrupt / schema-mismatched cache must never break the live path:
          // drop this collection's cache and continue live-only.
          store.clearCollection(collectionId);
        }

        // 2) Start the real live sync (RPC + WS). It reconciles against whatever
        //    we hydrated, writing only the deltas.
        const cleanupInner = innerSync.sync(params);

        // 3) Write through every committed change to the store so the next reload
        //    hydrates from the latest snapshot.
        const subscription = collection.subscribeChanges((changes) => {
          try {
            for (const change of changes) {
              if (change.type === "delete") {
                store.delete(collectionId, String(change.key));
              } else {
                store.put(collectionId, String(change.key), JSON.stringify(stripVirtualFields(change.value)));
              }
            }
          } catch {
            // Never let a cache write break the live UI.
          }
        });

        // If we did NOT hydrate (cold cache), seed the store from the live snapshot
        // once it is present, so a subsequent reload is warm.
        if (!hydrated) {
          try {
            const snapshot: PersistedRow[] = [];
            for (const [, value] of collection.entries()) snapshot.push(serialize(value as TRow));
            if (snapshot.length > 0) store.replace(collectionId, snapshot);
          } catch {
            // ignore
          }
        }

        return () => {
          subscription.unsubscribe();
          if (typeof cleanupInner === "function") cleanupInner();
          else if (cleanupInner && typeof (cleanupInner as { cleanup?: () => void }).cleanup === "function") {
            (cleanupInner as { cleanup: () => void }).cleanup();
          }
        };
      },
    },
  };
}
