import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewAgents, registeredReviewCodexCredentials, resolveReviewEngine } from "../../src/workflow/createReviewAgents";

const ENV_KEYS = [
  "SMITHERS_REVIEW_ENGINE",
  "SMITHERS_REVIEW_MODEL",
  "SMITHERS_REVIEW_CHEAP_MODEL",
  "SMITHERS_REVIEW_FALLBACK_MODEL",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "SMITHERS_HOME",
] as const;
const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

function clearEnv() {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.SMITHERS_HOME = `/tmp/smithers-review-no-accounts-${process.pid}`;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("createReviewAgents", () => {
  test("defaults to Codex when installed and otherwise falls back to Claude", () => {
    clearEnv();
    expect(resolveReviewEngine(() => true)).toBe("codex");
    expect(resolveReviewEngine(() => false)).toBe("claude");
  });

  test("an explicit engine override wins over binary detection", () => {
    clearEnv();
    process.env.SMITHERS_REVIEW_ENGINE = "claude";
    expect(resolveReviewEngine(() => true)).toBe("claude");
    process.env.SMITHERS_REVIEW_ENGINE = "codex";
    expect(resolveReviewEngine(() => false)).toBe("codex");
  });

  test("explicit claude fallback builds a shared two-agent subscription pool", () => {
    clearEnv();
    process.env.SMITHERS_REVIEW_ENGINE = "claude";
    const agents = createReviewAgents("/tmp/repo");
    expect(agents.review).toHaveLength(2);
    // All four stages share the same primary/fallback pool.
    expect(agents.narrate).toEqual(agents.review);
    expect(agents.verify).toEqual(agents.review);
    expect(agents.quiz).toEqual(agents.review);
  });

  test("claude proxy mode (base URL + api key) builds api-key agents", () => {
    clearEnv();
    process.env.SMITHERS_REVIEW_ENGINE = "claude";
    process.env.ANTHROPIC_BASE_URL = "https://proxy.test";
    process.env.ANTHROPIC_API_KEY = "sk-proxy";
    process.env.SMITHERS_REVIEW_MODEL = "claude-fable-5";
    process.env.SMITHERS_REVIEW_FALLBACK_MODEL = "claude-opus-4-8";
    const agents = createReviewAgents("/tmp/repo");
    expect(agents.review).toHaveLength(2);
    expect(agents.quiz).toEqual(agents.review);
  });

  test("codex engine builds Codex first with Claude only after it, honoring CODEX_HOME", () => {
    clearEnv();
    process.env.SMITHERS_REVIEW_ENGINE = "codex";
    process.env.CODEX_HOME = "/tmp/codex-home";
    const agents = createReviewAgents("/tmp/repo");
    expect(agents.review).toHaveLength(3);
    expect(agents.narrate).toHaveLength(3);
    expect(agents.verify).toHaveLength(3);
    expect(agents.quiz).toHaveLength(3);
    // Distinct per-stage agents (each pinned to its own output schema).
    expect(agents.review[0]).not.toBe(agents.narrate[0]);
    expect((agents.review[0] as { model?: string }).model).toBe("gpt-5.6-sol");
    expect((agents.verify[0] as { model?: string }).model).toBe("gpt-5.6-sol");
    expect((agents.narrate[0] as { model?: string }).model).toBe("gpt-5.6-luna");
    expect((agents.quiz[0] as { model?: string }).model).toBe("gpt-5.6-luna");
  });

  test("codex engine without CODEX_HOME still constructs agents", () => {
    clearEnv();
    process.env.SMITHERS_REVIEW_ENGINE = "codex";
    process.env.SMITHERS_REVIEW_MODEL = "gpt-sol-custom";
    process.env.SMITHERS_REVIEW_CHEAP_MODEL = "gpt-luna-custom";
    const agents = createReviewAgents("/tmp/repo");
    expect(agents.review).toHaveLength(3);
    expect((agents.review[0] as { model?: string }).model).toBe("gpt-sol-custom");
    expect((agents.narrate[0] as { model?: string }).model).toBe("gpt-luna-custom");
  });

  test("blank Codex model overrides fall through to the role defaults", () => {
    clearEnv();
    process.env.SMITHERS_REVIEW_ENGINE = "codex";
    process.env.SMITHERS_REVIEW_MODEL = "  ";
    process.env.SMITHERS_REVIEW_CHEAP_MODEL = "";
    const agents = createReviewAgents("/tmp/repo");
    expect((agents.review[0] as { model?: string }).model).toBe("gpt-5.6-sol");
    expect((agents.narrate[0] as { model?: string }).model).toBe("gpt-5.6-luna");
  });

  test("registered Codex accounts run before Claude fallbacks", () => {
    clearEnv();
    process.env.SMITHERS_REVIEW_ENGINE = "codex";
    const root = mkdtempSync(join(tmpdir(), "smithers-review-accounts-"));
    tempDirs.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "accounts.json"), JSON.stringify({
      version: 1,
      accounts: [
        { label: "codex-work", provider: "codex", configDir: "/accounts/codex-work" },
        { label: "openai-paid", provider: "openai-api", apiKey: "sk-openai-paid" },
      ],
    }));
    process.env.SMITHERS_HOME = root;

    expect(registeredReviewCodexCredentials()).toHaveLength(2);
    const agents = createReviewAgents("/tmp/repo") as { review: any[] };
    expect(agents.review).toHaveLength(5);
    expect(agents.review[0].model).toBe("gpt-5.6-sol");
    expect(agents.review[1].opts.configDir).toBe("/accounts/codex-work");
    expect(agents.review[2].opts.apiKey).toBe("sk-openai-paid");
    expect(agents.review[3].model).toBe("claude-fable-5");
  });
});
