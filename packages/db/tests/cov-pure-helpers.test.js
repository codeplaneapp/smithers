import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { z } from "zod";

import { assertMaxStringLength } from "../src/assertMaxStringLength.js";
import { assertOptionalArrayMaxLength } from "../src/assertOptionalArrayMaxLength.js";
import { assertPositiveFiniteInteger } from "../src/assertPositiveFiniteInteger.js";
import { assertPositiveFiniteNumber } from "../src/assertPositiveFiniteNumber.js";
import { assertJsonPayloadWithinBounds } from "../src/assertJsonPayloadWithinBounds.js";
import {
    SQLITE,
    POSTGRES,
    quoteIdentifier,
    translatePlaceholders,
    columnType,
    translateDdl,
    beginTransactionSql,
    jsonExtractText,
} from "../src/dialect.js";
import {
    normalizeWaitForEventCorrelationId,
    parseWaitForEventOptionalFiniteNumber,
    parseWaitForEventAttemptSnapshot,
} from "../src/waitForEventAttempt.js";
import { withSqliteWriteRetry } from "../src/write-retry.js";
import { withSqliteWriteRetryEffect } from "../src/withSqliteWriteRetryEffect.js";
import { buildOutputSchemaDescriptor } from "../src/output-schema-descriptor.js";
import { syncZodTableSchema } from "../src/zodToCreateTableSQL.js";
import { ensureSmithersTables, ensureSmithersTablesEffect } from "../src/ensure.js";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

describe("assert helpers", () => {
    test("assertMaxStringLength: ok, non-string throws, too-long throws", () => {
        expect(assertMaxStringLength("f", "hi", 5)).toBe("hi");
        expect(() => assertMaxStringLength("f", 123, 5)).toThrow(/must be a string/);
        expect(() => assertMaxStringLength("f", "toolong", 3)).toThrow(/maximum length/);
    });

    test("assertOptionalArrayMaxLength: nullish returns, non-array throws, over-limit throws, ok", () => {
        expect(assertOptionalArrayMaxLength("f", undefined, 3)).toBeUndefined();
        expect(assertOptionalArrayMaxLength("f", null, 3)).toBeUndefined();
        expect(assertOptionalArrayMaxLength("f", [1, 2], 3)).toBeUndefined();
        expect(() => assertOptionalArrayMaxLength("f", "nope", 3)).toThrow(/must be an array/);
        expect(() => assertOptionalArrayMaxLength("f", [1, 2, 3, 4], 3)).toThrow(/maximum size/);
    });

    test("assertPositiveFiniteNumber + assertPositiveFiniteInteger", () => {
        expect(assertPositiveFiniteNumber("f", 2.5)).toBe(2.5);
        expect(() => assertPositiveFiniteNumber("f", 0)).toThrow(/greater than 0/);
        expect(() => assertPositiveFiniteNumber("f", -1)).toThrow(/greater than 0/);
        expect(() => assertPositiveFiniteNumber("f", Number.POSITIVE_INFINITY)).toThrow(/greater than 0/);
        expect(() => assertPositiveFiniteNumber("f", "5")).toThrow(/greater than 0/);
        expect(assertPositiveFiniteInteger("f", 3)).toBe(3);
        expect(() => assertPositiveFiniteInteger("f", 2.5)).toThrow(/must be an integer/);
    });

    test("assertJsonPayloadWithinBounds: serializable value passes", () => {
        const json = assertJsonPayloadWithinBounds("f", { a: 1, b: "x", c: [true, null] }, { maxBytes: 1000, maxDepth: 10, maxStringLength: 100, maxArrayLength: 100 });
        expect(JSON.parse(json)).toEqual({ a: 1, b: "x", c: [true, null] });
    });

    test("assertJsonPayloadWithinBounds: null/boolean leaves, non-finite number, undefined and BigInt reject", () => {
        // null + boolean leaf values return early (validateJsonValue leaf path).
        expect(() => assertJsonPayloadWithinBounds("f", { a: null, b: true }, { maxBytes: 1000 })).not.toThrow();
        // Non-finite numbers are rejected even though JSON.stringify coerces them to null.
        expect(() => assertJsonPayloadWithinBounds("f", { x: Number.POSITIVE_INFINITY }, { maxBytes: 1000 })).toThrow(/finite numbers/);
        // JSON.stringify(undefined) === undefined → the undefined guard.
        expect(() => assertJsonPayloadWithinBounds("f", undefined, {})).toThrow(/JSON-serializable/);
        // JSON.stringify(BigInt) throws → the try/catch guard.
        expect(() => assertJsonPayloadWithinBounds("f", 10n, {})).toThrow(/JSON-serializable/);
    });

    test("assertJsonPayloadWithinBounds: a toJSON-masked cycle is caught by the walker", () => {
        // JSON.stringify succeeds via toJSON (acyclic output), but the validator
        // walks the ORIGINAL graph and detects the self-reference.
        const cyclic = /** @type {any} */ ({});
        cyclic.self = cyclic;
        cyclic.toJSON = () => ({ ok: 1 });
        expect(() => assertJsonPayloadWithinBounds("f", cyclic, { maxBytes: 1000 })).toThrow(/circular references/);
    });
});

