import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { createSmithersCloudflare } from "../src/create.js";
import { createCloudflareDurableObjectSqliteDescriptor } from "../src/cloudflare.js";

setDefaultTimeout(60_000);

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

// Real bun:sqlite behind the Durable Object `storage.sql` shape, with a thin
// interceptor that makes selected statements throw. This drives the best-effort
// `.catch(...)` swallow arrows in createSmithersCloudflare with a real backend.
function createThrowingDurableObjectStorage(shouldThrow) {
  const sqlite = new Database(":memory:");
  cleanups.push(() => {
    try {
      sqlite.close();
    } catch {
      /* already closed */
    }
  });
  return {
    sql: {
      exec(statement, ...params) {
        if (shouldThrow(statement)) {
          throw new Error(`intercepted: ${statement.slice(0, 40)}`);
        }
        const returnsRows = /^\s*(select|with|pragma|values)\b/i.test(statement) || /\breturning\b/i.test(statement);
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
  };
}

describe("createSmithersCloudflare — best-effort input-table reconciliation swallows failures", () => {
  test("tolerates a failing input table_info probe and a failing payload ALTER", async () => {
    // No `input` schema => the default-input branch runs. The PRAGMA probe on the
    // input table throws (queryAllRaw .catch(() => []) fires), so `hasPayload` is
    // false and the ADD COLUMN payload ALTER runs — which also throws and is
    // swallowed by its own .catch(() => {}). Boot must still succeed.
    const storage = createThrowingDurableObjectStorage(
      (stmt) =>
        /PRAGMA\s+table_info\("input"\)/i.test(stmt) || /ALTER\s+TABLE\s+"input"\s+ADD\s+COLUMN\s+payload/i.test(stmt),
    );
    const api = await createSmithersCloudflare(
      { result: z.object({ value: z.string() }) },
      { db: createCloudflareDurableObjectSqliteDescriptor(storage) },
    );
    expect(Object.keys(api.tables)).toContain("result");
  });

  test("tolerates a failing output-schema metadata insert and a failing output ALTER", async () => {
    // Pre-create the output table missing a column so syncZodTableSchemaStorage's
    // ADD COLUMN path runs; make both the metadata INSERT and the output-table
    // ALTER throw so the two best-effort catch blocks are exercised. Boot succeeds.
    const inner = createThrowingDurableObjectStorage(
      (stmt) =>
        /INSERT\s+INTO\s+_smithers_output_schema_columns/i.test(stmt) ||
        /ALTER\s+TABLE\s+"result"\s+ADD\s+COLUMN/i.test(stmt),
    );
    // Seed the result table with only run bookkeeping columns (missing `value`).
    inner.sql.exec('CREATE TABLE "result" (run_id TEXT)');
    const api = await createSmithersCloudflare(
      { result: z.object({ value: z.string() }) },
      { db: createCloudflareDurableObjectSqliteDescriptor(inner) },
    );
    expect(Object.keys(api.tables)).toContain("result");
  });
});
