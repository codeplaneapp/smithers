import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDurableSqliteDatabase } from "@smthrs/db/openDurableSqliteDatabase";
import { acquireSqliteConnection, sqliteConnectionRefCount, sqliteShareKey } from "@smthrs/db/sqliteConnectionRegistry";

/** @type {(() => void)[]} */
const cleanups = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // best-effort teardown
    }
  }
});

function makeDbPath(name) {
  const dir = mkdtempSync(join(tmpdir(), `smithers-registry-${name}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "smithers.db");
}

describe("sqlite connection registry", () => {
  test("a second in-process open of the same file reuses one connection", () => {
    const dbPath = makeDbPath("share");
    const first = openDurableSqliteDatabase(dbPath);
    cleanups.push(first.close);
    const second = openDurableSqliteDatabase(dbPath);
    cleanups.push(second.close);

    expect(second.db.$client).toBe(first.db.$client);
    expect(sqliteConnectionRefCount(dbPath)).toBe(2);
  });

  test("a write from a second opener does not wedge on the first opener's transaction", async () => {
    // Regression test for issue #1577. `bun:sqlite` is synchronous: with two
    // connections on one file, a write issued while the other connection holds
    // the WAL write lock blocks the whole event loop inside sqlite3_step for the
    // entire 30s busy_timeout. Nothing can run during that block -- including
    // the continuation that would COMMIT and release the lock -- so the wait
    // always runs to timeout and fails with SQLITE_BUSY / SQLITE_PROTOCOL,
    // taking every timer, lease heartbeat and HTTP handler down with it.
    const dbPath = makeDbPath("wedge");
    const writer = openDurableSqliteDatabase(dbPath);
    cleanups.push(writer.close);
    const writerClient = writer.db.$client;
    writerClient.run(`CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)`);

    // A second component opens the same store while the first holds a write
    // transaction open across an await, exactly as the gateway's detached
    // recovery/poller jobs do against a running workflow's database.
    writerClient.run("BEGIN IMMEDIATE");
    writerClient.run(`INSERT OR REPLACE INTO t VALUES ('held', '1')`);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = openDurableSqliteDatabase(dbPath);
    cleanups.push(second.close);
    const startedAt = Date.now();
    second.db.$client.run(`INSERT OR REPLACE INTO t VALUES ('other', '2')`);
    const elapsedMs = Date.now() - startedAt;
    writerClient.run("COMMIT");

    // With two connections this took the full busy_timeout (30_000ms) and then
    // threw; with one shared connection the write simply joins the open turn.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(writerClient.query(`SELECT v FROM t WHERE k = 'other'`).get()?.v).toBe("2");
  });

  test("close is refcounted: the file closes only when the last holder releases", () => {
    const dbPath = makeDbPath("refcount");
    const first = openDurableSqliteDatabase(dbPath);
    const second = openDurableSqliteDatabase(dbPath);
    const client = first.db.$client;
    client.run(`CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY)`);

    first.close();
    expect(sqliteConnectionRefCount(dbPath)).toBe(1);
    // Still usable: the underlying sqlite3 handle must not have been closed.
    expect(() => client.run(`INSERT OR REPLACE INTO t VALUES ('a')`)).not.toThrow();

    second.close();
    expect(sqliteConnectionRefCount(dbPath)).toBe(0);
    expect(() => client.run(`SELECT 1`)).toThrow();
  });

  test("a repeated close from one holder cannot close the file under another", () => {
    const dbPath = makeDbPath("double-close");
    const first = openDurableSqliteDatabase(dbPath);
    const second = openDurableSqliteDatabase(dbPath);
    cleanups.push(second.close);

    // Each acquire pairs with exactly one release; every wrapper around the
    // registry makes its own `close()` idempotent, so a caller that closes
    // twice cannot drop a reference it does not own.
    first.close();
    first.close();
    expect(sqliteConnectionRefCount(dbPath)).toBe(1);
    expect(() => second.db.$client.run(`SELECT 1`)).not.toThrow();
  });

  test("in-memory databases are never shared", () => {
    expect(sqliteShareKey(":memory:")).toBeNull();
    expect(sqliteShareKey("")).toBeNull();
    expect(sqliteShareKey("file:x?mode=memory")).toBeNull();
    expect(sqliteShareKey("relative.db")).toBe(join(process.cwd(), "relative.db"));

    const first = acquireSqliteConnection(":memory:");
    const second = acquireSqliteConnection(":memory:");
    cleanups.push(() => first.close());
    cleanups.push(() => second.close());
    expect(second).not.toBe(first);
  });

  test("a database file deleted under the registry is not handed to the next opener", () => {
    const dbPath = makeDbPath("deleted");
    const first = openDurableSqliteDatabase(dbPath);
    cleanups.push(first.close);
    first.db.$client.run(`CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY)`);

    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    expect(existsSync(dbPath)).toBe(false);

    const second = openDurableSqliteDatabase(dbPath);
    cleanups.push(second.close);
    expect(second.db.$client).not.toBe(first.db.$client);
    // The evicted holder keeps a working handle; eviction must not close it.
    expect(() => first.db.$client.run(`SELECT 1`)).not.toThrow();
  });
});
