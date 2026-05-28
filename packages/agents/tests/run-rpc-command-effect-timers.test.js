import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

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
 * Spies on the global timer functions, recording every timer id created via
 * setTimeout and every id passed to clearTimeout. Returns helpers plus a
 * restore function. Real timers still run so nothing leaks during the test.
 */
function installTimerSpy() {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    /** @type {Set<unknown>} */
    const created = new Set();
    /** @type {Set<unknown>} */
    const cleared = new Set();

    globalThis.setTimeout = /** @type {any} */ ((fn, ms, ...rest) => {
        const id = realSetTimeout(fn, ms, ...rest);
        created.add(id);
        return id;
    });
    globalThis.clearTimeout = /** @type {any} */ ((id) => {
        cleared.add(id);
        return realClearTimeout(id);
    });

    return {
        created,
        cleared,
        // Untracked timer for the test's own scheduling, so test delays do not
        // pollute the created/cleared sets we assert on.
        realSetTimeout,
        restore() {
            globalThis.setTimeout = realSetTimeout;
            globalThis.clearTimeout = realClearTimeout;
        },
    };
}

describe("runRpcCommandEffect timer cleanup", () => {
    /** @type {ReturnType<typeof installTimerSpy> | undefined} */
    let timers;
    /** @type {(() => any) | undefined} */
    let nextChild;

    beforeEach(() => {
        timers = installTimerSpy();
        nextChild = undefined;
        // Replace spawn so the effect uses our controllable fake child.
        mock.module("node:child_process", () => ({
            spawn: () => {
                const child = nextChild ? nextChild() : makeFakeChild();
                return child;
            },
        }));
    });

    afterEach(() => {
        timers?.restore();
        mock.restore();
    });

    test("clears total-timeout and inactivity timers when settling via handleError (stdin unavailable)", async () => {
        // Re-import after the mock so spawn is the mocked one.
        const { runRpcCommandEffect } = await import(
            "../src/BaseCliAgent/runRpcCommandEffect.js?handleError"
        );
        const { Effect } = await import("effect");

        nextChild = () => makeFakeChild({ stdin: false });

        const effect = runRpcCommandEffect("fake-cli", [], {
            cwd: process.cwd(),
            env: /** @type {any} */ ({}),
            prompt: "hello",
            // Non-trivial timeouts so real setTimeout timers are created.
            timeoutMs: 1_000_000,
            idleTimeoutMs: 1_000_000,
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
        const { runRpcCommandEffect } = await import(
            "../src/BaseCliAgent/runRpcCommandEffect.js?lineQueue"
        );
        const { Effect } = await import("effect");

        const child = makeFakeChild({ stdin: true });
        nextChild = () => child;

        const effect = runRpcCommandEffect("fake-cli", [], {
            cwd: process.cwd(),
            env: /** @type {any} */ ({}),
            prompt: "hello",
            timeoutMs: 1_000_000,
            idleTimeoutMs: 1_000_000,
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
        await new Promise((r) => timers?.realSetTimeout(r, 10));
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
