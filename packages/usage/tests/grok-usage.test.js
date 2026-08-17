import { describe, expect, test } from "bun:test";
import { getAccountUsage, grokUsage } from "../src/index.js";

describe("grokUsage", () => {
  test("reports the absence of a live xAI account-usage endpoint without estimating", async () => {
    await expect(grokUsage()).resolves.toEqual({
      source: "none",
      error: "xAI exposes no live usage endpoint",
    });
    await expect(
      getAccountUsage({ label: "grok-main", provider: "grok", configDir: "/tmp/grok-main" }),
    ).resolves.toMatchObject({
      accountLabel: "grok-main",
      provider: "grok",
      source: "none",
      estimate: false,
      error: "xAI exposes no live usage endpoint",
    });
    await expect(getAccountUsage({ label: "xai-key", provider: "xai-api", apiKey: "secret" })).resolves.toMatchObject({
      accountLabel: "xai-key",
      provider: "xai-api",
      source: "none",
      estimate: false,
      error: "xAI exposes no live usage endpoint",
    });
  });
});
