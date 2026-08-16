import { loadBunSqliteDrizzle } from "./bunSqliteRuntime.js";
import { acquireSqliteConnection } from "./sqliteConnectionRegistry.js";

/**
 * Open the standard durable local SQLite connection used by Smithers sidecars.
 * Keeping the raw constructor in the DB package preserves the repository's
 * storage ownership boundary.
 *
 * Routed through {@link acquireSqliteConnection} so a process that already has
 * this file open reuses that connection instead of adding a second one; a
 * second synchronous `bun:sqlite` handle on one file wedges the event loop for
 * the whole `busy_timeout` as soon as the two contend.
 *
 * Requires Bun. Callers that must also run on Node route around this: see
 * `attachMemoryBackend` in `smthrs/src/openSmithersBackend.js`.
 *
 * @param {string} path
 */
export function openDurableSqliteDatabase(path) {
  const drizzle = loadBunSqliteDrizzle();
  const sqlite = acquireSqliteConnection(path, {
    configure: (connection) => {
      // busy_timeout must precede the journal_mode change: switching journal modes
      // takes locks, and with no busy_timeout a contended open fails SQLITE_BUSY.
      connection.run("PRAGMA busy_timeout = 30000");
      connection.run("PRAGMA journal_mode = WAL");
      connection.run("PRAGMA synchronous = NORMAL");
      connection.run("PRAGMA locking_mode = NORMAL");
      connection.run("PRAGMA foreign_keys = ON");
    },
  });
  let released = false;
  return {
    db: drizzle(sqlite),
    close: () => {
      if (released) return;
      released = true;
      sqlite.close();
    },
  };
}
