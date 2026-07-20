import { describe, expect, test } from "bun:test";
import { jsonSchemaToZod } from "../src/external/json-schema-to-zod.js";

describe("engine jsonSchemaToZod", () => {
    test("falls back to catchall object for non-object roots and undefined nodes", () => {
        expect(jsonSchemaToZod({ type: "string" }).parse({ arbitrary: 1 })).toEqual({ arbitrary: 1 });
        expect(jsonSchemaToZod(undefined).parse({ any: "value" })).toEqual({ any: "value" });
    });

    test("converts object properties, scalar constraints and metadata", () => {
        const schema = jsonSchemaToZod({
            type: "object",
            description: "User payload",
            required: ["name", "age", "score", "enabled", "tags", "role"],
            properties: {
                name: {
                    type: "string",
                    minLength: 2,
                    maxLength: 8,
                    pattern: "^[A-Z]",
                    description: "display name",
                },
                age: { type: "integer", minimum: 18, maximum: 99 },
                score: { type: "number", minimum: 0, maximum: 10, default: 5 },
                enabled: { type: "boolean" },
                tags: { type: "array", items: { type: "string" } },
                role: { type: "string", enum: ["admin", "user"] },
                optionalNote: { type: "string", nullable: true },
                unknownThing: {},
                nullThing: { type: "null" },
            },
        });

        const parsed = schema.parse({
            name: "Alice",
            age: 42,
            score: 9.5,
            enabled: true,
            tags: ["a", "b"],
            role: "admin",
            optionalNote: null,
            unknownThing: { nested: true },
            nullThing: null,
        });

        expect(parsed.name).toBe("Alice");
        expect(parsed.optionalNote).toBe(null);
        expect(parsed.unknownThing).toEqual({ nested: true });
        expect(() => schema.parse({ name: "bob", age: 17, score: 11, enabled: true, tags: [], role: "guest" })).toThrow();
    });

    test("converts refs, escaped JSON pointers and circular references", () => {
        const schema = jsonSchemaToZod({
            type: "object",
            required: ["pet", "escaped", "self"],
            properties: {
                pet: { $ref: "#/$defs/Pet" },
                escaped: { $ref: "#/$defs/a~1b~0c" },
                self: { $ref: "#/$defs/Self" },
            },
            $defs: {
                Pet: {
                    type: "object",
                    required: ["name"],
                    properties: { name: { type: "string" } },
                },
                "a/b~c": { type: "string" },
                Self: {
                    type: "object",
                    properties: {
                        child: { $ref: "#/$defs/Self" },
                    },
                },
            },
        });

        const parsed = schema.parse({
            pet: { name: "Milo" },
            escaped: "ok",
            self: { child: { anything: true } },
        });
        expect(parsed.pet.name).toBe("Milo");
        expect(parsed.escaped).toBe("ok");
        expect(parsed.self.child).toEqual({ anything: true });
    });

    test("throws for unsupported and missing refs", () => {
        expect(() => jsonSchemaToZod({
            type: "object",
            required: ["bad"],
            properties: { bad: { $ref: "Pet" } },
        })).toThrow("Unsupported $ref format");

        expect(() => jsonSchemaToZod({
            type: "object",
            required: ["bad"],
            properties: { bad: { $ref: "#/$defs/Missing" } },
            $defs: {},
        })).toThrow("Could not resolve $ref");
    });

    test("converts allOf, anyOf and oneOf variants", () => {
        const schema = jsonSchemaToZod({
            type: "object",
            required: ["singleAll", "multiAll", "nullableDefault", "unionValue", "singleOne", "multiOne"],
            properties: {
                singleAll: {
                    allOf: [{ type: "string", minLength: 2 }],
                    description: "single allOf",
                },
                multiAll: {
                    allOf: [
                        {
                            type: "object",
                            required: ["a"],
                            properties: { a: { type: "string" } },
                        },
                        {
                            type: "object",
                            required: ["b"],
                            properties: { b: { type: "number" } },
                        },
                    ],
                },
                nullableDefault: {
                    anyOf: [{ type: "null" }, { type: "string" }],
                    default: "fallback",
                    description: "nullable",
                },
                unionValue: {
                    anyOf: [{ type: "string" }, { type: "number" }],
                },
                singleOne: {
                    oneOf: [{ type: "boolean" }],
                    description: "single oneOf",
                },
                multiOne: {
                    oneOf: [{ type: "string" }, { type: "integer" }],
                    description: "multi oneOf",
                },
            },
        });

        expect(schema.parse({
            singleAll: "ok",
            multiAll: { a: "x", b: 1 },
            nullableDefault: null,
            unionValue: 2,
            singleOne: true,
            multiOne: "x",
        }).multiAll).toEqual({ a: "x", b: 1 });

        expect(schema.parse({
            singleAll: "ok",
            multiAll: { a: "x", b: 1 },
            unionValue: "text",
            singleOne: false,
            multiOne: 3,
        }).nullableDefault).toBe("fallback");
    });
});
