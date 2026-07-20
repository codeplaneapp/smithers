import { describe, expect, test } from "bun:test";
import { WorkflowDriver } from "../src/WorkflowDriver.js";

/**
 * Minimal driver whose scheduling decisions are stubbed so the test controls the
 * loop directly. `session` is set so the driver skips session initialization.
 * @param {{ onExecute: () => void }} hooks
 */
function makeDriver(hooks) {
    const driver = new WorkflowDriver({
        workflow: { db: {} },
        db: {},
        session: { submitGraph() { }, getTaskStates() { } },
    });
    let drained = false;
    driver.drainInflight = async () => {
        drained = true;
    };
    // Always hand back another Execute decision, so only an explicit pause (not
    // natural completion) can stop the loop.
    driver.renderAndSubmit = async () => ({ _tag: "Execute", tasks: [{ nodeId: "a", iteration: 0 }] });
    driver.executeTasks = async () => {
        hooks.onExecute();
        return { _tag: "Execute", tasks: [{ nodeId: "a", iteration: 0 }] };
    };
    return { driver, wasDrained: () => drained };
}

describe("WorkflowDriver graceful pause", () => {
    test("an aborted pauseSignal drains in-flight work and parks the run paused before scheduling more tasks", async () => {
        let executed = 0;
        const { driver, wasDrained } = makeDriver({ onExecute: () => { executed += 1; } });
        const pause = new AbortController();
        pause.abort();
        const result = await driver.run({
            runId: "r1",
            input: {},
            signal: new AbortController().signal,
            pauseSignal: pause.signal,
        });
        expect(result).toEqual({ runId: "r1", status: "paused" });
        expect(wasDrained()).toBe(true);
        // Pause is checked at the top of the loop, before the Execute switch, so no
        // further task batch is scheduled once pause is requested.
        expect(executed).toBe(0);
    });

    test("without a pauseSignal the loop proceeds to execute tasks", async () => {
        let executed = 0;
        const driver = new WorkflowDriver({
            workflow: { db: {} },
            db: {},
            session: { submitGraph() { }, getTaskStates() { } },
        });
        driver.renderAndSubmit = async () => ({ _tag: "Execute", tasks: [{ nodeId: "a", iteration: 0 }] });
        driver.executeTasks = async () => {
            executed += 1;
            return { runId: "r1", status: "finished" };
        };
        const result = await driver.run({
            runId: "r1",
            input: {},
            signal: new AbortController().signal,
        });
        expect(result).toEqual({ runId: "r1", status: "finished" });
        expect(executed).toBe(1);
    });

    test("cancel (aborted signal) still wins over pause", async () => {
        const { driver } = makeDriver({ onExecute: () => { } });
        let cancelled = false;
        driver.cancelRun = async () => {
            cancelled = true;
            return { runId: "r1", status: "cancelled" };
        };
        const abort = new AbortController();
        abort.abort();
        const pause = new AbortController();
        pause.abort();
        const result = await driver.run({
            runId: "r1",
            input: {},
            signal: abort.signal,
            pauseSignal: pause.signal,
        });
        expect(result).toEqual({ runId: "r1", status: "cancelled" });
        expect(cancelled).toBe(true);
    });

    test("a cancel that lands during the pause drain wins over park", async () => {
        const { driver } = makeDriver({ onExecute: () => { } });
        const cancel = new AbortController();
        // The drain window is where a cancel can arrive: the engine's
        // pause-watcher aborts the run signal mid-drain. Simulate that by
        // aborting the cancel controller from inside drainInflight.
        driver.drainInflight = async () => {
            cancel.abort();
        };
        // cancelRequested returns undefined so cancelRun falls through to its
        // {status:'cancelled'} fallback.
        driver.session = { ...driver.session, cancelRequested: () => undefined };
        driver.runEffect = async () => undefined;
        const pause = new AbortController();
        pause.abort();
        const result = await driver.run({
            runId: "r1",
            input: {},
            signal: cancel.signal,
            pauseSignal: pause.signal,
        });
        expect(result).toEqual({ runId: "r1", status: "cancelled" });
    });
});
