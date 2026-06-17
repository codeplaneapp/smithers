import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { getTableName } from "drizzle-orm";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL.js";
import { zodToTable } from "../src/zodToTable.js";
describe("zodToTable", () => {
    test("creates table from simple schema", () => {
        const schema = z.object({
            name: z.string(),
            age: z.number(),
        });
        const table = zodToTable("test_simple", schema);
        expect(getTableName(table)).toBe("test_simple");
    });
    test("includes smithers key columns", () => {
        const schema = z.object({ val: z.string() });
        const table = zodToTable("test_keys", schema);
        const cols = Object.keys(table);
        expect(cols).toContain("runId");
        expect(cols).toContain("nodeId");
        expect(cols).toContain("iteration");
    });
    test("maps string to text column", () => {
        const schema = z.object({ name: z.string() });
        const table = zodToTable("test_string", schema);
        expect(Object.keys(table)).toContain("name");
    });
    test("maps number to real column", () => {
        const schema = z.object({
            score: z.number(),
            confidence: z.number().min(0).max(1),
        });
        const table = zodToTable("test_number", schema);
        const ddl = zodToCreateTableSQL("test_number", schema);
        expect(table.score.getSQLType()).toBe("real");
        expect(table.confidence.getSQLType()).toBe("real");
        expect(ddl).toContain('"score" REAL');
        expect(ddl).toContain('"confidence" REAL');
    });
    test("maps integer number schemas to integer columns", () => {
        const schema = z.object({
            count: z.number().int(),
            exact: z.int(),
        });
        const table = zodToTable("test_integer", schema);
        const ddl = zodToCreateTableSQL("test_integer", schema);
        expect(table.count.getSQLType()).toBe("integer");
        expect(table.exact.getSQLType()).toBe("integer");
        expect(ddl).toContain('"count" INTEGER');
        expect(ddl).toContain('"exact" INTEGER');
    });
    test("maps boolean to integer(boolean) column", () => {
        const schema = z.object({ active: z.boolean() });
        const table = zodToTable("test_bool", schema);
        expect(Object.keys(table)).toContain("active");
    });
    test("maps enum to text column", () => {
        const schema = z.object({ status: z.enum(["a", "b"]) });
        const table = zodToTable("test_enum", schema);
        expect(Object.keys(table)).toContain("status");
    });
    test("maps array to json text column", () => {
        const schema = z.object({ tags: z.array(z.string()) });
        const table = zodToTable("test_array", schema);
        expect(Object.keys(table)).toContain("tags");
    });
    test("maps nested object to json text column", () => {
        const schema = z.object({
            meta: z.object({ key: z.string() }),
        });
        const table = zodToTable("test_nested", schema);
        expect(Object.keys(table)).toContain("meta");
    });
    test("handles optional fields", () => {
        const schema = z.object({
            required: z.string(),
            optional: z.string().optional(),
        });
        const table = zodToTable("test_optional", schema);
        expect(Object.keys(table)).toContain("required");
        expect(Object.keys(table)).toContain("optional");
    });
    test("handles nullable fields", () => {
        const schema = z.object({
            nullable: z.string().nullable(),
        });
        const table = zodToTable("test_nullable", schema);
        expect(Object.keys(table)).toContain("nullable");
    });
});
