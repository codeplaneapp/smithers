import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { loadInputEffect } from "../src/snapshot.js";

// Input table deliberately missing a `runId` column to exercise the
// DB_MISSING_COLUMNS path.
const noRunIdTable = sqliteTable("test_input_no_runid", {
    id: text("id").primaryKey(),
    prompt: text("prompt"),
});

function createTestDb() {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
    CREATE TABLE test_input_no_runid (
      id TEXT PRIMARY KEY,
      prompt TEXT
    );
  `);
    const db = drizzle(sqlite, { schema: { input: noRunIdTable } });
    return { db, cleanup: () => sqlite.close() };
}

describe("loadInputEffect: missing runId column", () => {
    test("does NOT throw synchronously during Effect construction", () => {
        const { db, cleanup } = createTestDb();
        try {
            // Building the Effect must be pure: the missing-column error has to
            // be deferred into the Effect, not thrown while constructing it.
            let effect;
            expect(() => {
                effect = loadInputEffect(db, noRunIdTable, "run-1");
            }).not.toThrow();
            expect(effect).toBeDefined();
        } finally {
            cleanup();
        }
    });

    test("fails the Effect with a DB_MISSING_COLUMNS SmithersError (catchable)", async () => {
        const { db, cleanup } = createTestDb();
        try {
            const exit = await Effect.runPromiseExit(loadInputEffect(db, noRunIdTable, "run-1"));
            expect(Exit.isFailure(exit)).toBe(true);

            // The error must surface through the Effect error channel so callers
            // can catch it, rather than escaping as a synchronous throw or defect.
            const error = await Effect.runPromise(
                loadInputEffect(db, noRunIdTable, "run-1").pipe(Effect.flip),
            );
            expect(error).toBeInstanceOf(SmithersError);
            expect(error.code).toBe("DB_MISSING_COLUMNS");
        } finally {
            cleanup();
        }
    });

    test("rejected runPromise carries the SmithersError, not an unrelated throw", async () => {
        const { db, cleanup } = createTestDb();
        try {
            let caught;
            try {
                await Effect.runPromise(loadInputEffect(db, noRunIdTable, "run-1"));
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeDefined();
            // Effect wraps failures, so assert the SmithersError is reachable.
            const message = caught instanceof Error ? caught.message : String(caught);
            expect(message).toContain("schema.input must include runId column");
        } finally {
            cleanup();
        }
    });
});
