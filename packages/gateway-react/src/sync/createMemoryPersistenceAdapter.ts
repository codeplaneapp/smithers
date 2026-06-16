import type { PersistenceAdapter, PersistedRow, SavePersistedRowsRequest } from "./PersistenceAdapter.ts";

export function createMemoryPersistenceAdapter(): PersistenceAdapter & {
  rows(collectionId: string): readonly PersistedRow<object>[];
} {
  let schemaVersion: string | undefined;
  const rowsByCollection = new Map<string, PersistedRow<object>[]>();
  const ensureVersion = (next: string) => {
    if (schemaVersion === undefined) {
      schemaVersion = next;
      return;
    }
    if (schemaVersion !== next) {
      rowsByCollection.clear();
      schemaVersion = next;
    }
  };
  return {
    async loadRows<TRow extends object>(collectionId: string, version: string) {
      ensureVersion(version);
      return (rowsByCollection.get(collectionId) ?? []) as PersistedRow<TRow>[];
    },
    async saveRows<TRow extends object>(request: SavePersistedRowsRequest<TRow>) {
      ensureVersion(request.schemaVersion);
      rowsByCollection.set(request.collectionId, request.rows.map((row) => ({ key: row.key, row: row.row })));
    },
    async reset() {
      rowsByCollection.clear();
      schemaVersion = undefined;
    },
    rows(collectionId: string) {
      return rowsByCollection.get(collectionId) ?? [];
    },
  };
}
