/**
 * SqlError messages must stay diagnosable. `formatSqlErrorMessage`/`formatSqlCause`
 * turn an opaque "Failed to execute SQLite statement" into
 * "Failed to execute <dialect> <op>: <cause>; sql=<clipped statement>". These
 * tests pin that shape (and the statement clip) so a refactor can't silently
 * regress the message back to something un-actionable. The Postgres/PGlite twin
 * lives in db-postgres-dialect.test.js.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqlMessageStorage } from "../src/sql-message-storage.js";

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

describe("SqlError diagnostic message (SQLite)", () => {
  test("a failing statement surfaces the driver cause and the sql text", async () => {
    const storage = new SqlMessageStorage(new Database(":memory:"));
    await storage.ensureSchema();

    let caught;
    try {
      await storage.queryAll("SELECT * FROM __missing_table__");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    const message = messageOf(caught);
    expect(message).toMatch(/Failed to execute SQLite statement: .+; sql=.+/);
    expect(message).toContain("no such table");
    expect(message).toContain("sql=SELECT * FROM __missing_table__");
  });

  test("an overlong statement is collapsed and clipped in the sql= suffix", async () => {
    const storage = new SqlMessageStorage(new Database(":memory:"));
    await storage.ensureSchema();

    const longPredicate = Array.from({ length: 200 }, (_, i) => `col_${i} = ${i}`).join("   OR   ");

    let caught;
    try {
      await storage.queryAll(`SELECT *\n  FROM __missing_table__\n  WHERE ${longPredicate}`);
    } catch (error) {
      caught = error;
    }

    const message = messageOf(caught);
    const sql = message.slice(message.indexOf("sql=") + "sql=".length);
    // formatSqlErrorMessage collapses whitespace and clips to 497 chars + "...".
    expect(sql.length).toBeLessThanOrEqual(500);
    expect(sql.endsWith("...")).toBe(true);
    expect(sql).not.toContain("\n");
    expect(sql).not.toContain("   ");
  });
});
