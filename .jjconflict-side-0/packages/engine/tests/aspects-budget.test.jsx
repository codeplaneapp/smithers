/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Approval, Aspects, Sequence, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { approveNode } from "../src/approvals.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";

const schemas = {
    outputA: z.object({ value: z.number() }),
    outputB: z.object({ value: z.number() }),
    approval: z.object({ approved: z.boolean() }),
};

/**
 * A fake agent that reports a fixed token usage so budgets trip deterministically.
 * @param {unknown} output
 * @param {{ inputTokens?: number; outputTokens?: number }} usage
 */
function usageAgent(output, usage) {
    return {
        id: "usage-agent",
        model: "claude-opus-4-8",
        tools: {},
        generate: async () => ({ output, usage }),
    };
}

/** Two sequential agent tasks, each reporting 120 tokens, wrapped in one Aspects. */
function twoTaskWorkflow(smithers, outputs, aspectsProps) {
    return smithers(() => (
        <Workflow name="budget-two-task">
            <Aspects {...aspectsProps}>
                <Sequence>
                    <Task id="t1" output={outputs.outputA} agent={usageAgent({ value: 1 }, { inputTokens: 60, outputTokens: 60 })}>
                        run
                    </Task>
                    <Task id="t2" output={outputs.outputB} agent={usageAgent({ value: 2 }, { inputTokens: 60, outputTokens: 60 })}>
                        run
                    </Task>
                </Sequence>
            </Aspects>
        </Workflow>
    ));
}

describe("Aspects budget enforcement (engine)", () => {
    test("onExceeded: fail — second task trips the token budget and fails the run", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
        try {
            const workflow = twoTaskWorkflow(smithers, outputs, {
                tokenBudget: { max: 100, onExceeded: "fail" },
            });
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("failed");
            expect(result.error?.code).toBe("ASPECT_BUDGET_EXCEEDED");
            expect(result.error?.details?.kind).toBe("tokens");
            // First task ran; second never produced output.
            const rowsA = await db.select().from(tables.outputA);
            const rowsB = await db.select().from(tables.outputB);
            expect(rowsA.map((r) => r.value)).toEqual([1]);
            expect(rowsB).toHaveLength(0);
        }
        finally {
            cleanup();
        }
    });

    test("onExceeded: warn — over-budget task still runs", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
        try {
            const workflow = twoTaskWorkflow(smithers, outputs, {
                tokenBudget: { max: 100, onExceeded: "warn" },
            });
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            const rowsA = await db.select().from(tables.outputA);
            const rowsB = await db.select().from(tables.outputB);
            expect(rowsA.map((r) => r.value)).toEqual([1]);
            expect(rowsB.map((r) => r.value)).toEqual([2]);
        }
        finally {
            cleanup();
        }
    });

    test("onExceeded: skip-remaining — over-budget task is skipped, run finishes", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
        try {
            const workflow = twoTaskWorkflow(smithers, outputs, {
                tokenBudget: { max: 100, onExceeded: "skip-remaining" },
            });
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            const rowsA = await db.select().from(tables.outputA);
            const rowsB = await db.select().from(tables.outputB);
            expect(rowsA.map((r) => r.value)).toEqual([1]);
            expect(rowsB).toHaveLength(0);
            const adapter = new SmithersDb(db);
            const t2 = await Effect.runPromise(adapter.getNode(result.runId, "t2", 0));
            expect(t2?.state).toBe("skipped");
        }
        finally {
            cleanup();
        }
    });

    test("accumulated usage survives resume and still enforces the budget", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
        try {
            const workflow = smithers(() => (
                <Workflow name="budget-resume">
                    <Aspects tokenBudget={{ max: 100, onExceeded: "skip-remaining" }}>
                        <Sequence>
                            <Task id="t1" output={outputs.outputA} agent={usageAgent({ value: 1 }, { inputTokens: 60, outputTokens: 60 })}>
                                run
                            </Task>
                            <Approval id="gate" output={outputs.approval} request={{ title: "continue?" }} />
                            <Task id="t2" output={outputs.outputB} agent={usageAgent({ value: 2 }, { inputTokens: 60, outputTokens: 60 })}>
                                run
                            </Task>
                        </Sequence>
                    </Aspects>
                </Workflow>
            ));

            // Run 1: t1 runs (120 tokens, persisted), then pauses at the approval gate.
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-approval");
            const rowsAfterFirst = await db.select().from(tables.outputA);
            expect(rowsAfterFirst.map((r) => r.value)).toEqual([1]);

            // Approve and resume in a fresh engine invocation: the tracker re-seeds
            // its 120 accumulated tokens from persisted events, so t2 is skipped.
            const adapter = new SmithersDb(db);
            await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "ok", "tester"));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            const rowsB = await db.select().from(tables.outputB);
            expect(rowsB).toHaveLength(0);
            const t2 = await Effect.runPromise(adapter.getNode(first.runId, "t2", 0));
            expect(t2?.state).toBe("skipped");
        }
        finally {
            cleanup();
        }
    }, 20000);
});

describe("Aspects budget enforcement (legacy engine)", () => {
    const LEGACY = { __smithersEngineMode: "legacy" };

    test("onExceeded: fail fails the run with ASPECT_BUDGET_EXCEEDED", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
        try {
            const workflow = twoTaskWorkflow(smithers, outputs, {
                tokenBudget: { max: 100, onExceeded: "fail" },
            });
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, ...LEGACY }));
            expect(result.status).toBe("failed");
            expect(result.error?.code).toBe("ASPECT_BUDGET_EXCEEDED");
            const rowsB = await db.select().from(tables.outputB);
            expect(rowsB).toHaveLength(0);
        }
        finally {
            cleanup();
        }
    });

    test("onExceeded: skip-remaining skips the over-budget task", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
        try {
            const workflow = twoTaskWorkflow(smithers, outputs, {
                tokenBudget: { max: 100, onExceeded: "skip-remaining" },
            });
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, ...LEGACY }));
            expect(result.status).toBe("finished");
            const rowsA = await db.select().from(tables.outputA);
            const rowsB = await db.select().from(tables.outputB);
            expect(rowsA.map((r) => r.value)).toEqual([1]);
            expect(rowsB).toHaveLength(0);
            const adapter = new SmithersDb(db);
            const t2 = await Effect.runPromise(adapter.getNode(result.runId, "t2", 0));
            expect(t2?.state).toBe("skipped");
        }
        finally {
            cleanup();
        }
    });
});
