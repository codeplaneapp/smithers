import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createSmithers } from "../src/create.js";
import { migrateSmithersStore } from "../src/migrateSmithersStore.js";

setDefaultTimeout(120_000);

/** @type {string[]} */
const tempDirs = [];

function makeWorkspace(name) {
  const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, ".smithers"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function seedSqliteStore(cwd, dbPath = join(cwd, "smithers.db")) {
  const api = createSmithers(
    {
      input: z.object({ prompt: z.string().nullable() }),
      result: z.object({ value: z.number().int(), ok: z.boolean() }),
    },
    { dbPath, backend: "sqlite" },
  );
  ensureSmithersTables(api.db);
  const sqlite = api.db.$client;
  sqlite.exec(`
    INSERT INTO input (run_id, prompt) VALUES ('run-migrate-1', 'hello');
    INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms, started_at_ms, finished_at_ms)
      VALUES ('run-migrate-1', 'migration-fixture', '.smithers/workflows/migration-fixture.tsx', 'finished', 10, 11, 20);
    INSERT INTO result (run_id, node_id, iteration, value, ok)
      VALUES ('run-migrate-1', 'write-result', 0, 42, 1);
  `);
  sqlite.close();
  return dbPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migrateSmithersStore — reachable guard branches", () => {
  test("rejects an unknown --to backend with INVALID_INPUT", async () => {
    const cwd = makeWorkspace("migrate-bad-backend");
    await expect(migrateSmithersStore({ cwd, to: "mysql", env: {} })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("rejects an unknown --from backend with INVALID_INPUT", async () => {
    const cwd = makeWorkspace("migrate-bad-from");
    await expect(migrateSmithersStore({ cwd, from: "mongodb", to: "pglite", env: {} })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  test("defaults the target to sqlite when --to is omitted and rejects same source/target", async () => {
    const cwd = makeWorkspace("migrate-default-target");
    seedSqliteStore(cwd);
    // No `to`: normalizeBackend(undefined, "sqlite") returns the "sqlite"
    // fallback, the source infers to sqlite, and the both-sqlite guard fires.
    await expect(migrateSmithersStore({ cwd, env: {} })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("rejects a forward migration when the SQLite source file is missing", async () => {
    const cwd = makeWorkspace("migrate-missing-source");
    await expect(migrateSmithersStore({ cwd, to: "pglite", env: {} })).rejects.toMatchObject({
      code: "CLI_DB_NOT_FOUND",
    });
  });

  test("reverse migration refuses to overwrite an unrelated file at the target path", async () => {
    const cwd = makeWorkspace("migrate-reverse-junk-target");
    // Build a real PGlite store (removing the sqlite source) so the reverse
    // migration has run history to copy.
    seedSqliteStore(cwd);
    await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", keepSqlite: false, env: {} });
    // Put an unrelated (non-Smithers) file where smithers.db would be published.
    writeFileSync(join(cwd, "smithers.db"), "not a sqlite database", "utf8");
    rmSync(join(cwd, ".smithers", "migrated.json"), { force: true });
    rmSync(join(cwd, ".smithers", "backend.json"), { force: true });
    await expect(migrateSmithersStore({ cwd, from: "pglite", to: "sqlite", env: {} })).rejects.toMatchObject({
      code: "DB_WRITE_FAILED",
    });
  });

  test("reverse inference ignores a malformed migrated.json receipt and falls back to run counts", async () => {
    const cwd = makeWorkspace("migrate-malformed-receipt");
    seedSqliteStore(cwd);
    await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", keepSqlite: false, env: {} });
    // Corrupt the receipt: readReceiptCurrentBackend must swallow the JSON parse
    // error and fall back to the run-count heuristic (which finds only pglite).
    writeFileSync(join(cwd, ".smithers", "migrated.json"), "{ this is not json", "utf8");
    const result = await migrateSmithersStore({ cwd, to: "sqlite", env: {} });
    expect(result.source.backend).toBe("pglite");
    expect(existsSync(join(cwd, "smithers.db"))).toBe(true);
  });

  test("reverse inference ignores a receipt with an empty target backend", async () => {
    const cwd = makeWorkspace("migrate-empty-receipt-backend");
    seedSqliteStore(cwd);
    await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", keepSqlite: false, env: {} });
    writeFileSync(join(cwd, ".smithers", "migrated.json"), JSON.stringify({ target: { backend: "" } }), "utf8");
    const result = await migrateSmithersStore({ cwd, to: "sqlite", env: {} });
    expect(result.source.backend).toBe("pglite");
  });

  test("source inference tolerates an unreachable postgres url and falls back to sqlite", async () => {
    const cwd = makeWorkspace("migrate-infer-bad-pg-url");
    // No stores anywhere. With `from` omitted, inference probes postgres via the
    // supplied url; the connection is refused, the probe swallows it (returns 0),
    // and inference falls back to sqlite — which is then reported missing.
    await expect(
      migrateSmithersStore({
        cwd,
        to: "pglite",
        url: "postgres://postgres@127.0.0.1:1/nope",
        env: {},
      }),
    ).rejects.toMatchObject({ code: "CLI_DB_NOT_FOUND" });
  });

  test("reverse migration with a leftover populated sqlite + malformed receipt refuses to merge", async () => {
    const cwd = makeWorkspace("migrate-reverse-leftover-sqlite");
    seedSqliteStore(cwd);
    // keepSqlite:true leaves the populated smithers.db on disk beside the pglite
    // store. A malformed receipt means readReceiptSource returns undefined, so the
    // reverse migration cannot prove smithers.db was the forward source and refuses
    // to overwrite it.
    await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", keepSqlite: true, env: {} });
    writeFileSync(join(cwd, ".smithers", "migrated.json"), "@@ not json @@", "utf8");
    await expect(migrateSmithersStore({ cwd, from: "pglite", to: "sqlite", env: {} })).rejects.toMatchObject({
      code: "DB_WRITE_FAILED",
    });
  });
});
