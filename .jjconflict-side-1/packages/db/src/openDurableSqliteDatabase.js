import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

/**
 * Open the standard durable local SQLite connection used by Smithers sidecars.
 * Keeping the raw constructor in the DB package preserves the repository's
 * storage ownership boundary.
 *
 * @param {string} path
 */
export function openDurableSqliteDatabase(path) {
    const sqlite = new Database(path);
    sqlite.run("PRAGMA journal_mode = WAL");
    sqlite.run("PRAGMA busy_timeout = 30000");
    sqlite.run("PRAGMA synchronous = NORMAL");
    sqlite.run("PRAGMA locking_mode = NORMAL");
    sqlite.run("PRAGMA foreign_keys = ON");
    return {
        db: drizzle(sqlite),
        close: () => sqlite.close(),
    };
}
