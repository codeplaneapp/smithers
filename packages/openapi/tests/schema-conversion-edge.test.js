// ---------------------------------------------------------------------------
// Schema converter edge cases: deep nesting, circular $ref, oversized schemas.
// ---------------------------------------------------------------------------
import { describe, test, expect } from "bun:test";
import { jsonSchemaToZod } from "../src/schema-converter.js";

const emptySpec = {
    openapi: "3.0.0",
    info: { title: "Test", version: "1.0.0" },
    paths: {},
};

/**
 * Build a deeply nested OpenAPI schema: object -> object -> ... -> string
 * @param {number} depth
 */
function deepNestedSchema(depth) {
    let leaf = { type: "string" };
    for (let i = 0; i < depth; i += 1) {
        leaf = { type: "object", properties: { child: leaf } };
    }
    return leaf;
}

/**
 * Build a value matching that schema.
 * @param {number} depth
 */
function deepNestedValue(depth) {
    let value = "leaf";
    for (let i = 0; i < depth; i += 1) {
        value = { child: value };
    }
    return value;
}

describe("schema converter — deep nesting", () => {
    test("converts an OpenAPI schema nested 32 levels and parses a matching value", () => {
        const schema = deepNestedSchema(32);
        const zod = jsonSchemaToZod(schema, emptySpec);
        const value = deepNestedValue(32);
        expect(() => zod.parse(value)).not.toThrow();
    });

    test("rejects a value shallower than the declared schema (required prop missing)", () => {
        const schema = deepNestedSchema(8);
        const zod = jsonSchemaToZod(schema, emptySpec);
        const value = deepNestedValue(4);
        // Missing nested 'child' chain — should fail validation.
        expect(() => zod.parse(value)).toThrow();
    });
});

describe("schema converter — circular $ref", () => {
    test("self-referential $ref is unfolded once and then bails to z.any() (no infinite recursion)", () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "Circular", version: "1.0.0" },
            paths: {},
            components: {
                schemas: {
                    Node: {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                            // Direct self-reference.
                            children: {
                                type: "array",
                                items: { $ref: "#/components/schemas/Node" },
                            },
                        },
                    },
                },
            },
        };
        const zod = jsonSchemaToZod(
            { $ref: "#/components/schemas/Node" },
            spec,
        );
        // Should accept a valid two-level value without throwing or hanging.
        const value = {
            name: "root",
            children: [{ name: "child", children: [] }],
        };
        expect(() => zod.parse(value)).not.toThrow();
    });

    test("mutually recursive $refs do not crash the converter", () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "MutualCircular", version: "1.0.0" },
            paths: {},
            components: {
                schemas: {
                    A: {
                        type: "object",
                        properties: {
                            label: { type: "string" },
                            b: { $ref: "#/components/schemas/B" },
                        },
                    },
                    B: {
                        type: "object",
                        properties: {
                            label: { type: "string" },
                            a: { $ref: "#/components/schemas/A" },
                        },
                    },
                },
            },
        };
        // The conversion itself must complete in finite time.
        const zod = jsonSchemaToZod(
            { $ref: "#/components/schemas/A" },
            spec,
        );
        expect(() => zod.parse({ label: "a", b: { label: "b" } })).not.toThrow();
    });
});

describe("schema converter — oversized schema", () => {
    test("converts an object schema with 500 properties without exhausting memory", () => {
        const properties = {};
        for (let i = 0; i < 500; i += 1) {
            properties[`field_${i}`] = { type: "string" };
        }
        const schema = { type: "object", properties };
        const zod = jsonSchemaToZod(schema, emptySpec);
        // Build a complete value.
        const value = {};
        for (let i = 0; i < 500; i += 1) {
            value[`field_${i}`] = `v${i}`;
        }
        expect(() => zod.parse(value)).not.toThrow();
    });

    test("converts an array schema with a deeply nested item without crashing", () => {
        const schema = {
            type: "array",
            items: deepNestedSchema(16),
        };
        const zod = jsonSchemaToZod(schema, emptySpec);
        const value = Array.from({ length: 10 }, () => deepNestedValue(16));
        expect(() => zod.parse(value)).not.toThrow();
    });
});
