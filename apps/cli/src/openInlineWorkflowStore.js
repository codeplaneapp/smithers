import { resolve } from "node:path";
import { SmithersError } from "@smithers-orchestrator/errors";
import { readBackendMarkerForCwd } from "./readBackendMarkerForCwd.js";

/** @param {string} cwd @param {Record<string, import("zod").ZodTypeAny>} schemas */
export async function openInlineWorkflowStore(cwd, schemas) {
  const [{ Database }, { drizzle }, { sqliteTable, text }, { zodToTable }, { syncZodTableSchema }, { camelToSnake }] =
    await Promise.all([
      import("bun:sqlite"),
      import("drizzle-orm/bun-sqlite"),
      import("drizzle-orm/sqlite-core"),
      import("@smithers-orchestrator/db/zodToTable"),
      import("@smithers-orchestrator/db/zodToCreateTableSQL"),
      import("@smithers-orchestrator/db/utils/camelToSnake"),
    ]);
  const { findSmithersAnchorDir } = await import("smithers-orchestrator/findSmithersAnchorDir");
  const anchorDir = findSmithersAnchorDir(cwd);
  const backend = readBackendMarkerForCwd(cwd);
  if (backend && backend !== "sqlite")
    throw new SmithersError(
      "BACKEND_MISMATCH",
      `This workspace's store is ${backend}, but inline workflows currently support only sqlite.`,
    );
  const sqlite = new Database(resolve(anchorDir ?? cwd, "smithers.db"));
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA busy_timeout = 30000");
  sqlite.run("PRAGMA synchronous = NORMAL");
  sqlite.run("PRAGMA locking_mode = NORMAL");
  sqlite.run("PRAGMA foreign_keys = ON");
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
