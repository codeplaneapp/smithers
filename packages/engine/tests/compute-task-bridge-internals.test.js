import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { TaskHeartbeatTimeout } from "@smithers-orchestrator/errors/TaskHeartbeatTimeout";
import { defineTool } from "@smithers-orchestrator/tool-context";
import { archiveDiscardedEffects } from "@smithers-orchestrator/time-travel/archiveDiscardedEffects";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import {
    __computeTaskBridgeInternals as I,
    canExecuteBridgeManagedComputeTask,
    executeComputeTaskBridge,
} from "../src/effect/compute-task-bridge.js";

function makeHarness() {
    const api = createTestSmithers(outputSchemas);
    ensureSmithersTables(api.db);
    return {
        ...api,
        adapter: new SmithersDb(api.db),
    };
}

function makeEventBus({ failFlush = false } = {}) {
    const events = [];
    return {
        events,
        emitEventWithPersist: (event) => Effect.sync(() => {
            events.push(event);
        }),
        emitEventQueued: async (event) => {
            events.push(event);
        },
        flush: () => failFlush ? Effect.fail(new Error("flush boom")) : Effect.void,
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

function makeDesc(tables, overrides = {}) {
    return {
        nodeId: "compute",
        ordinal: 0,
        iteration: 0,
        outputTable: tables.outputA,
        outputTableName: "output_a",
        outputSchema: outputSchemas.outputA,
        needsApproval: false,
        skipIf: false,
        retries: 0,
        timeoutMs: null,
        heartbeatTimeoutMs: null,
        continueOnFail: false,
        computeFn: () => ({ value: 1 }),
        ...overrides,
    };
}

async function runBridge({ descOverrides = {}, eventBus = makeEventBus(), signal } = {}) {
    const harness = makeHarness();
    const desc = makeDesc(harness.tables, descOverrides);
    await Effect.runPromise(harness.adapter.insertRun({
        runId: descOverrides.runId ?? "run",
        workflowName: "compute-bridge-internals",
        status: "running",
        runtimeOwnerId: "compute-bridge-owner",
        createdAtMs: Date.now(),
    }));
    await executeComputeTaskBridge(
        harness.adapter,
        harness.db,
        descOverrides.runId ?? "run",
        desc,
        eventBus,
        { rootDir: process.cwd() },
        "compute-bridge-internals",
        signal,
    );
    return { ...harness, desc, eventBus, runId: descOverrides.runId ?? "run" };
}

describe("compute task bridge pure helpers", () => {
    test("classifies abort, heartbeat and execution capability helpers", () => {
        expect(I.isAbortError(null)).toBe(false);
        expect(I.isAbortError(new SmithersError("TASK_ABORTED", "stop"))).toBe(true);
        expect(I.isAbortError({ code: "TASK_ABORTED" })).toBe(true);
        expect(I.isAbortError({ _tag: "TaskAborted", message: "tagged stop" })).toBe(true);
        expect(I.isAbortError({ name: "AbortError" })).toBe(true);
        expect(I.isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
        expect(I.isAbortError(new Error("operation aborted"))).toBe(true);
        expect(I.isAbortError(new Error("plain failure"))).toBe(false);
        expect(I.isAbortError("plain")).toBe(false);

        expect(I.parseAttemptHeartbeatData(null)).toBeNull();
        expect(I.parseAttemptHeartbeatData("")).toBeNull();
        expect(I.parseAttemptHeartbeatData("{")).toBeNull();
        expect(I.parseAttemptHeartbeatData('{"cursor":1}')).toEqual({ cursor: 1 });

        const timeout = new TaskHeartbeatTimeout({
            message: "stale",
            nodeId: "node",
            iteration: 0,
            attempt: 1,
            timeoutMs: 10,
            staleForMs: 20,
            lastHeartbeatAtMs: 1,
        });
        const controller = new AbortController();
        controller.abort(timeout);
        expect(I.heartbeatTimeoutReasonFromAbort(controller.signal, new Error("ignored"))).toBe(timeout);
        expect(I.heartbeatTimeoutReasonFromAbort(undefined, new SmithersError("TASK_HEARTBEAT_TIMEOUT", "stale"))).toBeInstanceOf(SmithersError);
        expect(I.heartbeatTimeoutReasonFromAbort(undefined, {
            _tag: "TaskHeartbeatTimeout",
            message: "tagged",
            nodeId: "node",
            iteration: 0,
            attempt: 1,
            timeoutMs: 10,
            staleForMs: 20,
            lastHeartbeatAtMs: 1,
        })).toBeInstanceOf(SmithersError);
        expect(I.heartbeatTimeoutReasonFromAbort(undefined, {
            code: "TASK_HEARTBEAT_TIMEOUT",
            message: "plain",
            details: { nodeId: "node" },
        })).toBeInstanceOf(SmithersError);
        expect(I.heartbeatTimeoutReasonFromAbort(undefined, new Error("other"))).toBeNull();

        const alreadyAborted = new AbortController();
        alreadyAborted.abort(new Error("already aborted"));
        const linkedAlready = new AbortController();
        I.linkEffectAbortSignal(linkedAlready, alreadyAborted.signal)();
        expect(linkedAlready.signal.aborted).toBe(true);
        const linkedLater = new AbortController();
        const sourceLater = new AbortController();
        const removeLater = I.linkEffectAbortSignal(linkedLater, sourceLater.signal);
        sourceLater.abort(new Error("later aborted"));
        removeLater();
        expect(linkedLater.signal.aborted).toBe(true);

        expect(I.isHeartbeatPayloadValidationError(new SmithersError("HEARTBEAT_PAYLOAD_TOO_LARGE", "large"))).toBe(true);
        expect(I.isHeartbeatPayloadValidationError({ code: "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" })).toBe(true);
        expect(I.isHeartbeatPayloadValidationError({ code: "OTHER" })).toBe(false);
        expect(I.isHeartbeatPayloadValidationError(null)).toBe(false);

        expect(canExecuteBridgeManagedComputeTask({ computeFn: () => ({}) }, false)).toBe(true);
        expect(canExecuteBridgeManagedComputeTask({ computeFn: () => ({}) }, true)).toBe(false);
        expect(canExecuteBridgeManagedComputeTask({ computeFn: () => ({}), cachePolicy: {} }, false)).toBe(false);
        expect(canExecuteBridgeManagedComputeTask({ computeFn: () => ({}), sideEffect: { idempotent: false } }, false)).toBe(false);
        expect(canExecuteBridgeManagedComputeTask({ computeFn: null }, false)).toBe(false);
        expect(canExecuteBridgeManagedComputeTask({ computeFn: () => ({}), agent: {} }, false)).toBe(false);
        expect(canExecuteBridgeManagedComputeTask({ computeFn: () => ({}), worktreePath: "/tmp/wt" }, false)).toBe(false);
        expect(canExecuteBridgeManagedComputeTask({ computeFn: () => ({}), scorers: { score: {} } }, false)).toBe(false);
    });

    test("validates and serializes heartbeat payloads", () => {
        expect(I.serializeHeartbeatPayload({ ok: true, count: 1, nested: [null, "x"], at: new Date(0) })).toMatchObject({
            heartbeatDataJson: expect.any(String),
            dataSizeBytes: expect.any(Number),
        });
        expect(() => I.validateHeartbeatValue(Number.NaN, "$.n", new Set())).toThrow("finite numbers");
        expect(() => I.validateHeartbeatValue(undefined, "$.missing", new Set())).toThrow("undefined");
        expect(() => I.validateHeartbeatValue(1n, "$.big", new Set())).toThrow("non-JSON");
        expect(() => I.validateHeartbeatValue(Symbol("s"), "$.sym", new Set())).toThrow("non-JSON");
        expect(() => I.validateHeartbeatValue(() => { }, "$.fn", new Set())).toThrow("non-JSON");
        class CustomPayload { }
        expect(() => I.validateHeartbeatValue(new CustomPayload(), "$.custom", new Set())).toThrow("plain JSON");
        const circular = {};
        circular.self = circular;
        expect(() => I.validateHeartbeatValue(circular, "$", new Set())).toThrow("circular");
        expect(() => I.serializeHeartbeatPayload("x".repeat(I.TASK_HEARTBEAT_MAX_PAYLOAD_BYTES + 1))).toThrow("exceeds");
    });
});

describe("compute task bridge execution branches", () => {
    test("cancels immediately when the external signal is already aborted", async () => {
        const unhandled = [];
        const onUnhandled = (reason) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        const controller = new AbortController();
        controller.abort(new Error("operator stop"));
        const result = await runBridge({
            descOverrides: { nodeId: "pre-aborted", runId: "pre-aborted-run" },
            signal: controller.signal,
        });
        try {
            const attempts = await Effect.runPromise(result.adapter.listAttempts(result.runId, "pre-aborted", 0));
            expect(attempts[0]?.state).toBe("cancelled");
            expect(result.eventBus.events.map((event) => event.type)).toContain("NodeCancelled");
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(unhandled).toHaveLength(0);
        }
        finally {
            process.off("unhandledRejection", onUnhandled);
            result.cleanup();
        }
    });

    test("marks schema-validation failures as non-retryable", async () => {
        const result = await runBridge({
            descOverrides: {
                nodeId: "bad-schema",
                runId: "bad-schema-run",
                outputSchema: z.object({ value: z.string() }),
                computeFn: () => ({ value: 1 }),
                retries: 3,
            },
        });
        try {
            const attempts = await Effect.runPromise(result.adapter.listAttempts(result.runId, "bad-schema", 0));
            expect(attempts[0]?.state).toBe("failed");
            expect(JSON.parse(attempts[0]?.metaJson ?? "{}").failureRetryable).toBe(false);
            expect(JSON.parse(attempts[0]?.errorJson ?? "{}").code).toBe("INVALID_OUTPUT");
        }
        finally {
            result.cleanup();
        }
    });

    test("records flush failures through the task failure path", async () => {
        const eventBus = makeEventBus({ failFlush: true });
        const result = await runBridge({
            eventBus,
            descOverrides: {
                nodeId: "flush-fails",
                runId: "flush-fails-run",
                computeFn: () => ({ value: 2 }),
            },
        });
        try {
            const attempts = await Effect.runPromise(result.adapter.listAttempts(result.runId, "flush-fails", 0));
            expect(attempts[0]?.state).toBe("failed");
            expect(JSON.parse(attempts[0]?.errorJson ?? "{}").message).toContain("flush boom");
        }
        finally {
            result.cleanup();
        }
    });

    test("continues when heartbeat persistence fails", async () => {
        const harness = makeHarness();
        const eventBus = makeEventBus();
        await harness.adapter.insertRun({
            runId: "heartbeat-write-fails-run",
            workflowName: "compute-bridge-internals",
            workflowHash: "test",
            status: "running",
            createdAtMs: Date.now(),
        });
        const desc = makeDesc(harness.tables, {
            nodeId: "heartbeat-write-fails",
            computeFn: () => {
                requireTaskRuntime().heartbeat({ cursor: "page-1" });
                return { value: 3 };
            },
        });
        const originalHeartbeatAttempt = harness.adapter.heartbeatAttempt.bind(harness.adapter);
        harness.adapter.heartbeatAttempt = () => Effect.fail(new Error("heartbeat write failed"));
        try {
            await executeComputeTaskBridge(
                harness.adapter,
                harness.db,
                "heartbeat-write-fails-run",
                desc,
                eventBus,
                { rootDir: process.cwd() },
                "compute-bridge-internals",
            );
            const attempts = await Effect.runPromise(harness.adapter.listAttempts("heartbeat-write-fails-run", "heartbeat-write-fails", 0));
            expect(attempts[0]?.state).toBe("finished");
            expect(eventBus.events.map((event) => event.type)).toContain("NodeFinished");
        }
        finally {
            harness.adapter.heartbeatAttempt = originalHeartbeatAttempt;
            harness.cleanup();
        }
    });

    test("records heartbeat-watchdog task failures before the watchdog times out", async () => {
        const result = await runBridge({
            descOverrides: {
                nodeId: "heartbeat-task-fails",
                runId: "heartbeat-task-fails-run",
                heartbeatTimeoutMs: 500,
                computeFn: () => {
                    throw new Error("failed before stale");
                },
            },
        });
        try {
            const attempts = await Effect.runPromise(result.adapter.listAttempts(result.runId, "heartbeat-task-fails", 0));
            expect(attempts[0]?.state).toBe("failed");
            expect(JSON.parse(attempts[0]?.errorJson ?? "{}").message).toContain("failed before stale");
        }
        finally {
            result.cleanup();
        }
    });

    test("marks intended compute-tool rows unknown when the compute task fails", async () => {
        const entered = deferred();
        const hangingTool = defineTool({
            name: "compute-failure-in-flight",
            schema: z.object({}),
            sideEffect: true,
            idempotent: false,
            execute: async (_input, _context) => {
                entered.resolve();
                await new Promise(() => {});
            },
        });
        const result = await runBridge({
            descOverrides: {
                nodeId: "compute-tool-failure",
                runId: "compute-tool-failure-run",
                computeFn: async () => {
                    void hangingTool.execute({});
                    await entered.promise;
                    throw new Error("compute failed while tool was in flight");
                },
            },
        });
        try {
            const rows = await Effect.runPromise(result.adapter.listToolCalls(
                result.runId,
                "compute-tool-failure",
                0,
            ));
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                toolName: "compute-failure-in-flight",
                status: "unknown",
                errorJson: expect.stringContaining("compute failed while tool was in flight"),
            });
        }
        finally {
            result.cleanup();
        }
    });

    test("bridge stale completion is token-fenced after primary-key reuse", async () => {
        const entered = deferred();
        const release = deferred();
        let staleCompletion;
        let receivedSignal;
        const hangingTool = defineTool({
            name: "bridge-late-completion",
            schema: z.object({}),
            sideEffect: true,
            idempotent: false,
            execute: async (_input, context) => {
                receivedSignal = context.signal;
                entered.resolve();
                await release.promise;
                return { generation: "stale" };
            },
        });
        const result = await runBridge({
            descOverrides: {
                nodeId: "bridge-late-completion",
                runId: "bridge-late-completion-run",
                computeFn: async () => {
                    staleCompletion = hangingTool.execute({});
                    await entered.promise;
                    throw new Error("compute failed while bridge tool was in flight");
                },
            },
        });
        try {
            expect(receivedSignal).toBeInstanceOf(AbortSignal);
            const staleRow = (await Effect.runPromise(result.adapter.listToolCalls(
                result.runId,
                "bridge-late-completion",
                0,
            )))[0];
            const staleCallToken = String(staleRow.callToken);
            expect(staleRow).toMatchObject({
                status: "unknown",
                callToken: expect.any(String),
            });
            await archiveDiscardedEffects(result.adapter, {
                runId: result.runId,
                opId: "bridge-rewind",
                archivedAtMs: Date.now(),
                archiveReason: "rewind",
                attempts: [{
                    nodeId: "bridge-late-completion",
                    iteration: 0,
                    attempt: 1,
                }],
            });
            const freshCallToken = crypto.randomUUID();
            await Effect.runPromise(result.adapter.insertToolCall({
                ...staleRow,
                callToken: freshCallToken,
                inputJson: '{"generation":"fresh"}',
                outputJson: null,
                startedAtMs: Date.now(),
                finishedAtMs: null,
                status: "intended",
                errorJson: null,
                revertStatus: null,
                revertedAtMs: null,
                revertErrorJson: null,
                forcedPastJson: null,
            }));

            release.resolve();
            await staleCompletion;

            expect(await result.adapter.internalStorage.queryOne(
                `SELECT status, output_json FROM _smithers_tool_calls WHERE call_token = ?`,
                [freshCallToken],
            )).toEqual({ status: "intended", outputJson: null });
            expect(await result.adapter.internalStorage.queryOne(
                `SELECT status, output_json FROM _smithers_tool_call_archive WHERE call_token = ?`,
                [staleCallToken],
            )).toEqual({ status: "succeeded", outputJson: '{"generation":"stale"}' });
            expect(await Effect.runPromise(result.adapter.listEventsByType(
                result.runId,
                "SideEffectBoundaryCrossed",
            ))).toHaveLength(1);
        }
        finally {
            release.resolve();
            await staleCompletion?.catch(() => undefined);
            result.cleanup();
        }
    });

    test("marks intended compute-tool rows unknown when the compute task is cancelled", async () => {
        const entered = deferred();
        let receivedSignal;
        const hangingTool = defineTool({
            name: "compute-cancel-in-flight",
            schema: z.object({}),
            sideEffect: true,
            idempotent: false,
            execute: async (_input, context) => {
                receivedSignal = context.signal;
                entered.resolve();
                await new Promise((_, reject) => {
                    if (context.signal?.aborted) {
                        reject(context.signal.reason);
                        return;
                    }
                    context.signal?.addEventListener("abort", () => reject(context.signal.reason), {
                        once: true,
                    });
                });
            },
        });
        const controller = new AbortController();
        const running = runBridge({
            descOverrides: {
                nodeId: "compute-tool-cancel",
                runId: "compute-tool-cancel-run",
                computeFn: async () => await hangingTool.execute({}),
            },
            signal: controller.signal,
        });
        await entered.promise;
        controller.abort(new Error("cancel compute with tool in flight"));
        const result = await running;
        try {
            expect(receivedSignal).toBeInstanceOf(AbortSignal);
            expect(receivedSignal.aborted).toBe(true);
            const rows = await Effect.runPromise(result.adapter.listToolCalls(
                result.runId,
                "compute-tool-cancel",
                0,
            ));
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                toolName: "compute-cancel-in-flight",
                status: "unknown",
                errorJson: expect.stringContaining("cancel compute with tool in flight"),
            });
        }
        finally {
            result.cleanup();
        }
    });
});
