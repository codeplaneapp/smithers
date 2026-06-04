/** @jsxImportSource smithers-orchestrator */
/**
 * PostgreSQL/PGlite coverage for the createSmithers JSX API
 * (createSmithersPostgres). The JSX API differs from the Effect-native builder:
 * it generates per-Zod-schema output tables with individual columns (not a single
 * `payload` blob) and is driven through runWorkflow directly. These tests prove
 * the same surface — single task, sequence, ralph iteration — works on Postgres,
 * exercising the dialect-aware engine reads/writes and the Postgres-typed DDL
 * derived from the Zod schemas.
 *
 * Set SMITHERS_TEST_PG_URL to run against a real PostgreSQL (recommended);
 * otherwise an embedded PGlite is booted.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { Effect } from "effect";
import { ContinueAsNew, Ralph, Sequence, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createSmithersPostgres } from "../../smithers/src/create.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { loadRunOutputRowsEffect } from "@smithers-orchestrator/db/snapshot";

setDefaultTimeout(180_000);

const PG_URL = process.env.SMITHERS_TEST_PG_URL;

const outputSchemas = {
    outputA: z.object({ value: z.number() }),
    outputB: z.object({ value: z.number() }),
};

async function makeApi() {
    return PG_URL
        ? createSmithersPostgres(outputSchemas, { provider: "postgres", connectionString: PG_URL })
        : createSmithersPostgres(outputSchemas, { provider: "pglite" });
}

function uniqueRunId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${process.pid}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Read all rows of an output table for a run via the dialect-aware helper. */
async function readRows(api, table, runId) {
    return Effect.runPromise(loadRunOutputRowsEffect(api.db, table, runId));
}

describe("createSmithers (postgres)", () => {
    test("runs a single task and persists its output to individual columns", async () => {
        const api = await makeApi();
        try {
            const runId = uniqueRunId("cs-pg-task");
            const workflow = api.smithers(() => (
                <Workflow name="cs-pg-task">
                    <Task id="step" output={api.outputs.outputA}>
                        {{ value: 42 }}
                    </Task>
                </Workflow>
            ));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(result.status).toBe("finished");
            const rows = await readRows(api, api.tables.outputA, runId);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ runId, nodeId: "step", iteration: 0, value: 42 });
        } finally {
            await api.close();
        }
    });

    test("runs a sequence of dependent tasks", async () => {
        const api = await makeApi();
        try {
            const runId = uniqueRunId("cs-pg-seq");
            const workflow = api.smithers((ctx) => (
                <Workflow name="cs-pg-seq">
                    <Sequence>
                        <Task id="first" output={api.outputs.outputA}>
                            {{ value: 1 }}
                        </Task>
                        <Task id="second" output={api.outputs.outputB}>
                            {() => ({ value: (ctx.latest("outputA", "first")?.value ?? 0) + 10 })}
                        </Task>
                    </Sequence>
                </Workflow>
            ));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(result.status).toBe("finished");
            const aRows = await readRows(api, api.tables.outputA, runId);
            const bRows = await readRows(api, api.tables.outputB, runId);
            expect(aRows[0]).toMatchObject({ nodeId: "first", value: 1 });
            expect(bRows[0]).toMatchObject({ nodeId: "second", value: 11 });
        } finally {
            await api.close();
        }
    });

    test("iterates a Ralph loop until the output condition is met", async () => {
        const api = await makeApi();
        try {
            const runId = uniqueRunId("cs-pg-ralph");
            const workflow = api.smithers((ctx) => (
                <Workflow name="cs-pg-ralph">
                    <Ralph id="loop" until={ctx.outputs("outputA").length >= 2}>
                        <Task id="step" output={api.outputs.outputA}>
                            {{ value: ctx.outputs("outputA").length }}
                        </Task>
                    </Ralph>
                </Workflow>
            ));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(result.status).toBe("finished");
            const rows = await readRows(api, api.tables.outputA, runId);
            const iterations = rows.map((r) => r.iteration).sort((a, b) => a - b);
            expect(iterations).toEqual([0, 1]);
        } finally {
            await api.close();
        }
    });

    test("continue-as-new spawns a child run carrying the workflow payload", async () => {
        const api = PG_URL
            ? await createSmithersPostgres(
                { result: z.object({ cursor: z.string().nullable(), seenPayload: z.boolean() }) },
                { provider: "postgres", connectionString: PG_URL },
            )
            : await createSmithersPostgres(
                { result: z.object({ cursor: z.string().nullable(), seenPayload: z.boolean() }) },
                { provider: "pglite" },
            );
        try {
            const runId = uniqueRunId("cs-pg-can");
            const workflow = api.smithers((ctx) => {
                const continuation = ctx.input?.__smithersContinuation;
                const shouldContinue = !continuation?.payload;
                return (
                    <Workflow name="cs-pg-can">
                        <Sequence>
                            {shouldContinue ? <ContinueAsNew state={{ cursor: "abc" }} /> : null}
                            <Task id="result" output={api.outputs.result}>
                                {() => ({
                                    cursor: continuation?.payload?.cursor ?? null,
                                    seenPayload: Boolean(continuation?.payload),
                                })}
                            </Task>
                        </Sequence>
                    </Workflow>
                );
            });
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(result.status).toBe("finished");
            const adapter = new SmithersDb(api.db);
            const ancestry = await adapter.listRunAncestry(result.runId, 100);
            expect(ancestry.length).toBe(2);
            const latestRunId = ancestry[0].runId;
            const previousRunId = ancestry[1].runId;
            const previousRun = await adapter.getRun(previousRunId);
            expect(previousRun?.status).toBe("continued");
            const resultRows = await readRows(api, api.tables.result, latestRunId);
            expect(resultRows).toHaveLength(1);
            expect(resultRows[0].cursor).toBe("abc");
            expect(resultRows[0].seenPayload).toBe(true);
            const previousEvents = await adapter.listEvents(previousRunId, -1, 100);
            expect(previousEvents.some((event) => event.type === "RunContinuedAsNew")).toBe(true);
        } finally {
            await api.close();
        }
    });
});
