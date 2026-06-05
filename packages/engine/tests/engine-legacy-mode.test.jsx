/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    Branch,
    Parallel,
    Ralph,
    Sequence,
    Task,
    Workflow,
    runWorkflow,
} from "smithers-orchestrator";
import { approveNode } from "../src/approvals.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";

const LEGACY_RUN_OPTIONS = { __smithersEngineMode: "legacy" };

function buildSmithers() {
    return createTestSmithers(outputSchemas);
}

function runLegacy(workflow, opts = {}) {
    return Effect.runPromise(runWorkflow(workflow, {
        input: {},
        ...opts,
        __smithersEngineMode: "legacy",
    }));
}

describe("legacy engine mode", () => {
    test("finishes sequence, parallel, branch and skipped tasks", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildSmithers();
        try {
            const workflow = smithers((_ctx) => (
                <Workflow name="legacy-graph-shapes">
                    <Sequence>
                        <Task id="first" output={outputs.outputA}>
                            {{ value: 1 }}
                        </Task>
                        <Parallel maxConcurrency={2}>
                            <Task id="left" output={outputs.outputB}>
                                {{ value: 2 }}
                            </Task>
                            <Task id="right" output={outputs.outputC}>
                                {{ value: 3 }}
                            </Task>
                        </Parallel>
                        <Branch
                            if={true}
                            then={<Task id="branch-yes" output={outputs.outputA}>
                                {{ value: 4 }}
                            </Task>}
                            else={<Task id="branch-no" output={outputs.outputB}>
                                {{ value: 5 }}
                            </Task>}
                        />
                        <Task id="skipped" output={outputs.outputC} skipIf>
                            {{ value: 6 }}
                        </Task>
                    </Sequence>
                </Workflow>
            ));

            const result = await runLegacy(workflow);

            expect(result.status).toBe("finished");
            const rowsA = await db.select().from(tables.outputA);
            const rowsB = await db.select().from(tables.outputB);
            const rowsC = await db.select().from(tables.outputC);
            expect(rowsA.map((row) => row.value).sort()).toEqual([1, 4]);
            expect(rowsB.map((row) => row.value)).toEqual([2]);
            expect(rowsC.map((row) => row.value)).toEqual([3]);
        }
        finally {
            cleanup();
        }
    });

    test("runs compute callbacks, retries failures and continues after allowed failure", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildSmithers();
        try {
            let calls = 0;
            const workflow = smithers((_ctx) => (
                <Workflow name="legacy-compute">
                    <Sequence>
                        <Task id="flaky" output={outputs.outputA} retries={2}>
                            {() => {
                                calls += 1;
                                if (calls < 2)
                                    throw new Error("try again");
                                return { value: calls };
                            }}
                        </Task>
                        <Task id="bomb" output={outputs.outputB} continueOnFail noRetry>
                            {() => {
                                throw new Error("allowed failure");
                            }}
                        </Task>
                        <Task id="after" output={outputs.outputC}>
                            {async () => {
                                await sleep(1);
                                return { value: 9 };
                            }}
                        </Task>
                    </Sequence>
                </Workflow>
            ));

            const result = await runLegacy(workflow);

            expect(result.status).toBe("finished");
            expect(calls).toBe(2);
            const rowsA = await db.select().from(tables.outputA);
            const rowsB = await db.select().from(tables.outputB);
            const rowsC = await db.select().from(tables.outputC);
            expect(rowsA[0].value).toBe(2);
            expect(rowsB).toEqual([]);
            expect(rowsC[0].value).toBe(9);
        }
        finally {
            cleanup();
        }
    });

    test("pauses for approval and resumes after approval", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildSmithers();
        try {
            const workflow = smithers((_ctx) => (
                <Workflow name="legacy-approval">
                    <Sequence>
                        <Task id="gate" output={outputs.outputA} needsApproval>
                            {{ value: 1 }}
                        </Task>
                        <Task id="after" output={outputs.outputB}>
                            {{ value: 2 }}
                        </Task>
                    </Sequence>
                </Workflow>
            ));

            const first = await runLegacy(workflow);
            expect(first.status).toBe("waiting-approval");

            const adapter = new SmithersDb(db);
            await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "ok", "test"));
            const resumed = await runLegacy(workflow, {
                runId: first.runId,
                resume: true,
            });

            expect(resumed.status).toBe("finished");
            const rowsB = await db.select().from(tables.outputB);
            expect(rowsB[0].value).toBe(2);
        }
        finally {
            cleanup();
        }
    });

    test("iterates Ralph loops in legacy mode", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildSmithers();
        try {
            const workflow = smithers((ctx) => (
                <Workflow name="legacy-ralph">
                    <Ralph id="loop" until={ctx.outputs("outputA").length >= 3}>
                        <Task id="step" output={outputs.outputA}>
                            {{ value: ctx.outputs("outputA").length }}
                        </Task>
                    </Ralph>
                </Workflow>
            ));

            const result = await runLegacy(workflow);

            expect(result.status).toBe("finished");
            const rows = await db.select().from(tables.outputA);
            expect(rows.map((row) => row.iteration).sort()).toEqual([0, 1, 2]);
        }
        finally {
            cleanup();
        }
    });

    test("records legacy duplicate task failures", async () => {
        const { smithers, outputs, cleanup } = buildSmithers();
        try {
            const workflow = smithers((_ctx) => (
                <Workflow name="legacy-duplicate">
                    <Sequence>
                        <Task id="same" output={outputs.outputA}>
                            {{ value: 1 }}
                        </Task>
                        <Task id="same" output={outputs.outputB}>
                            {{ value: 2 }}
                        </Task>
                    </Sequence>
                </Workflow>
            ));

            const result = await runLegacy(workflow, LEGACY_RUN_OPTIONS);

            expect(result.status).toBe("failed");
            expect(result.error?.message).toContain("Duplicate Task id detected");
        }
        finally {
            cleanup();
        }
    });
});
