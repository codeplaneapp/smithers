import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import { z } from "zod";
import {
    pgRowToDrizzle,
    isPostgresDb,
    getJsonColumnKeys,
    loadInput,
    loadInputEffect,
    loadOutputs,
    loadRunOutputRowsEffect,
} from "../src/snapshot.js";
import { zodToTable } from "../src/zodToTable.js";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL.js";

describe("snapshot.js pure helpers", () => {
    test("pgRowToDrizzle: snake→camel, payload + json-key decode, bad JSON + non-string passthrough", () => {
        const out = pgRowToDrizzle(
            {
                run_id: "r",
                node_id: "n",
                payload: '{"a":1}',
                meta_json: '{"b":2}',
                bad_json: "{not json",
                count_col: 5,
            },
            ["metaJson", "badJson"],
        );
        expect(out.runId).toBe("r");
        expect(out.nodeId).toBe("n");
        expect(out.payload).toEqual({ a: 1 });
        expect(out.metaJson).toEqual({ b: 2 });
        // Invalid JSON on a declared json key falls back to the raw string.
        expect(out.badJson).toBe("{not json");
        // Non-string values pass straight through.
        expect(out.countCol).toBe(5);
    });

    test("pgRowToDrizzle without jsonKeys still decodes the literal payload column", () => {
        expect(pgRowToDrizzle({ payload: '{"x":true}' }).payload).toEqual({ x: true });
    });

    test("isPostgresDb", () => {
        expect(isPostgresDb({ dialect: "postgres", connection: {} })).toBe(true);
        expect(isPostgresDb({ dialect: "postgres" })).toBe(false);
        expect(isPostgresDb({ dialect: "sqlite" })).toBe(false);
        expect(isPostgresDb(null)).toBe(false);
    });

    test("getJsonColumnKeys returns json-mode keys and [] on a bad table", () => {
        const table = zodToTable("j", z.object({ data: z.array(z.string()), name: z.string() }));
        expect(getJsonColumnKeys(table)).toContain("data");
        expect(getJsonColumnKeys(/** @type {any} */ (null))).toEqual([]);
    });
});

describe("snapshot.js loadInput (sqlite)", () => {
    test("loads a row and returns undefined for a missing run", async () => {
        const inputTable = sqliteTable("input", { runId: text("run_id").primaryKey(), payload: text("payload") });
        const sqlite = new Database(":memory:");
        sqlite.exec(`CREATE TABLE input (run_id TEXT PRIMARY KEY, payload TEXT)`);
        const db = drizzle(sqlite, { schema: { input: inputTable } });
        db.insert(inputTable).values({ runId: "r1", payload: "hi" }).run();
        expect((await loadInput(db, inputTable, "r1")).payload).toBe("hi");
        expect(await loadInput(db, inputTable, "nope")).toBeUndefined();
        sqlite.close();
    });

    test("fails when the input table lacks a runId column", async () => {
        const badTable = sqliteTable("bad", { other: text("other") });
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite, { schema: { bad: badTable } });
        const exit = await Effect.runPromiseExit(loadInputEffect(db, badTable, "r1"));
        expect(exit._tag).toBe("Failure");
        sqlite.close();
    });

    test("surfaces a DB error (missing physical table) through the sqlite catch branch", async () => {
        const inputTable = sqliteTable("phantom", { runId: text("run_id").primaryKey(), payload: text("payload") });
        const sqlite = new Database(":memory:"); // table never created
        const db = drizzle(sqlite, { schema: { phantom: inputTable } });
        const exit = await Effect.runPromiseExit(loadInputEffect(db, inputTable, "r1"));
        expect(exit._tag).toBe("Failure");
        sqlite.close();
    });
});

describe("snapshot.js loadOutputs (sqlite)", () => {
    test("loads output tables, coerces booleans, and skips input/non-table/runId-less entries", async () => {
        const schema = z.object({ ok: z.boolean(), score: z.number() });
        const table = zodToTable("out_a", schema);
        const noRunId = sqliteTable("no_runid", { other: text("other") });
        const sqlite = new Database(":memory:");
        sqlite.exec(zodToCreateTableSQL("out_a", schema));
        sqlite.exec(`CREATE TABLE no_runid (other TEXT)`);
        const db = drizzle(sqlite, { schema: { outA: table } });
        db.insert(table).values({ runId: "r1", nodeId: "n1", iteration: 0, ok: true, score: 5 }).run();
        const outputs = await loadOutputs(
            db,
            {
                outA: table,
                input: table, // "input" key is skipped
                notATable: 42, // non-object is skipped
                noRunId, // table without a runId column is skipped
            },
            "r1",
        );
        expect(outputs.outA.length).toBe(1);
        expect(outputs.outA[0].ok).toBe(true);
        expect(outputs.outA[0].score).toBe(5);
        expect(outputs.noRunId).toBeUndefined();
        sqlite.close();
    });
});

describe("snapshot.js loadRunOutputRowsEffect (sqlite)", () => {
    test("returns all rows, or only the run's rows when a runId is given", async () => {
        const schema = z.object({ flag: z.boolean() });
        const table = zodToTable("rows_t", schema);
        const sqlite = new Database(":memory:");
        sqlite.exec(zodToCreateTableSQL("rows_t", schema));
        const db = drizzle(sqlite, { schema: { rowsT: table } });
        db.insert(table).values({ runId: "r1", nodeId: "n1", iteration: 0, flag: true }).run();
        db.insert(table).values({ runId: "r2", nodeId: "n1", iteration: 0, flag: false }).run();

        const scoped = await Effect.runPromise(loadRunOutputRowsEffect(db, table, "r1"));
        expect(scoped.length).toBe(1);
        expect(scoped[0].flag).toBe(true);

        const all = await Effect.runPromise(loadRunOutputRowsEffect(db, table));
        expect(all.length).toBe(2);
        sqlite.close();
    });
});
