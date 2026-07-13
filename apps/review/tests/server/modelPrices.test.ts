import { describe, expect, test } from "bun:test";

import { modelPrices } from "../../src/server/proxy/modelPrices.ts";

describe("modelPrices", () => {
  test("includes GPT-5.6 Sol, Terra, and Luna", () => {
    expect(modelPrices("gpt-5.6-sol")).toEqual({ input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(modelPrices("gpt-5.6-terra")).toEqual({ input: 2.5, output: 15, cacheWrite: 3.125, cacheRead: 0.25 });
    expect(modelPrices("gpt-5.6-luna")).toEqual({ input: 1, output: 6, cacheWrite: 1.25, cacheRead: 0.1 });
  });

  test("uses current Anthropic prices", () => {
    expect(modelPrices("claude-fable-5")).toEqual({ input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 });
    expect(modelPrices("claude-opus-4-8")).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(modelPrices("claude-opus-4-7")).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(modelPrices("claude-haiku-4-5")).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });
  });

  test("prices a date-stamped suffix", () => {
    expect(modelPrices("claude-haiku-4-5-20251001").input).toBe(1);
  });

  test("prices a bracketed context-window alias (not metered as free)", () => {
    // claude-opus-4-8[1m] is a real model; it must not fall through to $0.
    const price = modelPrices("claude-opus-4-8[1m]");
    expect(price.input).toBe(5);
    expect(price.output).toBe(25);
  });

  test("unknown models record $0", () => {
    expect(modelPrices("some-unknown-model").input).toBe(0);
  });
});
