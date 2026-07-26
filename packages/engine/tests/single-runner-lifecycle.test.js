import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Context, Effect } from "effect";
import {
    __singleRunnerInternals as I,
    acquireSingleRunnerRunLease,
    closeSingleRunnerRuntime,
    dispatchWorkerTask,
    reopenSingleRunnerRuntime,
} from "../src/effect/single-runner.js";

/**
 * #1378: `buildSingleRunnerRuntime` used to drop the Scope it created, so the
 * cluster daemon fibers pinned the event loop forever and a finite program
 * could never exit without `process.exit()`. These tests pin the public
 * teardown boundary and, crucially, the lease that stops a close from landing
 * between two retry attempts of a live run.
 */

function makeTask(overrides = {}) {
    return {
        executionId: "lifecycle-exec",
        bridgeKey: "lifecycle-bridge",
        workflowName: "workflow",
        runId: "lifecycle-run",
        nodeId: "node",
        iteration: 0,
        retries: 0,
        taskKind: "compute",
        dispatchKind: "compute",
        ...overrides,
    };
}

/**
 * A stand-in for a built runtime whose `dispose` records how often the layer
 * finalizers ran.
 */
function makeFakeRuntime(overrides = {}) {
    const disposals = [];
    return {
        disposals,
        runtime: {
            context: Context.empty(),
            client: () => ({
                execute: (task) => Effect.succeed({
                    _tag: "Success",
                    executionId: task.executionId,
                    terminal: true,
                }),
            }),
            dispose: async () => {
                disposals.push(Date.now());
                if (overrides.disposeError) {
                    throw overrides.disposeError;
                }
            },
        },
    };
}

// The single runner is a process-wide module singleton shared with every other
// engine test file, so snapshot whatever runtime is live and put it back.
let savedRuntimePromise;

beforeEach(() => {
    savedRuntimePromise = I.getSingleRunnerRuntimePromiseForTest();
    I.resetSingleRunnerLifecycleForTest();
});

afterEach(() => {
    I.resetSingleRunnerLifecycleForTest();
    if (savedRuntimePromise) {
        I.setSingleRunnerRuntimePromiseForTest(savedRuntimePromise);
    }
});

