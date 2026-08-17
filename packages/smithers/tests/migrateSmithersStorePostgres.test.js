import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { forkRun, getBranchInfo, listBranches } from "@smthrs/time-travel/fork";
import { createSmithers } from "../src/create.js";
import { migrateSmithersStore } from "../src/migrateSmithersStore.js";
import { openSmithersBackend } from "../src/openSmithersBackend.js";
import { createSmithersPostgres } from "../src/create.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  chunkedTest,
  assertRowForRowEquality,
  sourceColumns,
  assertSqlitePrimaryKeyAndDuplicateRejection,
  closeApi,
  makeWorkspace,
  PG_URL,
  seedPgliteStore,
  seedSqliteStore,
  sqliteRunIds,
  tableCount,
  withTempPostgresDatabase,
} from "./migrateStoreKit.js";

setDefaultTimeout(120_000);

const postgresTest = (name, fn, timeoutOrOptions) => {
  if (!PG_URL) {
    test.skip(name, fn, timeoutOrOptions);
    return;
  }
  chunkedTest(name, fn, timeoutOrOptions);
};

describe("migrateSmithersStore real postgres", () => {
  postgresTest("copies a SQLite Smithers store to real Postgres row-for-row", async () => {
    await withTempPostgresDatabase("smithers_migrate_sqlite_pg", async (url) => {
      const cwd = makeWorkspace("smithers-migrate-sqlite-postgres");
      const dbPath = seedSqliteStore(cwd);

      const result = await migrateSmithersStore({ cwd, from: "sqlite", to: "postgres", url, env: {} });

      expect(result.backend).toBe("postgres");
      expect(result.source.backend).toBe("sqlite");
      expect(result.target).toMatchObject({ backend: "postgres", url: "set" });
      expect(result.runCount).toBe(1);
      expect(result.schemaVersion).toBe("0044");
      expect(existsSync(result.markerPath)).toBe(true);

      const api = await openSmithersBackend({}, { cwd, backend: "postgres", connectionString: url, env: {} });
      try {
        await assertRowForRowEquality(dbPath, api.db.connection);
        expect(await tableCount(api.db.connection, "_smithers_runs")).toBe(1);
      } finally {
        await closeApi(api);
      }
    });
  });

  postgresTest("copies a real Postgres Smithers store back to SQLite with keys and indexes", async () => {
    await withTempPostgresDatabase("smithers_migrate_pg_sqlite", async (url) => {
      const cwd = makeWorkspace("smithers-migrate-postgres-sqlite");
      seedSqliteStore(cwd);
      await migrateSmithersStore({ cwd, from: "sqlite", to: "postgres", url, env: {} });
      rmSync(join(cwd, "smithers.db"), { force: true });
      rmSync(join(cwd, ".smithers", "migrated.json"), { force: true });
      rmSync(join(cwd, ".smithers", "backend.json"), { force: true });

      const result = await migrateSmithersStore({ cwd, from: "postgres", to: "sqlite", url, env: {} });

      expect(result.backend).toBe("sqlite");
      expect(result.source).toMatchObject({ backend: "postgres", url: "set" });
      expect(result.runCount).toBe(1);
      expect(sqliteRunIds(join(cwd, "smithers.db"))).toEqual(["run-migrate-1"]);
      assertSqlitePrimaryKeyAndDuplicateRejection(join(cwd, "smithers.db"));
    });
  });

  postgresTest("copies a PGlite Smithers store to real Postgres row-for-row", async () => {
    await withTempPostgresDatabase("smithers_migrate_pglite_pg", async (url) => {
      const cwd = makeWorkspace("smithers-migrate-pglite-postgres");
      const sqliteSourcePath = await seedPgliteStore(cwd);

      const result = await migrateSmithersStore({
        cwd,
        from: "sqlite",
        to: "postgres",
        url,
        dbPath: sqliteSourcePath,
        env: {},
      });

      expect(result.backend).toBe("postgres");
      expect(result.source.backend).toBe("sqlite");

      // Open both comparison stores directly (not via the resolver): this
      // workspace deliberately keeps an unmarked SQLite store beside the PGlite
      // one, so resolveSmithersBackendChoice correctly refuses to disambiguate.
      // The migrate path itself opens stores this way (createSmithersPostgres).
      const sourceApi = await createSmithersPostgres({}, { provider: "pglite", dataDir: join(cwd, ".smithers", "pg") });
      const targetApi = await createSmithersPostgres({}, { provider: "postgres", connectionString: url });
      try {
        const tables = await sourceApi.db.connection.query({
          text: "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name",
        });
        for (const row of tables.rows) {
          const table = row.table_name;
          const sourceCount = await tableCount(sourceApi.db.connection, table);
          const targetCount = await tableCount(targetApi.db.connection, table);
          expect({ table, targetCount }).toEqual({ table, targetCount: sourceCount });
        }
      } finally {
        await closeApi(targetApi);
        await closeApi(sourceApi);
      }
    });
  });
});
