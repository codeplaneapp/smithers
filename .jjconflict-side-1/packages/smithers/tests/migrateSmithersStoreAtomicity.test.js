import { describe, expect, setDefaultTimeout } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createSmithersPostgres } from "../src/create.js";
import { migrateSmithersStore } from "../src/migrateSmithersStore.js";
import { chunkedTest, closeApi, makeWorkspace, seedSqliteStore, tableCount } from "./migrateStoreKit.js";

setDefaultTimeout(120_000);

async function openPgliteTarget(cwd) {
  return createSmithersPostgres({}, { provider: "pglite", dataDir: join(cwd, ".smithers", "pg") });
}

describe("migrateSmithersStore atomic target writes", () => {
  chunkedTest("rolls back a late PGlite insert failure so the migration can be retried", async () => {
    const cwd = makeWorkspace("smithers-migrate-pglite-atomic");
    seedSqliteStore(cwd);

    const target = await openPgliteTarget(cwd);
    try {
      await target.db.connection.query({
        text: `ALTER TABLE "_smithers_nodes" ADD CONSTRAINT "reject_migration_node" CHECK (run_id <> 'run-migrate-1')`,
      });
    } finally {
      await closeApi(target);
    }

    await expect(migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", env: {} }))
      .rejects.toThrow("reject_migration_node");

    const rolledBack = await openPgliteTarget(cwd);
    try {
      expect(await tableCount(rolledBack.db.connection, "_smithers_runs")).toBe(0);
      await rolledBack.db.connection.query({
        text: `ALTER TABLE "_smithers_nodes" DROP CONSTRAINT "reject_migration_node"`,
      });
    } finally {
      await closeApi(rolledBack);
    }
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);

    const result = await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", env: {} });
    expect(result.runCount).toBe(1);
  });

  chunkedTest("rolls back when a table-copied progress callback throws so the same command can retry", async () => {
    const cwd = makeWorkspace("smithers-migrate-progress-atomic");
    seedSqliteStore(cwd);
    let failProgress = true;
    const options = {
      cwd,
      from: "sqlite",
      to: "pglite",
      env: {},
      onProgress(event) {
        if (failProgress && event.type === "table-copied" && event.table === "_smithers_runs") {
          failProgress = false;
          throw new Error("forced table progress failure");
        }
      },
    };

    await expect(migrateSmithersStore(options)).rejects.toThrow("forced table progress failure");

    const rolledBack = await openPgliteTarget(cwd);
    try {
      expect(await tableCount(rolledBack.db.connection, "_smithers_runs")).toBe(0);
    } finally {
      await closeApi(rolledBack);
    }
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);

    const result = await migrateSmithersStore(options);
    expect(result.runCount).toBe(1);
  });
});
