import { describe, expect, test } from "bun:test";
import { SmithersDb } from "../src/adapter.js";
import { zodToTable } from "../src/zodToTable.js";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

/**
 * Build a SmithersDb backed by an in-memory sqlite db that contains a single
 * output table created from the given zod schema.
 *
 * @param {string} tableName
 * @param {z.ZodObject<any>} schema
 */
function createDbWithOutputTable(tableName, schema) {
    const table = zodToTable(tableName, schema);
    const sqlite = new Database(":memory:");
    sqlite.exec(zodToCreateTableSQL(tableName, schema));
    const db = drizzle(sqlite, { schema: { [tableName]: table } });
    return { adapter: new SmithersDb(db), table };
}

describe("getRawNodeOutput", () => {
    test("returns the row when node_id contains a single quote", async () => {
        const tableName = "out";
        const { adapter, table } = createDbWithOutputTable(tableName, z.object({ title: z.string() }));

        // A node_id with an apostrophe used to break the interpolated SQL
        // string and silently return null (via catchAll). The parameterized
        // query must handle it correctly.
        const runId = "run-1";
        const nodeId = "o'brien";

        await adapter.upsertOutputRow(table, { runId, nodeId, iteration: 0 }, { title: "hello" });

        const row = await adapter.getRawNodeOutput(tableName, runId, nodeId);

        expect(row).not.toBeNull();
        expect(row?.node_id).toBe(nodeId);
        expect(row?.run_id).toBe(runId);
        expect(row?.title).toBe("hello");
    });

    test("returns the row when run_id contains a single quote", async () => {
        const tableName = "out";
        const { adapter, table } = createDbWithOutputTable(tableName, z.object({ title: z.string() }));

        const runId = "run-o'malley";
        const nodeId = "n1";

        await adapter.upsertOutputRow(table, { runId, nodeId, iteration: 0 }, { title: "world" });

        const row = await adapter.getRawNodeOutput(tableName, runId, nodeId);

        expect(row).not.toBeNull();
        expect(row?.run_id).toBe(runId);
        expect(row?.title).toBe("world");
    });

    test("returns the latest iteration for a quoted node_id", async () => {
        const tableName = "out";
        const { adapter, table } = createDbWithOutputTable(tableName, z.object({ title: z.string() }));

        const runId = "run-1";
        const nodeId = "o'brien";

        await adapter.upsertOutputRow(table, { runId, nodeId, iteration: 0 }, { title: "first" });
        await adapter.upsertOutputRow(table, { runId, nodeId, iteration: 1 }, { title: "second" });

        const row = await adapter.getRawNodeOutput(tableName, runId, nodeId);

        expect(row).not.toBeNull();
        expect(row?.iteration).toBe(1);
        expect(row?.title).toBe("second");
    });
});
