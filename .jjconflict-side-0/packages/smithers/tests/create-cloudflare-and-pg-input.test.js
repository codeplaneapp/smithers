import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSmithersCloudflare, createSmithersPostgres } from "../src/create.js";
import { createCloudflareDurableObjectSqliteDescriptor } from "../src/cloudflare.js";

setDefaultTimeout(60_000);

/** @type {Array<() => void | Promise<void>>} */
const cleanups = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

// A real in-memory SQLite database presented through the Cloudflare Durable
// Object `storage.sql` shape. This is a genuine SQLite backend (bun:sqlite),
// exercising createSmithersCloudflare + syncZodTableSchemaStorage end to end,
// not a stub of the code under test.
function createFakeDurableObjectStorage() {
  const sqlite = new Database(":memory:");
  return {
    sql: {
      exec(statement, ...params) {
        const returnsRows =
          /^\s*(select|with|pragma|values)\b/i.test(statement) || /\breturning\b/i.test(statement);
        if (!returnsRows) {
          sqlite.run(statement, ...params);
          return { toArray: () => [], raw: () => [] };
        }
        const query = sqlite.query(statement);
        return { toArray: () => query.all(...params), raw: () => query.values(...params) };
      },
    },
    async transaction(operation) {
      sqlite.run("BEGIN IMMEDIATE");
      try {
        const result = await operation();
        sqlite.run("COMMIT");
        return result;
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    },
    close() {
      sqlite.close();
    },
  };
}

describe("createSmithersCloudflare", () => {
  test("throws when no Cloudflare descriptor is supplied", async () => {
    await expect(createSmithersCloudflare({ result: z.object({ ok: z.boolean() }) }, {})).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  test("provisions the default input payload column plus output tables and metadata", async () => {
    // No `input` schema: exercises the default input table + payload backfill
    // branch and the output-table metadata sync in syncZodTableSchemaStorage.
    const storage = createFakeDurableObjectStorage();
    cleanups.push(() => storage.close());
    const descriptor = createCloudflareDurableObjectSqliteDescriptor(storage);

    let closed = false;
    const api = await createSmithersCloudflare(
      { result: z.object({ value: z.string() }), review: z.object({ score: z.number() }) },
      { db: descriptor, close: () => { closed = true; } },
    );

    expect(Object.keys(api.tables).sort()).toEqual(["result", "review"]);
    expect(api.outputs.result).toBeDefined();

    // The physical output table and its metadata were created.
    const cols = storage.sql.exec('PRAGMA table_info("result")').toArray();
    expect(cols.some((c) => c.name === "value")).toBe(true);
    const meta = storage.sql
      .exec("SELECT table_name, column_name, kind FROM _smithers_output_schema_columns WHERE table_name = 'result'")
      .toArray();
    expect(meta.length).toBeGreaterThan(0);
    // The default input table exists and carries the payload column.
    const inputCols = storage.sql.exec('PRAGMA table_info("input")').toArray();
    expect(inputCols.some((c) => c.name === "payload")).toBe(true);

    expect(typeof api.close).toBe("function");
    await api.close();
    expect(closed).toBe(true);
  });

  test("uses the provided input schema and adds newly introduced columns", async () => {
    const storage = createFakeDurableObjectStorage();
    cleanups.push(() => storage.close());
    // Pre-create the input table missing a column the schema introduces, so the
    // ALTER TABLE ADD COLUMN reconciliation path in syncZodTableSchemaStorage runs.
    storage.sql.exec('CREATE TABLE "input" (run_id TEXT PRIMARY KEY)');

    const api = await createSmithersCloudflare(
      { input: z.object({ prompt: z.string(), retries: z.number() }), result: z.object({ ok: z.boolean() }) },
      { db: createCloudflareDurableObjectSqliteDescriptor(storage) },
    );

    const inputCols = storage.sql.exec('PRAGMA table_info("input")').toArray().map((c) => c.name);
    expect(inputCols).toContain("prompt");
    expect(inputCols).toContain("retries");
    // No close callback supplied => close is undefined.
    expect(api.close).toBeUndefined();
  });

  test("backfills the payload column onto a legacy default input table (run_id only)", async () => {
    const storage = createFakeDurableObjectStorage();
    cleanups.push(() => storage.close());
    // A legacy input table without payload + no input schema: the default-input
    // branch must detect the missing column and ALTER it in.
    storage.sql.exec('CREATE TABLE "input" (run_id TEXT PRIMARY KEY)');

    const api = await createSmithersCloudflare(
      { result: z.object({ ok: z.boolean() }) },
      { db: createCloudflareDurableObjectSqliteDescriptor(storage) },
    );

    const inputCols = storage.sql.exec('PRAGMA table_info("input")').toArray().map((c) => c.name);
    expect(inputCols).toContain("payload");
    expect(typeof api.tables).toBe("object");
  });

  test("skips column reconciliation when the table_info probe fails mid-sync", async () => {
    // A Durable Object storage whose PRAGMA table_info on the output table
    // fails (e.g. an older SQLite): provisioning must degrade to skipping the
    // ADD COLUMN reconciliation rather than crashing the whole boot.
    const inner = createFakeDurableObjectStorage();
    cleanups.push(() => inner.close());
    const storage = {
      sql: {
        exec(statement, ...params) {
          if (/PRAGMA\s+table_info\("result"\)/i.test(statement)) {
            throw new Error("PRAGMA unsupported");
          }
          return inner.sql.exec(statement, ...params);
        },
      },
      transaction: inner.transaction.bind(inner),
    };

    const api = await createSmithersCloudflare(
      { result: z.object({ value: z.string() }) },
      { db: createCloudflareDurableObjectSqliteDescriptor(storage) },
    );
    // The output table itself was still created before the probe failure.
    expect(Object.keys(api.tables)).toContain("result");
    const cols = inner.sql.exec('PRAGMA table_info("result")').toArray();
    expect(cols.length).toBeGreaterThan(0);
  });
});

describe("createSmithersPostgres input table reconciliation", () => {
  test("adds the payload column to a legacy input table that only has run_id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-pg-input-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dataDir = join(dir, "pg");

    // Seed a legacy `input` table with ONLY run_id (no payload) directly in the
    // PGlite data dir, then boot createSmithersPostgres with no input schema so
    // it backfills the payload column.
    const { PGlite } = await import("@electric-sql/pglite");
    const seed = await PGlite.create(dataDir);
    await seed.exec('CREATE TABLE "input" (run_id TEXT PRIMARY KEY)');
    await seed.close();

    const api = await createSmithersPostgres({ result: z.object({ ok: z.boolean() }) }, { provider: "pglite", dataDir });
    try {
      const cols = await api.db.connection.query({
        text: "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'input'",
      });
      const names = cols.rows.map((r) => r.column_name);
      expect(names).toContain("run_id");
      expect(names).toContain("payload");
    } finally {
      await api.close();
    }
  });

  test("drains the socket server and client teardown when schema provisioning fails after connect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-pg-fail-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dataDir = join(dir, "pg");

    // Seed a VIEW named like the output table. The PGlite socket server and pg
    // client both boot and register teardown, then the output-table ALTER fails
    // because a view is not a base table — exercising the catch that drains the
    // registered teardown (server stop + client end) before rethrowing.
    const { PGlite } = await import("@electric-sql/pglite");
    const seed = await PGlite.create(dataDir);
    await seed.exec("CREATE VIEW result AS SELECT 1 AS value");
    await seed.close();

    await expect(
      createSmithersPostgres({ result: z.object({ value: z.string(), extra: z.number() }) }, { provider: "pglite", dataDir }),
    ).rejects.toThrow(/ADD COLUMN|result/);

    // The port was released by the teardown drain, so a fresh PGlite can reopen
    // the same data dir without a lingering socket server holding it.
    const reopen = await PGlite.create(dataDir);
    await reopen.close();
  });
});
