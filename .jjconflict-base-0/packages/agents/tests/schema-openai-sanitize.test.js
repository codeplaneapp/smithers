import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodToOpenAISchema } from "../src/zodToOpenAISchema.js";
import { sanitizeForOpenAI } from "../src/sanitizeForOpenAI.js";
describe("zodToOpenAISchema", () => {
    test("basic object schema is unchanged", async () => {
        const schema = z.object({ name: z.string() });
        const result = await zodToOpenAISchema(schema);
        expect(result.type).toBe("object");
        expect(result.properties?.name?.type).toBe("string");
    });
    test("loose object has type: object and strict additionalProperties", async () => {
        const schema = z.object({ document: z.string() }).catchall(z.unknown());
        const result = await zodToOpenAISchema(schema);
        expect(result.type).toBe("object");
        expect(result.additionalProperties).toBe(false);
    });
    test("nested loose objects all have type: object", async () => {
        const inner = z.object({ value: z.number() }).catchall(z.unknown());
        const schema = z.object({ nested: inner }).catchall(z.unknown());
        const result = await zodToOpenAISchema(schema);
        expect(result.type).toBe("object");
        const nested = result.properties?.nested;
        expect(nested?.type).toBe("object");
    });
    test("array items with loose object are fixed", async () => {
        const item = z.object({ id: z.string() }).catchall(z.unknown());
        const schema = z.object({ items: z.array(item) });
        const result = await zodToOpenAISchema(schema);
        const itemSchema = result.properties?.items?.items;
        expect(itemSchema?.type).toBe("object");
    });
    test("z.looseObject output schemas are strict enough for Codex structured output", async () => {
        const schema = z.looseObject({ document: z.string() });
        const result = await zodToOpenAISchema(schema);
        expect(result.type).toBe("object");
        expect(result.additionalProperties).toBe(false);
        expect(result.additionalProperties).not.toEqual({});
    });
    test("ordinary strict object schemas keep additionalProperties false", async () => {
        const schema = z.object({ document: z.string() });
        const result = await zodToOpenAISchema(schema);
        expect(result.type).toBe("object");
        expect(result.additionalProperties).toBe(false);
    });
});
describe("sanitizeForOpenAI", () => {
    test("adds type: object when additionalProperties present but type missing", () => {
        const schema = {
            additionalProperties: true,
            properties: { foo: { type: "string" } },
        };
        sanitizeForOpenAI(schema);
        expect(schema.type).toBe("object");
    });
    test("does not overwrite existing type", () => {
        const schema = {
            type: "object",
            additionalProperties: true,
        };
        sanitizeForOpenAI(schema);
        expect(schema.type).toBe("object");
    });
    test("coerces empty object additionalProperties to false", () => {
        const schema = {
            type: "object",
            additionalProperties: {},
        };
        sanitizeForOpenAI(schema);
        expect(schema.additionalProperties).toBe(false);
    });
    test("coerces non-empty additionalProperties schema to false", () => {
        const subSchema = { type: "string" };
        const schema = {
            type: "object",
            additionalProperties: subSchema,
        };
        sanitizeForOpenAI(schema);
        expect(schema.additionalProperties).toBe(false);
    });
    test("recursively fixes deeply nested schemas", () => {
        const schema = {
            type: "object",
            properties: {
                level1: {
                    properties: {
                        level2: {
                            additionalProperties: true,
                            properties: { deep: { type: "string" } },
                        },
                    },
                },
            },
        };
        sanitizeForOpenAI(schema);
        expect(schema.properties.level1.properties.level2.type).toBe("object");
    });
    test("handles null and primitive values without throwing", () => {
        expect(() => sanitizeForOpenAI(null)).not.toThrow();
        expect(() => sanitizeForOpenAI(undefined)).not.toThrow();
        expect(() => sanitizeForOpenAI("string")).not.toThrow();
        expect(() => sanitizeForOpenAI(42)).not.toThrow();
    });
});
