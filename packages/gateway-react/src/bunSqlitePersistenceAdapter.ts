import type { PersistenceAdapter, PersistedRow, SavePersistedRowsRequest } from "./sync/PersistenceAdapter.ts";

type BunDatabase = {
  exec(sql: string): void;
  query<T = unknown, Args extends unknown[] = unknown[]>(sql: string): {
    get(...args: Args): T | null;
    all(...args: Args): T[];
    run(...args: Args): unknown;
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
};

type BunSqliteModule = {
  Database: new (path: string, options?: { create?: boolean }) => BunDatabase;
};

type CreateBunSqlitePersistenceAdapterOptions = {
  path: string;
};

function ensureTables(db: BunDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _smithers_client_persistence_meta (
      id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _smithers_client_persistence_rows (
      collection_id TEXT NOT NULL,
      row_key TEXT NOT NULL,
      row_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (collection_id, row_key)
    );
  `);
}

function ensureSchemaVersion(db: BunDatabase, schemaVersion: string) {
  const row = db.query<{ schema_version: string }, [string]>(
    "SELECT schema_version FROM _smithers_client_persistence_meta WHERE id = ?",
  ).get("schema");
  if (!row) {
    db.query("INSERT INTO _smithers_client_persistence_meta (id, schema_version) VALUES (?, ?)").run("schema", schemaVersion);
    return;
  }
  if (row.schema_version !== schemaVersion) {
    db.exec("DELETE FROM _smithers_client_persistence_rows");
    db.query("UPDATE _smithers_client_persistence_meta SET schema_version = ? WHERE id = ?").run(schemaVersion, "schema");
  }
}

export async function createBunSqlitePersistenceAdapter(
  options: CreateBunSqlitePersistenceAdapterOptions,
): Promise<PersistenceAdapter> {
  const sqlite = await import("bun:sqlite") as BunSqliteModule;
  const db = new sqlite.Database(options.path, { create: true });
  ensureTables(db);

  return {
    async loadRows<TRow extends object>(collectionId: string, schemaVersion: string): Promise<readonly PersistedRow<TRow>[]> {
      ensureSchemaVersion(db, schemaVersion);
      const rows = db.query<{ row_key: string; row_json: string }, [string]>(
        "SELECT row_key, row_json FROM _smithers_client_persistence_rows WHERE collection_id = ? ORDER BY row_key",
      ).all(collectionId);
      return rows.map((row) => ({ key: row.row_key, row: JSON.parse(row.row_json) as TRow }));
    },
    async saveRows<TRow extends object>(request: SavePersistedRowsRequest<TRow>): Promise<void> {
      ensureSchemaVersion(db, request.schemaVersion);
      const write = db.transaction(() => {
        db.query("DELETE FROM _smithers_client_persistence_rows WHERE collection_id = ?").run(request.collectionId);
        const insert = db.query(
          "INSERT INTO _smithers_client_persistence_rows (collection_id, row_key, row_json, updated_at_ms) VALUES (?, ?, ?, ?)",
        );
        const now = Date.now();
        for (const row of request.rows) {
          insert.run(request.collectionId, row.key, JSON.stringify(row.row), now);
        }
      });
      write();
    },
    async reset(): Promise<void> {
      db.exec("DELETE FROM _smithers_client_persistence_rows; DELETE FROM _smithers_client_persistence_meta;");
    },
    close(): void {
      db.close();
    },
  };
}
