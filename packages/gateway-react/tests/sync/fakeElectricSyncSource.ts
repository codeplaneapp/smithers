import type { CollectionConfig } from "@tanstack/react-db";
import {
  createConnectionObserver,
  syncKeyFingerprint,
  type CollectionDef,
  type SyncSource,
} from "@smithers-orchestrator/gateway-client";

type FakeElectricSource = SyncSource & {
  setRows<TRow extends object, TKey extends string | number>(
    def: CollectionDef<TRow, TKey>,
    rows: readonly TRow[],
  ): void;
};

export function createFakeElectricSyncSource(): FakeElectricSource {
  const status = createConnectionObserver();
  const rowsByCollection = new Map<string, object[]>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (id: string) => {
    for (const listener of listeners.get(id) ?? []) listener();
  };

  return {
    collection<TRow extends object, TKey extends string | number>(
      def: CollectionDef<TRow, TKey>,
    ): CollectionConfig<TRow, TKey> {
      const id = syncKeyFingerprint(def.key);
      return {
        id,
        getKey: def.getKey,
        startSync: false,
        sync: {
          sync({ begin, write, commit, markReady, collection }) {
            const apply = () => {
              const rows = (rowsByCollection.get(id) ?? []) as TRow[];
              const nextKeys = new Set(rows.map((row) => def.getKey(row)));
              begin();
              for (const row of rows) {
                const key = def.getKey(row);
                write({ type: collection.has(key) ? "update" : "insert", value: row });
              }
              for (const key of collection.keys()) {
                if (!nextKeys.has(key)) write({ type: "delete", key });
              }
              commit();
              status.markOnline();
            };
            apply();
            markReady();
            const set = listeners.get(id) ?? new Set<() => void>();
            set.add(apply);
            listeners.set(id, set);
            return () => {
              set.delete(apply);
            };
          },
        },
      };
    },
    status: () => status,
    reset() {
      rowsByCollection.clear();
      listeners.clear();
      status.reset();
    },
    setRows<TRow extends object, TKey extends string | number>(
      def: CollectionDef<TRow, TKey>,
      rows: readonly TRow[],
    ): void {
      const id = syncKeyFingerprint(def.key);
      rowsByCollection.set(id, [...rows]);
      notify(id);
    },
  };
}
