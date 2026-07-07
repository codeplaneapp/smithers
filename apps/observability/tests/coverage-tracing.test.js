import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    getCurrentSmithersTraceAnnotations,
    withSmithersSpan,
    TracingService,
    TracingServiceLive,
} from "../src/_coreTracing.js";
import { runWithCorrelationContext } from "@smithers-orchestrator/observability/correlation";
import { getCurrentSmithersTraceAnnotations as spanAnnotations } from "../src/getCurrentSmithersTraceAnnotations.js";
import { smithersTraceSpanStorage } from "../src/_smithersTraceSpanStorage.js";
import { makeSmithersSpanAttributes } from "../src/makeSmithersSpanAttributes.js";

/** @param {string} name @param {Record<string, unknown>} attributes */
async function spanNameFor(name, attributes) {
    const program = withSmithersSpan(
        name,
        Effect.gen(function* () {
            const span = yield* Effect.currentSpan;
            return span.name;
        }),
        attributes,
    );
    return Effect.runPromise(program);
}

describe("_coreTracing getCurrentSmithersTraceAnnotations (correlation-backed)", () => {
    test("returns undefined when there is no correlation context", () => {
        expect(getCurrentSmithersTraceAnnotations()).toBeUndefined();
    });
    test("returns traceId/spanId when the context carries both", () => {
        const annotations = runWithCorrelationContext(
            { runId: "r", traceId: "trace-x", spanId: "span-x" },
            () => getCurrentSmithersTraceAnnotations(),
        );
        expect(annotations).toEqual({ traceId: "trace-x", spanId: "span-x" });
    });
    test("returns undefined when the context is missing a spanId", () => {
        const annotations = runWithCorrelationContext(
            { runId: "r", traceId: "trace-x" },
            () => getCurrentSmithersTraceAnnotations(),
        );
        expect(annotations).toBeUndefined();
    });
});

describe("_coreTracing inferSmithersSpanName task/run inference", () => {
    test("infers smithers.task from a nodeId attribute", async () => {
        expect(await spanNameFor("materialize", { nodeId: "n" })).toBe("smithers.task");
    });
    test("infers smithers.task from a snake_case node_id attribute", async () => {
        expect(await spanNameFor("materialize", { node_id: "n" })).toBe("smithers.task");
    });
    test("infers smithers.run from a runId attribute", async () => {
        expect(await spanNameFor("kickoff", { runId: "r" })).toBe("smithers.run");
    });
    test("infers smithers.run from a snake_case run_id attribute", async () => {
        expect(await spanNameFor("kickoff", { run_id: "r" })).toBe("smithers.run");
    });
    test("leaves an unrecognized name unchanged", async () => {
        expect(await spanNameFor("plain-op", { custom: "x" })).toBe("plain-op");
    });
});

describe("TracingServiceLive.annotate error/empty paths", () => {
    test("swallows the annotate failure when there is no current span", async () => {
        const program = Effect.gen(function* () {
            const tracing = yield* TracingService;
            yield* tracing.annotate({ model: "gpt-5" });
            return "done";
        }).pipe(Effect.provide(TracingServiceLive));
        // annotateCurrentSpan fails outside a span; the catchAll keeps the effect alive.
        await expect(Effect.runPromise(program)).resolves.toBe("done");
    });
    test("returns a no-op when there are no span attributes", async () => {
        const program = Effect.gen(function* () {
            const tracing = yield* TracingService;
            yield* tracing.annotate({ omitted: undefined });
            return "done";
        }).pipe(Effect.provide(TracingServiceLive));
        await expect(Effect.runPromise(program)).resolves.toBe("done");
    });
});

describe("TracingServiceLive.withSpan / withCorrelation (direct src import)", () => {
    test("withSpan infers the span name and withCorrelation seeds the context", async () => {
        const program = Effect.gen(function* () {
            const tracing = yield* TracingService;
            return yield* tracing.withCorrelation(
                { runId: "run-live", traceId: "trace-live", spanId: "span-live" },
                tracing.withSpan(
                    "tool:apply",
                    Effect.gen(function* () {
                        const span = yield* Effect.currentSpan;
                        return span.name;
                    }),
                    { toolName: "apply" },
                ),
            );
        }).pipe(Effect.provide(TracingServiceLive));
        await expect(Effect.runPromise(program)).resolves.toBe("smithers.tool");
    });
});

describe("getCurrentSmithersTraceAnnotations (span-storage-backed)", () => {
    test("returns undefined when no span is stored", () => {
        expect(spanAnnotations()).toBeUndefined();
    });
    test("projects the stored span's traceId/spanId", () => {
        const annotations = smithersTraceSpanStorage.run(
            /** @type any */ ({ traceId: "t1", spanId: "s1" }),
            () => spanAnnotations(),
        );
        expect(annotations).toEqual({ traceId: "t1", spanId: "s1" });
    });
});

describe("makeSmithersSpanAttributes (standalone module)", () => {
    test("aliases keys, keeps smithers.* keys, and drops undefined values", () => {
        expect(
            makeSmithersSpanAttributes({
                runId: "r",
                "smithers.status": "ok",
                custom: "c",
                omitted: undefined,
            }),
        ).toEqual({
            "smithers.run_id": "r",
            "smithers.status": "ok",
            custom: "c",
        });
    });
    test("defaults to an empty object", () => {
        expect(makeSmithersSpanAttributes()).toEqual({});
    });
});
