import { describe, expect, test } from "bun:test";
import { autoOpenMonitor } from "../src/autoOpenMonitor.js";

/**
 * Build a spawnImpl stand-in that records its calls via the injection seam.
 *
 * @param {{ throws?: boolean }} [options]
 * @returns {{ calls: Array<{ command: string; args: string[]; options: object }>; unrefCalls: number; spawnImpl: (command: string, args: string[], options: object) => { unref: () => void } }}
 */
function makeSpawnRecorder({ throws = false } = {}) {
    const recorder = {
        calls: [],
        unrefCalls: 0,
        spawnImpl: (command, args, options) => {
            if (throws) {
                throw new Error("spawn EACCES");
            }
            recorder.calls.push({ command, args, options });
            return {
                unref: () => {
                    recorder.unrefCalls += 1;
                },
            };
        },
    };
    return recorder;
}

describe("autoOpenMonitor", () => {
    test("dispatches a detached, unref'd `bun <cliPath> monitor <runId>` when enabled", () => {
        const recorder = makeSpawnRecorder();

        const dispatched = autoOpenMonitor({
            runId: "run_123",
            cliPath: "/opt/smithers/src/index.js",
            enabled: true,
            env: {},
            spawnImpl: recorder.spawnImpl,
        });

        expect(dispatched).toBe(true);
        expect(recorder.calls).toHaveLength(1);
        const call = recorder.calls[0];
        expect(call.command).toBe("bun");
        expect(call.args).toEqual(["/opt/smithers/src/index.js", "monitor", "run_123"]);
        expect(call.options.detached).toBe(true);
        expect(call.options.stdio).toBe("ignore");
        expect(recorder.unrefCalls).toBe(1);
    });

    test("passes the provided env through to the child", () => {
        const recorder = makeSpawnRecorder();
        const env = { PATH: "/usr/bin" };

        autoOpenMonitor({
            runId: "run_env",
            cliPath: "/opt/smithers/src/index.js",
            enabled: true,
            env,
            spawnImpl: recorder.spawnImpl,
        });

        expect(recorder.calls[0].options.env).toBe(env);
    });

    test("returns false without spawning when enabled is false", () => {
        const recorder = makeSpawnRecorder();

        const dispatched = autoOpenMonitor({
            runId: "run_123",
            cliPath: "/opt/smithers/src/index.js",
            enabled: false,
            env: {},
            spawnImpl: recorder.spawnImpl,
        });

        expect(dispatched).toBe(false);
        expect(recorder.calls).toHaveLength(0);
    });

    test('returns false without spawning when env.SMITHERS_NO_OPEN === "1"', () => {
        const recorder = makeSpawnRecorder();

        const dispatched = autoOpenMonitor({
            runId: "run_123",
            cliPath: "/opt/smithers/src/index.js",
            enabled: true,
            env: { SMITHERS_NO_OPEN: "1" },
            spawnImpl: recorder.spawnImpl,
        });

        expect(dispatched).toBe(false);
        expect(recorder.calls).toHaveLength(0);
    });

    test("returns false without spawning when env.CI is set", () => {
        const recorder = makeSpawnRecorder();

        const dispatched = autoOpenMonitor({
            runId: "run_123",
            cliPath: "/opt/smithers/src/index.js",
            enabled: true,
            env: { CI: "true" },
            spawnImpl: recorder.spawnImpl,
        });

        expect(dispatched).toBe(false);
        expect(recorder.calls).toHaveLength(0);
    });

    test("returns false instead of throwing when spawnImpl throws", () => {
        const recorder = makeSpawnRecorder({ throws: true });

        const dispatched = autoOpenMonitor({
            runId: "run_123",
            cliPath: "/opt/smithers/src/index.js",
            enabled: true,
            env: {},
            spawnImpl: recorder.spawnImpl,
        });

        expect(dispatched).toBe(false);
        expect(recorder.calls).toHaveLength(0);
    });

    test("returns true even when the child exposes no unref", () => {
        /** @type {Array<{ command: string; args: string[] }>} */
        const calls = [];
        const spawnImpl = (command, args) => {
            calls.push({ command, args });
            return {};
        };

        const dispatched = autoOpenMonitor({
            runId: "run_no_unref",
            cliPath: "/opt/smithers/src/index.js",
            enabled: true,
            env: {},
            spawnImpl,
        });

        expect(dispatched).toBe(true);
        expect(calls).toHaveLength(1);
    });
});
