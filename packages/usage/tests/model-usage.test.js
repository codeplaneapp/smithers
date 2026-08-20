import { describe, expect, test } from "bun:test";
import { foldModelUsageEvents, usageFromModelEvent } from "../src/index.js";

describe("flows model usage", () => {
  test("normalizes cached input without double-counting it", () => {
    expect(
      usageFromModelEvent({
        type: "usage",
        inputTokens: 1_200,
        outputTokens: 340,
        cachedInputTokens: 900,
        cacheWriteTokens: 100,
        reasoningTokens: 40,
        totalTokens: 1_540,
      }),
    ).toEqual({
      inputTokens: 1_200,
      freshInputTokens: 200,
      outputTokens: 340,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
      reasoningTokens: 40,
      totalTokens: 1_540,
    });
  });

  test("replays envelopes and keeps the final usage event per request", () => {
    const total = foldModelUsageEvents([
      { payload: JSON.stringify({ type: "usage", inputTokens: 1_000, outputTokens: 10 }) },
      {
        payload: {
          modelEvent: {
            type: "usage",
            inputTokens: 1_200,
            outputTokens: 340,
            cachedInputTokens: 900,
            cacheWriteTokens: 100,
            totalTokens: 1_540,
          },
        },
      },
      { event: { type: "settle", stopReason: "tool-calls" } },
      { event: { type: "usage", inputTokens: 800, outputTokens: 60, cachedInputTokens: 600, cacheWriteTokens: 50 } },
      { event: { type: "settle", stopReason: "stop" } },
    ]);
    expect(total).toEqual({
      inputTokens: 2_000,
      freshInputTokens: 350,
      outputTokens: 400,
      cacheReadTokens: 1_500,
      cacheWriteTokens: 150,
      reasoningTokens: 0,
      totalTokens: 2_400,
      requests: 2,
    });
  });
});
