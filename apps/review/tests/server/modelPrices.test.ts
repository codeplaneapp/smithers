import { describe, expect, test } from "bun:test";

import { modelPrices } from "../../src/server/proxy/modelPrices.ts";

describe("modelPrices", () => {
  test("includes GPT-5.6 Sol, Terra, and Luna", () => {
    expect(modelPrices("gpt-5.6-sol")).toEqual({ input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(modelPrices("gpt-5.6-terra")).toEqual({ input: 2.5, output: 15, cacheWrite: 3.125, cacheRead: 0.25 });
    expect(modelPrices("gpt-5.6-luna")).toEqual({ input: 1, output: 6, cacheWrite: 1.25, cacheRead: 0.1 });
  });

  test("prices the base model id", () => {
    expect(modelPrices("claude-opus-4-8").input).toBe(15);
  });

  test("prices a date-stamped suffix", () => {
    expect(modelPrices("claude-haiku-4-5-20251001").input).toBe(0.8);
  });

  test("prices a bracketed context-window alias (not metered as free)", () => {
    // claude-opus-4-8[1m] is a real model; it must not fall through to $0.
    const price = modelPrices("claude-opus-4-8[1m]");
    expect(price.input).toBe(15);
    expect(price.output).toBe(75);
  });

  test("unknown models record $0", () => {
    expect(modelPrices("some-unknown-model").input).toBe(0);
  });
});
