import { describe, expect, test } from "bun:test";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import {
    __workflowMakeBridgeInternals as I,
    createSchedulerWakeQueue,
    getWorkflowMakeBridgeRuntime,
    runWorkflowWithMakeBridge,
    withWorkflowMakeBridgeRuntime,
} from "../src/effect/workflow-make-bridge.js";

describe("workflow make bridge internals", () => {
    test("namespaces workflows and classifies suspending statuses", () => {
        const workflowA = {};
        const workflowB = {};
        expect(I.getWorkflowNamespace(workflowA)).toBe(I.getWorkflowNamespace(workflowA));
        expect(I.getWorkflowNamespace(workflowA)).not.toBe(I.getWorkflowNamespace(workflowB));
        expect(I.makeBridgeWorkflow(workflowA, "run").name).toContain("SmithersWorkflowBridge");
        expect(I.isSuspendingStatus("waiting-approval")).toBe(true);
        expect(I.isSuspendingStatus("waiting-event")).toBe(true);
        expect(I.isSuspendingStatus("waiting-timer")).toBe(true);
        expect(I.isSuspendingStatus("finished")).toBe(false);
    });

    test("scopes workflow make bridge runtime in async local storage", () => {
        const runtime = { marker: "runtime" };
        expect(getWorkflowMakeBridgeRuntime()).toBeUndefined();
        expect(withWorkflowMakeBridgeRuntime(runtime, () => getWorkflowMakeBridgeRuntime())).toBe(runtime);
        expect(getWorkflowMakeBridgeRuntime()).toBeUndefined();
    });

    test("scheduler wake queue handles pending and future notifications", async () => {
        const queue = createSchedulerWakeQueue();
        queue.notify();
        await queue.wait();

        let resolved = false;
        const waiting = queue.wait().then(() => {
            resolved = true;
        });
        await Promise.resolve();
        expect(resolved).toBe(false);
        queue.notify();
        await waiting;
        expect(resolved).toBe(true);
    });

    test("continues workflow execution with the next run id", async () => {
        const { db, cleanup } = createTestSmithers(outputSchemas);
        try {
            const workflow = { db };
            const calls = [];
            const result = await runWorkflowWithMakeBridge(workflow, { runId: "first-run" }, async (_workflow, opts) => {
                calls.push(opts);
                if (calls.length === 1) {
                    return {
                        runId: opts.runId,
                        status: "continued",
                        nextRunId: "second-run",
                    };
                }
                return {
                    runId: opts.runId,
                    status: "finished",
                };
            });
            expect(result).toEqual({
                runId: "second-run",
                status: "finished",
            });
            expect(calls).toEqual([
                expect.objectContaining({ runId: "first-run" }),
                expect.objectContaining({ runId: "second-run", resume: true }),
            ]);
        }
        finally {
            cleanup();
        }
    });

    test("throws failed workflow exits", async () => {
        const { db, cleanup } = createTestSmithers(outputSchemas);
        try {
            const workflow = { db };
            await expect(runWorkflowWithMakeBridge(workflow, { runId: "failed-run" }, async () => {
                throw new Error("body failed");
            })).rejects.toThrow();
        }
        finally {
            cleanup();
        }
    });
});
