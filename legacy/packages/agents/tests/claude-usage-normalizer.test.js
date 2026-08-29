import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";
import { createDeepSeekUsageNormalizer } from "../src/deepseekUsage.js";
import { makeFakeNodeCli, prependPath } from "./fake-cli.js";

const originalPath = process.env.PATH ?? "";

afterEach(() => {
  process.env.PATH = originalPath;
});

const DEEPSEEK_USAGE = {
  prompt_cache_miss_tokens: 120,
  prompt_cache_hit_tokens: 380,
  output_tokens: 42,
};

/**
 * @param {string} stdoutScript
 */
async function makeFakeClaude(stdoutScript) {
  const dir = await mkdtemp(join(tmpdir(), "smithers-claude-test-"));
  return makeFakeNodeCli(dir, "claude", stdoutScript);
}

describe("createDeepSeekUsageNormalizer", () => {
  const normalize = createDeepSeekUsageNormalizer();

  test("maps DeepSeek cache and output counters to the normalized shape", () => {
    expect(normalize({ usage: DEEPSEEK_USAGE })).toEqual({
      inputTokens: 120,
      cacheReadTokens: 380,
      outputTokens: 42,
      totalTokens: 542,
    });
  });

  test("accepts a bare usage object too", () => {
    expect(normalize(DEEPSEEK_USAGE)).toEqual({
      inputTokens: 120,
      cacheReadTokens: 380,
      outputTokens: 42,
      totalTokens: 542,
    });
  });

  test("rejects ambiguous legacy aliases instead of mis-billing them", () => {
    expect(() => normalize({ usage: { ...DEEPSEEK_USAGE, cache_read_input_tokens: 380 } })).toThrow(
      /legacy usage alias/,
    );
    expect(() => normalize({ usage: { cache_creation_input_tokens: 5, output_tokens: 1 } })).toThrow(
      /legacy usage alias/,
    );
    expect(() => normalize({ usage: { input_tokens: 10, output_tokens: 1 } })).toThrow(/legacy usage alias/);
  });

  test("returns undefined when no provider counters are present", () => {
    expect(normalize({ usage: {} })).toBeUndefined();
    expect(normalize({})).toBeUndefined();
    expect(normalize(undefined)).toBeUndefined();
  });
});

describe("ClaudeCodeAgent normalizeUsage option", () => {
  test("applies the normalizer to completed events (success and failure)", () => {
    const agent = new ClaudeCodeAgent({ normalizeUsage: createDeepSeekUsageNormalizer() });
    const interpreter = agent.createOutputInterpreter();
    const okEvents = interpreter.onStdoutLine(
      JSON.stringify({ type: "result", subtype: "success", result: "done", usage: DEEPSEEK_USAGE }),
    );
    const okCompleted = okEvents.find((event) => event.type === "completed");
    expect(okCompleted?.usage).toEqual({ inputTokens: 120, cacheReadTokens: 380, outputTokens: 42, totalTokens: 542 });

    const failingAgent = new ClaudeCodeAgent({ normalizeUsage: createDeepSeekUsageNormalizer() });
    const failInterpreter = failingAgent.createOutputInterpreter();
    const failEvents = failInterpreter.onStdoutLine(
      JSON.stringify({ type: "result", subtype: "error", is_error: true, error: "boom", usage: DEEPSEEK_USAGE }),
    );
    const failCompleted = failEvents.find((event) => event.type === "completed");
    expect(failCompleted?.ok).toBe(false);
    expect(failCompleted?.usage).toEqual({
      inputTokens: 120,
      cacheReadTokens: 380,
      outputTokens: 42,
      totalTokens: 542,
    });
  });

  test("normalizer errors surface as invocation failures, not silent mis-billing", () => {
    const agent = new ClaudeCodeAgent({ normalizeUsage: createDeepSeekUsageNormalizer() });
    const interpreter = agent.createOutputInterpreter();
    const events = interpreter.onStdoutLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "done",
        usage: { ...DEEPSEEK_USAGE, cache_read_input_tokens: 1 },
      }),
    );
    const completed = events.find((event) => event.type === "completed");
    expect(completed?.ok).toBe(false);
    expect(completed?.error).toMatch(/legacy usage alias/);
  });

  test("flows normalized usage into generate results", async () => {
    const fake = await makeFakeClaude(`
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  result: "done",
  session_id: "s-1",
  usage: { prompt_cache_miss_tokens: 120, prompt_cache_hit_tokens: 380, output_tokens: 42 }
}) + "\\n");
`);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      const agent = new ClaudeCodeAgent({ normalizeUsage: createDeepSeekUsageNormalizer() });
      const result = await agent.generate({ prompt: "hi" });
      expect(result.usage.inputTokens).toBe(120);
      expect(result.usage.outputTokens).toBe(42);
      expect(result.usage.inputTokenDetails?.cacheReadTokens).toBe(380);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("flows normalized usage into stream results", async () => {
    const fake = await makeFakeClaude(`
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  result: "done",
  session_id: "s-1",
  usage: { prompt_cache_miss_tokens: 120, prompt_cache_hit_tokens: 380, output_tokens: 42 }
}) + "\\n");
`);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      const agent = new ClaudeCodeAgent({ normalizeUsage: createDeepSeekUsageNormalizer() });
      const result = await agent.stream({ prompt: "hi" });
      const usage = await result.usage;
      expect(usage.inputTokens).toBe(120);
      expect(usage.outputTokens).toBe(42);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("normalized result usage wins over incremental partial-message usage", async () => {
    // With --include-partial-messages the stream also carries Anthropic-shaped
    // message_start/message_delta counters. Those are the custom provider's
    // numbers under Anthropic field names, so the normalizer must stay
    // authoritative and the generate result must match the completed event.
    const fake = await makeFakeClaude(`
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 500, cache_read_input_tokens: 380 } } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  result: "done",
  session_id: "s-1",
  usage: { prompt_cache_miss_tokens: 120, prompt_cache_hit_tokens: 380, output_tokens: 42 }
}) + "\\n");
`);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      const agent = new ClaudeCodeAgent({
        includePartialMessages: true,
        normalizeUsage: createDeepSeekUsageNormalizer(),
      });
      const result = await agent.generate({ prompt: "hi" });
      expect(result.usage.inputTokens).toBe(120);
      expect(result.usage.outputTokens).toBe(42);
      expect(result.usage.inputTokenDetails?.cacheReadTokens).toBe(380);
      expect(result.usage.totalTokens).toBe(542);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("default Anthropic usage passthrough is unchanged without the option", () => {
    const agent = new ClaudeCodeAgent();
    const interpreter = agent.createOutputInterpreter();
    const events = interpreter.onStdoutLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "done",
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
    );
    const completed = events.find((event) => event.type === "completed");
    expect(completed?.usage).toEqual({ input_tokens: 5, output_tokens: 6 });
  });
});
