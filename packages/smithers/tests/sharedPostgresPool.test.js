import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireSharedPostgresPool,
  normalizePostgresConnectionIdentity,
  redactPostgresIdentity,
  resolvePostgresAcquireTimeoutMs,
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
    this.pool.checkedOut -= 1;
    this.pool.drainPending();
  }
}

/**
 * A pool that honors `max` and `connectionTimeoutMillis` the way node-postgres
 * does, including its exact queue-timeout message, so saturation handling is
 * exercised without a live server.
 */
class FakePool {
  constructor(options) {
    this.options = options;
    this.queries = [];
    this.clients = [];
    this.pending = [];
    this.checkedOut = 0;
    this.ended = 0;
    this.failText = null;
    this.listeners = new Map();
    pools.push(this);
  }

  get totalCount() {
    return this.clients.length;
  }

  get idleCount() {
    return Math.max(0, this.clients.length - this.checkedOut);
  }

  get waitingCount() {
    return this.pending.length;
  }

  on(event, handler) {
    this.listeners.set(event, handler);
  }

  drainPending() {
    while (this.pending.length && this.checkedOut < this.options.max) {
      const waiter = this.pending.shift();
      clearTimeout(waiter.timer);
      this.checkedOut += 1;
      const client = new FakeClient(this);
      this.clients.push(client);
      waiter.resolve(client);
    }
  }

  async query(query) {
    const client = await this.connect();
    try {
      this.queries.push({ target: "pool", query });
      if (this.failText === query.text) throw new Error(`failed ${query.text}`);
      return { rows: [] };
    } finally {
      client.release();
    }
  }

  async connect() {
    if (this.checkedOut < this.options.max) {
      this.checkedOut += 1;
      const client = new FakeClient(this);
      this.clients.push(client);
      return client;
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve };
      waiter.timer = setTimeout(() => {
        this.pending = this.pending.filter((item) => item !== waiter);
        // node-postgres' verbatim message for an acquire that outlived
        // connectionTimeoutMillis waiting on the pool queue.
        reject(new Error("timeout exceeded when trying to connect"));
      }, this.options.connectionTimeoutMillis ?? 10_000);
      this.pending.push(waiter);
    });
  }

  async end() {
    this.ended += 1;
  }
}

const pg = {
  Pool: FakePool,
  types: { getTypeParser: () => (value) => value },
};

const url =
  "postgresql://USER:secret@EXAMPLE.test:5432/smithers?application_name=gateway&password=query-secret&sslmode=require";

afterEach(async () => {
  // Every test must release its own leases; this guard catches a regression in
  // cleanup paths before state can leak into the next lifecycle assertion.
  expect(sharedPostgresPoolCount()).toBe(0);
  pools.splice(0);
});

