import { describe, expect, test } from "bun:test";
import { resolveInferenceEnv } from "../../action/src/resolveInferenceEnv";

const base = { anthropicBaseUrl: "https://review.example/anthropic", sessionToken: "srs_session" };

describe("resolveInferenceEnv", () => {
  test("defaults to proxy mode with the session token as the API key", () => {
    const resolved = resolveInferenceEnv(base);
    expect(resolved.mode).toBe("proxy");
    expect(resolved.env).toEqual({
      ANTHROPIC_BASE_URL: "https://review.example/anthropic",
      ANTHROPIC_API_KEY: "srs_session",
    });
  });

  test("CODEX_AUTH_JSON selects codex subscription mode and switches the engine", () => {
    const resolved = resolveInferenceEnv({ ...base, codexAuthJson: '{"auth_mode":"chatgpt"}' });
    expect(resolved.mode).toBe("codex-subscription");
    expect(resolved.env).toEqual({ SMITHERS_REVIEW_ENGINE: "codex" });
  });

  test("CLAUDE_CODE_OAUTH_TOKEN selects claude subscription mode with no overrides", () => {
    const resolved = resolveInferenceEnv({ ...base, claudeCodeOauthToken: "sk-ant-oat01-example" });
    expect(resolved.mode).toBe("claude-subscription");
    expect(resolved.env).toEqual({});
  });

  test("codex wins over claude when both subscription secrets are present", () => {
    const resolved = resolveInferenceEnv({
      ...base,
      codexAuthJson: '{"auth_mode":"chatgpt"}',
      claudeCodeOauthToken: "sk-ant-oat01-example",
    });
    expect(resolved.mode).toBe("codex-subscription");
  });

  test("blank secrets do not count as subscription mode", () => {
    const resolved = resolveInferenceEnv({ ...base, codexAuthJson: "   ", claudeCodeOauthToken: "" });
    expect(resolved.mode).toBe("proxy");
  });
});
