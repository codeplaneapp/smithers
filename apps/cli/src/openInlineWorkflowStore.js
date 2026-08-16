import { resolve } from "node:path";
import { SmithersError } from "@smthrs/errors";

/** @param {string} cwd @param {Record<string, import("zod").ZodTypeAny>} schemas */
export async function openInlineWorkflowStore(cwd, schemas) {
  const [
    { acquireSqliteConnection },
    { drizzle },
    { sqliteTable, text },
    { zodToTable },
    { syncZodTableSchema },
    { camelToSnake },
  ] = await Promise.all([
    import("@smthrs/db/sqliteConnectionRegistry"),
    import("drizzle-orm/bun-sqlite"),
    import("drizzle-orm/sqlite-core"),
    import("@smthrs/db/zodToTable"),
    import("@smthrs/db/zodToCreateTableSQL"),
    import("@smthrs/db/utils/camelToSnake"),
  ]);
  const { findSmithersAnchorDir } = await import("smthrs/findSmithersAnchorDir");
  const { resolveSmithersBackendPreference } = await import("smthrs/resolveSmithersBackendChoice");
  const anchorDir = findSmithersAnchorDir(cwd);
  // Ask the shared resolver, not a marker file. Reading `.smithers/migrated.json`
  // directly used to override `--backend sqlite`, `SMITHERS_BACKEND=sqlite`, and
  // a `backend` field in smithers.config.ts, so once a workspace had ever been
  // migrated to pglite there was no way to run an inline workflow in it at all
  // and `smithers oneshot` was permanently unavailable there.
  const { backend, source } = await resolveSmithersBackendPreference({ cwd });
  if (backend !== "sqlite")
    throw new SmithersError(
      "BACKEND_MISMATCH",
      `This workspace's store is ${backend} (selected by ${source}), but inline workflows currently support only sqlite. ` +
        `Pin sqlite for this workspace to run inline workflows such as \`smithers oneshot\`: set SMITHERS_BACKEND=sqlite, ` +
        `add \`backend: "sqlite"\` to .smithers/smithers.config.ts, or write {"backend":"sqlite"} to .smithers/backend.json.`,
    );
  // One connection per database file per process; see `acquireSqliteConnection`.
  // An inline workflow runs inside a CLI process that may already hold this
  // store open (`smithers up`, the gateway), and a second synchronous handle
  // would block the event loop for the whole busy_timeout on first contention.
  const sqlite = acquireSqliteConnection(resolve(anchorDir ?? cwd, "smithers.db"), {
    configure: (connection) => {
      connection.run("PRAGMA busy_timeout = 30000");
      connection.run("PRAGMA journal_mode = WAL");
      connection.run("PRAGMA synchronous = NORMAL");
      connection.run("PRAGMA locking_mode = NORMAL");
      connection.run("PRAGMA foreign_keys = ON");
    },
  });
  sqlite.exec(`CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`);
  const inputTable = sqliteTable("input", {
    runId: text("run_id").primaryKey(),
    payload: text("payload", { mode: "json" }).$type(),
  });
  const registry = {};
  const schemaRegistry = new Map();
  const zodToKeyName = new Map();
  for (const [key, schema] of Object.entries(schemas)) {
    const tableName = camelToSnake(key);
    const table = zodToTable(tableName, schema);
    syncZodTableSchema(sqlite, tableName, schema);
    registry[key] = table;
    schemaRegistry.set(key, { table, zodSchema: schema });
    zodToKeyName.set(schema, key);
  }
  return { db: drizzle(sqlite, { schema: { input: inputTable, ...registry } }), schemaRegistry, zodToKeyName };
}
