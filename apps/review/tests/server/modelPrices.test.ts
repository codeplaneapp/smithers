import { describe, expect, test } from "bun:test";

import { modelPrices } from "../../src/server/proxy/modelPrices.ts";

describe("modelPrices", () => {
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
