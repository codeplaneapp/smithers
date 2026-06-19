import type { PersistenceBackend, SqlBindValue } from "./PersistenceBackend.ts";

/**
 * Wire a {@link PersistenceBackend} over `@sqlite.org/sqlite-wasm`. The SQLite
 * WASM module is *injected*, not imported here, for two reasons:
 *
 *   1. `@sqlite.org/sqlite-wasm` ships a `.wasm` asset that only a bundler (the
 *      consuming app's Vite) can resolve with the right URL/headers — so the app
 *      owns the import + `sqlite3InitModule()` call and hands us the ready module.
 *   2. The unit round-trip test injects the *same* module (its Node build) over
 *      an in-process DB, so the persistence logic is exercised for real with no
 *      mock — only the VFS differs (browser OPFS SAHPool vs. in-memory).
 *
 * This file never references the package, so gateway-react needs no dependency on
 * it; the app provides it.
 */

/** The slice of an `oo1.DB` instance we use — `exec` with the two row modes. */
export type Oo1Db = {
  exec(opts: {
    sql: string;
    bind?: ReadonlyArray<SqlBindValue>;
    rowMode?: "object";
    returnValue?: "resultRows";
  }): unknown;
  exec(sql: string): unknown;
  close(): void;
};

/** A constructor compatible with `sqlite3.oo1.DB` / `sqlite3.oo1.OpfsSAHPoolDb`. */
export type Oo1DbCtor = new (filename: string, flags?: string) => Oo1Db;

/** The minimal SQLite-WASM module shape we consume (a subset of `Sqlite3Static`). */
export type SqliteWasmModule = {
  oo1: { DB: Oo1DbCtor };
  installOpfsSAHPoolVfs?: (opts: {
    name?: string;
    directory?: string;
    clearOnInit?: boolean;
  }) => Promise<{ OpfsSAHPoolDb: Oo1DbCtor }>;
};

function backendFromDb(db: Oo1Db): PersistenceBackend {
  return {
    run(sql, bind) {
      db.exec({ sql, bind: bind ?? [] });
    },
    query(sql, bind) {
      const rows = db.exec({
        sql,
        bind: bind ?? [],
        rowMode: "object",
        returnValue: "resultRows",
      }) as Array<Record<string, SqlBindValue>>;
      return Array.isArray(rows) ? rows : [];
    },
    flush() {
      // SAHPool + in-memory VFS are durable on `exec`; a WAL checkpoint is a cheap
      // belt-and-suspenders and a no-op when WAL is off.
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // No WAL / unsupported — ignore; the row writes already committed.
      }
    },
    close() {
      db.close();
    },
  };
}

/**
 * Open a {@link PersistenceBackend} for the *browser*, backed by an OPFS SAHPool
 * VFS so writes survive a page reload **without** cross-origin isolation
 * (SharedArrayBuffer): the SAHPool VFS uses synchronous OPFS access handles, so
 * no COOP/COEP headers are required. Returns `null` when OPFS is unavailable
 * (no `navigator.storage.getDirectory`, e.g. SSR or a locked-down context) so the
 * caller can run live-only rather than throw.
 */
export async function openOpfsSahPoolBackend(
  sqlite3: SqliteWasmModule,
  options: { directory?: string; dbName?: string } = {},
): Promise<PersistenceBackend | null> {
  const hasOpfs =
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === "function";
  if (!hasOpfs || typeof sqlite3.installOpfsSAHPoolVfs !== "function") {
    return null;
  }
  const directory = options.directory ?? "smithers-gateway-cache";
  const dbName = options.dbName ?? "gateway-collections.sqlite3";
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: directory, directory: `/${directory}` });
  const db = new pool.OpfsSAHPoolDb(`/${dbName}`);
  return backendFromDb(db);
}

/**
 * Open a {@link PersistenceBackend} over a *plain* `oo1.DB` handle (a file name
 * or `:memory:`). Used by the unit round-trip test to exercise the exact same
 * `PersistentCollectionStore` logic the browser runs, against a real SQLite-WASM
 * DB — no mock.
 */
export function openDbBackend(sqlite3: SqliteWasmModule, filename = ":memory:"): PersistenceBackend {
  const db = new sqlite3.oo1.DB(filename, "c");
  return backendFromDb(db);
}
