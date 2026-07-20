import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodSchemaToJsonExample } from "../src/zod-to-example.js";

describe("zodSchemaToJsonExample unions and lazy schemas", () => {
    test("renders a nested discriminated-union envelope instead of value", () => {
        const expr = z.lazy(() => z.discriminatedUnion("tag", [
            z.object({
                tag: z.literal("agent"),
                id: z.string().describe("local-id"),
            }),
            z.object({
                tag: z.literal("sequence"),
                steps: z.array(expr),
            }),
        ]));
        const schema = z.object({
            protocolVersion: z.literal(2),
            outcome: z.discriminatedUnion("tag", [
                z.object({
                    tag: z.literal("subworkflow"),
                    value: z.object({ root: expr }),
                }),
                z.object({
                    tag: z.literal("complete"),
                    value: z.object({ summary: z.string() }),
                }),
            ]),
        });

        expect(JSON.parse(zodSchemaToJsonExample(schema))).toEqual({
            protocolVersion: 2,
            outcome: {
                tag: "subworkflow",
                value: {
                    root: {
                        tag: "agent",
                        id: "local-id",
                    },
                },
            },
        });
    });

    test("chooses the first ordinary union branch deterministically", () => {
        const schema = z.object({
            result: z.union([
                z.object({ kind: z.literal("first"), value: z.number() }),
                z.object({ kind: z.literal("second"), value: z.string() }),
            ]),
        });

        expect(JSON.parse(zodSchemaToJsonExample(schema))).toEqual({
            result: { kind: "first", value: 0 },
        });
    });

    test("cuts recursive lazy paths without recursing forever", () => {
        const node = z.lazy(() => z.object({
            tag: z.literal("branch"),
            children: z.array(node),
        }));
        const schema = z.object({ root: node });

        expect(JSON.parse(zodSchemaToJsonExample(schema))).toEqual({
            root: {
                tag: "branch",
                children: ["value"],
            },
        });
    });
});
