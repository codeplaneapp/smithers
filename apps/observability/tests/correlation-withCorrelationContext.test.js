import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    correlationContextToLogAnnotations,
    getCurrentCorrelationContext,
    withCorrelationContext,
} from "@smithers-orchestrator/observability/correlation";
import { logErrorAwait } from "@smithers-orchestrator/observability/logging";

describe("withCorrelationContext", () => {
    // Regression: withCorrelationContext only patched the Effect FiberRef, so the
    // imperative logger (which reads the AsyncLocalStorage via
    // getCurrentCorrelationContext) saw no context. The fix syncs the ALS via
    // enterWith so an imperative log emitted within the wrapped effect carries the
    // correlation annotations. See fix(observability) "make withCorrelationContext
    // visible to the imperative logger".

    test("patches the imperative correlation context the logger reads", async () => {
        let annotations;
        await Effect.runPromise(
            withCorrelationContext(
                // This mirrors exactly what logging.js#buildLogProgram does: it reads
                // the imperative context synchronously when a log fn is invoked.
                Effect.sync(() => {
                    annotations = correlationContextToLogAnnotations(
                        getCurrentCorrelationContext(),
                    );
                }),
                { runId: "r1", nodeId: "n1", iteration: 3 },
            ),
        );
        // Pre-fix this was undefined because the ALS was never patched.
        expect(annotations).toEqual({ runId: "r1", nodeId: "n1", iteration: 3 });
    });

    test("an imperative log emitted within the context carries the annotations", async () => {
        const lines = [];
        const origLog = console.log;
        const origError = console.error;
        // The imperative logger runs its own Effect runtime via runPromise and emits
        // through the default Effect logger (console). Capture both streams.
        console.log = (...args) => lines.push(args.join(" "));
        console.error = (...args) => lines.push(args.join(" "));
        try {
            await Effect.runPromise(
                withCorrelationContext(
                    // logErrorAwait is above the default WARNING threshold, so this is
                    // deterministic regardless of SMITHERS_LOG_LEVEL.
                    Effect.promise(() => logErrorAwait("inside-context")),
                    { runId: "r1", nodeId: "n1", iteration: 3 },
                ),
            );
        } finally {
            console.log = origLog;
            console.error = origError;
        }
        const output = lines.join("\n");
        expect(output).toContain("message=inside-context");
        // Pre-fix none of these correlation annotations were present on the record.
        expect(output).toContain("runId=r1");
        expect(output).toContain("nodeId=n1");
        expect(output).toContain("iteration=3");
    });

    test("restores the previous imperative context after the effect completes", async () => {
        await Effect.runPromise(
            withCorrelationContext(Effect.void, {
                runId: "outer",
                nodeId: "outer-node",
            }),
        );
        // The patch must not leak past the wrapped effect.
        expect(getCurrentCorrelationContext()).toBeUndefined();
    });
});