describe("single runner lifecycle", () => {
    test("closing before the runtime ever opened resolves and fences later work", async () => {
        expect(I.getSingleRunnerStateForTest()).toBe("idle");
        await closeSingleRunnerRuntime();
        expect(I.getSingleRunnerStateForTest()).toBe("closed");
        await expect(dispatchWorkerTask(makeTask(), async () => ({ terminal: true }))).rejects.toMatchObject({ code: "SINGLE_RUNNER_CLOSED" });
        expect(() => acquireSingleRunnerRunLease("late-run")).toThrow(/SINGLE_RUNNER_CLOSED|closed/);
    });

    test("concurrent and repeat closes share one promise object and dispose once", async () => {
        const { runtime, disposals } = makeFakeRuntime();
        I.setSingleRunnerRuntimePromiseForTest(Promise.resolve(runtime));
        const first = closeSingleRunnerRuntime();
        const second = closeSingleRunnerRuntime();
        expect(second).toBe(first);
        await Promise.all([first, second]);
        expect(closeSingleRunnerRuntime()).toBe(first);
        await closeSingleRunnerRuntime();
        expect(disposals.length).toBe(1);
        expect(I.getSingleRunnerStateForTest()).toBe("closed");
    });

    test("closing runs the runtime finalizer", async () => {
        const { runtime, disposals } = makeFakeRuntime();
        I.setSingleRunnerRuntimePromiseForTest(Promise.resolve(runtime));
        expect(I.getSingleRunnerStateForTest()).toBe("open");
        await closeSingleRunnerRuntime();
        expect(disposals.length).toBe(1);
        expect(I.getSingleRunnerStateForTest()).toBe("closed");
    });

    test("a close raced by an in-flight dispatch is rejected as busy and the dispatch still completes", async () => {
        const { runtime, disposals } = makeFakeRuntime();
        let releaseExecution = () => { };
        const executionGate = new Promise((resolve) => {
            releaseExecution = resolve;
        });
        I.setSingleRunnerRuntimePromiseForTest(Promise.resolve(runtime));
        const dispatch = dispatchWorkerTask(makeTask({ executionId: "busy-exec" }), async () => {
            await executionGate;
            return { terminal: true };
        });
        await expect(closeSingleRunnerRuntime()).rejects.toMatchObject({
            code: "SINGLE_RUNNER_BUSY",
            details: { executionIds: ["busy-exec"] },
        });
        // The busy close left the runtime untouched and usable.
        expect(disposals.length).toBe(0);
        expect(I.getSingleRunnerStateForTest()).toBe("open");
        releaseExecution();
        expect(await dispatch).toEqual({ terminal: true });
        // The failed attempt was discarded, so a later close can retry.
        await closeSingleRunnerRuntime();
        expect(disposals.length).toBe(1);
    });

    test("a run lease keeps the runtime alive across driver retry backoff", async () => {
        const { runtime, disposals } = makeFakeRuntime();
        I.setSingleRunnerRuntimePromiseForTest(Promise.resolve(runtime));
        const releaseRunLease = acquireSingleRunnerRunLease("retrying-run");
        // Between two attempts there is NO dispatch in flight; only the run
        // lease can see that the run is still alive.
        expect(I.activeDispatchLeases.size).toBe(0);
        expect(I.workerExecutions.size).toBe(0);
        await expect(closeSingleRunnerRuntime()).rejects.toMatchObject({
            code: "SINGLE_RUNNER_BUSY",
            details: { runIds: ["retrying-run"] },
        });
        // The retried dispatch still works against the untouched runtime.
        expect(await dispatchWorkerTask(makeTask({ executionId: "retry-attempt" }), async () => ({ terminal: true }))).toEqual({ terminal: true });
        releaseRunLease();
        await closeSingleRunnerRuntime();
        expect(disposals.length).toBe(1);
    });

    test("dispatch and run admission are fenced while a close is in flight", async () => {
        let finishDispose = () => { };
        const disposeGate = new Promise((resolve) => {
            finishDispose = resolve;
        });
        const runtime = {
            context: Context.empty(),
            client: () => ({
                execute: (task) => Effect.succeed({
                    _tag: "Success",
                    executionId: task.executionId,
                    terminal: true,
                }),
            }),
            dispose: () => disposeGate,
        };
        I.setSingleRunnerRuntimePromiseForTest(Promise.resolve(runtime));
        const closing = closeSingleRunnerRuntime();
        expect(I.getSingleRunnerStateForTest()).toBe("closing");
        await expect(dispatchWorkerTask(makeTask({ executionId: "during-close" }), async () => ({ terminal: true }))).rejects.toMatchObject({ code: "SINGLE_RUNNER_CLOSED" });
        expect(() => acquireSingleRunnerRunLease("during-close-run")).toThrow(/closed|closing/);
        expect(() => reopenSingleRunnerRuntime()).toThrow(/closing/);
        finishDispose();
        await closing;
        expect(I.getSingleRunnerStateForTest()).toBe("closed");
    });

    test("closing while the runtime is still being constructed disposes the built runtime", async () => {
        const { runtime, disposals } = makeFakeRuntime();
        let finishBuild = () => { };
        const buildGate = new Promise((resolve) => {
            finishBuild = resolve;
        });
        I.setSingleRunnerRuntimePromiseForTest(buildGate.then(() => runtime));
        const closing = closeSingleRunnerRuntime();
        finishBuild();
        await closing;
        expect(disposals.length).toBe(1);
        expect(I.getSingleRunnerStateForTest()).toBe("closed");
    });

    test("closing after a failed construction is a no-op", async () => {
        await expect(I.getSingleRunnerRuntimeFromBuilder(async () => {
            throw new Error("runtime unavailable");
        })).rejects.toThrow("runtime unavailable");
        // Construction failure stays retryable: the memo is cleared, not closed.
        expect(I.getSingleRunnerStateForTest()).toBe("idle");
        await closeSingleRunnerRuntime();
        expect(I.getSingleRunnerStateForTest()).toBe("closed");
    });

    test("a failing finalizer rejects every waiter and leaves an explicit reopen available", async () => {
        const { runtime } = makeFakeRuntime({ disposeError: new Error("finalizer exploded") });
        I.setSingleRunnerRuntimePromiseForTest(Promise.resolve(runtime));
        const first = closeSingleRunnerRuntime();
        const second = closeSingleRunnerRuntime();
        await expect(first).rejects.toThrow("finalizer exploded");
        await expect(second).rejects.toThrow("finalizer exploded");
        expect(I.getSingleRunnerStateForTest()).toBe("closed");
        reopenSingleRunnerRuntime();
        expect(I.getSingleRunnerStateForTest()).toBe("idle");
    });

    test("closed is terminal until reopen, and reopen rebuilds lazily on the next dispatch", async () => {
        const { runtime, disposals } = makeFakeRuntime();
        let builds = 0;
        const build = async () => {
            builds += 1;
            return runtime;
        };
        expect(await I.getSingleRunnerRuntimeFromBuilder(build)).toBe(runtime);
        expect(builds).toBe(1);
        await closeSingleRunnerRuntime();
        expect(disposals.length).toBe(1);
        // Terminal: no implicit rebuild.
        await expect(I.getSingleRunnerRuntimeFromBuilder(build)).rejects.toMatchObject({ code: "SINGLE_RUNNER_CLOSED" });
        expect(builds).toBe(1);
        reopenSingleRunnerRuntime();
        expect(I.getSingleRunnerStateForTest()).toBe("idle");
        expect(await I.getSingleRunnerRuntimeFromBuilder(build)).toBe(runtime);
        expect(builds).toBe(2);
        expect(I.getSingleRunnerStateForTest()).toBe("open");
        // The reopened runtime closes like any other.
        await closeSingleRunnerRuntime();
        expect(disposals.length).toBe(2);
    });

    test("reopen is a no-op while the runtime is still usable", () => {
        expect(I.getSingleRunnerStateForTest()).toBe("idle");
        reopenSingleRunnerRuntime();
        expect(I.getSingleRunnerStateForTest()).toBe("idle");
        I.setSingleRunnerRuntimePromiseForTest(Promise.resolve(makeFakeRuntime().runtime));
        expect(I.getSingleRunnerStateForTest()).toBe("open");
        reopenSingleRunnerRuntime();
        expect(I.getSingleRunnerStateForTest()).toBe("open");
    });
});