describe("dialect", () => {
    test("quoteIdentifier escapes embedded quotes", () => {
        expect(quoteIdentifier('a"b')).toBe('"a""b"');
    });

    test("translatePlaceholders: sqlite passthrough; postgres renumbers only real placeholders", () => {
        expect(translatePlaceholders(SQLITE, "SELECT ? , ?")).toBe("SELECT ? , ?");
        const sql = `SELECT ?, '?', "c?", ? -- ? comment\n/* ? block */ ?`;
        const out = translatePlaceholders(POSTGRES, sql);
        expect(out).toContain("$1");
        expect(out).toContain("$2");
        expect(out).toContain("$3");
        // The '?' inside the string literal, quoted identifier and comments stays literal.
        expect(out).toContain("'?'");
        expect(out).toContain('"c?"');
        expect(out).toContain("-- ? comment");
        expect(out).toContain("/* ? block */");
    });

    test("translatePlaceholders handles escaped quotes inside literals/identifiers", () => {
        const out = translatePlaceholders(POSTGRES, `SELECT 'a''?b' , "c""?d" , ?`);
        expect(out).toContain("'a''?b'");
        expect(out).toContain('"c""?d"');
        expect(out).toContain("$1");
    });

    test("columnType maps sqlite types for postgres; passthrough for sqlite", () => {
        expect(columnType(SQLITE, "INTEGER")).toBe("INTEGER");
        expect(columnType(POSTGRES, "INTEGER")).toBe("BIGINT");
        expect(columnType(POSTGRES, "REAL")).toBe("DOUBLE PRECISION");
        expect(columnType(POSTGRES, "BLOB")).toBe("BYTEA");
        expect(columnType(POSTGRES, "TEXT")).toBe("TEXT");
    });

    test("translateDdl rewrites autoincrement/blob/real/integer for postgres", () => {
        expect(translateDdl(SQLITE, "x INTEGER")).toBe("x INTEGER");
        const ddl = translateDdl(POSTGRES, "id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER, r REAL, b BLOB");
        expect(ddl).toContain("BIGSERIAL PRIMARY KEY");
        expect(ddl).toContain("BIGINT");
        expect(ddl).toContain("DOUBLE PRECISION");
        expect(ddl).toContain("BYTEA");
        expect(ddl).not.toContain("AUTOINCREMENT");
    });

    test("beginTransactionSql + jsonExtractText per dialect", () => {
        expect(beginTransactionSql(SQLITE)).toBe("BEGIN IMMEDIATE");
        expect(beginTransactionSql(POSTGRES)).toBe("BEGIN");
        expect(jsonExtractText(SQLITE, "payload_json", "$.nodeId")).toBe("json_extract(payload_json, '$.nodeId')");
        expect(jsonExtractText(POSTGRES, "payload_json", "$.nodeId")).toBe("(payload_json::json->>'nodeId')");
    });
});

