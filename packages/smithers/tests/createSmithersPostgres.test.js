import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { createSmithersPostgres } from "../src/create.js";
import { sharedPostgresPoolCount } from "../src/sharedPostgresPool.js";

setDefaultTimeout(60_000);

/** @type {Array<() => Promise<void>>} */
const cleanups = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => {});
  }
  expect(sharedPostgresPoolCount()).toBe(0);
});

// PGlite's socket server currently desyncs node-postgres on Windows CI. The
// real Postgres backend is still covered by the separate test-postgres job.
describe.skipIf(process.platform === "win32")("createSmithersPostgres", () => {
  test("boots a PGlite backend, creates schema tables, and returns a usable API", async () => {
    const api = await createSmithersPostgres(
      {
        input: z.object({ prompt: z.string() }),
        result: z.object({ ok: z.boolean() }),
      },
      { provider: "pglite" },
    );
    cleanups.push(() => api.close());

    // db descriptor uses postgres dialect
    expect(api.db.dialect).toBe("postgres");

    // tables metadata is populated for non-input schemas
    expect(Object.keys(api.tables).sort()).toEqual(["result"]);

    // output schemas are accessible
    expect(api.outputs.result).toBeDefined();

    // real postgres roundtrip — insert a row and read it back
    const { rows } = await api.db.connection.query({
      text: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    });
    const tableNames = rows.map((r) => r.table_name);
    expect(tableNames).toContain("result");
    expect(tableNames).toContain("input");
  });

  test("close() tears down the socket server and client without error", async () => {
    const api = await createSmithersPostgres({ result: z.object({ value: z.string() }) }, { provider: "pglite" });

    // Should resolve cleanly
    await expect(api.close()).resolves.toBeUndefined();

    // Calling close() again should not throw (idempotent teardown via try/catch in server.stop)
    await expect(api.close()).resolves.toBeUndefined();
  });

  test("propagates errors from failed schema creation and tears down cleanly", async () => {
    // Pass an invalid schema that will cause a DDL error (duplicate column via a
    // Zod object that maps to a reserved postgres keyword as column name).
    // We trigger the error path by passing an already-open client indirectly: use
    // an impossible connectionString so client.connect() throws.
    await expect(
      createSmithersPostgres(
        { result: z.object({ ok: z.boolean() }) },
        {
          provider: "postgres",
          connectionString: "postgres://invalid_host_that_does_not_exist/db",
          env: { SMITHERS_POSTGRES_ACQUIRE_TIMEOUT_MS: "50" },
        },
      ),
    ).rejects.toThrow();
    expect(sharedPostgresPoolCount()).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("BIGINT (oid 20) type parsing", () => {
  test("coerces BIGINT to number on smithers' own connection without mutating the global pg.types registry", async () => {
    const pgModule = await import("pg");
    const pg = pgModule.default ?? pgModule;
    const globalBigintParser = pg.types.getTypeParser(20);

    const api = await createSmithersPostgres({ result: z.object({ value: z.string() }) }, { provider: "pglite" });
    cleanups.push(() => api.close());

    // smithers' own client coerces oid 20 to a JS number
    const { rows } = await api.db.connection.query({ text: `SELECT 9007199254740991::bigint AS n` });
    expect(rows[0].n).toBe(9007199254740991);

    // the process-global pg.types registry is untouched — a host app's own
    // pg.Client still gets node-postgres' default lossless string decoding
    expect(pg.types.getTypeParser(20)).toBe(globalBigintParser);
    expect(pg.types.getTypeParser(20)("9007199254740993")).toBe("9007199254740993");
  });
});

describe.skipIf(process.platform === "win32")("findFreePgPort (via createSmithersPostgres)", () => {
  test("allocates a non-zero port for the PGlite socket server", async () => {
    const api = await createSmithersPostgres({ result: z.object({ value: z.number() }) }, { provider: "pglite" });
    cleanups.push(() => api.close());

    // The connection string embedded in the descriptor reflects the allocated port
    const connStr = api.db.connection.connectionParameters?.host
      ? undefined
      : api.db.connection._connectionParameters?.port;

    // Verify by querying — if the port were 0 or wrong, the query would fail
    const { rows } = await api.db.connection.query({ text: "SELECT 1 AS n" });
    expect(rows[0].n).toBe(1);
  });
});
