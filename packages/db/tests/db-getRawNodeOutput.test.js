import { describe, expect, test } from "bun:test";
import { SmithersDb } from "../src/adapter.js";
import { zodToTable } from "../src/zodToTable.js";
import { syncZodTableSchema } from "../src/zodToCreateTableSQL.js";
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
    syncZodTableSchema(sqlite, tableName, schema);
    const db = drizzle(sqlite, { schema: { [tableName]: table } });
    return { adapter: new SmithersDb(db), db, sqlite, table };
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

    test("preserves persisted boolean schema metadata without a live drizzle schema", async () => {
        const tableName = "boolean_results";
        const { db, sqlite, table } = createDbWithOutputTable(tableName, z.object({
            approved: z.boolean(),
            declined: z.boolean(),
            reviewed: z.boolean().nullable(),
            generatedAt: z.string(),
            count: z.number(),
        }));
        const schemaAdapter = new SmithersDb(db);
        await schemaAdapter.upsertOutputRow(table, { runId: "run-1", nodeId: "gate", iteration: 0 }, {
            approved: false,
            declined: true,
            reviewed: null,
            generatedAt: "2026-06-09T00:00:00.000Z",
            count: 1,
        });

        const rawAdapter = new SmithersDb(drizzle(sqlite));
        const row = await rawAdapter.getRawNodeOutputForIteration(tableName, "run-1", "gate", 0);

        expect(row).toMatchObject({
            run_id: "run-1",
            node_id: "gate",
            iteration: 0,
            approved: false,
            declined: true,
            reviewed: null,
            generated_at: "2026-06-09T00:00:00.000Z",
            count: 1,
        });
        expect(typeof row?.approved).toBe("boolean");
        expect(typeof row?.declined).toBe("boolean");
        expect(row?.reviewed).toBeNull();
    });
});
