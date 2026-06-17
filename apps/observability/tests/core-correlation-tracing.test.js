import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    getCurrentCorrelationContextEffect,
    mergeCorrelationContext,
    TracingService,
    TracingServiceLive,
    withCorrelationContext,
} from "@smithers-orchestrator/observability";
import {
    annotateSmithersTrace,
    makeSmithersSpanAttributes,
    withSmithersSpan,
} from "../src/_coreTracing.js";

function plainAnnotations(annotations) {
    return Object.fromEntries(annotations);
}

describe("core correlation context", () => {
    test("normalizes patches before merging and ignores empty invalid patches", () => {
        expect(
            mergeCorrelationContext(
                {
                    runId: "run-1",
                    nodeId: "node-old",
                    workflowName: "wf-old",
                    iteration: 1,
                    attempt: 0,
                    traceId: "trace-old",
                    spanId: "span-old",
                },
                {
                    runId: "",
                    nodeId: "node-new",
                    workflowName: undefined,
                    parentRunId: "parent-1",
                    iteration: Number.NaN,
                    attempt: 2,
                    traceId: "trace-new",
                    spanId: "",
                },
            ),
        ).toEqual({
            runId: "run-1",
            nodeId: "node-new",
            workflowName: "wf-old",
            parentRunId: "parent-1",
            iteration: 1,
            attempt: 2,
            traceId: "trace-new",
            spanId: "span-old",
        });

        expect(
            mergeCorrelationContext(null, {
                runId: "",
                nodeId: "node-without-run",
                attempt: Number.POSITIVE_INFINITY,
            }),
        ).toBeUndefined();
    });

    test("withCorrelationContext merges with the active context and restores it", async () => {
        const program = withCorrelationContext(
            Effect.gen(function* () {
                const outer = yield* getCurrentCorrelationContextEffect();
                const inner = yield* withCorrelationContext(
                    getCurrentCorrelationContextEffect(),
                    {
                        nodeId: "node-2",
                        attempt: 3,
                        traceId: "trace-2",
                    },
                );
                const restored = yield* getCurrentCorrelationContextEffect();
                return { outer, inner, restored };
            }),
            {
                runId: "run-1",
                nodeId: "node-1",
                traceId: "trace-1",
                spanId: "span-1",
            },
        );

        await expect(Effect.runPromise(program)).resolves.toEqual({
            outer: {
                runId: "run-1",
                nodeId: "node-1",
                traceId: "trace-1",
                spanId: "span-1",
            },
            inner: {
                runId: "run-1",
                nodeId: "node-2",
                attempt: 3,
                traceId: "trace-2",
                spanId: "span-1",
            },
            restored: {
                runId: "run-1",
                nodeId: "node-1",
                traceId: "trace-1",
                spanId: "span-1",
            },
        });
    });
});

describe("core tracing", () => {
    test("aliases Smithers span attributes and keeps custom attributes", () => {
        expect(
            makeSmithersSpanAttributes({
                runId: "run-1",
                run_id: "run-ignored",
                nodeId: "node-1",
                workflowName: "wf",
                "smithers.status": "ok",
                custom: "value",
                omitted: undefined,
            }),
        ).toEqual({
            "smithers.run_id": "run-ignored",
            "smithers.node_id": "node-1",
            "smithers.workflow_name": "wf",
            "smithers.status": "ok",
            custom: "value",
        });
    });

    test("withSmithersSpan infers span names, annotates spans, and carries correlation logs", async () => {
        const program = withCorrelationContext(
            withSmithersSpan(
                "tool:apply-patch",
                Effect.gen(function* () {
                    const span = yield* Effect.currentSpan;
                    const annotations = yield* Effect.logAnnotations;
                    return {
                        spanName: span.name,
                        attributes: Object.fromEntries(span.attributes),
                        annotations: plainAnnotations(annotations),
                    };
                }),
                {
                    runId: "run-1",
                    nodeId: "node-1",
                    toolName: "apply_patch",
                    custom: "custom-value",
                },
            ),
            {
                runId: "run-1",
                nodeId: "node-1",
                traceId: "trace-1",
                spanId: "span-1",
            },
        );

        await expect(Effect.runPromise(program)).resolves.toEqual({
            spanName: "smithers.tool",
            attributes: {
                "smithers.run_id": "run-1",
                "smithers.node_id": "node-1",
                "smithers.tool_name": "apply_patch",
                custom: "custom-value",
            },
            annotations: {
                runId: "run-1",
                nodeId: "node-1",
                toolName: "apply_patch",
                custom: "custom-value",
                traceId: "trace-1",
                spanId: "span-1",
            },
        });
    });

    test("annotateSmithersTrace annotates the current span", async () => {
        const program = Effect.gen(function* () {
            yield* annotateSmithersTrace({
                agent: "codex",
                status: "ok",
                omitted: undefined,
            });
            const span = yield* Effect.currentSpan;
            return Object.fromEntries(span.attributes);
        }).pipe(Effect.withSpan("manual"));

        await expect(Effect.runPromise(program)).resolves.toEqual({
            "smithers.agent": "codex",
            "smithers.status": "ok",
        });

        await expect(Effect.runPromise(annotateSmithersTrace({ runId: "run-1" }))).resolves.toBeUndefined();
    });

    test("TracingServiceLive delegates spans, annotation, and correlation", async () => {
        const program = Effect.gen(function* () {
            const tracing = yield* TracingService;
            return yield* tracing.withCorrelation(
                {
                    runId: "run-1",
                    traceId: "trace-1",
                    spanId: "span-1",
                },
                tracing.withSpan(
                    "agent.codex",
                    Effect.gen(function* () {
                        yield* tracing.annotate({ model: "gpt-5" });
                        const span = yield* Effect.currentSpan;
                        return {
                            context: yield* getCurrentCorrelationContextEffect(),
                            spanName: span.name,
                            attributes: Object.fromEntries(span.attributes),
                        };
                    }),
                    { agent: "codex" },
                ),
            );
        }).pipe(Effect.provide(TracingServiceLive));

        await expect(Effect.runPromise(program)).resolves.toEqual({
            context: {
                runId: "run-1",
                traceId: "trace-1",
                spanId: "span-1",
            },
            spanName: "smithers.agent",
            attributes: {
                "smithers.agent": "codex",
                "smithers.model": "gpt-5",
            },
        });
    });
});
