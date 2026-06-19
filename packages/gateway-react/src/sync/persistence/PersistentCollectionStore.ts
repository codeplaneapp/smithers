import type { PersistenceBackend } from "./PersistenceBackend.ts";

/**
 * A schema-versioned, backend-agnostic row cache for the gateway collections.
 *
 * It owns two tables in whatever {@link PersistenceBackend} it is handed:
 *
 *   - `gateway_meta(k TEXT PRIMARY KEY, v TEXT)` — holds the active `schemaVersion`.
 *   - `gateway_rows(collection_id TEXT, row_key TEXT, row_json TEXT,
 *      PRIMARY KEY(collection_id, row_key))` — one JSON-serialized row per
 *      `(collection, key)`, exactly the rows TanStack DB reconciles.
 *
 * **schemaVersion invalidation.** On {@link PersistentCollectionStore.open} the
 * store reads the stored `schemaVersion`. If it differs from the version the app
 * was built with (the caller passes the current one), every cached row is dropped
 * and the new version is recorded. A schema change therefore invalidates the
 * whole cache *cleanly* — a reload after a bump shows live data, never a row
 * shaped for the old schema. Bump the version whenever a `Gateway*Row` shape or
 * the collection-id fingerprint scheme changes.
 *
 * The store is deliberately dumb about *what* a row is: it stores `getKey(row) ->
 * JSON(row)` and hands JSON back. The collection's own `getKey` and reconcile
 * logic (in `createGatewayCollection`) decide identity and merge; this layer only
 * makes those rows survive a reload.
 */

const META_TABLE = "gateway_meta";
const ROWS_TABLE = "gateway_rows";
const SCHEMA_VERSION_KEY = "schemaVersion";

export type PersistedRow = { key: string; json: string };

/**
 * The synchronous store surface `withPersistence` / `createGatewayCollections`
 * consume. The in-process {@link PersistentCollectionStore} implements it over a
 * single SQLite handle. An app that must run SQLite in a Worker (e.g. browser
 * OPFS, whose synchronous access handles only exist off the main thread) supplies
 * its own implementation: synchronous reads from an in-memory mirror seeded at
 * boot, writes forwarded to the worker. Either way the reads MUST be synchronous
 * so a collection's first sync commit hydrates from cache with no await — that is
 * what removes the reload flash.
 */
export interface GatewayCollectionStore {
  /** All cached rows for one collection id, in stable key order. */
  read(collectionId: string): PersistedRow[];
  /** Insert-or-replace one row's JSON for a collection. */
  put(collectionId: string, key: string, json: string): void;
  /** Drop one row from a collection's cache. */
  delete(collectionId: string, key: string): void;
  /** Reconcile a collection's cache to exactly `rows` (upsert + delete missing). */
  replace(collectionId: string, rows: ReadonlyArray<PersistedRow>): void;
  /** Drop every cached row for one collection. */
  clearCollection(collectionId: string): void;
  /** Drop every cached row across all collections (sign-out / remote-mode swap). */
  clearAll(): void;
}

export class PersistentCollectionStore implements GatewayCollectionStore {
  private constructor(
    private readonly backend: PersistenceBackend,
    readonly schemaVersion: string,
  ) {}

  /**
   * Open the store over an already-connected backend, creating its tables and
   * applying schemaVersion invalidation. Synchronous on purpose: the backend's
   * `run`/`query` are synchronous (SAHPool / in-memory VFS), so the caller can
   * hydrate a collection's *first* sync commit from cache with no await — that
   * is what removes the reload flash.
   */
  static open(backend: PersistenceBackend, schemaVersion: string): PersistentCollectionStore {
    backend.run(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
    );
    backend.run(
      `CREATE TABLE IF NOT EXISTS ${ROWS_TABLE} (` +
        `collection_id TEXT NOT NULL, ` +
        `row_key TEXT NOT NULL, ` +
        `row_json TEXT NOT NULL, ` +
        `PRIMARY KEY (collection_id, row_key)` +
        `)`,
    );

    const stored = backend.query(`SELECT v FROM ${META_TABLE} WHERE k = ?`, [SCHEMA_VERSION_KEY]);
    const current = stored.length > 0 ? String(stored[0]?.v ?? "") : null;
    if (current !== schemaVersion) {
      // Schema changed (or first run): drop every cached row and record the new
      // version so the next reload starts clean rather than deserializing rows
      // shaped for the old schema.
      backend.run(`DELETE FROM ${ROWS_TABLE}`);
      backend.run(
        `INSERT INTO ${META_TABLE} (k, v) VALUES (?, ?) ` +
          `ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        [SCHEMA_VERSION_KEY, schemaVersion],
      );
      backend.flush?.();
    }
    return new PersistentCollectionStore(backend, schemaVersion);
  }

  /** All cached rows for one collection id, in stable key order. */
  read(collectionId: string): PersistedRow[] {
    const rows = this.backend.query(
      `SELECT row_key AS key, row_json AS json FROM ${ROWS_TABLE} ` +
        `WHERE collection_id = ? ORDER BY row_key`,
      [collectionId],
    );
    return rows.map((r) => ({ key: String(r.key), json: String(r.json) }));
  }

  /** Insert-or-replace one row's JSON for a collection. */
  put(collectionId: string, key: string, json: string): void {
    this.backend.run(
      `INSERT INTO ${ROWS_TABLE} (collection_id, row_key, row_json) VALUES (?, ?, ?) ` +
        `ON CONFLICT(collection_id, row_key) DO UPDATE SET row_json = excluded.row_json`,
      [collectionId, key, json],
    );
  }

  /** Drop one row from a collection's cache. */
  delete(collectionId: string, key: string): void {
    this.backend.run(
      `DELETE FROM ${ROWS_TABLE} WHERE collection_id = ? AND row_key = ?`,
      [collectionId, key],
    );
  }

  /**
   * Reconcile a collection's cache to exactly `rows` (replace semantics): upsert
   * the given rows and delete any cached key not present. Wrapped in a single
   * transaction so a reload never sees a half-applied snapshot.
   */
  replace(collectionId: string, rows: ReadonlyArray<PersistedRow>): void {
    const nextKeys = new Set(rows.map((r) => r.key));
    this.backend.run("BEGIN");
    try {
      for (const existing of this.read(collectionId)) {
        if (!nextKeys.has(existing.key)) this.delete(collectionId, existing.key);
      }
      for (const row of rows) this.put(collectionId, row.key, row.json);
      this.backend.run("COMMIT");
    } catch (error) {
      this.backend.run("ROLLBACK");
      throw error;
    }
    this.backend.flush?.();
  }

  /** Drop every cached row for one collection. */
  clearCollection(collectionId: string): void {
    this.backend.run(`DELETE FROM ${ROWS_TABLE} WHERE collection_id = ?`, [collectionId]);
    this.backend.flush?.();
  }

  /** Drop every cached row across all collections (sign-out / remote-mode swap). */
  clearAll(): void {
    this.backend.run(`DELETE FROM ${ROWS_TABLE}`);
    this.backend.flush?.();
  }

  close(): void {
    this.backend.close();
  }
}
