import { describe, expect, test } from "bun:test";
import {
    WATCH_MIN_INTERVAL_MS,
    clampWatchIntervalMs,
    runWatchLoop,
    watchIntervalSecondsToMs,
} from "../src/watch.js";

describe("watch helpers", () => {
    test("validates and clamps watch intervals", () => {
        expect(() => clampWatchIntervalMs(0)).toThrow("greater than 0");
        expect(() => clampWatchIntervalMs(Number.NaN)).toThrow("greater than 0");
        expect(clampWatchIntervalMs(1.9)).toBe(WATCH_MIN_INTERVAL_MS);
        expect(clampWatchIntervalMs(750)).toBe(750);
        expect(watchIntervalSecondsToMs(0.001)).toBe(WATCH_MIN_INTERVAL_MS);
        expect(watchIntervalSecondsToMs(2)).toBe(2_000);
    });

    test("returns immediately when the initial snapshot is terminal", async () => {
        const renders = [];
        const result = await runWatchLoop({
            intervalSeconds: 1,
            fetch: async () => ({ status: "finished" }),
            render: async (snapshot, context) => {
                renders.push({ snapshot, context });
            },
            isTerminal: (snapshot) => snapshot.status === "finished",
        });

        expect(result).toMatchObject({
            intervalMs: 1_000,
            tickCount: 0,
            stoppedBySignal: false,
            reachedTerminal: true,
            lastData: { status: "finished" },
        });
        expect(renders).toEqual([
            {
                snapshot: { status: "finished" },
                context: { tickCount: 0, initial: true },
            },
        ]);
    });

    test("stops on process signal and keeps the last snapshot", async () => {
        setTimeout(() => {
            process.emit("SIGINT");
            process.emit("SIGTERM");
        }, 0);

        const result = await runWatchLoop({
            intervalSeconds: 1,
            fetch: async () => ({ status: "running" }),
            render: async () => {},
            isTerminal: (snapshot) => snapshot.status === "finished",
        });

        expect(result).toMatchObject({
            intervalMs: 1_000,
            tickCount: 0,
            stoppedBySignal: true,
            reachedTerminal: false,
            signal: "SIGINT",
            lastData: { status: "running" },
        });
    });

    test("renders a tick, clears the screen, and stops at terminal data", async () => {
        const writes = [];
        const originalWrite = process.stdout.write;
        process.stdout.write = function write(chunk, ...args) {
            writes.push(String(chunk));
            return true;
        };
        try {
            let fetchCount = 0;
            const renders = [];
            const result = await runWatchLoop({
                intervalSeconds: 0.5,
                fetch: async () => {
                    fetchCount += 1;
                    return { status: fetchCount === 1 ? "running" : "finished" };
                },
                render: async (snapshot, context) => {
                    renders.push({ snapshot, context });
                },
                isTerminal: (snapshot) => snapshot.status === "finished",
            });

            expect(result).toMatchObject({
                intervalMs: WATCH_MIN_INTERVAL_MS,
                tickCount: 1,
                stoppedBySignal: false,
                reachedTerminal: true,
                lastData: { status: "finished" },
            });
            expect(renders).toEqual([
                {
                    snapshot: { status: "running" },
                    context: { tickCount: 0, initial: true },
                },
                {
                    snapshot: { status: "finished" },
                    context: { tickCount: 1, initial: false },
                },
            ]);
            expect(writes).toContain("\x1B[2J\x1B[0f");
        }
        finally {
            process.stdout.write = originalWrite;
        }
    });
});
