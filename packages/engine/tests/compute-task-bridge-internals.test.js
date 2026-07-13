import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { TaskHeartbeatTimeout } from "@smithers-orchestrator/errors/TaskHeartbeatTimeout";
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
        const controller = new AbortController();
        controller.abort(new Error("operator stop"));
        const result = await runBridge({
            descOverrides: { nodeId: "pre-aborted", runId: "pre-aborted-run" },
            signal: controller.signal,
        });
        try {
            const attempts = await result.adapter.listAttempts(result.runId, "pre-aborted", 0);
            expect(attempts[0]?.state).toBe("cancelled");
            expect(result.eventBus.events.map((event) => event.type)).toContain("NodeCancelled");
        }
        finally {
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
            const attempts = await result.adapter.listAttempts(result.runId, "bad-schema", 0);
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
            const attempts = await result.adapter.listAttempts(result.runId, "flush-fails", 0);
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
            const attempts = await harness.adapter.listAttempts("heartbeat-write-fails-run", "heartbeat-write-fails", 0);
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
            const attempts = await result.adapter.listAttempts(result.runId, "heartbeat-task-fails", 0);
            expect(attempts[0]?.state).toBe("failed");
            expect(JSON.parse(attempts[0]?.errorJson ?? "{}").message).toContain("failed before stale");
        }
        finally {
            result.cleanup();
        }
    });
});
