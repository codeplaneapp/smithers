import { describe, expect, test } from "bun:test";
import { Context, Effect } from "effect";
import {
    __singleRunnerInternals as I,
    dispatchWorkerTask,
    subscribeTaskWorkerDispatches,
} from "../src/effect/single-runner.js";

function makeTask(overrides = {}) {
    return {
        executionId: "exec",
        bridgeKey: "bridge",
        workflowName: "workflow",
        runId: "run",
        nodeId: "node",
        iteration: 0,
        retries: 0,
        taskKind: "compute",
        dispatchKind: "compute",
        ...overrides,
    };
}

describe("single runner internals", () => {
    test("notifies dispatch subscribers and ignores subscriber failures", () => {
        const received = [];
        const unsubscribe = subscribeTaskWorkerDispatches((task) => received.push(task.executionId));
        const unsubscribeThrowing = subscribeTaskWorkerDispatches(() => {
            throw new Error("observer failed");
        });
        try {
            I.notifyDispatchSubscribers(makeTask({ executionId: "notify" }));
            expect(received).toEqual(["notify"]);
        }
        finally {
            unsubscribe();
            unsubscribeThrowing();
        }
    });

    test("builds and consumes worker task errors", () => {
        const task = makeTask({ executionId: "missing-exec" });
        expect(I.buildMissingExecutionResult(task)).toEqual({
            _tag: "Failure",
            executionId: "missing-exec",
            error: {
                _tag: "UnknownWorkerError",
                errorId: "missing:missing-exec",
                message: "No worker execution registered for missing-exec",
            },
        });
        const tagged = { _tag: "TaskAborted", message: "aborted" };
        expect(I.toWorkerTaskError("tagged", tagged)).toEqual({
            _tag: "TaskAborted",
            message: "aborted",
            details: undefined,
            name: undefined,
        });
        const unknownError = new Error("boom");
        const unknown = I.toWorkerTaskError("unknown", unknownError);
        expect(unknown).toMatchObject({
            _tag: "UnknownWorkerError",
            errorId: "unknown:error",
            message: "boom",
        });
        expect(I.consumeWorkerError({ _tag: "Failure", executionId: "tagged", error: tagged })._tag).toBe("TaskAborted");
        expect(I.consumeWorkerError({ _tag: "Failure", executionId: "unknown", error: unknown })).toBe(unknownError);
        expect(I.consumeWorkerError({
            _tag: "Failure",
            executionId: "missing",
            error: {
                _tag: "UnknownWorkerError",
                errorId: "missing:error",
                message: "missing fallback",
            },
        }).message).toBe("missing fallback");
    });

    test("runs registered executions through success, failure and missing paths", async () => {
        const successTask = makeTask({ executionId: "success" });
        I.workerExecutions.set("success", {
            task: successTask,
            execute: async () => ({ terminal: true }),
        });
        expect(await I.runRegisteredExecution(successTask)).toEqual({
            _tag: "Success",
            executionId: "success",
            terminal: true,
        });
        expect(I.workerExecutions.has("success")).toBe(false);

        const failureTask = makeTask({ executionId: "failure" });
        I.workerExecutions.set("failure", {
            task: failureTask,
            execute: async () => {
                throw new Error("worker failed");
            },
        });
        const failed = await I.runRegisteredExecution(failureTask);
        expect(failed._tag).toBe("Failure");
        expect(failed.error).toMatchObject({
            _tag: "UnknownWorkerError",
            message: "worker failed",
        });
        expect(I.workerExecutions.has("failure")).toBe(false);

        expect(await I.runRegisteredExecution(makeTask({ executionId: "missing" }))).toMatchObject({
            _tag: "Failure",
            error: {
                _tag: "UnknownWorkerError",
                errorId: "missing:missing",
            },
        });
    });

    test("dispatches worker tasks and surfaces registered execution failures", async () => {
        const task = makeTask({ executionId: "dispatch-success", bridgeKey: "dispatch-bridge" });
        expect(await dispatchWorkerTask(task, async () => ({ terminal: false }))).toEqual({ terminal: false });

        const failedTask = makeTask({ executionId: "dispatch-failure", bridgeKey: "dispatch-bridge" });
        await expect(dispatchWorkerTask(failedTask, async () => {
            throw new Error("dispatch failed");
        })).rejects.toThrow("dispatch failed");

        const fakeTask = makeTask({ executionId: "fake-runtime", bridgeKey: "fake-bridge" });
        I.setSingleRunnerRuntimePromiseForTest(Promise.resolve({
            context: Context.empty(),
            client: () => ({
                execute: () => Effect.succeed({
                    _tag: "Success",
                    executionId: "fake-runtime",
                    terminal: true,
                }),
            }),
        }));
        try {
            expect(await dispatchWorkerTask(fakeTask, async () => ({ terminal: false }))).toEqual({ terminal: true });
            expect(I.workerExecutions.has("fake-runtime")).toBe(false);
        }
        finally {
            I.setSingleRunnerRuntimePromiseForTest(undefined);
        }
    }, 30_000);

    test("resets the cached runtime promise when runtime construction fails", async () => {
        I.setSingleRunnerRuntimePromiseForTest(undefined);
        await expect(I.getSingleRunnerRuntimeFromBuilder(async () => {
            throw new Error("runtime unavailable");
        })).rejects.toThrow("runtime unavailable");
        expect(await I.getSingleRunnerRuntimeFromBuilder(async () => ({
            context: Context.empty(),
            client: () => ({
                execute: () => Effect.succeed({
                    _tag: "Success",
                    executionId: "recovered",
                    terminal: true,
                }),
            }),
        }))).toBeDefined();
        I.setSingleRunnerRuntimePromiseForTest(undefined);
    });
});
