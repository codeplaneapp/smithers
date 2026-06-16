export type PersistedRow<TRow extends object> = {
  key: string;
  row: TRow;
};

export type SavePersistedRowsRequest<TRow extends object> = {
  collectionId: string;
  schemaVersion: string;
  rows: readonly PersistedRow<TRow>[];
};

export type PersistenceAdapter = {
  loadRows<TRow extends object>(collectionId: string, schemaVersion: string): Promise<readonly PersistedRow<TRow>[]>;
  saveRows<TRow extends object>(request: SavePersistedRowsRequest<TRow>): Promise<void>;
  reset?(): Promise<void> | void;
  close?(): Promise<void> | void;
};
