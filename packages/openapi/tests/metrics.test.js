// ---------------------------------------------------------------------------
// Tests asserting that executeToolEffect correctly increments metrics and
// records duration on both success and error paths.
// ---------------------------------------------------------------------------
import { mock, describe, test, expect, afterEach } from "bun:test";
import { Effect, Metric } from "effect";
import { executeToolEffect } from "../src/tool-factory/_helpers.js";
import {
    openApiToolCallsTotal,
    openApiToolCallErrorsTotal,
    openApiToolDuration,
} from "../src/metrics.js";

const originalFetch = globalThis.fetch;

/** Minimal parsed operation for testing */
const operation = {
    operationId: "listPets",
    method: "get",
    path: "/pets",
    parameters: [],
    requestBodyMediaType: undefined,
};

const baseUrl = "https://api.example.com";
const options = {};

/** Read current counter value */
async function readCounter(metric) {
    const state = await Effect.runPromise(Metric.value(metric));
    return state.count;
}

/** Read current histogram observation count */
async function readHistogramCount(metric) {
    const state = await Effect.runPromise(Metric.value(metric));
    return state.count;
}

/** Run the effect, swallowing any Effect failure (mirrors execute wrapper) */
async function runEffect(effect) {
    return Effect.runPromise(effect).catch(() => null);
}

describe("executeToolEffect metric increments", () => {
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test("openApiToolCallsTotal increments on a successful call", async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            ),
        );
        const before = await readCounter(openApiToolCallsTotal);
        await runEffect(executeToolEffect(operation, {}, baseUrl, options));
        const after = await readCounter(openApiToolCallsTotal);
        expect(after - before).toBe(1);
    });

    test("openApiToolCallsTotal increments on a failed call", async () => {
        globalThis.fetch = mock(() => Promise.reject(new Error("Network error")));
        const before = await readCounter(openApiToolCallsTotal);
        await runEffect(executeToolEffect(operation, {}, baseUrl, options));
        const after = await readCounter(openApiToolCallsTotal);
        expect(after - before).toBe(1);
    });

    test("openApiToolCallErrorsTotal increments on a failed call", async () => {
        globalThis.fetch = mock(() => Promise.reject(new Error("Network error")));
        const before = await readCounter(openApiToolCallErrorsTotal);
        await runEffect(executeToolEffect(operation, {}, baseUrl, options));
        const after = await readCounter(openApiToolCallErrorsTotal);
        expect(after - before).toBe(1);
    });

    test("openApiToolCallErrorsTotal does NOT increment on a successful call", async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            ),
        );
        const before = await readCounter(openApiToolCallErrorsTotal);
        await runEffect(executeToolEffect(operation, {}, baseUrl, options));
        const after = await readCounter(openApiToolCallErrorsTotal);
        expect(after - before).toBe(0);
    });

    test("openApiToolDuration is recorded on a successful call", async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            ),
        );
        const before = await readHistogramCount(openApiToolDuration);
        await runEffect(executeToolEffect(operation, {}, baseUrl, options));
        const after = await readHistogramCount(openApiToolDuration);
        expect(after - before).toBe(1);
    });

    test("openApiToolDuration is recorded on a failed call (error path)", async () => {
        globalThis.fetch = mock(() => Promise.reject(new Error("Network error")));
        const before = await readHistogramCount(openApiToolDuration);
        await runEffect(executeToolEffect(operation, {}, baseUrl, options));
        const after = await readHistogramCount(openApiToolDuration);
        expect(after - before).toBe(1);
    });
});
