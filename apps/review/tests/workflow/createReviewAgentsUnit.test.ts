import { afterEach, describe, expect, test } from "bun:test";
import { createReviewAgents } from "../../src/workflow/createReviewAgents";

const ENV_KEYS = [
  "SMITHERS_REVIEW_ENGINE",
  "SMITHERS_REVIEW_MODEL",
  "SMITHERS_REVIEW_FALLBACK_MODEL",
  "CODEX_HOME",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

function clearEnv() {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
});

describe("createReviewAgents", () => {
  test("claude engine (default) builds a shared two-agent subscription pool", () => {
    clearEnv();
    const agents = createReviewAgents("/tmp/repo");
    expect(agents.review).toHaveLength(2);
    // All four stages share the same primary/fallback pool.
    expect(agents.narrate).toEqual(agents.review);
    expect(agents.verify).toEqual(agents.review);
    expect(agents.quiz).toEqual(agents.review);
  });

  test("claude proxy mode (base URL + api key) builds api-key agents", () => {
    clearEnv();
    process.env.ANTHROPIC_BASE_URL = "https://proxy.test";
    process.env.ANTHROPIC_API_KEY = "sk-proxy";
    process.env.SMITHERS_REVIEW_MODEL = "claude-fable-5";
    process.env.SMITHERS_REVIEW_FALLBACK_MODEL = "claude-opus-4-8";
    const agents = createReviewAgents("/tmp/repo");
    expect(agents.review).toHaveLength(2);
    expect(agents.quiz).toEqual(agents.review);
  });

  test("codex engine builds one CodexAgent per stage, honoring CODEX_HOME", () => {
    clearEnv();
    process.env.SMITHERS_REVIEW_ENGINE = "codex";
    process.env.CODEX_HOME = "/tmp/codex-home";
    const agents = createReviewAgents("/tmp/repo");
    expect(agents.review).toHaveLength(1);
    expect(agents.narrate).toHaveLength(1);
    expect(agents.verify).toHaveLength(1);
    expect(agents.quiz).toHaveLength(1);
    // Distinct per-stage agents (each pinned to its own output schema).
    expect(agents.review[0]).not.toBe(agents.narrate[0]);
  });

  test("codex engine without CODEX_HOME still constructs agents", () => {
    clearEnv();
    process.env.SMITHERS_REVIEW_ENGINE = "codex";
    process.env.SMITHERS_REVIEW_MODEL = "gpt-5.5";
    const agents = createReviewAgents("/tmp/repo");
    expect(agents.review).toHaveLength(1);
  });
});
