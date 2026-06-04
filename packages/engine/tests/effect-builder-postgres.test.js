/**
 * End-to-end coverage of the PostgreSQL/PGlite backends for the Effect-native
 * builder (Smithers.workflow().execute()). Mirrors the SQLite execute tests in
 * effect-builder-runtime.test.js but provides Smithers.postgres()/Smithers.pglite()
 * instead of Smithers.sqlite(), exercising the whole durable path on Postgres:
 * schema init, step execution, output persistence, and final result extraction.
 *
 * Defaults to a self-contained embedded PGlite. Set SMITHERS_TEST_PG_URL to run
 * against a real PostgreSQL (faster); each test uses a unique runId so runs do
 * not collide in shared tables.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Smithers } from "../src/effect/builder.js";

setDefaultTimeout(180_000);

const PG_URL = process.env.SMITHERS_TEST_PG_URL;

const inputSchema = Schema.Struct({
    repo: Schema.String,
    sha: Schema.String,
});
const outputSchema = Schema.Struct({
    value: Schema.String,
});

function dbLayer() {
    return PG_URL ? Smithers.postgres({ connectionString: PG_URL }) : Smithers.pglite({});
}

function uniqueRunId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${process.pid}`;
}

describe("Smithers.workflow execute (postgres)", () => {
    test("executes a finished builder workflow and extracts the final output", async () => {
        const G = Smithers.workflow({ name: "pg-builder-finished", input: inputSchema });
        const step = G.step("build", {
            output: outputSchema,
            run: ({ input }) => ({ value: `${input.repo}@${input.sha}` }),
        });
        const wf = G.from(step);
        const result = await Effect.runPromise(
            wf
                .execute({ repo: "smithers", sha: "abc123" }, { runId: uniqueRunId("pg-finished") })
                .pipe(Effect.provide(dbLayer())),
        );
        expect(result).toEqual({ value: "smithers@abc123" });
    });

    test("returns waiting approval results from builder workflow execution", async () => {
        const G = Smithers.workflow({ name: "pg-builder-approval", input: inputSchema });
        const wf = G.from(G.approval("gate", { request: () => ({ title: "Approve" }) }));
        const runId = uniqueRunId("pg-approval");
        const result = await Effect.runPromise(
            wf.execute({ repo: "smithers", sha: "abc123" }, { runId }).pipe(Effect.provide(dbLayer())),
        );
        expect(result.status).toBe("waiting-approval");
        expect(result.runId).toBe(runId);
    });

    test("normalizes failed builder workflow execution", async () => {
        const G = Smithers.workflow({ name: "pg-builder-failed", input: inputSchema });
        const wf = G.from(
            G.step("bad", {
                output: outputSchema,
                run: () => {
                    throw new Error("builder exploded");
                },
            }),
        );
        await expect(
            Effect.runPromise(
                wf
                    .execute({ repo: "smithers", sha: "abc123" }, { runId: uniqueRunId("pg-failed") })
                    .pipe(Effect.provide(dbLayer())),
            ),
        ).rejects.toThrow('status "failed"');
    });
});
