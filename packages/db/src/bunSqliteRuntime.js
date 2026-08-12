import { createRequire } from "node:module";
import { SmithersError } from "@smthrs/errors/SmithersError";

/**
 * `bun:sqlite` and `drizzle-orm/bun-sqlite` exist only under Bun. A static
 * import of either aborts the entire module graph under plain Node with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME, so every consumer fails to load, including
 * workflows on the pglite and postgres backends that never open a sqlite file.
 *
 * Resolve both through `createRequire` instead. The specifier is looked up when
 * a sqlite code path actually runs, which keeps the synchronous call signatures
 * `createSmithers` and the migration reader depend on, and a Node process that
 * never asks for sqlite never touches them.
 */
const requireFromDb = createRequire(import.meta.url);

const SQLITE_NEEDS_BUN = [
  "The sqlite backend requires Bun. `bun:sqlite` is a Bun built-in with no Node equivalent.",
  "Run the same command under Bun, or select a backend that runs on Node:",
  "  SMITHERS_BACKEND=pglite    embedded Postgres, no server to start",
  "  SMITHERS_BACKEND=postgres  with DATABASE_URL set",
  'The CLI accepts the same choice as `--backend pglite`, and smithers.config.ts as `backend: "pglite"`.',
].join("\n");

/**
 * @param {string} specifier
 * @returns {never}
 */
function throwSqliteNeedsBun(specifier) {
  throw new SmithersError("DB_REQUIRES_BUN_SQLITE", SQLITE_NEEDS_BUN, { specifier, runtime: "node" });
}

/** @type {typeof import("bun:sqlite").Database | undefined} */
let cachedDatabase;

/**
 * The `bun:sqlite` Database constructor. Throws an actionable SmithersError
 * when the caller is not running under Bun.
 *
 * @returns {typeof import("bun:sqlite").Database}
 */
export function loadBunSqliteDatabase() {
  if (cachedDatabase) return cachedDatabase;
  if (typeof Bun === "undefined") throwSqliteNeedsBun("bun:sqlite");
  cachedDatabase = requireFromDb("bun:sqlite").Database;
  return /** @type {typeof import("bun:sqlite").Database} */ (cachedDatabase);
}

/** @type {typeof import("drizzle-orm/bun-sqlite").drizzle | undefined} */
let cachedDrizzle;

/**
 * Drizzle's `bun:sqlite` driver. Throws an actionable SmithersError when the
 * caller is not running under Bun.
 *
 * @returns {typeof import("drizzle-orm/bun-sqlite").drizzle}
 */
export function loadBunSqliteDrizzle() {
  if (cachedDrizzle) return cachedDrizzle;
  if (typeof Bun === "undefined") throwSqliteNeedsBun("drizzle-orm/bun-sqlite");
  cachedDrizzle = requireFromDb("drizzle-orm/bun-sqlite").drizzle;
  return /** @type {typeof import("drizzle-orm/bun-sqlite").drizzle} */ (cachedDrizzle);
}
