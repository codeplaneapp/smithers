import { loadBunSqliteDatabase, loadBunSqliteDrizzle } from "./bunSqliteRuntime.js";

/**
 * Open the standard durable local SQLite connection used by Smithers sidecars.
 * Keeping the raw constructor in the DB package preserves the repository's
 * storage ownership boundary.
 *
 * Requires Bun. Callers that must also run on Node route around this: see
 * `attachMemoryBackend` in `smthrs/src/openSmithersBackend.js`.
 *
 * @param {string} path
 */
export function openDurableSqliteDatabase(path) {
  const Database = loadBunSqliteDatabase();
  const drizzle = loadBunSqliteDrizzle();
  const sqlite = new Database(path);
  // busy_timeout must precede the journal_mode change: switching journal modes
  // takes locks, and with no busy_timeout a contended open fails SQLITE_BUSY.
  sqlite.run("PRAGMA busy_timeout = 30000");
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA synchronous = NORMAL");
  sqlite.run("PRAGMA locking_mode = NORMAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  return {
    db: drizzle(sqlite),
    close: () => sqlite.close(),
  };
}