describe("waitForEventAttempt", () => {
    test("normalizeWaitForEventCorrelationId trims / collapses blanks to null", () => {
        expect(normalizeWaitForEventCorrelationId("  x  ")).toBe("x");
        expect(normalizeWaitForEventCorrelationId("   ")).toBeNull();
        expect(normalizeWaitForEventCorrelationId(null)).toBeNull();
        expect(normalizeWaitForEventCorrelationId(undefined)).toBeNull();
        expect(normalizeWaitForEventCorrelationId(42)).toBeNull();
    });

    test("parseWaitForEventOptionalFiniteNumber", () => {
        expect(parseWaitForEventOptionalFiniteNumber(null)).toBeUndefined();
        expect(parseWaitForEventOptionalFiniteNumber("")).toBeUndefined();
        expect(parseWaitForEventOptionalFiniteNumber("12")).toBe(12);
        expect(parseWaitForEventOptionalFiniteNumber("abc")).toBeUndefined();
        expect(parseWaitForEventOptionalFiniteNumber(7)).toBe(7);
    });

    test("parseWaitForEventAttemptSnapshot: full snapshot + every rejection path", () => {
        const full = parseWaitForEventAttemptSnapshot(JSON.stringify({
            waitForEvent: { signalName: " sig ", correlationId: " c ", waitAsync: true, resolvedSignalSeq: "3", receivedAtMs: 1000 },
        }));
        expect(full).toEqual({
            meta: { waitForEvent: { signalName: " sig ", correlationId: " c ", waitAsync: true, resolvedSignalSeq: "3", receivedAtMs: 1000 } },
            signalName: "sig",
            correlationId: "c",
            waitAsync: true,
            resolvedSignalSeq: 3,
            receivedAtMs: 1000,
        });
        expect(parseWaitForEventAttemptSnapshot(null)).toBeNull();
        expect(parseWaitForEventAttemptSnapshot("{bad")).toBeNull();
        expect(parseWaitForEventAttemptSnapshot(JSON.stringify([1, 2]))).toBeNull();
        expect(parseWaitForEventAttemptSnapshot(JSON.stringify({ waitForEvent: null }))).toBeNull();
        expect(parseWaitForEventAttemptSnapshot(JSON.stringify({ waitForEvent: [1] }))).toBeNull();
        expect(parseWaitForEventAttemptSnapshot(JSON.stringify({ waitForEvent: { signalName: "  " } }))).toBeNull();
    });
});

describe("write-retry (Promise variant)", () => {
    test("uses the built-in delay when no sleep override is provided", async () => {
        let attempts = 0;
        const result = await withSqliteWriteRetry(
            async () => {
                attempts += 1;
                if (attempts < 2) throw new SmithersError("SQLITE_BUSY", "database is busy");
                return "ok";
            },
            { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 },
        );
        expect(result).toBe("ok");
        expect(attempts).toBe(2);
    });

    test("gives up on a non-retryable error", async () => {
        await expect(
            withSqliteWriteRetry(async () => {
                throw new SmithersError("DB_WRITE_FAILED", "constraint failed");
            }, { maxAttempts: 3, baseDelayMs: 1 }),
        ).rejects.toThrow(/constraint failed/);
    });
});

describe("withSqliteWriteRetryEffect edge branches", () => {
    test("retries a codeless 'database is busy' error (non-string code branch) through a nested cause", async () => {
        let attempts = 0;
        const sleeps = [];
        // The outer error carries no `code`; the retryable signal lives in a
        // nested `cause`, exercising the cause-chain walk + codeless describe.
        const result = await Effect.runPromise(
            withSqliteWriteRetryEffect(
                () => {
                    attempts += 1;
                    if (attempts < 2) {
                        const inner = new Error("database is busy");
                        const outer = new Error("wrapper");
                        // @ts-ignore attach cause chain
                        outer.cause = inner;
                        return Effect.fail(outer);
                    }
                    return Effect.succeed("done");
                },
                { label: "codeless", maxAttempts: 4, sleep: async (ms) => { sleeps.push(ms); } },
            ),
        );
        expect(result).toBe("done");
        expect(attempts).toBe(2);
        expect(sleeps.length).toBe(1);
    });
});

