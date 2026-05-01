import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeSqliteLock } from "./freezeSqliteLock";

interface TestCtx {
  dir: string;
  dbPath: string;
  victim: Database;
}

let ctx: TestCtx;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "freeze-sqlite-lock-"));
  const dbPath = join(dir, "test.db");
  const victim = new Database(dbPath);
  victim.exec("CREATE TABLE t (x INTEGER PRIMARY KEY)");
  victim.exec("INSERT INTO t VALUES (1)");
  ctx = { dir, dbPath, victim };
});

afterEach(() => {
  try {
    ctx.victim.close();
  } catch {}
  rmSync(ctx.dir, { recursive: true, force: true });
});

describe("freezeSqliteLock", () => {
  test("blocks victim writes with SQLITE_BUSY while frozen, then releases", async () => {
    const handle = await freezeSqliteLock(ctx.dbPath);

    let caught: unknown;
    try {
      ctx.victim.exec("INSERT INTO t VALUES (2)");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const message = (caught as Error).message ?? "";
    const code = (caught as { code?: string }).code;
    expect(code === "SQLITE_BUSY" || message.includes("database is locked")).toBe(true);

    await handle.release();
    expect(() => ctx.victim.exec("INSERT INTO t VALUES (3)")).not.toThrow();
  });

  test("auto-releases after durationMs", async () => {
    await freezeSqliteLock(ctx.dbPath, 50);

    expect(() => ctx.victim.exec("INSERT INTO t VALUES (10)")).toThrow();

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(() => ctx.victim.exec("INSERT INTO t VALUES (11)")).not.toThrow();
  });

  test("release is idempotent", async () => {
    const handle = await freezeSqliteLock(ctx.dbPath);
    await handle.release();
    await handle.release();
    expect(() => ctx.victim.exec("INSERT INTO t VALUES (20)")).not.toThrow();
  });
});
