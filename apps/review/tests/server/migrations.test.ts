import { describe, expect, test } from "bun:test";
import type { D1Database, D1PreparedStatement, D1Result } from "../../src/server/d1.ts";
import { ensureSchema } from "../../src/server/migrations.ts";
import { sqliteD1 } from "./helpers/sqliteD1.ts";

/**
 * Wrap a real sqlite-backed D1 but make every ALTER TABLE ... run() throw the
 * given message. Fault-injection against the real migration path (not a data
 * mock): the CREATE TABLEs still run, only the additive ALTERs fail.
 */
function alterFailingD1(message: string): D1Database {
  const base = sqliteD1();
  const failing: D1PreparedStatement = {
    bind: () => failing,
    first: async () => null,
    all: (async () => ({ results: [], success: true, meta: {} }) as D1Result) as D1PreparedStatement["all"],
    run: async () => {
      throw new Error(message);
    },
  };
  return {
    prepare: (query: string) => (/ALTER TABLE/i.test(query) ? failing : base.prepare(query)),
    exec: (query: string) => base.exec(query),
  };
}

describe("ensureSchema", () => {
  test("is idempotent and creates the cache-token columns on usage_events", async () => {
    const db = sqliteD1();
    // First run creates everything; a second run (fresh wrapper, so the
    // per-instance guard does not short-circuit) re-runs the ALTERs and must
    // swallow their duplicate-column errors.
    await ensureSchema(db);
    await ensureSchema({ prepare: (q: string) => db.prepare(q), exec: (q: string) => db.exec(q) });
    // Both cache columns exist: inserting them round-trips.
    await db
      .prepare(
        "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("u1", "octo/widgets", 1, "claude-sonnet-4-6", 10, 5, 200, 4000, 0.001, "messages", Date.now())
      .run();
    const row = await db.prepare("SELECT cache_creation_tokens, cache_read_tokens FROM usage_events").first<{
      cache_creation_tokens: number;
      cache_read_tokens: number;
    }>();
    expect(row?.cache_creation_tokens).toBe(200);
    expect(row?.cache_read_tokens).toBe(4000);
  });

  test("swallows a genuine duplicate-column ALTER error", async () => {
    await expect(ensureSchema(alterFailingD1("SQLITE_ERROR: duplicate column name: quiz"))).resolves.toBeUndefined();
  });

  test("propagates a non-duplicate ALTER failure instead of masking it as migrated", async () => {
    await expect(ensureSchema(alterFailingD1("D1_ERROR: database is locked"))).rejects.toThrow("database is locked");
  });
});
