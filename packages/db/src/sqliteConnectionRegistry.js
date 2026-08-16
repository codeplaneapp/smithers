import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadBunSqliteDatabase } from "./bunSqliteRuntime.js";

/**
 * Process-wide, refcounted `bun:sqlite` connections keyed by resolved absolute
 * path, so one process holds exactly ONE connection per database file.
 *
 * Why this has to exist: `bun:sqlite` is synchronous. When two connections in
 * the same process point at one file and the first holds the WAL write lock
 * across an `await`, the second one's write blocks the whole event loop inside
 * `sqlite3_step` for the entire `busy_timeout` (30s here). Nothing else can run
 * — including the very continuation that would commit and release the first
 * transaction — so the lock cannot clear and the wait always runs to timeout,
 * surfacing as SQLITE_BUSY / SQLITE_PROTOCOL ("locking protocol"). Lease
 * heartbeats, timers, and HTTP handlers all die for the duration. Two
 * connections to the same file in one process are never worth the risk: SQLite
 * serializes statements on a shared connection instead, and the adapter's
 * per-client transaction coordination (see `sqliteTransactionStateByClient` in
 * `adapter.js`) already queues concurrent fibers behind an open transaction.
 *
 * Refcounted so existing close semantics keep working: every acquirer still
 * calls `close()` exactly as before (including `Gateway.close()` using it as an
 * I/O barrier); the underlying `sqlite3_close()` happens when the last acquirer
 * releases.
 */

/** @typedef {import("bun:sqlite").Database} Database */
/** @typedef {{ sqlite: Database; refs: number; realClose: (...args: unknown[]) => unknown }} RegistryEntry */

// pnpm workspaces plus Bun's module graph can evaluate this module more than
// once in a single process (a different resolved specifier for `@smthrs/db`
// yields a separate module instance). A module-scoped Map would then hand out
// one connection per copy and reintroduce exactly the wedge above, so anchor
// the table on a well-known global symbol instead.
const REGISTRY_SYMBOL = Symbol.for("@smthrs/db/sqliteConnectionRegistry");

/** @returns {Map<string, RegistryEntry>} */
function getRegistry() {
  const host = /** @type {Record<symbol, unknown>} */ (globalThis);
  let registry = /** @type {Map<string, RegistryEntry> | undefined} */ (host[REGISTRY_SYMBOL]);
  if (!registry) {
    registry = new Map();
    Object.defineProperty(host, REGISTRY_SYMBOL, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: registry,
    });
  }
  return registry;
}

/**
 * The registry key for a filename, or `null` when the database must NOT be
 * shared. In-memory databases are private per connection — `:memory:` opened
 * twice is two unrelated databases, and sharing them would silently merge
 * unrelated state. A `file:` URI can request the same thing through query
 * parameters, so those are left unshared rather than parsed.
 *
 * @param {unknown} filename
 * @returns {string | null}
 */
export function sqliteShareKey(filename) {
  if (typeof filename !== "string") return null;
  const trimmed = filename.trim();
  if (trimmed === "" || trimmed === ":memory:") return null;
  if (trimmed.startsWith("file:")) return null;
  return resolve(trimmed);
}

/**
 * Whether a registry entry may still be handed to a new acquirer for `key`.
 * Two ways it goes stale in a long-lived process:
 *
 *  - the file was deleted and a caller now wants a *new* database at the same
 *    path (test suites delete their temp db between cases). Handing back the
 *    connection to the deleted inode would silently write to a ghost file.
 *  - the handle was closed out from under the registry (`Database.prototype.close`
 *    called directly, bypassing the refcounted override).
 *
 * Either way the entry is evicted; the existing owner keeps its handle and its
 * own release path, so eviction never closes a connection someone still holds.
 *
 * @param {string} key
 * @param {RegistryEntry} entry
 * @returns {boolean}
 */
function isEntryReusable(key, entry) {
  if (!existsSync(key)) return false;
  try {
    entry.sqlite.run("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the process's connection for `filename`, opening it if this is the
 * first acquirer. The returned handle is a normal `bun:sqlite` Database whose
 * `close()` releases one reference; the real close runs at zero. Each acquire
 * must therefore be paired with exactly ONE close — every wrapper around this
 * function makes its own `close()`/`cleanup()` idempotent so a caller that
 * closes twice cannot drop a reference it does not own.
 *
 * `configure` runs ONLY when this call actually opens the connection, for two
 * reasons. Re-applying a later acquirer's pragmas would silently reconfigure a
 * connection an earlier owner is already using (a read path's
 * `wal_autocheckpoint = 0`, a probe's deliberately short `busy_timeout`), and
 * `journal_mode` cannot be set at all while any holder has a transaction open.
 * Callers therefore keep their pragma set narrow enough to be a safe baseline
 * for whoever comes second.
 *
 * @param {string} filename
 * @param {{ configure?: (sqlite: Database) => void }} [opts]
 * @returns {Database}
 */
export function acquireSqliteConnection(filename, opts = {}) {
  const Database = loadBunSqliteDatabase();
  const key = sqliteShareKey(filename);
  if (key === null) {
    const sqlite = new Database(filename);
    opts.configure?.(sqlite);
    return sqlite;
  }

  const registry = getRegistry();
  const existing = registry.get(key);
  if (existing) {
    if (isEntryReusable(key, existing)) {
      existing.refs += 1;
      return existing.sqlite;
    }
    registry.delete(key);
  }

  const sqlite = new Database(filename);
  /** @type {RegistryEntry} */
  const entry = {
    sqlite,
    refs: 1,
    realClose: (...args) => Database.prototype.close.apply(sqlite, /** @type {[]} */ (args)),
  };
  Object.defineProperty(sqlite, "close", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: (...args) => releaseEntry(key, entry, args),
  });
  registry.set(key, entry);
  try {
    opts.configure?.(sqlite);
  } catch (error) {
    entry.refs = 1;
    sqlite.close();
    throw error;
  }
  return sqlite;
}

/**
 * @param {string} key
 * @param {RegistryEntry} entry
 * @param {unknown[]} args
 */
function releaseEntry(key, entry, args) {
  // A holder that closes twice must not release someone else's reference, and
  // must not re-close an already-closed handle. Callers pair one acquire with
  // one release; anything past zero is a no-op.
  if (entry.refs <= 0) return undefined;
  entry.refs -= 1;
  if (entry.refs > 0) return undefined;
  entry.refs = 0;
  const registry = getRegistry();
  if (registry.get(key) === entry) registry.delete(key);
  return entry.realClose(...args);
}

/**
 * Live reference count for a database file. Diagnostics and regression tests
 * only — production code should acquire and release instead.
 *
 * @param {string} filename
 * @returns {number}
 */
export function sqliteConnectionRefCount(filename) {
  const key = sqliteShareKey(filename);
  if (key === null) return 0;
  return getRegistry().get(key)?.refs ?? 0;
}
