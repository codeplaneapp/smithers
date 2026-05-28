import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runDiagnostics } from "../src/diagnostics/index.js";

// ---------------------------------------------------------------------------
// Regression: runCheck must clear its per-check timeout timer once the check
// settles. Previously the setTimeout-based rejection timer was raced via
// Promise.race but never cleared when check.run resolved first, leaving a
// ~5s timer armed on a hot path (diagnostics run on every agent invocation).
// See fix(agents): clear per-check diagnostic timeout when the check resolves.
// ---------------------------------------------------------------------------
describe("runDiagnostics per-check timeout cleanup", () => {
    /** @type {ReturnType<typeof spyOn> | undefined} */
    let setTimeoutSpy;
    /** @type {ReturnType<typeof spyOn> | undefined} */
    let clearTimeoutSpy;

    afterEach(() => {
        setTimeoutSpy?.mockRestore();
        clearTimeoutSpy?.mockRestore();
    });

    test("clears the timeout timer when a check resolves quickly", async () => {
        // Track every timer handle armed and cleared during the run so we can
        // assert the per-check timeout timer does not stay armed.
        /** @type {Set<unknown>} */
        const armed = new Set();
        /** @type {Set<unknown>} */
        const cleared = new Set();

        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;

        setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
            /** @type {any} */ ((fn, ms, ...args) => {
                const handle = realSetTimeout(fn, ms, ...args);
                armed.add(handle);
                return handle;
            }),
        );
        clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
            /** @type {any} */ ((handle) => {
                cleared.add(handle);
                return realClearTimeout(handle);
            }),
        );

        const strategy = {
            agentId: "fast-agent",
            command: "fast",
            checks: [
                {
                    id: "cli_installed",
                    // Resolves immediately — well before the per-check timeout.
                    run: async () => ({
                        id: "cli_installed",
                        status: "pass",
                        message: "found",
                        durationMs: 0,
                    }),
                },
            ],
        };

        const report = await runDiagnostics(strategy, { env: {}, cwd: "/tmp" });

        // Sanity: the check resolved successfully (not via the timeout path).
        expect(report.checks[0].status).toBe("pass");

        // The per-check timeout timer was armed...
        expect(armed.size).toBeGreaterThanOrEqual(1);
        // ...and clearTimeout was called for it.
        expect(clearTimeoutSpy).toHaveBeenCalled();

        // Every timer armed during the run must have been cleared. If the fix
        // is missing, the per-check timeout handle stays in `armed` but never
        // appears in `cleared`, and this assertion fails.
        for (const handle of armed) {
            expect(cleared.has(handle)).toBe(true);
        }
    });
});
