import { describe, expect, test } from "bun:test";
import { estimateCostUsd, modelTokenPrices } from "../src/index.js";

describe("modelTokenPrices", () => {
  test("returns current Anthropic prices and cache multipliers", () => {
    expect(modelTokenPrices("claude-fable-5")).toEqual({
      input: 10,
      output: 50,
      cacheWrite: 12.5,
      cacheRead: 1,
    });
    expect(modelTokenPrices("claude-opus-5")).toEqual({
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    });
    expect(modelTokenPrices("claude-opus-4-8")).toEqual({
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    });
    expect(modelTokenPrices("claude-opus-4-7")).toEqual({
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    });
    expect(modelTokenPrices("claude-haiku-4-5")).toEqual({
      input: 1,
      output: 5,
      cacheWrite: 1.25,
      cacheRead: 0.1,
    });
  });

  test("prices every GPT-5.6 Codex tier", () => {
    expect(modelTokenPrices("gpt-5.6-sol")).toEqual({
      input: 5,
      output: 30,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    });
    expect(modelTokenPrices("gpt-5.6-terra")).toEqual({
      input: 2.5,
      output: 15,
      cacheWrite: 3.125,
      cacheRead: 0.25,
    });
    expect(modelTokenPrices("gpt-5.6-luna")).toEqual({
      input: 1,
      output: 6,
      cacheWrite: 1.25,
      cacheRead: 0.1,
    });
  });

  test("date-stamped suffix with a dash still matches the base id", () => {
    expect(modelTokenPrices("claude-sonnet-5-20250101").input).toBe(3);
  });

  test("underscore-suffixed id matches the base id", () => {
    expect(modelTokenPrices("claude-haiku-4-5_preview").output).toBe(5);
  });

  test("bracketed context-window alias matches the base id", () => {
    expect(modelTokenPrices("claude-opus-4-8[1m]").output).toBe(25);
  });

  test("is case-insensitive", () => {
    expect(modelTokenPrices("CLAUDE-FABLE-5").input).toBe(10);
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

  test("Luna input/output and cache usage use the published base rates below 272K input", () => {
    expect(
      estimateCostUsd({
        model: "gpt-5.6-luna",
        inputTokens: 100_000,
        outputTokens: 100_000,
      }),
    ).toBeCloseTo(0.7, 10);
    expect(
      estimateCostUsd({
        model: "gpt-5.6-luna",
        cacheReadTokens: 100_000,
        cacheWriteTokens: 100_000,
      }),
    ).toBeCloseTo(0.135, 10);
  });

  test("GPT-5.6 long-context pricing starts only above 272K input and reprices the entire request", () => {
    expect(
      estimateCostUsd({
        model: "gpt-5.6-luna",
        inputTokens: 272_000,
        outputTokens: 100_000,
      }),
    ).toBeCloseTo(0.872, 10);

    expect(
      estimateCostUsd({
        model: "gpt-5.6-luna",
        inputTokens: 272_001,
        outputTokens: 100_000,
      }),
    ).toBeCloseTo(1.444002, 10);
  });

  test("GPT-5.6 long-context input multiplier includes cache reads and writes", () => {
    expect(
      estimateCostUsd({
        model: "gpt-5.6-terra",
        cacheReadTokens: 200_000,
        cacheWriteTokens: 100_000,
        outputTokens: 100_000,
      }),
    ).toBeCloseTo(2.975, 10);
  });

  test("coarse GPT-5.6 totals use the existing 50/50 split for the long-context threshold", () => {
    expect(
      estimateCostUsd({
        model: "gpt-5.6-luna",
        tokens: 544_000,
      }),
    ).toBeCloseTo(1.904, 10);
    expect(
      estimateCostUsd({
        model: "gpt-5.6-luna",
        tokens: 544_002,
      }),
    ).toBeCloseTo(2.992011, 10);
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

  test("prices a flows usage event using its cached-input breakdown", () => {
    const cost = estimateCostUsd({
      type: "usage",
      model: "claude-sonnet-5",
      inputTokens: 1_200_000,
      outputTokens: 100_000,
      cachedInputTokens: 900_000,
      cacheWriteTokens: 100_000,
      totalTokens: 1_300_000,
    });
    expect(cost).toBeCloseTo(2.745, 10);
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
    expect(estimateCostUsd({ model: "gpt-5.5", inputTokens: 1_000_000 })).toBe(0);
  });
});
