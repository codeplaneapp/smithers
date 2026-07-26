import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { createSmithersPostgres } from "../src/create.js";
import { acquireSharedPostgresPool, sharedPostgresPoolCount } from "../src/sharedPostgresPool.js";

setDefaultTimeout(120_000);

// Real Postgres only. `SMITHERS_TEST_PG_URL` is the same admin URL the CLI's
// postgres round-trip e2e uses; without it these assertions cannot be made
// against a live server, so they report as skipped rather than passing vacuously.
const PG_URL = process.env.SMITHERS_TEST_PG_URL;
const pgTest = PG_URL ? test : test.skip;

/** @type {Array<() => Promise<void>>} */
const cleanups = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => {});
  }
});

function quoteId(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

async function loadPg() {
  const module = await import("pg");
  return module.default ?? module;
}

/**
 * Run `fn` against a throwaway database so parallel suites never share schema
 * or connection budget.
 * @param {(url: string) => Promise<void>} fn
 */
async function withTempPostgresDatabase(fn) {
  const pg = await loadPg();
  const database = `smithers_pool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quoteId(database)}`);
  await admin.end();

  const url = new URL(PG_URL);
  url.pathname = `/${database}`;
  try {
    return await fn(url.toString());
  } finally {
    const cleanup = new pg.Client({ connectionString: PG_URL });
    await cleanup.connect();
    await cleanup
      .query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [
        database,
      ])
      .catch(() => {});
    await cleanup.query(`DROP DATABASE IF EXISTS ${quoteId(database)}`).catch(() => {});
    await cleanup.end().catch(() => {});
  }
}

/**
 * Backend sessions Postgres currently holds for `database`. This is the number
 * that issue #1368 watched climb once per workflow registration.
 * @param {string} database
 */
async function backendSessionCount(database) {
  const pg = await loadPg();
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    return rows[0].sessions;
  } finally {
    await admin.end().catch(() => {});
  }
}

pgTest("many workflow registrations against one URL stay inside one bounded pool", async () => {
  await withTempPostgresDatabase(async (connectionString) => {
    const database = new URL(connectionString).pathname.slice(1);
    const schemas = { result: z.object({ ok: z.boolean() }) };

    const backends = [];
    for (let i = 0; i < 6; i += 1) {
      backends.push(
        await createSmithersPostgres(schemas, { provider: "postgres", connectionString, postgresPoolMax: 4 }),
      );
    }
    cleanups.push(async () => {
      for (const backend of backends) await backend.close().catch(() => {});
    });

    // Six registrations, one pool. Pre-fix this held one session per backend
    // and grew without bound as the Gateway registered more workflows.
    expect(sharedPostgresPoolCount()).toBe(1);
    await Promise.all(backends.map((backend) => backend.db.connection.query({ text: "SELECT 1" })));
    expect(await backendSessionCount(database)).toBeLessThanOrEqual(4);

    // Every owner but the last releasing keeps the pool usable.
    for (const backend of backends.slice(0, -1)) await backend.close();
    expect(sharedPostgresPoolCount()).toBe(1);
    const { rows } = await backends.at(-1).db.connection.query({ text: "SELECT 42 AS answer" });
    expect(rows[0].answer).toBe(42);

    // The final owner closes the pool and drops every server session.
    await backends.at(-1).close();
    expect(sharedPostgresPoolCount()).toBe(0);
    expect(await backendSessionCount(database)).toBe(0);
  });
});

pgTest("a real transaction stays pinned to one connection while pooled queries run beside it", async () => {
  await withTempPostgresDatabase(async (connectionString) => {
    const first = await acquireSharedPostgresPool({ pg: await loadPg(), connectionString, max: 4 });
    const second = await acquireSharedPostgresPool({ pg: await loadPg(), connectionString, max: 4 });
    cleanups.push(() => first.close());
    cleanups.push(() => second.close());
    expect(sharedPostgresPoolCount()).toBe(1);

    await first.connection.query({ text: "CREATE TABLE pinned (id int primary key)" });
    await first.connection.query({ text: "BEGIN" });
    await first.connection.query({ text: "INSERT INTO pinned (id) VALUES (1)" });

    // A pooled read from the other owner takes a different connection, so the
    // uncommitted row must not be visible to it.
    const duringTx = await second.connection.query({ text: "SELECT count(*)::int AS n FROM pinned" });
    expect(duringTx.rows[0].n).toBe(0);

    await first.connection.query({ text: "COMMIT" });
    const afterTx = await second.connection.query({ text: "SELECT count(*)::int AS n FROM pinned" });
    expect(afterTx.rows[0].n).toBe(1);

    // Closing mid-transaction rolls back rather than stranding the client.
    await first.connection.query({ text: "BEGIN" });
    await first.connection.query({ text: "INSERT INTO pinned (id) VALUES (2)" });
    await first.close();
    const afterClose = await second.connection.query({ text: "SELECT count(*)::int AS n FROM pinned" });
    expect(afterClose.rows[0].n).toBe(1);
    await second.close();
    expect(sharedPostgresPoolCount()).toBe(0);
  });
});

pgTest("a saturated real pool raises PG_POOL_SATURATED naming the cap and the knob", async () => {
  await withTempPostgresDatabase(async (connectionString) => {
    const pg = await loadPg();
    const options = { pg, connectionString, max: 2, acquireTimeoutMs: 300 };
    // Two owners each pin a connection in an open transaction, which is exactly
    // the leaked/stuck-query shape the error message calls out.
    const holders = [await acquireSharedPostgresPool(options), await acquireSharedPostgresPool(options)];
    const starved = await acquireSharedPostgresPool(options);
    cleanups.push(async () => {
      for (const lease of [starved, ...holders]) await lease.close().catch(() => {});
    });
    for (const holder of holders) await holder.connection.query({ text: "BEGIN" });

    const error = await starved.connection.query({ text: "SELECT 1" }).catch((caught) => caught);
    expect(error.code).toBe("PG_POOL_SATURATED");
    expect(error.message).toContain("all 2 connections");
    expect(error.message).toContain("SMITHERS_POSTGRES_POOL_MAX=4");
    expect(error.message).toContain("postgresPoolMax: 4");
    expect(error.details).toMatchObject({ max: 2, idleCount: 0, configKnob: "SMITHERS_POSTGRES_POOL_MAX" });

    // Releasing one pin makes the pool serviceable again without a restart.
    await holders[0].close();
    const { rows } = await starved.connection.query({ text: "SELECT 7 AS answer" });
    expect(rows[0].answer).toBe(7);

    await holders[1].close();
    await starved.close();
    expect(sharedPostgresPoolCount()).toBe(0);
  });
});

pgTest("distinct databases on one server keep separate pools", async () => {
  await withTempPostgresDatabase(async (firstUrl) => {
    await withTempPostgresDatabase(async (secondUrl) => {
      const pg = await loadPg();
      const first = await acquireSharedPostgresPool({ pg, connectionString: firstUrl, max: 2 });
      const second = await acquireSharedPostgresPool({ pg, connectionString: secondUrl, max: 2 });
      cleanups.push(() => first.close());
      cleanups.push(() => second.close());

      expect(first.identity).not.toBe(second.identity);
      expect(sharedPostgresPoolCount()).toBe(2);

      await first.connection.query({ text: "CREATE TABLE only_here (id int)" });
      await expect(second.connection.query({ text: "SELECT * FROM only_here" })).rejects.toThrow();

      await first.close();
      expect(sharedPostgresPoolCount()).toBe(1);
      await second.close();
      expect(sharedPostgresPoolCount()).toBe(0);
    });
  });
});