describe("shared PostgreSQL pools", () => {
  test("normalizes equivalent URLs and shares one configured bounded pool", async () => {
    const first = await acquireSharedPostgresPool({ pg, connectionString: url, max: 3 });
    const second = await acquireSharedPostgresPool({
      pg,
      connectionString:
        "postgres://USER:secret@example.test/smithers?sslmode=require&password=query-secret&application_name=gateway",
      max: 3,
    });

    expect(normalizePostgresConnectionIdentity(url)).toBe(
      normalizePostgresConnectionIdentity(
        "postgres://USER:secret@example.test/smithers?sslmode=require&password=query-secret&application_name=gateway",
      ),
    );
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
    const second = await acquireSharedPostgresPool({
      pg,
      connectionString: "postgres://USER:secret@example.test/other",
    });

    expect(pools).toHaveLength(2);
    await first.close();
    await second.close();
  });

  test("normalizes effective ports without folding case-sensitive Unix sockets", () => {
    const previousPort = process.env.PGPORT;
    try {
      process.env.PGPORT = "6543";
      expect(normalizePostgresConnectionIdentity("postgres://example.test/smithers")).not.toBe(
        normalizePostgresConnectionIdentity("postgres://example.test:5432/smithers"),
      );
      expect(normalizePostgresConnectionIdentity("postgres://%2Ftmp%2FPgSock/smithers")).not.toBe(
        normalizePostgresConnectionIdentity("postgres://%2Ftmp%2Fpgsock/smithers"),
      );

      delete process.env.PGPORT;
      expect(normalizePostgresConnectionIdentity("postgres://example.test/smithers")).toBe(
        normalizePostgresConnectionIdentity("postgres://example.test:5432/smithers"),
      );
    } finally {
      if (previousPort === undefined) delete process.env.PGPORT;
      else process.env.PGPORT = previousPort;
    }
  });

  test("defaults to sixteen, accepts an environment bound, and rejects conflicting owners", async () => {
    expect(resolvePostgresPoolMax(undefined, undefined)).toBe(16);
    expect(resolvePostgresPoolMax(undefined, "4")).toBe(4);
    expect(() => resolvePostgresPoolMax(undefined, "0")).toThrow(RangeError);

    const first = await acquireSharedPostgresPool({
      pg,
      connectionString: url,
      environment: { SMITHERS_POSTGRES_POOL_MAX: "4" },
    });
    expect(pools[0].options.max).toBe(4);
    await expect(acquireSharedPostgresPool({ pg, connectionString: url, max: 5 })).rejects.toThrow(/already has max 4/);
    await first.close();
  });

  test("uses an injected environment without leaking process pool settings", async () => {
    const previousMax = process.env.SMITHERS_POSTGRES_POOL_MAX;
    const previousTimeout = process.env.SMITHERS_POSTGRES_ACQUIRE_TIMEOUT_MS;
    process.env.SMITHERS_POSTGRES_POOL_MAX = "99";
    process.env.SMITHERS_POSTGRES_ACQUIRE_TIMEOUT_MS = "999";
    try {
      const lease = await acquireSharedPostgresPool({ pg, connectionString: url, environment: {} });
      expect(pools[0].options.max).toBe(16);
      expect(pools[0].options.connectionTimeoutMillis).toBe(10_000);
      await lease.close();
    } finally {
      if (previousMax === undefined) delete process.env.SMITHERS_POSTGRES_POOL_MAX;
      else process.env.SMITHERS_POSTGRES_POOL_MAX = previousMax;
      if (previousTimeout === undefined) delete process.env.SMITHERS_POSTGRES_ACQUIRE_TIMEOUT_MS;
      else process.env.SMITHERS_POSTGRES_ACQUIRE_TIMEOUT_MS = previousTimeout;
    }
  });

  test("bounds the acquire wait and never prints the password", async () => {
    expect(resolvePostgresAcquireTimeoutMs(undefined, undefined)).toBe(10_000);
    expect(resolvePostgresAcquireTimeoutMs(undefined, "250")).toBe(250);
    expect(() => resolvePostgresAcquireTimeoutMs(undefined, "0")).toThrow(RangeError);
    const redacted = redactPostgresIdentity(normalizePostgresConnectionIdentity(url));
    expect(redacted).toBe(
      "postgres://example.test:5432/smithers?application_name=gateway&password=***&sslmode=require",
    );
    expect(redacted).not.toContain("USER");
    expect(redacted).not.toContain("query-secret");

    const first = await acquireSharedPostgresPool({ pg, connectionString: url, max: 4 });
    expect(pools[0].options.connectionTimeoutMillis).toBe(10_000);
    const rejected = await acquireSharedPostgresPool({ pg, connectionString: url, max: 9 }).catch((error) => error);
    expect(rejected.message).not.toContain("secret");
    expect(rejected.message).not.toContain("USER");
    expect(rejected.message).toContain("postgres://example.test");
    await first.close();
  });

  test("saturating the cap fails with an actionable PG_POOL_SATURATED error", async () => {
    const lease = await acquireSharedPostgresPool({
      pg,
      connectionString: url,
      max: 2,
      acquireTimeoutMs: 25,
    });
    // Pin both pooled connections, then ask for a third.
    const held = [await pools[0].connect(), await pools[0].connect()];

    const error = await lease.connection.query({ text: "SELECT saturated" }).catch((caught) => caught);
    expect(error.code).toBe("PG_POOL_SATURATED");
    expect(error.message).toContain("all 2 connections");
    expect(error.message).toContain("SMITHERS_POSTGRES_POOL_MAX=4");
    expect(error.message).toContain("postgresPoolMax: 4");
    expect(error.message).toContain("2 open, 0 idle");
    // The identity is present but its URL credentials never are.
    expect(error.message).toContain("postgres://example.test");
    expect(error.message).not.toContain("USER");
    expect(error.message).not.toContain("secret");
    expect(error.details).toMatchObject({ max: 2, configKnob: "SMITHERS_POSTGRES_POOL_MAX" });

    // BEGIN takes the same bounded wait and the same typed failure.
    const beginError = await lease.connection.query({ text: "BEGIN" }).catch((caught) => caught);
    expect(beginError.code).toBe("PG_POOL_SATURATED");

    for (const client of held) client.release();
    await lease.close();
  });

  test("reports the default cap as the default in the saturation error", async () => {
    const lease = await acquireSharedPostgresPool({ pg, connectionString: url, acquireTimeoutMs: 25 });
    expect(pools[0].options.max).toBe(16);
    const held = [];
    for (let i = 0; i < 16; i += 1) held.push(await pools[0].connect());

    const error = await lease.connection.query({ text: "SELECT saturated" }).catch((caught) => caught);
    expect(error.code).toBe("PG_POOL_SATURATED");
    expect(error.message).toContain("all 16 connections (the default 16)");
    expect(error.message).toContain("SMITHERS_POSTGRES_POOL_MAX=32");

    for (const client of held) client.release();
    await lease.close();
  });

  test("survives an idle-client pool error instead of crashing the host process", async () => {
    const lease = await acquireSharedPostgresPool({ pg, connectionString: url, max: 2 });
    expect(typeof pools[0].listeners.get("error")).toBe("function");
    expect(() => pools[0].listeners.get("error")(new Error("terminating connection"))).not.toThrow();
    await lease.close();
  });

  test("rejects conflicting acquire waits for owners of one pool", async () => {
    const first = await acquireSharedPostgresPool({ pg, connectionString: url, max: 2, acquireTimeoutMs: 25 });
    const error = await acquireSharedPostgresPool({
      pg,
      connectionString: url,
      max: 2,
      acquireTimeoutMs: 50,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toContain("already has acquire timeout 25ms");
    expect(error.message).not.toContain("secret");
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
    // Every checked-out client went back to the pool: the first served the
    // non-transactional query, the second was the transaction pin.
    expect(pools[0].idleCount).toBe(pools[0].totalCount);
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
    expect(pools[0].idleCount).toBe(pools[0].totalCount);
    expect(pools[0].ended).toBe(1);
  });

  test("shutdown cannot strand a BEGIN waiting for a pooled client", async () => {
    const lease = await acquireSharedPostgresPool({
      pg,
      connectionString: url,
      max: 1,
      acquireTimeoutMs: 100,
    });
    const held = await pools[0].connect();
    const beginning = lease.connection.query({ text: "BEGIN" });
    await Promise.resolve();
    const nested = lease.connection.query({ text: "BEGIN" }).catch((error) => error);
    const closing = lease.close();

    held.release();

    await expect(beginning).rejects.toThrow("closed while beginning");
    expect((await nested).message).toContain("Nested PostgreSQL transactions");
    await closing;
    expect(pools[0].checkedOut).toBe(0);
    expect(pools[0].ended).toBe(1);
  });

  test("repeated close calls wait for the same in-flight transaction cleanup", async () => {
    const lease = await acquireSharedPostgresPool({ pg, connectionString: url });
    await lease.connection.query({ text: "BEGIN" });

    const firstClose = lease.close();
    const secondClose = lease.close();
    await Promise.all([firstClose, secondClose]);

    expect(pools[0].clients[0].released).toBe(1);
    expect(pools[0].ended).toBe(1);
  });

  test("shutdown waits for an in-flight transaction query before rollback", async () => {
    const lease = await acquireSharedPostgresPool({ pg, connectionString: url });
    await lease.connection.query({ text: "BEGIN" });
    const client = pools[0].clients[0];
    const queryClient = client.query.bind(client);
    let finishSlowQuery;
    const slowQueryGate = new Promise((resolve) => {
      finishSlowQuery = resolve;
    });
    client.query = async (query) => {
      if (query.text === "SELECT slow") await slowQueryGate;
      return queryClient(query);
    };

    const slowQuery = lease.connection.query({ text: "SELECT slow" });
    await Promise.resolve();
    let closeFinished = false;
    const closing = lease.close().then(() => {
      closeFinished = true;
    });
    await Promise.resolve();
    expect(closeFinished).toBe(false);

    finishSlowQuery();
    await slowQuery;
    await closing;
    expect(pools[0].queries.map(({ query }) => query.text)).toContain("ROLLBACK");
    expect(pools[0].checkedOut).toBe(0);
  });
});
