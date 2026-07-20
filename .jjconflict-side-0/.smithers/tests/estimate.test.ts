import { describe, expect, test } from "bun:test";
import { priceEstimate } from "../components/Estimate";

describe("priceEstimate", () => {
  test("folds iterations into total tokens", () => {
    const e = priceEstimate({
      perTask: [{ nodeId: "impl", tokens: 100_000, iterations: 3, model: "claude-sonnet-5" }],
      confidence: "medium",
      assumptions: [],
    });
    expect(e.perTask[0].tokens).toBe(300_000);
    expect(e.totalTokens).toBe(300_000);
  });

  test("prices at the blended input/output midpoint per model", () => {
    // sonnet is 3 in / 15 out => midpoint 9 per Mtok; 1M tokens => $9.
    const e = priceEstimate({
      perTask: [{ nodeId: "a", tokens: 1_000_000, iterations: 1, model: "claude-sonnet-5" }],
      confidence: "high",
      assumptions: [],
    });
    expect(e.costUsd).toBeCloseTo(9, 6);
  });

  test("falls back to defaultModel when a task's model is blank", () => {
    const e = priceEstimate(
      { perTask: [{ nodeId: "a", tokens: 1_000_000, iterations: 1 }], confidence: "low", assumptions: [] },
      "claude-haiku-4-5",
    );
    // haiku 1 in / 5 out => midpoint 3 per Mtok.
    expect(e.perTask[0].model).toBe("claude-haiku-4-5");
    expect(e.costUsd).toBeCloseTo(3, 6);
  });

  test("uses Luna as the default pricing model", () => {
    const e = priceEstimate({
      perTask: [{ nodeId: "impl", tokens: 1_000_000, iterations: 1 }],
      confidence: "high",
      assumptions: [],
    });
    expect(e.perTask[0].model).toBe("gpt-5.6-luna");
    // The coarse estimate assumes a 50/50 split. Its 500K estimated input is
    // above GPT-5.6's 272K threshold, so the whole request is 2x input / 1.5x output.
    expect(e.costUsd).toBeCloseTo(5.5, 6);
  });

  test("unknown (unpriced) models cost $0 but still count tokens", () => {
    const e = priceEstimate({
      perTask: [{ nodeId: "a", tokens: 50_000, iterations: 2, model: "gpt-5.5" }],
      confidence: "low",
      assumptions: [],
    });
    expect(e.totalTokens).toBe(100_000);
    expect(e.costUsd).toBe(0);
  });

  test("empty / missing forecast yields a zero estimate, not a throw", () => {
    expect(priceEstimate(null)).toEqual({
      totalTokens: 0,
      costUsd: 0,
      confidence: "low",
      assumptions: [],
      perTask: [],
    });
  });

  test("clamps junk iterations to at least 1", () => {
    const e = priceEstimate({
      perTask: [{ nodeId: "a", tokens: 1000, iterations: 0, model: "claude-sonnet-5" }],
      confidence: "low",
      assumptions: [],
    });
    expect(e.perTask[0].iterations).toBe(1);
    expect(e.perTask[0].tokens).toBe(1000);
  });
});
