import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SqlMessageStorage } from "../src/sql-message-storage.js";

const MODULE_URL = new URL("../src/sql-message-storage.js", import.meta.url).href;

/** A minimal Cloudflare/external SQLite descriptor (no bun:sqlite involved). */
function externalDescriptor() {
  return {
    dialect: "sqlite",
    driver: "cloudflare-sqlite",
    queryAllRaw: async () => [],
    queryValuesRaw: async () => [],
    execute: async () => {},
    transaction: async (/** @type {() => unknown} */ op) => op(),
  };
}

describe("resolveSqliteDatabase (via SqlMessageStorage constructor)", () => {
  test("a raw bun:sqlite Database resolves to itself", () => {
    const raw = new Database(":memory:");
    const storage = new SqlMessageStorage(raw);
    expect(storage.driverKind).toBe("bun-sqlite");
    expect(storage.sqlite).toBe(raw);
  });

  test("a Drizzle BunSQLiteDatabase resolves to its underlying client", () => {
    const raw = new Database(":memory:");
    const storage = new SqlMessageStorage(drizzle(raw));
    expect(storage.driverKind).toBe("bun-sqlite");
    expect(storage.sqlite).toBe(raw);
  });

  test("an empty object throws (no query/run)", () => {
    expect(() => new SqlMessageStorage(/** @type {any} */ ({}))).toThrow(/requires a Bun SQLite client/);
  });

  test("a wrapper whose client lacks query/run throws", () => {
    expect(() => new SqlMessageStorage(/** @type {any} */ ({ $client: {} }))).toThrow(/requires a Bun SQLite client/);
  });

  test("an external/cloudflare-sqlite descriptor bypasses bun:sqlite entirely", () => {
    const storage = new SqlMessageStorage(/** @type {any} */ (externalDescriptor()));
    expect(storage.driverKind).toBe("cloudflare-sqlite");
    expect(storage.sqlite).toBeNull();
  });
});

describe("isolate-load regression", () => {
  // Node lacks bun:sqlite, exactly like a Cloudflare Workers / Vercel Edge V8
  // isolate. Before the bun:sqlite import chain was de-static-ized (the static
  // `import { Database } from "bun:sqlite"` in sql-message-storage.js AND the
  // transitive `drizzle-orm/bun-sqlite` import in schema-migrations.js), this
  // module threw "protocol 'bun:'" at load — so the whole db package could not
  // load on an isolate even on the cloudflare-sqlite path. This guards that.
  test("sql-message-storage.js loads + runs the cloudflare-sqlite path under plain node", () => {
    const node = Bun.which("node");
    if (!node) return; // CI clean box ships node; skip only where genuinely absent.
    const code = `
      const { SqlMessageStorage } = await import(${JSON.stringify(MODULE_URL)});
      const s = new SqlMessageStorage({
        dialect: "sqlite", driver: "cloudflare-sqlite",
        queryAllRaw: async () => [], queryValuesRaw: async () => [],
        execute: async () => {}, transaction: async (op) => op(),
      });
      if (s.driverKind !== "cloudflare-sqlite") { console.error("wrong driverKind", s.driverKind); process.exit(2); }
    `;
    const proc = Bun.spawnSync([node, "--input-type=module", "-e", code], { stderr: "pipe", stdout: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(
        `node import of sql-message-storage.js failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`,
      );
    }
    expect(proc.exitCode).toBe(0);
  });
});
