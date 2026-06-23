import { describe, expect, test } from "bun:test";
import { Effect, LogLevel } from "effect";
import {
    createSmithersOtelLayer,
    createSmithersObservabilityLayer,
    createSmithersRuntimeLayer,
    SmithersObservability,
} from "../src/index.js";

describe("createSmithersOtelLayer", () => {
    test("returns a layer when disabled (no options)", () => {
        const layer = createSmithersOtelLayer({ enabled: false });
        expect(layer).toBeDefined();
    });

    test("returns a layer when called with no arguments (defaults to disabled)", () => {
        const layer = createSmithersOtelLayer();
        expect(layer).toBeDefined();
    });

    test("returns a layer when enabled with explicit endpoint", () => {
        const layer = createSmithersOtelLayer({
            enabled: true,
            endpoint: "http://localhost:4318",
            serviceName: "test-service",
        });
        expect(layer).toBeDefined();
    });
});

describe("createSmithersObservabilityLayer", () => {
    test("provides SmithersObservability with resolved options", async () => {
        const layer = createSmithersObservabilityLayer({
            enabled: false,
            serviceName: "test-svc",
            logFormat: "json",
            logLevel: "debug",
        });
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const obs = yield* SmithersObservability;
                return obs.options;
            }).pipe(Effect.provide(layer)),
        );
        expect(result.enabled).toBe(false);
        expect(result.serviceName).toBe("test-svc");
        expect(result.logFormat).toBe("json");
        expect(result.logLevel).toBe(LogLevel.Debug);
    });

    test("provides SmithersObservability with default options when called with no arguments", async () => {
        const layer = createSmithersObservabilityLayer();
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const obs = yield* SmithersObservability;
                return obs.options;
            }).pipe(Effect.provide(layer)),
        );
        expect(result.serviceName).toBe("smithers");
        expect(result.enabled).toBe(false);
        expect(result.logFormat).toBe("logfmt");
        expect(result.logLevel).toBe(LogLevel.Info);
    });

    test("installLogger:false is reflected in the service options", async () => {
        const layer = createSmithersObservabilityLayer({
            enabled: false,
            installLogger: false,
        });
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const obs = yield* SmithersObservability;
                return obs.options.installLogger;
            }).pipe(Effect.provide(layer)),
        );
        expect(result).toBe(false);
    });

    test("service annotate method returns an Effect that resolves without error", async () => {
        const layer = createSmithersObservabilityLayer({ enabled: false });
        await Effect.runPromise(
            Effect.gen(function* () {
                const obs = yield* SmithersObservability;
                yield* obs.annotate({ runId: "run-1", status: "ok" });
            }).pipe(
                Effect.withSpan("test-span"),
                Effect.provide(layer),
            ),
        );
    });

    test("service withSpan method wraps an effect and returns its result", async () => {
        const layer = createSmithersObservabilityLayer({ enabled: false });
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const obs = yield* SmithersObservability;
                return yield* obs.withSpan("smithers.tool", Effect.succeed(42), {
                    runId: "run-1",
                });
            }).pipe(Effect.provide(layer)),
        );
        expect(result).toBe(42);
    });

    test("service withSpan propagates failures from the inner effect", async () => {
        const layer = createSmithersObservabilityLayer({ enabled: false });
        await expect(
            Effect.runPromise(
                Effect.gen(function* () {
                    const obs = yield* SmithersObservability;
                    return yield* obs.withSpan(
                        "smithers.run",
                        Effect.fail(new Error("inner failure")),
                    );
                }).pipe(Effect.provide(layer)),
            ),
        ).rejects.toThrow("inner failure");
    });
});

describe("createSmithersRuntimeLayer", () => {
    test("is the same function as createSmithersObservabilityLayer", () => {
        expect(createSmithersRuntimeLayer).toBe(createSmithersObservabilityLayer);
    });

    test("provides SmithersObservability with the given serviceName", async () => {
        const layer = createSmithersRuntimeLayer({
            enabled: false,
            serviceName: "runtime-svc",
        });
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const obs = yield* SmithersObservability;
                return obs.options.serviceName;
            }).pipe(Effect.provide(layer)),
        );
        expect(result).toBe("runtime-svc");
    });
});
