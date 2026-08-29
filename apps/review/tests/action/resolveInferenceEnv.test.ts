import { describe, expect, test } from "bun:test";
import { resolveInferenceEnv } from "../../action/src/resolveInferenceEnv.ts";

const session = { anthropicBaseUrl: "https://review.test/api/anthropic", sessionToken: "srs_tok" };

describe("resolveInferenceEnv", () => {
  test("a bring-your-own Anthropic key wins and never sets a base URL", () => {
    const resolved = resolveInferenceEnv({ ...session, anthropicApiKey: "sk-ant-byo" });
    expect(resolved.mode).toBe("byo-anthropic");
    expect(resolved.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-byo" });
  });

  test("a bring-your-own OpenAI key moves both seats onto the openai provider", () => {
    const resolved = resolveInferenceEnv({ ...session, openaiApiKey: "sk-oai-byo" });
    expect(resolved.mode).toBe("byo-openai");
    expect(resolved.env.OPENAI_API_KEY).toBe("sk-oai-byo");
    // A seat's provider is the half ahead of the colon, and it decides which
    // credential is read: an openai key with anthropic: seats resolves nothing.
    expect(resolved.env.SMITHERS_REVIEW_SEAT).toStartWith("openai:");
    expect(resolved.env.SMITHERS_REVIEW_CHEAP_SEAT).toStartWith("openai:");
  });

  test("Anthropic wins over OpenAI when both are set", () => {
    const resolved = resolveInferenceEnv({ ...session, anthropicApiKey: "sk-ant", openaiApiKey: "sk-oai" });
    expect(resolved.mode).toBe("byo-anthropic");
  });

  test("blank keys are treated as unset", () => {
    const resolved = resolveInferenceEnv({ ...session, anthropicApiKey: "  ", openaiApiKey: "" });
    expect(resolved.mode).toBe("proxy");
  });

  test("the default is the metered proxy, pointed at the session's origin", () => {
    const resolved = resolveInferenceEnv(session);
    expect(resolved.mode).toBe("proxy");
    expect(resolved.env).toEqual({
      ANTHROPIC_BASE_URL: "https://review.test/api/anthropic",
      ANTHROPIC_API_KEY: "srs_tok",
    });
  });
});
