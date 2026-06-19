/**
 * The minimal synchronous SQL surface the persistence store drives. A backend is
 * an already-open SQLite database handle (the browser path opens one over an OPFS
 * SAHPool VFS via `@sqlite.org/sqlite-wasm`; tests open an in-process WASM DB over
 * the same `oo1.DB` API). Keeping the surface this small is what lets the *exact
 * same* `PersistentCollectionStore` logic run in the browser and under the unit
 * round-trip test with no mock — only the handle differs.
 *
 * Every method is synchronous because both the OPFS SAHPool VFS and the in-memory
 * VFS expose synchronous `exec`; that is the whole reason the SAHPool VFS exists
 * (it needs no cross-origin isolation / SharedArrayBuffer, unlike the async OPFS
 * VFS). See `createSqliteWasmBackend`.
 */
export type SqlBindValue = string | number | null;

export type PersistenceBackend = {
  /** Run a statement with no result rows (DDL / INSERT / DELETE). */
  run(sql: string, bind?: ReadonlyArray<SqlBindValue>): void;
  /** Run a query, returning every row as a plain object. */
  query(sql: string, bind?: ReadonlyArray<SqlBindValue>): ReadonlyArray<Record<string, SqlBindValue>>;
  /** Flush durable state (OPFS SAHPool is durable on `exec`, but a checkpoint is cheap insurance). */
  flush?(): void;
  /** Close the underlying handle (best-effort; the page lifecycle usually owns this). */
  close(): void;
};
