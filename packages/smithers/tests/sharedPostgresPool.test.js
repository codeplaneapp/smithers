import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireSharedPostgresPool,
  normalizePostgresConnectionIdentity,
  resolvePostgresPoolMax,
  sharedPostgresPoolCount,
} from "../src/sharedPostgresPool.js";

/** @type {FakePool[]} */
const pools = [];

class FakeClient {
  constructor(pool) {
    this.pool = pool;
    this.released = 0;
  }

  async query(query) {
    this.pool.queries.push({ target: "client", query });
    if (this.pool.failText === query.text) throw new Error(`failed ${query.text}`);
    return { rows: [] };
  }

  release() {
    this.released += 1;
  }
}

class FakePool {
  constructor(options) {
    this.options = options;
    this.queries = [];
    this.clients = [];
    this.ended = 0;
    this.failText = null;
    pools.push(this);
  }

  async query(query) {
    this.queries.push({ target: "pool", query });
    if (this.failText === query.text) throw new Error(`failed ${query.text}`);
    return { rows: [] };
  }

  async connect() {
    const client = new FakeClient(this);
    this.clients.push(client);
    return client;
  }

  async end() {
    this.ended += 1;
  }
}

const pg = {
  Pool: FakePool,
  types: { getTypeParser: () => (value) => value },
};

const url = "postgresql://USER:secret@EXAMPLE.test:5432/smithers?application_name=gateway&sslmode=require";

afterEach(async () => {
  // Every test must release its own leases; this guard catches a regression in
  // cleanup paths before state can leak into the next lifecycle assertion.
  expect(sharedPostgresPoolCount()).toBe(0);
  pools.splice(0);
});

describe("shared PostgreSQL pools", () => {
  test("normalizes equivalent URLs and shares one configured bounded pool", async () => {
    const first = await acquireSharedPostgresPool({ pg, connectionString: url, max: 3 });
    const second = await acquireSharedPostgresPool({ pg, connectionString: "postgres://USER:secret@example.test/smithers?sslmode=require&application_name=gateway", max: 3 });

    expect(normalizePostgresConnectionIdentity(url)).toBe(normalizePostgresConnectionIdentity("postgres://USER:secret@example.test/smithers?sslmode=require&application_name=gateway"));
    expect(pools).toHaveLength(1);
    expect(pools[0].options.max).toBe(3);
    expect(sharedPostgresPoolCount()).toBe(1);

    await first.close();
    expect(pools[0].ended).toBe(0);
    await second.close();
    expect(pools[0].ended).toBe(1);
  });

  test("isolates distinct normalized URLs", async () => {
    const first = await acquireSharedPostgresPool({ pg, connectionString: url });
    const second = await acquireSharedPostgresPool({ pg, connectionString: "postgres://USER:secret@example.test/other" });

    expect(pools).toHaveLength(2);
    await first.close();
    await second.close();
  });

  test("defaults to ten, accepts an environment bound, and rejects conflicting owners", async () => {
    expect(resolvePostgresPoolMax(undefined, undefined)).toBe(10);
    expect(resolvePostgresPoolMax(undefined, "4")).toBe(4);
    expect(() => resolvePostgresPoolMax(undefined, "0")).toThrow(RangeError);

    const first = await acquireSharedPostgresPool({ pg, connectionString: url, environmentMax: "4" });
    expect(pools[0].options.max).toBe(4);
    await expect(acquireSharedPostgresPool({ pg, connectionString: url, max: 5 })).rejects.toThrow(/already has max 4/);
    await first.close();
  });

  test("pins BEGIN through COMMIT to one client and returns non-transactional work to the pool", async () => {
    const lease = await acquireSharedPostgresPool({ pg, connectionString: url });
    await lease.connection.query({ text: "SELECT outside" });
    await lease.connection.query({ text: "BEGIN" });
    await lease.connection.query({ text: "SELECT inside" });
    await lease.connection.query({ text: "COMMIT" });

    expect(pools[0].queries.map(({ target, query }) => [target, query.text])).toEqual([
      ["pool", "SELECT outside"],
      ["client", "BEGIN"],
      ["client", "SELECT inside"],
      ["client", "COMMIT"],
    ]);
    expect(pools[0].clients[0].released).toBe(1);
    await lease.close();
  });

  test("releases transaction and pool ownership after query failure and close", async () => {
    const lease = await acquireSharedPostgresPool({ pg, connectionString: url });
    await lease.connection.query({ text: "BEGIN" });
    pools[0].failText = "SELECT fails";
    await expect(lease.connection.query({ text: "SELECT fails" })).rejects.toThrow("failed SELECT fails");

    await lease.close();
    expect(pools[0].queries.map(({ target, query }) => [target, query.text])).toContainEqual(["client", "ROLLBACK"]);
    expect(pools[0].clients[0].released).toBe(1);
    expect(pools[0].ended).toBe(1);
  });
});
