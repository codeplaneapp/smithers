import { describe, expect, test } from "bun:test";
import { resolveInferenceEnv } from "../../action/src/resolveInferenceEnv";

describe("resolveInferenceEnv", () => {
  test("always pins the GitHub Action to Claude through the short-lived metered session", () => {
    expect(resolveInferenceEnv({
      anthropicBaseUrl: "https://review.example/anthropic",
      sessionToken: "srs_session",
    })).toEqual({
      mode: "proxy",
      env: {
        SMITHERS_REVIEW_ENGINE: "claude",
        ANTHROPIC_BASE_URL: "https://review.example/anthropic",
        ANTHROPIC_API_KEY: "srs_session",
      },
    });
  });
});
