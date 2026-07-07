import { describe, expect, test } from "bun:test";
import { estimateCostUsd, modelTokenPrices } from "../src/index.js";

describe("modelTokenPrices", () => {
    test("exact id match returns its price table", () => {
        expect(modelTokenPrices("claude-opus-4-8")).toEqual({
            input: 15,
            output: 75,
            cacheWrite: 18.75,
            cacheRead: 1.5,
        });
    });

    test("date-stamped suffix with a dash still matches the base id", () => {
        expect(modelTokenPrices("claude-sonnet-5-20250101").input).toBe(3);
    });

    test("underscore-suffixed id matches the base id", () => {
        expect(modelTokenPrices("claude-haiku-4-5_preview").output).toBe(4);
    });

    test("bracketed context-window alias matches the base id", () => {
        expect(modelTokenPrices("claude-opus-4-8[1m]").output).toBe(75);
    });

    test("is case-insensitive", () => {
        expect(modelTokenPrices("CLAUDE-FABLE-5").input).toBe(15);
    });

    test("unknown id prices at all zeros", () => {
        expect(modelTokenPrices("gpt-5.5")).toEqual({
            input: 0,
            output: 0,
            cacheWrite: 0,
            cacheRead: 0,
        });
    });

    test("null / undefined id coerces to the empty string and prices free", () => {
        expect(modelTokenPrices(undefined)).toEqual({
            input: 0,
            output: 0,
            cacheWrite: 0,
            cacheRead: 0,
        });
        expect(modelTokenPrices(null)).toEqual({
            input: 0,
            output: 0,
            cacheWrite: 0,
            cacheRead: 0,
        });
    });
});

describe("estimateCostUsd", () => {
    test("a single coarse token total prices at the blended input/output midpoint", () => {
        // claude-sonnet-5: input 3, output 15 -> midpoint 9 per million.
        const cost = estimateCostUsd({ model: "claude-sonnet-5", tokens: 1_000_000 });
        expect(cost).toBe(9);
    });

    test("an input/output split prices each rate separately", () => {
        // claude-sonnet-5: input 3, output 15 per million.
        const cost = estimateCostUsd({
            model: "claude-sonnet-5",
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
        });
        expect(cost).toBe(18);
    });

    test("cache read/write tokens are priced at their own rates", () => {
        // claude-sonnet-5: cacheRead 0.3, cacheWrite 3.75 per million.
        const cost = estimateCostUsd({
            model: "claude-sonnet-5",
            cacheReadTokens: 1_000_000,
            cacheWriteTokens: 1_000_000,
        });
        expect(cost).toBeCloseTo(4.05, 10);
    });

    test("providing inputTokens suppresses the blended-total path even with tokens set", () => {
        const cost = estimateCostUsd({
            model: "claude-sonnet-5",
            tokens: 5_000_000,
            inputTokens: 1_000_000,
        });
        // tokens is ignored once inputTokens is present; only the split is priced.
        expect(cost).toBe(3);
    });

    test("negative and non-numeric counts clamp to zero", () => {
        const cost = estimateCostUsd({
            model: "claude-sonnet-5",
            inputTokens: -10,
            outputTokens: Number.NaN,
        });
        expect(cost).toBe(0);
    });

    test("unknown models price to zero dollars", () => {
        expect(
            estimateCostUsd({ model: "gpt-5.5", inputTokens: 1_000_000 }),
        ).toBe(0);
    });
});
