import { PersistentCollectionStore } from "./PersistentCollectionStore.ts";
import {
  openDbBackend,
  openOpfsSahPoolBackend,
  type SqliteWasmModule,
} from "./createSqliteWasmBackend.ts";

/**
 * The persistence handle `createGatewayCollections` consumes. It is just an
 * already-open {@link PersistentCollectionStore} plus a `dispose`. Building it is
 * async (SQLite-WASM init + OPFS VFS install), so the app awaits it *before*
 * constructing the collections registry — the registry needs the store
 * synchronously so it can hydrate a collection's first sync commit with no await.
 */
export type GatewayPersistence = {
  store: PersistentCollectionStore;
  dispose(): void;
};

export type CreateGatewayPersistenceOptions = {
  /**
   * The SQLite-WASM module the app already initialized via
   * `sqlite3InitModule()`. Injected (not imported) so gateway-react carries no
   * dependency on `@sqlite.org/sqlite-wasm` and the app's bundler owns the
   * `.wasm` asset resolution.
   */
  sqlite3: SqliteWasmModule;
  /**
   * Bump whenever a `Gateway*Row` shape or the collection-id scheme changes. A
   * mismatch with the persisted version drops the whole cache on open, so a
   * reload after a bump shows live data, never stale-shaped rows.
   */
  schemaVersion: string;
  /** OPFS directory for the SAHPool VFS (default `smithers-gateway-cache`). */
  directory?: string;
  /** DB file name inside the VFS (default `gateway-collections.sqlite3`). */
  dbName?: string;
  /**
   * Force a plain (non-OPFS) DB — used by tests to drive the same store logic
   * over an in-process WASM DB. In the browser, leave this unset.
   */
  forcePlainDbFile?: string;
};

/**
 * Open the gateway persistence store. In the browser it uses an OPFS SAHPool VFS
 * (durable across reload, **no** cross-origin isolation required). Returns `null`
 * when durable storage is unavailable (SSR / no OPFS) so the caller runs
 * live-only — the live gateway path is never gated on persistence succeeding.
 */
export async function createGatewayPersistence(
  options: CreateGatewayPersistenceOptions,
): Promise<GatewayPersistence | null> {
  const backend =
    options.forcePlainDbFile !== undefined
      ? openDbBackend(options.sqlite3, options.forcePlainDbFile)
      : await openOpfsSahPoolBackend(options.sqlite3, {
          directory: options.directory,
          dbName: options.dbName,
        });
  if (!backend) return null;
  const store = PersistentCollectionStore.open(backend, options.schemaVersion);
  return {
    store,
    dispose() {
      store.close();
    },
  };
}