describe("output-schema-descriptor", () => {
    test("throws without a zod object schema", () => {
        expect(() => buildOutputSchemaDescriptor({})).toThrow(/requires a Zod object schema/);
        expect(() => buildOutputSchemaDescriptor({ shape: [] })).toThrow(/requires a Zod object schema/);
    });

    test("describes every supported field type + optional/nullable/default/enum/literal", () => {
        const warnings = [];
        const descriptor = buildOutputSchemaDescriptor(
            z.object({
                s: z.string().describe("a string"),
                n: z.number(),
                i: z.int(),
                b: z.boolean(),
                nul: z.null(),
                arr: z.array(z.string()),
                tup: z.tuple([z.string(), z.number()]),
                setf: z.set(z.string()),
                obj: z.object({ y: z.string() }),
                rec: z.record(z.string(), z.number()),
                mapf: z.map(z.string(), z.number()),
                en: z.enum(["a", "b"]),
                litStr: z.literal("x"),
                litNum: z.literal(3),
                litBool: z.literal(true),
                litNull: z.literal(null),
                unk: z.unknown(),
                optional: z.string().optional(),
                nullable: z.string().nullable(),
                withDefault: z.string().default("d"),
                // Wrapper types exercised by unwrapSchema: readonly / nonoptional / catch / pipe.
                readonlyField: z.string().readonly(),
                nonoptionalField: z.nonoptional(z.string()),
                caughtField: z.string().catch("x"),
                pipedField: z.string().transform((s) => s),
            }),
            { onWarning: (w) => warnings.push(w) },
        );
        const byName = Object.fromEntries(descriptor.fields.map((f) => [f.name, f]));
        expect(byName.s.type).toBe("string");
        expect(byName.s.description).toBe("a string");
        expect(byName.n.type).toBe("number");
        expect(byName.i.type).toBe("number");
        expect(byName.b.type).toBe("boolean");
        expect(byName.nul.type).toBe("null");
        expect(byName.arr.type).toBe("array");
        expect(byName.tup.type).toBe("array");
        expect(byName.setf.type).toBe("array");
        expect(byName.obj.type).toBe("object");
        expect(byName.rec.type).toBe("object");
        expect(byName.mapf.type).toBe("object");
        expect(byName.en.type).toBe("string");
        expect(byName.en.enum).toEqual(["a", "b"]);
        expect(byName.litStr).toMatchObject({ type: "string", enum: ["x"] });
        expect(byName.litNum).toMatchObject({ type: "number", enum: [3] });
        expect(byName.litBool).toMatchObject({ type: "boolean", enum: [true] });
        expect(byName.litNull.type).toBe("null");
        expect(byName.unk.type).toBe("unknown");
        expect(byName.optional.optional).toBe(true);
        expect(byName.nullable.nullable).toBe(true);
        expect(byName.withDefault.optional).toBe(true);
    });

    test("reports a warning for unsupported constructs (multi-value literal / bigint)", () => {
        const warnings = [];
        buildOutputSchemaDescriptor(
            z.object({ many: z.literal(["a", "b"]), big: z.bigint() }),
            { onWarning: (w) => warnings.push(w) },
        );
        expect(warnings.some((w) => w.code === "SchemaConversionError")).toBe(true);
        // Also exercise the no-onWarning path (reportUnsupported optional chaining).
        expect(() => buildOutputSchemaDescriptor(z.object({ big: z.bigint() }))).not.toThrow();
    });
});

describe("zodToCreateTableSQL.syncZodTableSchema (sqlite)", () => {
    test("adds missing columns via ALTER TABLE on an existing older table", () => {
        const sqlite = new Database(":memory:");
        sqlite.run(`CREATE TABLE t (run_id TEXT NOT NULL, node_id TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, a TEXT, PRIMARY KEY (run_id, node_id, iteration))`);
        // `d` is a json-kind column (array) so sqliteKindFor's json branch runs.
        syncZodTableSchema(sqlite, "t", z.object({ a: z.string(), b: z.number(), c: z.boolean(), d: z.array(z.string()) }));
        const cols = new Set(sqlite.query(`PRAGMA table_info("t")`).all().map((r) => r.name));
        expect(cols.has("b")).toBe(true);
        expect(cols.has("c")).toBe(true);
        // Schema-columns metadata table populated.
        const meta = sqlite.query(`SELECT column_name FROM _smithers_output_schema_columns WHERE table_name = 't'`).all();
        expect(meta.length).toBeGreaterThan(0);
        sqlite.close();
    });

    test("input tables skip the metadata + key columns", () => {
        const sqlite = new Database(":memory:");
        syncZodTableSchema(sqlite, "ti", z.object({ a: z.string() }), { isInput: true });
        const cols = new Set(sqlite.query(`PRAGMA table_info("ti")`).all().map((r) => r.name));
        expect(cols.has("run_id")).toBe(true);
        expect(cols.has("a")).toBe(true);
        expect(cols.has("node_id")).toBe(false);
        sqlite.close();
    });
});

describe("ensure", () => {
    test("ensureSmithersTables is a no-op for a postgres descriptor", () => {
        // No throw, and nothing is executed synchronously for postgres.
        expect(() => ensureSmithersTables(/** @type {any} */ ({ dialect: "postgres" }))).not.toThrow();
    });

    test("ensureSmithersTablesEffect creates the schema for a real sqlite db", async () => {
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        await Effect.runPromise(ensureSmithersTablesEffect(db));
        const rows = sqlite.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='_smithers_runs'`).all();
        expect(rows.length).toBe(1);
        sqlite.close();
    });
});
