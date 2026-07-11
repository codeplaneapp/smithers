import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Effect } from "effect";
import { runRpcCommandEffect } from "../src/BaseCliAgent/runRpcCommandEffect.js";

/**
 * Builds a fake child process object that satisfies the surface area
 * runRpcCommandEffect touches (stdout/stderr streams, stdin, lifecycle
 * events, pid/exitCode). `stdin` can be forced to null to exercise the
 * "stdin is not available" error settle path.
 *
 * @param {{ stdin?: boolean }} [opts]
 */
function makeFakeChild({ stdin = true } = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = stdin ? new PassThrough() : null;
    child.pid = undefined; // no real OS process to signal
    child.exitCode = null;
    child.unref = () => {};
    return child;
}

/**
 * Builds an isolated timer API for one runRpcCommandEffect invocation. This
 * avoids process-wide timer spies recording unrelated timers from other test
 * files while Bun is running them in the same process.
 */
function makeTimerHarness() {
    /** @type {Set<unknown>} */
    const created = new Set();
    /** @type {Set<unknown>} */
    const cleared = new Set();
    let sequence = 0;

    return {
        created,
        cleared,
        timerApi: /** @type {any} */ ({
            setTimeout() {
                const id = ++sequence;
                created.add(id);
                return id;
            },
            clearTimeout(id) {
                cleared.add(id);
            },
        }),
        waitForListeners() {
            return new Promise((resolve) => {
                setTimeout(resolve, 10);
            });
        },
    };
}

describe("runRpcCommandEffect timer cleanup", () => {
    /** @type {ReturnType<typeof makeTimerHarness> | undefined} */
    let timers;
    /** @type {(() => any) | undefined} */
    let nextChild;

    // Inject a controllable fake child via the spawnFn seam. This avoids
    // mock.module("node:child_process", …): a global module mock is process-
    // wide and bun runs test files concurrently, so the stub (and its fake
    // child that never closes) would bleed into other files and hang them —
    // and mock.restore() does not undo mock.module().
    const spawnFn = /** @type {any} */ (
        () => (nextChild ? nextChild() : makeFakeChild())
    );

    beforeEach(() => {
        timers = makeTimerHarness();
        nextChild = undefined;
    });

    test("clears total-timeout and inactivity timers when settling via handleError (stdin unavailable)", async () => {
        nextChild = () => makeFakeChild({ stdin: false });

        const effect = runRpcCommandEffect("fake-cli", [], {
            cwd: process.cwd(),
            env: /** @type {any} */ ({}),
            prompt: "hello",
            // Non-trivial timeouts so both lifecycle timers are created.
            timeoutMs: 1_000_000,
            idleTimeoutMs: 1_000_000,
            spawnFn,
            lifecycleTimerApi: timers?.timerApi,
        });

        await expect(Effect.runPromise(effect)).rejects.toThrow(
            /stdin is not available/,
        );

        // Both timers the effect created must have been cleared on this settle
        // path. Pre-fix, handle() did not call inactivity.clear()/
        // totalTimeout.clear(), so the created timers were never cleared.
        expect(timers?.created.size).toBeGreaterThan(0);
        for (const id of timers?.created ?? []) {
            expect(timers?.cleared.has(id)).toBe(true);
        }
    });

    test("clears total-timeout and inactivity timers when a queued line handler rejects (handleError via lineQueue)", async () => {
        const child = makeFakeChild({ stdin: true });
        nextChild = () => child;

        const effect = runRpcCommandEffect("fake-cli", [], {
            cwd: process.cwd(),
            env: /** @type {any} */ ({}),
            prompt: "hello",
            timeoutMs: 1_000_000,
            idleTimeoutMs: 1_000_000,
            spawnFn,
            lifecycleTimerApi: timers?.timerApi,
            // Throwing while handling an extension_ui_request makes the queued
            // handleLine() promise reject, settling the effect through the
            // lineQueue .catch -> handleError() path (never reaching the child
            // close/error handlers). Pre-fix this path did not clear timers.
            onExtensionUiRequest: () => {
                throw new Error("boom from extension handler");
            },
        });

        const run = Effect.runPromise(effect);

        // Give the effect a tick to attach the readline "line" listener.
        await timers?.waitForListeners();
        child.stdout.write(
            JSON.stringify({
                type: "extension_ui_request",
                method: "select",
                id: "req-1",
            }) + "\n",
        );

        await expect(run).rejects.toThrow(/boom from extension handler/);

        // handleError() must clear both created timers on this settle path.
        expect(timers?.created.size).toBeGreaterThan(0);
        for (const id of timers?.created ?? []) {
            expect(timers?.cleared.has(id)).toBe(true);
        }
    });
});
