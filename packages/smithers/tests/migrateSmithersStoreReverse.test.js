import { describe, expect, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSnapshot } from "@smthrs/time-travel/snapshot";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { migrateSmithersStore } from "../src/migrateSmithersStore.js";
import { openSmithersBackend } from "../src/openSmithersBackend.js";
import { createSmithersPostgres } from "../src/create.js";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  chunkedTest,
  listSourceTables,
  closeApi,
  makeWorkspace,
  quoteId,
  seedPgliteStore,
  seedPgliteStoreWithReceipt,
  seedSqliteStore,
  sqliteRunIds,
  tableCount,
} from "./migrateStoreKit.js";

setDefaultTimeout(120_000);

describe("migrateSmithersStore reverse and inference", () => {
  chunkedTest(
    "copies a PGlite Smithers store back to SQLite row-for-row and writes both receipts after verification",
    async () => {
      const cwd = makeWorkspace("smithers-migrate-pglite-to-sqlite");
      const originalSqlite = await seedPgliteStore(cwd);
      rmSync(originalSqlite, { force: true });
      expect(existsSync(originalSqlite)).toBe(false);
      expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
      expect(existsSync(join(cwd, ".smithers", "backend.json"))).toBe(false);

      const result = await migrateSmithersStore({ cwd, from: "pglite", to: "sqlite" });

      expect(result.backend).toBe("sqlite");
      expect(result.source.backend).toBe("pglite");
      expect(result.runCount).toBe(1);
      expect(existsSync(join(cwd, "smithers.db"))).toBe(true);
      expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(true);
      expect(JSON.parse(await Bun.file(join(cwd, ".smithers", "backend.json")).text())).toMatchObject({
        backend: "sqlite",
      });
      expect(sqliteRunIds(join(cwd, "smithers.db"))).toEqual(["run-migrate-1"]);
      const marker = JSON.parse(readFileSync(join(cwd, ".smithers", "migrated.json"), "utf8"));
      expect(marker.source).toMatchObject({ backend: "pglite", dataDir: join(cwd, ".smithers", "pg") });
      expect(marker.source.dbPath).toBeUndefined();

      const writableSqlite = new Database(join(cwd, "smithers.db"));
      try {
        const tableDdl = writableSqlite
          .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_smithers_runs'")
          .get().sql;
        expect(tableDdl).toContain("PRIMARY KEY");
        const primaryKeyColumns = writableSqlite
          .query("PRAGMA table_info(_smithers_runs)")
          .all()
          .filter((row) => Number(row.pk) > 0)
          .map((row) => row.name);
        expect(primaryKeyColumns).toEqual(["run_id"]);
        const indexCount = writableSqlite.query("PRAGMA index_list(_smithers_runs)").all().length;
        expect(indexCount).toBeGreaterThan(0);
        expect(writableSqlite.query("SELECT ref_count FROM _smithers_snapshot_contents").get().ref_count).toBe(1);
        expect(writableSqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_payload_refs").get().count).toBe(
          1,
        );
        expect(() => {
          writableSqlite
            .query(
              "INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms) VALUES (?, ?, ?, ?, ?)",
            )
            .run("run-migrate-1", "dup", "dup.tsx", "finished", 99);
        }).toThrow();
      } finally {
        writableSqlite.close();
      }

      // Open the PGlite source directly: the migrated SQLite store now sits
      // beside it, so the resolver correctly refuses to disambiguate.
      const sourceApi = await createSmithersPostgres({}, { provider: "pglite", dataDir: join(cwd, ".smithers", "pg") });
      try {
        const sqlite = new Database(join(cwd, "smithers.db"), { readonly: true });
        try {
          const tables = listSourceTables(sqlite);
          for (const table of tables) {
            const sourceCount = await tableCount(sourceApi.db.connection, table);
            const targetCount = sqlite.query(`SELECT COUNT(*) AS count FROM ${quoteId(table)}`).get().count;
            expect({ table, targetCount }).toEqual({ table, targetCount: sourceCount });
          }
        } finally {
          sqlite.close();
        }
      } finally {
        await closeApi(sourceApi);
      }
    },
    300_000,
  );

  chunkedTest("does not provision an existing-but-uninitialized pglite store while inferring --from", async () => {
    const cwd = makeWorkspace("smithers-migrate-pglite-probe-no-provision");
    const pgliteDir = join(cwd, ".smithers", "pg");
    mkdirSync(pgliteDir, { recursive: true });

    let caught;
    try {
      await migrateSmithersStore({ cwd, to: "pglite" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.code).toBe("CLI_DB_NOT_FOUND");
    // The probe must never boot/ensureSchema the candidate store: no cluster
    // files should appear in a dataDir it only inspected.
    expect(existsSync(join(pgliteDir, "PG_VERSION"))).toBe(false);
  });

  chunkedTest("refuses to migrate from an uninitialized pglite source without provisioning it", async () => {
    const cwd = makeWorkspace("smithers-migrate-pglite-source-no-provision");
    const pgliteDir = join(cwd, ".smithers", "pg");
    mkdirSync(pgliteDir, { recursive: true });

    let caught;
    try {
      await migrateSmithersStore({ cwd, from: "pglite", to: "sqlite" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.code).toBe("CLI_DB_NOT_FOUND");
    expect(existsSync(join(pgliteDir, "PG_VERSION"))).toBe(false);
  });

  chunkedTest(
    "infers --from when exactly one backend store has runs and refuses ambiguous populated stores",
    async () => {
      const pgliteOnly = makeWorkspace("smithers-migrate-infer-pglite");
      const originalSqlite = await seedPgliteStore(pgliteOnly);
      rmSync(originalSqlite, { force: true });

      const inferred = await migrateSmithersStore({ cwd: pgliteOnly, to: "sqlite" });
      expect(inferred.source.backend).toBe("pglite");
      expect(sqliteRunIds(join(pgliteOnly, "smithers.db"))).toEqual(["run-migrate-1"]);

      const ambiguous = makeWorkspace("smithers-migrate-ambiguous");
      await seedPgliteStore(ambiguous);
      await expect(migrateSmithersStore({ cwd: ambiguous, to: "sqlite" })).rejects.toMatchObject({
        code: "SMITHERS_BACKEND_CONFLICT",
      });
    },
  );

  // The migrated.json receipt is the AUTHORITY on the current backend after a
  // prior migration. Reverse-inference (`migrate --to sqlite` with no --from)
  // must trust it over leftover stores on disk, instead of misreading the
  // source as sqlite and failing with "source and target are both sqlite".
  chunkedTest(
    "reverse-infers pglite->sqlite from the migrated.json receipt when --from is omitted",
    async () => {
      const cwd = makeWorkspace("smithers-migrate-receipt-reverse");
      await seedPgliteStoreWithReceipt(cwd, { keepSqlite: false });
      expect(existsSync(join(cwd, "smithers.db"))).toBe(false);
      const receipt = JSON.parse(readFileSync(join(cwd, ".smithers", "migrated.json"), "utf8"));
      expect(receipt.target.backend).toBe("pglite");

      const result = await migrateSmithersStore({ cwd, to: "sqlite" });

      expect(result.source.backend).toBe("pglite");
      expect(result.backend).toBe("sqlite");
      expect(result.runCount).toBe(1);
      expect(existsSync(join(cwd, "smithers.db"))).toBe(true);
      expect(sqliteRunIds(join(cwd, "smithers.db"))).toEqual(["run-migrate-1"]);
    },
    300_000,
  );

  chunkedTest("honors the migrated.json receipt even when a leftover sqlite store still exists", async () => {
    const cwd = makeWorkspace("smithers-migrate-receipt-leftover-sqlite");
    await seedPgliteStoreWithReceipt(cwd, { keepSqlite: false });
    // A populated leftover sqlite store from before the migration is still on
    // disk at the nested path. Without the receipt, the run-count heuristic
    // sees two populated backends (nested sqlite + pglite) and refuses with
    // SMITHERS_BACKEND_CONFLICT. The receipt resolves it to pglite.
    seedSqliteStore(cwd, join(cwd, ".smithers", "smithers.db"));

    const result = await migrateSmithersStore({ cwd, to: "sqlite" });

    expect(result.source.backend).toBe("pglite");
    expect(result.backend).toBe("sqlite");
    expect(sqliteRunIds(join(cwd, "smithers.db"))).toEqual(["run-migrate-1"]);
  });

  chunkedTest("falls back to the run-count heuristic when there is NO migrated.json receipt", async () => {
    const single = makeWorkspace("smithers-migrate-receipt-absent-single");
    await seedPgliteStoreWithReceipt(single, { keepSqlite: false });
    rmSync(join(single, ".smithers", "migrated.json"), { force: true });
    rmSync(join(single, ".smithers", "backend.json"), { force: true });
    expect(existsSync(join(single, ".smithers", "migrated.json"))).toBe(false);

    const result = await migrateSmithersStore({ cwd: single, to: "sqlite" });
    expect(result.source.backend).toBe("pglite");
    expect(sqliteRunIds(join(single, "smithers.db"))).toEqual(["run-migrate-1"]);

    // And with no receipt, two populated stores stay genuinely ambiguous.
    const ambiguous = makeWorkspace("smithers-migrate-receipt-absent-ambiguous");
    await seedPgliteStoreWithReceipt(ambiguous, { keepSqlite: true });
    rmSync(join(ambiguous, ".smithers", "migrated.json"), { force: true });
    rmSync(join(ambiguous, ".smithers", "backend.json"), { force: true });
    await expect(migrateSmithersStore({ cwd: ambiguous, to: "sqlite" })).rejects.toMatchObject({
      code: "SMITHERS_BACKEND_CONFLICT",
    });
  });

  chunkedTest("a receipt whose current backend equals the target still fires the clear both-X guard", async () => {
    const cwd = makeWorkspace("smithers-migrate-receipt-equals-target");
    // Real round-trip: sqlite->pglite (receipt -> pglite), then pglite->sqlite
    // (inferred from that receipt) leaves a receipt whose target.backend is now
    // sqlite. Re-running `migrate --to sqlite` must hit the clear guard.
    await seedPgliteStoreWithReceipt(cwd, { keepSqlite: false });
    await migrateSmithersStore({ cwd, to: "sqlite" });
    const receipt = JSON.parse(readFileSync(join(cwd, ".smithers", "migrated.json"), "utf8"));
    expect(receipt.target.backend).toBe("sqlite");

    let caught;
    try {
      await migrateSmithersStore({ cwd, to: "sqlite" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.code).toBe("INVALID_INPUT");
    expect(caught.message).toContain("both sqlite");
  });

  chunkedTest("refuses to merge into a non-empty SQLite target and does not write receipts", async () => {
    const cwd = makeWorkspace("smithers-migrate-nonempty-sqlite-target");
    const sourceDbPath = await seedPgliteStore(cwd);
    rmSync(join(cwd, ".smithers", "migrated.json"), { force: true });
    rmSync(join(cwd, ".smithers", "backend.json"), { force: true });
    seedSqliteStore(cwd, sourceDbPath);

    await expect(migrateSmithersStore({ cwd, from: "pglite", to: "sqlite" })).rejects.toMatchObject({
      code: "DB_WRITE_FAILED",
    });
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
    expect(existsSync(join(cwd, ".smithers", "backend.json"))).toBe(false);
  });

  chunkedTest("deterministic migration failures include agent fallback guidance and keep receipts absent", async () => {
    const cwd = makeWorkspace("smithers-migrate-agent-guidance");
    await seedPgliteStore(cwd);
    rmSync(join(cwd, ".smithers", "migrated.json"), { force: true });
    rmSync(join(cwd, ".smithers", "backend.json"), { force: true });
    seedSqliteStore(cwd, join(cwd, "smithers.db"));

    let caught;
    try {
      await migrateSmithersStore({ cwd, from: "pglite", to: "sqlite" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SmithersError);
    // DB_WRITE_FAILED (target already has data) must NOT suggest retrying the
    // same command — the guard would fire again. It must instead tell the
    // operator to inspect or remove the conflicting target.
    expect(caught.message).not.toContain("smithers migrate --from pglite --to sqlite");
    expect(caught.message).toContain("Agent-assisted repair is tracked as a follow-up");
    expect(caught.message).not.toContain("is not defined");
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
    expect(existsSync(join(cwd, ".smithers", "backend.json"))).toBe(false);
  });

  chunkedTest(
    "forward sqlite to pglite failures include agent fallback guidance and keep receipts absent",
    async () => {
      const cwd = makeWorkspace("smithers-migrate-forward-agent-guidance");
      const targetApi = await openSmithersBackend({}, { cwd, backend: "pglite", env: {} });
      try {
        await targetApi.db.connection.query({
          text: "INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms) VALUES ($1, $2, $3, $4, $5)",
          values: ["target-run", "existing", "existing.tsx", "finished", 1],
        });
      } finally {
        await closeApi(targetApi);
      }
      seedSqliteStore(cwd);

      let caught;
      try {
        await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite" });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SmithersError);
      // DB_WRITE_FAILED (target pglite already has rows) must NOT suggest retrying
      // the same command — the guard would fire again.
      expect(caught.message).not.toContain("smithers migrate --from sqlite --to pglite");
      expect(caught.message).toContain("Agent-assisted repair is tracked as a follow-up");
      expect(caught.message).not.toContain("is not defined");
      expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
      expect(existsSync(join(cwd, ".smithers", "backend.json"))).toBe(false);
    },
  );
});
